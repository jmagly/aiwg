import { createHash } from 'node:crypto';
import type { BatchCostEvidence, DecisionBatchReceipt } from './types.js';

export interface SanitizedBatchReceiptExport {
  schemaVersion: 'decision-batch-receipt-export/v1';
  batchId: string; invocationId: string; runId: string;
  plan: DecisionBatchReceipt['plan']; subjectHash: string; stateHash: string;
  questionIds: string[]; status: DecisionBatchReceipt['status']; createdAtEpochMs: number;
  updatedAtEpochMs: number; terminalAtEpochMs: number | null;
  attempts: Array<Omit<DecisionBatchReceipt['attempts'][number], 'providerRequestId'> & { providerRequestIdHash: string | null }>;
  answerReferences: DecisionBatchReceipt['answerReferences']; allocations: DecisionBatchReceipt['allocations'];
}

/** Raw request IDs, state, response bodies, credentials, and reasoning cannot enter this shape. */
export function sanitizedBatchReceiptExport(receipt: DecisionBatchReceipt, requestIdHashSalt: string): SanitizedBatchReceiptExport {
  if (requestIdHashSalt.length < 16) throw new Error('A deployment-scoped request-ID hash salt of at least 16 characters is required');
  return {
    schemaVersion: 'decision-batch-receipt-export/v1', batchId: receipt.batchId,
    invocationId: receipt.invocationId, runId: receipt.runId,
    plan: { planDigest: receipt.plan.planDigest, partitionId: receipt.plan.partitionId,
      nativeBatchGroupId: receipt.plan.nativeBatchGroupId },
    subjectHash: receipt.subjectHash, stateHash: receipt.stateHash, questionIds: [...receipt.questionIds],
    status: receipt.status, createdAtEpochMs: receipt.createdAtEpochMs, updatedAtEpochMs: receipt.updatedAtEpochMs,
    terminalAtEpochMs: receipt.terminalAtEpochMs,
    attempts: receipt.attempts.map(attempt => ({
      ordinal: attempt.ordinal, adapterId: attempt.adapterId, adapterVersion: attempt.adapterVersion,
      requestedModel: attempt.requestedModel, actualModel: attempt.actualModel, status: attempt.status,
      dispatchedAtEpochMs: attempt.dispatchedAtEpochMs, completedAtEpochMs: attempt.completedAtEpochMs,
      usage: { inputTokens: attempt.usage.inputTokens, outputTokens: attempt.usage.outputTokens },
      cost: exportCost(attempt.cost),
      fallbackFromAttemptOrdinal: attempt.fallbackFromAttemptOrdinal,
      providerRequestIdHash: attempt.providerRequestId === null ? null : `sha256:${createHash('sha256').update(requestIdHashSalt).update('\0').update(attempt.providerRequestId).digest('hex')}` })),

    answerReferences: receipt.answerReferences.map(ref => ({ questionId: ref.questionId, answerId: ref.answerId,
      resultId: ref.resultId })),
    allocations: receipt.allocations.map(value => ({ questionId: value.questionId, kind: value.kind,
      algorithm: value.algorithm, algorithmVersion: value.algorithmVersion,
      inputTokens: value.inputTokens, outputTokens: value.outputTokens })),
  };
}

function exportCost(cost: BatchCostEvidence): BatchCostEvidence {
  switch (cost.kind) {
    case 'provider-authoritative': return { kind: cost.kind, currency: cost.currency, amountMicros: cost.amountMicros };
    case 'client-derived': return { kind: cost.kind, currency: cost.currency, amountMicros: cost.amountMicros,
      priceCatalogId: cost.priceCatalogId, priceCatalogVersion: cost.priceCatalogVersion, effectiveAt: cost.effectiveAt };
    case 'bounded-unknown': return { kind: cost.kind, currency: cost.currency, upperBoundMicros: cost.upperBoundMicros,
      boundPolicyId: cost.boundPolicyId, boundPolicyVersion: cost.boundPolicyVersion };
    case 'unknown': return { kind: 'unknown' };
  }
}
