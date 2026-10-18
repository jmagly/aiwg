/**
 * Artifact Query Engine
 *
 * Searches the artifact index by keyword, type, phase, tags, and path pattern.
 * Returns ranked results in human-readable or JSON format.
 *
 * @implements #416
 * @source @src/artifacts/types.ts
 * @tests @test/unit/artifacts/query-engine.test.ts
 */

import { minimatch } from 'minimatch';
import type { DiscoveryShadowRoute } from './discovery-shadow.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { QueryParams, QueryResult, MetadataEntry, GraphType, ArtifactIndex } from './types.js';
import {
  OPERATIONAL_DISCOVERY_TYPES,
  OPERATIONAL_SHOW_TYPES,
  isOperationalShowType,
  loadGlobalGraphConfigs,
} from './types.js';
import { loadMetadataIndex, loadGraphIndexFile } from './index-reader.js';
import { bm25Rank, type FullTextDoc } from './fulltext.js';
import { parseFrontmatter } from './index-builder.js';
import {
  applyFacetFusion,
  diagnoseFacetActivations,
  type FacetScoreDiagnostic,
} from './discover-facets.js';
import {
  recordTypeForEntry,
  stableRecordId,
  type AiwgFortemiRecord,
} from './browser-export.js';
import { loadProviderModelMetadata } from '../models/provider-models.js';
import { projectAiwgPath, projectControlPath } from '../config/project-artifacts.js';
import {
  operationalStateQueryProjection,
  type OperationalStateQueryProjection,
} from './operational-state.js';
import type {
  ResourceSource,
  VerifiedWebRelease,
  WebReleaseOptions,
} from '../resources/web-release.js';

function normalizeIndexedPath(entryPath: string): string {
  return entryPath.replace(/\\/g, '/');
}

/**
 * Resolve an index entry's source file path and read its body (frontmatter
 * stripped). Entry paths are normally relative to the project; framework-graph
 * entries may be absolute or anchored to $AIWG_ROOT. Returns null when the
 * file can't be read (stale index entry) so full-text ranking skips it.
 */
function readEntryBody(cwd: string, entryPath: string): string | null {
  const candidates: string[] = [];
  if (path.isAbsolute(entryPath)) candidates.push(entryPath);
  else {
    const normalizedPath = normalizeIndexedPath(entryPath);
    if (normalizedPath.startsWith('.aiwg/')) {
      candidates.push(projectAiwgPath(cwd, normalizedPath.slice('.aiwg/'.length)));
    }
    candidates.push(path.resolve(cwd, normalizedPath));
    if (process.env.AIWG_ROOT) candidates.push(path.resolve(process.env.AIWG_ROOT, normalizedPath));
  }
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      return parseFrontmatter(raw).body;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}


export interface QueryOptions {
  json?: boolean;
  graph?: GraphType;
  backend?: 'local' | 'fortemi-core';
}

const DEFAULT_ARTIFACT_SEARCH_BACKEND: 'fortemi-core' = 'fortemi-core';

const DISCOVER_TYPE_ORDER = new Map(
  [...OPERATIONAL_DISCOVERY_TYPES, 'hook', 'doc'].map((type, index) => [type, index]),
);

function canonicalLocalityRank(entryPath: string): number {
  const normalized = entryPath.replace(/\\/g, '/');
  if (normalized.startsWith('.aiwg/') || normalized.includes('/.aiwg/')) return 0;
  // Top-level persona mirrors are the least canonical source for a name a bundle
  // also owns. Without this they fell into the catch-all below and scored 1,
  // beating the bundle copy at 2 — the opposite of #1643. It only ever looked
  // correct because a populated user index supplied provenance and `scopeRank`
  // never reached this fallback (#2544).
  if (normalized.startsWith('agentic/code/agents/') || normalized.includes('/agentic/code/agents/')) return 4;
  if (normalized.includes('/plugins/') || normalized.startsWith('agentic/code/plugins/')) return 3;
  if (
    normalized.includes('/frameworks/') ||
    normalized.includes('/addons/') ||
    normalized.includes('/extensions/') ||
    normalized.startsWith('agentic/code/frameworks/') ||
    normalized.startsWith('agentic/code/addons/') ||
    normalized.startsWith('agentic/code/extensions/')
  ) {
    return 2;
  }
  return 1;
}

type ProvenancedEntry = MetadataEntry & {
  indexGraph?: string;
  indexScope?: 'project' | 'user' | 'packaged' | 'codebase' | 'custom';
};

function graphScope(graph: GraphType): ProvenancedEntry['indexScope'] {
  if (graph === 'project') return 'project';
  if (graph === 'user' || graph.startsWith('user-')) return 'user';
  if (graph === 'framework') return 'packaged';
  if (graph === 'codebase' || graph === 'source') return 'codebase';
  return 'custom';
}

function containsTokenSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function withIndexProvenance(entry: MetadataEntry, graph: GraphType): ProvenancedEntry {
  return { ...entry, indexGraph: graph, indexScope: graphScope(graph) };
}

/** Keep existing project capabilities visible while their derived cache is unavailable. */
function projectCapabilityFallback(cwd: string): MetadataEntry[] | null {
  const index = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', 'project');
  if (index) {
    const entries = Object.values(index.entries).map((entry) => withIndexProvenance(entry, 'project'));
    if (entries.length > 0) {
      // One diagnostic per command, on stderr so JSON and skill bodies stay parseable.
      console.error('Warning: project capability cache is unavailable or stale; using the local project index. Run `aiwg index sync` to repair the cache.');
      return entries;
    }
  }
  if (['extensions', 'addons', 'frameworks', 'plugins', 'skills'].some(
    (dir) => fs.existsSync(projectAiwgPath(cwd, dir)),
  )) {
    console.error('Warning: project capabilities could not be loaded: the cache is unavailable and the local project index is missing or empty. Run `aiwg index build --graph project` to repair discovery.');
  }
  return index ? [] : null;
}

function discoveryIdForEntry(entry: MetadataEntry): string {
  return stableRecordId(recordTypeForEntry(entry, 'v2'), entry.path);
}

function logicalDiscoverKey(entry: MetadataEntry): string {
  const identity = (entry.name ?? entry.title ?? path.basename(entry.path))
    .toLowerCase()
    .replace(/[-_\s]+/g, ' ')
    .trim();
  return `${entry.type}:${identity}`;
}

function dedupeDiscoverResults<T extends QueryResult>(results: T[]): T[] {
  const bestByIdentity = new Map<string, T>();
  for (const result of results) {
    const key = logicalDiscoverKey(result.entry);
    const existing = bestByIdentity.get(key);
    if (!existing || compareDiscoverResults(result, existing) < 0) {
      bestByIdentity.set(key, result);
    }
  }
  return Array.from(bestByIdentity.values()).sort(compareDiscoverResults);
}

function scopeRank(entry: MetadataEntry): number {
  const scope = (entry as ProvenancedEntry).indexScope;
  if (scope === 'project') return 0;
  if (scope === 'user') return 1;
  if (scope === 'custom') return 2;
  if (scope === 'packaged') return 3;
  if (scope === 'codebase') return 4;
  return canonicalLocalityRank(entry.path);
}

function compareText(left: string | undefined, right: string | undefined): number {
  return (left ?? '').localeCompare(right ?? '');
}

export function compareDiscoverResults(left: QueryResult, right: QueryResult): number {
  const scoreCmp = right.score - left.score;
  if (scoreCmp !== 0) return scoreCmp;

  const localityCmp = scopeRank(left.entry) - scopeRank(right.entry);
  if (localityCmp !== 0) return localityCmp;

  const typeCmp =
    (DISCOVER_TYPE_ORDER.get(left.entry.type) ?? 99) -
    (DISCOVER_TYPE_ORDER.get(right.entry.type) ?? 99);
  if (typeCmp !== 0) return typeCmp;

  const nameCmp = compareText(left.entry.name ?? left.entry.title, right.entry.name ?? right.entry.title);
  if (nameCmp !== 0) return nameCmp;

  return left.entry.path.localeCompare(right.entry.path);
}

/**
 * Stop-words to drop when tokenizing a discovery phrase. Keep short —
 * we want the user's verbs and nouns to dominate scoring.
 */
// Stopwords stripped from a discover QUERY before scoring (#1581). Two classes:
//   1. Grammatical filler (articles, prepositions, pronouns, question words,
//      asking verbs) — a natural-language intent like "Find an AIWG skill that
//      handles intake forms" carries the same meaning as "intake forms", but the
//      filler tokens inflate the token count: the strict overlap gate is
//      ceil(n/2), so a verbose query raises the bar above what the genuinely
//      relevant short-match artifact can clear, and the (hits/n) term dilutes
//      every score. Dropping filler collapses the query to its content tokens.
//   2. AIWG meta-type nouns ('aiwg', 'skill', 'agent', 'command', 'rule',
//      'flow', 'workflow') — in a discover query these carry zero discriminating
//      signal (every result IS an aiwg skill/agent/…; the TYPE is filtered via
//      --type). The content word after them is what matters
//      ("…skill that handles >intake forms<"). Keeping them surfaces incidental
//      junk matches (any artifact mentioning "skill"/"aiwg") above the real one.
// Only the query is tokenized here — entry fields are substring-matched — so this
// never changes what text an artifact exposes, only how the query is reduced.
const SCORE_STOPWORDS = new Set([
  // articles / conjunctions / prepositions / copula
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on',
  'with', 'into', 'from', 'is', 'are', 'be', 'i', 'we', 'my',
  // pronouns / determiners / fillers
  'it', 'you', 'me', 'us', 'your', 'our', 'this', 'that', 'these', 'those',
  'there', 'here', 'some', 'any', 'all', 'also', 'please', 'about', 'project',
  // question words
  'how', 'what', 'which', 'where', 'when', 'who', 'why',
  // asking / request verbs ("find a skill that handles …")
  'find', 'give', 'show', 'need', 'want', 'looking', 'look', 'help',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will',
  'handle', 'handles', 'handling',
  // AIWG meta-type nouns — zero discriminating signal in a discover query
  'aiwg', 'skill', 'skills', 'agent', 'agents', 'command', 'commands',
  'rule', 'rules', 'schema', 'schemas', 'flow', 'flows', 'workflow', 'workflows',
  'template', 'templates',
]);

/**
 * Tokenize a query phrase into lowercased keywords for multi-word
 * scoring. Splits on whitespace and punctuation; drops stopwords and
 * single-character tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !SCORE_STOPWORDS.has(t))
    .map(token => token.length > 4 && token.endsWith('s') && !token.endsWith('ss')
      ? token.slice(0, -1)
      : token);
}

function matchedFieldTokens(queryTokens: string[], field: string): string[] {
  const fieldTokens = new Set(tokenize(field));
  return queryTokens.filter(token => fieldTokens.has(token));
}

function fieldContainsQuery(field: string, queryTokens: string[]): boolean {
  return containsTokenSequence(tokenize(field), queryTokens);
}

/**
 * Score a metadata entry against a keyword query.
 *
 * Multi-word queries are tokenized; each token contributes its weighted
 * match across the entry's searchable fields. The full phrase still
 * earns bonus weight when it appears as a contiguous substring or as
 * an exact trigger phrase (the most reliable signal).
 *
 * For AIWG artifact kinds (skills/agents/commands/rules) the entry
 * carries `triggers` (declared activation phrases) and `capability`
 * (one-line description). These get the highest weights so capability
 * search via `aiwg index discover` ranks the right skill on top
 * instead of bottoming out on a path-substring match (#1214).
 */
/**
 * Normalize a string for exact-name comparison (#1233) — lowercase and
 * collapse `-` / `_` / whitespace runs so hyphenated kernel-skill names
 * like `aiwg-doctor` match queries with spaces ("aiwg doctor") and the
 * rendered title ("AIWG Doctor") matches the slug query.
 */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[-_\s]+/g, ' ').trim();
}

function damerauLevenshteinAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;

  if (a.length === b.length) {
    let firstDiff = -1;
    let diffCount = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        if (firstDiff < 0) firstDiff = i;
        diffCount++;
      }
    }
    if (diffCount === 1) return true;
    return diffCount === 2
      && firstDiff + 1 < a.length
      && a[firstDiff] === b[firstDiff + 1]
      && a[firstDiff + 1] === b[firstDiff];
  }

  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
    } else {
      edits++;
      if (edits > 1) return false;
      j++;
    }
  }
  return true;
}

