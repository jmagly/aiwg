// Shared identity normalization contract for corpus resolve and expand (#3736/#3735).
import { describe, expect, it } from 'vitest';
import { identityKeys, normalizeDoi, normalizeIdentity, normalizeTitle, parseArxivId, parseResearchIdentifier } from '../../../src/research/identity.js';
import { parsePartialReference } from '../../../src/research/reference-match.js';

describe('research identities', () => {
  it.each([
    { openReviewId: 'AbC-123', aclId: 'P19-1010' },
    { openreview_id: 'AbC-123', acl_id: 'P19-1010' },
  ])('case-normalizes OpenReview and ACL identity spellings: %j', fields => {
    expect(normalizeIdentity(fields)).toMatchObject({ openReviewId: 'abc-123', aclId: 'p19-1010' });
    expect(identityKeys(fields)).toEqual(['openReviewId:abc-123', 'aclId:p19-1010']);
  });
  it.each([
    ['2401.12345v2', '2401.12345', 2], ['0704.0001', '0704.0001', undefined],
    ['hep-th/9901001v3', 'hep-th/9901001', 3], ['math.GT/0309136', 'math.gt/0309136', undefined],
    ['https://arxiv.org/abs/2401.12345v2', '2401.12345', 2],
    ['https://arxiv.org/pdf/0704.0001v2.pdf', '0704.0001', 2],
    ['https://arxiv.org/html/hep-th/9901001v3', 'hep-th/9901001', 3],
    ['https://arxiv.org/pdf/2401.12345v2.pdf?download=1', '2401.12345', 2],
    ['10.48550/arXiv.2401.12345v2', '2401.12345', 2],
    ['https://doi.org/10.48550/arXiv.hep-th/9901001v2', 'hep-th/9901001', 2],
  ])('parses %s', (input, id, version) => {
    expect(parseArxivId(input as string)).toEqual({ id, ...(version ? { version } : {}) });
    expect(parseResearchIdentifier(input as string)).toMatchObject({ kind: 'arxiv', id });
  });

  it('rejects partial arXiv IDs and unrelated text', () => {
    for (const input of ['2401.123', '2401.123456', 'A title', '2401.12345extra']) expect(parseArxivId(input)).toBeUndefined();
  });

  it.each(['a'.repeat(40), `Example, A. (2024). A bibliography title. ${'a'.repeat(40)}`])('does not claim bare hex as an S2 identifier: %s', input => {
    expect(parseResearchIdentifier(input)).toBeUndefined();
  });

  it.each(['ImageNet 2021 challenge', '2001 A Space Odyssey', 'Comparing 2020 and 2021 results'])('preserves title numbers without year cues: %s', input => {
    expect(parsePartialReference(input)).toMatchObject({ title: input, year: undefined });
    expect(parsePartialReference(input, 2024)).toMatchObject({ title: input, year: 2024 });
  });

  it('uses bibliographic year cues and keeps the explicit year authoritative', () => {
    expect(parsePartialReference('Example et al. 2024. ImageNet 2021 challenge')).toMatchObject({ title: 'ImageNet 2021 challenge', year: 2024, firstAuthor: 'Example' });
    expect(parsePartialReference('"ImageNet 2021 challenge" (2024)', 2025)).toMatchObject({ title: 'ImageNet 2021 challenge', year: 2025 });
  });

  it('normalizes DOI URLs without losing balanced suffix parentheses', () => {
    expect(normalizeDoi('https://doi.org/10.1234/ABC(1).')).toBe('10.1234/abc(1)');
    expect(normalizeDoi('doi:10.1234/ABC).')).toBe('10.1234/abc');
  });

  it('retains canonical alternate DOI keys for preprint identities', () => {
    const identity = { doi: '10.1234/JOURNAL', alternateDois: ['https://doi.org/10.2139/SSRN.1568864', 'invalid', '10.2139/ssrn.1568864'] };
    expect(normalizeIdentity(identity)).toMatchObject({ doi: '10.1234/journal', alternateDois: ['10.2139/ssrn.1568864'] });
    expect(identityKeys(identity)).toEqual(['doi:10.1234/journal', 'doi:10.2139/ssrn.1568864']);
  });

  it('normalizes Unicode, punctuation and LaTeX formatting consistently', () => {
    expect(normalizeTitle('｛ＡＩ｝ \\textbf{Self}-Supervised $x^2$')).toBe('ai self supervised x 2');
  });

  it('exports stable keys for both arxiv frontmatter spellings and DOI/title deduplication', () => {
    const keys = ['arxivId:hep-th/9901001', 'doi:10.1234/abc', 'title:self supervised'];
    for (const spelling of ['arxiv', 'arxiv_id']) {
      expect(identityKeys({ [spelling]: 'https://arxiv.org/pdf/hep-th/9901001v2.pdf', doi: 'https://doi.org/10.1234/ABC', title: 'Self-Supervised' })).toEqual(keys);
      expect(identityKeys({ [spelling]: 2401.12345 })).toEqual(['arxivId:2401.12345']);
    }
  });

  it('extracts title, year and author from bibliography lines without overwriting input', () => {
    const input = 'Example, A. (2024). "Self-supervised representation learning". 10.1234/fixture';
    expect(parsePartialReference(input)).toMatchObject({ input, title: 'Self-supervised representation learning', firstAuthor: 'Example', year: 2024, identifier: { kind: 'doi', id: '10.1234/fixture' } });
    expect(parsePartialReference('Self-supervised representation learning (2024)')).toMatchObject({ title: 'Self-supervised representation learning', year: 2024 });
  });
});
