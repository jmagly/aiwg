import type {
  DecisionAdapter,
  DecisionAdapterRequest,
  DecisionCompileCachePolicy,
  DecisionDefinition,
  ExecutionTarget,
  JsonValue,
} from '../types.js';

export interface PrepareCompiledArtifactInput {
  alias: string;
  definition: DecisionDefinition;
  target: ExecutionTarget;
  adapter: DecisionAdapter;
  policy?: DecisionCompileCachePolicy;
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
  if (!policy?.enabled) return compile();

  const identity = policy.identityFor(input);
  const context = typeof policy.context === 'function' ? policy.context() : policy.context;
  try {
    const result = await policy.store.getOrCompile(identity, context, policy.ttlMs, compile);
    policy.onResult?.({ alias: input.alias, outcome: result.outcome });
    return structuredClone(result.entry.value);
  } catch (error) {
    if (policy.failureMode === 'fail') throw error;
    policy.onResult?.({ alias: input.alias, outcome: 'rejected' });
    return compile();
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
