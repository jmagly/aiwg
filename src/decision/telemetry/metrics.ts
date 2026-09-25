import type { ResultCacheTelemetry } from '../result-cache/types.js';
import type { DecisionTelemetrySpan, TelemetryAttributes } from './types.js';

// Free-form adapter/model/version strings require an explicit deployment allowlist.
// Merely bounding their length does not prevent a short user ID or body canary
// from becoming a metric label.
const DYNAMIC_DIMENSIONS = new Set(['aiwg.adapter.id', 'aiwg.adapter.version', 'gen_ai.request.model', 'gen_ai.response.model']);
const FIXED_DIMENSIONS: Record<string, readonly string[]> = {
  'aiwg.decision.status': ['success', 'abstained', 'error', 'unsupported', 'cancelled', 'completed', 'review', 'failed', 'succeeded', 'not-sent'],
  'aiwg.decision.reason': ['none', 'invalid-input', 'invalid-definition', 'digest-mismatch', 'unauthorized',
    'data-boundary-denied', 'unsupported-capability', 'executor-unavailable', 'invalid-output', 'low-confidence',
    'missing-confidence', 'confidence-profile-mismatch', 'insufficient-information', 'timeout', 'network-transient',
    'rate-limited', 'overloaded', 'service-error', 'authentication', 'invalid-request', 'budget-exhausted',
    'cancelled', 'persistence-error', 'replay-mismatch', 'execution-uncertain', 'batch-record-unavailable', 'no-match', 'conflicting-outcomes', 'evaluation-failed',
    'context-plan-stale', 'context-unqualified'],
  'aiwg.acceptance.disposition': ['act', 'review', 'reject', 'fallback'],
  'aiwg.batch.mode': ['native', 'single', 'emulated'],
  // Compile-layer (D30) and result-layer (D15) cache layers share one bounded vocabulary.
  'aiwg.cache.layer': ['definition-compilation', 'adapter-compilation', 'provider-prefix', 'invocation-replay',
    'semantic-result', 'result'],
  // Provider-prefix statuses, compile-cache outcomes, and every D15 result-cache event.
  'aiwg.cache.result': ['hit', 'miss', 'stale', 'unknown', 'bypass', 'rejected', 'unsupported', 'single-flight', 'invalidation'],
  'aiwg.cache.reason': ['verified-hit', 'cold-fill', 'cache-disabled', 'store-rejected', 'provider-report',
    'documented-unsupported', 'policy-bypass', 'unreported'],
  'aiwg.review.status': ['pending', 'approved', 'denied', 'escalated', 'expired'],
  'aiwg.usage.cost_provenance': ['provider-fact', 'client-derived', 'estimate', 'unknown'],
  'aiwg.admission.decision': ['admit', 'defer', 'reject'],
  'aiwg.admission.reason': ['admitted', 'disabled', 'cancelled', 'deadline-exceeded', 'concurrency', 'requests-per-minute',
    'tokens-per-second', 'attempts', 'batch-size', 'cost', 'unknown-cost', 'queue-full', 'queue-timeout', 'invalid-estimate',
    'request-too-large', 'too-many-items', 'retained-work', 'unknown-retained-work', 'retry-after', 'circuit-open',
    'unconfigured-provider'],
  'aiwg.breaker.status': ['closed', 'open', 'half-open'],
};

export interface DecisionMetricPoint { name: string; value: number; dimensions: TelemetryAttributes }

/** Only fixed metric names are accepted; caller-controlled names would defeat cardinality limits. */
const METRIC_NAMES = new Set([
  'decision.throughput', 'decision.duration', 'decision.attempts', 'decision.retries',
  'decision.fallbacks', 'decision.errors', 'decision.queue_delay', 'decision.coverage',
  'decision.abstention', 'decision.review', 'decision.cost_usd',
  'decision.input_tokens', 'decision.output_tokens', 'decision.cache', 'decision.drift',
  'decision.cache_saved_input_tokens', 'decision.cache_saved_output_tokens',
  'decision.cache_saved_latency_ms', 'decision.cache_saved_cost_usd',
  'decision.admission', 'decision.throttles', 'decision.breaker_transitions',
]);

