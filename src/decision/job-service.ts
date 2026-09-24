import { DecisionJobGateway } from './job-gateway.js';
import { admittedJobItemExecutor } from './job-evaluate.js';
import { artifactDigest } from './validate.js';
import type { DecisionEvaluationRequest, DecisionReceiptStore } from './types.js';
import type { DecisionJobItem } from './job-contract.js';
import type { JobReservation, OfflineItemExecutor } from './job-worker.js';
import { FileJobPollLimiter } from './job-poll-limiter.js';
import { FileJobPayloadStore } from './job-payload-store.js';
import { FileJobQuotaStore, type JobQuotaPolicy } from './job-quota.js';
import { DecisionJobRuntime } from './job-runtime.js';
import { OfflineJobScheduler } from './job-scheduler.js';
import { OfflineJobWorker } from './job-worker.js';
import { FileJobStore, JobConflictError, type JobScope, type JobSnapshot } from './job-store.js';
import { canonicalJson } from '../security/artifact-trust.js';
import type { DecisionTelemetryHook } from './telemetry/types.js';
import { validateDecisionLifecyclePolicy, type DecisionLifecyclePolicy } from './lifecycle.js';
import type { DecisionJob } from './job-contract.js';

export interface OfflineDecisionJobServiceConfig {
  directory: string;
  /** Host-owned secret, retrieved at runtime; never put in a job or model state. */
  handleKey: Buffer;
  payloadKey: Buffer;
  payloadMaxItemBytes: number;
  now?: () => number;
  quota: JobQuotaPolicy;
  lifecyclePolicy: DecisionLifecyclePolicy;
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
  validateDecisionLifecyclePolicy(config.lifecyclePolicy);
  if (config.lifecyclePolicy.surfaces.job.backup !== 'expire-with-primary' ||
      config.lifecyclePolicy.surfaces.job.deletion !== 'erase')
    throw new JobConflictError('Persisted job requires erasure and backup expiry policy');
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
  const admitJob = (job: DecisionJob) => {
    const duration = job.expiresAtEpochMs - job.createdAtEpochMs;
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > config.lifecyclePolicy.surfaces.job.retentionMs)
      throw new JobConflictError('Job exceeds D10 retention policy');
  };
  const gateway = new DecisionJobGateway(runtime, config.handleKey, now, actor => polling.check(actor), {
    listSnapshots: () => store.listSnapshots(), authorizeExport: async (actor, snapshot) =>
      config.lifecyclePolicy.surfaces.job.export === 'sanitized' && await config.authorizeExport(actor, snapshot),
  }, admitJob);
  /** Host maintenance: bound queued dwell by the pinned expiry even after a restart. */
  const sweepExpired = async (): Promise<number> => {
    let expired = 0;
    for (const record of await store.listSnapshots()) {
      if (record.deleted || now() < record.job.expiresAtEpochMs ||
          ['expired', 'canceled', 'completed', 'failed'].includes(record.job.state)) continue;
      try {
        if ((await runtime.expire(record.job.scope, record.job.id))?.job.state === 'expired') expired++;
      } catch (error) {
        if (!(error instanceof JobConflictError) || error.message !== 'Concurrent job update') throw error;
        // Another process owns the winning revision. Do not retry or dispatch here.
      }
    }
    return expired;
  };
  /** D10 eraser callback: publish D10 tombstone first, then call this; retries are safe after partial erasure. */
  const eraseJob = async (scope: JobScope, id: string): Promise<void> => {
    if (!await config.externallyDeleted(scope, id)) throw new JobConflictError('Independent job tombstone required');
    const raw = await new FileJobStore(config.directory).read(scope, id);
    if (raw && (!raw.deleted || raw.legalHold)) throw new JobConflictError('Authorized job deletion required');
    await payloads.purgeDeleted(scope, id);
    await store.purgeDeleted(scope, id);
  };
  /** Recover a completed result from its durable D03 receipt, never by replaying the provider. */
  const materializeResult = async (actor: JobScope, id: string, itemId: string, receipts: DecisionReceiptStore): Promise<boolean> => {
    const snapshot = await runtime.poll(actor, id);
    const item = snapshot?.job.items.find(entry => entry.id === itemId);
    const attempt = item?.attempts.at(-1);
    if (!snapshot || !item || !['succeeded', 'review', 'abstained'].includes(item.state) ||
        !item.resultDigest || !attempt?.receiptDigest || attempt.outcome !== 'succeeded')
      throw new JobConflictError('Validated job result unavailable');
    const receipt = await receipts.read(attempt.id, actor.projectId);
    if (!receipt || receipt.state !== 'completed' || !receipt.result ||
        artifactDigest(receipt) !== attempt.receiptDigest || artifactDigest(receipt.result) !== item.resultDigest)
      throw new JobConflictError('Validated job receipt unavailable');
    await payloads.put(actor, id, itemId, 'result', receipt.result);
    return true;
  };
  /** Dispatches only the already admitted synchronous evaluator using protected pinned input. */
  const runAdmittedItem = async (actor: JobScope, id: string, itemId: string,
    requestFor: (item: Readonly<DecisionJobItem>, input: unknown, signal: AbortSignal) => DecisionEvaluationRequest,
    reservation: JobReservation): Promise<JobSnapshot> => {
    const snapshot = await runtime.poll(actor, id);
    if (!snapshot) throw new JobConflictError('Job unavailable');
    let receipts: DecisionReceiptStore | undefined;
    const execute: OfflineItemExecutor = async (item, signal) => {
      const input = await payloads.get(actor, id, item.id, 'input');
      if (input === null) throw new JobConflictError('Protected job input unavailable');
      return admittedJobItemExecutor(snapshot.job, (candidate, active) => {
        const request = requestFor(candidate, input, active);
        receipts = request.receiptStore;
        return request;
      })(item, signal);
    };
    execute.requiresReservation = true;
    const finished = await worker.run(actor, id, itemId, execute, reservation);
    const item = finished.job.items.find(candidate => candidate.id === itemId);
    if (item && ['succeeded', 'review', 'abstained'].includes(item.state)) {
      if (!receipts) throw new JobConflictError('Durable decision receipts required');
      await materializeResult(actor, id, itemId, receipts);
    }
    return finished;
  };
  return { gateway, runtime, worker, scheduler, payloads, eraseJob, sweepExpired, runAdmittedItem, materializeResult };
}
