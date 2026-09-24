import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { shortlistRerankTemplate, taxonomyBeamTemplate, extractorVerifierFallbackTemplate } from '../../../src/decision/graph-templates.js';
import { decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
import { graphBeamFlowInvoker } from '../../../src/decision/graph-beam.js';
import { GraphBudgetLedger } from '../../../src/decision/graph-budget.js';
import { admittedDecisionFlowAdapter, type GraphFlowRequest } from '../../../src/decision/graph-flow-adapter.js';
import { finalizeDecisionGraphRun } from '../../../src/decision/graph-run.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { executeFlowGraph } = require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs');

// Offline paired benchmark. A seeded scripted provider answers identically for the
// compiled DAG and for an independently authored explicit FlowGraph, so this measures
// what the DAG layer itself changes: task accuracy against fixed labels, provider
// calls, tokens, priced cost, logical (provider-reported) critical-path latency and
// the host's own orchestration time. It cannot measure real provider accuracy,
// billable price or network latency; #2686 carries that live benchmark.
type Pattern = 'shortlist-rerank' | 'taxonomy-beam' | 'extractor-verifier-fallback';
const patterns: Pattern[] = ['shortlist-rerank', 'taxonomy-beam', 'extractor-verifier-fallback'];
const TASKS = 24;
const pin = { id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` as const };
const config = { subject: 'case', target: 'jev', model: 'm', egress: 'local',
  stateDigest: `sha256:${'b'.repeat(64)}` as const, definition: pin, binding: pin };
const base = { id: 'paired-benchmark', resolvedPins: new Set([pin.digest]),
  budget: { attempts: 8, deadlineMs: 5_000, tokens: 40, costMicros: 40,
    fanOut: 3, beamWidth: 2, depth: 4, concurrency: 2 } };
const skill = 'aiwg:skill:7763181ed98b5100' as const;
const narrow = (pattern: Pattern) => pattern === 'taxonomy-beam' ? [{ beamWidth: 1 }] : [];
// Same deterministic generator style as the other decision suites.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0) / 2 ** 32;
}
const hash = (text: string) => [...text].reduce((value, char) => Math.imul(value ^ char.charCodeAt(0), 16_777_619) >>> 0, 2_166_136_261);

interface Task { seed: number; label: string | null; answer: (node: string) => Record<string, unknown> }
function task(pattern: Pattern, index: number): Task {
  const next = random(0x2608 + index * 7_919 + hash(pattern));
  if (pattern === 'shortlist-rerank') {
    const candidates = ['c1', 'c2', 'c3'].slice(0, Math.floor(next() * 4));
    const label = candidates[0] ?? null;
    const correct = next() < 0.8;
    return { seed: index, label, answer: node => node === 'shortlist'
      ? { candidates, 'has-candidates': candidates.length > 0 }
      : { result: correct ? label : 'wrong' } };
  }
  if (pattern === 'taxonomy-beam') {
    const scores = { 'branch-a': [0.2, 0.5, 0.8][Math.floor(next() * 3)]!, 'branch-b': [0.2, 0.5, 0.8][Math.floor(next() * 3)]! };
    // Equal scores resolve to the lower ID, exactly as the declared secondary key does.
    const label = scores['branch-b'] > scores['branch-a'] ? 'branch-b' : 'branch-a';
    const correct = next() < 0.9;
    return { seed: index, label, answer: node => node === 'taxonomy' ? { children: ['a', 'b'] }
      : node.startsWith('branch-') ? { score: scores[node as keyof typeof scores] }
        : { result: correct ? node.replace('detail-', '') : 'wrong' } };
  }
  const needsFallback = next() < 0.4;
  const fallbackCorrect = next() < 0.9;
  return { seed: index, label: 'review', answer: node => node === 'extractor' ? { evidence: 'text' }
    : node === 'verifier' ? { result: needsFallback ? 'unsure' : 'review', 'needs-fallback': needsFallback }
      : { result: fallbackCorrect ? 'review' : 'reject' } };
}
/** Scripted provider usage depends only on task and node, never on call order. */
function usage(seed: number, node: string) {
  const next = random(seed * 104_729 + hash(node));
  const tokens = 1 + Math.floor(next() * 5);
  return { tokens, costUsd: tokens / 1_000_000, timeMs: 1 + Math.floor(next() * 20) };
}

const types = { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] };
const input = (name: string, from: string) => ({ name, from, schema: types });
const output = (name: string, state?: string) => ({ name, schema: state ? { type: 'boolean' } : types,
  ...(state ? { state } : {}) });
const node = (id: string, stage: number, inputs: any[], outputs: any[], dependsOn: string[] = []) => ({ id, kind: 'skill', ref: skill,
  phase: `stage-${stage}`, ...(dependsOn.length ? { dependsOn } : {}), inputs, outputs, capabilities: [], permissions: [],
  sideEffectMode: 'none', retry: { limit: 0, backoff: 'none', on: ['failure'] } });
const route = (from: string, to: string, when?: string) => ({ from, to,
  ...(when ? { when: { expression: when } } : {}) });
/** Independently authored explicit FlowGraph for each pattern. */
function baseline(pattern: Pattern) {
  let nodes: any[], routes: any[], state: any[] = [];
  const flag = (name: string) => ({ name, schema: { type: 'boolean' }, reducer: 'replace' });
  if (pattern === 'shortlist-rerank') {
    state = [flag('condition-shortlist-has-candidates')];
    nodes = [node('shortlist', 0, [], [output('candidates'), output('has-candidates', 'condition-shortlist-has-candidates')]),
      node('rerank', 1, [input('candidates', 'shortlist.candidates')], [output('result')], ['shortlist'])];
    routes = [route('shortlist', 'rerank', 'state.condition-shortlist-has-candidates == true')];
  } else if (pattern === 'taxonomy-beam') {
    state = ['a', 'b'].map(id => flag(`condition-select-chosen-branch-${id}`));
    nodes = [node('taxonomy', 0, [], [output('children')]),
      ...['a', 'b'].map(id => node(`branch-${id}`, 1, [input('children', 'taxonomy.children')], [output('score')], ['taxonomy'])),
      node('select', 2, ['a', 'b'].map(id => input(`branch-${id}`, `branch-${id}.score`)),
        [output('result'), ...['a', 'b'].map(id => output(`chosen-branch-${id}`, `condition-select-chosen-branch-${id}`))],
        ['branch-a', 'branch-b']),
      ...['a', 'b'].map(id => node(`detail-branch-${id}`, 3, [input('seed', 'select.result')], [output('result')], ['select']))];
    routes = [route('taxonomy', 'branch-a'), route('taxonomy', 'branch-b'),
      route('branch-a', 'select'), route('branch-b', 'select'),
      ...['a', 'b'].map(id => route('select', `detail-branch-${id}`, `state.condition-select-chosen-branch-${id} == true`))];
  } else {
    state = [flag('condition-verifier-needs-fallback')];
    nodes = [node('extractor', 0, [], [output('evidence')]),
      node('verifier', 1, [input('evidence', 'extractor.evidence')],
        [output('result'), output('needs-fallback', 'condition-verifier-needs-fallback')], ['extractor']),
      node('fallback', 2, [input('prior', 'verifier.result')], [output('result')], ['verifier'])];
    routes = [route('extractor', 'verifier'), route('verifier', 'fallback', 'state.condition-verifier-needs-fallback == true')];
  }
  return { apiVersion: 'flow.aiwg.io/v1alpha1', kind: 'FlowGraph', metadata: { name: 'explicit-flow' }, spec: {
    entry: [nodes[0].id], candidates: [{ id: skill, kind: 'skill' }], state: { fields: state },
    permissions: [], capabilities: [], ceilings: { activations: 8, tokens: 40, costUsd: 0.000040, timeMs: 5_000, concurrency: 2 },
    nodes, routes, joins: [], failure: { onNodeFailure: 'fail', maxFailures: 0 },
    output: { mode: 'final-only', from: nodes[nodes.length - 1].id + '.result', schema: types }, trace: { level: 'metadata', redact: [] },
  } };
}
function template(pattern: Pattern) {
  if (pattern === 'shortlist-rerank') return shortlistRerankTemplate({ ...base, shortlist: config, rerank: config });
  if (pattern === 'taxonomy-beam') return taxonomyBeamTemplate({ ...base, taxonomy: config,
    branches: [{ id: 'branch-a', config }, { id: 'branch-b', config }], select: { ...config, target: 'beam' }, details: config });
  return extractorVerifierFallbackTemplate({ ...base, extractor: config, verifier: config, fallback: config });
}
/** Logical latency: each Flow activation waits for its slowest node. */
function criticalPath(report: any): number {
  const waves = new Map<number, number>();
  for (const event of report.trace) {
    if (event.type === 'node-completed') waves.set(event.activation, Math.max(waves.get(event.activation) ?? 0, event.usage.timeMs));
  }
  return [...waves.values()].reduce((sum, value) => sum + value, 0);
}
/** The explicit baseline's answer: the deepest declared terminal that ran. */
function baselineAnswer(pattern: Pattern, report: any): unknown {
  const ran = (id: string) => report.results[id]?.outputs.result;
  if (pattern === 'shortlist-rerank') return ran('rerank') ?? null;
  if (pattern === 'taxonomy-beam') return ran('detail-branch-a') ?? ran('detail-branch-b') ?? null;
  return ran('fallback') ?? ran('verifier') ?? null;
}
interface Metrics { correct: number; calls: number; tokens: number; costMicros: number; logicalMs: number; hostMs: number }
const empty = (): Metrics => ({ correct: 0, calls: 0, tokens: 0, costMicros: 0, logicalMs: 0, hostMs: 0 });
function add(metrics: Metrics, report: any, answer: unknown, label: string | null, calls: number, hostMs: number) {
  metrics.correct += answer === label ? 1 : 0;
  metrics.calls += calls;
  metrics.tokens += report.realizedResources.tokens;
  metrics.costMicros += Math.round(report.realizedResources.costUsd * 1_000_000);
  metrics.logicalMs += criticalPath(report);
  metrics.hostMs += hostMs;
}

describe('paired offline benchmark: compiled DAG / independently authored Flow baselines', () => {
  it.each(patterns)('DAG-045 %s matches its baseline on seeded tasks for quality, calls, tokens, cost and logical latency', async pattern => {
    const { graph, plan } = template(pattern);
    const compiled = decisionGraphToFlow(graph, { resolvedPins: base.resolvedPins, decisionSkillId: skill,
      terminal: graph.terminals[0]!, ceilings: narrow(pattern) });
    const explicit = baseline(pattern);
    const dag = empty(), flow = empty();
    const outcomes: Record<string, number> = {};
    for (let index = 0; index < TASKS; index++) {
      const current = task(pattern, index);
      let calls = 0;
      const provider = async (request: GraphFlowRequest) => {
        calls++;
        return { outputs: current.answer(request.node.id), attempts: 1, usage: usage(current.seed, request.node.id) };
      };
      // DAG path: full host admission, local beam selector and receipt finalization.
      const records: any[] = [];
      let started = performance.now();
      const adapter = admittedDecisionFlowAdapter(new GraphBudgetLedger(graph, plan, narrow(pattern)),
        () => ({ attempts: 1, tokens: 5, costMicros: 5 }), graphBeamFlowInvoker(graph, provider, narrow(pattern)),
        undefined, record => records.push(structuredClone(record)));
      const report = await executeFlowGraph(compiled, { validation: { catalogIds: new Set([skill]) },
        invokeNode: adapter, runId: `dag-${index}` });
      const receipt = finalizeDecisionGraphRun(graph, plan, report, records, narrow(pattern));
      const dagMs = performance.now() - started;
      outcomes[receipt.outcome] = (outcomes[receipt.outcome] ?? 0) + 1;
      const answer = receipt.value === null ? null : (receipt.value as { result: unknown }).result;
      add(dag, report, answer, current.label, calls, dagMs);
      // Baseline path: the same provider through plain Flow, with the same host-local selector.
      const before = calls;
      started = performance.now();
      const plain = await executeFlowGraph(explicit, { validation: { catalogIds: new Set([skill]) },
        invokeNode: graphBeamFlowInvoker(graph, provider, narrow(pattern)), runId: `flow-${index}` });
      const flowMs = performance.now() - started;
      add(flow, plain, baselineAnswer(pattern, plain), current.label, calls - before, flowMs);
      expect(Object.keys(report.results).sort()).toEqual(Object.keys(plain.results).sort());
    }
    for (const key of ['correct', 'calls', 'tokens', 'costMicros', 'logicalMs'] as const) expect(dag[key]).toBe(flow[key]);
    // The scripted provider is imperfect, so accuracy is a real (fake-provider) measurement.
    expect(dag.correct).toBeGreaterThan(0);
    expect(dag.correct).toBeLessThanOrEqual(TASKS);
    if (pattern === 'shortlist-rerank') expect(outcomes['empty-shortlist']).toBeGreaterThan(0);
    else expect(outcomes).toEqual({ complete: TASKS });
    // Host overhead is reported, not asserted: it depends on the machine.
    expect(Number.isFinite(dag.hostMs) && Number.isFinite(flow.hostMs)).toBe(true);
    if (process.env.AIWG_GRAPH_BENCHMARK_REPORT) {
      console.log(JSON.stringify({ pattern, tasks: TASKS, dag, flow, outcomes }));
    }
  });
});
