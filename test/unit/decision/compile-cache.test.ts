import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CompileCacheRejectedError, FileCompileCache, MemoryCompileCache, cacheBenchmarkReport, compileCacheKey,
  pairedPreparationLatencyInterval,
  prepareAdapterRequest, providerPrefixEvidence,
  providerPrefixKey, type CompileCacheIdentity, type CompileCacheReadContext, type ProviderPrefixIdentity,
} from '../../../src/decision/compile-cache/index.js';
import {
  executeQualificationPlan, verifyQualificationArtifacts, writeQualificationEvidenceManifest,
} from '../../../src/decision/qualification/runner.js';
import type { DecisionAdapter, DecisionAdapterRequest, DecisionDefinition, ExecutionTarget } from '../../../src/decision/types.js';
import {
  DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, type DecisionLifecycleHold, type DecisionLifecyclePolicy,
  type DecisionLifecycleRule, type DecisionLifecycleTombstone,
} from '../../../src/decision/lifecycle.js';

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
function lifecyclePolicy(cache: Partial<DecisionLifecycleRule> = {}): DecisionLifecyclePolicy {
  const rule: DecisionLifecycleRule = { classification: 'internal', accessScopes: ['decision-runtime'], retentionMs: 100_000,
    export: 'denied', deletion: 'tombstone', backup: 'expire-with-primary' };
  return { version: DECISION_LIFECYCLE_VERSION, surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface =>
    [surface, surface === 'cache' ? { ...rule, ...cache } : rule])) as DecisionLifecyclePolicy['surfaces'] };
}
const lifecycle = (cache: Partial<DecisionLifecycleRule> = {}) => ({ lifecyclePolicy: lifecyclePolicy(cache) });
const hold = (expiresAt = 10_000, overrides: Partial<DecisionLifecycleHold> = {}): DecisionLifecycleHold =>
  ({ subject: 'case-1', reason: 'litigation', scope: ['cache'], expiresAt, authorizedBy: 'records-officer', ...overrides });

