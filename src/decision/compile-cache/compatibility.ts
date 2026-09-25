import { canonicalJson } from '../../security/artifact-trust.js';
import { providerPrefixKey } from './identity.js';
import type {
  ProviderPrefixAliasSnapshot, ProviderPrefixCompatibilityRecord, ProviderPrefixCompatibleDimension, ProviderPrefixIdentity,
  ProviderPrefixReuseDecision,
} from './types.js';

const PREFIX_DIMENSIONS = [
  'schemaVersion', 'orderedPrefixDigest', 'provider', 'backend', 'requestedModel', 'actualModel', 'apiRevision', 'policy',
  'tenantId', 'workspaceId', 'dataClass', 'region', 'egressPolicyDigest',
] as const satisfies ReadonlyArray<keyof ProviderPrefixIdentity>;
const TRANSFERABLE = new Set<string>(['requestedModel', 'actualModel', 'apiRevision', 'backend', 'policy'] satisfies ProviderPrefixCompatibleDimension[]);

export interface ProviderPrefixReuseInput {
  /** Identity under which the provider prefix was previously established. */
  cached: ProviderPrefixIdentity;
  cachedAtEpochMs: number;
  /** Identity of the request that would reuse it. */
  next: ProviderPrefixIdentity;
  nowEpochMs: number;
  records?: readonly ProviderPrefixCompatibilityRecord[];
  /** Host D09 registry check; an alias move is never trusted from the record alone. */
  verifyAliasSnapshot?: (snapshot: ProviderPrefixAliasSnapshot) => boolean | Promise<boolean>;
}

/** Dimensions whose canonical values differ between two prefix identities. */
export function changedPrefixDimensions(left: ProviderPrefixIdentity, right: ProviderPrefixIdentity): string[] {
  return PREFIX_DIMENSIONS.filter(dimension => canonicalJson(left[dimension]) !== canonicalJson(right[dimension]));
}

/**
 * Decide whether a previously established provider prefix may be reused.
 * TTL expiry always invalidates. Any identity change invalidates unless one
 * unexpired pinned record names exactly this from/to pair and permits every
 * changed dimension; scope, data class, region, egress, provider and the
 * prefix bytes themselves can never transfer.
 */
export async function evaluateProviderPrefixReuse(input: ProviderPrefixReuseInput): Promise<ProviderPrefixReuseDecision> {
  const changed = changedPrefixDimensions(input.cached, input.next);
  const decision = (reusable: boolean, reason: ProviderPrefixReuseDecision['reason']) => ({ reusable, reason, changedDimensions: changed });
  if (!Number.isSafeInteger(input.cachedAtEpochMs) || !Number.isSafeInteger(input.nowEpochMs)
    || input.nowEpochMs < input.cachedAtEpochMs
    || input.nowEpochMs - input.cachedAtEpochMs >= Math.min(input.cached.policy.ttlMs, input.next.policy.ttlMs)) {
    return decision(false, 'ttl-expired');
  }
  if (!changed.length) return decision(true, 'identical');
  if (changed.some(dimension => !TRANSFERABLE.has(dimension))) return decision(false, 'non-transferable-dimension');
  const from = providerPrefixKey(input.cached); const to = providerPrefixKey(input.next);
  const candidates = (input.records ?? []).filter(record => record.schemaVersion === 'decision-provider-prefix-compatibility/v1'
    && record.fromIdentityDigest === from && record.toIdentityDigest === to);
  if (!candidates.length) return decision(false, 'identity-changed');
  const live = candidates.filter(record => Number.isSafeInteger(record.expiresAtEpochMs) && record.expiresAtEpochMs > input.nowEpochMs
    && !!record.approvedBy);
  if (!live.length) return decision(false, 'record-expired');
  const permitting = live.filter(record => changed.every(dimension => record.permits.includes(dimension as ProviderPrefixCompatibleDimension)));
  if (!permitting.length) return decision(false, 'record-mismatch');
  const modelMoved = changed.includes('requestedModel') || changed.includes('actualModel');
  for (const record of permitting) {
    if (!modelMoved) return decision(true, 'pinned-compatibility');
    const snapshot = record.aliasSnapshot;
    if (!snapshot || snapshot.alias !== input.next.requestedModel || snapshot.validUntilEpochMs <= input.nowEpochMs
      || input.next.actualModel === null || !snapshot.approvedActualModels.includes(input.next.actualModel)
      || !input.verifyAliasSnapshot) continue;
    let verified = false;
    try { verified = await input.verifyAliasSnapshot(structuredClone(snapshot)) === true; } catch { verified = false; }
    if (verified) return decision(true, 'pinned-compatibility');
  }
  return decision(false, 'alias-snapshot-unverified');
}
