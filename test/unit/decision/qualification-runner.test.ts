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
import { expectedQualificationCaseIds, REQUIRED_VENDOR_CASE_IDS } from '../../../src/decision/qualification/manifest.js';
import { DECISION_RELEASE_GATES } from '../../../src/decision/qualification/gates.js';
import type { QualificationCase, QualificationRunManifest } from '../../../src/decision/qualification/types.js';

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

describe('decision qualification executable runner', () => {
  it('executes all TV01-TV25 vectors and emits independently verifiable artifacts', async () => {
    const root = await artifactRoot();
    const cases = REQUIRED_VENDOR_CASE_IDS.map(id => ({ id, kind: 'vendor' as const, mandatory: true, candidateTests: [] }));
    const seen: string[] = [];
    const executors = Object.fromEntries(cases.map(item => [item.id, ({ caseId }: { caseId: string }) => {
      seen.push(caseId);
      return { outcome: 'pass' as const, details: { vector: caseId } };
    }]));
    const run = await executeQualificationPlan({
      manifest: manifest(cases), artifactRoot: root, executors, concurrency: 3,
      evidenceChecks: { 'runtime-suite-complete': () => true, 'privacy-scan-clean': () => false },
    });

    expect(seen.sort()).toEqual([...REQUIRED_VENDOR_CASE_IDS]);
    expect(run.evidence).toHaveLength(25);
    expect(run.evidence.every(item => item.executable && item.outcome === 'pass')).toBe(true);
    expect(run.evidenceFlags).toEqual({ 'privacy-scan-clean': false, 'runtime-suite-complete': true });
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
      executors: { TV01: () => { throw new Error('observed mismatch'); } },
    });
    expect(run.evidence.map(item => ({ id: item.caseId, executable: item.executable, outcome: item.outcome }))).toEqual([
      { id: 'TV01', executable: true, outcome: 'fail' },
      { id: 'TV02', executable: false, outcome: 'skip' },
    ]);
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
    })).rejects.toThrow('artifact exceeds 256 bytes');
  });

  it('promotes through the combined pipeline only after all executions, checks, and hashes pass', async () => {
    const root = await artifactRoot();
    const cases = expectedQualificationCaseIds().map(id => ({
      id, kind: id.startsWith('TV') ? 'vendor' as const : 'baseline' as const, mandatory: true, candidateTests: [],
    }));
    const executors = Object.fromEntries(cases.map(({ id }) => [id, () => ({ outcome: 'pass' as const })]));
    const requiredFlags = [...new Set(DECISION_RELEASE_GATES.flatMap(gate => gate.requiredEvidence))];
    const evidenceChecks = Object.fromEntries(requiredFlags.map(name => [name, () => true]));

    const result = await executeAndEvaluateQualification({
      manifest: manifest(cases), artifactRoot: root, executors, evidenceChecks, concurrency: 8,
    });
    expect(result.verification).toHaveLength(67);
    expect(result.verification.every(item => item.verified)).toBe(true);
    expect(result.report.gates.every(gate => gate.status === 'pass')).toBe(true);
    expect(result.report.decision).toBe('PROMOTE');
  });
});
