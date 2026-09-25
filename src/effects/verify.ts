/**
 * Whole-ledger verification: keyring, every segment line (signature, key
 * window, writer and seq binding, chain, record hash, scope, identity), the
 * index/segment agreement, the local checkpoint chain, and the latest
 * checkpoint from the independent sink (truncation and deletion).
 *
 * @see docs/contracts/effect-ledger.v1.md
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../security/artifact-trust.js';
import { exists } from '../storage/protected-files.js';
import type { CheckpointSink } from './checkpoint-sinks.js';
import { EFFECT_EXIT_CODES } from './errors.js';
import { sha256Digest } from './identity.js';
import { checkSignature, keyringFailure } from './keyring.js';
import type { EffectLedger } from './ledger.js';
import { lineFailures, readAllSegments, readKeyring, type ReadSegment } from './reader.js';
import { isEffectSchemaValid } from './schema.js';
import { indexName, listIndexEntries, loadIndexKey, readPending, type LedgerPaths } from './store.js';
import {
  CHECKPOINT_PAYLOAD_TYPE,
  type EffectCheckpoint,
  type EffectCheckpointBody,
  type EffectKeyring,
  type EffectScope,
} from './types.js';

export interface LedgerVerifyFailure {
  reason: string;
  writer?: string;
  seq?: number;
  checkpoint?: number;
}

export interface LedgerVerification {
  ok: boolean;
  exitCode: 0 | 6;
  scope: EffectScope;
  records: number;
  writers: Array<{ writer: string; count: number; headHash: string | null }>;
  checkpoint: { sequence: number; source: 'sink' | 'local'; digest: string } | null;
  failures: LedgerVerifyFailure[];
  warnings: string[];
}

export interface VerifyLedgerOptions {
  /** Checkpoint sink to compare against. Defaults to the ledger's sink; null skips it. */
  sink?: CheckpointSink | null;
  /** Check index/segment agreement. Default true. */
  checkIndex?: boolean;
  /** Host-pinned genesis key IDs. When given, the keyring must descend from one of them. */
  trustedKeyids?: string[];
}

/** `"sha256:"` plus hex SHA-256 of `canonicalJson(checkpoint)`, as used by `previousCheckpoint`. */
export function checkpointDigest(checkpoint: EffectCheckpoint): string {
  return sha256Digest(canonicalJson(checkpoint));
}

export function checkpointBody(checkpoint: EffectCheckpoint): EffectCheckpointBody {
  const { signatures: _signatures, ...body } = checkpoint;
  return body;
}

/**
 * Digests of the keyring as it stood after each rotation (0..n). A checkpoint's
 * `keyringDigest` must equal one of them, so a later keyring can only extend
 * the one the checkpoint anchored, never replace or re-window it.
 */
export function keyringPrefixDigests(keyring: EffectKeyring): string[] {
  const chain = [keyring.keys.find(key => !keyring.rotations.some(rotation => rotation.to === key.keyid))!,
    ...keyring.rotations.map(rotation => keyring.keys.find(key => key.keyid === rotation.to)!)];
  return chain.map((_key, count) => {
    const keys = chain.slice(0, count + 1).map(key => structuredClone(key));
    const last = keys[count];
    if (count < keyring.rotations.length && last.status !== 'revoked') {
      delete last.validUntil;
      last.status = 'active';
    }
    return sha256Digest(canonicalJson({ ...keyring, keys, rotations: keyring.rotations.slice(0, count) }));
  });
}

/** Schema, scope, root, keyring lineage and signature checks for one checkpoint. Returns a failure reason or null. */
export function checkpointFailure(checkpoint: unknown, keyring: EffectKeyring, scope: EffectScope): string | null {
  if (!isEffectSchemaValid('checkpoint', checkpoint)) return 'checkpoint-schema-invalid';
  const value = checkpoint as EffectCheckpoint;
  if (canonicalJson(value.scope) !== canonicalJson(scope)) return 'checkpoint-scope-mismatch';
  const writers = value.writers.map(entry => entry.writer);
  if (writers.some((writer, index) => index > 0 && writers[index - 1] >= writer)) return 'checkpoint-writers-unsorted';
  if (value.writers.some(entry => entry.segment !== `segments/${entry.writer}.jsonl`)) return 'checkpoint-segment-path';
  if (value.root !== sha256Digest(canonicalJson(value.writers))) return 'checkpoint-root-mismatch';
  if (!keyringPrefixDigests(keyring).includes(value.keyringDigest)) return 'checkpoint-keyring-mismatch';
  const payload = Buffer.from(canonicalJson(checkpointBody(value)), 'utf8');
  for (const signature of value.signatures) {
    const check = checkSignature(keyring, signature.keyid, signature.sig, CHECKPOINT_PAYLOAD_TYPE, payload, value.createdAt);
    if (check !== 'ok') return `checkpoint-${check}`;
  }
  return null;
}

