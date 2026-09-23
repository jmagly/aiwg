import {
  digestDecisionContext, verifyDecisionChain, type DataClassification, type DecisionCorrelation,
  type JsonlOperatorDecisionStore, type OperatorDecisionInput, type OperatorDecisionRecord,
} from '../../audit/operator-decision.js';
import { canonicalJson } from '../../security/artifact-trust.js';
import type { DecisionReview, ReviewEvent } from './types.js';
import { ReviewIntegrityError, reviewOperatorEventId, validateReview } from './validate.js';

/** #1567 record mapping: review event ID is the operator audit event ID, not a parallel identity. */
export function reviewOperatorDecisionInput(review: DecisionReview, event: ReviewEvent,
  correlation: DecisionCorrelation, classification: DataClassification): OperatorDecisionInput | null {
  const outcome = ({ approved: ['approval', 'approved'], rejected: ['denial', 'denied'],
    escalated: ['escalation', 'escalated'], 'authorization-denied': ['denial', 'denied'] } as const)[event.type as
      'approved' | 'rejected' | 'escalated' | 'authorization-denied'];
  if (!outcome) return null;
  if (event.operatorDecisionEventId && event.operatorDecisionEventId !== reviewOperatorEventId(review.reviewId, event.sequence)) {
    throw new ReviewIntegrityError('Operator audit identity mismatch');
  }
  const proposal = review.proposals.find(item => item.version === event.proposalVersion);
  if (!proposal) throw new ReviewIntegrityError('Operator audit proposal mismatch');
  return {
    kind: outcome[0], outcome: outcome[1],
    event_id: event.operatorDecisionEventId ?? reviewOperatorEventId(review.reviewId, event.sequence),
    timestamp: new Date(event.atEpochMs).toISOString(),
    actor: { id: event.actor.id, type: 'human', authentication: event.actor.authorityContext, roles: event.actor.roles },
    reason: event.rationale, classification, correlation,
    policy_ref: review.policyPins.map(pin => `${pin.id}@${pin.version}`).join(',') || undefined,
    context: { reviewId: review.reviewId, sourceReceipt: review.sourceReceipt,
      proposalVersion: event.proposalVersion, actionDigest: proposal.actionDigest },
  };
}

/**
 * Recover missing #1567 audit records after a crash using the durable review
 * event IDs. Caller must serialize writers to the operator JSONL audit store.
 */
export async function replayReviewOperatorAudit(review: DecisionReview, store: JsonlOperatorDecisionStore,
  correlation: DecisionCorrelation, classification: DataClassification): Promise<OperatorDecisionRecord[]> {
  validateReview(review);
  const prior = await store.read();
  if (!verifyDecisionChain(prior).ok) throw new ReviewIntegrityError('Operator audit chain is invalid');
  const matched: OperatorDecisionRecord[] = [];
  for (const event of review.events) {
    const input = reviewOperatorDecisionInput(review, event, correlation, classification);
    if (!input) continue;
    const existing = prior.find(record => record.event_id === input.event_id);
    if (existing) {
      if (existing.kind !== input.kind || existing.outcome !== input.outcome || existing.actor.id !== input.actor.id ||
          existing.context_digest !== digestDecisionContext(input.context) ||
          canonicalJson(existing.correlation) !== canonicalJson(input.correlation) ||
          existing.reason !== input.reason || existing.policy_ref !== input.policy_ref) {
        throw new ReviewIntegrityError('Conflicting operator audit record');
      }
      matched.push(existing);
    } else {
      const created = await store.append(input);
      prior.push(created);
      matched.push(created);
    }
  }
  return matched;
}
