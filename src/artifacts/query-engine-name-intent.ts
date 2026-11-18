// Recognize complete compound skill names inside a leading natural-language request.
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
