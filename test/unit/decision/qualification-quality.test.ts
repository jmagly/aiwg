import { describe, expect, it } from 'vitest';
import { evaluateBinaryHeldout, evaluateOrdinalHeldout, evaluateRankingHeldout, freezeQualificationSplit, verifyQualificationSplits, type BinaryQualificationSample } from '../../../src/decision/qualification/quality.js';

const splits = () => [
  freezeQualificationSplit('tuning', ['train-1']),
  freezeQualificationSplit('calibration', ['cal-1']),
  freezeQualificationSplit('test', ['test-1', 'test-2']),
];
const sample = (id: string, overrides: Partial<BinaryQualificationSample> = {}): BinaryQualificationSample => ({
  id, slice: 'a', label: 1, probability: 0.8, accepted: true, latencyMs: 10,
  inputTokens: 3, outputTokens: 2, costUsd: 0.01, calls: 1, retries: 0, fallbacks: 0, ...overrides,
});

describe('held-out qualification metrics', () => {
  it('checks immutable, disjoint split membership and forbids missing held-out rows', () => {
    expect(() => verifyQualificationSplits(splits())).not.toThrow();
    expect(() => freezeQualificationSplit('test', ['a', 'a'])).toThrow('unique');
    const altered = splits();
    altered[2] = { ...altered[2]!, ids: ['substituted'] };
    expect(() => verifyQualificationSplits(altered)).toThrow('digest');
    expect(() => verifyQualificationSplits([
      ...splits().slice(0, 2), { ...splits()[2]!, name: 'unknown' as 'test' },
    ])).toThrow('requires tuning');
    const overlap = splits();
    overlap[1] = freezeQualificationSplit('calibration', ['train-1']);
    expect(() => verifyQualificationSplits(overlap)).toThrow('overlap');
    expect(() => evaluateBinaryHeldout(splits(), [sample('test-1')])).toThrow('membership');
    expect(() => evaluateBinaryHeldout(splits(), [sample('test-1'), sample('cal-1')])).toThrow('membership');
  });

  it('calculates primitive-aware binary scores, coverage, uncertainty, latency and cost', () => {
    const result = evaluateBinaryHeldout(splits(), [
      sample('test-1', { slice: 'safe', label: 1, probability: 0.8, accepted: true, latencyMs: 10 }),
      sample('test-2', { slice: 'risky', label: 0, probability: 0.6, accepted: false, latencyMs: 20, costUsd: null, retries: 1 }),
    ]);
    expect(result.overall).toMatchObject({ sampleN: 2, errorRate: 0.5,
      coverage: 0.5, selectiveRisk: 0, reviewRate: 0.5,
      latencyMs: { p50: 10, p95: 20, p99: 20 }, inputTokens: 6, outputTokens: 4,
      costUsd: null, calls: 2, retries: 1, fallbacks: 0 });
    expect(result.overall.brier).toBeCloseTo(0.2);
    expect(result.overall.errorWilson95[0]).toBeGreaterThan(0);
    expect(result.overall.errorWilson95[1]).toBeLessThan(1);
    expect(result.overall.logLoss).toBeCloseTo((-Math.log(0.8) - Math.log(0.4)) / 2);
    expect(result.slices.risky?.selectiveRisk).toBeNull();
    expect(result.slices.safe?.brier).toBeCloseTo(0.04);
  });

  it('reports held-out ordinal error and refuses out-of-domain levels', () => {
    const scores = [
      { id: 'test-1', trueLevel: 0, predictedLevel: 1, levels: 3 },
      { id: 'test-2', trueLevel: 2, predictedLevel: 2, levels: 3 },
    ];
    expect(evaluateOrdinalHeldout(splits(), scores)).toEqual({
      sampleN: 2, exactRate: 0.5, meanAbsoluteError: 0.5, normalizedAbsoluteError: 0.25,
    });
    expect(() => evaluateOrdinalHeldout(splits(), [{ ...scores[0]!, predictedLevel: 3 }, scores[1]!])).toThrow('invalid');
    expect(() => evaluateOrdinalHeldout(splits(), [scores[0]!, { ...scores[1]!, id: 'cal-1' }])).toThrow('membership');
  });

  it('scores ranking inversions and predicted ties as errors, with null for no comparable gold pairs', () => {
    const rows = [
      { id: 'test-1', gold: { a: 3, b: 2, c: 1 }, predicted: { a: 2, b: 3, c: 1 } },
      { id: 'test-2', gold: { a: 1, b: 1 }, predicted: { a: 1, b: 0 } },
    ];
    expect(evaluateRankingHeldout(splits(), rows)).toEqual({ sampleN: 2, comparablePairs: 3, concordance: 2 / 3 });
    expect(evaluateRankingHeldout(splits(), rows.map(row => ({ ...row, gold: { a: 1, b: 1 }, predicted: { a: 1, b: 1 } })))).toMatchObject({ comparablePairs: 0, concordance: null });
    expect(evaluateRankingHeldout(splits(), [
      { ...rows[0]!, predicted: { a: 1, b: 1, c: 0 } }, rows[1]!,
    ]).concordance).toBe(2 / 3);
    expect(() => evaluateRankingHeldout(splits(), [{ ...rows[0]!, predicted: { a: 1 } }, rows[1]!])).toThrow('option mismatch');
    expect(() => evaluateRankingHeldout(splits(), [{ ...rows[0]!, predicted: { a: NaN, b: 1, c: 0 } }, rows[1]!])).toThrow('invalid');
  });

  it('rejects nonfinite and invalid samples instead of treating missing cost as zero', () => {
    for (const overrides of [{ probability: NaN }, { probability: 1.1 }, { latencyMs: -1 },
      { costUsd: -0.01 }, { inputTokens: 1.5 }, { calls: -1 }, { slice: '' },
      { accepted: 'false' as unknown as boolean }]) {
      expect(() => evaluateBinaryHeldout(splits(), [sample('test-1', overrides), sample('test-2')])).toThrow('invalid');
    }
    const result = evaluateBinaryHeldout(splits(), [sample('test-1', { accepted: false }), sample('test-2', { accepted: false })]);
    expect(result.overall.selectiveRisk).toBeNull();
    expect(result.overall.reviewRate).toBe(1);
  });
});
