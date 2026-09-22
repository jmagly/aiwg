import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonByteEstimator,
  ContextPlanError,
  assertContextPlanCurrent,
  planDecisionContext,
  recordContextActualUsage,
  type ContextPlanInput,
  type ContextProviderProfile,
  type ContextTokenEstimator,
} from '../../../src/decision/context-plan.js';

const authorizationDigest = `sha256:${'a'.repeat(64)}` as const;
const exactEstimator: ContextTokenEstimator = {
  id: 'fixture', version: '1',
  estimate(value) {
    const object = value as { tokens?: number };
    const tokens = object.tokens ?? 0;
    return { tokens, serializedBytes: tokens * 3 };
  },
};
const profile = (overrides: Partial<ContextProviderProfile> = {}): ContextProviderProfile => ({
  id: 'jev', version: '2026-09-20', estimator: { id: 'fixture', version: '1' },
  limits: { aggregateTokens: 64_000, stateAndLongestQuestionTokens: 32_000 },
  safetyMarginBps: 0, requestEnvelopeTokens: 10, ...overrides,
});
const input = (stateTokens: number, questionTokens: number[]): ContextPlanInput => ({
  subject: 'subject-1', authorizedState: { tokens: stateTokens }, authorizationDigest,
  incompleteContext: false,
  questions: questionTokens.map((tokens, index) => ({ id: `q${index + 1}`, subject: 'subject-1', entry: { tokens } })),
});

