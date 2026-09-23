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
const restrictedKey = /(?:password|credential|api.?key|secret|private.?reasoning|provider.?body|raw.?state|vault.?locator)/i;
const restrictedValue = /(?:vault:\/\/|\b(?:sk-(?:test-)?[a-z0-9_-]{12,}|ghp_[a-z0-9]{12,})\b)/i;
/** Enforce reference-only default review payloads; do not echo rejected material. */
export function assertReviewProjection(value: unknown): void {
  if (typeof value === 'string') {
    if (restrictedValue.test(value)) throw new ReviewIntegrityError('Restricted review payload');
  } else if (Array.isArray(value)) {
    value.forEach(assertReviewProjection);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (restrictedKey.test(key)) throw new ReviewIntegrityError('Restricted review payload');
      assertReviewProjection(child);
    }
  }
}
const legalEvents = new Set<ReviewEventType>(['created', 'claimed', 'approved', 'rejected', 'edited', 'expired', 'escalated', 'canceled', 'resumed', 'execution-completed', 'execution-failed', 'legal-hold-placed', 'legal-hold-released', 'tombstoned', 'authorization-denied']);

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
  if (review.lifecycle && (typeof review.lifecycle.legalHold !== 'boolean'
    || (review.lifecycle.tombstonedAtEpochMs !== undefined && !Number.isSafeInteger(review.lifecycle.tombstonedAtEpochMs)))) {
    throw new ReviewIntegrityError('Invalid review lifecycle');
  }
  assertReviewProjection(review.presentation);
  review.proposals.forEach((proposal, index) => {
    assertReviewProjection(proposal.action);
    assertReviewProjection(proposal.rationale);
    if (proposal.version !== index + 1 || proposal.actionDigest !== reviewDigest(proposal.action)) throw new ReviewIntegrityError('Invalid proposal lineage');
  });
  review.decisions.forEach(decision => assertReviewProjection(decision.rationale));
  review.events.forEach(event => assertReviewProjection(event.rationale));
  if (review.effectReceipt) assertReviewProjection(review.effectReceipt.result);
  review.events.forEach((event, index) => {
    if (event.sequence !== index + 1 || !legalEvents.has(event.type) || event.proposalVersion < 1 || event.proposalVersion > review.proposals.length) {
      throw new ReviewIntegrityError('Invalid event lineage');
    }
    if (index && event.atEpochMs < review.events[index - 1]!.atEpochMs) throw new ReviewIntegrityError('Event time reordered');
  });
  if (review.revision !== review.events.length || review.events[0]?.type !== 'created' ||
    review.events[0]?.proposalVersion !== 1 || review.events[0]?.atEpochMs !== review.createdAtEpochMs ||
    review.events.at(-1)?.atEpochMs !== review.updatedAtEpochMs) throw new ReviewIntegrityError('Review event envelope mismatch');
  let state: DecisionReview['status'] = 'pending';
  let version = 1;
  let legalHold = false;
  let decisionIndex = 0;
  for (const event of review.events.slice(1)) {
    if (event.type === 'edited') {
      if (!['pending', 'claimed'].includes(state) || event.proposalVersion !== ++version) throw new ReviewIntegrityError('Illegal proposal edit');
      state = 'pending';
    } else {
      if (event.proposalVersion !== version) throw new ReviewIntegrityError('Event refers to wrong proposal');
      switch (event.type) {
        case 'claimed':
          if (!['pending', 'claimed'].includes(state)) throw new ReviewIntegrityError('Illegal claim');
          state = 'claimed'; break;
        case 'approved': case 'rejected': {
          if (!['pending', 'claimed'].includes(state)) throw new ReviewIntegrityError('Illegal decision');
          const decision = review.decisions[decisionIndex++];
          if (!decision || decision.proposalVersion !== version || decision.decision !== (event.type === 'approved' ? 'approve' : 'reject') ||
              canonicalJson(decision.reviewer) !== canonicalJson(event.actor) || decision.rationale !== event.rationale || decision.atEpochMs !== event.atEpochMs) {
            throw new ReviewIntegrityError('Decision event mismatch');
          }
          if (event.type === 'rejected') state = 'rejected';
          else state = review.decisions.slice(0, decisionIndex).filter(item => item.proposalVersion === version && item.decision === 'approve').length >= review.quorum
            ? 'approved' : 'claimed';
          break;
        }
        case 'resumed':
          if (state !== 'approved' && state !== 'resuming') throw new ReviewIntegrityError('Action before approval');
          if (event.data?.effectId !== reviewDigest({ reviewId: review.reviewId, continuationId: review.continuation.id, proposalVersion: version })) throw new ReviewIntegrityError('Effect identity mismatch');
          state = 'resuming'; break;
        case 'execution-completed':
          if (state !== 'resuming' || event.data?.effectId !== review.effectReceipt?.effectId) throw new ReviewIntegrityError('Completion without effect receipt');
          state = 'completed'; break;
        case 'execution-failed':
          if (state !== 'resuming') throw new ReviewIntegrityError('Failure without dispatch');
          state = 'execution-failed'; break;
        case 'expired': case 'escalated': case 'canceled':
          if (!['pending', 'claimed', 'approved', 'escalated'].includes(state)) throw new ReviewIntegrityError('Illegal terminal transition');
          if (event.type === 'escalated' && !['pending', 'claimed'].includes(state)) throw new ReviewIntegrityError('Illegal escalation');
          state = event.type; break;
        case 'tombstoned':
          if (state === 'tombstoned' || legalHold) throw new ReviewIntegrityError('Illegal tombstone');
          state = 'tombstoned'; break;
        case 'legal-hold-placed': case 'legal-hold-released':
          if (state === 'tombstoned' || legalHold === (event.type === 'legal-hold-placed')) throw new ReviewIntegrityError('Illegal legal-hold change');
          legalHold = event.type === 'legal-hold-placed'; break;
        case 'authorization-denied':
          if (state !== 'approved' && state !== 'resuming') throw new ReviewIntegrityError('Illegal authorization denial');
          break;
        default: throw new ReviewIntegrityError('Unexpected review event');
      }
    }
  }
  if (version !== review.proposals.length || decisionIndex !== review.decisions.length || state !== review.status ||
      legalHold !== (review.lifecycle?.legalHold ?? false)) throw new ReviewIntegrityError('Review history does not match state');
  if ((review.status === 'completed' && !review.effectReceipt) ||
      (review.effectReceipt && (review.status !== 'completed' && review.status !== 'tombstoned' ||
        review.effectReceipt.proposalVersion !== version || review.effectReceipt.continuationId !== review.continuation.id ||
        review.effectReceipt.effectId !== reviewDigest({ reviewId: review.reviewId, continuationId: review.continuation.id, proposalVersion: version })))) {
    throw new ReviewIntegrityError('Effect receipt does not match continuation');
  }
}

