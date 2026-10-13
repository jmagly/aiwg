import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../../src/mcp/server.mjs';

const hostPlatform = process.platform;
const posix = hostPlatform !== 'win32';
const linuxDescriptors = hostPlatform === 'linux';

let root: string;
let project: string;
let artifacts: string;
let outside: string;
let server: Awaited<ReturnType<typeof createServer>>;
let client: Client;

// The portable lane exercises its algorithm on the host filesystem, not OS emulation.
describe.each(['native', 'portable'])('%s artifact access', access => {
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'aiwg-artifact-containment-'));
    project = join(root, 'project');
    artifacts = join(project, '.aiwg');
    // A similarly prefixed sibling also catches naive startsWith containment.
    outside = join(project, '.aiwg-outside');
    await fs.mkdir(artifacts, { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, 'secret'), 'outside content');
    for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR', 'AIWG_MCP_TOOLSETS']) {
      vi.stubEnv(key, '');
    }
    if (access === 'portable' && linuxDescriptors) {
      vi.stubGlobal('process', new Proxy(process, {
        get: (target, key) => key === 'platform' ? 'darwin' : Reflect.get(target, key),
      }));
    }
    server = await createServer();
    client = new Client({ name: 'artifact-regression', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await client?.close();
    await server?.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  function call(tool: string, path: string) {
    return client.callTool({ name: tool, arguments: { path, project_dir: project, content: 'replacement' } });
  }

  describe.each(['artifact-read', 'artifact-write'])('%s containment', tool => {
    it.each(['../.aiwg-outside/secret', 'nested/../../.aiwg-outside/secret', '..\\.aiwg-outside\\secret', 'nested/../file'])('rejects traversal: %s', async path => {
      expect((await call(tool, path)).isError).toBe(true);
      expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
    });

    it('rejects absolute paths on POSIX and Windows', async () => {
      for (const path of [join(outside, 'secret'), 'C:\\outside\\secret', 'C:secret', '\\outside\\secret', '\\\\host\\share\\secret']) {
        expect((await call(tool, path)).isError).toBe(true);
      }
      expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
    });

    it.skipIf(!posix)('rejects an escaping file symlink', async () => {
      await fs.symlink(join(outside, 'secret'), join(artifacts, 'link'));
      expect((await call(tool, 'link')).isError).toBe(true);
      expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
    });

    it('rejects an escaping directory symlink, including missing descendants', async () => {
      await fs.symlink(outside, join(artifacts, 'link'), hostPlatform === 'win32' ? 'junction' : 'dir');
      for (const path of ['link/secret', 'link/new/deep/file']) {
        expect((await call(tool, path)).isError).toBe(true);
      }
      expect(await fs.readdir(outside)).toEqual(['secret']);
      expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
    });

    it.skipIf(!posix)('rejects dangling file and ancestor symlinks without creating their targets', async () => {
      await fs.symlink(join(outside, 'missing'), join(artifacts, 'dangling'));
      for (const path of ['dangling', 'dangling/nested/file']) {
        expect((await call(tool, path)).isError).toBe(true);
      }
      expect(await fs.readdir(outside)).toEqual(['secret']);
    });
  });

  it('writes new nested artifacts and reads them back', async () => {
    expect((await call('artifact-write', 'new/deep/file')).isError).toBeUndefined();
    await fs.writeFile(join(artifacts, 'new/deep/file'), 'longer existing content that must be truncated');
    expect((await call('artifact-write', 'new/deep/file')).isError).toBeUndefined();
    const result = await call('artifact-read', 'new/deep/file');
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: 'replacement' }]);
  });

  it('creates the default artifact root on the first fresh-project write', async () => {
    await fs.rm(artifacts, { recursive: true });
    expect((await call('artifact-write', 'new/deep/file')).isError).toBeUndefined();
    expect(await fs.readFile(join(artifacts, 'new/deep/file'), 'utf8')).toBe('replacement');
  });

  it('does not create an unavailable configured external root', async () => {
    const missing = join(root, 'missing-store');
    await fs.writeFile(join(project, '.aiwg-location'), missing);
    expect((await call('artifact-write', 'file')).isError).toBe(true);
    await expect(fs.lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(artifacts)).toEqual([]);
  });

  it.skipIf(hostPlatform !== 'win32')('rejects native Windows normalized names and alternate data streams', async () => {
    for (const path of ['new./file', 'new /file', 'file:secret', 'C:file', '\\outside\\secret']) {
      expect((await call('artifact-write', path)).isError).toBe(true);
    }
    expect(await fs.readdir(artifacts)).toEqual([]);
  });

  it.skipIf(hostPlatform !== 'win32')('keeps native Windows case aliases contained', async () => {
    await fs.mkdir(join(artifacts, 'MixedCase'));
    await fs.writeFile(join(artifacts, 'MixedCase/file'), 'inside content');
    expect((await call('artifact-read', 'MIXEDCASE/FILE')).content).toEqual([{ type: 'text', text: 'inside content' }]);
    expect((await call('artifact-write', 'mixedcase/FILE')).isError).toBeUndefined();
    expect(await fs.readFile(join(artifacts, 'MixedCase/file'), 'utf8')).toBe('replacement');
  });

  it.skipIf(!posix)('does not create a dangling artifact-root alias target', async () => {
    await fs.rm(artifacts, { recursive: true });
    const missing = join(root, 'missing-store');
    await fs.symlink(missing, artifacts);
    expect((await call('artifact-write', 'new/file')).isError).toBe(true);
    await expect(fs.lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.lstat(artifacts)).isSymbolicLink()).toBe(true);
  });

  it.skipIf(!posix)('allows contained read symlinks but refuses final-component write symlinks', async () => {
    await fs.writeFile(join(artifacts, 'original'), 'original');
    await fs.symlink(join(artifacts, 'original'), join(artifacts, 'link'));
    expect((await call('artifact-read', 'link')).content).toEqual([{ type: 'text', text: 'original' }]);
    expect((await call('artifact-write', 'link')).isError).toBe(true);
    expect(await fs.readFile(join(artifacts, 'original'), 'utf8')).toBe('original');
  });

  it.skipIf(!posix || !constants.O_NOFOLLOW)('uses O_NOFOLLOW if the final write component becomes a symlink before open', async () => {
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      expect(Number(flags) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      if (String(file).endsWith('/raced')) await fs.symlink(join(outside, 'secret'), String(file));
      return open(file, flags, mode);
    });
    expect((await call('artifact-write', 'raced')).isError).toBe(true);
    expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
  });

  describe('parent swaps during descriptor-based artifact access', () => {
    it.skipIf(access === 'portable' || !linuxDescriptors).each(['verification', 'directory cleanup'])('closes every handle and preserves the %s error', async failure => {
      await fs.mkdir(join(artifacts, 'parent'));
      await fs.writeFile(join(artifacts, 'parent/file'), 'preserved');
      const open = fs.open.bind(fs);
      const closed: string[] = [];
      vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        const handle = await open(file, flags, mode);
        const name = String(file);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          closed.push(name);
          if (name === artifacts || (failure === 'verification' && name.endsWith('/file'))) {
            throw new Error('directory cleanup failed');
          }
        });
        if (failure === 'verification' && name.endsWith('/file')) {
          vi.spyOn(handle, 'stat').mockRejectedValue(new Error('verification failed'));
        }
        return handle;
      });
      const result = await call('artifact-write', 'parent/file');
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: `Error writing artifact: ${failure} failed` }]);
      expect(closed).toHaveLength(3);
      expect(await fs.readFile(join(artifacts, 'parent/file'), 'utf8')).toBe('preserved');
    });

    it.skipIf(access === 'portable' || !linuxDescriptors).each(['artifact-read', 'artifact-write'])('%s rejects a parent swapped before its directory open', async tool => {
      await fs.mkdir(join(artifacts, 'parent'));
      await fs.writeFile(join(artifacts, 'parent/secret'), 'inside content');
      const open = fs.open.bind(fs);
      let swapped = false;
      vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        if (!swapped && String(file).endsWith('/parent')) {
          swapped = true;
          await fs.rename(join(artifacts, 'parent'), join(artifacts, 'held'));
          await fs.symlink(outside, join(artifacts, 'parent'), hostPlatform === 'win32' ? 'junction' : 'dir');
        }
        return open(file, flags, mode);
      });
      expect((await call(tool, 'parent/secret')).isError).toBe(true);
      expect(swapped).toBe(true);
      expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
      expect(await fs.readFile(join(artifacts, 'held/secret'), 'utf8')).toBe('inside content');
    });

    it.skipIf(access === 'portable' || !linuxDescriptors).each(['artifact-read', 'artifact-write'])('%s remains anchored when its parent is swapped immediately before file open', async tool => {
      await fs.mkdir(join(artifacts, 'parent'));
      await fs.writeFile(join(artifacts, 'parent/secret'), 'inside content');
      const open = fs.open.bind(fs);
      let swapped = false;
      vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        if (!swapped && String(file).endsWith('/secret')) {
          swapped = true;
          if (tool === 'artifact-write') expect(Number(flags) & constants.O_TRUNC).toBe(0);
          await fs.rename(join(artifacts, 'parent'), join(artifacts, 'held'));
          await fs.symlink(outside, join(artifacts, 'parent'), hostPlatform === 'win32' ? 'junction' : 'dir');
        }
        return open(file, flags, mode);
      });
      const result = await call(tool, 'parent/secret');
      expect(swapped).toBe(true);
      expect(result.isError).toBeUndefined();
      if (tool === 'artifact-read') expect(result.content).toEqual([{ type: 'text', text: 'inside content' }]);
      expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
      expect(await fs.readFile(join(artifacts, 'held/secret'), 'utf8')).toBe(tool === 'artifact-read' ? 'inside content' : 'replacement');
    });

    it.skipIf(access === 'portable' || !linuxDescriptors)('anchors mkdir to the opened parent when its name is replaced with an outside symlink', async () => {
      await fs.mkdir(join(artifacts, 'parent'));
      const mkdir = fs.mkdir.bind(fs);
      let swapped = false;
      vi.spyOn(fs, 'mkdir').mockImplementation(async (dir, options) => {
        if (!swapped && String(dir).endsWith('/new')) {
          swapped = true;
          expect(options).toBeUndefined();
          await fs.rename(join(artifacts, 'parent'), join(artifacts, 'held'));
          await fs.symlink(outside, join(artifacts, 'parent'), hostPlatform === 'win32' ? 'junction' : 'dir');
        }
        return mkdir(dir, options as never);
      });
      expect((await call('artifact-write', 'parent/new/deep/file')).isError).toBeUndefined();
      expect(swapped).toBe(true);
      expect(await fs.readdir(outside)).toEqual(['secret']);
      expect(await fs.readFile(join(artifacts, 'held/new/deep/file'), 'utf8')).toBe('replacement');
    });

    it.skipIf(access === 'portable' || !linuxDescriptors)('rejects an outside symlink inserted for a missing component immediately before mkdir', async () => {
      await fs.mkdir(join(artifacts, 'parent'));
      const mkdir = fs.mkdir.bind(fs);
      let inserted = false;
      vi.spyOn(fs, 'mkdir').mockImplementation(async (dir, options) => {
        if (!inserted && String(dir).endsWith('/new')) {
          inserted = true;
          await fs.symlink(outside, join(artifacts, 'parent/new'));
        }
        return mkdir(dir, options as never);
      });
      expect((await call('artifact-write', 'parent/new/deep/file')).isError).toBe(true);
      expect(inserted).toBe(true);
      expect(await fs.readdir(outside)).toEqual(['secret']);
      expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
    });

    it.skipIf(access === 'portable' || !linuxDescriptors)('verifies an opened file before truncating or reading after a parent is moved outside', async () => {
      for (const tool of ['artifact-read', 'artifact-write']) {
        await fs.mkdir(join(artifacts, tool));
        await fs.writeFile(join(artifacts, tool, 'file'), 'preserved');
        const open = fs.open.bind(fs);
        const spy = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
          const handle = await open(file, flags, mode);
          if (String(file).endsWith('/file')) {
            await fs.rename(join(artifacts, tool), join(outside, tool));
            await fs.symlink(outside, join(artifacts, tool));
          }
          return handle;
        });
        expect((await call(tool, `${tool}/file`)).isError).toBe(true);
        expect(await fs.readFile(join(outside, tool, 'file'), 'utf8')).toBe('preserved');
        spy.mockRestore();
      }
    });

    it.skipIf(access === 'portable' || !linuxDescriptors)('fails closed before creating anything when descriptor paths are unavailable', async () => {
      const realpath = fs.realpath.bind(fs);
      vi.spyOn(fs, 'realpath').mockImplementation(async file => {
        if (String(file).startsWith('/proc/self/fd/')) throw Object.assign(new Error('procfs unavailable'), { code: 'ENOENT' });
        return realpath(file);
      });
      expect((await call('artifact-write', 'new/deep/file')).isError).toBe(true);
      expect(await fs.readdir(artifacts)).toEqual([]);
      expect(await fs.readdir(outside)).toEqual(['secret']);
    });
  });

  it('uses the real artifact root for a configured external store and root alias', async () => {
    const store = join(root, 'store');
    const alias = join(root, 'store-alias');
    await fs.mkdir(store);
    await fs.symlink(store, alias, hostPlatform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(join(project, '.aiwg-location'), alias);
    expect((await call('artifact-write', 'nested/file')).isError).toBeUndefined();
    expect(await fs.readFile(join(store, 'nested/file'), 'utf8')).toBe('replacement');
    expect((await call('artifact-read', 'nested/file')).isError).toBeUndefined();
    expect(await fs.readdir(artifacts)).toEqual([]);
  });

  describe.skipIf(access !== 'portable')('portable post-open verification', () => {
    it('rejects missing descendants after a mkdir parent swap, with an empty-directory residual', async () => {
      await fs.mkdir(join(artifacts, 'parent'));
      const mkdir = fs.mkdir.bind(fs);
      let swapped = false;
      vi.spyOn(fs, 'mkdir').mockImplementation(async (dir, options) => {
        if (!swapped && String(dir) === join(artifacts, 'parent/new')) {
          swapped = true;
          await fs.rename(join(artifacts, 'parent'), join(artifacts, 'held'));
          await fs.symlink(outside, join(artifacts, 'parent'), hostPlatform === 'win32' ? 'junction' : 'dir');
        }
        return mkdir(dir, options as never);
      });
      expect((await call('artifact-write', 'parent/new/deep/file')).isError).toBe(true);
      expect(swapped).toBe(true);
      // Portable mkdir cannot anchor its parent. Reject before descendants;
      // directory deletion would itself race and is deliberately not attempted.
      expect(await fs.readdir(join(outside, 'new'))).toEqual([]);
      expect(await fs.readdir(outside)).toEqual(['new', 'secret']);
    });

    it('rechecks a swapped parent before creating a missing file', async () => {
      await fs.mkdir(join(artifacts, 'parent'));
      const open = fs.open.bind(fs);
      let swapped = false;
      vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        if (!swapped && String(file) === join(artifacts, 'parent/new')) {
          swapped = true;
          expect(Number(flags) & constants.O_CREAT).toBe(0);
          await fs.rename(join(artifacts, 'parent'), join(artifacts, 'held'));
          await fs.symlink(outside, join(artifacts, 'parent'), hostPlatform === 'win32' ? 'junction' : 'dir');
        }
        return open(file, flags, mode);
      });
      expect((await call('artifact-write', 'parent/new')).isError).toBe(true);
      expect(swapped).toBe(true);
      expect(await fs.readdir(outside)).toEqual(['secret']);
    });

    it('removes its own empty file after a parent swap during exclusive creation', async () => {
      await fs.mkdir(join(artifacts, 'parent'));
      const open = fs.open.bind(fs);
      let created = false;
      vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        if (Number(flags) & constants.O_CREAT) {
          created = true;
          expect(Number(flags) & constants.O_EXCL).toBe(constants.O_EXCL);
          await fs.rename(join(artifacts, 'parent'), join(artifacts, 'held'));
          await fs.symlink(outside, join(artifacts, 'parent'), hostPlatform === 'win32' ? 'junction' : 'dir');
        }
        return open(file, flags, mode);
      });
      expect((await call('artifact-write', 'parent/new')).isError).toBe(true);
      expect(created).toBe(true);
      expect(await fs.readdir(outside)).toEqual(['secret']);
    });

    it('preserves a replacement when verification fails after creation', async () => {
      const open = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        const handle = await open(file, flags, mode);
        if (Number(flags) & constants.O_CREAT) {
          await fs.rename(String(file), join(artifacts, 'held'));
          await fs.writeFile(String(file), 'replacement inode');
        }
        return handle;
      });
      expect((await call('artifact-write', 'new')).isError).toBe(true);
      expect(await fs.readFile(join(artifacts, 'new'), 'utf8')).toBe('replacement inode');
      expect(await fs.readFile(join(artifacts, 'held'), 'utf8')).toBe('');
    });

    it.skipIf(!posix)('exclusive creation rejects a dangling symlink without O_NOFOLLOW', async () => {
      const open = fs.open.bind(fs);
      let inserted = false;
      vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        if (Number(flags) & constants.O_CREAT) {
          inserted = true;
          await fs.symlink(join(outside, 'missing'), String(file));
        }
        return open(file, Number(flags) & ~(constants.O_NOFOLLOW || 0), mode);
      });
      expect((await call('artifact-write', 'new')).isError).toBe(true);
      expect(inserted).toBe(true);
      expect(await fs.readdir(outside)).toEqual(['secret']);
    });

    it.each(['artifact-read', 'artifact-write'])('%s rejects a replaced file identity before accessing content', async tool => {
      await fs.writeFile(join(artifacts, 'file'), 'preserved content');
      const open = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        if (tool === 'artifact-write') expect(Number(flags) & constants.O_TRUNC).toBe(0);
        const handle = await open(file, flags, mode);
        await fs.rename(join(artifacts, 'file'), join(artifacts, 'held'));
        await fs.writeFile(join(artifacts, 'file'), 'different inode');
        return handle;
      });
      expect((await call(tool, 'file')).isError).toBe(true);
      expect(await fs.readFile(join(artifacts, 'held'), 'utf8')).toBe('preserved content');
      expect(await fs.readFile(join(artifacts, 'file'), 'utf8')).toBe('different inode');
    });

    it.each(['artifact-read', 'artifact-write'])('%s rejects an outside parent swap before file open', async tool => {
      await fs.mkdir(join(artifacts, 'parent'));
      await fs.writeFile(join(artifacts, 'parent/secret'), 'inside content');
      const open = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        if (tool === 'artifact-write') expect(Number(flags) & constants.O_TRUNC).toBe(0);
        await fs.rename(join(artifacts, 'parent'), join(artifacts, 'held'));
        await fs.symlink(outside, join(artifacts, 'parent'), hostPlatform === 'win32' ? 'junction' : 'dir');
        return open(file, flags, mode);
      });
      expect((await call(tool, 'parent/secret')).isError).toBe(true);
      expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
    });

    it('checks a newly created directory with lstat before creating descendants', async () => {
      const mkdir = fs.mkdir.bind(fs);
      vi.spyOn(fs, 'mkdir').mockImplementation(async (dir, options) => {
        expect(options).toBeUndefined();
        if (String(dir).endsWith(`${sep}new`)) await fs.symlink(outside, String(dir), hostPlatform === 'win32' ? 'junction' : 'dir');
        return mkdir(dir, options as never);
      });
      expect((await call('artifact-write', 'new/deep/file')).isError).toBe(true);
      expect(await fs.readdir(outside)).toEqual(['secret']);
    });
  });

});
