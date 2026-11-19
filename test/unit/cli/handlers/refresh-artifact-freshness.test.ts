// Old stamps remain current only when both deployed bytes and bundled source hashes verify.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { detectStaleProviderTrees } from '../../../../src/cli/handlers/refresh.js';
import { hasCurrentBundledArtifact } from '../../../../src/cli/handlers/refresh-artifact-freshness.js';
import { generateCommandContent, parseFrontmatter } from '../../../../src/plugin/skill-command-translator.js';
// @ts-expect-error provider tool module has no TypeScript declaration
import { mirrorSkillsAsCommands } from '../../../../tools/agents/deploy-command-mirrors.mjs';

let root: string;
const hash = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-refresh-freshness-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it.each(['claude', 'codex'])('%s accepts an old stamp only while deployed and current source hashes match', async provider => {
  const frameworkRoot = path.join(root, 'framework');
  const projectRoot = path.join(root, 'project');
  const source = '---\nname: example\nmodel: haiku\n---\nCurrent instructions.\n';
  const files = ['agents', 'commands'].map(kind => {
    const name = `example.${provider === 'codex' && kind === 'agents' ? 'toml' : 'md'}`;
    const sourcePath = path.join(frameworkRoot, 'agentic/code/addons/example', kind, 'example.md');
    const file = path.join(projectRoot, `.${provider}`, kind, name);
    const content = '# aiwg:managed v2026.11.4 bundled\nTransformed model and bound rules.\n';
    write(sourcePath, source);
    write(file, content);
    write(path.join(path.dirname(file), '.aiwg-manifest.json'), JSON.stringify({ managed: {
      [name]: { sourcePath, sourceHash: hash(source), hash: hash(content), version: '2026.11.4' },
    } }));
    return { sourcePath, file, content };
  });
  const scan = () => detectStaleProviderTrees({ projectRoot, frameworkRoot, provider: 'muse', currentVersion: '2026.11.8' });
  expect(await scan()).toEqual([]);
  write(files[0].sourcePath, source + 'Updated instructions.\n');
  expect((await scan())[0].counts).toEqual({ agents: 1, commands: 0, rules: 0 });
  write(files[0].sourcePath, source);
  write(files[1].file, files[1].content + 'Operator edit.\n');
  expect((await scan())[0].counts).toEqual({ agents: 0, commands: 1, rules: 0 });
});

it.each(['missing', 'invalid', 'no-record', 'no-hash', 'no-source-hash', 'no-source-path',
  'external-source', 'escaping-source', 'missing-source', 'edited-output', 'changed-source', 'relocated', 'windows', 'current'])(
  'handles %s receipt evidence conservatively', async scenario => {
    const framework = path.join(root, 'framework');
    const file = path.join(root, 'project/.claude/agents/example.md');
    const suffix = 'agentic/code/addons/example/agents/example.md';
    const source = path.join(framework, suffix);
    write(source, 'Canonical instructions.\n');
    write(file, '# aiwg:managed v2026.11.4 bundled\nTransformed instructions.\n');
    const record: Record<string, string> = { hash: hash(fs.readFileSync(file, 'utf8')),
      sourceHash: hash(fs.readFileSync(source, 'utf8')), sourcePath: source };
    if (scenario === 'no-hash') delete record.hash;
    if (scenario === 'no-source-hash') delete record.sourceHash;
    if (scenario === 'no-source-path') delete record.sourcePath;
    if (scenario === 'external-source') record.sourcePath = path.join(root, 'unrelated.md');
    if (scenario === 'escaping-source') record.sourcePath = path.join(framework, 'agentic/code') + '/../../../unrelated.md';
    if (scenario === 'missing-source') fs.unlinkSync(source);
    if (scenario === 'edited-output') write(file, 'Operator changes.\n');
    if (scenario === 'changed-source') write(source, 'New instructions.\n');
    if (scenario === 'relocated') record.sourcePath = `/old-install/${suffix}`;
    if (scenario === 'windows') record.sourcePath = `C:\\old-install\\${suffix.replaceAll('/', '\\')}`;
    const receipt = path.join(path.dirname(file), '.aiwg-manifest.json');
    if (scenario !== 'missing') write(receipt, scenario === 'invalid' ? 'invalid JSON' : JSON.stringify({
      managed: scenario === 'no-record' ? {} : { 'example.md': record },
    }));
    expect(await hasCurrentBundledArtifact(file, framework)).toBe(['relocated', 'windows', 'current'].includes(scenario));
  },
);

