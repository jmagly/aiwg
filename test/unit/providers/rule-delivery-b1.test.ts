import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileWithCapture as execFileSync } from '../../helpers/exec-file-capture.js';
import { collectDeploymentRuleSources, renderRuleKernelIndex } from '../../../tools/agents/providers/rule-delivery.mjs';
import { lintRuleActivation } from '../../../src/lint/rule-activation.js';
import { parseRuleFrontmatter } from '../../../src/rules/activation.mjs';

const repo = path.resolve(__dirname, '../../..');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-b1-regression-')); roots.push(root);
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  fs.cpSync(path.join(repo, 'test/fixtures/rule-delivery'), source, { recursive: true });
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'rules/core-policy.md'), '---\nactivation: core\n---\nFull policy.');
  fs.writeFileSync(path.join(source, 'rules/core-policy.core.md'), 'CORE_POLICY');
  return { root, source, target };
}
function deploy(source: string, target: string, provider: string, args: string[] = []) {
  return execFileSync('node', [path.join(repo, 'tools/agents/deploy-agents.mjs'), '--source', source, '--target', target,
    '--provider', provider, '--mode', 'all', '--kernel-only', '--skip-commands-migration', ...args], {
    cwd: repo, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: path.join(target, '../home'), HERMES_HOME: path.join(target, '../home/.hermes'),
      AIWG_ROOT: source, AIWG_RULES_INLINE_BUDGET_TOKENS: '0' },
  });
}

