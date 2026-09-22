import type { ArtifactPin, DecisionFailureReason, JsonValue } from '../types.js';

export const RESULT_CACHE_SCHEMA_VERSION = 'decision-result-cache/v1' as const;
export const RESULT_CACHE_KEY_VERSION = 'decision-semantic-key/v1' as const;

export interface ResultCacheScope { tenantId: string; projectId: string; workspaceId: string }

export interface ResultCacheActor extends ResultCacheScope {
  subjectId: string;
  permissions: Array<'read' | 'write' | 'invalidate' | 'export' | 'delete'>;
}

export interface ResultCachePolicy {
  /** Result reuse is deliberately inert unless both switches are true. */
  enabled: boolean;
  sideEffectFree: boolean;
  policyVersion: string;
  ttlMs: number;
  scope: 'workspace';
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
  negative?: { enabled: boolean; ttlMs: number; reasons: Array<'invalid-input'> };
}

export type ModelCompatibilityPolicy =
  | { mode: 'pinned'; actualModel: string }
  | { mode: 'alias'; alias: string; snapshotId: string; approvedActualModels: string[]; validUntilEpochMs: number };

/** Every field is behavior-affecting and participates in the canonical key. */
export interface ResultCacheSemanticIdentity {
  keyVersion: typeof RESULT_CACHE_KEY_VERSION;
  definition: ArtifactPin;
  ruleset: ArtifactPin;
  binding: ArtifactPin;
  adapter: { id: string; version: string };
  promptDigest: `sha256:${string}`;
  acceptancePolicyDigest: `sha256:${string}`;
  calibrationDigest: `sha256:${string}`;
  backend: string;
  requestedModel: string;
  modelCompatibility: ModelCompatibilityPolicy;
  primitive: 'choice' | 'ordinal-score' | 'truth-probability';
  projectedInput: JsonValue;
  subjectIdentityDigest: `sha256:${string}`;
  projectionPolicyDigest: `sha256:${string}`;
  egressPolicyDigest: `sha256:${string}`;
  capabilityMode: string;
}

export interface CachedResultEvidence {
  result: JsonValue;
  resultDigest: `sha256:${string}`;
  sourceInvocationId: string;
  sourceReceiptId: string;
  evaluatedAtEpochMs: number;
  actualModel: string;
  uncertainty: JsonValue | null;
  calibrationStatus: string;
  durationMs: number;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  status: 'success' | 'terminal-failure';
  failureReason: DecisionFailureReason;
}

export interface ResultCacheEntry {
  schemaVersion: typeof RESULT_CACHE_SCHEMA_VERSION;
  revision: 1;
  entryId: string;
  scope: ResultCacheScope;
  keyDigest: `sha256:${string}`;
  identityDigest: `sha256:${string}`;
  policyVersion: string;
  sensitivity: ResultCachePolicy['sensitivity'];
  createdAtEpochMs: number;
  expiresAtEpochMs: number;
  evidence: CachedResultEvidence;
  integrityDigest: `sha256:${string}`;
}

export interface ResultCacheStore {
  read(actor: ResultCacheActor, keyDigest: `sha256:${string}`): Promise<ResultCacheEntry | null>;
  putIfAbsent(actor: ResultCacheActor, entry: ResultCacheEntry): Promise<ResultCacheEntry>;
  invalidate(actor: ResultCacheActor, keyDigest: `sha256:${string}`, expectedEntryId?: string): Promise<boolean>;
  delete(actor: ResultCacheActor, keyDigest: `sha256:${string}`): Promise<boolean>;
  export(actor: ResultCacheActor, keyDigest: `sha256:${string}`): Promise<ResultCacheEntry | null>;
}

export type ResultCacheEvent = 'hit' | 'miss' | 'bypass' | 'stale' | 'invalidation' | 'single-flight';
export interface ResultCacheTelemetry {
  event: ResultCacheEvent;
  /** Opaque correlation only: never the semantic key, input, subject, or entry ID. */
  operationId: string;
  reason: string;
  saved?: { inputTokens: number; outputTokens: number; latencyMs: number; costUsd: number };
}

export interface ResultCacheCallerReceipt {
  disposition: 'cache-hit' | 'cache-miss-fill' | 'bypass';
  callerInvocationId: string;
  sourceInvocationId: string | null;
  sourceReceiptId: string | null;
  originalEvaluatedAtEpochMs: number | null;
  cacheEntryId: string | null;
  createdAtEpochMs: number;
  /** Always false for a cache hit; consumers must not represent it as a provider attempt. */
  providerAttempted: boolean;
}

export interface ResultCacheOutcome {
  evidence: CachedResultEvidence | null;
  receipt: ResultCacheCallerReceipt;
}

export type ResultCacheFill = () => Promise<CachedResultEvidence>;
