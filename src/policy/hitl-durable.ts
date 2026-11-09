// Matches verified durable grants deterministically without trusting descriptor-supplied authority.
import { assertAuthorizationGrant } from '../effects/authorization-grant.js';
import type { AuthorizationGrantRead, StoredAuthorizationGrant } from '../effects/authorization-store.js';
import type { HitlAction, HitlResolution } from './hitl-types.js';

export interface DurableAuthorization extends AuthorizationGrantRead {
  /** Canonical project directory plus governing workspace directories, supplied by the host. */
  workspaces: string[];
  uses: Record<string, number>;
  /** Purging a use loses its grant reference; bounded grants then fail closed. */
  usageUnavailable?: boolean;
  historyUnavailable?: boolean;
}

export const AUTHORIZATION_USE_KIND = 'x.aiwg.authorization-use';
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const forbidden = /(?:^|[^a-z0-9])(?:secrets?|credentials?|tokens?|destructive|irreversible|production|prod|delete|destroy|wipe|drop|override)(?:$|[^a-z0-9])/i;
export const unsafeDurableAction = (action: HitlAction): boolean =>
  [action.category, action.environment, action.verb ?? '', action.target ?? ''].some(value => forbidden.test(value))
  || !action.reversible || action.impact === 'high';

export function matchDurableAuthorization(action: HitlAction, snapshot: DurableAuthorization, now: number,
  glob: (pattern: string, path: string) => boolean): {
    match?: StoredAuthorizationGrant; nearest?: HitlResolution['nearestGrant'];
  } {
  const revoked = new Set(snapshot.grants.flatMap(({ grant }) => [grant.revokes, grant.supersedes].filter((id): id is string => !!id)));
  const candidates = snapshot.grants.map(entry => {
    const { grant: g } = entry;
    const fields: string[] = [];
    try { assertAuthorizationGrant(g); } catch { return { entry, fields: ['invalid-grant'] }; }
    const { targets } = g.scope;
    if (!g.scope.categories.includes(action.category)) fields.push('category');
    if (!targets.includes(action.target ?? `repo:${action.repo}`)) fields.push('target');
    if (!targets.includes(`repo:${action.repo}`)) fields.push('repo');
    // A bare repo name cannot authorize another checkout or workspace with that same repo identity.
    if (!snapshot.workspaces.length || snapshot.workspaces.some(path => !targets.includes(`workspace:${path}`))) fields.push('workspace');
    if (!g.scope.environments.includes(action.environment)) fields.push('environment');
    if (!action.resources.every(path => g.scope.resources.some(pattern => glob(pattern, path)))) fields.push('resources');
    if (!g.scope.verbs.includes(action.verb ?? action.category.split('.').at(-1)!)) fields.push('verb');
    if (!action.reversible) fields.push('reversible');
    if (action.impact === 'high' || (action.impact === 'medium' && g.constraints.maxImpact !== 'medium')) fields.push('impact');
    if (now < Date.parse(g.createdAt)) fields.push('createdAt');
    if (g.expiresAt !== 'until-revoked' && now >= Date.parse(g.expiresAt)) fields.push('expiresAt');
    if (snapshot.historyUnavailable || g.revocation.state !== 'active' || revoked.has(g.grantId) || g.revokes) fields.push('revocation');
    // Free-text conditions are not executable predicates; never assume they have been satisfied.
    if (g.constraints.conditions.length) fields.push('conditions');
    if (g.constraints.maxUses !== undefined && (snapshot.usageUnavailable
      || (snapshot.uses[entry.effectId] ?? 0) >= g.constraints.maxUses)) fields.push('maxUses');
    return { entry, fields };
  }).sort((a, b) => a.fields.length - b.fields.length || compare(a.entry.grant.grantId, b.entry.grant.grantId)
    || compare(a.entry.effectId, b.entry.effectId));
  const nearest = candidates[0];
  if (!nearest) return {};
  return nearest.fields.length ? { nearest: { grantId: nearest.entry.grant.grantId, fields: nearest.fields } }
    : { match: nearest.entry };
}
