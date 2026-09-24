import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../security/artifact-trust.js';
import type { DecisionLifecycleRule } from '../lifecycle.js';
import type { AdapterObservation } from '../types.js';
import { BatchRecordUnavailableError, BatchStoreIntegrityError, BatchStoreMigrationRequiredError, ensurePrivateDirectory,
  exists, expired, keyedName, macFor, macMatches, parseCanonical, publishExclusive, receiptLifecycleRule, requireIntegrityKey,
  serialized, syncDirectory, writeTombstone, type BatchStoreLifecycleBinding, type BatchStoreRestoreReport } from './protection.js';
import type { DecisionBatchReceipt } from './types.js';
import { BatchReceiptValidationError } from './validate.js';

export interface BatchResultSnapshot {
  schemaVersion: 'decision-batch-result/v1';
  tenantId: string;
  projectId: string;
  batchId: string;
  receiptRevision: number;
  questionId: string;
  answerId: string;
  resultId: string;
  observation: AdapterObservation;
  createdAtEpochMs: number;
}

export interface BatchResultStore {
  writeMany(receipt: DecisionBatchReceipt, observations: ReadonlyMap<string, AdapterObservation>): Promise<void>;
  readMany(receipt: DecisionBatchReceipt): Promise<Map<string, AdapterObservation>>;
}

export class MemoryBatchResultStore implements BatchResultStore {
  private readonly records = new Map<string, BatchResultSnapshot>();

  async writeMany(receipt: DecisionBatchReceipt, observations: ReadonlyMap<string, AdapterObservation>): Promise<void> {
    const snapshots = snapshotsFor(receipt, observations);
    for (const snapshot of snapshots) {
      const existing = this.records.get(snapshotKey(snapshot));
      if (existing && canonicalJson(existing) !== canonicalJson(snapshot)) {
        throw new BatchReceiptValidationError('Conflicting batch result publication');
      }
    }
    for (const snapshot of snapshots) this.records.set(snapshotKey(snapshot), structuredClone(snapshot));
  }

  async readMany(receipt: DecisionBatchReceipt): Promise<Map<string, AdapterObservation>> {
    const found = new Map<string, AdapterObservation>();
    for (const reference of receipt.answerReferences) {
      const snapshot = this.records.get(snapshotKey({ ...scope(receipt), questionId: reference.questionId, answerId: reference.answerId }));
      if (!snapshot) return new Map();
      validateSnapshotForReceipt(snapshot, receipt);
      found.set(reference.questionId, structuredClone(snapshot.observation));
    }
    return found;
  }
}

export interface FileBatchResultStoreOptions extends BatchStoreLifecycleBinding {
  /** HMAC-SHA256 key of at least 32 bytes sealing every snapshot envelope. */
  integrityKey: Uint8Array;
  /** Logical name of the AES-256 key new snapshots are encrypted with. Never key material. */
  encryptionKeyReference: string;
  /** Host key resolver. It must return exactly 32 bytes; the store zeroes its copy after each use. */
  resolveEncryptionKey: (reference: string) => Promise<Uint8Array>;
}

const ENVELOPE = 'decision-batch-result-envelope/v1' as const;
const MAC_DOMAIN = 'decision-batch-result/v1';
const SEALED = /^([a-f0-9]{64})\.([a-f0-9]{64})\.sealed\.json$/;
const LEGACY = /^([a-f0-9]{64})\.json$/;
interface ResultEnvelope {
  version: typeof ENVELOPE;
  keyReference: string;
  createdAtEpochMs: number;
  nonce: string; tag: string; ciphertext: string;
  mac: string;
}
type SnapshotScope = Pick<BatchResultSnapshot, 'tenantId' | 'projectId' | 'batchId' | 'receiptRevision' | 'questionId' | 'answerId'>;

/**
 * Snapshot values are encrypted with AES-256-GCM. The AAD binds tenant, project, batch, question,
 * answer and receipt revision, so a snapshot moved to any other scope fails authentication.
 */
export class FileBatchResultStore implements BatchResultStore {
  private readonly key: Buffer;
  private readonly rule: DecisionLifecycleRule;
  private readonly clock: () => number;

  constructor(private readonly directory: string, private readonly options: FileBatchResultStoreOptions) {
    this.key = requireIntegrityKey(options?.integrityKey, 'Batch result');
    if (typeof options.resolveEncryptionKey !== 'function' || typeof options.encryptionKeyReference !== 'string'
      || !options.encryptionKeyReference) throw new Error('Batch result encryption key resolver required');
    this.rule = receiptLifecycleRule(options);
    this.clock = options.clock ?? Date.now;
  }

