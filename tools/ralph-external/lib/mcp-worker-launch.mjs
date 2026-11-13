// Adapt MCP shell dispatch to the same one-shot launch and capture owner as --launch-worker.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionLauncher, planDirectWorkerLaunch } from '../session-launcher.mjs';
import { checkWorkerDispatch, launchIsolatedWorker } from './worker-isolation.mjs';

export async function launchMcpShellWorker(invocation, { plan, invocationId, releaseOutput, runDir, servedRoot,
  loadInputs, now, onRunDir, memoryMaxGb = 2, allowDegraded, admission, dispatchGuard,
  live, readers, thresholdOverlay, isolation, spawn, spawnAsync }) {
  if (!Number.isFinite(memoryMaxGb) || memoryMaxGb <= 0) throw new Error('Worker isolation requires a positive memoryMaxGb ceiling');
  const parent = await mkdtemp(join(servedRoot, '.worker-run-'));
  runDir ??= join(parent, 'run');
  const invocationPath = join(parent, 'plan.json');
  await writeFile(invocationPath, JSON.stringify(plan), { flag: 'wx', mode: 0o600 });
  onRunDir(runDir);
  await releaseOutput(); // The launcher exclusively reserves every output before spawning.
  const owner = new SessionLauncher();
  let launch;
  let attempt;
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  owner.once('launched', () => resolveStarted(launch));
  const completion = owner.launchWorker({ invocationPath, invocationId, runDir, loadInputs, now: () => now().toISOString(),
    memoryMaxGb, allowDegraded, scopedBreaker: null, isolation,
    checkDispatch: options => checkWorkerDispatch({ ...options, live, readers, thresholdOverlay }),
    launchIsolated: async options => {
      const onSpawnAttempt = value => { attempt = value; };
      // The MCP bridge retains its single recovery admission and leaf dispatch guard.
      launch = await (admission === undefined
        ? launchIsolatedWorker({ ...options, spawn, spawnAsync, onSpawnAttempt })
        : planDirectWorkerLaunch({ ...options, invocation, invocationId, admission, dispatchGuard,
          live, readers, thresholdOverlay, spawn, spawnAsync, onSpawnAttempt }));
      launch.child?.once('close', (exitCode, signalCode) => {
        launch.spawnObservation = { closed: true, exitCode, signalCode };
      });
      return launch;
    },
  });
  // Observe rejection immediately; preparation failures must never strand MCP admission.
  const settled = completion.then(() => launch, error => {
    error.launchAttempted = !!(launch?.child?.pid || launch?.unit || attempt?.child?.pid || attempt?.unit);
    throw error;
  });
  const result = await Promise.race([started, settled]);
  // A transport's close cannot override the capture owner's descendant proof.
  const stop = () => { if (!owner.workerStop) return false; owner.workerStop(); return true; };
  const outcome = async () => { const value = await completion; return { ...value, stopped: !!value.cancelled }; };
  const control = {
    stop: async () => stop(),
    stopAndConfirm: async () => { stop(); return outcome(); },
    wait: async (deadlineMs, { deadlineAtMs, nowMs = () => performance.now() } = {}) => {
      const remaining = Math.max(0, Math.min(deadlineMs, (deadlineAtMs ?? Infinity) - nowMs()));
      const timer = setTimeout(() => owner.workerStop?.('HARD_DEADLINE'), remaining);
      try { return await outcome(); } finally { clearTimeout(timer); }
    },
    dispose() {},
  };
  return { ...result, runDir, launchAttempted: !!(result?.child?.pid || result?.unit),
    ownedGroup: result?.ownedGroup ?? (['native-sandbox', 'degraded'].includes(result?.mode) && !!result?.pid),
    control, cleanup: () => settled };
}
