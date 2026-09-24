import { createHash } from 'node:crypto';

/** Frozen dataset memberships. Threshold selection may read tuning/calibration, never test. */
export interface QualificationSplit {
  name: 'tuning' | 'calibration' | 'test';
  ids: readonly string[];
  digest: `sha256:${string}`;
}

export interface FrozenBinaryBenchmarkPlan {
  schemaVersion: 'decision-binary-benchmark-plan/v1';
  splits: readonly QualificationSplit[];
  /** Hash of sorted (id, label, slice) triples across all splits, before any held-out predictions. */
  datasetDigest: `sha256:${string}`;
  minimumOverallN: number;
  minimumSliceN: number;
  maximumSelectiveRisk: number;
  maximumReviewRate: number;
  maximumBrier: number;
  digest: `sha256:${string}`;
}

export interface BinaryBenchmarkLabel { id: string; label: 0 | 1; slice: string }

const sha256 = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

/** Freeze thresholds and all three label sets before acquiring test predictions. */
export function freezeBinaryBenchmarkPlan(
  splits: readonly QualificationSplit[], labels: readonly BinaryBenchmarkLabel[],
  limits: Pick<FrozenBinaryBenchmarkPlan, 'minimumOverallN' | 'minimumSliceN' | 'maximumSelectiveRisk' | 'maximumReviewRate' | 'maximumBrier'>,
): FrozenBinaryBenchmarkPlan {
  verifyQualificationSplits(splits);
  const ids = splits.flatMap(split => split.ids).sort();
  if (labels.length !== ids.length || new Set(labels.map(label => label.id)).size !== ids.length
    || labels.some(label => !ids.includes(label.id) || ![0, 1].includes(label.label) || !label.slice?.trim())
    || !Number.isSafeInteger(limits.minimumOverallN) || limits.minimumOverallN < 1
    || !Number.isSafeInteger(limits.minimumSliceN) || limits.minimumSliceN < 1
    || [limits.maximumSelectiveRisk, limits.maximumReviewRate, limits.maximumBrier]
      .some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error('invalid preregistered benchmark plan');
  }
  const fields = {
    schemaVersion: 'decision-binary-benchmark-plan/v1' as const,
    splits: ['tuning', 'calibration', 'test'].map(name => splits.find(split => split.name === name)!),
    datasetDigest: sha256([...labels].sort((a, b) => a.id.localeCompare(b.id))),
    ...limits,
  };
  return { ...fields, digest: sha256(fields) };
}

