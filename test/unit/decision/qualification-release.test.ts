import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DECISION_RELEASE_GATES } from '../../../src/decision/qualification/gates.js';
import { expectedQualificationCaseIds } from '../../../src/decision/qualification/manifest.js';
import { QUALIFICATION_PRIVACY_SURFACES } from '../../../src/decision/qualification/privacy.js';
import { buildQualificationReleaseRecord, qualificationReleaseSummary } from '../../../src/decision/qualification/release.js';
import { executeAndEvaluateQualification } from '../../../src/decision/qualification/runner.js';
import { buildIntegrityMetadata } from '../../../tools/eval/src/integrity.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const pins = Object.fromEntries([
  'definition', 'ruleset', 'binding', 'adapter', 'requestedModel', 'servedModel', 'policy',
  'calibration', 'dataset', 'split', 'seed', 'priceCatalog', 'compilePrefixCache', 'receiptReplay', 'resultCache',
].map((name, i) => [name, `sha256:${String(i + 1).padStart(64, '0')}`])) as Record<string, `sha256:${string}`>;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'decision-release-'));
  roots.push(root);
  const cases = expectedQualificationCaseIds().map(id => ({ id, kind: id.startsWith('TV') ? 'vendor' as const : 'baseline' as const,
    mandatory: true, candidateTests: [] }));
  const flags = Object.fromEntries(DECISION_RELEASE_GATES.flatMap(gate => gate.requiredEvidence)
    .map(name => [name, () => true]));
  return executeAndEvaluateQualification({
    artifactRoot: root,
    manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'synthetic-release',
      generatedAt: '2026-09-23T00:00:00.000Z', sourceCommit: 'a'.repeat(40), dirty: false, cases },
    executors: Object.fromEntries(cases.map(item => [item.id, () => ({ outcome: 'pass' as const })])),
    evidenceChecks: flags, privacyCanaries: ['synthetic-marker@example.invalid'],
    privacyCaptures: QUALIFICATION_PRIVACY_SURFACES.map(surface => ({ surface, content: '' })),
  });
}

const benchmark = { planDigest: `sha256:${'1'.repeat(64)}` as const,
  trustedPlanDigest: `sha256:${'1'.repeat(64)}` as const, decision: 'pass' as const,
  sampleN: 10, minimumN: 10 };
const integrity = (changedArtifacts: Array<'test_edit' | 'scorer_edit' | 'fixture_edit'> = []) => buildIntegrityMetadata({
  mode: 'locked', freshWorkspaceRequired: false, freshWorkspaceVerified: true,
  changedArtifacts, sampleN: 10, passedN: 10, overallScore: 100,
});

describe('decision qualification release record', () => {
  it('emits a pinned hashable record and redacted human summary from verified evidence', async () => {
    const executed = await fixture();
    expect(executed.report.decision).toBe('PROMOTE');
    const input = { commands: ['vitest run'], environment: 'synthetic-node', pins,
      budgets: { calls: 10 }, actuals: { calls: 0 }, reviewer: 'reviewed-by-operator', integrity: integrity(), benchmark };
    const record = buildQualificationReleaseRecord(executed, input);
    expect(record).toMatchObject({ schemaVersion: 'decision-qualification-release/v1', decision: 'PROMOTE',
      reviewer: 'reviewed-by-operator', budgets: { calls: 10 }, actuals: { calls: 0 } });
    expect(record.suites).toHaveLength(67);
    expect(record.suites.every(item => item.verified)).toBe(true);
    expect(record.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(buildQualificationReleaseRecord({ ...executed, manifest: {
      ...executed.manifest, evidence: [...executed.manifest.evidence].reverse(),
    } }, input).digest).toBe(record.digest);
    expect(qualificationReleaseSummary(record)).toContain('G6=pass');
    expect(qualificationReleaseSummary(record)).not.toContain('reviewed-by-operator');
  });

  it('cannot upgrade HOLD or ROLLBACK, missing pins, dirty workspace or unverified artifacts', async () => {
    const executed = await fixture();
    const input = { commands: ['vitest run'], environment: 'synthetic-node', pins,
      budgets: { calls: 10 }, actuals: { calls: 0 }, reviewer: 'reviewed-by-operator', integrity: integrity(), benchmark };
    expect(buildQualificationReleaseRecord(executed, { ...input, integrity: buildIntegrityMetadata({
      mode: 'standard', freshWorkspaceRequired: false, freshWorkspaceVerified: false,
      changedArtifacts: [], sampleN: 1, passedN: 1, overallScore: 100,
    }) }).decision).toBe('HOLD');
    expect(buildQualificationReleaseRecord(executed, { ...input, integrity: integrity(['fixture_edit']) }).decision).toBe('ROLLBACK');
    expect(buildQualificationReleaseRecord({ ...executed, report: { ...executed.report, decision: 'ROLLBACK' } }, input).decision).toBe('ROLLBACK');
    expect(buildQualificationReleaseRecord({ ...executed, manifest: { ...executed.manifest, dirty: true } }, input).decision).toBe('HOLD');
    expect(buildQualificationReleaseRecord({ ...executed, verification: [] }, input).decision).toBe('HOLD');
    expect(buildQualificationReleaseRecord(executed, { ...input, actuals: { calls: 11 } }).decision).toBe('HOLD');
    expect(buildQualificationReleaseRecord(executed, { ...input, reviewer: null }).decision).toBe('HOLD');
    expect(buildQualificationReleaseRecord(executed, { ...input, benchmark: undefined }).decision).toBe('HOLD');
    expect(buildQualificationReleaseRecord(executed, { ...input,
      benchmark: { ...benchmark, trustedPlanDigest: `sha256:${'2'.repeat(64)}` } }).decision).toBe('HOLD');
    expect(buildQualificationReleaseRecord(executed, { ...input,
      benchmark: { ...benchmark, decision: 'insufficient-evidence' } }).decision).toBe('HOLD');
    expect(buildQualificationReleaseRecord(executed, { ...input,
      benchmark: { ...benchmark, sampleN: 1 } }).decision).toBe('HOLD');
    expect(() => buildQualificationReleaseRecord(executed, { ...input,
      pins: { ...pins, adapter: undefined } as unknown as typeof pins })).toThrow('missing release pin: adapter');
    expect(() => buildQualificationReleaseRecord(executed, { ...input,
      pins: { ...pins, compilePrefixCache: pins.resultCache! } })).toThrow('must be distinct');
  });
});
