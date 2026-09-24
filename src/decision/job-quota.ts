import { join } from 'node:path';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { acquireDirectoryLock } from '../artifacts/prebuilt-build-lock.js';
import { canonicalJson } from '../security/artifact-trust.js';
import type { DecisionJob } from './job-contract.js';
import { canonicalizeInitialJob, FileJobStore, JobConflictError, type JobScope, type JobSnapshot, type JobStore } from './job-store.js';

export interface JobQuotaLimits {
  queued: number; running: number; retainedItems: number; retainedBytes: number;
  tokens: number; costMicros: number; calls: number; jobs: number;
}
export interface JobQuotaPolicy { principal: JobQuotaLimits; project: JobQuotaLimits }
const quantities = ['queued', 'running', 'retainedItems', 'retainedBytes', 'tokens', 'costMicros', 'calls', 'jobs'] as const;
/** Explicit operator-gated local recovery; never steal a live or unverified lock. */
export async function recoverStaleJobQuotaLock(directory: string,
  authorize: (owner: { pid: number; token: string }) => Promise<boolean>): Promise<boolean> {
  if (typeof authorize !== 'function') throw new JobConflictError('Job lock recovery requires authorization');
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0)
    throw new JobConflictError('Job storage root must be private');
  const guard = join(directory, '.quota-recover');
  try { await mkdir(guard, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  try {
    const lock = join(directory, '.quota-lock');
    let info;
    try { info = await lstat(lock); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new JobConflictError('Invalid job lock');
    const ownerFile = join(lock, 'owner');
    const ownerInfo = await lstat(ownerFile);
    if (!ownerInfo.isFile() || (ownerInfo.mode & 0o077) !== 0) throw new JobConflictError('Invalid job lock owner');
    const token = (await readFile(ownerFile, 'utf8')).trim();
    const match = /^([1-9][0-9]*):([0-9a-f-]{36})$/.exec(token);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new JobConflictError('Invalid job lock owner');
    const pid = Number(match[1]);
    const isDead = () => {
      try { process.kill(pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
    };
    if (!isDead()) return false;
    let approved = false;
    try { approved = await authorize({ pid, token }); } catch { /* deny recovery */ }
    if (!approved || !isDead() || (await readFile(ownerFile, 'utf8')).trim() !== token) return false;
    await rm(lock, { recursive: true });
    return true;
  } finally { await rm(guard, { recursive: true, force: true }); }
}
/** Same-host, local-filesystem transactional quota gate. All writers to the store must use this wrapper. */
export class FileJobQuotaStore implements JobStore {
  private readonly journal: FileJobStore;
  private readonly lockPath: string;
  private readonly limits: JobQuotaPolicy;
  constructor(directory: string, limits: JobQuotaPolicy,
    externallyDeleted?: (scope: JobScope, id: string) => Promise<boolean>,
    private readonly payloadBytes?: (scope: JobScope, tier: 'principal' | 'project') => Promise<number>) {
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
  /** Call only after the independent D10 tombstone and authorized deletion. */
  async purgeDeleted(scope: JobScope, id: string): Promise<void> {
    await this.journal.read(scope, id);
    await this.transaction(() => this.journal.purgeDeleted(scope, id));
  }
  async acquire(job: DecisionJob): Promise<{ owner: boolean; snapshot: JobSnapshot }> {
    job = canonicalizeInitialJob(job);
    await this.journal.read(job.scope, job.id);
    return this.transaction(async () => {
      const existing = await this.journal.read(job.scope, job.id);
      if (!existing) await this.check(await this.journal.listSnapshots(), { revision: 1, job, deleted: false });
      return this.journal.acquire(job);
    });
  }
  async compareAndSwap(previous: JobSnapshot, next: JobSnapshot): Promise<boolean> {
    await this.journal.read(previous.job.scope, previous.job.id);
    return this.transaction(async () => {
      const current = await this.journal.read(previous.job.scope, previous.job.id);
      if (!current || canonicalJson(current) !== canonicalJson(previous)) return false;
      await this.check(await this.journal.listSnapshots(), next, previous);
      return this.journal.compareAndSwap(previous, next);
    });
  }
  private async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Fail closed rather than stealing a stale/slow owner's lock; operator must reconcile a crash.
    const release = await acquireDirectoryLock(this.lockPath, { timeoutMs: 5000, pollMs: 20 });
    try { return await fn(); } finally { await release(); }
  }
  private async check(records: JobSnapshot[], proposed: JobSnapshot, previous?: JobSnapshot): Promise<void> {
    const scope = proposed.job.scope;
    const effective = records.filter(record => !previous || canonicalJson(record.job.scope) !== canonicalJson(scope) || record.job.id !== proposed.job.id);
    effective.push(proposed);
    const tiers: Array<['project' | 'principal', JobQuotaLimits, (job: DecisionJob) => boolean]> = [
      ['project', this.limits.project, job => job.scope.tenantId === scope.tenantId && job.scope.projectId === scope.projectId],
      ['principal', this.limits.principal, job => job.scope.tenantId === scope.tenantId && job.scope.projectId === scope.projectId &&
        job.scope.workspaceId === scope.workspaceId && job.scope.principalId === scope.principalId],
    ];
    for (const [tier, limits, belongs] of tiers) {
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
      if (this.payloadBytes) totals.retainedBytes += await this.payloadBytes(scope, tier);
      if (quantities.some(quantity => !Number.isSafeInteger(totals[quantity]) || totals[quantity] > limits[quantity]))
        throw new JobConflictError('Job capacity unavailable');
    }
  }
}
