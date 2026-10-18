import { mkdtemp } from '../../helpers/temp-dir.js';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import provider from '../../../tools/agents/providers/deepseek-harness.mjs';

describe('DeepSeek Harness deployment', () => {
  it('keeps dry-run pure and native skill deployment idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-dsh-skill-'));
    const target = join(root, 'project');
    const skill = join(root, 'fixture-skill');
    await mkdir(skill);
    await writeFile(join(skill, 'SKILL.md'), '---\nname: fixture-skill\ndescription: fixture\n---\n');
    provider.deploySkills([skill], target, { dryRun: true, force: false, quiet: true });
    await expect(access(target)).rejects.toThrow();
    expect(provider.deploySkills([skill], target, { dryRun: false, force: false, quiet: true })).toBe(1);
    const first = await readFile(join(target, '.agents', 'skills', 'fixture-skill', 'SKILL.md'), 'utf8');
    expect(provider.deploySkills([skill], target, { dryRun: false, force: false, quiet: true })).toBe(1);
    expect(await readFile(join(target, '.agents', 'skills', 'fixture-skill', 'SKILL.md'), 'utf8')).toBe(first);
  });

  it('uses one native skill root and a safe owned Cordis patch', async () => {
    expect(provider.paths.skills).toBe('.agents/skills');
    expect(provider.kernelSkillsPath).toBe('.agents/skills');
    const target = await mkdtemp(join(tmpdir(), 'aiwg-dsh-deploy-'));
    const options = { srcRoot: resolve('.'), target, dryRun: false, force: false, quiet: true };
    const previewTarget = join(target, 'preview');
    expect(provider.deployCordisPatch(previewTarget, { ...options, target: previewTarget, dryRun: true })).toHaveLength(1);
    await expect(access(previewTarget)).rejects.toThrow();
    expect(provider.deployCordisPatch(target, options)).toHaveLength(1);
    const patch = await readFile(join(target, '.dsh', 'aiwg.cordis.patch.yml'), 'utf8');
    expect(patch).toContain('compression: none');
    expect(patch).toContain('mode: workspace-write');
    expect(patch).toContain('session-telemetry-otel');
    expect(patch).not.toMatch(/apiKey|credential|danger-full-access/);
  });

  it('preserves an operator replacement unless force is explicit', async () => {
    const target = await mkdtemp(join(tmpdir(), 'aiwg-dsh-preserve-'));
    const options = { srcRoot: resolve('.'), target, dryRun: false, force: false, quiet: true };
    provider.deployCordisPatch(target, options);
    const destination = join(target, '.dsh', 'aiwg.cordis.patch.yml');
    await writeFile(destination, '# operator-owned\n');
    provider.deployCordisPatch(target, options);
    expect(await readFile(destination, 'utf8')).toBe('# operator-owned\n');
  });
});
