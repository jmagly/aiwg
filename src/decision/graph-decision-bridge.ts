import { evaluateDecisionRuleset } from './evaluate.js';
import { artifactPin } from './validate.js';
import { DecisionGraphError, type DecisionGraph } from './graph.js';
import { admitEntry } from './entry.js';
import type { DecisionEvaluationRequest, RulesetResult } from './types.js';
import type { GraphFlowRequest, GraphFlowResponse } from './graph-flow-adapter.js';

type GraphNode = DecisionGraph['nodes'][number];
type NodeStatus = NonNullable<GraphFlowResponse['status']>;
/** Host-owned mapping from a ruleset result to graph outputs and node status. */
export interface DecisionResultProjection {
  project: (nodeId: string, result: RulesetResult) => Record<string, unknown>;
  /** Mandatory conservative bound per attempt if provider does not report price. */
  unknownCostBoundUsd: number;
  /** Defaults to decisionResultNodeStatus. Only an 'ok' result is projected. */
  status?: (nodeId: string, result: RulesetResult) => NodeStatus;
}

/** Default node status: an unsupported capability, or every evaluation abstaining,
 * yields no evidence. Hosts with a ruleset-specific policy supply their own. */
export function decisionResultNodeStatus(result: RulesetResult): NodeStatus {
  const statuses = Object.values(result.spec.evaluations).map(item => item.spec.status);
  if (result.spec.reason === 'unsupported-capability' || (statuses.length && statuses.every(s => s === 'unsupported'))) return 'unsupported';
  if (statuses.length && statuses.every(s => s === 'abstained')) return 'abstained';
  return 'ok';
}

/** Validate a Flow skill request and return the graph node and its declared projected input. */
export function decisionFlowNode(graph: DecisionGraph, flow: GraphFlowRequest): { node: GraphNode; input: Record<string, unknown> } {
  const node = graph.nodes.find(n => n.id === flow.node.id);
  if (!node || flow.node.kind !== 'skill' || !flow.runId || !flow.invocationKey) throw new DecisionGraphError('invalid Flow decision invocation');
  const input: Record<string, unknown> = {};
  for (const name of node.input) {
    if (!Object.hasOwn(flow.inputs, name)) throw new DecisionGraphError('missing projected Flow input');
    input[name] = flow.inputs[name];
  }
  return { node, input };
}

export function assertDecisionFlowPins(node: GraphNode, binding: { metadata: { id: string; version: string } },
  definitions: ReadonlyArray<{ metadata: { id: string; version: string } }>): void {
  if (artifactPin(binding).digest !== node.binding.digest ||
      !definitions.some(def => artifactPin(def).digest === node.definition.digest)) {
    throw new DecisionGraphError('Flow decision pin mismatch');
  }
}

/** Project a ruleset result through the host projector and account every attempt. */
export function decisionFlowResponse(graph: DecisionGraph, node: GraphNode, result: RulesetResult,
  host: DecisionResultProjection): GraphFlowResponse {
  const status = (host.status ?? ((_: string, value: RulesetResult) => decisionResultNodeStatus(value)))(node.id, result);
  if (!['ok', 'abstained', 'unsupported'].includes(status)) throw new DecisionGraphError('invalid decision node status');
  const output = status === 'ok' ? host.project(node.id, result) : {};
  try { admitEntry(output); } catch { throw new DecisionGraphError('invalid projected decision result'); }
  if (status === 'ok' && (!output || typeof output !== 'object' || Array.isArray(output) ||
      Object.keys(output).some(key => !node.output.includes(key)) ||
      node.output.some(key => !Object.hasOwn(output, key)) ||
      graph.edges.some(edge => edge.from === node.id && edge.when && typeof output[edge.when.source] !== 'boolean'))) {
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
  return { outputs: output, attempts: attempts.length || 1, usage: { tokens, costUsd, timeMs },
    ...(status === 'ok' ? {} : { status }) };
}

export function assertUnknownCostBound(host: { unknownCostBoundUsd: number }): void {
  if (!Number.isFinite(host.unknownCostBoundUsd) || host.unknownCostBoundUsd <= 0) {
    throw new DecisionGraphError('unknown cost requires conservative price bound');
  }
}

/** Embedded-host bridge: calls the same evaluateDecisionRuleset that the shipped
 * decision-evaluate skill script wraps, in process. Use decisionEvaluateSkillFlowInvoker
 * to run the skill's own entrypoint and request contract.
 * Host owns authenticated artifact resolution, adapters, receipt store and price bound.
 * The graph artifact supplies no credentials, executable adapters or permissions.
 */
export function decisionRulesetFlowInvoker(graph: DecisionGraph, host: DecisionResultProjection & {
  resolve: (nodeId: string) => DecisionEvaluationRequest;
  evaluate?: typeof evaluateDecisionRuleset;
}): (request: GraphFlowRequest) => Promise<GraphFlowResponse> {
  assertUnknownCostBound(host);
  return async flow => {
    const { node, input } = decisionFlowNode(graph, flow);
    const resolved = host.resolve(node.id);
    assertDecisionFlowPins(node, resolved.binding, Object.values(resolved.definitions));
    // The entry has no dependency: only the trusted host input is used.
    const result = await (host.evaluate ?? evaluateDecisionRuleset)({ ...resolved,
      input: node.id === graph.entry ? resolved.input : input,
      runId: flow.runId, invocationId: flow.invocationKey });
    return decisionFlowResponse(graph, node, result, host);
  };
}
