/**
 * Worker process isolation for Tier 0 direct dispatch (FR-OG-108, #2954).
 *
 * Direct workers default to a separate cgroup: on the titan host an oomd
 * kill of one shared cgroup took the conductor session with it. Explicit
 * native-sandbox policy instead uses an owned process group and the CLI's
 * sandbox, without a cgroup memory limit or descendant kill scope.
 * This module builds `systemd-run --user` launch arguments (own unit or
 * scope with `MemoryMax` and `MemorySwapMax=0`, PATH/HOME passthrough,
 * stdin `/dev/null`) and, where no systemd user manager exists, returns an
 * explicit DEGRADED diagnostic instead of silently launching unconfined.
 *
 * Pure argument construction is fully unit-tested with synthetic inputs. The
 * single integration test executes a real `systemd-run --user` only when a
 * user manager is reachable and skips otherwise. No worker is ever launched
 * by importing this module.
 *
 * Callers (conductors, bridges, future #2888 templates) use this flow:
 *
 * ```js
 * import { checkWorkerDispatch } from '../../../scripts/resource-preflight.mjs';
 * import { detectWorkerIsolation, launchIsolatedWorker } from './worker-isolation.mjs';
 *
 * const gate = checkWorkerDispatch({ config });
 * // Over threshold -> queue, pick another qualified host, or reject. Never launch.
 * const outcome = launchIsolatedWorker({ name, memoryMaxGb, command, args, cwd, logFile, gate });
 * ```
 *
 * `prepareWorkerInvocation` (provider-adapter.mjs) deliberately stays
 * launch-free: it prepares and validates the descriptor, while the conductor
 * owns the gate-then-launch sequence above. No mandatory enforcement is
 * wired into #2887/#2888 internals by this change.
 */

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { constants, openSync, closeSync, writeFileSync, fsyncSync, renameSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { sampleWorkerIdentity, createWorkerIdentityCapture } from '../process-monitor.mjs';
import { checkWorkerDispatch } from '../../scripts/resource-preflight.mjs';
import { buildSystemdClientEnv, resolveSystemdClient, resolveSystemdRun, unitEnvironmentNames, isClientControlVariable } from './systemd-client.mjs';

import { assertAbsolute, proposeWorkerUnitName, detectWorkerIsolation, buildWorkerIsolationArgs, resolveManagerEnvNames } from './worker-isolation-args.mjs';
import { createWorkerUnitOwner } from './worker-unit-cleanup.mjs';
export { proposeWorkerUnitName, detectWorkerIsolation, buildWorkerIsolationArgs, resolveManagerEnvNames };
export { NATIVE_SANDBOX_UNAVAILABLE, workerNeedsNativeNamespaces, nativeSandboxFailure,
  nativeSandboxProbeMessage, probeWorkerNativeSandbox } from './worker-native-sandbox.mjs';

/**
 * Gate, then launch one worker in its own resource scope (FR-OG-107/108).
 *
 * - `gate` must be a `checkWorkerDispatch()` result. Missing results refuse
 *   launch. Explicit `gate: 'disabled'` requires worker_dispatch off in config.
 *   A failing gate returns
 *   `{ launched: false, blocked: true, failures }` and nothing launches.
 * - Without a reachable systemd user manager the result is an explicit
 *   `{ launched: false, mode: 'degraded', diagnostic }` unless the caller
 *   passes `allowDegraded: true`, which launches the command directly with
 *   stdin `/dev/null` and records the degraded mode for the qualification
 *   record. Degraded launches never claim isolation.
 * - Degraded launches return an async child/pid handle without a deadline.
 *   `spawn` (manager queries), `spawnAsync`, and `proposeUnit` are injectable.
 * - `attached: true` (#2892 B2) launches with live stdio pipes instead of
 *   file redirection/`/dev/null`, for callers (e.g. an in-process MCP stdio
 *   client) that need to read/write the worker's stdin/stdout directly
 *   rather than poll for termination afterward. Incompatible with
 *   `stdinPath`/`stdoutPath`/`stderrPath`/`logFile` (refused, not ignored).
 *   Degraded-attached returns the usual `{ mode: 'degraded', child }`; the
 *   confined path returns `{ mode: 'systemd-unit', child }` where `child` is
 *   the live `systemd-run --pipe --wait` process itself — its stdio IS the
 *   unit's stdio, and its own `close` event fires with the unit's exit code.
 */
/**
 * Run the real process-start call, optionally gated by the D2 dispatch-
 * commit hook (#2915 round 8). `spawnFn` performs the actual, otherwise
 * irreversible side effect (the `spawn`/`spawnAsync` call) and returns the
 * same result shape `launchIsolatedWorker` always returned.
 *
 * Dual-mode, deliberately: when `onDispatchCommit` is omitted (every
 * existing caller — direct production callers, every test in this repo
 * that constructs `launchIsolatedWorker` options itself), this returns
 * `spawnFn()`'s result DIRECTLY and synchronously — `launchIsolatedWorker`
 * is NOT declared `async`, and its sync return contract for every pre-D2
 * caller is completely unaffected; nothing here ever makes an existing
 * caller receive a Promise where it previously received a plain object.
 * Only when a caller supplies the hook (today: `session-launcher.mjs`'s own
 * gated launch paths) does this return a Promise, which that caller already
 * awaits.
 *
 * When the hook IS given, it runs immediately before `spawnFn()` — after
 * every preparation check `launchIsolatedWorker` performs for whichever
 * branch (degraded/systemd-unit, attached/non-attached) is actually taken.
 * If it throws, `spawnFn` is NEVER called — nothing starts — and the thrown
 * error is converted into the same `{ launched: false, blocked: true,
 * failures: [...] }` refusal shape every other pre-spawn refusal in this
 * module already uses, rather than propagating as a rejected promise: a
 * proven pre-spawn refusal is a RESULT here, consistent with the dispatch
 * gate and degraded-without-allowDegraded refusals above it.
 *
 * `onAbort` (#2915 round 8 review 8, C3 follow-up), when given, runs ONLY
 * on that same hook-throws path -- it exists so a caller that had to open
 * resources (e.g. the non-attached degraded path's stdio file descriptors)
 * BEFORE this call, so that opening them is itself part of "every
 * preparation check" the hook boundary assumes already ran, can release
 * them when the hook aborts the dispatch instead of leaking them.
 */
function _runDispatchCommit(onDispatchCommit, spawnFn, onAbort) {
  if (!onDispatchCommit) return spawnFn();
  return (async () => {
    try {
      await onDispatchCommit();
    } catch (error) {
      if (onAbort) { try { onAbort(); } catch { /* best-effort cleanup only */ } }
      return { launched: false, blocked: true,
        failures: [{ signal: 'dispatch-commit', reason: error?.message ?? String(error) }] };
    }
    return spawnFn();
  })();
}

export function launchIsolatedWorker({
  name = 'worker',
  memoryMaxGb,
  command,
  args = [],
  cwd,
  logFile,
  stdinPath,
  stdoutPath,
  stderrPath,
  env = process.env,
  envNames = ['PATH', 'HOME'],
  gate,
  config,
  allowDegraded = false,
  isolation,
  workerGroup,
  kind = 'unit',
  attached = false,
  spawn = spawnSync,
  spawnAsync = nodeSpawn,
  proposeUnit = proposeWorkerUnitName,
  stdin = 'closed',
  ownedGroup = false,
  onSpawnAttempt,
  runDir,
  // #2915 round 8 (D2): INTERNAL dispatch-commit hook — never documented as
  // a public launch option; only `session-launcher.mjs`'s own gated launch
  // paths (and, through `planDirectWorkerLaunch`'s borrowed-admission
  // branch, `src/mcp/tools/worker-invoke.mjs`'s two dispatch boundaries)
  // ever pass it. See `_runDispatchCommit`'s doc comment for the exact
  // contract and why every existing caller that omits it is byte-for-byte
  // unaffected.
  onDispatchCommit,
} = {}) {
  const resolvedGate = gate === 'disabled' && !config?.parallelism?.worker_dispatch
    ? checkWorkerDispatch({ config })
    : gate && typeof gate.ok === 'boolean' && typeof gate.enabled === 'boolean' ? gate : undefined;
  if (!resolvedGate || (config?.parallelism?.worker_dispatch && resolvedGate.enabled === false)) {
    return { launched: false, blocked: true, failures: [{ signal: 'gate', reason: 'worker launch requires a dispatch gate result; disabled is allowed only with worker_dispatch off' }] };
  }
  if (!resolvedGate.ok) {
    return { launched: false, blocked: true, failures: resolvedGate.failures ?? [], gate: resolvedGate };
  }
  const detected = isolation ?? detectWorkerIsolation({ spawn });
  const nativeSandbox = detected.mode === 'native-sandbox';
  if (nativeSandbox) {
    const execution = config?.parallelism?.groups?.[workerGroup]?.execution;
    if (execution?.launchMode !== 'native-sandbox' || !['read-only', 'workspace-write'].includes(execution.sandbox)
      || (execution.transport ?? 'shell') !== 'shell' || !attached || !ownedGroup) {
      throw Object.assign(new Error('native-sandbox requires policy opt-in and an owned attached process group with an enforcing native sandbox'),
        { code: 'OG_POLICY_RELAXATION' });
    }
  }
  if (detected.mode === 'degraded' && !allowDegraded) {
    return {
      launched: false,
      mode: 'degraded',
      diagnostic: `worker isolation unavailable: ${detected.reason}; pass allowDegraded:true to launch unconfined with stdin /dev/null (recorded as degraded)`,
      gate: resolvedGate,
    };
  }
  if (detected.mode === 'degraded' || nativeSandbox) {
    assertAbsolute('worker binary', command);
    if (cwd !== undefined) assertAbsolute('working directory', cwd);
    if (stdinPath !== undefined) assertAbsolute('stdin brief', stdinPath);
    if (stdoutPath !== undefined) assertAbsolute('stdout path', stdoutPath);
    if (stderrPath !== undefined) assertAbsolute('stderr path', stderrPath);
    if (!Array.isArray(args) || args.some(token => typeof token !== 'string' || token.includes('\0'))) {
      throw new Error('Worker isolation argv must be NUL-free strings');
    }
    // Process-group modes have no systemd unit to confine the environment, so this
    // module builds the allowlisted environment itself and passes it as the
    // child's *entire* environment (the `env` option replaces, never merges
    // with, the current process environment) — the functional equivalent of
    // `env -i NAME=value ...`. The conductor's own environment (secrets,
    // NODE_OPTIONS, etc.) is therefore never inherited, allowlisted or not.
    // This applies equally to the plain direct launch below and to the
    // attached transport wrapper, which receives this same allowedEnv as its
    // own process environment rather than the caller's raw `env`.
    const allowedEnv = {};
    for (const key of envNames) {
      const value = env?.[key];
      if (value !== undefined) allowedEnv[key] = value;
    }
    // #2892 F6: the transport-bootstrap refusal and the private wrapper
    // routing both apply to EVERY attached launch, with or without a
    // `runDir` — a caller that supplies no `runDir` (e.g. the MCP bridge,
    // which has no need for the wrapper's own identity/exit record files)
    // must still never spawn the worker directly with an unwrapped,
    // potentially bootstrap-altering environment. `runDir` only toggles
    // whether the wrapper is ALSO given `--run-dir`/`--invocation-id` to
    // write those record files; it never toggles whether the wrapper runs
    // at all.
    if (attached && envNames.some(isClientControlVariable)) {
      throw new Error('Worker environment cannot alter trusted transport bootstrap');
    }
    // Finish descriptor, argv and environment preparation before consuming
    // dispatch authority. Keep the no-hook path synchronous.
    const fds = [];
    const closePreparedFds = () => {
      for (const fd of fds) if (typeof fd === 'number') closeSync(fd);
    };
    let deferredClose = false;
    try {
      let launchCommand, launchArgs, launchOptions;
      if (attached) {
        launchCommand = process.execPath;
        launchArgs = [fileURLToPath(import.meta.url), '--worker-environment', JSON.stringify(envNames),
          ...(runDir ? ['--run-dir', runDir, '--invocation-id', name] : []), '--', command, ...args];
        launchOptions = { cwd, stdio: [stdin === 'closed' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          env: allowedEnv, ...(ownedGroup ? { detached: true } : {}) };
      } else {
        // Open every input/output before commit; a preparation failure never
        // consumes dispatch authority. Output truncation matches the renderer.
        const stdinFd = stdinPath !== undefined ? openSync(stdinPath, 'r') : 'ignore';
        fds.push(stdinFd);
        const stdoutFd = stdoutPath !== undefined ? openSync(stdoutPath, 'w') : 'pipe';
        fds.push(stdoutFd);
        const stderrFd = stderrPath !== undefined ? openSync(stderrPath, 'w') : 'pipe';
        fds.push(stderrFd);
        launchCommand = command;
        launchArgs = args;
        launchOptions = { cwd, env: allowedEnv, stdio: [stdinFd, stdoutFd, stderrFd], detached: ownedGroup };
      }
      const result = _runDispatchCommit(onDispatchCommit, () => {
        const child = spawnAsync(launchCommand, launchArgs, launchOptions);
        onSpawnAttempt?.({ mode: detected.mode, child, pid: child.pid });
        const outcome = {
          launched: Number.isInteger(child.pid) && child.pid > 0,
          mode: detected.mode, child, pid: child.pid,
          ownedGroup: ownedGroup === true,
          ...(attached ? { transportSupervisor: true } : {}),
          diagnostic: nativeSandbox ? 'Native CLI sandbox boundary; no cgroup resource confinement' : `launched without resource confinement: ${detected.reason}`,
          gate: resolvedGate,
        };
        // Preserve launch errors even when callers attach listeners later.
        child.once('error', error => { outcome.launched = false; outcome.error = error.message; });
        return outcome;
      });
      if (onDispatchCommit) {
        const pending = result.finally(closePreparedFds);
        deferredClose = true;
        return pending;
      }
      return result;
    } finally {
      // Numeric stdio descriptors are duplicated into the child. Close our
      // copies on every preparation, hook-refusal and spawn-error path.
      if (!deferredClose) closePreparedFds();
    }
  }
  // The unit path's security contract (see buildWorkerIsolationArgs' doc
  // comment) depends on knowing exactly which names the user manager would
  // otherwise inject, so it can unset every one of them that is not
  // allowlisted. Without a trustworthy answer to that query, launching would
  // either omit `UnsetEnvironment` (silently falling back to the padded,
  // non-exact environment this fix exists to remove) or guess — both are
  // refused in favor of an explicit failure.
  let managerEnvNames, systemdRun;
  try {
    managerEnvNames = resolveManagerEnvNames({ spawn });
    systemdRun = resolveSystemdRun();
  } catch (error) {
    return {
      launched: false,
      mode: 'systemd-unit',
      diagnostic: `unable to determine the user manager's inherited environment or resolve the trusted systemd-run client (required to isolate the worker's environment exactly): ${error.message}`,
      gate: resolvedGate,
    };
  }
  const unit = proposeUnit(name);
  const owner = createWorkerUnitOwner(unit, kind);
  // A private host-owned wrapper strips manager/client connection variables
  // before spawning the real worker. Environment values never enter argv.
  const wrapped = attached || kind === 'scope';
  const isolatedCommand = wrapped ? process.execPath : command;
  const isolatedArgs = wrapped ? [fileURLToPath(import.meta.url), '--worker-environment', JSON.stringify(unitEnvironmentNames(envNames)),
    ...(runDir ? ['--run-dir', runDir, '--invocation-id', name] : []), '--', command, ...args] : args;
  const argv = buildWorkerIsolationArgs({ unit, memoryMaxGb, command: isolatedCommand, args: isolatedArgs,
    cwd, logFile, stdinPath, stdoutPath, stderrPath, env, envNames, managerEnvNames, kind, attached, extraProperties: owner.properties });
  // #2915 round 8 (D2): same dispatch-commit boundary as the degraded path
  // above — every systemd-unit preparation check (gate, manager-environment
  // query, argv construction) has already run by this point.
  if (attached) {
    const launchArgs = argv.slice(1);
    const launchOptions = { cwd, env: buildSystemdClientEnv({ env, envNames }),
      stdio: [stdin === 'closed' ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: ownedGroup };
    return _runDispatchCommit(onDispatchCommit, () => {
      onSpawnAttempt?.({ mode: 'systemd-unit', unit });
      const child = spawnAsync(systemdRun, launchArgs, launchOptions);
      const outcome = { launched: Number.isInteger(child.pid) && child.pid > 0, mode: 'systemd-unit', unit, child, gate: resolvedGate };
      child.once('error', error => { outcome.launched = false; outcome.error = error.message; });
      return owner.track(outcome);
    });
  }
  const launchArgs = argv.slice(1);
  const launchOptions = { encoding: 'utf8', timeout: 30000, env: buildSystemdClientEnv({ env, envNames }) };
  return _runDispatchCommit(onDispatchCommit, () => {
    onSpawnAttempt?.({ mode: 'systemd-unit', unit });
    const child = spawn(systemdRun, launchArgs, launchOptions);
    if (child.error || child.status !== 0) {
      const stderr = String(child.stderr ?? '').trim();
      return owner.track({
        launched: false,
        mode: 'systemd-unit',
        unit,
        // #2915 round 8 review 8 (C2): a failed or timed-out `systemd-run`
        // submission does not PROVE the transient unit was never created
        // (e.g. a 30s wait timeout after the unit itself started) -- carry
        // this forward as dispatch-UNCERTAIN, never as "never began", so any
        // caller deriving stop evidence from this result (`resolveStopEvidence`'s
        // `dispatchState`) resolves to `unresolved`, never a confirmed stop.
        ...(onDispatchCommit ? { dispatchState: 'submission-uncertain' } : {}),
        diagnostic: `systemd-run launch failed: ${child.error?.message ?? stderr ?? `exit ${child.status}`}`,
        gate: resolvedGate,
      });
    }
    let pid;
    try {
      const shown = spawn(resolveSystemdClient('systemctl'), ['--user', 'show', '-p', 'MainPID', '--value', unit], { encoding: 'utf8', timeout: 10000, env: buildSystemdClientEnv({ envNames: [] }) });
      const parsed = Number(String(shown.stdout ?? '').trim());
      if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
    } catch {
      pid = undefined;
    }
    return owner.track({ launched: true, mode: 'systemd-unit', unit, pid, gate: resolvedGate });
  });
}

export { getWorkerIsolationStatus } from './worker-isolation-status.mjs';

/**
 * Request the unit's cgroup be torn down (`KillMode=control-group` is already
 * set at launch, so this kills the transport, the worker and any descendants
 * together). This is the actual stop authority for `systemd-unit` mode: a
 * PID/PGID signal may still be unresolved (identity races the unit's start),
 * while `systemctl --user stop` targets the unit by the name the launcher
 * already holds. It does not itself confirm anything — issuing the stop
 * request and having it take effect are different claims. Callers must
 * recheck `getWorkerIsolationStatus(unit)` afterward and treat an
 * unconfirmed stop as uncertain, never as a confirmed termination. Idempotent
 * on an already-stopped/unknown unit — `systemctl --user stop` on a unit
 * that no longer exists is not an error worth surfacing to the caller.
 */
export function stopWorkerUnit(unit, { spawn = spawnSync, timeoutMs = 10000 } = {}) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9:_.@-]+$/.test(unit)) {
    throw new Error('Worker isolation requires a unit-safe unit name');
  }
  const result = spawn(resolveSystemdClient('systemctl'), ['--user', 'stop', unit], { encoding: 'utf8', timeout: timeoutMs, env: buildSystemdClientEnv({ envNames: [] }) });
  return { ok: !result.error && result.status === 0,
    diagnostic: result.error ? result.error.message : String(result.stderr ?? '').trim() || null };
}

