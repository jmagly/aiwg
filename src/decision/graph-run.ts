import { canonicalJson } from '../security/artifact-trust.js';
import { createHash } from 'node:crypto';
import { admitEntry } from './entry.js';
import { DecisionGraphError, type DecisionGraph, type GraphPlan } from './graph.js';
import { auditGraphEvidence, type GraphCeilings, type GraphEvidenceReceipt, type GraphObservation } from './graph-evidence.js';
import { selectDecisionBeam } from './graph-patterns.js';
import type { GraphFlowRequest, GraphFlowResponse } from './graph-flow-adapter.js';

export interface GraphFlowReport {
  runId: string; status: string; stopReason: string;
  trace: Array<{ type: string; from?: string; to?: string; active?: boolean;
    nodeId?: string; nodeRunId?: string; invocationKey?: string; attempt?: number; activation?: number; sequence?: number }>;
  results: Record<string, { outputs: Record<string, unknown>; usage: { tokens: number; costUsd: number; timeMs: number } }>;
  checkpoint: { skipped: string[]; completed: string[] };
  realizedResources: { tokens: number; costUsd: number; nodeRuns: number };
}
export interface GraphRunReceipt {
  schemaVersion: 'decision-graph-run/v1';
  graphDigest: string; flowRunId: string; flowStatus: string; flowStopReason: string;
  evidence: GraphEvidenceReceipt;
  terminal: string | null;
  outcome: GraphEvidenceReceipt['outcome'];
  /** Candidate output is evidence, never an action authorization. */
  value: unknown | null;
  batches: Array<{ stage: number; nodes: string[]; resultDigests: string[] }>;
  attempts: Array<{ nodeId: string; nodeRunId: string; invocationKey: string; attempt: number; activation: number }>;
  receiptDigest: string;
}

/** Cross-check Flow results against the host's append-only invocation observations.
 * If an observed Flow invocation is absent, incomplete, or tampered with, fail closed.
 * The host must persist this receipt atomically alongside its Flow checkpoint.
 */
