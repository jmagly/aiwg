import { randomBytes } from 'node:crypto';
import type { DecisionTelemetryContext } from './types.js';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[01])$/;

export interface DecisionTelemetryIdSource {
  traceId(): string;
  spanId(): string;
}

export const randomTelemetryIds: DecisionTelemetryIdSource = {
  traceId: () => randomBytes(16).toString('hex'),
  spanId: () => randomBytes(8).toString('hex'),
};

function validNonZero(value: string): boolean {
  return !/^0+$/.test(value);
}

export function createTelemetryContext(
  ids: DecisionTelemetryIdSource = randomTelemetryIds,
  parent?: DecisionTelemetryContext,
): DecisionTelemetryContext {
  const traceId = parent?.traceId ?? ids.traceId();
  const spanId = ids.spanId();
  if (!/^[0-9a-f]{32}$/.test(traceId) || !validNonZero(traceId)
    || !/^[0-9a-f]{16}$/.test(spanId) || !validNonZero(spanId)) {
    throw new Error('Telemetry ID source returned an invalid W3C identifier');
  }
  return { traceId, spanId, traceFlags: parent?.traceFlags ?? '01', ...(parent?.traceState ? { traceState: parent.traceState } : {}) };
}

export function injectTraceContext(context: DecisionTelemetryContext): Record<string, string> {
  return {
    traceparent: `00-${context.traceId}-${context.spanId}-${context.traceFlags}`,
    ...(context.traceState ? { tracestate: context.traceState.slice(0, 512) } : {}),
  };
}

/** Provider-bound propagation: `traceparent` only, never vendor `tracestate`. */
export function transportTraceContext(context: DecisionTelemetryContext): { traceparent: string } {
  return { traceparent: injectTraceContext(context).traceparent! };
}

export function isTraceparent(value: unknown): value is string {
  return typeof value === 'string' && extractTraceContext({ traceparent: value }) !== null && value === value.trim().toLowerCase();
}

export function extractTraceContext(headers: Record<string, string | undefined>): DecisionTelemetryContext | null {
  const match = TRACEPARENT.exec(headers.traceparent?.trim().toLowerCase() ?? '');
  if (!match || !validNonZero(match[1]!) || !validNonZero(match[2]!)) return null;
  const traceState = headers.tracestate?.trim();
  return {
    traceId: match[1]!, spanId: match[2]!, traceFlags: match[3] as '00' | '01',
    ...(traceState && traceState.length <= 512 ? { traceState } : {}),
  };
}
