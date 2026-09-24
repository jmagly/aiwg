import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { DecisionResultCache, FileResultCacheStore, MemoryResultCacheStore, RESULT_CACHE_KEY_VERSION, ResultCacheAccessDeniedError, digestCachedResult, digestResultCacheIdentity, entryIntegrityDigest } from '../../../src/decision/result-cache/index.js';
import type { CachedResultEvidence, ResultCacheActor, ResultCacheEntry, ResultCachePolicy, ResultCacheSemanticIdentity, ResultCacheStore } from '../../../src/decision/result-cache/index.js';

type Permission = ResultCacheActor['permissions'][number];
const ALL: Permission[] = ['read', 'write', 'invalidate', 'export', 'delete'];
const pin = (id: string) => ({ id, version: '1', digest: `sha256:${id.repeat(64)}` as const });
const victim: ResultCacheActor = { tenantId: 'tenant', projectId: 'project', workspaceId: 'victim', subjectId: 'owner', permissions: [...ALL] };
const foreign: ResultCacheActor = { ...victim, workspaceId: 'attacker', subjectId: 'prober' };
const otherProject: ResultCacheActor = { ...victim, projectId: 'other-project', subjectId: 'prober' };
const policy: ResultCachePolicy = { enabled: true, sideEffectFree: true, policyVersion: 'policy-1', ttlMs: 60_000, scope: 'workspace', sensitivity: 'internal' };
const identity = (text: string): ResultCacheSemanticIdentity => ({ keyVersion: RESULT_CACHE_KEY_VERSION, definition: pin('a'), ruleset: pin('b'), binding: pin('c'), adapter: { id: 'adapter', version: '1' }, promptDigest: pin('d').digest, acceptancePolicyDigest: pin('e').digest, calibrationDigest: pin('f').digest, runtimePolicyDigest: pin('4').digest, backend: 'test', requestedModel: 'model', modelCompatibility: { mode: 'pinned', actualModel: 'model' }, primitive: 'choice', projectedInput: { text }, subjectIdentityDigest: pin('1').digest, projectionPolicyDigest: pin('2').digest, egressPolicyDigest: pin('3').digest, capabilityMode: 'json' });
const present = digestResultCacheIdentity(identity('victim subject'));
const absent = digestResultCacheIdentity(identity('never stored'));
const evidence = (): CachedResultEvidence => ({ result: { answer: 'yes' }, resultDigest: pin('0').digest, sourceInvocationId: 'original', sourceReceiptId: 'receipt', evaluatedAtEpochMs: 10, actualModel: 'model', uncertainty: null, calibrationStatus: 'pinned', durationMs: 40, usage: { inputTokens: 5, outputTokens: 1, costUsd: null }, status: 'success', failureReason: 'none' });
function entry(owner: ResultCacheActor, keyDigest: `sha256:${string}`): ResultCacheEntry {
  const now = Date.now();
  const unsigned: Omit<ResultCacheEntry, 'integrityDigest'> = { schemaVersion: 'decision-result-cache/v1', revision: 1, entryId: `entry-${owner.workspaceId}`,
    scope: { tenantId: owner.tenantId, projectId: owner.projectId, workspaceId: owner.workspaceId }, keyDigest, identityDigest: keyDigest,
    policyVersion: policy.policyVersion, sensitivity: 'internal', createdAtEpochMs: now, expiresAtEpochMs: now + 60_000,
    evidence: { ...evidence(), resultDigest: digestCachedResult(evidence().result) } };
  return { ...unsigned, integrityDigest: entryIntegrityDigest(unsigned) };
}
async function stores(run: (store: ResultCacheStore, kind: string, dir: string | null) => Promise<void>): Promise<void> {
  await run(new MemoryResultCacheStore(), 'memory', null);
  const dir = await mkdtemp(join(tmpdir(), 'result-cache-oracle-'));
  try { await run(new FileResultCacheStore(dir), 'file', dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
/** Outcome of an operation reduced to what a caller can observe: value or error class and message. */
async function observe(work: () => Promise<unknown>): Promise<string> {
  try { const value = await work(); return `ok:${value === null ? 'null' : typeof value === 'boolean' ? value : 'entry'}`; }
  catch (error) { return `error:${(error as Error).constructor.name}:${(error as Error).message}`; }
}
const operations = (store: ResultCacheStore, actor: ResultCacheActor, key: `sha256:${string}`) => ({
  read: () => store.read(actor, key), export: () => store.export(actor, key),
  invalidate: () => store.invalidate(actor, key), delete: () => store.delete(actor, key),
  write: () => store.putIfAbsent(actor, entry(victim, key)),
});

describe('result-cache existence and timing oracles across scopes', () => {
  it('answers a foreign-scope lookup of a present key exactly like a lookup of an absent key', () => stores(async (store, kind) => {
    await store.putIfAbsent(victim, entry(victim, present));
    for (const prober of [foreign, otherProject]) {
      for (const name of ['read', 'export', 'invalidate', 'delete', 'write'] as const) {
        const onPresent = await observe(operations(store, prober, present)[name]);
        const onAbsent = await observe(operations(store, prober, absent)[name]);
        expect(onPresent, `${kind} ${name}`).toBe(onAbsent);
      }
    }
    // Probing, invalidation and deletion attempts from other scopes never touched the victim.
    expect((await store.read(victim, present))?.entryId).toBe('entry-victim');
  }));

  it('refuses each operation without its permission with one indistinguishable denial', () => stores(async (store, kind) => {
    await store.putIfAbsent(victim, entry(victim, present));
    for (const permission of ALL) {
      const denied: ResultCacheActor = { ...victim, permissions: ALL.filter(value => value !== permission) };
      const name = permission === 'write' ? 'write' : permission;
      const outcomes = new Set<string>();
      for (const actor of [denied, { ...denied, workspaceId: 'attacker' }]) {
        for (const key of [present, absent]) outcomes.add(await observe(operations(store, actor, key)[name]));
      }
      expect([...outcomes], `${kind} ${permission}`).toEqual([`error:ResultCacheAccessDeniedError:${new ResultCacheAccessDeniedError().message}`]);
    }
    expect((await store.read(victim, present))?.entryId).toBe('entry-victim');
  }));

  it('AC15: rejects unauthorized invalidate, export and delete on both Memory and File stores without side effects', async () => {
    const covered: string[] = [];
    await stores(async (store, kind) => {
      await store.putIfAbsent(victim, entry(victim, present));
      for (const permission of ['invalidate', 'export', 'delete'] as const) {
        const lacking: ResultCacheActor = { ...victim, subjectId: 'intruder', permissions: ALL.filter(value => value !== permission) };
        for (const key of [present, absent]) {
          await expect(operations(store, lacking, key)[permission](), `${kind} ${permission}`).rejects.toBeInstanceOf(ResultCacheAccessDeniedError);
        }
        // A caller holding the permission but in another scope cannot reach the victim entry either.
        const scoped = await observe(operations(store, foreign, present)[permission]);
        expect(scoped, `${kind} ${permission}`).toBe(permission === 'export' ? 'ok:null' : 'ok:false');
        expect((await store.read(victim, present))?.entryId, `${kind} ${permission}`).toBe('entry-victim');
        covered.push(`${kind}:${permission}`);
      }
    });
    expect(covered).toEqual(['memory:invalidate', 'memory:export', 'memory:delete', 'file:invalidate', 'file:export', 'file:delete']);
  });

  it('never reads victim storage during a foreign lookup, so corrupt or unreadable entries cannot leak existence', async () => {
    const memory = new MemoryResultCacheStore();
    await memory.putIfAbsent(victim, entry(victim, present));
    const internal = (memory as unknown as { entries: Map<string, ResultCacheEntry> }).entries;
    for (const value of internal.values()) value.integrityDigest = pin('9').digest;
    await expect(memory.read(victim, present)).rejects.toThrow();
    expect(await memory.read(foreign, present)).toBeNull();

    const dir = await mkdtemp(join(tmpdir(), 'result-cache-oracle-fs-'));
    try {
      const file = new FileResultCacheStore(dir);
      await file.putIfAbsent(victim, entry(victim, present));
      const [name] = (await readdir(dir)).filter(value => value.endsWith('.json'));
      await chmod(join(dir, name!), 0o000);
      // Root ignores file modes; the property still holds, but only the foreign result is asserted then.
      if (process.getuid?.() !== 0) await expect(file.read(victim, present)).rejects.toThrow();
      expect(await file.read(foreign, present)).toBeNull();
      expect(await file.export(foreign, present)).toBeNull();
      await chmod(join(dir, name!), 0o600);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('gives a foreign caller the same service events, store calls and fill as a cold key', async () => {
    const trace = async (key: 'present' | 'absent') => {
      const inner = new MemoryResultCacheStore();
      await inner.putIfAbsent(victim, entry(victim, present));
      const calls: string[] = [];
      const recording: ResultCacheStore = {
        read: (a, k) => { calls.push('read'); return inner.read(a, k); },
        putIfAbsent: (a, e) => { calls.push('putIfAbsent'); return inner.putIfAbsent(a, e); },
        invalidate: (a, k, id) => { calls.push('invalidate'); return inner.invalidate(a, k, id); },
        delete: (a, k) => { calls.push('delete'); return inner.delete(a, k); },
        export: (a, k) => { calls.push('export'); return inner.export(a, k); },
      };
      const events: string[] = [];
      const cache = new DecisionResultCache(recording, event => events.push(`${event.event}:${event.reason}`));
      let fills = 0;
      const outcome = await cache.evaluate({ actor: foreign, policy, identity: identity(key === 'present' ? 'victim subject' : 'never stored'),
        callerInvocationId: 'probe', nowEpochMs: Date.now(), operationId: 'op' }, async () => { fills += 1; return evidence(); });
      return { calls, events, fills, disposition: outcome.receipt.disposition, attempted: outcome.receipt.providerAttempted };
    };
    const onPresent = await trace('present');
    expect(onPresent).toEqual(await trace('absent'));
    expect(onPresent).toMatchObject({ disposition: 'cache-miss-fill', fills: 1, attempted: true });
  });

  it('keeps foreign-present and absent filesystem lookups within the same latency band', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'result-cache-oracle-timing-'));
    try {
      const store = new FileResultCacheStore(dir);
      await store.putIfAbsent(victim, entry(victim, present));
      const samples: Record<'present' | 'absent', number[]> = { present: [], absent: [] };
      for (let index = 0; index < 20; index += 1) { await store.read(foreign, present); await store.read(foreign, absent); }
      // Interleave so scheduler noise and cache warmth affect both series equally.
      for (let index = 0; index < 150; index += 1) {
        for (const [label, key] of (index % 2 ? [['present', present], ['absent', absent]] : [['absent', absent], ['present', present]]) as Array<['present' | 'absent', `sha256:${string}`]>) {
          const start = performance.now(); await store.read(foreign, key); samples[label].push(performance.now() - start);
        }
      }
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
      const [p, a] = [median(samples.present), median(samples.absent)];
      // Both paths perform the same syscalls on a path the victim never owns; the band is
      // deliberately loose so it detects a structural difference (a victim read), not noise.
      expect(Math.abs(p - a)).toBeLessThan(Math.max(0.5, 0.5 * Math.max(p, a)));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
