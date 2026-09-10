/**
 * Basic tests for IterationAnalytics
 *
 * Run with: node tools/ralph-external/iteration-analytics.test.mjs
 */

import { IterationAnalytics } from './iteration-analytics.mjs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { test, after } from 'node:test';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import Ajv from 'ajv';
import yaml from 'js-yaml';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'aiwg-analytics-'));
after(cleanup);

const validMetrics = { iteration_number: 1, quality_score: 75, tokens_used: 10, token_cost_usd: 0.1, execution_time_ms: 100, verification_status: 'passed', output_snapshot_path: null };

test('save/load preserves budget and selection decisions and declared exploration policy', () => {
  setup();
  const analytics = new IterationAnalytics('reload', 'test', { storagePath: TEST_DIR,
    qualityThreshold: 60, selectionCriteria: 'most_recent_above_threshold',
    diminishingReturnsThreshold: 0.1, consecutiveCountThreshold: 3,
    budgetLimits: { total_tokens: 10 }, explorationQuota: { enabled: true, k: 1 },
  });
  analytics.recordIteration({ ...validMetrics, quality_score: 80 });
  analytics.recordIteration({ ...validMetrics, iteration_number: 2, quality_score: 79 });
  const loaded = IterationAnalytics.load(analytics.saveAnalytics());
  assert.deepStrictEqual(loaded.config, analytics.config);
  assert.deepStrictEqual(loaded.checkBudgetLimits(), analytics.checkBudgetLimits());
  assert.strictEqual(loaded.checkBudgetLimits().exhausted, true);
  assert.deepStrictEqual(loaded.checkExplorationQuota(), analytics.checkExplorationQuota());
  assert.deepStrictEqual(loaded.selectBestIteration(), analytics.selectBestIteration());
  assert.strictEqual(loaded.selectBestIteration().selected.iteration_number, 2);
});

test('load preserves legacy budget_limits and anchors writes to the artifact directory', () => {
  setup();
  const analytics = new IterationAnalytics('reload', 'test', { storagePath: TEST_DIR, budgetLimits: { total_tokens: 10 } });
  analytics.recordIteration(validMetrics);
  const filename = analytics.saveAnalytics();
  const summary = JSON.parse(readFileSync(filename, 'utf8'));
  delete summary.analytics_config;
  writeFileSync(filename, JSON.stringify(summary));
  const legacy = IterationAnalytics.load(filename);
  assert.strictEqual(legacy.checkBudgetLimits().exhausted, true);
  summary.analytics_config = { storagePath: join(TEST_DIR, 'must-not-exist') };
  writeFileSync(filename, JSON.stringify(summary));
  const loaded = IterationAnalytics.load(filename);
  assert.strictEqual(loaded.config.storagePath, TEST_DIR);
  assert.strictEqual(loaded.saveAnalytics(), filename);
  assert(!existsSync(join(TEST_DIR, 'must-not-exist')));
  summary.analytics_config = { qualityThreshold: 101 };
  writeFileSync(filename, JSON.stringify(summary));
  assert.throws(() => IterationAnalytics.load(filename), /qualityThreshold/);
  for (const config of [null, [], 'invalid']) {
    summary.analytics_config = config;
    writeFileSync(filename, JSON.stringify(summary));
    assert.throws(() => IterationAnalytics.load(filename), /analytics_config/);
  }
});

for (const [field, values] of [
  ['diminishingReturnsThreshold', [NaN, Infinity, -1, 2, '0.05']],
  ['consecutiveCountThreshold', [0, -1, 1.5, Infinity]],
  ['qualityThreshold', [-1, 101, NaN, '70']],
  ['selectionCriteria', ['unknown', null]],
  ['budgetLimits', [null, [], { total_tokens: '100' }, { spend_usd: -1 }, { total_tokens: 0 }, { total_tokens: Infinity }, { unknown: 1 }]],
  ['explorationQuota', [null, [], { k: 1.5 }, { k: -1 }, { k: '2' }, { enabled: 'true' }]],
  ['storagePath', ['', null]],
]) {
  for (const [index, value] of values.entries()) {
    test(`invalid configuration ${field} case ${index} cannot create storage`, () => {
      const storagePath = join(TEST_DIR, 'must-not-exist');
      assert.throws(() => new IterationAnalytics('validation', 'test', { storagePath, [field]: value }), new RegExp(field));
      assert(!existsSync(storagePath));
    });
  }
}

