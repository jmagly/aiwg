import { describe, expect, it } from 'vitest';
import { planDecisionGraph, type DecisionGraph } from '../../../src/decision/graph.js';
import { auditGraphEvidence, type GraphObservation } from '../../../src/decision/graph-evidence.js';
import { decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
import { GraphBudgetLedger } from '../../../src/decision/graph-budget.js';
import { admittedDecisionFlowAdapter, type GraphFlowRequest, type GraphFlowResponse } from '../../../src/decision/graph-flow-adapter.js';
import { finalizeDecisionGraphRun } from '../../../src/decision/graph-run.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { executeFlowGraph } = require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs');

// Seeded property tests: random valid DAGs, shuffled insertion order and shuffled
// completion order. Failures print the seed so a case can be replayed exactly.
const pin = { id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` as const };
const other = { id: 'artifact', version: 'v2', digest: `sha256:${'c'.repeat(64)}` as const };
const pins = new Set([pin.digest, other.digest]);
const skill = 'aiwg:skill:7763181ed98b5100' as const;
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0) / 2 ** 32;
}
const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
function shuffle<T>(next: () => number, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** A random valid graph: one entry, every later node fed by at least one earlier node. */
function randomGraph(seed: number): DecisionGraph {
  const next = random(seed);
  const stages = 1 + Math.floor(next() * 4);
  const nodes: DecisionGraph['nodes'] = [];
  const edges: DecisionGraph['edges'] = [];
  const state = `sha256:${'b'.repeat(64)}` as const;
  nodes.push({ id: 'n0-0', stage: 0, subject: 's0', target: 'jev', model: 'm', egress: 'local', stateDigest: state,
    definition: pin, binding: pin, input: [], output: ['out'] });
  for (let stage = 1; stage < stages; stage++) {
    const earlier = nodes.filter(n => n.stage < stage);
    const count = 1 + Math.floor(next() * 3);
    for (let index = 0; index < count; index++) {
      const id = `n${stage}-${index}`;
      const sources = shuffle(next, earlier).slice(0, 1 + Math.floor(next() * Math.min(2, earlier.length)));
      nodes.push({ id, stage, subject: pick(next, ['s0', 's1']), target: 'jev', model: pick(next, ['m', 'm']),
        egress: 'local', stateDigest: state, definition: pin, binding: pick(next, [pin, pin, other]),
        input: sources.map(source => `from-${source.id}`), output: ['out'] });
      for (const source of sources) edges.push({ from: source.id, to: id, source: 'out', destination: `from-${source.id}` });
    }
  }
  const terminals = nodes.filter(n => !edges.some(e => e.from === n.id)).map(n => n.id);
  return { schemaVersion: 'decision-graph/v1', id: `random-${seed}`, entry: 'n0-0', terminals, nodes, edges,
    budget: { attempts: 100, deadlineMs: 60_000, tokens: 1_000, costMicros: 1_000,
      fanOut: 3, beamWidth: 3, depth: 4, concurrency: 3 } };
}
/** The same graph with every order-insensitive collection shuffled. */
function reordered(graph: DecisionGraph, seed: number): DecisionGraph {
  const next = random(seed);
  return { ...structuredClone(graph), nodes: shuffle(next, graph.nodes).map(n => ({ ...structuredClone(n),
    input: shuffle(next, n.input), output: shuffle(next, n.output) })),
  edges: shuffle(next, structuredClone(graph.edges)), terminals: shuffle(next, graph.terminals) };
}
const SEEDS = Array.from({ length: 120 }, (_, i) => 0x2608 + i * 31);

describe('seeded properties of plans and receipts', () => {
  it('DAG-055 random DAGs plan identically under shuffled insertion order and keep stage invariants', () => {
    const shapes = { deep: 0, batched: 0, fannedOut: 0 };
    for (const seed of SEEDS) {
      const graph = randomGraph(seed);
      const plan = planDecisionGraph(graph, pins);
      shapes.deep += plan.stages.length >= 3 ? 1 : 0;
      shapes.batched += plan.stages.some(s => s.batches.length) ? 1 : 0;
      shapes.fannedOut += plan.stages.some(s => s.stage > 0 && s.fanOut.length) ? 1 : 0;
      for (let k = 1; k <= 4; k++) expect(planDecisionGraph(reordered(graph, seed * 7 + k), pins), `seed ${seed}/${k}`).toEqual(plan);
      const stageOf = new Map(graph.nodes.map(n => [n.id, n.stage]));
      expect(plan.stages.map(s => s.stage), `seed ${seed}`).toEqual([...plan.stages.keys()]);
      for (const edge of plan.edges) expect(stageOf.get(edge.from)! < stageOf.get(edge.to)!, `seed ${seed}`).toBe(true);
      for (const stage of plan.stages) {
        // Batches and fan-out partition the stage; a batch shares subject and pins.
        expect([...stage.batches.flat(), ...stage.fanOut].sort(), `seed ${seed}`).toEqual([...stage.nodes].sort());
        for (const batch of stage.batches) {
          const members = batch.map(id => graph.nodes.find(n => n.id === id)!);
          expect(new Set(members.map(n => `${n.subject}|${n.binding.digest}|${n.stage}`)).size, `seed ${seed}`).toBe(1);
        }
      }
    }
    // The generator is not degenerate: it covers depth, co-batching and fan-out.
    expect(Math.min(shapes.deep, shapes.batched, shapes.fannedOut)).toBeGreaterThan(10);
  });
  it('DAG-056 evidence receipts are identical for any observation completion order', () => {
    for (const seed of SEEDS) {
      const graph = randomGraph(seed);
      const plan = planDecisionGraph(graph, pins);
      const next = random(seed ^ 0x5eed);
      const observations: GraphObservation[] = graph.nodes.map(n => ({ node: n.id, status: 'ok', output: { out: `${n.id}-value` },
        attempts: 1, tokens: 1 + Math.floor(next() * 5), costMicros: 1 + Math.floor(next() * 5),
        durationMs: Math.floor(next() * 10), used: true }));
      const first = auditGraphEvidence(graph, plan, observations);
      expect(first.outcome, `seed ${seed}`).toBe('complete');
      for (let k = 0; k < 4; k++) {
        const again = auditGraphEvidence(reordered(graph, seed + k), plan, shuffle(random(seed * 13 + k), observations));
        expect(again.receiptDigest, `seed ${seed}/${k}`).toBe(first.receiptDigest);
      }
    }
  });
  it('DAG-057 Flow-hosted receipts do not depend on the order in which parallel calls complete', async () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const graph = randomGraph(seed);
      const plan = planDecisionGraph(graph, pins);
      const manifest = decisionGraphToFlow(graph, { resolvedPins: pins, decisionSkillId: skill, terminal: graph.terminals[0]! });
      const digests = new Set<string>();
      for (let order = 0; order < 3; order++) {
        const records: any[] = [];
        const ledger = new GraphBudgetLedger(graph, plan);
        const invokeNode = admittedDecisionFlowAdapter(ledger, () => ({ attempts: 1, tokens: 2, costMicros: 2 }),
          async (request: GraphFlowRequest): Promise<GraphFlowResponse> => ({ outputs: { out: `${request.node.id}-value` }, attempts: 1,
            usage: { tokens: 1, costUsd: 0.000001, timeMs: 1 } }), undefined, record => records.push(structuredClone(record)));
        // Settle every wave's calls in a seeded order, as a concurrent transport would.
        const next = random(seed * 101 + order);
        const parallelDispatch = async (requests: GraphFlowRequest[], invoke: typeof invokeNode) => {
          const results: GraphFlowResponse[] = new Array(requests.length);
          for (const index of shuffle(next, [...requests.keys()])) results[index] = await invoke(requests[index]!);
          return results;
        };
        const report = await executeFlowGraph(manifest, { validation: { catalogIds: new Set([skill]) },
          invokeNode, parallelDispatch, runId: `property-${seed}` });
        expect(report.status, `seed ${seed}/${order}`).toBe('completed');
        const receipt = finalizeDecisionGraphRun(graph, plan, report, records);
        expect(receipt.outcome, `seed ${seed}/${order}`).toBe('complete');
        digests.add(receipt.receiptDigest);
      }
      expect(digests.size, `seed ${seed}`).toBe(1);
    }
  });
});
