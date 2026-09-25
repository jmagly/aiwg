import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { admittedJobItemExecutor } from '../../../src/decision/job-evaluate.js';
import { createOfflineDecisionJobService } from '../../../src/decision/job-service.js';
import { jobPolicy } from './fixtures/job-policy.js';
import { accountDecisionJob } from '../../../src/decision/job-accounting.js';
import { artifactDigest } from '../../../src/decision/validate.js';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { DecisionJobRuntime, recount } from '../../../src/decision/job-runtime.js';
import { OfflineJobWorker } from '../../../src/decision/job-worker.js';
import { MemoryJobStore } from '../../../src/decision/job-store.js';
import { FileDecisionReceiptStore, MemoryDecisionReceiptStore } from '../../../src/decision/receipts.js';
import type { DecisionReceiptStore } from '../../../src/decision/types.js';
import type { DecisionAdapter, DecisionBinding, DecisionDefinition, DecisionRuleset } from '../../../src/decision/types.js';
import type { BatchReceiptStore, DecisionBatchReceipt } from '../../../src/decision/batch-receipts/types.js';
const fixture = <T>(name: string): T => JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
const scope = { tenantId: 't', projectId: 'p', workspaceId: 'workspace', principalId: 'principal' };
function setup(persistedReceipts?: DecisionReceiptStore) {
  const ruleset = fixture<DecisionRuleset>('ruleset.json');
  const binding = fixture<DecisionBinding>('binding-jev.json');
  const definitions = { category: fixture<DecisionDefinition>('decision-category.json'),
    severity: fixture<DecisionDefinition>('decision-severity.json'), core: fixture<DecisionDefinition>('decision-core_unavailable.json') };
  const input = fixture('input.json');
  const digest = artifactDigest(input);
  const job: DecisionJob = { schemaVersion: 'decision-job/v1', id: 'jobA', scope, fingerprint: digest, state: 'validating',
    items: [{ id: 'subject', fingerprint: digest, subjectDigest: digest,
      bindingDigest: artifactDigest(binding), definitionDigest: artifactDigest(definitions), rulesetDigest: artifactDigest(ruleset), state: 'queued', attempts: [] }],
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'],
    createdAtEpochMs: 10, expiresAtEpochMs: 100000000000000, budget: { maxAttempts: 3, maxTokens: 10000, maxCostMicros: 1000000, maxConcurrency: 1 } };
  recount(job);
  const adapter: DecisionAdapter = { id: 'jev', version: '1.0.0', capabilities: async () => ({
    answerKinds: ['choice', 'ordinal-score', 'truth-probability'],
    features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10,
    confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true, egress: { mode: 'none' as const },
  }), evaluate: vi.fn(async ({ alias }) => ({ status: 'success' as const, reason: 'none' as const,
    value: alias === 'category' ? 'documentation' : alias === 'severity' ? 0.25 : 0.05,
    uncertainty: { source: 'provider' as const, profile: alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1',
      calibration: 'vendor-claimed' as const, confidence: 0.9, distribution: null, calibrationRef: null },
    actualModel: 'fixture', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 }, requestId: 'fixture',
  })) };
  const receiptStore = persistedReceipts ?? new MemoryDecisionReceiptStore();
  const limits = { concurrency: 2, maxAttempts: 3, allowUnknownCost: false, maxCostUsd: 1, maxQueueLength: 5 };
  const requestFor = (item: DecisionJob['items'][number], signal: AbortSignal) => ({
    ruleset, binding, definitions, input, runId: 'run', invocationId: item.attempts.at(-1)!.id,
    adapters: { jev: adapter }, receiptStore, receiptProjectId: scope.projectId, signal,
    scheduler: { enabled: true, profileVersion: 'fixture', workspace: { id: scope.workspaceId, limits },
      principal: { id: scope.principalId, limits }, providers: { jev: limits },
      estimate: () => ({ tokens: 3, costUsd: 0.001, attempts: 1 }) },
  });
  return { job, adapter, receiptStore, requestFor };
}
describe('JOB admission-controlled evaluator bridge', () => {
  it('loads pinned protected input and materializes validated D03 results without provider replay after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'job-admitted-protected-'));
    try {
      const receiptStore = new FileDecisionReceiptStore(join(root, 'receipts'), { integrityKey: randomBytes(32) });
      const { job, adapter, requestFor } = setup(receiptStore);
      const handleKey = randomBytes(32); const payloadKey = randomBytes(32);
      const limits = { queued: 1, running: 1, retainedItems: 1, retainedBytes: 100000,
        tokens: 10000, costMicros: 1000000, calls: 3, jobs: 1 };
      const config = { directory: join(root, 'jobs'), handleKey, payloadKey, payloadMaxItemBytes: 50000,
        quota: { principal: limits, project: limits }, lifecyclePolicy: jobPolicy(100000000000000), now: () => 20,
        polls: { windowMs: 100, perPrincipal: 10, perProject: 10, maxLanes: 2 },
        scheduler: { concurrency: 1, maxQueuedItems: 1 },
        externallyDeleted: async () => false, authorizeExport: async () => false };
      const service = createOfflineDecisionJobService(config);
      const initial = await service.gateway.submit(scope, job);
      const protectedInput = fixture('input.json');
      await service.payloads.put(scope, job.id, 'subject', 'input', protectedInput);
      const queued = structuredClone(initial.snapshot.job); queued.state = 'queued';
      await service.runtime.advance(scope, job.id, initial.snapshot, queued);
      const finished = await service.runAdmittedItem(scope, job.id, 'subject',
        (item, input, signal) => ({ ...requestFor(item, signal), input }), { tokens: 10, costMicros: 10000 });
      expect(finished.job.state).toBe('completed');
      expect(adapter.evaluate).toHaveBeenCalled();
      const attempt = finished.job.items[0]!.attempts[0]!;
      const receipt = await receiptStore.read(attempt.id, scope.projectId);
      expect(await service.payloads.get(scope, job.id, 'subject', 'result')).toEqual(receipt?.result);
      const calls = (adapter.evaluate as ReturnType<typeof vi.fn>).mock.calls.length;
      const restarted = createOfflineDecisionJobService(config);
      expect(await restarted.materializeResult(scope, job.id, 'subject', receiptStore)).toBe(true);
      expect((adapter.evaluate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(calls);
      await expect(restarted.materializeResult({ ...scope, projectId: 'other' }, job.id, 'subject', receiptStore))
        .rejects.toThrow('unavailable');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('reserves job token and monetary budgets atomically before any provider call', async () => {
    const { job, adapter, requestFor } = setup();
    const runtime = new DecisionJobRuntime(new MemoryJobStore());
    const first = await runtime.submit(job, scope); const queued = structuredClone(first.job); queued.state = 'queued';
    await runtime.advance(scope, job.id, first, queued);
    const worker = new OfflineJobWorker(runtime); const executor = admittedJobItemExecutor(job, requestFor);
    await expect(worker.run(scope, job.id, 'subject', executor)).rejects.toThrow('requires budget reservation');
    await expect(worker.run(scope, job.id, 'subject', executor, { tokens: job.budget.maxTokens + 1, costMicros: 1 }))
      .rejects.toThrow('Job budget reservation exceeded');
    expect((await runtime.poll(scope, job.id))?.job.items[0]?.attempts).toHaveLength(0);
    expect(adapter.evaluate).not.toHaveBeenCalled();
    const fenced = await worker.run(scope, job.id, 'subject', executor, { tokens: 1, costMicros: 1 });
    expect(fenced.job.items[0]?.state).toBe('execution-unknown');
    expect(adapter.evaluate).not.toHaveBeenCalled();
  });
  it('rejects unbound principal or digest before any adapter call', async () => {
    const { job, adapter, requestFor } = setup();
    const runtime = new DecisionJobRuntime(new MemoryJobStore());
    const first = await runtime.submit(job, scope); const queued = structuredClone(first.job); queued.state = 'queued';
    await runtime.advance(scope, job.id, first, queued);
    const worker = new OfflineJobWorker(runtime);
    const result = await worker.run(scope, job.id, 'subject', admittedJobItemExecutor(job, (item, signal) => ({
      ...requestFor(item, signal), scheduler: { ...requestFor(item, signal).scheduler, principal: { ...requestFor(item, signal).scheduler.principal, id: 'forged' } },
    })), { tokens: 10, costMicros: 10000 });
    expect(result.job.items[0]?.state).toBe('execution-unknown');
    expect(adapter.evaluate).not.toHaveBeenCalled();
  });
  it('rejects altered ruleset and subject pins before backend dispatch', async () => {
    for (const mutate of [
      (job: DecisionJob) => { job.items[0]!.rulesetDigest = `sha256:${'b'.repeat(64)}`; },
      (job: DecisionJob) => { job.items[0]!.subjectDigest = `sha256:${'b'.repeat(64)}`; },
    ]) {
      const { job, adapter, requestFor } = setup(); mutate(job);
      const runtime = new DecisionJobRuntime(new MemoryJobStore());
      const first = await runtime.submit(job, scope); const queued = structuredClone(first.job); queued.state = 'queued';
      await runtime.advance(scope, job.id, first, queued);
      const result = await new OfflineJobWorker(runtime).run(scope, job.id, 'subject', admittedJobItemExecutor(job, requestFor),
        { tokens: 10, costMicros: 10000 });
      expect(result.job.items[0]?.state).toBe('execution-unknown');
      expect(adapter.evaluate).not.toHaveBeenCalled();
    }
  });
  it('persists one receipt and one validated reference per independent item invocation', async () => {
    const { job, adapter, receiptStore, requestFor } = setup();
    const runtime = new DecisionJobRuntime(new MemoryJobStore());
    const first = await runtime.submit(job, scope); const queued = structuredClone(first.job); queued.state = 'queued';
    await runtime.advance(scope, job.id, first, queued);
    const result = await new OfflineJobWorker(runtime).run(scope, job.id, 'subject', admittedJobItemExecutor(job, requestFor),
      { tokens: 10, costMicros: 10000 });
    const attempt = result.job.items[0]?.attempts[0];
    expect(attempt?.outcome).toBe('succeeded');
    expect(attempt?.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.job.items[0]?.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await receiptStore.read(attempt!.id, scope.projectId))?.state).toBe('completed');
    expect(result.job.state).toBe('completed');
    expect(adapter.evaluate).toHaveBeenCalled();
    const accounting = await accountDecisionJob(result.job, receiptStore);
    expect(accounting.items.subject?.complete).toBe(true);
    expect(accounting.knownCostMicros).toBeGreaterThan(0);
    expect(accounting.overCostBudget).toBe(false);
    expect(accounting.overTokenBudget).toBe(false);
    expect((await runtime.accounting(scope, job.id, receiptStore))?.knownCostMicros).toBe(accounting.knownCostMicros);
    expect(await runtime.accounting({ ...scope, projectId: 'other' }, job.id, receiptStore)).toBeNull();
    const unknownReceipt = structuredClone((await receiptStore.read(attempt!.id, scope.projectId))!);
    const evaluation = Object.values(unknownReceipt.result!.spec.evaluations)[0]!;
    evaluation.spec.attempts[0]!.usage.costUsd = null;
    const unknownJob = structuredClone(result.job);
    unknownJob.items[0]!.attempts[0]!.receiptDigest = artifactDigest(unknownReceipt);
    const uncertain = await accountDecisionJob(unknownJob, new Proxy(receiptStore, {
      get(target, property) { return property === 'read' ? async () => unknownReceipt : Reflect.get(target, property); },
    }));
    expect(uncertain.unknownCost).toBe(true);
    expect(uncertain.overCostBudget).toBe(true);
    const unavailable = structuredClone(result.job); delete unavailable.items[0]!.attempts[0]!.receiptDigest;
    expect((await accountDecisionJob(unavailable, receiptStore)).complete).toBe(false);
    const batched = structuredClone((await receiptStore.read(attempt!.id, scope.projectId))!);
    for (const [alias, evaluation] of Object.entries(batched.result!.spec.evaluations).slice(0, 2)) {
      evaluation.spec.attempts[0]!.batch = { mode: 'native', groupId: 'shared', questionId: alias };
      evaluation.spec.batchResult = { schemaVersion: 'decision-batch-result-ref/v1', batchId: 'shared',
        receiptRevision: 1, questionId: alias, answerId: alias };
    }
    const batch: DecisionBatchReceipt = { schemaVersion: 'decision-batch-receipt/v1', revision: 1,
      tenantId: scope.tenantId, projectId: scope.projectId, batchId: 'shared', invocationId: attempt!.id, runId: 'run',
      plan: { planDigest: job.fingerprint, partitionId: 'partition', nativeBatchGroupId: 'shared' },
      subjectHash: job.items[0]!.subjectDigest, stateHash: job.items[0]!.subjectDigest,
      executionEnvelope: 'fixture', questionIds: ['category', 'severity'],
      answerReferences: ['category', 'severity'].map(questionId => ({ questionId, answerId: questionId, resultId: questionId })), allocations: [],
      attempts: [{ ordinal: 1, adapterId: 'jev', adapterVersion: '1', requestedModel: 'fixture', actualModel: 'fixture',
        providerRequestId: null, status: 'succeeded', dispatchedAtEpochMs: 10, completedAtEpochMs: 20,
        usage: { inputTokens: 7, outputTokens: 5 }, cost: { kind: 'provider-authoritative', currency: 'USD', amountMicros: 500 },
        fallbackFromAttemptOrdinal: null }], status: 'completed', createdAtEpochMs: 10, updatedAtEpochMs: 20, terminalAtEpochMs: 20 };
    const batchJob = structuredClone(result.job);
    batchJob.items[0]!.attempts[0]!.receiptDigest = artifactDigest(batched);
    const batchReader = { read: async () => batch } as unknown as BatchReceiptStore;
    const batchedTotals = await accountDecisionJob(batchJob, new Proxy(receiptStore, {
      get(target, property) { return property === 'read' ? async () => batched : Reflect.get(target, property); },
    }), batchReader);
    expect(batchedTotals.inputTokens).toBe(8); // shared transport once + single evaluation
    expect(batchedTotals.outputTokens).toBe(6);
    expect(batchedTotals.knownCostMicros).toBe(1500);
    const substituted = structuredClone(batched);
    Object.values(substituted.result!.spec.evaluations)[0]!.spec.batchResult!.answerId = 'other-answer';
    const substitutedJob = structuredClone(result.job);
    substitutedJob.items[0]!.attempts[0]!.receiptDigest = artifactDigest(substituted);
    await expect(accountDecisionJob(substitutedJob, new Proxy(receiptStore, {
      get(target, property) { return property === 'read' ? async () => substituted : Reflect.get(target, property); },
    }), batchReader)).rejects.toThrow('Native batch receipt unavailable');
  });
});
