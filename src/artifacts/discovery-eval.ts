import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ArtifactIndex, MetadataEntry, OperationalDiscoveryType } from './types.js';
import { getGraphIndexDir, OPERATIONAL_DISCOVERY_TYPES } from './types.js';
import { getFrameworkIndexBaseDir } from './framework-index-paths.js';
import { loadGraphIndexFile } from './index-reader.js';
import { loadFortemiCoreExport, loadFortemiCoreMetadataEntries, scoreStaticRecord } from './fortemi-core-query-adapter.js';
import { discoverCapability } from './query-engine.js';
import type { AiwgFortemiIndexExport } from './browser-export.js';
import { measureDiscoveryGraphMatrix, type DiscoveryGraphMatrixReport } from './discovery-graph-eval.js';

export const DISCOVERY_EVAL_SCHEMA = 'aiwg.discovery-relevance.v1';
export const DISCOVERY_EVAL_REPORT_SCHEMA = 'aiwg.discovery-eval-report.v1';
export const DISCOVERY_EVAL_STRATEGIES = ['lexical', 'dense', 'hybrid-rrf', 'rerank', 'chunk-multivector', 'graph', 'degree-matched-random', 'shuffled-graph'] as const;
export type DiscoveryEvalStrategy = typeof DISCOVERY_EVAL_STRATEGIES[number];
export type DiscoveryEvalBackend = 'local' | 'fortemi-core';

export interface DiscoveryRelevanceQuery {
  schema: typeof DISCOVERY_EVAL_SCHEMA;
  id: string;
  query: string;
  target_type: OperationalDiscoveryType;
  relevant_ids: string[];
  hard_negative_ids: string[];
  query_class: 'exact-name' | 'capability' | 'process-step' | 'hard-negative' | 'cross-type';
  notes?: string;
}

export interface RankedDiscoveryItem { id: string; type: string; name: string; score: number }
export interface DiscoveryEvalMetrics {
  query_count: number; hit_at_1: number; hit_at_3: number; hit_at_5: number; mrr: number; ndcg_at_10: number;
  per_type_recall_at_3: Record<string, number>; hard_negative_intrusion_at_5: number;
}

export interface DiscoveryEvalReport {
  experimental_graph?: DiscoveryGraphMatrixReport;
  schema: typeof DISCOVERY_EVAL_REPORT_SCHEMA;
  corpus: { path: string; schema: typeof DISCOVERY_EVAL_SCHEMA; query_count: number };
  configuration: { backend: DiscoveryEvalBackend; strategy: DiscoveryEvalStrategy; limit: number; graph: 'framework' };
  hardware: { platform: string; arch: string; cpu_model: string; logical_cpus: number; total_memory_bytes: number; node: string };
  metrics: DiscoveryEvalMetrics;
  performance: { p50_latency_ms: number; p95_latency_ms: number; index_bytes: number; peak_resident_memory_bytes: number };
  parity?: { compared_to: 'local:lexical'; top_1_agreement: number; top_5_overlap: number; differing_queries: string[] };
  adoption_gate: {
    baseline: 'local:lexical'; no_per_type_hit_at_3_regression: boolean | null;
    aggregate_mrr_improvement: number | null; mrr_95pct_confidence_interval: [number, number] | null;
    latency_ceiling_ms: number; storage_ceiling_ratio: number; clears_gate: boolean | null; decision: string;
  };
  queries: Array<{ id: string; target_type: string; relevant_rank: number | null; reciprocal_rank: number; latency_ms: number; results: RankedDiscoveryItem[] }>;
}

const round = (value: number, digits = 6): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1] ?? sorted[sorted.length - 1];
}
function stringArray(value: unknown, label: string, line: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`Discovery relevance fixture line ${line}: ${label} must be a non-empty string array`);
  }
  return value;
}

