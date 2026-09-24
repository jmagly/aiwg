import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QUALIFICATION_PRIVACY_SURFACES } from '../../../src/decision/qualification/privacy.js';
import {
  buildQualificationReleaseRecord, deriveCacheLayerPins, qualificationReleaseSummary, type QualificationCacheLayerEvidence,
} from '../../../src/decision/qualification/release.js';
import { evaluateBinaryHeldout } from '../../../src/decision/qualification/quality.js';
import { executeAndEvaluateQualification } from '../../../src/decision/qualification/runner.js';
import { buildIntegrityMetadata } from '../../../tools/eval/src/integrity.js';
import { createHash } from 'node:crypto';
import { syntheticCases, syntheticSplitPlan, writeGateArtifacts } from './qualification-gate-fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const pins = Object.fromEntries([
  'definition', 'ruleset', 'binding', 'adapter', 'requestedModel', 'servedModel', 'policy',
  'calibration', 'dataset', 'split', 'seed', 'priceCatalog', 'compilePrefixCache', 'receiptReplay', 'resultCache',
].map((name, i) => [name, `sha256:${String(i + 1).padStart(64, '0')}`])) as Record<string, `sha256:${string}`>;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'decision-release-'));
  const sources = await mkdtemp(join(tmpdir(), 'decision-release-gates-'));
  roots.push(root, sources);
  const cases = syntheticCases();
  const manifest = { schemaVersion: 'decision-qualification-run/v1' as const, mode: 'offline' as const, runId: 'synthetic-release',
    generatedAt: '2026-09-23T00:00:00.000Z', sourceCommit: 'a'.repeat(40), dirty: false, cases };
  return executeAndEvaluateQualification({
    artifactRoot: root, manifest, gateArtifacts: await writeGateArtifacts(sources, manifest),
    executors: Object.fromEntries(cases.map(item => [item.id, () => ({ outcome: 'pass' as const })])),
    privacyCanaries: ['synthetic-marker@example.invalid'],
    privacyCaptures: QUALIFICATION_PRIVACY_SURFACES.map(surface => ({ surface, content: '' })),
  });
}

const benchmark = { planDigest: `sha256:${'1'.repeat(64)}` as const,
  trustedPlanDigest: `sha256:${'1'.repeat(64)}` as const, decision: 'pass' as const,
  sampleN: 10, minimumN: 10 };
const plan = syntheticSplitPlan();
const heldout = evaluateBinaryHeldout(plan.splits, plan.splits.find(split => split.name === 'test')!.ids.map((id, index) => ({
  id, slice: 'synthetic', label: (index % 2) as 0 | 1, probability: index % 2 ? 0.9 : 0.1, accepted: true, latencyMs: 10 + index,
  inputTokens: 5, outputTokens: 1, costUsd: null, calls: 1, retries: 0, fallbacks: 0 })));
const metrics = { ...heldout, stability: null, injectionSensitivity: null };
const integritySnapshot = { digest: `sha256:${'9'.repeat(64)}` as const, artifactCount: 3 };
const layer = (runId: string, caseId: string): QualificationCacheLayerEvidence => ({
  digest: `sha256:${createHash('sha256').update(runId).digest('hex')}`,
  manifest: { schemaVersion: 'decision-qualification-evidence-manifest/v1', runId, sourceCommit: 'a'.repeat(40), evidence: [{
    caseId, testEvidenceIds: [], executable: true, outcome: 'pass',
    artifact: { path: `${runId}/${caseId}.json`, digest: `sha256:${'8'.repeat(64)}` },
    sourceGoldens: [{ path: 'src/decision/receipts.ts', digest: `sha256:${'7'.repeat(64)}` }] }] },
});
const cacheLayers = { compilePrefixCache: layer('d30', 'D30-CCP'), receiptReplay: layer('d03', 'D03-REPLAY'),
  resultCache: layer('d15', 'D15-RESULT-CACHE') };