/** A separately anchored digest is required: a caller-created plan cannot attest its own preregistration. */
export function evaluatePreregisteredBinaryBenchmark(
  plan: FrozenBinaryBenchmarkPlan, trustedPlanDigest: `sha256:${string}`,
  labels: readonly BinaryBenchmarkLabel[], samples: readonly BinaryQualificationSample[],
): { decision: 'pass' | 'fail' | 'insufficient-evidence'; reasons: string[]; metrics: ReturnType<typeof evaluateBinaryHeldout> } {
  const { digest, ...fields } = plan;
  if (digest !== trustedPlanDigest || digest !== sha256(fields)
    || freezeBinaryBenchmarkPlan(plan.splits, labels, {
      minimumOverallN: plan.minimumOverallN, minimumSliceN: plan.minimumSliceN,
      maximumSelectiveRisk: plan.maximumSelectiveRisk, maximumReviewRate: plan.maximumReviewRate,
      maximumBrier: plan.maximumBrier,
    }).digest !== digest) throw new Error('benchmark preregistration or dataset mismatch');
  const testLabels = new Map(labels.filter(label => plan.splits.find(split => split.name === 'test')!.ids.includes(label.id))
    .map(label => [label.id, label]));
  if (samples.some(sample => sample.label !== testLabels.get(sample.id)?.label || sample.slice !== testLabels.get(sample.id)?.slice)) {
    throw new Error('held-out label or slice mismatch');
  }
  const metrics = evaluateBinaryHeldout(plan.splits, samples);
  const insufficient = metrics.overall.sampleN < plan.minimumOverallN
    || Object.values(metrics.slices).some(slice => slice.sampleN < plan.minimumSliceN || slice.selectiveRisk === null);
  const reasons: string[] = [];
  if (insufficient) reasons.push('insufficient-heldout-evidence');
  if (metrics.overall.selectiveRisk === null) reasons.push('zero-accepted-samples');
  if (metrics.overall.selectiveRisk !== null && metrics.overall.selectiveRisk > plan.maximumSelectiveRisk) reasons.push('selective-risk');
  if (metrics.overall.reviewRate > plan.maximumReviewRate) reasons.push('review-rate');
  if (metrics.overall.brier > plan.maximumBrier) reasons.push('brier');
  const exceeded = reasons.some(reason => reason === 'selective-risk' || reason === 'review-rate' || reason === 'brier');
  return { decision: exceeded ? 'fail' : insufficient || metrics.overall.selectiveRisk === null ? 'insufficient-evidence'
    : 'pass', reasons, metrics };
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

export interface OrdinalQualificationSample {
  id: string;
  trueLevel: number;
  predictedLevel: number;
  levels: number;
}

/** Mean absolute level error and exact match, scored on a frozen held-out split. */
export function evaluateOrdinalHeldout(
  splits: readonly QualificationSplit[], samples: readonly OrdinalQualificationSample[],
): { sampleN: number; exactRate: number; meanAbsoluteError: number; normalizedAbsoluteError: number } {
  verifyQualificationSplits(splits);
  const testIds = splits.find(split => split.name === 'test')!.ids;
  if (samples.length !== testIds.length || new Set(samples.map(s => s.id)).size !== samples.length
    || samples.some(s => !testIds.includes(s.id))) throw new Error('held-out ordinal membership mismatch');
  if (samples.some(s => !Number.isSafeInteger(s.levels) || s.levels < 2
    || !Number.isSafeInteger(s.trueLevel) || !Number.isSafeInteger(s.predictedLevel)
    || s.trueLevel < 0 || s.trueLevel >= s.levels || s.predictedLevel < 0 || s.predictedLevel >= s.levels)) {
    throw new Error('invalid held-out ordinal sample');
  }
  return {
    sampleN: samples.length,
    exactRate: samples.filter(s => s.trueLevel === s.predictedLevel).length / samples.length,
    meanAbsoluteError: samples.reduce((sum, s) => sum + Math.abs(s.trueLevel - s.predictedLevel), 0) / samples.length,
    normalizedAbsoluteError: samples.reduce((sum, s) => sum + Math.abs(s.trueLevel - s.predictedLevel) / (s.levels - 1), 0) / samples.length,
  };
}

export interface RankingQualificationSample {
  id: string;
  /** Higher score means preferred; scores must refer to the same stable option IDs. */
  gold: Readonly<Record<string, number>>;
  predicted: Readonly<Record<string, number>>;
}

/** Counts gold-comparable option pairs; ties in the prediction are errors, not wins. */
export function evaluateRankingHeldout(
  splits: readonly QualificationSplit[], samples: readonly RankingQualificationSample[],
): { sampleN: number; comparablePairs: number; concordance: number | null } {
  verifyQualificationSplits(splits);
  const testIds = splits.find(split => split.name === 'test')!.ids;
  if (samples.length !== testIds.length || new Set(samples.map(s => s.id)).size !== samples.length
    || samples.some(s => !testIds.includes(s.id))) throw new Error('held-out ranking membership mismatch');
  let pairs = 0;
  let correct = 0;
  for (const sample of samples) {
    const options = Object.keys(sample.gold).sort();
    if (options.length < 2 || options.length !== Object.keys(sample.predicted).length
      || options.some(option => !Object.hasOwn(sample.predicted, option))) {
      throw new Error('ranking option mismatch');
    }
    for (const option of options) {
      if (!Number.isFinite(sample.gold[option]) || !Number.isFinite(sample.predicted[option])) {
        throw new Error('invalid ranking score');
      }
    }
    for (let i = 0; i < options.length; i++) for (let j = i + 1; j < options.length; j++) {
      const goldDifference = sample.gold[options[i]!]! - sample.gold[options[j]!]!;
      if (goldDifference === 0) continue;
      pairs++;
      const predictedDifference = sample.predicted[options[i]!]! - sample.predicted[options[j]!]!;
      if (Math.sign(predictedDifference) === Math.sign(goldDifference)) correct++;
    }
  }
  return { sampleN: samples.length, comparablePairs: pairs, concordance: pairs ? correct / pairs : null };
}

export interface PairedQualificationSample {
  id: string;
  control: string;
  /** Same task after hostile-state perturbation or repeated invocation. */
  observed: string;
}

/** Measures categorical movement without claiming that either output is correct. */
export function measurePairedMovement(pairs: readonly PairedQualificationSample[]): {
  sampleN: number; changedN: number; changedRate: number; changedWilson95: readonly [number, number];
} {
  if (!pairs.length || new Set(pairs.map(pair => pair.id)).size !== pairs.length
    || pairs.some(pair => !pair.id.trim() || !pair.control.trim() || !pair.observed.trim())) {
    throw new Error('paired qualification requires unique nonempty IDs and outcomes');
  }
  const changedN = pairs.filter(pair => pair.control !== pair.observed).length;
  const [low, high] = wilson95(changedN, pairs.length);
  return { sampleN: pairs.length, changedN, changedRate: changedN / pairs.length, changedWilson95: [low, high] };
}

function wilson95(errors: number, n: number): readonly [number, number] {
  // 95% normal quantile; finite-sample Wilson interval for binomial events.
  const z = 1.959963984540054;
  const rate = errors / n;
  const denominator = 1 + z * z / n;
  const center = (rate + z * z / (2 * n)) / denominator;
  const margin = z * Math.sqrt(rate * (1 - rate) / n + z * z / (4 * n * n)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function scoreBinary(samples: readonly BinaryQualificationSample[]): BinarySliceMetrics {
  const n = samples.length;
  const errors = samples.filter(s => (s.probability >= 0.5 ? 1 : 0) !== s.label).length;
  const accepted = samples.filter(s => s.accepted);
  const acceptedErrors = accepted.filter(s => (s.probability >= 0.5 ? 1 : 0) !== s.label).length;
  const rate = errors / n;
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
    errorWilson95: wilson95(errors, n),
    latencyMs: { p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99) },
    inputTokens: sumKnown('inputTokens'), outputTokens: sumKnown('outputTokens'), costUsd: sumKnown('costUsd'),
    calls: samples.reduce((sum, s) => sum + s.calls, 0),
    retries: samples.reduce((sum, s) => sum + s.retries, 0),
    fallbacks: samples.reduce((sum, s) => sum + s.fallbacks, 0),
  };
}
