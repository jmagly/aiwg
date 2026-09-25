import { canonicalJson } from '../security/artifact-trust.js';
import { createHash } from 'node:crypto';
import { admitEntry } from './entry.js';
import { DecisionGraphError, type DecisionGraph, type GraphPlan } from './graph.js';
import { auditGraphEvidence, type GraphCeilings, type GraphEvidenceReceipt, type GraphObservation } from './graph-evidence.js';
import { selectDecisionBeam } from './graph-patterns.js';
import { decisionGraphApprovalGateId } from './graph-flow.js';
import type { GraphFlowRequest, GraphFlowResponse } from './graph-flow-adapter.js';

export interface GraphFlowReport {
  runId: string; status: string; stopReason: string;
  trace: Array<{ type: string; from?: string; to?: string; active?: boolean;
    nodeId?: string; nodeRunId?: string; invocationKey?: string; attempt?: number; activation?: number; sequence?: number }>;
  results: Record<string, { outputs: Record<string, unknown>; usage: { tokens: number; costUsd: number; timeMs: number } }>;
  checkpoint: { skipped: string[]; completed: string[]; failed?: string[] };
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
  batches: Array<{ stage: number; nodes: string[]; resultDigests: string[]; executedNative: boolean }>;
  attempts: Array<{ nodeId: string; nodeRunId: string; invocationKey: string; attempt: number; activation: number }>;
  /** Flow approval gates that the host approved before a gated node could run. */
  approvals: Array<{ gate: string; nodeId: string; stage: number; nodeRunId: string; activation: number }>;
  receiptDigest: string;
}

/** Cross-check Flow results against the host's append-only invocation observations.
 * If an observed Flow invocation is absent, incomplete, or tampered with, fail closed.
 * The host must persist this receipt atomically alongside its Flow checkpoint.
 */
