import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../security/artifact-trust.js';
import { mayRestoreDecisionReference, type DecisionLifecycleReference, type DecisionLifecycleRule,
  type DecisionLifecycleTombstone } from '../lifecycle.js';
import { BatchRecordUnavailableError, BatchStoreIntegrityError, BatchStoreMigrationRequiredError, ensurePrivateDirectory,
  exists, expired, keyedName, macFor, macMatches, parseCanonical, publishExclusive, receiptLifecycleRule, requireIntegrityKey,
  serialized, syncDirectory, writeTombstone, type BatchStoreLifecycleBinding, type BatchStoreRestoreReport } from './protection.js';
import type { FileBatchResultStore } from './result-store.js';
import type { DecisionBatchReceipt, BatchReceiptAcquireResult, BatchReceiptStore } from './types.js';
import { BatchReceiptValidationError, validateBatchReceipt, validateBatchReceiptTransition } from './validate.js';

export class BatchReceiptConflictError extends Error {}

export class MemoryBatchReceiptStore implements BatchReceiptStore {
  private readonly records = new Map<string, DecisionBatchReceipt>();
  async acquire(initial: DecisionBatchReceipt): Promise<BatchReceiptAcquireResult> {
    validateBatchReceipt(initial);
    if (initial.revision !== 1 || initial.status !== 'acquired') throw new BatchReceiptValidationError('Initial receipt must be acquired revision 1');
    const key = scopeKey(initial.batchId, initial.tenantId, initial.projectId);
    const existing = this.records.get(key);
    if (existing) { assertSameIdentity(initial, existing); return { owner: false, receipt: structuredClone(existing) }; }
    this.records.set(key, structuredClone(initial)); return { owner: true, receipt: structuredClone(initial) };
  }
  async read(batchId: string, tenantId: string, projectId: string): Promise<DecisionBatchReceipt | null> {
    return structuredClone(this.records.get(scopeKey(batchId, tenantId, projectId)) ?? null);
  }
  async compareAndSwap(previous: DecisionBatchReceipt, next: DecisionBatchReceipt): Promise<boolean> {
    validateBatchReceiptTransition(previous, next);
    const key = scopeKey(previous.batchId, previous.tenantId, previous.projectId);
    const current = this.records.get(key);
    if (!current || canonicalJson(current) !== canonicalJson(previous)) return false;
    this.records.set(key, structuredClone(next)); return true;
  }
}

export interface FileBatchReceiptStoreOptions extends BatchStoreLifecycleBinding {
  /** HMAC-SHA256 key of at least 32 bytes. Every revision is verified against it on every read. */
  integrityKey: Uint8Array;
  /** Cascade target: erasing a batch receipt erases its result snapshots. Required for erase and sweep. */
  results?: FileBatchResultStore;
  /** Independent D10 tombstone authority, consulted on read, acquisition and restore. Errors fail closed. */
  isTombstoned?: (reference: DecisionLifecycleReference) => Promise<boolean>;
}

const ENVELOPE = 'decision-batch-receipt-envelope/v1' as const;
const MAC_DOMAIN = 'decision-batch-receipt/v1';
const REFERENCE = /^batch-receipt-([a-f0-9]{64})$/;
const SEALED = /^([a-f0-9]{64})\.r([0-9]+)\.sealed\.json$/;
const LEGACY = /^([a-f0-9]{64})\.r([0-9]+)\.json$/;
interface ReceiptEnvelope { version: typeof ENVELOPE; receipt: DecisionBatchReceipt; mac: string }

/**
 * Every revision is immutable and sealed with a keyed MAC; hard-link publication supplies
 * filesystem CAS. File names are keyed, so a directory listing does not reveal scope.
 */
export class FileBatchReceiptStore implements BatchReceiptStore {
  private readonly key: Buffer;
  private readonly rule: DecisionLifecycleRule;
  private readonly clock: () => number;

  constructor(private readonly directory: string, private readonly options: FileBatchReceiptStoreOptions) {
    this.key = requireIntegrityKey(options?.integrityKey, 'Batch receipt');
    this.rule = receiptLifecycleRule(options);
    this.clock = options.clock ?? Date.now;
  }

  /** Opaque D10 reference for host link registration. It never contains scope identifiers. */
  lifecycleReference(batchId: string, tenantId: string, projectId: string): DecisionLifecycleReference {
    return { surface: 'receipt', opaqueId: `batch-receipt-${this.prefix(batchId, tenantId, projectId)}` };
  }

