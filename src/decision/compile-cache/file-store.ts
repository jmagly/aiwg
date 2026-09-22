import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
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

/** Durable, atomic filesystem cache. Files are named only by one-way key digests. */
export class FileCompileCache<T> {
  private readonly fills = new Map<Sha256, Promise<CompileCacheEntry<T>>>();

  constructor(private readonly directory: string) {}

  async getOrCompile(identity: CompileCacheIdentity, context: CompileCacheReadContext, ttlMs: number,
    compile: () => Promise<T>, options: { bypass?: boolean } = {}): Promise<CompileCacheResult<T>> {
    validateCompileIdentity(identity);
    const key = compileCacheKey(identity);
    if (options.bypass) return { outcome: 'bypass', key, entry: await this.build(identity, key, context, ttlMs, compile) };
    const existing = await this.read(identity, context);
    if (existing) return { outcome: 'hit', key, entry: existing };
    const active = this.fills.get(key);
    if (active) return { outcome: 'hit', key, entry: this.revalidate(await active, identity, context) };
    const fill = this.buildAndPublish(identity, key, context, ttlMs, compile);
    this.fills.set(key, fill);
    try { return { outcome: 'miss', key, entry: structuredClone(await fill) }; }
    finally { this.fills.delete(key); }
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

  private async buildAndPublish(identity: CompileCacheIdentity, key: Sha256, context: CompileCacheReadContext,
    ttlMs: number, compile: () => Promise<T>): Promise<CompileCacheEntry<T>> {
    const entry = await this.build(identity, key, context, ttlMs, compile);
    await this.publish(entry);
    return entry;
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
