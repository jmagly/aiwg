import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdmissionError,
  BoundedDecisionMetrics,
  DecisionAdmissionController,
  DecisionAdmissionRegistry,
  evaluateDecisionRuleset,
  type AdapterObservation,
  type AdmissionBreakerTransitionRecord,
  type AdmissionLease,
  type AdmissionProfileChangeRecord,
  type AdmissionRequest,
  type AdmissionScopeLimits,
  type DecisionAdapter,
  type DecisionAdmissionLimits,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionRuleset,
  type DecisionSchedulerPolicy,
  type DecisionTelemetrySpan,
} from '../../../src/decision/index.js';

const limits = (overrides: Partial<DecisionAdmissionLimits> = {}): DecisionAdmissionLimits =>
  ({ concurrency: 4, maxQueueLength: 64, maxQueueWaitMs: 60_000, ...overrides });

const request = (principalId: string, overrides: Partial<AdmissionRequest> = {}): AdmissionRequest => ({
  budgetId: `budget-${principalId}-${Math.random()}`, principalId, workspaceId: 'workspace', providerId: 'jev',
  estimate: {}, deadlineEpochMs: Date.now() + 600_000, signal: new AbortController().signal, ...overrides,
});

/** A bare controller whose principals have their own limits over shared workspace and provider pools. */
function controller(principals: Record<string, DecisionAdmissionLimits>, shared: Partial<AdmissionScopeLimits> = {},
  options: ConstructorParameters<typeof DecisionAdmissionController>[2] = {}): DecisionAdmissionController {
  return new DecisionAdmissionController(admission => ({
    principal: principals[admission.principalId]!, workspace: shared.workspace ?? limits(), provider: shared.provider ?? limits(),
  }), Date.now, { principals: () => Object.entries(principals), ...options });
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

/** Acquire and record the lease. Waiters left queued at the end of a test are cancelled by `signal`. */
function track(admission: DecisionAdmissionController, principalId: string, admitted: AdmissionLease[], signal = new AbortController().signal) {
  const pending = admission.acquire(request(principalId, { signal })).then(lease => { admitted.push(lease); return lease; });
  pending.catch(() => undefined);
  return pending;
}

describe('reserved capacity and per-principal share caps (CNC-ADMIT-RESERVE, CNC-ADMIT-SHARE)', () => {
  it('CNC-ADMIT-RESERVE-001 holds a quiet principal\'s reservation back from a noisy principal above the shared limit', async () => {
    const admission = controller({ noisy: limits({ concurrency: 8 }), quiet: limits({ concurrency: 2, reservedConcurrency: 1 }) });
    const noisy: AdmissionLease[] = [];
    for (let index = 0; index < 6; index += 1) void track(admission, 'noisy', noisy);
    await settle();
    // Workspace concurrency is 4; one permit stays reserved for the idle quiet principal.
    expect(noisy).toHaveLength(3);
    const quiet: AdmissionLease[] = [];
    void track(admission, 'quiet', quiet);
    await settle();
    expect(quiet).toHaveLength(1);
    expect(quiet[0]!.evidence).toMatchObject({ decision: 'admit', queued: 0 });
    // Once the quiet principal uses its reservation, a released noisy permit goes back to noisy work.
    noisy[0]!.release({ success: true });
    await settle();
    expect(noisy).toHaveLength(4);
  });

  it('CNC-ADMIT-RESERVE-002 lets an unreserved noisy principal take the whole shared pool (control)', async () => {
    const admission = controller({ noisy: limits({ concurrency: 8 }), quiet: limits({ concurrency: 2 }) });
    const noisy: AdmissionLease[] = [];
    for (let index = 0; index < 6; index += 1) void track(admission, 'noisy', noisy);
    await settle();
    expect(noisy).toHaveLength(4);
  });

  it('CNC-ADMIT-SHARE-001 caps one principal\'s share of workspace and provider concurrency', async () => {
    const workspaceShare = controller({ noisy: limits({ concurrency: 8 }), quiet: limits() },
      { workspace: limits({ maxPrincipalShare: 0.5 }) });
    const noisy: AdmissionLease[] = [];
    for (let index = 0; index < 6; index += 1) void track(workspaceShare, 'noisy', noisy);
    await settle();
    expect(noisy).toHaveLength(2);
    const quiet: AdmissionLease[] = [];
    for (let index = 0; index < 2; index += 1) void track(workspaceShare, 'quiet', quiet);
    await settle();
    expect(quiet).toHaveLength(2);

    const providerShare = controller({ noisy: limits({ concurrency: 8 }) }, { provider: limits({ concurrency: 4, maxPrincipalShare: 0.75 }) });
    const capped: AdmissionLease[] = [];
    for (let index = 0; index < 6; index += 1) void track(providerShare, 'noisy', capped);
    await settle();
    expect(capped).toHaveLength(3);
  });

  it('CNC-ADMIT-SHARE-002 stops a noisy principal from filling the shared queue for others', async () => {
    const admission = controller({ noisy: limits({ concurrency: 8, maxQueueLength: 64 }), quiet: limits() },
      { workspace: limits({ concurrency: 1, maxQueueLength: 4, maxPrincipalShare: 0.5 }) });
    const noisy: AdmissionLease[] = [];
    void track(admission, 'noisy', noisy);
    await settle();
    const queued = [track(admission, 'noisy', noisy), track(admission, 'noisy', noisy)];
    const rejected = await track(admission, 'noisy', noisy).catch(error => error as AdmissionError);
    expect(rejected).toBeInstanceOf(AdmissionError);
    expect((rejected as AdmissionError).evidence).toMatchObject({ decision: 'reject', reason: 'queue-full' });
    expect((rejected as AdmissionError).retryable).toBe(true);
    // The quiet principal can still queue even though the noisy principal is at its share.
    const quiet = admission.acquire(request('quiet'));
    await settle();
    expect(admission.snapshot()).toEqual({ active: 1, queued: 3 });
    noisy[0]!.release({ success: true });
    await settle();
    (await queued[0]!).release({ success: true });
    (await quiet).release({ success: true });
    (await queued[1]!).release({ success: true });
  });

  it('fails closed on reservations that exceed shared capacity and on invalid shares', () => {
    const registry = new DecisionAdmissionRegistry();
    const policy = (principal: string, principalLimits: DecisionAdmissionLimits, workspace = limits()): DecisionSchedulerPolicy => ({
      enabled: true, profileVersion: 'v1', workspace: { id: 'reserve', limits: workspace },
      principal: { id: principal, limits: principalLimits }, providers: { jev: limits({ concurrency: 2 }) } });
    registry.register(policy('a', limits({ concurrency: 2, reservedConcurrency: 1 })));
    registry.register(policy('b', limits({ concurrency: 2, reservedConcurrency: 1 })));
    expect(() => registry.register(policy('c', limits({ concurrency: 2, reservedConcurrency: 1 })))).toThrow(/reservations exceed/);
    expect(() => registry.register(policy('d', limits({ concurrency: 1, reservedConcurrency: 2 })))).toThrow(/within the principal concurrency/);
    expect(() => new DecisionAdmissionRegistry().register(policy('e', limits(), limits({ maxPrincipalShare: 1.5 })))).toThrow(/share/);
  });
});

describe('large-token fairness (CNC-ADMIT-TOKEN)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('CNC-ADMIT-TOKEN-001 reserves a deferred large-token request so small work cannot starve it', async () => {
    vi.useFakeTimers();
    const admission = controller({ small: limits({ concurrency: 64 }), huge: limits({ concurrency: 64 }) },
      { workspace: limits({ concurrency: 64 }), provider: limits({ concurrency: 64, tokensPerSecond: 1_000 }) });
    for (let index = 0; index < 9; index += 1) (await admission.acquire(request('small', { estimate: { tokens: 100 } }))).release({ success: true });
    const started = Date.now();
    const order: string[] = [];
    let hugeAdmittedAt = 0;
    const huge = admission.acquire(request('huge', { estimate: { tokens: 900 } }))
      .then(lease => { hugeAdmittedAt = Date.now() - started; order.push('huge'); lease.release({ success: true }); });
    const smalls: Array<Promise<void>> = [];
    for (let tick = 0; tick < 20; tick += 1) {
      smalls.push(admission.acquire(request('small', { estimate: { tokens: 100 } }))
        .then(lease => { order.push('small'); lease.release({ success: true }); }));
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([huge, ...smalls]);
    // 100 tokens remain after the warm-up, so 900 more need 800 ms of refill.
    expect(order[0]).toBe('huge');
    expect(hugeAdmittedAt).toBeGreaterThanOrEqual(800);
    expect(hugeAdmittedAt).toBeLessThan(1_000);
    expect(order.filter(entry => entry === 'small')).toHaveLength(20);
  });
});

