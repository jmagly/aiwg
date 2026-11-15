/**
 * RLM Result Cache — Type Definitions
 *
 * @implements #1203
 * @see docs/architecture/index-and-manifest-loading.md
 */

/** One artifact contributing to a cache key. */
export interface CacheInput {
  artifactId:  string;
  contentHash: string;
}

/** Composite key inputs that fully determine a cache entry. */
export interface CacheKey {
  inputs:            CacheInput[];
  query:             string;
  subPrompt:         string;
  model:             string;
  aggregateStrategy: string;
}

/** Cache manifest — which artifacts contributed. */
export interface CacheManifest {
  inputs: CacheInput[];
}

/** Cache metadata — query, prompt, model, cost. */
export interface CacheMetadata {
  hash:              string;
  query:             string;
  subPrompt:         string;
  model:             string;
  aggregateStrategy: string;
  createdAt:         string;   // ISO8601
  tokensIn?:         number;
  tokensOut?:        number;
  costUsd?:          number;
}

/** Materialized cache entry on disk. */
export interface CacheEntry {
  hash:     string;
  result:   unknown;
  manifest: CacheManifest;
  metadata: CacheMetadata;
}

/** Cache list row (compact summary). */
export interface CacheEntrySummary {
  hash:        string;
  model:       string;
  query:       string;        // truncated to 80 chars
  createdAt:   string;
  ageDays:     number;
  inputCount:  number;
  costUsd:     number | null;
}

/** Cache statistics. */
export interface CacheStats {
  totalEntries:  number;
  totalSizeKb:   number;
  oldestAgeDays: number | null;
  newestAgeDays: number | null;
  totalCostUsd:  number;       // sum of all metadata.costUsd
}

/** Eviction policy options. */
export interface EvictionOptions {
  olderThanDays?: number;
  hash?:          string;
}

/** Eviction result. */
export interface EvictionResult {
  evictedCount: number;
  evictedBytes: number;
  hashes:       string[];
}