test('rejects unsafe loop identities and empty task before creating storage', () => {
  const storagePath = join(TEST_DIR, 'must-not-exist');
  for (const loopId of ['../escaped', '/tmp/escaped', 'a/b', 'a\\b', '', '..', null]) {
    assert.throws(() => new IterationAnalytics(loopId, 'test', { storagePath }), /loopId/);
  }
  assert.throws(() => new IterationAnalytics('valid', ' ', { storagePath }), /taskDescription/);
  assert(!existsSync(storagePath));
});

for (const [field, values] of [
  ['iteration_number', [0, -1, 1.5, NaN, '1']],
  ['quality_score', [-1, 101, NaN, Infinity, '75']],
  ['tokens_used', [-1, 1.5, Infinity, '10']],
  ['input_tokens', [-1, 1.5]], ['output_tokens', [-1, '1']],
  ['token_cost_usd', [-1, '2.5', Infinity]],
  ['tool_calls', [-1, 0.5, null]],
  ['execution_time_ms', [-1, NaN, Infinity, '100']],
  ['verification_status', ['invalid', null]],
  ['output_snapshot_path', [1, {}]],
  ['reflections', ['text', [1], null]],
  ['eval_human_override', ['true']],
  ['experiment', [[], { hypothesis: 1 }, { recorded_before_change: 'true' }, { result: 'invalid' }]],
  ['baseline_comparison', [[], { quality_score: '70' }, { quality_score: 70, tokens_used: -1 }]],
  ['eval_harness_result', [[], { status: 'invalid', optimizer_feedback: {} },
    { status: 'pass', optimizer_feedback: {}, private_diagnostics_ref: 2 },
    { status: 'pass', optimizer_feedback: {}, human_override: 'true' },
    { status: 'pass', optimizer_feedback: {}, _forbidden_fields_seen: [2] },
    { status: 'pass', optimizer_feedback: {}, leakage_audit: { checked: 'true', result: 'pass' } },
    { status: 'pass', optimizer_feedback: {}, leakage_audit: { checked: true, result: 'unknown' } },
  ]],
]) {
  for (const [index, value] of values.entries()) {
    test(`invalid metric ${field} case ${index} cannot alter history or saved output`, () => {
      setup();
      const analytics = new IterationAnalytics('validation', 'test', { storagePath: TEST_DIR });
      const filename = join(TEST_DIR, 'validation.json');
      const invalid = { ...validMetrics, [field]: value };
      assert.throws(() => analytics.recordIteration(invalid), new RegExp(field));
      assert.deepStrictEqual(analytics.iterations, []);
      assert(!existsSync(filename));
      analytics.recordIteration(validMetrics);
      const before = readFileSync(filename, 'utf8');
      assert.throws(() => analytics.recordIteration(invalid), new RegExp(field));
      assert.strictEqual(analytics.iterations.length, 1);
      assert.strictEqual(readFileSync(filename, 'utf8'), before);
    });
  }
}

test('rejects aggregate overflow before appending or saving', () => {
  setup();
  const analytics = new IterationAnalytics('overflow', 'test', { storagePath: TEST_DIR });
  analytics.recordIteration({ ...validMetrics, token_cost_usd: Number.MAX_VALUE });
  const before = readFileSync(join(TEST_DIR, 'overflow.json'), 'utf8');
  assert.throws(() => analytics.recordIteration({ ...validMetrics, iteration_number: 2, token_cost_usd: Number.MAX_VALUE }), /cumulative total/);
  assert.strictEqual(analytics.iterations.length, 1);
  assert.strictEqual(readFileSync(join(TEST_DIR, 'overflow.json'), 'utf8'), before);
});

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
test('IterationAnalytics initializes correctly', () => {
  setup();
  const analytics = new IterationAnalytics(
    'test-loop-001',
    'Test task',
    { storagePath: TEST_DIR }
  );

  assert.strictEqual(analytics.loopId, 'test-loop-001');
  assert.strictEqual(analytics.taskDescription, 'Test task');
  assert.strictEqual(analytics.iterations.length, 0);
});

