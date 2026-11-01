// Tier replacement verifies every recorded byte; stale index cleanup supports legacy markers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { removeSkillCopy } from '../../../tools/agents/providers/skill-copy-prune.mjs';
import { deploySkillsWithKernelRouting } from '../../../tools/agents/providers/base-kernel-skills.mjs';
import { captureDeploymentOutputs } from '../../../src/providers/deployment-ownership.mjs';
import { preserveDeploymentOutputs } from '../../../src/providers/deployment-preservation.mjs';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-copy-prune-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function skill(receipt = true) {
  const dir = path.join(root, 'skill'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'original');
  fs.writeFileSync(path.join(dir, '.aiwg-managed'), 'aiwg');
  if (receipt) fs.writeFileSync(path.join(dir, '.aiwg-manifest.json'), JSON.stringify({ managed: {
    'SKILL.md': { hash: `sha256:${createHash('sha256').update('original').digest('hex')}` },
  } }));
  return dir;
}
function replacement() {
  const dir = path.join(root, 'other-tier', 'skill'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'new tier');
  return dir;
}
it('deletes a legacy marker-only directory only in index mode', () => {
  const dir = skill(false);
  expect(removeSkillCopy(dir, { copyMode: true })).toBe(false);
  expect(removeSkillCopy(dir, { copyMode: true, tierMove: true })).toBe(false);
  expect(removeSkillCopy(dir, { dryRun: true })).toBe(true);
  expect(fs.existsSync(dir)).toBe(true);
  expect(removeSkillCopy(dir)).toBe(true);
  expect(fs.existsSync(dir)).toBe(false);
});
it.each(['operator', 'malformed', 'edited', 'added', 'missing', 'symlink'])('preserves %s payloads', kind => {
  const dir = skill(kind !== 'operator');
  if (kind === 'operator') fs.rmSync(path.join(dir, '.aiwg-managed'));
  if (kind === 'malformed') fs.writeFileSync(path.join(dir, '.aiwg-manifest.json'), '{bad json');
  if (kind === 'edited') fs.writeFileSync(path.join(dir, 'SKILL.md'), 'edit');
  if (kind === 'added') fs.writeFileSync(path.join(dir, 'addition'), 'operator');
  if (kind === 'missing') fs.rmSync(path.join(dir, 'SKILL.md'));
  if (kind === 'symlink') { fs.renameSync(path.join(dir, 'SKILL.md'), path.join(root, 'backing')); fs.symlinkSync(path.join(root, 'backing'), path.join(dir, 'SKILL.md')); }
  expect(removeSkillCopy(dir)).toBe(false);
  expect(fs.existsSync(dir)).toBe(true);
});
it('keeps stale hashed copies in copy mode but allows verified tier replacement', () => {
  const dir = skill();
  expect(removeSkillCopy(dir, { copyMode: true })).toBe(false);
  expect(removeSkillCopy(dir, { copyMode: true, tierMove: true, replacement: replacement() })).toBe(true);
  expect(fs.existsSync(dir)).toBe(false);
});
it('keeps the old-tier copy when the copy-mode replacement is missing', () => {
  const dir = skill();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(removeSkillCopy(dir, { copyMode: true, tierMove: true })).toBe(false);
  expect(removeSkillCopy(dir, { copyMode: true, tierMove: true, replacement: path.join(root, 'absent') })).toBe(false);
  expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toBe('original');
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('replacement copy missing'));
  warn.mockRestore();
});
it('verifies a recorded marker as part of the receipt payload', () => {
  const dir = skill();
  const receipt = path.join(dir, '.aiwg-manifest.json');
  const record = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  record.managed['.aiwg-managed'] = { hash: `sha256:${createHash('sha256').update('aiwg').digest('hex')}` };
  fs.writeFileSync(receipt, JSON.stringify(record));
  expect(removeSkillCopy(dir)).toBe(true);
});
it('tracks staging and logical replacement paths for both preservation passes', () => {
  const dir = skill(), replacedSkillCopies = new Set<string>();
  const logicalOutputPath = (file: string) => file.replace(root, path.join(root, 'logical'));
  expect(removeSkillCopy(dir, { copyMode: true, tierMove: true, replacement: replacement(), replacedSkillCopies, logicalOutputPath })).toBe(true);
  expect(replacedSkillCopies.has(path.join(dir, 'SKILL.md'))).toBe(true);
  expect(replacedSkillCopies.has(logicalOutputPath(path.join(dir, 'SKILL.md')))).toBe(true);
});
it.each([true, false])('does not restore a verified tier replacement during copy preservation (kernel=%s)', kernel => {
  const source = path.join(root, 'source', 'demo'); fs.mkdirSync(source, { recursive: true });
  const kernelRoot = path.join(root, 'kernel'), standardRoot = path.join(root, 'standard');
  const body = (isKernel: boolean) => `---\nname: demo\nnamespace: aiwg\nkernel: ${isKernel}\n---\nbody\n`;
  const opts = { copyStandardSkills: true, copyMode: true, target: root, replacedSkillCopies: new Set<string>() };
  fs.writeFileSync(path.join(source, 'SKILL.md'), body(kernel));
  deploySkillsWithKernelRouting([source], standardRoot, kernelRoot, opts);
  const before = captureDeploymentOutputs([kernelRoot, standardRoot]);
  fs.writeFileSync(path.join(source, 'SKILL.md'), body(!kernel));
  deploySkillsWithKernelRouting([source], standardRoot, kernelRoot, opts);
  preserveDeploymentOutputs(before, [kernelRoot, standardRoot], opts);
  expect(fs.existsSync(path.join(kernel ? kernelRoot : standardRoot, 'demo'))).toBe(false);
  expect(fs.existsSync(path.join(kernel ? standardRoot : kernelRoot, 'demo', 'SKILL.md'))).toBe(true);
});
it.each([true, false])('preserves edited old-tier copies when kernel=%s moves tiers', kernel => {
  const source = path.join(root, 'source', 'demo'); fs.mkdirSync(source, { recursive: true });
  const kernelRoot = path.join(root, 'kernel'), standardRoot = path.join(root, 'standard');
  const body = (isKernel: boolean) => `---\nname: demo\nnamespace: aiwg\nkernel: ${isKernel}\n---\nbody\n`;
  fs.writeFileSync(path.join(source, 'SKILL.md'), body(kernel));
  const opts = { copyStandardSkills: true, copyMode: true };
  deploySkillsWithKernelRouting([source], standardRoot, kernelRoot, opts);
  const old = path.join(kernel ? kernelRoot : standardRoot, 'demo', 'SKILL.md');
  fs.appendFileSync(old, 'operator edit');
  fs.writeFileSync(path.join(source, 'SKILL.md'), body(!kernel));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  deploySkillsWithKernelRouting([source], standardRoot, kernelRoot, opts);
  expect(fs.readFileSync(old, 'utf8')).toContain('operator edit');
  expect(fs.existsSync(path.join(kernel ? standardRoot : kernelRoot, 'demo', 'SKILL.md'))).toBe(true);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('operator-edited'));
});
