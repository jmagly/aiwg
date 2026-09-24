import { describe, expect, it } from 'vitest';
import { shortlistRerankTemplate, taxonomyBeamTemplate, extractorVerifierFallbackTemplate } from '../../../src/decision/graph-templates.js';
import { decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
import { finalizeDecisionGraphRun } from '../../../src/decision/graph-run.js';
import { GraphBudgetLedger } from '../../../src/decision/graph-budget.js';
import { admittedDecisionFlowAdapter } from '../../../src/decision/graph-flow-adapter.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateFlowGraph, executeFlowGraph } = {
  ...require('../../../agentic/code/addons/composition-engine/lib/validator.mjs'),
  ...require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs'),
};
const pin = { id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` as const };
const config = { subject: 'case', target: 'jev', model: 'm', egress: 'local',
  stateDigest: `sha256:${'b'.repeat(64)}` as const, definition: pin, binding: pin };
const base = { id: 'pattern-template', budget: { attempts: 5, deadlineMs: 100,
  tokens: 20, costMicros: 20, fanOut: 3, beamWidth: 3, depth: 3, concurrency: 2 }, resolvedPins: new Set([pin.digest]) };
const skill = 'aiwg:skill:7763181ed98b5100' as const;
describe('first-class dependent graph templates', () => {
  it('DAG-032 builds three stable, pinned graph patterns and rejects new model-authored branches', () => {
    const shortlist = shortlistRerankTemplate({ ...base, shortlist: config, rerank: config });
    expect(shortlist.plan.stages.map(s => s.nodes)).toEqual([['shortlist'], ['rerank']]);
    const taxonomy = taxonomyBeamTemplate({ ...base, taxonomy: config, select: config,
      branches: [{ id: 'branch-b', config }, { id: 'branch-a', config }] });
    const swapped = taxonomyBeamTemplate({ ...base, taxonomy: config, select: config,
      branches: [{ id: 'branch-a', config }, { id: 'branch-b', config }] });
    expect(taxonomy.plan.planDigest).toBe(swapped.plan.planDigest);
    expect(taxonomy.plan.stages[1]!.nodes).toEqual(['branch-a', 'branch-b']);
    expect(() => taxonomyBeamTemplate({ ...base, taxonomy: config, select: config,
      branches: [{ id: 'branch-a', config }, { id: 'branch-a', config }] })).toThrow();
    const fallback = extractorVerifierFallbackTemplate({ ...base, extractor: config, verifier: config, fallback: config });
    expect(fallback.graph.edges[1]!.when).toEqual({ source: 'needs-fallback', equals: true });
  });
  it.each([false, true])('DAG-033 fallback=%s selects only the declared terminal', async needed => {
    const { graph, plan } = extractorVerifierFallbackTemplate({ ...base, extractor: config, verifier: config, fallback: config });
    const manifest = decisionGraphToFlow(graph, { resolvedPins: base.resolvedPins, decisionSkillId: skill, terminal: 'verifier' });
    expect(validateFlowGraph(manifest, { catalogIds: new Set([skill]) }).valid).toBe(true);
    const records: any[] = [];
    const adapter = admittedDecisionFlowAdapter(new GraphBudgetLedger(graph, plan),
      () => ({ attempts: 1, tokens: 2, costMicros: 2 }),
      async ({ node }: any) => ({ outputs: node.id === 'extractor' ? { evidence: 'evidence' } :
        node.id === 'verifier' ? { result: 'verified', 'needs-fallback': needed } : { result: 'fallback' },
      attempts: 1, usage: { tokens: 1, costUsd: 0.000001, timeMs: 1 } }), undefined,
      record => records.push(structuredClone(record)));
    const report = await executeFlowGraph(manifest, { validation: { catalogIds: new Set([skill]) },
      invokeNode: adapter, runId: 'pattern-run' });
    const receipt = finalizeDecisionGraphRun(graph, plan, report, records);
    expect(receipt.outcome).toBe('complete');
    expect(receipt.terminal).toBe(needed ? 'fallback' : 'verifier');
    expect(receipt.value).toEqual({ result: needed ? 'fallback' : 'verified',
      ...(needed ? {} : { 'needs-fallback': false }) });
    expect(receipt.evidence.totals.attempts).toBe(needed ? 3 : 2);
  });
});
