import type { ReviewEffectReceipt, ReviewScope } from './types.js';

/**
 * Session history is an audit locator, never proof that an external effect ran.
 * The host must hydrate only an authorized workspace and prove that the exact
 * previous session is covered; global catalog integrity is not enough.
 */
export interface ReviewSessionAudit {
  hydrate(workspaceId: string, previousSessionId: string): Promise<{
    workspaceId: string; previousSessionId: string; coverage: 'covered' | 'partial' | 'stale' | 'unavailable';
  }>;
  findAttempt(query: { workspaceId: string; previousSessionId: string; reviewId: string; effectId: string }):
    Promise<{ workspaceId: string; sessionId: string; reviewId: string; effectId: string } | null>;
}

/** Authenticated executor-side ledger; never use transcript text as a receipt. */
export interface VerifiedReviewEffectLedger {
  completedReceipt(query: { tenantId: string; projectId: string; reviewId: string; effectId: string }):
    Promise<ReviewEffectReceipt | null>;
}

/**
 * Opt-in recovery adapter for DecisionReviewService.resume's reconcile callback.
 * Missing, stale, conflicting, or unauthenticated evidence returns null; the
 * service will keep the old effect uncertain and will not dispatch it again.
 */
export function auditedReviewReconciler(input: {
  workspaceId: string; previousSessionId: string; reviewId: string;
  scope: Pick<ReviewScope, 'tenantId' | 'projectId'>;
  catalog: ReviewSessionAudit; ledger: VerifiedReviewEffectLedger;
}): (effectId: string) => Promise<ReviewEffectReceipt | null> {
  return async effectId => {
    const coverage = await input.catalog.hydrate(input.workspaceId, input.previousSessionId);
    if (coverage.workspaceId !== input.workspaceId || coverage.previousSessionId !== input.previousSessionId || coverage.coverage !== 'covered') return null;
    const attempt = await input.catalog.findAttempt({ workspaceId: input.workspaceId, previousSessionId: input.previousSessionId, reviewId: input.reviewId, effectId });
    if (!attempt || attempt.workspaceId !== input.workspaceId || attempt.sessionId !== input.previousSessionId ||
        attempt.reviewId !== input.reviewId || attempt.effectId !== effectId) return null;
    const receipt = await input.ledger.completedReceipt({ tenantId: input.scope.tenantId, projectId: input.scope.projectId,
      reviewId: input.reviewId, effectId });
    if (!receipt || receipt.effectId !== effectId || !Number.isSafeInteger(receipt.completedAtEpochMs) || receipt.completedAtEpochMs < 0) return null;
    return receipt;
  };
}
