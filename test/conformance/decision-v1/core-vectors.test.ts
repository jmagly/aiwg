import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeQualificationPlan, verifyQualificationArtifacts } from '../../../src/decision/index.js';
import { CASE_IDS, executors } from './vectors/core.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('C01-C07 executable offline transport vectors', () => {
  it('asserts each exact primitive outcome or invalid-output class before writing evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'decision-core-vectors-'));
    roots.push(root);
    const run = await executeQualificationPlan({
      artifactRoot: root, executors,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'core-vectors',
        generatedAt: '2026-09-23T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true,
        cases: CASE_IDS.map(id => ({ id, kind: 'baseline' as const, mandatory: true,
          candidateTests: ['test/conformance/decision-v1/core-vectors.test.ts'] })) },
    });
    expect(run.evidence.map(item => [item.caseId, item.outcome])).toEqual(CASE_IDS.map(id => [id, 'pass']));
    expect((await verifyQualificationArtifacts(run, root)).every(item => item.verified)).toBe(true);
  });
});
