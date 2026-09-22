import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  BoundedDecisionMetrics,
  BoundedDecisionTraceExporter,
  createTelemetryContext,
  DecisionTraceBuilder,
  deleteTelemetryReference,
  estimatedUsageAllocation,
  extractTraceContext,
  injectTraceContext,
  mapDecisionAttempt,
  recordBatchReceiptTrace,
  restoreTelemetryTrace,
  sanitizedTelemetryExport,
  scanTelemetryCanaries,
  validateDebugCapturePolicy,
  type DecisionTelemetryIdSource,
  type DecisionTelemetryTrace,
} from '../../../src/decision/telemetry/index.js';
import type { DecisionAttempt } from '../../../src/decision/types.js';
import type { DecisionBatchReceipt } from '../../../src/decision/batch-receipts/index.js';

function deterministicIds(): DecisionTelemetryIdSource {
  let value = 1;
  return {
    traceId: () => '1'.repeat(32),
    spanId: () => (value++).toString(16).padStart(16, '0'),
  };
}

function trace(): DecisionTelemetryTrace {
  const builder = new DecisionTraceBuilder(deterministicIds(), () => 100);
  const root = builder.startSpan('decision.workflow', { attributes: { 'aiwg.run.id': 'run-1' }, provenance: { 'aiwg.run.id': 'client-derived' } });
  builder.endSpan(root, 'ok', 110);
  return builder.build();
}

