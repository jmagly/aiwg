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
  expect(await diagnoseWorkspaceContext(project)).not.toContainEqual(expect.objectContaining({ code: 'duplicate-prompt-hook' }));
  // Removing the project registration reactivates the user hook without redeploying.
  await fs.rm(path.join(project, '.claude/settings.json'));
  expect(JSON.parse(run(await command(home))).hookSpecificOutput.additionalContext).toContain('aiwg discover');
});

it('warns for legacy non-deferring user hooks and clears the warning on redeploy', async () => {
  await installAiwgHooks({ frameworkRoot, projectPath: home, scope: 'user' });
  expect((await diagnoseWorkspaceContext(project)).some(d => d.code === 'duplicate-prompt-hook')).toBe(false);
  await installAiwgHooks({ frameworkRoot, projectPath: project, scope: 'project' });
  const file = path.join(home, '.claude/settings.json');
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  // The pre-#4257 verified loader had no project registration guard.
  doc.hooks.UserPromptSubmit[0].hooks[0].command = (await command(home))
    .replace(/try\{const project=.+?catch\{\}/, '');
  await fs.writeFile(file, JSON.stringify(doc));
  expect(JSON.parse(run(await command(home))).hookSpecificOutput.additionalContext).toContain('aiwg discover');
  expect((await diagnoseWorkspaceContext(project)).filter(d => d.code === 'duplicate-prompt-hook')).toHaveLength(1);
  expect((await diagnoseWorkspaceContext(home)).some(d => d.code === 'duplicate-prompt-hook')).toBe(false);
  await installAiwgHooks({ frameworkRoot, projectPath: home, scope: 'user' });
  expect((await diagnoseWorkspaceContext(project)).some(d => d.code === 'duplicate-prompt-hook')).toBe(false);
});

it('warns if any registered user prompt hook is still non-deferring', async () => {
  await installAiwgHooks({ frameworkRoot, projectPath: home, scope: 'user' });
  await installAiwgHooks({ frameworkRoot, projectPath: project, scope: 'project' });
  const file = path.join(home, '.claude/settings.json');
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  doc.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', _aiwg_managed: true,
    _aiwg_id: 'aiwg-prompt-discovery', command: 'node .claude/hooks/aiwg-prompt-discovery.cjs' }] });
  await fs.writeFile(file, JSON.stringify(doc));
  expect(await diagnoseWorkspaceContext(project)).toContainEqual(expect.objectContaining({
    code: 'duplicate-prompt-hook', severity: 'warning',
    message: expect.stringContaining('aiwg use all --global --providers claude'),
  }));
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
