// Adapt the frozen D23 policy and validated observations to the shipped gate evaluator.
import { artifactDigest } from '../validate.js';
import { evaluateGates, sealGateHoldout, sealUpstream, type EvaluateGatesInput } from '../../gates/evaluate.js';
import { GateRegistry } from '../../gates/registry.js';
import { createCoreProviderRegistry, evidenceProvider, pairedProvider, proportionProvider } from '../../gates/providers/index.js';
import { qualifyGateParameter, type GateBinding, type GateDefinition, type GatePack, type GateReport } from '../../gates/types.js';
import type { ComparativeReplayInput, ComparativeReplayReport } from './comparative.js';

export const COMPARATIVE_REPLAY_POLICY = {
  minimumTestRoots: 400, minimumSliceRoots: 100, levelBps: 9500,
  pairedMethod: 'newcombe-10', errorMethod: 'wilson', nonInferiorityMarginBps: -100,
  maxErrorUpperBps: 100, maxSliceErrorUpperBps: 500,
  maxBackendCalls: 0, maxTokens: 0, maxCostMicros: 0, requireExactReproduction: true,
} as const;

const PACK_ID = 'project:d23-comparative-replay';
const SLICES = ['threshold-boundary', 'priority-loss', 'unchanged-control', 'unreplayable'];
const ALL = { mode: 'all' } as const;
const LOWER = 'lower-is-stricter';
const HIGHER = 'higher-is-stricter';
const CHECKS = ['reports-valid', 'zero-call-budget-violated', 'reproduction-mismatch',
  'integrity-sample-mismatch', 'reviewer-audit-pending'] as const;
const NON_DIAGNOSTIC = new Set(['integrity-ceiling', 'integrity-sample-mismatch', 'reviewer-audit-pending']);

function replayPack(): GatePack {
  const errors = { provider: proportionProvider.id, name: 'false-ready' };
  const gate = (id: string, kind: GateDefinition['kind'], rest: Partial<GateDefinition>): GateDefinition =>
    ({ id, kind, scope: ALL, direction: LOWER, onFail: 'HOLD', ...rest });
  return {
    apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GatePack',
    metadata: { id: PACK_ID, version: '1.0.0', description: 'Frozen D23 comparative policy replay criteria.' },
    spec: {
      parameters: {
        minimumTestRoots: { type: 'count', direction: HIGHER },
        minimumSliceRoots: { type: 'count', direction: HIGHER },
        levelBps: { type: 'level', direction: HIGHER },
        nonInferiorityMarginBps: { type: 'value', direction: HIGHER },
        maxErrorUpperBps: { type: 'bps', direction: LOWER },
        maxSliceErrorUpperBps: { type: 'bps', direction: LOWER },
      },
      metrics: {
        'false-ready': { provider: proportionProvider.id, kind: 'proportion' },
        coverage: { provider: proportionProvider.id, kind: 'proportion' },
        contrast: { provider: pairedProvider.id, kind: 'paired' },
        attestations: { provider: evidenceProvider.id, kind: 'evidence' },
      },
      gates: [
        gate('test-support-insufficient', 'minimum-n', { metric: errors, direction: HIGHER,
          minimumN: { param: 'minimumTestRoots' } }),
        gate('diagnostic-errors', 'count-max', { metric: errors, threshold: { op: 'lte', value: 0 } }),
        gate('false-no-change', 'count-max', { metric: { provider: proportionProvider.id, name: 'coverage' },
          threshold: { op: 'lte', value: 0 } }),
        gate('non-inferiority-failed', 'paired-difference', {
          metric: { provider: pairedProvider.id, name: 'contrast' }, direction: HIGHER,
          statistic: { kind: 'paired-difference', method: 'newcombe', levelBps: { param: 'levelBps' },
            mode: 'non-inferiority', marginBps: { param: 'nonInferiorityMarginBps' } },
        }),
        gate('error-bound-failed', 'interval-bound', { metric: errors,
          statistic: { kind: 'interval-bound', method: 'wilson', bound: 'upper', levelBps: { param: 'levelBps' } },
          threshold: { op: 'lte', param: 'maxErrorUpperBps' } }),
        gate('slice-support', 'minimum-n', { metric: errors, direction: HIGHER, scope: { mode: 'each' },
          minimumN: { param: 'minimumSliceRoots' } }),
        gate('slice-errors', 'count-max', { metric: errors, scope: { mode: 'each' }, threshold: { op: 'lte', value: 0 } }),
        gate('slice-error-bound', 'interval-bound', { metric: errors, scope: { mode: 'each' },
          statistic: { kind: 'interval-bound', method: 'wilson', bound: 'upper', levelBps: { param: 'levelBps' } },
          threshold: { op: 'lte', param: 'maxSliceErrorUpperBps' } }),
        ...CHECKS.map(id => gate(id, 'evidence', {
          metric: { provider: evidenceProvider.id, name: 'attestations' }, evidence: { required: [id] },
        })),
        gate('integrity-ceiling', 'upstream-ceiling', { direction: HIGHER, floor: true }),
      ],
      combine: { rule: 'max-severity' },
    },
  };
}