export async function readLocalCheckpoints(paths: LedgerPaths): Promise<Array<{ sequence: number; value: unknown }>> {
  let names: string[];
  try { names = await readdir(paths.checkpoints); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const out: Array<{ sequence: number; value: unknown }> = [];
  for (const name of names) {
    const match = /^(0|[1-9][0-9]*)\.json$/.exec(name);
    if (!match) continue;
    let value: unknown;
    try { value = JSON.parse(await readFile(join(paths.checkpoints, name), 'utf8')); } catch { value = null; }
    out.push({ sequence: Number(match[1]), value });
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}

function verifySegments(segments: ReadSegment[], keyring: EffectKeyring, scope: EffectScope, failures: LedgerVerifyFailure[]): number {
  let records = 0;
  for (const segment of segments) {
    if (segment.torn) failures.push({ reason: 'segment-torn', writer: segment.writer, seq: segment.lines.length - 1 });
    let previous: string | null = null;
    for (const read of segment.lines) {
      records += 1;
      if (!read.decoded) {
        failures.push({ reason: read.failure!, writer: segment.writer, seq: read.index });
        previous = null;
        continue;
      }
      for (const reason of lineFailures(keyring, scope, segment.writer, read.index, read.decoded, previous)) {
        failures.push({ reason, writer: segment.writer, seq: read.index });
      }
      previous = read.decoded.line.recordHash;
    }
  }
  return records;
}

async function verifyIndex(paths: LedgerPaths, segments: ReadSegment[], scope: EffectScope, failures: LedgerVerifyFailure[], warnings: string[]): Promise<void> {
  const hasRecords = segments.some(segment => segment.lines.length > 0);
  if (!(await exists(paths.indexKey))) {
    if (hasRecords) failures.push({ reason: 'index-key-missing' });
    return;
  }
  let key: Buffer;
  try { key = await loadIndexKey(paths); } catch { failures.push({ reason: 'index-key-malformed' }); return; }
  let entries: Awaited<ReturnType<typeof listIndexEntries>>;
  try { entries = await listIndexEntries(paths); } catch { failures.push({ reason: 'index-entry-malformed' }); return; }
  const byWriter = new Map(segments.map(segment => [segment.writer, segment]));
  const claimed = new Set<string>();
  for (const { name, entry } of entries) {
    if (name !== indexName(key, scope, entry.effectId, entry.role)) {
      failures.push({ reason: 'index-name-mismatch', writer: entry.writer, seq: entry.seq });
      continue;
    }
    const read = byWriter.get(entry.writer)?.lines[entry.seq];
    if (!read) {
      const pending = await readPending(paths, entry.writer);
      if (pending?.indexName === name) warnings.push(`pending-append:${entry.writer}:${entry.seq}`);
      else failures.push({ reason: 'index-dangling', writer: entry.writer, seq: entry.seq });
      continue;
    }
    const predicate = read.decoded?.statement.predicate;
    const phase = predicate?.phase === 'tombstone' ? predicate.tombstone!.originalPhase : predicate?.phase;
    if (!predicate || predicate.effectId !== entry.effectId || read.decoded!.line.recordHash !== entry.recordHash
      || predicate.payloadDigest !== entry.payloadDigest || phase !== entry.phase
      || (entry.role === 'intent') !== (phase === 'intent')) {
      failures.push({ reason: 'index-segment-mismatch', writer: entry.writer, seq: entry.seq });
      continue;
    }
    claimed.add(`${entry.writer}\0${entry.seq}`);
  }
  for (const segment of segments) {
    for (const read of segment.lines) {
      const predicate = read.decoded?.statement.predicate;
      if (!predicate) continue;
      const phase = predicate.phase === 'tombstone' ? predicate.tombstone!.originalPhase : predicate.phase;
      if ((phase === 'intent' || phase === 'completed' || phase === 'failed') && !claimed.has(`${segment.writer}\0${read.index}`)) {
        failures.push({ reason: 'index-missing', writer: segment.writer, seq: read.index });
      }
    }
  }
}

/**
 * Verify the whole ledger for this scope. Integrity failures are reported, not
 * thrown (exit 6); an unavailable artifact root still throws (exit 7).
 */
export async function verifyLedger(ledger: EffectLedger, options: VerifyLedgerOptions = {}): Promise<LedgerVerification> {
  const paths = ledger.paths();
  const scope = ledger.scope;
  const failures: LedgerVerifyFailure[] = [];
  const warnings: string[] = [];
  const segments = await readAllSegments(paths);
  const writers = segments.map(segment => ({
    writer: segment.writer, count: segment.lines.length, headHash: segment.lines.at(-1)?.decoded?.line.recordHash ?? null,
  }));
  const result = (records: number, checkpoint: LedgerVerification['checkpoint']): LedgerVerification => ({
    ok: failures.length === 0,
    exitCode: failures.length === 0 ? EFFECT_EXIT_CODES.ok : EFFECT_EXIT_CODES.integrity,
    scope, records, writers, checkpoint, failures, warnings,
  });

  const stored = await readKeyring(paths).catch(() => 'malformed' as const);
  const localCheckpoints = await readLocalCheckpoints(paths);
  if (stored === null) {
    if (segments.some(segment => segment.lines.length) || localCheckpoints.length) failures.push({ reason: 'keyring-missing' });
    else warnings.push('ledger-empty');
    return result(0, null);
  }
  const ringFailure = stored === 'malformed' ? 'keyring-malformed' : keyringFailure(stored, scope);
  if (ringFailure) {
    failures.push({ reason: ringFailure });
    return result(0, null);
  }
  const keyring = stored as EffectKeyring;
  if (options.trustedKeyids && !options.trustedKeyids.includes(keyring.keys.find(key => !keyring.rotations.some(rotation => rotation.to === key.keyid))!.keyid)) {
    failures.push({ reason: 'keyring-untrusted' });
  }

  const records = verifySegments(segments, keyring, scope, failures);
  if (options.checkIndex !== false) await verifyIndex(paths, segments, scope, failures, warnings);

  // Local checkpoint chain.
  let local: EffectCheckpoint | null = null;
  for (const [position, entry] of localCheckpoints.entries()) {
    const failure = checkpointFailure(entry.value, keyring, scope);
    if (failure) { failures.push({ reason: failure, checkpoint: entry.sequence }); local = null; continue; }
    const value = entry.value as EffectCheckpoint;
    if (value.sequence !== entry.sequence || entry.sequence !== position) failures.push({ reason: 'checkpoint-sequence-gap', checkpoint: entry.sequence });
    const expectedPrevious = position === 0 ? null : localCheckpoints[position - 1].value as EffectCheckpoint;
    if ((expectedPrevious ? checkpointDigest(expectedPrevious) : null) !== value.previousCheckpoint) failures.push({ reason: 'checkpoint-chain-broken', checkpoint: entry.sequence });
    local = value;
  }

  // Independent sink.
  const sink = options.sink === undefined ? ledger.sink : options.sink;
  let anchor: { value: EffectCheckpoint; source: 'sink' | 'local' } | null = local ? { value: local, source: 'local' } : null;
  if (sink) {
    let remote: EffectCheckpoint | null = null;
    let readable = true;
    try { remote = await sink.latest(scope); } catch { readable = false; warnings.push('checkpoint-sink-unreadable'); }
    if (readable) {
      if (remote) {
        const failure = checkpointFailure(remote, keyring, scope);
        if (failure) failures.push({ reason: `sink-${failure}`, checkpoint: remote.sequence });
        else {
          const sameLocal = localCheckpoints.find(entry => entry.sequence === remote!.sequence)?.value as EffectCheckpoint | undefined;
          if (sameLocal && checkpointDigest(sameLocal) !== checkpointDigest(remote)) failures.push({ reason: 'checkpoint-divergence', checkpoint: remote.sequence });
          if (local && remote.sequence < local.sequence) failures.push({ reason: 'checkpoint-sink-behind', checkpoint: remote.sequence });
          if (!local || remote.sequence > local.sequence) {
            if (!sameLocal) warnings.push('local-checkpoint-behind');
            anchor = { value: remote, source: 'sink' };
          } else if (remote.sequence === local.sequence) {
            anchor = { value: remote, source: 'sink' };
          }
        }
      } else if (localCheckpoints.length) {
        failures.push({ reason: 'checkpoint-sink-missing' });
      }
    }
  }

  if (!anchor) warnings.push('no-checkpoint');
  else {
    const bySegment = new Map(segments.map(segment => [segment.writer, segment]));
    for (const entry of anchor.value.writers) {
      const segment = bySegment.get(entry.writer);
      if (!segment) { failures.push({ reason: 'segment-missing', writer: entry.writer, checkpoint: anchor.value.sequence }); continue; }
      const complete = segment.torn ? segment.lines.length - 1 : segment.lines.length;
      if (complete < entry.count) { failures.push({ reason: 'segment-truncated', writer: entry.writer, checkpoint: anchor.value.sequence }); continue; }
      if (segment.lines[entry.count - 1].decoded?.line.recordHash !== entry.headHash) {
        failures.push({ reason: 'checkpoint-head-mismatch', writer: entry.writer, checkpoint: anchor.value.sequence });
      }
    }
  }
  return result(records, anchor ? { sequence: anchor.value.sequence, source: anchor.source, digest: checkpointDigest(anchor.value) } : null);
}
