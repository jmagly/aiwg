import { canonicalJson } from '../../security/artifact-trust.js';
import { resultCacheSha256 } from './key.js';
import type { ResultCacheEntry } from './types.js';

export class ResultCacheIntegrityError extends Error {}

export function entryIntegrityDigest(entry: Omit<ResultCacheEntry, 'integrityDigest'>): `sha256:${string}` {
  return resultCacheSha256(canonicalJson(entry));
}

export function assertResultCacheEntry(entry: ResultCacheEntry): void {
  if (entry.schemaVersion !== 'decision-result-cache/v1' || entry.revision !== 1) throw new ResultCacheIntegrityError('Unsupported cache entry schema');
  const { integrityDigest, ...unsigned } = entry;
  if (entryIntegrityDigest(unsigned) !== integrityDigest) throw new ResultCacheIntegrityError('Cache entry integrity check failed');
  if (entry.evidence.resultDigest !== resultCacheSha256(canonicalJson(entry.evidence.result))) throw new ResultCacheIntegrityError('Cached result digest mismatch');
  if (entry.expiresAtEpochMs <= entry.createdAtEpochMs) throw new ResultCacheIntegrityError('Invalid cache freshness interval');
  if (entry.evidence.durationMs < 0) throw new ResultCacheIntegrityError('Invalid original duration');
  if (entry.evidence.status === 'success' && entry.evidence.failureReason !== 'none') throw new ResultCacheIntegrityError('Successful evidence has a failure reason');
  if (entry.evidence.status === 'terminal-failure' && entry.evidence.failureReason !== 'invalid-input') throw new ResultCacheIntegrityError('Unsafe negative cache entry');
}
