import { readRuleDeliveryContext } from '../../helpers/rule-delivery-context.js';
import { showBindingEnvelopes } from '../../helpers/show-binding-envelopes.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import Ajv from 'ajv/dist/2020.js';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { resolveRuleBindingTarget } from '../../../src/artifacts/query-engine.js';
import type { ArtifactIndex } from '../../../src/artifacts/types.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const decisions = JSON.parse(fs.readFileSync(path.join(repo, 'test/uat/rule-binding/wave5-addons-decisions.json'), 'utf8'));
const wave = decisions.map((decision: any) => decision.rule);
const providers = ['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw'];
const read = (file: string) => fs.readFileSync(file, 'utf8');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const metadata = (file: string) => parse(read(file).match(/^---\n([\s\S]*?)\n---/)![1]);

describe('Wave 5 addon rule delivery (#2945)', () => {
  let root: string;
  let source: string;
  let bundle: string;
  let entries: ArtifactIndex['entries'];
  let rules: Array<{ name: string; data: any }>;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-wave5-addons-'));
    source = path.join(root, 'source');
    bundle = path.join(source, 'agentic/code/addons/wave5-addons');
    fs.mkdirSync(path.join(bundle, 'rules'), { recursive: true });
    rules = wave.map((relative: string) => {
      const file = path.join(repo, relative);
      const name = path.basename(file, '.md');
      fs.copyFileSync(file, path.join(bundle, 'rules', `${name}.md`));
      return { name, data: metadata(file) };
    });
    // Real indexed names and paths exercise display-name/slugs and canonical
    // precedence; no hand-built binding entries can hide unresolved targets.
    const corpus = path.join(root, 'corpus');
    for (const file of walk(path.join(repo, 'agentic/code')).filter(file =>
      !file.includes('/plugins/') && (file.includes('/agents/') && file.endsWith('.md') || file.includes('/skills/') && file.endsWith('.md') || /\/flows\/flow-[^/]+\.playbook\.yaml$/.test(file)))) {
      const dest = path.join(corpus, path.relative(repo, file));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
    }
    await buildIndex(corpus, { scope: 'agentic/code', includeIgnored: true, outputDir: root, force: true, quiet: true });
    entries = JSON.parse(read(path.join(root, '.aiwg/.index/metadata.json'))).entries;
    const targets = new Map<string, { type: string; id: string; file: string }>();
    for (const { data } of rules) for (const [kind, ids] of Object.entries(data.bound_to) as Array<[string, string[]]>) {
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

  it('records all 20 decisions with explicit activation, authored summaries and exact targets (U2)', () => {
    expect(rules).toHaveLength(20);
    expect(new Set(decisions.map((d: any) => d.rule)).size).toBe(20);
    expect(rules.filter(rule => rule.data.activation === 'bound')).toHaveLength(14);
    expect(rules.filter(rule => rule.data.activation === 'summary')).toHaveLength(3);
    expect(rules.filter(rule => rule.data.activation === 'paths')).toHaveLength(3);
    for (const { name, data } of rules) {
      expect([...data.summary].length).toBeLessThanOrEqual(240);
      expect(data.summary.length).toBeGreaterThan(0);
      expect(data.summary).not.toMatch(/[\r\n]/);
      expect(Object.values(data.bound_to).flat().length).toBeGreaterThan(0);
      expect(Object.values(data.bound_to).flat().every(id => !String(id).includes('*'))).toBe(true);
      const decision = decisions.find((d: any) => d.rule.endsWith(`/${name}.md`));
      expect(decision.activation).toBe(data.activation);
      expect(decision.reason.length).toBeGreaterThan(25);
      expect(decision.enforcement).toBe(data.enforcement ?? 'unclassified');
    }
  });

  it('validates lane probes against the shared rule schema and the merged full-suite schema (U5/U7 authoring only)', () => {
    const schema = JSON.parse(read(path.join(repo, 'test/uat/rule-binding/probes.schema.json')));
    const ajv = new Ajv({ allErrors: true, strict: true });
    const lane = parse(read(path.join(repo, 'test/uat/rule-binding/wave5-addons-probes.yaml')));
    const base = parse(read(path.join(repo, 'test/uat/rule-binding/probes.yaml')));
    const validate = ajv.compile(schema);
    // Explicit inheritance allows a small lane while standalone suites keep
    // their base coverage requirement.
    expect(validate(lane), JSON.stringify(validate.errors)).toBe(true);
    const validateRule = ajv.compile({ $schema: schema.$schema, definitions: schema.definitions, $ref: '#/definitions/rule' });
    for (const rule of lane.rules) {
      expect(validateRule(rule), JSON.stringify(validateRule.errors)).toBe(true);
      expect(rule.probes.map((probe: any) => probe.id)).toEqual(['positive-1', 'positive-2', 'negative-1']);
      expect(fs.existsSync(path.join(repo, rule.source))).toBe(true);
      for (const probe of rule.probes) for (const assertion of probe.assertions) {
        if (assertion.pattern) expect(() => new RegExp(assertion.pattern)).not.toThrow();
        if (assertion.type === 'json-equals' && typeof assertion.value === 'string') {
          expect(probe.prompt).toContain(assertion.value);
        }
      }
    }
    expect(validate({ version: 1, rules: [...base.rules, ...lane.rules] }), JSON.stringify(validate.errors)).toBe(true);
    const required = decisions.filter((d: any) => ['critical', 'high', 'block', 'unclassified'].includes(d.enforcement) && d.activation !== 'kernel');
    expect(lane.rules.map((r: any) => r.source).sort()).toEqual(required.map((d: any) => d.rule).sort());
    expect(lane.rules).toHaveLength(14);
  });

  it('shows every canonical binding through the actual CLI JSON envelope (U4)', async () => {
    const home = path.join(root, 'show-home');
    fs.mkdirSync(home);
    const config = path.join(home, 'config');
    fs.mkdirSync(config);
    fs.writeFileSync(path.join(config, 'channel.json'), JSON.stringify({ channel: 'edge', edgePath: repo, devMode: true, checkOnStartup: false }));
    const env = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, AIWG_ROOT: repo, AIWG_CONFIG: config,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
      AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', CI: '1' };
    // Shipped prebuilt tables cover read gates; cold builds have isolated tests.
    const targets = new Map<string, { type: string; id: string; rules: Array<{ name: string; data: any }> }>();
    for (const rule of rules) for (const [kind, ids] of Object.entries(rule.data.bound_to) as Array<[string, string[]]>) {
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
          expect.objectContaining({ name: data.name ?? name, activation: data.activation, summary: data.summary,
            show_command: `aiwg show rule ${data.name ?? name} --body` }),
        ]));
      }
    }
  }, 600_000);

  it('discovers every migrated rule after building the isolated framework index (U6)', () => {
    const home = path.join(root, 'discover-home');
    fs.mkdirSync(home);
    const config = path.join(home, 'config');
    fs.mkdirSync(config);
    fs.writeFileSync(path.join(config, 'channel.json'), JSON.stringify({ channel: 'edge', edgePath: repo, devMode: true, checkOnStartup: false }));
    const env = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
      PATH: process.env.PATH, HOME: home, AIWG_ROOT: repo, AIWG_CONFIG: config,
      AIWG_ARTIFACTS_PATH: path.join(home, 'artifacts'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
      AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', CI: '1' };
    // Shipped prebuilt tables cover read gates; cold builds have isolated tests.
    const needs = Object.fromEntries(rules.map(({ name, data }) => [data.name ?? name, name.replaceAll('-', ' ')]));
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
    if (provider === 'hermes') {
      const chars = read(path.join(project, 'AGENTS.md')).length;
      console.info('Hermes fixture', 'addons', chars, 'chars');
      expect(chars).toBeLessThanOrEqual(19000); // ADR 220–224: full bodies, no compression.
    }
    const startup = readRuleDeliveryContext(report, provider);
    for (const { name, data } of rules) {
      if (data.activation === 'summary') {
        expect(startup).toContain(data.summary);
        expect(startup).toContain(`- ${data.name ?? name} — ${data.summary}`);
        expect(startup).toContain(`aiwg show rule ${data.name ?? name} --body`);
      } else if (data.activation === 'bound') {
        expect(startup).not.toContain(`aiwg show rule ${data.name ?? name}`);
      }
      const heading = read(path.join(bundle, 'rules', `${name}.md`)).split('\n').find(line => line.startsWith('# '));
      if (data.activation !== 'paths' || !['claude', 'cursor'].includes(provider)) expect(startup).not.toContain(heading);
    }
    const allFiles = walk(path.join(root, provider));
    const outputs = allFiles.filter(file => /\.(md|toml)$/.test(file));
    for (const { name, data } of rules.filter(rule => rule.data.activation !== 'paths')) {
      expect(allFiles.filter(file => file.includes('/rules/') &&
        new RegExp(`/${name}\\.md$`).test(file)), `${provider}: ${name} startup body (${data.activation})`).toHaveLength(0);
    }
    for (const { name, data } of rules) for (const [kind, ids] of Object.entries(data.bound_to) as Array<[string, string[]]>) {
      for (const id of ids) {
        const target = resolveRuleBindingTarget(Object.values(entries), kind.slice(0, -1) as 'skill' | 'agent' | 'flow', id);
        const slug = path.basename(target.path).replace(/\.md$/, '') === 'SKILL' ? path.basename(path.dirname(target.path)) : path.basename(target.path).replace(/\.md$/, '');
        const definitions = outputs.filter(file => file.includes(`/${kind === 'flows' ? 'skills' : kind}/`) &&
          (kind !== 'agents' ? (file.endsWith(`/${slug}/SKILL.md`) || file.endsWith(`/${slug}.md`)) : new RegExp(`/${slug}\\.(?:md|toml)$`).test(file)));
        expect(definitions.length, `${provider} ${kind}:${id}`).toBeGreaterThan(0);
        for (const file of definitions) {
          const content = read(file);
          expect(content.match(/<!-- AIWG:bound-rules:start -->/g), file).toHaveLength(1);
          const index = read(path.join(project, `.${provider}/RULES-BOUND.md`));
          const anchors = [...content.matchAll(/RULES-BOUND\.md#([a-z0-9_-]+)/g)];
          expect(anchors.length, file).toBeGreaterThan(0);
          const bound = anchors.map(match => index.split(`## ${match[1]}\n`)[1]?.split('\n## ')[0] || '').join('\n');
          expect(bound, file).toContain(`aiwg show rule ${data.name ?? name} --body`);
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
