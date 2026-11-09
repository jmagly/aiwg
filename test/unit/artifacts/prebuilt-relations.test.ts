import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import * as builder from '../../../src/artifacts/index-builder.js';
import { buildPrebuiltRelations, checkPrebuiltRelations } from '../../../src/artifacts/prebuilt-relations.js';
import { frameworkSourceDigest } from '../../../src/artifacts/framework-source-digest.js';
import { ensureRelations, loadBuiltRelations, selectPrebuiltRelations, PREBUILT_RELATIONS_DIR } from '../../../src/artifacts/relations.js';
import { getGraphIndexDir, type ArtifactIndex } from '../../../src/artifacts/types.js';
import { showArtifact, relationshipRules, relationshipRuleStats } from '../../../src/artifacts/query-engine.js';
import { main as indexCliMain } from '../../../src/artifacts/cli.js';
import { refreshFrameworkCapabilities } from '../../../src/artifacts/framework-capabilities.js';
import { discoverCapability } from '../../../src/artifacts/query-engine-discover.js';
import { buildAiwgFortemiIndexExport } from '../../../src/artifacts/browser-export.js';
import { createHash } from 'node:crypto';

let tmp: string;
let root: string;
const skill = 'agentic/code/addons/example/skills/work/SKILL.md';
const rule = 'agentic/code/addons/example/rules/first.md';
function put(relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
}
function entries() {
  const index = JSON.parse(fs.readFileSync(path.join(getGraphIndexDir(root, 'framework'), 'metadata.json'), 'utf8')) as ArtifactIndex;
  return Object.values(index.entries);
}
function writeTables() {
  const tables = buildPrebuiltRelations(root, entries());
  for (const [file, text] of Object.entries(tables)) put(`${PREBUILT_RELATIONS_DIR}/${file}`, text);
  return tables;
}
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-prebuilt-relations-'));
  root = path.join(tmp, 'runtime');
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(key, path.join(tmp, key));
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_ROOT', root);
  put('package.json', '{"name":"aiwg","version":"1.0.0"}');
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) fs.mkdirSync(path.join(root, 'agentic/code', kind), { recursive: true });
  put(skill, '---\nname: work\n---\n# Work\n');
  put(rule, '---\nname: first\nactivation: bound\nenforcement: high\nsummary: First summary.\nbound_to: {skills: [work]}\n---\n# First\n');
  await buildIndex(root, { graph: 'framework', quiet: true });
  writeTables();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('prebuilt relationship selection', () => {
  it('shows and discovers template relationships using only shipped tables and an empty index directory', async () => {
    const templates = ['progress-update', 'blocker-found', 'feedback-needed', 'task-completed'];
    const templatePaths = templates.map(name => `agentic/code/addons/example/templates/${name}.md`);
    templates.forEach((name, i) => put(templatePaths[i], `# ${name}\n`));
    put(skill, `---\nname: work\ndescription: Post a status update on an issue\n---\n# Work\n${templatePaths.map(file => `@${file}`).join('\n')}\n`);
    for (const [directory, name] of [['agents', 'reviewer'], ['commands', 'update']]) {
      put(`agentic/code/addons/example/${directory}/${name}.md`, `# ${name}\n${templatePaths.map(file => `@${file}`).join('\n')}\n`);
    }
    put('agentic/code/addons/example/flows/review-flow.yaml',
      `apiVersion: flow.aiwg.io/v1\nkind: FlowPlaybook\nmetadata: { name: review-flow }\nspec: { description: Review work }\n${templatePaths.map(file => `# @${file}`).join('\n')}\n`);
    await buildIndex(root, { graph: 'framework', quiet: true });
    writeTables();
    const exported = JSON.stringify(buildAiwgFortemiIndexExport(root, { graph: 'framework', schemaVersion: 'v2' }));
    put('prebuilt/fortemi-core/framework/aiwg-fortemi-index-v2.json', exported);
    put('prebuilt/fortemi-core/framework/manifest.json', JSON.stringify({
      schema_version: 'aiwg.fortemi.prebuilt.v1', backend: 'fortemi-core', graph: 'framework',
      export_path: 'aiwg-fortemi-index-v2.json', export_schema_version: 'aiwg.fortemi.index.export.v2',
      export_checksum: createHash('sha256').update(exported).digest('hex'), item_count: JSON.parse(exported).items.length,
      package_version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
      source_digest: frameworkSourceDigest(root, false),
    }));
    const directory = getGraphIndexDir(root, 'framework');
    fs.rmSync(directory, { recursive: true });
    fs.mkdirSync(directory, { recursive: true });
    const build = vi.spyOn(builder, 'buildIndex');
    const read = vi.spyOn(fs, 'readFileSync');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const show = async (type: string, name: string) => {
      await showArtifact(root, { name, typeFilter: [type], json: true });
      return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    };
    const card = await show('skill', 'work');
    expect(card.templates.map((item: any) => item.name).sort()).toEqual([...templates].sort());
    for (const [type, name] of [['agent', 'reviewer'], ['command', 'update'], ['flow', 'review-flow']]) {
      expect((await show(type, name)).templates.map((item: any) => item.name).sort()).toEqual([...templates].sort());
    }
    for (const item of card.templates) {
      expect(item.show_command).toBe(`aiwg show template ${item.name}`);
      const template = await show('template', item.name);
      expect(template.used_by).toHaveLength(4);
      expect(template.used_by).toContainEqual(expect.objectContaining({ name: 'work', type: 'skill', show_command: 'aiwg show skill work' }));
    }
    await showArtifact(root, { name: 'work', typeFilter: ['skill'] });
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('## Templates');
    await showArtifact(root, { name: 'progress-update', typeFilter: ['template'] });
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('## Used by');
    const discover = { phrase: 'post a status update on an issue', graph: 'framework' as const, json: true };
    await discoverCapability(root, discover);
    const results = JSON.parse(String(log.mock.calls.at(-1)?.[0])).results;
    expect(results.find((item: any) => item.name === 'work').templates).toHaveLength(3);
    await discoverCapability(root, { ...discover, includePaths: false });
    const compact = JSON.parse(String(log.mock.calls.at(-1)?.[0])).results.find((item: any) => item.name === 'work');
    expect(compact.templates.every((template: any) => !Object.hasOwn(template, 'path'))).toBe(true);
    await discoverCapability(root, { ...discover, phrase: 'progress-update', typeFilter: ['template'] });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).results[0].used_by.map((item: any) => item.name)).toContain('work');
    await discoverCapability(root, { ...discover, json: false });
    expect(log.mock.calls.flat().join('\n')).toContain('templates:');
    expect(build).not.toHaveBeenCalled();
    expect(read.mock.calls.some(([file]) => String(file).endsWith('/metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'metadata.json'))).toBe(false);
  });

  it('applies project pins equally to prebuilt and built readers without changing canonical tables', () => {
    const project = path.join(tmp, 'project');
    fs.mkdirSync(path.join(project, '.aiwg'), { recursive: true });
    fs.writeFileSync(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({
      installed: { example: { source: 'project-local' } },
      rules: { always_load: [{ rules: ['first'] }] },
    }));
    const build = vi.spyOn(builder, 'buildIndex');
    for (const reader of [selectPrebuiltRelations(root, project).reader!, loadBuiltRelations(root, project)!]) {
      expect(reader.ruleStats('skill', 'work').by_activation).toEqual({ kernel: 1 });
      expect(Object.values(reader.index.rules)[0].activation).toBe('bound');
    }
    expect(selectPrebuiltRelations(root).reader!.ruleStats('skill', 'work').by_activation).toEqual({ bound: 1 });
    expect(build).not.toHaveBeenCalled();
  });

  it('reports invalid project pin policy instead of hiding it as a missing relationship cache', async () => {
    const project = path.join(tmp, 'project');
    fs.mkdirSync(path.join(project, '.aiwg'), { recursive: true });
    fs.writeFileSync(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({ rules: { always_load: [{ all: 'yes' }] } }));
    const build = vi.spyOn(builder, 'buildIndex');
    expect(() => selectPrebuiltRelations(root, project)).toThrow(/always_load|all/);
    expect(() => loadBuiltRelations(root, project)).toThrow(/always_load|all/);
    await expect(ensureRelations(root, project)).rejects.toThrow(/always_load|all/);
    expect(build).not.toHaveBeenCalled();
  });

  it('is portable, byte reproducible, and selected on a fresh HOME without source index reads/builds', async () => {
    put('src/rules/activation.mjs', '// byte-identical shipped module\n');
    const tables = writeTables();
    const other = path.join(tmp, 'installed');
    fs.cpSync(root, other, { recursive: true });
    fs.mkdirSync(path.join(other, 'dist/src/rules'), { recursive: true });
    fs.renameSync(path.join(other, 'src/rules/activation.mjs'), path.join(other, 'dist/src/rules/activation.mjs'));
    expect(frameworkSourceDigest(other, false)).toBe(frameworkSourceDigest(root, false));
    expect(buildPrebuiltRelations(other, entries())).toEqual(tables);
    fs.rmSync(getGraphIndexDir(root, 'framework'), { recursive: true });
    const build = vi.spyOn(builder, 'buildIndex');
    const read = vi.spyOn(fs, 'readFileSync');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await showArtifact(root, { name: 'work', typeFilter: ['skill'], json: true });
    const shown = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(shown.bound_rules).toEqual([{ name: 'first', activation: 'bound', enforcement: 'high', precedence: 'medium', overridable: true, precedence_source: 'rule', project_context: false, summary: 'First summary.', show_command: 'aiwg show rule first --body' }]);
    expect(build).not.toHaveBeenCalled();
    expect(read.mock.calls.some(([file]) => String(file).endsWith('metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(getGraphIndexDir(root, 'framework'), 'metadata.json'))).toBe(false);
    expect(selectPrebuiltRelations(other).reader).not.toBeNull();
    expect(checkPrebuiltRelations(root)).toEqual([]);
  });

  it.each(['skill', 'agent', 'flow', 'command', 'rule'])('returns a compact %s card without full-index reads', async type => {
    const file = type === 'skill' ? skill : `agentic/code/addons/example/${type}s/card.md`;
    put(file, `---\nname: card\ntype: ${type}\ndescription: Synthetic capability.\nactivation: bound\nenforcement: high\n---\n# Card\n\n## Steps\nDo the synthetic work.\n\n### Check\nVerify it.\n\n## Notes\nExtra detail.\n`);
    await buildIndex(root, { graph: 'framework', quiet: true });
    writeTables();
    fs.rmSync(getGraphIndexDir(root, 'framework'), { recursive: true });
    const read = vi.spyOn(fs, 'readFileSync');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await showArtifact(root, { name: 'card', typeFilter: [type], json: true });
    const card = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(card.content).toBeUndefined();
    expect(card.content_notice).toContain('The component body has not been fetched');
    expect(card.content_notice).toContain('--body');
    expect(card.description).toBe('Synthetic capability.');
    expect(card.id).toMatch(/^aiwg:/);
    expect(card.capability).toEqual({ kind: 'addon', name: 'example' });
    expect(typeof card.installed).toBe('boolean');
    expect(card.outline.map((section: any) => section.heading)).toEqual(['Card', 'Steps', 'Check', 'Notes']);
    expect(card.outline.every((section: any) => section.bytes > 0 && section.lines > 0)).toBe(true);
    expect(card.drill_in.body).toContain('--body');
    expect(card.drill_in.sections[1]).toContain('--section "Steps"');
    expect(card.rule_stats.required_checks).toBe(type === 'skill' ? 1 : 0);
    expect(read.mock.calls.some(([file]) => String(file).endsWith('metadata.json'))).toBe(false);
    await showArtifact(root, { name: 'card', typeFilter: [type] });
    const text = String(log.mock.calls.at(-1)?.[0]);
    expect(text).toContain(`# ${type}: card`);
    expect(text).toContain('## Outline');
    expect(text).toContain(card.content_notice);
    expect(text.indexOf(card.content_notice)).toBeLessThan(text.indexOf('## Outline'));
    expect(text).not.toContain('Do the synthetic work.');
    expect(text.match(/^rules: .* required checks$/gm)).toHaveLength(1);
    if (type === 'skill') {
      expect(text).toContain('rules: 1 high · activation: 1 bound · 1 required checks');
      expect(text.indexOf('rules:')).toBeLessThan(text.indexOf('## Bound rules'));
      expect(text).toContain('**first** [bound / high; precedence medium; overridable true; source rule]: First summary. (`aiwg show rule first --body`)');
      expect(text).toContain(card.rule_check_obligation);
      expect(text.slice(text.indexOf('## Bound rules'))).not.toContain('rules: 1 high');
    }
  });

  it('selects exact then case-insensitive headings, includes children, and rejects unknown headings', async () => {
    put(skill, '# Work\n## Steps\nDo work.\n### Check\nVerify.\n## Notes\nExtra.\n```md\n## Fake\n```\n');
    writeTables();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const show = async (options: object) => {
      await showArtifact(root, { name: 'work', typeFilter: ['skill'], json: true, ...options });
      return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    };
    const selected = await show({ sections: ['steps', 'Notes'] });
    expect(selected.content).toBe('## Steps\nDo work.\n### Check\nVerify.\n\n## Notes\nExtra.\n```md\n## Fake\n```\n');
    expect(selected.outline.map((s: any) => s.heading)).not.toContain('Fake');
    await expect(show({ sections: ['Stepps'] })).rejects.toThrow(/Unknown heading.*Stepps.*Work.*Steps.*Check.*Notes/s);
    expect((await show({ body: true })).content).toBe(fs.readFileSync(path.join(root, skill), 'utf8'));
    const card = await show({ rules: true, withRuleBodies: true });
    expect(card.content).toBeUndefined();
    expect(card.bound_rules[0].content).toContain('# First');
    expect(card.bound_rules[0].enforcement).toBe('high');
    expect(card.required_rule_checks[0].fetch_command).toMatch(/--body$/);
  });

  it('lists and reads only contained resources and refuses traversal and symlinks', async () => {
    put('agentic/code/addons/example/skills/work/references/guide.md', 'Synthetic resource');
    put('agentic/code/addons/example/skills/work/scripts/check.sh', 'echo synthetic');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const show = async (options: object) => {
      await showArtifact(root, { name: 'work', typeFilter: ['skill'], json: true, ...options });
      return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    };
    expect((await show({ resources: true })).resources.map((r: any) => r.path)).toEqual(['references/guide.md', 'scripts/check.sh']);
    expect((await show({ resource: 'references/guide.md' })).resource.body).toBe('Synthetic resource');
    await expect(show({ resource: '../../../package.json' })).rejects.toThrow(/Unknown resource/);
    fs.symlinkSync(path.join(root, 'package.json'), path.join(root, 'agentic/code/addons/example/skills/work/references/link.md'));
    await expect(show({ resource: 'references/link.md' })).rejects.toThrow(/Unknown resource/);
  });

  it('includes linked companion files and bundle templates without permitting arbitrary sibling reads', async () => {
    put(skill, '# Work\n[Guide](./guide.md)\n[Template](../../templates/form.md)\n[Not a resource](../../package.json)\n');
    put('agentic/code/addons/example/skills/work/guide.md', 'Synthetic guide');
    put('agentic/code/addons/example/templates/form.md', 'Synthetic form');
    put('agentic/code/addons/example/package.json', '{"synthetic":true}');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await showArtifact(root, { name: 'work', typeFilter: ['skill'], json: true });
    const card = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(card.resources.map((r: any) => r.path)).toEqual(['../../templates/form.md', 'guide.md']);
    await showArtifact(root, { name: 'work', typeFilter: ['skill'], json: true, resource: '../../templates/form.md' });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).resource.body).toBe('Synthetic form');
  });

  it('uses exact heading precedence and refuses ambiguous case-insensitive matches', async () => {
    put(skill, '# Work\n## Steps\nUpper.\n## steps\nLower.\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await showArtifact(root, { name: 'work', typeFilter: ['skill'], json: true, sections: ['steps'] });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).content).toBe('## steps\nLower.\n');
    await expect(showArtifact(root, { name: 'work', typeFilter: ['skill'], json: true, sections: ['STEPS'] })).rejects.toThrow(/Ambiguous heading.*STEPS.*Steps.*steps/s);
  });

  it('parses CLI drill-ins and preserves their JSON card, with clear missing-value errors', async () => {
    put(skill, '# Work\n## Steps\nSynthetic steps.\n## Notes\nSynthetic notes.\n');
    put('agentic/code/addons/example/skills/work/references/guide.md', 'Synthetic guide');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexCliMain(['show', 'skill', 'work', '--json', '--section', 'Steps', '--section', 'notes', '--rules', '--with-rule-bodies', '--resources', '--backend', 'local']);
    const card = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(card.content).toBe('## Steps\nSynthetic steps.\n\n## Notes\nSynthetic notes.\n');
    expect(card.bound_rules[0].content).toContain('# First');
    expect(card.resources[0].path).toBe('references/guide.md');
    await indexCliMain(['show', 'skill', 'work', '--json', '--resource', 'references/guide.md', '--backend', 'local']);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).resource.body).toBe('Synthetic guide');
    await indexCliMain(['show', 'skill', 'work', '--json', '--body', '--backend', 'local']);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).content).toBe(fs.readFileSync(path.join(root, skill), 'utf8'));
    for (const flag of ['--section', '--resource']) {
      await expect(indexCliMain(['show', 'skill', 'work', flag])).rejects.toThrow(`${flag} requires a value`);
      await expect(indexCliMain(['show', 'skill', 'work', flag, '--json'])).rejects.toThrow(`${flag} requires a value`);
    }
  });

  it('accepts card headings that start with -- in both --section forms', async () => {
    put(skill, '# Work\n## --max-iterations (default: 10)\nSynthetic limit.\n## Steps\nSynthetic steps.\n');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await indexCliMain(['show', 'skill', 'work', '--json', '--section', '--max-iterations (default: 10)', '--backend', 'local']);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).content).toBe('## --max-iterations (default: 10)\nSynthetic limit.\n');
    await indexCliMain(['show', 'skill', 'work', '--json', '--section=Steps', '--backend', 'local']);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).content).toBe('## Steps\nSynthetic steps.\n');
  });

  it('uses the same card and drill-ins for mocked verified web resources without local body reads', async () => {
    const web = await import('../../../src/resources/web-release.js');
    const adapter = await import('../../../src/artifacts/fortemi-core-query-adapter.js');
    const raw = `raw/${skill}`;
    const guide = path.posix.join(path.posix.dirname(raw), 'references/guide.md');
    const source = '# Work\n## Steps\nSynthetic web steps.\n';
    const release = { selector: 'synthetic', version: '1.0.0', manifestDigest: 'synthetic-digest', manifestUrl: 'https://invalid.example/manifest',
      descriptors: new Map([[guide, { path: guide, size: 15 }]]) };
    vi.spyOn(web, 'resolveWebRelease').mockResolvedValue(release as any);
    vi.spyOn(adapter, 'loadFortemiCoreMetadataEntries').mockReturnValue({ entries: entries() } as any);
    const read = vi.spyOn(web, 'fetchVerifiedRawResource').mockImplementation(async (_release, file) => {
      if (file === raw) return Buffer.from(source);
      if (file === guide) return Buffer.from('Synthetic guide');
      if (file === `raw/${rule}`) return Buffer.from('# First web policy');
      throw new Error(`Unexpected synthetic path: ${file}`);
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const params = { name: 'work', typeFilter: ['skill'], resourceSource: 'web' as const, backend: 'fortemi-core' as const, json: true, offline: true };
    await showArtifact(root, params);
    const card = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(card.content).toBeUndefined();
    expect(card.resources).toEqual([{ path: 'references/guide.md', bytes: 15 }]);
    expect(card.drill_in.body).toContain('--resource-source web --offline --body');
    await showArtifact(root, { ...params, sections: ['steps'], withRuleBodies: true, resource: 'references/guide.md' });
    const selected = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(selected.content).toBe('## Steps\nSynthetic web steps.\n');
    expect(selected.resource.body).toBe('Synthetic guide');
    expect(selected.bound_rules[0].content).toBe('# First web policy');
    expect(read).toHaveBeenCalledWith(release, guide, expect.objectContaining({ offline: true }));
  });

  it('quietly rebuilds modified rules and reports fallback only in verbose mode', async () => {
    await refreshFrameworkCapabilities(root, false);
    const before = selectPrebuiltRelations(root).reader!.index;
    put(rule, fs.readFileSync(path.join(root, rule), 'utf8').replace('First summary.', 'Edited summary.'));
    expect(selectPrebuiltRelations(root).reason).toContain('source digest differs');
    const build = vi.spyOn(builder, 'buildIndex');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reader = await ensureRelations(root);
    expect(build).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(reader!.index.fingerprint).not.toEqual(before.fingerprint);
    expect(Object.values(reader!.index.rules)[0].summary).toBe('Edited summary.');
    await ensureRelations(root);
    expect(warn).not.toHaveBeenCalled();
    await ensureRelations(root, root, { verbose: true });
    expect(warn.mock.calls.flat().join(' ')).toContain('source digest differs');
    expect(build).toHaveBeenCalledTimes(1);
    expect(checkPrebuiltRelations(root).join(' ')).toContain('source digest differs');
  });


  it('retains an actionable error when neither relationship index can be used', async () => {
    put('package.json', '{"name":"aiwg","version":"2.0.0"}');
    const refresh = await import('../../../src/artifacts/framework-capabilities.js');
    vi.spyOn(refresh, 'refreshFrameworkCapabilities').mockResolvedValue();
    fs.rmSync(path.join(getGraphIndexDir(root, 'framework'), 'relations.json'));
    await expect(ensureRelations(root)).rejects.toThrow('no usable prebuilt or per-root index');
  });

  it('detects additions, deletions, same-size edits, version mismatch and corrupt tables', () => {
    const initial = frameworkSourceDigest(root);
    const oldStat = fs.statSync(path.join(root, rule));
    put(rule, fs.readFileSync(path.join(root, rule), 'utf8').replace('First summary.', 'Other summary.'));
    fs.utimesSync(path.join(root, rule), oldStat.atime, oldStat.mtime);
    expect(frameworkSourceDigest(root)).not.toBe(initial);
    put(rule, fs.readFileSync(path.join(root, rule), 'utf8').replace('Other summary.', 'First summary.'));
    expect(frameworkSourceDigest(root)).toBe(initial);
    put('agentic/code/addons/example/skills/new/SKILL.md', '# New\n');
    expect(selectPrebuiltRelations(root).reason).toContain('source digest differs');
    fs.rmSync(path.join(root, 'agentic/code/addons/example/skills/new'), { recursive: true });
    expect(selectPrebuiltRelations(root).reader).not.toBeNull();
    fs.unlinkSync(path.join(root, skill));
    expect(selectPrebuiltRelations(root).reason).toContain('source digest differs');
    put(skill, '---\nname: work\n---\n# Work\n');
    put('package.json', '{"name":"aiwg","version":"1.0.1"}');
    expect(selectPrebuiltRelations(root).reason).toContain('package version differs');
    put('package.json', '{"name":"aiwg","version":"1.0.0"}');
    put(`${PREBUILT_RELATIONS_DIR}/relations.json`, '{}');
    expect(selectPrebuiltRelations(root).reason).toContain('checksum differs');
    expect(checkPrebuiltRelations(root)).toContain('relations.json checksum differs');
  });

  it('merges project contracts without changing precomputed shipped stats', () => {
    const reader = selectPrebuiltRelations(root).reader!;
    const target = entries().find(entry => entry.type === 'skill')!;
    const local = { ...entries().find(entry => entry.type === 'rule')!,
      path: '.aiwg/rules/local.md', name: 'local', activation: 'summary', ruleEnforcement: 'critical' };
    expect(relationshipRules([local], target, reader).map(rule => rule.name)).toEqual(['first', 'local']);
    expect(relationshipRuleStats([local], target, reader)).toEqual({
      by_enforcement: { high: 1, critical: 1 }, by_activation: { bound: 1, summary: 1 }, required_checks: 2,
    });
    expect(reader.ruleStats('skill', target.name!).required_checks).toBe(1);
    const override = { ...target, path: '.aiwg/skills/work/SKILL.md' };
    expect(relationshipRules([local], override, reader).map(rule => rule.name)).toEqual(['first', 'local']);
    expect(relationshipRuleStats([local], override, reader)).toEqual(relationshipRuleStats([local], target, reader));
  });

  it('precomputes native paths, Hermes deferral, legacy activation and flow skill projections', async () => {
    for (const [name, activation, enforcement] of [
      ['kernel-high', 'kernel', 'high'], ['kernel-critical', 'kernel', 'critical'],
      ['paths', 'paths', 'high'], ['summary', 'summary', 'medium'], ['demand', 'on-demand', 'low'],
    ]) put(`agentic/code/addons/example/rules/${name}.md`, `---\nactivation: ${activation}\nenforcement: ${enforcement}\nsummary: ${name}.\n${activation === 'paths' ? 'paths: ["src/**"]\n' : ''}---\n# ${name}\n`);
    put('agentic/code/addons/example/rules/legacy.md', '# Legacy\n\n**Enforcement Level**: MEDIUM\n');
    put('agentic/code/addons/example/flows/workflow.yaml', 'apiVersion: flow.aiwg.io/v1\nkind: FlowPlaybook\nmetadata: { name: workflow }\nspec: { description: Do work }\n');
    put(rule, fs.readFileSync(path.join(root, rule), 'utf8').replace('skills: [work]', 'skills: [work], flows: [workflow]'));
    await buildIndex(root, { graph: 'framework', quiet: true });
    const tables = writeTables();
    const relations = JSON.parse(tables['relations.json']);
    const bindings = JSON.parse(tables['bindings.json']);
    const id = (name: string): string => Object.keys(relations.rules).find(id => relations.rules[id].name === name)!;
    expect(bindings.providers.claude.native_paths).toContain(id('paths'));
    expect(bindings.providers.codex.discoverable_paths).toContain(id('paths'));
    expect(bindings.providers.hermes.kernel).toContain(id('kernel-critical'));
    expect(bindings.providers.hermes.kernel).not.toContain(id('kernel-high'));
    expect(bindings.providers.hermes.summary).toContain(id('kernel-high'));
    expect(bindings.providers.claude.kernel).toContain(id('kernel-high'));
    expect(bindings.rules[id('legacy')].activation).toBe('on-demand');
    expect(bindings.rules[id('first')].targets.flow).toHaveLength(1);
    expect(bindings.rules[id('first')].targets.skill).toHaveLength(2);
    const projection = bindings.rules[id('first')].targets.skill.find((id: string) => id.startsWith('projected:'));
    expect(bindings.targets[`skill:${projection}`].rules).toContain(id('first'));
  });

  it('repairs a removed sidecar even when the source/index receipt is unchanged', async () => {
    await refreshFrameworkCapabilities(root, false);
    const sidecar = path.join(getGraphIndexDir(root, 'framework'), 'relations.json');
    fs.unlinkSync(sidecar);
    const build = vi.spyOn(builder, 'buildIndex');
    await refreshFrameworkCapabilities(root, false);
    expect(build).toHaveBeenCalledTimes(1);
    expect(loadBuiltRelations(root)!.rulesForTarget('skill', 'work')).toHaveLength(1);
  });
});
