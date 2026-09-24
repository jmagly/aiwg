import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRuleset, evaluatePredicate, executeQualificationPlan, verifyQualificationArtifacts,
  type DecisionRuleset, type QualificationCaseExecutor } from '../../../src/decision/index.js';
import { DecisionValidationError } from '../../../src/decision/validate.js';

const fixture = async (name: string): Promise<DecisionRuleset> =>
  JSON.parse(await readFile(`examples/decision/${name}`, 'utf8')) as DecisionRuleset;
const always = { op: 'exists', left: { source: 'input', pointer: '' } } as const;
const CASE_IDS = ['C19', 'C20', 'C21', 'C22', 'C23', 'C40'] as const;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const executors: Record<(typeof CASE_IDS)[number], QualificationCaseExecutor> = {
  C19: async () => {
    const rules = await fixture('ruleset.json');
    rules.spec.rules = [
      { id: 'a', priority: 100, when: always, outcome: 'docs-review' },
      { id: 'b', priority: 100, when: always, outcome: 'runtime-review' },
    ];
    const result = composeRuleset(rules, {}, {});
    assert.equal(result.status, 'review');
    assert.equal(result.reason, 'conflicting-outcomes');
    assert.equal(result.outcome, 'manual-review');
    return { outcome: 'pass' };
  },
  C20: async () => {
    const rules = await fixture('ruleset.json');
    rules.spec.rules = [
      { id: 'a', priority: 100, when: always, outcome: 'docs-review' },
      { id: 'b', priority: 100, when: always, outcome: 'docs-review' },
    ];
    const result = composeRuleset(rules, {}, {});
    assert.equal(result.status, 'completed');
    assert.equal(result.outcome, 'docs-review');
    assert.deepEqual(result.matchedRules, ['a', 'b']);
    return { outcome: 'pass' };
  },
  C21: async () => {
    const rules = await fixture('ruleset.json');
    rules.spec.rules = [{ id: 'never', priority: 100,
      when: { op: 'eq', left: { source: 'input', pointer: '/flag' }, right: true }, outcome: 'docs-review' }];
    const result = composeRuleset(rules, { flag: false }, {});
    assert.equal(result.outcome, 'manual-review');
    assert.deepEqual(result.matchedRules, []);
    return { outcome: 'pass' };
  },
  C22: async () => {
    const rules = await fixture('ruleset-collect.json');
    rules.spec.rules = [
      { id: 'z', priority: 50, when: always, outcome: 'docs-review' },
      { id: 'b', priority: 100, when: always, outcome: 'runtime-review' },
      { id: 'a', priority: 100, when: always, outcome: 'manual-review' },
    ];
    const result = composeRuleset(rules, {}, {});
    assert.deepEqual(result.outcome, ['manual-review', 'runtime-review', 'docs-review']);
    assert.deepEqual(result.matchedRules, ['a', 'b', 'z']);
    return { outcome: 'pass' };
  },
  C23: async () => {
    const predicate = { op: 'eq', left: { source: 'input', pointer: '/missing' }, right: 1 } as const;
    assert.equal(evaluatePredicate(predicate, {}, {}), 'unknown');
    const rules = await fixture('ruleset.json');
    rules.spec.rules = [{ id: 'unknown', priority: 100, when: predicate, outcome: 'docs-review' }];
    const result = composeRuleset(rules, {}, {});
    assert.deepEqual(result.matchedRules, []);
    assert.equal(result.outcome, 'manual-review');
    return { outcome: 'pass' };
  },
  C40: async () => {
    const rules = await fixture('ruleset-collect.json');
    rules.spec.rules = [
      { id: 'a', priority: 100, when: always, outcome: 'docs-review' },
      { id: 'b', priority: 50, when: always, outcome: 'runtime-review' },
    ];
    rules.spec.outputSchema = { ...rules.spec.outputSchema, maxItems: 1 };
    assert.throws(() => composeRuleset(rules, {}, {}), DecisionValidationError);
    return { outcome: 'pass' };
  },
};

describe('C19-C23/C40 executable offline rule vectors', () => {
  it('asserts conflict, default, collect ordering and unknown predicates before writing evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'decision-rule-vectors-'));
    roots.push(root);
    const run = await executeQualificationPlan({ artifactRoot: root, executors,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'rule-vectors',
        generatedAt: '2026-09-23T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true,
        cases: CASE_IDS.map(id => ({ id, kind: 'baseline' as const, mandatory: true,
          candidateTests: ['test/conformance/decision-v1/rule-vectors.test.ts'] })) },
    });
    expect(run.evidence.map(item => [item.caseId, item.outcome])).toEqual(CASE_IDS.map(id => [id, 'pass']));
    expect((await verifyQualificationArtifacts(run, root)).every(item => item.verified)).toBe(true);
  });
});
