import type { DecisionPatternId, DecisionPatternPack, PatternFixture } from './types.js';
import { decisionPatternArtifactUri } from './artifacts.js';

const fixture = (id: string, input: PatternFixture['input'], recordedEvidence: PatternFixture['recordedEvidence'], route: PatternFixture['expected']['route'], reason: string): PatternFixture => ({
  id, subjectId: `synthetic:${id}`, input, recordedEvidence, expected: { route, reason },
});

function pack(
  id: DecisionPatternId,
  primitive: DecisionPatternPack['primitive'],
  summary: string,
  fixtures: PatternFixture[],
  status: DecisionPatternPack['status'] = 'supported',
): DecisionPatternPack {
  const artifact = (kind: Parameters<typeof decisionPatternArtifactUri>[2]) => decisionPatternArtifactUri(id, '1.0.0', kind);
  return {
    schema: 'decision-pattern-pack/v1', id, version: '1.0.0', status, summary, primitive,
    artifacts: {
      definitions: [artifact('definition')], inputSchema: artifact('input-schema'),
      outputSchema: artifact('output-schema'), candidatePolicy: artifact('candidate-policy'),
      ruleset: artifact('ruleset'), offlineBinding: artifact('offline-binding'),
      ...(status !== 'unavailable' ? { liveBindingTemplate: artifact('live-binding-template') } : {}),
      expectedReceipt: artifact('expected-receipt'), readme: artifact('readme'),
    },
    fixtures,
    limitations: ['Recorded evidence is illustrative, not workload qualification or universal calibration.', 'Typed output does not guarantee semantic correctness.'],
    failurePath: 'Abstain or route to review; never infer permission from model evidence.',
    rollback: `Remove ${id}@1.0.0 from discovery or restore its pinned predecessor; retain receipts.`,
    ...(status !== 'unavailable' ? { live: { syntheticOnly: true, credentialRef: 'typesafe:jev/playground', requiredEgressClass: 'synthetic-decision', limits: { maxCalls: 2, maxTokens: 2048, maxCostUsd: 0.05, allowUnknownCost: false, maxAttempts: 1, deadlineMs: 15_000 } } } : {}),
  };
}

export const decisionPatternPacks: readonly DecisionPatternPack[] = [
  pack('intent-routing', 'choice', 'Route only among code-authorized capabilities, with none/review.', [
    fixture('route-authorized', { authorizedCandidates: ['search', 'summarize'] }, { selected: 'search', confidence: 0.91 }, 'accept', 'authorized-candidate'),
    fixture('route-unauthorized', { authorizedCandidates: ['summarize'] }, { selected: 'admin', confidence: 0.99 }, 'review', 'candidate-not-authorized'),
  ]),
  pack('rag-screen', 'composite', 'Advisory relevance, contradiction, and injection evidence.', [
    fixture('rag-injection', { deterministicPolicy: 'deny' }, { relevant: true, contradiction: false, injection: false }, 'deny', 'deterministic-policy-deny'),
  ]),
  pack('citation-support', 'choice', 'Citation support with independent locator and provenance validation.', [
    fixture('citation-valid', { sourceLocators: ['doc:1#p2'] }, { selectedLocator: 'doc:1#p2', support: 'supported' }, 'accept', 'locator-verified'),
    fixture('citation-fabricated', { sourceLocators: ['doc:1#p2'] }, { selectedLocator: 'doc:9#p1', support: 'supported' }, 'review', 'locator-not-provided'),
  ]),
  pack('guardrails', 'truth-probability', 'Model screening remains advisory beside deterministic input/output policy.', [
    fixture('guardrail-conflict', { deterministicPolicy: 'deny' }, { allowProbability: 1 }, 'deny', 'deterministic-policy-deny'),
  ]),
  pack('tool-risk-preflight', 'choice', 'Advisory tool-risk classification that cannot grant tool authority.', [
    fixture('tool-deny-conflict', { deterministicPolicy: 'deny', authorizedTools: [] }, { selected: 'allow', distribution: { allow: 1, deny: 0 } }, 'deny', 'deterministic-policy-deny'),
  ]),
  pack('bounded-classification', 'choice', 'Classification over a closed code-owned option set.', [
    fixture('classification-unknown', { allowedOptions: ['bug', 'feature', 'none'] }, { selected: 'sales' }, 'review', 'candidate-not-authorized'),
  ]),
  pack('ordinal-scoring', 'ordinal-score', 'Ordinal score preserving legend, distribution, mean, and dispersion.', [
    fixture('ordinal-full', { legend: ['low', 'medium', 'high'] }, { distribution: { low: 0.2, medium: 0.5, high: 0.3 }, mean: 1.1, dispersion: 0.49 }, 'accept', 'distribution-preserved'),
  ]),
  pack('function-selection', 'choice', 'Choose but never execute a code-enumerated function with typed arguments.', [
    fixture('function-unauthorized', { legalFunctions: ['lookup'], argumentSchemas: { lookup: 'lookup/v1' } }, { selected: 'deleteAll', arguments: {} }, 'deny', 'function-not-authorized'),
  ]),
  pack('same-subject-batch', 'composite', 'Heterogeneous questions sharing one explicit subject identity.', [
    fixture('batch-one-subject', { itemSubjects: ['case:1', 'case:1'], questions: ['risk', 'route'] }, { requestUsage: { inputTokens: 20, outputTokens: 4 } }, 'accept', 'same-subject-batch'),
    fixture('batch-multi-subject', { itemSubjects: ['case:1', 'case:2'], questions: ['risk', 'route'] }, {}, 'deny', 'multi-subject-batch-rejected'),
  ]),
  pack('dependent-two-stage', 'composite', 'Conditional DAG example; unavailable until the governed DAG runtime is present.', [], 'unavailable'),
  pack('durable-review', 'composite', 'Experimental offline review/resume contract with idempotency-key evidence.', [
    fixture('review-resume', { reviewRequired: true, invocationId: 'synthetic-review-1', resumeCount: 2 }, { persisted: true, resultCount: 1 }, 'review', 'durable-review-required'),
  ], 'experimental'),
  pack('candidate-selection', 'choice', 'Deterministic extraction followed by bounded evidence-based selection.', [
    fixture('candidate-bounded', { extractedCandidates: ['alpha', 'beta'] }, { selected: 'beta' }, 'accept', 'authorized-candidate'),
  ]),
] as const;

export function getDecisionPatternPack(id: DecisionPatternId): DecisionPatternPack {
  const found = decisionPatternPacks.find(candidate => candidate.id === id);
  if (!found) throw new Error(`Unknown decision pattern: ${id}`);
  return structuredClone(found);
}
