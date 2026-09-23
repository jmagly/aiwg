import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../security/artifact-trust.js';
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

/** Every revision is immutable; hard-link publication supplies filesystem CAS. */
export class FileBatchReceiptStore implements BatchReceiptStore {
  constructor(private readonly directory: string) {}

  async acquire(initial: DecisionBatchReceipt): Promise<BatchReceiptAcquireResult> {
    validateBatchReceipt(initial);
    if (initial.revision !== 1 || initial.status !== 'acquired') throw new BatchReceiptValidationError('Initial receipt must be acquired revision 1');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const published = await this.publish(initial);
    if (published) return { owner: true, receipt: structuredClone(initial) };
    const existing = (await this.read(initial.batchId, initial.tenantId, initial.projectId))!;
    assertSameIdentity(initial, existing); return { owner: false, receipt: existing };
  }

  async read(batchId: string, tenantId: string, projectId: string): Promise<DecisionBatchReceipt | null> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const prefix = filePrefix(batchId, tenantId, projectId);
    const revisions = (await readdir(this.directory)).flatMap(name => {
      const match = name.match(new RegExp(`^${prefix}\\.r([0-9]+)\\.json$`)); return match ? [Number(match[1])] : [];
    }).sort((a, b) => a - b);
    if (!revisions.length) return null;
    revisions.forEach((revision, index) => { if (revision !== index + 1) throw new BatchReceiptValidationError('Batch receipt revision gap'); });
    let previous: DecisionBatchReceipt | null = null;
    for (const revision of revisions) {
      const parsed = JSON.parse(await readFile(join(this.directory, `${prefix}.r${revision}.json`), 'utf8')) as DecisionBatchReceipt;
      validateBatchReceipt(parsed);
      if (parsed.batchId !== batchId || parsed.tenantId !== tenantId || parsed.projectId !== projectId) {
        throw new BatchReceiptValidationError('Batch receipt scope substitution');
      }
      if (previous) validateBatchReceiptTransition(previous, parsed);
      previous = parsed;
    }
    return structuredClone(previous);
  }

  async compareAndSwap(previous: DecisionBatchReceipt, next: DecisionBatchReceipt): Promise<boolean> {
    validateBatchReceiptTransition(previous, next);
    const current = await this.read(previous.batchId, previous.tenantId, previous.projectId);
    if (!current || canonicalJson(current) !== canonicalJson(previous)) return false;
    return this.publish(next);
  }

  private async publish(receipt: DecisionBatchReceipt): Promise<boolean> {
    const finalPath = join(this.directory, `${filePrefix(receipt.batchId, receipt.tenantId, receipt.projectId)}.r${receipt.revision}.json`);
    const temporary = join(this.directory, `.batch-receipt-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${canonicalJson(receipt)}\n`, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temporary, finalPath); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    finally { await rm(temporary, { force: true }); }
  }
}

function scopeKey(batchId: string, tenantId: string, projectId: string): string { return `${tenantId}\u0000${projectId}\u0000${batchId}`; }
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
