import type { JsonValue } from '../types.js';

export const DECISION_PATTERN_PACK_VERSION = 'decision-pattern-pack/v1' as const;

export type DecisionPatternId =
  | 'intent-routing' | 'rag-screen' | 'citation-support' | 'guardrails'
  | 'tool-risk-preflight' | 'bounded-classification' | 'ordinal-scoring'
  | 'function-selection' | 'same-subject-batch' | 'dependent-two-stage'
  | 'durable-review' | 'candidate-selection';

export type PatternSupport = 'supported' | 'experimental' | 'unavailable' | 'unknown';

export interface PatternArtifactSet {
  definitions: string[];
  inputSchema: string;
  outputSchema: string;
  candidatePolicy: string;
  ruleset: string;
  offlineBinding: string;
  liveBindingTemplate?: string;
  expectedReceipt: string;
  readme: string;
}

export type PatternArtifactKind =
  | 'definition' | 'input-schema' | 'output-schema' | 'candidate-policy'
  | 'ruleset' | 'offline-binding' | 'live-binding-template' | 'expected-receipt'
  | 'readme';

export interface ResolvedPatternArtifact {
  schema: 'decision-pattern-artifact/v1';
  patternId: DecisionPatternId;
  patternVersion: string;
  kind: PatternArtifactKind;
  mediaType: 'application/json' | 'text/markdown';
  content: JsonValue | string;
}

export interface PatternFixture {
  id: string;
  subjectId: string;
  input: Record<string, JsonValue>;
  recordedEvidence: Record<string, JsonValue>;
  expected: { route: 'accept' | 'review' | 'deny' | 'unavailable'; reason: string };
}

export interface DecisionPatternPack {
  schema: typeof DECISION_PATTERN_PACK_VERSION;
  id: DecisionPatternId;
  version: string;
  status: PatternSupport;
  summary: string;
  primitive: 'choice' | 'ordinal-score' | 'truth-probability' | 'composite';
  artifacts: PatternArtifactSet;
  fixtures: PatternFixture[];
  limitations: string[];
  failurePath: string;
  rollback: string;
  live?: {
    syntheticOnly: true;
    credentialRef: string;
    requiredEgressClass: string;
    limits: { maxCalls: number; maxTokens: number; maxCostUsd: number; allowUnknownCost: false; maxAttempts: number; deadlineMs: number };
  };
}

export interface PatternReceipt {
  schema: 'decision-pattern-receipt/v1';
  pattern: { id: DecisionPatternId; version: string };
  fixtureId: string;
  subjectId: string;
  executionMode: 'offline-recorded';
  evidenceOrigin: 'sanitized-recorded-fixture';
  primitive: DecisionPatternPack['primitive'];
  requestedModel: 'offline-fixture';
  actualModel: null;
  uncertainty: {
    provenance: 'recorded-uncalibrated';
    calibration: 'unavailable';
    distribution: Record<string, number> | null;
  };
  route: PatternFixture['expected']['route'];
  reason: string;
  attempts: 0;
  usage: { inputTokens: null; outputTokens: null; costUsd: null; availability: 'unavailable' };
  action: { status: 'unexecuted'; candidate: string | null };
  checks: string[];
}

export interface LivePatternRequest {
  /** The runner accepts synthetic state only; callers cannot override this invariant. */
  synthetic: true;
  input: Record<string, JsonValue>;
}

export interface LivePatternObservation {
  requestedModel: string;
  actualModel: string;
  output: Record<string, JsonValue>;
  /** Total provider calls made by the supplied adapter for this probe. */
  calls: number;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
}

export interface LivePatternReceipt {
  schema: 'decision-pattern-live-receipt/v1';
  pattern: { id: DecisionPatternId; version: string };
  executionMode: 'live';
  evidenceOrigin: 'live-synthetic';
  requestedModel: string;
  actualModel: string;
  calls: number;
  attempts: number;
  usage: LivePatternObservation['usage'];
  deadlineMs: number;
  action: { status: 'unexecuted' };
  output: Record<string, JsonValue>;
}

export interface PatternDrillReceipt {
  schema: 'decision-pattern-operational-drill/v1';
  drillId: string;
  runbookId: string;
  scenario: string;
  observedContainment: string;
  expectedContainment: string;
  passed: boolean;
  evidence: readonly string[];
  action: { status: 'unexecuted' };
}

export interface LivePatternPlan {
  mode: 'live';
  status: 'ready' | 'skipped' | 'denied';
  reason: 'ready' | 'explicit-opt-in-required' | 'credential-unavailable' | 'egress-denied' | 'live-binding-unavailable';
  credentialRef: string | null;
  limits: DecisionPatternPack['live'] extends infer _T ? { maxCalls: number; maxTokens: number; maxCostUsd: number; allowUnknownCost: false; maxAttempts: number; deadlineMs: number } | null : never;
  executes: false;
}
