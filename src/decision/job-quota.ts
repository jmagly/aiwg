import { join } from 'node:path';
import { acquireDirectoryLock } from '../artifacts/prebuilt-build-lock.js';
import { canonicalJson } from '../security/artifact-trust.js';
import type { DecisionJob } from './job-contract.js';
import { FileJobStore, JobConflictError, type JobScope, type JobSnapshot, type JobStore } from './job-store.js';

export interface JobQuotaLimits {
  queued: number; running: number; retainedItems: number; retainedBytes: number;
  tokens: number; costMicros: number; calls: number; jobs: number;
}
export interface JobQuotaPolicy { principal: JobQuotaLimits; project: JobQuotaLimits }
const quantities = ['queued', 'running', 'retainedItems', 'retainedBytes', 'tokens', 'costMicros', 'calls', 'jobs'] as const;
/** Same-host, local-filesystem transactional quota gate. All writers to the store must use this wrapper. */
export class FileJobQuotaStore implements JobStore {
  private readonly journal: FileJobStore;
  private readonly lockPath: string;
  private readonly limits: JobQuotaPolicy;
  constructor(directory: string, limits: JobQuotaPolicy,
    externallyDeleted?: (scope: JobScope, id: string) => Promise<boolean>) {
    this.journal = new FileJobStore(directory, externallyDeleted);
    this.lockPath = join(directory, '.quota-lock');
    this.limits = structuredClone(limits);
    for (const tier of [this.limits.principal, this.limits.project]) for (const quantity of quantities) {
      if (!Number.isSafeInteger(tier[quantity]) || tier[quantity] < 0)
        throw new JobConflictError('Invalid job quota policy');
    }
  }
  read(scope: JobScope, id: string): Promise<JobSnapshot | null> { return this.journal.read(scope, id); }
  /** Host-only listing; the gateway filters and authenticates every returned object. */
  listSnapshots(): Promise<JobSnapshot[]> { return this.journal.listSnapshots(); }
  async acquire(job: DecisionJob): Promise<{ owner: boolean; snapshot: JobSnapshot }> {
    await this.journal.read(job.scope, job.id);
    return this.transaction(async () => {
      const existing = await this.journal.read(job.scope, job.id);
      if (!existing) this.check(await this.journal.listSnapshots(), { revision: 1, job, deleted: false });
      return this.journal.acquire(job);
    });
  }
  async compareAndSwap(previous: JobSnapshot, next: JobSnapshot): Promise<boolean> {
    await this.journal.read(previous.job.scope, previous.job.id);
    return this.transaction(async () => {
      const current = await this.journal.read(previous.job.scope, previous.job.id);
      if (!current || canonicalJson(current) !== canonicalJson(previous)) return false;
      this.check(await this.journal.listSnapshots(), next, previous);
      return this.journal.compareAndSwap(previous, next);
    });
  }
  private async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Fail closed rather than stealing a stale/slow owner's lock; operator must reconcile a crash.
    const release = await acquireDirectoryLock(this.lockPath, { timeoutMs: 5000, pollMs: 20 });
    try { return await fn(); } finally { await release(); }
  }
  private check(records: JobSnapshot[], proposed: JobSnapshot, previous?: JobSnapshot): void {
    const scope = proposed.job.scope;
    const effective = records.filter(record => !previous || canonicalJson(record.job.scope) !== canonicalJson(scope) || record.job.id !== proposed.job.id);
    effective.push(proposed);
    const tiers: Array<[JobQuotaLimits, (job: DecisionJob) => boolean]> = [
      [this.limits.project, job => job.scope.tenantId === scope.tenantId && job.scope.projectId === scope.projectId],
      [this.limits.principal, job => job.scope.tenantId === scope.tenantId && job.scope.projectId === scope.projectId &&
        job.scope.workspaceId === scope.workspaceId && job.scope.principalId === scope.principalId],
    ];
    for (const [limits, belongs] of tiers) {
      const totals = Object.fromEntries(quantities.map(quantity => [quantity, 0])) as Record<typeof quantities[number], number>;
      for (const record of effective) {
        if (record.deleted || !belongs(record.job)) continue;
        const job = record.job;
        totals.jobs++;
        totals.queued += job.summary.queued + job.summary['retryable-failed'];
        totals.running += job.summary.running;
        totals.retainedItems += job.items.length;
        totals.retainedBytes += Buffer.byteLength(canonicalJson(job), 'utf8');
        totals.tokens += job.budget.maxTokens;
        totals.costMicros += job.budget.maxCostMicros;
        totals.calls += job.items.length * job.budget.maxAttempts;
      }
      if (quantities.some(quantity => !Number.isSafeInteger(totals[quantity]) || totals[quantity] > limits[quantity]))
        throw new JobConflictError('Job capacity unavailable');
    }
  }
}
