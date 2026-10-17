import { mkdtemp } from '../../helpers/temp-dir.js';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JsonlOperatorDecisionStore,
  createDecisionRecord,
  digestDecisionContext,
  toOpenTelemetryLog,
  verifyDecisionChain,
  type OperatorDecisionInput,
} from '../../../src/audit/operator-decision.js';

function input(overrides: Partial<OperatorDecisionInput> = {}): OperatorDecisionInput {
  return {
    kind: 'approval',
    outcome: 'approved',
    actor: { id: 'alice@example.com', type: 'human', authentication: 'os-keychain', roles: ['release-manager'] },
    reason: 'Release evidence reviewed',
    context: { prompt: 'deploy?', token: 'secret-value' },
    classification: 'confidential',
    correlation: {
      mission_id: 'mission-1',
      flow_id: 'flow-release',
      provider_id: 'codex',
      sandbox_task_id: 'task-1',
      issue_id: '1567',
      pull_request_id: '42',
      prompt_id: 'prompt-1',
      trace_id: 'trace-1',
    },
    runtime: { runtime_kind: 'vm', isolation: 'hardware', transport_mode: 'vsock', transport_trust: 'mtls' },
    timestamp: '2026-08-03T12:00:00.000Z',
    event_id: 'event-1',
    ...overrides,
  };
}

describe('operator decision audit (#1567)', () => {
  it('creates a versioned, correlated record without persisting raw context', () => {
    const record = createDecisionRecord(input(), null);
    expect(record).toMatchObject({
      schema_version: 'operator-decision.aiwg.io/v1',
      kind: 'approval',
      actor: { id: 'alice@example.com' },
      correlation: { mission_id: 'mission-1', sandbox_task_id: 'task-1' },
      previous_hash: null,
    });
    expect(record.context_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain('deploy?');
    expect(JSON.stringify(record)).not.toContain('secret-value');
  });

  it('redacts secrets in actor, reason, correlation, and runtime fields', () => {
    const record = createDecisionRecord(input({
      actor: { id: 'alice', type: 'human', authentication: 'Bearer abc.def' },
      reason: 'used sk-example-secret',
      correlation: { mission_id: 'm', trace_id: 'ghp_example' },
      runtime: { evidence_refs: ['safe', 'Bearer runtime-secret'] },
    }), null);
    const encoded = JSON.stringify(record);
    expect(encoded).not.toMatch(/abc\.def|sk-example-secret|ghp_example|runtime-secret/);
    expect(record.redacted_fields.length).toBeGreaterThanOrEqual(4);
  });

  it('detects mutation and reordering in a decision chain', () => {
    const first = createDecisionRecord(input(), null);
    const second = createDecisionRecord(input({ event_id: 'event-2', kind: 'override', outcome: 'overridden' }), first.record_hash);
    expect(verifyDecisionChain([first, second])).toEqual({ ok: true });
    expect(verifyDecisionChain([second, first])).toMatchObject({ ok: false, index: 0 });
    const mutated = structuredClone(second);
    mutated.reason = 'changed';
    expect(verifyDecisionChain([first, mutated])).toMatchObject({ ok: false, index: 1 });
  });

  it('persists 0600 JSONL, verifies before append, and prunes by classification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiwg-decision-audit-'));
    const path = join(dir, 'events.jsonl');
    const store = new JsonlOperatorDecisionStore(path);
    await store.append(input({ classification: 'public' }));
    await store.append(input({ event_id: 'event-2', timestamp: '2026-08-03T13:00:00.000Z' }));
    expect(verifyDecisionChain(await store.read())).toEqual({ ok: true });
    const result = await store.prune({ maxAgeDays: { public: 1, confidential: 30 } }, Date.parse('2026-08-05T12:00:00.000Z'));
    expect(result).toMatchObject({ retained: 1, deleted: 1 });
    expect(verifyDecisionChain(await store.read())).toEqual({ ok: true });

    await writeFile(path, (await readFile(path, 'utf8')).replace('reviewed', 'tampered'));
    await expect(store.append(input({ event_id: 'event-3' }))).rejects.toThrow(/chain is invalid/);
  });

  it('exports an OpenTelemetry-compatible log record', () => {
    const record = createDecisionRecord(input(), null);
    const exported = toOpenTelemetryLog(record);
    expect(exported).toMatchObject({ severityText: 'INFO', body: { stringValue: 'approval:approved' } });
    expect(JSON.stringify(exported)).toContain('aiwg.mission.id');
  });

  it('carries optional graph decision identity through audit and telemetry', () => {
    const graph = {
      graph_id: 'release/graph', graph_version: '1.0.0', run_id: 'run-1',
      node_id: 'approval', node_run_id: 'run-1:approval:2:1', edge_id: 'review-to-approval',
      route_name: 'request-approval', route_reason: 'policy matched', checkpoint_id: 'checkpoint-2',
      replay_parent_run_id: 'run-0',
    };
    const record = createDecisionRecord(input({ graph }), null);
    expect(record.graph).toEqual(graph);
    const exported = JSON.stringify(toOpenTelemetryLog(record));
    expect(exported).toContain('aiwg.graph.node_run_id');
    expect(exported).toContain('checkpoint-2');
    expect(() => createDecisionRecord(input({ graph: { ...graph, run_id: '' } }), null)).toThrow(/graph decision context/);
  });

  it('requires identity, reason, and correlation', () => {
    expect(() => createDecisionRecord(input({ actor: { id: '', type: 'human', authentication: '' } }), null)).toThrow(/identity/);
    expect(() => createDecisionRecord(input({ reason: '' }), null)).toThrow(/reason/);
    expect(() => createDecisionRecord(input({ correlation: {} }), null)).toThrow(/correlation/);
    expect(digestDecisionContext({ a: 1, b: 2 })).toBe(digestDecisionContext({ b: 2, a: 1 }));
  });
});
