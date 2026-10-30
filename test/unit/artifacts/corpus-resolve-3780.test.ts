// Replay #3780 through the real resolve service and HTTP clients without network access.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReference } from '../../../src/artifacts/corpus-tools/resolve.js';
import { crossrefPaper, fixtureFetch, httpFixture, s2Paper, type HttpFixture } from '../../fixtures/research/resolve-http.js';
import { crossrefPair, exactCases, pairCases } from '../../fixtures/research/resolve-3780.js';

let root: string;
let state: HttpFixture;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('S2_API_KEY', '');
  root = mkdtempSync(join(tmpdir(), 'aiwg-resolve-3780-'));
  state = httpFixture();
  state.s2 = [];
  fetchMock = vi.fn(fixtureFetch(state));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});
async function run(input: string) {
  const pending = resolveReference(input, root);
  await vi.runAllTimersAsync();
  return pending;
}

describe('#3780 single exact matches', () => {
  it.each(exactCases)('resolves $title ($year) despite another source timing out', async item => {
    if (item.arxiv) state.arxiv = [{ id: item.arxiv, title: item.title, year: item.year }];
    else state.crossref = [crossrefPaper({ DOI: item.doi, title: [item.title], published: { 'date-parts': [[item.year]] } })];
    const base = fixtureFetch(state);
    fetchMock.mockImplementation(input => String(input).includes('semanticscholar') ? new Promise(() => {}) : base(input));
    const result = await run(`${item.title} (${item.year})`);
    expect(result).toMatchObject({ status: 'resolved', incomplete: true, paper: { title: item.title, year: item.year } });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ score: 1, score_parts: { title: 1, year: 1 } });
    expect(result.findings.some(f => f.type === 'title_ambiguous')).toBe(false);
  });
  describe.each([false, true])('bare titles with incomplete paths: %s', incomplete => {
    it.each(['Deep Learning', 'Scaling Laws', 'A tutorial on energy-based learning',
      'Theory of Ordinary Differential Equations', 'Logical physical clocks'])(
    'requests metadata for the sole exact candidate for %s', async title => {
      state.crossref = [crossrefPaper({ title: [title] })];
      if (incomplete) state.errors.arxiv = 503;
      const result = await run(title);
      expect(result).toMatchObject({ status: 'ambiguous', incomplete });
      expect(result).not.toHaveProperty('paper');
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].score).toBe(1);
      expect(result.findings).toContainEqual({ type: 'title_ambiguous', supplied: title,
        returned: 'Supply a year, author, or verified identifier to disambiguate this title' });
    });
  });
  it('resolves a lone generic title with a matching supplied author despite incomplete paths', async () => {
    state.crossref = [crossrefPaper({ title: ['Logical physical clocks'], author: [{ family: 'Example' }] })];
    state.errors.arxiv = 503;
    const result = await run('Example et al. 2024. Logical physical clocks');
    expect(result).toMatchObject({ status: 'resolved', incomplete: true,
      reference: { firstAuthor: 'Example' }, paper: { title: 'Logical physical clocks' } });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].score_parts.first_author).toBe(1);
    expect(result.findings).toEqual([]);
  });
  it('retains caution for a generic title with competing candidates', async () => {
    state.s2 = [s2Paper({ title: 'Deep Learning', externalIds: {} }),
      s2Paper({ title: 'Deep Learning Applications', paperId: 'b'.repeat(40), externalIds: {} })];
    const result = await run('Deep Learning');
    expect(result.status).toBe('ambiguous');
    expect(result.findings).toContainEqual(expect.objectContaining({ type: 'title_ambiguous' }));
  });
  it.each([
    { title: 'Hamiltonian Neural Networks', incomplete: true },
    { title: 'Logical physical clocks', incomplete: false },
    { title: 'Logical physical clocks', incomplete: true },
  ])('does not request a supplied year for $title (incomplete: $incomplete)', async ({ title, incomplete }) => {
    state.s2 = [s2Paper({ title, year: 2019, externalIds: {} }),
      s2Paper({ title, year: 2018, paperId: 'b'.repeat(40), externalIds: {} })];
    if (incomplete) state.errors.arxiv = 503;
    const result = await run(`${title} (2019)`);
    expect(result).toMatchObject({ status: 'ambiguous', incomplete });
    const finding = result.findings.find(f => f.type === 'title_ambiguous');
    expect(finding).toBeDefined();
    expect(finding!.returned).not.toMatch(/supply a year/i);
    expect(finding!.returned).toBe('Supply an author or verified identifier to disambiguate this title');
  });
});

