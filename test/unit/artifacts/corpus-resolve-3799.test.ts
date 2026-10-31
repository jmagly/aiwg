// Guard supplied-year reprint disambiguation through offline HTTP clients and a mutation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReference, type ResolutionResult } from '../../../src/artifacts/corpus-tools/resolve.js';
import * as referenceMatch from '../../../src/research/reference-match.js';
import { fixtureFetch, httpFixture, type HttpFixture } from '../../fixtures/research/resolve-http.js';
import { ridge, ridgeRecords } from '../../fixtures/research/resolve-3799.js';

let root: string;
let state: HttpFixture;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('S2_API_KEY', '');
  root = mkdtempSync(join(tmpdir(), 'aiwg-resolve-3799-'));
  state = httpFixture();
  state.s2 = [];
  state.crossref = ridgeRecords();
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
function assertOriginal(result: ResolutionResult) {
  expect(result).toMatchObject({ status: 'resolved', paper: { doi: ridge.doi, year: ridge.year } });
  expect(result.findings).not.toContainEqual(expect.objectContaining({ type: 'title_ambiguous' }));
}

describe('#3799 supplied-year reprint tie', () => {
  it.each([false, true])('resolves the 1970 original (incomplete: %s)', async incomplete => {
    if (incomplete) state.errors.arxiv = 503;
    const result = await run(`${ridge.title} (${ridge.year})`);
    assertOriginal(result);
    expect(result.incomplete).toBe(incomplete);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({ score: 1, score_parts: { title: 1, year: 1 } });
    expect(result.candidates[1].score_parts).toEqual({ title: 1, year: 0 });
    expect(result.candidates[1].score).toBeCloseTo(0.947, 3);
    expect(result.candidates[0].paper.authors).toEqual(result.candidates[1].paper.authors);
  });
  it.each([false, true])('keeps the same pair ambiguous without a year (incomplete: %s)', async incomplete => {
    if (incomplete) state.errors.arxiv = 503;
    const result = await run(ridge.title);
    expect(result.status).toBe('ambiguous');
    expect(result).not.toHaveProperty('paper');
    expect(result.candidates.map(candidate => candidate.score)).toEqual([1, 1]);
    if (incomplete) expect(result.findings).toContainEqual(expect.objectContaining({ type: 'title_ambiguous' }));
  });
  it.each([false, true])('resolves a two-year gap (incomplete: %s)', async incomplete => {
    if (incomplete) state.errors.arxiv = 503;
    state.crossref[1].published = { 'date-parts': [[1972]] };
    assertOriginal(await run(`${ridge.title} (${ridge.year})`));
  });
  it('kills the mutation that counts a wrong-year reprint as competing again', async () => {
    state.errors.arxiv = 503;
    const original = referenceMatch.needsTitleDisambiguation;
    const mutation = vi.spyOn(referenceMatch, 'needsTitleDisambiguation').mockImplementation((reference, candidates, incomplete) =>
      original({ ...reference, year: undefined }, candidates, incomplete));
    try {
      const result = await run(`${ridge.title} (${ridge.year})`);
      expect(result.status).toBe('ambiguous');
      expect(result.findings).toContainEqual(expect.objectContaining({ type: 'title_ambiguous' }));
      expect(() => assertOriginal(result)).toThrow();
    } finally { mutation.mockRestore(); }
    assertOriginal(await run(`${ridge.title} (${ridge.year})`));
  });
});
