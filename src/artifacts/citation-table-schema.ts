/**
 * Registered column aliases for citation-sidecar edge extraction.
 *
 * Based on the research-papers corpus table contract
 * (scripts/corpus/citation-sidecar.schema.json, schemaVersion 1). A unique
 * resolution header identifies the target cell in Incoming/Outgoing tables.
 * Without one, a whole-cell REF ID can resolve a row.
 * Other columns supply metadata or explicit qualifiers that disavow citations;
 * they do not need to follow an enumerated table shape.
 */

export const CITATION_HEADER_ALIASES: Record<string, readonly string[]> = {
  ordinal: ['#', 'bibliography #', 'label', 'row', 'original label', '# (arxiv)'],
  title: [
    'title', 'citing work', 'cited work', 'citation', 'citation (extracted)', 'title / source',
    'title / work', 'title / source bibliographic entry', 'citation as printed (normalized whitespace)',
    'citation as printed or faithfully transcribed', 'cited source / concept',
    'mentioned work / cluster', 'work cited / discussed', 'source', 'artifact', 'title / referent',
    'work / cluster', 'source-reported reference', 'title / source label', 'title / target', 'entry',
    'reference', 'reference (as printed, cvpr 2026 camera-ready)', 'reference (as printed, arxiv v2)',
  ],
  authors: [
    'authors', 'authors / publisher', 'organization', 'party', 'authors / project', 'author(s)',
    'authors / attributed entity', 'authors (as printed)', 'author or owner', 'authors / org',
  ],
  year: ['year'],
  locator: [
    'doi/url', 'doi / url', 'url', 'identifier', 'venue / doi / url', 'doi/url/venue', 'venue / url',
    'doi/url or venue', 'venue / id', 'venue / identifier', 'identifier / url', 'venue / doi',
  ],
  ref: [
    'inducted ref', 'corpus node', 'corpus ref', 'in-corpus ref', 'ref', 'citing ref', 'ref / issue',
    'in-corpus ref / issue', 'corpus id',
  ],
  context: ['context', 'where it appears'],
  notes: ['notes', 'note', 'rationale', 'why the guarded matcher missed it'],
  evidence: [
    'source evidence', 'in-text evidence', 'provenance', 'evidence', 'basis', 'verification',
    'confirmed by',
  ],
  'their-row': ['their row', '[ref]', 'row in its sidecar'],
  venue: ['venue'],
  kind: ['kind', 'type', 'nature'],
  relationship: ['relationship', 'relation', 'relationship (conceptual, not citation-grounded)'],
  status: ['mapping status', 'status', 'mapping'],
};
