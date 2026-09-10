/**
 * Focused tests for provider stream usage extraction.
 *
 * Run with: node tools/ralph-external/session-launcher-usage.test.mjs
 */

import assert from 'node:assert/strict';
import { SessionLauncher } from './session-launcher.mjs';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('extracts snake_case usage and cost fields', () => {
  const launcher = new SessionLauncher();
  const usage = launcher._extractUsageStats({
    type: 'result',
    total_cost_usd: 0.123,
    usage: {
      input_tokens: 100,
      output_tokens: 25,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
    },
  });

  assert.strictEqual(usage.hasUsage, true);
  assert.strictEqual(usage.inputTokens, 100);
  assert.strictEqual(usage.outputTokens, 25);
  assert.strictEqual(usage.cacheCreationInputTokens, 10);
  assert.strictEqual(usage.cacheReadInputTokens, 5);
  assert.strictEqual(usage.totalTokens, 140);
  assert.strictEqual(usage.costUsd, 0.123);
});

test('prefers explicit total tokens when present', () => {
  const launcher = new SessionLauncher();
  const usage = launcher._extractUsageStats({
    usage: {
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 500,
    },
  });

  assert.strictEqual(usage.totalTokens, 500);
});

test('returns zero usage for events without accounting data', () => {
  const launcher = new SessionLauncher();
  const usage = launcher._extractUsageStats({ type: 'text', content: 'hello' });

  assert.strictEqual(usage.hasUsage, false);
  assert.strictEqual(usage.totalTokens, 0);
  assert.strictEqual(usage.costUsd, 0);
  assert.strictEqual(usage.hasCostField, false);
});

test('reads usage nested under message.usage (assistant events) (#1766)', () => {
  const launcher = new SessionLauncher();
  // Claude assistant events nest usage under message.usage — reading only the
  // top-level usage lost all accounting on timed-out sessions whose terminal
  // result event never arrives.
  const usage = launcher._extractUsageStats({
    type: 'assistant',
    message: {
      usage: { input_tokens: 200, output_tokens: 50 },
    },
  });

  assert.strictEqual(usage.hasUsage, true);
  assert.strictEqual(usage.inputTokens, 200);
  assert.strictEqual(usage.outputTokens, 50);
  assert.strictEqual(usage.totalTokens, 250);
});

test('distinguishes a present cost field from an absent one (#1766)', () => {
  const launcher = new SessionLauncher();

  const withCost = launcher._extractUsageStats({ type: 'result', total_cost_usd: 0, usage: { total_tokens: 10 } });
  assert.strictEqual(withCost.hasCostField, true);

  const withoutCost = launcher._extractUsageStats({ type: 'result', usage: { total_tokens: 10 } });
  assert.strictEqual(withoutCost.hasCostField, false);
});

test('explicit zero total is not replaced by component sums', () => {
  const usage = new SessionLauncher()._extractUsageStats({ usage: { total_tokens: 0, input_tokens: 5 } });
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.hasTokenField, true);
  assert.equal(usage.hasUsage, true);
});

for (const [name, event, totalTokens, costUsd, tokenObserved, costObserved] of [
  ['both explicit zero', { usage: { total_tokens: 0 }, total_cost_usd: 0 }, 0, 0, true, true],
  ['absent accounting', { type: 'text', content: 'synthetic' }, 0, 0, false, false],
  ['empty usage object', { usage: {} }, 0, 0, false, false],
  ['zero tokens only', { usage: { total_tokens: 0 } }, 0, 0, true, false],
  ['positive tokens only', { usage: { total_tokens: 5 } }, 5, 0, true, false],
  ['zero cost only', { total_cost_usd: 0 }, 0, 0, false, true],
  ['positive cost only', { total_cost_usd: 0.25 }, 0, 0.25, false, true],
  ['both positive', { usage: { total_tokens: 5 }, total_cost_usd: 0.25 }, 5, 0.25, true, true],
  ['nested zero components', { type: 'assistant', message: { usage: { input_tokens: 0, output_tokens: 0 } } }, 0, 0, true, false],
  ['top-level camelCase zero', { totalTokens: 0, costUsd: 0 }, 0, 0, true, true],
  ['nonnumeric fields', { usage: { total_tokens: '0' }, total_cost_usd: null }, 0, 0, false, false],
]) {
  test(`final result preserves independent accounting observation: ${name}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'aiwg-usage-owner-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const launcher = new SessionLauncher();
    // The real local parser runs; provider launch and operator transcript
    // lookup are outside this owner and are never invoked.
    t.mock.method(launcher, 'copySessionTranscript', async () => null);
    const errors = [];
    launcher.on('artifact-error', error => errors.push(error.message));
    const stdoutPath = join(directory, 'stream.jsonl');
    writeFileSync(stdoutPath, JSON.stringify(event) + '\n');
    const result = {};
    await launcher._captureSessionArtifacts({ sessionId: 'synthetic', workingDir: directory, outputDir: join(directory, 'output'), stdoutPath }, result);
    assert.deepEqual(errors, []);
    assert.equal(result.totalTokens, totalTokens);
    assert.equal(result.costUsd, costUsd);
    assert.equal(result.tokenUsageObserved, tokenObserved);
    assert.equal(result.costObserved, costObserved);
    const saved = JSON.parse(readFileSync(result.parsedEventsPath, 'utf8'));
    assert.equal(saved.stats.tokenFieldSeen, tokenObserved);
    assert.equal(saved.stats.costFieldSeen, costObserved);
    assert.equal(saved.stats.usageEvents, tokenObserved || costObserved ? 1 : 0);
    assert.equal(saved.events.length, 1);
  });
}
