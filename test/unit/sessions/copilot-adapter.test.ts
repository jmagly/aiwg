import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COPILOT_ADAPTER_VERSION,
  COPILOT_EXPORT_SCHEMA_VERSION,
  CopilotSessionAdapter,
  IncrementalSessionImporter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/copilot');

function selected(name: string, locatorClass = 'copilot-chat-json-export'): SelectedSource {
  return {
    provider: 'copilot',
    locator: resolve(fixturesRoot, name),
    locatorClass,
    sourceId: `copilot-${name}`,
    authorizedScope: {
      workspaceId: 'workspace-fixture',
      allowedRoots: [fixturesRoot],
    },
  };
}

describe('Copilot session adapter', () => {
  const adapter = new CopilotSessionAdapter();

  it('reports explicit supported export capability without stable workspace-store discovery', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('copilot', {
      state: 'available',
      evidence: {
        adapterVersion: COPILOT_ADAPTER_VERSION,
        sourceSchemaVersion: COPILOT_EXPORT_SCHEMA_VERSION,
        verifiedAt: '2026-07-27',
        reference: 'docs/providers/copilot-sessions.md',
      },
      reason: null,
      remediation: null,
    })).toMatchObject({
      provider: 'copilot',
      classification: 'implemented',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['manual-export'],
    });
    expect(await collect(adapter.discover({
      workspaceId: 'workspace-fixture',
      allowedRoots: [fixturesRoot],
    }))).toEqual([]);
  });

  it('preserves prompts, responses, metadata, unknown fields, and explicit flattening losses', async () => {
    await expect(adapter.inspect(selected('complete.chat.json'))).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'provisional',
      operationalState: 'available',
    });
    const records = await collect(adapter.stream(selected('complete.chat.json')));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      nativeSessionId: 'copilot-session-fixture',
      nativeEventId: 'request-1:request',
      role: 'user',
      text: 'Decision: keep synthetic fixture evidence',
      extensions: {
        lifecycle: 'active',
        sync: {
          status: 'synced',
          archiveState: 'not-reported',
          deletionState: 'not-reported',
        },
        workspace: { id: 'workspace-fixture', repository: 'example/synthetic' },
        model: 'synthetic-model',
        provenance: {
          acquisition: 'vscode-chat-json-export',
          stableWorkspaceStoreDependency: false,
          proposedApiDependency: false,
        },
        exportUnknownFields: { futureExportField: 'preserved' },
      },
    });
    expect(records[1]).toMatchObject({
      nativeEventId: 'request-1:response',
      role: 'assistant',
      text: 'The synthetic decision is recorded.\n\nSynthetic tool result only',
      extensions: {
        metadataLoss: [{
          field: 'response[1]',
          reason: expect.stringContaining('toolInvocation'),
        }],
        unknownFields: {
          responseParts: [
            { futurePartField: 'preserved' },
            { toolCallId: 'synthetic-tool-1' },
          ],
        },
      },
    });
  });

  it('keeps archive, sync, and deletion states distinct', async () => {
    const records = await collect(adapter.stream(selected('archived.chat.json')));
    expect(records).toHaveLength(2);
    expect(records[0].extensions).toMatchObject({
      lifecycle: 'archived',
      sync: {
        status: 'local-only',
        archiveState: 'archived',
        deletionState: 'not-reported',
      },
    });
  });

  it.each([
    ['unknown-major.chat.json', 'UNKNOWN_SCHEMA_MAJOR'],
    ['malformed.chat.json', 'MALFORMED_SOURCE'],
  ])('fails closed for %s with %s', async (name, code) => {
    await expect(adapter.inspect(selected(name))).rejects.toMatchObject({ code });
  });

  it('refuses versioned workspace-store JSON/JSONL as a stable dependency', async () => {
    await expect(adapter.inspect(selected(
      'complete.chat.json',
      'copilot-workspace-store-jsonl',
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });
});

describeWithSqlite('Copilot adapter repository conformance', () => {
  it('imports a synthetic export, redacts normalized text, and replays as a no-op', async () => {
    const adapter = new CopilotSessionAdapter();
    const selectedSource = selected('redaction.chat.json');
    const source: SessionSource = {
      contractVersion: SESSION_CONTRACT_VERSION,
      sourceId: selectedSource.sourceId,
      provider: 'copilot',
      providerProfile: 'vscode-chat-json-export',
      locatorClass: selectedSource.locatorClass,
      redactedLocator: '<session-source>/redaction.chat.json',
      adapterVersion: COPILOT_ADAPTER_VERSION,
      sourceSchemaVersion: COPILOT_EXPORT_SCHEMA_VERSION,
      disposition: 'implemented',
      operationalState: 'available',
      consistency: 'provisional',
      authorizedAt: '2026-07-27T00:00:00.000Z',
      extensions: { 'native.copilot': {} },
    };
    const repository = new SessionRepository();
    const importer = new IncrementalSessionImporter(repository);
    const request = {
      source,
      selectedSource,
      adapter,
      workspaceId: 'workspace-fixture',
      policyVersion: '1.0.0',
    };
    expect((await importer.import(request))
      .reduce((sum, receipt) => sum + receipt.eventsInserted, 0)).toBe(2);
    const serialized = JSON.stringify(repository.authorizedSearchDocuments({
      workspaceId: 'workspace-fixture',
      limit: 10,
    }));
    expect(serialized).not.toContain('redaction-canary-123');
    expect(serialized).not.toContain('synthetic@example.test');
    expect(await importer.import(request)).toEqual([]);
    repository.close();
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const value of iterable) output.push(value);
  return output;
}
