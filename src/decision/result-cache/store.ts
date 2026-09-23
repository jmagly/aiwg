import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rm, unlink } from 'node:fs/promises';
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
  constructor(private readonly directory: string) {}
  async read(actor: ResultCacheActor, key: `sha256:${string}`): Promise<ResultCacheEntry | null> { authorize(actor, 'read'); return this.load(actor, key, 'read'); }
  async putIfAbsent(actor: ResultCacheActor, entry: ResultCacheEntry): Promise<ResultCacheEntry> {
    authorize(actor, 'write', entry.scope); assertResultCacheEntry(entry); await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(actor, entry.keyDigest); const tmp = join(this.directory, `.cache-${randomUUID()}.tmp`); const handle = await open(tmp, 'wx', 0o600);
    try { await handle.writeFile(`${canonicalJson(entry)}\n`); await handle.sync(); } finally { await handle.close(); }
    try { await link(tmp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } finally { await rm(tmp, { force: true }); }
    const stored = await this.load(actor, entry.keyDigest, 'write'); if (!stored) throw new Error('Cache publication failed'); return stored;
  }
  async invalidate(actor: ResultCacheActor, key: `sha256:${string}`, expectedEntryId?: string): Promise<boolean> { authorize(actor, 'invalidate'); if (expectedEntryId) { const current = await this.load(actor, key, 'invalidate'); if (!current || current.entryId !== expectedEntryId) return false; } return this.remove(actor, key); }
  async delete(actor: ResultCacheActor, key: `sha256:${string}`): Promise<boolean> { authorize(actor, 'delete'); return this.remove(actor, key); }
  async export(actor: ResultCacheActor, key: `sha256:${string}`): Promise<ResultCacheEntry | null> { authorize(actor, 'export'); return this.load(actor, key, 'export'); }
  private async load(actor: ResultCacheActor, key: `sha256:${string}`, permission: ResultCacheActor['permissions'][number]): Promise<ResultCacheEntry | null> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { const entry = JSON.parse(await readFile(this.path(actor, key), 'utf8')) as ResultCacheEntry; authorize(actor, permission, entry.scope); assertResultCacheEntry(entry); if (entry.keyDigest !== key) throw new Error('Cache key substitution'); return entry; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async remove(actor: ResultCacheActor, key: `sha256:${string}`): Promise<boolean> { try { await unlink(this.path(actor, key)); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
  private path(actor: ResultCacheActor, key: string): string { return join(this.directory, `${createHash('sha256').update(mapKey(actor, key)).digest('hex')}.json`); }
}
