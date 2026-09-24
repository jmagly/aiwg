import { chmod, copyFile, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { DecisionJobRuntime, recount } from '../../../src/decision/job-runtime.js';
import { FileJobStore, JobConflictError, MemoryJobStore, type JobStore } from '../../../src/decision/job-store.js';
import type { DecisionTelemetrySpan } from '../../../src/decision/telemetry/types.js';

const digest = `sha256:${'a'.repeat(64)}` as const;
const scope = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' };
const other = { ...scope, projectId: 'other' };
function fixture(): DecisionJob {
  const job: DecisionJob = { schemaVersion: 'decision-job/v1', id: 'jobA', scope, fingerprint: digest,
    state: 'validating', createdAtEpochMs: 10, expiresAtEpochMs: 100,
    budget: { maxAttempts: 3, maxTokens: 1000, maxCostMicros: 10000, maxConcurrency: 2 },
    items: Array.from({ length: 3 }, (_, i) => ({ id: `item${i}`, fingerprint: digest, subjectDigest: digest,
      definitionDigest: digest, bindingDigest: digest, state: 'queued', attempts: [] })),
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'] };
  recount(job); return job;
}
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function stores(): Promise<JobStore[]> {
  const directory = await mkdtemp(join(tmpdir(), 'decision-jobs-')); directories.push(directory);
  return [new MemoryJobStore(), new FileJobStore(directory)];
}

describe('JOB durable offline lifecycle', () => {
  it('bounds offline 256-item jobs and keeps simultaneous scoped acquisitions distinct', async () => {
    const store = new MemoryJobStore(); const runtime = new DecisionJobRuntime(store, () => 20);
    const jobs = Array.from({ length: 32 }, (_, index) => {
      const job = fixture(); job.id = `job${index}`;
      job.items = Array.from({ length: 256 }, (_, itemIndex) => ({ ...structuredClone(job.items[0]!), id: `item${itemIndex}` }));
      recount(job); return job;
    });
    const snapshots = await Promise.all(jobs.map(job => runtime.submit(job, scope)));
    expect(new Set(snapshots.map(snapshot => snapshot.job.id)).size).toBe(32);
    expect((await runtime.items(scope, 'job0', 156, 100))?.map(item => item.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `item${156 + index}`));
    const overflow = fixture(); overflow.id = 'overflow';
    overflow.items = Array.from({ length: 1001 }, (_, index) => ({ ...structuredClone(jobs[0]!.items[0]!), id: `item${index}` })); recount(overflow);
    await expect(runtime.submit(overflow, scope)).rejects.toThrow();
    expect(await runtime.poll(other, 'job0')).toBeNull();
  });
  it('purges deleted journal revisions and refuses same-directory backup resurrection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-jobs-erase-'));
    const backup = await mkdtemp(join(tmpdir(), 'decision-jobs-backup-'));
    directories.push(directory, backup);
    const store = new FileJobStore(directory);
    const runtime = new DecisionJobRuntime(store, () => 20);
    await runtime.submit(fixture(), scope);
    await expect(store.purgeDeleted(scope, 'jobA')).rejects.toThrow(JobConflictError);
    await expect(store.purgeDeleted(other, 'jobA')).rejects.toThrow(JobConflictError);
    expect(await runtime.remove(scope, 'jobA')).toBe(true);
    const revisions = (await readdir(directory)).filter(name => name.endsWith('.json'));
    for (const name of revisions) await copyFile(join(directory, name), join(backup, name));
    const orphan = `.${revisions[0]!.split('.')[0]}.job-${randomUUID()}.tmp`;
    await writeFile(join(directory, orphan), 'abandoned-private-revision', { mode: 0o600 });
    await store.purgeDeleted(scope, 'jobA');
    expect((await readdir(directory))).not.toContain(orphan);
    expect((await readdir(directory)).filter(name => name.endsWith('.json'))).toHaveLength(0);
    expect((await readdir(directory)).filter(name => name.endsWith('.deleted'))).toHaveLength(1);
    for (const name of revisions) await copyFile(join(backup, name), join(directory, name));
    expect(await new FileJobStore(directory).read(scope, 'jobA')).toBeNull();
    await expect(new FileJobStore(directory).acquire(fixture())).rejects.toThrow('Job tombstoned');
    await store.purgeDeleted(scope, 'jobA');
    expect((await readdir(directory)).filter(name => name.endsWith('.json'))).toHaveLength(0);
  });
  it('fails closed on a shared or symlinked storage directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'decision-jobs-root-'));
    directories.push(root);
    const alias = join(root, 'alias');
    const privateDir = await mkdtemp(join(root, 'real-'));
    await symlink(privateDir, alias);
    await expect(new FileJobStore(alias).acquire(fixture())).rejects.toThrow('private');
    await chmod(privateDir, 0o755);
    await expect(new FileJobStore(privateDir).acquire(fixture())).rejects.toThrow('private');
    await chmod(privateDir, 0o700);
    expect(await new FileJobStore(privateDir).acquire(fixture())).toMatchObject({ owner: true });
  });
  it('uses owner-only journal modes and rejects a corrupted revision instead of using stale state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-jobs-integrity-'));
    directories.push(directory);
    const store = new FileJobStore(directory);
    await store.acquire(fixture());
    const [name] = (await readdir(directory)).filter(file => file.endsWith('.json'));
    expect(name).toBeDefined();
    expect((await stat(join(directory, name!))).mode & 0o777).toBe(0o600);
    await writeFile(join(directory, name!), '{"invalid":true}');
    await expect(store.read(scope, 'jobA')).rejects.toThrow();
  });
  it('coalesces only equivalent duplicate caller item IDs before acquisition with no dispatch', async () => {
    for (const store of await stores()) {
      const runtime = new DecisionJobRuntime(store, () => 20);
      const repeated = fixture();
      repeated.items.push(structuredClone(repeated.items[0]!)); recount(repeated);
      const acquired = await runtime.submit(repeated, scope);
      expect(acquired.job.items).toHaveLength(3);
      expect(acquired.job.items.map(item => item.id)).toEqual(['item0', 'item1', 'item2']);
      expect(acquired.job.summary.queued).toBe(3);
      expect((await runtime.submit(repeated, scope)).revision).toBe(1);
      expect((await runtime.submit(fixture(), scope)).revision).toBe(1);
      const mismatched = structuredClone(repeated);
      mismatched.items.at(-1)!.definitionDigest = `sha256:${'b'.repeat(64)}`;
      await expect(runtime.submit(mismatched, scope)).rejects.toThrow('Duplicate item ID');
      expect((await runtime.poll(scope, 'jobA'))?.revision).toBe(1);
      if (store instanceof FileJobStore)
        expect((await readdir(directories.at(-1)!)).filter(name => name.endsWith('.json'))).toHaveLength(1);
    }
  });
  it('acquires idempotently, rejects identity mismatch, and survives store re-instantiation', async () => {
    for (const store of await stores()) {
      const runtime = new DecisionJobRuntime(store, () => 20);
      const first = await runtime.submit(fixture(), scope);
      expect((await runtime.submit(fixture(), scope))).toEqual(first);
      const changed = fixture(); changed.items[0]!.fingerprint = `sha256:${'b'.repeat(64)}`;
      await expect(runtime.submit(changed, scope)).rejects.toThrow(JobConflictError);
      await expect(runtime.submit(fixture(), other)).rejects.toThrow(JobConflictError);
      expect(await runtime.poll(other, 'jobA')).toBeNull();
      if (store instanceof FileJobStore) {
        const directory = directories.at(-1)!;
        expect((await new FileJobStore(directory).read(scope, 'jobA'))?.revision).toBe(1);
        expect((await readdir(directory)).filter(name => name.endsWith('.json'))).toHaveLength(1);
      }
    }
  });
  it('emits metadata-only D14 job spans for submit, cancellation, expiration, and deletion', async () => {
    const spans: DecisionTelemetrySpan[] = [];
    let now = 20;
    const runtime = new DecisionJobRuntime(new MemoryJobStore(), () => now, { emit(span) { spans.push(span); } });
    const submitted = await runtime.submit(fixture(), scope);
    const queued = structuredClone(submitted.job); queued.state = 'queued';
    await runtime.advance(scope, 'jobA', submitted, queued);
    await runtime.cancel(scope, 'jobA');
    now = 101;
    await runtime.expire(scope, 'jobA');
    await runtime.remove(scope, 'jobA');
    expect(spans.map(span => [span.name, span.attributes['aiwg.job.operation'], span.attributes['aiwg.job.status']])).toEqual([
      ['decision.job', 'submit', 'validating'], ['decision.job', 'transition', 'queued'],
      ['decision.job', 'cancel', 'cancel-requested'],
      ['decision.job', 'expire', 'expired'], ['decision.job', 'delete', 'expired'],
    ]);
    for (const span of spans) {
      expect(span.status).toBe('ok');
      expect(JSON.stringify(span)).not.toContain('principalId');
      expect(JSON.stringify(span)).not.toContain('actor');
      expect(JSON.stringify(span)).not.toContain('item0');
    }
  });
  it('does not emit a secret or PII canary from scope or item identifiers', async () => {
    const spans: DecisionTelemetrySpan[] = [];
    const canary = 'CANARY_secret_2610';
    const job = fixture(); job.scope = { ...scope, principalId: canary };
    job.items[0]!.id = canary;
    const runtime = new DecisionJobRuntime(new MemoryJobStore(), () => 20, { emit(span) { spans.push(span); } });
    await runtime.submit(job, job.scope);
    expect(spans).toHaveLength(1);
    expect(JSON.stringify(spans)).not.toContain(canary);
  });
  it('isolates every object operation and survives concurrent conflicting acquisition', async () => {
    for (const store of await stores()) {
      const runtime = new DecisionJobRuntime(store, () => 20);
      const changed = fixture(); changed.fingerprint = `sha256:${'b'.repeat(64)}`;
      const settled = await Promise.allSettled([runtime.submit(fixture(), scope), runtime.submit(changed, scope)]);
      expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1);
      const actor = { ...scope, principalId: 'untrusted' };
      expect(await runtime.poll(actor, 'jobA')).toBeNull();
      expect(await runtime.items(actor, 'jobA')).toBeNull();
      expect(await runtime.cancel(actor, 'jobA')).toBeNull();
      expect(await runtime.retry(actor, 'jobA', 'item0')).toBeNull();
      expect(await runtime.reconcile(actor, 'jobA')).toBeNull();
      expect(await runtime.expire(actor, 'jobA')).toBeNull();
      expect(await runtime.remove(actor, 'jobA')).toBe(false);
      const existing = (await runtime.poll(scope, 'jobA'))!;
      const altered = structuredClone(existing.job); altered.state = 'queued';
      await expect(runtime.advance(actor, 'jobA', existing, altered)).rejects.toThrow(JobConflictError);
      expect((await runtime.poll(scope, 'jobA'))?.revision).toBe(1);
    }
  });
  it('persists legal hold across restart and denies unauthorized hold, deletion and ID reuse', async () => {
    for (const store of await stores()) {
      const runtime = new DecisionJobRuntime(store, () => 20);
      const submitted = await runtime.submit(fixture(), scope);
      expect(await runtime.setLegalHold(other, 'jobA', true)).toBeNull();
      const held = (await runtime.setLegalHold(scope, 'jobA', true))!;
      expect(held.legalHold).toBe(true);
      await expect(runtime.remove(scope, 'jobA')).rejects.toThrow(JobConflictError);
      expect(await runtime.setLegalHold(scope, 'jobA', true)).toEqual(held);
      if (store instanceof FileJobStore) {
        const restarted = new DecisionJobRuntime(new FileJobStore(directories.at(-1)!), () => 20);
        await expect(restarted.remove(scope, 'jobA')).rejects.toThrow(JobConflictError);
        expect((await restarted.poll(scope, 'jobA'))?.legalHold).toBe(true);
      }
      await expect(runtime.advance(scope, 'jobA', submitted, { ...submitted.job, state: 'queued' })).rejects.toThrow(JobConflictError);
      await runtime.setLegalHold(scope, 'jobA', false);
      expect(await runtime.remove(scope, 'jobA')).toBe(true);
      expect((await runtime.submit(fixture(), scope)).deleted).toBe(true);
    }
  });
  it('keeps requested order, paginates without mutation, rejects stale CAS and tombstones', async () => {
    for (const store of await stores()) {
      const runtime = new DecisionJobRuntime(store, () => 20);
      const first = await runtime.submit(fixture(), scope);
      const next = structuredClone(first.job); next.state = 'queued';
      const second = await runtime.advance(scope, 'jobA', first, next);
      await expect(runtime.advance(scope, 'jobA', first, next)).rejects.toThrow(JobConflictError);
      expect((await runtime.items(scope, 'jobA', 1, 2))?.map(item => item.id)).toEqual(['item1', 'item2']);
      expect((await runtime.poll(scope, 'jobA'))?.revision).toBe(second.revision);
      await expect(runtime.items(scope, 'jobA', 0, 101)).rejects.toThrow(JobConflictError);
      expect(await runtime.remove(other, 'jobA')).toBe(false);
      expect(await runtime.remove(scope, 'jobA')).toBe(true);
      expect(await runtime.poll(scope, 'jobA')).toBeNull();
      expect((await runtime.submit(fixture(), scope)).deleted).toBe(true);
    }
  });
  it('rejects reordering and preserves requested-order pagination after out-of-order item completion', async () => {
    for (const store of await stores()) {
      const runtime = new DecisionJobRuntime(store, () => 20);
      const first = await runtime.submit(fixture(), scope);
      const queued = structuredClone(first.job); queued.state = 'queued';
      const second = await runtime.advance(scope, 'jobA', first, queued);
      const reordered = structuredClone(second.job);
      reordered.items.reverse();
      await expect(runtime.advance(scope, 'jobA', second, reordered)).rejects.toThrow();
      const running = structuredClone(second.job); running.state = 'running';
      running.items[2]!.state = 'running';
      running.items[2]!.attempts.push({ id: 'attempt2', requestDigest: digest, outcome: 'dispatched' });
      recount(running);
      const third = await runtime.advance(scope, 'jobA', second, running);
      const done = structuredClone(third.job); done.state = 'partially-completed';
      done.items[2]!.state = 'succeeded'; done.items[2]!.resultDigest = digest;
      done.items[2]!.attempts[0]!.outcome = 'succeeded'; done.items[2]!.attempts[0]!.receiptDigest = digest;
      recount(done);
      const fourth = await runtime.advance(scope, 'jobA', third, done);
      expect(fourth.job.summary.succeeded).toBe(1);
      expect((await runtime.items(scope, 'jobA'))?.map(item => item.id)).toEqual(['item0', 'item1', 'item2']);
      const tampered = structuredClone(done); tampered.items[2]!.attempts[0]!.requestDigest = `sha256:${'b'.repeat(64)}`;
      await expect(runtime.advance(scope, 'jobA', third, tampered)).rejects.toThrow();
    }
  });
  it('reconciles restart ambiguity without losing earlier results or replaying a dispatch', async () => {
    for (const store of await stores()) {
      const spans: DecisionTelemetrySpan[] = [];
      const runtime = new DecisionJobRuntime(store, () => 20, { emit(span) { spans.push(span); } });
      const first = await runtime.submit(fixture(), scope);
      const queued = structuredClone(first.job); queued.state = 'queued';
      const second = await runtime.advance(scope, 'jobA', first, queued);
      const running = structuredClone(second.job); running.state = 'running';
      running.items[0]!.state = 'running';
      running.items[0]!.attempts.push({ id: 'attempt1', requestDigest: digest, outcome: 'dispatched' });
      recount(running);
      await runtime.advance(scope, 'jobA', second, running);
      const recovered = await runtime.reconcile(scope, 'jobA');
      expect(recovered?.job.state).toBe('failed');
      expect(recovered?.job.items.map(item => item.state)).toEqual(['execution-unknown', 'canceled', 'canceled']);
      expect(recovered?.job.summary['execution-unknown']).toBe(1);
      expect(spans.at(-1)?.attributes).toMatchObject({
        'aiwg.job.operation': 'reconcile', 'aiwg.job.unknown_count': 1, 'aiwg.job.status': 'failed',
      });
      expect(await runtime.reconcile(scope, 'jobA')).toEqual(recovered);
      await expect(runtime.retry(scope, 'jobA', 'item0')).rejects.toThrow(JobConflictError);
    }
  });
  it('requeues only eligible failures while preserving attempt lineage', async () => {
    for (const store of await stores()) {
      const spans: DecisionTelemetrySpan[] = [];
      const runtime = new DecisionJobRuntime(store, () => 20, { emit(span) { spans.push(span); } });
      const first = await runtime.submit(fixture(), scope);
      const queued = structuredClone(first.job); queued.state = 'queued';
      const second = await runtime.advance(scope, 'jobA', first, queued);
      const running = structuredClone(second.job); running.state = 'running';
      running.items[0]!.state = 'running';
      running.items[0]!.attempts.push({ id: 'attempt1', requestDigest: digest, outcome: 'dispatched' });
      recount(running);
      const third = await runtime.advance(scope, 'jobA', second, running);
      const failed = structuredClone(third.job); failed.state = 'partially-completed';
      failed.items[0]!.state = 'retryable-failed'; failed.items[0]!.attempts[0]!.outcome = 'failed';
      recount(failed);
      await runtime.advance(scope, 'jobA', third, failed);
      const retried = await runtime.retry(scope, 'jobA', 'item0');
      expect(retried?.job.items[0]).toMatchObject({ state: 'queued', attempts: [{ id: 'attempt1', outcome: 'failed' }] });
      expect(spans.at(-1)?.attributes).toMatchObject({ 'aiwg.job.operation': 'retry', 'aiwg.job.status': 'partially-completed' });
      await expect(runtime.retry(scope, 'jobA', 'item0')).rejects.toThrow(JobConflictError);
      await expect(runtime.retry(scope, 'jobA', 'item1')).rejects.toThrow(JobConflictError);
      expect(await runtime.retry(other, 'jobA', 'item0')).toBeNull();
    }
  });
  it('cancels queued work but preserves in-flight ambiguity, then expires without replay', async () => {
    for (const store of await stores()) {
      let now = 20;
      const runtime = new DecisionJobRuntime(store, () => now);
      const first = await runtime.submit(fixture(), scope);
      const queued = structuredClone(first.job); queued.state = 'queued';
      const second = await runtime.advance(scope, 'jobA', first, queued);
      const running = structuredClone(second.job); running.state = 'running';
      running.items[1]!.state = 'running';
      running.items[1]!.attempts.push({ id: 'attempt1', requestDigest: digest, outcome: 'dispatched' });
      recount(running);
      await runtime.advance(scope, 'jobA', second, running);
      const canceled = await runtime.cancel(scope, 'jobA');
      expect(canceled?.job.state).toBe('cancel-requested');
      expect(canceled?.job.items.map(item => item.state)).toEqual(['canceled', 'running', 'canceled']);
      expect(await runtime.cancel(scope, 'jobA')).toEqual(canceled);
      now = 101;
      const expired = await runtime.expire(scope, 'jobA');
      expect(expired?.job.state).toBe('expired');
      expect(expired?.job.items[1]?.state).toBe('execution-unknown');
      expect(expired?.job.items[1]?.attempts[0]?.outcome).toBe('execution-unknown');
      expect((await store.read(scope, 'jobA'))?.revision).toBe(5);
    }
  });
});
