// Released 1.0.92 attachment/cancellation/resume/fork captures, replayed offline.
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GrokBuildSessionAdapter, GROK_BUILD_NATIVE_LOCATOR_CLASS,
  GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS, IncrementalSessionImporter,
  type ImportCheckpoint, type SelectedSource, type SessionSource } from '../../../src/sessions/index.js';
import { parseGrokHeadlessSessionId } from '../../../src/sessions/grok-build-cli.js';
import type { SessionRepositoryPort } from '../../../src/sessions/ports.js';

const fixtures = resolve('test/fixtures/sessions/grok-build/captured-1.0.92-20261123');
const attached = '01a20a15-4a9e-7b31-bec4-1f0e7ec2a5d2';
const resumed = '01a20a15-6029-7a11-82a4-9adae4461f51';
const forked = '01a20a15-88f5-7f43-94c1-ce69b0d6a1ff';
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function collect<T>(input: AsyncIterable<T>) { const out: T[] = []; for await (const item of input) out.push(item); return out; }
async function captured(id = attached) {
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL', '1');
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', '1.0.92');
  const root = await mkdtemp(join(tmpdir(), 'grok-nov23-')); roots.push(root);
  const directory = join(root, encodeURIComponent('/absolute/temp/project'), id);
  await cp(join(fixtures, id), directory, { recursive: true });
  const source: SelectedSource = { provider: 'grok-build', sourceId: `capture-${id}`, locator: join(directory, 'chat_history.jsonl'),
    locatorClass: GROK_BUILD_NATIVE_LOCATOR_CLASS, authorizedScope: { workspaceId: 'fixture', allowedRoots: [root] } };
  return { root, directory, source, adapter: new GrokBuildSessionAdapter() };
}

it('attributes inline file text to its captured prompt without acquiring external snapshots', async () => {
  const { source, adapter, directory, root } = await captured();
  const records = await collect(adapter.stream(source));
  const prompt = records.find(r => r.text?.includes('<attached_files>'))!;
  expect(prompt.text).toContain('1→Release checklist (synthetic fixture)');
  expect(prompt.extensions).toMatchObject({
    provenance: { grokVersion: '1.0.92' },
    attachments: { acquisitionMode: 'inline-prompt-text', ownerSessionId: attached, promptIndex: 0, externalFilesRead: false },
    lossReport: { unavailable: ['eventTimestamps', 'externalAttachments', 'fileSnapshots'] },
  });
  expect(records.find(r => r.role === 'assistant')?.extensions).not.toHaveProperty('attachments');
  expect(records.every(r => r.occurredAt === undefined)).toBe(true);
  // These stores are outside the qualified projection, even when present or linked.
  const privateFile = join(root, 'private-snapshot'); await writeFile(privateFile, 'snapshot-canary');
  await rm(join(directory, 'rewind_points.jsonl'));
  await symlink(privateFile, join(directory, 'rewind_points.jsonl'));
  await symlink(privateFile, join(directory, 'notes.txt'));
  expect(await collect(adapter.stream(source))).toEqual(records);
  expect(JSON.stringify(records)).not.toContain('snapshot-canary');
});

