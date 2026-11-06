import { mkdtempSync } from '../../helpers/temp-dir.js';
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
const wave = ['delivery-policy', 'sdlc-right-sizing', 'vague-discretion', 'respect-repo-access-manifest', 'native-ux-tools'];
const providers = ['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw'];
const read = (file: string) => fs.readFileSync(file, 'utf8');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const metadata = (file: string) => parse(read(file).match(/^---\n([\s\S]*?)\n---/)![1]);

describe('Wave 2 canonical rule delivery (#2942)', () => {
  let root: string;
  let source: string;
  let bundle: string;
  let entries: ArtifactIndex['entries'];
  let rules: Array<{ name: string; data: any }>;
  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-wave2-'));
    source = path.join(root, 'source');
    bundle = path.join(source, 'agentic/code/addons/wave2');
    fs.mkdirSync(path.join(bundle, 'rules'), { recursive: true });
    rules = wave.map(name => {
      const addon = 'aiwg-utils';
      const file = path.join(repo, 'agentic/code/addons', addon, 'rules', `${name}.md`);
      fs.copyFileSync(file, path.join(bundle, 'rules', `${name}.md`));
      return { name, data: metadata(file) };
    });
    // Index the real canonical corpus, including flat skills and YAML flows.
    // Output stays in temp; no synthetic entries can hide unresolved targets.
    await buildIndex(repo, { scope: 'agentic/code', includeIgnored: true, outputDir: root, force: true, quiet: true });
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
      const dest = path.join(bundle, `${type}s`, type === 'skill' ? `${id}/SKILL.md` : path.basename(file));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (type === 'skill' && path.basename(file) === 'SKILL.md') fs.cpSync(path.dirname(file), path.dirname(dest), { recursive: true });
      else fs.copyFileSync(file, dest);
    }
  }, 60_000);
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('keeps the ADR modes and expands workflow families to concrete IDs', () => {
    for (const { name, data } of rules) expect(data.activation).toBe(name === 'vague-discretion' ? 'bound' : 'summary');
    const bindings = (name: string) => rules.find(rule => rule.name === name)!.data.bound_to;
    expect(bindings('delivery-policy').skills).toEqual(expect.arrayContaining([
      'aiwg-pr', 'aiwg-delivery-pr', 'issue-create', 'issue-update', 'issue-close',
      'flow-delivery-track', 'flow-release', 'release-publication-verify', 'steward',
    ]));
    expect(bindings('sdlc-right-sizing').skills).toEqual(expect.arrayContaining(['intake-wizard', 'intake-from-codebase', 'sdlc-accelerate']));
    expect(bindings('sdlc-right-sizing').flows).toContain('flow-agentloop-lfd-controls');
    expect(bindings('vague-discretion').skills).toEqual(expect.arrayContaining(['ralph', 'aiwg-mission', 'gate-evaluation', 'infer-completion-criteria']));
    expect(bindings('respect-repo-access-manifest').skills).toEqual(expect.arrayContaining(['commit-and-push', 'issue-comment', 'ops-verify', 'sys-host-audit']));
    expect(bindings('native-ux-tools').skills).toEqual(expect.arrayContaining(['intake-wizard', 'issue-audit', 'ralph', 'scaffold-extension']));
    for (const { data } of rules) for (const ids of Object.values(data.bound_to) as string[][]) {
      expect(ids.every(id => !id.includes('*'))).toBe(true);
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
    // One CLI response per distinct artifact; verify every rule/artifact pair.
    const requests = new Map<string, { type: string; id: string; expected: any[] }>();
    for (const { name, data } of rules) for (const [kind, ids] of Object.entries(data.bound_to) as Array<[string, string[]]>) {
      for (const id of ids) {
        const key = `${kind}:${id}`;
        const request = requests.get(key) || { type: kind.slice(0, -1), id, expected: [] };
        request.expected.push({ name, activation: data.activation, summary: data.summary,
          show_command: `aiwg show rule ${name} --body` });
        requests.set(key, request);
      }
    }
    const batch = [...requests.values()];
    const shown = showBindingEnvelopes(repo, env, batch);
    batch.forEach((request, index) => {
      expect(shown[index].bound_rules, `${request.type}:${request.id}`).toEqual(expect.arrayContaining(
        request.expected.map(expected => expect.objectContaining(expected))));
    });
  }, 90_000);

  it('ranks each moved rule in the top three for its natural need (U6)', () => {
    const home = path.join(root, 'discover-home');
    fs.mkdirSync(home);
    const needs: Record<string, string> = {
      'delivery-policy': 'how does this project deliver changes',
      'sdlc-right-sizing': 'how much SDLC process does this change need',
      'vague-discretion': 'write measurable loop completion criteria',
      'respect-repo-access-manifest': 'am I allowed to write to this repo',
      'native-ux-tools': 'ask the user an interactive question',
    };
    // Build the framework index in this isolated HOME so the result does not depend on test order.
    const discoverEnv = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
      PATH: process.env.PATH, HOME: home, AIWG_ROOT: repo,
      AIWG_ARTIFACTS_PATH: path.join(home, 'artifacts'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
      AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', CI: '1' };
    // Shipped prebuilt tables cover read gates; cold builds have isolated tests.
    for (const [name, phrase] of Object.entries(needs)) {
      const result = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'bin/aiwg.mjs'),
        'discover', phrase, '--type', 'rule', '--json'], {
        cwd: repo, env: discoverEnv,
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
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { deploy } = await import(${JSON.stringify(path.join(repo, 'tools/agents/providers', `${provider}.mjs`))});
      await deploy(${JSON.stringify({ srcRoot: source, target: project, provider, mode: 'all', config: { installed: { [path.basename(bundle)]: {} } },
        deployRules: true, deploySkills: true, deployCommands: true, copyStandardSkills: true,
        force: true, quiet: true })});
    `], { cwd: repo, env: { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
      PATH: process.env.PATH, HOME: home, HERMES_HOME: path.join(home, '.hermes'),
      AIWG_ROOT: source, XDG_DATA_HOME: path.join(home, '.local/share'), CI: '1' },
    encoding: 'utf8', timeout: 60_000, stdio: 'pipe' });
    const allFiles = walk(path.join(root, provider));
    const outputs = allFiles.filter(file => /\.(md|toml)$/.test(file));
    for (const { name, data } of rules) {
      expect(allFiles.filter(file => file.includes('/rules/') &&
        new RegExp(`/${name}\\.(?:md|mdc)$`).test(file)), `${provider}: ${name} startup body`).toHaveLength(0);
      if (data.activation === 'bound') for (const file of outputs.filter(file => /\/(?:AGENTS|AIWG|WARP)\.md$/.test(file))) {
        expect(read(file)).not.toContain(data.summary);
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
  }, 300_000);
});
