import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { calibrationArtifactDigest } from '../../../src/decision/calibration/registry.js';
import type { CalibrationArtifact } from '../../../src/decision/calibration/types.js';
import {
  DECISION_GATE_SUITES, loadManifestDigest, qualificationOutcomesDigest,
  type QualificationGateArtifactFlag, type QualificationLoadResult, type QualificationReviewRecord,
} from '../../../src/decision/qualification/gate-evidence.js';
import { expectedQualificationCaseIds } from '../../../src/decision/qualification/manifest.js';
import { freezeBinaryBenchmarkPlan, freezeQualificationSplit } from '../../../src/decision/qualification/quality.js';
import type { QualificationCase, QualificationEvidence } from '../../../src/decision/qualification/types.js';

/**
 * Synthetic gate artifacts for runner-mechanics tests only. They satisfy the
 * artifact validators so a test can reach PROMOTE; they are not release evidence.
 */
const hash = (value: string) => `sha256:${value.repeat(64)}` as const;

/** All 67 cases, with each suite's required named evidence attached to that suite's first case. */
export function syntheticCases(): QualificationCase[] {
  const named = new Map<string, Set<string>>();
  for (const suite of Object.values(DECISION_GATE_SUITES)) {
    const ids = named.get(suite.caseIds[0]!) ?? new Set<string>();
    for (const id of suite.evidenceIds ?? []) ids.add(id);
    named.set(suite.caseIds[0]!, ids);
  }
  return expectedQualificationCaseIds().map(id => ({
    id, kind: id.startsWith('TV') ? 'vendor' as const : 'baseline' as const, mandatory: true, candidateTests: [],
    ...(named.get(id)?.size ? { evidenceIds: [...named.get(id)!].sort() } : {}),
  }));
}

export interface GateArtifactRun {
  runId: string;
  sourceCommit: string;
  generatedAt: string;
  /** Expected outcomes the reviewer signs; defaults to every case passing. */
  evidence?: Array<Pick<QualificationEvidence, 'caseId' | 'executable' | 'outcome' | 'testEvidenceIds'>>;
  cases?: QualificationCase[];
}

export function syntheticSplitPlan() {
  const ids = (prefix: string) => Array.from({ length: 4 }, (_, index) => `${prefix}-${index}`);
  const splits = [freezeQualificationSplit('tuning', ids('tune')), freezeQualificationSplit('calibration', ids('cal')),
    freezeQualificationSplit('test', ids('test'))];
  const labels = splits.flatMap(split => split.ids.map((id, index) => ({ id, label: (index % 2) as 0 | 1, slice: 'synthetic' })));
  return freezeBinaryBenchmarkPlan(splits, labels, { minimumOverallN: 4, minimumSliceN: 4,
    maximumSelectiveRisk: 0.5, maximumReviewRate: 0.5, maximumBrier: 0.5 });
}

export function syntheticCalibration(splitDigest: `sha256:${string}`, overrides: Partial<Omit<CalibrationArtifact, 'digest'>> = {}): CalibrationArtifact {
  const payload: Omit<CalibrationArtifact, 'digest'> = {
    schemaVersion: 'decision-calibration-artifact/v1', id: 'calibration:synthetic-gate',
    identity: { provider: 'jev', backend: 'api', actualModel: 'jev-synthetic', primitive: 'choice', definitionDigest: hash('a'),
      adapterVersion: 'prompt-v1', dataset: { id: 'synthetic', hash: hash('b') }, slice: { id: 'synthetic', hash: hash('c') },
      calibrator: { id: 'isotonic', version: '1', parametersDigest: hash('d') } },
    splitProvenance: { id: 'synthetic-split', hash: splitDigest, holdoutAccessedAt: null },
    profile: { minimumTotalSamples: 10, minimumPerSliceSamples: 4, powerRule: null,
      confidenceInterval: { method: 'bootstrap-bca', level: 0.95 }, maximumCalibrationError: 0.1,
      maximumSelectiveRisk: 0.1, expiresAfterDays: 30 },
    metrics: { totalSamples: 12, perSliceSamples: 4, calibrationError: 0.05, selectiveRisk: 0.05,
      confidenceIntervals: { ece: { lower: 0.01, upper: 0.08 } } },
    effectiveAt: '2026-09-01T00:00:00.000Z', limitations: ['Synthetic runner-mechanics fixture; not release evidence.'],
    approval: { state: 'approved', reference: 'approval:synthetic' }, ...overrides,
  };
  return { ...payload, digest: calibrationArtifactDigest(payload) };
}

export function syntheticLoadResult(observations?: Record<string, number>): QualificationLoadResult {
  const manifest = { schema: 'decision-load-manifest/v1' as const, mode: 'offline-fake-provider',
    bounds: { maximumActiveCalls: 3, maximumQueuedCalls: 128, maximumRetryAmplificationRatio: 1.25 } };
  return { schemaVersion: 'decision-load-result/v1', manifestDigest: loadManifestDigest(manifest), manifest,
    mode: manifest.mode, observations: observations ?? { maximumActiveCalls: 3, maximumQueuedCalls: 40, maximumRetryAmplificationRatio: 1 },
    recordedAt: '2026-09-02T00:00:00.000Z' };
}

export function syntheticReview(run: GateArtifactRun, overrides: Partial<QualificationReviewRecord> = {}): QualificationReviewRecord {
  const cases = run.cases ?? syntheticCases();
  const evidence = run.evidence ?? cases.map(item => ({ caseId: item.id, executable: true, outcome: 'pass' as const,
    testEvidenceIds: [...(item.evidenceIds ?? [])].sort() }));
  return { schemaVersion: 'decision-qualification-review/v1', runId: run.runId, sourceCommit: run.sourceCommit,
    outcomesDigest: qualificationOutcomesDigest({ runId: run.runId, sourceCommit: run.sourceCommit,
      evidence: evidence.map(item => ({ ...item, artifact: null, digest: null })) }),
    reviewer: 'synthetic-reviewer', decision: 'approve', recordedAt: '2026-09-03T00:00:00.000Z', ...overrides };
}

/** Writes one valid artifact per artifact-backed flag and returns the plan input. */
export async function writeGateArtifacts(dir: string, run: GateArtifactRun,
  omit: readonly QualificationGateArtifactFlag[] = []): Promise<Partial<Record<QualificationGateArtifactFlag, string>>> {
  const plan = syntheticSplitPlan();
  const values: Record<QualificationGateArtifactFlag, unknown> = {
    'immutable-splits': plan,
    'calibration-qualified': syntheticCalibration(plan.digest),
    'load-manifest-qualified': syntheticLoadResult(),
    'review-decision-recorded': syntheticReview(run),
  };
  const paths: Partial<Record<QualificationGateArtifactFlag, string>> = {};
  for (const [flag, value] of Object.entries(values) as Array<[QualificationGateArtifactFlag, unknown]>) {
    if (omit.includes(flag)) continue;
    const path = join(dir, `${flag}.source.json`);
    await writeFile(path, `${JSON.stringify(value)}\n`);
    paths[flag] = path;
  }
  return paths;
}
