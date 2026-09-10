/**
 * Tests for EarlyStopping
 *
 * Run with: node tools/ralph-external/early-stopping.test.mjs
 */

import { EarlyStopping } from './early-stopping.mjs';
import { IterationAnalytics } from './iteration-analytics.mjs';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { test, after } from 'node:test';
import assert from 'assert';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'aiwg-early-stopping-'));
after(cleanup);

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function setup() {
  cleanup();
  mkdirSync(TEST_DIR, { recursive: true });
}

// Test: Basic initialization
test('EarlyStopping initializes with defaults', () => {
  const earlyStopping = new EarlyStopping();

  const config = earlyStopping.getConfig();
  assert.strictEqual(config.highConfidenceThreshold, 0.95);
  assert.strictEqual(config.plateauConsecutiveCount, 3);
  assert.strictEqual(config.plateauImprovementThreshold, 0.02);
  assert.strictEqual(config.minQualityThreshold, 70);
  assert.strictEqual(config.requireVerification, true);
});

// Test: Custom configuration
test('EarlyStopping accepts custom config', () => {
  const earlyStopping = new EarlyStopping({
    highConfidenceThreshold: 0.90,
    plateauConsecutiveCount: 2,
    minQualityThreshold: 80,
  });

  const config = earlyStopping.getConfig();
  assert.strictEqual(config.highConfidenceThreshold, 0.90);
  assert.strictEqual(config.plateauConsecutiveCount, 2);
  assert.strictEqual(config.minQualityThreshold, 80);
});

// Test: No stop on first iteration
test('shouldStop() returns false on first iteration', () => {
  const earlyStopping = new EarlyStopping();

  earlyStopping.recordIterationResult(1, {
    quality_score: 75,
    confidence: 0.80,
    verification_status: 'passed',
    quality_delta: 0,
  });

  const decision = earlyStopping.shouldStop(1);
  assert.strictEqual(decision.stop, false);
  assert.strictEqual(decision.trigger, 'none');
});

// Test: High confidence + verification triggers stop
test('High confidence + verification passed triggers stop', () => {
  const earlyStopping = new EarlyStopping({
    highConfidenceThreshold: 0.95,
    requireVerification: true,
    minQualityThreshold: 70,
  });

  earlyStopping.recordIterationResult(1, {
    quality_score: 85,
    confidence: 0.96,
    verification_status: 'passed',
    quality_delta: 0,
  });

  const decision = earlyStopping.shouldStop(1);
  assert.strictEqual(decision.stop, true);
  assert.strictEqual(decision.trigger, 'high_confidence');
  assert(decision.reason.includes('High confidence'));
  assert(decision.reason.includes('verification passed'));
  assert.strictEqual(decision.confidence, 0.96);
});

// Test: High confidence but verification failed
test('High confidence without verification does not stop (when required)', () => {
  const earlyStopping = new EarlyStopping({
    highConfidenceThreshold: 0.95,
    requireVerification: true,
  });

  earlyStopping.recordIterationResult(1, {
    quality_score: 85,
    confidence: 0.96,
    verification_status: 'failed',
    quality_delta: 0,
  });

  const decision = earlyStopping.shouldStop(1);
  assert.strictEqual(decision.stop, false);
  // When not stopping, we get the generic continuation message
  assert(decision.reason.includes('Continuing iteration'));
});

// Test: High confidence without verification requirement
test('High confidence stops when verification not required', () => {
  const earlyStopping = new EarlyStopping({
    highConfidenceThreshold: 0.95,
    requireVerification: false,
  });

  earlyStopping.recordIterationResult(1, {
    quality_score: 85,
    confidence: 0.96,
    verification_status: 'failed',
    quality_delta: 0,
  });

  const decision = earlyStopping.shouldStop(1);
  assert.strictEqual(decision.stop, true);
  assert.strictEqual(decision.trigger, 'high_confidence');
});

// Test: Quality below minimum threshold
test('High confidence with low quality does not stop', () => {
  const earlyStopping = new EarlyStopping({
    highConfidenceThreshold: 0.95,
    minQualityThreshold: 70,
    requireVerification: false,
  });

  earlyStopping.recordIterationResult(1, {
    quality_score: 65, // Below threshold
    confidence: 0.96,
    verification_status: 'passed',
    quality_delta: 0,
  });

  const decision = earlyStopping.shouldStop(1);
  assert.strictEqual(decision.stop, false);
});

