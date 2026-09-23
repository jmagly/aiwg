import { canonicalJson } from '../security/artifact-trust.js';
import { correlateAtomicBatch, decisionBatchQuestionId } from './batch.js';
import { GraphBudgetLedger } from './graph-budget.js';
import { DecisionGraphError, planDecisionGraph, type DecisionGraph, type GraphPlan } from './graph.js';
import type { GraphFlowEstimate, GraphFlowRequest, GraphFlowResponse } from './graph-flow-adapter.js';

/** Flow parallelDispatch seam. Native batching is strictly opt-in and atomic;
 * otherwise the existing admitted invokeNode handles bounded fan-out.
 */
export function decisionGraphParallelDispatch(graph: DecisionGraph, plan: GraphPlan, options: {
  ledger: GraphBudgetLedger;
  estimate: (request: GraphFlowRequest) => GraphFlowEstimate;
  /** Authenticated transport capability, not model-provided policy. */
  canBatch: (requests: readonly GraphFlowRequest[]) => boolean;
  invokeNativeBatch: (requests: readonly GraphFlowRequest[]) => Promise<Array<{ questionId: string; value: GraphFlowResponse }>>;
  onObservation?: (observation: { request: GraphFlowRequest; response: GraphFlowResponse }) => void;
  onNativeBatch?: (nodeIds: string[]) => void;
}) {
  const pins = new Set(graph.nodes.flatMap(n => [n.definition.digest, n.binding.digest]));
  if (canonicalJson(plan) !== canonicalJson(planDecisionGraph(graph, pins))) throw new DecisionGraphError('graph/plan mismatch');
  return async (requests: GraphFlowRequest[], invokeNode: (request: GraphFlowRequest) => Promise<GraphFlowResponse>): Promise<GraphFlowResponse[]> => {
    const ids = new Set(requests.map(r => r.node.id));
    if (ids.size !== requests.length) throw new DecisionGraphError('duplicate Flow parallel node');
    const groups: GraphFlowRequest[][] = [];
    const assigned = new Set<string>();
    for (const stage of plan.stages) for (const batch of stage.batches) {
      const group = requests.filter(r => batch.includes(r.node.id)).sort((a, b) => a.node.id.localeCompare(b.node.id));
      if (group.length > 1) { groups.push(group); group.forEach(r => assigned.add(r.node.id)); }
    }
    for (const request of requests) if (!assigned.has(request.node.id)) groups.push([request]);
    const settled = new Map<string, GraphFlowResponse>();
    await Promise.all(groups.map(async group => {
      if (group.length === 1 || !options.canBatch(group) ||
          new Set(group.map(r => canonicalJson(r.inputs))).size !== 1) {
        const results = await Promise.all(group.map(r => invokeNode(r)));
        group.forEach((r, i) => settled.set(r.node.id, results[i]!));
        return;
      }
      const stages = new Set(group.map(r => r.node.phase));
      if (stages.size !== 1 || group.some(r => r.node.kind !== 'skill' || r.node.retry?.limit !== 0 ||
          r.node.sideEffectMode !== 'none' || !/^stage-(0|[1-9]\d*)$/.test(r.node.phase ?? ''))) {
        throw new DecisionGraphError('invalid native batch stage');
      }
      const stage = Number(group[0]!.node.phase!.slice(6));
      const estimates = group.map(r => options.estimate(r));
      if (estimates.some(e => !e || !Number.isSafeInteger(e.costMicros) || e.costMicros < 1 ||
          !Number.isSafeInteger(e.tokens) || e.tokens < 1)) throw new DecisionGraphError('missing native batch estimate');
      const finish = options.ledger.reserveBatch(stage, estimates);
      try {
        const ids = group.map(r => decisionBatchQuestionId(r.node.id));
        const correlated = correlateAtomicBatch(ids, await options.invokeNativeBatch(group));
        const values = ids.map(id => correlated.get(id)!);
        values.forEach((value, index) => {
          const bound = estimates[index]!;
          if (!value || !value.usage || !Number.isSafeInteger(value.attempts) || value.attempts < 1 ||
              !Number.isSafeInteger(value.usage.tokens) || value.usage.tokens < 0 ||
              !Number.isFinite(value.usage.costUsd) || value.usage.costUsd < 0 ||
              !Number.isSafeInteger(value.usage.timeMs) || value.usage.timeMs < 0 ||
              value.attempts > bound.attempts || value.usage.tokens > bound.tokens ||
              Math.ceil(value.usage.costUsd * 1_000_000) > bound.costMicros) {
            throw new DecisionGraphError('invalid native batch usage');
          }
        });
        values.forEach((value, index) => finish[index]!({ attempts: value.attempts,
          tokens: value.usage.tokens, costMicros: Math.ceil(value.usage.costUsd * 1_000_000) }));
        group.forEach((r, index) => {
          settled.set(r.node.id, values[index]!);
          options.onObservation?.({ request: r, response: values[index]! });
        });
        options.onNativeBatch?.(group.map(r => r.node.id));
      } catch (error) {
        options.ledger.cancel();
        throw error; // Never retry an uncertain native batch as individual calls.
      }
    }));
    return requests.map(r => settled.get(r.node.id)!);
  };
}