// Test: Record iteration
test('recordIteration() tracks metrics correctly', () => {
  setup();
  const analytics = new IterationAnalytics(
    'test-loop-002',
    'Test task',
    { storagePath: TEST_DIR }
  );

  const record = analytics.recordIteration({
    iteration_number: 1,
    quality_score: 75,
    tokens_used: 1000,
    token_cost_usd: 0.01,
    execution_time_ms: 5000,
    verification_status: 'passed',
    output_snapshot_path: '/path/to/snapshot',
  });

  assert.strictEqual(record.iteration_number, 1);
  assert.strictEqual(record.quality_score, 75);
  assert.strictEqual(record.quality_delta, 0); // First iteration
  assert.strictEqual(analytics.iterations.length, 1);
});

// Test: Quality delta calculation
test('Quality delta calculated correctly', () => {
  setup();
  const analytics = new IterationAnalytics(
    'test-loop-003',
    'Test task',
    { storagePath: TEST_DIR }
  );

  analytics.recordIteration({
    iteration_number: 1,
    quality_score: 70,
    tokens_used: 1000,
    token_cost_usd: 0.01,
    execution_time_ms: 5000,
    verification_status: 'passed',
    output_snapshot_path: '/path/1',
  });

  const record2 = analytics.recordIteration({
    iteration_number: 2,
    quality_score: 85,
    tokens_used: 1000,
    token_cost_usd: 0.01,
    execution_time_ms: 5000,
    verification_status: 'passed',
    output_snapshot_path: '/path/2',
  });

  assert.strictEqual(record2.quality_delta, 15); // 85 - 70
});

// Test: Diminishing returns detection
test('detectDiminishingReturns() detects consecutive low deltas', () => {
  setup();
  const analytics = new IterationAnalytics(
    'test-loop-004',
    'Test task',
    {
      storagePath: TEST_DIR,
      diminishingReturnsThreshold: 0.05,
      consecutiveCountThreshold: 2,
    }
  );

  // First iteration: 70
  analytics.recordIteration({
    iteration_number: 1,
    quality_score: 70,
    tokens_used: 1000,
    token_cost_usd: 0.01,
    execution_time_ms: 5000,
    verification_status: 'passed',
    output_snapshot_path: '/path/1',
  });

  // Second iteration: 72 (delta: +2, 2.86% improvement - below 5%)
  analytics.recordIteration({
    iteration_number: 2,
    quality_score: 72,
    tokens_used: 1000,
    token_cost_usd: 0.01,
    execution_time_ms: 5000,
    verification_status: 'passed',
    output_snapshot_path: '/path/2',
  });

  // Third iteration: 73 (delta: +1, 1.39% improvement - below 5%)
  analytics.recordIteration({
    iteration_number: 3,
    quality_score: 73,
    tokens_used: 1000,
    token_cost_usd: 0.01,
    execution_time_ms: 5000,
    verification_status: 'passed',
    output_snapshot_path: '/path/3',
  });

  const result = analytics.detectDiminishingReturns();
  assert.strictEqual(result.detected, true);
  assert.strictEqual(result.iteration, 3);
});

// Test: Quality trajectory
test('getTrajectory() calculates trajectory correctly', () => {
  setup();
  const analytics = new IterationAnalytics(
    'test-loop-005',
    'Test task',
    { storagePath: TEST_DIR }
  );

  // Improving trajectory
  [70, 80, 90, 95].forEach((score, i) => {
    analytics.recordIteration({
      iteration_number: i + 1,
      quality_score: score,
      tokens_used: 1000,
      token_cost_usd: 0.01,
      execution_time_ms: 5000,
      verification_status: 'passed',
      output_snapshot_path: `/path/${i + 1}`,
    });
  });

  const trajectory = analytics.getTrajectory();
  assert.strictEqual(trajectory, 'improving');
});

