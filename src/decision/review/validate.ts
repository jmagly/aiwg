import { createHash } from 'node:crypto';
import { canonicalJson } from '../../security/artifact-trust.js';
import type { DecisionReview, ReviewEventType, ReviewProposal } from './types.js';

export class ReviewIntegrityError extends Error {}
export class ReviewAccessError extends Error {}
export class ReviewConflictError extends Error {}

export function reviewDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const legalEvents = new Set<ReviewEventType>(['created', 'claimed', 'approved', 'rejected', 'edited', 'expired', 'escalated', 'canceled', 'resumed', 'execution-completed', 'execution-failed']);

export function currentProposal(review: DecisionReview): ReviewProposal {
  const proposal = review.proposals.at(-1);
  if (!proposal) throw new ReviewIntegrityError('Review has no proposal');
  return proposal;
}

export function validateReview(review: DecisionReview): void {
  if (!review || review.apiVersion !== 'decision.aiwg.io/v1alpha1' || review.kind !== 'DecisionReview' || review.schema !== 'decision-review/v1'
    || !Number.isSafeInteger(review.revision) || review.revision < 1 || !review.reviewId || !review.tenantId || !review.projectId
    || !digestPattern.test(review.sourceReceipt.digest) || !digestPattern.test(review.continuation.tokenDigest)
    || !Number.isSafeInteger(review.quorum) || review.quorum < 1 || review.quorum > 16
    || !Number.isSafeInteger(review.createdAtEpochMs) || review.updatedAtEpochMs < review.createdAtEpochMs
    || review.expiresAtEpochMs <= review.createdAtEpochMs || !Array.isArray(review.proposals) || !review.proposals.length
    || !Array.isArray(review.events) || !review.events.length) throw new ReviewIntegrityError('Invalid review envelope');
  review.proposals.forEach((proposal, index) => {
    if (proposal.version !== index + 1 || proposal.actionDigest !== reviewDigest(proposal.action)) throw new ReviewIntegrityError('Invalid proposal lineage');
  });
  review.events.forEach((event, index) => {
    if (event.sequence !== index + 1 || !legalEvents.has(event.type) || event.proposalVersion < 1 || event.proposalVersion > review.proposals.length) {
      throw new ReviewIntegrityError('Invalid event lineage');
    }
    if (index && event.atEpochMs < review.events[index - 1]!.atEpochMs) throw new ReviewIntegrityError('Event time reordered');
  });
  if (review.effectReceipt && (review.effectReceipt.proposalVersion !== currentProposal(review).version
    || review.effectReceipt.continuationId !== review.continuation.id)) throw new ReviewIntegrityError('Effect receipt does not match continuation');
}

export function assertImmutable(previous: DecisionReview, next: DecisionReview): void {
  const fixed = ['reviewId', 'tenantId', 'projectId', 'requesterId', 'sourceReceipt', 'evidencePins', 'policyPins', 'createdAtEpochMs', 'continuation'] as const;
  for (const key of fixed) if (canonicalJson(previous[key]) !== canonicalJson(next[key])) throw new ReviewIntegrityError(`Immutable review field changed: ${key}`);
  if (next.revision !== previous.revision + 1 || next.events.length !== previous.events.length + 1
    || canonicalJson(next.events.slice(0, -1)) !== canonicalJson(previous.events)
    || next.proposals.length < previous.proposals.length
    || canonicalJson(next.proposals.slice(0, previous.proposals.length)) !== canonicalJson(previous.proposals)) {
    throw new ReviewIntegrityError('Review append-only lineage changed');
  }
  validateReview(next);
}