describe('circuit-breaker thresholds and transition telemetry (CNC-ADMIT-BREAKER)', () => {
  it('CNC-ADMIT-BREAKER-001 stays closed at N-1 failures, opens at N, and records every transition', async () => {
    let now = 1_000;
    const observed: AdmissionBreakerTransitionRecord[] = [];
    const breaker = { failureThreshold: 3, openMs: 500, halfOpenMaxCalls: 1 };
    const admission = new DecisionAdmissionController(() => ({ principal: limits(), workspace: limits(), provider: limits({ circuitBreaker: breaker }) }),
      () => now, { onBreakerTransition: transition => observed.push(transition) });
    const attempt = async (success: boolean) => {
      const lease = await admission.acquire(request('principal', { deadlineEpochMs: now + 10_000 }));
      lease.release({ success });
      return lease.evidence;
    };
    for (let failure = 1; failure < breaker.failureThreshold; failure += 1) {
      expect((await attempt(false)).breakerTransitions).toBeUndefined();
    }
    expect(admission.breakerTransitions()).toEqual([]);
    const opening = await attempt(false);
    expect(opening.breakerTransitions).toEqual([{ from: 'closed', to: 'open' }]);
    // While open, new work is deferred rather than dispatched.
    const cancel = new AbortController();
    const deferred = admission.acquire(request('principal', { deadlineEpochMs: now + 10_000, signal: cancel.signal }));
    await settle();
    expect(admission.snapshot()).toEqual({ active: 0, queued: 1 });
    cancel.abort();
    await expect(deferred).rejects.toMatchObject({ evidence: { reason: 'cancelled', breakerState: 'open' } });
    now += breaker.openMs;
    const probe = await attempt(true);
    expect(probe.breakerTransitions).toEqual([{ from: 'open', to: 'half-open' }, { from: 'half-open', to: 'closed' }]);
    expect(observed.map(({ from, to }) => `${from}->${to}`)).toEqual(['closed->open', 'open->half-open', 'half-open->closed']);
    expect(observed[0]).toMatchObject({ providerId: 'jev', atEpochMs: 1_000, failures: 3 });
    expect(admission.breakerTransitions()).toEqual(observed);
    expect(JSON.stringify(observed)).not.toContain('principal');
  });
});

