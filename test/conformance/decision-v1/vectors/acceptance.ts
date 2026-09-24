import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DECISION_API_VERSION_STRUCTURED, applyPrimitiveAcceptance, artifactPin, evaluateDecisionRuleset,
  validatePrimitiveAcceptancePolicy, type AdapterObservation, type DecisionDefinition, type DecisionAdapter,
  type DecisionBinding, type DecisionRuleset, type PrimitiveAcceptancePolicy, type QualificationCaseExecutor,
} from '../../../../src/decision/index.js';

export const SOURCE_ROOT = process.cwd();
export const GOLDEN_ROOT = 'test/fixtures/decision/acceptance';
export const GOLDENS = {
  noul: `${GOLDEN_ROOT}/noul-near-indeterminate.json`,
  choice: `${GOLDEN_ROOT}/choice-raw-derived.json`,
  score: `${GOLDEN_ROOT}/score-equal-mean-dispersions.json`,
} as const;
export const CASE_IDS = ['C08', 'C09', 'C10', 'TV03', 'TV04', 'TV05', 'TV11'] as const;

type Golden = {
  raw: RawObservation | RawObservation[];
  acceptance: unknown | unknown[];
};
type RawObservation = Pick<AdapterObservation, 'value' | 'uncertainty'>;

const route = (disposition: 'act' | 'review' | 'reject' | 'fallback', fallbackTarget?: string) =>
  fallbackTarget ? { disposition, fallbackTarget } as const : { disposition } as const;

function policy(profile: string, overrides: Partial<PrimitiveAcceptancePolicy> = {}): PrimitiveAcceptancePolicy {
  return {
    mode: 'primitive-policy', version: '1.0.0', compatibleUncertaintyProfiles: [profile],
    precedence: 'first-match', calibration: 'advisory', rules: [], defaultRoute: route('review'),
    missingEvidenceRoute: route('review'), invalidEvidenceRoute: route('reject'), tieRoute: route('review'),
    ...overrides,
  };
}

function definition(kind: DecisionDefinition['spec']['answer']['kind'], includeNone = true): DecisionDefinition {
  const answer = kind === 'choice'
    ? { kind, options: [
      { id: 'yes', description: 'yes' }, { id: 'no', description: 'no' },
      ...(includeNone ? [{ id: 'none', description: 'none' }] : []),
    ] }
    : kind === 'ordinal-score'
      ? { kind, levels: ['zero', 'one', 'two', 'three'] }
      : { kind, trueDescription: 'yes', falseDescription: 'no' };
  return {
    apiVersion: DECISION_API_VERSION_STRUCTURED, kind: 'DecisionDefinition',
    metadata: { id: `qualification-${kind}`, version: '1.0.0', description: 'qualification fixture' },
    spec: { purpose: 'qualification fixture', inputSchema: { type: 'object' }, question: 'question', answer, requiredCapabilities: [] },
  } as DecisionDefinition;
}

function observation(raw: RawObservation): AdapterObservation {
  return {
    status: 'success', reason: 'none', value: raw.value, actualModel: 'qualification-fixture', requestId: null,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, uncertainty: structuredClone(raw.uncertainty),
  };
}

async function golden(path: string): Promise<Golden> {
  return JSON.parse(await readFile(path, 'utf8')) as Golden;
}

async function legacyThresholdReason(
  reason: 'low-confidence' | 'missing-confidence' | 'confidence-profile-mismatch',
): Promise<string | undefined> {
  const rulesetRaw = JSON.parse(await readFile('examples/decision/ruleset.json', 'utf8')) as DecisionRuleset;
  const definitionRaw = JSON.parse(await readFile('examples/decision/decision-category.json', 'utf8')) as DecisionDefinition;
  const definition = { ...definitionRaw, apiVersion: DECISION_API_VERSION_STRUCTURED } as DecisionDefinition;
  const ruleset = {
    ...rulesetRaw, apiVersion: DECISION_API_VERSION_STRUCTURED,
    spec: {
      ...rulesetRaw.spec,
      evaluations: [{ ...rulesetRaw.spec.evaluations[0]!, decision: artifactPin(definition) }],
      rules: rulesetRaw.spec.rules.filter(rule => rule.id === 'docs'),
    },
  } as DecisionRuleset;
  const bindingRaw = JSON.parse(await readFile('examples/decision/binding-jev.json', 'utf8')) as DecisionBinding;
  const target = structuredClone(bindingRaw.spec.evaluations.category!.targets[0]!);
  target.acceptance = {
    mode: 'confidence-threshold',
    profile: reason === 'confidence-profile-mismatch' ? 'incompatible-profile' : 'typesafe-distribution-v1',
    minimumBps: 8000,
  };
  const binding = {
    ...bindingRaw, apiVersion: DECISION_API_VERSION_STRUCTURED,
    spec: { ...bindingRaw.spec, ruleset: artifactPin(ruleset), evaluations: { category: { targets: [target], fallbackOn: [] } } },
  } as DecisionBinding;
  const confidence = reason === 'missing-confidence' ? null : 0.4;
  const adapter: DecisionAdapter = {
    id: target.adapter, version: target.adapterVersion,
    capabilities: async () => ({
      answerKinds: ['choice'], features: ['structured-entries'], maxOptions: 255, maxLevels: 10,
      confidenceProfiles: ['typesafe-distribution-v1'], executable: true,
    }),
    evaluate: async () => ({
      status: 'success', reason: 'none', value: 'documentation', actualModel: 'qualification-fixture', requestId: null,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
      uncertainty: { source: 'provider', profile: 'typesafe-distribution-v1', calibration: 'uncalibrated',
        confidence, distribution: { documentation: 0.7, runtime: 0.2, other: 0.1 }, calibrationRef: null },
    }),
  };
  const result = await evaluateDecisionRuleset({
    ruleset, binding, definitions: { category: definition },
    input: JSON.parse(await readFile('examples/decision/input.json', 'utf8')),
    runId: 'qualification', invocationId: `qualification-${reason}`, adapters: { [target.adapter]: adapter },
  });
  assert.equal(result.spec.evaluations.category?.spec.status, 'abstained');
  return result.spec.evaluations.category?.spec.reason;
}

