import { readRuleDeliveryContext } from '../../helpers/rule-delivery-context.js';
import { showBindingEnvelopes } from '../../helpers/show-binding-envelopes.js';
// Verify canonical SDLC lane bindings through indexing, CLI show and six provider writers.
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
const owner = 'agentic/code/frameworks/sdlc-complete/rules';
const wave = ['actionable-feedback', 'agent-fallback', 'agent-friendly-code', 'agent-generation-guardrails',
  'artifact-discovery', 'auto-reply-chains', 'best-output-selection', 'citation-policy', 'config-in-environment',
  'conversable-agent-interface', 'criticality-panel-sizing', 'disposable-processes', 'executable-feedback',
  'failure-mitigation', 'few-shot-examples', 'hitl-gates', 'hitl-patterns', 'human-gate-display', 'index-generation'];
const providers = ['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw'];
const read = (file: string) => fs.readFileSync(file, 'utf8');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const metadata = (file: string) => parse(read(file).match(/^---\n([\s\S]*?)\n---/)![1]);

describe('Wave 5 SDLC lane a canonical rule delivery (#2945)', () => {
  let root: string;
  let source: string;
  let bundle: string;
  let entries: ArtifactIndex['entries'];
  let rules: Array<{ name: string; data: any }>;
  let cliEnv: NodeJS.ProcessEnv;
  const hermesWorkloads = new Map<string, { source: string; rules: typeof rules }>();
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-wave5-sdlc-a-'));
    source = path.join(root, 'source');
    bundle = path.join(source, 'agentic/code/addons/wave5-sdlc-a');
    fs.mkdirSync(path.join(bundle, 'rules'), { recursive: true });
    rules = wave.map(name => {
      const file = path.join(repo, owner, `${name}.md`);
      fs.copyFileSync(file, path.join(bundle, 'rules', `${name}.md`));
      return { name, data: metadata(file) };
    });
    // Real corpus identities and precedence prevent synthetic fixtures from
    // concealing missing bindings or display-name versus canonical-ID errors.
    const corpus = path.join(root, 'corpus');
    for (const file of walk(path.join(repo, 'agentic/code')).filter(file =>
      !file.includes('/plugins/') && (file.includes('/agents/') && file.endsWith('.md') ||
        file.endsWith('/SKILL.md') || /\/flows\/flow-[^/]+\.playbook\.yaml$/.test(file)))) {
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
      const dest = path.join(bundle, `${type}s`, type === 'skill' ? `${id}/SKILL.md` :
        type === 'flow' ? `${id}.playbook.yaml` : `${id}.md`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (type === 'skill') fs.cpSync(path.dirname(file), path.dirname(dest), { recursive: true });
      else fs.copyFileSync(file, dest);
    }
    // Hermes has a 19K startup cap. Exercise bounded coding and workflow
    // installations, each with the unchanged universal kernel body, rather
    // than an artificial installation of every unrelated authoring role.
    for (const [label, names] of Object.entries({
      coding: ['citation-policy', 'agent-friendly-code', 'agent-generation-guardrails', 'executable-feedback'],
      workflow: wave.filter(name => !['agent-friendly-code', 'agent-generation-guardrails', 'executable-feedback'].includes(name)),
    })) {
      const workloadSource = path.join(root, `${label}-source`);
      const workloadBundle = path.join(workloadSource, 'agentic/code/addons/wave5-sdlc-a');
      const selected = rules.filter(rule => names.includes(rule.name));
      fs.mkdirSync(path.join(workloadBundle, 'rules'), { recursive: true });
      const selectedTargets = new Set<string>();
      for (const { name, data } of selected) {
        fs.copyFileSync(path.join(bundle, 'rules', `${name}.md`), path.join(workloadBundle, 'rules', `${name}.md`));
        for (const [kind, ids] of Object.entries(data.bound_to ?? {}) as Array<[string, string[]]>) {
          for (const id of ids) selectedTargets.add(`${kind.slice(0, -1)}:${id}`);
        }
      }
      for (const [key, { type, id }] of targets) if (selectedTargets.has(key)) {
        const relative = `${type}s/${type === 'skill' ? `${id}/SKILL.md` : type === 'flow' ? `${id}.playbook.yaml` : `${id}.md`}`;
        const dest = path.join(workloadBundle, relative);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (type === 'skill') fs.cpSync(path.dirname(path.join(bundle, relative)), path.dirname(dest), { recursive: true });
        else fs.copyFileSync(path.join(bundle, relative), dest);
      }
      hermesWorkloads.set(label, { source: workloadSource, rules: selected });
    }
    const home = path.join(root, 'cli-home');
    const config = path.join(root, 'cli-config');
    fs.mkdirSync(home);
    fs.mkdirSync(config);
    fs.writeFileSync(path.join(config, 'channel.json'), JSON.stringify({ channel: 'edge', edgePath: repo,
      devMode: true, checkOnStartup: false }));
    cliEnv = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, AIWG_ROOT: repo, AIWG_CONFIG: config,
      AIWG_ARTIFACTS_PATH: path.join(home, 'artifacts'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
      AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', CI: '1' };
    // Build in this isolated HOME before either show or discover. A host index
    // must never make this fixture pass or hide a cold-start discovery failure.
    // Shipped prebuilt tables cover read gates; cold builds have isolated tests.
  }, 120_000);
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('records every disposition and keeps the universal CRITICAL citation guard kernel (U2)', () => {
    const decisions = JSON.parse(read(path.join(repo, 'test/uat/rule-binding/wave5-sdlc-a-decisions.json')));
    expect(decisions.map((item: any) => item.rule).sort()).toEqual([...wave].sort());
    for (const { name, data } of rules) {
      expect(['kernel', 'summary', 'bound', 'paths', 'on-demand']).toContain(data.activation);
      expect(data.summary.trim().length).toBeGreaterThan(0);
      expect([...data.summary].length).toBeLessThanOrEqual(240);
      expect(decisions).toContainEqual(expect.objectContaining({ rule: name,
        enforcement: data.enforcement, activation: data.activation, reason: expect.stringMatching(/\S/) }));
      if (data.activation === 'kernel') expect(data.bound_to).toBeUndefined();
      else {
        const ids = Object.values(data.bound_to).flat() as string[];
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.every(id => !id.includes('*'))).toBe(true);
      }
    }
    expect(rules.filter(rule => rule.data.enforcement === 'critical').map(rule => rule.name)).toEqual(['citation-policy']);
    expect(rules.find(rule => rule.name === 'citation-policy')!.data.activation).toBe('kernel');
    expect(rules.find(rule => rule.name === 'artifact-discovery')!.data.activation).toBe('summary');
    for (const name of ['agent-friendly-code', 'agent-generation-guardrails']) {
      const data = rules.find(rule => rule.name === name)!.data;
      expect(data.activation).toBe('paths');
      expect(data.paths.length).toBeGreaterThan(0);
    }
  });

  it('schema-validates U5 probes for every moved HIGH rule, including legacy HIGH process severity', () => {
    const file = path.join(repo, 'test/uat/rule-binding/wave5-sdlc-a-probes.yaml');
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { loadProbes } = await import(${JSON.stringify(path.join(repo, 'tools/rules/run-rule-probes.mjs'))});
      loadProbes(${JSON.stringify(file)});
    `], { cwd: repo, env: cliEnv, encoding: 'utf8', timeout: 30_000, stdio: 'pipe' });
    const probes = parse(read(file));
    for (const { name, data } of rules.filter(rule => rule.data.activation !== 'kernel' &&
      ['critical', 'high'].includes(rule.data.enforcement) || rule.name === 'disposable-processes')) {
      const row = probes.rules.find((item: any) => item.id === name);
      expect(row.source).toBe(`${owner}/${name}.md`);
      expect(row.probes.map((probe: any) => [probe.id, probe.kind])).toEqual(expect.arrayContaining([
        ['positive-1', 'positive'], ['positive-2', 'positive'], ['negative-1', 'negative'],
      ]));
      expect(data.activation).not.toBe('kernel');
    }
  });

  it('shows every declared pair through the CLI JSON bound_rules envelope (U4)', async () => {
    const targets = new Map<string, { type: string; id: string; rules: Array<{ name: string; data: any }> }>();
    for (const rule of rules) for (const [kind, ids] of Object.entries(rule.data.bound_to ?? {}) as Array<[string, string[]]>) {
      for (const id of ids) {
        const key = `${kind}:${id}`;
        const target = targets.get(key) ?? { type: kind.slice(0, -1), id, rules: [] };
        target.rules.push(rule);
        targets.set(key, target);
      }
    }
    // Vitest parallelizes files; keep per-file lookups serial to bound resources.
    const requests = [...targets.values()];
    const envelopes = showBindingEnvelopes(repo, cliEnv, requests.map(({ type, id }) => ({ type, id })));
    for (const [index, target] of requests.entries()) {
      const shown = envelopes[index];
      for (const { name, data } of target.rules) expect(shown.bound_rules, `${target.type}:${target.id}`).toEqual(
        expect.arrayContaining([expect.objectContaining({ name, activation: data.activation,
          summary: data.summary, show_command: `aiwg show rule ${name} --body` })]));
    }
  }, 600_000);

  it('discovers each moved rule in the top three from a natural need after isolated indexing (U6)', () => {
    for (const { name, data } of rules.filter(rule => rule.data.activation !== 'kernel')) {
      const phrase = data.triggers[0];
      const shown = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'bin/aiwg.mjs'),
        'discover', phrase, '--type', 'rule', '--json'], {
        cwd: repo, env: cliEnv, encoding: 'utf8', timeout: 30_000, stdio: 'pipe',
      }));
      expect(shown.results.slice(0, 3).map((item: any) => item.name), phrase).toContain(name);
    }
  }, 180_000);

  for (const provider of providers) it(`${provider}: delivers all bindings and the summary kernel index (U3/U9)`, () => {
    const workloads = provider === 'hermes' ? hermesWorkloads : new Map([['all', { source, rules }]]);
    for (const [label, workload] of workloads) {
      const project = path.join(root, provider, label, 'project');
      const home = path.join(root, provider, label, 'home');
      fs.mkdirSync(project, { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      const deployed = execFileSync(process.execPath, ['--input-type=module', '-e', `
        const { deploy } = await import(${JSON.stringify(path.join(repo, 'tools/agents/providers', `${provider}.mjs`))});
        const report = await deploy(${JSON.stringify({ srcRoot: workload.source, target: project, provider, mode: 'all', config: { installed: { [path.basename(bundle)]: {} } },
          deployRules: true, deploySkills: true, deployCommands: true, copyStandardSkills: true,
          force: true, quiet: true })});
        console.log('REPORT:' + JSON.stringify(report));
      `], { cwd: repo, env: { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
      PATH: process.env.PATH, HOME: home, HERMES_HOME: path.join(home, '.hermes'),
        AIWG_ROOT: workload.source, XDG_DATA_HOME: path.join(home, '.local/share'), CI: '1' },
      encoding: 'utf8', timeout: 90_000, stdio: 'pipe' });
      const report = JSON.parse(deployed.split('REPORT:')[1].trim());
      if (provider === 'hermes') {
        const chars = read(path.join(project, 'AGENTS.md')).length;
        console.info('Hermes fixture', label, chars, 'chars');
        expect(chars).toBeLessThanOrEqual(19000); // ADR 220–224: full bodies, no compression.
      }
      const startup = readRuleDeliveryContext(report, provider);
      for (const { name, data } of workload.rules) {
        const heading = read(path.join(bundle, 'rules', `${name}.md`)).split('\n').find(line => line.startsWith('# '));
        if (data.activation === 'summary') {
          expect(startup).toContain(data.summary);
          expect(startup).toContain(`- ${name} — ${data.summary}`);
          expect(startup).toContain(`aiwg show rule ${name} --body`);
          expect(startup).not.toContain(heading);
        } else if (data.activation === 'kernel') {
          const body = read(path.join(bundle, 'rules', `${name}.md`)).replace(/^---\n[\s\S]*?\n---\s*/, '').trim();
          expect(startup).toContain(body);
        }
        else if (data.activation === 'bound') expect(startup).not.toContain(heading);
        else if (!['claude', 'cursor'].includes(provider)) {
          expect(startup).toContain(data.summary);
          expect(startup).not.toContain(heading);
        }
      }
      const allFiles = walk(path.join(root, provider, label));
      const outputs = allFiles.filter(file => /\.(md|mdc|toml)$/.test(file));
      for (const { name, data } of workload.rules) {
        if (data.activation === 'paths' && ['claude', 'cursor'].includes(provider)) {
          const scoped = outputs.filter(file => file.includes('/rules/') && new RegExp(`/${name}\\.(?:md|mdc)$`).test(file));
          expect(scoped).toHaveLength(1);
          expect(read(scoped[0])).toContain(provider === 'cursor' ? 'globs:' : 'paths:');
          expect(read(scoped[0])).toContain(data.paths[0]);
        }
        if (['bound', 'summary'].includes(data.activation)) expect(allFiles.filter(file =>
          file.includes('/rules/') && new RegExp(`/${name}\\.(?:md|mdc)$`).test(file)), `${provider}: ${name}`).toHaveLength(0);
        for (const [kind, ids] of Object.entries(data.bound_to ?? {}) as Array<[string, string[]]>) for (const id of ids) {
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
      if (provider === 'hermes') expect(read(path.join(project, 'AGENTS.md')).length).toBeLessThanOrEqual(19000);
    }
  }, 180_000);
});
