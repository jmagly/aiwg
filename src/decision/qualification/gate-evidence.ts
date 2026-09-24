import { createHash } from 'node:crypto';
import { canonicalJson } from '../../security/artifact-trust.js';
import { CalibrationRegistry, calibrationArtifactDigest } from '../calibration/registry.js';
import type { CalibrationArtifact } from '../calibration/types.js';
import { validateCaseInventory } from './manifest.js';
import { verifyQualificationSplits, type FrozenBinaryBenchmarkPlan } from './quality.js';
import type { QualificationGateArtifactRef, QualificationRunManifest } from './types.js';

/**
 * Gate evidence that is computed from recorded case evidence. Callers cannot
 * supply these flags: the runner ignores callbacks with these names and the
 * evaluator recomputes them from the manifest.
 */
export interface QualificationSuiteDefinition {
  gate: 'G1' | 'G2' | 'G4';
  caseIds: readonly string[];
  /** Named master-test-plan evidence IDs that must appear on passing evidence. */
  evidenceIds?: readonly string[];
}

const range = (prefix: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, index) => `${prefix}${String(from + index).padStart(2, '0')}`);

export const DECISION_GATE_SUITES: Readonly<Record<string, QualificationSuiteDefinition>> = {
  'runtime-suite-complete': { gate: 'G1', caseIds: [
    ...range('C', 1, 12), ...range('C', 19, 23), 'C25', 'C26', 'C31', 'C35', 'C40', 'C41',
    'TV01', 'TV03', 'TV04', 'TV05', 'TV08', 'TV11', 'TV22',
  ] },
  'security-suite-complete': { gate: 'G2', caseIds: ['C29', 'C30', 'C32', 'C34', 'C36', 'C39'] },
  'fault-suite-complete': { gate: 'G4', caseIds: [
    ...range('C', 13, 18), 'C24', 'C27', 'C28', 'C33', 'C37', 'C38', 'C42',
  ] },
  'drift-suite-complete': { gate: 'G4', caseIds: ['TV10'], evidenceIds: [
    'DRF-ALIAS-01', 'DRF-SHADOW-01', 'DRF-ACTIVE-PIN-01', 'DRF-PROMOTE-01', 'DRF-ROLLBACK-01', 'DRF-RETIRE-01',
  ] },
};

/** Flags backed by a checked, digest-pinned artifact copied into the run directory. */
export const GATE_ARTIFACT_SCHEMAS = {
  'immutable-splits': 'decision-binary-benchmark-plan/v1',
  'calibration-qualified': 'decision-calibration-artifact/v1',
  'load-manifest-qualified': 'decision-load-result/v1',
  'review-decision-recorded': 'decision-qualification-review/v1',
} as const;
export type QualificationGateArtifactFlag = keyof typeof GATE_ARTIFACT_SCHEMAS;
export const GATE_ARTIFACT_FLAGS = Object.keys(GATE_ARTIFACT_SCHEMAS) as QualificationGateArtifactFlag[];

/** Every name that the caller cannot assert through an evidence-check callback. */
export const DERIVED_GATE_EVIDENCE: readonly string[] = [
  'case-inventory-complete', ...Object.keys(DECISION_GATE_SUITES), 'evidence-hashes-verified',
  'privacy-scan-clean', ...GATE_ARTIFACT_FLAGS,
];

export interface QualificationLoadResult {
  schemaVersion: 'decision-load-result/v1';
  /** SHA-256 of the canonical JSON of `manifest`, recorded before observations are collected. */
  manifestDigest: `sha256:${string}`;
  manifest: { schema: 'decision-load-manifest/v1'; mode: string; bounds: Record<string, number> };
  mode: string;
  observations: Record<string, number>;
  recordedAt: string;
}