export function finalizeDecisionGraphRun(graph: DecisionGraph, plan: GraphPlan, report: GraphFlowReport,
  records: ReadonlyArray<{ request: GraphFlowRequest; response: GraphFlowResponse }>,
  ceilings: GraphCeilings[] = [], unknownCostBoundMicros?: number,
  nativeBatches: ReadonlyArray<readonly string[]> = [], approvalStages: readonly number[] = []): GraphRunReceipt {
  try { admitEntry({ graph, plan, ceilings, runId: report.runId, status: report.status,
    results: Object.fromEntries(Object.entries(report.results).map(([id, value]) => [id, value.outputs])),
    completed: report.checkpoint.completed, skipped: report.checkpoint.skipped,
    routes: report.trace.filter(item => item.type === 'route-evaluated').map(item =>
      ({ from: item.from ?? '', to: item.to ?? '', active: item.active === true })), 
    records: records.map(({ request, response }) => ({ node: request.node.id, runId: request.runId,
      outputs: response.outputs, attempts: response.attempts, usage: response.usage })),
    nativeBatches: nativeBatches.map(group => [...group].sort()), approvalStages: [...approvalStages],
    ...(unknownCostBoundMicros === undefined ? {} : { unknownCostBoundMicros }) }); }
  catch { throw new DecisionGraphError('graph run admission denied'); }
  if (new Set(approvalStages).size !== approvalStages.length ||
      approvalStages.some(stage => stage < 1 || !plan.stages.some(s => s.stage === stage))) throw new DecisionGraphError('invalid approval stage');
  // A paused run is waiting for an approval; it has no outcome yet.
  if (report.status === 'paused') throw new DecisionGraphError('Flow graph run is not final');
  const gates = new Map(plan.stages.filter(stage => approvalStages.includes(stage.stage))
    .flatMap(stage => stage.nodes.map(id => [decisionGraphApprovalGateId(id), { nodeId: id, stage: stage.stage }] as const)));
  if (report.checkpoint.completed.some(id => !gates.has(id) && !graph.nodes.some(n => n.id === id))) {
    throw new DecisionGraphError('unknown Flow graph node');
  }
  const completed = report.checkpoint.completed.filter(id => !gates.has(id));
  if ([...gates].some(([gate, { nodeId }]) => completed.includes(nodeId) && !report.checkpoint.completed.includes(gate))) {
    throw new DecisionGraphError('gated node ran without approval');
  }
  const observed = new Map<string, GraphObservation>();
  for (const { request, response } of records) {
    const status = response.status ?? 'ok';
    if (observed.has(request.node.id) || request.runId !== report.runId || !graph.nodes.some(n => n.id === request.node.id) ||
        (status === 'ok' ? !completed.includes(request.node.id) || !report.results[request.node.id] ||
          canonicalJson(report.results[request.node.id]!.outputs) !== canonicalJson(response.outputs)
          : completed.includes(request.node.id) || !report.checkpoint.failed?.includes(request.node.id) ||
            (status !== 'abstained' && status !== 'unsupported') || Object.keys(response.outputs).length)) {
      throw new DecisionGraphError('Flow graph observation mismatch');
    }
    if (!Number.isSafeInteger(response.attempts) || response.attempts < 1 ||
        !Number.isSafeInteger(response.usage.tokens) || response.usage.tokens < 0 ||
        !Number.isSafeInteger(response.usage.timeMs) || response.usage.timeMs < 0 ||
        !Number.isFinite(response.usage.costUsd) || response.usage.costUsd < 0) throw new DecisionGraphError('invalid Flow graph usage');
    observed.set(request.node.id, { node: request.node.id, status, output: response.outputs,
      attempts: response.attempts, tokens: response.usage.tokens, costMicros: Math.ceil(response.usage.costUsd * 1_000_000),
      durationMs: response.usage.timeMs, used: status === 'ok',
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
      if (completed.includes(id) || inactive.has(id)) continue;
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
  // A node that abstained or was unsupported stopped the graph (as does a cancelled
  // run): nodes it prevented from dispatching are recorded with zero usage.
  const stopped = report.status === 'cancelled' ? 'cancelled' as const :
    [...observed.values()].some(obs => obs.status !== 'ok' && obs.status !== 'skipped') ? 'skipped' as const : null;
  if (stopped) for (const node of graph.nodes) {
    if (observed.has(node.id)) continue;
    observed.set(node.id, { node: node.id, status: stopped, output: {}, attempts: 0, tokens: 0,
      costMicros: 0, durationMs: 0, used: false });
  }
  // Flow counts only successful node runs, including approved zero-cost gates.
  const flowRecords = records.filter(item => (item.response.status ?? 'ok') === 'ok');
  const approvedGates = report.checkpoint.completed.filter(id => gates.has(id)).length;
  if (completed.length !== flowRecords.length || observed.size !== graph.nodes.length ||
      report.realizedResources.nodeRuns !== flowRecords.length + approvedGates ||
      report.realizedResources.tokens !== flowRecords.reduce((sum, item) => sum + item.response.usage.tokens, 0) ||
      Math.abs(report.realizedResources.costUsd - flowRecords.reduce((sum, item) => sum + item.response.usage.costUsd, 0)) > 1e-9) {
    throw new DecisionGraphError('missing Flow graph observation');
  }
  const candidates = graph.terminals.filter(id => observed.get(id)?.status === 'ok');
  // Prefer the deepest completed terminal, with stable ID tie ordering.
  // An invoked fallback supersedes its verifier; a guarded-off fallback does not.
  const deepest = Math.max(-1, ...candidates.map(id => graph.nodes.find(n => n.id === id)!.stage));
  const terminal = candidates.length ? selectDecisionBeam(candidates.map(id =>
    ({ id, score: graph.nodes.find(n => n.id === id)!.stage === deepest ? 1 : 0 })), 1, 1)[0]!.id : null;
  // Only the chosen terminal's transitive predecessors contributed to the
  // selected evidence. Every speculative observation still retains its usage.
  const used = new Set<string>();
  if (terminal) {
    const pending = [terminal];
    while (pending.length) {
      const id = pending.pop()!;
      if (used.has(id)) continue;
      used.add(id);
      pending.push(...plan.edges.filter(edge => edge.to === id).map(edge => edge.from));
    }
  }
  for (const obs of observed.values()) if (obs.status === 'ok') obs.used = used.has(obs.node);
  const evidence = auditGraphEvidence(graph, plan, [...observed.values()], ceilings, unknownCostBoundMicros);
  let outcome = evidence.outcome;
  if (report.status === 'cancelled') outcome = 'cancelled';
  else if (report.status !== 'completed' && outcome === 'complete' &&
      !(report.status === 'failed' && report.stopReason.startsWith('no runnable nodes remain:') &&
        completed.length + inactive.size === graph.nodes.length)) outcome = 'error';
  else if (outcome === 'complete' && !terminal) outcome = graph.pattern === 'shortlist-rerank' ? 'empty-shortlist' : 'incomplete-evidence';
  const value = outcome === 'complete' && terminal ? observed.get(terminal)!.output : null;
  const declared = nativeBatches.map(group => canonicalJson([...group].sort()));
  const permitted = new Set(plan.stages.flatMap(stage => stage.batches.map(group => canonicalJson(group))));
  if (declared.length !== new Set(declared).size || declared.some(group => !permitted.has(group))) {
    throw new DecisionGraphError('unrecognized native batch receipt');
  }
  const batches = plan.stages.flatMap(stage => stage.batches.map(nodes => ({ stage: stage.stage, nodes,
    resultDigests: nodes.map(id => evidence.stages[stage.stage]!.nodes.find(node => node.id === id)!.resultDigest),
    executedNative: declared.includes(canonicalJson(nodes)) })));
  const started = report.trace.filter(event => event.type === 'node-started');
  const approvals = started.filter(event => event.nodeId && gates.has(event.nodeId)).map(event => {
    if (!event.nodeRunId || !Number.isSafeInteger(event.activation)) throw new DecisionGraphError('invalid Flow approval lineage');
    const gate = gates.get(event.nodeId!)!;
    return { gate: event.nodeId!, nodeId: gate.nodeId, stage: gate.stage, nodeRunId: event.nodeRunId, activation: event.activation! };
  }).sort((a, b) => a.gate.localeCompare(b.gate) || a.activation - b.activation);
  const attempts = started.filter(event => !event.nodeId || !gates.has(event.nodeId)).map(event => {
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
    evidence, terminal, outcome, value, batches, attempts, approvals };
  return { ...receipt, receiptDigest: `sha256:${createHash('sha256').update(canonicalJson(receipt)).digest('hex')}` };
}
