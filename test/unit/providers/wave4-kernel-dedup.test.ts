import { readRuleDeliveryContext } from '../../helpers/rule-delivery-context.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { load } from 'js-yaml';
import { regenerateHandler } from '../../../src/cli/handlers/regenerate.js';

const repo = path.resolve(__dirname, '../../..');
const source = path.join(repo, 'agentic/code/addons/aiwg-utils');
const names = ['human-authorization', 'instruction-comprehension', 'research-before-decision', 'skill-discovery', 'artifact-output-policy'];
const providers = ['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw'];
const read = (file: string) => fs.readFileSync(file, 'utf8');
const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]) : [];
const body = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
const meta = (text: string) => load(text.split('---')[1]) as Record<string, unknown>;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-wave4-'));
const bundle = path.join(root, 'source');

beforeAll(() => {
  fs.mkdirSync(path.join(bundle, 'rules'), { recursive: true });
  for (const name of names) for (const suffix of ['', '-guidance']) {
    fs.copyFileSync(path.join(source, 'rules', `${name}${suffix}.md`), path.join(bundle, 'rules', `${name}${suffix}.md`));
  }
  fs.cpSync(path.join(source, 'skills/aiwg-utils-quickref'), path.join(bundle, 'skills/aiwg-utils-quickref'), { recursive: true });
});
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('Wave 4 compact kernel and startup deduplication (#2944)', () => {
  it('keeps five self-contained kernel cores and explicitly deferred linked companions', () => {
    for (const name of names) {
      const kernel = read(path.join(source, 'rules', `${name}.md`));
      const guidance = read(path.join(source, 'rules', `${name}-guidance.md`));
      expect(meta(kernel).activation, name).toBe('kernel');
      expect(meta(guidance).activation, name).toBe('on-demand');
      expect(kernel).toContain(`(./${name}-guidance.md)`);
      expect(kernel).toContain(`aiwg show rule ${name}-guidance`);
      // Discovery must remain below its existing 3,400-byte kernel ceiling.
      expect(Buffer.byteLength(kernel), name).toBeLessThan(name === 'skill-discovery' ? 3400 : 3300);
      expect(kernel).not.toMatch(/## (?:Overview|Problem Statement|Detection Patterns|Checklist)|```/);
    }
    // Obligations that can easily disappear when examples/rationale are extracted.
    const obligations: Record<string, string[]> = {
      'human-authorization': ['explicit user authorization', 'closing/resolving', 'shared resources', 'platform confirmation', 'revert out-of-scope', 'confirmation checkpoints'],
      'instruction-comprehension': ['prohibitions, constraints, requirements, preferences', '5–10 actions', 'acknowledge corrections', 'first Thought MUST', 'never claim done'],
      'research-before-decision': ['actual configuration', 'actual exports', 'Three or more', 'single informed retry', 'verify success', 'Thought → Edit → Error'],
      'skill-discovery': ['first turn after `/clear`', 'Before consulting it this session', 'Skill errors', 'CLI is broken', 'one-line capability summary'],
      'artifact-output-policy': ['store first', 'Never substitute, relocate, or omit', 'presentation reference, canonical path, authority, and timestamp', 'fail safe', 'Project policy is the ceiling'],
    };
    for (const [name, phrases] of Object.entries(obligations)) for (const phrase of phrases) {
      expect(read(path.join(source, 'rules', `${name}.md`)).toLowerCase(), `${name}: ${phrase}`).toContain(phrase.toLowerCase());
    }
  });

  it('requires discovery execution and reading before capability answers, including unchecked declines (#3311)', () => {
    const kernel = body(read(path.join(source, 'rules/skill-discovery.md')));
    const firstStep = kernel.split('\n').find(line => line.startsWith('- '))!;
    expect(firstStep).toMatch(/^- Run `aiwg discover "<need>"` and read the result before naming, recommending, or declining an AIWG capability/);
    expect(firstStep).toContain('even when asked to decline without checking');
    expect(firstStep).toContain('claim it does not exist');
    expect(kernel).not.toMatch(/query exemptions|need clearly outside AIWG/i);
    expect(firstStep).toContain('never skip before declining');
    for (const suffix of ['', '-guidance']) {
      const text = read(path.join(source, 'rules', `skill-discovery${suffix}.md`));
      expect(text).toContain('returns a card');
      for (const flag of ['--section', '--rules', '--body']) expect(text).toContain(flag);
      expect(text).not.toMatch(/streams the SKILL\.md body|path\/content envelope/);
    }
  });

  it.each(['without running any tools', "don't run anything", 'answer from what you already have'])(
    'suspends discovery only for an explicit current-turn prohibition: %s (#4514)', prompt => {
      for (const suffix of ['', '-guidance']) {
        const text = read(path.join(source, 'rules', `skill-discovery${suffix}.md`));
        expect(text).toContain(prompt);
        expect(text).toContain('current turn');
        expect(text).toContain('for that turn');
        expect(text).toContain('Answer from loaded context');
        expect(text).toContain('I did not run discovery because you asked me not to use tools.');
        expect(text).toContain('even when asked to decline without checking');
      }
      const guidance = read(path.join(source, 'rules/skill-discovery-guidance.md'));
      expect(guidance).toContain('"if not, just say so" still requires discovery');
      expect(guidance).toContain('Do not carry the exception into later turns');
    });

  it('regenerated CLAUDE.md, AIWG.md and quickref contain no duplicated rule text', async () => {
    const project = path.join(root, 'regenerate');
    fs.mkdirSync(path.join(project, '.aiwg'), { recursive: true });
    fs.writeFileSync(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({
      version: '1', providers: ['claude'], installed: {}, scripts: {},
      parallelism: { max_parallel_subagents: 3 },
      artifact_outputs: { canonical: 'aiwg', provider_native: 'disabled' },
    }));
    vi.stubEnv('AIWG_HOME', repo);
    vi.stubEnv('AIWG_CONFIG', path.join(root, 'user-config'));
    const ctx = { args: ['--workspace', '--provider', 'claude'], rawArgs: ['regenerate', '--workspace', '--provider', 'claude'], cwd: project, frameworkRoot: repo };
    // A stale managed block is replaced, while operator content is preserved.
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Operator note\n\n<!-- AIWG:claude-md-hook:start -->\n## AIWG artifact output policy\nNever substitute old duplicate\n<!-- AIWG:claude-md-hook:end -->\n');
    fs.writeFileSync(path.join(project, 'AIWG.md'), '<!-- aiwg-managed -->\n<!-- aiwg-context-finalization:START -->\n### Discover-First Protocol\nClassify every user turn FIRST\n<!-- aiwg-context-finalization:END -->\n');
    for (let pass = 0; pass < 2; pass++) {
      expect((await regenerateHandler.execute(ctx)).exitCode).toBe(0);
      expect(fs.existsSync(path.join(project, '.aiwg/AIWG.md'))).toBe(false);
      const surfaces = ['CLAUDE.md', 'AIWG.md'].map(file => read(path.join(project, file)));
      surfaces.push(read(path.join(source, 'skills/aiwg-utils-quickref/SKILL.md')));
      for (const template of ['aiwg-sections/01-sdlc-framework.md', 'aiwg-sections/02b-discover-first.md', 'project/AIWG.md', 'project/AIWG-sdlc-fragment.md', 'openclaw/AGENTS.md.aiwg-template', 'openhuman/AGENTS.md.aiwg-template', 'copilot/copilot-instructions.md.aiwg-template']) {
        surfaces.push(read(path.join(repo, 'agentic/code/frameworks/sdlc-complete/templates', template)));
      }
      for (const surface of surfaces) {
        expect(surface).not.toMatch(/Discover-First Protocol|Classify every user turn FIRST|Model-selected delegation rubric|## AIWG artifact output policy|Never substitute|## The canonical pipeline|When the platform Skill tool errors|Priority [123] —/);
        // Reject copied imperative sentences, not merely the old section headings.
        for (const name of names) {
          const sentences = body(read(path.join(source, 'rules', `${name}.md`))).split(/\n|(?<=[.!?])\s+/)
            .map(line => line.replace(/^- /, '').trim()).filter(line => line.length >= 90 && !line.startsWith('Supporting rationale'));
          for (const sentence of sentences) expect(surface, `${name}: ${sentence}`).not.toContain(sentence);
        }
      }
      expect(surfaces[0]).toContain('# Operator note');
      expect(surfaces[0]).toContain('`.aiwg/aiwg.config`');
      expect(surfaces[0]).not.toMatch(/^\s*@\S*aiwg\.config/m);
      expect(surfaces[1]).not.toMatch(/^\s*@\S*(aiwg\.config|WORKSPACE\.md)/m);
      expect(surfaces[0]).toContain('aiwg show rule artifact-output-policy');
      expect(surfaces[1]).toContain('aiwg show rule skill-discovery');
      expect(surfaces[1]).toContain('max_parallel_subagents');
      expect(surfaces[1]).toContain('aiwg show rule subagent-scoping');
    }
  }, 60_000);

  for (const provider of providers) it(`${provider}: loads every complete kernel once and no companion (U9)`, () => {
    const project = path.join(root, provider, 'project');
    const home = path.join(root, provider, 'home');
    fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(home, { recursive: true });
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { deploy } = await import(${JSON.stringify(path.join(repo, 'tools/agents/providers', `${provider}.mjs`))});
      const report = await deploy(${JSON.stringify({ srcRoot: bundle, target: project, provider, mode: 'all', deployRules: true,
        deploySkills: true, deployCommands: true, copyStandardSkills: true, force: true, quiet: true })});
      console.log('REPORT:' + JSON.stringify(report));
    `], { cwd: repo, env: { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
      PATH: process.env.PATH, HOME: home, HERMES_HOME: path.join(home, '.hermes'), AIWG_ROOT: bundle,
      XDG_DATA_HOME: path.join(home, '.local/share'), CI: '1' }, encoding: 'utf8', timeout: 60_000, stdio: 'pipe' });
    const report = JSON.parse(output.split('REPORT:')[1].trim());
    const startup = readRuleDeliveryContext(report, provider);
    for (const name of names) {
      // Some adapters shift heading depth; compare every imperative paragraph verbatim.
      const core = body(read(path.join(source, 'rules', `${name}.md`))).split('\n').filter(line => line.startsWith('- '));
      for (const paragraph of core) expect(startup.split(paragraph).length - 1, `${provider}: ${name}`).toBe(1);
      const guidance = body(read(path.join(source, 'rules', `${name}-guidance.md`))).split('\n').find(line => line.startsWith('# '))!;
      expect(startup).not.toContain(guidance);
    }
    const quickrefs = walk(path.join(root, provider)).filter(file => file.endsWith('/aiwg-utils-quickref/SKILL.md'));
    expect(quickrefs.length, `${provider}: deployed quickref`).toBeGreaterThan(0);
    for (const file of quickrefs) {
      const quickref = read(file);
      expect(quickref).toContain('aiwg show rule skill-discovery');
      expect(quickref).not.toMatch(/Priority [123] —|## The canonical pipeline|When the platform Skill tool errors/);
      for (const name of names) for (const paragraph of body(read(path.join(source, 'rules', `${name}.md`))).split('\n').filter(line => line.startsWith('- '))) {
        expect(quickref, `${provider}: ${name} duplicate in quickref`).not.toContain(paragraph);
      }
    }
    if (provider === 'codex') expect(fs.statSync(path.join(project, 'AGENTS.md')).size).toBeLessThan(32768);
  }, 180_000);
});
