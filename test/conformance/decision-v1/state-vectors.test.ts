import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeQualificationPlan, verifyQualificationArtifacts } from '../../../src/decision/index.js';
import { ids, executors } from './vectors/state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('C24-C28/C37-C38/C42 executable offline state vectors', () => {
  it('asserts cancellation, worker terminal contract and receipt replay/persistence outcomes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'decision-state-vectors-')); roots.push(root);
    const run = await executeQualificationPlan({ artifactRoot: root, executors, concurrency: 1,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'state-vectors',
        generatedAt: '2026-09-23T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true,
        cases: ids.map(id => ({ id, kind: 'baseline' as const, mandatory: true,
          candidateTests: ['test/conformance/decision-v1/state-vectors.test.ts'] })) },
    });
    expect(run.evidence.map(item => [item.caseId, item.outcome])).toEqual(ids.map(id => [id, 'pass']));
    expect((await verifyQualificationArtifacts(run, root)).every(item => item.verified)).toBe(true);
  });
});