export interface QualificationReviewRecord {
  schemaVersion: 'decision-qualification-review/v1';
  runId: string;
  sourceCommit: string;
  /** `qualificationOutcomesDigest` of the reviewed run. */
  outcomesDigest: `sha256:${string}`;
  reviewer: string;
  decision: 'approve' | 'reject';
  recordedAt: string;
}

const sha256Pattern = /^sha256:[0-9a-f]{64}$/;
const sha256 = (value: string): `sha256:${string}` => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/**
 * Deterministic digest of the run's case outcomes and named evidence. Artifact
 * digests are excluded (they bind durations), so a reviewer can sign the
 * outcome set that the run must reproduce.
 */
export function qualificationOutcomesDigest(manifest: Pick<QualificationRunManifest, 'runId' | 'sourceCommit' | 'evidence'>): `sha256:${string}` {
  const outcomes = [...manifest.evidence].sort((a, b) => a.caseId.localeCompare(b.caseId)).map(item => ({
    caseId: item.caseId, executable: item.executable, outcome: item.outcome,
    testEvidenceIds: [...(item.testEvidenceIds ?? [])].sort(),
  }));
  return sha256(canonicalJson({ runId: manifest.runId, sourceCommit: manifest.sourceCommit, outcomes }));
}

export function loadManifestDigest(manifest: unknown): `sha256:${string}` {
  return sha256(canonicalJson(manifest));
}

/** True only when every suite case has executable, digest-bound, passing evidence and named IDs are proven. */
export function suiteSatisfied(manifest: Pick<QualificationRunManifest, 'evidence'>, suite: QualificationSuiteDefinition): boolean {
  const byCase = new Map<string, QualificationRunManifest['evidence'][number][]>();
  for (const item of manifest.evidence) byCase.set(item.caseId, [...(byCase.get(item.caseId) ?? []), item]);
  const proven = new Set<string>();
  for (const caseId of suite.caseIds) {
    const items = byCase.get(caseId) ?? [];
    const item = items[0];
    if (items.length !== 1 || !item || !item.executable || item.outcome !== 'pass' || !item.artifact
      || !item.digest || !sha256Pattern.test(item.digest)) return false;
    for (const id of item.testEvidenceIds ?? []) proven.add(id);
  }
  return (suite.evidenceIds ?? []).every(id => proven.has(id));
}

export interface GateArtifactContext {
  manifest: Pick<QualificationRunManifest, 'runId' | 'sourceCommit' | 'generatedAt' | 'evidence'>;
  /** Parsed, already-accepted artifacts; calibration binds to the accepted split plan. */
  accepted: Partial<Record<QualificationGateArtifactFlag, unknown>>;
}

function validSplitPlan(value: unknown): value is FrozenBinaryBenchmarkPlan {
  if (!record(value) || value.schemaVersion !== GATE_ARTIFACT_SCHEMAS['immutable-splits']) return false;
  const { digest, ...fields } = value as unknown as FrozenBinaryBenchmarkPlan;
  try { verifyQualificationSplits(fields.splits); } catch { return false; }
  return typeof digest === 'string' && sha256Pattern.test(digest) && digest === sha256(JSON.stringify(fields))
    && sha256Pattern.test(String(fields.datasetDigest));
}

function validCalibration(value: unknown, context: GateArtifactContext): boolean {
  if (!record(value) || value.schemaVersion !== GATE_ARTIFACT_SCHEMAS['calibration-qualified']) return false;
  const artifact = value as unknown as CalibrationArtifact;
  const plan = context.accepted['immutable-splits'] as FrozenBinaryBenchmarkPlan | undefined;
  try { new CalibrationRegistry().registerArtifact(artifact); } catch { return false; }
  const { digest, ...payload } = artifact;
  const at = Date.parse(context.manifest.generatedAt);
  const effective = Date.parse(artifact.effectiveAt);
  const expires = effective + artifact.profile.expiresAfterDays * 86_400_000;
  return digest === calibrationArtifactDigest(payload) && artifact.approval.state === 'approved'
    && plan !== undefined && artifact.splitProvenance.hash === plan.digest
    && Number.isFinite(at) && effective <= at && at < expires
    && artifact.metrics.totalSamples >= artifact.profile.minimumTotalSamples
    && artifact.metrics.perSliceSamples >= artifact.profile.minimumPerSliceSamples
    && artifact.metrics.calibrationError <= artifact.profile.maximumCalibrationError
    && artifact.metrics.selectiveRisk <= artifact.profile.maximumSelectiveRisk;
}

