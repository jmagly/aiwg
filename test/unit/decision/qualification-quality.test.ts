import { describe, expect, it } from 'vitest';
import { evaluateBinaryHeldout, freezeQualificationSplit, verifyQualificationSplits, type BinaryQualificationSample } from '../../../src/decision/qualification/quality.js';

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