/** Pure adapter; historical D23 trust pins remain validated by the comparative report owner. */
export function comparativeReplayGateInput(input: ComparativeReplayInput,
  rows: ComparativeReplayReport['roots'], usage: Pick<ComparativeReplayReport['metrics'],
    'backendCalls' | 'tokens' | 'costMicros' | 'exactReproduction'>,
  reportFindings: ReadonlySet<string>): EvaluateGatesInput {
  const plan = input.preregistration;
  if (plan.pairedMethod !== COMPARATIVE_REPLAY_POLICY.pairedMethod
    || plan.errorMethod !== COMPARATIVE_REPLAY_POLICY.errorMethod) {
    throw new Error('D23 comparative replay requires pairedMethod newcombe-10 and errorMethod wilson');
  }
  const providers = createCoreProviderRegistry();
  const registry = new GateRegistry(providers);
  registry.registerPack(replayPack(), { namespace: 'project' });
  const pack = registry.resolvePack(PACK_ID);
  const metricProviders = [proportionProvider, pairedProvider, evidenceProvider];
  const binding: GateBinding = {
    apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GateBinding',
    metadata: { id: plan.id, version: '1.0.0', description: 'D23 frozen synthetic policy replay.' },
    spec: {
      packs: [{ id: PACK_ID, version: '1.0.0', digest: pack.digest, resolvedDigest: pack.resolvedDigest }],
      parameters: Object.fromEntries(['minimumTestRoots', 'minimumSliceRoots', 'levelBps',
        'nonInferiorityMarginBps', 'maxErrorUpperBps', 'maxSliceErrorUpperBps'].map(name =>
        [qualifyGateParameter(PACK_ID, name), plan[name as keyof typeof COMPARATIVE_REPLAY_POLICY] as number])),
      slices: [...SLICES], references: [],
      metricProviders: metricProviders.map(({ id, version, sourceDigest }) => ({ id, version, sourceDigest })),
      registeredAt: plan.frozenAt, frozenAt: plan.frozenAt,
      corpusDigest: plan.corpusDigest, goldDigest: plan.goldDigest, splitDigest: plan.splitDigest,
    },
  };
  const testRows = rows.filter(row => row.split === 'test');
  const checks = {
    'reports-valid': reportFindings.size === 0,
    'zero-call-budget-violated': usage.backendCalls <= plan.maxBackendCalls
      && usage.tokens <= plan.maxTokens && usage.costMicros <= plan.maxCostMicros,
    'reproduction-mismatch': usage.exactReproduction,
    'integrity-sample-mismatch': input.integrity.sample_n === testRows.length,
    'reviewer-audit-pending': false,
  };
  const trustedBindingDigest = artifactDigest(binding);
  return {
    binding, registry, trustedBindingDigest,
    holdout: sealGateHoldout({ frozenDigest: trustedBindingDigest, firstAccessedAt: input.accessedAt }),
    upstream: sealUpstream(input.integrity), now: input.accessedAt,
    // Legacy retained D23 policy: no ambient project configuration may change historical replay.
    floors: 'none-explicit-opt-out',
    metrics: { providers: {
      [proportionProvider.id]: proportionProvider.compute(testRows.flatMap(row => [
        { slice: row.slice, metric: 'false-ready', event: !row.correct },
        { slice: row.slice, metric: 'coverage', event: row.falseNoChange },
      ])),
      [pairedProvider.id]: pairedProvider.compute(testRows.map(row =>
        ({ slice: row.slice, candidate: row.correct, baseline: true }))),
      [evidenceProvider.id]: evidenceProvider.compute(CHECKS.map(id => ({ id, passed: checks[id] }))),
    } },
  };
}

export function evaluateComparativeReplayGates(...args: Parameters<typeof comparativeReplayGateInput>) {
  const context = comparativeReplayGateInput(...args);
  return { binding: context.binding, gateReport: evaluateGates(context) };
}

/** Translate gate evidence to the retained D23 finding vocabulary without re-evaluating thresholds. */
export function comparativeReplayGateFindings(report: GateReport): { findings: string[]; diagnosticDecision: 'pass' | 'fail' } {
  const failed = report.gateEvidence.filter(gate => gate.status !== 'pass');
  const findings = new Set(failed.filter(gate => gate.gateId !== 'reports-valid' && gate.gateId !== 'integrity-ceiling')
    .map(gate => gate.gateId.startsWith('slice-') ? `slice-failed:${gate.slice}` : gate.gateId));
  for (const reason of report.upstream?.reasons ?? []) findings.add(reason.replace(/^upstream:/, ''));
  return { findings: [...findings], diagnosticDecision: failed.some(gate => !NON_DIAGNOSTIC.has(gate.gateId)) ? 'fail' : 'pass' };
}
