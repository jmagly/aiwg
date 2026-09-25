/**
 * D10 retention for effect records. A purge replaces each record's envelope
 * with a signed tombstone that keeps the effect ID, kind, payload digest, chain
 * position, links and subject digest, and names the original record hash and
 * keyid, so the chain still verifies. Target, context and outcome bodies are
 * dropped. The effect-ID index is never deleted, so a purged ID cannot be
 * replayed as new.
 *
 * @see docs/contracts/effect-ledger.v1.md "Retention and tombstones"
 */

import { validateDecisionLifecyclePolicy, type DecisionLifecyclePolicy } from '../decision/lifecycle.js';
import { EffectLedgerError, integrityError, usageError } from './errors.js';
import { assertEffectId } from './identity.js';
import { activeKey, assertKeyring, keyValidAt } from './keyring.js';
import { lookupEffect, type EffectLedger } from './ledger.js';
import { lineFailures, readKeyring, readWriterSegment } from './reader.js';
import { signSegmentLine } from './records.js';
import { ensureLedgerDirectories, replaceSegment, withLedgerLock } from './store.js';
import { EFFECT_PREDICATE_TYPE, IN_TOTO_STATEMENT_TYPE, type EffectPredicate, type EffectStatement } from './types.js';

/** Ledger records bind the D10 `receipt` surface until a dedicated surface exists. */
export const EFFECT_RETENTION_POLICY = 'decision-lifecycle/v1#receipt' as const;

export interface PurgeEffectOptions {
  lifecycle: DecisionLifecyclePolicy;
  /** A D10 legal hold on this effect blocks purge. */
  legalHold?: boolean;
}

export interface PurgeEffectResult {
  effectId: string;
  tombstoned: number;
  alreadyTombstoned: number;
  retentionPolicy: typeof EFFECT_RETENTION_POLICY;
}

const refused = (reason: string, message: string) => new EffectLedgerError('purge-refused', message, reason);

/**
 * Purge one effect's records to tombstones. Refused while a legal hold applies,
 * before the D10 receipt retention has elapsed, and while the intent has no
 * definitive outcome (completed, failed, or a present/absent reconcile).
 */
export async function purgeEffect(ledger: EffectLedger, id: string, options: PurgeEffectOptions): Promise<PurgeEffectResult> {
  assertEffectId(id);
  try { validateDecisionLifecyclePolicy(options?.lifecycle); }
  catch { throw usageError('Purge needs a complete decision-lifecycle/v1 policy', 'lifecycle-invalid'); }
  const rule = options.lifecycle.surfaces.receipt;
  if (options.legalHold) throw refused('legal-hold', 'A legal hold blocks purging this effect');
  const found = await lookupEffect(ledger, id);
  if (!found.found) throw usageError('No records exist for this effect ID', 'effect-not-found');
  const live = found.records.filter(record => record.phase !== 'tombstone');
  const result: PurgeEffectResult = { effectId: id, tombstoned: 0, alreadyTombstoned: found.records.length - live.length, retentionPolicy: EFFECT_RETENTION_POLICY };
  if (!live.length) return result;
  const definitive = found.records.some(record => record.phase === 'completed' || record.phase === 'failed'
    || (record.phase === 'reconciled' && record.verification?.result !== 'unknown')
    || (record.phase === 'tombstone' && (record.tombstone!.originalPhase === 'completed' || record.tombstone!.originalPhase === 'failed')));
  if (!definitive) throw refused('unreconciled-intent', 'An intent without a definitive outcome is never purged; reconcile it first');
  const purgedAt = ledger.now();
  const newest = Math.max(...live.map(record => Date.parse(record.recordedAt)));
  if (Date.parse(purgedAt) - newest < rule.retentionMs) throw refused('retention-not-elapsed', 'The D10 receipt retention period has not elapsed for this effect');

  const paths = ledger.paths();
  await ensureLedgerDirectories(paths);
  const key = await ledger.signingKey();
  const writers = [...new Set(live.map(record => record.writer))].sort();
  for (const writer of writers) {
    await withLedgerLock(paths, `writer-${writer}`, ledger.lockTimeoutMs, async () => {
      const keyring = await readKeyring(paths);
      assertKeyring(keyring, ledger.scope);
      const active = activeKey(keyring);
      if (active.keyid !== key.keyid || !keyValidAt(active, purgedAt)) {
        throw new EffectLedgerError('key-unavailable', 'The loaded signing key is not the active ledger key at this time', 'key-not-active');
      }
      const segment = await readWriterSegment(paths, writer);
      if (!segment || segment.torn) throw integrityError('segment-torn');
      let previous: string | null = null;
      let changed = false;
      const lines = segment.lines.map((read) => {
        if (!read.decoded) throw integrityError(read.failure!);
        const failures = lineFailures(keyring, ledger.scope, writer, read.index, read.decoded, previous);
        if (failures.length) throw integrityError(failures[0]);
        previous = read.decoded.line.recordHash;
        const original = read.decoded.statement;
        if (original.predicate.effectId !== id || original.predicate.phase === 'tombstone') return read.text;
        const { target: _target, context: _context, verification: _verification, failure: _failure, ...kept } = original.predicate;
        const predicate: EffectPredicate = {
          ...kept,
          phase: 'tombstone',
          tombstone: {
            originalRecordHash: read.decoded.line.recordHash,
            originalKeyid: read.decoded.line.envelope.signatures[0].keyid,
            originalPhase: original.predicate.phase as Exclude<EffectPredicate['phase'], 'tombstone'>,
            purgedAt,
            retentionPolicy: EFFECT_RETENTION_POLICY,
          },
        };
        const statement: EffectStatement = {
          _type: IN_TOTO_STATEMENT_TYPE,
          subject: [{ name: `aiwg-effect:${id}`, digest: structuredClone(original.subject[0].digest) }],
          predicateType: EFFECT_PREDICATE_TYPE,
          predicate,
        };
        changed = true;
        result.tombstoned += 1;
        return JSON.stringify(signSegmentLine(statement, key, read.decoded.line.recordHash));
      });
      if (changed) await replaceSegment(paths, writer, lines);
    });
  }
  return result;
}
