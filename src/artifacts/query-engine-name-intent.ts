// Recognize complete compound skill names inside a leading natural-language request.
import type { MetadataEntry } from './types.js';
import type { LexicalMatchDiagnostic } from './query-engine-scoring.js';

export function skillNameIntent(name: string, text: string, tokenize: (value: string) => string[]): string[] {
  const identityTokens = (value: string) => [...new Set([
    ...tokenize(value), ...(/\baiwg\b/i.test(value) ? ['aiwg'] : []),
  ])];
  const nameTokens = identityTokens(name);
  // Single generic words are too ambiguous to bypass query coverage scoring.
  if (nameTokens.length < 2) return [];
  const leading = text.replace(/(`+)[\s\S]*?\1/g, ' ').split(/[.!?;:\n]/, 1)[0];
  const queryTokens = identityTokens(leading);
  const matches = nameTokens.map(token => queryTokens.find(query => token === query
    // An agent noun may name the action: post-scorer -> score ... post.
    || (token.length >= 6 && token.endsWith('er')
      && (query === token.slice(0, -1) || query === token.slice(0, -2)))));
  return matches.every((token): token is string => token !== undefined) ? matches : [];
}

/** Combine explicit product identity with bounded metadata evidence, even in a long request. */
export function productNameEvidence(
  entry: MetadataEntry, text: string, tokenize: (value: string) => string[],
  near: (a: string, b: string) => boolean,
): LexicalMatchDiagnostic | undefined {
  if (!['skill', 'agent'].includes(entry.type) || !/^aiwg[-_]/i.test(entry.name ?? '')) return;
  const leading = text.replace(/(`+)[\s\S]*?\1/g, ' ').split(/[.!?;:\n]/, 1)[0];
  if (!/\baiwg\b/i.test(leading)) return;
  const query = [...new Set(tokenize(leading))];
  const vocabulary = [...new Set(tokenize([
    entry.title, entry.capability ?? '', ...(entry.triggers ?? []),
  ].join(' ')))].filter(token => !['use', 'make', 'as'].includes(token));
  const hits = new Set<string>();
  const targets = new Set<string>();
  const match = (word: string) => vocabulary.find(target => target === word)
    ?? vocabulary.find(target => word.length >= 5 && target.length >= 5 && near(word, target));
  for (let i = 0; i < query.length; i++) {
    const target = match(query[i]);
    if (target) { hits.add(query[i]); targets.add(target); }
    // Recover a split compound or a punctuation typo (work space, deploy,ent).
    const compound = i + 1 < query.length ? match(query[i] + query[i + 1]) : undefined;
    if (compound) { hits.add(query[i]); hits.add(query[i + 1]); targets.add(compound); }
  }
  if (!hits.size) return;
  return {
    field: 'capability', match: 'token-overlap', value: entry.capability,
    matched_tokens: [...hits], query_token_coverage: hits.size / Math.max(1, tokenize(text).length),
    // Product identity and capability jointly outweigh incidental generic hits.
    // Keep exact names, complete triggers and named subjects stronger.
    contribution: 0.6 + Math.min(0.24, targets.size * 0.06),
  };
}