describe('decision compile and provider-prefix cache', () => {
  it('CCP-001 fills once and verifies subsequent hits', async () => {
    const cache = new MemoryCompileCache<{ request: string }>(lifecycle()); let calls = 0;
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

  it('CCP-002 changes in every pinned dimension miss and create independent immutable entries', async () => {
    const cache = new MemoryCompileCache<string>(lifecycle());
    const variants = [identity(), identity({ sourceArtifactDigests: [digest('b')] }),
      identity({ compiler: { id: 'decision', version: '2' } }), identity({ runtimeVersion: 'node-24' }),
      identity({ schemaVersion: 'decision-v2' }), identity({ canonicalizer: { id: 'rfc8785', version: '2' } }),
      identity({ adapter: { id: 'jev', version: '2', promptVersion: 'p2' } }),
      identity({ backendCapabilityMode: 'grammar' }),
      identity({ modelPolicy: { requested: 'jev-2', compatibleActualModels: ['jev-2'] } }),
      identity({ featureFlags: { strict: false } }), identity({ tenantId: 'other' }),
      identity({ projectId: 'other' }), identity({ dataClass: 'restricted' })];
    for (const [index, pins] of variants.entries()) {
      const scope = context(100, { tenantId: pins.tenantId, projectId: pins.projectId });
      expect((await cache.getOrCompile(pins, scope, 1_000, async () => `artifact-${index}`)).outcome).toBe('miss');
      expect((await cache.getOrCompile(pins, scope, 1_000, async () => 'wrong')).entry.value).toBe(`artifact-${index}`);
    }
    expect(new Set(variants.map(compileCacheKey)).size).toBe(variants.length);
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
    const cache = new MemoryCompileCache<string>(lifecycle()); let calls = 0; let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const compile = async () => { calls++; await blocked; return 'compiled'; };
    const first = cache.getOrCompile(identity(), context(), 1_000, compile);
    const second = cache.getOrCompile(identity(), context(), 1_000, compile); release();
    const results = await Promise.all([first, second]);
    expect(calls).toBe(1); expect(results.map(value => value.entry.value)).toEqual(['compiled', 'compiled']);
  });

  it('CCP-005 failed fills never publish a successful entry', async () => {
    const cache = new MemoryCompileCache<string>(lifecycle());
    await expect(cache.getOrCompile(identity(), context(), 1_000, async () => { throw new Error('crash'); })).rejects.toThrow('crash');
    expect(cache.read(identity(), context())).toBeNull();
    await expect(cache.getOrCompile(identity(), context(), 1_000, async () => 'recovered')).resolves.toMatchObject({ outcome: 'miss' });
  });

  it('CCP-006 rejects expiry, project substitution, authorization failure, and tampering identically', async () => {
    const cache = new MemoryCompileCache<{ stable: boolean }>(lifecycle());
    const filled = await cache.getOrCompile(identity(), context(), 10, async () => ({ stable: true }));
    expect(() => cache.read(identity(), context(110))).toThrow(CompileCacheRejectedError);
    expect(cache.read(identity(), context(101, { projectId: 'other' }))).toBeNull();
    expect(cache.read(identity(), context(101, { authorize: () => false }))).toBeNull();
    expect(() => cache.restore({ ...filled.entry, value: { stable: false } }, context(101))).toThrow('entry unavailable');
    expect(() => cache.restore({ ...filled.entry, schemaVersion: 'decision-compile-cache-entry/v0' as never }, context(101)))
      .toThrow('entry unavailable');
  });

  it('CCP-007 refreshes authenticated expired memory entries without resurrecting tombstones', async () => {
    const cache = new MemoryCompileCache<string>(lifecycle());
    let calls = 0;
    const compile = async () => `artifact-${++calls}`;
    await cache.getOrCompile(identity(), context(), 10, compile);
    expect(() => cache.read(identity(), context(110))).toThrow('unavailable');
    await expect(cache.getOrCompile(identity(), context(110, { authorize: () => false }), 10, compile))
      .rejects.toThrow('unavailable');
    expect((await cache.getOrCompile(identity(), context(110), 10, compile)).entry.value).toBe('artifact-2');
    expect(calls).toBe(2);
    cache.tombstone(identity(), context(111));
    await expect(cache.getOrCompile(identity(), context(112), 10, compile)).rejects.toThrow('unavailable');
    expect(calls).toBe(2);
  });

  it('CCP-007 no-cache bypass is byte-equivalent but does not publish', async () => {
    const cache = new MemoryCompileCache<{ normalized: string }>(lifecycle());
    const compile = async () => ({ normalized: '{"stable":true}' });
    const bypass = await cache.getOrCompile(identity(), context(), 1_000, compile, { bypass: true });
    expect(bypass.outcome).toBe('bypass'); expect(cache.read(identity(), context())).toBeNull();
    const cached = await cache.getOrCompile(identity(), context(), 1_000, compile);
    expect(cached.entry.value).toEqual(bypass.entry.value);
  });

  it('CCP-008 applies tombstone, legal hold, deletion, and restore integrity', async () => {
    const cache = new MemoryCompileCache<string>(lifecycle());
    const filled = await cache.getOrCompile(identity(), context(), 1_000, async () => 'compiled');
    const backup = cache.backup(identity(), context(101))!;
    expect(() => cache.setLegalHold(identity(), context(101), hold(10_000, { scope: ['job'] }))).toThrow('hold denied');
    expect(() => cache.setLegalHold(identity(), context(101), hold(50))).toThrow('hold denied');
    cache.setLegalHold(identity(), context(101), hold(150));
    expect(cache.delete(identity(), context(102))).toBe(false);
    expect(cache.tombstone(identity(), context(102))).toBe(false);
    expect(cache.read(identity(), context(103))?.legalHold).toMatchObject({ reason: 'litigation', scope: ['cache'] });
    // An expired D10 hold no longer blocks deletion.
    expect(cache.delete(identity(), context(150))).toBe(true);
    expect(() => cache.read(identity(), context(151))).toThrow('entry unavailable');
    expect(cache.delete(identity(), context(152))).toBe(false);
    expect(() => cache.restore(backup, context(153))).toThrow('entry unavailable');
    expect(() => cache.restore(filled.entry, context(153))).toThrow('entry unavailable');
    await expect(cache.getOrCompile(identity(), context(154), 1_000, async () => 'refilled')).rejects.toThrow('unavailable');
  });

  it('CCP-008 restores only within the cache retention rule and refuses backups the rule does not persist', async () => {
    const cache = new MemoryCompileCache<string>(lifecycle({ retentionMs: 500 }));
    await expect(cache.getOrCompile(identity(), context(), 501, async () => 'too-long')).rejects.toThrow('unavailable');
    const filled = await cache.getOrCompile(identity(), context(), 500, async () => 'compiled');
    const empty = new MemoryCompileCache<string>(lifecycle({ retentionMs: 500 }));
    empty.restore(filled.entry, context(200));
    expect(empty.read(identity(), context(201))?.value).toBe('compiled');
    const unpersisted = new MemoryCompileCache<string>(lifecycle({ backup: 'not-persisted' }));
    await unpersisted.getOrCompile(identity(), context(), 1_000, async () => 'compiled');
    expect(() => unpersisted.backup(identity(), context(101))).toThrow('unavailable');
    expect(() => unpersisted.backup(identity({ projectId: 'absent' }), context(101))).toThrow('unavailable');
    expect(() => new MemoryCompileCache<string>({ lifecyclePolicy: { version: DECISION_LIFECYCLE_VERSION } as DecisionLifecyclePolicy }))
      .toThrow('incomplete');
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
    expect(providerPrefixEvidence(prefix(), { kind: 'reported', hit: true, cacheVersion: 'v1', savedInputTokens: 42, expiresAtEpochMs: 900 }, 800))
      .toMatchObject({ status: 'hit', source: 'provider-report', savedInputTokens: 42 });
    expect(providerPrefixEvidence(prefix(), { kind: 'reported', hit: true, cacheVersion: 'v1', savedInputTokens: 42, expiresAtEpochMs: 900 }, 900))
      .toMatchObject({ status: 'unknown', savedInputTokens: null });
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

  it('CCP-011 executes paired offline compile runs with observed disk size and no invented provider economics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-compile-cache-benchmark-'));
    const store = new FileCompileCache<{ artifact: string }>(directory, lifecycle());
    let compilations = 0;
    const compile = async () => {
      compilations++;
      return { artifact: 'stable-compiled-bytes' };
    };
    const configuration = identity();
    const ttlMs = 10_000;
    for (let index = 0; index < 2; index++) {
      await store.getOrCompile(configuration, context(100), ttlMs, compile, { bypass: true });
      await store.getOrCompile(configuration, context(100), ttlMs, compile);
    }
    const samples: import('../../../src/decision/compile-cache/benchmark.js').CacheBenchmarkSample[] = [];
    const durations: { disabled: number[]; enabled: number[] } = { disabled: [], enabled: [] };
    for (let index = 0; index < 8; index++) {
      for (const [mode, bypass] of [['cache-disabled', true], ['cache-enabled', false]] as const) {
        const started = performance.now();
        const result = await store.getOrCompile(configuration, context(101 + index), ttlMs, compile, { bypass });
        const latency = Math.max(0, performance.now() - started);
        durations[bypass ? 'disabled' : 'enabled'].push(latency);
        const bytes = (await stat(join(directory, `${result.key.slice('sha256:'.length)}.json`))).size;
        samples.push({ mode, preparationLatencyMs: latency, inputTokens: null, cachedInputTokens: null,
          costUsd: null, memoryBytes: Buffer.byteLength(JSON.stringify(result.entry.value)), storageBytes: bytes,
          outcome: result.outcome, invalidated: false });
        expect(result.entry.value).toEqual({ artifact: 'stable-compiled-bytes' });
      }
    }
    const report = cacheBenchmarkReport(compileCacheKey(configuration), 2, 500,
      pairedPreparationLatencyInterval(durations.disabled, durations.enabled), samples);
    expect(compilations).toBe(11);
    expect(report).toMatchObject({ measuredCalls: 16,
      disabled: { calls: 8, hitRateBps: 0, averageInputTokens: null, averageCostUsd: null },
      enabled: { calls: 8, hitRateBps: 10_000, averageCachedInputTokens: null, averageCostUsd: null,
        invalidationRateBps: 0 } });
    expect(report.enabled.peakStorageBytes).toBeGreaterThan(0);
    expect(report.confidenceInterval).toMatch(/^95% paired bootstrap CI \[-?[\d.]+, -?[\d.]+\] ms$/);
    expect(() => pairedPreparationLatencyInterval([1], [1])).toThrow();
  });

  it('CCP-011 rejects unpaired and invalid benchmark measurements instead of reporting savings', () => {
    const sample = { mode: 'cache-disabled' as const, preparationLatencyMs: 2, inputTokens: 100,
      outputTokens: 10, cachedInputTokens: 0, costUsd: 0.01, memoryBytes: 0, storageBytes: 0,
      outcome: 'bypass' as const, invalidated: false };
    const enabled = { ...sample, mode: 'cache-enabled' as const, outcome: 'hit' as const };
    expect(() => cacheBenchmarkReport(digest('e'), 0, 500, '95% CI', [sample, enabled])).not.toThrow();
    expect(() => cacheBenchmarkReport(digest('e'), 0, 500, '95% CI', [sample, enabled, enabled])).toThrow('paired');
    expect(() => cacheBenchmarkReport(digest('e'), 0, 500, '95% CI', [{ ...sample, costUsd: NaN }, enabled])).toThrow('paired');
    expect(() => cacheBenchmarkReport(digest('e'), 0, 500, '95% CI', [{ ...sample, outputTokens: -1 }, enabled])).toThrow('paired');
  });

  it('CCP-005 never publishes a malformed filesystem fill and recovers on retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-compile-cache-malformed-'));
    const store = new FileCompileCache<number>(directory, lifecycle());
    await expect(store.getOrCompile(identity(), context(), 1_000, async () => Number.NaN))
      .rejects.toThrow('non-finite');
    expect(await store.read(identity(), context())).toBeNull();
    expect((await store.getOrCompile(identity(), context(), 1_000, async () => 42)).entry.value).toBe(42);
  });

  it('CCP-004 coordinates cold fills across independent filesystem cache instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-compile-cache-lock-'));
    const first = new FileCompileCache<string>(directory, { ...lifecycle(), lockPollMs: 1, lockTimeoutMs: 1_000 });
    const second = new FileCompileCache<string>(directory, { ...lifecycle(), lockPollMs: 1, lockTimeoutMs: 1_000 });
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

  it('CCP-004 does not steal a newly created lock with incomplete owner metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-compile-cache-partial-lock-'));
    const key = compileCacheKey(identity()).slice('sha256:'.length);
    const path = join(directory, `${key}.lock`);
    await writeFile(path, '{}');
    const cache = new FileCompileCache<string>(directory, { ...lifecycle(), lockPollMs: 1, lockTimeoutMs: 25 });
    await expect(cache.getOrCompile(identity(), context(), 1_000, async () => 'should-not-run'))
      .rejects.toThrow(CompileCacheRejectedError);
    expect(await readFile(path, 'utf8')).toBe('{}');
    const stale = new Date(Date.now() - 60_000);
    await utimes(path, stale, stale);
    await expect(cache.getOrCompile(identity(), context(), 1_000, async () => 'recovered'))
      .resolves.toMatchObject({ outcome: 'miss', entry: { value: 'recovered' } });
  });

  it('CCP-004 reclaims a dead fill owner and never publishes a failed fill', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-compile-cache-stale-lock-'));
    const key = compileCacheKey(identity()).slice('sha256:'.length);
    await writeFile(join(directory, `${key}.lock`), JSON.stringify({
      version: 1, pid: 2_147_483_647, token: 'stale-owner', createdAtEpochMs: 1,
    }));
    const cache = new FileCompileCache<string>(directory, { ...lifecycle(), lockPollMs: 1, lockTimeoutMs: 1_000 });
    await expect(cache.getOrCompile(identity(), context(), 1_000, async () => { throw new Error('compiler-crash'); }))
      .rejects.toThrow('compiler-crash');
    await expect(cache.read(identity(), context())).resolves.toBeNull();
    await expect(cache.getOrCompile(identity(), context(), 1_000, async () => 'recovered'))
      .resolves.toMatchObject({ outcome: 'miss', entry: { value: 'recovered' } });
  });

  it('CCP-007 refreshes only an authenticated expired filesystem entry, never stale evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-compile-cache-expiry-'));
    const store = new FileCompileCache<string>(directory, lifecycle());
    let calls = 0;
    const compile = async () => `artifact-${++calls}`;
    expect((await store.getOrCompile(identity(), context(), 10, compile)).outcome).toBe('miss');
    await expect(store.read(identity(), context(110))).rejects.toThrow(CompileCacheRejectedError);
    await expect(store.getOrCompile(identity(), context(110, { projectId: 'other' }), 10, compile))
      .rejects.toThrow(CompileCacheRejectedError);
    expect(calls).toBe(1);
    const refreshed = await store.getOrCompile(identity(), context(110), 10, compile);
    expect(refreshed).toMatchObject({ outcome: 'miss', entry: { value: 'artifact-2', createdAtEpochMs: 110 } });
    expect((await store.getOrCompile(identity(), context(111), 10, compile)).outcome).toBe('hit');
    expect(calls).toBe(2);
    const path = join(directory, `${refreshed.key.slice('sha256:'.length)}.json`);
    await writeFile(path, (await readFile(path, 'utf8')).replace('artifact-2', 'tampered'));
    await expect(store.getOrCompile(identity(), context(120), 10, compile))
      .rejects.toThrow(CompileCacheRejectedError);
    expect(calls).toBe(2);
  });

  it('CCP-008 persists isolated entries and enforces lifecycle integrity across store restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-compile-cache-'));
    const first = new FileCompileCache<{ stable: boolean }>(directory, lifecycle());
    const filled = await first.getOrCompile(identity(), context(), 1_000, async () => ({ stable: true }));
    const restarted = new FileCompileCache<{ stable: boolean }>(directory, lifecycle());
    expect((await restarted.read(identity(), context(101)))?.value).toEqual({ stable: true });
    expect(await restarted.backup(identity(), context(102))).toMatchObject({ key: filled.key });
    await expect(restarted.read(identity(), context(103, { projectId: 'other' }))).resolves.toBeNull();
    const path = join(directory, `${filled.key.slice('sha256:'.length)}.json`);
    await writeFile(path, (await readFile(path, 'utf8')).replace('true', 'false'));
    await expect(restarted.read(identity(), context(104))).rejects.toThrow('unavailable');
  });

  it('CCP-008 enforces tombstone, hold, deletion and backup/restore across filesystem restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-compile-cache-lifecycle-'));
    const store = new FileCompileCache<string>(directory, lifecycle());
    const filled = await store.getOrCompile(identity(), context(), 1_000, async () => 'artifact');
    const backup = await store.backup(identity(), context(101));
    expect(backup).toEqual(filled.entry);
    await store.setLegalHold(identity(), context(102), hold(10_000));
    const restarted = new FileCompileCache<string>(directory, lifecycle());
    expect(await restarted.tombstone(identity(), context(103))).toBe(false);
    expect(await restarted.delete(identity(), context(104))).toBe(false);
    expect((await restarted.read(identity(), context(104)))?.value).toBe('artifact');
    await expect(restarted.restore(backup!, context(104))).rejects.toThrow('unavailable');
    await restarted.setLegalHold(identity(), context(105), null);
    expect(await restarted.delete(identity(), context(106))).toBe(true);
    await expect(restarted.read(identity(), context(107))).rejects.toThrow('unavailable');
    await expect(restarted.getOrCompile(identity(), context(107), 1_000, async () => 'forbidden'))
      .rejects.toThrow('unavailable');
    expect(await restarted.delete(identity(), context(107))).toBe(false);
    // The persistent tombstone refuses every earlier backup, including an untouched one.
    await expect(restarted.restore(backup!, context(108))).rejects.toThrow('unavailable');
    await expect(new FileCompileCache<string>(directory, lifecycle()).restore(filled.entry, context(108)))
      .rejects.toThrow('unavailable');
    await expect(restarted.restore({ ...backup!, value: 'tampered' }, context(110))).rejects.toThrow('unavailable');
    await expect(restarted.restore(backup!, context(108, { authorize: () => false }))).rejects.toThrow('unavailable');
  });

  it('CCP-008 tombstones erase the value and every identifier from disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-compile-cache-erasure-'));
    const store = new FileCompileCache<{ body: string }>(directory, lifecycle());
    const canary = 'synthetic-compile-cache-canary-2674';
    const pins = identity({ featureFlags: { marker: 'identity-canary-2674' } });
    const filled = await store.getOrCompile(pins, context(), 1_000, async () => ({ body: canary }));
    const path = join(directory, `${filled.key.slice('sha256:'.length)}.json`);
    expect(await readFile(path, 'utf8')).toContain(canary);
    expect(await store.tombstone(pins, context(101))).toBe(true);
    const bytes = await readFile(path, 'utf8');
    for (const secret of [canary, 'identity-canary-2674', filled.entry.valueDigest, 'tenant', 'project']) {
      expect(bytes).not.toContain(secret);
    }
    expect(JSON.parse(bytes)).toEqual({ schemaVersion: 'decision-compile-cache-tombstone/v1', key: filled.key,
      tombstone: { subject: filled.key.slice(7), reference: { surface: 'cache', opaqueId: filled.key.slice(7) }, deletedAt: 101 } });
    const names = await readdir(directory);
    for (const name of names) expect(await readFile(join(directory, name), 'utf8')).not.toContain(canary);

    const memory = new MemoryCompileCache<{ body: string }>(lifecycle());
    const memoryEntry = await memory.getOrCompile(pins, context(), 1_000, async () => ({ body: canary }));
    expect(memory.tombstone(pins, context(101))).toBe(true);
    expect(JSON.stringify((memory as unknown as { records: Map<string, unknown> }).records.get(memoryEntry.key)))
      .not.toContain(canary);
  });

  it('CCP-008 consults an independent D10 tombstone journal before restoring', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-compile-cache-journal-'));
    const journaled: DecisionLifecycleTombstone[] = [];
    const lifecycleJournal = {
      tombstone: async (value: DecisionLifecycleTombstone) => { journaled.push(value); },
      tombstones: async (subject: string) => journaled.filter(value => value.subject === subject),
    };
    const store = new FileCompileCache<string>(directory, { ...lifecycle(), lifecycleJournal });
    const filled = await store.getOrCompile(identity(), context(), 1_000, async () => 'artifact');
    expect(await store.delete(identity(), context(101))).toBe(true);
    expect(journaled).toHaveLength(1);
    // Even if the local tombstone is lost (for example a directory restored from media), the journal refuses the backup.
    const restoredMedia = await mkdtemp(join(tmpdir(), 'decision-compile-cache-journal-media-'));
    const fresh = new FileCompileCache<string>(restoredMedia, { ...lifecycle(), lifecycleJournal });
    await expect(fresh.restore(filled.entry, context(102))).rejects.toThrow('unavailable');
    const unjournaled = new FileCompileCache<string>(restoredMedia, lifecycle());
    await unjournaled.restore(filled.entry, context(102));
    expect((await unjournaled.read(identity(), context(103)))?.value).toBe('artifact');
  });

  it('CCP-005 out-of-scope and unauthorized lifecycle calls are indistinguishable from absent entries', async () => {
    const denied = [
      ['cross-project', context(101, { projectId: 'other' })],
      ['cross-tenant', context(101, { tenantId: 'other' })],
      ['unauthorized', context(101, { authorize: () => false })],
      ['authorizer-throws', context(101, { authorize: () => { throw new Error('policy offline'); } })],
    ] as const;
    const outcome = async (run: () => unknown) => {
      try { return { value: await run() }; }
      catch (error) { return { error: `${(error as Error).name}:${(error as Error).message}` }; }
    };
    const fileStore = async () => new FileCompileCache<string>(await mkdtemp(join(tmpdir(), 'decision-compile-cache-oracle-')), lifecycle());
    for (const [storeName, make] of [['memory', async () => new MemoryCompileCache<string>(lifecycle())], ['file', fileStore]] as const) {
      const present = await make();
      await present.getOrCompile(identity(), context(), 1_000, async () => 'present');
      const absent = await make();
      const operations = {
        read: (cache: typeof present, scope: CompileCacheReadContext) => cache.read(identity(), scope),
        delete: (cache: typeof present, scope: CompileCacheReadContext) => cache.delete(identity(), scope),
        tombstone: (cache: typeof present, scope: CompileCacheReadContext) => cache.tombstone(identity(), scope),
        setLegalHold: (cache: typeof present, scope: CompileCacheReadContext) => cache.setLegalHold(identity(), scope, hold()),
        backup: (cache: typeof present, scope: CompileCacheReadContext) => cache.backup(identity(), scope),
        getOrCompile: (cache: typeof present, scope: CompileCacheReadContext) =>
          cache.getOrCompile(identity(), scope, 1_000, async () => 'forbidden').then(result => result.outcome),
      };
      for (const [operation, run] of Object.entries(operations)) {
        const absentOutcome = await outcome(() => run(absent, context(101)));
        for (const [label, scope] of denied) {
          const existing = await outcome(() => run(present, scope));
          const missing = await outcome(() => run(absent, scope));
          expect(existing, `${storeName} ${operation} ${label}`).toEqual(missing);
          if (operation !== 'getOrCompile') expect(existing, `${storeName} ${operation} ${label} vs absent`).toEqual(absentOutcome);
        }
      }
      // Denied calls never altered the present entry.
      expect((await present.read(identity(), context(102)))?.value).toBe('present');
    }
  });

  it('CCP-011 reports provider-qualified synthetic paired economics without inferring live savings', () => {
    const pinned = prefix();
    const changed = prefix({ apiRevision: 'v2' });
    expect(providerPrefixKey(changed)).not.toBe(providerPrefixKey(pinned));
    const fixture = [
      { report: { kind: 'reported' as const, hit: false, cacheVersion: 'fixture-v1', savedInputTokens: 0, expiresAtEpochMs: 900 }, at: 800 },
      { report: { kind: 'reported' as const, hit: true, cacheVersion: 'fixture-v1', savedInputTokens: 60, expiresAtEpochMs: 900 }, at: 801 },
      { report: { kind: 'reported' as const, hit: true, cacheVersion: 'fixture-v1', savedInputTokens: 60, expiresAtEpochMs: 900 }, at: 900 },
    ];
    const samples: import('../../../src/decision/compile-cache/benchmark.js').CacheBenchmarkSample[] = [];
    for (const { report, at } of fixture) {
      const evidence = providerPrefixEvidence(pinned, report, at);
      samples.push({ mode: 'cache-disabled', preparationLatencyMs: 10, inputTokens: 100, outputTokens: 20,
        cachedInputTokens: 0, costUsd: 0.01, memoryBytes: 0, storageBytes: 0, outcome: 'bypass', invalidated: false });
      samples.push({ mode: 'cache-enabled', preparationLatencyMs: 10, inputTokens: 100, outputTokens: 20,
        cachedInputTokens: evidence.source === 'provider-report' ? evidence.savedInputTokens : null,
        costUsd: null, memoryBytes: 0, storageBytes: 0, outcome: evidence.status === 'hit' ? 'hit' :
          evidence.status === 'miss' ? 'miss' : 'unknown', invalidated: evidence.status === 'unknown' });
    }
    const report = cacheBenchmarkReport(providerPrefixKey(pinned), 1, 500,
      pairedPreparationLatencyInterval([10, 10, 10], [10, 10, 10]), samples);
    expect(report).toMatchObject({ measuredCalls: 6,
      disabled: { averageInputTokens: 100, averageTotalTaskTokens: 120, averageCostUsd: 0.01, hitRateBps: 0 },
      enabled: { averageInputTokens: 100, averageTotalTaskTokens: 120, averageCachedInputTokens: null, averageCostUsd: null,
        hitRateBps: 3333, invalidationRateBps: 3333 } });
  });

  it('CCP-008 preserves byte-equivalent compiled artifacts through disabled and cached runtime paths', async () => {
    let compilations = 0;
    const seen: string[] = [];
    const definition = compileDefinition();
    const target = compileTarget();
    const adapter: DecisionAdapter = {
      id: 'jev', version: '1',
      capabilities: async () => ({ answerKinds: ['choice'], features: [], maxOptions: 10, maxLevels: null,
        confidenceProfiles: [], executable: true, egress: { mode: 'none' as const } }),
      compile: async value => ({ bytes: JSON.stringify(value) }),
      evaluate: async request => { compilations += 0; seen.push(JSON.stringify(request.compiledArtifact));
        return { status: 'success', reason: 'none', value: 'yes', uncertainty: null, actualModel: 'm',
          usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestId: null }; },
    };
    adapter.compile = async value => { compilations += 1; return { bytes: JSON.stringify(value) }; };
    const request = compileRequest(definition, target);
    const store = new MemoryCompileCache(lifecycle());
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
