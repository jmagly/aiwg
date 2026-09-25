import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewConflictError } from '../../../src/decision/review/index.js';
import {
  REVIEW_ID, TOKEN, actor, createInput, effectId, executor, openLedger, openService, openStore, paths, requester, tenant,
} from './fixtures/review-process.js';

// HITL cross-process concurrency and real kill/restart (#2606 AC5, AC6, evidence plan).
// Children run the real FileDecisionReviewStore over one directory. Races start
// from a stdin barrier released only after every child is ready, so no child is
// scheduled by a timer. Crash children report their crash point on stdout,
// block the thread at a store fault seam or inside the executor, and are then
// SIGKILLed; the parent restarts from disk. No test sleeps on the wall clock.
const script = fileURLToPath(new URL('./fixtures/review-process-child.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('../../../', import.meta.url));
const directories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'review-process-')); directories.push(dir); return dir; }
function child(args: string[]) {
  const proc = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd, stdio: 'pipe' });
  children.push(proc);
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += String(chunk); });
  const lines: unknown[] = [];
  const waiters: Array<() => void> = [];
  createInterface({ input: proc.stdout }).on('line', line => { lines.push(JSON.parse(line)); waiters.splice(0).forEach(fn => fn()); });
  const next = async (index: number) => {
    while (lines.length <= index) {
      if (proc.exitCode !== null) throw new Error(`child exited early: ${stderr.slice(0, 500)}`);
      await new Promise<void>(resolve => { waiters.push(resolve); proc.once('exit', () => resolve()); });
    }
    return lines[index] as Record<string, unknown>;
  };
  return { proc, next, stderr: () => stderr };
}
/** Start N children, wait until each is ready, then release all of them at once. */
async function race(count: number, args: (index: number) => string[]) {
  const racers = Array.from({ length: count }, (_, index) => child(args(index)));
  for (const racer of racers) expect(await racer.next(0)).toHaveProperty('ready');
  for (const racer of racers) racer.proc.stdin.write('go\n');
  const results = await Promise.all(racers.map(racer => racer.next(1)));
  await Promise.all(racers.map(racer => racer.proc.exitCode === null ? once(racer.proc, 'exit') : undefined));
  return results;
}
async function effectLines(dir: string) {
  try { return (await readFile(paths(dir).effects, 'utf8')).split('\n').filter(Boolean); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
/** Run one crash step in a child, wait for it to report its crash point, and SIGKILL it there. */
async function crashAt(dir: string, step: string) {
  const crashing = child(['crash', dir, step]);
  expect(await crashing.next(0)).toEqual({ crashPoint: step });
  crashing.proc.kill('SIGKILL');
  if (crashing.proc.exitCode === null && crashing.proc.signalCode === null) await once(crashing.proc, 'exit');
  expect(crashing.proc.signalCode).toBe('SIGKILL');
}
const reviewer = actor('reviewer-a', 'reviewer');
let clock = 5_000;
const restarted = (dir: string) => openService(dir, () => clock);
async function seed(dir: string, through: 'created' | 'approved') {
  const service = restarted(dir);
  await service.create(requester, createInput());
  if (through === 'approved') await service.decide(reviewer, REVIEW_ID, 'approve', 'approve');
}
const countingExecutor = (calls: { count: number }) => async () => { calls.count += 1; return { delivered: true }; };

describe('HITL cross-process review concurrency', () => {
  it('HITL-CNC-PROC-01 four processes racing claim produce exactly one claimant', async () => {
    const dir = await directory(); clock = 5_000;
    await seed(dir, 'created');
    const results = await race(4, index => ['race-claim', dir, `reviewer-${index}`]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    for (const result of results.filter(item => !item.ok)) {
      expect(result).toEqual({ ok: false, name: 'ReviewConflictError', message: 'Review already claimed' });
    }
    const stored = (await openStore(dir).read(REVIEW_ID, tenant.tenantId, tenant.projectId))!;
    expect(stored.status).toBe('claimed');
    expect(stored.events.filter(event => event.type === 'claimed')).toHaveLength(1);
  }, 60_000);

  it('HITL-CNC-PROC-02 four processes racing resume dispatch exactly one effect and share its receipt', async () => {
    const dir = await directory(); clock = 5_000;
    await seed(dir, 'approved');
    const results = await race(4, () => ['race-resume', dir]);
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ ok: true, effectId })));
    expect(await effectLines(dir)).toHaveLength(1);
    const stored = (await openStore(dir).read(REVIEW_ID, tenant.tenantId, tenant.projectId))!;
    expect(stored.status).toBe('completed');
    expect(stored.events.filter(event => event.type === 'resumed')).toHaveLength(1);
  }, 60_000);
});

