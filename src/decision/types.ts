import type {
  ContextActualUsageEvidence,
  ContextPlan,
  ContextPlanInput,
  ContextProviderProfile,
  ContextTokenEstimator,
} from './context-plan.js';
import type { ContextQualification } from './context-qualification.js';
import type { BatchResultReference } from './batch-receipts/receipt.js';
import type { BatchResultStore } from './batch-receipts/result-store.js';
import type { BatchReceiptStore, PriceCatalogRecord } from './batch-receipts/types.js';
import type { CalibrationRegistry } from './calibration/registry.js';
import type { CalibrationIdentity, CompatibilityDecision, CompatibilityPolicy } from './calibration/types.js';
import type {
  CompileCacheIdentity,
  CompileCacheReadContext,
  CompileCacheResult,
  ProviderPrefixEvidence,
  ProviderPrefixIdentity,
} from './compile-cache/types.js';
import type { ProviderPrefixReport } from './compile-cache/prefix.js';
import type { DecisionTelemetryContext, DecisionTelemetryHook } from './telemetry/types.js';
import type { DecisionTelemetryIdSource } from './telemetry/context.js';
import type { DecisionProjectionEvidence, DecisionProjectionPolicy } from './projection.js';
import type { DecisionResultCache, ResultCacheActor, ResultCacheCallerReceipt,
  ResultCachePolicy, ResultCacheSemanticIdentity } from './result-cache/index.js';

export const DECISION_API_VERSION = 'decision.aiwg.io/v1alpha1' as const;
export const DECISION_API_VERSION_STRUCTURED = 'decision.aiwg.io/v1alpha2' as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
/** Portable, bounded JSON semantic entry. Admission limits are enforced at runtime. */
export type EntryType = JsonValue;
export type EntryInstruction = string | EntryType[] | { [key: string]: EntryType };
export type JsonSchema = Record<string, unknown>;

export interface ArtifactMetadata {
  id: string;
  version: string;
  description: string;
}

export interface ArtifactPin {
  id: string;
  version: string;
  digest: `sha256:${string}`;
}

export type DecisionAnswer =
  | { kind: 'choice'; options: Array<{ id: string; description: EntryType }> }
  | { kind: 'ordinal-score'; levels: EntryType[] }
  | { kind: 'truth-probability'; trueDescription: EntryType; falseDescription: EntryType };

export interface DecisionDefinition {
  apiVersion: typeof DECISION_API_VERSION | typeof DECISION_API_VERSION_STRUCTURED;
  kind: 'DecisionDefinition';
  metadata: ArtifactMetadata;
  spec: {
    purpose: string;
    inputSchema: JsonSchema;
    question: EntryInstruction;
    answer: DecisionAnswer;
    requiredCapabilities: string[];
  };
}

export interface PredicateSource {
  source: 'input' | 'decision';
  alias?: string;
  pointer: string;
}

export type DecisionPredicate =
  | { op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; left: PredicateSource; right: JsonValue }
  | { op: 'exists'; left: PredicateSource }
  | { all: DecisionPredicate[] }
  | { any: DecisionPredicate[] }
  | { not: DecisionPredicate };

export interface DecisionRuleset {
  apiVersion: typeof DECISION_API_VERSION | typeof DECISION_API_VERSION_STRUCTURED;
  kind: 'DecisionRuleset';
  metadata: ArtifactMetadata;
  spec: {
    purpose: string;
    inputSchema: JsonSchema;
    evaluations: Array<{ alias: string; decision: ArtifactPin; inputPointer: string }>;
    rules: Array<{ id: string; priority: number; when: DecisionPredicate; outcome: JsonValue }>;
    composition: 'first-match' | 'collect';
    conflict: 'error' | 'review';
    defaultOutcome: JsonValue;
    failureOutcome: JsonValue;
    outputSchema: JsonSchema;
  };
}

