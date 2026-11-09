// Hook commands must bind deployed bytes and resolve independently of the session cwd.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { installAiwgHooks } from '../../../src/extensions/claude-hooks-installer.js';
import { translateForCodex } from '../../../src/smiths/hook-bridge/codex-translator.js';
import { deployMuseHooks } from '../../../tools/agents/providers/muse-hooks.mjs';

let root: string;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const frameworkRoot = path.resolve(import.meta.dirname, '../../..');
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-hook-command-')); });
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function install(provider: string, target: string) {
  if (provider === 'claude') await installAiwgHooks({ projectPath: target, frameworkRoot });
  if (provider === 'muse') deployMuseHooks(target, { quiet: true });
  if (provider === 'codex') await translateForCodex({
    id: 'aiwg-prompt-discovery', description: 'AIWG prompt discovery', events: ['UserPromptSubmit'],
    command: 'node', args: [path.join(frameworkRoot, 'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs')],
  }, { projectPath: target });
  const file = path.join(target, `.${provider}`, provider === 'claude' ? 'settings.json' : 'hooks.json');
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  return doc.hooks.UserPromptSubmit[0].hooks[0].command as string;
}

it.each(['claude', 'codex', 'muse'].flatMap(provider => ['project', 'user'].map(scope => ({ provider, scope }))))
('anchors and binds $provider $scope hooks, repairs legacy commands, and refuses changed bytes', async ({ provider, scope }) => {
  const target = path.join(root, scope === 'user' ? 'User Profile' : 'project with spaces');
  const other = path.join(root, 'unrelated');
  await fs.mkdir(other);
  vi.stubEnv('HOME', scope === 'user' ? target : path.join(root, 'home'));
  vi.stubEnv('USERPROFILE', scope === 'user' ? target : path.join(root, 'home'));
  const command = await install(provider, target);
  const script = path.join(target, `.${provider}/hooks/aiwg-prompt-discovery.cjs`);
  const hash = createHash('sha256').update(await fs.readFile(script)).digest('hex');
  expect(command).toContain(hash);
  const run = () => spawnSync(command, { shell: true, timeout: 30_000, cwd: other, input: '{}', encoding: 'utf8',
    env: { ...process.env, AIWG_PROMPT_DISCOVERY: '0', CLAUDE_PROJECT_DIR: target } });
  expect(run().status).toBe(0);
  await fs.appendFile(script, '\nprocess.stdout.write("UNREVIEWED");\n');
  const changed = run();
  expect(changed.status).not.toBe(0);
  expect(changed.stdout).not.toContain('UNREVIEWED');
  await fs.rm(script);
  const ancestor = path.join(root, `.${provider}/hooks`);
  await fs.mkdir(ancestor, { recursive: true });
  await fs.writeFile(path.join(ancestor, 'aiwg-prompt-discovery.cjs'), 'process.stdout.write("ANCESTOR");');
  const missing = run();
  expect(missing.status).not.toBe(0);
  expect(missing.stdout).not.toContain('ANCESTOR');
});

it.each(['claude', 'codex', 'muse'].flatMap(provider => ['project', 'user'].map(scope => ({ provider, scope }))))
('generates shell-safe $provider $scope commands on emulated win32', async ({ provider, scope }) => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const target = path.join(root, 'User Profile $dollar `tick` %percent%');
  vi.stubEnv('USERPROFILE', scope === 'user' ? target : path.join(root, 'other-home'));
  const command = await install(provider, target);
  const encoded = /Buffer.from\('([A-Za-z0-9+/=]+)','base64'\)/.exec(command)![1];
  const config = JSON.parse(Buffer.from(encoded, 'base64').toString());
  expect(config.anchor).toBe(path.win32.resolve(target));
  expect(config.relative).toBe(`.${provider}/hooks/aiwg-prompt-discovery.cjs`);
  expect(config.projectEnv).toBe(provider === 'claude' && scope === 'project' ? 'CLAUDE_PROJECT_DIR' : '');
  expect(command).not.toMatch(/[$`%\\]/);
});

it('preserves drive letters, backslashes and shell metacharacters without expansion', async () => {
  const { verifiedHookCommand } = await import('../../../src/extensions/verified-hook-command.js');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const home = 'C:\\Users\\A Space $HOME %USERPROFILE% `tick`';
  vi.stubEnv('USERPROFILE', home);
  const command = verifiedHookCommand(home, '.claude/hooks/aiwg-trace.cjs', Buffer.from('fixture'), ['start']);
  const config = JSON.parse(Buffer.from(/Buffer.from\('([^']+)'/.exec(command)![1], 'base64').toString());
  expect(config).toEqual({ anchor: home, relative: '.claude/hooks/aiwg-trace.cjs', args: ['start'], projectEnv: '' });
  expect(command).not.toMatch(/[$`%\\]/);
});

