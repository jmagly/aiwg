import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateDecisionRuleset,
  FileDecisionReceiptStore,
  MemoryDecisionReceiptStore,
  runBoundedFair,
  type AdapterObservation,
  type DecisionAdapter,
  type DecisionAdmissionEstimate,
  type DecisionAdmissionLimits,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionEvaluationRequest,
  type DecisionReceiptStore,
  type DecisionRuleset,
  type DecisionSchedulerPolicy,
} from '../../../src/decision/index.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
const definitions = (): Record<string, DecisionDefinition> => ({
  category: fixture('decision-category.json'),
  severity: fixture('decision-severity.json'),
  core: fixture('decision-core_unavailable.json'),
});

const observe = (alias: string): AdapterObservation => ({
  status: 'success', reason: 'none', value: alias === 'category' ? 'documentation' : alias === 'severity' ? 0.25 : 0.05,
  uncertainty: { source: 'provider', profile: alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1',
    calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
  actualModel: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: 'fixture-request',
});

function adapter(id: 'jev' | 'llm-subagent', evaluate: (alias: string) => Promise<AdapterObservation> | AdapterObservation): DecisionAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    id, version: '1.0.0', calls,
    capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'],
      features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10,
      confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true, egress: { mode: 'none' as const } }),
    evaluate: async request => { calls.push(request.alias); return await evaluate(request.alias); },
  };
}

const base = (overrides: Partial<DecisionAdmissionLimits> = {}): DecisionAdmissionLimits =>
  ({ concurrency: 4, maxQueueLength: 8, maxQueueWaitMs: 1_000, ...overrides });

function policy(workspace: string, options: {
  principal?: string; principalLimits?: DecisionAdmissionLimits; workspaceLimits?: DecisionAdmissionLimits;
  providers?: Record<string, DecisionAdmissionLimits>; estimate?: () => DecisionAdmissionEstimate; profileVersion?: string;
} = {}): DecisionSchedulerPolicy {
  return {
    enabled: true, profileVersion: options.profileVersion ?? 'offline-v1',
    workspace: { id: workspace, limits: options.workspaceLimits ?? base() },
    principal: { id: options.principal ?? 'principal', limits: options.principalLimits ?? base() },
    providers: options.providers ?? { jev: base() },
    ...(options.estimate ? { estimate: options.estimate } : {}),
  };
}

function request(invocationId: string, scheduler: DecisionSchedulerPolicy, adapters: DecisionEvaluationRequest['adapters'],
  extra: Partial<DecisionEvaluationRequest> = {}): DecisionEvaluationRequest {
  return {
    ruleset: fixture<DecisionRuleset>('ruleset.json'), binding: fixture<DecisionBinding>('binding-jev.json'),
    definitions: definitions(), input: fixture('input.json'), runId: 'run', invocationId, adapters, scheduler, ...extra,
  };
}

const stores: Array<{ label: string; create: () => Promise<{ store: DecisionReceiptStore; cleanup: () => Promise<void> }> }> = [
  { label: 'memory', create: async () => ({ store: new MemoryDecisionReceiptStore(), cleanup: async () => undefined }) },
  { label: 'file', create: async () => {
    const root = await mkdtemp(join(tmpdir(), 'admission-receipts-'));
    return { store: new FileDecisionReceiptStore(join(root, 'receipts'), { integrityKey: randomBytes(32) }),
      cleanup: () => rm(root, { recursive: true, force: true }) };
  } },
];

interface RejectionCase {
  label: string;
  evidence: string;
  reason: string;
  scheduler: (workspace: string, skew: () => void) => DecisionSchedulerPolicy;
}

const rejections: RejectionCase[] = [
  { label: 'requests-per-minute', evidence: 'requests-per-minute', reason: 'rate-limited',
    scheduler: ws => policy(ws, { providers: { jev: base({ requestsPerMinute: 0 }) } }) },
  { label: 'tokens-per-second', evidence: 'tokens-per-second', reason: 'rate-limited',
    scheduler: ws => policy(ws, { providers: { jev: base({ tokensPerSecond: 1 }) }, estimate: () => ({ tokens: 5, attempts: 1 }) }) },
  { label: 'attempts', evidence: 'attempts', reason: 'budget-exhausted',
    scheduler: ws => policy(ws, { principalLimits: base({ maxAttempts: 0 }) }) },
  { label: 'cost', evidence: 'cost', reason: 'budget-exhausted',
    scheduler: ws => policy(ws, { principalLimits: base({ maxCostUsd: 0.5 }), estimate: () => ({ costUsd: 1, attempts: 1 }) }) },
  { label: 'unknown-cost', evidence: 'unknown-cost', reason: 'budget-exhausted',
    scheduler: ws => policy(ws, { principalLimits: base({ maxCostUsd: 1 }) }) },
  { label: 'batch-size', evidence: 'batch-size', reason: 'overloaded',
    scheduler: ws => policy(ws, { providers: { jev: base({ maxBatchSize: 0 }) } }) },
  { label: 'queue-full', evidence: 'queue-full', reason: 'overloaded',
    scheduler: ws => policy(ws, { workspaceLimits: base({ maxQueueLength: 0 }) }) },
  { label: 'queue-timeout', evidence: 'queue-timeout', reason: 'timeout',
    scheduler: ws => policy(ws, { principalLimits: base({ maxQueueWaitMs: 0 }) }) },
  { label: 'deadline-exceeded', evidence: 'deadline-exceeded', reason: 'timeout',
    scheduler: (ws, skew) => policy(ws, { estimate: () => { skew(); return { attempts: 1 }; } }) },
  { label: 'missing provider limits', evidence: 'unconfigured-provider', reason: 'overloaded',
    scheduler: ws => policy(ws, { providers: { 'llm-subagent': base() } }) },
];

