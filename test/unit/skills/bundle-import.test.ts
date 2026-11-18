// Offline acceptance coverage for repository-to-addon import and pinned refresh.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitFixture, repositorySkills } from '../../fixtures/skills/bundle-repositories.js';
import { BundleManifestSchema } from '../../../src/extensions/manifest.js';
import { loadGraphIndexFile } from '../../../src/artifacts/index-reader.js';
import { isArtifactInstalled } from '../../../src/artifacts/query-engine-installation.js';

let root: string;
let projectDir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-bundle-import-'));
  projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const bundle = () => path.join(projectDir, '.aiwg/addons/community');
const read = (file: string) => fs.readFileSync(path.join(bundle(), file), 'utf8');
const manifest = () => JSON.parse(read('manifest.json'));
const importer = async () => (await import('../../../src/skills/bundle-import.js')).importSkillBundle;

describe('repository skill bundle import', () => {
  it('imports 53 + 17 skills, preserves licenses, renames one collision and indexes without installing', async () => {
    const importBundle = await importer();
    const first = path.join(root, 'marketingskills');
    const second = path.join(root, 'social-media-skills');
    const commit = gitFixture(first, { ...repositorySkills('marketing', 53), LICENSE: 'MIT License\n' });
    gitFixture(second, { ...repositorySkills('social', 17), 'LICENSE.md': 'MIT License\n' });
    const collision = path.join(root, 'agentic/code/frameworks/media-marketing-kit/skills/sales-enablement');
    fs.mkdirSync(collision, { recursive: true });
    fs.writeFileSync(path.join(collision, 'SKILL.md'), '---\nname: sales-enablement\n---\n');
    const result = await importBundle({ source: first, ref: commit, into: 'community', projectDir, frameworkRoot: root });
    expect(result.diagnostics.filter(item => item.code === 'collision')).toHaveLength(1);
    expect(result.manifest.upstream?.[0]).toMatchObject({ commit, license: 'MIT', renames: { 'sales-enablement': 'marketingskills-sales-enablement' } });
    await importBundle({ source: second, ref: 'main', into: 'community', projectDir, frameworkRoot: root });
    expect(manifest().skills).toHaveLength(70);
    expect(BundleManifestSchema.safeParse(manifest()).success).toBe(true);
    expect(read('skills/marketingskills-sales-enablement/SKILL.md')).toContain('name: marketingskills-sales-enablement');
    expect(fs.readdirSync(path.join(bundle(), 'licenses'))).toHaveLength(2);
    const index: any = loadGraphIndexFile(projectDir, 'metadata.json', 'project');
    const skills = Object.values(index.entries).filter((entry: any) => entry.type === 'skill') as any[];
    expect(skills).toHaveLength(70);
    expect(await isArtifactInstalled(projectDir, root, skills[0], 'addon', 'community')).toBe(false);
    expect(fs.existsSync(path.join(projectDir, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, '.aiwg/installed.json'))).toBe(false);
    await expect(importBundle({ refresh: 'community', ref: 'main', projectDir, frameworkRoot: root })).rejects.toThrow(/exactly one upstream/);
  });

  it('reports collisions, scripts, binaries and dangling excluded references before project writes', async () => {
    const importBundle = await importer();
    const source = path.join(root, 'source');
    gitFixture(source, {
      ...repositorySkills('marketing', 1), LICENSE: 'MIT License',
      'skills/sales-enablement/SKILL.md': '---\nname: sales-enablement\ndescription: test\n---\nSee `../../tools/clis/helper.cjs` and [test](tests/check.md).\n',
      'tools/clis/helper.cjs': 'throw new Error("never execute")',
      'skills/sales-enablement/tests/check.md': 'Excluded test',
      'skills/sales-enablement/helper.cjs': 'throw new Error("never execute")',
      'skills/sales-enablement/blob.bin': Buffer.from([0, 1, 2]),
    });
    const owner = path.join(projectDir, '.agents/skills/sales-enablement');
    fs.mkdirSync(owner, { recursive: true });
    fs.writeFileSync(path.join(owner, 'SKILL.md'), '---\nname: sales-enablement\n---\n');
    let reports = 0;
    const report = (plan: any) => {
      reports++;
      expect(fs.existsSync(path.join(projectDir, '.aiwg'))).toBe(false);
      expect(plan.diagnostics.map((d: any) => d.code)).toEqual(expect.arrayContaining(['collision', 'script', 'binary', 'dangling-reference']));
    };
    const options = { source, ref: 'main', into: 'community', projectDir, frameworkRoot: root, report };
    const planned = await importBundle({ ...options, dryRun: true });
    expect(planned.installed).toBe(false);
    expect(reports).toBe(1);
    await importBundle(options);
    expect(reports).toBe(2);
    expect(fs.existsSync(path.join(bundle(), 'tools'))).toBe(false);
    expect(fs.existsSync(path.join(bundle(), 'skills/source-sales-enablement/tests'))).toBe(false);
  });

  it('refreshes pinned bytes, previews a file diff, and preserves local renames', async () => {
    const importBundle = await importer();
    const source = path.join(root, 'source');
    const files = repositorySkills('marketing', 1);
    const commit = gitFixture(source, { ...files, LICENSE: 'MIT License' });
    const owner = path.join(projectDir, '.agents/skills/sales-enablement');
    fs.mkdirSync(owner, { recursive: true });
    fs.writeFileSync(path.join(owner, 'SKILL.md'), '---\nname: sales-enablement\n---\n');
    await importBundle({ source, into: 'community', ref: commit, projectDir, frameworkRoot: root });
    const file = 'skills/source-sales-enablement/SKILL.md';
    const original = read(file);
    fs.writeFileSync(path.join(bundle(), file), original + '\nlocal change');
    gitFixture(source, { ...files, LICENSE: 'MIT License', 'skills/new-skill/SKILL.md': 'new upstream HEAD' });
    const plan = await importBundle({ refresh: 'community', dryRun: true, projectDir, frameworkRoot: root });
    expect(plan.diff.modified).toContain(file);
    expect(read(file)).toContain('local change');
    await importBundle({ refresh: 'community', projectDir, frameworkRoot: root });
    expect(read(file)).toBe(original);
    expect(manifest().upstream[0].commit).toBe(commit);
    expect(manifest().upstream[0].renames).toEqual({ 'sales-enablement': 'source-sales-enablement' });
    expect(manifest().skills).toEqual(['source-sales-enablement']);
  });

  it('filters skill globs and refuses invalid inputs, absent licenses and symlinks without writing', async () => {
    const importBundle = await importer();
    const source = path.join(root, 'source');
    gitFixture(source, { ...repositorySkills('social', 3), LICENSE: 'MIT License' });
    const base = { source, ref: 'main', into: 'community', projectDir, frameworkRoot: root };
    const plan = await importBundle({ ...base, only: 'social-[12]', dryRun: true });
    expect(plan.manifest.skills).toEqual(['social-1', 'social-2']);
    await expect(importBundle({ ...base, into: '../escape' })).rejects.toThrow();
    await expect(importBundle({ ...base, only: 'absent-*' })).rejects.toThrow();
    gitFixture(source, repositorySkills('social', 1));
    await expect(importBundle(base)).rejects.toThrow(/license/i);
    expect(fs.existsSync(path.join(projectDir, '.aiwg'))).toBe(false);
  });

  it('rejects symlinked destinations and keeps other addon files during refresh', async () => {
    const importBundle = await importer();
    const source = path.join(root, 'source');
    gitFixture(source, { ...repositorySkills('social', 1), LICENSE: 'MIT License' });
    const base = { source, into: 'community', projectDir, frameworkRoot: root };
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(projectDir, '.aiwg'));
    await expect(importBundle(base)).rejects.toThrow(/Unsafe addon destination/);
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(path.join(projectDir, '.aiwg'));
    await importBundle(base);
    fs.writeFileSync(path.join(bundle(), 'README.md'), 'Local addon notes');
    await expect(importBundle(base)).rejects.toThrow(/already imported/);
    await importBundle({ refresh: 'community', projectDir, frameworkRoot: root });
    expect(read('README.md')).toBe('Local addon notes');
    fs.symlinkSync(outside, path.join(bundle(), 'escape'));
    await expect(importBundle({ refresh: 'community', projectDir, frameworkRoot: root })).rejects.toThrow(/non-regular addon path/);
  });

  it('detects collisions in the existing project index and other project-local addons', async () => {
    const importBundle = await importer();
    const source = path.join(root, 'source');
    gitFixture(source, { ...repositorySkills('social', 2), LICENSE: 'MIT License' });
    await importBundle({ source, into: 'other', only: 'social-0', projectDir, frameworkRoot: root });
    const otherManifest = path.join(projectDir, '.aiwg/addons/other/manifest.json');
    const other = JSON.parse(fs.readFileSync(otherManifest, 'utf8'));
    other.addonConfig.skills = other.skills;
    delete other.skills;
    fs.writeFileSync(otherManifest, JSON.stringify(other));
    const indexFile = path.join(projectDir, '.aiwg/.index/project/metadata.json');
    fs.writeFileSync(indexFile, JSON.stringify({ entries: {
      existing: { type: 'skill', path: '.aiwg/custom/skills/social-1/SKILL.md' },
      ignored: { type: 'rule', path: '.aiwg/rules/example.md' },
    } }));
    const result = await importBundle({ source, into: 'community', projectDir, frameworkRoot: root, dryRun: true });
    expect(result.manifest.skills).toEqual(['source-social-0', 'source-social-1']);
    expect(fs.existsSync(bundle())).toBe(false);
    fs.writeFileSync(otherManifest, '{"id":"other"}');
    await expect(importBundle({ source, into: 'community', projectDir, frameworkRoot: root })).rejects.toThrow(/manifests require repair/);
  });
});
