import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyDiscoveryError,
  diffModelCatalog,
  discoverOpenClawModels,
  discoverOpenCodeModels,
  discoverPiModels,
  PROVIDER_DISCOVERY_DECISIONS,
  resolveDynamicModelCatalog,
  selectRoleModels,
} from '../../../src/models/model-discovery.js';
import type { ProviderInventory } from '../../../src/providers/provider-inventory.js';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-model-discovery-'));
  roots.push(root);
  const cacheFile = join(root, 'cache/model-catalog.v1.json');
  await mkdir(join(root, 'agentic/code/providers'), { recursive: true });
  const catalog = {
    version: '1.0.0',
    refreshedAt: '2026-07-20',
    providers: {
      codex: { roles: { reasoning: { id: 'static-premium' }, coding: { id: 'static-standard' } } },
      claude: { roles: { reasoning: { id: 'static-opus' } } },
    },
  };
  await writeFile(
    join(root, 'agentic/code/providers/model-catalog.v1.json'),
    JSON.stringify(catalog),
  );
  const inventory: ProviderInventory = {
    generatedAt: new Date(0).toISOString(),
    projectDir: root,
    activeProvider: 'codex',
    activeSource: 'env',
    providers: [
      {
        id: 'codex',
        displayName: 'Codex',
        configured: true,
        deployed: true,
        detected: true,
        available: true,
        active: true,
        evidence: [],
        reasons: [],
      },
      {
        id: 'claude',
        displayName: 'Claude',
        configured: true,
        deployed: false,
        detected: false,
        available: false,
        active: false,
        evidence: [],
        reasons: ['not installed'],
      },
    ],
  };
  return { root, cacheFile, inventory, catalog };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('dynamic model catalog', () => {
  it('records an implemented-or-unsupported decision for every AIWG provider', () => {
    expect(Object.keys(PROVIDER_DISCOVERY_DECISIONS).sort()).toEqual([
      'claude', 'codex', 'copilot', 'cursor', 'factory', 'grok-build', 'grokbot', 'hermes',
      'muse', 'omp', 'openclaw', 'opencode', 'openhuman', 'pi', 'warp', 'windsurf',
    ]);
    expect(Object.values(PROVIDER_DISCOVERY_DECISIONS).every(decision =>
      decision.reason.length > 0 && decision.documentation.startsWith('https://')
    )).toBe(true);
    expect(Object.values(PROVIDER_DISCOVERY_DECISIONS)
      .filter(decision => decision.status === 'native')
      .map(decision => decision.provider)
      .sort()).toEqual(['codex', 'grok-build', 'omp', 'openclaw', 'opencode', 'pi']);
  });

  it('maps enumerated models to semantic roles without inventing identifiers', () => {
    const models = [
      { id: 'provider/general' },
      { id: 'provider/nemotron-ultra' },
      { id: 'provider/north-mini-code' },
      { id: 'provider/deepseek-flash' },
    ];
    expect(selectRoleModels(models)).toEqual({
      reasoning: models[1],
      coding: models[2],
      efficiency: models[2],
    });
  });

  it('normalizes documented OpenCode model rows with runtime provenance', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: '1.17.3\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: 'anthropic/claude-sonnet-4-6\nopencode/north-mini-code-free\n',
        stderr: '',
        exitCode: 0,
      });
    const result = await discoverOpenCodeModels('opencode', runner);
    expect(result).toMatchObject({
      provider: 'opencode',
      source: 'native',
      runtimeVersion: '1.17.3',
      accountScope: 'local-runtime',
      models: [
        { id: 'anthropic/claude-sonnet-4-6' },
        { id: 'opencode/north-mini-code-free' },
      ],
    });
    expect(runner).toHaveBeenNthCalledWith(
      2,
      'opencode',
      ['models', '--pure'],
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it('normalizes Pi model rows while preserving backend/model identity', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: '0.85.0\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'provider    model                  context\r\nopenrouter  fixture/code:free      32K\r\n', stderr: '', exitCode: 0 });
    expect(await discoverPiModels('pi', runner)).toMatchObject({
      provider: 'pi', runtimeVersion: '0.85.0', models: [{ id: 'openrouter/fixture/code:free' }],
    });
  });

  it('normalizes documented OpenClaw JSON without probing provider APIs', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: 'OpenClaw 2026.6.5\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          count: 2,
          models: [
            { key: 'openai/gpt-5.5', name: 'gpt-5.5', tags: ['default'] },
            { key: 'anthropic/claude-haiku-4-5', name: 'Haiku', tags: [] },
            { key: 'unavailable/not-entitled', available: false, tags: [] },
          ],
        }),
        stderr: '',
        exitCode: 0,
      });
    const result = await discoverOpenClawModels('openclaw', runner);
    expect(result).toMatchObject({
      provider: 'openclaw',
      runtimeVersion: 'OpenClaw 2026.6.5',
      accountScope: 'local-runtime',
      models: [
        { id: 'openai/gpt-5.5', isDefault: true },
        { id: 'anthropic/claude-haiku-4-5', isDefault: false },
      ],
    });
    expect(runner).toHaveBeenNthCalledWith(
      2,
      'openclaw',
      ['models', 'list', '--json'],
      { timeoutMs: 15_000 },
    );
  });

  it('classifies authentication, rate-limit, and unsupported discovery failures', async () => {
    expect(classifyDiscoveryError('HTTP 401 authentication required')).toBe('authentication');
    expect(classifyDiscoveryError('HTTP 429 rate limit exceeded')).toBe('rate-limit');
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: '1.0\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 403 forbidden', exitCode: 1 });
    expect(await discoverOpenCodeModels('opencode', runner)).toMatchObject({
      models: [],
      errorKind: 'authentication',
    });
    const rateLimitedRunner = vi.fn()
      .mockResolvedValueOnce({ stdout: 'OpenClaw 1.0\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'HTTP 429: rate limit exceeded',
        exitCode: 1,
      });
    expect(await discoverOpenClawModels('openclaw', rateLimitedRunner)).toMatchObject({
      models: [],
      errorKind: 'rate-limit',
    });
  });

  it('records an explicit unsupported fallback without treating static rows as observed', async () => {
    const { root, cacheFile, inventory } = await fixture();
    inventory.providers.push({
      id: 'factory',
      displayName: 'Factory',
      configured: true,
      deployed: true,
      detected: true,
      available: true,
      active: false,
      evidence: [],
      reasons: [],
    });
    const resolved = await resolveDynamicModelCatalog({
      aiwgRoot: root,
      cacheFile,
      inventory,
      allowNetwork: true,
      nativeDiscoverers: {},
      now: () => new Date(0),
    });
    expect(resolved.discovery?.providers.factory).toMatchObject({
      provider: 'factory',
      accountScope: 'static',
      errorKind: 'unsupported',
      models: [],
    });
    expect(resolved.discovery?.providers.factory.error).toContain(
      'no documented non-interactive model-list command',
    );
  });

  it('produces a reviewable provider-role drift report', () => {
    const before: any = {
      version: '1',
      providers: { codex: { roles: { coding: { id: 'old' } } } },
    };
    const after: any = {
      version: '2',
      providers: { codex: { roles: { coding: { id: 'new' } } } },
    };
    expect(diffModelCatalog(before, after)).toEqual({
      changed: true,
      providers: {
        codex: [{ role: 'coding', before: 'old', after: 'new' }],
      },
    });
  });

  it('uses static data without network during ordinary reads', async () => {
    const { root, cacheFile, inventory } = await fixture();
    const fetchImpl = vi.fn();
    const resolved = await resolveDynamicModelCatalog({
      aiwgRoot: root,
      cacheFile,
      inventory,
      allowNetwork: false,
      fetchImpl: fetchImpl as any,
      now: () => new Date(0),
    });
    expect(resolved.discovery?.source).toBe('static');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes from a public feed and runs native discovery only for available providers', async () => {
    const { root, cacheFile, inventory } = await fixture();
    const codexDiscovery = vi.fn().mockResolvedValue({
      provider: 'codex',
      source: 'native',
      observedAt: new Date(0).toISOString(),
      accountScope: 'local-account',
      models: [{ id: 'account-model' }],
    });
    const claudeDiscovery = vi.fn();
    const resolved = await resolveDynamicModelCatalog({
      aiwgRoot: root,
      cacheFile,
      inventory,
      allowNetwork: true,
      remoteUrl: 'https://aiwg.example/models.json',
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        version: '2.0.0',
        providers: {
          codex: { roles: { reasoning: { id: 'remote-premium' } } },
        },
      }))),
      nativeDiscoverers: {
        codex: codexDiscovery,
        claude: claudeDiscovery,
      },
      now: () => new Date(0),
    });
    expect(resolved.version).toBe('2.0.0');
    expect(resolved.discovery).toMatchObject({
      source: 'remote',
      remoteUrl: 'https://aiwg.example/models.json',
    });
    expect(resolved.discovery?.providers.codex.models).toEqual([{ id: 'account-model' }]);
    expect(codexDiscovery).toHaveBeenCalledOnce();
    expect(claudeDiscovery).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(cacheFile, 'utf8')).discovery.source).toBe('remote');
  });

  it('records remote failure and preserves the committed catalog deterministically', async () => {
    const { root, cacheFile, inventory } = await fixture();
    inventory.providers.forEach(provider => {
      provider.available = false;
      provider.detected = false;
      provider.active = false;
    });
    const resolved = await resolveDynamicModelCatalog({
      aiwgRoot: root,
      cacheFile,
      inventory,
      allowNetwork: true,
      forceRefresh: true,
      remoteUrl: 'https://catalog.example/model-catalog.v1.json',
      fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 503 })),
      now: () => new Date(0),
    });
    expect(resolved.version).toBe('1.0.0');
    expect(resolved.providers.codex.roles.coding.id).toBe('static-standard');
    expect(resolved.discovery).toMatchObject({
      source: 'static',
      remoteError: 'HTTP 503',
      providers: {},
    });
  });

  it('uses a fresh cache and avoids provider or network probes', async () => {
    const { root, cacheFile, inventory } = await fixture();
    await mkdir(join(root, 'cache'), { recursive: true });
    await writeFile(cacheFile, JSON.stringify({
      version: 'cached',
      providers: {},
      discovery: {
        source: 'remote',
        fetchedAt: '2026-07-20T00:00:00.000Z',
        providers: {},
      },
    }));
    const fetchImpl = vi.fn();
    const native = vi.fn();
    const resolved = await resolveDynamicModelCatalog({
      aiwgRoot: root,
      cacheFile,
      inventory,
      allowNetwork: true,
      fetchImpl: fetchImpl as any,
      nativeDiscoverers: { codex: native },
      now: () => new Date('2026-07-20T01:00:00.000Z'),
    });
    expect(resolved.version).toBe('cached');
    expect(resolved.discovery).toMatchObject({ source: 'cache', upstreamSource: 'remote' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });

  it('forces native refresh from a fresh cache without requiring a public feed', async () => {
    const { root, cacheFile, inventory } = await fixture();
    await mkdir(join(root, 'cache'), { recursive: true });
    await writeFile(cacheFile, JSON.stringify({
      version: 'cached',
      providers: {},
      discovery: {
        source: 'remote',
        fetchedAt: '2026-07-20T00:00:00.000Z',
        providers: {},
      },
    }));
    const fetchImpl = vi.fn();
    const native = vi.fn().mockResolvedValue({
      provider: 'codex',
      source: 'native',
      observedAt: '2026-07-20T01:00:00.000Z',
      accountScope: 'local-account',
      models: [{ id: 'native-default', isDefault: true }],
    });
    const resolved = await resolveDynamicModelCatalog({
      aiwgRoot: root,
      cacheFile,
      inventory,
      allowNetwork: true,
      forceRefresh: true,
      fetchImpl: fetchImpl as any,
      nativeDiscoverers: { codex: native },
      now: () => new Date('2026-07-20T01:00:00.000Z'),
    });
    expect(resolved.version).toBe('1.0.0');
    expect(resolved.discovery?.source).toBe('static');
    expect(resolved.providers.codex.roles.coding).toMatchObject({
      id: 'native-default',
      observed: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledOnce();
  });

  it('invalidates a fresh cache when provider runtime evidence changes', async () => {
    const { root, cacheFile, inventory } = await fixture();
    await mkdir(join(root, 'cache'), { recursive: true });
    await writeFile(cacheFile, JSON.stringify({
      version: 'cached',
      providers: {},
      discovery: {
        source: 'native',
        fetchedAt: '2026-07-20T00:00:00.000Z',
        inventorySignature: 'codex:executable=/old/codex@1',
        providers: {},
      },
    }));
    inventory.providers[0].evidence = [
      { kind: 'executable', scope: 'runtime', value: '/new/codex@2' },
    ];
    const native = vi.fn().mockResolvedValue({
      provider: 'codex',
      source: 'native',
      observedAt: '2026-07-20T01:00:00.000Z',
      accountScope: 'local-account',
      models: [{ id: 'new-runtime-model', isDefault: true }],
    });
    const resolved = await resolveDynamicModelCatalog({
      aiwgRoot: root,
      cacheFile,
      inventory,
      allowNetwork: true,
      nativeDiscoverers: { codex: native },
      now: () => new Date('2026-07-20T01:00:00.000Z'),
    });
    expect(resolved.version).toBe('1.0.0');
    expect(resolved.providers.codex.roles.coding.id).toBe('new-runtime-model');
    expect(native).toHaveBeenCalledOnce();
  });
});

describe('OMP catalog scope isolation', () => {
  it('isolates cache by profile, config overlay and extension discovery mode', async () => {
    const { root, cacheFile, inventory } = await fixture();
    inventory.providers = [{ ...inventory.providers[0], id: 'omp', displayName: 'Oh My Pi' }];
    const catalogFile = join(root, 'agentic/code/providers/model-catalog.v1.json');
    const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
    catalog.providers.omp = { roles: { coding: { id: 'configured/default', observed: false } } };
    await writeFile(catalogFile, JSON.stringify(catalog));
    let probes = 0;
    const nativeDiscoverers = { omp: async () => { probes++; return { provider: 'omp', source: 'native' as const, observedAt: new Date().toISOString(), accountScope: 'local-runtime' as const, models: [{ id: 'fixture/model' }] }; } };
    const base = { aiwgRoot: root, cacheFile, inventory, allowNetwork: true, nativeDiscoverers };
    const first = await resolveDynamicModelCatalog({ ...base, omp: { profile: 'first', config: ['/a.yml'] } });
    expect(first.providers.omp.roles.coding).toEqual({ id: 'configured/default', observed: false });
    expect(first.discovery?.providers.omp.models).toEqual([{ id: 'fixture/model' }]);
    expect(probes).toBe(1);
    expect((await resolveDynamicModelCatalog({ ...base, omp: { profile: 'first', config: ['/a.yml'] } })).discovery?.source).toBe('cache');
    expect(probes).toBe(1);
    await resolveDynamicModelCatalog({ ...base, omp: { profile: 'second', config: ['/a.yml'] } }); expect(probes).toBe(2);
    await resolveDynamicModelCatalog({ ...base, omp: { profile: 'second', config: ['/b.yml'] } }); expect(probes).toBe(3);
    await resolveDynamicModelCatalog({ ...base, omp: { profile: 'second', config: ['/b.yml'], extensions: true } }); expect(probes).toBe(4);
  });
});
