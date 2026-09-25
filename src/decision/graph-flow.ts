import { planDecisionGraph, DecisionGraphError, type DecisionGraph } from './graph.js';
import { effectiveGraphCeilings, type GraphCeilings } from './graph-evidence.js';

/** Flow gate ID guarding one node of an approval stage. The gate is an existing
 * Flow `gate` node: Flow refuses to invoke it until the host approves it. */
export function decisionGraphApprovalGateId(nodeId: string): string { return `approve-${nodeId}`; }

/** Compile an authorized decision DAG into existing Flow skill nodes. No new executor/node kind. */
export function decisionGraphToFlow(graph: DecisionGraph, options: {
  resolvedPins: ReadonlySet<string>;
  /** Stable ID must be discovered and authorized by the host, not inferred from graph evidence. */
  decisionSkillId: `aiwg:skill:${string}`;
  terminal: string;
  ceilings?: GraphCeilings[];
  /** Stages whose nodes wait for a host-approved Flow gate before any dispatch. */
  approvalStages?: readonly number[];
}) {
  const plan = planDecisionGraph(graph, options.resolvedPins);
  const approvalStages = new Set(options.approvalStages ?? []);
  if (approvalStages.size !== (options.approvalStages ?? []).length || [...approvalStages].some(stage =>
    !Number.isSafeInteger(stage) || stage < 1 || !plan.stages.some(s => s.stage === stage))) {
    throw new DecisionGraphError('invalid approval stage');
  }
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
  const guards = new Map<string, string>();
  for (const edge of plan.edges) {
    if (!edge.when) continue;
    const name = `condition-${edge.from}-${edge.when.source}`;
    guards.set(`${edge.from}.${edge.when.source}`, name);
  }
  const gated = new Set(plan.stages.filter(stage => approvalStages.has(stage.stage)).flatMap(stage => stage.nodes));
  for (const id of gated) {
    const gate = decisionGraphApprovalGateId(id);
    if (names.has(gate) || gate.length > 63) throw new DecisionGraphError('approval gate identity incompatible with Flow');
  }
  const nodes = plan.stages.flatMap(stage => stage.nodes.flatMap(id => {
    const n = names.get(id)!;
    const incoming = plan.edges.filter(edge => edge.to === id);
    const predecessors = [...new Set(incoming.map(e => e.from))].sort();
    // A gate mirrors its node's readiness (same predecessors and guarded routes),
    // so approval is requested only for a node that would otherwise run.
    const gate = gated.has(id) ? [{ id: decisionGraphApprovalGateId(id), kind: 'gate' as const,
      phase: `stage-${stage.stage}`, dependsOn: predecessors, inputs: [], outputs: [],
      capabilities: [], permissions: [], sideEffectMode: 'none' as const }] : [];
    const dependsOn = [...predecessors, ...gate.map(g => g.id)].sort();
    return [...gate, {
      id, kind: 'skill' as const, ref: options.decisionSkillId,
      phase: `stage-${stage.stage}`,
      ...(dependsOn.length ? { dependsOn } : {}),
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
      outputs: n.output.map(name => {
        const guard = guards.get(`${id}.${name}`);
        return { name, schema: guard ? { type: 'boolean' } : { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] },
          ...(guard ? { state: guard } : {}) };
      }),
      capabilities: [], permissions: [], sideEffectMode: 'none' as const,
      retry: { limit: 0, backoff: 'none' as const, on: ['failure' as const] },
    }];
  }));
  const terminalNode = names.get(options.terminal)!;
  if (terminalNode.output.length < 1) throw new DecisionGraphError('terminal requires an output');
  // Existing Flow tracks run/node/activation/invocation identity and enforces its
  // own permission, retry, approval, trace and resource policies. These are ceilings,
  // not a grant for inference: the host adapter still controls actual transport.
  // Each approval wave costs one Flow activation but no decision attempt.
  return {
    apiVersion: 'flow.aiwg.io/v1alpha1' as const, kind: 'FlowGraph' as const,
    metadata: { name: graph.id },
    spec: {
      entry: [graph.entry], candidates: [{ id: options.decisionSkillId, kind: 'skill' }],
      state: { fields: [...guards.values()].sort().map(name => ({ name, schema: { type: 'boolean' }, reducer: 'replace' })) },
      permissions: [], capabilities: [],
      ceilings: { activations: ceilings.attempts + approvalStages.size, tokens: ceilings.tokens,
        costUsd: ceilings.costMicros / 1_000_000, timeMs: ceilings.deadlineMs, concurrency: ceilings.concurrency },
      nodes, routes: [...new Set(plan.edges.map(e => `${e.from}:${e.to}`))].sort().flatMap(pair => {
        const [from, to] = pair.split(':');
        const matches = plan.edges.filter(e => e.from === from && e.to === to);
        const predicates = [...new Set(matches.map(e => e.when ? `${guards.get(`${e.from}.${e.when.source}`)} == ${e.when.equals}` : 'always'))];
        if (predicates.length !== 1) throw new DecisionGraphError('conflicting guards on Flow route');
        const when = predicates[0] === 'always' ? {} : { when: { expression: `state.${predicates[0]}` } };
        return [{ from: from!, to: to!, ...when },
          ...(gated.has(to!) ? [{ from: from!, to: decisionGraphApprovalGateId(to!), ...when }] : [])];
      }),
      joins: [], failure: { onNodeFailure: 'fail', maxFailures: 0 },
      output: { mode: 'final-only', from: `${options.terminal}.${terminalNode.output[0]}`,
        schema: { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] } },
      trace: { level: 'metadata', redact: [] },
    },
  };
}
