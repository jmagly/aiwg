import { canonicalJson } from '../security/artifact-trust.js';
import type { DecisionAdmissionEstimate, DecisionAdmissionEvidence, DecisionAdmissionLimits, DecisionSchedulerPolicy } from './types.js';

export interface AdmissionRequest {
  /** Stable invocation/budget scope supplied by the trusted host. */
  budgetId: string;
  principalId: string;
  workspaceId: string;
  providerId: string;
  estimate: DecisionAdmissionEstimate;
  deadlineEpochMs: number;
  signal: AbortSignal;
}

export interface AdmissionLease {
  evidence: DecisionAdmissionEvidence;
  release(outcome?: { success: boolean; retryAfterMs?: number }): void;
}

export class AdmissionError extends Error {
  constructor(readonly evidence: DecisionAdmissionEvidence, readonly retryable: boolean) {
    super(`decision admission ${evidence.decision}: ${evidence.reason}`);
  }
}

interface Bucket { value: number; updatedAt: number }
interface Breaker { state: 'closed' | 'open' | 'half-open'; failures: number; openedAt: number; halfOpenActive: number }
interface Waiter {
  request: AdmissionRequest;
  resolve: (lease: AdmissionLease) => void;
  reject: (error: AdmissionError) => void;
  enqueuedAt: number;
  cleanup: () => void;
}

export interface AdmissionScopeLimits {
  principal: DecisionAdmissionLimits;
  workspace: DecisionAdmissionLimits;
  provider: DecisionAdmissionLimits;
}

/** Shared, in-process controller. Hosts may share one instance across invocations. */
export class DecisionAdmissionController {
  private active = 0;
  private readonly activePrincipal = new Map<string, number>();
  private readonly activeWorkspace = new Map<string, number>();
  private readonly activeProvider = new Map<string, number>();
  private readonly requestBuckets = new Map<string, Bucket>();
  private readonly tokenBuckets = new Map<string, Bucket>();
  private readonly costSpent = new Map<string, number>();
  private readonly tokensReserved = new Map<string, number>();
  private readonly attempts = new Map<string, number>();
  private readonly breakers = new Map<string, Breaker>();
  private readonly providerPausedUntil = new Map<string, number>();
  private readonly queues = new Map<string, Waiter[]>();
  private laneCursor = 0;
  private retryPressure = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** Returns null when the trusted profile has no limits for the request's provider. */
    private readonly limits: (request: AdmissionRequest) => AdmissionScopeLimits | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when no lease is active and no request is queued, optionally for one principal. */
  idle(principalId?: string): boolean {
    if (principalId === undefined) return this.active === 0 && this.queuedCount() === 0;
    return !this.activePrincipal.get(principalId) && this.queuedCount(request => request.principalId === principalId) === 0;
  }

  async acquire(request: AdmissionRequest): Promise<AdmissionLease> {
    const checked = this.preflight(request);
    if (checked) throw checked;
    const lane = `${request.providerId}\u0000${request.workspaceId}\u0000${request.principalId}`;
    const limits = this.limits(request)!;
    const queueCounts = [this.queuedCount(candidate => candidate.principalId === request.principalId),
      this.queuedCount(candidate => candidate.workspaceId === request.workspaceId),
      this.queuedCount(candidate => candidate.providerId === request.providerId)];
    const queueLimits = [limits.principal.maxQueueLength, limits.workspace.maxQueueLength, limits.provider.maxQueueLength];
    if (queueLimits.some((limit, index) => limit !== undefined && queueCounts[index]! >= limit)) {
      throw this.error('queue-full', 'reject', request, true, this.jitterHint(250));
    }
    return await new Promise<AdmissionLease>((resolve, reject) => {
      const queue = this.queues.get(lane) ?? [];
      const cancelled = (): void => { this.remove(request, 'cancelled'); };
      request.signal.addEventListener('abort', cancelled, { once: true });
      queue.push({ request, resolve, reject, enqueuedAt: this.now(),
        cleanup: () => request.signal.removeEventListener('abort', cancelled) });
      this.queues.set(lane, queue);
      this.pump();
    });
  }