function nearNameMatch(query: string, name: string): boolean {
  const queryParts = normalizeName(query).split(/\s+/).filter(Boolean);
  const nameParts = normalizeName(name).split(/\s+/).filter(Boolean);
  if (queryParts.length !== nameParts.length) return false;

  return queryParts.every((part, i) => {
    const target = nameParts[i];
    if (part === target) return true;
    if (part.length < 5 || target.length < 5) return false;
    return damerauLevenshteinAtMostOne(part, target);
  });
}

interface LexicalMatchDiagnostic {
  field: 'name' | 'trigger' | 'capability' | 'title' | 'tag' | 'search_terms' | 'kind' | 'source_type' | 'summary' | 'path' | 'type';
  match: 'exact' | 'near-name' | 'contained-phrase' | 'token-overlap';
  value?: string;
  contribution: number;
  matched_tokens?: string[];
  query_token_coverage?: number;
}

interface LexicalScoreDiagnostic {
  content_tokens: string[];
  raw_score: number;
  score: number;
  score_cap_applied: boolean;
  matches: LexicalMatchDiagnostic[];
}

interface DetailedScore {
  score: number;
  diagnostic: LexicalScoreDiagnostic;
}

function scoreEntryDetailed(
  entry: MetadataEntry,
  text: string,
  opts: { relaxOverlap?: boolean } = {},
): DetailedScore {
  const tokens = tokenize(text);
  // Field substring matching uses the stopword-stripped CONTENT phrase, not the
  // raw query (#1581). Without this, a query that reduces to a single content
  // token — e.g. "intake skill" or "find an intake skill" → ["intake"] — sets
  // useMultiToken=false (1 token) and then fails the full-string `.includes()`
  // checks because the raw phrase ("intake skill") isn't a substring of any
  // field, while the one meaningful token is never matched. Joining the content
  // tokens restores the invariant that a single content token IS the phrase, and
  // for multi-token queries gives a tighter (content-only) phrase to match.
  // Pure-stopword queries fall back to the raw text.
  const lower = tokens.length > 0 ? tokens.join(' ') : text.toLowerCase().trim();
  const rawLower = text.toLowerCase().trim();
  const personaIdentitySuppressed = diagnoseFacetActivations(text).some(
    (activation) =>
      activation.facet === 'persona-identity' && activation.status === 'suppressed',
  );
  let score = 0;
  const matches: LexicalMatchDiagnostic[] = [];
  const creditedTokens = new Set<string>();
  const finish = (uncappedScore = score, cap = 1): DetailedScore => ({
    score: Math.min(uncappedScore, cap),
    diagnostic: {
      content_tokens: tokens,
      raw_score: uncappedScore,
      score: Math.min(uncappedScore, cap),
      score_cap_applied: uncappedScore > cap,
      matches,
    },
  });
  const addMatch = (
    contribution: number,
    match: Omit<LexicalMatchDiagnostic, 'contribution'>,
  ): void => {
    score += contribution;
    matches.push({ ...match, contribution });
  };
  const addTokenMatch = (
    contributionPerToken: number,
    hits: string[],
    match: Omit<LexicalMatchDiagnostic, 'contribution' | 'matched_tokens' | 'query_token_coverage'>,
  ): void => {
    const newlyMatched = hits.filter(token => !creditedTokens.has(token));
    if (newlyMatched.length === 0) return;
    newlyMatched.forEach(token => creditedTokens.add(token));
    addMatch(contributionPerToken * newlyMatched.length, {
      ...match,
      matched_tokens: newlyMatched,
      query_token_coverage: tokens.length > 0 ? newlyMatched.length / tokens.length : 0,
    });
  };

  // Exact-name floor (#1233) — if the query (normalized) exactly matches
  // the entry's canonical name, this is the artifact the user is asking
  // for and it must surface at the top regardless of how cluttered the
  // rest of the corpus scoring gets. Hyphens, underscores, and whitespace
  // are interchangeable in the comparison so `aiwg-doctor`, `aiwg doctor`,
  // and `aiwg_doctor` all match a kernel skill with `name: aiwg-doctor`.
  //
  // Returns 1.001 (not 1.0) so an exact-name hit sorts above the many
  // capped-at-1.0 substring matches that share generic words like "use".
  // Display rounding (Math.round(score * 100) / 100) hides the offset, so
  // the user still sees `score: 1.0` while sort order is preserved.
  if (entry.name) {
    const queryNorm = normalizeName(text);
    const nameNorm = normalizeName(entry.name);
    if (queryNorm === nameNorm) {
      matches.push({
        field: 'name',
        match: 'exact',
        value: entry.name,
        contribution: 1.001,
        matched_tokens: tokens,
        query_token_coverage: 1,
      });
      return finish(1.001, 1.001);
    }
    if (nearNameMatch(text, entry.name)) {
      matches.push({
        field: 'name',
        match: 'near-name',
        value: entry.name,
        contribution: 0.951,
        matched_tokens: tokens,
        query_token_coverage: 1,
      });
      return finish(0.951);
    }
  }

  // Searchable text — joined once so per-token includes() is cheap
  const titleLower = entry.title.toLowerCase();
  const summaryLower = entry.summary.toLowerCase();
  const pathLower = entry.path.toLowerCase();
  const typeLower = entry.type.toLowerCase();
  const capabilityLower = entry.capability ? entry.capability.toLowerCase() : '';
  const tagsLower = entry.tags.map(t => t.toLowerCase());
  const triggersLower = (entry.triggers ?? []).map(trigger => trigger.toLowerCase());
  const searchTermsLower = (entry.searchTerms ?? []).join(' ').toLowerCase();
  const kindLower = entry.kind?.toLowerCase() ?? '';
  const sourceTypeLower = entry.sourceType?.toLowerCase() ?? '';

  // For multi-token queries, require ≥50% token overlap to count
  // partial matches. This keeps gibberish queries (e.g.,
  // `xyzzy_zzqwkjhg_42` after splitting on `_`) from surfacing
  // incidental single-token hits.
  const useMultiToken = tokens.length > 1;
  // #1561 — verbose natural-language queries (e.g. "skill that handles intake
  // forms") dilute the token hit ratio below the ceil(n/2) overlap gate and
  // dead-end to zero results. When the strict pass finds nothing, callers
  // re-score with `relaxOverlap` so a single meaningful token hit (intake /
  // forms) still surfaces ranked candidates instead of an empty set.
  const minHits = useMultiToken
    ? (opts.relaxOverlap ? 1 : Math.ceil(tokens.length / 2))
    : 1;
  const overlapOK = (hits: number): boolean => useMultiToken && hits >= minHits;

  // Trigger phrase match — highest weight (4x). Exact match on the full
  // phrase wins big; substring or token-overlap is still strong.
  if (triggersLower.length > 0) {
    for (const trigger of triggersLower) {
      const triggerTokens = tokenize(trigger);
      const matchedTokens = tokens.filter((token) => triggerTokens.includes(token));
      const queryCoverage = tokens.length > 0 ? matchedTokens.length / tokens.length : 0;
      if (trigger === lower || trigger === rawLower) {
        matches.push({
          field: 'trigger',
          match: 'exact',
          value: trigger,
          contribution: 1.0008,
          matched_tokens: matchedTokens,
          query_token_coverage: 1,
        });
        return finish(1.0008, 1.0008);
      } else if (
        containsTokenSequence(triggerTokens, tokens) ||
        containsTokenSequence(tokens, triggerTokens)
      ) {
        const triggerInsideQuery = containsTokenSequence(tokens, triggerTokens);
        const containedCoverage = triggerInsideQuery
          ? queryCoverage
          : triggerTokens.length > 0
            ? matchedTokens.length / triggerTokens.length
            : 0;
        // A complete multi-word trigger inside a noisier query is a strong
        // metadata signal. The ambiguous one-word `persona` trigger is
        // downweighted only when the facet classifier has identified buyer /
        // audience marketing context; distinctive one-word triggers such as
        // GRADE retain their established exact-trigger behavior (#1828).
        const suppressedGenericPersona =
          personaIdentitySuppressed &&
          triggerTokens.length === 1 &&
          triggerTokens[0] === 'persona' &&
          tokens.length > 1;
        const contribution = suppressedGenericPersona
          ? 0.24 * queryCoverage
          : triggerTokens.length > 1
            ? Math.min(1, 0.75 + 0.25 * containedCoverage)
            : 1;
        addMatch(contribution, {
          field: 'trigger',
          match: 'contained-phrase',
          value: trigger,
          matched_tokens: matchedTokens,
          query_token_coverage: queryCoverage,
        });
      } else if (useMultiToken) {
        const hits = matchedFieldTokens(tokens, trigger);
        if (overlapOK(hits.length)) {
          addTokenMatch(0.1 * 4, hits, {
            field: 'trigger',
            match: 'token-overlap',
            value: trigger,
          });
        }
      }
    }
  }

  // Capability description (2x weight) — full phrase first, then tokens
  if (capabilityLower) {
    if (fieldContainsQuery(capabilityLower, tokens)) {
      addMatch(0.2 * 2, {
        field: 'capability',
        match: 'contained-phrase',
        value: entry.capability,
      });
    } else if (useMultiToken) {
      const hits = matchedFieldTokens(tokens, capabilityLower);
      if (overlapOK(hits.length)) {
        addTokenMatch(0.1 * 2, hits, {
          field: 'capability',
          match: 'token-overlap',
          value: entry.capability,
        });
      }
    }
  }

  // Title (3x weight)
  if (fieldContainsQuery(titleLower, tokens)) {
    addMatch(0.3 * 3, {
      field: 'title',
      match: titleLower === lower ? 'exact' : 'contained-phrase',
      value: entry.title,
    });
    if (titleLower === lower) {
      addMatch(0.2, { field: 'title', match: 'exact', value: entry.title });
    }
  } else if (useMultiToken) {
    const hits = matchedFieldTokens(tokens, titleLower);
    if (overlapOK(hits.length)) {
      addTokenMatch(0.08 * 3, hits, {
        field: 'title',
        match: 'token-overlap',
        value: entry.title,
      });
    }
  }

  // Tags (2x weight)
  for (const tag of tagsLower) {
    if (fieldContainsQuery(tag, tokens)) {
      addMatch(0.2 * 2, { field: 'tag', match: 'contained-phrase', value: tag });
    } else if (useMultiToken) {
      const hits = matchedFieldTokens(tokens, tag);
      if (overlapOK(hits.length)) {
        addTokenMatch(0.05 * 2, hits, {
          field: 'tag',
          match: 'token-overlap',
          value: tag,
        });
      }
    }
  }

  // Structure-aware language terms (1.5x weight). These are deliberately
  // below declared triggers/capabilities but above generic body summaries.
  if (fieldContainsQuery(searchTermsLower, tokens)) {
    addMatch(0.18 * 1.5, { field: 'search_terms', match: 'contained-phrase' });
  } else if (useMultiToken) {
    const hits = matchedFieldTokens(tokens, searchTermsLower);
    if (overlapOK(hits.length)) {
      addTokenMatch(0.06 * 1.5, hits, {
        field: 'search_terms',
        match: 'token-overlap',
      });
    }
  }

  // Exact declarative kind and physical source classification are compact,
  // useful routing signals (e.g. FlowPlaybook vs OpsInventory; runbook that
  // originated under templates/).
  if (fieldContainsQuery(kindLower, tokens)) {
    addMatch(0.15, { field: 'kind', match: 'contained-phrase', value: entry.kind });
  }
  if (fieldContainsQuery(sourceTypeLower, tokens)) {
    addMatch(0.08, { field: 'source_type', match: 'contained-phrase', value: entry.sourceType });
  }

  // Summary (1x weight)
  if (fieldContainsQuery(summaryLower, tokens)) {
    addMatch(0.15, { field: 'summary', match: 'contained-phrase' });
  } else if (useMultiToken) {
    const hits = matchedFieldTokens(tokens, summaryLower);
    if (overlapOK(hits.length)) {
      addTokenMatch(0.04, hits, {
        field: 'summary',
        match: 'token-overlap',
      });
    }
  }

  // Path (0.5x weight)
  if (fieldContainsQuery(pathLower, tokens)) {
    addMatch(0.1, { field: 'path', match: 'contained-phrase', value: entry.path });
  } else if (useMultiToken) {
    const hits = matchedFieldTokens(tokens, pathLower);
    if (overlapOK(hits.length)) {
      addTokenMatch(0.03, hits, {
        field: 'path',
        match: 'token-overlap',
        value: entry.path,
      });
    }
  }

  // Type (0.5x weight)
  if (fieldContainsQuery(typeLower, tokens)) {
    addMatch(0.1, { field: 'type', match: 'contained-phrase', value: entry.type });
  }

  return finish();
}

