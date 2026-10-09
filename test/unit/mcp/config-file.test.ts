import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const failure = vi.hoisted(() => ({ close: false, write: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (failure.close) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          throw new Error('synthetic close failure');
        };
      }
      if (failure.write) handle.writeFile = async () => { throw new Error('synthetic write failure'); };
      return handle;
    },
  };
});
import { assertConfigDestination, writeConfigAtomic } from '../../../src/mcp/config-file.mjs';
import { manageOmpMcp } from '../../../src/mcp/omp-config.mjs';
import { manageGrokBuildMcp } from '../../../src/mcp/grok-build-config.mjs';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aiwg-config-file-')); });
afterEach(async () => {
  failure.close = false;
  failure.write = false;
  await rm(root, { recursive: true, force: true });
});

describe('atomic MCP config writes', () => {
  it.each([false, true])('removes the temp file even when cleanup close fails (write fails=%s)', async writeFails => {
    const file = join(root, 'mcp.json');
    await writeFile(file, 'original');
    failure.close = true;
    failure.write = writeFails;
    await expect(writeConfigAtomic(file, 'replacement')).rejects.toThrow('synthetic close failure');
    expect(await readFile(file, 'utf8')).toBe('original');
    expect(await readdir(root)).toEqual(['mcp.json']);
  });

  it.each(['shared', 'omp', 'grok'] as const)('makes an existing 0644 user config private via %s', async writer => {
    const file = join(root, 'mcp.json');
    await writeFile(file, writer === 'grok' ? 'preference = "keep"\n' : '{ "preference": "keep" }');
    await chmod(file, 0o644);
    if (writer === 'shared') await writeConfigAtomic(file, 'replacement', { userScope: true });
    else if (writer === 'omp') await manageOmpMcp(file, [{ name: 'aiwg', command: 'aiwg' }], { userScope: true });
    else await manageGrokBuildMcp(file, [{ name: 'aiwg', type: 'stdio', command: 'aiwg' }], { root, userScope: true });
    expect((await stat(file)).mode & 0o7777).toBe(0o600);
  });

  it('creates new project files with the process umask applied', async () => {
    const file = join(root, 'mcp.json');
    const helper = pathToFileURL(resolve(__dirname, '../../../src/mcp/config-file.mjs')).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { writeConfigAtomic } from ${JSON.stringify(helper)};
      process.umask(0o027);
      await writeConfigAtomic(process.argv[1], '{}');
    `, file], { timeout: 60_000 });
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });

  it('checks every project path component and excludes the project root', async () => {
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    await mkdir(project);
    await mkdir(outside);
    await mkdir(join(project, '.nested'));
    await symlink(outside, join(project, '.nested', 'parent'));
    const file = join(project, '.nested', 'parent', 'new', 'mcp.json');
    await expect(writeConfigAtomic(file, '{}', { projectRoot: project })).rejects.toThrow('parent directory is a symlink');
    expect(await readdir(outside)).toEqual([]);
    const alias = join(root, 'project-alias');
    await symlink(project, alias);
    await writeConfigAtomic(join(alias, 'mcp.json'), '{}', { projectRoot: alias });
    expect(await readFile(join(project, 'mcp.json'), 'utf8')).toBe('{}');
  });

  it('bounds registry parent checks below the config root and refuses symlinks below it', async () => {
    const config = join(root, 'config');
    const outside = join(root, 'outside');
    await mkdir(config);
    await mkdir(outside);
    const alias = join(root, 'config-alias');
    await symlink(config, alias);
    await writeConfigAtomic(join(alias, 'mcp.json'), '{}', {
      userScope: true, rejectSymlinkParents: true, symlinkRoot: alias,
    });
    expect(await readFile(join(config, 'mcp.json'), 'utf8')).toBe('{}');
    await symlink(outside, join(config, 'nested'));
    await expect(writeConfigAtomic(join(alias, 'nested/new/mcp.json'), '{}', {
      userScope: true, rejectSymlinkParents: true, symlinkRoot: alias,
    })).rejects.toThrow('parent directory is a symlink');
    expect(await readdir(outside)).toEqual([]);
  });

  it('allows user parent symlinks and still refuses a symlinked file', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    const parent = join(root, 'user-config');
    await symlink(outside, parent);
    const file = join(parent, 'mcp.json');
    await writeConfigAtomic(file, '{}', { userScope: true });
    expect((await stat(join(outside, 'mcp.json'))).mode & 0o777).toBe(0o600);
    await symlink(join(outside, 'mcp.json'), join(parent, 'link.json'));
    await expect(assertConfigDestination(join(parent, 'link.json'))).rejects.toThrow('destination is a symlink');
  });
});
