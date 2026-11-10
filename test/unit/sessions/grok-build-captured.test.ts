// Regressions derived from sanitized Grok Build 1.0.77 captures; no model calls.
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { grokBuildList, grokBuildSearch, parseGrokHeadlessSessionId } from '../../../src/sessions/grok-build-cli.js';
import { GrokBuildSessionAdapter, GROK_BUILD_NATIVE_LOCATOR_CLASS, IncrementalSessionImporter, type ImportCheckpoint, type SessionSource, type SelectedSource } from '../../../src/sessions/index.js';

import type { SessionRepositoryPort } from '../../../src/sessions/ports.js';

const fixtures = resolve('test/fixtures/sessions/grok-build/captured-1.0.77');
const id = '0199c111-1111-7111-8111-111111111111';
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function collect<T>(input: AsyncIterable<T>) { const out: T[] = []; for await (const item of input) out.push(item); return out; }
async function temp() { const p = await mkdtemp(join(tmpdir(), 'grok-capture-')); roots.push(p); return p; }
function selected(locator: string, root: string, locatorClass = GROK_BUILD_NATIVE_LOCATOR_CLASS): SelectedSource {
  return { provider: 'grok-build', sourceId: 'capture', locator, locatorClass, authorizedScope: { workspaceId: 'fixture', allowedRoots: [root] } };
}

it('imports captured multiline tool commands without inventing tool output', async () => {
  const adapter = new GrokBuildSessionAdapter();
  const source = selected(join(fixtures, `${id}.md`), fixtures, 'grok-build-cli-markdown-export');
  const records = await collect(adapter.stream(source));
  expect(records.filter(r => r.kind === 'tool-call')).toHaveLength(3);
  expect(records.find(r => r.kind === 'tool-call')?.text).toContain("\nAIWG_REQUEST");
  expect(records.some(r => r.kind === 'tool-result')).toBe(false);
  expect(records[0].extensions).toMatchObject({ lossReport: { unavailableInCliExport: expect.arrayContaining(['toolResults', 'timestamps']) } });
  expect(await collect(adapter.stream(source))).toEqual(records);
});

it('accepts captured list/search and rejects changed row grammars', async () => {
  const cwd = await temp();
  const run = (stdout: string) => ({ cwd, env: { GROK_HOME: join(cwd, '.grok'), PATH: '' }, runner: vi.fn(async () => ({ stdout, stderr: '' })) });
  expect(await grokBuildList(run(await readFile(join(fixtures, 'sessions-list.txt'), 'utf8')))).toEqual([id]);
  expect(await grokBuildSearch(run(await readFile(join(fixtures, 'sessions-search.txt'), 'utf8')), 'Example')).toEqual([id]);
  for (const stdout of [`${id} CHANGED\n`, 'SESSION ID CHANGED\n', `No sessions found.\n${id} CHANGED\n`]) {
    await expect(grokBuildList(run(stdout))).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  }
  await expect(grokBuildSearch(run(`Total: 1\n  orphan snippet\n`), 'Example')).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
});

it('validates captured headless envelopes and rejects unknown streaming events', async () => {
  expect(parseGrokHeadlessSessionId(await readFile(join(fixtures, 'headless.json'), 'utf8'), 'json')).toBe(id);
  const stream = await readFile(join(fixtures, 'streaming.jsonl'), 'utf8');
  expect(parseGrokHeadlessSessionId(stream, 'streaming-json')).toBe(id);
  expect(() => parseGrokHeadlessSessionId(`${stream}{"type":"changed","sessionId":"${id}"}\n`, 'streaming-json')).toThrowError(/SCHEMA_DRIFT|unrecognized/i);
  expect(() => parseGrokHeadlessSessionId(`{"type":"tool_call","toolCallId":"call-fixture","content":[],"locations":[]}\n${stream}`, 'streaming-json')).toThrowError(/unrecognized/);
});

it('requires an exact native version pin even after the experimental opt-in', async () => {
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL', '1');
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', '1.0.78');
  await expect(collect(new GrokBuildSessionAdapter().discover({ workspaceId: 'fixture', allowedRoots: [fixtures] })))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION', message: expect.stringMatching(/1\.0\.77.*grok export/) });
});

