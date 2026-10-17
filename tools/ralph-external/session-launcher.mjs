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
import { open, mkdir, rename, unlink, lstat, readdir, realpath, link } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative, isAbsolute } from 'path';
import { EventEmitter } from 'events';
import { homedir, constants as osConstants } from 'os';
import { parseDocument } from 'yaml';
import { importImpl } from '../_resolve-impl.mjs';
import { sampleWorkerIdentity, sameWorkerIdentity, createWorkerIdentityCapture, sampleWorkerGroup, sampleWorkerChildren, sampleProcessCgroup, sampleProcessAncestry,
  qualifyWorkerCpuTickRate, sampleWorkerCpuTime, isSafeWorkerGroupTarget } from './process-monitor.mjs';
import { createWorkerHealthObserver, sampleOwnedWorktreeContent, classifyWorkerHealthFailure } from './lib/worker-health.mjs';
import { ScopedFailureBreaker, attributeFailureScope } from './lib/consecutive-failure-circuit-breaker.mjs';
import { buildSessionEnvironment } from './lib/session-environment.mjs';
import { launcherRecoveryEvidence, observeLauncherRecoveryOutcome, recordLauncherRecoveryHint } from './lib/launcher-recovery-evidence.mjs';
export { observeLauncherRecoveryOutcome } from './lib/launcher-recovery-evidence.mjs';
import { checkWorkerDispatch, detectWorkerIsolation, launchIsolatedWorker, getWorkerIsolationStatus, stopWorkerUnit, readUnitControlGroup } from './lib/worker-isolation.mjs';
const { signalChild } = await importImpl(import.meta.url, 'process/signal-child.mjs');

// Resolve the same installation owner as CLI/MCP inputs in source and packaged layouts.
const { getWorkerRecoveryCapabilities, workerVersionProbeEnvironment } = await importImpl(import.meta.url, 'models/worker-installation.mjs');

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