// Test: Quality plateau detection
test('Quality plateau triggers stop after consecutive low improvements', () => {
  const earlyStopping = new EarlyStopping({
    plateauConsecutiveCount: 3,
    plateauImprovementThreshold: 0.02, // 2%
    enablePlateauDetection: true,
  });

  // Iteration 1: quality 70
  earlyStopping.recordIterationResult(1, {
    quality_score: 70,
    confidence: 0.80,
    verification_status: 'passed',
    quality_delta: 0,
  });

  // Iteration 2: quality 71 (delta: +1, 1.43% improvement - below 2%)
  earlyStopping.recordIterationResult(2, {
    quality_score: 71,
    confidence: 0.82,
    verification_status: 'passed',
    quality_delta: 1,
  });

  // Iteration 3: quality 71.5 (delta: +0.5, 0.7% improvement - below 2%)
  earlyStopping.recordIterationResult(3, {
    quality_score: 71.5,
    confidence: 0.83,
    verification_status: 'passed',
    quality_delta: 0.5,
  });

  // Iteration 4: quality 72 (delta: +0.5, 0.7% improvement - below 2%)
  earlyStopping.recordIterationResult(4, {
    quality_score: 72,
    confidence: 0.84,
    verification_status: 'passed',
    quality_delta: 0.5,
  });

  const decision = earlyStopping.shouldStop(4);
  assert.strictEqual(decision.stop, true);
  assert.strictEqual(decision.trigger, 'quality_plateau');
  assert(decision.reason.includes('Quality plateau detected'));
  assert(decision.reason.includes('3 consecutive iterations'));
});

// Test: Quality plateau not detected with significant improvement
test('Quality plateau not detected when improvements exceed threshold', () => {
  const earlyStopping = new EarlyStopping({
    plateauConsecutiveCount: 3,
    plateauImprovementThreshold: 0.02, // 2%
  });

  // Iteration 1: 70
  earlyStopping.recordIterationResult(1, {
    quality_score: 70,
    confidence: 0.80,
    verification_status: 'passed',
    quality_delta: 0,
  });

  // Iteration 2: 73 (4.3% improvement - above threshold)
  earlyStopping.recordIterationResult(2, {
    quality_score: 73,
    confidence: 0.82,
    verification_status: 'passed',
    quality_delta: 3,
  });

  // Iteration 3: 75 (2.7% improvement - above threshold)
  earlyStopping.recordIterationResult(3, {
    quality_score: 75,
    confidence: 0.84,
    verification_status: 'passed',
    quality_delta: 2,
  });

  const decision = earlyStopping.shouldStop(3);
  assert.strictEqual(decision.stop, false);
  assert(decision.reason.includes('Continuing iteration') || decision.reason.includes('Quality still improving'));
});

// Test: Integration with IterationAnalytics for diminishing returns
test('Diminishing returns detection via IterationAnalytics', () => {
  setup();

  const analytics = new IterationAnalytics('test-loop', 'Test task', {
    storagePath: TEST_DIR,
    diminishingReturnsThreshold: 0.05,
    consecutiveCountThreshold: 2,
  });

  const earlyStopping = new EarlyStopping(
    { enableDiminishingReturns: true },
    analytics
  );

  // Record iterations in both systems
  const iterations = [
    { iteration_number: 1, quality_score: 70, quality_delta: 0 },
    { iteration_number: 2, quality_score: 72, quality_delta: 2 }, // 2.86% < 5%
    { iteration_number: 3, quality_score: 73, quality_delta: 1 }, // 1.39% < 5%
  ];

  iterations.forEach(it => {
    analytics.recordIteration({
      ...it,
      tokens_used: 1000,
      token_cost_usd: 0.01,
      execution_time_ms: 5000,
      verification_status: 'passed',
      output_snapshot_path: `/path/${it.iteration_number}`,
    });

    earlyStopping.recordIterationResult(it.iteration_number, {
      quality_score: it.quality_score,
      confidence: 0.85,
      verification_status: 'passed',
      quality_delta: it.quality_delta,
    });
  });

  const decision = earlyStopping.shouldStop(3);
  assert.strictEqual(decision.stop, true);
  assert.strictEqual(decision.trigger, 'diminishing_returns');
  assert(decision.reason.includes('Diminishing returns detected'));
});

