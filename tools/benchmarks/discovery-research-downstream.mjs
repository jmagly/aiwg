// Execute synthetic evidence-to-configuration tasks with equal search/read ceilings.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { discoverCapability } from '../../src/artifacts/query-engine-discover.ts';
import { discoveryIdForEntry } from '../../src/artifacts/query-engine-entries.ts';
import { buildDiscoveryGraph, controlDiscoveryGraph, rankDiscoveryGraph } from '../../src/artifacts/discovery-graph.ts';
import { serializeDiscoveryGraph, GRAPH_EVAL_SEEDS } from '../../src/artifacts/discovery-graph-eval.ts';

export const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const BUDGET = { searches: 1, source_reads: 3, source_bytes: 4096, reasoning_passes: 1 };

/** Extract facts only from inspected immutable raw sources; contradictory values force abstention. */
export function compileConfiguration(task, inspected) {
  const evidence = inspected.filter(doc => doc.kind === 'source');
  const configuration = {};
  for (const field of task.fields) {
    const values = evidence.filter(doc => Object.hasOwn(doc.facts, field)).map(doc => doc.facts[field]);
    const unique = [...new Set(values.map(value => JSON.stringify(value)))];
    if (unique.length !== 1) return { status: 'abstain', reason: unique.length ? 'contradiction' : 'missing-source' };
    configuration[field] = JSON.parse(unique[0]);
  }
  return { status: 'compiled', configuration };
}

export async function discoverRows(cwd, task, graph = false, limit = 3) {
  const output = []; const original = console.log;
  console.log = (...args) => output.push(args.map(String).join(' '));
  try {
    await discoverCapability(cwd, { phrase: task.query, graph: 'project', noBuild: true,
      backend: 'local', json: true, jsonPretty: false, includePaths: false,
      experimentalGraph: graph, typeFilter: ['skill', 'rule', 'memory'], limit });
  } finally { console.log = original; }
  return JSON.parse(output.join('')).results;
}

