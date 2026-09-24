import { createHash } from 'node:crypto';
import type { ExecutedQualification } from './runner.js';

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
  decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK';
  digest: `sha256:${string}`;
}

const REQUIRED_PINS = [
  'definition', 'ruleset', 'binding', 'adapter', 'requestedModel', 'servedModel',
  'policy', 'calibration', 'dataset', 'split', 'seed', 'priceCatalog',
  'compilePrefixCache', 'receiptReplay', 'resultCache',
] as const;

/** A release record cannot upgrade a HOLD/ROLLBACK from #2037/#2048 integrity. */
export function buildQualificationReleaseRecord(
  executed: ExecutedQualification, input: QualificationReleaseInputs,
): QualificationReleaseRecord {
  const { manifest, report, verification } = executed;
  if (!manifest.runId || !manifest.sourceCommit || !input.environment.trim() || !input.commands.length
    || input.commands.some(command => !command.trim()) || input.integrity.sample_n < 0) {
    throw new Error('incomplete qualification release metadata');
  }
  for (const pin of REQUIRED_PINS) {
    if (!/^sha256:[0-9a-f]{64}$/.test(input.pins[pin] ?? '')) throw new Error(`missing release pin: ${pin}`);
  }
  if (new Set([input.pins.compilePrefixCache, input.pins.receiptReplay, input.pins.resultCache]).size !== 3) {
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
  const complete = withinBudgets && integrityVerified && benchmarkVerified && !manifest.dirty && input.reviewer !== null && input.reviewer.trim().length > 0
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
    pins: Object.fromEntries(Object.entries(input.pins).sort(([a], [b]) => a.localeCompare(b))),
    budgets: Object.fromEntries(Object.entries(input.budgets).sort(([a], [b]) => a.localeCompare(b))),
    actuals: Object.fromEntries(Object.entries(input.actuals).sort(([a], [b]) => a.localeCompare(b))),
    reviewer: input.reviewer, suites, gates: [...report.gates].sort((a, b) => a.id.localeCompare(b.id)),
    integrity: input.integrity, benchmark: benchmark ?? null, decision,
  };
  return { ...fields, digest: `sha256:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}` };
}

/** Deliberately excludes private callback details, stdout/stderr and raw captures. */
export function qualificationReleaseSummary(record: QualificationReleaseRecord): string {
  return [
    `# Qualification ${record.runId}`,
    `- Decision: ${record.decision}`,
    `- Commit: ${record.sourceCommit}${record.dirty ? ' (dirty)' : ''}`,
    `- Integrity: ${record.integrity.integrity_state}; sample_n=${record.integrity.sample_n}`,
    `- Gates: ${record.gates.map(gate => `${gate.id}=${gate.status}`).join(', ')}`,
    `- Evidence: ${record.suites.filter(item => item.verified).length}/${record.suites.length} verified`,
    `- Manifest: ${record.digest}`,
  ].join('\n');
}
