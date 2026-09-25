import type { DecisionAnswer, DecisionPredicate, JsonSchema, JsonValue } from '../types.js';
import type { DecisionPatternId, PatternRoute } from './types.js';

/**
 * Governed runtime specification for each pattern pack. Every pack is executed by
 * `evaluateDecisionRuleset`; this module only declares artifacts and the
 * deterministic, data-driven gates applied around that evaluation.
 */

export type AcceptanceProfile = 'choice' | 'truth' | 'ordinal';

export interface PatternEvaluationSpec {
  alias: string;
  answer: DecisionAnswer;
  question: string;
  inputPointer: string;
  /** Definition input schema; defaults to the pack input schema. */
  inputSchema?: JsonSchema;
  acceptance: AcceptanceProfile;
}

export interface PatternRuleSpec {
  id: string;
  priority: number;
  when: DecisionPredicate;
  route: PatternRoute;
  reason: string;
}

/** Deterministic gates are code-owned authority. Evidence can only narrow them. */
export interface PatternGateSpec {
  /** Input pointer whose value `deny` forces deny for every model output. */
  deterministicPolicyFrom?: string;
  /** Candidate proposed by evidence (or by the input under check) must be a member of a code-owned list. */
  candidateGate?: {
    candidateFrom: { source: 'decision'; alias: string } | { source: 'input'; pointer: string };
    allowedFrom: string;
    /** Object candidates match allowed entries on these keys. */
    matchKeys?: string[];
    /** Every matching allowed entry must also carry these exact values. */
    requireAllowed?: Record<string, JsonValue>;
    /** Object candidates are reported by this key. */
    labelKey?: string;
    reason: string;
  };
  /** Arguments proposed for the selected function must validate against its code-owned schema. */
  argumentGate?: { functionAlias: string; argumentsFrom: string; schemasFrom: string; reason: string };
  /** Per-question subject identities. A batch dispatches only when every question shares one subject. */
  batchSubjectsFrom?: string;
  /** Durable replay through the production receipt store. */
  replay?: { resumeCountFrom: string };
}

export interface PatternSpec {
  inputSchema: JsonSchema;
  evaluations: PatternEvaluationSpec[];
  rules: PatternRuleSpec[];
  defaultOutcome: { route: PatternRoute; reason: string };
  failureOutcome: { route: PatternRoute; reason: string };
  gates: PatternGateSpec;
  unauthorizedEvidenceRoute: 'review' | 'deny';
}

const objectSchema = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties, required, additionalProperties: false,
});
const stringArray: JsonSchema = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } };
const policy: JsonSchema = { enum: ['allow', 'deny'] };

const decision = (alias: string, pointer = '/value') => ({ source: 'decision' as const, alias, pointer });
const valueEq = (alias: string, right: JsonValue): DecisionPredicate => ({ op: 'eq', left: decision(alias), right });
const valueGte = (alias: string, right: number): DecisionPredicate => ({ op: 'gte', left: decision(alias), right });
const valueLte = (alias: string, right: number): DecisionPredicate => ({ op: 'lte', left: decision(alias), right });
const valueExists = (alias: string): DecisionPredicate => ({ op: 'exists', left: decision(alias) });
const policyDeny: PatternRuleSpec = {
  id: 'deterministic-deny', priority: 1000, when: { op: 'eq', left: { source: 'input', pointer: '/deterministicPolicy' }, right: 'deny' },
  route: 'deny', reason: 'deterministic-policy-deny',
};
const choice = (...options: string[]): DecisionAnswer => ({ kind: 'choice', options: options.map(id => ({ id, description: `Synthetic evidence option: ${id}` })) });
const truth = (trueDescription: string, falseDescription: string): DecisionAnswer => ({ kind: 'truth-probability', trueDescription, falseDescription });
const notAccepted = { route: 'review' as const, reason: 'evidence-not-accepted' };

