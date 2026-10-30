import type { GateOutcome } from './lattice.js';
import type { QualificationIntegrityMetadata } from './upstream-ceiling.js';
import type { DecisionPredicate } from '../decision/types.js';

export const GATES_API_VERSION = 'gates.aiwg.io/v1alpha1' as const;

export type Sha256Digest = `sha256:${string}`;

export interface GateMetadata {
  id: string;
  version: string;
  description: string;
}

export interface ArtifactPinLike {
  id: string;
  version: string;
  digest: Sha256Digest;
}

/** A binding/report pin over one gate pack: the authored digest plus the digest of the composed (extends-resolved) pack. */
export interface GatePackPin {
  id: string;
  version: string;
  digest: Sha256Digest;
  resolvedDigest: Sha256Digest;
}

/** A full pin over a parent pack, used for `extends`. The digest covers the parent's authored bytes. */
export interface GateParentPin {
  id: string;
  version: string;
  digest: Sha256Digest;
}

export type GateKind =
  | 'interval-bound' | 'paired-difference' | 'bootstrap-bound' | 'count-max' | 'count-min'
  | 'value-threshold' | 'minimum-n' | 'evidence' | 'predicate' | 'upstream-ceiling';

export type StatisticKind = 'interval-bound' | 'paired-difference' | 'bootstrap-bound';

export type StatisticMethod = 'wilson' | 'clopper-pearson' | 'newcombe' | 'tango' | 'bootstrap';

/** Reference to a named pack parameter, resolved against the binding's preregistered values. */
export interface GateParamRef {
  param: string;
}

export interface GateStatistic {
  kind: StatisticKind;
  method?: StatisticMethod;
  bound?: 'upper' | 'lower';
  levelBps?: number | GateParamRef;
  mode?: 'non-inferiority' | 'superiority';
  marginBps?: number | GateParamRef;
  seed?: number;
  resamples?: number;
  bounds?: readonly [number, number];
  vs?: string;
}

export interface GateThreshold {
  op: 'lte' | 'gte';
  value?: number;
  param?: string;
}

export type GateScopeMode = 'all' | 'each' | 'listed' | 'pooled';

export interface GateScope {
  mode: GateScopeMode;
  slices?: string[];
  except?: string[];
}

export type GateFailOutcome = 'HOLD' | 'ROLLBACK';

export type TighteningDirection = 'lower-is-stricter' | 'higher-is-stricter';

export interface GateDefinition {
  id: string;
  kind: GateKind;
  description?: string;
  metric?: { provider: string; name: string };
  statistic?: GateStatistic;
  threshold?: GateThreshold;
  minimumN?: number | GateParamRef;
  scope: GateScope;
  /** Outcome when the gate fails. Never PROMOTE. */
  onFail: GateFailOutcome;
  /** Outcome when evidence is insufficient. Always HOLD (ROLLBACK needs an observed blocking failure); defaults to HOLD. */
  onInsufficient?: 'HOLD';
  direction: TighteningDirection;
  floor?: boolean;
  evidence?: { required: string[] };
  predicate?: DecisionPredicate;
}

export type ParameterType = 'bps' | 'count' | 'level' | 'value';

export interface GateParameter {
  type: ParameterType;
  direction: TighteningDirection;
  default?: number;
  description?: string;
}

export type MetricKind = 'proportion' | 'paired' | 'scalar' | 'differences' | 'evidence';

export interface GatePack {
  apiVersion: typeof GATES_API_VERSION;
  kind: 'GatePack';
  metadata: GateMetadata;
  spec: {
    extends?: GateParentPin;
    parameters?: Record<string, GateParameter>;
    metrics: Record<string, { provider: string; kind: MetricKind; description?: string }>;
    gates: GateDefinition[];
    combine?: { rule: 'max-severity' };
  };
}

export type ReferenceKind = 'always-review' | 'always-predict' | 'pinned-baseline';

export interface GateReference {
  name: string;
  kind: ReferenceKind;
  baseline?: ArtifactPinLike;
}

