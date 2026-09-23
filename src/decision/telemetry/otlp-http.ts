import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';
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
    // DNS resolution and rebinding still require a separately qualified transport.
    // Literal and local-only names cannot be mistaken for approved public collectors.
    const host = endpoint.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (isIP(host) || host === 'localhost' || host.endsWith('.localhost')) {
      throw new TypeError('OTLP collector requires a qualified DNS hostname');
    }
    if (!Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes < 1) throw new TypeError('Invalid OTLP payload bound');
    this.endpoint = endpoint.href;
    this.maxPayloadBytes = options.maxPayloadBytes;
    // Native HTTPS connects to the validated address, not a second DNS lookup.
    // Injected transports are for controlled tests only; they do not enforce DNS policy.
    this.transport = options.fetch ?? pinnedHttpsFetch;
  }

  async export(trace: DecisionTelemetryTrace, signal: AbortSignal): Promise<void> {
    const safe = sanitizedTelemetryExport(trace);
    const payload = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ scope: { name: 'aiwg.decision', version: '1' },
      spans: safe.spans.map(toOtlpSpan) }] }] });
    if (Buffer.byteLength(payload, 'utf8') > this.maxPayloadBytes) throw new Error('OTLP payload exceeds configured bound');
    let response: Response;
    try {
      response = await this.transport(this.endpoint, { method: 'POST', redirect: 'manual', signal,
        headers: { 'content-type': 'application/json' }, body: payload });
    } catch {
      // DNS, TLS and injected transport errors may contain private hostnames,
      // paths or payloads. Diagnostics must report failure without echoing them.
      throw new Error('OTLP transport failed');
    }
    if (!response.ok) throw new Error(`OTLP exporter returned HTTP ${response.status}`);
    if (!response.body) return;
    // OTLP/HTTP may acknowledge a request while rejecting some spans. Never
    // echo collector response text; it can contain arbitrary sensitive data.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) throw new Error('OTLP response exceeds configured inspection bound');
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'OTLP response exceeds configured inspection bound') throw error;
      throw new Error('OTLP response read failed');
    } finally { reader.releaseLock(); }
    if (size === 0) return;
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new Error('OTLP collector returned an invalid response'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('OTLP collector returned an invalid response');
    const partial = (body as Record<string, unknown>).partialSuccess;
    if (partial === undefined) return;
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new Error('OTLP collector returned an invalid response');
    const rejected = (partial as Record<string, unknown>).rejectedSpans;
    if (rejected !== undefined && rejected !== 0 && rejected !== '0') {
      // Unknown or non-zero values cannot be treated as a complete export.
      throw new Error('OTLP collector partially rejected spans');
    }
    if ((partial as Record<string, unknown>).errorMessage) throw new Error('OTLP collector reported partial success');
  }
}

// Reject non-global IPv4 space, including documentation, benchmarking and multicast.
// IPv6 is allowlisted to global unicast; mapped IPv4 and local transition ranges fail closed.
const forbiddenV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) forbiddenV4.addSubnet(address, prefix);

export function isPublicCollectorAddress(address: string): boolean {
  if (isIP(address) === 4) return !forbiddenV4.check(address, 'ipv4');
  // Exclude IPv4-mapped addresses and translation/tunneling ranges even if
  // their embedded IPv4 address looks public.
  if (isIP(address) === 6) return /^2[0-9a-f]{3}:/i.test(address)
    && !/^2001:(?:0:|db8:)/i.test(address) && !/^2002:/i.test(address);
  return false;
}

export async function resolvePublicCollectorAddress(host: string,
  resolver: (host: string) => Promise<LookupAddress[]> = name => lookup(name, { all: true, verbatim: true }),
): Promise<LookupAddress> {
  const addresses = await resolver(host);
  if (!addresses.length || addresses.some(({ address, family }) => isIP(address) !== family || !isPublicCollectorAddress(address))) {
    throw new Error('OTLP collector DNS includes a non-public address');
  }
  return addresses[0]!;
}

function pinnedHttpsFetch(input: string | URL | Request, options?: RequestInit): Promise<Response> {
  const endpoint = new URL(input instanceof Request ? input.url : input);
  return new Promise((resolve, reject) => {
    // Node's HTTPS request performs TLS verification against the original hostname.
    // A fresh DNS resolution is validated for each connection; no connection pool
    // survives to bypass this policy on subsequent exports.
    const req = request(endpoint, {
      method: 'POST', agent: false, headers: { 'content-type': 'application/json' },
      lookup: (host, _opts, callback) => {
        void resolvePublicCollectorAddress(host).then(
          ({ address, family }) => callback(null, address, family),
          error => callback(error as Error, '', 4),
        );
      },
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4096) { req.destroy(new Error('OTLP response exceeds configured inspection bound')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(new Response(
        [204, 205, 304].includes(response.statusCode ?? 0) ? null : Buffer.concat(chunks),
        { status: response.statusCode ?? 502 },
      )));
      response.on('error', reject);
    });
    req.on('error', reject);
    const signal = options?.signal;
    if (signal?.aborted) { req.destroy(signal.reason); return; }
    signal?.addEventListener('abort', () => req.destroy(new Error('OTLP export aborted')), { once: true });
    req.end(options?.body as string);
  });
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
