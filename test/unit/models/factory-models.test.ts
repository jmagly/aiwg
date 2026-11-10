// Factory config observations use a disposable HOME and a version-only fake runner.
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PROVIDER_DISCOVERY_DECISIONS, resolveDynamicModelCatalog } from '../../../src/models/model-discovery.js';
import { assertOperatorWorkerNativeArgv, inspectWorkerInvocationProfile, loadProviderModelCapabilities,
  validateWorkerCatalogDiscovery, WORKER_OPERATOR_APPROVAL } from '../../../src/models/provider-policy.js';
import { discoverFactoryModels } from '../../../src/models/factory-models.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const id = 'custom:AIWG-OpenRouter-Qwen-3.8-27B';
const row = { model: 'qwen/qwen3.8-27b', displayName: 'AIWG OpenRouter Qwen 3.8 27B',
  baseUrl: 'https://openrouter.ai/api/v1', provider: 'generic-chat-completion-api', maxOutputTokens: 8192 };
async function fixture(customModels: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-factory-models-')); roots.push(root);
  await mkdir(join(root, '.factory'));
  await writeFile(join(root, '.factory/settings.json'), JSON.stringify({ customModels }));
  await mkdir(join(root, 'agentic/code/providers'), { recursive: true });
  await writeFile(join(root, 'agentic/code/providers/model-catalog.v1.json'), JSON.stringify({ version: '1',
    providers: { factory: { roles: { coding: { id: 'claude-sonnet-5' } } } } }));
  const runner = vi.fn(async (_command: string, args: string[]) => {
    expect(args).toEqual(['--version']);
    return { stdout: 'droid-cli 1.0.0\n', stderr: '', exitCode: 0 };
  });
  const cacheFile = join(root, 'catalog.json');
  const refresh = () => resolveDynamicModelCatalog({ aiwgRoot: root, homeDir: root, cacheFile,
    inventory: { generatedAt: '', projectDir: root, activeProvider: 'factory', activeSource: 'env',
      providers: [{ id: 'factory', displayName: 'Factory', configured: true, deployed: true,
        detected: true, available: true, active: true, evidence: [], reasons: [] }] },
    allowNetwork: true, forceRefresh: true, runner, now: () => new Date('2026-11-10T15:00:00Z') });
  return { root, cacheFile, runner, refresh };
}

it('observes custom selectors with runtime provenance while preserving static plan pins', async () => {
  const f = await fixture([row]);
  const result = await f.refresh();
  expect(PROVIDER_DISCOVERY_DECISIONS.factory.status).toBe('native');
  expect(result.providers.factory.roles.coding).toEqual({ id: 'claude-sonnet-5' });
  const observed = result.discovery!.providers.factory;
  expect(observed).toMatchObject({ source: 'native', observedAt: '2026-11-10T15:00:00.000Z',
    runtimeVersion: '1.0.0', accountScope: 'local-account', models: [{ id, apiModelId: id,
      llmProvider: 'openrouter', displayName: row.displayName, worker: { runtimeVersion: '1.0.0',
        accountScope: 'local-account', effortSupport: 'not-applicable', efforts: [], contextTokens: null,
        maxOutputTokens: 8192, qualification: { status: 'unqualified' } } }] });
  expect(observed.models[0].worker!.provenance[0].source).toContain('.factory/settings.json#/customModels/0');
  expect(validateWorkerCatalogDiscovery(result.discovery)).toEqual([]);
  expect(f.runner).toHaveBeenCalledOnce();
});

