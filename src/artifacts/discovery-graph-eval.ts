// Measure the offline graph and seeded controls against the same warm lexical retriever.
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import type { ArtifactIndex, MetadataEntry } from './types.js';
import type { DiscoveryEvalMetrics, DiscoveryRelevanceQuery, RankedDiscoveryItem } from './discovery-eval.js';
import { loadGraphIndexFile } from './index-reader.js';
import { discoveryIdForEntry, isOrdinaryMemoryEntry } from './query-engine-entries.js';
import { buildDiscoveryGraph, controlDiscoveryGraph, rankDiscoveryGraph, type DiscoveryGraph, type GraphControl } from './discovery-graph.js';

export const GRAPH_EVAL_SEEDS = [3319, 4239, 1819] as const;
type Strategy = 'lexical' | 'graph' | GraphControl;
export interface DiscoveryGraphMatrixReport {
  schema: 'aiwg.discovery-eval-report.v1';
  historical_80_query_partition: string;
  seeds: number[];
  hardware: { platform: string; arch: string; cpu_model: string; node: string };
  graph: { nodes: number; edges: number; communities: number; supplied_co_use_pairs: number; supplied_similarity_pairs: number };
  measurements: {
    warm_p95_latency_ms: number; lexical_warm_p95_latency_ms: number; construction_ms: number;
    storage_ratio: number; lexical_index_bytes: number; serialized_graph_bytes: number;
    incremental_rss_bytes: number; baseline_rss_bytes: number; peak_rss_bytes: number;
  };
  budgets: { latency_ms: number; storage_ratio: number; incremental_rss_bytes: number; passed: boolean; missed: string[] };
  runs: Array<{ strategy: Strategy; seed: number | null; metrics: DiscoveryEvalMetrics; warm_p95_latency_ms: number; warm_p50_latency_ms: number;
    changed_edges: number; queries: Array<{ id: string; target_type: string; relevant_rank: number | null;
      reciprocal_rank: number; latency_ms: number; results: RankedDiscoveryItem[]; context_bytes: number }> }>;
  limitations: string[];
}
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;
const round = (value: number) => Math.round(value * 1000) / 1000;
const edgeKey = (a: string, b: string) => JSON.stringify([a, b].sort());

/** The exact bytes counted for the candidate graph representation; metadata stays in its owner index. */
export function serializeDiscoveryGraph(graph: DiscoveryGraph): string {
  return JSON.stringify({ nodes: graph.nodes.map(node => node.path), edges: graph.edges,
    communities: graph.communities, uses: graph.uses, nowSeconds: graph.nowSeconds });
}