describe('decision telemetry foundation', () => {
  it('propagates W3C context without using provider request identities', () => {
    const root = createTelemetryContext(deterministicIds());
    const headers = injectTraceContext(root);
    expect(extractTraceContext(headers)).toEqual(root);
    expect(extractTraceContext({ traceparent: '00-provider-request-0000000000000001-01' })).toBeNull();
  });

  it('maps attempts with explicit fact/derived/unknown provenance', () => {
    const attempt: DecisionAttempt = {
      ordinal: 1, adapter: 'jev', adapterVersion: '1.2.3', requestedModel: 'alias', actualModel: null,
      subagent: null, status: 'success', reason: 'none', durationMs: 20,
      usage: { inputTokens: 10, outputTokens: null, costUsd: null }, requestId: 'req\n42', requestIdSource: 'typesafe',
    };
    const mapped = mapDecisionAttempt(attempt);
    expect(mapped.attributes['aiwg.provider.request_id']).toBe('req42');
    expect(String(mapDecisionAttempt({ ...attempt, requestId: `request-${'x'.repeat(500)}` }).attributes['aiwg.provider.request_id']).length).toBe(128);
    expect(mapped.provenance['gen_ai.response.model']).toBe('unknown');
    expect(mapped.attributes['gen_ai.usage.output_tokens']).toBeNull();
    expect(mapped.attributes['aiwg.usage.cost_provenance']).toBe('unknown');
  });

  it('records shared batch usage once and reconciles estimated allocations', () => {
    const builder = new DecisionTraceBuilder(deterministicIds(), () => 100);
    const root = builder.startSpan('decision.workflow');
    const batch = builder.startSpan('decision.batch.request', { parent: root.context });
    builder.recordBatchUsage(batch, 'batch-safe', { inputTokens: 7, outputTokens: 5, costUsd: null });
    expect(() => builder.recordBatchUsage(batch, 'batch-safe', { inputTokens: 7, outputTokens: 5, costUsd: null })).toThrow(/already recorded/);
    const allocations = estimatedUsageAllocation(7, [1, 1, 1], 'largest-remainder', 'v1');
    expect(allocations.reduce((sum, item) => sum + item.value, 0)).toBe(7);
    expect(new Set(allocations.map(item => item.provenance))).toEqual(new Set(['estimate']));
  });

  it('maps durable retry receipts to one authoritative usage record per consumed attempt', () => {
    const builder = new DecisionTraceBuilder(deterministicIds(), () => 100);
    const root = builder.startSpan('decision.workflow');
    const receipt: DecisionBatchReceipt = {
      schemaVersion: 'decision-batch-receipt/v1', revision: 3, tenantId: 'tenant', projectId: 'project',
      batchId: 'batch-1', invocationId: 'invocation-1', runId: 'run-1',
      plan: { planDigest: `sha256:${'a'.repeat(64)}`, partitionId: 'partition-1', nativeBatchGroupId: 'group-1' },
      subjectHash: `sha256:${'b'.repeat(64)}`, stateHash: `sha256:${'c'.repeat(64)}`, executionEnvelope: 'jev/v1',
      questionIds: ['q-1', 'q-2'], answerReferences: [
        { questionId: 'q-1', answerId: 'a-1', resultId: 'r-1' },
        { questionId: 'q-2', answerId: 'a-2', resultId: 'r-2' },
      ], allocations: [], status: 'completed', createdAtEpochMs: 10, updatedAtEpochMs: 40, terminalAtEpochMs: 40,
      attempts: [
        { ordinal: 1, adapterId: 'jev', adapterVersion: '1', requestedModel: 'alias', actualModel: null,
          providerRequestId: 'failed-request', status: 'failed', dispatchedAtEpochMs: 10, completedAtEpochMs: 20,
          usage: { inputTokens: 5, outputTokens: 1 }, cost: { kind: 'client-derived', currency: 'USD', amountMicros: 42,
            priceCatalogId: 'catalog', priceCatalogVersion: '2026-09-20', effectiveAt: '2026-09-20T00:00:00Z' }, fallbackFromAttemptOrdinal: null },
        { ordinal: 2, adapterId: 'jev', adapterVersion: '1', requestedModel: 'alias', actualModel: 'served',
          providerRequestId: 'success-request', status: 'succeeded', dispatchedAtEpochMs: 21, completedAtEpochMs: 40,
          usage: { inputTokens: 7, outputTokens: 3 }, cost: { kind: 'provider-authoritative', currency: 'USD', amountMicros: 100 },
          fallbackFromAttemptOrdinal: 1 },
      ],
    };
    const spans = recordBatchReceiptTrace(builder, receipt, root.context);
    expect(spans).toHaveLength(2);
    expect(spans.map(span => span.attributes['gen_ai.usage.input_tokens'])).toEqual([5, 7]);
    expect(spans.map(span => span.attributes['aiwg.batch.item_count'])).toEqual([2, 2]);
    expect(spans.map(span => span.provenance['aiwg.usage.cost_usd'])).toEqual(['client-derived', 'provider-fact']);
    expect(spans.reduce((sum, span) => sum + Number(span.attributes['gen_ai.usage.input_tokens']), 0)).toBe(12);
    expect(JSON.stringify(spans)).not.toContain('q-1');
  });

  it('redacts protected content, provider IDs, and injected canaries from public export', () => {
    const value = trace();
    value.spans[0]!.attributes = {
      ...value.spans[0]!.attributes,
      prompt: 'do not export',
      'aiwg.provider.request_id': 'request-internal',
      'safe.field': 'prefix PII-CANARY suffix',
    };
    const sanitized = sanitizedTelemetryExport(value, { canaries: ['PII-CANARY'] });
    expect(JSON.stringify(sanitized)).not.toContain('do not export');
    expect(JSON.stringify(sanitized)).not.toContain('request-internal');
    expect(scanTelemetryCanaries(sanitized, ['PII-CANARY', 'SECRET-CANARY'])).toEqual([]);
  });

  it('requires a complete explicit debug capture policy', () => {
    expect(validateDebugCapturePolicy(undefined)).toBeNull();
    expect(() => validateDebugCapturePolicy({
      explicitlyAuthorized: true,
      encryption: { enabled: false, keyReference: 'opaque-key' },
      accessAudit: { enabled: true, sinkReference: 'audit' },
      classification: 'restricted', ttlMs: 1_000, deletionEnabled: true,
    })).toThrow(/incomplete/);
  });

  it('enforces metric dimension allowlists and cardinality bounds', () => {
    const metrics = new BoundedDecisionMetrics(10, 2);
    expect(metrics.record('decision.duration', 1, { 'aiwg.run.id': 'unbounded-1', 'aiwg.adapter.id': 'jev' })).toBe(true);
    expect(metrics.record('decision.duration', 2, { 'aiwg.run.id': 'unbounded-2', 'aiwg.adapter.id': 'llm' })).toBe(true);
    expect(metrics.record('decision.duration', 3, { 'aiwg.adapter.id': 'third' })).toBe(false);
    expect(metrics.snapshot().every(point => !Object.hasOwn(point.dimensions, 'aiwg.run.id'))).toBe(true);
  });

  it('bounds exporter backpressure and records failures without throwing to callers', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const exporter = new BoundedDecisionTraceExporter({ export: async () => blocked }, { capacity: 1, timeoutMs: 1_000 });
    expect(exporter.offer(trace())).toBe(true);
    expect(exporter.offer(trace())).toBe(true);
    expect(exporter.offer(trace())).toBe(false);
    release();
    await exporter.shutdown();
    expect(exporter.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'dropped' })]));
  });

  it('bounds an exporter that ignores cancellation', async () => {
    const exporter = new BoundedDecisionTraceExporter({ export: async () => new Promise<void>(() => undefined) }, { capacity: 1, timeoutMs: 5 });
    expect(exporter.offer(trace())).toBe(true);
    await exporter.shutdown();
    expect(exporter.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'timeout' })]));
  });

  it('tombstones deletions and rejects them under legal hold', () => {
    const policy = { traceTtlMs: 100, debugSidecarTtlMs: 100, exportTtlMs: 100, linkedRecordTtlMs: 100, deletionEnabled: true, tombstonesEnabled: true, legalHold: false };
    const deleted = deleteTelemetryReference(trace(), 'review', 'review-opaque', 'retention elapsed', policy, 500);
    expect(deleted.tombstones).toEqual([{ referenceType: 'review', opaqueId: 'review-opaque', deletedAtUnixMs: 500, reason: 'retention elapsed' }]);
    expect(() => deleteTelemetryReference(trace(), 'review', 'review-opaque', 'requested', { ...policy, legalHold: true })).toThrow(/legal hold/);
    const restored = restoreTelemetryTrace(trace(), policy, 1_000);
    expect(restored.spans).toEqual([]);
    expect(restored.tombstones?.at(-1)?.reason).toBe('expired during restore');
    expect(restoreTelemetryTrace(trace(), { ...policy, legalHold: true }, 1_000).spans).toHaveLength(1);
  });

  it('keeps the complete required scenario set in the golden manifest', async () => {
    const fixture = JSON.parse(await readFile(new URL('../../fixtures/decision/telemetry-golden-v1.json', import.meta.url), 'utf8')) as { scenarios: Array<{ id: string; name: string; spans: string[] }> };
    expect(fixture.scenarios.map(scenario => scenario.name)).toEqual([
      'single-success', 'heterogeneous-batch', 'retry-then-success', 'backend-fallback', 'invalid-output',
      'caller-cancellation', 'execution-uncertainty', 'policy-review', 'cache-hit', 'async-item',
      'approved-action-link', 'sanitized-incident-export',
    ]);
    expect(fixture.scenarios.every(scenario => scenario.spans[0] === 'decision.workflow')).toBe(true);
  });
});