it('leaves an unexposed prompt index absent and treats assistant file markup as response text', async () => {
  const { source, adapter } = await captured();
  const rows = (await readFile(source.locator, 'utf8')).trimEnd().split('\n').map(l => JSON.parse(l));
  const prompt = rows.find(r => r.prompt_index === 0);
  delete prompt.prompt_index;
  rows.push({ type: 'assistant', content: prompt.content[0].text });
  await writeFile(source.locator, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const records = await collect(adapter.stream(source));
  const owned = records.find(r => r.role === 'user' && r.text?.includes('<attached_files>'))!;
  expect(owned.extensions?.attachments).toMatchObject({ ownerSessionId: attached, externalFilesRead: false });
  expect(owned.extensions?.attachments).not.toHaveProperty('promptIndex');
  expect(records.at(-1)?.extensions).not.toHaveProperty('attachments');
});

it.each([[attached, 's1-attach'], [resumed, 's2-bigtool'], [resumed, 's3-continue'], [forked, 's4-fork']])
('extracts the released stream ID %s from %s including cancellation', async (id, name) => {
  expect(parseGrokHeadlessSessionId(await readFile(join(fixtures, `${name}.jsonl`), 'utf8'), 'streaming-json')).toBe(id);
});

it('retains cancelled tool output, same-ID continuation and explicit fork lineage', async () => {
  const { source, adapter } = await captured(resumed);
  const records = await collect(adapter.stream(source));
  const call = records.find(r => r.kind === 'tool-call')!;
  expect(records.find(r => r.kind === 'tool-result')).toMatchObject({
    toolCallId: call.toolCallId, text: 'User cancelled the execution for tool `run_terminal_command`',
  });
  expect(records.find(r => r.text === 'continued-ok')).toMatchObject({ nativeSessionId: resumed, model: 'grok-4.7-build-fast' });
  expect(records[0].extensions).not.toHaveProperty('attachments');
  const child = await captured(forked);
  const childRecords = await collect(child.adapter.stream(child.source));
  expect(childRecords.at(-1)?.text).toBe('forked-ok');
  expect(childRecords.every(r => r.nativeSessionId === forked)).toBe(true);
  expect(childRecords[0].extensions).toMatchObject({ lineage: { parentSessionId: resumed, forkedAt: '2026-11-23T20:25:13.207117059Z' } });
  expect(await collect(adapter.stream(source))).toEqual(records);
  expect(await collect(adapter.stream(source, { value: records.at(-1)!.sourceCursor! }))).toEqual([]);
});

it.each([attached, resumed, forked])('imports the public export %s with explicit missing native evidence', async id => {
  const { root, source, adapter } = await captured(id);
  const locator = join(root, `${id}.md`);
  await cp(join(fixtures, `export-${id}.md`), locator);
  const selected = { ...source, locator, locatorClass: GROK_BUILD_CLI_EXPORT_LOCATOR_CLASS };
  const records = await collect(adapter.stream(selected));
  expect(records[0].extensions).toMatchObject({ provenance: { toolOutputAvailable: false, nativeStoreInspected: false },
    lossReport: { unavailableInCliExport: expect.arrayContaining(['attachments', 'fileSnapshots', 'lineage']) } });
  expect(records.some(r => r.text?.includes('<attached_files>') || r.kind === 'tool-result')).toBe(false);
  expect(await collect(adapter.stream(selected))).toEqual(records);
});

it.each(['schema', 'block', 'partial', 'corrupt'] as const)('fails closed on %s drift in the attachment capture', async mode => {
  const { directory, source, adapter } = await captured();
  if (mode === 'schema') {
    const path = join(directory, 'summary.json');
    const summary = JSON.parse(await readFile(path, 'utf8')); summary.chat_format_version = 2;
    await writeFile(path, JSON.stringify(summary));
  } else {
    const suffix = mode === 'block' ? '{"type":"user","content":[{"type":"file","path":"notes.txt"}]}\n'
      : mode === 'partial' ? '{"type":"user"' : 'not-json\n';
    await writeFile(source.locator, await readFile(source.locator, 'utf8') + suffix);
  }
  await expect(adapter.inspect(source)).rejects.toMatchObject({ code: 'SCHEMA_DRIFT', message: expect.stringContaining('grok export') });
});

it('imports attachment/fork captures idempotently through normalization and repository checkpoints', async () => {
  for (const id of [attached, forked]) {
    const { source, adapter } = await captured(id);
    let checkpoint: ImportCheckpoint | null = null;
    const eventIds = new Set<string>();
    let ownedPrompts = 0;
    const repository: SessionRepositoryPort = {
      getCheckpoint: () => checkpoint, getBatchCheckpoint: () => null, commitStagedImports: () => 0,
      applyImport(batch, next) {
        const before = eventIds.size;
        for (const event of batch.events) {
          eventIds.add(event.eventId);
          const native = event.extensions['native.grok-build'];
          if (id === attached && JSON.stringify(native).includes('inline-prompt-text')) {
            ownedPrompts += 1;
            expect(native).toMatchObject({ attachments: { ownerSessionId: attached, promptIndex: 0, externalFilesRead: false } });
          }
        }
        if (id === forked) for (const session of batch.sessions) expect(session.extensions['native.grok-build']).toMatchObject({ lineage: { parentSessionId: resumed } });
        checkpoint = { ...next };
        return { operationId: batch.run.importRunId, outcome: 'committed', sessionsInserted: batch.sessions.length,
          eventsInserted: eventIds.size - before, checkpoint };
      },
    };
    const sessionSource: SessionSource = { contractVersion: '1.0.0', sourceId: source.sourceId, provider: 'grok-build', providerProfile: 'native',
      locatorClass: source.locatorClass, redactedLocator: '<fixture>', adapterVersion: adapter.adapterVersion, disposition: 'implemented',
      ...await adapter.inspect(source), authorizedAt: '2026-11-23T00:00:00Z', extensions: {} };
    const importer = new IncrementalSessionImporter(repository);
    const request = { source: sessionSource, selectedSource: source, adapter, workspaceId: 'fixture', policyVersion: '1.0.0' };
    expect((await importer.import(request)).reduce((n, r) => n + r.eventsInserted, 0)).toBe((await collect(adapter.stream(source))).length);
    expect(await importer.import(request)).toEqual([]);
    if (id === attached) expect(ownedPrompts).toBe(1);
  }
});
