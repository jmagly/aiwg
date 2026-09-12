import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FACTORY_ADAPTER_VERSION,
  FACTORY_SOURCE_SCHEMA_VERSION,
  FactorySessionAdapter,
  IncrementalSessionImporter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  type FactoryRemoteTransport,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/factory');

function selected(name: string): SelectedSource {
  return {
    provider: 'factory',
    locator: resolve(fixturesRoot, name),
    locatorClass: 'factory-droid-jsonl',
    sourceId: `factory-${name}`,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

describe('Factory session adapter', () => {
  const adapter = new FactorySessionAdapter();

  it('reports documented local JSONL and negotiated remote capability classes', () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('factory', {
      state: 'available',
      evidence: {
        adapterVersion: FACTORY_ADAPTER_VERSION,
        sourceSchemaVersion: FACTORY_SOURCE_SCHEMA_VERSION,
        verifiedAt: '2026-07-27',
        reference: 'docs/providers/factory-sessions.md',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      classification: 'implemented',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['jsonl', 'api'],
    });
  });

  it('normalizes text, reasoning, tools, images, settings, and unknown fields', async () => {
    await expect(adapter.inspect(selected('complete.jsonl'))).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'complete',
      operationalState: 'available',
    });
    const records = await collect(adapter.stream(selected('complete.jsonl')));
    expect(records.map((record) => record.kind)).toEqual([
      'factory.session', 'message', 'reasoning', 'tool-call', 'image', 'message',
      'tool-result', 'factory.session_end',
    ]);
    expect(records[0]).toMatchObject({
      nativeSessionId: 'factory-session',
      extensions: {
        productVersion: '0.30.0',
        settings: { model: 'synthetic-model', reasoningEffort: 'medium' },
        unknownFields: { futureTopLevel: 'preserved' },
      },
    });
    expect(records[1].extensions).toMatchObject({
      unknownFields: { futureBlock: 'preserved' },
    });
    expect(records[3]).toMatchObject({ nativeEventId: 'tool-1', text: 'Read' });
    expect(records[4].extensions).toMatchObject({ opaque: true });
    expect(records[6]).toMatchObject({ nativeEventId: 'tool-1', text: 'synthetic result' });
  });

  it('keeps a mutable/incomplete final record provisional for a later retry', async () => {
    await expect(adapter.inspect(selected('active-incomplete.jsonl'))).resolves.toMatchObject({
      consistency: 'provisional',
    });
    const records = await collect(adapter.stream(selected('active-incomplete.jsonl')));
    expect(records).toHaveLength(2);
    expect(records.every((record) => !record.extensions?.lifecycle)).toBe(true);
  });

  it('parses current session_start envelopes using id as native session identity', async () => {
    await expect(adapter.inspect(selected('current-session-start.jsonl'))).resolves.toMatchObject({
      sourceSchemaVersion: '1.0.0',
      consistency: 'provisional',
    });
    const records = await collect(adapter.stream(selected('current-session-start.jsonl')));
    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => record.nativeSessionId)))
      .toEqual(new Set(['factory-current-session']));
    expect(records[0]).toMatchObject({
      nativeEventId: 'factory-current-session:0',
      kind: 'factory.session_start',
      extensions: {
        productVersion: 2,
        unknownFields: {
          title: 'Synthetic current session',
          sessionTitle: 'Synthetic current session',
          owner: 'synthetic',
        },
      },
    });
  });

  it.each([
    ['unknown-major.jsonl', 'UNKNOWN_SCHEMA_MAJOR'],
    ['malformed.jsonl', 'MALFORMED_SOURCE'],
  ])('fails closed for %s with %s', async (name, code) => {
    await expect(adapter.inspect(selected(name))).rejects.toMatchObject({ code });
  });

  it('reports malformed source coordinates and schema requirement without content', async () => {
    await expect(adapter.inspect(selected('malformed.jsonl'))).rejects.toMatchObject({
      code: 'MALFORMED_SOURCE',
      message: expect.stringMatching(
        /Factory source malformed\.jsonl record 1 type <missing-or-invalid> failed requirement type/,
      ),
    });
  });

  it('negotiates Sessions API and Droid Exec instead of assuming availability', async () => {
    const remoteSource = (locatorClass: string, operation?: string): SelectedSource => ({
      provider: 'factory',
      locator: `factory://${locatorClass}/synthetic`,
      locatorClass,
      sourceId: locatorClass,
      authorizedScope: {
        workspaceId: 'workspace-fixture',
        allowedRoots: [],
        authorizedAccounts: ['factory-account'],
        networkOperation: operation,
      },
    });
    await expect(adapter.inspect(remoteSource(
      'factory-sessions-api',
      'factory.sessions.read',
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    await expect(adapter.inspect(remoteSource(
      'factory-sessions-api',
    ))).rejects.toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' });

    const api: FactoryRemoteTransport = {
      kind: 'sessions-api',
      snapshot: async () => [
        { schemaVersion: '1.0.0', type: 'message', sessionId: 'api-session',
          id: 'api-message', message: { role: 'user', content: 'API evidence' } },
        { schemaVersion: '1.0.0', type: 'result', sessionId: 'api-session',
          id: 'api-result', status: 'completed' },
      ],
    };
    const exec: FactoryRemoteTransport = {
      kind: 'droid-exec',
      snapshot: async () => [
        { schemaVersion: '1.0.0', type: 'message', session_id: 'exec-session',
          id: 'exec-message', message: { role: 'assistant', content: 'Exec evidence' } },
      ],
    };
    const negotiated = new FactorySessionAdapter(undefined, [api, exec]);
    await expect(negotiated.inspect(remoteSource(
      'factory-sessions-api',
      'factory.sessions.read',
    ))).resolves.toMatchObject({ consistency: 'complete' });
    await expect(negotiated.inspect(remoteSource(
      'factory-exec-stream',
      'factory.exec.stream',
    ))).resolves.toMatchObject({ consistency: 'provisional' });
  });
});

describeWithSqlite('Factory adapter repository conformance', () => {
  it('redacts searchable content and makes identical replay a no-op', async () => {
    const adapter = new FactorySessionAdapter();
    const selectedSource = selected('redaction.jsonl');
    const source: SessionSource = {
      contractVersion: SESSION_CONTRACT_VERSION,
      sourceId: selectedSource.sourceId,
      provider: 'factory',
      providerProfile: 'documented-project-jsonl',
      locatorClass: selectedSource.locatorClass,
      redactedLocator: '<session-source>/redaction.jsonl',
      adapterVersion: FACTORY_ADAPTER_VERSION,
      sourceSchemaVersion: FACTORY_SOURCE_SCHEMA_VERSION,
      disposition: 'implemented',
      operationalState: 'available',
      consistency: 'complete',
      authorizedAt: '2026-07-27T00:00:00.000Z',
      extensions: { 'native.factory': {} },
    };
    const repository = new SessionRepository();
    const importer = new IncrementalSessionImporter(repository);
    const request = {
      source, selectedSource, adapter, workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
    };
    expect((await importer.import(request))
      .reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(3);
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
