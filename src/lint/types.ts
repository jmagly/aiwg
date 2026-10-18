/**
 * Lint System Types
 *
 * Defines interfaces for lint rules, rulesets, results, and configuration.
 * Rules are declarative YAML; the runner evaluates them against target files.
 *
 * @issue #810
 */

/**
 * Severity levels for lint rules and diagnostics
 */
export type LintSeverity = 'error' | 'warn' | 'info';

/**
 * Output format for lint results
 */
export type LintOutputFormat = 'full' | 'summary' | 'json';

/**
 * A single lint check within a rule
 */
export interface LintCheck {
  /** Check type */
  type:
    | 'rule-activation'
    | 'frontmatter-required'
    | 'frontmatter-format'
    | 'reference-resolves'
    | 'pattern-match'
    | 'file-exists'
    | 'id-unique'
    | 'id-format'
    | 'cross-ref-bidirectional'
    | 'unregistered-uncertainty';

  /** Fields to check (for frontmatter checks) */
  fields?: string[];

  /** Specific field name (for single-field checks) */
  field?: string;

  /**
   * Regex pattern (for format/pattern checks). For id-format with a field,
   * the first capture group (or the full match) must equal the present field.
   */
  pattern?: string;

  /** Reference pattern to extract and resolve (for reference checks) */
  referencePattern?: string;

  /** Base directory for resolving references */
  basePath?: string;

  /**
   * Phrases marking an identifier as deliberately absent, for
   * `reference-resolves`. A mention beside one of these is documentation of a
   * gap, not a dangling reference (#2555). Defaults to the corpus set.
   */
  absenceMarkers?: string[];

  /** Section name that should contain cross-references */
  section?: string;

  /**
   * Phrases that state an unperformed check, for `unregistered-uncertainty`.
   * Matched case-insensitively. Defaults to the induction set when omitted.
   */
  uncertaintyPatterns?: string[];

  /**
   * Things the agent could have checked (OpenReview, camera-ready, PDF, census,
   * code URL, venue...). Required on the same line as the uncertainty phrase, so
   * a paper's own unverified claim is not mistaken for a skipped check.
   */
  verificationTargets?: string[];

  /**
   * Patterns that discharge an uncertainty by naming a specific obstacle or
   * recording an outcome (HTTP status, credential requirement, rate limit,
   * paywall, or a declared check with evidence). Defaults to a general set.
   */
  obstaclePatterns?: string[];

  /**
   * Maximum character distance between the uncertainty phrase and its
   * verification target. Markdown keeps whole paragraphs on one line, so
   * same-line co-occurrence alone relates unrelated clauses. Default 80.
   */
  targetProximity?: number;

  /**
   * How many lines after an uncertainty may carry its obstacle. Default 2 —
   * the obstacle normally sits in the same sentence or the next one.
   */
  obstacleWithinLines?: number;
}

/**
 * A declarative lint rule definition (loaded from YAML)
 */
export interface LintRule {
  /** Rule identifier (e.g., 'research/ref-frontmatter') */
  id: string;

  /** Human-readable rule name */
  name: string;

  /** Description of what the rule checks */
  description: string;

  /** Severity: error, warn, or info */
  severity: LintSeverity;

  /** File targeting — which files this rule applies to */
  appliesTo: {
    /** Glob pattern relative to lint target */
    glob: string;
  };

  /** Checks to perform on matching files */
  checks: LintCheck[];
}

/**
 * A ruleset definition (loaded from ruleset.yaml)
 */
export interface LintRuleset {
  /** Ruleset identifier (e.g., 'research') */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description */
  description: string;

  /** Framework that owns this ruleset */
  framework: string;

  /** Version */
  version: string;

  /** Individual rules in this ruleset */
  rules: LintRule[];
}

/**
 * A single lint diagnostic (violation or info)
 */
export interface LintDiagnostic {
  /** Rule that produced this diagnostic */
  ruleId: string;

  /** Rule name */
  ruleName: string;

  /** Severity */
  severity: LintSeverity;

  /** File path (relative to target) */
  file: string;

  /** Human-readable message */
  message: string;

  /** Line number (if applicable) */
  line?: number;

  /** Suggested fix (if available) */
  fix?: string;
}

/**
 * Result of a lint run
 */
export interface LintResult {
  /** Target path that was linted */
  target: string;

  /** Rulesets that were applied */
  rulesets: string[];

  /** All diagnostics */
  diagnostics: LintDiagnostic[];

  /** Target-relative files selected by each rule, including empty selections. */
  ruleCoverage: Record<string, string[]>;

  /** Complete assembled startup cost, when a deployment plan is supplied. */
  inlineBudget?: import('../rules/inline-budget.mjs').InlineBudgetReport;

  /** Summary counts */
  summary: {
    filesChecked: number;
    errors: number;
    warnings: number;
    infos: number;
    passed: boolean;
    /** Rules in the selected rulesets (#2555). */
    rulesSelected: number;
    /** Rules that selected at least one file in this target (#2555). */
    rulesApplied: number;
    /** Rule ids whose glob matched no file in this target (#2555). */
    inapplicableRules: string[];
    /** Explanation when no files or rules were covered. */
    coverageMessage?: string;
  };

  /** Timestamp */
  timestamp: string;
}

/**
 * CLI options for the lint command
 */
export interface LintOptions {
  /** JSON planned startup set: { provider, files: [{ path, bytes | content }] }. */
  startupPlan?: string;
  /** Lint files git ignores too (default: false — generated trees are skipped, #2555). */
  respectGitignore?: boolean;

  /** Target path to lint */
  target: string;

  /** Explicit ruleset(s) to apply */
  rulesets?: string[];

  /** Recursive directory scan */
  recursive?: boolean;

  /** Output format */
  format?: LintOutputFormat;

  /** CI mode — exit code reflects pass/fail */
  ci?: boolean;

  /** Permit zero files or zero applied rules in CI mode. */
  allowEmpty?: boolean;

  /** Fail threshold for CI mode */
  failOn?: LintSeverity;

  /** Dry run — show what would be checked */
  dryRun?: boolean;

  /** List available rulesets */
  listRulesets?: boolean;

  /** List rules in a specific ruleset */
  listRules?: string;
}
