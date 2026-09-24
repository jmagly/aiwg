import { DECISION_LIFECYCLE_VERSION, validateDecisionLifecyclePolicy, type DecisionLifecycleHold,
  type DecisionLifecyclePolicy, type DecisionLifecycleSurface } from '../lifecycle.js';
import type { DecisionDebugCapturePolicy, DecisionRetentionPolicy, DecisionTelemetryTombstone, DecisionTelemetryTrace } from './types.js';

export function validateDebugCapturePolicy(policy: DecisionDebugCapturePolicy | undefined): DecisionDebugCapturePolicy | null {
  if (!policy) return null;
  if (!policy.explicitlyAuthorized || !policy.encryption.enabled || !policy.encryption.keyReference
    || !policy.accessAudit.enabled || !policy.accessAudit.sinkReference || !policy.deletionEnabled
    || !Number.isSafeInteger(policy.ttlMs) || policy.ttlMs <= 0
    || !['confidential', 'restricted'].includes(policy.classification)
    || !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(policy.encryption.keyReference)
    || !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(policy.accessAudit.sinkReference)) throw new Error('Sensitive debug capture policy is incomplete');
  return structuredClone(policy);
}

/** Lifecycle surfaces whose content telemetry retains or links to. */
export const TELEMETRY_LIFECYCLE_SURFACES: readonly DecisionLifecycleSurface[] = [
  'trace', 'debug-sidecar', 'export', 'review', 'job', 'cache', 'evaluation',
];

/**
 * Derive telemetry retention from the common `decision-lifecycle/v1` policy (M09).
 * TTLs come from the lifecycle surfaces; linked records use the shortest linked-surface TTL.
 * Legal hold is true only while an authorized lifecycle hold for a telemetry surface is active.
 */
export function telemetryRetentionFromLifecyclePolicy(
  policy: DecisionLifecyclePolicy,
  holds: ReadonlyArray<DecisionLifecycleHold> = [],
  now = Date.now(),
): DecisionRetentionPolicy {
  validateDecisionLifecyclePolicy(policy);
  if (!Number.isSafeInteger(now) || now < 0 || !Array.isArray(holds as unknown)) throw new Error('Invalid telemetry retention policy');
  const surfaces = policy.surfaces;
  const legalHold = holds.some(hold => Number.isSafeInteger(hold?.expiresAt) && hold.expiresAt > now
    && Array.isArray(hold.scope as unknown) && hold.scope.some(surface => TELEMETRY_LIFECYCLE_SURFACES.includes(surface)));
  const retention: DecisionRetentionPolicy = {
    traceTtlMs: surfaces.trace.retentionMs,
    debugSidecarTtlMs: surfaces['debug-sidecar'].retentionMs,
    exportTtlMs: surfaces.export.retentionMs,
    linkedRecordTtlMs: Math.min(surfaces.review.retentionMs, surfaces.job.retentionMs,
      surfaces.cache.retentionMs, surfaces.evaluation.retentionMs),
    deletionEnabled: true,
    tombstonesEnabled: true,
    legalHold,
    lifecycleVersion: DECISION_LIFECYCLE_VERSION,
  };
  validateRetentionPolicy(retention);
  return retention;
}

export function validateRetentionPolicy(policy: DecisionRetentionPolicy): void {
  const ttls = [policy.traceTtlMs, policy.debugSidecarTtlMs, policy.exportTtlMs, policy.linkedRecordTtlMs];
  if (ttls.some(ttl => !Number.isSafeInteger(ttl) || ttl <= 0) || !policy.deletionEnabled || !policy.tombstonesEnabled) throw new Error('Invalid telemetry retention policy');
}

export function deleteTelemetryReference(
  trace: DecisionTelemetryTrace,
  referenceType: DecisionTelemetryTombstone['referenceType'],
  opaqueId: string,
  reason: string,
  policy: DecisionRetentionPolicy,
  now = Date.now(),
): DecisionTelemetryTrace {
  validateRetentionPolicy(policy);
  if (policy.legalHold) throw new Error('Telemetry deletion prohibited by legal hold');
  if (!opaqueId || !reason) throw new Error('Deletion requires an opaque reference and reason');
  const tombstone: DecisionTelemetryTombstone = { referenceType, opaqueId, deletedAtUnixMs: now, reason: reason.slice(0, 128) };
  const spans = trace.spans.map(span => ({
    ...span,
    links: span.links.map(link => link.attributes && Object.values(link.attributes).includes(opaqueId)
      ? { ...link, attributes: { 'aiwg.link.state': 'deleted', 'aiwg.link.tombstone': opaqueId } }
      : link),
  }));
  return { ...trace, spans, tombstones: [...(trace.tombstones ?? []), tombstone] };
}

/** Reapply trace TTL after backup/restore before making restored content queryable. */
export function restoreTelemetryTrace(
  trace: DecisionTelemetryTrace,
  policy: DecisionRetentionPolicy,
  now = Date.now(),
): DecisionTelemetryTrace {
  validateRetentionPolicy(policy);
  if (policy.legalHold || trace.spans.length === 0) return structuredClone(trace);
  const createdAt = Math.min(...trace.spans.map(span => span.startTimeUnixMs));
  if (now - createdAt <= policy.traceTtlMs) return structuredClone(trace);
  return {
    schemaVersion: trace.schemaVersion,
    traceId: trace.traceId,
    spans: [],
    tombstones: [...(trace.tombstones ?? []), {
      referenceType: 'trace', opaqueId: trace.traceId, deletedAtUnixMs: now, reason: 'expired during restore',
    }],
  };
}
