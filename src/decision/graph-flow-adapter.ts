import { GraphBudgetLedger } from './graph-budget.js';
import { DecisionGraphError } from './graph.js';

export interface GraphFlowRequest {
  node: { id: string; kind: string; phase?: string; retry?: { limit: number }; sideEffectMode: string };
  inputs: Record<string, unknown>;
  runId: string; nodeRunId: string; activationId: string; invocationKey: string;
}
export interface GraphFlowResponse {
  outputs: Record<string, unknown>;
  usage: { tokens: number; costUsd: number; timeMs: number };
  /** Actual backend attempts including retries and fallback, supplied by trusted adapter. */
  attempts: number;
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
          !Number.isSafeInteger(response.attempts) || response.attempts < 1) {
        ledger.cancel(); throw new DecisionGraphError('invalid graph usage');
      }
      const micros = Math.ceil(response.usage.costUsd * 1_000_000);
      reservation({ attempts: response.attempts, tokens: response.usage.tokens, costMicros: micros });
      if (signal?.aborted) { ledger.cancel(); throw new DecisionGraphError('graph cancelled'); }
      onObservation?.({ request, response });
      return response;
    } catch (error) {
      ledger.cancel();
      throw error;
    }
  };
}
