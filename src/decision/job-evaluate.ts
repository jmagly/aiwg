import { canonicalJson } from '../security/artifact-trust.js';
import { artifactDigest } from './validate.js';
import { evaluateDecisionRuleset } from './evaluate.js';
import type { DecisionEvaluationRequest } from './types.js';
import type { DecisionJob, DecisionJobItem } from './job-contract.js';
import type { OfflineItemExecutor, OfflineJobResult } from './job-worker.js';
import { JobConflictError } from './job-store.js';

/** Job item state for a completed D03 decision result; `null` for an unsupported status. */
export function decisionResultJobState(result: { spec?: { status?: unknown } } | null | undefined):
  'succeeded' | 'review' | 'permanent-failed' | null {
  const status = result?.spec?.status;
  if (status === 'review') return 'review';
  if (status === 'completed' || status === 'defaulted') return 'succeeded';
  if (status === 'error' || status === 'cancelled') return 'permanent-failed';
  return null;
}

/**
 * Host-only bridge to the synchronous evaluator. Never pass model-authored scope or adapters.
 * Each job item receives an independent invocation/receipt; native same-state batches remain
 * inside that invocation, never across two subjects.
 */
export function admittedJobItemExecutor(job: Readonly<DecisionJob>,
  requestFor: (item: Readonly<DecisionJobItem>, signal: AbortSignal) => DecisionEvaluationRequest): OfflineItemExecutor {
  const execute: OfflineItemExecutor = async (item, signal): Promise<OfflineJobResult> => {
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
    let plannedTokens = 0; let plannedCostMicros = 0;
    try {
      for (const [alias, plan] of Object.entries(request.binding.spec.evaluations)) {
        for (const target of plan.targets) {
          const estimate = scheduler.estimate(alias, target, request.input);
          if (!Number.isSafeInteger(estimate.tokens) || estimate.tokens! < 0 ||
              !Number.isFinite(estimate.costUsd) || estimate.costUsd! < 0)
            throw new JobConflictError('Unknown job estimate');
          plannedTokens += estimate.tokens!;
          plannedCostMicros += Math.ceil(estimate.costUsd! * 1_000_000);
        }
      }
      if (!Number.isSafeInteger(plannedTokens) || !Number.isSafeInteger(plannedCostMicros) ||
          attempt.reservedTokens === undefined || attempt.reservedCostMicros === undefined ||
          plannedTokens > attempt.reservedTokens || plannedCostMicros > attempt.reservedCostMicros)
        throw new JobConflictError('Item admission exceeds durable reservation');
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
    const state = decisionResultJobState(result);
    if (state === 'review' || state === 'succeeded') return { state, receiptDigest, resultDigest };
    if (state === 'permanent-failed') return { state, errorCode: 'decision-failed' };
    throw new JobConflictError('Unsupported decision outcome');
  };
  execute.requiresReservation = true;
  return execute;
}
