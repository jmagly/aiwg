import { randomUUID } from 'node:crypto';
import { type DecisionJobItem } from './job-contract.js';
import { recount, DecisionJobRuntime } from './job-runtime.js';
import { JobConflictError, type JobScope, type JobSnapshot } from './job-store.js';

/** Explicitly offline fixture executor. No provider endpoint or implicit dispatch is enabled. */
export interface OfflineJobResult {
  state: 'succeeded' | 'abstained' | 'review' | 'unsupported' | 'retryable-failed' | 'permanent-failed';
  /** For authoritative result states, both references must identify governed validated evidence. */
  receiptDigest?: `sha256:${string}`;
  resultDigest?: `sha256:${string}`;
  errorCode?: string;
}
export type OfflineItemExecutor = ((item: Readonly<DecisionJobItem>, signal: AbortSignal) => Promise<OfflineJobResult>) &
  { requiresReservation?: boolean };
export interface JobReservation { tokens: number; costMicros: number }
/**
 * Optional D16 effect recording (#2722): called once an admitted item has a validated D03 receipt,
 * before the job record is updated, so a crash between the two leaves a verifiable effect behind.
 * It records digests only and must never dispatch. Failures are ignored: the job record stays authoritative.
 */
export interface JobItemEffectRecorder {
  recordReceipt(input: { scope: JobScope; jobId: string; itemId: string; attemptId: string;
    requestDigest: `sha256:${string}`; receiptDigest: `sha256:${string}` }): Promise<void>;
}

