import Ajv2020 from 'ajv/dist/2020.js';
import { artifactDigest, validateBinding, validateDefinition, validateRuleset } from '../validate.js';
import type { DecisionBinding, DecisionDefinition, DecisionRuleset, ExecutionTarget, JsonSchema, JsonValue, PrimitiveAcceptancePolicy } from '../types.js';
import { PATTERN_SPECS, type AcceptanceProfile, type PatternEvaluationSpec } from './specs.js';
import type { DecisionPatternId, PatternArtifactKind, ResolvedPatternArtifact } from './types.js';

const PREFIX = 'aiwg://decision-patterns/';
const KINDS = new Set<PatternArtifactKind>(['definition', 'input-schema', 'output-schema', 'candidate-policy', 'ruleset', 'offline-binding', 'live-binding-template', 'expected-receipt', 'readme']);
const PATTERNS = new Set<DecisionPatternId>(Object.keys(PATTERN_SPECS) as DecisionPatternId[]);

/** Logical credential for the recorded offline transport. It resolves to a fixed, non-secret marker. */
export const OFFLINE_RECORDED_CREDENTIAL_REF = 'offline.recorded-fixture';
export const OFFLINE_RECORDED_MODEL = 'offline:recorded-fixture';
export const LIVE_TEMPLATE_MODEL = 'jev:explicit-opt-in-required';

const objectSchema = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties, required, additionalProperties: false });
const nested = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const probability = { type: 'number', minimum: 0, maximum: 1 };
const probabilities = { type: 'object', minProperties: 1, additionalProperties: probability };
const pointer = { type: 'string', pattern: '^(/.*)?$' };

/** Sanitized recorded Jev answers, keyed by ruleset alias. */
function recordedAnswerSchema(evaluation: PatternEvaluationSpec): JsonSchema {
  switch (evaluation.answer.kind) {
    case 'choice': return nested({ type: { const: 'choice' }, choice: { type: 'string' }, probabilities, confidence: probability }, ['type', 'choice', 'probabilities', 'confidence']);
    case 'ordinal-score': return nested({ type: { const: 'score' }, score: { type: 'number', minimum: 0 }, probabilities, legend: { type: 'object' }, confidence: probability }, ['type', 'score', 'probabilities', 'legend', 'confidence']);
    case 'truth-probability': return nested({ type: { const: 'noul' }, noul: probability }, ['type', 'noul']);
  }
}

function outputSchemaFor(id: DecisionPatternId): JsonSchema {
  const spec = PATTERN_SPECS[id];
  return objectSchema({
    answers: nested(Object.fromEntries(spec.evaluations.map(evaluation => [evaluation.alias, recordedAnswerSchema(evaluation)])), spec.evaluations.map(evaluation => evaluation.alias)),
    usage: nested({ input_tokens: { type: 'integer', minimum: 0 }, output_tokens: { type: 'integer', minimum: 0 } }, ['input_tokens', 'output_tokens']),
  }, ['answers']);
}

const decisionSource = { type: 'object', properties: { source: { const: 'decision' }, alias: { type: 'string', minLength: 1 } }, required: ['source', 'alias'], additionalProperties: false };
const inputSource = { type: 'object', properties: { source: { const: 'input' }, pointer }, required: ['source', 'pointer'], additionalProperties: false };

export const PATTERN_CANDIDATE_POLICY_SCHEMA: JsonSchema = objectSchema({
  schema: { const: 'decision-pattern-candidate-policy/v2' }, patternId: { type: 'string', enum: [...PATTERNS] }, patternVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
  authority: { const: 'deterministic-code' }, authorizedCandidatesFrom: { type: 'string', minLength: 1 }, evidenceMayExpandCandidates: { const: false }, actionsExecute: { const: false },
  deterministicDenyOverrides: { const: true }, unauthorizedEvidenceRoute: { enum: ['review', 'deny'] },
  deterministicPolicyFrom: pointer,
  candidateGate: nested({
    candidateFrom: { oneOf: [decisionSource, inputSource] }, allowedFrom: pointer,
    matchKeys: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, requireAllowed: { type: 'object' },
    labelKey: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 },
  }, ['candidateFrom', 'allowedFrom', 'reason']),
  argumentGate: nested({ functionAlias: { type: 'string', minLength: 1 }, argumentsFrom: pointer, schemasFrom: pointer, reason: { type: 'string', minLength: 1 } }, ['functionAlias', 'argumentsFrom', 'schemasFrom', 'reason']),
  batchSubjectsFrom: pointer,
  replay: nested({ resumeCountFrom: pointer }, ['resumeCountFrom']),
}, ['schema', 'patternId', 'patternVersion', 'authority', 'authorizedCandidatesFrom', 'evidenceMayExpandCandidates', 'actionsExecute', 'deterministicDenyOverrides', 'unauthorizedEvidenceRoute']);

