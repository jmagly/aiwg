import { pairedBinaryDifferenceInterval, pairedMeanDifferenceBootstrap, wilsonScoreInterval } from '../qualification/quality.js';
import type { PairedDeltaObservation } from '../ensemble/types.js';
import { D17_ANALYSIS, validateD17Analysis } from './protocol.js';
import { d17GateFindings, evaluateD17Statistics } from './gates.js';
import type { GateBinding } from '../../gates/types.js';

export interface D17ArmMeasurement {
  probability: number;
  accepted: boolean;
  correct: boolean;
  brier: number;
  latencyMs: number;
  tokens: number | null;
  reservedCostMicros: number;
}
export interface D17Pair { id: string; slice: string; champion: D17ArmMeasurement; challenger: D17ArmMeasurement }
const mean = (values: readonly number[]) => values.reduce((sum, n) => sum + n, 0) / values.length;
const p95 = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;

/** Abstentions are false for correctness, but true events in their own paired endpoint. */
function interval(pairs: readonly D17Pair[], endpoint: (arm: D17ArmMeasurement) => boolean, levelBps: number) {
  const counts = { both: 0, candidateOnly: 0, baselineOnly: 0, neither: 0 };
  for (const pair of pairs) {
    const c = endpoint(pair.challenger), b = endpoint(pair.champion);
    counts[c ? b ? 'both' : 'candidateOnly' : b ? 'baselineOnly' : 'neither']++;
  }
  return pairedBinaryDifferenceInterval({ counts, levelBps, method: 'newcombe-10' });
}

/** Local descriptive statistics, never a release authorization. Missing endpoints withhold native reporting. */
export function d17Statistics(pairs: readonly D17Pair[], expectedIds: readonly string[], protocol: unknown = D17_ANALYSIS, binding?: GateBinding) {
  validateD17Analysis(protocol);
  const p = protocol;
  if (new Set(expectedIds).size !== expectedIds.length || new Set(pairs.map(row => row.id)).size !== pairs.length
    || pairs.some(row => !expectedIds.includes(row.id) || !p.slices.some(slice => slice === row.slice))) throw new Error('D17 pair membership');
  for (const row of pairs) for (const arm of [row.champion, row.challenger]) {
    if (typeof arm.accepted !== 'boolean' || typeof arm.correct !== 'boolean' || !arm.accepted && arm.correct
      || [arm.probability, arm.brier].some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)
      || [arm.latencyMs, arm.reservedCostMicros].some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)
      || arm.tokens !== null && (!Number.isSafeInteger(arm.tokens) || arm.tokens < 0)) throw new Error('D17 unknown or invalid measurement');
  }
  const slices = p.slices.map(slice => {
    const rows = pairs.filter(row => row.slice === slice);
    const delta = rows.length ? mean(rows.map(row => Number(row.challenger.correct) - Number(row.champion.correct))) : null;
    return { slice, n: rows.length, qualityDelta: delta, harm: delta !== null && delta < 0, descriptiveOnly: true };
  });
  const metrics = (arm: D17ArmMeasurement): Record<string, number | null> => ({ quality: Number(arm.correct), calibration: arm.brier,
    'risk-coverage': Number(arm.accepted && !arm.correct), abstention: Number(!arm.accepted), latency: arm.latencyMs,
    tokens: arm.tokens, cost: arm.reservedCostMicros, slice: Number(arm.correct) });
  const pairedDeltas: PairedDeltaObservation[] = p.native.map(threshold => {
    const complete = pairs.filter(row => metrics(row.champion)[threshold.metric] !== null && metrics(row.challenger)[threshold.metric] !== null);
    const item = { metric: threshold.metric, pairs: complete.length, delta: complete.length ? mean(complete.map(row =>
      metrics(row.challenger)[threshold.metric]! - metrics(row.champion)[threshold.metric]!)) : null };
    return item;
  });
  const quality = pairs.length ? interval(pairs, arm => arm.correct, p.interval.levelBps) : null;
  const abstention = pairs.length ? interval(pairs, arm => !arm.accepted, p.abstention.levelBps) : null;
  const brier = pairs.length >= 2 ? pairedMeanDifferenceBootstrap({ differences: pairs.map(row => row.challenger.brier - row.champion.brier),
    levelBps: p.brier.levelBps, seed: p.brier.seed, resamples: p.brier.resamples, bounds: [-1, 1] }) : null;
  const accepted = pairs.filter(row => row.challenger.accepted), errors = accepted.filter(row => !row.challenger.correct).length;
  const risk = accepted.length ? wilsonScoreInterval({ events: errors, n: accepted.length, levelBps: p.risk.levelBps }) : null;
  const coverage = pairs.length ? wilsonScoreInterval({ events: accepted.length, n: pairs.length, levelBps: p.risk.levelBps }) : null;
  const acceptedErrorUpperBps = risk ? Math.ceil(risk[1] * 10000) : null;
  const coverageLowerBps = coverage ? Math.floor(coverage[0] * 10000) : null;
  const p95LatencyIncreaseMs = pairs.length ? p95(pairs.map(row => row.challenger.latencyMs)) - p95(pairs.map(row => row.champion.latencyMs)) : null;
  const observed = new Set(pairs.map(row => row.id));
  const measurements = { sampleN: pairs.length, missingIds: expectedIds.filter(id => !observed.has(id)), slices, pairedDeltas,
    quality, brier, abstention, acceptedN: accepted.length, acceptedErrors: errors, acceptedErrorUpperBps, coverageLowerBps,
    p95LatencyIncreaseMs, latencyDifferencesMs: pairs.map(row => row.challenger.latencyMs - row.champion.latencyMs),
    netSavingsMicros: pairs.reduce((sum, row) => sum + row.champion.reservedCostMicros - row.challenger.reservedCostMicros, 0),
    costBasis: 'nonrefundable-reservations-including-failed-attempts',
  };
  const gates = d17GateFindings(evaluateD17Statistics(measurements, binding));
  return { ...measurements, benefitSupported: gates.benefitSupported, findings: gates.findings, statisticalGate: gates.statisticalGate,
    worstCaseFailureAsError: { n: expectedIds.length, championCorrect: pairs.filter(row => row.champion.correct).length,
      challengerCorrect: pairs.filter(row => row.challenger.correct).length, missingPairsCountedAsErrors: expectedIds.length - pairs.length } };
}