describe('B1 rule delivery regressions', () => {
  it.each(['claude', 'codex', 'pi'])('%s: deferred kernel passes deploy skills and leave projection to the final pass', (provider) => {
    const { source, target } = setup();
    deploy(source, target, provider, ['--defer-rule-projection']);
    const skill = path.join(target, provider === 'claude' ? '.claude/skills' : '.agents/skills', 'fixture-skill/SKILL.md');
    expect(fs.readFileSync(skill, 'utf8')).toContain('Preserve this authored skill body.');
    const rules = path.join(target, `.${provider}/rules`);
    expect(fs.existsSync(path.join(rules, 'RULES-INDEX.md'))).toBe(false);
    expect(fs.existsSync(path.join(target, `.${provider}/RULES-BOUND.md`))).toBe(false);

    deploy(source, target, provider);
    expect(fs.readFileSync(path.join(rules, 'fixture-kernel.md'), 'utf8')).toContain('FIXTURE_KERNEL_BODY');
    expect(fs.readFileSync(path.join(rules, 'RULES-INDEX.md'), 'utf8')).toContain('fixture-summary');
    expect(fs.readFileSync(skill, 'utf8')).toContain('aiwg show rule fixture-bound --body');
    expect(fs.readFileSync(path.join(target, `.${provider}/RULES-BOUND.md`), 'utf8')).toContain('fixture-bound');
  }, 90_000);

  for (const provider of ['claude', 'codex', 'cursor', 'pi', 'hermes', 'warp', 'factory', 'opencode', 'copilot']) {
    it(`${provider}: kernel-only writes core, kernel and index, without bulk definitions`, () => {
      const { source, target } = setup();
      if (provider === 'hermes') fs.writeFileSync(path.join(target, 'AGENTS.md'),
        '# Operator context\n<!-- AIWG:hermes-context:start -->\n### Rule: uninstalled-ops\nUNINSTALLED_OPS_BODY\n<!-- AIWG:hermes-context:end -->\n');
      deploy(source, target, provider);
      if (provider === 'hermes') {
        const startup = fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8');
        expect(startup).not.toContain('UNINSTALLED_OPS_BODY');
        expect(startup).toContain('# Operator context');
      }
      const rules = path.join(target, provider === 'opencode' ? '.opencode/rule' : provider === 'copilot' ? '.github/instructions' : `.${provider}/rules`);
      const ext = provider === 'cursor' ? 'mdc' : 'md';
      expect(fs.readFileSync(path.join(rules, `fixture-kernel.${ext}`), 'utf8')).toContain('FIXTURE_KERNEL_BODY');
      expect(fs.readFileSync(path.join(rules, `RULES-INDEX.${ext}`), 'utf8')).toContain('fixture-summary');
      const coreFile = ['claude', 'cursor'].includes(provider) ? path.join(rules, `core-core-policy.${ext}`)
        : path.join(target, provider === 'copilot' ? '.github/copilot-instructions.md' : provider === 'warp' ? 'WARP.md' : 'AGENTS.md');
      expect(fs.readFileSync(coreFile, 'utf8')).toContain('CORE_POLICY');
      const agents = provider === 'opencode' ? '.opencode/agent' : provider === 'factory' ? '.factory/droids' : provider === 'copilot' ? '.github/agents' : `.${provider}/agents`;
      expect(fs.existsSync(path.join(target, agents, 'fixture-agent.md'))).toBe(false);
      expect(fs.existsSync(path.join(rules, `fixture-bound.${ext}`))).toBe(false);
      expect(fs.existsSync(path.join(rules, `fixture-on-demand.${ext}`))).toBe(false);
    }, 90_000);
  }

  it('preserves an unmanaged core file with an advisory, then replaces it under --force', () => {
    const { source, target } = setup();
    const file = path.join(target, '.claude/rules/core-core-policy.md');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'operator policy');
    deploy(source, target, 'claude');
    expect(fs.readFileSync(file, 'utf8')).toBe('operator policy');
    deploy(source, target, 'claude', ['--force']);
    expect(fs.readFileSync(file, 'utf8')).toContain('CORE_POLICY');
  }, 90_000);

  it('selects installed bundle dependency closure and never resurrects previous sources', () => {
    const { root, target } = setup();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'aiwg' }));
    const bundle = (kind: string, name: string, manifest = {}) => {
      const dir = path.join(root, 'agentic/code', kind, name); fs.mkdirSync(path.join(dir, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: name, ...manifest }));
      const rule = path.join(dir, 'rules', `${name}.md`); fs.writeFileSync(rule, '---\nactivation: kernel\n---\nPolicy.'); return rule;
    };
    const core = bundle('addons', 'core', { core: true, autoInstall: true });
    const dep = bundle('addons', 'dep', { dependencies: { required: ['core'] } });
    const chosen = bundle('extensions', 'chosen', { dependencies: { required: ['dep'], optional: ['other'] } });
    const other = bundle('frameworks', 'other');
    const opts = { srcRoot: root, target, mode: 'all', kernelOnly: true, config: { installed: { all: {}, chosen: {} } }, previousRuleSources: [other] };
    expect(new Set(collectDeploymentRuleSources(opts))).toEqual(new Set([core, dep, chosen]));
    // Bulk deploy invokes each discovered root in turn; that must not install it.
    expect(new Set(collectDeploymentRuleSources({ ...opts, srcRoot: path.dirname(path.dirname(other)) })))
      .toEqual(new Set([core, dep, chosen]));
    expect(collectDeploymentRuleSources({ ...opts, config: { installed: { all: {} } } })).toEqual([core]);
    expect(collectDeploymentRuleSources({ ...opts, ruleSources: [chosen] })).toEqual([chosen]);
    const sdlc = bundle('frameworks', 'sdlc-complete');
    expect(new Set(collectDeploymentRuleSources({ ...opts, config: { installed: { sdlc: {} } } })))
      .toEqual(new Set([core, sdlc]));
  });

  it('keeps canonical index membership across native and emulated path presentations', () => {
    const rules = [
      { name: 'safety', tagged: true, activation: 'kernel', summary: 'Apply safety.' },
      { name: 'scoped', tagged: true, activation: 'paths', paths: ['src/**'], summary: 'Apply scope.' },
      { name: 'guide', tagged: true, activation: 'summary', summary: 'Read guidance.' },
    ];
    for (const native of [true, false]) {
      const index = renderRuleKernelIndex(rules, native);
      expect(index.match(/^- /gm)).toHaveLength(3);
      for (const rule of rules) expect(index).toContain(`- ${rule.name}`);
    }
  });

  it('states the shared fetch obligation once and preserves every name and summary verbatim', () => {
    const rules = [
      { name: 'unsummarized', tagged: true, activation: 'kernel' },
      { name: 'safety', tagged: true, activation: 'kernel', summary: 'Keep `literal` wording — including punctuation!' },
      { name: 'guide', tagged: true, activation: 'summary', summary: 'Read guidance.' },
    ];
    expect(renderRuleKernelIndex(rules)).toBe([
      '# Rule kernel index', '',
      "Fetch a rule's full body when a task or discovered component needs it: `aiwg show rule <name> --body`.", '',
      '- unsummarized', '', '- safety — Keep `literal` wording — including punctuation!', '',
      '- guide — Read guidance.', '',
    ].join('\n'));
  });

  it('preserves receipt command entries for deployment accounting consumers', () => {
    expect(renderRuleKernelIndex([
      { name: 'safety', tagged: true, activation: 'kernel' },
      { name: 'guide', tagged: true, activation: 'summary', summary: 'Read guidance.' },
    ], false, true)).toBe([
      '# Rule kernel index', '',
      '- safety — Binding kernel rule. Full rule: `aiwg show rule safety --body`.', '',
      '- guide — Read guidance. Fetch when a task or discovered component needs it: `aiwg show rule guide --body`.', '',
    ].join('\n'));
  });

  it('missing activation stays on demand at every enforcement level; shipped lint rejects it', () => {
    expect(lintRuleActivation('# Rule directory documentation', 'agentic/code/frameworks/demo/rules/README.md', repo)).toEqual([]);
    for (const enforcement of ['critical', 'high', 'medium', 'low']) {
      const text = `---\nenforcement: ${enforcement}\n---\nPolicy.`;
      expect(parseRuleFrontmatter(text).rule?.activation).toBe('on-demand');
      expect(lintRuleActivation(text, 'agentic/code/extensions/example/rules/policy.md', repo)).toContainEqual(
        expect.objectContaining({ severity: 'error', message: expect.stringContaining('on-demand') }));
    }
  });

  it('every migrated extension rule declares and validates its activation', () => {
    let count = 0;
    for (const name of ['dev', 'it', 'net', 'sec', 'stream', 'sys', 'repo-maintainer']) {
      const dir = path.join(repo, 'agentic/code/extensions', name, 'rules');
      for (const file of fs.readdirSync(dir).filter(file => file.endsWith('.md'))) {
        const parsed = parseRuleFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8'));
        expect(parsed.valid, file).toBe(true); expect(parsed.rule?.tagged, file).toBe(true); count++;
      }
    }
    expect(count).toBe(22);
  });

  it('a near-ceiling agent stays dispatchable using a compact pointer to exactly the selected bound rules', () => {
    const { source, target } = setup();
    const agent = path.join(source, 'agents/fixture-agent.md');
    const content = fs.readFileSync(agent, 'utf8');
    fs.writeFileSync(agent, content + 'x'.repeat(16_120 - Buffer.byteLength(content)));
    execFileSync('node', ['--input-type=module', '-e', `
      const { deploy } = await import(${JSON.stringify(path.join(repo, 'tools/agents/providers/claude.mjs'))});
      await deploy(${JSON.stringify({ srcRoot: source, target, mode: 'all', deployRules: true, deploySkills: true,
        bindingEntries: [{ type: 'agent', name: 'fixture-agent', path: agent },
          { type: 'skill', name: 'fixture-skill', path: path.join(source, 'skills/fixture-skill/SKILL.md') },
          { type: 'flow', name: 'fixture-flow', path: path.join(source, 'flows/fixture-flow.yaml') }], force: true, quiet: true })});
    `], { cwd: repo, encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: path.join(target, '../home'), AIWG_ROOT: source,
      AIWG_RULES_INLINE_BUDGET_TOKENS: '0' } });
    const deployed = fs.readFileSync(path.join(target, '.claude/agents/fixture-agent.md'), 'utf8');
    expect(Buffer.byteLength(deployed)).toBeLessThanOrEqual(16 * 1024);
    expect(deployed).toContain('.claude/RULES-BOUND.md#agent-fixture-agent');
    const bindings = fs.readFileSync(path.join(target, '.claude/RULES-BOUND.md'), 'utf8');
    for (const name of ['fixture-bound', 'fixture-paths', 'fixture-summary']) expect(bindings).toContain(`aiwg show rule ${name} --body`);
    expect(bindings).not.toContain('fixture-on-demand');
    expect(deployed.match(/<!-- AIWG:bound-rules:start -->/g)).toHaveLength(1);
    expect(deployed).not.toContain('Follow the fixture bound policy.');
    const skill = fs.readFileSync(path.join(target, '.claude/skills/fixture-skill/SKILL.md'), 'utf8');
    expect(skill).toContain('Follow the fixture bound policy.');
    expect(skill).toContain('Fetch and follow before governed work: `aiwg show rule fixture-bound --body`');
    expect(skill.match(/aiwg show rule fixture-bound --body/g)).toHaveLength(1);
    expect(skill.match(/<!-- AIWG:bound-rules:start -->/g)).toHaveLength(1);
  }, 90_000);
});
