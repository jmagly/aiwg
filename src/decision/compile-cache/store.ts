import { canonicalJson } from '../../security/artifact-trust.js';
import { compileCacheKey, sha256, validateCompileIdentity } from './identity.js';
import type { CompileCacheEntry, CompileCacheIdentity, CompileCacheReadContext, CompileCacheResult, Sha256 } from './types.js';

export class CompileCacheRejectedError extends Error {
  constructor() { super('compile cache entry unavailable'); this.name = 'CompileCacheRejectedError'; }
}

/** In-memory reference store. Entries are immutable and concurrent fills share one promise. */
export class MemoryCompileCache<T> {
  private readonly entries = new Map<Sha256, CompileCacheEntry<T>>();
  private readonly fills = new Map<Sha256, Promise<CompileCacheEntry<T>>>();

  async getOrCompile(identity: CompileCacheIdentity, context: CompileCacheReadContext, ttlMs: number,
    compile: () => Promise<T>, options: { bypass?: boolean } = {}): Promise<CompileCacheResult<T>> {
    validateCompileIdentity(identity);
    const key = compileCacheKey(identity);
    if (options.bypass) return { outcome: 'bypass', key, entry: await this.build(identity, key, context, ttlMs, compile) };
    const existing = this.entries.get(key);
    if (existing) {
      // Authenticate the old entry before allowing an expiry refresh. A
      // tombstone or tamper is never silently converted into a cache miss.
      this.revalidate(existing, identity, context, true);
      if (existing.tombstonedAtEpochMs !== null) throw new CompileCacheRejectedError();
      if (context.nowEpochMs < existing.expiresAtEpochMs) {
        return { outcome: 'hit', key, entry: this.revalidate(existing, identity, context) };
      }
    }
    const active = this.fills.get(key);
    if (active) return { outcome: 'hit', key, entry: this.revalidate(await active, identity, context) };
    const fill = this.build(identity, key, context, ttlMs, compile);
    this.fills.set(key, fill);
    try {
      const entry = await fill;
      this.entries.set(key, entry);
      return { outcome: 'miss', key, entry: structuredClone(entry) };
    } finally { this.fills.delete(key); }
  }

  read(identity: CompileCacheIdentity, context: CompileCacheReadContext): CompileCacheEntry<T> | null {
    const entry = this.entries.get(compileCacheKey(identity));
    return entry ? this.revalidate(entry, identity, context) : null;
  }

  tombstone(identity: CompileCacheIdentity, context: CompileCacheReadContext): void {
    const key = compileCacheKey(identity); const entry = this.entries.get(key);
    if (!entry) return;
    this.revalidate(entry, identity, context);
    this.entries.set(key, { ...entry, tombstonedAtEpochMs: context.nowEpochMs });
  }

  delete(identity: CompileCacheIdentity, context: CompileCacheReadContext): boolean {
    const key = compileCacheKey(identity); const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.identity.tenantId !== context.tenantId || entry.identity.projectId !== context.projectId || !context.authorize(entry.identity)) {
      throw new CompileCacheRejectedError();
    }
    if (entry.legalHold) return false;
    return this.entries.delete(key);
  }

  setLegalHold(identity: CompileCacheIdentity, context: CompileCacheReadContext, legalHold: boolean): void {
    const key = compileCacheKey(identity); const entry = this.entries.get(key);
    if (!entry) return;
    this.revalidate(entry, identity, context);
    this.entries.set(key, { ...entry, legalHold });
  }

  /** Test/restore hook: integrity remains checked on every subsequent read. */
  restore(entry: CompileCacheEntry<T>): void { this.entries.set(entry.key, structuredClone(entry)); }

  private async build(identity: CompileCacheIdentity, key: Sha256, context: CompileCacheReadContext, ttlMs: number,
    compile: () => Promise<T>): Promise<CompileCacheEntry<T>> {
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
      && context.authorize(entry.identity) && (allowInactive || (entry.tombstonedAtEpochMs === null && context.nowEpochMs < entry.expiresAtEpochMs));
    if (!valid) throw new CompileCacheRejectedError();
    return structuredClone(entry);
  }
}