export type DecisionFailureReason =
  | 'none' | 'invalid-input' | 'invalid-definition' | 'digest-mismatch'
  | 'unauthorized' | 'data-boundary-denied' | 'unsupported-capability'
  | 'executor-unavailable' | 'invalid-output' | 'low-confidence'
  | 'missing-confidence' | 'confidence-profile-mismatch'
  | 'insufficient-information' | 'timeout' | 'network-transient'
  | 'rate-limited' | 'overloaded' | 'service-error' | 'authentication'
  | 'invalid-request' | 'budget-exhausted' | 'cancelled'
  | 'persistence-error' | 'replay-mismatch' | 'execution-uncertain'
  | 'no-match' | 'conflicting-outcomes' | 'evaluation-failed';

export type AcceptanceDisposition = 'act' | 'review' | 'reject' | 'fallback';
export type AcceptanceMetric =
  | 'yes-probability' | 'selected-probability' | 'native-confidence'
  | 'top-two-margin' | 'entropy' | 'concentration'
  | 'expected-score' | 'dispersion' | 'calibrated-risk';

export interface AcceptanceRoute {
  disposition: AcceptanceDisposition;
  /** Required for a declared fallback and otherwise prohibited by validation. */
  fallbackTarget?: string;
}

export interface AcceptanceCondition {
  metric: AcceptanceMetric;
  op: 'lt' | 'lte' | 'gt' | 'gte' | 'between' | 'outside';
  /** Probability-normalized basis points. Inclusive for `between`. */
  thresholdBps?: number;
  minimumBps?: number;
  maximumBps?: number;
}

export interface PrimitiveAcceptancePolicy {
  mode: 'primitive-policy';
  version: string;
  /** Explicit allow-list; prevents applying one backend's uncertainty semantics to another. */
  compatibleUncertaintyProfiles: string[];
  /** Ordered rules make overlapping gray bands explicit and deterministic. */
  precedence: 'first-match';
  calibration: 'advisory' | 'required';
  rules: Array<{
    id: string;
    primitive: DecisionAnswer['kind'];
    all: AcceptanceCondition[];
    route: AcceptanceRoute;
  }>;
  defaultRoute: AcceptanceRoute;
  missingEvidenceRoute: AcceptanceRoute;
  invalidEvidenceRoute: AcceptanceRoute;
  tieRoute: AcceptanceRoute;
  /** Choice policies may require explicit `none`, `other`, or project-defined options. */
  requiredOptions?: string[];
}

export interface ExecutionTarget {
  adapter: 'jev' | 'llm-subagent';
  adapterVersion: string;
  model: string;
  subagent?: ArtifactPin;
  credentialRef?: string;
  requiredCapabilities: string[];
  acceptance:
    | { mode: 'typed-value' }
    | { mode: 'confidence-threshold'; profile: string; minimumBps: number }
    | PrimitiveAcceptancePolicy;
  timeoutMs: number;
  retry: { maxRetries: number; initialDelayMs: number; maxDelayMs: number };
}

export interface DecisionBinding {
  apiVersion: typeof DECISION_API_VERSION | typeof DECISION_API_VERSION_STRUCTURED;
  kind: 'DecisionBinding';
  metadata: ArtifactMetadata;
  spec: {
    ruleset: ArtifactPin;
    totalTimeoutMs: number;
    maxAttempts: number;
    concurrency: number;
    evaluations: Record<string, { targets: ExecutionTarget[]; fallbackOn: DecisionFailureReason[] }>;
  };
}

export interface DecisionUncertainty {
  source: 'provider' | 'model-self-report' | 'derived';
  profile: string;
  calibration: 'vendor-claimed' | 'uncalibrated' | 'measured';
  confidence: number | null;
  distribution: Record<string, number> | null;
  calibrationRef: string | null;
  /** Derived calibrated risk remains separate from raw provider uncertainty. */
  calibratedRisk?: { value: number; calibrationRef: string };
}

