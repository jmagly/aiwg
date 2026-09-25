/**
 * Effect ledger core: intent, outcome, reconcile and lookup semantics, schema
 * conformance of every written document, storage permissions and the
 * fail-closed artifact root. Offline only.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as api from '../../../src/api/index.js';
import {
  EFFECT_EXIT_CODES,
  EffectLedgerError,
  createVerifierRegistry,
  effectId,
  isEffectSchemaValid,
  lookupEffect,
  openEffectLedger,
  payloadDigest,
  reconcileEffect,
  recordIntent,
  recordOutcome,
  staticKeyProvider,
  verifyLedger,
  writeCheckpoint,
  type EffectVerifier,
} from '../../../src/effects/index.js';
import { comment, harness, present, scope, testKey, type Harness } from './helpers.js';

let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());

const ledgerRoot = () => join(h.dir, '.aiwg', 'effects', 'delivery');
const segmentLines = (writer: string) => readFileSync(join(ledgerRoot(), 'segments', `${writer}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const decode = (line: any) => JSON.parse(Buffer.from(line.envelope.payload, 'base64').toString('utf8'));

async function expectLedgerError(promise: Promise<unknown>, code: string, exitCode: number, reason?: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(EffectLedgerError);
  expect((error as EffectLedgerError).code).toBe(code);
  expect((error as EffectLedgerError).exitCode).toBe(exitCode);
  if (reason) expect((error as EffectLedgerError).reason).toBe(reason);
}

describe('library exports', () => {
  it('EFF-LIB-01 exports the contract operations from src/effects and the package API', () => {
    for (const name of ['effectId', 'recordIntent', 'recordOutcome', 'lookupEffect', 'reconcileEffect', 'verifyLedger', 'writeCheckpoint', 'rotateKey'] as const) {
      expect(typeof (api as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});

describe('intent idempotence and conflict', () => {
  it('EFF-LED-01 the same ID and payload digest returns the first receipt with idempotent: true', async () => {
    const ledger = h.ledger();
    const first = await recordIntent(ledger, comment());
    expect(first).toMatchObject({ phase: 'intent', writer: 'writer-a', seq: 0, idempotent: false, exitCode: 0 });
    expect(first.effectId).toMatch(/^eff1_[a-z2-7]{51}[aq]$/);
    h.clock.advance(1000);
    const again = await recordIntent(ledger, comment());
    expect(again).toEqual({ ...first, idempotent: true });
    expect(segmentLines('writer-a')).toHaveLength(1);
  });

  it('EFF-LED-02 the same ID with a different payload digest is a conflict (exit 5) and appends nothing', async () => {
    const ledger = h.ledger();
    await recordIntent(ledger, comment());
    await expectLedgerError(recordIntent(ledger, { ...comment(), payloadDigest: payloadDigest('different body') }), 'conflict', EFFECT_EXIT_CODES.conflict);
    await expectLedgerError(recordIntent(h.ledger({ writer: 'writer-b' }), { ...comment(), payloadDigest: payloadDigest('different body') }), 'conflict', 5);
    expect(segmentLines('writer-a')).toHaveLength(1);
    expect(existsSync(join(ledgerRoot(), 'segments', 'writer-b.jsonl'))).toBe(false);
  });

  it('EFF-LED-03 a second writer sees the first writer\'s receipt (first writer wins)', async () => {
    const first = await recordIntent(h.ledger(), comment());
    const second = await recordIntent(h.ledger({ writer: 'writer-b' }), comment());
    expect(second).toEqual({ ...first, idempotent: true });
  });

  it('EFF-LED-04 malformed inputs are usage errors (exit 2)', async () => {
    const ledger = h.ledger();
    await expectLedgerError(recordIntent(ledger, { ...comment(), kind: 'shell.exec' }), 'usage', 2, 'unknown-kind');
    await expectLedgerError(recordIntent(ledger, { ...comment(), target: 'has space' }), 'usage', 2, 'invalid-target');
    await expectLedgerError(recordIntent(ledger, { ...comment(), payloadDigest: 'md5:abc' }), 'usage', 2, 'invalid-payload-digest');
    await expectLedgerError(recordIntent(ledger, { ...comment(), context: { nested: { a: 1 } as never } }), 'usage', 2, 'invalid-context');
    await expectLedgerError(lookupEffect(ledger, 'eff1_NOTVALID'), 'usage', 2, 'malformed-effect-id');
    expect(() => openEffectLedger({ projectDir: h.dir, scope: { ...scope, subsystem: 'other' as never }, writer: 'writer-a' })).toThrow(EffectLedgerError);
    expect(() => openEffectLedger({ projectDir: h.dir, scope, writer: 'Writer_A' })).toThrow(EffectLedgerError);
  });

  it('EFF-LED-05 restricted material in the context is refused before signing', async () => {
    await expectLedgerError(recordIntent(h.ledger(), { ...comment(), context: { note: 'vault://kv/ledger' } }), 'usage', 2, 'restricted-material');
    await expectLedgerError(recordIntent(h.ledger(), { ...comment(), context: { secret_value: 'x' } }), 'usage', 2, 'restricted-material');
    expect(existsSync(join(ledgerRoot(), 'segments', 'writer-a.jsonl'))).toBe(false);
  });
});

describe('outcomes, reconcile and lookup', () => {
  it('EFF-LED-06 lookup exit codes follow the contract: none 3, intent 4, completed 0, failed 3', async () => {
    const ledger = h.ledger();
    const intent = await recordIntent(ledger, comment());
    expect((await lookupEffect(ledger, intent.effectId)).exitCode).toBe(EFFECT_EXIT_CODES.unknown);
    const missing = await lookupEffect(ledger, effectId({ scope, kind: 'git.tag', target: 'git-tag:never', context: {} }));
    expect(missing).toMatchObject({ found: false, status: 'none', exitCode: 3 });
    h.clock.advance(1000);
    const done = await recordOutcome(ledger, intent.effectId, { phase: 'completed', payloadDigest: comment().payloadDigest, verification: present() });
    expect(done).toMatchObject({ phase: 'completed', seq: 1, idempotent: false });
    const found = await lookupEffect(ledger, intent.effectId);
    expect(found).toMatchObject({ found: true, status: 'completed', result: 'present', exitCode: 0, kind: 'tracker.comment', target: 'gitea:example/repo#12' });
    expect(found.records.map(record => record.phase)).toEqual(['intent', 'completed']);

    const other = await recordIntent(ledger, comment(13));
    await recordOutcome(ledger, other.effectId, { phase: 'failed', payloadDigest: comment(13).payloadDigest, failure: { reason: 'target-rejected' } });
    expect(await lookupEffect(ledger, other.effectId)).toMatchObject({ status: 'failed', exitCode: 3 });
  });

  it('EFF-LED-07 outcomes are idempotent, the first outcome wins across writers, and a different outcome conflicts', async () => {
    const ledger = h.ledger();
    const intent = await recordIntent(ledger, comment());
    const input = { phase: 'completed' as const, payloadDigest: comment().payloadDigest, verification: present() };
    const first = await recordOutcome(ledger, intent.effectId, input);
    expect(await recordOutcome(h.ledger({ writer: 'writer-b' }), intent.effectId, input)).toEqual({ ...first, idempotent: true });
    await expectLedgerError(recordOutcome(ledger, intent.effectId, { phase: 'failed', payloadDigest: comment().payloadDigest, failure: { reason: 'target-rejected' } }), 'conflict', 5, 'outcome-conflict');
    await expectLedgerError(recordOutcome(ledger, intent.effectId, { ...input, payloadDigest: payloadDigest('other') }), 'conflict', 5);
    await expectLedgerError(recordOutcome(ledger, intent.effectId, { ...input, verification: { ...present(), result: 'unknown', reason: 'timeout', complete: false } }), 'usage', 2, 'completed-without-present');
    expect(segmentLines('writer-a')).toHaveLength(2);
  });

  it('EFF-LED-08 an outcome without an intent is refused', async () => {
    const ledger = h.ledger();
    const id = effectId({ scope, kind: 'git.tag', target: 'git-tag:v1', context: {} });
    await expectLedgerError(recordOutcome(ledger, id, { phase: 'failed', payloadDigest: payloadDigest('x'), failure: { reason: 'target-rejected' } }), 'usage', 2, 'intent-missing');
  });

  it('EFF-LED-09 reconcile with no registered verifier is unknown/verifier-missing (exit 4) and appends a reconciled record', async () => {
    const ledger = h.ledger();
    const intent = await recordIntent(ledger, comment());
    const outcome = await reconcileEffect(ledger, intent.effectId);
    expect(outcome.result).toMatchObject({ schemaVersion: 'aiwg.effect.verifier-result.v1', exitCode: 4, verification: { result: 'unknown', reason: 'verifier-missing', complete: false } });
    expect(isEffectSchemaValid('verifierResult', outcome.result)).toBe(true);
    expect(outcome.receipt).toMatchObject({ phase: 'reconciled', exitCode: 4 });
    expect(await lookupEffect(ledger, intent.effectId)).toMatchObject({ status: 'reconciled', result: 'unknown', exitCode: 4 });
  });

  it('EFF-LED-10 the verifier port enforces the tri-state rules', async () => {
    const ledger = h.ledger();
    const make = (canReportAbsent: boolean, observation: unknown): EffectVerifier => ({
      kind: 'tracker.comment', version: '1.2.3', canReportAbsent, verify: async () => observation as never,
    });
    const run = async (verifier: EffectVerifier, issue: number) => {
      const intent = await recordIntent(ledger, comment(issue));
      return (await reconcileEffect(ledger, intent.effectId, { verifiers: createVerifierRegistry([verifier]) })).result;
    };
    expect(await run(make(true, { result: 'present', reason: 'marker-match', complete: true }), 1)).toMatchObject({ exitCode: 0, verification: { result: 'present', verifier: { version: '1.2.3' } } });
    expect(await run(make(true, { result: 'absent', reason: 'complete-query-no-match', complete: true }), 2)).toMatchObject({ exitCode: 3, verification: { result: 'absent' } });
    expect(await run(make(false, { result: 'absent', reason: 'complete-query-no-match', complete: true }), 3)).toMatchObject({ exitCode: 4, verification: { reason: 'verifier-cannot-report-absent' } });
    expect(await run(make(true, { result: 'absent', reason: 'complete-query-no-match', complete: false }), 4)).toMatchObject({ exitCode: 4, verification: { reason: 'paging-incomplete' } });
    expect(await run(make(true, { result: 'absent', reason: 'heuristic-match', complete: true }), 5)).toMatchObject({ exitCode: 4, verification: { reason: 'malformed-response' } });
    expect(await run({ ...make(true, null), verify: async () => { throw new Error('boom'); } }, 6)).toMatchObject({ exitCode: 4, verification: { reason: 'server-error' } });
    expect(await run(make(true, { result: 'unknown', reason: 'rate-limited', complete: false }), 7)).toMatchObject({ exitCode: 4, verification: { reason: 'rate-limited' } });
    expect((await verifyLedger(ledger, { sink: null })).ok).toBe(true);
  });

  it('EFF-LED-11 the d13.review/v1 derivation records a review continuation whose ID equals reviewDigest', async () => {
    const { reviewDigest } = await import('../../../src/decision/review/validate.js');
    const ledger = h.ledger({ scope: { ...scope, subsystem: 'review' } });
    const context = { reviewId: 'review-0001', continuationId: 'continuation-0001', proposalVersion: 1 };
    const receipt = await recordIntent(ledger, { kind: 'decision.review.continuation', target: 'review:local/example/repo/review-0001', context, payloadDigest: payloadDigest('action') });
    expect(receipt.idDerivation).toBe('d13.review/v1');
    expect(receipt.effectId).toBe(reviewDigest(context));
    expect(await lookupEffect(ledger, receipt.effectId)).toMatchObject({ status: 'intent', exitCode: 4 });
  });
});

describe('schema conformance and storage', () => {
  it('EFF-LED-12 every segment line, statement, keyring and checkpoint written validates against the E1 schemas', async () => {
    const ledger = h.ledger();
    const intent = await recordIntent(ledger, comment());
    await recordOutcome(ledger, intent.effectId, { phase: 'completed', payloadDigest: comment().payloadDigest, verification: present() });
    await reconcileEffect(ledger, intent.effectId);
    await recordIntent(h.ledger({ writer: 'writer-b' }), comment(20));
    await writeCheckpoint(ledger);
    for (const writer of ['writer-a', 'writer-b']) {
      for (const line of segmentLines(writer)) {
        expect(isEffectSchemaValid('record', line)).toBe(true);
        expect(isEffectSchemaValid('record', decode(line))).toBe(true);
      }
    }
    expect(isEffectSchemaValid('keyring', JSON.parse(readFileSync(join(ledgerRoot(), 'keyring.json'), 'utf8')))).toBe(true);
    expect(isEffectSchemaValid('checkpoint', JSON.parse(readFileSync(join(ledgerRoot(), 'checkpoints', '0.json'), 'utf8')))).toBe(true);
    expect(isEffectSchemaValid('checkpoint', h.sink.published[0])).toBe(true);
    const verification = await verifyLedger(ledger);
    expect(verification).toMatchObject({ ok: true, exitCode: 0, records: 4, checkpoint: { sequence: 0, source: 'sink' } });
  });

  it('EFF-LED-13 directories are 0700, files 0600, and index names hide plaintext effect IDs', async () => {
    const ledger = h.ledger();
    const intent = await recordIntent(ledger, comment());
    await writeCheckpoint(ledger);
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const file = join(dir, name);
      return statSync(file).isDirectory() ? [file, ...walk(file)] : [file];
    });
    for (const file of walk(ledgerRoot())) {
      const mode = statSync(file).mode & 0o777;
      expect(mode, file).toBe(statSync(file).isDirectory() ? 0o700 : 0o600);
    }
    const names = readdirSync(join(ledgerRoot(), 'index'));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(names.join('')).not.toContain(intent.effectId);
  });

  it('EFF-LED-14 an unavailable external artifact root fails every operation with exit 7 and writes nothing under .aiwg', async () => {
    writeFileSync(join(h.dir, '.aiwg-location'), join(h.dir, 'detached-corpus'));
    const ledger = h.ledger();
    const id = effectId({ scope, kind: comment().kind, target: comment().target, context: comment().context });
    const operations: Array<Promise<unknown>> = [
      recordIntent(ledger, comment()),
      recordOutcome(ledger, id, { phase: 'failed', payloadDigest: comment().payloadDigest, failure: { reason: 'target-rejected' } }),
      reconcileEffect(ledger, id),
      lookupEffect(ledger, id),
      verifyLedger(ledger),
      writeCheckpoint(ledger),
    ];
    for (const operation of operations) {
      const error = await operation.then(() => null, (caught: unknown) => caught) as EffectLedgerError;
      expect(error).toBeInstanceOf(EffectLedgerError);
      expect(error.exitCode).toBe(EFFECT_EXIT_CODES.artifactRootUnavailable);
      expect(error.message).toMatch(/Reconnect or attach the external corpus/);
    }
    expect(existsSync(join(h.dir, '.aiwg'))).toBe(false);
    expect(existsSync(join(h.dir, 'detached-corpus'))).toBe(false);
    mkdirSync(join(h.dir, 'detached-corpus'));
    await recordIntent(ledger, comment());
    expect(existsSync(join(h.dir, 'detached-corpus', 'effects', 'delivery', 'keyring.json'))).toBe(true);
    expect(existsSync(join(h.dir, '.aiwg'))).toBe(false);
  });

  it('EFF-LED-15 writes need a key provider and a key that matches the active keyring key', async () => {
    const readOnly = openEffectLedger({ projectDir: h.dir, scope, writer: 'writer-a', clock: h.clock.read, sink: h.sink });
    await expectLedgerError(recordIntent(readOnly, comment()), 'key-unavailable', 1);
    await recordIntent(h.ledger(), comment());
    const stranger = openEffectLedger({ projectDir: h.dir, scope, writer: 'writer-z', keyProvider: staticKeyProvider(testKey('stranger')), clock: h.clock.read, sink: h.sink });
    await expectLedgerError(recordIntent(stranger, comment(40)), 'key-unavailable', 1, 'key-not-active');
  });
});
