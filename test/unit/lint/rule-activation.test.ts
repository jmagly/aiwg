import { main as lintMain } from '../../../src/lint/cli.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { autoDetectRulesets, runLint } from '../../../src/lint/runner.js';
import { ruleActivationRuleset } from '../../../src/lint/rule-activation.js';
import { discoverRulesets } from '../../../src/lint/loader.js';
import { formatResult } from '../../../src/lint/reporters.js';
import { resolveRuleBindingTarget } from '../../../src/artifacts/query-engine.js';
import { stableRecordId, recordTypeForEntry } from '../../../src/artifacts/browser-export.js';
import type { MetadataEntry } from '../../../src/artifacts/types.js';

const entry = (name: string, type: string, path = `agentic/code/addons/example/${type}s/${name}.md`) => ({ name, type, path, title: `Title ${name}` }) as MetadataEntry;
const repo = fileURLToPath(new URL('../../../', import.meta.url));

describe('activation lint in the existing runner (#2938)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aiwg-activation-lint-'));
    await mkdir(join(dir, 'rules'));
    await mkdir(join(dir, 'home'));
    vi.stubEnv('HOME', join(dir, 'home'));
    vi.stubEnv('AIWG_CONFIG', join(dir, 'home/.aiwg'));
    vi.stubEnv('XDG_DATA_HOME', dir);
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = undefined; await rm(dir, { recursive: true, force: true }); });
  const lint = async (content: string, entries: MetadataEntry[] = []) => {
    await writeFile(join(dir, 'rules/example.md'), content);
    return runLint(dir, [ruleActivationRuleset], { respectGitignore: false, artifactEntries: entries, ci: true });
  };
  it('warns only on detectable opposite directives sharing a declared subject and effective tier', async () => {
    const source = (directive: string, tier = 'high', subject = 'commit attribution') =>
      `---\nactivation: on-demand\nprecedence: ${tier}\nsubject: ${subject}\n---\n- ${directive}\n`;
    await writeFile(join(dir, 'rules/first.md'), source('Always add attribution.'));
    await writeFile(join(dir, 'rules/second.md'), source('Never add attribution.'));
    const run = () => runLint(dir, [ruleActivationRuleset], { respectGitignore: false, artifactEntries: [] });
    const result = await run();
    expect(result.summary).toMatchObject({ passed: true, warnings: 1 });
    expect(result.diagnostics[0].message).toMatch(/first.md.*second.md.*commit attribution.*high/);
    await writeFile(join(dir, 'rules/second.md'), source('Never add attribution.', 'low'));
    expect((await run()).summary.warnings).toBe(0);
    await writeFile(join(dir, 'rules/second.md'), source('Never add attribution.', 'high', 'emails'));
    expect((await run()).summary.warnings).toBe(0);
  });
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
  it('resolves enforcedBy against real gate identities and rejects unknown packs or gates', async () => {
    vi.stubEnv('AIWG_ROOT', dir);
    const packs = join(dir, 'agentic/code/addons/example/gate-packs');
    await mkdir(packs, { recursive: true });
    await writeFile(join(packs, 'checks.gatepack.json'), JSON.stringify({
      apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GatePack',
      metadata: { id: 'aiwg:example/checks', version: '1.0.0', description: 'Synthetic lint gates' },
      spec: { metrics: {}, gates: [{ id: 'ceiling', kind: 'upstream-ceiling', scope: { mode: 'all' },
        direction: 'higher-is-stricter', onFail: 'HOLD' }], combine: { rule: 'max-severity' } },
    }));
    const source = (ref: string) => `---\nactivation: kernel\nenforcedBy: ["${ref}"]\n---\nBody`;
    expect((await lint(source('aiwg:example/checks#ceiling'))).summary).toMatchObject({ passed: true, errors: 0, infos: 0 });
    for (const ref of ['aiwg:example/checks#missing', 'aiwg:example/missing#ceiling']) {
      const result = await lint(source(ref));
      expect(result.summary).toMatchObject({ passed: false, errors: 1 });
      expect(result.diagnostics[0].message).toContain(ref);
      expect(result.diagnostics[0].message).toMatch(/unknown gate/);
    }
  });
  it('rejects opaque enforcedBy metadata now that the field has a contract', async () => {
    expect((await lint('---\nactivation: kernel\nenforcedBy: {future: [hook]}\n---\nBody')).summary)
      .toMatchObject({ passed: false, errors: 1 });
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
    // `aiwg use all` indexes several generated plugin copies with absolute paths.
    // Plain entries use path-based precedence; packaged index provenance is
    // covered separately below because it overrides that ranking.
    const root = '/opt/aiwg/agentic/code';
    const raw = (p: string) => ({ name: 'flow-architecture-evolution', type: 'flow', path: p }) as any;
    const flow = raw(`${root}/frameworks/sdlc-complete/flows/flow-architecture-evolution.playbook.yaml`);
    const copies = ['sdlc', 'codex-sdlc'].map(plugin => raw(`${root}/plugins/${plugin}/flows/flow-architecture-evolution.playbook.yaml`));
    expect(resolveRuleBindingTarget([...copies, flow], 'flow', 'flow-architecture-evolution')).toBe(flow);
    expect(() => resolveRuleBindingTarget(copies, 'flow', 'flow-architecture-evolution')).toThrow('Ambiguous flow');
    const stableId = stableRecordId(recordTypeForEntry(canonical, 'v2'), canonical.path);
    expect(resolveRuleBindingTarget([canonical], 'agent', stableId)).toBe(canonical);
    const result = await lint(`---\nactivation: paths\nsummary: Fix source.\npaths: [src/**]\nbound_to:\n  agents: [${stableId}]\n  skills: [fix-source]\n  flows: [flow-fix]\n---\nBody`, [canonical, entry('fix-source', 'skill'), entry('flow-fix', 'flow')]);
    expect(result.summary).toMatchObject({ passed: true, errors: 0, warnings: 0 });
  });
  it.each(['mixed', 'packaged'] as const)(
    'resolves packaged flow bindings despite generated plugin copies (%s provenance, #2945)',
    provenance => {
      const name = 'flow-architecture-evolution';
      // prepareRuleDelivery merges provenance-tagged framework index entries
      // with raw rebuilt source entries and makes their paths absolute. Packaged
      // scope and untagged plugin locality both rank 3, defeating show's normal
      // rank-2 canonical-source preference. cwd and stable IDs are irrelevant.
      const root = join(dir, 'aiwg/agentic/code');
      const canonical = { ...entry(name, 'flow', `${root}/frameworks/sdlc-complete/flows/${name}.playbook.yaml`),
        indexGraph: 'framework', indexScope: 'packaged' };
      const copies = ['codex-sdlc', 'sdlc'].map(plugin => ({
        ...entry(name, 'flow', `${root}/plugins/${plugin}/flows/${name}.playbook.yaml`),
        ...(provenance === 'packaged' ? { indexGraph: 'framework', indexScope: 'packaged' } : {}),
      }));
      // Keep genuine ambiguity errors; generated copies alone and two authored
      // sources must never silently select one of the tied candidates.
      expect(() => resolveRuleBindingTarget(copies, 'flow', name)).toThrow('Ambiguous flow');
      const other = { ...canonical, path: `${root}/addons/other/flows/${name}.playbook.yaml` };
      expect(() => resolveRuleBindingTarget([...copies, canonical, other], 'flow', name)).toThrow('Ambiguous flow');
      const copyId = stableRecordId(recordTypeForEntry(copies[0], 'v2'), copies[0].path);
      expect(resolveRuleBindingTarget([...copies, canonical], 'flow', copyId)).toBe(copies[0]);
      expect(resolveRuleBindingTarget([...copies, canonical], 'flow', name)).toBe(canonical);
    },
  );
  it.each(['skill', 'agent'] as const)(
    'resolves packaged %s rule bindings alongside generated plugin copies (#2945)',
    type => {
      const name = type === 'skill' ? 'flow-architecture-evolution' : 'architecture-designer';
      const suffix = type === 'skill' ? `skills/${name}/SKILL.md` : `agents/${name}.md`;
      const root = join(dir, 'aiwg/agentic/code');
      const canonical = { ...entry(name, type, `${root}/frameworks/sdlc-complete/${suffix}`),
        indexGraph: 'framework', indexScope: 'packaged' };
      for (const provenance of ['mixed', 'packaged']) {
        const copies = ['codex-sdlc', 'sdlc'].map(plugin => ({
          ...entry(name, type, `${root}/plugins/${plugin}/${suffix}`),
          ...(provenance === 'packaged' ? { indexGraph: 'framework', indexScope: 'packaged' } : {}),
        }));
        // These layouts already have type-specific canonical-source fallbacks.
        expect(resolveRuleBindingTarget([...copies, canonical], type, name)).toBe(canonical);
        expect(() => resolveRuleBindingTarget(copies, type, name)).toThrow(`Ambiguous ${type}`);
        const other = { ...canonical, path: `${root}/frameworks/other/${suffix}` };
        expect(() => resolveRuleBindingTarget([...copies, canonical, other], type, name)).toThrow(`Ambiguous ${type}`);
      }
    },
  );
  it('rejects command rule bindings even when command plugin copies exist (#2945)', async () => {
    const commands = ['frameworks/sdlc-complete', 'plugins/codex-sdlc', 'plugins/sdlc'].map(bundle =>
      entry('build', 'command', join(dir, `aiwg/agentic/code/${bundle}/commands/build.md`)));
    const result = await lint('---\nactivation: bound\nsummary: Build the project.\nbound_to:\n  commands: [build]\n---\nBody', commands);
    expect(result.summary.passed).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error',
      message: expect.stringContaining('additional properties') }));
    expect(() => resolveRuleBindingTarget(commands, 'flow', 'build')).toThrow('Missing flow');
  });
  it('resolves canonical slugs with display-name frontmatter without accepting titles or paths', () => {
    const agent = { ...entry('Build Engineer', 'agent', 'agentic/code/frameworks/sdlc-complete/agents/build-engineer.md'), title: 'Build automation expert' };
    const skill = entry('Decision Offload', 'skill', 'agentic/code/addons/decision-engine/skills/decision-offload/SKILL.md');
    expect(resolveRuleBindingTarget([agent], 'agent', 'build-engineer')).toBe(agent);
    expect(resolveRuleBindingTarget([skill], 'skill', 'decision-offload')).toBe(skill);
    expect(() => resolveRuleBindingTarget([agent], 'agent', agent.title)).toThrow('Missing agent');
    expect(() => resolveRuleBindingTarget([agent], 'agent', agent.path)).toThrow('Missing agent');
  });
  it('loads canonical source targets even when a persisted index disagrees (#3643)', async () => {
    vi.stubEnv('AIWG_ROOT', dir);
    const agents = join(dir, 'agentic/code/addons/example/agents');
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, 'lint-source-agent.md'), '---\nname: lint-source-agent\n---\n# Source agent');
    const indexDir = join(dir, '.aiwg/.index/project');
    await mkdir(indexDir, { recursive: true });
    await writeFile(join(indexDir, 'metadata.json'), JSON.stringify({ entries: { stale: entry('lint-source-agent', 'skill') } }));
    await writeFile(join(dir, 'rules/example.md'), '---\nactivation: bound\nsummary: Fix source.\nbound_to:\n  agents: [lint-source-agent]\n---\nBody');
    const result = await runLint(dir, [ruleActivationRuleset], { respectGitignore: false });
    expect(result.summary.passed).toBe(true);
  });
  it('resolves every shipped binding with an empty HOME and AIWG_CONFIG (#3643)', async () => {
    vi.stubEnv('AIWG_ROOT', repo);
    vi.stubEnv('AIWG_FRAMEWORK_INDEX_CACHE', '');
    expect(await readdir(join(dir, 'home'))).toEqual([]);
    const result = await runLint(join(repo, 'agentic/code'), [ruleActivationRuleset], { respectGitignore: false, ci: true });
    expect(result.summary.filesChecked).toBeGreaterThan(0);
    expect(result.diagnostics.filter(d => /^Missing (skill|agent|flow) binding target/.test(d.message))).toEqual([]);
    expect(result.summary).toMatchObject({ passed: true, errors: 0 });
    expect(await readdir(join(dir, 'home'))).toEqual([]);
  });
  it('still reports a non-existent skill with an empty HOME and AIWG_CONFIG (#3643)', async () => {
    vi.stubEnv('AIWG_ROOT', dir);
    await writeFile(join(dir, 'rules/example.md'), '---\nactivation: bound\nsummary: Fix source.\nbound_to:\n  skills: [non-existent-lint-skill]\n---\nBody');
    const result = await runLint(dir, [ruleActivationRuleset], { respectGitignore: false, ci: true });
    expect(result.summary).toMatchObject({ passed: false, errors: 1 });
    expect(result.diagnostics[0].message).toContain('Missing skill');
    expect(result.diagnostics[0].message).toContain('non-existent-lint-skill');
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
