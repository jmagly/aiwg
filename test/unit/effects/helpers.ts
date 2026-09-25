/** Shared offline fixtures for the effect ledger unit tests. */
import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  memoryCheckpointSink,
  openEffectLedger,
  payloadDigest,
  staticKeyProvider,
  type CheckpointSink,
  type EffectLedger,
  type EffectScope,
  type EffectVerification,
} from '../../../src/effects/index.js';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Deterministic test-only Ed25519 key derived from a public label. */
export function testKey(label: string): KeyObject {
  const seed = createHash('sha256').update(`aiwg-effect-ledger-unit-test-key/${label}`).digest();
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export function testKeySeedHex(label: string): string {
  return createHash('sha256').update(`aiwg-effect-ledger-unit-test-key/${label}`).digest('hex');
}

export const scope: EffectScope = { tenant: 'local', project: 'example/repo', subsystem: 'delivery' };

export class TestClock {
  constructor(public now = Date.parse('2026-09-24T10:00:00.000Z')) {}
  readonly read = () => this.now;
  advance(ms: number): void { this.now += ms; }
}

export interface Harness {
  dir: string;
  clock: TestClock;
  sink: CheckpointSink & { published: unknown[] };
  ledger(options?: { writer?: string; key?: string; scope?: EffectScope; sink?: CheckpointSink }): EffectLedger;
  cleanup(): void;
}

export function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'aiwg-effects-'));
  const clock = new TestClock();
  const sink = memoryCheckpointSink();
  return {
    dir,
    clock,
    sink,
    ledger: (options = {}) => openEffectLedger({
      projectDir: dir,
      scope: options.scope ?? scope,
      writer: options.writer ?? 'writer-a',
      keyProvider: staticKeyProvider(testKey(options.key ?? 'a')),
      clock: clock.read,
      sink: options.sink ?? sink,
      lockTimeoutMs: 20_000,
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const comment = (issue = 12, cycle = 1) => ({
  kind: 'tracker.comment',
  target: `gitea:example/repo#${issue}`,
  context: { issue, action: 'cycle-comment', cycle },
  payloadDigest: payloadDigest(`cycle comment body ${issue}/${cycle}\n`),
});

export const present = (kind = 'tracker.comment', checkedAt = '2026-09-24T10:00:01.000Z'): EffectVerification => ({
  verifier: { kind, version: '1.0.0', canReportAbsent: true },
  result: 'present', reason: 'marker-match', complete: true, checkedAt,
  evidenceDigest: payloadDigest('comment evidence'),
});
