import type { DecisionTelemetrySpan, DecisionTelemetryTrace, TelemetryAttribute, TelemetryAttributes } from './types.js';

const PROTECTED_KEY = /(?:state|question|prompt|response|answer(?:\.body)?|authorization|api[_-]?key|credential|vault|secret|reasoning|cookie|token(?!s?$))/i;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const SAFE_EVENT_NAMES = new Set(['retry.scheduled', 'attempt.terminated', 'breaker.transition']);
// Only schema-declared metadata may cross the telemetry boundary. A syntactically
// plausible custom key can still carry body text or PII in its value.
const SAFE_ATTRIBUTE_KEYS = new Set(`
  aiwg.run.id aiwg.invocation.id aiwg.workflow.status aiwg.evaluation.count
  aiwg.decision.id aiwg.decision.version aiwg.decision.alias aiwg.decision.status aiwg.decision.reason
  aiwg.ruleset.id aiwg.ruleset.version aiwg.binding.id aiwg.binding.version
  aiwg.adapter.id aiwg.adapter.version aiwg.attempt.ordinal aiwg.attempt.count
  aiwg.attempt.duration_ms aiwg.attempt.termination aiwg.retry.delay_ms
  aiwg.acceptance.policy_version aiwg.acceptance.disposition aiwg.acceptance.reason
  aiwg.calibration.compatibility_state aiwg.calibration.compatibility_action
  aiwg.calibration.artifact_id aiwg.calibration.artifact_digest aiwg.calibration.alias_revision
  aiwg.calibration.reason_count aiwg.route.reason aiwg.route.fallback aiwg.primitive.count
  aiwg.validation.outcome aiwg.persistence.result aiwg.cache.source aiwg.cache.layer
  aiwg.cache.result aiwg.cache.version aiwg.cache.saved_tokens aiwg.cache.expires_at_ms
  aiwg.batch.id aiwg.batch.mode aiwg.batch.plan_digest aiwg.batch.partition_id
  aiwg.batch.item_count aiwg.batch.result_count aiwg.job.id
  aiwg.job.operation aiwg.job.status aiwg.job.revision aiwg.job.item_count aiwg.job.unknown_count
  aiwg.review.id aiwg.operator_decision.event_id
  aiwg.review.status aiwg.review.event aiwg.review.revision aiwg.effect_receipt.id
  aiwg.provider.request_id aiwg.provider.request_id_source aiwg.remote.execution
  aiwg.usage.cost_usd aiwg.usage.cost_provenance aiwg.usage.scope aiwg.link.state
  aiwg.link.tombstone aiwg.queue.delay_ms aiwg.drift.value
  aiwg.admission.decision aiwg.admission.reason aiwg.admission.estimated_tokens aiwg.admission.estimated_cost_usd
  aiwg.admission.retry_after_ms aiwg.queue.active aiwg.queue.queued aiwg.retry.pressure
  aiwg.breaker.status aiwg.breaker.from aiwg.breaker.to
  aiwg.projection.mode aiwg.projection.outcome aiwg.projection.reason aiwg.projection.field_count
  aiwg.projection.incomplete_context aiwg.projection.automatic_action_allowed
  gen_ai.request.model gen_ai.response.model gen_ai.usage.input_tokens
  gen_ai.usage.output_tokens http.response.status_code
`.trim().split(/\s+/));
for (const prefix of ['aiwg.definition', 'aiwg.policy', 'aiwg.calibration']) {
  for (const suffix of ['id', 'version', 'digest']) SAFE_ATTRIBUTE_KEYS.add(`${prefix}.${suffix}`);
}
// Declared keys whose names match PROTECTED_KEY but carry only fixed metadata.
// `aiwg.link.state` is the deletion tombstone marker; dropping it would turn an
// explicit tombstone into an unexplained link in exports.
const PROTECTED_KEY_EXEMPTIONS = new Set(['gen_ai.response.model', 'http.response.status_code', 'aiwg.link.state']);
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
    if (!SAFE_ATTRIBUTE_KEYS.has(key)
      || (PROTECTED_KEY.test(key) && !PROTECTED_KEY_EXEMPTIONS.has(key))
      || (options.publicExport && key === 'aiwg.provider.request_id')
      || options.canaries?.some(canary => canary && key.toLowerCase().includes(canary.toLowerCase()))) continue;
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
      // Tracestate is a vendor-defined free-form string, not needed for export;
      // do not copy it into a disclosure even if a caller supplied one.
      context: { traceId: span.context.traceId, spanId: span.context.spanId, traceFlags: span.context.traceFlags },
      provenance: Object.fromEntries(Object.entries(span.provenance).filter(([key]) => Object.hasOwn(attributes, key))),
      events: span.events.filter(event => SAFE_EVENT_NAMES.has(event.name)).map(event => ({ ...event,
        attributes: sanitizeAttributes(event.attributes, { publicExport: true, canaries: options.canaries }) })),
      links: span.links.map(link => ({ ...link, ...(link.attributes ? { attributes: sanitizeAttributes(link.attributes, { publicExport: true, canaries: options.canaries }) } : {}) })),
    };
  });
  const tombstones = trace.tombstones?.map(tombstone => ({
    ...tombstone,
    opaqueId: options.canaries?.some(canary => canary && tombstone.opaqueId.toLowerCase().includes(canary.toLowerCase()))
      ? 'redacted' : sanitizeOpaqueValue(tombstone.opaqueId),
    reason: options.canaries?.some(canary => canary && tombstone.reason.toLowerCase().includes(canary.toLowerCase()))
      ? 'redacted' : sanitizeOpaqueValue(tombstone.reason),
  }));
  return { ...trace, spans, ...(tombstones ? { tombstones } : {}) };
}

export function scanTelemetryCanaries(value: unknown, canaries: readonly string[]): string[] {
  const serialized = JSON.stringify(value).toLowerCase();
  return canaries.filter(canary => canary.length > 0 && serialized.includes(canary.toLowerCase()));
}