export const executors: Record<(typeof CASE_IDS)[number], QualificationCaseExecutor> = {
  C08: async () => {
    assert.equal(await legacyThresholdReason('low-confidence'), 'low-confidence');
    return { outcome: 'pass', details: { status: 'abstained', reason: 'low-confidence' } };
  },
  C09: async () => {
    assert.equal(await legacyThresholdReason('missing-confidence'), 'missing-confidence');
    return { outcome: 'pass', details: { status: 'abstained', reason: 'missing-confidence' } };
  },
  C10: async () => {
    assert.equal(await legacyThresholdReason('confidence-profile-mismatch'), 'confidence-profile-mismatch');
    return { outcome: 'pass', details: { status: 'abstained', reason: 'confidence-profile-mismatch' } };
  },
  TV03: async () => {
    const fixture = await golden(GOLDENS.score);
    const raw = fixture.raw as RawObservation[];
    const scorePolicy = policy('typesafe-score-v1', {
      rules: [{ id: 'bounded-dispersion', primitive: 'ordinal-score', all: [
        { metric: 'expected-score', op: 'between', minimumBps: 5000, maximumBps: 5000 },
        { metric: 'dispersion', op: 'lte', thresholdBps: 1000 },
      ], route: route('act') }],
    });
    const results = raw.map(item => applyPrimitiveAcceptance(definition('ordinal-score'), scorePolicy, observation(item)));
    assert.deepEqual(results.map(item => item.acceptance), fixture.acceptance);
    assert.deepEqual(results.map(item => item.value), [1.5, 1.5]);
    assert.notEqual(results[0]!.acceptance?.values.dispersion?.value, results[1]!.acceptance?.values.dispersion?.value);
    return { outcome: 'pass', details: { routes: results.map(item => item.acceptance?.disposition), equalMean: true } };
  },
  TV04: async () => {
    const fixture = await golden(GOLDENS.noul);
    const raw = fixture.raw as RawObservation;
    const before = structuredClone(raw);
    const result = applyPrimitiveAcceptance(definition('truth-probability'), policy('typesafe-noul-v1', {
      rules: [{ id: 'near-indeterminate', primitive: 'truth-probability', all: [
        { metric: 'yes-probability', op: 'between', minimumBps: 4500, maximumBps: 5500 },
      ], route: route('review') }], defaultRoute: route('act'),
    }), observation(raw));
    assert.deepEqual(result.acceptance, fixture.acceptance);
    assert.deepEqual(raw, before);
    assert.equal(result.acceptance?.values['native-confidence'], undefined);
    return { outcome: 'pass', details: { route: result.acceptance?.disposition, probability: result.value } };
  },
  TV05: () => {
    assert.throws(() => validatePrimitiveAcceptancePolicy(
      policy('typesafe-choice-v1', { requiredOptions: ['none'] }), definition('choice', false),
    ), /missing an option/);
    assert.deepEqual((definition('choice', false).spec.answer as { options: { id: string }[] }).options.map(item => item.id), ['yes', 'no']);
    return { outcome: 'pass', details: { rejectedIncompleteSpace: true, inventedLabels: 0 } };
  },
  TV11: async () => {
    const noul = await golden(GOLDENS.noul);
    const choice = await golden(GOLDENS.choice);
    const n = applyPrimitiveAcceptance(definition('truth-probability'), policy('typesafe-noul-v1'), observation(noul.raw as RawObservation));
    const c = applyPrimitiveAcceptance(definition('choice'), policy('typesafe-choice-v1'), observation(choice.raw as RawObservation));
    const separatePositive = applyPrimitiveAcceptance(definition('truth-probability'), policy('positive-noul-v1'), observation({
      value: 0.55, uncertainty: { ...(noul.raw as RawObservation).uncertainty!, profile: 'positive-noul-v1' },
    }));
    const separateNegative = applyPrimitiveAcceptance(definition('truth-probability'), policy('negative-noul-v1'), observation({
      value: 0.49, uncertainty: { ...(noul.raw as RawObservation).uncertainty!, profile: 'negative-noul-v1' },
    }));
    assert.equal(n.acceptance?.values['yes-probability']?.provenance, 'provider-value');
    assert.equal(c.acceptance?.values['selected-probability']?.provenance, 'provider-distribution');
    assert.notEqual(n.acceptance?.uncertaintyProfile, c.acceptance?.uncertaintyProfile);
    assert.notEqual(Number(separatePositive.value) + Number(separateNegative.value), 1);
    return { outcome: 'pass', details: { primitives: ['noul', 'choice', 'separate-nouls'], complementaryInvariant: false } };
  },
};
