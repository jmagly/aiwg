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
const decisions = JSON.parse(fs.readFileSync(path.join(repo, 'test/uat/rule-binding/wave5-utils-decisions.json'), 'utf8'));
const wave: string[] = decisions.map((decision: { rule: string }) => decision.rule);
const devRules = new Set(['addon-boundaries', 'aiwg-ci-safety', 'aiwg-dir-reference-contract',
  'component-completeness', 'no-circular-skill-calls', 'skill-placement']);
const providers = ['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw'];
const read = (file: string) => fs.readFileSync(file, 'utf8');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const metadata = (file: string) => parse(read(file).match(/^---\n([\s\S]*?)\n---/)![1]);

describe('Wave 5 utils canonical rule delivery (#2945)', () => {
  let root: string;
  let source: string;
  let bundle: string;
  let entries: ArtifactIndex['entries'];
  let rules: Array<{ name: string; data: any }>;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-wave5-utils-'));
    source = path.join(root, 'source');
    bundle = path.join(source, 'agentic/code/addons/wave5-utils');
    fs.mkdirSync(path.join(bundle, 'rules'), { recursive: true });
    rules = wave.map(name => {
      const owner = devRules.has(name) ? 'addons/aiwg-dev' : 'addons/aiwg-utils';
      const file = path.join(repo, 'agentic/code', owner, 'rules', `${name}.md`);
      fs.copyFileSync(file, path.join(bundle, 'rules', `${name}.md`));
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
      if (type === 'skill') fs.cpSync(path.dirname(file), path.dirname(dest), { recursive: true });
      else fs.copyFileSync(file, dest);
    }
  }, 60_000);
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('records all 16 scoped decisions and validates concrete activation metadata (U2)', () => {
    expect(new Set(wave).size).toBe(16);
    expect(rules.filter(rule => rule.data.activation === 'paths')).toHaveLength(7);
    expect(rules.filter(rule => rule.data.activation === 'bound')).toHaveLength(5);
    expect(rules.filter(rule => rule.data.activation === 'summary')).toHaveLength(4);
    for (const { name, data } of rules) {
      expect([...data.summary].length).toBeGreaterThan(0);
      expect([...data.summary].length).toBeLessThanOrEqual(240);
      expect(Object.values(data.bound_to).flat().length).toBeGreaterThan(0);
      expect(Object.values(data.bound_to).flat().every(id => !String(id).includes('*'))).toBe(true);
      expect(decisions).toContainEqual(expect.objectContaining({ rule: name,
        enforcement: data.enforcement, activation: data.activation, reason: expect.stringMatching(/\S/) }));
      if (data.activation === 'paths') expect(data.paths.length).toBeGreaterThan(0);
    }
    for (const name of ['context-bloat', 'context-budget', 'implicit-dependencies', 'parallel-then-synthesize']) {
      const orchestration = rules.find(rule => rule.name === name)!.data;
      expect(orchestration.bound_to.skills).toEqual(expect.arrayContaining(['parallel-dispatch', 'rlm-batch', 'aiwg-mission']));
      expect(orchestration.bound_to.flows).toContain('flow-guided-implementation');
    }
    const agent = rules.find(rule => rule.name === 'agent-deployment')!.data;
    expect(agent.paths).toEqual(expect.arrayContaining(['agentic/**', 'AGENTS.md', '.claude/agents/**',
      '.factory/droids/**', '.codex/agents/**', '.opencode/agent/**']));
  });

  it('schema-validates lane probes and covers every moved HIGH rule (U5 planning only)', async () => {
    const { default: Ajv } = await import('ajv/dist/2020.js');
    const { loadProbes } = await import('../../../tools/rules/run-rule-probes.mjs');
    const file = path.join(repo, 'test/uat/rule-binding/wave5-utils-probes.yaml');
    const probes = loadProbes(file);
    const schema = JSON.parse(read(path.join(repo, 'test/uat/rule-binding/probes.schema.json')));
    const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
    expect(validate(parse(read(file))), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(probes), JSON.stringify(validate.errors)).toBe(true);
    for (const { name, data } of rules.filter(rule => ['critical', 'high'].includes(rule.data.enforcement)
      || rule.data.severity === 'HIGH')) {
      const entry = probes.rules.find((rule: any) => rule.id === name);
      expect(entry, name).toBeDefined();
      expect(entry.source).toBe(`agentic/code/addons/${devRules.has(name) ? 'aiwg-dev' : 'aiwg-utils'}/rules/${name}.md`);
      expect(entry.probes.map((probe: any) => [probe.id, probe.kind])).toEqual([
        ['positive-1', 'positive'], ['positive-2', 'positive'], ['negative-1', 'negative'],
      ]);
      expect(data.activation).not.toBe('kernel');
    }
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
      'addon-boundaries': 'addon boundaries',
      'aiwg-ci-safety': 'aiwg ci safety',
      'aiwg-dir-reference-contract': 'aiwg directory reference contract',
      'component-completeness': 'component completeness',
      'no-circular-skill-calls': 'no circular skill calls',
      'skill-placement': 'skill placement',
      'activity-log': 'activity log',
      'agent-deployment': 'agent deployment',
      'context-bloat': 'context bloat',
      'context-budget': 'context budget',
      'diagram-generation': 'diagram generation',
      'implicit-dependencies': 'implicit dependencies',
      'no-time-estimates': 'no time estimates',
      'parallel-then-synthesize': 'parallel then synthesize',
      'post-commit-index-refresh': 'post commit index refresh',
      'soul-enforcement': 'soul enforcement',
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
    if (provider === 'hermes') {
      const chars = read(path.join(project, 'AGENTS.md')).length;
      console.info('Hermes fixture', 'utils', chars, 'chars');
      expect(chars).toBeLessThanOrEqual(19000); // ADR 220–224: full bodies, no compression.
    }
    const startup = readRuleDeliveryContext(report, provider);
    for (const { name, data } of rules) {
      if (data.activation === 'summary' || data.activation === 'paths' && !['claude', 'cursor'].includes(provider)) {
        expect(startup).toContain(data.summary);
        expect(startup).toContain(data.activation === 'paths' ? `aiwg show rule ${name} --body` : `- ${name} — ${data.summary}`);
        expect(startup).toContain(`aiwg show rule ${name} --body`);
      } else if (data.activation === 'bound') {
        expect(startup).not.toContain(`aiwg show rule ${name}`);
      }
      const heading = read(path.join(bundle, 'rules', `${name}.md`)).split('\n').find(line => line.startsWith('# '));
      if (data.activation !== 'paths' || !['claude', 'cursor'].includes(provider)) expect(startup).not.toContain(heading);
    }
    const allFiles = walk(path.join(root, provider));
    const outputs = allFiles.filter(file => /\.(md|mdc|toml)$/.test(file));
    for (const { name, data } of rules) {
      const bodies = allFiles.filter(file => file.includes('/rules/') &&
        new RegExp(`/${name}\\.(?:md|mdc)$`).test(file));
      if (data.activation === 'paths' && ['claude', 'cursor'].includes(provider)) {
        expect(bodies, `${provider}: ${name} native path body`).toHaveLength(1);
        const content = read(bodies[0]);
        expect(content).toContain(provider === 'cursor' ? 'globs:' : 'paths:');
        if (provider === 'cursor') expect(content).toContain('alwaysApply: false');
      } else {
        expect(bodies, `${provider}: ${name} startup body`).toHaveLength(0);
      }
    }
    for (const { name, data } of rules) for (const [kind, ids] of Object.entries(data.bound_to) as Array<[string, string[]]>) {
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
