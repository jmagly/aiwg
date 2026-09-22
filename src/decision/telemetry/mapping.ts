import type { ArtifactPin, DecisionAttempt, DecisionResult, RulesetResult } from '../types.js';
import { sanitizeOpaqueValue } from './redaction.js';
import type { TelemetryAttributes, TelemetryProvenance } from './types.js';

export interface AttributeMapping {
  attributes: TelemetryAttributes;
  provenance: Record<string, TelemetryProvenance>;
}

function put(target: AttributeMapping, key: string, value: string | number | boolean | null, provenance: TelemetryProvenance): void {
  target.attributes[key] = value;
  target.provenance[key] = value === null ? 'unknown' : provenance;
}

export function mapDecisionAttempt(attempt: DecisionAttempt): AttributeMapping {
  const out: AttributeMapping = { attributes: {}, provenance: {} };
  put(out, 'aiwg.attempt.ordinal', attempt.ordinal, 'client-derived');
  put(out, 'aiwg.adapter.id', attempt.adapter, 'client-derived');
  put(out, 'aiwg.adapter.version', attempt.adapterVersion, 'client-derived');
  put(out, 'gen_ai.request.model', attempt.requestedModel, 'client-derived');
  put(out, 'gen_ai.response.model', attempt.actualModel, 'provider-fact');
  put(out, 'aiwg.decision.status', attempt.status, 'client-derived');
  put(out, 'aiwg.decision.reason', attempt.reason, 'client-derived');
  put(out, 'aiwg.attempt.duration_ms', attempt.durationMs, 'client-derived');
  put(out, 'gen_ai.usage.input_tokens', attempt.usage.inputTokens, 'provider-fact');
  put(out, 'gen_ai.usage.output_tokens', attempt.usage.outputTokens, 'provider-fact');
  put(out, 'aiwg.usage.cost_usd', attempt.usage.costUsd, 'provider-fact');
  put(out, 'aiwg.usage.cost_provenance', attempt.usage.costUsd === null ? 'unknown' : 'provider-fact', 'client-derived');
  put(out, 'aiwg.provider.request_id', attempt.requestId === null ? null : sanitizeOpaqueValue(attempt.requestId, 128), 'provider-fact');
  if (attempt.requestIdSource) put(out, 'aiwg.provider.request_id_source', attempt.requestIdSource, 'client-derived');
  if (attempt.httpStatus !== undefined) put(out, 'http.response.status_code', attempt.httpStatus, 'provider-fact');
  if (attempt.retryDelayMs !== undefined) put(out, 'aiwg.retry.delay_ms', attempt.retryDelayMs, 'client-derived');
  if (attempt.termination) put(out, 'aiwg.attempt.termination', attempt.termination, 'client-derived');
  if (attempt.remoteExecution) put(out, 'aiwg.remote.execution', attempt.remoteExecution, 'unknown');
  if (attempt.batch) {
    put(out, 'aiwg.batch.id', attempt.batch.groupId, 'client-derived');
    put(out, 'aiwg.batch.mode', attempt.batch.mode, 'client-derived');
  }
  return out;
}

export interface DecisionLifecycleMetadata {
  policyPin?: ArtifactPin | null;
  calibrationPin?: ArtifactPin | null;
  definitionPin?: ArtifactPin | null;
  routeReason?: string | null;
  fallback?: boolean;
  primitiveCount?: number | null;
  validationOutcome?: 'accepted' | 'rejected' | 'unknown';
  persistenceResult?: 'persisted' | 'failed' | 'not-required' | 'unknown';
  cacheSource?: string | null;
  batchId?: string | null;
  jobId?: string | null;
  reviewId?: string | null;
  effectReceiptId?: string | null;
}

