import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IncrementalSessionImporter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  WARP_ADAPTER_VERSION,
  WARP_MARKDOWN_SCHEMA_VERSION,
  WarpSessionAdapter,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/warp');

function selected(name: string, locatorClass = 'warp-markdown-export'): SelectedSource {
  return {
    provider: 'warp',
    locator: resolve(fixturesRoot, name),
    locatorClass,
    sourceId: `warp-${name}`,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

describe('Warp session adapter', () => {
  const adapter = new WarpSessionAdapter();

  it('reports manual-only Markdown acquisition without discovery', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('warp', {
      state: 'available',
      evidence: {
        adapterVersion: WARP_ADAPTER_VERSION,
        sourceSchemaVersion: WARP_MARKDOWN_SCHEMA_VERSION,
        verifiedAt: '2026-07-27',
        reference: 'docs/providers/warp-sessions.md',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      classification: 'manual-only',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['manual-export'],
    });
    expect(await collect(adapter.discover({
      workspaceId: 'workspace-fixture',
      allowedRoots: [fixturesRoot],
    }))).toEqual([]);
  });

  it('imports explicit Markdown with stable derived identity and completed-at-import evidence', async () => {
    await expect(adapter.inspect(selected('complete.md'))).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'complete',
      operationalState: 'available',
    });
    const records = await collect(adapter.stream(selected('complete.md')));
    expect(records).toHaveLength(4);
    expect(records.map((record) => record.role)).toEqual([
      'user', 'assistant', 'user', 'assistant',
    ]);
    expect(records[0]).toMatchObject({
      nativeSessionId: expect.stringMatching(/^manual:[a-f0-9]{32}$/),
      nativeEventId: undefined,
      occurredAt: undefined,
      extensions: {
        lifecycle: 'completed-at-import',
        manualImport: true,
        identity: {
          nativeSessionIdKnown: false,
          nativeEventIdKnown: false,
          derivedSessionIdentity: true,
        },
        provenance: {
          acquisition: 'user-selected-markdown-export',
          exportCommand: '/export-to-file',
          internalStoreInspected: false,
        },
      },
    });
    expect(new Set(records.map((record) => record.nativeSessionId)).size).toBe(1);
  });

  it('emits an explicit loss report and leaves absent native fields unknown', async () => {
    const records = await collect(adapter.stream(selected('unknown-lifecycle.md')));
    expect(records[0].extensions).toMatchObject({
      lifecycle: 'unknown-at-import',
      lossReport: {
        lossless: false,
        sourceFormat: 'markdown',
        unknownFields: expect.arrayContaining([
          'nativeSessionId',
          'nativeEventId',
          'timestamp',
          'model',
          'toolStructure',
          'attachmentStructure',
        ]),
        lifecycleEvidence: 'unknown-at-import',
      },
      deletion: {
        aiwgDeletionDoesNotDeleteWarpConversation: true,
        providerDeletionStateUnknown: true,
      },
    });
  });

  it.each(['warp-internal-store', 'warp-sqlite', 'warp-protobuf'])(
    'rejects internal source class %s with export remediation',
    async (locatorClass) => {
      await expect(adapter.inspect(selected('complete.md', locatorClass)))
        .rejects.toMatchObject({
          code: 'UNSUPPORTED_OPERATION',
          message: expect.stringContaining('/export-to-file'),
        });
    },
  );

  it.each([
    ['unknown-major.md', 'UNKNOWN_SCHEMA_MAJOR'],
    ['malformed.md', 'MALFORMED_SOURCE'],
  ])('fails closed for %s with %s', async (name, code) => {
    await expect(adapter.inspect(selected(name))).rejects.toMatchObject({ code });
  });
});

describeWithSqlite('Warp adapter repository conformance', () => {
  it('redacts searchable content and makes identical replay a no-op', async () => {
    const adapter = new WarpSessionAdapter();
    const selectedSource = selected('redaction.md');
    const source: SessionSource = {
      contractVersion: SESSION_CONTRACT_VERSION,
      sourceId: selectedSource.sourceId,
      provider: 'warp',
      providerProfile: 'manual-lossy-markdown-export',
      locatorClass: selectedSource.locatorClass,
      redactedLocator: '<session-source>/redaction.md',
      adapterVersion: WARP_ADAPTER_VERSION,
      sourceSchemaVersion: WARP_MARKDOWN_SCHEMA_VERSION,
      disposition: 'manual-only',
      operationalState: 'available',
      consistency: 'complete',
      authorizedAt: '2026-07-27T00:00:00.000Z',
      extensions: { 'native.warp': {} },
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
    expect(stored).not.toContain('redaction-canary-202');
    expect(stored).not.toContain('warp-synthetic@example.test');
    expect(await importer.import(request)).toEqual([]);
    repository.close();
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of iterable) result.push(value);
  return result;
}
