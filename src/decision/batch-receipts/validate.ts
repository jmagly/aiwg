import { canonicalJson } from '../../security/artifact-trust.js';
import type { BatchAttempt, DecisionBatchReceipt } from './types.js';

const HASH = /^sha256:[0-9a-f]{64}$/;
const TERMINAL = new Set(['completed', 'failed', 'execution-uncertain']);
const TRANSITIONS: Record<DecisionBatchReceipt['status'], DecisionBatchReceipt['status'][]> = {
  acquired: ['running', 'failed'],
  running: ['running', 'completed', 'failed', 'execution-uncertain'],
  completed: [], failed: [], 'execution-uncertain': [],
};

export class BatchReceiptValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'BatchReceiptValidationError'; }
}

export function validateBatchReceipt(receipt: DecisionBatchReceipt): void {
  const ids = new Set(receipt.questionIds);
  if (receipt.schemaVersion !== 'decision-batch-receipt/v1'
    || !positive(receipt.revision) || !text(receipt.tenantId) || !text(receipt.projectId)
    || !text(receipt.batchId) || !text(receipt.invocationId) || !text(receipt.runId)
    || !HASH.test(receipt.plan.planDigest) || !text(receipt.plan.partitionId)
    || !HASH.test(receipt.subjectHash) || !HASH.test(receipt.stateHash)
    || !text(receipt.executionEnvelope) || !receipt.questionIds.length || ids.size !== receipt.questionIds.length
    || receipt.questionIds.some(id => !text(id))
    || !Number.isSafeInteger(receipt.createdAtEpochMs) || receipt.createdAtEpochMs < 0
    || !Number.isSafeInteger(receipt.updatedAtEpochMs) || receipt.updatedAtEpochMs < receipt.createdAtEpochMs
    || (TERMINAL.has(receipt.status) !== (receipt.terminalAtEpochMs !== null))
    || (receipt.terminalAtEpochMs !== null && (!Number.isSafeInteger(receipt.terminalAtEpochMs)
      || receipt.terminalAtEpochMs < receipt.createdAtEpochMs))) fail();
  receipt.attempts.forEach((attempt, index) => validateAttempt(attempt, index + 1));
  const answers = new Set<string>(); const referencedQuestions = new Set<string>(); const results = new Set<string>();
  for (const ref of receipt.answerReferences) {
    if (!ids.has(ref.questionId) || !text(ref.answerId) || !text(ref.resultId) || answers.has(ref.answerId)
      || referencedQuestions.has(ref.questionId) || results.has(ref.resultId)) fail();
    answers.add(ref.answerId); referencedQuestions.add(ref.questionId); results.add(ref.resultId);
  }
  if (receipt.allocations.length && receipt.allocations.length !== receipt.questionIds.length) fail();
  const allocationIds = new Set<string>();
  for (const allocation of receipt.allocations) {
    if (!ids.has(allocation.questionId) || allocationIds.has(allocation.questionId)
      || allocation.kind !== 'estimated' || allocation.algorithm !== 'largest-remainder-weighted'
      || allocation.algorithmVersion !== '1' || !nullableCount(allocation.inputTokens)
      || !nullableCount(allocation.outputTokens)) fail();
    allocationIds.add(allocation.questionId);
  }
  if (receipt.status === 'completed' && (receipt.questionIds.some(questionId =>
    !receipt.answerReferences.some(reference => reference.questionId === questionId))
    || !receipt.attempts.some(attempt => attempt.status === 'succeeded'))) fail();
  if (receipt.allocations.length) {
    const inputTotal = knownAttemptTotal(receipt, 'inputTokens');
    const outputTotal = knownAttemptTotal(receipt, 'outputTokens');
    if (inputTotal === null ? receipt.allocations.some(item => item.inputTokens !== null)
      : receipt.allocations.some(item => item.inputTokens === null)
        || receipt.allocations.reduce((sum, item) => sum + item.inputTokens!, 0) !== inputTotal) fail();
    if (outputTotal === null ? receipt.allocations.some(item => item.outputTokens !== null)
      : receipt.allocations.some(item => item.outputTokens === null)
        || receipt.allocations.reduce((sum, item) => sum + item.outputTokens!, 0) !== outputTotal) fail();
  }
}

