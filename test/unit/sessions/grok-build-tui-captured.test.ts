// TUI compaction regressions from sanitized 1.0.77 set-b captures; no live CLI.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GrokBuildSessionAdapter, GROK_BUILD_NATIVE_LOCATOR_CLASS, IncrementalSessionImporter,
  type ImportCheckpoint, type ProviderRecord, type SelectedSource, type SessionSource } from '../../../src/sessions/index.js';
import type { SessionRepositoryPort } from '../../../src/sessions/ports.js';

const fixtures = resolve('test/fixtures/sessions/grok-build/captured-1.0.77-20261110b');
const id = '0199f001-1111-7111-8111-000000000001';
const checkpointId = '0199f002-1111-4111-8111-000000000002';
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function collect<T>(input: AsyncIterable<T>) { const out: T[] = []; for await (const item of input) out.push(item); return out; }
async function captured() {
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL', '1');
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', '1.0.77');
  const root = await mkdtemp(join(tmpdir(), 'grok-tui-capture-')); roots.push(root);
  const directory = join(root, encodeURIComponent('/synthetic/workspace'), id);
  await cp(join(fixtures, id), directory, { recursive: true });
  const source: SelectedSource = { provider: 'grok-build', sourceId: 'tui-capture', locator: join(directory, 'chat_history.jsonl'),
    locatorClass: GROK_BUILD_NATIVE_LOCATOR_CLASS, authorizedScope: { workspaceId: 'fixture', allowedRoots: [root] } };
  return { directory, source, adapter: new GrokBuildSessionAdapter() };
}
async function updateRows(directory: string) {
  return (await readFile(join(directory, 'updates.jsonl'), 'utf8')).trimEnd().split('\n').map(l => JSON.parse(l));
}
async function saveUpdates(directory: string, rows: unknown[]) {
  await writeFile(join(directory, 'updates.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

it.each(['absent', 'null'] as const)('imports captured TUI turns with %s kind left unknown and one compaction event', async kind => {
  const { source, adapter, directory } = await captured();
  if (kind === 'null') {
    const path = join(directory, 'summary.json');
    const summary = JSON.parse(await readFile(path, 'utf8')); summary.session_kind = null;
    await writeFile(path, JSON.stringify(summary));
  }
  expect(await collect(adapter.discover(source.authorizedScope))).toMatchObject([{ nativeSessionId: id }]);
  const records = await collect(adapter.stream(source));
  expect(records.map(r => [r.kind, r.role, r.text])).toEqual([
    ['message', 'user', 'Remember the code word TULIP. Reply with just OK. Do not run any tools.'],
    ['message', 'assistant', 'OK'], ['compaction', undefined, ''],
    ['message', 'user', 'What was the code word? Reply with just the word. Do not run any tools.'],
    ['message', 'assistant', 'TULIP'],
  ]);
  expect(records[2]).toMatchObject({ occurredAt: '2026-11-11T02:47:55.348Z', extensions: {
    compaction: { tokensBefore: 30903, tokensAfter: 30903, checkpointId, promptIndexAtCompaction: 1 },
  } });
  for (const record of records) {
    expect(record.extensions?.provenance).not.toHaveProperty('sessionKind');
    expect(record.extensions?.provenance).toMatchObject({ acquisition: 'grok-build-native-updates', grokVersion: '1.0.77' });
  }
  expect(JSON.stringify(records)).not.toMatch(/Synthetic omitted|compaction_checkpoints|interactive|\/compact/);
  expect(new Set(records.map(r => r.nativeEventId)).size).toBe(5);
  expect(await collect(adapter.stream(source))).toEqual(records);
  expect(await collect(adapter.stream(source, { value: records.at(-1)!.sourceCursor! }))).toEqual([]);
});

it.each(['bad-kind', 'bad-checkpoint-index', 'missing-prompt', 'bad-checkpoint-schema', 'bad-checkpoint-id', 'duplicate-checkpoint',
  'unfinished-checkpoint', 'missing-completion', 'missing-updates', 'truncated-updates', 'unknown-update'] as const)
('fails closed on TUI %s', async mode => {
  const { source, adapter, directory } = await captured();
  const rows = await updateRows(directory);
  const checkpointAt = rows.findIndex(r => r.params.update.sessionUpdate === 'compaction_checkpoint');
  if (mode === 'bad-kind') {
    const path = join(directory, 'summary.json');
    const summary = JSON.parse(await readFile(path, 'utf8')); summary.session_kind = 'tui';
    await writeFile(path, JSON.stringify(summary));
  }
  if (mode === 'bad-checkpoint-index') rows[checkpointAt].params.update.prompt_index_at_compaction = 2;
  if (mode === 'bad-checkpoint-schema') rows[checkpointAt].params.update.schema_version = 2;
  if (mode === 'bad-checkpoint-id') rows[checkpointAt].params.update.checkpoint_id = 'invalid';
  if (mode === 'duplicate-checkpoint') rows.splice(checkpointAt, 0, rows[checkpointAt]);
  if (mode === 'missing-prompt') rows.splice(1, 1);
  if (mode === 'unfinished-checkpoint') rows.splice(checkpointAt + 1);
  if (mode === 'missing-completion') rows.splice(checkpointAt + 1, 1);
  if (mode === 'unknown-update') rows[checkpointAt].params.update.sessionUpdate = 'future_compaction';
  await saveUpdates(directory, rows);
  if (mode === 'missing-updates') await rm(join(directory, 'updates.jsonl'));
  if (mode === 'truncated-updates') await writeFile(join(directory, 'updates.jsonl'), '{"timestamp":');
  await expect(adapter.inspect(source)).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
});

it('retains TUI prefix identities across compaction and imports each turn exactly once', async () => {
  const { source, adapter, directory } = await captured();
  const history = await readFile(source.locator, 'utf8');
  const rows = await updateRows(directory);
  const checkpointAt = rows.findIndex(r => r.params.update.sessionUpdate === 'compaction_checkpoint');
  await saveUpdates(directory, rows.slice(0, checkpointAt));
  await writeFile(source.locator, JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'Synthetic pre-compaction history.' }] }) + '\n');
  let checkpoint: ImportCheckpoint | null = null;
  const events = new Map<string, unknown>();
  const repository: SessionRepositoryPort = {
    getCheckpoint: () => checkpoint, getBatchCheckpoint: () => null, commitStagedImports: () => 0,
    applyImport(batch, next) {
      const before = events.size;
      for (const event of batch.events) {
        expect((event.extensions['native.grok-build'] as ProviderRecord['extensions'])?.provenance).not.toHaveProperty('sessionKind');
        events.set(event.eventId, event);
      }
      checkpoint = { ...next };
      return { operationId: batch.run.importRunId, outcome: 'committed', sessionsInserted: batch.sessions.length,
        eventsInserted: events.size - before, checkpoint };
    },
  };
  const sessionSource: SessionSource = { contractVersion: '1.0.0', sourceId: source.sourceId, provider: 'grok-build', providerProfile: 'native',
    locatorClass: source.locatorClass, redactedLocator: '<fixture>', adapterVersion: adapter.adapterVersion, disposition: 'implemented',
    ...await adapter.inspect(source), authorizedAt: '2026-11-10T00:00:00Z', extensions: {} };
  const importer = new IncrementalSessionImporter(repository);
  const request = { source: sessionSource, selectedSource: source, adapter, workspaceId: 'fixture', policyVersion: '1.0.0', limits: { batchSize: 2 } };
  const before = await collect(adapter.stream(source));
  expect((await importer.import(request)).reduce((n, r) => n + r.eventsInserted, 0)).toBe(2);
  await writeFile(source.locator, history); await saveUpdates(directory, rows);
  const complete = await collect(adapter.stream(source));
  expect(complete.slice(0, before.length)).toEqual(before);
  expect((await importer.import(request)).reduce((n, r) => n + r.eventsInserted, 0)).toBe(3);
  expect(await importer.import(request)).toEqual([]);
  expect(events.size).toBe(5);
  // A checkpoint belongs to the compaction event's immutable source evidence.
  const changedId = '0199f004-1111-4111-8111-000000000004';
  rows[checkpointAt].params.update.checkpoint_id = changedId;
  rows[checkpointAt].params.update.checkpoint_file = `compaction_checkpoints/${changedId}.json`;
  await saveUpdates(directory, rows);
  await expect(importer.import(request)).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
});
