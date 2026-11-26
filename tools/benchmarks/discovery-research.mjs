// Reproduce #3319 locally with pinned queries, isolated caches, and no providers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const historicalPath = 'test/fixtures/artifacts/discovery-relevance-80.jsonl';
const historicalDigest = 'sha256:dbffb0e626ae37c89f082a6eaf5a7924331fa676a4d65414b088162ee23bd7c5';
const historicalSource = '5e8940b81:test/fixtures/artifacts/discovery-relevance.jsonl';
globalThis.fetch = () => { throw new Error('Network disabled in offline evaluation'); };

if (process.argv[2] === '--cold') {
  const { currentRank } = await import('../../src/artifacts/discovery-eval.ts');
  const query = JSON.parse(process.argv[4]);
  const start = performance.now();
  const results = await currentRank(process.argv[3], query, 'local', 10, process.argv[5] === 'graph');
  console.log(JSON.stringify({ operation_ms: performance.now() - start, peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    cpu_microseconds: process.cpuUsage(), result_ids: results.map(item => item.id) }));
} else {
  const output = path.resolve(process.argv[2] ?? path.join(root, '.worker/evidence/discovery-research.json'));
  if (!output.startsWith(`${root}${path.sep}`)) throw new Error('Results must stay inside the worktree');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-discovery-research-'));
  const previous = { ...process.env };
  try {
    // No operator home, provider settings, external artifact root, or shared index cache.
    for (const key of ['HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
      process.env[key] = path.join(scratch, key); fs.mkdirSync(process.env[key], { recursive: true });
    }
    for (const key of ['CODEX_HOME', 'AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
      'AIWG_PROJECT_LOCAL_PATHS', 'AIWG_FRAMEWORK_INDEX_CACHE', 'AIWG_FRAMEWORK_INDEX_CACHE_SOURCE', 'AIWG_CONFIG_LAYERS']) delete process.env[key];
    process.env.AIWG_CONFIG = path.join(scratch, 'config');
    process.env.AIWG_ROOT = root;
    const { buildIndex } = await import('../../src/artifacts/index-builder.ts');
    const { getGraphIndexDir } = await import('../../src/artifacts/types.ts');
    const { parseDiscoveryRelevanceJsonl, currentRank, calculateDiscoveryMetrics } = await import('../../src/artifacts/discovery-eval.ts');
    const { measureDiscoveryGraphMatrix } = await import('../../src/artifacts/discovery-graph-eval.ts');
    const { evaluateDownstream } = await import('./discovery-research-downstream.mjs');
    const text = fs.readFileSync(path.join(root, historicalPath));
    if (sha(text) !== historicalDigest) throw new Error('Pinned 80-query fixture changed');
    const records = parseDiscoveryRelevanceJsonl(text.toString());
    if (records.length !== 80) throw new Error('Expected original 80 queries');
    const indexStart = performance.now();
    await buildIndex(root, { graph: 'framework', explicit: false, quiet: true });
    const indexBuildMs = performance.now() - indexStart;
    const builtDir = getGraphIndexDir(root, 'framework');
    const project = path.join(scratch, 'project'); fs.mkdirSync(project);
    // Replay an unmodified current-corpus snapshot through the cached-local discovery path.
    process.env.AIWG_ROOT = path.join(scratch, 'runtime');
    const replayDir = getGraphIndexDir(project, 'framework');
    fs.mkdirSync(path.dirname(replayDir), { recursive: true });
    fs.cpSync(builtDir, replayDir, { recursive: true });
    const metadata = fs.readFileSync(path.join(replayDir, 'metadata.json'));
    const index = JSON.parse(metadata);
    const indexFiles = fs.readdirSync(replayDir).filter(file => fs.statSync(path.join(replayDir, file)).isFile())
      .map(file => ({ path: file, bytes: fs.statSync(path.join(replayDir, file)).size,
        digest: sha(fs.readFileSync(path.join(replayDir, file))) }));
    const matrix = await measureDiscoveryGraphMatrix({ cwd: project, records, limit: 10,
      historical80QueryPartition: `${historicalSource} (${historicalDigest})`,
      lexicalIndexBytes: indexFiles.reduce((sum, file) => sum + file.bytes, 0), metrics: calculateDiscoveryMetrics,
      lexicalRank: (record, limit) => currentRank(project, record, 'local', limit),
      graphRank: (record, limit) => currentRank(project, record, 'local', limit, true) });
    // Fresh Node processes include module loading; page-cache eviction is deliberately absent.
    const cold = [];
    for (const strategy of ['lexical', 'graph']) for (const id of ['skill-01', 'rule-02', 'flow-02']) {
      const record = records.find(item => item.id === id);
      const start = performance.now();
      const observed = JSON.parse(execFileSync(process.execPath,
        ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url), '--cold', project, JSON.stringify(record), strategy],
        { cwd: project, env: process.env, encoding: 'utf8', timeout: 60_000 }));
      cold.push({ strategy, query_id: id, process_wall_ms: performance.now() - start, ...observed });
    }
    const fixtureDir = path.join(root, 'test/fixtures/artifacts/discovery-downstream');
    const fixtureText = fs.readFileSync(path.join(fixtureDir, 'sample.json'));
    const fixture = JSON.parse(fixtureText);
    const entries = fixture.documents.map(doc => ({ path: doc.path, name: doc.name, title: doc.name,
      type: doc.type, summary: doc.summary, capability: doc.summary, phase: '', tags: [],
      created: '', updated: '', checksum: doc.digest, dependencies: [], dependents: [] }));
    const projectDir = getGraphIndexDir(project, 'project'); fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'metadata.json'), JSON.stringify({ entries: Object.fromEntries(entries.map(entry => [entry.path, entry])), experimentalGraph: fixture.graph }));
    const downstream = await evaluateDownstream({ cwd: project, fixture, fixtureDir, entries, graphInput: fixture.graph });
    const nonTiming = result => result.runs.map(run => ({ strategy: run.strategy, seed: run.seed,
      metrics: run.metrics, changed_edges: run.changed_edges, queries: run.queries.map(query => ({ id: query.id, results: query.results })) }));
    const paired = matrix.runs[1].queries.map((query, i) => ({ id: query.id,
      reciprocal_rank_delta: query.reciprocal_rank - matrix.runs[0].queries[i].reciprocal_rank,
      same_results: JSON.stringify(query.results) === JSON.stringify(matrix.runs[0].queries[i].results) }));
    const report = { issue: 3319, command: 'nice -n 19 node --import tsx tools/benchmarks/discovery-research.mjs',
      source_commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      fixture: { path: historicalPath, digest: historicalDigest, source: historicalSource, queries: records.length },
      corpus: { metadata_digest: sha(metadata), entry_count: Object.keys(index.entries).length,
        index_build_ms: indexBuildMs, index_files: indexFiles, supplied_graph_observations: Boolean(index.experimentalGraph) },
      matrix, paired, cold, downstream_fixture_digest: sha(fixtureText), downstream,
      non_timing_matrix_digest: sha(JSON.stringify(nonTiming(matrix))),
      limitations: ['Current corpus snapshot, not the historical July corpus or an exact reproduction of its metrics.',
        'Cached-local mode: both paths use noBuild=true and per-query fixture type filters; this isolates ranking, not full default CLI startup/reconciliation.',
        'Cold observations are fresh Node/tsx processes with warm filesystem cache, three distinct queries per strategy; no cold p95 claim.',
        'No live provider, paid call, external embedding, human annotation, or causal capability-improvement claim.'] };
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ output: path.relative(root, output), lexical: matrix.runs[0].metrics,
      graph: matrix.runs[1].metrics, budgets: matrix.budgets,
      downstream: downstream.runs.map(({ strategy, success_count, task_count }) => ({ strategy, success_count, task_count })) }));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); fs.rmSync(scratch, { recursive: true, force: true });
  }
}
