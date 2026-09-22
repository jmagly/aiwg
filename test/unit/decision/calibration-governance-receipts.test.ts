import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CalibrationGovernanceReceiptError,
  FileCalibrationGovernanceReceiptStore,
  createCalibrationGovernanceReceipt,
  type CalibrationDigest,
} from '../../../src/decision/index.js';

const roots: string[] = [];
const hash = (character: string) => `sha256:${character.repeat(64)}` as CalibrationDigest;

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe('calibration promotion and rollback receipts', () => {
  it('DRF-PROMOTE-01 and DRF-ROLLBACK-01 persist reviewed action evidence in an immutable hash chain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'calibration-governance-'));
    roots.push(root);
    const store = new FileCalibrationGovernanceReceiptStore(root);
    const reviewedEvidence = {
      evaluationIntegrityReport: { id: 'qualification:run-42', digest: hash('a') },
      calibrationArtifact: { id: 'calibration:jev-v2', digest: hash('b') },
      compatibilityRelation: { id: 'compatibility:v1-v2', digest: hash('c') },
    };
    const promotion = createCalibrationGovernanceReceipt({
      receiptId: 'promotion:jev-latest:2', sequence: 1, kind: 'promotion', alias: 'jev-latest',
      from: { aliasRevision: 1, identityDigest: hash('d') }, to: { aliasRevision: 2, identityDigest: hash('e') },
      action: 'promote', reviewedEvidence, approvalReference: 'approval:change-17', eligibilityId: 'eligibility:jev-v2',
      reasons: ['qualification-gates-passed', 'review-approved'], recordedAt: '2026-09-22T12:00:00.000Z', previousReceiptDigest: null,
    });
    await store.append(promotion);
    const rollback = createCalibrationGovernanceReceipt({
      receiptId: 'rollback:jev-latest:3', sequence: 2, kind: 'rollback', alias: 'jev-latest',
      from: { aliasRevision: 2, identityDigest: hash('e') }, to: { aliasRevision: 1, identityDigest: hash('d') },
      action: 'rollback', reviewedEvidence, approvalReference: 'approval:incident-9', eligibilityId: null,
      reasons: ['preregistered-drift-bound-breached'], recordedAt: '2026-09-22T13:00:00.000Z', previousReceiptDigest: promotion.digest,
    });
    await store.append(rollback);

    const history = await store.readHistory();
    expect(history).toEqual([promotion, rollback]);
    expect(history[1]).toMatchObject({ previousReceiptDigest: promotion.digest, reviewedEvidence, action: 'rollback' });

    const secondPath = join(root, '000000000002.json');
    const altered = JSON.parse(await readFile(secondPath, 'utf8')) as Record<string, unknown>;
    altered.reasons = ['history-rewritten'];
    await writeFile(secondPath, `${JSON.stringify(altered)}\n`);
    await expect(store.readHistory()).rejects.toThrow(CalibrationGovernanceReceiptError);
  });

  it('fails closed when an append does not extend the durable ledger head', async () => {
    const root = await mkdtemp(join(tmpdir(), 'calibration-governance-'));
    roots.push(root);
    const store = new FileCalibrationGovernanceReceiptStore(root);
    const draft = {
      receiptId: 'promotion:1', sequence: 1, kind: 'promotion' as const, alias: 'jev-latest',
      from: { aliasRevision: 1, identityDigest: hash('a') }, to: { aliasRevision: 2, identityDigest: hash('b') },
      action: 'promote' as const,
      reviewedEvidence: { evaluationIntegrityReport: { id: 'report', digest: hash('c') }, calibrationArtifact: { id: 'cal', digest: hash('d') }, compatibilityRelation: null },
      approvalReference: 'approval', eligibilityId: 'eligibility', reasons: ['approved'], recordedAt: '2026-09-22T12:00:00.000Z', previousReceiptDigest: null,
    };
    const first = createCalibrationGovernanceReceipt(draft);
    await store.append(first);
    await expect(store.append(first)).rejects.toThrow('does not extend');
  });
});