export function finalizeDecisionGraphRun(graph: DecisionGraph, plan: GraphPlan, report: GraphFlowReport,
  records: ReadonlyArray<{ request: GraphFlowRequest; response: GraphFlowResponse }>,
  ceilings: GraphCeilings[] = [], unknownCostBoundMicros?: number): GraphRunReceipt {
  try { admitEntry({ graph, plan, ceilings, runId: report.runId, status: report.status,
    results: Object.fromEntries(Object.entries(report.results).map(([id, value]) => [id, value.outputs])),
    completed: report.checkpoint.completed, skipped: report.checkpoint.skipped,
    routes: report.trace.filter(item => item.type === 'route-evaluated').map(item =>
      ({ from: item.from ?? '', to: item.to ?? '', active: item.active === true })), 
    records: records.map(({ request, response }) => ({ node: request.node.id, runId: request.runId,
      outputs: response.outputs, attempts: response.attempts, usage: response.usage })),
    ...(unknownCostBoundMicros === undefined ? {} : { unknownCostBoundMicros }) }); }
  catch { throw new DecisionGraphError('graph run admission denied'); }
  const observed = new Map<string, GraphObservation>();
  for (const { request, response } of records) {
    if (observed.has(request.node.id) || request.runId !== report.runId ||
        !report.checkpoint.completed.includes(request.node.id) || !report.results[request.node.id] ||
        canonicalJson(report.results[request.node.id]!.outputs) !== canonicalJson(response.outputs)) {
      throw new DecisionGraphError('Flow graph observation mismatch');
    }
    if (!Number.isSafeInteger(response.attempts) || response.attempts < 1 ||
        !Number.isSafeInteger(response.usage.tokens) || response.usage.tokens < 0 ||
        !Number.isSafeInteger(response.usage.timeMs) || response.usage.timeMs < 0 ||
        !Number.isFinite(response.usage.costUsd) || response.usage.costUsd < 0) throw new DecisionGraphError('invalid Flow graph usage');
    observed.set(request.node.id, { node: request.node.id, status: 'ok', output: response.outputs,
      attempts: response.attempts, tokens: response.usage.tokens, costMicros: Math.ceil(response.usage.costUsd * 1_000_000),
      durationMs: response.usage.timeMs, used: true,
      flow: { runId: request.runId, nodeRunId: request.nodeRunId,
        activationId: request.activationId, invocationKey: request.invocationKey } });
  }
  // Flow v1alpha1 reports guarded-off destinations as NO_RUNNABLE_NODES rather
  // than skipped. Only interpret such nodes as unused if every incoming route
  // has an explicit inactive trace from a completed predecessor (or a skipped
  // predecessor). Never normalize an unrelated failed Flow run to success.
  const inactive = new Set(report.checkpoint.skipped);
  for (const stage of plan.stages) {
    for (const id of stage.nodes) {
      if (report.checkpoint.completed.includes(id) || inactive.has(id)) continue;
      const incoming = plan.edges.filter(e => e.to === id);
      if (incoming.length && incoming.every(e => inactive.has(e.from) ||
          report.trace.some(event => event.type === 'route-evaluated' && event.from === e.from && event.to === id && event.active === false))) {
        inactive.add(id);
      }
    }
  }
  for (const id of inactive) {
    if (observed.has(id)) throw new DecisionGraphError('Flow node both skipped and observed');
    observed.set(id, { node: id, status: 'skipped', output: {}, attempts: 0, tokens: 0,
      costMicros: 0, durationMs: 0, used: false });
  }
  if (report.checkpoint.completed.length !== records.length || observed.size !== graph.nodes.length ||
      report.realizedResources.nodeRuns !== records.length ||
      report.realizedResources.tokens !== records.reduce((sum, item) => sum + item.response.usage.tokens, 0) ||
      Math.abs(report.realizedResources.costUsd - records.reduce((sum, item) => sum + item.response.usage.costUsd, 0)) > 1e-9) {
    throw new DecisionGraphError('missing Flow graph observation');
  }
  const evidence = auditGraphEvidence(graph, plan, [...observed.values()], ceilings, unknownCostBoundMicros);
  const candidates = graph.terminals.filter(id => observed.get(id)?.status === 'ok');
  // Prefer the deepest completed terminal, with stable ID tie ordering.
  // An invoked fallback supersedes its verifier; a guarded-off fallback does not.
  const deepest = Math.max(-1, ...candidates.map(id => graph.nodes.find(n => n.id === id)!.stage));
  const terminal = candidates.length ? selectDecisionBeam(candidates.map(id =>
    ({ id, score: graph.nodes.find(n => n.id === id)!.stage === deepest ? 1 : 0 })), 1, 1)[0]!.id : null;
  let outcome = evidence.outcome;
  if (report.status === 'cancelled') outcome = 'cancelled';
  else if (report.status !== 'completed' && outcome === 'complete' &&
      !(report.status === 'failed' && report.stopReason.startsWith('no runnable nodes remain:') &&
        report.checkpoint.completed.length + inactive.size === graph.nodes.length)) outcome = 'error';
  else if (outcome === 'complete' && !terminal) outcome = graph.pattern === 'shortlist-rerank' ? 'empty-shortlist' : 'incomplete-evidence';
  const value = outcome === 'complete' && terminal ? observed.get(terminal)!.output : null;
  const batches = plan.stages.flatMap(stage => stage.batches.map(nodes => ({ stage: stage.stage, nodes,
    resultDigests: nodes.map(id => evidence.stages[stage.stage]!.nodes.find(node => node.id === id)!.resultDigest) })));
  const attempts = report.trace.filter(event => event.type === 'node-started').map(event => {
    if (!event.nodeId || !event.nodeRunId || !event.invocationKey ||
        !Number.isSafeInteger(event.attempt) || !Number.isSafeInteger(event.activation)) {
      throw new DecisionGraphError('invalid Flow attempt lineage');
    }
    return { nodeId: event.nodeId, nodeRunId: event.nodeRunId, invocationKey: event.invocationKey,
      attempt: event.attempt!, activation: event.activation! };
  }).sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.attempt - b.attempt);
  if (attempts.length < records.length) throw new DecisionGraphError('missing Flow attempt lineage');
  const receipt = { schemaVersion: 'decision-graph-run/v1' as const, graphDigest: plan.graphDigest,
    flowRunId: report.runId, flowStatus: report.status, flowStopReason: report.stopReason,
    evidence, terminal, outcome, value, batches, attempts };
  return { ...receipt, receiptDigest: `sha256:${createHash('sha256').update(canonicalJson(receipt)).digest('hex')}` };
}
