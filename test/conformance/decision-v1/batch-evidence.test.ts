import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeQualificationPlan,
  verifyQualificationArtifacts,
  writeQualificationEvidenceManifest,
  type QualificationCaseExecutor,
} from '../../../src/decision/index.js';
import { CASE_IDS, createBatchExecutors, DEFAULT_BATCH_INPUTS, type BatchBenchmarkInputs } from './vectors/batch.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function run(executors: Readonly<Record<string, QualificationCaseExecutor>>, runId: string) {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'batch-qualification-'));
  roots.push(artifactRoot);
  const manifest = await executeQualificationPlan({
    artifactRoot, executors,
    manifest: {
      schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId,
      generatedAt: '2026-09-22T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true,
      cases: CASE_IDS.map(id => ({ id, kind: 'vendor' as const, mandatory: true,
        candidateTests: ['test/conformance/decision-v1/batch-evidence.test.ts'] })),
    },
  });
  return { artifactRoot, manifest };
}

const outcomes = (manifest: Awaited<ReturnType<typeof run>>['manifest']) =>
  Object.fromEntries(manifest.evidence.map(item => [item.caseId, item.outcome]));

describe('native batch qualification evidence', () => {
  it('executes a paired workload and links TV01/TV08/TV22 into D11-verifiable artifacts', async () => {
    const { artifactRoot, manifest } = await run(createBatchExecutors(), 'd04-native-batch-v1');
    expect(manifest.evidence.map(item => [item.caseId, item.outcome])).toEqual(CASE_IDS.map(id => [id, 'pass']));
    expect((await verifyQualificationArtifacts(manifest, artifactRoot)).every(item => item.verified)).toBe(true);
    const linked = await writeQualificationEvidenceManifest(manifest, artifactRoot, '.', Object.fromEntries(
      CASE_IDS.map(id => [id, ['examples/decision/input.json', 'examples/decision/binding-jev.json']]),
    ));
    expect(linked.manifest.evidence.map(item => item.caseId)).toEqual(CASE_IDS);
    expect(linked.manifest.evidence.every(item => item.executable && item.outcome === 'pass'
      && item.sourceGoldens.length === 2)).toBe(true);
    expect(linked.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each<[string, Partial<BatchBenchmarkInputs>, Record<string, 'pass' | 'fail'>]>([
    ['native batching disabled', { nativeBatching: false }, { TV01: 'fail', TV08: 'pass', TV22: 'fail' }],
    ['native answer diverges from single calls', { nativeChoice: 'runtime' }, { TV01: 'pass', TV08: 'fail', TV22: 'pass' }],
  ])('records fail, not pass, when the benchmark input is mutated: %s', async (_name, mutation, expected) => {
    const { manifest } = await run(createBatchExecutors({ ...DEFAULT_BATCH_INPUTS, ...mutation }), 'd04-native-batch-mutated');
    expect(outcomes(manifest)).toEqual(expected);
    expect(manifest.evidence.every(item => item.executable)).toBe(true);
  });
});
