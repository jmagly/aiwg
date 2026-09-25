/**
 * Effect ledger v1 vocabulary: the identifiers, phases, kinds and reason codes
 * pinned by `docs/contracts/effect-ledger.v1.md` and `schemas/effects/*`.
 */

export const EFFECT_PREDICATE_TYPE = 'https://aiwg.io/attestations/effect/v1' as const;
export const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1' as const;
export const STATEMENT_PAYLOAD_TYPE = 'application/vnd.in-toto+json' as const;
export const CHECKPOINT_PAYLOAD_TYPE = 'application/vnd.aiwg.effect-checkpoint.v1+json' as const;
export const ROTATION_PAYLOAD_TYPE = 'application/vnd.aiwg.effect-key-rotation.v1+json' as const;

export const RECORD_SCHEMA_VERSION = 'aiwg.effect.record.v1' as const;
export const SEGMENT_LINE_SCHEMA_VERSION = 'aiwg.effect.segment-line.v1' as const;
export const CHECKPOINT_SCHEMA_VERSION = 'aiwg.effect.checkpoint.v1' as const;
export const KEYRING_SCHEMA_VERSION = 'aiwg.effect.keyring.v1' as const;
export const ROTATION_SCHEMA_VERSION = 'aiwg.effect.key-rotation.v1' as const;
export const VERIFIER_RESULT_SCHEMA_VERSION = 'aiwg.effect.verifier-result.v1' as const;
export const INDEX_SCHEMA_VERSION = 'aiwg.effect.index.v1' as const;

export const EFFECT_SUBSYSTEMS = ['review', 'job', 'delivery', 'custom'] as const;
export type EffectSubsystem = typeof EFFECT_SUBSYSTEMS[number];

export const EFFECT_PHASES = ['intent', 'completed', 'failed', 'reconciled', 'tombstone'] as const;
export type EffectPhase = typeof EFFECT_PHASES[number];

export const CORE_EFFECT_KINDS = [
  'git.commit',
  'git.tag',
  'file.digest',
  'decision.receipt',
  'decision.review.continuation',
  'tracker.comment',
  'tracker.issue.closed',
  'tracker.pr.merged',
] as const;
export type CoreEffectKind = typeof CORE_EFFECT_KINDS[number];

export const EFFECT_ID_DERIVATION_NAMES = ['aiwg.effect/v1', 'd13.review/v1'] as const;
export type EffectIdDerivationName = typeof EFFECT_ID_DERIVATION_NAMES[number];

export const PRESENT_REASONS = ['marker-match', 'state-match', 'digest-match', 'heuristic-match'] as const;
export const ABSENT_REASONS = ['complete-query-no-match'] as const;
export const UNKNOWN_REASONS = [
  'verifier-missing',
  'verifier-version-mismatch',
  'verifier-cannot-report-absent',
  'network-error',
  'timeout',
  'auth-denied',
  'rate-limited',
  'server-error',
  'container-unreadable',
  'paging-incomplete',
  'consistency-lag',
  'tracker-blocked',
  'malformed-response',
  'evidence-conflict',
] as const;
export type PresentReason = typeof PRESENT_REASONS[number];
export type AbsentReason = typeof ABSENT_REASONS[number];
export type UnknownReason = typeof UNKNOWN_REASONS[number];

export const FAILURE_REASONS = ['target-rejected', 'precondition-failed', 'cancelled-before-dispatch'] as const;
export type FailureReason = typeof FAILURE_REASONS[number];

export type EffectContextValue = string | number | boolean;
export type EffectContext = Record<string, EffectContextValue>;

export interface EffectScope {
  tenant: string;
  project: string;
  subsystem: EffectSubsystem;
}

export interface EffectIdentityInput {
  scope: EffectScope;
  kind: string;
  target: string;
  context: EffectContext;
}

export interface VerifierRef {
  kind: string;
  version: string;
  canReportAbsent: boolean;
}

export type VerificationResult = 'present' | 'absent' | 'unknown';

export interface EffectVerification {
  verifier: VerifierRef;
  result: VerificationResult;
  reason: string;
  complete: boolean;
  checkedAt: string;
  evidenceDigest?: string;
}

export interface EffectFailure {
  reason: FailureReason;
  evidenceDigest?: string;
}

export interface EffectTombstone {
  originalRecordHash: string;
  originalKeyid: string;
  originalPhase: Exclude<EffectPhase, 'tombstone'>;
  purgedAt: string;
  retentionPolicy: string;
}

export interface EffectLinks {
  operatorDecisionEventId?: string;
  operatorDecisionRecordHash?: string;
  traceId?: string;
  spanId?: string;
  toolCallId?: string;
}

export interface EffectPredicate {
  schemaVersion: typeof RECORD_SCHEMA_VERSION;
  effectId: string;
  idDerivation: EffectIdDerivationName;
  scope: EffectScope;
  kind: string;
  target?: string;
  context?: EffectContext;
  phase: EffectPhase;
  payloadDigest: string;
  writer: string;
  seq: number;
  prev: string | null;
  recordedAt: string;
  verification?: EffectVerification;
  failure?: EffectFailure;
  tombstone?: EffectTombstone;
  links: EffectLinks;
}

export interface EffectStatement {
  _type: typeof IN_TOTO_STATEMENT_TYPE;
  subject: [{ name: string; digest: { sha256: string } }];
  predicateType: typeof EFFECT_PREDICATE_TYPE;
  predicate: EffectPredicate;
}

export interface EffectSignature { keyid: string; sig: string }

export interface EffectEnvelope {
  payloadType: typeof STATEMENT_PAYLOAD_TYPE;
  payload: string;
  signatures: EffectSignature[];
}

export interface EffectSegmentLine {
  schemaVersion: typeof SEGMENT_LINE_SCHEMA_VERSION;
  writer: string;
  seq: number;
  recordHash: string;
  envelope: EffectEnvelope;
}

export interface EffectKeyringKey {
  keyid: string;
  algorithm: 'ed25519';
  publicKey: string;
  validFrom: string;
  validUntil?: string;
  status: 'active' | 'retired' | 'revoked';
  revokedAt?: string;
}

export interface EffectKeyRotationBody {
  schemaVersion: typeof ROTATION_SCHEMA_VERSION;
  sequence: number;
  from: string;
  to: string;
  effectiveAt: string;
  reason: 'scheduled' | 'custody-change' | 'compromise';
}

export interface EffectKeyRotation extends EffectKeyRotationBody {
  signatures: Array<{ role: 'prior' | 'successor'; keyid: string; sig: string }>;
}

export interface EffectKeyring {
  schemaVersion: typeof KEYRING_SCHEMA_VERSION;
  scope: EffectScope;
  keys: EffectKeyringKey[];
  rotations: EffectKeyRotation[];
}

export interface EffectCheckpointWriter {
  writer: string;
  segment: string;
  count: number;
  headHash: string;
}

export interface EffectCheckpointBody {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  scope: EffectScope;
  sequence: number;
  createdAt: string;
  writers: EffectCheckpointWriter[];
  root: string;
  keyringDigest: string;
  previousCheckpoint: string | null;
}

export interface EffectCheckpoint extends EffectCheckpointBody {
  signatures: EffectSignature[];
}

export interface EffectVerifierResult {
  schemaVersion: typeof VERIFIER_RESULT_SCHEMA_VERSION;
  effectId: string;
  kind: string;
  verification: EffectVerification;
  exitCode: 0 | 3 | 4;
}
