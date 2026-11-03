// Reproduce EVAL-OG-01 direct-06 overwrite and direct-13 deliverable reuse through the launcher.
import { chmod, lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerInvocationFixture } from '../../fixtures/worker-single-invocation.js';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { verifyRetryPredecessor } from '../../../tools/ralph-external/session-launcher.mjs';
import { resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { inspectWorkerPath } from '../../../src/serve/worker-invocation-paths.js';

const roots: string[] = [], breakers: ScopedFailureBreaker[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const breaker of breakers.splice(0)) breaker.destroy();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = () => workerInvocationFixture({ waitForIdentity: true }, { roots, breakers });
const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const record = async (dir: string, name: string) => JSON.parse(await readFile(path.join(dir, name), 'utf8'));
async function nextPlan(f: any, final = path.join(f.root, 'second-final.json'), task = f.plan.request.task) {
  // A separate task isolates path reservations from open-predecessor refusal after deleting old outputs.
  if (task === 'bugfix') f.snapshot.models.defaults.workerSelection.taskClasses.bugfix = 'coding';
  const plan = await resolveWorkerInvocation(f.snapshot, { ...f.plan.request, task, final_output: final }, f.drivers, f.request.now);
  expect(plan.invocation, JSON.stringify(plan)).toBeDefined();
  const invocationPath = path.join(f.root, 'second-plan.json');
  await writeFile(invocationPath, JSON.stringify(plan));
  return { invocationPath, runDir: path.join(f.root, 'second-run') };
}
const verify = (f: any, invocationId: string) => verifyRetryPredecessor({ runDir: f.runDir, invocationId },
  { inspect: inspectWorkerPath, workerWritableRoots: [f.cwd] });

describe('T-OG-15 attempt capture preservation (#3832, partial)', () => {
  it.each([true, false])('seals exact stdout, stderr and final bytes before returning (recovery %s)', async gated => {
    const f = await fixture();
    const result = await f.launch(gated ? {} : { scopedBreaker: null });
    expect(result.termination).toBe('confirmed');
    const invocation = await record(f.runDir, 'invocation.json');
    const exit = await record(f.runDir, 'exit.json');
    expect(exit.captureSeal).toEqual(result.captureSeal);
    expect(exit.captureSeal.directory).toBe(invocation.captureDirectory);
    expect((await lstat(invocation.captureDirectory)).mode & 0o777).toBe(0o500);
    expect(exit.captureSeal.files).toHaveLength(5);
    expect(new Set(exit.captureSeal.files.map((file: any) => file.source)))
      .toEqual(new Set([...Object.values(invocation.paths), ...Object.values(invocation.captures)]));
    for (const file of exit.captureSeal.files) {
      const bytes = await readFile(file.source);
      expect(await readFile(file.path)).toEqual(bytes);
      expect(file.digest).toBe(digest(bytes));
      expect(file.byteLength).toBe(bytes.length);
      expect((await lstat(file.path)).mode & 0o777).toBe(0o400);
    }
    await expect(verify(f, result.invocationId)).resolves.toMatchObject({ invocationId: result.invocationId });
    const first = exit.captureSeal.files[0].path;
    if (process.getuid?.() === 0) {
      // Root ignores the 0400/0500 bits (CI containers run tests as root), so the
      // seal's protection there is detection: a rewritten snapshot fails verification.
      await writeFile(first, 'overwrite');
      await expect(verify(f, result.invocationId)).rejects.toThrow(/capture/i);
    } else {
      await expect(writeFile(first, 'overwrite')).rejects.toMatchObject({ code: 'EACCES' });
      await expect(unlink(first)).rejects.toMatchObject({ code: 'EACCES' });
    }
  });

  it.each(['run-directory', 'stdout', 'stderr', 'final'])('refuses second-attempt reuse of %s without predecessor linkage', async kind => {
    const f = await fixture(), first = await f.launch();
    const exit = await record(f.runDir, 'exit.json');
    const before = await Promise.all(exit.captureSeal.files.map((file: any) => readFile(file.path)));
    const next = kind === 'run-directory' ? {} : await nextPlan(f,
      kind === 'final' ? f.final : f.plan.invocation![`${kind}Path`]);
    const launch = vi.fn();
    await expect(f.launch({ ...next, launchIsolated: launch })).rejects.toThrow(/fresh|empty|earlier attempt/);
    expect(launch).not.toHaveBeenCalled();
    expect(await Promise.all(exit.captureSeal.files.map((file: any) => readFile(file.path)))).toEqual(before);
    await expect(verify(f, first.invocationId)).resolves.toMatchObject({ invocationId: first.invocationId });
  });

  it('refuses a deleted deliverable path even on another launcher without retryOf (direct-13)', async () => {
    const f = await fixture(); await f.launch();
    await unlink(f.final);
    const next = await nextPlan(f, f.final, 'bugfix'), launch = vi.fn();
    const { SessionLauncher } = await import('../../../tools/ralph-external/session-launcher.mjs');
    await expect(new SessionLauncher().launchWorker({ ...f.options, ...next, launchIsolated: launch }))
      .rejects.toThrow(/earlier attempt/);
    expect(launch).not.toHaveBeenCalled();
    await expect(lstat(f.final)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses reuse of a deleted run directory with fresh outputs (direct-06)', async () => {
    const f = await fixture(); await f.launch();
    const exit = await record(f.runDir, 'exit.json');
    await rm(f.runDir, { recursive: true, force: true });
    const next = await nextPlan(f), launch = vi.fn();
    await expect(f.launch({ ...next, runDir: f.runDir, launchIsolated: launch })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(launch).not.toHaveBeenCalled();
    expect(await readFile(exit.captureSeal.files[0].path)).toEqual(await readFile(exit.captureSeal.files[0].source));
  });

  it.each([false, true])('refuses a deleted live capture as another attempt deliverable (run replaced: %s)', async removeRun => {
    const f = await fixture(); await f.launch();
    const invocation = await record(f.runDir, 'invocation.json');
    if (removeRun) { await rm(f.runDir, { recursive: true, force: true }); await mkdir(f.runDir, { mode: 0o700 }); }
    else await unlink(invocation.captures.stdout);
    const next = await nextPlan(f, invocation.captures.stdout, 'bugfix'), launch = vi.fn();
    await expect(f.launch({ ...next, launchIsolated: launch })).rejects.toThrow(/earlier attempt/);
    expect(launch).not.toHaveBeenCalled();
    await expect(lstat(invocation.captures.stdout)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reserves each output even if opening a later capture fails', async () => {
    const f = await fixture(); let opens = 0;
    await expect(f.launch({ openCapture: async (...args: Parameters<typeof open>) => {
      if (++opens === 2) throw Object.assign(new Error('second capture refused'), { code: 'EACCES' });
      return open(...args);
    } })).rejects.toThrow('second capture refused');
    await unlink(f.plan.invocation!.stdoutPath!);
    const next = await nextPlan(f, f.plan.invocation!.stdoutPath, 'bugfix'), launch = vi.fn();
    await expect(f.launch({ ...next, launchIsolated: launch })).rejects.toThrow(/earlier attempt/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('permits a fresh linked retry only after verifying the retained predecessor seal', async () => {
    const f = await fixture(), first = await f.launch();
    const next = await nextPlan(f);
    // The fixture uses a file to synchronize the first worker's identity capture.
    const config = path.join(f.root, 'fake.json');
    const contents = JSON.parse(await readFile(config, 'utf8'));
    await writeFile(config, JSON.stringify({ ...contents, waitForIdentity: path.join(next.runDir, 'process.json') }));
    const second = await f.launch({ ...next, retryOf: { invocationId: first.invocationId, runDir: f.runDir } });
    const invocation = await record(next.runDir, 'invocation.json');
    expect(invocation.previousAttemptId).toBe(first.invocationId);
    expect(second.invocationId).not.toBe(first.invocationId);
    expect(second.captureSeal.directory).not.toBe(first.captureSeal.directory);
    await expect(verify(f, first.invocationId)).resolves.toMatchObject({ invocationId: first.invocationId });
  });

  it.each(['original', 'snapshot', 'missing-snapshot', 'permissions', 'missing-seal', 'manifest'])('verification and retry reject %s tampering', async kind => {
    const f = await fixture(), result = await f.launch();
    const exit = await record(f.runDir, 'exit.json'), file = exit.captureSeal.files[0];
    if (kind === 'original') await writeFile(file.source, 'changed raw capture');
    if (kind === 'snapshot') { await chmod(file.path, 0o600); await writeFile(file.path, 'changed retained capture'); await chmod(file.path, 0o400); }
    if (kind === 'missing-snapshot') { await chmod(exit.captureSeal.directory, 0o700); await unlink(file.path); await chmod(exit.captureSeal.directory, 0o500); }
    if (kind === 'permissions') await chmod(file.path, 0o600);
    if (kind === 'missing-seal') delete exit.captureSeal;
    if (kind === 'manifest') exit.captureSeal.files.pop();
    if (kind === 'missing-seal' || kind === 'manifest') await writeFile(path.join(f.runDir, 'exit.json'), JSON.stringify(exit));
    await expect(verify(f, result.invocationId)).rejects.toThrow(/capture seal verification failed/);
    const next = await nextPlan(f), launch = vi.fn();
    await expect(f.launch({ ...next, retryOf: { invocationId: result.invocationId, runDir: f.runDir }, launchIsolated: launch }))
      .rejects.toThrow(/capture seal verification failed/);
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([true, false])('retains a sealed partial capture after a pre-spawn failure (recovery %s)', async gated => {
    const f = await fixture(), launch = vi.fn();
    await expect(f.launch({ ...(gated ? {} : { scopedBreaker: null }), launchIsolated: launch,
      openCapture: async () => { throw Object.assign(new Error('synthetic capture failure'), { code: 'EACCES' }); } })).rejects.toThrow('synthetic capture failure');
    expect(launch).not.toHaveBeenCalled();
    const exit = await record(f.runDir, 'exit.json');
    expect(exit.captureSeal.files).toHaveLength(5);
    expect(exit.captureSeal.files.every((file: any) => file.missing)).toBe(true);
    await expect(verify(f, exit.invocationId)).resolves.toMatchObject({ descendants: 'not-started' });
  });
});
