import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../security/artifact-trust.js';
import { admitEntry } from './entry.js';
import { DecisionGraphError } from './graph.js';
import type { GraphRunReceipt } from './graph-run.js';

/** Immutable create-once graph receipt store. Digest detects accidental changes;
 * without a host-supplied authenticated storage layer it does not prove origin.
 * Flow checkpoint and dispatcher receipts remain their own durable authorities.
 */
export class FileGraphRunReceiptStore {
  constructor(private readonly directory: string) {}
  private path(id: string) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new DecisionGraphError('invalid graph receipt id');
    return join(this.directory, `${id}.json`);
  }
  async create(id: string, receipt: GraphRunReceipt): Promise<void> {
    const destination = this.path(id);
    this.verify(receipt);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(canonicalJson(receipt));
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporary);
      throw error;
    }
    await handle.close();
    try {
      // link is exclusive: another writer cannot replace the existing receipt.
      await link(temporary, destination);
    } finally { await unlink(temporary); }
  }
  async read(id: string): Promise<GraphRunReceipt> {
    const value = JSON.parse(await readFile(this.path(id), 'utf8')) as GraphRunReceipt;
    this.verify(value);
    return value;
  }
  private verify(value: GraphRunReceipt): void {
    try { admitEntry(value); } catch { throw new DecisionGraphError('invalid graph receipt'); }
    if (value.schemaVersion !== 'decision-graph-run/v1' || typeof value.receiptDigest !== 'string') {
      throw new DecisionGraphError('invalid graph receipt');
    }
    const { receiptDigest, ...body } = value;
    if (receiptDigest !== `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`) {
      throw new DecisionGraphError('graph receipt digest mismatch');
    }
  }
}
