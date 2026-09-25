import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DecisionResultCache, FileResultCacheStore, MemoryResultCacheStore, RESULT_CACHE_KEY_VERSION, assertResultCacheEntry, digestCachedResult, digestResultCacheIdentity, entryIntegrityDigest } from '../../../src/decision/result-cache/index.js';
import type { CachedResultEvidence, ResultCacheActor, ResultCacheEntry, ResultCachePolicy, ResultCacheSemanticIdentity, ResultCacheStore } from '../../../src/decision/result-cache/index.js';

/** Conclusions of docs/decision/result-cache.md "Key construction security review". */
const REVIEWED = ['RCK-01', 'RCK-02', 'RCK-03', 'RCK-04', 'RCK-05', 'RCK-06', 'RCK-07'];

const pin = (id: string) => ({ id, version: '1', digest: `sha256:${id.repeat(64)}` as const });
const actor: ResultCacheActor = { tenantId: 'tenant', projectId: 'project', workspaceId: 'workspace', subjectId: 'caller', permissions: ['read', 'write', 'invalidate', 'export', 'delete'] };
const policy: ResultCachePolicy = { enabled: true, sideEffectFree: true, policyVersion: 'policy-1', ttlMs: 60_000, scope: 'workspace', sensitivity: 'internal' };
const identity = (projectedInput: ResultCacheSemanticIdentity['projectedInput'] = { text: 'private subject' }): ResultCacheSemanticIdentity => ({ keyVersion: RESULT_CACHE_KEY_VERSION, definition: pin('a'), ruleset: pin('b'), binding: pin('c'), adapter: { id: 'adapter', version: '1' }, promptDigest: pin('d').digest, acceptancePolicyDigest: pin('e').digest, calibrationDigest: pin('f').digest, runtimePolicyDigest: pin('4').digest, backend: 'test', requestedModel: 'model', modelCompatibility: { mode: 'pinned', actualModel: 'model' }, primitive: 'choice', projectedInput, subjectIdentityDigest: pin('1').digest, projectionPolicyDigest: pin('2').digest, egressPolicyDigest: pin('3').digest, capabilityMode: 'json' });
const evidence = (): CachedResultEvidence => ({ result: { answer: 'yes' }, resultDigest: pin('0').digest, sourceInvocationId: 'original', sourceReceiptId: 'receipt', evaluatedAtEpochMs: 10, actualModel: 'model', uncertainty: null, calibrationStatus: 'pinned', durationMs: 40, usage: { inputTokens: 5, outputTokens: 1, costUsd: null }, status: 'success', failureReason: 'none' });
const key = (input: unknown) => digestResultCacheIdentity(identity(input as ResultCacheSemanticIdentity['projectedInput']));
async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'result-cache-key-review-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('result-cache key construction security review', () => {
  it('enforces every conclusion listed in the written review', () => {
    const doc = readFileSync('docs/decision/result-cache.md', 'utf8');
    const section = doc.slice(doc.indexOf('## Key construction security review'));
    expect(section.length).toBeGreaterThan(40);
    expect([...new Set(section.match(/RCK-\d{2}/g))]).toEqual(REVIEWED);
  });

  it('RCK-01 uses a full SHA-256 over structure-preserving canonical JSON', () => {
    expect(key({ text: 'x' })).toMatch(/^sha256:[a-f0-9]{64}$/);
    const distinct = [
      { value: '1' }, { value: 1 }, { value: true }, { value: 'true' }, { value: null }, {},
      { value: { a: 'b' } }, { value: '{"a":"b"}' }, { value: ['a'] }, { value: { 0: 'a' } },
      { a: 'b,c' }, { 'a,b': 'c' }, { value: ['a', 'b'] }, { value: ['a,b'] },
    ];
    expect(new Set(distinct.map(key)).size).toBe(distinct.length);
  });

  it('RCK-02 canonicalizes order, Unicode and numbers, and refuses non-JSON values', () => {
    expect(key({ a: 1, b: 2 })).toBe(key({ b: 2, a: 1 }));
    expect(key({ text: 'é' })).toBe(key({ text: 'é' }));
    expect(() => key({ 'é': 1, 'é': 2 })).toThrow('Ambiguous');
    // Equal JSON numbers are one key; the adapter receives the same serialization.
    expect(key({ n: 1 })).toBe(key({ n: 1.0 }));
    expect(key({ n: -0 })).toBe(key({ n: 0 }));
    expect(JSON.stringify({ n: -0 })).toBe(JSON.stringify({ n: 0 }));
    expect(key({ n: 1 })).not.toBe(key({ n: 1.5 }));
    for (const invalid of [{ n: Number.NaN }, { n: Number.POSITIVE_INFINITY }, { n: undefined }, { f: () => 1 }]) {
      expect(() => key(invalid)).toThrow();
    }
  });

  it('RCK-03 keeps the key version inside the hashed identity', () => {
    const v2 = identity();
    const v1 = { ...v2, keyVersion: 'decision-semantic-key/v1' } as unknown as ResultCacheSemanticIdentity;
    expect(digestResultCacheIdentity(v1)).not.toBe(digestResultCacheIdentity(v2));
  });

  it('RCK-04 binds scope at storage and refuses scope components that could re-split', async () => {
    const left: ResultCacheActor = { ...actor, tenantId: 'a\0b', projectId: 'c' };
    const right: ResultCacheActor = { ...actor, tenantId: 'a', projectId: 'b\0c' };
    await withDir(async dir => {
      for (const store of [new MemoryResultCacheStore(), new FileResultCacheStore(dir)] as ResultCacheStore[]) {
        for (const bad of [left, right, { ...actor, workspaceId: '' }, { ...actor, projectId: 'p\n' }, { ...actor, tenantId: 't'.repeat(257) }]) {
          await expect(store.read(bad, key({ text: 'x' }))).rejects.toThrow('denied');
          await expect(new DecisionResultCache(store).evaluate({ actor: bad, policy, identity: identity(), callerInvocationId: 'x', nowEpochMs: 1 },
            async () => evidence())).rejects.toThrow('denied');
        }
      }
      // The same semantic key in two scopes is two independent entries.
      const store = new FileResultCacheStore(dir);
      const other = { ...actor, projectId: 'other' };
      await new DecisionResultCache(store).evaluate({ actor, policy, identity: identity(), callerInvocationId: 'a', nowEpochMs: Date.now() }, async () => evidence());
      expect(await store.read(other, key({ text: 'private subject' }))).toBeNull();
      expect((await readdir(dir)).filter(name => name.endsWith('.json'))).toHaveLength(1);
    });
  });

  it('RCK-05 keeps storage names and modes from exposing the key or scope', async () => withDir(async dir => {
    const store = new FileResultCacheStore(dir);
    await new DecisionResultCache(store).evaluate({ actor, policy, identity: identity(), callerInvocationId: 'a', nowEpochMs: Date.now() }, async () => evidence());
    const [name] = (await readdir(dir)).filter(value => value.endsWith('.json'));
    const hex = key({ text: 'private subject' }).slice('sha256:'.length);
    expect(name).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(name).not.toContain(hex);
    for (const component of [actor.tenantId, actor.projectId, actor.workspaceId]) expect(name).not.toContain(component);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, name!))).mode & 0o777).toBe(0o600);
  }));

  it('RCK-06 stores the key digest but never the identity or its input-derived digests', async () => withDir(async dir => {
    const store = new FileResultCacheStore(dir);
    const id = identity();
    await new DecisionResultCache(store).evaluate({ actor, policy, identity: id, callerInvocationId: 'a', nowEpochMs: Date.now() }, async () => evidence());
    const [name] = (await readdir(dir)).filter(value => value.endsWith('.json'));
    const stored = await readFile(join(dir, name!), 'utf8');
    expect(stored).toContain(digestResultCacheIdentity(id));
    for (const secret of ['private subject', id.promptDigest, id.subjectIdentityDigest, id.egressPolicyDigest, id.projectionPolicyDigest]) {
      expect(stored).not.toContain(secret);
    }
  }));

  it('RCK-07 treats the unkeyed entry digest as corruption detection, not authentication', async () => {
    const store = new MemoryResultCacheStore();
    const cache = new DecisionResultCache(store);
    await cache.evaluate({ actor, policy, identity: identity(), callerInvocationId: 'a', nowEpochMs: Date.now() }, async () => evidence());
    const stored = (await store.read(actor, key({ text: 'private subject' })))!;
    // Anyone who can write the store can recompute the digest: this passes the store check.
    const { integrityDigest: _old, ...unsigned } = stored;
    const forged: Omit<ResultCacheEntry, 'integrityDigest'> = { ...unsigned, evidence: { ...unsigned.evidence, result: { answer: 'no' },
      resultDigest: digestCachedResult({ answer: 'no' }) } };
    expect(() => assertResultCacheEntry({ ...forged, integrityDigest: entryIntegrityDigest(forged) })).not.toThrow();
    // Authenticity instead requires the caller's own identity digest ...
    const mismatched = { ...forged, identityDigest: key({ text: 'other' }) };
    const other = new MemoryResultCacheStore();
    await other.putIfAbsent(actor, { ...mismatched, integrityDigest: entryIntegrityDigest(mismatched) });
    const outcome = await new DecisionResultCache(other).evaluate({ actor, policy, identity: identity(), callerInvocationId: 'b', nowEpochMs: Date.now() }, async () => evidence());
    expect(outcome.receipt.disposition).not.toBe('cache-hit');
    // ... and, in the evaluator, source-receipt re-verification (result-cache-runtime.test.ts,
    // "rejects a forged cached result even when an attacker recomputes the entry digest").
    const runtime = readFileSync('test/unit/decision/result-cache-runtime.test.ts', 'utf8');
    expect(runtime).toContain('rejects a forged cached result even when an attacker recomputes the entry digest');
  });
});
