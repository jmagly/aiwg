// Verify pinned query recovery and the deterministic downstream executor's evidence boundary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGraphIndexDir } from '../../../src/artifacts/types.js';
import { parseDiscoveryRelevanceJsonl, calculateDiscoveryMetrics } from '../../../src/artifacts/discovery-eval.js';
import { buildDiscoveryGraph, controlDiscoveryGraph } from '../../../src/artifacts/discovery-graph.js';
import { compileConfiguration, digest, evaluateDownstream } from '../../../tools/benchmarks/discovery-research-downstream.mjs';

const fixtures = path.resolve(import.meta.dirname, '../../fixtures/artifacts');
let root: string;
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('pinned historical discovery fixture', () => {
  it('recovers all original bytes, eight types and 80 queries without rewriting current labels', () => {
    const raw = fs.readFileSync(path.join(fixtures, 'discovery-relevance-80.jsonl'));
    expect(digest(raw)).toBe('sha256:dbffb0e626ae37c89f082a6eaf5a7924331fa676a4d65414b088162ee23bd7c5');
    const records = parseDiscoveryRelevanceJsonl(raw.toString());
    expect(records).toHaveLength(80);
    const counts = Object.groupBy(records, record => record.target_type);
    expect(Object.keys(counts)).toHaveLength(8);
    expect(Object.values(counts).every(rows => rows?.length === 10)).toBe(true);
    const metrics = calculateDiscoveryMetrics(records, records.map(record => [{ id: record.relevant_ids[0], type: record.target_type, name: '', score: 1 }]));
    expect(Object.values(metrics.per_type_recall_at_3).filter(value => value !== null)).toEqual(Array(8).fill(1));
    expect(Object.values(metrics.per_type_recall_at_3).filter(value => value === null)).toHaveLength(5);
    expect(metrics.mrr).toBe(1);
  });
});

describe('evidence-to-configuration downstream sample', () => {
  it('uses raw evidence rather than a contradictory summary', () => {
    expect(compileConfiguration({ fields: ['port'] }, [
      { kind: 'derived', facts: { port: 1 } }, { kind: 'source', facts: { port: 8100 } },
    ])).toEqual({ status: 'compiled', configuration: { port: 8100 } });
  });
  it('abstains on missing evidence or conflicting raw sources', () => {
    expect(compileConfiguration({ fields: ['port'] }, [{ kind: 'derived', facts: { port: 1 } }]))
      .toMatchObject({ status: 'abstain', reason: 'missing-source' });
    expect(compileConfiguration({ fields: ['port'] }, [
      { kind: 'source', facts: { port: 1 } }, { kind: 'source', facts: { port: 2 } },
    ])).toMatchObject({ status: 'abstain', reason: 'contradiction' });
  });
  it('executes every strategy with fixed budgets and verifies source digests', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-discovery-task-'));
    for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) vi.stubEnv(key, path.join(root, key));
    for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
      'AIWG_PROJECT_LOCAL_PATHS', 'AIWG_FRAMEWORK_INDEX_CACHE', 'AIWG_FRAMEWORK_INDEX_CACHE_SOURCE']) vi.stubEnv(key, '');
    vi.stubEnv('AIWG_ROOT', path.join(root, 'runtime')); vi.stubEnv('AIWG_CONFIG', path.join(root, 'config'));
    const fixtureDir = path.join(root, 'sources'); fs.cpSync(path.join(fixtures, 'discovery-downstream'), fixtureDir, { recursive: true });
    const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'sample.json'), 'utf8'));
    const entries = fixture.documents.map((doc: { path: string; name: string; type: string; summary: string }) => ({ ...doc,
      title: doc.name, capability: doc.summary, phase: '', tags: [], created: '', updated: '', checksum: '', dependencies: [], dependents: [] }));
    const dir = getGraphIndexDir(root, 'project'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ entries: Object.fromEntries(entries.map((entry: { path: string }) => [entry.path, entry])), experimentalGraph: fixture.graph }));
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    const input = { cwd: root, fixture, fixtureDir, entries, graphInput: fixture.graph };
    const first = await evaluateDownstream(input);
    const second = await evaluateDownstream(input);
    const stable = (value: typeof first) => value.runs.map((run: { tasks: Array<Record<string, unknown>> }) => ({ ...run,
      tasks: run.tasks.map(({ latency_ms: _time, ...task }) => task) }));
    expect(stable(second)).toEqual(stable(first));
    expect(first.runs).toHaveLength(11);
    expect(first.runs.every((run: { task_count: number; unsupported_conclusions: number }) => run.task_count === 12 && run.unsupported_conclusions === 0)).toBe(true);
    for (const run of first.runs) for (const task of run.tasks) {
      expect(task.searches).toBeLessThanOrEqual(1); expect(task.source_reads).toBeLessThanOrEqual(3);
      expect(task.source_bytes).toBeLessThanOrEqual(4096); expect(task.reasoning_passes).toBe(1);
    }
    expect(first.runs.find((run: { strategy: string }) => run.strategy === 'organized-document').correct_compilations).toBe(4);
    expect(first.runs.find((run: { strategy: string }) => run.strategy === 'no-memory').correct_compilations).toBe(0);
    const graph = buildDiscoveryGraph(entries, fixture.graph);
    expect(graph.edges.length).toBeGreaterThan(0);
    const keys = (edges: typeof graph.edges) => edges.map(edge => JSON.stringify([edge.source, edge.target].sort()));
    for (const seed of [3319, 4239, 1819]) for (const control of ['degree-matched-random', 'shuffled-graph'] as const) {
      expect(keys(controlDiscoveryGraph(graph, control, seed).edges)).not.toEqual(keys(graph.edges));
    }
    expect(fetch).not.toHaveBeenCalled();
    fs.appendFileSync(path.join(fixtureDir, fixture.documents[0].path), ' ');
    await expect(evaluateDownstream(input)).rejects.toThrow(/Source changed/);
  });
});
