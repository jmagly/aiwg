import { appendFile, cp, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OmpSessionAdapter, PiSessionAdapter, IncrementalSessionImporter, SessionRepository, SessionSourceSchema, stableSessionId, discoverWorkspaceHistories, importDiscoveryManifest, type SelectedSource } from '../../../src/sessions/index.js';
import { itWithSqlite } from '../../helpers/sqlite.js';
const fixtures = resolve('test/fixtures/sessions/omp');
const roots: string[] = [];
async function temp() { const root = await mkdtemp(join(tmpdir(), 'omp-sessions-')); roots.push(root); return root; }
const selected = (name = 'title-slot.jsonl', root = fixtures): SelectedSource => ({ provider: 'omp', locator: join(root, name), sourceId: 'omp-source', locatorClass: 'omp-session-v3-jsonl', authorizedScope: { workspaceId: '/workspace', allowedRoots: [root] } });
async function collect(source: SelectedSource, cursor?: string, adapter = new OmpSessionAdapter()) { const rows = []; for await (const row of adapter.stream(source, cursor ? { value: cursor } : undefined)) rows.push(row); return rows; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('OMP native sessions', () => {
  it('reads title-prefixed and legacy header-first v3 files with distinct Pi fingerprint', async () => {
    const adapter = new OmpSessionAdapter();
    expect(await adapter.inspect(selected())).toMatchObject({ sourceSchemaVersion: '3.0.0' });
    const rows = await collect(selected());
    expect(rows).toHaveLength(8);
    expect((await collect(selected('header-first.jsonl'))).map(row => row.nativeEventId)).toEqual(rows.map(row => row.nativeEventId));
    expect(rows[0]).toMatchObject({ nativeSessionId: 'omp-native-id', extensions: { provenance: { parentSession: '/prior/fork.jsonl', previousSessionFiles: ['/prior/moved.jsonl'] } } });
    expect(rows[1]).toMatchObject({ model: 'openrouter/test', extensions: { role: 'smol', resolvedModelIsFallback: true } });
    expect(rows[2]).toMatchObject({ extensions: { purpose: 'title', usage: { input: 5, output: 2, cost: { total: .01 } } } });
    expect(rows[3]).toMatchObject({ activityBoundary: 'continuation', extensions: { firstKeptEntryId: 'a' } });
    expect(rows[4]).toMatchObject({ extensions: { fromId: 'b', parentId: 'a' } });
    expect(rows[7]).toMatchObject({ extensions: { opaque: true, nativeType: 'future_entry' } });
    expect(JSON.stringify(rows)).not.toContain('SECRET_CANARY');
    await expect(new PiSessionAdapter().inspect({ ...selected(), provider: 'pi' })).rejects.toMatchObject({ code: 'MALFORMED_SOURCE' });
    expect(await collect(selected(), rows[5].sourceCursor)).toEqual(rows.slice(6));
    await expect(collect(selected(), 'byte:300')).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  });
  it.each([['missing-header.jsonl', 'MALFORMED_SOURCE'], ['malformed-title.jsonl', 'MALFORMED_SOURCE'], ['unknown-major.jsonl', 'UNKNOWN_SCHEMA_MAJOR'], ['truncated.jsonl', 'TRUNCATED_SOURCE']])('rejects %s', async (file, code) => {
    await expect(collect(selected(file))).rejects.toMatchObject({ code });
    await expect(new OmpSessionAdapter().inspect(selected(file))).rejects.toMatchObject({ code });
  });
  it('enforces roots, symlinks, byte and file limits', async () => {
    const root = await temp();
    await symlink(join(fixtures, 'title-slot.jsonl'), join(root, 'linked.jsonl'));
    await expect(collect(selected('linked.jsonl', root))).rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
    await expect(collect({ ...selected(), authorizedScope: { workspaceId: 'x', allowedRoots: [root] } })).rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
    await expect(new OmpSessionAdapter({ maxRecordBytes: 10 }).inspect(selected())).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    await expect(collect(selected(), undefined, new OmpSessionAdapter({ maxTotalBytes: 300 }))).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    const discover = async () => { for await (const _ of new OmpSessionAdapter(undefined, 1).discover(selected().authorizedScope)) {} };
    await expect(discover()).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
  });
  itWithSqlite('imports idempotently through persistent checkpoints after title rewrite plus append', async () => {
    const root = await temp(); await cp(join(fixtures, 'title-slot.jsonl'), join(root, 'title-slot.jsonl'));
    const selection = selected('title-slot.jsonl', root);
    const source = SessionSourceSchema.parse({ contractVersion: '1.0.0', sourceId: selection.sourceId, provider: 'omp', providerProfile: 'native-title-slot-v3', locatorClass: selection.locatorClass, redactedLocator: '<omp>', adapterVersion: '1.0.0', sourceSchemaVersion: '3.0.0', disposition: 'implemented', operationalState: 'available', consistency: 'complete', authorizedAt: '2026-09-04T12:00:00Z' });
    const db = join(root, 'sessions.db'); let repository = new SessionRepository(db);
    const request = { source, selectedSource: selection, adapter: new OmpSessionAdapter(), workspaceId: '/workspace', policyVersion: '1.0.0' };
    await new IncrementalSessionImporter(repository).import(request);
    const id = stableSessionId('omp', selection.sourceId, 'omp-native-id');
    expect(repository.listEvents(id)).toHaveLength(8); repository.close();
    const text = await readFile(selection.locator, 'utf8');
    const handle = await open(selection.locator, 'r+'); await handle.write(text.slice(0,256).replace('Initial','Changed'), 0, 'utf8'); await handle.close();
    repository = new SessionRepository(db);
    const importer = new IncrementalSessionImporter(repository);
    expect(await importer.import(request)).toEqual([]);
    await appendFile(selection.locator, JSON.stringify({ type: 'message', id: 'new', parentId: 'a', timestamp: '2026-09-04T12:01:00Z', message: { role: 'assistant', content: 'Appended' } })+'\n');
    await importer.import(request);
    expect(repository.listEvents(id)).toHaveLength(9);
    expect(await importer.import(request)).toEqual([]);
    const file = await open(selection.locator, 'r+'); await file.write(text.slice(256).replace('Review OMP', 'REVIEW OMP'), 256, 'utf8'); await file.close();
    await expect(importer.import(request)).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' }); repository.close();
  });
  itWithSqlite('discovers only authorized OMP roots matching workspace', async () => {
    const root = await temp(); const workspace = await temp();
    const content = (await readFile(join(fixtures,'title-slot.jsonl'),'utf8')).replace('"cwd":"/workspace"', `"cwd":${JSON.stringify(workspace)}`);
    await writeFile(join(root,'matching.jsonl'), content);
    await cp(join(fixtures,'title-slot.jsonl'),join(root,'other.jsonl'));
    const manifest = await discoverWorkspaceHistories({ workspace, ompRoot: root });
    expect(manifest.sources.filter(s => s.provider === 'omp')).toHaveLength(1);
    const repository = new SessionRepository();
    try {
      expect((await importDiscoveryManifest({manifest, repository})).totals.accepted).toBe(1);
      await appendFile(join(root, 'matching.jsonl'), JSON.stringify({type:'message', id:'appended', parentId:'a', timestamp:'2026-09-04T12:01:00Z', message:{role:'user',content:'More'}})+'\n');
      const refreshed = await discoverWorkspaceHistories({workspace, ompRoot: root});
      expect(refreshed.sources[0].sourceId).toBe(manifest.sources[0].sourceId);
      expect((await importDiscoveryManifest({manifest: refreshed, repository})).totals.accepted).toBe(1);
      expect(repository.listEvents(stableSessionId('omp', refreshed.sources[0].sourceId, 'omp-native-id'))).toHaveLength(9);
    } finally { repository.close(); }
    expect((await discoverWorkspaceHistories({workspace})).sources.filter(s => s.provider === 'omp')).toHaveLength(0);
  });
});
