// Guard ordered title scoring and identifier-backed work deduplication.
import { describe, expect, it } from 'vitest';
import { classifyCandidates, mergePapers, needsTitleDisambiguation, parsePartialReference, scorePaper, titleSimilarity } from '../../../src/research/reference-match.js';
import type { ResearchPaper } from '../../../src/research/types.js';

const paper = (overrides: Partial<ResearchPaper>): ResearchPaper => ({
  id: '2303.12077', arxivId: '2303.12077', title: 'VAD: Vectorized Scene Representation for Efficient Autonomous Driving',
  authors: [{ name: 'Bo Jiang' }], year: 2023, source: 'arxiv', type: 'preprint', retrievedAt: '', ...overrides,
});

describe('ordered title similarity', () => {
  it('scores the reordered Attention title below the resolution threshold', () => {
    expect(titleSimilarity('Is Attention All You Need?', 'Attention Is All You Need')).toBeLessThan(0.92);
    expect(titleSimilarity('Attention Is All You Need!', 'Attention Is All You Need')).toBe(1);
  });
  it('penalizes repeated tokens as well as order', () => {
    expect(titleSimilarity('attention attention is all you need', 'attention is all you need')).toBeLessThan(1);
  });
  it('preserves ordered subset coverage for the approved boundary fixtures', () => {
    const words = Array.from({ length: 100 }, (_, i) => `token${i}`);
    expect(titleSimilarity(words.join(' '), words.slice(0, 92).join(' '))).toBeCloseTo(0.92, 12);
  });
});

describe('one work with preprint and published identifiers', () => {
  const preprint = paper({ doi: '10.48550/arXiv.2303.12077' });
  const published = paper({ id: '10.1109/iccv51070.2023.00766', arxivId: undefined,
    doi: '10.1109/iccv51070.2023.00766', source: 'crossref', type: 'conference' });
  const bridge = paper({ id: 's2-vad', source: 'semantic-scholar', s2PaperId: 's2-vad', doi: published.doi });
  it.each([
    [preprint, published, bridge], [bridge, published, preprint], [published, preprint, bridge],
  ])('merges the full component regardless of source order', (...records) => {
    const merged = mergePapers(records);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: published.id, source: 'crossref', type: 'conference',
      doi: published.doi, arxivId: '2303.12077', s2PaperId: 's2-vad' });
    expect(preprint.doi).toBe('10.48550/arXiv.2303.12077');
  });
  it('recognizes an arXiv DOI without an explicit arxivId', () => {
    expect(mergePapers([paper({ arxivId: undefined, doi: '10.48550/arXiv.2303.12077' }), paper({})])).toHaveLength(1);
  });
  it('keeps conflicting published DOIs separate even with an arXiv link', () => {
    expect(mergePapers([bridge, paper({ doi: '10.1234/different' })])).toHaveLength(2);
  });
  it('does not let merged preprint identities bridge different published DOIs', () => {
    const first = paper({ ...published, arxivId: preprint.arxivId, alternateDois: [preprint.doi!] });
    const second = paper({ ...first, id: '10.1234/different', doi: '10.1234/different' });
    expect(mergePapers([first, second])).toHaveLength(2);
  });
  it('never merges on title, year and author alone', () => {
    expect(mergePapers([paper({ arxivId: undefined }), published])).toHaveLength(2);
  });
  it.each(['doi', 'arxivId'] as const)('vetoes a misattributed shared %s when titles strongly disagree', key => {
    const real = paper({ arxivId: undefined, [key]: key === 'doi' ? '10.1234/real' : '2303.12077', source: 'crossref' });
    const wrong = paper({ ...real, id: 'wrong-s2', source: 'semantic-scholar', title: 'Quantum Error Correction Codes' });
    for (const records of [[real, wrong], [wrong, real]]) {
      expect(mergePapers(records)).toHaveLength(2);
    }
  });
  it.each([['openReviewId', 'AbC-123'], ['aclId', 'P19-1010']] as const)('merges case variants of %s', (key, id) => {
    expect(mergePapers([paper({ arxivId: undefined, [key]: id }),
      paper({ arxivId: undefined, [key]: id.toLowerCase() })])).toHaveLength(1);
  });
  it('permits normalized title agreement at the inclusive 0.5 veto boundary', () => {
    expect(titleSimilarity('Quantum Graph!', 'quantum graph models networks')).toBe(0.5);
    expect(mergePapers([paper({ title: 'Quantum Graph!' }), paper({ title: 'quantum graph models networks' })])).toHaveLength(1);
  });
});

it.each(['Hamiltonian Generative Networks', 'Distinctive Graph Diffusion Models'])('resolves complete distinctive title: %s', title => {
  const reference = parsePartialReference(title);
  const candidates = [scorePaper(reference, paper({ title }))];
  expect(needsTitleDisambiguation(reference, candidates, false)).toBe(false);
  expect(classifyCandidates(candidates)).toBe('resolved');
});

describe('generic title metadata gates', () => {
  it.each(['year', 'author'] as const)('permits a lone threshold candidate with matching %s', metadata => {
    const reference = { ...parsePartialReference('Logical physical clocks'),
      ...(metadata === 'year' ? { year: 2023 } : { firstAuthor: 'Jiang' }) };
    const candidate = scorePaper(reference, paper({ title: reference.title! }));
    candidate.score = 0.92;
    expect(candidate.score_parts[metadata === 'year' ? 'year' : 'first_author']).toBe(1);
    expect(classifyCandidates([candidate])).toBe('resolved');
    expect(needsTitleDisambiguation(reference, [candidate], true)).toBe(false);
  });
  it.each([false, true])('retains caution with a competing candidate and matching author (incomplete: %s)', incomplete => {
    const reference = { ...parsePartialReference('Logical physical clocks'), firstAuthor: 'Jiang' };
    const candidates = [scorePaper(reference, paper({ title: reference.title! })),
      scorePaper(reference, paper({ title: 'Logical physical clocks models' }))];
    expect(needsTitleDisambiguation(reference, candidates, incomplete)).toBe(true);
  });
  it.each([false, true])('ignores an unrelated candidate with a matching author (incomplete: %s)', incomplete => {
    const reference = { ...parsePartialReference('Logical physical clocks'), firstAuthor: 'Jiang' };
    const candidates = [scorePaper(reference, paper({ title: reference.title! })),
      scorePaper(reference, paper({ title: 'Unrelated quantum optimization' }))];
    expect(classifyCandidates([candidates[1]])).toBe('unresolved');
    expect(needsTitleDisambiguation(reference, candidates, incomplete)).toBe(false);
  });
});
