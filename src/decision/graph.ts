import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { canonicalJson } from '../security/artifact-trust.js';
import { admitEntry } from './entry.js';

/** Offline contract only. This module never obtains credentials or dispatches work. */
export interface DecisionGraph {
  schemaVersion: 'decision-graph/v1';
  id: string;
  entry: string;
  terminals: string[];
  pattern?: 'custom' | 'shortlist-rerank' | 'taxonomy-beam' | 'extractor-verifier-fallback';
  nodes: Array<{
    id: string; stage: number; subject: string; target: string; model: string; egress: string;
    stateDigest: `sha256:${string}`;
    definition: GraphPin; binding: GraphPin; input: string[]; output: string[];
  }>;
  edges: Array<{ from: string; to: string; source: string; destination: string;
    /** Trusted control: observe a declared boolean output only; evidence cannot author edges. */
    when?: { source: string; equals: boolean } }>;
  budget: {
    attempts: number; deadlineMs: number; tokens: number; costMicros: number;
    fanOut: number; beamWidth: number; depth: number; concurrency: number;
  };
  stageBudgets?: Array<{ stage: number; limits: DecisionGraph['budget'] }>;
}
export interface GraphPin { id: string; version: string; digest: `sha256:${string}` }
export interface GraphPlan {
  schemaVersion: 'decision-graph-plan/v1'; graphDigest: `sha256:${string}`;
  stages: Array<{ stage: number; nodes: string[]; batches: string[][]; fanOut: string[] }>;
  edges: DecisionGraph['edges'];
  planDigest: `sha256:${string}`;
}
export class DecisionGraphError extends Error { constructor(message: string) { super(message); this.name = 'DecisionGraphError'; } }
const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = [resolve(here, '../../schemas/decision'), resolve(here, '../../../schemas/decision')]
  .find(path => existsSync(resolve(path, 'DecisionGraph.v1.schema.json')));
if (!schemaDir) throw new Error('Decision graph schema directory is unavailable');
const schema = JSON.parse(readFileSync(resolve(schemaDir, 'DecisionGraph.v1.schema.json'), 'utf8')) as object;
const check = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
const digest = (value: unknown): `sha256:${string}` => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const fail = (message: string): never => { throw new DecisionGraphError(message); };

/** resolvedPins must be supplied by the trusted caller; neither evidence nor model state can supply it. */
export function planDecisionGraph(value: unknown, resolvedPins: ReadonlySet<string>): GraphPlan {
  try { admitEntry(value); } catch { return fail('graph admission denied'); }
  if (!check(value)) return fail('invalid decision graph schema');
  const graph = value as DecisionGraph;
  const nodes = new Map<string, DecisionGraph['nodes'][number]>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) return fail('duplicate graph node');
    nodes.set(node.id, node);
    if (!resolvedPins.has(node.definition.digest) || !resolvedPins.has(node.binding.digest)) return fail('unresolved graph pin');
  }
  const entry = nodes.get(graph.entry);
  if (!entry || entry.stage !== 0 || entry.input.length !== 0) return fail('invalid graph entry');
  if (new Set(graph.terminals).size !== graph.terminals.length || graph.terminals.some(id => !nodes.has(id))) return fail('invalid graph terminal');
  const inputs = new Map<string, Set<string>>();
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) { inputs.set(node.id, new Set()); outgoing.set(node.id, []); }
  const edgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from); const to = nodes.get(edge.to);
    if (!from || !to || from.id === to.id || from.stage >= to.stage) return fail('invalid graph dependency or cycle');
    if (!from.output.includes(edge.source) || !to.input.includes(edge.destination) ||
        (edge.when && !from.output.includes(edge.when.source))) return fail('illegal evidence projection');
    const key = canonicalJson(edge);
    if (edgeKeys.has(key) || inputs.get(to.id)!.has(edge.destination)) return fail('ambiguous evidence projection');
    edgeKeys.add(key);
    inputs.get(to.id)!.add(edge.destination);
    outgoing.get(from.id)!.push(to.id);
  }
  const reached = new Set([graph.entry]);
  const queue = [graph.entry];
  for (let i = 0; i < queue.length; i++) {
    for (const id of outgoing.get(queue[i]!)!) if (!reached.has(id)) { reached.add(id); queue.push(id); }
  }
  for (const node of graph.nodes) {
    if (!reached.has(node.id) || (node.id !== graph.entry && (!node.input.length || node.input.some(name => !inputs.get(node.id)!.has(name)))) ||
        (outgoing.get(node.id)!.length === 0 ? !graph.terminals.includes(node.id) :
          graph.terminals.includes(node.id) && graph.edges.some(edge => edge.from === node.id && !edge.when))) {
      return fail('ambiguous root, input, or terminal');
    }
  }
  const sortedNodes = [...graph.nodes].sort((a, b) => a.stage - b.stage || a.id.localeCompare(b.id));
  const edges = [...graph.edges].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const stages = [...new Set(sortedNodes.map(node => node.stage))].map(stage => {
    const stageNodes = sortedNodes.filter(node => node.stage === stage);
    const groups = new Map<string, string[]>();
    for (const node of stageNodes) {
      const projections = edges.filter(edge => edge.to === node.id)
        .map(edge => [edge.from, edge.source, edge.destination]);
      const key = canonicalJson([node.subject, node.target, node.model, node.egress, node.stateDigest,
        node.definition.digest, node.binding.digest, projections]);
      const group = groups.get(key) ?? []; group.push(node.id); groups.set(key, group);
    }
    const batches = [...groups.values()].filter(group => group.length > 1);
    return { stage, nodes: stageNodes.map(node => node.id), batches,
      fanOut: [...groups.values()].filter(group => group.length === 1).flat() };
  });
  if (stages.some((s, i) => s.stage !== i) || stages.length > graph.budget.depth || stages.some(s => s.nodes.length > graph.budget.fanOut) ||
      stages.some(s => s.batches.some(group => group.length > graph.budget.beamWidth))) return fail('graph budget exceeded');
  if (graph.stageBudgets && (new Set(graph.stageBudgets.map(item => item.stage)).size !== graph.stageBudgets.length ||
      graph.stageBudgets.some(item => {
        const stage = stages.find(s => s.stage === item.stage);
        return !stage || stage.nodes.length > item.limits.fanOut ||
          stage.batches.some(group => group.length > item.limits.beamWidth) || stage.stage >= item.limits.depth;
      }))) return fail('invalid stage budget');
  const canonicalGraph = { ...graph, ...(graph.stageBudgets ? { stageBudgets: [...graph.stageBudgets].sort((a, b) => a.stage - b.stage) } : {}),
    terminals: [...graph.terminals].sort(), nodes: sortedNodes.map(node => ({ ...node, input: [...node.input].sort(), output: [...node.output].sort() })), edges };
  const plan = { schemaVersion: 'decision-graph-plan/v1' as const, graphDigest: digest(canonicalGraph), stages, edges };
  return { ...plan, planDigest: digest(plan) };
}
