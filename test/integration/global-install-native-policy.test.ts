import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createWebResourceReleaseFixture,
  TEST_RAW_PATH,
  TEST_SKILL_BODY,
  TEST_VERSION,
} from '../fixtures/web-resource-release.js';
import { acquireDirectoryLock } from '../../src/artifacts/prebuilt-build-lock.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let tempRoot = '';
let installRoot = '';
let installOutput = '';
let cliPath = '';
let home = '';
let project = '';
let trustRootFile = '';
let fixture: ReturnType<typeof createWebResourceReleaseFixture>;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runInstalledCli(args: string[]): Promise<CliResult> {
  return runInstalledCliIn(project, args);
}

function installedEnv(): NodeJS.ProcessEnv {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !key.toLowerCase().startsWith('npm_config_') && key !== 'AIWG_ROOT'),
  );
  return {
    ...cleanEnv,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    AIWG_RESOURCE_BASE_URL: fixture.baseUrl,
    AIWG_RESOURCE_CACHE_ROOT: path.join(home, '.cache', 'aiwg-web'),
    AIWG_RESOURCE_TRUST_ROOT_FILE: trustRootFile,
    AIWG_RESOURCE_ALLOW_INSECURE_LOOPBACK_HTTP: '1',
    AIWG_BIN: cliPath,
    AIWG_LOG_LEVEL: 'silent',
    NO_UPDATE_NOTIFIER: '1',
  };
}

