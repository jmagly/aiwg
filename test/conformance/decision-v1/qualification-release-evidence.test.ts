import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DECISION_GATE_SUITES, QUALIFICATION_CACHE_LAYERS, qualificationReleaseSummary,
  type QualificationEvidenceManifest, type QualificationReleaseRecord,
} from '../../../src/decision/index.js';
import { AGGREGATE_CANARIES, AGGREGATE_RELEASE_COMMAND, runAggregateRelease } from './aggregate-release.js';
import { DECISION_CASE_COVERAGE } from './coverage-map.js';

// Retained D11 aggregate release record (#2604). It was produced offline by the
// generator below from a `git archive` export of the exact commit it names, so
// its source tree is clean. Regenerate with AGGREGATE_RELEASE_COMMAND.
const EVIDENCE = 'docs/decision/evidence/d11-aggregate-release-v1';
const RECORDED_COMMIT = 'e37fdd5ba056f9cd797e1681f349c49a325c943b';
const RUN_ID = 'd11-aggregate-release-v1';
const read = (name: string) => readFileSync(`${EVIDENCE}/${name}`);
const json = <T>(name: string): T => JSON.parse(read(name).toString('utf8')) as T;
const sha = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const cacheFile = (layer: string) => `cache-${layer}.json`;

describe('D11 retained exact-commit aggregate release record', () => {
  const out = process.env.AIWG_D11_RELEASE_OUT;
  it.runIf(Boolean(out))('regenerates the retained record from a clean exact-commit tree', async () => {
    const sourceCommit = process.env.AIWG_D11_SOURCE_COMMIT ?? '';
    expect(sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    const root = await mkdtemp(join(tmpdir(), 'd11-release-'));
    const receipts = await mkdtemp(join(tmpdir(), 'd11-release-receipts-'));
    try {
      const run = await runAggregateRelease({ root, receipts, runId: RUN_ID, sourceCommit, dirty: false,
        generatedAt: '2026-09-24T00:00:00.000Z' });
      expect(run.privacyClean).toBe(true);
      await mkdir(out!, { recursive: true });
      await writeFile(join(out!, 'release-record.json'), `${JSON.stringify(run.record, null, 2)}\n`);
      await copyFile(join(root, run.manifestFiles.main), join(out!, 'evidence-manifest.json'));
      for (const layer of QUALIFICATION_CACHE_LAYERS) await copyFile(join(root, run.manifestFiles[layer]), join(out!, cacheFile(layer)));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(receipts, { recursive: true, force: true });
    }
  }, 180_000);

  // Read lazily so the generator above can write the file first.
  let loaded: QualificationReleaseRecord | undefined;
  const retained = () => (loaded ??= json<QualificationReleaseRecord>('release-record.json'));

  it('D11-REL-01 is self-digested, clean, at the recorded commit and bound to the regeneration command', () => {
    const record = retained();
    const { digest, ...fields } = record;
    expect(digest).toBe(sha(JSON.stringify(fields)));
    expect(record).toMatchObject({ schemaVersion: 'decision-qualification-release/v1', runId: RUN_ID,
      sourceCommit: RECORDED_COMMIT, dirty: false, reviewer: null });
    expect(record.commands).toEqual([AGGREGATE_RELEASE_COMMAND]);
    expect(JSON.stringify(record)).not.toMatch(new RegExp(AGGREGATE_CANARIES.join('|')));
  });

  it('D11-REL-02 records every case as verified passing evidence and HOLDs on the live G3/G5/G6 inputs', () => {
    const record = retained();
    expect(record.suites.map(item => item.caseId)).toEqual(DECISION_CASE_COVERAGE.map(item => item.id).sort());
    expect(record.suites.every(item => item.outcome === 'pass' && item.verified && /^sha256:[0-9a-f]{64}$/.test(item.evidenceHash ?? ''))).toBe(true);
    const status = Object.fromEntries(record.gates.map(gate => [gate.id, gate.status]));
    // Held-out data, a load result and a reviewer decision are live inputs tracked in #2684.
    expect(status).toEqual({ G0: 'pass', G1: 'pass', G2: 'pass', G3: 'fail', G4: 'pass', G5: 'fail', G6: 'fail' });
    expect(record.gates.find(gate => gate.id === 'G6')!.missing).toEqual(['evidence:review-decision-recorded']);
    expect(record.integrity.integrity_state).not.toBe('verified');
    expect(record.decision).toBe('HOLD');
    expect(qualificationReleaseSummary(record)).toContain(`Commit: ${RECORDED_COMMIT}`);
    // Every gate suite that the recorded gates rely on is still defined.
    expect(Object.keys(DECISION_GATE_SUITES).length).toBeGreaterThan(0);
  });

  it('D11-REL-03 binds per-case hashes to the retained evidence manifest', () => {
    const record = retained();
    const manifest = json<QualificationEvidenceManifest>('evidence-manifest.json');
    expect(manifest).toMatchObject({ schemaVersion: 'decision-qualification-evidence-manifest/v1', runId: RUN_ID,
      sourceCommit: RECORDED_COMMIT });
    const hashes = Object.fromEntries(record.suites.map(item => [item.caseId, item.evidenceHash]));
    expect(manifest.evidence.map(item => item.caseId).sort()).toEqual(Object.keys(hashes).sort());
    for (const item of manifest.evidence) {
      expect(item.artifact.digest, item.caseId).toBe(hashes[item.caseId]);
      expect(item.sourceGoldens.length, item.caseId).toBeGreaterThanOrEqual(2);
    }
  });

  it('D11-REL-04 derives the three cache-layer pins from distinct retained manifests at the same commit', () => {
    const record = retained();
    const runIds = new Set<string>();
    for (const layer of QUALIFICATION_CACHE_LAYERS) {
      const bytes = read(cacheFile(layer));
      const manifest = JSON.parse(bytes.toString('utf8')) as QualificationEvidenceManifest;
      expect(sha(bytes), layer).toBe(record.pins[layer]);
      expect(record.cacheLayers?.[layer]).toMatchObject({ digest: record.pins[layer], runId: manifest.runId });
      expect(manifest.sourceCommit).toBe(RECORDED_COMMIT);
      expect(manifest.evidence.every(item => item.executable && item.outcome === 'pass')).toBe(true);
      runIds.add(manifest.runId);
    }
    expect(runIds.size).toBe(QUALIFICATION_CACHE_LAYERS.length);
  });
});
