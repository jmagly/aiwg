import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../src/security/artifact-trust.js';
import { FileGraphRunReceiptStore } from '../../../src/decision/graph-run-store.js';
import type { GraphRunReceipt } from '../../../src/decision/graph-run.js';
describe('DAG immutable receipt persistence', () => {
  it('DAG-031 writes private create-once receipts and rejects modified data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'graph-receipt-'));
    try {
      const body = { schemaVersion: 'decision-graph-run/v1' as const, graphDigest: 'sha256:a', flowRunId: 'run',
        flowStatus: 'completed', flowStopReason: 'completed', evidence: {} as GraphRunReceipt['evidence'],
        terminal: 'node', outcome: 'complete' as const, value: null, batches: [], attempts: [] };
      const receipt: GraphRunReceipt = { ...body,
        receiptDigest: `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}` };
      const store = new FileGraphRunReceiptStore(directory);
      await store.create('receipt', receipt);
      expect(await store.read('receipt')).toEqual(receipt);
      expect((await stat(join(directory, 'receipt.json'))).mode & 0o777).toBe(0o600);
      await expect(store.create('receipt', receipt)).rejects.toThrow();
      await writeFile(join(directory, 'receipt.json'), JSON.stringify({ ...receipt, terminal: 'forged' }));
      await expect(store.read('receipt')).rejects.toThrow(/digest mismatch/);
      await expect(store.read('../unsafe')).rejects.toThrow(/invalid graph receipt id/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