// #2915 review 4 (finding 4): `privateOutput: true` REPAIRS a loose mode
// (chmod 0600) rather than rejecting it — correct for the worker's own
// final-output file, which the launcher itself created and is free to
// re-tighten. `rejectInsecureMode: true` additionally REFUSES a mode other
// than exactly 0600 instead of repairing it, for evidence this launcher
// did NOT create moments ago (retry predecessor metadata) — a 0666 file
// there is itself a signal worth refusing on, not silently normalizing
// away.
async function boundedPrivateRead(filename, limit, inspect, privateOutput = false, rejectInsecureMode = false) {
  if (!await inspect(filename, 'file')) throw new Error('Required worker input is missing');
  const handle = await withWorkerPath(filename, target => open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('Worker input must be a bounded unaliased regular file');
    if (privateOutput) {
      if (stat.uid !== process.getuid()) throw new Error('Worker final must be conductor-owned');
      if (rejectInsecureMode) {
        if ((stat.mode & 0o777) !== 0o600) throw new Error('Worker input mode must already be exactly 0600; insecure modes are refused, not repaired');
      } else {
        await handle.chmod(0o600);
      }
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
  if (!identity || !isSafeWorkerGroupTarget(identity.pid, supervisor)
    || !supervisor || identity.pid === supervisor.pid
    || identity.pgid !== identity.pid || identity.uid !== process.getuid?.()
    || identity.pgid === supervisor?.pgid || !sameWorkerIdentity(identity, sample(identity.pid))) return false;
  const members = group(identity.pgid);
  if (!members || !members.length || members.some(member => member.uid !== identity.uid
    || member.bootId !== identity.bootId || member.sessionId !== identity.sessionId)) return false;
  try { kill(-identity.pgid, signal); return true; } catch { return false; }
}

/**
 * Bounded SIGTERM-then-SIGKILL escalation against a single already-spawned
 * child process (#2915 review 5, "a second worker over unresolved
 * execution"): the degraded-isolation MCP wait path in
 * `src/mcp/tools/worker-invoke.mjs` sent a single unobserved SIGTERM on
 * timeout and never escalated, unlike this launcher's own identity-verified
 * degraded `stop()` escalation inside `captureOneWorker`, which always
 * follows an unacknowledged SIGTERM with SIGKILL after a bounded grace
 * window. Exported so every caller that owns a plain (non-owned-group)
 * child process shares this ONE escalation instead of re-implementing
 * SIGTERM/grace/SIGKILL timing a second time.
 *
 * Resolves `{ terminated: boolean }` once the child's own `'exit'` event
 * fires or the bounded window elapses, whichever is first — never waits
 * unboundedly beyond `graceMs` plus one fixed 100ms settle tick.
 */
export function terminateChildWithGrace(child, { graceMs = 5000 } = {}) {
  return new Promise(resolve => {
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (exited()) { resolve({ terminated: true }); return; }
    // A spawn without a PID cannot have started. Avoid waiting for ENOENT;
    // signalChild still validates every PID at both signal boundaries.
    if (!child.pid) { resolve({ terminated: false }); return; }
    let settled = false;
    const done = terminated => {
      if (settled) return;
      settled = true;
      child.removeListener('exit', onExit);
      resolve({ terminated });
    };
    const onExit = () => done(true);
    child.once('exit', onExit);
    try { signalChild(child, 'SIGTERM'); } catch { done(exited()); return; }
    const killTimer = setTimeout(() => {
      try { signalChild(child, 'SIGKILL'); } catch { /* already exited */ }
      setTimeout(() => done(exited()), 100);
    }, graceMs);
    if (killTimer.unref) killTimer.unref();
  });
}

/**
 * ONE function that resolves stop evidence from the isolation layer (#2915
 * round 8, D4), used by every settlement path below instead of deriving
 * `confirmedStop` ad hoc from a child-exit observation or a post-spawn
 * `blocked` outcome (#2915 round 8 critique, finding 5: "stop confirmation
 * is manufactured from insufficient evidence").
 *
 * Returns `{ stop, confirmedStop }` where `stop` is `'none-needed'`,
 * `'unresolved'`, or `'confirmed'` (the vocabulary a reservation's own
 * `stop` field uses — see `ScopedFailureBreaker`), and `confirmedStop` is
 * the boolean every existing `settleDirectWorker`/`reconcileStopEvidence`
 * caller already expects.
 *
 * - `dispatchState: 'never-began'` (the D2 hook was never reached — a
 *   proven pre-spawn refusal): `none-needed`, never `unresolved` — there is
 *   nothing to confirm the stop of.
 * - `dispatchState: 'submission-uncertain'` (a `systemd-run` submission
 *   itself failed or timed out): dispatch-uncertain, so `unresolved` — the
 *   absence of a returned child/unit does not prove nothing dispatched.
 * - `isolationMode: 'systemd-unit'`: the OWNED UNIT (`unitName`) is the
 *   actual stop/query authority — NEVER the attached `systemd-run`
 *   transport child. `confirmed` only when the unit itself is inactive
 *   after the stop request; an unavailable/ambiguous unit query is
 *   `unresolved`, never a fabricated confirmation.
 * - `isolationMode: 'degraded'` (including a degraded ATTACHED transport
 *   wrapper): no native unit query exists, so a confirmed exit of OUR OWN
 *   direct child — the wrapper, or the worker itself for a non-attached
 *   launch — is NEVER sufficient evidence that its descendants stopped;
 *   this always reports `unresolved`/`confirmedStop: false`, even when the
 *   bounded stop escalation below genuinely confirms the direct child
 *   exited (see `ScopedFailureBreaker`'s own doc comment on degraded
 *   blocking markers — this is a documented, accepted limitation, not an
 *   oversight). The escalation still runs, best-effort, so a live child is
 *   actually signalled.
 */
export async function resolveStopEvidence({ isolationMode, unitName = null, child = null,
  dispatchState = 'dispatched', graceMs = 5000, stopFirst = true,
  terminateChild = terminateChildWithGrace, stopUnit = stopWorkerUnit, getStatus = getWorkerIsolationStatus } = {}) {
  if (dispatchState === 'never-began') return { stop: 'none-needed', confirmedStop: false };
  if (dispatchState === 'submission-uncertain') return { stop: 'unresolved', confirmedStop: false };
  if (isolationMode === 'systemd-unit' && unitName) {
    if (stopFirst) {
      try { await stopUnit(unitName); } catch { /* best-effort: still re-check status below */ }
    }
    try {
      const status = await getStatus(unitName);
      // #2915 round 8 review 8 (C2): `active === false` alone is NOT a
      // terminal status -- it can also mean the unit never finished
      // starting, or ExecMainCode has not been set yet. Require the SAME
      // terminal exec-status codes `captureOneWorker`'s own `finish()`
      // already uses (`[1, 2, 3]` -- CLD_EXITED/CLD_KILLED/CLD_DUMPED) before
      // this resolves `confirmed`; `resolveStopEvidence({ active: false,
      // execMainCode: 0 })` must stay `unresolved`, never a fabricated stop.
      if (status && status.active === false && [1, 2, 3].includes(status.execMainCode)) {
        return { stop: 'confirmed', confirmedStop: true };
      }
    } catch { /* unit status unavailable -- fall through to unresolved */ }
    return { stop: 'unresolved', confirmedStop: false };
  }
  if (stopFirst && typeof terminateChild === 'function' && child) {
    try { await terminateChild(child, { graceMs }); } catch { /* best-effort */ }
  }
  return { stop: 'unresolved', confirmedStop: false };
}

/**
 * Optional cancellation/deadline guard for a D2 dispatch-commit hook (#2915
 * round 8 review 8, C3): `{ deadlineAtMs, nowMs, isCancelled }`. Checked
 * twice inside the hook — immediately after `beginDispatch` and again
 * immediately after the ledger debit, right before `commitDispatch` — so a
 * task whose deadline already passed, or that was cancelled, while the
 * hook's own (bounded, but non-zero) work ran never reaches the real
 * process-start call. Throws a plain `Error` on either condition; the
 * caller's existing `abortDispatch`/refund handling in the hook's own
 * try/catch applies exactly like any other hook failure.
 *
 * Never defaults `nowMs`; a caller that omits `dispatchGuard` entirely (every
 * existing caller today) gets no guard at all, matching every other
 * optional D2 hook input — this never changes behavior unless a caller
 * explicitly opts in.
 */
function checkDispatchGuard(dispatchGuard) {
  if (!dispatchGuard) return;
  if (typeof dispatchGuard.isCancelled === 'function' && dispatchGuard.isCancelled()) {
    throw new Error('Worker dispatch refused: cancelled before process start');
  }
  if (dispatchGuard.deadlineAtMs != null) {
    const now = typeof dispatchGuard.nowMs === 'function' ? dispatchGuard.nowMs() : Date.now();
    if (now >= dispatchGuard.deadlineAtMs) {
      throw new Error('Worker dispatch refused: deadline exceeded before process start');
    }
  }
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

const _workerRecoverySubscriptions = new WeakMap();
const _workerRecoveryReporters = new WeakMap();
const _reportedRecoveryTransitions = new WeakSet();

function subscribeWorkerRecovery(owner, breaker) {
  if (typeof breaker?.on !== 'function') return;
  let reporter = _workerRecoveryReporters.get(breaker);
  if (!reporter) {
    reporter = { owners: new Set() };
    // The breaker owns this reporter, so a cohort's last completion still
    // reports when every launcher with an operator listener has finished.
    breaker.on('transition', event => {
      if (_reportedRecoveryTransitions.has(event)) return;
      const target = [...reporter.owners].find(candidate => candidate.listenerCount('recovery-transition'));
      if (target) {
        _reportedRecoveryTransitions.add(event);
        target.emit('recovery-transition', event);
      } else {
        // Give an admission's explicit reporter the first chance to claim
        // this event when the breaker is also shared with another surface.
        queueMicrotask(() => {
          if (_reportedRecoveryTransitions.has(event)) return;
          _reportedRecoveryTransitions.add(event);
          console.error(event.summary);
        });
      }
    });
    _workerRecoveryReporters.set(breaker, reporter);
  }
  reporter.owners.add(owner);
  _workerRecoverySubscriptions.set(owner, () => reporter.owners.delete(owner));
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
  // #2915 review 5 (finding 4, "unauthenticated or reused authority"):
  // `verifyRetryPredecessor`'s own `workerWritableRoots` exclusion was
  // never wired into production -- `SessionLauncher.launchWorker` called
  // it BEFORE any plan was even loaded, with no resolved driver and so no
  // `workerWritableRoots` to pass, leaving a forged predecessor record
  // planted inside a worker-writable directory able to pass through the
  // real `launchWorker` unchecked. Resolving the plan first (here, after
  // `writableRoots` is already computed above for the run-directory check)
  // is what it takes to pass the SAME production-resolved roots into this
  // check too.
  let verifiedPreviousAttemptId = null;
  if (options?.retryOf !== undefined) {
    const exitRecord = await verifyRetryPredecessor(options.retryOf,
      { newInvocationPath: options?.invocationPath, inspect, workerWritableRoots: writableRoots });
    verifiedPreviousAttemptId = exitRecord.invocationId;
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
  // #2915 round 8 (D6): the COMPLETE eligibility decision — global switch,
  // per-CLI switch, `canVerifyAttempt`, explicit breaker override — made
  // ONCE here, at the earliest point every input it needs (`gate.enabled`,
  // the resolved `invocation`, `inputs.drivers`, `options.scopedBreaker`)
  // is actually known, and strictly before anything #2915 added runs
  // (before the task digest). `admitDirectWorker` below calls this exact
  // same predicate with these exact same inputs, so its own `gated` can
  // never disagree with this one — not "kept in sync by two matching
  // conditions", structurally the same answer by construction. Not gated:
  // hand off to `launchOneWorkerBaseline`, the frozen `a4085b86a`
  // reproduction above, and return directly — none of the digest,
  // admission, correction-budget or recovery-settlement code below this
  // point ever runs for this attempt.
  const eligibility = directRecoveryEligibility({ gateEnabled: gate.enabled, config: inputs.snapshot.config,
    invocation, drivers: inputs.drivers, scopedBreaker: options?.scopedBreaker });
  if (!eligibility.gated) {
    return launchOneWorkerBaseline(owner, options, { saved, invocation, runDir, runExists, paths, gate, isolation,
      verifiedPreviousAttemptId, loadInputs, validate, inspect, clock, qualificationDigest, inputs, brief, stdinBytes });
  }
  const transitionBreaker = options.scopedBreaker ?? getDirectRecoveryBreaker();
  subscribeWorkerRecovery(owner, transitionBreaker);
  // #2915 final (one admission, step 3): invocation ids are minted BEFORE
  // admission, so the exact covering-key set that gated this attempt is the
  // same set `settleDirectWorker` later resolves against — no separate
  // pre-mint probe and post-mint noted-keys pair to drift apart. `options.
  // scopedBreaker === null` disables the gate for callers that own recovery
  // themselves; pre-spawn refusals above never reach this point. Global
  // dispatch AND per-CLI enablement are checked inside `admitDirectWorker`
  // before any breaker construction (#2915 final review, finding 1).
  const invocationId = randomUUID();
  // #2915 review 4 (finding 8): computed ONCE, before admission, so the
  // SAME digest both gates the allowance reservation here and is published
  // into invocation.json below — never recomputed from a possibly-stale
  // `invocation` snapshot after the mid-attempt revalidation further down.
  //
  // #2915 round 8 (D6, formerly review 6 finding 6 / review 7 finding 13):
  // this line is reached ONLY when `eligibility.gated` is true (the branch
  // above already returned for every not-gated case — global switch,
  // per-CLI switch, `canVerifyAttempt`, explicit breaker override — via
  // the frozen `launchOneWorkerBaseline`, which publishes the origin/main
  // `qualificationDigest(saved.request)` algorithm instead). There is no
  // remaining not-gated case for this line to preserve origin/main
  // behavior for; computing the new stable task-chain digest
  // unconditionally here is exactly as safe as computing it conditionally
  // was unsafe — this file no longer has two places that both decide
  // "is this gated" and can disagree.
  const taskDigest = await stableTaskChainDigest(saved.request, invocation.briefDigest);
  const dispatchClockNow = () => options.scopedBreaker?.nowMs?.() ?? Number(process.hrtime.bigint()) / 1e6;
  const dispatchGuard = options.dispatchGuard ?? {
    nowMs: dispatchClockNow,
    deadlineAtMs: dispatchClockNow() + Math.min(invocation.health?.hardTimeoutSeconds ?? invocation.limits.wallSeconds,
      invocation.limits.wallSeconds) * 1000,
  };
  let admission;
  try {
    admission = await admitDirectWorker({ gateEnabled: gate.enabled, config: inputs.snapshot.config,
      invocation, invocationId, drivers: inputs.drivers, scopedBreaker: options?.scopedBreaker,
      taskChainDigest: taskDigest, maxAttempts: invocation.limits?.maxAttempts, captureRoot: options?.captureRoot, dispatchGuard,
      onTransition: null });
  } catch (error) {
    // Fail closed, never fail open or leak a slot: an admission-time
    // exception (bad breaker state, a thrown import) is a refusal, not a
    // silent skip of the gate.
    const wrapped = new Error(`Worker launch refused: recovery admission failed closed: ${error?.message ?? String(error)}`);
    wrapped.code = RECOVERY_SCOPE_OPEN_CODE;
    throw wrapped;
  }
  if (admission.refused) {
    // #2915 review 4 (finding 8): a ledger-exhaustion refusal has no
    // covering scope (`blockedBy` is empty) -- say so plainly instead of
    // reporting an empty "recovery scope open ()", which reads as a
    // breaker refusal that never happened.
    const message = admission.refused.blockedBy.length
      ? `Worker launch refused: recovery scope open (${admission.refused.blockedBy.join(', ')})`
      : `Worker launch refused: ${admission.refused.reason ?? admission.refused.code}`;
    const error = new Error(`${message}${admission.refused.reason ? `; ${admission.refused.reason}` : ''}`);
    error.probeDiagnostic = admission.refused.probeDiagnostic;
    error.code = admission.refused.code;
    error.blockedBy = admission.refused.blockedBy;
    if (admission.refused.ledgerDiagnostic) error.ledgerDiagnostics = [admission.refused.ledgerDiagnostic];
    throw error;
  }
  // #2915 review 6 (finding 9): collects every ledger-accounting diagnostic
  // (a refund that failed to persist) across this attempt's lifecycle so it
  // can be surfaced on the thrown error or the returned result, instead of
  // being silently swallowed. `admission.ledgerDiagnostic` (finding 4: a
  // worker-writable captureRoot fell back to the in-process ledger) is
  // folded in up front so every exit path reports it.
  const ledgerDiagnostics = admission.ledgerDiagnostic ? [admission.ledgerDiagnostic] : [];
  const settleLedger = async (outcome) => {
    const diagnostic = await settleDirectWorker(admission, outcome);
    if (diagnostic) ledgerDiagnostics.push(diagnostic);
  };
  // #2915 review 4 (finding 8): once a real ledger exists, it — not the
  // caller-supplied `options.correctStartup.correctionsUsed` — is
  // authoritative for the one-correction budget. `SessionLauncher.
  // launchWorker`'s own early gate (using the caller's count) still runs
  // first as a fast pre-check with no plan/ledger loaded yet; this is the
  // actual enforcement whenever a task chain is resolvable.
  //
  // #2915 review 6 (finding 6): the read, `startupCorrectionGate`
  // validation and the increment+write now happen inside ONE atomic
  // `reserveLedgerCorrection` call, replacing the former peek-then-gate-
  // then-record sequence (three independent, unlocked steps two concurrent
  // launches could each pass).
  //
  // #2915 review 6 (finding 9): wrapped in try/catch so ANY exception from
  // this block (lock contention, a corrupted record) settles the admission
  // before re-throwing -- the former code let such an exception escape
  // uncaught, stranding the breaker reservation AND the ledger's pending
  // slot forever (neither settle call below this point would ever run).
  if (options?.correctStartup !== undefined && admission.ledger) {
    let gate;
    try {
      // #2915 round 8 (D1.8): bound to admission's own attempt handle --
      // never re-derived from `taskChainDigest`/`maxAttempts`/`captureRoot`
      // -- so the correction slot lives in the exact chain directory (or
      // in-process chain) this admission's reserve already resolved, and
      // is charged/refunded automatically wherever that handle is.
      gate = await reserveLedgerCorrection({ ledger: admission.ledger, reasonCode: options.correctStartup.reasonCode });
    } catch (error) {
      await settleLedger({ kind: 'uncertain', confirmedStop: true });
      if (ledgerDiagnostics.length) error.ledgerDiagnostics = ledgerDiagnostics;
      throw error;
    }
    if (!gate.ok) {
      // #2915 review 6 (finding 3b, "blocking markers... zero spawns"): a
      // reservation that provably never dispatched must release without
      // leaving a marker, even if this settlement happens to land past its
      // own canary deadline -- PROVEN here: no worker process has been
      // started at any point before this refusal.
      await settleLedger({ kind: 'uncertain', confirmedStop: true });
      const error = new Error(`Startup correction refused: ${gate.reason}`);
      error.code = 'STARTUP_CORRECTION_REFUSED';
      if (ledgerDiagnostics.length) error.ledgerDiagnostics = ledgerDiagnostics;
      throw error;
    }
  }
  // #2915 review 4 (finding 2): this run-directory preparation is
  // pre-spawn work happening AFTER a successful admission above — any
  // failure here (mkdir, ownership, the `.launch-owner` write) must settle
  // the reservation exactly like every other pre-spawn exit, never leak it
  // by throwing before the big try/catch below is reached.
  try {
    if (!runExists) await mkdir(runDir, { mode: 0o700 }); // exclusive attempt: no recursive creation or reuse
    const runStat = await lstat(runDir);
    if (runStat.uid !== process.getuid()) throw new Error('Worker run directory must be conductor-owned');
    await withWorkerPath(runDir, async target => { const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.chmod(0o700); } finally { await handle.close(); } });
    const reservation = await withWorkerPath(join(runDir, '.launch-owner'), target => open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    try { await reservation.writeFile(invocationId); await reservation.sync(); } finally { await reservation.close(); }
  } catch (error) {
    // #2915 review 6 (finding 3b): PROVEN zero-spawn pre-spawn failure --
    // release without leaving a marker even past the canary deadline.
    await settleLedger({ kind: 'uncertain', confirmedStop: true });
    if (ledgerDiagnostics.length) error.ledgerDiagnostics = ledgerDiagnostics;
    throw error;
  }
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
    // #2915 review 4 (finding 4): a STABLE task-chain identity, never the
    // raw request object — `qualificationDigest(saved.request)` included
    // `final_output` (a fresh path on every legitimate attempt by design)
    // and the `brief`/`workdir` PATHS, so a genuinely confirmed predecessor
    // with a fresh output path was incorrectly refused as a "different
    // task". Identity is role/task/group plus the BRIEF CONTENT digest
    // (never its path) — the same instructions, not the same
    // attempt-specific paths. (Computed once, above, before admission.)
    await publish('invocation.json', { version: 1, origin: 'launcher', invocationId, attemptId: invocationId,
      // #2915 step 4: set only after `verifyRetryPredecessor` (above, now
      // resolved HERE with the production `workerWritableRoots` wired in —
      // #2915 review 5 finding 4) independently confirmed the predecessor's
      // owned, launcher-written, confirmed-terminal evidence for this exact
      // task — never from an unverified caller claim.
      previousAttemptId: verifiedPreviousAttemptId,
      requestId: invocationId, taskDigest, role: saved.request.role,
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
    // #2915 round 8 (D2, replaces the former "debit immediately before this
    // call" comment): the ledger debit now happens INSIDE the dispatch-
    // commit hook, which `launchIsolatedWorker` invokes itself after ALL of
    // its own preparation checks (isolation detection, argument/path
    // validation, manager-environment resolution) and immediately before
    // the actual process-start call — never before them, and never here.
    // This closes the "debiting before the wrapper is premature" gap: a
    // preparation failure INSIDE `launchIsolatedWorker` (e.g. an
    // unreachable systemd user manager) now never reaches the debit at
    // all, exactly like any other pre-spawn refusal above this line.
    //
    // The hook also re-admits this exact dispatch through the breaker's own
    // `beginDispatch -> commitDispatch` bracket (#2915 round 8, D3) — the
    // single leaf-level consumption of this reservation's launch authority,
    // replacing the former separate `claimLaunch` call the borrowed-
    // admission path used to make. `abortDispatch` on any failure (a
    // rejected `beginDispatch`/`commitDispatch`, or a ledger debit that
    // throws) leaves nothing started and the reservation in a releasable,
    // never-dispatched state.
    // `dispatchGuard` (#2915 round 8 review 8, C3): caller-supplied or
    // constructed from this launch's own monotonic task budget,
    // `{ deadlineAtMs, nowMs, isCancelled }`, checked immediately after
    // `beginDispatch` and again after the ledger debit, immediately before
    // `commitDispatch` -- so a task that already blew its deadline or was
    // cancelled while this hook's own preparation ran never reaches the
    // real process-start call.
    const onDispatchCommit = admission.gated ? async () => {
      const began = admission.breaker.beginDispatch(admission.token,
        { invocationId: admission.invocationId, selectionDigest: admission.selectionDigest });
      if (!began.ok) throw new Error(`Worker dispatch refused: ${began.reason}`);
      try {
        checkDispatchGuard(dispatchGuard);
        if (admission.ledger) await debitDirectWorkerAllowance(admission.ledger);
        checkDispatchGuard(dispatchGuard);
      } catch (error) {
        try { admission.breaker.abortDispatch(admission.token, { callerAborted: dispatchGuard?.isCancelled?.() === true }); } catch { /* best-effort */ }
        throw error;
      }
      const committed = admission.breaker.commitDispatch(admission.token);
      if (!committed.ok) {
        try { admission.breaker.abortDispatch(admission.token, { callerAborted: dispatchGuard?.isCancelled?.() === true }); } catch { /* best-effort */ }
        throw new Error(`Worker dispatch refused: ${committed.reason}`);
      }
    } : undefined;
    // #2915 round 8: `launchIsolatedWorker`'s dual-mode contract (see its
    // own doc comment on `_runDispatchCommit`) returns a plain object
    // synchronously whenever NO hook is given (the not-gated case) — only
    // `await` it when it genuinely returned a Promise, so a not-gated
    // attached launch keeps its real child's listeners attached in the
    // SAME synchronous tick the child is spawned in, exactly as before
    // this change. Introducing an unconditional microtask tick here let a
    // real child's own queued events (exit/close) race ahead of
    // `captureOneWorker`'s own listener attachment in several tests (and
    // would in production).
    const launchResult = (options.launchIsolated ?? launchIsolatedWorker)({ name: invocationId,
      command: artifacts.argv[0], args: artifacts.argv.slice(1), cwd: invocation.cwd,
      memoryMaxGb: options.memoryMaxGb ?? 4, gate, config: inputs.snapshot.config, isolation,
      allowDegraded: !!options.allowDegraded, attached: true, ownedGroup: true,
      env: environment, envNames: invocation.envNames, stdin: invocation.stdin, runDir,
      ...(onDispatchCommit ? { onDispatchCommit } : {}) });
    outcome = typeof launchResult?.then === 'function' ? await launchResult : launchResult;
    if (!outcome.child) throw new Error('Worker launch did not return an attached child');
    // #2915 review 4 (finding 3): when THIS attempt is the admitted canary
    // for one or more covering scopes, execution itself must be clipped to
    // the canary's own deadline (min(task deadline, admission+300s)) — not
    // merely the breaker's bookkeeping, which only knows how to settle a
    // reservation after the fact. `canaryDeadlineMs`/`canaryNowMs` let
    // `captureOneWorker` enforce a real stop at that wall-clock deadline,
    // on the SAME clock the breaker used to compute it (so synthetic-clock
    // tests and production `Date.now()` both stay self-consistent).
    const canaryDeadlineMs = admission.token?.canaryKeys?.length > 0 ? admission.token.deadlineMs : null;
    const canaryNowMs = admission.breaker?.nowMs ?? (() => Date.now());
    const result = await captureOneWorker(owner, { child: outcome.child, outcome, invocation, invocationId, supervisor,
      launchTime, monotonicStart, publish, publishFailures, paths, handles, inspect, inputs, profile, baselineContent, options, brief, stdinBytes, runDir,
      canaryDeadlineMs, canaryNowMs,
      // #2915 review 4 (finding 7): recovery-specific attempt parsing
      // (`getWorkerRecoveryCapabilities(driver).parseWorkerAttemptFinal`) and `result.attemptOutcome`
      // publication only run when recovery is actually gated — disabled
      // dispatch must do no new work at all, matching origin/main exactly
      // (a disabled-dispatch probe still observed the new parser called
      // once).
      recoveryGated: admission.gated });
    // #2915 final (production closure): settle using the evidence-contract
    // `result.attemptOutcome` — never `result.termination` — so a genuinely
    // successful degraded attempt closes its scope instead of silently
    // reopening it forever (#2915 final review, finding 4).
    await observeLauncherRecoveryOutcome({ invocation, result, breaker: admission.breaker,
      installation: inputs.drivers[invocation.selected.cli]?.qualification?.installation,
      timeoutMs: () => Math.min(10_000, dispatchGuard.deadlineAtMs - (dispatchGuard.nowMs?.() ?? performance.now())),
      beforeRequest: async () => {
        try { checkDispatchGuard(dispatchGuard); return true; } catch { return false; }
      },
      onDispatch: () => chargeDirectWorkerDiagnostic(admission, dispatchGuard) });
    await settleLedger(classifyAttemptForSettlement(invocation, result,
      { quotaAccount: admission.quotaAccount, installationQualifier: admission.installationQualifier }));
    // #2915 review 6 (finding 6, "changed disabled behavior"): origin/main's
    // `SessionLauncher` never had `lastAttemptResult`/`lastAttemptInvocationId`
    // at all -- gated on `admission.gated` (set HERE, inside `launchOneWorker`,
    // rather than unconditionally in `launchWorker` below) so a disabled-
    // dispatch launch leaves the launcher instance exactly as untouched as it
    // always was, matching origin/main byte-for-byte.
    if (admission.gated) {
      owner.lastAttemptResult = result ?? null;
      owner.lastAttemptInvocationId = result?.invocationId ?? owner.lastAttemptInvocationId;
    }
    // #2915 review 6 (finding 9): surface any ledger-accounting diagnostic
    // accumulated across this attempt's lifecycle on the returned result,
    // mirroring `publishFailures` — never silently discarded.
    if (ledgerDiagnostics.length && result) result.ledgerDiagnostics = ledgerDiagnostics.slice();
    return result;
  } catch (error) {
    if (!outcome?.child) {
      // Pre-spawn failure (or a recovery-scope refusal): PROVEN -- this
      // attempt never ran, so it settles outstanding membership with NO
      // failure evidence (#2915 final review: "every pre-spawn exit
      // releases capacity"). `confirmedStop: true` (#2915 review 6, finding
      // 3b): zero spawns occurred, so release without leaving a marker even
      // if this settlement happens to land past the reservation's own
      // canary deadline.
      await settleLedger({ kind: 'uncertain', confirmedStop: true });
      await publish('exit.json', { invocationId, exitCode: null, signal: null,
        endedAt: new Date().toISOString(), termination: 'confirmed', descendants: 'not-started', errorCode: error.code ?? 'LAUNCH_REFUSED' });
    } else if (admission.gated) {
      // #2915 review 5 (finding 2a, "leaked capacity"), hardened by #2915
      // review 6 (finding 4, "capture-setup exception after spawn"): a
      // child DID attach, but something thrown here means
      // `captureOneWorker` never reached its own normal settlement call
      // above -- its own internal paths are designed to always resolve a
      // `result` rather than throw, so reaching this branch means an
      // exception escaped that contract entirely (e.g. a synchronous
      // failure building the health observer before `finish()` is even
      // wired). The process may genuinely still be running: actually stop
      // it with the SAME bounded SIGTERM-then-SIGKILL escalation every
      // other "stop before retry" path already uses
      // (`terminateChildWithGrace`), and settle with the evidence that
      // produces, rather than abandoning a potentially-live child on a bare
      // 'uncertain' settlement -- the gap that previously let a second
      // canary launch over this attempt's still-running process once
      // backoff elapsed. An UNCONFIRMED stop leaves the finding-3 blocking
      // marker in place if this settlement also lands past the
      // reservation's own canary deadline; a CONFIRMED stop clears it.
      //
      // Confined to the GATED path (#2915 review 6, finding 6, "changed
      // disabled behavior"): origin/main never attempted this and never
      // installed the listener below, so a disabled-dispatch attempt must
      // behave exactly as it always did -- throw immediately, no stop
      // attempt, no listener.
      //
      // The exception escaped before `captureOneWorker` could attach its
      // own `child.once('error', ...)`/`'exit'` listeners, so ANY
      // subsequent async spawn failure (e.g. ENOENT arriving after this
      // synchronous throw, including one already in flight for this exact
      // child) would otherwise surface as an unhandled 'error' event on an
      // EventEmitter with zero listeners -- installed FIRST, before the
      // stop escalation below, which itself can race the same event.
      outcome.child.on('error', () => {});
      // #2915 round 8 (D4): `resolveStopEvidence` is the ONE evidence
      // source here — for `systemd-unit` mode it stops and queries the
      // OWNED UNIT (`outcome.unit`), never the attached `systemd-run`
      // transport child; for `degraded` mode it never fabricates
      // `confirmedStop: true` from a direct-child exit (see its own doc
      // comment).
      const graceMs = (invocation.health?.terminateGraceSeconds ?? 5) * 1000;
      const { confirmedStop } = await resolveStopEvidence({ isolationMode: outcome.mode,
        unitName: outcome.unit ?? null, child: outcome.child, graceMs });
      await settleLedger({ kind: 'uncertain', confirmedStop });
      // #2915 review 6 (finding 3d): when this bounded stop escalation DOES
      // confirm termination, also call the explicit reconciliation -- a
      // harmless no-op if this exact reservation's own settle() above
      // already resolved its marker, but the one path that still clears a
      // blocking marker left behind by a DIFFERENT reservation for this
      // same invocation (e.g. a prior attempt in the same retry chain whose
      // own token is no longer in scope here).
      if (confirmedStop) {
        try { admission.breaker?.reconcileStopEvidence?.({ invocationId, confirmedStop: true }); } catch { /* best-effort */ }
      }
    }
    if (ledgerDiagnostics.length) error.ledgerDiagnostics = ledgerDiagnostics;
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
  const { child, outcome, invocation, invocationId, supervisor, launchTime, monotonicStart, publish, paths, handles, options,
    canaryDeadlineMs = null, canaryNowMs = () => Date.now(), recoveryGated = false } = ctx;
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
  let recoveryReason = null;
  child.stderr.on('data', chunk => {
    observer.feed(chunk, { kind: 'stderr', id: 'stderr', generation: 0, offset: stderrOffset }); stderrOffset += chunk.length;
    const hint = classifyWorkerHealthFailure(chunk.toString('utf8'), { source: { kind: 'stderr' } })?.reasonCode;
    if (['RATE_LIMIT', 'NETWORK'].includes(hint)) recoveryReason = hint;
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
    recordLauncherRecoveryHint(result, recoveryReason);
    // #2915 (evidence contract): `attemptOutcome` is a SEPARATE launcher-owned
    // fact from `termination`/`descendants` above — whether THIS attempt
    // succeeded, never whether the descendant tree is confirmed stopped.
    // `processLevelOutcome` uses only process-observed facts (the direct
    // child's own wait() exit/signal, the systemd unit's own retained
    // ExecMainCode/Status when applicable, launcher-detected errors,
    // timeout and explicit cancellation) — never worker stderr/stdout text
    // or worker-writable records. A degraded-isolation attempt can reach
    // 'succeeded' here even though its `termination` stays 'uncertain'
    // forever (no descendant-stop confirmation is possible without a
    // systemd unit) — this is exactly the #2915 final-review fix: "give
    // degraded successful execution a valid recovery-success path without
    // falsely declaring descendant termination confirmed."
    const directChildCleanExit = sawExit && waitCode === 0 && waitSignal == null;
    const unitConfirmedClean = outcome.mode !== 'systemd-unit' || (native?.execMainCode === 1 && native?.execMainStatus === 0);
    const processLevelOutcome = result.errorCode || result.cancelled || result.timedOut
      ? 'failed'
      : directChildCleanExit && unitConfirmedClean ? 'succeeded'
      : sawExit ? 'failed' // an exit was observed, but it was not a clean one
      : 'uncertain'; // no direct-child exit was ever observed at all
    let healthFinalValid = false;
    let healthAttemptFinalValid = false;
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
          const claims = await driver.parseWorkerFinal(extracted ? output : finalBytes, {
            format: extracted && ctx.profile.health?.outputFraming === 'jsonl' ? 'jsonl' : 'json', observation: { transport: 'shell',
            status: result.exitCode === 0 && !result.errorCode && !result.timedOut ? 'completed' : 'failed',
            termination: result.termination, exitCode: result.exitCode } });
          // #2915 review 4 (finding 1): a successful PARSE is not success —
          // the worker's own strict claims carry their own `status`, and a
          // schema-valid `status: 'failed'` claim must never authorize
          // closure through this path either.
          //
          // #2915 review 5 (finding 6, disabled-dispatch equivalence): that
          // stricter check must apply ONLY when recovery is actually
          // gated. origin/main's own baseline (`healthFinalValid = true`
          // once the strict parse itself succeeds, with no `.status`
          // inspection) is what every disabled-dispatch caller must keep
          // seeing byte-for-byte -- review 5 found a failed claim now
          // changed disabled health from baseline `completed` to
          // `failed-to-start`/`FINAL_INVALID`, a behavior change with
          // recovery OFF that origin/main never had.
          healthFinalValid = recoveryGated ? claims?.status === 'completed' : true;
        } catch { /* failed strict claims remain unverified candidate evidence */ }
      }
      // #2915: the attempt-terminal sibling validation, gating
      // `result.attemptOutcome` below — same bytes/format, but asserted
      // against `processLevelOutcome` (never confirmed termination) so a
      // degraded or MCP attempt's strict final can validate even though
      // `termination` can never reach 'confirmed' for it.
      const recovery = recoveryGated ? getWorkerRecoveryCapabilities(driver) : null;
      if (recovery?.parseWorkerAttemptFinal) {
        try {
          const claims = await recovery.parseWorkerAttemptFinal(extracted ? output : finalBytes, {
            format: extracted && ctx.profile.health?.outputFraming === 'jsonl' ? 'jsonl' : 'json', observation: { transport: 'shell',
            status: processLevelOutcome === 'succeeded' ? 'completed' : 'failed',
            attemptOutcome: processLevelOutcome, exitCode: result.exitCode } });
          // #2915 review 4 (finding 1): same fix as above — a schema-valid
          // parse whose claims report `status !== 'completed'` must never
          // close a scope through the degraded/MCP attempt-terminal path.
          healthAttemptFinalValid = claims?.status === 'completed';
        } catch { /* invalid/missing final never recovers (invalid-final-never-recovers) */ }
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
    // #2915 review 4 (finding 1): finalized HERE — after every
    // metadata-write attempt that has run so far (recordProcess() and the
    // first exit.json publish, above), so the field a write failure must
    // gate already reflects every failure observed up to this point. "Exit
    // zero alone is insufficient": a clean process-level exit without a
    // strictly-valid final, or with an earlier metadata-write failure,
    // never reaches 'succeeded' — it downgrades to 'uncertain' (never
    // fabricated as 'failed' either, since neither the process evidence nor
    // a write failure shows a definite task failure). A process-level
    // failure stays 'failed' regardless of final validity (a bad exit is
    // bad regardless of what the final claims say).
    // #2915 review 4 (finding 7): only published when recovery is gated —
    // disabled dispatch must add no new field/behaviour versus origin/main.
    if (recoveryGated) {
      result.attemptOutcome = processLevelOutcome === 'succeeded'
        ? (healthAttemptFinalValid && result.errorCode !== 'METADATA_WRITE' ? 'succeeded' : 'uncertain')
        : processLevelOutcome;
    }
    try { await publish('exit.json', result); }
    catch {
      result.termination = 'uncertain'; result.errorCode = 'METADATA_WRITE'; result.health.termination = 'uncertain';
      // #2915 review 5 (finding 1b): the PRIOR round left this as a
      // documented residual ("attemptOutcome was already finalized by the
      // time it could observe this specific failure") -- review 5 correctly
      // called that unsafe: a failure of THIS LAST exit.json publication
      // still returned 'succeeded' and closed the breaker scope on an
      // attempt whose own terminal record never durably landed. Downgrade
      // here, exactly like every earlier metadata-write failure already
      // downgrades above -- never upgrade a 'failed' outcome, only prevent
      // an unconfirmed 'succeeded' from standing.
      if (recoveryGated && result.attemptOutcome === 'succeeded') result.attemptOutcome = 'uncertain';
    }
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
  // #2915 review 4 (finding 3): clipped to the admitted canary's own
  // deadline (min(task deadline, admission+300s)) when this attempt is a
  // canary — backoff/expiry sweeps on the breaker side must never leave a
  // live canary's EXECUTION running past the exact deadline that governs
  // whether a second canary could otherwise be admitted over it.
  const hardRemaining = () => {
    const taskRemainingMs = Math.min(invocation.health?.hardTimeoutSeconds ?? invocation.limits.wallSeconds,
      invocation.limits.wallSeconds) * 1000 - (Number(process.hrtime.bigint() - BigInt(monotonicStart)) / 1e6);
    const canaryRemainingMs = canaryDeadlineMs === null ? Infinity : canaryDeadlineMs - canaryNowMs();
    return Math.max(0, Math.min(taskRemainingMs, canaryRemainingMs));
  };
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

// ===========================================================================
// FROZEN TO a4085b86a (#2915 round 8, D6) — do not modify.
//
// `launchOneWorkerBaseline` and `captureOneWorkerBaseline` are a literal,
// byte-for-byte reproduction of `launchOneWorker`/`captureOneWorker` as
// they existed at base commit `a4085b86a` (`git show
// a4085b86a:tools/ralph-external/session-launcher.mjs`) — before any
// #2915 direct-recovery code existed in this file. `launchOneWorker`
// above calls `launchOneWorkerBaseline` for every attempt
// `directRecoveryEligibility` (see above) decides is NOT gated, instead
// of threading that decision through conditions inside the single
// gated-and-not-gated function #2915 originally grew into. That pattern
// — "if (gated) do the new thing else do the old thing" scattered across
// one shared function — is what seven straight review rounds found drift
// in (the persisted `taskDigest`, the constructor's instance shape, an
// an MCP callback argument list, …): a new piece of gated-path logic could
// be added without a matching `if (!gated)`/`if (gated)` guard, and
// nothing would catch it until the next review. Calling an entirely
// separate, frozen function makes that class of defect structurally
// impossible for the code below: there is no gated-path line for a
// future change to add without touching this delimited block, and
// touching this block is exactly what the comment above forbids.
//
// Both functions below call ONLY:
//   - helpers in this same file that are BYTE-IDENTICAL to their
//     `a4085b86a` originals (verified by diff when this block was
//     written: `publishWorkerRecord`, `withWorkerPath`,
//     `materializeWorkerArtifacts`, `signalOwnedWorker`,
//     `verifyWorkerContainment`, `bytesDigest`, `boundedPrivateRead` —
//     the last gained optional trailing parameters after `a4085b86a`
//     that default to its exact original behavior, so every call below,
//     which never passes them, is unaffected);
//   - exports from `./lib/worker-isolation.mjs` that changed on this
//     branch for the D2 dispatch-commit hook, called here exactly as
//     `a4085b86a` called them — with NO `onDispatchCommit` — which that
//     module's own dual-mode contract (`_runDispatchCommit`) defines as
//     "behaves exactly as before the hook existed";
//   - unchanged imports (`process-monitor.mjs`, `lib/worker-health.mjs`,
//     `serve/worker-invocation.js`, `models/qualification-digest.mjs`).
// Neither function imports, reads, or references the breaker, the
// ledger, `admission`, `recoveryGated`, `canaryDeadlineMs`, or any other
// #2915 identifier. If a future change to this file needs these
// functions to do something new, that is new #2915 behavior and belongs
// in `launchOneWorker`/`captureOneWorker` above, gated — never here.
// ===========================================================================

async function launchOneWorkerBaseline(owner, options, ctx) {
  const { saved, invocation, runDir, runExists, paths, gate, isolation, verifiedPreviousAttemptId,
    loadInputs, validate, inspect, clock, qualificationDigest } = ctx;
  let inputs = ctx.inputs;
  let localGate = gate;
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
      previousAttemptId: verifiedPreviousAttemptId ?? null, requestId: invocationId, taskDigest: qualificationDigest(saved.request), role: saved.request.role,
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
    localGate = (options.checkDispatch ?? checkWorkerDispatch)({ config: inputs.snapshot.config });
    if (!localGate.ok) throw new Error('Worker dispatch resource gate refused launch');
    if (bytesDigest(await boundedPrivateRead(invocation.briefPath, 262144, inspect)) !== invocation.briefDigest) throw new Error('Worker prompt changed before spawn');
    const environment = Object.fromEntries(invocation.envNames.filter(name => process.env[name] !== undefined)
      .map(name => [name, process.env[name]]));
    const baselineContent = await sampleOwnedWorktreeContent(invocation.cwd, { files: options.healthArtifacts });
    // The real `launchIsolatedWorker`, called with no `onDispatchCommit`
    // (never passed anywhere in this frozen function), is synchronous —
    // its own dual-mode contract (`_runDispatchCommit`) guarantees that,
    // matching `a4085b86a` exactly. The thenable check below exists only
    // to tolerate a test-injected `options.launchIsolated` written as an
    // `async` function (a test-infrastructure convenience shared with the
    // gated path's own test doubles, not a behavior this branch adds):
    // `await`ing a value that was never a Promise resolves to that exact
    // value with no observable difference.
    const launchResult = (options.launchIsolated ?? launchIsolatedWorker)({ name: invocationId,
      command: artifacts.argv[0], args: artifacts.argv.slice(1), cwd: invocation.cwd,
      memoryMaxGb: options.memoryMaxGb ?? 4, gate: localGate, config: inputs.snapshot.config, isolation,
      allowDegraded: !!options.allowDegraded, attached: true, ownedGroup: true,
      env: environment, envNames: invocation.envNames, stdin: invocation.stdin, runDir });
    outcome = typeof launchResult?.then === 'function' ? await launchResult : launchResult;
    if (!outcome.child) throw new Error('Worker launch did not return an attached child');
    return await captureOneWorkerBaseline(owner, { child: outcome.child, outcome, invocation, invocationId, supervisor,
      launchTime, monotonicStart, publish, publishFailures, paths, handles, inspect, inputs, profile, baselineContent, options,
      brief: ctx.brief, stdinBytes: ctx.stdinBytes, runDir });
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

async function captureOneWorkerBaseline(owner, ctx) {
  const { child, outcome, invocation, invocationId, supervisor, launchTime, monotonicStart, publish, paths, handles, options } = ctx;
  const hasTransport = outcome.mode === 'systemd-unit' || outcome.transportSupervisor;
  const sampleIdentity = options.sampleIdentity ?? sampleWorkerIdentity;
  const sampleNativeSupervisor = options.sampleNativeSupervisor ?? sampleWorkerIdentity;
  // For our own detached child, spawn waits through setsid/exec; one owned leader sample suffices.
  const immediate = !hasTransport ? sampleIdentity(child.pid) : null;
  let identity = immediate?.pid === child.pid && immediate?.pid === immediate?.pgid
    && immediate?.uid === process.getuid?.() && immediate?.parentPid === process.pid ? immediate : null;
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
  const stopUnit = () => { try { return (options.stopUnit ?? stopWorkerUnit)(outcome.unit); } catch { return { ok: false }; } };
  const stop = (cause = errorCode ? 'PROVIDER_ERROR' : 'CANCELLED') => {
    if (settled || stopRequested) return;
    stopRequested = true; stopReason = cause;
    timedOut = ['HARD_DEADLINE', 'STARTUP_DEADLINE', 'NO_PROGRESS'].includes(cause);
    if (outcome.mode === 'systemd-unit' && outcome.unit) {
      stopUnit();
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
    const confirmed = outcome.mode === 'systemd-unit' ? native?.active === false && [1, 2, 3].includes(native.execMainCode)
      : child.pid === undefined;
    const workerExit = hasTransport ? await transportRecord('worker-exit.json') : null;
    if (!identity && hasTransport && nativeSupervisor) {
      const workerStart = await transportRecord('worker-identity.json');
      if (workerStart?.worker && sameWorkerIdentity(workerStart.supervisor, nativeSupervisor)
        && workerStart.worker.parentPid === nativeSupervisor.pid) {
        reportedWorker = workerStart.worker;
        identityObservation = 'transport-reported-unverified';
      }
    }
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
      if (driver.parseWorkerFinal) {
        try {
          await driver.parseWorkerFinal(extracted ? output : finalBytes, {
            format: extracted && ctx.profile.health?.outputFraming === 'jsonl' ? 'jsonl' : 'json', observation: { transport: 'shell',
            status: result.exitCode === 0 && !result.errorCode && !result.timedOut ? 'completed' : 'failed',
            termination: result.termination, exitCode: result.exitCode } });
          healthFinalValid = true;
        } catch { /* failed strict claims remain unverified candidate evidence */ }
      }
    } catch { result.errorCode ??= 'FINAL_OUTPUT_INVALID'; }
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
  child.once('close', () => { sawClose = true; finish(); });
  const hardRemaining = () => Math.max(0, Math.min(invocation.health?.hardTimeoutSeconds ?? invocation.limits.wallSeconds,
    invocation.limits.wallSeconds) * 1000 - (Number(process.hrtime.bigint() - BigInt(monotonicStart)) / 1e6));
  later(() => {
    observer.check();
    reportHealth(); stop('HARD_DEADLINE');
  }, hardRemaining());
  const identityCapture = createWorkerIdentityCapture();
  const observeIdentity = async (firstSample) => {
    if (settled) return;
    let candidate = !hasTransport ? firstSample === undefined ? sampleIdentity(child.pid) : firstSample : null;
    if (hasTransport && !sawExit) {
      const native = outcome.mode === 'systemd-unit' ? readNative() : { mainPid: child.pid };
      const recorded = await transportRecord('worker-identity.json');
      if (settled || sawExit) return;
      nativeSupervisor ??= sampleNativeSupervisor(native?.mainPid);
      const contained = candidatePid => verifyWorkerContainment(candidatePid, { mode: outcome.mode, unit: outcome.unit, nativeSupervisor });
      const current = recorded?.worker ? sampleIdentity(recorded.worker.pid) : null;
      if (recorded && sameWorkerIdentity(recorded.supervisor, nativeSupervisor)
        && sameWorkerIdentity(recorded.worker, current)
        && contained(current?.pid)) {
        candidate = current;
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
    const observed = identityCapture.observe(candidate);
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
    if (!identity) later(observeIdentity, 50);
  };
  observeIdentity(immediate);
  const sampleLog = async () => {
    const locator = options.healthSessionLog;
    if (!locator || !ctx.profile.health?.sessionLogLocator || !locator.sessionId) return;
    const filename = locator.path;
    let handle;
    try {
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
    await reportHealth();
    if (settled) return;
    if (observer.shouldStop?.() || ['hung', 'failed-to-start'].includes(health.state) || ['HARD_DEADLINE', 'STEP_LIMIT'].includes(health.reasonCode)) stop(health.reasonCode);
    else later(sampleHealth, Math.min(observer.nextDelayMs(), hardRemaining()));
  };
  sampleHealth().catch(() => { observer.gap(); later(sampleHealth, (invocation.health?.checkSeconds ?? 15) * 1000); });
  const launchEvent = { invocationId, pid: identity?.pid ?? null, supervisorPid: process.pid, isolation: outcome.mode };
  owner.emit('started', launchEvent); // Preserve the public OS-launch event API.
  owner.emit('launched', launchEvent);
  return done;
}
// ===========================================================================
// END FROZEN TO a4085b86a
// ===========================================================================

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

/**
 * Stop-before-retry gate (#2915, 03 §11.5 steps 1–3). A retry or fresh-tree
 * replacement for a worker is only issued after the previous attempt's
 * termination is CONFIRMED using the launcher's own termination evidence
 * (`exit.json` `termination`, produced in finish() above). An uncertain
 * termination blocks the retry and is surfaced with a code the conductor
 * can act on — it must never silently spawn a duplicate writer.
 */
export const STOP_BEFORE_RETRY_CODE = 'UNCERTAIN_TERMINATION';
export const UNBOUND_RETRY_EVIDENCE_CODE = 'UNBOUND_RETRY_EVIDENCE';

/**
 * Mandatory stop-before-retry gate (#2915, 03 §11.5 steps 1–3). A retry or
 * fresh-tree replacement is only issued after the previous attempt's
 * termination is CONFIRMED using the launcher's own termination evidence
 * (`exit.json` `termination`, produced in finish() above). The evidence must
 * also be BOUND to the previous owned invocation: any object containing
 * `termination: 'confirmed'` is not enough — its `invocationId` must match
 * the launcher's stored previous attempt, or (for a fresh launcher with no
 * stored attempt, e.g. a cross-restart retry) the caller must supply the
 * evidence explicitly and it is adopted as the chain. An uncertain
 * termination, or confirmed evidence for some other invocation, blocks the
 * retry and is surfaced with a code the conductor can act on — it must never
 * silently spawn a duplicate writer.
 */
export function stopBeforeRetryGate(previousResult, { expectedInvocationId = null } = {}) {
  if (previousResult?.termination !== 'confirmed') {
    return {
      ok: false,
      code: STOP_BEFORE_RETRY_CODE,
      reason: `Previous attempt termination is '${previousResult?.termination ?? 'unknown'}', not confirmed: `
        + 'retry is blocked until owned stop is proven (no duplicate writer while the old tree may continue).',
      previousResult: previousResult === undefined ? undefined : (previousResult ?? null),
    };
  }
  const evidenceId = previousResult?.invocationId ?? null;
  if (expectedInvocationId !== null && evidenceId !== expectedInvocationId) {
    return {
      ok: false,
      code: UNBOUND_RETRY_EVIDENCE_CODE,
      reason: `Confirmed termination evidence is for invocation '${evidenceId ?? 'unknown'}', not the previous owned attempt `
        + `'${expectedInvocationId}': retry is blocked until the previous attempt's own stop is proven.`,
      previousResult: previousResult ?? null,
    };
  }
  return { ok: true };
}

export function assertStopBeforeRetry(previousResult, options) {
  const gate = stopBeforeRetryGate(previousResult, options);
  if (!gate.ok) {
    const error = new Error(gate.reason);
    error.code = gate.code;
    error.previousResult = gate.previousResult;
    throw error;
  }
  return gate;
}

/**
 * #2915 review 4 (finding 4): the STABLE task-chain identity shared by
 * `launchOneWorker`'s `invocation.json.taskDigest` and
 * `verifyRetryPredecessor`'s task-chain binding check. Deliberately
 * excludes every attempt-specific PATH (`final_output`, `brief`, `workdir`)
 * — those legitimately differ on every fresh retry attempt by design — and
 * instead binds on role/task/group plus the brief's CONTENT digest (never
 * its path), so a worker-authored brief swap is still caught while a
 * conductor-assigned fresh output directory for the identical instructions
 * is not mistaken for "a different task".
 */
export async function stableTaskChainDigest(request, briefDigest) {
  const { qualificationDigest } = await importImpl(import.meta.url, 'models/qualification-digest.mjs');
  return qualificationDigest({ role: request?.role ?? null, task: request?.task ?? null,
    group: request?.group ?? null, briefDigest: briefDigest ?? null });
}

// ===========================================================================
// Per-task allowance ledger: exclusive-create slots, no lock, no reclaim
// (#2915 round 8, design D1/C1/C2/C3/C6/C7 -- replaces the former single-
// JSON-record-plus-lock design from review 4/6)
// ===========================================================================
//
// Round 8's own review (rev7-codex-2915.md, "P1 -- Concurrent stale-lock
// reclaim breaks mutual exclusion and can refund dispatched work") found
// that two processes could both reclaim one stale lock and refund an
// attempt whose charge had already been committed. This construction has
// no lock and no reclaim of any kind to go wrong: every mutation is a
// single exclusive-create syscall against a FIXED numbered pathname, which
// the filesystem already serializes for free, and the only object that may
// ever mutate a slot again afterward is the in-process handle its own
// reserve call returned.
//
// Design, in the terms of .aiwg/working/s1-scratch/design-round8-2915.md
// section D1 (eleven numbered points):
//  1. One directory per task chain, `<captureRoot>/ledger/<hex digest>/` --
//     the digest is hex-encoded (never containing `:`) so the directory
//     name is a portable path component on every platform. 0700,
//     conductor-owned, validated the same anchored/no-follow way as every
//     other launcher-private metadata directory.
//  2. `policy` pins `{maxAttempts, maxCorrections}` for the chain's whole
//     lifetime, published ATOMICALLY (temp file + fsync + `link()` into the
//     chain directory, never a bare exclusive-create-then-write) so a crash
//     mid-publish can never leave a half-written `policy` that poisons the
//     whole chain -- it leaves, at worst, an inert leftover temp file next
//     to the chain directory. The first reserver to win the `link()`
//     publishes; every later reserver reads and compares, refusing on
//     mismatch (`ALLOWANCE_POLICY_MISMATCH_CODE`).
//  3. Reserve = exclusive-create the lowest-numbered `attempt-<n>` that is
//     not already taken, for n in 1..maxAttempts. Authorization comes
//     ONLY from that create succeeding, never from a directory listing.
//  4. Existence is occupancy: an empty or partially-written slot is still
//     occupied, with its identity simply unavailable -- never free, never
//     a reason to refuse the whole chain.
//  5. The returned handle tracks one of two linear, process-local state
//     machines -- `reserved -> debiting -> charged` or
//     `reserved -> refunding -> refunded` -- with the transition set
//     SYNCHRONOUSLY, before any `await`, so a refund racing a debit on the
//     SAME handle can never un-charge a committed attempt (the defect this
//     whole redesign exists to remove). Once debit has STARTED (even if it
//     later fails), refund is permanently a no-op on that handle; once
//     refund has started, debit refuses.
//  6. Debit = exclusive-create `attempt-<n>.charged`, fsync it and the
//     directory (C2's durability claim). A pre-existing `.charged` for a
//     slot this handle just reserved is an integrity failure: refuse, and
//     touch nothing else.
//  7. Refund = unlink `attempt-<n>`, reachable only from `reserved`.
//  8. Corrections are `correction-<n>` slots, n in
//     1..MAX_STARTUP_CORRECTIONS (the ONE correction ceiling that actually
//     exists in this codebase today -- never `maxAttempts`), reserved
//     through the exact same slot/handle primitive and bound to one
//     attempt handle: charged when it charges, refunded when it refunds.
//  9. Operator recovery (C1): a reservation whose owning process died
//     before dispatch stays consumed forever -- there is no age/pid/
//     liveness inference of any kind. `releaseLedgerSlot` (one attempt) and
//     `releaseLedgerPolicy` (the whole chain's `policy`, only once nothing
//     else remains in it) are the explicit, operator-invoked escape
//     hatches, for a chain with no running conductor.
//  10. Directory contents are validated on every touch: only regular,
//     single-link, 0600, conductor-owned files with one of the four
//     canonical name shapes are tolerated; anything else refuses the whole
//     admission.
//  11. With no `captureRoot` (MCP has none today), the exact same slot/
//     handle semantics run against an in-process Map -- real within this
//     one process, granting no cross-process guarantee.
//
// C6: an explicitly supplied persistent root that fails validation --
// including the private-directory/no-follow guarantees this construction
// depends on being unavailable on win32 -- REFUSES rather than silently
// falling back to the in-process ledger. Only the already-accepted no-root
// mode is in-process.
//
// C7: the former `<digest>.json` flat-record layout never shipped past
// this branch. If one is found for a chain, this construction refuses that
// chain outright rather than reading, migrating or ignoring it.

export const ALLOWANCE_EXHAUSTED_CODE = 'ALLOWANCE_EXHAUSTED';
export const ALLOWANCE_POLICY_MISMATCH_CODE = 'ALLOWANCE_POLICY_MISMATCH';
export const LEDGER_RECORD_INVALID_CODE = 'LEDGER_RECORD_INVALID';

// Defensive bound on how many entries a chain directory may ever legitimately
// hold (`policy` + up to `maxAttempts` attempt/charge pairs + up to
// `MAX_STARTUP_CORRECTIONS` correction/charge pairs) -- a directory with far
// more than that is refused outright by `validateLedgerChainDirectory`
// rather than scanned.
const LEDGER_DIR_MAX_ENTRIES = 4096;

function ledgerFail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

// Hex-encodes the WHOLE digest string byte-for-byte, so the resulting
// directory component contains only `[0-9a-f]` -- no `:`, no `/`, nothing
// platform-significant -- regardless of the digest's own format (today
// always `sha256:<hex>`, from `stableTaskChainDigest`/`qualificationDigest`,
// but this makes no assumption of that). Bijective for any input string.
function encodeTaskChainDigest(taskChainDigest) {
  if (typeof taskChainDigest !== 'string' || taskChainDigest.length === 0 || taskChainDigest.length > 512) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, 'taskChainDigest must be a non-empty bounded string');
  }
  return Buffer.from(taskChainDigest, 'utf8').toString('hex');
}

function ledgerChainDir(captureRoot, taskChainDigest) {
  return join(captureRoot, 'ledger', encodeTaskChainDigest(taskChainDigest));
}

/** The SAME private-ownership bar `launchOneWorker` already applies to a
 * fresh worker run directory, reused for every level of the ledger's own
 * path (`captureRoot`, its `ledger` child, and the per-chain directory): an
 * EXISTING directory with the wrong owner or any group/other bit REFUSES --
 * never chmod-repaired. A missing directory is left for the caller to
 * create via `mkdir(..., { mode: 0o700, recursive: true })`, which applies
 * that mode to every newly-created path segment, not only the leaf. */
async function assertPrivateLedgerDirectory(target) {
  let stat;
  try { stat = await lstat(target); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    ledgerFail(LEDGER_RECORD_INVALID_CODE, `Allowance ledger directory is not inspectable (${error.message})`);
  }
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, 'Allowance ledger directory is not privately owned');
  }
}

/** D1.1 (#2915 round 8 review 8, C11): the per-chain directory itself --
 * never `captureRoot`/`ledgerRoot`, which are the caller's own pre-existing
 * directories and may legitimately carry any private (owner-only) mode --
 * must be EXACTLY `0700`, not merely "no group/other bits" (which
 * `assertPrivateLedgerDirectory` alone would still accept for, say, `0500`
 * if an unusual umask stripped the write bit off the `mkdir(..., { mode:
 * 0o700 })` call that created it). A chain directory at any other private
 * mode refuses rather than being silently tolerated or repaired. */
async function assertExactLedgerChainMode(target) {
  let stat;
  try { stat = await lstat(target); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    ledgerFail(LEDGER_RECORD_INVALID_CODE, `Allowance ledger chain directory is not inspectable (${error.message})`);
  }
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, 'Allowance ledger chain directory must be exactly mode 0700');
  }
}

/** fsync ONE directory's own entry table (#2915 round 8 review 8, C8):
 * shared by `chargeLedgerSlotFile` (the chain directory's own entries, an
 * existing durability guarantee) and `ensureLedgerChain` (the newly
 * created chain/`ledger/` ancestry itself, below) -- fsyncing a FILE never
 * durably publishes the directory ENTRY that names it; the containing
 * directory's own fd must be fsynced too for the name itself to survive a
 * host crash. Propagates any failure: a directory that cannot be durably
 * published must refuse dispatch, never proceed as if it had been. */
async function syncLedgerDirectory(target) {
  await withWorkerPath(target, async anchored => {
    const dirHandle = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  });
}

/** C7: the pre-round-8 flat layout stored one record at
 * `<captureRoot>/ledger/<digest>.json`. Creating the new per-chain
 * DIRECTORY alongside an old record of the same name would silently grant
 * a fresh allowance on top of whatever that record had already consumed --
 * so its mere presence refuses the whole chain, unconditionally, before
 * anything else is touched. */
async function assertNoLegacyLedgerRecord(captureRoot, taskChainDigest) {
  const legacyPath = join(captureRoot, 'ledger', `${taskChainDigest}.json`);
  try { await withWorkerPath(legacyPath, target => lstat(target)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  ledgerFail(LEDGER_RECORD_INVALID_CODE,
    'A legacy allowance-ledger record exists for this task chain (pre-round-8 layout); refusing rather than reading, migrating or ignoring it');
}

/** #2915 review 6 (finding 8)'s duplicate-key defense, reused for the
 * `policy` file: RFC 8259 leaves repeated object member names to the
 * implementation, and `JSON.parse` silently keeps the LAST one, which would
 * let a forged policy smuggle a second, hidden `maxAttempts` past an
 * earlier one. `yaml`'s own strict-mapping-key parser (JSON is a flow-
 * mapping subset of YAML 1.2) is used purely as a duplicate-key VALIDATOR;
 * the ordinary `JSON.parse` result is still what is returned. */
function strictLedgerJson(text) {
  let value;
  try { value = JSON.parse(text); } catch { return undefined; }
  let document;
  try { document = parseDocument(text, { uniqueKeys: true }); } catch { return undefined; }
  if (document.errors.length) return undefined;
  return value;
}

/** Creates `name` under `dir` exclusively (O_EXCL) with `content`, fsyncing
 * the file before returning. Returns `true` on success, `false` on EEXIST
 * (someone else already created it) -- never throws for that one case, so
 * callers can treat "lost the create race" as an ordinary branch rather
 * than an exception. */
async function createLedgerFileExclusive(dir, name, content) {
  let handle;
  try {
    handle = await withWorkerPath(join(dir, name), target =>
      open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
  return true;
}

// Bounded wait between re-stats of `policy` when it is caught at nlink 2 --
// see `statLedgerChainEntry`'s doc comment for why that is not, by itself,
// evidence of tampering. Short enough that `LEDGER_POLICY_LINK_RECHECK_ATTEMPTS`
// rechecks total well under a second; long enough that the SAME process's
// own `finally` (which unlinks the publish temp file within microseconds of
// the `link()` that created the second name) has normally already run by
// the time the FIRST recheck elapses -- the remaining attempts are headroom
// for a paused (not merely racing) publisher, not evidence of tampering on
// their own either.
const LEDGER_POLICY_LINK_RECHECK_MS = 25;
// #2915 round 8 review 8 (C11): a single 25ms recheck classified a healthy
// publisher that merely paused (scheduler contention, a slow disk) between
// `link()` and its own `finally` as corruption. A few short, bounded
// rechecks (4 * 25ms = 100ms, "well under a second") give a paused-but-
// healthy publisher real headroom while staying bounded; a GENUINE extra
// hard link never resolves no matter how many rechecks run, and is still
// refused once the budget is exhausted.
const LEDGER_POLICY_LINK_RECHECK_ATTEMPTS = 4;

/** Stats one ledger-chain entry through the anchored, no-follow path, with
 * ONE deliberate exception for `policy`: the atomic-publish dance in
 * `ensureLedgerPolicy` below momentarily creates a SECOND hard link to
 * `policy`'s own temp file (between its `link()` succeeding and that same
 * call's `finally` unlinking the temp name), so a concurrent reader can
 * observe `policy` at nlink 2 for a brief, bounded instant that is not
 * evidence of a real hard link -- only of racing (or, with the bounded
 * retries below, a brief pause in) that cleanup. Content and ownership are
 * NOT relaxed for this case, only the nlink check, and only for `policy`: a
 * few short, bounded rechecks distinguish the transient/paused case (nlink
 * back to 1) from a genuine extra hard link (still 2 once the budget is
 * exhausted), which is refused exactly like any other canonical-file
 * violation -- but see `readLedgerPolicyFile`/`validateLedgerChainDirectory`
 * for why that refusal names "publication appears incomplete" rather than
 * asserting corruption outright: this function alone cannot tell a stalled
 * publisher (that will eventually finish) from a real hard link, only that
 * nlink stayed at 2 for the whole bounded window. Every other entry
 * (attempt/correction slots and their `.charged` markers) keeps the
 * unconditional nlink-1 rule -- nothing ever legitimately double-links
 * them. */
async function statLedgerChainEntry(dir, name) {
  const target = join(dir, name);
  let stat = await withWorkerPath(target, t => lstat(t));
  if (name === 'policy') {
    for (let attempt = 0; attempt < LEDGER_POLICY_LINK_RECHECK_ATTEMPTS && stat.nlink === 2; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, LEDGER_POLICY_LINK_RECHECK_MS));
      stat = await withWorkerPath(target, t => lstat(t));
    }
  }
  return stat;
}

/** Bounded, validated read of `policy`'s content, reusing
 * `statLedgerChainEntry`'s transient-nlink tolerance (never `boundedPrivateRead`,
 * which enforces nlink===1 unconditionally and has no notion of this
 * ledger-specific transient window). Refuses -- never resets -- on any
 * ownership, mode, size or JSON/duplicate-key problem, exactly like every
 * other ledger read. */
async function readLedgerPolicyFile(dir) {
  let stat;
  try { stat = await statLedgerChainEntry(dir, 'policy'); }
  catch (error) { ledgerFail(LEDGER_RECORD_INVALID_CODE, `Allowance ledger policy is missing or not inspectable (${error.message})`); }
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size === 0 || stat.size > 4096) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, 'Allowance ledger policy is missing, insecurely-moded or not owned');
  }
  // #2915 round 8 review 8 (C11): checked SEPARATELY, with its own
  // diagnostic -- `statLedgerChainEntry`'s bounded rechecks cannot
  // distinguish a publisher that is still mid-publish (will resolve to
  // nlink 1 shortly) from a genuine extra hard link once its retry budget
  // is exhausted, so the refusal says the publication APPEARS incomplete
  // rather than asserting corruption outright.
  if (stat.nlink !== 1) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE,
      'Allowance ledger policy publication appears incomplete (still hard-linked after the bounded recheck window); retry, or refuse this chain if the condition persists');
  }
  const target = join(dir, 'policy');
  const handle = await withWorkerPath(target, t => open(t, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  let bytes;
  try {
    const buffer = Buffer.alloc(stat.size);
    await handle.read(buffer, 0, buffer.length, 0);
    bytes = buffer;
  } finally { await handle.close(); }
  const value = strictLedgerJson(bytes.toString('utf8'));
  if (value === undefined) ledgerFail(LEDGER_RECORD_INVALID_CODE, 'Allowance ledger policy is not valid JSON or has a duplicate member name');
  return value;
}

/**
 * D1.2, published atomically: the first reserver writes the FULL policy
 * content to a throwaway, unpredictably-named temp file in the PARENT
 * `ledger/` directory (never inside the chain directory -- that would make
 * `validateLedgerChainDirectory` refuse a concurrent reserver on a name it
 * does not recognize), fsyncs it, then publishes it with one `link()` call.
 * `link()` is atomic: either it fails and `policy` is untouched, or it
 * succeeds and `policy` is immediately, fully populated -- there is no
 * window in which a reader can observe an empty or partially-written
 * policy, which is exactly the crash-poisons-the-whole-chain gap a plain
 * exclusive-create-then-write left open. `EEXIST` means another reserver
 * published first: this reads theirs back (`readLedgerPolicyFile`) and
 * compares, exactly as before. The temp file is always unlinked in a
 * `finally`, whether this call won, lost, or threw.
 *
 * `afterPolicyWrite` (test-only -- production never passes it) runs after
 * the temp file is written and fsynced but BEFORE the publishing `link()`,
 * so tests can inject a failure in exactly that window and prove the
 * crash leaves the chain usable by the next reserver (a leftover temp file
 * in `ledger/`, never a half-written `policy`).
 */
async function ensureLedgerPolicy(dir, ledgerRoot, taskChainDigest, maxAttempts, afterPolicyWrite) {
  const maxCorrections = MAX_STARTUP_CORRECTIONS;
  const content = JSON.stringify({ version: 1, taskChainDigest, maxAttempts, maxCorrections });
  const tempName = `.policy-tmp-${randomUUID()}`;
  const tempPath = join(ledgerRoot, tempName);
  let tempHandle;
  try {
    tempHandle = await withWorkerPath(tempPath, target =>
      open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
  } catch (error) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, `Allowance ledger policy temp file could not be created (${error.message})`);
  }
  try {
    try { await tempHandle.writeFile(content); await tempHandle.sync(); }
    finally { await tempHandle.close(); }
    if (afterPolicyWrite) await afterPolicyWrite();
    try {
      await withWorkerPath(dir, async dirAnchor => {
        const policyTarget = join(dirAnchor, 'policy');
        await withWorkerPath(tempPath, async tempAnchor => { await link(tempAnchor, policyTarget); });
      });
      return { maxAttempts, maxCorrections };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Someone else published first -- read and compare theirs below.
    }
  } finally {
    await withWorkerPath(tempPath, target => unlink(target)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  const policy = await readLedgerPolicyFile(dir);
  if (!policy || typeof policy !== 'object' || policy.version !== 1 || policy.taskChainDigest !== taskChainDigest
    || !Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1
    || !Number.isSafeInteger(policy.maxCorrections) || policy.maxCorrections < 1) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, 'Allowance ledger policy is malformed or has a duplicate member name');
  }
  if (policy.maxAttempts !== maxAttempts || policy.maxCorrections !== maxCorrections) {
    ledgerFail(ALLOWANCE_POLICY_MISMATCH_CODE,
      `Allowance ledger policy for this task chain is pinned to maxAttempts=${policy.maxAttempts}/maxCorrections=${policy.maxCorrections}, which does not match this request (maxAttempts=${maxAttempts}/maxCorrections=${maxCorrections})`);
  }
  return { maxAttempts: policy.maxAttempts, maxCorrections: policy.maxCorrections };
}

const ATTEMPT_NAME_RE = /^attempt-([1-9][0-9]*)$/;
const ATTEMPT_CHARGED_NAME_RE = /^attempt-([1-9][0-9]*)\.charged$/;
const CORRECTION_NAME_RE = /^correction-([1-9][0-9]*)$/;
const CORRECTION_CHARGED_NAME_RE = /^correction-([1-9][0-9]*)\.charged$/;

/** D1.10: only regular, single-link (see `statLedgerChainEntry` for
 * `policy`'s own narrow, deliberate exception), conductor-owned, exactly-
 * 0600 files with one of the four canonical name shapes are tolerated
 * anywhere in a chain directory; anything else -- a symlink, a hard link, a
 * loosely-moded file, an out-of-range index, or a name this ledger never
 * writes -- refuses the WHOLE admission rather than being silently
 * skipped. Runs on every reserve (attempt AND correction, D1.8), against
 * whatever `policy` already pinned -- a correction reserved moments after
 * its attempt handle re-runs this against the CURRENT directory contents,
 * never trusting that nothing changed since the attempt's own reserve. */
async function validateLedgerChainDirectory(dir, policy) {
  let entries;
  try { entries = await withWorkerPath(dir, target => readdir(target)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (entries.length > LEDGER_DIR_MAX_ENTRIES) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, 'Allowance ledger directory has more entries than expected');
  }
  for (const name of entries) {
    if (name !== 'policy') {
      const attempt = ATTEMPT_NAME_RE.exec(name) || ATTEMPT_CHARGED_NAME_RE.exec(name);
      const correction = !attempt && (CORRECTION_NAME_RE.exec(name) || CORRECTION_CHARGED_NAME_RE.exec(name));
      if (attempt) {
        if (Number(attempt[1]) > policy.maxAttempts) {
          ledgerFail(LEDGER_RECORD_INVALID_CODE, `Allowance ledger directory contains an out-of-range attempt entry: ${name}`);
        }
      } else if (correction) {
        if (Number(correction[1]) > policy.maxCorrections) {
          ledgerFail(LEDGER_RECORD_INVALID_CODE, `Allowance ledger directory contains an out-of-range correction entry: ${name}`);
        }
      } else {
        ledgerFail(LEDGER_RECORD_INVALID_CODE, `Allowance ledger directory contains an unrecognized entry: ${name}`);
      }
    }
    let stat;
    try { stat = await statLedgerChainEntry(dir, name); }
    catch (error) { ledgerFail(LEDGER_RECORD_INVALID_CODE, `Allowance ledger entry '${name}' is not inspectable (${error.message})`); }
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
      ledgerFail(LEDGER_RECORD_INVALID_CODE, `Allowance ledger entry '${name}' is not a canonical conductor-owned 0600 regular file`);
    }
    // #2915 round 8 review 8 (C11): see `readLedgerPolicyFile` -- `policy`'s
    // nlink is checked separately, with a diagnostic that names incomplete
    // publication rather than asserting corruption, because the bounded
    // rechecks in `statLedgerChainEntry` cannot fully distinguish the two.
    if (stat.nlink !== 1) {
      ledgerFail(LEDGER_RECORD_INVALID_CODE, name === 'policy'
        ? 'Allowance ledger policy publication appears incomplete (still hard-linked after the bounded recheck window); retry, or refuse this chain if the condition persists'
        : `Allowance ledger entry '${name}' is not a canonical conductor-owned 0600 regular file`);
    }
  }
}

/** D1.1/D1.2/D1.10: validates the full path down to the per-chain
 * directory, refuses a legacy flat record (C7) and a win32 target (C6),
 * creates/reads the chain's pinned policy, and validates every existing
 * entry against it -- the shared pre-flight every file-mode reserve (attempt
 * or correction) runs before touching a numbered slot.
 *
 * The parent `ledger/` directory's OWN entries are deliberately never
 * enumerated or validated here: it holds one chain subdirectory per digest
 * (named by `ledgerChainDir`), at most one legacy `<digest>.json` record
 * (checked by name, above), and -- only ever transiently -- a `policy`
 * publish temp file (`.policy-tmp-<random>`, from `ensureLedgerPolicy`).
 * None of those three name shapes can ever collide, so a crash-orphaned
 * temp file left behind in `ledger/` is simply inert: nothing reads it,
 * nothing lists it, and it is never mistaken for part of any chain. It is
 * deliberately left in place rather than opportunistically swept by age --
 * an age-based heuristic is exactly the kind of inference this design
 * otherwise refuses to make (C1), and a crash in this one-write window is
 * rare enough that unbounded accumulation is not a practical concern.
 *
 * #2915 round 8 review 8 (C8, durability): `mkdir(dir, { recursive: true
 * })` can create BOTH `ledger/` itself and the chain directory inside it
 * in one call. Creating a directory makes its own `.`/entries durable once
 * ITS contents are later fsynced (`chargeLedgerSlotFile` already does
 * this for the chain directory), but the directory's NAME is an entry in
 * its PARENT's own entry table -- fsyncing the new directory alone never
 * publishes that. Without also fsyncing each newly created directory's
 * PARENT, a host crash can lose the namespace entry naming it even though
 * a later charge inside it is otherwise durably committed, letting a
 * subsequent process recreate the "same" chain with no memory of what it
 * already consumed -- exactly what C2's durability claim exists to rule
 * out. Both ancestor syncs below run (and must succeed) BEFORE this
 * function returns, so no slot in either newly created directory can ever
 * be charged without its own containing namespace already durably
 * published; either sync failing propagates and refuses this reservation
 * entirely, never silently proceeding as if it had succeeded. */
async function ensureLedgerChain({ captureRoot, taskChainDigest, maxAttempts, afterPolicyWrite }) {
  if (process.platform === 'win32') {
    ledgerFail(LEDGER_RECORD_INVALID_CODE,
      'Persistent allowance ledger requires POSIX private-directory and no-follow guarantees unavailable on this platform (win32); omit captureRoot for the in-process ledger');
  }
  await assertNoLegacyLedgerRecord(captureRoot, taskChainDigest);
  const ledgerRoot = join(captureRoot, 'ledger');
  const dir = ledgerChainDir(captureRoot, taskChainDigest);
  await assertPrivateLedgerDirectory(captureRoot);
  await assertPrivateLedgerDirectory(ledgerRoot);
  await mkdir(dir, { mode: 0o700, recursive: true });
  await assertExactLedgerChainMode(dir);
  // Durably publish ancestry before any slot inside
  // either directory can be reserved, let alone charged. Order matters
  // only for clarity here (all must succeed before this function
  // returns, regardless of order) -- publish the OUTER name first.
  // Existence is not proof that a concurrent creator published the name.
  // Sync every parent through the filesystem root, including captureRoot's
  // ancestry, on every reservation before permitting a charge.
  const parents = [];
  for (let parent = ledgerRoot; ; parent = dirname(parent)) {
    parents.push(parent);
    if (dirname(parent) === parent) break;
  }
  for (const parent of parents.reverse()) await syncLedgerDirectory(parent);
  const policy = await ensureLedgerPolicy(dir, ledgerRoot, taskChainDigest, maxAttempts, afterPolicyWrite);
  await validateLedgerChainDirectory(dir, policy);
  return { dir, policy };
}

/** D1.3/D1.4: tries exclusive-create against the FIXED numbered namespace
 * `<prefix>-1 .. <prefix>-<ceiling>`, lowest first; the first `open()` that
 * actually succeeds wins and its invocation id is written into it.
 * Authorization is the create succeeding -- never a `readdir()` count, and
 * an EEXIST is simply "already occupied", with no inference about WHY
 * (review 7: "existence is occupancy" holds for a crashed empty slot
 * exactly as it does for a healthy one). A full pass finding nothing gets
 * ONE bounded rescan (`beforeRescan`, test-only -- production never passes
 * it) before reporting exhaustion, because a slot can legitimately be freed
 * by a concurrent refund between this scan's first and last check (review 7/
 * crit-round8 D1: "Lowest-free scanning is safe for the ceiling, not a
 * snapshot of availability"). Returns the won slot number, or `null` once
 * both passes find nothing free. */
async function reserveLedgerSlotFile(dir, prefix, ceiling, invocationId, { beforeRescan } = {}) {
  for (let pass = 0; pass < 2; pass += 1) {
    for (let n = 1; n <= ceiling; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await createLedgerFileExclusive(dir, `${prefix}-${n}`, invocationId)) return n;
    }
    if (pass === 0 && beforeRescan) await beforeRescan();
  }
  return null;
}

/** D1.6/C2: exclusive-creates `<prefix>-<n>.charged`, fsyncs the file and
 * then the chain directory itself, so a committed charge survives a host
 * crash (C2's durability claim), not merely a process crash. A pre-existing
 * `.charged` for a slot THIS call just reserved can only mean the handle
 * invariants above were violated (review 7/crit-round8 D1: "A pre-existing
 * `.charged` is not a fresh handle's successful debit") -- an integrity
 * failure, refused without touching anything else. */
async function chargeLedgerSlotFile(dir, prefix, n, invocationId) {
  const name = `${prefix}-${n}.charged`;
  let handle;
  try {
    handle = await withWorkerPath(join(dir, name), target =>
      open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
  } catch (error) {
    if (error.code === 'EEXIST') {
      ledgerFail(LEDGER_RECORD_INVALID_CODE, `Allowance ledger integrity failure: '${name}' already exists for a slot this handle just reserved`);
    }
    throw error;
  }
  try { await handle.writeFile(invocationId); await handle.sync(); }
  finally { await handle.close(); }
  await syncLedgerDirectory(dir);
}

/** D1.7: unlinks `<prefix>-<n>` -- reachable only while the caller's handle
 * is still `reserved` (enforced by `refundDirectWorkerAllowance` below,
 * never here). A missing slot is already-refunded-or-never-existed and is
 * a quiet no-op, never an error. */
async function refundLedgerSlotFile(dir, prefix, n) {
  try { await withWorkerPath(join(dir, `${prefix}-${n}`), target => unlink(target)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Bounded, tolerant diagnostic read of one slot's recorded identity --
 * D1.4's "existence is occupancy" applies here too: this NEVER throws and
 * NEVER treats an unreadable/empty/foreign-moded slot as free. Returns
 * `undefined` when the slot does not exist at all (free), `null` when it
 * exists but nothing trustworthy can be read from it ("occupied, identity
 * unavailable"), or the recorded invocation id otherwise. */
async function readLedgerSlotIdentity(dir, name) {
  const target = join(dir, name);
  let stat;
  try { stat = await withWorkerPath(target, t => lstat(t)); }
  catch (error) { return error.code === 'ENOENT' ? undefined : null; }
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size === 0 || stat.size > 256) {
    return null;
  }
  try {
    return await withWorkerPath(target, async t => {
      const handle = await open(t, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const buffer = Buffer.alloc(stat.size);
        await handle.read(buffer, 0, buffer.length, 0);
        return buffer.toString('utf8');
      } finally { await handle.close(); }
    });
  } catch { return null; }
}

/** Names every occupied slot and its (possibly unavailable) invocation id,
 * for an `ALLOWANCE_EXHAUSTED_CODE` refusal's diagnostic -- a bounded read,
 * never a reason to refuse or regrant anything on its own. */
async function describeOccupiedLedgerSlots(dir, prefix, ceiling) {
  const parts = [];
  for (let n = 1; n <= ceiling; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    const id = await readLedgerSlotIdentity(dir, `${prefix}-${n}`);
    if (id !== undefined) parts.push(`${prefix}-${n}=${id ?? '<unavailable>'}`);
  }
  return parts.length ? parts.join(', ') : 'none';
}

// D1.11: the in-process fallback, used today by the MCP bridge (no server-
// owned capture root) and whenever a caller-supplied `captureRoot` is
// outside the above (C6/worker-writable refusal below) -- a Map per task
// chain of the SAME slot/handle semantics, real within this one process
// only. `attempts`/`corrections` map slot number -> `{ invocationId,
// charged }`; a charged entry is kept for the remaining lifetime of this
// process (discarding it would let a fresh reserve for the same digest
// regrant spent allowance), so a chain is "empty" -- and retired -- only
// once BOTH maps are genuinely empty.
const _inProcessLedgerChains = new Map(); // taskChainDigest -> { maxAttempts, maxCorrections, attempts, corrections }
const IN_PROCESS_LEDGER_MAX_RECORDS = 5000;

export function resetInProcessAllowanceLedger() { _inProcessLedgerChains.clear(); }

function inProcessChain(taskChainDigest, maxAttempts) {
  let chain = _inProcessLedgerChains.get(taskChainDigest);
  if (!chain) {
    if (_inProcessLedgerChains.size >= IN_PROCESS_LEDGER_MAX_RECORDS) {
      ledgerFail(ALLOWANCE_EXHAUSTED_CODE, 'In-process allowance ledger is at its global task-chain bound');
    }
    chain = { maxAttempts, maxCorrections: MAX_STARTUP_CORRECTIONS, attempts: new Map(), corrections: new Map() };
    _inProcessLedgerChains.set(taskChainDigest, chain);
    return chain;
  }
  if (chain.maxAttempts !== maxAttempts) {
    ledgerFail(ALLOWANCE_POLICY_MISMATCH_CODE,
      `In-process allowance ledger for this task chain is pinned to maxAttempts=${chain.maxAttempts}, which does not match this request (maxAttempts=${maxAttempts})`);
  }
  return chain;
}

/** The in-process mirror of `reserveLedgerSlotFile`: fully synchronous
 * (no `await` anywhere in this function), so two "concurrent" async
 * reserve calls in the SAME process can never race past the `map.has`/
 * `map.set` pair -- whichever call's synchronous turn runs first simply
 * wins, exactly like the filesystem's own O_EXCL does for the file-mode
 * primitive. */
function reserveLedgerSlotInProcess(map, ceiling, invocationId) {
  for (let n = 1; n <= ceiling; n += 1) {
    if (!map.has(n)) { map.set(n, { invocationId, charged: false }); return n; }
  }
  return null;
}

// #2915 round 8 review 8 (C11, "an empty in-process chain accepted a
// different ceiling after refund"): this used to DELETE the chain record
// once both maps were empty (every reserved slot refunded, none charged),
// which also discarded its pinned `maxAttempts` -- a LATER reserve for the
// SAME `taskChainDigest` then silently created a fresh chain at a
// DIFFERENT ceiling, contradicting D1.2's "the policy pin lives for the
// chain's entire lifetime" rule exactly like the file-mode ledger's own
// `policy` file does (which persists until the explicit, otherwise-empty-
// chain-only `releaseLedgerPolicy` operator action, never automatically).
// The in-process ledger has no equivalent explicit-release operation (it
// is per-process and already bounded by `IN_PROCESS_LEDGER_MAX_RECORDS`
// distinct digests, not per-slot memory), so this is now a deliberate
// no-op: the pinned policy for a chain lives for the remaining lifetime of
// this process once first reserved, even once every one of its slots is
// refunded. Retained (rather than deleted outright) so a future explicit
// in-process release path has a single, obviously-named call site to wire
// into, should one ever be added.
function retireInProcessChainIfEmpty(_taskChainDigest) {
  // Intentionally does nothing -- see doc comment above.
}

// #2915 round 8 review 8 (C5, "ledger handles do not enforce creator-only
// mutation authority"): the REAL mutable state (`state`, `debited`,
// `correction`, `correctionChargeDiagnostic`, `correctionRefundDiagnostic`)
// for every ledger handle lives here, keyed by the EXACT handle object
// `reserveDirectWorkerAllowance`/`reserveLedgerCorrection` minted -- never
// as a caller-writable own-property on the handle itself. A `{...handle}`
// shallow copy is a DIFFERENT object with no entry here: debit/refund/
// correction-reserve on it refuse outright ("unknown handle"), regardless
// of whatever snapshot values the copy's own properties happen to carry.
const _ledgerHandleState = new WeakMap();

/** Build one opaque, creator-bound ledger handle. The identity fields
 * (`mode`/`captureRoot`/`taskChainDigest`/`invocationId`/`kind`/`n`/`dir`/
 * `maxAttempts`) are plain, non-writable, non-configurable OWN properties
 * -- they never change after creation, so exposing them directly is safe.
 * `state`/`debited`/`correction`/`correctionChargeDiagnostic`/
 * `correctionRefundDiagnostic` are READ-ONLY getters delegating to the
 * private state record below; there is no setter, so `ledger.state = ...`
 * from outside this module throws (strict ESM) rather than silently
 * mutating a copy of the truth. The handle itself is frozen on top of
 * that for full encapsulation (no new properties, no redefinition). */
function _createLedgerHandle(identity) {
  const state = { state: 'reserved', debited: false, correction: null,
    correctionChargeDiagnostic: null, correctionRefundDiagnostic: null };
  const handle = Object.defineProperties({}, {
    mode: { value: identity.mode, enumerable: true },
    captureRoot: { value: identity.captureRoot, enumerable: true },
    taskChainDigest: { value: identity.taskChainDigest, enumerable: true },
    invocationId: { value: identity.invocationId, enumerable: true },
    kind: { value: identity.kind, enumerable: true },
    n: { value: identity.n, enumerable: true },
    dir: { value: identity.dir, enumerable: true },
    maxAttempts: { value: identity.maxAttempts, enumerable: true },
    state: { get() { return state.state; }, enumerable: true },
    debited: { get() { return state.debited; }, enumerable: true },
    correction: { get() { return state.correction; }, enumerable: true },
    correctionChargeDiagnostic: { get() { return state.correctionChargeDiagnostic; }, enumerable: true },
    correctionRefundDiagnostic: { get() { return state.correctionRefundDiagnostic; }, enumerable: true },
  });
  Object.freeze(handle);
  _ledgerHandleState.set(handle, state);
  return handle;
}

/** Look up the private mutable state for a handle `reserveDirectWorkerAllowance`/
 * `reserveLedgerCorrection` actually minted. `null`/`undefined` (the
 * documented "no ledger in effect" case every caller already checks for
 * before calling debit/refund) pass through untouched by every caller of
 * THIS function -- they check that first. Anything else that is not a
 * recognized handle (a copy, a fabrication, a value from a different
 * process boundary) refuses outright rather than silently treating it as
 * a fresh or already-settled handle. */
function _requireLedgerHandleState(handle) {
  const state = _ledgerHandleState.get(handle);
  if (!state) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE,
      'Allowance ledger handle is not a value this module minted (a copy, fabrication or unknown handle is refused, never silently accepted)');
  }
  return state;
}

/**
 * D1.1-D1.4: reserves one allowance slot for `invocationId` against
 * `taskChainDigest`. With `captureRoot`, this is the real, cross-process
 * ledger under `<captureRoot>/ledger/<hex digest>/`; without one, it is the
 * in-process fallback (D1.11). `maxAttempts` pins this chain's policy
 * (D1.2) for its entire lifetime -- a later call with a different value for
 * the SAME digest refuses (`ALLOWANCE_POLICY_MISMATCH_CODE`), never widens
 * or narrows the budget already in effect.
 *
 * Returns an OPAQUE handle -- readable fields `mode`, `captureRoot`,
 * `taskChainDigest`, `invocationId`, `kind: 'attempt'`, `n`, `dir`,
 * `maxAttempts`, `state`, `debited`, `correction` -- that is the ONLY
 * thing authorized to debit or refund this slot (D1.5): `debited` starts
 * `false`; `state` starts `'reserved'`. Pass this handle, and only this
 * EXACT handle (#2915 round 8 review 8, C5: never a copy of it), to
 * `debitDirectWorkerAllowance`/`refundDirectWorkerAllowance`/
 * `reserveLedgerCorrection` -- its mutable fields are read-only from
 * outside this module; only this module's own functions, looking up the
 * handle's identity in a private map, can ever change them.
 */
export async function reserveDirectWorkerAllowance({ captureRoot, taskChainDigest, invocationId, maxAttempts,
  // Test-only passthrough to the bounded rescan between the two scan passes
  // (crit-round8 D1: "Lowest-free scanning is safe for the ceiling, not a
  // snapshot of availability") -- production never passes this; tests use
  // it to deterministically interleave a concurrent refund between a
  // scanner's two passes instead of depending on real fs scheduling.
  rescan,
  // Test-only passthrough into `ensureLedgerPolicy`'s atomic-publish dance
  // (see its own doc comment) -- fires after the policy temp file is
  // written and fsynced but before it is published, so a test can inject a
  // failure in exactly that window. Production never passes this.
  afterPolicyWrite } = {}) {
  // #2915 round 8 review 8 (C11): `Number.isSafeInteger`, not merely
  // `Number.isInteger` -- `9007199254740992` (2^53, the first integer
  // `Number.isInteger` accepts but double-precision float arithmetic can no
  // longer represent exactly) must never be accepted as a ceiling here, at
  // the FIRST reservation that pins this chain's policy for its lifetime.
  if (typeof taskChainDigest !== 'string' || !taskChainDigest || typeof invocationId !== 'string' || !invocationId
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, 'reserveDirectWorkerAllowance requires taskChainDigest, invocationId and a positive safe-integer maxAttempts');
  }
  if (!captureRoot) {
    const chain = inProcessChain(taskChainDigest, maxAttempts);
    const n = reserveLedgerSlotInProcess(chain.attempts, chain.maxAttempts, invocationId);
    if (n == null) ledgerFail(ALLOWANCE_EXHAUSTED_CODE, `Task-chain allowance exhausted (${chain.maxAttempts} attempt(s), in-process ledger)`);
    return _createLedgerHandle({ mode: 'in-process', captureRoot: null, taskChainDigest, invocationId, kind: 'attempt', n,
      dir: null, maxAttempts: chain.maxAttempts });
  }
  const { dir, policy } = await ensureLedgerChain({ captureRoot, taskChainDigest, maxAttempts, afterPolicyWrite });
  const n = await reserveLedgerSlotFile(dir, 'attempt', policy.maxAttempts, invocationId, { beforeRescan: rescan });
  if (n == null) {
    const occupied = await describeOccupiedLedgerSlots(dir, 'attempt', policy.maxAttempts);
    ledgerFail(ALLOWANCE_EXHAUSTED_CODE, `Task-chain allowance exhausted (${policy.maxAttempts} attempt(s)); occupied: ${occupied}`);
  }
  return _createLedgerHandle({ mode: 'file', captureRoot, taskChainDigest, invocationId, kind: 'attempt', n,
    dir, maxAttempts: policy.maxAttempts });
}

/**
 * D1.5/D1.6: moves `ledger` from `reserved` to `charged`. The state flip to
 * `'debiting'` is the FIRST statement in this function, synchronously,
 * before any `await` -- so a `refundDirectWorkerAllowance(ledger)` call
 * racing this one (on the SAME handle) is guaranteed to observe a
 * non-`'reserved'` state and no-op, never unlinking a slot this call is
 * concurrently charging (review 7, "Refund races debit"). A debit that
 * itself fails (lock contention does not exist anymore, but the charge
 * create/fsync still can) moves the handle to a terminal `'debit-failed'`
 * state: per C1/C3, everything up to a COMMITTED charge refunds, but a
 * charge ATTEMPT that fails commits nothing and is not retried or refunded
 * -- it is bounded, conservative crash-equivalent loss, recoverable only
 * through the explicit operator path (D1.9, `releaseLedgerSlot`). A second
 * debit call on an ALREADY-`charged` handle is an idempotent no-op, exactly
 * like the previous design.
 *
 * When this handle has a bound correction (`reserveLedgerCorrection`
 * reserved one against it), that correction is charged too, immediately
 * after -- best-effort: a correction-charge failure is recorded on the
 * handle's private state (surfaced through `correctionChargeDiagnostic`,
 * and from there into `settleDirectWorker`'s own returned diagnostic) and
 * never fails or unwinds the attempt's own already-committed charge, which
 * is what actually governs dispatch.
 *
 * #2915 round 8 review 8 (C5): `ledger` must be a handle THIS module
 * minted -- looked up by its own identity in a private map, never trusted
 * for its own field values. A copy, fabrication or unknown handle refuses
 * outright (never silently treated as fresh or already-settled).
 */
export async function debitDirectWorkerAllowance(ledger) {
  if (!ledger) return;
  const state = _requireLedgerHandleState(ledger);
  if (state.state === 'charged') return;
  if (state.state !== 'reserved') {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, `Allowance ledger handle cannot be debited from state '${state.state}'`);
  }
  state.state = 'debiting';
  try {
    if (ledger.mode === 'file') await chargeLedgerSlotFile(ledger.dir, ledger.kind, ledger.n, ledger.invocationId);
    else {
      const chain = _inProcessLedgerChains.get(ledger.taskChainDigest);
      const map = chain && (ledger.kind === 'attempt' ? chain.attempts : chain.corrections);
      const slot = map && map.get(ledger.n);
      // #2915 round 8 review 8 (C5): "in in-process mode a missing slot is
      // an error, never a silent success" -- a handle whose backing
      // in-process slot has vanished (the chain was torn down, or this is
      // somehow a foreign slot number) must fail the debit loudly.
      if (!slot) ledgerFail(LEDGER_RECORD_INVALID_CODE, 'In-process allowance ledger slot for this handle is missing; cannot debit');
      slot.charged = true;
    }
  } catch (error) {
    state.state = 'debit-failed';
    throw error;
  }
  state.state = 'charged';
  state.debited = true;
  const correctionState = state.correction && _ledgerHandleState.get(state.correction);
  if (correctionState && correctionState.state === 'reserved') {
    try { await debitDirectWorkerAllowance(state.correction); }
    catch (error) { state.correctionChargeDiagnostic = `correction charge failed: ${error?.message ?? String(error)}`; }
  }
}

/**
 * D1.5/D1.7: moves `ledger` from `reserved` to `refunded`. A no-op,
 * synchronously and unconditionally, for any handle that is not currently
 * `reserved` -- in particular once a debit has STARTED on it, successfully
 * or not (D1.5: "once debit has started refund is a no-op"), and once a
 * refund has already started or completed. This, together with the
 * synchronous state flip in `debitDirectWorkerAllowance`, is what makes the
 * two operations serialize on one handle without any lock.
 *
 * A bound correction that is still `reserved` is refunded too, the same
 * best-effort way debit charges it (`correctionRefundDiagnostic`, surfaced
 * from there into `settleDirectWorker`'s own returned diagnostic, on
 * failure, never failing the attempt's own refund).
 *
 * #2915 round 8 review 8 (C5): same creator-only lookup as `debitDirectWorkerAllowance`
 * -- a copy, fabrication or unknown handle refuses outright.
 */
export async function refundDirectWorkerAllowance(ledger) {
  if (!ledger) return;
  const state = _requireLedgerHandleState(ledger);
  if (state.state !== 'reserved') return;
  state.state = 'refunding';
  try {
    if (ledger.mode === 'file') await refundLedgerSlotFile(ledger.dir, ledger.kind, ledger.n);
    else {
      const chain = _inProcessLedgerChains.get(ledger.taskChainDigest);
      if (chain) {
        (ledger.kind === 'attempt' ? chain.attempts : chain.corrections).delete(ledger.n);
        retireInProcessChainIfEmpty(ledger.taskChainDigest);
      }
    }
  } catch (error) {
    state.state = 'refund-failed';
    throw error;
  }
  state.state = 'refunded';
  const correctionState = state.correction && _ledgerHandleState.get(state.correction);
  if (correctionState && correctionState.state === 'reserved') {
    try { await refundDirectWorkerAllowance(state.correction); }
    catch (error) { state.correctionRefundDiagnostic = `correction refund failed: ${error?.message ?? String(error)}`; }
  }
}

/**
 * D1.8: reserves ONE `correction-<n>` slot (n in 1..`MAX_STARTUP_CORRECTIONS`
 * -- the correction ceiling that actually exists in this codebase today,
 * never `ledger`'s own `maxAttempts`) in the SAME chain directory/in-process
 * chain `ledger` already belongs to, through the exact same slot primitive
 * attempts use, and binds it onto `ledger.correction` so
 * `debitDirectWorkerAllowance`/`refundDirectWorkerAllowance` propagate to it
 * automatically. Replaces the former standalone `reserveLedgerCorrection`
 * (keyed only by `captureRoot`/`taskChainDigest`) -- a correction is now
 * always an extension of one specific attempt's own reservation, never a
 * free-standing ledger call.
 *
 * Returns `startupCorrectionGate`'s own `{ ok, reason }` / `{ ok,
 * correctionsRemaining }` shape, unchanged: an unqualified `reasonCode`
 * refuses without touching any slot; an already-bound or already-exhausted
 * correction refuses with the SAME "already corrected" message
 * `startupCorrectionGate` has always produced.
 *
 * File mode RE-VALIDATES the chain directory (`validateLedgerChainDirectory`)
 * before touching a correction slot, rather than trusting the attempt
 * handle's own reserve-time validation: another process can write into the
 * SAME chain directory in the gap between an attempt being reserved and its
 * correction being reserved, and "validated moments earlier" is not
 * sufficient once that is possible.
 *
 * #2915 round 8 review 8 (C9, "correction acquisition can finish after its
 * attempt's terminal transition"): the attempt handle's eligibility is
 * checked HERE, before any of this function's own (possibly awaited) work
 * begins, AND AGAIN immediately before the correction is actually bound --
 * closing the race where `debitDirectWorkerAllowance`/
 * `refundDirectWorkerAllowance` (whose own state transition is always
 * synchronous) ran to completion on the SAME handle while this call was
 * paused on its own `await`. A parent that has started refunding, or has
 * refunded, by either checkpoint is never bound to -- a correction slot
 * this call already reserved in that window is refunded again immediately
 * (never left stranded, uncharged and parentless) and the refusal reports
 * why.
 */
export async function reserveLedgerCorrection({ ledger, reasonCode,
  // Test-only: awaited immediately after the correction slot is reserved
  // but BEFORE the re-check/bind below -- production never passes this.
  // Lets a test deterministically interleave a concurrent debit/refund of
  // the PARENT attempt handle into exactly the window the re-check exists
  // to close, instead of depending on real scheduling to land there.
  afterCorrectionReserved } = {}) {
  if (!ledger) return { ok: false, reason: 'No task chain to correct' };
  const state = _requireLedgerHandleState(ledger);
  if (state.state !== 'reserved') {
    return { ok: false, reason: `Startup correction refused: attempt reservation is '${state.state}'` };
  }
  if (state.correction) return startupCorrectionGate({ correctionsUsed: MAX_STARTUP_CORRECTIONS, reasonCode });
  const gateCheck = startupCorrectionGate({ correctionsUsed: 0, reasonCode });
  if (!gateCheck.ok) return gateCheck;
  const ceiling = MAX_STARTUP_CORRECTIONS;
  let n;
  if (ledger.mode === 'in-process') {
    const chain = _inProcessLedgerChains.get(ledger.taskChainDigest);
    n = chain ? reserveLedgerSlotInProcess(chain.corrections, ceiling, ledger.invocationId) : null;
  } else {
    await validateLedgerChainDirectory(ledger.dir, { maxAttempts: ledger.maxAttempts, maxCorrections: ceiling });
    n = await reserveLedgerSlotFile(ledger.dir, 'correction', ceiling, ledger.invocationId);
  }
  if (n == null) return startupCorrectionGate({ correctionsUsed: ceiling, reasonCode });
  if (afterCorrectionReserved) await afterCorrectionReserved();
  const correctionHandle = _createLedgerHandle({ mode: ledger.mode, captureRoot: ledger.captureRoot,
    taskChainDigest: ledger.taskChainDigest, invocationId: ledger.invocationId, kind: 'correction', n,
    dir: ledger.dir, maxAttempts: ledger.maxAttempts });
  // Re-check immediately before binding (see doc comment above): the
  // attempt-eligibility work above (`validateLedgerChainDirectory`/
  // `reserveLedgerSlotFile`, both async) is exactly the window the review
  // probe paused in. `state.correction` is also re-checked -- a second
  // concurrent `reserveLedgerCorrection` call could have bound one first.
  if (state.state !== 'reserved' || state.correction) {
    const reason = state.correction
      ? 'Startup correction refused: another correction was already bound while this one was being reserved'
      : `Startup correction refused: attempt reservation became '${state.state}' while this correction was being reserved`;
    try { await refundDirectWorkerAllowance(correctionHandle); }
    catch { /* best-effort: the slot is at worst a stranded-uncharged entry releaseLedgerSlot can still free */ }
    return { ok: false, reason };
  }
  state.correction = correctionHandle;
  return { ok: true, correctionsRemaining: ceiling - n };
}

/**
 * D1.9/C1: the one explicit operator escape hatch for a reservation whose
 * owning process died before dispatch. Refuses outright if `attempt-<n>`
 * is charged -- a committed charge is never released by this or any other
 * mechanism. Otherwise unlinks `attempt-<n>` (a no-op, reported as
 * `released: false`, if it was never reserved in the first place) and
 * returns the invocation id it had recorded, so an operator can see what
 * was consuming the allowance before releasing it. Documented (see
 * `index.mjs --help`) as being for a task chain with no running conductor --
 * nothing here attempts to verify that itself; there is deliberately no
 * age/pid/liveness inference anywhere in this file.
 */
export async function releaseLedgerSlot({ captureRoot, taskChainDigest, attempt, kind = 'attempt',
  // #2915 round 8 review 8 (C11, "operator release reports the invocation
  // identity AFTER unlinking"): optional, synchronous, best-effort callback
  // invoked with `{ invocationId }` the moment the recorded identity is
  // KNOWN -- BEFORE the unlink below runs, never after. D1.9 exists so an
  // operator can see what was consuming the allowance before releasing it;
  // if that only happens via this function's own return value, a crash or
  // thrown error between the read and the unlink (or the caller simply
  // never reaching its own print statement) means the operator never sees
  // it at all. `index.mjs` passes a callback that prints immediately here;
  // production callers that omit it keep today's "report via the return
  // value once released" behavior unchanged.
  report = () => {} } = {}) {
  if (!captureRoot) ledgerFail(LEDGER_RECORD_INVALID_CODE, 'releaseLedgerSlot requires a persistent captureRoot');
  if (typeof taskChainDigest !== 'string' || !taskChainDigest) ledgerFail(LEDGER_RECORD_INVALID_CODE, 'releaseLedgerSlot requires taskChainDigest');
  if (!Number.isSafeInteger(attempt) || attempt < 1) ledgerFail(LEDGER_RECORD_INVALID_CODE, 'releaseLedgerSlot requires a positive integer attempt number');
  if (kind !== 'attempt' && kind !== 'correction') ledgerFail(LEDGER_RECORD_INVALID_CODE, "releaseLedgerSlot requires kind to be 'attempt' or 'correction'");
  if (process.platform === 'win32') {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, 'Persistent allowance ledger is unavailable on this platform (win32)');
  }
  const dir = ledgerChainDir(captureRoot, taskChainDigest);
  await assertPrivateLedgerDirectory(captureRoot);
  await assertPrivateLedgerDirectory(join(captureRoot, 'ledger'));
  await assertExactLedgerChainMode(dir);
  const chargedId = await readLedgerSlotIdentity(dir, `${kind}-${attempt}.charged`);
  if (chargedId !== undefined) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, `${kind}-${attempt} is already charged; refusing to release a committed ${kind}`);
  }
  const invocationId = await readLedgerSlotIdentity(dir, `${kind}-${attempt}`);
  if (invocationId === undefined) return { released: false, invocationId: null, reason: 'slot was not reserved' };
  try { report({ invocationId: invocationId ?? null }); } catch { /* reporting must never block the actual release */ }
  await refundLedgerSlotFile(dir, kind, attempt);
  return { released: true, invocationId: invocationId ?? null };
}