  async writeMany(receipt: DecisionBatchReceipt, observations: ReadonlyMap<string, AdapterObservation>): Promise<void> {
    await this.ensurePrivateDirectory();
    const snapshots = snapshotsFor(receipt, observations);
    if (await exists(this.tombstonePath(this.batchPrefix(receipt)))) throw new BatchRecordUnavailableError();
    for (const snapshot of snapshots) {
      if (await exists(join(this.directory, `${legacyName(snapshot)}.json`))) throw new BatchStoreMigrationRequiredError();
    }
    for (const snapshot of snapshots) await this.publish(snapshot);
  }

  /** Erased, expired and missing snapshots all return an empty map. A verification failure throws. */
  async readMany(receipt: DecisionBatchReceipt): Promise<Map<string, AdapterObservation>> {
    await this.ensurePrivateDirectory();
    if (await exists(this.tombstonePath(this.batchPrefix(receipt)))) return new Map();
    // Values expire with their primary receipt as well as on their own creation time.
    if (expired(receipt.createdAtEpochMs, this.clock(), this.rule)) return new Map();
    const found = new Map<string, AdapterObservation>();
    for (const reference of receipt.answerReferences) {
      const identity: SnapshotScope = { ...scope(receipt), receiptRevision: receipt.revision,
        questionId: reference.questionId, answerId: reference.answerId };
      const envelope = await this.envelope(this.directory, this.sealedName(identity));
      if (!envelope) {
        if (await exists(join(this.directory, `${legacyName(identity)}.json`))) throw new BatchStoreMigrationRequiredError();
        return new Map();
      }
      if (expired(envelope.createdAtEpochMs, this.clock(), this.rule)) return new Map();
      const snapshot = await this.decrypt(envelope, identity);
      validateSnapshotForReceipt(snapshot, receipt);
      found.set(reference.questionId, structuredClone(snapshot.observation));
    }
    return found;
  }

  /** Cascade target of batch receipt erasure: a body-free tombstone, then every snapshot body is removed. */
  async eraseBatch(batchId: string, tenantId: string, projectId: string): Promise<void> {
    await this.ensurePrivateDirectory();
    const prefix = this.batchPrefix({ batchId, tenantId, projectId });
    await writeTombstone(this.directory, this.tombstonePath(prefix), { surface: 'receipt', opaqueId: `batch-result-${prefix}` }, this.clock());
    for (const name of await readdir(this.directory)) {
      if (SEALED.exec(name)?.[1] === prefix) await rm(join(this.directory, name), { force: true });
    }
    await syncDirectory(this.directory);
  }

  /** Restore sealed snapshots from a backup copy, refusing erased batches, expired values and unverifiable files. */
  async restoreFrom(backupDirectory: string): Promise<BatchStoreRestoreReport> {
    if (this.rule.backup === 'not-persisted') throw new Error('Batch result backup restore denied by lifecycle policy');
    await this.ensurePrivateDirectory();
    const report: BatchStoreRestoreReport = { restored: 0, refused: 0 };
    for (const name of await readdir(backupDirectory)) {
      const match = SEALED.exec(name);
      if (!match) continue;
      try {
        const envelope = await this.envelope(backupDirectory, name);
        if (!envelope || await exists(this.tombstonePath(match[1]!))
          || expired(envelope.createdAtEpochMs, this.clock(), this.rule)) { report.refused++; continue; }
        const contents = serialized(envelope);
        if (!await publishExclusive(this.directory, join(this.directory, name), contents, 'batch-result')
          && await readFile(join(this.directory, name), 'utf8') !== contents) throw new BatchStoreIntegrityError();
        report.restored++;
      } catch { report.refused++; }
    }
    return report;
  }

  /**
   * Explicit, authorized upgrade of plaintext snapshots written before encryption. Every legacy
   * file is validated before authorization; each is sealed and encrypted, then the plaintext is removed.
   */
  async migrateLegacy(authorize: (summary: { results: number }) => Promise<boolean>): Promise<{ migrated: number }> {
    await this.ensurePrivateDirectory();
    const legacy: Array<{ name: string; snapshot: BatchResultSnapshot }> = [];
    for (const name of await readdir(this.directory)) {
      const match = LEGACY.exec(name);
      if (!match) continue;
      const path = join(this.directory, name);
      await assertPrivateFile(path);
      let snapshot: BatchResultSnapshot;
      try { snapshot = JSON.parse(await readFile(path, 'utf8')) as BatchResultSnapshot; validateSnapshotShape(snapshot); }
      catch { throw new BatchStoreIntegrityError(); }
      if (legacyName(snapshot) !== match[1]) throw new BatchStoreIntegrityError();
      legacy.push({ name, snapshot });
    }
    if (!legacy.length) return { migrated: 0 };
    let approved = false;
    try { approved = await authorize({ results: legacy.length }) === true; } catch { /* authorization fails closed */ }
    if (!approved) throw new Error('Batch store migration denied');
    for (const { name, snapshot } of legacy) {
      if (await exists(this.tombstonePath(this.batchPrefix(snapshot)))) throw new BatchRecordUnavailableError();
      await this.publish(snapshot);
      await rm(join(this.directory, name));
    }
    await syncDirectory(this.directory);
    return { migrated: legacy.length };
  }

