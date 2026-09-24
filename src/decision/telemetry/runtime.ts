import type { DecisionEvaluationRequest, RulesetResult } from '../types.js';
import { mapAdmissionEvidence, mapDecisionAttempt, mapDecisionResult, mapRulesetResult } from './mapping.js';
import { DecisionTraceBuilder } from './trace.js';
import { recordDecisionSpanMetrics } from './metrics.js';
import type { DecisionTelemetrySpan } from './types.js';

/**
 * Emit a bounded, metadata-only trace for one completed evaluator invocation.
 * Exporter and ID-source failures are deliberately isolated from decision semantics.
 */
export async function emitRulesetRuntimeTrace(request: DecisionEvaluationRequest, result: RulesetResult): Promise<void> {
  const telemetry = request.telemetry;
  if (!telemetry) return;
  try {
    const now = request.now ?? Date.now;
    const builder = new DecisionTraceBuilder(telemetry.ids, now);
    const mapped = mapRulesetResult(result);
    const root = builder.startSpan('decision.workflow', {
      ...(telemetry.parent ? { parent: telemetry.parent } : {}),
      attributes: mapped.attributes,
      provenance: mapped.provenance,
    });
    if (result.spec.cache?.disposition === 'cache-hit') {
      // Historical attempts are evidence, not attempts by this caller. Emitting
      // their provider usage again would double-count tokens and fabricate work.
      root.attributes['aiwg.invocation.id'] = result.spec.cache.callerInvocationId;
      root.attributes['aiwg.cache.layer'] = 'result';
      root.attributes['aiwg.cache.result'] = 'hit';
      root.provenance['aiwg.invocation.id'] = 'client-derived';
      root.provenance['aiwg.cache.layer'] = 'client-derived';
      root.provenance['aiwg.cache.result'] = 'client-derived';
      const hit = builder.startSpan('decision.cache', { parent: root.context,
        attributes: { 'aiwg.cache.layer': 'result', 'aiwg.cache.result': 'hit' },
        provenance: { 'aiwg.cache.layer': 'client-derived', 'aiwg.cache.result': 'client-derived' } });
      builder.endSpan(hit, 'ok');
      builder.endSpan(root, 'ok');
      await emitAll(telemetry.hook.emit.bind(telemetry.hook), builder.build().spans);
      return;
    }
    const validate = builder.startSpan('decision.validate', { parent: root.context,
      attributes: { 'aiwg.validation.outcome': result.spec.reason === 'invalid-input' || result.spec.reason === 'invalid-definition' ? 'rejected' : 'accepted' },
      provenance: { 'aiwg.validation.outcome': 'client-derived' } });
    builder.endSpan(validate, validate.attributes['aiwg.validation.outcome'] === 'rejected' ? 'error' : 'ok');

    for (const evaluation of Object.values(result.spec.evaluations)) {
      for (const attempt of evaluation.spec.attempts) {
        if (attempt.admission) {
          const admission = mapAdmissionEvidence(attempt.admission);
          const admit = builder.startSpan('decision.admit', { parent: root.context,
            attributes: { ...admission.attributes, 'aiwg.adapter.id': attempt.adapter },
            provenance: { ...admission.provenance, 'aiwg.adapter.id': 'client-derived' } });
          for (const change of attempt.admission.breakerTransitions ?? []) {
            admit.events.push({ name: 'breaker.transition', timeUnixMs: now(),
              attributes: { 'aiwg.breaker.from': change.from, 'aiwg.breaker.to': change.to } });
          }
          builder.endSpan(admit, attempt.admission.decision === 'admit' ? 'ok'
            : attempt.admission.decision === 'reject' ? 'error' : 'unset');
        }
        const attemptMapping = mapDecisionAttempt(attempt);
        const span = builder.startSpan('decision.attempt', { parent: root.context,
          attributes: attemptMapping.attributes, provenance: attemptMapping.provenance });
        if (attempt.retryDelayMs !== undefined) span.events.push({ name: 'retry.scheduled', timeUnixMs: now(),
          attributes: { 'aiwg.retry.delay_ms': attempt.retryDelayMs } });
        if (attempt.termination) span.events.push({ name: 'attempt.terminated', timeUnixMs: now(),
          attributes: { 'aiwg.attempt.termination': attempt.termination } });
        builder.endSpan(span, attempt.status === 'success' ? 'ok' : 'error');
      }
      const resultMapping = mapDecisionResult(evaluation);
      const normalize = builder.startSpan('decision.normalize', { parent: root.context,
        attributes: resultMapping.attributes, provenance: resultMapping.provenance });
      builder.endSpan(normalize, evaluation.spec.reason === 'invalid-output' ? 'error' : 'ok');
      const accept = builder.startSpan('decision.accept', { parent: root.context,
        attributes: resultMapping.attributes, provenance: resultMapping.provenance });
      builder.endSpan(accept, evaluation.spec.status === 'error' || evaluation.spec.status === 'cancelled' ? 'error' : 'ok');
    }

    const compose = builder.startSpan('decision.compose', { parent: root.context,
      attributes: mapped.attributes, provenance: mapped.provenance });
    builder.endSpan(compose, result.spec.status === 'error' || result.spec.status === 'cancelled' ? 'error' : 'ok');
    if (result.spec.status === 'review') {
      const review = builder.startSpan('decision.review', { parent: root.context,
        attributes: { 'aiwg.decision.reason': result.spec.reason },
        provenance: { 'aiwg.decision.reason': 'client-derived' } });
      builder.endSpan(review, 'ok');
    }
    const persist = builder.startSpan('decision.persist', { parent: root.context,
      attributes: { 'aiwg.persistence.result': result.spec.reason === 'persistence-error' ? 'failed' : 'persisted' },
      provenance: { 'aiwg.persistence.result': 'client-derived' } });
    builder.endSpan(persist, result.spec.reason === 'persistence-error' ? 'error' : 'ok');
    builder.endSpan(root, result.spec.status === 'error' || result.spec.status === 'cancelled' ? 'error' : 'ok');
    const spans = builder.build().spans;
    if (telemetry.metrics) for (const span of spans) {
      try { recordDecisionSpanMetrics(span, telemetry.metrics); } catch { /* metrics cannot change a decision */ }
    }
    await emitAll(telemetry.hook.emit.bind(telemetry.hook), spans);
  } catch {
    // Observability must never alter, reject, or mask the authoritative result.
  }
}

async function emitAll(emit: (span: DecisionTelemetrySpan) => void | Promise<void>, spans: DecisionTelemetrySpan[]): Promise<void> {
  for (const span of spans) {
    try { await emit(span); } catch { /* isolate individual exporter failures */ }
  }
}
