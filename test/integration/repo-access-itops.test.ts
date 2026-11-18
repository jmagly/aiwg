import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve('bin/aiwg.mjs');
let root: string;
let home: string;
const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'repo-access', ...args], {
  cwd: root, encoding: 'utf8', timeout: 30_000,
  env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
    AIWG_CONFIG: join(home, 'aiwg'), AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
});
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'repo-access-cli-'));
  root = join(home, 'workspace');
  await cp(resolve('test/fixtures/repo-access/itops'), root, { recursive: true });
  await mkdir(join(root, 'repos/aiwg.io/.git'), { recursive: true });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('built repo-access CLI with itops specs (#4282)', () => {
  it('lists and checks declared members without a canonical manifest', () => {
    const listed = run('list');
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('Source: workspace-spec');
    expect(listed.stdout).toContain('aiwg.io');
    const checked = run('check', '--path', 'repos/aiwg.io', '--action', 'write');
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout).toContain('ALLOW write');
    const pushed = run('check', '--path', 'repos/aiwg.io', '--action', 'push');
    expect(pushed.status).toBe(1);
    expect(pushed.stdout).toContain('DENY push');
  });

  it('prints registration edits and audits an unlisted worktree', async () => {
    const added = run('add', '--path', 'repos/marketing', '--name', 'marketing', '--allow', 'read,write');
    expect(added.status).toBe(2);
    expect(added.stderr).toContain(join(root, 'config/workspace.yaml'));
    expect(added.stderr).toContain(join(root, 'config/repository-routing.yaml'));
    expect(added.stderr).toContain('name: "marketing"');
    await mkdir(join(root, 'repos/marketing'), { recursive: true });
    await writeFile(join(root, 'repos/marketing/.git'), 'gitdir: /synthetic/worktree');
    const audited = run('audit');
    expect(audited.status).toBe(1);
    expect(audited.stdout).toContain('- repos/marketing');
    expect(audited.stdout).not.toMatch(/^\s+- repos\/aiwg.io$/m);
  });
});
