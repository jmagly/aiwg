import { appendFile, cp, mkdir, mkdtemp, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_ADAPTER_VERSION,
  CLAUDE_TRANSCRIPT_SCHEMA_VERSION,
  ClaudeSessionAdapter,
  IncrementalSessionImporter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  stableSessionId,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/claude');
const temporaryRoots: string[] = [];

function selected(name: string, sourceId = `claude-${name}`): SelectedSource {
  return {
    provider: 'claude',
    locator: resolve(fixturesRoot, name),
    locatorClass: name.includes('.hook') ? 'claude-hook-jsonl' : 'claude-transcript-jsonl',
    sourceId,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Claude session adapter', () => {
  const adapter = new ClaudeSessionAdapter();

  it('reports implemented local JSONL and hook capabilities', () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('claude', {
      state: 'available',
      evidence: {
        adapterVersion: CLAUDE_ADAPTER_VERSION,
        sourceSchemaVersion: CLAUDE_TRANSCRIPT_SCHEMA_VERSION,
        verifiedAt: '2026-07-27',
        reference: 'docs/providers/claude-code-sessions.md',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      provider: 'claude',
      classification: 'implemented',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['jsonl', 'hook'],
    });
  });

  it('discovers JSONL deterministically within explicit roots and skips symlinks', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiwg-claude-discovery-'));
    temporaryRoots.push(root);
    await mkdir(resolve(root, 'project-b'), { recursive: true });
    await mkdir(resolve(root, 'project-a'), { recursive: true });
    await cp(resolve(fixturesRoot, 'resume-session.jsonl'), resolve(root, 'project-b', 'b.jsonl'));
    await cp(resolve(fixturesRoot, 'lifecycle.hooks.jsonl'), resolve(root, 'project-a', 'a.hooks.jsonl'));
    const { symlink } = await import('node:fs/promises');
    await symlink(resolve(root, 'project-b', 'b.jsonl'), resolve(root, 'linked.jsonl'));
    const discovered = await collect(adapter.discover({
      workspaceId: 'workspace-fixture',
      allowedRoots: [root],
    }));
    expect(discovered.map((item) => item.locator.slice(root.length + 1))).toEqual([
      'project-a/a.hooks.jsonl',
      'project-b/b.jsonl',
    ]);
    expect(discovered.map((item) => item.locatorClass)).toEqual([
      'claude-hook-jsonl',
      'claude-transcript-jsonl',
    ]);
  });

  it('reads complete records from an active truncated transcript and preserves unknown fields', async () => {
    await expect(adapter.inspect(selected('active-session.jsonl'))).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'provisional',
      operationalState: 'available',
    });
    const records = await collect(adapter.stream(selected('active-session.jsonl')));
    expect(records).toHaveLength(3);
    expect(records.map((record) => record.kind)).toEqual(['message', 'message', 'tool-call']);
    expect(records[0]).toMatchObject({
      nativeSessionId: 'active-session',
      nativeEventId: 'u-1:0',
      extensions: {
        productVersion: '2.1.18',
        workspace: { cwdClass: '<workspace>', gitBranch: 'main' },
        unknownFields: { futureTopLevel: 'preserved' },
      },
    });
    expect(records[1].extensions).toMatchObject({
      unknownFields: { futureBlockField: 'preserved' },
    });
    expect(records.every((record) => !JSON.stringify(record.extensions).includes('/private/work'))).toBe(true);
  });

  it('preserves resumed identity and assigns a distinct fork identity', async () => {
    const resumed = await collect(adapter.stream(selected('resume-session.jsonl')));
    const forked = await collect(adapter.stream(selected('fork-session.jsonl')));
    expect(new Set(resumed.map((record) => record.nativeSessionId))).toEqual(new Set(['resume-session']));
    expect(new Set(forked.map((record) => record.nativeSessionId))).toEqual(new Set(['fork-session']));
    expect(forked.find((record) => record.kind === 'claude.thinking')).toMatchObject({
      text: '',
      extensions: { opaque: true },
    });
  });

  it('treats filename and embedded identity mismatches as transcript-family evidence', async () => {
    const records = await collect(adapter.stream(selected('drift-session.jsonl')));
    expect(new Set(records.map((record) => record.nativeSessionId))).toEqual(new Set(['different-session']));
    expect(records[0].extensions).toMatchObject({
      transcriptFamily: {
        sourceArtifactSessionId: 'drift-session',
        nativeSessionId: 'different-session',
        identityRelation: 'related',
      },
    });
  });

  it('preserves parent, continuation, branch, and subagent family evidence', async () => {
    const records = await collect(adapter.stream(selected('subagent-artifact.jsonl')));
    expect(records).toHaveLength(2);
    expect(records[1].extensions).toMatchObject({
      transcriptFamily: {
        sourceArtifactSessionId: 'subagent-artifact',
        nativeSessionId: 'root-session',
        identityRelation: 'related',
        parentSessionId: 'root-session',
        gitBranch: 'feature/synthetic',
        continuation: true,
        subagent: true,
        agentId: 'agent-synthetic',
        agentSlug: 'worker-synthetic',
      },
    });
  });

  it('rejects a deliberately corrupted embedded identity', async () => {
    await expect(adapter.inspect(selected('corrupt-identity.jsonl')))
      .rejects.toMatchObject({ code: 'MALFORMED_SOURCE' });
  });

  it('preserves lifecycle hook evidence without raw local paths', async () => {
    await expect(adapter.inspect(selected('lifecycle.hooks.jsonl'))).resolves.toMatchObject({
      consistency: 'complete',
      operationalState: 'available',
    });
    const hooks = await collect(adapter.stream(selected('lifecycle.hooks.jsonl')));
    expect(hooks).toHaveLength(3);
    expect(hooks[0]).toMatchObject({
      nativeSessionId: 'resume-session',
      kind: 'lifecycle-hook',
      extensions: {
        hookEventName: 'SessionStart',
        startSource: 'resume',
        unknownFields: { futureHookField: 'preserved' },
      },
    });
    expect(hooks[0].extensions).not.toHaveProperty('lifecycle');
    expect(hooks[2]).toMatchObject({
      extensions: { hookEventName: 'SessionEnd', reason: 'clear', lifecycle: 'complete' },
    });
    expect(JSON.stringify(hooks)).not.toContain('/home/test');
    expect(JSON.stringify(hooks)).not.toContain('/private/work');
  });

  it.each([
    ['unknown-major.jsonl', 'UNKNOWN_SCHEMA_MAJOR'],
    ['malformed.jsonl', 'MALFORMED_SOURCE'],
  ])('fails closed for %s with %s', async (name, code) => {
    await expect(adapter.inspect(selected(name))).rejects.toMatchObject({ code });
  });

  it('requires an explicitly authorized discovery root', async () => {
    await expect(async () => collect(adapter.discover({
      workspaceId: 'workspace-fixture',
      allowedRoots: [],
    }))).rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
  });
});

