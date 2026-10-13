import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);
const uncertain = () => ({ termination: 'uncertain', exitCode: null });
const unitProperties = ['LoadState', 'ActiveState', 'Result', 'ExecMainStatus', 'ExecMainCode', 'MainPID'];

/** Parse only explicit stop proof. Missing/unknown properties are observation
 * failures, never evidence of termination. A collected unit has no exit result. */
export function parseShellUnitStatus(stdout) {
  const fields = Object.fromEntries(String(stdout).split('\n').filter(line => line.includes('='))
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  if (fields.LoadState === 'not-found' && fields.ActiveState === 'inactive' && fields.MainPID === '0') {
    return { termination: 'confirmed', exitCode: null };
  }
  if (!['loaded', 'error', 'masked'].includes(fields.LoadState)
    || !['active', 'activating', 'deactivating', 'reloading', 'inactive', 'failed'].includes(fields.ActiveState)
    || !fields.Result || !/^\d+$/.test(fields.ExecMainStatus ?? '') || !/^\d+$/.test(fields.ExecMainCode ?? '')
    || !/^\d+$/.test(fields.MainPID ?? '')) {
    throw new Error('worker status unavailable: missing or invalid systemd properties');
  }
  if (!['inactive', 'failed'].includes(fields.ActiveState) || fields.MainPID !== '0') return uncertain();
  const signaled = ['2', '3'].includes(fields.ExecMainCode);
  return { termination: 'confirmed', exitCode: fields.Result === 'success' && !signaled
    ? Number(fields.ExecMainStatus) : Number(fields.ExecMainStatus) || 1,
  ...(signaled ? { signalCode: Number(fields.ExecMainStatus) } : {}) };
}

export async function waitForUnitTermination(unit, deadlineMs, { signal, pollIntervalMs = 2000,
  exec = execFileAsync, sleep = (ms, abortSignal) => delay(ms, undefined, { signal: abortSignal }),
  clock = Date.now } = {}) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9:_.@-]+$/.test(unit)) throw new Error('Worker isolation requires a unit-safe unit name');
  const deadline = clock() + deadlineMs;
  while (!signal?.aborted && clock() < deadline) {
    try {
      const { stdout } = await exec('systemctl', ['--user', 'show', unit, ...unitProperties.flatMap(name => ['-p', name])],
        // Probes have a usable floor; the caller's AbortSignal bounds the
        // overall grace/deadline even when a probe is still in flight.
        { timeout: Math.max(1000, Math.min(10000, deadline - clock())), signal });
      if (signal?.aborted) return uncertain();
      const outcome = parseShellUnitStatus(stdout);
      if (outcome.termination === 'confirmed') return outcome;
    } catch (error) {
      // systemctl may return nonzero for a collected unit while still showing
      // its complete not-found/inactive properties. Never infer from stderr.
      if (!signal?.aborted && Number.isInteger(error.code) && /^LoadState=not-found$/m.test(error.stdout ?? '')) {
        try {
          const outcome = parseShellUnitStatus(error.stdout);
          if (outcome.termination === 'confirmed') return outcome;
        } catch { /* incomplete proof; retry below */ }
      }
      // Retry transient status failures until deadline/cancellation.
    }
    if (signal?.aborted) return uncertain();
    try { await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - clock())), signal); }
    catch { return uncertain(); }
  }
  return { ...uncertain(), timedOut: !signal?.aborted };
}

/** Retain uncertain workers with bounded polling. POSIX groups cannot contain
 * setsid/setpgid escapees; Windows proves only direct-child close. Sweep once
 * after leader reap to limit (not eliminate) the PGID reuse race. */
