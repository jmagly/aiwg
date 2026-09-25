/** OpenTelemetry-compatible, dependency-free decision telemetry contract. */
export const DECISION_TELEMETRY_SCHEMA_VERSION = 'decision-telemetry/v1' as const;

export type TelemetryAttribute = string | number | boolean | null;
export type TelemetryAttributes = Record<string, TelemetryAttribute>;
export type TelemetryProvenance = 'provider-fact' | 'client-derived' | 'estimate' | 'unknown';

export type DecisionSpanName =
  | 'decision.workflow' | 'decision.resolve' | 'decision.validate' | 'decision.project'
  | 'decision.admit' | 'decision.batch.request' | 'decision.attempt' | 'decision.normalize'
  | 'decision.accept' | 'decision.compose' | 'decision.persist' | 'decision.review'
  | 'decision.cache' | 'decision.job' | 'decision.action';

export interface DecisionTelemetryContext {
  traceId: string;
  spanId: string;
  traceFlags: '00' | '01';
  traceState?: string;
}

export interface DecisionTelemetryLink {
  traceId: string;
  spanId: string;
  relationship: 'batch' | 'review' | 'cache' | 'job' | 'action' | 'continuation' | 'evaluation';
  attributes?: TelemetryAttributes;
}

export interface DecisionTelemetryEvent {
  name: string;
  timeUnixMs: number;
  attributes: TelemetryAttributes;
}

export interface DecisionTelemetrySpan {
  schemaVersion: typeof DECISION_TELEMETRY_SCHEMA_VERSION;
  name: DecisionSpanName;
  context: DecisionTelemetryContext;
  parentSpanId: string | null;
  startTimeUnixMs: number;
  endTimeUnixMs: number;
  status: 'unset' | 'ok' | 'error';
  attributes: TelemetryAttributes;
  provenance: Record<string, TelemetryProvenance>;
  links: DecisionTelemetryLink[];
  events: DecisionTelemetryEvent[];
}

export interface DecisionTelemetryTrace {
  schemaVersion: typeof DECISION_TELEMETRY_SCHEMA_VERSION;
  traceId: string;
  spans: DecisionTelemetrySpan[];
  tombstones?: DecisionTelemetryTombstone[];
}

export interface DecisionTelemetryTombstone {
  referenceType: 'trace' | 'debug-sidecar' | 'review' | 'job' | 'cache' | 'evaluation';
  opaqueId: string;
  deletedAtUnixMs: number;
  reason: string;
}

export interface DecisionTelemetryHook {
  /** Evaluators call this hook explicitly; telemetry never controls their outcome. */
  emit(span: DecisionTelemetrySpan): void | Promise<void>;
}

export interface DecisionDebugCapturePolicy {
  explicitlyAuthorized: boolean;
  encryption: { enabled: boolean; keyReference: string };
  accessAudit: { enabled: boolean; sinkReference: string };
  classification: 'confidential' | 'restricted';
  ttlMs: number;
  deletionEnabled: boolean;
}

/**
 * Evaluated telemetry retention controls. Prefer deriving this from the common
 * `decision-lifecycle/v1` policy with `telemetryRetentionFromLifecyclePolicy()`.
 */
export interface DecisionRetentionPolicy {
  traceTtlMs: number;
  debugSidecarTtlMs: number;
  exportTtlMs: number;
  linkedRecordTtlMs: number;
  deletionEnabled: boolean;
  tombstonesEnabled: boolean;
  /**
   * @deprecated Hand-set boolean kept for backward compatibility. Derive it from authorized
   * `DecisionLifecycleHold` records via `telemetryRetentionFromLifecyclePolicy()` instead.
   */
  legalHold: boolean;
  /** Present when derived from the common lifecycle policy. */
  lifecycleVersion?: 'decision-lifecycle/v1';
}
