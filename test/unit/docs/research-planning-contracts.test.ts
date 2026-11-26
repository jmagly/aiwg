import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('research and planning contracts', () => {
  it('covers packets, budgets, resets, persistence, and provider adapters', () => {
    const doc = read('docs/context-engineering-contract.md');
    for (const value of ['Research induction', 'Research synthesis', 'Issue planning', 'SDLC planning', '70%', '85%', '95%', 'Claude Code', 'Codex', 'Generic fallback', 'artifact corpus']) expect(doc).toContain(value);
  });

  it('defines pass, fail, missing, and documentary checks in the schema', () => {
    const schema = JSON.parse(read('agentic/code/frameworks/sdlc-complete/schemas/verification-contract.schema.json'));
    expect(schema.required).toEqual(['expected_artifacts', 'checks', 'completion_evidence']);
    expect(schema.properties.checks.minItems).toBe(1);
    expect(schema.properties.checks.items.properties.kind.enum).toEqual(['command', 'documentary', 'review']);
    expect(schema.properties.completion_evidence.items.properties.status.enum).toEqual(['pass', 'fail', 'missing']);
  });

  it('covers decision dimensions, human roles, and four scenarios', () => {
    const doc = read('docs/autonomy-and-human-roles.md');
    for (const value of ['ambiguity', 'reversibility', 'architectural consequence', 'familiarity', 'testability', 'data sensitivity', 'external side effects', 'Autonomous', 'Supervised', 'Interactive', 'Human-owned', 'Director', 'Operator', 'Reviewer', 'generated index', 'cross-service architecture', 'research synthesis', 'Publishing, deploying']) expect(doc).toContain(value);
  });

  it('links contracts from research, planning, model routing, and loops', () => {
    expect(read('agentic/code/frameworks/research-complete/skills/induct-research/SKILL.md')).toContain('verification contract');
    expect(read('agentic/code/frameworks/sdlc-complete/skills/issue-planner/SKILL.md')).toContain('autonomy and human roles');
    expect(read('docs/models/hybrid-architectures.md')).toContain('autonomy classification');
    expect(read('agentic/code/addons/agent-loop/README.md')).toContain('cannot override human-owned');
  });

  it('maps all five memory-update constraints to existing owners with resolvable local references (#3318)', () => {
    const file = 'docs/decision/memory-update-controls.md';
    const doc = read(file);
    expect(read('docs/decision/README.md')).toContain('(memory-update-controls.md)');
    const map = doc.split('## Constraint-to-owner map')[1]?.split('\n## ')[0] ?? '';
    for (const id of ['C1', 'C2', 'C3', 'C4', 'C5']) expect(map).toMatch(new RegExp(`\\| ${id} \\|`));
    for (const issue of ['#3282', '#3283', '#3284', '#3285']) expect(map).toContain(issue);
    const links = [...doc.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]).filter(link => !/^https?:/.test(link));
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) expect(existsSync(resolve(dirname(resolve(file)), link.split('#')[0])), link).toBe(true);
  });

  it('specifies held-out controls, content shuffling, retention and independent gates (#3318)', () => {
    const doc = read('docs/decision/memory-update-controls.md');
    const plan = (doc.split('## H5 experiment plan (proposed)')[1]?.split('\n## ')[0] ?? '').replace(/\s+/g, ' ');
    for (const arm of ['frozen', 'updating', 'shuffled-memory', 'no-memory']) expect(plan).toContain(`| ${arm} |`);
    for (const requirement of [/held-out/i, /derangement/i, /earlier tasks/i, /R_after - R_before/,
      /ground.truth/i, /confidence interval/i, /stop/i, /no updates during evaluation/i]) expect(plan).toMatch(requirement);
  });

  it('maps the 2026-11-16 follow-ups onto the same owners and H5 plan (#3318)', () => {
    const doc = read('docs/decision/memory-update-controls.md');
    const map = doc.split('## Constraint-to-owner map')[1]?.split('\n## ')[0] ?? '';
    for (const id of ['C6', 'C7', 'C8', 'C9', 'C10', 'C11']) expect(map).toMatch(new RegExp(`\\| ${id} \\|`));
    for (const phrase of ['trusted head', 'negative evidence', 'maturity-aware', 'integrity conformance',
      'REF-3177', 'REF-3181', 'not deployment defaults']) expect(doc.toLowerCase()).toContain(phrase.toLowerCase());
    const plan = doc.split('## H5 experiment plan (proposed)')[1]?.split('\n## ')[0] ?? '';
    for (const phrase of ['unconditional', 'stale predecessor', 'replayed predecessor', 'concurrent conflicting updates',
      'rejected evidence', 'incomplete write', 'rollback recovery', 'negative transfer']) {
      expect(plan.toLowerCase()).toContain(phrase.toLowerCase());
    }
    expect(plan).toContain('retention_delta_pp');
    expect(plan).toContain('| shuffled-memory |');
  });

  it('separates research claims from observations and keeps edits versioned and reversible (#3318)', () => {
    const doc = read('docs/decision/memory-update-controls.md');
    for (const requirement of [/whole-prompt rewrites/i, /rollback/i, /precondition/,
      /contradictions/i, /drift/i, /activation/i, /not independently verified/i,
      /REF-1545/, /REF-2588/, /REF-2633/, /REF-1658/, /REF-1656/, /REF-2922/, /REF-2528/, /REF-2933/, /REF-785/]) {
      expect(doc).toMatch(requirement);
    }
  });
});
