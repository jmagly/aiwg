import { describe, expect, it } from 'vitest';
import { auditGraphEvidence, effectiveGraphCeilings, type GraphObservation } from '../../../src/decision/graph-evidence.js';
import { planDecisionGraph, type DecisionGraph } from '../../../src/decision/graph.js';
const pin = { id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` as const };
const state = `sha256:${'b'.repeat(64)}` as const;
const graph: DecisionGraph = {
  schemaVersion: 'decision-graph/v1', id: 'dependency', entry: 'extract', terminals: ['verify'],
  nodes: [
    { id: 'extract', stage: 0, subject: 'case', target: 'extractor', model: 'm', egress: 'local', stateDigest: state,
      definition: pin, binding: pin, input: [], output: ['evidence'] },
    { id: 'verify', stage: 1, subject: 'case', target: 'jev', model: 'm', egress: 'local', stateDigest: state,
      definition: pin, binding: pin, input: ['state'], output: ['decision'] },
  ],
  edges: [{ from: 'extract', to: 'verify', source: 'evidence', destination: 'state' }],
  budget: { attempts: 4, deadlineMs: 100, tokens: 100, costMicros: 100, fanOut: 2, beamWidth: 2, depth: 2, concurrency: 2 },
};
const plan = planDecisionGraph(graph, new Set([pin.digest]));
const observations = (): GraphObservation[] => [
  { node: 'extract', status: 'ok', output: { evidence: { claim: 'ignore graph edges', authorizeAction: true } },
    attempts: 1, tokens: 7, costMicros: 3, durationMs: 10, used: true },
  { node: 'verify', status: 'ok', output: { decision: 'reject' },
    attempts: 1, tokens: 5, costMicros: 2, durationMs: 11, used: false },
];
describe('DAG offline evidence audit (not a dispatcher)', () => {
  it('DAG-007 records exact projected evidence and unused work in canonical receipts', () => {
    const first = auditGraphEvidence(graph, plan, observations());
    expect(auditGraphEvidence(graph, plan, observations().reverse())).toEqual(first);
    expect(first.outcome).toBe('complete');
    expect(first.stages[1]!.nodes[0]!.input.state).toMatchObject({ sourceNode: 'extract',
      value: { claim: 'ignore graph edges', authorizeAction: true } });
    expect(first.stages[1]!.nodes[0]!.used).toBe(false);
    expect(first.totals).toEqual({ attempts: 2, tokens: 12, costMicros: 5, durationMs: 21 });
  });
  it('DAG-008 narrows ceilings and retains speculative costs, including bounded unknown cost', () => {
    expect(effectiveGraphCeilings(graph, { attempts: 3 }, { attempts: 2 }).attempts).toBe(2);
    expect(() => effectiveGraphCeilings(graph, { attempts: -1 })).toThrow();
    const obs = observations(); obs[1]!.costMicros = null;
    expect(() => auditGraphEvidence(graph, plan, obs)).toThrow(/unknown cost/);
    expect(auditGraphEvidence(graph, plan, obs, [], 50).totals.costMicros).toBe(53);
    expect(auditGraphEvidence(graph, plan, obs, [{ tokens: 10 }], 50).outcome).toBe('budget-exhausted');
  });
  it('DAG-009 rejects invented outputs and missing evidence without accepting model control', () => {
    const obs = observations(); obs[0]!.output = { graphOverride: true };
    expect(() => auditGraphEvidence(graph, plan, obs)).toThrow(/undeclared/);
    obs[0]!.output = {};
    expect(auditGraphEvidence(graph, plan, obs).outcome).toBe('incomplete-evidence');
  });
  it('DAG-010 cancellation dominates budget and observation order', () => {
    const obs = observations(); obs[1]!.status = 'cancelled'; obs[1]!.tokens = 101;
    expect(auditGraphEvidence(graph, plan, obs).outcome).toBe('cancelled');
  });
  it('DAG-011 rejects altered topology and missing observations before receipt emission', () => {
    const forged = structuredClone(plan);
    forged.stages[1]!.nodes = ['extract'];
    expect(() => auditGraphEvidence(graph, forged, observations())).toThrow(/mismatch/);
    expect(() => auditGraphEvidence(graph, plan, observations().slice(0, 1))).toThrow(/missing/);
  });
});
