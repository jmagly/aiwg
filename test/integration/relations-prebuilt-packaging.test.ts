import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { boundedSpawnSync } from '../../src/process/bounded-child-process.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertContract, assertRuleBytes, boundRuleFixture, bundles, kinds } from '../helpers/bound-rule-surfaces.js';

const root = path.resolve(import.meta.dirname, '../..');
describe('shipped relationship tables', () => {
  it('packs the versioned schema, manifest, relationships and resolved bindings', () => {
    const packed = inject('basePackageManifest') as { files: Array<{ path: string }> };
    const files = new Set(packed.files.map(file => file.path));
    for (const file of ['relations.json', 'bindings.json', 'manifest.json']) expect(files.has(`prebuilt/framework-relations/${file}`), file).toBe(true);
    expect(files.has('schemas/artifacts/relations.v1.schema.json')).toBe(true);
  });
  it('shows bound rules from an installed layout with a fresh HOME and no source index build', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-relations-packed-'));
    try {
      const installed = path.join(tmp, 'package');
      const pack = boundedSpawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tmp], 'long', {
        cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      });
      expect(pack.error?.message).toBeUndefined();
      expect(pack.status, pack.stderr).toBe(0);
      const filename = JSON.parse(pack.stdout)[0].filename;
      const unpack = boundedSpawnSync('tar', ['-xzf', path.join(tmp, filename), '-C', tmp], 'long', { encoding: 'utf8' });
      expect(unpack.status, unpack.stderr).toBe(0);
      // Offline runtime dependencies; package contents come from the packed manifest above.
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(installed, 'node_modules'), 'dir');
      const data = path.join(tmp, 'data');
      const result = boundedSpawnSync(process.execPath, [path.join(installed, 'bin/aiwg.mjs'), 'show', 'skill', 'address-issues', '--json'], 'long', {
        cwd: tmp, encoding: 'utf8', maxBuffer: 1024 * 1024,
        env: { ...process.env, HOME: path.join(tmp, 'home'), XDG_DATA_HOME: data, XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_CACHE_HOME: path.join(tmp, 'cache'), AIWG_ROOT: installed },
      });
      expect(result.error?.message).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).bound_rules.length).toBeGreaterThan(0);
      expect(result.stderr).not.toContain('source digest differs');
      const cli = (args: string[], json = true) => {
        const response = boundedSpawnSync(process.execPath, [path.join(installed, 'bin/aiwg.mjs'), ...args, ...(json ? ['--json'] : [])], 'long', {
          cwd: tmp, encoding: 'utf8', maxBuffer: 1024 * 1024,
          env: { ...process.env, HOME: path.join(tmp, 'home'), XDG_DATA_HOME: data,
            XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_CACHE_HOME: path.join(tmp, 'cache'), AIWG_ROOT: installed },
        });
        expect(response.status, response.stderr).toBe(0);
        return json ? JSON.parse(response.stdout) : response.stdout;
      };
      // #4030: the text card must handle both template lists and a string run hint.
      const create = cli(['show', 'skill', 'issue-create']);
      expect(create.templates.length).toBeGreaterThan(0);
      expect(typeof create.run_hint).toBe('string');
      const createText = cli(['show', 'skill', 'issue-create'], false);
      expect(createText).toContain('# skill: issue-create');
      expect(createText).toContain('## Templates');
      expect(cli(['show', 'skill', create.id], false)).toBe(createText);
      const skill = cli(['show', 'skill', 'issue-update']);
      expect(skill.templates.map((template: any) => template.name)).toEqual(expect.arrayContaining([
        'progress-update', 'blocker-found', 'feedback-needed', 'task-completed',
      ]));
      expect(cli(['show', 'template', 'progress-update']).used_by)
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'issue-update', type: 'skill' })]));
      const found = cli(['discover', 'post a status update on an issue']).results.find((item: any) => item.name === 'issue-update');
      expect(found.templates).toHaveLength(3);
      expect(found.templates[0].show_command).toMatch(/^aiwg show template /);
      const files = fs.readdirSync(data, { recursive: true }).map(String);
      expect(files.some(file => file.endsWith('metadata.json'))).toBe(false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }, 60_000);

  it('#4027 reads packaged docs runbook bodies by id from an external cwd', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-runbook-packed-'));
    try {
      const pack = boundedSpawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tmp], 'long', {
        cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      });
      expect(pack.status, pack.stderr).toBe(0);
      const unpack = boundedSpawnSync('tar', ['-xzf', path.join(tmp, JSON.parse(pack.stdout)[0].filename), '-C', tmp], 'long', { encoding: 'utf8' });
      expect(unpack.status, unpack.stderr).toBe(0);
      const installed = path.join(tmp, 'package');
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(installed, 'node_modules'), 'dir');
      const cli = (args: string[]) => {
        const response = boundedSpawnSync(process.execPath, [path.join(installed, 'bin/aiwg.mjs'), ...args], 'long', {
          cwd: tmp, encoding: 'utf8', maxBuffer: 1024 * 1024,
          env: { ...process.env, HOME: path.join(tmp, 'home'), XDG_DATA_HOME: path.join(tmp, 'data'),
            XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_CACHE_HOME: path.join(tmp, 'cache'), AIWG_ROOT: installed },
        });
        expect(response.status, response.stderr).toBe(0);
        return response.stdout;
      };
      const runbook = JSON.parse(cli(['show', 'runbook', 'agentic-install-runbook', '--body', '--json']));
      expect(runbook.path).toBe(path.join(installed, 'docs/agentic-install-runbook.md'));
      expect(cli(['show', 'runbook', runbook.id, '--body'])).toBe(fs.readFileSync(runbook.path, 'utf8'));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }, 60_000);
});

