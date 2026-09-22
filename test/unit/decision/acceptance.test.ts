import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  DECISION_API_VERSION_STRUCTURED,
  DecisionValidationError,
  MemoryDecisionReceiptStore,
  applyPrimitiveAcceptance,
  artifactPin,
  evaluateDecisionRuleset,
  validateDecisionDocument,
  validatePrimitiveAcceptancePolicy,
  type AdapterObservation,
  type DecisionAdapter,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionRuleset,
  type PrimitiveAcceptancePolicy,
} from '../../../src/decision/index.js';

const route = (disposition: 'act' | 'review' | 'reject' | 'fallback', fallbackTarget?: string) =>
  fallbackTarget ? { disposition, fallbackTarget } as const : { disposition } as const;

function policy(overrides: Partial<PrimitiveAcceptancePolicy> = {}): PrimitiveAcceptancePolicy {
  return {
    mode: 'primitive-policy', version: '1.0.0', compatibleUncertaintyProfiles: ['fixture'],
    precedence: 'first-match', calibration: 'advisory',
    rules: [], defaultRoute: route('review'), missingEvidenceRoute: route('review'),
    invalidEvidenceRoute: route('reject'), tieRoute: route('review'), ...overrides,
  };
}

function definition(kind: DecisionDefinition['spec']['answer']['kind']): DecisionDefinition {
  const answer = kind === 'choice'
    ? { kind, options: [{ id: 'yes', description: 'yes' }, { id: 'no', description: 'no' }, { id: 'none', description: 'none' }] }
    : kind === 'ordinal-score' ? { kind, levels: ['low', 'medium', 'high'] }
      : { kind, trueDescription: 'true', falseDescription: 'false' };
  return {
    apiVersion: DECISION_API_VERSION_STRUCTURED, kind: 'DecisionDefinition',
    metadata: { id: `decision-${kind}`, version: '1.0.0', description: kind },
    spec: { purpose: 'fixture', inputSchema: { type: 'object' }, question: 'question', answer, requiredCapabilities: [] },
  } as DecisionDefinition;
}

function observation(value: string | number, distribution: Record<string, number> | null, confidence: number | null = null): AdapterObservation {
  return {
    status: 'success', reason: 'none', value, actualModel: 'fixture-1', requestId: null,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
    uncertainty: { source: 'provider', profile: 'fixture', calibration: 'uncalibrated', confidence, distribution, calibrationRef: null },
  };
}

