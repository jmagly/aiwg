// Offline Cursor text discovery: captured listing and bounded fake command runner.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { validateParallelismConfig } from '../../../src/config/worker-parallelism.js';
import { discoverCursorListModels, discoverProjectCursorModels } from '../../../src/models/cursor-models.js';
import { DEFAULT_WORKER_SELECTION, validateWorkerCatalogDiscovery, validateWorkerPolicyRoute } from '../../../src/models/provider-policy.js';
import { resolveDynamicModelCatalog, type ModelDiscoveryCommandRunner, type ModelDiscoveryOptions } from '../../../src/models/model-discovery.js';
import { writeExecutable } from '../../helpers/write-executable.js';

const capture = new URL('../../fixtures/providers/cursor/list-models.txt', import.meta.url);
const options = { runtimeVersion: '2026.11.13-eacade1', accountBinding: 'fixture-account',
  now: () => new Date('2026-11-17T16:00:00Z') };

describe('Cursor list discovery', () => {
  it('parses every captured row, strips notes and zero-width characters, and bounds the command', async () => {
    const stdout = await readFile(capture, 'utf8');
    const runner = vi.fn<ModelDiscoveryCommandRunner>().mockResolvedValue({ stdout, stderr: '', exitCode: 0 });
    const result = await discoverCursorListModels('fixture-cursor', runner, options);
    expect(runner).toHaveBeenCalledExactlyOnceWith('fixture-cursor', ['--list-models'], expect.objectContaining({ timeoutMs: 15000 }));
    expect(result.error).toBeUndefined();
    expect(result.models).toHaveLength(stdout.split('\n').filter(row => row.includes(' - ')).length);
    expect(result.models.find(row => row.id === 'gpt-5.3-codex-high')).toMatchObject({
      apiModelId: 'gpt-5.3-codex-high', llmProvider: 'cursor', displayName: 'Codex 5.3 High',
      worker: { runtimeVersion: options.runtimeVersion, accountScope: 'fixture-account', availability: 'accessible',
        family: 'unknown', contextTokens: null, maxOutputTokens: null, qualification: { status: 'unqualified' },
        effortSupport: 'explicit', efforts: [{ id: 'high', selfDelegates: null }] },
    });
    expect(result.models.find(row => row.id === 'gpt-5.5-extra-high')?.worker?.efforts[0].id).toBe('xhigh');
    expect(result.models.find(row => row.id === 'composer-2.5')).toMatchObject({ displayName: 'Composer 2.5', worker: { effortSupport: 'unknown' } });
    expect(result.models.find(row => row.id === 'grok-4.7-low-fast')?.displayName).toBe('Grok 4.7  Low Fast');
    expect(result.models.find(row => row.id === 'auto')).toMatchObject({ isDefault: true, worker: { availability: 'unavailable', efforts: [] } });
    expect(validateWorkerCatalogDiscovery({ source: 'native', fetchedAt: result.observedAt, providers: { cursor: result } })).toEqual([]);
  });

  it.each(['Claude Opus 5 1M Thinking', 'GPT-5.6 Sol 1M High'])('records the standalone display-name 1M token: %s', async name => {
    const result = await discoverCursorListModels('fake', async () => ({ stdout: `fixture-high - ${name}`, stderr: '', exitCode: 0 }), options);
    expect(result.models[0].worker?.contextTokens).toBe(1_000_000);
    expect(result.models[0].worker?.provenance[0].fields).toContain('/contextTokens:display-name-1M');
  });

  it.each(['1m', '2M', '128K', 'X1M', '1MB', '1M-fast', '(1M)'])('does not infer limits from %s', async name => {
    const result = await discoverCursorListModels('fake', async () => ({ stdout: `fixture-high - Model ${name} High`, stderr: '', exitCode: 0 }), options);
    expect(result.models[0].worker?.contextTokens).toBeNull();
  });

  it('validates operator fixtures and gives declared limits precedence with separate provenance', async () => {
    const modelLimits = JSON.parse(await readFile(new URL('../../fixtures/providers/cursor/model-limits.valid.json', import.meta.url), 'utf8'));
    const invalid = JSON.parse(await readFile(new URL('../../fixtures/providers/cursor/model-limits.invalid.json', import.meta.url), 'utf8'));
    const config = (limits: unknown) => ({ clis: { cursor: { adapter: 'providers:cursor', accountScope: 'fixture', quotaScope: 'fixture', modelLimits: limits } } });
    expect(validateParallelismConfig(config(modelLimits))).toEqual([]);
    for (const limits of invalid) expect(validateParallelismConfig(config(limits)).length, JSON.stringify(limits)).toBeGreaterThan(0);
    const result = await discoverCursorListModels('fake', async () => ({ stdout: await readFile(capture, 'utf8'), stderr: '', exitCode: 0 }),
      { ...options, cliId: 'custom-cursor', modelLimits });
    const override = result.models.find(row => row.id === 'claude-opus-5-thinking-high')!.worker!;
    expect(override).toMatchObject({ contextTokens: 250000, maxOutputTokens: null });
    expect(override.provenance[0].fields).not.toContain('/contextTokens');
    expect(override.provenance).toContainEqual(expect.objectContaining({ source: '/parallelism/clis/custom-cursor/modelLimits',
      fields: ['/contextTokens'], kind: 'operator' }));
    expect(result.models.find(row => row.id === 'gpt-5.3-codex-high')?.worker).toMatchObject({ contextTokens: 200000, maxOutputTokens: 16000 });
  });

  it('detects a version without retaining arbitrary banner text and handles CRLF/current-default notes', async () => {
    const runner = vi.fn<ModelDiscoveryCommandRunner>().mockImplementation(async (_command, args) => ({
      exitCode: 0, stderr: '', stdout: args[0] === '--version' ? '2026.10.01-e373342\n'
        : 'Available models\r\n\r\ngpt-5.3-codex-high - Codex\u200b High (current, default)\r\ndefault - Default\r\n',
    }));
    const result = await discoverCursorListModels(undefined, runner);
    expect(runner).toHaveBeenCalledWith('cursor-agent', ['--version'], expect.objectContaining({ timeoutMs: 5000 }));
    expect(result.runtimeVersion).toBe('2026.10.1-e373342');
    expect(result.models[0]).toMatchObject({ displayName: 'Codex High', isDefault: true });
    expect(result.models[1].worker?.availability).toBe('unavailable');
  });

  it.each(['', 'Available models\n', 'token=do-not-echo\n', 'x - \u200b\n'])('rejects empty or malformed output without reflecting it: %j', async stdout => {
    const result = await discoverCursorListModels('fake', async () => ({ stdout, stderr: '', exitCode: 0 }), options);
    expect(result).toMatchObject({ errorKind: 'invalid-output', models: [] });
    expect(result.error).not.toContain('do-not-echo');
  });

  it('keeps valid rows while reporting malformed and duplicate rows without contents', async () => {
    const result = await discoverCursorListModels('fake', async () => ({ exitCode: 0, stderr: '',
      stdout: 'gpt-5.3-codex-high - Codex\npassword=literal\ngpt-5.3-codex-high - Duplicate\n' }), options);
    expect(result.models).toHaveLength(1);
    expect(result.errorKind).toBe('invalid-output');
    expect(result.error).toContain('line 2');
    expect(result.error).toContain('duplicate');
    expect(result.error).not.toContain('literal');
  });

  it.each([false, true])('redacts not-logged-in diagnostics (stdout: %s)', async useStdout => {
    const message = 'Not logged in; token=literal Authorization: Bearer private';
    const result = await discoverCursorListModels('fake', async () => ({ exitCode: 1,
      stdout: useStdout ? message : '', stderr: useStdout ? '' : message }), options);
    expect(result).toMatchObject({ errorKind: 'authentication', models: [] });
    expect(result.error).toContain('[REDACTED]');
    expect(result.error).not.toMatch(/literal|private/);
  });

  it('reports runner timeouts and thrown failures without credential material', async () => {
    const timeout = await discoverCursorListModels('fake', async () => ({ stdout: '', stderr: 'timed out', exitCode: 124 }), options);
    expect(timeout.errorKind).toBe('timeout');
    const thrown = await discoverCursorListModels('fake', async () => { throw new Error('token=literal'); }, options);
    expect(thrown).toMatchObject({ errorKind: 'command', models: [] });
    expect(thrown.error).not.toContain('literal');
  });

  it.each([1, 0])('does not trust a failed or arbitrary version banner (exit %s)', async exitCode => {
    const runner: ModelDiscoveryCommandRunner = async (_command, args) => args[0] === '--version'
      ? { exitCode, stdout: 'token=private-banner', stderr: '' }
      : { exitCode: 0, stdout: 'fixture-high - Fixture', stderr: '' };
    const result = await discoverCursorListModels('fake', runner);
    expect(result.runtimeVersion).toBeUndefined();
    expect(result.models[0].worker?.runtimeVersion).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('private-banner');
  });

  it('supplies bounded fallback diagnostics for silent exits and non-Error throws', async () => {
    const silent = await discoverCursorListModels('fake', async () => ({ exitCode: 7, stdout: '', stderr: '' }), options);
    expect(silent).toMatchObject({ errorKind: 'command', error: 'Cursor --list-models exited 7', models: [] });
    const thrown = await discoverCursorListModels('fake', async () => { throw 'token=private'; }, options);
    expect(thrown).toMatchObject({ errorKind: 'command', error: 'Cursor discovery command failed', models: [] });
  });

  it('ignores the tip and rejects control characters even in otherwise parseable rows', async () => {
    const result = await discoverCursorListModels('fake', async () => ({ exitCode: 0, stderr: '',
      stdout: 'Tip: use --model <id> to select\nfixture-high - Bad\tName\nvalid-high - Good Name' }), options);
    expect(result.models.map(row => row.id)).toEqual(['valid-high']);
    expect(result.error).toBe('Cursor --list-models line 2: malformed model row');
  });

  it('attributes default CLI operator limits separately from native context and output fields', async () => {
    const result = await discoverCursorListModels('fake', async () => ({ exitCode: 0, stderr: '',
      stdout: 'fixture-high - Model 1M High' }), { ...options,
      modelLimits: { 'fixture-high': { contextTokens: 32000, maxOutputTokens: 4000 } } });
    const worker = result.models[0].worker!;
    expect(worker).toMatchObject({ contextTokens: 32000, maxOutputTokens: 4000 });
    expect(worker.provenance[0].fields).not.toContain('/contextTokens:display-name-1M');
    expect(worker.provenance[0].fields).not.toContain('/contextTokens');
    expect(worker.provenance[0].fields).not.toContain('/maxOutputTokens');
    expect(worker.provenance).toContainEqual(expect.objectContaining({ source: '/parallelism/clis/cursor/modelLimits',
      fields: ['/contextTokens', '/maxOutputTokens'], kind: 'operator' }));
  });

  it('names the exact custom Cursor limit key when context cannot be bounded', async () => {
    const result = await discoverCursorListModels('fake', async () => ({ exitCode: 0, stderr: '',
      stdout: 'fixture-high - Model High' }), { ...options, cliId: 'custom-cursor' });
    const diagnostics = validateWorkerPolicyRoute({ policy: DEFAULT_WORKER_SELECTION, role: 'coding',
      inferenceProvider: 'cursor', apiModelId: 'fixture-high', selectedModel: 'fixture-high', effort: 'high',
      identityEvidence: 'runtime-configured', observation: result.models[0].worker!,
      now: options.now(), context: { estimator: 'fixture', briefTokens: 1, inputTokens: 1,
        toolOutputAllowance: 1, reservedOutput: 1 } });
    expect(diagnostics).toContainEqual(expect.objectContaining({ pointer: '/worker/contextTokens',
      message: expect.stringContaining('parallelism.clis.custom-cursor.modelLimits["fixture-high"].contextTokens') }));
  });

  it.each(['absent', 'empty', 'custom', 'implicit', 'multiple'])('binds only an unambiguous configured Cursor CLI: %s', async state => {
    const cli = { adapter: 'providers:cursor', executable: 'fake-custom', accountScope: 'fixture', quotaScope: 'fixture',
      modelLimits: { 'fixture-high': { contextTokens: 32000 } } };
    const clis = state === 'absent' ? undefined : state === 'empty' ? {} : state === 'implicit'
      ? { cursor: { ...cli, adapter: undefined } } : { custom: cli,
        ...(state === 'multiple' ? { second: cli } : {}),
        disabled: { ...cli, enabled: false }, local: { ...cli, localModels: {} },
        unknown: { ...cli, adapter: 'providers:unknown' } };
    const runner = vi.fn<ModelDiscoveryCommandRunner>().mockImplementation(async (_command, args) => ({ exitCode: 0, stderr: '',
      stdout: args[0] === '--version' ? '2026.11.13-eacade1' : 'fixture-high - Model' }));
    const result = await discoverProjectCursorModels({ parallelism: clis ? { clis } : undefined,
      runner, now: options.now } as ModelDiscoveryOptions);
    const bound = state === 'custom' || state === 'implicit';
    expect(runner.mock.calls[0][0]).toBe(bound ? 'fake-custom' : 'cursor-agent');
    expect(result.accountBinding).toBe(bound ? 'fixture' : undefined);
    expect(result.models[0].worker).toMatchObject({ cliId: state === 'custom' ? 'custom' : 'cursor',
      contextTokens: bound ? 32000 : null });
  });

  it('refreshes and caches Cursor through the default discoverer and bounded runner using a fake executable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aiwg-cursor-discovery-'));
    try {
      const executable = path.join(root, 'cursor-fixture');
      await writeExecutable(executable, `#!${process.execPath}
if (process.argv.slice(2).join(' ') === '--version') console.log('2026.11.13-eacade1');
else if (process.argv.slice(2).join(' ') === '--list-models') console.log('fixture-high - Model 1M High');
else process.exit(90);
`);
      await mkdir(path.join(root, 'agentic/code/providers'), { recursive: true });
      await writeFile(path.join(root, 'agentic/code/providers/model-catalog.v1.json'), JSON.stringify({
        version: '1.0.0', providers: { cursor: { roles: { coding: { id: 'fixture-high' } } } },
      }));
      const config: ModelDiscoveryOptions = { aiwgRoot: root, homeDir: root, cacheFile: path.join(root, 'cache/catalog.json'),
        forceRefresh: true, allowNetwork: true, now: options.now,
        fetchImpl: async () => { throw new Error('network disabled in fixture'); },
        inventory: { generatedAt: options.now().toISOString(), projectDir: root, activeProvider: 'cursor', activeSource: 'env',
          providers: [{ id: 'cursor', displayName: 'Cursor', configured: true, deployed: true, detected: true,
            available: true, active: true, evidence: [], reasons: [] }] },
        parallelism: { clis: { cursor: { adapter: 'providers:cursor', executable, accountScope: 'fixture', quotaScope: 'fixture' } } } };
      const refreshed = await resolveDynamicModelCatalog(config);
      expect(refreshed.discovery?.providers.cursor).toMatchObject({ source: 'native', accountBinding: 'fixture', models: [
        { id: 'fixture-high', worker: { contextTokens: 1_000_000, runtimeVersion: '2026.11.13-eacade1' } },
      ] });
      const cached = JSON.parse(await readFile(config.cacheFile!, 'utf8'));
      expect(cached.discovery.providers.cursor).toEqual(refreshed.discovery?.providers.cursor);
      expect((await resolveDynamicModelCatalog({ ...config, forceRefresh: false })).discovery?.source).toBe('cache');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
