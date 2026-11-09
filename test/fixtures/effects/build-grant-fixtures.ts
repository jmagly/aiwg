// Builds deterministic synthetic human grants and negative schema fixtures.
import type { AuthorizationGrant } from '../../../src/effects/authorization-grant.js';

export function grantFixture(): AuthorizationGrant {
  return {
    apiVersion: 'authorization-grant.aiwg.io/v1', grantId: 'grant-issue-filing',
    scope: { categories: ['tracker.write'], targets: ['repo:example/repo', 'tracker:local'], environments: ['development'], resources: ['issues/**'], verbs: ['create'] },
    constraints: { reversible: true, maxImpact: 'low', exclusions: ['secrets', 'destructive', 'production', 'policy-override'], conditions: ['Only in workspace example'], maxUses: 5 },
    grantedBy: { kind: 'human', id: 'operator@example.test', issuer: 'test-host', authenticationRef: 'local-login:operator' },
    provenance: { provider: 'test', sessionId: 'session-1', userTurnDigest: `sha256:${'a'.repeat(64)}`, nativeEventRef: 'question:1' },
    questionDigest: `sha256:${'b'.repeat(64)}`, policyVersion: 'policy-1',
    createdAt: '2026-09-24T10:00:00.000Z', expiresAt: '2026-09-25T10:00:00.000Z', revocation: { state: 'active' },
  };
}

export function buildGrantFixtures(): Map<string, unknown> {
  const fixtures = new Map<string, unknown>();
  const put = (valid: boolean, name: string, mutate: (grant: any) => void = () => {}) => {
    const grant = grantFixture(); mutate(grant);
    fixtures.set(`${valid ? 'valid' : 'invalid'}/grant.${name}.json`, grant);
  };
  put(true, 'bounded');
  put(true, 'until-revoked', grant => { grant.expiresAt = 'until-revoked'; });
  put(true, 'revoked', grant => { grant.revocation = { state: 'revoked', revokedAt: '2026-09-24T11:00:00.000Z', decisionEventId: `sha256:${'c'.repeat(64)}` }; });
  put(false, 'agent', grant => { grant.grantedBy = { kind: 'agent', id: 'worker', issuer: 'test-host', authenticationRef: 'x' }; });
  put(false, 'production', grant => { grant.scope.environments = ['production']; });
  put(false, 'irreversible', grant => { grant.constraints.reversible = false; });
  put(false, 'high-impact', grant => { grant.constraints.maxImpact = 'high'; });
  put(false, 'unbounded-medium', grant => { grant.constraints.maxImpact = 'medium'; grant.expiresAt = 'until-revoked'; });
  put(false, 'missing-question', grant => { delete grant.questionDigest; });
  return fixtures;
}
