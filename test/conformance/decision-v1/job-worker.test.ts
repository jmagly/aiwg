import { describe, expect, it } from 'vitest';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { DecisionJobRuntime, recount } from '../../../src/decision/job-runtime.js';
import { FileJobStore, JobConflictError, MemoryJobStore } from '../../../src/decision/job-store.js';
import { OfflineJobWorker } from '../../../src/decision/job-worker.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const digest = `sha256:${'a'.repeat(64)}` as const;
const scope = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' };
function fixture(): DecisionJob {
  const job: DecisionJob = { schemaVersion: 'decision-job/v1', id: 'jobA', scope, fingerprint: digest,
    state: 'validating', createdAtEpochMs: 10, expiresAtEpochMs: 100,
    budget: { maxAttempts: 2, maxTokens: 100, maxCostMicros: 10000, maxConcurrency: 2 },
    items: ['subjectA', 'subjectB'].map((id, index) => ({ id, fingerprint: digest,
      subjectDigest: `sha256:${String(index + 1).repeat(64)}`, definitionDigest: digest, bindingDigest: digest,
      state: 'queued', attempts: [] })),
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'] };
  recount(job); return job;
}
async function queued(runtime: DecisionJobRuntime) {
  const initial = await runtime.submit(fixture(), scope);
  const next = structuredClone(initial.job); next.state = 'queued';
  return runtime.advance(scope, 'jobA', initial, next);
}
const success = { state: 'succeeded', receiptDigest: digest, resultDigest: digest } as const;
const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
describe('JOB fenced offline executor', () => {
  it('finishes out of order by item ID without sharing distinct subject state', async () => {
    const runtime = new DecisionJobRuntime(new MemoryJobStore(), () => 20);
    await queued(runtime);
    const worker = new OfflineJobWorker(runtime);
    const gate = barrier();
    const started = barrier();
    const first = worker.run(scope, 'jobA', 'subjectA', async (item) => {
      expect(item.subjectDigest).toBe(`sha256:${'1'.repeat(64)}`);
      started.release(); await gate.promise; return success;
    });
    await started.promise;
    const second = await worker.run(scope, 'jobA', 'subjectB', async (item) => {
      expect(item.subjectDigest).toBe(`sha256:${'2'.repeat(64)}`); return { ...success, state: 'review' };
    });
    expect(second.job.items.map(item => item.state)).toEqual(['running', 'review']);
    gate.release();
    const final = await first;
    expect(final.job.state).toBe('completed');
    expect(final.job.items.map(item => item.id)).toEqual(['subjectA', 'subjectB']);
    expect(final.job.summary.succeeded).toBe(1);
    expect(final.job.summary.review).toBe(1);
    await expect(worker.run(scope, 'jobA', 'subjectA', async () => success)).rejects.toThrow(JobConflictError);
  });
  it('enforces the per-job concurrency ceiling before any executor call', async () => {
    const runtime = new DecisionJobRuntime(new MemoryJobStore(), () => 20);
    const initial = await runtime.submit({ ...fixture(), budget: { ...fixture().budget, maxConcurrency: 1 } }, scope);
    const next = structuredClone(initial.job); next.state = 'queued';
    await runtime.advance(scope, 'jobA', initial, next);
    const worker = new OfflineJobWorker(runtime); const gate = barrier(); const started = barrier();
    const first = worker.run(scope, 'jobA', 'subjectA', async () => { started.release(); await gate.promise; return success; });
    await started.promise;
    let secondCalls = 0;
    await expect(worker.run(scope, 'jobA', 'subjectB', async () => { secondCalls++; return success; })).rejects.toThrow(JobConflictError);
    expect(secondCalls).toBe(0);
    gate.release(); await first;
    const second = await worker.run(scope, 'jobA', 'subjectB', async () => { secondCalls++; return success; });
    expect(secondCalls).toBe(1);
    expect(second.job.state).toBe('completed');
  });
  it('fences duplicate dispatch, cancellation aborts pending work and keeps unknown evidence', async () => {
    const runtime = new DecisionJobRuntime(new MemoryJobStore(), () => 20);
    await queued(runtime);
    const worker = new OfflineJobWorker(runtime); const gate = barrier(); const started = barrier();
    let calls = 0;
    const first = worker.run(scope, 'jobA', 'subjectA', async (_item, signal) => {
      calls++; started.release(); await gate.promise;
      expect(signal.aborted).toBe(true); return success;
    });
    await started.promise;
    await expect(worker.run(scope, 'jobA', 'subjectA', async () => { calls++; return success; })).rejects.toThrow(JobConflictError);
    const canceled = await worker.cancel(scope, 'jobA');
    expect(canceled?.job.items.map(item => item.state)).toEqual(['running', 'canceled']);
    gate.release();
    const final = await first;
    expect(final.job.state).toBe('failed');
    expect(final.job.items[0]?.state).toBe('execution-unknown');
    expect(calls).toBe(1);
  });
  it('survives a restart after durable dispatch fence without executing again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-worker-'));
    try {
      const runtime = new DecisionJobRuntime(new FileJobStore(dir), () => 20);
      await queued(runtime);
      const worker = new OfflineJobWorker(runtime); const gate = barrier(); const started = barrier();
      const first = worker.run(scope, 'jobA', 'subjectA', async () => { started.release(); await gate.promise; return success; });
      await started.promise;
      const restarted = new DecisionJobRuntime(new FileJobStore(dir), () => 20);
      const recovery = await restarted.reconcile(scope, 'jobA');
      expect(recovery?.job.items[0]?.state).toBe('execution-unknown');
      await expect(new OfflineJobWorker(restarted).run(scope, 'jobA', 'subjectA', async () => success)).rejects.toThrow(JobConflictError);
      gate.release();
      await expect(first).rejects.toThrow(JobConflictError);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('fails closed on invalid result reference and thrown executor', async () => {
    const runtime = new DecisionJobRuntime(new MemoryJobStore(), () => 20);
    await queued(runtime);
    const worker = new OfflineJobWorker(runtime);
    const first = await worker.run(scope, 'jobA', 'subjectA', async () => ({ state: 'succeeded' }));
    expect(first.job.items[0]?.state).toBe('execution-unknown');
    const second = await worker.run(scope, 'jobA', 'subjectB', async () => { throw new Error('possibly sent'); });
    expect(second.job.items[1]?.state).toBe('execution-unknown');
    expect(second.job.state).toBe('failed');
  });
});
