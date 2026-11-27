// Enforce the digest-bound issue-new policy gate for every planned issue write.
export function requireIssuePlanAuthorization(
  plan: Record<string, any>, authorizationDigest?: string, singleSegment = false,
): void {
  if (plan.disposition === 'blocked' || (singleSegment && plan.segments.length !== 1)) {
    throw new Error(`Issue draft rejected by composition policy (${plan.blockingRule ?? plan.disposition}). No write was made. Plan digest: ${plan.digest}. Run aiwg issue plan to inspect suggested segments.`);
  }
  if (plan.authorizationRequired && authorizationDigest !== plan.digest) {
    throw new Error(`Issue draft requires explicit policy authorization (authorization-required). Review 'aiwg issue plan', then pass --authorize-policy ${plan.digest}. No write was made.\n${JSON.stringify(plan)}`);
  }
}
