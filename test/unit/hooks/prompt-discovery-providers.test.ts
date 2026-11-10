// Assert working context delivery and explicit bridge gaps for prompt discovery.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, unlink, access, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHookSources } from '../../../src/smiths/hook-bridge/loader.js';
import { verifiedHookCommand } from '../../../src/extensions/verified-hook-command.js';
import { spawnSync } from 'node:child_process';
import { postDeploy as postDeployCodex } from '../../../tools/agents/providers/codex-post-deploy.mjs';
import { translateForCodex } from '../../../src/smiths/hook-bridge/codex-translator.js';
import { translateForHermes } from '../../../src/smiths/hook-bridge/hermes-translator.js';
import { translateForCopilot } from '../../../src/smiths/hook-bridge/copilot-translator.js';
import { translateForGrokBuild } from '../../../src/smiths/hook-bridge/grok-build-translator.js';
import { deployMuseHooks, pruneMuseHooks } from '../../../tools/agents/providers/muse-hooks.mjs';
import { parse as parseYaml } from 'yaml';
import { diagnoseWorkspaceContext } from '../../../src/smiths/context-pipeline/workspace-doctor.js';
import { withWindows, windowsPath, assertWindowsCommandSafe } from '../../helpers/windows-simulation.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let projectPath: string;
beforeEach(async () => {
  projectPath = await mkdtemp(path.join(tmpdir(), 'aiwg-prompt-providers-'));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(projectPath, { recursive: true, force: true }); });

