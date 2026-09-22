import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CalibrationRegistry,
  calibrationArtifactDigest,
  artifactPin,
  evaluateDecisionRuleset,
  mapDecisionResult,
  validateDecisionDocument,
  type AdapterObservation,
  type CalibrationArtifact,
  type CalibrationIdentity,
  type DecisionAdapter,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionRuleset,
} from '../../../src/decision/index.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const fixture = <T>(name: string): T => JSON.parse(readFileSync(`examples/decision/${name}`, 'utf8')) as T;
const policy = { unknown: 'defer', incompatible: 'fail', shadowRequired: 'shadow', unusableCalibration: 'require-approval' } as const;

function setup(expiresAfterDays = 30) {
  const decision = fixture<DecisionDefinition>('decision-category.json');
  decision.apiVersion = 'decision.aiwg.io/v1alpha2';
  const rawRuleset = fixture<DecisionRuleset>('ruleset.json');
  const ruleset: DecisionRuleset = { ...rawRuleset, apiVersion: 'decision.aiwg.io/v1alpha2', spec: {
    ...rawRuleset.spec,
    evaluations: [{ ...rawRuleset.spec.evaluations[0]!, decision: artifactPin(decision) }],
    rules: rawRuleset.spec.rules.filter(rule => rule.id === 'docs'),
  } };
  const rawBinding = fixture<DecisionBinding>('binding-jev.json');
  const target = structuredClone(rawBinding.spec.evaluations.category!.targets[0]!);
  target.acceptance = {
    mode: 'primitive-policy', version: '1.0.0', compatibleUncertaintyProfiles: ['fixture'],
    precedence: 'first-match', calibration: 'required', rules: [],
    defaultRoute: { disposition: 'act' }, missingEvidenceRoute: { disposition: 'review' },
    invalidEvidenceRoute: { disposition: 'reject' }, tieRoute: { disposition: 'review' },
  };
  const binding: DecisionBinding = { ...rawBinding, apiVersion: 'decision.aiwg.io/v1alpha2', spec: {
    ...rawBinding.spec, ruleset: artifactPin(ruleset), evaluations: { category: { targets: [target], fallbackOn: [] } },
  } };
  const identity = (actualModel: string): CalibrationIdentity => ({
    provider: 'jev', backend: 'api', actualModel, primitive: 'choice', definitionDigest: artifactPin(decision).digest,
    adapterVersion: target.adapterVersion, dataset: { id: 'workflow', hash: hash('b') },
    slice: { id: 'high-risk', hash: hash('c') },
    calibrator: { id: 'isotonic', version: '1', parametersDigest: hash('d') },
  });
  const payload: Omit<CalibrationArtifact, 'digest'> = {
    schemaVersion: 'decision-calibration-artifact/v1', id: 'cal-runtime', identity: identity('jev-2026-09-01'),
    splitProvenance: { id: 'split', hash: hash('e'), holdoutAccessedAt: '2026-09-02T00:00:00.000Z' },
    profile: { minimumTotalSamples: 100, minimumPerSliceSamples: 40, powerRule: null,
      confidenceInterval: { method: 'bootstrap-bca', level: 0.95 }, maximumCalibrationError: 0.08,
      maximumSelectiveRisk: 0.05, expiresAfterDays },
    metrics: { totalSamples: 200, perSliceSamples: 80, calibrationError: 0.04, selectiveRisk: 0.02,
      confidenceIntervals: { ece: { lower: 0.02, upper: 0.06 } } },
    effectiveAt: '2026-09-01T00:00:00.000Z',
    limitations: ['Deterministic fixture only; not product-quality calibration evidence.'],
    approval: { state: 'approved', reference: 'review-17' },
  };
  const artifact: CalibrationArtifact = { ...payload, digest: calibrationArtifactDigest(payload) };
  const registry = new CalibrationRegistry();
  registry.registerArtifact(artifact);
  registry.observeAlias('jev-latest', artifact.identity, '2026-09-01T00:00:00.000Z');
  return { decision, ruleset, binding, target, artifact, registry, identity };
}

function observation(actualModel: string, calibrationRef: string): AdapterObservation {
  return {
    status: 'success', reason: 'none', value: 'documentation', actualModel, requestId: null,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
    uncertainty: { source: 'provider', profile: 'fixture', calibration: 'measured', confidence: 0.9,
      distribution: { documentation: 0.8, runtime: 0.1, other: 0.1 }, calibrationRef,
      calibratedRisk: { value: 0.03, calibrationRef } },
  };
}

