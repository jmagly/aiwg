import { usePlatformSimulation } from '../../helpers/windows-simulation.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(), shell: vi.fn(), platform: 'linux', config: vi.fn(), workspace: vi.fn(),
}));
vi.mock('../../../src/process/bounded-child-process.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/process/bounded-child-process.mjs')>(),
  boundedExecFileSync: mocks.execFile,
  boundedExecSync: mocks.shell,
}));
vi.mock('os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), platform: () => mocks.platform,
  homedir: () => process.env.HOME!,
}));
vi.mock('../../../src/channel/manager.mjs', () => ({
  loadConfig: mocks.config, saveConfig: vi.fn(), getChannel: vi.fn(), getPackageRoot: () => process.cwd(),
}));
vi.mock('../../../src/update/service.mjs', () => ({ updateInstallation: vi.fn() }));
vi.mock('readline', () => ({
  createInterface: () => ({ question: (_prompt: string, answer: (value: string) => void) => answer('y'), close: vi.fn() }),
}));
vi.mock('../../../src/config/workspace.js', () => ({ resolveWorkspace: mocks.workspace }));
vi.mock('../../../src/installation/manager.mjs', () => ({
  inspectInstallation: () => ({ actualMethod: 'source', actualRoot: process.cwd(), state: 'healthy' }),
}));
vi.mock('../../../src/cli/provider-resolution.js', () => ({
  resolveActiveProvider: async () => ({ provider: 'codex' }), isSessionProviderResolution: () => false,
}));

import { OpsRegistry } from '../../../src/ops/registry.js';
import { RuntimeDiscovery } from '../../../src/smiths/toolsmith/runtime-discovery.mjs';
import { OpenClawAdapter } from '../../../src/skills/adapters/openclaw.js';
import { ClawHubAdapter } from '../../../src/skills/adapters/clawhub.js';
import { checkForUpdates } from '../../../src/update/checker.mjs';
import { runtimeInfoHandler } from '../../../src/cli/handlers/runtime-info.js';

const simulatePlatform = usePlatformSimulation({ afterEach });

const summary = {
  environment: { os: 'Linux', osVersion: 'test', arch: 'x64', shell: '/bin/sh' },
  resources: { memoryAvailableGb: 1, memoryTotalGb: 2, diskFreeGb: 3, cpuCores: 4 },
  toolCounts: { core: 1, languages: 0, utilities: 0, custom: 0 }, totalTools: 1,
  lastDiscovery: 'test', catalogPath: 'test',
};

