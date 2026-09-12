import { resolve } from 'node:path';
import { requireFeaturePackage } from '../../../src/features/runtime.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  IncrementalSessionImporter,
  DEVIN_DESKTOP_ADAPTER_VERSION,
  DEVIN_DESKTOP_TRANSCRIPT_SCHEMA_VERSION,
  DevinDesktopSessionAdapter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  WINDSURF_ADAPTER_VERSION,
  WINDSURF_TRANSCRIPT_SCHEMA_VERSION,
  WindsurfSessionAdapter,
  stableSessionId,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/windsurf');

function selected(name: string, locatorClass = 'windsurf-cascade-hook-jsonl'): SelectedSource {
  return {
    provider: 'devin-desktop',
    locator: resolve(fixturesRoot, name),
    locatorClass,
    sourceId: `windsurf-${name}`,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

describe('Devin Desktop (Windsurf compatibility) session adapter', () => {
  const adapter = new DevinDesktopSessionAdapter();

  it('reports opt-in hook acquisition and performs no discovery', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('windsurf', {
      state: 'available',
      evidence: {
        adapterVersion: WINDSURF_ADAPTER_VERSION,
        sourceSchemaVersion: WINDSURF_TRANSCRIPT_SCHEMA_VERSION,
        verifiedAt: '2026-07-27',
        reference: 'docs/providers/windsurf-sessions.md',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      provider: 'devin-desktop',
      classification: 'implemented',
      acquisitionModes: ['hook', 'jsonl'],
    });
    expect(await collect(adapter.discover({
      workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot],
    }))).toEqual([]);
  });

  it('imports current transcript steps provisionally with hook provenance', async () => {
    await expect(adapter.inspect(selected('current.jsonl'))).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'provisional',
      operationalState: 'available',
    });
    const records = await collect(adapter.stream(selected('current.jsonl')));
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      nativeSessionId: 'trajectory-1920',
      nativeEventId: 'event-1',
      occurredAt: '2026-07-27T12:00:00.000Z',
      role: 'user',
      text: 'Create a hello world file',
      extensions: {
        trajectoryId: 'trajectory-1920',
        executionId: 'execution-1',
        model: 'Claude Sonnet 4',
        sensitiveContentWarning: true,
        nativeStep: { future_field: { preserved: true } },
        provenance: {
          product: 'Devin Desktop',
          providerId: 'devin-desktop',
          compatibilityProviderId: 'windsurf',
          optInRequired: true,
          hookConfiguredByAiWG: false,
          credentialsInspected: false,
          environmentSecretsInspected: false,
          liveTokenCapture: false,
          completeHistoricalCapture: false,
          providerRetention: { maximumFiles: 100, evictionOrder: 'oldest-mtime' },
        },
      },
    });
  });

  it('canonicalizes the compatibility alias before stable identity derivation', () => {
    expect(WINDSURF_ADAPTER_VERSION).toBe(DEVIN_DESKTOP_ADAPTER_VERSION);
    expect(WINDSURF_TRANSCRIPT_SCHEMA_VERSION)
      .toBe(DEVIN_DESKTOP_TRANSCRIPT_SCHEMA_VERSION);
    expect(stableSessionId('windsurf', 'source', 'trajectory'))
      .toBe(stableSessionId('devin-desktop', 'source', 'trajectory'));
    expect(new WindsurfSessionAdapter().provider).toBe('devin-desktop');
  });

  it('normalizes canonical and compatibility locator inputs identically', async () => {
    const alias = await collect(adapter.stream(selected(
      'current.jsonl',
      'windsurf-cascade-hook-jsonl',
    )));
    const canonical = await collect(adapter.stream(selected(
      'current.jsonl',
      'devin-desktop-cascade-hook-jsonl',
    )));
    expect(canonical).toEqual(alias);
    expect(canonical[0].rawReference.locatorClass)
      .toBe('devin-desktop-cascade-hook-jsonl');
  });

  it('rejects legacy stores and fails closed on drift', async () => {
    await expect(adapter.inspect(selected('current.jsonl', 'windsurf-legacy-protobuf')))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    await expect(adapter.inspect(selected('unknown-major.jsonl')))
      .rejects.toMatchObject({ code: 'UNKNOWN_SCHEMA_MAJOR' });
    await expect(adapter.inspect(selected('mixed.jsonl')))
      .rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
    await expect(adapter.inspect(selected('malformed.jsonl')))
      .rejects.toMatchObject({ code: 'MALFORMED_SOURCE' });
  });
});

