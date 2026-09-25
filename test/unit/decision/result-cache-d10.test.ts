import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, eraseDecisionSubject } from '../../../src/decision/lifecycle.js';
import type { DecisionLifecycleHold, DecisionLifecyclePolicy, DecisionLifecycleReference, DecisionLifecycleRule, DecisionLifecycleStore, DecisionLifecycleTombstone } from '../../../src/decision/lifecycle.js';
import { DecisionResultCache, FileResultCacheStore, RESULT_CACHE_KEY_VERSION, digestResultCacheIdentity } from '../../../src/decision/result-cache/index.js';
import type { CachedResultEvidence, ResultCacheActor, ResultCacheLifecycleBinding, ResultCachePolicy, ResultCacheSemanticIdentity } from '../../../src/decision/result-cache/index.js';

const pin = (id: string) => ({ id, version: '1', digest: `sha256:${id.repeat(64)}` as const });
const actor: ResultCacheActor = { tenantId: 'tenant', projectId: 'project', workspaceId: 'workspace', subjectId: 'caller', permissions: ['read', 'write', 'invalidate', 'export', 'delete'] };
const policy: ResultCachePolicy = { enabled: true, sideEffectFree: true, policyVersion: 'policy-1', ttlMs: 100, scope: 'workspace', sensitivity: 'internal' };
const identity: ResultCacheSemanticIdentity = { keyVersion: RESULT_CACHE_KEY_VERSION, definition: pin('a'), ruleset: pin('b'), binding: pin('c'), adapter: { id: 'adapter', version: '1' }, promptDigest: pin('d').digest, acceptancePolicyDigest: pin('e').digest, calibrationDigest: pin('f').digest, runtimePolicyDigest: pin('4').digest, backend: 'test', requestedModel: 'model', modelCompatibility: { mode: 'pinned', actualModel: 'model' }, primitive: 'choice', projectedInput: { text: 'private subject' }, subjectIdentityDigest: pin('1').digest, projectionPolicyDigest: pin('2').digest, egressPolicyDigest: pin('3').digest, capabilityMode: 'json' };
const key = digestResultCacheIdentity(identity);
const evidence = (sourceReceiptId = 'receipt'): CachedResultEvidence => ({ result: { answer: 'yes' }, resultDigest: pin('0').digest, sourceInvocationId: sourceReceiptId, sourceReceiptId, evaluatedAtEpochMs: 10, actualModel: 'model', uncertainty: null, calibrationStatus: 'pinned', durationMs: 40, usage: { inputTokens: 5, outputTokens: 1, costUsd: null }, status: 'success', failureReason: 'none' });
const request = (nowEpochMs: number, callerInvocationId: string, overrides: Partial<ResultCachePolicy> = {}) => ({ actor, policy: { ...policy, ...overrides }, identity, nowEpochMs, callerInvocationId });
function lifecycle(cache: Partial<DecisionLifecycleRule> = {}): DecisionLifecyclePolicy {
  const surfaces = Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
    classification: 'internal', accessScopes: ['decision-host'], retentionMs: 150, export: 'sanitized', deletion: 'tombstone', backup: 'expire-with-primary',
  }])) as DecisionLifecyclePolicy['surfaces'];
  surfaces.cache = { ...surfaces.cache, ...cache };
  return { version: DECISION_LIFECYCLE_VERSION, surfaces };
}
async function fixture(binding: Omit<ResultCacheLifecycleBinding, 'now'>, run: (store: FileResultCacheStore, clock: { now: number }, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'result-cache-d10-'));
  const clock = { now: 100 };
  try { await run(new FileResultCacheStore(dir, { lifecycle: { ...binding, now: () => clock.now } }), clock, dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

describe('result cache bound to the shared D10 lifecycle policy', () => {
  it('requires a complete D10 policy before the store can be constructed', () => {
    const incomplete = lifecycle();
    delete (incomplete.surfaces as Partial<DecisionLifecyclePolicy['surfaces']>).cache;
    expect(() => new FileResultCacheStore(tmpdir(), { lifecycle: { policy: incomplete } })).toThrow(/incomplete/);
  });

  it('caps TTL by the D10 cache retention and sensitivity by its classification', () => fixture({ policy: lifecycle({ classification: 'internal' }) }, async (store, _clock, dir) => {
    const cache = new DecisionResultCache(store);
    await expect(cache.evaluate(request(100, 'long', { ttlMs: 151 }), async () => evidence())).rejects.toThrow('denied');
    expect(await readdir(dir)).toEqual([]);
    const strict = new FileResultCacheStore(dir, { lifecycle: { policy: lifecycle({ classification: 'public' }) } });
    await expect(new DecisionResultCache(strict).evaluate(request(100, 'internal'), async () => evidence())).rejects.toThrow('denied');
    expect((await cache.evaluate(request(100, 'bounded', { ttlMs: 150 }), async () => evidence())).receipt.disposition).toBe('cache-miss-fill');
  }));

  it('stops serving at D10 retention even for an entry written under a longer TTL, purges it, and refills over it', () => fixture({ policy: lifecycle({ retentionMs: 150 }) }, async (store, clock, dir) => {
    // Written before the store was bound (or before the policy was tightened) with a 1000 ms TTL.
    await new DecisionResultCache(new FileResultCacheStore(dir)).evaluate(request(100, 'legacy', { ttlMs: 1_000 }), async () => evidence());
    const cache = new DecisionResultCache(store);
    const fill = vi.fn(async () => evidence());
    clock.now = 249;
    expect((await cache.evaluate(request(249, 'hit', { ttlMs: 1_000 }), fill)).receipt.disposition).toBe('cache-hit');
    clock.now = 250;
    expect(await store.read(actor, key)).toBeNull();
    // Hidden, not yet purged: the refill replaces it instead of failing publication.
    expect((await cache.evaluate(request(250, 'refill', { ttlMs: 150 }), fill)).receipt.disposition).toBe('cache-miss-fill');
    expect(fill).toHaveBeenCalledOnce();
    await new DecisionResultCache(new FileResultCacheStore(dir)).evaluate(request(500, 'legacy-2', { ttlMs: 1_000 }), async () => evidence());
    expect(await store.purgeExpired(actor, 649)).toBe(0);
    expect(await store.purgeExpired(actor, 650)).toBe(1);
    expect((await readdir(dir)).filter(name => name.endsWith('.json'))).toEqual([]);
  }));

  it('denies export when the D10 rule denies it, identically for present and absent keys', () => fixture({ policy: lifecycle({ export: 'denied' }) }, async store => {
    await new DecisionResultCache(store).evaluate(request(100, 'a'), async () => evidence());
    const absent = digestResultCacheIdentity({ ...identity, projectedInput: { text: 'absent' } });
    await expect(store.export(actor, key)).rejects.toThrow('Result cache operation denied');
    await expect(store.export(actor, absent)).rejects.toThrow('Result cache operation denied');
    expect(await store.read(actor, key)).not.toBeNull();
  }));

  it('cascades a source-receipt erasure through eraseDecisionSubject and honors D10 holds', () => fixture({ policy: lifecycle() }, async (store, _clock, dir) => {
    const cache = new DecisionResultCache(store);
    await cache.evaluate(request(100, 'source'), async () => evidence('receipt-1'));
    const other = { ...actor, workspaceId: 'other' };
    await cache.evaluate({ ...request(100, 'other'), actor: other }, async () => evidence('receipt-1'));
    const file = join(dir, (await readdir(dir)).find(name => name.endsWith('.json'))!);
    const tombstones: DecisionLifecycleTombstone[] = [];
    let holds: DecisionLifecycleHold[] = [{ subject: 'receipt-1', reason: 'litigation', scope: ['cache'], expiresAt: 1_000, authorizedBy: 'counsel' }];
    // The host resolves links from its own index; the cache supplies opaque entry IDs only.
    const host: DecisionLifecycleStore = {
      links: async subject => [{ surface: 'receipt', opaqueId: `receipt:${subject}` }, ...await store.lifecycleReferences(actor, subject)],
      erase: async (reference: DecisionLifecycleReference) => { if (reference.surface === 'cache') await store.eraseLifecycleReference(actor, reference); },
      tombstone: async value => { tombstones.push(value); }, holds: async () => holds,
      recordHold: async () => {}, releaseHold: async () => {},
    };
    const references = await store.lifecycleReferences(actor, 'receipt-1');
    expect(references).toHaveLength(1);
    expect(references[0]!.opaqueId).not.toContain(key.slice(7, 20));
    await expect(eraseDecisionSubject('receipt-1', lifecycle(), host, 200)).rejects.toThrow('hold');
    expect(await store.read(actor, key)).not.toBeNull();
    const backup = await readFile(file);
    holds = [];
    const erased = await eraseDecisionSubject('receipt-1', lifecycle(), host, 200);
    expect(erased.map(value => value.reference.surface)).toEqual(['receipt', 'cache']);
    expect(await store.read(actor, key)).toBeNull();
    await writeFile(file, backup);
    expect(await store.read(actor, key)).toBeNull();
    await expect(cache.evaluate(request(101, 'refill'), async () => evidence('receipt-2'))).rejects.toThrow('denied');
    // The cascade never crossed into another authenticated workspace.
    expect(await store.read(other, key)).not.toBeNull();
    expect(JSON.stringify(tombstones)).not.toContain('private subject');
  }));

  it('cascades directly by source receipt and fails closed when the D10 authority is unavailable', async () => {
    const erasedSources = new Set<string>();
    let available = true;
    await fixture({ policy: lifecycle(), sourceErased: async (_scope, source) => {
      if (!available) throw new Error('lifecycle service down'); return erasedSources.has(source);
    } }, async store => {
      const cache = new DecisionResultCache(store);
      await cache.evaluate(request(100, 'a'), async () => evidence('receipt-1'));
      erasedSources.add('receipt-1');
      // Passive: an entry whose source the host erased is hidden, purged and never refilled from it.
      expect(await store.read(actor, key)).toBeNull();
      await expect(cache.evaluate(request(101, 'b'), async () => evidence('receipt-1'))).rejects.toThrow('denied');
      expect(await store.purgeExpired(actor, 101)).toBe(1);
      expect((await cache.evaluate(request(102, 'c'), async () => evidence('receipt-2'))).receipt.disposition).toBe('cache-miss-fill');
      available = false;
      await expect(store.read(actor, key)).rejects.toThrow('denied');
      available = true;
      expect((await store.eraseBySourceReceipt(actor, 'receipt-2')).map(value => value.surface)).toEqual(['cache']);
      expect(await store.read(actor, key)).toBeNull();
      await expect(store.eraseLifecycleReference(actor, { surface: 'receipt', opaqueId: 'x' })).rejects.toThrow('invalid');
    });
  });
});
