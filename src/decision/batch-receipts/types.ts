export type BatchReceiptStatus = 'acquired' | 'running' | 'completed' | 'failed' | 'execution-uncertain';

export type BatchAttemptStatus = 'not-sent' | 'failed' | 'succeeded' | 'execution-uncertain';

export interface BatchProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export type BatchCostEvidence =
  | { kind: 'provider-authoritative'; currency: 'USD'; amountMicros: number }
  | { kind: 'client-derived'; currency: 'USD'; amountMicros: number; priceCatalogId: string;
      priceCatalogVersion: string; effectiveAt: string }
  | { kind: 'bounded-unknown'; currency: 'USD'; upperBoundMicros: number; boundPolicyId: string; boundPolicyVersion: string }
  | { kind: 'unknown' };

export interface BatchAttempt {
  ordinal: number;
  adapterId: string;
  adapterVersion: string;
  requestedModel: string;
  actualModel: string | null;
  providerRequestId: string | null;
  status: BatchAttemptStatus;
  dispatchedAtEpochMs: number | null;
  completedAtEpochMs: number | null;
  usage: BatchProviderUsage;
  cost: BatchCostEvidence;
  fallbackFromAttemptOrdinal: number | null;
}

export interface BatchAnswerReference {
  questionId: string;
  answerId: string;
  resultId: string;
}

export interface EstimatedTokenAllocation {
  questionId: string;
  kind: 'estimated';
  algorithm: 'largest-remainder-weighted';
  algorithmVersion: '1';
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Owns shared transport accounting. Decision results refer to this receipt and
 * an answer reference; they must not copy request-level usage or cost.
 */
export interface DecisionBatchReceipt {
  schemaVersion: 'decision-batch-receipt/v1';
  revision: number;
  tenantId: string;
  projectId: string;
  batchId: string;
  invocationId: string;
  runId: string;
  plan: { planDigest: `sha256:${string}`; partitionId: string; nativeBatchGroupId: string | null };
  subjectHash: `sha256:${string}`;
  stateHash: `sha256:${string}`;
  executionEnvelope: string;
  questionIds: string[];
  attempts: BatchAttempt[];
  answerReferences: BatchAnswerReference[];
  allocations: EstimatedTokenAllocation[];
  status: BatchReceiptStatus;
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
  terminalAtEpochMs: number | null;
}

export interface BatchReceiptAcquireResult {
  owner: boolean;
  receipt: DecisionBatchReceipt;
}

export interface BatchReceiptStore {
  acquire(initial: DecisionBatchReceipt): Promise<BatchReceiptAcquireResult>;
  read(batchId: string, tenantId: string, projectId: string): Promise<DecisionBatchReceipt | null>;
  compareAndSwap(previous: DecisionBatchReceipt, next: DecisionBatchReceipt): Promise<boolean>;
}

export interface PriceCatalogRecord {
  id: string;
  version: string;
  effectiveAt: string;
  currency: 'USD';
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
}