function scoreEntry(entry: MetadataEntry, text: string, opts: { relaxOverlap?: boolean } = {}): number {
  return scoreEntryDetailed(entry, text, opts).score;
}

/**
 * Query the artifact index
 */
export async function queryIndex(
  cwd: string,
  params: QueryParams,
  options: QueryOptions = {}
): Promise<void> {
  const { graph } = options;
  const backend = options.backend ?? DEFAULT_ARTIFACT_SEARCH_BACKEND;
  const startTime = Date.now();

  let candidates: MetadataEntry[];

  if (backend === 'fortemi-core') {
    const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
    const loaded = loadFortemiCoreMetadataEntries(cwd, graph ?? 'project');
    if (loaded.reason) {
      if (options.json) {
        console.log(JSON.stringify({
          query: { text: params.text, backend: 'fortemi-core', graph: graph ?? 'project' },
          results: [],
          total: 0,
          hint: loaded.reason ?? 'Fortemi Core static index is unavailable.',
        }, null, 2));
      } else {
        console.error('Error: ' + (loaded.reason ?? 'Fortemi Core static index is unavailable.'));
      }
      process.exit(1);
    }
    candidates = loaded.entries;
  } else if (graph) {
    // Single graph mode
    const index = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', graph);
    if (!index) {
      console.error(`Error: No artifact index found for graph '${graph}'.`);
      console.log("Run 'aiwg index build' first to create the index.");
      process.exit(1);
    }
    candidates = Object.values(index.entries);
  } else {
    // No graph specified: search across all project-local graphs
    const graphTypes: GraphType[] = ['project', 'codebase'];
    const allEntries: MetadataEntry[] = [];
    for (const g of graphTypes) {
      const idx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', g);
      if (idx) allEntries.push(...Object.values(idx.entries));
    }

    // Fall back to legacy root index
    if (allEntries.length === 0) {
      const legacy = loadMetadataIndex(cwd);
      if (!legacy) {
        console.error('Error: No artifact index found.');
        console.log("Run 'aiwg index build' first to create the index.");
        process.exit(1);
      }
      allEntries.push(...Object.values(legacy.entries));
    }

    candidates = allEntries;
  }

  // Apply filters
  if (params.type) {
    candidates = candidates.filter(e => e.type === params.type);
  }
  if (params.phase) {
    candidates = candidates.filter(e => e.phase === params.phase);
  }
  if (params.tags && params.tags.length > 0) {
    candidates = candidates.filter(e =>
      params.tags!.every(tag => e.tags.includes(tag))
    );
  }
  if (params.path) {
    candidates = candidates.filter(e => minimatch(e.path, params.path!));
  }
  if (params.updatedAfter) {
    const cutoff = new Date(params.updatedAfter).getTime();
    candidates = candidates.filter(e => new Date(e.updated).getTime() >= cutoff);
  }

  // Score and rank
  let results: QueryResult[];
  const matchedById = new Map<string, string[]>();
  const operationalStateById = new Map<string, OperationalStateQueryProjection>();
  if (params.text && params.fulltext && backend === 'fortemi-core') {
    const { queryFortemiCoreStaticFulltextIndex } = await import('./fortemi-core-query-adapter.js');
    const queried = queryFortemiCoreStaticFulltextIndex(cwd, {
      graph: graph ?? 'project',
      text: params.text,
      limit: params.limit ?? 20,
      path: params.path,
      type: params.type,
      phase: params.phase,
      tags: params.tags,
    });
    if (queried.reason) {
      if (options.json) {
        console.log(JSON.stringify({
          query: { text: params.text, backend: 'fortemi-core', graph: graph ?? 'project' },
          mode: 'fulltext',
          results: [],
          total: 0,
          hint: queried.reason,
        }, null, 2));
      } else {
        console.error('Error: ' + queried.reason);
      }
      process.exit(1);
    }
    results = queried.results.map(result => {
      const entry: MetadataEntry = {
        path: result.path,
        type: result.type,
        phase: result.phase,
        title: result.title,
        tags: result.tags,
        created: '',
        updated: '',
        checksum: '',
        summary: result.summary,
        dependencies: [],
        dependents: [],
      };
      matchedById.set(result.path, result.matched);
      if (result.operational_state) {
        operationalStateById.set(result.path, result.operational_state);
      }
      return { entry, score: result.score };
    });
  } else if (params.text && params.fulltext) {
    // Lexical full-text (#1494): read candidate bodies and BM25-rank. The
    // index is the candidate set; ranking is over actual body content, not
    // the metadata/summary the default path scores.
    const byPath = new Map<string, MetadataEntry>();
    const docs: FullTextDoc[] = [];
    for (const entry of candidates) {
      const body = readEntryBody(cwd, entry.path);
      if (body === null) continue;
      byPath.set(entry.path, entry);
      docs.push({ id: entry.path, text: body });
    }
    const hits = bm25Rank(docs, params.text);
    results = hits
      .map(h => {
        matchedById.set(h.id, h.matchedTerms);
        return { entry: byPath.get(h.id)!, score: h.score };
      })
      .filter(r => r.entry);
  } else if (params.text) {
    results = candidates
      .map(entry => ({ entry, score: scoreEntry(entry, params.text!) }))
      .filter(r => r.score > 0)
      .sort(compareDiscoverResults);
  } else {
    // No keyword — return all filtered results with score 1.0
    results = candidates.map(entry => ({ entry, score: 1.0 }));
  }

  // Apply limit
  const limit = params.limit ?? 20;
  results = results.slice(0, limit);

  const queryTimeMs = Date.now() - startTime;

  // Output
  if (options.json) {
    console.log(JSON.stringify({
      query: { text: params.text, filters: { type: params.type, phase: params.phase, tags: params.tags, path: params.path }, backend },
      mode: params.fulltext ? 'fulltext' : 'metadata',
      results: results.map(r => ({
        path: r.entry.path,
        type: r.entry.type,
        phase: r.entry.phase,
        title: r.entry.title,
        score: Math.round(r.score * 100) / 100,
        summary: r.entry.summary,
        ...(operationalStateById.has(r.entry.path)
          ? { operational_state: operationalStateById.get(r.entry.path) }
          : r.entry.operationalState
            ? { operational_state: operationalStateQueryProjection(r.entry.operationalState) }
            : {}),
        ...(params.fulltext ? { matched: matchedById.get(r.entry.path) ?? [] } : {}),
      })),
      total: results.length,
      query_time_ms: queryTimeMs,
    }, null, 2));
  } else {
    const queryDesc = params.text ? `"${params.text}"` : 'all';
    console.log(`Results for ${queryDesc} (${results.length} matches, ${queryTimeMs}ms):`);
    console.log('');
    console.log('  #  Score  Type         Phase          Path');

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const num = String(i + 1).padStart(3);
      const score = r.score.toFixed(2).padStart(4);
      const type = r.entry.type.padEnd(12).slice(0, 12);
      const phase = r.entry.phase.padEnd(14).slice(0, 14);
      console.log(`  ${num}  ${score}  ${type} ${phase} ${r.entry.path}`);
    }

    if (results.length === 0) {
      console.log('  No results found.');
    }
    console.log('');
  }
}

/**
 * Discovery query — capability search across AIWG artifact kinds.
 *
 * Tuned for "agent looking for the right operational asset" use case.
 * Defaults the type filter to AIWG operational artifact kinds, prefers the
 * `framework` graph (where deployed source lives), and outputs in a
 * token-tight format that names the top trigger phrase responsible for
 * each match.
 *
 * @implements #1214
 */
export interface DiscoverParams {
  /** Trusted host-only, default-off D27 observer. Shadow evidence never changes ranking. */
  shadowRoute?: DiscoveryShadowRoute;
  /** Search phrase (the user's capability description) */
  phrase: string;
  /** Restrict to specific types — defaults to the operational discovery surface */
  typeFilter?: string[];
  /** Max results (default 10) */
  limit?: number;
  /** JSON output mode */
  json?: boolean;
  /** Pretty-print JSON output. Defaults to true for CLI compatibility. */
  jsonPretty?: boolean;
  /** Override default graph (defaults to `framework`, falls back to `project`) */
  graph?: GraphType;
  /** Query backend. Defaults to Fortemi Core; use local for the legacy path. */
  backend?: 'local' | 'fortemi-core';
  /** Physical source of AIWG-owned resources. Defaults to local. */
  resourceSource?: ResourceSource;
  /** Exact calendar-semver version or signed channel selector for web mode. */
  aiwgVersion?: string;
  /** Prohibit network requests and require a fully verified warm cache. */
  offline?: boolean;
  /** Dependency injection for release-host tests and development. */
  webReleaseOptions?: Omit<WebReleaseOptions, 'selector' | 'offline'>;
  /**
   * Include filesystem paths in public discovery output. Default is true for
   * direct API compatibility; CLI callers set false so discover stays
   * capability-oriented and agents use the stable id with `show metadata`.
   */
  includePaths?: boolean;
}

const DEFAULT_DISCOVER_TYPES = [...OPERATIONAL_DISCOVERY_TYPES];

const DEFAULT_CAPABILITY_GRAPHS: GraphType[] = ['project', 'user', 'framework'];

function projectAllowsUserIndices(cwd: string): boolean {
  try {
    const configPath = projectControlPath(cwd, 'aiwg.config');
    if (!fs.existsSync(configPath)) return true;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const index = parsed.index as Record<string, unknown> | undefined;
    const userIndices = index?.userIndices as Record<string, unknown> | undefined;
    if (userIndices?.enabled === false) return false;
    const indices = parsed.indices as Record<string, unknown> | undefined;
    const user = indices?.user as Record<string, unknown> | undefined;
    if (user?.enabled === false) return false;
  } catch {
    return true;
  }
  return true;
}

function defaultCapabilityGraphs(cwd: string): GraphType[] {
  if (projectAllowsUserIndices(cwd)) return DEFAULT_CAPABILITY_GRAPHS;
  return DEFAULT_CAPABILITY_GRAPHS.filter((graph) => graph !== 'user' && !graph.startsWith('user-'));
}

/**
 * Resolve the AIWG installation root for path-anchoring discover output.
 * Discover returns paths anchored to AIWG_ROOT so the agent's `Read`
 * tool can resolve them from any project working directory (#1217).
 */
/**
 * Build the `run_hint` string for a script-bearing skill entry (#1227).
 *
 * Format: `aiwg run skill <name> [-- <argsHint>]`. The skill name is the
 * basename of its source directory (skills/<name>/SKILL.md), which is
 * what `aiwg run skill` accepts.
 */
function buildRunHint(entry: MetadataEntry): string {
  // Use the directory basename for slug-layout skills, filename stem otherwise.
  const lastSlash = entry.path.lastIndexOf('/');
  const tail = lastSlash >= 0 ? entry.path.slice(lastSlash + 1) : entry.path;
  let name: string;
  if (tail === 'SKILL.md' && lastSlash >= 0) {
    const dir = entry.path.slice(0, lastSlash);
    const dirSlash = dir.lastIndexOf('/');
    name = dirSlash >= 0 ? dir.slice(dirSlash + 1) : dir;
  } else {
    name = tail.replace(/\.[^.]+$/, '');
  }
  const argsHint = entry.script?.argsHint ? ` -- ${entry.script.argsHint}` : '';
  return `aiwg run skill ${name}${argsHint}`;
}

function showHintForDiscoverResult(entry: MetadataEntry, id: string): string {
  if (isOperationalShowType(entry.type)) {
    return `aiwg show ${entry.type} ${id}`;
  }
  return `aiwg show ${id}`;
}

