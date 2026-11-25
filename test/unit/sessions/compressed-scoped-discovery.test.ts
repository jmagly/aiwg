// Cover compressed rollouts, content retries, and strict selected Claude roots.
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import fsPromises from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionsHandler } from '../../../src/cli/handlers/sessions.js';
import {
  CodexSessionAdapter, IncrementalSessionImporter, SessionRepository,
  discoverWorkspaceHistories, importDiscoveryManifest, publicDiscoveryManifest,
  readDiscoveryManifest, writeDiscoveryManifest, type SelectedSource, type SessionSource,
} from '../../../src/sessions/index.js';
import { previewDiscoveryImport } from '../../../src/sessions/batch-import.js';
import { assertClaudeManifestBoundary, containsSource } from '../../../src/sessions/source-boundary.js';
import { itWithSqlite } from '../../helpers/sqlite.js';
import { createJunction, uncPath, windowsPath, withWindows } from '../../helpers/windows-simulation.mjs';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'session-compressed-boundary-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const selected = join(root, 'Selected Project');
  const other = join(root, 'Other Project');
  const codex = join(root, 'codex');
  await Promise.all([workspace, selected, other, codex].map(path => mkdir(path)));
  return { root, workspace, selected, other, codex };
}
const collect = async <T>(input: AsyncIterable<T>) => { const records: T[] = []; for await (const record of input) records.push(record); return records; };
function selection(locator: string, root: string, workspace: string): SelectedSource {
  return { provider: 'codex', locator, locatorClass: 'codex-rollout-jsonl', sourceId: 'retry-source',
    authorizedScope: { workspaceId: workspace, allowedRoots: [root] } };
}
function rollout(workspace: string, id = 'synthetic-rollout') {
  return [
    { type: 'session_meta', payload: { id, cwd: workspace }, timestamp: '2026-11-01T00:00:00Z' },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic text' }] }, timestamp: '2026-11-01T00:00:01Z' },
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
}
function claude(workspace: string, id: string) {
  return JSON.stringify({ type: 'user', cwd: workspace, sessionId: id, uuid: id,
    message: { role: 'user', content: 'synthetic Claude' } }) + '\n';
}

describe('compressed Codex and scoped Claude history', () => {
  it('streams equivalent records for plain/compressed synthetic rollouts, including filename identity', async () => {
    const f = await fixture();
    const name = 'rollout-2026-11-01T00-00-00-019d0000-0000-7000-8000-000000000003.jsonl';
    const plain = join(f.codex, name);
    const compressed = plain + '.zst';
    const text = rollout(f.workspace);
    await writeFile(plain, text);
    await writeFile(compressed, zstdCompressSync(text));
    const before = await readdir(f.codex);
    const adapter = new CodexSessionAdapter();
    expect(await collect(adapter.stream(selection(compressed, f.codex, f.workspace))))
      .toEqual(await collect(adapter.stream(selection(plain, f.codex, f.workspace))));
    expect(await adapter.inspect(selection(compressed, f.codex, f.workspace)))
      .toEqual(await adapter.inspect(selection(plain, f.codex, f.workspace)));
    expect(await readdir(f.codex)).toEqual(before);
  });

  it('bounds decompressed record and source bytes and rejects corrupt/truncated streams', async () => {
    const f = await fixture();
    const file = join(f.codex, 'rollout.jsonl.zst');
    const bytes = zstdCompressSync(rollout(f.workspace));
    await writeFile(file, bytes);
    for (const limits of [{ maxRecordBytes: 50 }, { maxTotalBytes: 100 }]) {
      await expect(collect(new CodexSessionAdapter(limits).stream(selection(file, f.codex, f.workspace))))
        .rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    }
    for (const damaged of [bytes.subarray(0, bytes.length - 5), Buffer.from('invalid zstd'), zstdCompressSync(rollout(f.workspace) + '{broken JSON')]) {
      await writeFile(file, damaged);
      await expect(new CodexSessionAdapter().inspect(selection(file, f.codex, f.workspace)))
        .rejects.toMatchObject({ code: 'MALFORMED_SOURCE' });
    }
  });

  itWithSqlite('keeps unsupported, unreadable and excluded sources visible in discovery and preview', async () => {
    const f = await fixture();
    await writeFile(join(f.codex, 'ok.jsonl.zst'), zstdCompressSync(rollout(f.workspace)));
    await writeFile(join(f.codex, 'unsupported.jsonl.gz'), 'unsupported synthetic bytes');
    await writeFile(join(f.codex, 'damaged.jsonl.zst'), 'damaged synthetic bytes');
    await writeFile(join(f.codex, 'excluded.jsonl.zst'), 'excluded without reading');
    const manifest = await discoverWorkspaceHistories({ workspace: f.workspace, expectedProviders: ['codex'],
      codexRoots: [f.codex], exclude: [join(f.codex, 'excluded.jsonl.zst')] });
    expect(publicDiscoveryManifest(manifest).totals).toMatchObject({ sources: 4, unsupported: 1, unreadable: 1, excluded: 1 });
    const preview = previewDiscoveryImport(manifest, null);
    expect(preview.totals).toMatchObject({ unsupported: 1, unreadable: 1, excluded: 1, imported: 0, pending: 1 });
    expect(preview.coverage.acquisitionStatus).toBe('partial');
    const repository = new SessionRepository(join(f.root, 'coverage.sqlite'));
    try {
      const imported = await importDiscoveryManifest({ manifest, repository });
      expect(imported.totals).toMatchObject({ unsupported: 1, unreadable: 1, excluded: 1, imported: 1 });
      expect(imported.coverage.acquisitionStatus).toBe('partial');
    } finally { repository.close(); }
  });

  it('never enumerates siblings or follows junctions outside repeated selected roots', async () => {
    const f = await fixture();
    const nested = join(f.selected, 'subagents');
    await mkdir(nested);
    await writeFile(join(nested, 'nested.jsonl'), claude(f.workspace, 'nested'));
    await writeFile(join(f.other, 'other.jsonl'), claude(f.workspace, 'other'));
    createJunction(f.other, join(f.selected, 'escape'));
    const second = join(f.root, 'Second Project');
    await mkdir(second);
    await writeFile(join(second, 'second.jsonl'), claude(f.workspace, 'second'));
    const enumerate = vi.spyOn(fsPromises, 'opendir');
    const list = vi.spyOn(fsPromises, 'readdir');
    const manifest = await withWindows(() => discoverWorkspaceHistories({ workspace: f.workspace,
      providerHome: f.root, expectedProviders: ['claude'], claudeProjectDirs: [f.selected, second] }));
    expect(manifest.sources.map(source => basename(source.locator)).sort()).toEqual(['nested.jsonl', 'second.jsonl']);
    expect(enumerate.mock.calls.every(([path]) => [f.selected, second].some(root => containsSource(root, String(path))))).toBe(true);
    expect(list.mock.calls.some(([path]) => String(path).includes('.claude'))).toBe(false);
    await expect(discoverWorkspaceHistories({ workspace: f.workspace, expectedProviders: ['claude'],
      claudeProjectDirs: [join(f.selected, 'escape')] })).rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });
    await expect(discoverWorkspaceHistories({ workspace: f.workspace, expectedProviders: ['claude'],
      claudeProjectDirs: [f.selected], authorizedRoots: { claude: [f.other] } }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('handles drive, UNC, case, separators and sibling prefixes with the Windows simulation helper', async () => {
    await withWindows(async () => {
      const drive = windowsPath('C', 'Users', 'Synthetic', 'Project');
      expect(containsSource(drive, 'c:/users/synthetic/project/subagents/session.jsonl')).toBe(true);
      expect(containsSource(drive, windowsPath('C', 'Users', 'Synthetic', 'Project-sibling', 's.jsonl'))).toBe(false);
      expect(containsSource(drive, windowsPath('D', 'Project', 's.jsonl'))).toBe(false);
      const unc = uncPath('server', 'share', 'Project');
      expect(containsSource(unc, uncPath('SERVER', 'SHARE', 'project', 's.jsonl'))).toBe(true);
      expect(containsSource(unc, uncPath('server', 'other', 'Project', 's.jsonl'))).toBe(false);
    });
  });

  itWithSqlite('deduplicates the reporter re-decompression reproducer under the same source ID', async () => {
    const f = await fixture();
    const adapter = new CodexSessionAdapter();
    const repository = new SessionRepository(join(f.root, 'catalog.sqlite'));
    const first = join(f.root, 'stage-one.jsonl');
    const second = join(f.root, 'stage-two.jsonl');
    const bytes = rollout(f.workspace);
    await writeFile(first, bytes);
    const source: SessionSource = { contractVersion: '1.0.0', sourceId: 'retry-source', provider: 'codex',
      providerProfile: 'synthetic', locatorClass: 'codex-rollout-jsonl', redactedLocator: '<session-source>',
      adapterVersion: adapter.adapterVersion, sourceSchemaVersion: '1.0.0', disposition: 'implemented',
      operationalState: 'available', consistency: 'provisional', authorizedAt: '2026-11-01T00:00:00Z', extensions: {} };
    const importer = new IncrementalSessionImporter(repository);
    try {
      const initial = await importer.import({ source, adapter, workspaceId: f.workspace, policyVersion: '1.0.0',
        selectedSource: selection(first, f.root, f.workspace) });
      expect(initial.reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBeGreaterThan(0);
      await rm(first);
      await writeFile(second, bytes);
      const retry = await importer.import({ source, adapter, workspaceId: f.workspace, policyVersion: '1.0.0',
        selectedSource: selection(second, f.root, f.workspace) });
      expect(retry).toEqual([]);
      await writeFile(second, bytes.replace('synthetic text', 'different text'));
      await expect(importer.import({ source, adapter, workspaceId: f.workspace, policyVersion: '1.0.0',
        selectedSource: selection(second, f.root, f.workspace) })).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
    } finally { repository.close(); }
  });

  itWithSqlite('shares exact saved sources across CLI preview/import, mixed formats and retries', async () => {
    const f = await fixture();
    await mkdir(join(f.codex, 'nested'));
    await writeFile(join(f.codex, 'plain.jsonl'), rollout(f.workspace, 'plain'));
    await writeFile(join(f.codex, 'nested', 'compressed.jsonl.zst'), zstdCompressSync(rollout(f.workspace, 'compressed')));
    await writeFile(join(f.selected, 'claude.jsonl'), claude(f.workspace, 'claude'));
    const second = join(f.root, 'Second');
    await mkdir(second);
    await writeFile(join(second, 'second.jsonl'), claude(f.workspace, 'second'));
    const manifestPath = join(f.root, 'manifest.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = ['--workspace', f.workspace, '--manifest', manifestPath, '--expected-providers', 'claude,codex',
      '--claude-project-dir', f.selected, '--claude-project-dir', second, '--codex-root', f.codex, '--json'];
    const ctx = { cwd: f.workspace, frameworkRoot: resolve('.'), rawArgs: [] };
    expect((await sessionsHandler.execute({ ...ctx, args: ['discover', ...args] } as any)).exitCode).toBe(0);
    const manifest = await readDiscoveryManifest(manifestPath);
    expect(manifest.sources).toHaveLength(4);
    await writeDiscoveryManifest(manifestPath, manifest);
    expect((await sessionsHandler.execute({ ...ctx, args: ['import-discovered', ...args, '--dry-run'] } as any)).exitCode).toBe(0);
    const preview = JSON.parse(String(log.mock.calls.at(-1)?.[0])).data.receipt;
    const repository = new SessionRepository(join(f.root, 'catalog.sqlite'));
    try {
      const receipt = await importDiscoveryManifest({ manifest, repository, claudeProjectDirs: [f.selected, second] });
      expect(receipt.run.sources.map(source => source.sourceId)).toEqual(preview.run.sources.map((source: any) => source.sourceId));
      expect(receipt.totals).toMatchObject({ imported: 4, rejected: 0 });
      const again = await importDiscoveryManifest({ manifest, repository });
      expect(again.totals).toMatchObject({ previouslyCommitted: 4, imported: 4 });
      await expect(assertClaudeManifestBoundary(manifest, [f.other])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      const compressed = manifest.sources.find(source => source.locator.endsWith('.zst'))!;
      await writeFile(compressed.locator, 'damaged');
      const rediscovered = await discoverWorkspaceHistories({ workspace: f.workspace,
        expectedProviders: ['codex'], codexRoots: [f.codex] });
      const damaged = await importDiscoveryManifest({ manifest: rediscovered, repository });
      expect(damaged.coverage.acquisitionStatus).toBe('partial');
      expect(damaged.totals.unreadable).toBe(1);
    } finally { repository.close(); }
  });
});