export interface DecisionAcceptanceEvidence {
  policyVersion: string;
  uncertaintyProfile: string | null;
  disposition: AcceptanceDisposition;
  matchedRule: string | null;
  fallbackTarget?: string;
  reason: 'matched' | 'default' | 'missing-evidence' | 'invalid-evidence' | 'tie' | 'calibration-required';
  values: Partial<Record<AcceptanceMetric, {
    value: number;
    normalizedBps: number;
    provenance: 'provider-value' | 'provider-confidence' | 'provider-distribution' | 'derived' | 'calibrated';
    calibrationRef: string | null;
  }>>;
}

export interface DecisionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface DecisionAttempt {
  ordinal: number;
  adapter: string;
  adapterVersion: string;
  requestedModel: string;
  actualModel: string | null;
  subagent: ArtifactPin | null;
  status: DecisionStatus;
  reason: DecisionFailureReason;
  durationMs: number;
  usage: DecisionUsage;
  requestId: string | null;
  /** Source of an accepted, sanitized provider correlation ID. */
  requestIdSource?: 'typesafe' | 'legacy' | 'body';
  httpStatus?: number;
  retryDelayMs?: number;
  termination?: 'caller-cancelled' | 'target-timeout' | 'total-deadline' | 'backend-cancelled';
  /** Remote execution and billing are uncertain after a dispatched cancellation or timeout. */
  remoteExecution?: 'unknown';
  batch?: DecisionBatchEvidence;
  /** Bounded, metadata-only scheduler/admission evidence. Never contains inputs or principal IDs. */
  admission?: DecisionAdmissionEvidence;
  /** Sanitized provider-authoritative prefix-cache evidence; never a raw cache handle. */
  providerPrefix?: ProviderPrefixEvidence;
}

export type DecisionAdmissionReason =
  | 'admitted' | 'disabled' | 'cancelled' | 'deadline-exceeded'
  | 'concurrency' | 'requests-per-minute' | 'tokens-per-second'
  | 'attempts' | 'batch-size' | 'cost' | 'unknown-cost'
  | 'queue-full' | 'queue-timeout' | 'invalid-estimate' | 'request-too-large' | 'too-many-items'
  | 'retained-work' | 'unknown-retained-work'
  | 'retry-after' | 'circuit-open' | 'unconfigured-provider';

export interface DecisionAdmissionEvidence {
  decision: 'admit' | 'defer' | 'reject';
  reason: DecisionAdmissionReason;
  queueDelayMs: number;
  active: number;
  queued: number;
  estimatedTokens: number | null;
  estimatedCostUsd: number | null;
  retryPressure: number;
  breakerState: 'closed' | 'open' | 'half-open';
  /** Bounded hint only; it is intentionally jittered by the controller. */
  retryAfterMs?: number;
  /** Breaker transitions caused by admitting or releasing this attempt, in order. */
  breakerTransitions?: DecisionBreakerTransition[];
}

export interface DecisionBreakerTransition {
  from: 'closed' | 'open' | 'half-open';
  to: 'closed' | 'open' | 'half-open';
}

export interface DecisionAdmissionLimits {
  concurrency: number;
  requestsPerMinute?: number;
  tokensPerSecond?: number;
  maxAttempts?: number;
  maxBatchSize?: number;
  maxCostUsd?: number;
  allowUnknownCost?: boolean;
  maxQueueLength?: number;
  maxQueueWaitMs?: number;
  maxRequestBytes?: number;
  maxItems?: number;
  /** Maximum work units the host may retain for this request. */
  maxRetainedWork?: number;
  circuitBreaker?: { failureThreshold: number; openMs: number; halfOpenMaxCalls: number };
  /**
   * Principal limits only: workspace and provider permits held back for this
   * principal. Other principals cannot take them while they are unused.
   */
  reservedConcurrency?: number;
  /**
   * Workspace or provider limits only: the fraction (0, 1] of this pool's
   * concurrency and queue length that one principal may hold.
   */
  maxPrincipalShare?: number;
}

