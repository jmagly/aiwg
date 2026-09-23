import { ITEM_STATES, type DecisionJob, type DecisionJobItem } from './job-contract.js';
import { JobConflictError, type JobScope, type JobSnapshot, type JobStore } from './job-store.js';

/** Offline lifecycle only: no provider calls or action execution. Scope comes from trusted authentication. */
export class DecisionJobRuntime {
  constructor(private readonly store: JobStore, private readonly now: () => number = Date.now) {}

  async submit(job: DecisionJob, actor: JobScope): Promise<JobSnapshot> {
    this.authorize(actor, job.scope);
    if (this.now() >= job.expiresAtEpochMs) throw new JobConflictError('Expired job');
    return (await this.store.acquire(job)).snapshot;
  }
  async poll(actor: JobScope, id: string): Promise<JobSnapshot | null> {
    const snapshot = await this.store.read(actor, id);
    return snapshot && !snapshot.deleted ? snapshot : null;
  }
  async items(actor: JobScope, id: string, offset = 0, limit = 100): Promise<DecisionJobItem[] | null> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new JobConflictError('Invalid page');
    const snapshot = await this.poll(actor, id);
    return snapshot ? structuredClone(snapshot.job.items.slice(offset, offset + limit)) : null;
  }
  async advance(actor: JobScope, id: string, expected: JobSnapshot, next: DecisionJob): Promise<JobSnapshot> {
    this.authorize(actor, expected.job.scope);
    if (expected.job.id !== id || this.now() >= expected.job.expiresAtEpochMs) throw new JobConflictError('Job expired or mismatched');
    const proposed = { revision: expected.revision + 1, job: structuredClone(next), deleted: false };
    if (!await this.store.compareAndSwap(expected, proposed)) throw new JobConflictError('Concurrent job update');
    return proposed;
  }
  /** Requeue one eligible failure only; no dispatch occurs here. Previous attempts remain immutable. */
  async retry(actor: JobScope, id: string, itemId: string): Promise<JobSnapshot | null> {
    const previous = await this.poll(actor, id);
    if (!previous) return null;
    const item = previous.job.items.find(candidate => candidate.id === itemId);
    if (!item || item.state !== 'retryable-failed' || item.attempts.length >= previous.job.budget.maxAttempts ||
        !['running', 'partially-completed'].includes(previous.job.state)) throw new JobConflictError('Item not retryable');
    const next = structuredClone(previous.job);
    next.items.find(candidate => candidate.id === itemId)!.state = 'queued';
    recount(next);
    return this.advance(actor, id, previous, next);
  }
  async cancel(actor: JobScope, id: string): Promise<JobSnapshot | null> {
    const previous = await this.poll(actor, id);
    if (!previous) return null;
    if (['completed', 'canceled', 'expired', 'failed', 'cancel-requested'].includes(previous.job.state)) return previous;
    const next = structuredClone(previous.job);
    next.state = previous.job.state === 'validating' ? 'canceled' : 'cancel-requested';
    // Running items remain in-flight; they must be reconciled rather than falsely marked canceled.
    next.items.forEach(item => { if (item.state === 'queued' || item.state === 'retryable-failed') item.state = 'canceled'; });
    recount(next);
    return this.advance(actor, id, previous, next);
  }
  /** Explicit offline restart reconciliation. Never re-dispatch an attempt whose transport may have started. */
  async reconcile(actor: JobScope, id: string): Promise<JobSnapshot | null> {
    const previous = await this.poll(actor, id);
    if (!previous) return null;
    if (!['running', 'partially-completed', 'cancel-requested'].includes(previous.job.state)) return previous;
    const next = structuredClone(previous.job);
    next.state = 'failed';
    next.items.forEach(item => {
      if (item.state === 'queued' || item.state === 'retryable-failed') item.state = 'canceled';
      if (item.state === 'running') {
        const attempt = item.attempts.at(-1);
        item.state = attempt?.outcome === 'dispatched' ? 'execution-unknown' : 'canceled';
        if (attempt?.outcome === 'dispatched') attempt.outcome = 'execution-unknown';
      }
    });
    recount(next);
    return this.advance(actor, id, previous, next);
  }
  async expire(actor: JobScope, id: string): Promise<JobSnapshot | null> {
    const previous = await this.poll(actor, id);
    if (!previous) return null;
    if (this.now() < previous.job.expiresAtEpochMs || ['expired', 'canceled', 'completed', 'failed'].includes(previous.job.state)) return previous;
    // Expiration must not erase the evidence of an in-flight request.
    const next = structuredClone(previous.job);
    next.state = 'expired';
    next.items.forEach(item => {
      if (item.state === 'queued' || item.state === 'retryable-failed') item.state = 'expired';
      if (item.state === 'running') {
        const attempt = item.attempts.at(-1);
        item.state = attempt?.outcome === 'dispatched' ? 'execution-unknown' : 'expired';
        if (attempt?.outcome === 'dispatched') attempt.outcome = 'execution-unknown';
      }
    });
    recount(next);
    const proposed = { revision: previous.revision + 1, job: next, deleted: false };
    if (!await this.store.compareAndSwap(previous, proposed)) throw new JobConflictError('Concurrent job update');
    return proposed;
  }
  async remove(actor: JobScope, id: string): Promise<boolean> {
    const previous = await this.poll(actor, id);
    if (!previous) return false;
    const next = { ...previous, revision: previous.revision + 1, deleted: true };
    if (!await this.store.compareAndSwap(previous, next)) throw new JobConflictError('Concurrent job update');
    return true;
  }
  private authorize(actor: JobScope, scope: JobScope): void {
    if (actor.tenantId !== scope.tenantId || actor.projectId !== scope.projectId ||
        actor.workspaceId !== scope.workspaceId || actor.principalId !== scope.principalId)
      throw new JobConflictError('Job unavailable');
  }
}
export function recount(job: DecisionJob): void {
  job.summary = Object.fromEntries(ITEM_STATES.map(state => [state, job.items.filter(item => item.state === state).length])) as DecisionJob['summary'];
}