function validLoadResult(value: unknown): boolean {
  if (!record(value) || value.schemaVersion !== GATE_ARTIFACT_SCHEMAS['load-manifest-qualified']) return false;
  const result = value as unknown as QualificationLoadResult;
  if (!record(result.manifest) || result.manifest.schema !== 'decision-load-manifest/v1' || !record(result.manifest.bounds)
    || !record(result.observations) || !validDate(result.recordedAt) || result.mode !== result.manifest.mode) return false;
  let digest: string;
  try { digest = loadManifestDigest(result.manifest); } catch { return false; }
  const bounds = Object.entries(result.manifest.bounds);
  return digest === result.manifestDigest && bounds.length > 0
    && Object.keys(result.observations).length === bounds.length
    && bounds.every(([name, limit]) => {
      const observed = result.observations[name];
      return Number.isFinite(limit) && limit >= 0 && typeof observed === 'number' && Number.isFinite(observed)
        && observed >= 0 && observed <= limit;
    });
}

function validReview(value: unknown, context: GateArtifactContext): boolean {
  if (!record(value) || value.schemaVersion !== GATE_ARTIFACT_SCHEMAS['review-decision-recorded']) return false;
  const review = value as unknown as QualificationReviewRecord;
  return review.runId === context.manifest.runId && review.sourceCommit === context.manifest.sourceCommit
    && typeof review.reviewer === 'string' && review.reviewer.trim().length > 0 && review.decision === 'approve'
    && validDate(review.recordedAt) && review.outcomesDigest === qualificationOutcomesDigest(context.manifest);
}

/** Validates a parsed gate artifact against its schema, self-digest and the run it is attached to. */
export function validateGateArtifact(flag: QualificationGateArtifactFlag, value: unknown, context: GateArtifactContext): boolean {
  switch (flag) {
    case 'immutable-splits': return validSplitPlan(value);
    case 'calibration-qualified': return validCalibration(value, context);
    case 'load-manifest-qualified': return validLoadResult(value);
    case 'review-decision-recorded': return validReview(value, context);
    default: return false;
  }
}

export interface QualificationEvidenceProof {
  /** Set only by the executable pipeline after every case and gate artifact re-verified on disk. */
  artifactsVerified?: boolean;
}

/** Computes every derived gate flag from the manifest; caller-supplied values for these names are ignored. */
export function deriveGateEvidence(manifest: QualificationRunManifest, proof: QualificationEvidenceProof = {}): Record<string, boolean> {
  const flags: Record<string, boolean> = {
    'case-inventory-complete': validateCaseInventory(manifest.cases).length === 0,
    'evidence-hashes-verified': proof.artifactsVerified === true,
    'privacy-scan-clean': manifest.evidenceFlags['privacy-scan-clean'] === true,
  };
  for (const [name, suite] of Object.entries(DECISION_GATE_SUITES)) flags[name] = suiteSatisfied(manifest, suite);
  for (const flag of GATE_ARTIFACT_FLAGS) {
    const ref: QualificationGateArtifactRef | undefined = manifest.gateArtifacts?.[flag];
    flags[flag] = ref !== undefined && ref.schemaVersion === GATE_ARTIFACT_SCHEMAS[flag]
      && typeof ref.artifact === 'string' && ref.artifact.length > 0 && sha256Pattern.test(ref.digest);
  }
  return flags;
}