/**
 * The operator counterpart to `releaseLedgerSlot`, for `policy` itself
 * (`--ledger-release <taskChainDigest> policy`). Removing `policy` while
 * any attempt or correction entry still exists would let a FRESH reserve
 * for the same digest publish a NEW policy with a different budget while
 * the old charged/occupied slots stay in place -- exactly the "regrant
 * spent allowance" failure the whole design exists to prevent -- so this
 * refuses outright whenever the chain directory has anything in it besides
 * `policy`. Only ever useful on a chain that is otherwise already empty
 * (every attempt/correction already individually released or never
 * reserved), and only ever needed to recover a chain whose `policy`
 * publish itself crashed in the narrow pre-link window `ensureLedgerPolicy`
 * documents.
 */
export async function releaseLedgerPolicy({ captureRoot, taskChainDigest } = {}) {
  if (!captureRoot) ledgerFail(LEDGER_RECORD_INVALID_CODE, 'releaseLedgerPolicy requires a persistent captureRoot');
  if (typeof taskChainDigest !== 'string' || !taskChainDigest) ledgerFail(LEDGER_RECORD_INVALID_CODE, 'releaseLedgerPolicy requires taskChainDigest');
  if (process.platform === 'win32') {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, 'Persistent allowance ledger is unavailable on this platform (win32)');
  }
  const dir = ledgerChainDir(captureRoot, taskChainDigest);
  await assertPrivateLedgerDirectory(captureRoot);
  await assertPrivateLedgerDirectory(join(captureRoot, 'ledger'));
  await assertExactLedgerChainMode(dir);
  let entries;
  try { entries = await withWorkerPath(dir, target => readdir(target)); }
  catch (error) {
    if (error.code === 'ENOENT') return { released: false, reason: 'chain directory does not exist' };
    throw error;
  }
  if (entries.some((name) => name !== 'policy')) {
    ledgerFail(LEDGER_RECORD_INVALID_CODE, 'refusing to release policy: the chain still has attempt or correction entries');
  }
  try { await withWorkerPath(join(dir, 'policy'), target => unlink(target)); }
  catch (error) {
    if (error.code === 'ENOENT') return { released: false, reason: 'policy was not present' };
    throw error;
  }
  return { released: true };
}

