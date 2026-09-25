import { createHash } from 'node:crypto';
import { canonicalJson } from '../security/artifact-trust.js';
import { admitEntry } from './entry.js';
import { DecisionGraphError, planDecisionGraph, type DecisionGraph, type GraphPlan } from './graph.js';

/** Offline evidence audit. This function never dispatches a graph or authorizes an action. */
export interface GraphObservation {
  node: string;
  status: 'ok' | 'abstained' | 'error' | 'unsupported' | 'cancelled' | 'skipped';
  output: Record<string, unknown>;
  attempts: number;
  tokens: number;
  /** Null requires a trusted cost bound before the observation can be audited. */
  costMicros: number | null;
  durationMs: number;
  used: boolean;
  flow?: { runId: string; nodeRunId: string; activationId: string; invocationKey: string };
}
export type GraphCeilings = Partial<DecisionGraph['budget']>;
export interface GraphEvidenceReceipt {
  schemaVersion: 'decision-graph-evidence/v1';
  graphDigest: string;
  planDigest: string;
  limits: DecisionGraph['budget'];
  stages: Array<{ stage: number; nodes: Array<{
    id: string; status: GraphObservation['status']; used: boolean;
    input: Record<string, { sourceNode: string; sourceResultDigest: string; value: unknown }>;
    resultDigest: string; attempts: number; tokens: number; costMicros: number; durationMs: number;
    flow?: GraphObservation['flow'];
  }> }>;
  totals: { attempts: number; tokens: number; costMicros: number; durationMs: number };
  outcome: 'complete' | 'abstained' | 'error' | 'unsupported' | 'cancelled' | 'incomplete-evidence' | 'budget-exhausted' | 'empty-shortlist';
  receiptDigest: string;
}
const digest = (value: unknown): string => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const fields = ['attempts', 'deadlineMs', 'tokens', 'costMicros', 'fanOut', 'beamWidth', 'depth', 'concurrency'] as const;

/** Caller, workspace and provider ceilings may only narrow the graph's authored ceiling. */
export function effectiveGraphCeilings(graph: DecisionGraph, ...ceilings: GraphCeilings[]): DecisionGraph['budget'] {
  const result = { ...graph.budget };
  for (const layer of ceilings) {
    for (const field of fields) {
      const limit = layer[field];
      if (limit === undefined) continue;
      if (!Number.isSafeInteger(limit) || limit < 1) throw new DecisionGraphError('invalid graph ceiling');
      result[field] = Math.min(result[field], limit);
    }
  }
  return result;
}

/** Audit complete immutable observations against an already validated trusted plan.
 * No partial receipt is returned on malformed observations. Unknown cost fails closed.
 */
