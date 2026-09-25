import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeQualificationPlan, verifyQualificationArtifacts } from '../../../src/decision/index.js';
import { CASE_IDS, executors } from './vectors/boundary.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('C31/C33 executable offline feature-gate and retry-ownership vectors', () => {
  it('asserts no network when disabled and a single bounded retry owner before emitting evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'decision-boundary-vectors-')); roots.push(root);
    const run = await executeQualificationPlan({ artifactRoot: root, executors, concurrency: 1,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'boundary-vectors',
        generatedAt: '2026-09-24T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true,
        cases: CASE_IDS.map(id => ({ id, kind: 'baseline' as const, mandatory: true,
          candidateTests: ['test/conformance/decision-v1/boundary-vectors.test.ts'] })) },
    });
    expect(run.evidence.map(item => [item.caseId, item.outcome])).toEqual(CASE_IDS.map(id => [id, 'pass']));
    expect((await verifyQualificationArtifacts(run, root)).every(item => item.verified)).toBe(true);
  });

  it.each(CASE_IDS)('%s asserts directly so a failing check reports its diagnostic', async id => {
    await expect(executors[id]({ caseId: id, runId: 'direct', signal: new AbortController().signal }))
      .resolves.toMatchObject({ outcome: 'pass' });
  });
});
