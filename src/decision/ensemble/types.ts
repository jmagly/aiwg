import type { AliasDriftEvent } from '../calibration/types.js';
import type { QualificationIntegrityMetadata } from '../qualification/release.js';

/** D17 contract slice. None of these records enables ensemble, shadow or drift runtime. */
export type EnsembleDigest = `sha256:${string}`;
export type EnsemblePrimitive = 'choice' | 'truth-probability' | 'ordinal-score';
export type EnsembleMemberType = 'model-version' | 'provider-backend' | 'repeated-sample' | 'prompt-adapter';
export type EnsembleAggregationAlgorithm = 'majority-v1' | 'mean-probability-v1' | 'score-distribution-mean-v1' | 'score-median-v1';
export type EnsembleDisagreementMetric = 'vote-share-v1' | 'normalized-entropy-v1' | 'jensen-shannon-v1' | 'score-dispersion-v1';
export type EnsembleTieRule = 'lowest-canonical-value' | 'defer' | 'review';
export type EnsembleDeferRoute = 'defer' | 'review';
export type IntegrityGateDecision = 'PROMOTE' | 'HOLD' | 'ROLLBACK';

export interface EnsemblePin { id: string; version: string; digest: EnsembleDigest }
export interface EnsembleCalibrationPin { artifactId: string; artifactDigest: EnsembleDigest }

export interface EnsembleMember {
  id: string;
  memberType: EnsembleMemberType;
  definition: EnsemblePin;
  binding: EnsemblePin;
  adapter: { id: string; version: string };
  model: { provider: string; backend: string; requested: string; pinnedVersion: string };
  primitive: EnsemblePrimitive;
  uncertaintyProfile: string;
  requiredCapabilities: string[];
  /** Capabilities the pinned binding declares; they are checked before any adapter could be called. */
  capabilities: string[];
  calibration: EnsembleCalibrationPin | null;
  samples: number;
  fallbackDepth: number;
  /** Conservative host estimates, mirroring GraphBudgetLedger reservations. */
  estimate: { attemptsPerSample: number; tokensPerAttempt: number; costMicrosPerAttempt: number | null; deadlineMsPerAttempt: number };
  /** Required for prompt/adapter variants, which are only members when explicitly approved. */
  approvalReference: string | null;
}

export interface EnsembleCeilings {
  members: number; attempts: number; deadlineMs: number; tokens: number; costMicros: number;
  concurrency: number; fallbackDepth: number;
}

export interface DecisionEnsemblePolicy {
  schemaVersion: 'decision-ensemble-policy/v1';
  id: string;
  version: string;
  mode: 'disabled' | 'offline-shadow' | 'advisory';
  riskTiers: string[];
  definition: EnsemblePin;
  primitive: EnsemblePrimitive;
  options?: string[];
  levels?: number;
  compatibleUncertaintyProfiles: string[];
  requiredCapabilities: string[];
  members: EnsembleMember[];
  aggregation: { algorithm: EnsembleAggregationAlgorithm; tieRule: EnsembleTieRule };
  disagreement: { metric: EnsembleDisagreementMetric; thresholdBps: number; onExceeded: EnsembleDeferRoute };
  acceptance: { minimumSuccessfulMembers: number; onInsufficientMembers: EnsembleDeferRoute; highAgreementWarningBps: number };
  calibration: { requirement: 'advisory' | 'required' };
  ceilings: EnsembleCeilings & {
    unknownCost: { rule: 'reject' } | { rule: 'reserve-bound'; boundMicrosPerAttempt: number };
  };
}

export interface EnsembleReservation { memberId: string; sampleIndex: number; attempts: number; tokens: number; costMicros: number }
export interface EnsembleBudgetPlan {
  effective: EnsembleCeilings;
  demand: EnsembleCeilings;
  /** All-or-nothing estimates in the GraphBudgetLedger `{ attempts, tokens, costMicros }` shape. */
  reservations: EnsembleReservation[];
}

export interface EnsembleMemberResult {
  memberId: string;
  sampleIndex: number;
  status: 'succeeded' | 'failed' | 'abstained';
  /** Digest of the member's complete, separately retained DecisionResult/attempt lineage. */
  resultDigest: EnsembleDigest;
  value: string | number | null;
  distribution: Readonly<Record<string, number>> | null;
  uncertaintyProfile: string | null;
}

export type EnsembleWarning =
  | 'high-agreement-not-correctness' | 'shared-systematic-error-risk'
  | 'member-failures-present' | 'uncalibrated-members';

