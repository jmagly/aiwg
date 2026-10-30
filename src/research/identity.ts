// Shared identifier and title normalization for research discovery and corpus deduplication.
export type IdentifierKind = 'arxiv' | 'doi' | 'openreview' | 'acl' | 's2';

export interface ResearchIdentifier {
  kind: IdentifierKind;
  id: string;
  version?: number;
  /** Exact input span, so bibliography parsing can retain the supplied title. */
  matched: string;
}

export interface ResearchIdentity {
  arxivId?: string;
  arxivVersion?: number;
  doi?: string;
  alternateDois?: string[];
  s2PaperId?: string;
  openReviewId?: string;
  aclId?: string;
  title?: string;
}

const ARXIV = '(?:\\d{4}\\.\\d{4,5}|[a-z][a-z.-]*(?:\\.[A-Z]{2})?/\\d{7})(?:v\\d+)?';

/** Parse abs/pdf/html URLs, arXiv DOIs, new/old IDs and an optional version. */
export function parseArxivId(input: string): { id: string; version?: number } | undefined {
  const text = input.trim().replace(/\.pdf(?:[?#].*)?$/i, '').replace(/[?#].*$/, '');
  const match = text.match(new RegExp(`^(?:(?:https?://(?:export\\.)?arxiv\\.org/(?:abs|pdf|html)/)|(?:https?://(?:dx\\.)?doi\\.org/)?10\\.48550/arxiv\\.|arxiv:\\s*)?(${ARXIV})$`, 'i'));
  if (!match) return undefined;
  const version = match[1].match(/v(\d+)$/i);
  return { id: match[1].replace(/v\d+$/i, '').toLowerCase(), ...(version ? { version: Number(version[1]) } : {}) };
}

/** Canonical DOI spelling, including DOI URLs; trailing citation punctuation is ignored. */
export function normalizeDoi(input: string): string | undefined {
  let text = input.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
  try { text = decodeURIComponent(text); } catch { /* Keep a literal DOI on malformed escapes. */ }
  text = text.replace(/[.,;]+$/, '');
  while (text.endsWith(')') && (text.match(/\)/g)?.length ?? 0) > (text.match(/\(/g)?.length ?? 0)) text = text.slice(0, -1);
  return /^10\.\d{4,9}\/\S+$/i.test(text) ? text.toLowerCase() : undefined;
}

/** Parse a recognized identifier even when embedded in a bibliography line. */
export function parseResearchIdentifier(input: string): ResearchIdentifier | undefined {
  const arxiv = input.match(new RegExp(`(?:https?://(?:export\\.)?arxiv\\.org/(?:abs|pdf|html)/|(?:https?://(?:dx\\.)?doi\\.org/)?10\\.48550/arxiv\\.|arxiv:\\s*)${ARXIV}(?:\\.pdf)?(?:[?#][^\\s<>]*)?|(?<![\\w./])${ARXIV}(?![\\w.])`, 'i'));
  if (arxiv) {
    const parsed = parseArxivId(arxiv[0]);
    if (parsed) return { kind: 'arxiv', ...parsed, matched: arxiv[0] };
  }
  const doi = input.match(/(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.\d{4,9}\/[^\s<>"\]]+/i);
  if (doi) {
    const id = normalizeDoi(doi[0]);
    if (id) return { kind: 'doi', id, matched: doi[0] };
  }
  const review = input.match(/https?:\/\/(?:www\.)?openreview\.net\/(?:forum|pdf)\?[^\s<>]*/i);
  if (review) {
    const id = new URL(review[0]).searchParams.get('id');
    if (id) return { kind: 'openreview', id, matched: review[0] };
  }
  const reviewId = input.match(/\bopenreview:\s*([\w-]+)/i);
  if (reviewId) return { kind: 'openreview', id: reviewId[1], matched: reviewId[0] };
  const acl = input.match(/https?:\/\/(?:www\.)?aclanthology\.org\/([\w.-]+)\/?(?:[?#][^\s<>]*)?|\bacl:\s*([\w.-]+)|\b((?:\d{4}\.[a-z][\w-]*\.\d+|[A-Z]\d{2}-\d{4}))\b/i);
  if (acl) return { kind: 'acl', id: (acl[1] ?? acl[2] ?? acl[3]).replace(/\.pdf$/i, ''), matched: acl[0] };
  const s2 = input.match(/https?:\/\/(?:www\.)?semanticscholar\.org\/paper\/(?:[^\s/]+\/)?([a-f\d]{40})\b|\b(?:s2|semanticscholar):\s*([a-f\d]{40})\b|\b(CorpusId:\d+)\b/i);
  if (s2) return { kind: 's2', id: (s2[1] ?? s2[2] ?? s2[3]).toLowerCase().replace(/^corpusid:/, 'CorpusId:'), matched: s2[0] };
  return undefined;
}

/** Remove LaTeX formatting while retaining its text, then normalize Unicode and punctuation. */
export function normalizeTitle(input: string): string {
  return input.normalize('NFKC')
    .replace(/\\(?:begin|end)\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z]+\*?/g, '')
    .replace(/\\([^a-zA-Z])/g, '$1')
    .toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Accept both corpus frontmatter spellings and canonical client metadata. */
export function normalizeIdentity(value: ResearchIdentity | Record<string, unknown>): ResearchIdentity {
  const fields = value as Record<string, unknown>;
  const str = (...keys: string[]): string | undefined => keys.map(k => fields[k])
    .map(v => typeof v === 'number' && Number.isFinite(v) ? String(v) : v)
    .find(v => typeof v === 'string' && v.trim()) as string | undefined;
  const arxiv = parseArxivId(str('arxivId', 'arxiv_id', 'arxiv') ?? '') ?? parseArxivId(str('doi') ?? '');
  const alternateDois = Array.isArray(fields.alternateDois)
    ? [...new Set(fields.alternateDois.flatMap(value => typeof value === 'string' ? normalizeDoi(value) ?? [] : []))] : [];
  return {
    ...(arxiv ? { arxivId: arxiv.id, arxivVersion: arxiv.version ?? (typeof fields.arxivVersion === 'number' ? fields.arxivVersion : undefined) } : {}),
    doi: normalizeDoi(str('doi', 'DOI') ?? ''),
    ...(alternateDois.length ? { alternateDois } : {}),
    s2PaperId: str('s2PaperId', 's2_paper_id', 'paperId')?.toLowerCase(),
    openReviewId: str('openReviewId', 'openreview_id')?.toLowerCase(),
    aclId: str('aclId', 'acl_id')?.toLowerCase(),
    title: str('title') ? normalizeTitle(str('title')!) : undefined,
  };
}

/** Stable keys for matching any identifier or a normalized title across corpus sources. */
export function identityKeys(value: ResearchIdentity | Record<string, unknown>): string[] {
  const identity = normalizeIdentity(value);
  return [...new Set([
    ...(['arxivId', 'doi', 's2PaperId', 'openReviewId', 'aclId', 'title'] as const)
      .flatMap(key => identity[key] ? [`${key}:${identity[key]}`] : []),
    ...(identity.alternateDois ?? []).map(doi => `doi:${doi}`),
  ])];
}

/** REF spelling is case-sensitive, including the optional legacy suffix letter. */
export const REF_ID_SOURCE = 'REF-\\d+[a-zA-Z]?';
/** Match whole tokens in prose and paths without accepting a malformed ID prefix. */
export const REF_ID_PATTERN = `(?<![A-Za-z0-9_])${REF_ID_SOURCE}(?![A-Za-z0-9_])`;
const REF_ID_FULL = new RegExp(`^${REF_ID_SOURCE}$`);

export function refIdsInText(text: string): string[] {
  return text.match(new RegExp(REF_ID_PATTERN, 'g')) ?? [];
}

/** Exact lexical REF identity: preserve zero padding and suffix case. */
export function isRefId(value: string): boolean {
  return value.trim() === value && REF_ID_FULL.test(value);
}

/** Read the REF token before a slug or extension; never normalize its spelling. */
export function refIdFromFilename(filename: string, extension = '.md'): string | null {
  if (!filename.endsWith(extension)) return null;
  const stem = filename.slice(0, -extension.length);
  const slug = stem.indexOf('-', 4);
  const ref = slug === -1 ? stem : stem.slice(0, slug);
  return isRefId(ref) ? ref : null;
}

/** Sort key for REF ids: [numeric, alpha-suffix]. Mirrors build.py ref_sort_key. */
export function refSortKey(refId: string): [number, string] {
  const m = isRefId(refId) ? refId.match(/^REF-(\d+)([a-zA-Z]?)$/) : null;
  return m ? [parseInt(m[1], 10), m[2]] : [999999, refId];
}

/** Compare two REF ids by (numeric, suffix). */
export function compareRefId(a: string, b: string): number {
  const [an, as_] = refSortKey(a);
  const [bn, bs] = refSortKey(b);
  return an !== bn ? an - bn : as_ < bs ? -1 : as_ > bs ? 1 : 0;
}
