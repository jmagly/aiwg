/**
 * Filesystem cache store tests.
 *
 * @implements #1203
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clear, evict, get, has, list, put, stats } from '../../../src/rlm/cache/store.js';
import type { CacheEntry } from '../../../src/rlm/cache/types.js';

const HASH_A = '0'.repeat(64);
const HASH_B = '1'.repeat(64);

function entry(hash: string, createdAt: string, costUsd = 0.01): Omit<CacheEntry, 'hash'> & { hash: string } {
  return {
    hash,
    result: { findings: ['stub'] },
    manifest: { inputs: [{ artifactId: 'foo.ts', contentHash: 'x'.repeat(64) }] },
    metadata: {
      hash,
      query:             'stub query',
      subPrompt:         'stub sub-prompt',
      model:             'claude-sonnet-4-6',
      aggregateStrategy: 'concat',
      createdAt,
      costUsd,
    },
  };
}

describe('cache store', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiwg-rlm-cache-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips put → has → get', () => {
    const e = entry(HASH_A, '2026-05-09T00:00:00Z');
    put(root, e);
    expect(has(root, HASH_A)).toBe(true);
    const got = get(root, HASH_A);
    expect(got).toEqual(e);
  });

  it('rejects invalid hash format', () => {
    expect(() => has(root, 'not-a-hash')).toThrow(/Invalid cache hash/);
  });

  it('list returns empty for empty cache', () => {
    expect(list(root)).toEqual([]);
  });

  it('list returns sorted summaries', () => {
    // Both insertion and lexical hash order oppose chronological order.
    put(root, entry(HASH_A, '2026-05-08T00:00:00Z', 0.02));
    put(root, entry(HASH_B, '2026-05-01T00:00:00Z', 0.03));
    const result = list(root, new Date('2026-05-09T00:00:00Z'));
    expect(result).toEqual([
      {
        hash: HASH_B, model: 'claude-sonnet-4-6', query: 'stub query',
        createdAt: '2026-05-01T00:00:00Z', ageDays: 8, inputCount: 1, costUsd: 0.03,
      },
      {
        hash: HASH_A, model: 'claude-sonnet-4-6', query: 'stub query',
        createdAt: '2026-05-08T00:00:00Z', ageDays: 1, inputCount: 1, costUsd: 0.02,
      },
    ]);
  });

  it('stats aggregates counts, sizes, ages, and cost', () => {
    put(root, entry(HASH_A, '2026-05-01T00:00:00Z', 0.05));
    put(root, entry(HASH_B, '2026-05-08T00:00:00Z', 0.10));
    const s = stats(root, new Date('2026-05-09T00:00:00Z'));
    expect(s.totalEntries).toBe(2);
    expect(s.totalSizeKb).toBeGreaterThan(0);
    expect(s.oldestAgeDays).toBe(8);
    expect(s.newestAgeDays).toBe(1);
    expect(s.totalCostUsd).toBeCloseTo(0.15, 5);
  });

  it('evict by hash removes single entry', () => {
    put(root, entry(HASH_A, '2026-05-09T00:00:00Z'));
    put(root, entry(HASH_B, '2026-05-09T00:00:00Z'));
    const r = evict(root, { hash: HASH_A });
    expect(r.evictedCount).toBe(1);
    expect(r.hashes).toEqual([HASH_A]);
    expect(has(root, HASH_A)).toBe(false);
    expect(has(root, HASH_B)).toBe(true);
  });

  it('evict --older-than removes only old entries', () => {
    put(root, entry(HASH_A, '2026-04-01T00:00:00Z'));   // ~38 days
    put(root, entry(HASH_B, '2026-05-08T00:00:00Z'));   // 1 day
    const r = evict(root, { olderThanDays: 30 }, new Date('2026-05-09T00:00:00Z'));
    expect(r.evictedCount).toBe(1);
    expect(r.hashes).toEqual([HASH_A]);
    expect(has(root, HASH_A)).toBe(false);
    expect(has(root, HASH_B)).toBe(true);
  });

  it('evict requires either hash or olderThanDays', () => {
    expect(() => evict(root, {})).toThrow(/either \{hash\}/);
  });

  it('clear wipes all entries', () => {
    put(root, entry(HASH_A, '2026-05-09T00:00:00Z'));
    put(root, entry(HASH_B, '2026-05-09T00:00:00Z'));
    const r = clear(root);
    expect(r.evictedCount).toBe(2);
    expect(list(root)).toEqual([]);
  });

  it('list ignores non-hash directory entries', () => {
    // Simulate stray file
    put(root, entry(HASH_A, '2026-05-09T00:00:00Z'));
    // Create a non-hash subdir
    require('node:fs').mkdirSync(join(root, 'not-a-hash'), { recursive: true });
    const result = list(root);
    expect(result).toHaveLength(1);
    expect(result[0]?.hash).toBe(HASH_A);
  });
});