// Test: Configure method updates settings
test('configure() updates configuration', () => {
  const earlyStopping = new EarlyStopping();

  earlyStopping.configure({
    highConfidenceThreshold: 0.90,
    minQualityThreshold: 75,
  });

  const config = earlyStopping.getConfig();
  assert.strictEqual(config.highConfidenceThreshold, 0.90);
  assert.strictEqual(config.minQualityThreshold, 75);
  // Other settings preserved
  assert.strictEqual(config.plateauConsecutiveCount, 3);
});

// Test: Stopping reason tracking
test('getStoppingReason() returns reason after stop', () => {
  const earlyStopping = new EarlyStopping({
    requireVerification: false,
  });

  earlyStopping.recordIterationResult(1, {
    quality_score: 85,
    confidence: 0.96,
    verification_status: 'passed',
    quality_delta: 0,
  });

  const decision = earlyStopping.shouldStop(1);
  assert.strictEqual(decision.stop, true);

  const reason = earlyStopping.getStoppingReason();
  assert(reason !== null);
  assert(reason.includes('High confidence'));
});

// Test: Stopping details tracking
test('getStoppingDetails() returns details after stop', () => {
  const earlyStopping = new EarlyStopping({
    requireVerification: false,
  });

  earlyStopping.recordIterationResult(1, {
    quality_score: 85,
    confidence: 0.96,
    verification_status: 'passed',
    quality_delta: 0,
  });

  earlyStopping.shouldStop(1);

  const details = earlyStopping.getStoppingDetails();
  assert(details !== null);
  assert.strictEqual(details.confidence, 0.96);
  assert.strictEqual(details.quality_score, 85);
});

// Test: Reset functionality
test('reset() clears iteration history and stopping state', () => {
  const earlyStopping = new EarlyStopping();

  earlyStopping.recordIterationResult(1, {
    quality_score: 85,
    confidence: 0.96,
    verification_status: 'passed',
    quality_delta: 0,
  });

  earlyStopping.shouldStop(1);

  // Before reset
  assert(earlyStopping.getIterationHistory().length > 0);

  earlyStopping.reset();

  // After reset
  assert.strictEqual(earlyStopping.getIterationHistory().length, 0);
  assert.strictEqual(earlyStopping.getStoppingReason(), null);
  assert.strictEqual(earlyStopping.getStoppingDetails(), null);
});

// Test: Generate summary
test('generateSummary() produces comprehensive report', () => {
  const earlyStopping = new EarlyStopping({
    requireVerification: false,
  });

  earlyStopping.recordIterationResult(1, {
    quality_score: 85,
    confidence: 0.96,
    verification_status: 'passed',
    quality_delta: 0,
  });

  const summary = earlyStopping.generateSummary();

  assert.strictEqual(summary.total_iterations, 1);
  assert.strictEqual(summary.stopped_early, true);
  assert.strictEqual(summary.stopping_trigger, 'high_confidence');
  assert(summary.stopping_reason.includes('High confidence'));
  assert.strictEqual(summary.final_quality, 85);
  assert.strictEqual(summary.final_confidence, 0.96);
  assert(summary.config !== undefined);
});

// Test: Summary with no iterations
test('generateSummary() handles empty history', () => {
  const earlyStopping = new EarlyStopping();

  const summary = earlyStopping.generateSummary();

  assert.strictEqual(summary.total_iterations, 0);
  assert.strictEqual(summary.stopped_early, false);
  assert.strictEqual(summary.reason, 'No iterations completed');
});

// Test: Multiple stopping criteria priority
test('High confidence takes priority over plateau detection', () => {
  const earlyStopping = new EarlyStopping({
    highConfidenceThreshold: 0.95,
    requireVerification: false,
    plateauConsecutiveCount: 2,
  });

  // Set up plateau conditions
  earlyStopping.recordIterationResult(1, {
    quality_score: 70,
    confidence: 0.80,
    verification_status: 'passed',
    quality_delta: 0,
  });

  earlyStopping.recordIterationResult(2, {
    quality_score: 71,
    confidence: 0.82,
    verification_status: 'passed',
    quality_delta: 1,
  });

  // Final iteration has high confidence
  earlyStopping.recordIterationResult(3, {
    quality_score: 72,
    confidence: 0.96, // High confidence
    verification_status: 'passed',
    quality_delta: 1,
  });

  const decision = earlyStopping.shouldStop(3);
  assert.strictEqual(decision.stop, true);
  assert.strictEqual(decision.trigger, 'high_confidence'); // Not plateau
});

