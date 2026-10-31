import { readRuleDeliveryContext } from '../../helpers/rule-delivery-context.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, cpSync, statSync, truncateSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileWithCapture as execFileSync } from '../../helpers/exec-file-capture.js';
import { parse } from 'yaml';
import { stableRecordId } from '../../../src/artifacts/browser-export.js';
import { sourceRules } from './rule-source-expectations.js';

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
  const kernel = join(root, 'source/rules/fixture-kernel.md');
  writeFileSync(kernel, readFileSync(kernel, 'utf8').replace('enforcement: medium',
    'enforcement: medium\nsummary: Follow the fixture kernel policy.'));
  return root;
}
function deploy(root: string, provider: string, extra = {}) {
  const source = join(root, 'source');
  const opts = { srcRoot: source, target: join(root, 'target'), provider, mode: 'all', deployRules: true,
    deploySkills: true, deployCommands: true, copyStandardSkills: true, force: true, quiet: true,
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
    AIWG_RULES_INLINE_BUDGET_TOKENS: '0', ...((extra as any).env || {}) }, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function contents(root: string) {
  return new Map(walk(root).filter(f => /\.(md|mdc|toml)$/.test(f)).map(f => [relative(root, f), readFileSync(f, 'utf8')]));
}

describe('activation-selected provider deployment (#2939)', () => {
  for (const provider of ['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw']) {
    it(`${provider}: selected startup bytes, native/emulated paths, bindings and idempotence`, () => {
      const root = setup();
      const out = deploy(root, provider);
      const report = JSON.parse(out.split('REPORT:')[1].trim());
      expect(report.selected_bytes).toBeGreaterThan(0);
      const startup = readRuleDeliveryContext(report, provider);
      expect(startup).toContain('FIXTURE_KERNEL_BODY');
      expect(startup).toContain('Follow the fixture summary policy.');
      expect(startup).not.toContain('FIXTURE_SUMMARY_BODY');
      expect(startup).not.toContain('fixture-bound');
      expect(startup).not.toContain('FIXTURE_BOUND_BODY');
      expect(startup).not.toContain('fixture-on-demand');
      expect(startup).not.toContain('<!-- AIWG:bound-rules:start -->');
      if (['claude', 'cursor'].includes(provider)) {
        const scoped = [...contents(root)].filter(([file]) => !file.startsWith('source/') && file.includes('/rules/fixture-paths.'));
        expect(scoped).toHaveLength(1);
        expect(scoped[0][1]).toContain('FIXTURE_PATHS_BODY');
        expect(scoped[0][1]).toContain(provider === 'cursor' ? 'globs:' : 'paths:');
        if (provider === 'cursor') expect(scoped[0][1]).toContain('alwaysApply: false');
      } else {
        expect(startup).toContain('Path rules (prompt emulation)');
        expect(startup).toContain('src/**');
        expect(startup).not.toContain('FIXTURE_PATHS_BODY');
      }
      const definitions = [...contents(root)].filter(([file]) => !file.startsWith('source/') && /fixture-(skill|agent|flow)\/(SKILL.md)$|fixture-agent\.(md|toml)$/.test(file));
      expect(definitions.length).toBeGreaterThanOrEqual(3);
      for (const [file, content] of definitions) {
        expect(content.match(/<!-- AIWG:bound-rules:start -->/g)).toHaveLength(1);
        expect(content).toMatch(/RULES-BOUND\.md#(agent|skill|flow)-fixture-(agent|skill|flow)/);
        expect(readFileSync(join(root, `target/.${provider}/RULES-BOUND.md`), 'utf8')).toContain('aiwg show rule fixture-bound --body');
        if (file.endsWith('/SKILL.md')) expect(content).toContain('Follow the fixture bound policy.');
        else expect(content).not.toContain('Follow the fixture bound policy.');
        expect(content).not.toContain('FIXTURE_BOUND_BODY');
        const description = content.match(/^description\s*[:=].*$/m)?.[0];
        expect(description).not.toContain('Bound rules');
      }
      if (provider === 'codex') expect(Buffer.byteLength(readFileSync(join(root, 'target/AGENTS.md'), 'utf8'))).toBeLessThan(32768);
      const first = contents(root);
      deploy(root, provider);
      expect(contents(root)).toEqual(first);
    }, 90_000);
  }

  it('strict/CI overruns and invalid activation preserve the previous deployment; report-only preserves selection', () => {
    const root = setup();
    deploy(root, 'claude');
    const before = contents(join(root, 'target'));
    expect(() => deploy(root, 'claude', { strict: true, env: { AIWG_RULES_INLINE_BUDGET_TOKENS: '1' } })).toThrow();
    expect(contents(join(root, 'target'))).toEqual(before);
    deploy(root, 'claude', { reportOnly: true, env: { CI: '', AIWG_RULES_INLINE_BUDGET_TOKENS: '1' } });
    expect(contents(join(root, 'target'))).toEqual(before);
    writeFileSync(join(root, 'source/rules/fixture-kernel.md'), '---\nactivation: typo\n---\ninvalid');
    expect(() => deploy(root, 'claude')).toThrow();
    expect(contents(join(root, 'target'))).toEqual(before);
  }, 90_000);

  it('redeploy replaces changed summaries, removes stale blocks and startup bodies, and retires budget sidecars', () => {
    const root = setup();
    deploy(root, 'claude', { copyStandardSkills: false });
    const file = join(root, 'source/rules/fixture-bound.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Follow the fixture bound policy.', 'Follow the revised bound policy.'));
    writeFileSync(join(root, 'target/.claude/rules/.aiwg-rules-budget.json'), JSON.stringify({ budgetTokens: 64000, demoted: ['fixture-kernel'] }));
    deploy(root, 'claude', { copyStandardSkills: false });
    expect(readFileSync(join(root, 'target/.claude/skills/fixture-skill/SKILL.md'), 'utf8')).toContain('RULES-BOUND.md#skill-fixture-skill');
    expect(readFileSync(join(root, 'target/.claude/RULES-BOUND.md'), 'utf8')).toContain('Follow the revised bound policy.');
    expect(existsSync(join(root, 'target/.claude/rules/.aiwg-rules-budget.json'))).toBe(false);
    rmSync(file);
    deploy(root, 'claude', { copyStandardSkills: false });
    expect(readFileSync(join(root, 'target/.claude/RULES-BOUND.md'), 'utf8')).not.toContain('fixture-bound');
  }, 90_000);
  it('keeps untagged SDLC/Claude rules on demand without promoting legacy scope metadata', () => {
    const root = setup();
    // Freeze the legacy delivery input independently of later corpus migrations
    // and #3222's tagged behaviors; this fixture tests untagged tier fallback.
    const legacy = join(root, 'legacy');
    // Wave 4 intentionally changes these bodies; its six-provider fixture
    // checks complete delivery. Retain the historical hashes for other rules.
    const wave4 = new Set(['human-authorization', 'instruction-comprehension', 'research-before-decision', 'skill-discovery', 'artifact-output-policy']);
    cpSync(join(repo, 'agentic/code'), join(legacy, 'agentic/code'), { recursive: true,
      filter: file => !file.includes('/plugins/') &&
        ![...wave4].some(name => file.endsWith(`/${name}-guidance.md`)) &&
        (statSync(file).isDirectory() || file.includes('/rules/') || file.endsWith('/manifest.json') || file.endsWith('/RULES-INDEX.md')) });
    for (const file of walk(legacy).filter(file => file.endsWith('.md'))) {
      const content = readFileSync(file, 'utf8');
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match || !/^activation:/m.test(match[1])) continue;
      // ADR lines 265–272 and 344 preserve legacy native agent-deployment
      // paths. Strip new activation fields as complete YAML fields, keeping
      // that rule's pre-existing path route and its now-explicit HIGH tier.
      const fields = file.endsWith('/agent-deployment.md') ? 'activation|summary|bound_to' : 'activation|summary|paths|bound_to';
      const header = match[1].replace(new RegExp(`^(?:${fields}):[^\\n]*(?:\\n[ \\t]+[^\\n]*)*(?:\\n|$)`, 'gm'), '').trimEnd();
      writeFileSync(file, content.replace(match[0], `---\n${header}\n---`));
    }
    deploy(root, 'claude', { srcRoot: legacy, mode: 'sdlc', deploySkills: false, deployCommands: false,
      rulesOnly: true, bindingEntries: [], deployVersion: 'fixture', deploySource: 'bundled' });
    const dir = join(root, 'target/.claude/rules');
    // Missing activation never authorizes always-on delivery, even for legacy
    // CRITICAL/HIGH contracts. Only the selected bundle set is discoverable.
    const selected = [...sourceRules(legacy, 'frameworks').filter(rule => rule.file.includes('/sdlc-complete/')),
      ...sourceRules(legacy, 'addons').filter(rule => /\/(aiwg-utils|schema-governance|dataset-intelligence)\//.test(rule.file))]
      .filter(rule => !rule.structural);
    expect(selected.length).toBeGreaterThan(30);
    expect(readdirSync(dir).filter(name => name.endsWith('.md')).sort()).toEqual(['RULES-ONDEMAND.md']);
    const index = readFileSync(join(dir, 'RULES-ONDEMAND.md'), 'utf8');
    expect([...index.matchAll(/^- `([^`]+)`/gm)].map(match => match[1]).sort())
      .toEqual(selected.map(rule => rule.name).sort());
    for (const rule of selected) {
      expect(existsSync(join(dir, `${rule.name}.md`)), rule.name).toBe(false);
      expect(index).toContain(`aiwg show rule ${rule.name} --body`);
    }
    // Legacy scope metadata remains intact in source, without becoming an
    // implicit native path activation or an always-on body.
    const legacyPaths = parse(readFileSync(join(legacy, 'agentic/code/addons/aiwg-utils/rules/agent-deployment.md'), 'utf8').match(/^---\n([\s\S]*?)\n---/)![1]);
    expect(legacyPaths.paths).toEqual(['.claude/agents/**', '.factory/droids/**', '.codex/agents/**',
      '.opencode/agent/**', 'agentic/**', 'AGENTS.md', 'tools/agents/providers/**']);
  }, 90_000);

  it('resolves concrete bindings through the shared source index on a fresh deployment', () => {
    const root = setup();
    deploy(root, 'claude', { bindingEntries: undefined });
    expect(readFileSync(join(root, 'target/.claude/skills/fixture-skill/SKILL.md'), 'utf8')).toContain('RULES-BOUND.md#');
  }, 90_000);

  it('resolves canonical package IDs in a cold source snapshot without installing external targets', () => {
    const root = setup();
    const source = join(root, 'cold-source');
    const selected = 'agentic/code/addons/example/skills/shared/SKILL.md';
    for (const owner of ['example', 'other']) {
      const file = join(source, 'agentic/code/addons', owner, 'skills/shared/SKILL.md');
      mkdirSync(resolve(file, '..'), { recursive: true });
      writeFileSync(file, '---\nname: shared\ndescription: Synthetic action.\n---\n# Shared action\nInspect only.\n');
    }
    mkdirSync(join(source, 'agentic/code/addons/example/rules'), { recursive: true });
    writeFileSync(join(source, 'agentic/code/addons/example/rules/canonical.md'), `---\nname: canonical\nactivation: bound\nenforcement: high\nsummary: Follow the selected canonical policy.\nbound_to:\n  skills: [${stableRecordId('aiwg.skill', selected)}]\n---\n# Canonical rule\n`);
    deploy(root, 'claude', { srcRoot: source, config: { installed: { example: {} } }, bindingEntries: undefined, deploySkills: false,
      deployCommands: false, rulesOnly: true });
    expect(walk(join(root, 'target')).filter(file => file.endsWith('/shared/SKILL.md'))).toEqual([]);
    // Validation still runs when rulesOnly has no invoked definition to decorate.
    const rule = join(source, 'agentic/code/addons/example/rules/canonical.md');
    writeFileSync(rule, readFileSync(rule, 'utf8').replace(stableRecordId('aiwg.skill', selected), 'aiwg:skill:0000000000000000'));
    expect(() => deploy(root, 'claude', { srcRoot: source, config: { installed: { example: {} } }, bindingEntries: undefined,
      deploySkills: false, deployCommands: false, rulesOnly: true })).toThrow();
  }, 90_000);

  it('preserves authored flow skill bodies and prunes opt-in projections without deleting operator resources', () => {
    const root = setup();
    const source = join(root, 'source/skills/fixture-flow');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '---\nname: fixture-flow\nnamespace: aiwg\ndescription: Authored flow skill.\n---\nAUTHORED_FLOW_SKILL_BODY\n');
    deploy(root, 'claude');
    const output = join(root, 'target/.claude/.aiwg/skills/fixture-flow');
    const authored = readFileSync(join(output, 'SKILL.md'), 'utf8');
    expect(authored).toContain('AUTHORED_FLOW_SKILL_BODY');
    expect(authored).toContain('RULES-BOUND.md#');
    expect(authored).not.toContain('```yaml');
    // Index cleanup releases the retired authored copy before projecting the flow.
    rmSync(source, { recursive: true });
    deploy(root, 'claude', { copyStandardSkills: false });
    deploy(root, 'claude');
    expect(readFileSync(join(output, 'SKILL.md'), 'utf8')).toContain('```yaml');
    writeFileSync(join(output, 'operator-note.txt'), 'Keep this operator resource.');
    deploy(root, 'claude', { copyStandardSkills: false });
    expect(existsSync(join(output, 'SKILL.md'))).toBe(false);
    expect(readFileSync(join(output, 'operator-note.txt'), 'utf8')).toBe('Keep this operator resource.');
    expect(existsSync(join(root, 'target/.claude/skills/fixture-flow'))).toBe(false);
  }, 90_000);

  it('validates external binding targets without copying them into the selected deployment', () => {
    const root = setup();
    const external = join(root, 'external/fixture-flow.yaml');
    mkdirSync(join(root, 'external'));
    cpSync(join(root, 'source/flows/fixture-flow.yaml'), external);
    rmSync(join(root, 'source/flows'), { recursive: true });
    deploy(root, 'claude', { bindingEntries: [
      { type: 'skill', name: 'fixture-skill', path: join(root, 'source/skills/fixture-skill/SKILL.md') },
      { type: 'agent', name: 'fixture-agent', path: join(root, 'source/agents/fixture-agent.md') },
      { type: 'flow', name: 'fixture-flow', path: external },
    ] });
    expect(readFileSync(join(root, 'target/.claude/skills/fixture-skill/SKILL.md'), 'utf8')).toContain('RULES-BOUND.md#');
    expect(walk(join(root, 'target')).filter(file => file.endsWith('/fixture-flow/SKILL.md'))).toEqual([]);
  }, 90_000);

  it('promotes empty resource directories along with the validated deployment', () => {
    const root = setup();
    mkdirSync(join(root, 'source/skills/fixture-skill/empty-resource'), { recursive: true });
    deploy(root, 'claude');
    const resource = join(root, 'target/.claude/skills/fixture-skill/empty-resource');
    expect(existsSync(resource)).toBe(true);
    expect(readdirSync(resource)).toEqual([]);
  }, 90_000);

  it('refreshes an invocation index snapshot when a later pass declares a new target', () => {
    const root = setup();
    const env = { AIWG_RULE_BINDING_INDEX_CACHE: join(root, 'binding-cache'),
      XDG_DATA_HOME: join(root, 'xdg-data'), XDG_CONFIG_HOME: join(root, 'xdg-config') };
    deploy(root, 'claude', { bindingEntries: undefined, env });
    writeFileSync(join(root, 'source/agents/late-agent.md'), '---\nname: late-agent\ndescription: Late target\n---\n# Late agent\n');
    writeFileSync(join(root, 'source/rules/late-rule.md'), '---\nname: late-rule\nactivation: bound\nsummary: Follow the late policy.\nbound_to:\n  agents: [late-agent]\n---\nLATE_RULE_BODY\n');
    deploy(root, 'claude', { bindingEntries: undefined, env });
    const late = readFileSync(join(root, 'target/.claude/agents/late-agent.md'), 'utf8');
    expect(late).toContain('RULES-BOUND.md#agent-late-agent');
    expect(late.match(/<!-- AIWG:bound-rules:start -->/g)).toHaveLength(1);
    expect(readFileSync(join(root, 'target/.claude/agents/fixture-agent.md'), 'utf8'))
      .toContain('RULES-BOUND.md#');
  }, 90_000);

  it('rebuilds a stale non-empty source index when a bound agent is missing', () => {
    const root = setup();
    const source = join(root, 'source');
    // A relative artifact override resolves separately beneath source and target.
    // loadLocalCapabilityEntries reads the project graph before its legacy fallback.
    const indexDir = join(source, 'artifacts/.index/project');
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(join(indexDir, 'metadata.json'), JSON.stringify({ entries: {
      skill: { type: 'skill', name: 'fixture-skill', path: join(source, 'skills/fixture-skill/SKILL.md') },
      flow: { type: 'flow', name: 'fixture-flow', path: join(source, 'flows/fixture-flow.yaml') },
    } }));

    deploy(root, 'claude', { bindingEntries: undefined, env: {
      AIWG_ARTIFACTS_PATH: 'artifacts',
      AIWG_RULE_BINDING_INDEX_CACHE: '',
      XDG_DATA_HOME: join(root, 'xdg-data'),
      XDG_CONFIG_HOME: join(root, 'xdg-config'),
    } });
    const agent = readFileSync(join(root, 'target/.claude/agents/fixture-agent.md'), 'utf8');
    expect(agent.match(/<!-- AIWG:bound-rules:start -->/g)).toHaveLength(1);
    expect(agent).toContain('RULES-BOUND.md#');
    expect(agent).not.toContain('FIXTURE_BOUND_BODY');
  }, 90_000);

  it('rebuilds a malformed shared binding snapshot instead of failing deployment', () => {
    const root = setup();
    const cache = join(root, 'binding-cache');
    const env = { AIWG_RULE_BINDING_INDEX_CACHE: cache,
      XDG_DATA_HOME: join(root, 'xdg-data'), XDG_CONFIG_HOME: join(root, 'xdg-config') };
    deploy(root, 'claude', { bindingEntries: undefined, env });
    const files = readdirSync(cache);
    expect(files).toHaveLength(1);
    writeFileSync(join(cache, files[0]), '{interrupted snapshot');
    deploy(root, 'claude', { bindingEntries: undefined, env });
    expect(JSON.parse(readFileSync(join(cache, files[0]), 'utf8'))).toEqual(expect.any(Array));
    expect(readdirSync(cache)).toEqual(files);
    expect(readFileSync(join(root, 'target/.claude/agents/fixture-agent.md'), 'utf8'))
      .toContain('RULES-BOUND.md#');
  }, 90_000);

  it('enforces provider hard caps even with a disabled configurable budget', () => {
    const root = setup();
    writeFileSync(join(root, 'target/AGENTS.md'), '# Authored context\n' + 'x'.repeat(32768));
    expect(() => deploy(root, 'codex')).toThrow();
    expect(readFileSync(join(root, 'target/AGENTS.md'), 'utf8')).toHaveLength(32787);
    writeFileSync(join(root, 'target/AGENTS.md'), '# Authored context\n');
    const kernel = readFileSync(join(root, 'source/rules/fixture-kernel.md'), 'utf8');
    writeFileSync(join(root, 'source/rules/fixture-kernel.md'), '---\nactivation: kernel\nenforcement: critical\n---\n' + 'x'.repeat(20000));
    deploy(root, 'hermes');
    expect(readFileSync(join(root, 'target/.hermes/rules/fixture-kernel.md'), 'utf8')).toContain('x'.repeat(20000));
    writeFileSync(join(root, 'source/rules/fixture-kernel.md'), kernel);
    writeFileSync(join(root, 'target/.hermes.md'), '# Operator routing\n' + 'x'.repeat(20000));
    expect(() => deploy(root, 'hermes')).toThrow('19000');
  }, 90_000);

  it('delivers a CRITICAL kernel set larger than the old inline cap in full rule files', () => {
    const root = setup();
    for (const name of ['critical-one', 'critical-two']) {
      writeFileSync(join(root, 'source/rules', `${name}.md`),
        `---\nname: ${name}\nactivation: kernel\nenforcement: critical\n---\n${name}\n${'x'.repeat(10000)}`);
    }
    const report = JSON.parse(deploy(root, 'hermes').split('REPORT:')[1].trim());
    readRuleDeliveryContext(report, 'hermes');
    const startup = readFileSync(join(root, 'target/AGENTS.md'), 'utf8');
    expect(startup).toContain('.hermes/rules/RULES-INDEX.md');
    expect(startup).not.toContain('x'.repeat(10000));
    expect(Buffer.byteLength(startup)).toBeLessThan(4096);
  }, 90_000);

  it('keeps large non-critical and CRITICAL kernels complete behind the hook', () => {
    const root = setup();
    const noncritical = join(root, 'source/rules/fixture-kernel.md');
    writeFileSync(noncritical, readFileSync(noncritical, 'utf8') + '\n' + 'LARGE_NONCRITICAL_BODY'.repeat(2000));
    const criticalBody = '# Critical core\n\nPreserve every character of this policy.\nSecond paragraph with Unicode: é λ.';
    writeFileSync(join(root, 'source/rules/critical-core.md'),
      `---\nname: critical-core\nactivation: kernel\nenforcement: critical\n---\n${criticalBody}`);
    deploy(root, 'hermes');
    const startup = readFileSync(join(root, 'target/AGENTS.md'), 'utf8');
    expect(startup).toContain('.hermes/rules/RULES-INDEX.md');
    expect(readFileSync(join(root, 'target/.hermes/rules/critical-core.md'), 'utf8')).toContain(criticalBody);
    expect(readFileSync(join(root, 'target/.hermes/rules/fixture-kernel.md'), 'utf8')).toContain('LARGE_NONCRITICAL_BODY'.repeat(2000));
    expect(startup).not.toContain('LARGE_NONCRITICAL_BODY');
    expect(startup.length).toBeLessThanOrEqual(19000);
    const before = contents(root);
    deploy(root, 'hermes');
    expect(contents(root)).toEqual(before);
  }, 90_000);

  it('retains selected activation and provider bootstrap when the final context owner regenerates startup', async () => {
    const { generate } = await import('../../../src/smiths/context-pipeline/index.js');
    for (const provider of ['codex', 'hermes', 'warp'] as const) {
      const root = setup();
      const report = JSON.parse(deploy(root, provider).split('REPORT:')[1].trim());
      await generate({ provider, projectPath: join(root, 'target'), sections: [], force: true });
      const file = provider === 'warp' ? 'WARP.md' : 'AGENTS.md';
      const content = readFileSync(join(root, 'target', file), 'utf8');
      const reached = readRuleDeliveryContext(report, provider);
      expect(reached).toContain('FIXTURE_KERNEL_BODY');
      expect(reached).toContain('Follow the fixture summary policy.');
      expect(content).not.toContain('FIXTURE_KERNEL_BODY');
      expect(content).not.toContain('fixture-bound');
      // Legacy compressed directives cannot promote rules from uninstalled
      // bundles. The provider bootstrap and selected contracts still survive.
      if (provider === 'hermes') {
        expect(content).not.toContain('Never fabricate citations, DOIs, URLs, or page numbers.');
        expect(content).toContain('Read and follow [WORKSPACE.md]');
        expect(content).not.toContain('### Rule: anti-laziness');
      }
      if (provider === 'codex') expect(Buffer.byteLength(readFileSync(join(root, 'target/AGENTS.md'), 'utf8'))).toBeLessThan(32768);
    }
  }, 90_000);

  it('keeps earlier pass summaries and kernels in the assembled deployment', () => {
    const root = setup();
    deploy(root, 'claude');
    const extra = join(root, 'extra');
    mkdirSync(join(extra, 'rules'), { recursive: true });
    writeFileSync(join(extra, 'rules/extra-summary.md'), '---\nname: extra-summary\nactivation: summary\nsummary: Follow the later-pass summary.\n---\nEXTRA_SUMMARY_BODY');
    deploy(root, 'claude', { srcRoot: extra, rulesOnly: true, deploySkills: false, deployCommands: false,
      config: { installed: { fixture: { localPath: join(root, 'source') }, extra: { localPath: extra } } } });
    const index = readFileSync(join(root, 'target/.claude/rules/RULES-INDEX.md'), 'utf8');
    expect(index).toContain('Follow the fixture summary policy.');
    expect(index).toContain('Follow the later-pass summary.');
    expect(readFileSync(join(root, 'target/.claude/rules/fixture-kernel.md'), 'utf8')).toContain('FIXTURE_KERNEL_BODY');
  }, 90_000);

  it('reconciles managed startup bodies when activation changes or source disappears', () => {
    const root = setup();
    deploy(root, 'claude', { copyStandardSkills: false });
    const source = join(root, 'source/rules/fixture-kernel.md');
    writeFileSync(source, '---\nname: fixture-kernel\nactivation: on-demand\n---\nKERNEL_NOW_MANUAL');
    deploy(root, 'claude', { copyStandardSkills: false });
    expect(existsSync(join(root, 'target/.claude/rules/fixture-kernel.md'))).toBe(false);
    rmSync(join(root, 'source/rules/fixture-paths.md'));
    deploy(root, 'claude', { copyStandardSkills: false });
    expect(existsSync(join(root, 'target/.claude/rules/fixture-paths.md'))).toBe(false);
  }, 90_000);

  it('Codex aggregate mode keeps bound definitions outside AGENTS.md', () => {
    const root = setup();
    deploy(root, 'codex', { asAgentsMd: true });
    const startup = readFileSync(join(root, 'target/AGENTS.md'), 'utf8');
    expect(startup).toContain('.codex/rules/RULES-INDEX.md');
    expect(startup).not.toContain('Bound rules');
    expect(readFileSync(join(root, 'target/.codex/agents/fixture-agent.toml'), 'utf8')).toContain('RULES-BOUND.md#');
    expect(Buffer.byteLength(startup)).toBeLessThan(32768);
  }, 90_000);

  it('rejects missing and ambiguous binding IDs before any output changes', () => {
    const root = setup();
    deploy(root, 'claude');
    const before = contents(join(root, 'target'));
    expect(() => deploy(root, 'claude', { bindingEntries: [] })).toThrow();
    const source = join(root, 'source');
    const other = join(root, 'other.md');
    writeFileSync(other, '# Other skill');
    expect(() => deploy(root, 'claude', { bindingEntries: [
      { type: 'skill', name: 'fixture-skill', path: join(source, 'skills/fixture-skill/SKILL.md') },
      { type: 'skill', name: 'fixture-skill', path: other },
    ] })).toThrow();
    expect(contents(join(root, 'target'))).toEqual(before);
  }, 90_000);

  it('counts Warp rule startup bytes while excluding large aggregated agent bodies', () => {
    const root = setup();
    const extra = { strict: true, config: { rules: { inline_budget_tokens: 2000 } },
      env: { AIWG_RULES_INLINE_BUDGET_TOKENS: undefined } };
    const baseline = JSON.parse(deploy(root, 'warp', extra).split('REPORT:')[1].trim());
    expect(baseline.selected_bytes).toBeGreaterThan(0);
    const aggregate = join(root, 'target/WARP.md');
    writeFileSync(aggregate, '# Project agent definitions\n' + 'AGENT_PAYLOAD '.repeat(30000) + '\n' + readFileSync(aggregate, 'utf8'));
    const enlarged = JSON.parse(deploy(root, 'warp', extra).split('REPORT:')[1].trim());
    expect(readFileSync(join(root, 'target/WARP.md'), 'utf8')).toContain('AGENT_PAYLOAD');
    expect(enlarged.selected_bytes).toBe(baseline.selected_bytes);
    const kernel = join(root, 'source/rules/fixture-kernel.md');
    writeFileSync(kernel, readFileSync(kernel, 'utf8') + '\n' + 'RULE_PAYLOAD '.repeat(2000));
    const before = contents(join(root, 'target'));
    expect(() => deploy(root, 'warp', extra)).toThrow(/Rules startup budget exceeded for warp/);
    expect(contents(join(root, 'target'))).toEqual(before);
  }, 90_000);

  it('accounts for behavior wrappers and config budgets before promotion', () => {
    const root = setup();
    const behavior = join(root, 'source/behaviors/fixture-behavior');
    mkdirSync(behavior, { recursive: true });
    writeFileSync(join(behavior, 'BEHAVIOR.md'), '---\nactivation: kernel\nname: fixture-behavior\n---\n' + 'x'.repeat(12000));
    expect(() => deploy(root, 'claude', { strict: true, config: { rules: { inline_budget_tokens: 1000 } }, env: { AIWG_RULES_INLINE_BUDGET_TOKENS: undefined } })).toThrow();
    expect(contents(join(root, 'target')).size).toBe(0);
    deploy(root, 'claude', { strict: true, config: { rules: { inline_budget_tokens: 1000 } }, env: { AIWG_RULES_INLINE_BUDGET_TOKENS: '0' } });
    expect(readFileSync(join(root, 'target/.claude/rules/behaviors/fixture-behavior.md'), 'utf8')).toContain('name: fixture-behavior');
  }, 90_000);

  it('preserves large artifact payloads without buffering them during deployment or dry-run', () => {
    const root = setup();
    const payload = join(root, 'target/.aiwg/working/payload.bin');
    mkdirSync(join(root, 'target/.aiwg/working'), { recursive: true });
    writeFileSync(payload, Buffer.from([0, 255, 1, 254]));
    truncateSync(payload, 64 * 1024 * 1024);
    const prior = statSync(payload);
    const hook = join(root, 'bounded-read.mjs');
    writeFileSync(hook, `
      import fs from 'node:fs';
      const read = fs.readFileSync;
      fs.readFileSync = (file, ...args) => {
        if (String(file).endsWith('/payload.bin')) throw new Error('Artifact payload must not be buffered');
        return read(file, ...args);
      };
    `);
    const env = { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${hook}` };
    deploy(root, 'claude', { env });
    const output = deploy(root, 'claude', { env, dryRun: true });
    expect(output).not.toContain('payload.bin');
    expect(statSync(payload).size).toBe(prior.size);
    expect(statSync(payload).mtimeMs).toBe(prior.mtimeMs);
  }, 90_000);

  it('dry-run stages and validates the full result without promoting output', () => {
    const root = setup();
    const output = deploy(root, 'claude', { dryRun: true });
    expect(output).toContain('[dry-run]');
    expect(contents(join(root, 'target')).size).toBe(0);
  }, 90_000);

  it('the standalone Cursor deploy script honors canonical activation', () => {
    const root = setup();
    execFileSync('node', ['tools/rules/deploy-rules-cursor.mjs', '--source', join(root, 'source'), '--target', join(root, 'target'), '--force'], {
      cwd: repo, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: join(root, 'home'), AIWG_ROOT: join(root, 'source'), AIWG_RULES_INLINE_BUDGET_TOKENS: '0', NO_UPDATE_NOTIFIER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const dir = join(root, 'target/.cursor/rules');
    expect(readFileSync(join(dir, 'fixture-paths.mdc'), 'utf8')).toContain('alwaysApply: false');
    expect(readFileSync(join(dir, 'fixture-kernel.mdc'), 'utf8')).toContain('alwaysApply: true');
    expect(existsSync(join(dir, 'fixture-bound.mdc'))).toBe(false);
    expect(existsSync(join(dir, 'fixture-on-demand.mdc'))).toBe(false);
    expect(readFileSync(join(dir, 'RULES-INDEX.mdc'), 'utf8')).toContain('Follow the fixture summary policy.');
  }, 90_000);

});
