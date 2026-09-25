import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Keeps DAG-* test IDs unique and the acceptance/TV-22 map in the docs pointing at real tests.
const root = resolve(import.meta.dirname, '../../..');
const suites = readdirSync(import.meta.dirname).filter(name => /^graph-.*\.test\.ts$/.test(name));
const declared = suites.flatMap(name => [...readFileSync(join(import.meta.dirname, name), 'utf8')
  .matchAll(/\bit(?:\.each\([^)]*\)|\.skipIf\([^)]*\))?\(\s*'(DAG-\d{3}[a-z]?) /g)].map(match => match[1]!));
const doc = readFileSync(join(root, 'docs/decision/dependent-graphs.md'), 'utf8');
const table = doc.slice(doc.indexOf('## Acceptance traceability'));

describe('DAG test identity and traceability', () => {
  it('DAG-058 declares every DAG test ID once and maps all 13 criteria plus TV-22 to existing tests', () => {
    expect(declared.length).toBeGreaterThan(50);
    expect(declared.filter((id, index) => declared.indexOf(id) !== index)).toEqual([]);
    for (let criterion = 1; criterion <= 13; criterion++) expect(table).toMatch(new RegExp(`^\\| AC${criterion} \\|`, 'm'));
    expect(table).toMatch(/^\| TV-22 \|/m);
    const cited = [...table.matchAll(/DAG-\d{3}[a-z]?/g)].map(match => match[0]);
    expect(cited.length).toBeGreaterThan(30);
    expect(cited.filter(id => !declared.includes(id))).toEqual([]);
  });
});
