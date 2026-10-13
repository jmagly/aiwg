/**
 * Session Launcher for External Ralph Loop
 *
 * Handles spawning Claude Code CLI sessions with proper argument
 * construction and output capture.
 *
 * @implements @.aiwg/requirements/design-ralph-external.md
 * @security docs/ralph-external-security.md
 *
 * SECURITY WARNING
 * ================
 * This module spawns Claude Code with --dangerously-skip-permissions which
 * BYPASSES ALL PERMISSION PROMPTS. The spawned session can:
 *
 * - Read ANY file the process user can read
 * - Write/modify ANY file the process user can write
 * - Execute ANY shell command
 * - Make network requests
 * - Install packages
 * - Modify system configuration
 *
 * This is required for headless/daemon operation but carries significant
 * security implications. Sessions run autonomously for extended periods
 * without human oversight.
 *
 * BEFORE USING:
 * - Read docs/ralph-external-security.md in full
 * - Understand all risks
 * - Set appropriate budget and iteration limits
 * - Ensure clean git state for rollback
 * - Have monitoring and abort procedures ready
 */

import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'child_process';
import { createWriteStream, mkdirSync, existsSync, readFileSync, copyFileSync, constants } from 'fs';
import { open, mkdir, rename, unlink, lstat, readdir, realpath } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative, isAbsolute } from 'path';
import { EventEmitter } from 'events';
import { homedir, constants as osConstants } from 'os';
import { importImpl } from '../_resolve-impl.mjs';
import { sampleWorkerIdentity, sameWorkerIdentity, createWorkerIdentityCapture, sampleWorkerGroup, sampleWorkerChildren, sampleProcessCgroup, sampleProcessAncestry,
  qualifyWorkerCpuTickRate, sampleWorkerCpuTime } from './process-monitor.mjs';
import { createWorkerHealthObserver, sampleOwnedWorktreeContent, classifyWorkerHealthFailure } from './lib/worker-health.mjs';
import { checkWorkerDispatch, detectWorkerIsolation, launchIsolatedWorker, getWorkerIsolationStatus, stopWorkerUnit, readUnitControlGroup } from './lib/worker-isolation.mjs';

/**
 * Kernel-verified containment gate for any candidate worker identity,
 * whether it came from a worker-writable disk record (`worker-identity.json`)
 * or a `/proc` children scan. A record that merely matches a REAL process
 * (resampled fresh by pid) is not sufficient on its own: that real process
 * can be any same-UID process on the host, including one entirely unrelated
 * to this invocation -- a same-UID worker can read another process's own
 * `/proc` entry and forge a record that matches it exactly (#2895 round 2,
 * MAJOR a). Trust requires containment derived from kernel facts the worker
 * cannot forge:
 *   - `systemd-unit` mode: the candidate pid's own cgroup
 *     (`/proc/<pid>/cgroup`) must equal the unit's own `ControlGroup`
 *     (`KillMode=control-group` places the transport, the worker and any
 *     descendants in that single cgroup).
 *   - degraded/attached mode: the candidate pid's real `/proc` ancestry
 *     chain (walked via ppid, never a worker-reported parentPid) must
 *     actually lead back to the launcher's own trusted transport child
 *     (`nativeSupervisor`), matching both pid, bootId and startTicks so a
 *     reused pid cannot stand in for it.
 */
function verifyWorkerContainment(pid, { mode, unit, nativeSupervisor,
  readControlGroup = readUnitControlGroup, readCgroup = sampleProcessCgroup, readAncestry = sampleProcessAncestry } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (mode === 'systemd-unit') {
    const unitGroup = unit ? readControlGroup(unit) : null;
    const pidGroup = readCgroup(pid);
    return !!unitGroup && !!pidGroup && pidGroup === unitGroup;
  }
  if (!nativeSupervisor || !Number.isSafeInteger(nativeSupervisor.pid)) return false;
  const chain = readAncestry(pid);
  if (!chain) return false;
  return chain.some(ancestor => ancestor.pid === nativeSupervisor.pid
    && ancestor.bootId === nativeSupervisor.bootId && ancestor.startTicks === nativeSupervisor.startTicks);
}

const bytesDigest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const beneath = (root, filename) => { const r = relative(root, filename); return r === '' || !r.startsWith('..') && !isAbsolute(r); };
const signalNumberToName = Object.fromEntries(Object.entries(osConstants.signals ?? {}).map(([name, number]) => [number, name]));

/** Resolve the deepest existing ancestor's realpath, then reattach any
 * not-yet-created remainder. A lexical prefix match is not sufficient: a
 * symlinked ancestor of either path can make `beneath()` wrong in either
 * direction, so both sides are resolved before the lexical comparison. */