describe('admission telemetry (CNC-ADMIT-TELEMETRY)', () => {
  const fixture = <T>(name: string): T => JSON.parse(readFileSync(`examples/decision/${name}`, 'utf8')) as T;
  const success = (alias: string): AdapterObservation => ({
    status: 'success', reason: 'none', value: alias === 'category' ? 'documentation' : alias === 'severity' ? 0.25 : 0.05,
    uncertainty: { source: 'provider', profile: alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1',
      calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
    actualModel: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: 'fixture',
  });

  it('CNC-ADMIT-TELEMETRY-001 emits metadata-only decision.admit spans with breaker transition events', async () => {
    let calls = 0;
    const adapter: DecisionAdapter = {
      id: 'jev', version: '1.0.0',
      capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'],
        features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10,
        confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true }),
      evaluate: async request => (calls++ === 0
        ? { ...success(request.alias), status: 'error', reason: 'service-error', value: undefined } : success(request.alias)),
    };
    const spans: DecisionTelemetrySpan[] = [];
    let span = 1;
    const metrics = new BoundedDecisionMetrics();
    const shared = limits({ circuitBreaker: { failureThreshold: 1, openMs: 60_000, halfOpenMaxCalls: 1 } });
    const result = await evaluateDecisionRuleset({
      ruleset: fixture<DecisionRuleset>('ruleset.json'), binding: fixture<DecisionBinding>('binding-jev.json'),
      definitions: { category: fixture<DecisionDefinition>('decision-category.json'), severity: fixture('decision-severity.json'),
        core: fixture('decision-core_unavailable.json') },
      input: fixture('input.json'), runId: 'run', invocationId: 'admit-telemetry', adapters: { jev: adapter },
      scheduler: { enabled: true, profileVersion: 'telemetry-v1', workspace: { id: 'secret-workspace-id', limits: limits() },
        principal: { id: 'secret-principal-id', limits: limits({ maxQueueWaitMs: 20 }) }, providers: { jev: shared } },
      telemetry: { hook: { emit: emitted => { spans.push(emitted); } }, metrics,
        ids: { traceId: () => '1'.repeat(32), spanId: () => (span++).toString(16).padStart(16, '0') } },
    });
    expect(calls).toBe(1);
    const admits = spans.filter(candidate => candidate.name === 'decision.admit');
    expect(admits).toHaveLength(3);
    expect(admits[0]).toMatchObject({ status: 'ok', attributes: { 'aiwg.admission.decision': 'admit', 'aiwg.admission.reason': 'admitted',
      'aiwg.breaker.status': 'closed', 'aiwg.adapter.id': 'jev' } });
    expect(admits[0]!.events).toEqual([expect.objectContaining({ name: 'breaker.transition',
      attributes: { 'aiwg.breaker.from': 'closed', 'aiwg.breaker.to': 'open' } })]);
    // Work deferred behind the open breaker is shed at its queue bound; the span carries the breaker state.
    expect(admits.slice(1).map(candidate => [candidate.status, candidate.attributes['aiwg.admission.reason'], candidate.attributes['aiwg.breaker.status']]))
      .toEqual([['error', 'queue-timeout', 'open'], ['error', 'queue-timeout', 'open']]);
    expect(result.spec.evaluations.severity?.spec.attempts[0]?.admission).toMatchObject({ decision: 'reject', reason: 'queue-timeout' });
    const serialized = JSON.stringify(spans);
    expect(serialized).not.toContain('secret-principal-id');
    expect(serialized).not.toContain('secret-workspace-id');
    const points = metrics.snapshot();
    expect(points.filter(point => point.name === 'decision.admission')).toHaveLength(3);
    expect(points.filter(point => point.name === 'decision.throttles')).toHaveLength(2);
    expect(points.filter(point => point.name === 'decision.breaker_transitions')).toHaveLength(1);
    expect(points.find(point => point.name === 'decision.throttles')?.dimensions).toMatchObject({
      'aiwg.admission.reason': 'queue-timeout', 'aiwg.breaker.status': 'open' });
  });
});

