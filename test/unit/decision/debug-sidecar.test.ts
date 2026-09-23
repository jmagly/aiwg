import { describe, expect, it, vi } from 'vitest';
import { DecisionDebugSidecar, type DebugSidecarBackend, type EncryptedDebugSidecar } from '../../../src/decision/telemetry/debug-sidecar.js';
import type { DecisionDebugCapturePolicy } from '../../../src/decision/telemetry/types.js';

const policy = (): DecisionDebugCapturePolicy => ({ explicitlyAuthorized: true,
  encryption: { enabled: true, keyReference: 'logical-debug-key' },
  accessAudit: { enabled: true, sinkReference: 'logical-audit' }, classification: 'restricted',
  ttlMs: 100, deletionEnabled: true });

function fixture() {
  const records = new Map<string, EncryptedDebugSidecar>();
  const audit = vi.fn(async (_event: unknown) => undefined);
  const backend: DebugSidecarBackend = {
    put: async record => { records.set(record.id, record); },
    get: async id => records.get(id) ?? null,
    delete: async id => { records.delete(id); },
    listExpired: async (scope, before) => [...records.values()].filter(record => record.scope === scope && record.expiresAt <= before),
    audit,
  };
  const authorize = vi.fn(async (scope: string) => scope === 'approved');
  const resolveKey = vi.fn(async () => new Uint8Array(32).fill(7));
  let now = 1000;
  const sidecar = new DecisionDebugSidecar(policy(), backend, resolveKey, authorize, () => now);
  return { sidecar, records, audit, authorize, resolveKey, advance: (time: number) => { now = time; } };
}

describe('authorized encrypted debug sidecar', () => {
  it('stores ciphertext only and audits capture/read/delete without exposing plaintext', async () => {
    const f = fixture();
    const canary = 'synthetic-debug-secret-canary';
    const id = await f.sidecar.capture('approved', Buffer.from(canary));
    expect(JSON.stringify([...f.records.values()])).not.toContain(canary);
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain(canary);
    expect(f.resolveKey).toHaveBeenCalledWith('logical-debug-key');
    expect(Buffer.from((await f.sidecar.read('approved', id))!).toString()).toBe(canary);
    await expect(f.sidecar.read('other', id)).rejects.toThrow('Debug read denied');
    await f.sidecar.delete('approved', id);
    expect(f.records.size).toBe(0);
    expect(await f.sidecar.read('approved', id)).toBeNull();
    expect(f.audit.mock.calls.map(([event]) => (event as { operation: string }).operation)).toEqual(['capture', 'read', 'delete']);
  });

  it('expires before key resolution or decrypt and erases content', async () => {
    const f = fixture();
    const id = await f.sidecar.capture('approved', Buffer.from('synthetic-debug-canary'));
    f.resolveKey.mockClear();
    f.advance(1100);
    expect(await f.sidecar.read('approved', id)).toBeNull();
    expect(f.resolveKey).not.toHaveBeenCalled();
    expect(f.records.size).toBe(0);
    expect(f.audit).toHaveBeenLastCalledWith({ operation: 'expire', id, scope: 'approved' });
  });

  it('sweeps expired ciphertext out of band without accessing or returning plaintext', async () => {
    const f = fixture();
    const id = await f.sidecar.capture('approved', Buffer.from('synthetic-debug-secret-canary'));
    f.advance(1099);
    expect(await f.sidecar.sweepExpired('approved')).toBe(0);
    f.advance(1100);
    expect(await f.sidecar.sweepExpired('approved')).toBe(1);
    expect(f.records.size).toBe(0);
    expect(f.audit).toHaveBeenLastCalledWith({ operation: 'expire', id, scope: 'approved' });
    await expect(f.sidecar.sweepExpired('other')).rejects.toThrow('Debug expiry sweep denied');
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain('synthetic-debug-secret-canary');
  });

  it('rechecks scope and expiry against live records returned by an untrusted sweep index', async () => {
    const f = fixture();
    const first = await f.sidecar.capture('approved', Buffer.from('keep-until-expired'));
    f.advance(1100);
    const second = await f.sidecar.capture('approved', Buffer.from('still-live'));
    f.records.get(second)!.scope = 'other';
    expect(await f.sidecar.sweepExpired('approved')).toBe(1);
    expect(f.records.has(first)).toBe(false);
    expect(f.records.has(second)).toBe(true);
  });

  it('fails closed on authorization, audit, or integrity failure', async () => {
    const f = fixture();
    await expect(f.sidecar.capture('other', Buffer.from('canary'))).rejects.toThrow('denied');
    expect(f.resolveKey).not.toHaveBeenCalled();
    f.audit.mockRejectedValueOnce(new Error('audit offline synthetic-debug-secret-canary'));
    await expect(f.sidecar.capture('approved', Buffer.from('canary'))).rejects.toThrow('Debug access audit failed');
    expect(f.records.size).toBe(0);
    const id = await f.sidecar.capture('approved', Buffer.from('canary'));
    f.records.get(id)!.ciphertext[0] ^= 1;
    await expect(f.sidecar.read('approved', id)).rejects.toThrow('integrity check failed');
    await expect(f.sidecar.delete('other', id)).rejects.toThrow('denied');
    expect(f.records.size).toBe(1);
  });

  it('refuses portable private locators and unknown classification', () => {
    const f = fixture();
    const backend: DebugSidecarBackend = { put: async () => {}, get: async () => null,
      delete: async () => {}, listExpired: async () => [], audit: async () => {} };
    for (const invalid of [
      { ...policy(), encryption: { enabled: true, keyReference: 'vault://private/key' } },
      { ...policy(), accessAudit: { enabled: true, sinkReference: 'Bearer canary' } },
      { ...policy(), classification: 'unknown' as 'restricted' },
    ]) expect(() => new DecisionDebugSidecar(invalid, backend, f.resolveKey, f.authorize)).toThrow(/incomplete/);
  });

  it('rejects incomplete capture policies', () => {
    const f = fixture();
    expect(() => new DecisionDebugSidecar({ ...policy(), encryption: { enabled: false, keyReference: 'x' } },
      { put: async () => {}, get: async () => null, delete: async () => {}, listExpired: async () => [], audit: async () => {} },
      f.resolveKey, f.authorize)).toThrow(/incomplete/);
  });
});
