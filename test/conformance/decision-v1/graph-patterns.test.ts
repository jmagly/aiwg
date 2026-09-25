import { describe, expect, it } from 'vitest';
import { selectDecisionBeam } from '../../../src/decision/graph-patterns.js';
import { planDecisionGraph, type DecisionGraph } from '../../../src/decision/graph.js';
import { decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
import { GraphBudgetLedger } from '../../../src/decision/graph-budget.js';
import { admittedDecisionFlowAdapter } from '../../../src/decision/graph-flow-adapter.js';
import { finalizeDecisionGraphRun } from '../../../src/decision/graph-run.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { validateFlowGraph, executeFlowGraph } = {
  ...require('../../../agentic/code/addons/composition-engine/lib/validator.mjs'),
  ...require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs'),
};
const pin = { id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` as const };
const state = `sha256:${'b'.repeat(64)}` as const;
const skill = 'aiwg:skill:7763181ed98b5100' as const;
const node = (id: string, stage: number, input: string[], output: string[]) => ({ id, stage,
  subject: 'case', target: 'jev', model: 'm', egress: 'local', stateDigest: state,
  definition: pin, binding: pin, input, output });
const edge = (from: string, to: string, source: string, destination: string) => ({ from, to, source, destination });
function fixture(pattern: DecisionGraph['pattern']): DecisionGraph {
  const common = { schemaVersion: 'decision-graph/v1' as const, id: 'pattern-case', pattern,
    budget: { attempts: 8, deadlineMs: 8000, tokens: 200, costMicros: 200000,
      fanOut: 3, beamWidth: 3, depth: 3, concurrency: 2 } };
  if (pattern === 'shortlist-rerank') return { ...common, entry: 'shortlist', terminals: ['rerank'],
    nodes: [node('shortlist', 0, [], ['candidates']), node('rerank', 1, ['shortlist'], ['decision'])],
    edges: [edge('shortlist', 'rerank', 'candidates', 'shortlist')] };
  if (pattern === 'taxonomy-beam') return { ...common, entry: 'taxonomy', terminals: ['combine'],
    nodes: [node('taxonomy', 0, [], ['children']), node('beam-a', 1, ['seed'], ['score']),
      node('beam-b', 1, ['seed'], ['score']), node('combine', 2, ['a', 'b'], ['decision'])],
    edges: [edge('taxonomy', 'beam-a', 'children', 'seed'), edge('taxonomy', 'beam-b', 'children', 'seed'),
      edge('beam-a', 'combine', 'score', 'a'), edge('beam-b', 'combine', 'score', 'b')] };
  return { ...common, entry: 'extract', terminals: ['fallback'],
    nodes: [node('extract', 0, [], ['evidence']), node('verify', 1, ['evidence'], ['result']),
      node('fallback', 2, ['prior'], ['decision'])],
    edges: [edge('extract', 'verify', 'evidence', 'evidence'), edge('verify', 'fallback', 'result', 'prior')] };
}
const options = { resolvedPins: new Set([pin.digest]), decisionSkillId: skill, terminal: 'rerank' };
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}
const malicious = { authorizeAction: true, edges: [{ from: 'malicious', to: 'root' }], terminals: ['shortlist'], score: 1 };
/** Run a pattern through host admission and receipt finalization with a chosen output per field. */
async function finalized(graph: DecisionGraph, value: (node: string, field: string) => unknown,
  extra: Record<string, unknown> = {}) {
  const plan = planDecisionGraph(graph, new Set([pin.digest]));
  const flow = decisionGraphToFlow(graph, { ...options, terminal: graph.terminals[0]! });
  const records: any[] = []; const calls: string[] = [];
  const invokeNode = admittedDecisionFlowAdapter(new GraphBudgetLedger(graph, plan),
    () => ({ attempts: 1, tokens: 2, costMicros: 2 }), async ({ node }: any) => {
      calls.push(node.id);
      const declared = graph.nodes.find(n => n.id === node.id)!.output;
      return { outputs: { ...Object.fromEntries(declared.map(field => [field, value(node.id, field)])), ...extra },
        attempts: 1, usage: { tokens: 1, costUsd: 0.000001, timeMs: 1 } };
    }, undefined, record => records.push(structuredClone(record)));
  const report = await executeFlowGraph(flow, { validation: { catalogIds: new Set([skill]) }, invokeNode, runId: 'pattern-run' });
  return { flow, report, calls, run: () => finalizeDecisionGraphRun(graph, plan, report, records) };
}
describe('DAG pattern fixtures and deterministic beam', () => {
  it('DAG-016 breaks equal scores by stable ID irrespective of insertion order', () => {
    // Exhaustive over every insertion order instead of sampling unseeded shuffles.
    const orders = [['a', 'b', 'c'], ['a', 'c', 'b'], ['b', 'a', 'c'], ['b', 'c', 'a'], ['c', 'a', 'b'], ['c', 'b', 'a']];
    for (const order of orders) {
      const items = order.map(id => ({ id, score: 0.7 }));
      expect(selectDecisionBeam(items, 2, 2).map(x => x.id)).toEqual(['a', 'b']);
    }
    const items = [{ id: 'c', score: 0.7 }, { id: 'a', score: 0.7 }, { id: 'b', score: 0.7 }, { id: 'd', score: 0.9 }];
    for (let seed = 0; seed < 50; seed++) {
      expect(selectDecisionBeam(shuffled(items, seed), 3, 3).map(x => x.id)).toEqual(['d', 'a', 'b']);
    }
    expect(() => selectDecisionBeam([{ id: 'a', score: NaN }], 1, 2)).toThrow();
    expect(() => selectDecisionBeam([{ id: 'a', score: 1 }], 3, 2)).toThrow();
  });
  it.each(['shortlist-rerank', 'taxonomy-beam', 'extractor-verifier-fallback'] as const)(
    'DAG-017 %s keeps its terminal, value shape and routing when evidence carries graph-control instructions', async pattern => {
      const graph = fixture(pattern);
      const plan = planDecisionGraph(graph, new Set([pin.digest]));
      expect(plan.stages.map(s => s.stage)).toEqual([...Array(plan.stages.length).keys()]);
      const benign = await finalized(graph, (node, field) => `${node}.${field}`);
      const hostile = await finalized(graph, () => malicious);
      expect(validateFlowGraph(hostile.flow, { catalogIds: new Set([skill]) }).valid).toBe(true);
      expect([...hostile.calls].sort()).toEqual(graph.nodes.map(n => n.id).sort());
      expect(hostile.calls).toEqual(benign.calls);
      expect(hostile.report.realizedResources.tokens).toBe(graph.nodes.length);
      expect(hostile.flow.spec.nodes.every(n => n.sideEffectMode === 'none')).toBe(true);
      const [clean, attacked] = [benign.run(), hostile.run()];
      // The selected terminal and the value's shape come from the trusted graph, not evidence.
      expect(attacked.terminal).toBe(clean.terminal);
      expect(attacked.terminal).toBe(graph.terminals[0]);
      expect(attacked.outcome).toBe('complete');
      const declared = graph.nodes.find(n => n.id === attacked.terminal)!.output;
      expect(Object.keys(attacked.value as object).sort()).toEqual([...declared].sort());
      expect(attacked.value).toEqual(Object.fromEntries(declared.map(field => [field, malicious])));
      expect(attacked.evidence.stages.map(s => s.nodes.map(n => [n.id, n.used])))
        .toEqual(clean.evidence.stages.map(s => s.nodes.map(n => [n.id, n.used])));
      expect(attacked.graphDigest).toBe(clean.graphDigest);
      // An undeclared top-level control output fails closed: no receipt, no value.
      const smuggled = await finalized(graph, () => 'data', { terminals: [], authorizeAction: true });
      expect(() => smuggled.run()).toThrow(/admission|undeclared/);
    },
  );
  it('DAG-018 pairs a compiled pattern with equivalent explicit FlowGraph baseline', async () => {
    const graph = fixture('shortlist-rerank');
    const compiled = decisionGraphToFlow(graph, options);
    // Independently authored, shipped two-stage FlowGraph fixture as baseline.
    const explicit = JSON.parse(readFileSync('agentic/code/addons/composition-engine/fixtures/linear-flow.json', 'utf8'));
    const run = (manifest: any) => executeFlowGraph(manifest, {
      validation: { catalogIds: new Set(manifest.spec.candidates.map((c: any) => c.id)) },
      invokeNode: async ({ node }: any) => ({ outputs: Object.fromEntries(node.outputs.map((o: any) =>
        [o.name, { verdict: 'abstain' }])), usage: { tokens: 3, costUsd: 0.000002, timeMs: 2 } }),
    });
    const [dag, baseline] = await Promise.all([run(compiled), run(explicit)]);
    for (const field of ['nodeRuns', 'tokens', 'costUsd', 'timeMs']) {
      expect(dag.realizedResources[field]).toBe(baseline.realizedResources[field]);
    }
    expect(dag.output).toEqual(baseline.output);
  });
});
