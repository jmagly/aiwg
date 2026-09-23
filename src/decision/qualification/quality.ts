import { createHash } from 'node:crypto';

/** Frozen dataset memberships. Threshold selection may read tuning/calibration, never test. */
export interface QualificationSplit {
  name: 'tuning' | 'calibration' | 'test';
  ids: readonly string[];
  digest: `sha256:${string}`;
}

export interface BinaryQualificationSample {
  id: string;
  slice: string;
  label: 0 | 1;
  probability: number;
  accepted: boolean;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  calls: number;
  retries: number;
  fallbacks: number;
}

export interface BinarySliceMetrics {
  sampleN: number;
  errorRate: number;
  brier: number;
  logLoss: number;
  expectedCalibrationError: number;
  coverage: number;
  selectiveRisk: number | null;
  reviewRate: number;
  errorWilson95: readonly [number, number];
  latencyMs: { p50: number; p95: number; p99: number };
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  calls: number;
  retries: number;
  fallbacks: number;
}

function digestIds(ids: readonly string[]): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex')}`;
}

/** Hash the exact membership set; duplicate, empty and overlapping IDs fail closed. */
export function freezeQualificationSplit(name: QualificationSplit['name'], ids: readonly string[]): QualificationSplit {
  if (!ids.length || ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('qualification split requires unique nonempty IDs');
  }
  return { name, ids: [...ids].sort(), digest: digestIds(ids) };
}

export function verifyQualificationSplits(splits: readonly QualificationSplit[]): void {
  if (splits.length !== 3 || new Set(splits.map(split => split.name)).size !== 3
    || splits.some(split => !['tuning', 'calibration', 'test'].includes(split.name))) {
    throw new Error('qualification requires tuning, calibration and test splits');
  }
  const all = new Set<string>();
  for (const split of splits) {
    if (!split.ids.length || split.ids.some(id => typeof id !== 'string' || !id.trim())
      || new Set(split.ids).size !== split.ids.length || split.digest !== digestIds(split.ids)) {
      throw new Error('qualification split digest or membership mismatch');
    }
    for (const id of split.ids) {
      if (all.has(id)) throw new Error('qualification splits overlap');
      all.add(id);
    }
  }
}

/** Refuses to score unregistered or non-held-out samples. */
export function evaluateBinaryHeldout(
  splits: readonly QualificationSplit[],
  samples: readonly BinaryQualificationSample[],
): { overall: BinarySliceMetrics; slices: Record<string, BinarySliceMetrics> } {
  verifyQualificationSplits(splits);
  const test = splits.find(split => split.name === 'test')!;
  if (samples.length !== test.ids.length || new Set(samples.map(sample => sample.id)).size !== samples.length
    || samples.some(sample => !test.ids.includes(sample.id))) {
    throw new Error('held-out sample membership mismatch');
  }
  for (const sample of samples) {
    if (typeof sample.slice !== 'string' || !sample.slice.trim() || typeof sample.accepted !== 'boolean'
      || ![0, 1].includes(sample.label)
      || !Number.isFinite(sample.probability) || sample.probability < 0 || sample.probability > 1
      || !Number.isFinite(sample.latencyMs) || sample.latencyMs < 0
      || [sample.calls, sample.retries, sample.fallbacks].some(n => !Number.isSafeInteger(n) || n < 0)
      || [sample.inputTokens, sample.outputTokens].some(n => n !== null && (!Number.isSafeInteger(n) || n < 0))
      || (sample.costUsd !== null && (!Number.isFinite(sample.costUsd) || sample.costUsd < 0))) {
      throw new Error('invalid held-out sample');
    }
  }
  const groups = new Map<string, BinaryQualificationSample[]>();
  for (const sample of samples) groups.set(sample.slice, [...(groups.get(sample.slice) ?? []), sample]);
  return {
    overall: scoreBinary(samples),
    slices: Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => [key, scoreBinary(group)])),
  };
}

function scoreBinary(samples: readonly BinaryQualificationSample[]): BinarySliceMetrics {
  const n = samples.length;
  const errors = samples.filter(s => (s.probability >= 0.5 ? 1 : 0) !== s.label).length;
  const accepted = samples.filter(s => s.accepted);
  const acceptedErrors = accepted.filter(s => (s.probability >= 0.5 ? 1 : 0) !== s.label).length;
  // Wilson score interval (95% normal approximation). Never extrapolate to an empty slice.
  const z = 1.959963984540054;
  const rate = errors / n;
  const denominator = 1 + z * z / n;
  const center = (rate + z * z / (2 * n)) / denominator;
  const margin = z * Math.sqrt(rate * (1 - rate) / n + z * z / (4 * n * n)) / denominator;
  const sorted = samples.map(s => s.latencyMs).sort((a, b) => a - b);
  const quantile = (q: number): number => sorted[Math.ceil(q * n) - 1]!;
  // Deciles are a reporting convention, not a calibrated decision threshold.
  const buckets = Array.from({ length: 10 }, () => [] as BinaryQualificationSample[]);
  for (const sample of samples) buckets[Math.min(9, Math.floor(sample.probability * 10))]!.push(sample);
  const sumKnown = (key: 'inputTokens' | 'outputTokens' | 'costUsd'): number | null =>
    samples.some(s => s[key] === null) ? null : samples.reduce((sum, s) => sum + (s[key] ?? 0), 0);
  return {
    sampleN: n, errorRate: rate,
    brier: samples.reduce((sum, s) => sum + (s.probability - s.label) ** 2, 0) / n,
    logLoss: samples.reduce((sum, s) => sum - (s.label ? Math.log(Math.max(s.probability, Number.EPSILON))
      : Math.log(Math.max(1 - s.probability, Number.EPSILON))), 0) / n,
    expectedCalibrationError: buckets.reduce((sum, bucket) => bucket.length ? sum + bucket.length / n
      * Math.abs(bucket.reduce((a, s) => a + s.probability, 0) / bucket.length
        - bucket.reduce((a, s) => a + s.label, 0) / bucket.length) : sum, 0),
    coverage: accepted.length / n, selectiveRisk: accepted.length ? acceptedErrors / accepted.length : null,
    reviewRate: (n - accepted.length) / n,
    errorWilson95: [Math.max(0, center - margin), Math.min(1, center + margin)],
    latencyMs: { p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99) },
    inputTokens: sumKnown('inputTokens'), outputTokens: sumKnown('outputTokens'), costUsd: sumKnown('costUsd'),
    calls: samples.reduce((sum, s) => sum + s.calls, 0),
    retries: samples.reduce((sum, s) => sum + s.retries, 0),
    fallbacks: samples.reduce((sum, s) => sum + s.fallbacks, 0),
  };
}
