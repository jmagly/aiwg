import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deploySkillDir,
  sameSkillOwner,
  deploySkillsWithKernelRouting,
  readSidecarManifest,
  writeSidecarManifest,
} from '../../../tools/agents/providers/base.mjs';

describe('shared skill copier ownership and stale files (#3035)', () => {
  let root: string;
  let destination: string;
  let sources: string;

  function write(filename: string, content: string): void {
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, content);
  }

  function skill(group: string, bundle: string, name: string, body = bundle): string {
    const source = join(sources, 'agentic/code', group, bundle, 'skills', name);
    write(join(source, 'SKILL.md'), `---\nname: ${name}\nplatforms: [all]\n---\n${body}\n`);
    write(join(source, 'references/recipe.md'), `${bundle} recipe\n`);
    return source;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiwg-skill-copy-'));
    sources = join(root, 'sources');
    destination = join(root, 'deployed');
    for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
      vi.stubEnv(name, join(root, name.toLowerCase()));
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  for (const name of ['cleanup-audit', 'doc-sync', 'sdlc-accelerate', 'doc-consolidate']) {
    for (const frameworkFirst of [false, true]) {
      it(`gives the framework precedence for ${name} (framework first: ${frameworkFirst})`, () => {
        const addon = skill('addons', 'aiwg-utils', name);
        const framework = skill('frameworks', 'sdlc-complete', name);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const order = frameworkFirst ? [framework, addon] : [addon, framework];
        for (const source of order) deploySkillDir(source, destination, { provider: 'pi' });
        expect(readSidecarManifest(join(destination, name)).managed['SKILL.md'].frameworkSlug).toBe('sdlc-complete');
        expect(readFileSync(join(destination, name, 'references/recipe.md'), 'utf8')).toBe('sdlc-complete recipe\n');
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('Skill deploy collision:'));
      });
    }
  }

  for (const group of ['frameworks', 'addons']) {
    for (const reversed of [false, true]) {
      it(`keeps existing peer ownership for ${group} (reversed: ${reversed})`, () => {
        const first = skill(group, reversed ? 'sdlc-complete' : 'research-complete', 'research-cite');
        const second = skill(group, reversed ? 'research-complete' : 'sdlc-complete', 'research-cite');
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        deploySkillDir(first, destination, {});
        deploySkillDir(second, destination, {});
        expect(readSidecarManifest(join(destination, 'research-cite')).skillSource).toBe(first);
        expect(warning).toHaveBeenLastCalledWith(expect.stringContaining('skipped'));
        deploySkillDir(second, destination, { force: true, dryRun: true });
        expect(readSidecarManifest(join(destination, 'research-cite')).skillSource).toBe(first);
        deploySkillDir(second, destination, { force: true });
        expect(readSidecarManifest(join(destination, 'research-cite')).skillSource).toBe(second);
        expect(warning).toHaveBeenLastCalledWith(expect.stringContaining('taking ownership'));
      });
    }
  }

  it('checks an existing manifest frameworkSlug even without a source-directory record', () => {
    const framework = skill('frameworks', 'sdlc-complete', 'demo');
    deploySkillDir(framework, destination, {});
    const receipt = readSidecarManifest(join(destination, 'demo'));
    delete receipt.skillSource;
    writeSidecarManifest(join(destination, 'demo'), receipt, false);
    const addon = skill('addons', 'aiwg-utils', 'demo');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deploySkillDir(addon, destination, {});
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('owned by sdlc-complete'));
  });

  it('matches moved legacy sources only when both lack slugs and their bundle-relative segments agree', () => {
    const receipt = { skillSource: join(root, 'old/bundle/skills/demo'), managed: {} };
    expect(sameSkillOwner(receipt, join(root, 'new/bundle/skills/demo'))).toBe(true);
    expect(sameSkillOwner(receipt, join(root, 'new/other/skills/demo'))).toBe(false);
    expect(sameSkillOwner(receipt, join(root, 'new/bundle/skills/other'))).toBe(false);
    expect(sameSkillOwner(receipt, join(root, 'new/bundle/skills/demo'), 'foreign')).toBe(false);
    const source = join(root, 'old/bundle/skills/demo');
    write(join(source, 'SKILL.md'), 'old');
    deploySkillDir(source, destination, {});
    const moved = join(root, 'new/bundle/skills/demo');
    write(join(moved, 'SKILL.md'), 'updated');
    deploySkillDir(moved, destination, {});
    expect(readFileSync(join(destination, 'demo/SKILL.md'), 'utf8')).toBe('updated');
  });

  it('detects a collision even when only the support assets differ', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo', 'same instructions');
    const framework = skill('frameworks', 'sdlc-complete', 'demo', 'same instructions');
    deploySkillDir(framework, destination, {});
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deploySkillDir(addon, destination, {});
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('owned by sdlc-complete'));
  });

  it('updates the same framework owner after its installation root moves', () => {
    const addon = skill('frameworks', 'sdlc-complete', 'demo');
    deploySkillDir(addon, destination, {});
    sources = join(root, 'relocated');
    const relocated = skill('frameworks', 'sdlc-complete', 'demo', 'updated');
    deploySkillDir(relocated, destination, {});
    expect(readFileSync(join(destination, 'demo/SKILL.md'), 'utf8')).toContain('updated');
    expect(readSidecarManifest(join(destination, 'demo')).skillSource).toBe(relocated);
  });

  it('prunes removed support files while preserving additions and modified files', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    write(join(addon, 'assets/retired.txt'), 'retired');
    deploySkillDir(addon, destination, {});
    const deployed = join(destination, 'demo');
    write(join(deployed, 'references/recipe.md'), 'operator edit');
    write(join(deployed, 'assets/local.txt'), 'operator addition');
    rmSync(join(addon, 'references'), { recursive: true });
    rmSync(join(addon, 'assets'), { recursive: true });
    deploySkillDir(addon, destination, {});
    expect(existsSync(join(deployed, 'assets/retired.txt'))).toBe(false);
    expect(readFileSync(join(deployed, 'references/recipe.md'), 'utf8')).toBe('operator edit');
    expect(readFileSync(join(deployed, 'assets/local.txt'), 'utf8')).toBe('operator addition');
    expect(Object.keys(readSidecarManifest(deployed).managed)).toEqual(['SKILL.md', 'references/recipe.md']);
  });

  it('preserves stale support files during a dry run', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    deploySkillDir(addon, destination, {});
    rmSync(join(addon, 'references'), { recursive: true });
    const receipt = readFileSync(join(destination, 'demo/.aiwg-manifest.json'), 'utf8');
    deploySkillDir(addon, destination, { dryRun: true });
    expect(existsSync(join(destination, 'demo/references/recipe.md'))).toBe(true);
    expect(readFileSync(join(destination, 'demo/.aiwg-manifest.json'), 'utf8')).toBe(receipt);
  });

  it('prunes stale files through a symlinked ancestor', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    const actual = join(root, 'actual');
    mkdirSync(actual);
    symlinkSync(actual, destination);
    deploySkillDir(addon, destination, {});
    rmSync(join(addon, 'references'), { recursive: true });
    deploySkillDir(addon, destination, {});
    expect(existsSync(join(actual, 'demo/references/recipe.md'))).toBe(false);
  });

  it.each(['file', 'directory'])('does not follow a replaced support %s symlink during cleanup', kind => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    deploySkillDir(addon, destination, {});
    const outside = join(root, 'outside');
    write(join(outside, 'recipe.md'), 'aiwg-utils recipe\n');
    const replaced = join(destination, kind === 'file' ? 'demo/references/recipe.md' : 'demo/references');
    rmSync(replaced, { recursive: true });
    symlinkSync(kind === 'file' ? join(outside, 'recipe.md') : outside, replaced);
    rmSync(join(addon, 'references'), { recursive: true });
    deploySkillDir(addon, destination, {});
    expect(existsSync(join(outside, 'recipe.md'))).toBe(true);
  });

  it('removes retired standard skills on redeploy, including an empty source skill list', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    const sibling = skill('addons', 'another-addon', 'sibling');
    const options = { copyStandardSkills: true, srcRoot: sources };
    deploySkillsWithKernelRouting([addon, sibling], destination, null, options);
    rmSync(addon, { recursive: true });
    const result = deploySkillsWithKernelRouting([], destination, null, { ...options, copyStandardSkills: false });
    expect(result.prunedFromStandardDir).toBe(1);
    expect(existsSync(join(destination, 'demo'))).toBe(false);
    expect(existsSync(join(destination, 'sibling/SKILL.md'))).toBe(true);
  });

  it('preserves operator files inside retired standard skills and leaves legacy marker-only copies alone', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    const options = { copyStandardSkills: true, srcRoot: sources };
    deploySkillsWithKernelRouting([addon], destination, null, options);
    write(join(destination, 'demo/local.txt'), 'operator addition');
    write(join(destination, 'demo/references/recipe.md'), 'operator edit');
    write(join(destination, 'legacy/SKILL.md'), 'operator or legacy skill');
    write(join(destination, 'legacy/.aiwg-managed'), 'aiwg\n');
    rmSync(addon, { recursive: true });
    const result = deploySkillsWithKernelRouting([], destination, null, { ...options, copyStandardSkills: false });
    expect(result.prunedFromStandardDir).toBe(0);
    expect(existsSync(join(destination, 'demo/SKILL.md'))).toBe(false);
    expect(readFileSync(join(destination, 'demo/local.txt'), 'utf8')).toBe('operator addition');
    expect(readFileSync(join(destination, 'demo/references/recipe.md'), 'utf8')).toBe('operator edit');
    expect(existsSync(join(destination, 'demo/.aiwg-managed'))).toBe(false);
    expect(existsSync(join(destination, 'legacy/SKILL.md'))).toBe(true);
  });

  it('scopes stale standard cleanup to this source and honors dry runs', () => {
    const addon = skill('addons', 'aiwg-utils', 'demo');
    const options = { copyStandardSkills: true, srcRoot: sources };
    deploySkillsWithKernelRouting([addon], destination, null, options);
    rmSync(addon, { recursive: true });
    deploySkillsWithKernelRouting([], destination, null, { ...options, dryRun: true });
    expect(existsSync(join(destination, 'demo/SKILL.md'))).toBe(true);
    deploySkillsWithKernelRouting([], destination, null, { ...options, srcRoot: join(sources, 'unrelated') });
    expect(existsSync(join(destination, 'demo/SKILL.md'))).toBe(true);
    deploySkillsWithKernelRouting([], destination, null, {});
    expect(existsSync(join(destination, 'demo/SKILL.md'))).toBe(true);
  });
});
