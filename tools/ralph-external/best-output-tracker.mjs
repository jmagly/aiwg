/**
 * Best Output Tracker for External Ralph Loop
 *
 * Tracks quality scores across iterations and selects best output
 * (not just final iteration) per REF-015 Self-Refine research.
 *
 * Research shows quality can fluctuate during iterative refinement,
 * with peak quality often occurring at iteration 2-3 before degrading.
 *
 * @implements @.aiwg/requirements/use-cases/UC-168-best-output-selection.md
 * @schema @agentic/code/addons/agent-loop/schemas/iteration-analytics.yaml
 * @research @.aiwg/research/findings/REF-015-self-refine.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'fs';
import { join, dirname } from 'path';

/**
 * @typedef {Object} QualityDimensions
 * @property {number} validation - Passes validation checks (0-1)
 * @property {number} completeness - All required sections present (0-1)
 * @property {number} correctness - Accurate information/behavior (0-1)
 * @property {number} readability - Clear, well-structured (0-1)
 * @property {number} efficiency - Appropriate length/complexity (0-1)
 */

/**
 * @typedef {Object} IterationRecord
 * @property {number} iteration_number - Iteration number
 * @property {string} timestamp - ISO timestamp
 * @property {number} quality_score - Overall quality score 0-100
 * @property {number|null} quality_delta - Change from previous iteration
 * @property {QualityDimensions} dimensions - Quality dimension scores
 * @property {number} tokens_used - Tokens consumed
 * @property {number} token_cost_usd - Cost in USD
 * @property {number} execution_time_ms - Duration in milliseconds
 * @property {string} verification_status - passed|failed|skipped|void
 * @property {string} snapshot_path - Path to artifact snapshot
 * @property {string[]} artifacts - Artifact file paths
 * @property {string[]} reflections - Self-reflection notes
 */

/**
 * @typedef {Object} SelectionCriteria
 * @property {string} mode - highest_quality|highest_quality_verified|most_recent_above_threshold
 * @property {number} threshold - Minimum quality threshold (0-100)
 * @property {boolean} require_verification - Only select verified iterations
 */

/**
 * @typedef {Object} SelectionResult
 * @property {number} selected_iteration - Selected iteration number
 * @property {number} quality_score - Quality score of selected iteration
 * @property {string} reason - Explanation of selection
 * @property {number} final_iteration - Final iteration number
 * @property {number} final_quality - Final iteration quality
 * @property {boolean} degradation_detected - Whether quality degraded
 */

/**
 * @typedef {Object} TrackingConfig
 * @property {string} storage_path - Base storage directory
 * @property {SelectionCriteria} selection - Selection criteria
 * @property {boolean} keep_all_iterations - Whether to preserve all snapshots
 * @property {Object} quality_weights - Dimension weights
 */

// Default quality dimension weights
const DEFAULT_WEIGHTS = {
  validation: 0.30,
  completeness: 0.25,
  correctness: 0.25,
  readability: 0.10,
  efficiency: 0.10,
};

// Default selection criteria
const DEFAULT_SELECTION = {
  mode: 'highest_quality_verified',
  threshold: 70,
  require_verification: true,
};

export class BestOutputTracker {
  /**
   * @param {string} loopId - Loop identifier
   * @param {Partial<TrackingConfig>} config - Configuration
   */
  constructor(loopId, config = {}) {
    this.loopId = loopId;
    this.config = {
      storage_path: config.storage_path || join(process.cwd(), '.aiwg', 'ralph', loopId),
      selection: { ...DEFAULT_SELECTION, ...(config.selection || {}) },
      keep_all_iterations: config.keep_all_iterations !== false,
      quality_weights: { ...DEFAULT_WEIGHTS, ...(config.quality_weights || {}) },
    };
    this.validateConfig();

    this.iterationsDir = join(this.config.storage_path, 'iterations');
    this.trackingFile = join(this.config.storage_path, 'best-output-tracking.json');

    /** @type {IterationRecord[]} */
    this.iterations = [];

    /** @type {number|null} */
    this.bestIterationNumber = null;

    // Initialize storage
    this.ensureStorageExists();

    // Load existing tracking if present
    this.load();
  }

  /**
   * Ensure storage directories exist
   */
  ensureStorageExists() {
    if (!existsSync(this.iterationsDir)) {
      mkdirSync(this.iterationsDir, { recursive: true });
    }
  }

