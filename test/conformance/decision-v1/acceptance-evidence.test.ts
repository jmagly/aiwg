import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeQualificationPlan, verifyQualificationArtifacts, writeQualificationEvidenceManifest,
} from '../../../src/decision/index.js';
import { CASE_IDS, executors, GOLDENS, SOURCE_ROOT, GOLDEN_ROOT } from './vectors/acceptance.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('primitive acceptance qualification evidence', () => {
  it('retains the checkpointed D11 release manifest and every digest-addressed artifact', async () => {
    const releaseRoot = `${GOLDEN_ROOT}/release`;
    const manifest = JSON.parse(await readFile(`${releaseRoot}/evidence-manifest.json`, 'utf8')) as {
      sourceCommit: string; evidence: Array<{ artifact: { path: string; digest: string }; sourceGoldens: Array<{ path: string; digest: string }> }>;
    };
    expect(manifest.sourceCommit).not.toBe('working-tree');
    for (const entry of manifest.evidence) {
      const artifact = await readFile(join(releaseRoot, entry.artifact.path));
      expect(`sha256:${createHash('sha256').update(artifact).digest('hex')}`).toBe(entry.artifact.digest);
      for (const source of entry.sourceGoldens) {
        const bytes = await readFile(join(SOURCE_ROOT, source.path));
        expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(source.digest);
      }
    }
  });

  it('executes C08-C10 and TV-03/04/05/11 through the qualification runner and emits D11 linkage', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'acceptance-qualification-'));
    roots.push(artifactRoot);
    const cases = CASE_IDS.map(id => ({
      id, kind: id.startsWith('TV') ? 'vendor' as const : 'baseline' as const, mandatory: true,
      candidateTests: ['test/conformance/decision-v1/acceptance-evidence.test.ts'],
    }));
    const run = await executeQualificationPlan({
      artifactRoot,
      manifest: {
        schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'd08-acceptance-v1',
        generatedAt: '2026-09-22T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true, cases,
      },
      executors,
    });
    expect(run.evidence.map(item => [item.caseId, item.executable, item.outcome])).toEqual(
      CASE_IDS.map(id => [id, true, 'pass']),
    );
    expect((await verifyQualificationArtifacts(run, artifactRoot)).every(item => item.verified)).toBe(true);

    const sourceGoldens = {
      C08: [GOLDENS.choice], C09: [GOLDENS.choice], C10: [GOLDENS.choice],
      TV03: [GOLDENS.score], TV04: [GOLDENS.noul], TV05: [GOLDENS.choice],
      TV11: [GOLDENS.noul, GOLDENS.choice],
    };
    const persisted = await writeQualificationEvidenceManifest(
      run, artifactRoot, SOURCE_ROOT, sourceGoldens,
    );
    const evidenceManifest = persisted.manifest;
    expect(evidenceManifest.schemaVersion).toBe('decision-qualification-evidence-manifest/v1');
    expect(evidenceManifest.evidence.map(item => item.caseId)).toEqual(CASE_IDS);
    expect(evidenceManifest.evidence.every(item => item.executable && item.outcome === 'pass'
      && /^sha256:[a-f0-9]{64}$/.test(item.artifact.digest)
      && item.sourceGoldens.length > 0
      && item.sourceGoldens.every(source => /^sha256:[a-f0-9]{64}$/.test(source.digest)))).toBe(true);
    expect(JSON.parse(JSON.stringify(evidenceManifest))).toEqual(evidenceManifest);
    expect(persisted.artifact).toBe('d08-acceptance-v1/evidence-manifest.json');
    expect(persisted.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.parse(await readFile(join(artifactRoot, persisted.artifact), 'utf8'))).toEqual(evidenceManifest);
  });
});
