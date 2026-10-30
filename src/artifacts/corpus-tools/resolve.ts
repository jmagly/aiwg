// Resolve partial paper references through audited client attempts and conservative scoring.
import { ArxivClient } from '../../research/clients/arxiv.js';
import { CrossRefClient } from '../../research/clients/crossref.js';
import { SemanticScholarClient } from '../../research/clients/semantic-scholar.js';
import { identityKeys, normalizeIdentity, normalizeTitle, type ResearchIdentifier } from '../../research/identity.js';
import { classifyCandidates, mergePapers, needsTitleDisambiguation, parsePartialReference, scorePaper, type PartialReference, type ScoredPaper, type ResolutionStatus } from '../../research/reference-match.js';
import { ResearchError, ResearchErrorCode, type ResearchPaper } from '../../research/types.js';
import { findInCorpus, type CorpusIdentityMatch } from './resolve-corpus.js';

export interface ResolutionPath {
  source: ResearchPaper['source'];
  method: string;
  query: string;
  status: 'returned' | 'empty' | 'error';
  returned: ResearchPaper[];
  error?: string;
  /** Only transient source failures leave the lookup incomplete. */
  retryable?: boolean;
}

export type ResolutionFinding = {
  type: 'title_mismatch' | 'identifier_mismatch';
  supplied: string;
  returned: string;
  candidate: string;
} | {
  type: 'title_ambiguous';
  supplied: string;
  returned: string;
} | {
  type: 'identifier_unresolved';
  supplied: string;
  returned: string;
  paths: ResolutionPath[];
};

export interface ResolutionResult {
  input: string;
  reference: PartialReference;
  status: ResolutionStatus;
  incomplete: boolean;
  candidates: ScoredPaper[];
  paper?: ResearchPaper;
  findings: ResolutionFinding[];
  paths_tried: ResolutionPath[];
  already_in_corpus: boolean;
  corpus_matches: CorpusIdentityMatch[];
}

export interface ResolverClients {
  arxiv: ArxivClient;
  s2: SemanticScholarClient;
  crossref: CrossRefClient;
}

export function createResolverClients(): ResolverClients {
  return { arxiv: new ArxivClient(), s2: new SemanticScholarClient(), crossref: new CrossRefClient() };
}

function canonicalPaper(paper: ResearchPaper): ResearchPaper {
  const identity = normalizeIdentity(paper);
  const validYear = (value: number) => Number.isInteger(value) && value >= 1000 && value <= 2199;
  const year = validYear(paper.year) ? paper.year : Number(paper.publicationDate?.slice(0, 4));
  if (!validYear(year)) throw new ResearchError(ResearchErrorCode.RF_301, 'Response lacks a valid publication year');
  // Keep source spelling in results; normalizeIdentity supplies case-insensitive keys.
  return { ...paper, year, ...Object.fromEntries(Object.entries(identity)
    .filter(([key, value]) => !['title', 'openReviewId', 'aclId'].includes(key) && value !== undefined)) };
}

function s2Identifier(identifier: ResearchIdentifier): string {
  switch (identifier.kind) {
    case 'arxiv': return `ARXIV:${identifier.id}`;
    case 'doi': return `DOI:${identifier.id}`;
    case 'acl': return `ACL:${identifier.id}`;
    case 'openreview': return `URL:https://openreview.net/forum?id=${identifier.id}`;
    case 's2': return identifier.id;
  }
}

