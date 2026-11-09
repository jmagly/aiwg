// Minimal hooks must reach complete per-harness contracts and survive redeployment.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileWithCapture as execFileSync } from '../../helpers/exec-file-capture.js';
import { readRuleDeliveryContext } from '../../helpers/rule-delivery-context.js';
import { generate } from '../../../src/smiths/context-pipeline/index.js';
import { inlineStartup, projectStartup } from '../../../tools/agents/providers/rule-startup.mjs';

const repo = path.resolve(__dirname, '../../..');
const roots: string[] = [];
const read = (file: string) => fs.readFileSync(file, 'utf8');
const factoryInstructions = " On every new request, your first tool call must be the shell command `aiwg discover --stdin <<'AIWG_REQUEST'` "
  + "with the request text on the next lines and `AIWG_REQUEST` on the last line; never put request text in quotes on a command line. Answer from its result. "
  + "Answering or declining without running it violates the skill-discovery rule. Use the `aiwg` CLI, not droid's built-in Skill tool. "
  + "Before writing an issue, comment, PR, report or SDLC artifact, run the same heredoc command with `--type template` and `<output> template` as the text, "
  + "read the chosen template with `aiwg show template <name> --body`, and fill every required section.";
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rule-hooks-')); roots.push(root);
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  fs.cpSync(path.join(repo, 'test/fixtures/rule-delivery'), source, { recursive: true });
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'rules/core-policy.md'), '---\nactivation: core\n---\nFull policy.');
  fs.writeFileSync(path.join(source, 'rules/core-policy.core.md'), 'CORE_POLICY');
  return { root, source, target };
}
function deploy(root: string, provider: string, kernelOnly = true) {
  let source = path.join(root, 'source');
  const target = path.join(root, 'target');
  if (provider === 'omp') {
    const corpus = path.join(root, 'omp-corpus');
    const bridge = path.join(corpus, 'agentic/code/providers/omp/aiwg-bridge.ts');
    fs.mkdirSync(path.dirname(bridge), { recursive: true });
    fs.mkdirSync(path.join(corpus, 'agentic/code/frameworks'), { recursive: true });
    const bundle = path.join(corpus, 'agentic/code/addons/fixture');
    if (!fs.existsSync(bundle)) fs.cpSync(source, bundle, { recursive: true });
    fs.writeFileSync(bridge, '// Synthetic local extension.\nexport default function () {}\n');
    source = bundle;
  }
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { deploy } = await import(${JSON.stringify(path.join(repo, 'tools/agents/providers'))} + '/' + ${JSON.stringify(provider)} + '.mjs');
    const report = await deploy(${JSON.stringify({ srcRoot: source, target, mode: 'all', kernelOnly, deployRules: true, quiet: true, ruleSources: fs.readdirSync(path.join(source, 'rules')).filter(file => !file.endsWith('.core.md')).map(file => path.join(source, 'rules', file)) })});
    console.log('REPORT:' + JSON.stringify(report));
  `], { cwd: repo, encoding: 'utf8', timeout: 60_000, stdio: 'pipe', env: {
    PATH: process.env.PATH, HOME: path.join(root, 'home'), HERMES_HOME: path.join(root, 'home/.hermes'),
    AIWG_ROOT: source, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    AIWG_RULES_INLINE_BUDGET_TOKENS: '0', CI: '1',
  } });
  return JSON.parse(stdout.split('REPORT:')[1].trim());
}

describe('per-harness rule hooks (#3740)', () => {
  it('keeps Codex deployment and regeneration discover-first without a prompt hook (#4036)', async () => {
    const { root, target } = setup();
    deploy(root, 'codex');
    const index = read(path.join(target, '.codex/rules/RULES-INDEX.md'));
    expect(index).toContain('On a new task, first run discovery for the request');
    for (const regenerate of [false, true]) {
      if (regenerate) {
        const file = path.join(target, 'AGENTS.md');
        fs.writeFileSync(file, read(file).replace(/On a new task[^\n]*\n\n/, '').replace('After discovery, read', 'Read'));
        await generate({ projectPath: target, provider: 'codex', sections: [], detectExistingFiles: true });
      }
      const content = read(path.join(target, 'AGENTS.md'));
      expect(content).toContain('On a new task, first run discovery for the request');
      expect(content).toContain('before any other tool call or answer');
      expect(content.indexOf('aiwg discover --stdin')).toBeLessThan(content.indexOf('[WORKSPACE.md]'));
      expect(content).toContain('After discovery, read and follow [WORKSPACE.md]');
      expect(content.match(/AIWG:rule-core:start/g)).toHaveLength(1);
      expect(content).toContain('CORE_POLICY');
      expect(content.match(/AIWG:rule-hook-codex:start/g)).toHaveLength(1);
    }
  });

  it.each(['copilot', 'grok-build'])('%s carries discover-first when prompt hooks cannot inject context (#3996)', provider => {
    const { target } = setup();
    const files = projectStartup({ target }, { name: provider }, '', path.join(target, 'rules/RULES-INDEX.md'));
    for (const file of files) {
      expect(read(file)).toContain("aiwg discover --stdin <<'AIWG_REQUEST'");
      expect(read(file)).toContain('Before any other tool call or answer');
      expect(read(file)).toContain('aiwg show <type> <name>');
      expect(read(file)).toContain('--rules --with-rule-bodies');
      projectStartup({ target }, { name: provider }, '', path.join(target, 'rules/RULES-INDEX.md'));
      expect(read(file).match(/Before any other tool call or answer/g)).toHaveLength(1);
    }
  });

  it.each([...Object.keys(inlineStartup), 'openclaw'])('%s preserves rule routing and the Factory template instruction (#3942, #3996)', provider => {
    const { target } = setup();
    const indexFile = path.join(target, `.${provider}/rules/RULES-INDEX.md`);
    const files = projectStartup({ target, activeWorkspace: target }, { name: provider }, '', indexFile);
    for (const file of files) {
      const location = `.${provider}/rules/RULES-INDEX.md`;
      const original = `${provider}: Before every task and subagent task, read and follow \`${location}\`; read every listed kernel file and fetch matching full rules before governed work.`;
      const hook = read(file).split(`<!-- AIWG:rule-hook-${provider}:start -->\n`)[1].split(`\n<!-- AIWG:rule-hook-${provider}:end -->`)[0];
      if (['copilot', 'grok-build'].includes(provider)) expect(hook.startsWith(original)).toBe(true);
      else expect(hook).toBe(original + (provider === 'factory' ? factoryInstructions : ''));
      if (provider === 'factory') {
        expect(hook).toContain("aiwg discover --stdin <<'AIWG_REQUEST'");
        expect(hook).toContain('never put request text in quotes on a command line');
        expect(hook).toContain('aiwg show template <name> --body');
        expect(hook).toContain('fill every required section');
      }
    }
  });

  it.each(['codex', 'muse', 'factory', 'antigravity', 'pi', 'copilot', 'omp', 'warp', 'hermes', 'grok-build', 'windsurf', 'opencode'])('%s reaches complete kernel files and indexes through its hook', provider => {
    const { root, target } = setup();
    const report = deploy(root, provider);
    const reached = readRuleDeliveryContext(report, provider);
    expect(reached).toContain('FIXTURE_KERNEL_BODY');
    expect(reached).toContain('Follow the fixture summary policy.');
    const dir = provider === 'opencode' ? '.opencode/rule' : provider === 'grok-build' ? '.grok/rules'
      : provider === 'copilot' ? '.github/instructions' : `.${provider}/rules`;
    expect(read(path.join(target, dir, 'fixture-kernel.md'))).toContain('FIXTURE_KERNEL_BODY');
    if (provider === 'windsurf') {
      expect(read(path.join(target, dir, 'fixture-kernel.md'))).toContain('trigger: always_on');
      const scoped = read(path.join(target, dir, 'fixture-paths.md'));
      expect(scoped).toContain('trigger: glob'); expect(scoped).toContain('glob: src/**');
      expect(scoped).toContain('FIXTURE_PATHS_BODY');
    } else {
      expect(read(path.join(target, dir, 'RULES-INDEX.md'))).toContain('src/**');
      expect(fs.existsSync(path.join(target, dir, 'fixture-paths.md'))).toBe(false);
    }
    if (provider === 'opencode') {
      const config = JSON.parse(read(path.join(target, 'opencode.json')));
      expect(config.instructions).toContain('.opencode/rule/*.md');
    }
    const before = read(path.join(target, dir, 'RULES-INDEX.md'));
    deploy(root, provider);
    expect(read(path.join(target, dir, 'RULES-INDEX.md'))).toBe(before);
  }, 90_000);

  it('keeps every shared AGENTS hook and operator text when upgrading a 20 KB inline bridge and regenerating', async () => {
    const { root, target } = setup();
    const bridge = path.join(target, 'AGENTS.md');
    fs.writeFileSync(bridge, '# Operator before\n<!-- BEGIN AIWG-managed (auto-generated; legacy) -->\n' + 'old generated '.repeat(1600) +
      '\n<!-- END AIWG-managed -->\n<!-- AIWG:rule-startup:start -->\nSTALE_KERNEL\n<!-- AIWG:rule-startup:end -->\nOperator after\n');
    const reports = ['codex', 'muse', 'factory'].map(provider => ({ provider, report: deploy(root, provider) }));
    for (const provider of ['codex', 'muse', 'factory'] as const) {
      await generate({ projectPath: target, provider, sections: [], detectExistingFiles: true });
    }
    for (const { provider, report } of reports) readRuleDeliveryContext(report, provider);
    const content = read(bridge);
    expect(content.split('<!-- AIWG:rule-hook-factory:start -->\n')[1].split('\n<!-- AIWG:rule-hook-factory:end -->')[0]).toBe(
      'factory: Before every task and subagent task, read and follow `.factory/rules/RULES-INDEX.md`; read every listed kernel file and fetch matching full rules before governed work.' + factoryInstructions);
    expect(content).toContain('# Operator before'); expect(content).toContain('Operator after');
    expect(content).not.toContain('STALE_KERNEL'); expect(content).not.toContain('old generated');
    expect(content).not.toContain('FIXTURE_KERNEL_BODY');
    expect(content.match(/CORE_POLICY/g)).toHaveLength(1);
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(4096);
  }, 90_000);

  it('F1 suppresses legacy Hermes directives on full deploy and retires them on redeploy', () => {
    const { root, target } = setup();
    deploy(root, 'hermes', false);
    for (const name of ['AGENTS.md', '.hermes.md']) {
      const file = path.join(target, name);
      const initial = read(file);
      expect.soft(initial).not.toContain('### Rule: token-security');
      expect.soft(initial).not.toContain('CRITICAL Rules (always apply)');
      fs.writeFileSync(file, initial + '\n## CRITICAL Rules (always apply)\n\n### Rule: token-security\nNever hard-code tokens, API keys, or secrets in source files or commit messages.\n\n## Operator after\nKeep me.\n');
    }
    deploy(root, 'hermes', false);
    for (const name of ['AGENTS.md', '.hermes.md']) {
      const content = read(path.join(target, name));
      expect(content).not.toContain('CRITICAL Rules (always apply)');
      expect(content).not.toContain('### Rule: token-security');
      expect(content).toContain('## Operator after\nKeep me.');
      expect(content.match(/CORE_POLICY/g)).toHaveLength(1);
      expect(content.match(/AIWG:rule-hook-hermes:start/g)).toHaveLength(1);
    }
  }, 90_000);

  it('F2 registers OpenCode framework context and shallow rules while preserving operator entries', () => {
    const { root, target } = setup();
    const file = path.join(target, 'opencode.json');
    fs.writeFileSync(file, JSON.stringify({ model: 'operator-model', instructions: ['operator.md', 'AGENTS.md', 'operator.md'] }));
    deploy(root, 'opencode');
    const config = JSON.parse(read(file));
    expect(config.model).toBe('operator-model');
    expect(config.instructions.slice(0, 2)).toEqual(['operator.md', 'AGENTS.md']);
    expect([...config.instructions].sort()).toEqual(['operator.md', 'AGENTS.md', 'AIWG.md', '.opencode/rule/*.md'].sort());
    const before = read(file);
    deploy(root, 'opencode');
    expect(read(file)).toBe(before);
  }, 90_000);

  it('F5 retires only removed provider hooks from shared startup on next deployment', () => {
    const { root, target } = setup();
    fs.mkdirSync(path.join(target, '.aiwg'));
    const config = path.join(target, '.aiwg/aiwg.config');
    fs.writeFileSync(config, JSON.stringify({ providers: ['codex', 'muse', 'hermes'] }));
    for (const provider of ['codex', 'muse', 'hermes']) deploy(root, provider);
    const removedDir = path.join(target, '.muse/rules');
    const managed = read(path.join(removedDir, 'fixture-kernel.md'));
    fs.writeFileSync(path.join(removedDir, 'operator.md'), 'Operator rule.');
    fs.writeFileSync(config, JSON.stringify({ providers: ['codex', 'hermes'] }));
    deploy(root, 'codex');
    const bridge = read(path.join(target, 'AGENTS.md'));
    expect(bridge).not.toContain('AIWG:rule-hook-muse:');
    expect(bridge).toContain('AIWG:rule-hook-codex:start');
    expect(bridge).toContain('AIWG:rule-hook-hermes:start');
    expect(read(path.join(removedDir, 'fixture-kernel.md'))).toBe(managed);
    expect(read(path.join(removedDir, 'operator.md'))).toBe('Operator rule.');
  }, 90_000);

  it.each(['claude', 'cursor', 'windsurf', 'opencode', 'grok-build'])('F4 rejects an unreachable %s kernel index entry and restores it', provider => {
    const { root, target } = setup();
    const report = deploy(root, provider);
    const dir = provider === 'opencode' ? '.opencode/rule' : provider === 'grok-build' ? '.grok/rules' : `.${provider}/rules`;
    const file = path.join(target, dir, `RULES-INDEX.${provider === 'cursor' ? 'mdc' : 'md'}`);
    const original = read(file);
    fs.writeFileSync(file, original.replace(/^- fixture-kernel[^\n]*\n/gm, ''));
    expect(() => readRuleDeliveryContext(report, provider)).toThrow();
    fs.writeFileSync(file, original);
    readRuleDeliveryContext(report, provider);
  }, 90_000);

  it.each(['windsurf', 'cursor', 'opencode'])('F4 rejects a disabled %s native loader and restores it', provider => {
    const { root, target } = setup();
    const report = deploy(root, provider);
    const file = path.join(target, provider === 'opencode' ? 'opencode.json' : provider === 'cursor'
      ? '.cursor/rules/fixture-kernel.mdc' : '.windsurf/rules/fixture-kernel.md');
    const original = read(file);
    readRuleDeliveryContext(report, provider);
    fs.writeFileSync(file, provider === 'opencode' ? JSON.stringify({ instructions: ['AGENTS.md', 'AIWG.md'] })
      : original.replace(provider === 'cursor' ? 'alwaysApply: true' : 'trigger: always_on', provider === 'cursor' ? 'alwaysApply: false' : 'trigger: manual'));
    expect(() => readRuleDeliveryContext(report, provider)).toThrow();
    fs.writeFileSync(file, original);
    readRuleDeliveryContext(report, provider);
  }, 90_000);

  it('F6 records Grok always-on project rule discovery beside its projection', () => {
    const source = read(path.join(repo, 'tools/agents/providers/grok-build.mjs'));
    expect(source).toMatch(/rules: 'native',[^\n]*always-on/);
    expect(source).toContain('https://docs.x.ai/build/features/project-rules');
    expect(source).toContain('no frontmatter marker');
  });

  it.each(['codex', 'windsurf', 'hermes'].flatMap(provider => ['drop hook', 'drop kernel file', 'inline kernel body'].map(mutation => ({ provider, mutation }))))('negative control $provider rejects $mutation, then passes after restoring', ({ provider, mutation }) => {
    const { root, target } = setup();
    const report = deploy(root, provider);
    const bridge = path.join(target, 'AGENTS.md'), kernel = path.join(target, `.${provider}/rules/fixture-kernel.md`);
    const original = read(bridge), body = read(kernel);
    readRuleDeliveryContext(report, provider);
    if (mutation === 'drop hook') fs.writeFileSync(bridge, original.replace(new RegExp(`${provider}: Before every task[^\\n]*`, 'g'), ''));
    if (mutation === 'drop kernel file') fs.rmSync(kernel);
    if (mutation === 'inline kernel body') fs.writeFileSync(bridge, original + '\n' + body.replace(/^---\n[\s\S]*?\n---\s*/, ''));
    expect(() => readRuleDeliveryContext(report, provider)).toThrow();
    console.info(`Negative control rejected: ${mutation}`);
    fs.writeFileSync(bridge, original); fs.writeFileSync(kernel, body);
    readRuleDeliveryContext(report, provider);
  }, 90_000);
});
