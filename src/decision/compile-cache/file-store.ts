import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../../security/artifact-trust.js';
import { compileCacheKey, sha256, validateCompileIdentity } from './identity.js';
import { CompileCacheRejectedError } from './store.js';
import type {
  CompileCacheEntry,
  CompileCacheIdentity,
  CompileCacheReadContext,
  CompileCacheResult,
  Sha256,
} from './types.js';

interface CompileCacheLockOwner {
  version: 1;
  pid: number;
  token: string;
  createdAtEpochMs: number;
}

const DEFAULT_LOCK_POLL_MS = 25;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/** Durable, atomic filesystem cache. Files are named only by one-way key digests. */
export class FileCompileCache<T> {
  private readonly fills = new Map<Sha256, Promise<CompileCacheEntry<T>>>();
  private readonly lockPollMs: number;
  private readonly lockTimeoutMs: number;

  constructor(private readonly directory: string, options: { lockPollMs?: number; lockTimeoutMs?: number } = {}) {
    this.lockPollMs = this.positiveInteger(options.lockPollMs ?? DEFAULT_LOCK_POLL_MS, 'lockPollMs');
    this.lockTimeoutMs = this.positiveInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, 'lockTimeoutMs');
  }

  async getOrCompile(identity: CompileCacheIdentity, context: CompileCacheReadContext, ttlMs: number,
    compile: () => Promise<T>, options: { bypass?: boolean } = {}): Promise<CompileCacheResult<T>> {
    validateCompileIdentity(identity);
    const key = compileCacheKey(identity);
    if (options.bypass) return { outcome: 'bypass', key, entry: await this.build(identity, key, context, ttlMs, compile) };
    const existing = await this.read(identity, context);
    if (existing) return { outcome: 'hit', key, entry: existing };
    const active = this.fills.get(key);
    if (active) return { outcome: 'hit', key, entry: this.revalidate(await active, identity, context) };
    const fill = this.buildWithFileLock(identity, key, context, ttlMs, compile);
    const shared = fill.then(result => result.entry);
    void shared.catch(() => undefined);
    this.fills.set(key, shared);
    try {
      const result = await fill;
      return { outcome: result.filled ? 'miss' : 'hit', key, entry: structuredClone(result.entry) };
    } finally { this.fills.delete(key); }
  }

  async read(identity: CompileCacheIdentity, context: CompileCacheReadContext): Promise<CompileCacheEntry<T> | null> {
    const path = this.path(compileCacheKey(identity));
    try { return this.revalidate(JSON.parse(await readFile(path, 'utf8')) as CompileCacheEntry<T>, identity, context); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error instanceof CompileCacheRejectedError ? error : new CompileCacheRejectedError();
    }
  }

  async tombstone(identity: CompileCacheIdentity, context: CompileCacheReadContext): Promise<void> {
    const entry = await this.read(identity, context);
    if (entry) await this.publish({ ...entry, tombstonedAtEpochMs: context.nowEpochMs });
  }

  async setLegalHold(identity: CompileCacheIdentity, context: CompileCacheReadContext, legalHold: boolean): Promise<void> {
    const entry = await this.read(identity, context);
    if (entry) await this.publish({ ...entry, legalHold });
  }

  async delete(identity: CompileCacheIdentity, context: CompileCacheReadContext): Promise<boolean> {
    const entry = await this.read(identity, context);
    if (!entry || entry.legalHold) return false;
    try { await unlink(this.path(entry.key)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  /** Export is explicit and scope-authorized; callers own encryption of backup media. */
  async backup(identity: CompileCacheIdentity, context: CompileCacheReadContext): Promise<CompileCacheEntry<T> | null> {
    return this.read(identity, context);
  }

  async restore(entry: CompileCacheEntry<T>, context: CompileCacheReadContext): Promise<void> {
    this.revalidate(entry, entry.identity, context, true);
    await this.publish(structuredClone(entry));
  }

  private async buildWithFileLock(identity: CompileCacheIdentity, key: Sha256, context: CompileCacheReadContext,
    ttlMs: number, compile: () => Promise<T>): Promise<{ entry: CompileCacheEntry<T>; filled: boolean }> {
    const owner = await this.acquireFillLock(key);
    try {
      const existing = await this.read(identity, context);
      if (existing) return { entry: existing, filled: false };
      const entry = await this.build(identity, key, context, ttlMs, compile);
      await this.publish(entry);
      return { entry, filled: true };
    } finally { await this.releaseFillLock(key, owner); }
  }

  private async acquireFillLock(key: Sha256): Promise<CompileCacheLockOwner> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const owner: CompileCacheLockOwner = { version: 1, pid: process.pid, token: randomUUID(), createdAtEpochMs: Date.now() };
    const path = this.lockPath(key);
    const started = Date.now();
    while (true) {
      try {
        const handle = await open(path, 'wx', 0o600);
        try { await handle.writeFile(canonicalJson(owner), 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        return owner;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!await this.lockOwnerAlive(path)) {
          await unlink(path).catch(unlinkError => {
            if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
          });
          continue;
        }
        if (Date.now() - started >= this.lockTimeoutMs) throw new CompileCacheRejectedError();
        await new Promise(resolve => setTimeout(resolve, this.lockPollMs));
      }
    }
  }

  private async lockOwnerAlive(path: string): Promise<boolean> {
    try {
      const owner = JSON.parse(await readFile(path, 'utf8')) as Partial<CompileCacheLockOwner>;
      if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid! < 1 || typeof owner.token !== 'string') {
        return this.lockRecordRecentlyCreated(path);
      }
      try { process.kill(owner.pid!, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      return this.lockRecordRecentlyCreated(path);
    }
  }

  private async lockRecordRecentlyCreated(path: string): Promise<boolean> {
    try {
      // Exclusive creation precedes the synced owner record. Both truncated and
      // parseable-but-incomplete metadata must remain owned during that window.
      return Date.now() - (await stat(path)).mtimeMs < Math.max(DEFAULT_LOCK_TIMEOUT_MS, this.lockTimeoutMs * 2);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  private async releaseFillLock(key: Sha256, owner: CompileCacheLockOwner): Promise<void> {
    const path = this.lockPath(key);
    try {
      const current = JSON.parse(await readFile(path, 'utf8')) as Partial<CompileCacheLockOwner>;
      if (current.token === owner.token && current.pid === owner.pid) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
    return value;
  }

  private async build(identity: CompileCacheIdentity, key: Sha256, context: CompileCacheReadContext,
    ttlMs: number, compile: () => Promise<T>): Promise<CompileCacheEntry<T>> {
    if (ttlMs <= 0 || !Number.isSafeInteger(ttlMs) || !context.authorize(identity)
      || identity.tenantId !== context.tenantId || identity.projectId !== context.projectId) throw new CompileCacheRejectedError();
    const value = await compile();
    if (value === undefined || canonicalJson(value) === undefined) throw new Error('compiler returned malformed output');
    return { schemaVersion: 'decision-compile-cache-entry/v1', key, identity: structuredClone(identity),
      value: structuredClone(value), valueDigest: sha256(value), createdAtEpochMs: context.nowEpochMs,
      expiresAtEpochMs: context.nowEpochMs + ttlMs, tombstonedAtEpochMs: null, legalHold: false };
  }

  private revalidate(entry: CompileCacheEntry<T>, identity: CompileCacheIdentity, context: CompileCacheReadContext,
    allowInactive = false): CompileCacheEntry<T> {
    const valid = entry.schemaVersion === 'decision-compile-cache-entry/v1'
      && entry.key === compileCacheKey(entry.identity) && entry.key === compileCacheKey(identity)
      && canonicalJson(entry.identity) === canonicalJson(identity) && entry.valueDigest === sha256(entry.value)
      && entry.identity.tenantId === context.tenantId && entry.identity.projectId === context.projectId
      && context.authorize(entry.identity) && (allowInactive || (entry.tombstonedAtEpochMs === null
        && context.nowEpochMs < entry.expiresAtEpochMs));
    if (!valid) throw new CompileCacheRejectedError();
    return structuredClone(entry);
  }

  private path(key: Sha256): string { return join(this.directory, `${key.slice('sha256:'.length)}.json`); }
  private lockPath(key: Sha256): string { return join(this.directory, `${key.slice('sha256:'.length)}.lock`); }

  private async publish(entry: CompileCacheEntry<T>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(entry.key);
    const temporary = join(dirname(path), `.compile-cache-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(canonicalJson(entry), 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(temporary, path); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
}
