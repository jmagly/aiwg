/**
 * Tests for BestOutputTracker
 *
 * @tests @tools/ralph-external/best-output-tracker.mjs
 * @requirement @.aiwg/requirements/use-cases/UC-168-best-output-selection.md
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BestOutputTracker } from './best-output-tracker.mjs';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'aiwg-best-output-test-'));

describe('BestOutputTracker', () => {
  let tracker;
  let testArtifactPath;

  beforeEach(() => {
    // Clean test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    // Create test artifact
    testArtifactPath = join(TEST_DIR, 'test-artifact.md');
    writeFileSync(testArtifactPath, '# Test Content\n\nSome content.');

    // Initialize tracker
    tracker = new BestOutputTracker('test-loop-001', {
      storage_path: join(TEST_DIR, 'tracking'),
    });
  });

  afterEach(() => {
    // Clean up
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('recordIteration', () => {
    it('should record an iteration with quality score', () => {
      const record = tracker.recordIteration({
        iteration_number: 1,
        dimensions: {
          validation: 0.8,
          completeness: 0.7,
          correctness: 0.9,
          readability: 0.8,
          efficiency: 0.7,
        },
        artifacts: [testArtifactPath],
      });

      assert.equal(record.iteration_number, 1);
      assert.ok(record.quality_score > 0);
      assert.equal(record.quality_delta, null); // First iteration has no delta
      assert.equal(record.verification_status, 'skipped');
    });

    it('should calculate quality delta for subsequent iterations', () => {
      tracker.recordIteration({
        iteration_number: 1,
        dimensions: {
          validation: 0.7,
          completeness: 0.7,
          correctness: 0.7,
          readability: 0.7,
          efficiency: 0.7,
        },
        artifacts: [testArtifactPath],
      });

      const record2 = tracker.recordIteration({
        iteration_number: 2,
        dimensions: {
          validation: 0.9,
          completeness: 0.9,
          correctness: 0.9,
          readability: 0.9,
          efficiency: 0.9,
        },
        artifacts: [testArtifactPath],
      });

      assert.ok(record2.quality_delta > 0); // Should show improvement
    });

    it('should snapshot artifacts', () => {
      const record = tracker.recordIteration({
        iteration_number: 1,
        dimensions: {
          validation: 1.0,
          completeness: 1.0,
          correctness: 1.0,
          readability: 1.0,
          efficiency: 1.0,
        },
        artifacts: [testArtifactPath],
      });

      assert.ok(existsSync(record.snapshot_path));
      assert.ok(record.artifacts.length > 0);
    });
  });

  describe('getBest', () => {
    it('should track the best iteration', () => {
      // Iteration 1: 70%
      tracker.recordIteration({
        iteration_number: 1,
        dimensions: {
          validation: 0.7,
          completeness: 0.7,
          correctness: 0.7,
          readability: 0.7,
          efficiency: 0.7,
        },
        artifacts: [testArtifactPath],
      });

      // Iteration 2: 85% (peak)
      tracker.recordIteration({
        iteration_number: 2,
        dimensions: {
          validation: 0.9,
          completeness: 0.85,
          correctness: 0.85,
          readability: 0.8,
          efficiency: 0.8,
        },
        artifacts: [testArtifactPath],
      });

      // Iteration 3: 75% (degraded)
      tracker.recordIteration({
        iteration_number: 3,
        dimensions: {
          validation: 0.75,
          completeness: 0.75,
          correctness: 0.75,
          readability: 0.75,
          efficiency: 0.75,
        },
        artifacts: [testArtifactPath],
      });

      const best = tracker.getBest();
      assert.equal(best.iteration_number, 2); // Should be iteration 2, not final
      assert.ok(best.quality_score >= 80);
    });

    it('excludes a VOID iteration from best-output even at peak quality (#1776)', () => {
      // Iteration 1: 70%, verified
      tracker.recordIteration({
        iteration_number: 1,
        dimensions: { validation: 0.7, completeness: 0.7, correctness: 0.7, readability: 0.7, efficiency: 0.7 },
        artifacts: [testArtifactPath],
        verification_status: 'passed',
      });
      // Iteration 2: 95%, but VOID (eval harness voided it — e.g. lint violation)
      tracker.recordIteration({
        iteration_number: 2,
        dimensions: { validation: 1, completeness: 0.95, correctness: 0.95, readability: 0.9, efficiency: 0.9 },
        artifacts: [testArtifactPath],
        verification_status: 'void',
      });

      // The higher-scoring iteration 2 is VOID → best stays iteration 1.
      const best = tracker.getBest();
      assert.equal(best.iteration_number, 1);
    });

    it('accepts a VOID iteration as best when human-overridden (#1776)', () => {
      tracker.recordIteration({
        iteration_number: 1,
        dimensions: { validation: 0.7, completeness: 0.7, correctness: 0.7, readability: 0.7, efficiency: 0.7 },
        artifacts: [testArtifactPath],
        verification_status: 'passed',
      });
      tracker.recordIteration({
        iteration_number: 2,
        dimensions: { validation: 1, completeness: 0.95, correctness: 0.95, readability: 0.9, efficiency: 0.9 },
        artifacts: [testArtifactPath],
        verification_status: 'void',
        eval_human_override: true,
      });

      const best = tracker.getBest();
      assert.equal(best.iteration_number, 2);
    });
  });

  describe('selectOutput', () => {
    beforeEach(() => {
      // Create quality trajectory: 72% → 85% (peak) → 83% (slight degradation)
      tracker.recordIteration({
        iteration_number: 1,
        dimensions: {
          validation: 0.7,
          completeness: 0.72,
          correctness: 0.72,
          readability: 0.72,
          efficiency: 0.75,
        },
        artifacts: [testArtifactPath],
        verification_status: 'passed',
      });

      tracker.recordIteration({
        iteration_number: 2,
        dimensions: {
          validation: 0.85,
          completeness: 0.85,
          correctness: 0.87,
          readability: 0.83,
          efficiency: 0.85,
        },
        artifacts: [testArtifactPath],
        verification_status: 'passed',
      });

      tracker.recordIteration({
        iteration_number: 3,
        dimensions: {
          validation: 0.83,
          completeness: 0.83,
          correctness: 0.83,
          readability: 0.82,
          efficiency: 0.83,
        },
        artifacts: [testArtifactPath],
        verification_status: 'passed',
      });
    });

    it('should select highest quality iteration', () => {
      const selection = tracker.selectOutput();

      assert.equal(selection.selected_iteration, 2); // Peak iteration
      assert.equal(selection.final_iteration, 3);
      assert.equal(selection.degradation_detected, true);
      assert.ok(selection.quality_score > selection.final_quality);
    });

    it('should respect quality threshold', () => {
      // Lower threshold to 60
      tracker.config.selection.threshold = 60;

      const selection = tracker.selectOutput();
      assert.equal(selection.selected_iteration, 2);
    });

    it('should handle highest_quality mode', () => {
      tracker.config.selection.mode = 'highest_quality';
      tracker.config.selection.require_verification = false;

      const selection = tracker.selectOutput();
      assert.equal(selection.selected_iteration, 2);
      assert.ok(selection.reason.includes('Highest quality'));
    });

    it('should handle most_recent_above_threshold mode', () => {
      tracker.config.selection.mode = 'most_recent_above_threshold';
      tracker.config.selection.threshold = 70;

      const selection = tracker.selectOutput();
      assert.equal(selection.selected_iteration, 3); // Most recent above 70%
      assert.ok(selection.reason.includes('Most recent'));
    });

    it('should handle no verified iterations', () => {
      // Mark all as failed
      for (const iteration of tracker.iterations) {
        iteration.verification_status = 'failed';
      }

      const selection = tracker.selectOutput();
      assert.equal(selection.selected_iteration, 2); // Still selects best
      assert.ok(selection.reason.includes('no verified'));
    });

    it('refuses to select when every iteration is VOID without a human override', () => {
      tracker = new BestOutputTracker('only-void', { storage_path: join(TEST_DIR, 'only-void') });
      tracker.recordIteration({
        iteration_number: 1,
        dimensions: { validation: 1, completeness: 1, correctness: 1, readability: 1, efficiency: 1 },
        artifacts: [testArtifactPath],
        verification_status: 'void',
      });

      assert.throws(() => tracker.selectOutput(), /all iterations are VOID without human override/);
    });
  });

  describe('generateSelectionReport', () => {
    it('should generate markdown report', () => {
      tracker.recordIteration({
        iteration_number: 1,
        dimensions: {
          validation: 0.7,
          completeness: 0.7,
          correctness: 0.7,
          readability: 0.7,
          efficiency: 0.7,
        },
        artifacts: [testArtifactPath],
      });

      tracker.recordIteration({
        iteration_number: 2,
        dimensions: {
          validation: 0.9,
          completeness: 0.9,
          correctness: 0.9,
          readability: 0.9,
          efficiency: 0.9,
        },
        artifacts: [testArtifactPath],
        verification_status: 'passed',
      });

      const selection = tracker.selectOutput();
      const report = tracker.generateSelectionReport(selection);

      assert.ok(report.includes('# Output Selection Report'));
      assert.ok(report.includes('## Quality Scores'));
      assert.ok(report.includes('## Selection Rationale'));
      assert.ok(report.includes('## Quality Trajectory'));
      assert.ok(report.includes('test-loop-001'));
    });

    it('should show degradation warning in report', () => {
      // Create degradation scenario
      tracker.recordIteration({
        iteration_number: 1,
        dimensions: {
          validation: 0.9,
          completeness: 0.9,
          correctness: 0.9,
          readability: 0.9,
          efficiency: 0.9,
        },
        artifacts: [testArtifactPath],
      });

      tracker.recordIteration({
        iteration_number: 2,
        dimensions: {
          validation: 0.6,
          completeness: 0.6,
          correctness: 0.6,
          readability: 0.6,
          efficiency: 0.6,
        },
        artifacts: [testArtifactPath],
      });

      const selection = tracker.selectOutput();
      const report = tracker.generateSelectionReport(selection);

      assert.ok(report.includes('Degradation Detected'));
      assert.ok(report.includes('degraded'));
    });
  });

  describe('detectDiminishingReturns', () => {
    it('should detect diminishing returns', () => {
      // 70 → 75 (+5) → 77 (+2) → 78 (+1) → 79 (+1)
      tracker.recordIteration({
        iteration_number: 1,
        dimensions: {
          validation: 0.7,
          completeness: 0.7,
          correctness: 0.7,
          readability: 0.7,
          efficiency: 0.7,
        },
        artifacts: [testArtifactPath],
      });

      tracker.recordIteration({
        iteration_number: 2,
        dimensions: {
          validation: 0.75,
          completeness: 0.75,
          correctness: 0.75,
          readability: 0.75,
          efficiency: 0.75,
        },
        artifacts: [testArtifactPath],
      });

      tracker.recordIteration({
        iteration_number: 3,
        dimensions: {
          validation: 0.77,
          completeness: 0.77,
          correctness: 0.77,
          readability: 0.77,
          efficiency: 0.77,
        },
        artifacts: [testArtifactPath],
      });

      tracker.recordIteration({
        iteration_number: 4,
        dimensions: {
          validation: 0.78,
          completeness: 0.78,
          correctness: 0.78,
          readability: 0.78,
          efficiency: 0.78,
        },
        artifacts: [testArtifactPath],
      });

      const result = tracker.detectDiminishingReturns(2, 5);
      assert.equal(result.detected, true);
      assert.ok(result.iteration >= 3);
    });

    it('should not detect when returns are not diminishing', () => {
      tracker.recordIteration({
        iteration_number: 1,
        dimensions: {
          validation: 0.5,
          completeness: 0.5,
          correctness: 0.5,
          readability: 0.5,
          efficiency: 0.5,
        },
        artifacts: [testArtifactPath],
      });

      tracker.recordIteration({
        iteration_number: 2,
        dimensions: {
          validation: 0.7,
          completeness: 0.7,
          correctness: 0.7,
          readability: 0.7,
          efficiency: 0.7,
        },
        artifacts: [testArtifactPath],
      });

      const result = tracker.detectDiminishingReturns(2, 5);
      assert.equal(result.detected, false);
    });
  });

  describe('persistence', () => {
    it('should save and load tracking data', () => {
      tracker.recordIteration({
        iteration_number: 1,
        dimensions: {
          validation: 0.8,
          completeness: 0.8,
          correctness: 0.8,
          readability: 0.8,
          efficiency: 0.8,
        },
        artifacts: [testArtifactPath],
      });

      // Create new tracker instance
      const tracker2 = new BestOutputTracker('test-loop-001', {
        storage_path: join(TEST_DIR, 'tracking'),
      });

      assert.equal(tracker2.iterations.length, 1);
      assert.equal(tracker2.iterations[0].iteration_number, 1);
    });
  });

  describe('getSummary', () => {
    it('should return summary statistics', () => {
      tracker.recordIteration({
        iteration_number: 1,
        dimensions: {
          validation: 0.7,
          completeness: 0.7,
          correctness: 0.7,
          readability: 0.7,
          efficiency: 0.7,
        },
        artifacts: [testArtifactPath],
        tokens_used: 1000,
        token_cost_usd: 0.01,
        execution_time_ms: 5000,
      });

      tracker.recordIteration({
        iteration_number: 2,
        dimensions: {
          validation: 0.9,
          completeness: 0.9,
          correctness: 0.9,
          readability: 0.9,
          efficiency: 0.9,
        },
        artifacts: [testArtifactPath],
        tokens_used: 1200,
        token_cost_usd: 0.012,
        execution_time_ms: 6000,
      });

      const summary = tracker.getSummary();

      assert.equal(summary.total_iterations, 2);
      assert.ok(summary.average_quality > 0);
      assert.ok(summary.best_quality >= summary.average_quality);
      assert.equal(summary.total_tokens, 2200);
      assert.equal(summary.total_cost_usd, 0.022);
      assert.equal(summary.total_time_ms, 11000);
    });
  });

  describe('exportCSV', () => {
    it('should export data as CSV', () => {
      tracker.recordIteration({
        iteration_number: 1,
        dimensions: {
          validation: 0.8,
          completeness: 0.8,
          correctness: 0.8,
          readability: 0.8,
          efficiency: 0.8,
        },
        artifacts: [testArtifactPath],
        tokens_used: 1000,
        token_cost_usd: 0.01,
        execution_time_ms: 5000,
        verification_status: 'passed',
      });

      const csv = tracker.exportCSV();

      assert.ok(csv.includes('iteration,timestamp,quality_score'));
      assert.ok(csv.includes('1,'));
      assert.ok(csv.includes('1000,'));
      assert.ok(csv.includes('passed'));
    });
  });

  describe('quality score calculation', () => {
    it('should calculate weighted quality score correctly', () => {
      const dimensions = {
        validation: 1.0,    // 30% weight
        completeness: 1.0,  // 25% weight
        correctness: 1.0,   // 25% weight
        readability: 1.0,   // 10% weight
        efficiency: 1.0,    // 10% weight
      };

      const score = tracker.calculateQualityScore(dimensions);
      assert.equal(score, 100); // Perfect score
    });

    it('should respect custom quality weights', () => {
      const customTracker = new BestOutputTracker('test-loop-002', {
        storage_path: join(TEST_DIR, 'tracking-custom'),
        quality_weights: {
          validation: 0.5,    // 50%
          completeness: 0.5,  // 50%
          correctness: 0.0,
          readability: 0.0,
          efficiency: 0.0,
        },
      });

      const dimensions = {
        validation: 0.8,
        completeness: 0.6,
        correctness: 0.0,
        readability: 0.0,
        efficiency: 0.0,
      };

      const score = customTracker.calculateQualityScore(dimensions);
      assert.equal(score, 70); // (0.8 * 50) + (0.6 * 50) = 70
    });

    it('should reject invalid dimensions and configuration', () => {
      const valid = { validation: 1, completeness: 1, correctness: 1, readability: 1, efficiency: 1 };
      for (const [dimension, value] of [
        ['validation', -0.01], ['completeness', 1.01], ['correctness', Number.NaN],
        ['readability', Number.POSITIVE_INFINITY], ['efficiency', '1'],
      ]) {
        assert.throws(() => tracker.calculateQualityScore({ ...valid, [dimension]: value }), /finite number between 0 and 1/);
      }
      assert.throws(() => tracker.calculateQualityScore({ ...valid, validation: undefined }), /Quality dimension validation/);
      assert.throws(() => new BestOutputTracker('bad-threshold', {
        storage_path: join(TEST_DIR, 'bad-threshold'), selection: { threshold: 101 },
      }), /threshold must be a finite number between 0 and 100/);
      assert.throws(() => new BestOutputTracker('bad-weights', {
        storage_path: join(TEST_DIR, 'bad-weights'), quality_weights: { validation: 0.5 },
      }), /weights must sum to 1/);
    });
  });
});