export interface DecisionAdmissionEstimate {
  tokens?: number;
  costUsd?: number | null;
  requestBytes?: number;
  items?: number;
  attempts?: number;
  batchSize?: number;
  /** Host-computed retained work units; required when a retained-work quota is configured. */
  retainedWork?: number;
}

export interface DecisionSchedulerPolicy {
  /** Conservative default: scheduling and admission are inert unless enabled. */
  enabled: boolean;
  /** Operator-pinned profile revision used for rollout and rollback. */
  profileVersion: string;
  callerConcurrency?: number;
  graphConcurrency?: number;
  workspace: { id: string; limits: DecisionAdmissionLimits };
  /** Must be supplied from authenticated host context, never decision input/model output. */
  principal: { id: string; limits: DecisionAdmissionLimits };
  providers: Record<string, DecisionAdmissionLimits>;
  estimate?: (alias: string, target: ExecutionTarget, input: unknown) => DecisionAdmissionEstimate;
  onEvidence?: (alias: string, evidence: DecisionAdmissionEvidence) => void;
}

export type DecisionStatus = 'success' | 'abstained' | 'error' | 'unsupported' | 'cancelled';

export interface DecisionResult {
  apiVersion: typeof DECISION_API_VERSION | typeof DECISION_API_VERSION_STRUCTURED;
  kind: 'DecisionResult';
  metadata: ArtifactMetadata;
  spec: {
    decision: ArtifactPin;
    ruleset: ArtifactPin;
    binding: ArtifactPin;
    alias: string;
    runId: string;
    invocationId: string;
    status: DecisionStatus;
    value?: string | number;
    reason: DecisionFailureReason;
    uncertainty: DecisionUncertainty | null;
    acceptance?: DecisionAcceptanceEvidence;
    /** Immutable compatibility decision applied before calibrated acceptance evidence was consumed. */
    calibrationCompatibility?: CompatibilityDecision;
    attempts: DecisionAttempt[];
    /** Reference-only link to the durable owner of shared batch transport accounting. */
    batchResult?: BatchResultReference;
    /** Body-free evidence for the context assumptions governing this dispatch. */
    context?: DecisionContextEvidence;
  };
}

export interface RulesetResult {
  apiVersion: typeof DECISION_API_VERSION | typeof DECISION_API_VERSION_STRUCTURED;
  kind: 'RulesetResult';
  metadata: ArtifactMetadata;
  spec: {
    ruleset: ArtifactPin;
    binding: ArtifactPin;
    runId: string;
    invocationId: string;
    status: 'completed' | 'defaulted' | 'review' | 'error' | 'cancelled';
    reason: DecisionFailureReason;
    outcome?: JsonValue;
    matchedRules: string[];
    evaluations: Record<string, DecisionResult>;
    /** Caller-level cache receipt. Historical evaluation attempts in a hit belong to the source. */
    cache?: ResultCacheCallerReceipt;
    /** Invocation-wide context plan plus immutable estimate-versus-actual evidence. */
    context?: DecisionContextEvidence;
  };
}

export interface AdapterCapabilities {
  answerKinds: DecisionAnswer['kind'][];
  features: string[];
  maxOptions: number | null;
  maxLevels: number | null;
  confidenceProfiles: string[];
  executable: boolean;
  /** Native shared-state batching is optional and must be atomic. */
  batch?: {
    native: boolean;
    atomic: true;
    /** Opaque adapter/configuration identity for host and transport policy. */
    executionEnvelope: string;
  };
}

