import { ITEM_STATES, validateDecisionJob, type DecisionJob, type DecisionJobItem } from './job-contract.js';
import { DecisionTraceBuilder } from './telemetry/trace.js';
import type { DecisionTelemetryHook } from './telemetry/types.js';
import { accountDecisionJob, type JobAccountingReport } from './job-accounting.js';
import type { DecisionReceiptStore } from './types.js';
import type { BatchReceiptStore } from './batch-receipts/types.js';
import { JobConflictError, type JobScope, type JobSnapshot, type JobStore } from './job-store.js';

/**
 * D16 opt-in resolver (#2722). Given an `execution-unknown` item and its
 * latest attempt, it may return a verified resolution. It must only read:
 * it never dispatches or replays the provider. Returning anything but a
 * `digest-match` resolution leaves the item `execution-unknown`.
 */
export interface ExecutionUnknownResolution {
  state: 'succeeded' | 'abstained' | 'review';
  effectId: string;
  reason: 'digest-match';
  receiptDigest: `sha256:${string}`;
  resultDigest: `sha256:${string}`;
}
export type ExecutionUnknownResolver = (input: {
  job: Readonly<DecisionJob>; item: Readonly<DecisionJobItem>; attempt: Readonly<DecisionJobItem['attempts'][number]>;
}) => Promise<ExecutionUnknownResolution | null>;
export interface JobReconcileOptions {
  /** Off by default. When set, `execution-unknown` items are offered to the resolver after reconciliation. */
  resolveUnknown?: ExecutionUnknownResolver;
}
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const EFFECT_ID = /^eff1_[a-z2-7]{51}[aq]$/;
function acceptedResolution(value: ExecutionUnknownResolution | null | undefined): value is ExecutionUnknownResolution {
  return !!value && value.reason === 'digest-match' && ['succeeded', 'abstained', 'review'].includes(value.state) &&
    typeof value.receiptDigest === 'string' && DIGEST.test(value.receiptDigest) &&
    typeof value.resultDigest === 'string' && DIGEST.test(value.resultDigest) &&
    typeof value.effectId === 'string' && EFFECT_ID.test(value.effectId);
}

/** Offline lifecycle only: no provider calls or action execution. Scope comes from trusted authentication. */
type JobOperation = 'submit' | 'transition' | 'retry' | 'cancel' | 'reconcile' | 'expire' | 'delete' | 'hold' | 'release-hold';
export class DecisionJobRuntime {
  constructor(private readonly store: JobStore, private readonly now: () => number = Date.now,
    private readonly telemetry?: DecisionTelemetryHook) {}

  private async trace(snapshot: JobSnapshot, operation: JobOperation): Promise<void> {
    if (!this.telemetry) return;
    try {
      const builder = new DecisionTraceBuilder(undefined, this.now);
      const safeOperation = (['submit', 'transition', 'retry', 'cancel', 'reconcile', 'expire', 'delete', 'hold', 'release-hold'] as const)
        .includes(operation) ? operation : 'transition';
      const span = builder.startSpan('decision.job', { attributes: {
        'aiwg.job.operation': safeOperation, 'aiwg.job.status': snapshot.job.state,
        'aiwg.job.revision': snapshot.revision, 'aiwg.job.item_count': snapshot.job.items.length,
        'aiwg.job.unknown_count': snapshot.job.summary['execution-unknown'],
      }, provenance: {
        'aiwg.job.operation': 'client-derived', 'aiwg.job.status': 'client-derived',
        'aiwg.job.revision': 'client-derived', 'aiwg.job.item_count': 'client-derived',
        'aiwg.job.unknown_count': 'client-derived',
      } });
      builder.endSpan(span);
      await this.telemetry.emit(builder.build().spans[0]!);
    } catch { /* observability must never change durable state or authorize actions */ }
  }

