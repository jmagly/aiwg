import { regenerateHandler } from '../../../src/cli/handlers/regenerate.js';
import { setRuleConfigKey } from '../../../src/config/cli.js';
import { discoveryIdForEntry } from '../../../src/artifacts/query-engine-entries.js';
import { ruleFiles } from '../../../src/rules/pin-state.js';
import { emitShowCard } from '../../../src/artifacts/query-engine-show-card.js';
import { emitDiscoverResults } from '../../../src/artifacts/query-engine-discover-output.js';
import type { MetadataEntry } from '../../../src/artifacts/types.js';
// Exercise source metadata, project config and generated instruction precedence together.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import { parseRuleFrontmatter } from '../../../src/rules/activation.mjs';
import { validateRulesConfig } from '../../../src/rules/inline-budget.mjs';
import { emptyConfig, writeAiwgConfig } from '../../../src/config/aiwg-config.js';
import { main } from '../../../src/config/cli.js';
import { ruleInventory } from '../../../src/rules/inventory.js';
import { ensureWorkspaceContext } from '../../../src/smiths/context-pipeline/workspace-document.js';
import { lintRuleActivation } from '../../../src/lint/rule-activation.js';
const repo = resolve(__dirname, '../../..');
let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aiwg-rule-precedence-'));
  vi.stubEnv('HOME', join(dir, 'home'));
  vi.stubEnv('AIWG_CONFIG', join(dir, 'home/.aiwg'));
  vi.stubEnv('XDG_DATA_HOME', join(dir, 'data'));
  vi.stubEnv('AIWG_USER_REGISTRY_PATH', join(dir, 'registry.json'));
  mkdirSync(join(dir, 'bundle/rules'), { recursive: true });
  for (const [name, overridable] of [['editable', true], ['locked', false]] as const) {
    writeFileSync(join(dir, 'bundle/rules', `${name}.md`), `---\nname: ${name}\nactivation: kernel\nprecedence: high\noverridable: ${overridable}\n---\n# ${name}\n`);
  }
  const config = emptyConfig(['claude']);
  config.installed = { fixture: { version: '1', source: 'project-local', localPath: 'bundle', localType: 'addon', installedAt: '2026-01-01', deployedTo: {} } };
  await writeAiwgConfig(dir, config);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe('per-rule precedence (#3986)', () => {
  it('ships explicit metadata on every kernel/core rule and locks the three kernel policies', () => {
    const files = ['addons', 'frameworks', 'extensions'].flatMap(kind => ruleFiles(join(repo, 'agentic/code', kind)));
    let count = 0;
    for (const file of files.filter(file => !file.endsWith('.core.md'))) {
      const result = parseRuleFrontmatter(readFileSync(file, 'utf8'));
      if (!result.rule || !['core', 'kernel'].includes(result.rule.activation)) continue;
      count++;
      expect(result.data, file).toMatchObject({ precedence: expect.stringMatching(/^(critical|high|medium|low)$/), overridable: expect.any(Boolean) });
    }
    expect(count).toBeGreaterThan(10);
    for (const name of ['no-attribution', 'anti-laziness', 'human-authorization']) {
      expect(parseRuleFrontmatter(readFileSync(join(repo, 'agentic/code/addons/aiwg-utils/rules', `${name}.md`), 'utf8')).rule)
        .toMatchObject({ overridable: false, precedence: 'critical' });
    }
  });
  it('defaults to medium and overridable, independent of enforcement', () => {
    expect(parseRuleFrontmatter('---\nactivation: kernel\nenforcement: critical\n---\nBody').rule)
      .toMatchObject({ precedence: 'medium', overridable: true });
  });
  it.each(['precedence: urgent', 'overridable: yes', 'enforcement: urgent'])('lint rejects %s', field => {
    expect(lintRuleActivation(`---\nactivation: kernel\n${field}\n---\nBody`, 'rules/test.md', dir))
      .toContainEqual(expect.objectContaining({ severity: 'error', message: expect.stringContaining(field.split(':')[0]) }));
  });
  it('defines project ordering in the config schema and validator', () => {
    const schema = JSON.parse(readFileSync(join(repo, 'vscode-extension/schemas/aiwg.config.v1.json'), 'utf8'));
    const check = new Ajv({ strict: true }).compile(schema.properties.rules);
    const rules = { precedence: { editable: { tier: 'low', project_context: true } } };
    expect(check(rules), JSON.stringify(check.errors)).toBe(true);
    expect(validateRulesConfig(rules)).toEqual([]);
    for (const value of [{ tier: 'urgent' }, { project_context: 'yes' }, {}, { unknown: true }]) {
      expect(check({ precedence: { editable: value } })).toBe(false);
      expect(validateRulesConfig({ precedence: { editable: value } }).length).toBeGreaterThan(0);
    }
  });
  it('config CLI writes an override and inventory reports its source', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['set', '--project', 'rules.precedence.editable', '{"tier":"low","project_context":true}', '--target', dir]);
    const report = await ruleInventory(dir, repo, { scope: 'workspace' });
    expect(report.rules.find(rule => rule.name === 'editable')).toMatchObject({ precedence: 'low', overridable: true,
      precedence_source: 'project', project_context: true });
  });
  it.each([{ tier: 'low' }, { project_context: true }])('refuses overrides of locked rules without writing: %j', async value => {
    const file = join(dir, '.aiwg/aiwg.config');
    const before = readFileSync(file, 'utf8');
    await expect(main(['set', '--project', 'rules.precedence.locked', JSON.stringify(value), '--target', dir])).rejects.toThrow(/locked.*non-overridable/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('accepts stable discovery IDs, merges user/project fields and refuses duplicate aliases', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const id = discoveryIdForEntry({ type: 'rule', path: join(dir, 'bundle/rules/editable.md') } as MetadataEntry);
    await setRuleConfigKey(dir, 'user', `rules.precedence.${id}`, '{"tier":"low","project_context":true}');
    await main(['set', '--project', 'rules.precedence.editable', '{"tier":"high"}', '--target', dir]);
    expect((await ruleInventory(dir, repo, { scope: 'workspace' })).rules.find(rule => rule.name === 'editable'))
      .toMatchObject({ precedence: 'high', project_context: true, precedence_source: 'project' });
    await expect(main(['set', '--project', `rules.precedence.${id}`, '{"tier":"medium"}', '--target', dir])).rejects.toThrow('duplicates override');
    await expect(setRuleConfigKey(dir, 'user', 'rules.precedence.locked', '{"tier":"high"}')).rejects.toThrow(/locked.*non-overridable/);
  });
  it('show and discover cards expose effective precedence and project source even with stale index metadata', async () => {
    await main(['set', '--project', 'rules.precedence.editable', '{"tier":"low","project_context":true}', '--target', dir]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = join(dir, 'bundle/rules/editable.md');
    const entry = { name: 'editable', title: 'Editable', type: 'rule', path: file,
      rulePrecedence: 'critical', ruleOverridable: false } as MetadataEntry;
    await emitShowCard(dir, repo, entry, file, readFileSync(file, 'utf8'), { name: 'editable', json: true }, { fields: {}, text: '' }, {}, true);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ precedence: 'low', overridable: true, precedence_source: 'project', project_context: true });
    await emitShowCard(dir, repo, entry, file, readFileSync(file, 'utf8'), { name: 'editable' }, { fields: {}, text: '' }, {}, true);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('Precedence: low | overridable: true | source: project');
    await emitDiscoverResults({ cwd: dir, aiwgRoot: repo, params: { phrase: 'editable', json: true, graph: 'project', noBuild: true },
      entries: [entry], scored: [{ entry, score: 1 }], resourceSource: 'local', backend: 'local', prebuiltRelations: null,
      types: ['rule'], limit: 1, relaxed: false, queryTimeMs: 0, lexicalDiagnostics: new Map() });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).results[0]).toMatchObject({ precedence: 'low', overridable: true, precedence_source: 'project' });
    const skill = { name: 'work', title: 'Work', type: 'skill', path: join(dir, 'work/SKILL.md') } as MetadataEntry;
    const bound = { ...entry, bound_to: { skills: ['work'] }, activation: 'bound' };
    await emitDiscoverResults({ cwd: dir, aiwgRoot: repo, params: { phrase: 'work', json: true, graph: 'project', noBuild: true },
      entries: [skill, bound], scored: [{ entry: skill, score: 1 }], resourceSource: 'local', backend: 'local', prebuiltRelations: null,
      types: ['skill'], limit: 1, relaxed: false, queryTimeMs: 0, lexicalDiagnostics: new Map() });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).results[0].bound_rules[0])
      .toMatchObject({ precedence: 'low', overridable: true, precedence_source: 'project' });
  });
  it('refuses unknown or ambiguous identities and same-tier overrides of locked shipped rules', async () => {
    for (const [id, pattern] of [['missing', /unknown rule/], ['no-attribution', /no-attribution.*non-overridable/]] as const) {
      await expect(main(['set', '--project', `rules.precedence.${id}`, '{"tier":"critical"}', '--target', dir])).rejects.toThrow(pattern);
    }
    writeFileSync(join(dir, 'bundle/rules/copy.md'), readFileSync(join(dir, 'bundle/rules/editable.md'), 'utf8'));
    await expect(main(['set', '--project', 'rules.precedence.editable', '{"tier":"low"}', '--target', dir])).rejects.toThrow('ambiguous rule');
  });
  it('generates rule and skill resolution text on both context surfaces', async () => {
    await main(['set', '--project', 'rules.precedence.editable', '{"tier":"low","project_context":true}', '--target', dir]);
    await ensureWorkspaceContext(dir);
    expect(readFileSync(join(dir, 'WORKSPACE.md'), 'utf8')).toContain('Rule editable: precedence low; project context outranks rule: true; source: project');
    vi.stubEnv('AIWG_HOME', repo);
    const generated = await regenerateHandler.execute({ args: ['--workspace', '--provider', 'claude'], rawArgs: ['regenerate', '--workspace', '--provider', 'claude'], cwd: dir, frameworkRoot: repo });
    expect(generated.exitCode, generated.message).toBe(0);
    for (const text of [readFileSync(join(dir, 'WORKSPACE.md'), 'utf8'), readFileSync(join(dir, 'AIWG.md'), 'utf8')]) {
      expect(text).toContain('critical > high > medium > low');
      expect(text).toContain('narrower scope wins');
      expect(text).toContain('skill follows its bound rules');
      expect(text).toContain('name the rule');
      expect(text).toContain('non-overridable');
    }
  });
});

describe('config load path', () => {
  it('loads rule precedence lazily so config readers do not compile the rule schema', () => {
    for (const file of ['src/config/aiwg-config.ts', 'src/config/cli.ts']) {
      const source = readFileSync(join(repo, file), 'utf8');
      expect(source, file).not.toMatch(/^import [^;]*from '\.\.\/rules\/project-precedence\.js'/m);
      expect(source, file).toContain("await import('../rules/project-precedence.js')");
    }
  });
});