/**
 * #2915 step 4 (retry linkage). Replaces the deleted `freshAttempt`
 * (unauthenticated caller bypass), `afterAttempt` (caller-asserted
 * evidence) and the path-pair (`invocationPath`+`runDir` equality)
 * inference entirely. A retry is now conductor-DECLARED, never inferred:
 * `retryOf` names the previous attempt's `invocationId` AND the exact
 * `runDir` it ran in; omission means unrelated work and is NEVER refused
 * for retry reasons, no matter what path coincidence exists.
 *
 * When supplied, the predecessor's OWN launcher-written evidence is read
 * directly from disk with the same anchored, no-follow, bounded readers
 * `launchOneWorker` uses for every other worker-adjacent file — never a
 * caller-supplied object. The directory and every file must be privately
 * owned (0700 dir; 0600, single-link, unaliased regular files); identity
 * (`.launch-owner`, `invocation.json.invocationId`, `exit.json.invocationId`)
 * must all agree with `retryOf.invocationId`; `invocation.json.origin` must
 * be `'launcher'` (never a worker-writable record); and the predecessor's
 * `taskDigest` must match the NEW attempt's own task (task-chain binding —
 * a retry can replace only the SAME task's prior attempt, never an
 * unrelated one that merely shares a directory). Missing, unreadable,
 * malformed or identity-mismatched evidence refuses the replacement
 * (`UNBOUND_RETRY_EVIDENCE_CODE`); a present, well-formed, matching record
 * still must show CONFIRMED termination (`stopBeforeRetryGate`) — an
 * uncertain predecessor refuses exactly as before.
 *
 * Returns the predecessor's verified `exit.json` record on success; throws
 * on any refusal.
 */
