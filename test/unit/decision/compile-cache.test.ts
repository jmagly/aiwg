import { describe, expect, it } from 'vitest';
import {
  CompileCacheRejectedError, MemoryCompileCache, cacheBenchmarkReport, compileCacheKey, providerPrefixEvidence,
  providerPrefixKey, type CompileCacheIdentity, type CompileCacheReadContext, type ProviderPrefixIdentity,
} from '../../../src/decision/compile-cache/index.js';

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
});

function prefix(overrides: Partial<ProviderPrefixIdentity> = {}): ProviderPrefixIdentity {
  return { schemaVersion: 'decision-provider-prefix-identity/v1', orderedPrefixDigest: digest('c'), provider: 'jev', backend: 'structured',
    requestedModel: 'jev-1', actualModel: 'jev-1.0', apiRevision: 'v1', policy: { id: 'documented', version: '1', ttlMs: 1_000 },
    tenantId: 'tenant', workspaceId: 'project', dataClass: 'internal', region: 'us', egressPolicyDigest: digest('d'), ...overrides };
}
