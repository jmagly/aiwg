// Check automatic pruning against persisted copy intent and ownership digests.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyConfig, writeAiwgConfig } from '../../../src/config/aiwg-config.js';
import { recordBundleDeployment } from '../../../src/cli/handlers/bundle-deployment-mode.js';
import { pruneStaleManagedAgentFiles } from '../../../src/cli/handlers/refresh.js';
import { automaticRemovalAllowed, preserveDeploymentOutputs } from '../../../src/providers/deployment-preservation.mjs';
// @ts-expect-error provider tool module
import { writeCodexSkillMetadata } from '../../../tools/skills/codex-skill-metadata.mjs';
// @ts-expect-error provider tool module
import { deploySkillDir } from '../../../tools/agents/providers/base-skill-copy.mjs';
// @ts-expect-error provider tool module
import { deploySkillsWithKernelRouting } from '../../../tools/agents/providers/base-kernel-skills.mjs';
// @ts-expect-error provider tool module
import { prepareRuleDeployment, commitRuleDeploymentPlan } from '../../../tools/agents/providers/rule-delivery.mjs';
let root: string;
const write = (file: string, bytes: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const hash = (bytes: string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-mode-')); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it('keeps foreign kernel receipts byte-identical during a named addon deploy', () => {
  const file = path.join(root, '.claude/skills/kernel/SKILL.md');
  const receipt = path.join(path.dirname(file), '.aiwg-manifest.json');
  const metadata = JSON.stringify({ managed: { 'SKILL.md': { hash: hash('original'), owners: ['kernel'] } } });
  const before = new Map([[file, Buffer.from('original')], [receipt, Buffer.from(metadata)]]);
  write(file, 'unrelated binding rewrite');
  write(receipt, JSON.stringify({ managed: { 'SKILL.md': { hash: hash('unrelated binding rewrite'), owners: ['addon'] } } }));
  preserveDeploymentOutputs(before, [root], { target: root, provider: 'claude', frameworkSlug: 'addon', bundleOnly: true });
  expect(fs.readFileSync(file, 'utf8')).toBe('original');
  expect(fs.readFileSync(receipt, 'utf8')).toBe(metadata);
});
it.each(['skills.ts', 'specialists.ts'])('refreshes shared Flue %s across owners while retaining operator edits', name => {
  const file = path.join(root, 'src/aiwg', name);
  const receipt = path.join(root, '.aiwg/.aiwg-manifest.json');
  const record = { hash: hash('first bundle'), owners: ['first'], kind: 'generated' };
  const metadata = JSON.stringify({ scope: 'project', managed: { [`src/aiwg/${name}`]: record } });
  const before = new Map([[file, Buffer.from('first bundle')], [receipt, Buffer.from(metadata)]]);
  const opts = { target: root, provider: 'flue', frameworkSlug: 'second', bundleOnly: true, writtenFiles: [file] };
  write(file, 'all selected bundles'); write(receipt, metadata);
  preserveDeploymentOutputs(before, [root], opts);
  expect(fs.readFileSync(file, 'utf8')).toBe('all selected bundles');
  expect(opts.writtenFiles).toContain(file);
  before.set(file, Buffer.from('operator edit'));
  write(file, 'next generation');
  preserveDeploymentOutputs(before, [root], opts);
  expect(fs.readFileSync(file, 'utf8')).toBe('operator edit');
  expect(JSON.parse(fs.readFileSync(receipt, 'utf8')).managed[`src/aiwg/${name}`]).toEqual(record);
});
it.each([false, true])('single-bundle projection scopes retirement, retains explicit copies and explains critical removals (copy=%s)', async copy => {
  const source = path.join(root, '.aiwg/addons/demo');
  const target = path.join(root, 'project');
  const rules = path.join(target, '.claude/rules');
  const current = path.join(source, 'rules/current.md');
  const text = '<!-- aiwg:managed v2026.11.1 bundled -->\n---\nactivation: kernel\nenforcement: critical\n---\nOriginal\n';
  write(current, '---\nname: current\nactivation: kernel\n---\nCurrent\n');
  const records = Object.fromEntries([
    ['retired.md', ['demo']], ['foreign.md', ['other']], ['shared.md', ['demo', 'other']], ['edited.md', ['demo']],
  ].map(([name, owners]) => {
    write(path.join(rules, name as string), text + (name === 'edited.md' ? 'Operator edit\n' : ''));
    return [name, { hash: hash(text), owners }];
  }));
  write(path.join(rules, '.aiwg-manifest.json'), JSON.stringify({ managed: records }));
  const opts = { srcRoot: source, target, provider: 'claude', mode: 'all', frameworkSlug: 'demo',
    bundleOnly: true, copyMode: copy, deployRules: true, contextFiles: false,
    ruleSources: [current], bindingEntries: [], pinConfigs: { project: {}, user: {} } };
  const provider = { name: 'claude', paths: { rules: '.claude/rules' } };
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await prepareRuleDeployment({ ...opts, dryRun: true }, provider, async () => {});
  expect(output.mock.calls.flat().join('\n').includes(`Would remove ${path.join(rules, 'retired.md')} (critical rule retired because`)).toBe(!copy);
  expect(fs.existsSync(path.join(rules, 'retired.md'))).toBe(true);
  commitRuleDeploymentPlan(await prepareRuleDeployment(opts, provider, async () => {}));
  expect(vi.mocked(console.warn).mock.calls.flat().join('\n').includes(`Removing ${path.join(rules, 'retired.md')} (critical rule retired because`)).toBe(!copy);
  expect(fs.existsSync(path.join(rules, 'retired.md'))).toBe(copy);
  for (const name of ['foreign.md', 'shared.md', 'edited.md']) {
    expect(fs.readFileSync(path.join(rules, name), 'utf8')).toBe(text + (name === 'edited.md' ? 'Operator edit\n' : ''));
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(rules, '.aiwg-manifest.json'), 'utf8'));
  expect(receipt.managed['retired.md']).toEqual(copy ? records['retired.md'] : undefined);
  expect(receipt.managed['foreign.md']).toEqual(records['foreign.md']);
  expect(receipt.managed['shared.md']).toEqual(records['shared.md']);
  expect(receipt.managed['edited.md']).toEqual(records['edited.md']);
  expect(receipt.managed['current.md'].owners).toEqual(['demo']);
});
it.each([false, true])('stale refresh pruning keeps edits and follows copy=%s, including cross-provider trees', async copy => {
  const project = path.join(root, 'project'), corpus = path.join(root, 'corpus');
  write(path.join(corpus, 'package.json'), '{"version":"2026.10.19"}');
  const config = emptyConfig(['claude']); config.installed.sdlc = { deployedTo: { claude: { copy } } };
  await writeAiwgConfig(project, config);
  await recordBundleDeployment(project, 'sdlc', 'claude', copy ? ['--copy-all'] : [], corpus);
  const dir = path.join(project, '.claude/agents');
  const original = '<!-- aiwg:managed v2026.1.0 bundled -->\n# Retired\n';
  write(path.join(dir, 'retired.md'), original);
  write(path.join(dir, 'edited.md'), `${original}Operator edit\n`);
  write(path.join(dir, '.aiwg-manifest.json'), JSON.stringify({ managed: Object.fromEntries(['retired.md', 'edited.md'].map(name => [name, { owners: ['sdlc-complete'], hash: hash(original) }])) }));
  for (const provider of ['claude', 'codex']) {
    const planned = await pruneStaleManagedAgentFiles({ projectRoot: project, frameworkRoot: corpus, provider, crossProvider: 'prune', allowTrackedDeletes: true, dryRun: true });
    expect(planned.removals).toEqual(copy ? [] : [{ provider: 'claude', paths: ['.claude/agents/retired.md'] }]);
  }
  await pruneStaleManagedAgentFiles({ projectRoot: project, frameworkRoot: corpus, provider: 'claude' });
  expect(fs.existsSync(path.join(dir, 'retired.md'))).toBe(copy);
  expect(fs.readFileSync(path.join(dir, 'edited.md'), 'utf8')).toContain('Operator edit');
  delete config.installed.sdlc; await writeAiwgConfig(project, config);
  if (copy) expect(automaticRemovalAllowed(project, 'claude', path.join(dir, 'retired.md'))).toBe(false);
});
it.each([false, true])('cleans legacy standard copies in index mode and preserves them in copy mode (edited=%s)', edited => {
  const source = path.join(root, 'agentic/code/frameworks/demo/skills/standard');
  const standard = path.join(root, 'project/.claude/.aiwg/skills'), kernel = path.join(root, 'project/.claude/skills');
  write(path.join(source, 'SKILL.md'), '---\nname: standard\nplatforms: [all]\n---\nOriginal\n');
  deploySkillDir(source, standard, { provider: 'claude' });
  const file = path.join(standard, 'standard/SKILL.md');
  if (edited) fs.writeFileSync(file, 'Operator edit\n');
  deploySkillsWithKernelRouting([source], standard, kernel, { provider: 'claude', copyStandardSkills: true });
  expect(fs.existsSync(file)).toBe(true);
  deploySkillsWithKernelRouting([source], standard, kernel, { provider: 'claude' });
  expect(fs.existsSync(file)).toBe(edited);
  if (edited) expect(fs.readFileSync(file, 'utf8')).toBe('Operator edit\n');
});
it('retains removed resources in copy mode while updating an unchanged standard skill', () => {
  const source = path.join(root, 'agentic/code/addons/demo/skills/standard'), dest = path.join(root, 'skills');
  write(path.join(source, 'SKILL.md'), 'First version\n'); write(path.join(source, 'resource.txt'), 'Retained resource\n');
  deploySkillDir(source, dest, { copyStandardSkills: true });
  write(path.join(source, 'SKILL.md'), 'Current version\n'); fs.rmSync(path.join(source, 'resource.txt'));
  deploySkillDir(source, dest, { copyStandardSkills: true });
  expect(fs.readFileSync(path.join(dest, 'standard/SKILL.md'), 'utf8')).toBe('Current version\n');
  expect(fs.readFileSync(path.join(dest, 'standard/resource.txt'), 'utf8')).toBe('Retained resource\n');
});
it('restores staged copy deletions and edited payloads with their old digests', () => {
  const file = path.join(root, '.claude/skills/demo/SKILL.md'), receipt = path.join(path.dirname(file), '.aiwg-manifest.json');
  const before = new Map([[file, Buffer.from('Operator edit')], [receipt, Buffer.from(JSON.stringify({ managed: { 'SKILL.md': { hash: hash('original'), owners: ['demo'] } } }))]]);
  write(file, 'New generated copy'); write(receipt, '{}');
  preserveDeploymentOutputs(before, [root], { target: root, provider: 'claude', copyStandardSkills: true });
  expect(fs.readFileSync(file, 'utf8')).toBe('Operator edit');
  expect(JSON.parse(fs.readFileSync(receipt, 'utf8')).managed['SKILL.md'].hash).toBe(hash('original'));
  fs.rmSync(file);
  preserveDeploymentOutputs(new Map([[file, Buffer.from('Unchanged')]]), [root], { target: root, copyStandardSkills: true });
  expect(fs.readFileSync(file, 'utf8')).toBe('Unchanged');
});

