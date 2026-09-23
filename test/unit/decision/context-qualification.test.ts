import { describe, expect, it } from 'vitest';
import { compareContextUsage, type ContextComparison } from '../../../src/decision/context-qualification.js';
import { ContextPlanError, type ContextProviderProfile, type ContextTokenEstimator } from '../../../src/decision/context-plan.js';

const estimator: ContextTokenEstimator = { id: 'fixture', version: '1', estimate: value => ({
  tokens: (value as { tokens: number }).tokens, serializedBytes: 1,
}) };
const profile: ContextProviderProfile = {
  id: 'jev', version: 'fixture', estimator: { id: 'fixture', version: '1' },
  limits: { aggregateTokens: 64_000, stateAndLongestQuestionTokens: 32_000 },
  safetyMarginBps: 2_000, requestEnvelopeTokens: 10,
};
const sample = (caseId: string, actualInputTokens: number, source: ContextComparison['source']): ContextComparison => ({
  caseId, actualInputTokens, source, usageRef: `receipt:${caseId}`,
  input: { subject: 'test', authorizationDigest: `sha256:${'a'.repeat(64)}`, incompleteContext: false,
    authorizedState: { tokens: 100 }, questions: [{ id: 'q', subject: 'test', entry: { tokens: 890 } }] },
});

describe('CTX qualification and TV-12 retained comparisons', () => {
  it('retains versioned profile, plan and request-level signed errors without bodies', () => {
    const first = compareContextUsage([sample('b', 1100, 'provider'), sample('a', 900, 'provider')], profile, estimator);
    expect(first).toEqual(compareContextUsage([sample('a', 900, 'provider'), sample('b', 1100, 'provider')], profile, estimator));
    expect(first.cases).toMatchObject([
      { caseId: 'a', estimatedInputTokens: 1000, errorTokens: -100, undercountBps: 0 },
      { caseId: 'b', estimatedInputTokens: 1000, errorTokens: 100, undercountBps: 910 },
    ]);
    expect(first.qualifiedForEnforcement).toBe(true);
    expect(JSON.stringify(first)).not.toContain('authorizedState');
    expect(compareContextUsage([sample('b', 1100, 'provider')], { ...profile, version: 'next' }, estimator).profile.digest)
      .not.toBe(first.profile.digest);
  });

  it('never qualifies synthetic data or undercount larger than the reserved margin', () => {
    expect(compareContextUsage([sample('a', 1100, 'synthetic')], profile, estimator))
      .toMatchObject({ qualifiedForEnforcement: false, reason: 'synthetic-only' });
    expect(compareContextUsage([sample('a', 1300, 'provider')], profile, estimator))
      .toMatchObject({ qualifiedForEnforcement: false, reason: 'undercount-exceeds-margin' });
  });

  it('rejects invalid, duplicate and split request comparisons', () => {
    expect(() => compareContextUsage([sample('a', NaN, 'provider')], profile, estimator)).toThrow(ContextPlanError);
    expect(() => compareContextUsage([sample('a', 1, 'provider'), sample('a', 2, 'provider')], profile, estimator)).toThrow(ContextPlanError);
    const split = sample('split', 100, 'provider');
    split.input.questions = Array.from({ length: 60 }, (_, n) => ({ id: `q${n}`, subject: 'test', entry: { tokens: 890 } }));
    expect(() => compareContextUsage([split], profile, estimator)).toThrow(ContextPlanError);
  });
});
