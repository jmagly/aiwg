import { createHash } from 'node:crypto';
import type { LabelStabilityReport } from './drift.js';
import type { BinarySliceMetrics } from './quality.js';
import type { ExecutedQualification } from './runner.js';
import type { QualificationEvidenceManifest } from './types.js';

/** Structural #2037/#2048 serialized integrity contract; no runtime dependency on tools/eval. */
export interface QualificationIntegrityMetadata {
  sample_n: number;
  uncertainty: unknown | null;
  paired_baseline: unknown | null;
  integrity_mode: string;
  fresh_workspace_required: boolean;
  fresh_workspace_verified: boolean;
  integrity_state: string;
  trusted_score_source: string;
  compromise_labels: readonly string[];
  weak_signal_reason: string | null;
  release_gate: { decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK'; reasons: readonly string[] };
}

/** AC8 metrics serialized into the release record from the preregistered held-out evaluation. */
export interface QualificationReleaseMetrics {
  overall: BinarySliceMetrics;
  slices: Readonly<Record<string, BinarySliceMetrics>>;
  /** Repeated-run label movement (stability). */
  stability: LabelStabilityReport | null;
  /** Paired clean-versus-injected movement (injection sensitivity). */
  injectionSensitivity: LabelStabilityReport | null;
}

/** Digest of the protected-artifact snapshot that the #2037/#2048 integrity metadata was computed over. */
export interface QualificationIntegritySnapshot {
  digest: `sha256:${string}`;
  artifactCount: number;
}

/** D30 compile/prefix cache, D03 receipt replay and D15 result cache evidence, each a verified evidence manifest. */
export const QUALIFICATION_CACHE_LAYERS = ['compilePrefixCache', 'receiptReplay', 'resultCache'] as const;
export type QualificationCacheLayer = typeof QUALIFICATION_CACHE_LAYERS[number];
export interface QualificationCacheLayerEvidence {
  manifest: QualificationEvidenceManifest;
  /** Digest returned by `writeQualificationEvidenceManifest` for this manifest. */
  digest: `sha256:${string}`;
}

export interface QualificationReleaseInputs {
  commands: readonly string[];
  environment: string;
  /** Definition, ruleset, binding, adapter, models, policy, calibration, dataset and price catalog. */
  pins: Readonly<Record<string, `sha256:${string}`>>;
  budgets: Readonly<Record<string, number>>;
  actuals: Readonly<Record<string, number>>;
  reviewer: string | null;
  integrity: QualificationIntegrityMetadata;
  /** Separately anchored, frozen held-out evaluation; absent or failed evidence blocks promotion. */
  benchmark?: { planDigest: `sha256:${string}`; trustedPlanDigest: `sha256:${string}`;
    decision: 'pass' | 'fail' | 'insufficient-evidence'; sampleN: number; minimumN: number };
  /** Absent metrics block promotion. */
  metrics?: QualificationReleaseMetrics;
  /** Absent snapshot digest blocks promotion. */
  integritySnapshot?: QualificationIntegritySnapshot;
  /**
   * When present, the compilePrefixCache/receiptReplay/resultCache pins are
   * derived from these verified manifests; a supplied pin that differs is rejected.
   */
  cacheLayers?: Readonly<Record<QualificationCacheLayer, QualificationCacheLayerEvidence>>;
}

export interface QualificationReleaseRecord {
  schemaVersion: 'decision-qualification-release/v1';
  runId: string;
  sourceCommit: string;
  dirty: boolean;
  environment: string;
  commands: readonly string[];
  pins: Readonly<Record<string, string>>;
  budgets: Readonly<Record<string, number>>;
  actuals: Readonly<Record<string, number>>;
  reviewer: string | null;
  suites: { caseId: string; outcome: string; evidenceHash: string | null; verified: boolean }[];
  gates: ExecutedQualification['report']['gates'];
  integrity: QualificationIntegrityMetadata;
  benchmark: QualificationReleaseInputs['benchmark'] | null;
  metrics: QualificationReleaseMetrics | null;
  integritySnapshot: QualificationIntegritySnapshot | null;
  cacheLayers: Record<QualificationCacheLayer, { runId: string; digest: string; caseIds: string[] }> | null;
  decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK';
  digest: `sha256:${string}`;
}

const REQUIRED_PINS = [
  'definition', 'ruleset', 'binding', 'adapter', 'requestedModel', 'servedModel',
  'policy', 'calibration', 'dataset', 'split', 'seed', 'priceCatalog',
  'compilePrefixCache', 'receiptReplay', 'resultCache',
] as const;

/**
 * Derives the three cache-layer pins from verified evidence manifests. Each
 * manifest must contain only executable, passing, digest-bound evidence, and
 * the three layers must come from different runs.
 */
export function deriveCacheLayerPins(
  layers: Readonly<Record<QualificationCacheLayer, QualificationCacheLayerEvidence>>,
): Record<QualificationCacheLayer, `sha256:${string}`> {
  const pins = {} as Record<QualificationCacheLayer, `sha256:${string}`>;
  for (const layer of QUALIFICATION_CACHE_LAYERS) {
    const evidence = layers[layer];
    if (!evidence || evidence.manifest.schemaVersion !== 'decision-qualification-evidence-manifest/v1'
      || !/^sha256:[0-9a-f]{64}$/.test(evidence.digest) || !evidence.manifest.evidence.length
      || evidence.manifest.evidence.some(item => !item.executable || item.outcome !== 'pass'
        || !/^sha256:[0-9a-f]{64}$/.test(item.artifact.digest) || !item.sourceGoldens.length)) {
      throw new Error(`cache layer evidence is not verified: ${layer}`);
    }
    pins[layer] = evidence.digest;
  }
  if (new Set(QUALIFICATION_CACHE_LAYERS.map(layer => layers[layer].manifest.runId)).size !== QUALIFICATION_CACHE_LAYERS.length) {
    throw new Error('compile/prefix, receipt replay and result cache evidence must come from distinct runs');
  }
  return pins;
}

/** A release record cannot upgrade a HOLD/ROLLBACK from #2037/#2048 integrity. */
export function buildQualificationReleaseRecord(
  executed: ExecutedQualification, input: QualificationReleaseInputs,
): QualificationReleaseRecord {
  const { manifest, report, verification } = executed;
  if (!manifest.runId || !manifest.sourceCommit || !input.environment.trim() || !input.commands.length
    || input.commands.some(command => !command.trim()) || input.integrity.sample_n < 0) {
    throw new Error('incomplete qualification release metadata');
  }
  const derived = input.cacheLayers ? deriveCacheLayerPins(input.cacheLayers) : {};
  for (const [layer, pin] of Object.entries(derived)) {
    if (input.pins[layer] !== undefined && input.pins[layer] !== pin) throw new Error(`release pin ${layer} does not match its evidence`);
  }
  const pinned: Record<string, `sha256:${string}`> = { ...input.pins, ...derived };
  for (const pin of REQUIRED_PINS) {
    if (!/^sha256:[0-9a-f]{64}$/.test(pinned[pin] ?? '')) throw new Error(`missing release pin: ${pin}`);
  }
  if (new Set([pinned.compilePrefixCache, pinned.receiptReplay, pinned.resultCache]).size !== 3) {
    throw new Error('compile/prefix, receipt replay and result cache evidence must be distinct');
  }
  for (const [name, value] of [...Object.entries(input.budgets), ...Object.entries(input.actuals)]) {
    if (!name || !Number.isFinite(value) || value < 0) throw new Error('invalid qualification resource bound');
  }
  const verified = new Map(verification.map(item => [item.caseId, item.verified]));
  const suites = manifest.evidence.map(item => ({
    caseId: item.caseId, outcome: item.outcome, evidenceHash: item.digest, verified: verified.get(item.caseId) === true,
  })).sort((a, b) => a.caseId.localeCompare(b.caseId));
  const releaseDecision = input.integrity.release_gate.decision;
  const withinBudgets = Object.entries(input.budgets).length > 0
    && Object.keys(input.actuals).length === Object.keys(input.budgets).length
    && Object.entries(input.budgets).every(([name, limit]) => input.actuals[name] !== undefined && input.actuals[name] <= limit);
  const integrityVerified = input.integrity.integrity_state === 'verified'
    && input.integrity.integrity_mode !== 'standard'
    && input.integrity.trusted_score_source !== 'local-unverified'
    && input.integrity.compromise_labels.length === 0
    && input.integrity.sample_n > 0 && input.integrity.uncertainty !== null;
  const benchmark = input.benchmark;
  const benchmarkVerified = benchmark !== undefined && benchmark.decision === 'pass'
    && /^sha256:[0-9a-f]{64}$/.test(benchmark.planDigest)
    && benchmark.planDigest === benchmark.trustedPlanDigest
    && Number.isSafeInteger(benchmark.sampleN) && Number.isSafeInteger(benchmark.minimumN)
    && benchmark.minimumN > 0 && benchmark.sampleN >= benchmark.minimumN;
  const snapshot = input.integritySnapshot;
  const snapshotVerified = snapshot !== undefined && /^sha256:[0-9a-f]{64}$/.test(snapshot.digest)
    && Number.isSafeInteger(snapshot.artifactCount) && snapshot.artifactCount > 0;
  const metricsRecorded = input.metrics !== undefined && input.metrics.overall.sampleN > 0;
  const complete = withinBudgets && integrityVerified && benchmarkVerified && snapshotVerified && metricsRecorded && !manifest.dirty && input.reviewer !== null && input.reviewer.trim().length > 0
    && suites.length === manifest.cases.length && suites.every(item => item.outcome === 'pass' && item.verified)
    && report.gates.length === 7 && report.gates.every(gate => gate.status === 'pass')
    && report.decision === 'PROMOTE';
  const decision: QualificationReleaseRecord['decision'] = releaseDecision === 'ROLLBACK'
    || report.decision === 'ROLLBACK' || input.integrity.integrity_state === 'compromised' || input.integrity.compromise_labels.length > 0 ? 'ROLLBACK'
    : complete && releaseDecision === 'PROMOTE' ? 'PROMOTE' : 'HOLD';
  const fields = {
    schemaVersion: 'decision-qualification-release/v1' as const,
    runId: manifest.runId, sourceCommit: manifest.sourceCommit, dirty: manifest.dirty,
    environment: input.environment, commands: [...input.commands],
    pins: Object.fromEntries(Object.entries(pinned).sort(([a], [b]) => a.localeCompare(b))),
    budgets: Object.fromEntries(Object.entries(input.budgets).sort(([a], [b]) => a.localeCompare(b))),
    actuals: Object.fromEntries(Object.entries(input.actuals).sort(([a], [b]) => a.localeCompare(b))),
    reviewer: input.reviewer, suites, gates: [...report.gates].sort((a, b) => a.id.localeCompare(b.id)),
    integrity: input.integrity, benchmark: benchmark ?? null,
    metrics: input.metrics ?? null, integritySnapshot: snapshot ?? null,
    cacheLayers: input.cacheLayers ? Object.fromEntries(QUALIFICATION_CACHE_LAYERS.map(layer => [layer, {
      runId: input.cacheLayers![layer].manifest.runId, digest: input.cacheLayers![layer].digest,
      caseIds: input.cacheLayers![layer].manifest.evidence.map(item => item.caseId).sort() }])) as QualificationReleaseRecord['cacheLayers'] : null,
    decision,
  };
  return { ...fields, digest: `sha256:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}` };
}

/** Deliberately excludes private callback details, stdout/stderr and raw captures. */
export function qualificationReleaseSummary(record: QualificationReleaseRecord): string {
  return [
    `# Qualification ${record.runId}`,
    `- Decision: ${record.decision}`,
    `- Commit: ${record.sourceCommit}${record.dirty ? ' (dirty)' : ''}`,
    `- Integrity: ${record.integrity.integrity_state}; sample_n=${record.integrity.sample_n}; snapshot=${record.integritySnapshot?.digest ?? 'missing'}`,
    `- Held-out: ${record.metrics ? `n=${record.metrics.overall.sampleN}, selective risk=${record.metrics.overall.selectiveRisk ?? 'n/a'}, review rate=${record.metrics.overall.reviewRate}` : 'missing'}`,
    `- Gates: ${record.gates.map(gate => `${gate.id}=${gate.status}`).join(', ')}`,
    `- Evidence: ${record.suites.filter(item => item.verified).length}/${record.suites.length} verified`,
    `- Manifest: ${record.digest}`,
  ].join('\n');
}
