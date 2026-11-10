// Shared event normalization, image extraction, redaction, and lifecycle derivation.
import {
  SESSION_CONTRACT_VERSION, SessionEventSchema, SessionSchema, sha256, stableEventId, stableSessionId,
  type ProviderRecord, type Session, type SessionEvent,
} from './contracts.js';
import type { ImportRequest } from './importer.js';
import { redactSessionValue, sanitizeSessionEvent, sanitizeNativeExtensions } from './policy.js';
import { extractEventImages, type ExtractedSessionImage } from './image-blobs.js';
import { DEFAULT_INACTIVITY_THRESHOLD_MS } from './lifecycle.js';
import { classifySessionEventOrigin, deriveSessionIntent } from './origin.js';

export function normalizeSessionBatch(
  request: ImportRequest,
  records: ProviderRecord[],
  digests: string[],
  importRunId: string,
  sourceObservedAt?: string,
): { sessions: Session[]; events: SessionEvent[]; imageBlobs: ExtractedSessionImage[] } {
  const sessions = new Map<string, Session>();
  // Extract inline images before sanitization: provider image blocks in
  // extensions are redacted to markers below, so bytes must be lifted out
  // first while the raw record is still intact (#3265).
  const imageBlobs = new Map<string, ExtractedSessionImage>();
  const events = records.map((record, index): SessionEvent => {
    const sessionId = stableSessionId(request.source.provider, request.source.sourceId, record.nativeSessionId);
    const native = sanitizeNativeExtensions(record.extensions ?? {});
    const lineage = ['codex', 'grok-build'].includes(request.source.provider) && native.value.lineage
      ? { lineage: native.value.lineage } : {};
    const images = extractEventImages({
      searchableText: record.text,
      extensions: record.extensions,
      rawReference: record.rawReference,
    });
    for (const image of images.images) {
      if (!imageBlobs.has(image.digest)) imageBlobs.set(image.digest, image);
    }
    const digest = digests[index];
    const origin = classifySessionEventOrigin(request.source.provider, record);
    const lifecycle = sessionLifecycle(request, record, sourceObservedAt);
    const lifecycleEvidence = sessionLifecycleEvidence(request, record, sourceObservedAt);
    const extensions = {
      [`native.${request.source.provider}`]: images.extensions,
    };
    const event = sanitizeSessionEvent(SessionEventSchema.parse({
      contractVersion: SESSION_CONTRACT_VERSION,
      eventId: stableEventId(request.source.provider, request.source.sourceId, record, digest),
      sessionId, sourceId: request.source.sourceId, importRunId,
      nativeId: record.nativeEventId ?? null, sequence: record.sequence,
      kind: record.kind, role: record.role ?? null, occurredAt: record.occurredAt ?? null,
      activityBoundary: record.activityBoundary ?? null,
      activityBoundaryBasis: record.activityBoundaryBasis ?? null,
      activityBoundaryConfidence: record.activityBoundaryConfidence ?? null,
      origin: origin.origin,
      originRule: origin.rule,
      originClassifierVersion: origin.classifierVersion,
      participant: record.participant ?? null,
      toolName: record.toolName ?? null,
      toolCallId: record.toolCallId ?? null,
      model: record.model ?? null,
      entities: record.entities ?? [],
      extractionState: record.extractionState ?? null,
      searchableText: images.searchableText, imageRefs: images.imageRefs,
      digest, rawReference: record.rawReference,
      adapterVersion: request.adapter.adapterVersion,
      consistency: request.source.consistency,
      sensitivity: { classification: 'none', classes: [] },
      opaque: !isKnownEventKind(record.kind),
      extensions,
    }));
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, SessionSchema.parse({
        contractVersion: SESSION_CONTRACT_VERSION,
        sessionId, sourceId: request.source.sourceId, provider: request.source.provider,
        nativeSessionId: record.nativeSessionId, workspaceId: request.workspaceId,
        startedAt: record.occurredAt ?? null, updatedAt: record.occurredAt ?? null,
        consistency: request.source.consistency,
        lifecycle,
        sourceDigest: sha256(`${sourceGenerationDigest(request)}\0${record.nativeSessionId}`),
        extensions: {
          [`native.${request.source.provider}`]: {
            ...lineage,
            lifecycleEvidence,
          },
        },
      }));
    } else {
      const session = sessions.get(sessionId)!;
      session.startedAt = earlierTimestamp(session.startedAt, record.occurredAt ?? null);
      session.updatedAt = laterTimestamp(session.updatedAt, record.occurredAt ?? null);
      session.consistency = strongerConsistency(session.consistency, request.source.consistency);
      const nativeKey = `native.${request.source.provider}`;
      const nativeEnvelope = session.extensions[nativeKey];
      const nativeRecord = nativeEnvelope && typeof nativeEnvelope === 'object' && !Array.isArray(nativeEnvelope)
        ? nativeEnvelope as Record<string, unknown>
        : {};
      const selected = selectLifecycleTransition(
        session.lifecycle,
        nativeRecord.lifecycleEvidence,
        lifecycle,
        lifecycleEvidence,
      );
      session.lifecycle = selected.lifecycle;
      session.extensions[nativeKey] = {
        ...nativeRecord,
        ...lineage,
        lifecycleEvidence: selected.evidence,
      };
    }
    return event;
  });
  for (const session of sessions.values()) {
    session.intent = deriveSessionIntent(
      events.filter((event) => event.sessionId === session.sessionId),
    );
  }
  return {
    sessions: redactSessionValue([...sessions.values()]).value,
    events,
    imageBlobs: [...imageBlobs.values()],
  };
}

