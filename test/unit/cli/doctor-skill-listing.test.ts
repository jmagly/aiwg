// Exercise startup-visible skill budgets through the real offline doctor.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workerVersionProbeEnvironment } from '../../../src/models/worker-installation.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
let root: string;
let project: string;
async function put(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'doctor-skill-listing-'));
  project = path.join(root, 'project');
  await put(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({ version: '1', providers: ['claude'] }));
  await put(path.join(root, '.claude/settings.json'), '{"skillListingBudgetFraction":0.03}');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function doctor() {
  const env = { ...workerVersionProbeEnvironment(), HOME: root, USERPROFILE: root,
    XDG_CONFIG_HOME: path.join(root, '.config'), AIWG_CONFIG: path.join(root, '.aiwg'),
    CODEX_HOME: path.join(root, '.codex'), HERMES_HOME: path.join(root, '.hermes'),
    PATH: root, AIWG_ROOT: repo, AIWG_HOME: repo, AIWG_NO_UPDATE_CHECK: '1', AIWG_COMMAND_LOG: 'off' };
  const { stdout } = await promisify(execFile)(process.execPath,
    [path.join(repo, 'tools/cli/doctor.mjs'), '--provider', 'claude'],
    { cwd: project, env, timeout: 30_000 }).catch(error => {
      // Missing optional platform binaries can make doctor exit 1; retain its completed report.
      if (error.code === 1 && /(?:FAIL|WARN|OK) /.test(error.stdout)) return error;
      throw error;
    });
  return stdout as string;
}
async function skill(relative: string, name: string, size: number) {
  await put(path.join(project, relative, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${'x'.repeat(size)}\n---\n`);
}

describe('Claude startup skill listing (#4314)', () => {
  it('ignores the hidden standard tier in a default kernel install', async () => {
    for (let i = 0; i < 26; i++) await skill('.claude/skills', `kernel-${i}`, 203);
    for (let i = 0; i < 121; i++) await skill('.claude/.aiwg/skills', `standard-${i}`, 110);
    const output = await doctor();
    expect(output).toMatch(/✓ Claude Code Deployed Skill Count: 26 deployed skills .*within/);
    expect(output).not.toMatch(/⚠ Claude Code Deployed Skill Count/);
  });

  it('still warns when startup-visible skills exceed the budget', async () => {
    await skill('.claude/skills', 'visible-oversized', 6_100);
    expect(await doctor()).toMatch(/⚠ Claude Code Deployed Skill Count: 1 deployed skills .*above/);
  });

  it('does not warn when only hidden standard-tier skills exist', async () => {
    await skill('.claude/.aiwg/skills', 'hidden-oversized', 6_100);
    expect(await doctor()).not.toContain('Claude Code Deployed Skill Count');
  });
});
