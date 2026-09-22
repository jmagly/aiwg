import { createHash } from 'node:crypto';
import type { DecisionBatchReceipt } from './types.js';

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
    invocationId: receipt.invocationId, runId: receipt.runId, plan: structuredClone(receipt.plan),
    subjectHash: receipt.subjectHash, stateHash: receipt.stateHash, questionIds: [...receipt.questionIds],
    status: receipt.status, createdAtEpochMs: receipt.createdAtEpochMs, updatedAtEpochMs: receipt.updatedAtEpochMs,
    terminalAtEpochMs: receipt.terminalAtEpochMs,
    attempts: receipt.attempts.map(({ providerRequestId, ...attempt }) => ({ ...structuredClone(attempt),
      providerRequestIdHash: providerRequestId === null ? null : `sha256:${createHash('sha256').update(requestIdHashSalt).update('\0').update(providerRequestId).digest('hex')}` })),
    answerReferences: structuredClone(receipt.answerReferences), allocations: structuredClone(receipt.allocations),
  };
}