export function assertImmutable(previous: DecisionReview, next: DecisionReview): void {
  const fixed = ['reviewId', 'tenantId', 'projectId', 'requesterId', 'sourceReceipt', 'evidencePins', 'policyPins',
    'reasonCodes', 'riskTier', 'presentation', 'createdAtEpochMs', 'expiresAtEpochMs', 'escalationAtEpochMs', 'quorum', 'continuation'] as const;
  for (const key of fixed) if (canonicalJson(previous[key] ?? null) !== canonicalJson(next[key] ?? null)) throw new ReviewIntegrityError(`Immutable review field changed: ${key}`);
  if (previous.effectReceipt && canonicalJson(previous.effectReceipt) !== canonicalJson(next.effectReceipt ?? null)) {
    throw new ReviewIntegrityError('Completed effect receipt changed');
  }
  if (canonicalJson(next.decisions.slice(0, previous.decisions.length)) !== canonicalJson(previous.decisions)) {
    throw new ReviewIntegrityError('Review decision history changed');
  }
  if (next.revision !== previous.revision + 1 || next.events.length !== previous.events.length + 1
    || canonicalJson(next.events.slice(0, -1)) !== canonicalJson(previous.events)
    || next.proposals.length < previous.proposals.length
    || canonicalJson(next.proposals.slice(0, previous.proposals.length)) !== canonicalJson(previous.proposals)) {
    throw new ReviewIntegrityError('Review append-only lineage changed');
  }
  validateReview(next);
}