it.each([1, 131072, Number.MAX_SAFE_INTEGER])('records maxContextLimit %s as reported input context with provenance', async maxContextLimit => {
  const f = await fixture([{ ...row, maxContextLimit }]);
  const result = await f.refresh();
  const observed = result.discovery!.providers.factory;
  expect(observed.models[0].worker).toMatchObject({ contextTokens: maxContextLimit, maxOutputTokens: 8192 });
  expect(observed.models[0].worker!.provenance).toContainEqual(expect.objectContaining({
    source: `${join(f.root, '.factory/settings.json')}#/customModels/0`, kind: 'native', confidence: 'reported',
    fields: expect.arrayContaining(['/contextTokens', '/contextTokens:maxContextLimit']),
  }));
  expect(validateWorkerCatalogDiscovery(result.discovery)).toEqual([]);
  expect(JSON.parse(await readFile(f.cacheFile, 'utf8')).discovery.providers.factory.models[0].worker.contextTokens)
    .toBe(maxContextLimit);
});

it('changes the evidence digest when the configured context limit changes or disappears', async () => {
  const f = await fixture([]);
  const digests: string[] = [];
  for (const maxContextLimit of [131072, 262144, undefined]) {
    await writeFile(join(f.root, '.factory/settings.json'), JSON.stringify({ customModels: [{ ...row, maxContextLimit }] }));
    const observed = await discoverFactoryModels({ homeDir: f.root, runtimeVersion: '1.0.0',
      now: () => new Date('2026-11-10T15:00:00Z') });
    expect(observed.models[0].worker!.contextTokens).toBe(maxContextLimit ?? null);
    digests.push(observed.models[0].worker!.evidenceDigest!);
  }
  expect(new Set(digests).size).toBe(3);
});

it.each(['apiKey', 'api_key'])('discards %s before observation and cache digests', async field => {
  const literal = 'synthetic-key-must-never-leave-config';
  const configured = { ...row, maxContextLimit: 131072 };
  const f = await fixture([{ ...configured, [field]: literal }]);
  const first = await f.refresh();
  expect(first.discovery!.providers.factory.models).toHaveLength(1);
  const text = await readFile(f.cacheFile, 'utf8');
  expect(JSON.stringify(first) + text).not.toContain(literal);
  expect(text).not.toMatch(/apiKey|api_key/);
  await writeFile(join(f.root, '.factory/settings.json'), JSON.stringify({ customModels: [{ ...configured, [field]: '${MISSING_SECRET}' }] }));
  const second = await f.refresh();
  expect(second.discovery!.providers.factory.models[0].worker!.evidenceDigest)
    .toBe(first.discovery!.providers.factory.models[0].worker!.evidenceDigest);
});

it.each(['missing', 'empty', 'malformed', 'shape', 'array', 'oversized', 'symlink'])('handles %s settings without exposing content', async shape => {
  const f = await fixture([]);
  const file = join(f.root, '.factory/settings.json');
  const literal = 'synthetic-secret-in-invalid-settings';
  if (shape === 'missing' || shape === 'symlink') await rm(file);
  if (shape === 'symlink') {
    const target = join(f.root, 'not-settings.json');
    await writeFile(target, JSON.stringify({ customModels: [row] }));
    await symlink(target, file);
  }
  if (shape === 'malformed') await writeFile(file, `{"apiKey":"${literal}",BROKEN`);
  if (shape === 'shape') await writeFile(file, 'null');
  if (shape === 'array') await writeFile(file, '{"customModels":{}}');
  if (shape === 'oversized') await writeFile(file, ' '.repeat(1024 * 1024 + 1));
  const observed = await discoverFactoryModels({ homeDir: f.root, runtimeVersion: '1.0.0' });
  expect(observed.models).toEqual([]);
  expect(observed.errorKind).toBe(shape === 'empty' ? undefined : shape === 'missing' ? 'unsupported' : 'invalid-output');
  expect(JSON.stringify(observed)).not.toContain(literal);
});

it('keeps valid rows with bounded diagnostics and rejects ambiguous custom selectors', async () => {
  const f = await fixture([row, null, { ...row, displayName: 'duplicate name' },
    { ...row, displayName: 'duplicate-name' }, { ...row, displayName: 'bad host', baseUrl: 'invalid' },
    { ...row, displayName: 'bad limit', maxOutputTokens: -1 }]);
  const observed = await discoverFactoryModels({ homeDir: f.root, runtimeVersion: '1.0.0' });
  expect(observed.errorKind).toBe('invalid-output');
  expect(observed.models.map(model => model.id)).toEqual([id]);
  expect(observed.error).toContain('/customModels/1');
  expect(observed.error).toContain('ambiguous');
});

