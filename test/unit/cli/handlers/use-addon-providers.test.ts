// Exercise provider selection, deployment, and install state with synthetic bundles.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyConfig, readAiwgConfig, writeAiwgConfig } from '../../../../src/config/aiwg-config.js';
import * as ui from '../../../../src/cli/ui.js';

const repo = resolve(import.meta.dirname, '../../../..');
vi.mock('os', async original => {
  const actual = await original<typeof import('node:os')>();
  const homedir = () => process.env.HOME!;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  const homedir = () => process.env.HOME!;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('../../../../src/channel/manager.mjs', () => ({
  getVersionInfo: async () => ({ version: 'test', devMode: true }),
}));


function write(root: string, file: string, text: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

const providers = ['claude', 'codex', 'muse'];
let root: string, project: string, source: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-addon-providers-'));
  project = join(root, 'project');
  source = join(root, 'source');
  mkdirSync(project);
  for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'AIWG_CONFIG']) {
    const directory = join(root, name.toLowerCase());
    mkdirSync(directory);
    vi.stubEnv(name, directory);
  }
  for (const name of ['AIWG_ROOT', 'AIWG_HOME', 'AIWG_USER_REGISTRY_PATH', 'CODEX_HOME']) vi.stubEnv(name, undefined);
  mkdirSync(join(source, 'agentic/code/frameworks'), { recursive: true });
  const deployer = join(source, 'tools/agents/deploy-agents.mjs');
  mkdirSync(dirname(deployer), { recursive: true });
  copyFileSync(join(repo, 'test/fixtures/cli/addon-provider-deployer.mjs'), deployer);
  write(source, 'package.json', JSON.stringify({ version: '1.0.0' }));
  write(source, 'agentic/code/providers/model-catalog.v1.json', JSON.stringify({
    version: '1.0.0', refreshedAt: '2026-10-12',
    providers: Object.fromEntries(providers.map(provider => [provider, { roles: {} }])),
  }));
  for (const [kind, id] of [['addons', 'decision-engine'], ['extensions', 'probe-extension']]) {
    const bundle = `agentic/code/${kind}/${id}`;
    write(source, `${bundle}/manifest.json`, JSON.stringify({ id, version: '1.0.0' }));
    write(source, `${bundle}/skills/${id}-probe/SKILL.md`,
      `---\nname: ${id}-probe\nnamespace: aiwg\nplatforms: [all]\nkernel: true\ndescription: synthetic probe\n---\n\nProbe.\n`);
  }
  await writeAiwgConfig(project, emptyConfig(providers));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function deploy(bundle: string, options: string[] = []) {
  vi.resetModules();
  const { UseHandler } = await import('../../../../src/cli/handlers/use.js');
  const args = [bundle, '--target', project, ...options, '--json'];
  const result = await new UseHandler().execute({ cwd: project, frameworkRoot: source, rawArgs: ['use', ...args], args });
  expect(result.exitCode, result.message).toBe(0);
  const payload = JSON.parse(result.message!);
  expect(payload.outcome).not.toBe('failed');
  return payload;
}

function expectSkill(bundle: string, provider: string) {
  const base = provider === 'claude' ? '.claude/skills' : '.agents/skills';
  const skill = `${base}/${bundle}-probe/SKILL.md`;
  expect(existsSync(join(project, skill)), `${provider}: ${skill}`).toBe(true);
}

describe('bundled addon provider set (#3661)', () => {
  it.each(['decision-engine', 'probe-extension'])('deploys and records every configured provider for %s', async bundle => {
    const payload = await deploy(bundle);
    expect(payload.providers.map((entry: { provider: string }) => entry.provider)).toEqual(providers);
    const config = (await readAiwgConfig(project))!;
    expect(Object.keys(config.installed[bundle].deployedTo).sort()).toEqual([...providers].sort());
    expect(config.providers).toEqual(providers);
    for (const provider of providers) {
      expect(config.installed[bundle].deployedTo[provider].skills).toBe(1);
      expectSkill(bundle, provider);
    }
  });

  it('keeps explicit --provider deployment and state limited to one provider', async () => {
    const payload = await deploy('decision-engine', ['--provider', 'codex']);
    expect(payload.providers.map((entry: { provider: string }) => entry.provider)).toEqual(['codex']);
    const config = (await readAiwgConfig(project))!;
    expect(Object.keys(config.installed['decision-engine'].deployedTo)).toEqual(['codex']);
    expectSkill('decision-engine', 'codex');
    expect(existsSync(join(project, '.claude/skills/decision-engine-probe/SKILL.md'))).toBe(false);
  });

  it('honors the existing --providers selector for addon deployment and state', async () => {
    const payload = await deploy('decision-engine', ['--providers', 'claude,muse']);
    expect(payload.providers.map((entry: { provider: string }) => entry.provider)).toEqual(['claude', 'muse']);
    expect(Object.keys((await readAiwgConfig(project))!.installed['decision-engine'].deployedTo)).toEqual(['claude', 'muse']);
  });

  it('bootstraps a comma list through --providers as separate providers (#3958)', async () => {
    rmSync(join(project, '.aiwg'), { recursive: true, force: true });
    const payload = await deploy('decision-engine', ['--providers', 'claude,codex,muse']);
    expect(payload.providers.map((entry: { provider: string }) => entry.provider)).toEqual(providers);
    const config = (await readAiwgConfig(project))!;
    expect(config.providers).toEqual(providers);
    expect(Object.keys(config.installed['decision-engine'].deployedTo)).toEqual(providers);
    for (const provider of providers) expectSkill('decision-engine', provider);
  });

  it('previews every provider without writing addon state or skills', async () => {
    const payload = await deploy('decision-engine', ['--dry-run']);
    expect(payload.dryRun).toBe(true);
    expect(payload.providers.map((entry: { provider: string }) => entry.provider)).toEqual(providers);
    expect((await readAiwgConfig(project))!.installed).toEqual({});
    expect(existsSync(join(project, '.agents'))).toBe(false);
    expect(existsSync(join(project, '.claude'))).toBe(false);
  });

  it('prints the message on the ERROR line for a multiline failure', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    ui.error('\nAIWG needs repair\n\nBlocking findings\n    synthetic failure');
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('ERROR AIWG needs repair\n'));
    expect(stderr.mock.calls.flat().join('\n')).not.toMatch(/^\s*ERROR\s*$/m);
  });
});
