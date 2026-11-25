// Freeze the offline pilot and check literal body support before metadata changes.
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const arms = ['unchanged', 'body-only', 'neighbour-aware', 'current-discover'];
export const original = ({ id, name, description, bodyHash }) => ({ id, name, description, bodyHash });
const assert = (condition, message) => { if (!condition) throw new Error(message); };

export function validateSnapshot(data) {
  const { skills, tasks, protocol } = data;
  assert(skills.length > 0 && tasks.length > 0, 'empty snapshot');
  assert(new Set(skills.map(s => s.id)).size === skills.length, 'duplicate identity');
  assert(new Set(skills.map(s => s.name)).size === skills.length, 'duplicate name');
  assert(new Set(tasks.map(t => t.id)).size === tasks.length, 'duplicate task');
  const incoming = skills.filter(s => s.cohort === 'new').map(s => s.id).sort();
  assert(incoming.length > 0 && skills.some(s => s.cohort === 'old'), 'missing cohorts');
  assert(Object.keys(protocol.streams).sort().join() === 'confusable,natural-random', 'missing streams');
  for (const sequence of Object.values(protocol.streams)) {
    assert(JSON.stringify([...sequence].sort()) === JSON.stringify(incoming), 'incomplete insertion sequence');
  }
  for (const key of ['limit', 'contextCharacters', 'executionSteps']) {
    assert(Number.isInteger(protocol[key]) && protocol[key] > 0, `invalid budget ${key}`);
  }
  for (const skill of skills) {
    assert(/^[a-z0-9-]+$/.test(skill.id) && skill.name === skill.id, 'invalid identity');
    assert(['old', 'new'].includes(skill.cohort), 'invalid cohort');
    assert(digest(skill.body) === skill.bodyHash, `body hash drift: ${skill.id}`);
    for (const arm of ['body-only', 'neighbour-aware']) refineIncoming(skill, [], arm);
  }
  const ids = new Set(skills.map(s => s.id));
  for (const task of tasks) {
    assert(task.required.length > 0 && task.required.every(id => ids.has(id)), 'unknown required identity');
    assert(new Set(task.required).size === task.required.length, 'duplicate requirement');
    assert(task.steps.length > 0 && task.steps.length <= protocol.executionSteps, 'execution budget exceeded');
    assert(task.validationCases.length >= 2, 'independent validation cases required');
    for (const [id, alternatives] of Object.entries(task.alternatives)) {
      assert(task.required.includes(id) && alternatives.every(other => ids.has(other) && other !== id), 'invalid alternative');
    }
  }
}

export function refineIncoming(skill, neighbours, arm) {
  // Literal clauses avoid claiming a semantic fidelity validator for arbitrary prose.
  const clauses = arm === 'body-only' ? skill.bodyOnly : skill.refined;
  const supported = new Set(skill.body.split('\n').filter(line => line.startsWith('// ')).map(line => line.slice(3)));
  assert(Array.isArray(clauses) && clauses.length > 0 && clauses.every(line => supported.has(line)),
    `unsupported capability or exclusion: ${skill.id}`);
  const basis = neighbours.map(original);
  // Compare against original descriptions only; prefer the least redundant supported
  // capability, keeping supported exclusions. No held-out task or rewritten neighbour enters here.
  const words = new Set(basis.flatMap(s => s.description.toLowerCase().match(/[a-z]+/g) ?? []));
  const novelty = clause => (clause.toLowerCase().match(/[a-z]+/g) ?? []).filter(word => !words.has(word)).length;
  const selected = arm === 'body-only' ? clauses : [...clauses].sort((a, b) => novelty(b) - novelty(a) || a.localeCompare(b));
  return { description: selected.join(' '), basis, bodyHash: skill.bodyHash };
}

export function interval(passed, count) {
  if (!count) return null;
  const z = 1.959963984540054, p = passed / count, d = 1 + z * z / count;
  const centre = (p + z * z / (2 * count)) / d;
  const margin = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / d;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

export function summarize(queries) {
  const result = {};
  for (const stratum of ['old-only', 'new-only', 'mixed']) {
    const rows = queries.filter(q => q.stratum === stratum);
    const metric = predicate => {
      const passed = rows.filter(predicate).length;
      return { passed, count: rows.length, rate: rows.length ? passed / rows.length : null,
        interval: interval(passed, rows.length), uncertainty: 'Wilson 95%; descriptive only, repeated synthetic tasks are dependent' };
    };
    result[stratum] = { strict: metric(q => q.strict), functional: metric(q => q.functional),
      execution: metric(q => q.execution.status === 'passed') };
  }
  return result;
}
