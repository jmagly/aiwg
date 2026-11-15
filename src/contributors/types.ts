/**
 * Contributor Discovery Type Definitions
 *
 * Cross-framework contributor convention per ADR-023. Frameworks, addons,
 * and extensions opt into cross-framework commands (project-status,
 * best-practices-audit, ...) by shipping `<framework>/<kind>/contributor.md`
 * files. The aggregator discovers, validates, and runs detection against them.
 *
 * @architecture @docs/contributing/contributor-quickstart.md
 * @issue #938
 */

/**
 * Discriminator for contributor kind. `string` keeps the union open so future
 * consumers (security, compliance, performance, ...) can register new kinds
 * without modifying this union.
 */
export type ContributorKind = 'status' | 'research' | string;

/**
 * Declarative detection spec. Determines whether a contributor's framework
 * is *in use* on the current project. No code execution by design — globs
 * and counts only. See ADR-023 §Alternative C for the rationale.
 */
export interface DetectionSpec {
  /** Glob patterns relative to the project root. Required, at least one. */
  glob: string[];
  /** Minimum number of matching files to count as in-use. Default: 1. */
  minCount?: number;
  /** Reserved for future regex-against-content checks. Currently unused. */
  conditions?: Record<string, string>;
}

/**
 * Common frontmatter shared by every contributor kind. Per-kind frontmatter
 * extends this in the kind's zod schema.
 */
export interface ContributorBase {
  kind: ContributorKind;
  domain: string;
  description: string;
  detect: DetectionSpec;
}

/**
 * Where a discovered contributor came from. Every record carries this so
 * reports can show whether a finding is framework-shipped or project-local.
 */
export interface ContributorOrigin {
  /** Framework / addon / extension id, or 'project-local'. */
  origin: string;
  /** Absolute path to the contributor file on disk. */
  path: string;
}

/**
 * A contributor that passed parsing, validation, and detection. The body
 * (post-frontmatter markdown) is preserved so the consumer can render it.
 */
export interface ContributorRecord<T extends ContributorBase = ContributorBase> extends ContributorOrigin {
  data: T;
  body: string;
}

/**
 * Reasons a contributor was skipped. Surfaces in warnings and structured
 * results so the consumer can show "discovered N, skipped M".
 */
export type SkipReason = 'parse-error' | 'schema-violation' | 'detection-error' | 'detection-no-match';

export interface SkippedContributor extends ContributorOrigin {
  reason: SkipReason;
  message: string;
}

/**
 * Result of a discovery pass. Skips are not failures — the aggregator
 * keeps going and reports both kept and skipped contributors.
 */
export interface DiscoveryResult<T extends ContributorBase = ContributorBase> {
  kind: ContributorKind;
  records: ContributorRecord<T>[];
  skipped: SkippedContributor[];
}