  /**
   * Calculate overall quality score from dimensions
   * @param {QualityDimensions} dimensions
   * @returns {number} Score 0-100
   */
  calculateQualityScore(dimensions) {
    const names = ['validation', 'completeness', 'correctness', 'readability', 'efficiency'];
    for (const name of names) {
      const value = dimensions?.[name];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new RangeError(`Quality dimension ${name} must be a finite number between 0 and 1`);
      }
    }
    const weights = this.config.quality_weights;
    const weighted =
      dimensions.validation * weights.validation +
      dimensions.completeness * weights.completeness +
      dimensions.correctness * weights.correctness +
      dimensions.readability * weights.readability +
      dimensions.efficiency * weights.efficiency;

    return Math.round(weighted * 100);
  }

  /**
   * Record an iteration with quality metrics
   * @param {Object} params
   * @param {number} params.iteration_number - Iteration number
   * @param {QualityDimensions} params.dimensions - Quality dimensions
   * @param {string[]} params.artifacts - Artifact paths
   * @param {number} [params.tokens_used=0] - Tokens consumed
   * @param {number} [params.token_cost_usd=0] - Cost in USD
   * @param {number} [params.execution_time_ms=0] - Execution time
   * @param {string} [params.verification_status='skipped'] - Verification status
   * @param {string[]} [params.reflections=[]] - Self-reflection notes
   */
  recordIteration(params) {
    const quality_score = this.calculateQualityScore(params.dimensions);

    // Calculate delta from previous iteration
    let quality_delta = null;
    if (this.iterations.length > 0) {
      const previous = this.iterations[this.iterations.length - 1];
      quality_delta = quality_score - previous.quality_score;
    }

    // Create snapshot directory
    const snapshotDir = join(
      this.iterationsDir,
      `iteration-${String(params.iteration_number).padStart(3, '0')}`
    );
    mkdirSync(snapshotDir, { recursive: true });

    // Snapshot artifacts
    const snapshotArtifacts = [];
    for (const artifactPath of params.artifacts) {
      if (existsSync(artifactPath)) {
        const basename = artifactPath.split('/').pop();
        const destPath = join(snapshotDir, basename);
        cpSync(artifactPath, destPath, { recursive: true });
        snapshotArtifacts.push(destPath);
      }
    }

    // Create iteration record
    /** @type {IterationRecord} */
    const record = {
      iteration_number: params.iteration_number,
      timestamp: new Date().toISOString(),
      quality_score,
      quality_delta,
      dimensions: params.dimensions,
      tokens_used: params.tokens_used || 0,
      token_cost_usd: params.token_cost_usd || 0,
      execution_time_ms: params.execution_time_ms || 0,
      verification_status: params.verification_status || 'skipped',
      snapshot_path: snapshotDir,
      artifacts: snapshotArtifacts,
      reflections: params.reflections || [],
      // VOID iterations are excluded from selection unless a human accepted
      // them (#1776).
      eval_human_override: params.eval_human_override === true,
    };

    this.iterations.push(record);

    // Update best iteration
    this.updateBest(record);

    // Persist
    this.save();

    return record;
  }

  /**
   * Update running best iteration tracker
   * @param {IterationRecord} newRecord
   */
  updateBest(newRecord) {
    // A VOID iteration is never the running best unless a human accepted it (#1776).
    const isSelectable = (rec) =>
      rec.verification_status !== 'void' || rec.eval_human_override === true;
    if (!isSelectable(newRecord)) {
      return;
    }

    if (this.bestIterationNumber === null) {
      this.bestIterationNumber = newRecord.iteration_number;
      return;
    }

    const current = this.getBest();
    if (!current) {
      this.bestIterationNumber = newRecord.iteration_number;
      return;
    }

    // Compare by quality score
    if (newRecord.quality_score > current.quality_score) {
      this.bestIterationNumber = newRecord.iteration_number;
    }
  }

  /**
   * Get current best iteration record
   * @returns {IterationRecord|null}
   */
  getBest() {
    if (this.bestIterationNumber === null) {
      return null;
    }

    return this.iterations.find(
      (it) => it.iteration_number === this.bestIterationNumber
    ) || null;
  }

  /**
   * Select output based on configured criteria
   * @returns {SelectionResult}
   */
  selectOutput() {
    if (this.iterations.length === 0) {
      throw new Error('No iterations recorded');
    }

    const criteria = this.config.selection;
    const finalIteration = this.iterations[this.iterations.length - 1];

    // VOID iterations (an eval harness voided them — e.g. a lint violation)
    // are never valid best-output candidates unless a human override accepted
    // that specific iteration (#1776). This is the mechanical fence that stops
    // the optimizer from being rewarded for a metric-gaming iteration.
    const selectable = this.iterations.filter(
      (it) => it.verification_status !== 'void' || it.eval_human_override === true
    );
    if (selectable.length === 0) {
      throw new Error('No selectable iterations: all iterations are VOID without human override');
    }

    // Filter by threshold
    let candidates = selectable.filter(
      (it) => it.quality_score >= criteria.threshold
    );

    // Filter by verification if required
    if (criteria.require_verification) {
      candidates = candidates.filter(
        (it) => it.verification_status === 'passed'
      );
    }

    // If no candidates meet criteria, fall back to all non-VOID iterations
    // (never fall back to a VOID iteration).
    if (candidates.length === 0) {
      candidates = [...selectable];
    }

    let selected;
    let reason;

    switch (criteria.mode) {
      case 'highest_quality':
        // Select highest quality regardless of verification
        selected = candidates.reduce((best, current) =>
          current.quality_score > best.quality_score ? current : best
        );
        reason = `Highest quality score: ${selected.quality_score}%`;
        break;

      case 'highest_quality_verified':
        // Select highest quality among verified
        const verified = candidates.filter(
          (it) => it.verification_status === 'passed'
        );
        if (verified.length > 0) {
          selected = verified.reduce((best, current) =>
            current.quality_score > best.quality_score ? current : best
          );
          reason = `Highest verified quality: ${selected.quality_score}%`;
        } else {
          // Fall back to highest overall
          selected = candidates.reduce((best, current) =>
            current.quality_score > best.quality_score ? current : best
          );
          reason = `Highest quality (no verified iterations): ${selected.quality_score}%`;
        }
        break;

      case 'most_recent_above_threshold':
        // Select most recent iteration above threshold
        selected = candidates[candidates.length - 1];
        reason = `Most recent above threshold (${criteria.threshold}%): ${selected.quality_score}%`;
        break;

      default:
        // Default to highest quality
        selected = candidates.reduce((best, current) =>
          current.quality_score > best.quality_score ? current : best
        );
        reason = `Highest quality: ${selected.quality_score}%`;
    }

    // Detect degradation
    const degradation_detected =
      selected.iteration_number !== finalIteration.iteration_number &&
      selected.quality_score > finalIteration.quality_score;

    return {
      selected_iteration: selected.iteration_number,
      quality_score: selected.quality_score,
      reason,
      final_iteration: finalIteration.iteration_number,
      final_quality: finalIteration.quality_score,
      degradation_detected,
    };
  }

  /**
   * Generate selection report
   * @param {SelectionResult} selection - Selection result
   * @returns {string} Markdown report
   */
  generateSelectionReport(selection) {
    const lines = [];

    lines.push('# Output Selection Report');
    lines.push('');
    lines.push(`**Loop ID**: ${this.loopId}`);
    lines.push(`**Total Iterations**: ${this.iterations.length}`);
    lines.push(`**Selected Iteration**: ${selection.selected_iteration}`);
    lines.push('');

    // Summary table
    lines.push('## Summary');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Selected Iteration | ${selection.selected_iteration} |`);
    lines.push(`| Selected Quality | ${selection.quality_score}% |`);
    lines.push(`| Final Iteration | ${selection.final_iteration} |`);
    lines.push(`| Final Quality | ${selection.final_quality}% |`);
    lines.push(`| Degradation Detected | ${selection.degradation_detected ? 'Yes' : 'No'} |`);
    lines.push('');

    // Quality scores table
    lines.push('## Quality Scores');
    lines.push('');
    lines.push('| Iteration | Quality | Delta | Tokens | Cost | Verified |');
    lines.push('|-----------|---------|-------|--------|------|----------|');

    for (const iteration of this.iterations) {
      const marker = iteration.iteration_number === selection.selected_iteration ? ' ✓' : '';
      const delta = iteration.quality_delta !== null
        ? (iteration.quality_delta >= 0 ? '+' : '') + iteration.quality_delta.toFixed(1)
        : '-';
      const cost = iteration.token_cost_usd.toFixed(4);
      const verified = iteration.verification_status === 'passed' ? '✓' : '✗';

      lines.push(
        `| ${iteration.iteration_number}${marker} | ${iteration.quality_score}% | ${delta}% | ${iteration.tokens_used} | $${cost} | ${verified} |`
      );
    }
    lines.push('');

    // Selection rationale
    lines.push('## Selection Rationale');
    lines.push('');
    lines.push(`**Selected**: Iteration ${selection.selected_iteration}`);
    lines.push(`**Reason**: ${selection.reason}`);
    lines.push('');

    if (selection.degradation_detected) {
      lines.push('### Degradation Detected');
      lines.push('');
      lines.push(
        `Quality degraded from iteration ${selection.selected_iteration} ` +
        `(${selection.quality_score}%) to final iteration ${selection.final_iteration} ` +
        `(${selection.final_quality}%). Selected best output instead of final.`
      );
      lines.push('');
    }

    // Quality trajectory
    lines.push('## Quality Trajectory');
    lines.push('');
    lines.push('```');
    const maxScore = Math.max(...this.iterations.map((it) => it.quality_score));
    for (const iteration of this.iterations) {
      const barLength = Math.round((iteration.quality_score / maxScore) * 40);
      const bar = '█'.repeat(barLength);
      const marker = iteration.iteration_number === selection.selected_iteration ? ' ← SELECTED' : '';
      lines.push(`Iteration ${iteration.iteration_number}: ${bar} ${iteration.quality_score}%${marker}`);
    }
    lines.push('```');
    lines.push('');

    // Artifacts applied
    const selectedIteration = this.iterations.find(
      (it) => it.iteration_number === selection.selected_iteration
    );

    if (selectedIteration) {
      lines.push('## Artifacts Applied');
      lines.push('');
      for (const artifact of selectedIteration.artifacts) {
        lines.push(`- ${artifact}`);
      }
      lines.push('');
    }

    // Recommendations
    lines.push('## Recommendations');
    lines.push('');

    if (selection.degradation_detected) {
      const degradationAmount = selection.quality_score - selection.final_quality;
      lines.push(`- Quality degraded by ${degradationAmount}% in later iterations`);
      lines.push('- Consider setting max iterations to avoid over-refinement');
      lines.push(`- Optimal iteration count for this task: ~${selection.selected_iteration}`);
    } else if (selection.selected_iteration === selection.final_iteration) {
      lines.push('- Quality improved or remained stable throughout iterations');
      lines.push('- Final iteration selected as best output');
    } else {
      lines.push('- Selected iteration met criteria while final did not');
      lines.push('- Review verification requirements if appropriate');
    }

    lines.push('');

    return lines.join('\n');
  }

  /**
   * Get iteration by number
   * @param {number} iterationNumber
   * @returns {IterationRecord|null}
   */
  getIteration(iterationNumber) {
    return this.iterations.find(
      (it) => it.iteration_number === iterationNumber
    ) || null;
  }

  /**
   * Get all iterations
   * @returns {IterationRecord[]}
   */
  getAllIterations() {
    return [...this.iterations];
  }

  /**
   * Get quality trajectory
   * @returns {Array<{iteration: number, quality: number}>}
   */
  getQualityTrajectory() {
    return this.iterations.map((it) => ({
      iteration: it.iteration_number,
      quality: it.quality_score,
    }));
  }

  /**
   * Detect diminishing returns
   * @param {number} consecutiveThreshold - Number of low-delta iterations
   * @param {number} deltaThreshold - Delta threshold (0-100)
   * @returns {{detected: boolean, iteration: number|null}}
   */
  detectDiminishingReturns(consecutiveThreshold = 2, deltaThreshold = 5) {
    if (this.iterations.length < consecutiveThreshold + 1) {
      return { detected: false, iteration: null };
    }

    let consecutiveLow = 0;

    for (let i = 1; i < this.iterations.length; i++) {
      const delta = this.iterations[i].quality_delta;

      if (delta !== null && Math.abs(delta) < deltaThreshold) {
        consecutiveLow++;

        if (consecutiveLow >= consecutiveThreshold) {
          return {
            detected: true,
            iteration: this.iterations[i - consecutiveThreshold + 1].iteration_number,
          };
        }
      } else {
        consecutiveLow = 0;
      }
    }

    return { detected: false, iteration: null };
  }

  /**
   * Save tracking data to disk
   */
  save() {
    const data = {
      loop_id: this.loopId,
      config: this.config,
      iterations: this.iterations,
      best_iteration_number: this.bestIterationNumber,
      last_updated: new Date().toISOString(),
    };

    mkdirSync(dirname(this.trackingFile), { recursive: true });
    writeFileSync(this.trackingFile, JSON.stringify(data, null, 2));
  }

  /**
   * Load tracking data from disk
   */
  load() {
    if (!existsSync(this.trackingFile)) {
      return;
    }

    try {
      const content = readFileSync(this.trackingFile, 'utf8');
      const data = JSON.parse(content);

      this.iterations = data.iterations || [];
      this.bestIterationNumber = data.best_iteration_number || null;

      // Merge config (prefer constructor config over loaded)
      if (data.config) {
        this.config = {
          ...data.config,
          ...this.config, // Constructor config takes precedence
        };
      }
    } catch (error) {
      console.error('Failed to load tracking data:', error.message);
    }
  }

  /**
   * Clean up snapshots except selected
   * @param {number} selectedIteration - Iteration to keep
   */
  cleanupSnapshots(selectedIteration) {
    if (this.config.keep_all_iterations) {
      return; // Keep all by configuration
    }

    for (const iteration of this.iterations) {
      if (iteration.iteration_number !== selectedIteration) {
        const snapshotDir = iteration.snapshot_path;
        if (existsSync(snapshotDir)) {
          rmSync(snapshotDir, { recursive: true, force: true });
        }
      }
    }
  }

  /**
   * Export tracking data as CSV
   * @returns {string} CSV content
   */
  exportCSV() {
    const lines = [];

    // Header
    lines.push('iteration,timestamp,quality_score,quality_delta,tokens_used,cost_usd,execution_time_ms,verification_status');

    // Rows
    for (const iteration of this.iterations) {
      const delta = iteration.quality_delta !== null ? iteration.quality_delta : '';
      lines.push(
        `${iteration.iteration_number},` +
        `${iteration.timestamp},` +
        `${iteration.quality_score},` +
        `${delta},` +
        `${iteration.tokens_used},` +
        `${iteration.token_cost_usd},` +
        `${iteration.execution_time_ms},` +
        `${iteration.verification_status}`
      );
    }

    return lines.join('\n');
  }

  /**
   * Get summary statistics
   * @returns {Object}
   */
  getSummary() {
    if (this.iterations.length === 0) {
      return {
        total_iterations: 0,
        average_quality: 0,
        best_quality: 0,
        worst_quality: 0,
        total_tokens: 0,
        total_cost_usd: 0,
        total_time_ms: 0,
      };
    }

    const qualities = this.iterations.map((it) => it.quality_score);
    const totalTokens = this.iterations.reduce((sum, it) => sum + it.tokens_used, 0);
    const totalCost = this.iterations.reduce((sum, it) => sum + it.token_cost_usd, 0);
    const totalTime = this.iterations.reduce((sum, it) => sum + it.execution_time_ms, 0);

    return {
      total_iterations: this.iterations.length,
      average_quality: qualities.reduce((a, b) => a + b, 0) / qualities.length,
      best_quality: Math.max(...qualities),
      worst_quality: Math.min(...qualities),
      total_tokens: totalTokens,
      total_cost_usd: totalCost,
      total_time_ms: totalTime,
    };
  }

  validateConfig() {
    const { threshold } = this.config.selection;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      throw new RangeError('Selection threshold must be a finite number between 0 and 100');
    }
    if (!['highest_quality', 'highest_quality_verified', 'most_recent_above_threshold'].includes(this.config.selection.mode)) {
      throw new RangeError(`Unknown selection mode: ${this.config.selection.mode}`);
    }
    const weights = Object.values(this.config.quality_weights);
    if (weights.length !== 5 || weights.some(weight => typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0)) {
      throw new RangeError('Quality weights must be five finite non-negative numbers');
    }
    const sum = weights.reduce((total, weight) => total + weight, 0);
    if (Math.abs(sum - 1) > 1e-9) throw new RangeError('Quality weights must sum to 1');
  }
}

export default BestOutputTracker;