// Test: Iteration history tracking
test('getIterationHistory() returns all recorded iterations', () => {
  const earlyStopping = new EarlyStopping();

  earlyStopping.recordIterationResult(1, {
    quality_score: 70,
    confidence: 0.80,
    verification_status: 'passed',
    quality_delta: 0,
  });

  earlyStopping.recordIterationResult(2, {
    quality_score: 75,
    confidence: 0.85,
    verification_status: 'passed',
    quality_delta: 5,
  });

  const history = earlyStopping.getIterationHistory();
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].iteration_number, 1);
  assert.strictEqual(history[1].iteration_number, 2);
  assert.strictEqual(history[1].quality_score, 75);
});

// Test: Plateau detection with insufficient iterations
test('Plateau detection requires minimum consecutive iterations', () => {
  const earlyStopping = new EarlyStopping({
    plateauConsecutiveCount: 3,
  });

  earlyStopping.recordIterationResult(1, {
    quality_score: 70,
    confidence: 0.80,
    verification_status: 'passed',
    quality_delta: 0,
  });

  earlyStopping.recordIterationResult(2, {
    quality_score: 71,
    confidence: 0.81,
    verification_status: 'passed',
    quality_delta: 1,
  });

  const decision = earlyStopping.shouldStop(2);
  assert.strictEqual(decision.stop, false);
});

for (const [field, values] of [
  ['highConfidenceThreshold', [NaN, Infinity, -0.1, 1.1, '0.95']],
  ['plateauImprovementThreshold', [NaN, Infinity, -0.1, 1.1]],
  ['minQualityThreshold', [NaN, Infinity, -1, 101]],
  ['plateauConsecutiveCount', [0, 1, 2.5, Infinity]],
  ['requireVerification', ['false', 0, null]],
  ['enablePlateauDetection', ['false']],
  ['enableDiminishingReturns', ['false']],
]) {
  for (const value of values) {
    test(`rejects invalid ${field}: ${String(value)} without changing configuration`, () => {
      assert.throws(() => new EarlyStopping({ [field]: value }), new RegExp(field));
      const stopping = new EarlyStopping();
      const before = stopping.getConfig();
      assert.throws(() => stopping.configure({ [field]: value }), new RegExp(field));
      assert.deepStrictEqual(stopping.getConfig(), before);
    });
  }
}

const validResult = { quality_score: 75, confidence: 0.8, quality_delta: 0, verification_status: 'passed' };
for (const [field, values] of [
  ['quality_score', [NaN, Infinity, -1, 101, '75']],
  ['confidence', [NaN, Infinity, -0.1, 1.1, '0.8']],
  ['quality_delta', [NaN, Infinity, '1']],
  ['verification_status', ['unknown', null]],
  ['timestamp', ['invalid', null]],
]) {
  for (const value of values) {
    test(`rejects invalid result ${field}: ${String(value)} before recording`, () => {
      const stopping = new EarlyStopping();
      assert.throws(() => stopping.recordIterationResult(1, { ...validResult, [field]: value }), new RegExp(field));
      assert.deepStrictEqual(stopping.getIterationHistory(), []);
    });
  }
}

test('rejects invalid iteration numbers and missing result objects', () => {
  const stopping = new EarlyStopping();
  for (const iteration of [0, -1, 1.5, NaN, Infinity, '1']) {
    assert.throws(() => stopping.recordIterationResult(iteration, validResult), /iteration/);
  }
  assert.throws(() => stopping.recordIterationResult(1, null), /object/);
  assert.deepStrictEqual(stopping.getIterationHistory(), []);
});

test('accepts finite boundary values and negative quality deltas', () => {
  const stopping = new EarlyStopping({ highConfidenceThreshold: 0, minQualityThreshold: 100, plateauImprovementThreshold: 1, plateauConsecutiveCount: 2 });
  stopping.recordIterationResult(1, { quality_score: 0, confidence: 0, quality_delta: -100, verification_status: 'void' });
  stopping.recordIterationResult(2, { quality_score: 100, confidence: 1, quality_delta: 100, verification_status: 'skipped', timestamp: '2026-09-10T00:00:00Z' });
  assert.strictEqual(stopping.getIterationHistory().length, 2);
});
