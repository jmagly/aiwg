/**
 * Early Stopping for External Ralph Loop
 *
 * Stops iteration when high confidence AND verification passed, or when
 * quality plateau detected. Prevents wasted iterations and token costs.
 *
 * @implements @.aiwg/requirements/use-cases/UC-149-early-stopping.md
 * @research @.aiwg/research/findings/REF-015-self-refine.md
 * @issue #149
 */

/**
 * @typedef {Object} IterationResult
 * @property {number} iteration_number - Iteration number
 * @property {number} quality_score - Quality score (0-100)
 * @property {number} confidence - Agent confidence (0-1)
 * @property {string} verification_status - passed|failed|skipped
 * @property {number} quality_delta - Change from previous iteration
 * @property {string} timestamp - ISO timestamp
 */

/**
 * @typedef {Object} StoppingDecision
 * @property {boolean} stop - Whether to stop iteration
 * @property {string} reason - Explanation of stopping decision
 * @property {number} confidence - Confidence in decision (0-1)
 * @property {string} trigger - Which stopping criterion triggered
 * @property {Object} [details] - Additional details about the decision
 */

/**
 * @typedef {Object} EarlyStoppingConfig
 * @property {number} highConfidenceThreshold - Confidence threshold for early stop (default: 0.95)
 * @property {number} plateauConsecutiveCount - Consecutive iterations for plateau (default: 3)
 * @property {number} plateauImprovementThreshold - Quality improvement % threshold (default: 0.02 = 2%)
 * @property {number} minQualityThreshold - Minimum quality to consider stopping (default: 70)
 * @property {boolean} requireVerification - Require verification to stop early (default: true)
 * @property {boolean} enablePlateauDetection - Enable quality plateau detection (default: true)
 * @property {boolean} enableDiminishingReturns - Use iteration analytics for DR (default: true)
 */

const DEFAULT_CONFIG = {
  highConfidenceThreshold: 0.95,
  plateauConsecutiveCount: 3,
  plateauImprovementThreshold: 0.02, // 2%
  minQualityThreshold: 70,
  requireVerification: true,
  enablePlateauDetection: true,
  enableDiminishingReturns: true,
};

const VERIFICATION_STATUSES = new Set(['passed', 'failed', 'skipped', 'void']);

export class EarlyStopping {
  /**
   * @param {Partial<EarlyStoppingConfig>} config - Configuration
   * @param {import('./iteration-analytics.mjs').IterationAnalytics} [iterationAnalytics] - Analytics instance
   */
  constructor(config = {}, iterationAnalytics = null) {
    this.config = this.validateConfig({ ...DEFAULT_CONFIG, ...config });
    this.iterationHistory = [];
    this.iterationAnalytics = iterationAnalytics;
    this.stoppingReason = null;
    this.stoppingDetails = null;
  }

  /**
   * Record iteration result
   * @param {number} iteration - Iteration number
   * @param {IterationResult} result - Iteration result
   */
  recordIterationResult(iteration, result) {
    this.validateIterationResult(iteration, result);
    const record = {
      iteration_number: iteration,
      quality_score: result.quality_score,
      confidence: result.confidence,
      verification_status: result.verification_status,
      quality_delta: result.quality_delta,
      timestamp: result.timestamp || new Date().toISOString(),
    };

    this.iterationHistory.push(record);
  }

  /**
   * Check if loop should stop
   * @param {number} iteration - Current iteration number
   * @returns {StoppingDecision}
   */
  shouldStop(iteration) {
    // Need at least one iteration
    if (this.iterationHistory.length === 0) {
      return {
        stop: false,
        reason: 'No iterations completed yet',
        confidence: 1.0,
        trigger: 'none',
      };
    }

    const currentIteration = this.iterationHistory[this.iterationHistory.length - 1];

    // Check high confidence criterion
    const highConfidenceStop = this.checkHighConfidence(currentIteration);
    if (highConfidenceStop.stop) {
      this.stoppingReason = highConfidenceStop.reason;
      this.stoppingDetails = highConfidenceStop.details;
      return highConfidenceStop;
    }

    // Check quality plateau
    if (this.config.enablePlateauDetection) {
      const plateauStop = this.checkQualityPlateau();
      if (plateauStop.stop) {
        this.stoppingReason = plateauStop.reason;
        this.stoppingDetails = plateauStop.details;
        return plateauStop;
      }
    }

    // Check diminishing returns from iteration analytics
    if (this.config.enableDiminishingReturns && this.iterationAnalytics) {
      const drStop = this.checkDiminishingReturns();
      if (drStop.stop) {
        this.stoppingReason = drStop.reason;
        this.stoppingDetails = drStop.details;
        return drStop;
      }
    }

    // No stopping criteria met
    return {
      stop: false,
      reason: 'Continuing iteration - no stopping criteria met',
      confidence: 0.7,
      trigger: 'none',
    };
  }

