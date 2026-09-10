import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCliPackage } from '../../tools/release/build-cli-package.mjs';
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
      !key.toLowerCase().startsWith('npm_config_') && key !== 'AIWG_ROOT' && key !== 'AIWG_CONFIG'),
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

async function writeJson(filename: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

async function createExternalPluginProject(
  project: string,
  platforms: Record<string, 'full' | 'partial' | 'experimental' | 'none'> = { claude: 'full', codex: 'full' },
): Promise<string> {
  const wrapper = path.join(project, '.aiwg', 'plugins', 'bt6-maintainer');
  const payload = path.join(wrapper, 'payload');
  await writeJson(path.join(wrapper, 'manifest.json'), {
    id: 'bt6-maintainer',
    type: 'plugin',
    name: 'BT6 Maintainer',
    version: '0.2.0',
    description: 'External plugin fixture for packed CLI deployment',
    manifestVersion: '1',
    platforms,
    keywords: ['bt6', 'maintainer'],
    deployment: { pathTemplate: '.aiwg/plugins/bt6-maintainer' },
    pluginConfig: { payloadType: 'addon', payloadPath: 'payload/' },
  });
  await writeJson(path.join(payload, 'manifest.json'), {
    id: 'bt6-maintainer-core',
    type: 'addon',
    name: 'BT6 Maintainer Core',
    version: '0.2.0',
    description: 'Payload for the BT6 Maintainer external plugin fixture',
    manifestVersion: '1',
    platforms,
    keywords: ['bt6', 'maintainer'],
    deployment: { pathTemplate: '.aiwg/addons/bt6-maintainer-core' },
    addonConfig: { entry: { agents: 'agents/', skills: 'skills/', rules: 'rules/' } },
  });
  for (let index = 1; index <= 5; index += 1) {
    const agentName = `bt6-fixture-agent-${index}`;
    await mkdir(path.join(payload, 'agents'), { recursive: true });
    await writeFile(
      path.join(payload, 'agents', `${agentName}.md`),
      `---\nname: ${agentName}\ndescription: Packed CLI fixture agent ${index}\nmodel: claude-sonnet-4-6\ntools: Read, Bash\n---\n\n# ${agentName}\n`,
    );
    const skillName = `bt6-fixture-skill-${index}`;
    await mkdir(path.join(payload, 'skills', skillName), { recursive: true });
    await writeFile(
      path.join(payload, 'skills', skillName, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: Packed CLI fixture skill ${index}\n---\n\n# ${skillName}\n`,
    );
  }
  await mkdir(path.join(payload, 'rules'), { recursive: true });
  await writeFile(
    path.join(payload, 'rules', 'bt6-fixture-rule.md'),
    '---\nid: bt6-fixture-rule\nname: bt6-fixture-rule\n---\n\n# BT6 fixture rule\n',
  );
  return wrapper;
}

async function listFixtureEntries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.startsWith('bt6-fixture-')).sort();
}

async function listRelativeFiles(directory: string, relative = ''): Promise<string[]> {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryRelative = path.join(relative, entry.name);
    return entry.isDirectory()
      ? listRelativeFiles(directory, entryRelative)
      : [entryRelative];
  }));
  return files.flat().sort();
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function runApi(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const requireFromPrefix = createRequire(path.join(path.dirname(installRoot), 'api-probe.mjs'));
  const entry = requireFromPrefix.resolve('@aiwg/cli');
  const script = [
    `const api = await import(${JSON.stringify(entry)});`,
    `await api.run(${JSON.stringify(args)}, { cwd: ${JSON.stringify(tempRoot)} });`,
    `process.exit(0);`,
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: tempRoot,
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

describe('@aiwg/cli packaged web distribution', () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aiwg-cli-package-'));
    const stage = path.join(tempRoot, 'stage');
    await buildCliPackage({ outputDir: stage });

    const pack = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', stage, '--ignore-scripts', '--json', '--pack-destination', tempRoot],
      { cwd: PROJECT_ROOT, env: isolatedNpmEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (pack.status !== 0) throw new Error(pack.stderr || pack.stdout);
    const packed = JSON.parse(pack.stdout) as Array<typeof packMetadata & { filename: string }>;
    packMetadata = packed[0]!;

    const prefix = path.join(tempRoot, 'prefix');
    const installArgs = [
        'install', '--prefix', prefix,
        '--cache', path.join(tempRoot, 'npm-cache'),
        '--min-release-age=7', '--ignore-scripts', '--no-audit', '--no-fund',
        path.join(tempRoot, packed[0]!.filename),
    ];
    // Probe the same options that will reach npm, not the repository's ambient config.
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
    expect(paths.filter((entry) => entry.startsWith('agentic/')).every(
      (entry) => entry.startsWith('agentic/code/providers/'),
    )).toBe(true);
    const allowedToolPrefixes = [
      'tools/_resolve-impl.mjs',
      'tools/agents/deploy-agents.mjs',
      'tools/agents/providers/',
      'tools/providers/antigravity-transport.mjs',
      'tools/commands/deploy-prompts-codex.mjs',
      'tools/plugin/package-plugins.mjs',
      'tools/skills/deploy-skills-codex.mjs',
    ];
    expect(paths.filter((entry) => entry.startsWith('tools/')).every(
      (entry) => allowedToolPrefixes.some((allowed) => entry === allowed || entry.startsWith(allowed)),
    )).toBe(true);
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
    expect(paths).toContain('tools/agents/deploy-agents.mjs');
    expect(paths).toContain('tools/agents/providers/antigravity.mjs');
    expect(paths).toContain('tools/providers/antigravity-transport.mjs');
    expect(paths).toContain('agentic/code/providers/antigravity/provider-contract.v1.json');
    expect(paths).toContain('tools/plugin/package-plugins.mjs');
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
    expect(Buffer.from(shown.stdout)).toEqual(TEST_SKILL_BODY);
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
