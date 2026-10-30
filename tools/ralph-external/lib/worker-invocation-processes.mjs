// Bind worker environments to an invocation and find surviving marked processes.
import { opendirSync, statSync, openSync, readSync, closeSync, constants } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { classifyUnreadableWorkerProcess, readProcCgroup } from './worker-invocation-ancestry.mjs';
import { importImpl } from '../../_resolve-impl.mjs';
const { WORKER_INVOCATION_MARKER } = await importImpl(import.meta.url, 'config/worker-invocation-marker.mjs');
export { WORKER_INVOCATION_MARKER };

function startedBeforeWorker(fs, path, startTicks) {
  if (typeof startTicks !== 'string' || !/^\d+$/.test(startTicks)) return false;
  let fd;
  try {
    fd = fs.openSync(`${path}/stat`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(4096);
    const size = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (size === buffer.length) return false;
    const stat = buffer.toString('utf8', 0, size);
    // comm may contain spaces and parentheses; field 3 begins after its LAST ')'.
    const end = stat.lastIndexOf(')');
    const ticks = end < 0 ? undefined : stat.slice(end + 1).trim().split(/\s+/)[19];
    return /^\d+$/.test(ticks ?? '') && BigInt(ticks) < BigInt(startTicks);
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function buildWorkerInvocationEnvironment(envNames, invocationId, inherited = process.env) {
  if (typeof invocationId !== 'string' || !invocationId || invocationId.includes('\0')) {
    throw new Error('Worker environment requires a non-empty NUL-free invocation ID');
  }
  const names = [...new Set([...envNames, WORKER_INVOCATION_MARKER])];
  const env = Object.fromEntries(envNames.filter(name => inherited[name] !== undefined)
    .map(name => [name, inherited[name]]));
  return { env: { ...env, [WORKER_INVOCATION_MARKER]: invocationId }, envNames: names };
}

export function scanWorkerInvocationProcesses({ invocationId, startTicks, uid = process.getuid?.(),
  platform = process.platform, procRoot = '/proc', now = () => performance.now(),
  deadline = now() + 100, maxEntries = 4096, maxEnvironmentBytes = 1048576,
  workerPid, workerPgid, workerSession, workerCgroup, selfCgroup, maxAncestryDepth,
  fs = { opendirSync, statSync, openSync, readSync, closeSync } } = {}) {
  const unknown = detail => ({ confirmed: false,
    missing: `escaped-descendant evidence: ${detail}` });
  if (platform !== 'linux') return unknown('same-uid invocation-marker scan requires Linux /proc');
  if (!Number.isInteger(uid) || typeof invocationId !== 'string' || !invocationId || invocationId.includes('\0')) {
    return unknown('launcher-bound invocation marker and uid');
  }
  // Ancestry discrimination needs the recorded worker leader. Without it the
  // scan keeps the legacy fail-closed behaviour for every unreadable
  // post-start process.
  const workerKnown = Number.isSafeInteger(workerPid) && workerPid > 1
    && typeof startTicks === 'string' && /^\d+$/.test(startTicks);
  let resolvedWorkerCgroup = workerCgroup;
  if (resolvedWorkerCgroup === undefined && workerKnown) {
    resolvedWorkerCgroup = readProcCgroup(fs, `${procRoot}/${workerPid}`);
  }
  let resolvedSelfCgroup = selfCgroup;
  if (resolvedSelfCgroup === undefined) resolvedSelfCgroup = readProcCgroup(fs, `${procRoot}/self`);
  const marker = `${WORKER_INVOCATION_MARKER}=${invocationId}`;
  const present = () => ({ ...unknown('same-uid process still carries invocation marker (possible escaped descendant)'), markerPresent: true });
  const gone = error => ['ENOENT', 'ESRCH'].includes(error.code);
  let directory, uncertain = null;
  // A time bound must never hide earlier unreadable-process or byte-bound evidence.
  const timedOut = () => uncertain ?? { ...unknown('same-uid invocation-marker scan time bound reached'), timeBoundReached: true };
  try {
    directory = fs.opendirSync(procRoot);
    // Stream entries and cap per-process reads; neither a huge PID set nor
    // a large environment can turn this proof into an unbounded allocation.
    const buffer = Buffer.alloc(Math.min(65536, maxEnvironmentBytes + 1));
    for (let count = 0; ; count++) {
      if (now() >= deadline) return timedOut();
      const entry = directory.readSync();
      if (!entry) return uncertain ?? { confirmed: true, missing: null };
      if (count >= maxEntries) return unknown('same-uid invocation-marker scan count bound reached');
      if (!/^\d+$/.test(entry.name)) continue;
      const path = `${procRoot}/${entry.name}`;
      let fd, sameUid = false;
      try {
        if (fs.statSync(path).uid !== uid) continue;
        sameUid = true;
        fd = fs.openSync(`${path}/environ`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        let bytes = 0, tail = '';
        const decoder = new StringDecoder('utf8');
        for (;;) {
          if (now() >= deadline) return timedOut();
          const size = fs.readSync(fd, buffer, 0, Math.min(buffer.length, maxEnvironmentBytes + 1 - bytes), null);
          if (!size) break;
          bytes += size;
          if (bytes > maxEnvironmentBytes) {
            uncertain = unknown('same-uid process environment exceeds scan byte bound'); break;
          }
          const fields = (tail + decoder.write(buffer.subarray(0, size))).split('\0');
          tail = fields.pop();
          if (fields.includes(marker)) return present();
        }
        if (tail + decoder.end() === marker) return present();
      } catch (error) {
        // An escaped descendant cannot predate its worker leader. Ownership
        // failures and unreadable/missing start times still cannot prove absence.
        if (gone(error)) continue;
        if (!sameUid) {
          uncertain = unknown('unreadable same-uid process environment or ownership');
          continue;
        }
        if (!workerKnown) {
          if (!startedBeforeWorker(fs, path, startTicks)) {
            uncertain = unknown('unreadable same-uid process environment or ownership');
          }
          continue;
        }
        // Hardened (non-dumpable, e.g. Codex) processes hide their environment
        // but not their stat/cgroup links: a parallel worker's tree reaches a
        // live process that predates this worker and is provably not ours,
        // while a genuine escapee still links to the leader, its session or
        // group, or its private cgroup.
        const verdict = classifyUnreadableWorkerProcess({ fs, procRoot, pid: Number(entry.name), uid,
          workerPid, workerPgid, workerSession, workerStart: startTicks,
          workerCgroup: resolvedWorkerCgroup, selfCgroup: resolvedSelfCgroup,
          now, deadline, ...(maxAncestryDepth === undefined ? {} : { maxDepth: maxAncestryDepth }) });
        if (verdict === 'possible-descendant') {
          uncertain = unknown('unreadable same-uid process links to the worker (ancestry, session, group or cgroup)');
        }
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  } catch { return unknown('readable Linux /proc process inventory'); }
  finally { directory?.closeSync(); }
}
