// Adapt validated D17 measurements to gate bindings without changing retained report bytes.
import { artifactDigest } from '../validate.js';
import { evaluateGates, sealGateHoldout, sealUpstream, type EvaluateGatesInput } from '../../gates/evaluate.js';
import { ceilingDecision } from '../../gates/lattice.js';
import { GateRegistry } from '../../gates/registry.js';
import { createCoreProviderRegistry, scalarProvider } from '../../gates/providers/index.js';
import { qualifyGateParameter, type GateBinding, type GateReport, type MetricObservation } from '../../gates/types.js';
import type { QualificationIntegrityMetadata } from '../qualification/release.js';
import { D17_GATE_PARAMETERS, D17_PACK_ID, d17GatePack } from './gate-policy.js';

export interface D17GateMeasurements {
  sampleN: number; missingIds: readonly string[];
  slices: readonly { slice: string; n: number }[];
  pairedDeltas: readonly { metric: string; pairs: number; delta: number | null }[];
  quality: { lowerBps: number } | null; brier: { upperBps: number } | null;
  abstention: { upperBps: number } | null; acceptedErrorUpperBps: number | null;
  coverageLowerBps: number | null; p95LatencyIncreaseMs: number | null;
}

const registry = new GateRegistry(createCoreProviderRegistry());
registry.registerPack(d17GatePack(), { namespace: 'project' });
const pack = registry.resolvePack(D17_PACK_ID);
const stamp = '2026-10-01T00:00:00.000Z';

export function d17GateBinding(): GateBinding {
  return { apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GateBinding',
    metadata: { id: 'd17-study', version: '1.0.0', description: 'Legacy D17 diagnostic replay policy.' },
    spec: { packs: [{ id: D17_PACK_ID, version: '1.0.0', digest: pack.digest, resolvedDigest: pack.resolvedDigest }],
      parameters: Object.fromEntries(Object.entries(D17_GATE_PARAMETERS).map(([name, value]) =>
        [qualifyGateParameter(D17_PACK_ID, name), value])),
      slices: pack.resolved.spec.gates.map(gate => gate.id), references: [],
      metricProviders: [{ id: scalarProvider.id, version: scalarProvider.version, sourceDigest: scalarProvider.sourceDigest }],
      registeredAt: stamp, frozenAt: stamp } };
}

/** Historical core metrics are caller-trusted; this adapter grants no new freeze/access attestation. */
export function d17GateInput(measurements: D17GateMeasurements, binding = d17GateBinding(), integrity?: QualificationIntegrityMetadata): EvaluateGatesInput {
  const m = measurements;
  const bySlice: Record<string, MetricObservation> = {};
  const add = (id: string, value: number | null, n = m.sampleN) => { bySlice[id] = { n, value }; };
  add('incomplete-pairs', m.sampleN); add('missing-pairs', m.missingIds.length);
  for (const row of m.slices) add(`slice-support-${row.slice}`, row.n, row.n);
  add('quality-ni', m.quality?.lowerBps ?? null); add('brier-upper', m.brier?.upperBps ?? null);
  add('abstention-upper', m.abstention?.upperBps ?? null); add('accepted-risk-upper', m.acceptedErrorUpperBps);
  add('coverage-lower', m.coverageLowerBps); add('latency-p95', m.p95LatencyIncreaseMs);
  // Integer basis-point lower bounds: subtract one to retain the strict benefit comparison.
  add('benefit', m.quality ? m.quality.lowerBps - 1 : null);
  for (const row of m.pairedDeltas) {
    add(`native-${row.metric}`, row.delta, row.pairs);
  }
  const trustedBindingDigest = artifactDigest(binding);
  return { binding, registry, trustedBindingDigest, metrics: { providers: {
    [scalarProvider.id]: { version: scalarProvider.version, sourceDigest: scalarProvider.sourceDigest,
      metrics: { measurement: { bySlice, pooled: null } } },
  } }, holdout: sealGateHoldout({ frozenDigest: trustedBindingDigest, firstAccessedAt: null }),
  upstream: integrity ? sealUpstream(integrity) : null, now: stamp,
  // Legacy D17 replay must not pick up ambient project policy or claim a new operator approval.
  floors: 'none-explicit-opt-out' };
}

/** Translate evaluated statuses only; threshold comparisons belong exclusively to evaluateGates. */
export function d17GateFindings(report: GateReport) {
  const findings = new Set<string>();
  for (const gate of report.gateEvidence) {
    if (gate.status === 'pass' || gate.gateId === 'benefit') continue;
    if (gate.gateId === 'missing-pairs') findings.add('incomplete-pairs');
    else if (gate.gateId.startsWith('slice-support-')) findings.add(`slice-insufficient:${gate.gateId.slice(14)}`);
    else if (gate.gateId.startsWith('native-')) findings.add(`paired-delta-${gate.n === 0 ? 'unknown' : gate.status === 'insufficient'
      ? 'insufficient' : 'failed'}:${gate.gateId.slice(7)}`);
    else findings.add(gate.gateId);
  }
  return { findings: [...findings].sort(), statisticalGate: findings.size ? 'HOLD' as const : 'pass' as const,
    benefitSupported: report.gateEvidence.some(gate => gate.gateId === 'benefit' && gate.status === 'pass') };
}

export function evaluateD17Statistics(measurements: D17GateMeasurements, binding?: GateBinding, integrity?: QualificationIntegrityMetadata) {
  return evaluateGates(d17GateInput(measurements, binding, integrity));
}

/** Independent diagnostic ceiling: neither a binding nor the calibrated D09 route may promote a study. */
export function d17StudyDecision(report: GateReport, integrity: QualificationIntegrityMetadata) {
  // Preserve D17's original release/label policy rather than adopting additional upstream allowlist rules.
  return ceilingDecision('HOLD', report.ceilings.packOutcome, report.ceilings.bindingCeiling, integrity.release_gate.decision,
    integrity.compromise_labels.length ? 'ROLLBACK' : 'PROMOTE');
}
