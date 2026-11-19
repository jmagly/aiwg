import { writeExecutable } from '../../../helpers/write-executable.js';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as discovery from '../../../../src/models/model-discovery.js';
import * as inventory from '../../../../src/providers/provider-inventory.js';
import { workerResolutionFixture } from '../../../fixtures/worker-resolution.js';
import { modelsHandler } from '../../../../src/cli/handlers/models.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-models-'));
  roots.push(root);
  const agent = path.join(root, 'agentic/code/frameworks/demo/agents/reviewer.md');
  const skill = path.join(root, 'agentic/code/frameworks/demo/skills/check/SKILL.md');
  await mkdir(path.dirname(agent), { recursive: true });
  await mkdir(path.dirname(skill), { recursive: true });
  await writeFile(agent, `---
name: reviewer
description: Review
model: opus
---
Review.
`);
  await writeFile(skill, `---
name: check
description: Check
commandHint:
  model: haiku
---
Check.
`);
  return { root, agent, skill };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function run(root: string, args: string[]) {
  return modelsHandler.execute({
    args, rawArgs: ['models', ...args], cwd: root, frameworkRoot: root,
  });
}

describe('models CLI handler', () => {
  it.each(['aiwg-model-reasoning-worker', 'aiwg-model-coding-worker', 'aiwg-model-efficiency-worker',
    'aiwg-model-explorer', 'aiwg-model-verifier'])('resolves built-in Muse wrapper %s outside the source checkout (#4325)', async agent => {
    const { root } = await fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await run(root, ['resolve', '--agent', agent, '--provider', 'muse', '--tier', 'standard', '--json'])).exitCode).toBe(0);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ name: agent, policy: { tier: 'standard' },
      compiled: { effectiveModel: 'muse-spark-1.3', outcome: 'unsupported', fields: {} } });
    log.mockClear();
    expect((await run(root, ['resolve', '--agent', agent, '--provider', 'muse', '--tier', 'standard'])).exitCode).toBe(0);
    expect(log.mock.calls.map(call => call.join(' ')).join('\n')).toContain('muse-spark-1.3');
  });

  it('uses the requested tier for a Muse wrapper found in source and leaves its bytes unchanged (#4325)', async () => {
    const { root, agent } = await fixture();
    const wrapperFile = path.join(path.dirname(agent), 'aiwg-model-reasoning-worker.md');
    const original = '---\nmodel-role: reasoning\nmodel-tier: premium\n---\n';
    await writeFile(wrapperFile, original);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(root, ['resolve', '--agent', 'aiwg-model-reasoning-worker', '--provider', 'muse', '--tier', 'standard', '--json']);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject([
      { policy: { tier: 'standard', role: 'reasoning' }, compiled: { effectiveModel: 'muse-spark-1.3' } },
    ]);
    await run(root, ['resolve', '--agent', 'aiwg-model-reasoning-worker', '--provider', 'muse', '--json']);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))[0].policy.tier).toBe('premium');
    expect(await readFile(wrapperFile, 'utf8')).toBe(original);
    await run(root, ['resolve', '--agent', 'missing-worker', '--provider', 'muse', '--json']);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual([]);
    await run(root, ['resolve', '--agent', 'aiwg-model-coding-worker', '--provider', 'claude', '--json']);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual([]);
  });

  it.each(['success', 'partial', 'failure'] as const)(
    'T-OG-02/12 refresh preserves preference bytes after %s discovery', async outcome => {
      const { root, agent, skill } = await fixture();
      const home = path.join(root, 'home');
      vi.stubEnv('HOME', home);
      vi.stubEnv('AIWG_CONFIG', path.join(home, '.config/aiwg'));
      const f = workerResolutionFixture();
      const userFile = path.join(home, '.config/aiwg/models.json');
      const projectFile = path.join(root, 'models.json');
      const groupsFile = path.join(root, '.aiwg/aiwg.config');
      const staticFile = path.join(root, 'agentic/code/providers/model-catalog.v1.json');
      const cacheFile = path.join(home, '.cache/aiwg/model-catalog.v1.json');
      for (const file of [userFile, groupsFile, staticFile]) {
        await mkdir(path.dirname(file), { recursive: true });
      }
      for (const [file, tier, pin] of [
        [userFile, 'economy', 'user-exact-pin'], [projectFile, 'premium', 'project-exact-pin'],
      ]) {
        await writeFile(file, JSON.stringify({ defaults: { provider: 'codex', tier,
          workerSelection: f.projectPolicy }, agentOverrides: {
          'aiwg-model-coding-worker': { 'model-override': pin },
        } }, null, '\t') + '\n\n');
      }
      await writeFile(groupsFile, JSON.stringify(f.snapshot.config, null, 4) + '\n');
      const staticCatalog = { version: '1.0.0', providers: {
        codex: { roles: { coding: { id: 'static-pin' } } },
      } };
      await writeFile(staticFile, JSON.stringify(staticCatalog));
      const files = [userFile, projectFile, groupsFile, agent, skill, staticFile];
      const before = await Promise.all(files.map(file => readFile(file)));
      vi.spyOn(inventory, 'collectProviderInventory').mockResolvedValue({
        generatedAt: f.request.now, projectDir: root, activeProvider: 'codex', activeSource: 'env',
        providers: ['codex', 'pi'].map(id => ({ id, displayName: id, available: true,
          active: id === 'codex', configured: true, deployed: true, detected: true, evidence: [], reasons: [],
        })),
      });
      const fakeSource = (provider: string) => vi.fn(async () => {
        if (outcome === 'failure' || (outcome === 'partial' && provider === 'pi')) {
          throw new Error('synthetic catalog unavailable');
        }
        return { provider, source: 'native' as const, observedAt: f.request.now,
          accountScope: 'synthetic', models: [{ id: `new-${provider}-model` }] };
      });
      const nativeDiscoverers = { codex: fakeSource('codex'), pi: fakeSource('pi') };
      const fetchImpl = vi.fn(async () => {
        if (outcome === 'failure') throw new Error('synthetic remote unavailable');
        return new Response(JSON.stringify(staticCatalog));
      });
      const resolveCatalog = discovery.resolveDynamicModelCatalog;
      const refresh = vi.spyOn(discovery, 'resolveDynamicModelCatalog').mockImplementation(options =>
        resolveCatalog({ ...options, homeDir: home, nativeDiscoverers, fetchImpl,
          now: () => new Date(f.request.now) }));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect((await run(root, ['refresh', '--url', 'https://catalog.invalid/models', '--json'])).exitCode).toBe(0);
      expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ allowNetwork: true, forceRefresh: true }));
      expect(fetchImpl).toHaveBeenCalledOnce();
      for (const source of Object.values(nativeDiscoverers)) expect(source).toHaveBeenCalledOnce();
      const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(output.discovery.source).toBe(outcome === 'failure' ? 'static' : 'remote');
      expect(output.discovery.providers.codex).toMatchObject(outcome === 'failure'
        ? { models: [], error: 'synthetic catalog unavailable' }
        : { models: [{ id: 'new-codex-model' }] });
      expect(output.discovery.providers.pi).toMatchObject(outcome === 'success'
        ? { models: [{ id: 'new-pi-model' }] } : { models: [], error: 'synthetic catalog unavailable' });
      expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toEqual(output);
      for (let i = 0; i < files.length; i++) expect(await readFile(files[i]), files[i]).toEqual(before[i]);
    },
  );

  it('lists and resolves exact skill policy without mutation', async () => {
    const { root, skill } = await fixture();
    const before = await readFile(skill, 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await run(root, ['resolve', '--skill', 'check', '--provider', 'codex', '--json'])).exitCode)
      .toBe(0);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(output).toHaveLength(1);
    expect(output[0].policy).toMatchObject({ role: 'efficiency', tier: 'economy' });
    expect(output[0].compiled.outcome).toBe('unsupported');
    expect(await readFile(skill, 'utf8')).toBe(before);
  });

  it('supports dry-run and atomic selected skill updates', async () => {
    const { root, skill } = await fixture();
    const before = await readFile(skill, 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await run(root, [
      'set', '--skill', 'check', '--tier', 'premium', '--provider', 'codex', '--dry-run',
    ])).exitCode)
      .toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain('unsupported');
    expect(await readFile(skill, 'utf8')).toBe(before);
    expect((await run(root, ['set', '--skill', 'check', '--tier', 'premium'])).exitCode)
      .toBe(0);
    expect(await readFile(skill, 'utf8')).toContain('modelTier: premium');
  });

  it('migrates legacy skill hints and preserves unrelated content', async () => {
    const { root, skill } = await fixture();
    expect((await run(root, ['migrate', '--all'])).exitCode).toBe(0);
    const output = await readFile(skill, 'utf8');
    expect(output).toContain('model: haiku');
    expect(output).toContain('modelRole: efficiency');
    expect(output).toContain('modelTier: economy');
    expect(output).toContain('description: Check');
    expect((await run(root, ['migrate', '--all'])).exitCode).toBe(0);
    expect(await readFile(skill, 'utf8')).toBe(output);
  });

  it('round-trips project defaults and rejects invalid mutation before writes', async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, 'models.json'), JSON.stringify({
      description: 'operator content',
      providers: { custom: { coding: 'local/model' } },
    }));
    expect((await run(root, ['set-default', 'economy'])).exitCode).toBe(0);
    const config = JSON.parse(await readFile(path.join(root, 'models.json'), 'utf8'));
    expect(config.defaults.tier).toBe('economy');
    expect(config.description).toBe('operator content');
    expect(config.providers.custom.coding).toBe('local/model');
    expect((await run(root, ['set', '--all', '--tier', 'invalid'])).exitCode).toBe(2);
  });

  it('reports Grok Build source precedence and resolved project roles without leaking credentials', async () => {
    const { root } = await fixture();
    const home = path.join(root, 'grok-home');
    const bin = path.join(root, 'bin');
    await mkdir(home, { recursive: true });
    await mkdir(bin, { recursive: true });
    const config = path.join(home, 'config.toml');
    await writeFile(config, '[model.local]\nmodel = "actual-backend-id"\nenv_key = "TEST_GROK_API_KEY"\nextra_headers = { Authorization = "secret-config-value" }\n[models]\ndefault = "local"\n');
    const executable = path.join(bin, 'grok');
    await writeExecutable(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'grok 1.0.38'; else printf '%s\\n' '{"configSources":{"layers":[{"role":"user","path":"${config}"}]}}'; fi\n`);
    await writeFile(path.join(root, 'models.json'), JSON.stringify({ providers: { 'grok-build': { efficiency: 'local' } } }));
    const previous = { PATH: process.env.PATH, GROK_HOME: process.env.GROK_HOME, TEST_GROK_API_KEY: process.env.TEST_GROK_API_KEY };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.env.PATH = `${bin}:${previous.PATH ?? ''}`;
      process.env.GROK_HOME = home;
      process.env.TEST_GROK_API_KEY = 'secret-env-value';
      expect((await run(root, ['sources', '--provider', 'grok-build', '--json'])).exitCode).toBe(0);
      const sources = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(sources.discovery.providers['grok-build'].policy.selected['models.default']).toMatchObject({ scope: 'user', value: 'local' });
      expect((await run(root, ['resolve', '--skill', 'check', '--provider', 'grok-build', '--json'])).exitCode).toBe(0);
      const resolved = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(resolved[0].providerResolution).toMatchObject({ source: 'project-policy', model: 'local' });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret-config-value|secret-env-value/);
      expect(sources.discovery.providers['grok-build'].models[0]).toMatchObject({ id: 'local', apiModelId: 'actual-backend-id' });
      expect((await run(root, ['audit', '--skill', 'check', '--provider', 'grok-build', '--model', 'missing', '--json'])).exitCode).toBe(2);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))[0].providerResolution.diagnostic).toContain('unavailable');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});
