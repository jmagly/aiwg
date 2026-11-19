import { usePlatformSimulation, withPlatform } from '../../helpers/windows-simulation.mjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const simulatePlatform = usePlatformSimulation({ afterEach });

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn(), version: vi.fn(), copies: vi.fn(), freshness: vi.fn(), packageRoot: vi.fn(), realSpawn: null }));
vi.mock('../../../src/cli/services/deployment-staleness.js', () => ({ configuredDeploymentStaleness: mocks.freshness }));
vi.mock('../../../src/process/bounded-child-process.mjs', async importOriginal => ({
  ...await importOriginal(), boundedExecFileSync: mocks.execFile,
}));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal();
  mocks.realSpawn = original.spawnSync;
  return { ...original, execFileSync: mocks.execFile, execSync: mocks.execFile, spawnSync: mocks.spawn };
});
vi.mock('../../../src/channel/manager.mjs', async importOriginal => ({
  ...await importOriginal(), getVersionInfo: mocks.version,
  loadConfig: async () => ({}), getPackageRoot: mocks.packageRoot,
  resolveMcpServerEntrypointPath: root => join(root, 'missing-server.mjs'),
}));
vi.mock('../../../src/installation/manager.mjs', async importOriginal => ({
  ...await importOriginal(), inspectInstallation: () => ({ state: 'aligned', drift: [] }),
  inspectInstallationCopies: mocks.copies,
}));

