import { artifactDigest } from './validate.js';
import { batchAccountingTotals } from './batch-receipts/accounting.js';
import type { BatchReceiptStore } from './batch-receipts/types.js';
import type { DecisionReceiptStore } from './types.js';
import type { DecisionJob } from './job-contract.js';
import { JobConflictError } from './job-store.js';

export interface JobUsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Known USD micros; conversion from provider USD is labeled client-derived. */
  knownCostMicros: number;
  unknownUsage: boolean;
  unknownCost: boolean;
  costProvenance: 'client-derived' | 'estimate' | 'unknown';
  /** Never treat a partial receipt set as admission evidence. */
  complete: boolean;
}
export interface JobAccountingReport extends JobUsageTotals {
  items: Record<string, JobUsageTotals>;
  overTokenBudget: boolean;
  overCostBudget: boolean;
}
const empty = (): JobUsageTotals => ({ inputTokens: 0, outputTokens: 0, knownCostMicros: 0,
  unknownUsage: false, unknownCost: false, costProvenance: 'client-derived', complete: true });
function add(target: JobUsageTotals, input: number | null, output: number | null, costMicros: number | null): void {
  if (input === null || output === null) target.unknownUsage = true;
  if (costMicros === null) { target.unknownCost = true; target.costProvenance = 'unknown'; }
  for (const [field, value] of [['inputTokens', input], ['outputTokens', output], ['knownCostMicros', costMicros]] as const) {
    if (value === null) continue;
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(target[field] + value))
      throw new JobConflictError('Invalid job usage total');
    target[field] += value;
  }
}
/** Read only: receipt ownership is authoritative; per-answer native batch allocations are ignored. */
export async function accountDecisionJob(job: DecisionJob, receipts: DecisionReceiptStore,
  batches?: BatchReceiptStore): Promise<JobAccountingReport> {
  const total = empty();
  const items: Record<string, JobUsageTotals> = Object.create(null) as Record<string, JobUsageTotals>;
  const seenBatches = new Map<string, string>();
  for (const item of job.items) {
    const usage = empty(); items[item.id] = usage;
    for (const attempt of item.attempts) {
      if (!attempt.receiptDigest) {
        usage.complete = false; usage.unknownUsage = true; usage.unknownCost = true;
        continue;
      }
      const receipt = await receipts.read(attempt.id, job.scope.projectId);
      if (!receipt || receipt.invocationId !== attempt.id || receipt.projectId !== job.scope.projectId ||
          artifactDigest(receipt) !== attempt.receiptDigest || receipt.state !== 'completed' || !receipt.result ||
          receipt.result.spec.invocationId !== attempt.id ||
          Object.values(receipt.result.spec.evaluations).some(evaluation => evaluation.spec.invocationId !== attempt.id)) {
        throw new JobConflictError('Job receipt unavailable or changed');
      }
      for (const evaluation of Object.values(receipt.result.spec.evaluations)) {
        for (const providerAttempt of evaluation.spec.attempts) {
          if (providerAttempt.batch?.mode === 'native') {
            const ref = evaluation.spec.batchResult;
            if (!ref || !batches) { usage.complete = false; usage.unknownUsage = true; usage.unknownCost = true; continue; }
            const owningItem = seenBatches.get(ref.batchId);
            if (owningItem && owningItem !== item.id) throw new JobConflictError('Native batch shared across job subjects');
            if (owningItem) continue;
            const batch = await batches.read(ref.batchId, job.scope.tenantId, job.scope.projectId);
            if (!batch || batch.tenantId !== job.scope.tenantId || batch.projectId !== job.scope.projectId ||
                batch.invocationId !== attempt.id || batch.status !== 'completed' ||
                batch.revision < ref.receiptRevision || !batch.questionIds.includes(ref.questionId) ||
                !batch.answerReferences.some(answer => answer.questionId === ref.questionId && answer.answerId === ref.answerId))
              throw new JobConflictError('Native batch receipt unavailable or outside item invocation');
            seenBatches.set(ref.batchId, item.id);
            const owner = batchAccountingTotals(batch);
            add(usage, owner.usage.inputTokens, owner.usage.outputTokens,
              owner.cost.unknownAttemptCount === 0 ? owner.cost.knownAmountMicros : owner.cost.conservativeUpperBoundMicros);
            if (owner.cost.unknownAttemptCount) {
              usage.unknownCost = owner.cost.conservativeUpperBoundMicros === null;
              usage.costProvenance = usage.unknownCost ? 'unknown' : 'estimate';
            }
          } else {
            const providerUsage = providerAttempt.usage;
            const amount = providerUsage.costUsd;
            add(usage, providerUsage.inputTokens, providerUsage.outputTokens,
              amount === null || !Number.isFinite(amount) || amount < 0 ? null : Math.round(amount * 1_000_000));
          }
        }
      }
    }
    add(total, usage.inputTokens, usage.outputTokens, usage.knownCostMicros);
    total.complete &&= usage.complete;
    total.unknownCost ||= usage.unknownCost;
    total.unknownUsage ||= usage.unknownUsage;
    if (usage.costProvenance === 'estimate' && total.costProvenance !== 'unknown') total.costProvenance = 'estimate';
  }
  if (total.unknownCost) total.costProvenance = 'unknown';
  return { ...total, items,
    overTokenBudget: total.unknownUsage || total.inputTokens + total.outputTokens > job.budget.maxTokens,
    overCostBudget: total.unknownCost || total.knownCostMicros > job.budget.maxCostMicros };
}
