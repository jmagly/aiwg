import { cp, mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEX_ADAPTER_VERSION,
  CodexSessionAdapter,
  IncrementalSessionImporter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  stableSessionId,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/codex');
const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex session adapter', () => {
  it('publishes implemented API-first and rollout fallback capabilities', () => {
    const adapter = new CodexSessionAdapter();
    expect(adapter).toMatchObject({
      provider: 'codex',
      adapterVersion: CODEX_ADAPTER_VERSION,
      disposition: 'implemented',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['api', 'jsonl'],
    });
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('codex', {
      state: 'available',
      evidence: {
        adapterVersion: CODEX_ADAPTER_VERSION,
        sourceSchemaVersion: '1.0.0',
        verifiedAt: '2026-07-27',
        reference: 'docs/providers/codex-sessions.md',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      provider: 'codex',
      classification: 'implemented',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['api', 'jsonl'],
    });
  });

  it('discovers authorized JSONL deterministically without following symlinks', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiwg-codex-discovery-'));
    temporaryRoots.push(root);
    await mkdir(resolve(root, 'nested'));
    await cp(resolve(fixturesRoot, 'threads.app-server.jsonl'), resolve(root, 'b.app-server.jsonl'));
    await cp(
      resolve(fixturesRoot, 'rollout-2026-07-27T10-00-00-019d0000-0000-7000-8000-000000000003.jsonl'),
      resolve(root, 'nested', 'a.jsonl'),
    );
    await symlink(resolve(root, 'nested'), resolve(root, 'linked'));
    const found = await collect(new CodexSessionAdapter().discover({
      workspaceId: 'workspace-fixture', allowedRoots: [root],
    }));
    expect(found.map((item) => basename(item.locator))).toEqual(['b.app-server.jsonl', 'a.jsonl']);
    expect(found.map((item) => item.locatorClass))
      .toEqual(['codex-app-server-jsonl', 'codex-rollout-jsonl']);
  });

  it('preserves App Server pagination, status, fork, compaction, archive, and delete evidence', async () => {
    const selected = selectedSource('threads.app-server.jsonl', 'codex-app-fixture');
    const adapter = new CodexSessionAdapter();
    expect(await adapter.inspect(selected)).toMatchObject({
      sourceSchemaVersion: '1.0.0',
      consistency: 'provisional',
    });
    const records = await collect(adapter.stream(selected));
    expect(records).toHaveLength(10);
    expect(records[0].extensions).toMatchObject({
      status: 'active',
      productVersion: '0.145.0',
      workspace: { cwdClass: '<workspace>', git: { branch: 'main', repositoryClass: '<repository>' } },
      pagination: { hasNext: true, hasBackwards: true },
      unknownFields: { futureThreadField: 'preserved' },
    });
    expect(records.find((record) => record.nativeSessionId.endsWith('0002'))?.extensions)
      .toMatchObject({ forkedFromId: expect.stringContaining('0001') });
    expect(records.some((record) => record.kind === 'summary')).toBe(true);
    expect(records.map((record) => record.extensions?.lifecycleEvent).filter(Boolean))
      .toEqual(['status-changed', 'archived', 'deleted']);
    expect(JSON.stringify(records)).not.toContain('/private/');
  });

  it('reads only complete rollout records and preserves durable replay provenance', async () => {
    const selected = selectedSource(
      'rollout-2026-07-27T10-00-00-019d0000-0000-7000-8000-000000000003.jsonl',
      'codex-rollout-fixture',
    );
    const adapter = new CodexSessionAdapter();
    expect(await adapter.inspect(selected)).toMatchObject({ consistency: 'provisional' });
    const records = await collect(adapter.stream(selected));
    expect(records).toHaveLength(5);
    expect(records.map((record) => record.kind)).toContain('summary');
    expect(records.every((record) =>
      (record.extensions?.provenance as any).durableReplay === true)).toBe(true);
    expect(records[0].extensions).toMatchObject({
      productVersion: '0.145.0',
      workspace: { cwdClass: '<workspace>' },
      unknownFields: { futureMeta: 'preserved' },
    });
    expect(JSON.stringify(records)).not.toContain('/private/');
  });

  it.each([
    ['unknown-major.app-server.jsonl', 'UNKNOWN_SCHEMA_MAJOR'],
    ['malformed.app-server.jsonl', 'MALFORMED_SOURCE'],
    ['drift.app-server.jsonl', 'SCHEMA_DRIFT'],
  ])('fails closed for %s', async (fixture, code) => {
    await expect(collect(new CodexSessionAdapter().stream(
      selectedSource(fixture, `codex-${fixture}`),
    ))).rejects.toMatchObject({ code });
  });

  it('rejects sources outside explicitly authorized roots', async () => {
    const selected = selectedSource('threads.app-server.jsonl', 'codex-auth');
    selected.authorizedScope.allowedRoots = [resolve(fixturesRoot, 'elsewhere')];
    await expect(new CodexSessionAdapter().inspect(selected))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
  });
});

