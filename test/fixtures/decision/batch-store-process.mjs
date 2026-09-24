import { readFileSync } from 'node:fs';
import { FileBatchReceiptStore, FileBatchResultStore } from '../../../src/decision/batch-receipts/index.ts';
import { DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION } from '../../../src/decision/lifecycle.ts';

const [receiptDirectory, resultDirectory, integrityHex, encryptionHex, inputPath, mode] = process.argv.slice(2);
const lifecycle = { version: DECISION_LIFECYCLE_VERSION, surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
  classification: 'restricted', accessScopes: ['batch-owner'], retentionMs: 86_400_000, export: 'denied', deletion: 'tombstone',
  backup: 'expire-with-primary',
}])) };
const clock = () => 1_000;
const integrityKey = Buffer.from(integrityHex, 'hex');
const results = new FileBatchResultStore(resultDirectory, { integrityKey, lifecycle, clock,
  encryptionKeyReference: 'batch-results-2026', resolveEncryptionKey: async () => Buffer.from(encryptionHex, 'hex') });
const receipts = new FileBatchReceiptStore(receiptDirectory, { integrityKey, lifecycle, clock, results });
const { chain, observations } = JSON.parse(readFileSync(inputPath, 'utf8'));
const last = chain.at(-1);

if (mode === 'write') {
  const acquired = await receipts.acquire(chain[0]);
  if (!acquired.owner) throw new Error('Expected to own the batch receipt');
  for (let index = 1; index < chain.length; index++) {
    // Values are published before the completed receipt revision becomes visible.
    if (index === chain.length - 1) await results.writeMany(chain[index], new Map(observations));
    if (!await receipts.compareAndSwap(chain[index - 1], chain[index])) throw new Error('Receipt publication lost');
  }
  process.stdout.write(`${JSON.stringify({ written: true })}\n`);
} else {
  const receipt = await receipts.read(last.batchId, last.tenantId, last.projectId);
  const values = receipt ? await results.readMany(receipt) : new Map();
  process.stdout.write(`${JSON.stringify({ status: receipt?.status ?? null,
    values: Object.fromEntries([...values].map(([questionId, value]) => [questionId, value.value])) })}\n`);
}