  async submit(job: DecisionJob, actor: JobScope): Promise<JobSnapshot> {
    this.authorize(actor, job.scope);
    if (this.now() >= job.expiresAtEpochMs) throw new JobConflictError('Expired job');
    const acquired = await this.store.acquire(job);
    if (acquired.owner) await this.trace(acquired.snapshot, 'submit');
    return acquired.snapshot;
  }
  async poll(actor: JobScope, id: string): Promise<JobSnapshot | null> {
    const snapshot = await this.store.read(actor, id);
    return snapshot && !snapshot.deleted ? snapshot : null;
  }
  async accounting(actor: JobScope, id: string, receipts: DecisionReceiptStore,
    batches?: BatchReceiptStore): Promise<JobAccountingReport | null> {
    const snapshot = await this.poll(actor, id);
    return snapshot ? accountDecisionJob(snapshot.job, receipts, batches) : null;
  }
  async items(actor: JobScope, id: string, offset = 0, limit = 100): Promise<DecisionJobItem[] | null> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new JobConflictError('Invalid page');
    const snapshot = await this.poll(actor, id);
    return snapshot ? structuredClone(snapshot.job.items.slice(offset, offset + limit)) : null;
  }
  async advance(actor: JobScope, id: string, expected: JobSnapshot, next: DecisionJob, operation: JobOperation = 'transition'): Promise<JobSnapshot> {
    this.authorize(actor, expected.job.scope);
    if (expected.job.id !== id || this.now() >= expected.job.expiresAtEpochMs) throw new JobConflictError('Job expired or mismatched');
    const proposed = { revision: expected.revision + 1, job: structuredClone(next), deleted: false, legalHold: expected.legalHold ?? false };
    if (!await this.store.compareAndSwap(expected, proposed)) throw new JobConflictError('Concurrent job update');
    await this.trace(proposed, operation);
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
    return this.advance(actor, id, previous, next, 'retry');
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
    return this.advance(actor, id, previous, next, 'cancel');
  }
  /**
   * Explicit offline restart reconciliation. Never re-dispatch an attempt whose transport may have started.
   * With `resolveUnknown` (opt-in, D16), the reconciled `execution-unknown` items are then offered to the
   * resolver; without it the result is exactly the default reconciliation.
   */
  async reconcile(actor: JobScope, id: string, options: JobReconcileOptions = {}): Promise<JobSnapshot | null> {
    const reconciled = await this.reconcileDispatches(actor, id);
    if (!reconciled || !options.resolveUnknown) return reconciled;
    return this.resolveUnknown(actor, id, options.resolveUnknown);
  }
  /**
   * D16 opt-in resolver (#2722): promote `execution-unknown` items whose resolver returns a verified
   * `digest-match` resolution, through the one gated contract transition out of `execution-unknown`.
   * The job state is kept; absent, unknown, `state-match` or a failing resolver leave the item as it is.
   * Never dispatches.
   */
  async resolveUnknown(actor: JobScope, id: string, resolver: ExecutionUnknownResolver): Promise<JobSnapshot | null> {
    const previous = await this.poll(actor, id);
    if (!previous) return null;
    this.authorize(actor, previous.job.scope);
    const next = structuredClone(previous.job);
    let resolved = 0;
    for (const item of next.items) {
      const attempt = item.attempts.at(-1);
      if (item.state !== 'execution-unknown' || !attempt || attempt.outcome !== 'execution-unknown') continue;
      let resolution: ExecutionUnknownResolution | null = null;
      try {
        resolution = await resolver({ job: structuredClone(previous.job), item: structuredClone(item), attempt: structuredClone(attempt) });
      } catch { resolution = null; }
      if (!acceptedResolution(resolution)) continue;
      attempt.outcome = 'succeeded';
      attempt.receiptDigest = resolution.receiptDigest;
      attempt.resolution = { method: 'effect-ledger', effectId: resolution.effectId, reason: 'digest-match', receiptDigest: resolution.receiptDigest };
      item.state = resolution.state;
      item.resultDigest = resolution.resultDigest;
      resolved++;
    }
    if (!resolved) return previous;
    recount(next);
    validateDecisionJob(next);
    const proposed = { revision: previous.revision + 1, job: next, deleted: false, legalHold: previous.legalHold ?? false };
    if (!await this.store.compareAndSwap(previous, proposed)) throw new JobConflictError('Concurrent job update');
    await this.trace(proposed, 'reconcile');
    return proposed;
  }
  private async reconcileDispatches(actor: JobScope, id: string): Promise<JobSnapshot | null> {
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
    return this.advance(actor, id, previous, next, 'reconcile');
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
    const proposed = { revision: previous.revision + 1, job: next, deleted: false, legalHold: previous.legalHold ?? false };
    if (!await this.store.compareAndSwap(previous, proposed)) throw new JobConflictError('Concurrent job update');
    await this.trace(proposed, 'expire');
    return proposed;
  }
  async setLegalHold(actor: JobScope, id: string, enabled: boolean): Promise<JobSnapshot | null> {
    if (typeof enabled !== 'boolean') throw new JobConflictError('Invalid legal hold');
    const previous = await this.poll(actor, id);
    if (!previous) return null;
    if (Boolean(previous.legalHold) === enabled) return previous;
    const next = { ...previous, revision: previous.revision + 1, legalHold: enabled };
    if (!await this.store.compareAndSwap(previous, next)) throw new JobConflictError('Concurrent job update');
    await this.trace(next, enabled ? 'hold' : 'release-hold');
    return next;
  }
  async remove(actor: JobScope, id: string): Promise<boolean> {
    const previous = await this.poll(actor, id);
    if (!previous) return false;
    if (previous.legalHold) throw new JobConflictError('Legal hold prohibits deletion');
    const next = { ...previous, revision: previous.revision + 1, deleted: true, legalHold: false };
    if (!await this.store.compareAndSwap(previous, next)) throw new JobConflictError('Concurrent job update');
    await this.trace(next, 'delete');
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
