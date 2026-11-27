import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { loadRule } from '../../../src/lint/loader.js';
import { parseFrontmatter, runCheck } from '../../../src/lint/checks.js';

const root = path.resolve(import.meta.dirname, '../../..');
const framework = path.join(root, 'agentic/code/frameworks/sdlc-complete');
const fixture = (name: string) => path.join(root, 'test/fixtures/feature-flags', name);
const read = (p: string) => readFileSync(p, 'utf8');
const high = JSON.parse(read(fixture('high-risk.json')));
const docs = JSON.parse(read(fixture('docs-only.json')));
const helper = await import(path.join(framework, 'skills/feature-flag-plan/scripts/flag-plan.mjs'));
const { assess, plan, providerRoute, readCard, debt, readiness, validateCard } = helper;
const card = readCard(fixture('feature-toggle-card-payments.md'));

describe('feature flag fit and planning fixtures (#4432–#4435)', () => {
  it('plans high-risk production work with a decision, linked card and no vendor route', () => {
    const result = plan(high);
    expect(result.record).toMatchObject({ fit: 'recommend', decision: 'accepted', scope: 'US-PAY-9' });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toContain('REQ-PAY-12');
    expect(result.cards[0]).toContain('TASK-PAY-19');
    expect(result.route).toEqual({ mode: 'cards-and-code', skills: {} });
    expect(() => validateCard(card)).not.toThrow();
  });
  it('skips docs silently, even with a recommendation trigger', () => {
    expect(plan({ ...docs, facts: { ...high.facts, docs_only: true } }))
      .toMatchObject({ record: { fit: 'skip', suggestion: null }, cards: [] });
  });
  it.each(['prototype', 'spike', 'library_no_runtime', 'one_off_script', 'static_no_runtime_no_js', 'very_small'])
    ('silently skips %s', (key) => {
      expect(assess({ facts: { [key]: true } }).suggestion).toBeNull();
    });
  it.each(['trunk_unfinished', 'dark_launch', 'migration', 'experiment', 'entitlement', 'external_kill_switch', 'llm_runtime'])
    ('recommends for %s', (key) => expect(assess({ facts: { [key]: true } }).fit).toBe('recommend'));
  it('offers low-risk user-facing work once, default no; does not assume acceptance', () => {
    const result = plan({ scope: 'US-ui', facts: { user_facing: true, low_risk: true, infrequent_deploy: true } });
    expect(result.record).toMatchObject({ fit: 'offer', decision: 'pending' });
    expect(result.cards).toEqual([]);
    expect(assess({ facts: { user_facing: true } }).fit).toBe('skip');
  });
  it('honors project/scope decline and never policy; allows explicit reopening', () => {
    expect(plan({ ...high, declined: true }).cards).toEqual([]);
    expect(assess({ ...high, feature_flags: { policy: 'never' } }).suggestion).toBeNull();
    expect(plan({ ...high, decision: 'declined' })).toMatchObject({ cards: [], record: { declined: true } });
    expect(assess({ ...high, declined: false }).fit).toBe('recommend');
  });
  it.each(['secrets', 'static_config', 'data_store', 'startup_config', 'per_commit'])
    ('never flags %s, including under always policy', (item) => {
      expect(assess({ ...high, feature_flags: { policy: 'always' }, never_flags: [item] }).suggestion).toBeNull();
    });
  it('always requests planning only for eligible work', () => {
    expect(assess({ feature_flags: { policy: 'always' } }).fit).toBe('recommend');
    expect(assess({ ...docs, feature_flags: { policy: 'always' } }).fit).toBe('skip');
  });
  it('requires actual metadata, typed defaults and requirement links before rendering', () => {
    expect(() => plan({ ...high, cards: [] })).toThrow('requires cards');
    expect(() => plan({ ...high, requirements: ['REQ-OTHER'] })).toThrow('link');
    expect(() => validateCard({ ...card, owner: '<owner>' })).toThrow('owner');
    expect(() => validateCard({ ...card, removal_criteria: 'error rate <1%' })).not.toThrow();
    expect(() => validateCard({ ...card, default_value: 'false' })).toThrow('default_value');
    expect(() => validateCard({ ...card, review_by: '2026-02-30' })).toThrow('review_by');
    expect(() => assess({ feature_flags: { policy: 'sometimes' } })).toThrow('policy');
    expect(() => assess({ facts: { production: 'false' } })).toThrow('booleans');
  });
  it('routes only installed provider skills and leaves none/missing addon as a no-op', () => {
    expect(providerRoute('none', ['vendor'], { vendor: { create: 'vendor-create' } })).toEqual({ mode: 'cards-and-code', skills: {} });
    expect(providerRoute('vendor')).toMatchObject({ mode: 'cards-and-code', skills: {} });
    expect(providerRoute('openfeature')).toEqual({ mode: 'openfeature-client', skills: {} });
    expect(providerRoute('vendor', ['vendor'], { vendor: { create: 'vendor-create', rollout: 'vendor-rollout', cleanup: 'vendor-audit' } }))
      .toMatchObject({ mode: 'addon', skills: { create: 'vendor-create', rollout: 'vendor-rollout', cleanup: 'vendor-audit' } });
    expect(providerRoute('vendor', ['vendor'])).toEqual({ mode: 'addon', skills: {} });
  });
  it('fails readiness for each live flag with missing owner or removal criteria', () => {
    expect(readiness([card]).status).toBe('PASS');
    expect(readiness([{ ...card, owner: '' }, { ...card, removal_criteria: '' }])).toMatchObject({ status: 'FAIL', failures: [{ id: card.id }, { id: card.id }] });
    expect(readiness([{ ...card, live: false, owner: '' }]).status).toBe('PASS');
    expect(readiness([]).status).toBe('PASS');
  });
  it('reports debt from Markdown cards, optional dates and live counts against caps', () => {
    const result = debt([card, { ...card, id: 'FT-permanent', lifetime: 'permanent' }], '2026-11-26', { payments: 0, unused: 2 });
    expect(result.rows).toEqual([expect.objectContaining({ id: card.id, reasons: ['removal criteria met', 'past review-by'], stage: 'ready for code removal', removal_task: 'TASK-PAY-19' })]);
    expect(result.counts).toContainEqual({ service: 'payments', live_temporary: 1, cap: 0, over_cap: true });
    expect(result.counts).toContainEqual({ service: 'unused', live_temporary: 0, cap: 2, over_cap: false });
    expect(debt([{ ...card, code_removed: true, live: false }], '2026-11-26').rows[0].stage).toBe('ready to archive');
    expect(debt([{ ...card, removal_criteria_met: false, review_by: null }], '2026-11-26').rows).toEqual([]);
    expect(debt([{ ...card, removal_criteria_met: false }], '2026-11-26').rows[0].stage).toBe('review required');
    expect(debt([{ ...card, removal_criteria_met: false, review_by: '2026-11-26' }], '2026-11-26').rows).toEqual([]);
    expect(debt([{ ...card, owner: '' }], '2026-11-26').metadata_issues).toHaveLength(1);
  });
});

