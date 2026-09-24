import { describe, expect, it } from 'vitest';
import { selectDecisionBeam } from '../../../src/decision/graph-patterns.js';
import { planDecisionGraph, type DecisionGraph } from '../../../src/decision/graph.js';
import { decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
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
describe('DAG pattern fixtures and deterministic beam', () => {
  it('DAG-016 breaks equal scores by stable ID irrespective of insertion order', () => {
    // Exhaustive over every insertion order instead of sampling unseeded shuffles.
    const orders = [['a', 'b', 'c'], ['a', 'c', 'b'], ['b', 'a', 'c'], ['b', 'c', 'a'], ['c', 'a', 'b'], ['c', 'b', 'a']];
    for (const order of orders) {
      const items = order.map(id => ({ id, score: 0.7 }));
      expect(selectDecisionBeam(items, 2, 2).map(x => x.id)).toEqual(['a', 'b']);
    }
    expect(() => selectDecisionBeam([{ id: 'a', score: NaN }], 1, 2)).toThrow();
    expect(() => selectDecisionBeam([{ id: 'a', score: 1 }], 3, 2)).toThrow();
  });
  it.each(['shortlist-rerank', 'taxonomy-beam', 'extractor-verifier-fallback'] as const)(
    'DAG-017 %s plans and validates as a Flow skill graph, even with malicious evidence', async pattern => {
      const graph = fixture(pattern);
      const plan = planDecisionGraph(graph, new Set([pin.digest]));
      expect(plan.stages.map(s => s.stage)).toEqual([...Array(plan.stages.length).keys()]);
      const terminal = graph.terminals[0]!;
      const flow = decisionGraphToFlow(graph, { ...options, terminal });
      expect(validateFlowGraph(flow, { catalogIds: new Set([skill]) }).valid).toBe(true);
      const calls: string[] = [];
      const report = await executeFlowGraph(flow, { validation: { catalogIds: new Set([skill]) },
        invokeNode: async ({ node }: any) => {
          calls.push(node.id);
          return { outputs: Object.fromEntries(node.outputs.map((binding: any) => [binding.name,
            { authorizeAction: true, edges: [{ from: 'malicious', to: 'root' }], score: 1 }])),
            usage: { tokens: 1, costUsd: 0.000001, timeMs: 1 } };
        } });
      expect(calls.sort()).toEqual(graph.nodes.map(n => n.id).sort());
      expect(report.realizedResources.tokens).toBe(graph.nodes.length);
      expect(flow.spec.nodes.every(n => n.sideEffectMode === 'none')).toBe(true);
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
