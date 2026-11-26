// Offline inheritance regressions for ordinary agents, wrappers and native skills.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// @ts-expect-error shipped JavaScript module
import { checkWorkerHealthReadiness } from '../../../tools/cli/doctor-worker-health.mjs';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
let root: string;
let project: string;
async function put(relative: string, content: string) {
  const file = path.join(project, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
async function findings(providers = ['claude']) {
  const check = vi.fn();
  await checkWorkerHealthReadiness({ config: { providers }, configFailed: false,
    AIWG_ROOT: packageRoot, cwd: project, check });
  return check.mock.calls.filter(([id]) => id === 'delegation.flagship-inheritance').map(row => row[2]);
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'doctor-inheritance-'));
  project = path.join(root, 'project');
  await mkdir(project);
  for (const [key, value] of Object.entries({ HOME: root, USERPROFILE: root,
    XDG_CONFIG_HOME: path.join(root, 'xdg'), AIWG_CONFIG: path.join(root, 'config'),
    CODEX_HOME: path.join(root, '.codex'), HERMES_HOME: path.join(root, '.hermes'),
    AIWG_ROOT: packageRoot, AIWG_HOME: packageRoot,
    AIWG_RESOLVE_IMPL_FROM: 'src', CLAUDE_CODE_SUBAGENT_MODEL: '', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '' })) vi.stubEnv(key, value);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('delegation flagship inheritance (#2649)', () => {
  it.each(['', 'model: inherit\n', 'model: claude-fable-5-1\n'])(
    'flags an ordinary deployed agent with model metadata %j', async model => {
      await put('.claude/agents/ordinary.md', `---\nname: ordinary\n${model}---\nWork.\n`);
      expect(await findings()).toContainEqual(expect.stringContaining('ordinary'));
    });

  it('flags missing wrapper models even without a recorded parent session', async () => {
    await put('.claude/agents/aiwg-model-coding-worker.md', '---\nname: worker\n---\nWork.\n');
    expect(await findings()).toContainEqual(expect.stringContaining('aiwg-model-coding-worker'));
  });

  it('scans kernel and indexed skills; commandHint is intent rather than a native pin', async () => {
    await put('.claude/skills/kernel/SKILL.md', '---\nname: kernel\ncommandHint:\n  modelTier: standard\n  model: sonnet\n---\nWork.\n');
    await put('.claude/.aiwg/skills/indexed/SKILL.md', '---\nname: indexed\nmodel: inherit\n---\nWork.\n');
    const rows = await findings();
    expect(rows).toContainEqual(expect.stringContaining('kernel'));
    expect(rows).toContainEqual(expect.stringContaining('indexed'));
  });

  it('keeps explicit second-tier Claude and Codex workers safe under flagship sessions', async () => {
    await put('.claude/settings.json', '{"model":"claude-fable-5-1"}');
    await put('.codex/config.toml', 'model = "gpt-6-astra"\n');
    await put('.claude/agents/ordinary.md', '---\nmodel: claude-sonnet-5-5\n---\nWork.\n');
    await put('.codex/agents/ordinary.toml', 'model = "gpt-6.1-terra"\nmodel_reasoning_effort = "medium"\n');
    expect(await findings(['claude', 'codex'])).toEqual([]);
  });

  it('uses the existing exact operator override as an exemption, never source metadata', async () => {
    await put('.codex/agents/allowed.toml', 'model = "gpt-6-astra"\n');
    await put('.codex/agents/other.toml', 'model = "gpt-6-astra"\nmodel-tier = "flagship"\n');
    await put('models.json', '{"agentOverrides":{"allowed":{"model-override":"gpt-6-astra"}}}');
    const rows = await findings(['codex']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('other');
  });

  it('does not treat unsupported Codex skill model metadata as a native pin', async () => {
    await put('.codex/config.toml', 'model = "gpt-6-astra"\n');
    await put('.agents/skills/ordinary/SKILL.md', '---\nmodel: gpt-6.1-terra\n---\nWork.\n');
    expect(await findings(['codex'])).toContainEqual(expect.stringContaining('ordinary'));
  });

  it('does not apply the Claude subagent fallback to an inline skill in a flagship session', async () => {
    await put('.claude/settings.json', '{"model":"claude-fable-5-1","env":{"CLAUDE_CODE_SUBAGENT_MODEL":"sonnet"}}');
    await put('.claude/skills/inline/SKILL.md', '---\nname: inline\n---\nWork.\n');
    expect(await findings()).toContainEqual(expect.stringContaining('inline'));
  });

  it('exempts only exact allowlisted names in the existing flagship authority API', async () => {
    // @ts-expect-error shipped JavaScript module
    const { collectDelegationInheritance } = await import('../../../tools/cli/doctor-delegation-inheritance.mjs');
    await put('.claude/agents/allowed.md', '---\nmodel: claude-fable-5-1\n---\n');
    const options = { projectDir: project, config: { providers: ['claude'] }, packageRoot };
    expect(await collectDelegationInheritance({ ...options, flagshipAllowlist: ['allowed'] })).toEqual([]);
    expect(await collectDelegationInheritance({ ...options, flagshipAllowlist: ['allow*'] }))
      .toContainEqual(expect.objectContaining({ artifact: 'allowed', id: 'delegation.flagship-inheritance' }));
  });

  it('applies exact allowlist exemptions across the combined wrapper, agent and skill audit', async () => {
    // @ts-expect-error shipped JavaScript module
    const { collectDoctorModelChecks } = await import('../../../tools/cli/doctor-delegation-inheritance.mjs');
    const names = ['aiwg-model-coding-worker', 'allowed-agent', 'allowed-skill'];
    for (const name of names.slice(0, 2)) {
      await put(`.claude/agents/${name}.md`, '---\nmodel: claude-fable-5-1\n---\n');
    }
    await put('.claude/skills/allowed-skill/SKILL.md', '---\nmodel: claude-fable-5-1\n---\n');
    const options = { projectDir: project, config: { providers: ['claude'] }, packageRoot };
    const risks = async (flagshipAllowlist: string[]) =>
      (await collectDoctorModelChecks({ ...options, flagshipAllowlist }))
        .filter((row: any) => row.id === 'delegation.flagship-inheritance');
    expect(await risks(names)).toEqual([]);
    expect(await risks(['aiwg-model-*', 'allowed-*'])).toHaveLength(3);
    expect(await risks(['allowed-agent', 'allowed-skill'])).toEqual([
      expect.objectContaining({ wrapper: 'aiwg-model-coding-worker' }),
    ]);
  });

  it('honors a safe fallback but detects the forced Claude flagship override', async () => {
    await put('.claude/settings.json', '{"model":"claude-fable-5-1","env":{"CLAUDE_CODE_SUBAGENT_MODEL":"claude-sonnet-5-5"}}');
    await put('.claude/agents/ordinary.md', '---\nmodel: inherit\n---\nWork.\n');
    expect(await findings()).toEqual([]);
    await put('.claude/settings.json', '{"env":{"CLAUDE_CODE_SUBAGENT_MODEL":"claude-fable-5-1","CLAUDE_CODE_SUBAGENT_MODEL_FORCE":"1"}}');
    await put('.claude/agents/ordinary.md', '---\nmodel: sonnet\n---\nWork.\n');
    expect(await findings()).toContainEqual(expect.stringContaining('ordinary'));
  });

  it('reports malformed agent metadata and ignores auxiliary skill documentation', async () => {
    await put('.claude/agents/broken.md', '---\nmodel: [broken\n---\n');
    await put('.claude/skills/safe/SKILL.md', '---\nmodel: sonnet\n---\n');
    await put('.claude/skills/safe/README.md', 'Reference only.\n');
    const rows = await findings();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('broken');
  });

  it('scopes providers and parses JSON, TOML, and missing frontmatter conservatively', async () => {
    // @ts-expect-error shipped JavaScript module
    const { collectDelegationInheritance } = await import('../../../tools/cli/doctor-delegation-inheritance.mjs');
    await put('.codex/agents/json.json', '{"model":"gpt-6-astra"}');
    await put('.codex/agents/malformed.toml', 'model = [');
    await put('.codex/agents/notes.md', 'No native model.\n');
    await put('.codex/agents/ignored.txt', 'Not an agent artifact.\n');
    await put('.claude/agents/other.md', '---\nmodel: inherit\n---\n');
    const rows = await collectDelegationInheritance({ projectDir: project, packageRoot,
      config: { providers: ['claude', 'codex', 'codex'] }, provider: 'codex' });
    expect(rows).toHaveLength(3);
    expect(rows.every((row: any) => row.provider === 'codex')).toBe(true);
    expect(rows.map((row: any) => row.artifact).sort()).toEqual(['json', 'malformed', 'notes']);
  });

  it('applies user elections, project precedence, and matching tier elections', async () => {
    await put('.codex/agents/worker.toml', 'model = "gpt-6-astra"\n');
    await mkdir(path.join(root, 'config'), { recursive: true });
    await writeFile(path.join(root, 'config/models.json'), '{"agentOverrides":{"worker":{"model-override":"gpt-6-astra"}}}');
    expect(await findings(['codex'])).toEqual([]);
    await put('models.json', '{"agentOverrides":{"worker":{"model-override":"gpt-6-luna"}}}');
    expect(await findings(['codex'])).toContainEqual(expect.stringContaining('worker'));
    await put('models.json', '{"agentOverrides":{"worker":{"model-tier":"max-quality","model-override":"gpt-6-luna"}}}');
    expect(await findings(['codex'])).toEqual([]);
  });

  it('continues without exemptions when operator election metadata is malformed', async () => {
    // @ts-expect-error shipped JavaScript module
    const { collectDelegationInheritance } = await import('../../../tools/cli/doctor-delegation-inheritance.mjs');
    await put('models.json', '{broken');
    await put('.claude/agents/worker.md', '---\nmodel: inherit\n---\n');
    const rows = await collectDelegationInheritance({ projectDir: project, packageRoot, config: { providers: ['claude'] } });
    expect(rows).toContainEqual(expect.objectContaining({ id: 'delegation.election-settings' }));
    expect(rows).toContainEqual(expect.objectContaining({ artifact: 'worker', id: 'delegation.flagship-inheritance' }));
  });

  it('reports unavailable provider modules and unreadable artifact directories', async () => {
    // @ts-expect-error shipped JavaScript module
    const { collectDelegationInheritance } = await import('../../../tools/cli/doctor-delegation-inheritance.mjs');
    await put('.claude/agents', 'A file cannot serve as the agents directory.');
    const rows = await collectDelegationInheritance({ projectDir: project, packageRoot,
      config: { providers: ['missing-provider', 'claude'] } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row: any) => row.id === 'delegation.artifacts-unavailable')).toBe(true);
  });

  it('audits forked Claude skills with the forced subagent model', async () => {
    await put('.claude/settings.json', '{"model":"sonnet","env":{"CLAUDE_CODE_SUBAGENT_MODEL":"claude-fable-5-1","CLAUDE_CODE_SUBAGENT_MODEL_FORCE":"1"}}');
    await put('.claude/skills/forked/SKILL.md', '---\ncontext: fork\nmodel: sonnet\n---\n');
    expect(await findings()).toContainEqual(expect.stringContaining('forked'));
  });

  it('runs the standalone JSON mode in process and detects deployments without a config', async () => {
    // @ts-expect-error shipped JavaScript module
    const { runDoctor } = await import('../../../tools/cli/doctor.mjs');
    await put('.codex/agents/worker.toml', 'model = "inherit"\n');
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const previousArgs = process.argv;
    process.argv = [process.execPath, 'doctor.mjs', '--json'];
    try { await runDoctor(); } finally { process.argv = previousArgs; }
    const result = JSON.parse(String(write.mock.calls.at(-1)?.[0]));
    expect(result.checks).toContainEqual(expect.objectContaining({ artifact: 'worker', provider: 'codex' }));
  });

  it('accepts the issue validation command and emits offline checks without probing CLIs', async () => {
    await put('.aiwg/aiwg.config', '{"version":"1","providers":["codex"]}');
    await put('.codex/agents/ordinary.toml', 'model = "inherit"\n');
    const { stdout } = await promisify(execFile)(process.execPath,
      [path.join(packageRoot, 'bin/aiwg.mjs'), 'doctor', '--json'], {
        cwd: project, timeout: 30_000, env: { ...process.env, PATH: path.dirname(process.execPath),
          AIWG_ROOT: packageRoot, AIWG_HOME: packageRoot, AIWG_RESOLVE_IMPL_FROM: 'dist',
          AIWG_NO_UPDATE_CHECK: '1', AIWG_COMMAND_LOG: 'off' },
      });
    expect(JSON.parse(stdout).checks).toContainEqual(expect.objectContaining({
      id: 'delegation.flagship-inheritance', provider: 'codex', artifact: 'ordinary', status: 'warn',
    }));
  });
});
