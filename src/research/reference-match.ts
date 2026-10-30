// Parse partial citations and score distinct candidate identities without choosing close matches.
import { normalizeIdentity, normalizeTitle, parseArxivId, parseResearchIdentifier, type ResearchIdentifier } from './identity.js';
import type { ResearchPaper } from './types.js';

export interface PartialReference {
  input: string;
  identifier?: ResearchIdentifier;
  title?: string;
  year?: number;
  firstAuthor?: string;
}

export interface ScoredPaper {
  paper: ResearchPaper;
  score: number;
  score_parts: { title: number; year?: number; first_author?: number; identifier?: number };
}

export type ResolutionStatus = 'resolved' | 'ambiguous' | 'unresolved' | 'deferred';

/** Common quoted, APA-style and title-plus-year citations; retain the untouched input. */
export function parsePartialReference(input: string, year?: number): PartialReference {
  const identifier = parseResearchIdentifier(input);
  let rest = identifier ? input.replace(identifier.matched, '') : input;
  rest = rest.replace(/^\s*\[\d+\]\s*/, '').trim();
  const quoted = rest.match(/["“]([^"”]+)["”]/);
  const apa = rest.match(/^(.+?)\s*\(((?:18|19|20|21)\d{2})\)\.?\s+(.+)$/);
  const authorYear = rest.match(/^(.+?(?:et al\.|,\s*[A-Z]\.))\s*((?:18|19|20|21)\d{2})\.?\s+(.+)$/);
  const bibliography = apa ?? authorYear;
  // A number inside a title is not publication metadata; require citation cues.
  const date = (quoted ? rest.replace(quoted[0], '') : rest).match(/\(((?:18|19|20|21)\d{2})\)/);
  const inferredYear = bibliography?.[2] ?? date?.[1];
  const firstAuthor = bibliography?.[1].split(/,|\s+et al\.|\s+and\s+|\s+&\s+/)[0].trim();
  if (quoted) rest = quoted[1];
  else if (bibliography) rest = bibliography[3].split(/\.\s+/)[0];
  else if (date) rest = rest.replace(date[0], '');
  rest = rest.replace(/^[\s.,;:()[\]{}"']+|[\s.,;:()[\]{}"']+$/g, '').trim();
  return { input, identifier, title: normalizeTitle(rest) ? rest : undefined, year: year ?? (inferredYear ? Number(inferredYear) : undefined), firstAuthor };
}

/** Token coverage discounted by sequence order; ordered prefixes retain coverage scores. */
export function titleSimilarity(left: string, right: string): number {
  if (normalizeTitle(left) && normalizeTitle(left) === normalizeTitle(right)) return 1;
  const a = normalizeTitle(left).split(' ').filter(Boolean);
  const b = normalizeTitle(right).split(' ').filter(Boolean);
  if (!a.length || !b.length) return 0;
  const uniqueA = new Set(a), uniqueB = new Set(b);
  const coverage = [...uniqueA].filter(token => uniqueB.has(token)).length / new Set([...a, ...b]).size;
  const row = Array<number>(b.length + 1).fill(0);
  for (const token of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const previous = row[j];
      row[j] = token === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = previous;
    }
  }
  // Repeated tokens must also reduce similarity even when their token sets agree.
  const repetition = Math.min(uniqueA.size / a.length, uniqueB.size / b.length);
  return coverage * row[b.length] / Math.min(a.length, b.length) * repetition;
}

/** Caution needs competing candidates or an unqualified generic topic, never length alone with metadata. */
export function needsTitleDisambiguation(reference: PartialReference, candidates: ScoredPaper[], incomplete: boolean): boolean {
  if (!reference.title || !candidates.length || candidates[0]?.score_parts.identifier === 1) return false;
  const unqualified = reference.year === undefined && !reference.firstAuthor;
  const competing = candidates.slice(1).some(candidate => classifyCandidates([candidate]) !== 'unresolved');
  if (!competing && !unqualified) return false;
  const title = normalizeTitle(reference.title);
  const tokens = title.split(' ');
  const informative = tokens.filter(token => !/^(?:a|an|the|of|for|in|on|and|with|to|is|all|you)$/.test(token));
  const exact = candidates.filter(candidate => normalizeTitle(candidate.paper.title) === title).length;
  // Overview headings and common topic phrases remain generic even after a complete search.
  // Single names/acronyms and distinctive technical phrases keep their complete-search behavior.
  const overview = /^(?:(?:a|an|the) )?(?:tutorial|theory)\b/.test(title);
  const commonTopic = informative.every(token => /^(?:deep|learning|scaling|laws|logical|physical|clocks)$/.test(token));
  const generic = tokens.length > 1 && (tokens.length <= 2 ||
    (informative.length <= 4 && (overview || commonTopic)));
  return (incomplete && (tokens.length <= 4 || informative.length <= 4 || exact > 1)) ||
    (generic && (unqualified || competing));
}

function surname(name: string): string {
  return normalizeTitle(name.includes(',') ? name.split(',')[0] : name.trim().split(/\s+/).at(-1) ?? '');
}

/** Title weight .9; supplied year and first author each add .05, then renormalize. */
export function scorePaper(reference: PartialReference, paper: ResearchPaper, verifiedId = false): ScoredPaper {
  const title = reference.title ? titleSimilarity(reference.title, paper.title) : (verifiedId ? 1 : 0);
  const parts: ScoredPaper['score_parts'] = { title };
  let sum = 0.9 * title;
  let weight = 0.9;
  if (reference.year !== undefined) {
    parts.year = paper.year === reference.year ? 1 : 0;
    sum += 0.05 * parts.year;
    weight += 0.05;
  }
  if (reference.firstAuthor) {
    parts.first_author = surname(reference.firstAuthor) === surname(paper.authors[0]?.name ?? '') ? 1 : 0;
    sum += 0.05 * parts.first_author;
    weight += 0.05;
  }
  if (verifiedId) parts.identifier = 1;
  return { paper, score: sum / weight, score_parts: parts };
}

/** Apply inclusive approved boundaries; epsilon only compensates floating-point subtraction. */
export function classifyCandidates(candidates: ScoredPaper[]): ResolutionStatus {
  const best = candidates[0]?.score ?? 0;
  if (best + 1e-12 < 0.6) return 'unresolved';
  const margin = best - (candidates[1]?.score ?? 0);
  return best + 1e-12 >= 0.92 && margin + 1e-12 >= 0.05 ? 'resolved' : 'ambiguous';
}

/** Shared IDs or corroborated preprint/publication metadata establish a work, never title alone. */
export function mergePapers(papers: ResearchPaper[]): ResearchPaper[] {
  const ids = ['arxivId', 'doi', 's2PaperId', 'openReviewId', 'aclId'] as const;
  const preprintDoi = (doi: string) => Boolean(parseArxivId(doi) || /^10\.2139\/ssrn\./i.test(doi));
  const published = (paper: ResearchPaper) => Boolean(paper.doi && !preprintDoi(paper.doi));
  const preprint = (paper: ResearchPaper) => !published(paper) && Boolean(paper.arxivId || (paper.doi && preprintDoi(paper.doi)));
  const sameWorkMetadata = (left: ResearchPaper, right: ResearchPaper) => {
    if (!((preprint(left) && published(right)) || (preprint(right) && published(left)))) return false;
    if (!Number.isInteger(left.year) || !Number.isInteger(right.year) || Math.abs(left.year - right.year) > 2) return false;
    if (!normalizeTitle(left.title) || normalizeTitle(left.title) !== normalizeTitle(right.title)) return false;
    const names = new Set(left.authors.map(author => normalizeTitle(author.name)).filter(Boolean));
    return right.authors.some(author => names.has(normalizeTitle(author.name)));
  };
  const linked = (left: ResearchPaper, right: ResearchPaper) => {
    const a = normalizeIdentity(left), b = normalizeIdentity(right);
    if (titleSimilarity(a.title ?? '', b.title ?? '') < 0.5) return false;
    if (published(left) && published(right) && a.doi !== b.doi) return false;
    const metadataMatch = sameWorkMetadata(left, right);
    const sharedDoi = [a.doi, ...(a.alternateDois ?? [])].some(doi => doi && [b.doi, ...(b.alternateDois ?? [])].includes(doi));
    if (ids.some(key => a[key] && b[key] && a[key] !== b[key] &&
      !(key === 'doi' && (metadataMatch || sharedDoi ||
        (a.arxivId && a.arxivId === b.arxivId && (parseArxivId(a.doi!) || parseArxivId(b.doi!))))))) return false;
    return metadataMatch || sharedDoi || ids.some(key => a[key] && a[key] === b[key]);
  };
  const combine = (left: ResearchPaper, right: ResearchPaper): ResearchPaper => {
    // A published CrossRef record owns proceedings metadata; other sources fill gaps.
    const preferRight = (published(right) && !published(left)) ||
      (published(right) && right.source === 'crossref' && left.source !== 'crossref');
    const [primary, alternate] = preferRight ? [right, left] : [left, right];
    const result = { ...primary };
    for (const [key, value] of Object.entries(alternate)) {
      if (value !== undefined && (!(result as unknown as Record<string, unknown>)[key] ||
          (Array.isArray(result[key as keyof ResearchPaper]) && (result[key as keyof ResearchPaper] as unknown[]).length === 0))) {
        (result as unknown as Record<string, unknown>)[key] = value;
      }
    }
    const alternateDois = [...new Set([primary.doi, alternate.doi,
      ...(primary.alternateDois ?? []), ...(alternate.alternateDois ?? [])])]
      .filter((doi): doi is string => Boolean(doi && doi !== result.doi));
    if (alternateDois.length) result.alternateDois = alternateDois;
    return result;
  };
  const merged: ResearchPaper[] = [];
  for (const paper of papers) {
    // Comparison keys are canonical; OpenReview/ACL spelling remains source metadata.
    const { title: _title, openReviewId: _review, aclId: _acl, ...identity } = normalizeIdentity(paper);
    let work = { ...paper, ...Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== undefined)) };
    // A late S2 bridge may join two components already encountered in source order.
    for (let i = 0; i < merged.length;) {
      if (!linked(work, merged[i])) { i++; continue; }
      work = combine(merged.splice(i, 1)[0], work);
      i = 0;
    }
    merged.push(work);
  }
  return merged;
}
