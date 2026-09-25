import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/security/artifact-trust.js';
import { planDecisionContext, type ContextTokenEstimator } from '../../../src/decision/context-plan.js';
import { FileDecisionLifecycleStore } from '../../../src/decision/file-lifecycle-store.js';
import { DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, eraseDecisionSubject, placeDecisionLifecycleHold,
  type DecisionLifecyclePolicy } from '../../../src/decision/lifecycle.js';
import {
  BatchRecordUnavailableError, BatchStoreIntegrityError, BatchStoreMigrationRequiredError,
  FileBatchReceiptStore, FileBatchResultStore, MemoryBatchReceiptStore, MemoryBatchResultStore, allocateEstimatedUsage, batchAccountingTotals,
  batchEnforcementCostMicros, batchResultReference, deriveCost, macFor, newBatchReceipt, nextBatchReceipt, sanitizedBatchReceiptExport,
  BatchReceiptValidationError, assertBatchReceiptPortable, validateBatchReceipt, validateBatchReceiptTransition, type BatchAttempt,
  type DecisionBatchReceipt, type BatchReceiptStore, type FileBatchReceiptStoreOptions, type FileBatchResultStoreOptions,
} from '../../../src/decision/batch-receipts/index.js';
import type { AdapterObservation } from '../../../src/decision/types.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`;
const estimator: ContextTokenEstimator = { id: 'fixture', version: '1', estimate(value) {
  return { tokens: (value as { tokens: number }).tokens, serializedBytes: 1 };
} };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

