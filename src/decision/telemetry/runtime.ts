import type { DecisionAdapterBatchObservation, DecisionAttempt, DecisionEvaluationRequest, DecisionResult, ExecutionTarget, RulesetResult } from '../types.js';
import type { DecisionBatchReceipt } from '../batch-receipts/types.js';
import { extractTraceContext, transportTraceContext } from './context.js';
import { mapDecisionAttempt, mapDecisionResult, mapRulesetResult, type AttributeMapping } from './mapping.js';
import { DecisionTraceBuilder, recordBatchReceiptTrace } from './trace.js';
import { recordDecisionSpanMetrics } from './metrics.js';
import { sanitizeAttributes } from './redaction.js';
import type { DecisionTelemetryLink, DecisionTelemetrySpan, TelemetryAttributes } from './types.js';

type RuntimeTelemetry = NonNullable<DecisionEvaluationRequest['telemetry']>;

/** One live span plus the only context an adapter may forward to its transport. */
export interface DecisionRuntimeSpan {
  readonly span: DecisionTelemetrySpan;
  readonly traceContext: { traceparent: string };
  readonly ordinal: number;
  response?: DecisionAdapterBatchObservation;
}

// Keyed by the per-invocation telemetry object, which request snapshots copy by reference.
const TRACES = new WeakMap<RuntimeTelemetry, DecisionRuntimeTrace>();
const USAGE_KEYS = ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'aiwg.usage.cost_usd',
  'aiwg.usage.cost_provenance', 'aiwg.provider.request_id', 'aiwg.provider.request_id_source'];

/**
 * Records metadata-only spans while one evaluator invocation runs. Spans carry
 * live start/end times, are buffered in start order and flushed once after the
 * terminal result. Every failure disables the trace; none reaches the decision.
 */
export class DecisionRuntimeTrace {
  private readonly builder: DecisionTraceBuilder;
  private readonly root: DecisionTelemetrySpan;
  private validate?: DecisionTelemetrySpan;
  private readonly batchSpans = new Map<string, DecisionTelemetrySpan[]>();
  private disabled = false;

  private constructor(private readonly telemetry: RuntimeTelemetry, private readonly now: () => number) {
    this.builder = new DecisionTraceBuilder(telemetry.ids, now);
    this.root = this.builder.startSpan('decision.workflow', telemetry.parent ? { parent: telemetry.parent } : {});
  }

  /** Start the root span and bind the trace to a request copy. Invalid ID sources disable telemetry. */
  static begin(request: DecisionEvaluationRequest): { request: DecisionEvaluationRequest; trace: DecisionRuntimeTrace | null } {
    if (!request.telemetry) return { request, trace: null };
    try {
      const telemetry = { ...request.telemetry };
      const trace = new DecisionRuntimeTrace(telemetry, request.now ?? Date.now);
      TRACES.set(telemetry, trace);
      return { request: { ...request, telemetry }, trace };
    } catch {
      return { request, trace: null };
    }
  }

  /** W3C traceparent of the workflow span, for durable receipts created by this invocation. */
  get traceParent(): string | undefined {
    return this.disabled ? undefined : transportTraceContext(this.root.context).traceparent;
  }

  validated(rejected: boolean): void {
    this.guard(() => {
      if (this.validate) return;
      const outcome = rejected ? 'rejected' : 'accepted';
      this.validate = this.builder.startSpan('decision.validate', { parent: this.root.context,
        startTimeUnixMs: this.root.startTimeUnixMs,
        attributes: { 'aiwg.validation.outcome': outcome }, provenance: { 'aiwg.validation.outcome': 'client-derived' } });
      this.builder.endSpan(this.validate, rejected ? 'error' : 'ok');
    });
  }

  startAttempt(alias: string, target: ExecutionTarget, ordinal: number, fallback = false): DecisionRuntimeSpan | undefined {
    return this.guard(() => {
      // Known before dispatch, so an attempt whose outcome is never observed still names its route.
      const attributes = { 'aiwg.decision.alias': alias, 'aiwg.adapter.id': target.adapter,
        'aiwg.adapter.version': target.adapterVersion, 'gen_ai.request.model': target.model,
        'aiwg.attempt.ordinal': ordinal, 'aiwg.route.fallback': fallback };
      return this.open(this.builder.startSpan('decision.attempt', { parent: this.root.context, attributes,
        provenance: Object.fromEntries(Object.keys(attributes).map(key => [key, 'client-derived' as const])) }), ordinal);
    });
  }

  endAttempt(handle: DecisionRuntimeSpan | undefined, attempt: DecisionAttempt): void {
    this.guard(() => {
      if (!handle) return;
      const mapped = mapDecisionAttempt(attempt);
      this.builder.annotate(handle.span, mapped.attributes, mapped.provenance);
      if (attempt.termination) handle.span.events.push({ name: 'attempt.terminated', timeUnixMs: this.now(),
        attributes: { 'aiwg.attempt.termination': attempt.termination } });
      this.builder.endSpan(handle.span, attempt.status === 'success' ? 'ok' : 'error');
    });
  }

