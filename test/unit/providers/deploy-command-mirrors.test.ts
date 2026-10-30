// Guard the legacy source selection and default command mirror policy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error provider tool module has no TypeScript declaration
import { mirrorSkillsAsCommands } from '../../../tools/agents/deploy-command-mirrors.mjs';
// @ts-expect-error provider tool module has no TypeScript declaration
import { finishBindings } from '../../../tools/agents/providers/rule-delivery-surface.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
let scratch: string;
let source: string;
function skill(parent: string, name: string) {
  const dir = path.join(source, parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture ${name}\n---\nRun ${name}.\n`);
}
function commands(dir: string) { return fs.readdirSync(dir).filter(name => name.endsWith('.md')).sort(); }
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-command-mirrors-'));
  source = path.join(scratch, 'source');
  skill('skills', 'flow-direct');
  skill('skills', 'not-a-command');
  skill('agentic/code/frameworks/sdlc-complete/skills', 'flow-sdlc');
  skill('agentic/code/frameworks/media-marketing-kit/skills', 'flow-marketing');
  skill('agentic/code/addons/aiwg-utils/skills', 'flow-utils');
  skill('agentic/code/addons/aiwg-utils/skills', 'aiwg-help');
});
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('command mirror split preserves legacy behavior', () => {
  it.each(['sdlc', 'marketing'])('binds late framework wrappers only when selected (installed=%s)', installed => {
    const target = path.join(scratch, 'target');
    const provider = { name: 'claude', paths: { commands: '.claude/commands' } };
    const flow = path.join(source, 'agentic/code/frameworks/sdlc-complete/flows/flow-sdlc.md');
    const opts = { srcRoot: source, mode: 'marketing', deployCommands: true, target,
      deploymentHome: path.join(scratch, 'home'), config: { installed: { [installed]: {} } }, ruleDelivery: {
        targets: [{ type: 'flow', name: 'flow-sdlc', source: flow }],
        bindings: new Map([[flow, [{ name: 'flow-rule', summary: 'Flow contract.' }]]]),
      } };
    mirrorSkillsAsCommands(provider, target, source, { ...opts, mode: 'sdlc' });
    const file = path.join(target, '.claude/commands/flow-sdlc.md');
    const original = fs.readFileSync(file);
    for (let pass = 0; pass < 2; pass++) {
      finishBindings(opts, provider);
      if (installed === 'sdlc') {
        expect(fs.readFileSync(path.join(target, '.claude/RULES-BOUND.md'), 'utf8')).toContain('## flow-flow-sdlc');
        expect(fs.readFileSync(file, 'utf8')).toContain('<!-- AIWG:bound-rules:start -->');
      } else {
        expect(fs.existsSync(path.join(target, '.claude/RULES-BOUND.md'))).toBe(false);
        expect(fs.readFileSync(file)).toEqual(original);
      }
    }
  });

  it('retains the legacy flow lookup when a wrapper also records its source skill', () => {
    const target = path.join(scratch, 'target');
    const provider = { name: 'claude', paths: { commands: '.claude/commands' } };
    const sourcePath = path.join(source, 'skills/flow-direct/SKILL.md');
    const flowPath = path.join(source, 'flows/flow-direct.md');
    const opts = { mode: 'general', deployCommands: true, target, deploymentHome: path.join(scratch, 'home'), ruleDelivery: {
      targets: [{ type: 'skill', name: 'flow-direct', source: sourcePath }, { type: 'flow', name: 'flow-direct', source: flowPath }],
      bindings: new Map([[sourcePath, [{ name: 'skill-rule', summary: 'Skill contract.' }]],
        [flowPath, [{ name: 'flow-rule', summary: 'Flow contract.' }]]]),
    } };
    mirrorSkillsAsCommands(provider, target, source, opts);
    finishBindings(opts, provider);
    const file = path.join(target, '.claude/commands/flow-direct.md');
    const first = fs.readFileSync(file);
    const index = fs.readFileSync(path.join(target, '.claude/RULES-BOUND.md'), 'utf8');
    expect(index).toContain('## flow-flow-direct');
    expect(index).toContain('flow-rule');
    expect(index).not.toContain('skill-rule');
    finishBindings(opts, provider);
    expect(fs.readFileSync(file)).toEqual(first);
  });

  it('keeps late command ownership metadata from changing bindings on redeploy', () => {
    const target = path.join(scratch, 'target');
    const provider = { name: 'claude', paths: { commands: '.claude/commands' } };
    const sourcePath = path.join(source, 'skills/flow-direct/SKILL.md');
    const entry = { type: 'skill', name: 'flow-direct', source: sourcePath };
    const opts = { mode: 'general', deployCommands: true, target, deploymentHome: path.join(scratch, 'home'), ruleDelivery: {
      targets: [entry], bindings: new Map([[sourcePath, [{ name: 'fixture-rule', summary: 'Read the rule.' }]]]),
    } };
    mirrorSkillsAsCommands(provider, target, source, opts);
    const file = path.join(target, '.claude/commands/flow-direct.md');
    const original = fs.readFileSync(file, 'utf8');
    for (let pass = 0; pass < 2; pass++) {
      finishBindings(opts, provider);
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
      expect(fs.existsSync(path.join(target, '.claude/RULES-BOUND.md'))).toBe(false);
    }
  });

  it.each(['deployCommands', 'commandsOnly'])('defaults the policy for a caller setting %s', flag => {
    skill('skills', 'aiwg-help');
    skill('skills', 'project-status');
    const target = path.join(scratch, 'target');
    expect(mirrorSkillsAsCommands({ name: 'codex', paths: { commands: '.codex/prompts' } }, target, source,
      { mode: 'marketing', [flag]: true })).toBe(4);
    expect(commands(path.join(target, '.codex/prompts'))).toEqual([
      'aiwg-help.md', 'flow-direct.md', 'flow-marketing.md', 'project-status.md',
    ]);
  });

  it('honors an explicit policy and the native kernel exclusion', () => {
    skill('skills', 'aiwg-help');
    const provider = { name: 'claude', paths: { commands: '.claude/commands' } };
    const opts = { mode: 'general', deployCommands: true, commandMirrorPolicy: {
      standard: new Set(['not-a-command', 'aiwg-help']), kernel: new Set(['aiwg-help']),
    } };
    expect(mirrorSkillsAsCommands(provider, scratch, source, opts)).toBe(2);
    expect(commands(path.join(scratch, '.claude/commands'))).toEqual(['flow-direct.md', 'not-a-command.md']);
  });

  it.each(['claude', 'codex', 'hermes'])('%s --source deploy writes exactly the legacy command files', provider => {
    const home = path.join(scratch, 'home'); fs.mkdirSync(home);
    for (const [mode, expected] of [
      ['general', ['flow-direct.md']],
      ['sdlc', ['flow-direct.md', 'flow-sdlc.md']],
      ['marketing', ['flow-direct.md', 'flow-marketing.md']],
      ['all', ['flow-direct.md', 'flow-marketing.md', 'flow-sdlc.md', 'flow-utils.md', ...(provider === 'codex' ? ['aiwg-help.md'] : [])].sort()],
    ] as const) {
      const target = path.join(scratch, mode);
      const hermesHome = path.join(target, '.hermes');
      const result = spawnSync(process.execPath, [path.join(ROOT, 'tools/agents/deploy-agents.mjs'),
        '--source', source, '--target', target, '--provider', provider, '--mode', mode,
        '--commands-only', '--no-context-files', '--no-attribution', '--deploy-version', '1'], {
        cwd: scratch, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, HERMES_HOME: hermesHome,
          AIWG_ROOT: source, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share') },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const commandDir = `.${provider}/commands`;
      expect(commands(path.join(target, commandDir)), mode).toEqual(expected);
    }
  }, 180_000);
});
