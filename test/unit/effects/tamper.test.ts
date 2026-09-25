/**
 * Tamper matrix: verifyLedger reports an integrity failure (exit 6) for every
 * edit, reorder, splice, truncation, deletion, forged or foreign signature and
 * cross-scope replay. Offline only.
 */
import { createHash, createPublicKey, sign } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson, dssePae } from '../../../src/security/artifact-trust.js';
import {
  EFFECT_EXIT_CODES,
  EffectLedgerError,
  lookupEffect,
  recordIntent,
  recordOutcome,
  verifyLedger,
  writeCheckpoint,
  type EffectLedger,
} from '../../../src/effects/index.js';
import { comment, harness, present, scope, testKey, type Harness } from './helpers.js';

let h: Harness;
let ledger: EffectLedger;
let firstId: string;

const root = (subsystem = 'delivery') => join(h.dir, '.aiwg', 'effects', subsystem);
const segmentPath = (writer: string, subsystem = 'delivery') => join(root(subsystem), 'segments', `${writer}.jsonl`);
const readLines = (writer: string, subsystem = 'delivery') => readFileSync(segmentPath(writer, subsystem), 'utf8').trim().split('\n');
const writeLines = (writer: string, lines: string[]) => writeFileSync(segmentPath(writer), `${lines.join('\n')}\n`);
const reasons = async (options: Parameters<typeof verifyLedger>[1] = {}) => {
  const result = await verifyLedger(ledger, options);
  expect(result.ok).toBe(false);
  expect(result.exitCode).toBe(EFFECT_EXIT_CODES.integrity);
  return result.failures.map(failure => failure.reason);
};

function resign(lineText: string, label: string, mutate: (statement: any) => void = () => {}, keyid?: string): string {
  const line = JSON.parse(lineText);
  const statement = JSON.parse(Buffer.from(line.envelope.payload, 'base64').toString('utf8'));
  mutate(statement);
  const payload = Buffer.from(canonicalJson(statement), 'utf8');
  const key = testKey(label);
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' });
  line.envelope.payload = payload.toString('base64');
  line.envelope.signatures = [{
    keyid: keyid ?? `sha256:${createHash('sha256').update(der).digest('hex')}`,
    sig: sign(null, dssePae('application/vnd.in-toto+json', payload), key).toString('base64'),
  }];
  return JSON.stringify(line);
}

beforeEach(async () => {
  h = harness();
  ledger = h.ledger();
  const first = await recordIntent(ledger, comment(1));
  firstId = first.effectId;
  h.clock.advance(1000);
  await recordOutcome(ledger, first.effectId, { phase: 'completed', payloadDigest: comment(1).payloadDigest, verification: present() });
  h.clock.advance(1000);
  await recordIntent(ledger, comment(2));
  const other = h.ledger({ writer: 'writer-b' });
  await recordIntent(other, comment(3));
  h.clock.advance(1000);
  await recordIntent(other, comment(4));
  await writeCheckpoint(ledger);
  expect((await verifyLedger(ledger)).ok).toBe(true);
});
afterEach(() => h.cleanup());