/** Record operational metrics without using result IDs or answer-level batch usage. */
export function recordDecisionSpanMetrics(span: DecisionTelemetrySpan, metrics: BoundedDecisionMetrics): void {
  const attributes = span.attributes;
  const record = (name: string, value: number): void => { metrics.record(name, value, attributes); };
  if (span.name === 'decision.workflow') {
    record('decision.throughput', 1);
    record('decision.duration', Math.max(0, span.endTimeUnixMs - span.startTimeUnixMs));
    if (span.status === 'error') record('decision.errors', 1);
  }
  if (span.name === 'decision.attempt' || span.name === 'decision.batch.request') {
    record('decision.attempts', 1);
    if (typeof attributes['aiwg.retry.delay_ms'] === 'number') record('decision.retries', 1);
    if (attributes['aiwg.route.fallback'] === true) record('decision.fallbacks', 1);
    if (span.status === 'error') record('decision.errors', 1);
    // Batch usage belongs to the request span only. Never sum linked answer spans.
    const accounted = span.name === 'decision.batch.request'
      ? attributes['aiwg.usage.scope'] === 'shared-request'
      : attributes['aiwg.batch.id'] === undefined;
    if (accounted) for (const [key, name] of [
      ['gen_ai.usage.input_tokens', 'decision.input_tokens'],
      ['gen_ai.usage.output_tokens', 'decision.output_tokens'],
      ['aiwg.usage.cost_usd', 'decision.cost_usd'],
    ] as const) {
      const value = attributes[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) record(name, value);
    }
  }
  if (span.name === 'decision.review') record('decision.review', 1);
  // Result-layer cache events are counted once, from the D15 service sink below.
  if (span.name === 'decision.cache' && attributes['aiwg.cache.layer'] !== 'result') record('decision.cache', 1);
  if (span.name === 'decision.admit') {
    record('decision.admission', 1);
    if (attributes['aiwg.admission.decision'] !== 'admit') record('decision.throttles', 1);
    const delay = attributes['aiwg.queue.delay_ms'];
    if (typeof delay === 'number' && Number.isFinite(delay) && delay >= 0) record('decision.queue_delay', delay);
    for (const event of span.events) if (event.name === 'breaker.transition') record('decision.breaker_transitions', 1);
  }
  if (span.name === 'decision.accept') {
    const disposition = attributes['aiwg.acceptance.disposition'];
    if (disposition === 'act') record('decision.coverage', 1);
    if (disposition === 'reject') record('decision.abstention', 1);
  }
  const drift = attributes['aiwg.drift.value'];
  if (typeof drift === 'number' && Number.isFinite(drift) && drift >= 0) record('decision.drift', drift);
}

/**
 * Feed one D15 result-cache event into the D14 metric pipeline. Only the event name
 * becomes a dimension; the operation ID and reason never do. Savings are recorded for
 * hits only, labelled as estimates, and null usage or cost is skipped, never zeroed.
 */
export function recordResultCacheMetrics(event: ResultCacheTelemetry, metrics: BoundedDecisionMetrics): void {
  const dimensions = { 'aiwg.cache.layer': 'result', 'aiwg.cache.result': event.event };
  metrics.record('decision.cache', 1, dimensions);
  if (event.event !== 'hit' || !event.saved) return;
  const estimated = { ...dimensions, 'aiwg.usage.cost_provenance': 'estimate' };
  for (const [value, name] of [
    [event.saved.inputTokens, 'decision.cache_saved_input_tokens'],
    [event.saved.outputTokens, 'decision.cache_saved_output_tokens'],
    [event.saved.latencyMs, 'decision.cache_saved_latency_ms'],
    [event.saved.costUsd, 'decision.cache_saved_cost_usd'],
  ] as const) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) metrics.record(name, value, estimated);
  }
}

/** A `DecisionResultCache` telemetry sink that records metrics and then forwards the event. */
export function resultCacheMetricsSink(metrics: BoundedDecisionMetrics,
  next?: (event: ResultCacheTelemetry) => void): (event: ResultCacheTelemetry) => void {
  return event => {
    try { recordResultCacheMetrics(event, metrics); } catch { /* metrics cannot change a decision */ }
    next?.(event);
  };
}

export class BoundedDecisionMetrics {
  private readonly points: DecisionMetricPoint[] = [];
  private readonly approvedDimensions: Readonly<Record<string, readonly string[]>>;
  constructor(private readonly capacity = 1_000, private readonly maximumDimensionValues = 100,
    trustedDimensionValues: Readonly<Record<string, readonly string[]>> = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(maximumDimensionValues) || maximumDimensionValues < 1
      || Object.entries(trustedDimensionValues).some(([key, values]) => !DYNAMIC_DIMENSIONS.has(key)
        || !Array.isArray(values) || values.length > capacity
        || values.some(value => typeof value !== 'string' || value.length < 1 || value.length > 64))) {
      throw new Error('Invalid metric bounds');
    }
    this.approvedDimensions = Object.fromEntries(Object.entries(trustedDimensionValues)
      .map(([key, values]) => [key, [...values]]));
  }

  record(name: string, value: number, attributes: TelemetryAttributes): boolean {
    if (!METRIC_NAMES.has(name) || !Number.isFinite(value) || this.points.length >= this.capacity) return false;
    const dimensions = Object.fromEntries(Object.entries(attributes).filter(([key, dimension]) => typeof dimension === 'string'
      && (FIXED_DIMENSIONS[key]?.includes(dimension) === true
        || DYNAMIC_DIMENSIONS.has(key) && this.approvedDimensions[key]?.includes(dimension) === true)));
    const signature = JSON.stringify(dimensions);
    const distinct = new Set(this.points.filter(point => point.name === name).map(point => JSON.stringify(point.dimensions)));
    if (!distinct.has(signature) && distinct.size >= this.maximumDimensionValues) return false;
    this.points.push({ name, value, dimensions });
    return true;
  }

  snapshot(): DecisionMetricPoint[] { return structuredClone(this.points); }
}
