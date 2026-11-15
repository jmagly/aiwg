/**
 * Semantic enrichment — type definitions.
 *
 * Stored as sidecar files at `.aiwg/index/semantic/<sanitized-id>.json`
 * so the existing index schema is not mutated. Surfaces additively from
 * `aiwg index query` when enrichment is present.
 *
 * @implements #1204
 * @see docs/architecture/index-and-manifest-loading.md
 */

export interface SemanticFields {
  /** One-paragraph summary, ≤500 chars. */
  summary: string;

  /** Exported function/type/entity names declared by the artifact. */
  declaredSymbols: string[];

  /** REF-XXX, paths, @-mentions referenced by the artifact. */
  citations: string[];

  /** Topic keywords inferred from content (vs frontmatter tags). */
  inferredTags: string[];

  /** Contradictions or open questions stated in the artifact itself. */
  openQuestions: string[];

  /** ISO8601 enrichment timestamp. */
  enrichedAt: string;

  /** Producer that generated this entry (rlm-batch, rlm-query, manual). */
  enrichedBy: string;

  /** sha256 of artifact content at enrichment time. */
  enrichedHash: string;
}

/** Compact summary for `enrich --list`. */
export interface EnrichmentSummary {
  artifactId:    string;
  enrichedAt:    string;
  enrichedHash:  string;
  symbolCount:   number;
  citationCount: number;
  ageDays:       number;
  isStale:       boolean;     // current artifact hash !== enriched_hash
}

/** Enrichment dispatch plan emitted by the CLI for an agent. */
export interface EnrichmentPlan {
  artifactId:    string;
  contentHash:   string;
  prompt:        string;
  outputPath:    string;
  cacheKey:      string;
}
