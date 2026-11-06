import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliToolFiles } from '../../tools/release/cli-package-files.mjs';
import { createExternalPluginProject, listFixtureEntries, listRelativeFiles, probeCliApi } from '../helpers/cli-package-fixtures.js';
import { buildCliPackage } from '../../tools/release/build-cli-package.mjs';
import { assertOfflinePluginDelivery } from '../helpers/cli-core-contract.js';
import { hasSevenDayReleaseAge } from '../helpers/npm-release-age.js';
import {
  createWebResourceReleaseFixture,
  TEST_SKILL_BODY,
  TEST_VERSION,
} from '../fixtures/web-resource-release.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let tempRoot = '';
let installRoot = '';
let cliPath = '';
let home = '';
let trustRootFile = '';
let fixture: ReturnType<typeof createWebResourceReleaseFixture>;
let packMetadata: { name: string; version: string; size: number; unpackedSize: number; files: Array<{ path: string }> };

function isolatedNpmEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      (!key.toLowerCase().startsWith('npm_config_') || key.toLowerCase() === 'npm_config_offline') && key !== 'AIWG_ROOT' && key !== 'AIWG_CONFIG'),
  );
}

function runtimeEnv(): NodeJS.ProcessEnv {
  return {
    ...isolatedNpmEnv(),
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    AIWG_CONFIG: path.join(home, '.aiwg'),
    AIWG_RESOURCE_BASE_URL: fixture.baseUrl,
    AIWG_RESOURCE_CACHE_ROOT: path.join(home, '.cache', 'aiwg-web'),
    AIWG_RESOURCE_TRUST_ROOT_FILE: trustRootFile,
    AIWG_RESOURCE_ALLOW_INSECURE_LOOPBACK_HTTP: '1',
    AIWG_LOG_LEVEL: 'silent',
    NO_UPDATE_NOTIFIER: '1',
  };
}

function runCli(args: string[], cwd = tempRoot): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd,
      env: runtimeEnv(),
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

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function runApi(args: string[]) {
  return probeCliApi(args, installRoot, tempRoot, runtimeEnv());
}

describe('packaging release-age policy interpretation', () => {
  const start = Date.parse('2026-09-10T12:00:00.000Z');
  const end = start + 1000;
  it.each([
    ['current npm', 'min-release-age=7\nbefore=null', true],
    ['normalized lower boundary', 'min-release-age=null\nbefore=2026-09-03T12:00:00.000Z', true],
    ['normalized upper boundary', 'min-release-age=null\nbefore=2026-09-03T12:00:01.000Z', true],
    ['omitted policy', 'min-release-age=null\nbefore=null', false],
    ['zero age', 'min-release-age=0\nbefore=null', false],
    ['wrong age', 'min-release-age=6\nbefore=null', false],
    ['normalized zero age', 'min-release-age=null\nbefore=2026-09-10T12:00:00.000Z', false],
    ['cutoff too recent', 'min-release-age=null\nbefore=2026-09-03T12:00:01.001Z', false],
    ['cutoff too old', 'min-release-age=null\nbefore=2026-09-03T11:59:59.999Z', false],
    ['invalid cutoff', 'min-release-age=null\nbefore=invalid', false],
    ['overriding cutoff', 'min-release-age=7\nbefore=2026-09-10T12:00:00.000Z', false],
    ['missing cutoff', 'min-release-age=7', false],
    ['duplicate age', 'min-release-age=7\nmin-release-age=7', false],
  ])('%s', (_name, output, expected) => {
    expect(hasSevenDayReleaseAge(output, start, end)).toBe(expected);
  });
  it.each([
    ['Thu Sep 03 2026 12:00:00 GMT+0000 (Coordinated Universal Time)', true],
    ['Thu Sep 03 2026 11:59:59 GMT+0000 (Coordinated Universal Time)', false],
    ['Thu Sep 03 2026 12:00:01 GMT+0000 (Coordinated Universal Time)', false],
    ['2026-09-03T12:00:00.000Z', false],
  ])('preserves cutoff precision for %s', (before, expected) => {
    expect(hasSevenDayReleaseAge(`min-release-age=null\nbefore=${before}`, start + 791, start + 950)).toBe(expected);
  });
});

