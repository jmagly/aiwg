import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MUSE_ADAPTER_VERSION,
  MUSE_EXPORT_SCHEMA_VERSION,
  MuseSessionAdapter,
  SessionSourceAdapterRegistry,
  type SelectedSource,
} from '../../../src/sessions/index.js';

const fixturesRoot = resolve('test/fixtures/sessions/muse');

function selected(name: string, sourceId: string, locatorClass = 'manual-export'): SelectedSource {
  return {
    provider: 'muse',
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

describe('Muse Code session adapter', () => {
  const adapter = new MuseSessionAdapter();

  it('is manual-only and rejects automatic discovery without probing homes', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('muse', {
      state: 'available',
      evidence: {
        adapterVersion: MUSE_ADAPTER_VERSION,
        sourceSchemaVersion: MUSE_EXPORT_SCHEMA_VERSION,
        verifiedAt: '2026-09-24',
        reference: 'docs/providers/muse-sessions.md',
      },
      reason: 'native session root unverified',
      remediation: 'select an authorized muse export trajectory file',
    })).toMatchObject({
      classification: 'manual-only',
      supportedOperations: ['inspect', 'stream'],
      acquisitionModes: ['manual-export'],
    });
    expect(() => registry.assertOperation('muse', 'discover'))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }));
    await expect(collect(adapter.discover({
      workspaceId: 'workspace-fixture',
      allowedRoots: [fixturesRoot],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('inspects and streams an authorized muse export trajectory', async () => {
    const source = selected('valid-v1.json', 'muse-fixture-v1');
    await expect(adapter.inspect(source)).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'complete',
      operationalState: 'available',
    });
    const events = await collect(adapter.stream(source));
    expect(events).toHaveLength(13);
    expect(events[0]).toMatchObject({
      nativeSessionId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      kind: 'proposed',
    });
  });

  it('preserves approval, tool, and model-lifecycle events with provenance', async () => {
    const events = await collect(adapter.stream(selected('valid-v1.json', 'muse-fixture-v1')));
    const byKind = new Map(events.map((event) => [event.kind, event]));

    const review = byKind.get('approval.review');
    expect(review).toBeDefined();

    const decision = byKind.get('decision_applied');
    expect(decision).toBeDefined();
    expect(decision!.extensions?.['native.muse']).toMatchObject({
      decision: 'approved',
      decisionSource: expect.objectContaining({ kind: 'llm_judge' }),
    });

    const terminal = byKind.get('approval_wait.effect.terminal');
    expect(terminal).toBeDefined();
    expect(terminal!.extensions?.['native.muse']).toMatchObject({ approvalOutcome: 'approved' });

    const intent = events.find((event) => event.kind === 'side_effect_intent' && event.toolName === 'bash');
    expect(intent).toBeDefined();
    expect(intent!.extensions?.['native.muse']).toMatchObject({
      operation: 'tool:bash',
      policyDecision: 'allow:llm_judge',
    });

    const toolStarted = byKind.get('tool_batch.effect.started');
    expect(toolStarted).toBeDefined();
    expect(toolStarted!.extensions?.['native.muse']).toMatchObject({
      exportSchemaVersion: 1,
      exporterVersion: expect.stringContaining('Muse Code'),
    });

    expect(byKind.get('session.end')).toBeDefined();
    expect(byKind.get('completed')).toBeDefined();
  });

  it('supports cursor-based resume', async () => {
    const events = await collect(adapter.stream(selected('valid-v1.json', 'muse-fixture-v1'), { value: '5' }));
    expect(events).toHaveLength(8);
    expect(events[0].kind).toBe('approval.review');
  });

  it.each([
    ['malformed.json', 'muse-malformed', 'MALFORMED_SOURCE'],
    ['unknown-major.json', 'muse-v2', 'UNKNOWN_SCHEMA_MAJOR'],
  ])('fails closed for %s with %s', async (name, sourceId, code) => {
    await expect(adapter.inspect(selected(name, sourceId))).rejects.toMatchObject({ code });
    await expect(collect(adapter.stream(selected(name, sourceId)))).rejects.toMatchObject({ code });
  });

  it('rejects non-manual locator classes', async () => {
    await expect(adapter.inspect(selected('valid-v1.json', 'muse-fixture-v1', 'cursor-composer')))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });
});