export function decisionPatternArtifactUri(id: DecisionPatternId, version: string, kind: PatternArtifactKind, alias?: string): string {
  return `${PREFIX}${id}/${version}/${kind}${alias ? `.${alias}` : ''}`;
}

/** Resolve an artifact entirely from the installed module, without checkout-relative paths or I/O. */
export function resolveDecisionPatternArtifact(reference: string): ResolvedPatternArtifact {
  if (!reference.startsWith(PREFIX)) throw new Error('Unsupported decision pattern artifact reference');
  const parts = reference.slice(PREFIX.length).split('/');
  if (parts.length !== 3) throw new Error('Malformed decision pattern artifact reference');
  const [patternId, patternVersion, rawKindWithAlias] = parts;
  const [rawKind, alias, ...extra] = (rawKindWithAlias ?? '').split('.');
  if (!PATTERNS.has(patternId as DecisionPatternId) || !/^\d+\.\d+\.\d+$/.test(patternVersion ?? '') || !KINDS.has(rawKind as PatternArtifactKind) || extra.length) throw new Error('Malformed decision pattern artifact reference');
  const id = patternId as DecisionPatternId;
  const kind = rawKind as PatternArtifactKind;
  if ((kind === 'definition') !== (alias !== undefined) || (alias !== undefined && !PATTERN_SPECS[id].evaluations.some(evaluation => evaluation.alias === alias))) {
    throw new Error('Malformed decision pattern artifact reference');
  }
  return {
    schema: 'decision-pattern-artifact/v1', patternId: id, patternVersion: patternVersion!, kind, ...(alias ? { alias } : {}),
    mediaType: kind === 'readme' ? 'text/markdown' : 'application/json', content: artifactContent(id, patternVersion!, kind, alias),
  };
}

type GovernedArtifacts = { definitions: Record<string, DecisionDefinition>; ruleset: DecisionRuleset; offlineBinding: DecisionBinding; liveBindingTemplate: DecisionBinding };
const governedCache = new Map<string, GovernedArtifacts>();

/** Governed runtime artifacts for one pack, as consumed by `evaluateDecisionRuleset`. Callers receive a private copy. */
export function governedPatternArtifacts(id: DecisionPatternId, version: string): GovernedArtifacts {
  const key = `${id}@${version}`;
  if (!governedCache.has(key)) governedCache.set(key, buildGovernedArtifacts(id, version));
  return structuredClone(governedCache.get(key)!);
}

function buildGovernedArtifacts(id: DecisionPatternId, version: string): GovernedArtifacts {
  const definitions = Object.fromEntries(PATTERN_SPECS[id].evaluations.map(evaluation => {
    const definition = definitionFor(id, version, evaluation);
    return [definition.metadata.id, definition];
  }));
  const ruleset = rulesetFor(id, version, definitions);
  return { definitions, ruleset, offlineBinding: bindingFor(id, version, ruleset, false), liveBindingTemplate: bindingFor(id, version, ruleset, true) };
}

let validatePolicy: ReturnType<Ajv2020['compile']> | undefined;

