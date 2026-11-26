import { describe, expect, it } from 'vitest';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildArgs } from '../../../../src/cli/handlers/ralph-launcher.js';

const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirnameLocal, '../../../..');

/** Adjacency helper: assert `flag` is immediately followed by `value` in argv. */
function expectFlagValue(args: string[], flag: string, value: string) {
  const idx = args.indexOf(flag);
  expect(idx, `${flag} present`).toBeGreaterThanOrEqual(0);
  expect(args[idx + 1], `${flag} → ${value}`).toBe(value);
}

describe('ralph-launcher buildArgs', () => {
  it('emits LFD hard budget and exploration quota flags with correct flag→value adjacency', () => {
    const args = buildArgs({
      objective: 'Budgeted loop',
      workerTier: 'economy',
      completionCriteria: 'tests pass',
      maxIterations: 5,
      maxTotalTokens: 5000,
      maxOutputTokens: 1200,
      maxToolCalls: 20,
      maxTotalCost: 3.5,
      maxWallClockMinutes: 45,
      explorationQuota: 2,
      budgetStopPolicy: 'budget-wins',
    });

    // Adjacency, not just membership (audit T1): a pairing regression must fail.
    expectFlagValue(args, '--worker-tier', 'economy');
    expectFlagValue(args, '--max-total-tokens', '5000');
    expectFlagValue(args, '--max-output-tokens', '1200');
    expectFlagValue(args, '--max-tool-calls', '20');
    expectFlagValue(args, '--max-total-cost', '3.5');
    expectFlagValue(args, '--max-wall-clock-minutes', '45');
    expectFlagValue(args, '--exploration-quota', '2');
    expectFlagValue(args, '--budget-stop-policy', 'budget-wins');
  });

  it('omits unset LFD flags entirely', () => {
    const args = buildArgs({
      objective: 'Plain loop',
      completionCriteria: 'tests pass',
    });
    for (const flag of [
      '--max-total-tokens', '--max-output-tokens', '--max-tool-calls',
      '--max-total-cost', '--max-wall-clock-minutes', '--exploration-quota',
      '--budget-stop-policy',
      '--worker-tier', '--model',
    ]) {
      expect(args, `${flag} absent when unset`).not.toContain(flag);
    }
  });

  it('END-TO-END contract: buildArgs output parses back through the runtime parseArgs (#1774)', async () => {
    // The buildArgs → index.mjs parseArgs contract was asserted independently on
    // each side but never together — a flag rename in index.mjs would break
    // production while every unit test stayed green (audit T1). This drives the
    // real runtime parser with buildArgs' real output.
    const { parseArgs } = await import(
      join(PROJECT_ROOT, 'tools/ralph-external/index.mjs')
    );

    const args = buildArgs({
      objective: 'Contract loop',
      completionCriteria: 'npm test passes',
      maxTotalTokens: 5000,
      maxOutputTokens: 1200,
      maxToolCalls: 20,
      maxTotalCost: 3.5,
      maxWallClockMinutes: 45,
      explorationQuota: 2,
      budgetStopPolicy: 'budget-wins',
    });

    const opts = parseArgs(args);

    expect(opts.objective).toBe('Contract loop');
    expect(opts.completionCriteria).toBe('npm test passes');
    // Every LFD flag survives the round-trip into the runtime option shape:
    expect(opts.budgetLimits.total_tokens).toBe(5000);
    expect(opts.budgetLimits.output_tokens).toBe(1200);
    expect(opts.budgetLimits.tool_calls).toBe(20);
    expect(opts.budgetLimits.spend_usd).toBe(3.5);
    expect(opts.budgetLimits.wall_clock_minutes).toBe(45);
    expect(opts.explorationQuota).toEqual({ enabled: true, k: 2 });
    expect(opts.budgetStopPolicy).toBe('budget-wins');
  });
});
