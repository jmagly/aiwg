import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverGrokBuildModels,
  parseGrokBuildModelConfig,
  resolveGrokBuildRoleModel,
} from '../../../src/models/grok-build-models.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-grok-models-'));
  roots.push(root);
  const home = join(root, 'custom-home');
  const project = join(root, 'project');
  await mkdir(join(project, '.grok'), { recursive: true });
  await mkdir(home, { recursive: true });
  const user = join(home, 'config.toml');
  const managed = join(home, 'managed_config.toml');
  const requirement = join(home, 'requirements.toml');
  const projectConfig = join(project, '.grok/config.toml');
  const layers = [
    { role: 'managed', path: managed },
    { role: 'user', path: user },
    { role: 'project', path: projectConfig },
    { role: 'requirements', path: requirement },
  ];
  return { root, home, project, user, managed, requirement, projectConfig, layers };
}

describe('Grok Build model discovery', () => {
  it('keeps runtime-observed default xAI aliases separate from API model IDs', async () => {
    const catalog = await discoverGrokBuildModels({ inspectReport: {
      configSources: { layers: [] },
      models: [{ id: 'grok-build', name: 'Built-in coding', isDefault: true }, { id: 'grok-4.7', name: 'Built-in search' }],
    } });
    expect(catalog.models.map(model => model.alias)).toEqual(['grok-build', 'grok-4.7']);
    expect(catalog.models.every(model => model.apiModelId === undefined)).toBe(true);
    expect(resolveGrokBuildRoleModel(catalog, 'coding').source).toBe('unresolved');
  });

  it('honors GROK_HOME, scope restrictions, managed defaults, requirements pins and safe aliases', async () => {
    const f = await fixture();
    await writeFile(f.managed, '[models]\ndefault = "managed"\n[model.managed]\nmodel = "api-managed"\n');
    await writeFile(f.user, '[models]\ndefault = "personal"\n[model.personal]\nmodel = "api-personal"\nenv_key = "PRIVATE_API_KEY"\nextra_headers = { "Authorization" = "Bearer secret-header" }\nbase_url = "https://secret-endpoint.invalid/v1"\ncontext_window = 100000\n');
    await writeFile(f.projectConfig, '[models]\ndefault = "project-malicious"\n[model.project-malicious]\nmodel = "api-project"\n');
    await writeFile(f.requirement, '[models]\ndefault = "personal"\nallowed_models = ["personal"]\n');
    const catalog = await discoverGrokBuildModels({
      cwd: f.project,
      env: { PATH: '/missing', HOME: f.root, GROK_HOME: f.home, GROK_DEFAULT_MODEL: 'environment', PRIVATE_API_KEY: 'secret-env' },
      inspectReport: { configSources: { layers: f.layers } },
    });
    expect(catalog.models.map(model => model.id)).toEqual(['personal']);
    expect(catalog.models[0]).toMatchObject({ alias: 'personal', apiModelId: 'api-personal', isDefault: true, credentialState: 'available', capabilities: ['context:100000', 'custom-endpoint', 'header:Authorization'] });
    expect(catalog.policy?.selected['model.personal.model']).toMatchObject({ value: 'api-personal', scope: 'user' });
    expect(catalog.policy?.selected['models.default']).toMatchObject({ value: 'personal', scope: 'requirements', constraint: 'pin' });
    expect(catalog.policy?.constraints.map(entry => entry.key)).toEqual(['models.default', 'models.allowed_models']);
    expect(catalog.policy?.diagnostics).toEqual(expect.arrayContaining([expect.stringContaining('project scope does not allow')]));
    const output = JSON.stringify(catalog);
    for (const secret of ['secret-env', 'secret-header', 'secret-endpoint.invalid']) expect(output).not.toContain(secret);
    expect(await readFile(f.projectConfig, 'utf8')).toContain('project-malicious');
  });

  it('uses inspect as the primary model list and bounded TOML only for missing model fields', async () => {
    const f = await fixture();
    await writeFile(f.user, '[model.my-local]\nmodel = "real-api-id"\nenv_key = "MISSING_KEY"\n');
    const calls: string[][] = [];
    const runner = async (_command: string, args: string[]) => {
      calls.push(args);
      return args.includes('--version')
        ? { stdout: 'grok 1.0.38', stderr: '', exitCode: 0 }
        : { stdout: JSON.stringify({ configSources: { layers: [{ role: 'user', path: f.user }] }, models: [{ alias: 'native-default', name: 'Native default' }] }), stderr: '', exitCode: 0 };
    };
    const catalog = await discoverGrokBuildModels({ runner, cwd: f.project, env: { HOME: f.root, GROK_HOME: f.home } });
    expect(calls).toEqual([['--version'], ['inspect', '--json']]);
    expect(catalog.models.map(model => model.id)).toEqual(['native-default', 'my-local']);
    expect(catalog.models[1]).toMatchObject({ credentialState: 'unavailable' });
    expect(catalog.runtimeVersion).toBe('grok 1.0.38');
  });

  it('handles env overlays and rejects inspect version drift without exposing secrets', async () => {
    const f = await fixture();
    await writeFile(f.user, '[models]\ndefault = "first"\n[model.first]\nmodel = "api-first"\n[model.second]\nmodel = "api-second"\n');
    const catalog = await discoverGrokBuildModels({
      env: { HOME: f.root, GROK_HOME: f.home, GROK_CONFIG: '{"models":{"default":"second"},"api_key":"secret-json"}' },
      inspectReport: { configSources: { layers: [
        { role: 'user', path: f.user }, { role: 'env_overlay', path: '$GROK_CONFIG (inline)' },
      ] } },
    });
    expect(catalog.policy?.selected['models.default']).toMatchObject({ value: 'second', scope: 'env_overlay' });
    expect(JSON.stringify(catalog)).not.toContain('secret-json');
    const drift = await discoverGrokBuildModels({ inspectReport: { futureConfig: { layers: [] } } });
    expect(drift.errorKind).toBe('invalid-output');
    expect(drift.error).toContain('omitted configSources');
    const error = await discoverGrokBuildModels({ env: { XAI_API_KEY: 'key-secret' }, runner: async () =>
      ({ stdout: '', stderr: 'Authorization: Bearer token-secret api_key=key-secret', exitCode: 1 }) });
    expect(JSON.stringify(error)).not.toMatch(/key-secret|token-secret/);
  });

  it('resolves project roles and explicit overrides without invented xAI ids', async () => {
    const f = await fixture();
    await writeFile(f.user, '[models]\ndefault = "only"\n');
    const catalog = await discoverGrokBuildModels({ inspectReport: { configSources: { layers: [{ role: 'user', path: f.user }] } } });
    expect(resolveGrokBuildRoleModel(catalog, 'coding')).toMatchObject({ model: 'only', source: 'single-model-fallback' });
    expect(resolveGrokBuildRoleModel(catalog, 'reasoning', { reasoning: 'only' })).toMatchObject({ model: 'only', source: 'project-policy' });
    expect(resolveGrokBuildRoleModel(catalog, 'coding', {}, 'only')).toMatchObject({ model: 'only', source: 'explicit' });
    const invalid = resolveGrokBuildRoleModel(catalog, 'coding', { coding: 'grok-4.6' });
    expect(invalid.source).toBe('unresolved');
    expect(invalid.model).toBeUndefined();
    expect(invalid.diagnostic).toContain('unavailable');
    const empty = await discoverGrokBuildModels({ inspectReport: { configSources: { layers: [{ role: 'user', path: join(f.home, 'missing.toml') }] } } });
    expect(empty.errorKind).toBe('invalid-output');
    expect(empty.models).toEqual([]);
  });

  it('does not parse project models even when a valid user alias exists', () => {
    const parsed = parseGrokBuildModelConfig('[models]\ndefault = "bad"\n[model."stolen"]\napi_key = "secret"', 'project');
    expect(parsed.models.size).toBe(0);
    expect(parsed.defaultModel).toBeUndefined();
    expect(parsed.projectModelFields).toBe(true);
  });
});
