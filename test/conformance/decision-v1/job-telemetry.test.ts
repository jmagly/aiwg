import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { DecisionJobRuntime, recount } from '../../../src/decision/job-runtime.js';
import { FileJobStore, MemoryJobStore, type JobStore } from '../../../src/decision/job-store.js';
import { OfflineJobWorker } from '../../../src/decision/job-worker.js';
import type { DecisionTelemetrySpan } from '../../../src/decision/telemetry/types.js';
const digest = `sha256:${'a'.repeat(64)}` as const;
const scope = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'CANARY_SECRET_2610' };
const goldens = JSON.parse(await readFile(new URL('./fixtures/job-traces.v1.json', import.meta.url), 'utf8')) as Record<string, unknown>;
function job(id: string, count: number): DecisionJob {
  const value: DecisionJob = { schemaVersion: 'decision-job/v1', id, scope, fingerprint: digest,
    state: 'validating', createdAtEpochMs: 10, expiresAtEpochMs: 100,
    items: Array.from({ length: count }, (_, i) => ({ id: `CANARY_ITEM_${i}`, fingerprint: digest,
      subjectDigest: digest, definitionDigest: digest, bindingDigest: digest, state: 'queued' as const, attempts: [] })),
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'],
    budget: { maxAttempts: 3, maxTokens: 1000, maxCostMicros: 1000, maxConcurrency: 2 } };
  recount(value); return value;
}
function fixture(store: JobStore = new MemoryJobStore()) {
  const spans: DecisionTelemetrySpan[] = []; let now = 20;
  const runtime = () => new DecisionJobRuntime(store, () => now, { emit(span) { spans.push(span); } });
  return { spans, runtime, setNow: (time: number) => { now = time; } };
}
async function enqueue(runtime: DecisionJobRuntime, value: DecisionJob) {
  const initial = await runtime.submit(value, scope);
  const queued = structuredClone(initial.job); queued.state = 'queued';
  return runtime.advance(scope, value.id, initial, queued);
}
function assertGolden(spans: DecisionTelemetrySpan[], name: string): void {
  expect(spans.map(span => [span.attributes['aiwg.job.operation'], span.attributes['aiwg.job.status'],
    span.attributes['aiwg.job.revision'], span.attributes['aiwg.job.unknown_count']])).toEqual(goldens[name]);
  for (const span of spans) {
    expect(span.name).toBe('decision.job');
    expect(span.status).toBe('ok');
    expect(Object.keys(span.attributes).sort()).toEqual([
      'aiwg.job.item_count', 'aiwg.job.operation', 'aiwg.job.revision', 'aiwg.job.status', 'aiwg.job.unknown_count']);
    expect(JSON.stringify(span)).not.toMatch(/CANARY|principal|project|item_id|job_id|queue_key/);
  }
}
describe('JOB D14 golden lifecycle traces', () => {
  it('records partial completion, eligible retry and final reconciliation without object identifiers', async () => {
    const { spans, runtime } = fixture(); const life = runtime();
    await enqueue(life, job('job-a', 2));
    const worker = new OfflineJobWorker(life);
    await worker.run(scope, 'job-a', 'CANARY_ITEM_0', async () => ({ state: 'succeeded', resultDigest: digest, receiptDigest: digest }));
    await worker.run(scope, 'job-a', 'CANARY_ITEM_1', async () => ({ state: 'retryable-failed', errorCode: 'TRANSIENT' }));
    await life.retry(scope, 'job-a', 'CANARY_ITEM_1');
    await worker.run(scope, 'job-a', 'CANARY_ITEM_1', async () => ({ state: 'review', resultDigest: digest, receiptDigest: digest }));
    expect((await life.poll(scope, 'job-a'))?.job.summary).toMatchObject({ succeeded: 1, review: 1 });
    assertGolden(spans, 'partial-retry-final');
  });
  it('records cancellation and expiry without claiming clean remote completion', async () => {
    const { spans, runtime, setNow } = fixture(); const life = runtime();
    await enqueue(life, job('job-b', 1));
    await life.cancel(scope, 'job-b'); setNow(101);
    await life.expire(scope, 'job-b');
    assertGolden(spans, 'cancel-expire');
  });
  it('restarts a real journal after a persisted dispatch fence and reconciles ambiguous execution once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'job-trace-restart-'));
    try {
      const { spans, runtime } = fixture(new FileJobStore(directory)); const life = runtime();
      const queued = await enqueue(life, job('job-c', 1));
      const inFlight = structuredClone(queued.job); inFlight.state = 'running';
      inFlight.items[0]!.state = 'running';
      inFlight.items[0]!.attempts.push({ id: randomUUID(), requestDigest: digest, outcome: 'dispatched' });
      recount(inFlight); await life.advance(scope, 'job-c', queued, inFlight);
      const restarted = new DecisionJobRuntime(new FileJobStore(directory), () => 20, { emit(span) { spans.push(span); } });
      expect((await restarted.reconcile(scope, 'job-c'))?.job.items[0]?.state).toBe('execution-unknown');
      await restarted.reconcile(scope, 'job-c');
      assertGolden(spans, 'restart-reconcile');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
