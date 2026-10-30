import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const repo = path.resolve(__dirname, '../../..');
const roots: string[] = [];
const surfaces: Record<string, string> = {
  copilot: '.github/copilot-instructions.md', factory: 'AGENTS.md', opencode: 'AGENTS.md',
  windsurf: 'AGENTS.md', antigravity: 'AGENTS.md', muse: 'AGENTS.md', omp: '.omp/AGENTS.md', 'grok-build': 'AGENTS.md',
};
const core = fs.readFileSync(path.join(repo, 'agentic/code/addons/aiwg-utils/rules/anti-laziness.core.md'), 'utf8').trim();
const noAttribution = fs.readFileSync(path.join(repo, 'agentic/code/addons/aiwg-utils/rules/no-attribution.core.md'), 'utf8').trim();
afterAll(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function setup() {
  // Each root is created directly under TMPDIR and removed after the suite;
  // a shared parent directory would outlive it and trip the leak gate.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-3457-legacy-')); roots.push(root);
  const target = path.join(root, 'project'); fs.mkdirSync(target);
  const env = { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'home/.config'),
    XDG_DATA_HOME: path.join(root, 'home/.local/share'), AIWG_ROOT: repo, AIWG_RULES_INLINE_BUDGET_TOKENS: '0' };
  return { root, target, env };
}
describe('legacy provider core projection (#3457)', () => {
  for (const [provider, surface] of Object.entries(surfaces)) {
    it(`${provider}: general rule deployment puts compact core first in native startup`, async () => {
      const { target, env } = setup();
      await run(process.execPath, ['--input-type=module', '-e', `
        const { deploy } = await import(${JSON.stringify(path.join(repo, 'tools/agents/providers', provider + '.mjs'))});
        await deploy(${JSON.stringify({ srcRoot: repo, target, mode: 'general', deployRules: true, rulesOnly: true, force: true, quiet: true })});
      `], { cwd: repo, env, encoding: 'utf8', timeout: 120_000 });
      const content = fs.readFileSync(path.join(target, surface), 'utf8');
      expect(content).toContain(core);
      expect(content).toContain(noAttribution);
      expect(content).not.toMatch(/@\S*anti-laziness/);
      const block = content.split('<!-- AIWG:rule-core:start -->')[1];
      expect(block.trimStart()).toMatch(/^## Core rules/);
      expect(content.match(/<!-- AIWG:rule-core:start -->/g)).toHaveLength(1);
      expect(block.split('<!-- AIWG:rule-core:end -->')[0]).not.toMatch(/<!-- AIWG:[\w-]+:(?:start|end) -->/);
      expect(content).not.toContain('agent-friendly-code');
      const dir = provider === 'copilot' ? '.github/instructions' : provider === 'opencode' ? '.opencode/rule' : provider === 'grok-build' ? '.grok/rules' : `.${provider}/rules`;
      expect(content).toContain(`${provider}: Before every task and subagent task, read and follow \`${dir}/RULES-INDEX.md\``);
      const body = fs.readFileSync(path.join(repo, 'agentic/code/addons/aiwg-utils/rules/skill-discovery.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\s*/, '').trim();
      expect(fs.readFileSync(path.join(target, dir, 'skill-discovery.md'), 'utf8')).toContain('Run `aiwg discover');
      expect(content).not.toContain(body);
      expect(content.indexOf('## Core rules')).toBeLessThan(content.indexOf(`${provider}: Before every task`));
    }, 120_000);
  }

  for (const [provider, surface] of Object.entries(surfaces)) {
    it.concurrent(`${provider}: use all delivers core without installing sdlc-complete`, async () => {
      const { target, env } = setup();
      await run(process.execPath, [path.join(repo, 'bin/aiwg.mjs'), 'use', 'all', '--provider', provider,
        '--target', target, '--force'], { cwd: target, env, encoding: 'utf8', timeout: 900_000 });
      const startup = fs.readFileSync(path.join(target, surface), 'utf8');
      expect(startup).toContain(core);
      expect(startup).toContain(noAttribution);
      const dir = provider === 'copilot' ? '.github/instructions' : provider === 'opencode' ? '.opencode/rule' : provider === 'grok-build' ? '.grok/rules' : `.${provider}/rules`;
      expect(startup).toContain(`${provider}: Before every task and subagent task, read and follow \`${dir}/RULES-INDEX.md\``);
      expect(fs.readFileSync(path.join(target, dir, 'skill-discovery.md'), 'utf8')).toContain('Run `aiwg discover');
      expect(startup).not.toContain('## Rule: skill-discovery');
      const config = JSON.parse(fs.readFileSync(path.join(target, '.aiwg/aiwg.config'), 'utf8'));
      expect(config.installed).not.toHaveProperty('sdlc-complete');
    }, 900_000);
  }
});
