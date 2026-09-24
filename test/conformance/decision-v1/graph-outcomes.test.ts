import { describe, expect, it } from 'vitest';
import { artifactPin } from '../../../src/decision/validate.js';
import { decisionResultNodeStatus, decisionRulesetFlowInvoker } from '../../../src/decision/graph-decision-bridge.js';
import { decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
import { GraphBudgetLedger } from '../../../src/decision/graph-budget.js';
import { admittedDecisionFlowAdapter, type GraphFlowRequest, type GraphFlowResponse } from '../../../src/decision/graph-flow-adapter.js';
import { finalizeDecisionGraphRun } from '../../../src/decision/graph-run.js';
import { shortlistRerankTemplate } from '../../../src/decision/graph-templates.js';
import { planDecisionGraph, type DecisionGraph } from '../../../src/decision/graph.js';
import type { DecisionEvaluationRequest, RulesetResult } from '../../../src/decision/types.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { executeFlowGraph } = require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs');
const skill = 'aiwg:skill:7763181ed98b5100' as const;
const definition = { metadata: { id: 'definition', version: 'v1' }, kind: 'DecisionDefinition' };
const binding = { metadata: { id: 'binding', version: 'v1' }, kind: 'DecisionBinding' };
const pin = artifactPin(definition); const bindingPin = artifactPin(binding);
const pins = new Set([pin.digest, bindingPin.digest]);
const graph: DecisionGraph = { schemaVersion: 'decision-graph/v1', id: 'outcomes', entry: 'first', terminals: ['second'],
  nodes: ['first', 'second'].map((id, stage) => ({ id, stage, subject: 'case', target: 'jev', model: 'm', egress: 'local',
    stateDigest: `sha256:${'b'.repeat(64)}`, definition: pin, binding: bindingPin,
    input: stage ? ['previous'] : [], output: ['result'] })),
  edges: [{ from: 'first', to: 'second', source: 'result', destination: 'previous' }],
  budget: { attempts: 4, deadlineMs: 5_000, tokens: 20, costMicros: 20, fanOut: 1, beamWidth: 1, depth: 2, concurrency: 1 } };
const plan = planDecisionGraph(graph, pins);
const manifest = decisionGraphToFlow(graph, { resolvedPins: pins, decisionSkillId: skill, terminal: 'second' });
/** Run through host admission, collect observations and finalize. */
async function run(target: DecisionGraph, targetPlan: typeof plan, flow: any,
  invoke: (request: GraphFlowRequest) => Promise<GraphFlowResponse>) {
  const records: any[] = []; const calls: string[] = [];
  const invokeNode = admittedDecisionFlowAdapter(new GraphBudgetLedger(target, targetPlan),
    () => ({ attempts: 1, tokens: 3, costMicros: 3 }), async request => { calls.push(request.node.id); return invoke(request); },
    undefined, record => records.push(structuredClone(record)));
  const report = await executeFlowGraph(flow, { validation: { catalogIds: new Set([skill]) }, invokeNode, runId: 'outcome-run' });
  return { report, calls, receipt: finalizeDecisionGraphRun(target, targetPlan, report, records) };
}
const usage = { tokens: 2, costUsd: 0.000002, timeMs: 1 };
const resolved = { binding, definitions: { d: definition }, input: { host: true }, runId: 'x', invocationId: 'x' } as unknown as DecisionEvaluationRequest;
function ruleset(reason: string, statuses: string[]): RulesetResult {
  return { spec: { status: 'review', reason, evaluations: Object.fromEntries(statuses.map((status, i) => [`e${i}`, { spec: { status,
    attempts: [{ usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.000001 }, durationMs: 1 }] } }])) } } as unknown as RulesetResult;
}

