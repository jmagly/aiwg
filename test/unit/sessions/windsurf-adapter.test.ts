import * as sessionReaders from '../../../src/sessions/readers.js';
import { resolve } from 'node:path';
import { requireFeaturePackage } from '../../../src/features/runtime.js';
import fsPromises, { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi, type MockInstance } from 'vitest';
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

describe('Devin Desktop (Devin Desktop compatibility) session adapter', () => {

  it('inspects and streams JSONL without collecting the source', async () => {
    const buffered = vi.spyOn(sessionReaders, 'readBoundedJsonLines')
      .mockRejectedValue(new Error('JSONL import must stream'));
    try {
      const adapter = new DevinDesktopSessionAdapter();
      const selection = selected('current.jsonl');
      await expect(adapter.inspect(selection)).resolves.toMatchObject({ operationalState: 'available' });
      let records = 0;
      for await (const record of adapter.stream(selection)) {
        expect(record.nativeSessionId).toBeTruthy();
        records += 1;
      }
      expect(records).toBeGreaterThan(0);
      expect(buffered).not.toHaveBeenCalled();
    } finally {
      buffered.mockRestore();
    }
  });
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
  it.each(['success', 'repository opened', 'import completed'])(
    'redacts searchable content and makes identical replay a no-op with cleanup (%s)', async failureAt => {
      await checkFixtureCleanup(failureAt, async checkpoint => {
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
          checkpoint('repository opened', repository);
          const importer = new IncrementalSessionImporter(repository);
          const request = {
            source, selectedSource, adapter, workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
          };
          expect((await importer.import(request))
            .reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(1);
          checkpoint('import completed');
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
    },
  );

  it.each(['success', 'directory created', 'initial repository opened', 'initial import completed',
    'raw database opened', 'legacy rows written', 'repository reopened', 'replay completed'])(
    'migrates a Devin Desktop catalog in place without duplicating stable rows with cleanup (%s)', async failureAt => {
      await checkFixtureCleanup(failureAt, async checkpoint => {
        const root = await mkdtemp(resolve(tmpdir(), 'aiwg-devin-migration-'));
        try {
          checkpoint('directory created', undefined, root);
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
              checkpoint('initial repository opened', repository);
              await new IncrementalSessionImporter(repository).import(request);
              checkpoint('initial import completed');
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
            checkpoint('raw database opened', raw);
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
            checkpoint('legacy rows written');
          } finally {
            raw.close();
          }

          const reopened = new SessionRepository(databasePath);
          try {
            checkpoint('repository reopened', reopened);
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
            checkpoint('replay completed');
          } finally {
            reopened.close();
          }
        } finally {
          await fsPromises.rm(root, { recursive: true, force: true });
        }
      });
    },
  );
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

type FixtureCheckpoint = (stage: string, handle?: { close(): void }, root?: string) => void;

async function checkFixtureCleanup(
  failureAt: string,
  run: (checkpoint: FixtureCheckpoint) => Promise<void>,
): Promise<void> {
  const failure = new Error(`synthetic fixture failure: ${failureAt}`);
  const handles: Array<{ close(): void }> = [];
  const closes: MockInstance<() => void>[] = [];
  const roots: string[] = [];
  const removals: Array<{ root: string; handlesClosed: boolean }> = [];
  const originalRemove = fsPromises.rm;
  const remove = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
    if (typeof path === 'string' && roots.includes(path)) {
      removals.push({ root: path, handlesClosed: closes.every(close => close.mock.calls.length === 1) });
    }
    return originalRemove(path, options);
  });
  const checkpoint: FixtureCheckpoint = (stage, handle, root) => {
    if (root) roots.push(root);
    if (handle) {
      handles.push(handle);
      closes.push(vi.spyOn(handle, 'close'));
      // A migration must release each connection before opening the next one.
      for (const close of closes.slice(0, -1)) expect(close).toHaveBeenCalledTimes(1);
    }
    if (stage === failureAt) throw failure;
  };
  try {
    if (failureAt === 'success') await run(checkpoint);
    else await expect(run(checkpoint)).rejects.toBe(failure);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    expect(removals).toEqual(roots.map(root => ({ root, handlesClosed: true })));
    for (const root of roots) expect(existsSync(root)).toBe(false);
  } finally {
    remove.mockRestore();
    // Rescue only this invocation's resources if the cleanup oracle fails.
    for (let index = handles.length - 1; index >= 0; index--) {
      if (closes[index].mock.calls.length === 0) handles[index].close();
      closes[index].mockRestore();
    }
    for (const root of roots) await fsPromises.rm(root, { recursive: true, force: true });
  }
}
