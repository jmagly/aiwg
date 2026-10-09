import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failure = vi.hoisted(() => ({ nth: 0, unwritable: false, calls: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: async (...args: Parameters<typeof actual.access>) => {
      if (failure.unwritable && String(args[0]).endsWith('claude-tool-permissions')) {
        throw new Error('ownership directory is not writable');
      }
      return actual.access(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      failure.calls.push(String(args[1]));
      if (failure.calls.length === failure.nth) throw new Error('injected rename failure');
      return actual.rename(...args);
    },
  };
});

import { McpServerRegistry, injectServers } from '../../../src/mcp/registry.js';
import { McpServerRegistry as RuntimeRegistry, injectServers as runtimeInject } from '../../../src/mcp/registry.mjs';
import { main } from '../../../src/mcp/cli.mjs';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-filter-transaction-'));
  for (const name of ['config', 'project', 'home']) mkdirSync(join(root, name));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('CODEX_HOME', join(root, 'home', '.codex'));
  vi.stubEnv('AIWG_CONFIG', join(root, 'config'));
  failure.nth = 0;
  failure.unwritable = false;
  failure.calls = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function snapshot(dir: string): Record<string, { content: string; mode: number }> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).flatMap(name => {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) return Object.entries(snapshot(file));
    return [[file, { content: readFileSync(file, 'utf-8'), mode: statSync(file).mode & 0o7777 }]];
  }));
}

const filters = { deny: ['git__delete'], allow: [] };
describe.each([
  { implementation: 'TypeScript', Registry: McpServerRegistry, inject: injectServers },
  { implementation: 'runtime', Registry: RuntimeRegistry as unknown as typeof McpServerRegistry, inject: runtimeInject as typeof injectServers },
])('$implementation persistent transaction', ({ Registry, inject }) => {
  it('refuses an unwritable ownership directory before changing either config', async () => {
    const registry = new Registry(join(root, 'config'));
    await registry.add({ name: 'git', type: 'stdio', command: 'git-mcp' });
    mkdirSync(join(root, 'config', 'claude-tool-permissions'));
    failure.calls = [];
    const before = snapshot(root);
    failure.unwritable = true;
    await expect(inject(registry, 'claude', { projectDir: join(root, 'project'), toolFilters: filters }))
      .rejects.toThrow('ownership directory is not writable');
    expect(snapshot(root)).toEqual(before);
    expect(failure.calls).toEqual([]);
  });

  it.each([false, true].flatMap(existing => [2, 3].map(nth => ({ existing, nth }))))(
    'restores all earlier files after write $nth fails (existing=$existing)', async ({ existing, nth }) => {
      const registry = new Registry(join(root, 'config'));
      await registry.add({ name: 'git', type: 'stdio', command: 'git-mcp' });
      const projectDir = join(root, 'project');
      if (existing) {
        await inject(registry, 'claude', { projectDir, toolFilters: filters });
        chmodSync(join(projectDir, '.mcp.json'), 0o640);
        chmodSync(join(projectDir, '.claude', 'settings.local.json'), 0o644);
      }
      const before = { ...snapshot(projectDir), ...snapshot(join(root, 'config')) };
      const receipt = vi.spyOn(registry, 'recordInjection');
      failure.calls = [];
      failure.nth = nth;
      await expect(inject(registry, 'claude', {
        projectDir, toolFilters: { deny: ['git__admin'], allow: [] },
      })).rejects.toThrow('injected rename failure');
      expect(failure.calls.slice(0, 2)).toEqual([
        join(projectDir, '.mcp.json'), join(projectDir, '.claude', 'settings.local.json'),
      ]);
      expect({ ...snapshot(projectDir), ...snapshot(join(root, 'config')) }).toEqual(before);
      expect(receipt).not.toHaveBeenCalled();
    },
  );
});

describe('ephemeral CLI transaction', () => {
  function inject(extra: string[] = []) {
    return main(['inject', '--provider', 'claude', '--profile', 'safe', '--ephemeral', '--out', join(root, 'run.json'), ...extra]);
  }
  beforeEach(() => {
    writeFileSync(join(root, 'config', 'mcp-servers.json'), JSON.stringify({
      apiVersion: 'aiwg.io/v1', kind: 'McpServerRegistry',
      servers: { git: { name: 'git', type: 'stdio', command: 'git-mcp' } },
    }));
    writeFileSync(join(root, 'config', 'mcp-profiles.json'), JSON.stringify({
      apiVersion: 'aiwg.io/v1', kind: 'McpProfileRegistry',
      profiles: { safe: { name: 'safe', servers: ['git'], providerOverrides: { '*': { toolDeny: ['git__delete'] } } } },
    }));
  });

  it.each([false, true].flatMap(existing => [2, 3].map(nth => ({ existing, nth }))))(
    'restores all earlier files after write $nth fails (existing=$existing)', async ({ existing, nth }) => {
      if (existing) {
        await inject();
        chmodSync(join(root, 'run.json'), 0o640);
        chmodSync(join(root, 'run.settings.json'), 0o644);
      }
      const before = snapshot(root);
      failure.calls = [];
      failure.nth = nth;
      await expect(inject()).rejects.toThrow('injected rename failure');
      expect(failure.calls.slice(0, 2)).toEqual([join(root, 'run.json'), join(root, 'run.settings.json')]);
      expect(snapshot(root)).toEqual(before);
    },
  );

  it('refuses an unwritable ownership directory before either output is changed', async () => {
    mkdirSync(join(root, 'config', 'claude-tool-permissions'));
    const before = snapshot(root);
    failure.unwritable = true;
    await expect(inject()).rejects.toThrow('ownership directory is not writable');
    expect(snapshot(root)).toEqual(before);
    expect(failure.calls).toEqual([]);
  });

  it('preflights the ownership directory before either output is changed', async () => {
    writeFileSync(join(root, 'config', 'claude-tool-permissions'), 'operator file');
    const before = snapshot(root);
    await expect(inject()).rejects.toThrow();
    expect(snapshot(root)).toEqual(before);
    expect(failure.calls).toEqual([]);
  });
});
