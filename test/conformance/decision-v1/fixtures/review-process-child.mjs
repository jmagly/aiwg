import { appendFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { journaledReviewExecutor } from '../../../../src/decision/review/index.ts';
import {
  CONTINUATION, REVIEW_ID, TOKEN, actor, createInput, executor, openLedger, openService, paths, requester, tenant,
} from './review-process.ts';

// Child process for the cross-process review tests. Modes:
//   race-claim <dir> <reviewer>   wait for "go" on stdin, then claim
//   race-resume <dir>             wait for "go" on stdin, then resume
//   crash <dir> <step>            run one step, report its crash point and block until killed
const [mode, directory, ...rest] = process.argv.slice(2);
const now = () => 5_000;
const effects = paths(directory).effects;
const report = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const failure = error => ({ ok: false, name: error.constructor.name, message: error.message });
/** Report the crash point synchronously, then block the thread until the parent sends SIGKILL. */
const blockForever = step => {
  writeSync(1, `${JSON.stringify({ crashPoint: step })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

async function barrier() {
  report({ ready: process.pid });
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) if (line.trim() === 'go') break;
  lines.close();
}

if (mode === 'race-claim') {
  const service = openService(directory, now);
  await barrier();
  report(await service.claim(actor(rest[0], 'reviewer'), REVIEW_ID, 'race').then(
    review => ({ ok: true, status: review.status, revision: review.revision }), failure));
} else if (mode === 'race-resume') {
  const service = openService(directory, now);
  await barrier();
  report(await service.resume(executor, REVIEW_ID, TOKEN, async id => {
    await appendFile(effects, `${process.pid}\n`);
    return { delivered: true, effectId: id };
  }).then(receipt => ({ ok: true, effectId: receipt.effectId }), failure));
} else if (mode === 'crash') {
  const [step] = rest;
  let effected = false;
  // Store fault seams run synchronously inside publication, so the kill lands exactly there.
  const fault = boundary => {
    if (step === 'create-before-publication' && boundary === 'review-before-publication') blockForever(step);
    if (['create', 'claim', 'decide'].includes(step) && boundary === 'review-after-publication') blockForever(step);
    if (step === 'post-effect' && effected && boundary === 'review-before-publication') blockForever(step);
  };
  const service = openService(directory, now, fault);
  if (step === 'create' || step === 'create-before-publication') await service.create(requester, createInput());
  else if (step === 'claim') await service.claim(actor('reviewer-a', 'reviewer'), REVIEW_ID, 'claim');
  else if (step === 'decide') await service.decide(actor('reviewer-a', 'reviewer'), REVIEW_ID, 'approve', 'approve');
  else if (step === 'dispatched') {
    // Executor entered after the durable `resuming` fence, before any external effect.
    await service.resume(executor, REVIEW_ID, TOKEN, async () => { blockForever(step); });
  } else if (step === 'post-effect') {
    // The effect happens and the executor journals it; the kill lands before the review receipt.
    await service.resume(executor, REVIEW_ID, TOKEN, journaledReviewExecutor({
      ledger: openLedger(directory), scope: tenant, reviewId: REVIEW_ID, continuationId: CONTINUATION,
      proposalVersion: 1, now, executeEffect: async id => {
        await appendFile(effects, `${process.pid}\n`);
        effected = true;
        return { delivered: true, effectId: id };
      },
    }));
  }
  throw new Error(`crash step ${step} did not reach its crash point`);
} else {
  throw new Error(`unknown mode ${mode}`);
}
