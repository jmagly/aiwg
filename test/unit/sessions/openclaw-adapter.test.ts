import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IncrementalSessionImporter,
  OPENCLAW_ADAPTER_VERSION,
  OPENCLAW_SOURCE_SCHEMA_VERSION,
  OpenClawSessionAdapter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  type OpenClawGatewayTransport,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/openclaw');

function selected(
  name: string,
  locatorClass = 'openclaw-consistent-snapshot-jsonl',
): SelectedSource {
  return {
    provider: 'openclaw',
    locator: resolve(fixturesRoot, name),
    locatorClass,
    sourceId: `openclaw-${name}`,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

describe('OpenClaw session adapter', () => {
  const adapter = new OpenClawSessionAdapter();

  it('reports negotiated Gateway, consistent snapshot, and projection capabilities', () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('openclaw', {
      state: 'available',
      evidence: {
        adapterVersion: OPENCLAW_ADAPTER_VERSION,
        sourceSchemaVersion: OPENCLAW_SOURCE_SCHEMA_VERSION,
        verifiedAt: '2026-07-27',
        reference: 'docs/providers/openclaw-sessions.md',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      classification: 'implemented',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['api', 'sqlite-snapshot', 'jsonl'],
    });
  });

  it('preserves schema-16/event-v3 windows, mappings, trees, lineage, identity, and opaque JSON', async () => {
    await expect(adapter.inspect(selected('complete.jsonl'))).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'consistent-snapshot',
      operationalState: 'available',
    });
    const records = await collect(adapter.stream(selected('complete.jsonl')));
    expect(records).toHaveLength(9);
    expect(records[0]).toMatchObject({
      nativeSessionId: 'openclaw-complete',
      kind: 'openclaw.session',
      extensions: {
        workspace: { agentId: 'main', conversationId: 'conversation-synthetic' },
        identity: {
          sessionKey: 'agent:main:synthetic',
          identityKey: 'identity-synthetic',
          stateVersion: 12,
        },
        window: { firstSequence: 1, lastSequence: 8, historyGap: false },
        recovered: true,
        provenance: {
          nativeSchema: '16.0.0',
          eventSchema: '3.0.0',
          snapshotConsistency: 'sqlite-backup',
        },
        sessionUnknownFields: { futureSession: 'preserved' },
        snapshotUnknownFields: { futureSnapshot: 'preserved' },
      },
    });
    expect(records[1]).toMatchObject({
      nativeEventId: 'event-root',
      extensions: {
        eventTree: { parentId: null },
        idempotencyKey: 'idem-root',
        unknownFields: { futureEvent: 'preserved' },
      },
    });
    expect(records.find((record) => record.nativeEventId === 'event-tool'))
      .toMatchObject({ kind: 'tool-result', text: 'Synthetic tool output' });
    expect(records.find((record) => record.nativeEventId === 'event-media'))
      .toMatchObject({ kind: 'media', extensions: { media: { kind: 'image' } } });
    for (const kind of ['fork', 'reset', 'rewind', 'compaction']) {
      expect(records.some((record) => record.kind === `lineage.${kind}`)).toBe(true);
    }
    expect(records.find((record) => record.nativeEventId === 'event-compaction')?.extensions)
      .toMatchObject({ opaqueEventJson: { summaryFormat: 'future-v1' } });
  });

  it('marks active snapshots provisional and retains recovered state', async () => {
    await expect(adapter.inspect(selected('active.jsonl'))).resolves.toMatchObject({
      consistency: 'consistent-snapshot',
      operationalState: 'available',
    });
    const records = await collect(adapter.stream(selected('active.jsonl')));
    expect(records[0].extensions).toMatchObject({
      lifecycle: 'active',
      window: { historyGap: false },
    });
  });

  it('returns explicit incognito and remote-Gateway mismatch states and blocks streaming', async () => {
    await expect(adapter.inspect(selected('incognito.jsonl'))).resolves.toMatchObject({
      operationalState: 'inaccessible',
    });
    await expect(adapter.stream(selected('incognito.jsonl')).next())
      .rejects.toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' });
    await expect(adapter.inspect(selected('remote-mismatch.jsonl'))).resolves.toMatchObject({
      operationalState: 'degraded',
    });
    await expect(adapter.stream(selected('remote-mismatch.jsonl')).next())
      .rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
  });

  it.each([
    ['bounded-history.jsonl', 'openclaw-bounded-history-jsonl', 'bounded-history'],
    ['html.jsonl', 'openclaw-html-projection-jsonl', 'html'],
    ['trajectory.jsonl', 'openclaw-trajectory-jsonl', 'trajectory'],
  ])('reports %s as an incomplete projection', async (name, locatorClass, kind) => {
    await expect(adapter.inspect(selected(name, locatorClass))).resolves.toMatchObject({
      consistency: 'provisional',
      operationalState: 'degraded',
    });
    const records = await collect(adapter.stream(selected(name, locatorClass)));
    expect(records[0].extensions).toMatchObject({
      projection: { kind, complete: false, lossless: false },
    });
  });

  it('rejects raw and unproven SQLite copies', async () => {
    await expect(adapter.inspect(selected('complete.jsonl', 'openclaw-state-db')))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    await expect(adapter.inspect(selected('inconsistent-snapshot.jsonl')))
      .rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  });

  it('requires explicit authorization and a negotiated Gateway transport', async () => {
    const source: SelectedSource = {
      provider: 'openclaw',
      locator: 'http://127.0.0.1:18789/sessions',
      locatorClass: 'openclaw-gateway-api',
      sourceId: 'openclaw-gateway',
      authorizedScope: {
        workspaceId: 'workspace-fixture',
        allowedRoots: [],
        networkOperation: 'openclaw.gateway.sessions.read',
      },
    };
    await expect(adapter.inspect(source)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    const transport: OpenClawGatewayTransport = {
      snapshot: async () => (await readFile(resolve(fixturesRoot, 'complete.jsonl'), 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line)),
    };
    await expect(new OpenClawSessionAdapter(undefined, transport).inspect(source))
      .resolves.toMatchObject({ operationalState: 'available' });
    await expect(new OpenClawSessionAdapter(undefined, transport).inspect({
      ...source,
      authorizedScope: { ...source.authorizedScope, networkOperation: undefined },
    })).rejects.toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' });
  });

  it.each([
    ['unknown-major.jsonl', 'UNKNOWN_SCHEMA_MAJOR'],
    ['unknown-event-major.jsonl', 'UNKNOWN_SCHEMA_MAJOR'],
    ['malformed.jsonl', 'MALFORMED_SOURCE'],
  ])('fails closed for %s with %s', async (name, code) => {
    await expect(adapter.inspect(selected(name))).rejects.toMatchObject({ code });
  });
});

describeWithSqlite('OpenClaw adapter repository conformance', () => {
  it('redacts searchable content and makes identical replay a no-op', async () => {
    const adapter = new OpenClawSessionAdapter();
    const selectedSource = selected('redaction.jsonl');
    const source: SessionSource = {
      contractVersion: SESSION_CONTRACT_VERSION,
      sourceId: selectedSource.sourceId,
      provider: 'openclaw',
      providerProfile: 'schema-16-event-v3-consistent-snapshot',
      locatorClass: selectedSource.locatorClass,
      redactedLocator: '<session-source>/redaction.jsonl',
      adapterVersion: OPENCLAW_ADAPTER_VERSION,
      sourceSchemaVersion: OPENCLAW_SOURCE_SCHEMA_VERSION,
      disposition: 'implemented',
      operationalState: 'available',
      consistency: 'consistent-snapshot',
      authorizedAt: '2026-07-27T00:00:00.000Z',
      extensions: { 'native.openclaw': {} },
    };
    const repository = new SessionRepository();
    const importer = new IncrementalSessionImporter(repository);
    const request = {
      source, selectedSource, adapter, workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
    };
    expect((await importer.import(request))
      .reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(2);
    const stored = JSON.stringify(repository.authorizedSearchDocuments({
      workspaceId: 'workspace-fixture', limit: 10,
    }));
    expect(stored).not.toContain('redaction-canary-789');
    expect(stored).not.toContain('openclaw-synthetic@example.test');
    expect(await importer.import(request)).toEqual([]);
    repository.close();
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of iterable) result.push(value);
  return result;
}