/**
 * Qualifies a pack parameter for a binding: `<packId>.<param>`. Parameters are
 * namespaced per pack so two packs declaring the same short name can never
 * collide or silently merge in a binding.
 */
export const qualifyGateParameter = (packId: string, name: string): string => `${packId}.${name}`;

/**
 * Trust-root record for one addon/extension bundle provider, stored in the
 * project config (`aiwg.config` `gates.providers`). Registration requires a
 * matching entry: the bundle id, provider id, isolated code digest and the
 * reviewer identity/timestamp must all match. In-bundle review files are
 * informational only; this allowlist is the authorization.
 */
export interface ProviderAllowlistEntry {
  bundleId: string;
  providerId: string;
  codeDigest: Sha256Digest;
  reviewer: string;
  reviewedAt: string;
}

/** Pin over one metric provider: descriptor digest plus, for bundle providers, the code digest. */
export interface GateProviderPin {
  id: string;
  version: string;
  sourceDigest: Sha256Digest;
  /**
   * Code digest for bundle providers (#2831). Absent for core providers.
   * When the registry provider carries a code digest the pin must match it;
   * a byte change moves the digest, so an old pin refuses until re-pinned.
   */
  codeDigest?: Sha256Digest;
  /**
   * Digest of the input records the provider section is reproduced from
   * (records binding, P4). Required on bundle-provider pins, forbidden on
   * core-provider pins. Evaluation re-runs the pinned provider over records
   * digesting to this value and uses the re-run output; caller-asserted
   * metrics for provider-backed gates are never accepted.
   */
  recordsDigest?: Sha256Digest;
}

export interface GateBinding {
  apiVersion: typeof GATES_API_VERSION;
  kind: 'GateBinding';
  metadata: GateMetadata;
  spec: {
    packs: GatePackPin[];
    /** Parameter values keyed by qualified name (`<packId>.<param>`). */
    parameters: Record<string, number>;
    slices: string[];
    sliceGroups?: Record<string, string[]>;
    references: GateReference[];
    metricProviders: GateProviderPin[];
    ceiling?: GateOutcome;
    registeredAt: string;
    frozenAt: string;
    /**
     * Deprecated and ignored by the evaluator. Holdout timing comes only from
     * the trusted holdout record passed to `evaluateGates`, never from the
     * binding under evaluation.
     */
    holdoutAccessedAt?: string | null;
    splitDigest?: Sha256Digest;
    corpusDigest?: Sha256Digest;
    goldDigest?: Sha256Digest;
  };
}

/**
 * Sealed trusted holdout inputs for one evaluation, derived from the
 * HeldoutFrozen / first-access record — never from the binding. The seal
 * (`digest` over `{frozenDigest, firstAccessedAt}`) is re-derived on every
 * use, following `readHeldoutFrozen` (`src/decision/heldout/calibration.ts`)
 * and `sealUpstream`: a spread-copied or forged record is refused. Both
 * content fields are required; a missing record refuses evaluation.
 * `firstAccessedAt` is null only when the binding declares no held-out split
 * (no `splitDigest`/`corpusDigest`/`goldDigest`); otherwise null refuses.
 */
export interface GateHoldoutInputs {
  /** First test-access timestamp, or null when no access has been recorded. */
  firstAccessedAt: string | null;
  /** Binding digest in the frozen record; must match the trusted binding digest. */
  frozenDigest: Sha256Digest;
  /** Seal over `{frozenDigest, firstAccessedAt}`; re-derived on every use. */
  digest: Sha256Digest;
}

export type { GateOutcome } from './lattice.js';

export type GateStatus = 'pass' | 'fail' | 'insufficient';

/** One metric observation for a single slice (or a pooled aggregate). Null means unknown: fail closed. */
export interface MetricObservation {
  n?: number | null;
  events?: number | null;
  value?: number | null;
  paired?: import('./stats/index.js').PairedBinaryCounts | null;
  differences?: readonly number[] | null;
  available?: readonly { id: string; passed: boolean; expiresAt?: string | null }[] | null;
}

