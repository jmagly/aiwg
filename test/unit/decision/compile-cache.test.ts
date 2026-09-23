import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CompileCacheRejectedError, FileCompileCache, MemoryCompileCache, cacheBenchmarkReport, compileCacheKey,
  prepareAdapterRequest, providerPrefixEvidence,
  providerPrefixKey, type CompileCacheIdentity, type CompileCacheReadContext, type ProviderPrefixIdentity,
} from '../../../src/decision/compile-cache/index.js';
import {
  executeQualificationPlan, verifyQualificationArtifacts, writeQualificationEvidenceManifest,
} from '../../../src/decision/qualification/runner.js';
import type { DecisionAdapter, DecisionAdapterRequest, DecisionDefinition, ExecutionTarget } from '../../../src/decision/types.js';

const executeFile = promisify(execFile);
const digest = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`;
function identity(overrides: Partial<CompileCacheIdentity> = {}): CompileCacheIdentity {
  return { identityVersion: 'decision-compile-cache-identity/v1', layer: 'definition-compilation',
    sourceArtifactDigests: [digest('a')], compiler: { id: 'decision', version: '1' }, runtimeVersion: 'node-22',
    schemaVersion: 'decision-v1alpha2', canonicalizer: { id: 'rfc8785', version: '1' },
    adapter: { id: 'jev', version: '1', promptVersion: 'p1' }, backendCapabilityMode: 'json-schema',
    modelPolicy: { requested: 'jev-1', compatibleActualModels: ['jev-1.0'] }, featureFlags: { strict: true },
    tenantId: 'tenant', projectId: 'project', dataClass: 'internal', ...overrides };
}
const context = (nowEpochMs = 100, overrides: Partial<CompileCacheReadContext> = {}): CompileCacheReadContext =>
  ({ tenantId: 'tenant', projectId: 'project', nowEpochMs, authorize: () => true, ...overrides });

describe('decision compile and provider-prefix cache', () => {
  it('CCP-001 fills once and verifies subsequent hits', async () => {
    const cache = new MemoryCompileCache<{ request: string }>(); let calls = 0;
    const first = await cache.getOrCompile(identity(), context(), 1_000, async () => ({ request: `stable-${++calls}` }));
    const second = await cache.getOrCompile(identity(), context(101), 1_000, async () => ({ request: `wrong-${++calls}` }));
    expect([first.outcome, second.outcome, calls]).toEqual(['miss', 'hit', 1]);
    expect(second.entry.value).toEqual(first.entry.value);
  });

  it('CCP-002 every behavior dimension participates in identity', () => {
    const base = identity(); const key = compileCacheKey(base);
    const variants = [identity({ sourceArtifactDigests: [digest('b')] }), identity({ compiler: { id: 'decision', version: '2' } }),
      identity({ runtimeVersion: 'node-24' }), identity({ schemaVersion: 'decision-v3' }),
      identity({ canonicalizer: { id: 'rfc8785', version: '2' } }),
      identity({ adapter: { id: 'jev', version: '2', promptVersion: 'p1' } }), identity({ backendCapabilityMode: 'grammar' }),
      identity({ modelPolicy: { requested: 'jev-2', compatibleActualModels: ['jev-2'] } }),
      identity({ featureFlags: { strict: false } }), identity({ projectId: 'other' }), identity({ dataClass: 'restricted' })];
    expect(variants.every(value => compileCacheKey(value) !== key)).toBe(true);
  });

  it('CCP-003 canonical key is stable for promised object-key equivalence and changes semantic arrays', () => {
    const left = identity({ featureFlags: { alpha: true, beta: 'x' } });
    const right = identity({ featureFlags: { beta: 'x', alpha: true } });
    expect(compileCacheKey(left)).toBe(compileCacheKey(right));
    expect(compileCacheKey(identity({ sourceArtifactDigests: [digest('a'), digest('b')] })))
      .not.toBe(compileCacheKey(identity({ sourceArtifactDigests: [digest('b'), digest('a')] })));
  });

  it('CCP-003 property suite preserves canonical object equivalence without semantic collisions', () => {
    let seed = 0x2603;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
    const keys = new Set<string>();
    for (let index = 0; index < 512; index += 1) {
      const alpha = Boolean(next() & 1); const beta = String(next()); const numeric = next();
      const left = identity({ featureFlags: { alpha, beta, numeric } });
      const right = identity({ featureFlags: { numeric, beta, alpha } });
      expect(compileCacheKey(left)).toBe(compileCacheKey(right));
      keys.add(compileCacheKey(left));
    }
    expect(keys.size).toBe(512);
  });

  it('CCP-004 single-flights concurrent cold requests', async () => {
    const cache = new MemoryCompileCache<string>(); let calls = 0; let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const compile = async () => { calls++; await blocked; return 'compiled'; };
    const first = cache.getOrCompile(identity(), context(), 1_000, compile);
    const second = cache.getOrCompile(identity(), context(), 1_000, compile); release();
    const results = await Promise.all([first, second]);
    expect(calls).toBe(1); expect(results.map(value => value.entry.value)).toEqual(['compiled', 'compiled']);
  });

  it('CCP-005 failed fills never publish a successful entry', async () => {
    const cache = new MemoryCompileCache<string>();
    await expect(cache.getOrCompile(identity(), context(), 1_000, async () => { throw new Error('crash'); })).rejects.toThrow('crash');
    expect(cache.read(identity(), context())).toBeNull();
    await expect(cache.getOrCompile(identity(), context(), 1_000, async () => 'recovered')).resolves.toMatchObject({ outcome: 'miss' });
  });

  it('CCP-006 rejects expiry, project substitution, authorization failure, and tampering identically', async () => {
    const cache = new MemoryCompileCache<{ stable: boolean }>();
    const filled = await cache.getOrCompile(identity(), context(), 10, async () => ({ stable: true }));
    expect(() => cache.read(identity(), context(110))).toThrow(CompileCacheRejectedError);
    expect(() => cache.read(identity(), context(101, { projectId: 'other' }))).toThrow('entry unavailable');
    expect(() => cache.read(identity(), context(101, { authorize: () => false }))).toThrow('entry unavailable');
    cache.restore({ ...filled.entry, value: { stable: false } });
    expect(() => cache.read(identity(), context(101))).toThrow('entry unavailable');
  });

  it('CCP-007 no-cache bypass is byte-equivalent but does not publish', async () => {
    const cache = new MemoryCompileCache<{ normalized: string }>();
    const compile = async () => ({ normalized: '{"stable":true}' });
    const bypass = await cache.getOrCompile(identity(), context(), 1_000, compile, { bypass: true });
    expect(bypass.outcome).toBe('bypass'); expect(cache.read(identity(), context())).toBeNull();
    const cached = await cache.getOrCompile(identity(), context(), 1_000, compile);
    expect(cached.entry.value).toEqual(bypass.entry.value);
  });

  it('CCP-008 applies tombstone, legal hold, deletion, and restore integrity', async () => {
    const cache = new MemoryCompileCache<string>();
    const filled = await cache.getOrCompile(identity(), context(), 1_000, async () => 'compiled');
    cache.setLegalHold(identity(), context(101), true); expect(cache.delete(identity(), context(102))).toBe(false);
    cache.setLegalHold(identity(), context(103), false); cache.tombstone(identity(), context(104));
    expect(() => cache.read(identity(), context(105))).toThrow('entry unavailable');
    expect(cache.delete(identity(), context(106))).toBe(true);
    cache.restore(filled.entry); expect(cache.read(identity(), context(107))?.value).toBe('compiled');
  });

  it('CCP-009 prefix identity pins policy, backend, revision, model, scope, region, and egress', () => {
    const base = prefix(); const key = providerPrefixKey(base);
    expect([prefix({ apiRevision: 'v2' }), prefix({ region: 'eu' }), prefix({ actualModel: 'jev-1.1' }),
      prefix({ egressPolicyDigest: digest('f') }), prefix({ workspaceId: 'other' }),
      prefix({ policy: { id: 'documented', version: '2', ttlMs: 1_000 } })]
      .every(value => providerPrefixKey(value) !== key)).toBe(true);
  });

  it('CCP-010 never infers prefix hits from absent reports', () => {
    expect(providerPrefixEvidence(prefix(), { kind: 'unreported' })).toMatchObject({ status: 'unknown', source: 'unreported', savedInputTokens: null });
    expect(providerPrefixEvidence(prefix(), { kind: 'reported', hit: true, cacheVersion: 'v1', savedInputTokens: 42, expiresAtEpochMs: 900 }))
      .toMatchObject({ status: 'hit', source: 'provider-report', savedInputTokens: 42 });
    expect(providerPrefixEvidence(prefix(), { kind: 'unsupported' }).status).toBe('unsupported');
    expect(providerPrefixEvidence(prefix(), { kind: 'bypass' }).status).toBe('bypass');
    expect(providerPrefixEvidence(prefix(), { kind: 'reported', hit: true, cacheVersion: '', savedInputTokens: -1, expiresAtEpochMs: 1 }).status).toBe('unknown');
  });

  it('CCP-011 retains unknown provider economics in a pinned paired benchmark', () => {
    const report = cacheBenchmarkReport(digest('e'), 2, 500, '95% bootstrap CI', [
      { mode: 'cache-disabled', preparationLatencyMs: 10, inputTokens: 100, cachedInputTokens: null, costUsd: null,
        memoryBytes: 10, storageBytes: 0, outcome: 'bypass', invalidated: false },
      { mode: 'cache-enabled', preparationLatencyMs: 2, inputTokens: 100, cachedInputTokens: null, costUsd: null,
        memoryBytes: 20, storageBytes: 30, outcome: 'hit', invalidated: false },
    ]);
    expect(report).toMatchObject({ warmupCalls: 2, measuredCalls: 2, minimumBenefitTargetBps: 500,
      enabled: { averagePreparationLatencyMs: 2, averageCostUsd: null, averageCachedInputTokens: null, hitRateBps: 10_000 } });
  });

  it('CCP-004 coordinates cold fills across independent filesystem cache instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-compile-cache-lock-'));
    const first = new FileCompileCache<string>(directory, { lockPollMs: 1, lockTimeoutMs: 1_000 });
    const second = new FileCompileCache<string>(directory, { lockPollMs: 1, lockTimeoutMs: 1_000 });
    let calls = 0; let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const compile = async () => { calls += 1; await blocked; return 'compiled-once'; };
    const left = first.getOrCompile(identity(), context(), 1_000, compile);
    const right = second.getOrCompile(identity(), context(), 1_000, compile);
    await expect.poll(() => calls).toBe(1);
    release();
    const results = await Promise.all([left, right]);
    expect(calls).toBe(1);
    expect(results.map(result => result.outcome).sort()).toEqual(['hit', 'miss']);
    expect(results.map(result => result.entry.value)).toEqual(['compiled-once', 'compiled-once']);
  });

  it('CCP-004 single-flights a cold fill across operating-system processes', async () => {
    const evidence = await crossProcessFill();
    expect(evidence.compilations).toBe(1);
    expect(evidence.outcomes.sort()).toEqual(['hit', 'miss']);
    expect(evidence.values).toEqual(['cross-process-compiled', 'cross-process-compiled']);
  });

  it('CCP-D11 emits verified cross-process locking qualification evidence', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'decision-compile-cache-qualification-'));
    const run = await executeQualificationPlan({
      artifactRoot,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'd30-compile-cache-v1',
        generatedAt: '2026-09-23T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true,
        cases: [{ id: 'D30-CCP', kind: 'baseline', mandatory: true,
          candidateTests: ['test/unit/decision/compile-cache.test.ts'] }] },
      executors: { 'D30-CCP': async () => {
        const evidence = await crossProcessFill();
        return { outcome: evidence.compilations === 1 && evidence.outcomes.sort().join(',') === 'hit,miss'
          ? 'pass' : 'fail', details: evidence };
      } },
    });
    expect((await verifyQualificationArtifacts(run, artifactRoot))).toEqual([{ caseId: 'D30-CCP', verified: true }]);
    const linked = await writeQualificationEvidenceManifest(run, artifactRoot, '.', {
      'D30-CCP': ['src/decision/compile-cache/file-store.ts', 'test/fixtures/decision/compile-cache-worker.ts'],
    });
    expect(linked.manifest.evidence[0]).toMatchObject({ caseId: 'D30-CCP', executable: true, outcome: 'pass' });
    expect(linked.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('CCP-004 reclaims a dead fill owner and never publishes a failed fill', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-compile-cache-stale-lock-'));
    const key = compileCacheKey(identity()).slice('sha256:'.length);
    await writeFile(join(directory, `${key}.lock`), JSON.stringify({
      version: 1, pid: 2_147_483_647, token: 'stale-owner', createdAtEpochMs: 1,
    }));
    const cache = new FileCompileCache<string>(directory, { lockPollMs: 1, lockTimeoutMs: 1_000 });
    await expect(cache.getOrCompile(identity(), context(), 1_000, async () => { throw new Error('compiler-crash'); }))
      .rejects.toThrow('compiler-crash');
    await expect(cache.read(identity(), context())).resolves.toBeNull();
    await expect(cache.getOrCompile(identity(), context(), 1_000, async () => 'recovered'))
      .resolves.toMatchObject({ outcome: 'miss', entry: { value: 'recovered' } });
  });

  it('CCP-008 persists isolated entries and enforces lifecycle integrity across store restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-compile-cache-'));
    const first = new FileCompileCache<{ stable: boolean }>(directory);
    const filled = await first.getOrCompile(identity(), context(), 1_000, async () => ({ stable: true }));
    const restarted = new FileCompileCache<{ stable: boolean }>(directory);
    expect((await restarted.read(identity(), context(101)))?.value).toEqual({ stable: true });
    expect(await restarted.backup(identity(), context(102))).toMatchObject({ key: filled.key });
    await expect(restarted.read(identity(), context(103, { projectId: 'other' }))).rejects.toThrow('unavailable');
    const path = join(directory, `${filled.key.slice('sha256:'.length)}.json`);
    await writeFile(path, (await readFile(path, 'utf8')).replace('true', 'false'));
    await expect(restarted.read(identity(), context(104))).rejects.toThrow('unavailable');
  });

  it('CCP-008 preserves byte-equivalent compiled artifacts through disabled and cached runtime paths', async () => {
    let compilations = 0;
    const seen: string[] = [];
    const definition = compileDefinition();
    const target = compileTarget();
    const adapter: DecisionAdapter = {
      id: 'jev', version: '1',
      capabilities: async () => ({ answerKinds: ['choice'], features: [], maxOptions: 10, maxLevels: null,
        confidenceProfiles: [], executable: true }),
      compile: async value => ({ bytes: JSON.stringify(value) }),
      evaluate: async request => { compilations += 0; seen.push(JSON.stringify(request.compiledArtifact));
        return { status: 'success', reason: 'none', value: 'yes', uncertainty: null, actualModel: 'm',
          usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestId: null }; },
    };
    adapter.compile = async value => { compilations += 1; return { bytes: JSON.stringify(value) }; };
    const request = compileRequest(definition, target);
    const store = new MemoryCompileCache();
    const common = { ttlMs: 1_000, store, context: context(), identityFor: () => identity() };
    const bypass = await prepareAdapterRequest(request, adapter, { enabled: false, ...common });
    const miss = await prepareAdapterRequest(request, adapter, { enabled: true, ...common });
    const hit = await prepareAdapterRequest(request, adapter, { enabled: true, ...common });
    await adapter.evaluate(bypass); await adapter.evaluate(miss); await adapter.evaluate(hit);
    expect(compilations).toBe(2);
    expect(new Set(seen).size).toBe(1);
  });
});

async function crossProcessFill(): Promise<{ compilations: number; outcomes: string[]; values: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'decision-compile-cache-processes-'));
  const directory = join(root, 'cache');
  const counter = join(root, 'compilations.log');
  const worker = join(process.cwd(), 'test/fixtures/decision/compile-cache-worker.ts');
  const executable = join(process.cwd(), 'node_modules/.bin/tsx');
  const [left, right] = await Promise.all([
    executeFile(executable, [worker, directory, counter, 'left']),
    executeFile(executable, [worker, directory, counter, 'right']),
  ]);
  const results = [left.stdout, right.stdout].map(output => JSON.parse(output) as { outcome: string; value: string });
  return { compilations: (await readFile(counter, 'utf8')).trim().split('\n').length,
    outcomes: results.map(result => result.outcome), values: results.map(result => result.value) };
}

function compileDefinition(): DecisionDefinition {
  return { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionDefinition',
    metadata: { id: 'compiled', version: '1', description: 'compiled' },
    spec: { purpose: 'test', inputSchema: {}, question: 'question',
      answer: { kind: 'choice', options: [{ id: 'yes', description: 'yes' }] }, requiredCapabilities: [] } };
}

function compileTarget(): ExecutionTarget {
  return { adapter: 'jev', adapterVersion: '1', model: 'm', requiredCapabilities: [], acceptance: { mode: 'typed-value' },
    timeoutMs: 1_000, retry: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 } };
}

function compileRequest(definition: DecisionDefinition, target: ExecutionTarget): DecisionAdapterRequest {
  return { alias: 'compiled', definition, input: {}, target, invocationId: 'i', deadlineEpochMs: 1_000,
    signal: new AbortController().signal, resolveCredential: async () => new Uint8Array() };
}

function prefix(overrides: Partial<ProviderPrefixIdentity> = {}): ProviderPrefixIdentity {
  return { schemaVersion: 'decision-provider-prefix-identity/v1', orderedPrefixDigest: digest('c'), provider: 'jev', backend: 'structured',
    requestedModel: 'jev-1', actualModel: 'jev-1.0', apiRevision: 'v1', policy: { id: 'documented', version: '1', ttlMs: 1_000 },
    tenantId: 'tenant', workspaceId: 'project', dataClass: 'internal', region: 'us', egressPolicyDigest: digest('d'), ...overrides };
}
