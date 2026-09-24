import { evaluateDecisionRuleset } from './evaluate.js';
import { artifactPin } from './validate.js';
import { DecisionGraphError, type DecisionGraph } from './graph.js';
import { admitEntry } from './entry.js';
import type { DecisionEvaluationRequest, RulesetResult } from './types.js';
import type { GraphFlowRequest, GraphFlowResponse } from './graph-flow-adapter.js';

/** Host owns authenticated artifact resolution, adapters, receipt store and price bound.
 * The graph artifact supplies no credentials, executable adapters or permissions.
 */
export function decisionRulesetFlowInvoker(graph: DecisionGraph, host: {
  resolve: (nodeId: string) => DecisionEvaluationRequest;
  project: (nodeId: string, result: RulesetResult) => Record<string, unknown>;
  /** Mandatory conservative bound per attempt if provider does not report price. */
  unknownCostBoundUsd: number;
  evaluate?: typeof evaluateDecisionRuleset;
}): (request: GraphFlowRequest) => Promise<GraphFlowResponse> {
  if (!Number.isFinite(host.unknownCostBoundUsd) || host.unknownCostBoundUsd <= 0) {
    throw new DecisionGraphError('unknown cost requires conservative price bound');
  }
  return async flow => {
    const node = graph.nodes.find(n => n.id === flow.node.id);
    if (!node || flow.node.kind !== 'skill' || !flow.runId || !flow.invocationKey) throw new DecisionGraphError('invalid Flow decision invocation');
    const resolved = host.resolve(node.id);
    if (artifactPin(resolved.binding).digest !== node.binding.digest ||
        !Object.values(resolved.definitions).some(def => artifactPin(def).digest === node.definition.digest)) {
      throw new DecisionGraphError('Flow decision pin mismatch');
    }
    const input: Record<string, unknown> = {};
    for (const name of node.input) {
      if (!Object.hasOwn(flow.inputs, name)) throw new DecisionGraphError('missing projected Flow input');
      input[name] = flow.inputs[name];
    }
    // The entry has no dependency: only the trusted host input is used.
    const result = await (host.evaluate ?? evaluateDecisionRuleset)({ ...resolved,
      input: node.id === graph.entry ? resolved.input : input,
      runId: flow.runId, invocationId: flow.invocationKey });
    const output = host.project(node.id, result);
    try { admitEntry(output); } catch { throw new DecisionGraphError('invalid projected decision result'); }
    if (!output || typeof output !== 'object' || Array.isArray(output) ||
        Object.keys(output).some(key => !node.output.includes(key)) ||
        node.output.some(key => !Object.hasOwn(output, key)) ||
        graph.edges.some(edge => edge.from === node.id && edge.when && typeof output[edge.when.source] !== 'boolean')) {
      throw new DecisionGraphError('invalid projected decision outputs');
    }
    const attempts = Object.values(result.spec.evaluations).flatMap(e => e.spec.attempts);
    let tokens = 0, costUsd = 0, timeMs = 0;
    for (const attempt of attempts) {
      const inputTokens = attempt.usage.inputTokens;
      const outputTokens = attempt.usage.outputTokens;
      if (inputTokens === null || outputTokens === null || !Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) {
        throw new DecisionGraphError('unknown graph token usage');
      }
      tokens += inputTokens + outputTokens;
      costUsd += attempt.usage.costUsd ?? host.unknownCostBoundUsd;
      timeMs += attempt.durationMs;
    }
    if (!Number.isSafeInteger(tokens) || !Number.isFinite(costUsd) || !Number.isSafeInteger(timeMs)) throw new DecisionGraphError('invalid graph usage');
    return { outputs: output, attempts: attempts.length || 1, usage: { tokens, costUsd, timeMs } };
  };
}
