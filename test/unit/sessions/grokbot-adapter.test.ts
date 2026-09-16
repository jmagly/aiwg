import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GROKBOT_ADAPTER_VERSION,
  GROKBOT_EXPORT_SCHEMA_VERSION,
  GrokbotSessionAdapter,
  SessionSourceAdapterRegistry,
  type SelectedSource,
} from '../../../src/sessions/index.js';

const fixturesRoot = resolve('test/fixtures/sessions/grokbot');

function selected(name: string, sourceId: string, locatorClass = 'manual-export'): SelectedSource {
  return {
    provider: 'grokbot',
    locator: resolve(fixturesRoot, name),
    locatorClass,
    sourceId,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const value of values) items.push(value);
  return items;
}

describe('Grok Bot session adapter', () => {
  const adapter = new GrokbotSessionAdapter();

  it('is manual-only and rejects automatic discovery without probing paths', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('grokbot', {
      state: 'available',
      evidence: {
        adapterVersion: GROKBOT_ADAPTER_VERSION,
        sourceSchemaVersion: GROKBOT_EXPORT_SCHEMA_VERSION,
        verifiedAt: '2026-09-15',
        reference: 'docs/providers/grokbot-sessions.md',
      },
      reason: 'native session locator unverified',
      remediation: 'select an authorized manual-export interchange file',
    })).toMatchObject({
      classification: 'manual-only',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['manual-export'],
    });
    expect(() => registry.assertOperation('grokbot', 'discover'))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }));
    await expect(collect(adapter.discover({
      workspaceId: 'workspace-fixture',
      allowedRoots: [fixturesRoot],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('inspects and streams an authorized manual interchange export', async () => {
    const source = selected('valid-v1.jsonl', 'grokbot-fixture-v1');
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
      role: 'user',
    });
  });

  it.each([
    ['opaque-input.jsonl', 'opaque', 'MALFORMED_SOURCE'],
    ['unknown-major-v2.jsonl', 'grokbot-v2', 'UNKNOWN_SCHEMA_MAJOR'],
  ])('fails closed for %s with %s', async (name, sourceId, code) => {
    await expect(adapter.inspect(selected(name, sourceId))).rejects.toMatchObject({ code });
  });

  it('rejects Cursor or other non-manual locator classes', async () => {
    await expect(adapter.inspect(selected('valid-v1.jsonl', 'grokbot-fixture-v1', 'cursor-composer')))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });
});