async function getAiwgRootForDiscover(): Promise<string | null> {
  if (process.env.AIWG_ROOT) return process.env.AIWG_ROOT;
  try {
    const mod: { getFrameworkRoot?: () => Promise<string | null> } =
      await import('../channel/manager.mjs');
    if (typeof mod.getFrameworkRoot === 'function') {
      const r = await mod.getFrameworkRoot();
      return r || null;
    }
  } catch {
    // channel manager unavailable — fall through
  }
  return null;
}

export async function discoverCapability(
  cwd: string,
  params: DiscoverParams,
): Promise<void> {
  loadGlobalGraphConfigs();
  const startTime = Date.now();
  const types = params.typeFilter && params.typeFilter.length > 0
    ? params.typeFilter
    : DEFAULT_DISCOVER_TYPES;
  // Default top-K = 5 (Wave A from #1218): peer-reviewed work on tool
  // retrieval (Semantic Tool Discovery for MCP, arXiv:2603.20313) reports
  // 97.1% hit@K=3 at scale; K=5 keeps a buffer above K=3 while halving
  // the prior K=10 default. Operators wanting more breadth can pass
  // `--limit N` explicitly.
  const limit = params.limit ?? 5;
  // For framework-graph entries, anchor returned paths to AIWG_ROOT so
  // they resolve from any project working directory (#1217).
  const aiwgRoot = await getAiwgRootForDiscover();

  // Source: prefer `framework` graph (built post-deploy), fall back to
  // project / codebase / legacy depending on what's available.
  let entries: MetadataEntry[] = [];
  const backend = params.backend ?? DEFAULT_ARTIFACT_SEARCH_BACKEND;
  let fortemiCoreDiscoveryScores: Map<string, number> | null = null;
  let resourceSource: ResourceSource = params.resourceSource ?? 'local';
  let resolvedWebRelease: VerifiedWebRelease | undefined;
  let verifiedSourcePaths:
    | import('./fortemi-core-query-adapter.js').FortemiCoreVerifiedSourcePaths
    | undefined;

  if (resourceSource === 'auto') {
    const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
    const localGraphs = params.graph ? [params.graph] : defaultCapabilityGraphs(cwd);
    const localAvailable = localGraphs.some(
      (graph) => loadFortemiCoreMetadataEntries(cwd, graph).entries.length > 0
        || Object.keys(loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', graph)?.entries ?? {}).length > 0,
    );
    resourceSource = localAvailable ? 'local' : 'web';
  }

  if (resourceSource === 'web') {
    if (backend !== 'fortemi-core') {
      console.error('Error: --resource-source web requires the Fortemi Core query backend; --backend local remains available with local resources.');
      process.exit(1);
    }
    if (params.graph && params.graph !== 'framework') {
      console.error("Error: web-backed capability discovery currently supports only the 'framework' graph.");
      process.exit(1);
    }
    try {
      const { resolveWebRelease } = await import('../resources/web-release.js');
      const release = await resolveWebRelease({
        ...params.webReleaseOptions,
        selector: params.aiwgVersion ?? 'stable',
        offline: params.offline,
      });
      resolvedWebRelease = release;
      verifiedSourcePaths = {
        manifestPath: release.fortemiManifestPath,
        exportPath: release.fortemiExportPath,
        manifestSha256: release.fortemiManifestSha256,
        manifestSize: release.fortemiManifestSize,
        exportSha256: release.fortemiExportSha256,
        exportSize: release.fortemiExportSize,
      };
    } catch (error) {
      console.error(`Error: AIWG web resource resolution failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  if (backend === 'fortemi-core') {
    const graphs = resourceSource === 'web'
      ? ['framework' as GraphType]
      : params.graph ? [params.graph] : defaultCapabilityGraphs(cwd);
    const {
      loadFortemiCoreMetadataEntries,
      queryFortemiCoreAiwgDiscovery,
    } = await import('./fortemi-core-query-adapter.js');
    let unavailableReason: string | undefined;
    for (const graph of graphs) {
      const loaded = loadFortemiCoreMetadataEntries(cwd, graph, verifiedSourcePaths);
      if (loaded.reason && graph === 'project' && !params.graph) {
        const fallback = projectCapabilityFallback(cwd);
        if (fallback) {
          entries.push(...fallback);
          continue;
        }
      }
      if (loaded.sourceIndexNewer && resourceSource === 'local') {
        // Do not silently omit a graph whose derived cache is stale. Rank its
        // current source metadata, without consulting scores from the old cache.
        const index = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', graph);
        if (index) {
          console.error(`Warning: ${graph} capability cache is unavailable or stale; using the local ${graph} index. ${loaded.reason}`);
          entries.push(...Object.values(index.entries).map((entry) => withIndexProvenance(entry, graph)));
          continue;
        }
      }
      if (loaded.reason) {
        unavailableReason ??= loaded.reason;
        if (graph === 'framework' && !params.graph) {
          console.error(`Warning: framework capabilities are unavailable: ${loaded.reason}`);
        }
      }
      entries.push(...loaded.entries.map((entry) => withIndexProvenance(entry, graph)));
      const discovered = await queryFortemiCoreAiwgDiscovery(cwd, {
        graph,
        text: params.phrase,
        limit: Math.max(limit * 10, 50),
        types,
        sourcePaths: verifiedSourcePaths,
      });
      if (!discovered.reason) {
        fortemiCoreDiscoveryScores ??= new Map();
        for (const result of discovered.results) {
          if (result.score <= 0) continue;
          fortemiCoreDiscoveryScores.set(
            result.entry.path,
            Math.max(fortemiCoreDiscoveryScores.get(result.entry.path) ?? 0, result.score),
          );
        }
      }
    }
    if (entries.length === 0 && unavailableReason) {
      if (params.json) {
        console.log(JSON.stringify({
          query: {
            phrase: params.phrase,
            types,
            limit,
            backend: 'fortemi-core',
            graph: resourceSource === 'web' ? 'framework' : params.graph ?? 'capability-default',
            ...(resourceSource === 'web'
              ? {
                  resource_source: 'web',
                  aiwg_selector: resolvedWebRelease?.selector,
                  aiwg_version: resolvedWebRelease?.version,
                  manifest_sha256: resolvedWebRelease?.manifestDigest,
                  manifest_url: resolvedWebRelease?.manifestUrl,
                }
              : {}),
          },
          results: [],
          total: 0,
          hint: unavailableReason,
        }, null, 2));
      } else {
        console.error('Error: ' + unavailableReason);
      }
      process.exit(1);
    }
  } else if (params.graph) {
    const idx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', params.graph);
    if (idx) entries = Object.values(idx.entries).map((entry) => withIndexProvenance(entry, params.graph!));
  } else {
    // discover is EXCLUSIVELY the agentic-capability surface (#1545): source
    // the `framework` graph (deployed AIWG capabilities) + project-local
    // capability artifacts. NEVER `codebase` — source code is not a capability
    // surface. discover leverages indexing transparently: if the framework
    // index is missing but its source is present, build it once (incremental
    // thereafter) so discover Just Works without the operator picking a graph.
    let fwIdx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', 'framework');
    if (!fwIdx) {
      // The framework graph is shared (XDG) and `defaultBuild: false`, so a bare
      // `aiwg index build` never (re)builds it — only `aiwg use` or an explicit
      // `--graph framework` does. When it's absent, build it from wherever the
      // AIWG source lives: `cwd/agentic/code` when inside the AIWG repo, else
      // `$AIWG_ROOT/agentic/code` for a USER project (#1541 — opencode users sit
      // in their own project, not the AIWG repo, so a cwd-only check left
      // discover unable to find deployed commands like address-issues). buildIndex
      // scans <root>/agentic/code and writes to the cwd-independent XDG dir, so
      // reading back via cwd still resolves the freshly-built shared index.
      const buildRoot = fs.existsSync(path.join(cwd, 'agentic', 'code'))
        ? cwd
        : aiwgRoot && fs.existsSync(path.join(aiwgRoot, 'agentic', 'code'))
          ? aiwgRoot
          : null;
      if (buildRoot) {
        const { buildIndex } = await import('./index-builder.js');
        if (!params.json) console.error('Building capability index (first run)…');
        // buildIndex writes progress to stdout. In --json mode that would corrupt
        // the JSON envelope the caller parses, so silence stdout for the duration
        // of the auto-build (the build is incidental to the query).
        const origLog = console.log;
        if (params.json) console.log = () => {};
        try {
          await buildIndex(buildRoot, { graph: 'framework', explicit: false });
        } catch {
          /* non-fatal — fall through to whatever index is available */
        } finally {
          console.log = origLog;
        }
        fwIdx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', 'framework');
      }
    }
    const includeUser = projectAllowsUserIndices(cwd);
    // Project-local operational artifacts authored in this project. The
    // DEFAULT_DISCOVER_TYPES filter keeps non-capability project artifacts
    // (requirements, ADRs, …) out of results.
    const projIdx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', 'project');
    if (projIdx) entries.push(...Object.values(projIdx.entries).map((entry) => withIndexProvenance(entry, 'project')));
    if (includeUser) {
      const userIdx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', 'user');
      if (userIdx) entries.push(...Object.values(userIdx.entries).map((entry) => withIndexProvenance(entry, 'user')));
    }
    if (fwIdx) entries.push(...Object.values(fwIdx.entries).map((entry) => withIndexProvenance(entry, 'framework')));
    if (entries.length === 0) {
      const legacy = loadMetadataIndex(cwd);
      if (legacy) entries.push(...Object.values(legacy.entries));
    }
  }

  if (entries.length === 0 && backend !== 'fortemi-core') {
    // Empty-index case (#1221). Surface a hint that explains the gap rather
    // than returning a bare zero-result envelope — the latter trains agents
    // to conclude "AIWG doesn't have a skill for that" when in fact the
    // index simply hasn't been built in this workspace yet.
    const hint = 'No artifact index found. Run `aiwg index build --graph framework` (or `aiwg use <framework>`) first.';
    if (params.json) {
      console.log(JSON.stringify({
        query: { phrase: params.phrase, types },
        results: [],
        total: 0,
        hint,
      }, null, 2));
    } else {
      console.error('Error: No artifact index found.');
      console.log('Run `aiwg index build --graph framework` (or `aiwg use <framework>`) first.');
    }
    process.exit(1);
  }

  // Filter by type
  const candidates = entries.filter(e => types.includes(e.type));

  // Score (strict overlap gate). Keep the full sorted list so the facet
  // fusion below can inject/lift curated capabilities into the top-K before
  // truncation — a capability that the lexical pass ranked outside `limit`
  // (or missed entirely) still surfaces when the query activates its facet.
  const lexicalDiagnostics = new Map<string, LexicalScoreDiagnostic>();
  const legacyStrictScored = candidates
    .map(entry => {
      const detailed = scoreEntryDetailed(entry, params.phrase);
      const legacyScore = detailed.score;
      const fortemiScore = fortemiCoreDiscoveryScores?.get(entry.path) ?? 0;
      lexicalDiagnostics.set(entry.path, detailed.diagnostic);
      return {
        entry,
        score: legacyScore > 0 ? legacyScore : fortemiScore * 0.2,
        legacyScore,
      };
    })
    .filter(r => r.score > 0)
    .sort(compareDiscoverResults);
  const strictScored = (
    legacyStrictScored.some(result => result.legacyScore > 0)
      ? legacyStrictScored.filter(result => result.legacyScore > 0)
      : legacyStrictScored
  ).map(({ entry, score }) => ({ entry, score }));

  // Single-pass facet fusion (#1623 U3): fuse the curated feature→capability
  // facets (expansion / persona / project / provider-capability) into the
  // lexical ranking so canonical domain phrases rank their owning capability
  // top-K instead of being out-scored by artifacts that merely mention the
  // word. Facet activation can also rescue an otherwise-empty strict pass.
  // #154 — a strict result anywhere in the corpus must not suppress relevant
  // partial matches for a natural-language query. Score the relaxed pass on
  // matched terms (unmatched terms do not divide the score), apply a noise
  // floor, and union it with strict matches before ranking. Word-boundary
  // token matching keeps this from resurrecting substring noise such as UX in
  // Linux.
  const RELAXED_MIN_SCORE = 0.02;
  const strictPaths = new Set(strictScored.map(result => result.entry.path));
  const combinedByPath = new Map(strictScored.map(result => [result.entry.path, result]));
  for (const entry of candidates) {
    const detailed = scoreEntryDetailed(entry, params.phrase, { relaxOverlap: true });
    if (detailed.score < RELAXED_MIN_SCORE) continue;
    const existing = combinedByPath.get(entry.path);
    if (!existing || detailed.score > existing.score) {
      combinedByPath.set(entry.path, { entry, score: detailed.score });
      lexicalDiagnostics.set(entry.path, detailed.diagnostic);
    }
  }
  const scored = dedupeDiscoverResults(
    await applyFacetFusion(
      Array.from(combinedByPath.values()).sort(compareDiscoverResults),
      candidates,
      params.phrase,
    ),
  ).slice(0, limit);
  const relaxed = scored.some(result => !strictPaths.has(result.entry.path));

  if (params.shadowRoute) {
    try {
      await params.shadowRoute.observe(params.phrase, scored.map(result => ({
        id: discoveryIdForEntry(result.entry), name: result.entry.name ?? result.entry.title,
        type: result.entry.type, capability: result.entry.capability ?? result.entry.summary,
        score: result.score,
      })));
    } catch {
      // An optional observation failure must never replace deterministic discovery.
      params.shadowRoute.disable();
    }
  }

  const queryTimeMs = Date.now() - startTime;

  /**
   * Resolve a stored framework-graph path to an absolute AIWG_ROOT
   * path (#1217). Framework-graph entries are stored as paths relative
   * to the AIWG repo root (e.g. `agentic/code/frameworks/.../SKILL.md`);
   * anchoring them to `AIWG_ROOT` makes them readable from any project
   * working directory.
   *
   * Kernel skills are anchored the same way (#1230) — `aiwg show` reads
   * the source corpus, not platform deploy mirrors, so kernel entries
   * need the same `AIWG_ROOT` anchoring as non-kernel framework entries.
   * Non-framework entries (project / codebase graphs) keep their stored
   * paths unchanged.
   */
  function resolvePath(entry: MetadataEntry): string {
    const normalizedPath = normalizeIndexedPath(entry.path);
    if (!aiwgRoot) return normalizedPath;
    if (path.isAbsolute(entry.path)) return entry.path;
    if (normalizedPath.startsWith('agentic/code/')) return path.join(aiwgRoot, normalizedPath);
    return normalizedPath;
  }

  // Build a hint string when the index has entries but no scored matches —
  // this is the second silent-failure mode #1221 calls out. When the workspace
  // has project-local content (.aiwg/{extensions,addons,frameworks,plugins,providers}/)
  // surface a project-graph rebuild hint (#1235).
  // discover-appropriate hint (#1545): never push index/graph mechanics. If
  // nothing scored, the phrase didn't match an indexed capability — suggest a
  // broader phrase / type filter, and a capability refresh via `aiwg use`.
  const emptyResultHint = scored.length === 0
    ? backend === 'fortemi-core'
      ? `No capability matched "${params.phrase}" among ${entries.length} Fortemi Core static-cache capabilities. Try a broader phrase or a \`--type\` filter. If the local index changed, refresh the cache with \`aiwg index sync ${params.graph ? `--graph ${params.graph}` : '--all'}\`, or pass \`--backend local\` to use the legacy local index.`
      : `No capability matched "${params.phrase}" among ${entries.length} indexed capabilities. Try a broader phrase or a \`--type\` filter. If you just installed or authored capabilities, refresh discovery with \`aiwg use <framework>\` (or \`aiwg index build\`).`
    : null;

  const includePaths = params.includePaths ?? true;
  const facetActivations = diagnoseFacetActivations(params.phrase);
  const roundDiagnostic = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
  const rankingDiagnostic = (
    entry: MetadataEntry,
    finalScore: number,
    facetDiagnostics: FacetScoreDiagnostic[] | undefined,
  ) => {
    const lexical = lexicalDiagnostics.get(entry.path) ?? {
      content_tokens: tokenize(params.phrase),
      raw_score: 0,
      score: 0,
      score_cap_applied: false,
      matches: [],
    };
    const scope = (entry as ProvenancedEntry).indexScope ?? 'unknown';
    return {
      lexical_score: roundDiagnostic(lexical.score),
      lexical_raw_score: roundDiagnostic(lexical.raw_score),
      final_score: roundDiagnostic(finalScore),
      score_cap_applied: lexical.score_cap_applied,
      matches: lexical.matches.map((match) => ({
        ...match,
        contribution: roundDiagnostic(match.contribution),
        ...(match.query_token_coverage === undefined
          ? {}
          : { query_token_coverage: roundDiagnostic(match.query_token_coverage) }),
      })),
      facets: (facetDiagnostics ?? []).map((facet) => ({
        ...facet,
        activation_floor: roundDiagnostic(facet.activation_floor),
        base_score: roundDiagnostic(facet.base_score),
        rrf_tiebreak: roundDiagnostic(facet.rrf_tiebreak),
      })),
      tie_breakers: {
        scope,
        scope_rank: scopeRank(entry),
        type_rank: DISCOVER_TYPE_ORDER.get(entry.type) ?? 99,
      },
    };
  };

  if (params.json) {
    const jsonIndent = params.jsonPretty === false ? undefined : 2;
    console.log(JSON.stringify({
      query: {
        phrase: params.phrase,
        types,
        limit,
        aiwg_root: aiwgRoot ?? null,
        backend,
        graph: backend === 'fortemi-core'
          ? resourceSource === 'web' ? 'framework' : params.graph ?? 'capability-default'
          : params.graph,
        ...(resourceSource === 'web'
          ? {
              resource_source: 'web',
              aiwg_selector: resolvedWebRelease?.selector,
              aiwg_version: resolvedWebRelease?.version,
              manifest_sha256: resolvedWebRelease?.manifestDigest,
              manifest_url: resolvedWebRelease?.manifestUrl,
            }
          : {}),
      },
      results: scored.map(r => ({
        id: discoveryIdForEntry(r.entry),
        ...(includePaths ? { path: resolvePath(r.entry) } : {}),
        type: r.entry.type,
        name: r.entry.name,
        title: r.entry.title,
        score: Math.round(r.score * 100) / 100,
        ranking: rankingDiagnostic(r.entry, r.score, r.facetDiagnostics),
        triggers: r.entry.triggers ?? [],
        capability: r.entry.capability ?? r.entry.summary,
        kernel: r.entry.kernel ?? false,
        provenance: {
          graph: (r.entry as ProvenancedEntry).indexGraph ?? null,
          scope: (r.entry as ProvenancedEntry).indexScope ?? null,
        },
        // #1227 — surface script-bearing skills so agents know to use
        // `aiwg run skill <name>` instead of executing instructions
        // themselves.
        ...(r.entry.script
          ? {
              executable: true,
              run_hint: buildRunHint(r.entry),
            }
          : {}),
      })),
      total: scored.length,
      query_time_ms: queryTimeMs,
      diagnostics: {
        content_tokens: tokenize(params.phrase),
        facet_activations: facetActivations,
        score_tie_break_order: ['score', 'scope', 'type', 'name', 'path'],
      },
      ...(relaxed ? { relaxed_overlap: true } : {}),
      ...(emptyResultHint ? { hint: emptyResultHint } : {}),
    }, null, jsonIndent));
    return;
  }

  if (scored.length === 0) {
    console.log(`No discovery matches for "${params.phrase}" in types: ${types.join(',')}.`);
    console.log(backend === 'fortemi-core'
      ? emptyResultHint
      : 'Try a broader phrase or a `--type` filter. If capabilities were just added, refresh with `aiwg use <framework>` (or `aiwg index build`).');
    return;
  }

  const relaxedNote = relaxed ? ' — relaxed match (verbose query)' : '';
  console.log(`Discovery results for "${params.phrase}" (${scored.length} matches, ${queryTimeMs}ms)${relaxedNote}:`);
  console.log('');
  for (const diagnostic of facetActivations) {
    if (diagnostic.status === 'suppressed' && diagnostic.reason) {
      console.log(`Routing diagnostic: ${diagnostic.reason}.`);
      console.log('');
    }
  }
  for (let i = 0; i < scored.length; i++) {
    const r = scored[i];
    const ranking = rankingDiagnostic(r.entry, r.score, r.facetDiagnostics);
    const id = discoveryIdForEntry(r.entry);
    const score = r.score.toFixed(2);
    const flags = [
      r.entry.kernel ? 'kernel' : null,
      r.entry.script ? 'exec' : null,
    ].filter(Boolean).join(', ');
    const locator = includePaths ? resolvePath(r.entry) : id;
    const topTriggerMatch = ranking.matches
      .filter((match) => match.field === 'trigger')
      .reduce<(typeof ranking.matches)[number] | undefined>(
        (best, match) => !best || match.contribution > best.contribution ? match : best,
        undefined,
      );
    const topTrigger = topTriggerMatch?.value ??
      (r.entry.triggers && r.entry.triggers.length > 0 ? r.entry.triggers[0] : '');
    console.log(`${i + 1}. ${r.entry.title}`);
    console.log(`   type: ${r.entry.type}  score: ${score}${flags ? `  flags: ${flags}` : ''}`);
    console.log(`   ${includePaths ? 'path' : 'id'}: ${locator}`);
    if (r.entry.name) {
      console.log(`   name: ${r.entry.name}`);
    }
    if (r.entry.capability) {
      console.log(`   capability: ${r.entry.capability}`);
    }
    if (topTrigger) {
      console.log(`   trigger: "${topTrigger}"`);
    }
    const triggerCoverage = topTriggerMatch?.query_token_coverage;
    const rankingParts = [
      `lexical ${ranking.lexical_score.toFixed(4)} -> final ${ranking.final_score.toFixed(4)}`,
      triggerCoverage === undefined
        ? null
        : `trigger covers ${Math.round(triggerCoverage * 100)}% of query tokens`,
      `scope ${ranking.tie_breakers.scope}`,
    ].filter((part): part is string => Boolean(part));
    console.log(`   ranking: ${rankingParts.join('; ')}`);
    if (r.entry.script) {
      console.log(`   run: ${buildRunHint(r.entry)}`);
    } else if (!includePaths) {
      console.log(`   show: ${showHintForDiscoverResult(r.entry, id)}`);
    }
    console.log('');
  }
  console.log('Use `--format json` for machine-readable output. Use `aiwg show metadata <id>` for paths and full metadata.');
}

export interface ShowParams {
  /** Skill name (e.g. `intake-wizard`), title, or artifact path */
  name: string;
  /** Restrict to specific types — defaults to showable operational types */
  typeFilter?: string[];
  /** Emit a JSON envelope (path + content) instead of raw file text */
  json?: boolean;
  /** Override default graph (defaults to `framework`, falls back to `project`) */
  graph?: GraphType;
  /** Include full bound rule bodies in addition to summaries and pointers. */
  boundRuleBodies?: boolean;
  /** When ambiguous, pick the first match instead of erroring */
  first?: boolean;
  /** Query backend. Defaults to Fortemi Core; use local for the legacy path. */
  backend?: 'local' | 'fortemi-core';
  /** Physical source of AIWG-owned resources. Defaults to local. */
  resourceSource?: ResourceSource;
  /** Exact calendar-semver version or signed channel selector for web mode. */
  aiwgVersion?: string;
  /** Prohibit network requests and require verified cached metadata and body bytes. */
  offline?: boolean;
  /** Dependency injection for release-host tests and development. */
  webReleaseOptions?: Omit<WebReleaseOptions, 'selector' | 'offline'>;
}

export interface ShowMetadataParams extends ShowParams {}

function resolveMetadataPath(cwd: string, aiwgRoot: string | null, entry: MetadataEntry): string {
  if (path.isAbsolute(entry.path)) return entry.path;
  const normalizedPath = normalizeIndexedPath(entry.path);
  if (aiwgRoot && normalizedPath.startsWith('agentic/code/')) {
    return path.join(aiwgRoot, normalizedPath);
  }
  if ((entry as ProvenancedEntry).indexScope === 'user' && normalizedPath.startsWith('~/.aiwg/')) {
    return path.join(process.env.HOME ?? '', normalizedPath.slice(2));
  }
  if (normalizedPath.startsWith('.aiwg/')) {
    return projectAiwgPath(cwd, normalizedPath.slice('.aiwg/'.length));
  }
  return path.join(cwd, normalizedPath);
}

async function loadShowEntries(
  cwd: string,
  params: Pick<
    ShowParams,
    'backend' | 'graph' | 'json' | 'name' | 'resourceSource' | 'aiwgVersion' | 'offline' | 'webReleaseOptions'
  >,
): Promise<{
  entries: MetadataEntry[];
  aiwgRoot: string | null;
  resourceSource: 'local' | 'web';
  webRelease?: VerifiedWebRelease;
  sourcePaths?: import('./fortemi-core-query-adapter.js').FortemiCoreVerifiedSourcePaths;
}> {
  const aiwgRoot = await getAiwgRootForDiscover();
  const backend = params.backend ?? DEFAULT_ARTIFACT_SEARCH_BACKEND;
  let resourceSource: ResourceSource = params.resourceSource ?? 'local';
  let entries: MetadataEntry[] = [];

  if (resourceSource === 'auto' && backend === 'fortemi-core') {
    const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
    const localGraphs = params.graph ? [params.graph] : defaultCapabilityGraphs(cwd);
    resourceSource = localGraphs.some(
      (graph) => loadFortemiCoreMetadataEntries(cwd, graph).entries.length > 0,
    ) ? 'local' : 'web';
  } else if (resourceSource === 'auto') {
    resourceSource = 'local';
  }

  if (resourceSource === 'web') {
    if (backend !== 'fortemi-core') {
      console.error('Error: --resource-source web requires the Fortemi Core query backend; --backend local remains available with local resources.');
      process.exit(1);
    }
    if (params.graph && params.graph !== 'framework') {
      console.error("Error: web-backed show currently supports only the 'framework' graph.");
      process.exit(1);
    }
    try {
      const { resolveWebRelease } = await import('../resources/web-release.js');
      const webRelease = await resolveWebRelease({
        ...params.webReleaseOptions,
        selector: params.aiwgVersion ?? 'stable',
        offline: params.offline,
      });
      const sourcePaths = {
        manifestPath: webRelease.fortemiManifestPath,
        exportPath: webRelease.fortemiExportPath,
        manifestSha256: webRelease.fortemiManifestSha256,
        manifestSize: webRelease.fortemiManifestSize,
        exportSha256: webRelease.fortemiExportSha256,
        exportSize: webRelease.fortemiExportSize,
      };
      const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
      const loaded = loadFortemiCoreMetadataEntries(cwd, 'framework', sourcePaths);
      if (loaded.reason) throw new Error(loaded.reason);
      entries = loaded.entries.map((entry) => withIndexProvenance(entry, 'framework'));
      return { entries, aiwgRoot, resourceSource: 'web', webRelease, sourcePaths };
    } catch (error) {
      console.error(`Error: AIWG web resource resolution failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  // Preserve the direct API's historical local-index behavior when callers
  // omit `backend`. The CLI always passes its explicit Fortemi default, while
  // an explicit `auto` source also opts into Fortemi-backed availability.
  if (params.backend === 'fortemi-core' || params.resourceSource === 'auto') {
    const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
    const graphs = params.graph ? [params.graph] : defaultCapabilityGraphs(cwd);
    let unavailableReason: string | undefined;
    for (const graph of graphs) {
      const loaded = loadFortemiCoreMetadataEntries(cwd, graph);
      if (loaded.reason && graph === 'project' && !params.graph) {
        const fallback = projectCapabilityFallback(cwd);
        if (fallback) {
          entries.push(...fallback);
          continue;
        }
      }
      if (loaded.reason) {
        unavailableReason ??= loaded.reason;
        if (graph === 'framework' && !params.graph) {
          console.error(`Warning: framework capabilities are unavailable: ${loaded.reason}`);
        }
      }
      entries.push(...loaded.entries.map((entry) => withIndexProvenance(entry, graph)));
    }
    if (entries.length === 0 && unavailableReason) {
      if (params.json) {
        console.log(JSON.stringify({
          backend: 'fortemi-core',
          name: params.name,
          error: unavailableReason,
        }, null, 2));
      } else {
        console.error('Error: ' + unavailableReason);
      }
      process.exit(1);
    }
  } else {
    entries = loadLocalCapabilityEntries(cwd, params.graph);
  }
  return { entries, aiwgRoot, resourceSource: 'local' };
}

/** Local index inputs shared by show and exact rule-binding validation (#2938). */
export function loadLocalCapabilityEntries(cwd: string, graph?: GraphType): MetadataEntry[] {
  const entries: MetadataEntry[] = [];
  for (const selectedGraph of graph ? [graph] : defaultCapabilityGraphs(cwd)) {
    const index = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', selectedGraph);
    if (index) entries.push(...Object.values(index.entries).map(entry => withIndexProvenance(entry, selectedGraph)));
  }
  if (!graph && entries.length === 0) {
    const legacy = loadMetadataIndex(cwd);
    if (legacy) entries.push(...Object.values(legacy.entries));
  }
  return entries;
}

function findShowMatches(entries: MetadataEntry[], types: string[], needle: string): MetadataEntry[] {
  const needleLower = needle.toLowerCase();
  const normalizedNeedle = normalizeIndexedPath(needle);
  const candidates = entries.filter(e => types.includes(e.type));

  let matches = candidates.filter(e => discoveryIdForEntry(e) === needle);
  if (matches.length === 0) {
    matches = candidates.filter(e => e.path === needle || normalizeIndexedPath(e.path) === normalizedNeedle);
  }
  if (matches.length === 0) {
    matches = candidates.filter(e => {
      const normalizedPath = normalizeIndexedPath(e.path);
      const dirStem = path.basename(path.dirname(normalizedPath));
      const basename = path.basename(normalizedPath);
      const fileStem = basename.replace(/\.[^.]+$/, '');
      const slugLayoutMatch =
        ((basename === 'SKILL.md' && e.type === 'skill') ||
          (basename === 'BEHAVIOR.md' && e.type === 'behavior')) &&
        dirStem === needle;
      if (slugLayoutMatch || fileStem === needle || e.name === needle) return true;
      if (e.type === 'gate-pack' && typeof e.name === 'string') {
        const gateStem = fileStem.replace(/\.gatepack$/i, '');
        const rest = e.name.includes(':') ? e.name.slice(e.name.indexOf(':') + 1) : e.name;
        const short = rest.includes('/') ? rest.slice(rest.indexOf('/') + 1) : rest;
        return gateStem === needle || rest === needle || short === needle;
      }
      return false;
    });
  }
  if (matches.length === 0) {
    matches = candidates.filter(e =>
      typeof e.title === 'string' && e.title.toLowerCase() === needleLower,
    );
  }

  matches = uniqueEntriesByPath(matches);
  matches = matches.sort((a, b) => scopeRank(a) - scopeRank(b) || a.path.localeCompare(b.path));

  if (matches.length > 1) {
    const sameIdentity = matches.every((entry) =>
      entry.type === matches[0].type &&
      (entry.name ?? '').toLowerCase() === (matches[0].name ?? '').toLowerCase(),
    );
    if (sameIdentity && scopeRank(matches[0]) < scopeRank(matches[1])) {
      matches = [matches[0]];
    }
  }
  if (matches.length > 1 && types.includes('skill')) {
    const frameworkSkillMatches = matches.filter(e => isFrameworkSourceSkillPath(e.path));
    if (frameworkSkillMatches.length === 1) matches = frameworkSkillMatches;
  }
  if (matches.length > 1 && types.includes('skill')) {
    const sourceSkillMatches = matches.filter(e => isCanonicalSourceSkillPath(e.path));
    if (sourceSkillMatches.length === 1) matches = sourceSkillMatches;
  }
  if (matches.length > 1 && types.includes('agent')) {
    const canonicalSourceMatches = matches.filter(e => isCanonicalSourceAgentPath(e.path));
    if (canonicalSourceMatches.length === 1) matches = canonicalSourceMatches;
  }
  if (matches.length > 1 && types.includes('agent')) {
    const canonicalBundleMatches = matches.filter(e => isCanonicalBundleAgentPath(e.path));
    const canonicalBundlePaths = uniqueEntriesByPath(canonicalBundleMatches);
    if (canonicalBundlePaths.length === 1) matches = canonicalBundlePaths;
  }
  if (matches.length > 1 && types.includes('agent')) {
    const nonPersonaMatches = matches.filter(e => !isTopLevelPersonaAgentPath(e.path));
    if (nonPersonaMatches.length === 1) matches = nonPersonaMatches;
  }
  return matches;
}

/** Resolve exact rule binding IDs using the same precedence and ambiguity as show.
 * Titles and filesystem path guesses are deliberately excluded (#2938).
 */
export function resolveRuleBindingTarget(
  entries: MetadataEntry[], type: 'skill' | 'agent' | 'flow', id: string,
): MetadataEntry {
  const exact = entries.filter(entry => entry.type === type
    && (entry.name === id || discoveryIdForEntry(entry) === id));
  const matches = findShowMatches(exact, [type], id);
  if (matches.length === 0) throw new Error(`Missing ${type} binding target: ${id}`);
  if (matches.length > 1) throw new Error(`Ambiguous ${type} binding target: ${id}: ${matches.map(entry => entry.path).join(', ')}`);
  return matches[0];
}

async function fortemiRecordForEntry(
  cwd: string,
  entry: MetadataEntry,
  sourcePaths?: import('./fortemi-core-query-adapter.js').FortemiCoreVerifiedSourcePaths,
): Promise<AiwgFortemiRecord | null> {
  const graph = ((entry as ProvenancedEntry).indexGraph ?? 'project') as GraphType;
  const { loadFortemiCoreExport } = await import('./fortemi-core-query-adapter.js');
  const loaded = loadFortemiCoreExport(cwd, graph, sourcePaths);
  if (!loaded.exported) return null;
  const id = discoveryIdForEntry(entry);
  return loaded.exported.items.find((record) => record.id === id || record.source.path === entry.path) ?? null;
}

/**
 * Scan bundle `gate-packs/` directories for a pack matching `needle` (#2830).
 *
 * Accepts the full namespaced id, the rest-path or the short pack name and
 * probes `<bundle>/gate-packs/<pack>.gatepack.{yaml,yml,json}`. Never looks
 * under `gates/`, which agent-persistence HITL owns.
 */
async function findGatePackInCorpus(
  groups: Array<{ kind: 'framework' | 'addon' | 'extension' | 'plugin'; dir: string }>,
  needle: string,
): Promise<{ path: string; bundleKind: 'framework' | 'addon' | 'extension' | 'plugin' | null; bundleId: string | null } | null> {
  const path = await import('node:path');
  const fsp = (await import('node:fs')).promises;
  const trimmed = needle.trim();
  const rest = trimmed.includes(':') ? trimmed.slice(trimmed.indexOf(':') + 1) : trimmed;
  const slash = rest.indexOf('/');
  const wantedBundle = slash >= 0 ? rest.slice(0, slash) : null;
  const wantedPack = slash >= 0 ? rest.slice(slash + 1) : rest;
  if (!wantedPack || /\s/.test(wantedPack) || wantedPack.includes(':') || wantedPack.includes('/')) return null;
  const extensions = ['.gatepack.yaml', '.gatepack.yml', '.gatepack.json'];
  const ordered = wantedBundle
    ? groups.flatMap(group => [{ group, bundle: wantedBundle }])
    : null;
  const probe = async (
    group: { kind: 'framework' | 'addon' | 'extension' | 'plugin'; dir: string },
    bundle: string,
  ): Promise<{ path: string; bundleKind: 'framework' | 'addon' | 'extension' | 'plugin' | null; bundleId: string | null } | null> => {
    for (const extension of extensions) {
      const candidate = path.join(group.dir, bundle, 'gate-packs', `${wantedPack}${extension}`);
      try {
        const stat = await fsp.stat(candidate);
        if (stat.isFile()) return { path: candidate, bundleKind: group.kind, bundleId: bundle };
      } catch {
        // not present — continue
      }
    }
    return null;
  };
  if (ordered) {
    for (const { group, bundle } of ordered) {
      const found = await probe(group, bundle);
      if (found) return found;
    }
    return null;
  }
  for (const group of groups) {
    let bundles: string[];
    try {
      bundles = (await fsp.readdir(group.dir, { withFileTypes: true }))
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
    } catch {
      continue;
    }
    for (const bundle of bundles) {
      const found = await probe(group, bundle);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Scan the AIWG_ROOT corpus for an artifact matching `name` (#1221).
 *
 * Walks the well-known artifact layouts under
 * `agentic/code/{frameworks,addons,extensions,plugins}/<bundle>/{skills,agents,commands,rules,templates,behaviors,flows}/`
 * and returns the first match. Used as a fallback in `aiwg show` when an
 * artifact isn't in any built index — either because the workspace hasn't
 * been deployed to yet, or because the bundle hasn't been installed.
 *
 * Returns the resolved absolute path plus enough metadata for the caller
 * to surface a useful install hint. Returns null if nothing matches.
 */
async function findCorpusArtifact(
  aiwgRoot: string,
  name: string,
  typeFilter: string[],
): Promise<{
  path: string;
  type: string;
  bundleKind: 'framework' | 'addon' | 'extension' | 'plugin' | null;
  bundleId: string | null;
} | null> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fsp = fs.promises;

  const groups: Array<{ kind: 'framework' | 'addon' | 'extension' | 'plugin'; dir: string }> = [
    { kind: 'framework', dir: path.join(aiwgRoot, 'agentic/code/frameworks') },
    { kind: 'addon', dir: path.join(aiwgRoot, 'agentic/code/addons') },
    { kind: 'extension', dir: path.join(aiwgRoot, 'agentic/code/extensions') },
    { kind: 'plugin', dir: path.join(aiwgRoot, 'agentic/code/plugins') },
  ];

  // (subdir, type, layout) — 'flat' = `<name>.md`, 'slug' = `<name>/SKILL.md`
  const tries: Array<{ sub: string; type: string; layout: 'flat' | 'slug'; extension?: '.md' | '.json' | '.yaml' }> = [
    { sub: 'skills', type: 'skill', layout: 'slug' },
    { sub: 'skills', type: 'skill', layout: 'flat' },
    { sub: 'agents', type: 'agent', layout: 'flat' },
    { sub: 'commands', type: 'command', layout: 'flat' },
    { sub: 'rules', type: 'rule', layout: 'flat' },
    { sub: 'templates', type: 'template', layout: 'flat' },
    { sub: 'behaviors', type: 'behavior', layout: 'flat' },
    { sub: 'flows', type: 'flow', layout: 'flat' },
    { sub: 'runbooks', type: 'runbook', layout: 'flat' },
    { sub: 'decisions', type: 'decision-definition', layout: 'flat', extension: '.json' },
    { sub: 'rulesets', type: 'decision-ruleset', layout: 'flat', extension: '.json' },
    { sub: 'bindings', type: 'decision-binding', layout: 'flat', extension: '.json' },
  ];

  for (const group of groups) {
    let bundles: string[];
    try {
      bundles = (await fsp.readdir(group.dir, { withFileTypes: true }))
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      continue;
    }
    for (const bundle of bundles) {
      for (const t of tries) {
        if (typeFilter.length > 0 && !typeFilter.includes(t.type)) continue;
        const candidate = t.layout === 'slug'
          ? path.join(group.dir, bundle, t.sub, name, 'SKILL.md')
          : path.join(group.dir, bundle, t.sub, `${name}${t.extension ?? '.md'}`);
        try {
          const stat = await fsp.stat(candidate);
          if (stat.isFile()) {
            return { path: candidate, type: t.type, bundleKind: group.kind, bundleId: bundle };
          }
        } catch {
          // not present — continue
        }
      }
    }
  }

  // Gate packs live in `<bundle>/gate-packs/*.gatepack.yaml|json` (never
  // `gates/`, which agent-persistence HITL uses). The needle may be the full
  // namespaced id (`aiwg:decision-engine/integrity-ceiling`), the rest-path
  // (`decision-engine/integrity-ceiling`) or the short pack name
  // (`integrity-ceiling`). (#2830)
  if (typeFilter.length === 0 || typeFilter.includes('gate-pack')) {
    const gateMatch = await findGatePackInCorpus(groups, name);
    if (gateMatch) return { ...gateMatch, type: 'gate-pack' };
  }

  // Top-level agents live at `agentic/code/agents/<category>/<name>.md`
  // (e.g. `personas/aiwg-writer.md`) — a flat-under-category layout the
  // bundle groups above do not cover. Scan it directly so persona/agent
  // `show` survives un-indexed (or stale-framework-index) workspaces, where
  // the corpus fallback is the only resolution path. (#1623 U5)
  if (typeFilter.length === 0 || typeFilter.includes('agent')) {
    const agentMatch = await findAgentInCorpus(
      path.join(aiwgRoot, 'agentic/code/agents'),
      name,
    );
    if (agentMatch) {
      return { path: agentMatch, type: 'agent', bundleKind: null, bundleId: null };
    }
  }

  // Behaviors commonly use a slug layout: `behaviors/<name>/BEHAVIOR.md`.
  if (typeFilter.length === 0 || typeFilter.includes('behavior')) {
    for (const group of groups) {
      let bundles: string[];
      try {
        bundles = (await fsp.readdir(group.dir, { withFileTypes: true }))
          .filter(d => d.isDirectory())
          .map(d => d.name);
      } catch {
        continue;
      }
      for (const bundle of bundles) {
        const candidate = path.join(group.dir, bundle, 'behaviors', name, 'BEHAVIOR.md');
        try {
          const stat = await fsp.stat(candidate);
          if (stat.isFile()) {
            return { path: candidate, type: 'behavior', bundleKind: group.kind, bundleId: bundle };
          }
        } catch {
          // not present — continue
        }
      }
    }
  }

  return null;
}

/**
 * Recursively scan `agentic/code/agents` for a flat `<name>.md` agent file.
 *
 * Agents use an `agents/<category>/<name>.md` layout (e.g. `personas/`) that
 * differs from the bundle `<dir>/<bundle>/<sub>/<name>.md` layout the generic
 * corpus scan walks, so persona agents are otherwise missed. Bounded depth —
 * the agents tree is shallow. Returns the first matching absolute path, or
 * null. Direct files at each level take priority over subdirectories. (#1623)
 */
async function findAgentInCorpus(
  agentsRoot: string,
  name: string,
  depth = 0,
): Promise<string | null> {
  if (depth > 3) return null;
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fsp = fs.promises;

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(agentsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  // Prefer a direct `<name>.md` at this level before descending.
  for (const entry of entries) {
    if (entry.isFile() && entry.name === `${name}.md`) {
      return path.join(agentsRoot, entry.name);
    }
  }
  // Descend into category subdirectories (e.g. personas/).
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findAgentInCorpus(path.join(agentsRoot, entry.name), name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Build an ephemeral reverse lookup from the already-loaded rule metadata. */
function rulesBoundTo(entries: MetadataEntry[], target: MetadataEntry): MetadataEntry[] {
  const key = ({ skill: 'skills', agent: 'agents', flow: 'flows' } as const)[target.type as 'skill' | 'agent' | 'flow'];
  if (!key) return [];
  const file = path.basename(normalizeIndexedPath(target.path));
  const aliases = [target.name, target.title, target.path, discoveryIdForEntry(target),
    file === 'SKILL.md' ? path.basename(path.dirname(normalizeIndexedPath(target.path))) : file.replace(/\.[^.]+$/, '')]
    .filter((alias): alias is string => !!alias);
  const seen = new Set<string>();
  return entries.filter(rule => {
    if (rule.type !== 'rule' && rule.type !== 'behavior') return false;
    const patterns = rule.bound_to?.[key];
    if (!Array.isArray(patterns) || !patterns.some(pattern => typeof pattern === 'string'
      && aliases.some(alias => alias === pattern || minimatch(alias, pattern, { nonegate: true, nocomment: true })))) return false;
    const identity = `${rule.type}:${rule.path}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).sort((a, b) => (a.name ?? a.path).localeCompare(b.name ?? b.path) || a.path.localeCompare(b.path));
}

async function showBindings(
  entries: MetadataEntry[], target: MetadataEntry, content: string, params: ShowParams,
  read: (entry: MetadataEntry) => Promise<string>,
): Promise<{ fields: Record<string, unknown>; text: string }> {
  const rules = rulesBoundTo(entries, target);
  const boundRules = await Promise.all(rules.map(async rule => ({
    name: rule.name ?? path.basename(rule.path, '.md'),
    activation: rule.activation ?? null,
    summary: rule.ruleSummary ?? '',
    show_command: `aiwg show ${rule.type} ${rule.name ?? path.basename(rule.path, '.md')}`,
    ...(params.boundRuleBodies ? { content: await read(rule) } : {}),
  })));
  // Parse the selected rule for reverse lookup, including corpus-only rules.
  const targets = target.type === 'rule' || target.type === 'behavior'
    ? parseFrontmatter(content).data.bound_to : undefined;
  const boundTo = targets && typeof targets === 'object' && !Array.isArray(targets)
    ? Object.fromEntries(['skills', 'agents', 'flows'].flatMap(key => {
        const values = (targets as Record<string, unknown>)[key];
        const names = Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === 'string' && !!value.trim()))] : [];
        return names.length ? [[key, names]] : [];
      })) : {};
  let text = '';
  if (boundRules.length) {
    text += '\n## Bound rules\n\n' + boundRules.map(rule =>
      `- **${rule.name}**: ${rule.summary} (\`${rule.show_command}\`)`
      + ('content' in rule ? `\n\n${rule.content}` : '')).join('\n') + '\n';
  }
  if (Object.keys(boundTo).length) {
    text += '\n## Bound targets\n\n' + Object.entries(boundTo)
      .map(([key, names]) => `- ${key}: ${(names as string[]).map(name => `\`${name}\``).join(', ')}`).join('\n') + '\n';
  }
  return { fields: {
    ...(boundRules.length ? { bound_rules: boundRules } : {}),
    ...(Object.keys(boundTo).length ? { bound_to: boundTo } : {}),
  }, text };
}

/**
 * Read and emit the full text of a specific artifact (typically a
 * SKILL.md). Consumers don't need to know where AIWG stores skills —
 * they pass the skill name and the CLI reads the file from the indexed
 * location.
 *
 * Lookup order:
 *   1. Stable discover/Fortemi id
 *   2. Exact path match against any indexed entry's stored path
 *   3. Basename match (e.g. `intake-wizard` matches an entry whose
 *      directory basename is `intake-wizard`)
 *   4. Title match (case-insensitive)
 *   5. Corpus fallback under AIWG_ROOT (#1221)
 *
 * On ambiguity, lists all matches and exits with code 2 unless
 * `--first` is supplied.
 */
export async function showArtifact(
  cwd: string,
  params: ShowParams,
): Promise<void> {
  loadGlobalGraphConfigs();
  const { promises: fs } = await import('node:fs');
  const types = params.typeFilter && params.typeFilter.length > 0
    ? params.typeFilter
    : [...OPERATIONAL_SHOW_TYPES];
  const {
    entries,
    aiwgRoot,
    resourceSource,
    webRelease,
  } = await loadShowEntries(cwd, params);

  if (entries.length === 0 && params.backend !== 'fortemi-core') {
    console.error('Error: No artifact index found.');
    console.error('Run `aiwg index build --graph framework` (or `aiwg use <framework>`) first.');
    process.exit(1);
  }

  const needle = params.name.trim();
  let matches = findShowMatches(entries, types, needle);

  if (matches.length === 0) {
    // Corpus fallback (#1221): when the artifact isn't in any indexed graph,
    // scan the AIWG_ROOT corpus for a likely match and render it with an
    // "(uninstalled)" banner. This keeps `aiwg show` useful in workspaces
    // where the operator hasn't run `aiwg use` yet, or where the framework
    // index is stale, rather than exiting with a misleading "not found".
    if (resourceSource === 'local' && aiwgRoot && params.backend !== 'fortemi-core') {
      const corpusMatch = await findCorpusArtifact(aiwgRoot, needle, types);
      if (corpusMatch) {
        let content: string;
        try {
          content = await fs.readFile(corpusMatch.path, 'utf8');
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          console.error(`Error reading ${corpusMatch.path}: ${e.message ?? String(err)}`);
          process.exit(1);
        }
        const installHint = corpusMatch.bundleKind && corpusMatch.bundleId
          ? `Run \`aiwg use ${corpusMatch.bundleId}\` to install this ${corpusMatch.bundleKind} into the workspace.`
          : 'Run `aiwg index build --graph framework` to refresh the artifact index.';
        const bindings = await showBindings(entries, {
          path: corpusMatch.path, type: corpusMatch.type, name: needle, title: needle,
        } as MetadataEntry, content, params, rule => fs.readFile(resolveMetadataPath(cwd, aiwgRoot, rule), 'utf8'));
        if (params.json) {
          console.log(JSON.stringify({
            ...bindings.fields,
            path: corpusMatch.path,
            type: corpusMatch.type,
            title: needle,
            kernel: false,
            uninstalled: true,
            hint: installHint,
            content,
          }, null, 2));
          return;
        }
        // Plain text mode: prepend a banner so consumers see the artifact is
        // corpus-only, then stream the body.
        const banner = [
          '<!-- AIWG: corpus-only artifact — not in the indexed workspace.',
          `     ${installHint}`,
          '     Origin: ' + corpusMatch.path,
          '-->',
          '',
        ].join('\n');
        process.stdout.write(banner);
        process.stdout.write(content);
        if (!content.endsWith('\n')) process.stdout.write('\n');
        if (bindings.text) process.stdout.write(bindings.text);
        return;
      }
    }
    console.error(`Error: no artifact found matching "${needle}".`);
    console.error('Try `aiwg discover "<phrase>"` to find the right name.');
    process.exit(1);
  }

  // Resolve relative framework-graph paths to absolute paths.
  // Kernel entries are anchored the same way as non-kernel framework entries
  // (#1230) — show reads the source corpus, not platform deploy mirrors.
  const resolvePath = (entry: MetadataEntry) => resourceSource === 'web'
    ? `raw/${normalizeIndexedPath(entry.path)}`
    : resolveMetadataPath(cwd, aiwgRoot, entry);

  if (matches.length > 1 && !params.first) {
    if (params.json) {
      console.log(JSON.stringify({
        ambiguous: true,
        name: needle,
        matches: matches.map(e => ({
          id: discoveryIdForEntry(e),
          path: resolvePath(e),
          type: e.type,
          name: e.name,
          title: e.title,
          kernel: e.kernel ?? false,
          provenance: {
            graph: (e as ProvenancedEntry).indexGraph ?? null,
            scope: (e as ProvenancedEntry).indexScope ?? null,
            ...(webRelease
              ? {
                  resource_source: 'web',
                  aiwg_selector: webRelease.selector,
                  aiwg_version: webRelease.version,
                  manifest_sha256: webRelease.manifestDigest,
                  manifest_url: webRelease.manifestUrl,
                }
              : {}),
          },
        })),
      }, null, 2));
    } else {
      console.error(`Ambiguous: "${needle}" matches ${matches.length} artifacts. Disambiguate with --type or pass the stable id:`);
      for (const e of matches) {
        console.error(`  ${e.type.padEnd(7)} ${discoveryIdForEntry(e)} ${e.title}`);
      }
      console.error('');
      console.error('Re-run with `--first` to pick the top match, `--type skill` to filter, or `aiwg show metadata <id>` for paths.');
    }
    process.exit(2);
  }

  const entry = matches[0];
  const filePath = resolvePath(entry);
  let content: string;
  if (resourceSource === 'web') {
    try {
      if (!webRelease) throw new Error('verified web release context is unavailable');
      const { logicalIdFromFirstPartyPath, resolveAiwgResourceBytes } = await import('../resources/resolver.js');
      const logicalId = logicalIdFromFirstPartyPath(entry.path);
      if (!logicalId) throw new Error(`indexed path is not a first-party AIWG resource: ${entry.path}`);
      const resolved = await resolveAiwgResourceBytes(logicalId, {
        source: 'web',
        frameworkRoot: aiwgRoot ?? cwd,
        webRelease,
        webReleaseOptions: params.webReleaseOptions,
        offline: params.offline,
      });
      content = resolved.bytes.toString('utf8');
    } catch (error) {
      console.error(`Error: AIWG web resource show failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      console.error(`Error reading ${filePath}: ${e.message ?? String(err)}`);
      process.exit(1);
    }
  }

  const bindings = await showBindings(entries, entry, content, params, async rule => {
    if (resourceSource === 'local') return fs.readFile(resolvePath(rule), 'utf8');
    const { logicalIdFromFirstPartyPath, resolveAiwgResourceBytes } = await import('../resources/resolver.js');
    const logicalId = logicalIdFromFirstPartyPath(rule.path);
    if (!logicalId || !webRelease) throw new Error(`Cannot resolve bound rule: ${rule.path}`);
    const resolved = await resolveAiwgResourceBytes(logicalId, {
      source: 'web', frameworkRoot: aiwgRoot ?? cwd, webRelease,
      webReleaseOptions: params.webReleaseOptions, offline: params.offline,
    });
    return resolved.bytes.toString('utf8');
  });

  if (params.json) {
    const providerModels = resourceSource === 'local'
      ? await loadProviderModelMetadata(cwd, aiwgRoot)
      : null;
    console.log(JSON.stringify({
      id: discoveryIdForEntry(entry),
      path: filePath,
      type: entry.type,
      name: entry.name,
      title: entry.title,
      kernel: entry.kernel ?? false,
      provenance: {
        graph: (entry as ProvenancedEntry).indexGraph ?? null,
        scope: (entry as ProvenancedEntry).indexScope ?? null,
        ...(webRelease
          ? {
              resource_source: 'web',
              aiwg_selector: webRelease.selector,
              aiwg_version: webRelease.version,
              manifest_sha256: webRelease.manifestDigest,
              manifest_url: webRelease.manifestUrl,
            }
          : {}),
      },
      // #1227 — surface script-bearing skills so callers can route to
      // `aiwg run skill <name>` instead of treating SKILL.md as
      // instructions for the agent to execute itself.
      ...(entry.script
        ? { executable: true, run_hint: buildRunHint(entry) }
        : {}),
      ...(providerModels ? { providerModels } : {}),
      ...bindings.fields,
      content,
    }, null, 2));
    return;
  }

  // Stream the authored content first; append binding guidance only when present.
  // #1227 — for script-bearing skills, prepend a one-line banner so
  // agents reading the body immediately see the skill is executable.
  if (entry.script) {
    const hint = buildRunHint(entry);
    process.stdout.write(`<!-- AIWG: executable skill — run via: ${hint} -->\n`);
  }
  process.stdout.write(content);
  if (!content.endsWith('\n')) process.stdout.write('\n');
  if (bindings.text) process.stdout.write(bindings.text);
}

export async function showMetadata(
  cwd: string,
  params: ShowMetadataParams,
): Promise<void> {
  loadGlobalGraphConfigs();
  const types = params.typeFilter && params.typeFilter.length > 0
    ? params.typeFilter
    : [...OPERATIONAL_SHOW_TYPES];
  const {
    entries,
    aiwgRoot,
    resourceSource,
    webRelease,
    sourcePaths,
  } = await loadShowEntries(cwd, params);

  if (entries.length === 0 && params.backend !== 'fortemi-core') {
    console.error('Error: No artifact index found.');
    console.error('Run `aiwg index build --graph framework` (or `aiwg use <framework>`) first.');
    process.exit(1);
  }

  const needle = params.name.trim();
  const matches = findShowMatches(entries, types, needle);

  if (matches.length === 0) {
    console.error(`Error: no artifact metadata found matching "${needle}".`);
    console.error('Try `aiwg discover "<phrase>" --json` to find the stable id.');
    process.exit(1);
  }

  const resolvePath = (entry: MetadataEntry) => resourceSource === 'web'
    ? `raw/${normalizeIndexedPath(entry.path)}`
    : resolveMetadataPath(cwd, aiwgRoot, entry);

  if (matches.length > 1 && !params.first) {
    if (params.json) {
      console.log(JSON.stringify({
        ambiguous: true,
        name: needle,
        matches: matches.map((entry) => ({
          id: discoveryIdForEntry(entry),
          type: entry.type,
          name: entry.name,
          title: entry.title,
          provenance: {
            graph: (entry as ProvenancedEntry).indexGraph ?? null,
            scope: (entry as ProvenancedEntry).indexScope ?? null,
            ...(webRelease
              ? {
                  resource_source: 'web',
                  aiwg_selector: webRelease.selector,
                  aiwg_version: webRelease.version,
                  manifest_sha256: webRelease.manifestDigest,
                  manifest_url: webRelease.manifestUrl,
                }
              : {}),
          },
        })),
      }, null, 2));
    } else {
      console.error(`Ambiguous: "${needle}" matches ${matches.length} artifacts. Disambiguate with the stable id:`);
      for (const entry of matches) {
        console.error(`  ${entry.type.padEnd(7)} ${discoveryIdForEntry(entry)} ${entry.title}`);
      }
    }
    process.exit(2);
  }

  const entry = matches[0];
  const absolutePath = resolvePath(entry);
  const backend = params.backend ?? DEFAULT_ARTIFACT_SEARCH_BACKEND;
  const record = backend === 'fortemi-core'
    ? await fortemiRecordForEntry(cwd, entry, sourcePaths)
    : null;
  const payload = {
    id: discoveryIdForEntry(entry),
    backend,
    type: entry.type,
    name: entry.name,
    title: entry.title,
    paths: {
      absolute: absolutePath,
      indexed: entry.path,
      repo_relative: record?.source.repo_relative_path ?? entry.path,
      locator: record?.source.locator ?? entry.name ?? entry.title,
    },
    provenance: {
      graph: (entry as ProvenancedEntry).indexGraph ?? null,
      scope: (entry as ProvenancedEntry).indexScope ?? null,
      ...(webRelease
        ? {
            resource_source: 'web',
            aiwg_selector: webRelease.selector,
            aiwg_version: webRelease.version,
            manifest_sha256: webRelease.manifestDigest,
            manifest_url: webRelease.manifestUrl,
          }
        : {}),
    },
    metadata: record ?? entry,
    providerModels: resourceSource === 'local'
      ? await loadProviderModelMetadata(cwd, aiwgRoot)
      : null,
  };

  if (params.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`${payload.type} ${payload.title}`);
  console.log(`  id: ${payload.id}`);
  if (payload.name) console.log(`  name: ${payload.name}`);
  console.log(`  graph: ${payload.provenance.graph ?? 'unknown'}`);
  console.log(`  scope: ${payload.provenance.scope ?? 'unknown'}`);
  console.log(`  path: ${payload.paths.absolute}`);
  console.log(`  indexed_path: ${payload.paths.indexed}`);
  if (payload.providerModels) {
    console.log('  provider_models:');
    for (const [provider, hints] of Object.entries(payload.providerModels.providers)) {
      console.log(`    ${provider}:`);
      for (const hint of hints) {
        console.log(`      ${hint.role}: ${hint.model} (wrapper: ${hint.wrapper}, status: ${hint.status})`);
      }
    }
  }
  console.log('');
  console.log(JSON.stringify(payload.metadata, null, 2));
}

function isTopLevelPersonaAgentPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\]agents[/\\]personas[/\\][^/\\]+\.md$/.test(entryPath);
}

function isCanonicalBundleAgentPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\](?:frameworks|addons|extensions|plugins)[/\\][^/\\]+[/\\]agents[/\\][^/\\]+\.md$/.test(entryPath);
}

function isCanonicalSourceAgentPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\](?:frameworks|addons|extensions)[/\\][^/\\]+[/\\]agents[/\\][^/\\]+\.md$/.test(entryPath);
}

function isFrameworkSourceSkillPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\]frameworks[/\\][^/\\]+[/\\]skills[/\\][^/\\]+[/\\]SKILL\.md$/.test(entryPath);
}

function isCanonicalSourceSkillPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\](?:frameworks|addons|extensions)[/\\][^/\\]+[/\\]skills[/\\][^/\\]+[/\\]SKILL\.md$/.test(entryPath);
}

function uniqueEntriesByPath(entries: MetadataEntry[]): MetadataEntry[] {
  const seen = new Set<string>();
  const unique: MetadataEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    unique.push(entry);
  }
  return unique;
}
