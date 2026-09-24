import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '../security/artifact-trust.js';
import type { DecisionJob, DecisionJobItem } from './job-contract.js';
import { DecisionJobRuntime } from './job-runtime.js';
import { JobConflictError, type JobScope, type JobSnapshot } from './job-store.js';

/** Host-only object authorization boundary. The key and actor come from the trusted host, never a request body. */
export class DecisionJobGateway {
  constructor(private readonly runtime: DecisionJobRuntime, private readonly key: Buffer,
    private readonly now: () => number = Date.now,
    private readonly pollGate?: (actor: JobScope) => Promise<void>,
    private readonly capabilities?: {
      listSnapshots: () => Promise<JobSnapshot[]>;
      authorizeExport: (actor: JobScope, snapshot: JobSnapshot) => Promise<boolean>;
    },
    private readonly admitJob?: (job: DecisionJob) => void) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new JobConflictError('Invalid job handle key');
    this.key = Buffer.from(key);
  }
  async submit(actor: JobScope, job: DecisionJob): Promise<{ handle: string; snapshot: JobSnapshot }> {
    this.admitJob?.(job);
    const snapshot = await this.runtime.submit(job, actor);
    if (snapshot.deleted || this.now() >= snapshot.job.expiresAtEpochMs) throw new JobConflictError('Job unavailable');
    return { handle: this.seal(snapshot), snapshot };
  }
  async poll(actor: JobScope, handle: string): Promise<JobSnapshot | null> {
    if (this.pollGate) await this.pollGate(actor);
    const id = this.unseal(actor, handle);
    if (!id) return null;
    const snapshot = await this.runtime.poll(actor, id.id);
    return snapshot && snapshot.job.fingerprint === id.fingerprint && snapshot.job.createdAtEpochMs === id.createdAtEpochMs &&
      snapshot.job.expiresAtEpochMs === id.expiresAtEpochMs && this.now() < snapshot.job.expiresAtEpochMs ? snapshot : null;
  }
  async items(actor: JobScope, handle: string, offset = 0, limit = 100): Promise<DecisionJobItem[] | null> {
    const snapshot = await this.poll(actor, handle);
    return snapshot ? this.runtime.items(actor, snapshot.job.id, offset, limit) : null;
  }
  async cancel(actor: JobScope, handle: string): Promise<JobSnapshot | null> {
    const snapshot = await this.poll(actor, handle);
    return snapshot ? this.runtime.cancel(actor, snapshot.job.id) : null;
  }
  async retry(actor: JobScope, handle: string, itemId: string): Promise<JobSnapshot | null> {
    const snapshot = await this.poll(actor, handle);
    return snapshot ? this.runtime.retry(actor, snapshot.job.id, itemId) : null;
  }
  async remove(actor: JobScope, handle: string): Promise<boolean> {
    const snapshot = await this.poll(actor, handle);
    return snapshot ? this.runtime.remove(actor, snapshot.job.id) : false;
  }
  async export(actor: JobScope, handle: string): Promise<JobSnapshot | null> {
    const snapshot = await this.poll(actor, handle);
    if (!snapshot || !this.capabilities || !await this.capabilities.authorizeExport(actor, snapshot)) return null;
    return snapshot;
  }
  async list(actor: JobScope, cursor?: string, limit = 100): Promise<{ handles: string[]; next: string | null } | null> {
    if (!this.capabilities || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
    if (this.pollGate) await this.pollGate(actor);
    let after: string | null = null;
    if (cursor !== undefined) {
      const position = this.open(actor, cursor, 'dc1_') as { scope?: JobScope; after?: string } | null;
      if (!position || typeof position.after !== 'string') return null;
      after = position.after;
    }
    const records = (await this.capabilities.listSnapshots())
      .filter(record => !record.deleted && this.now() < record.job.expiresAtEpochMs &&
        canonicalJson(record.job.scope) === canonicalJson(actor))
      .sort((a, b) => a.job.id < b.job.id ? -1 : a.job.id > b.job.id ? 1 : 0);
    if (after !== null && !records.some(record => record.job.id === after)) return null;
    const candidates = records.filter(record => after === null || record.job.id > after);
    const page = candidates.slice(0, limit);
    return { handles: page.map(record => this.seal(record)),
      next: candidates.length > page.length ? this.encrypt('dc1_', { scope: actor, after: page.at(-1)!.job.id }) : null };
  }
  private seal(snapshot: JobSnapshot): string {
    const { scope, id, fingerprint, createdAtEpochMs, expiresAtEpochMs } = snapshot.job;
    return this.encrypt('dj1_', { scope, id, fingerprint, createdAtEpochMs, expiresAtEpochMs });
  }
  private encrypt(prefix: string, value: object): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(canonicalJson(value), 'utf8'), cipher.final()]);
    return `${prefix}${Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
  }
  private open(actor: JobScope, handle: string, prefix: string): Record<string, unknown> | null {
    if (typeof handle !== 'string' || !handle.startsWith(prefix) || !/^[A-Za-z0-9_-]{40,2048}$/.test(handle.slice(4))) return null;
    try {
      const bytes = Buffer.from(handle.slice(4), 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const decoded = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as Record<string, unknown>;
      const expected = Buffer.from(canonicalJson(actor)); const actual = Buffer.from(canonicalJson(decoded.scope));
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
      return decoded;
    } catch { return null; }
  }
  private unseal(actor: JobScope, handle: string): Pick<DecisionJob, 'id' | 'fingerprint' | 'createdAtEpochMs' | 'expiresAtEpochMs'> | null {
    const decoded = this.open(actor, handle, 'dj1_');
    if (!decoded || typeof decoded.id !== 'string' || typeof decoded.fingerprint !== 'string' ||
        !Number.isSafeInteger(decoded.createdAtEpochMs) || !Number.isSafeInteger(decoded.expiresAtEpochMs)) return null;
    return decoded as unknown as Pick<DecisionJob, 'id' | 'fingerprint' | 'createdAtEpochMs' | 'expiresAtEpochMs'>;
  }
}
