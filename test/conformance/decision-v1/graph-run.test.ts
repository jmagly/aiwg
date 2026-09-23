import { describe, expect, it } from 'vitest';
import { finalizeDecisionGraphRun } from '../../../src/decision/graph-run.js';
import { decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
import { planDecisionGraph, type DecisionGraph } from '../../../src/decision/graph.js';
import { GraphBudgetLedger } from '../../../src/decision/graph-budget.js';
import { admittedDecisionFlowAdapter } from '../../../src/decision/graph-flow-adapter.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { executeFlowGraph } = require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs');
const pin = { id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` as const };
const hash = `sha256:${'b'.repeat(64)}` as const;
const skill = 'aiwg:skill:7763181ed98b5100' as const;
const graph: DecisionGraph = { schemaVersion: 'decision-graph/v1', id: 'graph-run', entry: 'root', terminals: ['left', 'right'],
  nodes: ['root', 'left', 'right'].map((id, index) => ({ id, stage: index ? 1 : 0,
    subject: 'case', target: 'jev', model: 'm', egress: 'local', stateDigest: hash,
    definition: pin, binding: pin, input: index ? ['evidence'] : [], output: index ? ['result'] : ['result', 'branch'] })),
  edges: [
    { from: 'root', to: 'left', source: 'result', destination: 'evidence', when: { source: 'branch', equals: true } },
    { from: 'root', to: 'right', source: 'result', destination: 'evidence', when: { source: 'branch', equals: false } },
  ], budget: { attempts: 3, deadlineMs: 100, tokens: 10, costMicros: 20,
    fanOut: 2, beamWidth: 2, depth: 2, concurrency: 2 } };
const plan = planDecisionGraph(graph, new Set([pin.digest]));
const flow = decisionGraphToFlow(graph, { resolvedPins: new Set([pin.digest]), decisionSkillId: skill, terminal: 'left' });
async function run(branch: boolean) {
  const ledger = new GraphBudgetLedger(graph, plan);
  const records: any[] = [];
  const invokeNode = admittedDecisionFlowAdapter(ledger, () => ({ attempts: 1, tokens: 2, costMicros: 2 }),
    async request => ({ outputs: request.node.id === 'root' ? { result: 'root', branch } : { result: request.node.id },
      attempts: 1, usage: { tokens: 1, costUsd: 0.000001, timeMs: 1 } }), undefined,
    record => records.push(structuredClone(record)));
  const report = await executeFlowGraph(flow, { validation: { catalogIds: new Set([skill]) }, invokeNode, runId: 'run-test' });
  return { report, records };
}
describe('DAG Flow run receipt', () => {
  it('DAG-028 correlates immutable stage, result digest and Flow invocation for chosen branch', async () => {
    const { report, records } = await run(true);
    expect({ status: report.status, skipped: report.checkpoint.skipped, completed: report.checkpoint.completed,
      count: records.length, runs: report.realizedResources.nodeRuns }).toEqual({ status: 'failed', skipped: [], completed: ['root', 'left'], count: 2, runs: 2 });
    const receipt = finalizeDecisionGraphRun(graph, plan, report, records);
    expect(receipt.outcome).toBe('complete');
    expect(receipt.terminal).toBe('left');
    expect(finalizeDecisionGraphRun(graph, plan, report, [...records].reverse()).receiptDigest).toBe(receipt.receiptDigest);
    expect(receipt.evidence.totals).toMatchObject({ attempts: 2, tokens: 2, costMicros: 2 });
    expect(receipt.evidence.stages[1]!.nodes.find(n => n.id === 'left')!.flow?.invocationKey).toContain('left');
    expect(receipt.evidence.stages[1]!.nodes.find(n => n.id === 'right')!.used).toBe(false);
  });
  it('DAG-029 rejects tampered Flow results before issuing any graph value', async () => {
    const { report, records } = await run(true);
    report.results.root.outputs.branch = false;
    expect(() => finalizeDecisionGraphRun(graph, plan, report, records)).toThrow(/mismatch/);
  });
  it('DAG-030 does not promote unrelated Flow failures to complete outcomes', async () => {
    const { report, records } = await run(true);
    report.stopReason = 'permission denied';
    const receipt = finalizeDecisionGraphRun(graph, plan, report, records);
    expect(receipt.outcome).toBe('error');
    expect(receipt.value).toBeNull();
  });
  it('DAG-031 selects the other declared terminal, not an absent Flow public output', async () => {
    const { report, records } = await run(false);
    const receipt = finalizeDecisionGraphRun(graph, plan, report, records);
    expect(receipt.outcome).toBe('complete');
    expect(receipt.terminal).toBe('right');
    expect(receipt.value).toEqual({ result: 'right' });
  });
});
