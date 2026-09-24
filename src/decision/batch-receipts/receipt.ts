import type { ContextPartition, ContextPlan } from '../context-plan.js';
import type { DecisionBatchReceipt, BatchReceiptStatus } from './types.js';
import { validateBatchReceipt, validateBatchReceiptTransition } from './validate.js';

export interface NewBatchReceiptInput {
  tenantId: string; projectId: string; batchId: string; invocationId: string; runId: string;
  contextPlan: ContextPlan; partition: ContextPartition; nativeBatchGroupId?: string | null;
  subjectHash: `sha256:${string}`; executionEnvelope: string; nowEpochMs: number;
  /** Optional W3C traceparent of the creating workflow span. */
  traceParent?: string;
}

/** Integration hook for D04 native groups and D06 deterministic context partitions. */
export function newBatchReceipt(input: NewBatchReceiptInput): DecisionBatchReceipt {
  if (input.partition.subject !== input.contextPlan.subject
    || !input.contextPlan.partitions.some(candidate => candidate.id === input.partition.id)) {
    throw new Error('Batch partition does not belong to the supplied context plan');
  }
  const receipt: DecisionBatchReceipt = {
    schemaVersion: 'decision-batch-receipt/v1', revision: 1,
    tenantId: input.tenantId, projectId: input.projectId, batchId: input.batchId,
    invocationId: input.invocationId, runId: input.runId,
    plan: { planDigest: input.contextPlan.planDigest, partitionId: input.partition.id,
      nativeBatchGroupId: input.nativeBatchGroupId ?? null },
    subjectHash: input.subjectHash, stateHash: input.partition.stateDigest,
    executionEnvelope: input.executionEnvelope, questionIds: [...input.partition.questionIds],
    attempts: [], answerReferences: [], allocations: [], status: 'acquired',
    createdAtEpochMs: input.nowEpochMs, updatedAtEpochMs: input.nowEpochMs, terminalAtEpochMs: null,
    ...(input.traceParent !== undefined ? { traceParent: input.traceParent } : {}),
  };
  validateBatchReceipt(receipt); return receipt;
}

export function nextBatchReceipt(previous: DecisionBatchReceipt, update: {
  status: BatchReceiptStatus;
  updatedAtEpochMs: number;
  attempts?: DecisionBatchReceipt['attempts'];
  answerReferences?: DecisionBatchReceipt['answerReferences'];
  allocations?: DecisionBatchReceipt['allocations'];
}): DecisionBatchReceipt {
  const terminal = update.status === 'completed' || update.status === 'failed' || update.status === 'execution-uncertain';
  const next: DecisionBatchReceipt = { ...structuredClone(previous), ...structuredClone(update),
    revision: previous.revision + 1, terminalAtEpochMs: terminal ? update.updatedAtEpochMs : null };
  validateBatchReceiptTransition(previous, next); return next;
}

/** Reference embedded by future DecisionResult writers; intentionally has no usage/cost fields. */
export interface BatchResultReference {
  schemaVersion: 'decision-batch-result-ref/v1';
  batchId: string;
  receiptRevision: number;
  questionId: string;
  answerId: string;
}

export function batchResultReference(receipt: DecisionBatchReceipt, questionId: string): BatchResultReference {
  const answer = receipt.answerReferences.find(candidate => candidate.questionId === questionId);
  if (!answer) throw new Error(`No answer reference for question '${questionId}'`);
  return { schemaVersion: 'decision-batch-result-ref/v1', batchId: receipt.batchId,
    receiptRevision: receipt.revision, questionId, answerId: answer.answerId };
}
