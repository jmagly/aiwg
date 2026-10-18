import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS,
  GrokbotSessionAdapter,
  type SelectedSource,
} from '../../../src/sessions/index.js';
import { discoverWorkspaceHistories } from '../../../src/sessions/workspace-discovery.js';
import { createSessionAdapterRegistry } from '../../../src/sessions/adapter-registry.js';
import {
  classifyGrokbotBlobName,
  grokbotTranscriptReplicaFilename,
} from '../../../src/sessions/adapters/grokbot-locator.js';

// Record every file the adapter reads, so the allowlist is checked against
// what was actually opened rather than only what discovery yielded.
const openedPaths = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/sessions/readers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/sessions/readers.js')>();
  return {
    ...original,
    readBoundedJson: (authorization: { selectedPath: string }, ...rest: unknown[]) => {
      openedPaths.push(authorization.selectedPath);
      return (original.readBoundedJson as (...args: unknown[]) => unknown)(authorization, ...rest);
    },
  };
});

const fixturesRoot = resolve('test/fixtures/sessions/grokbot/native');
const ids = JSON.parse(readFileSync(resolve(fixturesRoot, 'fixture-ids.json'), 'utf8')) as {
  account: string;
  conversations: Record<'complete' | 'truncated' | 'unknownSchema' | 'malformed', string>;
  decoys: { composerDraftsKey: string; plainFiles: string[] };
};

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const value of values) items.push(value);
  return items;
}

/** Select one fixture replica by conversation, independent of directory order. */
function replica(name: keyof typeof ids.conversations): SelectedSource {
  return selectedFor(resolve(fixturesRoot, grokbotTranscriptReplicaFilename(ids.account, ids.conversations[name])));
}

