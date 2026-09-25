/**
 * D16 opt-in resolver out of `execution-unknown` (#2722). Offline only: the
 * provider is a counted fake, the job store is in memory, D03 receipts are in
 * memory and the effect ledger uses a deterministic test key.
 */
import { createHash, createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertJobTransition, ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import {
  jobItemEffectId,
  jobItemEffectIdentity,
  ledgerExecutionUnknownResolver,
  ledgerJobEffectRecorder,
} from '../../../src/decision/job-effects.js';
import { admittedJobItemExecutor } from '../../../src/decision/job-evaluate.js';
import { DecisionJobRuntime, recount, type ExecutionUnknownResolver } from '../../../src/decision/job-runtime.js';
import { MemoryJobStore, type JobSnapshot } from '../../../src/decision/job-store.js';
import { OfflineJobWorker } from '../../../src/decision/job-worker.js';
import { MemoryDecisionReceiptStore } from '../../../src/decision/receipts.js';
import type { DecisionAdapter, DecisionBinding, DecisionDefinition, DecisionRuleset } from '../../../src/decision/types.js';
import { artifactDigest } from '../../../src/decision/validate.js';
import { lookupEffect, openEffectLedger, payloadDigest, recordIntent, staticKeyProvider, type EffectLedger } from '../../../src/effects/index.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
const scope = { tenantId: 't', projectId: 'p', workspaceId: 'workspace', principalId: 'principal' };
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const testKey = () => createPrivateKey({
  key: Buffer.concat([PKCS8_ED25519_PREFIX, createHash('sha256').update('aiwg-job-effect-resolver-test-key').digest()]),
  format: 'der', type: 'pkcs8',
});

/** A job store whose next compare-and-swap after `arm()` fails as a crash would. */
class CrashingJobStore extends MemoryJobStore {
  private armed = false;
  arm(): void { this.armed = true; }
  override async compareAndSwap(previous: JobSnapshot, next: JobSnapshot): Promise<boolean> {
    if (this.armed) { this.armed = false; throw new Error('simulated crash before the job record'); }
    return super.compareAndSwap(previous, next);
  }
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aiwg-job-effects-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ledger(): EffectLedger {
  return openEffectLedger({
    projectDir: dir, scope: { tenant: scope.tenantId, project: scope.projectId, subsystem: 'job' },
    writer: 'job-worker', keyProvider: staticKeyProvider(testKey()), lockTimeoutMs: 20_000,
  });
}

function setup() {
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
  const receipts = new MemoryDecisionReceiptStore();
  const limits = { concurrency: 2, maxAttempts: 3, allowUnknownCost: false, maxCostUsd: 1, maxQueueLength: 5 };
  const requestFor = (item: DecisionJob['items'][number], signal: AbortSignal) => ({
    ruleset, binding, definitions, input, runId: 'run', invocationId: item.attempts.at(-1)!.id,
    adapters: { jev: adapter }, receiptStore: receipts, receiptProjectId: scope.projectId, signal,
    scheduler: { enabled: true, profileVersion: 'fixture', workspace: { id: scope.workspaceId, limits },
      principal: { id: scope.principalId, limits }, providers: { jev: limits },
      estimate: () => ({ tokens: 3, costUsd: 0.001, attempts: 1 }) },
  });
  return { job, adapter, receipts, requestFor };
}

/** Run one admitted item and crash after the effect is recorded but before the job record is written. */
async function crashAfterEffect(options: { record?: boolean } = {}) {
  const { job, adapter, receipts, requestFor } = setup();
  const store = new CrashingJobStore();
  const runtime = new DecisionJobRuntime(store);
  const effects = ledger();
  const recorder = ledgerJobEffectRecorder({ ledger: effects, receipts, jobs: store });
  const recorded: string[] = [];
  const worker = new OfflineJobWorker(runtime, {
    async recordReceipt(input) {
      if (options.record !== false) await recorder.recordReceipt(input);
      recorded.push(input.receiptDigest);
      store.arm();
    },
  });
  const first = await runtime.submit(job, scope);
  const queued = structuredClone(first.job); queued.state = 'queued';
  await runtime.advance(scope, job.id, first, queued);
  await expect(worker.run(scope, job.id, 'subject', admittedJobItemExecutor(job, requestFor), { tokens: 10, costMicros: 10000 }))
    .rejects.toThrow('simulated crash');
  const calls = (adapter.evaluate as ReturnType<typeof vi.fn>).mock.calls.length;
  expect(calls).toBeGreaterThan(0);
  const crashed = (await runtime.poll(scope, job.id))!;
  expect(crashed.job.items[0]).toMatchObject({ state: 'running', attempts: [{ outcome: 'dispatched' }] });
  return { job, adapter, receipts, store, runtime, effects, recorded, calls, attempt: crashed.job.items[0]!.attempts[0]! };
}

const callCount = (adapter: DecisionAdapter) => (adapter.evaluate as ReturnType<typeof vi.fn>).mock.calls.length;

describe('JOB-D16 opt-in execution-unknown resolver', () => {
  it('JOB-D16-01 with the resolver off, reconcile is exactly the default reconciliation', async () => {
    const off = await crashAfterEffect();
    const defaulted = await off.runtime.reconcile(scope, 'jobA');
    expect(defaulted?.job.items[0]).toMatchObject({ state: 'execution-unknown', attempts: [{ outcome: 'execution-unknown' }] });
    expect(defaulted?.job.state).toBe('failed');
    const empty = await crashAfterEffect();
    const withEmptyOptions = await empty.runtime.reconcile(scope, 'jobA', {});
    const strip = (snapshot: JobSnapshot | null) => JSON.stringify({ ...snapshot, job: { ...snapshot!.job, items: snapshot!.job.items.map(item => ({ ...item, attempts: item.attempts.map(attempt => ({ ...attempt, id: 'attempt' })) })) } });
    expect(strip(withEmptyOptions)).toBe(strip(defaulted));
    expect(callCount(off.adapter)).toBe(off.calls);
  });

  it('JOB-D16-02 a matching verified receipt promotes the item through the gated transition without re-dispatch', async () => {
    const run = await crashAfterEffect();
    const effectId = jobItemEffectId(scope, 'jobA', 'subject', run.attempt.id);
    expect((await lookupEffect(run.effects, effectId)).status).toBe('completed');
    const resolver = ledgerExecutionUnknownResolver({ ledger: run.effects, receipts: run.receipts, jobs: run.store });
    const resolved = await run.runtime.reconcile(scope, 'jobA', { resolveUnknown: resolver });
    const item = resolved!.job.items[0]!;
    const receipt = (await run.receipts.read(run.attempt.id, scope.projectId))!;
    expect(item.state).toBe('succeeded');
    expect(item.resultDigest).toBe(artifactDigest(receipt.result));
    expect(item.attempts[0]).toMatchObject({
      id: run.attempt.id, outcome: 'succeeded', receiptDigest: run.recorded[0],
      resolution: { method: 'effect-ledger', effectId, reason: 'digest-match', receiptDigest: run.recorded[0] },
    });
    expect(resolved!.job.summary['execution-unknown']).toBe(0);
    // The job state records the reconciliation; the resolution never re-dispatches the provider.
    expect(resolved!.job.state).toBe('failed');
    expect(callCount(run.adapter)).toBe(run.calls);
    // Idempotent: a second pass finds nothing to resolve.
    expect(await run.runtime.reconcile(scope, 'jobA', { resolveUnknown: resolver })).toEqual(resolved);
    expect(callCount(run.adapter)).toBe(run.calls);
  });

  it('JOB-D16-03 a mismatched digest, absent or unknown evidence leaves the item execution-unknown', async () => {
    // No effect recorded: nothing to match.
    const none = await crashAfterEffect({ record: false });
    const noneResolver = ledgerExecutionUnknownResolver({ ledger: none.effects, receipts: none.receipts, jobs: none.store });
    expect((await none.runtime.reconcile(scope, 'jobA', { resolveUnknown: noneResolver }))!.job.items[0]!.state).toBe('execution-unknown');

    // A ledger digest that does not match the stored receipt: evidence-conflict (unknown).
    const mismatch = await crashAfterEffect({ record: false });
    await recordIntent(mismatch.effects, { ...jobItemEffectIdentity(scope, 'jobA', 'subject', mismatch.attempt.id), payloadDigest: payloadDigest('other receipt') });
    const mismatchResolver = ledgerExecutionUnknownResolver({ ledger: mismatch.effects, receipts: mismatch.receipts, jobs: mismatch.store });
    expect((await mismatch.runtime.reconcile(scope, 'jobA', { resolveUnknown: mismatchResolver }))!.job.items[0]!.state).toBe('execution-unknown');
    const conflict = await lookupEffect(mismatch.effects, jobItemEffectId(scope, 'jobA', 'subject', mismatch.attempt.id));
    expect(conflict.records.at(-1)?.verification).toMatchObject({ result: 'unknown', reason: 'evidence-conflict' });

    // The receipt is gone: absent.
    const absent = await crashAfterEffect();
    const emptyReceipts = new MemoryDecisionReceiptStore();
    const absentResolver = ledgerExecutionUnknownResolver({ ledger: absent.effects, receipts: emptyReceipts, jobs: absent.store });
    expect((await absent.runtime.reconcile(scope, 'jobA', { resolveUnknown: absentResolver }))!.job.items[0]!.state).toBe('execution-unknown');

    // The receipt store is unreadable: unknown.
    const unknown = await crashAfterEffect();
    const failing = { read: async () => { throw new Error('store offline'); } } as unknown as MemoryDecisionReceiptStore;
    const unknownResolver = ledgerExecutionUnknownResolver({ ledger: unknown.effects, receipts: failing, jobs: unknown.store });
    expect((await unknown.runtime.reconcile(scope, 'jobA', { resolveUnknown: unknownResolver }))!.job.items[0]!.state).toBe('execution-unknown');

    for (const run of [none, mismatch, absent, unknown]) expect(callCount(run.adapter)).toBe(run.calls);
  });

  it('JOB-D16-04 the runtime rejects a state-match or malformed resolution and a throwing resolver', async () => {
    const run = await crashAfterEffect();
    await run.runtime.reconcile(scope, 'jobA');
    const digest = run.recorded[0] as `sha256:${string}`;
    const effectId = jobItemEffectId(scope, 'jobA', 'subject', run.attempt.id);
    const resolvers: ExecutionUnknownResolver[] = [
      async () => ({ state: 'succeeded', effectId, reason: 'state-match' as never, receiptDigest: digest, resultDigest: digest }),
      async () => ({ state: 'succeeded', effectId, reason: 'digest-match', receiptDigest: 'sha256:short' as never, resultDigest: digest }),
      async () => ({ state: 'retryable-failed' as never, effectId, reason: 'digest-match', receiptDigest: digest, resultDigest: digest }),
      async () => { throw new Error('resolver failure'); },
      async () => null,
    ];
    for (const resolver of resolvers) {
      const snapshot = await run.runtime.resolveUnknown(scope, 'jobA', resolver);
      expect(snapshot!.job.items[0]!.state).toBe('execution-unknown');
    }
    expect(callCount(run.adapter)).toBe(run.calls);
  });

  it('JOB-D16-05 contract validation rejects an execution-unknown to succeeded transition without a matching receipt digest', async () => {
    const run = await crashAfterEffect();
    const before = (await run.runtime.reconcile(scope, 'jobA'))!.job;
    const digest = run.recorded[0] as `sha256:${string}`;
    const effectId = jobItemEffectId(scope, 'jobA', 'subject', run.attempt.id);
    const promote = (mutate: (job: DecisionJob) => void) => {
      const after = structuredClone(before);
      const item = after.items[0]!; const attempt = item.attempts[0]!;
      item.state = 'succeeded'; item.resultDigest = digest;
      attempt.outcome = 'succeeded'; attempt.receiptDigest = digest;
      attempt.resolution = { method: 'effect-ledger', effectId, reason: 'digest-match', receiptDigest: digest };
      mutate(after); recount(after);
      return after;
    };
    expect(() => assertJobTransition(before, promote(() => undefined))).not.toThrow();
    expect(() => assertJobTransition(before, promote(job => { job.items[0]!.attempts[0]!.resolution!.receiptDigest = payloadDigest('other') as `sha256:${string}`; })))
      .toThrow();
    expect(() => assertJobTransition(before, promote(job => { delete job.items[0]!.attempts[0]!.resolution; }))).toThrow();
    expect(() => assertJobTransition(before, promote(job => { delete job.items[0]!.attempts[0]!.receiptDigest; }))).toThrow();
    expect(() => assertJobTransition(before, promote(job => { (job.items[0]!.attempts[0]!.resolution as { reason: string }).reason = 'state-match'; }))).toThrow();
    expect(() => assertJobTransition(before, promote(job => { delete job.items[0]!.resultDigest; }))).toThrow();
    expect(() => assertJobTransition(before, promote(job => { job.items[0]!.attempts[0]!.reservedTokens = 1; }))).toThrow();
    expect(() => assertJobTransition(before, promote(job => { job.state = 'completed'; }))).toThrow();
  });
});