it('imports the captured native schema with model and cwd provenance, without fabricated timestamps', async () => {
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL', '1');
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', '1.0.77');
  const root = await temp();
  const directory = join(root, encodeURIComponent('/synthetic/workspace'), id);
  await mkdir(directory, { recursive: true });
  for (const file of ['chat_history.jsonl', 'summary.json']) await cp(join(fixtures, file), join(directory, file));
  const source = selected(join(directory, 'chat_history.jsonl'), root);
  const adapter = new GrokBuildSessionAdapter();
  const records = await collect(adapter.stream(source));
  expect(records.map(r => r.kind)).toEqual(['message', 'message', 'tool-call', 'tool-result', 'message']);
  expect(records[1].model).toBe('grok-4.7-build');
  expect(records.every(r => r.occurredAt === undefined)).toBe(true);
  expect(records[0].extensions).toMatchObject({ provenance: { grokVersion: '1.0.77', workingDirectory: '/synthetic/workspace', sessionCreatedAt: '2026-11-09T22:48:04.991625671Z', sessionUpdatedAt: '2026-11-09T22:54:29.223220284Z', currentModelId: 'grok-4.7' } });
  expect(await collect(adapter.stream(source))).toEqual(records);
  expect((records[0].extensions?.provenance as Record<string, unknown>)).not.toHaveProperty('sessionKind');
  await writeFile(join(directory, 'summary.json'), '{"chat_format_version":2}\n');
  await expect(adapter.inspect(source)).rejects.toMatchObject({ code: 'SCHEMA_DRIFT', message: expect.stringContaining('grok export') });
});

it('rejects native discovery through a symlinked or filesystem root before enumerating', async () => {
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL', '1');
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', '1.0.77');
  const root = await temp();
  await symlink(fixtures, join(root, 'escape'));
  const adapter = new GrokBuildSessionAdapter();
  await expect(collect(adapter.discover({ workspaceId: 'fixture', allowedRoots: [join(root, 'escape')] }))).rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });
  await expect(collect(adapter.discover({ workspaceId: 'fixture', allowedRoots: ['/'] }))).rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
});

it('keeps skipped system/reminder/reasoning content out of native imports and rejects attachments', async () => {
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL', '1');
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', '1.0.77');
  const root = await temp();
  const directory = join(root, encodeURIComponent('/synthetic/workspace'), id);
  await mkdir(directory, { recursive: true });
  await cp(join(fixtures, 'summary.json'), join(directory, 'summary.json'));
  const locator = join(directory, 'chat_history.jsonl');
  const content = await readFile(join(fixtures, 'chat_history.jsonl'), 'utf8');
  const omitted = [
    { type: 'system', content: 'omitted-system-canary' },
    { type: 'user', synthetic_reason: 'system_reminder', content: [{ type: 'text', text: 'omitted-reminder-canary' }] },
    { type: 'reasoning', id: 'reasoning-fixture', summary: [], encrypted_content: 'omitted-reasoning-canary', status: 'completed' },
  ];
  await writeFile(locator, omitted.map(r => JSON.stringify(r)).join('\n') + '\n' + content);
  const source = selected(locator, root);
  const adapter = new GrokBuildSessionAdapter();
  const records = await collect(adapter.stream(source));
  expect(records).toHaveLength(5);
  expect(JSON.stringify(records)).not.toContain('-canary');
  expect(records[0].extensions).toMatchObject({ lossReport: { excludedRecordTypes: ['system', 'system_reminder', 'reasoning'] } });
  for (const value of ['9007199254740992', '9'.repeat(400)]) await expect(collect(adapter.stream(source, { value }))).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  await writeFile(locator, content + '{"type":"user","content":[{"type":"image","path":"/synthetic/file"}]}\n');
  await expect(adapter.inspect(source)).rejects.toMatchObject({ code: 'SCHEMA_DRIFT', message: expect.stringContaining('grok export') });
  await writeFile(locator, content + '{"type":"user"');
  await expect(adapter.inspect(source)).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  await writeFile(locator, content + 'corrupt\n');
  await expect(adapter.inspect(source)).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
});