let root;
let runDoctor;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-doctor-probes-'));
  mkdirSync(join(root, '.aiwg'));
  writeFileSync(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({ remotes: { primary: 'origin' } }));
  writeFileSync(join(root, 'aiwg.cmd'), '@ECHO off\n"%_prog%" "%dp0%\\entry.mjs" %*\n');
  writeFileSync(join(root, 'entry.mjs'), '');
  vi.stubEnv('AIWG_ROOT', root);
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  ({ runDoctor } = await import('../../../tools/cli/doctor.mjs'));
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('doctor command probe behavior', () => {
  beforeEach(() => {
    mocks.freshness.mockResolvedValue([]);
    mocks.copies.mockReturnValue([]);
    mocks.packageRoot.mockReturnValue(root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'argv', 'get').mockReturnValue([process.execPath, 'doctor.mjs', '--no-budget-check']);
    mocks.execFile.mockImplementation((file, args) => {
      if (file === 'git' && args[0] === 'remote') return 'origin\nupstream\n';
      if (file === 'git' && args[0] === 'rev-list') return '2\n';
      return 'aiwg 1.0.0\n';
    });
    mocks.spawn.mockReturnValue({ status: 0, stdout: '{}', stderr: '' });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([false, true])('keeps deployment freshness findings advisory (unreadable: %s)', async unreadable => {
    if (unreadable) mocks.freshness.mockRejectedValue(new Error('unreadable deployment'));
    else mocks.freshness.mockResolvedValue([{ message: 'Stale deployment: old rule', remediation: 'aiwg refresh' }]);
    await runDoctor();
    const output = console.log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('⚠ Deployment freshness:');
    expect(output).toContain(unreadable ? 'Unable to check: unreadable deployment' : 'old rule — aiwg refresh');
  });

  it.each(['entrypoint', 'package'])('passes all four win32 discovery probes with spaces via %s (#437)', async via => {
    const fixture = mkdtempSync(join(tmpdir(), 'aiwg-doctor-spaces-'));
    const nativePlatform = process.platform;
    const nativeNode = process.execPath;
    const node = join(fixture, 'Program Files', 'nodejs', 'node.exe');
    const packageRoot = join(fixture, 'Install Prefix');
    const launcher = join(packageRoot, 'bin', 'aiwg.mjs');
    mkdirSync(join(fixture, 'Program Files', 'nodejs'), { recursive: true });
    mkdirSync(join(packageRoot, 'bin'), { recursive: true });
    if (nativePlatform === 'win32') copyFileSync(nativeNode, node);
    else symlinkSync(nativeNode, node);
    writeFileSync(launcher, 'console.log(JSON.stringify({ results: [{ name: "aiwg-doctor" }] }));');
    simulatePlatform('win32');
    vi.spyOn(process, 'execPath', 'get').mockReturnValue(node);
    vi.spyOn(process, 'argv', 'get').mockReturnValue([node, via === 'entrypoint' ? launcher : 'doctor.mjs', '--no-budget-check']);
    mocks.packageRoot.mockReturnValue(packageRoot);
    // Execute with the host's shell rules while exercising doctor's win32 branch.
    mocks.spawn.mockImplementation((file, args, options) => withPlatform(nativePlatform,
      () => mocks.realSpawn(file, args, options)));
    try {
      await runDoctor();
      const output = console.log.mock.calls.map(([line]) => String(line)).join('\n');
      for (const command of ['discover', 'show', 'index', 'runtime-info']) {
        expect(output).toContain(`✓ Discovery: aiwg ${command}:`);
      }
      expect(mocks.spawn).toHaveBeenCalledTimes(4);
      for (const [file, args, options] of mocks.spawn.mock.calls) {
        expect(file).toBe(node);
        expect(args[0]).toBe(launcher);
        expect(options.shell).toBe(false);
      }
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.each(['linux', 'win32'])('keeps PATH-only discovery launchable on %s (#437)', async platform => {
    simulatePlatform(platform);
    mocks.spawn.mockReturnValue({ status: 0, stdout: '{"results":[{"name":"aiwg-doctor"}]}', stderr: '' });
    await runDoctor();
    const probes = mocks.spawn.mock.calls.filter(([, args]) => ['discover', 'show', 'index', 'runtime-info'].includes(args[0]));
    expect(probes).toHaveLength(4);
    for (const [file, , options] of probes) {
      expect(file).toBe('aiwg');
      expect(options.shell).toBe(platform === 'win32');
    }
    const output = console.log.mock.calls.map(([line]) => String(line)).join('\n');
    for (const command of ['discover', 'show', 'index', 'runtime-info']) {
      expect(output).toContain(`✓ Discovery: aiwg ${command}:`);
    }
  });

  it('clears unrelated caller state from discovery child launches (#437)', async () => {
    const names = ['AIWG_TEST_PROVIDER_SECRET', 'NODE_OPTIONS', 'NODE_DEBUG'];
    const previous = names.map(name => process.env[name]);
    vi.stubEnv('AIWG_TEST_PROVIDER_SECRET', 'synthetic-sensitive-value');
    vi.stubEnv('NODE_OPTIONS', '--trace-warnings');
    vi.stubEnv('NODE_DEBUG', 'child_process');
    try {
      await runDoctor();
      const probes = mocks.spawn.mock.calls.filter(([, args]) => ['discover', 'show', 'index', 'runtime-info'].includes(args[0]));
      expect(probes).toHaveLength(4);
      for (const [, , options] of probes) {
        expect(options.env).toEqual(expect.objectContaining({ HOME: process.env.HOME }));
        expect(options.env).not.toHaveProperty('AIWG_TEST_PROVIDER_SECRET');
        expect(options.env).not.toHaveProperty('NODE_OPTIONS');
        expect(options.env).not.toHaveProperty('NODE_DEBUG');
      }
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
  });

  it.each([
    { state: 'non-git workspace', inside: null, branchExists: false, status: 'info', message: 'not a git repository; branch check skipped' },
    { state: 'bare repository', inside: 'false\n', branchExists: false, status: 'info', message: 'not a git worktree; branch check skipped' },
    { state: 'remote-only default branch', inside: 'true\n', branchExists: false, status: 'info', message: "default_branch 'main' not found locally" },
    { state: 'existing local default branch', inside: 'true\n', branchExists: true, status: 'ok', message: 'default_branch=main' },
    { state: 'non-git workspace with invalid mode', inside: null, branchExists: false, mode: 'invalid', status: 'warn', message: 'mode=invalid' },
  ])('reports Delivery Policy for a $state (#3911)', async ({ inside, branchExists, mode, status, message }) => {
    const configPath = join(root, '.aiwg', 'aiwg.config');
    writeFileSync(configPath, JSON.stringify({ delivery: { default_branch: 'main', mode } }));
    mocks.execFile.mockImplementation((file, args) => {
      if (file === 'git' && args.includes('--is-inside-work-tree')) {
        if (inside === null) throw Object.assign(new Error('not a git repository'), { status: 128 });
        return inside;
      }
      if (file === 'git' && args.includes('--verify')) {
        if (!branchExists) throw Object.assign(new Error('missing local branch'), { status: 1 });
        return 'synthetic-commit\n';
      }
      return '';
    });
    mocks.execFile.mockClear();
    try {
      await runDoctor();
      const policy = console.log.mock.calls.map(([line]) => String(line))
        .filter(line => line.includes('Delivery Policy:')).at(-1);
      expect(policy).toContain(`${{ info: '○', ok: '✓', warn: '⚠' }[status]} Delivery Policy:`);
      expect(policy).toContain(message);
      const branchProbes = mocks.execFile.mock.calls.filter(([file, args]) => file === 'git' && args.includes('--verify'));
      expect(branchProbes).toHaveLength(inside === 'true\n' ? 1 : 0);
      if (branchProbes.length) expect(branchProbes[0][1]).toEqual(['-C', root, 'rev-parse', '--verify', '--quiet', 'main']);
    } finally {
      writeFileSync(configPath, JSON.stringify({ remotes: { primary: 'origin' } }));
    }
  });

  it.each([undefined, 'systemd-unit', 'native-sandbox'])(
    'reports native-sandbox isolation only for opted-in groups (%s), in text and JSON', async launchMode => {
      const configPath = join(root, '.aiwg', 'aiwg.config');
      const original = { remotes: { primary: 'origin' } };
      const group = mode => ({ maxParallel: 1,
        execution: { sandbox: 'workspace-write', approval: 'never', ...(mode ? { launchMode: mode } : {}) },
        members: [{ id: 'worker', cli: 'codex', model: 'synthetic-model', roles: ['coding'] }] });
      writeFileSync(configPath, JSON.stringify({ ...original, parallelism: { worker_dispatch: false,
        groups: { workers: group(launchMode), harnesses: group(launchMode), isolated: group('systemd-unit') } } }));
      const priorExitCode = process.exitCode;
      try {
        for (const flags of [[], ['--probe-workers', '--dry-run'], ['--probe-workers', '--json'], ['--decision-offload', '--json']]) {
          vi.spyOn(process, 'argv', 'get').mockReturnValue([process.execPath, 'doctor.mjs', '--no-budget-check', ...flags]);
          console.log.mockClear();
          const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
          await runDoctor();
          const output = console.log.mock.calls.map(([line]) => String(line)).join('\n')
            + stdout.mock.calls.map(([line]) => String(line)).join('');
          if (flags.includes('--json')) {
            const payload = JSON.parse(output);
            expect(payload.nativeSandboxWarnings.map(warning => warning.group))
              .toEqual(launchMode === 'native-sandbox' ? ['workers', 'harnesses'] : []);
            for (const warning of payload.nativeSandboxWarnings) expect(warning.configPath).toBe(configPath);
          }
          if (launchMode === 'native-sandbox') {
            expect(output).toContain('workers');
            expect(output).toContain('harnesses');
            expect(output).toContain(configPath);
            expect(output).toContain('systemd-unit isolation and its memory limit do not apply');
            expect(output).toContain("only the worker CLI's own sandbox applies");
          } else expect(output).not.toContain('systemd-unit isolation and its memory limit do not apply');
          stdout.mockRestore();
        }
      } finally {
        process.exitCode = priorExitCode;
        writeFileSync(configPath, JSON.stringify(original));
      }
    }, 120000);

  it.each([
    { flags: [] },
    { flags: ['--json'] },
    { flags: ['--qualify', '--yes'] },
    { flags: ['--qualify', '--yes', '--json'] },
    { flags: ['--dry-run'] },
    { flags: ['--qualify', '--dry-run', '--json'] },
    { flags: ['--cli', 'codex'] },
    { flags: ['--cli', 'codex', '--json'] },
    { flags: ['--cli', 'codex', '--qualify', '--yes'] },
    { flags: ['--cli', 'codex', '--qualify', '--yes', '--json'] },
  ])('reports missing project config before worker probes with $flags (#3452)', async ({ flags }) => {
    const project = mkdtempSync(join(tmpdir(), 'aiwg-doctor-missing-config-'));
    const previousExitCode = process.exitCode;
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    vi.spyOn(process, 'argv', 'get').mockReturnValue([process.execPath, 'doctor.mjs', '--probe-workers', ...flags]);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.execFile.mockClear();
    mocks.spawn.mockClear();
    try {
      await runDoctor();
      expect(process.exitCode).toBe(1);
      const diagnostic = stderr.mock.calls.map(([text]) => String(text)).join('');
      expect(diagnostic).toContain('OG_CONFIG_REFERENCE');
      expect(diagnostic).toContain('Missing project config');
      expect(diagnostic).toContain(join(project, '.aiwg', 'aiwg.config'));
      expect(diagnostic).toContain('aiwg init');
      expect(diagnostic).not.toMatch(/TypeError|Cannot read properties|Unknown configured worker CLI/);
      expect(console.log).not.toHaveBeenCalled();
      expect(mocks.execFile).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(process.exit).not.toHaveBeenCalled();
      expect(existsSync(join(project, '.aiwg', 'aiwg.config'))).toBe(false);
    } finally {
      process.exitCode = previousExitCode;
      rmSync(project, { recursive: true, force: true });
    }
  });

  it.each(['linux', 'win32'])('runs both version and PATH probes with working %s launch arguments', async platform => {
    simulatePlatform(platform);
    vi.stubEnv('PATH', root);
    mocks.version.mockRejectedValue(new Error('version unavailable'));
    await runDoctor();
    const file = platform === 'win32' ? process.execPath : 'aiwg';
    const prefix = platform === 'win32' ? [join(root, 'entry.mjs')] : [];
    expect(mocks.execFile).toHaveBeenCalledWith(file, [...prefix, '-version'], 'quick', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
    });
    expect(mocks.execFile).toHaveBeenCalledWith(file, [...prefix, '--version'], 'quick', { stdio: 'ignore' });
    expect(mocks.spawn).toHaveBeenCalled();
    for (const [, , options] of mocks.spawn.mock.calls) {
      expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    }
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('AIWG Version: aiwg 1.0.0'));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('aiwg installed but may not be in your PATH'));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Installation Copies:'));
  });

  it('executes the edge and project Git probes with their tiers and working directories', async () => {
    mocks.version.mockResolvedValue({ version: '1.0.0', channel: 'edge', devMode: true, edgePath: join(root, 'edge') });
    await runDoctor();
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['remote'], 'quick', {
      cwd: join(root, 'edge'), encoding: 'utf-8',
    });
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['fetch', 'upstream', '--dry-run'], 'network', {
      cwd: join(root, 'edge'), stdio: 'pipe',
    });
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['rev-list', 'HEAD..upstream/main', '--count'], 'quick', {
      cwd: join(root, 'edge'), encoding: 'utf-8',
    });
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['remote'], 'quick', {
      cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('reports foreign PATH and inactive nvm copies even when the version probe succeeds', async () => {
    const active = join(root, '.nvm/versions/node/v24/lib/node_modules/aiwg');
    const inactive = join(root, '.nvm/versions/node/v25/lib/node_modules/aiwg');
    mocks.copies.mockReturnValue([
      { root: active, executables: [join(root, 'bin/aiwg')], onPath: true, registered: false },
      { root: inactive, executables: [join(root, 'v25/bin/aiwg')], onPath: false, registered: false },
      { root: 'registered-copy', executables: [], onPath: true, registered: true },
    ]);
    await runDoctor();
    const output = console.log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('Installation Copies:');
    expect(output).toContain(`${active} (on PATH`);
    expect(output).toContain(`${inactive} (other nvm Node version, off PATH`);
    expect(output).toContain('aiwg installation adopt --yes');
    expect(output).toContain('npm uninstall -g aiwg');
    expect(output).not.toContain('registered-copy');
  });

  it.each([
    ['2026.10.3', 'Version skew:', 'warn'],
    ['2026.9.20', 'launcher 2026.9.20;', 'ok'],
    ['(unknown)', 'Could not determine both versions:', 'warn'],
  ])('reports launcher/runtime comparison for runtime %s', async (runtimeVersion, message, status) => {
    mocks.version.mockResolvedValue({
      version: '2026.10.3', channel: 'edge', devMode: false,
      launcherVersion: '2026.9.20', runtimeVersion, runtimePath: join(root, 'edge'),
    });
    await runDoctor();
    const output = console.log.mock.calls.map(([line]) => String(line)).join('\n');
    const symbol = status === 'warn' ? '⚠' : '✓';
    const comparison = output.split('\n').filter(line => line.includes('Launcher/Runtime Versions:')).at(-1);
    expect(comparison).toContain(`${symbol} Launcher/Runtime Versions: ${message}`);
    expect(output).toContain(join(root, 'edge'));
  });
});