describe('HITL real kill and restart', () => {
  it('HITL-KILL-01 a kill before creation publishes leaves no review, and creation can be retried', async () => {
    const dir = await directory(); clock = 5_000;
    await crashAt(dir, 'create-before-publication');
    expect(await openStore(dir).read(REVIEW_ID, tenant.tenantId, tenant.projectId)).toBeNull();
    await expect(restarted(dir).create(requester, createInput())).resolves.toMatchObject({ revision: 1, status: 'pending' });
  }, 60_000);

  it('HITL-KILL-02 kills after creation, claim and decision publish keep each transition and resume once', async () => {
    const dir = await directory(); clock = 5_000;
    await crashAt(dir, 'create');
    expect(await openStore(dir).read(REVIEW_ID, tenant.tenantId, tenant.projectId)).toMatchObject({ revision: 1, status: 'pending' });
    await crashAt(dir, 'claim');
    const claimed = (await openStore(dir).read(REVIEW_ID, tenant.tenantId, tenant.projectId))!;
    expect(claimed).toMatchObject({ revision: 2, status: 'claimed' });
    // The same claimant's retry after restart returns the durable claim without a new event.
    expect((await restarted(dir).claim(reviewer, REVIEW_ID, 'claim')).revision).toBe(2);
    await crashAt(dir, 'decide');
    expect(await openStore(dir).read(REVIEW_ID, tenant.tenantId, tenant.projectId)).toMatchObject({ revision: 3, status: 'approved' });
    const calls = { count: 0 };
    const receipt = await restarted(dir).resume(executor, REVIEW_ID, TOKEN, countingExecutor(calls));
    expect(await restarted(dir).resume(executor, REVIEW_ID, TOKEN, countingExecutor(calls))).toEqual(receipt);
    expect(calls.count).toBe(1);
  }, 90_000);

  it('HITL-KILL-03 a kill after dispatch and before any effect stays unknown and never redispatches', async () => {
    const dir = await directory(); clock = 5_000;
    await seed(dir, 'approved');
    await crashAt(dir, 'dispatched');
    expect(await openStore(dir).read(REVIEW_ID, tenant.tenantId, tenant.projectId)).toMatchObject({ status: 'resuming' });
    clock = 5_000 + 1_000; // past the resuming lease
    const calls = { count: 0 };
    await expect(restarted(dir).resume(executor, REVIEW_ID, TOKEN, countingExecutor(calls)))
      .rejects.toThrow(new ReviewConflictError('Stale continuation requires effect reconciliation'));
    const ledger = openLedger(dir);
    await expect(restarted(dir).resume(executor, REVIEW_ID, TOKEN, countingExecutor(calls),
      id => ledger.completedReceipt({ ...tenant, reviewId: REVIEW_ID, effectId: id })))
      .rejects.toThrow('Effect outcome remains unknown');
    expect(calls.count).toBe(0);
    expect(await effectLines(dir)).toEqual([]);
    expect(await openStore(dir).read(REVIEW_ID, tenant.tenantId, tenant.projectId)).toMatchObject({ status: 'resuming' });
  }, 60_000);

  it('HITL-KILL-04 a kill after the effect and before the review receipt reconciles from the executor journal', async () => {
    const dir = await directory(); clock = 5_000;
    await seed(dir, 'approved');
    await crashAt(dir, 'post-effect');
    expect(await effectLines(dir)).toHaveLength(1);
    expect(await openStore(dir).read(REVIEW_ID, tenant.tenantId, tenant.projectId)).toMatchObject({ status: 'resuming' });
    clock = 5_000 + 1_000;
    const ledger = openLedger(dir);
    const reconcile = (id: string) => ledger.completedReceipt({ ...tenant, reviewId: REVIEW_ID, effectId: id });
    const calls = { count: 0 };
    const receipt = await restarted(dir).resume(executor, REVIEW_ID, TOKEN, countingExecutor(calls), reconcile);
    expect(receipt).toMatchObject({ effectId, result: { delivered: true, effectId } });
    expect(await restarted(dir).resume(executor, REVIEW_ID, TOKEN, countingExecutor(calls), reconcile)).toEqual(receipt);
    expect(calls.count).toBe(0);
    expect(await effectLines(dir)).toHaveLength(1);
    expect(await openStore(dir).read(REVIEW_ID, tenant.tenantId, tenant.projectId)).toMatchObject({ status: 'completed' });
  }, 60_000);
});
