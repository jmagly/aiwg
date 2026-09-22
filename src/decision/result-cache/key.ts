import { createHash } from 'node:crypto';
import { canonicalJson } from '../../security/artifact-trust.js';
import type { ResultCacheSemanticIdentity } from './types.js';

export function digestResultCacheIdentity(identity: ResultCacheSemanticIdentity): `sha256:${string}` {
  return resultCacheSha256(canonicalJson(identity));
}

export function digestCachedResult(value: unknown): `sha256:${string}` { return resultCacheSha256(canonicalJson(value)); }

export function resultCacheSha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
