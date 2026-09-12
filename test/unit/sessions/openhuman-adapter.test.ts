import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IncrementalSessionImporter,
  OPENHUMAN_ADAPTER_VERSION,
  OPENHUMAN_SOURCE_SCHEMA_VERSION,
  OpenHumanSessionAdapter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/openhuman');

function selected(name: string, locatorClass = 'openhuman-enriched-jsonl'): SelectedSource {
  return {
    provider: 'openhuman',
    locator: resolve(fixturesRoot, name),
    locatorClass,
    sourceId: `openhuman-${name}`,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

describe('OpenHuman session adapter', () => {
  const adapter = new OpenHumanSessionAdapter();

  it('reports explicit full-fidelity JSONL acquisition', () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('openhuman', {
      state: 'available',
      evidence: {
        adapterVersion: OPENHUMAN_ADAPTER_VERSION,
        sourceSchemaVersion: OPENHUMAN_SOURCE_SCHEMA_VERSION,
        verifiedAt: '2026-07-27',
        reference: 'docs/providers/openhuman-sessions.md',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      classification: 'implemented',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['jsonl'],
    });
  });

  it('joins thread and turn enrichment while preserving repeated metadata and unknown fields', async () => {
    await expect(adapter.inspect(selected('complete.jsonl'))).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'complete',
      operationalState: 'available',
    });
    const records = await collect(adapter.stream(selected('complete.jsonl')));
    expect(records).toHaveLength(9);
    expect(records[0]).toMatchObject({
      nativeSessionId: 'openhuman-complete',
      nativeEventId: 'event-user',
      extensions: {
        relationship: { threadId: 'thread-synthetic', requestId: 'request-1' },
        repeatedMetadata: {
          provider: 'provider-a',
          model: 'model-a',
          profile: 'profile-a',
          futureMetadata: 'preserved',
        },
        usage: { inputTokens: 10, cachedInputTokens: 4, chargedAmountUsd: 0.01 },
        interruption: { turnState: 'completed' },
        thread: { title: 'Synthetic thread', state: 'deleted' },
        provenance: { rawTranscriptAuthoritative: true, enrichmentJoined: true },
        unknownFields: { futureEvent: 'preserved' },
        threadUnknownFields: { futureThread: 'preserved' },
        turnUnknownFields: { futureTurn: 'preserved' },
      },
    });
    expect(records.find((record) => record.nativeEventId === 'event-assistant')?.extensions)
      .toMatchObject({ repeatedMetadata: { provider: 'provider-b', model: 'model-b', profile: 'profile-b' } });
    expect(records.find((record) => record.nativeEventId === 'event-nested')?.extensions)
      .toMatchObject({ repeatedMetadata: { nestedAgentId: 'agent-child', parentAgentId: 'agent-main' } });
    expect(records.find((record) => record.nativeEventId === 'event-tool-failure'))
      .toMatchObject({ kind: 'tool-result', extensions: { tool: { status: 'failed' } } });
    expect(records.find((record) => record.nativeEventId === 'event-compaction'))
      .toMatchObject({ kind: 'compaction', extensions: { compaction: { compacted: true } } });
    expect(records.find((record) => record.nativeEventId === 'event-interruption')?.extensions)
      .toMatchObject({ interruption: { interrupted: true, turnState: 'interrupted' } });
  });

  it('keeps present and expired attachment placeholders distinct', async () => {
    const records = await collect(adapter.stream(selected('complete.jsonl')));
    expect(records.find((record) => record.nativeEventId === 'event-present-attachment')?.extensions)
      .toMatchObject({ attachment: { state: 'present', uriPresent: true, expiredAt: undefined } });
    expect(records.find((record) => record.nativeEventId === 'event-expired-attachment')?.extensions)
      .toMatchObject({ attachment: { state: 'expired', uriPresent: false, expiredAt: expect.any(String) } });
  });

  it('proves thread deletion does not imply raw-transcript deletion', async () => {
    const records = await collect(adapter.stream(selected('raw-after-thread-delete.jsonl')));
    expect(records[0]).toMatchObject({
      text: 'Raw transcript retained',
      extensions: {
        lifecycle: 'complete',
        deletion: {
          threadDeletedAt: expect.any(String),
          rawTranscriptDeletedAt: undefined,
          threadDeletionDoesNotImplyRawDeletion: true,
        },
      },
    });
  });

  it('marks active append-only transcripts provisional', async () => {
    await expect(adapter.inspect(selected('active.jsonl', 'openhuman-session-raw-jsonl')))
      .resolves.toMatchObject({ consistency: 'provisional' });
  });

  it.each([
    ['unknown-major.jsonl', 'UNKNOWN_SCHEMA_MAJOR'],
    ['malformed.jsonl', 'MALFORMED_SOURCE'],
    ['mixed-schema.jsonl', 'SCHEMA_DRIFT'],
  ])('fails closed for %s with %s', async (name, code) => {
    await expect(adapter.inspect(selected(name))).rejects.toMatchObject({ code });
  });
});

describeWithSqlite('OpenHuman adapter repository conformance', () => {
  it('redacts searchable content and makes identical replay a no-op', async () => {
    const adapter = new OpenHumanSessionAdapter();
    const selectedSource = selected('redaction.jsonl', 'openhuman-session-raw-jsonl');
    const source: SessionSource = {
      contractVersion: SESSION_CONTRACT_VERSION,
      sourceId: selectedSource.sourceId,
      provider: 'openhuman',
      providerProfile: 'schema-1-session-raw',
      locatorClass: selectedSource.locatorClass,
      redactedLocator: '<session-source>/redaction.jsonl',
      adapterVersion: OPENHUMAN_ADAPTER_VERSION,
      sourceSchemaVersion: OPENHUMAN_SOURCE_SCHEMA_VERSION,
      disposition: 'implemented',
      operationalState: 'available',
      consistency: 'complete',
      authorizedAt: '2026-07-27T00:00:00.000Z',
      extensions: { 'native.openhuman': {} },
    };
    const repository = new SessionRepository();
    const importer = new IncrementalSessionImporter(repository);
    const request = {
      source, selectedSource, adapter, workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
    };
    expect((await importer.import(request))
      .reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(1);
    const stored = JSON.stringify(repository.authorizedSearchDocuments({
      workspaceId: 'workspace-fixture', limit: 10,
    }));
    expect(stored).not.toContain('redaction-canary-101');
    expect(stored).not.toContain('openhuman-synthetic@example.test');
    expect(await importer.import(request)).toEqual([]);
    repository.close();
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of iterable) result.push(value);
  return result;
}