describe('#2313 bound rule identity across production surfaces', () => {
  const fixture = boundRuleFixture();
  beforeAll(() => fixture.prepare(), 120_000);
  afterAll(() => fixture.cleanup());

  for (const kind of kinds) for (const bundle of bundles) {
    it(`${bundle} same-name ${kind} retains its rule identity and bytes through CLI, MCP and npm pack`, () => {
      let baseline: unknown;
      for (const [lane, packageRoot] of [['source', fixture.stage], ['packed', fixture.installed]]) {
        const discoveryArgs = { phrase: `${bundle} beacon`, type: kind, limit: 10 };
        const cliDiscovery = fixture.cli(packageRoot, lane, ['discover', discoveryArgs.phrase, '--type', kind, '--limit', '10']);
        const mcpDiscovery = fixture.mcp(packageRoot, lane, 'discover', discoveryArgs);
        expect(mcpDiscovery).toEqual({ ...cliDiscovery, query_time_ms: expect.any(Number) });
        const candidate = cliDiscovery.results[0];
        assertContract(candidate, bundle, kind);
        const shown = fixture.cli(packageRoot, lane, ['show', kind, candidate.id]);
        assertContract(shown, bundle, kind);
        expect(shown.required_rule_checks).toEqual(candidate.required_rule_checks);
        expect(shown.bound_rules).toEqual(candidate.bound_rules);
        // MCP exposes flows through discover, and skill/agent cards through typed show tools.
        if (kind !== 'flow') expect(fixture.mcp(packageRoot, lane, `${kind}-show`, { name: candidate.id })).toEqual(shown);
        const check = shown.required_rule_checks[0];
        // Follow the actual emitted command, rather than rebuilding a fetch from a rule name.
        const rule = fixture.cli(packageRoot, lane, check.fetch_command.split(' ').slice(1));
        const mcpRule = fixture.mcp(packageRoot, lane, 'rule-show', { name: check.rule_id, body: true });
        expect(mcpRule).toEqual(rule);
        assertRuleBytes(rule, bundle);
        const contract = { id: shown.id, checks: shown.required_rule_checks, rules: shown.bound_rules, content: rule.content };
        if (baseline) expect(contract).toEqual(baseline);
        baseline = contract;
      }
    }, 120_000);
  }

  it('#3768 https://git.integrolabs.net/roctinam/aiwg/issues/3768: discover drops a kernel-pinned rule that show keeps (pin parity)', () => {
    for (const [lane, packageRoot] of [['source', fixture.stage], ['packed', fixture.installed]]) {
      for (const kind of kinds) {
        const discovery = fixture.cli(packageRoot, lane, ['discover', 'amber beacon', '--type', kind], true);
        const shown = fixture.cli(packageRoot, lane, ['show', kind, discovery.results[0].id], true);
        assertContract(shown, 'amber', kind, true);
        assertContract(discovery.results[0], 'amber', kind, true);
        expect(fixture.mcp(packageRoot, lane, 'discover', { phrase: 'amber beacon', type: kind }, true))
          .toEqual({ ...discovery, query_time_ms: expect.any(Number) });
        const check = shown.required_rule_checks[0];
        assertRuleBytes(fixture.cli(packageRoot, lane, check.fetch_command.split(' ').slice(1), true), 'amber');
      }
    }
  }, 120_000);
});
