import { main as lintMain } from '../../../src/lint/cli.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autoDetectRulesets, runLint } from '../../../src/lint/runner.js';
import { ruleActivationRuleset } from '../../../src/lint/rule-activation.js';
import { discoverRulesets } from '../../../src/lint/loader.js';
import { formatResult } from '../../../src/lint/reporters.js';
import { resolveRuleBindingTarget } from '../../../src/artifacts/query-engine.js';
import { stableRecordId, recordTypeForEntry } from '../../../src/artifacts/browser-export.js';
import type { MetadataEntry } from '../../../src/artifacts/types.js';

const entry = (name: string, type: string, path = `agentic/code/addons/example/${type}s/${name}.md`) => ({ name, type, path, title: `Title ${name}` }) as MetadataEntry;

describe('activation lint in the existing runner (#2938)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aiwg-activation-lint-'));
    await mkdir(join(dir, 'rules'));
    vi.stubEnv('XDG_DATA_HOME', dir);
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = undefined; await rm(dir, { recursive: true, force: true }); });
  const lint = async (content: string, entries: MetadataEntry[] = []) => {
    await writeFile(join(dir, 'rules/example.md'), content);
    return runLint(dir, [ruleActivationRuleset], { respectGitignore: false, artifactEntries: entries, ci: true });
  };
  it('is discoverable without a separate lint subsystem', async () => {
    expect((await discoverRulesets(dir, dir)).map(r => r.id)).toContain('rule-activation');
    const research = { ...ruleActivationRuleset, id: 'research', framework: 'research' };
    expect(autoDetectRulesets('research', [ruleActivationRuleset, research])).toEqual([ruleActivationRuleset, research]);
  });
  it('errors on invalid activation and contradictory combinations', async () => {
    expect((await lint('---\nactivation: alwaysApply\n---\nBody')).summary).toMatchObject({ passed: false, errors: 1 });
    expect((await lint('---\nactivation: kernel\nbound_to:\n  agents: [debugger]\n---\nBody', [entry('debugger', 'agent')])).summary.passed).toBe(false);
  });
  it('warns on missing activation, names the file and inferred delivery, and passes CI during migration', async () => {
    const result = await lint('---\nenforcement: medium\npaths: [legacy/**]\n---\nBody');
    expect(result.summary).toMatchObject({ errors: 0, warnings: 1, passed: true, rulesApplied: 1 });
    expect(result.diagnostics[0]).toMatchObject({ file: 'rules/example.md', severity: 'warn', message: expect.stringContaining('on-demand') });
  });
  it('reports opaque enforcedBy with no effect', async () => {
    const result = await lint('---\nactivation: kernel\nenforcedBy: {future: [hook]}\n---\nBody');
    expect(result.summary).toMatchObject({ errors: 0, infos: 1 });
  });
  it('errors on missing, ambiguous, wrong-type, title guesses, and wildcard binding targets', async () => {
    const source = (target: string) => `---\nactivation: bound\nsummary: Fix source.\nbound_to:\n  agents: ["${target}"]\n---\nBody`;
    expect((await lint(source('debugger'))).diagnostics[0].message).toContain('Missing agent');
    const agents = [entry('debugger', 'agent'), entry('debugger', 'agent', 'agentic/code/addons/other/agents/debugger.md')];
    expect((await lint(source('debugger'), agents)).diagnostics[0].message).toContain('Ambiguous agent');
    expect((await lint(source('debugger'), [entry('debugger', 'skill')])).summary.passed).toBe(false);
    expect((await lint(source('Title debugger'), [entry('debugger', 'agent')])).summary.passed).toBe(false);
    expect((await lint(source('debug*'), agents)).summary.passed).toBe(false);
  });
  it('resolves exact type/name and stable index IDs using existing source precedence', async () => {
    const canonical = entry('debugger', 'agent');
    const mirror = entry('debugger', 'agent', 'agentic/code/plugins/example/agents/debugger.md');
    expect(resolveRuleBindingTarget([mirror, canonical], 'agent', 'debugger')).toBe(canonical);
    const stableId = stableRecordId(recordTypeForEntry(canonical, 'v2'), canonical.path);
    expect(resolveRuleBindingTarget([canonical], 'agent', stableId)).toBe(canonical);
    const result = await lint(`---\nactivation: paths\nsummary: Fix source.\npaths: [src/**]\nbound_to:\n  agents: [${stableId}]\n  skills: [fix-source]\n  flows: [flow-fix]\n---\nBody`, [canonical, entry('fix-source', 'skill'), entry('flow-fix', 'flow')]);
    expect(result.summary).toMatchObject({ passed: true, errors: 0, warnings: 0 });
  });
  it('loads binding targets from the existing artifact index when not supplied', async () => {
    const indexDir = join(dir, '.aiwg/.index/project');
    await mkdir(indexDir, { recursive: true });
    await writeFile(join(indexDir, 'metadata.json'), JSON.stringify({ entries: { debugger: entry('debugger', 'agent') } }));
    await writeFile(join(dir, 'rules/example.md'), '---\nactivation: bound\nsummary: Fix source.\nbound_to:\n  agents: [debugger]\n---\nBody');
    const result = await runLint(dir, [ruleActivationRuleset], { respectGitignore: false });
    expect(result.summary.passed).toBe(true);
  });
  it('validates behavior source contracts and excludes only generated structural indexes', async () => {
    await mkdir(join(dir, 'behaviors/daemon'), { recursive: true });
    await writeFile(join(dir, 'behaviors/daemon/BEHAVIOR.md'), '---\nactivation: invalid\n---\nBody');
    await writeFile(join(dir, 'rules/RULES-INDEX.md'), '# Generated');
    const result = await runLint(dir, [ruleActivationRuleset], { respectGitignore: false });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].file).toBe('behaviors/daemon/BEHAVIOR.md');
  });
  it('runs the CLI startup-plan guard with project config and the winning environment override', async () => {
    await mkdir(join(dir, '.aiwg'));
    await writeFile(join(dir, '.aiwg/aiwg.config'), JSON.stringify({ version: '1', rules: { inline_budget_tokens: 1 } }));
    await writeFile(join(dir, 'rules/example.md'), '---\nactivation: kernel\n---\nBody');
    const planPath = join(dir, 'startup.json');
    await writeFile(planPath, JSON.stringify({ provider: 'codex', files: [{ path: 'AGENTS.md', bytes: 8 }] }));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = ['rules', '--ruleset', 'rule-activation', '--startup-plan', planPath, '--format', 'json', '--no-gitignore', '--ci'];
    await lintMain(args);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).inlineBudget).toMatchObject({ limit: 1, selected_bytes: 8 });
    process.exitCode = undefined;
    vi.stubEnv('AIWG_RULES_INLINE_BUDGET_TOKENS', '0');
    await lintMain(args);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).inlineBudget).toMatchObject({ limit: 0, disabled: true });
  });
  it('turns invalid budget configuration into a failing lint diagnostic', async () => {
    await writeFile(join(dir, 'rules/example.md'), '---\nactivation: kernel\n---\nBody');
    const result = await runLint(dir, [ruleActivationRuleset], { respectGitignore: false, startupBudget: {
      provider: 'claude', files: [], env: { AIWG_RULES_INLINE_BUDGET_TOKENS: 'invalid' },
    } });
    expect(result.summary).toMatchObject({ passed: false, errors: 1 });
    expect(result.diagnostics[0].message).toContain('AIWG_RULES_INLINE_BUDGET_TOKENS');
  });
  it('reports budget contributors in JSON and terminal output, warns in report mode, errors in CI', async () => {
    await writeFile(join(dir, 'rules/example.md'), '---\nactivation: kernel\n---\nBody');
    const startupBudget = { provider: 'claude', files: [{ path: 'rules/example.md', bytes: 400 }], config: { rules: { inline_budget_tokens: 99 } }, env: {} };
    const result = await runLint(dir, [ruleActivationRuleset], { respectGitignore: false, startupBudget });
    expect(result.summary).toMatchObject({ warnings: 1, errors: 0, passed: true });
    expect(JSON.parse(formatResult(result, 'json')).inlineBudget).toMatchObject({ limit: 99, selected_tokens: 100, provider: 'claude' });
    expect(formatResult(result, 'full')).toContain('400 bytes');
    const strict = await runLint(dir, [ruleActivationRuleset], { respectGitignore: false, ci: true, startupBudget: { ...startupBudget, reportOnly: true } });
    expect(strict.summary).toMatchObject({ errors: 1, passed: false });
  });
});
