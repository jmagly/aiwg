import { createHash } from 'node:crypto';
import { canonicalJson } from '../../security/artifact-trust.js';
import type { ResultCacheSemanticIdentity } from './types.js';

export function digestResultCacheIdentity(identity: ResultCacheSemanticIdentity): `sha256:${string}` {
  return resultCacheSha256(canonicalJson(normalizeSemanticStrings(identity)));
}

export function digestCachedResult(value: unknown): `sha256:${string}` { return resultCacheSha256(canonicalJson(value)); }

/** NFC normalizes equivalent Unicode input without conflating distinct object keys. */
function normalizeSemanticStrings(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(normalizeSemanticStrings);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [rawKey, child] of Object.entries(value)) {
      const key = rawKey.normalize('NFC');
      if (Object.hasOwn(result, key)) throw new Error('Ambiguous Unicode keys in semantic identity');
      result[key] = normalizeSemanticStrings(child);
    }
    return result;
  }
  return value;
}

export function resultCacheSha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