describe('admission rejections with durable receipts (#2670)', () => {
  describe.each(stores)('$label receipt store', ({ label: storeLabel, create }) => {
    it.each(rejections)('CNC-ADMIT-RECEIPT-001 records $label as a not-sent terminal outcome', async ({ label, evidence, reason, scheduler }) => {
      const { store, cleanup } = await create();
      try {
        // The deadline case moves the injected clock past the attempt deadline for
        // exactly one reading, the controller's pre-admission check.
        let skewed = false;
        const clock = { at: 1_000_000 };
        const now = (): number => { if (skewed) { skewed = false; return clock.at + 10_000_000; } return clock.at; };
        const jev = adapter('jev', observe);
        const workspace = `receipts-${storeLabel}-${label}`;
        const invocationId = `reject-${storeLabel}-${label.replaceAll(' ', '-')}`;
        const result = await evaluateDecisionRuleset(request(invocationId, scheduler(workspace, () => { skewed = true; }),
          { jev }, { receiptStore: store, now }));

        expect(jev.calls).toEqual([]);
        expect(result.spec.reason).not.toBe('execution-uncertain');
        for (const evaluation of Object.values(result.spec.evaluations)) {
          expect(evaluation.spec.reason).toBe(reason);
          expect(evaluation.spec.attempts).toHaveLength(1);
          expect(evaluation.spec.attempts[0]!.admission).toMatchObject({ decision: 'reject', reason: evidence });
        }
        expect(Object.keys(result.spec.evaluations)).toEqual(['category', 'severity', 'core_unavailable']);
        const receipt = await store.read(invocationId, 'default');
        expect(receipt?.state).toBe('completed');
        expect(receipt?.result?.spec.evaluations.category?.spec.attempts[0]?.admission?.reason).toBe(evidence);
      } finally {
        await cleanup();
      }
    });

    it('CNC-ADMIT-RECEIPT-002 still records a dispatched attempt with an unknown outcome as execution-uncertain', async () => {
      const { store, cleanup } = await create();
      try {
        const jev = adapter('jev', () => ({ ...observe('category'), status: 'error', reason: 'service-error', value: undefined }));
        const invocationId = `uncertain-${storeLabel}`;
        const result = await evaluateDecisionRuleset(request(invocationId, policy(`uncertain-${storeLabel}`), { jev },
          { receiptStore: store }));
        expect(jev.calls).toEqual(['category']);
        expect(result.spec.reason).toBe('execution-uncertain');
        expect((await store.read(invocationId, 'default'))?.state).toBe('execution-uncertain');
      } finally {
        await cleanup();
      }
    });
  });
});

