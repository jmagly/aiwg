import { describe, expect, it } from 'vitest';
import { shortlistRerankTemplate, taxonomyBeamTemplate, extractorVerifierFallbackTemplate } from '../../../src/decision/graph-templates.js';
import { decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
import { graphBeamFlowInvoker } from '../../../src/decision/graph-beam.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { executeFlowGraph } = require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs');
const pin = { id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` as const };
const config = { subject: 'case', target: 'jev', model: 'm', egress: 'local',
  stateDigest: `sha256:${'b'.repeat(64)}` as const, definition: pin, binding: pin };
const base = { id: 'paired-benchmark', resolvedPins: new Set([pin.digest]),
  budget: { attempts: 8, deadlineMs: 100, tokens: 20, costMicros: 20,
    fanOut: 3, beamWidth: 2, depth: 4, concurrency: 2 } };
const skill = 'aiwg:skill:7763181ed98b5100' as const;
const types = { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] };
const input = (name: string, from: string) => ({ name, from, schema: types });
const output = (name: string, state?: string) => ({ name, schema: state ? { type: 'boolean' } : types,
  ...(state ? { state } : {}) });
const node = (id: string, stage: number, inputs: any[], outputs: any[]) => ({ id, kind: 'skill', ref: skill,
  phase: `stage-${stage}`, inputs, outputs, capabilities: [], permissions: [], sideEffectMode: 'none',
  retry: { limit: 0, backoff: 'none', on: ['failure'] } });
const route = (from: string, to: string, when?: string) => ({ from, to,
  ...(when ? { when: { expression: when } } : {}) });
function baseline(pattern: 'shortlist-rerank' | 'taxonomy-beam' | 'extractor-verifier-fallback') {
  let nodes: any[], routes: any[], state: any[] = [], terminal: string;
  if (pattern === 'shortlist-rerank') {
    nodes = [node('shortlist', 0, [], [output('candidates')]),
      node('rerank', 1, [input('candidates', 'shortlist.candidates')], [output('result')])];
    routes = [route('shortlist', 'rerank')]; terminal = 'rerank.result';
  } else if (pattern === 'taxonomy-beam') {
    state = ['a', 'b'].map(id => ({ name: `condition-select-chosen-branch-${id}`,
      schema: { type: 'boolean' }, reducer: 'replace' }));
    nodes = [node('taxonomy', 0, [], [output('children')]),
      ...['a', 'b'].map(id => node(`branch-${id}`, 1, [input('children', 'taxonomy.children')], [output('score')])),
      node('select', 2, ['a', 'b'].map(id => input(`branch-${id}`, `branch-${id}.score`)),
        [output('result'), ...['a', 'b'].map(id => output(`chosen-branch-${id}`, `condition-select-chosen-branch-${id}`))]),
      ...['a', 'b'].map(id => node(`detail-branch-${id}`, 3, [input('seed', 'select.result')], [output('result')]))];
    routes = [route('taxonomy', 'branch-a'), route('taxonomy', 'branch-b'),
      route('branch-a', 'select'), route('branch-b', 'select'),
      ...['a', 'b'].map(id => route('select', `detail-branch-${id}`,
        `state.condition-select-chosen-branch-${id} == true`))]; terminal = 'detail-branch-a.result';
  } else {
    state = [{ name: 'condition-verifier-needs-fallback', schema: { type: 'boolean' }, reducer: 'replace' }];
    nodes = [node('extractor', 0, [], [output('evidence')]),
      node('verifier', 1, [input('evidence', 'extractor.evidence')],
        [output('result'), output('needs-fallback', 'condition-verifier-needs-fallback')]),
      node('fallback', 2, [input('prior', 'verifier.result')], [output('result')])];
    routes = [route('extractor', 'verifier'), route('verifier', 'fallback',
      'state.condition-verifier-needs-fallback == true')]; terminal = 'verifier.result';
  }
  return { apiVersion: 'flow.aiwg.io/v1alpha1', kind: 'FlowGraph', metadata: { name: 'explicit-flow' }, spec: {
    entry: [nodes[0].id], candidates: [{ id: skill, kind: 'skill' }], state: { fields: state },
    permissions: [], capabilities: [], ceilings: { activations: 8, tokens: 20, costUsd: 0.000020, timeMs: 100, concurrency: 2 },
    nodes, routes, joins: [], failure: { onNodeFailure: 'fail', maxFailures: 0 },
    output: { mode: 'final-only', from: terminal, schema: types }, trace: { level: 'metadata', redact: [] },
  } };
}
function template(pattern: 'shortlist-rerank' | 'taxonomy-beam' | 'extractor-verifier-fallback') {
  if (pattern === 'shortlist-rerank') return shortlistRerankTemplate({ ...base, shortlist: config, rerank: config });
  if (pattern === 'taxonomy-beam') return taxonomyBeamTemplate({ ...base, taxonomy: config,
    branches: [{ id: 'branch-a', config }, { id: 'branch-b', config }], select: { ...config, target: 'beam' }, details: config });
  return extractorVerifierFallbackTemplate({ ...base, extractor: config, verifier: config, fallback: config });
}
function fakeTask(pattern: string, id: string) {
  if (pattern === 'shortlist-rerank') return id === 'shortlist' ? { candidates: ['a', 'b'] } : { result: 'a' };
  if (pattern === 'taxonomy-beam') {
    if (id === 'taxonomy') return { children: ['a', 'b'] };
    if (id.startsWith('branch-')) return { score: 0.5 };
    return { result: 'branch-a' };
  }
  return id === 'extractor' ? { evidence: 'text' } : id === 'verifier' ?
    { result: 'review', 'needs-fallback': true } : { result: 'review' };
}
describe('paired fake-transport DAG / independently authored Flow baselines', () => {
  it.each(['shortlist-rerank', 'taxonomy-beam', 'extractor-verifier-fallback'] as const)(
    'DAG-039 %s has equal quality, calls, tokens, priced cost and logical latency', async pattern => {
      const { graph } = template(pattern);
      const compiled = decisionGraphToFlow(graph, { resolvedPins: base.resolvedPins, decisionSkillId: skill,
        terminal: pattern === 'shortlist-rerank' ? 'rerank' : pattern === 'taxonomy-beam' ? 'detail-branch-a' : 'verifier',
        ceilings: pattern === 'taxonomy-beam' ? [{ beamWidth: 1 }] : [] });
      const explicit = baseline(pattern);
      const adapter = graphBeamFlowInvoker(graph, async request => ({ outputs: fakeTask(pattern, request.node.id),
        attempts: 1, usage: { tokens: 2, costUsd: 0.000001, timeMs: 3 } }),
      pattern === 'taxonomy-beam' ? [{ beamWidth: 1 }] : []);
      const run = (manifest: any) => executeFlowGraph(manifest, {
        validation: { catalogIds: new Set([skill]) }, invokeNode: adapter,
      });
      const [dag, flow] = await Promise.all([run(compiled), run(explicit)]);
      expect(Object.keys(dag.results).sort()).toEqual(Object.keys(flow.results).sort());
      for (const id of Object.keys(dag.results)) {
        expect(dag.results[id].outputs).toEqual(flow.results[id].outputs);
        expect(dag.results[id].usage).toEqual(flow.results[id].usage);
      }
      expect(dag.runId).not.toBe(flow.runId);
      for (const key of ['nodeRuns', 'tokens', 'costUsd', 'timeMs']) {
        expect(dag.realizedResources[key]).toBe(flow.realizedResources[key]);
      }
      // With a fixed fake answer the two shapes have identical task accuracy;
      // this says nothing about real provider quality or wall-clock latency.
      const target = pattern === 'shortlist-rerank' ? 'rerank' :
        pattern === 'taxonomy-beam' ? 'detail-branch-a' : 'fallback';
      expect(dag.results[target].outputs.result).toBe(pattern === 'shortlist-rerank' ? 'a' :
        pattern === 'taxonomy-beam' ? 'branch-a' : 'review');
    },
  );
});
