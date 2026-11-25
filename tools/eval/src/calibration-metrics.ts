// Compute type-appropriate agreement and deterministic family-clustered intervals.
import type { Criterion } from './calibration-types.js';
import { random } from './pilot-files.js';
const ratio = (a: number, b: number): number | null => b ? a / b : null;
export function criterionMetrics(criterion: Criterion, pairs: [string, string][]) {
  const labels = Object.keys(criterion.anchors).sort((a, b) => criterion.type === 'ordinal' ? criterion.values[a]! - criterion.values[b]! : a.localeCompare(b));
  const matrix = labels.map(() => labels.map(() => 0));
  for (const [truth, predicted] of pairs) {
    const i = labels.indexOf(truth), j = labels.indexOf(predicted);
    if (i < 0 || j < 0) throw new Error('Invalid metric label');
    matrix[i][j]++;
  }
  const n = pairs.length;
  const rows = matrix.map(row => row.reduce((a, b) => a + b, 0));
  const cols = labels.map((_, j) => matrix.reduce((a, row) => a + row[j], 0));
  const correct = matrix.reduce((a, row, i) => a + row[i], 0);
  const expected = rows.reduce((a, v, i) => a + v * cols[i], 0);
  const base = { n, labels, confusion: matrix, exact: ratio(correct, n), kappa: ratio(n * correct - expected, n * n - expected) };
  if (criterion.type === 'binary') {
    const met = labels.indexOf('MET'), unmet = labels.indexOf('UNMET');
    const tp = matrix[met][met], fp = matrix[unmet][met], fn = matrix[met][unmet], tn = matrix[unmet][unmet];
    return { ...base, tp, fp, fn, tn, sensitivity: ratio(tp, tp + fn), specificity: ratio(tn, tn + fp), precision: ratio(tp, tp + fp) };
  }
  if (criterion.type === 'ordinal') {
    let observed = 0, chance = 0, adjacent = 0, bias = 0;
    matrix.forEach((row, i) => row.forEach((v, j) => {
      observed += v * (i - j) ** 2;
      chance += rows[i] * cols[j] * (i - j) ** 2;
      if (Math.abs(i - j) <= 1) adjacent += v;
      bias += v * (criterion.values[labels[j]]! - criterion.values[labels[i]]!);
    }));
    return { ...base, adjacent: ratio(adjacent, n), quadratic_kappa: chance ? 1 - n * observed / chance : null, directional_bias: ratio(bias, n) };
  }
  const represented = labels.map((_, i) => i).filter(i => rows[i] + cols[i] > 0);
  return { ...base, per_class_recall: Object.fromEntries(labels.map((label, i) => [label, ratio(matrix[i][i], rows[i])])),
    macro_f1: ratio(represented.reduce((sum, i) => sum + 2 * matrix[i][i] / (rows[i] + cols[i]), 0), represented.length) };
}

export function clusteredInterval(rows: { family: string; value: number }[], seed: number) {
  const groups = new Map<string, number[]>();
  for (const row of rows) groups.set(row.family, [...(groups.get(row.family) ?? []), row.value]);
  const families = [...groups.keys()].sort();
  const rng = random(seed), draws: number[] = [];
  for (let iteration = 0; iteration < 2000 && families.length; iteration++) {
    let sum = 0, count = 0;
    for (let j = 0; j < families.length; j++) {
      const values = groups.get(families[Math.floor(rng() * families.length)])!;
      sum += values.reduce((a, b) => a + b, 0); count += values.length;
    }
    draws.push(sum / count);
  }
  draws.sort((a, b) => a - b);
  return { method: 'scenario-family-percentile' as const, confidence: 0.95, seed, resamples: 2000,
    clusters: families.length, estimate: ratio(rows.reduce((a, r) => a + r.value, 0), rows.length),
    lower: draws.length ? draws[49] : null, upper: draws.length ? draws[1949] : null,
    limitation: families.length < 10 ? 'too few scenario families for reliable uncertainty; descriptive interval only' : null };
}

export function scoreCriteria(criteria: Criterion[], labels: Record<string, string>) {
  const excluded = { NOT_APPLICABLE: 0, CANNOT_ASSESS: 0, PROVIDER_ERROR: 0, PARTIAL: 0, MISSING: 0 };
  let numerator = 0, retainedWeight = 0, retainedCount = 0, applicableCount = 0;
  for (const c of criteria) {
    const label = labels[c.id] ?? 'MISSING';
    if (label !== 'NOT_APPLICABLE') applicableCount++;
    if (Object.hasOwn(excluded, label)) { excluded[label as keyof typeof excluded]++; continue; }
    if (!Object.hasOwn(c.anchors, label)) throw new Error(`Invalid label for ${c.id}`);
    if (c.type === 'nominal') continue;
    numerator += c.weight * c.values[label]!;
    retainedWeight += c.weight; retainedCount++;
  }
  return { score: ratio(numerator, retainedWeight), original_count: criteria.length, retained_count: retainedCount,
    applicable_count: applicableCount, original_weight: criteria.reduce((n, c) => n + c.weight, 0), retained_weight: retainedWeight, excluded };
}

export function ensembleLabel(criterion: Criterion, labels: string[]): string {
  // Require an absolute majority of the full panel, including abstaining members.
  const counts = new Map<string, number>();
  for (const label of labels) {
    if (Object.hasOwn(criterion.anchors, label) || (criterion.allows_na && label === 'NOT_APPLICABLE')) counts.set(label, (counts.get(label) ?? 0) + 1);
    else if (!['CANNOT_ASSESS', 'NOT_APPLICABLE', 'PROVIDER_ERROR', 'MISSING'].includes(label)) throw new Error('Invalid ensemble label');
  }
  return [...counts].find(([, n]) => n > labels.length / 2)?.[0] ?? 'CANNOT_ASSESS';
}
