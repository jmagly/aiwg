import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JevDecisionAdapter } from '../../../src/decision/adapters/jev.js';
import { validateDecisionDocument } from '../../../src/decision/validate.js';
import type { DecisionDefinition } from '../../../src/decision/types.js';
import {
  CanonicalJsonByteEstimator,
  ContextPlanError,
  assertContextPlanCurrent,
  planDecisionContext,
  recordContextActualUsage,
  type ContextPlanInput,
  type ContextProviderProfile,
  type ContextTokenEstimator,
  type ContextValue,
} from '../../../src/decision/context-plan.js';
import { canonicalJson } from '../../../src/security/artifact-trust.js';

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

/** Documented Jev request maxima; CTX-MAX pins them against the adapter, definition schemas and docs. */
const JEV_MAX_CHOICE_OPTIONS = 255;
const JEV_MAX_SCORE_LEVELS = 10;
const byteEstimator = new CanonicalJsonByteEstimator('1.0.0');
const byteProfile = profile({ estimator: { id: byteEstimator.id, version: byteEstimator.version } });

// Entries follow the Jev wire shape the adapter sends (criteria map for Choice, level list for Score).
const maxChoiceQuestion = (id: string, subject: string) => ({ id, subject, entry: { type: 'choice',
  instructions: 'Classify the report — 報告を分類してください.', criteria: Object.fromEntries(Array.from(
    { length: JEV_MAX_CHOICE_OPTIONS }, (_, i) => [`o${String(i).padStart(3, '0')}`, `選択肢 ${i}: ${'説明'.repeat(4)} ✓`])) } });
const maxScoreQuestion = (id: string, subject: string) => ({ id, subject, entry: { type: 'score',
  instructions: 'Rate severity — évaluez la gravité.', criteria: Array.from({ length: JEV_MAX_SCORE_LEVELS },
    (_, i) => ({ level: i, label: `niveau ${i}`, detail: { nested: [`детали ${i}`, { emoji: '⚠️' }] } })) } });