describe('prompt discovery provider delivery', () => {
  it.each([['copilot', translateForCopilot], ['grok-build', translateForGrokBuild]] as const)(
    '%s reports its bootstrap fallback instead of emitting an ineffective prompt hook', async (provider, translate) => {
      const { sources } = await loadHookSources(root);
      const result = await translate(sources.find(source => source.id === 'aiwg-prompt-discovery')!, { projectPath });
      expect(result.skipped).toBe(true);
      expect(result.emittedPaths).toEqual([]);
      expect(result.skipReason).toContain('bootstrap rule');
      expect(await readFile(path.join(root, 'docs/hook-patterns.md'), 'utf8')).toContain(`| ${provider} | Bootstrap rule:`);
    });

  it.each(['dry-run', 'malformed config', 'malformed hooks', 'malformed entries', 'symlink'])(
    'Hermes %s leaves operator configuration untouched', async scenario => {
      const home = path.join(projectPath, 'profile');
      vi.stubEnv('HERMES_HOME', home);
      await mkdir(home);
      const config = path.join(home, 'config.yaml');
      const text = scenario === 'malformed config' ? 'hooks: [' : scenario === 'malformed hooks' ? 'hooks: false\n'
        : scenario === 'malformed entries' ? 'hooks:\n  pre_llm_call: false\n' : '# Operator\nmodel: keep\n';
      await writeFile(config, text);
      const { sources } = await loadHookSources(root);
      const source = sources.find(source => source.id === 'aiwg-prompt-discovery')!;
      if (scenario === 'symlink') {
        const { symlink } = await import('node:fs/promises');
        await symlink(path.join(projectPath, 'elsewhere'), path.join(home, 'agent-hooks'));
      }
      if (scenario === 'dry-run') await translateForHermes(source, { projectPath, dryRun: true });
      else await expect(translateForHermes(source, { projectPath })).rejects.toThrow(/Invalid Hermes|symlinked Hermes/);
      expect(await readFile(config, 'utf8')).toBe(text);
      await expect(access(path.join(home, 'agent-hooks/aiwg-prompt-discovery.cjs'))).rejects.toThrow();
    });

  it('registers the Codex prompt hook by default, preserving operator hooks and repairing the script', async () => {
    const settings = path.join(projectPath, '.codex/hooks.json');
    await mkdir(path.dirname(settings), { recursive: true });
    const operator = { hooks: [{ type: 'command', command: 'echo operator' }] };
    await writeFile(settings, JSON.stringify({ hooks: { UserPromptSubmit: [operator] } }));
    const opts = { srcRoot: root, mode: 'sdlc', quiet: true, contextFiles: false };
    await postDeployCodex(projectPath, opts);
    const once = await readFile(settings, 'utf8');
    const groups = JSON.parse(once).hooks.UserPromptSubmit;
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual(operator);
    const script = path.join(projectPath, '.codex/hooks/aiwg-prompt-discovery.cjs');
    expect(groups[1].hooks[0]).toEqual({ type: 'command', command: expect.stringMatching(/^node -e /), timeout: 2, statusMessage: 'AIWG prompt discovery',
      _aiwg_managed: true, _aiwg_id: 'aiwg-prompt-discovery' });
    expect(groups[1].hooks[0].command).not.toContain(projectPath);
    const shared = await readFile(path.join(root, 'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs'), 'utf8');
    expect(await readFile(script, 'utf8')).toBe(shared);
    await unlink(script);
    await postDeployCodex(projectPath, { ...opts, srcRoot: path.join(root, 'agentic/code/addons/aiwg-hooks') });
    expect(await readFile(script, 'utf8')).toBe(shared);
    expect(await readFile(settings, 'utf8')).toBe(once);
    const syntheticRoot = path.join(projectPath, 'synthetic-source');
    await mkdir(syntheticRoot);
    await unlink(script);
    await postDeployCodex(projectPath, { ...opts, srcRoot: syntheticRoot });
    expect(await readFile(script, 'utf8')).toBe(shared);
    expect(await readFile(settings, 'utf8')).toBe(once);
  });

  it.each([{ hooks: false }, { scope: 'user' }, { skillsOnly: true }, { commandsOnly: true }, { rulesOnly: true }, { dryRun: true }])
  ('skips Codex hooks for %j', async controls => {
    await postDeployCodex(projectPath, { srcRoot: root, mode: 'sdlc', quiet: true, contextFiles: false, ...controls });
    await expect(access(path.join(projectPath, '.codex/hooks.json'))).rejects.toThrow();
    await expect(access(path.join(projectPath, '.codex/hooks'))).rejects.toThrow();
  });

  it('includes Codex hooks in the kernel-only path used by aiwg use all', async () => {
    await postDeployCodex(projectPath, { srcRoot: root, mode: 'sdlc', quiet: true, contextFiles: false,
      skillsOnly: true, kernelOnly: true });
    await access(path.join(projectPath, '.codex/hooks.json'));
  });

  it.each(['.', 'nested'])('runs the registered Codex command from %s with the shared context, skip and opt-out contract', async subdirectory => {
    const loaded = await loadHookSources(root);
    expect(loaded.errors).toEqual([]);
    const source = loaded.sources.find(s => s.id === 'aiwg-prompt-discovery')!;
    expect(source.degradeOn).not.toContain('codex');
    const target = path.join(projectPath, 'project $AIWG_NOT_DEFINED with spaces');
    const cwd = path.join(target, subdirectory);
    await mkdir(cwd, { recursive: true });
    const result = await translateForCodex(source, { projectPath: target });
    expect(result.skipped).toBe(false);
    const groups = JSON.parse(await readFile(result.emittedPaths[0], 'utf8')).hooks.UserPromptSubmit;
    const runtime = path.join(projectPath, 'runtime/dist/src/artifacts');
    await mkdir(runtime, { recursive: true });
    await copyFile(path.join(root, 'test/fixtures/hooks-prompt-discovery.mjs'), path.join(runtime, 'query-engine-discover.js'));
    const invoke = (prompt: string, enabled = '1') => spawnSync(groups[0].hooks[0].command, {
      cwd, shell: true, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, AIWG_ROOT: path.join(projectPath, 'runtime'), AIWG_PROMPT_DISCOVERY: enabled },
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }),
    });
    const run = invoke('Review the authentication code for security issues');
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout).hookSpecificOutput).toMatchObject({
      hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('skill security-review'),
    });
    for (const run of [invoke('ok'), invoke('/help'), invoke('Review authentication', '0')]) {
      expect(run.status).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe('');
    }
  });

  it('deploys the same hook for Muse with an idempotent registration and repairs a missing script', async () => {
    deployMuseHooks(projectPath, { quiet: true });
    const settings = path.join(projectPath, '.muse/hooks.json');
    const once = await readFile(settings, 'utf8');
    const registration = JSON.parse(once).hooks.UserPromptSubmit;
    expect(registration).toEqual([{ matcher: '*', hooks: [{
      type: 'command', command: verifiedHookCommand(projectPath, '.muse/hooks/aiwg-prompt-discovery.cjs', await readFile(path.join(root, 'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs'))), timeout: 2,
    }] }]);
    const script = path.join(projectPath, '.muse/hooks/aiwg-prompt-discovery.cjs');
    expect(await readFile(script, 'utf8')).toBe(await readFile(path.join(root,
      'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs'), 'utf8'));
    await unlink(script);
    deployMuseHooks(projectPath, { quiet: true });
    await access(script);
    expect(await readFile(settings, 'utf8')).toBe(once);
    pruneMuseHooks(projectPath, { quiet: true });
    expect(JSON.parse(await readFile(settings, 'utf8')).hooks.UserPromptSubmit).toEqual([]);
  });

  it('keeps Muse dry-run free of script and settings writes', async () => {
    deployMuseHooks(projectPath, { dryRun: true, quiet: true });
    await expect(access(path.join(projectPath, '.muse'))).rejects.toThrow();
  });

  it('delivers Hermes pre_llm_call context through the documented shell-hook protocol (#3996)', async () => {
    const home = path.join(projectPath, 'profile');
    vi.stubEnv('HERMES_HOME', home);
    await mkdir(home);
    const config = path.join(home, 'config.yaml');
    await writeFile(config, '# Operator config\nmodel: operator-model\nhooks_auto_accept: false\nhooks:\n  pre_llm_call:\n    - command: operator-hook\n');
    const loaded = await loadHookSources(root);
    expect(loaded.errors).toEqual([]);
    const source = loaded.sources.find(s => s.id === 'aiwg-prompt-discovery')!;
    expect(source.degradeOn).not.toContain('hermes');
    const result = await translateForHermes(source, { projectPath });
    expect(result.skipped).toBe(false);
    const once = await readFile(config, 'utf8');
    expect(once).toContain('# Operator config');
    const doc = parseYaml(once);
    expect(doc.model).toBe('operator-model');
    expect(doc.hooks_auto_accept).toBe(false);
    expect(doc.hooks.pre_llm_call).toHaveLength(2);
    expect(doc.hooks.pre_llm_call[0].command).toBe('operator-hook');
    const entry = doc.hooks.pre_llm_call[1];
    const script = path.join(home, 'agent-hooks/aiwg-prompt-discovery.cjs');
    expect(entry.command).toBe(verifiedHookCommand(home, 'agent-hooks/aiwg-prompt-discovery.cjs', await readFile(script), [], 'user'));
    expect(result.warnings).toContain('Accept the Hermes hook (--accept-hooks); see aiwg doctor.');
    expect(result.warnings.every(line => `  hook-bridge hermes: ${line}`.length <= 80)).toBe(true);
    expect(entry.timeout).toBe(2);
    expect(result.emittedPaths).toEqual(expect.arrayContaining([script, config]));
    const runtime = path.join(projectPath, 'dist/src/artifacts');
    await mkdir(runtime, { recursive: true });
    await copyFile(path.join(root, 'test/fixtures/hooks-prompt-discovery.mjs'), path.join(runtime, 'query-engine-discover.js'));
    const invoke = (user_message: string, enabled = '1', hook_event_name = 'pre_llm_call') => spawnSync(entry.command, {
      shell: true, cwd: projectPath, encoding: 'utf8', timeout: 5000,
      input: JSON.stringify({ hook_event_name, cwd: projectPath, extra: { user_message } }),
      env: { ...process.env, AIWG_ROOT: projectPath, AIWG_PROMPT_DISCOVERY: enabled },
    });
    const run = invoke('Review the login code for authentication issues');
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout).context).toContain('skill security-review');
    expect(JSON.parse(run.stdout).context.length).toBeLessThan(600);
    for (const run of [invoke('ok'), invoke('Review authentication', '0'), invoke('Review authentication', '1', 'post_tool_call')]) {
      expect(run.status).toBe(0); expect(run.stdout).toBe(''); expect(run.stderr).toBe('');
    }
    await unlink(script);
    await translateForHermes(source, { projectPath });
    await access(script);
    expect(await readFile(config, 'utf8')).toBe(once);
    await writeFile(script, '// Operator edit\n');
    const changed = invoke('Review authentication');
    expect(changed.status).not.toBe(0);
    expect(changed.stderr).toContain('AIWG hook changed; redeploy and review');
    const edited = await translateForHermes(source, { projectPath });
    expect(edited.warnings.join(' ')).toContain('operator-edited');
    expect(await readFile(script, 'utf8')).toBe('// Operator edit\n');
  });
});

