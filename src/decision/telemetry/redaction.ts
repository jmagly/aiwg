import type { DecisionTelemetrySpan, DecisionTelemetryTrace, TelemetryAttribute, TelemetryAttributes } from './types.js';

const PROTECTED_KEY = /(?:state|question|prompt|response|answer(?:\.body)?|authorization|api[_-]?key|credential|vault|secret|reasoning|cookie|token(?!s?$))/i;
const CONTROL = /[\u0000-\u001f\u007f]/g;
export const DEFAULT_ATTRIBUTE_VALUE_LIMIT = 256;

export function sanitizeOpaqueValue(value: string, maximum = DEFAULT_ATTRIBUTE_VALUE_LIMIT): string {
  return value.replace(CONTROL, '').slice(0, maximum);
}

export function sanitizeAttributes(
  attributes: TelemetryAttributes,
  options: { publicExport?: boolean; canaries?: readonly string[]; maximumValueLength?: number } = {},
): TelemetryAttributes {
  const output: TelemetryAttributes = {};
  for (const [key, original] of Object.entries(attributes)) {
    if (PROTECTED_KEY.test(key) || (options.publicExport && key === 'aiwg.provider.request_id')) continue;
    let value: TelemetryAttribute = original;
    if (typeof value === 'string') {
      const lowered = value.toLowerCase();
      if (options.canaries?.some(canary => canary.length > 0 && lowered.includes(canary.toLowerCase()))) continue;
      value = sanitizeOpaqueValue(value, options.maximumValueLength);
    }
    output[key] = value;
  }
  return output;
}

export function sanitizedTelemetryExport(
  trace: DecisionTelemetryTrace,
  options: { canaries?: readonly string[]; includeInternalRequestIds?: boolean } = {},
): DecisionTelemetryTrace {
  const spans: DecisionTelemetrySpan[] = trace.spans.map(span => {
    const attributes = sanitizeAttributes(span.attributes, { publicExport: !options.includeInternalRequestIds, canaries: options.canaries });
    return {
      ...span, attributes,
      provenance: Object.fromEntries(Object.entries(span.provenance).filter(([key]) => Object.hasOwn(attributes, key))),
      events: span.events.map(event => ({ ...event, attributes: sanitizeAttributes(event.attributes, { publicExport: true, canaries: options.canaries }) })),
      links: span.links.map(link => ({ ...link, ...(link.attributes ? { attributes: sanitizeAttributes(link.attributes, { publicExport: true, canaries: options.canaries }) } : {}) })),
    };
  });
  const tombstones = trace.tombstones?.map(tombstone => ({
    ...tombstone,
    opaqueId: sanitizeOpaqueValue(tombstone.opaqueId),
    reason: options.canaries?.some(canary => canary && tombstone.reason.toLowerCase().includes(canary.toLowerCase()))
      ? 'redacted' : sanitizeOpaqueValue(tombstone.reason),
  }));
  return { ...trace, spans, ...(tombstones ? { tombstones } : {}) };
}

export function scanTelemetryCanaries(value: unknown, canaries: readonly string[]): string[] {
  const serialized = JSON.stringify(value).toLowerCase();
  return canaries.filter(canary => canary.length > 0 && serialized.includes(canary.toLowerCase()));
}
