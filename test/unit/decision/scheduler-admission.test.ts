import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdmissionError,
  DecisionAdmissionController,
  runBoundedFair,
  type AdmissionRequest,
  type DecisionAdmissionLimits,
} from '../../../src/decision/index.js';

const limits = (overrides: Partial<DecisionAdmissionLimits> = {}): DecisionAdmissionLimits => ({
  concurrency: 1,
  maxQueueLength: 8,
  maxQueueWaitMs: 1_000,
  ...overrides,
});

const request = (signal: AbortSignal = new AbortController().signal, estimate: AdmissionRequest['estimate'] = {}): AdmissionRequest => ({
  budgetId: 'invocation', principalId: 'authenticated-principal', workspaceId: 'workspace', providerId: 'jev', estimate,
  deadlineEpochMs: Date.now() + 10_000, signal,
});

describe('bounded fair decision scheduler', () => {
  it('bounds active work while retaining canonical input order', async () => {
    let active = 0;
    let maximum = 0;
    const work = [0, 1, 2, 3].map(value => ({ value, lane: value % 2 ? 'b' : 'a' }));
    const running = runBoundedFair(work, 2, async value => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => setTimeout(resolve, (4 - value) * 2));
      active -= 1;
      return `result-${value}`;
    });
    expect(await running).toEqual(['result-0', 'result-1', 'result-2', 'result-3']);
    expect(maximum).toBe(2);
  });

  it.each([
    { label: '1', items: 1, expectedMaximum: 1 },
    { label: '2', items: 2, expectedMaximum: 2 },
    { label: 'N', items: 4, expectedMaximum: 4 },
    { label: 'N+1', items: 5, expectedMaximum: 4 },
  ])('enforces the 1/2/N/N+1 concurrency boundary at $label', async ({ items, expectedMaximum }) => {
    const ceiling = 4;
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const running = runBoundedFair(
      Array.from({ length: items }, (_, value) => ({ value, lane: `lane-${value}` })),
      ceiling,
      async value => {
        active += 1;
        maximum = Math.max(maximum, active);
        started.push(value);
        await new Promise<void>(release => releases.push(release));
        active -= 1;
        return value;
      },
    );

    await Promise.resolve();
    expect(started).toHaveLength(expectedMaximum);
    while (releases.length) releases.shift()!();
    if (items > ceiling) {
      await new Promise<void>(done => setImmediate(done));
      expect(started).toHaveLength(items);
      while (releases.length) releases.shift()!();
    }
    expect(await running).toEqual(Array.from({ length: items }, (_, value) => value));
    expect(maximum).toBe(expectedMaximum);
  });

  it('is byte-identical in canonical input order across randomized completion orders', async () => {
    const inputs = Array.from({ length: 64 }, (_, value) => ({ value, lane: `lane-${value % 7}` }));
    const execute = async (seed: number): Promise<string> => {
      let state = seed >>> 0;
      const delays = inputs.map(() => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state % 7;
      });
      const results = await runBoundedFair(inputs, 8, async (value, index) => {
        await new Promise<void>(done => setTimeout(done, delays[index]));
        return { ordinal: value, stable: `result-${value}` };
      });
      return JSON.stringify(results);
    };

    const baseline = await execute(1);
    for (const seed of [2, 17, 2_601, 0xffff_ffff]) expect(await execute(seed)).toBe(baseline);
  });

  it('round-robins an eligible quiet lane through a noisy neighbor backlog', async () => {
    const starts: string[] = [];
    const work = [
      ...Array.from({ length: 32 }, (_, value) => ({ value: `noisy-${value}`, lane: 'noisy' })),
      { value: 'quiet-0', lane: 'quiet' },
      { value: 'third-0', lane: 'third' },
    ];
    const results = await runBoundedFair(work, 1, async value => {
      starts.push(value);
      return value;
    });

    expect(starts.slice(0, 3)).toEqual(['noisy-0', 'quiet-0', 'third-0']);
    expect(results).toEqual(work.map(item => item.value));
  });

  it('keeps the preregistered load spike and synthetic soak within active and fairness bounds', async () => {
    const manifestPath = resolve(process.cwd(), 'docs/decision/load-manifest.v1.json');
    const manifestBytes = readFileSync(manifestPath);
    expect(createHash('sha256').update(manifestBytes).digest('hex'))
      .toBe('9c6db981b0e1d124e317651ed15e8972fbf27b7a7596b15aa23ea3baac4bb03f');
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      arrivalModel: { averageRequestsPerSecond: number; spikeMultiplier: number; spikeDurationSeconds: number };
      duration: { loadSeconds: number; spikeSeconds: number; soakSeconds: number };
      bounds: { maximumActiveCalls: number; maximumEligibleLaneWaitMs: number };
    };
    const base = manifest.arrivalModel.averageRequestsPerSecond;
    const seconds = manifest.duration.loadSeconds + manifest.duration.spikeSeconds + manifest.duration.soakSeconds;
    const syntheticRequests = (base * seconds)
      + (base * (manifest.arrivalModel.spikeMultiplier - 1) * manifest.arrivalModel.spikeDurationSeconds);
    const laneCount = 37;
    let active = 0;
    let maximum = 0;
    const dispatchOrdinal = new Map<number, number>();
    let dispatches = 0;
    const work = Array.from({ length: syntheticRequests }, (_, value) => ({ value, lane: `principal-${value % laneCount}` }));
    const results = await runBoundedFair(work, manifest.bounds.maximumActiveCalls, async value => {
      active += 1;
      maximum = Math.max(maximum, active);
      dispatchOrdinal.set(value, dispatches++);
      await Promise.resolve();
      active -= 1;
      return value;
    });

    expect(maximum).toBeLessThanOrEqual(manifest.bounds.maximumActiveCalls);
    expect(results).toEqual(work.map(item => item.value));
    // Under the manifest's 20 request/s arrival rate, one full lane round is
    // 1.85 seconds. Every initially eligible lane therefore starts below the
    // preregistered 2 second fairness ceiling, even during the burst backlog.
    const maximumInitialLaneDispatch = Math.max(...Array.from({ length: laneCount }, (_, lane) => dispatchOrdinal.get(lane)!));
    expect((maximumInitialLaneDispatch / base) * 1_000).toBeLessThan(manifest.bounds.maximumEligibleLaneWaitMs);
  });
});

