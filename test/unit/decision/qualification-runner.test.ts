import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeAndEvaluateQualification,
  evaluateExecutedQualification,
  executeQualificationPlan,
  verifyQualificationArtifacts,
} from '../../../src/decision/qualification/runner.js';
import { REQUIRED_VENDOR_CASE_IDS } from '../../../src/decision/qualification/manifest.js';
import { DERIVED_GATE_EVIDENCE } from '../../../src/decision/qualification/gate-evidence.js';
import { QUALIFICATION_PRIVACY_SURFACES } from '../../../src/decision/qualification/privacy.js';
import type { QualificationCase, QualificationRunManifest } from '../../../src/decision/qualification/types.js';
import {
  syntheticCalibration, syntheticCases, syntheticLoadResult, syntheticReview, syntheticSplitPlan, writeGateArtifacts,
} from './qualification-gate-fixtures.js';

const roots: string[] = [];
const generatedAt = '2026-09-22T00:00:00.000Z';

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'decision-qualification-'));
  roots.push(root);
  return root;
}

function manifest(cases: QualificationCase[]): Omit<QualificationRunManifest, 'evidence' | 'evidenceFlags'> {
  return {
    schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'runner-unit', generatedAt,
    sourceCommit: '0123456789abcdef', dirty: false, cases,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// Runner mechanics only. These trivial callbacks are not vector evidence: the
// executable TV/C vectors live in test/conformance/decision-v1/vectors and run
// together in qualification-aggregate.test.ts.
describe('decision qualification executable runner', () => {
  it('RUNNER-MECHANICS-01 invokes every registered callback once and emits independently verifiable artifacts', async () => {
    const root = await artifactRoot();
    const cases = REQUIRED_VENDOR_CASE_IDS.map(id => ({ id, kind: 'vendor' as const, mandatory: true, candidateTests: [] }));
    const seen: string[] = [];
    const executors = Object.fromEntries(cases.map(item => [item.id, ({ caseId }: { caseId: string }) => {
      seen.push(caseId);
      return { outcome: 'pass' as const, details: { vector: caseId } };
    }]));
    const run = await executeQualificationPlan({
      manifest: manifest(cases), artifactRoot: root, executors, concurrency: 3,
      evidenceChecks: { 'runtime-suite-complete': () => true, 'privacy-scan-clean': () => false, 'operator-note': () => true },
    });

    expect(seen.sort()).toEqual([...REQUIRED_VENDOR_CASE_IDS]);
    expect(run.evidence).toHaveLength(25);
    expect(run.evidence.every(item => item.executable && item.outcome === 'pass')).toBe(true);
    // A callback cannot set a derived gate flag; only auxiliary flags pass through.
    expect(run.evidenceFlags['runtime-suite-complete']).toBe(false);
    expect(run.evidenceFlags['privacy-scan-clean']).toBe(false);
    expect(run.evidenceFlags['operator-note']).toBe(true);
    expect(await verifyQualificationArtifacts(run, root)).toEqual(
      REQUIRED_VENDOR_CASE_IDS.map(caseId => ({ caseId, verified: true })),
    );
    const first = JSON.parse(await readFile(join(root, run.evidence[0]!.artifact!), 'utf8')) as Record<string, unknown>;
    expect(first).toMatchObject({ schemaVersion: 'decision-qualification-artifact/v1', caseId: 'TV01', outcome: 'pass' });
  });

  it('derives failure and skip evidence rather than accepting claimed outcomes', async () => {
    const root = await artifactRoot();
    const cases: QualificationCase[] = [
      { id: 'TV01', kind: 'vendor', mandatory: true, candidateTests: [] },
      { id: 'TV02', kind: 'vendor', mandatory: true, candidateTests: [] },
    ];
    const run = await executeQualificationPlan({
      manifest: manifest(cases), artifactRoot: root,
      executors: { TV01: () => { throw new Error('private-test-payload'); } },
    });
    const artifact = await readFile(join(root, run.evidence[0]!.artifact!), 'utf8');
    expect(artifact).toContain('executor-failed');
    expect(artifact).not.toContain('private-test-payload');
    expect(JSON.stringify(run)).not.toContain('private-test-payload');
    expect(run.evidence.map(item => ({ id: item.caseId, executable: item.executable, outcome: item.outcome }))).toEqual([
      { id: 'TV01', executable: true, outcome: 'fail' },
      { id: 'TV02', executable: false, outcome: 'skip' },
    ]);
  });

  it('does not persist private callback details by default, including on failure', async () => {
    const root = await artifactRoot();
    const item: QualificationCase = { id: 'TV01', kind: 'vendor', mandatory: true, candidateTests: [] };
    const marker = 'private-canary@example.invalid';
    const run = await executeQualificationPlan({
      manifest: manifest([item]), artifactRoot: root,
      executors: { TV01: () => ({ outcome: 'fail', details: { trace: marker, nested: [marker] } }) },
    });
    const artifact = await readFile(join(root, run.evidence[0]!.artifact!), 'utf8');
    expect(artifact).not.toContain(marker);
    expect(artifact).not.toContain('details');
    expect(JSON.stringify(run)).not.toContain(marker);
    expect(await verifyQualificationArtifacts(run, root)).toEqual([{ caseId: 'TV01', verified: true }]);
  });

  it('fails closed when a public-details sanitizer throws without exporting its error', async () => {
    const root = await artifactRoot();
    const item: QualificationCase = { id: 'TV01', kind: 'vendor', mandatory: true, candidateTests: [] };
    const marker = 'private-canary@example.invalid';
    const run = await executeQualificationPlan({
      manifest: manifest([item]), artifactRoot: root,
      executors: { TV01: () => ({ outcome: 'pass', details: { trace: marker } }) },
      sanitizeDetails: () => { throw new Error(marker); },
    });
    expect(run.evidence[0]).toMatchObject({ outcome: 'fail' });
    const artifact = await readFile(join(root, run.evidence[0]!.artifact!), 'utf8');
    expect(artifact).toContain('details-sanitization-failed');
    expect(artifact).not.toContain(marker);
  });

  it('PRV-CANARY-01 rejects a canary in selected public details without persisting it', async () => {
    const root = await artifactRoot();
    const item: QualificationCase = { id: 'TV01', kind: 'vendor', mandatory: true, candidateTests: [] };
    const marker = 'canary@example.invalid';
    const run = await executeQualificationPlan({
      manifest: manifest([item]), artifactRoot: root,
      executors: { TV01: () => ({ outcome: 'pass', details: { nested: [marker] } }) },
      sanitizeDetails: value => value,
      privacyCanaries: [marker],
    });
    const artifact = await readFile(join(root, run.evidence[0]!.artifact!), 'utf8');
    expect(run.evidence[0]?.outcome).toBe('fail');
    expect(artifact).toContain('privacy-canary-detected');
    expect(artifact).not.toContain(marker);
    expect(JSON.stringify(run)).not.toContain(marker);
    expect((await evaluateExecutedQualification(run, root)).report.decision).toBe('HOLD');
  });

  it('PRV-CANARY-02 detects escaped canaries and rejects malformed canary sets', async () => {
    const root = await artifactRoot();
    const item: QualificationCase = { id: 'TV01', kind: 'vendor', mandatory: true, candidateTests: [] };
    const marker = 'private\nmarker';
    const plan = {
      manifest: manifest([item]), artifactRoot: root,
      executors: { TV01: () => ({ outcome: 'pass' as const, details: { marker } }) },
      sanitizeDetails: (value: unknown) => value,
    };
    const run = await executeQualificationPlan({ ...plan, privacyCanaries: [marker] });
    expect(run.evidence[0]?.outcome).toBe('fail');
    const artifact = await readFile(join(root, run.evidence[0]!.artifact!), 'utf8');
    expect(artifact).not.toContain('private');
    await expect(executeQualificationPlan({ ...plan, privacyCanaries: [''] })).rejects.toThrow('privacy canaries must be nonempty');
  });

  it('LIVE-ABSENT-01 reports an explicit skip and never labels mock execution live', async () => {
    const root = await artifactRoot();
    const item: QualificationCase = { id: 'TV01', kind: 'vendor', mandatory: true, candidateTests: [] };
    let calls = 0;
    const run = await executeQualificationPlan({
      manifest: { ...manifest([item]), mode: 'live' }, artifactRoot: root,
      executors: { TV01: () => { calls++; return { outcome: 'pass' }; } },
    });
    expect(calls).toBe(0);
    expect(run.evidence[0]).toMatchObject({ executable: false, outcome: 'skip' });
    const artifact = await readFile(join(root, run.evidence[0]!.artifact!), 'utf8');
    expect(artifact).toContain('live-evidence-unavailable');
    expect((await evaluateExecutedQualification(run, root)).report.gates[0]?.missing).toContain('case:TV01');
  });

  it('PRV-G2-01 prevents a positive callback from forging a privacy scan', async () => {
    const root = await artifactRoot();
    const cases: QualificationCase[] = [{ id: 'TV01', kind: 'vendor', mandatory: true, candidateTests: [] }];
    const plan = {
      manifest: manifest(cases), artifactRoot: root,
      executors: { TV01: () => ({ outcome: 'pass' as const }) },
      evidenceChecks: { 'privacy-scan-clean': () => true },
      privacyCanaries: ['canary@example.invalid'],
    };
    expect((await executeQualificationPlan(plan)).evidenceFlags['privacy-scan-clean']).toBe(false);
    const captures = QUALIFICATION_PRIVACY_SURFACES.map(surface => ({ surface, content: '' }));
    expect((await executeQualificationPlan({ ...plan, privacyCaptures: captures })).evidenceFlags['privacy-scan-clean']).toBe(true);
    expect((await executeQualificationPlan({ ...plan, privacyCaptures: captures.slice(1) })).evidenceFlags['privacy-scan-clean']).toBe(false);
  });

  it('links persisted qualification artifacts to named CAL and DRF master-plan evidence IDs', async () => {
    const root = await artifactRoot();
    const cases: QualificationCase[] = [
      { id: 'TV01', kind: 'vendor', mandatory: true, candidateTests: ['test/unit/unrelated.test.ts'], evidenceIds: ['CAL-COMPAT-01', 'DRF-ALIAS-01'] },
    ];
    const run = await executeQualificationPlan({
      manifest: manifest(cases), artifactRoot: root, executors: { TV01: () => ({ outcome: 'pass' }) },
    });
    expect(run.evidence[0]?.testEvidenceIds).toEqual(['CAL-COMPAT-01', 'DRF-ALIAS-01']);
    const artifact = JSON.parse(await readFile(join(root, run.evidence[0]!.artifact!), 'utf8')) as Record<string, unknown>;
    expect(artifact.testEvidenceIds).toEqual(['CAL-COMPAT-01', 'DRF-ALIAS-01']);
    expect(await verifyQualificationArtifacts(run, root)).toEqual([{ caseId: 'TV01', verified: true }]);

    run.evidence[0]!.testEvidenceIds = ['CAL-FORGED-01'];
    expect(await verifyQualificationArtifacts(run, root)).toEqual([{ caseId: 'TV01', verified: false, reason: 'invalid-artifact' }]);
  });

  it('fails promotion evaluation closed after artifact tampering', async () => {
    const root = await artifactRoot();
    const item: QualificationCase = { id: 'TV01', kind: 'vendor', mandatory: true, candidateTests: [] };
    const run = await executeQualificationPlan({
      manifest: manifest([item]), artifactRoot: root, executors: { TV01: () => ({ outcome: 'pass' }) },
    });
    await writeFile(join(root, run.evidence[0]!.artifact!), '{"tampered":true}\n');

    const evaluated = await evaluateExecutedQualification(run, root);
    expect(evaluated.verification).toEqual([{ caseId: 'TV01', verified: false, reason: 'digest-mismatch' }]);
    expect(evaluated.report.decision).toBe('HOLD');
    expect(evaluated.report.gates[0]?.missing).toContain('case:TV01');
  });

  it('rejects traversal and symlink artifact references', async () => {
    const root = await artifactRoot();
    const outside = join(root, '..', `qualification-outside-${Date.now()}.json`);
    roots.push(outside);
    await writeFile(outside, '{}');
    await symlink(outside, join(root, 'linked.json'));
    const base: QualificationRunManifest = {
      ...manifest([{ id: 'TV01', kind: 'vendor', mandatory: true, candidateTests: [] }]),
      evidenceFlags: {}, evidence: [{ caseId: 'TV01', executable: true, outcome: 'pass', artifact: '../outside.json', digest: `sha256:${'a'.repeat(64)}` }],
    };
    expect(await verifyQualificationArtifacts(base, root)).toEqual([{ caseId: 'TV01', verified: false, reason: 'unsafe-path' }]);
    base.evidence[0]!.artifact = 'linked.json';
    expect(await verifyQualificationArtifacts(base, root)).toEqual([{ caseId: 'TV01', verified: false, reason: 'not-file' }]);
  });

  it('bounds execution time and artifact size', async () => {
    const root = await artifactRoot();
    const item: QualificationCase = { id: 'TV01', kind: 'vendor', mandatory: true, candidateTests: [] };
    const timed = await executeQualificationPlan({
      manifest: manifest([item]), artifactRoot: root, timeoutMs: 5,
      executors: { TV01: async () => new Promise(resolve => setTimeout(() => resolve({ outcome: 'pass' }), 50)) },
    });
    expect(timed.evidence[0]).toMatchObject({ executable: true, outcome: 'fail' });
    await expect(executeQualificationPlan({
      manifest: manifest([item]), artifactRoot: root, maxArtifactBytes: 256,
      executors: { TV01: () => ({ outcome: 'pass', details: 'x'.repeat(1_000) }) },
      sanitizeDetails: details => details,
    })).rejects.toThrow('artifact exceeds 256 bytes');
  });

  it('promotes through the combined pipeline only after all executions, derived suites, gate artifacts, and hashes pass', async () => {
    const root = await artifactRoot();
    const cases = syntheticCases();
    const executors = Object.fromEntries(cases.map(({ id }) => [id, () => ({ outcome: 'pass' as const })]));
    const gateArtifacts = await writeGateArtifacts(await artifactRoot(), manifest(cases));

    const result = await executeAndEvaluateQualification({
      manifest: manifest(cases), artifactRoot: root, executors, gateArtifacts, concurrency: 8,
      privacyCanaries: ['canary@example.invalid'],
      privacyCaptures: QUALIFICATION_PRIVACY_SURFACES.map(surface => ({ surface, content: '' })),
    });
    expect(result.verification).toHaveLength(67);
    expect(result.verification.every(item => item.verified)).toBe(true);
    expect(result.gateVerification.map(item => [item.flag, item.verified])).toEqual([
      ['immutable-splits', true], ['calibration-qualified', true], ['load-manifest-qualified', true], ['review-decision-recorded', true],
    ]);
    expect(result.report.gates.every(gate => gate.status === 'pass')).toBe(true);
    expect(result.report.decision).toBe('PROMOTE');
  });

  it('GATE-DERIVED-01 ignores positive callbacks for every derived flag and never invokes them', async () => {
    const root = await artifactRoot();
    const cases = syntheticCases();
    let invoked = 0;
    const evidenceChecks = Object.fromEntries(DERIVED_GATE_EVIDENCE.map(name => [name, () => { invoked++; return true; }]));
    const result = await executeAndEvaluateQualification({
      manifest: manifest(cases), artifactRoot: root, evidenceChecks,
      executors: Object.fromEntries(cases.filter(item => item.id !== 'C31').map(({ id }) => [id, () => ({ outcome: 'pass' as const })])),
    });
    expect(invoked).toBe(0);
    const gate = (id: string) => result.report.gates.find(item => item.id === id)!;
    // G0 inventory is computed; G1 needs its recorded suite; G3/G5/G6 need artifacts.
    expect(gate('G0').missing).toContain('case:C31');
    expect(gate('G1')).toMatchObject({ status: 'fail', missing: ['evidence:runtime-suite-complete'] });
    expect(gate('G2').missing).toEqual(['evidence:privacy-scan-clean']);
    expect(gate('G3').missing).toEqual(['evidence:calibration-qualified', 'evidence:immutable-splits']);
    expect(gate('G4').missing).toEqual([]);
    expect(gate('G5').missing).toEqual(['evidence:load-manifest-qualified']);
    expect(gate('G6').missing).toEqual(['evidence:review-decision-recorded']);
    expect(result.report.decision).toBe('HOLD');
  });

  it('GATE-DERIVED-02 fails suites whose recorded case evidence failed, even with a positive callback', async () => {
    const root = await artifactRoot();
    const cases = syntheticCases();
    const failing = new Set(['C29', 'C13', 'TV10']);
    const result = await executeAndEvaluateQualification({
      manifest: manifest(cases), artifactRoot: root,
      evidenceChecks: { 'security-suite-complete': () => true, 'fault-suite-complete': () => true, 'drift-suite-complete': () => true },
      executors: Object.fromEntries(cases.map(({ id }) => [id, () => ({ outcome: failing.has(id) ? 'fail' as const : 'pass' as const })])),
    });
    const missing = (id: string) => result.report.gates.find(item => item.id === id)!.missing;
    expect(missing('G2')).toContain('evidence:security-suite-complete');
    expect(missing('G4')).toEqual(['evidence:drift-suite-complete', 'evidence:fault-suite-complete']);
    expect(missing('G1')).toEqual([]);
  });

  it('GATE-ARTIFACT-01 rejects invalid, unbound, or tampered gate artifacts', async () => {
    const cases = syntheticCases();
    const executors = Object.fromEntries(cases.map(({ id }) => [id, () => ({ outcome: 'pass' as const })]));
    const sources = await artifactRoot();
    const plan = (root: string, gateArtifacts: Awaited<ReturnType<typeof writeGateArtifacts>>) => ({
      manifest: manifest(cases), artifactRoot: root, executors, gateArtifacts,
      privacyCanaries: ['canary@example.invalid'],
      privacyCaptures: QUALIFICATION_PRIVACY_SURFACES.map(surface => ({ surface, content: '' })),
    });
    const valid = await writeGateArtifacts(sources, manifest(cases));

    // A review signed for other outcomes or rejecting the run, an over-bound load result, calibration
    // bound to a different split plan, or a split plan whose digest no longer matches is not evidence.
    const variants: Array<[string, string, unknown]> = [
      ['review-decision-recorded', 'G6', syntheticReview({ ...manifest(cases), runId: 'other-run' })],
      ['review-decision-recorded', 'G6', syntheticReview(manifest(cases), { decision: 'reject' })],
      ['load-manifest-qualified', 'G5', syntheticLoadResult({ maximumActiveCalls: 4, maximumQueuedCalls: 1, maximumRetryAmplificationRatio: 1 })],
      ['calibration-qualified', 'G3', syntheticCalibration(`sha256:${'f'.repeat(64)}`)],
      ['immutable-splits', 'G3', { ...syntheticSplitPlan(), minimumOverallN: 1 }],
    ];
    for (const [flag, gateId, value] of variants) {
      const path = join(sources, `${flag}.invalid.json`);
      await writeFile(path, JSON.stringify(value));
      const result = await executeAndEvaluateQualification(plan(await artifactRoot(), { ...valid, [flag]: path }));
      expect(result.manifest.gateArtifacts?.[flag]).toBeUndefined();
      expect(result.report.gates.find(item => item.id === gateId)!.missing).toContain(`evidence:${flag}`);
      expect(result.report.decision).toBe('HOLD');
    }

    const root = await artifactRoot();
    const run = await executeQualificationPlan(plan(root, valid));
    expect((await evaluateExecutedQualification(run, root)).report.decision).toBe('PROMOTE');
    await writeFile(join(root, run.gateArtifacts!['load-manifest-qualified']!.artifact), '{"tampered":true}\n');
    const tampered = await evaluateExecutedQualification(run, root);
    expect(tampered.gateVerification.find(item => item.flag === 'load-manifest-qualified')).toMatchObject({ verified: false, reason: 'digest-mismatch' });
    expect(tampered.report.gates.find(item => item.id === 'G5')!.missing).toEqual(['evidence:load-manifest-qualified']);
    expect(tampered.report.gates.find(item => item.id === 'G6')!.missing).toEqual(['evidence:evidence-hashes-verified']);
    expect(tampered.report.decision).toBe('HOLD');
  });
});
