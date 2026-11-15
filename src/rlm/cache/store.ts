/**
 * RLM result cache filesystem store.
 *
 * Layout:
 *   .aiwg/working/rlm-cache/{hash}/
 *     ├── result.json
 *     ├── manifest.json
 *     └── metadata.json
 *
 * @implements #1203
 * @see docs/architecture/index-and-manifest-loading.md
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  CacheEntry,
  CacheEntrySummary,
  CacheManifest,
  CacheMetadata,
  CacheStats,
  EvictionOptions,
  EvictionResult,
} from './types.js';

const CACHE_ROOT_DEFAULT = '.aiwg/working/rlm-cache';

const HASH_RE = /^[0-9a-f]{64}$/;

/** Resolve cache root, allowing tests to override. */
export function resolveCacheRoot(cwd: string = process.cwd()): string {
  return join(cwd, CACHE_ROOT_DEFAULT);
}

/** Compute the directory for a single entry. */
function entryDir(root: string, hash: string): string {
  if (!HASH_RE.test(hash)) {
    throw new Error(`Invalid cache hash: ${hash}`);
  }
  return join(root, hash);
}

/** Check whether a cache entry exists. */
export function has(root: string, hash: string): boolean {
  return existsSync(join(entryDir(root, hash), 'result.json'));
}

/** Read a full entry from disk. Throws on missing. */
export function get(root: string, hash: string): CacheEntry {
  const dir = entryDir(root, hash);
  if (!existsSync(dir)) {
    throw new Error(`Cache miss: ${hash}`);
  }
  const result   = JSON.parse(readFileSync(join(dir, 'result.json'),   'utf-8')) as unknown;
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) as CacheManifest;
  const metadata = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf-8')) as CacheMetadata;
  return { hash, result, manifest, metadata };
}

/** Write an entry, atomically per-file. Returns the entry directory. */
export function put(
  root:     string,
  entry:    Omit<CacheEntry, 'hash'> & { hash: string },
): string {
  const dir = entryDir(root, entry.hash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'),   JSON.stringify(entry.result,   null, 2), 'utf-8');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(entry.manifest, null, 2), 'utf-8');
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify(entry.metadata, null, 2), 'utf-8');
  return dir;
}

/** List all entries (compact summary form). */
export function list(root: string, now: Date = new Date()): CacheEntrySummary[] {
  if (!existsSync(root)) return [];
  const out: CacheEntrySummary[] = [];
  for (const name of readdirSync(root)) {
    if (!HASH_RE.test(name)) continue;
    const metaPath = join(root, name, 'metadata.json');
    if (!existsSync(metaPath)) continue;
    let meta: CacheMetadata;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as CacheMetadata;
    } catch {
      continue;
    }
    const manifestPath = join(root, name, 'manifest.json');
    let inputCount = 0;
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as CacheManifest;
        inputCount = manifest.inputs.length;
      } catch { /* ignore */ }
    }
    const ageMs   = now.getTime() - new Date(meta.createdAt).getTime();
    const ageDays = Math.max(0, Math.floor(ageMs / 86_400_000));
    out.push({
      hash:       name,
      model:      meta.model,
      query:      meta.query.length > 80 ? meta.query.slice(0, 77) + '...' : meta.query,
      createdAt:  meta.createdAt,
      ageDays,
      inputCount,
      costUsd:    typeof meta.costUsd === 'number' ? meta.costUsd : null,
    });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Aggregate statistics. */
export function stats(root: string, now: Date = new Date()): CacheStats {
  const entries = list(root, now);
  if (entries.length === 0) {
    return { totalEntries: 0, totalSizeKb: 0, oldestAgeDays: null, newestAgeDays: null, totalCostUsd: 0 };
  }
  let totalBytes = 0;
  for (const e of entries) {
    const dir = entryDir(root, e.hash);
    for (const f of ['result.json', 'manifest.json', 'metadata.json']) {
      const p = join(dir, f);
      if (existsSync(p)) totalBytes += statSync(p).size;
    }
  }
  const ages = entries.map((e) => e.ageDays);
  const totalCostUsd = entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  return {
    totalEntries:  entries.length,
    totalSizeKb:   Math.round(totalBytes / 1024),
    oldestAgeDays: Math.max(...ages),
    newestAgeDays: Math.min(...ages),
    totalCostUsd,
  };
}

/** Remove entries matching the given options. */
export function evict(
  root: string,
  opts: EvictionOptions,
  now:  Date = new Date(),
): EvictionResult {
  if (!existsSync(root)) {
    return { evictedCount: 0, evictedBytes: 0, hashes: [] };
  }
  const targets: string[] = [];
  if (opts.hash) {
    if (existsSync(entryDir(root, opts.hash))) targets.push(opts.hash);
  } else if (typeof opts.olderThanDays === 'number') {
    const cutoff = now.getTime() - opts.olderThanDays * 86_400_000;
    for (const e of list(root, now)) {
      if (new Date(e.createdAt).getTime() < cutoff) targets.push(e.hash);
    }
  } else {
    throw new Error('evict() requires either {hash} or {olderThanDays}');
  }

  let evictedBytes = 0;
  for (const h of targets) {
    const dir = entryDir(root, h);
    if (existsSync(dir)) {
      for (const f of ['result.json', 'manifest.json', 'metadata.json']) {
        const p = join(dir, f);
        if (existsSync(p)) evictedBytes += statSync(p).size;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { evictedCount: targets.length, evictedBytes, hashes: targets };
}

/** Wipe the entire cache. Caller is responsible for confirmation. */
export function clear(root: string): EvictionResult {
  if (!existsSync(root)) {
    return { evictedCount: 0, evictedBytes: 0, hashes: [] };
  }
  const before = list(root);
  let evictedBytes = 0;
  for (const e of before) {
    const dir = entryDir(root, e.hash);
    for (const f of ['result.json', 'manifest.json', 'metadata.json']) {
      const p = join(dir, f);
      if (existsSync(p)) evictedBytes += statSync(p).size;
    }
  }
  rmSync(root, { recursive: true, force: true });
  return { evictedCount: before.length, evictedBytes, hashes: before.map((e) => e.hash) };
}