describe('decision provider admission', () => {
  afterEach(() => vi.useRealTimers());
  it('enforces admission permits at 1/2/N/N+1 without over-admitting the queued request', async () => {
    const guarded = limits({ concurrency: 4 });
    const controller = new DecisionAdmissionController(() => ({ principal: guarded, workspace: guarded, provider: guarded }));
    const leases = [];
    for (let count = 1; count <= 4; count += 1) {
      leases.push(await controller.acquire({ ...request(), principalId: `principal-${count}` }));
      expect(leases.at(-1)!.evidence.active).toBe(1);
    }
    let fifthSettled = false;
    const fifth = controller.acquire({ ...request(), principalId: 'principal-5' }).then(lease => {
      fifthSettled = true;
      return lease;
    });
    await Promise.resolve();
    expect(fifthSettled).toBe(false);
    leases[0]!.release({ success: true });
    const admitted = await fifth;
    expect(admitted.evidence).toMatchObject({ decision: 'admit', reason: 'admitted' });
    admitted.release({ success: true });
    leases.slice(1).forEach(lease => lease.release({ success: true }));
  });

  it('admits a quiet principal after at most one noisy-neighbor continuation', async () => {
    const principal = limits({ concurrency: 1, maxQueueLength: 64 });
    const workspace = limits({ concurrency: 1, maxQueueLength: 64 });
    const provider = limits({ concurrency: 1, maxQueueLength: 64 });
    const controller = new DecisionAdmissionController(() => ({ principal, workspace, provider }));
    const first = await controller.acquire({ ...request(), principalId: 'noisy' });
    const order: string[] = [];
    const noisy = Array.from({ length: 12 }, (_, index) => controller
      .acquire({ ...request(), principalId: 'noisy', budgetId: `noisy-${index}` })
      .then(lease => { order.push(`noisy-${index}`); lease.release({ success: true }); }));
    const quiet = controller.acquire({ ...request(), principalId: 'quiet', budgetId: 'quiet' })
      .then(lease => { order.push('quiet'); lease.release({ success: true }); });
    first.release({ success: true });
    await Promise.all([...noisy, quiet]);

    expect(order.indexOf('quiet')).toBeLessThanOrEqual(1);
  });

  it('cancels a queued caller without consuming a provider permit', async () => {
    const shared = limits();
    const controller = new DecisionAdmissionController(() => ({ principal: shared, workspace: shared, provider: shared }));
    const first = await controller.acquire(request());
    const abort = new AbortController();
    const queued = controller.acquire(request(abort.signal));
    abort.abort();
    await expect(queued).rejects.toMatchObject({ evidence: { reason: 'cancelled' } });
    first.release({ success: true });
    const next = await controller.acquire(request());
    expect(next.evidence).toMatchObject({ decision: 'admit', reason: 'admitted' });
    next.release({ success: true });
  });

  it('rejects unknown cost and oversized batches with typed independent reasons', async () => {
    const guarded = limits({ maxCostUsd: 1, allowUnknownCost: false, maxBatchSize: 2 });
    const controller = new DecisionAdmissionController(() => ({ principal: guarded, workspace: guarded, provider: guarded }));
    await expect(controller.acquire(request(new AbortController().signal, { costUsd: null }))).rejects.toMatchObject({ evidence: { reason: 'unknown-cost' } });
    await expect(controller.acquire(request(new AbortController().signal, { costUsd: 0.1, batchSize: 3 }))).rejects.toMatchObject({ evidence: { reason: 'batch-size' } });
  });

  it.each([
    { limits: { maxRequestBytes: 8 }, estimate: { requestBytes: 9 }, reason: 'request-too-large' },
    { limits: { maxItems: 2 }, estimate: { items: 3 }, reason: 'too-many-items' },
    { limits: { maxRetainedWork: 2 }, estimate: {}, reason: 'unknown-retained-work' },
    { limits: { maxRetainedWork: 2 }, estimate: { retainedWork: 3 }, reason: 'retained-work' },
  ] as const)('rejects $reason independently before queueing', async ({ limits: overrides, estimate, reason }) => {
    const guarded = limits(overrides);
    const controller = new DecisionAdmissionController(() => ({ principal: guarded, workspace: guarded, provider: guarded }));
    await expect(controller.acquire(request(new AbortController().signal, estimate)))
      .rejects.toMatchObject({ retryable: false, evidence: { decision: 'reject', reason } });
  });

  it.each([
    { limits: { requestsPerMinute: 1 }, estimate: {}, reason: 'requests-per-minute' },
    { limits: { tokensPerSecond: 1 }, estimate: { tokens: 1 }, reason: 'tokens-per-second' },
  ] as const)('defers $reason independently after its bucket is consumed', async ({ limits: overrides, estimate, reason }) => {
    const guarded = limits(overrides);
    const controller = new DecisionAdmissionController(() => ({ principal: guarded, workspace: guarded, provider: guarded }));
    const first = await controller.acquire(request(new AbortController().signal, estimate));
    first.release({ success: true });
    const abort = new AbortController();
    const waiting = controller.acquire(request(abort.signal, estimate));
    let settled = false;
    void waiting.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled, `${reason} must independently hold the next request`).toBe(false);
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ evidence: { reason: 'cancelled' } });
  });

  it('enforces invocation-scoped attempt and cost budgets independently', async () => {
    const attemptLimits = limits({ maxAttempts: 1 });
    const attempts = new DecisionAdmissionController(() => ({ principal: attemptLimits, workspace: attemptLimits, provider: attemptLimits }));
    const first = await attempts.acquire(request(new AbortController().signal, { attempts: 1 }));
    first.release({ success: true });
    await expect(attempts.acquire(request(new AbortController().signal, { attempts: 1 }))).rejects.toMatchObject({ evidence: { reason: 'attempts' } });

    const costLimits = limits({ maxCostUsd: 0.1, allowUnknownCost: false });
    const costs = new DecisionAdmissionController(() => ({ principal: costLimits, workspace: costLimits, provider: costLimits }));
    const paid = await costs.acquire(request(new AbortController().signal, { costUsd: 0.06 }));
    paid.release({ success: true });
    await expect(costs.acquire(request(new AbortController().signal, { costUsd: 0.06 }))).rejects.toMatchObject({ evidence: { reason: 'cost' } });
  });

  it.each([
    { tokens: -1 }, { tokens: NaN }, { tokens: Infinity }, { requestBytes: 1.5 },
    { items: -1 }, { attempts: NaN }, { batchSize: Infinity }, { retainedWork: -1 },
    { costUsd: -0.01 }, { costUsd: NaN }, { costUsd: Infinity },
  ])('rejects malformed resource estimates before acquiring a permit: %j', async estimate => {
    const guarded = limits({ maxCostUsd: 1 });
    const controller = new DecisionAdmissionController(() => ({ principal: guarded, workspace: guarded, provider: guarded }));
    await expect(controller.acquire(request(new AbortController().signal, estimate)))
      .rejects.toMatchObject({ retryable: false, evidence: { decision: 'reject', reason: 'invalid-estimate',
        estimatedTokens: null, estimatedCostUsd: null, active: 0, queued: 0 } });
    const safe = await controller.acquire(request(new AbortController().signal, { costUsd: 0.1, tokens: 1 }));
    safe.release({ success: true });
  });

  it('revalidates queued work against a tightened admission profile before dispatch', async () => {
    let current = limits({ maxRequestBytes: 1_000 });
    const controller = new DecisionAdmissionController(() => ({ principal: current, workspace: current, provider: current }));
    const first = await controller.acquire(request());
    const waiting = controller.acquire({ ...request(), budgetId: 'waiting', estimate: { requestBytes: 100 } });
    let dispatched = false;
    void waiting.then(() => { dispatched = true; }, () => undefined);
    await Promise.resolve();
    current = limits({ maxRequestBytes: 50 });
    first.release({ success: true });
    await expect(waiting).rejects.toMatchObject({ evidence: { reason: 'request-too-large' } });
    expect(dispatched).toBe(false);
    const safe = await controller.acquire({ ...request(), budgetId: 'safe', estimate: { requestBytes: 10 } });
    safe.release({ success: true });
  });

  it('bounds queues and emits only aggregate metadata', async () => {
    const guarded = limits({ maxQueueLength: 1 });
    const controller = new DecisionAdmissionController(() => ({ principal: guarded, workspace: guarded, provider: guarded }));
    const first = await controller.acquire(request());
    const abort = new AbortController();
    const queued = controller.acquire(request(abort.signal));
    await expect(controller.acquire(request())).rejects.toSatisfy((error: unknown) =>
      error instanceof AdmissionError && error.evidence.reason === 'queue-full' && !('principalId' in error.evidence));
    abort.abort();
    await expect(queued).rejects.toBeInstanceOf(AdmissionError);
    first.release({ success: true });
  });

  it('coordinates Retry-After per provider without blocking unrelated providers', async () => {
    const shared = limits({ concurrency: 2 });
    const controller = new DecisionAdmissionController(() => ({ principal: shared, workspace: shared, provider: shared }));
    controller.coordinateRetryAfter('jev', 100);
    const unrelated = await controller.acquire({ ...request(), providerId: 'llm-subagent' });
    expect(unrelated.evidence.reason).toBe('admitted');
    unrelated.release({ success: true });
    const abort = new AbortController();
    const paused = controller.acquire(request(abort.signal));
    abort.abort();
    await expect(paused).rejects.toMatchObject({ evidence: { reason: 'cancelled' } });
  });

  it('resumes a provider lane after Retry-After and wakes at an earlier deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const shared = limits({ concurrency: 2, maxQueueWaitMs: 1_000 });
    const controller = new DecisionAdmissionController(() => ({ principal: shared, workspace: shared, provider: shared }));
    controller.coordinateRetryAfter('jev', 100);
    const resumed = controller.acquire({ ...request(), deadlineEpochMs: 500 });
    await vi.advanceTimersByTimeAsync(99);
    let settled = false;
    void resumed.then(() => { settled = true; });
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const lease = await resumed;
    expect(lease.evidence).toMatchObject({ decision: 'admit', reason: 'admitted' });
    lease.release({ success: true });

    controller.coordinateRetryAfter('jev', 100);
    const expired = controller.acquire({ ...request(), deadlineEpochMs: Date.now() + 20 });
    const expiredAssertion = expect(expired).rejects.toMatchObject({ evidence: { reason: 'deadline-exceeded' } });
    await vi.advanceTimersByTimeAsync(20);
    await expiredAssertion;
  });

  it('caps half-open probes and reopens the breaker when the probe fails', async () => {
    let now = 0;
    const guarded = limits({ circuitBreaker: { failureThreshold: 1, openMs: 100, halfOpenMaxCalls: 1 } });
    const controller = new DecisionAdmissionController(() => ({ principal: guarded, workspace: guarded, provider: guarded }), () => now);
    const failed = await controller.acquire({ ...request(), deadlineEpochMs: 1_000 });
    failed.release({ success: false });
    const probePromise = controller.acquire({ ...request(), deadlineEpochMs: 1_000 });
    now = 101;
    const followerAbort = new AbortController();
    const follower = controller.acquire({ ...request(followerAbort.signal), deadlineEpochMs: 1_000 });
    const probe = await probePromise;
    expect(probe.evidence.breakerState).toBe('half-open');
    let followerSettled = false;
    void follower.then(() => { followerSettled = true; }, () => { followerSettled = true; });
    await Promise.resolve();
    expect(followerSettled).toBe(false);
    probe.release({ success: false });
    await Promise.resolve();
    expect(followerSettled).toBe(false);
    followerAbort.abort();
    await expect(follower).rejects.toMatchObject({ evidence: { reason: 'cancelled' } });
  });

  it('moves a failed provider through open and half-open back to closed', async () => {
    let now = 0;
    const guarded = limits({ circuitBreaker: { failureThreshold: 1, openMs: 100, halfOpenMaxCalls: 1 } });
    const controller = new DecisionAdmissionController(() => ({ principal: guarded, workspace: guarded, provider: guarded }), () => now);
    const failed = await controller.acquire({ ...request(), deadlineEpochMs: 1_000 });
    failed.release({ success: false });
    const probe = controller.acquire({ ...request(), deadlineEpochMs: 1_000 });
    now = 101;
    const follower = controller.acquire({ ...request(), deadlineEpochMs: 1_000 });
    const halfOpen = await probe;
    expect(halfOpen.evidence.breakerState).toBe('half-open');
    halfOpen.release({ success: true });
    const closed = await follower;
    expect(closed.evidence.breakerState).toBe('closed');
    closed.release({ success: true });
  });
});
