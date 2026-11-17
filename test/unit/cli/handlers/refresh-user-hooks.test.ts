// Refresh must migrate legacy user hooks without adding registrations or touching operator commands.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { diagnoseUserHookCommands } from '../../../../src/extensions/user-hook-diagnostics.js';

const frameworkRoot = path.resolve(import.meta.dirname, '../../../..');
vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: () => ({ run: vi.fn().mockResolvedValue({ exitCode: 0 }) }),
}));
vi.mock('../../../../src/cli/handlers/use.js', () => ({ createUseHandler: () => ({ execute: vi.fn() }) }));
vi.mock('../../../../src/artifacts/framework-capabilities.js', () => ({ refreshFrameworkCapabilities: vi.fn() }));
vi.mock('../../../../src/packages/registry.js', () => ({ refreshAllPackages: vi.fn().mockResolvedValue([]) }));
import { refreshHandler } from '../../../../src/cli/handlers/refresh.js';
import * as channel from '../../../../src/channel/manager.mjs';
import * as ui from '../../../../src/cli/ui.js';
import { refreshAllPackages } from '../../../../src/packages/registry.js';
import { refreshUserHooks } from '../../../../src/cli/handlers/refresh-user-hooks.js';
import { createHash } from 'node:crypto';

let root: string, home: string, project: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-refresh-user-'));
  home = path.join(root, 'home'); project = path.join(root, 'project');
  await fs.mkdir(project);
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(channel, 'getFrameworkRoot').mockResolvedValue(frameworkRoot);
  vi.mocked(refreshAllPackages).mockResolvedValue([]);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

async function fixture(provider: string) {
  const file = path.join(home, `.${provider}`, provider === 'claude' ? 'settings.json' : 'hooks.json');
  const registrations = provider === 'claude' ? [
    ['SessionStart', 'aiwg-session', ''], ['PermissionRequest', 'aiwg-permissions', ''],
    ['SubagentStart', 'aiwg-trace', ' start'], ['SubagentStop', 'aiwg-trace', ' stop'],
  ] : [['UserPromptSubmit', 'aiwg-prompt-discovery', '']];
  const operator = { type: 'command', command: 'node ./operator.cjs', timeout: 7 };
  const hooks = Object.fromEntries(registrations.map(([event, id, arg]) => [event, [{ matcher: '*', hooks: [
    { type: 'command', command: `node .${provider}/hooks/${id}.cjs${arg}`, _aiwg_managed: true, _aiwg_id: id }, operator,
  ] }]]));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const original = JSON.stringify({ operatorSetting: true, hooks }, null, 2);
  await fs.writeFile(file, original);
  return { file, original, registrations, operator };
}
const refresh = (provider: string, dryRun = false) => refreshHandler.execute({ cwd: project, frameworkRoot,
  args: ['--skip-update', '--provider', provider, ...(dryRun ? ['--dry-run'] : [])], rawArgs: ['refresh'] });

it.each(['claude', 'muse'])('refresh anchors existing %s user hooks and backs up the exact settings', async provider => {
  const { file, original, registrations, operator } = await fixture(provider);
  expect(await diagnoseUserHookCommands()).toHaveLength(registrations.length);
  expect((await refresh(provider)).exitCode).toBe(0);
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(doc.operatorSetting).toBe(true);
  expect(Object.keys(doc.hooks)).toEqual(registrations.map(([event]) => event));
  for (const [event] of registrations) {
    const group = doc.hooks[event][0];
    expect(group.matcher).toBe('*'); expect(group.hooks[1]).toEqual(operator);
    expect(group.hooks[0].command).toMatch(/^node -e /);
    expect(execSync(group.hooks[0].command, { cwd: project, input: '{}', encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, AIWG_PROMPT_DISCOVERY: '0' } })).not.toContain('Cannot find module');
  }
  expect(await diagnoseUserHookCommands()).toEqual([]);
  const backups = (await fs.readdir(path.dirname(file))).filter(name => name.startsWith(path.basename(file) + '.bak.'));
  expect(backups).toHaveLength(1);
  expect(await fs.readFile(path.join(path.dirname(file), backups[0]), 'utf8')).toBe(original);
  const once = await fs.readFile(file, 'utf8');
  await refresh(provider);
  expect(await fs.readFile(file, 'utf8')).toBe(once);
});

