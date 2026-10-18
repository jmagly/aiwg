import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareWorkerInstallationStore } from '../../../src/models/worker-installation.mjs';

vi.mock('node:fs/promises', { spy: true });
// Node's native homedir ignores thread-local env changes in Vitest's pool.
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: () => process.env.HOME || os.homedir() };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('qualification store permission repair', () => {
  it.each([0o775, 0o777])('refuses repair beneath a writable ancestor (%s)', async mode => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-store-ancestor-'));
    roots.push(home);
    vi.stubEnv('HOME', home);
    const ancestor = path.join(home, 'config');
    const store = path.join(ancestor, 'aiwg');
    await fs.mkdir(store, { recursive: true });
    await fs.chmod(ancestor, mode);
    await fs.chmod(store, 0o775);
    vi.stubEnv('AIWG_CONFIG', store);
    const open = vi.spyOn(fs, 'open');
    for (const apply of [false, true]) {
      await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply }))
        .rejects.toThrow(`Untrusted installation store ancestor: ${ancestor}`);
    }
    expect(open).not.toHaveBeenCalled();
    expect((await fs.stat(store)).mode & 0o777).toBe(0o775);
  });

  it.each([0o755, 0o700])('repairs beneath trusted ancestors (%s)', async mode => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-store-trusted-'));
    roots.push(home);
    vi.stubEnv('HOME', home);
    const ancestor = path.join(home, 'config');
    const store = path.join(ancestor, 'aiwg');
    await fs.mkdir(store, { recursive: true });
    await fs.chmod(ancestor, mode);
    await fs.chmod(store, 0o775);
    vi.stubEnv('AIWG_CONFIG', store);
    const options = { workerWritableRoots: [] };
    await expect(prepareWorkerInstallationStore(options)).resolves.toEqual([{ path: store, action: 'chmod go-w' }]);
    expect((await fs.stat(store)).mode & 0o777).toBe(0o775);
    await prepareWorkerInstallationStore({ ...options, apply: true });
    expect((await fs.stat(store)).mode & 0o777).toBe(0o755);
  });

  it('refuses another owner with the path and never chmods it', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-store-owner-'));
    roots.push(root);
    vi.stubEnv('AIWG_CONFIG', root);
    const { lstat: original } = await vi.importActual<typeof fs>('node:fs/promises');
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await original(...args);
      return args[0] === root ? Object.assign(Object.create(stat), { uid: process.getuid!() + 1 }) : stat;
    });
    const open = vi.spyOn(fs, 'open');
    await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply: true }))
      .rejects.toThrow(`Installation store path is owned by another user: ${root}`);
    expect(open).not.toHaveBeenCalled();
  });

  it('never repairs a writable store file or a symlinked directory', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-store-path-'));
    roots.push(root);
    vi.stubEnv('AIWG_CONFIG', root);
    const filename = path.join(root, 'worker-installations.json');
    await fs.writeFile(filename, '{}');
    await fs.chmod(filename, 0o666);
    await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply: true }))
      .rejects.toThrow(`Untrusted installation store permissions: ${filename}`);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o666);
    const link = `${root}-link`;
    roots.push(link);
    await fs.symlink(root, link);
    vi.stubEnv('AIWG_CONFIG', link);
    await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply: true }))
      .rejects.toThrow('Symlinked installation store');
  });
});
