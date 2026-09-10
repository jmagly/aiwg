/**
 * Iteration Analytics for External Ralph Loop
 *
 * Tracks quality metrics, detects diminishing returns, and selects best output
 * per REF-015 Self-Refine research.
 *
 * @implements @agentic/code/addons/agent-loop/schemas/iteration-analytics.yaml (config)
 * @implements @agentic/code/addons/agent-loop/schemas/iteration-analytics-output.yaml (runtime output of generateSummary/generateBudgetStopReport)
 * @research @.aiwg/research/findings/REF-015-self-refine.md
 * @issue #167
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * @typedef {Object} IterationMetrics
 * @property {number} iteration_number - Iteration number
 * @property {string} timestamp - ISO timestamp
 * @property {number} quality_score - Quality score (0-100)
 * @property {number} quality_delta - Change from previous iteration
 * @property {number} tokens_used - Token count
 * @property {number} token_cost_usd - Estimated cost in USD
 * @property {number} [input_tokens] - Input token count
 * @property {number} [output_tokens] - Output token count
 * @property {number} [tool_calls] - Tool-call count
 * @property {number} execution_time_ms - Execution time in milliseconds
 * @property {string} verification_status - passed|failed|skipped|void
 * @property {string} output_snapshot_path - Path to snapshot
 * @property {string[]} reflections - Reflection notes
 * @property {Object} [experiment] - Hypothesis-before-change record
 * @property {number} [quality_per_1k_tokens] - Quality per 1K tokens
 * @property {number} [quality_per_minute] - Quality per minute
 * @property {Object|null} [baseline_comparison] - Optional random-walk/chance baseline comparison
 */

/**
 * @typedef {Object} AnalyticsSummary
 * @property {string} loop_id - Loop identifier
 * @property {string} task_description - Task description
 * @property {string} start_time - Start timestamp
 * @property {string} end_time - End timestamp
 * @property {IterationMetrics[]} iterations - All iteration metrics
 * @property {number} total_iterations - Total iteration count
 * @property {number} optimal_iteration - Iteration with highest quality
 * @property {number} final_iteration - Final iteration number
 * @property {number} selected_iteration - Selected iteration
 * @property {string} selection_reason - Why this iteration was selected
 * @property {number} total_tokens - Total tokens used
 * @property {number} total_cost_usd - Total cost in USD
 * @property {number} total_time_ms - Total execution time
 * @property {boolean} diminishing_returns_detected - DR detected
 * @property {number} diminishing_returns_iteration - DR first detected at
 * @property {string} quality_trajectory - improving|stable|declining|fluctuating
 * @property {Object|null} budget_stop_report - Budget stop report, if triggered
 */

/**
 * @typedef {Object} AnalyticsConfig
 * @property {string} storagePath - Storage directory
 * @property {number} diminishingReturnsThreshold - Percentage threshold (default: 0.05 = 5%)
 * @property {number} consecutiveCountThreshold - Consecutive low-delta threshold (default: 2)
 * @property {number} qualityThreshold - Minimum quality to consider (default: 70)
 * @property {string} selectionCriteria - highest_quality|highest_quality_verified|most_recent_above_threshold
 * @property {Object} budgetLimits - Hard cumulative budget ceilings
 * @property {Object} explorationQuota - Flat-cycle structural-variation settings
 */

const DEFAULT_CONFIG = {
  storagePath: '.aiwg/ralph/analytics',
  diminishingReturnsThreshold: 0.05, // 5%
  consecutiveCountThreshold: 2,
  qualityThreshold: 70,
  selectionCriteria: 'highest_quality_verified',
  budgetLimits: {},
  // Declared-K policy (#1770): the exploration quota is OFF unless the loop
  // explicitly declares a K. There is no default K.
  explorationQuota: {
    enabled: false,
  },
};

function objectValue(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
}

function numberValue(name, value, min = 0, max = Number.MAX_VALUE, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
    throw new RangeError(`${name} must be a finite ${integer ? 'safe integer' : 'number'} between ${min} and ${max}`);
  }
}

function textValue(name, value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
}

const SELECTION_CRITERIA = new Set(['highest_quality_verified', 'highest_quality', 'most_recent_above_threshold']);
const BUDGET_DIMENSIONS = new Set(['total_tokens', 'input_tokens', 'output_tokens', 'spend_usd', 'tool_calls', 'wall_clock_minutes']);

export class IterationAnalytics {
  /**
   * @param {string} loopId - Loop identifier
   * @param {string} taskDescription - Task description
   * @param {AnalyticsConfig} config - Analytics configuration
   */
  constructor(loopId, taskDescription, config = {}) {
    textValue('loopId', loopId);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(loopId)) throw new TypeError('loopId must be a safe single path segment');
    textValue('taskDescription', taskDescription);
    objectValue('config', config);
    this.loopId = loopId;
    this.taskDescription = taskDescription;
    this.config = { ...DEFAULT_CONFIG, ...config };
    textValue('storagePath', this.config.storagePath);
    numberValue('diminishingReturnsThreshold', this.config.diminishingReturnsThreshold, 0, 1);
    numberValue('consecutiveCountThreshold', this.config.consecutiveCountThreshold, 1, Number.MAX_SAFE_INTEGER, true);
    numberValue('qualityThreshold', this.config.qualityThreshold, 0, 100);
    if (!SELECTION_CRITERIA.has(this.config.selectionCriteria)) throw new TypeError('Invalid selectionCriteria');
    objectValue('budgetLimits', this.config.budgetLimits);
    for (const [name, limit] of Object.entries(this.config.budgetLimits)) {
      if (!BUDGET_DIMENSIONS.has(name)) throw new TypeError(`Unknown budgetLimits dimension: ${name}`);
      numberValue(`budgetLimits.${name}`, limit, Number.MIN_VALUE);
    }
    objectValue('explorationQuota', this.config.explorationQuota);
    const quota = this.config.explorationQuota;
    if (quota.enabled !== undefined && typeof quota.enabled !== 'boolean') throw new TypeError('explorationQuota.enabled must be boolean');
    if (quota.k !== undefined) numberValue('explorationQuota.k', quota.k, 0, Number.MAX_SAFE_INTEGER, true);
    this.config.budgetLimits = { ...this.config.budgetLimits };
    this.config.explorationQuota = { ...quota };

