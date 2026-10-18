import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { emptyConfig, readAiwgConfigCandidate, writeAiwgConfig } from '../../../src/config/aiwg-config.js';
import { guardRulesInlineBudget, resolveRulesInlineBudget, validateRulesConfig } from '../../../src/rules/inline-budget.mjs';

describe('rules.inline_budget_tokens config and non-mutating guard', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'aiwg-rules-config-')); await mkdir(join(dir, '.aiwg')); });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
  it('defaults to 64000, project config overrides it, environment wins (including zero)', () => {
    expect(resolveRulesInlineBudget({}, {})).toBe(64000);
    expect(emptyConfig().rules).toEqual({ inline_budget_tokens: 64000 });
    expect(resolveRulesInlineBudget({ rules: { inline_budget_tokens: 16 } }, {})).toBe(16);
    expect(resolveRulesInlineBudget({ rules: { inline_budget_tokens: 16 } }, { AIWG_RULES_INLINE_BUDGET_TOKENS: '0' })).toBe(0);
    expect(resolveRulesInlineBudget({ rules: { inline_budget_tokens: 0 } }, { AIWG_RULES_INLINE_BUDGET_TOKENS: '42' })).toBe(42);
  });
  it('uses the actual environment by default without persisting overrides to config', () => {
    vi.stubEnv('AIWG_RULES_INLINE_BUDGET_TOKENS', '17');
    const config = { rules: { inline_budget_tokens: 18 } };
    expect(resolveRulesInlineBudget(config)).toBe(17);
    expect(config.rules.inline_budget_tokens).toBe(18);
  });
  it.each([-1, 1.5, '42', null, true, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid config value %j', value => {
    expect(validateRulesConfig({ inline_budget_tokens: value }).length).toBeGreaterThan(0);
  });
  it.each(['', ' ', '-1', '1.5', '1e3', '12junk', 'Infinity', '9007199254740992'])('diagnoses invalid environment value %j', value => {
    expect(() => resolveRulesInlineBudget({}, { AIWG_RULES_INLINE_BUDGET_TOKENS: value })).toThrow('AIWG_RULES_INLINE_BUDGET_TOKENS');
  });
  it.each([null, [], 42, 'bad'])('rejects malformed rules block %j', rules => {
    expect(validateRulesConfig(rules)).toEqual(['rules: must be an object']);
  });
  it('validates config read and write at existing loader boundaries', async () => {
    await writeFile(join(dir, '.aiwg/aiwg.config'), JSON.stringify({ version: '1', rules: { inline_budget_tokens: 0 } }));
    expect((await readAiwgConfigCandidate(dir))?.rules).toEqual({ inline_budget_tokens: 0 });
    await writeFile(join(dir, '.aiwg/aiwg.config'), JSON.stringify({ version: '1', rules: { inline_budget_tokens: -1 } }));
    await expect(readAiwgConfigCandidate(dir)).rejects.toThrow('rules.inline_budget_tokens');
    await expect(writeAiwgConfig(dir, { ...emptyConfig(), rules: { inline_budget_tokens: -1 } })).rejects.toThrow('rules.inline_budget_tokens');
  });
  it('config JSON schema accepts the key and rejects invalid values', () => {
    const schema = JSON.parse(readFileSync(new URL('../../../vscode-extension/schemas/aiwg.config.v1.json', import.meta.url), 'utf8'));
    const validate = new Ajv({ strict: true }).compile({ type: 'object', properties: { rules: schema.properties.rules } });
    expect(validate({ rules: { inline_budget_tokens: 0 } })).toBe(true);
    expect(validate({ rules: { inline_budget_tokens: 64000 } })).toBe(true);
    for (const value of [-1, 1.5, '42']) expect(validate({ rules: { inline_budget_tokens: value } })).toBe(false);
  });
  it('reports final bytes / 4 including indexes, behaviors, wrappers, and path metadata without changing files', () => {
    const files = Object.freeze([
      Object.freeze({ path: 'kernel', content: '🦊' }),
      Object.freeze({ path: 'RULES-INDEX.md', bytes: 8 }),
      Object.freeze({ path: 'behaviors/daemon.md', bytes: 12 }),
      Object.freeze({ path: 'wrapper-and-path-index', bytes: 16 }),
    ]);
    const result = guardRulesInlineBudget({ provider: 'claude', files, config: { rules: { inline_budget_tokens: 9 } }, env: {} });
    expect(result.passed).toBe(false);
    expect(result.report).toMatchObject({ limit: 9, provider: 'claude', selected_bytes: 40, selected_tokens: 10, exceeded: true });
    expect(result.report.contributors.map(f => f.path)).toEqual(['wrapper-and-path-index', 'behaviors/daemon.md', 'RULES-INDEX.md', 'kernel']);
    expect(files.map(f => f.path)).toEqual(['kernel', 'RULES-INDEX.md', 'behaviors/daemon.md', 'wrapper-and-path-index']);
    expect(result.diagnostics[0].severity).toBe('error');
  });
  it('warns in report mode, accepts exact boundary, and zero disables only this guard', () => {
    const options = { provider: 'codex', files: [{ path: 'AGENTS.md', bytes: 36 }], env: {}, config: { rules: { inline_budget_tokens: 8 } } };
    expect(guardRulesInlineBudget({ ...options, reportOnly: true })).toMatchObject({ passed: true, diagnostics: [{ severity: 'warn' }] });
    expect(guardRulesInlineBudget({ ...options, config: { rules: { inline_budget_tokens: 9 } } }).passed).toBe(true);
    expect(guardRulesInlineBudget({ ...options, config: { rules: { inline_budget_tokens: 0 } } }).report).toMatchObject({ disabled: true, selected_bytes: 36 });
  });
});
