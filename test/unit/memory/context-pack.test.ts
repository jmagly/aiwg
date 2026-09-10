import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildContextPack,
  buildWorkspaceContextPack,
  type ContextCandidate,
  type ContextPackBudget,
} from '../../../src/memory/context-pack.js';

const discovery = vi.hoisted(() => ({ observe: undefined as (() => void) | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, realpathSync: (...args: Parameters<typeof original.realpathSync>) => {
    discovery.observe?.();
    return original.realpathSync(...args);
  } };
});

const roots: string[] = [];
afterEach(() => {
  discovery.observe = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function candidate(overrides: Partial<ContextCandidate>): ContextCandidate {
  return {
    tier: 'line',
    text: 'SQLite remains the authoritative session catalog.',
    locator: 'line-memory:one',
    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    score: 1,
    backend: 'fixture',
    verified: true,
    state: 'active',
    freshness: null,
    ...overrides,
  };
}

describe('bounded hybrid context packs', () => {
  it.each(['totalCharacters', 'lineCharacters', 'wikiCharacters', 'citationCharacters'] as const)(
    'independently enforces cumulative %s at exact fit and one over', (dimension) => {
      const tier = dimension === 'wikiCharacters' ? 'wiki' : 'line';
      const candidates = [candidate({ tier, text: 'a'.repeat(160), locator: 'first', digest: null }),
        candidate({ tier, text: 'b'.repeat(160), locator: 'second', digest: null, score: 0.5 })];
      const total = 331;
      const limit = dimension === 'totalCharacters' ? total : dimension === 'citationCharacters' ? 11 : 320;
      for (const excess of [0, 1]) {
        const budget: ContextPackBudget = { totalCharacters: 1000, lineCharacters: 1000, wikiCharacters: 1000, citationCharacters: 1000, instructionCharacters: 1000, [dimension]: limit - excess };
        const pack = buildContextPack('budget', candidates, { budget });
        expect(pack.items.map(item => item.locator)).toEqual(excess ? ['first'] : ['first', 'second']);
        const reason = dimension === 'totalCharacters' ? 'total-budget' : dimension === 'citationCharacters' ? 'citation-budget' : `${tier}-budget`;
        expect(pack.excluded).toEqual(excess ? [{ locator: 'second', reason }] : []);
        expect(pack.truncated).toBe(Boolean(excess));
        expect(pack.used).toEqual({ totalCharacters: excess ? 165 : total, lineCharacters: tier === 'line' ? excess ? 160 : 320 : 0, wikiCharacters: tier === 'wiki' ? excess ? 160 : 320 : 0, citationCharacters: excess ? 5 : 11, instructionCharacters: 0 });
      }
    },
  );

  it.each(['instructionCharacters', 'totalCharacters'] as const)(
    'independently enforces cumulative instruction %s', (dimension) => {
      const instructions = [{ text: 'a'.repeat(128), locator: 'one', trust: 'trusted' as const }, { text: 'b'.repeat(129), locator: 'two', trust: 'trusted' as const }];
      for (const excess of [0, 1]) {
        const pack = buildContextPack('instructions', [], { instructions, budget: { totalCharacters: 1000, instructionCharacters: 1000, [dimension]: 257 - excess } });
        expect(pack.instructions).toEqual(excess ? instructions.slice(0, 1) : instructions);
        expect(pack.excluded).toEqual(excess ? [{ locator: 'two', reason: 'instruction-budget' }] : []);
        expect(pack.used).toEqual({ totalCharacters: excess ? 128 : 257, instructionCharacters: excess ? 128 : 257, lineCharacters: 0, wikiCharacters: 0, citationCharacters: 0 });
        expect(pack.truncated).toBe(Boolean(excess));
      }
      if (dimension === 'instructionCharacters') {
        const pack = buildContextPack('zero', [], { instructions: instructions.slice(0, 1), budget: { instructionCharacters: 0 } });
        expect(pack.instructions).toEqual([]);
        expect(pack.excluded).toEqual([{ locator: 'one', reason: 'instruction-budget' }]);
        expect(pack.used.totalCharacters).toBe(0);
        expect(pack.used.instructionCharacters).toBe(0);
      }
    },
  );

  it('deduplicates and excludes invalid lifecycle states under combined limits', () => {
    const pack = buildContextPack('authoritative catalog', [
      candidate({}),
      candidate({ tier: 'wiki', locator: '.aiwg/wiki/catalog.md', score: 0.9 }),
      candidate({
        tier: 'wiki',
        locator: '.aiwg/wiki/old.md',
        text: 'The old catalog is authoritative.',
        state: 'superseded',
      }),
      candidate({
        tier: 'wiki',
        locator: '.aiwg/wiki/detail.md',
        text: 'Catalog provenance is retained through exact source spans.',
        score: 0.8,
      }),
    ], {
      budget: {
        totalCharacters: 256,
        lineCharacters: 100,
        wikiCharacters: 100,
        citationCharacters: 100,
        instructionCharacters: 0,
      },
    });
    expect(pack.items.map(item => item.locator)).toContain('line-memory:one');
    expect(pack.items.every(item => item.trust === 'quoted-data')).toBe(true);
    expect(pack.excluded).toEqual(expect.arrayContaining([
      { locator: '.aiwg/wiki/catalog.md', reason: 'duplicate-claim' },
      { locator: '.aiwg/wiki/old.md', reason: 'superseded' },
    ]));
    expect(pack.used.totalCharacters).toBeLessThanOrEqual(256);
    expect(pack.used.lineCharacters).toBeLessThanOrEqual(100);
    expect(pack.used.wikiCharacters).toBeLessThanOrEqual(100);
    expect(pack.used.citationCharacters).toBeLessThanOrEqual(100);
  });

  it('combines relevant line and wiki evidence using deterministic lexical fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-context-pack-'));
    roots.push(root);
    mkdirSync(join(root, '.aiwg/memory'), { recursive: true });
    mkdirSync(join(root, '.aiwg/wiki/concepts'), { recursive: true });
    writeFileSync(join(root, '.aiwg/memory/line-memory.txt'), [
      'SQLite is the authoritative session catalog.',
      'Unrelated deployment preference.',
    ].join('\n'));
    writeFileSync(join(root, '.aiwg/wiki/concepts/catalog.md'), [
      '---',
      'source: session:catalog-decision',
      '---',
      '# Session catalog',
      'The SQLite catalog retains source provenance and review receipts.',
    ].join('\n'));

    const first = buildWorkspaceContextPack(root, 'SQLite catalog provenance', { maxFiles: 20 });
    const second = buildWorkspaceContextPack(root, 'SQLite catalog provenance', { maxFiles: 20 });
    expect(first.id).toBe(second.id);
    expect(first.items.map(item => item.tier)).toEqual(expect.arrayContaining(['line', 'wiki']));
    expect(first.items.some(item => item.text.includes('Unrelated deployment'))).toBe(false);
    expect(first.backend).toEqual(['line-memory-lexical', 'wiki-lexical-fallback']);
    // Timing is validated separately with a deterministic clock, not a host SLA.
  });

  it('reports whole-workspace elapsed time while preserving standalone assembly timing', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-context-timing-'));
    roots.push(root);
    mkdirSync(join(root, '.aiwg/memory'), { recursive: true });
    writeFileSync(join(root, '.aiwg/memory/line-memory.txt'), 'SQLite catalog');
    let time = 10;
    let reads = 0;
    discovery.observe = () => { reads++; time += 100; };
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
    const pack = buildWorkspaceContextPack(root, 'SQLite');
    expect(reads).toBeGreaterThan(0);
    expect(pack.metrics.elapsedMs).toBe(reads * 100);
    expect(clock).toHaveBeenCalledTimes(4);
    clock.mockReset().mockReturnValueOnce(200).mockReturnValueOnce(207);
    expect(buildContextPack('SQLite', [candidate({})]).metrics.elapsedMs).toBe(7);
    expect(clock).toHaveBeenCalledTimes(2);
  });
});