it('dry-run reports the repair without changing user settings or creating backups', async () => {
  const { file, original } = await fixture('claude');
  const info = vi.spyOn(ui, 'info');
  await refresh('claude', true);
  expect(await fs.readFile(file, 'utf8')).toBe(original);
  expect(await fs.readdir(path.dirname(file))).toEqual(['settings.json']);
  expect(info).toHaveBeenCalledWith(expect.stringContaining('Would anchor 4 claude user hook'));
});

it('preserves unrelated AIWG-named commands, quoted arguments, and malformed groups', async () => {
  const { file } = await fixture('claude');
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  doc.hooks.SessionStart[0].hooks[0].command = 'node ".claude/hooks/aiwg-session.js"';
  const untouched = [
    { type: 'command', command: 'node .claude/hooks/aiwg-custom.cjs' },
    { type: 'command', command: 'node .claude/hooks/aiwg-session.cjs --operator-flag' },
    { type: 'command', command: 'echo operator' },
    { type: 'prompt', command: 'node .claude/hooks/aiwg-session.cjs' },
    { type: 'command', command: null },
  ];
  doc.hooks.SessionStart[0].hooks.push(...untouched);
  doc.hooks.SessionStart.push({ matcher: 'empty' });
  doc.hooks.PermissionRequest = 'invalid';
  await fs.writeFile(file, JSON.stringify(doc));
  await refreshUserHooks({ frameworkRoot, provider: 'claude', dryRun: false, quiet: true });
  const result = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(result.hooks.SessionStart[0].hooks.slice(2)).toEqual(untouched);
  expect(result.hooks.SessionStart[0].hooks[0].command).toMatch(/^node -e /);
  expect(result.hooks.PermissionRequest).toBe('invalid');
});

it('leaves only noncanonical relative user hooks alone and respects provider scope', async () => {
  const { file } = await fixture('claude');
  const original = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command',
    command: 'node .claude/hooks/aiwg-custom.cjs' }] }] } });
  await fs.writeFile(file, original);
  for (const provider of ['claude', 'muse', 'codex']) {
    await refreshUserHooks({ frameworkRoot, provider, dryRun: false, quiet: true });
  }
  expect(await fs.readFile(file, 'utf8')).toBe(original);
  expect(await fs.readdir(path.dirname(file))).toEqual(['settings.json']);
});

it('refuses migration before writing when a deployed managed script has operator edits', async () => {
  const { file, original } = await fixture('claude');
  const directory = path.join(home, '.claude/hooks');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'aiwg-session.cjs'), 'operator edits');
  await fs.writeFile(path.join(directory, '.aiwg-manifest.json'), JSON.stringify({ managed: {
    'aiwg-session.cjs': { hash: 'sha256:' + createHash('sha256').update('original').digest('hex') },
  } }));
  await expect(refreshUserHooks({ frameworkRoot, provider: 'claude', dryRun: false, quiet: true }))
    .rejects.toThrow('kept (operator-edited)');
  expect(await fs.readFile(file, 'utf8')).toBe(original);
  expect(await fs.readdir(path.dirname(file))).toEqual(['hooks', 'settings.json']);
});

it('warns and continues when the user hook migration needs review', async () => {
  const { refreshUserHooksOrWarn } = await import('../../../../src/cli/handlers/refresh-user-hooks.js');
  const warn = vi.spyOn(ui, 'warn').mockImplementation(() => {});
  const message = await refreshUserHooksOrWarn({ frameworkRoot, provider: 'claude', dryRun: false, quiet: true },
    async () => { throw new Error('.claude/hooks/x.cjs: kept (operator-edited); user hook migration needs review'); });
  expect(message).toBe('User hook migration skipped: .claude/hooks/x.cjs: kept (operator-edited); user hook migration needs review');
  expect(warn).toHaveBeenCalledWith(message);
  expect(await refreshUserHooksOrWarn({ frameworkRoot, provider: 'claude', dryRun: false, quiet: true }, async () => {})).toBeUndefined();
  warn.mockRestore();
});
