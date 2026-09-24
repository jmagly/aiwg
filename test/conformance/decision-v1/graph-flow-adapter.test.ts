import { describe, expect, it } from 'vitest';
import { GraphBudgetLedger } from '../../../src/decision/graph-budget.js';
import { admittedDecisionFlowAdapter, type GraphFlowRequest } from '../../../src/decision/graph-flow-adapter.js';
import { planDecisionGraph, type DecisionGraph } from '../../../src/decision/graph.js';
import { decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { executeFlowGraph } = require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs');
const pin = { id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` as const };
const hash = `sha256:${'b'.repeat(64)}` as const;
const skill = 'aiwg:skill:7763181ed98b5100' as const;
const graph: DecisionGraph = { schemaVersion: 'decision-graph/v1', id: 'budget-host', entry: 'first', terminals: ['second'],
  nodes: ['first', 'second'].map((id, stage) => ({ id, stage, subject: 'case', target: 'jev', model: 'm', egress: 'local',
    stateDigest: hash, definition: pin, binding: pin, input: stage ? ['previous'] : [], output: ['result'] })),
  edges: [{ from: 'first', to: 'second', source: 'result', destination: 'previous' }],
  budget: { attempts: 2, deadlineMs: 50, tokens: 6, costMicros: 20, fanOut: 1, beamWidth: 1, depth: 2, concurrency: 1 } };
const plan = planDecisionGraph(graph, new Set([pin.digest]));
const flow = decisionGraphToFlow(graph, { resolvedPins: new Set([pin.digest]), decisionSkillId: skill, terminal: 'second' });
const request: GraphFlowRequest = { node: { id: 'first', kind: 'skill', phase: 'stage-0', retry: { limit: 0 }, sideEffectMode: 'none' },
  inputs: {}, runId: 'r', nodeRunId: 'r:first', activationId: 'r:activation:1', invocationKey: 'i' };
const usage = { tokens: 2, costUsd: 0.000002, timeMs: 1 };
describe('DAG Flow host admission', () => {
  it('DAG-022 reserves before Flow dispatch and preserves Flow correlation', async () => {
    const calls: GraphFlowRequest[] = [];
    const ledger = new GraphBudgetLedger(graph, plan);
    const invokeNode = admittedDecisionFlowAdapter(ledger, () => ({ attempts: 1, tokens: 3, costMicros: 4 }),
      async req => { calls.push(req); return { outputs: { result: 'ok' }, attempts: 1, usage }; });
    const result = await executeFlowGraph(flow, { validation: { catalogIds: new Set([skill]) }, invokeNode });
    expect(result.realizedResources.nodeRuns).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.inputs.previous).toBe('ok');
    expect(calls[1]!.invocationKey).toContain('second');
  });
  it('DAG-023 rejects unknown cost or budget exhaustion before any transport call', async () => {
    let calls = 0;
    const ledger = new GraphBudgetLedger(graph, plan);
    const adapter = admittedDecisionFlowAdapter(ledger, () => ({ attempts: 1, tokens: 1, costMicros: 0 }),
      async () => { calls++; return { outputs: {}, attempts: 1, usage }; });
    await expect(adapter(request)).rejects.toThrow(/estimate/);
    expect(calls).toBe(0);
    const other = admittedDecisionFlowAdapter(ledger, () => ({ attempts: 3, tokens: 3, costMicros: 2 }),
      async () => { calls++; return { outputs: {}, attempts: 1, usage }; });
    await expect(other(request)).rejects.toThrow(/budget/);
    expect(calls).toBe(0);
  });
  it('DAG-024 cancellation and oversized actual usage prevent further calls', async () => {
    const ledger = new GraphBudgetLedger(graph, plan);
    let calls = 0;
    const adapter = admittedDecisionFlowAdapter(ledger, () => ({ attempts: 1, tokens: 1, costMicros: 1 }),
      async () => { calls++; return { outputs: {}, attempts: 1, usage }; });
    await expect(adapter(request)).rejects.toThrow(/reservation/);
    await expect(adapter(request)).rejects.toThrow(/cancelled/);
    expect(calls).toBe(1);
    const controller = new AbortController(); controller.abort();
    const cancelled = admittedDecisionFlowAdapter(new GraphBudgetLedger(graph, plan),
      () => ({ attempts: 1, tokens: 1, costMicros: 1 }), async () => { calls++; return { outputs: {}, attempts: 1, usage }; }, controller.signal);
    await expect(cancelled(request)).rejects.toThrow(/cancelled/);
    expect(calls).toBe(1);
  });
});
