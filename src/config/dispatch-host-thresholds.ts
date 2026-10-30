// Types for the existing dispatch host threshold resolver.
/**
 * Live host-resource thresholds gating worker dispatch and heavy verification
 * runs (FR-OG-107, #2954). The worker cap defaults to 5 and can be raised explicitly.
 * Other defaults mirror the
 * titan oomd incident prototype (`resource-gate.sh`): load above core count,
 * single-digit free-memory headroom, and sustained memory pressure all queued
 * work instead of launching into them.
 */
export interface DispatchHostThresholds {
  /** Minimum available memory (MemAvailable) in GiB. Default 8. */
  min_avail_mem_gb?: number;
  /** Maximum 1-minute load relative to core count. Default 1.0. */
  max_load_ratio?: number;
  /** Maximum memory PSI `some avg10` (percent). Default 30. */
  max_mem_psi_avg10?: number;
  /** Maximum memory PSI `some avg60` (percent). Default 10. */
  max_mem_psi_avg60?: number;
  /** Minimum free disk (bavail) in GiB on the evidence/worktree filesystem. Default 2. */
  min_free_disk_gb?: number;
  /**
   * Maximum running workers before dispatch queues. Default 5; configured layers
   * replace the default and combine with one another by MIN (see #3744).
   */
  max_workers?: number;
  /** Maximum host snapshot age in seconds. Default 300; layers can only tighten. */
  max_snapshot_age_seconds?: number;
}