/** Solve for an exact estimator token count by padding with ASCII (one byte per character). */
function padToTokens(value: Record<string, ContextValue>, tokens: number): Record<string, ContextValue> {
  const baseBytes = Buffer.byteLength(canonicalJson({ ...value, pad: '' }), 'utf8');
  const padded = { ...value, pad: 'x'.repeat(tokens * 3 - baseBytes) };
  expect(byteEstimator.estimate(padded).tokens).toBe(tokens);
  return padded;
}

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

  it('CTX-PACK packs many short questions without crossing either limit across permutations', () => {
    const request = input(1_000, Array.from({ length: 121 }, () => 750));
    const original = planDecisionContext(request, profile(), exactEstimator);
    expect(original.partitions.length).toBeGreaterThan(1);
    expect(original.partitions.flatMap(p => p.questionIds).sort()).toEqual(request.questions.map(q => q.id).sort());
    expect(original.partitions.every(p => p.estimate.aggregateTokens <= 64_000
      && p.estimate.stateAndLongestQuestionTokens <= 32_000)).toBe(true);
    for (let shift = 0; shift < request.questions.length; shift += 13) {
      const shuffled = { ...request, questions: [...request.questions.slice(shift), ...request.questions.slice(0, shift)].reverse() };
      expect(JSON.stringify(planDecisionContext(shuffled, profile(), exactEstimator))).toBe(JSON.stringify(original));
    }
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

  it('records a proper subset of a partition using only dispatched question tokens', () => {
    const plan = planDecisionContext(input(100, [200, 300, 400]), profile(), exactEstimator);
    expect(recordContextActualUsage(plan, plan.partitions[0]!.id, 700, ['q3', 'q1']))
      .toMatchObject({ questionIds: ['q1', 'q3'], estimatedInputTokens: 710,
        actualInputTokens: 700, estimationErrorTokens: -10 });
    expect(() => recordContextActualUsage(plan, plan.partitions[0]!.id, 100, ['q1', 'q1']))
      .toThrowError(expect.objectContaining({ reason: 'invalid-input' }));
    expect(() => recordContextActualUsage(plan, plan.partitions[0]!.id, 100, ['unplanned']))
      .toThrowError(expect.objectContaining({ reason: 'invalid-input' }));
  });

  it('CTX-MAX pins the documented Jev maxima (Choice 255 options, Score 10 levels) in adapter, schema and docs', async () => {
    const capabilities = await new JevDecisionAdapter({ fetch: (() => { throw new Error('offline'); }) as unknown as typeof fetch }).capabilities();
    expect(capabilities).toMatchObject({ maxOptions: JEV_MAX_CHOICE_OPTIONS, maxLevels: JEV_MAX_SCORE_LEVELS });
    for (const file of ['DecisionDefinition.schema.json', 'DecisionDefinition.v1alpha2.schema.json']) {
      const text = readFileSync(`schemas/decision/${file}`, 'utf8');
      expect(text).toContain(`"maxItems": ${JEV_MAX_CHOICE_OPTIONS}`);
      expect(text).toContain(`"maxItems": ${JEV_MAX_SCORE_LEVELS}`);
    }
    expect(readFileSync('docs/decision/specification.md', 'utf8')).toContain('Choice 255 options, Score 2–10 levels');
    expect(readFileSync('docs/decision/context-planning.md', 'utf8')).toContain('255-option Choice and 10-level Score');
    const category = JSON.parse(readFileSync('examples/decision/decision-category.json', 'utf8')) as DecisionDefinition;
    const severity = JSON.parse(readFileSync('examples/decision/decision-severity.json', 'utf8')) as DecisionDefinition;
    const withOptions = (count: number) => ({ ...category, spec: { ...category.spec, answer: { kind: 'choice' as const,
      options: Array.from({ length: count }, (_, i) => ({ id: `o${i}`, description: `選択肢 ${i}` })) } } });
    const withLevels = (count: number) => ({ ...severity, spec: { ...severity.spec, answer: { kind: 'ordinal-score' as const,
      levels: Array.from({ length: count }, (_, i) => `niveau ${i} — ${'детали '.repeat(3)}`) } } });
    expect(() => validateDecisionDocument(withOptions(JEV_MAX_CHOICE_OPTIONS))).not.toThrow();
    expect(() => validateDecisionDocument(withOptions(JEV_MAX_CHOICE_OPTIONS + 1))).toThrow();
    expect(() => validateDecisionDocument(withLevels(JEV_MAX_SCORE_LEVELS))).not.toThrow();
    expect(() => validateDecisionDocument(withLevels(JEV_MAX_SCORE_LEVELS + 1))).toThrow();
  });

  it('handles Unicode and nested maximum Choice/Score entries deterministically', () => {
    const request: ContextPlanInput = {
      subject: 'unicode', authorizationDigest, incompleteContext: false,
      authorizedState: { nested: { city: '東京', emoji: '🧭', path: [{ level: { deeper: ['ß', 'ﬁ', '👩‍💻'] } }] } },
      questions: [maxChoiceQuestion('choice', 'unicode'), maxScoreQuestion('score', 'unicode')],
    };
    const first = planDecisionContext(request, byteProfile, byteEstimator);
    expect(first).toEqual(planDecisionContext(structuredClone(request), byteProfile, byteEstimator));
    expect(first).toEqual(planDecisionContext({ ...request, questions: [...request.questions].reverse() }, byteProfile, byteEstimator));
    expect(first.rawEstimate.allQuestionTokens).toBe(first.partitions[0]!.estimate.questionTokens.choice!
      + first.partitions[0]!.estimate.questionTokens.score!);
    expect(first.partitions[0]!.estimate.questionTokens.choice).toBe(
      Math.ceil(Buffer.byteLength(canonicalJson(request.questions[0]!.entry), 'utf8') / 3));
  });

  it.each([[32_000, true], [32_001, false]])(
    'CTX-32K places a maximum Choice with Unicode state exactly at %i estimator tokens', (target, succeeds) => {
      const question = maxChoiceQuestion('choice', 'max');
      const questionTokens = byteEstimator.estimate(question.entry).tokens;
      const state = padToTokens({ locale: 'ja-JP', note: '東京🧭' }, target - questionTokens - byteProfile.requestEnvelopeTokens);
      const request: ContextPlanInput = { subject: 'max', authorizationDigest, incompleteContext: false,
        authorizedState: state, questions: [question] };
      const run = () => planDecisionContext(request, byteProfile, byteEstimator);
      if (!succeeds) {
        expect(run).toThrowError(expect.objectContaining({ reason: 'oversized-question' }));
        return;
      }
      const plan = run();
      expect(plan.rawEstimate.stateAndLongestQuestionTokens).toBe(target);
      expect(plan.partitions).toHaveLength(1);
    });

  it.each([[64_000, 1], [64_001, 2]])(
    'CTX-64K packs maximum Choice and Score entries at aggregate %i estimator tokens', (target, partitions) => {
      const questions = [
        ...Array.from({ length: 4 }, (_, i) => maxChoiceQuestion(`choice-${i}`, 'max')),
        ...Array.from({ length: 4 }, (_, i) => maxScoreQuestion(`score-${i}`, 'max')),
      ];
      const questionTokens = questions.reduce((sum, question) => sum + byteEstimator.estimate(question.entry).tokens, 0);
      // Two estimator-solved fillers (each within the 32k single-question limit) reach the exact aggregate target.
      const fillerTarget = target - questionTokens - byteProfile.requestEnvelopeTokens - 1_000;
      const fillers = [Math.floor(fillerTarget / 2), fillerTarget - Math.floor(fillerTarget / 2)].map((tokens, i) => ({
        id: `z-filler-${i}`, subject: 'max', entry: padToTokens({ type: 'noul', statement: `Ünïcödé ${i}` }, tokens) }));
      const request: ContextPlanInput = { subject: 'max', authorizationDigest, incompleteContext: false,
        authorizedState: padToTokens({ tenant: 'テスト' }, 1_000), questions: [...questions, ...fillers] };
      const plan = planDecisionContext(request, byteProfile, byteEstimator);
      expect(plan.rawEstimate.aggregateTokens).toBe(target);
      expect(plan.partitions).toHaveLength(partitions);
      expect(plan.partitions.every(partition => partition.estimate.aggregateTokens <= 64_000
        && partition.estimate.stateAndLongestQuestionTokens <= 32_000)).toBe(true);
      expect(plan.partitions.flatMap(partition => partition.questionIds).sort()).toEqual(request.questions.map(q => q.id).sort());
    });

  it('CTX-DOMINANT keeps one dominant question whole among many short ones', () => {
    const short = Array.from({ length: 70 }, () => 500);
    const request = input(1_000, [...short, 30_990]);
    const dominantId = `q${short.length + 1}`;
    const plan = planDecisionContext(request, profile(), exactEstimator);
    const dominant = plan.partitions.find(partition => partition.questionIds.includes(dominantId))!;
    expect(dominant.estimate.questionTokens[dominantId]).toBe(30_990);
    expect(dominant.estimate.stateAndLongestQuestionTokens).toBe(32_000);
    expect(plan.rawEstimate.aggregateTokens).toBe(1_000 + 70 * 500 + 30_990 + 10);
    expect(plan.partitions.length).toBeGreaterThan(1);
    expect(plan.partitions.every(partition => partition.estimate.aggregateTokens <= 64_000
      && partition.estimate.stateAndLongestQuestionTokens <= 32_000)).toBe(true);
    expect(plan.partitions.flatMap(partition => partition.questionIds).sort()).toEqual(request.questions.map(q => q.id).sort());
    const reversed = { ...request, questions: [...request.questions].reverse() };
    expect(JSON.stringify(planDecisionContext(reversed, profile(), exactEstimator))).toBe(JSON.stringify(plan));
    request.questions[short.length]!.entry = { tokens: 30_991 };
    expect(() => planDecisionContext(request, profile(), exactEstimator))
      .toThrowError(expect.objectContaining({ reason: 'oversized-question', details: expect.objectContaining({ questionId: dominantId }) }));
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid provider estimator token count %s before dispatch planning', tokens => {
      const estimator: ContextTokenEstimator = { id: 'fixture', version: '1', estimate: () => ({ tokens, serializedBytes: 3 }) };
      expect(() => planDecisionContext(input(1, [1]), profile(), estimator))
        .toThrowError(expect.objectContaining({ reason: 'invalid-profile' }));
    });

  it('rejects invalid serialized-byte estimates even when the token count appears to fit', () => {
    const estimator: ContextTokenEstimator = { id: 'fixture', version: '1', estimate: () => ({ tokens: 1, serializedBytes: NaN }) };
    expect(() => planDecisionContext(input(1, [1]), profile(), estimator))
      .toThrowError(expect.objectContaining({ reason: 'invalid-profile' }));
  });

  it('invalidates the qualified estimator when byte/token ratio changes under the same version', () => {
    const first = new CanonicalJsonByteEstimator('1.0.0', 3);
    const changed = new CanonicalJsonByteEstimator('1.0.0', 4);
    const configured = profile({ estimator: { id: first.id, version: first.version } });
    const plan = planDecisionContext(input(1, [1]), configured, first);
    expect(first.id).not.toBe(changed.id);
    expect(() => assertContextPlanCurrent(plan, input(1, [1]), configured, changed))
      .toThrowError(expect.objectContaining({ reason: 'estimator-profile-mismatch' }));
  });

  it('requires the exact estimator identity qualified by the versioned profile', () => {
    expect(() => planDecisionContext(input(1, [1]), profile({ estimator: { id: 'other', version: '2' } }), exactEstimator))
      .toThrowError(expect.objectContaining({ reason: 'estimator-profile-mismatch' }));
  });
});