export interface AdapterObservation {
  status: DecisionStatus;
  reason: DecisionFailureReason;
  value?: string | number;
  uncertainty: DecisionUncertainty | null;
  acceptance?: DecisionAcceptanceEvidence;
  actualModel: string | null;
  usage: DecisionUsage;
  requestId: string | null;
  /** Whether an HTTP exchange proves dispatch state for receipt retry safety. */
  dispatchCertainty?: 'not-sent' | 'terminal-response' | 'unknown';
  requestIdSource?: 'typesafe' | 'legacy' | 'body';
  httpStatus?: number;
  termination?: DecisionAttempt['termination'];
  remoteExecution?: 'unknown';
  /** Transport hint used only by the dispatcher; never persisted as decision data. */
  retryAfterMs?: number;
  /** Local scheduler evidence; adapters must not populate identity-bearing fields. */
  admission?: DecisionAdmissionEvidence;
  /** Transport metadata reported by the provider. The evaluator validates and sanitizes it. */
  providerPrefixReport?: ProviderPrefixReport;
  /** Evaluator-derived, sanitized evidence persisted on the attempt. */
  providerPrefix?: ProviderPrefixEvidence;
}

export interface DecisionAdapterRequest {
  alias: string;
  definition: DecisionDefinition;
  input: unknown;
  target: ExecutionTarget;
  invocationId: string;
  deadlineEpochMs: number;
  signal: AbortSignal;
  /** Original caller signal, distinct from a composed total-deadline signal. */
  callerSignal?: AbortSignal;
  /** Caller plus total deadline, before the evaluator adds the per-target timer. */
  totalSignal?: AbortSignal;
  resolveCredential: (logicalRef: string) => Promise<Uint8Array>;
  /** Persist an opaque remote handle before the adapter reports completion. */
  onRemoteHandle?: (handle: string) => Promise<void>;
  /** Stable opaque provider correlation key; defaults to alias for single calls. */
  questionId?: string;
  /**
   * Immutable backend preparation produced by the adapter's compile hook. The
   * evaluator obtains this through the same hook with and without caching so
   * enabling the cache cannot change provider request semantics.
   */
  compiledArtifact?: JsonValue;
  /** Metadata-only evidence that host-authorized projection preceded dispatch. */
  projectionEvidence?: DecisionProjectionEvidence;
}

export interface DecisionRuntimeProjectionPolicy {
  /** Trusted host callback. Portable artifacts and model-visible state cannot supply this policy. */
  resolve(input: {
    alias: string;
    target: ExecutionTarget;
  }): DecisionProjectionPolicy;
  incompleteContext?: boolean;
  onEvidence?: (input: { alias: string; evidence: DecisionProjectionEvidence }) => void;
  /** Optional host-only encrypted debug sink. Receives ONLY projected state, never ambient input. */
  debugCapture?: {
    scope: string;
    capture(scope: string, plaintext: Uint8Array): Promise<string>;
  };
}

export interface DecisionAdapterCompileRequest {
  definition: DecisionDefinition;
  target: ExecutionTarget;
}

export interface DecisionAdapterBatchRequest {
  requests: DecisionAdapterRequest[];
  decisionSubject: string;
}

export interface DecisionAdapterBatchObservation {
  /** An array is deliberate: duplicate IDs remain detectable and fail closed. */
  answers: Array<{ questionId: string; observation: AdapterObservation }>;
  sharedUsage: DecisionUsage;
}

export interface DecisionAdapter {
  readonly id: string;
  readonly version: string;
  capabilities(): Promise<AdapterCapabilities>;
  /** Compile stable definition/adapter material; must not resolve credentials or dispatch. */
  compile?(request: DecisionAdapterCompileRequest): Promise<JsonValue>;
  evaluate(request: DecisionAdapterRequest): Promise<AdapterObservation>;
  evaluateMany?(request: DecisionAdapterBatchRequest): Promise<DecisionAdapterBatchObservation>;
}

export interface DecisionCompileCacheStore {
  getOrCompile(
    identity: CompileCacheIdentity,
    context: CompileCacheReadContext,
    ttlMs: number,
    compile: () => Promise<JsonValue>,
    options?: { bypass?: boolean },
  ): Promise<CompileCacheResult<JsonValue>>;
}