export function parseDiscoveryRelevanceJsonl(content: string): DiscoveryRelevanceQuery[] {
  const records: DiscoveryRelevanceQuery[] = [];
  const ids = new Set<string>();
  for (const [offset, raw] of content.split(/\r?\n/).entries()) {
    if (raw.trim() === '') continue;
    const line = offset + 1;
    let value: Record<string, unknown>;
    try { value = JSON.parse(raw) as Record<string, unknown>; }
    catch (error) { throw new Error(`Discovery relevance fixture line ${line}: malformed JSON (${error instanceof Error ? error.message : String(error)})`); }
    if (value.schema !== DISCOVERY_EVAL_SCHEMA) throw new Error(`Discovery relevance fixture line ${line}: unsupported schema`);
    if (typeof value.id !== 'string' || value.id.trim() === '') throw new Error(`Discovery relevance fixture line ${line}: id must be a non-empty string`);
    if (ids.has(value.id)) throw new Error(`Discovery relevance fixture line ${line}: duplicate query id '${value.id}'`);
    ids.add(value.id);
    if (typeof value.query !== 'string' || value.query.trim() === '') throw new Error(`Discovery relevance fixture line ${line}: query must be a non-empty string`);
    if (!(OPERATIONAL_DISCOVERY_TYPES as readonly string[]).includes(String(value.target_type))) {
      throw new Error(`Discovery relevance fixture line ${line}: invalid target_type '${String(value.target_type)}'`);
    }
    const classes = ['exact-name', 'capability', 'process-step', 'hard-negative', 'cross-type'];
    if (!classes.includes(String(value.query_class))) throw new Error(`Discovery relevance fixture line ${line}: invalid query_class '${String(value.query_class)}'`);
    records.push({
      schema: DISCOVERY_EVAL_SCHEMA, id: value.id, query: value.query,
      target_type: value.target_type as OperationalDiscoveryType,
      relevant_ids: stringArray(value.relevant_ids, 'relevant_ids', line),
      hard_negative_ids: stringArray(value.hard_negative_ids, 'hard_negative_ids', line),
      query_class: value.query_class as DiscoveryRelevanceQuery['query_class'],
      ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
    });
  }
  if (records.length === 0) throw new Error('Discovery relevance fixture contains no queries');
  return records;
}

export function validateOperationalCoverage(records: DiscoveryRelevanceQuery[], minimum = 10): void {
  for (const type of OPERATIONAL_DISCOVERY_TYPES) {
    const count = records.filter((record) => record.target_type === type).length;
    if (count < minimum) throw new Error(`Discovery relevance fixture requires at least ${minimum} '${type}' queries; found ${count}`);
  }
}

function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((term) => term.length > 1))];
}
function identity(entry: MetadataEntry): string { return `${entry.type}:${entry.name ?? entry.title}`.toLowerCase(); }
function matches(item: RankedDiscoveryItem, expected: string): boolean {
  const needle = expected.toLowerCase();
  return item.id.toLowerCase() === needle || `${item.type}:${item.name}`.toLowerCase() === needle;
}
function fields(entry: MetadataEntry): string[] {
  return [entry.name ?? '', entry.title, entry.capability ?? '', entry.summary, ...(entry.triggers ?? []), ...(entry.searchTerms ?? []), entry.path].filter(Boolean);
}
function cosine(left: string, right: string): number {
  const a = terms(left); const b = terms(right);
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  return a.filter((term) => set.has(term)).length / Math.sqrt(a.length * b.length);
}

