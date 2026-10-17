import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  calculateDiscoveryMetrics,
  DISCOVERY_EVAL_SCHEMA,
  parseDiscoveryRelevanceJsonl,
  validateOperationalCoverage,
  type DiscoveryRelevanceQuery,
  type RankedDiscoveryItem,
} from '../../../src/artifacts/discovery-eval.js';

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
    expect(records).toHaveLength(139);
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
