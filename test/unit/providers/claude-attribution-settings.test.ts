// Exercise the provider settings owner with an isolated HOME, including opt-out parsing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { postDeploy } from '../../../tools/agents/providers/claude-post-deploy.mjs';
import { main as deployProvider, parseArgs } from '../../../tools/agents/deploy-agents.mjs';

let root: string;
let home: string;
let project: string;
const defaults = { commit: '', pr: '', sessionUrl: false };
async function deploy(extra: string[] = []) {
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'skills'), { recursive: true });
  expect(await deployProvider(['--source', source, '--target', project, '--provider', 'claude',
    '--scope', 'user', '--no-context-files', '--skip-commands-migration', ...extra])).toBe(0);
}
const settings = async (dir: string) => JSON.parse(await readFile(path.join(dir, '.claude/settings.json'), 'utf8'));
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-claude-settings-'));
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  await mkdir(project);
  await mkdir(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('AIWG_CONFIG', path.join(home, '.config/aiwg'));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('Claude provider attribution settings', () => {
  it('creates the minimal defaults and records ownership', async () => {
    await postDeploy(project, { contextFiles: false });
    expect((await settings(project)).attribution).toEqual(defaults);
    expect((await settings(project)).aiwg.attributionKeys).toEqual(['commit', 'pr', 'sessionUrl']);
  });
  it('merges project and existing user settings with a backup and warning', async () => {
    await mkdir(path.join(home, '.claude'));
    await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ attribution: { pr: 'Operator PR' }, other: true }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deploy();
    expect((await settings(project)).attribution).toEqual(defaults);
    // User scope also installs AIWG's anchored user hooks (#4037); everything else is preserved exactly.
    const { hooks, ...userSettings } = await settings(home);
    expect(userSettings).toEqual({ attribution: { ...defaults, pr: 'Operator PR' }, other: true,
      aiwg: { attributionKeys: ['commit', 'sessionUrl'] } });
    expect(Object.values(hooks).flat().flatMap((group: any) => group.hooks)
      .every((hook: any) => hook._aiwg_managed === true && hook.command.startsWith('node -e '))).toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Preserved operator attribution.pr'));
    expect((await readdir(path.join(home, '.claude'))).filter(name => name.includes('.bak.'))).toHaveLength(1);
  });
  it('honors the parsed opt-out for project and user scopes', async () => {
    const opts = parseArgs(['--no-hooks', '--no-attribution', '--scope', 'user']);
    expect(opts.attribution).toBe(false);
    await deploy(['--no-attribution', '--no-hooks']);
    expect((await settings(project)).attribution).toBeUndefined();
    await expect(readFile(path.join(home, '.claude/settings.json'))).rejects.toThrow();
  });
  it('dry-run writes neither project nor user settings', async () => {
    await deploy(['--dry-run']);
    await expect(readFile(path.join(project, '.claude/settings.json'))).rejects.toThrow();
    await expect(readFile(path.join(home, '.claude/settings.json'))).rejects.toThrow();
  });
});