async function resolveRealish(target) {
  const parts = target.split('/').filter(Boolean);
  for (let i = parts.length; i >= 0; i--) {
    const candidate = i === 0 ? '/' : `/${parts.slice(0, i).join('/')}`;
    try {
      const real = await realpath(candidate);
      const remainder = parts.slice(i).join('/');
      return remainder ? join(real, remainder) : real;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
export async function realBeneath(root, filename) {
  const [realRoot, realFilename] = await Promise.all([resolveRealish(root), resolveRealish(filename)]);
  return beneath(realRoot, realFilename);
}

// Linux directory handles pin each ancestor. O_NOFOLLOW on a pathname alone
// cannot protect an ancestor that the worker replaces after inspection.
async function withWorkerPath(filename, operation) {
  if (!isAbsolute(filename) || filename.includes('\0') || filename.split('/').includes('..')) throw new Error('Invalid worker path');
  const components = filename.split('/').filter(Boolean);
  const leaf = components.pop();
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of components) {
      const next = await open(`/proc/self/fd/${directory.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = next;
    }
    return await operation(`/proc/self/fd/${directory.fd}/${leaf ?? '.'}`);
  } finally { await directory.close(); }
}

async function boundedPrivateRead(filename, limit, inspect, privateOutput = false) {
  if (!await inspect(filename, 'file')) throw new Error('Required worker input is missing');
  const handle = await withWorkerPath(filename, target => open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('Worker input must be a bounded unaliased regular file');
    if (privateOutput) {
      if (stat.uid !== process.getuid()) throw new Error('Worker final must be conductor-owned');
      await handle.chmod(0o600);
    }
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('Worker input exceeds bound');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export async function publishWorkerRecord(runDir, name, value, inspect) {
  await inspect(runDir, 'directory');
  const target = join(runDir, name);
  await inspect(target, 'output');
  await withWorkerPath(target, async anchoredTarget => {
    const temporary = join(dirname(anchoredTarget), `.${name}.${randomUUID()}`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.chmod(0o600);
      await handle.sync();
    } finally { await handle.close(); }
    try { await inspect(target, 'output'); await rename(temporary, anchoredTarget); }
    finally { await unlink(temporary).catch(() => {}); }
  });
}

/** Never trust a PID/PGID from disk. The attached owner supplies this identity. */
export function signalOwnedWorker(identity, signal, { sample = sampleWorkerIdentity, group = sampleWorkerGroup,
  kill = process.kill, supervisor = sampleWorkerIdentity(process.pid) } = {}) {
  if (!identity || identity.pgid !== identity.pid || identity.uid !== process.getuid?.()
    || identity.pgid === supervisor?.pgid || !sameWorkerIdentity(identity, sample(identity.pid))) return false;
  const members = group(identity.pgid);
  if (!members || !members.length || members.some(member => member.uid !== identity.uid
    || member.bootId !== identity.bootId || member.sessionId !== identity.sessionId)) return false;
  try { kill(-identity.pgid, signal); return true; } catch { return false; }
}

/** Execution-time files in the launcher's private directory. Content producers
 * are pure; preview paths remain ${artifact:name}. Workspace locations are a
 * future declaration kind and are refused here. */
export async function materializeWorkerArtifacts(invocation, runDir) {
  const artifacts = invocation.artifacts ?? [];
  if (!Array.isArray(artifacts) || artifacts.length > 16) throw new Error('Worker artifact count exceeds bound');
  const names = new Set();
  let total = 0;
  for (const artifact of artifacts) {
    if (!artifact || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(artifact.name)
      || /[^A-Za-z0-9_-]/.test(artifact.name) || names.has(artifact.name) || typeof artifact.content !== 'string'
      || artifact.location !== undefined && artifact.location !== 'run-directory') throw new Error('Invalid worker artifact declaration');
    names.add(artifact.name);
    const size = Buffer.byteLength(artifact.content);
    total += size;
    if (size > 1048576 || total > 4194304) throw new Error('Worker artifact bytes exceed bound');
  }
  const paths = new Map(artifacts.map(artifact => [artifact.name, join(runDir, `artifact-${artifact.name}`)]));
  const argv = invocation.argv.map(token => {
    if (!token.includes('${artifact:')) return token;
    const match = /^\$\{artifact:([A-Za-z0-9][A-Za-z0-9_-]{0,63})\}$/.exec(token);
    if (!match || !paths.has(match[1])) throw new Error('Undeclared worker artifact placeholder');
    return paths.get(match[1]);
  });
  const { inspectWorkerPath } = await importImpl(import.meta.url, 'serve/worker-invocation.js');
  await inspectWorkerPath(runDir, 'directory');
  const stat = await lstat(runDir);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Worker artifact directory must be private and owned');
  const created = [];
  const cleanup = async () => {
    const results = await Promise.allSettled(created.map(filename =>
      withWorkerPath(filename, target => unlink(target)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      })));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  };
  try {
    for (const artifact of artifacts) {
      const filename = paths.get(artifact.name);
      const handle = await withWorkerPath(filename, target => open(target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
      created.push(filename);
      try { await handle.writeFile(artifact.content); await handle.sync(); }
      finally { await handle.close(); }
    }
    return { argv, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

async function launchOneWorker(owner, options) {
  const { inspectWorkerPath: inspect, revalidateWorkerInvocationPlan: validate } = await importImpl(import.meta.url, 'serve/worker-invocation.js');
  const { qualificationDigest } = await importImpl(import.meta.url, 'models/qualification-digest.mjs');
  const planBytes = await boundedPrivateRead(options.invocationPath, 1048576, inspect);
  const saved = JSON.parse(planBytes.toString('utf8'));
  const loadInputs = options.loadInputs ?? (options.inputs ? async () => options.inputs : async () =>
    (await importImpl(import.meta.url, 'cli/handlers/models.js')).loadWorkerInputs({
      cwd: process.cwd(), args: [], rawArgs: [], frameworkRoot: fileURLToPath(new URL('../../', import.meta.url)) }));
  let inputs = await loadInputs();
  const clock = () => typeof options.now === 'function' ? options.now() : options.now ?? new Date().toISOString();
  const now = clock();
  const invocation = await validate(saved, inputs.snapshot, inputs.drivers, now);
  if (invocation.transport !== 'shell') throw new Error('One-shot capture requires shell transport; use the qualified MCP descriptor directly');
  if (process.platform !== 'linux') throw new Error('One-shot worker capture requires qualified Linux process identity');
  const runDir = options.runDir;
  const runExists = await inspect(runDir, 'directory');
  if (runExists) {
    const stat = await lstat(runDir);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) || (await readdir(runDir)).length) {
      throw new Error('Worker run directory must be fresh, empty, private and owned');
    }
  }
  const writableRoots = inputs.drivers[invocation.selected.cli].qualification.installation?.workerWritableRoots ?? [invocation.cwd];
  let writableRootsContainRunDir = await realBeneath(invocation.cwd, runDir);
  for (const root of writableRoots) writableRootsContainRunDir ||= await realBeneath(root, runDir);
  if (writableRootsContainRunDir) {
    throw new Error('Run metadata must be outside worker-writable roots');
  }
  const paths = { stdout: invocation.stdoutPath, stderr: invocation.stderrPath, final: invocation.finalPath };
  if (new Set(Object.values(paths)).size !== 3 || Object.values(paths).some(filename =>
    filename === options.invocationPath || filename === invocation.briefPath
    || dirname(filename) === runDir && basename(filename).startsWith('artifact-')
    || ['invocation.json', 'process.json', 'exit.json', 'health.json', 'final-evidence.json', 'worker-start.json', 'worker-identity.json', 'worker-exit.json',
      'stdout.log', 'stdout.events.jsonl', 'stderr.log', '.launch-owner'].some(name => filename === join(runDir, name)))) {
    throw new Error('Worker output paths must be distinct from trusted metadata, capture files and artifact- paths');
  }
  for (const filename of Object.values(paths)) {
    if (await inspect(filename, 'output')) throw new Error('Fresh worker output paths are required');
    if (!await inspect(dirname(filename), 'directory')) throw new Error('Worker output parent is missing');
  }
  const brief = await boundedPrivateRead(invocation.briefPath, 262144, inspect);
  if (bytesDigest(brief) !== invocation.briefDigest) throw new Error('Worker prompt digest changed');
  // Frame stdin before any spawn: brief-json delivers a conductor-built params
  // document on the stdin pipe, never brief text in argv (#2911).
  const { workerStdinBytes } = await importImpl(import.meta.url, 'serve/worker-stdin-frame.mjs');
  const stdinBytes = workerStdinBytes(invocation, brief, inputs.drivers[invocation.selected.cli]);
  let gate = (options.checkDispatch ?? checkWorkerDispatch)({ config: inputs.snapshot.config });
  if (!gate.ok) throw new Error('Worker dispatch resource gate refused launch');
  const isolation = options.isolation ?? detectWorkerIsolation();
  if (isolation.mode === 'degraded' && !options.allowDegraded) {
    throw new Error('Worker isolation unavailable; explicitly select --allow-degraded-worker or use manual observation');
  }
  if (!runExists) await mkdir(runDir, { mode: 0o700 }); // exclusive attempt: no recursive creation or reuse
  const runStat = await lstat(runDir);
  if (runStat.uid !== process.getuid()) throw new Error('Worker run directory must be conductor-owned');
  await withWorkerPath(runDir, async target => { const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.chmod(0o700); } finally { await handle.close(); } });
  const invocationId = randomUUID();
  const reservation = await withWorkerPath(join(runDir, '.launch-owner'), target => open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
  try { await reservation.writeFile(invocationId); await reservation.sync(); } finally { await reservation.close(); }
  const supervisor = sampleWorkerIdentity(process.pid);
  const launchTime = new Date().toISOString();
  const monotonicStart = process.hrtime.bigint().toString();
  const profile = inputs.drivers[invocation.selected.cli].qualification.adapter.invocationProfiles[invocation.selected.profileRef];
  const captures = { stdout: join(runDir, profile.health?.outputFraming === 'jsonl' ? 'stdout.events.jsonl' : 'stdout.log'),
    stderr: join(runDir, 'stderr.log') };
  const writeRecord = options.publishRecord ?? publishWorkerRecord;
  const publishFailures = [];
  let publishing = Promise.resolve();
  // Each write must stay independent: one rejected publish must never block
  // every later one (including the final exit.json). The chain only orders
  // writes; `.catch(() => {})` keeps a prior failure from poisoning it, and
  // the per-call promise returned to the caller still reflects this write's
  // own outcome.
  const publish = (name, value) => {
    const write = publishing.catch(() => {}).then(() => writeRecord(runDir, name, value, inspect));
    publishing = write.catch(error => { publishFailures.push({ name, error: error?.message ?? String(error) }); });
    return write;
  };
  const handles = [];
  let outcome;
  let artifacts;
  try {
    artifacts = await materializeWorkerArtifacts(invocation, runDir);
    const displayArgv = artifacts.argv.map((token, i) => i === 0 ? token : `<argument:${bytesDigest(token)}>`);
    await publish('invocation.json', { version: 1, origin: 'launcher', invocationId, attemptId: invocationId,
      previousAttemptId: null, requestId: invocationId, taskDigest: qualificationDigest(saved.request), role: saved.request.role,
      selected: invocation.selected, planDigest: qualificationDigest(saved), invocationDigest: qualificationDigest(invocation),
      policyDigest: invocation.policyDigest, catalogDigest: invocation.catalogDigest, profileDigest: invocation.profileDigest,
      expiresAt: invocation.expiresAt, argv: displayArgv, commandDisplay: displayArgv.map(token => JSON.stringify(token)).join(' '),
      // Retain the legacy digest binding while naming both argv stages explicitly.
      argvDigest: qualificationDigest(invocation.argv), placeholderArgvDigest: qualificationDigest(invocation.argv),
      executedArgvDigest: qualificationDigest(artifacts.argv),
      artifacts: (invocation.artifacts ?? []).map(artifact => ({ name: artifact.name,
        byteLength: Buffer.byteLength(artifact.content), sha256: bytesDigest(artifact.content) })),
      envNames: invocation.envNames, stdin: invocation.stdin,
      prompt: { path: invocation.briefPath, digest: invocation.briefDigest }, cwd: invocation.cwd,
      worktree: { path: invocation.cwd, baseRevision: null }, paths, captures, outputFraming: profile.health?.outputFraming ?? 'opaque',
      health: invocation.health ?? null, transport: invocation.transport,
      isolation: { mode: isolation.mode, memoryMaxGb: options.memoryMaxGb ?? 4 },
      limits: invocation.limits, maxOutputBytes: Math.min(invocation.maxOutputBytes ?? 10485760, 10485760) });
    await publish('process.json', { invocationId, origin: 'launcher', supervisor, worker: null,
      launchTime, monotonicStart, ownership: 'unknown', isolation: isolation.mode });
    // All captures (including the reserved final) open successfully BEFORE spawn.
    for (const filename of [...Object.values(paths), ...Object.values(captures)]) {
      const handle = await withWorkerPath(filename, target => (options.openCapture ?? open)(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
      handles.push(handle);
    }
    // Recheck policy, prompt, installation and exact bindings after file preparation.
    inputs = await loadInputs();
    await validate(saved, inputs.snapshot, inputs.drivers, clock());
    gate = (options.checkDispatch ?? checkWorkerDispatch)({ config: inputs.snapshot.config });
    if (!gate.ok) throw new Error('Worker dispatch resource gate refused launch');
    if (bytesDigest(await boundedPrivateRead(invocation.briefPath, 262144, inspect)) !== invocation.briefDigest) throw new Error('Worker prompt changed before spawn');
    const environment = Object.fromEntries(invocation.envNames.filter(name => process.env[name] !== undefined)
      .map(name => [name, process.env[name]]));
    const baselineContent = await sampleOwnedWorktreeContent(invocation.cwd, { files: options.healthArtifacts });
    outcome = (options.launchIsolated ?? launchIsolatedWorker)({ name: invocationId,
      command: artifacts.argv[0], args: artifacts.argv.slice(1), cwd: invocation.cwd,
      memoryMaxGb: options.memoryMaxGb ?? 4, gate, config: inputs.snapshot.config, isolation,
      allowDegraded: !!options.allowDegraded, attached: true, ownedGroup: true,
      env: environment, envNames: invocation.envNames, stdin: invocation.stdin, runDir });
    if (!outcome.child) throw new Error('Worker launch did not return an attached child');
    return await captureOneWorker(owner, { child: outcome.child, outcome, invocation, invocationId, supervisor,
      launchTime, monotonicStart, publish, publishFailures, paths, handles, inspect, inputs, profile, baselineContent, options, brief, stdinBytes, runDir });
  } catch (error) {
    if (!outcome?.child) await publish('exit.json', { invocationId, exitCode: null, signal: null,
      endedAt: new Date().toISOString(), termination: 'confirmed', descendants: 'not-started', errorCode: error.code ?? 'LAUNCH_REFUSED' });
    throw error;
  } finally {
    try { await artifacts?.cleanup(); } finally {
      // Never chmod a worker-replaced pathname; only the inodes we opened.
      for (const handle of handles) { await handle.chmod(0o600).catch(() => {}); await handle.close().catch(() => {}); }
      await inspect(runDir, 'directory');
      await withWorkerPath(runDir, async target => { const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await handle.chmod(0o700); } finally { await handle.close(); } });
    }
  }
}

async function captureOneWorker(owner, ctx) {
  const { child, outcome, invocation, invocationId, supervisor, launchTime, monotonicStart, publish, paths, handles, options } = ctx;
  const hasTransport = outcome.mode === 'systemd-unit' || outcome.transportSupervisor;
  const sampleIdentity = options.sampleIdentity ?? sampleWorkerIdentity;
  // Separate hook from `sampleIdentity` (the worker-side sampler): this one
  // samples the launcher's own trusted transport child, never a worker PID,
  // and tests need to control the two independently (e.g. the transport
  // dies as soon as it is sampled once, while the worker side is never
  // reached at all).
  const sampleNativeSupervisor = options.sampleNativeSupervisor ?? sampleWorkerIdentity;
  // For our own detached child, spawn waits through setsid/exec; one owned leader sample suffices.
  const immediate = !hasTransport ? sampleIdentity(child.pid) : null;
  let identity = immediate?.pid === child.pid && immediate?.pid === immediate?.pgid
    && immediate?.uid === process.getuid?.() && immediate?.parentPid === process.pid ? immediate : null;
  // Pin the transport's own birth identity at the earliest possible moment --
  // synchronously, before any await can let it exit and be reaped. For
  // degraded/attached mode `child` IS the transport process (its PID is
  // `native.mainPid` below), so this sample is as trustworthy as the direct
  // child's `immediate` sample above. Sampling this only inside the polling
  // loop (as before) raced a worker that ran and exited fast enough that the
  // transport itself had already exited by the loop's first `await`,
  // leaving `nativeSupervisor` permanently null -- a dead process can never
  // be resampled back to non-null, so no later retry could recover it,
  // which is exactly the ordering that produced the null `worker` field.
  // For systemd-unit mode the unit's MainPID is not known synchronously; it
  // is still resolved once inside observeIdentity.
  let nativeSupervisor = hasTransport && outcome.mode !== 'systemd-unit' ? sampleNativeSupervisor(child.pid) : null;
  const streams = [handles[0], handles[1], handles[3], handles[4]].map(handle => createWriteStream('', { fd: handle.fd, autoClose: false }));
  let identityObservation = 'pending';
  let reportedWorker = null;
  let output = Buffer.alloc(0);
  let total = 0;
  let timedOut = false;
  let stopRequested = false;
  let stopReason = null;
  let errorCode = null;
  let settled = false;
  let waitCode = null;
  let waitSignal = null;
  let deliveredSignal = null;
  let sawExit = false;
  let sawClose = false;
  const driver = ctx.inputs.drivers[invocation.selected.cli];
  const observationOptions = { provider: driver.qualification.adapter.provider, profile: ctx.profile,
    effectiveHealth: invocation.health, invocationId, startedAt: Number(BigInt(monotonicStart)) / 1e6,
    launchTime, contentDigest: ctx.baselineContent, sessionId: options.healthSessionLog?.sessionId ?? null,
    runId: options.healthSessionLog?.runId ?? null, maxOutputBytes: invocation.maxOutputBytes };
  const observer = driver.createHealthObserver?.(observationOptions) ?? createWorkerHealthObserver(observationOptions);
  const tickRate = qualifyWorkerCpuTickRate();
  let previousCpu = null;
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let logCursor = { inode: null, offset: 0, generation: 0 };
  const reportHealth = async () => {
    const health = observer.snapshot();
    owner.emit('health', health);
    try { await publish('health.json', { origin: 'observer', invocationId, health, evidence: observer.evidence() }); }
    catch { observer.gap('CAPTURE_WRITE'); }
    return health;
  };
  const timers = new Set();
  const later = (fn, ms) => {
    if (settled) return null;
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t;
  };
  const graceMs = (invocation.health?.terminateGraceSeconds ?? 5) * 1000;
  const signal = value => {
    if (settled || !signalOwnedWorker(identity, value, { supervisor })) return false;
    deliveredSignal = value;
    return true;
  };
  const readNative = () => { try { return (options.isolationStatus ?? getWorkerIsolationStatus)(outcome.unit); } catch { return null; } };
  const transportRecord = async filename => {
    const target = join(ctx.runDir, filename);
    try {
      const stat = await lstat(target);
      if (stat.uid !== process.getuid() || (stat.mode & 0o077)) return null;
      const record = JSON.parse((await boundedPrivateRead(target, 65536, ctx.inspect)).toString('utf8'));
      if (filename === 'worker-exit.json' && (!(record.exitCode === null || Number.isInteger(record.exitCode) && record.exitCode >= 0 && record.exitCode <= 255)
        || !(record.signal === null || typeof record.signal === 'string' && /^SIG[A-Z0-9]+$/.test(record.signal))
        || record.errorCode != null && (typeof record.errorCode !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(record.errorCode)))) return null;
      return record.invocationId === invocationId ? record : null;
    } catch { return null; }
  };
  // A systemd unit has no owned-PGID signal lever worth relying on: identity
  // may still be null (observeIdentity races the unit's own start), and a
  // signal against a since-reused PID must never be sent. `systemctl --user
  // stop` plus KillMode=control-group is the actual stop authority here; the
  // unit's own retained state (checked in finish() via readNative()) is what
  // confirms or fails to confirm that the stop took effect.
  const stopUnit = () => { try { return (options.stopUnit ?? stopWorkerUnit)(outcome.unit); } catch { return { ok: false }; } };
  const stop = (cause = errorCode ? 'PROVIDER_ERROR' : 'CANCELLED') => {
    if (settled || stopRequested) return;
    stopRequested = true; stopReason = cause;
    timedOut = ['HARD_DEADLINE', 'STARTUP_DEADLINE', 'NO_PROGRESS'].includes(cause);
    if (outcome.mode === 'systemd-unit' && outcome.unit) {
      stopUnit();
      // Backstop: if the unit's own exit does not reach us promptly, force
      // resolution so the caller is never left hanging. finish() still
      // derives confirmed/uncertain from the unit's retained state, not from
      // the fact that a stop was requested.
      later(() => { if (!settled) finish(); }, Math.min(graceMs, hardRemaining()));
      return;
    }
    signal('SIGTERM');
    const remainingGrace = Math.min(graceMs, hardRemaining());
    if (remainingGrace === 0) { signal('SIGKILL'); later(() => finish(), 100); }
    else later(() => { signal('SIGKILL'); later(() => finish(), 100); }, remainingGrace);
  };
  owner.currentProcess = child;
  owner.workerStop = stop;
  const onSignal = () => stop();
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  child.stdout.on('data', chunk => {
    observer.feed(chunk, { kind: 'stdout', id: 'stdout', generation: 0, offset: stdoutOffset }); stdoutOffset += chunk.length;
    total += chunk.length;
    const remaining = Math.max(0, Math.min(invocation.maxOutputBytes ?? 10485760, 10485760) - output.length);
    if (remaining) { const bounded = chunk.subarray(0, remaining); output = Buffer.concat([output, bounded]); streams[0].write(bounded); streams[2].write(bounded); }
    if (remaining < chunk.length) { errorCode = 'OUTPUT_LIMIT'; stop(); }
    owner.emit('stdout', chunk);
  });
  let stderrBytes = 0;
  child.stderr.on('data', chunk => {
    observer.feed(chunk, { kind: 'stderr', id: 'stderr', generation: 0, offset: stderrOffset }); stderrOffset += chunk.length;
    const remaining = Math.max(0, 10485760 - stderrBytes);
    streams[1].write(chunk.subarray(0, remaining)); streams[3].write(chunk.subarray(0, remaining)); stderrBytes += chunk.length;
    if (stderrBytes > 10485760) { errorCode = 'OUTPUT_LIMIT'; stop(); }
    owner.emit('stderr', chunk);
  });
  for (const stream of streams) stream.on('error', () => { errorCode = 'CAPTURE_WRITE'; stop(); });
  child.stdin?.on('error', error => { if (error.code !== 'EPIPE') { errorCode = 'STDIN_WRITE'; stop(); } });
  child.stdin?.end(ctx.stdinBytes ?? undefined);
  const recordProcess = () => publish('process.json', { invocationId, origin: 'launcher', supervisor,
    transportProcess: hasTransport ? sampleWorkerIdentity(child.pid) : null,
    nativeSupervisor,
    worker: identity ?? reportedWorker, identityObservation, launchTime, monotonicStart, ownership: identity ? 'owned-group' : 'unknown',
    isolation: outcome.mode, unit: outcome.unit ?? null });
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const finish = async () => {
    if (settled) return;
    settled = true;
    identityObservation = identity ? 'stable-owned-group' : 'no-stable-owned-group';
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
    owner.currentProcess = null; owner.workerStop = null;
    child.stdout.destroy(); child.stderr.destroy(); child.stdin?.destroy(); child.unref();
    for (const stream of streams) await new Promise(resolve => { if (stream.destroyed) resolve(); else stream.end(resolve); });
    const native = outcome.mode === 'systemd-unit' ? readNative() : null;
    const members = identity ? sampleWorkerGroup(identity.pgid) : null;
    // An unconfined group can escape via setsid. Empty PGID alone never proves
    // descendant termination; keep the explicit degraded stop uncertain.
    const confirmed = outcome.mode === 'systemd-unit' ? native?.active === false && [1, 2, 3].includes(native.execMainCode)
      : child.pid === undefined;
    // `worker-exit.json`/`worker-identity.json` are written into a directory
    // the worker itself can reach (same UID, no filesystem confinement), so a
    // worker can plant either file before the trusted transport ever writes
    // it. Treat both as unauthenticated, worker-reported hints only: they may
    // inform diagnostics (`workerTermination`, `nativeSupervisor` fallback)
    // but MUST NOT set exitCode/signal/termination/confirmed. Authority comes
    // from successful launcher-owned signal delivery, the wait() status of its direct
    // child (never the worker — `child` here is the trusted transport or the
    // systemd-run wrapper that mirrors the unit's real exit) or, for
    // systemd-unit mode, from `getWorkerIsolationStatus` queried against the
    // unit by name, also not a worker-writable path.
    const workerExit = hasTransport ? await transportRecord('worker-exit.json') : null;
    // A worker that exits before the launcher sees it alive leaves only the
    // transport's start record. Publish it as a diagnostic, labelled
    // unverified and with ownership unknown: it is never signal authority
    // (`identity` stays null) and needs the supervisor the launcher sampled.
    if (!identity && hasTransport && nativeSupervisor) {
      const workerStart = await transportRecord('worker-identity.json');
      if (workerStart?.worker && sameWorkerIdentity(workerStart.supervisor, nativeSupervisor)
        && workerStart.worker.parentPid === nativeSupervisor.pid) {
        reportedWorker = workerStart.worker;
        identityObservation = 'transport-reported-unverified';
      }
    }
    // Successful owned-group delivery is a fallback only while both wait
    // and unit-native exit status are unavailable. Observed status wins.
    // Failed/refused signals and worker-writable records grant no evidence.
    const nativeExited = outcome.mode === 'systemd-unit' && [1, 2, 3].includes(native?.execMainCode);
    const resultSignal = (outcome.mode === 'systemd-unit' && [2, 3].includes(native?.execMainCode)
      ? signalNumberToName[native.execMainStatus] ?? null : waitSignal)
      ?? (!sawExit && waitCode === null && waitSignal === null && !nativeExited ? deliveredSignal : null);
    const exitCode = resultSignal ? null
      : outcome.mode === 'systemd-unit' && native?.execMainCode === 1 ? native.execMainStatus : waitCode;
    const result = { invocationId, exitCode, signal: resultSignal,
      endedAt: new Date().toISOString(), termination: confirmed ? 'confirmed' : 'uncertain',
      descendants: confirmed ? 'stopped' : 'unknown', timedOut: timedOut || hardRemaining() === 0,
      cancelled: stopReason === 'CANCELLED', stopReason, errorCode: errorCode ?? null, capturedBytes: Math.min(total, output.length),
      // Unauthenticated: reported by the worker-writable transport record, not
      // kernel-observed. Never used above for exitCode/signal/termination.
      workerTermination: hasTransport ? workerExit && !workerExit.errorCode ? 'confirmed' : 'uncertain' : sawExit ? 'confirmed' : 'uncertain',
      workerReportedExit: workerExit ? { exitCode: workerExit.exitCode, signal: workerExit.signal, errorCode: workerExit.errorCode ?? null } : null,
      groupMembersRemaining: members?.length ?? null,
      nativeExitCode: native?.execMainCode === 1 ? native.execMainStatus : null,
      captureCoverage: sawClose ? 'complete' : 'gap', isolation: outcome.mode, nativeResult: native?.result ?? null,
      publishFailures: ctx.publishFailures?.length ? ctx.publishFailures.slice() : null };
    let healthFinalValid = false;
    try {
      const finalStat = await lstat(paths.final);
      if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.nlink !== 1 || finalStat.size > 262144) throw new Error('Invalid final output');
      await ctx.inspect(paths.final, 'file');
      let extracted = false;
      if (finalStat.size === 0 && driver.extractFinal) {
        const final = driver.extractFinal(output.toString('utf8'));
        if (final === null || final === undefined || final.success === false) throw new Error('Missing or unsuccessful final extraction');
        const bytes = JSON.stringify({ invocationId, source: 'adapter-extraction', candidate: true, verified: false, result: final });
        if (Buffer.byteLength(bytes) > 262144) throw new Error('Final exceeds bound');
        await handles[2].writeFile(bytes); extracted = true;
      }
      const finalBytes = await boundedPrivateRead(paths.final, 262144, ctx.inspect, true);
      if (!finalBytes.length) throw new Error('Missing final output');
      if (!extracted && driver.extractFinal) {
        const parsed = driver.extractFinal(finalBytes.toString('utf8'));
        if (parsed === null || parsed === undefined || parsed.success === false) throw new Error('Invalid final output');
      }
      await publish('final-evidence.json', { invocationId, path: paths.final, digest: bytesDigest(finalBytes),
        source: extracted ? 'adapter-extraction' : 'worker-output', candidate: true, verified: false,
        terminalSuccess: result.exitCode === 0 && !result.timedOut && !result.errorCode });
      // Consume #2890's strict final contract when supplied by the installed
      // driver. Legacy extraction remains a candidate, never health authority.
      if (driver.parseWorkerFinal) {
        try {
          // Strict validation consumes original bytes. A legacy extracted
          // object may already have lost duplicate keys and cannot authorize
          // completion through reserialization.
          await driver.parseWorkerFinal(extracted ? output : finalBytes, {
            format: extracted && ctx.profile.health?.outputFraming === 'jsonl' ? 'jsonl' : 'json', observation: { transport: 'shell',
            status: result.exitCode === 0 && !result.errorCode && !result.timedOut ? 'completed' : 'failed',
            termination: result.termination, exitCode: result.exitCode } });
          healthFinalValid = true;
        } catch { /* failed strict claims remain unverified candidate evidence */ }
      }
    } catch { result.errorCode ??= 'FINAL_OUTPUT_INVALID'; }
    // The final exit.json publish must always be attempted, independent of
    // whether the preceding recordProcess() write succeeded: a failing
    // process.json must never suppress the exit.json publication attempt
    // (previously, chaining both in one try block meant a thrown
    // recordProcess() skipped publish('exit.json', ...) entirely, leaving no
    // exit record at all). The finally block runs regardless of the try
    // outcome; either failure marks the result uncertain and tags the error.
    try { await recordProcess(); }
    catch { result.termination = 'uncertain'; result.errorCode = 'METADATA_WRITE'; }
    finally {
      try { await publish('exit.json', result); }
      catch { result.termination = 'uncertain'; result.errorCode = 'METADATA_WRITE'; }
    }
    result.health = observer.finish({ ...result, finalValid: healthFinalValid });
    result.healthEvidence = observer.evidence();
    try { await publish('exit.json', result); }
    catch { result.termination = 'uncertain'; result.errorCode = 'METADATA_WRITE'; result.health.termination = 'uncertain'; }
    await reportHealth();
    owner.emit('complete', result);
    resolveDone(result);
  };
  child.once('error', error => {
    errorCode = error.code ?? 'SPAWN_ERROR';
    observer.observe(classifyWorkerHealthFailure({ code: errorCode }, { source: { kind: 'stderr' } }));
    later(() => finish(), 0);
  });
  child.once('exit', (code, sig) => {
    if (settled) return;
    sawExit = true; waitCode = code; waitSignal = sig; later(() => finish(), graceMs);
  });
  // sawExit/waitCode/waitSignal come solely from the 'exit' handler above; a
  // failed spawn (e.g. ENOENT) never emits 'exit' in this Node, so they stay
  // at their unset defaults (false/null/null) here, which is already correct
  // — there is no real exit to report.
  child.once('close', () => { sawClose = true; finish(); });
  const hardRemaining = () => Math.max(0, Math.min(invocation.health?.hardTimeoutSeconds ?? invocation.limits.wallSeconds,
    invocation.limits.wallSeconds) * 1000 - (Number(process.hrtime.bigint() - BigInt(monotonicStart)) / 1e6));
  // Grace is clipped at stop time; forceful cancellation is never scheduled
  // beyond this fixed ceiling, including tasks shorter than startup/grace.
  later(() => {
    observer.check();
    // Snapshot/IPC diagnostics precede stop. A slow disk cannot postpone the
    // monotonic hard cancellation target.
    reportHealth(); stop('HARD_DEADLINE');
  }, hardRemaining());
  const identityCapture = createWorkerIdentityCapture();
  const observeIdentity = async (firstSample) => {
    if (settled) return;
    let candidate = !hasTransport ? firstSample === undefined ? sampleIdentity(child.pid) : firstSample : null;
    // Once the transport is observed to have exited, stop trying to acquire
    // the worker's identity through it: `nativeSupervisor.pid` is a fixed
    // pid *number*, and after the real transport process is gone the OS can
    // reuse that number for an unrelated process, so a live resample of "its"
    // children or a live-resample match against a stale disk record could
    // silently pivot onto that unrelated process. Nothing further can be
    // learned this way regardless -- a dead transport can never produce a
    // new, valid live sample -- so this is a pure safety stop, not a loss.
    if (hasTransport && !sawExit) {
      const native = outcome.mode === 'systemd-unit' ? readNative() : { mainPid: child.pid };
      const recorded = await transportRecord('worker-identity.json');
      // Re-check, not just `settled`: the transport's exit can be observed
      // while this very call is awaiting the disk read above, and resuming
      // into the containment/children-scan work below on a transport pid
      // the OS may have already reused is exactly what this guard exists to
      // prevent -- checking only at entry is not enough once an await
      // separates the check from the work it is meant to gate.
      if (settled || sawExit) return;
      // The transport's own identity cannot change while it is alive. Once
      // pinned, a later non-null resample is never accepted as a
      // replacement: if the transport's pid were reused after it exited,
      // that unrelated process would otherwise become the trusted ancestor
      // for every containment check below. The first successful sample is
      // either the launcher's own spawn-time pin (captured above, before any
      // await could let the transport exit and be reaped) or, for
      // systemd-unit mode where the unit's MainPID isn't known
      // synchronously, the first live resample here.
      nativeSupervisor ??= sampleNativeSupervisor(native?.mainPid);
      const contained = candidatePid => verifyWorkerContainment(candidatePid, { mode: outcome.mode, unit: outcome.unit, nativeSupervisor });
      // A disk record that merely matches a REAL process on resample is not
      // enough: that real process can be any same-UID process on the host.
      // Containment (cgroup for systemd-unit, kernel ppid ancestry for
      // degraded) must also hold before the record is trusted.
      const current = recorded?.worker ? sampleIdentity(recorded.worker.pid) : null;
      if (recorded && sameWorkerIdentity(recorded.supervisor, nativeSupervisor)
        && sameWorkerIdentity(recorded.worker, current)
        && contained(current?.pid)) {
        candidate = current;
        // The transport spawned this worker itself (its sample is past
        // setsid) and this live sample matches its record field for field:
        // two concordant observations by different observers. Only the
        // children scan below can see a pre-setsid fork.
        if (current.pid === current.pgid && current.uid === process.getuid()) identity ??= current;
      } else {
        const children = (options.sampleChildren ?? sampleWorkerChildren)(nativeSupervisor?.pid);
        if (children?.length === 1 && children[0].uid === process.getuid() && children[0].parentPid === nativeSupervisor.pid
          && contained(children[0].pid)) {
          const current = sampleIdentity(children[0].pid);
          if (current?.parentPid === nativeSupervisor.pid && contained(current.pid)) candidate = current;
        }
      }
    }
    // A third-party children scan requires two matching samples: setsid may be pending.
    // A direct child uses stable capture only when its immediate sample was unusable.
    const observed = identityCapture.observe(candidate);
    // The capture's two-matching-samples stability only proves the *same*
    // process answered twice; it says nothing about whose child it is. A
    // transport-path candidate reaching here is already launcher/transport
    // -parented (verified above, before being assigned to `candidate`), but
    // a direct child's candidate is not -- require it here, or an unrelated
    // same-uid group leader (e.g. the OS reusing `child.pid` for something
    // else entirely after our own child exited before the immediate sample)
    // would be accepted merely for repeating within the window. This is
    // deliberately checked *after* `identityCapture.observe()`, not before:
    // rejecting the candidate earlier would starve the capture's own
    // window/deadline bookkeeping of ever seeing a non-null sample.
    if (observed && (hasTransport || observed.parentPid === process.pid)) identity ??= observed;
    if (identity) observer.processStarted(identity);
    if (!identity && !identityCapture.expired()) {
      later(observeIdentity, identityCapture.started() ? 5 : 50); return;
    }
    const observation = identity ? 'stable-owned-group' : 'no-stable-owned-group';
    if (identityObservation !== observation) {
      identityObservation = observation;
      recordProcess().catch(() => { errorCode = 'PROCESS_RECORD'; stop(); });
    }
    // Keep looking for a fresh candidate after an unsuccessful window.
    if (!identity) later(observeIdentity, 50);
  };
  observeIdentity(immediate);
  const sampleLog = async () => {
    const locator = options.healthSessionLog;
    if (!locator || !ctx.profile.health?.sessionLogLocator || !locator.sessionId) return;
    const filename = locator.path;
    let handle;
    try {
      // Explicit trusted locator only; never search global/private transcripts.
      await ctx.inspect(filename, 'file');
      handle = await withWorkerPath(filename, target => open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unavailable session source');
      if (logCursor.inode !== null && (logCursor.inode !== stat.ino || stat.size < logCursor.offset)) {
        observer.gap('SOURCE_GAP', { kind: 'session-log', id: 'session-log' });
        logCursor = { inode: stat.ino, offset: 0, generation: logCursor.generation + 1 };
      }
      logCursor.inode = stat.ino;
      const bytes = Buffer.alloc(Math.min(65536, Math.max(0, stat.size - logCursor.offset)));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, logCursor.offset);
      observer.feed(bytes.subarray(0, bytesRead), { kind: 'session-log', id: 'session-log', generation: logCursor.generation, offset: logCursor.offset });
      logCursor.offset += bytesRead;
    } catch { observer.gap('SOURCE_GAP', { kind: 'session-log', id: 'session-log' }); }
    finally { await handle?.close(); }
  };
  const sampleHealth = async () => {
    if (settled) return;
    const current = identity ? sampleWorkerIdentity(identity.pid) : null;
    const cpu = identity ? sampleWorkerCpuTime(identity, current, tickRate, previousCpu) : { cpuTimeMs: null };
    previousCpu = current;
    const content = await sampleOwnedWorktreeContent(invocation.cwd, { files: options.healthArtifacts });
    await sampleLog();
    if (settled) return;
    observer.sampleActivity({ running: current && sameWorkerIdentity(identity, current) ? true : null, cpu: cpu.cpuTimeMs, content });
    const health = observer.check();
    await reportHealth(); // diagnostics are captured before requesting stop
    if (settled) return;
    if (observer.shouldStop?.() || ['hung', 'failed-to-start'].includes(health.state) || ['HARD_DEADLINE', 'STEP_LIMIT'].includes(health.reasonCode)) stop(health.reasonCode);
    else later(sampleHealth, Math.min(observer.nextDelayMs(), hardRemaining()));
  };
  sampleHealth().catch(() => { observer.gap(); later(sampleHealth, (invocation.health?.checkSeconds ?? 15) * 1000); });
  // Notification of OS launch stays separate from semantic/task acceptance.
  const launchEvent = { invocationId, pid: identity?.pid ?? null, supervisorPid: process.pid, isolation: outcome.mode };
  owner.emit('started', launchEvent); // Preserve the public OS-launch event API.
  owner.emit('launched', launchEvent);
  return done;
}

/**
 * @typedef {Object} LaunchOptions
 * @property {string} prompt - The prompt to send
 * @property {string} sessionId - Session UUID for tracking
 * @property {string} [model='claude-sonnet-5'] - Pinned model variant (see #1450)
 * @property {number} [budget] - Budget per iteration in USD
 * @property {number} [maxTurns] - Maximum number of turns (requires Claude CLI support)
 * @property {boolean} [verbose=false] - Enable verbose output
 * @property {string} [systemPrompt] - System prompt to append
 * @property {Object} [mcpConfig] - MCP server configuration
 * @property {string} workingDir - Working directory for session
 * @property {string} stdoutPath - Path to capture stdout
 * @property {string} stderrPath - Path to capture stderr
 * @property {string} outputDir - Directory for session artifacts
 * @property {number} [timeoutMs] - Timeout in milliseconds
 */

/**
 * @typedef {Object} SessionResult
 * @property {number} exitCode - Process exit code
 * @property {string} stdoutPath - Path to stdout log
 * @property {string} stderrPath - Path to stderr log
 * @property {string} [transcriptPath] - Path to session transcript (if available)
 * @property {string} [parsedEventsPath] - Path to parsed stream events (if available)
 * @property {number} duration - Duration in milliseconds
 * @property {boolean} timedOut - Whether session timed out
 * @property {string} stdoutBuffer - Last portion of stdout
 * @property {number} [toolCallCount] - Number of tool calls detected
 * @property {number} [errorCount] - Number of errors detected
 * @property {number} [totalTokens] - Total token usage detected from stream events
 * @property {number} [inputTokens] - Input token usage detected from stream events
 * @property {number} [outputTokens] - Output token usage detected from stream events
 * @property {number} [costUsd] - Cost detected from stream events
 */

/**
 * @typedef {Object} StreamEvent
 * @property {string} type - Event type (e.g., 'tool_call', 'completion', 'error')
 * @property {number} timestamp - Unix timestamp
 * @property {Object} data - Event data
 */

export class SessionLauncher extends EventEmitter {
  constructor() {
    super();
    this.currentProcess = null;
    this.startTime = null;
    /** @type {import('./lib/provider-adapter.mjs').ProviderAdapter|null} */
    this.providerAdapter = null;
  }

  /**
   * Set the provider adapter for CLI abstraction
   * @param {import('./lib/provider-adapter.mjs').ProviderAdapter} adapter
   */
  setProviderAdapter(adapter) {
    this.providerAdapter = adapter;
  }

  /** Attached direct attempt; no Ralph state, monitor constructor, retry or legacy args. */
  async launchWorker(options) {
    if (this.currentProcess || this.workerLaunchPending) throw new Error('A worker is already attached to this launcher');
    this.workerLaunchPending = true;
    try { return await launchOneWorker(this, options); }
    finally { this.workerLaunchPending = false; }
  }

  /** Explicit manual observation grants no signal authority, with or without scratch. */
  async adoptWorker({ runDir, invocationId = null, worker, paths = null, request } = {}) {
    const { inspectWorkerPath: inspect } = await importImpl(import.meta.url, 'serve/worker-invocation.js');
    let record = {};
    if (runDir) {
      if (!await inspect(runDir, 'directory')) throw new Error('Manual run directory is missing');
      const stat = await lstat(runDir);
      if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Manual run directory must be private and owned');
      const filename = join(runDir, 'process.json');
      if (await inspect(filename, 'file')) {
        const fileStat = await lstat(filename);
        if (fileStat.uid !== process.getuid() || (fileStat.mode & 0o077)) throw new Error('Manual metadata must be private and owned');
        record = JSON.parse((await boundedPrivateRead(filename, 65536, inspect)).toString('utf8'));
      }
    }
    const known = worker ?? record.worker ?? {};
    const fields = ['pid', 'pgid', 'uid', 'host', 'bootId', 'startTicks', 'executable', 'parentPid', 'sessionId'];
    const identity = Object.fromEntries(fields.map(key => [key, known[key] ?? null]));
    const binding = request ?? record.request ?? {};
    const requestFields = ['serverRef', 'requestId', 'sessionId', 'taskTokenRef', 'endpointIdentity'];
    const requestIdentity = Object.fromEntries(requestFields.map(key => [key, binding[key] ?? null]));
    const observedWorker = Number.isSafeInteger(identity.pid) ? sampleWorkerIdentity(identity.pid) : null;
    const health = createWorkerHealthObserver({ invocationId: invocationId ?? record.invocationId ?? 'manual',
      health: { handshake: 'unobserved', outputFraming: 'opaque', coverage: 'unobserved' } }).snapshot();
    health.startupDeadlineAt = null; health.hardDeadlineAt = null;
    health.termination = 'uncertain'; health.unavailableSignals.push('enforced-deadline', 'confirmed-stop');
    return { origin: 'manual', invocationId: invocationId ?? record.invocationId ?? null, worker: identity,
      request: requestIdentity,
      supervisor: null, paths, runDir: runDir ?? null, coverage: runDir ? 'known-files-only' : 'conductor-context-only',
      termination: 'uncertain', exitCode: null, signal: null, ownership: 'unknown',
      unavailable: [...fields.filter(key => identity[key] === null), ...requestFields.filter(key => requestIdentity[key] === null), 'enforced-deadline', 'confirmed-stop'],
      observedWorker, health };
  }

  /**
   * Build Claude CLI arguments
   * @param {LaunchOptions} options
   * @returns {string[]}
   */
  buildArgs(options) {
    const args = [
      // SECURITY: This flag bypasses ALL permission prompts
      // Required for headless operation but enables:
      // - Unrestricted file read/write
      // - Arbitrary command execution
      // - Network access without confirmation
      // See docs/ralph-external-security.md
      '--dangerously-skip-permissions',
      '--print',
      '--output-format', 'stream-json',
      '--session-id', options.sessionId,
    ];

    // Verbose mode
    if (options.verbose) {
      args.push('--verbose');
    }

    // Model selection
    if (options.model) {
      args.push('--model', options.model);
    }

    // Budget control
    if (options.budget) {
      args.push('--max-budget-usd', String(options.budget));
    }

    // Max turns control (if supported by Claude CLI)
    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }

    // MCP configuration
    if (options.mcpConfig) {
      const configJson = typeof options.mcpConfig === 'string'
        ? options.mcpConfig
        : JSON.stringify(options.mcpConfig);
      args.push('--mcp-config', configJson);
    }

    // System prompt injection
    if (options.systemPrompt) {
      args.push('--append-system-prompt', options.systemPrompt);
    }

    // The prompt itself
    args.push(options.prompt);

    return args;
  }

  /**
   * Launch a Claude Code session
   * @param {LaunchOptions} options
   * @returns {Promise<SessionResult>}
   */
  async launch(options) {
    const sessionResult = await this._launchSession(options);

    // Post-session artifact capture
    await this._captureSessionArtifacts(options, sessionResult);

    return sessionResult;
  }

  /**
   * Internal method to launch session and capture basic output
   * @private
   * @param {LaunchOptions} options
   * @returns {Promise<SessionResult>}
   */
  _launchSession(options) {
    return new Promise((resolve, reject) => {
      // Ensure output directories exist
      mkdirSync(dirname(options.stdoutPath), { recursive: true });
      mkdirSync(dirname(options.stderrPath), { recursive: true });
      if (options.outputDir) {
        mkdirSync(options.outputDir, { recursive: true });
      }

      // Use adapter for args if available, otherwise use legacy buildArgs
      const args = this.providerAdapter
        ? this.providerAdapter.buildSessionArgs({
            prompt: options.prompt,
            // AIWG's tracking UUID is not an OMP native session to resume.
            sessionId: this.providerAdapter.getName() === 'omp' ? options.resumeSession : options.sessionId,
            model: options.model,
            budget: options.budget,
            maxTurns: options.maxTurns,
            verbose: options.verbose,
            systemPrompt: options.systemPrompt,
            mcpConfig: options.mcpConfig,
            thinking: options.thinking,
            tools: options.tools,
          })
        : this.buildArgs(options);
      this.startTime = Date.now();

      // Create write streams for output capture
      const stdoutStream = createWriteStream(options.stdoutPath);
      const stderrStream = createWriteStream(options.stderrPath);
      // Listen for capture-stream errors from the start, so a disk error before
      // the child closes cannot surface as an unhandled 'error' event.
      let captureError = null;
      for (const stream of [stdoutStream, stderrStream]) {
        stream.on('error', (error) => { captureError ??= error; });
      }
      // child.stdout/child.stderr are the child's pipes, distinct from these
      // disk-backed capture streams. The child 'close' event only proves the
      // child's own pipes drained into our 'data' handlers below; it says
      // nothing about whether createWriteStream's internal buffer has been
      // flushed to disk. Resolving on 'close' without waiting for these
      // streams' 'finish' event races the capture file write against callers
      // (e.g. the launcher's own caller) reading stdoutPath/stderrPath
      // immediately after launch() resolves, and can hand back a truncated
      // file under I/O load (#2981).
      const finalizeCaptureStream = stream => new Promise(res => {
        if (stream.destroyed || stream.writableFinished) { res(); return; }
        stream.once('error', res);
        stream.end(res);
      });

      // Buffer for last portion of stdout (for quick analysis)
      let stdoutBuffer = '';
      const isOmp = this.providerAdapter?.getName() === 'omp';
      let ompOutput = '';
      const ompTextDecoder = new StringDecoder('utf8');
      let ompInvalid = false;
      const maxBufferSize = 100000; // 100KB

      // Spawn process using provider adapter or legacy Claude defaults
      const binary = this.providerAdapter ? this.providerAdapter.getBinary() : 'claude';
      const envOverrides = this.providerAdapter ? this.providerAdapter.getEnvOverrides() : { CI: 'true' };

      const abortInput = this.providerAdapter?.getAbortInput?.();
      this.currentProcess = spawn(binary, args, {
        cwd: options.workingDir,
        detached: isOmp && process.platform !== 'win32',
        stdio: [abortInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...envOverrides,
        },
      });

      const child = this.currentProcess;
      const terminate = (signal) => { try { if (isOmp && process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* process already exited */ } };

      // Capture stdout
      child.stdout.on('data', (chunk) => {
        if (isOmp && !ompInvalid) {
          ompOutput += ompTextDecoder.write(chunk);
          if (Buffer.byteLength(ompOutput) > 64 * 1024 * 1024) { ompInvalid = true; ompOutput = ''; terminate('SIGKILL'); }
        }
        stdoutStream.write(chunk);
        stdoutBuffer += chunk.toString();
        // Keep buffer size manageable
        if (stdoutBuffer.length > maxBufferSize) {
          stdoutBuffer = stdoutBuffer.slice(-maxBufferSize);
        }
        this.emit('stdout', chunk);
      });

      // Capture stderr
      child.stderr.on('data', (chunk) => {
        stderrStream.write(chunk);
        this.emit('stderr', chunk);
      });

      // Handle timeout
      let timeoutId = null;
      let timedOut = false;
      // Escalation timers armed by the timeout path. They are unref'd so a
      // child that settles during the abort grace window does not hold the
      // loop process open for the full TERM/KILL schedule, and cleared on
      // close so nothing fires against a reaped pid (#2550).
      const escalationTimers = new Set();
      const armEscalation = (fn, delayMs) => {
        const timer = setTimeout(() => { escalationTimers.delete(timer); fn(); }, delayMs);
        if (typeof timer.unref === 'function') timer.unref();
        escalationTimers.add(timer);
        return timer;
      };
      const clearEscalation = () => {
        for (const timer of escalationTimers) clearTimeout(timer);
        escalationTimers.clear();
      };
      this.pendingEscalationTimers = escalationTimers;

      if (options.timeoutMs) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          this.emit('timeout');
          if (abortInput && child.stdin?.writable) child.stdin.write(abortInput);
          const terminateDelay = abortInput ? 2000 : 0;
          armEscalation(() => terminate('SIGTERM'), terminateDelay);
          // Force kill after bounded graceful-abort and termination windows.
          armEscalation(() => {
            if (child.exitCode === null && child.signalCode === null) {
              terminate('SIGKILL');
            }
          }, terminateDelay + 5000);
        }, options.timeoutMs);
      }

      // Handle process completion
      child.on('close', (code) => {
        if (isOmp) terminate('SIGKILL');
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        clearEscalation();

        const duration = Date.now() - this.startTime;
        this.currentProcess = null;

        // Close streams and wait for the capture files to actually finish
        // writing to disk before handing stdoutPath/stderrPath back to the
        // caller (see finalizeCaptureStream above for why 'close' alone is
        // not sufficient).
        Promise.all([finalizeCaptureStream(stdoutStream), finalizeCaptureStream(stderrStream)]).then(() => {
          // A failed capture means stdoutPath/stderrPath are incomplete; report
          // it rather than hand back a truncated transcript as a result.
          if (captureError) {
            this.emit('error', captureError);
            reject(captureError);
            return;
          }
          const result = {
            exitCode: isOmp && (ompInvalid || !this.providerAdapter.parseOutput(ompOutput, { exitCode: code ?? 1 })?.success) ? (code || 1) : (code ?? 1),
            stdoutPath: options.stdoutPath,
            stderrPath: options.stderrPath,
            duration,
            timedOut,
            stdoutBuffer,
          };

          this.emit('complete', result);
          resolve(result);
        });
      });

      // Handle process errors
      child.on('error', (err) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        clearEscalation();

        this.currentProcess = null;

        // Close streams before surfacing the error; no result is returned on
        // this path, so there is nothing to race against, but we still avoid
        // leaving the capture streams dangling.
        Promise.all([finalizeCaptureStream(stdoutStream), finalizeCaptureStream(stderrStream)]).then(() => {
          this.emit('error', err);
          reject(err);
        });
      });

      this.emit('started', { pid: child.pid, args });
    });
  }

  /**
   * Capture session artifacts after completion
   * @private
   * @param {LaunchOptions} options
   * @param {SessionResult} result
   */
  async _captureSessionArtifacts(options, result) {
    if (!options.outputDir) {
      return; // No output directory specified
    }

    try {
      // Copy session transcript if available
      const transcriptPath = await this.copySessionTranscript(
        options.sessionId,
        options.workingDir,
        options.outputDir
      );
      if (transcriptPath) {
        result.transcriptPath = transcriptPath;
      }

      // Parse stream events from stdout
      const { path: eventsPath, stats } = await this.parseStreamEvents(
        options.stdoutPath,
        options.outputDir
      );
      if (eventsPath) {
        result.parsedEventsPath = eventsPath;
        result.toolCallCount = stats.toolCallCount;
        result.errorCount = stats.errorCount;
        result.inputTokens = stats.inputTokens;
        result.outputTokens = stats.outputTokens;
        result.totalTokens = stats.totalTokens;
        result.costUsd = stats.costUsd;
        // Whether the provider actually reported token/cost usage this session.
        // Distinguishes "observed 0" from "cannot observe" so token/spend
        // ceilings aren't silently inert on providers that emit no usage (#1766).
        result.tokenUsageObserved = stats.tokenFieldSeen;
        result.costObserved = stats.costFieldSeen;
      }
    } catch (err) {
      // Log but don't fail the session
      this.emit('artifact-error', err);
    }
  }

  /**
   * Copy session transcript from Claude's project directory
   *
   * Claude stores session transcripts at:
   * ~/.claude/projects/{encoded-path}/{session-id}.jsonl
   *
   * Path encoding: Replace `/` with `-`, prepend `-`
   * Example: /foo/bar → -foo-bar
   *
   * @param {string} sessionId - Session UUID
   * @param {string} workingDir - Working directory path
   * @param {string} outputDir - Destination directory
   * @returns {Promise<string|null>} Path to copied transcript or null if not found
   */
  async copySessionTranscript(sessionId, workingDir, outputDir) {
    try {
      // Use adapter for transcript path if available
      let sourcePath;
      if (this.providerAdapter) {
        sourcePath = this.providerAdapter.getTranscriptPath(sessionId, workingDir);
        if (!sourcePath) {
          // Provider doesn't support transcripts
          this.emit('transcript-not-found', { reason: 'Provider does not support transcripts' });
          return null;
        }
      } else {
        // Legacy Claude-specific path
        const encodedPath = workingDir.replace(/\//g, '-');
        sourcePath = join(
          homedir(),
          '.claude',
          'projects',
          encodedPath,
          `${sessionId}.jsonl`
        );
      }

      // Check if transcript exists
      if (!existsSync(sourcePath)) {
        this.emit('transcript-not-found', { sourcePath });
        return null;
      }

      // Copy to output directory
      const destPath = join(outputDir, 'session-transcript.jsonl');
      copyFileSync(sourcePath, destPath);

      this.emit('transcript-copied', { sourcePath, destPath });
      return destPath;
    } catch (err) {
      this.emit('transcript-error', err);
      return null;
    }
  }

  /**
   * Parse stream-json events from stdout capture
   *
   * Extracts structured events from Claude's stream-json output format.
   * Tracks tool calls, completions, and errors.
   *
   * @param {string} stdoutPath - Path to stdout capture file
   * @param {string} outputDir - Directory to save parsed events
   * @returns {Promise<{path: string|null, stats: Object}>} Parsed events path and statistics
   */
  async parseStreamEvents(stdoutPath, outputDir) {
    const stats = {
      toolCallCount: 0,
      errorCount: 0,
      completionCount: 0,
      totalEvents: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      usageEvents: 0,
      tokenFieldSeen: false,
      costFieldSeen: false,
    };

    try {
      // Read stdout file
      const content = readFileSync(stdoutPath, 'utf-8');

      // Parse stream-json events (each line is a JSON object)
      const events = [];
      const lines = content.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Categorize event
          const eventType = this._categorizeStreamEvent(event);

          const structuredEvent = {
            type: eventType,
            timestamp: Date.now(), // Could extract from event if available
            data: event,
          };

          events.push(structuredEvent);
          stats.totalEvents++;

          // Update stats
          if (eventType === 'tool_call') {
            stats.toolCallCount++;
          } else if (eventType === 'error') {
            stats.errorCount++;
          } else if (eventType === 'completion') {
            stats.completionCount++;
          }

          const usage = this._extractUsageStats(event);
          if (usage.hasTokenField) {
            stats.tokenFieldSeen = true;
          }
          if (usage.hasCostField) {
            stats.costFieldSeen = true;
          }
          if (usage.hasUsage) {
            stats.inputTokens += usage.inputTokens;
            stats.outputTokens += usage.outputTokens;
            stats.cacheCreationInputTokens += usage.cacheCreationInputTokens;
            stats.cacheReadInputTokens += usage.cacheReadInputTokens;
            stats.totalTokens += usage.totalTokens;
            stats.costUsd += usage.costUsd;
            stats.usageEvents++;
          }
        } catch (parseErr) {
          // Skip malformed lines
          continue;
        }
      }

      // Save parsed events
      const eventsPath = join(outputDir, 'parsed-events.json');
      const eventsData = {
        stats,
        events,
        parsedAt: new Date().toISOString(),
      };

      mkdirSync(dirname(eventsPath), { recursive: true });
      const fs = await import('fs/promises');
      await fs.writeFile(eventsPath, JSON.stringify(eventsData, null, 2));

      this.emit('events-parsed', { eventsPath, stats });
      return { path: eventsPath, stats };
    } catch (err) {
      this.emit('parse-error', err);
      return { path: null, stats };
    }
  }

  /**
   * Categorize a stream-json event
   * @private
   * @param {Object} event - Raw event object
   * @returns {string} Event type
   */
  _categorizeStreamEvent(event) {
    // Check for tool-related events first (before checking type field)
    // This handles events like { type: 'tool_use', name: 'read_file' }
    if (event.type === 'tool_use' || event.tool || event.tool_use || event.name?.includes('tool')) {
      return 'tool_call';
    }

    // Check for error events
    // Note: message can be a string or object, so check type before calling includes
    if (event.type === 'error' || event.error || (typeof event.message === 'string' && event.message.includes('error'))) {
      return 'error';
    }

    // Check for other common type fields
    if (event.type) {
      return event.type;
    }

    // Heuristic categorization based on content
    if (event.stop_reason || event.content?.some?.(c => c.type === 'text')) {
      return 'completion';
    }

    if (event.delta || event.content_block_delta) {
      return 'content_delta';
    }

    if (event.message_start || event.content_block_start) {
      return 'start';
    }

    if (event.message_stop || event.content_block_stop) {
      return 'stop';
    }

    return 'unknown';
  }

  /**
   * Get current process PID
   * @returns {number|null}
   */
  getPid() {
    return this.currentProcess?.pid || null;
  }

  /**
   * Check if a process is running
   * @returns {boolean}
   */
  isRunning() {
    return this.currentProcess !== null && !this.currentProcess.killed;
  }

  /**
   * Kill current process
   * @param {string} [signal='SIGTERM']
   */
  kill(signal = 'SIGTERM') {
    if (this.workerStop) { this.workerStop(); return; }
    if (this.currentProcess && !this.currentProcess.killed) {
      if (this.providerAdapter?.getName() === 'omp' && process.platform !== 'win32') {
        const child = this.currentProcess;
        try { process.kill(-child.pid, signal); } catch { /* already exited */ }
        const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } } }, 500);
        timer.unref();
      } else this.currentProcess.kill(signal);
    }
  }

  /**
   * Get elapsed time since start
   * @returns {number|null}
   */
  getElapsed() {
    return this.startTime ? Date.now() - this.startTime : null;
  }

  /**
   * Extract token/cost usage from provider stream events.
   *
   * Providers differ here: Claude stream-json commonly reports usage on message
   * or result events, while other providers may use camelCase or aggregate cost
   * fields. This method intentionally reads only numeric fields and returns a
   * zero-usage result when the event has no observable accounting data.
   *
   * @private
   * @param {Object} event - Raw event object
   * @returns {Object} Usage counters
   */
  _extractUsageStats(event) {
    // Usage can live at event.usage (result events) OR event.message.usage
    // (assistant events). Reading only the former lost all usage on timed-out
    // sessions, whose terminal result event never arrives (#1766).
    const usage =
      (event?.usage && typeof event.usage === 'object' && event.usage) ||
      (event?.message?.usage && typeof event.message.usage === 'object' && event.message.usage) ||
      {};
    const numberFrom = (...values) => {
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
      }
      return undefined;
    };
    let hasTokenField = false;
    const tokenFrom = (...values) => {
      const value = numberFrom(...values);
      if (value !== undefined) hasTokenField = true;
      return value;
    };

    const inputTokens = tokenFrom(
      usage.input_tokens,
      usage.inputTokens,
      event.input_tokens,
      event.inputTokens
    ) ?? 0;
    const outputTokens = tokenFrom(
      usage.output_tokens,
      usage.outputTokens,
      event.output_tokens,
      event.outputTokens
    ) ?? 0;
    const cacheCreationInputTokens = tokenFrom(
      usage.cache_creation_input_tokens,
      usage.cacheCreationInputTokens,
      event.cache_creation_input_tokens,
      event.cacheCreationInputTokens
    ) ?? 0;
    const cacheReadInputTokens = tokenFrom(
      usage.cache_read_input_tokens,
      usage.cacheReadInputTokens,
      event.cache_read_input_tokens,
      event.cacheReadInputTokens
    ) ?? 0;
    const explicitTotal = tokenFrom(
      usage.total_tokens,
      usage.totalTokens,
      event.total_tokens,
      event.totalTokens
    );
    const totalTokens = explicitTotal ??
      inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens;
    const costCandidates = [
      event.cost_usd,
      event.total_cost_usd,
      event.costUsd,
      event.totalCostUsd,
      usage.cost_usd,
      usage.costUsd,
    ];
    const hasCostField = costCandidates.some(
      (v) => typeof v === 'number' && Number.isFinite(v)
    );
    const costUsd = numberFrom(...costCandidates) ?? 0;

    return {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      totalTokens,
      costUsd,
      hasCostField,
      hasTokenField,
      hasUsage: hasTokenField || hasCostField,
    };
  }
}