it('renders the Hermes command safely on emulated Windows (#4055)', async () => {
  const home = path.join(projectPath, 'Hermes $HOME %USERPROFILE% `tick`');
  vi.stubEnv('HERMES_HOME', home);
  const { sources } = await loadHookSources(root);
  await withWindows(async () => {
    await translateForHermes(sources.find(s => s.id === 'aiwg-prompt-discovery')!, { projectPath });
    const entry = parseYaml(await readFile(path.join(home, 'config.yaml'), 'utf8')).hooks.pre_llm_call[0];
    assertWindowsCommandSafe(entry.command);
    const data = /Buffer.from\('([^']+)','base64'\)/.exec(entry.command)![1];
    expect(JSON.parse(Buffer.from(data, 'base64').toString())).toEqual({
      anchor: path.win32.resolve(home), relative: 'agent-hooks/aiwg-prompt-discovery.cjs', args: [], projectEnv: '',
    });
  }, { profile: windowsPath('C', 'Users', 'Test User') });
});

it('changes the Hermes acceptance command only when reviewed source bytes change', async () => {
  const home = path.join(projectPath, 'hermes');
  vi.stubEnv('HERMES_HOME', home);
  const source = path.join(projectPath, 'fixture.cjs');
  const hook = { id: 'aiwg-prompt-discovery', description: 'fixture', events: ['UserPromptSubmit' as const], command: 'node', args: [source] };
  const install = async (bytes: string) => {
    await writeFile(source, bytes);
    await translateForHermes(hook, { projectPath });
    return parseYaml(await readFile(path.join(home, 'config.yaml'), 'utf8')).hooks.pre_llm_call[0].command;
  };
  const first = await install('process.stdout.write("first");');
  expect(await install('process.stdout.write("first");')).toBe(first);
  const second = await install('process.stdout.write("second");');
  expect(second).not.toBe(first);
  const run = (command: string) => spawnSync(command, { shell: true, cwd: projectPath, encoding: 'utf8', timeout: 5000 });
  expect(run(first).status).not.toBe(0);
  expect(run(second).stdout).toBe('second');
});

