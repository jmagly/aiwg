// Exercise preserved ownership through the shared stage/commit path for every selector.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { prepareRuleDeployment, commitRuleDeploymentPlan } from '../../../tools/agents/providers/rule-delivery.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
it.each(['antigravity', 'claude', 'factory', 'codex', 'opencode', 'copilot', 'cursor', 'flue', 'pi', 'omp',
  'deepseek-harness', 'warp', 'windsurf', 'hermes', 'openclaw', 'openhuman', 'grokbot', 'grok-build', 'muse'])(
  '%s stage and commit retain the original record when a helper only rewrites receipts', async name => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-preserved-record-')); roots.push(root);
    const source = path.join(root, 'source'), target = path.join(root, 'target');
    fs.mkdirSync(source);
    const relative = '.agents/skills/demo';
    const dir = path.join(target, relative);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md'), sidecar = path.join(dir, '.aiwg-manifest.json');
    const edited = '# aiwg:managed v1 bundled\nOriginal\n# operator note\n';
    const original = { hash: digest('Original'), owners: ['voice-framework'], kind: 'skill', frameworkSlug: 'voice-framework' };
    fs.writeFileSync(file, edited);
    fs.writeFileSync(sidecar, JSON.stringify({ managed: { 'SKILL.md': original } }));
    // Use synthetic writers; the shared transaction and recorder are real.
    const provider = { name, paths: { skills: '.agents/skills', rules: `.${name}/rules` },
      kernelSkillsPath: path.join(root, 'home', `.${name}/skills`),
      deploymentFiles: () => [], assertContextBudget: () => {} };
    const opts = { srcRoot: source, target, provider: name, mode: 'sdlc', skillsOnly: true,
      ruleSources: [], bindingEntries: [], pinConfigs: { project: {}, user: {} }, quiet: true };
    for (let pass = 0; pass < 2; pass++) {
      const plan = await prepareRuleDeployment(opts, provider, async staged => {
        const stagedDir = path.join(staged.target, relative);
        fs.writeFileSync(path.join(stagedDir, '.aiwg-manifest.json'), JSON.stringify({
          skillSource: path.join(staged.srcRoot, 'skills/demo'),
          managed: { 'SKILL.md': { hash: digest(edited), frameworkSlug: 'voice-framework' } },
        }));
      });
      commitRuleDeploymentPlan(plan);
      expect(fs.readFileSync(file, 'utf8')).toBe(edited);
      expect(JSON.parse(fs.readFileSync(sidecar, 'utf8')).managed['SKILL.md']).toEqual(original);
    }
  },
);
