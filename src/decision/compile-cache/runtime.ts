import type {
  DecisionAdapter,
  DecisionAdapterRequest,
  DecisionCompileCachePolicy,
  DecisionDefinition,
  ExecutionTarget,
  JsonValue,
} from '../types.js';
import { sanitizeOpaqueValue } from '../telemetry/redaction.js';
import type { CacheTelemetry, CompileCacheIdentity, CompileCacheOutcome, CacheTelemetryReason } from './types.js';

export interface PrepareCompiledArtifactInput {
  alias: string;
  definition: DecisionDefinition;
  target: ExecutionTarget;
  adapter: DecisionAdapter;
  policy?: DecisionCompileCachePolicy;
}

const REASONS: Record<CompileCacheOutcome, CacheTelemetryReason> = {
  hit: 'verified-hit', miss: 'cold-fill', bypass: 'cache-disabled', rejected: 'store-rejected',
};

/** Metadata-only compile-layer telemetry: no alias, key, identity or artifact content. */
export function compileCacheTelemetry(identity: Pick<CompileCacheIdentity, 'layer' | 'compiler'> | null,
  outcome: CompileCacheOutcome, preparationLatencyMs: number, expiresAtEpochMs: number | null): CacheTelemetry {
  return { schemaVersion: 'decision-cache-telemetry/v1', layer: identity?.layer ?? 'definition-compilation', outcome,
    reason: REASONS[outcome], version: identity ? sanitizeOpaqueValue(identity.compiler.version, 64) : null, savedTokens: null,
    preparationLatencyMs: Math.max(0, preparationLatencyMs), expiresAtEpochMs,
    invalidationReason: outcome === 'rejected' ? 'revalidation-failed' : null };
}

/**
 * Compile the stable adapter material through one semantic path. Caching only
 * selects where that exact artifact comes from; it never changes the request
 * passed to the compiler or permits stale fallback.
 */
export async function prepareCompiledArtifact(input: PrepareCompiledArtifactInput): Promise<JsonValue | undefined> {
  if (!input.adapter.compile) return undefined;
  const compile = async () => input.adapter.compile!({
    definition: structuredClone(input.definition),
    target: structuredClone(input.target),
  });
  const policy = input.policy;
  if (!policy) return compile();
  const started = performance.now();
  const emit = (identity: CompileCacheIdentity | null, outcome: CompileCacheOutcome, expiresAtEpochMs: number | null) => {
    try { policy.onTelemetry?.(compileCacheTelemetry(identity, outcome, performance.now() - started, expiresAtEpochMs)); }
    catch { /* telemetry is observability-only */ }
  };
  if (!policy.enabled) {
    const value = await compile();
    emit(null, 'bypass', null);
    return value;
  }

  const identity = policy.identityFor(input);
  const context = typeof policy.context === 'function' ? policy.context() : policy.context;
  try {
    const result = await policy.store.getOrCompile(identity, context, policy.ttlMs, compile);
    policy.onResult?.({ alias: input.alias, outcome: result.outcome });
    emit(identity, result.outcome, result.entry.expiresAtEpochMs);
    return structuredClone(result.entry.value);
  } catch (error) {
    if (policy.failureMode === 'fail') {
      emit(identity, 'rejected', null);
      throw error;
    }
    policy.onResult?.({ alias: input.alias, outcome: 'rejected' });
    const value = await compile();
    emit(identity, 'rejected', null);
    return value;
  }
}

export async function prepareAdapterRequest(
  request: DecisionAdapterRequest,
  adapter: DecisionAdapter,
  policy?: DecisionCompileCachePolicy,
): Promise<DecisionAdapterRequest> {
  const compiledArtifact = await prepareCompiledArtifact({
    alias: request.alias,
    definition: request.definition,
    target: request.target,
    adapter,
    policy,
  });
  return compiledArtifact === undefined ? request : { ...request, compiledArtifact };
}
