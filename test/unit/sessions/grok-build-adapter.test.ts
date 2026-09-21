import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GROK_BUILD_ADAPTER_VERSION,
  GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS,
  GROK_BUILD_CLI_EXPORT_SCHEMA_VERSION,
  GrokBuildSessionAdapter,
  discoverWorkspaceHistories,
  IncrementalSessionImporter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/grok-build');
const roots: string[] = [];

function selected(name: string, locatorClass = GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS): SelectedSource {
  return {
    provider: 'grok-build',
    locator: resolve(fixturesRoot, name),
    locatorClass,
    sourceId: `grok-build-${name}`,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Grok Build session adapter', () => {
  const adapter = new GrokBuildSessionAdapter();

  it('registers separately from Grok Bot and requires documented CLI export', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('grok-build', {
      state: 'available',
      evidence: {
        adapterVersion: GROK_BUILD_ADAPTER_VERSION,
        sourceSchemaVersion: GROK_BUILD_CLI_EXPORT_SCHEMA_VERSION,
        verifiedAt: '2026-09-21',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      provider: 'grok-build',
      classification: 'implemented',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['manual-export'],
    });
    await expect(collect(adapter.discover({
      workspaceId: 'workspace-fixture', allowedRoots: [resolve('/tmp/.grok/sessions')],
    }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('grok sessions list'),
    });
  });

  it('routes workspace discovery to the GROK_HOME-aware public CLI without reading native stores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-grok-build-discovery-'));
    roots.push(root);
    const manifest = await discoverWorkspaceHistories({ workspace: root, providerHome: root });
    expect(manifest.providers.find((entry) => entry.provider === 'grok-build')).toMatchObject({
      status: 'export-required',
      disposition: 'manual-export',
      sourceCount: 0,
      reasonCode: 'CLI_EXPORT_REQUIRED',
      remediation: expect.stringContaining('$GROK_HOME'),
    });
    expect(manifest.sources.some((source) => source.provider === 'grok-build')).toBe(false);
  });

  it('imports prompts, assistant output, and structured tool summaries with stable native identity', async () => {
    const source = selected('0199a111-1111-7111-8111-111111111111.md');
    await expect(adapter.inspect(source)).resolves.toEqual({
      sourceSchemaVersion: '1.0.0', consistency: 'complete', operationalState: 'available',
    });
    const first = await collect(adapter.stream(source));
    const second = await collect(adapter.stream(source));
    expect(second).toEqual(first);
    expect(first.map((record) => [record.kind, record.role, record.toolName])).toEqual([
      ['message', 'user', undefined],
      ['message', 'assistant', undefined],
      ['tool-call', 'tool', 'Read'],
      ['tool-call', 'tool', 'Execute'],
      ['message', 'user', undefined],
      ['message', 'assistant', undefined],
    ]);
    expect(first[0]).toMatchObject({
      nativeSessionId: '0199a111-1111-7111-8111-111111111111',
      occurredAt: undefined,
      extensions: {
        provenance: { product: 'grok-build', nativeStoreInspected: false },
        lossReport: { unavailableInCliExport: expect.arrayContaining([
          'timestamps', 'model', 'grokVersion', 'workingDirectory', 'attachments',
          'fileSnapshots', 'compaction', 'lineage', 'subagents',
        ]) },
      },
    });
  });

  it('fails closed for changed headings, native/Cursor locator classes, and missing CLI IDs', async () => {
    await expect(adapter.inspect(selected('0199a444-4444-7444-8444-444444444444.md')))
      .rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
    await expect(adapter.inspect(selected(
      '0199a111-1111-7111-8111-111111111111.md', 'grok-build-native-updates-jsonl',
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    await expect(adapter.inspect(selected(
      '0199a111-1111-7111-8111-111111111111.md', 'cursor-agent-transcript-jsonl',
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    await expect(adapter.inspect(selected('README.md')))
      .rejects.toMatchObject({ code: 'MALFORMED_SOURCE' });
  });

  it('rejects symlink escapes before reading the export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-grok-build-session-'));
    roots.push(root);
    const outside = join(dirname(root), '0199afff-ffff-7fff-8fff-ffffffffffff.md');
    await writeFile(outside, '## User\n\noutside\n');
    roots.push(outside);
    const link = join(root, '0199afff-ffff-7fff-8fff-ffffffffffff.md');
    await symlink(outside, link);
    await expect(adapter.inspect({
      provider: 'grok-build', locator: link,
      locatorClass: GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS,
      sourceId: 'symlink',
      authorizedScope: { workspaceId: 'workspace', allowedRoots: [root] },
    })).rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });
  });
});

describeWithSqlite('Grok Build adapter repository conformance', () => {
  it('is idempotent and keeps resumed/fork lineage unknown when the CLI export omits it', async () => {
    const adapter = new GrokBuildSessionAdapter();
    const selectedSource = selected('0199a222-2222-7222-8222-222222222222.md');
    const source: SessionSource = {
      contractVersion: SESSION_CONTRACT_VERSION,
      sourceId: selectedSource.sourceId,
      provider: 'grok-build',
      providerProfile: 'documented-cli-markdown-export',
      locatorClass: selectedSource.locatorClass,
      redactedLocator: '<session-source>/0199a222.md',
      adapterVersion: GROK_BUILD_ADAPTER_VERSION,
      sourceSchemaVersion: GROK_BUILD_CLI_EXPORT_SCHEMA_VERSION,
      disposition: 'implemented', operationalState: 'available', consistency: 'complete',
      authorizedAt: '2026-09-21T00:00:00.000Z',
      extensions: { 'native.grok-build': { nativeParsing: false } },
    };
    const repository = new SessionRepository();
    try {
      const importer = new IncrementalSessionImporter(repository);
      const request = {
        source, selectedSource, adapter, workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
      };
      expect((await importer.import(request)).reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(2);
      expect(await importer.import(request)).toEqual([]);
      const sessions = repository.listSessions({ workspaceId: 'workspace-fixture', limit: 10 });
      expect(sessions.total).toBe(1);
      expect(sessions.items[0]?.extensions).toMatchObject({
        'native.grok-build': { lifecycleEvidence: { state: 'unknown' } },
      });
    } finally {
      repository.close();
    }
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
