// Calibrate verbose-query evidence around the leading intent and weighted token coverage.
export function verboseQueryProfile(text: string, tokens: string[], tokenize: (text: string) => string[]) {
  // Short capability phrases retain their established lexical scores.
  if (tokens.length <= 8) return undefined;
  const prose = text.replace(/(`+)[\s\S]*?\1/g, ' ');
  const proseTokens = new Set(tokenize(prose));
  const leading = new Set(tokenize(prose.split(/[.!?;:\n]/, 1)[0]).slice(0, 8));
  const contextCount = tokens.filter(token => proseTokens.has(token) && !leading.has(token)).length;
  // Context gets at most a quarter of the leading clause's total weight.
  // Code-only words carry still less signal, but remain discoverable.
  const contextWeight = Math.min(0.25, Math.max(1, leading.size) / (4 * Math.max(1, contextCount)));
  const weights = new Map(tokens.map(token => [token,
    leading.has(token) ? 1 : proseTokens.has(token) ? contextWeight : contextWeight * 0.2]));
  const mass = (hits: string[]) => hits.reduce((sum, token) => sum + (weights.get(token) ?? 0), 0);
  const total = mass(tokens);
  return {
    weight: (hits: string[]) => mass(hits) / Math.max(1, hits.length),
    coverage: (matches: { matched_tokens?: string[] }[]) => {
      const hits = [...new Set(matches.flatMap(match => match.matched_tokens ?? tokens))];
      return total > 0 ? mass(hits) / total : 0;
    },
  };
}
