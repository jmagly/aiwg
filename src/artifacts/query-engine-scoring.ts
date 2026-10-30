// Tokenize discovery phrases and score metadata matches with lexical diagnostics.
import { diagnoseFacetActivations } from './discover-facets.js';
import type { MetadataEntry } from './types.js';

export function containsTokenSequence(haystack: string[], needle: string[]): boolean {
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
export const SCORE_STOPWORDS = new Set([
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
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !SCORE_STOPWORDS.has(t))
    .map(token => token.length > 4 && token.endsWith('s') && !token.endsWith('ss')
      ? token.slice(0, -1)
      : token);
}


export function matchedFieldTokens(queryTokens: string[], field: string): string[] {
  const fieldTokens = new Set(tokenize(field));
  return queryTokens.filter(token => fieldTokens.has(token));
}


export function fieldContainsQuery(field: string, queryTokens: string[]): boolean {
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
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[-_\s]+/g, ' ').trim();
}


export function damerauLevenshteinAtMostOne(a: string, b: string): boolean {
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


export function nearNameMatch(query: string, name: string): boolean {
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


export interface LexicalMatchDiagnostic {
  field: 'name' | 'trigger' | 'capability' | 'title' | 'tag' | 'search_terms' | 'kind' | 'source_type' | 'summary' | 'path' | 'type';
  match: 'exact' | 'near-name' | 'contained-phrase' | 'token-overlap';
  value?: string;
  contribution: number;
  matched_tokens?: string[];
  query_token_coverage?: number;
}


export interface LexicalScoreDiagnostic {
  content_tokens: string[];
  raw_score: number;
  score: number;
  score_cap_applied: boolean;
  matches: LexicalMatchDiagnostic[];
}


export interface DetailedScore {
  score: number;
  diagnostic: LexicalScoreDiagnostic;
}


export function scoreEntryDetailed(
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


export function scoreEntry(entry: MetadataEntry, text: string, opts: { relaxOverlap?: boolean } = {}): number {
  return scoreEntryDetailed(entry, text, opts).score;
}
