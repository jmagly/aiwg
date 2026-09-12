import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import {
  IncrementalSessionImporter,
  SessionEventSchema,
  SessionRepository,
  SessionSchema,
  SessionSourceSchema,
  classifySessionEventOrigin,
  deriveSessionTimeline,
  parseTimelineGap,
  type ProviderRecord,
  type SessionSourceAdapter,
  type TimelineInput,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

describeWithSqlite('session event origin and intent', () => {
  it('classifies known provider envelopes conservatively without reattributing ambiguity', () => {
    expect(classify('codex', {
      kind: 'message',
      role: 'user',
      text: '<codex_internal_context>provider state</codex_internal_context>',
    })).toMatchObject({ origin: 'provider-bootstrap', rule: 'envelope:codex_internal_context' });
    expect(classify('claude', {
      kind: 'message',
      role: 'user',
      text: '# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>\nRead context.\n</INSTRUCTIONS>',
    })).toMatchObject({ origin: 'workspace-instruction' });
    expect(classify('cursor', {
      kind: 'message',
      role: 'user',
      text: '<unrecognized_context>uncertain</unrecognized_context>',
    })).toMatchObject({ origin: 'unknown' });
    expect(classify('factory', {
      kind: 'factory.session_start',
      role: 'system',
      text: '',
    })).toMatchObject({ origin: 'provider-bootstrap' });
    expect(classify('claude', {
      kind: 'message',
      role: 'user',
      text: 'Please inspect the implementation.',
    })).toMatchObject({ origin: 'user-authored' });
  });

  it('selects the first real request and supports explicit control-event search modes', async () => {
    const repository = new SessionRepository(':memory:');
    const source = SessionSourceSchema.parse({
      contractVersion: '1.0.0',
      sourceId: 'origin-source',
      provider: 'codex',
      providerProfile: 'fixture',
      locatorClass: 'fixture-jsonl',
      redactedLocator: '<session-source>/fixture.jsonl',
      adapterVersion: '1.0.0',
      sourceSchemaVersion: '1.0.0',
      disposition: 'implemented',
      operationalState: 'available',
      consistency: 'complete',
      authorizedAt: '2026-07-28T00:00:00.000Z',
      extensions: { 'native.codex': {} },
    });
    const records: ProviderRecord[] = [
      record(0, '<recommended_plugins>bootstrapcanary</recommended_plugins>', 'user'),
      record(1, 'actualrequestcanary', 'user'),
      record(2, 'assistantresponsecanary', 'assistant'),
    ];
    const adapter: SessionSourceAdapter = {
      provider: 'codex',
      adapterVersion: '1.0.0',
      disposition: 'implemented',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['jsonl'],
      async *discover() {},
      async inspect() {
        return {
          sourceSchemaVersion: '1.0.0',
          consistency: 'complete',
          operationalState: 'available',
        };
      },
      async *stream() {
        for (const item of records) yield item;
      },
    };
    try {
      const locator = resolve('test/fixtures/sessions/generic/valid-v1.jsonl');
      await new IncrementalSessionImporter(repository).import({
        source,
        selectedSource: {
          provider: 'codex',
          locator,
          locatorClass: 'fixture-jsonl',
          sourceId: source.sourceId,
          authorizedScope: {
            workspaceId: 'origin-workspace',
            allowedRoots: [dirname(locator)],
          },
        },
        adapter,
        workspaceId: 'origin-workspace',
        policyVersion: '1.0.0',
      });
      const session = repository.listSessions({
        workspaceId: 'origin-workspace',
        limit: 10,
      }).items[0];
      expect(session.intent).toMatchObject({
        status: 'selected',
        title: 'actualrequestcanary',
        summary: 'actualrequestcanary',
      });
      expect(repository.listEvents(session.sessionId, 'origin-workspace').map(
        (event) => event.origin,
      )).toEqual(['provider-bootstrap', 'user-authored', 'assistant-generated']);
      expect(repository.search({
        query: 'bootstrapcanary',
        workspaceId: 'origin-workspace',
        limit: 10,
      }).items).toEqual([]);
      expect(repository.search({
        query: 'bootstrapcanary',
        workspaceId: 'origin-workspace',
        controlEvents: 'include',
        limit: 10,
      }).items[0]).toMatchObject({ origin: 'provider-bootstrap' });
      expect(repository.search({
        query: 'actualrequestcanary OR bootstrapcanary',
        workspaceId: 'origin-workspace',
        controlEvents: 'only',
        limit: 10,
      }).items).toHaveLength(1);
    } finally {
      repository.close();
    }
  });
});

describe('session activity timeline', () => {
  it('uses explicit boundaries before gaps and sorts offsets and identical timestamps deterministically', () => {
    const input = [
      timelineInput('session-b', 'codex', 0, '2026-07-27T08:00:00-04:00'),
      timelineInput('session-a', 'claude', 2, '2026-07-27T12:00:00.000Z'),
      timelineInput('session-a', 'claude', 1, '2026-07-27T08:00:00-04:00'),
      timelineInput('session-a', 'claude', 3, '2026-07-27T12:05:00.000Z', 'resume'),
      timelineInput('session-a', 'claude', 4, '2026-07-27T13:00:00.000Z'),
    ];
    expect(deriveSessionTimeline(input, parseTimelineGap('30m'))).toMatchObject([
      {
        provider: 'claude',
        sessionId: 'session-a',
        segmentIndex: 0,
        startAt: '2026-07-27T08:00:00-04:00',
        endAt: '2026-07-27T12:00:00.000Z',
        durationMs: 0,
        eventCount: 2,
        boundaryBasis: 'session-start',
      },
      {
        provider: 'codex',
        sessionId: 'session-b',
        segmentIndex: 0,
      },
      {
        provider: 'claude',
        sessionId: 'session-a',
        segmentIndex: 1,
        boundaryBasis: 'provider-explicit',
        confidence: 'high',
      },
      {
        provider: 'claude',
        sessionId: 'session-a',
        segmentIndex: 2,
        boundaryBasis: 'inferred-gap',
        confidence: 'medium',
      },
    ]);
  });

  it('re-derives late arrivals and remains stable under backward source sequence', () => {
    const first = [
      timelineInput('session', 'factory', 2, '2026-07-27T10:00:00.000Z'),
      timelineInput('session', 'factory', 1, '2026-07-27T10:10:00.000Z'),
      timelineInput('session', 'factory', 3, '2026-07-27T11:00:00.000Z'),
    ];
    expect(deriveSessionTimeline(first, parseTimelineGap('30m'))).toHaveLength(2);
    const late = [
      ...first,
      timelineInput('session', 'factory', 4, '2026-07-27T10:40:00.000Z'),
    ];
    const derived = deriveSessionTimeline(late, parseTimelineGap('30m'));
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({
      startAt: '2026-07-27T10:00:00.000Z',
      endAt: '2026-07-27T11:00:00.000Z',
      durationMs: 3_600_000,
      eventCount: 4,
    });
  });
});

function classify(
  provider: 'claude' | 'codex' | 'cursor' | 'factory',
  input: Pick<ProviderRecord, 'kind' | 'role' | 'text'>,
) {
  return classifySessionEventOrigin(provider, {
    nativeSessionId: 'session',
    nativeEventId: 'event',
    sequence: 0,
    rawReference: { locatorClass: 'fixture', sequence: 0 },
    ...input,
  });
}

function record(sequence: number, text: string, role: string): ProviderRecord {
  return {
    nativeSessionId: 'origin-session',
    nativeEventId: `event-${sequence}`,
    sequence,
    kind: 'message',
    role,
    occurredAt: `2026-07-28T00:00:0${sequence}.000Z`,
    text,
    rawReference: { locatorClass: 'fixture-jsonl', sequence },
  };
}

function timelineInput(
  sessionId: string,
  provider: 'claude' | 'codex' | 'factory',
  sequence: number,
  occurredAt: string,
  boundary?: 'resume',
): TimelineInput {
  const session = SessionSchema.parse({
    contractVersion: '1.0.0',
    sessionId,
    sourceId: `${provider}-source`,
    provider,
    nativeSessionId: sessionId,
    workspaceId: 'timeline-workspace',
    startedAt: occurredAt,
    updatedAt: occurredAt,
    consistency: 'complete',
    lifecycle: 'complete',
    sourceDigest: `sha256:${'a'.repeat(64)}`,
    extensions: { [`native.${provider}`]: {} },
  });
  const event = SessionEventSchema.parse({
    contractVersion: '1.0.0',
    eventId: `${sessionId}-${sequence}`,
    sessionId,
    sourceId: session.sourceId,
    importRunId: 'run',
    nativeId: `native-${sequence}`,
    sequence,
    kind: 'message',
    role: 'user',
    occurredAt,
    activityBoundary: boundary ?? null,
    activityBoundaryBasis: boundary ? `${provider}:resume` : null,
    activityBoundaryConfidence: boundary ? 'high' : null,
    searchableText: 'synthetic',
    digest: `sha256:${String(sequence).padStart(64, '0')}`,
    rawReference: { locatorClass: 'fixture', sequence },
    adapterVersion: '1.0.0',
    consistency: 'complete',
    sensitivity: { classification: 'none', classes: [] },
    extensions: { [`native.${provider}`]: {} },
  });
  return { session, event };
}
