import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HERMES_ADAPTER_VERSION,
  HERMES_EXPORT_SCHEMA_VERSION,
  HermesSessionAdapter,
  IncrementalSessionImporter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  type HermesLocalSessionsTransport,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/hermes');

function selected(
  name: string,
  locatorClass = 'hermes-export-jsonl',
): SelectedSource {
  return {
    provider: 'hermes',
    locator: resolve(fixturesRoot, name),
    locatorClass,
    sourceId: `hermes-${name}`,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

describe('Hermes session adapter', () => {
  const adapter = new HermesSessionAdapter();

  it('reports native export, negotiated local API, and consistent snapshot capabilities', () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('hermes', {
      state: 'available',
      evidence: {
        adapterVersion: HERMES_ADAPTER_VERSION,
        sourceSchemaVersion: HERMES_EXPORT_SCHEMA_VERSION,
        verifiedAt: '2026-07-27',
        reference: 'docs/providers/hermes-sessions.md',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      classification: 'implemented',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['jsonl', 'api', 'sqlite-snapshot'],
    });
  });

  it('preserves schema-23 lineage, workspace, routing, usage, cost, reasoning, tools, and opaque content', async () => {
    await expect(adapter.inspect(selected('complete.jsonl'))).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'complete',
      operationalState: 'available',
    });
    const records = await collect(adapter.stream(selected('complete.jsonl')));
    expect(records).toHaveLength(5);
    expect(records[0]).toMatchObject({
      nativeSessionId: 'hermes-ended',
      kind: 'hermes.session',
      extensions: {
        lifecycle: 'complete',
        lineage: {
          parentSessionId: 'hermes-parent',
          compressedFromSessionId: 'hermes-compressed',
        },
        workspace: {
          gitBranch: 'feature/synthetic',
          routingKey: 'agent:main:cli:synthetic',
          source: 'cli',
        },
        usage: {
          inputTokens: 100,
          reasoningTokens: 10,
          actualCostUsd: 0.1,
        },
        sessionUnknownFields: { futureSession: 'preserved' },
      },
    });
    expect(records[1].extensions).toMatchObject({
      unknownFields: { futureMessage: 'preserved' },
    });
    expect(records[2].extensions).toMatchObject({
      reasoning: {
        text: 'Synthetic reasoning',
        content: 'Reasoning content',
        details: { future: 'preserved' },
      },
    });
    expect(records[3]).toMatchObject({
      nativeEventId: 'tool-1',
      kind: 'tool-call',
      text: 'session_search',
    });
    expect(records[4]).toMatchObject({
      kind: 'tool-result',
      text: 'opaque tool output',
      extensions: { opaqueContent: true },
    });
  });

  it('marks active exports provisional and keeps archive, export deletion, and provider deletion distinct', async () => {
    await expect(adapter.inspect(selected('active.jsonl'))).resolves.toMatchObject({
      consistency: 'provisional',
    });
    const archived = await collect(adapter.stream(selected('archived.jsonl')));
    expect(archived[0].extensions).toMatchObject({
      lifecycle: 'archived',
      deletion: {
        exportDeletedAt: expect.any(String),
        providerDeletedAt: undefined,
        archivePreservesProviderData: true,
        compactionPreservesLineage: true,
      },
    });
  });

  it('accepts sqlite3.backup snapshots and rejects raw or unproven WAL copies', async () => {
    await expect(adapter.inspect(selected(
      'snapshot.jsonl',
      'hermes-consistent-snapshot-jsonl',
    ))).resolves.toMatchObject({ consistency: 'complete' });
    await expect(adapter.inspect(selected(
      'inconsistent-snapshot.jsonl',
      'hermes-consistent-snapshot-jsonl',
    ))).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
    await expect(adapter.inspect(selected(
      'snapshot.jsonl',
      'hermes-state-db',
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('negotiates the local API and requires explicit operation authorization', async () => {
    const source: SelectedSource = {
      provider: 'hermes',
      locator: 'http://127.0.0.1/sessions',
      locatorClass: 'hermes-local-api',
      sourceId: 'hermes-local-api',
      authorizedScope: {
        workspaceId: 'workspace-fixture',
        allowedRoots: [],
        networkOperation: 'hermes.local.sessions.read',
      },
    };
    await expect(adapter.inspect(source)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    const transport: HermesLocalSessionsTransport = {
      snapshot: async () => [{
        schemaVersion: 23, id: 'api-session', source: 'gateway',
        started_at: 1785150000, ended_at: 1785150100, messages: [],
      }],
    };
    await expect(new HermesSessionAdapter(undefined, transport).inspect(source))
      .resolves.toMatchObject({ consistency: 'complete' });
    await expect(new HermesSessionAdapter(undefined, transport).inspect({
      ...source,
      authorizedScope: { ...source.authorizedScope, networkOperation: undefined },
    })).rejects.toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' });
  });

  it.each([
    ['unknown-major.jsonl', 'UNKNOWN_SCHEMA_MAJOR'],
    ['malformed.jsonl', 'MALFORMED_SOURCE'],
  ])('fails closed for %s with %s', async (name, code) => {
    await expect(adapter.inspect(selected(name))).rejects.toMatchObject({ code });
  });
});

describeWithSqlite('Hermes adapter repository conformance', () => {
  it('redacts searchable content and makes identical replay a no-op', async () => {
    const adapter = new HermesSessionAdapter();
    const selectedSource = selected('redaction.jsonl');
    const source: SessionSource = {
      contractVersion: SESSION_CONTRACT_VERSION,
      sourceId: selectedSource.sourceId,
      provider: 'hermes',
      providerProfile: 'native-schema-23-export',
      locatorClass: selectedSource.locatorClass,
      redactedLocator: '<session-source>/redaction.jsonl',
      adapterVersion: HERMES_ADAPTER_VERSION,
      sourceSchemaVersion: HERMES_EXPORT_SCHEMA_VERSION,
      disposition: 'implemented',
      operationalState: 'available',
      consistency: 'complete',
      authorizedAt: '2026-07-27T00:00:00.000Z',
      extensions: { 'native.hermes': {} },
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
    expect(stored).not.toContain('redaction-canary-123');
    expect(stored).not.toContain('synthetic@example.test');
    expect(await importer.import(request)).toEqual([]);
    repository.close();
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of iterable) result.push(value);
  return result;
}
