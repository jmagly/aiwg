import { planDecisionGraph, DecisionGraphError, type DecisionGraph } from './graph.js';
import { effectiveGraphCeilings, type GraphCeilings } from './graph-evidence.js';

/** Compile an authorized decision DAG into existing Flow skill nodes. No new executor/node kind. */
export function decisionGraphToFlow(graph: DecisionGraph, options: {
  resolvedPins: ReadonlySet<string>;
  /** Stable ID must be discovered and authorized by the host, not inferred from graph evidence. */
  decisionSkillId: `aiwg:skill:${string}`;
  terminal: string;
  ceilings?: GraphCeilings[];
}) {
  const plan = planDecisionGraph(graph, options.resolvedPins);
  if (!/^aiwg:skill:[a-f0-9]{16}$/.test(options.decisionSkillId) || !graph.terminals.includes(options.terminal)) {
    throw new DecisionGraphError('unauthorized Flow skill or terminal');
  }
  // Flow's v1alpha1 IDs are lowercase DNS labels. Never silently rename identities.
  if ([graph.id, ...graph.nodes.map(n => n.id), ...graph.nodes.flatMap(n => [...n.input, ...n.output])]
    .some(id => !/^[a-z][a-z0-9-]*$/.test(id))) throw new DecisionGraphError('graph identity incompatible with Flow');
  const reserved = new Set(['subject', 'target', 'model', 'egress', 'state-digest', 'definition-pin', 'binding-pin']);
  if (graph.nodes.some(n => n.input.some(name => reserved.has(name)) || n.output.length === 0) ||
      graph.id.length > 63 || graph.id.endsWith('-')) throw new DecisionGraphError('graph incompatible with Flow bindings');
  const ceilings = effectiveGraphCeilings(graph, ...(options.ceilings ?? []));
  const names = new Map(graph.nodes.map(n => [n.id, n]));
  const nodes = plan.stages.flatMap(stage => stage.nodes.map(id => {
    const n = names.get(id)!;
    const incoming = plan.edges.filter(edge => edge.to === id);
    return {
      id, kind: 'skill' as const, ref: options.decisionSkillId,
      phase: `stage-${stage.stage}`,
      ...(incoming.length ? { dependsOn: [...new Set(incoming.map(e => e.from))].sort() } : {}),
      inputs: [
        { name: 'subject', schema: { type: 'string' }, value: n.subject },
        { name: 'target', schema: { type: 'string' }, value: n.target },
        { name: 'model', schema: { type: 'string' }, value: n.model },
        { name: 'egress', schema: { type: 'string' }, value: n.egress },
        { name: 'state-digest', schema: { type: 'string' }, value: n.stateDigest },
        { name: 'definition-pin', schema: { type: 'object' }, value: n.definition },
        { name: 'binding-pin', schema: { type: 'object' }, value: n.binding },
        ...incoming.map(e => ({ name: e.destination, schema: { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] }, from: `${e.from}.${e.source}` })),
      ],
      outputs: n.output.map(name => ({ name, schema: { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] } })),
      capabilities: [], permissions: [], sideEffectMode: 'none' as const,
      retry: { limit: 0, backoff: 'none' as const, on: ['failure' as const] },
    };
  }));
  const terminalNode = names.get(options.terminal)!;
  if (terminalNode.output.length < 1) throw new DecisionGraphError('terminal requires an output');
  // Existing Flow tracks run/node/activation/invocation identity and enforces its
  // own permission, retry, approval, trace and resource policies. These are ceilings,
  // not a grant for inference: the host adapter still controls actual transport.
  return {
    apiVersion: 'flow.aiwg.io/v1alpha1' as const, kind: 'FlowGraph' as const,
    metadata: { name: graph.id },
    spec: {
      entry: [graph.entry], candidates: [{ id: options.decisionSkillId, kind: 'skill' }],
      state: { fields: [] }, permissions: [], capabilities: [],
      ceilings: { activations: ceilings.attempts, tokens: ceilings.tokens,
        costUsd: ceilings.costMicros / 1_000_000, timeMs: ceilings.deadlineMs, concurrency: ceilings.concurrency },
      nodes, routes: [...new Set(plan.edges.map(e => `${e.from}:${e.to}`))].sort().map(pair => {
        const [from, to] = pair.split(':'); return { from: from!, to: to! };
      }),
      joins: [], failure: { onNodeFailure: 'fail', maxFailures: 0 },
      output: { mode: 'final-only', from: `${options.terminal}.${terminalNode.output[0]}`,
        schema: { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] } },
      trace: { level: 'metadata', redact: [] },
    },
  };
}
