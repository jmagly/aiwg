/**
 * Basic tests for Dashboard
 *
 * Run with: node tools/ralph-external/dashboard.test.mjs
 */

import { Dashboard } from './dashboard.mjs';
import { after, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import assert from 'assert';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'aiwg-dashboard-test-'));

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function setup() {
  cleanup();
  mkdirSync(TEST_DIR, { recursive: true });
}

// Test: Initialization
test('Dashboard initializes correctly', () => {
  setup();
  const dashboard = new Dashboard({ projectRoot: TEST_DIR });

  assert.strictEqual(dashboard.projectRoot, TEST_DIR);
  assert.ok(dashboard.loopsDir.endsWith('loops'));
});

// Test: centerText
test('centerText() centers text correctly', () => {
  setup();
  const dashboard = new Dashboard({ projectRoot: TEST_DIR });

  const centered = dashboard.centerText('Hello', 20);

  assert.ok(centered.startsWith('│'));
  assert.ok(centered.endsWith('│'));
  assert.strictEqual(centered.length, 20);
  assert.ok(centered.includes('Hello'));

  const truncated = dashboard.centerText('x'.repeat(80), 20);
  assert.strictEqual(truncated.length, 20);
  assert.ok(truncated.includes('..'));
});

// Test: formatDuration
test('formatDuration() formats durations correctly', () => {
  setup();
  const dashboard = new Dashboard({ projectRoot: TEST_DIR });

  assert.strictEqual(dashboard.formatDuration(5000), '5s');
  assert.strictEqual(dashboard.formatDuration(65000), '1m');
  assert.strictEqual(dashboard.formatDuration(3665000), '1h 1m');
  assert.strictEqual(dashboard.formatDuration(90065000), '1d 1h');
});

// Test: truncate
test('truncate() truncates strings correctly', () => {
  setup();
  const dashboard = new Dashboard({ projectRoot: TEST_DIR });

  const short = dashboard.truncate('hello', 10);
  assert.strictEqual(short, 'hello     '); // Padded

  const long = dashboard.truncate('this-is-a-very-long-string', 10);
  assert.strictEqual(long, 'this-is-..');
  assert.strictEqual(long.length, 10);
});

// Test: padRight and padLeft
test('padRight() and padLeft() pad correctly', () => {
  setup();
  const dashboard = new Dashboard({ projectRoot: TEST_DIR });

  assert.strictEqual(dashboard.padRight('test', 10), 'test      ');
  assert.strictEqual(dashboard.padLeft('test', 10), '      test');
});

// Test: getLoopsSummary with no loops
test('getLoopsSummary() returns empty array when no loops', () => {
  setup();
  const dashboard = new Dashboard({ projectRoot: TEST_DIR });

  const loops = dashboard.getLoopsSummary();
  assert.strictEqual(loops.length, 0);
});

// Test: getLoopsSummary with loops
test('getLoopsSummary() reads and sorts loops', () => {
  setup();
  const dashboard = new Dashboard({ projectRoot: TEST_DIR });

  // Create mock loop states
  const loopData = [
    { loopId: 'loop-001', status: 'paused', iteration: 5, max: 10 },
    { loopId: 'loop-002', status: 'running', iteration: 3, max: 10 },
    { loopId: 'loop-003', status: 'completed', iteration: 10, max: 10 },
  ];

  for (const data of loopData) {
    const loopDir = join(TEST_DIR, '.aiwg', 'ralph', 'loops', data.loopId);
    mkdirSync(loopDir, { recursive: true });
    writeFileSync(
      join(loopDir, 'state.json'),
      JSON.stringify({
        status: data.status,
        currentIteration: data.iteration,
        maxIterations: data.max,
        objective: `Test objective for ${data.loopId}`,
        startTime: new Date().toISOString(),
      })
    );
  }

  const loops = dashboard.getLoopsSummary();

  assert.strictEqual(loops.length, 3);

  // Should be sorted by status (running first)
  assert.strictEqual(loops[0].status, 'running');
  assert.strictEqual(loops[1].status, 'paused');
  assert.strictEqual(loops[2].status, 'completed');
});

