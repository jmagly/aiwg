import { createTelemetryContext, type DecisionTelemetryIdSource } from './context.js';
import { sanitizeAttributes, sanitizeOpaqueValue } from './redaction.js';
import type { BatchCostEvidence, DecisionBatchReceipt } from '../batch-receipts/types.js';
import { DECISION_TELEMETRY_SCHEMA_VERSION, type DecisionSpanName, type DecisionTelemetryContext, type DecisionTelemetryLink, type DecisionTelemetrySpan, type DecisionTelemetryTrace, type TelemetryAttributes, type TelemetryProvenance } from './types.js';

export interface StartSpanOptions {
  parent?: DecisionTelemetryContext;
  attributes?: TelemetryAttributes;
  provenance?: Record<string, TelemetryProvenance>;
  links?: DecisionTelemetryLink[];
  startTimeUnixMs?: number;
}

export class DecisionTraceBuilder {
  private readonly spans: DecisionTelemetrySpan[] = [];
  private readonly batchUsage = new Set<string>();
  private root?: DecisionTelemetryContext;

  constructor(private readonly ids?: DecisionTelemetryIdSource, private readonly now: () => number = Date.now) {}

  startSpan(name: DecisionSpanName, options: StartSpanOptions = {}): DecisionTelemetrySpan {
    const parent = options.parent ?? this.root;
    const context = createTelemetryContext(this.ids, parent);
    if (!this.root) this.root = context;
    const attributes = sanitizeAttributes(options.attributes ?? {});
    const span: DecisionTelemetrySpan = {
      schemaVersion: DECISION_TELEMETRY_SCHEMA_VERSION, name, context,
      parentSpanId: parent?.spanId ?? null,
      startTimeUnixMs: options.startTimeUnixMs ?? this.now(), endTimeUnixMs: options.startTimeUnixMs ?? this.now(),
      status: 'unset', attributes,
      provenance: Object.fromEntries(Object.entries(options.provenance ?? {}).filter(([key]) => Object.hasOwn(attributes, key))),
      links: structuredClone(options.links ?? []), events: [],
    };
    this.spans.push(span);
    return span;
  }

  endSpan(span: DecisionTelemetrySpan, status: DecisionTelemetrySpan['status'] = 'ok', endTimeUnixMs = this.now()): void {
    span.endTimeUnixMs = Math.max(span.startTimeUnixMs, endTimeUnixMs);
    span.status = status;
  }

  /** Shared provider usage belongs to exactly one batch request span. */
  recordBatchUsage(
    span: DecisionTelemetrySpan,
    batchId: string,
    usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null },
    provider: { requestId?: string | null; actualModel?: string | null } = {},
    options: { accountingKey?: string; costProvenance?: TelemetryProvenance } = {},
  ): void {
    if (span.name !== 'decision.batch.request') throw new Error('Batch usage can only be recorded on a batch request span');
    const accountingKey = options.accountingKey ?? batchId;
    if (this.batchUsage.has(accountingKey)) throw new Error(`Batch usage already recorded: ${accountingKey}`);
    this.batchUsage.add(accountingKey);
    span.attributes['aiwg.batch.id'] = batchId;
    span.attributes['gen_ai.usage.input_tokens'] = usage.inputTokens;
    span.attributes['gen_ai.usage.output_tokens'] = usage.outputTokens;
    span.attributes['aiwg.usage.cost_usd'] = usage.costUsd;
    span.attributes['aiwg.usage.scope'] = 'shared-request';
    span.attributes['aiwg.provider.request_id'] = provider.requestId === null || provider.requestId === undefined
      ? null : sanitizeOpaqueValue(provider.requestId, 128);
    span.attributes['gen_ai.response.model'] = provider.actualModel === null || provider.actualModel === undefined
      ? null : sanitizeOpaqueValue(provider.actualModel, 128);
    for (const key of ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens']) {
      span.provenance[key] = span.attributes[key] === null ? 'unknown' : 'provider-fact';
    }
    span.provenance['aiwg.usage.cost_usd'] = span.attributes['aiwg.usage.cost_usd'] === null
      ? 'unknown' : (options.costProvenance ?? 'provider-fact');
    span.provenance['aiwg.provider.request_id'] = provider.requestId === null || provider.requestId === undefined ? 'unknown' : 'provider-fact';
    span.provenance['gen_ai.response.model'] = provider.actualModel === null || provider.actualModel === undefined ? 'unknown' : 'provider-fact';
  }

  build(): DecisionTelemetryTrace {
    if (!this.root) throw new Error('Cannot build an empty decision trace');
    return { schemaVersion: DECISION_TELEMETRY_SCHEMA_VERSION, traceId: this.root.traceId, spans: structuredClone(this.spans) };
  }
}

