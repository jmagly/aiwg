// Exercise legacy Antigravity upgrades through the source CLI and compiled public router.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareAntigravityConfig } from '../../../src/mcp/antigravity-config.mjs';

const sourceCli = resolve('src/mcp/cli.mjs');
const router = pathToFileURL(resolve('dist/src/cli/router.js')).href;
const remoteUrl = 'https://mcp.example.invalid/mcp';
let root: string;
let project: string;
let legacyPath: string;
let pluginDir: string;
let original: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-antigravity-cli-upgrade-'));
  project = join(root, 'project');
  legacyPath = join(project, '.agents/mcp_config.json');
  pluginDir = join(project, '.agents/plugins/aiwg');
  for (const dir of [join(project, '.agents'), join(root, 'home'), join(root, 'config')]) {
    mkdirSync(dir, { recursive: true });
  }
  original = JSON.stringify({ mcpServers: {
    uatremote: { serverUrl: remoteUrl },
    operatorOwn: { command: 'my-tool' },
  }, operatorSetting: { keep: true } }, null, 4) + '\n';
  writeFileSync(legacyPath, original);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

it('refuses to use the legacy config as an injection destination', async () => {
  await expect(prepareAntigravityConfig('antigravity', legacyPath, {}, { projectDir: project }))
    .rejects.toThrow('legacy config is migration input only');
  expect(readFileSync(legacyPath, 'utf8')).toBe(original);
  expect(existsSync(pluginDir)).toBe(false);
});

describe.each(['source CLI', 'compiled router'])('%s Antigravity legacy upgrade', entry => {
  function cli(args: string[]) {
    const argv = entry === 'source CLI' ? [sourceCli, ...args] : [
      '--input-type=module', '--eval',
      `import { run } from ${JSON.stringify(router)}; await run(['mcp', ...process.argv.slice(1)]); process.exit(process.exitCode ?? 0);`,
      ...args,
    ];
    const result = spawnSync(process.execPath, argv, {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: join(root, 'home'), AIWG_CONFIG: join(root, 'config'),
        XDG_CACHE_HOME: join(root, 'cache'), TMPDIR: root, NO_UPDATE_NOTIFIER: '1' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result;
  }

  it.each(['antigravity', 'agy', '--all'])('migrates the released layout for %s and retains operator data byte for byte', provider => {
    cli(['add', 'uatremote', '--url', remoteUrl, '--transport', 'http']);
    // The released injector records this alongside its legacy project config.
    const registryPath = join(root, 'config/mcp-servers.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.servers.uatremote.injectedProviders = ['antigravity'];
    writeFileSync(registryPath, JSON.stringify(registry));
    const target = provider === '--all' ? ['--all'] : ['--provider', provider];
    const inject = () => cli(['inject', ...target, '--project', project]);
    const first = inject();
    expect(first.stdout).toContain(join(pluginDir, 'mcp_config.json'));
    expect(first.stderr).toContain('legacy file is retained unchanged');
    expect(first.stderr).toContain('Restart agy');
    expect(JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'))).toEqual({ name: 'aiwg' });
    expect(JSON.parse(readFileSync(join(pluginDir, 'mcp_config.json'), 'utf8'))).toEqual({
      mcpServers: { uatremote: { url: remoteUrl }, operatorOwn: { command: 'my-tool' } },
      operatorSetting: { keep: true },
    });
    expect(readFileSync(legacyPath, 'utf8')).toBe(original);
    expect(existsSync(join(project, '.agents/plugin.json'))).toBe(false);

    const migrated = readFileSync(join(pluginDir, 'mcp_config.json'));
    inject();
    expect(readFileSync(join(pluginDir, 'mcp_config.json'))).toEqual(migrated);
    expect(readFileSync(legacyPath, 'utf8')).toBe(original);
  });

  it('previews migration at the plugin target without modifying the released layout', () => {
    cli(['add', 'uatremote', '--url', remoteUrl, '--transport', 'http']);
    const result = cli(['inject', '--provider', 'antigravity', '--project', project, '--dry-run']);
    expect(result.stdout).toContain(join(pluginDir, 'mcp_config.json'));
    expect(result.stderr).toContain('legacy file is retained unchanged');
    expect(existsSync(pluginDir)).toBe(false);
    expect(readFileSync(legacyPath, 'utf8')).toBe(original);
  });
});