export class OfflineJobWorker {
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly runtime: DecisionJobRuntime, private readonly effects?: JobItemEffectRecorder) {}

  /** Persist a dispatch fence before invoking the fixture; ambiguous failures never replay. */
  async run(actor: JobScope, jobId: string, itemId: string, executor: OfflineItemExecutor,
    reservation?: JobReservation): Promise<JobSnapshot> {
    const previous = await this.runtime.poll(actor, jobId);
    if (!previous) throw new JobConflictError('Job unavailable');
    const item = previous.job.items.find(candidate => candidate.id === itemId);
    if (!item || item.state !== 'queued' || !['queued', 'running', 'partially-completed'].includes(previous.job.state) ||
        item.attempts.length >= previous.job.budget.maxAttempts ||
        previous.job.items.filter(candidate => candidate.state === 'running').length >= previous.job.budget.maxConcurrency)
      throw new JobConflictError('Item cannot be dispatched');
    if (executor.requiresReservation && !reservation) throw new JobConflictError('Provider work requires budget reservation');
    if (reservation) {
      if (!Number.isSafeInteger(reservation.tokens) || reservation.tokens < 0 ||
          !Number.isSafeInteger(reservation.costMicros) || reservation.costMicros < 0)
        throw new JobConflictError('Invalid job budget reservation');
      const attempts = previous.job.items.flatMap(candidate => candidate.attempts);
      const spentTokens = attempts.reduce((sum, attempt) => sum + (attempt.reservedTokens ?? 0), 0);
      const spentCost = attempts.reduce((sum, attempt) => sum + (attempt.reservedCostMicros ?? 0), 0);
      if (spentTokens + reservation.tokens > previous.job.budget.maxTokens ||
          spentCost + reservation.costMicros > previous.job.budget.maxCostMicros)
        throw new JobConflictError('Job budget reservation exceeded');
    }
    const next = structuredClone(previous.job);
    const scheduled = next.items.find(candidate => candidate.id === itemId)!;
    scheduled.state = 'running';
    scheduled.attempts.push({ id: randomUUID(), requestDigest: item.fingerprint, outcome: 'dispatched',
      ...(reservation ? { reservedTokens: reservation.tokens, reservedCostMicros: reservation.costMicros } : {}) });
    next.state = previous.job.state === 'queued' ? 'running' : previous.job.state;
    recount(next);
    const key = `${JSON.stringify(actor)}:${jobId}:${itemId}:${scheduled.attempts.at(-1)!.id}`;
    const controller = new AbortController();
    this.active.set(key, controller);
    // Register cancellation before publishing the fence; CAS losers never call the executor.
    try { await this.runtime.advance(actor, jobId, previous, next); }
    catch (error) { this.active.delete(key); throw error; }
    let outcome: OfflineJobResult | null = null;
    let onAbort: (() => void) | undefined;
    try {
      if (!controller.signal.aborted) {
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new JobConflictError('Execution interrupted'));
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        outcome = await Promise.race([executor(structuredClone(scheduled), controller.signal), aborted]);
      }
    } catch { /* A thrown/aborted fixture may have executed; do not replay. */ }
    finally {
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      this.active.delete(key);
    }
    const fenced = scheduled.attempts.at(-1)!;
    if (this.effects && outcome && !controller.signal.aborted && validOutcome(outcome) && outcome.receiptDigest &&
        ['succeeded', 'abstained', 'review'].includes(outcome.state)) {
      try {
        await this.effects.recordReceipt({ scope: structuredClone(previous.job.scope), jobId, itemId, attemptId: fenced.id,
          requestDigest: fenced.requestDigest, receiptDigest: outcome.receiptDigest });
      } catch { /* Recovery evidence only; the job record below stays authoritative. */ }
    }
    // Concurrent items may finish in the same tick. Retry only the local CAS, never the executor.
    for (let retry = 0; retry < 5; retry++) {
      const latest = await this.runtime.poll(actor, jobId);
      if (!latest) throw new JobConflictError('Job removed during execution');
      const current = latest.job.items.find(candidate => candidate.id === itemId);
      if (!current || current.state !== 'running' || current.attempts.at(-1)?.id !== scheduled.attempts.at(-1)?.id)
        throw new JobConflictError('In-flight item changed during execution');
      const updated = structuredClone(latest.job);
      const target = updated.items.find(candidate => candidate.id === itemId)!;
      const attempt = target.attempts.at(-1)!;
      if (controller.signal.aborted || !outcome || !validOutcome(outcome)) {
        target.state = 'execution-unknown'; attempt.outcome = 'execution-unknown';
      } else {
        target.state = outcome.state;
        attempt.outcome = ['succeeded', 'abstained', 'review'].includes(outcome.state) ? 'succeeded' : 'failed';
        if (outcome.receiptDigest) attempt.receiptDigest = outcome.receiptDigest;
        if (outcome.resultDigest) target.resultDigest = outcome.resultDigest;
        if (outcome.errorCode) target.errorCode = outcome.errorCode;
      }
      recount(updated);
      const outstanding = updated.summary.queued + updated.summary.running + updated.summary['retryable-failed'];
      const unknown = updated.summary['execution-unknown'] > 0;
      if (latest.job.state === 'cancel-requested') {
        updated.state = unknown ? 'failed' : outstanding ? 'partially-completed' : 'canceled';
      } else updated.state = outstanding ? 'partially-completed' : unknown ? 'failed' : 'completed';
      try { return await this.runtime.advance(actor, jobId, latest, updated); }
      catch (error) {
        if (!(error instanceof JobConflictError) || error.message !== 'Concurrent job update') throw error;
      }
    }
    throw new JobConflictError('Concurrent job updates exhausted');
  }

  async cancel(actor: JobScope, jobId: string): Promise<JobSnapshot | null> {
    const snapshot = await this.runtime.cancel(actor, jobId);
    if (snapshot) for (const [key, controller] of this.active) {
      if (key.startsWith(`${JSON.stringify(actor)}:${jobId}:`)) controller.abort();
    }
    return snapshot;
  }
}
function validOutcome(outcome: OfflineJobResult): boolean {
  if (!outcome || !['succeeded', 'abstained', 'review', 'unsupported', 'retryable-failed', 'permanent-failed'].includes(outcome.state)) return false;
  const digest = (value: unknown): boolean => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
  if (['succeeded', 'abstained', 'review'].includes(outcome.state))
    return digest(outcome.receiptDigest) && digest(outcome.resultDigest) && outcome.errorCode === undefined;
  return !outcome.resultDigest && !outcome.receiptDigest &&
    (outcome.errorCode === undefined || /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(outcome.errorCode));
}
