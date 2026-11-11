// Reserve raw shell outputs using the one-shot launcher's predecessor and capture owners.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importImpl } from '../../_resolve-impl.mjs';
import { boundedPrivateRead, withWorkerPath } from './worker-inputs.mjs';
import { assertWorkerCapturePathsAvailable, WorkerCaptureOwner } from './worker-capture.mjs';
import { prepareWorkerRetry } from './worker-retry-evidence.mjs';
import { publishWorkerRecord, stableTaskChainDigest } from '../session-launcher.mjs';

export async function reserveShellWorkerCapture({ request, invocation, paths }) {
  const { inspectWorkerPath: inspect } = await importImpl(import.meta.url, 'serve/worker-invocation-paths.js');
  const cwd = await realpath(invocation.cwd);
  const key = createHash('sha256').update(JSON.stringify([request.role, request.task, cwd])).digest('hex');
  const captureRoot = dirname(paths.final), runDir = join(captureRoot, `.shell-${key}`);
  const saved = { request: { ...request, workdir: cwd }, invocation };
  await prepareWorkerRetry({ runDir, captureRoot }, { saved, inspect, workerWritableRoots: [] });
  await assertWorkerCapturePathsAvailable(paths, inspect, { runDir, writableRoots: [] });
  for (const filename of Object.values(paths)) {
    if (await inspect(filename, 'output')) throw new Error('Fresh worker output paths are required');
    if (!await inspect(dirname(filename), 'directory')) throw new Error('Worker output parent is missing');
  }
  if (invocation.stdin !== 'closed') {
    const brief = await boundedPrivateRead(invocation.briefPath, 262144, inspect);
    if (`sha256:${createHash('sha256').update(brief).digest('hex')}` !== invocation.briefDigest) {
      throw new Error('Worker prompt digest changed; resolve again');
    }
  }
  // Atomic task reservation also refuses concurrent commands with distinct finals.
  // Keep it after failures: raw execution cannot establish owned termination.
  await withWorkerPath(runDir, target => mkdir(target, { mode: 0o700 }));
  const invocationId = randomUUID();
  await publishWorkerRecord(runDir, 'invocation.json', { origin: 'shell-handoff', invocationId,
    cwd, selected: invocation.selected, prompt: { path: invocation.briefPath, digest: invocation.briefDigest },
    taskBindingDigest: await stableTaskChainDigest(request, invocation.briefDigest), paths }, inspect);
  const owner = new WorkerCaptureOwner({ runDir, paths, captures: {}, inspect, invocationId });
  for (const filename of Object.values(paths)) await owner.reserveOutput(filename);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await reserveShellWorkerCapture(JSON.parse(process.argv[2])); }
  catch (error) { process.stderr.write(`Worker shell handoff refused: ${error.message}\n`); process.exitCode = 1; }
}