  async acquire(initial: DecisionBatchReceipt): Promise<BatchReceiptAcquireResult> {
    validateBatchReceipt(initial);
    if (initial.revision !== 1 || initial.status !== 'acquired') throw new BatchReceiptValidationError('Initial receipt must be acquired revision 1');
    await this.ensurePrivateDirectory();
    const prefix = this.prefix(initial.batchId, initial.tenantId, initial.projectId);
    // An erased batch must never be re-owned: that would re-dispatch a deleted request.
    if (await this.tombstoned(prefix)) throw new BatchRecordUnavailableError();
    await this.assertNoLegacy(initial.batchId, initial.tenantId, initial.projectId);
    if (await this.publish(initial)) {
      if (await this.tombstoned(prefix)) { await this.removeRevisions(prefix); throw new BatchRecordUnavailableError(); }
      return { owner: true, receipt: structuredClone(initial) };
    }
    const existing = await this.read(initial.batchId, initial.tenantId, initial.projectId);
    if (!existing) throw new BatchRecordUnavailableError();
    assertSameIdentity(initial, existing); return { owner: false, receipt: existing };
  }

  /** Erased, expired and missing receipts all return null. */
  async read(batchId: string, tenantId: string, projectId: string): Promise<DecisionBatchReceipt | null> {
    await this.ensurePrivateDirectory();
    const prefix = this.prefix(batchId, tenantId, projectId);
    if (await this.tombstoned(prefix)) return null;
    const revisions = revisionsIn(await readdir(this.directory), prefix, SEALED);
    if (!revisions.length) { await this.assertNoLegacy(batchId, tenantId, projectId); return null; }
    const chain = await this.chain(this.directory, prefix, revisions);
    if (expired(chain[0]!.createdAtEpochMs, this.clock(), this.rule)) return null;
    return structuredClone(chain.at(-1)!);
  }

  async compareAndSwap(previous: DecisionBatchReceipt, next: DecisionBatchReceipt): Promise<boolean> {
    validateBatchReceiptTransition(previous, next);
    const current = await this.read(previous.batchId, previous.tenantId, previous.projectId);
    if (!current || canonicalJson(current) !== canonicalJson(previous)) return false;
    const prefix = this.prefix(next.batchId, next.tenantId, next.projectId);
    const published = await this.publish(next);
    if (published && await this.tombstoned(prefix)) { await this.removeRevisions(prefix); return false; }
    return published;
  }

  /**
   * D10 content eraser for the `receipt` surface. Call it through `eraseDecisionSubject`, which
   * enforces legal holds and records the journal tombstone first. Publishes a body-free local
   * tombstone, cascades to the bound result store, then removes every revision body.
   */
  async erase(opaqueId: string): Promise<void> {
    const match = REFERENCE.exec(opaqueId);
    if (!match) throw new Error('Batch receipt lifecycle reference invalid');
    if (!this.options.results) throw new Error('Batch receipt erase requires a bound result store');
    await this.ensurePrivateDirectory();
    const prefix = match[1]!;
    await writeTombstone(this.directory, this.tombstonePath(prefix), { surface: 'receipt', opaqueId }, this.clock());
    const revisions = revisionsIn(await readdir(this.directory), prefix, SEALED);
    let identity: DecisionBatchReceipt | null = null;
    for (const revision of revisions) {
      try { identity = await this.revision(this.directory, prefix, revision); break; } catch { /* try the next sealed revision */ }
    }
    if (identity) await this.options.results.eraseBatch(identity.batchId, identity.tenantId, identity.projectId);
    await this.removeRevisions(prefix);
    // The bodies are gone, but an unverifiable receipt left its result cascade unresolved.
    if (revisions.length && !identity) throw new BatchStoreIntegrityError();
  }

  /** Erase receipts whose retention elapsed, skipping any the host reports as held. Returns the count erased. */
  async sweepExpired(isHeld: (reference: DecisionLifecycleReference) => Promise<boolean>): Promise<number> {
    if (typeof isHeld !== 'function') throw new Error('Batch receipt sweep requires a hold authority');
    await this.ensurePrivateDirectory();
    let erased = 0;
    for (const prefix of prefixesIn(await readdir(this.directory))) {
      if (await this.tombstoned(prefix)) continue;
      let first: DecisionBatchReceipt;
      try { first = await this.revision(this.directory, prefix, 1); } catch { continue; }
      if (!expired(first.createdAtEpochMs, this.clock(), this.rule)) continue;
      const reference: DecisionLifecycleReference = { surface: 'receipt', opaqueId: `batch-receipt-${prefix}` };
      let held = true;
      try { held = await isHeld(reference) !== false; } catch { /* an unavailable hold authority keeps the record */ }
      if (held) continue;
      await this.erase(reference.opaqueId); erased++;
    }
    return erased;
  }

