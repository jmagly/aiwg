import { describe, expect, it, vi } from 'vitest';
import { DecisionResultCache, MemoryResultCacheStore, RESULT_CACHE_KEY_VERSION } from '../../../src/decision/result-cache/index.js';
import type { CachedResultEvidence, ResultCacheActor, ResultCacheEvent, ResultCachePolicy, ResultCacheSemanticIdentity } from '../../../src/decision/result-cache/index.js';
import { BoundedDecisionMetrics, recordDecisionSpanMetrics, recordResultCacheMetrics, resultCacheMetricsSink } from '../../../src/decision/telemetry/metrics.js';
import type { DecisionTelemetrySpan } from '../../../src/decision/telemetry/types.js';

const pin = (id: string) => ({ id, version: '1', digest: `sha256:${id.repeat(64)}` as const });
const actor: ResultCacheActor = { tenantId: 'tenant', projectId: 'project', workspaceId: 'workspace', subjectId: 'caller', permissions: ['read', 'write', 'invalidate', 'export', 'delete'] };
const policy: ResultCachePolicy = { enabled: true, sideEffectFree: true, policyVersion: 'policy-1', ttlMs: 100, scope: 'workspace', sensitivity: 'internal' };
const identity: ResultCacheSemanticIdentity = { keyVersion: RESULT_CACHE_KEY_VERSION, definition: pin('a'), ruleset: pin('b'), binding: pin('c'), adapter: { id: 'adapter', version: '1' }, promptDigest: pin('d').digest, acceptancePolicyDigest: pin('e').digest, calibrationDigest: pin('f').digest, runtimePolicyDigest: pin('4').digest, backend: 'test', requestedModel: 'model', modelCompatibility: { mode: 'pinned', actualModel: 'model' }, primitive: 'choice', projectedInput: { text: 'private subject' }, subjectIdentityDigest: pin('1').digest, projectionPolicyDigest: pin('2').digest, egressPolicyDigest: pin('3').digest, capabilityMode: 'json' };
const evidence = (usage: CachedResultEvidence['usage'] = { inputTokens: 5, outputTokens: 1, costUsd: null }): CachedResultEvidence => ({ result: { answer: 'yes' }, resultDigest: pin('0').digest, sourceInvocationId: 'original', sourceReceiptId: 'receipt', evaluatedAtEpochMs: 10, actualModel: 'model', uncertainty: null, calibrationStatus: 'pinned', durationMs: 40, usage, status: 'success', failureReason: 'none' });
const request = (nowEpochMs: number, callerInvocationId: string, overrides: Partial<ResultCachePolicy> = {}) => ({ actor, policy: { ...policy, ...overrides }, identity, nowEpochMs, callerInvocationId, operationId: `op-${callerInvocationId}` });
const counts = (metrics: BoundedDecisionMetrics) => metrics.snapshot().filter(point => point.name === 'decision.cache')
  .map(point => point.dimensions['aiwg.cache.result']);

