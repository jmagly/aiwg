/**
 * Effect record construction and decoding: in-toto Statement v1 predicates,
 * DSSE envelopes, segment lines and record hashes.
 *
 * Verifiers check the exact decoded payload bytes; they never reserialize a
 * statement before signature verification.
 *
 * @see docs/contracts/effect-ledger.v1.md "Envelope and record"
 */

import { canonicalJson, decodeBase64, dssePae } from '../security/artifact-trust.js';
import { integrityError } from './errors.js';
import { effectIdDerivation, sha256Digest } from './identity.js';
import type { LedgerSigningKey } from './keys.js';
import { assertDigestOnly } from './redaction.js';
import { assertEffectSchema, isEffectSchemaValid } from './schema.js';
import {
  EFFECT_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  SEGMENT_LINE_SCHEMA_VERSION,
  STATEMENT_PAYLOAD_TYPE,
  type EffectPredicate,
  type EffectSegmentLine,
  type EffectStatement,
} from './types.js';

const sha256Hex = (value: string) => sha256Digest(value).slice('sha256:'.length);

/** Wrap a predicate in a Statement whose single subject is the target reference and its digest. */
export function statementFor(predicate: EffectPredicate): EffectStatement {
  const target = predicate.target;
  if (typeof target !== 'string') throw integrityError('statement-target-missing');
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: target, digest: { sha256: sha256Hex(target) } }],
    predicateType: EFFECT_PREDICATE_TYPE,
    predicate,
  };
}

/** `"sha256:"` plus hex SHA-256 of the DSSE PAE of exact payload bytes. */
export function recordHashFor(payload: Uint8Array): string {
  return sha256Digest(dssePae(STATEMENT_PAYLOAD_TYPE, payload));
}

/**
 * Validate, scan and sign a statement into a segment line. `recordHash` is the
 * PAE hash of the payload, except for a tombstone, which keeps the original.
 */
export function signSegmentLine(statement: EffectStatement, key: LedgerSigningKey, recordHash?: string): EffectSegmentLine {
  assertDigestOnly(statement);
  assertEffectSchema('record', statement);
  const payload = Buffer.from(canonicalJson(statement), 'utf8');
  const line: EffectSegmentLine = {
    schemaVersion: SEGMENT_LINE_SCHEMA_VERSION,
    writer: statement.predicate.writer,
    seq: statement.predicate.seq,
    recordHash: recordHash ?? recordHashFor(payload),
    envelope: {
      payloadType: STATEMENT_PAYLOAD_TYPE,
      payload: payload.toString('base64'),
      signatures: [{ keyid: key.keyid, sig: key.signPae(STATEMENT_PAYLOAD_TYPE, payload) }],
    },
  };
  assertEffectSchema('record', line);
  return line;
}

export interface DecodedLine {
  line: EffectSegmentLine;
  payload: Buffer;
  statement: EffectStatement;
}

/**
 * Parse one segment line and its statement. Returns a failure reason instead of
 * throwing so the verifier can report every broken line.
 */
export function decodeSegmentLine(text: string): DecodedLine | { failure: string } {
  let line: unknown;
  try { line = JSON.parse(text); } catch { return { failure: 'segment-line-malformed' }; }
  if (!isEffectSchemaValid('record', line) || (line as { envelope?: unknown }).envelope === undefined) return { failure: 'segment-line-schema-invalid' };
  const typed = line as EffectSegmentLine;
  let payload: Buffer;
  try { payload = decodeBase64(typed.envelope.payload, 'payload'); } catch { return { failure: 'segment-line-malformed' }; }
  let statement: unknown;
  try { statement = JSON.parse(payload.toString('utf8')); } catch { return { failure: 'statement-malformed' }; }
  if (canonicalJson(statement) !== payload.toString('utf8')) return { failure: 'statement-not-canonical' };
  if (!isEffectSchemaValid('record', statement) || (statement as { predicate?: unknown }).predicate === undefined) return { failure: 'statement-schema-invalid' };
  return { line: typed, payload, statement: statement as EffectStatement };
}

/** Recompute a non-tombstone record's ID from its signed identity fields. */
export function effectIdBindingHolds(predicate: EffectPredicate): boolean {
  if (predicate.phase === 'tombstone') return true;
  try {
    return effectIdDerivation(predicate.idDerivation).derive({
      scope: predicate.scope, kind: predicate.kind, target: predicate.target!, context: predicate.context!,
    }) === predicate.effectId;
  } catch { return false; }
}

/** The subject binds the target (or, for a tombstone, the effect ID) to its digest. */
export function subjectBindingHolds(statement: EffectStatement): boolean {
  const [subject] = statement.subject;
  if (statement.predicate.phase === 'tombstone') return subject.name === `aiwg-effect:${statement.predicate.effectId}`;
  return subject.name === statement.predicate.target && subject.digest.sha256 === sha256Hex(subject.name);
}

/** The time a record's signature must fall inside its key window. */
export function signedAt(predicate: EffectPredicate): string {
  return predicate.phase === 'tombstone' ? predicate.tombstone!.purgedAt : predicate.recordedAt;
}