export async function evaluateDownstream({ cwd, fixture, fixtureDir, entries, graphInput }) {
  const docs = fixture.documents;
  const byId = new Map(entries.map(entry => [discoveryIdForEntry(entry), entry]));
  const byPath = new Map(docs.map(doc => [doc.path, doc]));
  for (const task of fixture.tasks) await discoverRows(cwd, task);
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const graphStart = performance.now();
  const originalGraph = buildDiscoveryGraph(entries, graphInput);
  const constructionMs = performance.now() - graphStart;
  await discoverRows(cwd, fixture.tasks[0], true);
  const started = performance.now();
  const organization = new Map(docs.map(doc => [doc.path, doc.sources ?? []]));
  const organizationMs = performance.now() - started;
  const strategyNames = ['no-memory', 'raw-retrieval', 'lexical', 'organized-document', 'graph',
    ...GRAPH_EVAL_SEEDS.flatMap(seed => [`degree-matched-random:${seed}`, `shuffled-graph:${seed}`])];
  const edgeKey = edge => JSON.stringify([edge.source, edge.target].sort());
  const originalEdges = new Set(originalGraph.edges.map(edgeKey));
  const runs = [];
  for (const strategy of strategyNames) {
    const [control, seedText] = strategy.split(':');
    const graph = seedText ? controlDiscoveryGraph(originalGraph, control, Number(seedText)) : originalGraph;
    const tasks = [];
    for (const task of fixture.tasks) {
      const start = performance.now();
      let selected = []; let searches = 0; let retrievalBytes = 0;
      if (strategy === 'raw-retrieval') {
        selected = docs.slice(0, 3).map(doc => doc.path); searches = 1;
        retrievalBytes = Buffer.byteLength(JSON.stringify(docs.slice(0, 3)));
      }
      else if (strategy !== 'no-memory') {
        searches = 1;
        const rows = await discoverRows(cwd, task, strategy === 'graph', seedText ? entries.length : 3);
        retrievalBytes = Buffer.byteLength(JSON.stringify(rows));
        selected = rows.map(row => byId.get(row.id)?.path).filter(Boolean);
        if (seedText) {
          const lexical = rows.flatMap(row => byId.has(row.id) ? [{ entry: byId.get(row.id), score: row.ranking?.final_score ?? row.score }] : []);
          selected = rankDiscoveryGraph(graph, lexical, entries, task.query).slice(0, 3).map(item => item.entry.path);
        }
      }
      // Organization follows raw source links inside the same three-read envelope.
      if (strategy === 'organized-document') selected = [...new Set(selected.flatMap(file => [...organization.get(file), file]))].slice(0, 3);
      const inspected = []; const sources = []; let bytes = 0;
      for (const file of selected.slice(0, BUDGET.source_reads)) {
        const doc = byPath.get(file);
        const raw = fs.readFileSync(path.join(fixtureDir, file));
        if (digest(raw) !== doc.digest) throw new Error(`Source changed: ${file}`);
        if (bytes + raw.length > BUDGET.source_bytes) break;
        bytes += raw.length; inspected.push(JSON.parse(raw)); sources.push({ ref: file, digest: doc.digest });
      }
      const answer = compileConfiguration(task, inspected);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      const success = JSON.stringify(answer.status === 'compiled' ? answer.configuration : answer.status)
        === JSON.stringify(task.expected);
      const unsupported = answer.status === 'compiled' && Object.entries(answer.configuration).some(([field, value]) =>
        !inspected.some(doc => doc.kind === 'source' && JSON.stringify(doc.facts[field]) === JSON.stringify(value)));
      const required = task.required_sources ?? [];
      tasks.push({ id: task.id, selected, sources, answer, success, unsupported_conclusion: unsupported,
        retrieved_required_source_fraction: required.length ? required.filter(file => selected.includes(file)).length / required.length : null,
        inspected_required_source_fraction: required.length ? required.filter(file => sources.some(source => source.ref === file)).length / required.length : null,
        searches, source_reads: inspected.length, source_bytes: bytes, reasoning_passes: 1,
        retrieval_context_bytes: retrievalBytes, latency_ms: performance.now() - start });
    }
    runs.push({ strategy, changed_edges: seedText ? graph.edges.filter(edge => !originalEdges.has(edgeKey(edge))).length : 0,
      success_count: tasks.filter(task => task.success).length, task_count: tasks.length,
      compiled_count: tasks.filter(task => task.answer.status === 'compiled').length,
      correct_compilations: tasks.filter(task => task.success && task.answer.status === 'compiled').length,
      correct_abstentions: tasks.filter(task => task.success && task.answer.status === 'abstain').length,
      unsupported_conclusions: tasks.filter(task => task.unsupported_conclusion).length,
      source_reads: tasks.reduce((sum, task) => sum + task.source_reads, 0),
      source_bytes: tasks.reduce((sum, task) => sum + task.source_bytes, 0), tasks });
  }
  const graphBytes = Buffer.byteLength(serializeDiscoveryGraph(originalGraph));
  const inputBytes = Buffer.byteLength(JSON.stringify(graphInput));
  const lexicalBytes = Buffer.byteLength(JSON.stringify({ entries: Object.fromEntries(entries.map(entry => [entry.path, entry])) }));
  const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  const measurements = { construction_ms: constructionMs, nodes: originalGraph.nodes.length, edges: originalGraph.edges.length,
    warm_p95_latency_ms: p95(runs.find(run => run.strategy === 'graph').tasks.map(task => task.latency_ms)),
    lexical_warm_p95_latency_ms: p95(runs.find(run => run.strategy === 'lexical').tasks.map(task => task.latency_ms)),
    lexical_index_bytes: lexicalBytes, serialized_graph_bytes: graphBytes, serialized_input_bytes: inputBytes,
    storage_ratio: (lexicalBytes + graphBytes + inputBytes) / lexicalBytes,
    baseline_rss_bytes: baselineRss, peak_rss_bytes: peakRss, incremental_rss_bytes: Math.max(0, peakRss - baselineRss) };
  return { budget: BUDGET, measurements, budgets: { latency_ms: 250, storage_ratio: 2, incremental_rss_bytes: 64 * 1024 * 1024,
    passed: measurements.warm_p95_latency_ms <= 250 && measurements.storage_ratio <= 2 && measurements.incremental_rss_bytes <= 64 * 1024 * 1024 },
    organization: { construction_ms: organizationMs,
    serialized_bytes: Buffer.byteLength(JSON.stringify([...organization])), maintenance: 'full rebuild of immutable links; no updates in sample' },
    graph_serialized_bytes: graphBytes, runs,
    limitations: ['Synthetic, author-specified tasks and graph; no held-out or human calibration.',
      'One deterministic configuration compiler, not an LLM or a coding-agent task-success estimate.',
      'Raw retrieval is insertion-order selection, an intentionally weak unorganized baseline.',
      'Controls use prepared graphs and rounded lexical scores; control latency is not comparable to public graph calls.',
      'Retrieved-row JSON bytes and inspected source bytes are reported separately; neither is a token count.',
      'Downstream timings include bounded source reads, digest verification and compilation; sampled RSS includes every strategy and controls.',
      'Organization stores links, never replaces raw sources; initial construction is measured separately; maintenance is not exercised.'] };
}
