import { createHash } from 'node:crypto';
import { canonicalJson } from '../../security/artifact-trust.js';
import type { CompileCacheIdentity, ProviderPrefixIdentity, Sha256 } from './types.js';

export function sha256(value: unknown): Sha256 {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function compileCacheKey(identity: CompileCacheIdentity): Sha256 {
  validateCompileIdentity(identity);
  return sha256(identity);
}

export function providerPrefixKey(identity: ProviderPrefixIdentity): Sha256 {
  if (identity.policy.ttlMs <= 0 || !Number.isSafeInteger(identity.policy.ttlMs)) throw new Error('invalid provider prefix TTL');
  return sha256(identity);
}

export function validateCompileIdentity(identity: CompileCacheIdentity): void {
  if (!identity.sourceArtifactDigests.length || identity.sourceArtifactDigests.some(value => !/^sha256:[0-9a-f]{64}$/.test(value))) {
    throw new Error('compile identity requires valid pinned source digests');
  }
  const required = [identity.compiler.id, identity.compiler.version, identity.runtimeVersion, identity.schemaVersion,
    identity.canonicalizer.id, identity.canonicalizer.version, identity.adapter.id, identity.adapter.version,
    identity.adapter.promptVersion, identity.backendCapabilityMode, identity.modelPolicy.requested,
    identity.tenantId, identity.projectId, identity.dataClass];
  if (required.some(value => !value)) throw new Error('compile identity contains an empty semantic dimension');
}