export function buildShellStopControl(launch, { waitForUnit = waitForUnitTermination,
  stopUnit = defaultStopShellUnit, killUnit = defaultKillShellUnit, graceMs,
  onConfirmed, platform = process.platform, recheckMaxAttempts = 6, recheckDelayMs = 250 }) {
  let closed = false;
  let exitCode = null;
  let signalCode = null;
  let confirmed;
  let stopTask;
  let delivery;
  let stopped = false;
  let recheckTimer;
  let rechecks = 0;
  let disposed = false;
  let groupSwept = false;
  let resolveClose;
  const probes = new Set();
  const child = launch.child;
  const ownedGroup = platform !== 'win32' && launch.ownedGroup && child?.pid;
  const closeProof = new Promise(resolve => { resolveClose = resolve; });

  function groupGone() {
    if (!ownedGroup) return true;
    try { process.kill(-child.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  }
  function confirm(outcome) {
    if (confirmed) return confirmed;
    confirmed = { ...outcome, stopped };
    clearTimeout(recheckTimer);
    for (const probe of probes) probe.abort();
    child?.removeListener('close', onClose);
    child?.removeListener('error', onError);
    resolveClose(confirmed);
    // Registry/cleanup extension failures must not escape an event handler.
    try { Promise.resolve(onConfirmed?.(confirmed)).catch(() => {}); } catch { /* confirmed proof remains valid */ }
    return confirmed;
  }
  function onClose(code, signal) {
    closed = true;
    exitCode = code;
    signalCode = signal ?? child?.signalCode ?? null;
    if (launch.mode === 'systemd-unit') return; // systemd-run close is not cgroup stop proof
    if (groupGone()) confirm({ termination: 'confirmed', exitCode, signalCode });
    else void control.stop(); // descendants outlived their leader
  }
  function onError() {
    // A pid-bearing child error is an observation failure, not a deadline.
    // ENOENT has no pid and cannot have started a worker.
    if (!child?.pid && launch.mode !== 'systemd-unit') confirm({ termination: 'confirmed', exitCode: null });
  }
  child?.once('close', onClose);
  child?.on('error', onError);

  async function bounded(operation, ms) {
    const abort = new AbortController();
    probes.add(abort);
    let timer;
    let onAbort;
    try {
      return await Promise.race([Promise.resolve().then(() => operation(abort.signal)), new Promise(resolve => {
        onAbort = () => resolve(confirmed ?? uncertain());
        abort.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => resolve({ ...uncertain(), timedOut: true }), Math.max(0, ms));
      })]);
    } catch { return uncertain(); }
    finally {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', onAbort);
      probes.delete(abort);
      abort.abort(); // cancel a losing poll or execFile, including its sleep
    }
  }
  async function waitStopped(ms) {
    if (confirmed) return confirmed;
    if (launch.mode === 'systemd-unit') {
      const outcome = await bounded(signal => waitForUnit(launch.unit, ms, { signal }), ms);
      return outcome.termination === 'confirmed' ? confirm(outcome) : outcome;
    }
    if (closed && groupGone()) return confirm({ termination: 'confirmed', exitCode, signalCode });
    return bounded(() => closeProof, ms);
  }
  function recheck() {
    if (confirmed || disposed || recheckTimer || rechecks >= recheckMaxAttempts
      || (launch.mode !== 'systemd-unit' && !ownedGroup)) return;
    recheckTimer = setTimeout(async () => {
      recheckTimer = undefined;
      rechecks++;
      await waitStopped(launch.mode === 'systemd-unit' ? Math.max(1000, graceMs) : Math.max(25, graceMs));
      recheck();
    }, Math.min(8000, recheckDelayMs * 2 ** rechecks));
    recheckTimer.unref?.();
  }
  async function signal(signalName, budgetMs) {
    if (confirmed) return true;
    try {
      if (launch.mode === 'systemd-unit') {
        const result = await bounded(abortSignal => (signalName === 'SIGTERM' ? stopUnit : killUnit)(launch.unit,
          { signal: abortSignal, timeout: Math.max(1, budgetMs) }), budgetMs);
        return !!result.ok;
      }
      if (ownedGroup) {
        if ((closed || child.exitCode != null || child.signalCode != null) && groupSwept) return false;
        if (signalName === 'SIGKILL') groupSwept = true;
        process.kill(-child.pid, signalName);
        return true;
      }
      return !closed && !!child?.kill(signalName);
    } catch { return false; }
  }
  const control = {
    dispose: () => {
      disposed = true;
      clearTimeout(recheckTimer);
      for (const probe of probes) probe.abort();
      // Keep close/error listeners for late proof and EventEmitter safety.
    },
    get pollingStopped() { return disposed || !!confirmed || rechecks >= recheckMaxAttempts; },
    stop: async () => {
      if (confirmed) return true;
      if (stopTask) return delivery;
      stopped = true;
      const phaseMs = launch.mode === 'systemd-unit' ? Math.max(1000, graceMs) : graceMs;
      let phaseEnd = Date.now() + phaseMs;
      delivery = signal('SIGTERM', phaseMs);
      stopTask = (async () => {
        await delivery;
        let outcome = await waitStopped(Math.max(0, phaseEnd - Date.now()));
        if (outcome.termination !== 'confirmed') {
          phaseEnd = Date.now() + phaseMs;
          await signal('SIGKILL', phaseMs);
          outcome = await waitStopped(Math.max(0, phaseEnd - Date.now()));
        }
        if (outcome.termination !== 'confirmed') recheck();
        return outcome;
      })().finally(() => { stopTask = undefined; });
      return delivery;
    },
    stopAndConfirm: async () => {
      await control.stop();
      return confirmed ?? (stopTask ? await stopTask : uncertain());
    },
    wait: async deadlineMs => {
      const deadline = Date.now() + deadlineMs;
      let outcome;
      do {
        outcome = await waitStopped(Math.max(0, deadline - Date.now()));
        if (confirmed) return confirmed;
        // Observation failure alone never mandates a stop. Avoid a hot loop
        // when an injected/failed observer returns immediately.
        if (!outcome.timedOut) await Promise.race([closeProof, delay(Math.min(50, Math.max(0, deadline - Date.now())))]);
      } while (!disposed && !outcome.timedOut && Date.now() < deadline);
      if (disposed) return uncertain();
      return { ...await control.stopAndConfirm(), timedOut: true };
    },
  };
  // Only a recorded real close can be replayed; exitCode precedes stdio close.
  if (launch.spawnObservation?.closed) onClose(launch.spawnObservation.exitCode, launch.spawnObservation.signalCode);
  if (!child?.pid && !launch.unit && !launch.launched) confirm({ termination: 'confirmed', exitCode: null });
  return control;
}

export async function defaultStopShellUnit(unit, { signal, timeout = 1000, exec = execFileAsync } = {}) {
  try {
    await exec('systemctl', ['--user', '--no-block', 'stop', unit], { timeout, signal });
    return { ok: true };
  } catch { return { ok: false }; }
}
export async function defaultKillShellUnit(unit, { signal, timeout = 1000, exec = execFileAsync } = {}) {
  try {
    await exec('systemctl', ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', unit], { timeout, signal });
    return { ok: true };
  } catch { return { ok: false }; }
}
