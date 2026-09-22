import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planDecisionContext, type ContextTokenEstimator } from '../../../src/decision/context-plan.js';
import {
  FileBatchReceiptStore, MemoryBatchReceiptStore, allocateEstimatedUsage, batchAccountingTotals,
  batchEnforcementCostMicros, batchResultReference, deriveCost, newBatchReceipt, nextBatchReceipt, sanitizedBatchReceiptExport,
  validateBatchReceipt, type BatchAttempt, type DecisionBatchReceipt, type BatchReceiptStore,
} from '../../../src/decision/batch-receipts/index.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`;
const estimator: ContextTokenEstimator = { id: 'fixture', version: '1', estimate(value) {
  return { tokens: (value as { tokens: number }).tokens, serializedBytes: 1 };
} };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function base(questionIds = ['q1', 'q2', 'q3'], batchId = 'batch-1'): DecisionBatchReceipt {
  const plan = planDecisionContext({ subject: 'subject', authorizedState: { tokens: 10 }, authorizationDigest: hash('a'),
    incompleteContext: false, questions: questionIds.map(id => ({ id, subject: 'subject', entry: { tokens: 1 } })) },
  { id: 'jev', version: '2026-09-20', estimator: { id: 'fixture', version: '1' },
    limits: { aggregateTokens: 1_000, stateAndLongestQuestionTokens: 1_000 }, safetyMarginBps: 0, requestEnvelopeTokens: 1 }, estimator);
  return newBatchReceipt({ tenantId: 'tenant', projectId: 'project', batchId, invocationId: 'invocation', runId: 'run',
    contextPlan: plan, partition: plan.partitions[0]!, nativeBatchGroupId: 'batch_012345678901234567890123',
    subjectHash: hash('b'), executionEnvelope: 'https://api.example.test', nowEpochMs: 100 });
}

function attempt(overrides: Partial<BatchAttempt> = {}): BatchAttempt {
  return { ordinal: 1, adapterId: 'jev', adapterVersion: '2026-09-20', requestedModel: 'jev-1', actualModel: 'jev-1',
    providerRequestId: 'req_opaque', status: 'succeeded', dispatchedAtEpochMs: 110, completedAtEpochMs: 120,
    usage: { inputTokens: 10, outputTokens: 5 }, cost: { kind: 'provider-authoritative', currency: 'USD', amountMicros: 3 },
    fallbackFromAttemptOrdinal: null, ...overrides };
}

function completed(receipt = base(), attempts = [attempt()]): DecisionBatchReceipt {
  const totals = attempts.reduce((usage, item) => ({
    inputTokens: usage.inputTokens! + item.usage.inputTokens!, outputTokens: usage.outputTokens! + item.usage.outputTokens!,
  }), { inputTokens: 0 as number | null, outputTokens: 0 as number | null });
  const running = receipt.status === 'acquired'
    ? nextBatchReceipt(receipt, { status: 'running', updatedAtEpochMs: 110 }) : receipt;
  return nextBatchReceipt(running, { status: 'completed', updatedAtEpochMs: 130, attempts,
    answerReferences: running.questionIds.map((questionId, index) => ({ questionId, answerId: `answer-${index}`, resultId: `result-${index}` })),
    allocations: allocateEstimatedUsage(running.questionIds, totals) });
}

