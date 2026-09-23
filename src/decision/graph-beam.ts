import { DecisionGraphError, type DecisionGraph } from './graph.js';
import { effectiveGraphCeilings, type GraphCeilings } from './graph-evidence.js';
import { selectDecisionBeam } from './graph-patterns.js';
import type { GraphFlowRequest, GraphFlowResponse } from './graph-flow-adapter.js';

/** A deterministic host-side selector at the existing Flow skill invocation seam.
 * It cannot create nodes, change pins, dispatch inference or authorize actions.
 * The host still wraps this with admittedDecisionFlowAdapter for uniform accounting.
 */
export function graphBeamFlowInvoker(graph: DecisionGraph,
  delegate: (request: GraphFlowRequest) => Promise<GraphFlowResponse>, ceilings: GraphCeilings[] = [],
): (request: GraphFlowRequest) => Promise<GraphFlowResponse> {
  const nodeStage = graph.nodes.find(n => n.id === 'select')?.stage;
  const stageWidth = graph.stageBudgets?.find(item => item.stage === nodeStage)?.limits.beamWidth;
  const width = Math.min(effectiveGraphCeilings(graph, ...ceilings).beamWidth, stageWidth ?? Infinity);
  return async request => {
    const node = graph.nodes.find(n => n.id === request.node.id);
    if (node?.target !== 'beam') return delegate(request);
    if (graph.pattern !== 'taxonomy-beam' || node.id !== 'select' || request.node.kind !== 'skill') {
      throw new DecisionGraphError('unauthorized beam selector');
    }
    const candidates = node.input.map(id => {
      const score = request.inputs[id];
      if (typeof score !== 'number' || !Number.isFinite(score)) throw new DecisionGraphError('invalid beam score');
      return { id, score };
    });
    if (!candidates.length) throw new DecisionGraphError('empty beam shortlist');
    const ranked = selectDecisionBeam(candidates, Math.min(width, candidates.length), width).map(item => item.id);
    const selected = new Set(ranked);
    const output: Record<string, unknown> = { result: ranked };
    for (const id of node.input) {
      const flag = `chosen-${id}`;
      if (node.output.includes(flag)) output[flag] = selected.has(id);
    }
    if (node.output.some(key => !Object.hasOwn(output, key))) throw new DecisionGraphError('beam selector output mismatch');
    return { outputs: output, attempts: 1, usage: { tokens: 0, costUsd: 0, timeMs: 0 } };
  };
}
