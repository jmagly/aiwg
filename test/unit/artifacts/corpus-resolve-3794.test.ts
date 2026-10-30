// Replay runner-up and year findings through real HTTP clients using local fixtures only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReference } from '../../../src/artifacts/corpus-tools/resolve.js';
import { resolveCli } from '../../../src/artifacts/corpus-tools/resolve-cli.js';
import { classifyCandidates, needsTitleDisambiguation, needsYearReview } from '../../../src/research/reference-match.js';
import { crossrefPaper, fixtureFetch, httpFixture, s2Paper, type HttpFixture } from '../../fixtures/research/resolve-http.js';
import { control, distantRunner, planning, planningRecord, trees, treesRecords } from '../../fixtures/research/resolve-3794.js';

let root: string;
let state: HttpFixture;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('S2_API_KEY', '');
  root = mkdtempSync(join(tmpdir(), 'aiwg-resolve-3794-'));
  state = httpFixture();
  state.s2 = [];
  vi.stubGlobal('fetch', vi.fn(fixtureFetch(state)));
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

describe('#3794 runner-up distance', () => {
  it.each([false, true])('resolves the trees winner over a distant chapter (incomplete: %s)', async incomplete => {
    state.crossref = treesRecords();
    if (incomplete) state.errors.arxiv = 503;
    const result = await run(`${trees.title} (${trees.year})`);
    expect(result).toMatchObject({ status: 'resolved', incomplete, paper: { doi: trees.doi, year: trees.year } });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({ score: 1, score_parts: { title: 1, year: 1 } });
    expect(result.candidates[1].score).toBeCloseTo(0.711, 3);
    expect(result.candidates[1].score_parts.year).toBe(0);
    expect(result.findings).toEqual([]);
  });
});