describeWithSqlite('Claude adapter repository conformance', () => {
  it('imports active append incrementally, redacts content, and replays as a no-op', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiwg-claude-append-'));
    temporaryRoots.push(root);
    const path = resolve(root, 'active-session.jsonl');
    await cp(resolve(fixturesRoot, 'active-session.jsonl'), path);
    await truncate(path, (await stat(path)).size - 1);
    const adapter = new ClaudeSessionAdapter();
    const selectedSource: SelectedSource = {
      provider: 'claude',
      locator: path,
      locatorClass: 'claude-transcript-jsonl',
      sourceId: 'claude-active-fixture',
      authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [root] },
    };
    const source = sourceFor(selectedSource, 'provisional');
    const repository = new SessionRepository();
    const importer = new IncrementalSessionImporter(repository);
    const request = {
      source, selectedSource, adapter,
      workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
      // The fixture carries a fixed historical event timestamp. Keep this
      // append/resume test independent of the wall clock while lifecycle
      // threshold behavior is covered by dedicated importer tests.
      inactivityThresholdMs: 10 * 365 * 24 * 60 * 60 * 1_000,
    };
    const first = await importer.import(request);
    expect(first.reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(3);
    const sessionId = stableSessionId('claude', source.sourceId, 'active-session');
    expect(repository.getSession(sessionId)).toMatchObject({
      nativeSessionId: 'active-session',
      lifecycle: 'active',
      consistency: 'provisional',
    });
    expect(repository.listEvents(sessionId)[0].searchableText).not.toContain('synthetic@example.test');
    expect(repository.listEvents(sessionId)[0].searchableText).not.toContain('redaction-canary-value');

    await appendFile(path, ',"parentUuid":"a-1","sessionId":"active-session","timestamp":"2026-07-27T10:00:02.000Z","message":{"role":"user","content":"Appended after resume"}}\n');
    const second = await importer.import(request);
    expect(second.reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(1);
    expect(repository.listEvents(sessionId)).toHaveLength(4);
    expect(await importer.import(request)).toEqual([]);
    expect(repository.listEvents(sessionId)).toHaveLength(4);
    repository.close();
  });

  it('does not write or alter the #1649 skill-usage telemetry store', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiwg-claude-telemetry-isolation-'));
    temporaryRoots.push(root);
    const transcript = resolve(root, 'resume-session.jsonl');
    await cp(resolve(fixturesRoot, 'resume-session.jsonl'), transcript);
    const adapter = new ClaudeSessionAdapter();
    const selectedSource: SelectedSource = {
      provider: 'claude', locator: transcript, locatorClass: 'claude-transcript-jsonl',
      sourceId: 'claude-telemetry-isolation',
      authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [root] },
    };
    const repository = new SessionRepository();
    await new IncrementalSessionImporter(repository).import({
      source: sourceFor(selectedSource, 'provisional'),
      selectedSource, adapter, workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
    });
    await expect(stat(resolve(root, '.aiwg/telemetry/skill-usage.jsonl')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    repository.close();
  });

  it('rejects unknown major schema without partial normalized state', async () => {
    const adapter = new ClaudeSessionAdapter();
    const selectedSource = selected('unknown-major.jsonl', 'claude-unknown-major');
    const repository = new SessionRepository();
    await expect(new IncrementalSessionImporter(repository).import({
      source: sourceFor(selectedSource, 'complete', '2.0.0'),
      selectedSource, adapter, workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
    })).rejects.toMatchObject({ code: 'UNKNOWN_SCHEMA_MAJOR' });
    expect(repository.listSources()).toEqual([]);
    repository.close();
  });
});

function sourceFor(
  selectedSource: SelectedSource,
  consistency: 'provisional' | 'complete',
  sourceSchemaVersion = CLAUDE_TRANSCRIPT_SCHEMA_VERSION,
): SessionSource {
  return {
    contractVersion: SESSION_CONTRACT_VERSION,
    sourceId: selectedSource.sourceId,
    provider: 'claude',
    providerProfile: 'documented-local-jsonl',
    locatorClass: selectedSource.locatorClass,
    redactedLocator: `<session-source>/${basename(selectedSource.locator)}`,
    adapterVersion: CLAUDE_ADAPTER_VERSION,
    sourceSchemaVersion,
    disposition: 'implemented',
    operationalState: 'available',
    consistency,
    authorizedAt: '2026-07-27T12:00:00.000Z',
    extensions: { 'native.claude': { productVersion: '2.1.18' } },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}