it.each([undefined, '', '1.0.76', '1.0.78', '^1.0.77', '1.0.77-preview'])('refuses native version %s after opt-in', async version => {
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL', '1');
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', version);
  expect(new GrokBuildSessionAdapter().supportedOperations).toEqual(['inspect', 'stream']);
  await expect(collect(new GrokBuildSessionAdapter().discover({ workspaceId: 'fixture', allowedRoots: [fixtures] }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
});

it.each(['cli', 'native', 'fallback'] as const)('imports %s deterministically and idempotently through the repository port', async mode => {
  let adapter = new GrokBuildSessionAdapter();
  let source = selected(join(fixtures, `${id}.md`), fixtures, 'grok-build-cli-markdown-export');
  if (mode !== 'cli') {
    vi.stubEnv('AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL', '1');
    vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', '1.0.77');
    const root = await temp();
    const cwd = join(root, 'workspace');
    const grokHome = join(root, '.grok');
    const directory = join(grokHome, 'sessions', encodeURIComponent(cwd), id);
    await mkdir(cwd); await mkdir(directory, { recursive: true });
    for (const file of ['chat_history.jsonl', 'summary.json']) await cp(join(fixtures, file), join(directory, file));
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    summary.info.cwd = cwd;
    await writeFile(join(directory, 'summary.json'), JSON.stringify(summary));
    if (mode === 'fallback') {
      await writeFile(join(directory, 'chat_history.jsonl'), '{"type":"changed"}\n');
      const stdout = await readFile(join(fixtures, `${id}.md`), 'utf8');
      adapter = new GrokBuildSessionAdapter(undefined, undefined, { cwd, env: { GROK_HOME: grokHome, PATH: '' }, runner: async () => ({ stdout, stderr: '' }) });
    }
    source = selected(join(directory, 'chat_history.jsonl'), root);
  }
  const sessionSource: SessionSource = {
    contractVersion: '1.0.0', sourceId: source.sourceId, provider: 'grok-build',
    providerProfile: mode, locatorClass: source.locatorClass, redactedLocator: '<fixture>',
    adapterVersion: adapter.adapterVersion, disposition: 'implemented',
    ...await adapter.inspect(source), authorizedAt: '2026-11-09T00:00:00Z', extensions: {},
  };
  async function importTwice() {
    let checkpoint: ImportCheckpoint | null = null;
    const eventIds = new Set<string>();
    const repository: SessionRepositoryPort = {
      getCheckpoint: () => checkpoint, getBatchCheckpoint: () => null, commitStagedImports: () => 0,
      applyImport(batch, next) {
        const before = eventIds.size;
        for (const event of batch.events) {
          eventIds.add(event.eventId);
          expect(event.extensions['native.grok-build']).toMatchObject({ provenance: {
            toolOutputAvailable: mode === 'native',
            ...(mode === 'native' ? { sessionCreatedAtMs: Date.parse('2026-11-09T22:48:04.991625671Z') } : {}),
          } });
        }
        checkpoint = { ...next };
        return { operationId: batch.run.importRunId, outcome: 'committed',
          sessionsInserted: batch.sessions.length, eventsInserted: eventIds.size - before, checkpoint };
      },
    };
    const importer = new IncrementalSessionImporter(repository);
    const request = { source: sessionSource, selectedSource: source, adapter, workspaceId: 'fixture', policyVersion: '1.0.0', limits: { batchSize: 2 } };
    const receipts = await importer.import(request);
    expect(receipts.reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(mode === 'native' ? 5 : 7);
    expect(await importer.import(request)).toEqual([]);
    return [...eventIds].sort();
  }
  expect(await importTwice()).toEqual(await importTwice());
});

it('automatically falls back to bounded CLI export on native drift and replays its cursor', async () => {
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL', '1');
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', '1.0.77');
  const root = await temp();
  const cwd = join(root, 'workspace');
  const grokHome = join(root, '.grok');
  const store = join(grokHome, 'sessions');
  const directory = join(store, encodeURIComponent(cwd), id);
  await mkdir(cwd); await mkdir(directory, { recursive: true });
  const summary = JSON.parse(await readFile(join(fixtures, 'summary.json'), 'utf8'));
  summary.info.cwd = cwd;
  await writeFile(join(directory, 'summary.json'), JSON.stringify(summary));
  await writeFile(join(directory, 'chat_history.jsonl'), '{"type":"changed"}\n');
  const runner = vi.fn(async (_binary: string, args: string[], options: { cwd: string }) => {
    expect(args).toEqual(['--no-auto-update', 'export', id]);
    expect(options.cwd).toBe(cwd);
    return { stdout: '## User\n\nSynthetic prompt.\n\n## Assistant\n\nSynthetic response.\n', stderr: '' };
  });
  const adapter = new GrokBuildSessionAdapter(undefined, undefined, { cwd, env: { GROK_HOME: grokHome, PATH: '' }, runner });
  const source = selected(join(directory, 'chat_history.jsonl'), store);
  expect(await adapter.inspect(source)).toMatchObject({ consistency: 'complete' });
  const records = await collect(adapter.stream(source));
  expect(records).toHaveLength(2);
  expect(records[0].extensions).toMatchObject({ provenance: { acquisition: 'grok-cli-export-markdown', nativeFallback: true, toolOutputAvailable: false } });
  expect(records[1].sourceCursor).toMatch(/^grok-cli:2:[a-f0-9]{64}$/);
  expect(await collect(adapter.stream(source, { value: records[1].sourceCursor! }))).toEqual([]);
  expect(runner).toHaveBeenCalledTimes(3);
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', '1.0.78');
  expect(await collect(adapter.stream(source))).toEqual(records);
  await expect(collect(adapter.stream(source, { value: '1' }))).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  expect(runner).toHaveBeenCalledTimes(4);
  const wrongHome = new GrokBuildSessionAdapter(undefined, undefined, { cwd, env: { GROK_HOME: join(root, 'other-home'), PATH: '' }, runner });
  await expect(wrongHome.inspect(source)).rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
  const changedOutput = new GrokBuildSessionAdapter(undefined, undefined, { cwd, env: { GROK_HOME: grokHome, PATH: '' }, runner: async () => ({ stdout: 'changed output', stderr: '' }) });
  await expect(changedOutput.inspect(source)).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  await rm(source.locator);
  await symlink(join(fixtures, 'chat_history.jsonl'), source.locator);
  await expect(adapter.inspect(source)).rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });
  expect(runner).toHaveBeenCalledTimes(4);
});

const variants = resolve('test/fixtures/sessions/grok-build/captured-1.0.77-20261110');
const variantId = (n: number) => `0199d00${n}-1111-7111-8111-00000000000${n}`;
async function capturedVariant(n: number) {
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL', '1');
  vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', '1.0.77');
  const root = await temp();
  const directory = join(root, encodeURIComponent('/synthetic/workspace'), variantId(n));
  await cp(join(variants, variantId(n)), directory, { recursive: true });
  return { directory, source: selected(join(directory, 'chat_history.jsonl'), root), adapter: new GrokBuildSessionAdapter() };
}

it('preserves captured fork lineage and headless kind without inferring a parent for resumed sources', async () => {
  const { source, adapter } = await capturedVariant(2);
  const records = await collect(adapter.stream(source));
  expect(records.filter(r => r.role === 'assistant').map(r => r.text)).toEqual(['ALPHA', 'ALPHA BETA', 'GAMMA']);
  expect(records[0].extensions).toMatchObject({
    provenance: { sessionKind: 'headless' },
    lineage: { parentSessionId: variantId(1), forkedAt: '2026-11-10T09:13:56.525089735Z' },
  });
  expect(await collect(adapter.stream(source))).toEqual(records);
  const resumed = await capturedVariant(1);
  expect((await collect(resumed.adapter.stream(resumed.source)))[0].extensions?.lineage).toBeUndefined();
});

it('imports an appended captured resume exactly once through repository checkpoints', async () => {
  const { source, adapter } = await capturedVariant(1);
  const complete = await readFile(source.locator, 'utf8');
  const rows = complete.trimEnd().split('\n');
  const resumeAt = rows.findIndex(l => JSON.parse(l).prompt_index === 1);
  await writeFile(source.locator, rows.slice(0, resumeAt).join('\n') + '\n');
  let checkpoint: ImportCheckpoint | null = null;
  const events = new Map<string, unknown>();
  const repository: SessionRepositoryPort = {
    getCheckpoint: () => checkpoint, getBatchCheckpoint: () => null, commitStagedImports: () => 0,
    applyImport(batch, next) {
      const before = events.size;
      for (const event of batch.events) events.set(event.eventId, event);
      checkpoint = { ...next };
      return { operationId: batch.run.importRunId, outcome: 'committed', sessionsInserted: batch.sessions.length, eventsInserted: events.size - before, checkpoint };
    },
  };
  const sessionSource: SessionSource = {
    contractVersion: '1.0.0', sourceId: source.sourceId, provider: 'grok-build', providerProfile: 'native',
    locatorClass: source.locatorClass, redactedLocator: '<fixture>', adapterVersion: adapter.adapterVersion,
    disposition: 'implemented', ...await adapter.inspect(source), authorizedAt: '2026-11-10T00:00:00Z', extensions: {},
  };
  const importer = new IncrementalSessionImporter(repository);
  const request = { source: sessionSource, selectedSource: source, adapter, workspaceId: 'fixture', policyVersion: '1.0.0', limits: { batchSize: 2 } };
  expect((await importer.import(request)).reduce((s, r) => s + r.eventsInserted, 0)).toBe(2);
  await writeFile(source.locator, complete);
  expect((await importer.import(request)).reduce((s, r) => s + r.eventsInserted, 0)).toBe(2);
  expect(await importer.import(request)).toEqual([]);
  expect(events.size).toBe(4);
});

it('records captured subagent metadata and output on the parent without inventing child summary fields', async () => {
  const { source, adapter, directory } = await capturedVariant(3);
  const records = await collect(adapter.stream(source));
  expect(records[0].extensions).toMatchObject({ lineage: { subagents: [
    { subagentId: variantId(4), parentSessionId: variantId(3), childSessionId: variantId(4), status: 'completed', output: 'src=3' },
    { subagentId: variantId(5), parentSessionId: variantId(3), childSessionId: variantId(5), status: 'completed', output: 'docs=1' },
  ] } });
  expect(await collect(adapter.stream(source))).toEqual(records);
  const child = await capturedVariant(4);
  const childRecords = await collect(child.adapter.stream(child.source));
  expect(childRecords[0].extensions).toMatchObject({ provenance: { sessionKind: 'subagent' } });
  expect(childRecords[0].extensions?.lineage).toBeUndefined();
  const metaPath = join(directory, 'subagents', variantId(4), 'meta.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  delete meta.child_session_id;
  await writeFile(metaPath, JSON.stringify(meta));
  await rm(join(directory, 'subagents', variantId(4), 'output.json'));
  const partial = (await collect(adapter.stream(source)))[0].extensions?.lineage as { subagents: Record<string, unknown>[] };
  expect(partial.subagents[0]).not.toHaveProperty('childSessionId');
  expect(partial.subagents[0]).not.toHaveProperty('output');
});

it('recovers original captured turns once from updates across compaction and records its marker', async () => {
  const { source, adapter, directory } = await capturedVariant(6);
  const updatesPath = join(directory, 'updates.jsonl');
  const complete = await readFile(updatesPath, 'utf8');
  const rows = complete.trimEnd().split('\n');
  const compactAt = rows.findIndex(l => JSON.parse(l).params.update.sessionUpdate === 'auto_compact_completed');
  await writeFile(updatesPath, rows.slice(0, compactAt).join('\n') + '\n');
  const compactedHistory = await readFile(source.locator, 'utf8');
  await writeFile(source.locator, '{"type":"user","content":[{"type":"text","text":"Synthetic pre-compaction history."}]}\n');
  const before = await collect(adapter.stream(source));
  expect(before.filter(r => r.role === 'assistant').map(r => r.text)).toHaveLength(2);
  await writeFile(updatesPath, complete);
  await writeFile(source.locator, compactedHistory);
  const records = await collect(adapter.stream(source));
  expect(records.filter(r => r.role === 'assistant').map(r => r.text)).toEqual([
    'OK.', expect.stringContaining('Rhine rises'), 'ORCHID',
  ]);
  expect(records.filter(r => r.role === 'user').map(r => r.text)).toEqual([
    'Remember the code word ORCHID. Reply OK.', 'List three facts about the Rhine in one line each.', '/compact', 'What was the code word?',
  ]);
  expect(records.filter(r => r.kind === 'compaction')).toHaveLength(1);
  expect(records.find(r => r.kind === 'compaction')?.extensions).toMatchObject({ compaction: { tokensBefore: 20088, tokensAfter: 20088 } });
  expect(records.slice(0, before.length)).toEqual(before);
  const appended = await collect(adapter.stream(source, { value: before.at(-1)!.sourceCursor! }));
  expect(appended).toEqual(records.slice(before.length));
  expect(await collect(adapter.stream(source, { value: records.at(-1)!.sourceCursor! }))).toEqual([]);
  expect(await collect(adapter.stream(source))).toEqual(records);
  expect(JSON.stringify(records)).not.toContain('Synthetic omitted context');
});

it.each(['missing-summary', 'truncated', 'unknown', 'corrupt-updates'] as const)('fails closed with actionable code for captured %s mutation', async mode => {
  const { source, adapter, directory } = await capturedVariant(mode === 'corrupt-updates' ? 6 : 1);
  if (mode === 'missing-summary') await rm(join(directory, 'summary.json'));
  if (mode === 'truncated') await writeFile(source.locator, (await readFile(source.locator, 'utf8')) + '{"type":"user"');
  if (mode === 'unknown') await writeFile(source.locator, '{"type":"future-record"}\n');
  if (mode === 'corrupt-updates') await writeFile(join(directory, 'updates.jsonl'), '{"params":');
  await expect(adapter.inspect(source)).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
});

it('keeps fork lineage on normalized sessions and replays without inserting duplicates', async () => {
  const { source, adapter } = await capturedVariant(2);
  const sessionSource: SessionSource = {
    contractVersion: '1.0.0', sourceId: source.sourceId, provider: 'grok-build', providerProfile: 'native',
    locatorClass: source.locatorClass, redactedLocator: '<fixture>', adapterVersion: adapter.adapterVersion,
    disposition: 'implemented', ...await adapter.inspect(source), authorizedAt: '2026-11-10T00:00:00Z', extensions: {},
  };
  let checkpoint: ImportCheckpoint | null = null;
  const eventIds = new Set<string>();
  const repository: SessionRepositoryPort = {
    getCheckpoint: () => checkpoint, getBatchCheckpoint: () => null, commitStagedImports: () => 0,
    applyImport(batch, next) {
      const before = eventIds.size;
      for (const session of batch.sessions) expect(session.extensions['native.grok-build']).toMatchObject({
        lineage: { parentSessionId: variantId(1), forkedAt: expect.any(String) },
      });
      for (const event of batch.events) eventIds.add(event.eventId);
      checkpoint = { ...next };
      return { operationId: batch.run.importRunId, outcome: 'committed', sessionsInserted: batch.sessions.length, eventsInserted: eventIds.size - before, checkpoint };
    },
  };
  const importer = new IncrementalSessionImporter(repository);
  const request = { source: sessionSource, selectedSource: source, adapter, workspaceId: 'fixture', policyVersion: '1.0.0' };
  expect((await importer.import(request)).reduce((s, r) => s + r.eventsInserted, 0)).toBe(6);
  expect(await importer.import(request)).toEqual([]);
});

it('resumes repository import after compaction rewrites chat history, without losing or duplicating turns', async () => {
  const { source, adapter, directory } = await capturedVariant(6);
  const updatesPath = join(directory, 'updates.jsonl');
  const updates = await readFile(updatesPath, 'utf8');
  const history = await readFile(source.locator, 'utf8');
  const rows = updates.trimEnd().split('\n');
  const compactAt = rows.findIndex(l => JSON.parse(l).params.update.sessionUpdate === 'auto_compact_completed');
  await writeFile(updatesPath, rows.slice(0, compactAt).join('\n') + '\n');
  await writeFile(source.locator, JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'Synthetic pre-compaction history.' }] }) + '\n');
  const sessionSource: SessionSource = {
    contractVersion: '1.0.0', sourceId: source.sourceId, provider: 'grok-build', providerProfile: 'native',
    locatorClass: source.locatorClass, redactedLocator: '<fixture>', adapterVersion: adapter.adapterVersion,
    disposition: 'implemented', ...await adapter.inspect(source), authorizedAt: '2026-11-10T00:00:00Z', extensions: {},
  };
  let checkpoint: ImportCheckpoint | null = null;
  const eventIds = new Set<string>();
  const repository: SessionRepositoryPort = {
    getCheckpoint: () => checkpoint, getBatchCheckpoint: () => null, commitStagedImports: () => 0,
    applyImport(batch, next) {
      const before = eventIds.size;
      for (const event of batch.events) eventIds.add(event.eventId);
      checkpoint = { ...next };
      return { operationId: batch.run.importRunId, outcome: 'committed', sessionsInserted: batch.sessions.length, eventsInserted: eventIds.size - before, checkpoint };
    },
  };
  const importer = new IncrementalSessionImporter(repository);
  const request = { source: sessionSource, selectedSource: source, adapter, workspaceId: 'fixture', policyVersion: '1.0.0', limits: { batchSize: 2 } };
  expect((await importer.import(request)).reduce((s, r) => s + r.eventsInserted, 0)).toBe(4);
  await writeFile(source.locator, history);
  await writeFile(updatesPath, updates);
  expect((await importer.import(request)).reduce((s, r) => s + r.eventsInserted, 0)).toBe(4);
  expect(await importer.import(request)).toEqual([]);
  expect(eventIds.size).toBe(8);
  await writeFile(updatesPath, updates.replace('Remember the code word ORCHID.', 'Changed earlier prompt.'));
  await expect(importer.import(request)).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
});

