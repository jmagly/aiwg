/**
 * Signed checkpoints over every writer's segment head, published first to the
 * independent sink and then written locally.
 *
 * @see docs/contracts/effect-ledger.v1.md "Storage layout"
 */

import { join } from 'node:path';
import { canonicalJson } from '../security/artifact-trust.js';
import { publishExclusive } from '../storage/protected-files.js';
import type { CheckpointSink, CheckpointSinkReceipt } from './checkpoint-sinks.js';
import { EffectLedgerError, integrityError, usageError } from './errors.js';
import { sha256Digest } from './identity.js';
import { activeKey, assertKeyring, keyringDigest, keyValidAt } from './keyring.js';
import type { EffectLedger } from './ledger.js';
import { readAllSegments, readKeyring } from './reader.js';
import { assertEffectSchema } from './schema.js';
import { ensureLedgerDirectories, withLedgerLock } from './store.js';
import { CHECKPOINT_PAYLOAD_TYPE, CHECKPOINT_SCHEMA_VERSION, type EffectCheckpoint, type EffectCheckpointBody } from './types.js';
import { checkpointDigest, readLocalCheckpoints, verifyLedger } from './verify.js';

export interface WriteCheckpointResult {
  checkpoint: EffectCheckpoint;
  digest: string;
  sink: CheckpointSinkReceipt;
}

/**
 * Checkpoint the ledger. The ledger must verify first (against the previous
 * checkpoint), so a checkpoint never anchors a truncated or edited ledger.
 */
export async function writeCheckpoint(ledger: EffectLedger, options: { sink?: CheckpointSink } = {}): Promise<WriteCheckpointResult> {
  const sink = options.sink ?? ledger.sink;
  const paths = ledger.paths();
  await ensureLedgerDirectories(paths);
  const key = await ledger.signingKey();
  return withLedgerLock(paths, 'checkpoint', ledger.lockTimeoutMs, async () => {
    const verification = await verifyLedger(ledger, { sink });
    if (!verification.ok) throw integrityError(verification.failures[0].reason, 'Effect ledger failed verification; refusing to checkpoint');
    if (verification.warnings.includes('checkpoint-sink-unreadable')) {
      throw new EffectLedgerError('internal', 'Checkpoint sink is unavailable; no checkpoint was written', 'checkpoint-sink-unavailable');
    }
    const keyring = await readKeyring(paths);
    assertKeyring(keyring, ledger.scope);
    const createdAt = ledger.now();
    const active = activeKey(keyring);
    if (active.keyid !== key.keyid || !keyValidAt(active, createdAt)) {
      throw new EffectLedgerError('key-unavailable', 'The loaded signing key is not the active ledger key at this time', 'key-not-active');
    }
    const segments = await readAllSegments(paths);
    const writers = segments.filter(segment => segment.lines.length > 0).map(segment => ({
      writer: segment.writer,
      segment: `segments/${segment.writer}.jsonl`,
      count: segment.lines.length,
      headHash: segment.lines.at(-1)!.decoded!.line.recordHash,
    }));
    if (!writers.length) throw usageError('The effect ledger has no records to checkpoint', 'nothing-to-checkpoint');
    const local = (await readLocalCheckpoints(paths)).at(-1)?.value as EffectCheckpoint | undefined;
    const remote = await sink.latest(ledger.scope);
    const previous = [local, remote].filter((value): value is EffectCheckpoint => !!value)
      .sort((a, b) => b.sequence - a.sequence)[0];
    const body: EffectCheckpointBody = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      scope: structuredClone(ledger.scope),
      sequence: previous ? previous.sequence + 1 : 0,
      createdAt,
      writers,
      root: sha256Digest(canonicalJson(writers)),
      keyringDigest: keyringDigest(keyring),
      previousCheckpoint: previous ? checkpointDigest(previous) : null,
    };
    const checkpoint: EffectCheckpoint = {
      ...body,
      signatures: [{ keyid: key.keyid, sig: key.signPae(CHECKPOINT_PAYLOAD_TYPE, Buffer.from(canonicalJson(body), 'utf8')) }],
    };
    assertEffectSchema('checkpoint', checkpoint);
    const receipt = await sink.publish(checkpoint);
    const written = await publishExclusive(paths.checkpoints, join(paths.checkpoints, `${checkpoint.sequence}.json`),
      `${JSON.stringify(checkpoint, null, 2)}\n`, 'checkpoint');
    if (!written) throw integrityError('checkpoint-sequence-exists');
    return { checkpoint, digest: checkpointDigest(checkpoint), sink: receipt };
  });
}