// Test: getAggregateMetrics
test('getAggregateMetrics() calculates metrics correctly', () => {
  setup();
  const dashboard = new Dashboard({ projectRoot: TEST_DIR });

  // Create mock loop states
  const loopData = [
    { loopId: 'loop-004', status: 'completed', iteration: 10, max: 10 },
    { loopId: 'loop-005', status: 'failed', iteration: 5, max: 10 },
    { loopId: 'loop-006', status: 'running', iteration: 7, max: 10 },
  ];

  for (const data of loopData) {
    const loopDir = join(TEST_DIR, '.aiwg', 'ralph', 'loops', data.loopId);
    mkdirSync(loopDir, { recursive: true });
    writeFileSync(
      join(loopDir, 'state.json'),
      JSON.stringify({
        status: data.status,
        currentIteration: data.iteration,
        maxIterations: data.max,
        startTime: new Date().toISOString(),
      })
    );
  }

  const metrics = dashboard.getAggregateMetrics();

  assert.strictEqual(metrics.totalIterations, 22); // 10 + 5 + 7
  assert.strictEqual(metrics.successRate, 50); // 1 completed, 1 failed = 50%
  assert.ok(metrics.avgProgress > 0);
});

test('getAggregateMetrics() sums only finite nonnegative numeric costs', () => {
  setup();
  const dashboard = new Dashboard({ projectRoot: TEST_DIR });
  const loopDir = join(TEST_DIR, '.aiwg', 'ralph', 'loops', 'cost-loop');
  mkdirSync(loopDir, { recursive: true });
  writeFileSync(join(loopDir, 'state.json'), JSON.stringify({
    status: 'completed',
    currentIteration: 1,
    maxIterations: 1,
    startTime: new Date().toISOString(),
    iterations: [
      { analysis: { tokenCost: 1.25 } },
      { analysis: { tokenCost: 0.75 } },
      { analysis: { tokenCost: '9.5' } },
      { analysis: { tokenCost: -2 } },
      { analysis: { tokenCost: null } },
    ],
  }));

  const metrics = dashboard.getAggregateMetrics();
  assert.strictEqual(metrics.totalCost, 2);
  assert.strictEqual(typeof metrics.totalCost, 'number');
});

// Test: countCrashesToday
test('countCrashesToday() counts recent crashes', () => {
  setup();
  const dashboard = new Dashboard({ projectRoot: TEST_DIR });

  const loopId = 'loop-007';
  const loopDir = join(TEST_DIR, '.aiwg', 'ralph', 'loops', loopId);
  mkdirSync(loopDir, { recursive: true });

  // Create crash log with recent crash
  const now = new Date().toISOString();
  const yesterday = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const crashLog = `[${now}] Error: Timeout\n[${yesterday}] Error: OOM\n`;
  writeFileSync(join(loopDir, 'crash.log'), crashLog);

  const count = dashboard.countCrashesToday();

  // Should only count the recent one
  assert.strictEqual(count, 1);
});

// Test: render with no loops
test('render() produces valid output with no loops', () => {
  setup();
  const dashboard = new Dashboard({ projectRoot: TEST_DIR });

  const output = dashboard.render();

  assert.ok(output.includes('External Ralph Multi-Loop Dashboard'));
  assert.ok(output.includes('Active Loops: 0/0'));
  assert.ok(output.includes('No active loops'));
  assert.ok(output.includes('╭'));
  assert.ok(output.includes('╰'));
});

// Test: render with loops
test('render() produces valid output with loops', () => {
  setup();
  const dashboard = new Dashboard({ projectRoot: TEST_DIR });

  // Create mock loops
  const loopData = [
    { loopId: 'ralph-fix-tests-a1b2c3d4', status: 'running', iteration: 3, max: 10 },
    { loopId: 'ralph-migrate-ts-e5f6g7h8', status: 'paused', iteration: 7, max: 20 },
  ];

  for (const data of loopData) {
    const loopDir = join(TEST_DIR, '.aiwg', 'ralph', 'loops', data.loopId);
    mkdirSync(loopDir, { recursive: true });
    writeFileSync(
      join(loopDir, 'state.json'),
      JSON.stringify({
        status: data.status,
        currentIteration: data.iteration,
        maxIterations: data.max,
        startTime: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      })
    );
  }

  const output = dashboard.render();

  assert.ok(output.includes('Active Loops: 1/2')); // Only 1 running
  assert.ok(output.includes('ralph-fix-tests'));
  assert.ok(output.includes('ralph-migrate-ts'));
  assert.ok(output.includes('running'));
  assert.ok(output.includes('paused'));
  assert.ok(output.includes('3/10'));
  assert.ok(output.includes('7/20'));
});

after(cleanup);
