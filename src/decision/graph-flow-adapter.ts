import { GraphBudgetLedger } from './graph-budget.js';
import { DecisionGraphError } from './graph.js';

export interface GraphFlowRequest {
  node: { id: string; kind: string; ref?: string; phase?: string; retry?: { limit: number }; sideEffectMode: string };
  inputs: Record<string, unknown>;
  runId: string; nodeRunId: string; activationId: string; invocationKey: string;
}
export interface GraphFlowResponse {
  outputs: Record<string, unknown>;
  usage: { tokens: number; costUsd: number; timeMs: number };
  /** Actual backend attempts including retries and fallback, supplied by trusted adapter. */
  attempts: number;
  /** A decision node that abstained or lacked a capability yields no evidence.
   * It stops the graph: dependents never run on its absent result. */
  status?: 'ok' | 'abstained' | 'unsupported';
}
export interface GraphFlowEstimate { attempts: number; tokens: number; costMicros: number }

/** Attach trusted host admission to Flow's existing invokeNode seam. The estimator
 * must bound a full decision-evaluate call including retries/fallback and unknown
 * cost; without a conservative estimate, reject before invoking any adapter.
 */
export function admittedDecisionFlowAdapter(
  ledger: GraphBudgetLedger,
  estimate: (request: GraphFlowRequest) => GraphFlowEstimate,
  invoke: (request: GraphFlowRequest) => Promise<GraphFlowResponse>,
  signal?: AbortSignal,
  onObservation?: (observation: { request: GraphFlowRequest; response: GraphFlowResponse }) => void,
): (request: GraphFlowRequest) => Promise<GraphFlowResponse> {
  return async request => {
    if (signal?.aborted) { ledger.cancel(); throw new DecisionGraphError('graph cancelled'); }
    // Flow invokes a gate only after the host approved it. The gate dispatches
    // nothing, spends no decision budget and is not a decision observation.
    if (request.node.kind === 'gate' && request.node.sideEffectMode === 'none' && request.node.ref === undefined) {
      return { outputs: {}, attempts: 1, usage: { tokens: 0, costUsd: 0, timeMs: 0 } };
    }
    if (request.node.kind !== 'skill' || request.node.sideEffectMode !== 'none' || request.node.retry?.limit !== 0 ||
        !/^stage-(0|[1-9]\d*)$/.test(request.node.phase ?? '')) throw new DecisionGraphError('unauthorized graph Flow node');
    const stage = Number(request.node.phase!.slice(6));
    const bound = estimate(request);
    if (!bound || !Number.isSafeInteger(bound.tokens) || bound.tokens < 1 ||
        !Number.isSafeInteger(bound.costMicros) || bound.costMicros < 1) throw new DecisionGraphError('missing conservative graph estimate');
    const reservation = ledger.reserve(stage, bound);
    try {
      const response = await invoke(request);
      if (!response || !response.usage || !Number.isSafeInteger(response.usage.tokens) || response.usage.tokens < 0 ||
          !Number.isFinite(response.usage.costUsd) || response.usage.costUsd < 0 ||
          !Number.isSafeInteger(response.usage.timeMs) || response.usage.timeMs < 0 ||
          !Number.isSafeInteger(response.attempts) || response.attempts < 1 ||
          ![undefined, 'ok', 'abstained', 'unsupported'].includes(response.status) ||
          (response.status !== undefined && response.status !== 'ok' && Object.keys(response.outputs ?? {}).length)) {
        ledger.cancel(); throw new DecisionGraphError('invalid graph usage');
      }
      const micros = Math.ceil(response.usage.costUsd * 1_000_000);
      reservation({ attempts: response.attempts, tokens: response.usage.tokens, costMicros: micros });
      if (signal?.aborted) { ledger.cancel(); throw new DecisionGraphError('graph cancelled'); }
      onObservation?.({ request, response });
      // Record the spent attempt, then fail the Flow node so no dependent runs.
      if (response.status === 'abstained' || response.status === 'unsupported') {
        throw new DecisionGraphError(`decision node ${response.status}`);
      }
      return response;
    } catch (error) {
      ledger.cancel();
      throw error;
    }
  };
}