  coordinateRetryAfter(providerId: string, retryAfterMs: number): void {
    this.providerPausedUntil.set(providerId, Math.max(this.providerPausedUntil.get(providerId) ?? 0,
      this.now() + Math.max(0, retryAfterMs)));
    this.retryPressure += 1;
    this.schedulePump(Math.max(1, retryAfterMs));
  }

  /** Release invocation-scoped counters once every active lease has settled. */
  releaseBudget(budgetId: string): void {
    const prefix = `${budgetId}:`;
    for (const key of this.attempts.keys()) if (key.startsWith(prefix)) this.attempts.delete(key);
    for (const key of this.costSpent.keys()) if (key.startsWith(prefix)) this.costSpent.delete(key);
    for (const key of this.tokensReserved.keys()) if (key.startsWith(prefix)) this.tokensReserved.delete(key);
  }

  private preflight(request: AdmissionRequest): AdmissionError | null {
    const scoped = this.limits(request);
    const estimate = request.estimate;
    if (request.signal.aborted) return this.error('cancelled', 'reject', request, false);
    if (!scoped) return this.error('unconfigured-provider', 'reject', request, false);
    const all = Object.values(scoped);
    if (this.now() >= request.deadlineEpochMs) return this.error('deadline-exceeded', 'reject', request, false);
    for (const count of [estimate.tokens, estimate.requestBytes, estimate.items, estimate.attempts, estimate.batchSize, estimate.retainedWork]) {
      if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) {
        return this.error('invalid-estimate', 'reject', request, false);
      }
    }
    if (estimate.costUsd !== undefined && estimate.costUsd !== null
      && (!Number.isFinite(estimate.costUsd) || estimate.costUsd < 0)) {
      return this.error('invalid-estimate', 'reject', request, false);
    }
    for (const limit of all) {
      if (estimate.batchSize !== undefined && limit.maxBatchSize !== undefined && estimate.batchSize > limit.maxBatchSize) return this.error('batch-size', 'reject', request, false);
      if (estimate.requestBytes !== undefined && limit.maxRequestBytes !== undefined && estimate.requestBytes > limit.maxRequestBytes) return this.error('request-too-large', 'reject', request, false);
      if (estimate.items !== undefined && limit.maxItems !== undefined && estimate.items > limit.maxItems) return this.error('too-many-items', 'reject', request, false);
      if (limit.maxRetainedWork !== undefined && estimate.retainedWork === undefined) return this.error('unknown-retained-work', 'reject', request, false);
      if (estimate.retainedWork !== undefined && limit.maxRetainedWork !== undefined && estimate.retainedWork > limit.maxRetainedWork) return this.error('retained-work', 'reject', request, false);
      if (estimate.costUsd == null && limit.maxCostUsd !== undefined && !limit.allowUnknownCost) return this.error('unknown-cost', 'reject', request, false);
      if (estimate.tokens === undefined && limit.maxTokens !== undefined) return this.error('unknown-tokens', 'reject', request, false);
    }
    return null;
  }

  private pump(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const lanes = [...this.queues.keys()].filter(lane => this.queues.get(lane)?.length);
    if (!lanes.length) return;
    let nearest = Number.POSITIVE_INFINITY;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let offset = 0; offset < lanes.length; offset += 1) {
        const position = (this.laneCursor + offset) % lanes.length;
        const queue = this.queues.get(lanes[position]!)!;
        const waiter = queue[0];
        if (!waiter) continue;
        const waitLimit = Math.min(...Object.values(this.limits(waiter.request) ?? {}).map(limit => limit.maxQueueWaitMs ?? Number.POSITIVE_INFINITY));
        if (waiter.request.signal.aborted || this.now() >= waiter.request.deadlineEpochMs || this.now() - waiter.enqueuedAt >= waitLimit) {
          queue.shift();
          waiter.cleanup();
          waiter.reject(this.error(waiter.request.signal.aborted ? 'cancelled' : this.now() >= waiter.request.deadlineEpochMs ? 'deadline-exceeded' : 'queue-timeout', 'reject', waiter.request, false));
          progressed = true;
          continue;
        }
        // A profile may tighten while a client is queued. Recheck non-concurrency
        // limits at dispatch, not only when the waiter first enters the queue.
        const admitted = this.preflight(waiter.request) ?? this.tryAdmit(waiter);
        if (admitted instanceof AdmissionError) {
          if (!admitted.retryable) { queue.shift(); waiter.cleanup(); waiter.reject(admitted); progressed = true; }
          else nearest = Math.min(nearest, admitted.evidence.retryAfterMs ?? 25,
            Math.max(1, waiter.request.deadlineEpochMs - this.now()),
            Math.max(1, waitLimit - (this.now() - waiter.enqueuedAt)));
          continue;
        }
        queue.shift();
        waiter.cleanup();
        this.laneCursor = (position + 1) % lanes.length;
        waiter.resolve(admitted);
        progressed = true;
      }
    }
    for (const [lane, queue] of this.queues) if (!queue.length) this.queues.delete(lane);
    if (this.queuedCount()) this.schedulePump(Number.isFinite(nearest) ? nearest : 25);
  }

  private tryAdmit(waiter: Waiter): AdmissionLease | AdmissionError {
    const request = waiter.request;
    const { principal, workspace, provider } = this.limits(request)!;
    const limits = [principal, workspace, provider];
    const counts = [this.activePrincipal.get(request.principalId) ?? 0, this.activeWorkspace.get(request.workspaceId) ?? 0, this.activeProvider.get(request.providerId) ?? 0];
    if (limits.some((limit, index) => counts[index]! >= limit.concurrency)) return this.error('concurrency', 'defer', request, true, 10);
    const breaker = this.breaker(request.providerId);
    const breakerConfig = provider.circuitBreaker;
    const pausedUntil = this.providerPausedUntil.get(request.providerId) ?? 0;
    if (this.now() < pausedUntil) return this.error('retry-after', 'defer', request, true, pausedUntil - this.now());
    if (breaker.state === 'open') {
      const readyAt = breaker.openedAt + (breakerConfig?.openMs ?? 30_000);
      if (this.now() < readyAt) return this.error('circuit-open', 'defer', request, true, readyAt - this.now());
      breaker.state = 'half-open'; breaker.halfOpenActive = 0;
    }
    if (breaker.state === 'half-open' && breaker.halfOpenActive >= (breakerConfig?.halfOpenMaxCalls ?? 1)) return this.error('circuit-open', 'defer', request, true, 25);
    const keys: Array<[string, DecisionAdmissionLimits]> = [[`p:${request.principalId}`, principal], [`w:${request.workspaceId}`, workspace], [`v:${request.providerId}`, provider]];
    for (const [key, limit] of keys) {
      const budgetKey = `${request.budgetId}:${key}`;
      if (limit.maxAttempts !== undefined && (this.attempts.get(budgetKey) ?? 0) + (request.estimate.attempts ?? 1) > limit.maxAttempts) return this.error('attempts', 'reject', request, false);
      if (limit.maxCostUsd !== undefined && request.estimate.costUsd != null && (this.costSpent.get(budgetKey) ?? 0) + request.estimate.costUsd > limit.maxCostUsd) return this.error('cost', 'reject', request, false);
      if (limit.maxTokens !== undefined && (this.tokensReserved.get(budgetKey) ?? 0) + (request.estimate.tokens ?? 0) > limit.maxTokens) return this.error('tokens', 'reject', request, false);
      // A bucket can never refill beyond its capacity. Fail permanently rather
      // than retaining an impossible waiter until its deadline or queue timeout.
      if (limit.requestsPerMinute === 0) return this.error('requests-per-minute', 'reject', request, false);
      if (limit.tokensPerSecond !== undefined && (request.estimate.tokens ?? 0) > limit.tokensPerSecond) return this.error('tokens-per-second', 'reject', request, false);
      if (limit.requestsPerMinute !== undefined && !this.canConsume(this.requestBuckets, key, limit.requestsPerMinute, limit.requestsPerMinute / 60_000, 1)) return this.error('requests-per-minute', 'defer', request, true, 100);
      if (limit.tokensPerSecond !== undefined && !this.canConsume(this.tokenBuckets, key, limit.tokensPerSecond, limit.tokensPerSecond / 1000, request.estimate.tokens ?? 0)) return this.error('tokens-per-second', 'defer', request, true, 100);
    }
    keys.forEach(([key, limit]) => {
      this.consume(this.requestBuckets, key, limit.requestsPerMinute, limit.requestsPerMinute === undefined ? 0 : limit.requestsPerMinute / 60_000, 1);
      this.consume(this.tokenBuckets, key, limit.tokensPerSecond, limit.tokensPerSecond === undefined ? 0 : limit.tokensPerSecond / 1000, request.estimate.tokens ?? 0);
      const budgetKey = `${request.budgetId}:${key}`;
      this.attempts.set(budgetKey, (this.attempts.get(budgetKey) ?? 0) + (request.estimate.attempts ?? 1));
      if (request.estimate.costUsd != null) this.costSpent.set(budgetKey, (this.costSpent.get(budgetKey) ?? 0) + request.estimate.costUsd);
      if (request.estimate.tokens !== undefined) this.tokensReserved.set(budgetKey, (this.tokensReserved.get(budgetKey) ?? 0) + request.estimate.tokens);
    });
    this.active += 1;
    this.increment(this.activePrincipal, request.principalId);
    this.increment(this.activeWorkspace, request.workspaceId);
    this.increment(this.activeProvider, request.providerId);
    if (breaker.state === 'half-open') breaker.halfOpenActive += 1;
    let released = false;
    const evidence = this.evidence('admitted', 'admit', request, this.now() - waiter.enqueuedAt);
    return { evidence, release: outcome => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.decrement(this.activePrincipal, request.principalId);
      this.decrement(this.activeWorkspace, request.workspaceId);
      this.decrement(this.activeProvider, request.providerId);
      if (breaker.state === 'half-open') breaker.halfOpenActive = Math.max(0, breaker.halfOpenActive - 1);
      if (outcome?.retryAfterMs !== undefined) this.coordinateRetryAfter(request.providerId, outcome.retryAfterMs);
      else if (outcome?.success) { breaker.state = 'closed'; breaker.failures = 0; }
      else if (outcome && breakerConfig && ++breaker.failures >= breakerConfig.failureThreshold) { breaker.state = 'open'; breaker.openedAt = this.now(); }
      this.pump();
    } };
  }

  private breaker(provider: string): Breaker { let value = this.breakers.get(provider); if (!value) { value = { state: 'closed', failures: 0, openedAt: 0, halfOpenActive: 0 }; this.breakers.set(provider, value); } return value; }
  private queuedCount(predicate: (request: AdmissionRequest) => boolean = () => true): number {
    return [...this.queues.values()].reduce((sum, queue) => sum + queue.filter(waiter => predicate(waiter.request)).length, 0);
  }
  private increment(map: Map<string, number>, key: string): void { map.set(key, (map.get(key) ?? 0) + 1); }
  private decrement(map: Map<string, number>, key: string): void { const next = (map.get(key) ?? 1) - 1; if (next) map.set(key, next); else map.delete(key); }
  private canConsume(map: Map<string, Bucket>, key: string, capacity: number, rate: number, amount: number): boolean { const bucket = this.refill(map, key, capacity, rate); return bucket.value >= amount; }
  private consume(map: Map<string, Bucket>, key: string, capacity: number | undefined, rate: number, amount: number): void { if (capacity === undefined) return; const bucket = this.refill(map, key, capacity, rate); bucket.value -= amount; }
  private refill(map: Map<string, Bucket>, key: string, capacity: number, rate: number): Bucket { const at = this.now(); let bucket = map.get(key); if (!bucket) { bucket = { value: capacity, updatedAt: at }; map.set(key, bucket); } else { bucket.value = Math.min(capacity, bucket.value + Math.max(0, at - bucket.updatedAt) * rate); bucket.updatedAt = at; } return bucket; }
  private remove(request: AdmissionRequest, reason: 'cancelled'): void { for (const queue of this.queues.values()) { const index = queue.findIndex(waiter => waiter.request === request); if (index >= 0) { const [waiter] = queue.splice(index, 1); waiter!.cleanup(); waiter!.reject(this.error(reason, 'reject', request, false)); break; } } this.pump(); }
  private evidence(reason: DecisionAdmissionEvidence['reason'], decision: DecisionAdmissionEvidence['decision'], request: AdmissionRequest, queueDelayMs = 0, retryAfterMs?: number): DecisionAdmissionEvidence { const breaker = this.breaker(request.providerId); return { decision, reason, queueDelayMs: Math.max(0, queueDelayMs), active: this.activePrincipal.get(request.principalId) ?? 0, queued: Math.max(0, this.queuedCount(candidate => candidate.principalId === request.principalId) - ([...this.queues.values()].some(queue => queue.some(waiter => waiter.request === request)) ? 1 : 0)), estimatedTokens: Number.isSafeInteger(request.estimate.tokens) && request.estimate.tokens! >= 0 ? request.estimate.tokens! : null, estimatedCostUsd: request.estimate.costUsd != null && Number.isFinite(request.estimate.costUsd) && request.estimate.costUsd >= 0 ? request.estimate.costUsd : null, retryPressure: this.retryPressure, breakerState: breaker.state, ...(retryAfterMs === undefined ? {} : { retryAfterMs: this.jitterHint(retryAfterMs) }) }; }
  private error(reason: DecisionAdmissionEvidence['reason'], decision: 'defer' | 'reject', request: AdmissionRequest, retryable: boolean, retryAfterMs?: number): AdmissionError { return new AdmissionError(this.evidence(reason, decision, request, 0, retryAfterMs), retryable); }
  private jitterHint(value: number): number { return Math.max(1, Math.min(30_000, Math.round(value * 0.875))); }
  private schedulePump(delay: number): void { if (this.timer) return; this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, Math.max(1, Math.min(delay, 30_000))); }
}