// Test: Best output selection
test('getOptimalIteration() returns highest quality', () => {
  setup();
  const analytics = new IterationAnalytics(
    'test-loop-006',
    'Test task',
    { storagePath: TEST_DIR, qualityThreshold: 70 }
  );

  // Scores: 70, 85, 80 (peak at iteration 2)
  analytics.recordIteration({
    iteration_number: 1,
    quality_score: 70,
    tokens_used: 1000,
    token_cost_usd: 0.01,
    execution_time_ms: 5000,
    verification_status: 'passed',
    output_snapshot_path: '/path/1',
  });

  analytics.recordIteration({
    iteration_number: 2,
    quality_score: 85,
    tokens_used: 1000,
    token_cost_usd: 0.01,
    execution_time_ms: 5000,
    verification_status: 'passed',
    output_snapshot_path: '/path/2',
  });

  analytics.recordIteration({
    iteration_number: 3,
    quality_score: 80,
    tokens_used: 1000,
    token_cost_usd: 0.01,
    execution_time_ms: 5000,
    verification_status: 'passed',
    output_snapshot_path: '/path/3',
  });

  const optimal = analytics.getOptimalIteration();
  assert.strictEqual(optimal.iteration_number, 2);
  assert.strictEqual(optimal.quality_score, 85);
});

// Test: Summary generation
test('generateSummary() includes all required fields', () => {
  setup();
  const analytics = new IterationAnalytics(
    'test-loop-007',
    'Test task description',
    { storagePath: TEST_DIR }
  );

  analytics.recordIteration({
    iteration_number: 1,
    quality_score: 75,
    tokens_used: 1000,
    token_cost_usd: 0.01,
    execution_time_ms: 5000,
    verification_status: 'passed',
    output_snapshot_path: '/path/1',
  });

  const summary = analytics.generateSummary();

  assert.strictEqual(summary.loop_id, 'test-loop-007');
  assert.strictEqual(summary.task_description, 'Test task description');
  assert.strictEqual(summary.total_iterations, 1);
  assert.strictEqual(summary.total_tokens, 1000);
  assert.strictEqual(summary.total_cost_usd, 0.01);
  assert.strictEqual(summary.total_time_ms, 5000);
  assert.ok(summary.quality_trajectory);
});

// Test: Report generation
test('generateReport() produces markdown', () => {
  setup();
  const analytics = new IterationAnalytics(
    'test-loop-008',
    'Test task',
    { storagePath: TEST_DIR }
  );

  analytics.recordIteration({
    iteration_number: 1,
    quality_score: 75,
    tokens_used: 1000,
    token_cost_usd: 0.01,
    execution_time_ms: 5000,
    verification_status: 'passed',
    output_snapshot_path: '/path/1',
  });

  const report = analytics.generateReport();

  assert.ok(report.includes('# Ralph Loop Analytics'));
  assert.ok(report.includes('test-loop-008'));
  assert.ok(report.includes('## Summary'));
  assert.ok(report.includes('## Iteration History'));
  assert.ok(report.includes('Quality / 1K Tokens'));
  assert.ok(report.includes('Quality / Minute'));
  assert.ok(report.includes('Lift vs Random'));
  assert.ok(report.includes('## Quality Trajectory'));
  assert.ok(report.includes('## Recommendations'));
});

