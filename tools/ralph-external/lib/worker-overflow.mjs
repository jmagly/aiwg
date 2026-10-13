/** Stop authority and bounded termination proof for MCP stdout overflow. */
import { getWorkerIsolationStatus, stopWorkerUnit } from './worker-isolation.mjs';
import { signalOwnedWorker } from '../session-launcher.mjs';
import { sampleWorkerChildren, sampleWorkerIdentity, sameWorkerIdentity } from '../process-monitor.mjs';

export async function stopOverflowWorker(launch, {
  deadlineMs = 2000, pollIntervalMs = 25,
  stopUnit = stopWorkerUnit, unitStatus = getWorkerIsolationStatus,
  sample = sampleWorkerIdentity, children = sampleWorkerChildren, platform = process.platform,
  signal = signalOwnedWorker, clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const uncertain = diagnostic => ({ termination: 'uncertain', diagnostic });
  const deadline = clock() + deadlineMs;
  let diagnostic;
  // Subprocess timeouts cannot bound stalled kernel or /proc reads.
  const remaining = () => Math.max(1, deadline - clock());
  if (launch.mode === 'systemd-unit' && launch.unit) {
    try { if (!stopUnit(launch.unit, { timeoutMs: remaining() }).ok) diagnostic = 'OG_WORKER_MCP_STOP_FAILED'; }
    catch { diagnostic = 'OG_WORKER_MCP_STOP_FAILED'; }
  } else {
    const child = launch.child;
    // The direct-child handle cannot prove descendant termination.
    if (platform !== 'linux') {
      try { if (!child?.kill('SIGKILL')) return uncertain('OG_WORKER_MCP_STOP_FAILED'); }
      catch { return uncertain('OG_WORKER_MCP_STOP_FAILED'); }
      return uncertain('OG_WORKER_MCP_STOP_UNCONFIRMED');
    }
    const supervisor = sample(child?.pid);
    if (!supervisor || supervisor.parentPid !== process.pid || supervisor.uid !== process.getuid?.()
      || child.exitCode !== null || child.signalCode !== null) return uncertain('OG_WORKER_MCP_STOP_UNCONFIRMED');
    const candidates = launch.transportSupervisor ? children(supervisor.pid) : [supervisor];
    const worker = candidates?.length === 1 ? candidates[0] : null;
    if (!worker || launch.transportSupervisor && worker.parentPid !== supervisor.pid
      || !sameWorkerIdentity(supervisor, sample(supervisor.pid))) return uncertain('OG_WORKER_MCP_STOP_UNCONFIRMED');
    // Reuse the launcher's birth/session/UID checks; never signal a bare PID.
    if (!signal(worker, 'SIGKILL')) return uncertain('OG_WORKER_MCP_STOP_FAILED');
    // Descendants can escape the group, so its termination stays uncertain.
    return uncertain('OG_WORKER_MCP_STOP_UNCONFIRMED');
  }
  for (;;) {
    try { if (!unitStatus(launch.unit, { timeoutMs: remaining() }).active) return { termination: 'confirmed', ...(diagnostic ? { diagnostic } : {}) }; }
    catch { /* Retry unavailable/transient unit state until the deadline. */ }
    if (clock() >= deadline) break;
    await sleep(Math.min(pollIntervalMs, deadline - clock()));
  }
  return uncertain(diagnostic ?? 'OG_WORKER_MCP_STOP_UNCONFIRMED');
}
