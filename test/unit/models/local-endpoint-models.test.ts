// T-OG-03/12: endpoint-only observations using a loopback HTTP fixture.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import * as catalogFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localModelEndpoint } from '../../fixtures/local-model-endpoint.js';
import { discoverLocalEndpointModels, localModelsUrl } from '../../../src/models/local-endpoint-models.js';
import { resolveDynamicModelCatalog, type ModelDiscoveryOptions } from '../../../src/models/model-discovery.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { resolveWorkerPlan } from '../../../src/models/resolver.js';
import { validateParallelismConfig } from '../../../src/config/worker-parallelism.js';
import { validateWorkerCatalogDiscovery } from '../../../src/models/provider-policy.js';
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rename: vi.fn(original.rename) };
});
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const server = await localModelEndpoint();
  cleanup.push(server.close);
  const source = { endpoint: server.endpoint, models: [{ id: 'synthetic-model', checkpoint: 'fixture-revision',
    contextTokens: 32000, maxOutputTokens: 4096, efforts: ['medium'] }] };
  const observe = (extra = {}) => discoverLocalEndpointModels({ cli: 'local-codex', provider: 'codex', source,
    runtimeVersion: '0.161.0', accountBinding: 'fixture', ...extra });
  return { ...server, source, observe };
}
async function cacheFixture(vendor?: string) {
  const f = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-mixed-model-cache-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const now = () => new Date('2026-11-15T12:00:00.000Z');
  const vendorDiscoverer = vi.fn(async () => ({ provider: vendor!, source: 'native' as const,
    observedAt: now().toISOString(), accountScope: 'local-account' as const,
    accountBinding: 'fixture-vendor', models: [{ id: 'synthetic-vendor-model', isDefault: true }] }));
  const localVendorDiscoverer = vi.fn(async () => { throw new Error('endpoint CLI must not use vendor discovery'); });
  const options: ModelDiscoveryOptions = { aiwgRoot: process.cwd(), homeDir: root, now, remoteUrl: '',
    inventory: { projectDir: root, generatedAt: '', activeProvider: null, activeSource: '',
      providers: [...new Set(['codex', ...(vendor ? [vendor] : [])])].map(id => ({ id, displayName: id,
        configured: true, deployed: true, detected: true, available: true, active: false, evidence: [], reasons: [] })) },
    parallelism: { clis: {
      ...(vendor ? { vendor: { adapter: `providers:${vendor}`, accountScope: 'fixture-vendor', quotaScope: 'vendor' } } : {}),
      'codex-dtg-ext': { adapter: 'providers:codex', accountScope: 'fixture-local', quotaScope: 'local', localModels: f.source },
    } },
    nativeDiscoverers: { codex: localVendorDiscoverer, ...(vendor ? { [vendor]: vendorDiscoverer } : {}) },
    runner: vi.fn(async () => ({ stdout: 'codex-cli 0.161.0', stderr: '', exitCode: 0 })) };
  return { ...f, options, vendorDiscoverer, localVendorDiscoverer,
    cacheFile: path.join(root, '.cache/aiwg/model-catalog.v1.json') };
}
describe('declared self-hosted model observations (T-OG-03/12)', () => {
  it('records endpoint presence, declared checkpoint and local processing without approving roles', async () => {
    const f = await fixture();
    const result = await f.observe();
    expect(f.requests).toEqual([{ path: '/v1/models', authorization: undefined }]);
    expect(result.source).toBe('local-endpoint');
    expect(result.models[0].worker).toMatchObject({ endpoint: f.endpoint, checkpoint: 'fixture-revision',
      availability: 'accessible', dataUse: { processing: 'local', productImprovement: null },
      qualification: { status: 'unqualified', roles: [] } });
    expect(validateWorkerCatalogDiscovery({ source: 'local-endpoint', fetchedAt: result.observedAt,
      providers: {}, instances: { 'local-codex': result } })).toEqual([]);
  });
  it.each(['down', '401', 'missing', 'timeout', 'invalid', 'redirect', 'auth-missing'])(
    'returns typed unavailable observations for %s', async mode => {
      const f = await fixture();
      if (mode === 'down') await f.close();
      if (mode === '401') f.state.status = 401;
      if (mode === 'missing') f.state.ids = [];
      if (mode === 'timeout') { f.state.hang = true; Object.assign(f.source, { timeoutMs: 30 }); }
      if (mode === 'invalid') f.state.invalid = true;
      if (mode === 'redirect') { f.state.status = 302; f.state.redirect = 'http://not-declared.invalid/models'; }
      if (mode === 'auth-missing') Object.assign(f.source, { authEnv: 'SYNTHETIC_TOKEN' });
      const result = await f.observe({ env: {} });
      expect(result.models[0].worker).toMatchObject({ availability: 'unavailable',
        unavailableReason: ({ down: 'endpoint-down', '401': 'unauthorized', missing: 'model-missing', timeout: 'timeout',
          invalid: 'invalid-response', redirect: 'endpoint-down', 'auth-missing': 'auth-env-missing' } as any)[mode] });
      expect(result.errorKind).toBeDefined();
      expect(result.models[0].worker?.qualification.status).toBe('unqualified');
    });
  it('uses only an env name and never includes the value in results', async () => {
    const f = await fixture();
    Object.assign(f.source, { authEnv: 'SYNTHETIC_TOKEN' });
    const result = await f.observe({ env: { SYNTHETIC_TOKEN: 'fixture-secret' } });
    expect(f.requests[0].authorization).toBe('Bearer fixture-secret');
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
  it('denies undeclared hosts and embedded credentials before fetching', async () => {
    const f = await fixture();
    f.source.endpoint = 'http://undeclared.invalid/v1';
    const fetchImpl = vi.fn();
    expect((await f.observe({ fetchImpl })).models[0].worker?.unavailableReason).toBe('host-denied');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(localModelsUrl({ ...f.source, allowedHosts: ['undeclared.invalid'] }).hostname).toBe('undeclared.invalid');
    for (const endpoint of ['http://user:secret@127.0.0.1/v1', 'http://127.0.0.1/v1?token=secret']) {
      expect(() => localModelsUrl({ ...f.source, endpoint })).toThrow();
    }
  });
  it('validates declarations with the governed schema and rejects literals and duplicate IDs', async () => {
    const f = await fixture();
    const config = { clis: { local: { adapter: 'providers:codex', accountScope: 'fixture', quotaScope: 'fixture', localModels: f.source } } };
    expect(validateParallelismConfig(config)).toEqual([]);
    expect(validateParallelismConfig({ clis: { local: { ...config.clis.local,
      localModels: { ...f.source, token: 'literal' } } } })).not.toEqual([]);
    f.source.models.push(f.source.models[0]);
    expect(validateParallelismConfig(config).join()).toContain('Duplicate model ID');
  });
  it('allowedProcessing local selects the local member and excludes a higher-priority remote member', () => {
    const f = workerResolutionFixture();
    const rows = f.snapshot.catalog.discovery!.instances!.codex.models;
    rows[0].worker!.dataUse.processing = 'remote';
    rows[1].worker!.dataUse.processing = 'local';
    f.snapshot.models.defaults.workerSelection!.dataPolicy!.allowedProcessing = ['local'];
    const result = resolveWorkerPlan(f.snapshot, f.request);
    expect(result.selected?.member).toBe('alternate');
    expect(result.exclusions.find(row => row.member === 'primary')?.diagnostics.map(d => d.code)).toContain('OG_DATA_POLICY');
  });
  it('refreshes only declared endpoints and sources reads cache without network', async () => {
    const f = await fixture();
    const root = await mkdtemp(path.join(tmpdir(), 'aiwg-local-model-cache-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const options = { aiwgRoot: process.cwd(), homeDir: root, remoteUrl: 'http://not-declared.invalid',
      inventory: { projectDir: root, providers: [], generatedAt: '', activeProvider: null, activeSource: '' },
      parallelism: { clis: { local: { adapter: 'providers:codex', accountScope: 'fixture', quotaScope: 'fixture', localModels: f.source } } },
      runner: vi.fn(async () => ({ stdout: 'codex-cli 0.161.0', stderr: '', exitCode: 0 })) };
    const catalog = await resolveDynamicModelCatalog({ ...options, forceRefresh: true, allowNetwork: true });
    expect(catalog.discovery?.instances?.local.models[0].worker?.runtimeVersion).toBe('0.161.0');
    const noFetch = vi.fn();
    const cached = await resolveDynamicModelCatalog({ ...options, allowNetwork: false, fetchImpl: noFetch });
    expect(cached.discovery?.instances?.local).toEqual(catalog.discovery?.instances?.local);
    expect(f.requests).toHaveLength(1);
    expect(noFetch).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, '.cache/aiwg/model-catalog.v1.json'), 'utf8')).toContain('local-endpoint');
  });
  it.each(['codex', 'muse'])('merges %s vendor and endpoint instances in one cache write and reads both offline', async vendor => {
    const f = await cacheFixture(vendor);
    const rename = vi.mocked(catalogFs.rename);
    const refreshed = await resolveDynamicModelCatalog({ ...f.options, forceRefresh: true, allowNetwork: true });
    const vendorId = `${vendor}:fixture-vendor`;
    expect(refreshed.discovery?.instances?.[vendorId].models[0].id).toBe('synthetic-vendor-model');
    expect(refreshed.discovery?.providers[vendor]).toEqual(refreshed.discovery?.instances?.[vendorId]);
    expect(refreshed.discovery?.instances?.['codex-dtg-ext'].models[0].id).toBe('synthetic-model');
    expect(validateWorkerCatalogDiscovery(refreshed.discovery)).toEqual([]);
    expect(f.vendorDiscoverer).toHaveBeenCalledOnce();
    expect(f.localVendorDiscoverer).not.toHaveBeenCalled();
    expect(rename).toHaveBeenCalledOnce();
    const onDisk = JSON.parse(await readFile(f.cacheFile, 'utf8'));
    expect(onDisk.discovery.instances).toEqual(refreshed.discovery?.instances);
    expect(onDisk.discovery.providers[vendor]).toEqual(refreshed.discovery?.providers[vendor]);
    const noFetch = vi.fn(() => { throw new Error('unexpected network'); });
    const noRunner = vi.fn(() => { throw new Error('unexpected CLI probe'); });
    await f.close();
    const cached = await resolveDynamicModelCatalog({ ...f.options, allowNetwork: false, fetchImpl: noFetch, runner: noRunner });
    expect(cached.discovery?.source).toBe('cache');
    expect(cached.discovery?.instances).toEqual(refreshed.discovery?.instances);
    expect(cached.discovery?.providers).toEqual(refreshed.discovery?.providers);
    expect(f.vendorDiscoverer).toHaveBeenCalledOnce();
    expect(f.requests).toHaveLength(1);
    expect(noFetch).not.toHaveBeenCalled();
    expect(noRunner).not.toHaveBeenCalled();
    expect(rename).toHaveBeenCalledOnce();
  });
  it('invalidates only the local observation on declaration drift and refreshes both parts together', async () => {
    const f = await cacheFixture('codex');
    const refreshed = await resolveDynamicModelCatalog({ ...f.options, forceRefresh: true, allowNetwork: true });
    f.source.models[0].checkpoint = 'changed-revision';
    const noFetch = vi.fn(() => { throw new Error('unexpected network'); });
    const cached = await resolveDynamicModelCatalog({ ...f.options, allowNetwork: false, fetchImpl: noFetch });
    expect(cached.discovery?.instances?.['codex:fixture-vendor']).toEqual(refreshed.discovery?.instances?.['codex:fixture-vendor']);
    expect(cached.discovery?.instances?.['codex-dtg-ext']).toBeUndefined();
    expect(f.vendorDiscoverer).toHaveBeenCalledOnce();
    expect(noFetch).not.toHaveBeenCalled();
    const next = await resolveDynamicModelCatalog({ ...f.options, forceRefresh: true, allowNetwork: true });
    expect(next.discovery?.instances?.['codex-dtg-ext'].models[0].worker?.checkpoint).toBe('changed-revision');
    expect(f.vendorDiscoverer).toHaveBeenCalledTimes(2);
    expect(f.requests).toHaveLength(2);
    expect(JSON.parse(await readFile(f.cacheFile, 'utf8')).discovery.instances).toEqual(next.discovery?.instances);
  });
  it('keeps local digest reuse independent of vendor TTL and never vendor-discovers a local-only CLI', async () => {
    const f = await cacheFixture();
    const refreshed = await resolveDynamicModelCatalog({ ...f.options, forceRefresh: true, allowNetwork: true });
    expect(f.localVendorDiscoverer).not.toHaveBeenCalled();
    expect(refreshed.discovery?.providers).toEqual({});
    expect(Object.keys(refreshed.discovery?.instances ?? {})).toEqual(['codex-dtg-ext']);
    const noFetch = vi.fn(() => { throw new Error('unexpected network'); });
    const { nativeDiscoverers, ...offline } = f.options;
    const cached = await resolveDynamicModelCatalog({ ...offline, ttlMs: -1, allowNetwork: false, fetchImpl: noFetch });
    expect(cached.discovery?.source).toBe('static');
    expect(cached.discovery?.instances).toEqual(refreshed.discovery?.instances);
    expect(noFetch).not.toHaveBeenCalled();
    f.source.models[0].checkpoint = 'changed-revision';
    const drifted = await resolveDynamicModelCatalog({ ...offline, ttlMs: -1, allowNetwork: false, fetchImpl: noFetch });
    expect(drifted.discovery?.instances).toEqual({});
    expect(f.requests).toHaveLength(1);
  });
});
