import type { AcceptanceDisposition, DecisionAcceptanceEvidence, DecisionAnswer, DecisionEvaluationRequest, DecisionFailureReason, DecisionStatus, DecisionUsage, JsonValue, RulesetResult } from '../types.js';

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
  /** Evaluation alias for a definition artifact. */
  alias?: string;
  mediaType: 'application/json' | 'text/markdown';
  content: JsonValue | string;
}

export interface PatternFixture {
  id: string;
  subjectId: string;
  input: Record<string, JsonValue>;
  /** Sanitized recorded Jev response material: `answers` keyed by ruleset alias, optional request `usage`. */
  recordedEvidence: Record<string, JsonValue>;
  /** Checked against the computed receipt; never used to produce it. */
  expected: { route: PatternRoute; reason: string };
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
    limits: LivePatternLimits;
  };
}

export type PatternRoute = 'accept' | 'review' | 'deny';

/** Per-evaluation evidence copied from the production `RulesetResult`. */
export interface PatternEvaluationEvidence {
  alias: string;
  primitive: DecisionAnswer['kind'];
  status: DecisionStatus;
  reason: DecisionFailureReason;
  value: string | number | null;
  distribution: Record<string, number> | null;
  acceptance: { disposition: AcceptanceDisposition; matchedRule: string | null; reason: DecisionAcceptanceEvidence['reason'] } | null;
  attempts: number;
  /** Per-answer usage. Native batch answers carry null usage; the request owns it. */
  usage: DecisionUsage;
}

export interface PatternGateEvidence {
  gate: 'batch-subject' | 'deterministic-policy' | 'candidate-membership' | 'typed-arguments' | 'durable-replay';
  outcome: 'pass' | 'narrowed' | 'rejected-before-dispatch' | 'not-applicable';
  reason?: string;
}

export interface PatternUsageEvidence {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: null;
  availability: 'recorded' | 'unavailable';
  /** `request` means one shared native-batch request; `attempts` sums individual attempts. */
  scope: 'request' | 'attempts' | null;
}

export interface PatternReceipt {
  schema: 'decision-pattern-receipt/v2';
  pattern: { id: DecisionPatternId; version: string };
  fixtureId: string;
  subjectId: string;
  executionMode: 'offline-recorded';
  evidenceOrigin: 'sanitized-recorded-fixture';
  primitive: DecisionPatternPack['primitive'];
  requestedModel: 'offline:recorded-fixture';
  /** No model served a recorded fixture. */
  actualModel: null;
  runtime: {
    evaluator: 'evaluateDecisionRuleset';
    adapter: 'jev@1.0.0';
    transport: 'recorded-replay';
    /** Evaluator invocations; durable replay invokes the evaluator more than once. */
    invocations: number;
    /** Recorded transport requests actually served. */
    transportCalls: number;
  };
  uncertainty: {
    provenance: 'recorded-uncalibrated';
    calibration: 'unavailable';
    distribution: Record<string, number> | null;
  };
  route: PatternRoute;
  reason: string;
  /** Ruleset outcome before the deterministic gates narrowed it. Null when no evaluation ran. */
  rulesetOutcome: { status: RulesetResult['spec']['status']; route: PatternRoute; reason: string; matchedRules: string[] } | null;
  gates: PatternGateEvidence[];
  evaluations: PatternEvaluationEvidence[];
  attempts: number;
  usage: PatternUsageEvidence;
  action: { status: 'unexecuted'; candidate: string | null };
  checks: string[];
  /** The production result this receipt wraps. Null only when a precondition rejected dispatch. */
  result: RulesetResult | null;
}

export interface LivePatternRequest {
  /** The runner accepts synthetic state only; callers cannot override this invariant. */
  synthetic: true;
  input: Record<string, JsonValue>;
}

export type LivePatternLimits = { maxCalls: number; maxTokens: number; maxCostUsd: number; allowUnknownCost: false; maxAttempts: number; deadlineMs: number };

export interface LivePatternTransport {
  /** Jev HTTP transport. Every call is admitted against the pack limits before it starts. */
  fetch: typeof fetch;
  resolveCredential: (logicalRef: string) => Promise<Uint8Array>;
  /** Host reservation for one dispatch. A null cost is unknown and is never admitted. */
  estimate: (alias: string) => { tokens: number; costUsd: number | null };
  /** Explicit requested model; the template carries no default. */
  model: string;
  /** Optional caller cancellation. */
  signal?: AbortSignal;
  /**
   * Host-owned D10 projection boundary for the Jev dispatch. Required: omitting it
   * denies dispatch as `data-boundary-denied` before credential or transport access.
   */
  projection?: DecisionEvaluationRequest['projection'];
  /** Host-declared Jev deployment region that a projection policy is bound to. */
  region?: string;
}

export interface LivePatternReceipt {
  schema: 'decision-pattern-live-receipt/v2';
  pattern: { id: DecisionPatternId; version: string };
  executionMode: 'live';
  evidenceOrigin: 'live-synthetic';
  requestedModel: string;
  actualModel: string | null;
  /** Transport requests actually started. Admission rejects over-limit calls before they start. */
  calls: number;
  attempts: number;
  limits: LivePatternLimits;
  admission: Array<{ alias: string; decision: 'admit' | 'defer' | 'reject'; reason: string }>;
  usage: { inputTokens: number | null; outputTokens: number | null; reservedTokens: number; reservedCostUsd: number; reportedCostUsd: null };
  /** Caps the provider-reported usage exceeded after the fact; the reservations were not exceeded. */
  limitBreaches: string[];
  deadlineMs: number;
  route: PatternRoute;
  reason: string;
  action: { status: 'unexecuted' };
  result: RulesetResult;
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
  limits: LivePatternLimits | null;
  executes: false;
}
