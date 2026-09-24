import { DecisionJobGateway } from './job-gateway.js';
import { FileJobPollLimiter } from './job-poll-limiter.js';
import { FileJobQuotaStore, type JobQuotaPolicy } from './job-quota.js';
import { DecisionJobRuntime } from './job-runtime.js';
import { OfflineJobScheduler } from './job-scheduler.js';
import { OfflineJobWorker } from './job-worker.js';
import type { JobScope, JobSnapshot } from './job-store.js';
import type { DecisionTelemetryHook } from './telemetry/types.js';

export interface OfflineDecisionJobServiceConfig {
  directory: string;
  /** Host-owned secret, retrieved at runtime; never put in a job or model state. */
  handleKey: Buffer;
  now?: () => number;
  quota: JobQuotaPolicy;
  polls: { windowMs: number; perPrincipal: number; perProject: number; maxLanes: number };
  scheduler: { concurrency: number; maxQueuedItems: number };
  /** Independent D10 lifecycle authority; backed-up local markers are not sufficient. */
  externallyDeleted: (scope: JobScope, id: string) => Promise<boolean>;
  authorizeExport: (actor: JobScope, snapshot: JobSnapshot) => Promise<boolean>;
  telemetry?: DecisionTelemetryHook;
}
/** Disabled-by-default offline assembly. Host must supply authenticated actors and admitted item executors. */
export function createOfflineDecisionJobService(config: OfflineDecisionJobServiceConfig) {
  if (typeof config.externallyDeleted !== 'function' || typeof config.authorizeExport !== 'function')
    throw new Error('Independent lifecycle and export authorization required');
  const now = config.now ?? Date.now;
  const store = new FileJobQuotaStore(config.directory, config.quota, config.externallyDeleted);
  const runtime = new DecisionJobRuntime(store, now, config.telemetry);
  const worker = new OfflineJobWorker(runtime);
  const scheduler = new OfflineJobScheduler(worker, config.scheduler.concurrency, config.scheduler.maxQueuedItems);
  const polling = new FileJobPollLimiter(config.directory, config.polls.windowMs,
    config.polls.perPrincipal, config.polls.perProject, config.polls.maxLanes, now);
  const gateway = new DecisionJobGateway(runtime, config.handleKey, now, actor => polling.check(actor), {
    listSnapshots: () => store.listSnapshots(), authorizeExport: config.authorizeExport,
  });
  return { gateway, runtime, worker, scheduler };
}
