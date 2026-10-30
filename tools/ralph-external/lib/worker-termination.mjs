// Confirm owned containment is empty independently of semantic observer coverage.
import { sampleWorkerIdentity, isSafeWorkerGroupTarget } from '../process-monitor.mjs';
import { getWorkerIsolationStatus } from './worker-isolation-status.mjs';
import { scanWorkerInvocationProcesses } from './worker-invocation-processes.mjs';

const TERMINATION_BUDGET_MS = 2000;
const TERMINATION_ATTEMPT_MS = 100;
const TERMINATION_MAX_ATTEMPTS = 21;

export function observeWorkerTermination({ mode, native, workerExited, identity,
  supervisor = sampleWorkerIdentity(process.pid), kill = process.kill, invocationId,
  scan = scanWorkerInvocationProcesses, deadline, now = () => performance.now() } = {}) {
  if (mode === 'systemd-unit') {
    const exited = workerExited === true || [1, 2, 3].includes(native?.execMainCode);
    return { confirmed: exited && native?.active === false && native?.cgroupEmpty === true,
      missing: !exited ? 'launcher-observed exit or unit ExecMainCode exit evidence' : native?.active !== false
        ? 'unit inactive evidence' : native?.cgroupEmpty !== true ? 'empty unit cgroup (TasksCurrent=0)' : null };
  }
  if (!workerExited) return { confirmed: false, missing: 'launcher-observed worker exit' };
  if (!identity || identity.pid !== identity.pgid || identity.uid !== process.getuid?.()
    || !supervisor || identity.host !== supervisor.host || identity.bootId !== supervisor.bootId
    || !isSafeWorkerGroupTarget(identity.pgid, supervisor)) {
    return { confirmed: false, missing: 'launcher-owned process group identity on this host and boot' };
  }
  try { kill(-identity.pgid, 0); }
  catch (error) {
    // Pass the recorded leader so the marker scan can tell a parallel
    // hardened (non-dumpable) worker's tree apart from a genuine escapee via
    // readable stat/cgroup links instead of failing closed on every
    // unreadable post-start process.
    if (error.code === 'ESRCH') {
      // Exit-time callers get one scan, at most 2 s. An explicit deadline
      // leaves the scan budget and retries to the recheck caller.
      return scan({ invocationId, startTicks: identity.startTicks, uid: identity.uid, now,
        deadline: deadline ?? now() + TERMINATION_BUDGET_MS,
        workerPid: identity.pid, workerPgid: identity.pgid, workerSession: identity.sessionId });
    }
    return { confirmed: false, missing: `empty owned process group (signal-0 returned ${error.code ?? 'unknown'})` };
  }
  return { confirmed: false, missing: 'empty owned process group (signal-0 still finds members)' };
}

export function terminationRemedy(result, runDir) {
  const missing = result?.isolation === 'systemd-unit'
    ? 'unit exit, inactive state and empty cgroup (TasksCurrent=0)'
    : 'launcher-observed worker exit, empty owned process group (kill(-pgid, 0) = ESRCH) and escaped-descendant evidence (bounded same-uid invocation-marker scan in Linux /proc)';
  return `Missing evidence: ${missing}. Repeat the original --launch-worker${runDir ? ` --retry-of-run-dir ${JSON.stringify(runDir)}` : ' --retry-of-run-dir DIR'} or --verify-worker${runDir ? ` --run-dir ${JSON.stringify(runDir)}` : ' --run-dir DIR'} command with --check-descendants for a bounded descendant check (at most 2 seconds); live or unknown descendants still refuse linkage. Missing launcher-owned group identity requires the original launch owner to establish containment; worker-reported identity cannot authorize this check.`;
}

export async function recheckWorkerTermination({ processRecord, exitRecord,
  status = getWorkerIsolationStatus, observe = observeWorkerTermination,
  now = () => performance.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (processRecord?.invocationId !== exitRecord.invocationId || processRecord.origin !== 'launcher') {
    return { confirmed: false, missing: 'matching launcher process.json' };
  }
  const local = sampleWorkerIdentity(process.pid);
  if (!local || processRecord.supervisor?.host !== local.host || processRecord.supervisor?.bootId !== local.bootId
    || processRecord.supervisor?.uid !== local.uid || processRecord.isolation !== exitRecord.isolation
    || !['systemd-unit', 'native-sandbox', 'degraded'].includes(processRecord.isolation)) {
    return { confirmed: false, missing: 'launcher containment identity on this host and boot' };
  }
  const identity = processRecord.identityObservation === 'stable-owned-group'
    && processRecord.ownership === 'owned-group' ? processRecord.worker : null;
  if (processRecord.isolation !== 'systemd-unit' && processRecord.invocationMarker !== processRecord.invocationId) {
    return { confirmed: false, missing: 'escaped-descendant evidence: launcher-bound invocation marker in process.json' };
  }
  const deadline = now() + TERMINATION_BUDGET_MS;
  // Both elapsed time and sample count bound the check, including injected clocks.
  let evidence;
  for (let attempt = 0; attempt < TERMINATION_MAX_ATTEMPTS; attempt++) {
    if (evidence && now() >= deadline) return evidence;
    let native = null;
    // Use the unit's retained exit state whenever a unit name is recorded,
    // not only when the recorded mode already says systemd-unit: launch-mode
    // selection is unchanged, but unit (cgroup) evidence is preferred
    // wherever it is available. Non-unit modes still ignore it below.
    if (typeof processRecord.unit === 'string' && processRecord.unit !== '') {
      try { native = status(processRecord.unit, { timeoutMs: Math.max(1, Math.min(TERMINATION_ATTEMPT_MS, deadline - now())) }); }
      catch { /* Unavailable is never empty. */ }
    }
    evidence = observe({ mode: processRecord.isolation, native, identity, invocationId: processRecord.invocationId,
      deadline: Math.min(deadline, now() + TERMINATION_ATTEMPT_MS), now,
      workerExited: Number.isInteger(exitRecord.exitCode) && exitRecord.exitCode >= 0 && exitRecord.exitCode <= 255
        || exitRecord.captureCoverage === 'complete' && exitRecord.workerTermination === 'confirmed' && /^SIG[A-Z0-9]+$/.test(exitRecord.signal ?? '') });
    if (evidence.confirmed || evidence.markerPresent || now() >= deadline || attempt === TERMINATION_MAX_ATTEMPTS - 1) return evidence;
    await wait(Math.min(TERMINATION_ATTEMPT_MS, Math.max(0, deadline - now())));
  }
  return evidence;
}