it('uses endpoint identity instead of the upstream model vendor or generic API protocol', async () => {
  const f = await fixture([{ ...row, baseUrl: 'http://localhost:8000/v1' },
    { ...row, displayName: 'unknown endpoint', baseUrl: undefined }]);
  const observed = await discoverFactoryModels({ homeDir: f.root, runtimeVersion: '1.0.0', accountBinding: 'custom-account', cliId: 'factory-byok' });
  expect(observed.models).toHaveLength(1);
  expect(observed.models[0]).toMatchObject({ llmProvider: 'localhost', worker: { cliId: 'factory-byok', accountScope: 'custom-account' } });
  expect(observed.errorKind).toBe('invalid-output');
});

it('withholds observations if the runtime version cannot be established', async () => {
  const f = await fixture([row]);
  const observed = await discoverFactoryModels({ homeDir: f.root,
    runner: async () => ({ stdout: '', stderr: 'apiKey=synthetic-probe-secret', exitCode: 1 }) });
  expect(observed).toMatchObject({ models: [], errorKind: 'command' });
  expect(JSON.stringify(observed)).not.toContain('synthetic-probe-secret');
});

it.each([
  ['ftp endpoint', { baseUrl: 'ftp://openrouter.ai/models' }],
  ['unknown protocol without endpoint', { baseUrl: undefined }],
  ['null row', null], ['scalar row', 'invalid'], ['array row', []],
  ['non-string model', { model: 42 }], ['empty model', { model: '' }],
  ['whitespace model', { model: 'qwen model' }],
  ['non-string name', { displayName: 42 }], ['empty name', { displayName: '' }],
  ['padded name', { displayName: ' padded ' }], ['control in name', { displayName: 'bad\u0000name' }],
  ['non-string provider', { provider: null }],
  ['fractional limit', { maxOutputTokens: 1.5 }], ['zero limit', { maxOutputTokens: 0 }],
  ['null context limit', { maxContextLimit: null }], ['string context limit', { maxContextLimit: '131072' }],
  ['boolean context limit', { maxContextLimit: true }], ['object context limit', { maxContextLimit: {} }],
  ['array context limit', { maxContextLimit: [] }], ['zero context limit', { maxContextLimit: 0 }],
  ['negative context limit', { maxContextLimit: -1 }], ['fractional context limit', { maxContextLimit: 1.5 }],
  ['unsafe context limit', { maxContextLimit: Number.MAX_SAFE_INTEGER + 1 }],
  ['overflowing context limit', { maxContextLimit: 1e100 }],
] as const)('rejects %s with an indexed diagnostic while preserving valid siblings', async (_label, patch) => {
  const invalid = patch && typeof patch === 'object' && !Array.isArray(patch) ? { ...row, ...patch } : patch;
  const f = await fixture([row, invalid]);
  const observed = await discoverFactoryModels({ homeDir: f.root, runtimeVersion: '1.0.0' });
  expect(observed.models.map(model => model.id)).toEqual([id]);
  expect(observed.errorKind).toBe('invalid-output');
  expect(observed.error).toBe('Factory /customModels/1: malformed model fields or unknown inference provider.');
});

it.each([
  ['openai', undefined, 'openai'], ['anthropic', undefined, 'anthropic'],
  ['generic-chat-completion-api', 'https://api.openai.com/v1', 'openai'],
  ['generic-chat-completion-api', 'https://api.anthropic.com/v1', 'anthropic'],
] as const)('identifies %s at %s without requiring an output-token limit', async (provider, baseUrl, llmProvider) => {
  const f = await fixture([{ ...row, provider, baseUrl, maxOutputTokens: undefined }]);
  const observed = await discoverFactoryModels({ homeDir: f.root, runtimeVersion: '1.0.0' });
  expect(observed.errorKind).toBeUndefined();
  expect(observed.models).toMatchObject([{ id, llmProvider, worker: { maxOutputTokens: null } }]);
});

