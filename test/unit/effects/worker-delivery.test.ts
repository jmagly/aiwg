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
    expect(await lookupWorkerDelivery(ledger, deliverablePath)).not.toHaveProperty('kind');
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

describe('T-OG-04 signed typed-stop delivery', () => {
  const stop = (deliverablePath: string) => ({ kind: 'typed-stop' as const, verifierId: 'typed-stop@1' as const,
    deliverablePath, artifactDigest: sha256Digest('stop\n') });
  it('verifies typed-stop bytes without inventing worker lineage and detects edits', async () => {
    const ledger = h.ledger(), deliverablePath = join(h.dir, 'answer');
    const complete = await prepareWorkerDelivery(ledger, stop(deliverablePath));
    writeFileSync(deliverablePath, 'stop\n');
    expect((await lookupWorkerDelivery(ledger, deliverablePath)).verified).toBe(false);
    await complete();
    const result = await lookupWorkerDelivery(ledger, deliverablePath);
    expect(result).toMatchObject({ verified: true, ...stop(deliverablePath), recordHash: expect.stringMatching(/^sha256:/) });
    expect(result).not.toHaveProperty('invocationId'); expect(result).not.toHaveProperty('runDir');
    writeFileSync(deliverablePath, 'changed');
    expect((await lookupWorkerDelivery(ledger, deliverablePath)).verified).toBe(false);
  });
  it.each(['intent', 'completed', 'changed', 'deleted'])('refuses prior worker delivery (%s), regardless of current bytes', async state => {
    const ledger = h.ledger(), deliverablePath = join(h.dir, 'answer');
    writeFileSync(deliverablePath, 'worker');
    const complete = await prepareWorkerDelivery(ledger, { deliverablePath, artifactDigest: sha256Digest('worker'),
      verifierId: 'trusted-verification@1', runDir: join(h.dir, 'run'), invocationId: 'worker-1' });
    if (state !== 'intent') await complete();
    if (state === 'changed') writeFileSync(deliverablePath, 'changed');
    if (state === 'deleted') unlinkSync(deliverablePath);
    await expect(prepareWorkerDelivery(ledger, stop(deliverablePath))).rejects.toThrow('TYPED_STOP_CONFLICT');
  });
  it('reserves typed-stop paths against subsequent workers and repeated stops', async () => {
    const ledger = h.ledger(), deliverablePath = join(h.dir, 'answer');
    await prepareWorkerDelivery(ledger, stop(deliverablePath));
    await expect(prepareWorkerDelivery(ledger, stop(deliverablePath))).rejects.toThrow('TYPED_STOP_CONFLICT');
    await expect(prepareWorkerDelivery(ledger, { deliverablePath, artifactDigest: sha256Digest('worker'),
      verifierId: 'trusted-verification@1', runDir: join(h.dir, 'run'), invocationId: 'worker-1' })).rejects.toThrow('TYPED_STOP_CONFLICT');
  });
  it('serializes simultaneous worker/stop reservations so only one can win', async () => {
    const deliverablePath = join(h.dir, 'answer');
    const results = await Promise.allSettled([
      prepareWorkerDelivery(h.ledger(), stop(deliverablePath)),
      prepareWorkerDelivery(h.ledger({ writer: 'writer-b' }), { deliverablePath, artifactDigest: sha256Digest('worker'),
        verifierId: 'trusted-verification@1', runDir: join(h.dir, 'run'), invocationId: 'worker-1' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'TYPED_STOP_CONFLICT' } });
  });
  it('rejects typed-stop metadata with forged worker lineage', async () => {
    await expect(prepareWorkerDelivery(h.ledger(), { ...stop(join(h.dir, 'answer')), invocationId: 'forged' } as any))
      .rejects.toThrow('TYPED_STOP_INVALID');
  });
});
