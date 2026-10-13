/**
 * Worker process isolation for Tier 0 direct dispatch (FR-OG-108, #2954).
 *
 * Direct workers must never share the conductor's cgroup: on the titan host
 * an oomd kill of one shared cgroup took the conductor session with it.
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

const UNIT_SAFE = /[^A-Za-z0-9:_.@-]/g;
const transportBootstrapVariables = ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_DEBUG_OUTPUT'];

// Never unset these from a unit's environment even when the manager reports
// them and they are not allowlisted; see buildWorkerIsolationArgs' doc
// comment for why XDG_RUNTIME_DIR specifically must survive.
const UNAVOIDABLE_UNIT_ENV_NAMES = ['XDG_RUNTIME_DIR'];

/** Derive a unit-safe `aiwg-worker-<name>-<epoch>` unit name. */
export function proposeWorkerUnitName(name, nowSeconds = Math.floor(Date.now() / 1000)) {
  const stem = String(name ?? 'worker').replace(UNIT_SAFE, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'worker';
  return `aiwg-worker-${stem}-${nowSeconds}`;
}

function assertAbsolute(label, value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) {
    throw new Error(`Worker isolation requires an absolute NUL-free ${label}`);
  }
}

/**
 * Detect the worker isolation mode without launching anything.
 * `{ spawn }` is injectable so tests never touch the real user manager.
 * Returns `{ mode: 'systemd-unit' | 'degraded', reason, detail? }`.
 */
export function detectWorkerIsolation({ spawn = spawnSync, env = process.env } = {}) {
  if (process.platform !== 'linux') {
    return { mode: 'degraded', reason: `systemd user isolation requires Linux (this host: ${process.platform})` };
  }
  let runner;
  try {
    runner = spawn('systemd-run', ['--version'], { encoding: 'utf8', timeout: 10000 });
  } catch (error) {
    return { mode: 'degraded', reason: `systemd-run is unavailable: ${error.message}` };
  }
  if (runner.error || runner.status !== 0) {
    return { mode: 'degraded', reason: 'systemd-run is unavailable (no --version response)' };
  }
  let manager;
  try {
    manager = spawn('systemctl', ['--user', 'show', '-p', 'Version', '--value'], { encoding: 'utf8', timeout: 10000, env });
  } catch (error) {
    return { mode: 'degraded', reason: `systemd user manager is unreachable: ${error.message}` };
  }
  if (manager.error || manager.status !== 0) {
    return { mode: 'degraded', reason: 'systemd user manager is unreachable (systemctl --user failed)' };
  }
  return { mode: 'systemd-unit', reason: 'systemd user manager is reachable', detail: String(manager.stdout ?? '').trim() };
}

