// Defines and validates bounded human grants and their signed effect bindings.
import { canonicalJson } from '../security/artifact-trust.js';
import { usageError } from './errors.js';
import { payloadDigest } from './identity.js';
import { assertDigestOnly } from './redaction.js';
import { isEffectSchemaValid } from './schema.js';
import type { EffectPredicate } from './types.js';

export interface AuthorizationGrant {
  apiVersion: 'authorization-grant.aiwg.io/v1';
  grantId: string;
  scope: {
    categories: string[]; targets: string[]; environments: string[]; resources: string[]; verbs: string[];
  };
  constraints: {
    reversible: true; maxImpact: 'low' | 'medium';
    exclusions: ['secrets', 'destructive', 'production', 'policy-override'];
    conditions: string[]; maxUses?: number;
  };
  grantedBy: { kind: 'human'; id: string; issuer: string; authenticationRef: string };
  provenance: { provider: string; sessionId: string; userTurnDigest: string; nativeEventRef?: string };
  questionDigest: string;
  policyVersion: string;
  createdAt: string;
  expiresAt: string;
  revocation: { state: 'active' } | { state: 'revoked'; revokedAt: string; decisionEventId: string };
  supersedes?: string;
  revokes?: string;
}

// Extensible names cannot opt into any class the human-authorization rule excludes.
const FORBIDDEN = /(?:^|[^a-z0-9])(?:secrets?|credentials?|tokens?|destructive|production|prod|policy[._ -]?override|delete|destroy|wipe|drop)(?:$|[^a-z0-9])/i;
const ACTION_NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export function assertAuthorizationGrant(value: unknown): asserts value is AuthorizationGrant {
  if (!isEffectSchemaValid('authorizationGrant', value)) throw usageError('Invalid authorization grant', 'grant-schema-invalid');
  const grant = value as AuthorizationGrant;
  assertDigestOnly(grant);
  const { categories, targets, resources, verbs } = grant.scope;
  if ([...categories, ...verbs].some(name => !ACTION_NAME.test(name))
    || [...categories, ...targets, ...resources, ...verbs].some(name => FORBIDDEN.test(name))) {
    throw usageError('Authorization grant covers a prohibited action class', 'grant-prohibited');
  }
  const created = Date.parse(grant.createdAt);
  const expiry = grant.expiresAt === 'until-revoked' ? Infinity : Date.parse(grant.expiresAt);
  const revoked = grant.revocation.state === 'revoked' ? Date.parse(grant.revocation.revokedAt) : created;
  if (!Number.isFinite(created) || Number.isNaN(expiry) || !Number.isFinite(revoked)
    || expiry <= created || revoked < created
    || grant.supersedes === grant.grantId || grant.revokes === grant.grantId) {
    throw usageError('Invalid authorization grant time or link', 'grant-bounds-invalid');
  }
}

// Grants are internal ledger records with no external effect to verify, so they use the
// x.aiwg.* vendor namespace (like x.aiwg.ledger-lock-recovery) rather than a core kind.
export const AUTHORIZATION_GRANT_KIND = 'x.aiwg.authorization-grant' as const;

export function authorizationGrantIdentity(grantId: string) {
  return { kind: AUTHORIZATION_GRANT_KIND, target: `x-authorization-grant:${grantId}`, context: { grantId } };
}

/** Also used on read: generic effect writers cannot bypass grant validation or digest binding. */
export function authorizationGrantFailure(predicate: EffectPredicate): string | null {
  if (predicate.kind !== AUTHORIZATION_GRANT_KIND || predicate.phase !== 'intent') return null;
  const grant = predicate.authorizationGrant;
  try { assertAuthorizationGrant(grant); } catch { return 'authorization-grant-invalid'; }
  const identity = authorizationGrantIdentity(grant!.grantId);
  return predicate.target !== identity.target || canonicalJson(predicate.context) !== canonicalJson(identity.context)
    || predicate.payloadDigest !== payloadDigest(canonicalJson(grant)) ? 'authorization-grant-binding' : null;
}
