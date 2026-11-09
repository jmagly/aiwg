import { readRuleDeliveryContext } from '../../helpers/rule-delivery-context.js';
import { showBindingEnvelopes } from '../../helpers/show-binding-envelopes.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { resolveRuleBindingTarget } from '../../../src/artifacts/query-engine.js';
import { readCoreBody } from '../../../src/rules/activation.mjs';
import type { ArtifactIndex } from '../../../src/artifacts/types.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const wave = ['subagent-scoping', 'god-session', 'auto-compact-continue', 'cli-secondary', 'anti-laziness'];
const providers = ['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw'];
const read = (file: string) => fs.readFileSync(file, 'utf8');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const metadata = (file: string) => parse(read(file).match(/^---\n([\s\S]*?)\n---/)![1]);

describe('Wave 3 canonical orchestration rule delivery (#2943)', () => {
  let root: string;
  let source: string;
  let bundle: string;
  let entries: ArtifactIndex['entries'];
  let rules: Array<{ name: string; data: any }>;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-wave3-'));
    source = path.join(root, 'source');
    bundle = path.join(source, 'agentic/code/addons/wave3');
    fs.mkdirSync(path.join(bundle, 'rules'), { recursive: true });
    rules = wave.map(name => {
      const owner = 'addons/aiwg-utils';
      const file = path.join(repo, 'agentic/code', owner, 'rules', `${name}.md`);
      fs.copyFileSync(file, path.join(bundle, 'rules', `${name}.md`));
      if (fs.existsSync(file.replace(/\.md$/, '.core.md'))) fs.copyFileSync(file.replace(/\.md$/, '.core.md'), path.join(bundle, 'rules', `${name}.core.md`));
      return { name, data: metadata(file) };
    });
    // Real indexed names and paths exercise display-name/slugs and canonical
    // precedence; no hand-built binding entries can hide unresolved targets.
    const corpus = path.join(root, 'corpus');
    for (const file of walk(path.join(repo, 'agentic/code')).filter(file =>
      !file.includes('/plugins/') && (file.includes('/agents/') && file.endsWith('.md') || file.endsWith('/SKILL.md') || /\/flows\/flow-[^/]+\.playbook\.yaml$/.test(file)))) {
      const dest = path.join(corpus, path.relative(repo, file));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
    }
    await buildIndex(corpus, { scope: 'agentic/code', includeIgnored: true, outputDir: root, force: true, quiet: true });
    entries = JSON.parse(read(path.join(root, '.aiwg/.index/metadata.json'))).entries;
    const targets = new Map<string, { type: string; id: string; file: string }>();
    for (const { data } of rules) for (const [kind, ids] of Object.entries(data.bound_to ?? {}) as Array<[string, string[]]>) {
      const type = kind.slice(0, -1) as 'skill' | 'agent' | 'flow';
      for (const id of ids) {
        const target = resolveRuleBindingTarget(Object.values(entries), type, id);
        targets.set(`${type}:${id}`, { type, id, file: path.join(repo, target.path) });
      }
    }
    for (const { type, id, file } of targets.values()) {
      const dest = path.join(bundle, `${type}s`, type === 'skill' ? `${id}/SKILL.md` : type === 'flow' ? `${id}.playbook.yaml` : `${id}.md`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (type === 'skill') fs.cpSync(path.dirname(file), path.dirname(dest), { recursive: true });
      else fs.copyFileSync(file, dest);
    }
  }, 60_000);
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('restores all four budget-demoted rules through summary and concrete bindings (U2)', () => {
    // anti-laziness graduated to the always-loaded core class (#3450): it carries a
    // compact core body instead of summary/bound delivery, so bindings no longer apply.
    const coreRule = rules.find(rule => rule.name === 'anti-laziness')!.data;
    expect(coreRule.activation).toBe('core');
    expect(coreRule.bound_to ?? {}).toEqual({});
    for (const { name, data } of rules.filter(rule => rule.name !== 'anti-laziness')) {
      expect(data.activation, name).toBe('summary');
      expect([...data.summary].length).toBeLessThanOrEqual(240);
      expect(Object.values(data.bound_to).flat().length).toBeGreaterThan(0);
      expect(Object.values(data.bound_to).flat().every(id => !String(id).includes('*'))).toBe(true);
    }
    const scoping = rules.find(rule => rule.name === 'subagent-scoping')!.data;
    expect(scoping.bound_to.skills).toEqual(expect.arrayContaining(['aiwg-mission', 'mission-control', 'ralph', 'rlm-batch', 'rlm-query']));
    expect(scoping.bound_to.flows).toContain('flow-guided-implementation');
    expect(rules.find(rule => rule.name === 'god-session')!.data.bound_to.agents).toContain('agentsmith');
    expect(rules.find(rule => rule.name === 'cli-secondary')!.data.bound_to.agents).toContain('aiwg-finder');
  });

  it('shows every canonical binding through the actual CLI JSON envelope (U4)', async () => {
    const home = path.join(root, 'show-home');
    fs.mkdirSync(home);
    const env = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, AIWG_ROOT: repo,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
      AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', CI: '1' };
    // Shipped prebuilt tables cover read gates; cold builds have isolated tests.
    const targets = new Map<string, { type: string; id: string; rules: Array<{ name: string; data: any }> }>();
    for (const rule of rules) for (const [kind, ids] of Object.entries(rule.data.bound_to ?? {}) as Array<[string, string[]]>) {
      for (const id of ids) {
        const key = `${kind}:${id}`;
        const target = targets.get(key) ?? { type: kind.slice(0, -1), id, rules: [] };
        target.rules.push(rule);
        targets.set(key, target);
      }
    }
    // Check every distinct artifact and every declared rule-artifact pair.
    // Vitest parallelizes files; keep per-file lookups serial to bound resources.
    const requests = [...targets.values()];
    const envelopes = showBindingEnvelopes(repo, env, requests.map(({ type, id }) => ({ type, id })));
    for (const [index, target] of requests.entries()) {
      const shown = envelopes[index];
      for (const { name, data } of target.rules) {
        expect(shown.bound_rules, `${target.type}:${target.id}`).toEqual(expect.arrayContaining([
          expect.objectContaining({ name, activation: data.activation, summary: data.summary,
            show_command: `aiwg show rule ${name} --body` }),
        ]));
      }
    }
  }, 600_000);

  it('ranks each moved rule in the top three for its natural need (U6)', () => {
    const home = path.join(root, 'discover-home');
    fs.mkdirSync(home);
    const env = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
      PATH: process.env.PATH, HOME: home, AIWG_ROOT: repo,
      AIWG_ARTIFACTS_PATH: path.join(home, 'artifacts'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
      AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', CI: '1' };
    // Shipped prebuilt tables cover read gates; cold builds have isolated tests.
    const needs: Record<string, string> = {
      'subagent-scoping': 'how do I split this work',
      'god-session': 'agent has too many responsibilities',
      'auto-compact-continue': 'context is getting long',
      'cli-secondary': 'use a skill or raw CLI',
      'anti-laziness': 'can I skip this test',
    };
    for (const [name, phrase] of Object.entries(needs)) {
      const result = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'bin/aiwg.mjs'),
        'discover', phrase, '--type', 'rule', '--json'], {
        cwd: repo, env,
        encoding: 'utf8', timeout: 30_000, stdio: 'pipe',
      }));
      expect(result.results.slice(0, 3).map((entry: any) => entry.name), phrase).toContain(name);
    }
  }, 180_000);

  for (const provider of providers) it(`${provider}: delivers every declared binding outside startup listings (U3/U9)`, () => {
    const project = path.join(root, provider, 'project');
    const home = path.join(root, provider, 'home');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const deployed = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { deploy } = await import(${JSON.stringify(path.join(repo, 'tools/agents/providers', `${provider}.mjs`))});
      const report = await deploy(${JSON.stringify({ srcRoot: source, target: project, provider, mode: 'all', config: { installed: { [path.basename(bundle)]: {} } },
        deployRules: true, deploySkills: true, deployCommands: true, copyStandardSkills: true,
        force: true, quiet: true })});
      console.log('REPORT:' + JSON.stringify(report));
    `], { cwd: repo, env: { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
      PATH: process.env.PATH, HOME: home, HERMES_HOME: path.join(home, '.hermes'),
      AIWG_ROOT: source, XDG_DATA_HOME: path.join(home, '.local/share'), CI: '1' },
    encoding: 'utf8', timeout: 60_000, stdio: 'pipe' });
    const report = JSON.parse(deployed.split('REPORT:')[1].trim());
    const startup = readRuleDeliveryContext(report, provider);
    for (const { name, data } of rules) {
      if (name === 'anti-laziness') {
        // Core delivery (#3450): the compact body is in startup context; the full rule is not.
        expect(startup, provider).toContain(readCoreBody(path.join(bundle, 'rules', 'anti-laziness.md')));
        expect(startup, provider).toContain('aiwg show rule anti-laziness');
        expect(startup, provider).not.toContain(read(path.join(bundle, 'rules', 'anti-laziness.md')).split('\n').find(line => line.startsWith('# ')) + '\n\n**Enforcement');
        continue;
      }
      expect(startup).toContain(data.summary);
      expect(startup).toContain(data.activation === 'paths' ? `aiwg show rule ${name} --body` : `- ${name} — ${data.summary}`);
      expect(startup).toContain(`aiwg show rule ${name} --body`);
      const heading = read(path.join(bundle, 'rules', `${name}.md`)).split('\n').find(line => line.startsWith('# '));
      expect(startup).not.toContain(heading);
    }
    const allFiles = walk(path.join(root, provider));
    const outputs = allFiles.filter(file => /\.(md|toml)$/.test(file));
    for (const { name } of rules) {
      expect(allFiles.filter(file => file.includes('/rules/') &&
        new RegExp(`/${name}\\.md$`).test(file)), `${provider}: ${name} startup body`).toHaveLength(0);
    }
    for (const { name, data } of rules) for (const [kind, ids] of Object.entries(data.bound_to ?? {}) as Array<[string, string[]]>) {
      for (const id of ids) {
        const definitions = outputs.filter(file => file.includes(`/${kind === 'flows' ? 'skills' : kind}/`) &&
          (kind !== 'agents' ? file.endsWith(`/${id}/SKILL.md`) : new RegExp(`/${id}\\.(?:md|toml)$`).test(file)));
        expect(definitions.length, `${provider} ${kind}:${id}`).toBeGreaterThan(0);
        for (const file of definitions) {
          const content = read(file);
          expect(content.match(/<!-- AIWG:bound-rules:start -->/g), file).toHaveLength(1);
          const index = read(path.join(project, `.${provider}/RULES-BOUND.md`));
          const anchors = [...content.matchAll(/RULES-BOUND\.md#([a-z0-9_-]+)/g)];
          expect(anchors.length, file).toBeGreaterThan(0);
          const bound = anchors.map(match => index.split(`## ${match[1]}\n`)[1]?.split('\n## ')[0] || '').join('\n');
          expect(bound, file).toContain(`aiwg show rule ${name} --body`);
          expect(bound, file).toContain(data.summary);
          if (file.endsWith('/SKILL.md')) {
            expect(content, file).toContain(data.summary);
            const invocation = content.split('<!-- AIWG:bound-rules:start -->')[1].split('<!-- AIWG:bound-rules:end -->')[0];
            expect(invocation.split(`aiwg show rule ${data.name ?? name} --body`), file).toHaveLength(2);
          } else expect(content, file).not.toContain(data.summary);
        }
      }
    }
    for (const file of outputs.filter(file => /\/(?:AGENTS|AIWG|WARP)\.md$/.test(file))) {
      expect(read(file)).not.toContain('<!-- AIWG:bound-rules:start -->');
    }
    if (provider === 'codex') expect(fs.statSync(path.join(project, 'AGENTS.md')).size).toBeLessThan(32768);
  }, 180_000);
});
