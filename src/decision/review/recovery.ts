import type { ReviewEffectReceipt, ReviewScope } from './types.js';
import { ReviewConflictError } from './validate.js';

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

export interface ReviewEffectQuery { tenantId: string; projectId: string; reviewId: string; effectId: string }

/** A verifier answer for one review effect. `receipt` is set only for `present`. */
export interface ReviewEffectVerification {
  result: 'present' | 'absent' | 'unknown';
  receipt: ReviewEffectReceipt | null;
}

export interface ReviewEffectReconcileOptions {
  /** The continuation identity, used only when no intent was recorded (a crash before the intent). */
  identity?: { continuationId: string; proposalVersion: number };
  /** `proposal.actionDigest`, the intent payload digest; required with `identity`. */
  actionDigest?: string;
  /** The receipt the executor built; its digest is the verifier's expected digest and its body is archived. */
  receipt?: ReviewEffectReceipt;
}

/**
 * Read-side verifier fallback: reconcile one effect through its kind verifier
 * (the effect ledger's `decision.review.continuation`), never replaying it.
 */
export interface ReviewEffectVerifierPort {
  reconcileReceipt(query: ReviewEffectQuery, options?: ReviewEffectReconcileOptions): Promise<ReviewEffectVerification>;
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
  /**
   * Optional verifier fallback, consulted only after coverage and the attempt
   * check pass and the ledger has no receipt. Only `present` is accepted.
   */
  verifier?: ReviewEffectVerifierPort;
  /** When set, a receipt for another continuation or proposal version is refused. */
  expected?: { continuationId: string; proposalVersion: number };
}): (effectId: string) => Promise<ReviewEffectReceipt | null> {
  return async effectId => {
    const coverage = await input.catalog.hydrate(input.workspaceId, input.previousSessionId);
    if (coverage.workspaceId !== input.workspaceId || coverage.previousSessionId !== input.previousSessionId || coverage.coverage !== 'covered') return null;
    const attempt = await input.catalog.findAttempt({ workspaceId: input.workspaceId, previousSessionId: input.previousSessionId, reviewId: input.reviewId, effectId });
    if (!attempt || attempt.workspaceId !== input.workspaceId || attempt.sessionId !== input.previousSessionId ||
        attempt.reviewId !== input.reviewId || attempt.effectId !== effectId) return null;
    const query = { tenantId: input.scope.tenantId, projectId: input.scope.projectId, reviewId: input.reviewId, effectId };
    let receipt = await input.ledger.completedReceipt(query);
    if (!receipt && input.verifier) {
      const settled = await input.verifier.reconcileReceipt(query);
      // `absent` never authorizes a replay and `unknown` settles nothing.
      if (settled.result !== 'present') return null;
      receipt = settled.receipt;
    }
    if (!receipt || receipt.effectId !== effectId || !Number.isSafeInteger(receipt.completedAtEpochMs) || receipt.completedAtEpochMs < 0) return null;
    if (input.expected && (receipt.continuationId !== input.expected.continuationId || receipt.proposalVersion !== input.expected.proposalVersion)) {
      throw new ReviewConflictError('Reconciliation receipt mismatch');
    }
    return receipt;
  };
}
