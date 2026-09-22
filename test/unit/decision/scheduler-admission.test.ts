import { describe, expect, it } from 'vitest';
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
});

describe('decision provider admission', () => {
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
