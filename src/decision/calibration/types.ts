export type CalibrationDigest = `sha256:${string}`;
export type CompatibilityState = 'exact' | 'approved-compatible' | 'shadow-required' | 'incompatible' | 'unknown';
export type NonAction = 'fail' | 'defer' | 'shadow' | 'require-approval';
export type CompatibilityAction = 'allow' | NonAction;
export type CalibrationApprovalState = 'observed' | 'approved' | 'rejected' | 'retired';

export interface CalibrationIdentity {
  provider: string;
  backend: string;
  actualModel: string;
  primitive: string;
  definitionDigest: CalibrationDigest;
  adapterVersion: string;
  dataset: { id: string; hash: CalibrationDigest };
  slice: { id: string; hash: CalibrationDigest };
  calibrator: { id: string; version: string; parametersDigest: CalibrationDigest };
}

export interface CalibrationProfile {
  minimumTotalSamples: number;
  minimumPerSliceSamples: number;
  powerRule: string | null;
  confidenceInterval: { method: string; level: number };
  maximumCalibrationError: number;
  maximumSelectiveRisk: number;
  expiresAfterDays: number;
}

export interface CalibrationArtifact {
  schemaVersion: 'decision-calibration-artifact/v1';
  id: string;
  digest: CalibrationDigest;
  identity: CalibrationIdentity;
  splitProvenance: { id: string; hash: CalibrationDigest; holdoutAccessedAt: string | null };
  profile: CalibrationProfile;
  metrics: {
    totalSamples: number;
    perSliceSamples: number;
    calibrationError: number;
    selectiveRisk: number;
    confidenceIntervals: Record<string, { lower: number; upper: number }>;
  };
  effectiveAt: string;
  limitations: string[];
  approval: { state: CalibrationApprovalState; reference: string | null };
}

export interface CompatibilityRelation {
  id: string;
  fromIdentityDigest: CalibrationDigest;
  toIdentityDigest: CalibrationDigest;
  state: Exclude<CompatibilityState, 'exact' | 'unknown'>;
  evidenceReference: string;
  approvalReference: string | null;
  effectiveAt: string;
  expiresAt: string | null;
}

export interface CompatibilityPolicy {
  unknown: NonAction;
  incompatible: NonAction;
  shadowRequired: Extract<NonAction, 'shadow' | 'defer' | 'fail' | 'require-approval'>;
  unusableCalibration: NonAction;
}

export interface CompatibilityRequest {
  runId: string;
  requestedAlias: string;
  actualIdentity: CalibrationIdentity;
  calibrationArtifactId?: string;
  at: string;
}

export interface CompatibilityDecision {
  schemaVersion: 'decision-calibration-compatibility/v1';
  pinId: string;
  runId: string;
  requestedAlias: string;
  actualModel: string;
  aliasRevision: number | null;
  artifactId: string | null;
  artifactDigest: CalibrationDigest | null;
  state: CompatibilityState;
  action: CompatibilityAction;
  reasons: string[];
  decidedAt: string;
}

export interface AliasEvent {
  revision: number;
  alias: string;
  actualIdentityDigest: CalibrationDigest;
  actualModel: string;
  recordedAt: string;
  kind: 'observed' | 'promoted' | 'rolled-back' | 'retired';
  promotionEligibilityId: string | null;
}

export interface AliasDriftEvent {
  id: string;
  alias: string;
  previousIdentityDigest: CalibrationDigest;
  observedIdentityDigest: CalibrationDigest;
  previousActualModel: string;
  observedActualModel: string;
  detectedAt: string;
}

export interface PromotionEligibility {
  id: string;
  alias: string;
  candidateIdentityDigest: CalibrationDigest;
  candidateActualModel: string;
  evaluationIntegrityReport: { id: string; digest: CalibrationDigest };
  approvalReference: string;
  rollbackTarget: { aliasRevision: number; identityDigest: CalibrationDigest };
  eligible: boolean;
  reasons: string[];
  recordedAt: string;
}

/** Immutable, hash-chained evidence for registry-level alias movement. */
export interface CalibrationGovernanceReceipt {
  schemaVersion: 'decision-calibration-governance-receipt/v1';
  receiptId: string;
  sequence: number;
  kind: 'promotion' | 'rollback';
  alias: string;
  from: { aliasRevision: number; identityDigest: CalibrationDigest };
  to: { aliasRevision: number; identityDigest: CalibrationDigest };
  action: 'promote' | 'rollback';
  reviewedEvidence: {
    evaluationIntegrityReport: { id: string; digest: CalibrationDigest };
    calibrationArtifact: { id: string; digest: CalibrationDigest };
    compatibilityRelation: { id: string; digest: CalibrationDigest } | null;
  };
  approvalReference: string;
  eligibilityId: string | null;
  reasons: string[];
  recordedAt: string;
  previousReceiptDigest: CalibrationDigest | null;
  digest: CalibrationDigest;
}

export type CalibrationGovernanceReceiptDraft = Omit<CalibrationGovernanceReceipt, 'schemaVersion' | 'digest'>;

export interface RawDecisionEvidence {
  probability: number | null;
  confidence: number | null;
  distribution: Readonly<Record<string, number>> | null;
  provider: string;
  actualModel: string;
}

export interface CalibratedDecisionEvidence {
  value: number;
  metric: string;
  calibrationArtifactId: string;
  calibrationArtifactDigest: CalibrationDigest;
  derivedAt: string;
}

export interface DecisionEvidenceEnvelope {
  raw: RawDecisionEvidence;
  calibrated: CalibratedDecisionEvidence | null;
  compatibilityPin: CompatibilityDecision;
}