describe('#3780 CrossRef preprint-publication pairs', () => {
  it.each(pairCases)('merges both CrossRef records for $title and keeps their DOIs', async pair => {
    state.crossref = crossrefPair(pair);
    const result = await run(pair.title);
    expect(result.status).toBe('resolved');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].score).toBe(1);
    expect(result.paper).toMatchObject({ doi: pair.doi, alternateDois: [pair.preprint], source: 'crossref' });
    expect(result.paths_tried[2].returned).toHaveLength(2);
  });
  it.each([-2, 2])('merges a preprint within the inclusive year gap %s', async gap => {
    state.crossref = crossrefPair(pairCases[3], gap);
    expect((await run(pairCases[3].title)).candidates).toHaveLength(1);
  });
  it.each(['authors', 'missing-authors', 'title', 'published', 'year'])(
    'does not merge when corroborating %s evidence is absent', async field => {
      const pair = pairCases[0];
      state.crossref = crossrefPair(pair);
      if (field === 'authors') state.crossref[1].author = [{ given: 'Other', family: 'Person' }];
      if (field === 'missing-authors') state.crossref[1].author = [];
      if (field === 'title') state.crossref[1].title = [`${pair.title} other work`];
      if (field === 'published') { state.crossref[1].DOI = '10.1234/other'; state.crossref[1].type = 'proceedings-article'; }
      if (field === 'year') state.crossref[1].published = { 'date-parts': [[pair.year - 3]] };
      expect((await run(pair.title)).candidates).toHaveLength(2);
    });
  it('keeps the reported 2022/2026 Manifold pair outside the explicit two-year bound', async () => {
    const title = 'Statistical Exploration of the Manifold Hypothesis';
    state.crossref = crossrefPair({ title, doi: '10.1093/jrsssb/qkag055', preprint: '10.48550/arxiv.2208.11665', year: 2026 }, 4);
    expect((await run(title)).candidates).toHaveLength(2);
  });
});

describe('#3780 incomplete distinguishes transport from metadata', () => {
  it('drops a CrossRef record with no year without losing its valid sibling or setting incomplete', async () => {
    const item = exactCases[1];
    state.crossref = [crossrefPaper({ title: [item.title], published: undefined }),
      crossrefPaper({ title: [item.title], DOI: item.doi, published: { 'date-parts': [[item.year]] } })];
    const result = await run(`${item.title} (${item.year})`);
    expect(result).toMatchObject({ status: 'resolved', incomplete: false, paper: { doi: item.doi } });
    expect(result.candidates).toHaveLength(1);
    expect(result.paths_tried[2]).toMatchObject({ status: 'returned', returned: [{ doi: item.doi }] });
  });
  it('returns a complete unresolved result when only invalid-year metadata was returned', async () => {
    state.crossref = [crossrefPaper({ title: [exactCases[1].title], published: undefined })];
    expect(await run(exactCases[1].title)).toMatchObject({ status: 'unresolved', incomplete: false, candidates: [] });
  });
  it.each([400, 401, 403, 404])('does not label a nontransient HTTP %s response incomplete', async status => {
    state.errors = { s2: status, arxiv: status, crossref: status };
    expect(await run(exactCases[0].title)).toMatchObject({ status: 'unresolved', incomplete: false });
  });
  it.each([429, 503])('keeps HTTP %s retryable and incomplete', async status => {
    state.errors = { s2: status, arxiv: status, crossref: status };
    expect(await run(exactCases[0].title)).toMatchObject({ status: 'deferred', incomplete: true });
  });
  it('keeps exhausted connection errors retryable and incomplete', async () => {
    fetchMock.mockRejectedValue(new TypeError('Synthetic connection failure'));
    expect(await run(exactCases[0].title)).toMatchObject({ status: 'deferred', incomplete: true });
  });
});
