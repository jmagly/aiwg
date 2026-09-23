import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DecisionResultCache, FileResultCacheStore, RESULT_CACHE_KEY_VERSION, digestCachedResult, digestResultCacheIdentity, entryIntegrityDigest } from '../../../src/decision/result-cache/index.js';
import type { CachedResultEvidence, ResultCacheActor, ResultCacheEntry, ResultCachePolicy, ResultCacheSemanticIdentity } from '../../../src/decision/result-cache/index.js';

const pin = (id: string) => ({ id, version: '1', digest: `sha256:${id.repeat(64)}` as const });
const actor: ResultCacheActor = { tenantId: 'tenant', projectId: 'project', workspaceId: 'workspace', subjectId: 'caller', permissions: ['read', 'write', 'invalidate', 'export', 'delete'] };
const policy: ResultCachePolicy = { enabled: true, sideEffectFree: true, policyVersion: 'policy-1', ttlMs: 100, scope: 'workspace', sensitivity: 'internal' };
const identity: ResultCacheSemanticIdentity = { keyVersion: RESULT_CACHE_KEY_VERSION, definition: pin('a'), ruleset: pin('b'), binding: pin('c'), adapter: { id: 'adapter', version: '1' }, promptDigest: pin('d').digest, acceptancePolicyDigest: pin('e').digest, calibrationDigest: pin('f').digest, runtimePolicyDigest: pin('4').digest, backend: 'test', requestedModel: 'model', modelCompatibility: { mode: 'pinned', actualModel: 'model' }, primitive: 'choice', projectedInput: { text: 'private subject' }, subjectIdentityDigest: pin('1').digest, projectionPolicyDigest: pin('2').digest, egressPolicyDigest: pin('3').digest, capabilityMode: 'json' };
const evidence = (): CachedResultEvidence => ({ result: { answer: 'yes' }, resultDigest: pin('0').digest, sourceInvocationId: 'original', sourceReceiptId: 'receipt', evaluatedAtEpochMs: 10, actualModel: 'model', uncertainty: { confidence: 0.8 }, calibrationStatus: 'approved', durationMs: 40, usage: { inputTokens: 5, outputTokens: 1, costUsd: null }, status: 'success', failureReason: 'none' });

async function fixture(run: (store: FileResultCacheStore, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'result-cache-lifecycle-'));
  try { await run(new FileResultCacheStore(dir), dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const request = (nowEpochMs: number, callerInvocationId: string) => ({ actor, policy, identity, nowEpochMs, callerInvocationId });

describe('file-backed result cache lifecycle', () => {
  it('removes a failed fill lock without publishing a successful result', async () => fixture(async (store, dir) => {
    const cache = new DecisionResultCache(store);
    await expect(cache.evaluate(request(100, 'crash'), async () => { throw new Error('backend crashed'); })).rejects.toThrow('backend crashed');
    expect(await store.read(actor, digestResultCacheIdentity(identity))).toBeNull();
    expect(await readdir(dir)).toEqual([]);
    expect((await cache.evaluate(request(101, 'retry'), async () => evidence())).receipt.disposition).toBe('cache-miss-fill');
  }));

  it('coalesces two independent processes on a cold key', async () => fixture(async (_store, dir) => {
    const worker = join(process.cwd(), 'test/fixtures/decision/result-cache-worker.ts');
    const run = (caller: string) => promisify(execFile)(process.execPath, ['--import', 'tsx', worker, dir, caller]);
    const [a, b] = await Promise.all([run('a'), run('b')]);
    const receipts = [JSON.parse(a.stdout), JSON.parse(b.stdout)];
    expect(receipts.map(value => value.callerInvocationId).sort()).toEqual(['a', 'b']);
    expect(receipts.map(value => value.disposition).sort()).toEqual(['cache-hit', 'cache-miss-fill']);
    expect((await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n')).toEqual(['call']);
  }));
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
    // Deletion retains only body-free audit metadata, never a renamed result.
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.deleted$/);
    expect(await readFile(join(dir, files[0]!), 'utf8')).not.toContain('answer');
    await expect(cache.evaluate(request(202, 'e'), fill)).rejects.toThrow('denied');
  }));

  it('refuses plaintext persistence of confidential and restricted results', async () => fixture(async (store, dir) => {
    for (const sensitivity of ['confidential', 'restricted'] as const) {
      await expect(new DecisionResultCache(store).evaluate({ ...request(100, sensitivity),
        policy: { ...policy, sensitivity } }, async () => evidence())).rejects.toThrow('denied');
    }
    expect(await readdir(dir)).toEqual([]);
  }));

  it('purges expired entries only in the authenticated workspace', async () => fixture(async store => {
    await new DecisionResultCache(store).evaluate(request(100, 'a'), async () => evidence());
    const other = { ...actor, workspaceId: 'other' };
    await new DecisionResultCache(store).evaluate({ ...request(100, 'other'), actor: other }, async () => evidence());
    expect(await store.purgeExpired(actor, 200)).toBe(1);
    expect(await store.read(actor, digestResultCacheIdentity(identity))).toBeNull();
    expect(await store.read(other, digestResultCacheIdentity(identity))).not.toBeNull();
  }));

  it('rejects restored backup content after deletion, including legal hold audit mode', async () => fixture(async (store, dir) => {
    const holdStore = new FileResultCacheStore(dir, { legalHold: true });
    const key = digestResultCacheIdentity(identity);
    await new DecisionResultCache(store).evaluate(request(100, 'source'), async () => evidence());
    const file = join(dir, (await readdir(dir)).find(name => name.endsWith('.json'))!);
    const backup = await readFile(file);
    expect(await holdStore.delete(actor, key)).toBe(true);
    const tombstone = JSON.parse(await readFile(`${file}.deleted`, 'utf8')) as { legalHold: boolean; schemaVersion: string };
    expect(tombstone).toMatchObject({ schemaVersion: 'decision-result-cache-tombstone/v1', legalHold: true });
    expect(JSON.stringify(tombstone)).not.toContain('private subject');
    await writeFile(file, backup);
    expect(await holdStore.read(actor, key)).toBeNull();
    expect(await holdStore.export(actor, key)).toBeNull();
    await expect(new DecisionResultCache(holdStore).evaluate(request(101, 'fresh'), async () => evidence())).rejects.toThrow('denied');
  }));

  it('does not migrate an old key identity into the current key space', async () => fixture(async store => {
    const oldKey = digestCachedResult({ ...identity, keyVersion: 'decision-semantic-key/v1' });
    const prior: Omit<ResultCacheEntry, 'integrityDigest'> = { schemaVersion: 'decision-result-cache/v1', revision: 1,
      entryId: 'previous', scope: { tenantId: actor.tenantId, projectId: actor.projectId, workspaceId: actor.workspaceId },
      keyDigest: oldKey, identityDigest: oldKey, policyVersion: policy.policyVersion, sensitivity: policy.sensitivity,
      createdAtEpochMs: 100, expiresAtEpochMs: 200, evidence: { ...evidence(), resultDigest: digestCachedResult(evidence().result) } };
    await store.putIfAbsent(actor, { ...prior, integrityDigest: entryIntegrityDigest(prior) });
    const fill = vi.fn(async () => evidence());
    expect((await new DecisionResultCache(store).evaluate(request(101, 'new'), fill)).receipt.disposition).toBe('cache-miss-fill');
    expect(fill).toHaveBeenCalledOnce();
    expect(await store.read(actor, oldKey)).not.toBeNull();
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
