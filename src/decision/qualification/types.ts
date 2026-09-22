export type QualificationCaseKind = 'baseline' | 'vendor';
export type EvidenceOutcome = 'pass' | 'fail' | 'skip';
export type GateStatus = 'pass' | 'fail' | 'skip';

export interface QualificationCase {
  id: string;
  kind: QualificationCaseKind;
  mandatory: boolean;
  candidateTests: string[];
  /** Named master-test-plan evidence IDs implemented by this executable case. */
  evidenceIds?: string[];
}

export interface QualificationEvidence {
  caseId: string;
  executable: boolean;
  outcome: EvidenceOutcome;
  artifact: string | null;
  digest: `sha256:${string}` | null;
  /** Named master-test-plan IDs proven by the persisted runner artifact. */
  testEvidenceIds?: string[];
}

export interface QualificationGateDefinition {
  id: `G${0 | 1 | 2 | 3 | 4 | 5 | 6}`;
  title: string;
  mandatory: boolean;
  requiredCaseIds: string[];
  requiredEvidence: string[];
}

export interface QualificationRunManifest {
  schemaVersion: 'decision-qualification-run/v1';
  mode: 'offline' | 'recorded' | 'shadow' | 'live';
  runId: string;
  generatedAt: string;
  sourceCommit: string;
  dirty: boolean;
  cases: QualificationCase[];
  evidence: QualificationEvidence[];
  evidenceFlags: Record<string, boolean>;
}

export interface QualificationGateResult {
  id: QualificationGateDefinition['id'];
  title: string;
  status: GateStatus;
  missing: string[];
  failed: string[];
}

export interface QualificationReport {
  schemaVersion: 'decision-qualification-report/v1';
  runId: string;
  generatedAt: string;
  decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK';
  gates: QualificationGateResult[];
}

export interface QualificationEvidenceSource {
  path: string;
  digest: `sha256:${string}`;
}

export interface QualificationEvidenceManifestEntry {
  caseId: string;
  testEvidenceIds: string[];
  executable: boolean;
  outcome: EvidenceOutcome;
  artifact: QualificationEvidenceSource;
  sourceGoldens: QualificationEvidenceSource[];
}

/** D11-compatible, machine-readable linkage from executed cases to immutable evidence. */
export interface QualificationEvidenceManifest {
  schemaVersion: 'decision-qualification-evidence-manifest/v1';
  runId: string;
  sourceCommit: string;
  evidence: QualificationEvidenceManifestEntry[];
}