describe('@aiwg/cli offline plugin packaging', () => {
  it('packs the helper and packages an external plugin from the extracted CLI', async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'aiwg-cli-plugin-offline-'));
    try {
      const stage = path.join(scratch, 'stage');
      await buildCliPackage({ outputDir: stage });
      const pack = spawnSync('npm', [
        'pack', stage, '--offline', '--ignore-scripts', '--json',
        '--cache', path.join(scratch, 'cache'), '--pack-destination', scratch,
      ], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
      expect(pack.status, pack.stderr).toBe(0);
      const packed = JSON.parse(pack.stdout)[0];
      expect(packed.files.map((file: { path: string }) => file.path)).toContain('tools/plugin/plugin-links.mjs');
      const extracted = path.join(scratch, 'extracted');
      await mkdir(extracted);
      const unpack = spawnSync('tar', ['-xzf', path.join(scratch, packed.filename), '-C', extracted, '--strip-components=1'], {
        encoding: 'utf8', timeout: 30_000,
      });
      expect(unpack.status, unpack.stderr).toBe(0);
      // Borrow existing dependencies read-only; never run npm install.
      await symlink(path.join(PROJECT_ROOT, 'node_modules'), path.join(extracted, 'node_modules'), 'dir');
      await assertOfflinePluginDelivery(extracted, scratch, isolatedNpmEnv());
      expect(await readFile(path.join(extracted, 'tools/plugin/plugin-links.mjs'), 'utf8'))
        .toBe(await readFile(path.join(PROJECT_ROOT, 'tools/plugin/plugin-links.mjs'), 'utf8'));
      const project = path.join(scratch, 'consumer');
      const wrapper = await createExternalPluginProject(project);
      const result = spawnSync(process.execPath, [
        path.join(extracted, 'bin/aiwg.mjs'), 'package-plugin', path.relative(project, wrapper), '--provider', 'all',
      ], {
        cwd: project, encoding: 'utf8', timeout: 60_000,
        env: {
          ...isolatedNpmEnv(), HOME: scratch, USERPROFILE: scratch,
          XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_CONFIG_HOME: path.join(scratch, 'config'),
          XDG_DATA_HOME: path.join(scratch, 'data'), AIWG_CONFIG: path.join(scratch, 'config'),
          NO_UPDATE_NOTIFIER: '1', AIWG_LOG_LEVEL: 'silent',
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      for (const provider of ['claude', 'codex']) {
        expect((await readFile(path.join(project, 'dist/plugins', `bt6-maintainer-0.2.0-${provider}.tar.gz`))).byteLength)
          .toBeGreaterThan(0);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('@aiwg/cli packaged web distribution', () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aiwg-cli-package-'));
    const stage = path.join(tempRoot, 'stage');
    await buildCliPackage({ outputDir: stage });

    const pack = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', stage, '--ignore-scripts', '--json', '--pack-destination', tempRoot],
      { timeout: 60_000, cwd: PROJECT_ROOT, env: isolatedNpmEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (pack.status !== 0) throw new Error(pack.stderr || pack.stdout);
    const packed = JSON.parse(pack.stdout) as Array<typeof packMetadata & { filename: string }>;
    packMetadata = packed[0]!;

    const prefix = path.join(tempRoot, 'prefix');
    const installArgs = [
        'install', '--prefix', prefix,
        '--cache', process.env.AIWG_PACKAGE_TEST_NPM_CACHE ?? path.join(tempRoot, 'npm-cache'),
        '--min-release-age=7', '--ignore-scripts', '--no-audit', '--no-fund',
        path.join(tempRoot, packed[0]!.filename),
    ];
    const policyStartedAt = Date.now();
    const policy = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['config', 'get', 'min-release-age', 'before', ...installArgs.slice(1, -1)],
      { cwd: tempRoot, env: isolatedNpmEnv(), encoding: 'utf8', timeout: 30_000 },
    );
    expect(policy.status, policy.stderr).toBe(0);
    expect(hasSevenDayReleaseAge(policy.stdout, policyStartedAt, Date.now()), policy.stdout).toBe(true);
    const install = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      installArgs,
      { cwd: tempRoot, env: isolatedNpmEnv(), encoding: 'utf8', timeout: 120_000 },
    );
    if (install.status !== 0) throw new Error(`${install.stdout}\n${install.stderr}`);
    installRoot = path.join(prefix, 'node_modules', '@aiwg', 'cli');
    cliPath = path.join(installRoot, 'bin', 'aiwg.mjs');
    home = path.join(tempRoot, 'home');
    await mkdir(home, { recursive: true });

    fixture = createWebResourceReleaseFixture();
    await fixture.start();
    const release = fixture.publishRelease();
    fixture.publishChannel('stable', 1, release);
    trustRootFile = path.join(home, 'release-root.pem');
    await writeFile(trustRootFile, fixture.publicKeyPem, { mode: 0o600 });
  }, 180_000);

  afterAll(async () => {
    await fixture?.stop();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it('is CalVer-locked and excludes the default corpus', async () => {
    const core = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    const installed = JSON.parse(await readFile(path.join(installRoot, 'package.json'), 'utf8'));
    const sourceReadme = await readFile(path.join(PROJECT_ROOT, 'packages', 'cli', 'README.md'), 'utf8');
    const installedReadme = await readFile(path.join(installRoot, 'README.md'), 'utf8');
    const installedNotices = await readFile(path.join(installRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const paths = packMetadata.files.map((file) => file.path);

    expect(packMetadata.name).toBe('@aiwg/cli');
    expect(packMetadata.version).toBe(core.version);
    expect(installed.version).toBe(core.version);
    expect(installed.dependencies).toEqual(core.dependencies);
    expect(installed.optionalDependencies).toEqual(core.optionalDependencies);
    expect(packMetadata.unpackedSize).toBeLessThan(25 * 1024 * 1024);
    for (const prefix of ['docs/', 'prebuilt/', 'templates/', 'apps/']) {
      expect(paths.some((entry) => entry.startsWith(prefix)), `${prefix} must not ship in @aiwg/cli`).toBe(false);
    }
    const allowedAgenticRuntime = [
      // Prompt-discovery hook runtime for Codex and Muse deploys (#3888).
      'agentic/code/addons/aiwg-hooks/canonical/aiwg-prompt-discovery.yaml',
      'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs',
      'agentic/code/addons/aiwg-utils/rules/anti-laziness.md',
      'agentic/code/addons/aiwg-utils/rules/anti-laziness.core.md',
      'agentic/code/addons/composition-engine/lib/runtime.mjs',
      'agentic/code/addons/composition-engine/lib/validator.mjs',
      'agentic/code/addons/composition-engine/schemas/flow-graph.schema.json',
    ];
    expect(paths.filter((entry) => entry.startsWith('agentic/')).filter(
      (entry) => !entry.startsWith('agentic/code/providers/') && !allowedAgenticRuntime.includes(entry),
    )).toEqual([]);
    const manifest = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'packages/cli/package.json'), 'utf8'));
    expect(paths.filter((entry) => entry.startsWith('tools/')).sort())
      .toEqual(cliToolFiles(PROJECT_ROOT, manifest.files));
    expect(paths).toContain('bin/aiwg.mjs');
    expect(paths).toContain('LICENSE');
    expect(paths).toContain('THIRD_PARTY_NOTICES.md');
    expect(installedNotices).toContain('@fortemi/core@2026.7.15');
    expect(installedNotices).toContain('@bytecask/core@2026.7.5');
    expect(installedNotices).toContain('AGPL-3.0-only');
    expect(paths).toContain('dist/src/api/index.js');
    expect(paths).toContain('dist/src/api/index.d.ts');
    expect(paths).toContain('dist/src/resources/index.js');
    expect(paths).toContain('dist/src/providers/capability-matrix.yaml');
    expect(paths).toContain('dist/src/models/model-capabilities.v1.json');
    expect(paths).toContain('dist/src/models/model-catalog.v1.json');
    expect(paths).toContain('agentic/code/providers/model-catalog.v1.json');
    expect(paths).toContain('tools/_resolve-impl.mjs');
    expect(paths).toContain('tools/cli/decision-offload-report.mjs');
    expect(paths).toContain('tools/cli/workspace-status.mjs');
    expect(paths).toContain('tools/agents/deploy-agents.mjs');
    expect(paths).toContain('tools/agents/providers/antigravity.mjs');
    expect(paths).toContain('tools/providers/antigravity-transport.mjs');
    expect(paths).toContain('agentic/code/providers/antigravity/provider-contract.v1.json');
    expect(paths).toContain('tools/plugin/package-plugins.mjs');
    expect(paths).toContain('tools/plugin/plugin-links.mjs');
    expect(paths).toContain('README.md');
    expect(installedReadme).toBe(sourceReadme);
    expect(Buffer.byteLength(installedReadme)).toBeGreaterThan(25_000);
    expect(installedReadme).toContain('# @aiwg/cli');
    expect(installedReadme).toContain('## The Agentic Use Model');
    expect(installedReadme).toContain('## Why This Reduces Agent Token Use');
    expect(installedReadme).toContain('## How Skills and Agents Use the Runtime');
    expect(installedReadme).toContain('https://github.com/jmagly/aiwg/blob/main/docs/cli/reference.md');
    expect(installedReadme).not.toContain('## CLI Guide');
    expect(installedReadme).toContain('## Security Model');
    expect(installedReadme).toContain('## Installation Troubleshooting');
  });

  it('runs workspace status from the installed lightweight tarball', async () => {
    const result = await runCli(['status', '--json']);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      decisionOffload: {
        schema: 'aiwg-decision-offload-snapshot/v1',
        readiness: {
          ask: { probed: false },
          evaluate: { probed: false },
        },
      },
      workspace: {
        exists: false,
      },
    });
  });

  it('ships every decision schema needed by the public API and job contract', async () => {
    const sourceRoot = path.join(PROJECT_ROOT, 'schemas', 'decision');
    const schemas = (await listRelativeFiles(sourceRoot)).filter(relative => relative.endsWith('.json'));
    const packedPaths = new Set(packMetadata.files.map(file => file.path));
    expect(schemas).toContain('DecisionJob.v1.schema.json');
    for (const relative of schemas) {
      const packagePath = path.posix.join('schemas/decision', ...relative.split(path.sep));
      expect(packedPaths.has(packagePath), `${packagePath} must ship in @aiwg/cli`).toBe(true);
      expect(JSON.parse(await readFile(path.join(installRoot, packagePath), 'utf8')))
        .toEqual(JSON.parse(await readFile(path.join(sourceRoot, relative), 'utf8')));
    }
  });

  it('ships every security schema and parses each installed copy', async () => {
    const sourceRoot = path.join(PROJECT_ROOT, 'schemas', 'security');
    const sourceSchemas = (await listRelativeFiles(sourceRoot))
      .filter((relative) => relative.endsWith('.schema.json'));
    const packedPaths = new Set(packMetadata.files.map((file) => file.path));

    expect(sourceSchemas.length).toBeGreaterThan(0);
    for (const relative of sourceSchemas) {
      const packagePath = path.posix.join('schemas/security', ...relative.split(path.sep));
      expect(packedPaths.has(packagePath), `${packagePath} must ship in @aiwg/cli`).toBe(true);

      const source = JSON.parse(await readFile(path.join(sourceRoot, relative), 'utf8'));
      const installed = JSON.parse(await readFile(path.join(installRoot, packagePath), 'utf8'));
      expect(installed).toEqual(source);
    }
  });

  it.each([
    ['all-pi', ['use', 'all', '--provider', 'pi']],
    ['sdlc-codex', ['use', 'sdlc', '--provider', 'codex']],
    ['all-dry-run', ['use', 'all', '--dry-run']],
  ])('rejects bundled setup %s with full-package guidance before project mutation', async (label, args) => {
    const project = path.join(tempRoot, `bundled-setup-${label}`);
    await mkdir(project, { recursive: true });
    const original = '# Existing project\n\nPreserve operator content.\n';
    await writeFile(path.join(project, 'README.md'), original);

    const result = await runCli(args, project);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code, output).not.toBe(0);
    expect(output).toContain('@aiwg/cli');
    expect(output).toMatch(/full (?:aiwg )?package/i);
    expect(output).toContain('npm install -g aiwg');
    expect(output).not.toMatch(/ENOENT|Installing|scandir/i);
    expect(await readdir(project), output).toEqual(['README.md']);
    expect(await readFile(path.join(project, 'README.md'), 'utf8')).toBe(original);
  }, 30_000);

  it('routes verify help through the installed CLI', async () => {
    const help = await runCli(['verify', '--help']);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain('aiwg verify');
    expect(help.stdout).toContain('Verify cross-asset provenance');
  });

  it('executes the packaged verifier and preserves its stable malformed contract', async () => {
    const verified = await runCli([
      'verify', 'missing-artifact.bin',
      '--policy', 'missing-root.json',
      '--offline', '--json',
    ]);
    expect(verified.code).toBe(27);
    expect(verified.stderr).toBe('');
    expect(JSON.parse(verified.stdout)).toMatchObject({
      schemaVersion: 'aiwg.verify.result.v1',
      status: 'malformed',
      exitCode: 27,
      artifact: { name: 'missing-artifact.bin' },
      diagnostics: [{ code: 'CLI_INPUT_ERROR' }],
    });
  });

  it('defaults to signed stable web discover and show without flags or a bundled corpus', async () => {
    const discovered = await runCli([
      'discover', 'signed web regression',
      '--json', '--compact',
    ]);
    expect(discovered.code, discovered.stderr).toBe(0);
    const payload = JSON.parse(discovered.stdout);
    expect(payload.query).toMatchObject({
      resource_source: 'web',
      aiwg_selector: 'stable',
      aiwg_version: TEST_VERSION,
    });
    expect(payload.results[0]).toMatchObject({ name: 'web-regression', type: 'skill' });

    const shown = await runCli([
      'show', 'skill', payload.results[0].id,
    ]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('# skill: web-regression');
    expect(shown.stdout).toContain('## Outline');
    expect(shown.stdout).toContain('## Drill in');
    expect(shown.stdout).toContain('--body');
    expect(shown.stdout).not.toContain('Downloaded exactly from the signed release fixture.');

    const body = await runCli(['show', 'skill', payload.results[0].id, '--body']);
    expect(body.code, body.stderr).toBe(0);
    expect(Buffer.from(body.stdout)).toEqual(TEST_SKILL_BODY);
  });

  it('routes signed web discovery through the installed public API', async () => {
    const discovered = await runApi([
      'discover', 'signed web regression',
      '--json', '--compact',
    ]);
    expect(discovered.code, discovered.stderr).toBe(0);
    const payload = JSON.parse(discovered.stdout);
    expect(payload.query).toMatchObject({
      resource_source: 'web',
      aiwg_selector: 'stable',
      aiwg_version: TEST_VERSION,
    });
    expect(payload.results[0]).toMatchObject({
      name: 'web-regression',
      type: 'skill',
    });
  }, 15_000);

  it('packages an external wrapper through the installed lightweight CLI (#2007)', async () => {
    const project = path.join(tempRoot, 'package-plugin-project');
    const wrapper = await createExternalPluginProject(project);
    const packaged = await runCli([
      'package-plugin', path.relative(project, wrapper), '--provider', 'all',
    ], project);
    expect(packaged.code, `${packaged.stdout}\n${packaged.stderr}`).toBe(0);

    const claudeArchive = path.join(project, 'dist', 'plugins', 'bt6-maintainer-0.2.0-claude.tar.gz');
    const codexArchive = path.join(project, 'dist', 'plugins', 'bt6-maintainer-0.2.0-codex.tar.gz');
    const claudeDigest = sha256(await readFile(claudeArchive));
    expect((await readFile(claudeArchive)).byteLength).toBeGreaterThan(0);
    expect((await readFile(codexArchive)).byteLength).toBeGreaterThan(0);

    const secondOutput = path.join(project, 'dist', 'plugins-repeat');
    const repeated = await runCli([
      'package-plugin', path.relative(project, wrapper), '--provider', 'claude', '--output', secondOutput,
    ], project);
    expect(repeated.code, `${repeated.stdout}\n${repeated.stderr}`).toBe(0);
    expect(sha256(await readFile(path.join(secondOutput, 'bt6-maintainer-0.2.0-claude.tar.gz')))).toBe(claudeDigest);
  }, 120_000);

  it.each([
    ['claude', '.claude/agents', '.claude/.aiwg/skills', '.claude/rules', '.md'],
    ['codex', '.codex/agents', '.agents/skills', '.codex/rules', '.toml'],
  ])('installs 11 external artifacts for %s at project scope and refreshes indices (#2008)', async (
    provider,
    agentsDir,
    skillsDir,
    rulesDir,
    agentExtension,
  ) => {
    const project = path.join(tempRoot, `project-scope-${provider}`);
    await createExternalPluginProject(project);
    const deployed = await runCli([
      'use', 'bt6-maintainer', '--provider', provider, '--scope', 'project', '--target', project,
    ], project);
    expect(deployed.code, `${deployed.stdout}\n${deployed.stderr}`).toBe(0);
    expect(await listFixtureEntries(path.join(project, agentsDir))).toHaveLength(5);
    expect(await listFixtureEntries(path.join(project, skillsDir))).toHaveLength(5);
    expect(await listFixtureEntries(path.join(project, rulesDir))).toHaveLength(1);
    expect((await listFixtureEntries(path.join(project, agentsDir))).every((name) => name.endsWith(agentExtension))).toBe(true);

    const metadata = JSON.parse(await readFile(path.join(project, '.aiwg', '.index', 'project', 'metadata.json'), 'utf8'));
    expect(Object.keys(metadata.entries).some((entry) => entry.includes('bt6-fixture-skill-1'))).toBe(true);
    const fortemi = JSON.parse(await readFile(path.join(project, '.aiwg', '.index', 'fortemi-core', 'project', 'manifest.json'), 'utf8'));
    expect(fortemi.graph).toBe('project');
    expect(fortemi.item_count).toBeGreaterThanOrEqual(11);
  }, 180_000);

  it('installs an external wrapper globally without leaving project provider artifacts and refreshes user indices (#2008)', async () => {
    const project = path.join(tempRoot, 'global-scope-project');
    await createExternalPluginProject(project);
    const deployed = await runCli([
      'use', 'bt6-maintainer', '--provider', 'claude', '--global', '--target', project,
    ], project);
    expect(deployed.code, `${deployed.stdout}\n${deployed.stderr}`).toBe(0);
    await expect(readdir(path.join(project, '.claude', 'agents'))).rejects.toThrow();
    expect(await listFixtureEntries(path.join(home, '.claude', 'agents'))).toHaveLength(5);
    expect(await listFixtureEntries(path.join(home, '.claude', 'skills'))).toHaveLength(5);
    expect(await listFixtureEntries(path.join(home, '.claude', 'rules'))).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(home, '.aiwg', 'plugins', 'bt6-maintainer', 'manifest.json'), 'utf8')).id).toBe('bt6-maintainer');

    const userIndexRoot = path.join(home, '.local', 'share', 'aiwg', 'index');
    const metadata = JSON.parse(await readFile(path.join(userIndexRoot, 'user', 'metadata.json'), 'utf8'));
    expect(Object.keys(metadata.entries).some((entry) => entry.includes('bt6-fixture-skill-1'))).toBe(true);
    const fortemi = JSON.parse(await readFile(path.join(userIndexRoot, 'fortemi-core', 'user', 'manifest.json'), 'utf8'));
    expect(fortemi.graph).toBe('user');
    expect(fortemi.item_count).toBeGreaterThanOrEqual(11);
  }, 180_000);

  it('reports an actionable provider declaration error for external wrappers (#2008)', async () => {
    const project = path.join(tempRoot, 'unsupported-provider-project');
    await createExternalPluginProject(project, { claude: 'full' });
    const deployed = await runCli([
      'use', 'bt6-maintainer', '--provider', 'codex', '--scope', 'project', '--target', project,
    ], project);
    expect(deployed.code).toBe(1);
    expect(`${deployed.stdout}\n${deployed.stderr}`).toContain("does not declare support for provider 'codex'");
    expect(`${deployed.stdout}\n${deployed.stderr}`).toContain('Declared providers: claude');
  });
});
