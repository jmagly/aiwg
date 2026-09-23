import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileDecisionLifecycleStore } from '../../../src/decision/file-lifecycle-store.js';
import { FileDebugSidecarBackend } from '../../../src/decision/telemetry/file-debug-backend.js';
import { DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, eraseDecisionSubject,
  mayRestoreDecisionReference, placeDecisionLifecycleHold, releaseDecisionLifecycleHold,
  type DecisionLifecyclePolicy, type DecisionLifecycleReference, type DecisionLifecycleSurface } from '../../../src/decision/lifecycle.js';

const policy = (): DecisionLifecyclePolicy => ({ version: DECISION_LIFECYCLE_VERSION,
  surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
    classification: 'restricted', accessScopes: ['case-worker'], retentionMs: 100, export: 'denied',
    deletion: 'erase', backup: 'expire-with-primary',
  }])) as DecisionLifecyclePolicy['surfaces'] });

async function withStore(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'decision-lifecycle-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

describe('local lifecycle journal integration', () => {
  it('cascades all eleven surfaces across restart; tombstones block restored backups', async () => withStore(async root => {
    const erased = vi.fn(async (_id: string) => undefined);
    const erasers = Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, erased])) as
      Record<DecisionLifecycleSurface, (id: string) => Promise<void>>;
    const store = new FileDecisionLifecycleStore(root, erasers);
    for (const surface of DECISION_LIFECYCLE_SURFACES) await store.register('case-7', { surface, opaqueId: `${surface}-record` });
    const restarted = new FileDecisionLifecycleStore(root, erasers);
    expect(await restarted.links('case-7')).toHaveLength(DECISION_LIFECYCLE_SURFACES.length);
    const deleted = await eraseDecisionSubject('case-7', policy(), restarted, 200);
    expect(deleted).toHaveLength(DECISION_LIFECYCLE_SURFACES.length);
    expect(erased).toHaveBeenCalledTimes(DECISION_LIFECYCLE_SURFACES.length);
    for (const ref of await store.links('case-7')) {
      expect(mayRestoreDecisionReference(ref, 150, 201, policy(), await store.tombstones('case-7'))).toBe(false);
    }
    const records = (await readFile(join(root, 'lifecycle.jsonl'), 'utf8')).split('\n').filter(Boolean);
    expect(records).toHaveLength(DECISION_LIFECYCLE_SURFACES.length * 2);
    expect((await stat(join(root, 'lifecycle.jsonl'))).mode & 0o077).toBe(0);
    expect((await stat(root)).mode & 0o077).toBe(0);
    expect(records.join('')).not.toContain('synthetic-sensitive-body-canary');
  }));

  it('persists a hold across restart and releases only the selected hold', async () => withStore(async root => {
    const erase = vi.fn(async () => undefined);
    const store = new FileDecisionLifecycleStore(root, { review: erase });
    const ref: DecisionLifecycleReference = { surface: 'review', opaqueId: 'review-opaque' };
    await store.register('case-7', ref);
    const hold = { subject: 'case-7', reason: 'incident', scope: ['review' as const],
      expiresAt: 300, authorizedBy: 'operator' };
    const second = { ...hold, reason: 'second-review' };
    await placeDecisionLifecycleHold(hold, async () => true, store, 200);
    await placeDecisionLifecycleHold(second, async () => true, store, 200);
    const restarted = new FileDecisionLifecycleStore(root, { review: erase });
    expect(await restarted.holds('case-7')).toHaveLength(2);
    await releaseDecisionLifecycleHold(hold, 'operator', 'authorized release', async () => true, restarted, 210);
    expect(await restarted.holds('case-7')).toEqual([second]);
    await expect(eraseDecisionSubject('case-7', policy(), restarted, 220)).rejects.toThrow(/hold/);
    await releaseDecisionLifecycleHold(second, 'operator', 'authorized release', async () => true, restarted, 230);
    await eraseDecisionSubject('case-7', policy(), restarted, 240);
    expect(erase).toHaveBeenCalledOnce();
  }));

  it('cascades a real local debug sidecar through the lifecycle journal', async () => withStore(async root => {
    const backend = new FileDebugSidecarBackend(join(root, 'debug'));
    const id = randomUUID();
    await backend.put({ id, scope: 'case-7', expiresAt: 300, nonce: Buffer.alloc(12),
      tag: Buffer.alloc(16), ciphertext: Buffer.from('synthetic-encrypted-fixture') });
    const store = new FileDecisionLifecycleStore(join(root, 'lifecycle'), { 'debug-sidecar': id => backend.delete(id) });
    await store.register('case-7', { surface: 'debug-sidecar', opaqueId: id });
    expect(await backend.get(id)).not.toBeNull();
    await eraseDecisionSubject('case-7', policy(), store, 200);
    expect(await backend.get(id)).toBeNull();
    expect((await store.tombstones('case-7')).map(t => t.reference.opaqueId)).toEqual([id]);
  }));

  it('fails closed without a surface eraser and rejects malformed journal or unsafe IDs', async () => withStore(async root => {
    const store = new FileDecisionLifecycleStore(root, {});
    await store.register('case-7', { surface: 'debug-sidecar', opaqueId: 'opaque' });
    await expect(eraseDecisionSubject('case-7', policy(), store, 200)).rejects.toThrow(/erasure failed/);
    expect(await store.tombstones('case-7')).toHaveLength(1);
    await expect(store.register('case-7', { surface: 'state', opaqueId: '../private' })).rejects.toThrow(/opaque/);
    await writeFile(join(root, 'lifecycle.jsonl'), '{"kind":"unknown"}\n');
    await expect(store.links('case-7')).rejects.toThrow(/journal invalid/);
    expect(await readdir(root)).toEqual(['lifecycle.jsonl']);
  }));
});