function prototypeRank(entries: MetadataEntry[], query: string, strategy: Exclude<DiscoveryEvalStrategy, 'lexical'>, limit: number): RankedDiscoveryItem[] {
  const dense = entries.map((entry) => ({ entry, score: cosine(query, fields(entry).join(' ')) }));
  const lexical = entries.map((entry) => {
    const queryTerms = terms(query); const values = fields(entry).map((field) => field.toLowerCase());
    const hits = queryTerms.filter((term) => values.some((value) => value.includes(term))).length;
    return { entry, score: (values.some((value) => value === query.toLowerCase()) ? 1 : 0) + (queryTerms.length ? hits / queryTerms.length : 0) };
  });
  let ranked: Array<{ entry: MetadataEntry; score: number }>;
  if (strategy === 'dense') ranked = dense;
  else if (strategy === 'chunk-multivector') ranked = entries.map((entry) => ({ entry, score: Math.max(...fields(entry).map((field) => cosine(query, field)), 0) }));
  else if (strategy === 'rerank') ranked = [...lexical].sort((a, b) => b.score - a.score).slice(0, 50)
    .map((candidate) => ({ entry: candidate.entry, score: candidate.score + 0.35 * cosine(query, fields(candidate.entry).join(' ')) }));
  else {
    const fused = new Map<string, { entry: MetadataEntry; score: number }>();
    for (const list of [lexical, dense]) {
      [...list].sort((a, b) => b.score - a.score || identity(a.entry).localeCompare(identity(b.entry))).forEach((candidate, rank) => {
        const key = identity(candidate.entry); const current = fused.get(key) ?? { entry: candidate.entry, score: 0 };
        current.score += 1 / (61 + rank); fused.set(key, current);
      });
    }
    ranked = [...fused.values()];
  }
  return ranked.filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || identity(a.entry).localeCompare(identity(b.entry))).slice(0, limit)
    .map(({ entry, score }) => ({ id: identity(entry), type: entry.type, name: entry.name ?? entry.title, score: round(score) }));
}

async function currentRank(cwd: string, query: DiscoveryRelevanceQuery, backend: DiscoveryEvalBackend, limit: number, experimentalGraph = false): Promise<RankedDiscoveryItem[]> {
  const output: string[] = []; const original = console.log;
  console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  try {
    await discoverCapability(cwd, { phrase: query.query, typeFilter: [query.target_type], graph: 'framework', backend, limit, json: true, jsonPretty: false, includePaths: false, noBuild: true, experimentalGraph });
  } finally { console.log = original; }
  const envelope = JSON.parse(output.join('')) as { results: Array<{ id: string; type: string; name?: string; title: string; score: number; ranking?: { final_score: number } }> };
  return envelope.results.map((item) => ({ id: item.id, type: item.type, name: item.name ?? item.title, score: item.ranking?.final_score ?? item.score }));
}

