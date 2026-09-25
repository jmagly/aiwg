import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  composeRuleset, evaluatePredicate, type DecisionRuleset, type QualificationCaseExecutor,
} from '../../../../src/decision/index.js';
import { DecisionValidationError } from '../../../../src/decision/validate.js';

const fixture = async (name: string): Promise<DecisionRuleset> =>
  JSON.parse(await readFile(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as DecisionRuleset;
const always = { op: 'exists', left: { source: 'input', pointer: '' } } as const;
export const CASE_IDS = ['C19', 'C20', 'C21', 'C22', 'C23', 'C40'] as const;

export const executors: Record<(typeof CASE_IDS)[number], QualificationCaseExecutor> = {
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