const integrityKey = randomBytes(32);
const encryptionKey = randomBytes(32);
const clock = { now: 1_000 };
function lifecycle(retentionMs = 86_400_000, backup: 'not-persisted' | 'expire-with-primary' = 'expire-with-primary'): DecisionLifecyclePolicy {
  return { version: DECISION_LIFECYCLE_VERSION, surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
    classification: 'restricted', accessScopes: ['batch-owner'], retentionMs, export: 'denied', deletion: 'tombstone', backup,
  }])) as DecisionLifecyclePolicy['surfaces'] };
}
function resultStore(directory: string, overrides: Partial<FileBatchResultStoreOptions> = {}): FileBatchResultStore {
  return new FileBatchResultStore(directory, { integrityKey, lifecycle: lifecycle(), clock: () => clock.now,
    encryptionKeyReference: 'batch-results-2026', resolveEncryptionKey: async () => Buffer.from(encryptionKey), ...overrides });
}
function receiptStore(directory: string, overrides: Partial<FileBatchReceiptStoreOptions> = {}): FileBatchReceiptStore {
  return new FileBatchReceiptStore(directory, { integrityKey, lifecycle: lifecycle(), clock: () => clock.now, ...overrides });
}

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
  it('keeps an optional W3C traceparent immutable and rejects malformed values', () => {
    const traceParent = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`;
    const traced: DecisionBatchReceipt = { ...base(), traceParent };
    expect(() => validateBatchReceipt(traced)).not.toThrow();
    expect(nextBatchReceipt(traced, { status: 'running', updatedAtEpochMs: 110 }).traceParent).toBe(traceParent);
    for (const invalid of ['not-a-traceparent', `00-${'0'.repeat(32)}-${'2'.repeat(16)}-01`, ` ${traceParent}`]) {
      expect(() => validateBatchReceipt({ ...base(), traceParent: invalid })).toThrow();
    }
    const running = nextBatchReceipt(traced, { status: 'running', updatedAtEpochMs: 110 });
    const forged = { ...running, revision: running.revision + 1, traceParent: `00-${'3'.repeat(32)}-${'2'.repeat(16)}-01` };
    expect(() => validateBatchReceiptTransition(running, forged)).toThrow(/traceParent/);
  });

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

  it('REC-BATCH-002 reconciles weighted allocations across deterministic edge-case fixtures', () => {
    for (let count = 1; count <= 13; count++) {
      const ids = Array.from({ length: count }, (_, index) => `question-${index}`);
      const weights = Object.fromEntries(ids.map((id, index) => [id, index + 1]));
      for (const total of [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 1_000_000]) {
        const allocation = allocateEstimatedUsage(ids, { inputTokens: total, outputTokens: total + 1 }, weights);
        expect(allocation.reduce((sum, value) => sum + value.inputTokens!, 0)).toBe(total);
        expect(allocation.reduce((sum, value) => sum + value.outputTokens!, 0)).toBe(total + 1);
        expect(allocateEstimatedUsage(ids, { inputTokens: total, outputTokens: total + 1 }, weights)).toEqual(allocation);
      }
    }
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
    const poisoned = structuredClone(receipt);
    Object.assign(poisoned.plan, { privateReasoning: 'SECRET_DO_NOT_EXPORT' });
    Object.assign(poisoned.attempts[0]!, { privateReasoning: 'SECRET_DO_NOT_EXPORT' });
    Object.assign(poisoned.attempts[0]!.usage, { responseBody: 'SECRET_DO_NOT_EXPORT' });
    Object.assign(poisoned.attempts[0]!.cost, { credentials: 'SECRET_DO_NOT_EXPORT' });
    Object.assign(poisoned.answerReferences[0]!, { rawState: 'SECRET_DO_NOT_EXPORT' });
    Object.assign(poisoned.allocations[0]!, { privateReasoning: 'SECRET_DO_NOT_EXPORT' });
    expect(JSON.stringify(sanitizedBatchReceiptExport(poisoned, 'deployment-salt-1')))
      .not.toContain('SECRET_DO_NOT_EXPORT');
    const malformed = structuredClone(receipt); malformed.attempts[0]!.providerRequestId = 'x'.repeat(257);
    expect(() => validateBatchReceipt(malformed)).toThrow(/Invalid batch receipt/);
    const altered = { ...receipt, allocations: allocateEstimatedUsage(receipt.questionIds, { inputTokens: 999, outputTokens: 999 }) };
    expect(() => validateBatchReceipt(altered)).toThrow(/Invalid batch receipt/);
    expect(batchAccountingTotals(receipt).usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(batchEnforcementCostMicros(receipt)).toBe(3);
    expect(batchEnforcementCostMicros({ ...receipt, allocations: [] })).toBe(3);
  });

  it.each([['memory', () => new MemoryBatchReceiptStore()], ['file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'batch-receipts-')); directories.push(directory); return receiptStore(directory);
  }]] as const)('replays stable identity and permits one CAS owner in %s store', async (_name, create) => {
    const store: BatchReceiptStore = await create(); const initial = base();
    const acquisitions = await Promise.all([store.acquire(initial), store.acquire(structuredClone(initial))]);
    expect(acquisitions.map(result => result.owner).sort()).toEqual([false, true]);
    expect(acquisitions[0]!.receipt).toEqual(acquisitions[1]!.receipt);
    expect((await store.acquire({ ...initial, createdAtEpochMs: 101, updatedAtEpochMs: 101 })).owner).toBe(false);
    const running = nextBatchReceipt(initial, { status: 'running', updatedAtEpochMs: 110 });
    const candidates = await Promise.all([store.compareAndSwap(initial, running), store.compareAndSwap(initial, running)]);
    expect(candidates.sort()).toEqual([false, true]);
    expect(await store.read(initial.batchId, initial.tenantId, initial.projectId)).toEqual(running);
  });

  it('BCH-005 replays durable revisions after restart and ignores a crashed unpublished temporary write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'batch-receipts-restart-')); directories.push(directory);
    const first = receiptStore(directory); const initial = base(); await first.acquire(initial);
    const running = nextBatchReceipt(initial, { status: 'running', updatedAtEpochMs: 110 });
    expect(await first.compareAndSwap(initial, running)).toBe(true);
    await writeFile(join(directory, '.batch-receipt-crashed.tmp'), '{partial');
    const restarted = receiptStore(directory);
    expect(await restarted.read(initial.batchId, initial.tenantId, initial.projectId)).toEqual(running);
    expect((await restarted.acquire(initial)).owner).toBe(false);
  });

  it.each([['memory', async () => new MemoryBatchResultStore()], ['file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'batch-results-')); directories.push(directory);
    return resultStore(directory);
  }]] as const)('replays successful values and rejects conflicting publication in %s result store', async (_name, create) => {
    const store = await create();
    const receipt = completed();
    const observations = new Map(receipt.questionIds.map(questionId => [questionId, {
      status: 'success' as const, reason: 'none' as const, value: 'yes', uncertainty: null,
      actualModel: 'jev-1', requestId: null, usage: { inputTokens: null, outputTokens: null, costUsd: null },
    }]));
    await store.writeMany(receipt, observations);
    await store.writeMany(receipt, observations);
    expect((await store.readMany(receipt)).size).toBe(3);
    const changed = new Map(observations);
    changed.set(receipt.questionIds[0]!, { ...observations.get(receipt.questionIds[0]!)!, value: 'no' });
    await expect(store.writeMany(receipt, changed)).rejects.toThrow(/Conflicting batch result publication/);
    expect((await store.readMany(receipt)).get(receipt.questionIds[0]!)?.value).toBe('yes');
    expect((await store.readMany({ ...receipt, projectId: 'other-project' })).size).toBe(0);
    const withUsage = new Map(observations);
    withUsage.set(receipt.questionIds[0]!, { ...observations.get(receipt.questionIds[0]!)!,
      usage: { inputTokens: 10, outputTokens: null, costUsd: null } });
    await expect(store.writeMany(receipt, withUsage)).rejects.toThrow(/shared accounting/);
    const withRequestId = new Map(observations);
    withRequestId.set(receipt.questionIds[0]!, { ...observations.get(receipt.questionIds[0]!)!, requestId: 'req_opaque' });
    await expect(store.writeMany(receipt, withRequestId)).rejects.toThrow(/shared accounting/);
    await expect(store.writeMany(receipt, new Map([...observations].slice(0, 2))))
      .rejects.toThrow(/does not match receipt references/);
  });

  it('rejects insecure receipt directories and receipt files on replay', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'batch-receipt-permissions-')); directories.push(parent);
    const directory = join(parent, 'receipts');
    const store = receiptStore(directory);
    const receipt = base();
    await store.acquire(receipt);
    const name = (await readdir(directory)).find(candidate => candidate.endsWith('.json'))!;
    await chmod(join(directory, name), 0o644);
    await expect(store.read(receipt.batchId, receipt.tenantId, receipt.projectId))
      .rejects.toThrow(/Insecure batch receipt file/);
    await chmod(join(directory, name), 0o600);
    await chmod(directory, 0o755);
    await expect(store.read(receipt.batchId, receipt.tenantId, receipt.projectId))
      .rejects.toThrow(/Insecure batch receipt directory/);
    await expect(store.acquire(receipt)).rejects.toThrow(/Insecure batch receipt directory/);
    const link = join(parent, 'linked');
    await symlink(directory, link);
    await expect(receiptStore(link).read(receipt.batchId, receipt.tenantId, receipt.projectId))
      .rejects.toThrow(/Insecure batch receipt directory/);
  });

  it('rejects world-readable and symlinked result directories', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'batch-result-directory-')); directories.push(parent);
    const directory = join(parent, 'results');
    const store = resultStore(directory);
    const receipt = completed();
    await store.readMany(receipt);
    await chmod(directory, 0o755);
    await expect(store.readMany(receipt)).rejects.toThrow(/Insecure batch result directory/);
    await expect(store.writeMany(receipt, new Map())).rejects.toThrow(/Insecure batch result directory/);
    const link = join(parent, 'linked');
    await symlink(directory, link);
    await expect(resultStore(link).readMany(receipt)).rejects.toThrow(/Insecure batch result directory/);
  });

  it('rejects world-readable result snapshots on replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'batch-result-permissions-')); directories.push(directory);
    const store = resultStore(directory);
    const receipt = completed();
    const observations = new Map(receipt.questionIds.map(questionId => [questionId, {
      status: 'success' as const, reason: 'none' as const, value: 'yes', uncertainty: null,
      actualModel: 'jev-1', requestId: null, usage: { inputTokens: null, outputTokens: null, costUsd: null },
    }]));
    await store.writeMany(receipt, observations);
    const name = (await readdir(directory)).find(candidate => candidate.endsWith('.json'))!;
    await chmod(join(directory, name), 0o644);
    await expect(store.readMany(receipt)).rejects.toThrow(/Insecure batch result file/);
    await expect(store.writeMany(receipt, observations)).rejects.toThrow(/Insecure batch result file/);
  });

  it('fails closed when a replay reuses a batch ID for different immutable identity', async () => {
    const store = new MemoryBatchReceiptStore(); const initial = base(); await store.acquire(initial);
    const collision = structuredClone(initial); collision.runId = 'different-run';
    await expect(store.acquire(collision)).rejects.toThrow(/another immutable receipt identity/);
  });
});

const CANARY = 'CANARY-5e1f0c7d-decision-value';
function successObservations(receipt: DecisionBatchReceipt, value: unknown = CANARY): Map<string, AdapterObservation> {
  return new Map(receipt.questionIds.map(questionId => [questionId, {
    status: 'success' as const, reason: 'none' as const, value, uncertainty: null,
    actualModel: 'jev-1', requestId: null, usage: { inputTokens: null, outputTokens: null, costUsd: null },
  }]));
}
function scoped(overrides: Partial<Pick<DecisionBatchReceipt, 'tenantId' | 'projectId' | 'batchId'>>): DecisionBatchReceipt {
  return { ...base(), ...overrides };
}
async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix)); directories.push(directory); return directory;
}
async function sealedFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter(name => name.endsWith('.sealed.json')).sort();
}
/** Persist every revision of a completed receipt and its values, returning the chain. */
async function persistCompleted(receipts: FileBatchReceiptStore, results: FileBatchResultStore, initial = base(), value: unknown = CANARY) {
  const running = nextBatchReceipt(initial, { status: 'running', updatedAtEpochMs: 110 });
  const done = completed(running);
  expect((await receipts.acquire(initial)).owner).toBe(true);
  expect(await receipts.compareAndSwap(initial, running)).toBe(true);
  await results.writeMany(done, successObservations(done, value));
  expect(await receipts.compareAndSwap(running, done)).toBe(true);
  return { initial, running, done };
}
async function mutateJson(path: string, mutate: (value: Record<string, any>) => void): Promise<string> {
  const original = await readFile(path, 'utf8');
  const value = JSON.parse(original) as Record<string, any>;
  mutate(value);
  await writeFile(path, `${canonicalJson(value)}\n`);
  return original;
}

describe('batch store integrity, encryption and lifecycle (#2672)', () => {
  beforeEach(() => { clock.now = 1_000; });

  it('constructors fail closed without a 32-byte integrity key, lifecycle policy or key resolver', async () => {
    const directory = await temporary('batch-store-keys-');
    expect(() => new FileBatchReceiptStore(directory, undefined as never)).toThrow(/at least 32 bytes/);
    expect(() => new FileBatchReceiptStore(directory, { lifecycle: lifecycle() } as never)).toThrow(/at least 32 bytes/);
    expect(() => receiptStore(directory, { integrityKey: randomBytes(31) })).toThrow(/at least 32 bytes/);
    expect(() => new FileBatchResultStore(directory, undefined as never)).toThrow(/at least 32 bytes/);
    expect(() => resultStore(directory, { integrityKey: randomBytes(31) })).toThrow(/at least 32 bytes/);
    expect(() => receiptStore(directory, { lifecycle: undefined as never })).toThrow(/lifecycle policy is incomplete/);
    expect(() => resultStore(directory, { resolveEncryptionKey: undefined as never })).toThrow(/key resolver required/);
    expect(() => resultStore(directory, { encryptionKeyReference: '' })).toThrow(/key resolver required/);
    const shortKey = resultStore(directory, { resolveEncryptionKey: async () => randomBytes(16) });
    const receipt = completed();
    await expect(shortKey.writeMany(receipt, successObservations(receipt))).rejects.toThrow(/encryption key invalid/);
    expect(await sealedFiles(directory)).toEqual([]);
  });

  it('rejects any changed byte of a stored receipt revision with an opaque integrity error', async () => {
    const receiptDirectory = await temporary('batch-receipt-tamper-');
    const receipts = receiptStore(receiptDirectory);
    const results = resultStore(await temporary('batch-result-tamper-'));
    const { done } = await persistCompleted(receipts, results);
    const latest = join(receiptDirectory, (await sealedFiles(receiptDirectory)).find(name => name.includes('.r3.'))!);
    const mutations: Array<(envelope: Record<string, any>) => void> = [
      envelope => { envelope.receipt.attempts[0].usage.inputTokens = 11; },
      envelope => { envelope.receipt.tenantId = 'other-tenant'; },
      envelope => { envelope.receipt.revision = 4; },
      envelope => { envelope.receipt.answerReferences[0].answerId = 'answer-x'; },
      envelope => { envelope.receipt.status = 'failed'; },
      envelope => { envelope.mac = '0'.repeat(64); },
    ];
    for (const mutate of mutations) {
      const original = await mutateJson(latest, mutate);
      const failure = await receipts.read(done.batchId, done.tenantId, done.projectId).catch(error => error as Error);
      expect(failure).toBeInstanceOf(BatchStoreIntegrityError);
      expect((failure as Error).message).toBe('Batch store integrity check failed');
      // Replay must not become owner or fall back to an older revision.
      await expect(receipts.acquire(base())).rejects.toBeInstanceOf(BatchStoreIntegrityError);
      await writeFile(latest, original);
    }
    const original = await readFile(latest, 'utf8');
    await writeFile(latest, original.replace('{', '{ '));
    await expect(receipts.read(done.batchId, done.tenantId, done.projectId)).rejects.toBeInstanceOf(BatchStoreIntegrityError);
    await writeFile(latest, original);
    expect(await receipts.read(done.batchId, done.tenantId, done.projectId)).toEqual(done);
    await expect(receiptStore(receiptDirectory, { integrityKey: randomBytes(32) }).read(done.batchId, done.tenantId, done.projectId))
      .resolves.toBeNull();
  });

  it('rejects changed snapshot bytes without serving a partial or stale result', async () => {
    const resultDirectory = await temporary('batch-result-bytes-');
    const results = resultStore(resultDirectory);
    const receipt = completed();
    await results.writeMany(receipt, successObservations(receipt));
    const files = await sealedFiles(resultDirectory);
    expect(files).toHaveLength(3);
    const target = join(resultDirectory, files[1]!);
    const mutations: Array<(envelope: Record<string, any>) => void> = [
      envelope => { envelope.createdAtEpochMs += 1; },
      envelope => { envelope.keyReference = 'batch-results-other'; },
      envelope => { envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}${envelope.ciphertext.endsWith('AA') ? 'AB' : 'AA'}`; },
      envelope => { envelope.tag = Buffer.alloc(16).toString('base64url'); },
      envelope => { envelope.nonce = Buffer.alloc(12).toString('base64url'); },
    ];
    for (const mutate of mutations) {
      const original = await mutateJson(target, mutate);
      const failure = await results.readMany(receipt).catch(error => error as Error);
      expect(failure).toBeInstanceOf(BatchStoreIntegrityError);
      await writeFile(target, original);
    }
    // A ciphertext change that keeps the header MAC valid is caught by GCM authentication.
    const original = await mutateJson(target, envelope => {
      const bytes = Buffer.from(envelope.ciphertext, 'base64url'); bytes[0]! ^= 1;
      envelope.ciphertext = bytes.toString('base64url');
      const { mac: _mac, ...fields } = envelope;
      envelope.mac = macFor(integrityKey, 'decision-batch-result/v1', fields);
    });
    await expect(results.readMany(receipt)).rejects.toBeInstanceOf(BatchStoreIntegrityError);
    await writeFile(target, original);
    expect([...(await results.readMany(receipt)).values()].map(value => value.value)).toEqual([CANARY, CANARY, CANARY]);
    // The receipt revision (and so the answer set) is bound too.
    await expect(results.readMany({ ...receipt, revision: receipt.revision + 1 })).rejects.toBeInstanceOf(BatchStoreIntegrityError);
  });

  it('keeps answer values, canaries and scope identifiers out of every byte on disk', async () => {
    const receiptDirectory = await temporary('batch-at-rest-receipts-');
    const resultDirectory = await temporary('batch-at-rest-results-');
    await persistCompleted(receiptStore(receiptDirectory), resultStore(resultDirectory), base(), { verdict: 'approve', note: CANARY });
    const bytes = await Promise.all((await readdir(resultDirectory)).map(name => readFile(join(resultDirectory, name))));
    const disk = Buffer.concat(bytes).toString('latin1');
    for (const secret of [CANARY, 'approve', 'verdict', 'answer-0', 'result-0', 'batch-1', 'tenant', 'project']) {
      expect(disk).not.toContain(secret);
      expect(disk).not.toContain(Buffer.from(secret).toString('base64'));
    }
    expect((await readdir(receiptDirectory)).join('\n')).not.toMatch(/tenant|project|batch-1/);
    expect((await readdir(resultDirectory)).join('\n')).not.toMatch(/tenant|project|batch-1|q1/);
  });

  it('fails AAD verification when a snapshot moves to another tenant, project, batch or answer', async () => {
    const resultDirectory = await temporary('batch-result-aad-');
    const results = resultStore(resultDirectory);
    const source = completed();
    await results.writeMany(source, successObservations(source));
    const sourceFiles = await sealedFiles(resultDirectory);
    const sourceBytes = await readFile(join(resultDirectory, sourceFiles[0]!), 'utf8');
    // The envelope MAC is valid wherever the file lands, so any rejection comes from the GCM AAD.
    const { mac, ...fields } = JSON.parse(sourceBytes) as Record<string, string>;
    expect(macFor(integrityKey, 'decision-batch-result/v1', fields)).toBe(mac);
    for (const target of [completed(scoped({ tenantId: 'tenant-b' })), completed(scoped({ projectId: 'project-b' })),
      completed(scoped({ batchId: 'batch-b' }))]) {
      const before = new Set(await sealedFiles(resultDirectory));
      await results.writeMany(target, successObservations(target, 'other-value'));
      const added = (await sealedFiles(resultDirectory)).filter(name => !before.has(name));
      expect(added).toHaveLength(3);
      for (const name of added) await writeFile(join(resultDirectory, name), sourceBytes);
      await expect(results.readMany(target)).rejects.toBeInstanceOf(BatchStoreIntegrityError);
    }
    // Swap two answers inside the same batch.
    await writeFile(join(resultDirectory, sourceFiles[1]!), sourceBytes);
    await expect(results.readMany(source)).rejects.toBeInstanceOf(BatchStoreIntegrityError);
  });

  it('erases through the D10 journal with a body-free tombstone, blocks on legal hold and refuses restore', async () => {
    const receiptDirectory = await temporary('batch-erase-receipts-');
    const resultDirectory = await temporary('batch-erase-results-');
    const journalDirectory = await temporary('batch-erase-journal-');
    const results = resultStore(resultDirectory);
    const receipts = receiptStore(receiptDirectory, { results });
    const { done } = await persistCompleted(receipts, results);
    const backupReceipts = await temporary('batch-backup-receipts-');
    const backupResults = await temporary('batch-backup-results-');
    await cp(receiptDirectory, backupReceipts, { recursive: true });
    await cp(resultDirectory, backupResults, { recursive: true });

    const journal = new FileDecisionLifecycleStore(journalDirectory, { receipt: id => receipts.erase(id) });
    const reference = receipts.lifecycleReference(done.batchId, done.tenantId, done.projectId);
    expect(reference.opaqueId).toMatch(/^batch-receipt-[a-f0-9]{64}$/);
    await journal.register('subject-7', reference);
    const hold = await placeDecisionLifecycleHold({ subject: 'subject-7', reason: 'litigation', scope: ['receipt'],
      expiresAt: 5_000, authorizedBy: 'legal' }, async () => true, journal, clock.now);
    await expect(eraseDecisionSubject('subject-7', lifecycle(), journal, clock.now)).rejects.toThrow(/denied by hold/);
    expect(await receipts.read(done.batchId, done.tenantId, done.projectId)).toEqual(done);
    expect((await results.readMany(done)).size).toBe(3);
    await journal.releaseHold(hold, 'legal', 'matter closed', clock.now);

    const tombstones = await eraseDecisionSubject('subject-7', lifecycle(), journal, clock.now);
    expect(tombstones).toEqual([{ subject: 'subject-7', reference, deletedAt: clock.now }]);
    expect(await sealedFiles(receiptDirectory)).toEqual([]);
    expect(await sealedFiles(resultDirectory)).toEqual([]);
    const remaining = [...await readdir(receiptDirectory), ...await readdir(resultDirectory)];
    expect(remaining.every(name => name.endsWith('.tombstone'))).toBe(true);
    const markers = (await Promise.all([
      ...(await readdir(receiptDirectory)).map(name => readFile(join(receiptDirectory, name), 'utf8')),
      ...(await readdir(resultDirectory)).map(name => readFile(join(resultDirectory, name), 'utf8')),
    ])).join('\n');
    for (const secret of [CANARY, 'tenant', 'project', 'batch-1', 'answer-0', 'q1']) expect(markers).not.toContain(secret);

    // Later reads are indistinguishable from a batch that never existed.
    const never = completed(scoped({ batchId: 'never-written' }));
    expect(await receipts.read(done.batchId, done.tenantId, done.projectId)).toBeNull();
    expect(await receipts.read(never.batchId, never.tenantId, never.projectId)).toBeNull();
    expect(await results.readMany(done)).toEqual(await results.readMany(never));
    expect((await results.readMany(done)).size).toBe(0);
    await expect(results.writeMany(done, successObservations(done))).rejects.toBeInstanceOf(BatchRecordUnavailableError);
    await expect(receipts.acquire(base())).rejects.toBeInstanceOf(BatchRecordUnavailableError);

    // Restore through the store API is refused, and so is a raw file copy behind its back.
    expect(await receipts.restoreFrom(backupReceipts, await journal.tombstones('subject-7'))).toEqual({ restored: 0, refused: 1 });
    expect(await results.restoreFrom(backupResults)).toEqual({ restored: 0, refused: 3 });
    await cp(backupReceipts, receiptDirectory, { recursive: true });
    await cp(backupResults, resultDirectory, { recursive: true });
    expect(await receipts.read(done.batchId, done.tenantId, done.projectId)).toBeNull();
    expect((await results.readMany(done)).size).toBe(0);
    // Even with the local marker lost, the independent D10 journal tombstone keeps it erased.
    await rm(join(receiptDirectory, `${reference.opaqueId.slice('batch-receipt-'.length)}.tombstone`));
    const withAuthority = receiptStore(receiptDirectory, { results, isTombstoned: async candidate =>
      (await journal.tombstones('subject-7')).some(value => value.reference.opaqueId === candidate.opaqueId) });
    expect(await withAuthority.read(done.batchId, done.tenantId, done.projectId)).toBeNull();
    await expect(withAuthority.acquire(base())).rejects.toBeInstanceOf(BatchRecordUnavailableError);
    const failingAuthority = receiptStore(receiptDirectory, { results, isTombstoned: async () => { throw new Error('offline'); } });
    expect(await failingAuthority.read(done.batchId, done.tenantId, done.projectId)).toBeNull();
  });

  it('expires at retention, refuses expired restore, and sweeps only unheld receipts', async () => {
    const receiptDirectory = await temporary('batch-expiry-receipts-');
    const resultDirectory = await temporary('batch-expiry-results-');
    const results = resultStore(resultDirectory);
    const receipts = receiptStore(receiptDirectory, { results });
    const { done } = await persistCompleted(receipts, results);
    const backupReceipts = await temporary('batch-expiry-backup-receipts-');
    const backupResults = await temporary('batch-expiry-backup-results-');
    await cp(receiptDirectory, backupReceipts, { recursive: true });
    await cp(resultDirectory, backupResults, { recursive: true });
    const reference = receipts.lifecycleReference(done.batchId, done.tenantId, done.projectId);

    // Restoring a live backup before expiry is accepted and idempotent.
    expect(await receipts.restoreFrom(backupReceipts)).toEqual({ restored: 1, refused: 0 });
    expect(await results.restoreFrom(backupResults)).toEqual({ restored: 3, refused: 0 });
    await expect(receiptStore(receiptDirectory, { lifecycle: lifecycle(86_400_000, 'not-persisted') }).restoreFrom(backupReceipts))
      .rejects.toThrow(/denied by lifecycle policy/);

    clock.now = done.terminalAtEpochMs! + 86_400_000;
    expect(await receipts.read(done.batchId, done.tenantId, done.projectId)).toBeNull();
    expect((await results.readMany(done)).size).toBe(0);
    await expect(receipts.acquire(base())).rejects.toBeInstanceOf(BatchRecordUnavailableError);
    await rm(receiptDirectory, { recursive: true }); await rm(resultDirectory, { recursive: true });
    expect(await receipts.restoreFrom(backupReceipts)).toEqual({ restored: 0, refused: 1 });
    expect(await results.restoreFrom(backupResults)).toEqual({ restored: 0, refused: 3 });

    await cp(backupReceipts, receiptDirectory, { recursive: true });
    await cp(backupResults, resultDirectory, { recursive: true });
    expect(await receipts.sweepExpired(async candidate => candidate.opaqueId === reference.opaqueId)).toBe(0);
    expect(await receipts.sweepExpired(async () => { throw new Error('hold authority offline'); })).toBe(0);
    expect(await sealedFiles(receiptDirectory)).toHaveLength(3);
    expect(await receipts.sweepExpired(async () => false)).toBe(1);
    expect(await sealedFiles(receiptDirectory)).toEqual([]);
    expect(await sealedFiles(resultDirectory)).toEqual([]);
    await expect(receiptStore(receiptDirectory).erase(reference.opaqueId)).rejects.toThrow(/bound result store/);
    await expect(receipts.erase('batch-receipt-not-opaque')).rejects.toThrow(/reference invalid/);
  });

  it('refuses unkeyed legacy stores until an explicit authorized migration seals them', async () => {
    const receiptDirectory = await temporary('batch-legacy-receipts-');
    const resultDirectory = await temporary('batch-legacy-results-');
    const initial = base();
    const running = nextBatchReceipt(initial, { status: 'running', updatedAtEpochMs: 110 });
    const done = completed(running);
    const legacyPrefix = createHash('sha256').update(`tenant\u0000project\u0000${done.batchId}`).digest('hex');
    for (const receipt of [initial, running, done]) {
      await writeFile(join(receiptDirectory, `${legacyPrefix}.r${receipt.revision}.json`), `${canonicalJson(receipt)}\n`, { mode: 0o600 });
    }
    const observations = successObservations(done);
    for (const reference of done.answerReferences) {
      const snapshot = { schemaVersion: 'decision-batch-result/v1', tenantId: 'tenant', projectId: 'project', batchId: done.batchId,
        receiptRevision: done.revision, questionId: reference.questionId, answerId: reference.answerId, resultId: reference.resultId,
        observation: observations.get(reference.questionId), createdAtEpochMs: done.terminalAtEpochMs };
      const name = createHash('sha256').update(['tenant', 'project', done.batchId, reference.questionId, reference.answerId]
        .join('\u0000')).digest('hex');
      await writeFile(join(resultDirectory, `${name}.json`), `${canonicalJson(snapshot)}\n`, { mode: 0o600 });
    }
    const results = resultStore(resultDirectory);
    const receipts = receiptStore(receiptDirectory, { results });

    await expect(receipts.read(done.batchId, done.tenantId, done.projectId)).rejects.toBeInstanceOf(BatchStoreMigrationRequiredError);
    await expect(receipts.acquire(initial)).rejects.toBeInstanceOf(BatchStoreMigrationRequiredError);
    await expect(results.readMany(done)).rejects.toBeInstanceOf(BatchStoreMigrationRequiredError);
    await expect(results.writeMany(done, observations)).rejects.toBeInstanceOf(BatchStoreMigrationRequiredError);
    await expect(receipts.migrateLegacy(async () => false)).rejects.toThrow(/migration denied/);
    await expect(results.migrateLegacy(async () => { throw new Error('approver offline'); })).rejects.toThrow(/migration denied/);
    expect(await sealedFiles(receiptDirectory)).toEqual([]);
    expect(await sealedFiles(resultDirectory)).toEqual([]);

    const approvals: unknown[] = [];
    expect(await receipts.migrateLegacy(async summary => { approvals.push(summary); return true; })).toEqual({ migrated: 1 });
    expect(await results.migrateLegacy(async summary => { approvals.push(summary); return true; })).toEqual({ migrated: 3 });
    expect(approvals).toEqual([{ receipts: 1, revisions: 3 }, { results: 3 }]);
    expect(await receipts.read(done.batchId, done.tenantId, done.projectId)).toEqual(done);
    expect([...(await results.readMany(done)).values()].map(value => value.value)).toEqual([CANARY, CANARY, CANARY]);
    const disk = (await Promise.all((await readdir(resultDirectory)).map(name => readFile(join(resultDirectory, name), 'utf8')))).join('');
    expect(disk).not.toContain(CANARY);
    expect((await readdir(receiptDirectory)).some(name => name.startsWith(legacyPrefix))).toBe(false);

    // A corrupt legacy record is refused before authorization is even requested.
    await writeFile(join(receiptDirectory, `${'f'.repeat(64)}.r1.json`), '{"not":"a receipt"}\n', { mode: 0o600 });
    let asked = false;
    await expect(receipts.migrateLegacy(async () => { asked = true; return true; })).rejects.toBeInstanceOf(BatchStoreIntegrityError);
    expect(asked).toBe(false);
  });

  it('BCH-005 replays sealed values after a two-process restart and honours erase across processes', async () => {
    const receiptDirectory = join(await temporary('batch-process-'), 'receipts');
    const resultDirectory = join(await temporary('batch-process-'), 'results');
    const input = join(await temporary('batch-process-input-'), 'input.json');
    const initial = base();
    const running = nextBatchReceipt(initial, { status: 'running', updatedAtEpochMs: 110 });
    const done = completed(running);
    await writeFile(input, JSON.stringify({ chain: [initial, running, done], observations: [...successObservations(done)] }));
    const run = (mode: 'write' | 'read') => new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/decision/batch-store-process.mjs', receiptDirectory,
        resultDirectory, integrityKey.toString('hex'), encryptionKey.toString('hex'), input, mode],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let errors = '';
      child.stdout.on('data', chunk => { output += String(chunk); });
      child.stderr.on('data', chunk => { errors += String(chunk); });
      child.on('exit', code => code === 0 ? resolve(JSON.parse(output.trim().split('\n').at(-1)!) as Record<string, unknown>)
        : reject(new Error(errors)));
    });
    expect(await run('write')).toEqual({ written: true });
    const results = resultStore(resultDirectory);
    const receipts = receiptStore(receiptDirectory, { results });
    expect(await receipts.read(done.batchId, done.tenantId, done.projectId)).toEqual(done);
    expect((await results.readMany(done)).get('q1')?.value).toBe(CANARY);
    expect(await run('read')).toEqual({ status: 'completed', values: { q1: CANARY, q2: CANARY, q3: CANARY } });
    await receipts.erase(receipts.lifecycleReference(done.batchId, done.tenantId, done.projectId).opaqueId);
    expect(await run('read')).toEqual({ status: null, values: {} });
  }, 30_000);
});

