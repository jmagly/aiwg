/**
 * D10 retention: purge writes signed tombstones that keep the chain verifiable,
 * lookup returns them without a body, the index survives, and unreconciled
 * intents, legal holds and unexpired records are never purged. Offline only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, type DecisionLifecyclePolicy } from '../../../src/decision/lifecycle.js';
import {
  EFFECT_RETENTION_POLICY,
  isEffectSchemaValid,
  lookupEffect,
  purgeEffect,
  reconcileEffect,
  recordIntent,
  recordOutcome,
  verifyLedger,
  writeCheckpoint,
} from '../../../src/effects/index.js';
import { comment, harness, present, type Harness } from './helpers.js';

const DAY = 86_400_000;
function lifecycle(retentionMs = DAY): DecisionLifecyclePolicy {
  return { version: DECISION_LIFECYCLE_VERSION, surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
    classification: 'restricted', accessScopes: ['effect-ledger'], retentionMs, export: 'denied', deletion: 'tombstone', backup: 'expire-with-primary',
  }])) as DecisionLifecyclePolicy['surfaces'] };
}

let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());

const root = () => join(h.dir, '.aiwg', 'effects', 'delivery');
const segment = (writer: string) => readFileSync(join(root(), 'segments', `${writer}.jsonl`), 'utf8');

describe('tombstones', () => {
  it('EFF-TOMB-01 after a purge the chain and checkpoint still verify and lookup returns the tombstone without a body', async () => {
    const ledger = h.ledger();
    const first = await recordIntent(ledger, comment(1));
    await recordOutcome(ledger, first.effectId, { phase: 'completed', payloadDigest: comment(1).payloadDigest, verification: present() });
    const kept = await recordIntent(ledger, comment(2));
    await writeCheckpoint(ledger);
    const before = segment('writer-a').trim().split('\n').map(line => JSON.parse(line));
    h.clock.advance(2 * DAY);

    const result = await purgeEffect(ledger, first.effectId, { lifecycle: lifecycle() });
    expect(result).toEqual({ effectId: first.effectId, tombstoned: 2, alreadyTombstoned: 0, retentionPolicy: EFFECT_RETENTION_POLICY });
    const after = segment('writer-a').trim().split('\n').map(line => JSON.parse(line));
    expect(after.map(line => line.recordHash)).toEqual(before.map(line => line.recordHash));
    expect(after[2]).toEqual(before[2]);
    for (const line of after.slice(0, 2)) {
      const statement = JSON.parse(Buffer.from(line.envelope.payload, 'base64').toString('utf8'));
      expect(isEffectSchemaValid('record', statement)).toBe(true);
      expect(statement.subject[0].name).toBe(`aiwg-effect:${first.effectId}`);
      expect(statement.predicate).not.toHaveProperty('target');
      expect(statement.predicate).not.toHaveProperty('context');
      expect(statement.predicate).not.toHaveProperty('verification');
      expect(statement.predicate.tombstone).toMatchObject({ originalRecordHash: line.recordHash, retentionPolicy: EFFECT_RETENTION_POLICY });
    }
    const decoded = after.slice(0, 2).map(line => Buffer.from(line.envelope.payload, 'base64').toString('utf8')).join('\n');
    expect(decoded).not.toContain('gitea:example/repo#1');
    expect(decoded).not.toContain('cycle-comment');

    expect(await verifyLedger(ledger)).toMatchObject({ ok: true, failures: [] });
    const lookup = await lookupEffect(ledger, first.effectId);
    expect(lookup).toMatchObject({ found: true, status: 'tombstoned', tombstoned: true, exitCode: 0 });
    expect(lookup).not.toHaveProperty('target');
    expect(lookup.records.map(record => record.phase)).toEqual(['tombstone', 'tombstone']);
    expect(lookup.records.every(record => record.verification === undefined && record.tombstone)).toBe(true);
    expect((await lookupEffect(ledger, kept.effectId)).status).toBe('intent');

    // The index survives, so the purged ID is never recorded as new; a repeat purge is idempotent.
    expect(readdirSync(join(root(), 'index'))).toHaveLength(3);
    expect(await recordIntent(ledger, comment(1))).toMatchObject({ idempotent: true, effectId: first.effectId });
    expect(await purgeEffect(ledger, first.effectId, { lifecycle: lifecycle() })).toMatchObject({ tombstoned: 0, alreadyTombstoned: 2 });
  });

  it('EFF-TOMB-02 purging an intent that has no outcome is refused, until a definitive reconcile', async () => {
    const ledger = h.ledger();
    const intent = await recordIntent(ledger, comment(1));
    h.clock.advance(2 * DAY);
    await expect(purgeEffect(ledger, intent.effectId, { lifecycle: lifecycle() })).rejects.toMatchObject({ code: 'purge-refused', reason: 'unreconciled-intent' });
    await reconcileEffect(ledger, intent.effectId);
    await expect(purgeEffect(ledger, intent.effectId, { lifecycle: lifecycle() })).rejects.toMatchObject({ reason: 'unreconciled-intent' });
    expect(segment('writer-a')).not.toContain('"tombstone"');
  });

  it('EFF-TOMB-03 a legal hold or unexpired retention blocks purge', async () => {
    const ledger = h.ledger();
    const intent = await recordIntent(ledger, comment(1));
    await recordOutcome(ledger, intent.effectId, { phase: 'failed', payloadDigest: comment(1).payloadDigest, failure: { reason: 'target-rejected' } });
    await expect(purgeEffect(ledger, intent.effectId, { lifecycle: lifecycle() })).rejects.toMatchObject({ reason: 'retention-not-elapsed' });
    h.clock.advance(2 * DAY);
    await expect(purgeEffect(ledger, intent.effectId, { lifecycle: lifecycle(), legalHold: true })).rejects.toMatchObject({ reason: 'legal-hold' });
    await expect(purgeEffect(ledger, intent.effectId, { lifecycle: { version: DECISION_LIFECYCLE_VERSION } as never })).rejects.toMatchObject({ reason: 'lifecycle-invalid' });
    expect((await purgeEffect(ledger, intent.effectId, { lifecycle: lifecycle() })).tombstoned).toBe(2);
    expect((await lookupEffect(ledger, intent.effectId))).toMatchObject({ status: 'tombstoned', exitCode: 3 });
  });

  it('EFF-TOMB-04 an outcome cannot be recorded or reconciled against a purged intent', async () => {
    const ledger = h.ledger();
    const intent = await recordIntent(ledger, comment(1));
    await recordOutcome(ledger, intent.effectId, { phase: 'completed', payloadDigest: comment(1).payloadDigest, verification: present() });
    h.clock.advance(2 * DAY);
    await purgeEffect(ledger, intent.effectId, { lifecycle: lifecycle() });
    await expect(reconcileEffect(ledger, intent.effectId)).rejects.toMatchObject({ reason: 'intent-purged' });
  });
});
