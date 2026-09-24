import { describe, expect, it } from 'vitest';
import { decisionGraphParallelDispatch } from '../../../src/decision/graph-parallel.js';
import { GraphBudgetLedger } from '../../../src/decision/graph-budget.js';
import { admittedDecisionFlowAdapter } from '../../../src/decision/graph-flow-adapter.js';
import { decisionBatchQuestionId } from '../../../src/decision/batch.js';
import { planDecisionGraph, type DecisionGraph } from '../../../src/decision/graph.js';
import { decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
import { finalizeDecisionGraphRun } from '../../../src/decision/graph-run.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { executeFlowGraph } = require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs');
const pin = { id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` as const };
const hash = `sha256:${'b'.repeat(64)}` as const;
const skill = 'aiwg:skill:7763181ed98b5100' as const;
function fixture(): DecisionGraph {
  return { schemaVersion: 'decision-graph/v1', id: 'native-batch', entry: 'root', terminals: ['left', 'right'],
    nodes: ['root', 'left', 'right'].map((id, i) => ({ id, stage: i ? 1 : 0, subject: 'same',
      target: 'jev', model: 'm', egress: 'local', stateDigest: hash, definition: pin, binding: pin,
      input: i ? ['evidence'] : [], output: ['result'] })),
    edges: ['left', 'right'].map(to => ({ from: 'root', to, source: 'result', destination: 'evidence' })),
    budget: { attempts: 3, deadlineMs: 100, tokens: 10, costMicros: 10,
      fanOut: 2, beamWidth: 2, depth: 2, concurrency: 2 } };
}
const usage = { tokens: 1, costUsd: 0.000001, timeMs: 1 };
async function run(graph: DecisionGraph, badIds = false) {
  const plan = planDecisionGraph(graph, new Set([pin.digest]));
  const manifest = decisionGraphToFlow(graph, { resolvedPins: new Set([pin.digest]),
    decisionSkillId: skill, terminal: 'left' });
  const ledger = new GraphBudgetLedger(graph, plan);
  const ordinary: string[] = [], native: string[][] = [], observations: string[] = [], records: any[] = []; 
  const invokeNode = admittedDecisionFlowAdapter(ledger, () => ({ attempts: 1, tokens: 2, costMicros: 2 }),
    async req => { ordinary.push(req.node.id); return { outputs: { result: req.node.id }, attempts: 1, usage }; },
    undefined, item => { observations.push(item.request.node.id); records.push(structuredClone(item)); });
  const parallelDispatch = decisionGraphParallelDispatch(graph, plan, {
    ledger, estimate: () => ({ attempts: 1, tokens: 2, costMicros: 2 }),
    canBatch: () => true,
    invokeNativeBatch: async requests => {
      return requests.map(r => ({ questionId: badIds ? 'invalid' : decisionBatchQuestionId(r.node.id),
        value: { outputs: { result: r.node.id }, attempts: 1, usage } })).reverse();
    },
    onObservation: item => { observations.push(item.request.node.id); records.push(structuredClone(item)); },
    onNativeBatch: ids => native.push(ids),
  });
  const report = await executeFlowGraph(manifest, { validation: { catalogIds: new Set([skill]) },
    invokeNode, parallelDispatch, runId: 'batch-run' });
  return { report, ordinary, native, observations, records, plan }; 
}
describe('DAG native batch and independent fan-out through Flow', () => {
  it('DAG-036 batches same-subject compatible nodes atomically, mapping reversed provider order', async () => {
    const result = await run(fixture());
    expect(result.native).toEqual([['left', 'right']]);
    expect(result.ordinary).toEqual(['root']);
    expect(result.report.results.left.outputs.result).toBe('left');
    expect(result.report.results.right.outputs.result).toBe('right');
    expect(result.observations.sort()).toEqual(['left', 'right', 'root']);
    const receipt = finalizeDecisionGraphRun(fixture(), result.plan, result.report, result.records,
      [], undefined, result.native);
    expect(receipt.batches).toMatchObject([{ nodes: ['left', 'right'], executedNative: true }]);
    expect(receipt.evidence.stages[1]!.nodes.find(n => n.id === 'right')!.used).toBe(false);
    expect(receipt.evidence.totals).toMatchObject({ attempts: 3, tokens: 3, costMicros: 3 });
  });
  it('DAG-037 different subjects fan out without native batching', async () => {
    const graph = fixture(); graph.nodes[2]!.subject = 'different';
    const result = await run(graph);
    expect(result.native).toEqual([]);
    expect(result.ordinary.sort()).toEqual(['left', 'right', 'root']);
  });
  it('DAG-038 prevents native batching when runtime projected inputs differ despite matching plan', async () => {
    const graph = fixture(); const plan = planDecisionGraph(graph, new Set([pin.digest]));
    const ledger = new GraphBudgetLedger(graph, plan);
    let batched = 0, individual = 0;
    const parallel = decisionGraphParallelDispatch(graph, plan, { ledger,
      estimate: () => ({ attempts: 1, tokens: 1, costMicros: 1 }), canBatch: () => true,
      invokeNativeBatch: async () => { batched++; return []; } });
    const requests: any[] = ['left', 'right'].map(id => ({ node: { id, kind: 'skill', phase: 'stage-1',
      retry: { limit: 0 }, sideEffectMode: 'none' }, inputs: { evidence: id }, runId: 'r' }));
    await parallel(requests, async req => { individual++; return { outputs: { result: req.node.id },
      attempts: 1, usage }; });
    expect({ batched, individual }).toEqual({ batched: 0, individual: 2 });
  });
  it('DAG-039 rejects duplicated/unknown provider correlation without partial observations', async () => {
    const result = await run(fixture(), true);
    expect(result.report.status).toBe('failed');
    expect(result.observations).toEqual(['root']);
  });
});
