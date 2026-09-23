import { sanitizedTelemetryExport } from './redaction.js';
import type { DecisionTelemetrySpan, DecisionTelemetryTrace, TelemetryAttribute } from './types.js';
import type { DecisionTraceSink } from './exporter.js';

interface OtlpAttribute { key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean } }

/** Metadata-only OTLP/HTTP JSON sink. Credential headers and redirects are never accepted. */
export class DecisionOtlpHttpSink implements DecisionTraceSink {
  private readonly endpoint: string;
  private readonly maxPayloadBytes: number;
  private readonly transport: typeof fetch;

  constructor(options: { endpoint: string; maxPayloadBytes: number; fetch?: typeof fetch }) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !endpoint.pathname.endsWith('/v1/traces')) throw new TypeError('OTLP endpoint must be credential-free HTTPS /v1/traces');
    if (!Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes < 1) throw new TypeError('Invalid OTLP payload bound');
    this.endpoint = endpoint.href;
    this.maxPayloadBytes = options.maxPayloadBytes;
    this.transport = options.fetch ?? fetch;
  }

  async export(trace: DecisionTelemetryTrace, signal: AbortSignal): Promise<void> {
    const safe = sanitizedTelemetryExport(trace);
    const payload = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ scope: { name: 'aiwg.decision', version: '1' },
      spans: safe.spans.map(toOtlpSpan) }] }] });
    if (Buffer.byteLength(payload, 'utf8') > this.maxPayloadBytes) throw new Error('OTLP payload exceeds configured bound');
    const response = await this.transport(this.endpoint, { method: 'POST', redirect: 'manual', signal,
      headers: { 'content-type': 'application/json' }, body: payload });
    if (!response.ok) throw new Error(`OTLP exporter returned HTTP ${response.status}`);
  }
}

function toOtlpAttribute(key: string, value: TelemetryAttribute): OtlpAttribute {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') return { key, value: Number.isSafeInteger(value)
    ? { intValue: String(value) } : { doubleValue: value } };
  return { key, value: { stringValue: value === null ? 'unknown' : value } };
}

function toOtlpSpan(span: DecisionTelemetrySpan) {
  return {
    traceId: span.context.traceId, spanId: span.context.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    startTimeUnixNano: String(Math.trunc(span.startTimeUnixMs * 1_000_000)),
    endTimeUnixNano: String(Math.trunc(span.endTimeUnixMs * 1_000_000)),
    attributes: Object.entries(span.attributes).map(([key, value]) => toOtlpAttribute(key, value)),
    links: span.links.map(link => ({ traceId: link.traceId, spanId: link.spanId,
      attributes: Object.entries(link.attributes ?? {}).map(([key, value]) => toOtlpAttribute(key, value)) })),
    events: span.events.map(event => ({ name: event.name, timeUnixNano: String(Math.trunc(event.timeUnixMs * 1_000_000)),
      attributes: Object.entries(event.attributes).map(([key, value]) => toOtlpAttribute(key, value)) })),
    status: { code: span.status === 'error' ? 2 : span.status === 'ok' ? 1 : 0 },
  };
}
