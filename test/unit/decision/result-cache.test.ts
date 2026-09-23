import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DecisionResultCache, FileResultCacheStore, MemoryResultCacheStore, RESULT_CACHE_KEY_VERSION, ResultCacheAccessDeniedError, digestResultCacheIdentity } from '../../../src/decision/result-cache/index.js';
import type { CachedResultEvidence, ResultCacheActor, ResultCachePolicy, ResultCacheSemanticIdentity } from '../../../src/decision/result-cache/index.js';

const digest = (c: string) => `sha256:${c.repeat(64)}` as const;
const actor: ResultCacheActor = { tenantId: 't1', projectId: 'p1', workspaceId: 'w1', subjectId: 'user', permissions: ['read', 'write', 'invalidate', 'export', 'delete'] };
const policy: ResultCachePolicy = { enabled: true, sideEffectFree: true, policyVersion: 'p1', ttlMs: 1_000, scope: 'workspace', sensitivity: 'internal' };
const identity = (overrides: Partial<ResultCacheSemanticIdentity> = {}): ResultCacheSemanticIdentity => ({ keyVersion: RESULT_CACHE_KEY_VERSION, definition: { id: 'd', version: '1', digest: digest('1') }, ruleset: { id: 'r', version: '1', digest: digest('2') }, binding: { id: 'b', version: '1', digest: digest('3') }, adapter: { id: 'jev', version: '1' }, promptDigest: digest('4'), acceptancePolicyDigest: digest('5'), calibrationDigest: digest('6'), runtimePolicyDigest: digest('b'), backend: 'provider', requestedModel: 'model-v1', modelCompatibility: { mode: 'pinned', actualModel: 'model-v1' }, primitive: 'choice', projectedInput: { b: 2, a: 'é' }, subjectIdentityDigest: digest('7'), projectionPolicyDigest: digest('8'), egressPolicyDigest: digest('9'), capabilityMode: 'json', ...overrides });
const evidence = (overrides: Partial<CachedResultEvidence> = {}): CachedResultEvidence => ({ result: { answer: 'yes' }, resultDigest: digest('0'), sourceInvocationId: 'source-i', sourceReceiptId: 'source-r', evaluatedAtEpochMs: 900, actualModel: 'model-v1', uncertainty: { confidence: 0.9 }, calibrationStatus: 'approved', durationMs: 120, usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 }, status: 'success', failureReason: 'none', ...overrides });

