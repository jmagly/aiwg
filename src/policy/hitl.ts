// Resolves bounded HITL authorization without I/O, clocks, or prompt-text authority.
import { createHash } from 'node:crypto';
import { HITL_CATEGORIES, HITL_ENVIRONMENTS, type HitlAction, type HitlContext,
  type HitlLayer, type HitlProfile, type HitlResolution, type HitlSelector } from './hitl-types.js';
import { validateHitlPolicy } from './hitl-validation.js';
import { matchDurableAuthorization, unsafeDurableAction } from './hitl-durable.js';
export type * from './hitl-types.js';

export function hitlDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : v;
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}
export const hitlPolicyVersion = (layers: HitlLayer[]): string => hitlDigest(layers);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/;
const pathValid = (path: string): boolean => path.length > 0 && path.length <= 512 && !path.startsWith('/') && !path.includes(':')
  && !/[\\\x00-\x20*?\[\]{}!]/.test(path) && path.split('/').every(p => p !== '.' && p !== '..' && p !== '');
export function validHitlAction(value: unknown): value is HitlAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return actionFieldsValid(value as HitlAction);
}
function actionFieldsValid(a: HitlAction): boolean {
  const keys = ['category', 'repo', 'environment', 'resources', 'reversible', 'impact'];
  const binding = ['actor', 'inputDigest', 'target', 'verb'];
  return Object.keys(a).every(k => [...keys, ...binding].includes(k)) && keys.every(k => Object.hasOwn(a, k))
    && (a.category !== 'repo.edit' || (typeof a.actor === 'string' && typeof a.inputDigest === 'string'))
    && (a.target === undefined || (typeof a.target === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@#=-]{0,255}$/.test(a.target)))
    && (a.verb === undefined || (typeof a.verb === 'string' && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(a.verb)))
    && (a.actor === undefined || (typeof a.actor === 'string' && identifier.test(a.actor)))
    && (a.inputDigest === undefined || (typeof a.inputDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(a.inputDigest)))
    && [a.category, a.repo, a.environment].every(x => typeof x === 'string' && identifier.test(x))
    && Array.isArray(a.resources) && a.resources.length > 0 && a.resources.every(p => typeof p === 'string' && pathValid(p))
    && typeof a.reversible === 'boolean' && ['low', 'medium', 'high'].includes(a.impact);
}
/** Deliberately small glob language: * within a segment; ** crosses directories; ? one character. */
function glob(pattern: string, path: string): boolean {
  // Memoized matching bounds work by pattern length × path length, without regex backtracking.
  const memo = new Map<string, boolean>();
  const match = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key)!;
    let result: boolean;
    if (i === pattern.length) result = j === path.length;
    else if (pattern[i] === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        const slash = path.indexOf('/', j);
        result = match(i + 3, j) || (slash >= 0 && match(i, slash + 1));
      } else result = match(i + 2, j) || (j < path.length && match(i, j + 1));
    } else if (pattern[i] === '*') result = match(i + 1, j)
      || (j < path.length && path[j] !== '/' && match(i, j + 1));
    else result = j < path.length && (pattern[i] === path[j] || (pattern[i] === '?' && path[j] !== '/'))
      && match(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}
function selected(s: HitlSelector, a: HitlAction): boolean {
  return (!s.categories || s.categories.includes(a.category)) && (!s.repos || s.repos.includes(a.repo))
    && (!s.environments || s.environments.includes(a.environment))
    && (!s.resources || a.resources.some(p => s.resources!.some(g => glob(g, p))));
}
function grant(p: HitlProfile, a: HitlAction, now: number): boolean {
  return now < Date.parse(p.expiresAt) && p.reversible === true && a.reversible
    && p.categories.some(c => c === a.category) && p.repos.includes(a.repo)
    && p.environments.some(e => e === a.environment)
    && a.resources.every(path => p.resources.some(g => glob(g, path)))
    && (a.impact === 'low' || (a.impact === 'medium' && p.maxImpact === 'medium'));
}
export function resolveHitlAuthorization(action: unknown, context: HitlContext): HitlResolution {
  const policyVersion = hitlPolicyVersion(context.layers);
  let nearestGrant: HitlResolution['nearestGrant'];
  const result = (decision: HitlResolution['decision'], reason: string, provenance: HitlResolution['provenance'],
    matchedProfile: string | null = null): HitlResolution => ({ decision,
      reason: nearestGrant && decision === 'escalate'
        ? `${reason}; nearest-grant:${nearestGrant.grantId}; differing-fields:${nearestGrant.fields.join(',')}` : reason,
      policyVersion, matchedProfile, provenance, ...(nearestGrant && decision === 'escalate' ? { nearestGrant } : {}) });
  if (context.platform) return result(context.platform === 'deny' ? 'deny' : 'escalate', 'platform-constraint', 'platform');
  if (!validHitlAction(action)) return result('escalate', 'invalid-action-descriptor', 'default');
  if (unsafeDurableAction(action)) return result('escalate', 'safety-category-requires-explicit-review', 'platform');
  // Revalidate even when invoked directly with objects that bypassed the config loader.
  if (context.layers.some(l => validateHitlPolicy(l.policy).length)) return result('escalate', 'invalid-policy', 'default');
  if (context.layers.some(l => l.policy?.deny.some(s => selected(s, action)))) return result('deny', 'explicit-deny', 'explicit-deny');
  const now = Date.parse(context.now);
  if (!Number.isFinite(now)) return result('escalate', 'invalid-clock', 'default');
  if (context.durableAuthorization?.failures.length) return result('escalate', 'authorization-ledger-invalid', 'default');
  const session = context.sessionAuthorization;
  if (session?.source === 'session-user') {
    const probe = { version: '1', enabled: true, reviewedAt: context.now, maxAgeSeconds: 1,
      expiresAt: session.profile.expiresAt, profiles: { session: session.profile }, deny: [], requireReview: [] };
    if (!validateHitlPolicy(probe).length && grant(session.profile, action, now)) return {
      ...result('auto-authorized', 'session-user-authorization', 'session-user', 'session'), expiresAt: session.profile.expiresAt,
    };
  }
  if (context.expectedPolicyVersion && policyVersion !== context.expectedPolicyVersion) return result('escalate', 'stale-policy-version', 'project-policy');
  if (context.durableAuthorization) {
    const durable = matchDurableAuthorization(action, context.durableAuthorization, now, glob);
    nearestGrant = durable.nearest;
    // An independent human grant needs no profile, but cannot bypass a governing review/revocation.
    for (const { policy: p } of durable.match ? context.layers : []) {
      if (!p) continue;
      if (!p.enabled) return result('escalate', 'policy-revoked', 'project-policy');
      if (now >= Date.parse(p.expiresAt)) return result('escalate', 'policy-expired', 'project-policy');
      const reviewed = Date.parse(p.reviewedAt);
      if (reviewed > now || now - reviewed >= p.maxAgeSeconds * 1000) return result('escalate', 'stale-policy-review', 'project-policy');
      if (p.requireReview.some(s => selected(s, action))) return result('escalate', 'policy-requires-review', 'project-policy');
    }
    if (durable.match) {
      const { grant: g, effectId, recordHash } = durable.match;
      const policyExpiry = context.layers.flatMap(({ policy: p }) => p ? [Date.parse(p.expiresAt),
        Date.parse(p.reviewedAt) + p.maxAgeSeconds * 1000] : []);
      // Even until-revoked grants issue finite receipts; every consumption still reloads revocations.
      const expiresAt = new Date(Math.min(g.expiresAt === 'until-revoked' ? now + 86400_000 : Date.parse(g.expiresAt), ...policyExpiry)).toISOString();
      return { ...result('auto-authorized', 'durable-user-authorization', 'durable-user'), expiresAt,
        authorizationGrant: { grantId: g.grantId, effectId, recordHash } };
    }
  }
  if (!HITL_CATEGORIES.some(c => c === action.category) || !HITL_ENVIRONMENTS.some(e => e === action.environment)) {
    return result('escalate', 'safety-category-requires-explicit-review', 'platform');
  }
  if (!context.layers.length) return result('escalate', 'no-project-policy', 'default');
  let matched: string | null = null;
  let expires = Infinity;
  for (const layer of context.layers) {
    const p = layer.policy;
    if (!p?.enabled) return result('escalate', p ? 'policy-revoked' : 'missing-member-policy', 'project-policy');
    const reviewed = Date.parse(p.reviewedAt);
    if (now >= Date.parse(p.expiresAt)) return result('escalate', 'policy-expired', 'project-policy');
    if (reviewed > now || now - reviewed >= p.maxAgeSeconds * 1000) return result('escalate', 'stale-policy-review', 'project-policy');
    if (p.requireReview.some(s => selected(s, action))) return result('escalate', 'policy-requires-review', 'project-policy');
    const entry = Object.entries(p.profiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).find(([, profile]) => grant(profile, action, now));
    if (!entry) return result('escalate', 'outside-profile-or-expired', 'project-policy');
    matched = entry[0];
    expires = Math.min(expires, Date.parse(p.expiresAt), reviewed + p.maxAgeSeconds * 1000, Date.parse(entry[1].expiresAt));
  }
  return { ...result('auto-authorized', 'bounded-project-policy', 'project-policy', matched), expiresAt: new Date(expires).toISOString() };
}
