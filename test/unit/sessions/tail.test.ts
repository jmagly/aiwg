// Exercise every registered streaming adapter against a growing synthetic source.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { describeWithSqlite } from '../../helpers/sqlite.js';
import { SessionRepository } from '../../../src/sessions/repository.js';
import { IncrementalSessionImporter } from '../../../src/sessions/importer.js';
import { createSessionAdapterRegistry } from '../../../src/sessions/adapter-registry.js';
import { stableSessionId, type SessionEvent } from '../../../src/sessions/contracts.js';
import { assertTailSupported, tailSession } from '../../../src/sessions/tail.js';
import { tailFixture, tailFixtures } from './tail-fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describeWithSqlite('session tail', () => {
  beforeEach(() => { vi.stubEnv('AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL', '1'); vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', '1.0.77'); });
  afterEach(() => vi.unstubAllEnvs());
  it('covers every adapter advertising stream', () => {
    expect(tailFixtures.map(entry => entry[0]).sort()).toEqual(createSessionAdapterRegistry().list()
      .filter(adapter => adapter.supportedOperations.includes('stream')).map(adapter => adapter.provider).sort());
  });

  it.each([...tailFixtures, ['grok-build', 'grok-build-cli-markdown-export',
    'grok-build/0199a111-1111-7111-8111-111111111111.md'] as typeof tailFixtures[number]])(
    '%s follows appended native events within two seconds, without catalog writes',
    async (_provider, _locator, _path) => {
      const root = await mkdtemp(resolve(tmpdir(), 'aiwg-tail-'));
      roots.push(root);
      const fixture = await tailFixture(root, [_provider, _locator, _path]);
      const database = resolve(root, 'catalog.sqlite');
      let repository = new SessionRepository(database);
      const request = { ...fixture, workspaceId: 'workspace-fixture', policyVersion: '1.0.0' };
      await new IncrementalSessionImporter(repository).import(request);
      const beforeCheckpoint = repository.getCheckpoint(fixture.source.sourceId, fixture.adapter.adapterVersion);
      repository.close();
      const before = await readFile(database);
      repository = new SessionRepository(database, { readonly: true });
      const controller = new AbortController();
      const events: SessionEvent[] = [];
      const native = fixture.source.provider === 'warp' ? repository.listSessions({ limit: 1 }).items[0].nativeSessionId
        : fixture.records.at(-1)!.nativeSessionId;
      fixture.selectedSource.nativeSessionId = native;
      let polls = 0;
      const start = performance.now();
      const pending = tailSession({ ...request, repository, follow: true, pollMs: 10,
        sessionId: stableSessionId(fixture.source.provider, fixture.source.sourceId, native),
        signal: controller.signal, onEvent: event => events.push(event),
        onPoll: async () => { if (++polls === 1) await fixture.append(); },
      });
      try {
        await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 1900, interval: 10 });
        expect(performance.now() - start).toBeLessThan(2000);
        expect(events.at(-1)?.nativeId).toBe(fixture.records.at(-1)?.nativeEventId ?? null);
        await vi.waitFor(() => expect(polls).toBeGreaterThan(2));
        const count = events.length;
        await vi.waitFor(() => expect(polls).toBeGreaterThan(4));
        expect(events).toHaveLength(count);
        expect(repository.getCheckpoint(fixture.source.sourceId, fixture.adapter.adapterVersion)).toEqual(beforeCheckpoint);
      } finally {
        controller.abort();
        await pending;
        repository.close();
      }
      expect(await readFile(database)).toEqual(before);
    });

  it('names a manual-only adapter without stream as UNSUPPORTED_PROVIDER', () => {
    const adapter = createSessionAdapterRegistry().get('copilot');
    expect(() => assertTailSupported({ ...adapter, supportedOperations: ['inspect'] } as typeof adapter))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PROVIDER', message: expect.stringContaining('copilot') }));
  });

  it('commits appended events through the existing importer only with import opt-in', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiwg-tail-import-'));
    roots.push(root);
    const fixture = await tailFixture(root);
    const repository = new SessionRepository(resolve(root, 'catalog.sqlite'));
    const request = { ...fixture, workspaceId: 'workspace-fixture', policyVersion: '1.0.0' };
    try {
      await new IncrementalSessionImporter(repository).import(request);
      const session = repository.listSessions({ limit: 1 }).items[0];
      const before = repository.listEvents(session.sessionId).length;
      await fixture.append();
      const events: SessionEvent[] = [];
      await tailSession({ ...request, repository, sessionId: session.sessionId, import: true,
        onEvent: event => events.push(event) });
      expect(events.length).toBeGreaterThan(0);
      expect(repository.listEvents(session.sessionId)).toHaveLength(before + events.length);
      const replay: SessionEvent[] = [];
      await tailSession({ ...request, repository, sessionId: session.sessionId, onEvent: event => replay.push(event) });
      expect(replay).toEqual([]);
    } finally { repository.close(); }
  });
});