/**
 * Check if Claude CLI is available
 * @returns {Promise<boolean>}
 */
export async function isClaudeAvailable() {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--version'], {
      stdio: 'pipe',
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Get Claude CLI version
 * @returns {Promise<string|null>}
 */
export async function getClaudeVersion() {
  return new Promise((resolve) => {
    let output = '';

    const child = spawn('claude', ['--version'], {
      stdio: 'pipe',
    });

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        resolve(null);
      }
    });

    child.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Tier 0 direct-dispatch gate-then-launch helper (FR-OG-107/108, #2954, #2888).
 *
 * `SessionLauncher` above is the Claude-headless-loop launcher and is
 * untouched by this addition. A conductor following the subagent-scoping
 * Tier 0 procedure that wants to launch a *non-Claude* resolved worker
 * command (step 6: "Launch within caps") through this module's existing
 * primitives composes the already-qualified host-resource gate
 * (`checkWorkerDispatch`, #2954) with the isolated-launch builder
 * (`launchIsolatedWorker`, #2954) in the fixed order the rule documents:
 * gate first, launch only on a passing gate, never the reverse. This is a
 * pure composition — it adds no new subsystem, store, or mandatory command;
 * callers that already gate and launch themselves may keep doing so.
 *
 * A blocked gate never spawns. A gate that is off (`parallelism.worker_dispatch`
 * disabled) is legacy behavior and launches unconditionally, matching
 * `checkWorkerDispatch`'s own `{ enabled: false, ok: true }` contract.
 *
 * Accepts the complete resolved #2887 invocation (`src/serve/worker-invocation.ts`
 * `prepareWorkerInvocation()` / `aiwg models resolve --format json`) via the
 * `invocation` option and preserves its contract end to end — argv, cwd, stdin
 * source (the brief), the `envNames` allowlist and the separate stdout/stderr
 * destinations — through both `launchIsolatedWorker`'s confined (systemd-unit)
 * path and its degraded path. Flat options (`command`/`args`/`cwd`/`stdinPath`/
 * `envNames`/`stdoutPath`/`stderrPath`) remain accepted directly and win over
 * `invocation` when both are given, for callers that assemble their own plan.
 * `allowDegraded` only ever permits an *unconfined* launch when the caller
 * explicitly opts in, and even then the worker's environment is still built
 * from the `envNames` allowlist alone (never `process.env`) — the functional
 * equivalent of `env -i NAME=value ...`; there is no code path in this helper
 * that inherits the conductor's full environment.
 *
 * @param {object} options
 * @param {string} [options.name] - Human-readable worker label for the unit name.
 * @param {number} options.memoryMaxGb - Resource ceiling for the isolated worker.
 * @param {import('../../src/mission-protocol/types.js').WorkerResolvedInvocation} [options.invocation] -
 *   The resolved #2887 invocation to launch; supplies defaults for the flat
 *   options below when they are not given directly.
 * @param {string} [options.command] - Absolute path to the resolved worker binary
 *   (defaults to `invocation.argv[0]`).
 * @param {string[]} [options.args] - Resolved worker argv, never shell-assembled
 *   (defaults to `invocation.argv.slice(1)`).
 * @param {string} [options.cwd] - Absolute worktree path (defaults to `invocation.cwd`).
 * @param {string} [options.logFile] - Absolute combined stdout/stderr log path,
 *   used only when `stdoutPath`/`stderrPath` are not given.
 * @param {string} [options.stdinPath] - Absolute path the worker reads its brief
 *   from (defaults to `invocation.briefPath` for `brief-text`, none for `closed`,
 *   matching the frozen 'closed' meaning of empty stdin from #2887's shell renderer).
 *   A `brief-json` invocation needs a conductor-framed params file passed
 *   explicitly; the raw brief is never fed to such a worker.
 * @param {string} [options.stdoutPath] - Absolute stdout destination (defaults to
 *   `invocation.stdoutPath`).
 * @param {string} [options.stderrPath] - Absolute stderr destination, distinct from
 *   `stdoutPath` (defaults to `invocation.stderrPath`).
 * @param {string[]} [options.envNames] - Environment-variable allowlist; only these
 *   names are ever forwarded to the worker, confined or degraded (defaults to
 *   `invocation.envNames`, then `['PATH', 'HOME']`).
 * @param {Record<string, string>} [options.env] - Source of allowlisted values
 *   (defaults to the conductor's own `process.env`; never forwarded wholesale).
 * @param {import('../../src/config/aiwg-config.js').AiwgConfig} [options.config] - Current effective config.
 * @param {string[]} [options.paths] - Filesystems to sample free disk on
 *   (defaults to the worker `cwd`/worktree, never the conductor's cwd).
 * @param {boolean} [options.allowDegraded] - Explicit opt-in to an unconfined launch
 *   when no systemd user manager is reachable (recorded as degraded, never silent).
 * @param {boolean} [options.attached] - Launch with live stdio pipes instead of
 *   file redirection (#2892 B2), for an in-process client (e.g. an MCP stdio
 *   client) that needs to read/write the worker's stdin/stdout directly.
 * @returns {{ launched: boolean, blocked?: boolean, failures?: unknown[], mode?: string }}
 *   Same result shape as `launchIsolatedWorker`; a blocked result carries the
 *   dispatch gate's typed failures and never reaches a spawn call.
 */
export function planDirectWorkerLaunch({
  name = 'worker',
  memoryMaxGb,
  invocation,
  command = invocation?.argv?.[0],
  args = invocation?.argv?.slice(1) ?? [],
  cwd = invocation?.cwd,
  logFile,
  stdinPath = invocation?.stdin === 'brief-text' ? invocation.briefPath : undefined,
  stdoutPath = invocation?.stdoutPath,
  stderrPath = invocation?.stderrPath,
  envNames = invocation?.envNames,
  env,
  config,
  allowDegraded = false,
  // Test-only passthroughs mirroring checkWorkerDispatch's own injectable
  // signals/isolation detector; production callers omit these and sample
  // the real host / systemd user manager.
  live,
  readers,
  thresholdOverlay,
  paths,
  isolation,
  spawn,
  spawnAsync,
  proposeUnit,
  kind,
  attached = false,
  ownedGroup = false, onSpawnAttempt,
  // #2892: forwarded only when explicitly given, so every existing caller
  // (which omits it) keeps #2895's own `attached` default (`stdin: 'closed'`
  // -> stdio[0] 'ignore') unchanged. An MCP stdio worker passes `'open'` to
  // get a live, writable stdin pipe for JSON-RPC requests.
  stdin,
} = {}) {
  if (invocation?.stdin === 'brief-json' && stdinPath === undefined) {
    throw new Error('brief-json stdin requires an explicit conductor-framed params file (stdinPath)');
  }
  // Free disk is sampled on the worktree filesystem the worker will actually
  // write to — never the conductor's process cwd. Without live signals or
  // caller-supplied paths, an unknown worktree fails closed in the gate.
  const gate = checkWorkerDispatch({
    config, live, readers, thresholdOverlay,
    paths: paths ?? (typeof cwd === 'string' && cwd ? [cwd] : undefined),
  });
  if (!gate.ok) return { launched: false, blocked: true, failures: gate.failures ?? [], gate };
  return launchIsolatedWorker({ name, memoryMaxGb, command, args, cwd, logFile, stdinPath, stdoutPath, stderrPath,
    gate, config, allowDegraded, attached, ownedGroup, onSpawnAttempt,
    ...(envNames !== undefined ? { envNames } : {}), ...(env !== undefined ? { env } : {}),
    ...(isolation !== undefined ? { isolation } : {}), ...(spawn !== undefined ? { spawn } : {}),
    ...(spawnAsync !== undefined ? { spawnAsync } : {}), ...(proposeUnit !== undefined ? { proposeUnit } : {}),
    ...(kind !== undefined ? { kind } : {}), ...(stdin !== undefined ? { stdin } : {}) });
}

export default SessionLauncher;
