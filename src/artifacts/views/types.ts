/**
 * Materialized index views — type definitions.
 *
 * @implements #1207
 * @see docs/architecture/index-and-manifest-loading.md
 */

export type AggregateStrategy =
  | 'concat'
  | 'summarize'
  | 'filter-true'
  | 'filter-false'
  | 'json-merge';

export type Producer = 'rlm-batch' | 'rlm-query';

export type RefreshSchedule = 'never' | 'daily' | 'weekly' | 'monthly';

/** Mutually exclusive input source for a view. */
export interface ViewInputs {
  glob?:        string;
  query?:       string;
  neighborsOf?: { id: string; depth: number; direction: 'in' | 'out' | 'both'; graph?: string };
}

export interface ViewRefresh {
  onArtifactChange: boolean;
  schedule:         RefreshSchedule;
  manualOnly:       boolean;
}

/** A view definition as authored in `.aiwg/index/views/<name>.yaml`. */
export interface ViewDefinition {
  name:         string;
  description?: string;
  producer:     Producer;
  inputs:       ViewInputs;
  prompt:       string;
  aggregate:    AggregateStrategy;
  refresh:      ViewRefresh;
  outputFormat: 'json' | 'markdown' | 'text';
}

/** Result metadata persisted alongside a view's results. */
export interface ViewResultMeta {
  name:           string;
  builtAt:        string;       // ISO8601
  builtBy:        string;       // 'rlm-batch' | 'cli' | 'manual'
  inputCount:     number;
  cacheHits:      number;
  cacheMisses:    number;
  durationMs:     number;
  inputHashes:    string[];     // for change detection
}

/** A materialized view's stored result. */
export interface ViewResult {
  name:    string;
  result:  unknown;             // shape determined by aggregate strategy
  meta:    ViewResultMeta;
}

/** Compact summary for `views list`. */
export interface ViewSummary {
  name:        string;
  producer:    Producer;
  aggregate:   AggregateStrategy;
  hasResults:  boolean;
  builtAt:     string | null;
  ageDays:     number | null;
  staleReason: 'never-built' | 'fresh' | 'stale-schedule' | 'stale-inputs' | null;
}

/** Build dispatch plan emitted by the CLI for an agent to act on. */
export interface ViewBuildPlan {
  name:        string;
  producer:    Producer;
  inputs:      ViewInputs;
  prompt:      string;
  aggregate:   AggregateStrategy;
  cacheKey:    string;          // sha256 of inputs+prompt+model+aggregate
  outputPath:  string;
  metaPath:    string;
}
