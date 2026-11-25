import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateDiscoveryMetrics,
  DISCOVERY_EVAL_SCHEMA,
  parseDiscoveryRelevanceJsonl,
  validateOperationalCoverage,
  type DiscoveryRelevanceQuery,
  type RankedDiscoveryItem,
  evaluateDiscoveryGraphMatrix,
} from '../../../src/artifacts/discovery-eval.js';
import { getGraphIndexDir } from '../../../src/artifacts/types.js';

const fixturePath = path.resolve(import.meta.dirname, '../../fixtures/artifacts/discovery-relevance.jsonl');

function record(overrides: Partial<DiscoveryRelevanceQuery> = {}): DiscoveryRelevanceQuery {
  return {
    schema: DISCOVERY_EVAL_SCHEMA,
    id: 'q-1',
    query: 'preserve evidence',
    target_type: 'skill',
    relevant_ids: ['skill:evidence-preservation'],
    hard_negative_ids: ['skill:forensics-acquire'],
    query_class: 'capability',
    ...overrides,
  };
}

describe('operational discovery relevance fixture', () => {
  it('contains at least ten reviewed queries for every broad operational type', () => {
    const records = parseDiscoveryRelevanceJsonl(fs.readFileSync(fixturePath, 'utf8'));
    expect(records).toHaveLength(145);
    expect(() => validateOperationalCoverage(records)).not.toThrow();
    expect(new Set(records.map((item) => item.query_class))).toEqual(new Set([
      'exact-name',
      'capability',
      'process-step',
      'hard-negative',
      'cross-type',
    ]));
  });

  it('rejects malformed JSON', () => {
    expect(() => parseDiscoveryRelevanceJsonl('{not-json}\n')).toThrow(/malformed JSON/);
  });

  it('rejects duplicate query ids', () => {
    const line = JSON.stringify(record());
    expect(() => parseDiscoveryRelevanceJsonl(`${line}\n${line}\n`)).toThrow(/duplicate query id/);
  });

  it('rejects missing relevance labels', () => {
    expect(() => parseDiscoveryRelevanceJsonl(`${JSON.stringify({ ...record(), relevant_ids: [] })}\n`))
      .toThrow(/relevant_ids must be a non-empty string array/);
  });
});

describe('discovery relevance metrics', () => {
  it('emits deterministic metric output with stable per-type ordering', () => {
    const records = [
      record(),
      record({ id: 'q-2', target_type: 'agent', relevant_ids: ['agent:log analyst'] }),
    ];
    const results: RankedDiscoveryItem[][] = [
      [
        { id: 'other', type: 'skill', name: 'forensics-acquire', score: 1 },
        { id: 'wanted', type: 'skill', name: 'evidence-preservation', score: 0.8 },
      ],
      [{ id: 'wanted-agent', type: 'agent', name: 'Log Analyst', score: 1 }],
    ];
    const first = calculateDiscoveryMetrics(records, results);
    const second = calculateDiscoveryMetrics(records, results);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toMatchObject({
      query_count: 2,
      hit_at_1: 0.5,
      hit_at_3: 1,
      hit_at_5: 1,
      mrr: 0.75,
      ndcg_at_10: 0.815465,
    });
    expect(Object.keys(first.per_type_recall_at_3)).toEqual([
      'skill', 'agent', 'command', 'rule', 'schema',
      'decision-definition', 'decision-ruleset', 'decision-binding',
      'gate-pack', 'flow', 'runbook', 'template', 'behavior',
    ]);
  });
});

describe('offline graph matrix', () => {
  let root: string;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  it('evaluates all 145 rows with fixed controls and measured budgets without inventing edges', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-graph-eval-'));
    vi.stubEnv('AIWG_ROOT', path.join(root, 'runtime'));
    vi.stubEnv('AIWG_CONFIG', path.join(root, 'config'));
    vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
    vi.stubEnv('AIWG_FRAMEWORK_INDEX_CACHE', '');
    const index = path.join(getGraphIndexDir(root, 'framework'), 'metadata.json');
    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.writeFileSync(index, JSON.stringify({ entries: { probe: {
      path: 'probe', type: 'skill', name: 'probe', title: 'Probe', phase: '', tags: [],
      created: '', updated: '', checksum: '', dependencies: [], dependents: [],
      summary: 'Synthetic metadata padding for a realistic storage denominator. '.repeat(20),
    } } }));
    const report = await evaluateDiscoveryGraphMatrix({ cwd: root, fixturePath });
    expect(report.historical_80_query_partition).toBe('not identified');
    expect(report.seeds).toEqual([3319, 4239, 1819]);
    expect(report.runs.map(run => run.strategy)).toEqual([
      'lexical', 'graph', 'degree-matched-random', 'shuffled-graph',
      'degree-matched-random', 'shuffled-graph', 'degree-matched-random', 'shuffled-graph',
    ]);
    expect(report.runs.every(run => run.metrics.query_count === 145)).toBe(true);
    expect(report.graph.edges).toBe(0);
    expect(report.limitations.join(' ')).toMatch(/no supplied.*co-use/i);
    expect(report.measurements.warm_p95_latency_ms).toBeGreaterThanOrEqual(0);
    expect(report.measurements.storage_ratio).toBeGreaterThanOrEqual(1);
    expect(report.measurements.incremental_rss_bytes).toBeGreaterThanOrEqual(0);
    expect(report.budgets).toMatchObject({ latency_ms: 250, storage_ratio: 2, incremental_rss_bytes: 67108864 });
    expect(report.budgets.passed).toBe(true);
    expect(report.runs.every(run => JSON.stringify(run.metrics) === JSON.stringify(report.runs[0].metrics))).toBe(true);
    const missed = await evaluateDiscoveryGraphMatrix({ cwd: root, fixturePath, storageCeilingRatio: 1 });
    expect(missed.budgets.passed).toBe(false);
    expect(missed.budgets.missed).toContain('storage ratio');
    expect(missed.limitations.join(' ')).toMatch(/Budget missed: storage ratio/);
  });
});
