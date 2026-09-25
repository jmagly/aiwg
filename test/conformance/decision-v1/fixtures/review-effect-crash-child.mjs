import { appendFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { journaledReviewExecutor } from '../../../../src/decision/review/index.ts';
import { CONTINUATION, REVIEW_ID, TOKEN, actor, openJournal, openService, paths, tenant } from './review-effect-crash.ts';

// Child process for the D13 effect-ledger crash matrix (#2721). It resumes an
// approved review through the ledger-backed executor and blocks the thread at
// one crash point, where the parent SIGKILLs it:
//   before-intent   continuation acquired, intent not yet written
//   intent-written  signed intent written, effect not yet sent
//   effect-done     effect delivered to the target, completed not yet written
//   completed       completed written, review receipt not yet persisted
const [directory, point] = process.argv.slice(2);
const blockForever = () => {
  writeSync(1, `${JSON.stringify({ crashPoint: point })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const journal = openJournal(directory);
const ledger = {
  completedReceipt: query => journal.completedReceipt(query),
  reconcileReceipt: (query, options) => journal.reconcileReceipt(query, options),
  async recordIntent(identity, actionDigest) {
    if (point === 'before-intent') blockForever();
    const state = await journal.recordIntent(identity, actionDigest);
    if (point === 'intent-written') blockForever();
    return state;
  },
  async recordCompleted(query, receipt) {
    if (point === 'effect-done') blockForever();
    const recorded = await journal.recordCompleted(query, receipt);
    if (point === 'completed') blockForever();
    return recorded;
  },
};
await openService(directory, () => 5_000).resume(actor('executor', 'executor'), REVIEW_ID, TOKEN, journaledReviewExecutor({
  ledger, scope: tenant, reviewId: REVIEW_ID, continuationId: CONTINUATION, proposalVersion: 1, now: () => 5_000,
  executeEffect: async id => {
    await appendFile(paths(directory).effects, `${id}\n`);
    return { delivered: true };
  },
}));
throw new Error(`crash point ${point} was not reached`);
