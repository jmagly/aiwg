import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '../../security/artifact-trust.js';
import { assertResultCacheEntry } from './integrity.js';
import type { ResultCacheActor, ResultCacheEntry, ResultCacheScope, ResultCacheStore } from './types.js';

export class ResultCacheAccessDeniedError extends Error { constructor() { super('Result cache operation denied'); } }

function authorize(actor: ResultCacheActor, permission: ResultCacheActor['permissions'][number], scope?: ResultCacheScope): void {
  if (!actor.permissions.includes(permission) || (scope && (actor.tenantId !== scope.tenantId || actor.projectId !== scope.projectId || actor.workspaceId !== scope.workspaceId))) {
    // Deliberately identical for absence, wrong scope, and missing permission.
    throw new ResultCacheAccessDeniedError();
  }
}
function mapKey(actor: ResultCacheActor, key: string): string { return `${actor.tenantId}\0${actor.projectId}\0${actor.workspaceId}\0${key}`; }

export class MemoryResultCacheStore implements ResultCacheStore {
  private readonly entries = new Map<string, ResultCacheEntry>();
  async read(actor: ResultCacheActor, key: `sha256:${string}`): Promise<ResultCacheEntry | null> {
    authorize(actor, 'read'); const value = this.entries.get(mapKey(actor, key));
    if (!value) return null; authorize(actor, 'read', value.scope); assertResultCacheEntry(value); return structuredClone(value);
  }
  async putIfAbsent(actor: ResultCacheActor, entry: ResultCacheEntry): Promise<ResultCacheEntry> {
    authorize(actor, 'write', entry.scope); assertResultCacheEntry(entry); const key = mapKey(actor, entry.keyDigest);
    const existing = this.entries.get(key); if (existing) { assertResultCacheEntry(existing); return structuredClone(existing); }
    this.entries.set(key, structuredClone(entry)); return structuredClone(entry);
  }
  async invalidate(actor: ResultCacheActor, key: `sha256:${string}`, expectedEntryId?: string): Promise<boolean> { authorize(actor, 'invalidate'); const map = mapKey(actor, key); const current = this.entries.get(map); if (expectedEntryId && current?.entryId !== expectedEntryId) return false; return this.entries.delete(map); }
  async delete(actor: ResultCacheActor, key: `sha256:${string}`): Promise<boolean> { authorize(actor, 'delete'); return this.entries.delete(mapKey(actor, key)); }
  async export(actor: ResultCacheActor, key: `sha256:${string}`): Promise<ResultCacheEntry | null> { authorize(actor, 'export'); const value = this.entries.get(mapKey(actor, key)); if (!value) return null; authorize(actor, 'export', value.scope); assertResultCacheEntry(value); return structuredClone(value); }
}