it.each(['claude', 'codex'])('%s recognizes current legacy skill-command mirrors without sourceHash', async provider => {
  const frameworkRoot = path.join(root, 'framework');
  const projectRoot = path.join(root, 'project');
  const bundle = path.join(frameworkRoot, 'agentic/code/addons/example');
  const source = path.join(bundle, 'skills/project-status/SKILL.md');
  const raw = '---\nname: project-status\ndescription: Show project status\n---\nShow the current status.\n';
  write(source, raw);
  mirrorSkillsAsCommands({ name: provider, paths: { commands: `.${provider}/commands` } }, projectRoot, bundle,
    { mode: 'all', deployCommands: true, deployVersion: '2026.11.4' });
  const file = path.join(projectRoot, `.${provider}/commands/project-status.md`);
  expect(await hasCurrentBundledArtifact(file, frameworkRoot)).toBe(true);
  expect(await detectStaleProviderTrees({ projectRoot, frameworkRoot, provider: 'muse', currentVersion: '2026.11.8' })).toEqual([]);
  write(source, raw.replace('Show project status', 'New status description'));
  expect(await hasCurrentBundledArtifact(file, frameworkRoot)).toBe(false);
  write(source, raw + 'New instructions.\n');
  expect(await hasCurrentBundledArtifact(file, frameworkRoot)).toBe(false);
  write(source, raw);
  const receiptPath = path.join(path.dirname(file), '.aiwg-manifest.json');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const output = (content: string) => {
    write(file, content);
    receipt.managed['project-status.md'].hash = hash(content);
    write(receiptPath, JSON.stringify(receipt));
  };
  output(fs.readFileSync(file, 'utf8') + '\n<!-- AIWG:bound-rules:start -->\nGenerated pointer.\n<!-- AIWG:bound-rules:end -->\n');
  expect(await hasCurrentBundledArtifact(file, frameworkRoot)).toBe(true);
  const { frontmatter, body } = parseFrontmatter(raw);
  const translated = generateCommandContent('project-status', frontmatter, body).replace(/^---\n/, '---\n# aiwg:managed v2026.11.4 bundled\n');
  output(translated);
  expect(await hasCurrentBundledArtifact(file, frameworkRoot)).toBe(true);
  for (const policy of ['model: haiku', 'modelRole: efficiency', 'modelRole: efficiency\n  modelEffort: low\n  modelRationale: Simple task']) {
    output(translated);
    write(source, raw.replace('description: Show project status', `description: Show project status\ncommandHint:\n  ${policy}`));
    expect(await hasCurrentBundledArtifact(file, frameworkRoot)).toBe(false);
    mirrorSkillsAsCommands({ name: provider, paths: { commands: `.${provider}/commands` } }, projectRoot, bundle,
      { mode: 'all', deployCommands: true, deployVersion: '2026.11.4' });
    expect(await hasCurrentBundledArtifact(file, frameworkRoot)).toBe(true);
  }
  write(source, raw.replace('description: Show project status\n', ''));
  output('---\n# aiwg:managed v2026.11.4 bundled\nname: project-status\ndescription: Run AIWG skill project-status\n---\n\nShow the current status.\n');
  expect(await hasCurrentBundledArtifact(file, frameworkRoot)).toBe(true);
  receipt.managed['project-status.md'].sourceHash = 9;
  write(receiptPath, JSON.stringify(receipt));
  expect(await hasCurrentBundledArtifact(file, frameworkRoot)).toBe(false);
});

it.each([['factory', 'agents', '.factory/droids'], ['claude', 'rules', '.claude/rules']])(
  'preserves the existing %s %s stamp rule', async (provider, kind, directory) => {
    const frameworkRoot = path.join(root, 'framework');
    const projectRoot = path.join(root, 'project');
    const sourcePath = path.join(frameworkRoot, 'agentic/code/addons/example', kind, 'example.md');
    const content = '# aiwg:managed v2026.11.4 bundled\nInstructions.\n';
    const file = path.join(projectRoot, directory, 'example.md');
    write(sourcePath, content);
    write(file, content);
    write(path.join(path.dirname(file), '.aiwg-manifest.json'), JSON.stringify({ managed: {
      'example.md': { sourcePath, sourceHash: hash(content), hash: hash(content) },
    } }));
    const trees = await detectStaleProviderTrees({ projectRoot, frameworkRoot, provider: 'muse', currentVersion: '2026.11.8' });
    expect(trees).toEqual([expect.objectContaining({ provider, total: 1 })]);
  },
);