export async function verifyRetryPredecessor(retryOf, { newInvocationPath, inspect, workerWritableRoots } = {}) {
  const fail = (reason) => {
    const error = new Error(`Retry predecessor evidence refused: ${reason}`);
    error.code = UNBOUND_RETRY_EVIDENCE_CODE;
    throw error;
  };
  if (!retryOf || typeof retryOf.invocationId !== 'string' || !retryOf.invocationId
    || typeof retryOf.runDir !== 'string' || !retryOf.runDir) {
    fail('retryOf requires both a non-empty invocationId and runDir');
  }
  const { invocationId: prevId, runDir: prevRunDir } = retryOf;
  // #2915 review 4 (finding 4): the minimal directory-authority repair —
  // reject a predecessor location inside any worker-writable root, exactly
  // like `launchOneWorker` already refuses for a NEW run directory. This
  // closes the easiest forgery (planting a complete, well-formed fake
  // predecessor inside the worktree the worker itself can write to) but is
  // explicitly NOT a defense against an unconfined malicious same-UID
  // worker in general: such a worker can still write anywhere this
  // conductor process can (e.g. directly under a configured capture root,
  // if that root is not itself outside every worker-writable path, or by
  // racing a legitimate predecessor's own directory before this check
  // runs). A real guarantee needs an enforced filesystem/process boundary
  // protecting conductor-owned metadata, or a different execution
  // identity — same-UID alone never provides it.
  if (Array.isArray(workerWritableRoots)) {
    for (const root of workerWritableRoots) {
      if (await realBeneath(root, prevRunDir)) fail('predecessor location is inside a worker-writable root');
    }
  }
  if (!await inspect(prevRunDir, 'directory')) fail('predecessor run directory is missing');
  const dirStat = await lstat(prevRunDir);
  if (dirStat.uid !== process.getuid() || (dirStat.mode & 0o077)) fail('predecessor run directory is not privately owned');
  let ownerBytes, invocationBytes, exitBytes;
  try {
    // #2915 review 4 (finding 4): `rejectInsecureMode: true` — an insecure
    // mode on predecessor metadata REFUSES the retry instead of silently
    // chmod-repairing it and proceeding (the former behaviour the review
    // found: "the probe's 0666 files were accepted and changed to 0600").
    ownerBytes = await boundedPrivateRead(join(prevRunDir, '.launch-owner'), 256, inspect, true, true);
    invocationBytes = await boundedPrivateRead(join(prevRunDir, 'invocation.json'), 1048576, inspect, true, true);
    exitBytes = await boundedPrivateRead(join(prevRunDir, 'exit.json'), 1048576, inspect, true, true);
  } catch (error) { fail(`predecessor metadata is missing, insecurely-moded, or not a bounded, privately-owned, unaliased regular file (${error.message})`); }
  if (ownerBytes.toString('utf8') !== prevId) fail('.launch-owner does not match retryOf.invocationId');
  let invocationRecord, exitRecord;
  try {
    invocationRecord = JSON.parse(invocationBytes.toString('utf8'));
    exitRecord = JSON.parse(exitBytes.toString('utf8'));
  } catch { fail('predecessor metadata is not valid JSON'); }
  if (invocationRecord?.invocationId !== prevId || invocationRecord?.origin !== 'launcher') {
    fail('invocation.json identity does not match retryOf (or is not launcher-written)');
  }
  if (exitRecord?.invocationId !== prevId) fail('exit.json identity does not match retryOf');
  if (newInvocationPath !== undefined) {
    // #2915 review 4 (finding 4): the SAME stable task-chain identity
    // `launchOneWorker` publishes — role/task/group plus the brief CONTENT
    // digest, never `final_output`/`brief`/`workdir` PATHS, which legitimately
    // differ between a confirmed predecessor and this fresh attempt.
    let newTaskDigest;
    try {
      const newPlanBytes = await boundedPrivateRead(newInvocationPath, 1048576, inspect);
      const newPlan = JSON.parse(newPlanBytes.toString('utf8'));
      newTaskDigest = await stableTaskChainDigest(newPlan.request, newPlan.invocation?.briefDigest ?? null);
    } catch { fail('new attempt plan is missing or invalid; cannot bind the retry to a task'); }
    if (invocationRecord.taskDigest !== newTaskDigest) fail('predecessor task does not match the new attempt (task-chain binding)');
  }
  assertStopBeforeRetry(exitRecord, { expectedInvocationId: prevId });
  return exitRecord;
}