it.each(['claude', 'muse'])('doctor flags relative %s user hooks and clears the warning after redeployment', async provider => {
  const { diagnoseUserHookCommands } = await import('../../../src/extensions/user-hook-diagnostics.js');
  vi.stubEnv('HOME', root);
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  const file = path.join(root, `.${provider}`, provider === 'claude' ? 'settings.json' : 'hooks.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: '*', hooks: [{
    type: 'command', command: `node .${provider}/hooks/aiwg-prompt-discovery.cjs`,
    _aiwg_managed: true, _aiwg_id: 'aiwg-prompt-discovery',
  }] }] } }));
  expect(await diagnoseUserHookCommands()).toContainEqual(expect.objectContaining({ code: 'relative-user-hook-command', path: file }));
  const { doctorHandler } = await import('../../../src/cli/handlers/utility-doctor.js');
  const result = await doctorHandler.execute({ args: ['--scope', 'user'], rawArgs: ['doctor', '--scope', 'user'], cwd: root, frameworkRoot });
  expect(result.message).toContain('hook depends on the session cwd');
  await install(provider, root);
  expect(await diagnoseUserHookCommands()).toEqual([]);
});

it.each(['claude', 'codex', 'muse'])('finalizes %s user hooks at the provider home and respects opt-out', async provider => {
  const { installUserHooks } = await import('../../../tools/agents/providers/user-hooks.mjs');
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('CODEX_HOME', path.join(root, 'custom codex home'));
  const dir = provider === 'codex' ? process.env.CODEX_HOME! : path.join(root, `.${provider}`);
  const config = path.join(dir, provider === 'claude' ? 'settings.json' : 'hooks.json');
  await installUserHooks(provider, { hooks: false, attribution: false, quiet: true });
  await expect(fs.access(config)).rejects.toThrow();
  await installUserHooks(provider, { quiet: true });
  const doc = JSON.parse(await fs.readFile(config, 'utf8'));
  const command = doc.hooks.UserPromptSubmit[0].hooks[0].command;
  const run = spawnSync(command, { shell: true, timeout: 30_000, cwd: os.tmpdir(), input: '{}', encoding: 'utf8',
    env: { ...process.env, AIWG_PROMPT_DISCOVERY: '0', CLAUDE_PROJECT_DIR: '/unrelated/project' } });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
});

it('executes verified bytes with trace arguments and rejects redirected scripts', async () => {
  const { verifiedHookCommand } = await import('../../../src/extensions/verified-hook-command.js');
  const bytes = Buffer.from('process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));');
  const script = path.join(root, 'trace.cjs');
  await fs.writeFile(script, bytes);
  const command = verifiedHookCommand(root, 'trace.cjs', bytes, ['start'], 'user');
  const run = () => spawnSync(command, { shell: true, timeout: 30_000, cwd: os.tmpdir(), encoding: 'utf8' });
  expect(JSON.parse(run().stdout)).toEqual({ args: ['start'], cwd: os.tmpdir() });
  await fs.rename(script, path.join(root, 'outside.cjs'));
  await fs.symlink(path.join(root, 'outside.cjs'), script);
  expect(run().status).not.toBe(0);
});


it('changes the reviewed command when source bytes change on redeploy', async () => {
  const source = path.join(root, 'source.cjs');
  const target = path.join(root, 'project');
  const hook = { id: 'aiwg-prompt-discovery', description: 'AIWG prompt discovery',
    events: ['UserPromptSubmit' as const], command: 'node', args: [source] };
  const installSource = async (text: string) => {
    await fs.writeFile(source, text);
    await translateForCodex(hook, { projectPath: target });
    return JSON.parse(await fs.readFile(path.join(target, '.codex/hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0];
  };
  const first = await installSource('process.stdout.write("first");');
  const second = await installSource('process.stdout.write("second");');
  expect(first.command).not.toBe(second.command);
  const run = (command: string) => spawnSync(command, { shell: true, timeout: 30_000, cwd: root, encoding: 'utf8' });
  expect(run(first.command).status).not.toBe(0);
  expect(run(second.command).stdout).toBe('second');
  expect(second.statusMessage).toBe('AIWG prompt discovery');
});

it.each(['claude', 'codex', 'muse'])('anchors staged %s deployment commands to the promoted project', async provider => {
  const stage = path.join(root, 'temporary stage');
  const target = path.join(root, 'final project');
  const opts = { srcRoot: frameworkRoot, mode: 'sdlc', quiet: true, contextFiles: false,
    hooks: true, attribution: false, logicalOutputPath: () => target };
  if (provider === 'claude') {
    const { postDeploy } = await import('../../../tools/agents/providers/claude-post-deploy.mjs');
    await postDeploy(stage, opts);
  } else if (provider === 'codex') {
    const { postDeploy } = await import('../../../tools/agents/providers/codex-post-deploy.mjs');
    await postDeploy(stage, opts);
  } else deployMuseHooks(stage, opts);
  const doc = JSON.parse(await fs.readFile(path.join(stage, `.${provider}`, provider === 'claude' ? 'settings.json' : 'hooks.json'), 'utf8'));
  const command = doc.hooks.UserPromptSubmit[0].hooks[0].command;
  await fs.rename(stage, target);
  const result = spawnSync(command, { shell: true, timeout: 30_000, cwd: root, input: '{}', encoding: 'utf8',
    env: { ...process.env, AIWG_PROMPT_DISCOVERY: '0', CLAUDE_PROJECT_DIR: '' } });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
