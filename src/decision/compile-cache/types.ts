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
  tombstonedAtEpochMs: number | null;
  legalHold: boolean;
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

export interface CacheTelemetry {
  schemaVersion: 'decision-cache-telemetry/v1';
  layer: DecisionCacheLayer;
  outcome: CompileCacheOutcome | ProviderPrefixStatus;
  reason: string;
  version: string | null;
  savedTokens: number | null;
  preparationLatencyMs: number;
  expiresAtEpochMs: number | null;
  invalidationReason: string | null;
}