it.each(['{}', '[]', 'false', '"scalar"', '{"customModels":null}'])('handles settings root %s explicitly', async contents => {
  const f = await fixture([]);
  await writeFile(join(f.root, '.factory/settings.json'), contents);
  const observed = await discoverFactoryModels({ homeDir: f.root, runtimeVersion: '1.0.0' });
  expect(observed.models).toEqual([]);
  expect(observed.errorKind).toBe(contents === '{}' ? undefined : 'invalid-output');
});

it('rejects more than 1024 rows before producing observations', async () => {
  const f = await fixture(Array.from({ length: 1025 }, () => row));
  const observed = await discoverFactoryModels({ homeDir: f.root, runtimeVersion: '1.0.0' });
  expect(observed).toMatchObject({ models: [], errorKind: 'invalid-output',
    error: 'Factory /customModels: expected bounded array.' });
});

it('rejects a settings directory without treating it as a model list', async () => {
  const f = await fixture([]);
  const file = join(f.root, '.factory/settings.json');
  await rm(file);
  await mkdir(file);
  const observed = await discoverFactoryModels({ homeDir: f.root, runtimeVersion: '1.0.0' });
  expect(observed).toMatchObject({ models: [], errorKind: 'invalid-output' });
});

it.each(['throws', 'unexpected banner', 'plain version'])('handles a version probe that returns %s', async mode => {
  const f = await fixture([row]);
  const runner = vi.fn(async () => {
    if (mode === 'throws') throw new Error('synthetic-probe-secret');
    return { stdout: mode === 'plain version' ? '1.0.0\n' : 'synthetic-probe-secret', stderr: '', exitCode: 0 };
  });
  const observed = await discoverFactoryModels({ homeDir: f.root, runner });
  expect(runner).toHaveBeenCalledWith('droid', ['--version'], { cwd: tmpdir(), timeoutMs: 5000 });
  if (mode === 'plain version') {
    expect(observed.runtimeVersion).toBe('1.0.0');
    expect(observed.models.map(model => model.id)).toEqual([id]);
  } else expect(observed).toMatchObject({ models: [], errorKind: 'command' });
  expect(JSON.stringify(observed)).not.toContain('synthetic-probe-secret');
});

it('checks the exact Factory argv before trusting the operator-approved direct renderer', () => {
  const adapter = structuredClone(loadProviderModelCapabilities().providers.factory.workerHealthAdapter!);
  adapter.qualification = { status: 'qualified', evidenceRef: WORKER_OPERATOR_APPROVAL,
    fixtureDigest: `sha256:${'1'.repeat(64)}`, verifiedAt: new Date().toISOString() };
  const selected = { model: id, effort: { value: null } };
  const argv = ['droid', 'exec', '-m', id, '--cwd', '/tmp/work', '--output-format', 'stream-json'];
  expect(() => assertOperatorWorkerNativeArgv(adapter, argv, selected, { sandbox: 'read-only' })).not.toThrow();
  for (const extra of [['--skip-permissions-unsafe'], ['-m', 'other'], ['--auto', 'high'],
    ['--mission'], ['-r', 'high'], ['--cwd', '/other'], ['--', 'prompt']]) {
    expect(() => assertOperatorWorkerNativeArgv(adapter, [...argv, ...extra], selected, { sandbox: 'read-only' })).toThrow();
  }
  expect(() => inspectWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell',
    cliVersion: '1.0.0', permissions: { sandbox: 'read-only' } })).not.toThrow();
  expect(() => inspectWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell',
    cliVersion: '1.0.0', requiredControls: ['fallback'] })).toThrow('unqualified');
});