  private batchPrefix(input: Pick<BatchResultSnapshot, 'tenantId' | 'projectId' | 'batchId'>): string {
    return keyedName(this.key, 'decision-batch-result-batch/v1', [input.tenantId, input.projectId, input.batchId]);
  }

  private sealedName(input: SnapshotScope): string {
    return `${this.batchPrefix(input)}.${keyedName(this.key, 'decision-batch-result-answer/v1', [input.questionId, input.answerId])}.sealed.json`;
  }

  private tombstonePath(prefix: string): string { return join(this.directory, `${prefix}.tombstone`); }

  private async ensurePrivateDirectory(): Promise<void> {
    await ensurePrivateDirectory(this.directory, 'Insecure batch result directory');
  }

  private async resolveKey(reference: string): Promise<Buffer> {
    let resolved: Uint8Array;
    try { resolved = await this.options.resolveEncryptionKey(reference); }
    catch { throw new Error('Batch result encryption key unavailable'); }
    if (!(resolved instanceof Uint8Array) || resolved.length !== 32) throw new Error('Batch result encryption key invalid');
    return Buffer.from(resolved);
  }

  private async publish(snapshot: BatchResultSnapshot): Promise<void> {
    const keyReference = this.options.encryptionKeyReference;
    const nonce = randomBytes(12);
    const key = await this.resolveKey(keyReference);
    let ciphertext: Buffer; let tag: Buffer;
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad(snapshot, keyReference, snapshot.createdAtEpochMs));
      ciphertext = Buffer.concat([cipher.update(canonicalJson(snapshot), 'utf8'), cipher.final()]);
      tag = cipher.getAuthTag();
    } finally { key.fill(0); }
    const fields = { version: ENVELOPE, keyReference, createdAtEpochMs: snapshot.createdAtEpochMs,
      nonce: nonce.toString('base64url'), tag: tag.toString('base64url'), ciphertext: ciphertext.toString('base64url') };
    const envelope: ResultEnvelope = { ...fields, mac: macFor(this.key, MAC_DOMAIN, fields) };
    const name = this.sealedName(snapshot);
    if (await publishExclusive(this.directory, join(this.directory, name), serialized(envelope), 'batch-result')) return;
    const existing = await this.envelope(this.directory, name);
    if (!existing || canonicalJson(await this.decrypt(existing, snapshot)) !== canonicalJson(snapshot)) {
      throw new BatchReceiptValidationError('Conflicting batch result publication');
    }
  }

  private async envelope(directory: string, name: string): Promise<ResultEnvelope | null> {
    const path = join(directory, name);
    if (directory === this.directory) {
      try { await assertPrivateFile(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }
    try {
      const envelope = parseCanonical(await readFile(path, 'utf8')) as ResultEnvelope;
      const { mac, ...fields } = envelope ?? {} as ResultEnvelope;
      if (envelope?.version !== ENVELOPE || Object.keys(envelope).length !== 7
        || typeof envelope.keyReference !== 'string' || !envelope.keyReference
        || !Number.isSafeInteger(envelope.createdAtEpochMs) || envelope.createdAtEpochMs < 0
        || ![envelope.nonce, envelope.tag, envelope.ciphertext].every(part => typeof part === 'string' && /^[A-Za-z0-9_-]+$/.test(part))
        || !macMatches(this.key, MAC_DOMAIN, fields, mac)) throw new BatchStoreIntegrityError();
      return envelope;
    } catch { throw new BatchStoreIntegrityError(); }
  }

  private async decrypt(envelope: ResultEnvelope, identity: SnapshotScope): Promise<BatchResultSnapshot> {
    const key = await this.resolveKey(envelope.keyReference);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64url'));
      decipher.setAAD(aad(identity, envelope.keyReference, envelope.createdAtEpochMs));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
      const snapshot = JSON.parse(plain.toString('utf8')) as BatchResultSnapshot;
      validateSnapshotShape(snapshot);
      if (snapshot.createdAtEpochMs !== envelope.createdAtEpochMs) throw new BatchStoreIntegrityError();
      return snapshot;
    } catch { throw new BatchStoreIntegrityError(); }
    finally { key.fill(0); }
  }
}

