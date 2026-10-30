// Pool metric observations and evaluate each gate against resolved binding parameters.
import { evaluatePredicate } from '../decision/predicates.js';
import { evaluateUpstreamCeiling } from './upstream-ceiling.js';
import { clopperPearsonInterval } from './stats/clopper-pearson.js';
import { wilsonScoreInterval } from './stats/binomial.js';
import { pairedMeanDifferenceBootstrap } from './stats/bootstrap.js';
import { PairedDifferenceError } from './stats/error.js';
import { pairedBinaryDifferenceInterval, pairedNonInferiority } from './stats/paired.js';
import { qualifyGateParameter } from './types.js';
import type { ResolvedBinding } from './registry.js';
import type { GateDefinition, GateEvidence, GateMetricsDocument, GateParamRef, GateStatus, MetricObservation, MetricSeries, UpstreamCeiling } from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function supportOf(observation: MetricObservation | null | undefined): number | null {
  const n = observation?.n;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function poolObservations(kind: string, observations: MetricObservation[]): MetricObservation | null {
  if (!observations.length) return null;
  if (kind === 'proportion') {
    let n = 0;
    let events = 0;
    for (const observation of observations) {
      if (supportOf(observation) === null || typeof observation.events !== 'number'
        || !Number.isSafeInteger(observation.events) || observation.events < 0) return null;
      if ((observation.events as number) > (observation.n as number)) return null;
      n += observation.n as number;
      events += observation.events;
    }
    return { n, events };
  }
  if (kind === 'paired') {
    const total = { both: 0, candidateOnly: 0, baselineOnly: 0, neither: 0 };
    let n = 0;
    for (const observation of observations) {
      const cells = isRecord(observation?.paired)
        ? ['both', 'candidateOnly', 'baselineOnly', 'neither'].map(key =>
          (observation.paired as Record<string, unknown>)[key])
        : [];
      if (supportOf(observation) === null || cells.length !== 4
        || cells.some(cell => !Number.isSafeInteger(cell) || (cell as number) < 0)) {
        return null;
      }
      const [both, candidateOnly, baselineOnly, neither] = cells as [number, number, number, number];
      // The counted support must equal the cell sums; a disagreement is unknown, fail closed.
      if ((observation.n as number) !== both + candidateOnly + baselineOnly + neither) return null;
      n += observation.n as number;
      total.both += both;
      total.candidateOnly += candidateOnly;
      total.baselineOnly += baselineOnly;
      total.neither += neither;
    }
    return { n, paired: total };
  }
  if (kind === 'scalar') {
    let n = 0;
    let weighted = 0;
    for (const observation of observations) {
      if (supportOf(observation) === null || typeof observation.value !== 'number' || !Number.isFinite(observation.value)) return null;
      n += observation.n as number;
      weighted += (observation.n as number) * (observation.value as number);
    }
    return n === 0 ? null : { n, value: weighted / n };
  }
  if (kind === 'differences') {
    const differences: number[] = [];
    let n = 0;
    for (const observation of observations) {
      if (supportOf(observation) === null || !Array.isArray(observation.differences)
        || observation.differences.some(value => typeof value !== 'number' || !Number.isFinite(value))) return null;
      if ((observation.n as number) !== (observation.differences as number[]).length) return null;
      n += observation.n as number;
      differences.push(...(observation.differences as number[]));
    }
    return { n, differences };
  }
  if (kind === 'evidence') {
    const available = observations.flatMap(observation => observation?.available ?? []);
    if (observations.some(observation => !Array.isArray(observation?.available))) return null;
    return { available };
  }
  return null;
}

interface SliceEvaluation {
  slice: string | null;
  status: GateStatus;
  reason: string;
  n: number | null;
  events?: number | null;
  statistic?: GateEvidence['statistic'];
  threshold?: GateEvidence['threshold'];
}

export function seriesFor(gate: GateDefinition, pack: ResolvedBinding['packs'][number],
  metrics: GateMetricsDocument): MetricSeries | null {
  if (gate.metric === undefined) return null;
  const declared = pack.resolved.spec.metrics[gate.metric.name];
  if (declared === undefined || declared.provider !== gate.metric.provider) return null;
  return metrics.providers[gate.metric.provider]?.metrics[gate.metric.name] ?? null;
}

export function metricKindOf(gate: GateDefinition, pack: ResolvedBinding['packs'][number]): string {
  if (gate.metric === undefined) return '';
  return pack.resolved.spec.metrics[gate.metric.name]?.kind ?? '';
}

export function expandScope(gate: GateDefinition, kind: string, series: MetricSeries | null,
  slices: string[]): { slice: string | null; observation: MetricObservation | null }[] {
  const mode = gate.scope.mode;
  if (mode === 'all') return [{ slice: null, observation: series?.pooled ?? null }];
  if (mode === 'pooled') {
    const observations = (gate.scope.slices ?? []).map(slice => series?.bySlice[slice] ?? null);
    if (observations.some(observation => observation === null)) {
      return [{ slice: null, observation: null }];
    }
    return [{ slice: null, observation: poolObservations(kind, observations as MetricObservation[]) }];
  }
  const excluded = new Set(gate.scope.except ?? []);
  const names = mode === 'each' ? slices.filter(slice => !excluded.has(slice)) : (gate.scope.slices ?? []);
  return names.map(slice => ({ slice, observation: series?.bySlice[slice] ?? null }));
}

function pairedCells(observation: MetricObservation | null | undefined): {
  both: number; candidateOnly: number; baselineOnly: number; neither: number;
} | null {
  if (!isRecord(observation?.paired)) return null;
  const cells = ['both', 'candidateOnly', 'baselineOnly', 'neither'].map(key =>
    (observation.paired as Record<string, unknown>)[key]);
  if (cells.some(cell => !Number.isSafeInteger(cell) || (cell as number) < 0)) return null;
  const [both, candidateOnly, baselineOnly, neither] = cells as [number, number, number, number];
  return { both, candidateOnly, baselineOnly, neither };
}

/**
 * Resolve a literal-or-parameter gate number against the binding's
 * preregistered values. Null when a `{param}` reference has no resolved
 * value: callers hold as `parameter-missing`, never promote.
 */
function resolveGateNumber(
  value: number | GateParamRef | undefined,
  packId: string,
  parameters: Record<string, number>,
): number | null {
  if (value === undefined) return null;
  if (typeof value === 'number') return value;
  if (value !== null && typeof value === 'object' && typeof value.param === 'string') {
    const resolved = parameters[qualifyGateParameter(packId, value.param)];
    return typeof resolved === 'number' ? resolved : null;
  }
  return null;
}

export function evaluateObservation(gate: GateDefinition, observation: MetricObservation | null,
  context: { packId: string; parameters: Record<string, number>; metrics: GateMetricsDocument;
    upstream: UpstreamCeiling | null; nowMs: number; slice: string | null; slices: string[] }): SliceEvaluation {
  const { packId, parameters, metrics, upstream, nowMs, slice, slices } = context;
  const base = { slice, n: supportOf(observation) };
  const minimumN = gate.minimumN === undefined ? 0 : resolveGateNumber(gate.minimumN, packId, parameters);
  // Evidence gates observe attestations, not counted support; upstream and predicate
  // gates read the ceiling and the whole document. None of them take an n.
  if (gate.kind !== 'upstream-ceiling' && gate.kind !== 'predicate' && gate.kind !== 'evidence') {
    if (observation === null || observation === undefined) return { ...base, status: 'insufficient', reason: 'metric-missing' };
    if (base.n === null) return { ...base, status: 'insufficient', reason: 'support-unknown' };
    if (minimumN === null) return { ...base, status: 'insufficient', reason: 'parameter-missing' };
    if (base.n < minimumN) return { ...base, status: 'insufficient', reason: 'below-minimum-n' };
  }
  const thresholdValue = (): number | null => {
    if (gate.threshold?.value !== undefined) return gate.threshold.value;
    if (gate.threshold?.param !== undefined) {
      const value = parameters[qualifyGateParameter(packId, gate.threshold.param)];
      return typeof value === 'number' ? value : null;
    }
    return null;
  };
  switch (gate.kind) {
    case 'minimum-n': {
      const target = gate.minimumN === undefined ? null : resolveGateNumber(gate.minimumN, packId, parameters);
      if (target === null) {
        return { ...base, status: 'insufficient', reason: 'parameter-missing',
          statistic: { method: 'support-count' } };
      }
      const passed = (base.n as number) >= target;
      return { ...base, status: passed ? 'pass' : 'insufficient', reason: passed ? 'support-met' : 'below-minimum-n',
        statistic: { method: 'support-count' } };
    }
    case 'interval-bound': {
      const events = observation?.events;
      if (typeof events !== 'number' || !Number.isSafeInteger(events) || events < 0) {
        return { ...base, status: 'insufficient', reason: 'events-unknown', events: null };
      }
      if (events > (base.n as number)) return { ...base, status: 'insufficient', reason: 'events-exceed-n', events };
      const target = thresholdValue();
      if (target === null) return { ...base, status: 'insufficient', reason: 'parameter-missing', events };
      const method = gate.statistic?.method ?? 'wilson';
      const levelBps = resolveGateNumber(gate.statistic?.levelBps, packId, parameters);
      if (levelBps === null) return { ...base, status: 'insufficient', reason: 'parameter-missing', events };
      let lower: number;
      let upper: number;
      try {
        if (method === 'clopper-pearson') {
          ({ lower, upper } = clopperPearsonInterval({ events, n: base.n as number, levelBps }));
        } else {
          [lower, upper] = wilsonScoreInterval({ events, n: base.n as number, levelBps });
        }
      } catch (error) {
        if (error instanceof PairedDifferenceError) {
          return { ...base, status: 'insufficient', reason: 'statistic-invalid', events };
        }
        throw error;
      }
      const lowerBps = Math.max(0, Math.floor(lower * 10000));
      const upperBps = Math.min(10000, Math.ceil(upper * 10000));
      const estimateBps = Math.round(events / (base.n as number) * 10000);
      const passed = gate.statistic?.bound === 'upper' ? upperBps <= target : lowerBps >= target;
      return { ...base, status: passed ? 'pass' : 'fail', reason: passed ? 'bound-within-threshold' : 'bound-breaches-threshold',
        events, statistic: { method, levelBps, lowerBps, upperBps, estimateBps },
        threshold: { op: gate.threshold?.op as 'lte' | 'gte', ...(gate.threshold?.value !== undefined
          ? { value: gate.threshold.value } : { param: gate.threshold?.param as string }), resolved: target } };
    }
    case 'paired-difference': {
      const cells = pairedCells(observation);
      if (cells === null) return { ...base, status: 'insufficient', reason: 'paired-unknown' };
      if ((base.n as number) !== cells.both + cells.candidateOnly + cells.baselineOnly + cells.neither) {
        return { ...base, status: 'insufficient', reason: 'observation-mismatch' };
      }
      const method = gate.statistic?.method ?? 'newcombe';
      const levelBps = resolveGateNumber(gate.statistic?.levelBps, packId, parameters);
      if (levelBps === null) return { ...base, status: 'insufficient', reason: 'parameter-missing' };
      let interval;
      try {
        interval = pairedBinaryDifferenceInterval({ counts: cells, levelBps, method: method === 'tango' ? 'tango' : 'newcombe-10' });
      } catch (error) {
        if (error instanceof PairedDifferenceError) return { ...base, status: 'insufficient', reason: 'paired-invalid' };
        throw error;
      }
      const mode = gate.statistic?.mode ?? 'non-inferiority';
      const margin = resolveGateNumber(gate.statistic?.marginBps ?? 0, packId, parameters);
      if (margin === null) return { ...base, status: 'insufficient', reason: 'parameter-missing' };
      const statistic = { method, levelBps, lowerBps: interval.lowerBps, upperBps: interval.upperBps,
        estimateBps: interval.estimateBps };
      const threshold = { op: 'gte' as const, resolved: margin };
      if (mode === 'non-inferiority') {
        const verdict = pairedNonInferiority({ interval, marginBps: margin });
        if (verdict.decision === 'insufficient') return { ...base, status: 'insufficient', reason: 'paired-invalid', statistic, threshold };
        const passed = verdict.decision === 'non-inferior';
        return { ...base, status: passed ? 'pass' : 'fail',
          reason: passed ? 'lower-bound-at-or-above-margin' : 'lower-bound-below-margin', statistic, threshold };
      }
      const passed = interval.lowerBps > margin;
      return { ...base, status: passed ? 'pass' : 'fail',
        reason: passed ? 'lower-bound-above-margin' : 'lower-bound-at-or-below-margin', statistic, threshold };
    }
    case 'bootstrap-bound': {
      const differences = observation?.differences;
      if (!Array.isArray(differences)) return { ...base, status: 'insufficient', reason: 'differences-unknown' };
      if (differences.length !== base.n) return { ...base, status: 'insufficient', reason: 'observation-mismatch' };
      const target = thresholdValue();
      if (target === null) return { ...base, status: 'insufficient', reason: 'parameter-missing' };
      const levelBps = resolveGateNumber(gate.statistic?.levelBps, packId, parameters);
      if (levelBps === null) return { ...base, status: 'insufficient', reason: 'parameter-missing' };
      let interval;
      try {
        interval = pairedMeanDifferenceBootstrap({ differences, levelBps,
          seed: gate.statistic?.seed as number, resamples: gate.statistic?.resamples as number,
          bounds: gate.statistic?.bounds as [number, number] });
      } catch (error) {
        if (error instanceof PairedDifferenceError) return { ...base, status: 'insufficient', reason: 'statistic-invalid' };
        throw error;
      }
      const passed = gate.statistic?.bound === 'upper' ? interval.upperBps <= target : interval.lowerBps >= target;
      return { ...base, status: passed ? 'pass' : 'fail', reason: passed ? 'bound-within-threshold' : 'bound-breaches-threshold',
        statistic: { method: 'bootstrap', levelBps, lowerBps: interval.lowerBps,
          upperBps: interval.upperBps, estimateBps: interval.estimateBps },
        threshold: { op: gate.threshold?.op as 'lte' | 'gte', ...(gate.threshold?.value !== undefined
          ? { value: gate.threshold.value } : { param: gate.threshold?.param as string }), resolved: target } };
    }
    case 'count-max':
    case 'count-min': {
      const events = observation?.events;
      if (typeof events !== 'number' || !Number.isSafeInteger(events) || events < 0) {
        return { ...base, status: 'insufficient', reason: 'events-unknown', events: null };
      }
      if (events > (base.n as number)) return { ...base, status: 'insufficient', reason: 'events-exceed-n', events };
      const target = thresholdValue();
      if (target === null) return { ...base, status: 'insufficient', reason: 'parameter-missing', events };
      const passed = gate.kind === 'count-max' ? events <= target : events >= target;
      return { ...base, status: passed ? 'pass' : 'fail', reason: passed ? 'count-within-threshold' : 'count-breaches-threshold',
        events, statistic: { method: 'exact-count' },
        threshold: { op: gate.threshold?.op as 'lte' | 'gte', ...(gate.threshold?.value !== undefined
          ? { value: gate.threshold.value } : { param: gate.threshold?.param as string }), resolved: target } };
    }
    case 'value-threshold': {
      const value = observation?.value;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ...base, status: 'insufficient', reason: 'value-unknown' };
      }
      const target = thresholdValue();
      if (target === null) return { ...base, status: 'insufficient', reason: 'parameter-missing' };
      const passed = gate.threshold?.op === 'lte' ? value <= target : value >= target;
      return { ...base, status: passed ? 'pass' : 'fail', reason: passed ? 'value-within-threshold' : 'value-breaches-threshold',
        statistic: { method: 'exact-value' },
        threshold: { op: gate.threshold?.op as 'lte' | 'gte', ...(gate.threshold?.value !== undefined
          ? { value: gate.threshold.value } : { param: gate.threshold?.param as string }), resolved: target } };
    }
    case 'evidence': {
      const available = observation?.available;
      if (!Array.isArray(available)) return { ...base, status: 'insufficient', reason: 'evidence-unknown' };
      for (const id of gate.evidence?.required ?? []) {
        const entry = available.find(candidate => candidate?.id === id);
        if (entry === undefined) return { ...base, status: 'insufficient', reason: 'evidence-missing', statistic: { method: 'evidence-present' } };
        if (entry.passed !== true) {
          return { ...base, status: 'fail', reason: 'evidence-failed', statistic: { method: 'evidence-present' } };
        }
        if (entry.expiresAt !== undefined && entry.expiresAt !== null) {
          const expiry = Date.parse(entry.expiresAt);
          if (!Number.isFinite(expiry) || expiry <= nowMs) {
            return { ...base, status: 'fail', reason: 'evidence-expired', statistic: { method: 'evidence-present' } };
          }
        }
      }
      return { ...base, status: 'pass', reason: 'evidence-present', statistic: { method: 'evidence-present' } };
    }
    case 'predicate': {
      let value: unknown = 'unknown';
      try {
        value = evaluatePredicate(gate.predicate!, { metrics, parameters, slices }, {});
      } catch {
        value = 'unknown';
      }
      if (value === true) return { ...base, status: 'pass', reason: 'predicate-true', statistic: { method: 'predicate' } };
      if (value === false) return { ...base, status: 'fail', reason: 'predicate-false', statistic: { method: 'predicate' } };
      return { ...base, status: 'insufficient', reason: 'predicate-unknown', statistic: { method: 'predicate' } };
    }
    case 'upstream-ceiling': {
      if (upstream === null) return { ...base, status: 'insufficient', reason: 'upstream-missing',
        statistic: { method: 'upstream-integrity' } };
      const { problems, compromised } = evaluateUpstreamCeiling(upstream.metadata);
      if (!problems.length) {
        return { ...base, status: 'pass', reason: 'upstream-clean', statistic: { method: 'upstream-integrity' } };
      }
      return { ...base, status: 'fail', reason: compromised ? 'upstream-compromised' : 'upstream-allowlist',
        statistic: { method: 'upstream-integrity' } };
    }
  }
}