describe('primitive-aware acceptance', () => {
  it.each([
    ['lt', 0.4999, true], ['lt', 0.5, false], ['lt', 0.5001, false],
    ['lte', 0.4999, true], ['lte', 0.5, true], ['lte', 0.5001, false],
    ['gt', 0.4999, false], ['gt', 0.5, false], ['gt', 0.5001, true],
    ['gte', 0.4999, false], ['gte', 0.5, true], ['gte', 0.5001, true],
    ['between', 0.3999, false], ['between', 0.4, true], ['between', 0.6, true], ['between', 0.6001, false],
    ['outside', 0.3999, true], ['outside', 0.4, false], ['outside', 0.6, false], ['outside', 0.6001, true],
  ] as const)('POL-ACCEPT-OP %s handles boundary value %s', (op, value, matches) => {
    const condition = op === 'between' || op === 'outside'
      ? { metric: 'yes-probability' as const, op, minimumBps: 4000, maximumBps: 6000 }
      : { metric: 'yes-probability' as const, op, thresholdBps: 5000 };
    const result = applyPrimitiveAcceptance(definition('truth-probability'), policy({
      rules: [{ id: 'operator', primitive: 'truth-probability', all: [condition], route: route('act') }],
      defaultRoute: route('reject'),
    }), observation(value, null));
    expect(result.acceptance?.disposition).toBe(matches ? 'act' : 'reject');
  });

  it('POL-ACCEPT-PROPERTY is monotonic for a greater-than-or-equal probability policy', () => {
    const monotonic = policy({ rules: [{ id: 'threshold', primitive: 'truth-probability',
      all: [{ metric: 'yes-probability', op: 'gte', thresholdBps: 5000 }], route: route('act') }],
      defaultRoute: route('review') });
    let acted = false;
    for (let bps = 0; bps <= 10_000; bps += 137) {
      const disposition = applyPrimitiveAcceptance(definition('truth-probability'), monotonic,
        observation(bps / 10_000, null)).acceptance?.disposition;
      if (disposition === 'act') acted = true;
      if (acted) expect(disposition).toBe('act');
    }
  });

  it.each([
    [0.4999, 'reject'], [0.5, 'review'], [0.5001, 'act'],
  ] as const)('POL-ACCEPT-NOUL routes exact basis-point boundaries: %s', (value, expected) => {
    const result = applyPrimitiveAcceptance(definition('truth-probability'), policy({
      rules: [
        { id: 'reject-low', primitive: 'truth-probability', all: [{ metric: 'yes-probability', op: 'lt', thresholdBps: 5000 }], route: route('reject') },
        { id: 'gray', primitive: 'truth-probability', all: [{ metric: 'yes-probability', op: 'between', minimumBps: 5000, maximumBps: 5000 }], route: route('review') },
        { id: 'act-high', primitive: 'truth-probability', all: [{ metric: 'yes-probability', op: 'gt', thresholdBps: 5000 }], route: route('act') },
      ],
    }), observation(value, null));
    expect(result.acceptance?.disposition).toBe(expected);
    expect(result.acceptance?.values['yes-probability']).toMatchObject({ value, provenance: 'provider-value' });
  });

  it('POL-ACCEPT-CHOICE keeps selected probability, native confidence, margin, entropy and concentration separate', () => {
    const result = applyPrimitiveAcceptance(definition('choice'), policy({ requiredOptions: ['none'],
      rules: [{ id: 'strong', primitive: 'choice', all: [
        { metric: 'selected-probability', op: 'gte', thresholdBps: 6000 },
        { metric: 'top-two-margin', op: 'gte', thresholdBps: 3000 },
      ], route: route('act') }],
    }), observation('yes', { yes: 0.7, no: 0.2, none: 0.1 }, 0.83));
    expect(result.acceptance?.disposition).toBe('act');
    expect(result.acceptance?.values).toMatchObject({
      'selected-probability': { value: 0.7, provenance: 'provider-distribution' },
      'native-confidence': { value: 0.83, provenance: 'provider-confidence' },
      'top-two-margin': { provenance: 'derived' },
      entropy: { provenance: 'derived' }, concentration: { provenance: 'derived' },
    });
    expect(result.acceptance?.values['top-two-margin']?.value).toBeCloseTo(0.5);
    expect(result.acceptance?.values.concentration?.value).toBeCloseTo(0.54);
  });

  it('POL-ACCEPT-CHOICE routes ties and missing distributions without inventing evidence', () => {
    const choice = definition('choice');
    const tie = applyPrimitiveAcceptance(choice, policy({ tieRoute: route('fallback', 'human-review') }),
      observation('yes', { yes: 0.5, no: 0.5, none: 0 }));
    expect(tie).toMatchObject({ status: 'abstained', reason: 'low-confidence', acceptance: { disposition: 'fallback', reason: 'tie' } });
    const missing = applyPrimitiveAcceptance(choice, policy({
      rules: [{ id: 'needs-probability', primitive: 'choice', all: [{ metric: 'selected-probability', op: 'gte', thresholdBps: 5000 }], route: route('act') }],
    }), observation('yes', null));
    expect(missing.acceptance).toMatchObject({ disposition: 'review', reason: 'missing-evidence', values: {} });
  });

  it('POL-ACCEPT-SCORE can route equal means differently by dispersion', () => {
    const scorePolicy = policy({ rules: [{ id: 'concentrated', primitive: 'ordinal-score', all: [
      { metric: 'expected-score', op: 'between', minimumBps: 5000, maximumBps: 5000 },
      { metric: 'dispersion', op: 'lte', thresholdBps: 1000 },
    ], route: route('act') }] });
    const concentrated = applyPrimitiveAcceptance(definition('ordinal-score'), scorePolicy,
      observation(1, { 0: 0, 1: 1, 2: 0 }, 0.9));
    const dispersed = applyPrimitiveAcceptance(definition('ordinal-score'), scorePolicy,
      observation(1, { 0: 0.5, 1: 0, 2: 0.5 }, 0.9));
    expect(concentrated.acceptance).toMatchObject({ disposition: 'act', values: { 'expected-score': { value: 1 }, dispersion: { value: 0 } } });
    expect(dispersed.acceptance).toMatchObject({ disposition: 'review', values: { 'expected-score': { value: 1 }, dispersion: { value: 1 } } });
  });

  it('POL-ACCEPT-CAL requires separately pinned calibrated risk when declared', () => {
    const required = policy({ calibration: 'required', missingEvidenceRoute: route('reject') });
    const absent = applyPrimitiveAcceptance(definition('truth-probability'), required, observation(0.9, null));
    expect(absent.acceptance).toMatchObject({ disposition: 'reject', reason: 'calibration-required' });
    const calibrated = observation(0.9, null);
    calibrated.uncertainty!.calibratedRisk = { value: 0.04, calibrationRef: 'calibration:fixture@sha256:abc' };
    const present = applyPrimitiveAcceptance(definition('truth-probability'), { ...required, defaultRoute: route('act') }, calibrated);
    expect(present.acceptance?.values['calibrated-risk']).toMatchObject({ value: 0.04, provenance: 'calibrated', calibrationRef: 'calibration:fixture@sha256:abc' });
    expect(present.acceptance?.disposition).toBe('act');
  });

  it('POL-ACCEPT-PROFILE fails closed for missing or incompatible declared uncertainty semantics', () => {
    const guarded = policy({
      compatibleUncertaintyProfiles: ['typesafe-truth-v1'],
      defaultRoute: route('act'),
      missingEvidenceRoute: route('review'),
      invalidEvidenceRoute: route('reject'),
    });
    const incompatible = applyPrimitiveAcceptance(definition('truth-probability'), guarded, observation(0.9, null));
    expect(incompatible.acceptance).toMatchObject({
      disposition: 'reject', reason: 'invalid-evidence', uncertaintyProfile: 'fixture', values: {},
    });
    const absent = observation(0.9, null);
    absent.uncertainty = null;
    expect(applyPrimitiveAcceptance(definition('truth-probability'), guarded, absent).acceptance).toMatchObject({
      disposition: 'review', reason: 'missing-evidence', uncertaintyProfile: null, values: {},
    });
  });

  it('POL-ACCEPT-QUANTIZATION records raw evidence while comparison uses the documented basis-point projection', () => {
    const justBelow = 0.4999999999999;
    const result = applyPrimitiveAcceptance(definition('truth-probability'), policy({
      rules: [{ id: 'boundary', primitive: 'truth-probability',
        all: [{ metric: 'yes-probability', op: 'gte', thresholdBps: 5000 }], route: route('act') }],
      defaultRoute: route('reject'),
    }), observation(justBelow, null));
    expect(result.acceptance).toMatchObject({ disposition: 'act', values: {
      'yes-probability': { value: justBelow, normalizedBps: 5000 },
    } });
    expect(result.uncertainty?.profile).toBe('fixture');
  });

  it('POL-ACCEPT-NO-SIDE-EFFECT returns routing evidence without mutating policy or observation', () => {
    const immutablePolicy = policy({ defaultRoute: route('fallback', 'operator') });
    const immutableObservation = observation(0.25, null);
    const policyBefore = structuredClone(immutablePolicy);
    const observationBefore = structuredClone(immutableObservation);
    const result = applyPrimitiveAcceptance(definition('truth-probability'), immutablePolicy, immutableObservation);
    expect(result.acceptance).toMatchObject({ disposition: 'fallback', fallbackTarget: 'operator' });
    expect(immutablePolicy).toEqual(policyBefore);
    expect(immutableObservation).toEqual(observationBefore);
  });

  it('POL-ACCEPT-VALIDATE rejects ambiguous structure, invalid boundaries, and incomplete Choice spaces', () => {
    expect(() => validatePrimitiveAcceptancePolicy(policy({ precedence: 'last-match' as 'first-match' }))).toThrow(/precedence/);
    expect(() => validatePrimitiveAcceptancePolicy(policy({ rules: [
      { id: 'bad', primitive: 'truth-probability', all: [{ metric: 'yes-probability', op: 'between', minimumBps: 7000, maximumBps: 6000 }], route: route('act') },
    ] }))).toThrow(/ordered/);
    expect(() => validatePrimitiveAcceptancePolicy(policy({ requiredOptions: ['unknown'] }), definition('choice'))).toThrow(/missing an option/);
    expect(() => validatePrimitiveAcceptancePolicy(policy({ defaultRoute: route('fallback') }))).toThrow(/fallbackTarget/);
    expect(() => validatePrimitiveAcceptancePolicy(policy({ compatibleUncertaintyProfiles: [] }))).toThrow(/uncertainty profiles/);
    expect(() => validatePrimitiveAcceptancePolicy(policy({ compatibleUncertaintyProfiles: ['fixture', 'fixture'] }))).toThrow(/uncertainty profiles/);
  });

  it('POL-ACCEPT-RECEIPT persists evidence while preserving the raw distribution', async () => {
    const raw = JSON.parse(readFileSync('examples/decision/ruleset.json', 'utf8')) as DecisionRuleset;
    const ruleset = { ...raw, apiVersion: DECISION_API_VERSION_STRUCTURED,
      spec: { ...raw.spec, evaluations: raw.spec.evaluations.filter(item => item.alias === 'category'), rules: raw.spec.rules.filter(rule => rule.id === 'docs') } };
    const decision = definition('choice'); decision.metadata.id = ruleset.spec.evaluations[0]!.decision.id;
    ruleset.spec.evaluations[0]!.decision = artifactPin(decision);
    const bindingRaw = JSON.parse(readFileSync('examples/decision/binding-jev.json', 'utf8')) as DecisionBinding;
    const target = bindingRaw.spec.evaluations.category!.targets[0]!;
    target.acceptance = policy({ defaultRoute: route('act') });
    const binding: DecisionBinding = { ...bindingRaw, apiVersion: DECISION_API_VERSION_STRUCTURED,
      spec: { ...bindingRaw.spec, ruleset: artifactPin(ruleset), evaluations: { category: { targets: [target], fallbackOn: [] } } } };
    const observed = observation('yes', { yes: 0.7, no: 0.2, none: 0.1 }, 0.8);
    const adapter: DecisionAdapter = { id: 'jev', version: target.adapterVersion,
      capabilities: async () => ({ answerKinds: ['choice'], features: ['structured-entries'], maxOptions: 255, maxLevels: 10, confidenceProfiles: [], executable: true }),
      evaluate: vi.fn(async () => observed) };
    const receiptStore = new MemoryDecisionReceiptStore();
    const request = { ruleset, binding, definitions: { category: decision },
      input: JSON.parse(readFileSync('examples/decision/input.json', 'utf8')),
      runId: 'run', invocationId: 'primitive-receipt', adapters: { jev: adapter }, receiptStore };
    const result = await evaluateDecisionRuleset(request);
    expect(result.spec.evaluations.category?.spec.acceptance).toMatchObject({ disposition: 'act', policyVersion: '1.0.0' });
    expect(result.spec.evaluations.category?.spec.uncertainty?.distribution).toEqual({ yes: 0.7, no: 0.2, none: 0.1 });
    expect(() => validateDecisionDocument(result)).not.toThrow();
    const replay = await evaluateDecisionRuleset(request);
    expect(replay).toEqual(result);
    expect(adapter.evaluate).toHaveBeenCalledTimes(1);
  });

  it('POL-ACCEPT-COMPAT does not admit primitive policy into v1alpha1', () => {
    const binding = JSON.parse(readFileSync('examples/decision/binding-jev.json', 'utf8')) as DecisionBinding;
    binding.spec.evaluations.category!.targets[0]!.acceptance = policy();
    expect(() => validateDecisionDocument(binding)).toThrow(DecisionValidationError);
  });
});
