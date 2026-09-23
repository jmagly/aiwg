import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../security/artifact-trust.js';
import type { AdapterObservation } from '../types.js';
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

export class FileBatchResultStore implements BatchResultStore {
  constructor(private readonly directory: string) {}

  async writeMany(receipt: DecisionBatchReceipt, observations: ReadonlyMap<string, AdapterObservation>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const snapshot of snapshotsFor(receipt, observations)) await this.publish(snapshot);
  }

  async readMany(receipt: DecisionBatchReceipt): Promise<Map<string, AdapterObservation>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const found = new Map<string, AdapterObservation>();
    const names = await readdir(this.directory);
    for (const reference of receipt.answerReferences) {
      const prefix = filePrefix({ ...scope(receipt), questionId: reference.questionId, answerId: reference.answerId });
      const name = names.find(candidate => candidate === `${prefix}.json`);
      if (!name) return new Map();
      const parsed = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as BatchResultSnapshot;
      validateSnapshotForReceipt(parsed, receipt);
      found.set(reference.questionId, structuredClone(parsed.observation));
    }
    return found;
  }

  private async publish(snapshot: BatchResultSnapshot): Promise<void> {
    const finalPath = join(this.directory, `${filePrefix(snapshot)}.json`);
    const temporary = join(this.directory, `.batch-result-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${canonicalJson(snapshot)}\n`, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temporary, finalPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { await rm(temporary, { force: true }); }
  }
}

function snapshotsFor(receipt: DecisionBatchReceipt, observations: ReadonlyMap<string, AdapterObservation>): BatchResultSnapshot[] {
  if (receipt.status !== 'completed' || receipt.terminalAtEpochMs === null) {
    throw new BatchReceiptValidationError('Batch results require a completed receipt');
  }
  return receipt.answerReferences.map(reference => {
    const observation = observations.get(reference.questionId);
    if (!observation || observation.status !== 'success') {
      throw new BatchReceiptValidationError('Batch result store only accepts successful completed observations');
    }
    return {
      schemaVersion: 'decision-batch-result/v1', ...scope(receipt), receiptRevision: receipt.revision,
      questionId: reference.questionId, answerId: reference.answerId, resultId: reference.resultId,
      observation: structuredClone(observation), createdAtEpochMs: receipt.terminalAtEpochMs!,
    };
  });
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
  if (snapshot.observation.status !== 'success') throw new BatchReceiptValidationError('Batch result is not successful evidence');
}

function scope(receipt: DecisionBatchReceipt): Pick<BatchResultSnapshot, 'tenantId' | 'projectId' | 'batchId'> {
  return { tenantId: receipt.tenantId, projectId: receipt.projectId, batchId: receipt.batchId };
}

function snapshotKey(input: Pick<BatchResultSnapshot, 'tenantId' | 'projectId' | 'batchId' | 'questionId' | 'answerId'>): string {
  return `${input.tenantId}\u0000${input.projectId}\u0000${input.batchId}\u0000${input.questionId}\u0000${input.answerId}`;
}

function filePrefix(input: Pick<BatchResultSnapshot, 'tenantId' | 'projectId' | 'batchId' | 'questionId' | 'answerId'>): string {
  return createHash('sha256').update(snapshotKey(input)).digest('hex');
}
