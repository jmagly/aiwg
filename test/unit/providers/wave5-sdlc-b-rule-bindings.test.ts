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
import type { ArtifactIndex } from '../../../src/artifacts/types.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const wave = ["lfd-control-tiers", "logs-as-event-streams", "mention-wiring", "no-attribution", "progressive-disclosure", "provenance-tracking", "qualified-references", "reasoning-sections", "reproducibility", "reproducibility-validation", "research-metadata", "sdlc-orchestration", "self-maintenance", "stateless-processes", "tao-loop", "thought-protocol", "token-security", "versioning"];
const providers = ['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw'];
const read = (file: string) => fs.readFileSync(file, 'utf8');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const metadata = (file: string) => parse(read(file).match(/^---\n([\s\S]*?)\n---/)![1]);

describe('Wave 5 sdlc-b canonical rule delivery (#2945)', () => {
  let root: string;
  let source: string;
  let bundle: string;
  let entries: ArtifactIndex['entries'];
  let rules: Array<{ name: string; data: any }>;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-wave5-sdlc-b-'));
    source = path.join(root, 'source');
    bundle = path.join(source, 'agentic/code/addons/wave5-sdlc-b');
    fs.mkdirSync(path.join(bundle, 'rules'), { recursive: true });
    rules = wave.map(name => {
      const owner = name === 'no-attribution' ? 'addons/aiwg-utils' : 'frameworks/sdlc-complete';
      const file = path.join(repo, 'agentic/code', owner, 'rules', `${name}.md`);
      fs.copyFileSync(file, path.join(bundle, 'rules', `${name}.md`));
      const data = metadata(file);
      if (data.activation === 'core') fs.copyFileSync(file.replace(/\.md$/, '.core.md'), path.join(bundle, 'rules', `${name}.core.md`));
      return { name, data };
    });
    // Real indexed names and paths exercise display-name/slugs and canonical
    // precedence; no hand-built binding entries can hide unresolved targets.
    const corpus = path.join(root, 'corpus');
    for (const file of walk(path.join(repo, 'agentic/code')).filter(file =>
      !file.includes('/plugins/') && (file.includes('/agents/') && file.endsWith('.md') || file.endsWith('/SKILL.md') || /\/skills\/[^/]+\.md$/.test(file) || /\/flows\/flow-[^/]+\.playbook\.yaml$/.test(file)))) {
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
      if (type === 'skill' && path.basename(file) === 'SKILL.md') fs.cpSync(path.dirname(file), path.dirname(dest), { recursive: true });
      else fs.copyFileSync(file, dest);
    }
  }, 60_000);
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('records every reviewed disposition and resolves concrete targets (U2)', () => {
    const decisions = JSON.parse(read(path.join(repo, 'test/uat/rule-binding/wave5-sdlc-b-decisions.json')));
    expect(decisions.map((item: any) => item.rule).sort()).toEqual([...wave].sort());
    for (const { name, data } of rules) {
      expect(decisions).toContainEqual(expect.objectContaining({ rule: name,
        activation: data.activation, enforcement: data.enforcement, reason: expect.stringMatching(/\S/) }));
      expect([...data.summary].length).toBeLessThanOrEqual(240);
      if (['core', 'kernel'].includes(data.activation)) expect(data.bound_to).toBeUndefined();
      else expect(Object.values(data.bound_to).flat().length).toBeGreaterThan(0);
      expect(Object.values(data.bound_to ?? {}).flat().every(id => !String(id).includes('*'))).toBe(true);
    }
    expect(rules.filter(rule => rule.data.activation === 'kernel').map(rule => rule.name).sort())
      .toEqual(['token-security']);
    expect(rules.find(rule => rule.name === 'no-attribution')!.data.activation).toBe('core');
    expect(rules.find(rule => rule.name === 'versioning')!.data.activation).toBe('paths');
    expect(rules.find(rule => rule.name === 'sdlc-orchestration')!.data.paths).toContain('.aiwg/**');
  });

  it('validates the standalone probe schema and covers every HIGH/CRITICAL move', async () => {
    const { loadProbes, buildPlan } = await import('../../../tools/rules/run-rule-probes.mjs');
    const probes = loadProbes(path.join(repo, 'test/uat/rule-binding/wave5-sdlc-b-probes.yaml'));
    for (const { name, data } of rules.filter(rule => ['critical', 'high'].includes(rule.data.enforcement)
      && rule.data.activation !== 'kernel')) {
      const entry = probes.rules.find((rule: any) => rule.id === name);
      expect(entry?.probes.map((probe: any) => probe.id)).toEqual(expect.arrayContaining(['positive-1', 'positive-2', 'negative-1']));
    }
    expect(buildPlan(probes, { rules: ['versioning'], n: 5 }).call_count)
      .toBe(probes.rules.find((rule: any) => rule.id === 'versioning').probes.length * 5);
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
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
      AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', CI: '1' };
    // Shipped prebuilt tables cover read gates; cold builds have isolated tests.
    const needs: Record<string, string> = {
      "lfd-control-tiers": "which LFD controls are mechanical",
      "logs-as-event-streams": "how should applications route logs",
      "mention-wiring": "when to add traceability mentions",
      "progressive-disclosure": "how to progressively disclose SDLC templates",
      "provenance-tracking": "what provenance must generated artifacts record",
      "qualified-references": "how to qualify cross references",
      "reasoning-sections": "what reasoning sections do SDLC templates need",
      "reproducibility": "how to make workflow execution reproducible",
      "reproducibility-validation": "how to validate critical workflow reproducibility",
      "research-metadata": "what metadata must research documents contain",
      "sdlc-orchestration": "how to orchestrate canonical SDLC workflows",
      "self-maintenance": "how should agents maintain AIWG",
      "stateless-processes": "where should application process state live",
      "tao-loop": "how to structure iterative agent execution",
      "thought-protocol": "which thought types guide tool using agents",
      "versioning": "how to format release versions and tags"
};
    for (const [name, phrase] of Object.entries(needs)) {
      const result = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'bin/aiwg.mjs'),
        'discover', phrase, '--type', 'rule', '--json'], {
        cwd: repo, env,
        encoding: 'utf8', timeout: 30_000, stdio: 'pipe',
      }));
      expect(result.results.slice(0, 3).map((entry: any) => entry.name), phrase).toContain(name);
    }
  }, 300_000);

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
    if (provider === 'hermes') {
      const chars = read(path.join(project, 'AGENTS.md')).length;
      console.info('Hermes fixture', 'sdlc-b', chars, 'chars');
      expect(chars).toBeLessThanOrEqual(19000); // ADR 220–224: full bodies, no compression.
    }
    const startup = readRuleDeliveryContext(report, provider);
    for (const { name, data } of rules) {
      const canonical = read(path.join(bundle, 'rules', `${name}.md`));
      const body = canonical.replace(/^---\n[\s\S]*?\n---\s*/, '').trim();
      if (data.activation === 'core') {
        expect(startup).toContain(read(path.join(bundle, 'rules', `${name}.core.md`)).trim());
        expect(startup).not.toContain(body);
      }
      if (data.activation === 'kernel') expect(startup, `${provider}: ${name}`).toContain(body);
      if (data.activation === 'summary') {
        expect(startup).toContain(data.summary);
        expect(startup).toContain(`- ${name} — ${data.summary}`);
        expect(startup).toContain(`aiwg show rule ${name} --body`);
        expect(startup).not.toContain(body);
      }
      if (data.activation === 'bound') expect(startup).not.toContain(data.summary);
      if (data.activation === 'paths' && !['claude', 'cursor'].includes(provider)) {
        expect(startup).toContain(data.summary);
        expect(startup).toContain(`aiwg show rule ${name} --body`);
        expect(startup).toContain(`aiwg show rule ${name} --body`);
        expect(startup).not.toContain(body);
        for (const glob of data.paths) expect(startup).toContain(glob);
      }
    }
    const allFiles = walk(path.join(root, provider));
    const outputs = allFiles.filter(file => /\.(md|mdc|toml)$/.test(file));
    for (const { name, data } of rules) {
      const native = allFiles.filter(file => file.includes('/rules/') &&
        new RegExp(`/${name}\\.(?:md|mdc)$`).test(file));
      if (['bound', 'summary'].includes(data.activation)) {
        expect(native, `${provider}: ${name} startup body`).toHaveLength(0);
      }
      if (data.activation === 'paths' && ['claude', 'cursor'].includes(provider)) {
        expect(native, `${provider}: ${name} native scoped body`).toHaveLength(1);
        const content = read(native[0]);
        expect(content).toContain(provider === 'cursor' ? 'globs:' : 'paths:');
        for (const glob of data.paths) expect(content).toContain(glob);
      }
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
  }, 300_000);
});
