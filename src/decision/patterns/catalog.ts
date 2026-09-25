import type { JsonValue } from '../types.js';
import type { DecisionPatternId, DecisionPatternPack, PatternFixture } from './types.js';
import { decisionPatternArtifactUri } from './artifacts.js';
import { PATTERN_SPECS } from './specs.js';

const fixture = (id: string, input: PatternFixture['input'], recordedEvidence: PatternFixture['recordedEvidence'], route: PatternFixture['expected']['route'], reason: string): PatternFixture => ({
  id, subjectId: `synthetic:${id}`, input, recordedEvidence, expected: { route, reason },
});

/** Sanitized recorded Jev Choice answer; the unselected mass is spread evenly. */
export function recordedChoice(options: readonly string[], selected: string, probability: number): Record<string, JsonValue> {
  const rest = options.length > 1 ? (1 - probability) / (options.length - 1) : 0;
  return { type: 'choice', choice: selected, probabilities: Object.fromEntries(options.map(option => [option, option === selected ? probability : rest])), confidence: probability };
}

/** Sanitized recorded Jev Noul (truth-probability) answer. */
export function recordedNoul(probability: number): Record<string, JsonValue> { return { type: 'noul', noul: probability }; }

/** Sanitized recorded Jev Score answer; the score is the distribution's weighted mean. */
export function recordedScore(levels: readonly string[], distribution: readonly number[], confidence = 0.8): Record<string, JsonValue> {
  return { type: 'score', score: distribution.reduce((sum, probability, index) => sum + probability * index, 0),
    probabilities: Object.fromEntries(distribution.map((probability, index) => [String(index), probability])),
    legend: Object.fromEntries(levels.map((level, index) => [String(index), level])), confidence };
}

const options = (id: DecisionPatternId, alias: string): string[] => {
  const answer = PATTERN_SPECS[id].evaluations.find(evaluation => evaluation.alias === alias)!.answer;
  return answer.kind === 'choice' ? answer.options.map(option => option.id) : [];
};
const choiceFor = (id: DecisionPatternId, alias: string, selected: string, probability: number) => recordedChoice(options(id, alias), selected, probability);
const answers = (value: Record<string, Record<string, JsonValue>>, usage?: { input_tokens: number; output_tokens: number }): Record<string, JsonValue> =>
  ({ answers: value, ...(usage ? { usage } : {}) });
const LEVELS = ['low', 'medium', 'high'];
const lookupSchema = { lookup: { type: 'object', required: ['query'], properties: { query: { type: 'string' } }, additionalProperties: false } };
const source = { locator: 'doc:1#p2', digest: `sha256:${'a'.repeat(64)}`, provenanceVerified: true };

function pack(
  id: DecisionPatternId,
  primitive: DecisionPatternPack['primitive'],
  summary: string,
  fixtures: PatternFixture[],
  status: DecisionPatternPack['status'] = 'supported',
): DecisionPatternPack {
  const artifact = (kind: Parameters<typeof decisionPatternArtifactUri>[2]) => decisionPatternArtifactUri(id, '1.0.0', kind);
  const calls = PATTERN_SPECS[id].evaluations.length;
  return {
    schema: 'decision-pattern-pack/v1', id, version: '1.0.0', status, summary, primitive,
    artifacts: {
      definitions: PATTERN_SPECS[id].evaluations.map(evaluation => decisionPatternArtifactUri(id, '1.0.0', 'definition', evaluation.alias)),
      inputSchema: artifact('input-schema'),
      outputSchema: artifact('output-schema'), candidatePolicy: artifact('candidate-policy'),
      ruleset: artifact('ruleset'), offlineBinding: artifact('offline-binding'),
      ...(status !== 'unavailable' ? { liveBindingTemplate: artifact('live-binding-template') } : {}),
      expectedReceipt: artifact('expected-receipt'), readme: artifact('readme'),
    },
    fixtures,
    limitations: ['Recorded evidence is illustrative, not workload qualification or universal calibration.', 'Typed output does not guarantee semantic correctness.'],
    failurePath: 'Abstain or route to review; never infer permission from model evidence.',
    rollback: `Remove ${id}@1.0.0 from discovery or restore its pinned predecessor; retain receipts.`,
    ...(status !== 'unavailable' ? { live: { syntheticOnly: true, credentialRef: 'typesafe:jev/playground', requiredEgressClass: 'synthetic-decision', limits: { maxCalls: calls, maxTokens: 1024 * calls, maxCostUsd: 0.02 * calls, allowUnknownCost: false, maxAttempts: 1, deadlineMs: 15_000 } } } : {}),
  };
}