it.each(['missing', 'accepted', 'wrong-command', 'wrong-event', 'empty-allowlist', 'malformed', 'unreadable', 'auto-accept', 'missing-script', 'unmanaged'])
('doctor reads Hermes hook acceptance without writing (%s)', async state => {
  const home = path.join(projectPath, 'hermes-home');
  vi.stubEnv('HERMES_HOME', home);
  await mkdir(path.join(home, 'agent-hooks'), { recursive: true });
  const script = path.join(home, 'agent-hooks/aiwg-prompt-discovery.cjs');
  const bytes = Buffer.from('// fixture\n');
  await writeFile(script, bytes);
  const command = verifiedHookCommand(home, 'agent-hooks/aiwg-prompt-discovery.cjs', bytes, [], 'user');
  const config = path.join(home, 'config.yaml');
  const text = `# Operator\nhooks_auto_accept: ${state === 'auto-accept'}\nhooks:\n  pre_llm_call:\n    - command: ${JSON.stringify(command)}\n      _aiwg_managed: ${state !== 'unmanaged'}\n      _aiwg_id: aiwg-prompt-discovery\n`;
  await writeFile(config, text);
  const allowlist = path.join(home, 'shell-hooks-allowlist.json');
  const approvals = state === 'malformed' ? 'invalid' : JSON.stringify({ approvals: state === 'empty-allowlist' ? [] : [null, {
    event: state === 'wrong-event' ? 'post_tool_call' : 'pre_llm_call',
    command: state === 'wrong-command' ? command + ' ' : command,
  }] });
  if (state === 'unreadable') await mkdir(allowlist);
  else if (!['missing', 'auto-accept'].includes(state)) await writeFile(allowlist, approvals);
  if (state === 'missing-script') await unlink(script);
  const diagnostics = await diagnoseWorkspaceContext(projectPath);
  const diagnostic = diagnostics.find(item => item.code === 'hermes-prompt-discovery-acceptance');
  const silent = ['accepted', 'auto-accept', 'missing-script', 'unmanaged'].includes(state);
  expect(Boolean(diagnostic)).toBe(!silent);
  if (diagnostic) {
    expect(diagnostic.path).toBe(config);
    for (const option of ['TTY prompt', '--accept-hooks', 'HERMES_ACCEPT_HOOKS=1', 'hooks_auto_accept: true']) {
      expect(diagnostic.message).toContain(option);
    }
    expect(diagnostic.message).toContain(['malformed', 'unreadable'].includes(state) ? 'unverified' : 'not accepted');
  }
  expect(await readFile(config, 'utf8')).toBe(text);
  if (['missing', 'auto-accept'].includes(state)) await expect(access(allowlist)).rejects.toThrow();
  else if (state === 'unreadable') await expect(readFile(allowlist)).rejects.toMatchObject({ code: 'EISDIR' });
  else expect(await readFile(allowlist, 'utf8')).toBe(approvals);
});

