/**
 * Canonical extraction prompt — single source of truth for semantic enrichment.
 *
 * The prompt instructs the dispatched RLM agent to read one artifact and
 * return JSON matching the SemanticFields schema. Cache invalidation depends
 * on this prompt being stable; changing it busts the cache for every
 * previously-enriched artifact.
 *
 * @implements #1204
 * @see docs/architecture/index-and-manifest-loading.md
 */

export const ENRICHMENT_PROMPT = `Read the artifact below. Return JSON matching this schema exactly:

{
  "summary":          "<one paragraph, max 500 chars>",
  "declared_symbols": ["<exported function / type / entity / class names>"],
  "citations":        ["<REF-XXX | path/to/file.md | @-mention target>"],
  "inferred_tags":    ["<topic keywords from the content>"],
  "open_questions":   ["<contradictions or open questions stated in the artifact>"]
}

Be conservative: empty arrays are fine when nothing applies. Do not fabricate citations or symbols not present in the source. Do not include the artifact's title or path in the summary — write the summary as if the reader already knows what file they are reading.

Output ONLY the JSON object, no surrounding prose.`;

/** Validate raw RLM output against the SemanticFields shape. Returns issues, empty if valid. */
export function validateEnrichmentOutput(raw: unknown): string[] {
  const issues: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return ['enrichment output must be a JSON object'];
  }
  const r = raw as Record<string, unknown>;

  if (typeof r['summary'] !== 'string') issues.push('summary must be a string');
  else if (r['summary'].length > 1000) issues.push('summary exceeds 1000 chars');

  for (const arrField of ['declared_symbols', 'citations', 'inferred_tags', 'open_questions']) {
    const v = r[arrField];
    if (!Array.isArray(v)) {
      issues.push(`${arrField} must be a string array`);
    } else if (v.some((item) => typeof item !== 'string')) {
      issues.push(`${arrField} must contain only strings`);
    }
  }

  return issues;
}
