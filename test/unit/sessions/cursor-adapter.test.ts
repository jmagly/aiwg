import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CURSOR_ADAPTER_VERSION,
  CURSOR_SOURCE_SCHEMA_VERSION,
  CursorSessionAdapter,
  IncrementalSessionImporter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/cursor');

function selected(name: string, locatorClass?: string): SelectedSource {
  return {
    provider: 'cursor',
    locator: resolve(fixturesRoot, name),
    locatorClass: locatorClass ?? (name.endsWith('.md')
      ? 'cursor-editor-markdown'
      : name.endsWith('.cloud.jsonl')
        ? 'cursor-cloud-events-jsonl'
        : 'cursor-cli-stream-json'),
    sourceId: `cursor-${name}`,
    authorizedScope: {
      workspaceId: 'workspace-fixture',
      allowedRoots: [fixturesRoot],
    },
  };
}

describe('Cursor session adapter', () => {
  const adapter = new CursorSessionAdapter();

  it('discovers authorized agent transcripts and excludes editor SQLite discovery', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('cursor', {
      state: 'available',
      evidence: {
        adapterVersion: CURSOR_ADAPTER_VERSION,
        sourceSchemaVersion: CURSOR_SOURCE_SCHEMA_VERSION,
        verifiedAt: '2026-07-27',
        reference: 'docs/providers/cursor-sessions.md',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      classification: 'implemented',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['api', 'jsonl', 'manual-export'],
    });
    expect(await collect(adapter.discover({
      workspaceId: 'workspace-fixture',
      allowedRoots: [resolve(fixturesRoot, 'agent-transcripts')],
    }))).toEqual([{
      provider: 'cursor',
      locator: resolve(
        fixturesRoot,
        'agent-transcripts',
        'agent-session',
        'agent-session.jsonl',
      ),
      locatorClass: 'cursor-agent-transcript-jsonl',
    }]);
    await expect(adapter.inspect(selected(
      'editor-export.md',
      'cursor-editor-sqlite',
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('normalizes CLI messages, tool calls/results, cwd, model, permissions, and IDs', async () => {
    await expect(adapter.inspect(selected('cli-complete.jsonl'))).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'complete',
      operationalState: 'available',
    });
    const records = await collect(adapter.stream(selected('cli-complete.jsonl')));
    expect(records).toHaveLength(6);
    expect(records[0]).toMatchObject({
      nativeSessionId: 'cursor-cli-session',
      kind: 'system',
      extensions: {
        cwd: '/synthetic/workspace',
        model: 'Synthetic Model',
        permissionMode: 'default',
        unknownFields: { apiKeySource: 'login', futureSystemField: 'preserved' },
      },
    });
    expect(records[3]).toMatchObject({
      nativeEventId: 'synthetic-call',
      kind: 'tool.started',
      extensions: { toolCall: { readToolCall: { args: { path: 'fixture.txt' } } } },
    });
    expect(records[4].extensions).toMatchObject({
      toolCall: { readToolCall: { result: { success: { content: 'synthetic' } } } },
    });
  });

  it('marks an active CLI stream provisional and exposes the reported product version', async () => {
    await expect(adapter.inspect(selected('cli-active.jsonl'))).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'provisional',
      operationalState: 'available',
    });
    const records = await collect(adapter.stream(selected('cli-active.jsonl')));
    expect(records[0].extensions).toMatchObject({
      productVersion: '2026.07-synthetic',
    });
    expect(records[0].extensions).not.toHaveProperty('lifecycle');
  });

  it('preserves Cloud Agent status, reconnect, cancellation, archive, restore, and deletion', async () => {
    await expect(adapter.inspect(selected('cloud-lifecycle.cloud.jsonl'))).resolves.toMatchObject({
      consistency: 'complete',
    });
    const records = await collect(adapter.stream(selected('cloud-lifecycle.cloud.jsonl')));
    expect(records).toHaveLength(6);
    expect(records[0]).toMatchObject({
      nativeSessionId: 'agent-synthetic:run-synthetic',
      extensions: {
        agent: { futureAgentField: 'preserved' },
        reconnect: { eventId: 'evt-1', supported: true, header: 'Last-Event-ID' },
      },
    });
    expect(records.map((record) => record.extensions?.lifecycle)).toEqual([
      undefined, undefined, 'cancelled', 'archived', 'active', 'deleted',
    ]);
    expect(records[5].extensions).toMatchObject({
      unknownFields: { futureCloudField: 'preserved' },
    });
  });

  it('normalizes project-scoped agent-transcripts JSONL separately from CLI streams', async () => {
    await expect(adapter.inspect(selected(
      'agent-transcripts/agent-session/agent-session.jsonl',
      'cursor-agent-transcript-jsonl',
    ))).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'provisional',
      operationalState: 'available',
    });
    const records = await collect(adapter.stream(selected(
      'agent-transcripts/agent-session/agent-session.jsonl',
      'cursor-agent-transcript-jsonl',
    )));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      nativeSessionId: 'agent-session',
      nativeEventId: 'user:0',
      kind: 'message',
      role: 'user',
      text: 'Synthetic Cursor agent transcript prompt.',
      rawReference: { locatorClass: 'cursor-agent-transcript-jsonl' },
      extensions: {
        provenance: {
          acquisition: 'cursor-agent-transcript-jsonl',
          nativeSessionIdDerivedFromPath: true,
        },
      },
    });
  });

  it('does not accept agent-transcript records as Cursor CLI streams', async () => {
    await expect(adapter.inspect(selected(
      'agent-transcripts/agent-session/agent-session.jsonl',
      'cursor-cli-stream-json',
    ))).rejects.toMatchObject({ code: 'MALFORMED_SOURCE' });
  });

  it('imports editor Markdown as explicitly lossy text without invented metadata', async () => {
    const records = await collect(adapter.stream(selected('editor-export.md')));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      role: 'user',
      text: 'Decision: Markdown must not invent structured metadata.',
      extensions: {
        metadataLoss: expect.arrayContaining([
          'timestamps unavailable',
          'model unavailable',
          'tool calls and results unavailable',
          'provider lifecycle unavailable',
        ]),
        provenance: {
          nativeSessionIdDerivedFromFilename: true,
          undocumentedSqliteDependency: false,
        },
      },
    });
    expect(records[0]).not.toHaveProperty('occurredAt');
    expect(records[0].extensions).not.toHaveProperty('model');
    expect(records[0].extensions).not.toHaveProperty('lifecycle');
  });

  it.each([
    ['unknown-major.jsonl', 'UNKNOWN_SCHEMA_MAJOR'],
    ['malformed.jsonl', 'MALFORMED_SOURCE'],
  ])('fails closed for %s with %s', async (name, code) => {
    await expect(adapter.inspect(selected(name))).rejects.toMatchObject({ code });
  });
});

