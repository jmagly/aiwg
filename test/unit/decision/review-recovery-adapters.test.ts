import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileVerifiedReviewEffectLedger, WorkspaceReviewSessionAudit, auditedReviewReconciler } from '../../../src/decision/review/index.js';
import type { SessionRepository } from '../../../src/sessions/repository.js';

const query = { tenantId: 'tenant-a', projectId: 'project-a', reviewId: 'review-a', effectId: 'effect-a' };
const receipt = { effectId: query.effectId, continuationId: 'continuation-a', proposalVersion: 1,
  completedAtEpochMs: 1000, result: { delivered: true } };
const key = Buffer.alloc(32, 7);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const directory = async () => { const dir = await mkdtemp(join(tmpdir(), 'review-ledger-')); dirs.push(dir); return dir; };

describe('executor-owned receipt journal', () => {
  it('survives restart, accepts identical duplicate and rejects conflicting writers', async () => {
    const dir = await directory();
    const ledger = new FileVerifiedReviewEffectLedger(dir, key);
    expect(await ledger.recordCompleted(query, receipt)).toBe(true);
    expect(await new FileVerifiedReviewEffectLedger(dir, key).completedReceipt(query)).toEqual(receipt);
    expect(await ledger.recordCompleted(query, receipt)).toBe(false);
    await expect(ledger.recordCompleted(query, { ...receipt, result: 'different' })).rejects.toThrow(/Conflicting/);
    expect(await ledger.completedReceipt({ ...query, projectId: 'other' })).toBeNull();
    await expect(new FileVerifiedReviewEffectLedger(dir, Buffer.alloc(32, 8)).completedReceipt(query)).rejects.toThrow(/Invalid/);
  });
  it('fails closed on tampered receipt and invalid identity', async () => {
    const dir = await directory(); const ledger = new FileVerifiedReviewEffectLedger(dir, key);
    await expect(ledger.recordCompleted(query, { ...receipt, effectId: 'other' })).rejects.toThrow(/Invalid/);
    await ledger.recordCompleted(query, receipt);
    const path = join(dir, (await (await import('node:fs/promises')).readdir(dir)).find(name => name.endsWith('.json'))!);
    const envelope = JSON.parse(await readFile(path, 'utf8'));
    envelope.record.receipt.result = 'forged';
    await writeFile(path, JSON.stringify(envelope));
    await expect(ledger.completedReceipt(query)).rejects.toThrow(/Invalid/);
  });
});

describe('workspace-scoped production catalog reader', () => {
  it('requires exact session, completed coverage and unique attempt before consulting ledger', async () => {
    const dir = await directory(); const ledger = new FileVerifiedReviewEffectLedger(dir, key);
    const refresh = vi.fn(async () => {});
    const event = { eventId: 'attempt-1', marker: { reviewId: query.reviewId, effectId: query.effectId } };
    const repository = { getSession: vi.fn(() => ({ consistency: 'complete' })),
      getCoverage: vi.fn(() => ({ status: 'complete' })), listEvents: vi.fn(() => [event]) } as unknown as SessionRepository;
    const catalog = new WorkspaceReviewSessionAudit(repository, refresh, e => (e as typeof event).marker);
    const reconcile = auditedReviewReconciler({ workspaceId: '/workspace', previousSessionId: 'prior', reviewId: query.reviewId,
      scope: query, catalog, ledger });
    expect(await reconcile(query.effectId)).toBeNull(); // transcript cannot prove completion
    await ledger.recordCompleted(query, receipt);
    expect(await reconcile(query.effectId)).toEqual(receipt);
    expect(refresh).toHaveBeenCalledWith('/workspace', 'prior');
    expect(repository.getSession).toHaveBeenCalledWith('prior', '/workspace');
    expect(repository.listEvents).toHaveBeenCalledWith('prior', '/workspace');
    vi.mocked(repository.getCoverage).mockReturnValue({ status: 'partial' } as ReturnType<SessionRepository['getCoverage']>);
    expect(await reconcile(query.effectId)).toBeNull();
    vi.mocked(repository.getCoverage).mockReturnValue({ status: 'complete' } as ReturnType<SessionRepository['getCoverage']>);
    vi.mocked(repository.listEvents).mockReturnValue([event, event] as ReturnType<SessionRepository['listEvents']>);
    expect(await reconcile(query.effectId)).toBeNull();
  });
});
