import { createHash } from 'node:crypto';
import { canonicalJson } from '../security/artifact-trust.js';
import {
  ContextPlanError, planDecisionContext, type ContextPlanInput,
  type ContextProviderProfile, type ContextTokenEstimator,
} from './context-plan.js';

/** Only request-level provider input usage qualifies a profile; synthetic values are diagnostic only. */
export interface ContextComparison {
  caseId: string;
  input: ContextPlanInput;
  actualInputTokens: number;
  source: 'provider' | 'synthetic';
  /** Immutable reference to the provider response/usage artifact (never a credential or body). */
  usageRef: string;
}

export interface ContextQualification {
  schemaVersion: 'decision-context-qualification/v1';
  profile: { id: string; version: string; digest: string };
  estimator: { id: string; version: string };
  cases: Array<{
    caseId: string; source: ContextComparison['source']; usageRef: string;
    planDigest: string; estimatedInputTokens: number; actualInputTokens: number;
    errorTokens: number; undercountBps: number;
  }>;
  worstUndercountBps: number;
  /** No observed usage may be promoted from synthetic fixtures. */
  qualifiedForEnforcement: boolean;
  reason: 'provider-comparisons-within-margin' | 'synthetic-only' | 'undercount-exceeds-margin';
}

/** Retains a body-free, immutable comparison. Reject split samples: usage is per request, not per group. */
export function assertContextQualified(qualification: ContextQualification, profile: ContextProviderProfile,
  estimator: ContextTokenEstimator): void {
  const digest = `sha256:${createHash('sha256').update(canonicalJson(profile)).digest('hex')}`;
  const cases = qualification?.cases;
  if (qualification?.schemaVersion !== 'decision-context-qualification/v1'
    || qualification.profile.digest !== digest || qualification.profile.id !== profile.id
    || qualification.profile.version !== profile.version || qualification.estimator.id !== estimator.id
    || qualification.estimator.version !== estimator.version || !qualification.qualifiedForEnforcement
    || qualification.reason !== 'provider-comparisons-within-margin' || !Array.isArray(cases) || !cases.length
    || new Set(cases.map(c => c.caseId)).size !== cases.length
    || cases.some(c => c.source !== 'provider' || !Number.isSafeInteger(c.actualInputTokens)
      || !Number.isSafeInteger(c.estimatedInputTokens) || c.actualInputTokens < 0 || c.estimatedInputTokens < 0
      || c.errorTokens !== c.actualInputTokens - c.estimatedInputTokens
      || c.undercountBps !== (c.actualInputTokens === 0 ? 0
        : Math.max(0, Math.ceil(c.errorTokens * 10_000 / c.actualInputTokens))))
    || qualification.worstUndercountBps !== Math.max(...cases.map(c => c.undercountBps))
    || qualification.worstUndercountBps > profile.safetyMarginBps) {
    throw new ContextPlanError('rollout-unqualified', 'context enforcement requires matching provider-backed qualification');
  }
}

export function compareContextUsage(
  comparisons: readonly ContextComparison[], profile: ContextProviderProfile, estimator: ContextTokenEstimator,
): ContextQualification {
  if (!comparisons.length || new Set(comparisons.map(c => c.caseId)).size !== comparisons.length) {
    throw new ContextPlanError('invalid-input', 'qualification requires unique nonempty comparison cases');
  }
  const cases = comparisons.map(sample => {
    if (!sample.caseId || !sample.usageRef || !['provider', 'synthetic'].includes(sample.source)
      || !Number.isSafeInteger(sample.actualInputTokens) || sample.actualInputTokens < 0) {
      throw new ContextPlanError('invalid-input', 'comparison requires an ID, usage reference and nonnegative provider usage');
    }
    const plan = planDecisionContext(sample.input, profile, estimator);
    if (plan.partitions.length !== 1 || plan.partitions[0]!.questionIds.length !== sample.input.questions.length) {
      throw new ContextPlanError('invalid-input', 'comparison must correspond to exactly one complete provider request');
    }
    const estimatedInputTokens = plan.partitions[0]!.estimate.aggregateTokens;
    const errorTokens = sample.actualInputTokens - estimatedInputTokens;
    return {
      caseId: sample.caseId, source: sample.source, usageRef: sample.usageRef,
      planDigest: plan.planDigest, estimatedInputTokens, actualInputTokens: sample.actualInputTokens,
      errorTokens, undercountBps: sample.actualInputTokens === 0 ? 0
        : Math.max(0, Math.ceil(errorTokens * 10_000 / sample.actualInputTokens)),
    };
  }).sort((a, b) => a.caseId.localeCompare(b.caseId, 'en'));
  const worstUndercountBps = Math.max(...cases.map(c => c.undercountBps));
  const providerOnly = cases.every(c => c.source === 'provider');
  // If estimate is lower than actual by more than reserved margin, the effective limit may overflow.
  const qualifiedForEnforcement = providerOnly && worstUndercountBps <= profile.safetyMarginBps;
  return {
    schemaVersion: 'decision-context-qualification/v1',
    profile: { id: profile.id, version: profile.version,
      digest: `sha256:${createHash('sha256').update(canonicalJson(profile)).digest('hex')}` },
    estimator: { id: estimator.id, version: estimator.version }, cases, worstUndercountBps,
    qualifiedForEnforcement,
    reason: !providerOnly ? 'synthetic-only' : qualifiedForEnforcement
      ? 'provider-comparisons-within-margin' : 'undercount-exceeds-margin',
  };
}