describe('D15 result-cache events in the D14 metric pipeline', () => {
  it('exports every result-cache event, including bypass and single-flight, as a bounded dimension', () => {
    const metrics = new BoundedDecisionMetrics();
    const events: ResultCacheEvent[] = ['hit', 'miss', 'bypass', 'stale', 'invalidation', 'single-flight'];
    for (const event of events) recordResultCacheMetrics({ event, operationId: 'op', reason: 'free-form reason' }, metrics);
    expect(counts(metrics)).toEqual(events);
    for (const point of metrics.snapshot()) {
      // Operation IDs and reasons are free-form correlation, never metric labels.
      expect(point.dimensions).toEqual({ 'aiwg.cache.layer': 'result', 'aiwg.cache.result': point.dimensions['aiwg.cache.result'] });
    }
    expect(metrics.record('decision.cache', 1, { 'aiwg.cache.result': 'sha256:secret-key' })).toBe(true);
    expect(metrics.snapshot().at(-1)!.dimensions).toEqual({});
  });

  it('feeds a live cache service through the sink and records savings once per reused caller as estimates', async () => {
    const metrics = new BoundedDecisionMetrics();
    const forwarded: string[] = [];
    const cache = new DecisionResultCache(new MemoryResultCacheStore(), resultCacheMetricsSink(metrics, event => forwarded.push(event.event)));
    const fill = vi.fn(async () => evidence());
    await cache.evaluate(request(100, 'cold'), fill);
    await cache.evaluate(request(120, 'warm'), fill);
    await cache.evaluate(request(130, 'disabled', { enabled: false }), fill);
    await cache.evaluate(request(250, 'expired'), fill);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow = vi.fn(async () => { await gate; return evidence(); });
    const joined = [cache.evaluate({ ...request(400, 'a'), identity: { ...identity, projectedInput: { text: 'other' } } }, slow),
      cache.evaluate({ ...request(400, 'b'), identity: { ...identity, projectedInput: { text: 'other' } } }, slow)];
    release(); await Promise.all(joined);
    expect(counts(metrics)).toEqual(forwarded);
    expect(counts(metrics)).toEqual(['miss', 'hit', 'bypass', 'stale', 'invalidation', 'miss', 'miss', 'single-flight', 'hit']);
    const saved = metrics.snapshot().filter(point => point.name.startsWith('decision.cache_saved_'));
    // Two reused callers (warm hit, single-flight joiner). Cost was unknown: skipped, never zero.
    expect(saved.map(point => point.name).sort()).toEqual([
      'decision.cache_saved_input_tokens', 'decision.cache_saved_input_tokens',
      'decision.cache_saved_latency_ms', 'decision.cache_saved_latency_ms',
      'decision.cache_saved_output_tokens', 'decision.cache_saved_output_tokens']);
    expect(saved.every(point => point.dimensions['aiwg.usage.cost_provenance'] === 'estimate')).toBe(true);
    expect(saved.filter(point => point.name === 'decision.cache_saved_input_tokens').map(point => point.value)).toEqual([5, 5]);
    // Savings never become new provider usage.
    expect(metrics.snapshot().some(point => point.name === 'decision.input_tokens' || point.name === 'decision.cost_usd')).toBe(false);
  });

  it('keeps an exploding metrics pipeline or sink outside cache semantics', async () => {
    const broken = { record: () => { throw new Error('metrics down'); } } as unknown as BoundedDecisionMetrics;
    const cache = new DecisionResultCache(new MemoryResultCacheStore(), resultCacheMetricsSink(broken));
    expect((await cache.evaluate(request(100, 'a'), async () => evidence())).receipt.disposition).toBe('cache-miss-fill');
    const throwing = new DecisionResultCache(new MemoryResultCacheStore(), () => { throw new Error('sink down'); });
    await throwing.evaluate(request(100, 'a'), async () => evidence());
    expect((await throwing.evaluate(request(110, 'b'), async () => evidence())).receipt.disposition).toBe('cache-hit');
  });

  it('does not double count a result-layer hit from its trace span', () => {
    const metrics = new BoundedDecisionMetrics();
    const span = (layer: string): DecisionTelemetrySpan => ({ schemaVersion: 'decision-telemetry/v1', name: 'decision.cache',
      context: { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: '01' }, parentSpanId: null,
      startTimeUnixMs: 1, endTimeUnixMs: 2, status: 'ok', attributes: { 'aiwg.cache.layer': layer, 'aiwg.cache.result': 'hit' },
      provenance: {}, links: [], events: [] });
    recordDecisionSpanMetrics(span('result'), metrics);
    expect(metrics.snapshot()).toEqual([]);
    recordDecisionSpanMetrics(span('provider-prefix'), metrics);
    expect(counts(metrics)).toEqual(['hit']);
    expect(metrics.snapshot()[0]!.dimensions['aiwg.cache.layer']).toBe('provider-prefix');
  });
});