async function run(config: ReturnType<typeof setup>, actualModel: string, at: string, invocationId: string) {
  const adapter: DecisionAdapter = { id: 'jev', version: config.target.adapterVersion,
    capabilities: async () => ({ answerKinds: ['choice'], features: ['choice', 'structured-entries'], maxOptions: 255,
      maxLevels: 10, confidenceProfiles: [], executable: true }),
    evaluate: vi.fn(async () => observation(actualModel, config.artifact.id)) };
  return evaluateDecisionRuleset({ ruleset: config.ruleset, binding: config.binding,
    definitions: { category: config.decision }, input: fixture('input.json'), runId: 'run-calibration', invocationId,
    adapters: { jev: adapter }, now: () => Date.parse(at),
    calibrationCompatibility: { registry: config.registry, policy, calibrationArtifactId: config.artifact.id,
      identityFor: ({ actualModel: served }) => config.identity(served) } });
}

describe('runtime calibration compatibility', () => {
  it('admits exact pinned evidence and exposes the decision to telemetry', async () => {
    const config = setup();
    const result = await run(config, 'jev-2026-09-01', '2026-09-10T00:00:00.000Z', 'exact');
    const evaluation = result.spec.evaluations.category!;
    expect(evaluation.spec.calibrationCompatibility).toMatchObject({ state: 'exact', action: 'allow', artifactId: config.artifact.id });
    expect(evaluation.spec.acceptance).toMatchObject({ disposition: 'act', values: { 'calibrated-risk': { value: 0.03 } } });
    expect(mapDecisionResult(evaluation).attributes).toMatchObject({
      'aiwg.calibration.compatibility_state': 'exact', 'aiwg.calibration.compatibility_action': 'allow',
      'aiwg.calibration.artifact_id': config.artifact.id,
    });
    expect(() => validateDecisionDocument(result)).not.toThrow();
  });

  it('detects alias drift and removes calibrated evidence from an unknown model', async () => {
    const config = setup();
    const result = await run(config, 'jev-2026-10-01', '2026-09-10T00:00:00.000Z', 'drift');
    const evaluation = result.spec.evaluations.category!;
    expect(evaluation.spec.calibrationCompatibility).toMatchObject({ state: 'unknown', action: 'defer', reasons: ['alias-drift'] });
    expect(evaluation.spec.uncertainty).toMatchObject({ confidence: 0.9, distribution: { documentation: 0.8 } });
    expect(evaluation.spec.uncertainty?.calibratedRisk).toBeUndefined();
    expect(evaluation.spec.acceptance).toMatchObject({ disposition: 'review', reason: 'calibration-required' });
    expect(config.registry.driftEvents('jev-latest')).toHaveLength(1);
  });

  it('makes expired exact calibration non-actionable without erasing raw uncertainty', async () => {
    const config = setup(5);
    const result = await run(config, 'jev-2026-09-01', '2026-09-10T00:00:00.000Z', 'expired');
    const evaluation = result.spec.evaluations.category!;
    expect(evaluation.spec.calibrationCompatibility).toMatchObject({ state: 'exact', action: 'require-approval', reasons: ['calibration-expired'] });
    expect(evaluation.spec.uncertainty?.distribution).toEqual({ documentation: 0.8, runtime: 0.1, other: 0.1 });
    expect(evaluation.spec.uncertainty?.calibratedRisk).toBeUndefined();
    expect(evaluation.spec.acceptance?.disposition).toBe('review');
  });

  it('does not trust an unpinned calibrated-risk reference even for exact identity', async () => {
    const config = setup();
    const adapter = config.binding.spec.evaluations.category!.targets[0]!;
    const identityFor = ({ actualModel }: { actualModel: string }) => config.identity(actualModel);
    const provider: DecisionAdapter = { id: 'jev', version: adapter.adapterVersion,
      capabilities: async () => ({ answerKinds: ['choice'], features: ['choice', 'structured-entries'], maxOptions: 255, maxLevels: 10, confidenceProfiles: [], executable: true }),
      evaluate: vi.fn(async () => observation('jev-2026-09-01', 'calibration-not-registered')) };
    const result = await evaluateDecisionRuleset({ ruleset: config.ruleset, binding: config.binding,
      definitions: { category: config.decision }, input: fixture('input.json'), runId: 'run-calibration', invocationId: 'bad-reference',
      adapters: { jev: provider }, now: () => Date.parse('2026-09-10T00:00:00.000Z'),
      calibrationCompatibility: { registry: config.registry, policy, calibrationArtifactId: config.artifact.id, identityFor } });
    expect(result.spec.evaluations.category?.spec.calibrationCompatibility?.state).toBe('exact');
    expect(result.spec.evaluations.category?.spec.uncertainty?.calibratedRisk).toBeUndefined();
    expect(result.spec.evaluations.category?.spec.acceptance?.reason).toBe('calibration-required');
  });
});
