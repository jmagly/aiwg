import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IncrementalSessionImporter,
  OPENCODE_ADAPTER_VERSION,
  OPENCODE_EXPORT_SCHEMA_VERSION,
  OpenCodeSessionAdapter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  type OpenCodeSessionTransport,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/opencode');

function selected(name: string, locatorClass = 'opencode-export-json'): SelectedSource {
  return {
    provider: 'opencode',
    locator: resolve(fixturesRoot, name),
    locatorClass,
    sourceId: `opencode-${name}`,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

describe('OpenCode session adapter', () => {
  const adapter = new OpenCodeSessionAdapter();

  it('reports explicit export and negotiated API/SSE capabilities', () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('opencode', {
      state: 'available',
      evidence: {
        adapterVersion: OPENCODE_ADAPTER_VERSION,
        sourceSchemaVersion: OPENCODE_EXPORT_SCHEMA_VERSION,
        verifiedAt: '2026-07-27',
        reference: 'docs/providers/opencode-sessions.md',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      classification: 'implemented',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['manual-export', 'api', 'jsonl'],
    });
  });

  it('preserves identity, workspace, lineage, models, usage, tools, attachments, sharing, and unknown fields', async () => {
    await expect(adapter.inspect(selected('complete.json'))).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'complete',
      operationalState: 'available',
    });
    const records = await collect(adapter.stream(selected('complete.json')));
    expect(records[0]).toMatchObject({
      nativeSessionId: 'ses_opencode_complete',
      kind: 'opencode.session',
      extensions: {
        workspace: { projectId: 'project-synthetic', directoryClass: '<workspace>' },
        lineage: { parentSessionId: 'ses_parent' },
        sharing: { shared: true, publicUrlPresent: true },
        sanitization: { sanitized: true },
        provenance: { directSqlite: false },
        sessionUnknownFields: {
          futureExport: 'preserved',
          futureSession: 'preserved',
        },
      },
    });
    expect(records.find((record) => record.nativeEventId === 'message:msg_assistant')?.extensions)
      .toMatchObject({
        parentMessageId: 'msg_user',
        model: { providerID: 'synthetic', modelID: 'model-a' },
        usage: { cost: 0.02, tokens: { input: 10, output: 20, reasoning: 5 } },
      });
    expect(records.find((record) => record.nativeEventId === 'part:part_tool')).toMatchObject({
      kind: 'tool-result',
      text: 'Synthetic output',
      extensions: { tool: 'read', toolCallId: 'call-1' },
    });
    expect(records.find((record) => record.nativeEventId === 'part:part_file')?.extensions)
      .toMatchObject({ attachment: { mime: 'text/plain', filename: 'synthetic.txt', urlPresent: true } });
    expect(records.find((record) => record.nativeEventId === 'part:part_future')?.extensions)
      .toMatchObject({ opaqueContent: true, unknownFields: { futurePart: 'preserved' } });
  });

  it('normalizes sanitized export and captured SSE events to the same session and native event identities', async () => {
    const exported = await collect(adapter.stream(selected('complete.json')));
    const events = await collect(adapter.stream(selected('events.jsonl', 'opencode-sse-jsonl')));
    expect(new Set(events.map((record) => record.nativeSessionId))).toEqual(
      new Set(exported.map((record) => record.nativeSessionId)),
    );
    expect(events.map((record) => record.nativeEventId)).toEqual(
      expect.arrayContaining(['session:ses_opencode_complete', 'message:msg_user', 'part:part_text']),
    );
    await expect(adapter.inspect(selected('events.jsonl', 'opencode-sse-jsonl')))
      .resolves.toMatchObject({ consistency: 'provisional' });
  });

  it('marks active data provisional and rejects direct SQLite access', async () => {
    await expect(adapter.inspect(selected('active.json'))).resolves.toMatchObject({
      consistency: 'provisional',
    });
    await expect(adapter.inspect(selected('complete.json', 'opencode-sqlite')))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('requires explicit authorization and negotiated transports for local API/SSE', async () => {
    const source: SelectedSource = {
      provider: 'opencode',
      locator: 'http://127.0.0.1:4096/session/ses_opencode_complete',
      locatorClass: 'opencode-local-api',
      sourceId: 'opencode-api',
      authorizedScope: {
        workspaceId: 'workspace-fixture',
        allowedRoots: [],
        networkOperation: 'opencode.local.sessions.read',
      },
    };
    await expect(adapter.inspect(source)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    const transport: OpenCodeSessionTransport = {
      kind: 'api',
      snapshot: async () => JSON.parse(await readFile(
        resolve(fixturesRoot, 'complete.json'),
        'utf8',
      )),
    };
    await expect(new OpenCodeSessionAdapter(undefined, [transport]).inspect(source))
      .resolves.toMatchObject({ consistency: 'provisional' });
    await expect(new OpenCodeSessionAdapter(undefined, [transport]).inspect({
      ...source,
      authorizedScope: { ...source.authorizedScope, networkOperation: undefined },
    })).rejects.toMatchObject({ code: 'OPERATION_NOT_AUTHORIZED' });
  });

  it.each([
    ['unknown-major.json', 'opencode-export-json', 'UNKNOWN_SCHEMA_MAJOR'],
    ['malformed.json', 'opencode-export-json', 'MALFORMED_SOURCE'],
    ['malformed-events.jsonl', 'opencode-sse-jsonl', 'MALFORMED_SOURCE'],
  ])('fails closed for %s with %s', async (name, locatorClass, code) => {
    await expect(adapter.inspect(selected(name, locatorClass))).rejects.toMatchObject({ code });
  });
});

describeWithSqlite('OpenCode adapter repository conformance', () => {
  it('redacts searchable content and makes identical replay a no-op', async () => {
    const adapter = new OpenCodeSessionAdapter();
    const selectedSource = selected('redaction.json');
    const source: SessionSource = {
      contractVersion: SESSION_CONTRACT_VERSION,
      sourceId: selectedSource.sourceId,
      provider: 'opencode',
      providerProfile: 'sanitized-json-export',
      locatorClass: selectedSource.locatorClass,
      redactedLocator: '<session-source>/redaction.json',
      adapterVersion: OPENCODE_ADAPTER_VERSION,
      sourceSchemaVersion: OPENCODE_EXPORT_SCHEMA_VERSION,
      disposition: 'implemented',
      operationalState: 'available',
      consistency: 'complete',
      authorizedAt: '2026-07-27T00:00:00.000Z',
      extensions: { 'native.opencode': {} },
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
    expect(stored).not.toContain('redaction-canary-456');
    expect(stored).not.toContain('synthetic-opencode@example.test');
    expect(await importer.import(request)).toEqual([]);
    repository.close();
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of iterable) result.push(value);
  return result;
}
