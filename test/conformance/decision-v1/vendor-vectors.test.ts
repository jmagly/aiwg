import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeQualificationPlan, REQUIRED_VENDOR_CASE_IDS, verifyQualificationArtifacts } from '../../../src/decision/index.js';
import { CASE_IDS, EVIDENCE_IDS, executors, vendorCatalog } from './vectors/vendor.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('TV02-TV25 executable offline vendor vectors', () => {
  it('checks in a definition, assumption and expected outcome for every TV01-TV25 vector', async () => {
    const catalog = await vendorCatalog();
    expect(catalog.map(item => item.id)).toEqual([...REQUIRED_VENDOR_CASE_IDS]);
    for (const item of catalog) {
      expect(item.title && item.basis && item.assumption && item.suite).toBeTruthy();
      expect(Object.keys(item.expected).length).toBeGreaterThan(0);
    }
    for (const id of CASE_IDS) expect(catalog.find(item => item.id === id)?.suite).toBe('test/conformance/decision-v1/vendor-vectors.test.ts');
  });

  it('asserts each exact normalized outcome or failure class before writing evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'decision-vendor-vectors-')); roots.push(root);
    const run = await executeQualificationPlan({ artifactRoot: root, executors, concurrency: 1,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'vendor-vectors',
        generatedAt: '2026-09-24T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true,
        cases: CASE_IDS.map(id => ({ id, kind: 'vendor' as const, mandatory: true, evidenceIds: [...(EVIDENCE_IDS[id] ?? [])],
          candidateTests: ['test/conformance/decision-v1/vendor-vectors.test.ts'] })) },
    });
    expect(run.evidence.map(item => [item.caseId, item.outcome])).toEqual(CASE_IDS.map(id => [id, 'pass']));
    expect((await verifyQualificationArtifacts(run, root)).every(item => item.verified)).toBe(true);
  }, 60_000);

  it.each(CASE_IDS)('%s asserts directly so a failing check reports its diagnostic', async id => {
    await expect(executors[id]({ caseId: id, runId: 'direct', signal: new AbortController().signal }))
      .resolves.toMatchObject({ outcome: 'pass' });
  });
});
