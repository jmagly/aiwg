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

  it('imports a real Muse Code 1.4.0 export (epoch-microsecond timestamps, retained frames)', async () => {
    // Scrubbed from a live `muse export --redacted` on 2026-09-25: integer
    // recorded_at, null causation ids, and a leading retained_frame marker
    // whose envelope is a transaction frame rather than a record.
    const source = selected('live-1.4.0-v1.json', 'muse-live-1.4.0');
    await expect(adapter.inspect(source)).resolves.toMatchObject({ consistency: 'complete' });
    const events = await collect(adapter.stream(source));
    expect(events).toHaveLength(11);
    expect(events.every((event) => event.nativeSessionId === '00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(events[0]).toMatchObject({ kind: 'runtime.session.metadata', sequence: 1 });
    expect(events[0].occurredAt).toBe(new Date(Math.floor(1790349213957005 / 1000)).toISOString());
    const model = events.find((event) => event.kind === 'run.model.configured');
    expect(model?.extensions['native.muse']).toMatchObject({
      exporterVersion: 'Muse Code 1.4.0 (04f5eb2e6e)',
      redaction: 'redacted',
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

  describe('live multi-stream evidence (Muse Code 1.3.0)', () => {
    const parentId = '01a0d42e-4285-73b2-8145-c30f949c5bf8';
    const spawnId = '01a0d42f-2708-7550-9956-91434f3e3898';
    const childId = '01a0d42f-2711-73a2-a03c-757fa74b98fc';

    it('inspects a real-shaped multi-stream export', async () => {
      const source = selected('multistream-v1.json', 'muse-fixture-multistream');
      await expect(adapter.inspect(source)).resolves.toEqual({
        sourceSchemaVersion: '1.0.0',
        consistency: 'complete',
        operationalState: 'available',
      });
    });

    it('attributes each record by its own envelope.stream.id and skips gap markers', async () => {
      const events = await collect(adapter.stream(selected('multistream-v1.json', 'muse-fixture-multistream')));
      // 5 raw events, 1 gap marker with "envelope": null -> 4 provider records.
      expect(events).toHaveLength(4);
      expect(events.map((event) => event.nativeEventId))
        .toEqual(['muse-seq-0', 'muse-seq-1', 'muse-seq-3', 'muse-seq-4']);
      for (const event of events) {
        expect(event.nativeSessionId).toBe(parentId);
        if (event.nativeEventId !== 'muse-seq-4') {
          expect(event.extensions?.['native.muse']).toMatchObject({
            streamKind: 'session',
            streamId: parentId,
          });
        }
      }
      // The record with no stream block falls back to sessions[0].session_id.
      const fallback = events[3];
      expect(fallback.kind).toBe('tool_batch.effect.started');
      expect(fallback.nativeSessionId).toBe(parentId);
      expect(fallback.extensions?.['native.muse']).not.toHaveProperty('streamId');
      expect(fallback.extensions?.['native.muse']).not.toHaveProperty('streamKind');
    });

    it('keeps the spawn handle and the child session id distinct', async () => {
      const events = await collect(adapter.stream(selected('multistream-v1.json', 'muse-fixture-multistream')));
      const bound = events.find((event) => event.kind === 'subagent.control.child_session_bound');
      expect(bound).toBeDefined();
      const native = bound!.extensions?.['native.muse'] as Record<string, unknown>;
      // CRITICAL: subagent_id (spawn handle) != child_session_id (child session/dir identity).
      expect(native.subagentId).toBe(spawnId);
      expect(native.childSessionId).toBe(childId);
      expect(native.subagentId).not.toBe(native.childSessionId);
      // Spawn context is joined by the spawn handle, not the child id.
      expect(native).toMatchObject({ spawnAgentPath: 'main/create-a-txt/1', spawnRole: 'file-creator-A' });

      const attested = events.find((event) => event.kind === 'subagent.control.start_attested');
      expect(attested).toBeDefined();
      expect((attested!.extensions?.['native.muse'] as Record<string, unknown>)).toMatchObject({
        subagentId: spawnId,
        subagentSessionId: childId,
        spawnRole: 'file-creator-A',
      });
    });
  });
});
