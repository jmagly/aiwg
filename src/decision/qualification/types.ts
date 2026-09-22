export type QualificationCaseKind = 'baseline' | 'vendor';
export type EvidenceOutcome = 'pass' | 'fail' | 'skip';
export type GateStatus = 'pass' | 'fail' | 'skip';

export interface QualificationCase {
  id: string;
  kind: QualificationCaseKind;
  mandatory: boolean;
  candidateTests: string[];
}

export interface QualificationEvidence {
  caseId: string;
  executable: boolean;
  outcome: EvidenceOutcome;
  artifact: string | null;
  digest: `sha256:${string}` | null;
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