/**
 * SIGKILL every process in the unit's cgroup and return without waiting.
 * `stop` sends SIGTERM and then waits for the unit's stop timeout, which a
 * worker that ignores SIGTERM outlasts (#3691).
 */
export function killWorkerUnit(unit, { spawn = spawnSync, timeoutMs = 10000, signal = 'SIGKILL' } = {}) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9:_.@-]+$/.test(unit)) {
    throw new Error('Worker isolation requires a unit-safe unit name');
  }
  if (!/^SIG[A-Z0-9]+$/.test(signal)) throw new Error('Worker isolation requires a named signal');
  const result = spawn(resolveSystemdClient('systemctl'), ['--user', 'kill', '--kill-whom=all', `--signal=${signal}`, unit],
    { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', env: buildSystemdClientEnv({ envNames: [] }) });
  return { ok: !result.error && result.status === 0,
    diagnostic: result.error ? result.error.message : String(result.stderr ?? '').trim() || null };
}

export { readUnitControlGroup } from './worker-isolation-status.mjs';

export { checkWorkerDispatch };

/** Supervise the private transport's worker, with injectable kernel sampling. */
export function runWorkerTransport({ command, args, environment, record,
  spawn = nodeSpawn, sampleIdentity = sampleWorkerIdentity,
  now = () => Number(process.hrtime.bigint()) / 1e6,
  setExitCode = code => { process.exitCode = code; },
  propagateSignal = signal => process.kill(process.pid, signal) }) {
  record('worker-start.json', { supervisor: sampleIdentity(process.pid), worker: null });
  const worker = spawn(command, args, { env: environment, detached: true, stdio: 'inherit' });
  // We spawned this detached child: spawn waits through setsid/exec, so one owned leader sample suffices.
  const immediate = sampleIdentity(worker.pid);
  let identity = immediate?.pid === worker.pid && immediate?.pid === immediate?.pgid
    && immediate?.uid === process.getuid?.() && immediate?.parentPid === process.pid ? immediate : null;
  // Transport lifetime, rather than startup latency, bounds this capture.
  const capture = createWorkerIdentityCapture({ now, timeoutMs: Infinity });
  let identityTimer;
  let identityRecorded = false;
  const recordIdentity = () => {
    if (identityRecorded) return;
    identityRecorded = true;
    clearTimeout(identityTimer);
    record('worker-identity.json', { supervisor: sampleIdentity(process.pid), worker: identity,
      identityObservation: identity ? 'stable-owned-group' : 'no-stable-owned-group' });
  };
  const observeIdentity = (current = sampleIdentity(worker.pid)) => {
    identity ??= capture.observe(current);
    if (identity) recordIdentity();
    else identityTimer = setTimeout(observeIdentity, 5);
  };
  worker.once('error', error => {
    try {
      recordIdentity();
      record('worker-exit.json', { worker: identity, exitCode: null, signal: null, errorCode: error.code ?? 'SPAWN_ERROR', endedAt: new Date().toISOString() });
    } finally { setExitCode(127); }
  });
  worker.once('exit', (code, signal) => {
    // Bookkeeping must never replace the true wait status.
    try {
      recordIdentity();
      record('worker-exit.json', { worker: identity, exitCode: code, signal, errorCode: null, endedAt: new Date().toISOString() });
    } finally { if (signal) propagateSignal(signal); else setExitCode(code); }
  });
  observeIdentity(immediate);
  return worker;
}

// Private attached transport entry, never a public CLI or legacy Ralph route.
// The unit or launcher-owned process group owns this supervisor and worker.
// Only unit cgroup exit evidence covers descendants. The worker receives only allowed values.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--worker-environment') {
  process.umask(0o077);
  const names = JSON.parse(process.argv[3]);
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error('Invalid private worker environment');
  let commandOffset = 5;
  let runDir;
  let invocationId;
  if (process.argv[4] === '--run-dir' && process.argv[6] === '--invocation-id') {
    runDir = process.argv[5]; invocationId = process.argv[7]; commandOffset = 9;
    assertAbsolute('run directory', runDir);
    const stat = lstatSync(runDir);
    if (!/^[a-zA-Z0-9-]+$/.test(invocationId) || !stat.isDirectory() || stat.uid !== process.getuid()
      || (stat.mode & 0o077) || realpathSync(runDir) !== runDir || runDir.split('/').includes('..')) throw new Error('Invalid private worker run');
  }
  if (process.argv[commandOffset - 1] !== '--') throw new Error('Invalid private worker command');
  const [command, ...args] = process.argv.slice(commandOffset);
  assertAbsolute('worker binary', command);
  // A publish collision (a pre-existing target, planted or otherwise) is
  // recorded as a diagnostic anomaly file; it is never allowed to propagate
  // as a thrown error. The worker's real wait() status (propagated via
  // `process.kill`/`process.exitCode` by the caller below) must never be
  // replaced by an uncaught exception from this bookkeeping write.
  const recordAnomaly = (filename, temporary, error) => {
    try { unlinkSync(temporary); } catch { /* best effort cleanup only */ }
    try {
      const anomalyTarget = path.join(runDir, `${filename}.transport-anomaly.json`);
      const anomalyTemp = path.join(runDir, `.${filename}.transport-anomaly-${process.pid}`);
      const fd = openSync(anomalyTemp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify({ invocationId, filename, error: error?.message ?? String(error), at: new Date().toISOString() })); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(anomalyTemp, anomalyTarget);
    } catch { /* anomaly recording is diagnostics-only and must never throw */ }
  };
  const record = (filename, value) => {
    if (!runDir) return;
    const target = path.join(runDir, filename);
    const temporary = path.join(runDir, `.${filename}-${process.pid}`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ invocationId, ...value })); fsyncSync(fd); } finally { closeSync(fd); }
    // Only this trusted transport writes these fresh records. A pre-existing
    // target is a recorded anomaly, not a thrown error — callers must always
    // reach their own post-record status propagation regardless.
    try { lstatSync(target); recordAnomaly(filename, temporary, new Error('Worker transport record already exists')); return; }
    catch (error) {
      if (error.code !== 'ENOENT') { recordAnomaly(filename, temporary, error); return; }
    }
    try { renameSync(temporary, target); }
    catch (error) { recordAnomaly(filename, temporary, error); }
  };
  const environment = Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  runWorkerTransport({ command, args, environment, record });
}