/** Validate pins, schemas and cross-artifact references using the production decision validators. */
export function validateGovernedPatternArtifacts(id: DecisionPatternId, version: string): void {
  const { definitions, ruleset, offlineBinding, liveBindingTemplate } = governedPatternArtifacts(id, version);
  Object.values(definitions).forEach(validateDefinition);
  validateRuleset(ruleset);
  validateBinding(offlineBinding, ruleset);
  validateBinding(liveBindingTemplate, ruleset);
  validatePolicy ??= new Ajv2020({ strict: true, allErrors: true }).compile(PATTERN_CANDIDATE_POLICY_SCHEMA);
  if (!validatePolicy(candidatePolicyFor(id, version))) throw new Error('candidate policy is invalid');
}

export function patternInputSchema(id: DecisionPatternId): JsonSchema { return structuredClone(PATTERN_SPECS[id].inputSchema); }
export function patternOutputSchema(id: DecisionPatternId): JsonSchema { return outputSchemaFor(id); }

function artifactContent(id: DecisionPatternId, version: string, kind: PatternArtifactKind, alias?: string): JsonValue | string {
  const artifacts = governedPatternArtifacts(id, version);
  switch (kind) {
    case 'definition': return Object.values(artifacts.definitions).find(definition => definition.metadata.id === definitionId(id, alias!)) as unknown as JsonValue;
    case 'input-schema': return patternInputSchema(id) as JsonValue;
    case 'output-schema': return outputSchemaFor(id) as JsonValue;
    case 'candidate-policy': return candidatePolicyFor(id, version);
    case 'ruleset': return artifacts.ruleset as unknown as JsonValue;
    case 'offline-binding': return artifacts.offlineBinding as unknown as JsonValue;
    case 'live-binding-template': return artifacts.liveBindingTemplate as unknown as JsonValue;
    case 'expected-receipt': return { schema: 'decision-pattern-receipt/v2', pattern: { id, version }, executionMode: 'offline-recorded', evidenceOrigin: 'sanitized-recorded-fixture', runtime: { evaluator: 'evaluateDecisionRuleset', adapter: 'jev@1.0.0', transport: 'recorded-replay' }, action: { status: 'unexecuted' } };
    case 'readme': return `# ${id}\n\nOffline fixtures replay sanitized recorded Jev answers through the production decision evaluator. Recorded evidence is illustrative, not qualification, universal calibration, permission, or proof of deterministic model behavior. Failures abstain or route to review. Disable ${id}@${version} from discovery and retain receipts.\n`;
  }
}

const definitionId = (id: DecisionPatternId, alias: string) => `pattern.${id}.${alias}`;

function definitionFor(id: DecisionPatternId, version: string, evaluation: PatternEvaluationSpec): DecisionDefinition {
  return { apiVersion: 'decision.aiwg.io/v1alpha2', kind: 'DecisionDefinition', metadata: { id: definitionId(id, evaluation.alias), version, description: `Governed ${id} ${evaluation.alias} evidence definition` },
    spec: { purpose: `Collect bounded advisory evidence for ${id}`, inputSchema: evaluation.inputSchema ?? PATTERN_SPECS[id].inputSchema, question: evaluation.question, answer: evaluation.answer, requiredCapabilities: [] } };
}

function rulesetFor(id: DecisionPatternId, version: string, definitions: Record<string, DecisionDefinition>): DecisionRuleset {
  const spec = PATTERN_SPECS[id];
  const outputSchema = objectSchema({ route: { enum: ['accept', 'review', 'deny'] }, reason: { type: 'string', minLength: 1 }, action: { const: 'unexecuted' } }, ['route', 'reason', 'action']);
  const outcome = (value: { route: string; reason: string }) => ({ route: value.route, reason: value.reason, action: 'unexecuted' });
  return { apiVersion: 'decision.aiwg.io/v1alpha2', kind: 'DecisionRuleset', metadata: { id: `pattern.${id}.ruleset`, version, description: `Deterministic policy boundary for ${id}` },
    spec: { purpose: `Keep ${id} evidence subordinate to deterministic authority`, inputSchema: spec.inputSchema,
      evaluations: spec.evaluations.map(evaluation => {
        const definition = definitions[definitionId(id, evaluation.alias)]!;
        return { alias: evaluation.alias, decision: { id: definition.metadata.id, version, digest: artifactDigest(definition) }, inputPointer: evaluation.inputPointer };
      }),
      rules: spec.rules.map(rule => ({ id: rule.id, priority: rule.priority, when: rule.when, outcome: outcome(rule) })),
      composition: 'first-match', conflict: 'review', defaultOutcome: outcome(spec.defaultOutcome), failureOutcome: outcome(spec.failureOutcome), outputSchema } };
}

