/**
 * Signed checkpoints and the default git-ref sink (a local temporary
 * repository, no remote). Offline only.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gitRefCheckpointSink,
  openEffectLedger,
  recordIntent,
  staticKeyProvider,
  verifyLedger,
  writeCheckpoint,
  type EffectCheckpoint,
} from '../../../src/effects/index.js';
import { checkpointDigest } from '../../../src/effects/verify.js';
import { comment, harness, scope, testKey, type Harness } from './helpers.js';

let h: Harness;
beforeEach(() => {
  h = harness();
  execFileSync('git', ['init', '-q', h.dir]);
});
afterEach(() => h.cleanup());

const REF = 'refs/aiwg/effects/delivery/checkpoint';
const gitLedger = (writer = 'writer-a') => openEffectLedger({ projectDir: h.dir, scope, writer, keyProvider: staticKeyProvider(testKey('a')), clock: h.clock.read });
const refBlob = () => JSON.parse(execFileSync('git', ['-C', h.dir, 'cat-file', 'blob', REF], { encoding: 'utf8' })) as EffectCheckpoint;
const root = () => join(h.dir, '.aiwg', 'effects', 'delivery');

describe('checkpoints', () => {
  it('EFF-CKP-01 the default sink is a git ref; checkpoints chain by digest and the ref tracks the latest', async () => {
    const ledger = gitLedger();
    await recordIntent(ledger, comment(1));
    const first = await writeCheckpoint(ledger);
    expect(first.sink.sink).toBe('git-ref');
    expect(first.sink.reference.startsWith(`${REF}@`)).toBe(true);
    expect(refBlob()).toEqual(first.checkpoint);
    h.clock.advance(1000);
    await recordIntent(gitLedger('writer-b'), comment(2));
    const second = await writeCheckpoint(ledger);
    expect(second.checkpoint).toMatchObject({ sequence: 1, previousCheckpoint: checkpointDigest(first.checkpoint) });
    expect(second.checkpoint.writers.map(writer => writer.writer)).toEqual(['writer-a', 'writer-b']);
    expect(refBlob()).toEqual(second.checkpoint);
    expect(await verifyLedger(ledger)).toMatchObject({ ok: true, checkpoint: { sequence: 1, source: 'sink' } });
  });

  it('EFF-CKP-02 the git ref detects truncation after the local checkpoints and segment tail are both removed', async () => {
    const ledger = gitLedger();
    await recordIntent(ledger, comment(1));
    await recordIntent(ledger, comment(2));
    await writeCheckpoint(ledger);
    rmSync(join(root(), 'checkpoints'), { recursive: true, force: true });
    const segment = join(root(), 'segments', 'writer-a.jsonl');
    writeFileSync(segment, `${readFileSync(segment, 'utf8').split('\n')[0]}\n`);
    const result = await verifyLedger(ledger, { checkIndex: false });
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(expect.objectContaining({ reason: 'segment-truncated', writer: 'writer-a' }));
    expect(result.warnings).toContain('local-checkpoint-behind');
  });

  it('EFF-CKP-03 a checkpoint is refused over a ledger that fails verification, and a deleted sink ref is reported', async () => {
    const ledger = gitLedger();
    await recordIntent(ledger, comment(1));
    await recordIntent(ledger, comment(2));
    await writeCheckpoint(ledger);
    const segment = join(root(), 'segments', 'writer-a.jsonl');
    const lines = readFileSync(segment, 'utf8').trim().split('\n');
    writeFileSync(segment, `${lines[1]}\n${lines[0]}\n`);
    await expect(writeCheckpoint(ledger)).rejects.toMatchObject({ code: 'integrity', exitCode: 6 });
    writeFileSync(segment, `${lines.join('\n')}\n`);
    execFileSync('git', ['-C', h.dir, 'update-ref', '-d', REF]);
    expect((await verifyLedger(ledger)).failures).toContainEqual({ reason: 'checkpoint-sink-missing' });
  });

  it('EFF-CKP-04 the git sink refuses an unsafe ref and a concurrent ref move', async () => {
    expect(() => gitRefCheckpointSink({ repoDir: h.dir, subsystem: 'delivery', ref: 'refs/../HEAD' })).toThrow();
    const ledger = gitLedger();
    await recordIntent(ledger, comment(1));
    const { checkpoint } = await writeCheckpoint(ledger);
    let calls = 0;
    const racing = gitRefCheckpointSink({
      repoDir: h.dir, subsystem: 'delivery',
      runner: async (args, stdin) => {
        calls += 1;
        // Simulate another host moving the ref between the read and the compare-and-swap.
        if (args[0] === 'update-ref') execFileSync('git', ['-C', h.dir, 'update-ref', REF, execFileSync('git', ['-C', h.dir, 'hash-object', '-w', '--stdin'], { input: 'other\n', encoding: 'utf8' }).trim()]);
        try { return { stdout: execFileSync('git', ['-C', h.dir, ...args], { input: stdin ?? '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }), exitCode: 0 }; }
        catch (error) { return { stdout: '', exitCode: (error as { status?: number }).status ?? 1 }; }
      },
    });
    await expect(racing.publish({ ...checkpoint, sequence: 1 })).rejects.toMatchObject({ reason: 'checkpoint-sink-unavailable' });
    expect(calls).toBeGreaterThan(0);
  });
});
