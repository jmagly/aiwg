import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewConflictError, ledgerReviewReconciler } from '../../../src/decision/review/index.js';
import { lookupEffect } from '../../../src/effects/index.js';
import {
  CONTINUATION, REVIEW_ID, TOKEN, actionDigest, actor, createInput, effectId, openJournal, openService, openStore, targetLines, tenant,
  type ProbeMode,
} from './fixtures/review-effect-crash.js';

// D13 effect-ledger adoption (#2721): a killed-process crash matrix. A child
// resumes an approved review through the ledger-backed executor and blocks at
// one crash point; the parent SIGKILLs it there and restarts from disk with the
// production reconciler and a verifier probe that is truthful, or forced to
// `absent` or `unknown`. No test sleeps on the wall clock.
const script = fileURLToPath(new URL('./fixtures/review-effect-crash-child.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('../../../', import.meta.url));
const directories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function crashAt(dir: string, point: string) {
  const proc = spawn(process.execPath, ['--import', 'tsx', script, dir, point], { cwd, stdio: 'pipe' });
  children.push(proc);
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += String(chunk); });
  const lines = createInterface({ input: proc.stdout });
  const first = await Promise.race([
    new Promise<unknown>(resolve => lines.once('line', line => resolve(JSON.parse(line)))),
    once(proc, 'exit').then(() => { throw new Error(`child exited before its crash point: ${stderr.slice(0, 500)}`); }),
  ]);
  expect(first).toEqual({ crashPoint: point });
  proc.kill('SIGKILL');
  if (proc.exitCode === null && proc.signalCode === null) await once(proc, 'exit');
  expect(proc.signalCode).toBe('SIGKILL');
}

const POINTS = ['before-intent', 'intent-written', 'effect-done', 'completed'] as const;
type Point = typeof POINTS[number];
/** Whether the target received the effect before the kill. */
const effected = (point: Point) => point === 'effect-done' || point === 'completed';
/** Whether the effect is settled at restart: a signed `completed`, or a truthful verifier that finds it at the target. */
const recovers = (point: Point, mode: ProbeMode) => point === 'completed' || (point === 'effect-done' && mode === 'truthful');

describe('D13 effect ledger killed-process crash matrix', () => {
  for (const point of POINTS) {
    for (const mode of ['truthful', 'absent', 'unknown'] as const) {
      it(`REV-EFF-KILL ${point} / verifier ${mode}: ${recovers(point, mode) ? 'recovers the receipt' : 'stays uncertain'} with no duplicate effect`, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'review-effect-crash-')); directories.push(dir);
        const seed = openService(dir, () => 5_000);
        await seed.create(actor('requester', 'requester'), createInput());
        await seed.decide(actor('reviewer-a', 'reviewer'), REVIEW_ID, 'approve', 'approve');

        await crashAt(dir, point);
        expect(await targetLines(dir)).toEqual(effected(point) ? [effectId] : []);
        expect(await openStore(dir).read(REVIEW_ID, tenant.tenantId, tenant.projectId)).toMatchObject({ status: 'resuming' });

        // Restart past the resuming lease with the production reconciler.
        const journal = openJournal(dir, mode);
        const service = openService(dir, () => 7_000);
        const reconcile = ledgerReviewReconciler({ journal, scope: tenant, reviewId: REVIEW_ID, continuationId: CONTINUATION, proposalVersion: 1, actionDigest });
        let replays = 0;
        const replay = async () => { replays += 1; return { replayed: true }; };
        const resume = () => service.resume(actor('executor', 'executor'), REVIEW_ID, TOKEN, replay, reconcile);

        if (recovers(point, mode)) {
          const receipt = await resume();
          expect(receipt).toMatchObject({ effectId, continuationId: CONTINUATION, proposalVersion: 1 });
          if (point === 'completed') expect(receipt.result).toEqual({ delivered: true });
          expect(await resume()).toEqual(receipt);
          expect(await openStore(dir).read(REVIEW_ID, tenant.tenantId, tenant.projectId)).toMatchObject({ status: 'completed', effectReceipt: receipt });
          expect((await lookupEffect(journal.ledger, effectId)).records.filter(record => record.phase === 'completed')).toHaveLength(1);
        } else {
          await expect(resume()).rejects.toThrow(new ReviewConflictError('Effect outcome remains unknown'));
          expect(await openStore(dir).read(REVIEW_ID, tenant.tenantId, tenant.projectId)).toMatchObject({ status: 'resuming' });
          const lookup = await lookupEffect(journal.ledger, effectId);
          // The intent exists (recorded late after a kill before it), no completed was invented, and every attempt is on record.
          expect(lookup.records.map(record => record.phase)).toContain('intent');
          expect(lookup.records.some(record => record.phase === 'completed')).toBe(false);
          expect(lookup.records.at(-1)?.verification?.result).toBe(mode === 'unknown' ? 'unknown' : 'absent');
        }
        // Never a duplicate effect and never a replay.
        expect(replays).toBe(0);
        expect(await targetLines(dir)).toEqual(effected(point) ? [effectId] : []);
      }, 60_000);
    }
  }
});