export interface MetricSeries {
  bySlice: Record<string, MetricObservation>;
  pooled: MetricObservation | null;
}

export interface ProviderMetrics {
  version: string;
  sourceDigest: Sha256Digest;
  /**
   * Trusted code digest for bundle providers (#2831), sealed by the host via
   * `sealProviderSection` (never provider-declared). The evaluator verifies it
   * against the binding pin and the loaded provider.
   */
  codeDigest?: Sha256Digest;
  /** Digest of the input records the section was computed from. */
  recordsDigest?: Sha256Digest;
  metrics: Record<string, MetricSeries>;
}

export interface GateMetricsDocument {
  providers: Record<string, ProviderMetrics>;
  references?: Record<string, Record<string, ProviderMetrics>>;
}

/**
 * A sealed eval-integrity report. The digest covers the full integrity metadata and is
 * re-derived on every use, so a spread-copied or forged report is refused. The
 * `upstream-ceiling` gate validates it with `qualificationIntegrityAllowlistProblems`.
 */
export interface UpstreamCeiling {
  metadata: QualificationIntegrityMetadata;
  digest: Sha256Digest;
}

export type StatisticEvidenceMethod =
  | 'wilson' | 'clopper-pearson' | 'newcombe' | 'tango' | 'bootstrap'
  | 'exact-count' | 'exact-value' | 'evidence-present' | 'predicate' | 'upstream-integrity' | 'support-count';

export interface GateEvidence {
  gateId: string;
  kind: GateKind;
  scope: { mode: GateScopeMode; slices?: string[] };
  slice: string | null;
  n: number | null;
  events?: number | null;
  statistic?: { method: StatisticEvidenceMethod; levelBps?: number | null; lowerBps?: number | null; upperBps?: number | null; estimateBps?: number | null };
  threshold?: { op: 'lte' | 'gte'; value?: number; param?: string; resolved: number };
  status: GateStatus;
  outcome: GateOutcome;
  reasons: string[];
}

/** Validated upstream ceiling recorded in a report: the release_gate verdict, allowlist problems and the sealed metadata digest. */
export interface UpstreamRecord {
  decision: GateOutcome;
  reasons: string[];
  digest: Sha256Digest;
}

export interface GateHoldoutRecord {
  /** Seal of the trusted holdout inputs consumed by this evaluation. */
  digest: Sha256Digest;
  /** Binding digest carried by the sealed record. */
  frozenDigest: Sha256Digest;
  /** First test-access timestamp carried by the sealed record. */
  firstAccessedAt: string | null;
}

/**
 * Which project floors an evaluation applied (R2). Either the canonical
 * digest of the applied `ProjectFloors` input, or an explicit opt-out marker
 * (only for tests or legacy callers with a documented reason). There is no
 * absent state: reports always say which one governed them, and report
 * validation re-derives the distinction.
 */
export type GateFloorsRecord =
  | { mode: 'applied'; digest: Sha256Digest }
  | { mode: 'opt-out' };

export interface GateReport {
  apiVersion: typeof GATES_API_VERSION;
  kind: 'GateReport';
  metadata: GateMetadata;
  binding: ArtifactPinLike;
  packs: GatePackPin[];
  metricProviders: GateProviderPin[];
  metricsDigest: Sha256Digest;
  floors: GateFloorsRecord;
  holdout: GateHoldoutRecord;
  gateEvidence: GateEvidence[];
  references: { name: string; kind: ReferenceKind; observed: boolean }[];
  upstream: UpstreamRecord | null;
  ceilings: { packOutcome: GateOutcome; upstreamCeiling: GateOutcome; bindingCeiling: GateOutcome };
  decision: GateOutcome;
  evaluatedAt: string;
  /**
   * Provenance of the trust ceremony behind this report. Present only on
   * reports produced by the offline CLI (`evaluateGatesFromFiles`), whose
   * trust inputs are caller-asserted files: `offline-cli` marks them
   * distinguishable from reports built over a verified ceremony. Absent on
   * library-produced reports; absence changes no bytes.
   */
  attestation?: 'offline-cli';
  digest: Sha256Digest;
}