it.each([false, true])('updates unchanged Codex metadata and preserves edits with copy=%s', copy => {
  const source = path.join(root, 'source/standard'), dest = path.join(root, 'skills');
  const opts = { copyStandardSkills: true, copyMode: copy };
  write(path.join(source, 'SKILL.md'), 'Original skill\n');
  deploySkillDir(source, dest, opts);
  const target = path.join(dest, 'standard');
  writeCodexSkillMetadata(target, 'name: first\n');
  deploySkillDir(source, dest, opts);
  writeCodexSkillMetadata(target, 'name: current\n');
  expect(fs.readFileSync(path.join(target, 'agents/openai.yaml'), 'utf8')).toBe('name: current\n');
  write(path.join(target, 'agents/openai.yaml'), 'Operator metadata\n');
  deploySkillDir(source, dest, opts);
  writeCodexSkillMetadata(target, 'name: next\n');
  expect(fs.readFileSync(path.join(target, 'agents/openai.yaml'), 'utf8')).toBe('Operator metadata\n');
});

it.each([{ copy: false }, { copy: true }, { copy: false, package: true }])('respects another parent’s mode during an index pass (%j)', parentMode => {
  const file = path.join(root, '.claude/skills/aiwg-utils/SKILL.md');
  const receiptFile = path.join(path.dirname(file), '.aiwg-manifest.json');
  const receipt = JSON.stringify({ managed: { 'SKILL.md': { owners: ['aiwg-utils'], hash: hash('original') } } });
  write(file, 'original'); write(receiptFile, receipt);
  write(path.join(root, '.aiwg/.aiwg-manifest.json'), JSON.stringify({ bundleDeployments: { claude: {
    'sdlc-complete': { ...parentMode, produces: ['aiwg-utils'] },
    'aiwg-utils': { copy: true, produces: ['aiwg-utils'] },
  } } }));
  const before = new Map([[file, Buffer.from('original')], [receiptFile, Buffer.from(receipt)]]);
  fs.rmSync(file);
  preserveDeploymentOutputs(before, [root], { target: root, provider: 'claude', copyMode: false,
    srcRoot: path.join(root, 'agentic/code/addons/aiwg-utils') });
  expect(fs.existsSync(file)).toBe(parentMode.copy || parentMode.package === true);
  if (parentMode.copy || parentMode.package) expect(fs.readFileSync(file, 'utf8')).toBe('original');
});


