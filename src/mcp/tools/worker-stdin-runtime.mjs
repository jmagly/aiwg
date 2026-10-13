import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Sweep old private directories only for dead conductors; PID reuse retains
 * them. Runtime files keep prompts out of git, but cannot isolate same-user workers. */
export async function sweepWorkerStdin(root = tmpdir(), { staleMs = 86400000, now = Date.now(),
  isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } } } = {}) {
  try {
    for (const name of await readdir(root)) {
      const match = /^aiwg-worker-stdin-(\d+)-[A-Za-z0-9]+$/.exec(name);
      if (!match || isAlive(Number(match[1]))) continue;
      const directory = path.join(root, name);
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs < staleMs
          || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700))) continue;
        await rm(directory, { recursive: true, force: true });
      } catch { /* best-effort stale cleanup must not prevent registration */ }
    }
  } catch { /* missing/inaccessible runtime root */ }
}

export async function prepareWorkerStdin(bytes, root = tmpdir()) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(root, `aiwg-worker-stdin-${process.pid}-`));
  const stdinPath = path.join(directory, 'stdin');
  let cleanupTask;
  const cleanup = () => cleanupTask ??= rm(directory, { recursive: true, force: true }).catch(() => {
    console.error('[worker-invoke] private stdin cleanup failed; retained for stale sweep');
  });
  try {
    await writeFile(stdinPath, bytes, { flag: 'wx', mode: 0o600 });
    return { stdinPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function launchPreparedShellWorker(invocation, { allowDegraded, config, name, live, readers, thresholdOverlay,
  memoryMaxGb, driver, servedRoot, isolation, spawn, spawnAsync, stdinRuntimeRoot },
  { loadRalphExternal, readBoundedFile, importImpl, describeGateFailures }) {
  let attempt;
  let cleanup = () => Promise.resolve();
  try {
    const { planDirectWorkerLaunch } = await loadRalphExternal('session-launcher.mjs');
    if (!Number.isFinite(memoryMaxGb) || memoryMaxGb <= 0) throw new Error('Worker isolation requires a positive memoryMaxGb ceiling');
    const brief = await readBoundedFile(invocation.briefPath, 262144, servedRoot);
    if (`sha256:${createHash('sha256').update(brief).digest('hex')}` !== invocation.briefDigest) {
      throw new Error('Worker prompt digest changed');
    }
    const { workerStdinBytes } = await importImpl('serve/worker-stdin-frame.mjs');
    let stdinPath;
    const bytes = workerStdinBytes(invocation, brief, driver);
    if (bytes !== null) {
      ({ stdinPath, cleanup } = await prepareWorkerStdin(bytes, stdinRuntimeRoot));
    }
    const launch = await planDirectWorkerLaunch({ invocation, config, allowDegraded, name, live, readers,
      thresholdOverlay, memoryMaxGb, stdinPath, ownedGroup: true, isolation,
      spawn, spawnAsync, onSpawnAttempt: value => {
        attempt = value;
        value.child?.once('close', (exitCode, signalCode) => { Object.assign(value, { closed: true, exitCode, signalCode }); });
      },
    });
    const launchAttempted = !!(attempt?.unit || attempt?.pid);
    if (!launch.launched && !launchAttempted) await cleanup();
    return { ...launch, launchAttempted, spawnObservation: attempt, ownedGroup: launch.mode === 'degraded' && !!launch.pid, cleanup,
      diagnostic: launch.diagnostic ?? describeGateFailures(launch.failures) };
  } catch (error) {
    if (attempt?.unit || attempt?.pid) {
      return { ...attempt, spawnObservation: attempt, ownedGroup: attempt.mode === 'degraded', launched: false, launchAttempted: true, cleanup, diagnostic: error.message };
    }
    error.workerNotLaunched = true;
    await cleanup();
    throw error;
  }
}
