import { describe, expect, it, vi } from 'vitest';
import {
  auditedReviewReconciler, type ReviewSessionAudit, type VerifiedReviewEffectLedger,
} from '../../../src/decision/review/index.js';
const receipt = { effectId: 'effect-a', continuationId: 'continuation-a', proposalVersion: 1,
  completedAtEpochMs: 1000, result: { delivered: true } };
const scope = { tenantId: 'tenant-a', projectId: 'project-a' };
function sources() {
  const catalog: ReviewSessionAudit = {
    hydrate: vi.fn(async (workspaceId: string, previousSessionId: string) =>
      ({ workspaceId, previousSessionId, coverage: 'covered' as const })),
    findAttempt: vi.fn(async () => ({ workspaceId: '/workspace/aiwg', sessionId: 'previous-session',
      reviewId: 'review-a', effectId: receipt.effectId })),
  };
  const ledger: VerifiedReviewEffectLedger = {
    completedReceipt: vi.fn(async () => receipt),
  };
  const reconcile = () => auditedReviewReconciler({ workspaceId: '/workspace/aiwg', previousSessionId: 'previous-session',
    reviewId: 'review-a', scope, catalog, ledger });
  return { catalog, ledger, reconcile };
}
describe('review crash-recovery audit', () => {
  it('REV-REC-01 hydrates a scoped session, audits its attempt and checks an authenticated ledger', async () => {
    const { catalog, ledger, reconcile } = sources();
    expect(await reconcile()('effect-a')).toEqual(receipt);
    expect(catalog.hydrate).toHaveBeenCalledWith('/workspace/aiwg', 'previous-session');
    expect(catalog.findAttempt).toHaveBeenCalledWith({ workspaceId: '/workspace/aiwg', previousSessionId: 'previous-session',
      reviewId: 'review-a', effectId: 'effect-a' });
    expect(ledger.completedReceipt).toHaveBeenCalledWith({ ...scope, reviewId: 'review-a', effectId: 'effect-a' });
  });
  it('REV-REC-02 partial, stale or substituted coverage fails before auditing content or looking up effects', async () => {
    for (const coverage of ['partial', 'stale', 'unavailable'] as const) {
      const source = sources(); source.catalog.hydrate = vi.fn(async () => ({ workspaceId: '/workspace/aiwg',
        previousSessionId: 'previous-session', coverage }));
      expect(await source.reconcile()('effect-a')).toBeNull();
      expect(source.catalog.findAttempt).not.toHaveBeenCalled();
      expect(source.ledger.completedReceipt).not.toHaveBeenCalled();
    }
    const source = sources(); source.catalog.hydrate = vi.fn(async () => ({ workspaceId: '/other',
      previousSessionId: 'previous-session', coverage: 'covered' }));
    expect(await source.reconcile()('effect-a')).toBeNull();
    expect(source.catalog.findAttempt).not.toHaveBeenCalled();
  });
  it('REV-REC-03 transcript-only claims, scope substitution and mismatched receipts never prove completion', async () => {
    for (const attempt of [null, { workspaceId: '/other', sessionId: 'previous-session', reviewId: 'review-a', effectId: 'effect-a' },
      { workspaceId: '/workspace/aiwg', sessionId: 'other', reviewId: 'review-a', effectId: 'effect-a' }]) {
      const source = sources(); source.catalog.findAttempt = vi.fn(async () => attempt);
      expect(await source.reconcile()('effect-a')).toBeNull();
      expect(source.ledger.completedReceipt).not.toHaveBeenCalled();
    }
    const source = sources(); source.ledger.completedReceipt = vi.fn(async () => null);
    expect(await source.reconcile()('effect-a')).toBeNull();
    const mismatch = sources(); mismatch.ledger.completedReceipt = vi.fn(async () => ({ ...receipt, effectId: 'other' }));
    expect(await mismatch.reconcile()('effect-a')).toBeNull();
  });
});