describe('semantic decision result cache', () => {
  it('is disabled unless policy is explicit and side-effect-free', async () => { const fill = vi.fn(async () => evidence()); const cache = new DecisionResultCache(new MemoryResultCacheStore()); const out = await cache.evaluate({ actor, policy: { ...policy, enabled: false }, identity: identity(), callerInvocationId: 'c', nowEpochMs: 1_000 }, fill); expect(out.receipt.disposition).toBe('bypass'); expect(fill).toHaveBeenCalledOnce(); });
  it('canonicalizes equivalent projected objects and changes every semantic pin', () => { const base = digestResultCacheIdentity(identity()); expect(digestResultCacheIdentity(identity({ projectedInput: { a: 'é', b: 2 } }))).toBe(base); expect(digestResultCacheIdentity(identity({ promptDigest: digest('a') }))).not.toBe(base); expect(digestResultCacheIdentity(identity({ primitive: 'ordinal-score' }))).not.toBe(base); });
  it('misses for each independent semantic dimension', () => {
    const baseline = digestResultCacheIdentity(identity());
    const changed: Partial<ResultCacheSemanticIdentity>[] = [
      { definition: { ...identity().definition, version: '2' } },
      { ruleset: { ...identity().ruleset, digest: digest('a') } },
      { binding: { ...identity().binding, version: '2' } },
      { adapter: { id: 'jev', version: '2' } },
      { promptDigest: digest('a') }, { acceptancePolicyDigest: digest('a') },
      { calibrationDigest: digest('a') }, { runtimePolicyDigest: digest('a') },
      { backend: 'another' }, { requestedModel: 'another' },
      { modelCompatibility: { mode: 'alias', alias: 'model-v1', snapshotId: 's1', approvedActualModels: ['model-v1'], validUntilEpochMs: 2000 } },
      { primitive: 'ordinal-score' }, { projectedInput: { a: 'é', b: 3 } },
      { subjectIdentityDigest: digest('a') }, { projectionPolicyDigest: digest('a') },
      { egressPolicyDigest: digest('a') }, { capabilityMode: 'plain' },
    ];
    for (const mutation of changed) expect(digestResultCacheIdentity(identity(mutation))).not.toBe(baseline);
    expect(digestResultCacheIdentity(identity({ projectedInput: { a: 'e\u0301', b: 2 } }))).toBe(baseline);
  });
  it('returns original provenance without a fake provider attempt', async () => { const fill = vi.fn(async () => evidence()); const cache = new DecisionResultCache(new MemoryResultCacheStore()); const req = { actor, policy, identity: identity(), callerInvocationId: 'c1', nowEpochMs: 1_000 }; await cache.evaluate(req, fill); const hit = await cache.evaluate({ ...req, callerInvocationId: 'c2', nowEpochMs: 1_100 }, fill); expect(hit.receipt).toMatchObject({ disposition: 'cache-hit', sourceInvocationId: 'source-i', originalEvaluatedAtEpochMs: 900, providerAttempted: false }); expect(fill).toHaveBeenCalledOnce(); });
  it('does not turn unknown usage or cost into fabricated cache savings', async () => {
    const events: Array<{ event: string; saved?: { inputTokens: number | null; outputTokens: number | null;
      costUsd: number | null; latencyMs: number; estimated: true } }> = [];
    const cache = new DecisionResultCache(new MemoryResultCacheStore(), event => events.push(event));
    const request = { actor, policy, identity: identity(), callerInvocationId: 'c', nowEpochMs: 1_000 };
    await cache.evaluate(request, async () => evidence({ usage: { inputTokens: null, outputTokens: null, costUsd: null } }));
    await cache.evaluate({ ...request, callerInvocationId: 'd', nowEpochMs: 1_001 }, async () => { throw new Error('hit must not dispatch'); });
    expect(events.find(event => event.event === 'hit')?.saved).toEqual({ inputTokens: null,
      outputTokens: null, costUsd: null, latencyMs: 120, estimated: true });
  });
  it('treats expiry as stale and refreshes', async () => { const events: string[] = []; const fill = vi.fn(async () => evidence()); const cache = new DecisionResultCache(new MemoryResultCacheStore(), e => events.push(e.event)); const req = { actor, policy, identity: identity(), callerInvocationId: 'c' }; await cache.evaluate({ ...req, nowEpochMs: 1_000 }, fill); await cache.evaluate({ ...req, nowEpochMs: 2_001 }, fill); expect(fill).toHaveBeenCalledTimes(2); expect(events).toContain('stale'); expect(events).toContain('invalidation'); });
  it('collapses concurrent cold fills and correlates both callers', async () => { let release!: () => void; const gate = new Promise<void>(r => { release = r; }); const fill = vi.fn(async () => { await gate; return evidence(); }); const events: string[] = []; const cache = new DecisionResultCache(new MemoryResultCacheStore(), e => events.push(e.event)); const a = cache.evaluate({ actor, policy, identity: identity(), callerInvocationId: 'a', nowEpochMs: 1_000 }, fill); const b = cache.evaluate({ actor, policy, identity: identity(), callerInvocationId: 'b', nowEpochMs: 1_000 }, fill); release(); const [one, two] = await Promise.all([a, b]); expect(fill).toHaveBeenCalledOnce(); expect([one.receipt.callerInvocationId, two.receipt.callerInvocationId]).toEqual(['a', 'b']); expect(events).toContain('single-flight'); });
  it('does not join flights across different policy or actor authorization', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fill = vi.fn(async () => { await gate; return evidence(); });
    const cache = new DecisionResultCache(new MemoryResultCacheStore());
    const first = cache.evaluate({ actor, policy, identity: identity(), callerInvocationId: 'a', nowEpochMs: 1_000 }, fill);
    const second = cache.evaluate({ actor: { ...actor, subjectId: 'different' }, policy: { ...policy, policyVersion: 'new' }, identity: identity(), callerInvocationId: 'b', nowEpochMs: 1_000 }, fill);
    release(); await Promise.all([first, second]);
    expect(fill).toHaveBeenCalledTimes(2);
  });
  it('does not share mutable result objects between joined callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let joined!: () => void;
    const joinedFlight = new Promise<void>(resolve => { joined = resolve; });
    const cache = new DecisionResultCache(new MemoryResultCacheStore(), event => { if (event.event === 'single-flight') joined(); });
    const req = { actor, policy, identity: identity(), callerInvocationId: 'a', nowEpochMs: 1_000 };
    const first = cache.evaluate(req, async () => { await gate; return evidence(); });
    const second = cache.evaluate({ ...req, callerInvocationId: 'b' }, async () => { throw new Error('duplicate fill'); });
    await joinedFlight; release(); const [one, two] = await Promise.all([first, second]);
    expect(one.evidence).not.toBe(two.evidence);
    (one.evidence!.result as { answer: string }).answer = 'tampered';
    expect(two.evidence?.result).toEqual({ answer: 'yes' });
  });
  it('does not publish a crashed or execution-uncertain fill', async () => { const store = new MemoryResultCacheStore(); const cache = new DecisionResultCache(store); await expect(cache.evaluate({ actor, policy, identity: identity(), callerInvocationId: 'c', nowEpochMs: 1_000 }, async () => { throw new Error('crash'); })).rejects.toThrow('crash'); expect(await store.read(actor, digestResultCacheIdentity(identity()))).toBeNull(); const unknown = evidence({ status: 'terminal-failure', failureReason: 'execution-uncertain' }); await cache.evaluate({ actor, policy, identity: identity(), callerInvocationId: 'c', nowEpochMs: 1_000 }, async () => unknown); expect(await store.read(actor, digestResultCacheIdentity(identity()))).toBeNull(); });
  it('only negative-caches configured deterministic invalid input', async () => { const store = new MemoryResultCacheStore(); const cache = new DecisionResultCache(store); const negativePolicy = { ...policy, negative: { enabled: true, ttlMs: 50, reasons: ['invalid-input' as const] } }; const fill = vi.fn(async () => evidence({ status: 'terminal-failure', failureReason: 'invalid-input' })); await cache.evaluate({ actor, policy: negativePolicy, identity: identity(), callerInvocationId: 'a', nowEpochMs: 1_000 }, fill); await cache.evaluate({ actor, policy: negativePolicy, identity: identity(), callerInvocationId: 'b', nowEpochMs: 1_010 }, fill); expect(fill).toHaveBeenCalledOnce(); });
  it('never reuses auth, egress, transient or uncertain failure states', async () => {
    for (const reason of ['authentication', 'unauthorized', 'data-boundary-denied', 'network-transient', 'execution-uncertain'] as const) {
      const fill = vi.fn(async () => evidence({ status: 'terminal-failure', failureReason: reason }));
      const cache = new DecisionResultCache(new MemoryResultCacheStore());
      const config = { actor, policy: { ...policy, negative: { enabled: true, ttlMs: 50, reasons: ['invalid-input' as const] } },
        identity: identity(), callerInvocationId: 'one', nowEpochMs: 1_000 };
      await cache.evaluate(config, fill);
      await cache.evaluate({ ...config, callerInvocationId: 'two' }, fill);
      expect(fill).toHaveBeenCalledTimes(2);
    }
  });
  it('bypasses expired and unknown alias compatibility', async () => { const fill = vi.fn(async () => evidence()); const cache = new DecisionResultCache(new MemoryResultCacheStore()); const alias = identity({ modelCompatibility: { mode: 'alias', alias: 'latest', snapshotId: 's1', approvedActualModels: ['model-v1'], validUntilEpochMs: 999 } }); const out = await cache.evaluate({ actor, policy, identity: alias, callerInvocationId: 'c', nowEpochMs: 1_000 }, fill); expect(out.receipt.disposition).toBe('bypass'); });
  it('does not publish an actual model outside the compatibility snapshot', async () => { const store = new MemoryResultCacheStore(); const cache = new DecisionResultCache(store); const alias = identity({ modelCompatibility: { mode: 'alias', alias: 'latest', snapshotId: 's1', approvedActualModels: ['model-v1'], validUntilEpochMs: 2_000 } }); await cache.evaluate({ actor, policy, identity: alias, callerInvocationId: 'c', nowEpochMs: 1_000 }, async () => evidence({ actualModel: 'model-v2' })); expect(await store.read(actor, digestResultCacheIdentity(alias))).toBeNull(); });
  it('reuses only an approved actual version inside an alias snapshot window', async () => { const fill = vi.fn(async () => evidence()); const cache = new DecisionResultCache(new MemoryResultCacheStore()); const alias = identity({ requestedModel: 'latest', modelCompatibility: { mode: 'alias', alias: 'latest', snapshotId: 's1', approvedActualModels: ['model-v1'], validUntilEpochMs: 2_000 } }); const req = { actor, policy, identity: alias, callerInvocationId: 'a', nowEpochMs: 1_000 }; await cache.evaluate(req, fill); const hit = await cache.evaluate({ ...req, callerInvocationId: 'b', nowEpochMs: 1_100 }, fill); expect(hit.receipt.disposition).toBe('cache-hit'); expect(hit.evidence.actualModel).toBe('model-v1'); expect(fill).toHaveBeenCalledOnce(); });
  it('supports explicit invalidation and deletion without stale fallback', async () => { const store = new MemoryResultCacheStore(); const cache = new DecisionResultCache(store); const key = digestResultCacheIdentity(identity()); const req = { actor, policy, identity: identity(), callerInvocationId: 'a', nowEpochMs: 1_000 }; await cache.evaluate(req, async () => evidence()); const entry = await store.read(actor, key); expect(await store.invalidate(actor, key, entry!.entryId)).toBe(true); expect(await store.read(actor, key)).toBeNull(); await cache.evaluate({ ...req, nowEpochMs: 1_100 }, async () => evidence()); expect(await store.delete(actor, key)).toBe(true); expect(await store.read(actor, key)).toBeNull(); });
  it('prevents cross-workspace access and exposes the same denial', async () => { const store = new MemoryResultCacheStore(); await expect(store.read({ ...actor, workspaceId: 'other', permissions: [] }, digest('a'))).rejects.toBeInstanceOf(ResultCacheAccessDeniedError); await expect(store.read({ ...actor, permissions: [] }, digest('a'))).rejects.toBeInstanceOf(ResultCacheAccessDeniedError); });
  it('detects modified stored bytes in the real filesystem store', async () => { const dir = await mkdtemp(join(tmpdir(), 'decision-cache-')); const store = new FileResultCacheStore(dir); const cache = new DecisionResultCache(store); await cache.evaluate({ actor, policy, identity: identity(), callerInvocationId: 'c', nowEpochMs: 1_000 }, async () => evidence()); const files = (await import('node:fs/promises')).readdir(dir); const name = (await files)[0]!; const path = join(dir, name); const raw = await readFile(path, 'utf8'); await writeFile(path, raw.replace('model-v1', 'model-v2')); await expect(store.read(actor, digestResultCacheIdentity(identity()))).rejects.toThrow('integrity'); });
  it('keeps telemetry free of semantic key and identity material', async () => { const events: unknown[] = []; const cache = new DecisionResultCache(new MemoryResultCacheStore(), e => events.push(e)); await cache.evaluate({ actor, policy, identity: identity(), callerInvocationId: 'c', nowEpochMs: 1_000, operationId: 'op' }, async () => evidence()); const serialized = JSON.stringify(events); expect(serialized).not.toContain(digestResultCacheIdentity(identity())); expect(serialized).not.toContain('source-i'); expect(serialized).toContain('op'); });
});