  /**
   * Check high confidence stopping criterion
   * @param {Object} iteration - Current iteration record
   * @returns {StoppingDecision}
   */
  checkHighConfidence(iteration) {
    const meetsConfidenceThreshold = iteration.confidence >= this.config.highConfidenceThreshold;
    const meetsQualityThreshold = iteration.quality_score >= this.config.minQualityThreshold;
    const verificationPassed = iteration.verification_status === 'passed';

    // High confidence + verification passed
    if (meetsConfidenceThreshold && meetsQualityThreshold) {
      if (this.config.requireVerification) {
        if (verificationPassed) {
          return {
            stop: true,
            reason: `High confidence (${(iteration.confidence * 100).toFixed(1)}%) AND verification passed`,
            confidence: iteration.confidence,
            trigger: 'high_confidence',
            details: {
              confidence: iteration.confidence,
              quality_score: iteration.quality_score,
              verification_status: iteration.verification_status,
            },
          };
        } else {
          // High confidence but verification not passed
          return {
            stop: false,
            reason: `High confidence but verification status: ${iteration.verification_status}`,
            confidence: iteration.confidence * 0.8, // Reduce confidence due to verification
            trigger: 'none',
          };
        }
      } else {
        // Verification not required
        return {
          stop: true,
          reason: `High confidence (${(iteration.confidence * 100).toFixed(1)}%) reached`,
          confidence: iteration.confidence,
          trigger: 'high_confidence',
          details: {
            confidence: iteration.confidence,
            quality_score: iteration.quality_score,
          },
        };
      }
    }

    return {
      stop: false,
      reason: 'High confidence threshold not met',
      confidence: iteration.confidence,
      trigger: 'none',
    };
  }

  /**
   * Check quality plateau stopping criterion
   * @returns {StoppingDecision}
   */
  checkQualityPlateau() {
    const requiredCount = this.config.plateauConsecutiveCount;

    // Need enough iterations for plateau detection
    if (this.iterationHistory.length < requiredCount) {
      return {
        stop: false,
        reason: `Insufficient iterations for plateau detection (${this.iterationHistory.length}/${requiredCount})`,
        confidence: 0.5,
        trigger: 'none',
      };
    }

    // Get recent iterations
    const recentIterations = this.iterationHistory.slice(-requiredCount);

    // Check if all recent iterations have minimal improvement
    let plateauDetected = true;
    const improvements = [];

    for (let i = 1; i < recentIterations.length; i++) {
      const prev = recentIterations[i - 1];
      const curr = recentIterations[i];

      // Calculate percentage improvement. A change from a zero-score baseline
      // is unbounded relative improvement — it must never read as plateau (#1767)
      const percentageImprovement = prev.quality_score > 0
        ? Math.abs(curr.quality_delta) / prev.quality_score
        : (Math.abs(curr.quality_delta) > 0 ? Number.POSITIVE_INFINITY : 0);

      improvements.push({
        iteration: curr.iteration_number,
        improvement: percentageImprovement,
        delta: curr.quality_delta,
      });

      // If any improvement exceeds threshold, no plateau
      if (percentageImprovement >= this.config.plateauImprovementThreshold) {
        plateauDetected = false;
        break;
      }
    }

    if (plateauDetected) {
      const avgQuality = recentIterations.reduce((sum, it) => sum + it.quality_score, 0) / recentIterations.length;

      return {
        stop: true,
        reason: `Quality plateau detected: ${requiredCount} consecutive iterations with <${(this.config.plateauImprovementThreshold * 100).toFixed(0)}% improvement`,
        confidence: 0.85,
        trigger: 'quality_plateau',
        details: {
          consecutive_count: requiredCount,
          improvements,
          average_quality: avgQuality,
          threshold: this.config.plateauImprovementThreshold,
        },
      };
    }

    return {
      stop: false,
      reason: 'Quality still improving above threshold',
      confidence: 0.7,
      trigger: 'none',
    };
  }