describe('decision batch receipts', () => {
  it('REC-BATCH-001 owns one request total and exposes three reference-only answer links', () => {
    const receipt = completed();
    expect(receipt.attempts).toHaveLength(1);
    expect(receipt.attempts[0]).toMatchObject({ providerRequestId: 'req_opaque', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(receipt.answerReferences).toHaveLength(3);
    expect(batchResultReference(receipt, 'q2')).toEqual({ schemaVersion: 'decision-batch-result-ref/v1',
      batchId: 'batch-1', receiptRevision: 3, questionId: 'q2', answerId: 'answer-1' });
    expect(batchResultReference(receipt, 'q2')).not.toHaveProperty('usage');
  });

  it('REC-BATCH-002 allocations are explicitly estimated and reconcile with deterministic rounding', () => {
    const values = allocateEstimatedUsage(['z', 'a', 'm'], { inputTokens: 10, outputTokens: 2 });
    expect(values.every(value => value.kind === 'estimated' && value.algorithmVersion === '1')).toBe(true);
    expect(values.map(value => [value.questionId, value.inputTokens, value.outputTokens]))
      .toEqual([['z', 3, 0], ['a', 4, 1], ['m', 3, 1]]);
    expect(values.reduce((sum, value) => sum + value.inputTokens!, 0)).toBe(10);
    expect(values.reduce((sum, value) => sum + value.outputTokens!, 0)).toBe(2);
  });

  it('REC-BATCH-003 retains retry and fallback consumption without overwriting failed attempts', () => {
    const attempts = [attempt({ status: 'failed', usage: { inputTokens: 8, outputTokens: 0 },
      cost: { kind: 'bounded-unknown', currency: 'USD', upperBoundMicros: 8, boundPolicyId: 'budget', boundPolicyVersion: '1' } }),
    attempt({ ordinal: 2, providerRequestId: 'req_retry', usage: { inputTokens: 10, outputTokens: 5 },
      fallbackFromAttemptOrdinal: 1, cost: { kind: 'provider-authoritative', currency: 'USD', amountMicros: 3 } })];
    const receipt = completed(base(), attempts);
    expect(receipt.attempts.map(value => [value.providerRequestId, value.status])).toEqual([['req_opaque', 'failed'], ['req_retry', 'succeeded']]);
    expect(batchAccountingTotals(receipt)).toEqual({ usage: { inputTokens: 18, outputTokens: 5 },
      cost: { knownAmountMicros: 3, unknownAttemptCount: 1, conservativeUpperBoundMicros: 11 } });
  });

  it('REC-BATCH-004 keeps missing usage and cost unknown and never zero-by-default', () => {
    const receipt = nextBatchReceipt(base(), { status: 'failed', updatedAtEpochMs: 130,
      attempts: [attempt({ status: 'failed', usage: { inputTokens: null, outputTokens: null }, cost: { kind: 'unknown' } })] });
    expect(batchAccountingTotals(receipt)).toEqual({ usage: { inputTokens: null, outputTokens: null },
      cost: { knownAmountMicros: 0, unknownAttemptCount: 1, conservativeUpperBoundMicros: null } });
    expect(deriveCost({ inputTokens: null, outputTokens: 2 }, { id: 'jev-usd', version: '2026-09-20',
      effectiveAt: '2026-09-20T00:00:00Z', currency: 'USD', inputMicrosPerMillionTokens: 42_000,
      outputMicrosPerMillionTokens: 100_000 })).toEqual({ kind: 'unknown' });
  });

  it('REC-BATCH-005 pins the catalog and derives the reviewed USD 0.042 example exactly', () => {
    expect(deriveCost({ inputTokens: 1_000_000, outputTokens: 0 }, { id: 'jev-usd', version: '2026-09-20',
      effectiveAt: '2026-09-20T00:00:00Z', currency: 'USD', inputMicrosPerMillionTokens: 42_000,
      outputMicrosPerMillionTokens: 100_000 })).toEqual({ kind: 'client-derived', currency: 'USD', amountMicros: 42_000,
      priceCatalogId: 'jev-usd', priceCatalogVersion: '2026-09-20', effectiveAt: '2026-09-20T00:00:00Z' });
  });

  it('BCH-001 links split partitions to one plan without sharing receipt ownership', () => {
    const plan = planDecisionContext({ subject: 'subject', authorizedState: { tokens: 10 }, authorizationDigest: hash('a'),
      incompleteContext: false, questions: ['q1', 'q2'].map(id => ({ id, subject: 'subject', entry: { tokens: 10 } })) },
    { id: 'jev', version: '2026-09-20', estimator: { id: 'fixture', version: '1' },
      limits: { aggregateTokens: 25, stateAndLongestQuestionTokens: 25 }, safetyMarginBps: 0, requestEnvelopeTokens: 1 }, estimator);
    const create = (index: number) => newBatchReceipt({ tenantId: 'tenant', projectId: 'project', batchId: `partition-${index + 1}`,
      invocationId: 'invocation', runId: 'run', contextPlan: plan, partition: plan.partitions[index]!, subjectHash: hash('b'),
      executionEnvelope: 'https://api.example.test', nowEpochMs: 100 });
    const first = create(0); const second = create(1);
    expect(first.plan.planDigest).toBe(second.plan.planDigest);
    expect(first.plan.partitionId).not.toBe(second.plan.partitionId);
    expect(new Set([first.batchId, second.batchId]).size).toBe(2);
    expect(batchAccountingTotals(completed(first)).usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(batchAccountingTotals(completed(second)).usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('sanitizes exports, contains malformed request IDs, and cannot use allocations as budget evidence', () => {
    const receipt = completed();
    const exported = sanitizedBatchReceiptExport(receipt, 'deployment-salt-1');
    expect(JSON.stringify(exported)).not.toContain('req_opaque');
    expect(exported.attempts[0]!.providerRequestIdHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(exported).not.toHaveProperty('rawState'); expect(exported).not.toHaveProperty('responseBody');
    const malformed = structuredClone(receipt); malformed.attempts[0]!.providerRequestId = 'x'.repeat(257);
    expect(() => validateBatchReceipt(malformed)).toThrow(/Invalid batch receipt/);
    const altered = { ...receipt, allocations: allocateEstimatedUsage(receipt.questionIds, { inputTokens: 999, outputTokens: 999 }) };
    expect(() => validateBatchReceipt(altered)).toThrow(/Invalid batch receipt/);
    expect(batchAccountingTotals(receipt).usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(batchEnforcementCostMicros(receipt)).toBe(3);
    expect(batchEnforcementCostMicros({ ...receipt, allocations: [] })).toBe(3);
  });

  it.each([['memory', () => new MemoryBatchReceiptStore()], ['file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'batch-receipts-')); directories.push(directory); return new FileBatchReceiptStore(directory);
  }]] as const)('replays stable identity and permits one CAS owner in %s store', async (_name, create) => {
    const store: BatchReceiptStore = await create(); const initial = base();
    const acquisitions = await Promise.all([store.acquire(initial), store.acquire(structuredClone(initial))]);
    expect(acquisitions.map(result => result.owner).sort()).toEqual([false, true]);
    expect(acquisitions[0]!.receipt).toEqual(acquisitions[1]!.receipt);
    const running = nextBatchReceipt(initial, { status: 'running', updatedAtEpochMs: 110 });
    const candidates = await Promise.all([store.compareAndSwap(initial, running), store.compareAndSwap(initial, running)]);
    expect(candidates.sort()).toEqual([false, true]);
    expect(await store.read(initial.batchId, initial.tenantId, initial.projectId)).toEqual(running);
  });

  it('BCH-005 replays durable revisions after restart and ignores a crashed unpublished temporary write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'batch-receipts-restart-')); directories.push(directory);
    const first = new FileBatchReceiptStore(directory); const initial = base(); await first.acquire(initial);
    const running = nextBatchReceipt(initial, { status: 'running', updatedAtEpochMs: 110 });
    expect(await first.compareAndSwap(initial, running)).toBe(true);
    await writeFile(join(directory, '.batch-receipt-crashed.tmp'), '{partial');
    const restarted = new FileBatchReceiptStore(directory);
    expect(await restarted.read(initial.batchId, initial.tenantId, initial.projectId)).toEqual(running);
    expect((await restarted.acquire(initial)).owner).toBe(false);
  });

  it('fails closed when a replay reuses a batch ID for different immutable identity', async () => {
    const store = new MemoryBatchReceiptStore(); const initial = base(); await store.acquire(initial);
    const collision = structuredClone(initial); collision.runId = 'different-run';
    await expect(store.acquire(collision)).rejects.toThrow(/another immutable receipt identity/);
  });
});