function runInstalledCliIn(cwd: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd,
      env: installedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runInstalledApi(cwd: string, args: string[]): Promise<CliResult> {
  const probePath = path.join(path.dirname(installRoot), 'api-probe.mjs');
  const script = [
    `import { createRequire } from 'node:module';`,
    `const require = createRequire(${JSON.stringify(probePath)});`,
    `const api = await import(require.resolve('aiwg'));`,
    `await api.run(${JSON.stringify(args)}, { cwd: ${JSON.stringify(cwd)} });`,
    `process.exit(0);`,
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd,
      env: installedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function expectCliSuccess(result: CliResult): void {
  expect(result.code, [result.stderr, result.stdout].filter(Boolean).join('\n')).toBe(0);
}

describe('global install native lifecycle-script policy', () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aiwg-global-install-'));
    // Release indices are generated artifacts and are intentionally ignored by
    // git. A clean tag checkout therefore has no package fallback until the
    // release build materializes it. Build it explicitly before using
    // --ignore-scripts so this test exercises the packed artifact without
    // relying on another test or workflow step to have run first.
    const materialize = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'release:fortemi-index'],
      { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 180_000 },
    );
    if (materialize.status !== 0) throw new Error(materialize.stderr || materialize.stdout);

    const releasePackLock = await acquireDirectoryLock(
      path.join(PROJECT_ROOT, 'prebuilt', 'fortemi-core', '.framework-build.lock'),
    );
    let pack: ReturnType<typeof spawnSync>;
    try {
      pack = spawnSync(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['pack', '--ignore-scripts', '--json', '--pack-destination', tempRoot],
        { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
    } finally {
      await releasePackLock();
    }
    if (pack.status !== 0) throw new Error(pack.stderr || pack.stdout);
    const packed = JSON.parse(pack.stdout) as Array<{ filename: string }>;
    const tarball = path.join(tempRoot, packed[0]!.filename);

    const prefix = path.join(tempRoot, 'prefix');
    const npmrc = path.join(tempRoot, 'npmrc');
    await writeFile(npmrc, 'ignore-scripts=false\n');
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_')),
    );
    const installArgs = [
        'install', '--global', '--prefix', prefix,
        '--cache', path.join(tempRoot, 'cache'), '--userconfig', npmrc,
        '--min-release-age=7', '--no-audit', '--no-fund', tarball,
    ];
    // Probe the actual install options after environment/userconfig isolation.
    const policy = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['config', 'get', 'min-release-age', ...installArgs.slice(1, -1)],
      { cwd: tempRoot, encoding: 'utf8', timeout: 30_000, env: cleanEnv },
    );
    expect(policy.status, policy.stderr).toBe(0);
    expect(policy.stdout.trim()).toBe('7');
    const install = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      installArgs,
      { cwd: tempRoot, encoding: 'utf8', timeout: 240_000, env: cleanEnv },
    );
    installOutput = `${install.stdout}\n${install.stderr}`;
    if (install.status !== 0) throw new Error(installOutput);
    installRoot = process.platform === 'win32'
      ? path.join(prefix, 'node_modules', 'aiwg')
      : path.join(prefix, 'lib', 'node_modules', 'aiwg');
    cliPath = process.platform === 'win32'
      ? path.join(prefix, 'aiwg.cmd')
      : path.join(prefix, 'bin', 'aiwg');

    home = path.join(tempRoot, 'home');
    project = path.join(tempRoot, 'legacy-project');
    await mkdir(path.join(project, '.aiwg'), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(path.join(project, '.aiwgrc.json'), JSON.stringify({
      version: '1.0',
      validation: { enabled: true },
    }, null, 2) + '\n');
    await writeFile(path.join(project, '.aiwg', 'aiwg.config'), JSON.stringify({
      version: '1.0',
      project: { name: 'legacy-web-regression' },
      providers: ['claude', 'codex'],
    }, null, 2) + '\n');

    fixture = createWebResourceReleaseFixture();
    await fixture.start();
    fixture.publishRelease();
    trustRootFile = path.join(home, 'release-root.pem');
    await writeFile(trustRootFile, fixture.publicKeyPem, { mode: 0o600 });
  }, 420_000);

  afterAll(async () => {
    await fixture?.stop();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it('does not put node-pty or hnswlib-node in the base dependency graph', async () => {
    const manifest = JSON.parse(await readFile(path.join(installRoot, 'package.json'), 'utf8'));
    expect(manifest.optionalDependencies).not.toHaveProperty('node-pty');
    expect(manifest.optionalDependencies).not.toHaveProperty('hnswlib-node');
    expect(existsSync(path.join(installRoot, 'node_modules', 'node-pty'))).toBe(false);
    expect(existsSync(path.join(installRoot, 'node_modules', 'hnswlib-node'))).toBe(false);
  });

  it('emits no lifecycle-script policy warning for either deferred native package', () => {
    expect(installOutput).not.toMatch(/allow-scripts[^\n]*(node-pty|hnswlib-node)/i);
    expect(installOutput).not.toMatch(/(node-pty|hnswlib-node)[^\n]*install scripts? not yet covered/i);
  });

  it('exports the supported programmatic API from the installed package root', async () => {
    const requireFromPrefix = createRequire(path.join(path.dirname(installRoot), 'api-probe.cjs'));
    const entry = requireFromPrefix.resolve('aiwg');
    expect(entry).toBe(path.join(installRoot, 'dist', 'src', 'api', 'index.js'));
    expect(existsSync(path.join(installRoot, 'dist', 'src', 'api', 'index.d.ts'))).toBe(true);
    expect(existsSync(path.join(installRoot, 'dist', 'src', 'resources', 'index.d.ts'))).toBe(true);

    const entryUrl = pathToFileURL(entry).href;
    const probe = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `const api = await import(${JSON.stringify(entryUrl)});` +
        `if (typeof api.run !== 'function' || ` +
        `typeof api.resolveWebRelease !== 'function' || ` +
        `typeof api.fetchVerifiedRawResource !== 'function') process.exit(2);` +
        `process.exit(0);`,
    ], { encoding: 'utf8' });
    expect(probe.status, probe.stderr).toBe(0);
  });

  it('routes signed web discovery through the installed package API', async () => {
    const discovered = await runInstalledApi(project, [
      'discover', 'signed web regression',
      '--resource-source', 'web',
      '--aiwg-version', TEST_VERSION,
      '--json', '--compact',
    ]);
    expectCliSuccess(discovered);
    const payload = JSON.parse(discovered.stdout);
    expect(payload.query).toMatchObject({
      resource_source: 'web',
      aiwg_version: TEST_VERSION,
    });
    expect(payload.results[0]).toMatchObject({ name: 'web-regression', type: 'skill' });
  });

  it('regenerates lightweight Claude project wiring without deploying project assets', async () => {
    const contextProject = path.join(tempRoot, 'context-only-project');
    await mkdir(contextProject, { recursive: true });

    const result = await runInstalledCliIn(contextProject, ['regenerate', '--provider', 'claude']);

    expectCliSuccess(result);
    expect(existsSync(path.join(contextProject, 'WORKSPACE.md'))).toBe(true);
    expect(existsSync(path.join(contextProject, 'AIWG.md'))).toBe(true);
    expect(existsSync(path.join(contextProject, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(path.join(contextProject, '.aiwg', 'AIWG.md'))).toBe(true);
    expect(existsSync(path.join(contextProject, '.claude'))).toBe(false);
    expect(existsSync(path.join(contextProject, '.agents'))).toBe(false);
  });

  it('globally installs kernel assets and leaves only lightweight project wiring', async () => {
    const globalProject = path.join(tempRoot, 'global-project');
    await mkdir(globalProject, { recursive: true });

    const result = await runInstalledCliIn(globalProject, [
      'use', 'sdlc', '--provider', 'claude', '--global',
      '--no-hooks', '--yes',
    ]);

    expectCliSuccess(result);
    expect(existsSync(path.join(home, '.claude', 'skills', 'aiwg-status', 'SKILL.md'))).toBe(true);
    const registry = JSON.parse(await readFile(path.join(home, '.aiwg', 'installed.json'), 'utf8'));
    expect(registry.installed.sdlc.deployedTo.claude.skills).toBeGreaterThan(0);
    expect(registry.installed.sdlc.deployedTo.claude.entries.skills).toContain('aiwg-status');
    expect(existsSync(path.join(globalProject, 'WORKSPACE.md'))).toBe(true);
    expect(existsSync(path.join(globalProject, 'AIWG.md'))).toBe(true);
    expect(existsSync(path.join(globalProject, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(path.join(globalProject, '.aiwg', 'AIWG.md'))).toBe(true);
    expect(existsSync(path.join(globalProject, '.claude'))).toBe(false);
    expect(existsSync(path.join(globalProject, '.agents'))).toBe(false);
  }, 180_000);

  it('discovers and shows packaged kernel assets from a legacy project without aiwg use', async () => {
    const discovered = await runInstalledCli(['discover', 'aiwg status', '--json', '--compact']);
    expectCliSuccess(discovered);
    const payload = JSON.parse(discovered.stdout);
    expect(payload.results[0]).toMatchObject({ name: 'aiwg-status', type: 'skill' });
    expect(payload.query.aiwg_root).toBe(installRoot);

    const shown = await runInstalledCli(['show', 'skill', 'aiwg-status']);
    expectCliSuccess(shown);
    expect(shown.stdout).toContain('name: aiwg-status');
    expect(existsSync(path.join(project, '.claude'))).toBe(false);
    expect(existsSync(path.join(project, '.agents'))).toBe(false);
  }, 30_000);

  it('runs the workspace status probe from the packed install', async () => {
    const status = await runInstalledCli(['status', '--probe', '--json']);

    expectCliSuccess(status);
    const payload = JSON.parse(status.stdout);
    expect(payload).toHaveProperty('status');
    expect(payload).toHaveProperty('checks');
    expect(status.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  });

  it('doctor verifies a known capability instead of accepting an empty discovery result', async () => {
    const doctor = await runInstalledCli(['doctor', '--provider', 'claude']);

    expectCliSuccess(doctor);
    expect(doctor.stdout).toContain('Discovery: aiwg discover');
    expect(doctor.stdout).toContain('`aiwg discover aiwg doctor --json --limit 10` succeeded');
    expect(doctor.stdout).toContain('prebuilt framework index present');
    expect(existsSync(path.join(
      installRoot,
      'prebuilt', 'fortemi-core', 'framework', 'manifest.json',
    ))).toBe(true);
    expect(existsSync(path.join(
      installRoot,
      'prebuilt', 'fortemi-core', 'framework', 'aiwg-fortemi-index-v2.json',
    ))).toBe(true);
  }, 90_000);

  it('runs installed-CLI web discover/show and warm offline through legacy configuration', async () => {
    const discovered = await runInstalledCli([
      'discover', 'signed web regression',
      '--resource-source', 'web',
      '--aiwg-version', TEST_VERSION,
      '--json', '--compact',
    ]);
    expectCliSuccess(discovered);
    const payload = JSON.parse(discovered.stdout);
    expect(payload.query).toMatchObject({
      resource_source: 'web',
      aiwg_version: TEST_VERSION,
      graph: 'framework',
    });
    expect(payload.results[0]).toMatchObject({ name: 'web-regression', type: 'skill' });
    const id = payload.results[0].id as string;

    const shown = await runInstalledCli([
      'show', 'skill', id,
      '--resource-source', 'web',
      '--aiwg-version', TEST_VERSION,
    ]);
    expectCliSuccess(shown);
    expect(Buffer.from(shown.stdout)).toEqual(TEST_SKILL_BODY);
    expect(fixture.requestPaths).toContain(`/resources/${TEST_VERSION}/${TEST_RAW_PATH}`);

    const requestsBeforeOffline = fixture.requestPaths.length;
    const offline = await runInstalledCli([
      'show', 'skill', id,
      '--resource-source', 'web',
      '--aiwg-version', TEST_VERSION,
      '--offline',
    ]);
    expectCliSuccess(offline);
    expect(Buffer.from(offline.stdout)).toEqual(TEST_SKILL_BODY);
    expect(fixture.requestPaths).toHaveLength(requestsBeforeOffline);
  });
});
