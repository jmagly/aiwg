import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DecisionResultCache, FileResultCacheStore, RESULT_CACHE_KEY_VERSION, digestResultCacheIdentity, entryIntegrityDigest } from '../../../src/decision/result-cache/index.js';
import type { CachedResultEvidence, ResultCacheActor, ResultCacheEntry, ResultCachePolicy, ResultCacheSemanticIdentity } from '../../../src/decision/result-cache/index.js';

const pin = (id: string) => ({ id, version: '1', digest: `sha256:${id.repeat(64)}` as const });
const actor: ResultCacheActor = { tenantId: 'tenant', projectId: 'project', workspaceId: 'workspace', subjectId: 'caller', permissions: ['read', 'write', 'invalidate', 'export', 'delete'] };
const policy: ResultCachePolicy = { enabled: true, sideEffectFree: true, policyVersion: 'policy-1', ttlMs: 100, scope: 'workspace', sensitivity: 'internal' };
const identity: ResultCacheSemanticIdentity = { keyVersion: RESULT_CACHE_KEY_VERSION, definition: pin('a'), ruleset: pin('b'), binding: pin('c'), adapter: { id: 'adapter', version: '1' }, promptDigest: pin('d').digest, acceptancePolicyDigest: pin('e').digest, calibrationDigest: pin('f').digest, backend: 'test', requestedModel: 'model', modelCompatibility: { mode: 'pinned', actualModel: 'model' }, primitive: 'choice', projectedInput: { text: 'private subject' }, subjectIdentityDigest: pin('1').digest, projectionPolicyDigest: pin('2').digest, egressPolicyDigest: pin('3').digest, capabilityMode: 'json' };
const evidence = (): CachedResultEvidence => ({ result: { answer: 'yes' }, resultDigest: pin('0').digest, sourceInvocationId: 'original', sourceReceiptId: 'receipt', evaluatedAtEpochMs: 10, actualModel: 'model', uncertainty: { confidence: 0.8 }, calibrationStatus: 'approved', durationMs: 40, usage: { inputTokens: 5, outputTokens: 1, costUsd: null }, status: 'success', failureReason: 'none' });

async function fixture(run: (store: FileResultCacheStore, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'result-cache-lifecycle-'));
  try { await run(new FileResultCacheStore(dir), dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const request = (nowEpochMs: number, callerInvocationId: string) => ({ actor, policy, identity, nowEpochMs, callerInvocationId });

describe('file-backed result cache lifecycle', () => {
  it('expires, explicitly invalidates and deletes without returning protected content', async () => fixture(async (store, dir) => {
    const events: string[] = []; const cache = new DecisionResultCache(store, event => events.push(event.event));
    const fill = vi.fn(async () => evidence());
    await cache.evaluate(request(100, 'a'), fill);
    expect((await cache.evaluate(request(199, 'b'), fill)).receipt.disposition).toBe('cache-hit');
    expect((await cache.evaluate(request(200, 'c'), fill)).receipt.disposition).toBe('cache-miss-fill');
    expect(fill).toHaveBeenCalledTimes(2);
    expect(events).toContain('stale');
    const key = digestResultCacheIdentity(identity);
    const current = await store.read(actor, key);
    expect(current?.evidence.sourceInvocationId).toBe('original');
    expect(await store.invalidate(actor, key, current!.entryId)).toBe(true);
    expect(await store.read(actor, key)).toBeNull();
    await cache.evaluate(request(201, 'd'), fill);
    expect(await store.delete(actor, key)).toBe(true);
    expect(await store.export(actor, key)).toBeNull();
    // Deletion must not leave a renamed JSON copy of the protected result.
    const files = await readdir(dir);
    expect(files).toEqual([]);
  }));

  it('rejects unsupported schema revisions rather than migrating or serving old bytes', async () => fixture(async (store, dir) => {
    await new DecisionResultCache(store).evaluate(request(100, 'a'), async () => evidence());
    const file = join(dir, (await readdir(dir)).find(name => name.endsWith('.json'))!);
    const entry = JSON.parse(await readFile(file, 'utf8')) as ResultCacheEntry;
    const altered = { ...entry, revision: 2 };
    const { integrityDigest: _old, ...unsigned } = altered;
    await writeFile(file, JSON.stringify({ ...altered, integrityDigest: entryIntegrityDigest(unsigned as Omit<ResultCacheEntry, 'integrityDigest'>) }));
    await expect(store.read(actor, digestResultCacheIdentity(identity))).rejects.toThrow('schema');
  }));

  it('rejects scope substitution even when an attacker recomputes the unkeyed digest', async () => fixture(async (store, dir) => {
    await new DecisionResultCache(store).evaluate(request(100, 'a'), async () => evidence());
    const file = join(dir, (await readdir(dir)).find(name => name.endsWith('.json'))!);
    const entry = JSON.parse(await readFile(file, 'utf8')) as ResultCacheEntry;
    const { integrityDigest: _old, ...unsigned } = entry;
    const forged = { ...unsigned, scope: { ...actor, projectId: 'other' } };
    await writeFile(file, JSON.stringify({ ...forged, integrityDigest: entryIntegrityDigest(forged) }));
    await expect(store.read(actor, digestResultCacheIdentity(identity))).rejects.toThrow('denied');
  }));
});
