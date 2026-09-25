/**
 * Effect ledger v1 runtime conformance (offline).
 *
 * The E1 contract fixtures are golden vectors for the `src/effects` library:
 * the runtime schema validator agrees with the catalog on every positive and
 * negative fixture, and a ledger assembled from the fixture segment lines,
 * keyring and checkpoint verifies with the library, answers lookups, and fails
 * on tamper.
 *
 * @see docs/contracts/effect-ledger.v1.md
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  effectId,
  isEffectSchemaValid,
  keyringFailure,
  lookupEffect,
  memoryCheckpointSink,
  openEffectLedger,
  verifyLedger,
  type EffectCheckpoint,
  type EffectKeyring,
  type EffectSchemaName,
} from '../../../src/effects/index.js';
import { checkpointFailure } from '../../../src/effects/verify.js';
import { decodeSegmentLine } from '../../../src/effects/records.js';

const fixtureDir = 'test/fixtures/effects';
const read = (file: string) => JSON.parse(readFileSync(join(fixtureDir, file), 'utf8'));
const scope = { tenant: 'local', project: 'example/repo', subsystem: 'delivery' as const };
const schemaFor = (name: string): EffectSchemaName => name.startsWith('record.') ? 'record'
  : name.startsWith('checkpoint.') ? 'checkpoint' : name.startsWith('keyring.') ? 'keyring' : 'verifierResult';

let projectDir: string;
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'aiwg-effects-conformance-'));
  const root = join(projectDir, '.aiwg', 'effects', 'delivery');
  for (const directory of ['segments', 'checkpoints']) mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
  const line = (file: string) => JSON.stringify(read(`valid/${file}`));
  writeFileSync(join(root, 'segments', 'writer-a.jsonl'), `${line('record.segment-a-0.intent.json')}\n${line('record.segment-a-1.completed.json')}\n`);
  writeFileSync(join(root, 'segments', 'writer-b.jsonl'), `${line('record.segment-b-0.tombstone.json')}\n${line('record.segment-b-1.tombstone.json')}\n`);
  copyFileSync(join(fixtureDir, 'valid/keyring.rotated.json'), join(root, 'keyring.json'));
  copyFileSync(join(fixtureDir, 'valid/checkpoint.initial.json'), join(root, 'checkpoints', '0.json'));
});
afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

// The fixture checkpoint is also held by an independent sink, as the contract requires.
const ledger = () => {
  const sink = memoryCheckpointSink();
  sink.published.push(read('valid/checkpoint.initial.json'));
  return openEffectLedger({ projectDir, scope, writer: 'verifier', sink });
};

describe('effect ledger v1 runtime conformance', () => {
  it.each(readdirSync(join(fixtureDir, 'valid')).sort())('EFF-RT-01 the runtime validator accepts valid/%s', file => {
    expect(isEffectSchemaValid(schemaFor(file), read(`valid/${file}`))).toBe(true);
  });

  it.each(readdirSync(join(fixtureDir, 'invalid')).sort())('EFF-RT-02 the runtime validator rejects invalid/%s', file => {
    expect(isEffectSchemaValid(schemaFor(file), read(`invalid/${file}`))).toBe(false);
  });

  it('EFF-RT-03 the fixture keyring, checkpoint and segment lines verify as a ledger', async () => {
    const keyring = read('valid/keyring.rotated.json') as EffectKeyring;
    expect(keyringFailure(keyring, scope)).toBeNull();
    expect(keyringFailure(read('invalid/keyring.rotation-not-signed-by-prior.json'), scope)).not.toBeNull();
    expect(checkpointFailure(read('valid/checkpoint.initial.json') as EffectCheckpoint, keyring, scope)).toBeNull();
    const result = await verifyLedger(ledger(), { checkIndex: false });
    expect(result.failures).toEqual([]);
    expect(result).toMatchObject({ ok: true, exitCode: 0, records: 4, checkpoint: { sequence: 0, source: 'sink' } });
    expect((await verifyLedger(openEffectLedger({ projectDir, scope, writer: 'verifier', sink: memoryCheckpointSink() }), { checkIndex: false })).failures).toEqual([{ reason: 'checkpoint-sink-missing' }]);
  });

  it('EFF-RT-04 the library decodes fixture lines to the fixture statements and rederives their IDs', () => {
    const decoded = decodeSegmentLine(JSON.stringify(read('valid/record.segment-a-0.intent.json')));
    expect('failure' in decoded).toBe(false);
    if ('failure' in decoded) return;
    expect(decoded.statement).toEqual(read('valid/record.statement.intent.json'));
    const { predicate } = decoded.statement;
    expect(effectId({ scope: predicate.scope, kind: predicate.kind, target: predicate.target!, context: predicate.context! })).toBe(predicate.effectId);
    const d13 = read('valid/record.statement.d13-intent.json').predicate;
    expect(effectId({ scope: d13.scope, kind: d13.kind, target: d13.target, context: d13.context })).toBe(d13.effectId);
  });

  it('EFF-RT-05 lookups over the fixture ledger follow the exit-code contract', async () => {
    const intent = read('valid/record.statement.intent.json').predicate;
    const tombstone = read('valid/record.statement.tombstone.json').predicate;
    expect(await lookupEffect(ledger(), intent.effectId)).toMatchObject({ status: 'completed', result: 'present', exitCode: 0 });
    const purged = await lookupEffect(ledger(), tombstone.effectId);
    expect(purged).toMatchObject({ status: 'tombstoned', tombstoned: true, exitCode: 0 });
    expect(purged).not.toHaveProperty('target');
  });

  it('EFF-RT-06 a tampered fixture line or a truncated fixture segment fails library verification', async () => {
    const segment = join(projectDir, '.aiwg', 'effects', 'delivery', 'segments', 'writer-a.jsonl');
    const lines = readFileSync(segment, 'utf8').trim().split('\n');
    writeFileSync(segment, `${lines[0]}\n`);
    expect((await verifyLedger(ledger(), { checkIndex: false })).failures).toContainEqual(expect.objectContaining({ reason: 'segment-truncated', writer: 'writer-a' }));
    writeFileSync(segment, `${lines[1]}\n${lines[0]}\n`);
    expect((await verifyLedger(ledger(), { checkIndex: false })).ok).toBe(false);
  });
});
