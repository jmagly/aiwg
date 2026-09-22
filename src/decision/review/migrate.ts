import type { RulesetResult } from '../types.js';
import type { CreateReviewInput } from './types.js';
import { reviewDigest } from './validate.js';

export interface DurableReviewMigrationOptions {
  enabled: boolean;
  reviewId: string;
  continuationId: string;
  resumeToken: string;
  expiresAtEpochMs: number;
  escalationAtEpochMs?: number;
  rationale: string;
  riskTier: string;
  reasonCodes: string[];
  presentation?: Record<string, unknown>;
  quorum?: number;
}

/** Explicit opt-in bridge; receiving a review result never creates durable state. */
export function durableReviewInputFromRuleset(
  result: RulesetResult,
  options: DurableReviewMigrationOptions,
): CreateReviewInput | null {
  if (!options.enabled) return null;
  if (result.spec.status !== 'review') throw new Error('Only a review RulesetResult may enter durable review');
  if (result.spec.outcome === undefined) throw new Error('Durable review requires a proposed outcome');
  if (!options.reviewId || !options.continuationId || !options.resumeToken || !options.rationale
    || !options.riskTier || !options.reasonCodes.length) {
    throw new Error('Durable review migration requires explicit identity, rationale, risk, reason, and continuation data');
  }
  const evidencePins = Object.values(result.spec.evaluations)
    .map(evaluation => evaluation.spec.decision)
    .sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
  return {
    reviewId: options.reviewId,
    sourceReceipt: { id: result.spec.invocationId, digest: reviewDigest(result) },
    evidencePins,
    policyPins: [result.spec.ruleset, result.spec.binding],
    reasonCodes: [...options.reasonCodes],
    riskTier: options.riskTier,
    presentation: structuredClone(options.presentation ?? {}),
    action: structuredClone(result.spec.outcome),
    rationale: options.rationale,
    expiresAtEpochMs: options.expiresAtEpochMs,
    ...(options.escalationAtEpochMs === undefined ? {} : { escalationAtEpochMs: options.escalationAtEpochMs }),
    ...(options.quorum === undefined ? {} : { quorum: options.quorum }),
    continuationId: options.continuationId,
    resumeToken: options.resumeToken,
  };
}