export function auditGraphEvidence(graph: DecisionGraph, plan: GraphPlan, observations: GraphObservation[],
  ceilings: GraphCeilings[] = [], unknownCostBoundMicros?: number): GraphEvidenceReceipt {
  try { admitEntry({ graph, plan, observations, ceilings, ...(unknownCostBoundMicros === undefined ? {} : { unknownCostBoundMicros }) }); }
  catch { throw new DecisionGraphError('graph evidence admission denied'); }
  // Revalidate topology and reject forged plan groups/edges. This does not resolve pins;
  // trusted pin resolution belongs to the caller that created the original plan.
  const pins = new Set(graph.nodes.flatMap(node => [node.definition.digest, node.binding.digest]));
  const expected = planDecisionGraph(graph, pins);
  if (canonicalJson(plan) !== canonicalJson(expected)) throw new DecisionGraphError('graph/plan mismatch');
  const limits = effectiveGraphCeilings(graph, ...ceilings);
  const byId = new Map<string, GraphObservation>();
  for (const obs of observations) {
    if (byId.has(obs.node) || !graph.nodes.some(n => n.id === obs.node)) throw new DecisionGraphError('duplicate or unknown observation');
    for (const field of ['attempts', 'tokens', 'durationMs'] as const) {
      if (!Number.isSafeInteger(obs[field]) || obs[field] < 0) throw new DecisionGraphError('invalid usage');
    }
    if (obs.costMicros !== null && (!Number.isSafeInteger(obs.costMicros) || obs.costMicros < 0)) throw new DecisionGraphError('invalid cost');
    if (obs.costMicros === null && (!Number.isSafeInteger(unknownCostBoundMicros) || unknownCostBoundMicros! < 1)) throw new DecisionGraphError('unknown cost without bound');
    if (typeof obs.used !== 'boolean' || !['ok', 'abstained', 'error', 'unsupported', 'cancelled', 'skipped'].includes(obs.status)) throw new DecisionGraphError('invalid observation');
    const names = graph.nodes.find(n => n.id === obs.node)!.output;
    if (!obs.output || Array.isArray(obs.output) || typeof obs.output !== 'object' ||
        Object.keys(obs.output).some(name => !names.includes(name))) throw new DecisionGraphError('undeclared observation output');
    if (obs.status === 'skipped' && (obs.used || obs.attempts !== 0 || obs.tokens !== 0 || obs.costMicros !== 0 || obs.durationMs !== 0 || Object.keys(obs.output).length)) {
      throw new DecisionGraphError('skipped node has resource usage');
    }
    byId.set(obs.node, obs);
  }
  const totals = { attempts: 0, tokens: 0, costMicros: 0, durationMs: 0 };
  let outcome: GraphEvidenceReceipt['outcome'] = 'complete';
  const stages = plan.stages.map(stage => ({ stage: stage.stage, nodes: stage.nodes.map(id => {
    const obs = byId.get(id);
    if (!obs) throw new DecisionGraphError('missing graph observation');
    const input: GraphEvidenceReceipt['stages'][number]['nodes'][number]['input'] = {};
    for (const edge of plan.edges.filter(e => e.to === id)) {
      const source = byId.get(edge.from);
      if (!source || source.status !== 'ok' || (!source.used && obs.used) || !Object.hasOwn(source.output, edge.source)) {
        // Keep the earliest explicit cause (for example an abstained predecessor).
        if (outcome === 'complete') outcome = 'incomplete-evidence';
        continue;
      }
      input[edge.destination] = { sourceNode: edge.from, sourceResultDigest: digest(source.output), value: source.output[edge.source] };
    }
    const node = graph.nodes.find(n => n.id === id)!;
    if (outcome === 'complete' && obs.status !== 'skipped' && node.input.some(key => !Object.hasOwn(input, key))) outcome = 'incomplete-evidence';
    const costMicros = obs.costMicros ?? unknownCostBoundMicros!;
    totals.attempts += obs.attempts; totals.tokens += obs.tokens; totals.costMicros += costMicros;
    totals.durationMs += obs.durationMs;
    if (![totals.attempts, totals.tokens, totals.costMicros, totals.durationMs].every(Number.isSafeInteger)) throw new DecisionGraphError('usage overflow');
    if (obs.status === 'cancelled') outcome = 'cancelled';
    else if (outcome === 'complete' && obs.status !== 'ok' && obs.status !== 'skipped') outcome = obs.status;
    return { id, status: obs.status, used: obs.used, input, resultDigest: digest(obs.output),
      attempts: obs.attempts, tokens: obs.tokens, costMicros, durationMs: obs.durationMs,
      ...(obs.flow ? { flow: obs.flow } : {}) };
  }) }));
  if (stages.some(stage => {
    const stageLimit = graph.stageBudgets?.find(b => b.stage === stage.stage)?.limits;
    if (!stageLimit) return false;
    const spent = { attempts: 0, tokens: 0, costMicros: 0, durationMs: 0 };
    for (const node of stage.nodes) {
      spent.attempts += node.attempts; spent.tokens += node.tokens;
      spent.costMicros += node.costMicros; spent.durationMs += node.durationMs;
    }
    return spent.attempts > stageLimit.attempts || spent.tokens > stageLimit.tokens ||
      spent.costMicros > stageLimit.costMicros || spent.durationMs > stageLimit.deadlineMs ||
      stage.nodes.length > stageLimit.fanOut;
  })) outcome = 'budget-exhausted';
  if (totals.attempts > limits.attempts || totals.tokens > limits.tokens || totals.costMicros > limits.costMicros ||
    totals.durationMs > limits.deadlineMs || stages.length > limits.depth ||
    stages.some(stage => stage.nodes.length > limits.fanOut)) outcome = 'budget-exhausted';
  if (observations.some(obs => obs.status === 'cancelled')) outcome = 'cancelled';
  const receipt = { schemaVersion: 'decision-graph-evidence/v1' as const, graphDigest: plan.graphDigest,
    planDigest: plan.planDigest, limits, stages, totals, outcome };
  return { ...receipt, receiptDigest: digest(receipt) };
}
