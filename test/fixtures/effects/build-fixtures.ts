/**
 * Deterministic builder for the effect ledger v1 contract fixtures and identity vectors.
 *
 *   npx tsx test/fixtures/effects/build-fixtures.ts --write   # regenerate
 *   npx tsx test/fixtures/effects/build-fixtures.ts --check   # fail if stale
 *
 * The signing keys are test-only Ed25519 keys derived from public labels. They
 * never leave this builder: fixtures contain public keys, digests and signatures
 * only. Ed25519 is deterministic, so the output is byte-stable.
 *
 * @see docs/contracts/effect-ledger.v1.md
 */
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson, dssePae } from '../../../src/security/artifact-trust.js';
import { reviewDigest } from '../../../src/decision/review/validate.js';

export const FIXTURE_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const STATEMENT_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
export const CHECKPOINT_PAYLOAD_TYPE = 'application/vnd.aiwg.effect-checkpoint.v1+json';
export const ROTATION_PAYLOAD_TYPE = 'application/vnd.aiwg.effect-key-rotation.v1+json';
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const sha256Hex = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = (bytes: string | Uint8Array) => `sha256:${sha256Hex(bytes)}`;
const clone = <T>(value: T): T => structuredClone(value);

/** Unpadded lowercase RFC 4648 base32, most significant bit first. */
export function base32Lower(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function effectIdV1(input: JsonObject): string {
  return `eff1_${base32Lower(createHash('sha256').update(canonicalJson(input)).digest())}`;
}

interface FixtureKey { label: string; privateKey: KeyObject; publicKey: string; keyid: string }

function fixtureKey(label: string): FixtureKey {
  const seed = createHash('sha256').update(`aiwg-effect-contract-fixture-key/${label}`).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return { label, privateKey, publicKey: der.toString('base64'), keyid: digest(der) };
}

const signPae = (key: FixtureKey, payloadType: string, payload: Uint8Array) =>
  sign(null, dssePae(payloadType, payload), key.privateKey).toString('base64');

const scopeDelivery = { tenant: 'local', project: 'example/repo', subsystem: 'delivery' };
const scopeReview = { tenant: 'local', project: 'example/repo', subsystem: 'review' };
const scopeCustom = { tenant: 'local', project: 'example/repo', subsystem: 'custom' };

const EFFECT_VECTOR_INPUTS: Array<{ name: string; input: JsonObject }> = [
  { name: 'tracker-comment-cycle', input: { v: 1, scope: scopeDelivery, kind: 'tracker.comment', target: 'gitea:example/repo#12', context: { issue: 12, action: 'cycle-comment', cycle: 1 } } },
  { name: 'tracker-pr-merged', input: { v: 1, scope: scopeDelivery, kind: 'tracker.pr.merged', target: 'gitea:example/repo#34', context: {} } },
  { name: 'git-tag', input: { v: 1, scope: scopeDelivery, kind: 'git.tag', target: 'git-tag:v1.0.0', context: {} } },
  { name: 'file-digest', input: { v: 1, scope: scopeDelivery, kind: 'file.digest', target: `file:docs/example.md@sha256:${sha256Hex('example\n')}`, context: {} } },
  { name: 'key-order-and-unicode', input: { v: 1, scope: scopeCustom, kind: 'x.example.notify', target: 'x-example:channel/general', context: { beta: 2, alpha: true, Zeta: 'café' } } },
];

const D13_VECTOR_INPUTS = [
  { name: 'review-proposal-1', input: { reviewId: 'review-0001', continuationId: 'continuation-0001', proposalVersion: 1 } },
  { name: 'review-proposal-2', input: { reviewId: 'review-0001', continuationId: 'continuation-0001', proposalVersion: 2 } },
];

function identityVectors() {
  return {
    schemaVersion: 'aiwg.effect.identity-vectors.v1',
    canonicalizer: 'src/security/artifact-trust.ts#canonicalJson',
    effectIds: EFFECT_VECTOR_INPUTS.map(({ name, input }) => {
      const canonical = canonicalJson(input);
      return { name, derivation: 'aiwg.effect/v1', input, canonical, sha256: sha256Hex(canonical), expected: effectIdV1(input) };
    }),
    d13ReviewIds: D13_VECTOR_INPUTS.map(({ name, input }) => {
      const canonical = canonicalJson(input);
      return { name, derivation: 'd13.review/v1', input, canonical, expected: reviewDigest(input) };
    }),
  };
}

const vectorInput = (name: string) => EFFECT_VECTOR_INPUTS.find(item => item.name === name)!.input;

interface PredicateInput {
  vector: string;
  phase: string;
  writer: string;
  seq: number;
  prev: string | null;
  recordedAt: string;
  payload: string;
  extra?: JsonObject;
  links?: JsonObject;
}

function statementFor(item: PredicateInput): JsonObject {
  const input = vectorInput(item.vector);
  const target = input.target as string;
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: target, digest: { sha256: sha256Hex(target) } }],
    predicateType: 'https://aiwg.io/attestations/effect/v1',
    predicate: {
      schemaVersion: 'aiwg.effect.record.v1',
      effectId: effectIdV1(input),
      idDerivation: 'aiwg.effect/v1',
      scope: input.scope,
      kind: input.kind,
      target,
      context: input.context,
      phase: item.phase,
      payloadDigest: digest(item.payload),
      writer: item.writer,
      seq: item.seq,
      prev: item.prev,
      recordedAt: item.recordedAt,
      ...(item.extra ?? {}),
      links: item.links ?? {},
    },
  };
}

