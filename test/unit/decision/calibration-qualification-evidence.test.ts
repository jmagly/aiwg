import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CalibrationRegistry, calibrationArtifactDigest, calibrationIdentityDigest,
  createQualificationEvidenceManifest, executeQualificationPlan,
  validateCalibrationGovernanceReceipt,
  type CalibrationArtifact, type QualificationCase,
} from '../../../src/decision/index.js';
import { calibrationEvidenceIds, executors, identity } from '../../conformance/decision-v1/vectors/calibration.js';

const roots: string[] = [];
const fileDigest = async (path: string) => `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe('D09 calibration qualification and retained evidence', () => {
  it('runs the named CAL compatibility cross-product and vendor TV-10 through the qualification runner', async () => {
    const evidenceIds = await calibrationEvidenceIds();
    const item: QualificationCase = { id: 'TV10', kind: 'vendor', mandatory: true, candidateTests: [
      'test/unit/decision/calibration-qualification-evidence.test.ts',
    ], evidenceIds };
    const root = await mkdtemp(join(tmpdir(), 'calibration-qualification-')); roots.push(root);
    const run = await executeQualificationPlan({
      artifactRoot: root,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'calibration-cross-product-v1',
        generatedAt: '2026-09-22T12:00:00.000Z', sourceCommit: 'fixture-source-not-release', dirty: false, cases: [item] },
      executors,
    });
    expect(run.evidence[0]).toMatchObject({ caseId: 'TV10', outcome: 'pass', testEvidenceIds: [...evidenceIds].sort() });
    const linked = await createQualificationEvidenceManifest(run, root, process.cwd(), {
      TV10: ['test/fixtures/decision/calibration-compatibility-cross-product-v1.json', 'docs/decision/evidence/calibration-rollout-v1.json'],
    });
    expect(linked.evidence[0]?.testEvidenceIds).toEqual([...evidenceIds].sort());
    expect(linked.evidence[0]?.sourceGoldens).toHaveLength(2);
  });

  it('retains exact pins, preregistered sample rules, limitations, rollout phases, and valid promotion/rollback receipts', async () => {
    const rollout = JSON.parse(await readFile('docs/decision/evidence/calibration-rollout-v1.json', 'utf8')) as any;
    expect(rollout.champion).toMatchObject({ state: 'observed', actualModel: 'jev-1.13.0', calibratedAutomationEnabled: false });
    expect(rollout.candidate).toMatchObject({ state: 'shadow', actualModel: 'jev-1.14.0', pairedAgainstChampion: true });
    expect(rollout.heldOutApproval).toMatchObject({ approvalReference: 'approval:fixture-review-17', decision: 'approved-for-fixture-promotion' });
    expect(rollout.sampleCounts.observedTotal).toBeGreaterThanOrEqual(rollout.sampleCounts.minimumTotal);
    expect(rollout.sampleCounts.observedPerSlice).toBeGreaterThanOrEqual(rollout.sampleCounts.minimumPerSlice);
    expect(rollout.limitations.length).toBeGreaterThanOrEqual(3);
    expect(calibrationIdentityDigest(identity)).toMatch(/^sha256:[0-9a-f]{64}$/);
    const promotion = JSON.parse(await readFile(rollout.promotionReceipt, 'utf8'));
    const rollback = JSON.parse(await readFile(rollout.rollbackReceipt, 'utf8'));
    expect(() => validateCalibrationGovernanceReceipt(promotion)).not.toThrow();
    expect(() => validateCalibrationGovernanceReceipt(rollback)).not.toThrow();
    expect(rollback.previousReceiptDigest).toBe(promotion.digest);
    expect([promotion.action, rollback.action]).toEqual(['promote', 'rollback']);

    const manifest = JSON.parse(await readFile(rollout.qualificationManifest, 'utf8')) as any;
    const retained = manifest.evidence.find((entry: any) => entry.caseId === 'TV10');
    expect(retained).toMatchObject({ executable: true, outcome: 'pass' });
    expect(retained.testEvidenceIds).toEqual(expect.arrayContaining(['CAL-EXACT-01', 'DRF-PROMOTE-01', 'DRF-ROLLBACK-01']));
    expect(retained.artifact.digest).toBe(await fileDigest(retained.artifact.path));
    for (const source of retained.sourceGoldens) expect(source.digest).toBe(await fileDigest(source.path));

    const report = JSON.parse(await readFile(rollout.heldOutApproval.report.path, 'utf8'));
    expect(report).toMatchObject({ runId: manifest.runId, decision: 'PROMOTE', reviewedCase: 'TV10' });
    expect(rollout.heldOutApproval.report.digest).toBe(await fileDigest(rollout.heldOutApproval.report.path));

    const retainedArtifact = JSON.parse(await readFile(rollout.calibrationArtifact, 'utf8')) as CalibrationArtifact;
    const { digest, ...artifactPayload } = retainedArtifact;
    expect(digest).toBe(calibrationArtifactDigest(artifactPayload));
    expect(() => new CalibrationRegistry().registerArtifact(retainedArtifact)).not.toThrow();
    expect(rollout.immutableInputs).toMatchObject({
      definitionDigest: retainedArtifact.identity.definitionDigest,
      dataset: retainedArtifact.identity.dataset,
      slice: retainedArtifact.identity.slice,
      split: { id: retainedArtifact.splitProvenance.id, hash: retainedArtifact.splitProvenance.hash },
      adapterVersion: retainedArtifact.identity.adapterVersion,
      primitive: retainedArtifact.identity.primitive,
    });
    expect(promotion.reviewedEvidence.calibrationArtifact).toEqual({ id: retainedArtifact.id, digest });

    const relation = JSON.parse(await readFile(rollout.compatibilityRelation, 'utf8'));
    const relationRegistry = new CalibrationRegistry();
    expect(() => relationRegistry.registerRelation(relation)).not.toThrow();
    expect(promotion.reviewedEvidence.compatibilityRelation).toEqual({ id: relation.id, digest: await fileDigest(rollout.compatibilityRelation) });
    expect(promotion.reviewedEvidence.evaluationIntegrityReport.digest).toBe(await fileDigest(rollout.heldOutApproval.report.path));
    expect(promotion.from.identityDigest).toBe(calibrationIdentityDigest(identity));
    expect(promotion.to.identityDigest).toBe(calibrationIdentityDigest(retainedArtifact.identity));
  });
});
