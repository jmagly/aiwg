/**
 * Focused tests for external Ralph status output.
 *
 * Run with: node tools/ralph-external/status-output.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { parseArgs } from './index.mjs';

const CLI_PATH = fileURLToPath(new URL('./index.mjs', import.meta.url));

const integerFlags = ['--max-iterations', '--max-total-tokens', '--max-output-tokens',
  '--max-tool-calls', '--exploration-quota', '--timeout'];
const decimalFlags = ['--budget', '--max-total-cost', '--max-wall-clock-minutes'];

for (const flag of [...integerFlags, ...decimalFlags]) {
  const invalid = ['1junk', '1,000', '0x10', 'Infinity', '0', '-1', '', undefined];
  if (integerFlags.includes(flag)) invalid.push('1.5', '9007199254740992');
  for (const raw of invalid) {
    test(`CLI rejects ${flag} value ${JSON.stringify(raw)}`, t => {
      const root = createRoot(t);
      const args = [CLI_PATH, '--status', flag, ...(raw === undefined ? [] : [raw])];
      const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1, result.stdout);
      assert.ok(result.stderr.includes(`Error: ${flag} requires a positive`), result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(existsSync(join(root, '.aiwg')), false);
    });
  }
}

for (const [raw, expected] of [['1', 1], ['1e2', 100], ['1.0', 1]]) {
  test(`CLI accepts whole positive limits ${raw}`, t => {
    const root = createRoot(t);
    const args = [...integerFlags, ...decimalFlags].flatMap(flag => [flag, raw]);
    const parsed = parseArgs(args);
    assert.equal(parsed.maxIterations, expected);
    assert.equal(parsed.timeoutMinutes, expected);
    assert.equal(parsed.budgetPerIteration, expected);
    assert.deepEqual(parsed.budgetLimits, {
      total_tokens: expected, output_tokens: expected, tool_calls: expected,
      spend_usd: expected, wall_clock_minutes: expected,
    });
    assert.deepEqual(parsed.explorationQuota, { enabled: true, k: expected });
    const result = spawnSync(process.execPath, [CLI_PATH, '--status', ...args], {
      cwd: root, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'No external Ralph loop found.\n');
  });
}

test('CLI accepts fractional positive cost and wall-clock limits', t => {
  const root = createRoot(t);
  const args = decimalFlags.flatMap(flag => [flag, '0.25']);
  const parsed = parseArgs(args);
  assert.equal(parsed.budgetPerIteration, 0.25);
  assert.deepEqual(parsed.budgetLimits, { spend_usd: 0.25, wall_clock_minutes: 0.25 });
  const result = spawnSync(process.execPath, [CLI_PATH, '--status', ...args], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'No external Ralph loop found.\n');
});

function createRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'ralph-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function createStatusFixture(t) {
  const root = createRoot(t);
  const stateDir = join(root, '.aiwg', 'ralph-external');
  const analyticsDir = join(stateDir, 'analytics');
  mkdirSync(analyticsDir, { recursive: true });

  const loopId = 'lfd-status-loop';
  const state = {
    version: '1.0.0',
    loopId,
    objective: 'Exercise LFD status output',
    completionCriteria: 'status shows budget usage',
    status: 'running',
    maxIterations: 3,
    currentIteration: 2,
    startTime: '2026-07-10T00:00:00.000Z',
    lastUpdate: '2026-07-10T00:05:00.000Z',
    iterations: [
      { status: 'completed', analysis: { completionPercentage: 40 } },
      { status: 'completed', analysis: { completionPercentage: 80 } },
    ],
    accumulatedLearnings: '',
    config: {
      budgetLimits: {
        total_tokens: 2000,
        output_tokens: 500,
        tool_calls: 10,
        spend_usd: 0.5,
        wall_clock_minutes: 10,
      },
      explorationQuota: { enabled: true, k: 3 },
    },
    lfdControls: {
      structuralVariantRequired: false,
      flatCycleCount: 1,
      explorationQuotaK: 3,
    },
  };

  const analytics = {
    loop_id: loopId,
    budget_usage: {
      total_tokens: 1500,
      output_tokens: 300,
      tool_calls: 4,
      spend_usd: 0.12,
      wall_clock_minutes: 2.5,
    },
    budget_exhausted: false,
    flat_cycle_count: 1,
    structural_variant_required: false,
    iterations: [
      {
        iteration_number: 1,
        quality_per_1k_tokens: 50,
        quality_per_minute: 120,
        baseline_comparison: {
          quality_lift: 10,
          token_efficiency_lift: 20,
          speed_efficiency_lift: 40,
        },
      },
      {
        iteration_number: 2,
        quality_per_1k_tokens: 60,
        quality_per_minute: 100,
        baseline_comparison: {
          quality_lift: 25,
          token_efficiency_lift: 30,
          speed_efficiency_lift: 10,
        },
      },
    ],
  };

  writeFileSync(join(stateDir, 'session-state.json'), JSON.stringify(state, null, 2));
  writeFileSync(join(analyticsDir, `${loopId}.json`), JSON.stringify(analytics, null, 2));

  return root;
}

for (const [locale, suffix, expectedTokens] of [
  ['en_US.UTF-8', '', '1,500 / 2,000 (75.0%)'],
  ['de_DE.UTF-8', ' (German locale)', '1.500 / 2.000 (75.0%)'],
]) {
  test(`ralph-external --status shows LFD budget and efficiency metrics${suffix}`, t => {
    const root = createStatusFixture(t);

    try {
      const result = spawnSync(process.execPath, [CLI_PATH, '--status'], {
        cwd: root,
        // Production intentionally formats token counts using its process locale.
        // Pin the child's locale, not the parent or production implementation.
        env: { ...process.env, LANG: locale, LC_ALL: locale },
        encoding: 'utf8',
        timeout: 10000,
      });

      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /LFD Controls:/);
      const totalTokensLine = result.stdout.split('\n').find(line => line.trimStart().startsWith('Total Tokens:'));
      assert.equal(totalTokensLine?.trim(), `Total Tokens:   ${expectedTokens}`);
      assert.match(result.stdout, /Output Tokens:\s+300 \/ 500 \(60\.0%\)/);
      assert.match(result.stdout, /Tool Calls:\s+4 \/ 10 \(40\.0%\)/);
      assert.match(result.stdout, /Spend:\s+\$0\.1200 \/ \$0\.5000 \(24\.0%\)/);
      assert.match(result.stdout, /Runtime:\s+2\.50 min \/ 10\.00 min \(25\.0%\)/);
      assert.match(result.stdout, /Best \/ 1K Tok:\s+iteration 2 \(60\.00\)/);
      assert.match(result.stdout, /Best \/ Minute:\s+iteration 1 \(120\.00\)/);
      assert.match(result.stdout, /Random Lift:\s+iteration 2 \(\+25\.00\)/);
      assert.match(result.stdout, /Random TokLift:\s+iteration 2 \(\+30\.00\)/);
      assert.match(result.stdout, /Random SpdLift:\s+iteration 1 \(\+40\.00\)/);
      assert.match(result.stdout, /Structural Var:\s+not required \(1\/3 flat cycles\)/);
    } finally {
      if (existsSync(root)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
}

for (const [name, args, diagnostic] of [
  ['malformed JSON option', ['--mcp-config', '{broken'], /SyntaxError:/],
  ['missing tools value', ['--tools'], /TypeError:/],
]) {
  test(`CLI rejects ${name} with a failure exit`, t => {
    const root = createRoot(t);
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.match(result.stderr, diagnostic);
    assert.equal(result.stdout, '');
    assert.equal(result.status, 1);
    assert.equal(existsSync(join(root, '.aiwg')), false);
  });
}

for (const [name, args, output] of [
  ['help', ['--help'], /External Ralph Loop - Crash-resilient iterative task execution/],
  ['empty status', ['--status'], /^No external Ralph loop found\.\n$/],
]) {
  test(`CLI ${name} remains successful`, t => {
    const root = createRoot(t);
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, output);
  });
}