function lineFor(statement: JsonObject, key: FixtureKey, recordHash?: string): JsonObject {
  const payload = Buffer.from(canonicalJson(statement), 'utf8');
  const predicate = statement.predicate as JsonObject;
  return {
    schemaVersion: 'aiwg.effect.segment-line.v1',
    writer: predicate.writer,
    seq: predicate.seq,
    recordHash: recordHash ?? digest(dssePae(STATEMENT_PAYLOAD_TYPE, payload)),
    envelope: {
      payloadType: STATEMENT_PAYLOAD_TYPE,
      payload: payload.toString('base64'),
      signatures: [{ keyid: key.keyid, sig: signPae(key, STATEMENT_PAYLOAD_TYPE, payload) }],
    },
  };
}

function tombstoneFor(original: JsonObject, originalLine: JsonObject, originalKey: FixtureKey, purgedAt: string): JsonObject {
  const predicate = original.predicate as JsonObject;
  const subject = (original.subject as JsonObject[])[0];
  const { target: _target, context: _context, verification: _verification, failure: _failure, ...kept } = predicate;
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `aiwg-effect:${predicate.effectId as string}`, digest: subject.digest }],
    predicateType: 'https://aiwg.io/attestations/effect/v1',
    predicate: {
      ...kept,
      phase: 'tombstone',
      tombstone: {
        originalRecordHash: originalLine.recordHash,
        originalKeyid: originalKey.keyid,
        originalPhase: predicate.phase,
        purgedAt,
        retentionPolicy: 'decision-lifecycle/v1#receipt',
      },
    },
  };
}

const presentVerification = (kind: string, reason: string, checkedAt: string, evidence: string): JsonObject => ({
  verifier: { kind, version: '1.0.0', canReportAbsent: true },
  result: 'present', reason, complete: true, checkedAt, evidenceDigest: digest(evidence),
});

