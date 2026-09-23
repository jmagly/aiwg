import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { validateDebugCapturePolicy } from './retention.js';
import type { DecisionDebugCapturePolicy } from './types.js';

export interface EncryptedDebugSidecar {
  id: string;
  scope: string;
  expiresAt: number;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export interface DebugSidecarBackend {
  put(record: EncryptedDebugSidecar): Promise<void>;
  get(id: string): Promise<EncryptedDebugSidecar | null>;
  delete(id: string): Promise<void>;
  listExpired(scope: string, before: number): Promise<EncryptedDebugSidecar[]>;
  audit(event: { operation: 'capture' | 'read' | 'delete' | 'expire'; id: string; scope: string }): Promise<void>;
}

/** Opaque reference and ciphertext only; never serialize plaintext into a receipt or audit event. */
export class DecisionDebugSidecar {
  constructor(
    private readonly policy: DecisionDebugCapturePolicy,
    private readonly backend: DebugSidecarBackend,
    private readonly resolveKey: (reference: string) => Promise<Uint8Array>,
    private readonly authorize: (scope: string, operation: 'capture' | 'read' | 'delete') => Promise<boolean>,
    private readonly clock: () => number = Date.now,
  ) {
    if (!validateDebugCapturePolicy(policy)) throw new Error('Debug capture authorization required');
  }

  async capture(scope: string, plaintext: Uint8Array): Promise<string> {
    if (!scope || !await this.authorize(scope, 'capture')) throw new Error('Debug capture denied');
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + this.policy.ttlMs)) throw new Error('Debug capture clock invalid');
    const id = randomUUID();
    const nonce = randomBytes(12);
    const key = await this.key();
    let ciphertext: Buffer;
    let tag: Buffer;
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(`${id}:${scope}:${now + this.policy.ttlMs}`));
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      tag = cipher.getAuthTag();
    } finally { key.fill(0); }
    // Audit must succeed before content is persisted. An audit failure never opens capture.
    await this.audit('capture', id, scope);
    try { await this.backend.put({ id, scope, expiresAt: now + this.policy.ttlMs, nonce, ciphertext, tag }); }
    catch { throw new Error('Debug sidecar storage failed'); }
    return id;
  }

  async read(scope: string, id: string): Promise<Uint8Array | null> {
    if (!scope || !await this.authorize(scope, 'read')) throw new Error('Debug read denied');
    const record = await this.get(id);
    if (!record || record.scope !== scope) return null;
    if (this.clock() >= record.expiresAt) {
      await this.audit('expire', id, scope);
      await this.erase(id);
      return null;
    }
    await this.audit('read', id, scope);
    const key = await this.key();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, record.nonce);
      decipher.setAAD(Buffer.from(`${id}:${scope}:${record.expiresAt}`));
      decipher.setAuthTag(record.tag);
      return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]);
    } catch {
      throw new Error('Debug sidecar integrity check failed');
    } finally { key.fill(0); }
  }

  async delete(scope: string, id: string): Promise<void> {
    if (!scope || !await this.authorize(scope, 'delete')) throw new Error('Debug deletion denied');
    const record = await this.get(id);
    if (!record || record.scope !== scope) return;
    await this.audit('delete', id, scope);
    await this.erase(id);
  }

  /** Evict expired ciphertext even when nobody reads it. The backend must return
   * only scoped records; each candidate is checked again before erasure. */
  async sweepExpired(scope: string): Promise<number> {
    if (!scope || !await this.authorize(scope, 'delete')) throw new Error('Debug expiry sweep denied');
    const now = this.clock();
    let records: EncryptedDebugSidecar[];
    try { records = await this.backend.listExpired(scope, now); }
    catch { throw new Error('Debug sidecar storage failed'); }
    let deleted = 0;
    for (const candidate of records) {
      const record = await this.get(candidate.id);
      if (!record || record.scope !== scope || now < record.expiresAt) continue;
      await this.audit('expire', record.id, scope);
      await this.erase(record.id);
      deleted++;
    }
    return deleted;
  }

  private async get(id: string): Promise<EncryptedDebugSidecar | null> {
    try { return await this.backend.get(id); }
    catch { throw new Error('Debug sidecar storage failed'); }
  }

  private async erase(id: string): Promise<void> {
    try { await this.backend.delete(id); }
    catch { throw new Error('Debug sidecar deletion failed'); }
  }

  private async audit(operation: 'capture' | 'read' | 'delete' | 'expire', id: string, scope: string): Promise<void> {
    try { await this.backend.audit({ operation, id, scope }); }
    catch { throw new Error('Debug access audit failed'); }
  }

  private async key(): Promise<Buffer> {
    let resolved: Uint8Array;
    try { resolved = await this.resolveKey(this.policy.encryption.keyReference); }
    catch { throw new Error('Debug encryption key unavailable'); }
    if (resolved.length !== 32) throw new Error('Debug encryption key invalid');
    return Buffer.from(resolved);
  }
}