  retryScheduled(handle: DecisionRuntimeSpan | undefined, delayMs: number): void {
    this.guard(() => {
      if (!handle) return;
      this.builder.annotate(handle.span, { 'aiwg.retry.delay_ms': delayMs }, { 'aiwg.retry.delay_ms': 'client-derived' });
      handle.span.events.push({ name: 'retry.scheduled', timeUnixMs: this.now(), attributes: { 'aiwg.retry.delay_ms': delayMs } });
    });
  }

  /** Open the shared request span before dispatch; its context is what the transport receives. */
  startBatch(aliases: readonly string[], groupId: string, ordinal: number): DecisionRuntimeSpan | undefined {
    return this.guard(() => {
      const span = this.builder.startSpan('decision.batch.request', { parent: this.root.context,
        attributes: { 'aiwg.batch.id': groupId, 'aiwg.batch.mode': 'native', 'aiwg.batch.item_count': aliases.length,
          'aiwg.attempt.ordinal': ordinal },
        provenance: { 'aiwg.batch.id': 'client-derived', 'aiwg.batch.mode': 'client-derived',
          'aiwg.batch.item_count': 'client-derived', 'aiwg.attempt.ordinal': 'client-derived' } });
      for (const alias of aliases) this.batchSpans.set(alias, [...this.batchSpans.get(alias) ?? [], span]);
      return this.open(span, ordinal);
    });
  }

  /**
   * Close one batch plan. A durable receipt is the accounting authority and is
   * bridged through `recordBatchReceiptTrace`; without one, shared usage comes
   * from the single transport response. A replayed receipt dispatched nothing
   * here, so it only links back to the trace that created it.
   */
  finishBatch(handles: readonly DecisionRuntimeSpan[], receipt: DecisionBatchReceipt | undefined): void {
    this.guard(() => {
      if (receipt && handles.length === 0) {
        this.linkOrigin(receipt.traceParent, 'batch', { 'aiwg.batch.id': receipt.batchId });
        return;
      }
      if (receipt) {
        recordBatchReceiptTrace(this.builder, receipt, this.root.context,
          new Map(handles.map(handle => [handle.ordinal, handle.span])));
        return;
      }
      for (const handle of handles) {
        if (!handle.response || handle.span.status !== 'unset') continue;
        const answers = handle.response.answers.map(answer => answer.observation);
        const requestIds = [...new Set(answers.map(answer => answer.requestId).filter((id): id is string => id !== null))];
        const models = [...new Set(answers.map(answer => answer.actualModel).filter((model): model is string => model !== null))];
        this.builder.recordBatchUsage(handle.span, String(handle.span.attributes['aiwg.batch.id']), handle.response.sharedUsage,
          { requestId: requestIds.length === 1 ? requestIds[0] : null, actualModel: models.length === 1 ? models[0] : null },
          { accountingKey: handle.span.context.spanId });
        this.builder.endSpan(handle.span, answers.every(answer => answer.status === 'success') ? 'ok' : 'error');
      }
    });
  }

  /** Link the workflow to the trace that created a durable receipt this invocation is replaying. */
  linkOrigin(traceParent: string | undefined, relationship: DecisionTelemetryLink['relationship'], attributes: TelemetryAttributes): void {
    this.guard(() => {
      const origin = traceParent ? extractTraceContext({ traceparent: traceParent }) : null;
      if (!origin || (origin.traceId === this.root.context.traceId && origin.spanId === this.root.context.spanId)
        || this.root.links.some(link => link.traceId === origin.traceId && link.spanId === origin.spanId)) return;
      this.root.links.push({ traceId: origin.traceId, spanId: origin.spanId, relationship,
        ...(Object.keys(attributes).length ? { attributes: sanitizeAttributes(attributes) } : {}) });
    });
  }

  /** Record normalize/accept for one finished evaluation, linked to any shared batch request. */
  decided(result: DecisionResult): void {
    this.guard(() => {
      const batches = this.batchSpans.get(result.spec.alias) ?? [];
      const links = batches.map((span): DecisionTelemetryLink => ({ traceId: span.context.traceId, spanId: span.context.spanId,
        relationship: 'batch' }));
      result.spec.attempts.forEach((attempt, index) => {
        const request = batches[index];
        // Native answers without a request span from this invocation are replayed evidence, not new work.
        if (attempt.batch?.mode !== 'native' || !request) return;
        const mapped = withoutUsage(mapDecisionAttempt(attempt));
        const span = this.builder.startSpan('decision.attempt', { parent: this.root.context,
          startTimeUnixMs: request.startTimeUnixMs, links: [links[index]!],
          attributes: { ...mapped.attributes, 'aiwg.decision.alias': result.spec.alias, 'aiwg.usage.scope': 'batch-answer' },
          provenance: { ...mapped.provenance, 'aiwg.decision.alias': 'client-derived', 'aiwg.usage.scope': 'client-derived' } });
        this.builder.endSpan(span, attempt.status === 'success' ? 'ok' : 'error', request.endTimeUnixMs);
      });
      const mapped = mapDecisionResult(result);
      const normalize = this.builder.startSpan('decision.normalize', { parent: this.root.context, links,
        attributes: mapped.attributes, provenance: mapped.provenance });
      this.builder.endSpan(normalize, result.spec.reason === 'invalid-output' ? 'error' : 'ok');
      const accept = this.builder.startSpan('decision.accept', { parent: this.root.context, links,
        attributes: mapped.attributes, provenance: mapped.provenance });
      this.builder.endSpan(accept, result.spec.status === 'error' || result.spec.status === 'cancelled' ? 'error' : 'ok');
    });
  }