  /**
   * Check diminishing returns from iteration analytics
   * @returns {StoppingDecision}
   */
  checkDiminishingReturns() {
    if (!this.iterationAnalytics) {
      return {
        stop: false,
        reason: 'Iteration analytics not available',
        confidence: 0.5,
        trigger: 'none',
      };
    }

    const drResult = this.iterationAnalytics.detectDiminishingReturns();

    if (drResult.detected) {
      return {
        stop: true,
        reason: `Diminishing returns detected: ${drResult.reason}`,
        confidence: 0.80,
        trigger: 'diminishing_returns',
        details: {
          detected_at_iteration: drResult.iteration,
          analytics_reason: drResult.reason,
        },
      };
    }

    return {
      stop: false,
      reason: 'Diminishing returns not detected',
      confidence: 0.7,
      trigger: 'none',
    };
  }

  /**
   * Get explanation of why loop stopped
   * @returns {string|null}
   */
  getStoppingReason() {
    return this.stoppingReason;
  }

  /**
   * Get detailed stopping information
   * @returns {Object|null}
   */
  getStoppingDetails() {
    return this.stoppingDetails;
  }

  /**
   * Configure stopping thresholds
   * @param {Partial<EarlyStoppingConfig>} options - Configuration options
   */
  configure(options) {
    this.config = this.validateConfig({ ...this.config, ...options });
  }

  /**
   * Get current configuration
   * @returns {EarlyStoppingConfig}
   */
  getConfig() {
    return { ...this.config };
  }

  /**
   * Get iteration history
   * @returns {Object[]}
   */
  getIterationHistory() {
    return [...this.iterationHistory];
  }

  /**
   * Reset stopping state (for testing or resumption)
   */
  reset() {
    this.iterationHistory = [];
    this.stoppingReason = null;
    this.stoppingDetails = null;
  }

  /**
   * Generate stopping summary report
   * @returns {Object}
   */
  generateSummary() {
    if (this.iterationHistory.length === 0) {
      return {
        total_iterations: 0,
        stopped_early: false,
        reason: 'No iterations completed',
      };
    }

    const lastIteration = this.iterationHistory[this.iterationHistory.length - 1];
    const stopDecision = this.shouldStop(lastIteration.iteration_number);

    return {
      total_iterations: this.iterationHistory.length,
      stopped_early: stopDecision.stop,
      stopping_trigger: stopDecision.trigger,
      stopping_reason: stopDecision.reason,
      stopping_confidence: stopDecision.confidence,
      final_quality: lastIteration.quality_score,
      final_confidence: lastIteration.confidence,
      final_verification: lastIteration.verification_status,
      config: this.config,
      details: stopDecision.details,
    };
  }

  validateConfig(config) {
    const finiteRange = (name, value, min, max) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new RangeError(`${name} must be a finite number between ${min} and ${max}`);
      }
    };
    finiteRange('highConfidenceThreshold', config.highConfidenceThreshold, 0, 1);
    finiteRange('plateauImprovementThreshold', config.plateauImprovementThreshold, 0, 1);
    finiteRange('minQualityThreshold', config.minQualityThreshold, 0, 100);
    if (!Number.isInteger(config.plateauConsecutiveCount) || config.plateauConsecutiveCount < 2) {
      throw new RangeError('plateauConsecutiveCount must be an integer of at least 2');
    }
    for (const name of ['requireVerification', 'enablePlateauDetection', 'enableDiminishingReturns']) {
      if (typeof config[name] !== 'boolean') throw new TypeError(`${name} must be boolean`);
    }
    return { ...config };
  }

  validateIterationResult(iteration, result) {
    if (!Number.isInteger(iteration) || iteration < 1) throw new RangeError('iteration must be a positive integer');
    if (!result || typeof result !== 'object') throw new TypeError('iteration result must be an object');
    if (typeof result.quality_score !== 'number' || !Number.isFinite(result.quality_score) || result.quality_score < 0 || result.quality_score > 100) {
      throw new RangeError('quality_score must be a finite number between 0 and 100');
    }
    if (typeof result.confidence !== 'number' || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
      throw new RangeError('confidence must be a finite number between 0 and 1');
    }
    if (typeof result.quality_delta !== 'number' || !Number.isFinite(result.quality_delta)) throw new TypeError('quality_delta must be finite');
    if (!VERIFICATION_STATUSES.has(result.verification_status)) throw new TypeError(`Invalid verification_status: ${result.verification_status}`);
    if (result.timestamp !== undefined && (typeof result.timestamp !== 'string' || !Number.isFinite(Date.parse(result.timestamp)))) {
      throw new TypeError('timestamp must be a valid date-time string');
    }
  }
}

export default EarlyStopping;