it('shows all acceptance options through doctor --scope user without granting consent', async () => {
  const home = path.join(projectPath, 'doctor-hermes-home');
  vi.stubEnv('HERMES_HOME', home);
  vi.stubEnv('AIWG_USER_REGISTRY_PATH', path.join(projectPath, 'registry.json'));
  const { sources } = await loadHookSources(root);
  await translateForHermes(sources.find(s => s.id === 'aiwg-prompt-discovery')!, { projectPath });
  const config = path.join(home, 'config.yaml');
  const original = await readFile(config, 'utf8');
  const { doctorHandler } = await import('../../../src/cli/handlers/utility-doctor.js');
  const result = await doctorHandler.execute({ args: ['--scope', 'user'], rawArgs: ['doctor', '--scope', 'user'], cwd: projectPath, frameworkRoot: root });
  expect(result.message).toContain('Hermes prompt-discovery hook deployed but not accepted');
  for (const option of ['TTY prompt', '--accept-hooks', 'HERMES_ACCEPT_HOOKS=1', 'hooks_auto_accept: true']) {
    expect(result.message).toContain(option);
  }
  expect(await readFile(config, 'utf8')).toBe(original);
  await expect(access(path.join(home, 'shell-hooks-allowlist.json'))).rejects.toThrow();
});
