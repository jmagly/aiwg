// Shares verified operator lookup, deterministic explanation, health and signed revocation across existing surfaces.
import { randomUUID } from 'node:crypto';
import { effectSession, openLedger } from '../effects/host.js';
import { openEffectLedger, type EffectLedger } from '../effects/ledger.js';
import { inspectAuthorizationIndex, readAuthorizationGrants, recordAuthorizationGrant,
  type StoredAuthorizationGrant } from '../effects/authorization-store.js';
import { integrityError, usageError } from '../effects/errors.js';
import { readAllSegments } from '../effects/reader.js';
import { AUTHORIZATION_GRANT_KIND } from '../effects/authorization-grant.js';
import { loadHitlLayers } from './hitl-config.js';
import { canonicalHitlAction } from './hitl-check.js';
import { refreshDurableAuthorization } from './hitl-durable-store.js';
import { matchDurableAuthorization, unsafeDurableAction } from './hitl-durable.js';
import { glob, hitlDigest, resolveHitlAuthorization, validHitlAction } from './hitl.js';

/** Seven days, inclusive of the end of the window; expired grants are excluded. */
export const AUTHORIZATION_EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;
export type GrantStatus = 'active' | 'expired' | 'revoked' | 'pending';
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export async function authorizationReadLedger(projectDir: string): Promise<EffectLedger> {
  const session = await effectSession(projectDir, 'custom');
  return openEffectLedger({ projectDir, scope: session.scope, writer: 'cli' });
}
export function authorizationEntries(entries: StoredAuthorizationGrant[], now = Date.now()) {
  const removed = new Set(entries.flatMap(({ grant: g }) => [g.revokes, g.supersedes].filter(Boolean)));
  return entries.map(entry => {
    const g = entry.grant;
    const status: GrantStatus = g.revokes || g.revocation.state !== 'active' || removed.has(g.grantId) ? 'revoked'
      : g.expiresAt !== 'until-revoked' && Date.parse(g.expiresAt) <= now ? 'expired'
      : Date.parse(g.createdAt) > now ? 'pending' : 'active';
    return { ...entry, status };
  }).sort((a, b) => compare(a.grant.grantId, b.grant.grantId) || compare(a.effectId, b.effectId));
}
async function verifiedEntries(projectDir: string) {
  const read = await readAuthorizationGrants(await authorizationReadLedger(projectDir));
  if (read.failures.length) throw integrityError('authorization-ledger-invalid');
  return authorizationEntries(read.grants);
}
export async function listAuthorizationGrants(projectDir: string, status?: GrantStatus) {
  const entries = await verifiedEntries(projectDir);
  return { grants: status ? entries.filter(entry => entry.status === status) : entries };
}
export async function showAuthorizationGrant(projectDir: string, grantId: string) {
  const entry = (await verifiedEntries(projectDir)).find(entry => entry.grant.grantId === grantId);
  if (!entry) throw usageError('Unknown authorization grant', 'grant-not-found');
  return entry;
}
const tokens = (text: string) => [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
export async function searchAuthorizationGrants(projectDir: string, query: string) {
  if (!query.trim() || query.length > 4096) throw usageError('Search requires 1–4096 characters', 'grant-query-invalid');
  const queryTokens = tokens(query);
  const matches = (await verifiedEntries(projectDir)).map(entry => {
    const fields = { ...entry.grant.scope, ids: [entry.grant.grantId, entry.effectId, entry.recordHash] };
    const reasons = Object.entries(fields).flatMap(([field, values]) => queryTokens.flatMap(token => {
      const matched = values.filter(value => tokens(value).includes(token));
      return matched.length ? [{ field, token, values: matched }] : [];
    }));
    return { ...entry, score: reasons.length, reasons };
  }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score
    || compare(a.grant.grantId, b.grant.grantId) || compare(a.effectId, b.effectId)).slice(0, 20);
  return { query, matches };
}
export async function explainAuthorization(projectDir: string, input: unknown) {
  const loaded = await loadHitlLayers(projectDir);
  const action = await canonicalHitlAction(loaded.projectDir, input);
  const ledger = await authorizationReadLedger(loaded.projectDir);
  const context = await refreshDurableAuthorization(ledger, { now: new Date().toISOString(), layers: loaded.layers });
  const snapshot = context.durableAuthorization!;
  const resolution = resolveHitlAuthorization(action, context);
  const matched = validHitlAction(action) && !snapshot.failures.length
    ? matchDurableAuthorization(action, snapshot, Date.parse(context.now), glob) : {};
  return { ...resolution, matchingGrant: matched.match ?? null, nearestGrant: matched.nearest ?? null,
    safetyClassForcesEscalation: validHitlAction(action) && (unsafeDurableAction(action)
      || resolution.reason === 'safety-category-requires-explicit-review'), failures: snapshot.failures };
}

/** Only removes authority: original scope/human evidence is retained as lineage, never fresh approval. */
export async function revokeAuthorizationGrant(projectDir: string, grantId: string) {
  const original = await showAuthorizationGrant(projectDir, grantId);
  if (original.status === 'revoked') return { revokes: grantId, alreadyRevoked: true };
  const now = new Date().toISOString();
  const event = { operation: 'revoke', grantId, at: now, id: randomUUID() };
  const grant = { ...original.grant, grantId: `revocation-${event.id}`, revokes: grantId,
    createdAt: now, expiresAt: 'until-revoked', constraints: { ...original.grant.constraints, maxImpact: 'low' as const },
    revocation: { state: 'revoked' as const, revokedAt: now, decisionEventId: hitlDigest(event) } };
  delete grant.supersedes;
  const receipt = await recordAuthorizationGrant(openLedger(await effectSession(projectDir, 'custom')), grant);
  return { revokes: grantId, revocationGrantId: grant.grantId, effectId: receipt.effectId };
}

export async function authorizationHealth(projectDir: string, now = Date.now()) {
  const ledger = await authorizationReadLedger(projectDir);
  const read = await readAuthorizationGrants(ledger);
  const entries = authorizationEntries(read.grants, now);
  let unverifiable: number | null = 0;
  if (read.failures.length) {
    const segments = await readAllSegments(ledger.paths());
    // Count untrusted records only; never expose their fields or treat them as authority.
    unverifiable = segments.some(s => s.torn || s.lines.some(l => !l.decoded)) ? null
      : segments.reduce((n, s) => n + s.lines.filter(l => l.decoded?.statement.predicate.kind === AUTHORIZATION_GRANT_KIND
        && l.decoded.statement.predicate.phase === 'intent').length, 0);
  }
  return { active: entries.filter(e => e.status === 'active').length,
    expiringSoon: entries.filter(e => e.status === 'active' && e.grant.expiresAt !== 'until-revoked'
      && Date.parse(e.grant.expiresAt) <= now + AUTHORIZATION_EXPIRING_SOON_MS).length,
    expiringSoonWindowMs: AUTHORIZATION_EXPIRING_SOON_MS, unverifiable, failures: read.failures,
    index: await inspectAuthorizationIndex(ledger, read) };
}