export async function measureDiscoveryGraphMatrix(options: {
  cwd: string; records: DiscoveryRelevanceQuery[]; limit: number; lexicalIndexBytes: number;
  lexicalRank: (query: DiscoveryRelevanceQuery, limit: number) => Promise<RankedDiscoveryItem[]>;
  graphRank: (query: DiscoveryRelevanceQuery, limit: number) => Promise<RankedDiscoveryItem[]>;
  metrics: (records: DiscoveryRelevanceQuery[], results: RankedDiscoveryItem[][]) => DiscoveryEvalMetrics;
  latencyCeilingMs?: number; storageCeilingRatio?: number; rssCeilingBytes?: number;
  historical80QueryPartition?: string;
}): Promise<DiscoveryGraphMatrixReport> {
  const index = loadGraphIndexFile<ArtifactIndex>(options.cwd, 'metadata.json', 'framework');
  if (!index) throw new Error('Offline graph evaluation requires a cached local framework index');
  const entries = Object.values(index.entries).filter(entry => isOrdinaryMemoryEntry(entry));
  const byIdentity = new Map<string, MetadataEntry>();
  for (const entry of entries) {
    byIdentity.set(discoveryIdForEntry(entry), entry);
    byIdentity.set(`${entry.type}:${entry.name ?? entry.title}`.toLowerCase(), entry);
  }
  // Warm every query before recording any latency or graph allocation baseline.
  for (const record of options.records) await options.lexicalRank(record, options.limit);
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const started = performance.now();
  const graph = buildDiscoveryGraph(entries, index.experimentalGraph);
  const constructionMs = performance.now() - started;
  const graphBytes = Buffer.byteLength(serializeDiscoveryGraph(graph), 'utf8');
  const sampleRss = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
  sampleRss();
  await options.graphRank(options.records[0], options.limit); sampleRss();
  const runs: DiscoveryGraphMatrixReport['runs'] = [];
  const strategies: Array<{ strategy: Strategy; seed: number | null }> = [
    { strategy: 'lexical', seed: null }, { strategy: 'graph', seed: null },
    ...GRAPH_EVAL_SEEDS.flatMap(seed => [
      { strategy: 'degree-matched-random' as const, seed }, { strategy: 'shuffled-graph' as const, seed },
    ]),
  ];
  const originalEdges = new Set(graph.edges.map(edge => edgeKey(edge.source, edge.target)));
  for (const { strategy, seed } of strategies) {
    const selected = strategy === 'degree-matched-random' || strategy === 'shuffled-graph'
      ? controlDiscoveryGraph(graph, strategy, seed!) : graph;
    sampleRss();
    if (seed !== null && !graph.edges.length) {
      // Empty topology makes both controls exactly lexical; label reused timing explicitly.
      runs.push({ ...runs[0], strategy, seed, changed_edges: 0 });
      continue;
    }
    const resultSets: RankedDiscoveryItem[][] = []; const latencies: number[] = [];
    for (const record of options.records) {
      const start = performance.now();
      const lexical = strategy === 'graph' ? await options.graphRank(record, options.limit)
        : await options.lexicalRank(record, strategy === 'lexical' ? options.limit : Math.max(entries.length, options.limit));
      const seeds = lexical.flatMap(item => {
        const entry = byIdentity.get(item.id) ?? byIdentity.get(`${item.type}:${item.name}`.toLowerCase());
        return entry ? [{ entry, score: item.score }] : [];
      });
      const candidates = entries.filter(entry => entry.type === record.target_type);
      const results = strategy === 'lexical' || strategy === 'graph' ? lexical.slice(0, options.limit)
        : rankDiscoveryGraph(selected, seeds, candidates, record.query).slice(0, options.limit).map(({ entry, score }) => ({
          id: discoveryIdForEntry(entry), type: entry.type, name: entry.name ?? entry.title, score,
        }));
      latencies.push(performance.now() - start); resultSets.push(results); sampleRss();
    }
    runs.push({ strategy, seed, metrics: options.metrics(options.records, resultSets), warm_p95_latency_ms: round(p95(latencies)),
      warm_p50_latency_ms: round([...latencies].sort((a, b) => a - b)[Math.ceil(latencies.length / 2) - 1] ?? 0),
      changed_edges: selected.edges.filter(edge => !originalEdges.has(edgeKey(edge.source, edge.target))).length,
      queries: options.records.map((record, i) => {
        const rank = resultSets[i].findIndex(item => record.relevant_ids.some(expected =>
          [item.id.toLowerCase(), `${item.type}:${item.name}`.toLowerCase()].includes(expected.toLowerCase())));
        return { id: record.id, target_type: record.target_type, relevant_rank: rank < 0 ? null : rank + 1,
          reciprocal_rank: rank < 0 ? 0 : 1 / (rank + 1), latency_ms: round(latencies[i]), results: resultSets[i],
          context_bytes: Buffer.byteLength(JSON.stringify(resultSets[i]), 'utf8') };
      }),
    });
  }
  const graphP95 = runs.find(run => run.strategy === 'graph')!.warm_p95_latency_ms;
  const storageRatio = (options.lexicalIndexBytes + graphBytes) / Math.max(1, options.lexicalIndexBytes);
  const deltaRss = Math.max(0, peakRss - baselineRss);
  const budgets = { latency_ms: options.latencyCeilingMs ?? 250, storage_ratio: options.storageCeilingRatio ?? 2,
    incremental_rss_bytes: options.rssCeilingBytes ?? 64 * 1024 * 1024, passed: false, missed: [] as string[] };
  if (graphP95 > budgets.latency_ms) budgets.missed.push('warm p95 latency');
  if (storageRatio > budgets.storage_ratio) budgets.missed.push('storage ratio');
  if (deltaRss > budgets.incremental_rss_bytes) budgets.missed.push('incremental RSS');
  budgets.passed = budgets.missed.length === 0;
  const input = index.experimentalGraph;
  const limitations = [
    options.historical80QueryPartition
      ? 'Historical fixture recovered from pinned history; evaluation against the current corpus is development evidence, not held-out evidence.'
      : 'Historical 80-query partition not identified; the current rows are not a held-out evaluation.',
    'In-house Leiden prototype uses deterministic modularity moves/refinement/aggregation; equivalence to a reference library is unverified.',
    'Context bytes measure UTF-8 retrieval JSON, not task completion. No reviewed downstream task fixture was supplied.',
    'Storage measures the serialized candidate representation plus lexical index, not a deployed graph store.',
    'Incremental RSS is the sampled process delta after lexical warm-up, including construction and all controls; allocator noise remains.',
    'Degree-matched control uses bounded double-edge swaps; exact node degrees are preserved, uniform mixing is not guaranteed.',
    'Lexical and graph latency use the public cached-local discovery path, including output serialization and graph construction. Controls use full lexical JSON scores rounded to six decimals plus prepared-graph ranking; their latency is not directly comparable.',
  ];
  if (!input?.coUse?.pairs.length && !input?.similarities?.length) limitations.push(
    'No supplied offline co-use counts or embedding similarities; graph edges are empty and controls are degenerate. No graph quality conclusion is supported.');
  if (!graph.edges.length) limitations.push('Empty-graph controls reuse lexical results and lexical latency measurements; no independent control latency is claimed.');
  if (runs.some(run => run.seed !== null && run.changed_edges === 0)) limitations.push('At least one control left topology unchanged; inspect changed_edges before interpreting comparisons.');
  if (!budgets.passed) limitations.push(`Budget missed: ${budgets.missed.join(', ')}.`);
  return {
    schema: 'aiwg.discovery-eval-report.v1', historical_80_query_partition: options.historical80QueryPartition ?? 'not identified', seeds: [...GRAPH_EVAL_SEEDS],
    hardware: { platform: os.platform(), arch: os.arch(), cpu_model: os.cpus()[0]?.model ?? 'unknown', node: process.version },
    graph: { nodes: graph.nodes.length, edges: graph.edges.length, communities: graph.communities.length,
      supplied_co_use_pairs: input?.coUse?.pairs.length ?? 0, supplied_similarity_pairs: input?.similarities?.length ?? 0 },
    measurements: { warm_p95_latency_ms: graphP95, lexical_warm_p95_latency_ms: runs[0].warm_p95_latency_ms,
      construction_ms: round(constructionMs), storage_ratio: storageRatio, lexical_index_bytes: options.lexicalIndexBytes,
      serialized_graph_bytes: graphBytes, incremental_rss_bytes: deltaRss, baseline_rss_bytes: baselineRss, peak_rss_bytes: peakRss },
    budgets, runs, limitations,
  };
}