/** Primitive-aware acceptance. A truth probability of 0.5 always falls to review, never to an accept band or severity label. */
function acceptanceFor(profile: AcceptanceProfile): PrimitiveAcceptancePolicy {
  const review = { disposition: 'review' as const };
  const base = { mode: 'primitive-policy' as const, version: '1.0.0', precedence: 'first-match' as const, calibration: 'advisory' as const,
    defaultRoute: review, missingEvidenceRoute: review, invalidEvidenceRoute: review, tieRoute: review };
  if (profile === 'truth') {
    return { ...base, compatibleUncertaintyProfiles: ['typesafe-truth-v1'], rules: [
      { id: 'confident-true', primitive: 'truth-probability', all: [{ metric: 'yes-probability', op: 'gte', thresholdBps: 8000 }], route: { disposition: 'act' } },
      { id: 'confident-false', primitive: 'truth-probability', all: [{ metric: 'yes-probability', op: 'lte', thresholdBps: 2000 }], route: { disposition: 'act' } },
    ] };
  }
  if (profile === 'ordinal') {
    return { ...base, compatibleUncertaintyProfiles: ['typesafe-distribution-v1'], rules: [
      { id: 'concentrated', primitive: 'ordinal-score', all: [{ metric: 'dispersion', op: 'lte', thresholdBps: 2000 }], route: { disposition: 'act' } },
    ] };
  }
  return { ...base, compatibleUncertaintyProfiles: ['typesafe-distribution-v1'], rules: [
    { id: 'selected-confident', primitive: 'choice', all: [{ metric: 'selected-probability', op: 'gte', thresholdBps: 8000 }], route: { disposition: 'act' } },
  ] };
}

function bindingFor(id: DecisionPatternId, version: string, ruleset: DecisionRuleset, live: boolean): DecisionBinding {
  const spec = PATTERN_SPECS[id];
  const target = (evaluation: PatternEvaluationSpec): ExecutionTarget => ({
    adapter: 'jev', adapterVersion: '1.0.0', model: live ? LIVE_TEMPLATE_MODEL : OFFLINE_RECORDED_MODEL,
    credentialRef: live ? 'typesafe.jev.playground' : OFFLINE_RECORDED_CREDENTIAL_REF,
    requiredCapabilities: [], acceptance: acceptanceFor(evaluation.acceptance), timeoutMs: live ? 15_000 : 5_000,
    retry: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 },
  });
  return { apiVersion: 'decision.aiwg.io/v1alpha2', kind: 'DecisionBinding', metadata: { id: `pattern.${id}.${live ? 'live' : 'offline'}`, version, description: `${live ? 'Disabled opt-in live' : 'Recorded offline'} binding for ${id}` },
    spec: { ruleset: { id: ruleset.metadata.id, version, digest: artifactDigest(ruleset) }, totalTimeoutMs: live ? 15_000 : 10_000, maxAttempts: spec.evaluations.length, concurrency: 1,
      evaluations: Object.fromEntries(spec.evaluations.map(evaluation => [evaluation.alias, { targets: [target(evaluation)], fallbackOn: [] }])) } };
}

export function candidatePolicyFor(id: DecisionPatternId, version: string): JsonValue {
  const spec = PATTERN_SPECS[id];
  const gate = spec.gates.candidateGate;
  return { schema: 'decision-pattern-candidate-policy/v2', patternId: id, patternVersion: version, authority: 'deterministic-code',
    authorizedCandidatesFrom: gate?.allowedFrom ?? 'deterministic-policy', evidenceMayExpandCandidates: false, actionsExecute: false,
    deterministicDenyOverrides: true, unauthorizedEvidenceRoute: spec.unauthorizedEvidenceRoute,
    ...structuredClone(spec.gates) as Record<string, JsonValue> };
}
