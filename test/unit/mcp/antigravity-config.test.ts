// Cover native plugin migration, preservation and refusal through both registry owners.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as typed from '../../../src/mcp/registry.js';
import * as runtime from '../../../src/mcp/registry.mjs';
import { prepareAntigravityConfig, resolveAntigravityConfigPath } from '../../../src/mcp/antigravity-config.mjs';

let root: string;
let project: string;
let home: string;
let configPath: string;
let legacyPath: string;
let manifestPath: string;
const url = 'https://fixture.example.invalid/mcp';

function put(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value) + '\n');
}
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-antigravity-config-'));
  project = join(root, 'project');
  home = join(root, 'home');
  mkdirSync(project);
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('AIWG_CONFIG_LAYERS', '');
  configPath = join(project, '.agents/plugins/aiwg/mcp_config.json');
  manifestPath = join(dirname(configPath), 'plugin.json');
  legacyPath = join(project, '.agents/mcp_config.json');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('Antigravity migration planner', () => {
  it('maps only legacy serverUrl entries without a native url and preserves every other value', async () => {
    const legacy = { mcpServers: {
      remote: { serverUrl: url, headers: { Accept: 'application/json' } },
      both: { serverUrl: url, url: `${url}/native` },
      local: { command: 'fixture' }, empty: null, array: [], scalar: 'operator-value',
    }, operatorSetting: { enabled: true } };
    put(legacyPath, legacy);
    const original = readFileSync(legacyPath, 'utf8');
    const plan = await prepareAntigravityConfig('agy', configPath, {}, { projectDir: project });
    expect(plan.config).toEqual({ ...legacy, mcpServers: {
      ...legacy.mcpServers, remote: { url, headers: { Accept: 'application/json' } },
    } });
    expect(plan.warnings).toEqual([expect.stringContaining('legacy file is retained unchanged')]);
    expect(plan.warnings[0]).toContain('Restart agy');
    expect(plan.writes).toEqual([{ file: manifestPath, content: '{"name":"aiwg"}\n', options: { projectRoot: project } }]);
    expect(readFileSync(legacyPath, 'utf8')).toBe(original);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('preserves existing manifest and warns only for differing shared server and top-level values', async () => {
    put(manifestPath, { name: 'aiwg', description: 'operator metadata' });
    const existing = { mcpServers: { conflict: { command: 'plugin' }, same: { url } },
      setting: 'plugin', equal: { keep: true } };
    put(legacyPath, { mcpServers: { conflict: { command: 'legacy' }, same: { serverUrl: url },
      inherited: { command: 'inherited' } }, setting: 'legacy', equal: { keep: true }, legacyOnly: true });
    const plan = await prepareAntigravityConfig('antigravity', configPath, existing, { projectDir: project });
    expect(plan.writes).toEqual([]);
    expect(plan.config).toEqual({ ...existing, legacyOnly: true, mcpServers: {
      ...existing.mcpServers, inherited: { command: 'inherited' },
    } });
    expect(plan.warnings).toEqual([
      expect.stringContaining('legacy file is retained unchanged'),
      expect.stringContaining('server conflict differs'),
      expect.stringContaining('top-level setting differs'),
    ]);
    expect(read(manifestPath)).toEqual({ name: 'aiwg', description: 'operator metadata' });
  });

  it('accepts legacy metadata without a server map and an existing config without a map', async () => {
    put(legacyPath, { operatorSetting: true });
    expect((await prepareAntigravityConfig('antigravity', configPath, {}, { projectDir: project })).config)
      .toEqual({ operatorSetting: true, mcpServers: {} });
  });

  it.each(['claude', 'antigravity'] as const)('does not plan project migration for %s user scope', async provider => {
    put(legacyPath, { mcpServers: { legacy: { serverUrl: url } } });
    const existing = { mcpServers: { own: { url } } };
    expect(await prepareAntigravityConfig(provider, configPath, existing, { projectDir: project, scope: 'user' }))
      .toEqual({ config: existing, writes: [], warnings: [] });
  });

  it.each(['manifest', 'legacy'] as const)('refuses malformed %s data without changing files', async target => {
    const file = target === 'manifest' ? manifestPath : legacyPath;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{broken');
    await expect(prepareAntigravityConfig('antigravity', configPath, {}, { projectDir: project }))
      .rejects.toThrow('Refusing to overwrite malformed MCP config');
    expect(readFileSync(file, 'utf8')).toBe('{broken');
    expect(existsSync(configPath)).toBe(false);
  });

  it.each([[], null, { mcpServers: [] }])('refuses invalid legacy config shape %j', async value => {
    put(legacyPath, value);
    await expect(prepareAntigravityConfig('agy', configPath, {}, { projectDir: project }))
      .rejects.toThrow('object root and an object server map');
    expect(read(legacyPath)).toEqual(value);
  });

  it.each(['manifest', 'legacy', 'parent'] as const)('refuses symlinked %s migration input', async target => {
    const outside = join(root, 'outside.json');
    put(outside, { mcpServers: {} });
    const file = target === 'manifest' ? manifestPath : legacyPath;
    if (target === 'parent') symlinkSync(home, join(project, '.agents'), 'dir');
    else {
      mkdirSync(dirname(file), { recursive: true });
      symlinkSync(outside, file);
    }
    await expect(prepareAntigravityConfig('antigravity', configPath, {}, { projectDir: project }))
      .rejects.toThrow('symlink');
    expect(read(outside)).toEqual({ mcpServers: {} });
    expect(existsSync(configPath)).toBe(false);
  });
});

describe.each([['typed', typed], ['runtime', runtime]] as const)('%s Antigravity injection', (_name, api) => {
  it.each(['antigravity', 'agy'] as const)('migrates through %s, reports conflicts and retains plugin ownership', async provider => {
    const registry = new api.McpServerRegistry(join(root, 'registry'));
    await registry.add({ name: 'shared', type: 'http', url });
    await registry.add({ name: 'new', type: 'http', url, headers: { Accept: '' } });
    const existing = { mcpServers: { shared: { command: 'plugin-owned' } }, setting: 'plugin' };
    put(configPath, existing);
    put(legacyPath, { mcpServers: { shared: { serverUrl: url }, legacyOnly: { serverUrl: url } }, setting: 'legacy' });
    const original = readFileSync(legacyPath, 'utf8');
    const result = await api.injectServers(registry, provider, { projectDir: project });
    expect(result.error).toBeUndefined();
    expect(result.configPath).toBe(configPath);
    expect(result.alreadyPresent).toEqual(['shared']);
    expect(result.serversInjected).toEqual(['new']);
    expect(result.warnings).toEqual([
      expect.stringContaining('legacy file is retained unchanged'),
      expect.stringContaining('server shared differs'), expect.stringContaining('top-level setting differs'),
    ]);
    expect(read(configPath)).toEqual({ setting: 'plugin', mcpServers: {
      shared: { command: 'plugin-owned' }, legacyOnly: { url }, new: { url, headers: { Accept: '' } },
    } });
    expect(read(manifestPath)).toEqual({ name: 'aiwg' });
    expect(readFileSync(legacyPath, 'utf8')).toBe(original);
    expect((await registry.get('shared'))?.injectedProviders).toEqual([]);
    expect((await registry.get('new'))?.injectedProviders).toEqual(['antigravity']);
  });

  it('uses private user scope without reading or migrating the project legacy config', async () => {
    const registry = new api.McpServerRegistry(join(root, 'registry'));
    await registry.add({ name: 'remote', type: 'http', url });
    put(legacyPath, { mcpServers: [] });
    const userPath = join(home, '.gemini/config/mcp_config.json');
    expect(api.getProviderConfigPath('agy', project, { scope: 'user' })).toBe(userPath);
    const result = await api.injectServers(registry, 'agy', { projectDir: project, scope: 'user' });
    expect(result.error).toBeUndefined();
    expect(result.warnings).toBeUndefined();
    expect(read(userPath)).toEqual({ mcpServers: { remote: { url } } });
    expect(statSync(userPath).mode & 0o777).toBe(0o600);
    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  it('combines tool-filter and migration warnings in a dry run without creating the plugin', async () => {
    const registry = new api.McpServerRegistry(join(root, 'registry'));
    await registry.add({ name: 'remote', type: 'http', url });
    put(legacyPath, { mcpServers: { inherited: { serverUrl: url } } });
    const result = await api.injectServers(registry, 'antigravity', {
      projectDir: project, dryRun: true, toolFilters: { deny: ['invalid-pattern'], allow: [] },
    });
    expect(result.error).toBeUndefined();
    expect(result.warnings).toEqual([
      expect.stringContaining('invalid-pattern'), expect.stringContaining('legacy file is retained unchanged'),
    ]);
    expect(result.serversInjected).toEqual(['remote']);
    expect(existsSync(dirname(configPath))).toBe(false);
    expect((await registry.get('remote'))?.injectedProviders).toEqual([]);
  });

  it.each(['malformed', 'directory', 'symlink'] as const)('refuses a %s plugin destination', async kind => {
    const registry = new api.McpServerRegistry(join(root, 'registry'));
    await registry.add({ name: 'remote', type: 'http', url });
    mkdirSync(dirname(configPath), { recursive: true });
    const outside = join(root, 'outside.json');
    put(outside, { mcpServers: {} });
    if (kind === 'malformed') writeFileSync(configPath, '{broken');
    else if (kind === 'directory') mkdirSync(configPath);
    else symlinkSync(outside, configPath);
    await expect(api.injectServers(registry, 'agy', { projectDir: project }))
      .rejects.toThrow(kind === 'symlink' ? 'symlink' : 'Refusing to overwrite malformed MCP config');
    expect(read(outside)).toEqual({ mcpServers: {} });
    expect(existsSync(manifestPath)).toBe(false);
    expect((await registry.get('remote'))?.injectedProviders).toEqual([]);
  });

  it('renders remote native url with and without headers, and local commands with default args', () => {
    expect(api.buildServerConfig({ name: 'remote', type: 'http', url }, 'agy')).toEqual({ url });
    expect(api.buildServerConfig({ name: 'remote', type: 'sse', url, headers: { Accept: 'application/json' } }, 'antigravity'))
      .toEqual({ url, headers: { Accept: 'application/json' } });
    expect(api.buildServerConfig({ name: 'local', type: 'stdio', command: 'fixture' }, 'agy'))
      .toEqual({ command: 'fixture', args: [] });
  });
});

it('resolves user config from USERPROFILE when HOME is unset', () => {
  vi.stubEnv('HOME', '');
  expect(resolveAntigravityConfigPath(project, { scope: 'user' })).toBe(join(home, '.gemini/config/mcp_config.json'));
});

it('falls back to the native home for user paths without HOME or USERPROFILE', () => {
  vi.stubEnv('HOME', '');
  vi.stubEnv('USERPROFILE', '');
  expect(resolveAntigravityConfigPath(project, { scope: 'user' })).toBe(resolve(homedir(), '.gemini/config/mcp_config.json'));
});