/**
 * One corrected startup retry (#2915, 03 §11.5 step 1). A failed start may
 * correct a demonstrated qualified mechanical cause at most once — and only
 * within the task's existing attempts/budget, which the caller enforces.
 * Auth, trust, resource and unknown causes are never qualified: they need
 * authorized restoration or diagnosis, not a blind relaunch.
 */
export const MAX_STARTUP_CORRECTIONS = 1;
export const QUALIFIED_STARTUP_CORRECTION_CODES = Object.freeze(['STDIN_WAIT', 'NOT_FOUND', 'MODEL']);

export function startupCorrectionGate({ correctionsUsed = 0, reasonCode = null } = {}) {
  if (!QUALIFIED_STARTUP_CORRECTION_CODES.includes(reasonCode)) {
    return { ok: false, reason: `Reason '${reasonCode ?? 'unknown'}' is not a qualified mechanical startup cause` };
  }
  if (correctionsUsed >= MAX_STARTUP_CORRECTIONS) {
    return { ok: false, reason: `Startup already corrected once (${correctionsUsed}); no further blind relaunch` };
  }
  return { ok: true, correctionsRemaining: MAX_STARTUP_CORRECTIONS - correctionsUsed };
}

/**
 * Build the narrowest-scope failure attribution for a failed invocation.
 * Identities come from trusted resolved configuration only: the inference
 * backend is the raw `selected.inferenceProvider` string (never normalized
 * through the CLI/provider-definition registry, which maps backends onto
 * CLI ids and merges the two identities), the installation is
 * `selected.cli`, and the quota account is the installation qualification's
 * `accountScope` (or an explicitly passed trusted account). Reason codes
 * carry an evidence source: only launcher/resolver-classified reasons may
 * widen a scope — worker-derived codes (stderr signatures, worker output,
 * worker-writable files) stay invocation-scoped no matter their text.
 */
export async function buildFailureAttribution(invocation, { reasonCode = null, evidenceSource = null,
  quotaAccount = null, hostId = null, corroboratedBackends = null, installationQualifier = null } = {}) {
  const { attributeFailureScope } = await import('./lib/consecutive-failure-circuit-breaker.mjs');
  const { workerModelKey } = await importImpl(import.meta.url, 'models/provider-policy.js');
  const selected = invocation?.selected ?? {};
  let modelKey = null;
  try {
    const inferenceProvider = selected.inferenceProvider ?? null;
    const apiModelId = selected.apiModelId ?? selected.model ?? null;
    if (inferenceProvider && apiModelId) modelKey = workerModelKey(inferenceProvider, apiModelId);
  } catch { modelKey = null; }
  const account = quotaAccount
    ?? invocation?.qualification?.installation?.accountScope
    ?? selected.accountScope
    ?? null;
  return attributeFailureScope({
    reasonCode,
    evidenceSource,
    invocationId: invocation?.invocationId ?? null,
    modelKey,
    cli: selected.cli ?? null,
    inferenceProvider: selected.inferenceProvider ?? null,
    quotaAccount: account,
    hostId,
    corroboratedBackends,
    installationQualifier,
  });
}

/**
 * Classify a launcher-observed attempt outcome into trusted recovery
 * evidence. Uses ONLY launcher-owned facts (spawn errors on the resolved
 * argv, native unit results, and independently queried qualified endpoints) — never worker
 * stderr/stdout text, structured worker output, or worker-writable records.
 * Private endpoint observations may attest quota/provider failure; native
 * resource failures require cross-backend corroboration. Other post-spawn
 * outcomes attest only this invocation. Failure to execute the resolved CLI
 * binary itself implicates its installation. Signatures visible only in worker output
 * are worker-sourced by definition and must not be passed here as
 * launcher evidence.
 */
export function classifyLaunchOutcomeForRecovery(result) {
  const observed = launcherRecoveryEvidence(result);
  if (observed) return observed;
  if (result?.termination !== 'confirmed') return { reasonCode: null, evidenceSource: null };
  const code = result?.errorCode ?? null;
  if ((code === 'ENOENT' || code === 'EACCES' || code === 'SPAWN_ERROR') && !result?.sawExit && result?.exitCode == null) {
    return { reasonCode: 'NOT_FOUND', evidenceSource: 'launcher' };
  }
  return { reasonCode: null, evidenceSource: 'launcher' };
}

/**
 * Process-scoped recovery breaker owner for the S1 direct dispatch path
 * (#2915A). Both direct launch functions (`launchWorker` below and
 * `planDirectWorkerLaunch`) construct-and-consult this one breaker, so
 * repeated conductor attempts in this process share scope state: `canLaunch`
 * before a launch, failure attribution after an attempt, probe/canary
 * gating before a paused scope resumes.
 *
 * State lives in-memory in this process (see ScopedFailureBreaker restart
 * notes): a process restart comes up with every scope CLOSED, coupled with
 * the stop-before-retry gate below. Tests inject a synthetic-clock breaker
 * via `setDirectRecoveryBreaker`; production uses the lazy default.
 */
let _directRecoveryBreaker = null;

export function getDirectRecoveryBreaker() {
  // #2915 round 8 review 8 (C3 follow-up, "production deadlines use
  // Date.now(), not a monotonic clock"): the real production singleton is
  // the one place this matters -- a wall-clock adjustment (NTP step, manual
  // change, DST) must never shorten or lengthen a canary/commit deadline
  // this breaker is already tracking. `performance.now()` is monotonic and
  // every comparison `ScopedFailureBreaker` makes is relative to another
  // reading of this SAME clock, so this is a safe, isolated override —
  // `ScopedFailureBreaker`'s own constructor default stays `Date.now()` for
  // every other (in particular, every test) caller.
  if (!_directRecoveryBreaker) _directRecoveryBreaker = new ScopedFailureBreaker({ nowMs: () => performance.now() });
  return _directRecoveryBreaker;
}

export function setDirectRecoveryBreaker(breaker) {
  _directRecoveryBreaker = breaker;
}

export function resetDirectRecoveryBreaker() {
  try { _directRecoveryBreaker?.destroy(); } catch { /* never fail teardown */ }
  _directRecoveryBreaker = null;
}

/**
 * Synchronous, process-local digest of a resolved selection (#2915 review 6,
 * finding 1, "unauthenticated/reused authority"): used ONLY to cross-check a
 * BORROWED admission's claimed selection against the invocation we are about
 * to dispatch for -- never persisted, never a stable public identity, never
 * part of any scope key. Deliberately synchronous (no dynamic import):
 * `planDirectWorkerLaunch`'s borrowed-admission branch must throw
 * synchronously (see its own doc comment), so this cannot await the lazy
 * `qualificationDigest` module load the rest of this file otherwise prefers.
 */