/** Maps lifecycle-only metadata not present on DecisionResult without opening a body. */
export function mapDecisionLifecycle(metadata: DecisionLifecycleMetadata): AttributeMapping {
  const out: AttributeMapping = { attributes: {}, provenance: {} };
  const pin = (prefix: string, value: ArtifactPin | null | undefined): void => {
    put(out, `${prefix}.id`, value?.id ?? null, 'client-derived');
    put(out, `${prefix}.version`, value?.version ?? null, 'client-derived');
    put(out, `${prefix}.digest`, value?.digest ?? null, 'client-derived');
  };
  pin('aiwg.definition', metadata.definitionPin);
  pin('aiwg.policy', metadata.policyPin);
  pin('aiwg.calibration', metadata.calibrationPin);
  put(out, 'aiwg.route.reason', metadata.routeReason ?? null, 'client-derived');
  put(out, 'aiwg.route.fallback', metadata.fallback ?? false, 'client-derived');
  put(out, 'aiwg.primitive.count', metadata.primitiveCount ?? null, 'client-derived');
  put(out, 'aiwg.validation.outcome', metadata.validationOutcome ?? 'unknown', 'client-derived');
  put(out, 'aiwg.persistence.result', metadata.persistenceResult ?? 'unknown', 'client-derived');
  put(out, 'aiwg.cache.source', metadata.cacheSource ?? null, 'client-derived');
  for (const [key, value] of Object.entries({
    'aiwg.batch.id': metadata.batchId, 'aiwg.job.id': metadata.jobId, 'aiwg.review.id': metadata.reviewId,
    'aiwg.effect_receipt.id': metadata.effectReceiptId,
  })) put(out, key, value ?? null, 'client-derived');
  return out;
}

export function mapDecisionResult(result: DecisionResult): AttributeMapping {
  const out: AttributeMapping = { attributes: {}, provenance: {} };
  put(out, 'aiwg.run.id', result.spec.runId, 'client-derived');
  put(out, 'aiwg.invocation.id', result.spec.invocationId, 'client-derived');
  put(out, 'aiwg.decision.id', result.spec.decision.id, 'client-derived');
  put(out, 'aiwg.decision.version', result.spec.decision.version, 'client-derived');
  put(out, 'aiwg.ruleset.id', result.spec.ruleset.id, 'client-derived');
  put(out, 'aiwg.ruleset.version', result.spec.ruleset.version, 'client-derived');
  put(out, 'aiwg.binding.id', result.spec.binding.id, 'client-derived');
  put(out, 'aiwg.binding.version', result.spec.binding.version, 'client-derived');
  put(out, 'aiwg.decision.alias', result.spec.alias, 'client-derived');
  put(out, 'aiwg.decision.status', result.spec.status, 'client-derived');
  put(out, 'aiwg.decision.reason', result.spec.reason, 'client-derived');
  put(out, 'aiwg.attempt.count', result.spec.attempts.length, 'client-derived');
  if (result.spec.acceptance) {
    put(out, 'aiwg.acceptance.policy_version', result.spec.acceptance.policyVersion, 'client-derived');
    put(out, 'aiwg.acceptance.disposition', result.spec.acceptance.disposition, 'client-derived');
    put(out, 'aiwg.acceptance.reason', result.spec.acceptance.reason, 'client-derived');
  }
  return out;
}

export function mapRulesetResult(result: RulesetResult): AttributeMapping {
  const out: AttributeMapping = { attributes: {}, provenance: {} };
  put(out, 'aiwg.run.id', result.spec.runId, 'client-derived');
  put(out, 'aiwg.invocation.id', result.spec.invocationId, 'client-derived');
  put(out, 'aiwg.ruleset.id', result.spec.ruleset.id, 'client-derived');
  put(out, 'aiwg.ruleset.version', result.spec.ruleset.version, 'client-derived');
  put(out, 'aiwg.binding.id', result.spec.binding.id, 'client-derived');
  put(out, 'aiwg.binding.version', result.spec.binding.version, 'client-derived');
  put(out, 'aiwg.workflow.status', result.spec.status, 'client-derived');
  put(out, 'aiwg.decision.reason', result.spec.reason, 'client-derived');
  put(out, 'aiwg.evaluation.count', Object.keys(result.spec.evaluations).length, 'client-derived');
  return out;
}