test('baseline comparison records lift over random walk', () => {
  setup();
  const analytics = new IterationAnalytics(
    'test-loop-baseline',
    'Test task',
    { storagePath: TEST_DIR }
  );

  const record = analytics.recordIteration({
    iteration_number: 1,
    quality_score: 80,
    tokens_used: 1000,
    token_cost_usd: 0.01,
    tool_calls: 2,
    execution_time_ms: 60000,
    verification_status: 'passed',
    output_snapshot_path: '/path/1',
    random_walk_baseline: {
      quality_score: 50,
      tokens_used: 2000,
      tool_calls: 5,
      execution_time_ms: 120000,
      source: 'synthetic-fixture',
    },
  });

  assert.strictEqual(record.baseline_comparison.baseline_type, 'random_walk');
  assert.strictEqual(record.baseline_comparison.source, 'synthetic-fixture');
  assert.strictEqual(record.baseline_comparison.quality_lift, 30);
  assert.strictEqual(record.baseline_comparison.quality_lift_pct, 0.6);
  assert.strictEqual(record.baseline_comparison.token_efficiency_lift, 55);
  assert.strictEqual(record.baseline_comparison.speed_efficiency_lift, 55);
  assert.strictEqual(record.baseline_comparison.tool_call_savings, 3);

  const summary = analytics.generateSummary();
  assert.strictEqual(summary.baseline_comparison.count, 1);
  assert.strictEqual(summary.baseline_comparison.best_quality_lift, 30);

  const report = analytics.generateReport();
  assert.ok(report.includes('Best Lift Over Random Baseline'));
  assert.ok(report.includes('Best Token-Efficiency Lift Over Random Baseline'));
  assert.ok(report.includes('Best Speed-Efficiency Lift Over Random Baseline'));
  assert.ok(report.includes('Token Lift vs Random'));
  assert.ok(report.includes('Speed Lift vs Random'));
  assert.ok(report.includes('| 1 | 80.0 | +0.0 | 1000 | 80.00 | 80.00 | 30.00 | 55.00 | 55.00 |'));
});

// Test: Export
test('export() creates both JSON and Markdown files', () => {
  setup();
  const analytics = new IterationAnalytics(
    'test-loop-009',
    'Test task',
    { storagePath: TEST_DIR }
  );

  analytics.recordIteration({
    iteration_number: 1,
    quality_score: 75,
    tokens_used: 1000,
    token_cost_usd: 0.01,
    execution_time_ms: 5000,
    verification_status: 'passed',
    output_snapshot_path: '/path/1',
  });

  const paths = analytics.export();

  assert.ok(existsSync(paths.json));
  assert.ok(existsSync(paths.markdown));
  assert.ok(paths.json.endsWith('.json'));
  assert.ok(paths.markdown.endsWith('.md'));
});

// Test: Load from file
test('load() restores analytics from JSON', () => {
  setup();
  const analytics = new IterationAnalytics(
    'test-loop-010',
    'Test task',
    { storagePath: TEST_DIR }
  );

  analytics.recordIteration({
    iteration_number: 1,
    quality_score: 75,
    tokens_used: 1000,
    token_cost_usd: 0.01,
    execution_time_ms: 5000,
    verification_status: 'passed',
    output_snapshot_path: '/path/1',
  });

  const jsonPath = analytics.saveAnalytics();
  const loaded = IterationAnalytics.load(jsonPath);

  assert.strictEqual(loaded.loopId, 'test-loop-010');
  assert.strictEqual(loaded.taskDescription, 'Test task');
  assert.strictEqual(loaded.iterations.length, 1);
  assert.strictEqual(loaded.iterations[0].quality_score, 75);
});