export function selectionDigestFor(invocation) {
  const selected = invocation?.selected ?? null;
  if (!selected) return null;
  const payload = JSON.stringify({ cli: selected.cli ?? null, model: selected.model ?? null,
    apiModelId: selected.apiModelId ?? null, inferenceProvider: selected.inferenceProvider ?? null });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Derive the recovery scope keys covering a resolved invocation, from
 * trusted resolved configuration only (selected cli/backend, installation
 * accountScope, model). The invocation key uses the launcher-minted
 * invocationId. Unresolvable identities are omitted — never defaulted to a
 * shared scope, EXCEPT `host:local`, which always covers every direct
 * dispatch today (single-host S1 scope; #2915 review: model/host scopes
 * could open but nothing ever checked them, since this function omitted
 * both). `installationQualifier`, when supplied, distinguishes
 * separately-qualified installations that share a CLI name (e.g. the
 * installed binary's boundary digest) so two different installations of
 * the same CLI never share one `installation:<cli>` scope.
 */
export async function recoveryScopeKeysForInvocation(invocation, { invocationId = null, quotaAccount = null,
  installationQualifier = null } = {}) {
  const selected = invocation?.selected ?? {};
  const keys = [];
  if (invocationId != null) keys.push(`invocation:${invocationId}`);
  let modelKey = null;
  try {
    const { workerModelKey } = await importImpl(import.meta.url, 'models/provider-policy.js');
    const inferenceProvider = selected.inferenceProvider ?? null;
    const apiModelId = selected.apiModelId ?? selected.model ?? null;
    if (inferenceProvider && apiModelId) modelKey = workerModelKey(inferenceProvider, apiModelId);
  } catch { modelKey = null; }
  if (modelKey) keys.push(`model:${modelKey}`);
  if (selected.cli) keys.push(installationQualifier ? `installation:${selected.cli}:${installationQualifier}` : `installation:${selected.cli}`);
  if (selected.inferenceProvider) keys.push(`provider:${selected.inferenceProvider}`);
  const account = quotaAccount
    ?? invocation?.qualification?.installation?.accountScope
    ?? selected.accountScope
    ?? null;
  if (account) keys.push(`quota:${account}`);
  keys.push('host:local');
  return keys;
}

export const RECOVERY_SCOPE_OPEN_CODE = 'RECOVERY_SCOPE_OPEN';

/**
 * #2915 round 8 (D6): the COMPLETE, pure direct-recovery eligibility
 * decision, extracted so every surface that must decide "is recovery
 * gated for this attempt" — `admitDirectWorker` below, the attached
 * launcher's `launchOneWorker`, `planDirectWorkerLaunch`'s standalone
 * branch, and (via this same export) the MCP `run()` bridge in
 * `src/mcp/tools/worker-invoke.mjs` — calls the SAME function with the
 * SAME inputs, instead of re-deriving (or partially re-deriving) the
 * decision inline. Seven prior review rounds found drift specifically
 * because the disabled/enabled decision was threaded through new code as
 * ad hoc conditions (`if (gate.enabled) ... else ...`, `if (admission.
 * gated) ...`) that could fall out of sync with `admitDirectWorker`'s own
 * checks; one shared predicate makes that drift structurally impossible
 * for every call site that uses it.
 *
 * The decision has exactly four components, checked in order, matching
 * what `admitDirectWorker` itself checked inline before this extraction:
 *   1. the global switch (`gateEnabled`, resolved by the caller's own
 *      `checkWorkerDispatch()`/dispatch-gate result — never re-derived
 *      here, so this performs no new I/O);
 *   2. per-CLI enablement (`config.parallelism.clis[<cli>].enabled`);
 *   3. `canVerifyAttempt: false` (Warp, Copilot — an adapter that can
 *      never report a verified success back to the breaker is never
 *      eligible for recovery-breaker gating at all, see
 *      `worker-installation.mjs`);
 *   4. an explicit breaker override (`scopedBreaker: null`) or, in the
 *      hypothetical case the shared breaker getter itself returns a
 *      falsy value, the ambient shared breaker being unavailable.
 *
 * Performs no reservation, no breaker/ledger import, and no I/O beyond
 * what `admitDirectWorker` already performed at this exact point before
 * this extraction (a synchronous config/driver lookup and the existing
 * `getDirectRecoveryBreaker()` accessor, already imported by this file).
 *
 * Returns `{ gated: false, reason }` (same `reason` strings
 * `admitDirectWorker` always returned for these cases — `undefined` for
 * the first two, which never carried one) or `{ gated: true }`.
 */
export function directRecoveryEligibility({ gateEnabled, config, invocation, drivers = {}, scopedBreaker } = {}) {
  if (!gateEnabled) return { gated: false };
  const cli = invocation?.selected?.cli ?? null;
  if (cli && config?.parallelism?.clis?.[cli]?.enabled === false) return { gated: false };
  // #2915 follow-up: an adapter whose `parseWorkerFinal`/`parseWorkerAttemptFinal`
  // can NEVER validate a final (Warp, Copilot — `canVerifyAttempt: false`,
  // see worker-installation.mjs) can never report a verified success back
  // to the breaker. Admitting a canary for such a CLI would gate it behind
  // a success that is structurally unreachable, not merely unlikely — so
  // this CLI is never eligible for recovery-breaker gating at all, exactly
  // like the global/per-CLI dispatch switch being off.
  if (cli && getWorkerRecoveryCapabilities(drivers?.[cli])?.canVerifyAttempt === false) return { gated: false, reason: 'cli-cannot-verify-final' };
  // #2915 round 8 review 8 (A/D6, "directRecoveryEligibility constructs/
  // reads shared breaker state"): this must decide from its OWN inputs
  // only — never call the `getDirectRecoveryBreaker()` accessor, which
  // lazily CONSTRUCTS (a side effect) and caches the shared singleton the
  // first time anything calls it. The only way the resolved breaker could
  // ever be falsy is the caller's own explicit `scopedBreaker: null`
  // override (documented as "disables the gate"); the default
  // (`scopedBreaker` omitted/`undefined`) always resolves to a truthy
  // breaker via that accessor, so checking for the override directly is
  // exactly equivalent — without ever touching module-level state.
  if (scopedBreaker === null) return { gated: false };
  return { gated: true };
}

/**
 * ONE admission entry point (#2915 final review step 3), shared by
 * `launchOneWorker`, `planDirectWorkerLaunch` and the MCP `run()` bridge
 * (`src/mcp/tools/worker-invoke.mjs`). Replaces the three independent
 * `canLaunch`+`noteLaunched` call sites the review found — one of which
 * (MCP shell dispatch) re-gated and rejected its own already-admitted
 * canary, and none of which released capacity uniformly on every pre-spawn
 * exception.
 *
 * Global dispatch (`gateEnabled`, resolved by the caller's own
 * `checkWorkerDispatch()`/dispatch-gate result) AND per-CLI enablement
 * (`config.parallelism.clis[<cli>].enabled`) are checked FIRST, before any
 * import, scope derivation or breaker construction — either disabled
 * returns `{ gated: false }` ("not-gated"): the recovery breaker is never
 * constructed or consulted, so behaviour is byte-for-byte what it was
 * before this feature existed (#2915 final review, finding 1: the planner
 * checked only the global switch, so a per-CLI-disabled selection still
 * constructed and consulted the breaker). This eligibility decision is
 * `directRecoveryEligibility` above — the same function every other
 * decision point in this file (and the MCP bridge) calls.
 *
 * Returns one of:
 *   - `{ gated: false }` — recovery is not in effect for this attempt.
 *   - `{ gated: true, refused: { code, blockedBy, nextEligibleAt } }` — a
 *     covering scope is open and not due; nothing was reserved.
 *   - `{ gated: true, breaker, token, quotaAccount, installationQualifier }`
 *     — admitted (ordinarily or as the canary for `token.canaryKeys`).
 *     `token` MUST be passed to exactly one later `settleDirectWorker` call.
 */
const recoveryTransitionSubscriptions = new WeakMap();

export async function admitDirectWorker(options = {}) {
  const eligibility = directRecoveryEligibility(options);
  if (!eligibility.gated) return eligibility;
  const breaker = options.scopedBreaker ?? getDirectRecoveryBreaker();
  const report = options.onTransition ?? (event => console.error(event.summary));
  const listener = event => {
    if (_reportedRecoveryTransitions.has(event)) return;
    if (report(event) !== false) _reportedRecoveryTransitions.add(event);
  };
  if (options.onTransition !== null) breaker.on?.('transition', listener);
  const unsubscribe = () => breaker.removeListener?.('transition', listener);
  let admission;
  try {
    admission = await admitDirectWorkerInner({ ...options, scopedBreaker: breaker });
    if (admission.token) recoveryTransitionSubscriptions.set(admission, unsubscribe);
    return admission;
  } finally { if (!admission?.token) unsubscribe(); }
}

async function admitDirectWorkerInner({ gateEnabled, config, invocation, invocationId, drivers = {},
  scopedBreaker, quotaAccount = null, installationQualifier = null,
  // #2915 review 4 (finding 8): the allowance ledger is consulted ONLY when
  // gated — disabled dispatch (or an ineligible CLI, or a covering scope
  // that's open) performs ZERO ledger operations, the same "not-gated"
  // posture as the breaker itself. `taskChainDigest`/`maxAttempts` are
  // required to reserve; omitting either (a caller with no resolved task,
  // e.g. a flat-option standalone planner call) simply skips the ledger.
  taskChainDigest = null, maxAttempts = null, captureRoot = null, dispatchGuard } = {}) {
  const eligibility = directRecoveryEligibility({ gateEnabled, config, invocation, drivers, scopedBreaker });
  if (!eligibility.gated) return eligibility;
  const cli = invocation?.selected?.cli ?? null;
  const breaker = scopedBreaker !== undefined ? scopedBreaker : getDirectRecoveryBreaker();
  if (!breaker) return { gated: false };
  const startedAtMs = breaker.nowMs();
  dispatchGuard ??= { nowMs: () => breaker.nowMs(), deadlineAtMs: startedAtMs + Math.min(
    invocation?.health?.hardTimeoutSeconds ?? Infinity, invocation?.limits?.wallSeconds ?? Infinity,
    invocation?.mcp?.timeoutSeconds ?? Infinity) * 1000 };
  const resolvedInstallationQualifier = installationQualifier
    ?? drivers?.[cli]?.qualification?.installation?.boundary?.digest ?? null;
  const resolvedQuotaAccount = quotaAccount ?? drivers?.[cli]?.qualification?.installation?.accountScope ?? null;
  const scopeKeys = invocation?.selected
    ? await recoveryScopeKeysForInvocation(invocation, { quotaAccount: resolvedQuotaAccount, installationQualifier: resolvedInstallationQualifier })
    : [];
  // #2915 round 8 (D3): the selection digest is bound onto the breaker's own
  // FROZEN reservation token at admission time — never only a separate
  // mutable field on this function's returned wrapper — so `beginDispatch`
  // later has an authoritative, breaker-owned value to compare against.
  const selectionDigest = selectionDigestFor(invocation);
  try { checkDispatchGuard(dispatchGuard); } catch (error) {
    return { gated: true, refused: { code: RECOVERY_SCOPE_OPEN_CODE, blockedBy: [], nextEligibleAt: null, reason: error.message } };
  }
  let probeDiagnostic = null;
  let admission = breaker.admit({ invocationId, scopeKeys, selectionDigest });
  if (!admission.ok && admission.probeRequired?.length) {
    // Probe and task are separate dispatches against the same cumulative
    // allowance. Reserve atomically before any asynchronous probe work.
    try { checkDispatchGuard(dispatchGuard); } catch (error) {
      return { gated: true, refused: { code: RECOVERY_SCOPE_OPEN_CODE, blockedBy: [], nextEligibleAt: null, reason: error.message } };
    }
    const probeId = `${invocationId}:probe:${randomUUID()}`;
    const reserved = breaker.admit({ invocationId: probeId, scopeKeys, selectionDigest, purpose: 'probe' });
    if (reserved.ok) {
      let probeLedger = null;
      let probeDispatched = false;
      let probeOutcome = { kind: 'uncertain', confirmedStop: true };
      try {
        if (taskChainDigest == null || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
          throw new Error('Recovery probe requires remaining task allowance');
        }
        checkDispatchGuard(dispatchGuard);
        if (captureRoot != null) {
          const writableRoots = [invocation?.cwd, ...(drivers?.[cli]?.qualification?.installation?.workerWritableRoots ?? [])].filter(Boolean);
          for (const root of writableRoots) {
            if (await realBeneath(root, captureRoot)) ledgerFail(LEDGER_RECORD_INVALID_CODE,
              'ledger capture root is inside a worker-writable location');
          }
        }
        probeLedger = await reserveDirectWorkerAllowance({ captureRoot, taskChainDigest, invocationId: probeId, maxAttempts });
        const began = breaker.beginDispatch(reserved.token, { invocationId: probeId, selectionDigest });
        if (!began.ok) throw new Error(began.reason);
        const { runRecoveryProbe } = await import('./lib/recovery-probe.mjs');
        const result = await runRecoveryProbe({ driver: drivers[cli], invocation,
          timeoutMs: Math.min(breaker.policy.probeTimeoutMs, reserved.token.deadlineMs - breaker.nowMs(),
            dispatchGuard?.deadlineAtMs == null ? Infinity : dispatchGuard.deadlineAtMs - (dispatchGuard.nowMs?.() ?? Date.now())), maxOutputBytes: breaker.policy.probeMaxOutputBytes,
          onDispatch: async () => {
            checkDispatchGuard(dispatchGuard);
            await debitDirectWorkerAllowance(probeLedger);
            checkDispatchGuard(dispatchGuard);
            const committed = breaker.commitDispatch(reserved.token);
            if (!committed.ok) throw new Error(committed.reason);
            probeDispatched = true;
          } });
        probeDiagnostic = { reason: result.reason, operatorIntervention: result.operatorIntervention === true };
        probeOutcome = { kind: probeDispatched ? (result.success ? 'succeeded' : 'failed') : 'uncertain',
          relevant: result.relevant === true, evidenceSource: 'launcher', retryAfterSeconds: result.retryAfterSeconds ?? null,
          confirmedStop: result.termination === 'confirmed' };
      } catch (error) {
        try { breaker.abortDispatch(reserved.token, { callerAborted: dispatchGuard?.isCancelled?.() === true }); } catch { /* no dispatch on preparation failure */ }
        if ([ALLOWANCE_EXHAUSTED_CODE, ALLOWANCE_POLICY_MISMATCH_CODE, LEDGER_RECORD_INVALID_CODE].includes(error?.code)) {
          return { gated: true, refused: { code: error.code, blockedBy: [], nextEligibleAt: null, reason: error.message } };
        }
      } finally {
        breaker.settle(reserved.token, { ...probeOutcome,
          callerAborted: dispatchGuard.isCancelled?.() === true });
        if (probeLedger) await refundDirectWorkerAllowance(probeLedger);
      }
      if (probeDiagnostic?.operatorIntervention) {
        breaker.requireOperatorIntervention(reserved.token.canaryKeys, probeDiagnostic.reason);
      }
      admission = breaker.admit({ invocationId, scopeKeys, selectionDigest });
    } else admission = reserved;
  }
  if (!admission.ok) {
    const operatorReasons = (admission.blockedBy ?? []).map(key => breaker.getState?.(key)?.operatorReason).filter(Boolean);
    return { gated: true, refused: { code: operatorReasons.length ? 'RECOVERY_OPERATOR_INTERVENTION' : RECOVERY_SCOPE_OPEN_CODE,
      blockedBy: admission.blockedBy, nextEligibleAt: admission.nextEligibleAt,
      ...(probeDiagnostic ? { probeDiagnostic } : {}),
      ...(operatorReasons.length ? { reason: operatorReasons.join('; ') } : {}) } };
  }
  let ledger = null;
  let ledgerDiagnostic = null;
  if (taskChainDigest != null && Number.isInteger(maxAttempts) && maxAttempts >= 1) {
    // #2915 round 8 (C, "admitDirectWorker rolls back its own partial
    // acquisition"): the breaker already minted a reservation above — root
    // resolution (the worker-writable-root exclusion below) AND the ledger
    // reserve itself are now BOTH covered by one try/catch. Any throw here
    // releases that reservation before propagating, exactly like every
    // other refused admission; previously only the ledger reserve call was
    // protected, leaking the reservation on a root-resolution exception
    // (#2915 round 8 critique, finding "root-resolution exceptions after
    // internal breaker admission; caller-side cleanup cannot recover an
    // unreturned handle").
    try {
      // #2915 round 8 (C6, D1.1): the SAME worker-writable-root exclusion
      // `launchOneWorker` already applies to the run directory, applied here
      // to the ledger's own persistence root — a caller-supplied `captureRoot`
      // inside any worker-writable location (including the invocation's own
      // cwd) is never trusted as cross-process storage: a worker with write
      // access there could delete/replace ledger slots to regrant allowance.
      // Unlike review 6, an explicitly supplied root that fails this check
      // now REFUSES the admission outright rather than silently falling back
      // to the in-process ledger (rev7-codex-2915.md finding 11/"P2": two
      // modeled conductor processes using the same explicit-but-unsafe root
      // each debited independently, with no shared record at all). Only the
      // already-accepted NO-root mode is ever in-process.
      if (captureRoot != null) {
        const candidateRoots = [invocation?.cwd, ...(drivers?.[cli]?.qualification?.installation?.workerWritableRoots ?? [])].filter(Boolean);
        for (const root of candidateRoots) {
          if (await realBeneath(root, captureRoot)) {
            ledgerFail(LEDGER_RECORD_INVALID_CODE, 'ledger capture root is inside a worker-writable location; refusing rather than silently falling back to an in-process ledger');
          }
        }
      }
      ledger = await reserveDirectWorkerAllowance({ captureRoot, taskChainDigest, invocationId, maxAttempts });
    } catch (error) {
      // Release the breaker-side reservation before deciding how to report
      // the failure — never leak it regardless of which branch below runs.
      try { breaker.settle(admission.token, { kind: 'uncertain', confirmedStop: true }); } catch { /* never fail a refusal */ }
      // Preserve the EXISTING behavior for a ledger-reserve-specific
      // failure (exhausted/policy-mismatch/invalid): report it as an
      // ordinary refusal, which every caller (`launchOneWorker`,
      // `planDirectWorkerLaunch`, `src/mcp/tools/worker-invoke.mjs`'s
      // `run()`) already handles uniformly. Anything else (e.g. an
      // unexpected root-resolution failure) rethrows — every one of those
      // same callers already treats a thrown `admitDirectWorker` as
      // fail-closed.
      if ([ALLOWANCE_EXHAUSTED_CODE, ALLOWANCE_POLICY_MISMATCH_CODE, LEDGER_RECORD_INVALID_CODE].includes(error?.code)) {
        return { gated: true, refused: { code: error.code, blockedBy: [], nextEligibleAt: null,
          reason: error.message, ledgerDiagnostic } };
      }
      throw error;
    }
  }
  // `invocationId`/`selectionDigest` (#2915 review 6, finding 1): identity
  // the BORROWED-admission path cross-checks against the invocation it is
  // actually about to dispatch for, so a reservation minted for one
  // invocation/selection cannot authorize a launch for a different one.
  // These are convenience/diagnostic copies ONLY — the authoritative
  // comparison (#2915 round 8, D3) happens inside `beginDispatch` against
  // the breaker's own frozen token fields, never against this object.
  return { gated: true, breaker, token: admission.token, quotaAccount: resolvedQuotaAccount, installationQualifier: resolvedInstallationQualifier,
    ledger, invocationId, selectionDigest, ledgerDiagnostic, startedAtMs };
}

/** Charge a diagnostic at its request boundary against the worker's task chain.
 * Its own reservation counts the request without attributing task failure to
 * any shared scope or competing with an already admitted canary. */
export async function chargeDirectWorkerDiagnostic(admission, dispatchGuard) {
  if (!admission?.gated || !admission.ledger) throw new Error('Diagnostic requires remaining task allowance');
  _requireLedgerHandleState(admission.ledger);
  checkDispatchGuard(dispatchGuard);
  const invocationId = `${admission.invocationId}:diagnostic:${randomUUID()}`;
  const reserved = admission.breaker.admit({ invocationId, purpose: 'probe' });
  if (!reserved.ok) throw new Error('Diagnostic recovery reservation refused');
  let ledger;
  let dispatched = false;
  try {
    ledger = await reserveDirectWorkerAllowance({ captureRoot: admission.ledger.captureRoot,
      taskChainDigest: admission.ledger.taskChainDigest, maxAttempts: admission.ledger.maxAttempts, invocationId });
    const began = admission.breaker.beginDispatch(reserved.token, { invocationId, selectionDigest: null });
    if (!began.ok) throw new Error(began.reason);
    checkDispatchGuard(dispatchGuard);
    await debitDirectWorkerAllowance(ledger);
    checkDispatchGuard(dispatchGuard);
    const committed = admission.breaker.commitDispatch(reserved.token);
    if (!committed.ok) throw new Error(committed.reason);
    dispatched = true;
  } finally {
    if (dispatched) admission.breaker.settle(reserved.token, { kind: 'succeeded', confirmedStop: true });
    else admission.breaker.abortDispatch(reserved.token, { callerAborted: dispatchGuard?.isCancelled?.() === true });
    if (ledger) await refundDirectWorkerAllowance(ledger);
  }
}

/**
 * Settle exactly one `admitDirectWorker` admission. A no-op for a
 * `{ gated: false }` or `{ refused }` admission (nothing was reserved).
 * Never throws: recovery accounting must never fail a launch whose own
 * outcome is already decided.
 */
// #2915 review 4 (finding 8): returns a Promise (resolved once any owed
// ledger refund completes, or immediately if none is owed) so a caller
// that needs deterministic ordering (tests; `launchOneWorker`'s own
// catch blocks) can `await settleDirectWorker(...)`. Production call sites
// in `launchOneWorker` now await it (#2915 review 6, finding 9); a caller
// that still does not await is harmless — the breaker settlement above
// still runs synchronously first, and the refund (if any) still completes
// on its own.
//
// #2915 review 6 (finding 9): the returned promise NEVER rejects (a
// refund failure must never fail a launch whose own outcome is already
// decided) but now resolves to a bounded diagnostic STRING naming the
// refund failure, or `null` when nothing went wrong, instead of silently
// swallowing it into `undefined` — a caller that awaits can surface that
// diagnostic (`launchOneWorker` does, into its thrown error or returned
// result) rather than the failure being entirely invisible.
export function settleDirectWorker(admission, outcome = { kind: 'uncertain' }) {
  // #2915 round 8 (D1.5): `refundDirectWorkerAllowance` is now its own
  // no-op once the handle's debit has started or succeeded (or once a
  // refund already has) — settlement can simply call it unconditionally
  // whenever a ledger handle exists, rather than pre-checking a `debited`
  // flag itself. A reservation that was never debited is ALWAYS refunded on
  // settlement, regardless of `outcome` — a preparation refusal or proven
  // pre-spawn exit never reaches the debit point (immediately before
  // dispatch, in the D2 dispatch-commit hook), so this is the one place
  // every such path already calls that can return it. Once debited,
  // settlement never touches the ledger again (a dispatched attempt —
  // including a spawn failure or canary — stays charged no matter how it
  // concludes).
  const refund = admission?.ledger
    ? refundDirectWorkerAllowance(admission.ledger).then(() => null, (error) => `allowance refund failed: ${error?.message ?? String(error)}`)
      // #2915 round 8 review 8 (C9): a correction's own charge/refund
      // failure was previously visible ONLY by inspecting the handle's own
      // `correctionChargeDiagnostic`/`correctionRefundDiagnostic` fields --
      // nothing read them. Fold them into the SAME settlement diagnostic
      // `launchOneWorker`/`planDirectWorkerLaunch` already thread onto the
      // thrown error or returned result as `ledgerDiagnostics`.
      .then((diagnostic) => {
        const correctionDiagnostics = [admission.ledger.correctionChargeDiagnostic, admission.ledger.correctionRefundDiagnostic].filter(Boolean);
        return correctionDiagnostics.length ? [diagnostic, ...correctionDiagnostics].filter(Boolean).join('; ') : diagnostic;
      })
    : Promise.resolve(null);
  if (!admission?.gated || !admission.token) return refund;
  // #2915 round 8: callers that construct and consume the D2 dispatch-commit
  // hook (`launchOneWorker`'s attached path, `planDirectWorkerLaunch`'s
  // borrowed/standalone branches) call `abortDispatch` THEMSELVES on a hook
  // failure — never here. `settleDirectWorker` always finalizes with the
  // caller's own reported `outcome` through the ordinary `settle()`, exactly
  // as before: every existing proven-pre-spawn-refusal call site already
  // reports `{ kind: 'uncertain', confirmedStop: true }`, which `settle()`
  // handles identically to `abortDispatch` (itself defined in terms of it).
  try { admission.breaker.settle(admission.token, outcome); } catch { /* recovery accounting must never fail a launch */ }
  recoveryTransitionSubscriptions.get(admission)?.();
  recoveryTransitionSubscriptions.delete(admission);
  return refund;
}

/**
 * Build the `settleDirectWorker` outcome for a launcher-observed direct
 * attempt result, from the evidence-contract `result.attemptOutcome`
 * (#2915 evidence contract — NEVER `result.termination`, which a degraded
 * or MCP attempt can never confirm even on genuine success). A `'failed'`
 * outcome attributes through the same launcher-only evidence
 * `classifyLaunchOutcomeForRecovery` always used, so post-spawn task
 * failures stay invocation-scoped unless independent launcher observations
 * attest a qualified endpoint outage or a corroborated native host fault.
 * Worker claims never widen scope.
 *
 * `confirmedStop` (#2915 review 5, "a second worker over unresolved
 * execution") is a SEPARATE fact from `kind`: whether THIS attempt's own
 * descendant tree is launcher-confirmed stopped (`result.termination ===
 * 'confirmed'`), independent of whether the attempt succeeded or failed.
 * `ScopedFailureBreaker.settle()` reads it only when this settlement
 * arrives against a reservation whose own canary deadline already passed
 * unresolved — it resolves that reservation's bounded blocking marker, never
 * the ordinary success/failure transition. A degraded-isolation attempt can
 * never confirm descendant termination (`captureOneWorker`'s own `confirmed`
 * computation), so its marker — if any — stays blocking until some other
 * owned isolation evidence resolves it.
 */
export function classifyAttemptForSettlement(invocation, result, { quotaAccount = null, installationQualifier = null } = {}) {
  const kind = result?.attemptOutcome ?? 'uncertain';
  const confirmedStop = result?.termination === 'confirmed';
  if (kind !== 'failed') return { kind, confirmedStop };
  const selected = invocation?.selected ?? {};
  const evidence = classifyLaunchOutcomeForRecovery(result);
  return { kind, confirmedStop, ...evidence, cli: selected.cli ?? null,
    inferenceProvider: selected.inferenceProvider ?? null, quotaAccount, installationQualifier };
}

// #2915 round 8 (D6, "lazy public fields still differ after mixed use"):
// `lastAttemptResult`/`lastAttemptInvocationId` are informational
// bookkeeping only (#2915 step 4 — the retry gate no longer reads them;
// see `launchWorker`'s `options.retryOf`, verified fresh against disk
// evidence on every call) that origin/main's `SessionLauncher` never had
// as instance fields at all. Keeping them as `this.*` assignments in the
// constructor (even initialized to `null`) made `Object.keys(new
// SessionLauncher())` differ from origin/main unconditionally, and a
// gated launch followed by a not-gated one on the SAME instance left the
// gated launch's own values sitting on an instance a not-gated-only
// caller would otherwise see as untouched. Keyed by instance in this
// module-private `WeakMap` instead, surfaced through plain accessor
// properties on the prototype (never an own, enumerable instance
// property) so every existing reader/writer (`owner.lastAttemptResult =
// result` inside `launchOneWorker`, every test that reads
// `launcher.lastAttemptResult`) keeps working unchanged, while
// `Object.keys()`/`JSON.stringify()`/`for...in` on the instance see
// exactly origin/main's three fields.
const lastAttemptState = new WeakMap();

export class SessionLauncher extends EventEmitter {
  constructor() {
    super();
    this.currentProcess = null;
    this.startTime = null;
    /** @type {import('./lib/provider-adapter.mjs').ProviderAdapter|null} */
    this.providerAdapter = null;
  }

  /** Informational-only; see the `lastAttemptState` WeakMap doc comment above. */
  get lastAttemptResult() { return lastAttemptState.get(this)?.result ?? null; }

  set lastAttemptResult(value) {
    lastAttemptState.set(this, { ...lastAttemptState.get(this), result: value });
  }

  /** Informational-only; see the `lastAttemptState` WeakMap doc comment above. */
  get lastAttemptInvocationId() { return lastAttemptState.get(this)?.invocationId ?? null; }

  set lastAttemptInvocationId(value) {
    lastAttemptState.set(this, { ...lastAttemptState.get(this), invocationId: value });
  }

  /**
   * Set the provider adapter for CLI abstraction
   * @param {import('./lib/provider-adapter.mjs').ProviderAdapter} adapter
   */
  setProviderAdapter(adapter) {
    this.providerAdapter = adapter;
  }

  /**
   * Attached direct attempt; no Ralph state, monitor constructor, retry or legacy args.
   *
   * Stop-before-retry is MANDATORY, not opt-in (#2915B). #2915 step 4
   * DELETED the path-pair (`invocationPath`+`runDir` equality) inference,
   * `afterAttempt` (caller-asserted evidence) and `freshAttempt` (an
   * unauthenticated bypass of the whole gate) entirely. A retry is now
   * conductor-DECLARED, never inferred: `options.retryOf = { invocationId,
   * runDir }` names the previous attempt explicitly. Omission means
   * UNRELATED work and is never refused for retry reasons, no matter what
   * path coincidence exists (#2915 review: an unrelated sequential launch
   * on the same launcher was being refused as if it were a retry). When
   * supplied, `verifyRetryPredecessor` reads the predecessor's OWN
   * launcher-written, privately-owned evidence directly from disk — never
   * a caller-supplied claim — and refuses on anything missing, unreadable,
   * identity-mismatched, or not CONFIRMED terminal.
   *
   * `options.correctStartup: { reasonCode, correctionsUsed }` enforces the
   * one-qualified-startup-correction budget on a conductor-declared
   * correction retry (startupCorrectionGate): unqualified causes and second
   * corrections are refused, within the task's existing allowance. There is
   * no automatic correction loop.
   *
   * Both checks are gated recovery behavior, not a general launch
   * precondition: enforcement happens entirely INSIDE `launchOneWorker`,
   * after admission has determined whether recovery is actually gated for
   * this attempt (global `worker_dispatch` AND per-CLI enablement — see
   * `admitDirectWorker`). Retry-predecessor verification runs there every
   * time `options.retryOf` is supplied, same as any other run; the
   * correction-budget check there only runs once a real ledger exists
   * (`admission.ledger`), never against a caller-supplied `correctionsUsed`.
   * `launchWorker` itself must never pre-empt either refusal before a plan
   * is even loaded — a prior round's early, UNGATED `correctStartup` check
   * here refused calls origin/main would have let through unmodified, since
   * neither option exists on origin/main at all (#2915 review 5, "changed
   * disabled behavior"). Stop-before-retry is MANDATORY regardless of
   * `worker_dispatch`, by design (#2915B) — it is a distinct, always-on
   * safety control, not part of the opt-in scoped-failure-breaker feature
   * the dispatch switch gates.
   */
  async launchWorker(options) {
    if (this.currentProcess || this.workerLaunchPending) throw new Error('A worker is already attached to this launcher');
    this.workerLaunchPending = true;
    // Informational-only `lastAttemptResult`/`lastAttemptInvocationId`
    // bookkeeping (no longer consulted by the retry gate, which is now
    // `options.retryOf`-driven and disk-verified every time) is set inside
    // `launchOneWorker` itself, gated on whether recovery actually admitted
    // this attempt (#2915 review 6, finding 6) — never here unconditionally.
    try { return await launchOneWorker(this, options); }
    finally {
      _workerRecoverySubscriptions.get(this)?.();
      _workerRecoverySubscriptions.delete(this);
      this.workerLaunchPending = false;
    }
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
      // A failed write destroys the stream at once, but WriteStream emits
      // 'error' only after its async fd close, so wait for 'close' (which
      // follows both 'finish' and 'error') rather than returning early on
      // `destroyed`; otherwise launch() can resolve before captureError lands.
      const finalizeCaptureStream = stream => new Promise(res => {
        if (stream.closed) { res(); return; }
        stream.once('close', res);
        if (!stream.destroyed && !stream.writableEnded) stream.end();
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
        env: buildSessionEnvironment(this.providerAdapter?.getName() ?? 'claude', envOverrides),
      });

      const child = this.currentProcess;
      const terminate = (signal) => { try { if (isOmp && process.platform !== 'win32') { if (isSafeWorkerGroupTarget(child.pid)) process.kill(-child.pid, signal); } else signalChild(child, signal); } catch { /* process already exited */ } };

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
          captureError ??= stdoutStream.errored ?? stderrStream.errored;
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
        if (!isSafeWorkerGroupTarget(child.pid)) return;
        try { process.kill(-child.pid, signal); } catch { /* already exited */ }
        const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null && isSafeWorkerGroupTarget(child.pid)) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } } }, 500);
        timer.unref();
      } else signalChild(this.currentProcess, signal);
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
      env: workerVersionProbeEnvironment(),
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
      env: workerVersionProbeEnvironment(),
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
 * Standalone ownership observer. Attached and detached launches share the
 * admission clock and absolute deadline; child completion cannot disarm an
 * unresolved unit's deadline. At the bound, attempt an isolation-specific
 * stop, then retain ownership unless terminal unit evidence confirms it.
 */