export interface DecisionCompileCachePolicy {
  /** Conservative rollout default: omitted or false always takes the bypass path. */
  enabled: boolean;
  ttlMs: number;
  store: DecisionCompileCacheStore;
  context: CompileCacheReadContext | (() => CompileCacheReadContext);
  identityFor(input: {
    alias: string;
    definition: DecisionDefinition;
    target: ExecutionTarget;
    adapter: DecisionAdapter;
  }): CompileCacheIdentity;
  /** Cache rejection can safely recompile; strict mode instead fails before dispatch. */
  failureMode?: 'recompile' | 'fail';
  onResult?: (input: { alias: string; outcome: CompileCacheResult<JsonValue>['outcome'] }) => void;
}

export interface DecisionProviderPrefixPolicy {
  /** Constructs the complete protected semantic identity after the actual model is known. */
  identityFor(input: {
    request: DecisionAdapterRequest;
    adapter: DecisionAdapter;
    observation: AdapterObservation;
  }): ProviderPrefixIdentity;
  /** Receives sanitized evidence only; raw provider handles are never forwarded. */
  onEvidence?: (input: { alias: string; evidence: ProviderPrefixEvidence }) => void;
}

export interface DecisionBatchEvaluationPolicy {
  /** Canonical record/entity identity. Equal projected JSON alone is insufficient. */
  decisionSubject: string;
  /** Only explicitly independent questions may share a provider request. */
  independent: boolean;
  /** Dependent questions use later ordered stages and never share a stage. */
  stage?: number;
  /** Identity of the already-authorized egress policy, not policy text. */
  egressPolicy: string;
  /** Identity of the trusted host policy governing this execution. */
  hostPolicy: string;
}

export interface DecisionBatchPolicy {
  /** Rollout switch. Native batching remains disabled unless explicitly enabled. */
  enabled: boolean;
  evaluations: Record<string, DecisionBatchEvaluationPolicy>;
}

/** Durable ownership required before a native shared-state dispatch is attempted. */
export interface DecisionBatchReceiptPolicy {
  store: BatchReceiptStore;
  /** Governed value repository used to reconstruct completed batch results on replay. */
  resultStore?: BatchResultStore;
  tenantId: string;
  projectId: string;
  contextPlan: ContextPlan;
  subjectHash: `sha256:${string}`;
  /** Optional reviewed catalog for deriving cost when the provider omits it. */
  priceCatalog?: PriceCatalogRecord;
  /** Conservative per-attempt cost bound when neither provider cost nor a priced usage total exists. */
  unknownCostBound?: { upperBoundMicros: number; policyId: string; policyVersion: string };
  /** Optional invocation-wide cap for durable native batches. Requires unknownCostBound. */
  maxCostMicros?: number;
}

export interface DecisionContextEvidence {
  plan: ContextPlan;
  actualUsage: ContextActualUsageEvidence[];
}

/** Explicit, qualified context preflight. It remains inert unless supplied. */
export interface DecisionContextPolicy {
  input: ContextPlanInput;
  profile: ContextProviderProfile;
  estimator: ContextTokenEstimator;
  /** Optional caller-persisted plan. A stale plan fails closed instead of silently replanning. */
  plan?: ContextPlan;
  /** Observe-only disables native batching; enforce requires a matching provider-backed qualification. */
  rollout?: { mode: 'observe-only' } | { mode: 'enforce'; qualification: ContextQualification };
}

export interface DecisionBatchEvidence {
  mode: 'native' | 'single';
  groupId: string;
  questionId: string;
  degradationReason?: 'disabled' | 'unsupported' | 'ineligible';
}

export type DecisionReceiptState = 'acquired' | 'dispatched' | 'remote-handle-known' | 'observation-received' | 'composed' | 'completed' | 'failed' | 'execution-uncertain';