describe('#3794 year findings', () => {
  it('rejects the 1971 control candidate carrying an uncorroborated arXiv id and DOI', async () => {
    state.s2 = [s2Paper({ title: control.title, year: 1971, authors: [],
      externalIds: { ArXiv: '9999.99999', DOI: '10.1234/different-work' },
      venue: undefined, publicationVenue: undefined })];
    const result = await run('"Applied optimal control" (1972)');
    expect(result).toMatchObject({ status: 'ambiguous', incomplete: false });
    expect(result).not.toHaveProperty('paper');
    expect(result.reference.identifier).toBeUndefined();
    expect(result.reference.firstAuthor).toBeUndefined();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].paper).toMatchObject({ arxivId: '9999.99999', doi: '10.1234/different-work' });
    expect(result.findings).toEqual([{ type: 'year_conflict', supplied: '1972', returned: '1971',
      candidate: result.candidates[0].paper.id }]);
  });
  it('resolves a one-year gap with a supplied matching first author and no identifiers', async () => {
    state.s2 = [s2Paper({ title: control.title, year: 1971, externalIds: {} })];
    const result = await run('Example, A. (1972). Applied optimal control.');
    expect(result).toMatchObject({ status: 'resolved', reference: { firstAuthor: 'Example' },
      paper: { title: control.title, year: 1971 } });
    expect(result.candidates[0].score_parts).toEqual({ title: 1, year: 0, first_author: 1 });
    expect(result.findings).toEqual([{ type: 'year_mismatch', supplied: '1972', returned: '1971', candidate: result.paper!.id }]);
  });
  it('resolves planning from the sole S2 record linking both ids to a venue', async () => {
    state.s2 = [planningRecord()];
    const result = await run(`${planning.title} (${planning.venueYear})`);
    expect(result).toMatchObject({ status: 'resolved', paper: { arxivId: planning.arxiv, doi: planning.doi, venue: 'CVPR' } });
    expect(result.candidates).toHaveLength(1);
    expect(result.findings).toEqual([{ type: 'year_mismatch', supplied: '2023', returned: '2022', candidate: result.paper!.id }]);
  });
  it('does not resolve a different Applied optimal control work from 1971 for the supplied 1972', async () => {
    state.crossref = [crossrefPaper({ title: [control.title], DOI: '10.1234/different-work',
      published: { 'date-parts': [[1971]] } })];
    const result = await run('"Applied optimal control" (1972)');
    expect(result).toMatchObject({ status: 'ambiguous', incomplete: false });
    expect(result).not.toHaveProperty('paper');
    expect(result.candidates).toHaveLength(1);
    expect(result.findings).toEqual([{ type: 'year_conflict', supplied: '1972', returned: '1971',
      candidate: '10.1234/different-work' }]);
  });
  it.each([[2025, 'resolved', 'year_mismatch'], [2028, 'ambiguous', 'year_conflict']] as const)(
    'pins verified DOI year policy for %s', async (year, status, finding) => {
    state.idTitle = control.title;
    const result = await run(`"${control.title}" (${year}) DOI:10.1234/fixture`);
    expect(result.status).toBe(status);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].score_parts).toMatchObject({ title: 1, identifier: 1, year: 0 });
    expect(result.candidates[0].paper.arxivId).toBeUndefined();
    expect(result.findings).toEqual([{ type: finding, supplied: String(year), returned: '2024',
      candidate: result.candidates[0].paper.id }]);
    if (status === 'resolved') expect(result.paper).toBeDefined();
    else expect(result).not.toHaveProperty('paper');
  });
  it.each([false, true])('resolves the exact planning title one year off (incomplete: %s)', async incomplete => {
    state.s2 = [planningRecord(), distantRunner()];
    state.arxiv = [{ id: planning.arxiv, title: planning.title, year: planning.year }];
    if (incomplete) state.errors.crossref = 503;
    const result = await run(`${planning.title} (${planning.venueYear})`);
    expect(result).toMatchObject({ status: 'resolved', incomplete,
      paper: { title: planning.title, year: planning.year, arxivId: planning.arxiv, doi: planning.doi } });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].score_parts).toMatchObject({ title: 1, year: 0 });
    expect(result.findings).toEqual([{ type: 'year_mismatch', supplied: '2023', returned: '2022', candidate: result.paper!.id }]);
  });
  it('also reports the one-year mismatch when the published venue year owns the merged record', async () => {
    state.s2 = [planningRecord(), distantRunner()];
    state.crossref = [crossrefPaper({ title: [planning.title], DOI: planning.doi,
      published: { 'date-parts': [[planning.venueYear]] }, type: 'proceedings-article' })];
    const result = await run(`${planning.title} (${planning.year})`);
    expect(result).toMatchObject({ status: 'resolved', paper: { year: 2023, arxivId: planning.arxiv, doi: planning.doi } });
    expect(result.findings).toEqual([{ type: 'year_mismatch', supplied: '2022', returned: '2023', candidate: planning.doi }]);
  });
  it('does not let a one-year allowance override close distinct title candidates', async () => {
    state.s2 = [planningRecord(), s2Paper({ title: planning.title, year: planning.year,
      paperId: 'b'.repeat(40), externalIds: { DOI: '10.1234/fixture-other-work' } })];
    const result = await run(`${planning.title} (${planning.venueYear})`);
    expect(result.status).toBe('ambiguous');
    expect(result).not.toHaveProperty('paper');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].score - result.candidates[1].score).toBe(0);
  });
  it.each([false, true])('keeps the four-year control gap under review (incomplete: %s)', async incomplete => {
    state.crossref = [crossrefPaper({ title: [control.title], published: { 'date-parts': [[control.year]] } })];
    if (incomplete) state.errors.arxiv = 503;
    const result = await run(`${control.title} (${control.suppliedYear})`);
    expect(result).toMatchObject({ status: 'ambiguous', incomplete });
    expect(result).not.toHaveProperty('paper');
    expect(result.candidates[0].score_parts).toMatchObject({ title: 1, year: 0 });
    expect(result.findings).toEqual([{ type: 'year_conflict', supplied: '1975', returned: '1971', candidate: '10.1234/fixture' }]);
  });
  it('downgrades an otherwise resolved 1979 control record solely because of yearConflict', async () => {
    state.crossref = [crossrefPaper({ title: [control.title], published: { 'date-parts': [[1979]] } })];
    const result = await run(`${control.title} (1975)`);
    expect(classifyCandidates(result.candidates)).toBe('resolved');
    expect(needsTitleDisambiguation(result.reference, result.candidates, result.incomplete)).toBe(false);
    expect(needsYearReview(result.reference, result.candidates[0])).toBe(true);
    expect(result.reference.identifier).toBeUndefined();
    expect(result.status).toBe('ambiguous');
    expect(result).not.toHaveProperty('paper');
    expect(result.findings).toEqual([{ type: 'year_conflict', supplied: '1975', returned: '1979', candidate: '10.1234/fixture' }]);
  });
  it('requires review for a fuzzy title even when the year gap is only one', async () => {
    state.s2 = [planningRecord()];
    const result = await run(`Planning-oriented autonomous driving models (${planning.venueYear})`);
    expect(result.status).toBe('ambiguous');
    expect(result).not.toHaveProperty('paper');
    expect(result.findings).toContainEqual(expect.objectContaining({ type: 'year_conflict', supplied: '2023', returned: '2022' }));
  });
  it.each([
    { title: planning.title, supplied: 2023, returned: 2022, finding: 'year_mismatch', exitCode: 0 },
    { title: control.title, supplied: 1975, returned: 1971, finding: 'year_conflict', exitCode: 2 },
  ])('prints both years and preserves exit $exitCode for $finding', async item => {
    state.crossref = [crossrefPaper({ title: [item.title], published: { 'date-parts': [[item.returned]] } })];
    if (item.title === planning.title) state.arxiv = [{ id: planning.arxiv, title: planning.title, year: item.returned }];
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
    const pending = resolveCli([`${item.title} (${item.supplied})`], root, root).catch(error => error);
    await vi.runAllTimersAsync();
    const error = await pending;
    if (item.exitCode) expect(error).toMatchObject({ exitCode: item.exitCode });
    else expect(error).toBeUndefined();
    expect(output).toContain(`Finding ${item.finding}: supplied "${item.supplied}"; returned "${item.returned}"`);
    expect(output).not.toContain('title_ambiguous');
  });
});
