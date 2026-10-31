/**
 * Codex startup-listing budget (#2561).
 *
 * Codex lists every skill under `.agents/skills/` at startup and truncates the
 * listing at 8,000 chars. The deployer keeps the listing under the cap by
 * placing overflow skills on the standard tier (`.codex/.aiwg/skills/`), where
 * the index still reaches them, instead of deploying over the cap and then
 * warning. Kernel-flagged skills are never demoted.
 *
 * @source tools/skills/deploy-skills-codex.mjs
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'tools', 'skills', 'deploy-skills-codex.mjs');
const temporary: string[] = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aiwg-${label}-`));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeSkill(root: string, name: string, descriptionChars: number, kernel = false): void {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const description = `${name[0].repeat(descriptionChars)} ${name}`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    ...(kernel ? ['kernel: true'] : []),
    '---',
    '',
    `# ${name}`,
    '',
    'Body.',
    '',
  ].join('\n'));
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? 1 };
}

const listing = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

describe('codex startup-listing budget (#2561)', () => {
  it('places overflow skills on the standard tier, largest entry first, never kernel skills', () => {
    const source = tempDir('codex-budget-src');
    const project = tempDir('codex-budget-project');
    writeSkill(source, 'alpha', 300);
    writeSkill(source, 'beta', 100);
    writeSkill(source, 'gamma', 300);
    writeSkill(source, 'kernel-one', 300, true);
    const kernelDir = path.join(project, '.agents', 'skills');
    const standardDir = path.join(project, '.codex', '.aiwg', 'skills');

    const result = run([
      '--source', source, '--target', kernelDir, '--standard-target', standardDir,
      '--copy-all', '--listing-cap', '700',
    ]);

    expect(result.exitCode).toBe(0);
    expect(listing(kernelDir)).toEqual(['beta', 'kernel-one']);
    expect(listing(standardDir)).toEqual(['alpha', 'gamma']);
    expect(result.stdout).toContain('Codex listing budget: 2 skill(s) placed on the standard tier');
    expect(result.stdout).toContain('alpha, gamma');
    expect(result.stdout).not.toContain('--force');
    // Overflow copies are still AIWG-managed and index-reachable.
    expect(fs.existsSync(path.join(standardDir, 'alpha', '.aiwg-managed'))).toBe(true);
    expect(fs.existsSync(path.join(standardDir, 'alpha', 'SKILL.md'))).toBe(true);
  });

  it('keeps copy-mode overflow until index cleanup reconciles the listing budget', () => {
    const source = tempDir('codex-budget-src');
    const project = tempDir('codex-budget-project');
    writeSkill(source, 'alpha', 300);
    writeSkill(source, 'beta', 100);
    const kernelDir = path.join(project, '.agents', 'skills');
    const standardDir = path.join(project, '.codex', '.aiwg', 'skills');

    // First deploy with the budget disabled reproduces the over-cap state.
    const over = run(['--source', source, '--target', kernelDir, '--standard-target', standardDir, '--copy-all', '--listing-cap', '0']);
    expect(over.exitCode).toBe(0);
    expect(listing(kernelDir)).toEqual(['alpha', 'beta']);

    // A plain redeploy under the cap moves the overflow without --force.
    const fixed = run(['--source', source, '--target', kernelDir, '--standard-target', standardDir, '--copy-all', '--listing-cap', '200']);
    expect(fixed.exitCode).toBe(0);
    expect(listing(kernelDir)).toEqual(['alpha', 'beta']);
    const indexed = run(['--source', source, '--target', kernelDir, '--standard-target', standardDir, '--copy-all', '--index-mode', '--listing-cap', '200']);
    expect(indexed.exitCode).toBe(0);
    expect(listing(kernelDir)).toEqual(['beta']);
    expect(listing(standardDir)).toEqual(['alpha']);
  });

  it('counts skills already in the kernel dir that this run does not replace', () => {
    const source = tempDir('codex-budget-src');
    const project = tempDir('codex-budget-project');
    const kernelDir = path.join(project, '.agents', 'skills');
    const standardDir = path.join(project, '.codex', '.aiwg', 'skills');
    // An unrelated, previously deployed skill occupies most of the cap.
    fs.mkdirSync(path.join(kernelDir, 'resident'), { recursive: true });
    fs.writeFileSync(path.join(kernelDir, 'resident', 'SKILL.md'), `---\nname: resident\ndescription: ${'r'.repeat(500)}\n---\n\n# resident\n`);
    writeSkill(source, 'newcomer', 200);

    const result = run(['--source', source, '--target', kernelDir, '--standard-target', standardDir, '--copy-all', '--listing-cap', '600']);
    expect(result.exitCode).toBe(0);
    expect(listing(kernelDir)).toEqual(['resident']);
    expect(listing(standardDir)).toEqual(['newcomer']);
  });

  it('keeps standalone invocations without a standard tier unbudgeted', () => {
    const source = tempDir('codex-budget-src');
    const target = tempDir('codex-budget-legacy');
    writeSkill(source, 'alpha', 300);
    writeSkill(source, 'gamma', 300);
    const result = run(['--source', source, '--target', target, '--copy-all']);
    expect(result.exitCode).toBe(0);
    expect(listing(target)).toEqual(['alpha', 'gamma']);
    expect(result.stdout).not.toContain('Codex listing budget');
  });
});