/**
 * Emit transport-attempt spans from the durable accounting authority. Each
 * consumed provider attempt owns its usage exactly once, including failed
 * retry/fallback attempts. Per-answer allocations remain off these spans.
 */
export function recordBatchReceiptTrace(
  builder: DecisionTraceBuilder,
  receipt: DecisionBatchReceipt,
  parent: DecisionTelemetryContext,
): DecisionTelemetrySpan[] {
  const spans: DecisionTelemetrySpan[] = [];
  for (const attempt of receipt.attempts) {
    if (attempt.status === 'not-sent') continue;
    const cost = batchCost(attempt.cost);
    const span = builder.startSpan('decision.batch.request', {
      parent,
      startTimeUnixMs: attempt.dispatchedAtEpochMs ?? receipt.createdAtEpochMs,
      attributes: {
        'aiwg.batch.id': receipt.batchId,
        'aiwg.batch.plan_digest': receipt.plan.planDigest,
        'aiwg.batch.partition_id': receipt.plan.partitionId,
        'aiwg.batch.item_count': receipt.questionIds.length,
        'aiwg.batch.result_count': receipt.answerReferences.length,
        'aiwg.attempt.ordinal': attempt.ordinal,
        'aiwg.adapter.id': attempt.adapterId,
        'aiwg.adapter.version': attempt.adapterVersion,
        'gen_ai.request.model': attempt.requestedModel,
        'aiwg.decision.status': attempt.status,
      },
      provenance: {
        'aiwg.batch.id': 'client-derived', 'aiwg.batch.plan_digest': 'client-derived',
        'aiwg.batch.partition_id': 'client-derived', 'aiwg.batch.item_count': 'client-derived',
        'aiwg.batch.result_count': 'client-derived', 'aiwg.attempt.ordinal': 'client-derived',
        'aiwg.adapter.id': 'client-derived', 'aiwg.adapter.version': 'client-derived',
        'gen_ai.request.model': 'client-derived', 'aiwg.decision.status': 'client-derived',
      },
    });
    builder.recordBatchUsage(span, receipt.batchId, {
      inputTokens: attempt.usage.inputTokens,
      outputTokens: attempt.usage.outputTokens,
      costUsd: cost.amountUsd,
    }, { requestId: attempt.providerRequestId, actualModel: attempt.actualModel }, {
      accountingKey: `${receipt.batchId}:${attempt.ordinal}`,
      costProvenance: cost.provenance,
    });
    builder.endSpan(span, attempt.status === 'succeeded' ? 'ok' : 'error',
      attempt.completedAtEpochMs ?? attempt.dispatchedAtEpochMs ?? receipt.updatedAtEpochMs);
    spans.push(span);
  }
  return spans;
}

function batchCost(cost: BatchCostEvidence): { amountUsd: number | null; provenance: TelemetryProvenance } {
  switch (cost.kind) {
    case 'provider-authoritative': return { amountUsd: cost.amountMicros / 1_000_000, provenance: 'provider-fact' };
    case 'client-derived': return { amountUsd: cost.amountMicros / 1_000_000, provenance: 'client-derived' };
    case 'bounded-unknown':
    case 'unknown': return { amountUsd: null, provenance: 'unknown' };
  }
}

export function estimatedUsageAllocation(total: number, weights: readonly number[], method: string, version: string): Array<{ value: number; provenance: 'estimate'; method: string; version: string }> {
  if (!Number.isSafeInteger(total) || total < 0 || weights.length === 0 || weights.some(weight => !Number.isFinite(weight) || weight < 0)) throw new Error('Invalid usage allocation input');
  const sum = weights.reduce((left, right) => left + right, 0);
  if (sum <= 0 || !method || !version) throw new Error('Usage allocation requires positive weights and versioned method');
  const raw = weights.map(weight => total * weight / sum);
  const values = raw.map(Math.floor);
  let remainder = total - values.reduce((left, right) => left + right, 0);
  const order = raw.map((value, index) => ({ index, fraction: value - values[index]! }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < remainder; index += 1) values[order[index]!.index]! += 1;
  remainder = total - values.reduce((left, right) => left + right, 0);
  if (remainder !== 0) throw new Error('Usage allocation did not reconcile');
  return values.map(value => ({ value, provenance: 'estimate', method, version }));
}
