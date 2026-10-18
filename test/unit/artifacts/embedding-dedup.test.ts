import { mkdtempSync } from '../../helpers/temp-dir.js';
/**
 * Semantic dedup + readIndexSync round-trip (#1493).
 *
 * The full build/query/dedup pipeline needs @xenova/transformers + hnswlib-node
 * (optional peer deps). When absent these tests skip — matching
 * embedding-index.test.ts. The manifest-absent error path runs without deps.
 *
 * @source @src/artifacts/embedding-index.ts
 * @issue #1493
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  checkEmbeddingDeps,
  buildEmbeddingIndex,
  semanticQuery,
  dedupReport,
} from '../../../src/artifacts/embedding-index.js';
import type { MetadataEntry } from '../../../src/artifacts/embedding-index.js';

function entry(over: Partial<MetadataEntry>): MetadataEntry {
  return {
    path: 'x', type: 'document', phase: 'other', title: '', tags: [],
    created: '2026-01-01', updated: '2026-01-01', checksum: 'c', summary: '',
    dependencies: [], dependents: [], ...over,
  };
}

describe('dedupReport error path (no deps required)', () => {
  it('throws when there is no embedding index', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-nodedup-'));
    await expect(dedupReport(dir)).rejects.toThrow(/No embedding index/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('semantic pipeline round-trip (#1493)', () => {
  let available = false;
  beforeAll(async () => {
    available = (await checkEmbeddingDeps()).available;
  });

  it('builds, reads (readIndexSync), and ranks; dedup flags the near-duplicate pair', async () => {
    if (!available) {
      // Optional deps absent (e.g. CI) — pipeline can't run; the error-path
      // test above covers the no-deps behavior. Skip the live pipeline.
      return;
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-dedup-'));
    const entries: Record<string, MetadataEntry> = {
      'REF-A': entry({ path: 'REF-A', title: 'FlashAttention fast exact attention', summary: 'IO-aware exact attention algorithm reducing memory reads and writes on GPUs.' }),
      'REF-A2': entry({ path: 'REF-A2', title: 'FlashAttention: fast and exact attention', summary: 'An IO-aware exact attention algorithm that reduces GPU memory reads/writes.' }),
      'REF-B': entry({ path: 'REF-B', title: 'A study of social exclusion via fMRI', summary: 'Neuroimaging of rejection and social pain in the brain.' }),
    };
    const n = await buildEmbeddingIndex(entries, dir);
    expect(n).toBe(3);

    // Round-trip query proves readIndexSync actually loads the points (the
    // async readIndex bug returned an empty index).
    const hits = await semanticQuery('fast exact GPU attention algorithm', dir, 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(['REF-A', 'REF-A2']).toContain(hits[0].nodeId);

    // The two FlashAttention paraphrases are a near-duplicate pair; the fMRI
    // paper is not. A modest threshold isolates the dup.
    const pairs = await dedupReport(dir, 0.8);
    const flagged = pairs.find((p) => [p.a, p.b].sort().join('|') === 'REF-A|REF-A2');
    expect(flagged, 'FlashAttention paraphrase pair should be flagged').toBeTruthy();
    expect(pairs.some((p) => p.a === 'REF-B' || p.b === 'REF-B')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