describeWithSqlite('Codex adapter repository conformance', () => {
  it('imports App Server evidence, redacts content, and replays as a no-op', async () => {
    const selected = selectedSource('threads.app-server.jsonl', 'codex-app-import');
    const source = sourceFor(selected, 'provisional');
    const repository = new SessionRepository();
    const importer = new IncrementalSessionImporter(repository);
    const request = {
      source, selectedSource: selected, adapter: new CodexSessionAdapter(),
      workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
    };
    const first = await importer.import(request);
    expect(first.reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(10);
    const id = stableSessionId('codex', source.sourceId, '019d0000-0000-7000-8000-000000000001');
    expect(repository.getSession(id)).toMatchObject({ lifecycle: 'active', consistency: 'provisional' });
    expect(repository.listEvents(id).some((event) =>
      event.searchableText.includes('synthetic@example.test'))).toBe(false);
    expect(await importer.import(request)).toEqual([]);
    repository.close();
  });

  it('leaves no partial normalized state for an unknown major', async () => {
    const selected = selectedSource('unknown-major.app-server.jsonl', 'codex-major-import');
    const repository = new SessionRepository();
    await expect(new IncrementalSessionImporter(repository).import({
      source: sourceFor(selected, 'provisional', '2.0.0'),
      selectedSource: selected, adapter: new CodexSessionAdapter(),
      workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
    })).rejects.toMatchObject({ code: 'UNKNOWN_SCHEMA_MAJOR' });
    expect(repository.doctor()).toMatchObject({ sources: 0, sessions: 0, events: 0 });
    repository.close();
  });
});

function selectedSource(fixture: string, sourceId: string): SelectedSource {
  return {
    provider: 'codex',
    locator: resolve(fixturesRoot, fixture),
    locatorClass: fixture.endsWith('.app-server.jsonl')
      ? 'codex-app-server-jsonl'
      : 'codex-rollout-jsonl',
    sourceId,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

function sourceFor(
  selected: SelectedSource,
  consistency: 'provisional' | 'complete',
  sourceSchemaVersion = '1.0.0',
): SessionSource {
  return {
    contractVersion: SESSION_CONTRACT_VERSION,
    sourceId: selected.sourceId,
    provider: 'codex',
    providerProfile: 'app-server-v2-rollout-fallback',
    locatorClass: selected.locatorClass,
    redactedLocator: '<session-source>/fixture.jsonl',
    adapterVersion: CODEX_ADAPTER_VERSION,
    sourceSchemaVersion,
    disposition: 'implemented',
    operationalState: 'available',
    consistency,
    authorizedAt: '2026-07-27T00:00:00.000Z',
    extensions: { 'native.codex': {} },
  };
}


async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const item of input) output.push(item);
  return output;
}
