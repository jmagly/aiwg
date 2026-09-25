/**
 * Built-in `decision.review.continuation` verifier over the D13 review store
 * (#2721). It replaces the #2718 placeholder.
 *
 * Target: `review:<tenant>/<project>/<reviewId>`. The context is exactly the
 * `d13.review/v1` identity `{reviewId, continuationId, proposalVersion}`, and
 * the effect ID must equal `reviewDigest(context)`.
 *
 * The review store is the authority for whether the continuation was dispatched
 * and whether its receipt was persisted. While the review holds the
 * continuation without a receipt (the crash window between dispatch and
 * `execution-completed`), the store cannot settle the effect; the verifier then
 * asks the host's `execution` probe, which queries the effect's own target. With
 * no probe the answer is `unknown` / `consistency-lag`.
 *
 * `absent` never authorizes a D13 replay by itself (see the contract).
 *
 * @see docs/contracts/effect-ledger.v1.md "Built-in verifiers"
 */

import { canonicalJson } from '../../security/artifact-trust.js';
import type { DecisionReview, ReviewStore } from '../../decision/review/types.js';
import { ReviewAccessError, reviewDigest } from '../../decision/review/validate.js';
import { sha256Digest } from '../identity.js';
import type { EffectVerifier, EffectVerifierEvidence, EffectVerifierObservation, EffectVerifierRequest } from './types.js';

export const REVIEW_CONTINUATION_VERIFIER_VERSION = '1.0.0';

const DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface ReviewContinuationVerifierOptions {
  /** The D13 review store. Only `read` is used. */
  store: Pick<ReviewStore, 'read'>;
  /**
   * Host probe for the executed effect at its own target, consulted only while
   * the review holds the dispatched continuation without a receipt. Its answer
   * is subject to every framework rule; it SHOULD look for the effect ID the
   * executor carried into the target.
   */
  execution?: (request: EffectVerifierRequest) => Promise<EffectVerifierObservation>;
}

type Observation = EffectVerifierObservation;
const unknown = (reason: Observation['reason'], evidence?: EffectVerifierEvidence): Observation =>
  ({ result: 'unknown', reason, complete: false, ...(evidence ? { evidence } : {}) });

/**
 * Parse `review:<tenant>/<project>/<reviewId>` against the effect scope. Tenant
 * and project may themselves contain `/`, so the prefix comes from the scope.
 */
function targetReviewId(target: string, scope: EffectVerifierRequest['scope']): string | null {
  const prefix = `review:${scope.tenant}/${scope.project}/`;
  return target.startsWith(prefix) && target.length > prefix.length ? target.slice(prefix.length) : null;
}

/** The `decision.review.continuation` target for a review. */
export function reviewContinuationTarget(tenantId: string, projectId: string, reviewId: string): string {
  return `review:${tenantId}/${projectId}/${reviewId}`;
}

function receiptDigest(review: DecisionReview): string | null {
  try { return reviewDigest(review.effectReceipt); } catch { return null; }
}

async function delegate(options: ReviewContinuationVerifierOptions, request: EffectVerifierRequest, base: EffectVerifierEvidence): Promise<Observation> {
  if (!options.execution) return unknown('consistency-lag', { ...base, execution: 'not-configured' });
  const answer = await options.execution(request);
  if (!answer || typeof answer !== 'object') return unknown('malformed-response', base);
  let executionEvidenceDigest = answer.evidenceDigest ?? null;
  if (answer.evidence !== undefined) {
    try { executionEvidenceDigest = sha256Digest(canonicalJson(answer.evidence)); } catch { return unknown('malformed-response', base); }
  }
  // The framework normalizes the delegated result and reason like any other answer.
  return {
    result: answer.result, reason: answer.reason, complete: answer.complete,
    evidence: { ...base, execution: 'probed', executionReason: String(answer.reason), executionEvidenceDigest },
  };
}

/** `decision.review.continuation`: the D13 review store, then the host execution probe. */
export function reviewContinuationVerifier(options: ReviewContinuationVerifierOptions): EffectVerifier {
  return {
    kind: 'decision.review.continuation',
    version: REVIEW_CONTINUATION_VERIFIER_VERSION,
    canReportAbsent: true,
    async verify(request) {
      const targetId = targetReviewId(request.target, request.scope);
      const { reviewId, continuationId, proposalVersion } = request.context;
      if (request.scope.subsystem !== 'review' || targetId === null || targetId !== reviewId
        || typeof continuationId !== 'string' || typeof proposalVersion !== 'number'
        || request.effectId !== reviewDigest({ reviewId, continuationId, proposalVersion })) return unknown('malformed-response');
      const expected = request.expected.digest;
      if (expected !== undefined && !DIGEST.test(expected)) return unknown('malformed-response');

      let review: DecisionReview | null;
      try { review = await options.store.read(targetId, request.scope.tenant, request.scope.project); }
      catch (error) { return unknown(error instanceof ReviewAccessError ? 'auth-denied' : 'container-unreadable'); }
      const base: EffectVerifierEvidence = { source: 'd13-review', found: review !== null, expectedDigest: expected ?? null };
      if (!review) return { result: 'absent', reason: 'complete-query-no-match', complete: true, evidence: base };
      const state = { ...base, status: review.status, revision: review.revision };
      if (review.status === 'tombstoned') return unknown('container-unreadable', state);
      if (review.continuation.id !== continuationId) return unknown('evidence-conflict', state);

      if (review.effectReceipt) {
        const actual = receiptDigest(review);
        const evidence = { ...state, receiptDigest: actual };
        if (!actual) return unknown('malformed-response', state);
        // A receipt for another proposal version means this identity never completed here, but a
        // replay under it would still race the recorded effect: never absent.
        if (review.effectReceipt.effectId !== request.effectId) return unknown('evidence-conflict', evidence);
        if (expected === undefined) return { result: 'present', reason: 'state-match', complete: true, evidence };
        return actual === expected
          ? { result: 'present', reason: 'digest-match', complete: true, evidence }
          : unknown('evidence-conflict', evidence);
      }

      const dispatched = review.events.some(event => event.type === 'resumed' && event.data?.effectId === request.effectId);
      if (!dispatched) return { result: 'absent', reason: 'complete-query-no-match', complete: true, evidence: { ...state, dispatched: false } };
      // A definitive executor failure is recorded only when the target rejected the effect.
      if (review.status === 'execution-failed') return { result: 'absent', reason: 'complete-query-no-match', complete: true, evidence: { ...state, dispatched: true } };
      return delegate(options, request, { ...state, dispatched: true });
    },
  };
}