function aad(identity: SnapshotScope, keyReference: string, createdAtEpochMs: number): Buffer {
  return Buffer.from(canonicalJson({ domain: MAC_DOMAIN, tenantId: identity.tenantId, projectId: identity.projectId,
    batchId: identity.batchId, receiptRevision: identity.receiptRevision, questionId: identity.questionId,
    answerId: identity.answerId, keyReference, createdAtEpochMs }), 'utf8');
}

async function assertPrivateFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new BatchReceiptValidationError('Insecure batch result file');
}

function snapshotsFor(receipt: DecisionBatchReceipt, observations: ReadonlyMap<string, AdapterObservation>): BatchResultSnapshot[] {
  if (receipt.status !== 'completed' || receipt.terminalAtEpochMs === null) {
    throw new BatchReceiptValidationError('Batch results require a completed receipt');
  }
  if (observations.size !== receipt.answerReferences.length) {
    throw new BatchReceiptValidationError('Batch result set does not match receipt references');
  }
  return receipt.answerReferences.map(reference => {
    const observation = observations.get(reference.questionId);
    if (!observation || observation.status !== 'success') {
      throw new BatchReceiptValidationError('Batch result store only accepts successful completed observations');
    }
    const snapshot: BatchResultSnapshot = {
      schemaVersion: 'decision-batch-result/v1', ...scope(receipt), receiptRevision: receipt.revision,
      questionId: reference.questionId, answerId: reference.answerId, resultId: reference.resultId,
      observation: structuredClone(observation), createdAtEpochMs: receipt.terminalAtEpochMs!,
    };
    validateSnapshotForReceipt(snapshot, receipt);
    return snapshot;
  });
}

function validateSnapshotShape(snapshot: BatchResultSnapshot): void {
  if (!snapshot || snapshot.schemaVersion !== 'decision-batch-result/v1'
    || [snapshot.tenantId, snapshot.projectId, snapshot.batchId, snapshot.questionId, snapshot.answerId, snapshot.resultId]
      .some(value => typeof value !== 'string' || !value)
    || !Number.isSafeInteger(snapshot.receiptRevision) || snapshot.receiptRevision < 1
    || !Number.isSafeInteger(snapshot.createdAtEpochMs) || snapshot.createdAtEpochMs < 0
    || !snapshot.observation || snapshot.observation.status !== 'success') {
    throw new BatchReceiptValidationError('Invalid batch result snapshot');
  }
}

function validateSnapshotForReceipt(snapshot: BatchResultSnapshot, receipt: DecisionBatchReceipt): void {
  if (snapshot.schemaVersion !== 'decision-batch-result/v1'
    || snapshot.tenantId !== receipt.tenantId || snapshot.projectId !== receipt.projectId
    || snapshot.batchId !== receipt.batchId || snapshot.receiptRevision !== receipt.revision) {
    throw new BatchReceiptValidationError('Batch result scope substitution');
  }
  const reference = receipt.answerReferences.find(candidate => candidate.questionId === snapshot.questionId);
  if (!reference || reference.answerId !== snapshot.answerId || reference.resultId !== snapshot.resultId) {
    throw new BatchReceiptValidationError('Batch result reference mismatch');
  }
  if (snapshot.createdAtEpochMs !== receipt.terminalAtEpochMs || snapshot.observation.status !== 'success'
    || snapshot.observation.requestId !== null || snapshot.observation.requestIdSource !== undefined
    || snapshot.observation.usage?.inputTokens !== null || snapshot.observation.usage?.outputTokens !== null
    || snapshot.observation.usage?.costUsd !== null) {
    throw new BatchReceiptValidationError('Batch result must contain only successful value evidence, not shared accounting');
  }
}

function scope(receipt: DecisionBatchReceipt): Pick<BatchResultSnapshot, 'tenantId' | 'projectId' | 'batchId'> {
  return { tenantId: receipt.tenantId, projectId: receipt.projectId, batchId: receipt.batchId };
}

function snapshotKey(input: Pick<BatchResultSnapshot, 'tenantId' | 'projectId' | 'batchId' | 'questionId' | 'answerId'>): string {
  return `${input.tenantId}\u0000${input.projectId}\u0000${input.batchId}\u0000${input.questionId}\u0000${input.answerId}`;
}

/** Unkeyed name used by stores written before encryption; only migration and refusal checks read it. */
function legacyName(input: Pick<BatchResultSnapshot, 'tenantId' | 'projectId' | 'batchId' | 'questionId' | 'answerId'>): string {
  return createHash('sha256').update(snapshotKey(input)).digest('hex');
}