export interface DecisionReceipt {
  schema: 'decision-receipt/v2';
  revision: number;
  acquiredAtEpochMs: number;
  updatedAtEpochMs: number;
  completedAtEpochMs?: number;
  projectId: string;
  invocationId: string;
  fingerprint: string;
  state: DecisionReceiptState;
  result?: RulesetResult;
  remoteHandles: string[];
  evaluations: Record<string, DecisionResult>;
  pending: { alias: string; targetIndex: number; ordinal: number; attempts: DecisionAttempt[] } | null;
}

export interface DecisionReceiptStore {
  read(invocationId: string, projectId?: string): Promise<DecisionReceipt | null>;
  acquire(invocationId: string, projectId: string, fingerprint: string): Promise<{ owner: boolean; receipt: DecisionReceipt }>;
  compareAndSwap(invocationId: string, projectId: string, expectedRevision: number, next: DecisionReceipt): Promise<boolean>;
  waitForTerminal(invocationId: string, projectId: string, fingerprint: string, signal?: AbortSignal): Promise<DecisionReceipt>;
}

export interface DecisionEvaluationRequest {
  ruleset: DecisionRuleset;
  binding: DecisionBinding;
  definitions: Record<string, DecisionDefinition>;
  input: unknown;
  runId: string;
  invocationId: string;
  adapters: Record<string, DecisionAdapter>;
  resolveCredential?: (logicalRef: string) => Promise<Uint8Array>;
  receiptStore?: DecisionReceiptStore;
  receiptProjectId?: string;
  policyPin?: ArtifactPin | null;
  calibrationPin?: ArtifactPin | null;
  /** Optional fail-closed runtime binding for separately registered calibration evidence. */
  calibrationCompatibility?: {
    registry: CalibrationRegistry;
    policy: CompatibilityPolicy;
    calibrationArtifactId?: string;
    identityFor: (context: {
      alias: string;
      definition: DecisionDefinition;
      target: ExecutionTarget;
      actualModel: string;
    }) => CalibrationIdentity;
  };
  /** Resolve a persisted handle without starting another remote operation. */
  reconcileRemote?: (handle: string, signal: AbortSignal) => Promise<AdapterObservation | null>;
  signal?: AbortSignal;
  now?: () => number;
  /** Uniform [0,1) source for bounded retry jitter. */
  random?: () => number;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  batching?: DecisionBatchPolicy;
  batchReceipts?: DecisionBatchReceiptPolicy;
  context?: DecisionContextPolicy;
  scheduler?: DecisionSchedulerPolicy;
  compileCache?: DecisionCompileCachePolicy;
  /** Experimental, explicit host-owned semantic reuse. Omitted means no result cache lookup. */
  resultCache?: {
    service: DecisionResultCache;
    actor: ResultCacheActor;
    policy: ResultCachePolicy;
    /** Must supply all semantic pins from trusted host state, not from the model or input. */
    identityFor: (context: {
      alias: string; definition: DecisionDefinition; target: ExecutionTarget;
      projectedInput: JsonValue;
    }) => ResultCacheSemanticIdentity;
    /** Registry-backed two-stage check on EVERY alias lookup. False bypasses reuse. */
    verifyAliasSnapshot?: (snapshot: Extract<ResultCacheSemanticIdentity['modelCompatibility'], { mode: 'alias' }>) => Promise<boolean>;
    /** Persist a separate caller-level receipt before releasing the result to the caller. */
    recordCallerReceipt?: (receipt: ResultCacheCallerReceipt) => Promise<void>;
  };
  /** Optional policy for consuming provider-reported prompt-prefix metadata. */
  providerPrefix?: DecisionProviderPrefixPolicy;
  /** Optional trusted host-side state projection boundary. */
  projection?: DecisionRuntimeProjectionPolicy;
  /** Optional metadata-only observability sink. Its failures never affect evaluation. */
  telemetry?: {
    hook: DecisionTelemetryHook;
    /** Optional bounded, allowlisted operational metrics; never an authorization signal. */
    metrics?: import('./telemetry/metrics.js').BoundedDecisionMetrics;
    ids?: DecisionTelemetryIdSource;
    parent?: DecisionTelemetryContext;
  };
}