it.each(['history', 'declaration'])('preserves a package deployment from its %s, including produced owners', async source => {
  const file = path.join(root, '.agents/skills/custom/SKILL.md');
  const receiptFile = path.join(path.dirname(file), '.aiwg-manifest.json');
  const receipt = JSON.stringify({ managed: { 'SKILL.md': { owners: ['custom'], hash: hash('original') } } });
  write(file, 'original'); write(receiptFile, receipt);
  await recordBundleDeployment(root, 'custom', 'flue', ['--package'], root);
  const config = emptyConfig(['flue']);
  if (source === 'declaration') config.installed.custom = { deployedTo: { flue: { package: true } } };
  expect(automaticRemovalAllowed(root, 'flue', file, config)).toBe(false);
  const before = new Map([[file, Buffer.from('original')], [receiptFile, Buffer.from(receipt)]]);
  fs.rmSync(file);
  preserveDeploymentOutputs(before, [root], { target: root, provider: 'flue', config, mode: 'other' });
  expect(fs.readFileSync(file, 'utf8')).toBe('original');
  const { providerCopyMode } = await import('../../../src/providers/deployment-preservation.mjs');
  expect(providerCopyMode(root, 'flue', undefined, config)).toBe(true);
  expect(providerCopyMode(root, 'flue', 'custom', config, 'custom')).toBe(false);
});