/**
 * Build the `systemd-run --user` argv for one isolated worker. Pure and
 * fully unit-tested. `kind` is `'unit'` (default, matches the field
 * prototype: own unit retained for post-exit status inspection) or `'scope'`.
 * Failed units require explicit `systemctl --user reset-failed <unit>` cleanup
 * after Result/ExecMainStatus have been recorded; --collect would erase them.
 * `env` supplies passthrough values (defaults to the conductor's current
 * `PATH`/`HOME`); only the allowlisted `envNames` are forwarded, and their
 * values are never written into argv. Each is requested with bare
 * `--setenv=NAME` (no `=value`), which (systemd >= 230; confirmed on this
 * host's systemd 259) imports the value from systemd-run's *own* invoking
 * process environment rather than rendering it into the unit's argv — so a
 * secret value never appears in `/proc/<systemd-run-pid>/cmdline`. That
 * import is additive to whatever the user manager already injects into every
 * unit (`systemctl --user show-environment`: LANG, XDG_*, SSH_AUTH_SOCK,
 * etc. on an interactive manager), so `managerEnvNames` — the caller's own
 * live snapshot of that list — drives a single `-p UnsetEnvironment=...`
 * removing every manager-injected name that is not on the allowlist, except
 * `XDG_RUNTIME_DIR` (`UNAVOIDABLE_UNIT_ENV_NAMES`): unsetting it is harmless
 * to secrecy (it is just `/run/user/<uid>`, not a secret) but was verified
 * empirically to make the launched unit's own `/proc/<pid>/environ`
 * unreadable (EACCES) even to the same-UID conductor that just started
 * it — on this host with `kernel.yama.ptrace_scope=1`, removing it strips
 * the unit of whatever ties it to the login session that would otherwise
 * grant that read. Carrying it through is the "systemd's minimal unit
 * variables if unavoidable" carve-out. The result is a unit environment
 * containing exactly the allowlisted names, `XDG_RUNTIME_DIR`, and whatever
 * few variables systemd itself always injects into a unit (`INVOCATION_ID`,
 * `MANAGERPID`, `MEMORY_PRESSURE_WATCH`, ...) — never a secret, never an
 * unrelated inherited variable. `kind: 'scope'` is exempt:
 * `--scope` execs directly as a child of the `systemd-run` client itself
 * (confirmed empirically — it inherits that process's environment wholesale,
 * ignoring `UnsetEnvironment`), so this guarantee applies only to `kind:
 * 'unit'`, not `'scope'`.
 *
 * `attached: true` (#2892 B2 / #2895) is `kind: 'unit'` plus `--wait --pipe
 * --quiet`: systemd-run itself stays attached for the lifetime of the unit,
 * connecting the unit's stdin/stdout/stderr directly to systemd-run's own
 * (i.e. to whatever stdio the *caller* gave the systemd-run child process),
 * and systemd-run's own exit mirrors the unit's exit status. This is how an
 * MCP stdio worker can be launched resource-confined while still giving the
 * conductor a live, bidirectional stdio stream to speak JSON-RPC over — the
 * same resource ceiling (`MemoryMax`/`MemorySwapMax`) and environment-
 * allowlist contract as the fire-and-forget `'unit'` path, just attached
 * instead of detached, plus the transport-bootstrap hardening
 * (`KillMode=control-group`/`ExitType=cgroup`/`UMask=0077`, refusal of
 * `NODE_OPTIONS`/`LD_PRELOAD`/etc. in the allowlist) `launchIsolatedWorker`
 * layers on top. Attached is therefore incompatible with `stdinPath`/
 * `stdoutPath`/`stderrPath`/`logFile` (those redirect to files; `--pipe`
 * redirects to the systemd-run client's own stdio) — passing any of them
 * with `attached: true` is refused rather than silently ignored.
 *
 * `pipe`/`wait` are separate boolean flags (independent of `attached`) for a
 * synchronous verification caller that wants `--pipe`/`--wait` (and, when
 * both are set, the mandatory `--quiet` below) without the attached/async
 * child contract — see `verification-isolation.mjs`.
 *
 * `stdinPath`, when given, feeds the worker's stdin from that file
 * (`StandardInputFile=`) instead of the default `StandardInput=null` — this
 * is how a resolved #2887 invocation's brief reaches the worker. `stdoutPath`
 * / `stderrPath`, when given, route stdout/stderr to distinct files; either
 * falls back to the combined `logFile` when omitted, so existing combined-log
 * callers are unaffected. Both use systemd's `truncate:` output mode
 * (systemd >= 248) rather than `file:` (which appends with O_APPEND), so a
 * pre-existing file at that path is replaced, not appended to.
 */
