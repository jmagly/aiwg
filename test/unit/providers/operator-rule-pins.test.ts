import { readRuleDeliveryContext } from '../../helpers/rule-delivery-context.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';



const repo = resolve(__dirname, '../../..');
const fixture = join(repo, 'test/fixtures/rule-delivery');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const walk = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]) : [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiwg-activation-fixture-'));
  roots.push(root);
  mkdirSync(join(root, 'target'));
  cpSync(fixture, join(root, 'source'), { recursive: true });
  return root;
}
function deploy(root: string, provider: string, extra = {}) {
  const source = join(root, 'source');
  const opts = { srcRoot: source, target: join(root, 'target'), provider, mode: 'all', deployRules: true,
    deploySkills: true, deployCommands: true, copyStandardSkills: true, force: true, quiet: true,
    capability: 'fixture', config: { installed: { fixture: {} }, rules: { always_load: [{ rules: ['fixture-bound', 'fixture-summary', 'fixture-paths', 'fixture-on-demand'] }] } },
    bindingEntries: [
      { type: 'skill', name: 'fixture-skill', path: join(source, 'skills/fixture-skill/SKILL.md') },
      { type: 'agent', name: 'fixture-agent', path: join(source, 'agents/fixture-agent.md') },
      { type: 'flow', name: 'fixture-flow', path: join(source, 'flows/fixture-flow.yaml') },
    ], ...extra };
  return execFileSync('node', ['--input-type=module', '-e', `
    const { deploy } = await import(${JSON.stringify(join(repo, 'tools/agents/providers', `${provider}.mjs`))});
    const report = await deploy(${JSON.stringify(opts)});
    console.log('REPORT:' + JSON.stringify(report));
  `], { cwd: repo, env: { ...process.env, HOME: join(root, 'home'), HERMES_HOME: join(root, 'home/.hermes'), AIWG_ROOT: source,
    AIWG_RULES_INLINE_BUDGET_TOKENS: '0', XDG_DATA_HOME: join(root, 'xdg-data'), XDG_CONFIG_HOME: join(root, 'xdg-config'), AIWG_CONFIG: join(root, 'home/.aiwg'), ...((extra as any).env || {}) }, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function contents(root: string) {
  return new Map(walk(root).filter(f => /\.(md|mdc|toml)$/.test(f)).map(f => [relative(root, f), readFileSync(f, 'utf8')]));
}

describe('operator pinned provider projections', () => {
  for (const provider of ['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw']) {
    it(`${provider}: full native bodies, bindings, summaries, and canonical restoration`, () => {
      const root = setup();
      const pinned = JSON.parse(deploy(root, provider).split('REPORT:')[1].trim());
      const startup = readRuleDeliveryContext(pinned, provider);
      for (const mode of ['BOUND', 'SUMMARY', 'PATHS', 'ON_DEMAND']) expect(startup).toContain(`FIXTURE_${mode}_BODY`);
      for (const name of ['bound', 'summary', 'paths', 'on-demand']) {
        const body = readFileSync(join(root, `source/rules/fixture-${name}.md`), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
        expect(startup).toContain(body);
      }
      expect(startup).toContain('Follow the fixture summary policy.');
      expect(pinned.pins).toHaveLength(4);
      if (provider === 'cursor') {
        const file = readFileSync(join(root, 'target/.cursor/rules/fixture-paths.mdc'), 'utf8');
        expect(file).toContain('alwaysApply: true');
        expect(file).not.toContain('globs:');
      }
      if (provider === 'claude') expect(readFileSync(join(root, 'target/.claude/rules/fixture-paths.md'), 'utf8')).not.toMatch(/^paths:/m);
      const first = contents(root);
      deploy(root, provider);
      expect(contents(root)).toEqual(first);
      const config = { installed: { fixture: {} }, rules: { always_load: [] } };
      const unpinned = JSON.parse(deploy(root, provider, { config, copyStandardSkills: false }).split('REPORT:')[1].trim());
      const normal = readRuleDeliveryContext(unpinned, provider);
      expect(normal).not.toContain('FIXTURE_BOUND_BODY');
      expect(normal).not.toContain('FIXTURE_SUMMARY_BODY');
      expect(normal).not.toContain('FIXTURE_ON_DEMAND_BODY');
      expect(normal).toContain('Follow the fixture summary policy.');
      expect(unpinned.pins).toHaveLength(0);
      const restored = contents(root);
      deploy(root, provider, { config, copyStandardSkills: false });
      expect(contents(root)).toEqual(restored);
    }, 90_000);
  }
  it('fails inline budgets with provider and pin contributors before promotion, allows explicit override', () => {
    const root = setup();
    const extra = { env: { AIWG_RULES_INLINE_BUDGET_TOKENS: '1', CI: '' } };
    expect(() => deploy(root, 'claude', extra)).toThrow(/claude.*startup bytes|Rules startup budget/s);
    expect(contents(join(root, 'target')).size).toBe(0);
    const output = deploy(root, 'claude', { ...extra, allowOverBudget: true });
    const report = JSON.parse(output.split('REPORT:')[1].trim());
    expect(report.exceeded).toBe(true);
    expect(readFileSync(join(root, 'target/.claude/rules/fixture-bound.md'), 'utf8')).toContain('FIXTURE_BOUND_BODY');
  }, 90_000);
  it.each(['codex', 'hermes'])('%s hard cap retains entire pins only with explicit override', provider => {
    const root = setup();
    const file = join(root, 'source/rules/fixture-on-demand.md');
    writeFileSync(file, readFileSync(file, 'utf8') + 'x'.repeat(40000));
    writeFileSync(join(root, 'target/AGENTS.md'), 'x'.repeat(provider === 'codex' ? 33000 : 20000));
    expect(() => deploy(root, provider)).toThrow(/hard cap/);
    const report = JSON.parse(deploy(root, provider, { allowOverBudget: true }).split('REPORT:')[1].trim());
    const startup = report.contributors.map((file: any) => readFileSync(file.path, 'utf8')).join('\n');
    expect(startup).toContain('FIXTURE_ON_DEMAND_BODY');
    expect(startup).toContain('x'.repeat(40000));
  }, 90_000);
  it('pin-only redeployment retains existing behavior contracts in aggregate startup', () => {
    const root = setup();
    const behavior = join(root, 'source/behaviors/fixture-behavior');
    mkdirSync(behavior, { recursive: true });
    writeFileSync(join(behavior, 'BEHAVIOR.md'), '---\nactivation: kernel\nenforcement: high\n---\nPERSISTENT_BEHAVIOR_BODY\n');
    deploy(root, 'codex');
    const ruleSources = readdirSync(join(root, 'source/rules')).map(file => join(root, 'source/rules', file));
    const report = JSON.parse(deploy(root, 'codex', { ruleSources, rulesOnly: true, deploySkills: false, deployCommands: false }).split('REPORT:')[1].trim());
    const startup = report.contributors.map((file: any) => readFileSync(file.path, 'utf8')).join('\n');
    expect(startup).toContain('PERSISTENT_BEHAVIOR_BODY');
    expect(readFileSync(join(root, 'target/AGENTS.md'), 'utf8')).toContain('.codex/rules/RULES-INDEX.md');
    expect(readFileSync(join(root, 'target/.codex/rules/behaviors/fixture-behavior.md'), 'utf8')).toContain('PERSISTENT_BEHAVIOR_BODY');
    const config = { installed: { fixture: {} }, rules: { always_load: [] } };
    const restored = JSON.parse(deploy(root, 'codex', { ruleSources, config, rulesOnly: true, deploySkills: false, deployCommands: false }).split('REPORT:')[1].trim());
    expect(restored.contributors.map((file: any) => readFileSync(file.path, 'utf8')).join('\n')).toContain('PERSISTENT_BEHAVIOR_BODY');
    expect(readFileSync(join(root, 'target/AGENTS.md'), 'utf8')).toContain('.codex/rules/RULES-INDEX.md');
    expect(readFileSync(join(root, 'target/.codex/rules/behaviors/fixture-behavior.md'), 'utf8')).toContain('PERSISTENT_BEHAVIOR_BODY');
  }, 90_000);
  it('uses user config pins during ordinary redeployment', () => {
    const root = setup();
    mkdirSync(join(root, 'home/.aiwg'), { recursive: true });
    writeFileSync(join(root, 'home/.aiwg/aiwg.config'), JSON.stringify({ rules: { always_load: [{ rules: ['fixture-bound'] }] } }));
    const config = { installed: { fixture: {} } };
    const report = JSON.parse(deploy(root, 'claude', { config }).split('REPORT:')[1].trim());
    expect(report.pins).toHaveLength(1);
    expect(report.pins[0].matches[0].source).toBe('user');
  }, 90_000);
});
