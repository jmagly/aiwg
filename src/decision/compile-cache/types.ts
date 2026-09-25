import type { DecisionLifecycleHold, DecisionLifecyclePolicy, DecisionLifecycleTombstone } from '../lifecycle.js';

export type Sha256 = `sha256:${string}`;

export type DecisionCacheLayer =
  | 'definition-compilation' | 'adapter-compilation' | 'provider-prefix'
  | 'invocation-replay' | 'semantic-result';

export interface CompileCacheIdentity {
  identityVersion: 'decision-compile-cache-identity/v1';
  layer: 'definition-compilation' | 'adapter-compilation';
  sourceArtifactDigests: Sha256[];
  compiler: { id: string; version: string };
  runtimeVersion: string;
  schemaVersion: string;
  canonicalizer: { id: string; version: string };
  adapter: { id: string; version: string; promptVersion: string };
  backendCapabilityMode: string;
  modelPolicy: { requested: string; compatibleActualModels: string[] };
  featureFlags: Record<string, boolean | number | string>;
  tenantId: string;
  projectId: string;
  dataClass: string;
}

export interface CompileCacheEntry<T> {
  schemaVersion: 'decision-compile-cache-entry/v1';
  key: Sha256;
  identity: CompileCacheIdentity;
  value: T;
  valueDigest: Sha256;
  createdAtEpochMs: number;
  expiresAtEpochMs: number;
  /** D10 hold; an unexpired hold blocks tombstone and deletion. */
  legalHold: DecisionLifecycleHold | null;
}

/**
 * Body-free record left at a key by tombstone or deletion. It keeps no identity,
 * value or value digest, and it blocks later fills and backup restores.
 */
export interface CompileCacheTombstoneRecord {
  schemaVersion: 'decision-compile-cache-tombstone/v1';
  key: Sha256;
  tombstone: DecisionLifecycleTombstone;
}

/** Independent D10 tombstone journal, such as `FileDecisionLifecycleStore`. */
export interface CompileCacheLifecycleJournal {
  tombstone(value: DecisionLifecycleTombstone): Promise<void>;
  tombstones(subject: string): Promise<DecisionLifecycleTombstone[]>;
}

export interface CompileCacheLifecycleOptions {
  /** Retention, backup and hold rules come from the policy's `cache` surface. */
  lifecyclePolicy: DecisionLifecyclePolicy;
}

export interface CompileCacheReadContext {
  tenantId: string;
  projectId: string;
  nowEpochMs: number;
  authorize(identity: CompileCacheIdentity): boolean;
}

export type CompileCacheOutcome = 'hit' | 'miss' | 'bypass' | 'rejected';

export interface CompileCacheResult<T> {
  outcome: CompileCacheOutcome;
  key: Sha256;
  entry: CompileCacheEntry<T>;
}

export interface ProviderPrefixIdentity {
  schemaVersion: 'decision-provider-prefix-identity/v1';
  orderedPrefixDigest: Sha256;
  provider: string;
  backend: string;
  requestedModel: string;
  actualModel: string | null;
  apiRevision: string;
  policy: { id: string; version: string; ttlMs: number };
  tenantId: string;
  workspaceId: string;
  dataClass: string;
  region: string;
  egressPolicyDigest: Sha256;
}

export type ProviderPrefixStatus = 'hit' | 'miss' | 'bypass' | 'unsupported' | 'unknown';

export interface ProviderPrefixEvidence {
  schemaVersion: 'decision-provider-prefix-evidence/v1';
  identityDigest: Sha256;
  status: ProviderPrefixStatus;
  source: 'provider-report' | 'documented-unsupported' | 'policy-bypass' | 'unreported';
  cacheVersion: string | null;
  savedInputTokens: number | null;
  expiresAtEpochMs: number | null;
}

/** Bounded reason codes; never a key, alias, identifier or error message. */
export type CacheTelemetryReason =
  | 'verified-hit' | 'cold-fill' | 'cache-disabled' | 'store-rejected' | 'provider-report'
  | 'documented-unsupported' | 'policy-bypass' | 'unreported';

export type CacheInvalidationReason = 'revalidation-failed' | null;

/** Metadata-only cache telemetry record; `version` is a bounded compiler or provider cache version. */
export interface CacheTelemetry {
  schemaVersion: 'decision-cache-telemetry/v1';
  layer: DecisionCacheLayer;
  outcome: CompileCacheOutcome | ProviderPrefixStatus;
  reason: CacheTelemetryReason;
  version: string | null;
  savedTokens: number | null;
  preparationLatencyMs: number;
  expiresAtEpochMs: number | null;
  invalidationReason: CacheInvalidationReason;
}

/** Prefix-identity dimensions a pinned compatibility record may allow to differ. */
export type ProviderPrefixCompatibleDimension = 'requestedModel' | 'actualModel' | 'apiRevision' | 'backend' | 'policy';

/** D09-style alias snapshot that pins which actual models an alias move may resolve to. */
export interface ProviderPrefixAliasSnapshot {
  alias: string;
  snapshotId: string;
  approvedActualModels: string[];
  validUntilEpochMs: number;
}

/**
 * Explicit, pinned permission to reuse a provider prefix across one exact
 * identity change. Without a matching record, any change invalidates reuse.
 */
export interface ProviderPrefixCompatibilityRecord {
  schemaVersion: 'decision-provider-prefix-compatibility/v1';
  fromIdentityDigest: Sha256;
  toIdentityDigest: Sha256;
  permits: ProviderPrefixCompatibleDimension[];
  /** Required whenever the record permits `requestedModel` or `actualModel`. */
  aliasSnapshot: ProviderPrefixAliasSnapshot | null;
  approvedBy: string;
  expiresAtEpochMs: number;
}

export type ProviderPrefixReuseReason =
  | 'identical' | 'pinned-compatibility' | 'ttl-expired' | 'identity-changed' | 'non-transferable-dimension'
  | 'record-expired' | 'record-mismatch' | 'alias-snapshot-unverified';

export interface ProviderPrefixReuseDecision {
  reusable: boolean;
  reason: ProviderPrefixReuseReason;
  changedDimensions: string[];
}
