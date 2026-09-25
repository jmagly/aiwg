/**
 * Canary scan: after exercising every operation, no ledger file, decoded
 * payload, returned JSON or error contains private-key material, token-shaped
 * strings, vault locators or raw payload fields. Uses the D13 restricted scan
 * (`assertReviewProjection`) and the evidence-bundle restricted member names.
 * Offline only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertReviewProjection } from '../../../src/decision/review/validate.js';
import { DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, type DecisionLifecyclePolicy } from '../../../src/decision/lifecycle.js';
import { EVIDENCE_RESTRICTED_KEY } from '../../../src/evidence/bundle.js';
import {
  containsRestrictedMaterial,
  effectOutputJson,
  lookupEffect,
  payloadDigest,
  purgeEffect,
  reconcileEffect,
  recordIntent,
  recordOutcome,
  rotateKey,
  staticKeyProvider,
  verifyLedger,
  writeCheckpoint,
} from '../../../src/effects/index.js';
import { harness, present, testKey, testKeySeedHex, type Harness } from './helpers.js';

const BODY = 'CANARY raw comment body with a token ghp_abcdefghijklmnop1234 inside';
const policy: DecisionLifecyclePolicy = {
  version: DECISION_LIFECYCLE_VERSION,
  surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
    classification: 'restricted', accessScopes: ['effect-ledger'], retentionMs: 1000, export: 'denied', deletion: 'tombstone', backup: 'expire-with-primary',
  }])) as DecisionLifecyclePolicy['surfaces'],
};

let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());

const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const file = join(dir, name);
  return statSync(file).isDirectory() ? files(file) : [file];
});

function privateMaterial(label: string): string[] {
  const der = testKey(label).export({ format: 'der', type: 'pkcs8' }) as Buffer;
  return [testKeySeedHex(label), der.toString('base64'), der.toString('hex'), testKey(label).export({ format: 'pem', type: 'pkcs8' }).toString()];
}

function assertClean(text: string, where: string): void {
  for (const secret of [...privateMaterial('a'), ...privateMaterial('b')]) expect(text, where).not.toContain(secret);
  expect(text, where).not.toMatch(/PRIVATE KEY|MC4CAQAwBQYDK2Vw|vault:\/\//);
  expect(containsRestrictedMaterial(text), where).toBe(false);
  expect(text, where).not.toContain('CANARY');
}

function assertCleanJson(value: unknown, where: string): void {
  expect(() => assertReviewProjection(value), where).not.toThrow();
  const visit = (node: unknown, parent?: string): void => {
    if (Array.isArray(node)) node.forEach(item => visit(item, parent));
    else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        expect(EVIDENCE_RESTRICTED_KEY.test(key), `${where}: ${key}`).toBe(false);
        if (!(key === 'payload' && parent === 'envelope')) expect(/^(?:body|rawBody|raw_body|content|text|request|response|payload)$/.test(key), `${where}: ${key}`).toBe(false);
        visit(child, key);
      }
    }
  };
  visit(value);
}

describe('canary scan', () => {
  it('EFF-CAN-01 records, segments, checkpoints, keyring, errors and JSON output are digest-only', async () => {
    const ledger = h.ledger();
    const outputs: unknown[] = [];
    const errors: unknown[] = [];
    const input = { kind: 'tracker.comment', target: 'gitea:example/repo#7', context: { issue: 7, action: 'cycle-comment' }, payloadDigest: payloadDigest(BODY) };
    const intent = await recordIntent(ledger, input);
    outputs.push(intent, await recordOutcome(ledger, intent.effectId, { phase: 'completed', payloadDigest: input.payloadDigest, verification: present() }));
    outputs.push(await reconcileEffect(ledger, intent.effectId), await writeCheckpoint(ledger));
    h.clock.advance(60_000);
    outputs.push(await rotateKey(ledger, staticKeyProvider(testKey('b'))));
    outputs.push(await purgeEffect(ledger, intent.effectId, { lifecycle: policy }));
    outputs.push(await lookupEffect(ledger, intent.effectId), await verifyLedger(ledger), await writeCheckpoint(ledger), ledger);

    for (const attempt of [
      () => recordIntent(ledger, { ...input, context: { note: BODY } }),
      () => recordIntent(ledger, { ...input, context: { note: 'vault://kv/ledger-key' } }),
      () => recordIntent(ledger, { ...input, payloadDigest: payloadDigest('other') }),
      () => recordIntent(h.ledger({ writer: 'writer-z', key: 'a' }), { ...input, target: 'gitea:example/repo#8' }),
    ]) errors.push(await attempt().then(() => null, (caught: unknown) => caught));
    expect(errors.every(Boolean)).toBe(true);

    for (const output of outputs) {
      const text = effectOutputJson(output);
      assertClean(text, 'output');
      assertCleanJson(JSON.parse(text), 'output');
    }
    for (const error of errors) {
      assertClean(`${(error as Error).message} ${JSON.stringify(error)} ${String((error as Error).stack)}`, 'error');
    }
    const ledgerFiles = files(join(h.dir, '.aiwg', 'effects'));
    expect(ledgerFiles.some(file => file.endsWith('.jsonl'))).toBe(true);
    for (const file of ledgerFiles) {
      const text = readFileSync(file, 'utf8');
      assertClean(text, file);
      for (const chunk of file.endsWith('.jsonl') ? text.trim().split('\n') : file.endsWith('.json') ? [text] : []) {
        const value = JSON.parse(chunk);
        assertCleanJson(value, file);
        if (value.envelope) {
          const decoded = Buffer.from(value.envelope.payload, 'base64').toString('utf8');
          assertClean(decoded, `${file}#payload`);
          assertCleanJson(JSON.parse(decoded), `${file}#payload`);
        }
      }
    }
  });
});
