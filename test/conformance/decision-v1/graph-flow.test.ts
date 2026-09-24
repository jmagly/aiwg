import { describe, it, expect } from 'vitest';
import { decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
import type { DecisionGraph } from '../../../src/decision/graph.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pin = { id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` as const };
const state = `sha256:${'b'.repeat(64)}` as const;
const skill = 'aiwg:skill:7763181ed98b5100' as const;
function graph(): DecisionGraph {
  const node = (id: string, stage: number) => ({ id, stage, subject: 'case', target: 'jev', model: 'm',
    egress: 'local', stateDigest: state, definition: pin, binding: pin,
    input: stage ? ['evidence'] : [], output: stage ? ['decision'] : ['result'] });
  return { schemaVersion: 'decision-graph/v1', id: 'decision-test', entry: 'extract', terminals: ['verify'],
    nodes: [node('extract', 0), node('verify', 1)],
    edges: [{ from: 'extract', to: 'verify', source: 'result', destination: 'evidence' }],
    budget: { attempts: 3, deadlineMs: 5000, tokens: 100, costMicros: 100000,
      fanOut: 2, beamWidth: 2, depth: 2, concurrency: 2 } };
}
const options = { resolvedPins: new Set([pin.digest]), decisionSkillId: skill, terminal: 'verify' };
const { validateFlowGraph } = require('../../../agentic/code/addons/composition-engine/lib/validator.mjs');
const { executeFlowGraph } = require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs');
describe('DAG Flow skill bridge', () => {
  it('DAG-012 validates via existing FlowGraph without a new node kind', () => {
    const compiled = decisionGraphToFlow(graph(), options);
    const validation = validateFlowGraph(compiled, { catalogIds: new Set([skill]) });
    expect(validation.diagnostics).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(compiled.spec.nodes.map(n => n.kind)).toEqual(['skill', 'skill']);
    expect(compiled.spec.nodes[1]!.retry.limit).toBe(0);
  });
  it('DAG-013 runs dependent projection under Flow identities and resource accounting', async () => {
    const calls: any[] = [];
    const report = await executeFlowGraph(decisionGraphToFlow(graph(), options), {
      validation: { catalogIds: new Set([skill]) }, runId: 'run-2608',
      invokeNode: async (request: any) => {
        calls.push(request);
        return { outputs: request.node.id === 'extract' ? { result: { trusted: 'data' } } : { decision: 'abstain' },
          usage: { tokens: 2, costUsd: 0.000001, timeMs: 2 } };
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].inputs.evidence).toEqual({ trusted: 'data' });
    expect(calls[1].runId).toBe('run-2608');
    expect(calls[1].nodeRunId).toContain('verify');
    expect(calls[1].activationId).toContain('activation');
    expect(report.realizedResources.tokens).toBe(4);
  });
  it('DAG-014 fans out independent subjects, retaining Flow accounting for unused terminal', async () => {
    const g = graph();
    const other = structuredClone(g.nodes[1]!); other.id = 'other'; other.subject = 'different';
    g.nodes.push(other); g.terminals.push('other');
    g.edges.push({ from: 'extract', to: 'other', source: 'result', destination: 'evidence' });
    const manifest = decisionGraphToFlow(g, options);
    expect(validateFlowGraph(manifest, { catalogIds: new Set([skill]) }).valid).toBe(true);
    const calls: string[] = [];
    const report = await executeFlowGraph(manifest, {
      validation: { catalogIds: new Set([skill]) }, runId: 'fan-out',
      invokeNode: async ({ node, inputs }: any) => {
        calls.push(node.id);
        if (node.id !== 'extract') expect(inputs.evidence).toEqual({ ok: true });
        return { outputs: node.id === 'extract' ? { result: { ok: true } } : { decision: node.id },
          usage: { tokens: 1, costUsd: 0.000001, timeMs: 1 } };
      },
    });
    expect(calls.sort()).toEqual(['extract', 'other', 'verify']);
    expect(report.realizedResources.tokens).toBe(3);
  });
  it('DAG-015 follows trusted conditional routes only for the declared boolean evidence', async () => {
    const g = graph(); g.nodes[0]!.output.push('branch');
    g.edges[0]!.when = { source: 'branch', equals: true };
    const flow = decisionGraphToFlow(g, options);
    expect(validateFlowGraph(flow, { catalogIds: new Set([skill]) }).valid).toBe(true);
    const invoke = (branch: boolean) => executeFlowGraph(flow, {
      validation: { catalogIds: new Set([skill]) },
      invokeNode: async ({ node }: any) => ({ outputs: node.id === 'extract' ?
        { result: { authorizeAction: true }, branch } : { decision: 'review' },
        usage: { tokens: 1, costUsd: 0.000001, timeMs: 1 } }),
    });
    const [taken, discarded] = await Promise.all([invoke(true), invoke(false)]);
    expect(taken.realizedResources.nodeRuns).toBe(2);
    expect(discarded.realizedResources.nodeRuns).toBe(1);
    expect(taken.output).toBe('review');
    expect(discarded.output).toBeUndefined();
  });
  it('DAG-042 rejects untrusted pins, skill IDs, and Flow-incompatible identities before dispatch', () => {
    expect(() => decisionGraphToFlow(graph(), { ...options, resolvedPins: new Set() })).toThrow();
    expect(() => decisionGraphToFlow(graph(), { ...options, decisionSkillId: 'aiwg:skill:not-real' })).toThrow();
    const invalid = graph(); invalid.nodes[0]!.id = 'Upper'; invalid.entry = 'Upper'; invalid.edges[0]!.from = 'Upper';
    expect(() => decisionGraphToFlow(invalid, options)).toThrow(/Flow/);
  });
});
