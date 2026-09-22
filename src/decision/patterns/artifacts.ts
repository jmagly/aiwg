import type { JsonValue } from '../types.js';
import type { DecisionPatternId, PatternArtifactKind, ResolvedPatternArtifact } from './types.js';

const PREFIX = 'aiwg://decision-patterns/';
const KINDS = new Set<PatternArtifactKind>([
  'definition', 'input-schema', 'output-schema', 'candidate-policy', 'ruleset',
  'offline-binding', 'live-binding-template', 'expected-receipt', 'readme',
]);
const PATTERNS = new Set<DecisionPatternId>([
  'intent-routing', 'rag-screen', 'citation-support', 'guardrails', 'tool-risk-preflight',
  'bounded-classification', 'ordinal-scoring', 'function-selection', 'same-subject-batch',
  'dependent-two-stage', 'durable-review', 'candidate-selection',
]);

export function decisionPatternArtifactUri(id: DecisionPatternId, version: string, kind: PatternArtifactKind): string {
  return `${PREFIX}${id}/${version}/${kind}`;
}

/** Resolve an artifact entirely from the installed module, without checkout-relative paths or I/O. */
export function resolveDecisionPatternArtifact(reference: string): ResolvedPatternArtifact {
  if (!reference.startsWith(PREFIX)) throw new Error('Unsupported decision pattern artifact reference');
  const parts = reference.slice(PREFIX.length).split('/');
  if (parts.length !== 3) throw new Error('Malformed decision pattern artifact reference');
  const [patternId, patternVersion, rawKind] = parts;
  if (!PATTERNS.has(patternId as DecisionPatternId) || !/^\d+\.\d+\.\d+$/.test(patternVersion ?? '') || !KINDS.has(rawKind as PatternArtifactKind)) throw new Error('Malformed decision pattern artifact reference');
  const id = patternId as DecisionPatternId;
  const kind = rawKind as PatternArtifactKind;
  return { schema: 'decision-pattern-artifact/v1', patternId: id, patternVersion: patternVersion!, kind,
    mediaType: kind === 'readme' ? 'text/markdown' : 'application/json', content: artifactContent(id, patternVersion!, kind) };
}

function artifactContent(id: DecisionPatternId, version: string, kind: PatternArtifactKind): JsonValue | string {
  const identity = { patternId: id, patternVersion: version };
  switch (kind) {
    case 'definition': return { apiVersion: 'decision.aiwg.io/v1alpha2', kind: 'DecisionDefinition', metadata: identity, spec: { primitive: primitiveFor(id), evidenceOnly: true } };
    case 'input-schema': return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: `${id} offline input`, type: 'object', additionalProperties: true };
    case 'output-schema': return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: `${id} recorded evidence`, type: 'object', additionalProperties: true };
    case 'candidate-policy': return { ...identity, authority: 'deterministic-code', evidenceMayExpandCandidates: false, actionsExecute: false };
    case 'ruleset': return { apiVersion: 'decision.aiwg.io/v1alpha2', kind: 'DecisionRuleset', metadata: identity, spec: { denyOverridesEvidence: true, reviewOnAbstention: true } };
    case 'offline-binding': return { ...identity, mode: 'offline-recorded', adapter: 'sanitized-fixture', networkAllowed: false, credentialRequired: false };
    case 'live-binding-template': return { ...identity, mode: 'live', enabled: false, explicitOptInRequired: true, syntheticOnly: true, credentialRef: 'typesafe:jev/playground', limits: { maxCalls: 2, maxTokens: 2048, maxCostUsd: 0.05, allowUnknownCost: false, maxAttempts: 1, deadlineMs: 15_000 } };
    case 'expected-receipt': return { schema: 'decision-pattern-receipt/v1', pattern: identity, executionMode: 'offline-recorded', evidenceOrigin: 'sanitized-recorded-fixture', attempts: 0, action: { status: 'unexecuted' } };
    case 'readme': return `# ${id}\n\nRecorded evidence is illustrative, not qualification, universal calibration, permission, or proof of deterministic model behavior. Failures abstain or route to review. Disable ${id}@${version} from discovery and retain receipts.\n`;
  }
}

function primitiveFor(id: DecisionPatternId): string {
  if (id === 'ordinal-scoring') return 'ordinal-score';
  if (id === 'rag-screen' || id === 'same-subject-batch' || id === 'dependent-two-stage' || id === 'durable-review') return 'composite';
  if (id === 'guardrails') return 'truth-probability';
  return 'choice';
}
