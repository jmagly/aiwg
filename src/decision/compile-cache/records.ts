import { canonicalJson } from '../../security/artifact-trust.js';
import {
  DECISION_LIFECYCLE_SURFACES, mayRestoreDecisionReference, validateDecisionLifecyclePolicy,
  type DecisionLifecycleHold, type DecisionLifecyclePolicy, type DecisionLifecycleReference,
  type DecisionLifecycleRule, type DecisionLifecycleTombstone,
} from '../lifecycle.js';
import { compileCacheKey, sha256 } from './identity.js';
import type {
  CompileCacheEntry, CompileCacheIdentity, CompileCacheReadContext, CompileCacheTombstoneRecord, Sha256,
} from './types.js';

export class CompileCacheRejectedError extends Error {
  constructor() { super('compile cache entry unavailable'); this.name = 'CompileCacheRejectedError'; }
}

/** The D10 `cache` surface rule that governs retention, backup and hold handling. */
export function compileCacheLifecycleRule(policy: DecisionLifecyclePolicy): DecisionLifecycleRule {
  validateDecisionLifecyclePolicy(policy);
  return structuredClone(policy.surfaces.cache);
}

export function compileCacheReference(key: Sha256): DecisionLifecycleReference {
  return { surface: 'cache', opaqueId: key.slice('sha256:'.length) };
}

/**
 * Scope and authorization are decided on the requested identity before any
 * storage lookup, so a denied caller cannot tell a present entry from an absent one.
 */
export function compileCacheScopeAllowed(identity: CompileCacheIdentity, context: CompileCacheReadContext): boolean {
  try {
    return identity.tenantId === context.tenantId && identity.projectId === context.projectId
      && context.authorize(identity) === true;
  } catch { return false; }
}

export function activeCompileCacheHold(entry: CompileCacheEntry<unknown>, nowEpochMs: number): boolean {
  return entry.legalHold !== null && entry.legalHold.expiresAt > nowEpochMs;
}

export function validateCompileCacheHold(hold: DecisionLifecycleHold, nowEpochMs: number): DecisionLifecycleHold {
  if (!hold?.subject || !hold.reason || !hold.authorizedBy || !Array.isArray(hold.scope) || !hold.scope.includes('cache')
    || hold.scope.some(surface => !DECISION_LIFECYCLE_SURFACES.includes(surface))
    || !Number.isSafeInteger(hold.expiresAt) || hold.expiresAt <= nowEpochMs) throw new Error('Decision lifecycle hold denied');
  return structuredClone(hold);
}

export function compileCacheTombstoneRecord(key: Sha256, nowEpochMs: number): CompileCacheTombstoneRecord {
  const reference = compileCacheReference(key);
  return { schemaVersion: 'decision-compile-cache-tombstone/v1', key,
    tombstone: { subject: reference.opaqueId, reference, deletedAt: nowEpochMs } };
}

export function isCompileCacheTombstone(record: unknown, key: Sha256): record is CompileCacheTombstoneRecord {
  const value = record as Partial<CompileCacheTombstoneRecord> | null;
  const reference = compileCacheReference(key);
  return value?.schemaVersion === 'decision-compile-cache-tombstone/v1' && value.key === key
    && Object.keys(value).length === 3 && value.tombstone?.subject === reference.opaqueId
    && value.tombstone.reference?.surface === 'cache' && value.tombstone.reference.opaqueId === reference.opaqueId
    && Number.isSafeInteger(value.tombstone.deletedAt) && value.tombstone.deletedAt >= 0;
}

export async function buildCompileCacheEntry<T>(identity: CompileCacheIdentity, key: Sha256, context: CompileCacheReadContext,
  ttlMs: number, rule: DecisionLifecycleRule, compile: () => Promise<T>): Promise<CompileCacheEntry<T>> {
  // Entry lifetime can never exceed the lifecycle retention for the cache surface.
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > rule.retentionMs
    || !compileCacheScopeAllowed(identity, context)) throw new CompileCacheRejectedError();
  const value = await compile();
  if (value === undefined || canonicalJson(value) === undefined) throw new Error('compiler returned malformed output');
  return { schemaVersion: 'decision-compile-cache-entry/v1', key, identity: structuredClone(identity),
    value: structuredClone(value), valueDigest: sha256(value), createdAtEpochMs: context.nowEpochMs,
    expiresAtEpochMs: context.nowEpochMs + ttlMs, legalHold: null };
}

/** Revalidate integrity, identity, scope, authorization and (unless allowed) expiry. */
export function revalidateCompileCacheEntry<T>(entry: CompileCacheEntry<T>, identity: CompileCacheIdentity,
  context: CompileCacheReadContext, allowExpired = false): CompileCacheEntry<T> {
  let valid = false;
  try {
    valid = entry?.schemaVersion === 'decision-compile-cache-entry/v1'
      && entry.key === compileCacheKey(entry.identity) && entry.key === compileCacheKey(identity)
      && canonicalJson(entry.identity) === canonicalJson(identity) && entry.valueDigest === sha256(entry.value)
      && Number.isSafeInteger(entry.createdAtEpochMs) && Number.isSafeInteger(entry.expiresAtEpochMs)
      && (entry.legalHold === null || (typeof entry.legalHold === 'object' && Number.isSafeInteger(entry.legalHold.expiresAt)))
      && compileCacheScopeAllowed(entry.identity, context)
      && (allowExpired || context.nowEpochMs < entry.expiresAtEpochMs);
  } catch { valid = false; }
  if (!valid) throw new CompileCacheRejectedError();
  return structuredClone(entry);
}

/** D10 restore gate: any tombstone for the key, or elapsed retention, refuses the backup. */
export function mayRestoreCompileCacheEntry(entry: CompileCacheEntry<unknown>, nowEpochMs: number,
  policy: DecisionLifecyclePolicy, tombstones: ReadonlyArray<DecisionLifecycleTombstone>): boolean {
  return mayRestoreDecisionReference(compileCacheReference(entry.key), entry.createdAtEpochMs, nowEpochMs, policy, tombstones);
}