describe('trusted-scope admission keying (#2670)', () => {
  const held = (tracker: { active: number; maximum: number }): ((alias: string) => Promise<AdapterObservation>) => async alias => {
    tracker.active += 1;
    tracker.maximum = Math.max(tracker.maximum, tracker.active);
    await new Promise<void>(done => setTimeout(done, 5));
    tracker.active -= 1;
    return observe(alias);
  };

  it.each([
    { label: 'principal', principals: ['same', 'same'], limits: { principalLimits: base({ concurrency: 1 }) } },
    { label: 'workspace', principals: ['first', 'second'], limits: { workspaceLimits: base({ concurrency: 1 }) } },
    { label: 'provider', principals: ['first', 'second'], limits: { providers: { jev: base({ concurrency: 1 }) } } },
  ])('CNC-ADMIT-SCOPE-001 enforces the $label ceiling across structurally equal but distinct policy objects', async ({ label, principals, limits }) => {
    const tracker = { active: 0, maximum: 0 };
    const jev = adapter('jev', held(tracker));
    const [first, second] = principals.map(principal => policy(`keying-${label}`, { principal, ...limits }));
    expect(first).not.toBe(second);
    expect(first!.workspace.limits).toEqual(second!.workspace.limits);
    const results = await Promise.all([
      evaluateDecisionRuleset(request(`keying-${label}-a`, first!, { jev })),
      evaluateDecisionRuleset(request(`keying-${label}-b`, second!, { jev })),
    ]);
    expect(jev.calls).toHaveLength(6);
    expect(tracker.maximum).toBe(1);
    for (const result of results) expect(result.spec.status).toBe('completed');
  });

  it('CNC-ADMIT-SCOPE-002 does not let one principal consume another principal\'s equal quota', async () => {
    const trackers = { first: { active: 0, maximum: 0 }, second: { active: 0, maximum: 0 } };
    const total = { active: 0, maximum: 0 };
    const counted = (own: { active: number; maximum: number }) => async (alias: string) => {
      total.active += 1; total.maximum = Math.max(total.maximum, total.active);
      try { return await held(own)(alias); } finally { total.active -= 1; }
    };
    const first = adapter('jev', counted(trackers.first));
    const second = adapter('jev', counted(trackers.second));
    const limits = { principalLimits: base({ concurrency: 1, requestsPerMinute: 3, maxQueueWaitMs: 50 }) };
    await Promise.all([
      evaluateDecisionRuleset(request('quota-first-1', policy('quota', { principal: 'first', ...limits }), { jev: first })),
      evaluateDecisionRuleset(request('quota-second-1', policy('quota', { principal: 'second', ...limits }), { jev: second })),
    ]);
    expect(first.calls).toHaveLength(3);
    expect(second.calls).toHaveLength(3);
    expect(trackers.first.maximum).toBe(1);
    expect(trackers.second.maximum).toBe(1);
    expect(total.maximum).toBe(2);

    // The first principal's request bucket is now empty; a fresh policy object
    // cannot reset it, and the second principal's bucket is unaffected.
    const exhausted = await evaluateDecisionRuleset(request('quota-first-2', policy('quota', { principal: 'first', ...limits }), { jev: first }));
    expect(first.calls).toHaveLength(3);
    expect(exhausted.spec.evaluations.category?.spec.attempts[0]?.admission?.reason).toBe('queue-timeout');
  });

  it('CNC-ADMIT-RECEIPT-003 reports a target timeout during a queued wait as a timeout, not a caller cancellation', async () => {
    let release!: () => void;
    const holding = new Promise<void>(done => { release = done; });
    const busy = adapter('jev', async alias => { await holding; return observe(alias); });
    const limits = { principalLimits: base({ concurrency: 1 }) };
    const blocker = evaluateDecisionRuleset(request('queued-timeout-blocker', policy('queued-timeout', limits), { jev: busy }));
    await vi.waitFor(() => expect(busy.calls).toHaveLength(1));
    const binding = fixture<DecisionBinding>('binding-jev.json');
    for (const evaluation of Object.values(binding.spec.evaluations)) evaluation.targets[0]!.timeoutMs = 20;
    const idle = adapter('jev', observe);
    const waited = await evaluateDecisionRuleset(request('queued-timeout-waiter', policy('queued-timeout', limits), { jev: idle }, { binding }));
    release();
    await blocker;
    expect(idle.calls).toEqual([]);
    const attempt = waited.spec.evaluations.category!.spec.attempts[0]!;
    // The target timer and the controller's deadline poll can both end the wait;
    // either way it is a timeout and never a caller cancellation.
    expect(attempt).toMatchObject({ status: 'error', reason: 'timeout' });
    expect(['cancelled', 'deadline-exceeded']).toContain(attempt.admission?.reason);
    if (attempt.admission?.reason === 'cancelled') expect(attempt.termination).toBe('target-timeout');
  });

  it('CNC-ADMIT-SCOPE-003 fails closed when one profile revision is registered with different limits', async () => {
    const jev = adapter('jev', observe);
    await evaluateDecisionRuleset(request('revision-a', policy('revision', { workspaceLimits: base({ concurrency: 2 }) }), { jev }));
    const conflicting = await evaluateDecisionRuleset(request('revision-b',
      policy('revision', { workspaceLimits: base({ concurrency: 3 }) }), { jev }));
    expect(conflicting.spec).toMatchObject({ status: 'error', reason: 'invalid-definition' });
    expect(jev.calls).toHaveLength(3);
    const revised = await evaluateDecisionRuleset(request('revision-c',
      policy('revision', { workspaceLimits: base({ concurrency: 3 }), profileVersion: 'offline-v2' }), { jev }));
    expect(revised.spec.status).toBe('completed');
  });
});

