import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { access, link, lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireDirectoryLock } from '../artifacts/prebuilt-build-lock.js';
import { canonicalJson } from '../security/artifact-trust.js';
import { artifactDigest } from './validate.js';
import { FileJobStore, JobConflictError, type JobScope } from './job-store.js';

export type JobPayloadKind = 'input' | 'result';
interface Envelope {
  version: 'decision-job-payload/v1';
  digest: string; expiresAtEpochMs: number; bytes: number;
  project: string; principal: string;
  nonce: string; tag: string; ciphertext: string; mac: string;
}
export interface JobPayloadLimits { itemBytes: number; principalBytes: number; projectBytes: number }
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Host-only protected JSON value store, bound to job pins and an independent D10 authority. */
export class FileJobPayloadStore {
  private readonly key: Buffer;
  constructor(private readonly directory: string, key: Buffer,
    private readonly journal: FileJobStore,
    private readonly externallyDeleted: (scope: JobScope, id: string) => Promise<boolean>,
    private readonly limits: JobPayloadLimits,
    private readonly now: () => number = Date.now,
    private readonly metadataBytes?: (scope: JobScope, tier: 'principal' | 'project') => Promise<number>) {
    if (!Buffer.isBuffer(key) || key.length !== 32 || typeof externallyDeleted !== 'function' ||
        ![limits.itemBytes, limits.principalBytes, limits.projectBytes].every(n => Number.isSafeInteger(n) && n > 0) ||
        limits.itemBytes > 1_048_576 || limits.itemBytes > limits.principalBytes || limits.principalBytes > limits.projectBytes)
      throw new JobConflictError('Invalid protected job payload configuration');
    this.key = Buffer.from(key);
  }
  async put(scope: JobScope, jobId: string, itemId: string, kind: JobPayloadKind, value: unknown): Promise<void> {
    const digest = artifactDigest(value);
    const plain = Buffer.from(canonicalJson(value), 'utf8');
    if (plain.length > this.limits.itemBytes) throw new JobConflictError('Protected job payload limit exceeded');
    await this.ensurePrivate();
    const release = await acquireDirectoryLock(join(this.directory, '.quota-lock'), { timeoutMs: 5000, pollMs: 20 });
    try {
      const job = await this.authorize(scope, jobId, itemId, kind, digest);
      const file = this.file(scope, jobId, itemId, kind);
      const existing = await this.readEnvelope(file);
      if (existing) {
        if (existing.digest !== digest || existing.expiresAtEpochMs !== job.expiresAtEpochMs ||
            canonicalJson(await this.get(scope, jobId, itemId, kind)) !== plain.toString('utf8'))
          throw new JobConflictError('Conflicting protected job payload');
        return;
      }
      const project = hash([scope.tenantId, scope.projectId]);
      const principal = hash([scope.tenantId, scope.projectId, scope.workspaceId, scope.principalId]);
      let totalProject = plain.length; let totalPrincipal = plain.length;
      for (const name of await readdir(this.directory)) {
        if (!/^[a-f0-9]{64}\.[a-f0-9]{64}\.json$/.test(name)) continue;
        const envelope = await this.readEnvelope(join(this.directory, name));
        if (!envelope) throw new JobConflictError('Protected job payload unavailable');
        if (envelope.project === project) totalProject += envelope.bytes;
        if (envelope.principal === principal) totalPrincipal += envelope.bytes;
      }
      if (this.metadataBytes) {
        totalProject += await this.metadataBytes(scope, 'project');
        totalPrincipal += await this.metadataBytes(scope, 'principal');
      }
      if (!Number.isSafeInteger(totalProject) || !Number.isSafeInteger(totalPrincipal) ||
          totalProject > this.limits.projectBytes || totalPrincipal > this.limits.principalBytes)
        throw new JobConflictError('Protected job payload limit exceeded');
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
      cipher.setAAD(this.aad(scope, jobId, itemId, kind, digest, job.expiresAtEpochMs));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      const fields = { version: 'decision-job-payload/v1' as const, digest, expiresAtEpochMs: job.expiresAtEpochMs,
        bytes: plain.length, project, principal, nonce: nonce.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'), ciphertext: encrypted.toString('base64url') };
      const envelope: Envelope = { ...fields, mac: this.mac(fields) };
      const temporary = join(this.directory, `.payload-${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(`${canonicalJson(envelope)}\n`); await handle.sync(); } finally { await handle.close(); }
      try {
        await link(temporary, file);
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new JobConflictError('Conflicting protected job payload'); throw error; }
      finally { await rm(temporary, { force: true }); }
    } finally { await release(); }
  }
  async get(scope: JobScope, jobId: string, itemId: string, kind: JobPayloadKind): Promise<unknown | null> {
    await this.ensurePrivate();
    const job = await this.authorize(scope, jobId, itemId, kind);
    const envelope = await this.readEnvelope(this.file(scope, jobId, itemId, kind));
    if (!envelope) return null;
    if (envelope.expiresAtEpochMs !== job.expiresAtEpochMs) throw new JobConflictError('Protected job payload expiry mismatch');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.nonce, 'base64url'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      decipher.setAAD(this.aad(scope, jobId, itemId, kind, envelope.digest, envelope.expiresAtEpochMs));
      const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8')) as unknown;
      if (envelope.project !== hash([scope.tenantId, scope.projectId]) ||
          envelope.principal !== hash([scope.tenantId, scope.projectId, scope.workspaceId, scope.principalId]) ||
          artifactDigest(value) !== envelope.digest || Buffer.byteLength(canonicalJson(value)) !== envelope.bytes ||
          (kind === 'input' ? job.items.find(item => item.id === itemId)?.subjectDigest :
            job.items.find(item => item.id === itemId)?.resultDigest) !== envelope.digest)
        throw new JobConflictError('Protected job payload integrity mismatch');
      return value;
    } catch { throw new JobConflictError('Protected job payload integrity mismatch'); }
  }
  /** Aggregate plaintext sizes for the quota journal, called while holding its shared lock. */
  async usage(scope: JobScope, tier: 'principal' | 'project'): Promise<number> {
    await this.ensurePrivate();
    const expected = tier === 'project' ? hash([scope.tenantId, scope.projectId]) :
      hash([scope.tenantId, scope.projectId, scope.workspaceId, scope.principalId]);
    let total = 0;
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.[a-f0-9]{64}\.json$/.test(name)) continue;
      const envelope = await this.readEnvelope(join(this.directory, name));
      if (!envelope) throw new JobConflictError('Protected job payload unavailable');
      if ((tier === 'project' ? envelope.project : envelope.principal) === expected) total += envelope.bytes;
    }
    if (!Number.isSafeInteger(total)) throw new JobConflictError('Protected job payload usage invalid');
    return total;
  }
  /** Host-only D10 eraser; call after independently persisted tombstone and authorized job deletion. */
  async purgeDeleted(scope: JobScope, jobId: string): Promise<void> {
    await this.ensurePrivate();
    const current = await this.journal.read(scope, jobId);
    if (!await this.externallyDeleted(scope, jobId) || current && (!current.deleted || current.legalHold))
      throw new JobConflictError('Independent job tombstone required');
    const release = await acquireDirectoryLock(join(this.directory, '.quota-lock'), { timeoutMs: 5000, pollMs: 20 });
    try {
      const marker = this.marker(scope, jobId);
      try { const handle = await open(marker, 'wx', 0o600); try { await handle.sync(); } finally { await handle.close(); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const prefix = `${hash([scope, jobId])}.`;
      for (const name of await readdir(this.directory))
        if (name.startsWith(prefix) && /^[a-f0-9]{64}\.json$/.test(name.slice(prefix.length))) await rm(join(this.directory, name));
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await release(); }
  }
  private async authorize(scope: JobScope, jobId: string, itemId: string, kind: JobPayloadKind, digest?: string) {
    if (!['input', 'result'].includes(kind) || typeof itemId !== 'string' || !itemId) throw new JobConflictError('Job unavailable');
    if (await this.externallyDeleted(scope, jobId)) throw new JobConflictError('Job unavailable');
    try { await access(this.marker(scope, jobId)); throw new JobConflictError('Job unavailable'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const record = await this.journal.read(scope, jobId);
    if (!record || record.deleted || this.now() >= record.job.expiresAtEpochMs) throw new JobConflictError('Job unavailable');
    const item = record.job.items.find(entry => entry.id === itemId);
    if (!item || kind === 'result' && (!['succeeded', 'review', 'abstained'].includes(item.state) ||
        !item.attempts.some(attempt => attempt.outcome === 'succeeded' && attempt.receiptDigest)))
      throw new JobConflictError('Job unavailable');
    if (digest && (kind === 'input' ? item.subjectDigest : item.resultDigest) !== digest)
      throw new JobConflictError('Protected job payload pin mismatch');
    return record.job;
  }
  private file(scope: JobScope, id: string, itemId: string, kind: JobPayloadKind): string {
    return join(this.directory, `${hash([scope, id])}.${hash([itemId, kind])}.json`);
  }
  private marker(scope: JobScope, id: string): string { return join(this.directory, `${hash([scope, id])}.deleted`); }
  private aad(scope: JobScope, id: string, item: string, kind: JobPayloadKind, digest: string, expiry: number): Buffer {
    return Buffer.from(canonicalJson({ scope, id, item, kind, digest, expiry }));
  }
  private async ensurePrivate(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new JobConflictError('Protected job payload root must be private');
  }
  private mac(fields: Omit<Envelope, 'mac'>): string {
    return createHmac('sha256', this.key).update('decision-job-payload-header/v1:').update(canonicalJson(fields)).digest('hex');
  }
  private async readEnvelope(file: string): Promise<Envelope | null> {
    let info;
    try { info = await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > this.limits.itemBytes * 2 + 1024)
      throw new JobConflictError('Protected job payload file must be private');
    const envelope = JSON.parse(await readFile(file, 'utf8')) as Envelope;
    if (envelope?.version !== 'decision-job-payload/v1' || !/^sha256:[a-f0-9]{64}$/.test(envelope.digest) ||
        !Number.isSafeInteger(envelope.expiresAtEpochMs) || !Number.isSafeInteger(envelope.bytes) || envelope.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(envelope.project) || !/^[a-f0-9]{64}$/.test(envelope.principal) ||
        ![envelope.nonce, envelope.tag, envelope.ciphertext].every(part => typeof part === 'string' && /^[A-Za-z0-9_-]+$/.test(part)) ||
        typeof envelope.mac !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.mac))
      throw new JobConflictError('Protected job payload invalid');
    const { mac, ...fields } = envelope;
    if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(this.mac(fields), 'hex')))
      throw new JobConflictError('Protected job payload integrity mismatch');
    return envelope;
  }
}
