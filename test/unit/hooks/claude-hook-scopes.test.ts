// Exercise simultaneous Claude user/project registrations with deterministic discovery.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { installAiwgHooks } from '../../../src/extensions/claude-hooks-installer.js';
import { diagnoseWorkspaceContext } from '../../../src/smiths/context-pipeline/workspace-doctor.js';

const frameworkRoot = path.resolve(import.meta.dirname, '../../..');
let root: string, home: string, project: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-hook-scopes-'));
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  await fs.mkdir(project);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const runtime = path.join(root, 'dist/src/artifacts');
  await fs.mkdir(runtime, { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(runtime, 'query-engine-discover.js'),
    'export async function discoverCapability() { console.log(JSON.stringify({results:[]})); }');
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

async function command(target: string) {
  return JSON.parse(await fs.readFile(path.join(target, '.claude/settings.json'), 'utf8'))
    .hooks.UserPromptSubmit[0].hooks[0].command;
}
function run(command: string, cwd = project, projectEnv = project) {
  return execSync(command, { cwd, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit',
    prompt: 'fix the doctor warnings', cwd: project }), encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, AIWG_ROOT: root, AIWG_PROMPT_DISCOVERY: '1', CLAUDE_PROJECT_DIR: projectEnv } });
}

it.each([['user', 'project'], ['project', 'user']])('injects once after installing %s then %s', async (first, second) => {
  for (const scope of [first, second] as const) await installAiwgHooks({ frameworkRoot,
    projectPath: scope === 'user' ? home : project, scope: scope as 'user' | 'project' });
  expect(run(await command(home))).toBe('');
  expect(run(await command(home), project, '')).toBe('');
  expect(run(await command(home), root, project)).toBe('');
  expect(JSON.parse(run(await command(project))).hookSpecificOutput.additionalContext).toContain('aiwg discover');
  expect(await diagnoseWorkspaceContext(project)).toContainEqual(expect.objectContaining({ code: 'duplicate-prompt-hook' }));
  // Removing the project registration reactivates the user hook without redeploying.
  await fs.rm(path.join(project, '.claude/settings.json'));
  expect(JSON.parse(run(await command(home))).hookSpecificOutput.additionalContext).toContain('aiwg discover');
});

it('reports overlap independently of other workspace warnings and avoids a home self-overlap', async () => {
  await installAiwgHooks({ frameworkRoot, projectPath: home, scope: 'user' });
  expect((await diagnoseWorkspaceContext(project)).some(d => d.code === 'duplicate-prompt-hook')).toBe(false);
  await installAiwgHooks({ frameworkRoot, projectPath: project, scope: 'project' });
  expect((await diagnoseWorkspaceContext(project)).filter(d => d.code === 'duplicate-prompt-hook')).toHaveLength(1);
  expect((await diagnoseWorkspaceContext(home)).some(d => d.code === 'duplicate-prompt-hook')).toBe(false);
});

it('keeps user discovery for operator-only or malformed project settings', async () => {
  await installAiwgHooks({ frameworkRoot, projectPath: home, scope: 'user' });
  await fs.mkdir(path.join(project, '.claude'));
  for (const value of ['{', JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{
    type: 'command', command: 'echo operator',
  }] }] } })]) {
    await fs.writeFile(path.join(project, '.claude/settings.json'), value);
    expect(JSON.parse(run(await command(home))).hookSpecificOutput.additionalContext).toContain('aiwg discover');
  }
  expect(JSON.parse(run(await command(home), home, home)).hookSpecificOutput.additionalContext).toContain('aiwg discover');
});
