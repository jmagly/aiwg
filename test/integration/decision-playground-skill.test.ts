import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Drives the packaged decision-playground entry point (#2673). It imports the
// compiled runtime, so the suite needs `npm run build:cli`; CI builds before tests.
const root = path.resolve(import.meta.dirname, '../..');
const addon = path.join(root, 'agentic/code/addons/decision-engine');
const script = path.join(addon, 'skills/decision-playground/scripts/decision-playground.mjs');
const built = existsSync(path.join(root, 'dist/src/decision/index.js'));

interface Run { code: number; stdout: string; stderr: string }

function playground(...args: string[]): Promise<Run> {
  return new Promise(resolve => {
    // No feature flag, credential or network configuration is supplied.
    execFile(process.execPath, [script, ...args], { cwd: root, timeout: 120_000, env: { PATH: process.env.PATH ?? '' } },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
  });
}

describe('decision-playground skill registration', () => {
  it('is declared by the decision-engine addon manifest', () => {
    const manifest = JSON.parse(readFileSync(path.join(addon, 'manifest.json'), 'utf8')) as { skills: string[] };
    expect(manifest.skills).toContain('decision-playground');
    expect(readFileSync(path.join(addon, 'skills/decision-playground/SKILL.md'), 'utf8')).toMatch(/entrypoint: scripts\/decision-playground\.mjs/);
  });

  it('locates the runtime with the same resolver as decision-evaluate', () => {
    // Each skill is deployed on its own, so the playground carries its own copy.
    const locator = (skill: string) => readFileSync(path.join(addon, 'skills', skill, 'scripts/runtime-root.mjs'), 'utf8');
    expect(locator('decision-playground')).toBe(locator('decision-evaluate'));
    expect(readFileSync(script, 'utf8')).toContain("from './runtime-root.mjs'");
  });
});

describe.skipIf(!built)('decision-playground entry point (#2673)', () => {
  it('lists every installed pack with status and fixtures', async () => {
    const run = await playground('list');
    expect(run.code, run.stderr).toBe(0);
    const listed = JSON.parse(run.stdout) as Array<{ id: string; status: string; fixtures: string[] }>;
    expect(listed).toHaveLength(12);
    expect(listed.find(pack => pack.id === 'dependent-two-stage')).toMatchObject({ status: 'unavailable', fixtures: [] });
  });

  it('runs one fixture through the production evaluator', async () => {
    const run = await playground('run', 'guardrails', '--fixture', 'guardrail-noul-midpoint');
    expect(run.code, run.stderr).toBe(0);
    const receipt = JSON.parse(run.stdout);
    expect(receipt).toMatchObject({ schema: 'decision-pattern-receipt/v2', executionMode: 'offline-recorded', route: 'review',
      runtime: { evaluator: 'evaluateDecisionRuleset', transport: 'recorded-replay', transportCalls: 1 }, result: { kind: 'RulesetResult' } });
    expect(run.stdout).not.toMatch(/medium/i);
  });

  it('runs every offline fixture and refuses unavailable packs and unknown commands', async () => {
    const all = await playground('run-all');
    expect(all.code, all.stderr).toBe(0);
    expect(JSON.parse(all.stdout)).toMatchObject({ executionMode: 'offline-recorded', failed: 0 });
    expect((await playground('run', 'dependent-two-stage')).code).toBe(3);
    expect((await playground('run', 'not-a-pack')).code).toBe(2);
    expect((await playground('unknown')).code).toBe(2);
  });

  it('prints a non-executing live plan', async () => {
    const run = await playground('live-plan', 'rag-screen');
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ mode: 'live', status: 'skipped', executes: false, limits: { maxCalls: 3, allowUnknownCost: false } });
  });
});
