import { describe, expect, it } from 'vitest';
import { taxonomyBeamTemplate } from '../../../src/decision/graph-templates.js';
import { graphBeamFlowInvoker } from '../../../src/decision/graph-beam.js';
import { decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
import { GraphBudgetLedger } from '../../../src/decision/graph-budget.js';
import { admittedDecisionFlowAdapter } from '../../../src/decision/graph-flow-adapter.js';
import { finalizeDecisionGraphRun } from '../../../src/decision/graph-run.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { executeFlowGraph, validateFlowGraph } = {
  ...require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs'),
  ...require('../../../agentic/code/addons/composition-engine/lib/validator.mjs'),
};
const pin = { id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` as const };
const config = { subject: 'case', target: 'jev', model: 'm', egress: 'local',
  stateDigest: `sha256:${'b'.repeat(64)}` as const, definition: pin, binding: pin };
const { graph, plan } = taxonomyBeamTemplate({ id: 'beam-graph', resolvedPins: new Set([pin.digest]),
  budget: { attempts: 8, deadlineMs: 100, tokens: 20, costMicros: 20,
    fanOut: 3, beamWidth: 2, depth: 4, concurrency: 2 },
  taxonomy: config, branches: [{ id: 'branch-b', config }, { id: 'branch-a', config }],
  select: { ...config, target: 'beam' }, details: config });
const skill = 'aiwg:skill:7763181ed98b5100' as const;
const manifest = decisionGraphToFlow(graph, { resolvedPins: new Set([pin.digest]), decisionSkillId: skill,
  terminal: 'detail-branch-a', ceilings: [{ beamWidth: 1 }] });
const bounded = [{ beamWidth: 1 }];
describe('DAG host-side taxonomy beam gate', () => {
  it('DAG-034 routes only top-ranked candidate under narrowed width; equal scores break by ID', async () => {
    expect(validateFlowGraph(manifest, { catalogIds: new Set([skill]) }).valid).toBe(true);
    const calls: string[] = []; const records: any[] = [];
    const ordinary = async ({ node }: any) => {
      calls.push(node.id);
      const output = node.id === 'taxonomy' ? { children: 'declared' } :
        node.id.startsWith('branch-') ? { score: 0.5 } : { result: node.id };
      return { outputs: output, attempts: 1, usage: { tokens: 1, costUsd: 0.000001, timeMs: 1 } };
    };
    const adapter = admittedDecisionFlowAdapter(new GraphBudgetLedger(graph, plan, bounded),
      () => ({ attempts: 1, tokens: 2, costMicros: 2 }), graphBeamFlowInvoker(graph, ordinary, bounded),
      undefined, record => records.push(structuredClone(record)));
    const report = await executeFlowGraph(manifest, { validation: { catalogIds: new Set([skill]) },
      invokeNode: adapter, runId: 'beam-run' });
    const receipt = finalizeDecisionGraphRun(graph, plan, report, records, bounded);
    expect(receipt.outcome).toBe('complete');
    expect(receipt.terminal).toBe('detail-branch-a');
    expect(calls.sort()).toEqual(['branch-a', 'branch-b', 'detail-branch-a', 'taxonomy']);
    expect(receipt.evidence.totals.attempts).toBe(5);
    expect(receipt.evidence.stages[3]!.nodes.find(n => n.id === 'detail-branch-b')!.used).toBe(false);
  });
  it('DAG-035 rejects non-finite or invented scores before selecting any detail', async () => {
    const request: any = { node: { id: 'select', kind: 'skill' }, inputs: { 'branch-a': NaN, 'branch-b': 1 } };
    const invoke = graphBeamFlowInvoker(graph, async () => { throw new Error('must not call'); }, bounded);
    await expect(invoke(request)).rejects.toThrow(/score/);
    request.inputs['branch-a'] = 1;
    request.inputs['invented'] = 100;
    expect((await invoke(request)).outputs.result).toEqual(['branch-a']);
  });
});