describeWithSqlite('Cursor adapter repository conformance', () => {
  it('redacts normalized text and makes identical replay a no-op', async () => {
    const adapter = new CursorSessionAdapter();
    const selectedSource = selected('redaction.jsonl');
    const source: SessionSource = {
      contractVersion: SESSION_CONTRACT_VERSION,
      sourceId: selectedSource.sourceId,
      provider: 'cursor',
      providerProfile: 'cli-stream-json',
      locatorClass: selectedSource.locatorClass,
      redactedLocator: '<session-source>/redaction.jsonl',
      adapterVersion: CURSOR_ADAPTER_VERSION,
      sourceSchemaVersion: CURSOR_SOURCE_SCHEMA_VERSION,
      disposition: 'implemented',
      operationalState: 'available',
      consistency: 'complete',
      authorizedAt: '2026-07-27T00:00:00.000Z',
      extensions: { 'native.cursor': {} },
    };
    const repository = new SessionRepository();
    const importer = new IncrementalSessionImporter(repository);
    const request = {
      source,
      selectedSource,
      adapter,
      workspaceId: 'workspace-fixture',
      policyVersion: '1.0.0',
    };
    expect((await importer.import(request))
      .reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(3);
    const serialized = JSON.stringify(repository.authorizedSearchDocuments({
      workspaceId: 'workspace-fixture',
      limit: 10,
    }));
    expect(serialized).not.toContain('redaction-canary-123');
    expect(serialized).not.toContain('synthetic@example.test');
    expect(await importer.import(request)).toEqual([]);
    repository.close();
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const value of iterable) output.push(value);
  return output;
}