    this.startTime = new Date().toISOString();
    this.endTime = null;
    this.iterations = [];

    this.ensureStorageDir();
  }

  /**
   * Ensure storage directory exists
   */
  ensureStorageDir() {
    if (!existsSync(this.config.storagePath)) {
      mkdirSync(this.config.storagePath, { recursive: true });
    }
  }

  /**
   * Record metrics for an iteration
   * @param {Object} metrics - Iteration metrics
   * @param {number} metrics.iteration_number - Iteration number
   * @param {number} metrics.quality_score - Quality score (0-100)
   * @param {number} metrics.tokens_used - Token count
   * @param {number} metrics.token_cost_usd - Cost in USD
   * @param {number} metrics.execution_time_ms - Execution time
   * @param {string} metrics.verification_status - passed|failed|skipped|void
   * @param {string} metrics.output_snapshot_path - Path to snapshot
   * @param {string[]} [metrics.reflections] - Reflection notes
   * @returns {IterationMetrics} Complete iteration record
   */
  recordIteration(metrics) {
    this.validateMetrics(metrics);
    const timestamp = new Date().toISOString();

    // Calculate quality delta
    const previousIteration = this.iterations[this.iterations.length - 1];
    const quality_delta = previousIteration
      ? metrics.quality_score - previousIteration.quality_score
      : 0;

    // Unknown vs zero (#1766): null means "provider did not report this usage
    // dimension" and must be preserved (not coerced to 0), so a declared
    // token/spend ceiling on an unobservable provider is flagged rather than
    // silently never firing.
    const keepUnknown = (v) => (v === null || v === undefined ? null : v);

    /** @type {IterationMetrics} */
    const record = {
      iteration_number: metrics.iteration_number,
      timestamp,
      quality_score: metrics.quality_score,
      quality_delta,
      tokens_used: keepUnknown(metrics.tokens_used),
      token_cost_usd: keepUnknown(metrics.token_cost_usd),
      input_tokens: keepUnknown(metrics.input_tokens),
      output_tokens: keepUnknown(metrics.output_tokens),
      tool_calls: metrics.tool_calls || 0,
      execution_time_ms: metrics.execution_time_ms,
      verification_status: metrics.verification_status,
      output_snapshot_path: metrics.output_snapshot_path,
      reflections: metrics.reflections || [],
      experiment: metrics.experiment || null,
      // Eval-harness result + VOID handling (#1776). eval_human_override lets a
      // human accept a VOID iteration as a best-output candidate.
      eval_harness_result: metrics.eval_harness_result || null,
      eval_human_override: metrics.eval_human_override === true,
      quality_per_1k_tokens: metrics.tokens_used > 0
        ? metrics.quality_score / (metrics.tokens_used / 1000)
        : null,  // null when tokens unknown or zero

      quality_per_minute: metrics.execution_time_ms > 0
        ? metrics.quality_score / (metrics.execution_time_ms / 60000)
        : null,
      baseline_comparison: this.computeBaselineComparison(metrics),
    };

    this.iterations.push(record);

    // Auto-save after each iteration
    this.saveAnalytics();

    return record;
  }

  validateMetrics(metrics) {
    objectValue('metrics', metrics);
    numberValue('iteration_number', metrics.iteration_number, 1, Number.MAX_SAFE_INTEGER, true);
    numberValue('quality_score', metrics.quality_score, 0, 100);
    for (const name of ['tokens_used', 'input_tokens', 'output_tokens', 'token_cost_usd']) {
      if (metrics[name] != null) numberValue(name, metrics[name], 0, Number.MAX_VALUE, name !== 'token_cost_usd');
    }
    if (metrics.tool_calls !== undefined) numberValue('tool_calls', metrics.tool_calls, 0, Number.MAX_SAFE_INTEGER, true);
    numberValue('execution_time_ms', metrics.execution_time_ms);
    if (!['passed', 'failed', 'skipped', 'void'].includes(metrics.verification_status)) throw new TypeError('Invalid verification_status');
    if (metrics.output_snapshot_path != null && typeof metrics.output_snapshot_path !== 'string') throw new TypeError('output_snapshot_path must be a string or null');
    if (metrics.reflections !== undefined && (!Array.isArray(metrics.reflections) || metrics.reflections.some(value => typeof value !== 'string'))) throw new TypeError('reflections must be an array of strings');
    if (metrics.eval_human_override !== undefined && typeof metrics.eval_human_override !== 'boolean') throw new TypeError('eval_human_override must be boolean');
    if (metrics.experiment != null) {
      objectValue('experiment', metrics.experiment);
      for (const name of ['hypothesis', 'expected_failure_mode', 'distinguishing_diagnostic', 'probe_or_generalization_signal']) {
        if (metrics.experiment[name] !== undefined && typeof metrics.experiment[name] !== 'string') throw new TypeError(`experiment.${name} must be a string`);
      }
      for (const name of ['structural_variant', 'adjustment_key']) {
        if (metrics.experiment[name] != null && typeof metrics.experiment[name] !== 'string') throw new TypeError(`experiment.${name} must be a string or null`);
      }
      if (metrics.experiment.recorded_before_change !== undefined && typeof metrics.experiment.recorded_before_change !== 'boolean') throw new TypeError('experiment.recorded_before_change must be boolean');
      if (metrics.experiment.result !== undefined && !['passed', 'failed'].includes(metrics.experiment.result)) throw new TypeError('Invalid experiment.result');
    }
    for (const name of ['baseline_comparison', 'random_walk_baseline']) {
      if (metrics[name] == null) continue;
      objectValue(name, metrics[name]);
      const baseline = metrics[name].random_walk ?? metrics[name].baseline ?? metrics[name];
      objectValue(name, baseline);
      numberValue(`${name}.quality_score`, baseline.quality_score, 0, 100);
      for (const field of ['tokens_used', 'total_tokens', 'execution_time_ms', 'tool_calls']) {
        if (baseline[field] !== undefined) numberValue(`${name}.${field}`, baseline[field], 0, Number.MAX_VALUE, field !== 'execution_time_ms');
      }
    }
    if (metrics.eval_harness_result != null) {
      const result = metrics.eval_harness_result;
      objectValue('eval_harness_result', result);
      if (!['pass', 'fail', 'void', 'error'].includes(result.status)) throw new TypeError('Invalid eval_harness_result.status');
      objectValue('optimizer_feedback', result.optimizer_feedback);
      const feedback = result.optimizer_feedback;
      for (const name of Object.keys(feedback)) {
        if (!['score', 'pass_count', 'total_count', 'status', 'void_reason'].includes(name)) throw new TypeError(`Forbidden optimizer_feedback field: ${name}`);
      }
      if (feedback.score !== undefined) numberValue('optimizer_feedback.score', feedback.score, 0, 100);
      for (const name of ['pass_count', 'total_count']) {
        if (feedback[name] !== undefined) numberValue(`optimizer_feedback.${name}`, feedback[name], 0, Number.MAX_SAFE_INTEGER, true);
      }
      for (const name of ['status', 'void_reason']) {
        if (feedback[name] !== undefined && typeof feedback[name] !== 'string') throw new TypeError(`optimizer_feedback.${name} must be a string`);
      }
      if (result.private_diagnostics_ref != null && typeof result.private_diagnostics_ref !== 'string') throw new TypeError('eval_harness_result.private_diagnostics_ref must be a string or null');
      if (result.human_override !== undefined && typeof result.human_override !== 'boolean') throw new TypeError('eval_harness_result.human_override must be boolean');
      if (result._forbidden_fields_seen !== undefined && (!Array.isArray(result._forbidden_fields_seen) || result._forbidden_fields_seen.some(value => typeof value !== 'string'))) throw new TypeError('eval_harness_result._forbidden_fields_seen must be an array of strings');
      if (result.leakage_audit !== undefined) {
        objectValue('eval_harness_result.leakage_audit', result.leakage_audit);
        if (typeof result.leakage_audit.checked !== 'boolean' || !['pass', 'fail', 'not_applicable'].includes(result.leakage_audit.result)) throw new TypeError('Invalid eval_harness_result.leakage_audit');
      }
    }
    for (const name of ['tokens_used', 'input_tokens', 'output_tokens', 'token_cost_usd', 'tool_calls', 'execution_time_ms']) {
      const total = this.iterations.reduce((sum, it) => sum + (it[name] ?? 0), metrics[name] ?? 0);
      if (!Number.isFinite(total)) throw new RangeError(`${name} cumulative total must remain finite`);
    }
  }

  /**
   * Compare an iteration against an optional random-walk or chance baseline.
   * @param {Object} metrics - Iteration metrics
   * @returns {Object|null} Baseline comparison
   */
  computeBaselineComparison(metrics) {
    const input = metrics.baseline_comparison || metrics.random_walk_baseline;
    if (!input || typeof input !== 'object') return null;

    const baseline = input.random_walk || input.baseline || input;
    const baselineQuality = Number(baseline.quality_score);
    if (!Number.isFinite(baselineQuality)) return null;

    const qualityLift = metrics.quality_score - baselineQuality;
    const baselineTokens = Number(baseline.tokens_used || baseline.total_tokens || 0);
    const baselineTimeMs = Number(baseline.execution_time_ms || 0);
    const baselineToolCalls = Number(baseline.tool_calls || 0);
    const iterationTokens = Number(metrics.tokens_used || 0);
    const iterationTimeMs = Number(metrics.execution_time_ms || 0);
    const iterationToolCalls = Number(metrics.tool_calls || 0);

    const baselineQualityPer1k = baselineTokens > 0
      ? baselineQuality / (baselineTokens / 1000)
      : null;
    const iterationQualityPer1k = iterationTokens > 0
      ? metrics.quality_score / (iterationTokens / 1000)
      : null;
    const baselineQualityPerMinute = baselineTimeMs > 0
      ? baselineQuality / (baselineTimeMs / 60000)
      : null;
    const iterationQualityPerMinute = iterationTimeMs > 0
      ? metrics.quality_score / (iterationTimeMs / 60000)
      : null;

    return {
      baseline_type: input.baseline_type || baseline.baseline_type || 'random_walk',
      source: input.source || baseline.source || 'declared_harness_baseline',
      baseline_quality_score: baselineQuality,
      quality_lift: qualityLift,
      quality_lift_pct: baselineQuality !== 0
        ? qualityLift / Math.abs(baselineQuality)
        : null,
      baseline_tokens_used: baselineTokens || null,
      token_efficiency_lift: baselineQualityPer1k !== null && iterationQualityPer1k !== null
        ? iterationQualityPer1k - baselineQualityPer1k
        : null,
      baseline_execution_time_ms: baselineTimeMs || null,
      speed_efficiency_lift: baselineQualityPerMinute !== null && iterationQualityPerMinute !== null
        ? iterationQualityPerMinute - baselineQualityPerMinute
        : null,
      baseline_tool_calls: baselineToolCalls || null,
      tool_call_savings: baselineToolCalls > 0 && iterationToolCalls >= 0
        ? baselineToolCalls - iterationToolCalls
        : null,
    };
  }

  /**
   * Get cumulative observable resource usage.
   * @returns {Object} Cumulative counters
   */
  getBudgetUsage() {
    // Sum over observed (non-null) values only. tool_calls and wall_clock are
    // always observable (counted/measured by the orchestrator).
    const sumObserved = (field) =>
      this.iterations.reduce((sum, it) => sum + (typeof it[field] === 'number' ? it[field] : 0), 0);

    return {
      total_tokens: sumObserved('tokens_used'),
      input_tokens: sumObserved('input_tokens'),
      output_tokens: sumObserved('output_tokens'),
      spend_usd: sumObserved('token_cost_usd'),
      tool_calls: sumObserved('tool_calls'),
      wall_clock_minutes: sumObserved('execution_time_ms') / 60000,
    };
  }

  /**
   * Which budget dimensions were actually observed at least once.
   * A dimension whose per-iteration field is null/undefined for EVERY recorded
   * iteration is unobservable on the active provider — a declared ceiling on it
   * cannot fire and must be surfaced rather than silently passing (#1766).
   * @returns {Object<string,boolean>}
   */
  getObservableDimensions() {
    const anyObserved = (field) =>
      this.iterations.some((it) => typeof it[field] === 'number');
    return {
      total_tokens: anyObserved('tokens_used'),
      input_tokens: anyObserved('input_tokens'),
      output_tokens: anyObserved('output_tokens'),
      spend_usd: anyObserved('token_cost_usd'),
      // Always observable — the orchestrator counts/measures these directly.
      tool_calls: true,
      wall_clock_minutes: true,
    };
  }

  /**
   * Check declared hard budget ceilings.
   * @returns {Object} Budget decision
   */
  checkBudgetLimits() {
    const limits = this.config.budgetLimits || {};
    const usage = this.getBudgetUsage();
    const observable = this.getObservableDimensions();
    const exhausted = [];
    const unobservable = [];

    for (const [name, limit] of Object.entries(limits)) {
      if (limit === undefined || limit === null || limit === '' || Number(limit) <= 0) {
        continue;
      }

      const observed = usage[name];
      // Unknown vs zero (#1766): a declared ceiling whose dimension the provider
      // never reported is UNOBSERVABLE — do not treat the constant-0 sum as
      // "under budget". Surface it so the operator learns the ceiling is inert
      // on this provider instead of it silently never firing.
      if (observable[name] === false || typeof observed !== 'number' || !Number.isFinite(observed)) {
        unobservable.push(name);
        // Emit the warning once, when the dimension first proves unobservable.
        if (!this._warnedUnobservable) this._warnedUnobservable = new Set();
        if (!this._warnedUnobservable.has(name)) {
          this._warnedUnobservable.add(name);
          console.warn(
            `[IterationAnalytics] Declared budget ceiling '${name}=${Number(limit)}' is UNOBSERVABLE on this provider ` +
            `(no usage reported) — it cannot fire. Use --max-wall-clock-minutes for a provider-independent hard stop.`
          );
        }
        continue;
      }

      if (observed >= Number(limit)) {
        exhausted.push({ name, limit: Number(limit), observed });
      }
    }

    const triggerName = exhausted.length > 0
      ? this.getBudgetStopTrigger(exhausted[0].name)
      : 'none';

    return {
      exhausted: exhausted.length > 0,
      trigger: triggerName,
      exhausted_limits: exhausted,
      unobservable_limits: unobservable,
      usage,
      limits,
    };
  }

  /**
   * Map budget counter names to schema stop-reason names.
   * @param {string} name - Budget counter name
   * @returns {string} Stop trigger
   */
  getBudgetStopTrigger(name) {
    const triggers = {
      wall_clock_minutes: 'wall_clock_exhausted',
      output_tokens: 'output_tokens_exhausted',
      total_tokens: 'total_tokens_exhausted',
      spend_usd: 'spend_exhausted',
      tool_calls: 'tool_calls_exhausted',
    };

    return triggers[name] || `${name}_exhausted`;
  }

  /**
   * Count consecutive flat cycles at the tail of the run.
   * @returns {number} Flat-cycle count
   */
  getFlatCycleCount() {
    if (this.iterations.length < 2) return 0;

    const threshold = this.config.diminishingReturnsThreshold;
    let flatCount = 0;

    for (let i = this.iterations.length - 1; i >= 1; i--) {
      const iteration = this.iterations[i];
      const prevScore = this.iterations[i - 1].quality_score;
      // A change from a zero-score baseline is unbounded relative improvement,
      // never a flat cycle — 0 → 90 used to count as flat (#1767 / audit M6)
      const percentageChange = prevScore > 0
        ? Math.abs(iteration.quality_delta) / prevScore
        : (Math.abs(iteration.quality_delta) > 0 ? Number.POSITIVE_INFINITY : 0);

      if (percentageChange < threshold) {
        flatCount++;
      } else {
        break;
      }
    }

    return flatCount;
  }

  /**
   * Stall rule (#1768): after a non-improving cycle, the same adjustment must
   * not be repeated. Mechanically detects (a) whether the last recorded cycle
   * failed to improve quality, and (b) the adjustment fingerprint of that
   * cycle, so the orchestrator can forbid repeating it in the next prompt. This
   * fires immediately on ONE non-improving cycle — earlier than the exploration
   * quota, which needs K consecutive flat cycles.
   *
   * @returns {{active: boolean, lastNonImproving: boolean, forbiddenAdjustment: string|null, lastQualityDelta: number|null}}
   */
  checkStallRule() {
    if (this.iterations.length < 1) {
      return { active: false, lastNonImproving: false, forbiddenAdjustment: null, lastQualityDelta: null };
    }
    const last = this.iterations[this.iterations.length - 1];
    const delta = typeof last.quality_delta === 'number' ? last.quality_delta : 0;
    // Non-improving = quality did not increase. The first iteration has delta 0
    // (no prior) — treat as improving so we don't fence the second iteration
    // before any tactic has actually been shown to fail.
    const lastNonImproving = this.iterations.length >= 2 && delta <= 0;
    const forbiddenAdjustment = last.experiment?.adjustment_key
      || last.experiment?.structural_variant
      || null;
    return {
      active: lastNonImproving && !!forbiddenAdjustment,
      lastNonImproving,
      forbiddenAdjustment,
      lastQualityDelta: delta,
    };
  }

  /**
   * Determine whether the next iteration must use a structural variant.
   * @returns {Object} Structural-variation decision
   */
  checkExplorationQuota() {
    const quota = this.config.explorationQuota || {};
    const k = Number(quota.k);

    // Declared-K policy (#1770): the quota is active only when explicitly
    // enabled WITH a valid declared K >= 1. No default K is substituted —
    // `k: 0`/missing/invalid means the control is off, never silently 3.
    if (quota.enabled !== true || !Number.isFinite(k) || k < 1) {
      return {
        required: false,
        flat_cycle_count: 0,
        k: Number.isFinite(k) && k >= 1 ? k : null,
        trigger: 'none',
      };
    }

    const flatCycleCount = this.getFlatCycleCount();

    return {
      required: flatCycleCount >= k,
      flat_cycle_count: flatCycleCount,
      k,
      trigger: flatCycleCount >= k ? 'exploration_quota' : 'none',
    };
  }

  /**
   * Generate an LFD-style budget stop report.
   * @param {string} stopReason - Stop reason
   * @returns {Object} Budget stop report
   */
  generateBudgetStopReport(stopReason) {
    const selection = this.selectBestIteration();
    const finalIteration = this.iterations[this.iterations.length - 1] || null;
    const budgetDecision = this.checkBudgetLimits();

    return {
      stop_reason: stopReason,
      budgets: {
        limits: budgetDecision.limits,
        observed: budgetDecision.usage,
        exhausted: budgetDecision.exhausted_limits,
        unobservable: budgetDecision.unobservable_limits,
      },
      selected_iteration: selection.selected?.iteration_number || null,
      final_iteration: finalIteration?.iteration_number || null,
      best_score: selection.selected?.quality_score ?? null,
      final_score: finalIteration?.quality_score ?? null,
      hypothesis_outcomes: this.iterations
        .filter(it => it.experiment)
        .map(it => ({
          iteration: it.iteration_number,
          ...it.experiment,
        })),
      next_recommended_action: 'Review best output before raising budgets or continuing optimization.',
    };
  }

  /**
   * Detect diminishing returns using consecutive low-delta method
   * @returns {Object} Detection result
   */
  detectDiminishingReturns() {
    if (this.iterations.length < 2) {
      return {
        detected: false,
        iteration: null,
        reason: 'Insufficient iterations for detection',
      };
    }

    const threshold = this.config.diminishingReturnsThreshold;
    const consecutiveRequired = this.config.consecutiveCountThreshold;
    let consecutiveLowDelta = 0;
    let detectedAtIteration = null;

    for (let i = 1; i < this.iterations.length; i++) {
      const iteration = this.iterations[i];
      const prevScore = this.iterations[i - 1].quality_score;
      // Zero-baseline improvement is unbounded relative change, never low-delta (#1767)
      const percentageChange = prevScore > 0
        ? Math.abs(iteration.quality_delta) / prevScore
        : (Math.abs(iteration.quality_delta) > 0 ? Number.POSITIVE_INFINITY : 0);

      if (percentageChange < threshold) {
        consecutiveLowDelta++;

        if (consecutiveLowDelta >= consecutiveRequired && detectedAtIteration === null) {
          detectedAtIteration = iteration.iteration_number;
        }
      } else {
        consecutiveLowDelta = 0;
      }
    }

    const detected = detectedAtIteration !== null;

    return {
      detected,
      iteration: detectedAtIteration,
      reason: detected
        ? `${consecutiveRequired} consecutive iterations with <${threshold * 100}% improvement`
        : 'No diminishing returns detected',
    };
  }

  /**
   * Calculate quality trajectory
   * @returns {string} improving|stable|declining|fluctuating
   */
  getTrajectory() {
    if (this.iterations.length < 3) {
      return 'insufficient_data';
    }

    const deltas = this.iterations.slice(1).map(it => it.quality_delta);
    const positiveCount = deltas.filter(d => d > 2).length;
    const negativeCount = deltas.filter(d => d < -2).length;
    const stableCount = deltas.filter(d => Math.abs(d) <= 2).length;

    const totalChanges = deltas.length;
    const positiveRatio = positiveCount / totalChanges;
    const negativeRatio = negativeCount / totalChanges;
    const stableRatio = stableCount / totalChanges;

    if (positiveRatio >= 0.67) return 'improving';
    if (negativeRatio >= 0.67) return 'declining';
    if (stableRatio >= 0.67) return 'stable';
    return 'fluctuating';
  }

  /**
   * Get optimal iteration (highest quality)
   * @param {boolean} [verifiedOnly=true] - Only consider verified iterations
   * @returns {IterationMetrics|null} Optimal iteration or null
   */
  getOptimalIteration(verifiedOnly = true) {
    if (this.iterations.length === 0) {
      return null;
    }

    // VOID iterations (eval-harness voided — e.g. a lint violation) are never
    // valid best-output candidates unless a human override accepted them
    // (#1776). Even the fallback must not return a VOID iteration.
    const selectable = this.iterations.filter(
      it => it.verification_status !== 'void' || it.eval_human_override === true
    );
    const pool = selectable;
    if (pool.length === 0) return null;

    let candidates = [...pool];

    // Filter by verification status if requested
    if (verifiedOnly) {
      candidates = candidates.filter(it => it.verification_status === 'passed');
    }

    // Filter by quality threshold
    candidates = candidates.filter(it => it.quality_score >= this.config.qualityThreshold);

    if (candidates.length === 0) {
      // Fallback: highest quality among selectable (non-VOID) iterations.
      return pool.reduce((best, curr) =>
        curr.quality_score > best.quality_score ? curr : best
      );
    }

    // Find highest quality
    return candidates.reduce((best, curr) =>
      curr.quality_score > best.quality_score ? curr : best
    );
  }

  /**
   * Select best iteration based on configuration
   * @returns {Object} Selection result
   */
  selectBestIteration() {
    const selectable = this.iterations.filter(
      it => it.verification_status !== 'void' || it.eval_human_override === true
    );
    if (selectable.length === 0) {
      return {
        selected: null,
        reason: this.iterations.length === 0 ? 'No iterations available' : 'No eligible iterations available (all VOID)',
      };
    }

    const criteria = this.config.selectionCriteria;
    let selected = null;
    let reason = '';

    switch (criteria) {
      case 'highest_quality_verified': {
        const optimal = this.getOptimalIteration(true);
        selected = optimal;
        reason = optimal?.verification_status === 'passed' && optimal.quality_score >= this.config.qualityThreshold
          ? `Highest quality verified iteration (${optimal.quality_score})`
          : 'No verified iterations above threshold, using best available';

        if (!optimal) {
          selected = this.getOptimalIteration(false);
          reason = 'No verified iterations, selected highest quality overall';
        }
        break;
      }

      case 'highest_quality': {
        selected = this.getOptimalIteration(false);
        reason = `Highest quality iteration (${selected.quality_score})`;
        break;
      }

      case 'most_recent_above_threshold': {
        const aboveThreshold = selectable
          .filter(it => it.quality_score >= this.config.qualityThreshold)
          .reverse();

        selected = aboveThreshold[0] || selectable[selectable.length - 1];
        reason = aboveThreshold[0]
          ? `Most recent iteration above threshold (${selected.quality_score})`
          : 'No iterations above threshold, using final iteration';
        break;
      }

      default:
        selected = selectable[selectable.length - 1];
        reason = 'Using final iteration (unknown selection criteria)';
    }

    return {
      selected,
      reason,
    };
  }

  /**
   * Generate analytics summary
   * @returns {AnalyticsSummary}
   */
  generateSummary() {
    this.endTime = this.endTime || new Date().toISOString();

    const optimalIteration = this.getOptimalIteration(false);
    const selection = this.selectBestIteration();
    const diminishingReturns = this.detectDiminishingReturns();

    const totalTokens = this.iterations.reduce((sum, it) => sum + it.tokens_used, 0);
    const totalCost = this.iterations.reduce((sum, it) => sum + it.token_cost_usd, 0);
    const totalTime = this.iterations.reduce((sum, it) => sum + it.execution_time_ms, 0);
    const budgetDecision = this.checkBudgetLimits();
    const explorationQuota = this.checkExplorationQuota();
    const baselineComparisons = this.iterations
      .map(it => it.baseline_comparison)
      .filter(Boolean);
    const bestFinite = (values) => {
      const finite = values.filter(value => typeof value === 'number' && Number.isFinite(value));
      return finite.length > 0 ? Math.max(...finite) : null;
    };

    /** @type {AnalyticsSummary} */
    const summary = {
      loop_id: this.loopId,
      task_description: this.taskDescription,
      analytics_config: {
        diminishingReturnsThreshold: this.config.diminishingReturnsThreshold,
        consecutiveCountThreshold: this.config.consecutiveCountThreshold,
        qualityThreshold: this.config.qualityThreshold,
        selectionCriteria: this.config.selectionCriteria,
        budgetLimits: { ...this.config.budgetLimits },
        explorationQuota: { ...this.config.explorationQuota },
      },
      start_time: this.startTime,
      end_time: this.endTime,
      iterations: this.iterations,
      total_iterations: this.iterations.length,
      optimal_iteration: optimalIteration ? optimalIteration.iteration_number : null,
      final_iteration: this.iterations.length > 0
        ? this.iterations[this.iterations.length - 1].iteration_number
        : 0,
      selected_iteration: selection.selected ? selection.selected.iteration_number : null,
      selection_reason: selection.reason,
      total_tokens: totalTokens,
      total_cost_usd: totalCost,
      total_time_ms: totalTime,
      budget_usage: budgetDecision.usage,
      budget_limits: budgetDecision.limits,
      budget_exhausted: budgetDecision.exhausted,
      budget_stop_report: budgetDecision.exhausted
        ? this.generateBudgetStopReport(budgetDecision.trigger)
        : null,
      flat_cycle_count: explorationQuota.flat_cycle_count,
      structural_variant_required: explorationQuota.required,
      // Eval-harness result of the final iteration + count of VOID iterations
      // (LFD Track 3, #1776). null when no harness was declared.
      eval_harness_result: this.iterations.length > 0
        ? (this.iterations[this.iterations.length - 1].eval_harness_result || null)
        : null,
      void_iteration_count: this.iterations.filter(
        it => it.verification_status === 'void'
      ).length,
      baseline_comparison: baselineComparisons.length > 0
        ? {
            count: baselineComparisons.length,
            best_quality_lift: Math.max(...baselineComparisons.map(it => it.quality_lift)),
            best_token_efficiency_lift: bestFinite(baselineComparisons.map(it => it.token_efficiency_lift)),
            best_speed_efficiency_lift: bestFinite(baselineComparisons.map(it => it.speed_efficiency_lift)),
          }
        : null,
      diminishing_returns_detected: diminishingReturns.detected,
      diminishing_returns_iteration: diminishingReturns.iteration,
      quality_trajectory: this.getTrajectory(),
    };

    return summary;
  }

  /**
   * Generate quality chart (ASCII)
   * @returns {string} ASCII quality chart
   */
  generateQualityChart() {
    if (this.iterations.length === 0) {
      return 'No data';
    }

    const maxScore = Math.max(...this.iterations.map(it => it.quality_score));
    const minScore = Math.min(...this.iterations.map(it => it.quality_score));
    const range = maxScore - minScore;

    if (range === 0) {
      return `Quality: ${maxScore} (constant)`;
    }

    const height = 10;
    const lines = [];

    // Create chart lines from top to bottom
    for (let row = height; row >= 0; row--) {
      const threshold = minScore + (range * row / height);
      let line = `${threshold.toFixed(0).padStart(3)} |`;

      for (const iteration of this.iterations) {
        const score = iteration.quality_score;
        if (Math.abs(score - threshold) < range / (height * 2)) {
          line += iteration.verification_status === 'passed' ? '●' : '○';
        } else {
          line += ' ';
        }
      }

      lines.push(line);
    }

    // Add x-axis
    const xAxis = '    +' + '-'.repeat(this.iterations.length);
    const labels = '     ' + this.iterations.map(it => it.iteration_number % 10).join('');

    return lines.join('\n') + '\n' + xAxis + '\n' + labels;
  }

  /**
   * Generate markdown report
   * @returns {string} Markdown report
   */
  generateReport() {
    const summary = this.generateSummary();
    const chart = this.generateQualityChart();
    const diminishingReturns = this.detectDiminishingReturns();
    const formatNullable = (value, digits = 2) =>
      typeof value === 'number' && Number.isFinite(value)
        ? value.toFixed(digits)
        : 'N/A';
    const bestQualityPerToken = this.iterations
      .filter(it => typeof it.quality_per_1k_tokens === 'number' && Number.isFinite(it.quality_per_1k_tokens))
      .reduce((best, curr) =>
        !best || curr.quality_per_1k_tokens > best.quality_per_1k_tokens ? curr : best,
      null);
    const bestQualityPerMinute = this.iterations
      .filter(it => typeof it.quality_per_minute === 'number' && Number.isFinite(it.quality_per_minute))
      .reduce((best, curr) =>
        !best || curr.quality_per_minute > best.quality_per_minute ? curr : best,
      null);
    const bestBaselineLift = this.iterations
      .filter(it => it.baseline_comparison && typeof it.baseline_comparison.quality_lift === 'number')
      .reduce((best, curr) =>
        !best || curr.baseline_comparison.quality_lift > best.baseline_comparison.quality_lift ? curr : best,
      null);
    const bestBaselineTokenLift = this.iterations
      .filter(it => it.baseline_comparison && typeof it.baseline_comparison.token_efficiency_lift === 'number')
      .reduce((best, curr) =>
        !best || curr.baseline_comparison.token_efficiency_lift > best.baseline_comparison.token_efficiency_lift ? curr : best,
      null);
    const bestBaselineSpeedLift = this.iterations
      .filter(it => it.baseline_comparison && typeof it.baseline_comparison.speed_efficiency_lift === 'number')
      .reduce((best, curr) =>
        !best || curr.baseline_comparison.speed_efficiency_lift > best.baseline_comparison.speed_efficiency_lift ? curr : best,
      null);

    // Build iteration rows
    const iterationRows = this.iterations.map(it => {
      const deltaStr = it.quality_delta >= 0
        ? `+${it.quality_delta.toFixed(1)}`
        : it.quality_delta.toFixed(1);

      const verifiedMark = it.verification_status === 'passed' ? '✓' :
                          it.verification_status === 'failed' ? '✗' : '-';

      const baselineLift = it.baseline_comparison
        ? formatNullable(it.baseline_comparison.quality_lift)
        : 'N/A';
      const tokenLift = it.baseline_comparison
        ? formatNullable(it.baseline_comparison.token_efficiency_lift)
        : 'N/A';
      const speedLift = it.baseline_comparison
        ? formatNullable(it.baseline_comparison.speed_efficiency_lift)
        : 'N/A';

      // tokens_used / token_cost_usd may be null (unknown) on providers that
      // report no usage (#1766) — render N/A rather than crashing on toFixed.
      const tokensCell = typeof it.tokens_used === 'number' ? it.tokens_used : 'N/A';
      const costCell = typeof it.token_cost_usd === 'number' ? `$${it.token_cost_usd.toFixed(4)}` : 'N/A';
      return `| ${it.iteration_number} | ${it.quality_score.toFixed(1)} | ${deltaStr} | ${tokensCell} | ${formatNullable(it.quality_per_1k_tokens)} | ${formatNullable(it.quality_per_minute)} | ${baselineLift} | ${tokenLift} | ${speedLift} | ${costCell} | ${verifiedMark} |`;
    }).join('\n');

    // Diminishing returns note
    const drNote = diminishingReturns.detected
      ? `**Diminishing Returns Detected:** At iteration ${diminishingReturns.iteration}\n${diminishingReturns.reason}`
      : '**Diminishing Returns:** Not detected - iterations continue to show improvement';

    // Recommendations
    const recommendations = [];

    if (summary.selected_iteration !== summary.final_iteration) {
      recommendations.push(`- Selected iteration ${summary.selected_iteration} over final iteration ${summary.final_iteration} due to higher quality`);
    }

    if (diminishingReturns.detected) {
      recommendations.push(`- Consider stopping at iteration ${diminishingReturns.iteration} to save tokens/cost`);
    }

    if (summary.quality_trajectory === 'declining') {
      recommendations.push('- Quality is declining - review feedback mechanism');
    } else if (summary.quality_trajectory === 'fluctuating') {
      recommendations.push('- Quality is fluctuating - consider more stable evaluation criteria');
    }

    if (recommendations.length === 0) {
      recommendations.push('- Loop performed well with consistent improvement');
    }

    const report = `# Ralph Loop Analytics: ${summary.loop_id}

**Task:** ${summary.task_description}
**Duration:** ${summary.start_time} → ${summary.end_time}

## Summary

| Metric | Value |
|--------|-------|
| Total Iterations | ${summary.total_iterations} |
| Selected Iteration | ${summary.selected_iteration} |
| Final Quality Score | ${summary.iterations[summary.iterations.length - 1]?.quality_score.toFixed(1) || 'N/A'} |
| Total Tokens | ${summary.total_tokens.toLocaleString()} |
| Total Cost | $${summary.total_cost_usd.toFixed(4)} |
| Best Quality / 1K Tokens | ${bestQualityPerToken ? `Iteration ${bestQualityPerToken.iteration_number} (${formatNullable(bestQualityPerToken.quality_per_1k_tokens)})` : 'N/A'} |
| Best Quality / Minute | ${bestQualityPerMinute ? `Iteration ${bestQualityPerMinute.iteration_number} (${formatNullable(bestQualityPerMinute.quality_per_minute)})` : 'N/A'} |
| Best Lift Over Random Baseline | ${bestBaselineLift ? `Iteration ${bestBaselineLift.iteration_number} (+${formatNullable(bestBaselineLift.baseline_comparison.quality_lift)})` : 'N/A'} |
| Best Token-Efficiency Lift Over Random Baseline | ${bestBaselineTokenLift ? `Iteration ${bestBaselineTokenLift.iteration_number} (+${formatNullable(bestBaselineTokenLift.baseline_comparison.token_efficiency_lift)})` : 'N/A'} |
| Best Speed-Efficiency Lift Over Random Baseline | ${bestBaselineSpeedLift ? `Iteration ${bestBaselineSpeedLift.iteration_number} (+${formatNullable(bestBaselineSpeedLift.baseline_comparison.speed_efficiency_lift)})` : 'N/A'} |

## Iteration History

| # | Quality | Delta | Tokens | Quality / 1K Tokens | Quality / Minute | Lift vs Random | Token Lift vs Random | Speed Lift vs Random | Cost | Verified |
|---|---------|-------|--------|---------------------|------------------|----------------|----------------------|----------------------|------|----------|
${iterationRows}

## Quality Trajectory

\`\`\`
${chart}
\`\`\`

**Trajectory:** ${summary.quality_trajectory}

## Analysis

**Best Output:** Iteration ${summary.optimal_iteration} (quality: ${this.getOptimalIteration(false)?.quality_score.toFixed(1) || 'N/A'})
**Selected:** Iteration ${summary.selected_iteration} (${summary.selection_reason})

${drNote}

## Recommendations

${recommendations.join('\n')}

---

*Generated: ${new Date().toISOString()}*
`;

    return report;
  }

  /**
   * Save analytics to JSON file
   * @param {string} [filename] - Custom filename (optional)
   */
  saveAnalytics(filename = null) {
    const summary = this.generateSummary();
    const filepath = filename || join(this.config.storagePath, `${this.loopId}.json`);

    writeFileSync(filepath, JSON.stringify(summary, null, 2));

    return filepath;
  }

  /**
   * Save report to markdown file
   * @param {string} [filename] - Custom filename (optional)
   */
  saveReport(filename = null) {
    const report = this.generateReport();
    const filepath = filename || join(this.config.storagePath, `${this.loopId}-report.md`);

    writeFileSync(filepath, report);

    return filepath;
  }

  /**
   * Export all analytics (JSON + Markdown)
   * @returns {Object} Export paths
   */
  export() {
    const jsonPath = this.saveAnalytics();
    const reportPath = this.saveReport();

    return {
      json: jsonPath,
      markdown: reportPath,
    };
  }

  /**
   * Load analytics from file
   * @param {string} filepath - Path to analytics JSON
   * @returns {IterationAnalytics} Analytics instance
   */
  static load(filepath) {
    if (!existsSync(filepath)) {
      throw new Error(`Analytics file not found: ${filepath}`);
    }

    const content = readFileSync(filepath, 'utf8');
    const summary = JSON.parse(content);
    if (summary.analytics_config !== undefined) objectValue('analytics_config', summary.analytics_config);

    const analytics = new IterationAnalytics(
      summary.loop_id,
      summary.task_description,
      {
        ...(summary.analytics_config ?? {}),
        budgetLimits: summary.analytics_config?.budgetLimits ?? summary.budget_limits ?? {},
        storagePath: join(filepath, '..'),
      }
    );

    analytics.startTime = summary.start_time;
    analytics.endTime = summary.end_time;
    analytics.iterations = summary.iterations;

    return analytics;
  }

  /**
   * Format duration in human-readable format
   * @param {number} ms - Duration in milliseconds
   * @returns {string} Formatted duration
   */
  static formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

export default IterationAnalytics;