describe('feature flag registration, bindings and lint fixtures', () => {
  it('registers the skill, rule and existing card in their sibling manifests/index', () => {
    const skills = JSON.parse(read(path.join(framework, 'skills/manifest.json')));
    expect(skills.skills.find((s: { name: string }) => s.name === 'feature-flag-plan').triggers).toContain('plan feature flags');
    const rules = JSON.parse(read(path.join(framework, 'rules/manifest.json')));
    expect(rules.rules.find((r: { name: string }) => r.name === 'feature-flag-fit')).toMatchObject({ activation: 'summary', enforcement: 'medium' });
    expect(read(path.join(framework, 'rules/RULES-INDEX.md'))).toContain('#### feature-flag-fit');
    expect(JSON.parse(read(path.join(framework, 'templates/deployment/manifest.json'))).files).toContain('feature-toggle-card.md');
    const rule = parseFrontmatter(read(path.join(framework, 'rules/feature-flag-fit.md')));
    const bound = rule.bound_to as { skills: string[] };
    for (const skill of ['intake-start', 'architecture-evolution', 'flow-elaboration-to-construction', 'flow-construction-to-transition']) {
      expect(bound.skills).toContain(skill);
      expect(read(path.join(framework, `skills/${skill}/SKILL.md`))).toContain('feature-flag-fit');
    }
    for (const capability of ['c2i-architecture-sketch', 'e2c-iteration-planning', 'c2t-deployment-strategy']) {
      expect(read(path.join(framework, `flows/capabilities/${capability}.yaml`))).toContain('feature-flag-fit');
    }
  });
  it('preserves solution-profile contract and card schema', () => {
    const profile = read(path.join(framework, 'templates/intake/solution-profile-template.md'));
    expect(yaml.load(profile.match(/```yaml\n([\s\S]*?)```/)![1])).toEqual({ feature_flags: { provider: 'none', policy: 'suggest' } });
    const template = parseFrontmatter(read(path.join(framework, 'templates/deployment/feature-toggle-card.md')));
    for (const key of ['kind', 'value_type', 'dynamism', 'owner', 'default_value', 'default_rationale', 'removal_criteria', 'removal_task', 'review_by']) expect(template).toHaveProperty(key);
  });
  it('lints the shipped template and fixture and catches missing fields', async () => {
    const rule = await loadRule(path.join(framework, 'lint/feature-toggle-card.yaml'));
    for (const file of [fixture('feature-toggle-card-payments.md'), path.join(framework, 'templates/deployment/feature-toggle-card.md')]) {
      const content = read(file);
      const run = (body: string) => rule.checks.flatMap(check => runCheck(check, body, parseFrontmatter(body), file, root, [], new Set(), root));
      expect(run(content)).toEqual([]);
      expect(run(content.replace(/^removal_task:.*\n/m, ''))).toHaveLength(1);
    }
  });
  it('keeps the helper vendor-free and skill concise', () => {
    const skill = read(path.join(framework, 'skills/feature-flag-plan/SKILL.md'));
    expect(skill.split('\n').length).toBeLessThan(150);
    const require = createRequire(import.meta.url);
    expect(require.resolve('js-yaml')).toBeTruthy();
    expect(read(path.join(framework, 'skills/feature-flag-plan/scripts/flag-plan.mjs'))).not.toMatch(/https?:\/\/|fetch\(|child_process/);
  });
});