function fortemiStaticRank(exported: AiwgFortemiIndexExport, query: DiscoveryRelevanceQuery, limit: number): RankedDiscoveryItem[] {
  const queryTerms = query.query.toLowerCase().split(/[^a-z0-9-]+/).map((term) => term.trim()).filter((term) => term.length > 2);
  return exported.items
    .filter((record) => (record.search?.type ?? record.type.replace(/^aiwg:/, '')) === query.target_type)
    .map((record) => ({ record, ...scoreStaticRecord(record, queryTerms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.record.source.path.localeCompare(b.record.source.path))
    .slice(0, limit)
    .map(({ record, score }) => ({
      id: `${query.target_type}:${record.name ?? record.search?.name ?? record.title}`.toLowerCase(),
      type: query.target_type,
      name: record.name ?? record.search?.name ?? record.title,
      score: round(score),
    }));
}

function loadEntries(cwd: string, backend: DiscoveryEvalBackend): MetadataEntry[] {
  if (backend === 'fortemi-core') {
    const loaded = loadFortemiCoreMetadataEntries(cwd, 'framework');
    if (!loaded.entries.length) throw new Error(loaded.reason ?? 'Fortemi Core framework index is empty');
    return loaded.entries;
  }
  const index = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', 'framework');
  if (!index) throw new Error('Local framework index is missing; run `aiwg index build --graph framework`');
  return Object.values(index.entries);
}

export function calculateDiscoveryMetrics(records: DiscoveryRelevanceQuery[], resultSets: RankedDiscoveryItem[][]): DiscoveryEvalMetrics {
  const ranks = records.map((record, index) => {
    const rank = (resultSets[index] ?? []).findIndex((item) => record.relevant_ids.some((id) => matches(item, id)));
    return rank < 0 ? null : rank + 1;
  });
  const hit = (k: number) => ranks.filter((rank) => rank !== null && rank <= k).length / records.length;
  const perType: Record<string, number> = {};
  for (const type of OPERATIONAL_DISCOVERY_TYPES) {
    const selected = records.map((record, index) => ({ record, index })).filter(({ record }) => record.target_type === type);
    perType[type] = round(selected.filter(({ index }) => ranks[index] !== null && ranks[index]! <= 3).length / selected.length);
  }
  return {
    query_count: records.length, hit_at_1: round(hit(1)), hit_at_3: round(hit(3)), hit_at_5: round(hit(5)),
    mrr: round(ranks.reduce<number>((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / records.length),
    ndcg_at_10: round(ranks.reduce<number>((sum, rank) => sum + (rank === null || rank > 10 ? 0 : 1 / Math.log2(rank + 1)), 0) / records.length),
    per_type_recall_at_3: perType,
    hard_negative_intrusion_at_5: round(records.filter((record, index) => (resultSets[index] ?? []).slice(0, 5)
      .some((item) => record.hard_negative_ids.some((id) => matches(item, id)))).length / records.length),
  };
}

function indexBytes(cwd: string, backend: DiscoveryEvalBackend): number {
  const root = backend === 'local' ? getGraphIndexDir(cwd, 'framework')
    : path.join(getFrameworkIndexBaseDir(cwd), 'fortemi-core', 'framework');
  let total = 0;
  const visit = (target: string): void => {
    if (!fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    if (stat.isFile()) total += stat.size; else for (const child of fs.readdirSync(target)) visit(path.join(target, child));
  };
  visit(root); return total;
}

export async function evaluateDiscovery(options: {
  cwd: string; fixturePath: string; backend: DiscoveryEvalBackend; strategy: DiscoveryEvalStrategy; limit?: number;
  latencyCeilingMs?: number; storageCeilingRatio?: number;
}): Promise<DiscoveryEvalReport> {
  if (['graph', 'degree-matched-random', 'shuffled-graph'].includes(options.strategy)) {
    if (options.backend !== 'local') throw new Error('Experimental graph evaluation requires the local backend');
    return graphEvaluationReport(options);
  }
  const records = parseDiscoveryRelevanceJsonl(fs.readFileSync(options.fixturePath, 'utf8'));
  validateOperationalCoverage(records);
  const limit = options.limit ?? 10; const entries = loadEntries(options.cwd, options.backend);
  const fortemiExport = options.backend === 'fortemi-core' && options.strategy === 'lexical'
    ? loadFortemiCoreExport(options.cwd, 'framework')
    : null;
  if (fortemiExport && !fortemiExport.exported) {
    throw new Error(fortemiExport.reason ?? 'Fortemi Core framework export is unavailable');
  }
  const resultSets: RankedDiscoveryItem[][] = []; const latencies: number[] = [];
  let peakRss = process.memoryUsage().rss;
  for (const record of records) {
    const start = performance.now();
    resultSets.push(options.strategy === 'lexical'
      ? options.backend === 'fortemi-core'
        ? fortemiStaticRank(fortemiExport!.exported!, record, limit)
        : await currentRank(options.cwd, record, options.backend, limit)
      : prototypeRank(entries.filter((entry) => entry.type === record.target_type), record.query, options.strategy, limit));
    latencies.push(performance.now() - start); peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  const metrics = calculateDiscoveryMetrics(records, resultSets); const cpus = os.cpus();
  let parity: DiscoveryEvalReport['parity'];
  if (options.backend === 'fortemi-core' && options.strategy === 'lexical') {
    const localSets: RankedDiscoveryItem[][] = [];
    for (const record of records) localSets.push(await currentRank(options.cwd, record, 'local', limit));
    const differingQueries: string[] = [];
    let topOneAgreements = 0;
    let topFiveOverlap = 0;
    for (let index = 0; index < records.length; index++) {
      const fortemi = resultSets[index];
      const local = localSets[index];
      const key = (item: RankedDiscoveryItem | undefined) => item ? `${item.type}:${item.name}`.toLowerCase() : '';
      if (key(fortemi[0]) === key(local[0])) topOneAgreements++;
      else differingQueries.push(records[index].id);
      const localFive = new Set(local.slice(0, 5).map((item) => key(item)));
      topFiveOverlap += fortemi.slice(0, 5).filter((item) => localFive.has(key(item))).length / Math.max(1, Math.min(5, local.length, fortemi.length));
    }
    parity = {
      compared_to: 'local:lexical',
      top_1_agreement: round(topOneAgreements / records.length),
      top_5_overlap: round(topFiveOverlap / records.length),
      differing_queries: differingQueries,
    };
  }
  return {
    schema: DISCOVERY_EVAL_REPORT_SCHEMA,
    corpus: { path: path.relative(options.cwd, options.fixturePath).replace(/\\/g, '/'), schema: DISCOVERY_EVAL_SCHEMA, query_count: records.length },
    configuration: { backend: options.backend, strategy: options.strategy, limit, graph: 'framework' },
    hardware: { platform: os.platform(), arch: os.arch(), cpu_model: cpus[0]?.model ?? 'unknown', logical_cpus: cpus.length, total_memory_bytes: os.totalmem(), node: process.version },
    metrics,
    performance: { p50_latency_ms: round(percentile(latencies, 0.5), 3), p95_latency_ms: round(percentile(latencies, 0.95), 3), index_bytes: indexBytes(options.cwd, options.backend), peak_resident_memory_bytes: peakRss },
    ...(parity ? { parity } : {}),
    adoption_gate: {
      baseline: 'local:lexical', no_per_type_hit_at_3_regression: null, aggregate_mrr_improvement: null,
      mrr_95pct_confidence_interval: null, latency_ceiling_ms: options.latencyCeilingMs ?? 250,
      storage_ceiling_ratio: options.storageCeilingRatio ?? 2, clears_gate: null,
      decision: 'Run the full strategy matrix and compare against local:lexical before adoption.',
    },
    queries: records.map((record, index) => {
      const rank = resultSets[index].findIndex((item) => record.relevant_ids.some((id) => matches(item, id)));
      return { id: record.id, target_type: record.target_type, relevant_rank: rank < 0 ? null : rank + 1, reciprocal_rank: rank < 0 ? 0 : round(1 / (rank + 1)), latency_ms: round(latencies[index], 3), results: resultSets[index] };
    }),
  };
}

/** Offline matrix uses the current lexical owner for every strategy and never creates observations. */
export async function evaluateDiscoveryGraphMatrix(options: {
  cwd: string; fixturePath: string; limit?: number; latencyCeilingMs?: number; storageCeilingRatio?: number; rssCeilingBytes?: number;
}): Promise<DiscoveryGraphMatrixReport> {
  const records = parseDiscoveryRelevanceJsonl(fs.readFileSync(options.fixturePath, 'utf8'));
  validateOperationalCoverage(records);
  return measureDiscoveryGraphMatrix({ ...options, records, limit: options.limit ?? 10,
    lexicalIndexBytes: indexBytes(options.cwd, 'local'), metrics: calculateDiscoveryMetrics,
    lexicalRank: (query, limit) => currentRank(options.cwd, query, 'local', limit),
    graphRank: (query, limit) => currentRank(options.cwd, query, 'local', limit, true) });
}

async function graphEvaluationReport(options: Parameters<typeof evaluateDiscovery>[0]): Promise<DiscoveryEvalReport> {
  const matrix = await evaluateDiscoveryGraphMatrix(options);
  const run = matrix.runs.find(item => item.strategy === options.strategy)!;
  const cpus = os.cpus();
  return {
    schema: DISCOVERY_EVAL_REPORT_SCHEMA, experimental_graph: matrix,
    corpus: { path: path.relative(options.cwd, options.fixturePath), schema: DISCOVERY_EVAL_SCHEMA, query_count: run.metrics.query_count },
    configuration: { backend: 'local', strategy: options.strategy, limit: options.limit ?? 10, graph: 'framework' },
    hardware: { ...matrix.hardware, logical_cpus: cpus.length, total_memory_bytes: os.totalmem() },
    metrics: run.metrics,
    performance: { p50_latency_ms: run.warm_p50_latency_ms, p95_latency_ms: run.warm_p95_latency_ms,
      index_bytes: matrix.measurements.lexical_index_bytes + matrix.measurements.serialized_graph_bytes,
      peak_resident_memory_bytes: matrix.measurements.peak_rss_bytes },
    adoption_gate: { baseline: 'local:lexical', no_per_type_hit_at_3_regression: null, aggregate_mrr_improvement: null,
      mrr_95pct_confidence_interval: null, latency_ceiling_ms: matrix.budgets.latency_ms, storage_ceiling_ratio: matrix.budgets.storage_ratio,
      clears_gate: false, decision: matrix.budgets.passed
        ? 'Measured resource budgets pass; experimental only. Review graph observations, controls and held-out downstream evidence before adoption.'
        : `Budget missed: ${matrix.budgets.missed.join(', ')}. Experimental only; do not adopt.` },
    queries: run.queries,
  };
}

export function formatDiscoveryEvalSummary(report: DiscoveryEvalReport): string {
  const m = report.metrics;
  return [
    `Discovery evaluation: ${report.configuration.backend}:${report.configuration.strategy}`,
    `Corpus: ${report.corpus.query_count} queries (${report.corpus.path})`, '',
    'Metric                Value', `Hit@1                 ${m.hit_at_1.toFixed(4)}`, `Hit@3                 ${m.hit_at_3.toFixed(4)}`,
    `Hit@5                 ${m.hit_at_5.toFixed(4)}`, `MRR                   ${m.mrr.toFixed(4)}`, `nDCG@10               ${m.ndcg_at_10.toFixed(4)}`,
    `Hard-negative@5       ${m.hard_negative_intrusion_at_5.toFixed(4)}`, `p50 latency           ${report.performance.p50_latency_ms.toFixed(3)} ms`,
    `p95 latency           ${report.performance.p95_latency_ms.toFixed(3)} ms`, `Index bytes           ${report.performance.index_bytes}`,
    `Peak resident memory  ${report.performance.peak_resident_memory_bytes}`, '', 'Per-type Hit@3:',
    ...Object.entries(m.per_type_recall_at_3).map(([type, value]) => `  ${type.padEnd(10)} ${value.toFixed(4)}`), '',
    `Decision: ${report.adoption_gate.decision}`,
    ...(report.experimental_graph ? [
      'Historical 80-query partition: not identified',
      `Graph storage ratio: ${report.experimental_graph.measurements.storage_ratio.toFixed(3)}`,
      `Incremental RSS bytes: ${report.experimental_graph.measurements.incremental_rss_bytes}`,
      `Graph construction: ${report.experimental_graph.measurements.construction_ms} ms`,
      `Resource budgets: ${report.experimental_graph.budgets.passed ? 'pass' : `MISSED: ${report.experimental_graph.budgets.missed.join(', ')}`}`,
      ...report.experimental_graph.runs.map(run => `${run.strategy} seed=${run.seed ?? 'none'} Hit@3=${run.metrics.hit_at_3} MRR=${run.metrics.mrr} warm p95=${run.warm_p95_latency_ms} ms`),
      ...report.experimental_graph.limitations,
    ] : []),
  ].join('\n');
}