/** Derived stability evidence. Deliberately has no calibrated-probability or correctness field. */
export interface DecisionEnsembleAggregate {
  schemaVersion: 'decision-ensemble-aggregate/v1';
  policy: { id: string; version: string; digest: EnsembleDigest };
  primitive: EnsemblePrimitive;
  algorithm: { id: EnsembleAggregationAlgorithm; version: string };
  semantics: 'stability-signal-not-correctness';
  provenance: 'derived';
  members: Array<{ memberId: string; sampleIndex: number; status: EnsembleMemberResult['status']; resultDigest: EnsembleDigest; value: string | number | null }>;
  counts: { declared: number; succeeded: number; failed: number; abstained: number };
  outcome: {
    disposition: 'accept' | EnsembleDeferRoute;
    value: string | number | null;
    reason: 'aggregated' | 'tie' | 'disagreement-exceeded' | 'insufficient-members';
    tie: boolean;
    tieRule: EnsembleTieRule | null;
  };
  statistics: {
    votes: Record<string, number> | null;
    meanProbability: number | null;
    meanDistribution: Record<string, number> | null;
    meanScore: number | null;
    medianScore: number | null;
    dispersion: number | null;
  };
  disagreement: { metric: { id: EnsembleDisagreementMetric; version: string }; valueBps: number; thresholdBps: number; exceeded: boolean };
  warnings: EnsembleWarning[];
  correctnessGate: { status: 'not-satisfied'; reason: 'agreement-is-not-correctness-evidence' };
  digest: EnsembleDigest;
}

export type PairedMetric = 'quality' | 'calibration' | 'risk-coverage' | 'abstention' | 'latency' | 'tokens' | 'cost' | 'slice';
export interface PairedMetricThreshold { metric: PairedMetric; comparison: 'delta-at-least' | 'delta-at-most'; bound: number; minimumPairs: number }
export interface ChampionChallengerRolePin {
  identityDigest: EnsembleDigest;
  actualModel: string;
  binding: EnsemblePin;
  adapter: { id: string; version: string };
  calibration: EnsembleCalibrationPin | null;
  ensemblePolicy: EnsemblePin | null;
}

export interface DecisionChampionChallenger {
  schemaVersion: 'decision-champion-challenger/v1';
  id: string;
  alias: string;
  champion: ChampionChallengerRolePin & { aliasRevision: number };
  challenger: ChampionChallengerRolePin;
  inputSet: { id: string; digest: EnsembleDigest; itemCount: number; frozenAt: string; purpose: 'shadow' | 'held-out' };
  pairedMetrics: PairedMetricThreshold[];
  preregistration: { thresholdsDigest: EnsembleDigest; registeredAt: string; holdoutAccessedAt: string | null };
  /** D09 `PromotionEligibility.id`; D17 never creates a parallel eligibility record. */
  eligibilityId: string;
  evaluationIntegrityReport: { id: string; digest: EnsembleDigest };
  approval: { reference: string; approvedAt: string };
  /** Must be the exact champion alias revision, as D09 `promoteAlias` requires. */
  rollbackTarget: { aliasRevision: number; identityDigest: EnsembleDigest };
}

export interface PairedDeltaObservation { metric: PairedMetric; delta: number | null; pairs: number }

export interface DecisionEnsembleIntegrityReport {
  schemaVersion: 'decision-ensemble-integrity-report/v1';
  subject: { kind: 'champion-challenger'; id: string; digest: EnsembleDigest; eligibilityId: string };
  /** The #2037/#2048 integrity fields, carried unchanged. */
  integrity: QualificationIntegrityMetadata;
  pairedDeltas: Array<PairedMetricThreshold & { delta: number | null; pairs: number; passed: boolean }>;
  findings: string[];
  upstreamDecision: IntegrityGateDecision;
  decision: IntegrityGateDecision;
  digest: EnsembleDigest;
}

export type DriftSource = 'alias-drift' | 'output-distribution' | 'label-drift';
export type DriftMetric = 'identity-change' | 'jensen-shannon-v1' | 'population-stability-index-v1' | 'label-error-rate-delta-v1' | 'calibration-error-delta-v1';
export type DriftResponseAction = 'alert' | 'reduce-coverage' | 'route-to-review' | 'disable-challenger' | 'restore-champion' | 'require-recertification';
export interface DriftResponseRule { id: string; source: DriftSource; metric: DriftMetric; thresholdBps: number | null; response: DriftResponseAction }

export interface DecisionDriftResponse {
  schemaVersion: 'decision-drift-response/v1';
  id: string;
  version: string;
  alias: string;
  thresholds: { version: string; digest: EnsembleDigest; registeredAt: string };
  window: { kind: 'observations' | 'duration-ms'; size: number; minimumSamples: number };
  rules: DriftResponseRule[];
  insufficientSamplesResponse: DriftResponseAction;
}

export type DriftSignal =
  | { source: 'alias-drift'; event: AliasDriftEvent }
  | { source: 'output-distribution' | 'label-drift'; id: string; alias: string; metric: DriftMetric;
    valueBps: number; sampleN: number; thresholdsVersion: string; observedAt: string };

export interface DriftResponseDecision {
  schemaVersion: 'decision-drift-response-decision/v1';
  policy: { id: string; version: string; thresholdsVersion: string };
  signalId: string;
  source: DriftSource;
  metric: DriftMetric;
  ruleId: string | null;
  state: 'breached' | 'within-threshold' | 'insufficient-samples';
  /** Unlabeled distribution drift is a warning, not direct evidence of quality loss. */
  evidence: 'identity-change' | 'unlabeled-distribution-warning' | 'labeled-quality';
  response: DriftResponseAction | null;
}