  /**
   * Restore sealed revisions from a backup copy of this store. A batch is refused when it is
   * tombstoned locally or by the host, is past retention, or fails verification.
   */
  async restoreFrom(backupDirectory: string, tombstones: ReadonlyArray<DecisionLifecycleTombstone> = []): Promise<BatchStoreRestoreReport> {
    if (this.rule.backup === 'not-persisted') throw new Error('Batch receipt backup restore denied by lifecycle policy');
    await this.ensurePrivateDirectory();
    const names = await readdir(backupDirectory);
    const report: BatchStoreRestoreReport = { restored: 0, refused: 0 };
    for (const prefix of prefixesIn(names)) {
      const reference: DecisionLifecycleReference = { surface: 'receipt', opaqueId: `batch-receipt-${prefix}` };
      try {
        const revisions = revisionsIn(names, prefix, SEALED);
        const chain = await this.chain(backupDirectory, prefix, revisions);
        if (await this.tombstoned(prefix)
          || !mayRestoreDecisionReference(reference, chain[0]!.createdAtEpochMs, this.clock(), this.options.lifecycle, tombstones)) {
          report.refused++; continue;
        }
        for (const revision of revisions) {
          const name = sealedName(prefix, revision);
          const contents = await readFile(join(backupDirectory, name), 'utf8');
          if (!await publishExclusive(this.directory, join(this.directory, name), contents, 'batch-receipt')
            && await readFile(join(this.directory, name), 'utf8') !== contents) throw new BatchStoreIntegrityError();
        }
        report.restored++;
      } catch { report.refused++; }
    }
    return report;
  }

  /**
   * Explicit, authorized upgrade of unkeyed revisions written before integrity protection.
   * Every legacy chain is validated before authorization; nothing is written unless it is granted.
   */
  async migrateLegacy(authorize: (summary: { receipts: number; revisions: number }) => Promise<boolean>): Promise<{ migrated: number }> {
    await this.ensurePrivateDirectory();
    const names = await readdir(this.directory);
    const chains: DecisionBatchReceipt[][] = [];
    for (const legacyPrefix of new Set(names.flatMap(name => LEGACY.exec(name)?.[1] ?? []))) {
      const chain: DecisionBatchReceipt[] = [];
      for (const [index, revision] of revisionsIn(names, legacyPrefix, LEGACY).entries()) {
        const path = join(this.directory, `${legacyPrefix}.r${revision}.json`);
        await assertPrivateFile(path, 'Insecure batch receipt file');
        let receipt: DecisionBatchReceipt;
        try { receipt = JSON.parse(await readFile(path, 'utf8')) as DecisionBatchReceipt; validateBatchReceipt(receipt); }
        catch { throw new BatchStoreIntegrityError(); }
        if (revision !== index + 1 || receipt.revision !== revision
          || filePrefix(receipt.batchId, receipt.tenantId, receipt.projectId) !== legacyPrefix) throw new BatchStoreIntegrityError();
        if (chain.length) validateBatchReceiptTransition(chain.at(-1)!, receipt);
        chain.push(receipt);
      }
      chains.push(chain);
    }
    if (!chains.length) return { migrated: 0 };
    let approved = false;
    try { approved = await authorize({ receipts: chains.length, revisions: chains.reduce((sum, chain) => sum + chain.length, 0) }) === true; }
    catch { /* authorization fails closed */ }
    if (!approved) throw new Error('Batch store migration denied');
    for (const chain of chains) {
      const first = chain[0]!;
      const prefix = this.prefix(first.batchId, first.tenantId, first.projectId);
      if (await this.tombstoned(prefix)) throw new BatchRecordUnavailableError();
      for (const receipt of chain) {
        if (!await this.publish(receipt)
          && canonicalJson(await this.revision(this.directory, prefix, receipt.revision)) !== canonicalJson(receipt)) {
          throw new BatchReceiptConflictError('Legacy batch receipt conflicts with a sealed revision');
        }
      }
      const legacyPrefix = filePrefix(first.batchId, first.tenantId, first.projectId);
      for (const receipt of chain) await rm(join(this.directory, `${legacyPrefix}.r${receipt.revision}.json`));
    }
    await syncDirectory(this.directory);
    return { migrated: chains.length };
  }

  private prefix(batchId: string, tenantId: string, projectId: string): string {
    return keyedName(this.key, 'decision-batch-receipt-name/v1', [tenantId, projectId, batchId]);
  }

  private tombstonePath(prefix: string): string { return join(this.directory, `${prefix}.tombstone`); }

