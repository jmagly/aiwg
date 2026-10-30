import { describe, expect, it } from 'vitest';
import { hasIndependentWorkerAcceptance } from '../../../src/mission-protocol/worker-review-gate.js';
import { reviewedResult } from '../../fixtures/mission-summary.js';

describe('existing independent acceptance verdict', () => {
  it.each([true, false])('reads a verifier-owned result (direct=%s)', direct => {
    expect(hasIndependentWorkerAcceptance(reviewedResult(direct).verification)).toBe(true);
  });
  it.each(['pending', 'rejected', 'blocked'])('does not accept %s', status => {
    const verification = reviewedResult().verification;
    verification.status = status;
    expect(hasIndependentWorkerAcceptance(verification)).toBe(false);
  });
  it.each(['missing rounds', 'empty rounds', 'missing evidence', 'invalid review'])('does not accept %s', change => {
    const verification = reviewedResult().verification;
    if (change === 'missing rounds') delete verification.reviewRounds;
    if (change === 'empty rounds') verification.reviewRounds = [];
    if (change === 'missing evidence') verification.evidence = [];
    if (change === 'invalid review') verification.reviewRounds[0].headSha = 'b'.repeat(40);
    expect(hasIndependentWorkerAcceptance(verification)).toBe(false);
  });
});
