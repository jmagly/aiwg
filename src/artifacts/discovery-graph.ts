// Construct and rank an offline skill/rule/memory graph from explicitly supplied observations.
import type { MetadataEntry, QueryResult } from './types.js';
import { isOrdinaryMemoryEntry, dedupeDiscoverResults } from './query-engine-entries.js';
import { summarizeCommunities } from './discovery-graph-communities.js';

export interface OfflineGraphInput {
  coUse?: { windows: number; occurrences: Record<string, number>; pairs: Array<{ source: string; target: string; count: number }> };
  similarities?: Array<{ source: string; target: string; similarity: number }>;
  nearestNeighbours?: number;
  minSharedNeighbours?: number;
  nowSeconds?: number;
  uses?: Record<string, number[]>;
}
export interface DiscoveryGraphEdge { source: string; target: string; weight: number }
export interface DiscoveryGraph {
  nodes: MetadataEntry[];
  edges: DiscoveryGraphEdge[];
  communities: Array<{ members: string[]; summary: string }>;
  uses: Record<string, number[]>;
  nowSeconds: number;
}
export type GraphControl = 'degree-matched-random' | 'shuffled-graph';
const key = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);
const invalid = (): never => { throw new Error('Invalid offline graph fixture observations'); };
const finite = (n: number) => typeof n === 'number' && Number.isFinite(n);
const count = (n: number) => Number.isSafeInteger(n) && n >= 0;

function validate(input: OfflineGraphInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  for (const n of [input.nearestNeighbours, input.minSharedNeighbours]) if (n !== undefined && (!count(n) || n < 1)) invalid();
  const co = input.coUse;
  if (co) {
    if (!count(co.windows) || co.windows < 1 || !co.occurrences || !Array.isArray(co.pairs)) invalid();
    for (const n of Object.values(co.occurrences)) if (!count(n) || n > co.windows) invalid();
    const seen = new Set<string>();
    for (const pair of co.pairs) {
      if (!pair || typeof pair.source !== 'string' || typeof pair.target !== 'string'
        || !count(pair.count) || pair.count > (co.occurrences[pair.source] ?? -1)
        || pair.count > (co.occurrences[pair.target] ?? -1) || seen.has(key(pair.source, pair.target))) invalid();
      seen.add(key(pair.source, pair.target));
    }
  }
  if (input.similarities !== undefined && !Array.isArray(input.similarities)) invalid();
  const seen = new Set<string>();
  for (const pair of input.similarities ?? []) {
    if (!pair || typeof pair.source !== 'string' || typeof pair.target !== 'string'
      || !finite(pair.similarity) || pair.similarity < -1 || pair.similarity > 1
      || seen.has(key(pair.source, pair.target))) invalid();
    seen.add(key(pair.source, pair.target));
  }
  if (input.nowSeconds !== undefined && (!finite(input.nowSeconds) || input.nowSeconds < 0)) invalid();
  if (input.uses && (input.nowSeconds === undefined || typeof input.uses !== 'object' || Array.isArray(input.uses))) invalid();
  for (const times of Object.values(input.uses ?? {})) {
    if (!Array.isArray(times) || times.some(time => !finite(time) || time < 0 || time > input.nowSeconds!)) invalid();
  }
}

export function buildDiscoveryGraph(entries: MetadataEntry[], input: OfflineGraphInput = {}): DiscoveryGraph {
  validate(input);
  const nodes = [...new Map(entries.filter(entry =>
    (entry.type === 'skill' || entry.type === 'rule' || entry.type === 'memory' || entry.memoryRecord)
    && isOrdinaryMemoryEntry(entry)).map(entry => [entry.path, entry])).values()]
    .sort((a, b) => a.path.localeCompare(b.path));
  const paths = new Set(nodes.map(node => node.path));
  const edges = new Map<string, DiscoveryGraphEdge>();
  const add = (source: string, target: string, weight: number) => {
    if (source === target || !paths.has(source) || !paths.has(target) || weight <= 0) return;
    const edgeKey = key(source, target);
    const edge = edges.get(edgeKey) ?? { source: source < target ? source : target, target: source < target ? target : source, weight: 0 };
    edge.weight += weight; edges.set(edgeKey, edge);
  };
  if (input.coUse) {
    const { windows, occurrences, pairs } = input.coUse;
    for (const pair of pairs) {
      if (!pair.count) continue;
      const pmi = Math.log(pair.count * windows / (occurrences[pair.source] * occurrences[pair.target]));
      if (pmi > 0) add(pair.source, pair.target, pmi);
    }
  }
  const neighbours = new Map<string, Array<{ path: string; similarity: number }>>();
  for (const pair of input.similarities ?? []) {
    if (!paths.has(pair.source) || !paths.has(pair.target) || pair.source === pair.target || pair.similarity <= 0) continue;
    for (const [a, b] of [[pair.source, pair.target], [pair.target, pair.source]]) {
      const list = neighbours.get(a) ?? []; list.push({ path: b, similarity: pair.similarity }); neighbours.set(a, list);
    }
  }
  const nearest = new Map([...neighbours].map(([node, list]) => [node, new Set(list
    .sort((a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path))
    .slice(0, input.nearestNeighbours ?? 10).map(item => item.path))]));
  for (const pair of input.similarities ?? []) {
    const shared = [...(nearest.get(pair.source) ?? [])].filter(node => nearest.get(pair.target)?.has(node)).length;
    if (shared >= (input.minSharedNeighbours ?? 1)) add(pair.source, pair.target, pair.similarity);
  }
  const result: DiscoveryGraph = {
    nodes, edges: [...edges.values()].sort((a, b) => key(a.source, a.target).localeCompare(key(b.source, b.target))),
    communities: [], uses: structuredClone(input.uses ?? {}), nowSeconds: input.nowSeconds ?? 0,
  };
  result.communities = summarizeCommunities(result);
  return result;
}

