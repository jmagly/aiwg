import { describe, expect, it } from 'vitest';
import { planDecisionGraph, DecisionGraphError, type DecisionGraph } from '../../../src/decision/graph.js';
const pin = { id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` as const };
const hash = `sha256:${'b'.repeat(64)}` as const;
const known = new Set([pin.digest]);
const node = (id: string, stage: number) => ({ id, stage, subject: 'same', target: 'jev', model: 'm1',
  egress: 'local', stateDigest: hash, definition: pin, binding: pin,
  input: stage ? ['evidence'] : [], output: ['result'] });
function fixture(): DecisionGraph {
  return { schemaVersion: 'decision-graph/v1', id: 'sample', entry: 'root', terminals: ['left', 'right'],
    pattern: 'shortlist-rerank', nodes: [node('root', 0), node('left', 1), node('right', 1)],
    edges: [{ from: 'root', to: 'left', source: 'result', destination: 'evidence' },
      { from: 'root', to: 'right', source: 'result', destination: 'evidence' }],
    budget: { attempts: 3, deadlineMs: 5000, tokens: 1000, costMicros: 10000,
      fanOut: 3, beamWidth: 3, depth: 3, concurrency: 2 } };
}
const plan = (value: unknown, pins = known) => planDecisionGraph(value, pins);
describe('DAG offline contract (execution disabled)', () => {
  it('DAG-001 canonicalizes insertion order and groups compatible same-subject independent nodes', () => {
    const graph = fixture(); const first = plan(graph);
    const shuffled = structuredClone(graph);
    shuffled.nodes.reverse(); shuffled.edges.reverse(); shuffled.terminals.reverse();
    expect(plan(shuffled)).toEqual(first);
    expect(first.stages.map(stage => stage.nodes)).toEqual([['root'], ['left', 'right']]);
    expect(first.stages[1]?.batches).toEqual([['left', 'right']]);
  });
  it('DAG-002 separates different subjects and rejects unresolved pins without dispatch', () => {
    const graph = fixture(); graph.nodes[2]!.subject = 'other';
    expect(plan(graph).stages[1]).toMatchObject({ batches: [], fanOut: ['left', 'right'] });
    expect(() => plan(graph, new Set())).toThrow(DecisionGraphError);
  });
  it('DAG-002b does not batch different resolved binding pins', () => {
    const graph = fixture();
    const other = { ...pin, digest: `sha256:${'c'.repeat(64)}` as const };
    graph.nodes[2]!.binding = other;
    expect(plan(graph, new Set([pin.digest, other.digest])).stages[1]).toMatchObject({ batches: [], fanOut: ['left', 'right'] });
  });
  it('DAG-003 rejects cycles, cross-stage and dangling edges', () => {
    for (const change of [
      (g: DecisionGraph) => { g.edges.push({ from: 'left', to: 'root', source: 'result', destination: 'evidence' }); },
      (g: DecisionGraph) => { g.edges[0]!.to = 'missing'; },
      (g: DecisionGraph) => { g.nodes[1]!.stage = 0; },
      (g: DecisionGraph) => { g.nodes[1]!.id = 'root'; },
    ]) { const graph = fixture(); change(graph); expect(() => plan(graph)).toThrow(DecisionGraphError); }
  });
  it('DAG-004 rejects undeclared, duplicate, and use-before-produce projections', () => {
    for (const change of [
      (g: DecisionGraph) => { g.edges[0]!.source = 'missing'; },
      (g: DecisionGraph) => { g.edges.push({ ...g.edges[0]! }); },
      (g: DecisionGraph) => { g.nodes[1]!.input = ['other']; },
      (g: DecisionGraph) => { g.nodes[1]!.input.push('unproduced'); },
    ]) { const graph = fixture(); change(graph); expect(() => plan(graph)).toThrow(DecisionGraphError); }
  });
  it('DAG-005 enforces bounded numeric budgets and stage limits before any execution', () => {
    const graph = fixture(); graph.budget.fanOut = 1;
    expect(() => plan(graph)).toThrow(DecisionGraphError);
    graph.budget.fanOut = 3; graph.budget.tokens = 0;
    expect(() => plan(graph)).toThrow(DecisionGraphError);
    graph.budget.tokens = 1000; graph.budget.depth = 1;
    expect(() => plan(graph)).toThrow(DecisionGraphError);
  });
  it('DAG-006 ignores model-authored graph instructions in evidence (no executable inputs)', () => {
    const graph = fixture();
    expect(() => plan({ ...graph, modelOverride: { terminals: [], authorizeAction: true } })).toThrow(DecisionGraphError);
  });
});
