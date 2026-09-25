/**
 * Key rotation: rotations are signed by the prior and successor keys, records
 * signed before a rotation keep verifying, and the old key is refused after its
 * window closes. Offline only.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EffectLedgerError,
  LedgerSigningKey,
  isEffectSchemaValid,
  keyringFailure,
  lookupEffect,
  recordIntent,
  recordOutcome,
  rotateKey,
  staticKeyProvider,
  verifyLedger,
  writeCheckpoint,
  type EffectKeyring,
} from '../../../src/effects/index.js';
import { signSegmentLine, statementFor } from '../../../src/effects/records.js';
import { comment, harness, present, scope, testKey, type Harness } from './helpers.js';

let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());

const root = () => join(h.dir, '.aiwg', 'effects', 'delivery');
const keyringFile = () => join(root(), 'keyring.json');
const readKeyring = (): EffectKeyring => JSON.parse(readFileSync(keyringFile(), 'utf8'));

describe('key rotation', () => {
  it('EFF-ROT-01 a rotation is signed by both keys, and records and checkpoints from before it still verify', async () => {
    const ledger = h.ledger();
    const before = await recordIntent(ledger, comment(1));
    await writeCheckpoint(ledger);
    h.clock.advance(60_000);
    const effectiveAt = new Date(h.clock.now).toISOString();
    const keyring = await rotateKey(ledger, staticKeyProvider(testKey('b')), { reason: 'scheduled' });
    expect(isEffectSchemaValid('keyring', keyring)).toBe(true);
    expect(keyringFailure(keyring, scope)).toBeNull();
    expect(keyring.keys.map(key => key.status)).toEqual(['retired', 'active']);
    expect(keyring.keys[0].validUntil).toBe(effectiveAt);
    expect(keyring.rotations[0].signatures.map(signature => signature.role)).toEqual(['prior', 'successor']);

    h.clock.advance(1000);
    await recordOutcome(ledger, before.effectId, { phase: 'completed', payloadDigest: comment(1).payloadDigest, verification: present() });
    await writeCheckpoint(ledger);
    const verification = await verifyLedger(ledger);
    expect(verification).toMatchObject({ ok: true, checkpoint: { sequence: 1 } });
    const lookup = await lookupEffect(ledger, before.effectId);
    expect(lookup.records.map(record => record.keyid)).toEqual([keyring.keys[0].keyid, keyring.keys[1].keyid]);
  });

  it('EFF-ROT-02 the old key is refused for new writes, and a record it signs after validUntil fails verification', async () => {
    const ledger = h.ledger();
    await recordIntent(ledger, comment(1));
    h.clock.advance(60_000);
    await rotateKey(ledger, staticKeyProvider(testKey('b')));
    h.clock.advance(1000);

    const stale = h.ledger({ writer: 'writer-a', key: 'a' });
    const error = await recordIntent(stale, comment(2)).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(EffectLedgerError);
    expect((error as EffectLedgerError).reason).toBe('key-not-active');

    // Forge a correctly chained line signed by the retired key after its window.
    const lines = readFileSync(join(root(), 'segments', 'writer-a.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const head = JSON.parse(Buffer.from(lines[0].envelope.payload, 'base64').toString('utf8')).predicate;
    const forged = signSegmentLine(statementFor({
      ...head, phase: 'failed', seq: 1, prev: lines[0].recordHash, recordedAt: new Date(h.clock.now).toISOString(),
      failure: { reason: 'target-rejected' },
    }), new LedgerSigningKey(testKey('a')));
    appendFileSync(join(root(), 'segments', 'writer-a.jsonl'), `${JSON.stringify(forged)}\n`);
    const result = await verifyLedger(ledger, { checkIndex: false });
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(expect.objectContaining({ reason: 'key-window', writer: 'writer-a', seq: 1 }));
  });

  it('EFF-ROT-03 a rotation without a valid prior-key signature is rejected', async () => {
    const ledger = h.ledger();
    await recordIntent(ledger, comment(1));
    h.clock.advance(60_000);
    await rotateKey(ledger, staticKeyProvider(testKey('b')));
    const ring = readKeyring();
    const successorSig = ring.rotations[0].signatures.find(signature => signature.role === 'successor')!.sig;
    ring.rotations[0].signatures = ring.rotations[0].signatures.map(signature => signature.role === 'prior' ? { ...signature, sig: successorSig } : signature);
    expect(keyringFailure(ring, scope)).toBe('keyring-rotation-prior-signature');
    writeFileSync(keyringFile(), JSON.stringify(ring));
    expect((await verifyLedger(ledger, { sink: null })).failures).toContainEqual({ reason: 'keyring-rotation-prior-signature' });

    const unsigned = { ...ring, rotations: [{ ...ring.rotations[0], signatures: ring.rotations[0].signatures.filter(signature => signature.role !== 'prior') }] };
    expect(keyringFailure(unsigned, scope)).toBe('keyring-schema-invalid');
    const injected = { ...ring, rotations: [], keys: [ring.keys[0], ring.keys[1]] };
    expect(keyringFailure(injected, scope)).toBe('keyring-unrotated-key');
  });

  it('EFF-ROT-04 only the active key can rotate, and a successor cannot be reused', async () => {
    const ledger = h.ledger();
    await recordIntent(ledger, comment(1));
    h.clock.advance(60_000);
    await rotateKey(ledger, staticKeyProvider(testKey('b')));
    h.clock.advance(60_000);
    await expect(rotateKey(h.ledger({ key: 'a' }), staticKeyProvider(testKey('c')))).rejects.toMatchObject({ reason: 'rotation-prior-not-active' });
    await expect(rotateKey(ledger, staticKeyProvider(testKey('a')))).rejects.toMatchObject({ reason: 'rotation-key-reused' });
  });
});
