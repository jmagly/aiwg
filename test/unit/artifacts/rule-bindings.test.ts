import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, extractRuleBindings } from '../../../src/artifacts/index-builder.js';
import { showArtifact, type ShowParams } from '../../../src/artifacts/query-engine.js';
import { syncFortemiCoreIndex } from '../../../src/artifacts/fortemi-core-sync.js';
import { buildAiwgFortemiIndexExport } from '../../../src/artifacts/browser-export.js';

const cli = vi.hoisted(() => vi.fn());
vi.mock('../../../src/mcp/helpers.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/mcp/helpers.mjs')>(), runAiwgCli: cli,
}));
// @ts-expect-error .mjs tool registration has no declarations
import { registerDiscoveryTools } from '../../../src/mcp/tools/discovery.mjs';

let root: string;
let log: ReturnType<typeof vi.spyOn>;
let write: ReturnType<typeof vi.spyOn>;
const plain = '# Unbound\n\nKeep this exact text.\n';
async function show(name: string, type: string, extra: Partial<ShowParams> = {}) {
  log.mockClear(); write.mockClear();
  await showArtifact(root, { name, typeFilter: [type], graph: 'project', backend: 'local', json: true, ...extra });
  return extra.json === false ? write.mock.calls.map(c => String(c[0])).join('') : JSON.parse(String(log.mock.calls.at(-1)?.[0]));
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-bindings-'));
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'xdg'));
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, '');
  const files = {
    'skills/work/SKILL.md': '---\nname: work\n---\n# Work\n',
    'agents/worker.md': '---\nname: worker\n---\n# Worker\n',
    'flows/workflow.md': '---\ntype: flow\n---\n# Workflow\n',
    'skills/unbound/SKILL.md': plain,
    'rules/first.md': '---\nactivation: bound\nsummary: Follow the first rule.\nbound_to: { skills: [work, work], agents: [worker], flows: [workflow] }\n---\n# First rule body\n',
    'rules/second.md': '---\nactivation: summary\nsummary: Follow the second rule.\nbound_to:\n  skills: [wor*]\n---\n# Second rule body\n',
    'rules/legacy.md': '# Legacy rule\n',
  };
  for (const [file, content] of Object.entries(files)) {
    const destination = path.join(root, '.aiwg', file);
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, content);
  }
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await buildIndex(root, { force: true, graph: 'project' });
  cli.mockImplementation(async (args: string[]) => ({ code: 0, stderr: '', stdout: JSON.stringify(await show(args[2], args[1], { boundRuleBodies: args.includes('--bound-rule-bodies') })) }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('bound rule expansion', () => {
  it('returns each binding once, across all target types, without rule bodies by default (U4)', async () => {
    const skill = await show('work', 'skill');
    expect(skill.bound_rules).toEqual([
      { name: 'first', activation: 'bound', summary: 'Follow the first rule.', show_command: 'aiwg show rule first' },
      { name: 'second', activation: 'summary', summary: 'Follow the second rule.', show_command: 'aiwg show rule second' },
    ]);
    for (const [name, type] of [['worker', 'agent'], ['workflow', 'flow']]) {
      expect((await show(name, type)).bound_rules).toEqual([skill.bound_rules[0]]);
    }
    const text = await show('work', 'skill', { json: false });
    expect(text).toContain('## Bound rules'); expect(text).toContain('aiwg show rule first');
    expect(text).not.toContain('# First rule body');
    expect((await show('work', 'skill', { boundRuleBodies: true })).bound_rules[0].content).toContain('# First rule body');
    expect(await show('work', 'skill', { json: false, boundRuleBodies: true })).toContain('# First rule body');
  });
  it('lists typed reverse targets and preserves legacy rules', async () => {
    expect((await show('first', 'rule')).bound_to).toEqual({ skills: ['work'], agents: ['worker'], flows: ['workflow'] });
    expect(await show('first', 'rule', { json: false })).toContain('## Bound targets');
    expect((await show('legacy', 'rule')).bound_to).toBeUndefined();
  });
  it('keeps unbound text and JSON byte-identical to the previous envelope', async () => {
    expect(await show('unbound', 'skill', { json: false })).toMatchInlineSnapshot(`
      "# Unbound

      Keep this exact text.
      "
    `);
    const value = await show('unbound', 'skill');
    expect(value.content).toBe(plain);
    expect(Object.keys(value)).toEqual(['id', 'path', 'type', 'name', 'title', 'kernel', 'provenance', 'providerModels', 'content']);
  });
  it('reads absent and malformed declarations tolerantly', () => {
    expect(extractRuleBindings({})).toEqual({});
    expect(extractRuleBindings({ bound_to: { skills: 'work', agents: [null, 4, '', 'worker'] } })).toEqual({ bound_to: { agents: ['worker'] } });
  });
  it('exports binding metadata for the default Fortemi backend', () => {
    const exported = buildAiwgFortemiIndexExport(root, { graph: 'project', schemaVersion: 'v2' });
    const rule = exported.items.find(record => record.name === 'first')!;
    expect(rule.search?.frontmatter).toMatchObject({ activation: 'bound', summary: 'Follow the first rule.', bound_to: { skills: ['work'] } });
  });
  it('expands bindings after a Fortemi export round trip', async () => {
    const expected = (await show('work', 'skill')).bound_rules;
    await syncFortemiCoreIndex(root, { graph: 'project' });
    expect((await show('work', 'skill', { backend: 'fortemi-core' })).bound_rules).toEqual(expected);
  });
  it.each([['work', 'skill'], ['worker', 'agent'], ['first', 'rule']])('MCP %s has CLI parity', async (name, type) => {
    const tools = new Map<string, any>();
    registerDiscoveryTools({ registerTool(key: string, _config: unknown, handler: unknown) { tools.set(key, handler); } }, { corpusStore: {} });
    const expected = await show(name, type);
    const result = await tools.get(`${type}-show`)({ name });
    expect(JSON.parse(result.content[0].text)).toEqual(expected);
    if (type !== 'rule') {
      const full = await tools.get(`${type}-show`)({ name, bound_rule_bodies: true });
      expect(JSON.parse(full.content[0].text).bound_rules[0].content).toContain('# First rule body');
    }
  });
});