describe('bounded argv callers', () => {
  let dir: string;
  let ttyDescriptors: [object, PropertyDescriptor | undefined][];

  beforeEach(async () => {
    vi.resetAllMocks();
    mocks.platform = 'linux';
    dir = await mkdtemp(join(tmpdir(), 'aiwg-bounded-callers-'));
    vi.stubEnv('HOME', dir);
    vi.stubEnv('CARGO_HOME', join(dir, '.cargo'));
    vi.stubEnv('AIWG_CONFIG', join(dir, 'config'));
    vi.stubEnv('AIWG_ARTIFACTS_PATH', join(dir, 'artifacts'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ttyDescriptors = [];
  });

  afterEach(async () => {
    for (const [stream, descriptor] of ttyDescriptors) {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else Reflect.deleteProperty(stream, 'isTTY');
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('initializes, clones and reads remotes using literal argv and exact repository paths', async () => {
    const remote = `file:///repo 'quoted';$(echo injected)`;
    const home = join(dir, `ops 'quoted';$(echo injected)`);
    mocks.execFile.mockImplementation((_file, args) => {
      if (args[0] === 'clone') mkdirSync(join(args[args.length - 1], '.git'), { recursive: true });
      return args[0] === 'config' ? Buffer.from(remote + '\n') : Buffer.alloc(0);
    });
    const registry = new OpsRegistry(join(dir, 'config'));
    await registry.initWorkspace({ name: 'fresh', home, mode: 'multi-repo', extensions: ['sys'], silent: true });
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['init'], 'quick', { cwd: join(home, 'sysops'), stdio: 'pipe' });
    await registry.initWorkspace({ name: 'clone', home: join(dir, 'clone'), mode: 'single-repo', extensions: ['sys'], from: remote, silent: true });
    const repoPath = join(dir, 'clone', 'ops');
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['clone', '--', remote, repoPath], 'long', { stdio: 'pipe' });
    expect((await registry.load()).workspaces.clone.repos.ops.remote).toBe(remote);
    await registry.initWorkspace({ name: 'adopt', home: join(dir, 'clone'), mode: 'single-repo', extensions: ['sys'], silent: true });
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['config', '--get', 'remote.origin.url'], 'quick', {
      cwd: repoPath, stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it('pushes an authorized remote and branch as separate arguments and handles a failed push', async () => {
    const home = join(dir, 'workspace'); const repoPath = join(home, `repo 'quoted'`);
    const remote = `origin;$(echo injected)`; const branch = `topic 'quoted';$(echo injected)`;
    mkdirSync(join(home, '.aiwg'), { recursive: true }); mkdirSync(repoPath);
    await writeFile(join(home, '.aiwg', 'aiwg.config'), JSON.stringify({ repos: [] }));
    const registry = new OpsRegistry(join(dir, 'config')); const data = await registry.load();
    data.workspaces.test = { home, mode: 'single-repo', repos: { repo: { path: repoPath, remote: 'unused', extensions: ['sys'] } } };
    await registry.save(data);
    mocks.workspace.mockResolvedValue({ members: [{ path: repoPath, allowed: ['push'], remotes: { primary: remote }, delivery: { default_branch: branch } }] });
    mocks.execFile.mockReturnValue(Buffer.alloc(0));
    await registry.pushWorkspace('test');
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['push', '--end-of-options', remote, branch], 'network', { cwd: repoPath, stdio: 'pipe' });
    mocks.execFile.mockImplementation(() => { throw new Error('push denied'); });
    await expect(registry.pushWorkspace('test')).resolves.toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('push failed — push denied'));
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it.each(['remote', 'branch'])('rejects a push %s beginning with a dash before invoking git', async operand => {
    const home = join(dir, 'workspace'); const repoPath = join(home, 'repo');
    mkdirSync(join(home, '.aiwg'), { recursive: true }); mkdirSync(repoPath);
    await writeFile(join(home, '.aiwg', 'aiwg.config'), JSON.stringify({ repos: [] }));
    const registry = new OpsRegistry(join(dir, 'config')); const data = await registry.load();
    data.workspaces.test = { home, mode: 'single-repo', repos: { repo: { path: repoPath, remote: 'unused', extensions: ['sys'] } } };
    await registry.save(data);
    mocks.workspace.mockResolvedValue({ members: [{ path: repoPath, allowed: ['push'],
      remotes: { primary: operand === 'remote' ? '--receive-pack=command' : 'origin' },
      delivery: { default_branch: operand === 'branch' ? '--all' : 'main' } }] });
    await registry.pushWorkspace('test');
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Remote and branch must not start with "-"'));
  });

  it('looks up exact tool names, tries version flags, and reads man paths without shell parsing', async () => {
    const tool = `custom 'quoted';$(echo injected)`; const toolPath = join(dir, tool); const manPath = join(dir, 'manual.1');
    await writeFile(manPath, 'manual');
    mocks.execFile.mockImplementation((file, args) => {
      if (file === 'which' && args[0] === tool) return toolPath + '\n/ignored/second\n';
      if (file === toolPath && args[0] === '-V') return 'custom 1.2.3\n';
      if (file === 'man') return manPath + '\n';
      if (file === 'df') return 'Filesystem 1K-blocks Used Available Use% Mounted\n/dev/test 10000000 1 9000000 1% /\n';
      throw new Error('not found');
    });
    const discovery = new RuntimeDiscovery(join(dir, 'catalog'));
    discovery.knownTools = { [tool]: { category: 'custom', capabilities: [], aliases: [], relatedTools: [] } };
    const catalog = await discovery.discover();
    expect(catalog.tools).toEqual([expect.objectContaining({ id: tool, path: toolPath, version: '1.2.3', manPage: manPath })]);
    expect(mocks.execFile).toHaveBeenCalledWith('which', [tool], 'quick', { encoding: 'utf-8' });
    for (const flag of ['--version', '-v', '-V']) {
      expect(mocks.execFile).toHaveBeenCalledWith(toolPath, [flag], 'quick', {
        encoding: 'utf-8', timeout: 3000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    expect(mocks.execFile).toHaveBeenCalledWith('man', ['-w', tool], 'quick', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    expect(mocks.execFile).toHaveBeenCalledWith('df', ['-k', '.'], 'quick', { encoding: 'utf-8', cwd: process.cwd() });
    expect(await discovery.checkTool('missing')).toMatchObject({ available: false });
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'])('uses argv for %s environment and disk commands', async os => {
    mocks.platform = os;
    mocks.execFile.mockReturnValue(os === 'darwin' ? '14.1\n' : 'FreeSpace Size\n1073741824 2147483648\n');
    const discovery = new RuntimeDiscovery(join(dir, 'catalog'));
    if (os === 'darwin') {
      expect(await discovery.getEnvironment()).toMatchObject({ osVersion: 'macOS 14.1' });
      expect(mocks.execFile).toHaveBeenCalledWith('sw_vers', ['-productVersion'], 'quick', { encoding: 'utf-8' });
    } else {
      expect(await discovery.getResources()).toMatchObject({ diskFreeGb: 1 });
      expect(mocks.execFile).toHaveBeenCalledWith('wmic', ['logicaldisk', 'get', 'size,freespace'], 'quick', { encoding: 'utf-8' });
    }
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it('checks edge hashes and pulls with unchanged cwd and fast-forward arguments', async () => {
    const edgePath = join(dir, `edge 'quoted';$(echo injected)`);
    mocks.config.mockResolvedValue({ channel: 'edge', edgePath });
    mocks.execFile.mockImplementation((_file, args) => args[1] === 'HEAD' ? 'local\n' : args[1] === 'origin/main' ? 'remote\n' : Buffer.alloc(0));
    for (const stream of [process.stdin, process.stdout]) {
      ttyDescriptors.push([stream, Object.getOwnPropertyDescriptor(stream, 'isTTY')]);
      Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
    }
    await checkForUpdates();
    expect(mocks.execFile.mock.calls).toEqual([
      ['git', ['fetch', '--quiet'], 'network', { cwd: edgePath, timeout: 10000 }],
      ['git', ['rev-parse', 'HEAD'], 'quick', { cwd: edgePath, encoding: 'utf8' }],
      ['git', ['rev-parse', 'origin/main'], 'quick', { cwd: edgePath, encoding: 'utf8' }],
      ['git', ['pull', '--ff-only'], 'network', { cwd: edgePath, stdio: 'inherit' }],
    ]);
    expect(console.log).toHaveBeenCalledWith('Update complete!');
    mocks.config.mockResolvedValue({ channel: 'edge', edgePath });
    mocks.execFile.mockImplementation((_file, args) => {
      if (args[0] === 'pull') throw new Error('fast-forward refused');
      return args[1] === 'HEAD' ? 'local\n' : args[1] === 'origin/main' ? 'remote\n' : Buffer.alloc(0);
    });
    await expect(checkForUpdates()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('Update failed. Run manually:');
    expect(console.error).toHaveBeenCalledWith(`  cd ${edgePath} && git pull`);
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it('trims equal local and remote hashes and avoids prompting or pulling', async () => {
    mocks.config.mockResolvedValue({ channel: 'edge', edgePath: dir });
    mocks.execFile.mockImplementation((_file, args) => args[1] === 'HEAD' ? ' same\n' : 'same\n');
    await checkForUpdates();
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
    expect(console.log).not.toHaveBeenCalledWith('New commits available in the main branch.');
  });

  it('silently handles a failed edge fetch without checking hashes or pulling', async () => {
    mocks.config.mockResolvedValue({ channel: 'edge', edgePath: dir });
    mocks.execFile.mockImplementation(() => { throw new Error('offline'); });
    await expect(checkForUpdates()).resolves.toBeUndefined();
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('delegates OpenClaw availability, list, search, info and install through literal argv', async () => {
    const name = `skill 'quoted';$(echo injected)`;
    mocks.execFile.mockImplementation((_file, args) => {
      if (args[1] === 'list' || args[1] === 'search') return JSON.stringify([{ name, description: 'result' }]);
      if (args[1] === 'info') return JSON.stringify({ name, version: '1.0' });
      return '';
    });
    const adapter = new OpenClawAdapter();
    expect(await adapter.isAvailable()).toBe(true);
    expect(await adapter.list()).toEqual([expect.objectContaining({ name })]);
    expect(await adapter.search(name)).toEqual([expect.objectContaining({ name })]);
    expect(await adapter.info(name)).toMatchObject({ name, version: '1.0' });
    await adapter.install(name, { projectDir: dir });
    expect(mocks.execFile.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ['openclaw', ['--version']], ['openclaw', ['skills', 'list', '--json']],
      ['openclaw', ['skills', 'search', name, '--json']], ['openclaw', ['skills', 'info', name, '--json']],
      ['openclaw', ['skills', 'install', name]],
    ]);
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it('launches OpenClaw availability and skill commands through its Windows npm Node entry point', async () => {
    const entry = join(dir, 'openclaw.mjs');
    await writeFile(entry, '');
    await writeFile(join(dir, 'openclaw.cmd'), '@ECHO off\n"%_prog%" "%dp0%\\openclaw.mjs" %*\n');
    vi.stubEnv('PATH', dir);
    simulatePlatform('win32');
    mocks.execFile.mockReturnValue('[]');
    const adapter = new OpenClawAdapter();
    expect(await adapter.isAvailable()).toBe(true);
    await adapter.search('literal & query');
    expect(mocks.execFile.mock.calls.map(call => [call[0], call[1]])).toEqual([
      [process.execPath, [entry, '--version']],
      [process.execPath, [entry, 'skills', 'search', 'literal & query', '--json']],
    ]);
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it('delegates every ClawHub command with literal arguments and no shell redirects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const name = `skill 'quoted';$(echo injected)`;
    mocks.execFile.mockImplementation((_file, args) => {
      if (args[0] === 'search' || args[0] === 'list') return JSON.stringify([{ name }]);
      if (args[0] === 'info') return JSON.stringify({ name });
      return '';
    });
    const adapter = new ClawHubAdapter();
    expect(await adapter.isAvailable()).toBe(true);
    expect(await adapter.search(name)).toEqual([expect.objectContaining({ name })]);
    expect(await adapter.info(name)).toMatchObject({ name });
    expect(await adapter.list()).toEqual([expect.objectContaining({ name })]);
    await adapter.install(name, { projectDir: dir });
    await adapter.publish(dir);
    const calls = mocks.execFile.mock.calls.map(call => [call[0], call[1]]);
    expect(calls.slice(0, 4)).toEqual([
      ['clawhub', ['--version']], ['clawhub', ['search', name, '--json']],
      ['clawhub', ['info', name, '--json']], ['clawhub', ['list', '--json']],
    ]);
    expect(calls[4]).toEqual(['clawhub', ['install', name, '--output', expect.any(String)]]);
    expect(calls[5]).toEqual(['clawhub', ['publish', dir]]);
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it('launches ClawHub availability and searches through its Windows npm Node entry point', async () => {
    const entry = join(dir, 'clawhub.mjs');
    await writeFile(entry, '');
    await writeFile(join(dir, 'clawhub.cmd'), '@ECHO off\n"%_prog%" "%dp0%\\clawhub.mjs" %*\n');
    vi.stubEnv('PATH', dir);
    simulatePlatform('win32');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    mocks.execFile.mockReturnValue('[]');
    const adapter = new ClawHubAdapter();
    expect(await adapter.isAvailable()).toBe(true);
    const query = '$(echo injected) & "literal"';
    await adapter.search(query);
    expect(mocks.execFile.mock.calls.map(call => [call[0], call[1]])).toEqual([
      [process.execPath, [entry, '--version']],
      [process.execPath, [entry, 'search', query, '--json']],
    ]);
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it.each(['chronyc', 'chronyd', 'missing'])('reports chrony availability after looking up %s', async available => {
    vi.spyOn(RuntimeDiscovery.prototype, 'getSummary').mockResolvedValue(summary);
    mocks.execFile.mockImplementation((_file, args) => {
      if (args[0] !== available) throw new Error('not found');
      return '/usr/bin/' + available;
    });
    const result = await runtimeInfoHandler.execute({ args: [], rawArgs: ['runtime-info'], cwd: dir, frameworkRoot: dir });
    expect(result.exitCode).toBe(0);
    expect(mocks.execFile.mock.calls).toEqual((available === 'chronyc' ? ['chronyc'] : ['chronyc', 'chronyd'])
      .map(tool => ['which', [tool], 'quick', { stdio: ['pipe', 'pipe', 'ignore'] }]));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(available === 'missing' ? '✗ not installed' : '✓ installed'));
    expect(mocks.shell).not.toHaveBeenCalled();
  });
});