// Run all tests
{

  test('checkBudgetLimits() detects hard total token exhaustion', () => {
    setup();
    const analytics = new IterationAnalytics(
      'test-loop-011',
      'Budgeted task',
      {
        storagePath: TEST_DIR,
        budgetLimits: { total_tokens: 1500 },
      }
    );

    analytics.recordIteration({
      iteration_number: 1,
      quality_score: 70,
      tokens_used: 1000,
      token_cost_usd: 0.01,
      execution_time_ms: 5000,
      verification_status: 'passed',
      output_snapshot_path: '/path/1',
    });
    analytics.recordIteration({
      iteration_number: 2,
      quality_score: 80,
      tokens_used: 600,
      token_cost_usd: 0.01,
      execution_time_ms: 5000,
      verification_status: 'passed',
      output_snapshot_path: '/path/2',
    });

    const decision = analytics.checkBudgetLimits();
    assert.strictEqual(decision.exhausted, true);
    assert.strictEqual(decision.trigger, 'total_tokens_exhausted');

    const report = analytics.generateBudgetStopReport(decision.trigger);
    assert.strictEqual(report.stop_reason, 'total_tokens_exhausted');
    assert.strictEqual(report.selected_iteration, 2);
    assert.strictEqual(report.budgets.observed.total_tokens, 1600);
  });

  test('checkBudgetLimits() uses schema stop reason names', () => {
    setup();
    const spendAnalytics = new IterationAnalytics(
      'test-loop-011b',
      'Spend task',
      {
        storagePath: TEST_DIR,
        budgetLimits: { spend_usd: 0.01 },
      }
    );

    spendAnalytics.recordIteration({
      iteration_number: 1,
      quality_score: 70,
      tokens_used: 1000,
      token_cost_usd: 0.02,
      execution_time_ms: 5000,
      verification_status: 'failed',
      output_snapshot_path: '/path/1',
    });

    assert.strictEqual(spendAnalytics.checkBudgetLimits().trigger, 'spend_exhausted');

    const timeAnalytics = new IterationAnalytics(
      'test-loop-011c',
      'Time task',
      {
        storagePath: TEST_DIR,
        budgetLimits: { wall_clock_minutes: 0.01 },
      }
    );

    timeAnalytics.recordIteration({
      iteration_number: 1,
      quality_score: 70,
      tokens_used: 1000,
      token_cost_usd: 0.01,
      execution_time_ms: 1000,
      verification_status: 'failed',
      output_snapshot_path: '/path/1',
    });

    assert.strictEqual(timeAnalytics.checkBudgetLimits().trigger, 'wall_clock_exhausted');
  });

  test('checkExplorationQuota() requires structural variant after flat cycles', () => {
    setup();
    const analytics = new IterationAnalytics(
      'test-loop-012',
      'Flat task',
      {
        storagePath: TEST_DIR,
        diminishingReturnsThreshold: 0.05,
        explorationQuota: { enabled: true, k: 2 },
      }
    );

    [70, 71, 71.5].forEach((score, index) => {
      analytics.recordIteration({
        iteration_number: index + 1,
        quality_score: score,
        tokens_used: 1000,
        token_cost_usd: 0.01,
        execution_time_ms: 5000,
        verification_status: 'failed',
        output_snapshot_path: `/path/${index + 1}`,
        experiment: {
          hypothesis: `hypothesis ${index + 1}`,
          expected_failure_mode: 'same failure',
          distinguishing_diagnostic: 'run verifier',
        },
      });
    });

    const decision = analytics.checkExplorationQuota();
    assert.strictEqual(decision.required, true);
    assert.strictEqual(decision.flat_cycle_count, 2);

    const summary = analytics.generateSummary();
    assert.strictEqual(summary.structural_variant_required, true);
    assert.strictEqual(summary.flat_cycle_count, 2);
  });

  test('unknown token/spend usage is not conflated with zero — unobservable ceilings surface (#1766)', () => {
    setup();
    const analytics = new IterationAnalytics('unknown-usage', 'No-usage provider', {
      storagePath: TEST_DIR,
      budgetLimits: { total_tokens: 1000, spend_usd: 5, wall_clock_minutes: 10 },
    });

    // A provider that reports no token/cost usage: record null (unknown), not 0.
    analytics.recordIteration({
      iteration_number: 1,
      quality_score: 40,
      tokens_used: null,
      input_tokens: null,
      output_tokens: null,
      tool_calls: 3,
      token_cost_usd: null,
      execution_time_ms: 30000,
      verification_status: 'failed',
      output_snapshot_path: '/path/1',
    });

    const observable = analytics.getObservableDimensions();
    assert.strictEqual(observable.total_tokens, false);
    assert.strictEqual(observable.spend_usd, false);
    assert.strictEqual(observable.wall_clock_minutes, true);
    assert.strictEqual(observable.tool_calls, true);

    const decision = analytics.checkBudgetLimits();
    // token/spend ceilings are unobservable (not silently "under budget");
    // wall-clock is observable and not yet exhausted.
    assert.ok(decision.unobservable_limits.includes('total_tokens'));
    assert.ok(decision.unobservable_limits.includes('spend_usd'));
    assert.strictEqual(decision.exhausted, false);
  });

  test('observed token usage still enforces the ceiling (#1766)', () => {
    setup();
    const analytics = new IterationAnalytics('observed-usage', 'Reporting provider', {
      storagePath: TEST_DIR,
      budgetLimits: { total_tokens: 1000 },
    });
    analytics.recordIteration({
      iteration_number: 1,
      quality_score: 40,
      tokens_used: 1200,
      input_tokens: 1000,
      output_tokens: 200,
      tool_calls: 1,
      token_cost_usd: 0.5,
      execution_time_ms: 5000,
      verification_status: 'failed',
      output_snapshot_path: '/path/1',
    });
    const decision = analytics.checkBudgetLimits();
    assert.strictEqual(decision.exhausted, true);
    assert.strictEqual(decision.trigger, 'total_tokens_exhausted');
    assert.ok(!decision.unobservable_limits.includes('total_tokens'));
  });

  test('checkExplorationQuota() is OFF without a declared K — no default is substituted (#1770)', () => {
    setup();

    const recordFlat = (analytics) => {
      [70, 70, 70, 70, 70].forEach((score, index) => {
        analytics.recordIteration({
          iteration_number: index + 1,
          quality_score: score,
          tokens_used: 1000,
          token_cost_usd: 0.01,
          execution_time_ms: 5000,
          verification_status: 'failed',
          output_snapshot_path: `/path/${index + 1}`,
        });
      });
    };

    // Default config: quota off entirely
    const defaults = new IterationAnalytics('quota-default', 'Flat task', { storagePath: TEST_DIR });
    recordFlat(defaults);
    assert.strictEqual(defaults.checkExplorationQuota().required, false);

    // enabled but no K declared: off, and k reported as null (not 3)
    const noK = new IterationAnalytics('quota-no-k', 'Flat task', {
      storagePath: TEST_DIR,
      explorationQuota: { enabled: true },
    });
    recordFlat(noK);
    const noKDecision = noK.checkExplorationQuota();
    assert.strictEqual(noKDecision.required, false);
    assert.strictEqual(noKDecision.k, null);

    // k: 0 means off — must never coerce to a default K
    const zeroK = new IterationAnalytics('quota-zero-k', 'Flat task', {
      storagePath: TEST_DIR,
      explorationQuota: { enabled: true, k: 0 },
    });
    recordFlat(zeroK);
    const zeroKDecision = zeroK.checkExplorationQuota();
    assert.strictEqual(zeroKDecision.required, false);
    assert.strictEqual(zeroKDecision.k, null);
  });

  test('generateSummary + generateBudgetStopReport validate against the output schema (#1771)', () => {
    setup();
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const schemaPath = join(
      __dirname,
      '../../agentic/code/addons/agent-loop/schemas/iteration-analytics-output.yaml',
    );
    const schema = yaml.load(readFileSync(schemaPath, 'utf-8'));
    // Drop the draft-2020-12 $schema URL — this Ajv build doesn't register that
    // meta-schema, and the constructs used here are draft-07 compatible.
    delete schema.$schema;
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);

    const analytics = new IterationAnalytics('schema-loop', 'Schema validation task', {
      storagePath: TEST_DIR,
      budgetLimits: { total_tokens: 1000 },
      explorationQuota: { enabled: true, k: 2 },
    });

    // Iteration with observed usage
    analytics.recordIteration({
      iteration_number: 1,
      quality_score: 40,
      tokens_used: 500,
      input_tokens: 400,
      output_tokens: 100,
      tool_calls: 2,
      token_cost_usd: 0.1,
      execution_time_ms: 5000,
      verification_status: 'failed',
      output_snapshot_path: '/p/1',
      experiment: {
        hypothesis: 'h',
        expected_failure_mode: 'e',
        distinguishing_diagnostic: 'd',
        adjustment_key: 'pivot:',
        recorded_before_change: true,
        result: 'failed',
        probe_or_generalization_signal: 'iteration-analysis',
      },
    });
    // Iteration with UNKNOWN usage (null token/cost) — must still validate (#1766)
    analytics.recordIteration({
      iteration_number: 2,
      quality_score: 55,
      tokens_used: null,
      input_tokens: null,
      output_tokens: null,
      tool_calls: 1,
      token_cost_usd: null,
      execution_time_ms: 4000,
      verification_status: 'failed',
      output_snapshot_path: '/p/2',
    });
    // VOID iteration with an eval-harness result — the new eval fields must
    // validate against the extended output schema (#1776)
    analytics.recordIteration({
      iteration_number: 3,
      quality_score: 88,
      tokens_used: 700,
      tool_calls: 2,
      token_cost_usd: 0.2,
      execution_time_ms: 3000,
      verification_status: 'void',
      output_snapshot_path: '/p/3',
      eval_human_override: false,
      eval_harness_result: {
        status: 'void',
        optimizer_feedback: { score: 88, pass_count: 8, total_count: 10, status: 'void', void_reason: 'lint violation' },
        private_diagnostics_ref: '/p/3/eval-harness-private.json',
        leakage_audit: { checked: true, result: 'pass' },
        human_override: false,
        _forbidden_fields_seen: ['holdout_answers'],
      },
    });

    const summary = analytics.generateSummary();
    const summaryValid = validate(summary);
    assert.ok(summaryValid, `Summary failed schema: ${JSON.stringify(validate.errors, null, 2)}`);

    // BudgetStopReport is embedded under $defs — get its validator from the
    // already-compiled root schema by its $id + JSON-pointer fragment (avoids
    // recompiling the same $id, which Ajv rejects).
    const report = analytics.generateBudgetStopReport('total_tokens_exhausted');
    const validateReport = ajv.getSchema(`${schema.$id}#/$defs/BudgetStopReport`);
    const reportValid = validateReport(report);
    assert.ok(reportValid, `BudgetStopReport failed schema: ${JSON.stringify(validateReport.errors, null, 2)}`);
  });

}