export function observeStandaloneUnitSettlement(unit, admission, {
  pollIntervalMs = 2000, boundMs = 300_000, getStatus = getWorkerIsolationStatus, stopUnit = stopWorkerUnit,
  nowMs = () => admission.breaker?.nowMs?.() ?? performance.now(), deadlineAtMs = nowMs() + boundMs,
  child = null, isolationMode = 'systemd-unit', terminateChild = terminateChildWithGrace,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = timer => clearTimeout(timer),
  unrefTimer = timer => timer?.unref?.(),
} = {}) {
  let timer;
  let confirmed = false;
  let stopStarted = false;
  let childObserved = false;
  const invocationId = admission.token?.invocationId ?? admission.invocationId;
  const settleObserved = async (status, stopFirst) => {
    const evidence = await resolveStopEvidence({ isolationMode, unitName: unit, child, terminateChild,
      getStatus: status ? () => status : getStatus, stopUnit, stopFirst });
    await settleDirectWorker(admission, { kind: 'uncertain', confirmedStop: evidence.confirmedStop });
    if (evidence.confirmedStop) {
      confirmed = true;
      clearTimer(timer);
      admission.breaker?.reconcileStopEvidence?.({ invocationId, confirmedStop: true });
    } else if (stopFirst && isolationMode === 'systemd-unit') {
      // Bounded late observations; exhaustion leaves the marker available
      // to explicit operator reconciliation, never releases it by age.
      observeLateStopEvidence(async () => {
        const later = await resolveStopEvidence({ isolationMode, unitName: unit, getStatus, stopFirst: false });
        if (later.confirmedStop) admission.breaker?.reconcileStopEvidence?.({ invocationId, confirmedStop: true });
        return later.confirmedStop;
      }, { pollIntervalMs, setTimer, unrefTimer });
    }
  };
  const schedule = () => {
    const remaining = Math.max(0, deadlineAtMs - nowMs());
    timer = setTimer(poll, isolationMode === 'systemd-unit' ? Math.min(pollIntervalMs, remaining) : remaining);
    unrefTimer(timer);
  };
  const stopAtDeadline = () => {
    if (nowMs() < deadlineAtMs) return false;
    stopStarted = true;
    settleObserved(null, true).catch(() => {});
    return true;
  };
  const poll = () => {
    if (confirmed || stopStarted || stopAtDeadline()) return;
    let status = null;
    if (isolationMode === 'systemd-unit') {
      try { status = getStatus(unit); } catch { /* unavailable evidence retains ownership */ }
    }
    if (stopAtDeadline()) return;
    if (status?.active === false && [1, 2, 3].includes(status.execMainCode)) {
      settleObserved(status, false).catch(() => {});
      return;
    }
    schedule();
  };
  if (child && typeof child.once === 'function') {
    const observe = () => {
      if (childObserved || confirmed) return;
      childObserved = true;
      settleObserved(null, false).catch(() => {});
    };
    child.once('exit', observe);
    child.once('error', observe);
    schedule();
  } else {
    poll();
  }
}

/** Three delayed observations, then explicit reconciliation owns any remainder. */
export function observeLateStopEvidence(observe, {
  pollIntervalMs = 2000, setTimer = (fn, ms) => setTimeout(fn, ms), unrefTimer = timer => timer?.unref?.(),
} = {}) {
  let remaining = 3;
  let timer;
  let cancelled = false;
  const schedule = () => {
    if (cancelled || remaining-- <= 0) return;
    timer = setTimer(async () => {
      if (cancelled) return;
      let confirmed = false;
      try { confirmed = await observe(); } catch { /* retain unresolved ownership */ }
      if (!confirmed) schedule();
    }, pollIntervalMs);
    unrefTimer(timer);
  };
  schedule();
  return () => { cancelled = true; clearTimeout(timer); };
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
 *   dispatch gate's typed failures and never reaches a spawn call. A
 *   recovery-scope refusal (`#2915`) returns `blocked: true` with
 *   `recoveryBlocked` (covering scope keys) and a `diagnostic`, and likewise
 *   never spawns.
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
  // #2915A: scoped-breaker consultation for this dispatch. Defaults to the
  // process-shared direct-recovery breaker; `null` disables the gate for
  // callers that own recovery themselves. Flat-option callers without a
  // resolved invocation have no trusted identities, so the gate is skipped
  // for them (never defaulted to a shared scope).
  scopedBreaker,
  recoveryScopeKeys,
  // #2915 final (one admission, step 3): a caller that already called
  // `admitDirectWorker` itself (the MCP `run()` bridge, so its own
  // try/finally owns settlement end-to-end) passes the resulting admission
  // here. The planner then BORROWS it — it neither re-admits nor settles —
  // instead of re-gating and potentially rejecting its own already-admitted
  // canary (#2915 final review, finding 4: "MCP shell dispatch consults the
  // breaker again... blocked, zero spawns, reservation still active").
  admission: borrowedAdmission,
  invocationId,
  // #2915 review 4 (finding 7): forwarded to `admitDirectWorker` for the
  // STANDALONE admission path below, so a driver's `canVerifyAttempt:
  // false` (Warp, Copilot — adapters that can never report a verified
  // success) actually reaches this planner instead of being silently lost
  // to a hardcoded `drivers: {}`. Omitted (the common case: most standalone
  // callers have no resolved driver map at all) never defaults to eligible
  // OR ineligible — `admitDirectWorker` simply has nothing to check, same
  // as before.
  drivers,
  // #2915 review 6 (finding 3, "MCP and standalone planner never debit"):
  // forwarded to `admitDirectWorker` for the STANDALONE admission path
  // below so a resolvable task chain gets ledger allowance identity/
  // enforcement too — a borrowed admission already carries these from its
  // own caller's `admitDirectWorker` call and never re-resolves them here.
  taskChainDigest,
  onRecoveryTransition,
  maxAttempts,
  captureRoot,
  // Test-only isolation observation/stop seams for standalone launches.
  // Production uses the native unit query and bounded isolation stop.
  isolationStatus,
  unitSettlementPollMs,
  unitSettlementBoundMs,
  stopUnit,
  terminateChild,
  // #2915 round 8 review 8 (C3): optional `{ deadlineAtMs, nowMs,
  // isCancelled }`, forwarded into both the borrowed and the standalone
  // dispatch-commit hook below — see `checkDispatchGuard`'s own doc
  // comment. Omitted by every existing caller today.
  dispatchGuard,
} = {}) {
  if (invocation?.stdin === 'brief-json' && stdinPath === undefined) {
    throw new Error('brief-json stdin requires an explicit conductor-framed params file (stdinPath)');
  }
  // #2915 final (step 6, compatibility): the dispatch switch is consulted
  // FIRST, and legacy behaviour (`worker_dispatch` off, or the resource gate
  // itself refusing) returns SYNCHRONOUSLY — this function is deliberately
  // NOT declared `async` so neither path ever manufactures a Promise where
  // none existed before #2915 (#2915 final review, finding 1: "the planner
  // now returns a Promise even when off; existing production callers await
  // it" — literal API equivalence requires the disabled/resource-refused
  // path to match pre-#2915 byte-for-byte, Promise-wrapping included). Free
  // disk is sampled on the worktree filesystem the worker will actually
  // write to — never the conductor's process cwd. Without live signals or
  // caller-supplied paths, an unknown worktree fails closed in the gate.
  const gate = checkWorkerDispatch({
    config, live, readers, thresholdOverlay,
    paths: paths ?? (typeof cwd === 'string' && cwd ? [cwd] : undefined),
  });
  if (!gate.ok) return { launched: false, blocked: true, failures: gate.failures ?? [], gate };
  // `onDispatchCommit` (#2915 round 8, D2) is OPTIONAL and omitted entirely
  // for the not-gated/disabled-CLI paths below, which must stay
  // synchronous and byte-for-byte legacy — passing `undefined` through to
  // `launchIsolatedWorker` is the dual-mode contract that keeps it so.
  let dispatchAttempt;
  const launch = (onDispatchCommit) => launchIsolatedWorker({ name, memoryMaxGb, command, args, cwd, logFile, stdinPath, stdoutPath, stderrPath,
    gate, config, allowDegraded, attached, ownedGroup,
    onSpawnAttempt: onDispatchCommit ? value => { dispatchAttempt = value; onSpawnAttempt?.(value); } : onSpawnAttempt,
    ...(envNames !== undefined ? { envNames } : {}), ...(env !== undefined ? { env } : {}),
    ...(isolation !== undefined ? { isolation } : {}), ...(spawn !== undefined ? { spawn } : {}),
    ...(spawnAsync !== undefined ? { spawnAsync } : {}), ...(proposeUnit !== undefined ? { proposeUnit } : {}),
    ...(kind !== undefined ? { kind } : {}), ...(stdin !== undefined ? { stdin } : {}),
    ...(onDispatchCommit ? { onDispatchCommit } : {}) });
  if (!gate.enabled) return launch(); // not-gated: synchronous, byte-for-byte legacy behaviour
  // #2915 review 4 (finding 7): per-CLI disablement is ALSO checked
  // synchronously, before any admission (borrowed or standalone) — a
  // disabled CLI must stay exactly as inert as the global switch being
  // off: synchronous, and the returned result carries no `admission`
  // field at all (the former code only special-cased the global switch,
  // so a per-CLI-disabled standalone call still went through the async
  // admission branch and attached `admission` to its result).
  if (invocation?.selected?.cli && config?.parallelism?.clis?.[invocation.selected.cli]?.enabled === false) {
    return launch();
  }
  if (borrowedAdmission !== undefined) {
    // #2915 review 5 (finding 4), hardened by #2915 review 6 (finding 1,
    // "unauthenticated/reused authority"): the borrowed admission must be a
    // value `admitDirectWorker` itself returned -- never a caller-
    // fabricated stand-in -- and may authorize at most ONE launch. A
    // genuine admission is either exactly `{ gated: false }` (not gated), a
    // refusal (`{ gated: true, refused: {...} }`), or a successful one
    // carrying both `token` and a REAL `ScopedFailureBreaker` instance (the
    // exact objects `admit()` minted) -- never anything else. `instanceof
    // ScopedFailureBreaker` (rather than duck-typing `breaker.settle` as a
    // function) is what actually closes the fabrication gap: a plain
    // `{ settle(){} }` stand-in satisfied the old duck-typed shape check and
    // then dispatched with zero real breaker protection.
    if (borrowedAdmission === null || typeof borrowedAdmission !== 'object' || typeof borrowedAdmission.gated !== 'boolean'
      || (borrowedAdmission.gated && !borrowedAdmission.refused && (!borrowedAdmission.token || !(borrowedAdmission.breaker instanceof ScopedFailureBreaker)))) {
      throw new Error('Borrowed admission is not a value admitDirectWorker returned; refusing to dispatch on unauthenticated authority');
    }
    // A `gated: false` CLAIM is never trusted on its own: by the time this
    // branch runs, the planner's OWN dispatch/eligibility checks above
    // (`gate.enabled`, per-CLI disablement) have already determined gating
    // IS active for this dispatch -- a borrowed admission claiming
    // `gated: false` here contradicts that and is refused rather than
    // honored as a free bypass. Only the launcher's own checks decide
    // not-gated-ness; a caller cannot assert it after the fact.
    if (!borrowedAdmission.gated) {
      throw new Error('Borrowed admission claims not-gated while this dispatch is gated; refusing to dispatch on unauthenticated authority');
    }
    // Borrowed: never re-admit, never settle — the outer caller's own
    // try/finally owns settlement of this exact admission end-to-end.
    if (borrowedAdmission.refused) {
      return { launched: false, blocked: true, recoveryBlocked: borrowedAdmission.refused.blockedBy,
        diagnostic: `recovery scope open: ${borrowedAdmission.refused.blockedBy.join(', ')}` };
    }
    // #2915 round 8 (D2/D3, replaces the former synchronous `claimLaunch`
    // call and its paired mutable-wrapper-field pre-checks): identity,
    // single-use consumption and the deadline are now ALL authenticated by
    // `beginDispatch` itself, inside the dispatch-commit hook, against the
    // breaker's own FROZEN token fields — never against this borrowed
    // wrapper object's own `invocationId`/`selectionDigest` copies (#2915
    // round 8 critique: "stored identity is only useful if compared against
    // the actual launch"; a caller that deletes or rewrites those copies on
    // the wrapper can no longer bypass anything, because they are never
    // what gets compared). Comparison values are derived HERE from this
    // exact call's own trusted, resolved `invocation`/`invocationId` —
    // falling back to the borrowed wrapper's own copies only when this call
    // was given no fresher identity to derive them from.
    //
    // #2915 round 8 review 8 (C6): NEVER falls back to the borrowed
    // wrapper's own `invocationId`/`selectionDigest` copies. Those are
    // whatever the wrapper's own caller claims, not an identity THIS call
    // independently resolved — a borrowed-dispatch caller that omits a
    // fresher `invocationId` gets refused, not silently authorized to
    // dispatch under the wrapper's identity. `selectionDigest` is derived
    // ONLY from this call's own trusted, resolved `invocation` (never from
    // the wrapper either); `selectionDigestFor(invocation)` legitimately
    // returns `null` when this call has no resolved selection identity to
    // bind, which `beginDispatch` accepts as long as it matches the
    // reservation's own stored binding.
    if (invocationId == null) {
      throw new Error('Borrowed admission requires an explicit, independently resolved invocationId; refusing to derive dispatch identity from the borrowed wrapper');
    }
    const resolvedInvocationId = invocationId;
    const resolvedSelectionDigest = selectionDigestFor(invocation);
    const onDispatchCommit = async () => {
      const began = borrowedAdmission.breaker.beginDispatch(borrowedAdmission.token,
        { invocationId: resolvedInvocationId, selectionDigest: resolvedSelectionDigest });
      if (!began.ok) {
        throw new Error(`Borrowed admission is not a live, unclaimed reservation on its breaker; refusing to dispatch on unauthenticated authority (${began.reason})`);
      }
      try {
        checkDispatchGuard(dispatchGuard);
        if (borrowedAdmission.ledger) await debitDirectWorkerAllowance(borrowedAdmission.ledger);
        checkDispatchGuard(dispatchGuard);
      } catch (error) {
        try { borrowedAdmission.breaker.abortDispatch(borrowedAdmission.token, { callerAborted: dispatchGuard?.isCancelled?.() === true }); } catch { /* best-effort */ }
        throw error;
      }
      const committed = borrowedAdmission.breaker.commitDispatch(borrowedAdmission.token);
      if (!committed.ok) {
        try { borrowedAdmission.breaker.abortDispatch(borrowedAdmission.token, { callerAborted: dispatchGuard?.isCancelled?.() === true }); } catch { /* best-effort */ }
        throw new Error(`Worker dispatch refused: ${committed.reason}`);
      }
    };
    return launch(onDispatchCommit);
  }
  // #2915 round 8 (D6): the COMPLETE eligibility decision — adding
  // `canVerifyAttempt` and the explicit breaker override to the
  // `gate.enabled`/per-CLI checks already made above — decided HERE,
  // synchronously, at the Standalone branch's own earliest point, using
  // the exact SAME `directRecoveryEligibility` predicate
  // `admitDirectWorker` below would otherwise independently re-derive.
  // Not gated: return the synchronous, base-shaped `launch()` result
  // directly, exactly like the `!gate.enabled`/per-CLI branches above —
  // never enter the admission IIFE at all.
  //
  // This also closes a real defect the predicate's extraction surfaced:
  // without this check, a standalone call with `scopedBreaker: null` (or
  // a driver whose `canVerifyAttempt` is `false`) reached the admission
  // IIFE below, `admitDirectWorker` correctly returned `{ gated: false }`
  // for it, and execution fell through to the un-guarded
  // `onDispatchCommit` closure that unconditionally calls
  // `admission.breaker.beginDispatch(...)` — `admission.breaker` is
  // `undefined` on a not-gated admission, so any caller actually hitting
  // either condition crashed with a `TypeError` at dispatch time instead
  // of launching, exactly the kind of divergence `directRecoveryEligibility`
  // exists to make impossible by construction.
  const standaloneEligibility = directRecoveryEligibility({ gateEnabled: gate.enabled, config, invocation,
    drivers: drivers ?? {}, scopedBreaker });
  if (!standaloneEligibility.gated) return launch(); // not-gated: synchronous, byte-for-byte legacy behaviour
  // Standalone: the planner performs its own admission. It settles LOCALLY
  // only on a pre-spawn refusal/exception (no observer exists to report a
  // post-spawn outcome back here); a successful launch returns its
  // `admission` so a caller that wants to track completion can call
  // `settleDirectWorker` itself once the attempt concludes (#2915 final
  // review: "standalone planner launches explicitly transfer settlement
  // responsibility to their bounded observer; pre-spawn exits settle
  // locally").
  return (async () => {
    const mintedInvocationId = invocationId ?? randomUUID();
    let admission;
    try {
      // `recoveryScopeKeys` (legacy flat-option override) is intentionally
      // not consulted: `admitDirectWorker` derives covering keys from the
      // trusted resolved `invocation` only, or skips the gate entirely for
      // flat-option callers with no resolved invocation (never defaulted to
      // a shared scope).
      admission = await admitDirectWorker({ gateEnabled: gate.enabled, config, invocation,
        invocationId: mintedInvocationId, scopedBreaker, drivers: drivers ?? {},
        taskChainDigest, maxAttempts, captureRoot, dispatchGuard, onTransition: onRecoveryTransition });
    } catch (error) {
      return { launched: false, blocked: true,
        diagnostic: `recovery admission failed closed: ${error?.message ?? String(error)}` };
    }
    if (admission.refused) {
      return { launched: false, blocked: true, recoveryBlocked: admission.refused.blockedBy,
        diagnostic: `recovery scope open: ${admission.refused.blockedBy.join(', ')}${admission.refused.reason ? `; ${admission.refused.reason}` : ''}`,
        probeDiagnostic: admission.refused.probeDiagnostic };
    }
    // #2915 round 8 (D2/D3, replaces the former "debit immediately before
    // this call" comment): the hook below is passed to
    // `launchIsolatedWorker`, which invokes it AFTER its own preparation
    // checks and immediately before the real process-start call — never
    // here, before even the resource/isolation checks `launch()` itself
    // still has to run. `beginDispatch`/`commitDispatch` consume this
    // reservation's own launch authority exactly once, at that same leaf
    // boundary (#2915 round 8, D3).
    const deadlineClockNow = dispatchGuard?.nowMs ?? (() => admission.breaker.nowMs());
    const admittedAtMs = deadlineClockNow();
    const deadlineAtMs = Math.min(dispatchGuard?.deadlineAtMs ?? Infinity, admission.token.deadlineMs,
      admittedAtMs + (unitSettlementBoundMs ?? 300_000),
      admittedAtMs + Math.min(invocation?.health?.hardTimeoutSeconds ?? Infinity, invocation?.limits?.wallSeconds ?? Infinity) * 1000);
    const standaloneGuard = { ...dispatchGuard, deadlineAtMs, nowMs: deadlineClockNow };
    const onDispatchCommit = async () => {
      const began = admission.breaker.beginDispatch(admission.token,
        { invocationId: admission.invocationId, selectionDigest: admission.selectionDigest });
      if (!began.ok) throw new Error(`Worker dispatch refused: ${began.reason}`);
      try {
        checkDispatchGuard(standaloneGuard);
        if (admission.ledger) await debitDirectWorkerAllowance(admission.ledger);
        checkDispatchGuard(standaloneGuard);
      } catch (error) {
        try { admission.breaker.abortDispatch(admission.token, { callerAborted: dispatchGuard?.isCancelled?.() === true }); } catch { /* best-effort */ }
        throw error;
      }
      const committed = admission.breaker.commitDispatch(admission.token);
      if (!committed.ok) {
        try { admission.breaker.abortDispatch(admission.token, { callerAborted: dispatchGuard?.isCancelled?.() === true }); } catch { /* best-effort */ }
        throw new Error(`Worker dispatch refused: ${committed.reason}`);
      }
    };
    let result;
    try {
      result = await launch(onDispatchCommit);
    } catch (error) {
      // #2915 round 8 review 8 (C10): awaited, never fired-and-forgotten —
      // a refund failure must reach the caller instead of being silently
      // discarded (mirroring `launchOneWorker`'s own `settleLedger`).
      const diagnostic = await settleDirectWorker(admission, { kind: 'uncertain' });
      if (dispatchAttempt?.mode === 'systemd-unit' && dispatchAttempt.unit) {
        observeStandaloneUnitSettlement(dispatchAttempt.unit, admission, {
          isolationMode: dispatchAttempt.mode, getStatus: isolationStatus, stopUnit,
          pollIntervalMs: unitSettlementPollMs, deadlineAtMs, nowMs: deadlineClockNow,
        });
      }
      if (diagnostic) error.ledgerDiagnostics = [...(error.ledgerDiagnostics ?? []), diagnostic];
      throw error;
    }
    if (!result?.launched) {
      const diagnostic = await settleDirectWorker(admission, { kind: 'uncertain' });
      // A failed submission can leave a live owned unit. Keep its deadline
      // and stop observer even though no successful launch was returned.
      if (result?.dispatchState === 'submission-uncertain' && result.unit) {
        observeStandaloneUnitSettlement(result.unit, admission, {
          isolationMode: result.mode, getStatus: isolationStatus, stopUnit,
          pollIntervalMs: unitSettlementPollMs, deadlineAtMs, nowMs: deadlineClockNow,
        });
      }
      return diagnostic ? { ...result, ledgerDiagnostics: [...(result.ledgerDiagnostics ?? []), diagnostic] } : result;
    }
    observeStandaloneUnitSettlement(result.unit ?? null, admission, {
      child: result.child, isolationMode: result.mode, getStatus: isolationStatus, stopUnit, terminateChild,
      pollIntervalMs: unitSettlementPollMs, deadlineAtMs, nowMs: deadlineClockNow,
    });
    return { ...result, admission };
  })();
}

export default SessionLauncher;
