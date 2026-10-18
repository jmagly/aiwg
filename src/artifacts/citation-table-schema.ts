/**
 * Registered bibliographic table forms for citation-sidecar edge extraction.
 *
 * Mirrors the citation/compact forms of the research-papers corpus table
 * contract (scripts/corpus/citation-sidecar.schema.json, schemaVersion 1).
 * Relationship, hyperlink and documentation forms never declare citations.
 */

export const CITATION_HEADER_ALIASES: Record<string, readonly string[]> = {
  'ordinal': ['#', 'bibliography #', 'label', 'row', 'original label', '# (arxiv)'],
  'title': ['title', 'citing work', 'cited work', 'citation', 'citation (extracted)', 'title / source', 'title / work', 'title / source bibliographic entry', 'citation as printed (normalized whitespace)', 'citation as printed or faithfully transcribed', 'cited source / concept', 'mentioned work / cluster', 'work cited / discussed', 'source', 'artifact', 'title / referent', 'work / cluster', 'source-reported reference', 'title / source label', 'title / target', 'entry', 'reference', 'reference (as printed, cvpr 2026 camera-ready)', 'reference (as printed, arxiv v2)'],
  'authors': ['authors', 'authors / publisher', 'organization', 'party', 'authors / project', 'author(s)', 'authors / attributed entity', 'authors (as printed)', 'author or owner', 'authors / org'],
  'year': ['year'],
  'locator': ['doi/url', 'doi / url', 'url', 'identifier', 'venue / doi / url', 'doi/url/venue', 'venue / url', 'doi/url or venue', 'venue / id', 'venue / identifier', 'identifier / url', 'venue / doi'],
  'ref': ['inducted ref', 'corpus node', 'corpus ref', 'in-corpus ref', 'ref', 'citing ref', 'ref / issue', 'in-corpus ref / issue', 'corpus id'],
  'context': ['context', 'where it appears'],
  'notes': ['notes', 'note', 'rationale', 'why the guarded matcher missed it'],
  'evidence': ['source evidence', 'in-text evidence', 'provenance', 'evidence', 'basis', 'verification', 'confirmed by'],
  'their-row': ['their row', '[ref]', 'row in its sidecar'],
  'venue': ['venue'],
  'kind': ['kind', 'type', 'nature'],
};

export const CITATION_TABLE_FORMS: readonly (readonly string[])[] = [
  // bibliographic
  ['ordinal', 'title', 'authors', 'year', 'locator', 'ref'],
  // bibliographic-with-row
  ['ordinal', 'title', 'authors', 'year', 'locator', 'ref', 'their-row'],
  // bibliographic-row-before-ref
  ['ordinal', 'title', 'authors', 'year', 'locator', 'their-row', 'ref'],
  // bibliographic-with-evidence
  ['ordinal', 'title', 'authors', 'year', 'locator', 'ref', 'evidence'],
  // bibliographic-with-notes
  ['ordinal', 'title', 'authors', 'year', 'locator', 'ref', 'notes'],
  // bibliographic-no-locator
  ['ordinal', 'title', 'authors', 'year', 'ref'],
  // bibliographic-venue
  ['ordinal', 'title', 'authors', 'year', 'venue', 'ref'],
  // bibliographic-citing-row
  ['ordinal', 'title', 'authors', 'year', 'their-row', 'ref'],
  // bibliographic-context
  ['ordinal', 'title', 'authors', 'year', 'context', 'ref'],
  // compact-dated
  ['ordinal', 'title', 'year', 'ref'],
  // compact-numbered
  ['ordinal', 'title', 'ref'],
  // compact
  ['title', 'ref'],
  // compact-citing-row
  ['ordinal', 'title', 'their-row', 'ref'],
  // compact-with-row-notes
  ['ordinal', 'title', 'ref', 'their-row', 'notes'],
  // compact-ref-notes
  ['ordinal', 'title', 'ref', 'notes'],
  // compact-dated-identifier
  ['ordinal', 'title', 'year', 'locator', 'ref'],
  // compact-reference-notes
  ['ordinal', 'title', 'notes', 'ref'],
  // reference-verification
  ['ordinal', 'ref', 'evidence'],
  // citing-evidence
  ['ordinal', 'title', 'authors', 'year', 'evidence', 'ref'],
  // typed-artifacts
  ['ordinal', 'title', 'kind', 'year', 'locator', 'ref'],
  // compact-ref-evidence
  ['ordinal', 'title', 'ref', 'evidence'],
  // reference-notes
  ['ordinal', 'ref', 'notes'],
];
