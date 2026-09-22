import Ajv2020 from 'ajv/dist/2020.js';
import { artifactDigest, validateBinding, validateDefinition, validateRuleset } from '../validate.js';
import type { DecisionAnswer, DecisionBinding, DecisionDefinition, DecisionRuleset, JsonSchema, JsonValue } from '../types.js';
import type { DecisionPatternId, PatternArtifactKind, ResolvedPatternArtifact } from './types.js';

const PREFIX = 'aiwg://decision-patterns/';
const KINDS = new Set<PatternArtifactKind>(['definition', 'input-schema', 'output-schema', 'candidate-policy', 'ruleset', 'offline-binding', 'live-binding-template', 'expected-receipt', 'readme']);
const PATTERNS = new Set<DecisionPatternId>(['intent-routing', 'rag-screen', 'citation-support', 'guardrails', 'tool-risk-preflight', 'bounded-classification', 'ordinal-scoring', 'function-selection', 'same-subject-batch', 'dependent-two-stage', 'durable-review', 'candidate-selection']);

const objectSchema = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties, required, additionalProperties: false });
const stringArray = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } };
const looseObject = { type: 'object' };

const INPUT_SCHEMAS: Record<DecisionPatternId, JsonSchema> = {
  'intent-routing': objectSchema({ authorizedCandidates: stringArray }, ['authorizedCandidates']),
  'rag-screen': objectSchema({ sourceLocator: { type: 'string', minLength: 1 }, deterministicPolicy: { const: 'deny' } }, ['sourceLocator']),
  'citation-support': objectSchema({ sources: { type: 'array', minItems: 1, items: objectSchema({ locator: { type: 'string' }, digest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' }, provenanceVerified: { type: 'boolean' } }, ['locator', 'digest', 'provenanceVerified']) } }, ['sources']),
  guardrails: objectSchema({ deterministicPolicy: { const: 'deny' } }, ['deterministicPolicy']),
  'tool-risk-preflight': objectSchema({ deterministicPolicy: { const: 'deny' }, authorizedTools: { type: 'array', maxItems: 0 } }, ['deterministicPolicy', 'authorizedTools']),
  'bounded-classification': objectSchema({ allowedOptions: stringArray }, ['allowedOptions']),
  'ordinal-scoring': objectSchema({ legend: stringArray, weights: { type: 'object', additionalProperties: { type: 'number' } } }, ['legend', 'weights']),
  'function-selection': objectSchema({ legalFunctions: stringArray, argumentSchemas: { type: 'object', minProperties: 1, additionalProperties: { type: 'object' } } }, ['legalFunctions', 'argumentSchemas']),
  'same-subject-batch': objectSchema({ itemSubjects: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, questions: stringArray }, ['itemSubjects', 'questions']),
  'dependent-two-stage': objectSchema({ stageOne: looseObject }, ['stageOne']),
  'durable-review': objectSchema({ reviewRequired: { const: true }, invocationId: { type: 'string', minLength: 1 }, resumeCount: { type: 'integer', minimum: 1 } }, ['reviewRequired', 'invocationId', 'resumeCount']),
  'candidate-selection': objectSchema({ extractedCandidates: stringArray }, ['extractedCandidates']),
};

const OUTPUT_SCHEMAS: Record<DecisionPatternId, JsonSchema> = {
  'intent-routing': objectSchema({ selected: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 } }, ['selected']),
  'rag-screen': objectSchema({ relevant: { type: 'boolean' }, contradiction: { type: 'boolean' }, injection: { type: 'boolean' } }, ['relevant', 'contradiction', 'injection']),
  'citation-support': objectSchema({ selectedLocator: { type: 'string' }, sourceDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' }, support: { enum: ['supported', 'unclear', 'unsupported'] } }, ['selectedLocator', 'sourceDigest', 'support']),
  guardrails: objectSchema({ allowProbability: { type: 'number', minimum: 0, maximum: 1 } }, ['allowProbability']),
  'tool-risk-preflight': objectSchema({ selected: { type: 'string' }, distribution: { type: 'object', required: ['allow', 'deny'], properties: { allow: { type: 'number', minimum: 0, maximum: 1 }, deny: { type: 'number', minimum: 0, maximum: 1 } }, additionalProperties: false } }, ['selected', 'distribution']),
  'bounded-classification': objectSchema({ selected: { type: 'string' } }, ['selected']),
  'ordinal-scoring': objectSchema({ distribution: { type: 'object', minProperties: 2, additionalProperties: { type: 'number', minimum: 0, maximum: 1 } }, mean: { type: 'number' }, dispersion: { type: 'number', minimum: 0 } }, ['distribution', 'mean', 'dispersion']),
  'function-selection': objectSchema({ selected: { type: 'string' }, arguments: looseObject }, ['selected', 'arguments']),
  'same-subject-batch': objectSchema({ requestUsage: objectSchema({ inputTokens: { type: 'integer', minimum: 0 }, outputTokens: { type: 'integer', minimum: 0 } }, ['inputTokens', 'outputTokens']) }),
  'dependent-two-stage': objectSchema({ stageTwo: looseObject }, ['stageTwo']),
  'durable-review': objectSchema({ persisted: { const: true }, resultCount: { const: 1 } }, ['persisted', 'resultCount']),
  'candidate-selection': objectSchema({ selected: { type: 'string' } }, ['selected']),
};

export const PATTERN_CANDIDATE_POLICY_SCHEMA: JsonSchema = objectSchema({
  schema: { const: 'decision-pattern-candidate-policy/v1' }, patternId: { type: 'string', enum: [...PATTERNS] }, patternVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
  authority: { const: 'deterministic-code' }, authorizedCandidatesFrom: { type: 'string', minLength: 1 }, evidenceMayExpandCandidates: { const: false }, actionsExecute: { const: false },
  deterministicDenyOverrides: { const: true }, unauthorizedEvidenceRoute: { enum: ['review', 'deny'] },
}, ['schema', 'patternId', 'patternVersion', 'authority', 'authorizedCandidatesFrom', 'evidenceMayExpandCandidates', 'actionsExecute', 'deterministicDenyOverrides', 'unauthorizedEvidenceRoute']);

export function decisionPatternArtifactUri(id: DecisionPatternId, version: string, kind: PatternArtifactKind): string { return `${PREFIX}${id}/${version}/${kind}`; }

/** Resolve an artifact entirely from the installed module, without checkout-relative paths or I/O. */
export function resolveDecisionPatternArtifact(reference: string): ResolvedPatternArtifact {
  if (!reference.startsWith(PREFIX)) throw new Error('Unsupported decision pattern artifact reference');
  const parts = reference.slice(PREFIX.length).split('/');
  if (parts.length !== 3) throw new Error('Malformed decision pattern artifact reference');
  const [patternId, patternVersion, rawKind] = parts;
  if (!PATTERNS.has(patternId as DecisionPatternId) || !/^\d+\.\d+\.\d+$/.test(patternVersion ?? '') || !KINDS.has(rawKind as PatternArtifactKind)) throw new Error('Malformed decision pattern artifact reference');
  const id = patternId as DecisionPatternId;
  const kind = rawKind as PatternArtifactKind;
  return { schema: 'decision-pattern-artifact/v1', patternId: id, patternVersion: patternVersion!, kind, mediaType: kind === 'readme' ? 'text/markdown' : 'application/json', content: artifactContent(id, patternVersion!, kind) };
}

/** Validate pins, schemas and cross-artifact references using the production decision validators. */
export function validateGovernedPatternArtifacts(id: DecisionPatternId, version: string): void {
  const definition = definitionFor(id, version);
  const ruleset = rulesetFor(id, version, definition);
  validateDefinition(definition);
  validateRuleset(ruleset);
  validateBinding(bindingFor(id, version, ruleset, false), ruleset);
  validateBinding(bindingFor(id, version, ruleset, true), ruleset);
  const validatePolicy = new Ajv2020({ strict: true, allErrors: true }).compile(PATTERN_CANDIDATE_POLICY_SCHEMA);
  if (!validatePolicy(candidatePolicyFor(id, version))) throw new Error('candidate policy is invalid');
}

function artifactContent(id: DecisionPatternId, version: string, kind: PatternArtifactKind): JsonValue | string {
  const definition = definitionFor(id, version);
  const ruleset = rulesetFor(id, version, definition);
  switch (kind) {
    case 'definition': return definition as unknown as JsonValue;
    case 'input-schema': return INPUT_SCHEMAS[id] as JsonValue;
    case 'output-schema': return OUTPUT_SCHEMAS[id] as JsonValue;
    case 'candidate-policy': return candidatePolicyFor(id, version);
    case 'ruleset': return ruleset as unknown as JsonValue;
    case 'offline-binding': return bindingFor(id, version, ruleset, false) as unknown as JsonValue;
    case 'live-binding-template': return bindingFor(id, version, ruleset, true) as unknown as JsonValue;
    case 'expected-receipt': return { schema: 'decision-pattern-receipt/v1', pattern: { id, version }, executionMode: 'offline-recorded', evidenceOrigin: 'sanitized-recorded-fixture', attempts: 0, action: { status: 'unexecuted' } };
    case 'readme': return `# ${id}\n\nRecorded evidence is illustrative, not qualification, universal calibration, permission, or proof of deterministic model behavior. Failures abstain or route to review. Disable ${id}@${version} from discovery and retain receipts.\n`;
  }
}

function definitionFor(id: DecisionPatternId, version: string): DecisionDefinition {
  const answer: DecisionAnswer = id === 'ordinal-scoring' ? { kind: 'ordinal-score', levels: ['low', 'medium', 'high'] }
    : id === 'guardrails' ? { kind: 'truth-probability', trueDescription: 'Advisory screen permits', falseDescription: 'Advisory screen flags' }
      : { kind: 'choice', options: choiceOptions(id).map(option => ({ id: option, description: `${id} evidence: ${option}` })) };
  return { apiVersion: 'decision.aiwg.io/v1alpha2', kind: 'DecisionDefinition', metadata: { id: `pattern.${id}.assessment`, version, description: `Governed ${id} evidence definition` },
    spec: { purpose: `Collect bounded advisory evidence for ${id}`, inputSchema: INPUT_SCHEMAS[id], question: `Assess the synthetic ${id} input without taking action.`, answer, requiredCapabilities: [] } };
}

function rulesetFor(id: DecisionPatternId, version: string, definition: DecisionDefinition): DecisionRuleset {
  const outputSchema = objectSchema({ route: { enum: ['accept', 'review', 'deny', 'unavailable'] }, reason: { type: 'string', minLength: 1 }, action: { const: 'unexecuted' } }, ['route', 'reason', 'action']);
  return { apiVersion: 'decision.aiwg.io/v1alpha2', kind: 'DecisionRuleset', metadata: { id: `pattern.${id}.ruleset`, version, description: `Deterministic policy boundary for ${id}` },
    spec: { purpose: `Keep ${id} evidence subordinate to deterministic authority`, inputSchema: INPUT_SCHEMAS[id], evaluations: [{ alias: 'assessment', decision: { id: definition.metadata.id, version, digest: artifactDigest(definition) }, inputPointer: '' }],
      rules: [{ id: 'evidence-present', priority: 100, when: { op: 'exists', left: { source: 'decision', alias: 'assessment', pointer: '/value' } }, outcome: { route: 'review', reason: 'policy-evaluation-required', action: 'unexecuted' } }],
      composition: 'first-match', conflict: 'review', defaultOutcome: { route: 'review', reason: 'no-authorized-outcome', action: 'unexecuted' }, failureOutcome: { route: 'review', reason: 'evaluation-failed', action: 'unexecuted' }, outputSchema } };
}

function bindingFor(id: DecisionPatternId, version: string, ruleset: DecisionRuleset, live: boolean): DecisionBinding {
  return { apiVersion: 'decision.aiwg.io/v1alpha2', kind: 'DecisionBinding', metadata: { id: `pattern.${id}.${live ? 'live' : 'offline'}`, version, description: `${live ? 'Disabled opt-in live' : 'Recorded offline'} binding for ${id}` },
    spec: { ruleset: { id: ruleset.metadata.id, version, digest: artifactDigest(ruleset) }, totalTimeoutMs: live ? 15_000 : 1_000, maxAttempts: 1, concurrency: 1,
      evaluations: { assessment: { targets: [{ adapter: live ? 'jev' : 'llm-subagent', adapterVersion: '1.0.0', model: live ? 'jev:explicit-opt-in-required' : 'offline:recorded-fixture',
        ...(live ? { credentialRef: 'typesafe.jev.playground' } : { subagent: { id: 'pattern.offline.recorded-adapter', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}` as const } }),
        requiredCapabilities: [], acceptance: { mode: 'typed-value' }, timeoutMs: live ? 15_000 : 1_000, retry: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 } }], fallbackOn: [] } } } };
}

function candidatePolicyFor(id: DecisionPatternId, version: string): JsonValue {
  return { schema: 'decision-pattern-candidate-policy/v1', patternId: id, patternVersion: version, authority: 'deterministic-code', authorizedCandidatesFrom: ({ 'intent-routing': '/authorizedCandidates', 'bounded-classification': '/allowedOptions', 'function-selection': '/legalFunctions', 'candidate-selection': '/extractedCandidates' } as Partial<Record<DecisionPatternId, string>>)[id] ?? 'deterministic-policy', evidenceMayExpandCandidates: false, actionsExecute: false, deterministicDenyOverrides: true, unauthorizedEvidenceRoute: id === 'function-selection' ? 'deny' : 'review' };
}

function choiceOptions(id: DecisionPatternId): string[] {
  return ({ 'intent-routing': ['authorized', 'none', 'manual-review'], 'rag-screen': ['relevant', 'contradiction', 'injection'], 'citation-support': ['supported', 'unclear', 'unsupported'], 'tool-risk-preflight': ['allow', 'deny', 'review'], 'bounded-classification': ['known', 'none', 'review'], 'function-selection': ['authorized', 'none', 'review'], 'same-subject-batch': ['same-subject', 'multiple-subjects'], 'dependent-two-stage': ['continue', 'stop'], 'durable-review': ['review', 'resume'], 'candidate-selection': ['authorized', 'none', 'review'] } as Partial<Record<DecisionPatternId, string[]>>)[id] ?? ['allow', 'deny'];
}
