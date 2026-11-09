// Calibrate verbose-query evidence around the leading intent and weighted token coverage.
function namedSubject(text: string, tokenize: (text: string) => string[]): string | undefined {
  // A command/skill named in the request is more specific than authoring vocabulary.
  // Limit this to the leading clause so examples and trailing context cannot redirect it.
  const leading = text.split(/[.!?;:\n]/, 1)[0];
  const explicit = leading.match(/\b(?:command|skill)\s+(?:called|named)\s+[`"']?([a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)\b/i);
  const before = leading.match(/\b([a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)[`"']?\s+(?:command|skill)\b/i);
  const after = leading.match(/\b(?:command|skill)\s+(?:called\s+|named\s+)?[`"']?([a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)\b/i);
  return [explicit?.[1], before?.[1], after?.[1]].find(value => value && tokenize(value).length)
    ?.toLowerCase().replace(/[-_]+/g, ' ');
}

export function verboseQueryProfile(text: string, tokens: string[], tokenize: (text: string) => string[]) {
  const subject = namedSubject(text, tokenize);
  const subjectTokens = new Set(subject ? tokenize(subject) : []);
  const named = subjectTokens.size > 0;
  // Short capability phrases retain their established lexical scores unless they name a subject.
  if (tokens.length <= 8 && !named) return undefined;
  const prose = text.replace(/(`+)[\s\S]*?\1/g, ' ');
  const proseTokens = new Set(tokenize(prose));
  const leading = named ? subjectTokens : new Set(tokenize(prose.split(/[.!?;:\n]/, 1)[0]).slice(0, 8));
  const contextCount = tokens.filter(token => (named || proseTokens.has(token)) && !leading.has(token)).length;
  // Context gets at most a quarter of the leading clause's total weight.
  // Code-only words carry still less signal, but remain discoverable.
  const contextWeight = Math.min(0.25, Math.max(1, leading.size) / (4 * Math.max(1, contextCount)));
  const weights = new Map(tokens.map(token => [token,
    leading.has(token) ? 1 : proseTokens.has(token) ? contextWeight : contextWeight * 0.2]));
  const mass = (hits: string[]) => hits.reduce((sum, token) => sum + (weights.get(token) ?? 0), 0);
  const total = mass(tokens);
  return {
    names: (name: string) => named && name.toLowerCase().replace(/[-_\s]+/g, ' ').trim() === subject,
    weight: (hits: string[]) => mass(hits) / Math.max(1, hits.length),
    coverage: (matches: { matched_tokens?: string[] }[]) => {
      const hits = [...new Set(matches.flatMap(match => match.matched_tokens ?? tokens))];
      return total > 0 ? mass(hits) / total : 0;
    },
  };
}