interface AdmissionScope {
  controller: DecisionAdmissionController;
  now: () => number;
  profileVersion: string;
  workspace: DecisionAdmissionLimits;
  providers: Record<string, DecisionAdmissionLimits>;
  principals: Map<string, DecisionAdmissionLimits>;
  /** Content digests per (profile revision, scope), used to reject same-revision conflicts. */
  revisions: Map<string, string>;
}

export class AdmissionProfileConflictError extends Error {
  constructor() { super('scheduler profile revision conflicts with the registered revision'); }
}

const MAX_TRACKED_REVISIONS = 4096;
const MAX_TRACKED_PRINCIPALS = 4096;

/**
 * Trusted-scope controller registry. Admission state is keyed by the host's
 * workspace ID, not by the identity of the policy object, so structurally equal
 * policies built per request share principal, workspace, and provider ceilings.
 *
 * The most recently registered `profileVersion` supplies the current limits for
 * a workspace (queued work is revalidated against it). Registering different
 * limits under a revision already seen for the same scope fails closed: a
 * changed profile must carry a new `profileVersion`.
 */
export class DecisionAdmissionRegistry {
  private readonly scopes = new Map<string, AdmissionScope>();

  constructor(private readonly maxIdleScopes = 1024) {}

  /** Record the policy as the workspace's current profile and return its controller. */
  register(policy: DecisionSchedulerPolicy, now: () => number = Date.now): DecisionAdmissionController {
    const scope = this.scopeFor(policy, now);
    const workspaceDigest = canonicalJson({ workspace: policy.workspace.limits, providers: policy.providers });
    const principalDigest = canonicalJson(policy.principal.limits);
    const workspaceKey = `w\u0000${policy.profileVersion}`;
    const principalKey = `p\u0000${policy.principal.id}\u0000${policy.profileVersion}`;
    const knownWorkspace = scope.revisions.get(workspaceKey);
    const knownPrincipal = scope.revisions.get(principalKey);
    if ((knownWorkspace !== undefined && knownWorkspace !== workspaceDigest)
      || (knownPrincipal !== undefined && knownPrincipal !== principalDigest)) throw new AdmissionProfileConflictError();
    this.remember(scope.revisions, workspaceKey, workspaceDigest, MAX_TRACKED_REVISIONS);
    this.remember(scope.revisions, principalKey, principalDigest, MAX_TRACKED_REVISIONS);
    scope.profileVersion = policy.profileVersion;
    scope.workspace = structuredClone(policy.workspace.limits);
    scope.providers = structuredClone(policy.providers);
    scope.principals.delete(policy.principal.id);
    scope.principals.set(policy.principal.id, structuredClone(policy.principal.limits));
    for (const principalId of scope.principals.keys()) {
      if (scope.principals.size <= MAX_TRACKED_PRINCIPALS) break;
      if (principalId !== policy.principal.id && scope.controller.idle(principalId)) scope.principals.delete(principalId);
    }
    return scope.controller;
  }