describe('retry backoff releases the scheduler permit (#2670)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('CNC-SCHED-BACKOFF-001 starts another lane while a retry sleeps under fake time at concurrency 1', async () => {
    vi.useFakeTimers();
    const starts: string[] = [];
    let active = 0;
    let maximum = 0;
    const running = runBoundedFair([{ value: 'retrying', lane: 'a' }, { value: 'other', lane: 'b' }, { value: 'later', lane: 'a' }], 1,
      async (value, _index, slot) => {
        const attempt = async (label: string): Promise<void> => {
          active += 1; maximum = Math.max(maximum, active); starts.push(label);
          await new Promise<void>(done => setTimeout(done, 10));
          active -= 1;
        };
        await attempt(`${value}#1`);
        if (value === 'retrying') {
          await slot.suspend(() => new Promise<void>(done => setTimeout(done, 1_000)));
          await attempt(`${value}#2`);
        }
        return value;
      });
    await vi.advanceTimersByTimeAsync(10);
    expect(starts).toEqual(['retrying#1', 'other#1']);
    await vi.advanceTimersByTimeAsync(10);
    // The backoff has not elapsed, so unstarted work may keep using the permit.
    expect(starts).toEqual(['retrying#1', 'other#1', 'later#1']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await running).toEqual(['retrying', 'other', 'later']);
    expect(starts).toEqual(['retrying#1', 'other#1', 'later#1', 'retrying#2']);
    expect(maximum).toBe(1);
  });

  it('CNC-SCHED-BACKOFF-002 resumes suspended work ahead of unstarted work', async () => {
    vi.useFakeTimers();
    const starts: string[] = [];
    const running = runBoundedFair([{ value: 'retrying', lane: 'a' }, { value: 'held', lane: 'b' }, { value: 'queued', lane: 'c' }], 1,
      async (value, _index, slot) => {
        starts.push(value);
        if (value === 'retrying') {
          await slot.suspend(() => new Promise<void>(done => setTimeout(done, 5)));
          starts.push('retrying#2');
        } else if (value === 'held') {
          await new Promise<void>(done => setTimeout(done, 20));
        }
        return value;
      });
    await vi.advanceTimersByTimeAsync(30);
    expect(await running).toEqual(['retrying', 'held', 'queued']);
    expect(starts).toEqual(['retrying', 'held', 'retrying#2', 'queued']);
  });

  it('CNC-SCHED-BACKOFF-003 lets the evaluator dispatch a different lane while a retry backs off', async () => {
    const binding = fixture<DecisionBinding>('binding-jev.json');
    binding.spec.maxAttempts = 4;
    binding.spec.evaluations.category!.targets[0]!.retry.maxRetries = 1;
    binding.spec.evaluations.severity = fixture<DecisionBinding>('binding-llm-subagent.json').spec.evaluations.severity!;
    const starts: string[] = [];
    let active = 0;
    let maximum = 0;
    let releaseSeverity!: () => void;
    let releaseBackoff!: () => void;
    const severityHeld = new Promise<void>(done => { releaseSeverity = done; });
    let categoryAttempts = 0;
    const track = async (alias: string, hold?: Promise<void>): Promise<void> => {
      active += 1; maximum = Math.max(maximum, active); starts.push(alias);
      if (hold) await hold;
      active -= 1;
    };
    const jev = adapter('jev', async alias => {
      await track(alias);
      if (alias === 'category' && ++categoryAttempts === 1) {
        return { ...observe(alias), status: 'error', reason: 'rate-limited', value: undefined, dispatchCertainty: 'terminal-response' };
      }
      return observe(alias);
    });
    const llm = adapter('llm-subagent', async alias => { await track(alias, severityHeld); return observe(alias); });
    let backoffEntered!: () => void;
    const entered = new Promise<void>(done => { backoffEntered = done; });
    const running = evaluateDecisionRuleset(request('backoff-lanes', policy('backoff', {
      providers: { jev: base(), 'llm-subagent': base() }, principalLimits: base({ concurrency: 1 }) }),
    { jev, 'llm-subagent': llm }, { binding, delay: () => new Promise<void>(done => { releaseBackoff = done; backoffEntered(); }) }));

    await entered;
    await vi.waitFor(() => expect(starts).toEqual(['category', 'severity']));
    releaseBackoff();
    await new Promise<void>(done => setImmediate(done));
    // The resumed retry waits for the permit that severity holds.
    expect(starts).toEqual(['category', 'severity']);
    releaseSeverity();
    const result = await running;
    expect(starts).toEqual(['category', 'severity', 'category', 'core_unavailable']);
    expect(maximum).toBe(1);
    expect(result.spec.evaluations.category?.spec.attempts.map(attempt => attempt.reason)).toEqual(['rate-limited', 'none']);
    expect(Object.keys(result.spec.evaluations)).toEqual(['category', 'severity', 'core_unavailable']);
  });
});
