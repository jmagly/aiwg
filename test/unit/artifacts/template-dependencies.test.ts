// Cover bundle-scoped template references, Flow edges and the shared lint rule.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildIndex, extractMentions } from '../../../src/artifacts/index-builder.js';
import { extractFlowDependencies } from '../../../src/artifacts/index-dependencies.js';
import { extractTemplateReferences } from '../../../src/artifacts/template-references.js';
import { lintTemplateReferences } from '../../../tools/mentions/template-lint.mjs';
import { INDEX_DIR } from '../../../src/artifacts/types.js';

const bundle = 'agentic/code/frameworks/example';
const target = `${bundle}/templates/card.md`;
const source = `${bundle}/skills/use-card/SKILL.md`;
const forms = [
  'templates/card.md',
  '$AIWG_ROOT/agentic/code/frameworks/example/templates/card.md',
  '@$AIWG_ROOT/agentic/code/frameworks/example/templates/card.md',
  '../../templates/card.md',
  'example/templates/card.md',
  'agentic/code/frameworks/example/templates/card.md',
];
let root: string;
function write(file: string, body: string) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}
async function index(force = true) {
  await buildIndex(root, { graph: 'framework', outputDir: root, force, quiet: true, includeIgnored: true });
  const dir = path.join(root, INDEX_DIR, 'framework');
  return {
    entries: JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')).entries,
    edges: JSON.parse(fs.readFileSync(path.join(dir, 'dependencies.json'), 'utf8')),
  };
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-template-deps-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('concrete template references', () => {
  it.each(forms)('extracts, resolves and lints %s', async reference => {
    write(target, '# Card');
    const content = `# Use card\n\nUse \`${reference}\` twice: ${reference}.`;
    write(source, content);
    expect(extractTemplateReferences(content)).toEqual([reference.replace(/^@/, '')]);
    expect(extractMentions(content)).toContain(reference.replace(/^@/, ''));
    const { edges, entries } = await index();
    expect(edges[source].upstream).toEqual([{ path: target, type: 'depends-on' }]);
    expect(entries[target].dependents).toEqual([source]);
    expect(lintTemplateReferences(path.join(root, source), content, root)).toEqual([]);
    fs.unlinkSync(path.join(root, target));
    expect(lintTemplateReferences(path.join(root, source), content, root)).toHaveLength(1);
  });

  it('ignores directory-only mentions, URLs and placeholder paths', async () => {
    const content = [
      'templates/requirements/', '../../templates/requirements/',
      '@$AIWG_ROOT/agentic/code/frameworks/example/templates/requirements/',
      'https://example.test/templates/card.md', 'templates/<name>.md',
    ].join('\n');
    write(source, content);
    expect(extractTemplateReferences(content)).toEqual([]);
    expect((await index()).edges[source].upstream).toEqual([]);
    expect(lintTemplateReferences(path.join(root, source), content, root)).toEqual([]);
  });

  it('resolves Markdown targets, anchors and provider template extensions', async () => {
    write(target, '# Card');
    write(`${bundle}/templates/AGENTS.md.aiwg-template`, '# Provider');
    write(source, '[card](../../templates/card.md#fields)\nUse templates/AGENTS.md.aiwg-template');
    expect((await index()).edges[source].upstream.map((edge: any) => edge.path).sort()).toEqual([
      `${bundle}/templates/AGENTS.md.aiwg-template`, target,
    ]);
  });

  it('uses the owning addon or framework, never an unrelated suffix match', async () => {
    const addon = 'agentic/code/addons/other';
    const addonSource = `${addon}/skills/use-card/SKILL.md`;
    write(target, '# Card');
    write(`${addon}/templates/card.md`, '# Other card');
    write(source, 'templates/card.md');
    write(addonSource, 'templates/card.md');
    const first = await index();
    expect(first.edges[source].upstream[0].path).toBe(target);
    expect(first.edges[addonSource].upstream[0].path).toBe(`${addon}/templates/card.md`);
    fs.unlinkSync(path.join(root, target));
    const next = await index(false);
    expect(next.edges[source].upstream).toEqual([]);
    expect(next.entries[`${addon}/templates/card.md`].dependents).toEqual([addonSource]);
  });

  it('does not link a bare project filename to a same-named template', async () => {
    write(`${bundle}/templates/project/CLAUDE.md`, '# CLAUDE.md template');
    write(`${bundle}/skills/use-card/notes.md`, '# Sibling notes');
    write(source, 'Read @CLAUDE.md and @AIWG.md for user configuration; see @notes.md.');
    const { edges } = await index();
    const upstream = (edges[source]?.upstream ?? []).map((edge: { path: string }) => edge.path);
    expect(upstream).not.toContain(`${bundle}/templates/project/CLAUDE.md`);
    expect(upstream).toContain(`${bundle}/skills/use-card/notes.md`);
  });

  it('never turns an existing unindexed template into an edge', async () => {
    write('outside/templates/card.md', '# Outside');
    write(source, '$AIWG_ROOT/outside/templates/card.md');
    expect((await index()).edges[source].upstream).toEqual([]);
  });

  it('keeps AIWG_ROOT paths rooted and removes stale reverse edges on incremental builds', async () => {
    write(target, '# Card');
    write(source, 'templates/card.md\n$AIWG_ROOT/templates/card.md');
    expect((await index()).edges[source].upstream).toHaveLength(1);
    write(source, '# No template needed');
    const next = await index(false);
    expect(next.edges[source].upstream).toEqual([]);
    expect(next.entries[target].dependents).toEqual([]);
  });
});

describe('declarative Flow dependencies', () => {
  it('links capabilities, agents and templates with bundle-scoped names', async () => {
    const playbook = `${bundle}/flows/release.yaml`;
    const capability = `${bundle}/flows/capabilities/check.yaml`;
    const agent = `${bundle}/agents/reviewer.md`;
    const header = 'apiVersion: flow.aiwg.io/v1\n';
    const check = `${header}kind: FlowCapability\nmetadata:\n  name: check\nspec:\n  agent: reviewer\n  template: templates/card.md\n`;
    write(capability, check);
    write(target, '# Card');
    write(agent, '---\nname: Reviewer Agent\n---\n# Reviewer');
    write('agentic/code/addons/other/flows/check.yaml', check);
    write('agentic/code/addons/other/agents/reviewer.md', '---\nname: Other Reviewer\n---\n# Other reviewer');
    write(playbook, `${header}kind: FlowPlaybook\nmetadata:\n  name: release\nspec:\n  steps:\n    - id: first\n      capability: check\n      rollback_capability: check\n    - id: second\n      capability: absent\n      depends_on: [first]\n`);
    const { edges, entries } = await index();
    expect(entries[playbook].type).toBe('flow');
    expect(edges[playbook].upstream).toEqual([{ path: capability, type: 'depends-on' }]);
    expect(edges[capability].upstream.map((edge: any) => edge.path).sort()).toEqual([agent, target].sort());
    expect(entries[capability].dependents).toEqual([playbook]);
  });

  it('does not mistake scripts or local step IDs for indexed references', () => {
    const spec: any = {
      steps: [{ id: 'check', depends_on: ['check'], capability: 'check' }],
      script: { agent: 'fake' }, description: 'agent: fake',
    };
    spec.self = spec; // YAML aliases must not cause an unbounded walk.
    expect(extractFlowDependencies(spec)).toEqual(['flow:check']);
  });
});

describe('ML007 template lint', () => {
  it('fails the existing CLI on missing templates and passes after repair', () => {
    write(source, 'templates/card.md');
    const cli = path.resolve('tools/mentions/mention-lint.mjs');
    const run = () => spawnSync(process.execPath, [cli, '--target', 'agentic/code', '--rules', 'ML007'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });
    const failed = run();
    expect(failed.status, failed.stderr).toBe(1);
    expect(failed.stdout).toContain('ML007 templates/card.md');
    write(target, '# Card');
    const passed = run();
    expect(passed.status, passed.stderr).toBe(0);
    expect(passed.stdout).toContain('0 errors');
  });
});