describeWithSqlite('Devin Desktop adapter repository conformance', () => {
  it('redacts searchable content and makes identical replay a no-op', async () => {
    const adapter = new DevinDesktopSessionAdapter();
    const selectedSource = selected('redaction.jsonl');
    const source: SessionSource = {
      contractVersion: SESSION_CONTRACT_VERSION,
      sourceId: selectedSource.sourceId,
      provider: 'devin-desktop',
      providerProfile: 'devin-desktop-cascade-transcript-hook',
      locatorClass: selectedSource.locatorClass,
      redactedLocator: '<session-source>/redaction.jsonl',
      adapterVersion: WINDSURF_ADAPTER_VERSION,
      sourceSchemaVersion: WINDSURF_TRANSCRIPT_SCHEMA_VERSION,
      disposition: 'implemented',
      operationalState: 'available',
      consistency: 'provisional',
      authorizedAt: '2026-07-27T00:00:00.000Z',
      extensions: {
        'native.devin-desktop': {
          product: 'Devin Desktop',
          compatibilityProviderId: 'windsurf',
        },
      },
    };
    const repository = new SessionRepository();
    try {
      const importer = new IncrementalSessionImporter(repository);
      const request = {
        source, selectedSource, adapter, workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
      };
      expect((await importer.import(request))
        .reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(1);
      const stored = JSON.stringify(repository.authorizedSearchDocuments({
        workspaceId: 'workspace-fixture', limit: 10,
      }));
      expect(stored).not.toContain('redaction-canary-1920');
      expect(stored).not.toContain('devin-synthetic@example.test');
      expect(await importer.import(request)).toEqual([]);
    } finally {
      repository.close();
    }
  });

  it('migrates a Windsurf catalog in place without duplicating stable rows', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiwg-devin-migration-'));
    try {
      const databasePath = resolve(root, 'catalog.sqlite');
      const adapter = new DevinDesktopSessionAdapter();
      const selectedSource = selected('redaction.jsonl');
      const source: SessionSource = {
        contractVersion: SESSION_CONTRACT_VERSION,
        sourceId: selectedSource.sourceId,
        provider: 'devin-desktop',
        providerProfile: 'devin-desktop-cascade-transcript-hook',
        locatorClass: 'devin-desktop-cascade-hook-jsonl',
        redactedLocator: '<session-source>/redaction.jsonl',
        adapterVersion: DEVIN_DESKTOP_ADAPTER_VERSION,
        sourceSchemaVersion: DEVIN_DESKTOP_TRANSCRIPT_SCHEMA_VERSION,
        disposition: 'implemented',
        operationalState: 'available',
        consistency: 'provisional',
        authorizedAt: '2026-07-27T00:00:00.000Z',
        extensions: { 'native.devin-desktop': { product: 'Devin Desktop' } },
      };
      const repository = new SessionRepository(databasePath);
      const request = {
        source,
        selectedSource,
        adapter,
        workspaceId: 'workspace-fixture',
        policyVersion: '1.0.0',
      };
      const original = await (async () => {
        try {
          await new IncrementalSessionImporter(repository).import(request);
          return repository.listSessions({
            workspaceId: 'workspace-fixture',
            limit: 10,
          }).items[0];
        } finally {
          repository.close();
        }
      })();

      const Database = requireFeaturePackage('better-sqlite3') as new (path: string) => any;
      const raw = new Database(databasePath);
      try {
        const sourceRow = raw.prepare('SELECT source_id, data FROM session_sources').get();
        const oldSource = JSON.parse(sourceRow.data);
        oldSource.provider = 'windsurf';
        oldSource.locatorClass = 'windsurf-cascade-hook-jsonl';
        oldSource.extensions = { 'native.windsurf': { product: 'Devin Desktop' } };
        raw.prepare(
          'UPDATE session_sources SET provider=?, data=? WHERE source_id=?',
        ).run('windsurf', JSON.stringify(oldSource), sourceRow.source_id);
        const sessionRow = raw.prepare('SELECT session_id, data FROM sessions').get();
        const oldSession = JSON.parse(sessionRow.data);
        oldSession.provider = 'windsurf';
        raw.prepare('UPDATE sessions SET data=? WHERE session_id=?')
          .run(JSON.stringify(oldSession), sessionRow.session_id);
        const eventRow = raw.prepare('SELECT event_id, data FROM session_events').get();
        const oldEvent = JSON.parse(eventRow.data);
        oldEvent.kind = oldEvent.kind.replace('devin-desktop.', 'windsurf.');
        oldEvent.extensions = { 'native.windsurf': oldEvent.extensions['native.devin-desktop'] };
        raw.prepare('UPDATE session_events SET data=? WHERE event_id=?')
          .run(JSON.stringify(oldEvent), eventRow.event_id);
        raw.prepare('DELETE FROM session_catalog_meta').run();
      } finally {
        raw.close();
      }

      const reopened = new SessionRepository(databasePath);
      try {
        const migrated = reopened.listSessions({
          workspaceId: 'workspace-fixture',
          limit: 10,
        }).items;
        expect(migrated).toHaveLength(1);
        expect(migrated[0]).toMatchObject({
          sessionId: original.sessionId,
          provider: 'devin-desktop',
        });
        expect(reopened.listEvents(original.sessionId)[0]).toMatchObject({
          kind: 'devin-desktop.user_input',
          rawReference: { locatorClass: 'devin-desktop-cascade-hook-jsonl' },
          extensions: { 'native.devin-desktop': expect.any(Object) },
        });
        expect(await new IncrementalSessionImporter(reopened).import(request)).toEqual([]);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