function selectedFor(locator: string): SelectedSource {
  return {
    provider: 'grokbot',
    locator,
    locatorClass: GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS,
    sourceId: 'native-fixture',
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

describe('Grok Bot native transcript-replica locator', () => {
  const adapter = new GrokbotSessionAdapter();

  it('discovers only transcript-replica blobs, never the roster or any decoy file', async () => {
    const descriptors = await collect(adapter.discover({
      workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot],
    }));
    expect(descriptors).toHaveLength(4); // complete, truncated, unknownSchema, malformed
    for (const descriptor of descriptors) {
      expect(descriptor.locatorClass).toBe(GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS);
      expect(descriptor.locator.endsWith('.blob')).toBe(true);
    }
    // None of the decoy / roster filenames (by content) ever surface as a source.
    const rosterOrDecoyContents = [
      readFileSync(resolve(fixturesRoot, 'sand-secrets.json'), 'utf8'),
      readFileSync(resolve(fixturesRoot, 'box-secrets-main.blob'), 'utf8'),
    ];
    for (const content of rosterOrDecoyContents) {
      expect(content).toBe('not-json-garbage-{{{');
    }
  });

  it('requires an explicitly authorized root and never probes with none given', async () => {
    await expect(collect(adapter.discover({ workspaceId: 'workspace-fixture', allowedRoots: [] })))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
  });

  it('inspects a complete replica as complete and streams every known-kind entry with mapped roles/text', async () => {
    const completeSource = replica('complete');

    const probe = await adapter.inspect(completeSource!);
    expect(probe).toEqual({ sourceSchemaVersion: '1.0.0', consistency: 'complete', operationalState: 'available' });
    expect(probe.declaredWorkspaceId).toBeUndefined();

    const records = await collect(adapter.stream(completeSource!));
    // 14 entries, 1 unrecognized kind skipped -> 13 records.
    expect(records).toHaveLength(13);
    expect(records.every((record) => record.nativeSessionId === ids.conversations.complete)).toBe(true);

    const byId = Object.fromEntries(records.map((record) => [record.nativeEventId, record]));
    expect(byId['evt-1']).toMatchObject({ role: 'user', kind: 'grokbot.message', text: 'Can you help me plan a release?' });
    expect(byId['evt-2']).toMatchObject({ role: 'assistant', kind: 'grokbot.send-message.text', text: 'Sure — what is the target date?' });
    expect(byId['evt-4']).toMatchObject({ role: 'assistant', participant: 'Release Bot' });
    expect((byId['evt-4'].extensions as any).fromAgent).toMatchObject({ id: 'agent-release-bot', name: 'Release Bot' });
    expect(byId['evt-5']).toMatchObject({ role: 'user', kind: 'grokbot.user-attachment' });
    expect(byId['evt-5'].text).toContain('roadmap.png');
    expect(byId['evt-6'].text).toBe('[widget] Pick a release channel -> stable');
    expect(byId['evt-7'].text).toBe('[email-draft] Release notes draft\nHello team, here are the draft release notes...');
    expect(byId['evt-8'].text).toBe('[slack-draft] #release-engineering\nHeads up: release cut next Friday.');
    expect(byId['evt-9'].text).toContain('checklist.pdf');
    expect(byId['evt-10'].text).toBe('[user-form] Confirm release owner');
    expect(byId['evt-11'].text).toBe('[secret-request] Deploy API token (value not exported)');
    expect(JSON.stringify(byId['evt-11'])).not.toMatch(/token.{0,20}=|bearer/i);
    expect(byId['evt-12']).toMatchObject({ role: 'system', kind: 'grokbot.event' });
    expect(byId['evt-13']).toMatchObject({ role: 'system', kind: 'grokbot.notice', text: 'Conversation archived by user.' });
    expect(byId['evt-14']).toBeUndefined(); // unrecognized kind: skipped, never fabricated
  });

  it('resumes from a prior seq cursor without re-emitting already-imported entries', async () => {
    const completeSource = replica('complete');
    const full = await collect(adapter.stream(completeSource!));
    const last = full.find((record) => record.nativeEventId === 'evt-6')!;
    expect(last.sourceCursor).toBe('native:6');

    const resumed = await collect(adapter.stream(completeSource!, { value: last.sourceCursor }));
    expect(resumed.map((record) => record.nativeEventId)).toEqual(
      full.slice(full.findIndex((record) => record.nativeEventId === 'evt-6') + 1)
        .map((record) => record.nativeEventId),
    );
    expect(resumed.some((record) => record.nativeEventId === 'evt-6')).toBe(false);
  });

  it('reports a window-evicted (truncated) replica as provisional, never claiming complete history', async () => {
    const truncatedSource = replica('truncated');
    await expect(adapter.inspect(truncatedSource)).resolves.toMatchObject({ consistency: 'provisional' });
    const records = await collect(adapter.stream(truncatedSource!));
    expect(records).toHaveLength(2);
    expect(records[0].sequence).toBe(41);
  });

  it('fails closed on an unknown schemaVersion major', async () => {
    await expect(adapter.inspect(replica('unknownSchema')))
      .rejects.toMatchObject({ code: 'UNKNOWN_SCHEMA_MAJOR' });
  });

  it('fails closed on a structurally malformed known-kind entry', async () => {
    await expect(collect(adapter.stream(replica('malformed'))))
      .rejects.toMatchObject({ code: 'MALFORMED_SOURCE' });
  });

  describe('replica schema compatibility', () => {
    let root: string;
    const entry = { kind: 'send-message', id: 'evt-1', timestampMs: 1_790_000_000_000, seq: 1 };
    const textMessage = { ...entry, message: { type: 'text', content: 'Fixture message' } };

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'aiwg-grokbot-schema-'));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    function sourceFor(value: Record<string, unknown>): SelectedSource {
      const path = join(root, grokbotTranscriptReplicaFilename(ids.account, ids.conversations.complete));
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, value: { entries: [textMessage], ...value } }));
      return { ...selectedFor(path), authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [root] } };
    }

    it.each([
      [1, 'complete'],
      [41, 'provisional'],
    ])('accepts null hints in a replica starting at seq %s', async (seq, consistency) => {
      const source = sourceFor({
        entries: [{ ...textMessage, seq }],
        epochHint: null,
        acceptedSequenceHint: null,
        persistedAt: null,
        precedingTimestampMs: null,
      });
      await expect(adapter.inspect(source)).resolves.toMatchObject({ consistency });
      await expect(collect(adapter.stream(source))).resolves.toMatchObject([
        { sequence: seq, text: 'Fixture message' },
      ]);
    });

    it('skips unknown send-message types and continues streaming known messages', async () => {
      const source = sourceFor({
        entries: [
          textMessage,
          { ...entry, id: 'evt-2', seq: 2, message: { type: 'auto-review-approval', content: 'Do not export' } },
          { ...textMessage, id: 'evt-3', seq: 3 },
        ],
      });
      await expect(adapter.inspect(source)).resolves.toMatchObject({ consistency: 'complete' });
      const records = await collect(adapter.stream(source));
      expect(records.map((record) => record.nativeEventId)).toEqual(['evt-1', 'evt-3']);
      expect(records.map((record) => record.text)).toEqual(['Fixture message', 'Fixture message']);
      const resumed = await collect(adapter.stream(source, { value: 'native:1' }));
      expect(resumed.map((record) => record.sourceCursor)).toEqual(['native:3']);
    });

    it.each([
      ['text', { content: { privateContent: 'Do not export' } }, 'content'],
      ['widget', { widget: { prompt: null } }, 'widget.prompt'],
      ['email-draft', { draft: { body: 42 } }, 'draft.body'],
      ['slack-draft', { draft: { body: 42 } }, 'draft.body'],
      ['attachment', { url: 42, file_name: 'fixture.txt' }, 'url'],
      ['user-form', { formRequest: { title: null } }, 'formRequest.title'],
      ['secret-request', { secretRequest: { label: null } }, 'secretRequest.label'],
    ])('still rejects malformed known message type %s with a field-only diagnostic', async (type, fields, path) => {
      const source = sourceFor({ entries: [{ ...entry, message: { type, ...fields } }] });
      await expect(collect(adapter.stream(source))).rejects.toMatchObject({
        code: 'MALFORMED_SOURCE',
        message: `Grok Bot send-message entry is malformed at message.${path} (invalid_type)`,
      });
    });

    it.each([undefined, null, {}, { type: null }, { type: 42 }, { type: '' }])(
      'rejects a missing or invalid message discriminator (%j)', async (message) => {
        const source = sourceFor({ entries: [{ ...entry, message }] });
        await expect(collect(adapter.stream(source))).rejects.toMatchObject({ code: 'MALFORMED_SOURCE' });
      },
    );

    it.each([
      ['epochHint', { privateContent: 'Do not export' }],
      ['acceptedSequenceHint', 'Do not export'],
      ['persistedAt', 'Do not export'],
      ['precedingTimestampMs', 'Do not export'],
    ])('reports the path and code for an invalid %s without its value', async (field, value) => {
      const source = sourceFor({ [field]: value });
      const error = {
        code: 'MALFORMED_SOURCE',
        message: `Grok Bot transcript replica is malformed at value.${field} (invalid_type)`,
      };
      await expect(adapter.inspect(source)).rejects.toMatchObject(error);
      await expect(collect(adapter.stream(source))).rejects.toMatchObject(error);
    });

    it('reports multiple issue paths, including fields within replica entries', async () => {
      const source = sourceFor({ entries: [{ ...textMessage, timestampMs: null }], persistedAt: -1 });
      await expect(adapter.inspect(source)).rejects.toMatchObject({
        code: 'MALFORMED_SOURCE',
        message: 'Grok Bot transcript replica is malformed at value.entries.0.timestampMs (invalid_type), '
          + 'value.persistedAt (too_small)',
      });
    });
  });

  it('rejects any locatorClass other than manual-export or the native replica class', async () => {
    const descriptors = await collect(adapter.discover({
      workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot],
    }));
    const forged: SelectedSource = { ...selectedFor(descriptors[0].locator), locatorClass: 'cursor-composer' };
    await expect(adapter.inspect(forged)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('opens only allowlisted transcript replicas, never the roster or decoy files', async () => {
    openedPaths.length = 0;
    const descriptors = await collect(adapter.discover({
      workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot],
    }));
    for (const descriptor of descriptors) {
      const source = selectedFor(descriptor.locator);
      await adapter.inspect(source).catch(() => undefined);
      await collect(adapter.stream(source)).catch(() => undefined);
    }

    expect(openedPaths.length).toBeGreaterThan(0);
    for (const opened of openedPaths) {
      expect(classifyGrokbotBlobName(basename(opened))?.kind).toBe('transcript-replica');
    }
    const neverOpened = readdirSync(fixturesRoot)
      .filter((name) => classifyGrokbotBlobName(name)?.kind !== 'transcript-replica');
    expect(neverOpened).toEqual(expect.arrayContaining(['sand-secrets.json', 'box-secrets-main.blob']));
    for (const name of neverOpened) {
      expect(openedPaths.map((opened) => basename(opened))).not.toContain(name);
    }
  });

  it('refuses to open a non-allowlisted file handed in with the native locator class', async () => {
    openedPaths.length = 0;
    for (const name of ['box-secrets-main.blob', 'sand-secrets.json']) {
      const forged = selectedFor(resolve(fixturesRoot, name));
      await expect(adapter.inspect(forged)).rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
      await expect(collect(adapter.stream(forged))).rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
    }
    expect(openedPaths).toEqual([]);
  });

  it('treats a window that starts after seq 1 as provisional even without the timestamp hint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-grokbot-window-'));
    try {
      const conversation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9';
      const entry = (seq: number) => ({
        kind: 'message', id: `evt-${seq}`, role: 'user', content: `entry ${seq}`,
        timestampMs: 1_790_000_000_000 + seq, requestId: '11111111-2222-4333-8444-555555555555', seq,
      });
      const path = join(root, grokbotTranscriptReplicaFilename(ids.account, conversation));
      // Out of order on disk, no precedingTimestampMs.
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, value: { entries: [entry(43), entry(41), entry(42)] } }));
      const source = { ...selectedFor(path), authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [root] } };

      await expect(adapter.inspect(source)).resolves.toMatchObject({ consistency: 'provisional' });
      const records = await collect(adapter.stream(source));
      expect(records.map((record) => record.sequence)).toEqual([41, 42, 43]);
      // Resuming after 42 yields only 43, so an out-of-order entry is never skipped for good.
      const resumed = await collect(adapter.stream(source, { value: 'native:42' }));
      expect(resumed.map((record) => record.sequence)).toEqual([43]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('assigns a conversation-id–derived sourceId (not content-digest) so re-discovery is stable', async () => {
    const workspace = resolve(fixturesRoot, '..'); // any real directory works as the authorized "workspace"
    const first = await discoverWorkspaceHistories({
      workspace,
      expectedProviders: ['grokbot'],
      grokbotRoot: fixturesRoot,
      registry: createSessionAdapterRegistry(),
    });
    const second = await discoverWorkspaceHistories({
      workspace,
      expectedProviders: ['grokbot'],
      grokbotRoot: fixturesRoot,
      registry: createSessionAdapterRegistry(),
    });
    const firstIds = first.sources.filter((s) => s.provider === 'grokbot').map((s) => s.sourceId).sort();
    const secondIds = second.sources.filter((s) => s.provider === 'grokbot').map((s) => s.sourceId).sort();
    expect(firstIds.length).toBeGreaterThan(0);
    expect(firstIds).toEqual(secondIds);
  });
});
