/**
 * Read-side helpers shared by lookup, verification and purge: the keyring,
 * decoded segments, and the per-line checks that bind a signed record to its
 * segment position, chain, scope, identity and key window.
 */

import { readFile } from 'node:fs/promises';
import { canonicalJson } from '../security/artifact-trust.js';
import { integrityError } from './errors.js';
import { checkSignature } from './keyring.js';
import {
  decodeSegmentLine,
  effectIdBindingHolds,
  recordHashFor,
  signedAt,
  subjectBindingHolds,
  type DecodedLine,
} from './records.js';
import { listWriters, readSegment, type LedgerPaths } from './store.js';
import type { EffectKeyring, EffectScope } from './types.js';
import { STATEMENT_PAYLOAD_TYPE } from './types.js';

/** The stored keyring, or null before the first write. Not verified here. */
export async function readKeyring(paths: LedgerPaths): Promise<unknown | null> {
  let raw: string;
  try { raw = await readFile(paths.keyring, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try { return JSON.parse(raw) as unknown; } catch { throw integrityError('keyring-malformed'); }
}

export interface ReadLine {
  writer: string;
  index: number;
  text: string;
  decoded?: DecodedLine;
  failure?: string;
}

export interface ReadSegment {
  writer: string;
  torn: boolean;
  lines: ReadLine[];
}

export async function readWriterSegment(paths: LedgerPaths, writer: string): Promise<ReadSegment | null> {
  const segment = await readSegment(paths, writer);
  if (!segment) return null;
  return {
    writer,
    torn: segment.torn,
    lines: segment.lines.map((text, index) => {
      const decoded = decodeSegmentLine(text);
      return 'failure' in decoded ? { writer, index, text, failure: decoded.failure } : { writer, index, text, decoded };
    }),
  };
}

export async function readAllSegments(paths: LedgerPaths): Promise<ReadSegment[]> {
  const out: ReadSegment[] = [];
  for (const writer of await listWriters(paths)) {
    const segment = await readWriterSegment(paths, writer);
    if (segment) out.push(segment);
  }
  return out;
}

/**
 * Every check that binds one decoded line to its place. Returns the failure
 * reasons (empty when the line verifies).
 */
export function lineFailures(
  keyring: EffectKeyring,
  scope: EffectScope,
  writer: string,
  index: number,
  decoded: DecodedLine,
  previousHash: string | null,
): string[] {
  const failures: string[] = [];
  const { line, payload, statement } = decoded;
  const predicate = statement.predicate;
  if (line.writer !== writer || predicate.writer !== writer) failures.push('writer-mismatch');
  if (line.seq !== index || predicate.seq !== index) failures.push('seq-mismatch');
  if (predicate.prev !== previousHash) failures.push('chain-broken');
  if (canonicalJson(predicate.scope) !== canonicalJson(scope)) failures.push('scope-mismatch');
  if (!subjectBindingHolds(statement)) failures.push('subject-mismatch');
  if (!effectIdBindingHolds(predicate)) failures.push('effect-id-mismatch');
  if (predicate.phase === 'tombstone') {
    if (predicate.tombstone!.originalRecordHash !== line.recordHash) failures.push('record-hash-mismatch');
    if (!keyring.keys.some(key => key.keyid === predicate.tombstone!.originalKeyid)) failures.push('unknown-keyid');
  } else if (recordHashFor(payload) !== line.recordHash) {
    failures.push('record-hash-mismatch');
  }
  const at = signedAt(predicate);
  for (const signature of line.envelope.signatures) {
    const check = checkSignature(keyring, signature.keyid, signature.sig, STATEMENT_PAYLOAD_TYPE, payload, at);
    if (check !== 'ok') { failures.push(check); break; }
  }
  return [...new Set(failures)];
}

/** Merge order for readers: `(recordedAt, writer, seq)`. */
export function mergeOrder(a: DecodedLine, b: DecodedLine): number {
  const left = a.statement.predicate;
  const right = b.statement.predicate;
  const time = Date.parse(left.recordedAt) - Date.parse(right.recordedAt);
  if (time !== 0) return time;
  if (left.writer !== right.writer) return left.writer < right.writer ? -1 : 1;
  return left.seq - right.seq;
}