export function buildWorkerIsolationArgs({
  unit,
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
  managerEnvNames = [],
  kind = 'unit',
  extraProperties = [],
  pipe = false,
  wait = false,
  memoryMax,
  attached = false,
} = {}) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9:_.@-]+$/.test(unit)) {
    throw new Error('Worker isolation requires a unit-safe unit name');
  }
  const hasMemoryMaxGb = memoryMaxGb !== undefined;
  if (hasMemoryMaxGb && (!Number.isFinite(memoryMaxGb) || memoryMaxGb <= 0)) {
    throw new Error('Worker isolation requires a positive memoryMaxGb ceiling');
  }
  if (!hasMemoryMaxGb && memoryMax === undefined) {
    throw new Error('Worker isolation requires a positive memoryMaxGb ceiling');
  }
  assertAbsolute('worker binary', command);
  for (const token of args) {
    if (typeof token !== 'string' || token.includes('\0')) throw new Error('Worker isolation argv must be NUL-free strings');
  }
  if (kind !== 'unit' && kind !== 'scope') throw new Error("Worker isolation kind must be 'unit' or 'scope'");
  if (attached && (stdinPath !== undefined || stdoutPath !== undefined || stderrPath !== undefined || logFile !== undefined)) {
    throw new Error('Worker isolation attached mode connects stdio directly through systemd-run and cannot also redirect stdinPath/stdoutPath/stderrPath/logFile');
  }
  if (cwd !== undefined) assertAbsolute('working directory', cwd);
  if (logFile !== undefined) assertAbsolute('log file', logFile);
  if (stdinPath !== undefined) assertAbsolute('stdin brief', stdinPath);
  if (stdoutPath !== undefined) assertAbsolute('stdout path', stdoutPath);
  if (stderrPath !== undefined) assertAbsolute('stderr path', stderrPath);
  if (!Array.isArray(extraProperties) || extraProperties.some(entry => typeof entry !== 'string' || entry.includes('\0'))) {
    throw new Error('Worker isolation extraProperties must be an array of NUL-free "Name=value" strings');
  }

  const argv = ['systemd-run', '--user', '--expand-environment=no'];
  if (attached) {
    if (kind !== 'unit' || logFile !== undefined) throw new Error('Attached worker requires a unit with separate pipe captures');
    argv.push('--wait', '--pipe', '--quiet');
    argv.push('-p', 'KillMode=control-group', '-p', 'ExitType=cgroup', '-p', 'UMask=0077',
      '-p', `UnsetEnvironment=${transportBootstrapVariables.join(' ')}`);
  }
  if (kind === 'unit') argv.push(`--unit=${unit}`);
  else argv.push('--scope');
  // Attached launches already pass --wait --pipe --quiet above.
  if (pipe && !attached) argv.push('--pipe');
  if (wait && !attached) argv.push('--wait');
  // --pipe connects the unit's stdio directly to systemd-run's own, but
  // systemd-run still writes its *own* "Running as unit:.../Finished with
  // result:..." status lines to that same stderr unless --quiet is given —
  // verified empirically on this host. A synchronous verification caller
  // needs the check's actual stderr, not systemd-run's narration mixed into
  // it, so --quiet is mandatory whenever both --pipe and --wait are used.
  if (pipe && wait && !attached) argv.push('--quiet');
  const requestedNames = [];
  for (const name of envNames) {
    if (attached && transportBootstrapVariables.includes(name)) throw new Error('Worker environment cannot alter trusted transport bootstrap');
    const value = env?.[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Worker isolation environment value for ${name} is not a NUL-free string`);
    requestedNames.push(name);
    argv.push(`--setenv=${name}`);
  }
  if (kind === 'unit') {
    const toUnset = managerEnvNames.filter(name => !requestedNames.includes(name) && !UNAVOIDABLE_UNIT_ENV_NAMES.includes(name));
    if (toUnset.length > 0) argv.push('-p', `UnsetEnvironment=${toUnset.join(' ')}`);
  }
  // stdin is /dev/null unless a brief file is given; attached (supervised)
  // launches rely on systemd-run --pipe to carry stdin, so leave it unset.
  if (stdinPath !== undefined) argv.push('-p', `StandardInputFile=${stdinPath}`);
  else if (!attached) argv.push('-p', 'StandardInput=null');
  if (hasMemoryMaxGb) argv.push('-p', `MemoryMax=${memoryMaxGb}G`);
  else if (memoryMax !== undefined) argv.push('-p', `MemoryMax=${memoryMax}`);
  argv.push('-p', 'MemorySwapMax=0');
  const outPath = stdoutPath ?? logFile;
  const errPath = stderrPath ?? logFile;
  if (!pipe && outPath !== undefined) argv.push('-p', `StandardOutput=truncate:${outPath}`);
  if (!pipe && errPath !== undefined) argv.push('-p', `StandardError=truncate:${errPath}`);
  // Additional conductor-supplied confinement properties (ReadOnlyPaths,
  // ReadWritePaths, NoNewPrivileges, PrivateUsers, PrivateNetwork, ...),
  // appended verbatim as repeated `-p Name=value` pairs. Callers are
  // responsible for probing which of these this host's systemd/AppArmor
  // policy actually enforces (see verification-isolation.mjs) — some
  // properties silently no-op or fall back without a non-zero exit on
  // kernels/policies that deny the namespace privilege they need.
  for (const property of extraProperties) argv.push('-p', property);
  if (cwd !== undefined) argv.push(`--working-directory=${cwd}`);
  argv.push('--', command, ...args);
  return argv;
}

/**
 * Query the user manager's own inherited-environment variable names
 * (`systemctl --user show-environment`), required so a `kind: 'unit'`
 * launch can `UnsetEnvironment=` every manager-injected name that is not on
 * the caller's allowlist (see `buildWorkerIsolationArgs`' doc comment).
 * Extracted from `launchIsolatedWorker` so verification callers can reuse
 * the exact same security-relevant query instead of re-deriving it.
 */
export function resolveManagerEnvNames({ spawn = spawnSync } = {}) {
  const shown = spawn('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', timeout: 10000 });
  if (shown.error || shown.status !== 0) throw new Error(shown.error?.message ?? (String(shown.stderr ?? '').trim() || `exit ${shown.status}`));
  return String(shown.stdout ?? '').split('\n').map(line => line.slice(0, line.indexOf('='))).filter(Boolean);
}

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
  kind = 'unit',
  attached = false,
  spawn = spawnSync,
  spawnAsync = nodeSpawn,
  proposeUnit = proposeWorkerUnitName,
  stdin = 'closed',
  ownedGroup = false,
  runDir,
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
  if (detected.mode === 'degraded' && !allowDegraded) {
    return {
      launched: false,
      mode: 'degraded',
      diagnostic: `worker isolation unavailable: ${detected.reason}; pass allowDegraded:true to launch unconfined with stdin /dev/null (recorded as degraded)`,
      gate: resolvedGate,
    };
  }
  if (detected.mode === 'degraded') {
    assertAbsolute('worker binary', command);
    if (cwd !== undefined) assertAbsolute('working directory', cwd);
    if (stdinPath !== undefined) assertAbsolute('stdin brief', stdinPath);
    if (stdoutPath !== undefined) assertAbsolute('stdout path', stdoutPath);
    if (stderrPath !== undefined) assertAbsolute('stderr path', stderrPath);
    if (!Array.isArray(args) || args.some(token => typeof token !== 'string' || token.includes('\0'))) {
      throw new Error('Worker isolation argv must be NUL-free strings');
    }
    // Degraded mode has no systemd unit to confine the environment, so this
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
    if (attached && envNames.some(variable => transportBootstrapVariables.includes(variable))) {
      throw new Error('Worker environment cannot alter trusted transport bootstrap');
    }
    let child;
    if (attached) {
      const launchArgs = [fileURLToPath(import.meta.url), '--worker-environment', JSON.stringify(envNames),
        ...(runDir ? ['--run-dir', runDir, '--invocation-id', name] : []), '--', command, ...args];
      child = spawnAsync(process.execPath, launchArgs, { cwd, stdio: [stdin === 'closed' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        env: allowedEnv, ...(ownedGroup ? { detached: true } : {}) });
    } else {
      // Opening the brief/output files ourselves (rather than letting the
      // worker inherit a stream) is what lets a degraded launch still honor a
      // resolved #2887 invocation's stdin source and separate stdout/stderr
      // destinations; `openSync` throws rather than silently falling back.
      // 'w' truncates a pre-existing file at open time (matching the #2887
      // shell renderer's `>`/`2>` contract); the previous 'a' silently kept
      // appending onto a stale file across repeated degraded launches.
      const stdinFd = stdinPath !== undefined ? openSync(stdinPath, 'r') : 'ignore';
      const stdoutFd = stdoutPath !== undefined ? openSync(stdoutPath, 'w') : 'pipe';
      const stderrFd = stderrPath !== undefined ? openSync(stderrPath, 'w') : 'pipe';
      child = spawnAsync(command, args, { cwd, env: allowedEnv, stdio: [stdinFd, stdoutFd, stderrFd], detached: ownedGroup });
      // Node dup()s a numeric stdio fd into the child and never closes the
      // parent's own copy; the child's duplicated fd keeps working after this
      // call returns (verified empirically), so closing here is what the
      // previous code was missing — every launch otherwise leaked up to three
      // fds in the long-running conductor process.
      for (const fd of [stdinFd, stdoutFd, stderrFd]) if (typeof fd === 'number') closeSync(fd);
    }
    const outcome = {
      launched: Number.isInteger(child.pid) && child.pid > 0,
      mode: 'degraded', child, pid: child.pid,
      ...(attached ? { transportSupervisor: true } : {}),
      diagnostic: `launched without resource confinement: ${detected.reason}`,
      gate: resolvedGate,
    };
    // Keep launch failures observable even if the caller attaches listeners later.
    child.once('error', error => { outcome.launched = false; outcome.error = error.message; });
    return outcome;
  }
  // The unit path's security contract (see buildWorkerIsolationArgs' doc
  // comment) depends on knowing exactly which names the user manager would
  // otherwise inject, so it can unset every one of them that is not
  // allowlisted. Without a trustworthy answer to that query, launching would
  // either omit `UnsetEnvironment` (silently falling back to the padded,
  // non-exact environment this fix exists to remove) or guess — both are
  // refused in favor of an explicit failure.
  let managerEnvNames;
  try {
    managerEnvNames = resolveManagerEnvNames({ spawn });
  } catch (error) {
    return {
      launched: false,
      mode: 'systemd-unit',
      diagnostic: `unable to determine the user manager's inherited environment (required to isolate the worker's environment exactly): ${error.message}`,
      gate: resolvedGate,
    };
  }
  const unit = proposeUnit(name);
  // A private host-owned transport wrapper strips the manager's environment
  // before spawning the real worker. Environment values never enter argv.
  const isolatedCommand = attached ? process.execPath : command;
  const isolatedArgs = attached ? [fileURLToPath(import.meta.url), '--worker-environment', JSON.stringify(envNames),
    ...(runDir ? ['--run-dir', runDir, '--invocation-id', name] : []), '--', command, ...args] : args;
  const argv = buildWorkerIsolationArgs({ unit, memoryMaxGb, command: isolatedCommand, args: isolatedArgs,
    cwd, logFile, stdinPath, stdoutPath, stderrPath, env, envNames, managerEnvNames, kind, attached });
  if (attached) {
    // The spawned transport wrapper's OWN process env is `{...process.env,
    // ...env}` (minus bootstrap vars) so systemd-run's bare `--setenv=NAME`
    // (see buildWorkerIsolationArgs' doc comment) can import allowlisted
    // values that live only in a caller-supplied `env` map (e.g. an MCP
    // worker server's own registered credentials) and not in the
    // conductor's own `process.env` — `process.env` is spread first so
    // systemd-run can still reach its D-Bus user session. The wrapper
    // itself then builds the REAL worker's environment purely from
    // `envNames`/`env` (never from this spawn env), so this merge only
    // widens what systemd-run's CLIENT can import from, never what the
    // worker receives.
    const child = spawnAsync(argv[0], argv.slice(1), { cwd,
      env: Object.fromEntries(Object.entries({ ...process.env, ...env })
        .filter(([variable]) => !transportBootstrapVariables.includes(variable))),
      stdio: [stdin === 'closed' ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: ownedGroup });
    const outcome = { launched: Number.isInteger(child.pid) && child.pid > 0, mode: 'systemd-unit', unit, child, gate: resolvedGate };
    child.once('error', error => { outcome.launched = false; outcome.error = error.message; });
    return outcome;
  }
  const child = spawn(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30000 });
  if (child.error || child.status !== 0) {
    const stderr = String(child.stderr ?? '').trim();
    return {
      launched: false,
      mode: 'systemd-unit',
      unit,
      diagnostic: `systemd-run launch failed: ${child.error?.message ?? stderr ?? `exit ${child.status}`}`,
      gate: resolvedGate,
    };
  }
  let pid;
  try {
    const shown = spawn('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unit], { encoding: 'utf8', timeout: 10000 });
    const parsed = Number(String(shown.stdout ?? '').trim());
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    pid = undefined;
  }
  return { launched: true, mode: 'systemd-unit', unit, pid, gate: resolvedGate };
}

/**
 * Read retained service state after launch/exit without reaping or mutation.
 * `memoryMax` is bytes. Query failures throw rather than reporting success.
 */
export function getWorkerIsolationStatus(unit, { spawn = spawnSync, timeoutMs = 10000 } = {}) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9:_.@-]+$/.test(unit)) {
    throw new Error('Worker isolation requires a unit-safe unit name');
  }
  const shown = spawn('systemctl', ['--user', 'show', unit, '-p', 'ActiveState',
    '-p', 'Result', '-p', 'ExecMainStatus', '-p', 'ExecMainCode', '-p', 'MainPID', '-p', 'MemoryMax'], { encoding: 'utf8', timeout: timeoutMs });
  if (shown.error || shown.status !== 0) {
    throw new Error(`worker status unavailable: ${shown.error?.message ?? String(shown.stderr ?? '').trim()}`);
  }
  const fields = Object.fromEntries(String(shown.stdout ?? '').trim().split('\n').map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  if (!fields.ActiveState || !fields.Result || !fields.ExecMainStatus || !fields.MemoryMax) {
    throw new Error('worker status unavailable: missing systemd properties');
  }
  return {
    active: ['active', 'activating', 'deactivating', 'reloading'].includes(fields.ActiveState),
    result: fields.Result,
    execMainStatus: Number(fields.ExecMainStatus),
    memoryMax: fields.MemoryMax === 'infinity' ? Infinity : Number(fields.MemoryMax),
    ...(fields.MainPID ? { mainPid: Number(fields.MainPID) } : {}),
    ...(fields.ExecMainCode ? { execMainCode: Number(fields.ExecMainCode) } : {}),
  };
}

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
  const result = spawn('systemctl', ['--user', 'stop', unit], { encoding: 'utf8', timeout: timeoutMs });
  return { ok: !result.error && result.status === 0,
    diagnostic: result.error ? result.error.message : String(result.stderr ?? '').trim() || null };
}

/**
 * Read the kernel-reported `ControlGroup` systemd placed this unit's
 * processes under. This is the containment authority for `systemd-unit`
 * mode worker identity (#2895 round 2, MAJOR a): a candidate pid is only
 * trustworthy if its own `/proc/<pid>/cgroup` matches this value, never
 * because a worker-writable record merely names a pid that happens to
 * resample successfully. Returns null (never a forged match) when the
 * property is unavailable.
 */
export function readUnitControlGroup(unit, { spawn = spawnSync } = {}) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9:_.@-]+$/.test(unit)) return null;
  try {
    const shown = spawn('systemctl', ['--user', 'show', unit, '-p', 'ControlGroup', '--value'], { encoding: 'utf8', timeout: 10000 });
    if (shown.error || shown.status !== 0) return null;
    const value = String(shown.stdout ?? '').trim();
    return value || null;
  } catch { return null; }
}

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
// The systemd unit owns this supervisor and its worker; cgroup exit evidence
// includes descendants. Only the actual worker receives the allowed values.
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
