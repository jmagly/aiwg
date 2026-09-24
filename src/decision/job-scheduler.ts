import { runBoundedFair, type SchedulerWaitError } from './scheduler.js';
import { JobConflictError, type JobScope, type JobSnapshot } from './job-store.js';
import { OfflineJobWorker, type JobReservation, type OfflineItemExecutor } from './job-worker.js';

export interface ScheduledJobItem {
  actor: JobScope;
  jobId: string;
  itemId: string;
  executor: OfflineItemExecutor;
  reservation?: JobReservation;
}

/** Offline round-robin across authenticated principal/project lanes; not a distributed admission authority. */
export class OfflineJobScheduler {
  constructor(private readonly worker: OfflineJobWorker, private readonly concurrency: number,
    private readonly maxQueuedItems: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
        !Number.isSafeInteger(maxQueuedItems) || maxQueuedItems < concurrency)
      throw new JobConflictError('Invalid job scheduler limits');
  }
  async run(work: ScheduledJobItem[], options: { signal?: AbortSignal; deadlineEpochMs?: number; now?: () => number } = {}):
    Promise<Array<JobSnapshot | SchedulerWaitError>> {
    if (work.length > this.maxQueuedItems) throw new JobConflictError('Job queue capacity exceeded');
    const keys = work.map(item => JSON.stringify([item.actor, item.jobId, item.itemId]));
    if (new Set(keys).size !== keys.length) throw new JobConflictError('Duplicate scheduled job item');
    return runBoundedFair(work.map(item => ({ value: item,
      lane: JSON.stringify([item.actor.tenantId, item.actor.projectId, item.actor.principalId]) })),
    this.concurrency, item => this.worker.run(item.actor, item.jobId, item.itemId, item.executor, item.reservation), options);
  }
}