describe('decision context planning', () => {
  it.each([
    [63_999, 1], [64_000, 1], [64_001, 2],
  ])('CTX-64K handles aggregate total %i deterministically', (total, expectedPartitions) => {
    const questionTotal = total - 1_010;
    const first = Math.floor(questionTotal / 3);
    const request = input(1_000, [first, first, questionTotal - first * 2]);
    const plan = planDecisionContext(request, profile(), exactEstimator);
    expect(plan.rawEstimate.aggregateTokens).toBe(total);
    expect(plan.partitions).toHaveLength(expectedPartitions);
    expect(plan.partitions.every(partition => partition.estimate.aggregateTokens <= 64_000)).toBe(true);
  });

  it.each([[31_999, true], [32_000, true], [32_001, false]])(
    'CTX-32K handles state-plus-longest total %i', (total, succeeds) => {
      const run = () => planDecisionContext(input(1_000, [total - 1_010]), profile(), exactEstimator);
      if (succeeds) expect(run().rawEstimate.stateAndLongestQuestionTokens).toBe(total);
      else expect(run).toThrowError(expect.objectContaining({ reason: 'oversized-question' }));
    });

  it('applies a margin to each limit independently and exposes raw/effective values', () => {
    const plan = planDecisionContext(input(1_000, [22_000]), profile({ safetyMarginBps: 2_000 }), exactEstimator);
    expect(plan.limits).toMatchObject({ effectiveAggregateTokens: 51_200, effectiveStateAndLongestQuestionTokens: 25_600 });
    expect(plan.rawEstimate.stateAndLongestQuestionTokens).toBe(23_010);
  });

  it('rejects oversized state and question before any integration hook can run', () => {
    expect(() => planDecisionContext(input(31_991, [0]), profile(), exactEstimator))
      .toThrowError(expect.objectContaining({ reason: 'oversized-state' }));
    expect(() => planDecisionContext(input(1_000, [31_000]), profile(), exactEstimator))
      .toThrowError(expect.objectContaining({ reason: 'oversized-question' }));
  });

  it('is byte-equivalent across permutations of independent input', () => {
    const first = input(100, [30_000, 20_000, 20_000]);
    first.questions[0].id = 'c'; first.questions[1].id = 'a'; first.questions[2].id = 'b';
    const second = { ...first, questions: [...first.questions].reverse() };
    expect(planDecisionContext(first, profile(), exactEstimator))
      .toEqual(planDecisionContext(second, profile(), exactEstimator));
  });

  it('preserves compatibility, subject, IDs, state and dependency execution order', () => {
    const request = input(100, [100, 100, 100]);
    request.questions[0].compatibilityKey = 'a';
    request.questions[1].compatibilityKey = 'b';
    request.questions[2].compatibilityKey = 'a';
    request.questions[2].dependsOn = ['q1'];
    const plan = planDecisionContext(request, profile(), exactEstimator);
    expect(plan.partitions.map(partition => [partition.wave, partition.compatibilityKey, partition.questionIds]))
      .toEqual([[0, 'a', ['q1']], [0, 'b', ['q2']], [1, 'a', ['q3']]]);
    expect(plan.partitions[2].questionDependencies).toEqual({ q3: ['q1'] });
    expect(new Set(plan.partitions.map(partition => partition.stateDigest)).size).toBe(1);
    expect(plan.partitions.every(partition => partition.subject === request.subject)).toBe(true);
  });

  it('fails closed for unknown and cyclic dependencies', () => {
    const unknown = input(1, [1]); unknown.questions[0].dependsOn = ['absent'];
    expect(() => planDecisionContext(unknown, profile(), exactEstimator))
      .toThrowError(expect.objectContaining({ reason: 'dependency-error' }));
    const cyclic = input(1, [1, 1]);
    cyclic.questions[0].dependsOn = ['q2']; cyclic.questions[1].dependsOn = ['q1'];
    expect(() => planDecisionContext(cyclic, profile(), exactEstimator))
      .toThrowError(expect.objectContaining({ reason: 'dependency-error' }));
  });

  it('invalidates plans on profile, estimator, authorization, or content drift', () => {
    const request = input(1, [1]);
    const plan = planDecisionContext(request, profile(), exactEstimator);
    expect(() => assertContextPlanCurrent(plan, request, profile(), exactEstimator)).not.toThrow();
    expect(() => assertContextPlanCurrent(plan, request, profile({ version: 'next' }), exactEstimator))
      .toThrowError(expect.objectContaining({ reason: 'stale-plan' }));
    expect(() => assertContextPlanCurrent(plan, { ...request, authorizationDigest: `sha256:${'b'.repeat(64)}` }, profile(), exactEstimator))
      .toThrowError(expect.objectContaining({ reason: 'stale-plan' }));
  });

  it('marks incomplete context as non-actionable without dropping it from the receipt', () => {
    const request = { ...input(1, [1]), incompleteContext: true };
    const plan = planDecisionContext(request, profile(), exactEstimator);
    expect(plan).toMatchObject({ incompleteContext: true, automaticActionAllowed: false });
  });

  it('records estimate-versus-actual evidence without mutating the original plan', () => {
    const plan = planDecisionContext(input(100, [200]), profile(), exactEstimator);
    const snapshot = structuredClone(plan);
    const evidence = recordContextActualUsage(plan, plan.partitions[0].id, 400);
    expect(evidence).toMatchObject({ estimatedInputTokens: 310, actualInputTokens: 400,
      estimationErrorTokens: 90, estimationErrorBps: 2250, planDigest: plan.planDigest });
    expect(plan).toEqual(snapshot);
  });

  it('records degraded single requests independently with request-accurate estimates', () => {
    const plan = planDecisionContext(input(100, [200, 300]), profile(), exactEstimator);
    const first = recordContextActualUsage(plan, plan.partitions[0].id, 315, 'q1');
    const second = recordContextActualUsage(plan, plan.partitions[0].id, 425, 'q2');
    expect(first).toMatchObject({ questionIds: ['q1'], estimatedInputTokens: 310, actualInputTokens: 315 });
    expect(second).toMatchObject({ questionIds: ['q2'], estimatedInputTokens: 410, actualInputTokens: 425 });
  });

  it('handles Unicode and deeply structured Choice/Score-like entries deterministically', () => {
    const estimator = new CanonicalJsonByteEstimator('1.0.0');
    const unicodeProfile = profile({ estimator: { id: estimator.id, version: estimator.version } });
    const request: ContextPlanInput = {
      subject: 'unicode', authorizationDigest, incompleteContext: false,
      authorizedState: { nested: { city: '東京', emoji: '🧭' } },
      questions: [
        { id: 'choice', subject: 'unicode', entry: { kind: 'choice', options: Array.from({ length: 64 }, (_, i) => ({ id: `o${i}`, description: `選択 ${i}` })) } },
        { id: 'score', subject: 'unicode', entry: { kind: 'ordinal-score', levels: Array.from({ length: 32 }, (_, i) => ({ score: i, label: `niveau ${i}` })) } },
      ],
    };
    const first = planDecisionContext(request, unicodeProfile, estimator);
    expect(first).toEqual(planDecisionContext(structuredClone(request), unicodeProfile, estimator));
    expect(first.rawEstimate.allQuestionTokens).toBeGreaterThan(0);
  });

  it('requires the exact estimator identity qualified by the versioned profile', () => {
    expect(() => planDecisionContext(input(1, [1]), profile({ estimator: { id: 'other', version: '2' } }), exactEstimator))
      .toThrowError(expect.objectContaining({ reason: 'estimator-profile-mismatch' }));
  });
});
