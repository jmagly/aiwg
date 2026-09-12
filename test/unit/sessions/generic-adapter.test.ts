import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GENERIC_ADAPTER_VERSION,
  GenericSessionInterchangeAdapter,
  IncrementalSessionImporter,
  SESSION_CONTRACT_VERSION,
  SessionRepository,
  SessionSourceAdapterRegistry,
  stableSessionId,
  type SelectedSource,
  type SessionSource,
} from '../../../src/sessions/index.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const fixturesRoot = resolve('test/fixtures/sessions/generic');

function selected(name: string, sourceId: string): SelectedSource {
  return {
    provider: 'generic',
    locator: resolve(fixturesRoot, name),
    locatorClass: 'manual-export',
    sourceId,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

describe('generic session interchange adapter', () => {
  const adapter = new GenericSessionInterchangeAdapter();

  it('is manual-only and rejects automatic discovery before source access', () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('generic', {
      state: 'available',
      evidence: {
        adapterVersion: GENERIC_ADAPTER_VERSION,
        sourceSchemaVersion: '1.0.0',
        verifiedAt: '2026-07-26',
        reference: 'docs/providers/generic-session-interchange.md',
      },
      reason: 'explicit file selection required',
      remediation: 'select a declared AIWG interchange file',
    })).toMatchObject({
      classification: 'manual-only',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['manual-export'],
    });
    expect(() => registry.assertOperation('generic', 'discover'))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }));
  });

  it('probes declared versions and preserves identities, metadata, and unknown fields', async () => {
    const source = selected('valid-v1.jsonl', 'generic-fixture-v1');
    await expect(adapter.inspect(source)).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'complete',
      operationalState: 'available',
    });
    const events = await collect(adapter.stream(source));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      nativeSessionId: 'session-1',
      nativeEventId: 'event-1',
      sequence: 0,
      extensions: {
        lifecycle: 'complete',
        workspace: {
          id: 'workspace-fixture',
          futureWorkspaceField: 'preserved',
        },
        provenance: { exporter: 'aiwg-test-fixture' },
        unknownFields: { futureEventField: 'preserved' },
      },
    });
    expect(events[1].kind).toBe('provider.future-kind');
  });

  it.each([
    ['duplicate-id-v1.jsonl', 'generic-duplicate-v1', 'DUPLICATE_NATIVE_ID'],
    ['ambiguous-time-v1.jsonl', 'generic-ambiguous-v1', 'AMBIGUOUS_TIMESTAMP'],
    ['unknown-major-v2.jsonl', 'generic-v2', 'UNKNOWN_SCHEMA_MAJOR'],
    ['opaque-input.jsonl', 'opaque', 'MALFORMED_SOURCE'],
    ['truncated-v1.jsonl', 'generic-truncated-v1', 'TRUNCATED_SOURCE'],
  ])('fails closed for %s with %s', async (name, sourceId, code) => {
    await expect(adapter.inspect(selected(name, sourceId))).rejects.toMatchObject({ code });
  });

  it('rejects source identity drift', async () => {
    await expect(adapter.inspect(selected('valid-v1.jsonl', 'wrong-source')))
      .rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  });
});

describeWithSqlite('generic interchange repository conformance', () => {
  it('imports deterministically, redacts content, preserves opaque events, and replays as a no-op', async () => {
    const adapter = new GenericSessionInterchangeAdapter();
    const selectedSource = selected('valid-v1.jsonl', 'generic-fixture-v1');
    const source: SessionSource = {
      contractVersion: SESSION_CONTRACT_VERSION,
      sourceId: selectedSource.sourceId,
      provider: 'generic',
      providerProfile: 'manual-interchange',
      locatorClass: 'manual-export',
      redactedLocator: '<session-source>/valid-v1.jsonl',
      adapterVersion: adapter.adapterVersion,
      sourceSchemaVersion: '1.0.0',
      disposition: 'manual-only',
      operationalState: 'available',
      consistency: 'complete',
      authorizedAt: '2026-07-26T12:00:00.000Z',
      extensions: { 'native.generic': { product: 'synthetic-fixture' } },
    };
    const repository = new SessionRepository();
    const importer = new IncrementalSessionImporter(repository);
    const request = {
      source, selectedSource, adapter,
      workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
      limits: { batchSize: 1 },
    };
    const first = await importer.import(request);
    expect(first).toHaveLength(2);
    const sessionId = stableSessionId('generic', source.sourceId, 'session-1');
    const events = repository.listEvents(sessionId);
    expect(events).toHaveLength(2);
    expect(events[0].nativeId).toBe('event-1');
    expect(events[0].searchableText).not.toContain('synthetic@example.test');
    expect(events[0].searchableText).not.toContain('redaction-canary-value');
    expect(events[1].opaque).toBe(true);
    expect(await importer.import(request)).toEqual([]);
    expect(repository.listEvents(sessionId)).toHaveLength(2);
    repository.close();
  });

  it('does not persist an unknown-major interchange', async () => {
    const adapter = new GenericSessionInterchangeAdapter();
    const repository = new SessionRepository();
    const importer = new IncrementalSessionImporter(repository);
    const selectedSource = selected('unknown-major-v2.jsonl', 'generic-v2');
    await expect(importer.import({
      source: {
        contractVersion: SESSION_CONTRACT_VERSION,
        sourceId: selectedSource.sourceId,
        provider: 'generic',
        providerProfile: 'manual-interchange',
        locatorClass: 'manual-export',
        redactedLocator: '<session-source>/unknown-major-v2.jsonl',
        adapterVersion: adapter.adapterVersion,
        sourceSchemaVersion: '2.0.0',
        disposition: 'manual-only',
        operationalState: 'schema-unsupported',
        consistency: 'complete',
        authorizedAt: '2026-07-26T12:00:00.000Z',
        extensions: { 'native.generic': {} },
      },
      selectedSource, adapter,
      workspaceId: 'workspace-fixture', policyVersion: '1.0.0',
    })).rejects.toMatchObject({ code: 'UNKNOWN_SCHEMA_MAJOR' });
    expect(repository.getCheckpoint(selectedSource.sourceId, adapter.adapterVersion)).toBeNull();
    repository.close();
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}