  /** Close the workflow and flush. Exporter and metric failures are isolated per span. */
  async finish(result: RulesetResult): Promise<void> {
    if (this.disabled) return;
    let spans: DecisionTelemetrySpan[];
    try {
      const failed = result.spec.status === 'error' || result.spec.status === 'cancelled';
      const mapped = mapRulesetResult(result);
      this.builder.annotate(this.root, mapped.attributes, mapped.provenance);
      if (result.spec.cache?.disposition === 'cache-hit') {
        // Historical attempts are evidence, not attempts by this caller. Emitting
        // their provider usage again would double-count tokens and fabricate work.
        this.builder.annotate(this.root, { 'aiwg.invocation.id': result.spec.cache.callerInvocationId,
          'aiwg.cache.layer': 'result', 'aiwg.cache.result': 'hit' }, { 'aiwg.invocation.id': 'client-derived',
          'aiwg.cache.layer': 'client-derived', 'aiwg.cache.result': 'client-derived' });
        const hit = this.builder.startSpan('decision.cache', { parent: this.root.context,
          attributes: { 'aiwg.cache.layer': 'result', 'aiwg.cache.result': 'hit' },
          provenance: { 'aiwg.cache.layer': 'client-derived', 'aiwg.cache.result': 'client-derived' } });
        this.builder.endSpan(hit, 'ok');
      } else {
        this.validated(result.spec.reason === 'invalid-input' || result.spec.reason === 'invalid-definition');
        // A span still open here never observed its outcome, e.g. an uncertain remote dispatch.
        for (const span of this.builder.openSpans()) {
          if (span === this.root) continue;
          this.builder.annotate(span, { 'aiwg.decision.reason': result.spec.reason }, { 'aiwg.decision.reason': 'client-derived' });
          this.builder.endSpan(span, 'error');
        }
        const compose = this.builder.startSpan('decision.compose', { parent: this.root.context,
          attributes: mapped.attributes, provenance: mapped.provenance });
        this.builder.endSpan(compose, failed ? 'error' : 'ok');
        if (result.spec.status === 'review') {
          const review = this.builder.startSpan('decision.review', { parent: this.root.context,
            attributes: { 'aiwg.decision.reason': result.spec.reason }, provenance: { 'aiwg.decision.reason': 'client-derived' } });
          this.builder.endSpan(review, 'ok');
        }
        const persist = this.builder.startSpan('decision.persist', { parent: this.root.context,
          attributes: { 'aiwg.persistence.result': result.spec.reason === 'persistence-error' ? 'failed' : 'persisted' },
          provenance: { 'aiwg.persistence.result': 'client-derived' } });
        this.builder.endSpan(persist, result.spec.reason === 'persistence-error' ? 'error' : 'ok');
      }
      this.builder.endSpan(this.root, failed ? 'error' : 'ok');
      spans = this.builder.build().spans;
    } catch {
      // Observability must never alter, reject, or mask the authoritative result.
      return;
    } finally {
      this.disabled = true;
    }
    if (this.telemetry.metrics) for (const span of spans) {
      try { recordDecisionSpanMetrics(span, this.telemetry.metrics); } catch { /* metrics cannot change a decision */ }
    }
    for (const span of spans) {
      try { await this.telemetry.hook.emit(span); } catch { /* isolate individual exporter failures */ }
    }
  }

  private open(span: DecisionTelemetrySpan, ordinal: number): DecisionRuntimeSpan {
    return { span, ordinal, traceContext: transportTraceContext(span.context) };
  }

  private guard<T>(record: () => T): T | undefined {
    if (this.disabled) return undefined;
    try { return record(); } catch { this.disabled = true; return undefined; }
  }
}

/** The live trace bound to this evaluator request, if telemetry is configured and healthy. */
export function runtimeTraceOf(request: DecisionEvaluationRequest): DecisionRuntimeTrace | null {
  return request.telemetry ? TRACES.get(request.telemetry) ?? null : null;
}

function withoutUsage(mapping: AttributeMapping): AttributeMapping {
  const attributes = { ...mapping.attributes };
  const provenance = { ...mapping.provenance };
  for (const key of USAGE_KEYS) { delete attributes[key]; delete provenance[key]; }
  return { attributes, provenance };
}