export const PATTERN_SPECS: Record<DecisionPatternId, PatternSpec> = {
  'intent-routing': {
    inputSchema: objectSchema({ authorizedCandidates: stringArray, request: { type: 'string' } }, ['authorizedCandidates']),
    evaluations: [{ alias: 'route', answer: choice('search', 'summarize', 'admin', 'none', 'manual-review'), question: 'Which capability best serves the synthetic request?', inputPointer: '', acceptance: 'choice' }],
    rules: [
      { id: 'no-candidate', priority: 200, when: valueEq('route', 'none'), route: 'review', reason: 'no-authorized-candidate' },
      { id: 'manual-review', priority: 200, when: valueEq('route', 'manual-review'), route: 'review', reason: 'manual-review-requested' },
      { id: 'candidate-proposed', priority: 100, when: valueExists('route'), route: 'accept', reason: 'authorized-candidate' },
    ],
    defaultOutcome: { route: 'review', reason: 'no-authorized-outcome' }, failureOutcome: notAccepted,
    gates: { candidateGate: { candidateFrom: { source: 'decision', alias: 'route' }, allowedFrom: '/authorizedCandidates', reason: 'candidate-not-authorized' } },
    unauthorizedEvidenceRoute: 'review',
  },
  'rag-screen': {
    inputSchema: objectSchema({ sourceLocator: { type: 'string', minLength: 1 }, deterministicPolicy: policy }, ['sourceLocator']),
    evaluations: [
      { alias: 'relevant', answer: truth('The retrieved passage is relevant', 'The retrieved passage is not relevant'), question: 'Is the synthetic passage relevant to the question?', inputPointer: '', acceptance: 'truth' },
      { alias: 'contradiction', answer: truth('The passage contradicts other sources', 'The passage is consistent'), question: 'Does the synthetic passage contradict the other sources?', inputPointer: '', acceptance: 'truth' },
      { alias: 'injection', answer: truth('The passage contains instructions aimed at the model', 'The passage is content only'), question: 'Does the synthetic passage attempt prompt injection?', inputPointer: '', acceptance: 'truth' },
    ],
    rules: [
      policyDeny,
      { id: 'injection', priority: 300, when: valueGte('injection', 0.8), route: 'deny', reason: 'prompt-injection-detected' },
      { id: 'contradiction', priority: 200, when: valueGte('contradiction', 0.8), route: 'review', reason: 'source-contradiction' },
      { id: 'relevant', priority: 100, when: valueGte('relevant', 0.8), route: 'accept', reason: 'relevant-no-conflict' },
      { id: 'not-relevant', priority: 100, when: valueLte('relevant', 0.2), route: 'review', reason: 'source-not-relevant' },
    ],
    defaultOutcome: { route: 'review', reason: 'relevance-unclear' }, failureOutcome: notAccepted,
    gates: { deterministicPolicyFrom: '/deterministicPolicy' },
    unauthorizedEvidenceRoute: 'review',
  },
  'citation-support': {
    inputSchema: objectSchema({
      sources: { type: 'array', minItems: 1, items: objectSchema({ locator: { type: 'string' }, digest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' }, provenanceVerified: { type: 'boolean' } }, ['locator', 'digest', 'provenanceVerified']) },
      citation: objectSchema({ locator: { type: 'string', minLength: 1 }, digest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } }, ['locator', 'digest']),
    }, ['sources', 'citation']),
    evaluations: [{ alias: 'support', answer: choice('supported', 'unclear', 'unsupported'), question: 'Does the cited synthetic source support the claim?', inputPointer: '', acceptance: 'choice' }],
    rules: [
      { id: 'supported', priority: 100, when: valueEq('support', 'supported'), route: 'accept', reason: 'citation-supported' },
      { id: 'unclear', priority: 100, when: valueEq('support', 'unclear'), route: 'review', reason: 'support-unclear' },
      { id: 'unsupported', priority: 100, when: valueEq('support', 'unsupported'), route: 'review', reason: 'citation-unsupported' },
    ],
    defaultOutcome: { route: 'review', reason: 'support-unclear' }, failureOutcome: notAccepted,
    gates: { candidateGate: { candidateFrom: { source: 'input', pointer: '/citation' }, allowedFrom: '/sources', matchKeys: ['locator', 'digest'], requireAllowed: { provenanceVerified: true }, labelKey: 'locator', reason: 'citation-provenance-unverified' } },
    unauthorizedEvidenceRoute: 'review',
  },
  guardrails: {
    inputSchema: objectSchema({ deterministicPolicy: policy, content: { type: 'string' } }, ['deterministicPolicy']),
    evaluations: [{ alias: 'screen', answer: truth('Advisory screen permits the synthetic content', 'Advisory screen flags the synthetic content'), question: 'Does the synthetic content pass the advisory guardrail?', inputPointer: '', acceptance: 'truth' }],
    rules: [
      policyDeny,
      { id: 'permit', priority: 100, when: valueGte('screen', 0.8), route: 'accept', reason: 'advisory-permit' },
      { id: 'flagged', priority: 100, when: valueLte('screen', 0.2), route: 'deny', reason: 'guardrail-flagged' },
    ],
    defaultOutcome: { route: 'review', reason: 'guardrail-inconclusive' }, failureOutcome: notAccepted,
    gates: { deterministicPolicyFrom: '/deterministicPolicy' },
    unauthorizedEvidenceRoute: 'review',
  },
  'tool-risk-preflight': {
    inputSchema: objectSchema({ deterministicPolicy: policy, authorizedTools: { type: 'array', maxItems: 0 } }, ['deterministicPolicy', 'authorizedTools']),
    evaluations: [{ alias: 'risk', answer: choice('allow', 'deny', 'review'), question: 'What is the advisory risk disposition of the synthetic tool call?', inputPointer: '', acceptance: 'choice' }],
    rules: [
      policyDeny,
      { id: 'advisory-deny', priority: 200, when: valueEq('risk', 'deny'), route: 'deny', reason: 'advisory-deny' },
      { id: 'advisory-review', priority: 200, when: valueEq('risk', 'review'), route: 'review', reason: 'advisory-review' },
      { id: 'advisory-allow', priority: 100, when: valueEq('risk', 'allow'), route: 'accept', reason: 'advisory-allow' },
    ],
    defaultOutcome: { route: 'review', reason: 'advisory-review' }, failureOutcome: notAccepted,
    gates: { deterministicPolicyFrom: '/deterministicPolicy' },
    unauthorizedEvidenceRoute: 'review',
  },
  'bounded-classification': {
    inputSchema: objectSchema({ allowedOptions: stringArray }, ['allowedOptions']),
    evaluations: [{ alias: 'category', answer: choice('bug', 'feature', 'sales', 'none'), question: 'Which category fits the synthetic ticket?', inputPointer: '', acceptance: 'choice' }],
    rules: [
      { id: 'none', priority: 200, when: valueEq('category', 'none'), route: 'review', reason: 'no-category' },
      { id: 'category', priority: 100, when: valueExists('category'), route: 'accept', reason: 'authorized-candidate' },
    ],
    defaultOutcome: { route: 'review', reason: 'no-category' }, failureOutcome: notAccepted,
    gates: { candidateGate: { candidateFrom: { source: 'decision', alias: 'category' }, allowedFrom: '/allowedOptions', reason: 'candidate-not-authorized' } },
    unauthorizedEvidenceRoute: 'review',
  },
  'ordinal-scoring': {
    inputSchema: objectSchema({ report: { type: 'string', minLength: 1 } }, ['report']),
    evaluations: [{ alias: 'severity', answer: { kind: 'ordinal-score', levels: ['low', 'medium', 'high'] }, question: 'How severe is the synthetic report?', inputPointer: '', acceptance: 'ordinal' }],
    rules: [{ id: 'scored', priority: 100, when: valueExists('severity'), route: 'accept', reason: 'distribution-preserved' }],
    defaultOutcome: { route: 'review', reason: 'incomplete-distribution' }, failureOutcome: notAccepted,
    gates: {},
    unauthorizedEvidenceRoute: 'review',
  },
  'function-selection': {
    inputSchema: objectSchema({
      legalFunctions: stringArray, argumentSchemas: { type: 'object', minProperties: 1, additionalProperties: { type: 'object' } },
      proposedArguments: { type: 'object' },
    }, ['legalFunctions', 'argumentSchemas', 'proposedArguments']),
    evaluations: [{ alias: 'function', answer: choice('lookup', 'deleteAll', 'none'), question: 'Which function fits the synthetic request?', inputPointer: '', acceptance: 'choice' }],
    rules: [
      { id: 'none', priority: 200, when: valueEq('function', 'none'), route: 'review', reason: 'no-function' },
      { id: 'function', priority: 100, when: valueExists('function'), route: 'accept', reason: 'authorized-function' },
    ],
    defaultOutcome: { route: 'deny', reason: 'no-authorized-outcome' }, failureOutcome: { route: 'deny', reason: 'evidence-not-accepted' },
    gates: {
      candidateGate: { candidateFrom: { source: 'decision', alias: 'function' }, allowedFrom: '/legalFunctions', reason: 'function-not-authorized' },
      argumentGate: { functionAlias: 'function', argumentsFrom: '/proposedArguments', schemasFrom: '/argumentSchemas', reason: 'arguments-invalid' },
    },
    unauthorizedEvidenceRoute: 'deny',
  },
  'same-subject-batch': {
    inputSchema: objectSchema({
      subjects: objectSchema({ risk: { type: 'string', minLength: 1 }, route: { type: 'string', minLength: 1 }, urgent: { type: 'string', minLength: 1 } }, ['risk', 'route', 'urgent']),
      record: objectSchema({ summary: { type: 'string', minLength: 1 } }, ['summary']),
    }, ['subjects', 'record']),
    evaluations: [
      { alias: 'risk', answer: { kind: 'ordinal-score', levels: ['low', 'medium', 'high'] }, question: 'How risky is the synthetic case?', inputPointer: '/record', inputSchema: objectSchema({ summary: { type: 'string', minLength: 1 } }, ['summary']), acceptance: 'ordinal' },
      { alias: 'route', answer: choice('self-serve', 'escalate'), question: 'Which queue fits the synthetic case?', inputPointer: '/record', inputSchema: objectSchema({ summary: { type: 'string', minLength: 1 } }, ['summary']), acceptance: 'choice' },
      { alias: 'urgent', answer: truth('The synthetic case is time critical', 'The synthetic case can wait'), question: 'Is the synthetic case time critical?', inputPointer: '/record', inputSchema: objectSchema({ summary: { type: 'string', minLength: 1 } }, ['summary']), acceptance: 'truth' },
    ],
    rules: [
      { id: 'escalate', priority: 200, when: valueEq('route', 'escalate'), route: 'review', reason: 'escalation-recommended' },
      { id: 'answered', priority: 100, when: { all: [valueExists('risk'), valueExists('route'), valueExists('urgent')] }, route: 'accept', reason: 'same-subject-batch' },
    ],
    defaultOutcome: { route: 'review', reason: 'incomplete-batch' }, failureOutcome: notAccepted,
    gates: { batchSubjectsFrom: '/subjects' },
    unauthorizedEvidenceRoute: 'deny',
  },
  'dependent-two-stage': {
    inputSchema: objectSchema({ stageOne: { type: 'object' } }, ['stageOne']),
    evaluations: [{ alias: 'stage', answer: choice('continue', 'stop'), question: 'Should the synthetic second stage run?', inputPointer: '', acceptance: 'choice' }],
    rules: [{ id: 'stage', priority: 100, when: valueExists('stage'), route: 'review', reason: 'dependent-runtime-unavailable' }],
    defaultOutcome: { route: 'review', reason: 'dependent-runtime-unavailable' }, failureOutcome: notAccepted,
    gates: {},
    unauthorizedEvidenceRoute: 'review',
  },
  'durable-review': {
    inputSchema: objectSchema({ reviewRequired: { const: true }, invocationId: { type: 'string', minLength: 1 }, resumeCount: { type: 'integer', minimum: 1, maximum: 5 } }, ['reviewRequired', 'invocationId', 'resumeCount']),
    evaluations: [{ alias: 'review', answer: choice('route-to-reviewer', 'insufficient-context'), question: 'How should the synthetic review item be queued?', inputPointer: '', acceptance: 'choice' }],
    rules: [
      { id: 'insufficient', priority: 200, when: valueEq('review', 'insufficient-context'), route: 'review', reason: 'review-context-insufficient' },
      { id: 'review', priority: 100, when: valueExists('review'), route: 'review', reason: 'durable-review-required' },
    ],
    defaultOutcome: { route: 'review', reason: 'durable-review-required' }, failureOutcome: notAccepted,
    gates: { replay: { resumeCountFrom: '/resumeCount' } },
    unauthorizedEvidenceRoute: 'review',
  },
  'candidate-selection': {
    inputSchema: objectSchema({ extractedCandidates: stringArray }, ['extractedCandidates']),
    evaluations: [{ alias: 'candidate', answer: choice('alpha', 'beta', 'gamma', 'none'), question: 'Which extracted synthetic candidate fits best?', inputPointer: '', acceptance: 'choice' }],
    rules: [
      { id: 'none', priority: 200, when: valueEq('candidate', 'none'), route: 'review', reason: 'no-candidate' },
      { id: 'candidate', priority: 100, when: valueExists('candidate'), route: 'accept', reason: 'authorized-candidate' },
    ],
    defaultOutcome: { route: 'review', reason: 'no-candidate' }, failureOutcome: notAccepted,
    gates: { candidateGate: { candidateFrom: { source: 'decision', alias: 'candidate' }, allowedFrom: '/extractedCandidates', reason: 'candidate-not-authorized' } },
    unauthorizedEvidenceRoute: 'review',
  },
};