describe('profile change audit (CNC-ADMIT-AUDIT)', () => {
  it('CNC-ADMIT-AUDIT-001 records initial, change, and rollback revisions and nothing for a refused conflict', () => {
    let now = 10;
    const registry = new DecisionAdmissionRegistry();
    const records: AdmissionProfileChangeRecord[] = [];
    const unsubscribe = registry.onProfileChange(record => records.push(record));
    const policy = (profileVersion: string, concurrency: number): DecisionSchedulerPolicy => ({
      enabled: true, profileVersion, workspace: { id: 'audited', limits: limits({ concurrency }) },
      principal: { id: 'principal', limits: limits() }, providers: { jev: limits() } });
    const clock = () => now;
    registry.register(policy('v1', 4), clock);
    registry.register(policy('v1', 4), clock);
    now = 20; registry.register(policy('v2', 2), clock);
    expect(() => registry.register(policy('v2', 3), clock)).toThrow(/conflicts/);
    now = 30; registry.register(policy('v1', 4), clock);
    unsubscribe();
    registry.register(policy('v3', 1), clock);
    expect(records.map(record => [record.kind, record.previousProfileVersion, record.profileVersion, record.atEpochMs]))
      .toEqual([['initial', null, 'v1', 10], ['change', 'v1', 'v2', 20], ['rollback', 'v2', 'v1', 30]]);
    expect(records[0]!.digest).toBe(records[2]!.digest);
    expect(records[0]!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(registry.profileHistory('audited').map(record => record.profileVersion)).toEqual(['v1', 'v2', 'v1', 'v3']);
    expect(JSON.stringify(records)).not.toContain('"concurrency"');
  });
});