it.each(['missing-updates', 'unknown-update', 'null-history', 'bad-parent', 'bad-output', 'symlink-meta', 'missing-marker', 'missing-turn-prefix'] as const)('rejects unsafe or incomplete %s evidence', async mode => {
  const { source, adapter, directory } = await capturedVariant(['bad-output', 'symlink-meta'].includes(mode) ? 3 : 6);
  if (mode === 'missing-updates') await rm(join(directory, 'updates.jsonl'));
  if (mode === 'unknown-update') {
    const path = join(directory, 'updates.jsonl');
    await writeFile(path, (await readFile(path, 'utf8')).replace('auto_compact_completed', 'future_compaction'));
  }
  if (mode === 'missing-marker' || mode === 'missing-turn-prefix') {
    const path = join(directory, 'updates.jsonl');
    const rows = (await readFile(path, 'utf8')).trimEnd().split('\n');
    await writeFile(path, (mode === 'missing-marker' ? rows.filter(l => !l.includes('auto_compact_completed')) : rows.slice(-2)).join('\n') + '\n');
  }
  if (mode === 'null-history') await writeFile(source.locator, 'null\n');
  if (mode === 'bad-parent') {
    const path = join(directory, 'summary.json');
    const summary = JSON.parse(await readFile(path, 'utf8'));
    summary.parent_session_id = 'not-a-session-id';
    await writeFile(path, JSON.stringify(summary));
  }
  if (mode === 'bad-output') await writeFile(join(directory, 'subagents', variantId(4), 'output.json'), 'null');
  if (mode === 'symlink-meta') {
    const path = join(directory, 'subagents', variantId(4), 'meta.json');
    const copy = join(await temp(), 'meta.json');
    await cp(path, copy); await rm(path); await symlink(copy, path);
  }
  await expect(adapter.inspect(source)).rejects.toMatchObject({ code: mode === 'symlink-meta' ? 'SOURCE_SYMLINK' : 'SCHEMA_DRIFT' });
});

it('rejects rewritten CLI export prefixes after enabling snapshot continuity for native compaction', async () => {
  const root = await temp();
  const path = join(root, `${id}.md`);
  const original = await readFile(join(fixtures, `${id}.md`), 'utf8');
  await writeFile(path, original);
  const source = selected(path, root, 'grok-build-cli-markdown-export');
  const adapter = new GrokBuildSessionAdapter();
  const records = await collect(adapter.stream(source));
  await writeFile(path, original.replace('## User', '## User\n\nChanged earlier prompt.'));
  await expect(collect(adapter.stream(source, { value: records.at(-1)!.sourceCursor ?? String(records.length) })))
    .rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
});
