import { spawn } from 'node:child_process';
import { access, appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { DecisionJobRuntime, recount } from '../../../src/decision/job-runtime.js';
import { FileJobStore, type JobSnapshot } from '../../../src/decision/job-store.js';
import { OfflineJobWorker } from '../../../src/decision/job-worker.js';
const digest = `sha256:${'a'.repeat(64)}` as const;
const actor = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' };
const success = { state: 'succeeded', receiptDigest: digest, resultDigest: digest } as const;
function job(): DecisionJob {
  const value: DecisionJob = { schemaVersion: 'decision-job/v1', id: 'jobA', scope: actor, fingerprint: digest,
    state: 'validating', createdAtEpochMs: 10, expiresAtEpochMs: 100,
    budget: { maxAttempts: 2, maxTokens: 100, maxCostMicros: 1000, maxConcurrency: 1 },
    items: ['item0', 'item1'].map((id, index) => ({ id, fingerprint: digest,
      subjectDigest: `sha256:${String(index + 1).repeat(64)}` as const, definitionDigest: digest,
      bindingDigest: digest, state: 'queued' as const, attempts: [] })),
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'] };
  recount(value); return value;
}
type Boundary = 'validation' | 'queue' | 'cancel' | 'finalization';
type Phase = 'before' | 'after';
const script = fileURLToPath(new URL('./fixtures/job-crash-boundary-child.mjs', import.meta.url));
const repository = fileURLToPath(new URL('../../../', import.meta.url));
interface Harness { store: string; calls: string; jobFile: string; marker: string }
const executions = async (file: string) => {
  try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
};
const counting = (file: string) => async (item: { id: string }) => {
  await appendFile(file, `${item.id}\n`, { mode: 0o600 }); return success;
};
const journal = async (store: string) => {
  const names = await readdir(store);
  return { revisions: names.filter(name => /\.r[0-9]+\.json$/.test(name)).length,
    temporary: names.filter(name => name.endsWith('.tmp')).length };
};
async function queued(runtime: DecisionJobRuntime): Promise<JobSnapshot> {
  const first = await runtime.submit(job(), actor);
  const next = structuredClone(first.job); next.state = 'queued';
  return runtime.advance(actor, 'jobA', first, next);
}
/** Durable state the parent prepares before the child crashes at the chosen write. */
async function prepare(boundary: Boundary, { store, calls }: Harness): Promise<void> {
  const runtime = new DecisionJobRuntime(new FileJobStore(store), () => 20);
  if (boundary === 'validation') return;
  if (boundary === 'queue') { await runtime.submit(job(), actor); return; }
  const admitted = await queued(runtime);
  if (boundary === 'cancel') {
    // A dispatched fence on item0 and a still-queued sibling.
    const next = structuredClone(admitted.job); next.state = 'running';
    next.items[0]!.state = 'running';
    next.items[0]!.attempts.push({ id: 'attempt0', requestDigest: digest, outcome: 'dispatched' });
    recount(next);
    await runtime.advance(actor, 'jobA', admitted, next);
    return;
  }
  // item1 finishes first; the child's item0 completion is the job-finalizing write.
  await new OfflineJobWorker(runtime).run(actor, 'jobA', 'item1', counting(calls));
}
async function crash(boundary: Boundary, phase: Phase, harness: Harness): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', script, harness.store, boundary, phase,
    harness.marker, harness.calls, harness.jobFile], { cwd: repository, stdio: 'pipe' });
  let error = '';
  child.stderr?.on('data', data => { error += String(data); });
  try {
    const deadline = Date.now() + 15000;
    while (true) {
      try { await access(harness.marker); break; }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
      if (child.exitCode !== null || Date.now() >= deadline)
        throw new Error(`Child did not reach ${boundary}/${phase} write: ${error.slice(0, 300)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(await readFile(harness.marker, 'utf8')).toBe(`${boundary}:${phase}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
  }
  expect(child.signalCode).toBe('SIGKILL');
}
const summary = (snapshot: JobSnapshot | null) =>
  Object.fromEntries(Object.entries(snapshot?.job.summary ?? {}).filter(([, count]) => count > 0));
/** Drive a restarted host to a terminal state. Every item may be executed at most once in total. */
async function drain(runtime: DecisionJobRuntime, calls: string): Promise<JobSnapshot> {
  const worker = new OfflineJobWorker(runtime);
  let latest = (await runtime.poll(actor, 'jobA'))!;
  for (const item of latest.job.items.filter(candidate => candidate.state === 'queued'))
    latest = await worker.run(actor, 'jobA', item.id, counting(calls));
  return latest;
}
const cases: Array<[Boundary, Phase]> = [
  ['validation', 'before'], ['validation', 'after'], ['queue', 'before'], ['queue', 'after'],
  ['cancel', 'before'], ['cancel', 'after'], ['finalization', 'before'], ['finalization', 'after'],
];
describe('JOB real killed-child crash at each durable write boundary', () => {
  it.each(cases)('restarts after a SIGKILL %s the %s write without duplicate execution', async (boundary, phase) => {
    const root = await mkdtemp(join(tmpdir(), 'job-crash-boundary-'));
    const harness: Harness = { store: join(root, 'journal'), calls: join(root, 'calls.log'),
      jobFile: join(root, 'job.json'), marker: join(root, 'crashed.marker') };
    try {
      await writeFile(harness.jobFile, JSON.stringify(job()), { mode: 0o600 });
      await prepare(boundary, harness);
      const prepared = await new FileJobStore(harness.store).read(actor, 'jobA');
      const callsBefore = await executions(harness.calls);
      await crash(boundary, phase, harness);
      const afterCrash = await journal(harness.store);
      // A torn temporary write is never published; a completed write is already durable when the child dies.
      expect(afterCrash.temporary).toBe(phase === 'before' ? 1 : 0);
      // The finalization child first publishes its own dispatch fence, then crashes at the final write.
      const fence = boundary === 'finalization' ? 1 : 0;
      expect(afterCrash.revisions).toBe((prepared?.revision ?? 0) + fence + (phase === 'after' ? 1 : 0));

      // Host restart: fresh store and runtime over the same journal, then explicit reconciliation.
      const restarted = new DecisionJobRuntime(new FileJobStore(harness.store), () => 20);
      const durable = await restarted.poll(actor, 'jobA');
      if (phase === 'before' && boundary !== 'finalization') expect(durable).toEqual(prepared);
      const recovered = await restarted.reconcile(actor, 'jobA');
      expect(await restarted.reconcile(actor, 'jobA')).toEqual(recovered);

      if (boundary === 'validation') {
        if (phase === 'before') expect(durable).toBeNull();
        else expect(durable?.revision).toBe(1);
        // The client retries the same submit: first-writer ownership, never a second record.
        const retried = await restarted.submit(job(), actor);
        expect(retried.revision).toBe(1);
        expect(retried.job).toEqual(job());
        const changed = job(); changed.fingerprint = `sha256:${'b'.repeat(64)}`;
        await expect(restarted.submit(changed, actor)).rejects.toThrow('different immutable request');
        const next = structuredClone(retried.job); next.state = 'queued';
        await restarted.advance(actor, 'jobA', retried, next);
      } else if (boundary === 'queue') {
        const initial = (await new FileJobStore(harness.store).read(actor, 'jobA'))!;
        if (phase === 'before') {
          expect(durable?.job.state).toBe('validating');
          const next = structuredClone(initial.job); next.state = 'queued';
          await restarted.advance(actor, 'jobA', initial, next);
        } else {
          expect(durable?.job.state).toBe('queued');
          // Replaying the lost acknowledgement's stale revision loses the CAS; nothing is re-queued.
          const stale = { ...prepared!, job: structuredClone(prepared!.job) };
          const next = structuredClone(stale.job); next.state = 'queued';
          await expect(restarted.advance(actor, 'jobA', stale, next)).rejects.toThrow('Concurrent job update');
        }
      }
      if (boundary === 'validation' || boundary === 'queue') {
        const final = await drain(restarted, harness.calls);
        expect(final.job.state).toBe('completed');
        expect(summary(final)).toEqual({ succeeded: 2 });
        expect((await executions(harness.calls)).sort()).toEqual(['item0', 'item1']);
        return;
      }

      if (boundary === 'cancel') {
        expect(durable?.job.state).toBe(phase === 'before' ? 'running' : 'cancel-requested');
        // A retried cancel after restart is idempotent against the reconciled terminal record.
        expect(await restarted.cancel(actor, 'jobA')).toEqual(recovered);
        expect(recovered?.job.state).toBe('failed');
        expect(recovered?.job.items.map(item => item.state)).toEqual(['execution-unknown', 'canceled']);
        expect(recovered?.job.items[0]?.attempts).toMatchObject([{ id: 'attempt0', outcome: 'execution-unknown' }]);
        expect(summary(recovered)).toEqual({ 'execution-unknown': 1, canceled: 1 });
      } else {
        // The child's executor ran exactly once; restart never replays it, even when its result was lost.
        expect(await executions(harness.calls)).toEqual([...callsBefore, 'item0']);
        if (phase === 'before') {
          expect(durable?.job.items.map(item => item.state)).toEqual(['running', 'succeeded']);
          expect(recovered?.job.state).toBe('failed');
          expect(recovered?.job.items.map(item => item.state)).toEqual(['execution-unknown', 'succeeded']);
          expect(summary(recovered)).toEqual({ 'execution-unknown': 1, succeeded: 1 });
        } else {
          expect(recovered).toEqual(durable);
          expect(recovered?.job.state).toBe('completed');
          expect(summary(recovered)).toEqual({ succeeded: 2 });
        }
      }
      for (const itemId of ['item0', 'item1'])
        await expect(new OfflineJobWorker(restarted).run(actor, 'jobA', itemId, counting(harness.calls))).rejects.toThrow();
      expect(await executions(harness.calls)).toEqual(boundary === 'finalization' ? [...callsBefore, 'item0'] : []);
      expect(await restarted.reconcile(actor, 'jobA')).toEqual(recovered);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 25000);
});
