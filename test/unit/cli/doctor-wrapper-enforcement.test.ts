// Synthetic config and native wrapper fixtures: no provider calls and no real HOME.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import cases from '../../fixtures/models/doctor-wrapper-cases.json';
// @ts-expect-error shipped JavaScript module
import { collectWrapperEnforcement } from '../../../tools/cli/doctor-wrapper-enforcement.mjs';
// @ts-expect-error shipped JavaScript module
import { readWrapperSettings } from '../../../tools/cli/doctor-wrapper-settings.mjs';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const wrapper = 'aiwg-model-coding-worker';
let root: string;
let projectDir: string;
async function put(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
const collect = (providers = ['codex']) => collectWrapperEnforcement({ projectDir, config: { providers }, packageRoot });
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'doctor-wrapper-'));
  projectDir = path.join(root, 'project');
  await mkdir(projectDir);
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('AIWG_CONFIG', path.join(root, 'config'));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'xdg'));
  vi.stubEnv('CODEX_HOME', path.join(root, '.codex'));
  vi.stubEnv('HERMES_HOME', path.join(root, '.hermes'));
  vi.stubEnv('CLAUDE_CODE_SUBAGENT_MODEL', '');
  vi.stubEnv('CLAUDE_CODE_SUBAGENT_MODEL_FORCE', '');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('offline doctor wrapper checks', () => {
  it('recognizes the single Muse catalog model elected in native settings without changing other pins (#4325)', async () => {
    const claude = path.join(projectDir, `.claude/agents/${wrapper}.md`);
    const codex = path.join(projectDir, `.codex/agents/${wrapper}.toml`);
    await put(claude, '---\nmodel: sonnet\neffort: medium\n---\n');
    await put(codex, 'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n');
    const before = await collect(['claude', 'codex']);
    await put(path.join(root, 'xdg/muse/settings.json'), '{"model":"muse-spark-1.3","contributor_mode_enabled":false}');
    const after = await collect(['muse', 'claude', 'codex']);
    expect(after.filter((c: any) => c.provider === 'muse' && c.id)).toEqual([]);
    expect(after.filter((c: any) => c.provider !== 'muse')).toEqual(before);
    expect(await readFile(claude, 'utf8')).toBe('---\nmodel: sonnet\neffort: medium\n---\n');
    expect(await readFile(codex, 'utf8')).toBe('model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n');
  });

  it.each(cases)('reports $name and leaves fixture settings/wrappers byte-identical', async fixture => {
    const ext = fixture.provider === 'codex' ? 'toml' : 'md';
    const artifact = path.join(projectDir, `.${fixture.provider}/agents/${wrapper}.${ext}`);
    const settings = path.join(projectDir, '.codex/config.toml');
    const config = path.join(projectDir, '.aiwg/aiwg.config');
    await put(artifact, fixture.wrapper);
    await put(settings, fixture.settings);
    await put(config, JSON.stringify({ providers: [fixture.provider] }));
    const timestamps = await Promise.all([artifact, settings, config].map(file => stat(file, { bigint: true }).then(s => s.mtimeNs)));
    const checks = await collect([fixture.provider]);
    expect(checks).toContainEqual(expect.objectContaining({ provider: fixture.provider, wrapper,
      modelEnforcement: fixture.model, effortEnforcement: fixture.effort }));
    expect(checks.filter((c: any) => c.id).map((c: any) => c.id)).toEqual(fixture.risks);
    for (const check of checks.filter((c: any) => c.id)) {
      expect(check).toMatchObject({ provider: fixture.provider, wrapper,
        remediation: `aiwg models resolve --agent ${wrapper} --provider ${fixture.provider} --tier standard` });
      expect(check.message).toContain(check.remediation);
    }
    expect(await readFile(artifact, 'utf8')).toBe(fixture.wrapper);
    expect(await readFile(settings, 'utf8')).toBe(fixture.settings);
    expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({ providers: [fixture.provider] });
    expect(await Promise.all([artifact, settings, config].map(file => stat(file, { bigint: true }).then(s => s.mtimeNs)))).toEqual(timestamps);
  });

  it('reports all configured providers, including those without deployed wrappers', async () => {
    const checks = await collect(['codex', 'hermes', 'muse', 'devin']);
    expect(checks.filter((c: any) => c.status === 'info' && !c.wrapper).map((c: any) => c.provider)).toEqual(['codex', 'hermes', 'muse', 'devin']);
    expect(checks.find((c: any) => c.provider === 'hermes').message).toContain('): global-only;');
    expect(checks.find((c: any) => c.provider === 'devin').message).toContain('): inherited;');
  });

  it.each([
    ['hermes', 'delegation.model', 'delegation.effort'],
    ['warp', '--model', 'effort: unavailable'],
    ['muse', '--model', '--reasoning-effort'],
    ['grokbot', 'model: unavailable', 'effort: unavailable'],
  ])('names global native controls in %s remediation', async (provider, model, effort) => {
    const checks = await collect([provider]);
    const risks = checks.filter((c: any) => c.id);
    expect(risks.length).toBeGreaterThan(0);
    for (const risk of risks) {
      expect(risk.message).toContain(model);
      expect(risk.message).toContain(effort);
    }
  });

  it('flags shared flagship inheritance for each Hermes wrapper without standalone files', async () => {
    await put(path.join(root, '.hermes/config.yaml'), 'delegation:\n  model: gpt-6-astra\n');
    const checks = await collect(['hermes']);
    const risks = checks.filter((c: any) => c.id === 'delegation.flagship-inheritance');
    expect(risks).toHaveLength(5);
    expect(risks).toContainEqual(expect.objectContaining({ provider: 'hermes', wrapper,
      remediation: `aiwg models resolve --agent ${wrapper} --provider hermes --tier standard` }));
  });

  it.each([{ 'model-override': 'gpt-6-astra' }, { 'model-tier': 'flagship' }])('honors explicit operator election %j', async override => {
    await put(path.join(projectDir, `.codex/agents/${wrapper}.toml`), 'name = "worker"\n');
    await put(path.join(projectDir, '.codex/config.toml'), 'model = "gpt-6-astra"\n');
    await put(path.join(projectDir, 'models.json'), JSON.stringify({ agentOverrides: { [wrapper]: override } }));
    expect((await collect()).filter((c: any) => c.id)).toEqual([]);
  });

  it.each([{ 'model-override': 'gpt-6-astra' }, { 'model-tier': 'flagship' }])('matches a pinned flagship election %j against its resolved model', async override => {
    await put(path.join(projectDir, `.codex/agents/${wrapper}.toml`), 'model = \"gpt-6-astra\"\n');
    await put(path.join(projectDir, '.codex/config.toml'), 'model = \"gpt-6-luna\"\n');
    await put(path.join(projectDir, 'models.json'), JSON.stringify({ agentOverrides: { [wrapper]: override } }));
    expect((await collect()).filter((c: any) => c.id)).toEqual([]);
    await put(path.join(projectDir, 'models.json'), JSON.stringify({ agentOverrides: { [wrapper]: { 'model-override': 'gpt-6-luna' } } }));
    expect((await collect()).filter((c: any) => c.id).map((c: any) => c.id)).toEqual(['delegation.flagship-inheritance']);
  });

  it('ignores built-in premium metadata as election and honors a different project override over a user pin', async () => {
    await put(path.join(projectDir, `.codex/agents/${wrapper}.toml`), 'model-tier = "premium"\n');
    await put(path.join(projectDir, '.codex/config.toml'), 'model = "gpt-6-astra"\n');
    await put(path.join(root, 'config/models.json'), JSON.stringify({ agentOverrides: { [wrapper]: { 'model-override': 'gpt-6-astra' } } }));
    await put(path.join(projectDir, 'models.json'), JSON.stringify({ agentOverrides: { [wrapper]: { 'model-override': 'gpt-6-luna' } } }));
    expect((await collect()).filter((c: any) => c.id).map((c: any) => c.id)).toEqual(['delegation.flagship-inheritance']);
  });

  it('does not confuse a premium election with a flagship election', async () => {
    await put(path.join(projectDir, `.codex/agents/${wrapper}.toml`), 'name = "worker"\n');
    await put(path.join(projectDir, 'models.json'), '{"defaults":{"tier":"premium"}}');
    await put(path.join(projectDir, '.codex/config.toml'), 'model = "gpt-6-astra"\n');
    expect((await collect()).filter((c: any) => c.id)).toContainEqual(expect.objectContaining({ id: 'delegation.flagship-inheritance' }));
    await put(path.join(projectDir, '.codex/config.toml'), 'model = "gpt-6.1-sol"\n');
    expect((await collect()).filter((c: any) => c.id)).toEqual([]);
  });

  it('reads native settings precedence, TOML profiles, and global-only settings offline', async () => {
    await put(path.join(root, '.codex/config.toml'), 'model = "global"\n');
    await put(path.join(projectDir, '.codex/config.toml'), 'profile = "economy"\n[profiles.economy]\nmodel = \'gpt-6-luna\' # comment\nmodel_reasoning_effort = "low"\n');
    expect(await readWrapperSettings('codex', projectDir)).toMatchObject({ inheritedModel: 'gpt-6-luna', inheritedEffort: 'low' });
    await put(path.join(root, '.hermes/config.yaml'), 'delegation:\n  model: global-model\n  effort: low\n');
    expect(await readWrapperSettings('hermes', projectDir)).toMatchObject({ inheritedModel: 'global-model', inheritedEffort: 'low' });
    await put(path.join(root, 'xdg/muse/settings.json'), '{"model":"muse-model"}');
    expect(await readWrapperSettings('muse', projectDir)).toMatchObject({ inheritedModel: 'muse-model' });
    await put(path.join(root, '.claude/settings.json'), '{"model":"sonnet"}');
    await put(path.join(projectDir, '.claude/settings.local.json'), '{"env":{"CLAUDE_CODE_SUBAGENT_MODEL":"opus","CLAUDE_CODE_SUBAGENT_MODEL_FORCE":"1"}}');
    expect(await readWrapperSettings('claude', projectDir)).toMatchObject({ inheritedModel: 'opus', forceInheritedModel: true });
    await put(path.join(projectDir, '.claude/settings.local.json'), '{"env":{"CLAUDE_CODE_SUBAGENT_MODEL_FORCE":"1"}}');
    expect(await readWrapperSettings('claude', projectDir)).toMatchObject({ inheritedModel: 'sonnet', forceInheritedModel: false });
  });

  it('surfaces malformed settings rather than claiming a healthy deployed pin', async () => {
    await put(path.join(projectDir, '.codex/config.toml'), '[broken');
    expect(await collect()).toContainEqual(expect.objectContaining({ provider: 'codex', status: 'warn', message: expect.stringContaining('unavailable') }));
  });

  async function textChecks(providers: string[]) {
    // @ts-expect-error shipped JavaScript module
    const { checkWorkerHealthReadiness } = await import('../../../tools/cli/doctor-worker-health.mjs');
    const check = vi.fn();
    await checkWorkerHealthReadiness({ config: { providers }, configFailed: false,
      AIWG_ROOT: packageRoot, cwd: projectDir, check });
    return check.mock.calls.filter(([name]) => name === 'Wrapper enforcement' || name.startsWith('delegation.'));
  }

  it('prints one provider line when all wrappers share its state and explains native settings once', async () => {
    const lines = await textChecks(['hermes']);
    const summaries = lines.filter(([name]) => name === 'Wrapper enforcement');
    expect(summaries).toHaveLength(1);
    expect(summaries[0][2]).toContain('global-only');
    for (const role of ['reasoning-worker', 'coding-worker', 'efficiency-worker', 'explorer', 'verifier']) {
      expect(summaries[0][2]).toContain(`aiwg-model-${role}`);
    }
    expect(lines.map(row => row[2]).join('\n').match(/not a live resolved-model audit/g)).toHaveLength(1);
  });

  it('prints only differing model or effort states separately from the provider', async () => {
    await put(path.join(projectDir, `.codex/agents/${wrapper}.toml`), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n');
    await put(path.join(projectDir, '.codex/agents/aiwg-model-verifier.toml'), 'model = "inherit"\n');
    await put(path.join(projectDir, '.codex/agents/aiwg-model-explorer.toml'), 'model = "gpt-6-luna"\n');
    const lines = (await textChecks(['codex'])).filter(([name]) => name === 'Wrapper enforcement');
    expect(lines).toHaveLength(3);
    expect(lines[0][2]).toContain(`Wrappers: ${wrapper}`);
    expect(lines[1][2]).toContain('aiwg-model-explorer: pinned');
    expect(lines[1][2]).toContain('effort: inherited');
    expect(lines[2][2]).toContain('aiwg-model-verifier: inherited');
    expect(lines.map(row => row[2]).join('\n').match(/not a live resolved-model audit/g)).toHaveLength(1);
  });

  it('groups flagship warnings by provider and remediation while naming every affected wrapper', async () => {
    await put(path.join(root, '.hermes/config.yaml'), 'delegation:\n  model: gpt-6-astra\n');
    await put(path.join(root, 'xdg/muse/settings.json'), '{"model":"gpt-6-astra"}');
    const lines = (await textChecks(['hermes', 'muse'])).filter(([name]) => name === 'delegation.flagship-inheritance');
    expect(lines).toHaveLength(2);
    for (const [index, provider] of ['hermes', 'muse'].entries()) {
      expect(lines[index][2]).toContain(provider);
      for (const role of ['reasoning-worker', 'coding-worker', 'efficiency-worker', 'explorer', 'verifier']) {
        expect(lines[index][2]).toContain(`aiwg-model-${role}`);
      }
      expect(lines[index][2]).toContain(`--agent <wrapper> --provider ${provider} --tier standard`);
    }
  });

  it('keeps warnings with different remediation separate and does not mutate JSON findings', async () => {
    // @ts-expect-error shipped JavaScript module
    const { wrapperTextFindings } = await import('../../../tools/cli/doctor-wrapper-text.mjs');
    await put(path.join(root, '.hermes/config.yaml'), 'delegation:\n  model: gpt-6-astra\n');
    const findings = await collect(['hermes']);
    const first = findings.find((row: any) => row.id);
    first.remediation += ' --effort low';
    first.message += ' Use low effort.';
    const original = structuredClone(findings);
    const warnings = wrapperTextFindings(findings).filter((row: any) => row.id);
    expect(warnings).toHaveLength(2);
    expect(warnings[0].message).toBe(first.message);
    expect(warnings[1].message).not.toContain(first.wrapper);
    expect(findings).toEqual(original);
  });

  it('replays the conductor sample wrapper configuration in eight lines instead of twenty-six', async () => {
    // @ts-expect-error shipped JavaScript module
    const { wrapperTextFindings } = await import('../../../tools/cli/doctor-wrapper-text.mjs');
    await put(path.join(root, 'xdg/muse/settings.json'), '{"model":"gpt-6-astra"}');
    await put(path.join(root, '.hermes/config.yaml'), 'delegation:\n  model: gpt-6-luna\n');
    for (const role of ['coding', 'efficiency', 'reasoning']) {
      const name = `aiwg-model-${role}-worker`;
      await put(path.join(projectDir, `.codex/agents/${name}.toml`), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n');
      await put(path.join(projectDir, `.claude/agents/${name}.md`), `---\nmodel: ${role === 'reasoning' ? 'opus' : 'sonnet'}\n---\n`);
    }
    const findings = await collect(['muse', 'codex', 'hermes', 'claude']);
    // Claude's reasoning wrapper pinned to its premium role default is not a risk.
    expect(findings).toHaveLength(25);
    const text = wrapperTextFindings(findings);
    expect(text).toHaveLength(8);
    expect(text.filter((row: any) => row.id === 'delegation.flagship-inheritance')).toHaveLength(1);
    // The 182-line capture contains 26 wrapper lines; all other sections are untouched.
    expect(182 - 26 + text.length).toBe(164);
  });

  it('ordinary doctor emits the checks through its existing offline health module', async () => {
    // @ts-expect-error shipped JavaScript module
    const { checkWorkerHealthReadiness } = await import('../../../tools/cli/doctor-worker-health.mjs');
    await put(path.join(projectDir, `.codex/agents/${wrapper}.toml`), 'model = "configured/coding"\n');
    const check = vi.fn();
    await checkWorkerHealthReadiness({ config: { providers: ['codex'] }, configFailed: false,
      AIWG_ROOT: packageRoot, cwd: projectDir, check });
    expect(check).toHaveBeenCalledWith('Wrapper enforcement', 'info', expect.stringContaining('Tier enforcement'));
    expect(check).toHaveBeenCalledWith('delegation.unresolved-model', 'warn', expect.stringContaining(wrapper));
  });

  it('keeps existing JSON worker fields and adds offline wrapper checks without executing a provider', async () => {
    await put(path.join(projectDir, '.aiwg/aiwg.config'), JSON.stringify({ version: '1', providers: ['codex'],
      parallelism: { worker_dispatch: false } }));
    await put(path.join(projectDir, `.codex/agents/${wrapper}.toml`), 'model = "configured/coding"\n');
    const { stdout } = await promisify(execFile)(process.execPath,
      [path.join(packageRoot, 'tools/cli/doctor.mjs'), '--probe-workers', '--json'], {
        cwd: projectDir, timeout: 30_000, env: { ...process.env, PATH: root,
          AIWG_ROOT: packageRoot, AIWG_HOME: packageRoot, AIWG_RESOLVE_IMPL_FROM: 'dist',
          AIWG_NO_UPDATE_CHECK: '1', AIWG_COMMAND_LOG: 'off' },
      });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ probeWorkers: true, workerDispatch: false, workersConfigured: false, workers: [],
      nativeSandboxWarnings: expect.any(Array), decisionOffload: expect.any(Object), message: expect.any(String) });
    expect(JSON.parse(JSON.stringify(result.wrapperEnforcement).replaceAll(projectDir, '<project>'))).toMatchSnapshot();
    expect(result.wrapperEnforcement).toContainEqual(expect.objectContaining({ id: 'delegation.unresolved-model', provider: 'codex', wrapper }));
  });
});