export const decisionPatternPacks: readonly DecisionPatternPack[] = [
  pack('intent-routing', 'choice', 'Route only among code-authorized capabilities, with none/review.', [
    fixture('route-authorized', { authorizedCandidates: ['search', 'summarize'] }, answers({ route: choiceFor('intent-routing', 'route', 'search', 0.91) }), 'accept', 'authorized-candidate'),
    fixture('route-unauthorized', { authorizedCandidates: ['summarize'] }, answers({ route: choiceFor('intent-routing', 'route', 'admin', 0.99) }), 'review', 'candidate-not-authorized'),
    fixture('route-low-confidence', { authorizedCandidates: ['search', 'summarize'] }, answers({ route: choiceFor('intent-routing', 'route', 'search', 0.55) }), 'review', 'evidence-not-accepted'),
  ]),
  pack('rag-screen', 'composite', 'Advisory relevance, contradiction, and injection evidence.', [
    fixture('rag-relevant', { sourceLocator: 'doc:rag#1' }, answers({ relevant: recordedNoul(0.95), contradiction: recordedNoul(0.03), injection: recordedNoul(0.02) }), 'accept', 'relevant-no-conflict'),
    fixture('rag-contradiction', { sourceLocator: 'doc:rag#2' }, answers({ relevant: recordedNoul(0.9), contradiction: recordedNoul(0.92), injection: recordedNoul(0.02) }), 'review', 'source-contradiction'),
    fixture('rag-injection', { sourceLocator: 'doc:rag#3' }, answers({ relevant: recordedNoul(0.9), contradiction: recordedNoul(0.05), injection: recordedNoul(0.97) }), 'deny', 'prompt-injection-detected'),
    fixture('rag-policy-deny', { sourceLocator: 'doc:rag#4', deterministicPolicy: 'deny' }, answers({ relevant: recordedNoul(0.95), contradiction: recordedNoul(0.03), injection: recordedNoul(0.02) }), 'deny', 'deterministic-policy-deny'),
  ]),
  pack('citation-support', 'choice', 'Citation support with independent locator and provenance validation.', [
    fixture('citation-valid', { sources: [source], citation: { locator: 'doc:1#p2', digest: source.digest } }, answers({ support: choiceFor('citation-support', 'support', 'supported', 0.93) }), 'accept', 'citation-supported'),
    fixture('citation-fabricated', { sources: [source], citation: { locator: 'doc:9#p1', digest: `sha256:${'b'.repeat(64)}` } }, answers({ support: choiceFor('citation-support', 'support', 'supported', 0.97) }), 'review', 'citation-provenance-unverified'),
  ]),
  pack('guardrails', 'truth-probability', 'Model screening remains advisory beside deterministic input/output policy.', [
    fixture('guardrail-conflict', { deterministicPolicy: 'deny' }, answers({ screen: recordedNoul(1) }), 'deny', 'deterministic-policy-deny'),
    fixture('guardrail-permit', { deterministicPolicy: 'allow' }, answers({ screen: recordedNoul(0.93) }), 'accept', 'advisory-permit'),
    fixture('guardrail-flagged', { deterministicPolicy: 'allow' }, answers({ screen: recordedNoul(0.04) }), 'deny', 'guardrail-flagged'),
    // A Noul probability of exactly 0.5 is uncertainty, not a "medium" label or an accept.
    fixture('guardrail-noul-midpoint', { deterministicPolicy: 'allow' }, answers({ screen: recordedNoul(0.5) }), 'review', 'evidence-not-accepted'),
  ]),
  pack('tool-risk-preflight', 'choice', 'Advisory tool-risk classification that cannot grant tool authority.', [
    fixture('tool-deny-conflict', { deterministicPolicy: 'deny', authorizedTools: [] }, answers({ risk: choiceFor('tool-risk-preflight', 'risk', 'allow', 0.98) }), 'deny', 'deterministic-policy-deny'),
    fixture('tool-advisory-allow', { deterministicPolicy: 'allow', authorizedTools: [] }, answers({ risk: choiceFor('tool-risk-preflight', 'risk', 'allow', 0.9) }), 'accept', 'advisory-allow'),
    fixture('tool-advisory-deny', { deterministicPolicy: 'allow', authorizedTools: [] }, answers({ risk: choiceFor('tool-risk-preflight', 'risk', 'deny', 0.86) }), 'deny', 'advisory-deny'),
  ]),
  pack('bounded-classification', 'choice', 'Classification over a closed code-owned option set.', [
    fixture('classification-unknown', { allowedOptions: ['bug', 'feature', 'none'] }, answers({ category: choiceFor('bounded-classification', 'category', 'sales', 0.9) }), 'review', 'candidate-not-authorized'),
    fixture('classification-known', { allowedOptions: ['bug', 'feature', 'none'] }, answers({ category: choiceFor('bounded-classification', 'category', 'bug', 0.88) }), 'accept', 'authorized-candidate'),
  ]),
  pack('ordinal-scoring', 'ordinal-score', 'Ordinal score preserving legend, distribution, mean, and dispersion.', [
    fixture('ordinal-full', { report: 'Synthetic outage report' }, answers({ severity: recordedScore(LEVELS, [0.2, 0.5, 0.3]) }), 'accept', 'distribution-preserved'),
    fixture('ordinal-dispersed', { report: 'Synthetic ambiguous report' }, answers({ severity: recordedScore(LEVELS, [0.5, 0, 0.5]) }), 'review', 'evidence-not-accepted'),
  ]),
  pack('function-selection', 'choice', 'Choose but never execute a code-enumerated function with typed arguments.', [
    fixture('function-valid', { legalFunctions: ['lookup'], argumentSchemas: lookupSchema, proposedArguments: { query: 'synthetic' } }, answers({ function: choiceFor('function-selection', 'function', 'lookup', 0.94) }), 'accept', 'authorized-function'),
    fixture('function-unauthorized', { legalFunctions: ['lookup'], argumentSchemas: lookupSchema, proposedArguments: {} }, answers({ function: choiceFor('function-selection', 'function', 'deleteAll', 0.96) }), 'deny', 'function-not-authorized'),
    fixture('function-invalid-arguments', { legalFunctions: ['lookup'], argumentSchemas: lookupSchema, proposedArguments: { query: 42 } }, answers({ function: choiceFor('function-selection', 'function', 'lookup', 0.94) }), 'deny', 'arguments-invalid'),
  ]),
  pack('same-subject-batch', 'composite', 'Heterogeneous questions sharing one explicit subject identity.', [
    fixture('batch-one-subject', { subjects: { risk: 'case:1', route: 'case:1', urgent: 'case:1' }, record: { summary: 'Synthetic case 1' } },
      answers({ risk: recordedScore(LEVELS, [0.7, 0.2, 0.1]), route: choiceFor('same-subject-batch', 'route', 'self-serve', 0.9), urgent: recordedNoul(0.1) }, { input_tokens: 20, output_tokens: 4 }), 'accept', 'same-subject-batch'),
    fixture('batch-multi-subject', { subjects: { risk: 'case:1', route: 'case:2', urgent: 'case:1' }, record: { summary: 'Synthetic cases 1 and 2' } },
      answers({ risk: recordedScore(LEVELS, [0.7, 0.2, 0.1]), route: choiceFor('same-subject-batch', 'route', 'self-serve', 0.9), urgent: recordedNoul(0.1) }, { input_tokens: 20, output_tokens: 4 }), 'deny', 'multi-subject-batch-rejected'),
  ]),
  pack('dependent-two-stage', 'composite', 'Conditional DAG example; unavailable until the governed DAG runtime is supported.', [], 'unavailable'),
  pack('durable-review', 'composite', 'Experimental offline review/resume contract with idempotency-key evidence.', [
    fixture('review-resume', { reviewRequired: true, invocationId: 'synthetic-review-1', resumeCount: 2 }, answers({ review: choiceFor('durable-review', 'review', 'route-to-reviewer', 0.9) }), 'review', 'durable-review-required'),
  ], 'experimental'),
  pack('candidate-selection', 'choice', 'Deterministic extraction followed by bounded evidence-based selection.', [
    fixture('candidate-bounded', { extractedCandidates: ['alpha', 'beta'] }, answers({ candidate: choiceFor('candidate-selection', 'candidate', 'beta', 0.87) }), 'accept', 'authorized-candidate'),
    fixture('candidate-not-extracted', { extractedCandidates: ['alpha', 'beta'] }, answers({ candidate: choiceFor('candidate-selection', 'candidate', 'gamma', 0.9) }), 'review', 'candidate-not-authorized'),
  ]),
] as const;

export function getDecisionPatternPack(id: DecisionPatternId): DecisionPatternPack {
  const found = decisionPatternPacks.find(candidate => candidate.id === id);
  if (!found) throw new Error(`Unknown decision pattern: ${id}`);
  return structuredClone(found);
}
