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
let root: string;
const write = (file: string, bytes: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const hash = (bytes: string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-mode-')); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
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

it.each([false, true])('respects another parent’s copy mode during an index pass (parent copy=%s)', parentCopy => {
  const file = path.join(root, '.claude/skills/aiwg-utils/SKILL.md');
  const receiptFile = path.join(path.dirname(file), '.aiwg-manifest.json');
  const receipt = JSON.stringify({ managed: { 'SKILL.md': { owners: ['aiwg-utils'], hash: hash('original') } } });
  write(file, 'original'); write(receiptFile, receipt);
  write(path.join(root, '.aiwg/.aiwg-manifest.json'), JSON.stringify({ bundleDeployments: { claude: {
    'sdlc-complete': { copy: parentCopy, produces: ['aiwg-utils'] },
    'aiwg-utils': { copy: true, produces: ['aiwg-utils'] },
  } } }));
  const before = new Map([[file, Buffer.from('original')], [receiptFile, Buffer.from(receipt)]]);
  fs.rmSync(file);
  preserveDeploymentOutputs(before, [root], { target: root, provider: 'claude', copyMode: false,
    srcRoot: path.join(root, 'agentic/code/addons/aiwg-utils') });
  expect(fs.existsSync(file)).toBe(parentCopy);
  if (parentCopy) expect(fs.readFileSync(file, 'utf8')).toBe('original');
});