/** Every fixture file, keyed by path relative to test/fixtures/effects. */
export function buildEffectFixtures(): Map<string, string> {
  const keyA = fixtureKey('a');
  const keyB = fixtureKey('b');
  const files = new Map<string, string>();
  const put = (file: string, value: unknown) => files.set(file, `${JSON.stringify(value, null, 2)}\n`);

  // Writer A: a verified tracker comment, then an unresolved-then-resolved PR merge (key B era).
  const a0 = statementFor({ vector: 'tracker-comment-cycle', phase: 'intent', writer: 'writer-a', seq: 0, prev: null,
    recordedAt: '2026-09-20T10:00:00Z', payload: 'fixture cycle comment body\n',
    links: { toolCallId: 'toolu-fixture-0001', traceId: sha256Hex('trace').slice(0, 32), spanId: sha256Hex('span').slice(0, 16) } });
  const a0Line = lineFor(a0, keyB);
  const a1 = statementFor({ vector: 'tracker-comment-cycle', phase: 'completed', writer: 'writer-a', seq: 1, prev: a0Line.recordHash as string,
    recordedAt: '2026-09-20T10:00:05Z', payload: 'fixture cycle comment body\n',
    extra: { verification: presentVerification('tracker.comment', 'marker-match', '2026-09-20T10:00:04Z', 'comment 4401 body digest') } });
  const a1Line = lineFor(a1, keyB);

  const reconciledUnknown = statementFor({ vector: 'tracker-pr-merged', phase: 'reconciled', writer: 'writer-a', seq: 3, prev: digest('writer-a seq 2 placeholder'),
    recordedAt: '2026-09-20T11:00:00Z', payload: 'merge request for #34\n',
    extra: { verification: { verifier: { kind: 'tracker.pr.merged', version: '1.0.0', canReportAbsent: true }, result: 'unknown', reason: 'rate-limited', complete: false, checkedAt: '2026-09-20T10:59:59Z' } },
    links: { operatorDecisionEventId: reviewDigest({ reviewId: 'review-0001', sequence: 4, schema: 'operator-decision.aiwg.io/v1' }) } });

  // Writer B: records signed with key A before rotation, purged to tombstones after it.
  const b0Original = statementFor({ vector: 'file-digest', phase: 'intent', writer: 'writer-b', seq: 0, prev: null,
    recordedAt: '2026-09-10T09:00:00Z', payload: 'example\n' });
  const b0OriginalLine = lineFor(b0Original, keyA);
  const b1Original = statementFor({ vector: 'file-digest', phase: 'completed', writer: 'writer-b', seq: 1, prev: b0OriginalLine.recordHash as string,
    recordedAt: '2026-09-10T09:00:02Z', payload: 'example\n',
    extra: { verification: presentVerification('file.digest', 'digest-match', '2026-09-10T09:00:01Z', 'example\n') } });
  const b1OriginalLine = lineFor(b1Original, keyA);
  const b0Tomb = tombstoneFor(b0Original, b0OriginalLine, keyA, '2026-09-22T00:00:00Z');
  const b1Tomb = tombstoneFor(b1Original, b1OriginalLine, keyA, '2026-09-22T00:00:00Z');
  const b0Line = lineFor(b0Tomb, keyB, b0OriginalLine.recordHash as string);
  const b1Line = lineFor(b1Tomb, keyB, b1OriginalLine.recordHash as string);

  const failed = statementFor({ vector: 'git-tag', phase: 'failed', writer: 'writer-c', seq: 1, prev: digest('writer-c seq 0 placeholder'),
    recordedAt: '2026-09-20T12:00:00Z', payload: 'tag v1.0.0 at commit\n',
    extra: { failure: { reason: 'target-rejected', evidenceDigest: digest('remote rejected tag push') } } });

  const d13Input = D13_VECTOR_INPUTS[0].input;
  const d13Intent: JsonObject = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'review:local/example/repo/review-0001', digest: { sha256: sha256Hex('review:local/example/repo/review-0001') } }],
    predicateType: 'https://aiwg.io/attestations/effect/v1',
    predicate: {
      schemaVersion: 'aiwg.effect.record.v1', effectId: reviewDigest(d13Input), idDerivation: 'd13.review/v1',
      scope: scopeReview, kind: 'decision.review.continuation', target: 'review:local/example/repo/review-0001',
      context: d13Input, phase: 'intent', payloadDigest: digest('approved continuation action digest'),
      writer: 'writer-r', seq: 0, prev: null, recordedAt: '2026-09-20T13:00:00Z',
      links: { operatorDecisionEventId: reviewDigest({ reviewId: 'review-0001', sequence: 3, schema: 'operator-decision.aiwg.io/v1' }) },
    },
  };

  put('valid/record.segment-a-0.intent.json', a0Line);
  put('valid/record.segment-a-1.completed.json', a1Line);
  put('valid/record.segment-b-0.tombstone.json', b0Line);
  put('valid/record.segment-b-1.tombstone.json', b1Line);
  put('valid/record.statement.intent.json', a0);
  put('valid/record.statement.completed.json', a1);
  put('valid/record.statement.reconciled.json', reconciledUnknown);
  put('valid/record.statement.failed.json', failed);
  put('valid/record.statement.tombstone.json', b1Tomb);
  put('valid/record.statement.d13-intent.json', d13Intent);

  const rotationBody = {
    schemaVersion: 'aiwg.effect.key-rotation.v1', sequence: 1, from: keyA.keyid, to: keyB.keyid,
    effectiveAt: '2026-09-15T00:00:00Z', reason: 'scheduled',
  };
  const rotationBytes = Buffer.from(canonicalJson(rotationBody), 'utf8');
  const keyring = {
    schemaVersion: 'aiwg.effect.keyring.v1',
    scope: scopeDelivery,
    keys: [
      { keyid: keyA.keyid, algorithm: 'ed25519', publicKey: keyA.publicKey, validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-09-15T00:00:00Z', status: 'retired' },
      { keyid: keyB.keyid, algorithm: 'ed25519', publicKey: keyB.publicKey, validFrom: '2026-09-15T00:00:00Z', status: 'active' },
    ],
    rotations: [{
      ...rotationBody,
      signatures: [
        { role: 'prior', keyid: keyA.keyid, sig: signPae(keyA, ROTATION_PAYLOAD_TYPE, rotationBytes) },
        { role: 'successor', keyid: keyB.keyid, sig: signPae(keyB, ROTATION_PAYLOAD_TYPE, rotationBytes) },
      ],
    }],
  };
  put('valid/keyring.rotated.json', keyring);

  const writers = [
    { writer: 'writer-a', segment: 'segments/writer-a.jsonl', count: 2, headHash: a1Line.recordHash },
    { writer: 'writer-b', segment: 'segments/writer-b.jsonl', count: 2, headHash: b1Line.recordHash },
  ];
  const checkpointBody = {
    schemaVersion: 'aiwg.effect.checkpoint.v1', scope: scopeDelivery, sequence: 0, createdAt: '2026-09-22T00:05:00Z',
    writers, root: digest(canonicalJson(writers)), keyringDigest: digest(canonicalJson(keyring)), previousCheckpoint: null,
  };
  const checkpoint = {
    ...checkpointBody,
    signatures: [{ keyid: keyB.keyid, sig: signPae(keyB, CHECKPOINT_PAYLOAD_TYPE, Buffer.from(canonicalJson(checkpointBody), 'utf8')) }],
  };
  put('valid/checkpoint.initial.json', checkpoint);

  const a1Predicate = a1.predicate as JsonObject;
  const reconciledPredicate = reconciledUnknown.predicate as JsonObject;
  const present = { schemaVersion: 'aiwg.effect.verifier-result.v1', effectId: a1Predicate.effectId, kind: 'tracker.comment', verification: a1Predicate.verification, exitCode: 0 };
  const unknown = { schemaVersion: 'aiwg.effect.verifier-result.v1', effectId: reconciledPredicate.effectId, kind: 'tracker.pr.merged', verification: reconciledPredicate.verification, exitCode: 4 };
  const absent = {
    schemaVersion: 'aiwg.effect.verifier-result.v1', effectId: effectIdV1(vectorInput('git-tag')), kind: 'git.tag',
    verification: { verifier: { kind: 'git.tag', version: '1.0.0', canReportAbsent: true }, result: 'absent', reason: 'complete-query-no-match', complete: true, checkedAt: '2026-09-20T12:00:01Z' },
    exitCode: 3,
  };
  put('valid/verifier-result.present.json', present);
  put('valid/verifier-result.absent.json', absent);
  put('valid/verifier-result.unknown.json', unknown);

  // Negative fixtures: each is one mutation of a valid fixture.
  const mutate = <T>(value: T, change: (copy: any) => void): T => { const copy = clone(value); change(copy); return copy; };
  put('invalid/record.segment-line.missing-keyid.json', mutate(a0Line, copy => { delete copy.envelope.signatures[0].keyid; }));
  put('invalid/record.statement.unknown-phase.json', mutate(a0, copy => { copy.predicate.phase = 'started'; }));
  put('invalid/record.statement.raw-body.json', mutate(a0, copy => { copy.predicate.body = 'fixture comment text'; }));
  put('invalid/record.statement.malformed-effect-id-uppercase.json', mutate(a0, copy => { copy.predicate.effectId = `eff1_${copy.predicate.effectId.slice(5).toUpperCase()}`; }));
  put('invalid/record.statement.malformed-effect-id-padded.json', mutate(a0, copy => { copy.predicate.effectId = `${copy.predicate.effectId}====`; }));
  put('invalid/record.statement.malformed-effect-id-trailing-bits.json', mutate(a0, copy => {
    const id: string = copy.predicate.effectId; copy.predicate.effectId = `${id.slice(0, -1)}${id.endsWith('a') ? 'b' : 'r'}`;
  }));
  put('invalid/record.statement.d13-derivation-mismatch.json', mutate(d13Intent, copy => { copy.predicate.effectId = a0.predicate && (a0.predicate as JsonObject).effectId; }));
  put('invalid/record.statement.unknown-kind.json', mutate(a0, copy => { copy.predicate.kind = 'shell.exec'; }));
  put('invalid/record.statement.completed-without-present.json', mutate(a1, copy => { copy.predicate.verification = clone(reconciledPredicate.verification); }));
  put('invalid/record.statement.tombstone-with-target.json', mutate(b1Tomb, copy => { copy.predicate.target = 'file:docs/example.md'; }));
  put('invalid/checkpoint.missing-root.json', mutate(checkpoint, copy => { delete copy.root; }));
  put('invalid/keyring.rotation-not-signed-by-prior.json', mutate(keyring, copy => {
    copy.rotations[0].signatures = copy.rotations[0].signatures.filter((entry: { role: string }) => entry.role !== 'prior');
  }));
  put('invalid/verifier-result.heuristic-absent.json', mutate(absent, copy => { copy.verification.reason = 'heuristic-match'; }));
  put('invalid/verifier-result.absent-incomplete.json', mutate(absent, copy => { copy.verification.complete = false; }));
  put('invalid/verifier-result.absent-cannot-report-absent.json', mutate(absent, copy => { copy.verification.verifier.canReportAbsent = false; }));
  put('invalid/verifier-result.exit-code-mismatch.json', mutate(unknown, copy => { copy.exitCode = 3; }));

  put('vectors/identity.v1.json', identityVectors());
  return files;
}

function main(argv: string[]): number {
  const files = buildEffectFixtures();
  if (argv.includes('--write')) {
    for (const [file, body] of files) {
      mkdirSync(path.dirname(path.join(FIXTURE_ROOT, file)), { recursive: true });
      writeFileSync(path.join(FIXTURE_ROOT, file), body);
    }
    console.log(`Wrote ${files.size} effect ledger fixtures`);
    return 0;
  }
  const stale = [...files].filter(([file, body]) => {
    try { return readFileSync(path.join(FIXTURE_ROOT, file), 'utf8') !== body; } catch { return true; }
  }).map(([file]) => file);
  if (stale.length) {
    console.error(`Stale effect ledger fixtures: ${stale.join(', ')}`);
    return 1;
  }
  console.log(`${files.size} effect ledger fixtures are current`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
