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
const frameworks = ['forensics-complete', 'ops-complete', 'security-engineering'];
const providers = ['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw'];
const read = (file: string) => fs.readFileSync(file, 'utf8');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const metadata = (file: string) => parse(read(file).match(/^---\n([\s\S]*?)\n---/)![1]);
const decisions = JSON.parse(read(path.join(repo, 'test/uat/rule-binding/wave5-secops-decisions.json')));
const probesFile = path.join(repo, 'test/uat/rule-binding/wave5-secops-probes.yaml');

describe('Wave 5 secops canonical rule delivery (#2945)', () => {
  let root: string;
  let source: string;
  let bundle: string;
  let entries: ArtifactIndex['entries'];
  let rules: Array<{ name: string; file: string; data: any }>;
  const isolatedEnv = (home: string, aiwgRoot = repo) => ({ TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
      PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    AIWG_ROOT: aiwgRoot, AIWG_CONFIG: path.join(home, '.config/aiwg'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
    AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', CI: '1' });
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-wave5-secops-'));
    source = path.join(root, 'source');
    bundle = path.join(source, 'agentic/code/addons/wave5-secops');
    fs.mkdirSync(path.join(bundle, 'rules'), { recursive: true });
    rules = decisions.map(({ rule: name }: { rule: string }, index: number) => {
      const owner = index < 4 ? 'forensics-complete' : index < 9 ? 'ops-complete' : 'security-engineering';
      const file = path.join(repo, 'agentic/code/frameworks', owner, 'rules', `${name}.md`);
      fs.copyFileSync(file, path.join(bundle, 'rules', `${name}.md`));
      return { name, file, data: metadata(file) };
    });
    // Index real canonical artifacts (including flat ops/extension skills).
    // Only the index output is written into our temporary root.
    await buildIndex(repo, { scope: 'agentic/code', includeIgnored: true, outputDir: root, force: true, quiet: true });
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
      if (type === 'skill' && file.endsWith('/SKILL.md')) fs.cpSync(path.dirname(file), path.dirname(dest), { recursive: true });
      else fs.copyFileSync(file, dest);
    }
    // Each real framework gets its own deployment fixture, so a combined
    // synthetic bundle cannot obscure a per-framework provider regression.
    for (const owner of frameworks) {
      const destBundle = path.join(root, `source-${owner}`, 'agentic/code/addons', owner);
      for (const rule of rules.filter(rule => rule.file.includes(`/frameworks/${owner}/`))) {
        fs.mkdirSync(path.join(destBundle, 'rules'), { recursive: true });
        fs.copyFileSync(rule.file, path.join(destBundle, 'rules', `${rule.name}.md`));
        for (const [kind, ids] of Object.entries(rule.data.bound_to ?? {}) as Array<[string, string[]]>) for (const id of ids) {
          const relative = kind === 'skills' ? `skills/${id}` : `${kind}/${id}${kind === 'flows' ? '.playbook.yaml' : '.md'}`;
          const dest = path.join(destBundle, relative);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.cpSync(path.join(bundle, relative), dest, { recursive: true });
        }
      }
    }
  }, 90_000);
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('records all 21 dispositions and resolves every concrete binding (U2/U3)', () => {
    expect(decisions).toHaveLength(21);
    expect(new Set(decisions.map((d: any) => d.rule)).size).toBe(21);
    for (const rule of rules) {
      const decision = decisions.find((d: any) => d.rule === rule.name);
      expect(decision).toMatchObject({ enforcement: rule.data.enforcement, activation: rule.data.activation });
      expect(decision.reason.trim()).not.toBe('');
      expect([...rule.data.summary].length).toBeLessThanOrEqual(240);
      expect(rule.data.summary.trim()).not.toBe('');
      if (rule.data.activation === 'kernel') expect(rule.data.bound_to).toBeUndefined();
      else {
        const ids = Object.values(rule.data.bound_to).flat();
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.every(id => !String(id).includes('*'))).toBe(true);
      }
    }
    expect(rules.filter(r => r.data.enforcement === 'critical').map(r => [r.name, r.data.activation])).toEqual([
      ['evidence-integrity', 'bound'], ['non-destructive', 'bound'], ['red-flag-escalation', 'bound'],
      ['ops-information-governance', 'kernel'], ['ops-safety', 'kernel'],
    ]);
  });

  it('schema-validates positive/negative probes for every moved CRITICAL/HIGH rule without model calls (U5/U7 preparation)', () => {
    const data = parse(read(probesFile));
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(JSON.parse(read(path.join(repo, 'test/uat/rule-binding/probes.schema.json'))));
    expect(validate(data), ajv.errorsText(validate.errors)).toBe(true);
    expect(data.rules.map((r: any) => r.id).sort()).toEqual(rules.map(r => r.name).sort());
    for (const rule of rules) {
      const probeRule = data.rules.find((r: any) => r.id === rule.name);
      expect(probeRule.source).toBe(path.relative(repo, rule.file));
      expect(probeRule.probes.map((p: any) => [p.id, p.kind])).toEqual([
        ['positive-1', 'positive'], ['positive-2', 'positive'], ['negative-1', 'negative'],
      ]);
      for (const probe of probeRule.probes) for (const assertion of probe.assertions) {
        if (assertion.type === 'json-equals' && typeof assertion.value === 'string') expect(probe.prompt).toContain(assertion.value);
      }
    }
  });

  it('shows every declared binding through CLI bound_rules JSON (U4)', async () => {
    const home = path.join(root, 'show-home');
    fs.mkdirSync(home);
    const env = isolatedEnv(home);
    // Shipped prebuilt tables cover read gates; cold builds have isolated tests.
    const targets = new Map<string, { type: string; id: string; rules: typeof rules }>();
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

  it('discovers each scoped rule in the top three from its natural-language need (U6)', () => {
    const home = path.join(root, 'discover-home');
    fs.mkdirSync(home);
    const env = { ...isolatedEnv(home), AIWG_ARTIFACTS_PATH: path.join(home, 'artifacts') };
    // Discovery must never depend on another test having populated this HOME.
    // Shipped prebuilt tables cover read gates; cold builds have isolated tests.
    for (const { name, data } of rules.filter(rule => rule.data.activation !== 'kernel')) {
      const phrase = data.triggers.at(-1);
      const result = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'bin/aiwg.mjs'),
        'discover', phrase, '--type', 'rule', '--json'], { cwd: repo, env, encoding: 'utf8', timeout: 30_000, stdio: 'pipe' }));
      expect(result.results.slice(0, 3).map((entry: any) => entry.name), phrase).toContain(name);
    }
  }, 180_000);

  for (const provider of providers) for (const owner of frameworks) it(`${owner}/${provider}: delivers bindings and activation-selected startup content (U3/U9)`, () => {
    const selectedRules = rules.filter(rule => rule.file.includes(`/frameworks/${owner}/`));
    const selectedSource = path.join(root, `source-${owner}`);
    const deployedRoot = path.join(root, provider, owner);
    const project = path.join(deployedRoot, 'project');
    const home = path.join(deployedRoot, 'home');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const deployed = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { deploy } = await import(${JSON.stringify(path.join(repo, 'tools/agents/providers', `${provider}.mjs`))});
      const report = await deploy(${JSON.stringify({ srcRoot: selectedSource, target: project, provider, mode: 'all', config: { installed: { [owner]: {} } },
        deployRules: true, deploySkills: true, deployCommands: true, copyStandardSkills: true,
        force: true, quiet: true })});
      console.log('REPORT:' + JSON.stringify(report));
    `], { cwd: repo, env: { ...isolatedEnv(home, selectedSource), HERMES_HOME: path.join(home, '.hermes') },
      encoding: 'utf8', timeout: 90_000, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
    const report = JSON.parse(deployed.split('REPORT:')[1].trim());
    if (provider === 'hermes') {
      const chars = read(path.join(project, 'AGENTS.md')).length;
      console.info('Hermes fixture', owner, chars, 'chars');
      expect(chars).toBeLessThanOrEqual(19000); // ADR 220–224: full bodies, no compression.
    }
    const startup = readRuleDeliveryContext(report, provider);
    const allFiles = walk(deployedRoot);
    const outputs = allFiles.filter(file => /\.(md|mdc|toml)$/.test(file));
    for (const { name, file, data } of selectedRules) {
      const heading = read(file).split('\n').find(line => line.startsWith('# '));
      if (data.activation === 'kernel') {
        expect(startup).toContain(heading);
        expect(startup).toContain(read(file).replace(/^---\n[\s\S]*?\n---\s*/, '').trim());
      }
      if (data.activation === 'summary' || data.activation === 'paths' && !['claude', 'cursor'].includes(provider)) {
        expect(startup).toContain(data.summary);
        expect(startup).toContain(data.activation === 'paths' ? `aiwg show rule ${name} --body` : `- ${name} — ${data.summary}`);
        expect(startup).toContain(`aiwg show rule ${name} --body`);
        expect(startup).not.toContain(heading);
      }
      if (['summary', 'bound'].includes(data.activation)) {
        expect(allFiles.filter(file => file.includes('/rules/') && new RegExp(`/${name}\\.(?:md|mdc)$`).test(file))).toHaveLength(0);
      }
      if (data.activation === 'bound') expect(startup).not.toContain(`aiwg show rule ${name}`);
      if (data.activation === 'paths' && ['claude', 'cursor'].includes(provider)) {
        const native = outputs.filter(file => file.includes('/rules/') && new RegExp(`/${name}\\.(?:md|mdc)$`).test(file));
        expect(native).toHaveLength(1);
        expect(read(native[0])).toContain(heading);
        expect(read(native[0])).toContain(provider === 'cursor' ? 'globs:' : 'paths:');
        if (provider === 'cursor') expect(read(native[0])).toContain('alwaysApply: false');
      }
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
    for (const file of outputs.filter(file => /\/(?:AGENTS|AIWG|WARP)\.md$/.test(file))) expect(read(file)).not.toContain('<!-- AIWG:bound-rules:start -->');
    if (provider === 'codex') {
      const agents = path.join(project, 'AGENTS.md');
      if (fs.existsSync(agents)) expect(fs.statSync(agents).size).toBeLessThan(32768);
      else {
        // ADR: a bound/on-demand-only selection has no startup rule contract
        // and needs no new bridge. Automatic selections still require one.
        expect(selectedRules.length).toBeGreaterThan(0);
        expect(selectedRules.every(rule => ['bound', 'on-demand'].includes(rule.data.activation))).toBe(true);
      }
    }
  }, 180_000);
});
