import type { DecisionLifecycleHold, DecisionLifecyclePolicy, DecisionLifecycleRule } from '../lifecycle.js';
import { compileCacheKey, validateCompileIdentity } from './identity.js';
import {
  activeCompileCacheHold, buildCompileCacheEntry, compileCacheLifecycleRule, compileCacheScopeAllowed,
  compileCacheTombstoneRecord, CompileCacheRejectedError, mayRestoreCompileCacheEntry, revalidateCompileCacheEntry,
  validateCompileCacheHold,
} from './records.js';
import type {
  CompileCacheEntry, CompileCacheIdentity, CompileCacheLifecycleOptions, CompileCacheReadContext, CompileCacheResult,
  CompileCacheTombstoneRecord, Sha256,
} from './types.js';

export { CompileCacheRejectedError } from './records.js';

type StoredRecord<T> = CompileCacheEntry<T> | CompileCacheTombstoneRecord;
const isTombstone = <T>(record: StoredRecord<T>): record is CompileCacheTombstoneRecord =>
  record.schemaVersion === 'decision-compile-cache-tombstone/v1';

/**
 * In-memory reference store. Entries are immutable and concurrent fills share one promise.
 * Out-of-scope or unauthorized lifecycle calls return the same result as an absent key.
 */
export class MemoryCompileCache<T> {
  private readonly records = new Map<Sha256, StoredRecord<T>>();
  private readonly fills = new Map<Sha256, Promise<CompileCacheEntry<T>>>();
  private readonly policy: DecisionLifecyclePolicy;
  private readonly rule: DecisionLifecycleRule;

  constructor(options: CompileCacheLifecycleOptions) {
    this.rule = compileCacheLifecycleRule(options.lifecyclePolicy);
    this.policy = structuredClone(options.lifecyclePolicy);
  }

  async getOrCompile(identity: CompileCacheIdentity, context: CompileCacheReadContext, ttlMs: number,
    compile: () => Promise<T>, options: { bypass?: boolean } = {}): Promise<CompileCacheResult<T>> {
    validateCompileIdentity(identity);
    const key = compileCacheKey(identity);
    if (!compileCacheScopeAllowed(identity, context)) throw new CompileCacheRejectedError();
    if (options.bypass) return { outcome: 'bypass', key, entry: await buildCompileCacheEntry(identity, key, context, ttlMs, this.rule, compile) };
    const existing = this.records.get(key);
    if (existing) {
      // Authenticate the old entry before allowing an expiry refresh. A
      // tombstone or tamper is never silently converted into a cache miss.
      if (isTombstone(existing)) throw new CompileCacheRejectedError();
      revalidateCompileCacheEntry(existing, identity, context, true);
      if (context.nowEpochMs < existing.expiresAtEpochMs) {
        return { outcome: 'hit', key, entry: revalidateCompileCacheEntry(existing, identity, context) };
      }
    }
    const active = this.fills.get(key);
    if (active) return { outcome: 'hit', key, entry: revalidateCompileCacheEntry(await active, identity, context) };
    const fill = buildCompileCacheEntry(identity, key, context, ttlMs, this.rule, compile);
    this.fills.set(key, fill);
    try {
      const entry = await fill;
      if (this.records.get(key) && isTombstone(this.records.get(key)!)) throw new CompileCacheRejectedError();
      this.records.set(key, entry);
      return { outcome: 'miss', key, entry: structuredClone(entry) };
    } finally { this.fills.delete(key); }
  }

  read(identity: CompileCacheIdentity, context: CompileCacheReadContext): CompileCacheEntry<T> | null {
    const record = this.lookup(identity, context);
    if (!record) return null;
    if (isTombstone(record)) throw new CompileCacheRejectedError();
    return revalidateCompileCacheEntry(record, identity, context);
  }

  /** Erase the body and leave a persistent tombstone; the key never fills or restores again. */
  tombstone(identity: CompileCacheIdentity, context: CompileCacheReadContext): boolean {
    return this.retire(identity, context);
  }

  /** D10 deletion: same body-free tombstone as `tombstone`; false when absent, held or already erased. */
  delete(identity: CompileCacheIdentity, context: CompileCacheReadContext): boolean {
    return this.retire(identity, context);
  }

  /** Place (or with `null`, release) a D10 hold scoped to the `cache` surface. */
  setLegalHold(identity: CompileCacheIdentity, context: CompileCacheReadContext, hold: DecisionLifecycleHold | null): void {
    const record = this.lookup(identity, context);
    if (!record) return;
    if (isTombstone(record)) throw new CompileCacheRejectedError();
    const entry = revalidateCompileCacheEntry(record, identity, context, true);
    this.records.set(entry.key, { ...entry, legalHold: hold === null ? null : validateCompileCacheHold(hold, context.nowEpochMs) });
  }

  /** Export an authorized live entry when the lifecycle rule persists backups. */
  backup(identity: CompileCacheIdentity, context: CompileCacheReadContext): CompileCacheEntry<T> | null {
    if (this.rule.backup === 'not-persisted') throw new CompileCacheRejectedError();
    return this.read(identity, context);
  }

  /** Import a backup only while live, in retention, and never over a tombstone or live entry. */
  restore(entry: CompileCacheEntry<T>, context: CompileCacheReadContext): void {
    const restored = revalidateCompileCacheEntry(entry, entry.identity, context);
    const existing = this.records.get(restored.key);
    if ((existing && !isTombstone(existing)) || !mayRestoreCompileCacheEntry(restored, context.nowEpochMs, this.policy,
      existing ? [existing.tombstone] : [])) throw new CompileCacheRejectedError();
    this.records.set(restored.key, restored);
  }

  private lookup(identity: CompileCacheIdentity, context: CompileCacheReadContext): StoredRecord<T> | null {
    if (!compileCacheScopeAllowed(identity, context)) return null;
    return this.records.get(compileCacheKey(identity)) ?? null;
  }

  private retire(identity: CompileCacheIdentity, context: CompileCacheReadContext): boolean {
    const record = this.lookup(identity, context);
    if (!record || isTombstone(record)) return false;
    const entry = revalidateCompileCacheEntry(record, identity, context, true);
    if (activeCompileCacheHold(entry, context.nowEpochMs)) return false;
    this.records.set(entry.key, compileCacheTombstoneRecord(entry.key, context.nowEpochMs));
    return true;
  }
}
