import { describe, expect, it } from 'vitest';
import { artifactPin } from '../../../src/decision/validate.js';
import { decisionRulesetFlowInvoker } from '../../../src/decision/graph-decision-bridge.js';
import { decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
import { GraphBudgetLedger } from '../../../src/decision/graph-budget.js';
import { admittedDecisionFlowAdapter } from '../../../src/decision/graph-flow-adapter.js';
import { planDecisionGraph } from '../../../src/decision/graph.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { executeFlowGraph } = require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs');
import type { DecisionGraph } from '../../../src/decision/graph.js';
import type { DecisionEvaluationRequest, RulesetResult } from '../../../src/decision/types.js';
import type { GraphFlowRequest } from '../../../src/decision/graph-flow-adapter.js';
const definition = { metadata: { id: 'definition', version: 'v1' }, kind: 'DecisionDefinition' };
const binding = { metadata: { id: 'binding', version: 'v1' }, kind: 'DecisionBinding' };
const pin = artifactPin(definition); const bindingPin = artifactPin(binding);
const graph: DecisionGraph = { schemaVersion: 'decision-graph/v1', id: 'bridge', entry: 'entry', terminals: ['dependent'],
  nodes: ['entry', 'dependent'].map((id, stage) => ({ id, stage, subject: 'case', target: 'jev', model: 'm', egress: 'local',
    stateDigest: `sha256:${'a'.repeat(64)}`, definition: pin, binding: bindingPin,
    input: stage ? ['evidence'] : [], output: ['result'] })),
  edges: [{ from: 'entry', to: 'dependent', source: 'result', destination: 'evidence' }],
  budget: { attempts: 3, deadlineMs: 100, tokens: 10, costMicros: 20, fanOut: 1, beamWidth: 1, depth: 2, concurrency: 1 } };
const flow: GraphFlowRequest = { node: { id: 'dependent', kind: 'skill', phase: 'stage-1', retry: { limit: 0 }, sideEffectMode: 'none' },
  inputs: { evidence: { payload: 'data', graphOverride: { terminals: [] } }, 'binding-pin': bindingPin },
  runId: 'flow-run', nodeRunId: 'flow-node-run', activationId: 'flow-activation', invocationKey: 'flow-invocation' };
const resolved = { binding, definitions: { d: definition }, input: { host: true }, runId: 'old', invocationId: 'old' } as unknown as DecisionEvaluationRequest;
const result = { spec: { evaluations: { d: { spec: { attempts: [
  { usage: { inputTokens: 2, outputTokens: 1, costUsd: null }, durationMs: 3 },
] } } }, status: 'completed' } } as unknown as RulesetResult;
describe('DAG real dispatcher bridge boundary', () => {
  it('DAG-025 passes only declared evidence and Flow identity into decision-evaluate', async () => {
    const requests: DecisionEvaluationRequest[] = [];
    const invoke = decisionRulesetFlowInvoker(graph, { resolve: () => resolved,
      project: () => ({ result: 'review' }), unknownCostBoundUsd: 0.000004,
      evaluate: async req => { requests.push(req); return result; } });
    const response = await invoke(flow);
    expect(requests[0]!.input).toEqual({ evidence: flow.inputs.evidence });
    expect(requests[0]).toMatchObject({ runId: 'flow-run', invocationId: 'flow-invocation' });
    expect(response).toEqual({ outputs: { result: 'review' }, attempts: 1,
      usage: { tokens: 3, costUsd: 0.000004, timeMs: 3 } });
  });
  it('DAG-026 executes both stages with Flow identities, budget admission and dispatcher bridge', async () => {
    const skill = 'aiwg:skill:7763181ed98b5100' as const;
    const manifest = decisionGraphToFlow(graph, { resolvedPins: new Set([pin.digest, bindingPin.digest]),
      decisionSkillId: skill, terminal: 'dependent' });
    const calls: DecisionEvaluationRequest[] = [];
    const invoker = decisionRulesetFlowInvoker(graph, { resolve: () => resolved,
      project: id => ({ result: id }), unknownCostBoundUsd: 0.000004,
      evaluate: async req => { calls.push(req); return result; } });
    const ledger = new GraphBudgetLedger(graph, planDecisionGraph(graph, new Set([pin.digest, bindingPin.digest])));
    const invokeNode = admittedDecisionFlowAdapter(ledger,
      () => ({ attempts: 1, tokens: 4, costMicros: 5 }), invoker);
    const report = await executeFlowGraph(manifest, { validation: { catalogIds: new Set([skill]) }, invokeNode });
    expect(report.realizedResources).toMatchObject({ nodeRuns: 2, tokens: 6 });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toEqual({ evidence: 'entry' });
    expect(calls[1]!.invocationId).toContain('dependent');
    expect(report.output).toBe('dependent');
  });
  it('DAG-027 rejects pin mismatch, undeclared output, unknown token counts and unbounded cost', async () => {
    expect(() => decisionRulesetFlowInvoker(graph, { resolve: () => resolved, project: () => ({}), unknownCostBoundUsd: 0 })).toThrow();
    const invoke = decisionRulesetFlowInvoker(graph, { resolve: () => resolved,
      project: () => ({ graphOverride: true }), unknownCostBoundUsd: 0.000004,
      evaluate: async () => result });
    await expect(invoke(flow)).rejects.toThrow(/outputs/);
    const guarded = structuredClone(graph);
    guarded.nodes[0]!.output.push('branch');
    guarded.edges[0]!.when = { source: 'branch', equals: true };
    const guardedFlow = { ...flow, node: { ...flow.node, id: 'entry' } };
    await expect(decisionRulesetFlowInvoker(guarded, { resolve: () => resolved,
      project: () => ({ result: true, branch: 'not-boolean' }), unknownCostBoundUsd: 0.000004,
      evaluate: async () => result })(guardedFlow)).rejects.toThrow(/outputs/);
    const modified = { ...graph, nodes: graph.nodes.map(node => ({ ...node, binding: pin })) };
    await expect(decisionRulesetFlowInvoker(modified, { resolve: () => resolved, project: () => ({ result: true }),
      unknownCostBoundUsd: 0.000004, evaluate: async () => result })(flow)).rejects.toThrow(/pin/);
    const unknown = structuredClone(result); unknown.spec.evaluations.d!.spec.attempts[0]!.usage.inputTokens = null;
    await expect(decisionRulesetFlowInvoker(graph, { resolve: () => resolved, project: () => ({ result: true }),
      unknownCostBoundUsd: 0.000004, evaluate: async () => unknown })(flow)).rejects.toThrow(/token/);
  });
});