describe('tamper matrix', () => {
  it('EFF-TAM-01 an edited payload byte breaks the signature', async () => {
    const lines = readLines('writer-a');
    const line = JSON.parse(lines[1]);
    const payload = Buffer.from(line.envelope.payload, 'base64');
    payload[payload.indexOf('"completed"') + 2] ^= 0x01;
    line.envelope.payload = payload.toString('base64');
    lines[1] = JSON.stringify(line);
    writeLines('writer-a', lines);
    const found = await reasons();
    expect(found.some(reason => ['signature-invalid', 'statement-malformed', 'statement-schema-invalid', 'statement-not-canonical'].includes(reason))).toBe(true);
    await expect(lookupEffect(ledger, firstId)).rejects.toMatchObject({ exitCode: 6 });
  });

  it('EFF-TAM-02 an edited record hash byte breaks the record hash and the chain', async () => {
    const lines = readLines('writer-a');
    lines[0] = lines[0].replace(/"recordHash":"sha256:(.)/, (_match, char: string) => `"recordHash":"sha256:${char === '0' ? '1' : '0'}`);
    writeLines('writer-a', lines);
    expect(await reasons()).toEqual(expect.arrayContaining(['record-hash-mismatch', 'chain-broken']));
  });

  it('EFF-TAM-03 reordered lines break the seq binding and the chain', async () => {
    const lines = readLines('writer-a');
    writeLines('writer-a', [lines[1], lines[0], lines[2]]);
    expect(await reasons()).toEqual(expect.arrayContaining(['seq-mismatch', 'chain-broken']));
  });

  it('EFF-TAM-04 a record spliced in from another segment is detected', async () => {
    const lines = readLines('writer-a');
    lines[2] = readLines('writer-b')[1];
    writeLines('writer-a', lines);
    expect(await reasons()).toEqual(expect.arrayContaining(['writer-mismatch']));
  });

  it('EFF-TAM-05 a truncated segment tail is detected against the sink checkpoint, even with local checkpoints deleted', async () => {
    writeLines('writer-a', readLines('writer-a').slice(0, 2));
    rmSync(join(root(), 'checkpoints'), { recursive: true, force: true });
    const found = await reasons({ checkIndex: false });
    expect(found).toContain('segment-truncated');
    expect((await verifyLedger(ledger, { sink: null, checkIndex: false })).warnings).toContain('no-checkpoint');
  });

  it('EFF-TAM-06 a deleted segment file is detected against the checkpoint', async () => {
    rmSync(segmentPath('writer-b'));
    expect(await reasons()).toEqual(expect.arrayContaining(['segment-missing', 'index-dangling']));
    expect(await reasons({ sink: null })).toContain('segment-missing');
  });

  it('EFF-TAM-07 a forged signature under the ledger keyid is rejected', async () => {
    const lines = readLines('writer-a');
    const keyid = JSON.parse(lines[1]).envelope.signatures[0].keyid;
    lines[1] = resign(lines[1], 'forger', statement => { statement.predicate.payloadDigest = `sha256:${'0'.repeat(64)}`; }, keyid);
    writeLines('writer-a', lines);
    expect(await reasons({ checkIndex: false })).toContain('signature-invalid');
  });

  it('EFF-TAM-08 a signature by an unknown keyid is rejected', async () => {
    const lines = readLines('writer-a');
    lines[1] = resign(lines[1], 'stranger');
    writeLines('writer-a', lines);
    expect(await reasons()).toContain('unknown-keyid');
  });

  it('EFF-TAM-09 a validly signed record replayed from another scope is rejected', async () => {
    const job = h.ledger({ scope: { ...scope, subsystem: 'job' } });
    await recordIntent(job, comment(1));
    const lines = readLines('writer-a');
    lines[0] = readLines('writer-a', 'job')[0];
    writeLines('writer-a', lines);
    const found = await reasons();
    expect(found).toContain('scope-mismatch');
    expect(found).not.toContain('signature-invalid');
  });

  it('EFF-TAM-10 a keyring swapped for an attacker key, a re-windowed keyring, or an edited checkpoint is rejected', async () => {
    const keyringFile = join(root(), 'keyring.json');
    const original = readFileSync(keyringFile, 'utf8');
    const ring = JSON.parse(original);
    ring.keys[0].validFrom = '2020-01-01T00:00:00.000Z';
    writeFileSync(keyringFile, JSON.stringify(ring));
    expect(await reasons()).toContain('sink-checkpoint-keyring-mismatch');

    // Full substitution: every record re-signed by an attacker key with a matching genesis keyring.
    const attacker = createPublicKey(testKey('attacker')).export({ format: 'der', type: 'spki' });
    const attackerKeyid = `sha256:${createHash('sha256').update(attacker).digest('hex')}`;
    writeFileSync(keyringFile, JSON.stringify({ ...JSON.parse(original), keys: [{ ...JSON.parse(original).keys[0], keyid: attackerKeyid, publicKey: attacker.toString('base64') }] }));
    for (const writer of ['writer-a', 'writer-b']) writeLines(writer, readLines(writer).map(line => resign(line, 'attacker')));
    expect(await reasons()).toEqual(expect.arrayContaining(['sink-checkpoint-keyring-mismatch']));
    expect(await reasons({ sink: null })).toEqual(expect.arrayContaining(['checkpoint-keyring-mismatch']));
  });

  it('EFF-TAM-10b an edited local checkpoint is rejected', async () => {
    const checkpointFile = join(root(), 'checkpoints', '0.json');
    const checkpoint = JSON.parse(readFileSync(checkpointFile, 'utf8'));
    checkpoint.writers[0].count = 1;
    writeFileSync(checkpointFile, JSON.stringify(checkpoint));
    expect(await reasons()).toEqual(expect.arrayContaining(['checkpoint-root-mismatch']));
  });

  it('EFF-TAM-11 writes refuse to extend a torn or tampered segment head', async () => {
    const lines = readLines('writer-a');
    writeFileSync(segmentPath('writer-a'), `${lines.join('\n')}\n{"torn":`);
    const error = await recordIntent(ledger, comment(9)).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(EffectLedgerError);
    expect((error as EffectLedgerError).exitCode).toBe(6);
    expect(await reasons()).toContain('segment-torn');
  });
});