export function validateBatchReceiptTransition(previous: DecisionBatchReceipt, next: DecisionBatchReceipt): void {
  validateBatchReceipt(previous); validateBatchReceipt(next);
  if (next.revision !== previous.revision + 1 || next.updatedAtEpochMs < previous.updatedAtEpochMs
    || !TRANSITIONS[previous.status].includes(next.status)) throw new BatchReceiptValidationError('Illegal batch receipt transition');
  const immutable = ['schemaVersion', 'tenantId', 'projectId', 'batchId', 'invocationId', 'runId', 'plan',
    'subjectHash', 'stateHash', 'executionEnvelope', 'questionIds', 'createdAtEpochMs'] as const;
  for (const key of immutable) if (canonicalJson(previous[key]) !== canonicalJson(next[key])) {
    throw new BatchReceiptValidationError(`Immutable batch receipt field changed: ${key}`);
  }
  if (next.attempts.length < previous.attempts.length
    || previous.attempts.some((attempt, index) => canonicalJson(attempt) !== canonicalJson(next.attempts[index]))) {
    throw new BatchReceiptValidationError('Batch attempt chronology is append-only');
  }
  if (previous.answerReferences.some(ref => !next.answerReferences.some(candidate => canonicalJson(candidate) === canonicalJson(ref)))) {
    throw new BatchReceiptValidationError('Batch answer references are append-only');
  }
}

function validateAttempt(attempt: BatchAttempt, ordinal: number): void {
  if (attempt.ordinal !== ordinal || !text(attempt.adapterId) || !text(attempt.adapterVersion)
    || !text(attempt.requestedModel) || (attempt.actualModel !== null && !text(attempt.actualModel))
    || (attempt.providerRequestId !== null && !validOpaqueRequestId(attempt.providerRequestId))
    || !nullableTime(attempt.dispatchedAtEpochMs) || !nullableTime(attempt.completedAtEpochMs)
    || (attempt.dispatchedAtEpochMs !== null && attempt.completedAtEpochMs !== null
      && attempt.completedAtEpochMs < attempt.dispatchedAtEpochMs)
    || !nullableCount(attempt.usage.inputTokens) || !nullableCount(attempt.usage.outputTokens)
    || (attempt.status === 'not-sent' && (attempt.providerRequestId !== null || attempt.dispatchedAtEpochMs !== null))
    || (attempt.fallbackFromAttemptOrdinal !== null && (!positive(attempt.fallbackFromAttemptOrdinal)
      || attempt.fallbackFromAttemptOrdinal >= ordinal))) fail();
  const cost = attempt.cost;
  if (cost.kind === 'provider-authoritative' && !count(cost.amountMicros)) fail();
  if (cost.kind === 'client-derived' && (!count(cost.amountMicros) || !text(cost.priceCatalogId)
    || !text(cost.priceCatalogVersion) || !validIso(cost.effectiveAt))) fail();
  if (cost.kind === 'bounded-unknown' && (!count(cost.upperBoundMicros) || !text(cost.boundPolicyId)
    || !text(cost.boundPolicyVersion))) fail();
}

/** Provider IDs are opaque internal data: bounded printable ASCII, never an authorization key. */
export function validOpaqueRequestId(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && /^[\x21-\x7e]+$/.test(value);
}
function validIso(value: string): boolean { return !Number.isNaN(Date.parse(value)); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function nullableCount(value: unknown): boolean { return value === null || count(value); }
function nullableTime(value: unknown): boolean { return value === null || count(value); }
function knownAttemptTotal(receipt: DecisionBatchReceipt, key: keyof BatchAttempt['usage']): number | null {
  const values = receipt.attempts.map(attempt => attempt.usage[key]);
  return values.some(value => value === null) ? null : values.reduce<number>((sum, value) => sum + value!, 0);
}
function fail(): never { throw new BatchReceiptValidationError('Invalid batch receipt'); }