for (const selectionCriteria of ['highest_quality_verified', 'highest_quality', 'most_recent_above_threshold']) {
  test(`${selectionCriteria} excludes all VOID candidates and permits explicit override`, () => {
    setup();
    const analytics = new IterationAnalytics('void-selection', 'test', { storagePath: TEST_DIR, selectionCriteria });
    const metrics = { iteration_number: 1, quality_score: 100, tokens_used: 0, token_cost_usd: 0, execution_time_ms: 0, verification_status: 'void', output_snapshot_path: null };
    analytics.recordIteration(metrics);
    assert.strictEqual(analytics.getOptimalIteration(), null);
    assert.strictEqual(analytics.getOptimalIteration(false), null);
    assert.strictEqual(analytics.selectBestIteration().selected, null);
    assert.strictEqual(analytics.generateSummary().selected_iteration, null);
    analytics.recordIteration({ ...metrics, iteration_number: 2, quality_score: 80, verification_status: 'passed' });
    analytics.recordIteration({ ...metrics, iteration_number: 3 });
    assert.strictEqual(analytics.selectBestIteration().selected.iteration_number, 2);
    analytics.recordIteration({ ...metrics, iteration_number: 4, quality_score: 90, eval_human_override: true });
    const selected = analytics.selectBestIteration().selected;
    assert.strictEqual(selected.iteration_number, selectionCriteria === 'highest_quality_verified' ? 2 : 4);
  });
}