/** ACT-R base-level activation: ln(sum(age^-0.5)); the fixture fixes the clock. */
export function actrActivation(times: number[], nowSeconds: number): number {
  if (!times.length) return 0;
  return Math.log(times.reduce((sum, time) => sum + Math.max(1, nowSeconds - time) ** -0.5, 0));
}

function pageRank(graph: DiscoveryGraph, seeds: Map<string, number>): Map<string, number> {
  const total = [...seeds.values()].reduce((sum, score) => sum + score, 0);
  if (!total) return new Map();
  const restart = new Map([...seeds].map(([node, score]) => [node, score / total]));
  const adjacency = new Map(graph.nodes.map(node => [node.path, new Map<string, number>()]));
  for (const edge of graph.edges) {
    adjacency.get(edge.source)!.set(edge.target, edge.weight); adjacency.get(edge.target)!.set(edge.source, edge.weight);
  }
  let ranks = new Map(restart);
  for (let iteration = 0; iteration < 80; iteration++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const [node, score] of ranks) {
      const neighbours = adjacency.get(node)!;
      const degree = [...neighbours.values()].reduce((sum, weight) => sum + weight, 0);
      if (!degree) dangling += score;
      else for (const [target, weight] of neighbours) next.set(target, (next.get(target) ?? 0) + 0.8 * score * weight / degree);
    }
    for (const [node, score] of restart) next.set(node, (next.get(node) ?? 0) + (0.2 + 0.8 * dangling) * score);
    const delta = [...adjacency.keys()].reduce((sum, node) => sum + Math.abs((next.get(node) ?? 0) - (ranks.get(node) ?? 0)), 0);
    ranks = next;
    if (delta < 1e-10) break;
  }
  return ranks;
}

export function rankDiscoveryGraph(graph: DiscoveryGraph, lexical: QueryResult[], candidates: MetadataEntry[], phrase: string): QueryResult[] {
  // Without supplied edges the exact lexical order/scores are the fallback.
  if (!graph.edges.length) return lexical;
  const paths = new Set(graph.nodes.map(node => node.path));
  const seeds = new Map(lexical.slice(0, 50).filter(item => paths.has(item.entry.path)).map(item => [item.entry.path, item.score]));
  const terms = [...new Set(phrase.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
  // Deterministic extractive community summaries supply a small additional seed.
  for (const community of graph.communities) {
    if (community.members.length < 2 || !terms.length) continue;
    const words = new Set(community.summary.toLowerCase().match(/[a-z0-9]+/g));
    const overlap = terms.filter(term => words.has(term)).length / terms.length;
    if (overlap < 0.5) continue;
    for (const node of community.members) seeds.set(node, (seeds.get(node) ?? 0) + 0.1 * overlap / community.members.length);
  }
  const ranks = pageRank(graph, seeds);
  const maxRank = Math.max(...ranks.values(), 0);
  const lexicalByPath = new Map(lexical.map(item => [item.entry.path, item]));
  return dedupeDiscoverResults(candidates.flatMap(entry => {
    const base = lexicalByPath.get(entry.path)?.score ?? 0;
    const rank = ranks.get(entry.path) ?? 0;
    if (!rank) return base > 0 ? [{ entry, score: base }] : [];
    const times = graph.uses[entry.path] ?? [];
    const activation = times.length ? 1 / (1 + Math.exp(-actrActivation(times, graph.nowSeconds))) : 0;
    return [{ entry, score: base + 0.25 * rank / maxRank + 0.05 * activation }];
  }));
}

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function controlDiscoveryGraph(graph: DiscoveryGraph, strategy: GraphControl, seed: number): DiscoveryGraph {
  const random = randomGenerator(seed);
  let edges = graph.edges.map(edge => ({ ...edge }));
  if (strategy === 'shuffled-graph') {
    const labels = graph.nodes.map(node => node.path);
    for (let i = labels.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1)); [labels[i], labels[j]] = [labels[j], labels[i]];
    }
    const permutation = new Map(graph.nodes.map((node, i) => [node.path, labels[i]]));
    edges = edges.map(edge => ({ ...edge, source: permutation.get(edge.source)!, target: permutation.get(edge.target)! }));
  } else {
    // Double-edge swaps preserve every node's unweighted degree exactly.
    const keys = new Set(edges.map(edge => key(edge.source, edge.target)));
    for (let attempt = 0; attempt < edges.length * 40; attempt++) {
      const i = Math.floor(random() * edges.length); const j = Math.floor(random() * edges.length);
      if (i === j) continue;
      const a = edges[i]; const b = edges[j];
      const [bs, bt] = random() < 0.5 ? [b.source, b.target] : [b.target, b.source];
      if (new Set([a.source, a.target, bs, bt]).size !== 4) continue;
      const first = key(a.source, bt); const second = key(bs, a.target);
      if (keys.has(first) || keys.has(second)) continue;
      keys.delete(key(a.source, a.target)); keys.delete(key(b.source, b.target));
      keys.add(first); keys.add(second);
      edges[i] = { ...a, target: bt }; edges[j] = { ...b, source: bs, target: a.target };
    }
  }
  edges = edges.map(edge => edge.source < edge.target ? edge : { ...edge, source: edge.target, target: edge.source })
    .sort((a, b) => key(a.source, a.target).localeCompare(key(b.source, b.target)));
  const result = { ...graph, edges, communities: [] } as DiscoveryGraph;
  result.communities = summarizeCommunities(result);
  return result;
}