/** Single-file-per-key store. Atomic hard-link publication prevents overwrite/poisoning. */
export class FileResultCacheStore implements ResultCacheStore {
  constructor(private readonly directory: string, private readonly options: { legalHold?: boolean } = {}) {}
  async withKeyLock<T>(actor: ResultCacheActor, key: `sha256:${string}`, work: () => Promise<T>): Promise<T> {
    authorize(actor, 'read'); authorize(actor, 'write');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = `${this.path(actor, key)}.lock`;
    const deadline = Date.now() + 60_000;
    while (true) {
      try {
        const handle = await open(lock, 'wx', 0o600);
        try {
          try { await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname() })); await handle.sync(); }
          finally { await handle.close(); }
          return await work();
        } finally { await rm(lock, { force: true }); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Only reclaim a dead process on this host; an unreadable or remote lock
        // fails closed rather than risking two provider calls on a shared volume.
        try {
          const before = await stat(lock);
          const owner = JSON.parse(await readFile(lock, 'utf8')) as { pid: number; host: string };
          if (owner.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            let alive = true;
            try { process.kill(owner.pid, 0); } catch (failure) { alive = (failure as NodeJS.ErrnoException).code !== 'ESRCH'; }
            if (!alive && (await stat(lock)).ino === before.ino) { await rm(lock, { force: true }); continue; }
          }
        } catch (failure) {
          // Lock creation and owner write are separate; a transient partial owner
          // is not proof of abandonment. Continue waiting, never break the lock.
          if ((failure as NodeJS.ErrnoException).code !== 'ENOENT' && !(failure instanceof SyntaxError)) throw failure;
        }
        if (Date.now() >= deadline) throw new Error('Result cache fill lock unavailable');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }
  /** Bounded retention sweep for the authenticated scope; never touches other projects. */
  async purgeExpired(actor: ResultCacheActor, nowEpochMs = Date.now()): Promise<number> {
    authorize(actor, 'invalidate');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let removed = 0;
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(this.directory, name);
      try {
        const entry = JSON.parse(await readFile(path, 'utf8')) as ResultCacheEntry;
        if (entry.scope.tenantId !== actor.tenantId || entry.scope.projectId !== actor.projectId
          || entry.scope.workspaceId !== actor.workspaceId) continue;
        assertResultCacheEntry(entry);
        if (this.path(actor, entry.keyDigest) !== path) throw new Error('Cache key substitution');
        if (entry.expiresAtEpochMs <= nowEpochMs && await this.invalidate(actor, entry.keyDigest, entry.entryId)) removed += 1;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return removed;
  }
  async read(actor: ResultCacheActor, key: `sha256:${string}`): Promise<ResultCacheEntry | null> { authorize(actor, 'read'); return this.load(actor, key, 'read'); }
  async putIfAbsent(actor: ResultCacheActor, entry: ResultCacheEntry): Promise<ResultCacheEntry> {
    authorize(actor, 'write', entry.scope); assertResultCacheEntry(entry); await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(actor, entry.keyDigest);
    if (await this.deleted(actor, entry.keyDigest)) throw new ResultCacheAccessDeniedError();
    const tmp = join(this.directory, `.cache-${randomUUID()}.tmp`); const handle = await open(tmp, 'wx', 0o600);
    try {
      try { await handle.writeFile(`${canonicalJson(entry)}\n`); await handle.sync(); } finally { await handle.close(); }
      try { await link(tmp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { await rm(tmp, { force: true }); }
    if (await this.deleted(actor, entry.keyDigest)) {
      await rm(path, { force: true });
      throw new ResultCacheAccessDeniedError();
    }
    const stored = await this.load(actor, entry.keyDigest, 'write'); if (!stored) throw new Error('Cache publication failed'); return stored;
  }
  async invalidate(actor: ResultCacheActor, key: `sha256:${string}`, expectedEntryId?: string): Promise<boolean> { authorize(actor, 'invalidate'); if (expectedEntryId) { const current = await this.load(actor, key, 'invalidate'); if (!current || current.entryId !== expectedEntryId) return false; } return this.remove(actor, key); }
  async delete(actor: ResultCacheActor, key: `sha256:${string}`): Promise<boolean> {
    authorize(actor, 'delete');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const marker = `${this.path(actor, key)}.deleted`;
    try {
      const handle = await open(marker, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ schemaVersion: 'decision-result-cache-tombstone/v1',
        deletedAtEpochMs: Date.now(), legalHold: this.options.legalHold === true })); await handle.sync(); }
      finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return this.remove(actor, key);
  }
  async export(actor: ResultCacheActor, key: `sha256:${string}`): Promise<ResultCacheEntry | null> { authorize(actor, 'export'); return this.load(actor, key, 'export'); }
  private async load(actor: ResultCacheActor, key: `sha256:${string}`, permission: ResultCacheActor['permissions'][number]): Promise<ResultCacheEntry | null> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await this.deleted(actor, key)) return null;
    try { const entry = JSON.parse(await readFile(this.path(actor, key), 'utf8')) as ResultCacheEntry; authorize(actor, permission, entry.scope); assertResultCacheEntry(entry); if (entry.keyDigest !== key) throw new Error('Cache key substitution'); return entry; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async deleted(actor: ResultCacheActor, key: `sha256:${string}`): Promise<boolean> {
    try { await stat(`${this.path(actor, key)}.deleted`); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private async remove(actor: ResultCacheActor, key: `sha256:${string}`): Promise<boolean> { try { await unlink(this.path(actor, key)); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
  private path(actor: ResultCacheActor, key: string): string { return join(this.directory, `${createHash('sha256').update(mapKey(actor, key)).digest('hex')}.json`); }
}
