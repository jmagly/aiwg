import * as catalogFs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, utimes } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { constants, openSync, closeSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  discoverMuseCatalogModels,
  discoverCodexDebugModels,
  discoverCodexModels,
  mergeProviderDiscovery,
  normalizeCodexDebugModels,
  normalizeMuseCatalogRows,
  type NormalizeDiscoveryOptions,
  type ModelDiscoveryOptions,
  classifyDiscoveryError,
  redactModelDiscoveryText,
  diffModelCatalog,
  discoverOpenClawModels,
  discoverOpenCodeModels,
  discoverPiModels,
  discoverOmpModels,
  resolveOmpRoleModel,
  retirementGuard,
  type ProviderModelDiscovery,
  PROVIDER_DISCOVERY_DECISIONS,
  resolveDynamicModelCatalog,
  selectRoleModels,
} from '../../../src/models/model-discovery.js';
import { validateWorkerModelObservation, validateWorkerCatalogDiscovery, validateWorkerPolicyRoute } from '../../../src/models/provider-policy.js';
import type { ProviderInventory } from '../../../src/providers/provider-inventory.js';
import { discoverGrokBuildModels } from '../../../src/models/grok-build-models.js';

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
    // 'ollama' added by roctinam/aiwg#2899 (B-OG-09): GET /api/tags is a native,
    // read-only model-list decision, declared here but not independently
    // implemented by that task (see the local-http worker-adapter docs).
    expect(Object.keys(PROVIDER_DISCOVERY_DECISIONS).sort()).toEqual([
      'claude', 'codex', 'copilot', 'cursor', 'factory', 'grok-build', 'grokbot', 'hermes',
      'muse', 'ollama', 'omp', 'openclaw', 'opencode', 'openhuman', 'pi', 'warp', 'windsurf',
    ]);
    expect(Object.values(PROVIDER_DISCOVERY_DECISIONS).every(decision =>
      decision.reason.length > 0 && decision.documentation.startsWith('https://')
    )).toBe(true);
    expect(Object.values(PROVIDER_DISCOVERY_DECISIONS)
      .filter(decision => decision.status === 'native')
      .map(decision => decision.provider)
      .sort()).toEqual(['codex', 'factory', 'grok-build', 'muse', 'ollama', 'omp', 'openclaw', 'opencode', 'pi']);
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

  it.each([
    'EROFS: read-only file system, mkdir /home/synthetic/.pi/agent/settings.json.lock',
    'EACCES: permission denied, FileSystem.open /home/synthetic/.local/share/opencode/log/401.log',
    'EPERM: operation not permitted, mkdir /home/synthetic/.pi/agent/settings.json.lock',
    'FileSystem.open: /home/synthetic/.local/share/opencode/log/synthetic.log',
    'read-only file system, mkdir /home/synthetic/.pi/agent/settings.json.lock',
    'permission denied, open /home/synthetic/.local/share/opencode/log/synthetic.log',
    'operation not permitted, mkdir /home/synthetic/.pi/agent/settings.json.lock',
  ])('classifies local filesystem failures as environment: %s', message => {
    expect(classifyDiscoveryError(`\u001b[31m${message}\u001b[0m`)).toBe('environment');
  });

  it.each([
    ['HTTP 403 forbidden', 'authentication'],
    ['HTTP 403 permission denied', 'authentication'],
    ['HTTP 429 rate limit exceeded', 'rate-limit'],
    ['models timed out', 'timeout'],
    ['spawn fake ENOENT', 'command'],
    ['unknown option --pure', 'command'],
    ['FileSystem.open: /tmp/unrelated-file', 'command'],
  ])('preserves discovery classification for %s', (message, expected) => {
    expect(classifyDiscoveryError(message)).toBe(expected);
  });

  it('strips terminal controls before redaction and diagnostic truncation', () => {
    const diagnostic = '\u001b[31m'.repeat(900)
      + '\u001b]8;;https://example.invalid\u0007failure\u001b]8;;\u001b\\ '
      + 'to\u001b[1mken=synthetic-value\u001b[0m';
    expect(redactModelDiscoveryText(diagnostic)).toBe('failure token=[REDACTED]');
    expect(redactModelDiscoveryText('x'.repeat(5000))).toHaveLength(4096);
  });

  it('accepts environment discovery errors in the catalog schema', async () => {
    const schema = JSON.parse(await readFile(new URL('../../../schemas/models/model-catalog.v1.schema.json', import.meta.url), 'utf8'));
    const ajv = addFormats(new Ajv2020({ strict: true }));
    ajv.addSchema(schema);
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/providerDiscovery` });
    const result = await discoverPiModels('fake', async () => ({ stdout: '', exitCode: 1,
      stderr: 'EROFS: read-only file system, mkdir /home/synthetic/.pi/agent/settings.json.lock' }));
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...result, errorKind: 'unknown-kind' })).toBe(false);
  });

  it.each(['returned', 'thrown'])('sanitizes %s native errors before storing diagnostics', async mode => {
    const { root, cacheFile, inventory } = await fixture();
    const message = 'EROFS: read-only file system, mkdir /home/synthetic/.pi/agent/settings.json.lock';
    const resolved = await resolveDynamicModelCatalog({ aiwgRoot: root, cacheFile, inventory, forceRefresh: true,
      nativeDiscoverers: { codex: async () => {
        const error = `\u001b[31m${message}\u001b[0m`;
        if (mode === 'thrown') throw new Error(error);
        return { provider: 'codex', source: 'native', observedAt: new Date(0).toISOString(),
          accountScope: 'local-account', models: [], errorKind: 'environment', error };
      } },
    });
    expect(resolved.discovery!.providers.codex).toMatchObject({ errorKind: 'environment', error: message, models: [] });
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
    expect(cached.discovery.providers.codex.error).toBe(message);
  });

  it.each([
    ['opencode', discoverOpenCodeModels, 'synthetic/code\n',
      'EACCES: permission denied, FileSystem.open /home/synthetic/.local/share/opencode/log/synthetic.log'],
    ['pi', discoverPiModels, 'provider  model\nsynthetic  code\n',
      'EROFS: read-only file system, mkdir /home/synthetic/.pi/agent/settings.json.lock'],
  ] as const)('preserves the last good %s catalog through environment failures and recovery', async (provider, discover, stdout, message) => {
    const { root, cacheFile, inventory, catalog } = await fixture();
    inventory.providers = [{ ...inventory.providers[0], id: provider }];
    const staticFile = join(root, 'agentic/code/providers/model-catalog.v1.json');
    await writeFile(staticFile, JSON.stringify({ ...catalog, providers: {
      [provider]: { roles: { coding: { id: 'synthetic/static-code' } } },
    } }));
    let failed = false;
    let now = new Date('2026-10-17T12:00:00.000Z');
    const runner = async (_command: string, args: string[]) => args.includes('--version')
      ? { stdout: 'fixture', stderr: '', exitCode: 0 }
      : failed ? { stdout: '', stderr: `\u001b[31m${message}\u001b[0m`, exitCode: 1 }
        : { stdout, stderr: '', exitCode: 0 };
    const options = { aiwgRoot: root, cacheFile, inventory, forceRefresh: true, now: () => now,
      nativeDiscoverers: { [provider]: async () => ({ ...await discover('fake', runner), observedAt: now.toISOString() }) } };
    const first = await resolveDynamicModelCatalog(options);
    expect(first.discovery!.providers[provider].errorKind).toBeUndefined();
    failed = true;
    now = new Date('2026-10-18T12:00:00.000Z');
    for (let attempt = 0; attempt < 2; attempt++) {
      const resolved = await resolveDynamicModelCatalog(options);
      const entry = resolved.discovery!.providers[provider];
      expect(entry).toMatchObject({ source: 'native', errorKind: 'environment', error: message,
        models: first.discovery!.providers[provider].models,
        observedAt: first.discovery!.providers[provider].observedAt });
      expect(resolved.providers[provider]).toEqual(first.providers[provider]);
      expect(resolved.discovery!.fetchedAt).toBe(now.toISOString());
      const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
      expect(cached.discovery.providers[provider]).toEqual(entry);
      expect(Object.values(cached.discovery.instances)).toContainEqual(entry);
      expect(JSON.stringify(cached)).not.toContain('\\u001b');
    }
    failed = false;
    const recovered = (await resolveDynamicModelCatalog(options)).discovery!.providers[provider];
    expect(recovered.errorKind).toBeUndefined();
    expect(recovered.error).toBeUndefined();
    expect(recovered.observedAt).toBe(now.toISOString());
  });

  it.each([
    ['opencode', discoverOpenCodeModels],
    ['pi', discoverPiModels],
    ['openclaw', discoverOpenClawModels],
  ] as const)('redacts %s stderr before caching a failed discovery', async (provider, discover) => {
    const { root, cacheFile, inventory } = await fixture();
    inventory.providers = [{ ...inventory.providers[0], id: provider }];
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: 'fixture', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 403 forbidden token=synthetic-secret-token', exitCode: 1 });
    const resolved = await resolveDynamicModelCatalog({
      aiwgRoot: root, cacheFile, inventory, forceRefresh: true,
      nativeDiscoverers: { [provider]: () => discover('fake', runner) },
    });
    expect(resolved.discovery?.providers[provider]).toMatchObject({
      errorKind: 'authentication', error: 'HTTP 403 forbidden token=[REDACTED]',
    });
    const cached = await readFile(cacheFile, 'utf8');
    expect(cached).not.toContain('synthetic-secret-token');
    expect(JSON.parse(cached).discovery.providers[provider].error).toContain('[REDACTED]');
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


// Guard the production regression against accidentally launching a real account CLI.
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, lstat: vi.fn(original.lstat) };
});

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(() => { throw new Error('Production discovery must use the injected fake runner'); }),
}));

const evidenceNow = new Date('2026-10-07T12:00:00.000Z');
const evidenceOptions: NormalizeDiscoveryOptions = {
  cliId: 'muse', source: '/synthetic/catalog.json', runtimeVersion: 'fixture',
  accountScope: 'local-account', now: evidenceNow, observedAt: evidenceNow.toISOString(),
};
const evidenceRow = { model_id: 'synth-code', visibility: 'listed', is_current: true,
  reasoning_effort_variants: ['high'], context_limit: 100, release_date: '2026-01-01' };

describe('#2882 production and evidence regressions', () => {
  it('uses the Codex debug runner in production, merges partial/failing refreshes and isolates accounts', async () => {
    const { root, cacheFile, inventory } = await fixture();
    let payload = { models: [{ slug: 'synth-code', visibility: 'listed', context_window: 100 },
      { slug: 'synth-old', visibility: 'listed' }] };
    let fail = false;
    const runner = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args[0] === '--version' ? '0.160.0-fixture' : JSON.stringify(payload),
      stderr: fail && args[0] !== '--version' ? 'timeout' : '',
      exitCode: fail && args[0] !== '--version' ? 124 : 0,
    }));
    const options = { aiwgRoot: root, cacheFile, inventory, allowNetwork: true,
      forceRefresh: true, runner, codex: { command: 'fake-codex', accountBinding: 'work' },
      now: () => evidenceNow } satisfies ModelDiscoveryOptions;
    const first = await resolveDynamicModelCatalog(options);
    expect(runner).toHaveBeenCalledWith('fake-codex', ['debug', 'models'], expect.anything());
    const original = first.discovery!.providers.codex.models;
    expect(original[0].worker?.contextTokens).toBe(100);
    expect(first.discovery!.instances!['codex:work'].models).toEqual(original);
    // A rejected row makes the refresh partial; fewer valid rows alone do not.
    payload = { models: [{ slug: 'synth-code', visibility: 'listed', context_window: 200 },
      { slug: '', visibility: 'listed' }] };
    const later = () => new Date('2026-10-08T12:00:00.000Z');
    const partial = await resolveDynamicModelCatalog({ ...options, now: later });
    expect(partial.discovery!.providers.codex.models.find(m => m.id === 'synth-old')).toEqual(original[1]);
    expect(partial.discovery!.providers.codex.models[0].worker?.firstObservedAt).toBe(evidenceNow.toISOString());
    fail = true;
    const failed = await resolveDynamicModelCatalog({ ...options, now: later });
    expect(failed.discovery!.providers.codex.models).toEqual(partial.discovery!.providers.codex.models);
    expect(failed.discovery!.providers.codex.observedAt).toBe(partial.discovery!.providers.codex.observedAt);
    expect(failed.discovery!.providers.codex.errorKind).toBe('timeout');
    const personal = await resolveDynamicModelCatalog({ ...options, now: later,
      codex: { command: 'fake-codex', accountBinding: 'personal' } });
    expect(personal.discovery!.providers.codex.models).toEqual([]);
    expect(personal.discovery!.instances!['codex:work'].models).toEqual(partial.discovery!.providers.codex.models);
    expect(validateWorkerCatalogDiscovery(personal.discovery)).toEqual([]);
  });

  it('never promotes retired/unqualified observations and guards existing retired pins in production', async () => {
    const { root, cacheFile, inventory, catalog } = await fixture();
    const rows = normalizeMuseCatalogRows({ rows: [evidenceRow, { ...evidenceRow,
      model_id: 'static-standard', retired: true, is_default: true }] }, evidenceOptions).models;
    expect(selectRoleModels(rows)).toEqual({});
    const resolved = await resolveDynamicModelCatalog({ aiwgRoot: root, cacheFile, inventory,
      forceRefresh: true, nativeDiscoverers: { codex: async () => ({ provider: 'codex', source: 'native',
        observedAt: evidenceNow.toISOString(), accountScope: 'local-account', models: rows }) } });
    expect(resolved.providers.codex.roles.coding.id).toBe(catalog.providers.codex.roles.coding.id);
    expect(resolved.providers.codex.roles.reasoning.id).toBe(catalog.providers.codex.roles.reasoning.id);
    expect(resolved.discovery!.providers.codex.policy?.diagnostics.join(';')).toContain('blocks dispatch');
  });

  it('preserves unchanged Muse evidence ages through the production cache, even after a file touch', async () => {
    const { root, cacheFile, inventory } = await fixture();
    inventory.providers[0].id = 'muse';
    const catalogDir = join(root, 'muse-catalog');
    await mkdir(catalogDir);
    const file = join(catalogDir, 'one.json');
    await writeFile(file, JSON.stringify({ fetchedAt: '2026-10-01T00:00:00.000Z', rows: [evidenceRow] }));
    const base = { aiwgRoot: root, cacheFile, inventory, allowNetwork: true, forceRefresh: true,
      muse: { catalogDir, accountBinding: 'work' }, now: () => evidenceNow } satisfies ModelDiscoveryOptions;
    const first = await resolveDynamicModelCatalog(base);
    const worker = first.discovery!.providers.muse.models[0].worker!;
    expect(worker.observedAt).toBe('2026-10-01T00:00:00.000Z');
    await utimes(file, evidenceNow, evidenceNow);
    const second = await resolveDynamicModelCatalog({ ...base, now: () => new Date('2026-10-08T12:00:00.000Z') });
    expect(second.discovery!.providers.muse.models[0].worker).toEqual(worker);
    expect(second.discovery!.providers.muse.observedAt).toBe(first.discovery!.providers.muse.observedAt);
    // A provider-written refresh timestamp changes file content and permits a new observation.
    await writeFile(file, JSON.stringify({ fetchedAt: '2026-10-08T10:00:00.000Z', rows: [evidenceRow] }));
    const third = await resolveDynamicModelCatalog({ ...base, now: () => new Date('2026-10-08T12:00:00.000Z') });
    expect(third.discovery!.providers.muse.models[0].worker!.observedAt).toBe('2026-10-08T10:00:00.000Z');
    expect(third.discovery!.providers.muse.models[0].worker!.firstObservedAt).toBe(worker.firstObservedAt);
    expect(validateWorkerCatalogDiscovery(third.discovery)).toEqual([]);
  });

  it.each(['muse', 'codex'])('retains duplicate lifecycle/visibility/effort/release evidence for %s', cli => {
    const rows = [{ ...evidenceRow, slug: evidenceRow.model_id, lifecycle: 'active', supported_reasoning_levels: ['low'] },
      { ...evidenceRow, slug: evidenceRow.model_id, retired: true, visibility: 'hidden',
        reasoning_effort_variants: ['ultra'], supported_reasoning_levels: ['ultra'], release_date: '2026-02-02' }];
    const result = cli === 'muse' ? normalizeMuseCatalogRows({ rows }, evidenceOptions)
      : normalizeCodexDebugModels({ models: rows }, { ...evidenceOptions, cliId: 'codex' });
    expect(result.models).toHaveLength(1);
    const worker = result.models[0].worker!;
    expect(worker.lifecycle).toBe('retired');
    expect(worker.availability).toBe('unavailable');
    expect(worker.releaseDate).toBeNull();
    const conflicts = worker.conflicts!;
    for (const field of ['/lifecycle', '/visibility', '/efforts', '/releaseDate']) {
      const conflict = conflicts.find(c => c.field === field);
      expect(conflict!.evidence).toHaveLength(2);
      expect(new Set(conflict!.evidence.map(e => e.source)).size).toBe(2);
      expect(conflict!.evidence[0].value).not.toEqual(conflict!.evidence[1].value);
    }
    expect(selectRoleModels(result.models)).toEqual({});
    expect(validateWorkerModelObservation(worker)).toEqual([]);
  });

  it('preserves exact API/provider identity and blocks conflicting native rows', () => {
    const row = { slug: 'synthetic-model', provider: 'synthetic-inference', visibility: 'listed', context_window: 32000, output_limit: 4096 };
    const options = { ...evidenceOptions, cliId: 'codex' };
    const exact = normalizeCodexDebugModels({ models: [row] }, options).models[0];
    expect(exact.apiModelId).toBe('synthetic-model');
    expect(exact.llmProvider).toBe('synthetic-inference');
    expect(exact.worker!.provenance[0].fields).toEqual(expect.arrayContaining(['/apiModelId', '/llmProvider']));
    const conflicting = normalizeCodexDebugModels({ models: [row, { ...row, provider: 'other-inference' }] }, options).models[0];
    expect(conflicting.llmProvider).toBeUndefined();
    expect(conflicting.worker!.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ field: '/llmProvider' })]));
  });

  it('hashes evidence values and covers every emitted field with concrete provenance', async () => {
    const one = normalizeMuseCatalogRows({ rows: [evidenceRow] }, evidenceOptions).models[0];
    const two = normalizeMuseCatalogRows({ rows: [{ ...evidenceRow, context_limit: 200 }] }, evidenceOptions).models[0];
    expect(one.worker!.provenance[0].digest).not.toBe(two.worker!.provenance[0].digest);
    const account = normalizeMuseCatalogRows({ rows: [evidenceRow] }, { ...evidenceOptions, accountBinding: 'another-account' }).models[0];
    const runtime = normalizeMuseCatalogRows({ rows: [evidenceRow] }, { ...evidenceOptions, runtimeVersion: 'different-runtime' }).models[0];
    expect(one.worker!.provenance[0].digest).not.toBe(account.worker!.provenance[0].digest);
    expect(one.worker!.provenance[0].digest).not.toBe(runtime.worker!.provenance[0].digest);
    const fields = one.worker!.provenance.flatMap(p => p.fields);
    for (const field of Object.keys(one.worker!).filter(k => k !== 'provenance')) expect(fields).toContain('/' + field);
    for (const field of Object.keys(one).filter(k => k !== 'worker')) expect(fields).toContain('/' + field);
    const root = await mkdtemp(join(tmpdir(), 'aiwg-muse-source-')); roots.push(root);
    const file = join(root, 'one.json');
    await writeFile(file, JSON.stringify({ fetchedAt: '2026-10-01T00:00:00.000Z', rows: [evidenceRow] }));
    const discovered = await discoverMuseCatalogModels({ catalogDir: root, now: () => evidenceNow });
    expect(discovered.models[0].worker!.provenance.every(p => p.source.includes(file) && !p.source.includes('*'))).toBe(true);
  });

  it.each(['muse', 'codex'])('rejects future evidence times and makes malformed release dates unknown for %s', cli => {
    const normalize = (options: NormalizeDiscoveryOptions, date: string = 'not-a-date') => cli === 'muse'
      ? normalizeMuseCatalogRows({ rows: [{ ...evidenceRow, release_date: date }] }, options)
      : normalizeCodexDebugModels({ models: [{ slug: 'synth-code', release_date: date }] }, { ...options, cliId: 'codex' });
    for (const field of ['observedAt', 'firstObservedAt', 'fetchedAt']) {
      const result = normalize({ ...evidenceOptions, [field]: '2027-01-01T00:00:00.000Z' });
      expect(result.models).toEqual([]);
      expect(result.diagnostics.join(';')).toContain(field);
    }
    for (const date of ['not-a-date', '2026-02-30', '2026-1-1']) {
      const result = normalize(evidenceOptions, date);
      expect(result.models[0].worker!.releaseDate).toBeNull();
      expect(result.diagnostics.join(';')).toContain('release_date');
      expect(validateWorkerModelObservation(result.models[0].worker)).toEqual([]);
    }
  });

  it('rejects FIFO/device/escaping symlink and oversized Muse files before reading, within a deadline', async context => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-muse-bounds-')); roots.push(root);
    const fifo = join(root, 'pipe.json');
    try { execFileSync('mkfifo', [fifo], { timeout: 1_000 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EROFS') {
        context.skip('Environment denies FIFO fixture creation (mkfifo EPERM/EROFS)'); return;
      }
      throw error;
    }
    await symlink('/dev/null', join(root, 'device.json'));
    await symlink(join(root, '..', 'outside.json'), join(root, 'escape.json'));
    await writeFile(join(root, 'large.json'), ' '.repeat(1024 * 1024 + 1));
    // Unblock the old implementation after the assertion deadline, so a failing test leaves no reader behind.
    const release = setTimeout(() => {
      try { const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK); writeSync(fd, '{}'); closeSync(fd); } catch { /* fixed reader rejects the FIFO */ }
    }, 250);
    const started = Date.now();
    try {
      const result = await Promise.race([
        discoverMuseCatalogModels({ catalogDir: root, now: () => evidenceNow, timeoutMs: 100 }),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 150)),
      ]);
      expect(result).not.toBeNull();
      expect(Date.now() - started).toBeLessThan(200);
      expect(result!.policy!.diagnostics.join(';')).toMatch(/regular file/);
      expect(result!.policy!.diagnostics.join(';')).toMatch(/size/);
      expect(result!.models).toEqual([]);
    } finally { await new Promise(resolve => setTimeout(resolve, 300)); clearTimeout(release); }
  });
});


describe('#2882 bounded file and route checks', () => {
  it('rejects nonregular, escaping symlink and oversized entries without reading them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-muse-files-')); roots.push(root);
    await symlink('/dev/null', join(root, 'device.json'));
    await symlink('/etc/passwd', join(root, 'escape.json'));
    await mkdir(join(root, 'directory.json'));
    await writeFile(join(root, 'large.json'), ' '.repeat(1024 * 1024 + 1));
    const result = await discoverMuseCatalogModels({ catalogDir: root, now: () => evidenceNow });
    expect(result.models).toEqual([]);
    expect(result.policy!.diagnostics.join(';')).toMatch(/regular file/);
    expect(result.policy!.diagnostics.join(';')).toMatch(/size.*before reading/);
    expect(result.policy!.diagnostics.join(';')).toMatch(/escapes catalog/);
  });

  it('rejects a synthetic FIFO stat promptly and enforces the overall metadata deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-muse-deadline-')); roots.push(root);
    const file = join(root, 'one.json');
    await writeFile(file, JSON.stringify({ rows: [evidenceRow] }));
    const stat = await catalogFs.lstat(file);
    vi.mocked(catalogFs.lstat).mockResolvedValueOnce({ ...stat, isFile: () => false, isSymbolicLink: () => false });
    const fifo = await discoverMuseCatalogModels({ catalogDir: root, now: () => evidenceNow, timeoutMs: 100 });
    expect(fifo.models).toEqual([]);
    expect(fifo.policy!.diagnostics.join(';')).toContain('not a regular file');
    vi.mocked(catalogFs.lstat).mockImplementationOnce(() => new Promise(() => {}));
    const started = Date.now();
    const timeout = await discoverMuseCatalogModels({ catalogDir: root, now: () => evidenceNow, timeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(200);
    expect(timeout.models).toEqual([]);
    expect(timeout.policy!.diagnostics.join(';')).toContain('deadline');
  });

  it('keeps lifecycle conflicts ineligible even when the observation is subsequently qualified', () => {
    const worker = normalizeMuseCatalogRows({ rows: [evidenceRow,
      { ...evidenceRow, retired: true }] }, evidenceOptions).models[0].worker!;
    worker.qualification = { status: 'qualified', roles: ['coding'], fixtureDigest: 'sha256:' + '1'.repeat(64),
      evidenceRef: '/synthetic/qualification.json', verifiedAt: evidenceNow.toISOString() };
    const findings = validateWorkerPolicyRoute({ policy: {}, role: 'coding', inferenceProvider: 'synthetic',
      apiModelId: 'synth-code', selectedModel: 'synth-code', effort: 'high', identityEvidence: 'runtime-configured',
      observation: worker, now: evidenceNow });
    expect(findings.some(d => d.pointer === '/worker/conflicts')).toBe(true);
  });
});


describe('#2882 scoped qualification and file evidence', () => {
  it('keeps a qualified route eligible when only release dates conflict', () => {
    const model = normalizeMuseCatalogRows({ rows: [evidenceRow,
      { ...evidenceRow, release_date: '2026-02-02' }] }, evidenceOptions).models[0];
    const worker = model.worker!;
    worker.qualification = { status: 'qualified', roles: ['coding'],
      fixtureDigest: 'sha256:' + '1'.repeat(64), evidenceRef: '/synthetic/qualification.json',
      verifiedAt: evidenceNow.toISOString() };
    worker.dataUse = { processing: 'local', productImprovement: false, retentionDays: 0 };
    worker.efforts = [{ id: 'high', selfDelegates: false }];
    const route = { policy: { roleGuidance: { coding: { groups: ['synthetic'], tier: 'standard' as const,
      initialEffort: 'high', effortLadder: ['high'] } } }, role: 'coding', inferenceProvider: 'synthetic',
      apiModelId: model.id, selectedModel: model.id, effort: 'high', identityEvidence: 'runtime-configured' as const,
      observation: worker, now: evidenceNow };
    const findings = validateWorkerPolicyRoute(route);
    expect(findings).toEqual([{ code: 'OG_MODEL_UNAPPROVED', pointer: '/worker/conflicts', blocking: false,
      message: 'Conflicting optional model evidence remains unknown: /releaseDate' }]);
    expect(findings.filter(diagnostic => diagnostic.blocking !== false)).toEqual([]);
    expect(worker.releaseDate).toBeNull();
    expect(worker.releaseDateKind).toBe('unknown');
    expect(worker.conflicts![0].evidence).toHaveLength(2);
    expect(selectRoleModels([model])).toEqual({ coding: model });
    // Each safety/identity field, including nested policy leaves, still blocks.
    for (const field of ['/lifecycle', '/visibility', '/availability', '/efforts', '/effortSupport',
      '/retiredAt', '/sunsetAt', '/replacementModelId', '/dataUse/productImprovement', '/family', '/id']) {
      const observation = { ...worker, conflicts: [{ ...worker.conflicts![0], field }] };
      expect(validateWorkerPolicyRoute({ ...route, observation }).some(diagnostic =>
        diagnostic.pointer === '/worker/conflicts' && diagnostic.blocking !== false)).toBe(true);
      expect(selectRoleModels([{ ...model, worker: observation }])).toEqual({});
    }
  });

  it('selects only roles with qualified eligible observations', () => {
    const model = normalizeMuseCatalogRows({ rows: [evidenceRow] }, evidenceOptions).models[0];
    model.worker!.qualification = { status: 'qualified', roles: ['coding'],
      fixtureDigest: 'sha256:' + '1'.repeat(64), evidenceRef: '/synthetic/qualification.json',
      verifiedAt: evidenceNow.toISOString() };
    expect(selectRoleModels([model])).toEqual({ coding: model });
    for (const overrides of [
      { visibility: 'hidden' as const }, { availability: 'unavailable' as const },
      { lifecycle: 'retired' as const }, { lifecycle: 'unverified' as const },
      { effortSupport: 'unknown' as const },
    ]) expect(selectRoleModels([{ ...model, worker: { ...model.worker!, ...overrides } }])).toEqual({});
  });

  it('preserves file mtime evidence on unchanged cache rereads without provider timestamps', async () => {
    const { root, cacheFile, inventory } = await fixture();
    inventory.providers[0].id = 'muse';
    const catalogDir = join(root, 'catalog'); await mkdir(catalogDir);
    const file = join(catalogDir, 'one.json');
    await writeFile(file, JSON.stringify({ rows: [evidenceRow] }));
    const old = new Date('2026-10-01T00:00:00.000Z'); await utimes(file, old, old);
    const options = { aiwgRoot: root, inventory, cacheFile, forceRefresh: true, allowNetwork: true,
      muse: { catalogDir }, now: () => evidenceNow };
    const first = await resolveDynamicModelCatalog(options);
    expect(first.discovery!.providers.muse.models[0].worker!.observedAt).toBe(old.toISOString());
    await utimes(file, evidenceNow, evidenceNow);
    const second = await resolveDynamicModelCatalog(options);
    expect(second.discovery!.providers.muse).toEqual(first.discovery!.providers.muse);
  });

  it('retains conflicting values and concrete file/row sources across the Muse directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-muse-conflicts-')); roots.push(root);
    const firstFile = join(root, 'first.json'), secondFile = join(root, 'second.json');
    const fetchedAt = '2026-10-01T00:00:00.000Z';
    await writeFile(firstFile, JSON.stringify({ fetchedAt, rows: [evidenceRow] }));
    await writeFile(secondFile, JSON.stringify({ fetchedAt, rows: [{ ...evidenceRow,
      retired: true, visibility: 'hidden', release_date: '2026-02-02', reasoning_effort_variants: ['ultra'] }] }));
    const discovered = await discoverMuseCatalogModels({ catalogDir: root, now: () => evidenceNow });
    const worker = discovered.models[0].worker!;
    expect(worker.lifecycle).toBe('retired');
    const dates = worker.conflicts!.find(c => c.field === '/releaseDate')!.evidence;
    expect(dates.map(e => [e.value, e.source, e.pointer])).toEqual([
      ['2026-01-01', firstFile + '#/rows/0', '/release_date'],
      ['2026-02-02', secondFile + '#/rows/0', '/release_date'],
    ]);
    expect(validateWorkerModelObservation(worker)).toEqual([]);
  });

  it('rejects future file timestamps and invalid sunset dates without emitting invalid observations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-muse-timestamps-')); roots.push(root);
    const file = join(root, 'one.json');
    for (const field of ['fetchedAt', 'observedAt', 'firstObservedAt']) {
      await writeFile(file, JSON.stringify({ fetchedAt: '2026-10-01T00:00:00.000Z',
        [field]: '2027-01-01T00:00:00.000Z', rows: [evidenceRow] }));
      const result = await discoverMuseCatalogModels({ catalogDir: root, now: () => evidenceNow });
      expect(result.models).toEqual([]);
      expect(result.policy!.diagnostics.join(';')).toContain(field);
    }
    for (const cliId of ['muse', 'codex']) {
      const options = { ...evidenceOptions, cliId };
      const result = cliId === 'muse'
        ? normalizeMuseCatalogRows({ rows: [{ ...evidenceRow, deprecated: true, sunset_at: '2026-02-30T00:00:00Z' }] }, options)
        : normalizeCodexDebugModels({ models: [{ slug: 'synth-code', deprecated: true, sunset_at: 'not-a-date' }] }, options);
      expect(result.models[0].worker!.sunsetAt).toBeNull();
      expect(result.diagnostics.join(';')).toContain('sunset_at');
      expect(validateWorkerModelObservation(result.models[0].worker)).toEqual([]);
    }
  });
});

async function legacyDiscovery(provider: string, ids: string[], root: string): Promise<ProviderModelDiscovery> {
  const payload = provider === 'opencode' ? ids.map(id => `synthetic/${id}`).join('\n')
    : provider === 'pi' ? 'provider  model\n' + ids.map(id => `synthetic  ${id}`).join('\n')
      : JSON.stringify({ models: ids.map(id => provider === 'openclaw'
        ? { key: `synthetic/${id}`, name: id, tags: [] } : { provider: 'synthetic', id, name: id }) });
  const runner = async (_command: string, args: string[]) => ({
    stdout: args[0] === '--version' ? 'fixture' : payload, stderr: '', exitCode: 0,
  });
  const discovery = provider === 'opencode' ? await discoverOpenCodeModels('fake', runner)
    : provider === 'openclaw' ? await discoverOpenClawModels('fake', runner)
      : provider === 'pi' ? await discoverPiModels('fake', runner)
        : provider === 'omp' ? await discoverOmpModels('fake', runner)
          : await discoverGrokBuildModels({ env: { HOME: root }, inspectReport: {
            configSources: { layers: [] }, models: ids.map(id => ({ alias: id, name: id })),
          } });
  expect(discovery.errorKind).toBeUndefined();
  return { ...discovery, observedAt: evidenceNow.toISOString() };
}

describe('#2882 complete versus failed/partial legacy refreshes', () => {
  const cases = ['opencode', 'openclaw', 'pi', 'grok-build', 'omp'].flatMap(provider =>
    ['success', 'failure', 'partial'].map(refresh => ({ provider, refresh })));
  it.each(cases)('$provider $refresh refresh handles removed rows and age', async ({ provider, refresh }) => {
    const { root, cacheFile, inventory, catalog } = await fixture();
    inventory.providers = [{ ...inventory.providers[0], id: provider }];
    const prior = await legacyDiscovery(provider, ['old-opus', 'old-mini'], root);
    const pinned = prior.models[0].id;
    const providerCatalog = { roles: { coding: { id: pinned, status: 'active', observed: true } } };
    await writeFile(join(root, 'agentic/code/providers/model-catalog.v1.json'), JSON.stringify({
      ...catalog, providers: { [provider]: providerCatalog },
    }));
    let next = prior;
    const options = { aiwgRoot: root, cacheFile, inventory, forceRefresh: true,
      nativeDiscoverers: { [provider]: async () => next }, now: () => evidenceNow };
    const first = await resolveDynamicModelCatalog(options);
    next = { ...await legacyDiscovery(provider, ['new-code'], root), observedAt: '2026-10-08T12:00:00.000Z',
      ...(refresh === 'success' ? {} : { errorKind: 'invalid-output' as const, error: 'Synthetic incomplete refresh' }),
      ...(refresh === 'failure' ? { models: [] } : {}),
    };
    const result = await resolveDynamicModelCatalog({ ...options, now: () => new Date(next.observedAt) });
    const entry = result.discovery!.providers[provider];
    if (refresh === 'success') {
      expect(entry.models).toEqual(next.models);
      expect(entry.observedAt).toBe(next.observedAt);
      expect(Object.values(selectRoleModels(entry.models)).every(model => model.id.endsWith('new-code'))).toBe(true);
      if (provider === 'omp') {
        expect(result.providers[provider].roles.coding).toEqual({ id: pinned, status: 'unverified', observed: false });
        expect(entry.policy!.diagnostics.join(';')).toContain(`Unavailable model ${pinned}`);
        expect(retirementGuard(pinned).blocked).toBe(true);
        expect(() => resolveOmpRoleModel(entry, 'coding', { coding: pinned })).toThrow('unavailable');
      } else {
        expect(Object.values(result.providers[provider].roles).every(role => role.id.endsWith('new-code'))).toBe(true);
      }
    } else {
      expect(entry.models.filter(model => model.id !== next.models[0]?.id)).toEqual(prior.models);
      expect(entry.observedAt).toBe(prior.observedAt);
      expect(entry.errorKind).toBe('invalid-output');
      expect(result.providers[provider]).toEqual(first.providers[provider]);
    }
    expect(result.discovery!.instances![`${provider}:${entry.accountScope}`]).toEqual(entry);
  });

  it.each(['codex', 'muse'])('marks a disappeared %s pin unavailable without substitution', async provider => {
    const { root, cacheFile, inventory, catalog } = await fixture();
    inventory.providers = [{ ...inventory.providers[0], id: provider }];
    await writeFile(join(root, 'agentic/code/providers/model-catalog.v1.json'), JSON.stringify({
      ...catalog, providers: { [provider]: { roles: { coding: { id: 'synth-code', status: 'active' } } } },
    }));
    let models = normalizeMuseCatalogRows({ rows: [evidenceRow] }, { ...evidenceOptions, cliId: provider }).models;
    const options = { aiwgRoot: root, cacheFile, inventory, forceRefresh: true, now: () => evidenceNow,
      nativeDiscoverers: { [provider]: async (): Promise<ProviderModelDiscovery> => ({ provider,
        source: 'native', observedAt: evidenceNow.toISOString(), accountScope: 'local-account', models }) } };
    await resolveDynamicModelCatalog(options);
    models = [];
    const result = await resolveDynamicModelCatalog(options);
    expect(result.discovery!.providers[provider].models).toEqual([]);
    expect(result.providers[provider].roles.coding).toEqual({ id: 'synth-code', status: 'unverified', observed: false });
    expect(result.discovery!.providers[provider].policy!.diagnostics.join(';')).toContain('blocks dispatch');
    expect(retirementGuard('synth-code')).toMatchObject({ blocked: true, pin: 'synth-code' });
    const repeated = await resolveDynamicModelCatalog(options);
    expect(repeated.providers[provider].roles.coding).toEqual(result.providers[provider].roles.coding);
    expect(repeated.discovery!.providers[provider].policy!.diagnostics.join(';')).toContain('blocks dispatch');
  });
});


it('accepts Codex list visibility and structured reasoning effort entries without guessing tiers', () => {
  const result = normalizeCodexDebugModels({ models: [{ slug: 'synth-code', visibility: 'list',
    supported_reasoning_levels: [{ effort: 'low', description: 'synthetic' }, { effort: 'high' }],
    default_reasoning_level: 'high' }] }, { ...evidenceOptions, cliId: 'codex' });
  expect(result.models[0].worker!.visibility).toBe('listed');
  expect(result.models[0].reasoningEfforts).toEqual(['low', 'high']);
  expect(validateWorkerModelObservation(result.models[0].worker)).toEqual([]);
});

describe('#2882 real parser completeness regressions', () => {
  it.each(['opencode', 'openclaw', 'pi', 'grok-build', 'omp', 'codex'])('%s exit-0 mixed rows preserve cached evidence until a clean refresh', async provider => {
    const { root, cacheFile, inventory } = await fixture();
    inventory.providers = [{ ...inventory.providers[0], id: provider }];
    let ids = ['current-code', 'retired-code'];
    let malformed = false;
    let now = evidenceNow;
    const runner = async (_command: string, args: string[]) => {
      const rows = ids.map(id => provider === 'openclaw' ? { key: `synthetic/${id}` }
        : provider === 'grok-build' ? { alias: `synthetic/${id}` }
          : provider === 'codex' ? { slug: `synthetic/${id}`, visibility: 'list', retired: id === 'retired-code' }
            : { provider: 'synthetic', id });
      const stdout = provider === 'opencode' ? ids.map(id => `synthetic/${id}`).concat(malformed ? ['broken-row'] : []).join('\n')
        : provider === 'pi' ? 'provider  model\n' + ids.map(id => `synthetic  ${id}`).concat(malformed ? ['broken-row'] : []).join('\n')
          : JSON.stringify({ models: [...rows, ...(malformed ? [null, { missing: 'identity' }] : [])] });
      return { stdout: args.includes('--version') ? 'fixture' : stdout, stderr: '', exitCode: 0 };
    };
    const discover = () => provider === 'opencode' ? discoverOpenCodeModels('fake', runner)
      : provider === 'openclaw' ? discoverOpenClawModels('fake', runner)
        : provider === 'pi' ? discoverPiModels('fake', runner)
          : provider === 'omp' ? discoverOmpModels('fake', runner)
            : provider === 'codex' ? discoverCodexDebugModels('fake', runner, { now: () => now })
              : discoverGrokBuildModels({ runner, env: { HOME: root } });
    const options = { aiwgRoot: root, cacheFile, inventory, forceRefresh: true, now: () => now,
      nativeDiscoverers: { [provider]: async () => ({ ...await discover(), observedAt: now.toISOString() }) } };
    const first = (await resolveDynamicModelCatalog(options)).discovery!.providers[provider];
    expect(first.errorKind).toBeUndefined();
    ids = ['current-code'];
    malformed = true;
    now = new Date('2026-10-08T12:00:00.000Z');
    const partial = (await resolveDynamicModelCatalog(options)).discovery!.providers[provider];
    expect(partial.errorKind).toBe('invalid-output');
    expect(partial.models).toHaveLength(2);
    expect(partial.models[1]).toEqual(first.models[1]);
    expect(partial.observedAt).toBe(first.observedAt);
    if (provider === 'pi' || provider === 'opencode') {
      expect(partial.error).toContain(`line ${provider === 'pi' ? 3 : 2}`);
    } else {
      expect(partial.error).toContain('/models/1');
      expect(partial.error).toContain('/models/2');
    }
    if (provider === 'codex') expect(retirementGuard('synthetic/retired-code', partial.models[1]).blocked).toBe(true);
    malformed = false;
    const complete = (await resolveDynamicModelCatalog(options)).discovery!.providers[provider];
    expect(complete.errorKind).toBeUndefined();
    expect(complete.models.map(model => model.id)).toEqual(['synthetic/current-code']);
    expect(complete.observedAt).toBe(now.toISOString());
  });

  it.each(['truncated', 'invalid-shape', 'invalid-row', 'invalid-date'])('Muse valid + %s file preserves cached retirement and age', async corruption => {
    const { root, cacheFile, inventory } = await fixture();
    inventory.providers = [{ ...inventory.providers[0], id: 'muse' }];
    const catalogDir = join(root, 'muse-catalog');
    await mkdir(catalogDir);
    const validFile = join(catalogDir, 'current.json');
    const badFile = join(catalogDir, 'retired.json');
    const payload = (rows: unknown[], timestamp = evidenceNow.toISOString()) => JSON.stringify({ rows, fetchedAt: timestamp });
    await writeFile(validFile, payload([evidenceRow]));
    await writeFile(badFile, payload([{ ...evidenceRow, model_id: 'retired-code', retired: true }]));
    let now = evidenceNow;
    const options = { aiwgRoot: root, cacheFile, inventory, forceRefresh: true, now: () => now,
      nativeDiscoverers: { muse: () => discoverMuseCatalogModels({ catalogDir, now: () => now }) } };
    const first = (await resolveDynamicModelCatalog(options)).discovery!.providers.muse;
    expect(first.errorKind).toBeUndefined();
    const retired = first.models.find(model => model.id === 'retired-code')!;
    now = new Date('2026-10-08T12:00:00.000Z');
    await writeFile(validFile, payload([evidenceRow], now.toISOString()));
    await writeFile(badFile, corruption === 'truncated' ? '{"rows":['
      : corruption === 'invalid-shape' ? '{"rows":{}}'
        : payload([corruption === 'invalid-row' ? { missing: 'model_id' } : { ...evidenceRow, release_date: 'not-a-date' }]));
    const partial = (await resolveDynamicModelCatalog(options)).discovery!.providers.muse;
    expect(partial.errorKind).toBe('invalid-output');
    expect(partial.error).toContain(badFile);
    expect(partial.observedAt).toBe(first.observedAt);
    expect(partial.models.find(model => model.id === retired.id)).toEqual(retired);
    expect(retirementGuard(retired.id, partial.models.find(model => model.id === retired.id)).blocked).toBe(true);
    await rm(badFile);
    const complete = (await resolveDynamicModelCatalog(options)).discovery!.providers.muse;
    expect(complete.errorKind).toBeUndefined();
    expect(complete.models.map(model => model.id)).toEqual([evidenceRow.model_id]);
    expect(complete.observedAt).toBe(now.toISOString());
  });

  it('keeps only the last 4 KiB of Codex app-server stderr and redacts timeout errors', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 54321,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const tail = 'x'.repeat(4096 - ' token=synthetic-secret-token'.length) + ' token=synthetic-secret-token';
    child.stdin.on('data', () => {
      child.stderr.write('discarded-prefix' + 'a'.repeat(4096));
      child.stderr.write(tail);
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const result = await discoverCodexModels('fake-codex', 10, async () => ({ stdout: 'fixture', stderr: '', exitCode: 0 }));
    expect(result.errorKind).toBe('timeout');
    expect(result.error).toBe('Codex app-server model/list timed out: ' + tail.replace('synthetic-secret-token', '[REDACTED]'));
    expect(child.kill).toHaveBeenCalled();
  });

  it.each(['mixed', 'truncated', 'pagination', 'rpc-error', 'complete'])('Codex app-server %s response uses the same completeness rules', async shape => {
    const response = shape === 'rpc-error' ? { id: 2, error: { message: 'synthetic failure' } }
      : { id: 2, result: { data: [{ model: 'current-code' }, ...(shape === 'mixed' ? [null, {}] : [])],
        ...(shape === 'pagination' ? { nextCursor: 'page-2' } : {}) } };
    const child = Object.assign(new EventEmitter(), {
      pid: 54321,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(),
    });
    child.stdin.on('data', chunk => {
      const request = JSON.parse(String(chunk));
      queueMicrotask(() => {
        if (request.id === 1) child.stdout.write(JSON.stringify({ id: 1, result: { serverInfo: { version: 'fixture' } } }) + '\n');
        if (request.id === 2) {
          if (shape === 'truncated') child.stdout.write('{truncated\n');
          child.stdout.write(JSON.stringify(response) + '\n');
        }
      });
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const next = await discoverCodexModels('fake-codex', 1000, async () => ({ stdout: 'fixture', stderr: '', exitCode: 0 }));
    const prior: ProviderModelDiscovery = { provider: 'codex', source: 'native', accountScope: 'local-account',
      observedAt: evidenceNow.toISOString(), models: [{ id: 'retired-code' }] };
    const merged = mergeProviderDiscovery(prior, next);
    if (shape === 'complete') {
      expect(next.errorKind).toBeUndefined();
      expect(merged.models.map(model => model.id)).toEqual(['current-code']);
    } else {
      expect(next.errorKind).toBe(shape === 'rpc-error' ? 'command' : 'invalid-output');
      expect(merged.models).toContainEqual(prior.models[0]);
      expect(merged.observedAt).toBe(prior.observedAt);
      if (shape === 'mixed') expect(next.error).toContain('/result/data/1');
      if (shape === 'truncated') expect(next.error).toContain('line 2');
      if (shape === 'pagination') expect(next.error).toContain('/result/nextCursor');
    }
  });
});

it('normalizes inference identity from real providerless Codex and provider_id Muse rows', () => {
  const options = { cliId: 'codex', source: 'fixture:real-shape', runtimeVersion: '0.163.0', accountScope: 'local-account' as const };
  const codex = normalizeCodexDebugModels({ models: [{ slug: 'synthetic-code', visibility: 'list' }] }, options).models[0];
  expect(codex.llmProvider).toBe('openai');
  expect(codex.apiModelId).toBe('synthetic-code');
  const muse = normalizeMuseCatalogRows({ rows: [{ model_id: 'synthetic-muse', provider_id: 'meta' }] }, { ...options, cliId: 'muse' }).models[0];
  expect(muse.llmProvider).toBe('meta');
  expect(muse.apiModelId).toBe('synthetic-muse');
  expect(muse.worker!.provenance[0].fields).toContain('/llmProvider');
  const unknown = normalizeMuseCatalogRows({ rows: [{ model_id: 'synthetic-muse' }] }, { ...options, cliId: 'muse' }).models[0];
  expect(unknown.llmProvider).toBeUndefined();
});

describe('#3083 native catalog context and delegation facts', () => {
  it.each([
    [{ context_window: 500000, max_context_window: 872000, effective_context_window_percent: 95 }, 475000],
    [{ context_window: 272000, max_context_window: 872000, effective_context_window_percent: 95 }, 258400],
    [{ context_window: 500000, max_context_window: 272000, effective_context_window_percent: 95 }, 258400],
    [{ context_window: 1001, effective_context_window_percent: 95 }, 950],
    [{ context_window: 32000 }, 32000],
    [{ max_context_window: 872000 }, null],
  ])('bounds context using the active catalog window: %j', (limits, expected) => {
    const result = normalizeCodexDebugModels({ models: [{ slug: 'synthetic-code', ...limits }] }, evidenceOptions);
    expect(result.diagnostics).toEqual([]);
    expect(result.models[0].worker).toMatchObject({ contextTokens: expected, maxOutputTokens: null });
    expect(result.models[0].worker!.provenance[0].fields).toContain('/contextTokens:context_window+max_context_window+effective_context_window_percent');
    expect(validateWorkerModelObservation(result.models[0].worker)).toEqual([]);
  });

  it.each([
    { max_context_window: -1 }, { max_context_window: '872000' },
    { effective_context_window_percent: 0 }, { effective_context_window_percent: 101 },
    { effective_context_window_percent: '95' }, { context_window: 3.5 },
  ])('keeps malformed context facts unknown: %j', limits => {
    const result = normalizeCodexDebugModels({ models: [{ slug: 'synthetic-code', context_window: 500000, ...limits }] }, evidenceOptions);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.models[0].worker!.contextTokens).toBeNull();
  });

  it.each(['codex', 'muse'] as const)('%s distinguishes ultra delegation from ordinary reasoning and child effort', cli => {
    const ids = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const levels = ids.map(id => ({ [cli === 'codex' ? 'effort' : 'tier']: id,
      description: id === 'ultra' ? 'Maximum reasoning with automatic task delegation' : 'Reasoning depth' }));
    const normalize = (raw: unknown) => cli === 'codex'
      ? normalizeCodexDebugModels({ models: [{ slug: 'synthetic-code', supported_reasoning_levels: raw,
        multi_agent_reasoning_effort: 'xhigh', multi_agent_version: 'v2' }] }, { ...evidenceOptions, cliId: cli })
      : normalizeMuseCatalogRows({ rows: [{ model_id: 'synthetic-code', reasoning_effort_variants: raw }] }, { ...evidenceOptions, cliId: cli });
    for (const raw of [levels, ids]) {
      const worker = normalize(raw).models[0].worker!;
      expect(worker.effortSupport).toBe('explicit');
      expect(worker.efforts).toEqual(ids.map(id => ({ id, selfDelegates: id === 'ultra' })));
      expect(worker.dataUse).toEqual({ processing: 'unknown', productImprovement: null, retentionDays: null });
      expect(validateWorkerModelObservation(worker)).toEqual([]);
    }
  });
});
