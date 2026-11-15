/**
 * Drift audit — type definitions.
 *
 * @implements #1208
 * @see docs/architecture/index-and-manifest-loading.md
 */

export interface DriftThresholds {
  /** Keyword-overlap ratio below which two summaries are considered to have drifted. */
  keywordOverlapMin:    number;       // default 0.70
  /** Any disappeared/added declared symbol counts as drift. */
  symbolChangeCritical: boolean;      // default true
  /** Maximum age in days before an entry is flagged stale even when content unchanged. */
  freshnessMaxDays:     number;       // default 90
}

export const DEFAULT_THRESHOLDS: DriftThresholds = {
  keywordOverlapMin:    0.70,
  symbolChangeCritical: true,
  freshnessMaxDays:     90,
};

export type DriftStatus = 'ok' | 'drift' | 'stale-age' | 'skip';

export interface DriftRow {
  artifactId:     string;
  status:         DriftStatus;
  reason:         string;
  storedHash:     string | null;
  currentHash:    string | null;
  ageDays:        number | null;
  /** When status === 'drift', a one-line remediation pointer. */
  remediation?:   string;
  /** Diffs surfaced to the operator when drift detected. */
  symbolDelta?:   { added: string[]; removed: string[] };
  overlap?:       number;
}

export interface AuditReport {
  total:         number;
  ok:            number;
  drift:         number;
  staleAge:      number;
  skipped:       number;
  thresholds:    DriftThresholds;
  rows:          DriftRow[];
}
