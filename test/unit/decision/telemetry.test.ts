import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  BoundedDecisionMetrics,
  BoundedDecisionTraceExporter,
  DecisionOtlpHttpSink,
  createTelemetryContext,
  DecisionTraceBuilder,
  deleteTelemetryReference,
  estimatedUsageAllocation,
  extractTraceContext,
  injectTraceContext,
  mapDecisionAttempt,
  recordBatchReceiptTrace,
  recordDecisionSpanMetrics,
  restoreTelemetryTrace,
  sanitizedTelemetryExport,
  scanTelemetryCanaries,
  validateDebugCapturePolicy,
  type DecisionTelemetryIdSource,
  type DecisionTelemetryTrace,
} from '../../../src/decision/telemetry/index.js';
import type { DecisionAttempt } from '../../../src/decision/types.js';
import type { DecisionBatchReceipt } from '../../../src/decision/batch-receipts/index.js';
import { isPublicCollectorAddress, resolvePublicCollectorAddress } from '../../../src/decision/telemetry/otlp-http.js';

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

  it('maps provider prefix facts without exporting semantic identity or handles', () => {
    const mapped = mapDecisionAttempt({
      ordinal: 1, adapter: 'jev', adapterVersion: '1', requestedModel: 'm', actualModel: 'm1', subagent: null,
      status: 'success', reason: 'none', durationMs: 1, usage: { inputTokens: 10, outputTokens: 1, costUsd: null }, requestId: null,
      providerPrefix: { schemaVersion: 'decision-provider-prefix-evidence/v1', identityDigest: `sha256:${'a'.repeat(64)}`,
        status: 'hit', source: 'provider-report', cacheVersion: 'provider-v1', savedInputTokens: 8, expiresAtEpochMs: 1234 },
    });
    expect(mapped.attributes).toMatchObject({ 'aiwg.cache.layer': 'provider-prefix', 'aiwg.cache.result': 'hit',
      'aiwg.cache.version': 'provider-v1', 'aiwg.cache.saved_tokens': 8 });
    expect(JSON.stringify(mapped)).not.toContain('sha256:');
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

  it('strips untrusted tracestate, event names, and tombstone canaries from incident exports', () => {
    const value = trace();
    value.spans[0]!.context.traceState = 'vendor=PRIVATE-CANARY';
    value.spans[0]!.events.push({ name: 'PRIVATE-CANARY response body', timeUnixMs: 100, attributes: {} });
    value.spans[0]!.events.push({ name: 'retry.scheduled', timeUnixMs: 100,
      attributes: { 'aiwg.retry.delay_ms': 1 } });
    value.tombstones = [{ referenceType: 'review', opaqueId: 'PRIVATE-CANARY', deletedAtUnixMs: 100,
      reason: 'PRIVATE-CANARY' }];
    const exported = sanitizedTelemetryExport(value, { canaries: ['PRIVATE-CANARY'] });
    expect(scanTelemetryCanaries(exported, ['PRIVATE-CANARY'])).toEqual([]);
    expect(exported.spans[0]?.events.map(event => event.name)).toEqual(['retry.scheduled']);
    expect(exported.spans[0]?.context.traceState).toBeUndefined();
    expect(exported.tombstones?.[0]).toMatchObject({ opaqueId: 'redacted', reason: 'redacted' });
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

  it('records only shared-request batch usage and fixed operational metric names', () => {
    const builder = new DecisionTraceBuilder(deterministicIds(), () => 100);
    const root = builder.startSpan('decision.workflow');
    const batch = builder.startSpan('decision.batch.request', { parent: root.context });
    builder.recordBatchUsage(batch, 'batch-1', { inputTokens: 13, outputTokens: 5, costUsd: null });
    const answer = builder.startSpan('decision.attempt', { parent: root.context, attributes: {
      'aiwg.batch.id': 'batch-1', 'gen_ai.usage.input_tokens': 13, 'gen_ai.usage.output_tokens': 5,
      'aiwg.run.id': 'private-run', 'aiwg.provider.request_id': 'private-provider',
    } });
    const metrics = new BoundedDecisionMetrics(20, 5);
    for (const span of [root, batch, answer]) recordDecisionSpanMetrics(span, metrics);
    expect(metrics.snapshot().filter(point => point.name === 'decision.input_tokens').map(point => point.value)).toEqual([13]);
    expect(metrics.snapshot().filter(point => point.name === 'decision.output_tokens').map(point => point.value)).toEqual([5]);
    expect(JSON.stringify(metrics.snapshot())).not.toMatch(/private-run|private-provider|batch-1/);
    expect(metrics.record('decision.body-' + 'secret', 1, {})).toBe(false);
    expect(metrics.record('decision.input_tokens', Number.NaN, {})).toBe(false);
    const admit = builder.startSpan('decision.admit', { attributes: { 'aiwg.queue.delay_ms': 8 } });
    const accept = builder.startSpan('decision.accept', { attributes: { 'aiwg.acceptance.disposition': 'act' } });
    recordDecisionSpanMetrics(admit, metrics);
    recordDecisionSpanMetrics(accept, metrics);
    expect(metrics.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'decision.queue_delay', value: 8 }),
      expect.objectContaining({ name: 'decision.coverage', value: 1 }),
    ]));
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

  it('exports metadata-only OTLP/HTTP JSON to a pinned HTTPS endpoint without redirects', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;
    const sink = new DecisionOtlpHttpSink({ endpoint: 'https://collector.example/v1/traces', maxPayloadBytes: 16_384,
      fetch: transport });
    const value = trace();
    value.spans[0]!.attributes = { 'aiwg.run.id': 'run-1', prompt: 'do-not-export',
      'aiwg.provider.request_id': 'internal-request' };
    await sink.export(value, new AbortController().signal);
    expect(transport).toHaveBeenCalledOnce();
    const [endpoint, options] = transport.mock.calls[0]!;
    expect(endpoint).toBe('https://collector.example/v1/traces');
    expect(options).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' } });
    const payload = JSON.parse(String(options?.body)) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: unknown[] }> }> }> };
    expect(payload.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes).toContainEqual({ key: 'aiwg.run.id', value: { stringValue: 'run-1' } });
    expect(JSON.stringify(payload)).not.toMatch(/do-not-export|internal-request/);
    expect(() => new DecisionOtlpHttpSink({ endpoint: 'http://collector.example/v1/traces', maxPayloadBytes: 1 }))
      .toThrow(/HTTPS/);
    expect(() => new DecisionOtlpHttpSink({ endpoint: 'https://user:password@collector.example/v1/traces', maxPayloadBytes: 1 }))
      .toThrow(/HTTPS/);
  });

  it.each([
    'https://127.0.0.1/v1/traces',
    'https://127.1/v1/traces',
    'https://[::1]/v1/traces',
    'https://169.254.1.1/v1/traces',
    'https://localhost/v1/traces',
    'https://collector.localhost/v1/traces',
  ])('rejects an OTLP literal or local-only collector destination: %s', endpoint => {
    expect(() => new DecisionOtlpHttpSink({ endpoint, maxPayloadBytes: 16_384 }))
      .toThrow(/qualified DNS hostname/);
  });

  it('rejects DNS rebinding and private, mapped, or mixed collector answers', async () => {
    for (const address of ['127.0.0.1', '10.2.3.4', '169.254.169.254', '192.168.1.1',
      '100.64.0.1', '198.51.100.2', '::1', 'fc00::1', 'fe80::1', '::ffff:8.8.8.8', '2001:db8::1']) {
      expect(isPublicCollectorAddress(address), address).toBe(false);
      await expect(resolvePublicCollectorAddress('collector.example', async () => [{ address, family: address.includes(':') ? 6 : 4 }]))
        .rejects.toThrow(/non-public/);
    }
    expect(isPublicCollectorAddress('8.8.8.8')).toBe(true);
    expect(isPublicCollectorAddress('2606:4700::1111')).toBe(true);
    await expect(resolvePublicCollectorAddress('collector.example', async () => [
      { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
    ])).rejects.toThrow(/non-public/);
    await expect(resolvePublicCollectorAddress('collector.example', async () => [])).rejects.toThrow(/non-public/);
    let n = 0;
    const resolver = async () => [{ address: ++n === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
    await expect(resolvePublicCollectorAddress('collector.example', resolver)).resolves.toMatchObject({ address: '8.8.8.8' });
    await expect(resolvePublicCollectorAddress('collector.example', resolver)).rejects.toThrow(/non-public/);
  });

  it('bounds sustained exporter backpressure without retrying or changing receipts', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const exporter = new BoundedDecisionTraceExporter({ export: async () => { calls++; await blocked; } },
      { capacity: 3, timeoutMs: 1000, maximumDiagnostics: 5 });
    const accepted = Array.from({ length: 1000 }, () => exporter.offer(trace())).filter(Boolean).length;
    expect(accepted).toBe(4); // one in-flight, three queued
    expect(exporter.diagnostics).toHaveLength(5);
    expect(exporter.diagnostics.every(item => item.type === 'dropped')).toBe(true);
    release();
    await exporter.shutdown();
    expect(calls).toBe(4);
  });

  it('bounds OTLP bytes and treats redirects as exporter failures', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 302,
      headers: { location: 'https://other.example/v1/traces' } })) as typeof fetch;
    const tiny = new DecisionOtlpHttpSink({ endpoint: 'https://collector.example/v1/traces', maxPayloadBytes: 1,
      fetch: transport });
    await expect(tiny.export(trace(), new AbortController().signal)).rejects.toThrow(/bound/);
    expect(transport).not.toHaveBeenCalled();
    const sink = new DecisionOtlpHttpSink({ endpoint: 'https://collector.example/v1/traces', maxPayloadBytes: 16_384,
      fetch: transport });
    const exporter = new BoundedDecisionTraceExporter(sink, { capacity: 1, timeoutMs: 100 });
    expect(exporter.offer(trace())).toBe(true);
    await exporter.shutdown();
    expect(exporter.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'failed' })]));
  });

  it('treats OTLP partial success and oversized responses as failures without echoing collector text', async () => {
    const respond = (body: string) => vi.fn(async () => new Response(body, { status: 200,
      headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const sink = (transport: typeof fetch) => new DecisionOtlpHttpSink({ endpoint: 'https://collector.example/v1/traces',
      maxPayloadBytes: 16_384, fetch: transport });
    const signal = new AbortController().signal;
    await expect(sink(respond('{"partialSuccess":{"rejectedSpans":"1","errorMessage":"private-test-payload"}}'))
      .export(trace(), signal)).rejects.toThrow('OTLP collector partially rejected spans');
    await expect(sink(respond('{"partialSuccess":{"rejectedSpans":"unknown"}}'))
      .export(trace(), signal)).rejects.toThrow('OTLP collector partially rejected spans');
    await expect(sink(respond('x'.repeat(4097))).export(trace(), signal)).rejects.toThrow(/inspection bound/);
    await expect(sink(respond('{"partialSuccess":{"rejectedSpans":"0"}}'))
      .export(trace(), signal)).resolves.toBeUndefined();
  });

  it('keeps collector transport errors and malformed responses out of diagnostics', async () => {
    const sink = new DecisionOtlpHttpSink({ endpoint: 'https://collector.example/v1/traces', maxPayloadBytes: 16_384,
      fetch: vi.fn(async () => { throw new Error('SECRET-CANARY https://private.internal/key'); }) as typeof fetch });
    const exporter = new BoundedDecisionTraceExporter(sink, { capacity: 1, timeoutMs: 100 });
    expect(exporter.offer(trace())).toBe(true);
    await exporter.shutdown();
    expect(exporter.diagnostics).toEqual([expect.objectContaining({ type: 'failed', detail: 'OTLP transport failed' })]);
    const empty = new DecisionOtlpHttpSink({ endpoint: 'https://collector.example/v1/traces', maxPayloadBytes: 16_384,
      fetch: vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch });
    await expect(empty.export(trace(), new AbortController().signal)).resolves.toBeUndefined();
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