describe('explicit graph outcomes with no partial result (AC9)', () => {
  it.each(['abstained', 'unsupported'] as const)('DAG-046 a %s node stops the graph with a null value and retained usage', async status => {
    const { report, calls, receipt } = await run(graph, plan, manifest, async request =>
      request.node.id === 'first' ? { outputs: {}, attempts: 1, usage, status } : { outputs: { result: 'must not run' }, attempts: 1, usage });
    expect(calls).toEqual(['first']);
    expect(report.status).toBe('failed');
    expect(receipt.outcome).toBe(status);
    expect(receipt.value).toBeNull();
    expect(receipt.terminal).toBeNull();
    const nodes = receipt.evidence.stages.flatMap(stage => stage.nodes);
    expect(nodes.map(n => [n.id, n.status, n.used])).toEqual([['first', status, false], ['second', 'skipped', false]]);
    // The spent call remains charged even though it produced no evidence.
    expect(receipt.evidence.totals).toMatchObject({ attempts: 1, tokens: 2, costMicros: 2 });
  });
  it('DAG-047 the decision bridge maps abstaining and unsupported rulesets without projecting evidence', async () => {
    expect(decisionResultNodeStatus(ruleset('none', ['abstained', 'abstained']))).toBe('abstained');
    expect(decisionResultNodeStatus(ruleset('unsupported-capability', ['success']))).toBe('unsupported');
    expect(decisionResultNodeStatus(ruleset('none', ['abstained', 'success']))).toBe('ok');
    for (const [result, expected] of [[ruleset('none', ['abstained']), 'abstained'],
      [ruleset('unsupported-capability', ['unsupported']), 'unsupported']] as const) {
      let projected = 0;
      const invoker = decisionRulesetFlowInvoker(graph, { resolve: () => resolved, unknownCostBoundUsd: 0.000001,
        project: () => { projected++; return { result: 'x' }; }, evaluate: async () => result });
      const { calls, receipt } = await run(graph, plan, manifest, invoker);
      expect(projected).toBe(0);
      expect(calls).toEqual(['first']);
      expect(receipt).toMatchObject({ outcome: expected, value: null, terminal: null });
    }
    // A host may override the default classification; an invalid status fails closed.
    const override = decisionRulesetFlowInvoker(graph, { resolve: () => resolved, unknownCostBoundUsd: 0.000001,
      project: () => ({ result: 'x' }), status: () => 'maybe' as never, evaluate: async () => ruleset('none', ['success']) });
    const flow = { node: { id: 'first', kind: 'skill', phase: 'stage-0', retry: { limit: 0 }, sideEffectMode: 'none' },
      inputs: {}, runId: 'r', nodeRunId: 'n', activationId: 'a', invocationKey: 'i' };
    await expect(override(flow)).rejects.toThrow(/status/);
  });
  it('DAG-048 an empty shortlist never reaches reranking and yields empty-shortlist', async () => {
    const config = { subject: 'case', target: 'jev', model: 'm', egress: 'local',
      stateDigest: `sha256:${'b'.repeat(64)}` as const, definition: pin, binding: bindingPin };
    const template = shortlistRerankTemplate({ id: 'empty-shortlist', resolvedPins: pins, budget: graph.budget,
      shortlist: config, rerank: config });
    const flow = decisionGraphToFlow(template.graph, { resolvedPins: pins, decisionSkillId: skill, terminal: 'rerank' });
    for (const candidates of [[], ['a']]) {
      const { calls, receipt } = await run(template.graph, template.plan, flow, async request => ({ attempts: 1, usage,
        outputs: request.node.id === 'shortlist' ? { candidates, 'has-candidates': candidates.length > 0 } : { result: 'a' } }));
      if (candidates.length) {
        expect(receipt).toMatchObject({ outcome: 'complete', terminal: 'rerank', value: { result: 'a' } });
        continue;
      }
      expect(calls).toEqual(['shortlist']);
      expect(receipt).toMatchObject({ outcome: 'empty-shortlist', terminal: null, value: null });
      expect(receipt.evidence.stages[1]!.nodes[0]).toMatchObject({ id: 'rerank', status: 'skipped', attempts: 0 });
      expect(receipt.evidence.totals.attempts).toBe(1);
    }
  });
});