export async function resolveReference(input: string, root: string, year?: number, clients = createResolverClients()): Promise<ResolutionResult> {
  const reference = parsePartialReference(input, year);
  const paths: ResolutionPath[] = [];
  const findings: ResolutionFinding[] = [];
  const papers: ResearchPaper[] = [];
  const verified = new Set<string>();
  const identifier = reference.identifier;

  async function attempt(source: ResolutionPath['source'], method: string, query: string, run: () => Promise<ResearchPaper[]>, byId = false): Promise<void> {
    try {
      const returned = (await run()).slice(0, 5).flatMap(paper => {
        try { return [canonicalPaper(paper)]; }
        catch (error) {
          // Missing years are record quality, not a failed request; retain valid siblings.
          if (error instanceof ResearchError && error.code === ResearchErrorCode.RF_301) return [];
          throw error;
        }
      });
      if (returned.some(paper => !paper.id || !normalizeTitle(paper.title))) {
        throw new ResearchError(ResearchErrorCode.RF_301, 'Response lacks a paper identity or title');
      }
      paths.push({ source, method, query, status: returned.length ? 'returned' : 'empty', returned });
      for (const paper of returned) {
        if (byId && identifier) {
          const key = { arxiv: 'arxivId', doi: 'doi', acl: 'aclId', openreview: 'openReviewId', s2: 's2PaperId' }[identifier.kind] as keyof ResearchPaper;
          const actual = paper[key];
          if (actual && identifier.kind !== 's2' && String(actual).toLowerCase() !== identifier.id.toLowerCase()) {
            findings.push({ type: 'identifier_mismatch', supplied: identifier.id, returned: String(actual), candidate: paper.id });
            continue;
          }
          if (identifier.kind === 's2' && !identifier.id.startsWith('CorpusId:') && paper.s2PaperId?.toLowerCase() !== identifier.id.toLowerCase()) {
            findings.push({ type: 'identifier_mismatch', supplied: identifier.id, returned: paper.s2PaperId ?? paper.id, candidate: paper.id });
            continue;
          }
          // A direct lookup establishes the requested ID when the API omits that externalId.
          if (identifier.kind !== 's2') Object.assign(paper, { [key]: identifier.id });
          for (const key of identityKeys(paper).filter(key => !key.startsWith('title:'))) verified.add(key);
        }
        papers.push(paper);
      }
    } catch (error) {
      const missing = error instanceof ResearchError && error.code === ResearchErrorCode.RF_300;
      const retryable = error instanceof ResearchError && [
        ResearchErrorCode.RF_103, ResearchErrorCode.RF_104, ResearchErrorCode.RF_200,
        ResearchErrorCode.RF_201, ResearchErrorCode.RF_202, ResearchErrorCode.RF_500,
        ResearchErrorCode.RF_501, ResearchErrorCode.RF_502,
      ].includes(error.code);
      paths.push({ source, method, query, status: missing ? 'empty' : 'error', returned: [],
        ...(missing ? {} : { error: error instanceof Error ? error.message : String(error), retryable }) });
    }
  }

  if (identifier) {
    if (identifier.kind === 'arxiv') {
      await attempt('arxiv', 'id', identifier.id, async () => [await clients.arxiv.getPaperById(identifier.id)], true);
    } else if (identifier.kind === 'doi') {
      await attempt('crossref', 'id', identifier.id, async () => [await clients.crossref.getPaperByDoi(identifier.id)], true);
    }
    const id = s2Identifier(identifier);
    await attempt('semantic-scholar', 'id', id, async () => [await clients.s2.getPaperById(id)], true);
  }

  const identifierUnresolved = Boolean(identifier && verified.size === 0);
  if (identifierUnresolved && identifier) {
    const idPaths = paths.filter(path => path.method === 'id');
    findings.push({ type: 'identifier_unresolved', supplied: identifier.id, paths: idPaths,
      returned: idPaths.map(path => {
        const detail = path.error ?? path.returned.map(paper => JSON.stringify({ ...normalizeIdentity(paper),
          openReviewId: paper.openReviewId, aclId: paper.aclId })).join(', ');
        const outcome = path.returned.length ? 'returned (identifier mismatch)' : path.status;
        return `${path.source}/${path.method} (${path.query}): ${outcome}${detail ? `: ${detail}` : ''}`;
      }).join('; ') });
  }

  if (reference.title && (!identifier || papers.length === 0)) {
    await attempt('semantic-scholar', 'title-match', reference.title, () => clients.s2.matchTitle(reference.title!));
    const query = `ti:"${normalizeTitle(reference.title)}"`;
    await attempt('arxiv', 'title', query, async () => (await clients.arxiv.search(query, { limit: 5 })).papers);
    await attempt('crossref', 'bibliographic', input, async () => (await clients.crossref.searchBibliographic(input, { limit: 5 })).papers);
  }

  const candidates = mergePapers(papers).map(paper => scorePaper(reference, paper, identityKeys(paper).some(key => verified.has(key))))
    .sort((a, b) => b.score - a.score || a.paper.id.localeCompare(b.paper.id)).slice(0, 5);
  for (const candidate of candidates.slice(0, 1)) {
    if (reference.title && normalizeTitle(reference.title) !== normalizeTitle(candidate.paper.title)) {
      findings.push({ type: 'title_mismatch', supplied: reference.title, returned: candidate.paper.title, candidate: candidate.paper.id });
    }
  }
  const classified = classifyCandidates(candidates);
  const incomplete = paths.some(path => path.retryable);
  const titleAmbiguous = needsTitleDisambiguation(reference, candidates, incomplete);
  const status = classified === 'unresolved' && incomplete ? 'deferred'
    : classified === 'resolved' && (identifierUnresolved || titleAmbiguous) ? 'ambiguous' : classified;
  if (titleAmbiguous && classified !== 'unresolved') findings.push({ type: 'title_ambiguous',
    supplied: reference.title!, returned: reference.year === undefined
      ? 'Supply a year, author, or verified identifier to disambiguate this title'
      : 'Supply an author or verified identifier to disambiguate this title' });
  const paper = status === 'resolved' ? candidates[0].paper : undefined;
  const corpusMatches = paper ? findInCorpus(root, paper) : [];
  return { input, reference, status, incomplete, candidates,
    ...(paper ? { paper } : {}), findings, paths_tried: paths, already_in_corpus: corpusMatches.length > 0, corpus_matches: corpusMatches };
}
