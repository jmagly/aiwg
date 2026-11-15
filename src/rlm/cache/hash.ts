/**
 * Deterministic cache key composition.
 *
 * The hash includes content hashes (not just artifact IDs) so file edits
 * invalidate the cache cleanly. Inputs are sorted by artifactId so caller
 * order does not affect the resulting hash.
 *
 * @implements #1203
 * @see docs/architecture/index-and-manifest-loading.md
 */

import { createHash } from 'node:crypto';
import type { CacheKey } from './types.js';

/** Compute a stable sha256 hex hash for a cache key. */
export function computeHash(key: CacheKey): string {
  const sortedInputs = [...key.inputs].sort((a, b) =>
    a.artifactId.localeCompare(b.artifactId)
  );
  const canonical = JSON.stringify({
    inputs:            sortedInputs,
    query:             key.query,
    subPrompt:         key.subPrompt,
    model:             key.model,
    aggregateStrategy: key.aggregateStrategy,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Validate a cache key has the minimum required fields. */
export function isCacheKey(value: unknown): value is CacheKey {
  if (!value || typeof value !== 'object') return false;
  const k = value as Record<string, unknown>;
  return (
    Array.isArray(k['inputs']) &&
    typeof k['query']             === 'string' &&
    typeof k['subPrompt']         === 'string' &&
    typeof k['model']             === 'string' &&
    typeof k['aggregateStrategy'] === 'string'
  );
}
