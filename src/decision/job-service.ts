import { DecisionJobGateway } from './job-gateway.js';
import { FileJobPollLimiter } from './job-poll-limiter.js';
import { FileJobPayloadStore } from './job-payload-store.js';
import { FileJobQuotaStore, type JobQuotaPolicy } from './job-quota.js';
import { DecisionJobRuntime } from './job-runtime.js';
import { OfflineJobScheduler } from './job-scheduler.js';
import { OfflineJobWorker } from './job-worker.js';
import { FileJobStore, JobConflictError, type JobScope, type JobSnapshot } from './job-store.js';
import { canonicalJson } from '../security/artifact-trust.js';
import type { DecisionTelemetryHook } from './telemetry/types.js';

export interface OfflineDecisionJobServiceConfig {
  directory: string;
  /** Host-owned secret, retrieved at runtime; never put in a job or model state. */
  handleKey: Buffer;
  payloadKey: Buffer;
  payloadMaxItemBytes: number;
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
  let payloads!: FileJobPayloadStore;
  const store = new FileJobQuotaStore(config.directory, config.quota, config.externallyDeleted,
    (scope, tier) => payloads.usage(scope, tier));
  const metadataBytes = async (scope: JobScope, tier: 'principal' | 'project') => {
    const records = await store.listSnapshots();
    return records.filter(record => !record.deleted && record.job.scope.tenantId === scope.tenantId &&
      record.job.scope.projectId === scope.projectId && (tier === 'project' ||
        record.job.scope.workspaceId === scope.workspaceId && record.job.scope.principalId === scope.principalId))
      .reduce((sum, record) => sum + Buffer.byteLength(canonicalJson(record.job), 'utf8'), 0);
  };
  payloads = new FileJobPayloadStore(config.directory, config.payloadKey,
    new FileJobStore(config.directory, config.externallyDeleted), config.externallyDeleted,
    { itemBytes: config.payloadMaxItemBytes, principalBytes: config.quota.principal.retainedBytes,
      projectBytes: config.quota.project.retainedBytes }, now, metadataBytes);
  const runtime = new DecisionJobRuntime(store, now, config.telemetry);
  const worker = new OfflineJobWorker(runtime);
  const scheduler = new OfflineJobScheduler(worker, config.scheduler.concurrency, config.scheduler.maxQueuedItems);
  const polling = new FileJobPollLimiter(config.directory, config.polls.windowMs,
    config.polls.perPrincipal, config.polls.perProject, config.polls.maxLanes, now);
  const gateway = new DecisionJobGateway(runtime, config.handleKey, now, actor => polling.check(actor), {
    listSnapshots: () => store.listSnapshots(), authorizeExport: config.authorizeExport,
  });
  /** D10 eraser callback: publish D10 tombstone first, then call this; retries are safe after partial erasure. */
  const eraseJob = async (scope: JobScope, id: string): Promise<void> => {
    if (!await config.externallyDeleted(scope, id)) throw new JobConflictError('Independent job tombstone required');
    const raw = await new FileJobStore(config.directory).read(scope, id);
    if (raw && (!raw.deleted || raw.legalHold)) throw new JobConflictError('Authorized job deletion required');
    await payloads.purgeDeleted(scope, id);
    await store.purgeDeleted(scope, id);
  };
  return { gateway, runtime, worker, scheduler, payloads, eraseJob };
}
