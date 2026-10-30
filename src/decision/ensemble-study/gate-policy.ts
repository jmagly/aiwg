// Own D17 threshold values and the gate pack used by the frozen protocol projection.
import type { GateDefinition, GatePack } from '../../gates/types.js';
import { scalarProvider } from '../../gates/providers/index.js';

export const D17_PACK_ID = 'project:d17-study';
export const D17_SLICES = ['direct-facts', 'multi-fact', 'negation', 'authority'] as const;
const base = {
  minimumPairs: 1200, minimumPerSlice: 300, maximumMissingPairs: 0,
  nonInferiorityMarginBps: -300, benefitLowerExclusiveBps: 0,
  maximumBrierUpperBps: 200, maximumAcceptedErrorUpperBps: 500,
  minimumCoverageLowerBps: 6000, maximumAbstentionUpperBps: 500,
  maximumP95LatencyIncreaseMs: 15000, maximumDisagreementBps: 1000,
  minimumSuccessfulMembers: 3, highAgreementWarningBps: 100,
  nativeRiskCoverage: 0.01, nativeLatency: 10000, nativeTokens: 8000, nativeCost: 800,
} as const;
export const D17_NATIVE = [
  { metric: 'quality', comparison: 'delta-at-least', param: 'nonInferiorityMarginBps', divisor: 10000 },
  { metric: 'calibration', comparison: 'delta-at-most', param: 'maximumBrierUpperBps', divisor: 10000 },
  { metric: 'risk-coverage', comparison: 'delta-at-most', param: 'nativeRiskCoverage', divisor: 1 },
  { metric: 'abstention', comparison: 'delta-at-most', param: 'maximumAbstentionUpperBps', divisor: 10000 },
  { metric: 'latency', comparison: 'delta-at-most', param: 'nativeLatency', divisor: 1 },
  { metric: 'tokens', comparison: 'delta-at-most', param: 'nativeTokens', divisor: 1 },
  { metric: 'cost', comparison: 'delta-at-most', param: 'nativeCost', divisor: 1 },
  { metric: 'slice', comparison: 'delta-at-least', param: 'nonInferiorityMarginBps', divisor: 10000 },
] as const;
export const d17NativeParameter = (metric: string) => `native_${metric.replaceAll('-', '_')}`;
export const D17_NATIVE_BOUNDS: Record<string, number> = Object.fromEntries(D17_NATIVE.map(row =>
  [d17NativeParameter(row.metric), base[row.param] / row.divisor]));
export const D17_GATE_PARAMETERS = { ...base, ...D17_NATIVE_BOUNDS };

/** Scalar targets are the historical rounded endpoints, not newly recomputed intervals. */
export function d17GatePack(): GatePack {
  const definitions: Array<readonly [string, string, 'lte' | 'gte']> = [
    ['incomplete-pairs', 'minimumPairs', 'gte'], ['missing-pairs', 'maximumMissingPairs', 'lte'],
    ...D17_SLICES.map(slice => [`slice-support-${slice}`, 'minimumPerSlice', 'gte'] as const),
    ['quality-ni', 'nonInferiorityMarginBps', 'gte'], ['brier-upper', 'maximumBrierUpperBps', 'lte'],
    ['abstention-upper', 'maximumAbstentionUpperBps', 'lte'],
    ['accepted-risk-upper', 'maximumAcceptedErrorUpperBps', 'lte'],
    ['coverage-lower', 'minimumCoverageLowerBps', 'gte'],
    ['latency-p95', 'maximumP95LatencyIncreaseMs', 'lte'],
    ['benefit', 'benefitLowerExclusiveBps', 'gte'],
    ...D17_NATIVE.map(row => [`native-${row.metric}`, d17NativeParameter(row.metric),
      row.comparison === 'delta-at-least' ? 'gte' : 'lte'] as const),
  ];
  const direction = (name: string) => name.startsWith('minimum') || name === 'nonInferiorityMarginBps'
    || name === 'benefitLowerExclusiveBps' || name === 'native_quality' || name === 'native_slice' ? 'higher-is-stricter' as const : 'lower-is-stricter' as const;
  const gates = definitions.map(([id, param, op]): GateDefinition => {
    const support = param === 'minimumPairs' || param === 'minimumPerSlice';
    return { id, kind: support ? 'minimum-n' : 'value-threshold',
      metric: { provider: scalarProvider.id, name: 'measurement' },
      ...(support ? { minimumN: { param } } : { threshold: { op, param } }),
      scope: { mode: 'listed', slices: [id] },
      ...(id.startsWith('native-') ? { minimumN: { param: 'minimumPairs' } } : {}),
      direction: op === 'gte' ? 'higher-is-stricter' : 'lower-is-stricter', onFail: 'HOLD' };
  });
  return { apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GatePack',
    metadata: { id: D17_PACK_ID, version: '1.0.0', description: 'D17 historical diagnostic endpoints.' },
    spec: { parameters: Object.fromEntries(Object.keys(D17_GATE_PARAMETERS).map(name => [name,
      { type: name === 'minimumPairs' || name === 'minimumPerSlice' ? 'count' : 'value', direction: direction(name) }])),
    metrics: { measurement: { provider: scalarProvider.id, kind: 'scalar' } }, gates,
    combine: { rule: 'max-severity' } } };
}
