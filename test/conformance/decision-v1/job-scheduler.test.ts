import { describe, expect, it } from 'vitest';
import { OfflineJobScheduler } from '../../../src/decision/job-scheduler.js';
import { OfflineJobWorker } from '../../../src/decision/job-worker.js';
import { DecisionJobRuntime, recount } from '../../../src/decision/job-runtime.js';
import { MemoryJobStore, JobConflictError } from '../../../src/decision/job-store.js';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { SchedulerWaitError } from '../../../src/decision/scheduler.js';
const digest = `sha256:${'a'.repeat(64)}` as const;
const actor = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'a' };
function job(id: string, scope = actor, count = 1): DecisionJob {
  const value: DecisionJob = { schemaVersion: 'decision-job/v1', id, scope, fingerprint: digest, state: 'validating',
    createdAtEpochMs: 1, expiresAtEpochMs: 1000, budget: { maxAttempts: 2, maxTokens: 100, maxCostMicros: 1000, maxConcurrency: 2 },
    items: Array.from({ length: count }, (_, index) => ({ id: `item${index}`, fingerprint: digest,
      subjectDigest: digest, bindingDigest: digest, definitionDigest: digest, state: 'queued', attempts: [] })),
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'] };
  recount(value); return value;
}
async function submit(runtime: DecisionJobRuntime, value: DecisionJob) {
  const initial = await runtime.submit(value, value.scope);
  const queued = structuredClone(initial.job); queued.state = 'queued';
  await runtime.advance(value.scope, value.id, initial, queued);
}
describe('JOB bounded offline queue', () => {
  it('round-robins principals without starvation and preserves input-slot correlation', async () => {
    const runtime = new DecisionJobRuntime(new MemoryJobStore(), () => 2);
    const other = { ...actor, principalId: 'b' };
    await submit(runtime, job('many', actor, 2)); await submit(runtime, job('other', other));
    const order: string[] = [];
    const execute = (label: string) => async () => { order.push(label); return { state: 'succeeded' as const, resultDigest: digest, receiptDigest: digest }; };
    const queue = new OfflineJobScheduler(new OfflineJobWorker(runtime), 1, 3);
    const results = await queue.run([
      { actor, jobId: 'many', itemId: 'item0', executor: execute('a0') },
      { actor, jobId: 'many', itemId: 'item1', executor: execute('a1') },
      { actor: other, jobId: 'other', itemId: 'item0', executor: execute('b0') },
    ]);
    expect(order).toEqual(['a0', 'b0', 'a1']);
    expect(results.map(result => result instanceof SchedulerWaitError ? 'wait' : result.job.items[0]?.state)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect((await runtime.poll(actor, 'many'))?.job.summary.succeeded).toBe(2);
    expect((await runtime.poll(other, 'other'))?.job.summary.succeeded).toBe(1);
  });
  it('rejects queue saturation and duplicate IDs without executing callbacks', async () => {
    let calls = 0;
    const worker = new OfflineJobWorker(new DecisionJobRuntime(new MemoryJobStore(), () => 2));
    const scheduler = new OfflineJobScheduler(worker, 1, 1);
    const item = { actor, jobId: 'many', itemId: 'item0', executor: async () => {
      calls++; return { state: 'succeeded' as const, resultDigest: digest, receiptDigest: digest };
    } };
    await expect(scheduler.run([item, item])).rejects.toThrow(JobConflictError);
    const duplicate = new OfflineJobScheduler(worker, 1, 3);
    await expect(duplicate.run([item, item])).rejects.toThrow('Duplicate scheduled job item');
    expect(calls).toBe(0);
  });
  it('cancels queued items before the worker and never counts them as clean success', async () => {
    const runtime = new DecisionJobRuntime(new MemoryJobStore(), () => 2);
    await submit(runtime, job('many', actor, 2));
    let calls = 0;
    const cancelled = new AbortController(); cancelled.abort();
    const work = [0, 1].map(index => ({ actor, jobId: 'many', itemId: `item${index}`, executor: async () => {
      calls++; return { state: 'succeeded' as const, resultDigest: digest, receiptDigest: digest };
    } }));
    const result = await new OfflineJobScheduler(new OfflineJobWorker(runtime), 1, 2).run(work, { signal: cancelled.signal });
    expect(result).toHaveLength(2);
    expect(result.every(entry => entry instanceof SchedulerWaitError && entry.reason === 'cancelled')).toBe(true);
    expect(calls).toBe(0);
    expect((await runtime.poll(actor, 'many'))?.job.summary.queued).toBe(2);
  });
});
