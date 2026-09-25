import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeQualificationPlan, verifyQualificationArtifacts } from '../../../src/decision/index.js';
import { CASE_IDS, executors } from './vectors/runtime.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('C11-C18 executable offline runtime vectors', () => {
  it('asserts bounded retry, terminal errors, fallback and budget outcomes before emitting hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'decision-runtime-vectors-'));
    roots.push(root);
    const run = await executeQualificationPlan({ artifactRoot: root, executors,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'runtime-vectors',
        generatedAt: '2026-09-23T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true,
        cases: CASE_IDS.map(id => ({ id, kind: 'baseline' as const, mandatory: true,
          candidateTests: ['test/conformance/decision-v1/runtime-vectors.test.ts'] })) },
    });
    expect(run.evidence.map(item => [item.caseId, item.outcome])).toEqual(CASE_IDS.map(id => [id, 'pass']));
    expect((await verifyQualificationArtifacts(run, root)).every(item => item.verified)).toBe(true);
  });
});