const integrity = (changedArtifacts: Array<'test_edit' | 'scorer_edit' | 'fixture_edit'> = []) => buildIntegrityMetadata({
  mode: 'locked', freshWorkspaceRequired: false, freshWorkspaceVerified: true,
  changedArtifacts, sampleN: 10, passedN: 10, overallScore: 100,
});

describe('decision qualification release record', () => {
  it('emits a pinned hashable record and redacted human summary from verified evidence', async () => {
    const executed = await fixture();
    expect(executed.report.decision).toBe('PROMOTE');
    const input = { commands: ['vitest run'], environment: 'synthetic-node', pins,
      budgets: { calls: 10 }, actuals: { calls: 0 }, reviewer: 'reviewed-by-operator', integrity: integrity(), benchmark,
      metrics, integritySnapshot };
    const record = buildQualificationReleaseRecord(executed, input);
    expect(record).toMatchObject({ schemaVersion: 'decision-qualification-release/v1', decision: 'PROMOTE',
      reviewer: 'reviewed-by-operator', budgets: { calls: 10 }, actuals: { calls: 0 } });
    expect(record.suites).toHaveLength(67);
    expect(record.suites.every(item => item.verified)).toBe(true);
    expect(record.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(buildQualificationReleaseRecord({ ...executed, manifest: {
      ...executed.manifest, evidence: [...executed.manifest.evidence].reverse(),
    } }, input).digest).toBe(record.digest);
    expect(record.metrics?.overall.sampleN).toBe(4);
    expect(record.integritySnapshot).toEqual(integritySnapshot);
    expect(qualificationReleaseSummary(record)).toContain('G6=pass');
    expect(qualificationReleaseSummary(record)).toContain(integritySnapshot.digest);
    expect(qualificationReleaseSummary(record)).not.toContain('reviewed-by-operator');
  });

  it('cannot upgrade HOLD or ROLLBACK, missing pins, dirty workspace or unverified artifacts', async () => {
    const executed = await fixture();
    const input = { commands: ['vitest run'], environment: 'synthetic-node', pins,
      budgets: { calls: 10 }, actuals: { calls: 0 }, reviewer: 'reviewed-by-operator', integrity: integrity(), benchmark,
      metrics, integritySnapshot };
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
    expect(buildQualificationReleaseRecord(executed, { ...input, metrics: undefined }).decision).toBe('HOLD');
    expect(buildQualificationReleaseRecord(executed, { ...input, integritySnapshot: undefined }).decision).toBe('HOLD');
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

  it('AC15 derives compile/prefix, receipt replay and result cache pins from verified layer evidence', async () => {
    const executed = await fixture();
    const { compilePrefixCache: _c, receiptReplay: _r, resultCache: _s, ...basePins } = pins;
    const input = { commands: ['vitest run'], environment: 'synthetic-node', pins: basePins, budgets: { calls: 10 },
      actuals: { calls: 0 }, reviewer: 'reviewed-by-operator', integrity: integrity(), benchmark, metrics, integritySnapshot, cacheLayers };
    const record = buildQualificationReleaseRecord(executed, input);
    expect(record.decision).toBe('PROMOTE');
    expect(record.pins.receiptReplay).toBe(cacheLayers.receiptReplay.digest);
    expect(record.cacheLayers?.compilePrefixCache).toEqual({ runId: 'd30', digest: cacheLayers.compilePrefixCache.digest, caseIds: ['D30-CCP'] });
    expect(() => buildQualificationReleaseRecord(executed, { ...input, pins: { ...basePins, resultCache: pins.resultCache! } }))
      .toThrow('does not match its evidence');
    expect(() => deriveCacheLayerPins({ ...cacheLayers, resultCache: layer('d03', 'D15-RESULT-CACHE') })).toThrow('distinct runs');
    const failed = layer('d15', 'D15-RESULT-CACHE');
    failed.manifest.evidence[0]!.outcome = 'fail';
    expect(() => deriveCacheLayerPins({ ...cacheLayers, resultCache: failed })).toThrow('not verified: resultCache');
  });
});
