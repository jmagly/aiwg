import { canonicalJson } from '../security/artifact-trust.js';
import { artifactDigest } from './validate.js';
import { evaluateDecisionRuleset } from './evaluate.js';
import type { DecisionEvaluationRequest } from './types.js';
import type { DecisionJob, DecisionJobItem } from './job-contract.js';
import type { OfflineItemExecutor, OfflineJobResult } from './job-worker.js';
import { JobConflictError } from './job-store.js';

/**
 * Host-only bridge to the synchronous evaluator. Never pass model-authored scope or adapters.
 * Each job item receives an independent invocation/receipt; native same-state batches remain
 * inside that invocation, never across two subjects.
 */
export function admittedJobItemExecutor(job: Readonly<DecisionJob>,
  requestFor: (item: Readonly<DecisionJobItem>, signal: AbortSignal) => DecisionEvaluationRequest): OfflineItemExecutor {
  return async (item, signal): Promise<OfflineJobResult> => {
    const attempt = item.attempts.at(-1);
    if (!attempt || attempt.outcome !== 'dispatched') throw new JobConflictError('Missing durable dispatch fence');
    const request = requestFor(item, signal);
    const scheduler = request.scheduler;
    if (!scheduler?.enabled || scheduler.workspace.id !== job.scope.workspaceId ||
        scheduler.principal.id !== job.scope.principalId || !request.receiptStore ||
        request.receiptProjectId !== job.scope.projectId || request.invocationId !== attempt.id ||
        request.signal !== signal || scheduler.principal.limits.allowUnknownCost !== false ||
        scheduler.principal.limits.maxCostUsd === undefined ||
        scheduler.principal.limits.maxCostUsd > job.budget.maxCostMicros / 1_000_000 ||
        scheduler.principal.limits.maxAttempts === undefined ||
        scheduler.principal.limits.maxAttempts > job.budget.maxAttempts ||
        !scheduler.estimate || request.binding.spec.maxAttempts > job.budget.maxAttempts)
      throw new JobConflictError('Job evaluation requires authenticated bounded admission and durable receipts');
    try {
      if (!item.rulesetDigest || artifactDigest(request.ruleset) !== item.rulesetDigest ||
          artifactDigest(request.input) !== item.subjectDigest ||
          artifactDigest(request.definitions) !== item.definitionDigest ||
          artifactDigest(request.binding) !== item.bindingDigest) throw new JobConflictError('Job item pins changed');
    } catch { throw new JobConflictError('Job item pins changed'); }
    const result = await evaluateDecisionRuleset(request);
    const receipt = await request.receiptStore.read(request.invocationId, job.scope.projectId);
    if (!receipt || receipt.state !== 'completed' || canonicalJson(receipt.result) !== canonicalJson(result))
      throw new JobConflictError('Unvalidated or incomplete decision receipt');
    const receiptDigest = artifactDigest(receipt);
    const resultDigest = artifactDigest(result);
    if (result.spec.status === 'review') return { state: 'review', receiptDigest, resultDigest };
    if (result.spec.status === 'completed' || result.spec.status === 'defaulted')
      return { state: 'succeeded', receiptDigest, resultDigest };
    if (result.spec.status === 'error' || result.spec.status === 'cancelled')
      return { state: 'permanent-failed', errorCode: 'decision-failed' };
    throw new JobConflictError('Unsupported decision outcome');
  };
}