const KNOWN_EVENT_KINDS = new Set(['message', 'tool-call', 'tool-result', 'artifact', 'attachment', 'summary']);

function isKnownEventKind(kind: string): boolean {
  const normalized = kind.toLowerCase();
  return KNOWN_EVENT_KINDS.has(normalized)
    || /^(?:tool-call|tool-result)(?:[._-]|$)/.test(normalized)
    || /^(?:sandbox|permission|approval|hitl|human|lifecycle)(?:[._-]|$)/.test(normalized);
}

function earlierTimestamp(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function laterTimestamp(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function strongerConsistency(
  left: Session['consistency'],
  right: Session['consistency'],
): Session['consistency'] {
  const rank: Record<Session['consistency'], number> = {
    provisional: 0,
    'consistent-snapshot': 1,
    complete: 2,
  };
  return rank[left] >= rank[right] ? left : right;
}

function sessionLifecycle(
  request: ImportRequest,
  record: ProviderRecord,
  sourceObservedAt?: string,
): Session['lifecycle'] {
  const explicit = nativeLifecycle(record.extensions);
  if (explicit) return explicit;
  if (request.source.consistency === 'complete') return 'complete';
  const observedAt = record.occurredAt ?? sourceObservedAt;
  if (observedAt && isStaleHistoricalTimestamp(
    observedAt,
    inactivityThresholdMs(request),
  )) return 'inactive';
  return 'active';
}

function sessionLifecycleEvidence(
  request: ImportRequest,
  record: ProviderRecord,
  sourceObservedAt?: string,
): Record<string, unknown> {
  const observedAt = record.occurredAt ?? sourceObservedAt;
  const explicit = nativeLifecycle(record.extensions);
  if (explicit) {
    return {
      basis: 'provider-explicit-event',
      state: explicit,
      observedAt: observedAt ?? request.source.authorizedAt,
      confidence: 'high',
    };
  }
  if (request.source.consistency === 'complete') {
    return {
      basis: 'complete-source',
      state: 'complete',
      observedAt: observedAt ?? request.source.authorizedAt,
      confidence: 'high',
    };
  }
  const thresholdMs = inactivityThresholdMs(request);
  if (observedAt && isStaleHistoricalTimestamp(observedAt, thresholdMs)) {
    return {
      basis: 'inactivity-threshold',
      state: 'inactive',
      observedAt,
      confidence: 'medium',
      thresholdMs,
    };
  }
  return {
    basis: 'open-provisional-source',
    state: 'active',
    observedAt: observedAt ?? request.source.authorizedAt,
    confidence: 'provisional',
    thresholdMs,
  };
}

function nativeLifecycle(extensions?: Record<string, unknown>): Session['lifecycle'] | null {
  const raw = typeof extensions?.lifecycle === 'string' ? extensions.lifecycle : undefined;
  if (!raw) return null;
  const normalized: Record<string, Session['lifecycle']> = {
    active: 'active',
    inactive: 'inactive',
    paused: 'paused',
    complete: 'complete',
    completed: 'complete',
    archived: 'archived',
    deleted: 'tombstoned',
    cancelled: 'interrupted',
    canceled: 'interrupted',
    failed: 'interrupted',
    interrupted: 'interrupted',
    unknown: 'unknown',
    'unknown-at-import': 'unknown',
    'completed-at-import': 'complete',
  };
  return normalized[raw] ?? null;
}

function selectLifecycleTransition(
  leftLifecycle: Session['lifecycle'],
  left: unknown,
  rightLifecycle: Session['lifecycle'],
  right: Record<string, unknown>,
): { lifecycle: Session['lifecycle']; evidence: Record<string, unknown> } {
  const leftEvidence = asLifecycleEvidence(left);
  if (leftLifecycle === 'tombstoned') {
    return { lifecycle: leftLifecycle, evidence: leftEvidence ?? right };
  }
  if (!leftEvidence) return { lifecycle: rightLifecycle, evidence: right };
  const rank: Record<string, number> = {
    'open-provisional-source': 1,
    'inactivity-threshold': 1,
    'complete-source': 2,
    'provider-explicit-event': 3,
  };
  const leftRank = rank[String(leftEvidence.basis)] ?? 0;
  const rightRank = rank[String(right.basis)] ?? 0;
  const rightIsNewer = evidenceTimestamp(right) > evidenceTimestamp(leftEvidence);
  return rightRank > leftRank || (rightRank === leftRank && rightIsNewer)
    ? { lifecycle: rightLifecycle, evidence: right }
    : { lifecycle: leftLifecycle, evidence: leftEvidence };
}

function asLifecycleEvidence(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function evidenceTimestamp(value: Record<string, unknown>): number {
  const parsed = Date.parse(String(value.observedAt ?? ''));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function inactivityThresholdMs(request: ImportRequest): number {
  return request.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS;
}

function isStaleHistoricalTimestamp(value: string, thresholdMs: number): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && Date.now() - timestamp > thresholdMs;
}

export function sourceGenerationDigest(request: ImportRequest): string {
  return sha256([
    request.source.sourceId,
    request.source.provider,
    request.selectedSource.locatorClass,
    request.source.sourceSchemaVersion,
    request.adapter.adapterVersion,
  ].join('\0'));
}