  /** The workspace's controller, registering the policy only when the scope is unknown. */
  controllerFor(policy: DecisionSchedulerPolicy, now: () => number = Date.now): DecisionAdmissionController {
    const scope = this.scopes.get(policy.workspace.id);
    return scope?.principals.has(policy.principal.id) ? scope.controller : this.register(policy, now);
  }

  controller(workspaceId: string): DecisionAdmissionController | undefined {
    return this.scopes.get(workspaceId)?.controller;
  }

  private scopeFor(policy: DecisionSchedulerPolicy, now: () => number): AdmissionScope {
    let scope = this.scopes.get(policy.workspace.id);
    if (!scope) {
      const created: AdmissionScope = { controller: undefined as unknown as DecisionAdmissionController, now,
        profileVersion: policy.profileVersion, workspace: policy.workspace.limits, providers: policy.providers,
        principals: new Map(), revisions: new Map() };
      created.controller = this.controllerOf(created);
      this.scopes.set(policy.workspace.id, created);
      for (const [workspaceId, candidate] of this.scopes) {
        if (this.scopes.size <= this.maxIdleScopes) break;
        if (candidate !== created && candidate.controller.idle()) this.scopes.delete(workspaceId);
      }
      scope = created;
    } else if (scope.now !== now && scope.controller.idle()) {
      // An injected clock is a test seam. Switching clocks restarts idle state;
      // a busy scope keeps its clock so live counters are never discarded.
      scope.now = now;
      scope.controller = this.controllerOf(scope);
    }
    return scope;
  }

  private controllerOf(scope: AdmissionScope): DecisionAdmissionController {
    return new DecisionAdmissionController(request => {
      const principal = scope.principals.get(request.principalId);
      const provider = scope.providers[request.providerId];
      return principal && provider ? { principal, workspace: scope.workspace, provider } : null;
    }, scope.now);
  }

  private remember(map: Map<string, string>, key: string, value: string, maximum: number): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > maximum) map.delete(map.keys().next().value!);
  }
}

/** Process-wide registry used by the evaluator. */
export const decisionAdmissionRegistry = new DecisionAdmissionRegistry();