describe('PRV-EGRESS-RECEIPT portable batch receipts', () => {
  // Assembled at runtime so no literal secret-shaped string lives in the source tree.
  const canary = 'CANARY' + 'k3Zp'.repeat(6);
  const fixtures: Array<[string, string]> = [
    ['bearer value', `Bearer ${canary}`],
    ['PEM private key', `-----BEGIN RSA ${'PRIVATE'} KEY-----${canary}`],
    ['vault locator', `secret://decision/${canary}`],
  ];

  it('PRV-EGRESS-RECEIPT-B01 rejects secret material in provider request ids and execution envelopes', () => {
    const running = nextBatchReceipt(base(), { status: 'running', updatedAtEpochMs: 110 });
    // Opaque request ids are printable ASCII without spaces, so this locator passes shape validation
    // and is rejected only by the portability guard.
    const locator = `vault://kv/${canary}`;
    expect(() => validateBatchReceipt({ ...running, attempts: [attempt({ providerRequestId: locator })] })).not.toThrow();
    let caught: unknown;
    try { nextBatchReceipt(running, { status: 'running', updatedAtEpochMs: 115, attempts: [attempt({ providerRequestId: locator })] }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(BatchReceiptValidationError);
    expect((caught as Error).message).toMatch(/forbidden credential or private-locator material/);
    expect((caught as Error).message).not.toContain(canary);
    for (const [label, value] of fixtures) {
      expect(() => assertBatchReceiptPortable({ ...running, executionEnvelope: value }), label).toThrow(BatchReceiptValidationError);
    }
  });

  it('PRV-EGRESS-RECEIPT-B02 rejects secret-derived hash keys', () => {
    const receipt = base();
    expect(() => assertBatchReceiptPortable({ ...receipt, plan: { ...receipt.plan, credentialHash: `sha256:${canary}` } as never }))
      .toThrow(/forbidden credential or private-locator material/);
  });

  it('PRV-EGRESS-RECEIPT-B03 benign control: completed receipts with opaque ids pass', () => {
    expect(() => assertBatchReceiptPortable(completed())).not.toThrow();
  });
});
