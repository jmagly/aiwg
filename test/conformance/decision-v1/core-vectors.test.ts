import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeQualificationPlan, JevDecisionAdapter, verifyQualificationArtifacts,
  type DecisionAdapterRequest, type DecisionBinding, type DecisionDefinition,
  type QualificationCaseExecutor,
} from '../../../src/decision/index.js';

const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(`examples/decision/${name}`, 'utf8')) as T;
const CASE_IDS = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07'] as const;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function evaluate(definitionFile: string, response: unknown) {
  const definition = await fixture<DecisionDefinition>(definitionFile);
  const binding = await fixture<DecisionBinding>('binding-jev.json');
  const request: DecisionAdapterRequest = {
    alias: 'category', definition, input: await fixture('input.json'),
    target: binding.spec.evaluations.category!.targets[0]!, invocationId: 'core-vectors',
    deadlineEpochMs: Date.now() + 10_000, signal: new AbortController().signal,
    resolveCredential: async () => new TextEncoder().encode('synthetic-credential'),
  };
  return new JevDecisionAdapter({ fetch: async () => new Response(JSON.stringify(response)) }).evaluate(request);
}
const reply = (answer: unknown) => ({ model: 'jev-fixture', answers: { category: answer }, usage: { input_tokens: 1, output_tokens: 1 } });
const choice = (overrides: Record<string, unknown> = {}) => ({ type: 'choice', choice: 'documentation', confidence: 0.9,
  probabilities: { documentation: 0.9, runtime: 0.1, other: 0 }, ...overrides });

const executors: Record<(typeof CASE_IDS)[number], QualificationCaseExecutor> = {
  C01: async () => {
    const result = await evaluate('decision-category.json', reply(choice()));
    assert.equal(result.status, 'success'); assert.equal(result.value, 'documentation');
    assert.deepEqual(result.uncertainty?.distribution, choice().probabilities);
    return { outcome: 'pass' };
  },
  C02: async () => {
    const definition = await fixture<DecisionDefinition>('decision-severity.json');
    const result = await evaluate('decision-severity.json', reply({ type: 'score', score: 1, confidence: 0.8,
      probabilities: { 0: 0.25, 1: 0.5, 2: 0.25 }, legend: Object.fromEntries(definition.spec.answer.kind === 'ordinal-score'
        ? definition.spec.answer.levels.map((level, index) => [String(index), level]) : []),
    }));
    assert.equal(result.status, 'success'); assert.equal(result.value, 1);
    assert.deepEqual(result.uncertainty?.distribution, { 0: 0.25, 1: 0.5, 2: 0.25 });
    return { outcome: 'pass' };
  },
  C03: async () => {
    const result = await evaluate('decision-core_unavailable.json', reply({ type: 'noul', noul: 0.5 }));
    assert.equal(result.status, 'success'); assert.equal(result.value, 0.5);
    assert.equal(result.uncertainty?.profile, 'typesafe-truth-v1');
    return { outcome: 'pass' };
  },
  C04: async () => {
    const result = await evaluate('decision-category.json', reply(choice({ choice: 'unknown' })));
    assert.equal(result.status, 'error'); assert.equal(result.reason, 'invalid-output');
    return { outcome: 'pass' };
  },
  C05: async () => {
    for (const probability of [NaN, Infinity, -0.1, 1.1]) {
      const result = await evaluate('decision-category.json', reply(choice({ probabilities: {
        documentation: probability, runtime: 0.1, other: 0,
      } })));
      assert.equal(result.reason, 'invalid-output');
    }
    return { outcome: 'pass' };
  },
  C06: async () => {
    for (const probabilities of [{ documentation: 1 }, { documentation: 0.3, runtime: 0.2, other: 0 }]) {
      const result = await evaluate('decision-category.json', reply(choice({ probabilities })));
      assert.equal(result.reason, 'invalid-output');
    }
    return { outcome: 'pass' };
  },
  C07: async () => {
    for (const answers of [{ wrong: choice() }, { category: choice(), extra: choice() }, {}]) {
      const result = await evaluate('decision-category.json', { model: 'jev-fixture', answers });
      assert.equal(result.reason, 'invalid-output');
    }
    return { outcome: 'pass' };
  },
};

describe('C01-C07 executable offline transport vectors', () => {
  it('asserts each exact primitive outcome or invalid-output class before writing evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'decision-core-vectors-'));
    roots.push(root);
    const run = await executeQualificationPlan({
      artifactRoot: root, executors,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'core-vectors',
        generatedAt: '2026-09-23T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true,
        cases: CASE_IDS.map(id => ({ id, kind: 'baseline' as const, mandatory: true,
          candidateTests: ['test/conformance/decision-v1/core-vectors.test.ts'] })) },
    });
    expect(run.evidence.map(item => [item.caseId, item.outcome])).toEqual(CASE_IDS.map(id => [id, 'pass']));
    expect((await verifyQualificationArtifacts(run, root)).every(item => item.verified)).toBe(true);
  });
});
