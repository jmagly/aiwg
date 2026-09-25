import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../../security/artifact-trust.js';
import type { DecisionLifecycleHold, DecisionLifecyclePolicy, DecisionLifecycleRule, DecisionLifecycleTombstone } from '../lifecycle.js';
import { compileCacheKey, validateCompileIdentity } from './identity.js';
import {
  activeCompileCacheHold, buildCompileCacheEntry, compileCacheLifecycleRule, compileCacheReference, compileCacheScopeAllowed,
  compileCacheTombstoneRecord, CompileCacheRejectedError, isCompileCacheTombstone, mayRestoreCompileCacheEntry,
  revalidateCompileCacheEntry, validateCompileCacheHold,
} from './records.js';
import type {
  CompileCacheEntry,
  CompileCacheIdentity,
  CompileCacheLifecycleJournal,
  CompileCacheLifecycleOptions,
  CompileCacheReadContext,
  CompileCacheResult,
  CompileCacheTombstoneRecord,
  Sha256,
} from './types.js';

interface CompileCacheLockOwner {
  version: 1;
  pid: number;
  token: string;
  createdAtEpochMs: number;
}

type StoredRecord<T> = CompileCacheEntry<T> | CompileCacheTombstoneRecord;
const isTombstone = <T>(record: StoredRecord<T>): record is CompileCacheTombstoneRecord =>
  record.schemaVersion === 'decision-compile-cache-tombstone/v1';

const DEFAULT_LOCK_POLL_MS = 25;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

export interface FileCompileCacheOptions extends CompileCacheLifecycleOptions {
  lockPollMs?: number;
  lockTimeoutMs?: number;
  /** Optional independent tombstone journal consulted before any restore. */
  lifecycleJournal?: CompileCacheLifecycleJournal;
}

/**
 * Durable, atomic filesystem cache. Files are named only by one-way key digests.
 * Out-of-scope or unauthorized lifecycle calls return the same result as an
 * absent key, decided before the filesystem is touched.
 */
export class FileCompileCache<T> {
  private readonly fills = new Map<Sha256, Promise<CompileCacheEntry<T>>>();
  private readonly lockPollMs: number;
  private readonly lockTimeoutMs: number;
  private readonly policy: DecisionLifecyclePolicy;
  private readonly rule: DecisionLifecycleRule;
  private readonly journal: CompileCacheLifecycleJournal | undefined;