  private async tombstoned(prefix: string): Promise<boolean> {
    if (await exists(this.tombstonePath(prefix))) return true;
    if (!this.options.isTombstoned) return false;
    try { return await this.options.isTombstoned({ surface: 'receipt', opaqueId: `batch-receipt-${prefix}` }) !== false; }
    catch { return true; }
  }

  private async assertNoLegacy(batchId: string, tenantId: string, projectId: string): Promise<void> {
    if (revisionsIn(await readdir(this.directory), filePrefix(batchId, tenantId, projectId), LEGACY).length) {
      throw new BatchStoreMigrationRequiredError();
    }
  }

  private async chain(directory: string, prefix: string, revisions: number[]): Promise<DecisionBatchReceipt[]> {
    revisions.forEach((revision, index) => { if (revision !== index + 1) throw new BatchReceiptValidationError('Batch receipt revision gap'); });
    const chain: DecisionBatchReceipt[] = [];
    for (const revision of revisions) {
      const receipt = await this.revision(directory, prefix, revision);
      if (chain.length) validateBatchReceiptTransition(chain.at(-1)!, receipt);
      chain.push(receipt);
    }
    return chain;
  }

  private async revision(directory: string, prefix: string, revision: number): Promise<DecisionBatchReceipt> {
    const path = join(directory, sealedName(prefix, revision));
    if (directory === this.directory) await assertPrivateFile(path, 'Insecure batch receipt file');
    try {
      const envelope = parseCanonical(await readFile(path, 'utf8')) as ReceiptEnvelope;
      if (!envelope || envelope.version !== ENVELOPE || Object.keys(envelope).length !== 3
        || !macMatches(this.key, MAC_DOMAIN, envelope.receipt, envelope.mac)) throw new BatchStoreIntegrityError();
      validateBatchReceipt(envelope.receipt);
      if (envelope.receipt.revision !== revision
        || this.prefix(envelope.receipt.batchId, envelope.receipt.tenantId, envelope.receipt.projectId) !== prefix) {
        throw new BatchStoreIntegrityError();
      }
      return envelope.receipt;
    } catch { throw new BatchStoreIntegrityError(); }
  }

  private async removeRevisions(prefix: string): Promise<void> {
    for (const revision of revisionsIn(await readdir(this.directory), prefix, SEALED)) {
      await rm(join(this.directory, sealedName(prefix, revision)), { force: true });
    }
    await syncDirectory(this.directory);
  }

  private async ensurePrivateDirectory(): Promise<void> {
    await ensurePrivateDirectory(this.directory, 'Insecure batch receipt directory');
  }

  private async publish(receipt: DecisionBatchReceipt): Promise<boolean> {
    const prefix = this.prefix(receipt.batchId, receipt.tenantId, receipt.projectId);
    const envelope: ReceiptEnvelope = { version: ENVELOPE, receipt, mac: macFor(this.key, MAC_DOMAIN, receipt) };
    return publishExclusive(this.directory, join(this.directory, sealedName(prefix, receipt.revision)), serialized(envelope), 'batch-receipt');
  }
}

function sealedName(prefix: string, revision: number): string { return `${prefix}.r${revision}.sealed.json`; }
function prefixesIn(names: string[]): Set<string> { return new Set(names.flatMap(name => SEALED.exec(name)?.[1] ?? [])); }
function revisionsIn(names: string[], prefix: string, pattern: RegExp): number[] {
  return names.flatMap(name => { const match = pattern.exec(name); return match && match[1] === prefix ? [Number(match[2])] : []; })
    .sort((a, b) => a - b);
}
async function assertPrivateFile(path: string, message: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new BatchReceiptValidationError(message);
}

function scopeKey(batchId: string, tenantId: string, projectId: string): string { return `${tenantId}\u0000${projectId}\u0000${batchId}`; }
/** Unkeyed name used by stores written before integrity protection; only migration reads it. */
function filePrefix(batchId: string, tenantId: string, projectId: string): string {
  return createHash('sha256').update(scopeKey(batchId, tenantId, projectId)).digest('hex');
}
function assertSameIdentity(requested: DecisionBatchReceipt, existing: DecisionBatchReceipt): void {
  const identity = (receipt: DecisionBatchReceipt) => ({ tenantId: receipt.tenantId, projectId: receipt.projectId,
    batchId: receipt.batchId, invocationId: receipt.invocationId, runId: receipt.runId, plan: receipt.plan,
    subjectHash: receipt.subjectHash, stateHash: receipt.stateHash, executionEnvelope: receipt.executionEnvelope,
    questionIds: receipt.questionIds });
  if (canonicalJson(identity(requested)) !== canonicalJson(identity(existing))) {
    throw new BatchReceiptConflictError('Batch ID already belongs to another immutable receipt identity');
  }
}
