import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { harness } from './helpers.js';
import { prepareWorkerDelivery, lookupWorkerDelivery } from '../../../src/effects/worker-delivery.js';
import { sha256Digest } from '../../../src/effects/identity.js';

let h: ReturnType<typeof harness>;
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());
describe('T-OG-04 signed worker delivery lookup', () => {
  it('requires a completed signed record for the current digest and preserves verifier lineage', async () => {
    const ledger = h.ledger();
    const deliverablePath = join(h.dir, 'answer');
    writeFileSync(deliverablePath, 'accepted');
    expect(await lookupWorkerDelivery(ledger, deliverablePath)).toMatchObject({ verified: false });
    const metadata = { artifactDigest: sha256Digest('accepted'), deliverablePath, verifierId: 'trusted-verification@1', runDir: join(h.dir, 'run'), invocationId: 'invocation-1' };
    const complete = await prepareWorkerDelivery(ledger, metadata);
    expect(await lookupWorkerDelivery(ledger, deliverablePath)).toMatchObject({ verified: false });
    await complete();
    expect(await lookupWorkerDelivery(ledger, deliverablePath)).toMatchObject({ verified: true, ...metadata });
    unlinkSync(ledger.paths().indexKey);
    expect((await lookupWorkerDelivery(ledger, deliverablePath)).verified).toBe(true);
    expect(existsSync(ledger.paths().indexKey)).toBe(false);
    writeFileSync(deliverablePath, 'changed');
    expect(await lookupWorkerDelivery(ledger, deliverablePath)).toMatchObject({ verified: false });
  });
});

it('rejects a changed published digest and a tampered signed delivery record', async () => {
  const ledger = h.ledger(), deliverablePath = join(h.dir, 'answer');
  writeFileSync(deliverablePath, 'accepted');
  const complete = await prepareWorkerDelivery(ledger, { artifactDigest: sha256Digest('accepted'), deliverablePath, verifierId: 'trusted-verification@1', runDir: join(h.dir, 'run'), invocationId: 'invocation-1' });
  writeFileSync(deliverablePath, 'changed');
  await expect(complete()).rejects.toThrow('digest does not match');
  writeFileSync(deliverablePath, 'accepted'); await complete();
  const segment = join(ledger.paths().root, 'segments', 'writer-a.jsonl');
  const lines = readFileSync(segment, 'utf8').trim().split('\n');
  const line = JSON.parse(lines[1]); line.envelope.signatures[0].sig = Buffer.alloc(64).toString('base64');
  lines[1] = JSON.stringify(line); writeFileSync(segment, lines.join('\n') + '\n');
  expect(await lookupWorkerDelivery(ledger, deliverablePath)).toMatchObject({ verified: false, reason: 'ledger-integrity-failed' });
});
it('reports an absent deliverable as unverified without creating ledger state', async () => {
  expect(await lookupWorkerDelivery(h.ledger(), join(h.dir, 'missing'))).toMatchObject({ verified: false, reason: 'deliverable-unreadable' });
});