  constructor(private readonly directory: string, options: FileCompileCacheOptions) {
    this.lockPollMs = this.positiveInteger(options.lockPollMs ?? DEFAULT_LOCK_POLL_MS, 'lockPollMs');
    this.lockTimeoutMs = this.positiveInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, 'lockTimeoutMs');
    this.rule = compileCacheLifecycleRule(options.lifecyclePolicy);
    this.policy = structuredClone(options.lifecyclePolicy);
    this.journal = options.lifecycleJournal;
  }

  async getOrCompile(identity: CompileCacheIdentity, context: CompileCacheReadContext, ttlMs: number,
    compile: () => Promise<T>, options: { bypass?: boolean } = {}): Promise<CompileCacheResult<T>> {
    validateCompileIdentity(identity);
    const key = compileCacheKey(identity);
    if (!compileCacheScopeAllowed(identity, context)) throw new CompileCacheRejectedError();
    if (options.bypass) return { outcome: 'bypass', key, entry: await buildCompileCacheEntry(identity, key, context, ttlMs, this.rule, compile) };
    const existing = await this.readExisting(identity, context, true);
    if (existing) return { outcome: 'hit', key, entry: existing };
    const active = this.fills.get(key);
    if (active) return { outcome: 'hit', key, entry: revalidateCompileCacheEntry(await active, identity, context) };
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
    if (!compileCacheScopeAllowed(identity, context)) return null;
    return this.readExisting(identity, context, false);
  }

  private async readExisting(identity: CompileCacheIdentity, context: CompileCacheReadContext,
    refreshExpired: boolean): Promise<CompileCacheEntry<T> | null> {
    // Validate integrity, identity, scope and authorization before deciding
    // whether an expired entry can be treated as a cache miss for a fill.
    const record = await this.readRecord(compileCacheKey(identity));
    if (!record) return null;
    if (isTombstone(record)) throw new CompileCacheRejectedError();
    const entry = revalidateCompileCacheEntry(record, identity, context, true);
    if (context.nowEpochMs >= entry.expiresAtEpochMs) {
      if (refreshExpired) return null;
      throw new CompileCacheRejectedError();
    }
    return entry;
  }

  /** Erase the body and leave a persistent tombstone; the key never fills or restores again. */
  async tombstone(identity: CompileCacheIdentity, context: CompileCacheReadContext): Promise<boolean> {
    return this.retire(identity, context);
  }

  /** D10 deletion: the same body-free tombstone; false when absent, held or already erased. */
  async delete(identity: CompileCacheIdentity, context: CompileCacheReadContext): Promise<boolean> {
    return this.retire(identity, context);
  }

  /** Place (or with `null`, release) a D10 hold scoped to the `cache` surface. */
  async setLegalHold(identity: CompileCacheIdentity, context: CompileCacheReadContext, hold: DecisionLifecycleHold | null): Promise<void> {
    const entry = await this.readLifecycleEntry(identity, context);
    if (entry) await this.publish({ ...entry, legalHold: hold === null ? null : validateCompileCacheHold(hold, context.nowEpochMs) });
  }

  private async retire(identity: CompileCacheIdentity, context: CompileCacheReadContext): Promise<boolean> {
    // Retirement works after expiry, but still authenticates the stored
    // identity and integrity before erasing anything.
    const entry = await this.readLifecycleEntry(identity, context);
    if (!entry || activeCompileCacheHold(entry, context.nowEpochMs)) return false;
    const record = compileCacheTombstoneRecord(entry.key, context.nowEpochMs);
    // Journal first so a failed local write cannot leave a restorable gap.
    if (this.journal) await this.journal.tombstone(structuredClone(record.tombstone));
    await this.publish(record);
    return true;
  }

  /** Authorized live or expired entry; null when absent, out of scope or already tombstoned. */
  private async readLifecycleEntry(identity: CompileCacheIdentity, context: CompileCacheReadContext): Promise<CompileCacheEntry<T> | null> {
    if (!compileCacheScopeAllowed(identity, context)) return null;
    const record = await this.readRecord(compileCacheKey(identity));
    if (!record || isTombstone(record)) return null;
    return revalidateCompileCacheEntry(record, identity, context, true);
  }

  private async readRecord(key: Sha256): Promise<StoredRecord<T> | null> {
    let raw: string;
    try { raw = await readFile(this.path(key), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new CompileCacheRejectedError();
    }
    let record: StoredRecord<T>;
    try { record = JSON.parse(raw) as StoredRecord<T>; } catch { throw new CompileCacheRejectedError(); }
    if (record?.schemaVersion === 'decision-compile-cache-tombstone/v1' && !isCompileCacheTombstone(record, key)) {
      throw new CompileCacheRejectedError();
    }
    return record;
  }

  /** Export is explicit, scope-authorized, and allowed only when the lifecycle rule persists backups. */
  async backup(identity: CompileCacheIdentity, context: CompileCacheReadContext): Promise<CompileCacheEntry<T> | null> {
    if (this.rule.backup === 'not-persisted') throw new CompileCacheRejectedError();
    return this.read(identity, context);
  }

  async restore(entry: CompileCacheEntry<T>, context: CompileCacheReadContext): Promise<void> {
    // Restored backups must still be live at the point of import; old copies
    // cannot resurrect deleted/tombstoned or expired compiler artifacts.
    const restored = revalidateCompileCacheEntry(entry, entry.identity, context);
    const existing = await this.readRecord(restored.key);
    // A backup cannot replace an existing immutable entry or undo any tombstone,
    // whether it is kept locally or in the independent lifecycle journal.
    if (existing && !isTombstone(existing)) throw new CompileCacheRejectedError();
    const tombstones: DecisionLifecycleTombstone[] = existing ? [existing.tombstone] : [];
    if (this.journal) {
      try { tombstones.push(...await this.journal.tombstones(compileCacheReference(restored.key).opaqueId)); }
      catch { throw new CompileCacheRejectedError(); }
    }
    if (!mayRestoreCompileCacheEntry(restored, context.nowEpochMs, this.policy, tombstones)) throw new CompileCacheRejectedError();
    await this.publish(restored);
  }

  private async buildWithFileLock(identity: CompileCacheIdentity, key: Sha256, context: CompileCacheReadContext,
    ttlMs: number, compile: () => Promise<T>): Promise<{ entry: CompileCacheEntry<T>; filled: boolean }> {
    const owner = await this.acquireFillLock(key);
    try {
      const existing = await this.readExisting(identity, context, true);
      if (existing) return { entry: existing, filled: false };
      const entry = await buildCompileCacheEntry(identity, key, context, ttlMs, this.rule, compile);
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

  private path(key: Sha256): string { return join(this.directory, `${key.slice('sha256:'.length)}.json`); }
  private lockPath(key: Sha256): string { return join(this.directory, `${key.slice('sha256:'.length)}.lock`); }

  private async publish(entry: StoredRecord<T>): Promise<void> {
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
