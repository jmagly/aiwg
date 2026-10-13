import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe.skipIf(!linuxDescriptors)('descriptor artifact access', () => {
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
    vi.spyOn(process, 'cwd').mockReturnValue(project);
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

  async function restart() {
    await client.close();
    await server.close();
    server = await createServer();
    client = new Client({ name: 'artifact-regression', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }

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
    await restart();
    expect((await call('artifact-write', 'new/deep/file')).isError).toBeUndefined();
    expect(await fs.readFile(join(artifacts, 'new/deep/file'), 'utf8')).toBe('replacement');
  });

  it.each(['local', 'external'])('rejects a %s root alias retargeted between requests', async location => {
    const store = join(root, 'store');
    await fs.mkdir(store);
    const alias = location === 'local' ? artifacts : join(root, 'store-alias');
    if (location === 'local') await fs.rm(artifacts, { recursive: true });
    else vi.stubEnv('AIWG_ARTIFACTS_PATH', alias);
    await fs.symlink(store, alias, 'dir');
    await restart();
    expect((await call('artifact-write', 'secret')).isError).toBeUndefined();
    expect((await call('artifact-read', 'secret')).content).toEqual([{ type: 'text', text: 'replacement' }]);
    await fs.unlink(alias);
    await fs.symlink(outside, alias, 'dir');
    const open = vi.spyOn(fs, 'open');
    const mkdir = vi.spyOn(fs, 'mkdir');
    for (const tool of ['artifact-read', 'artifact-write']) {
      const result = await call(tool, 'secret');
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('root changed since it was pinned') }]);
      expect((await call(tool, 'new/deep/file')).isError).toBe(true);
    }
    expect(open).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(await fs.readFile(join(store, 'secret'), 'utf8')).toBe('replacement');
    expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
    expect(await fs.readdir(outside)).toEqual(['secret']);
  });

  it('pins root identity at startup before the first request, even at the same canonical path', async () => {
    await fs.rename(artifacts, join(root, 'original-store'));
    await fs.mkdir(artifacts);
    await fs.writeFile(join(artifacts, 'secret'), 'replacement store');
    for (const tool of ['artifact-read', 'artifact-write']) {
      expect((await call(tool, 'secret')).isError).toBe(true);
    }
    expect(await fs.readFile(join(artifacts, 'secret'), 'utf8')).toBe('replacement store');
    expect(await fs.readdir(join(root, 'original-store'))).toEqual([]);
  });

  it('does not recreate an existing root removed after startup', async () => {
    await fs.rm(artifacts, { recursive: true });
    expect((await call('artifact-write', 'new/deep/file')).isError).toBe(true);
    await expect(fs.lstat(artifacts)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlink substituted for a missing default before its first write', async () => {
    await fs.rm(artifacts, { recursive: true });
    await restart();
    await fs.symlink(outside, artifacts, 'dir');
    expect((await call('artifact-write', 'secret')).isError).toBe(true);
    expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
  });

  it('does not create an unavailable configured external root', async () => {
    const missing = join(root, 'missing-store');
    vi.stubEnv('AIWG_ARTIFACTS_PATH', missing);
    await restart();
    expect((await call('artifact-write', 'file')).isError).toBe(true);
    await expect(fs.lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(artifacts)).toEqual([]);
  });

  it('rejects normalized aliases and alternate data streams', async () => {
    for (const path of ['new./file', 'new /file', 'file:secret', 'C:file', '\\outside\\secret']) {
      expect((await call('artifact-write', path)).isError).toBe(true);
    }
    expect(await fs.readdir(artifacts)).toEqual([]);
  });

  it.skipIf(!posix)('does not create a dangling artifact-root alias target', async () => {
    await fs.rm(artifacts, { recursive: true });
    const missing = join(root, 'missing-store');
    await fs.symlink(missing, artifacts);
    await restart();
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

  it.skipIf(!posix || !constants.O_NOFOLLOW)('exclusive temporary creation refuses a symlink inserted before open', async () => {
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      expect(Number(flags) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      if (Number(flags) & constants.O_CREAT) await fs.symlink(join(outside, 'secret'), String(file));
      return open(file, flags, mode);
    });
    expect((await call('artifact-write', 'raced')).isError).toBe(true);
    expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
  });

  describe('parent swaps during descriptor-based artifact access', () => {
    it.skipIf(!linuxDescriptors).each(['verification', 'directory cleanup'])('closes every handle and preserves the %s error', async failure => {
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
          if (name === artifacts || (failure === 'verification' && name.endsWith('.tmp'))) {
            throw new Error('directory cleanup failed');
          }
        });
        if (failure === 'verification' && name.endsWith('.tmp')) {
          vi.spyOn(handle, 'stat').mockRejectedValue(new Error('verification failed'));
        }
        return handle;
      });
      const result = await call('artifact-write', 'parent/file');
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: `Error writing artifact: ${failure} failed` }]);
      expect(closed).toHaveLength(3);
      expect(await fs.readFile(join(artifacts, 'parent/file'), 'utf8')).toBe(failure === 'verification' ? 'preserved' : 'replacement');
    });

    it.skipIf(!linuxDescriptors).each(['artifact-read', 'artifact-write'])('%s rejects a parent swapped before its directory open', async tool => {
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

    it.skipIf(!linuxDescriptors).each(['artifact-read', 'artifact-write'])('%s remains anchored when its parent is swapped immediately before file open', async tool => {
      await fs.mkdir(join(artifacts, 'parent'));
      await fs.writeFile(join(artifacts, 'parent/secret'), 'inside content');
      const open = fs.open.bind(fs);
      let swapped = false;
      vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        if (!swapped && (String(file).endsWith('/secret') || (Number(flags) & constants.O_CREAT))) {
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

    it.skipIf(!linuxDescriptors)('anchors mkdir to the opened parent when its name is replaced with an outside symlink', async () => {
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

    it.skipIf(!linuxDescriptors)('rejects an outside symlink inserted for a missing component immediately before mkdir', async () => {
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

    it.skipIf(!linuxDescriptors)('verifies an opened file before replacing or reading after a parent is moved outside', async () => {
      for (const tool of ['artifact-read', 'artifact-write']) {
        await fs.mkdir(join(artifacts, tool));
        await fs.writeFile(join(artifacts, tool, 'file'), 'preserved');
        const open = fs.open.bind(fs);
        const spy = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
          const handle = await open(file, flags, mode);
          if (String(file).endsWith('/file') || (Number(flags) & constants.O_CREAT)) {
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

    it.skipIf(!linuxDescriptors).each([false, true])('fails closed with unavailable descriptor paths (missing root=%s)', async missingRoot => {
      if (missingRoot) await fs.rm(artifacts, { recursive: true });
      const realpath = fs.realpath.bind(fs);
      vi.spyOn(fs, 'realpath').mockImplementation(async file => {
        if (String(file).startsWith('/proc/self/fd/')) throw Object.assign(new Error('procfs unavailable'), { code: 'ENOENT' });
        return realpath(file);
      });
      expect((await call('artifact-write', 'new/deep/file')).isError).toBe(true);
      if (missingRoot) await expect(fs.lstat(artifacts)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await fs.readdir(artifacts)).toEqual([]);
      expect(await fs.readdir(outside)).toEqual(['secret']);
    });
  });

  it('uses the real artifact root for a configured external store and root alias', async () => {
    const store = join(root, 'store');
    const alias = join(root, 'store-alias');
    await fs.mkdir(store);
    await fs.symlink(store, alias, hostPlatform === 'win32' ? 'junction' : 'dir');
    vi.stubEnv('AIWG_ARTIFACTS_PATH', alias);
    await restart();
    expect((await call('artifact-write', 'nested/file')).isError).toBeUndefined();
    expect(await fs.readFile(join(store, 'nested/file'), 'utf8')).toBe('replacement');
    expect((await call('artifact-read', 'nested/file')).isError).toBeUndefined();
    expect(await fs.readdir(artifacts)).toEqual([]);
  });

  it('accepts standalone dot components while rejecting parent segments and streams', async () => {
    expect((await call('artifact-write', './requirements/./file.md')).isError).toBeUndefined();
    expect((await call('artifact-read', './requirements/file.md')).content).toEqual([{ type: 'text', text: 'replacement' }]);
    for (const name of ['requirements/../file.md', './file.md:stream', 'requirements./file.md']) {
      expect((await call('artifact-read', name)).isError).toBe(true);
    }
  });

  it('does not let writable location pointers select another artifact root', async () => {
    expect((await client.callTool({ name: 'artifact-write', arguments: {
      path: '.aiwg-location', content: outside, project_dir: project,
    } })).isError).toBeUndefined();
    await fs.writeFile(join(project, '.aiwg-location'), outside);
    await fs.writeFile(join(artifacts, 'secret'), 'inside');
    expect((await call('artifact-read', 'secret')).content).toEqual([{ type: 'text', text: 'inside' }]);
    for (const tool of ['artifact-read', 'artifact-write']) {
      expect((await client.callTool({ name: tool, arguments: {
        path: 'secret', project_dir: artifacts, content: 'replacement',
      } })).isError).toBe(true);
    }
    expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
  });

  it('binds the default project and environment store at server start', async () => {
    await fs.writeFile(join(artifacts, 'file'), 'bound project');
    vi.spyOn(process, 'cwd').mockReturnValue(outside);
    vi.stubEnv('AIWG_ARTIFACTS_PATH', outside);
    expect((await client.callTool({ name: 'artifact-read', arguments: { path: 'file' } })).content)
      .toEqual([{ type: 'text', text: 'bound project' }]);
  });

  it('rejects hard-linked reads and replaces writes without changing the outside inode', async () => {
    await fs.link(join(outside, 'secret'), join(artifacts, 'linked'));
    expect((await call('artifact-read', 'linked')).isError).toBe(true);
    expect((await call('artifact-write', 'linked')).isError).toBeUndefined();
    expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
    expect(await fs.readFile(join(artifacts, 'linked'), 'utf8')).toBe('replacement');
    expect((await fs.stat(join(artifacts, 'linked'))).nlink).toBe(1);
  });

  it('atomic replacement preserves an outside hard link inserted just before rename', async () => {
    await fs.writeFile(join(artifacts, 'file'), 'old artifact');
    const rename = fs.rename.bind(fs);
    let replaced = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('.tmp')) {
        replaced = true;
        await fs.unlink(join(artifacts, 'file'));
        await fs.link(join(outside, 'secret'), join(artifacts, 'file'));
      }
      return rename(from, to);
    });
    expect((await call('artifact-write', 'file')).isError).toBeUndefined();
    expect(replaced).toBe(true);
    expect(await fs.readFile(join(outside, 'secret'), 'utf8')).toBe('outside content');
    expect(await fs.readFile(join(artifacts, 'file'), 'utf8')).toBe('replacement');
  });

  it('never unlinks a pathname after exclusive-create verification fails', async () => {
    const open = fs.open.bind(fs);
    let temporary = '';
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (Number(flags) & constants.O_CREAT) {
        expect(Number(flags) & constants.O_EXCL).toBe(constants.O_EXCL);
        temporary = String(file);
        await fs.rename(temporary, join(artifacts, 'held'));
        await fs.writeFile(temporary, 'replacement inode');
      }
      return handle;
    });
    const unlink = vi.spyOn(fs, 'unlink');
    expect((await call('artifact-write', 'new')).isError).toBe(true);
    expect(unlink).not.toHaveBeenCalled();
    expect(await fs.readFile(join(artifacts, temporary.split('/').pop()!), 'utf8')).toBe('replacement inode');
    expect(await fs.readFile(join(artifacts, 'held'), 'utf8')).toBe('');
  });

});

// Unsupported platforms must refuse before any pathname open/mkdir/cleanup.
describe('artifact access without rooted operations', () => {
  it.each(['darwin', 'win32'])('fails closed on %s without creating outside files or directories', async platform => {
    root = await fs.mkdtemp(join(tmpdir(), 'aiwg-artifact-unsupported-'));
    project = join(root, 'project');
    await fs.mkdir(project);
    vi.stubGlobal('process', new Proxy(process, {
      get: (target, key) => key === 'platform' ? platform : Reflect.get(target, key),
    }));
    const unsupported = await createServer();
    const requester = new Client({ name: 'unsupported-regression', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await unsupported.connect(st);
    await requester.connect(ct);
    const mkdir = vi.spyOn(fs, 'mkdir');
    const open = vi.spyOn(fs, 'open');
    const unlink = vi.spyOn(fs, 'unlink');
    try {
      for (const tool of ['artifact-read', 'artifact-write']) {
        const result = await requester.callTool({ name: tool, arguments: { path: './new/deep/file', project_dir: project, content: 'replacement' } });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('refusing unanchored I/O') }]);
      }
      expect(mkdir).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
      expect(await fs.readdir(project)).toEqual([]);
    } finally {
      await requester.close();
      await unsupported.close();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
