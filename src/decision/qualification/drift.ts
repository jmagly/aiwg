import { measurePairedMovement, type PairedQualificationSample } from './quality.js';

/** Preregistered bounds for a categorical drift comparison. Choose them before observing the candidate. */
export interface CategoricalDriftPlan {
  minimumN: number;
  /** Upper bound on total variation distance, in [0, 1]. */
  maximumTotalVariation: number;
  /** Upper bound on the population stability index. */
  maximumPopulationStability: number;
}

export interface CategoricalDriftReport {
  schemaVersion: 'decision-categorical-drift/v1';
  referenceN: number;
  candidateN: number;
  categories: string[];
  reference: Record<string, number>;
  candidate: Record<string, number>;
  totalVariation: number;
  populationStability: number;
  decision: 'stable' | 'drift' | 'insufficient-evidence';
  reasons: string[];
}

// Smoothing keeps PSI finite for categories that appear in only one sample.
// It is a reporting convention, not a statistical test.
const PSI_EPSILON = 1e-4;

function validPlan(plan: CategoricalDriftPlan): boolean {
  return Number.isSafeInteger(plan.minimumN) && plan.minimumN >= 1
    && Number.isFinite(plan.maximumTotalVariation) && plan.maximumTotalVariation >= 0 && plan.maximumTotalVariation <= 1
    && Number.isFinite(plan.maximumPopulationStability) && plan.maximumPopulationStability >= 0;
}

function proportions(values: readonly string[], categories: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries(categories.map(category => [category, (counts.get(category) ?? 0) / values.length]));
}

/**
 * Compares two categorical samples: model outputs for output drift, or input
 * slice membership for population drift. Too few observations are
 * `insufficient-evidence`, never `stable`.
 */
export function measureCategoricalDrift(
  reference: readonly string[], candidate: readonly string[], plan: CategoricalDriftPlan,
): CategoricalDriftReport {
  if (!validPlan(plan) || [...reference, ...candidate].some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('categorical drift requires a valid plan and nonempty categorical values');
  }
  const categories = [...new Set([...reference, ...candidate])].sort();
  const insufficient = reference.length < plan.minimumN || candidate.length < plan.minimumN;
  const left = reference.length ? proportions(reference, categories) : {};
  const right = candidate.length ? proportions(candidate, categories) : {};
  let totalVariation = 0;
  let populationStability = 0;
  if (!insufficient) {
    for (const category of categories) {
      const p = left[category]!;
      const q = right[category]!;
      totalVariation += Math.abs(p - q) / 2;
      const ps = Math.max(p, PSI_EPSILON);
      const qs = Math.max(q, PSI_EPSILON);
      populationStability += (qs - ps) * Math.log(qs / ps);
    }
  }
  const reasons: string[] = [];
  if (insufficient) reasons.push('insufficient-samples');
  if (!insufficient && totalVariation > plan.maximumTotalVariation) reasons.push('total-variation');
  if (!insufficient && populationStability > plan.maximumPopulationStability) reasons.push('population-stability');
  return {
    schemaVersion: 'decision-categorical-drift/v1', referenceN: reference.length, candidateN: candidate.length,
    categories, reference: left, candidate: right, totalVariation, populationStability,
    decision: insufficient ? 'insufficient-evidence' : reasons.length ? 'drift' : 'stable', reasons,
  };
}

export interface LabelStabilityReport {
  sampleN: number;
  changedN: number;
  changedRate: number;
  changedWilson95: readonly [number, number];
  maximumChangedRate: number;
  decision: 'stable' | 'drift' | 'insufficient-evidence';
}

/**
 * Repeated-run label movement against a preregistered bound. Stable only when
 * the whole 95% interval is within the bound; drift only when it is entirely
 * above; otherwise the sample cannot decide.
 */
export function measureLabelStability(
  pairs: readonly PairedQualificationSample[], maximumChangedRate: number,
): LabelStabilityReport {
  if (!Number.isFinite(maximumChangedRate) || maximumChangedRate < 0 || maximumChangedRate > 1) {
    throw new Error('label stability requires a changed-rate bound in [0, 1]');
  }
  const movement = measurePairedMovement(pairs);
  const [low, high] = movement.changedWilson95;
  return { ...movement, maximumChangedRate,
    decision: high <= maximumChangedRate ? 'stable' : low > maximumChangedRate ? 'drift' : 'insufficient-evidence' };
}
