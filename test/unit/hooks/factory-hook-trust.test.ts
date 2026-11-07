// Keep Factory hook prerequisites visible through doctor and deployment without granting trust.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diagnoseWorkspaceContext } from '../../../src/smiths/context-pipeline/workspace-doctor.js';
import { readFactoryHookTrust } from '../../../src/smiths/hook-bridge/factory-trust.js';
import type { HandlerResult } from '../../../src/cli/handlers/types.js';

vi.mock('../../../src/cli/services/deployment-verification.js', { spy: true });
import { verifyProviderDeployment } from '../../../src/cli/services/deployment-verification.js';
import { UseHandler } from '../../../src/cli/handlers/use.js';

let root: string;
let project: string;
let config: string;
const nextStep = 'Trust this folder in droid; project hooks load only in a git repository with at least one commit.';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aiwg-factory-trust-'));
  project = path.join(root, 'project with spaces');
  const home = path.join(root, 'home');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
  vi.stubEnv('AIWG_USER_REGISTRY_PATH', path.join(root, 'registry.json'));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await copyFile(new URL('../../fixtures/hooks/factory-trust-git.mjs', import.meta.url), path.join(bin, 'git'));
  await chmod(path.join(bin, 'git'), 0o755);
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  await mkdir(path.join(home, '.factory'), { recursive: true });
  config = path.join(home, '.factory/settings.json');
  await mkdir(path.join(project, '.factory/hooks'), { recursive: true });
  await writeFile(path.join(project, '.factory/hooks/aiwg-prompt-discovery.cjs'), '// fixture\n');
  await writeFile(path.join(project, '.factory/hooks.json'), JSON.stringify({
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node fixture.cjs',
      _aiwg_managed: true, _aiwg_id: 'aiwg-prompt-discovery' }] }],
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it.each(['trusted', 'untrusted', 'missing-config'])('doctor advises for %s without a git commit', async state => {
  const bytes = JSON.stringify({ trustedFolders: state === 'trusted' ? { [project]: {} } : {} });
  if (state !== 'missing-config') await writeFile(config, bytes);
  const diagnostics = await diagnoseWorkspaceContext(project);
  expect(diagnostics).toContainEqual(expect.objectContaining({
    code: 'factory-hook-trust', severity: 'warning',
    message: expect.stringContaining(nextStep),
  }));
  const message = diagnostics.find(item => item.code === 'factory-hook-trust')?.message;
  expect(message).toContain(`Project trust: ${state === 'missing-config' ? 'unknown' : state}`);
  expect(message).toContain('Git commit: missing or unverified');
  if (state !== 'missing-config') expect(await readFile(config, 'utf8')).toBe(bytes);
  else await expect(readFile(config)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([{}, false, null, 'accepted'])('recognizes an exact trustedFolders object key regardless of value (%j)', async value => {
  const bytes = JSON.stringify({ trustedFolders: { [project]: value } });
  await writeFile(config, bytes);
  await writeFile(path.join(project, '.fixture-head'), 'present');
  expect(await readFactoryHookTrust(project)).toEqual({ project: 'trusted', gitCommit: true });
  expect(await diagnoseWorkspaceContext(project))
    .not.toContainEqual(expect.objectContaining({ code: 'factory-hook-trust' }));
  expect(await readFile(config, 'utf8')).toBe(bytes);
});

it('ignores trust for other folders, parents, and project-local settings', async () => {
  await writeFile(config, JSON.stringify({ trustedFolders: { [root]: {}, [project + '-other']: {} } }));
  await writeFile(path.join(project, '.factory/settings.json'), JSON.stringify({ trustedFolders: { [project]: {} } }));
  await writeFile(path.join(project, '.fixture-head'), 'present');
  expect(await readFactoryHookTrust(project)).toEqual({ project: 'untrusted', gitCommit: true });
  expect(await diagnoseWorkspaceContext(project)).toContainEqual(expect.objectContaining({
    code: 'factory-hook-trust', message: expect.stringContaining('Git commit: present'),
  }));
});

it.each(['not JSON', '{}', 'null', '{"trustedFolders":null}', '{"trustedFolders":[]}', '{"trustedFolders":true}'])
('leaves invalid or absent trust data unchanged (%s)', async bytes => {
  await writeFile(config, bytes);
  expect(await readFactoryHookTrust(project)).toEqual({ project: 'unknown', gitCommit: false });
  expect(await readFile(config, 'utf8')).toBe(bytes);
});

it('bounds a hung git probe and leaves its prerequisite unverified', async () => {
  await writeFile(config, JSON.stringify({ trustedFolders: { [project]: {} } }));
  await writeFile(path.join(project, '.fixture-head'), 'hang');
  const started = Date.now();
  expect(await readFactoryHookTrust(project)).toEqual({ project: 'trusted', gitCommit: false });
  expect(Date.now() - started).toBeLessThan(5000);
});

it('handles an unborn HEAD as a missing commit', async () => {
  await writeFile(path.join(project, '.fixture-head'), 'unborn');
  expect(await readFactoryHookTrust(project)).toEqual({ project: 'unknown', gitCommit: false });
});

it('handles a missing git executable without failing doctor', async () => {
  vi.stubEnv('PATH', path.join(root, 'no-executables'));
  expect(await diagnoseWorkspaceContext(project)).toContainEqual(expect.objectContaining({
    code: 'factory-hook-trust', severity: 'warning',
  }));
});

it.each(['missing', 'invalid', 'operator-only'])('does not advise for %s Factory registrations', async state => {
  const file = path.join(project, '.factory/hooks.json');
  if (state === 'missing') await rm(file);
  else await writeFile(file, state === 'invalid' ? 'broken JSON' : JSON.stringify({
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo operator' }] }],
  }));
  expect(await readFactoryHookTrust(project)).toBeNull();
  expect(await diagnoseWorkspaceContext(project))
    .not.toContainEqual(expect.objectContaining({ code: 'factory-hook-trust' }));
});

it('also advises for the managed session hook without prompt discovery', async () => {
  await writeFile(path.join(project, '.factory/hooks.json'), JSON.stringify({ SessionStart: [{ hooks: [{
    type: 'command', command: 'aiwg refresh --dry-run --quiet',
  }] }] }));
  expect(await readFactoryHookTrust(project)).toEqual({ project: 'unknown', gitCommit: false });
});

it.each(['untrusted', 'no-commit', 'ready'].flatMap(state => [{ state, json: false }, { state, json: true }]))
('includes one Factory deploy next step only when needed (%j)', async ({ state, json }) => {
  await writeFile(config, JSON.stringify({ trustedFolders: state === 'untrusted' ? {} : { [project]: {} } }));
  if (state !== 'no-commit') await writeFile(path.join(project, '.fixture-head'), 'present');
  const result = await deploy(json);
  expect(result.exitCode).toBe(0);
  if (json) expect(JSON.parse(result.message!).findings.filter((item: { id: string }) => item.id === 'factory-hook-trust'))
    .toEqual(state === 'ready' ? [] : [expect.objectContaining({ provider: 'factory', message: nextStep })]);
  else expect(result.message?.trimEnd().endsWith(nextStep)).toBe(state !== 'ready');
  expect(result.message?.split(nextStep)).toHaveLength(state === 'ready' ? 1 : 2);
});

it.each(['--dry-run', 'user-scope', '--provider=codex', 'failed'])('skips Factory deploy advice for %s', async control => {
  expect((await deploy(true, control)).message).not.toContain(nextStep);
});

it('keeps the doctor trust advisory out of deployment verification findings', async () => {
  vi.mocked(verifyProviderDeployment).mockRestore();
  const frameworkRoot = path.join(root, 'source');
  await mkdir(frameworkRoot);
  const result = await verifyProviderDeployment({
    provider: 'factory', scope: 'project', projectRoot: project, frameworkRoot, requestedBundles: ['all'],
  });
  expect(result.findings.some(item => item.id === 'context-diagnostic:factory-hook-trust')).toBe(false);
});

async function deploy(json: boolean, control?: string) {
  const frameworkRoot = path.join(root, 'source');
  await mkdir(frameworkRoot, { recursive: true });
  await writeFile(path.join(frameworkRoot, 'package.json'), '{"name":"aiwg","version":"1.0.0"}');
  vi.mocked(verifyProviderDeployment).mockResolvedValue({
    provider: control === '--provider=codex' ? 'codex' : 'factory',
    scope: control === 'user-scope' ? 'user' : 'project',
    outcome: control === 'failed' ? 'failed' : 'ready', restartRequired: false,
    restartAction: null, restartReason: null, reloadPolicy: 'live-refresh', reloadFallback: null,
    counts: { agents: 0, commands: 0, skills: 0, rules: 0, behaviors: 0 }, phases: [], findings: [],
  });
  const handler = new UseHandler();
  vi.spyOn(handler as unknown as { executeCore(): Promise<HandlerResult> }, 'executeCore')
    .mockResolvedValue({ exitCode: control === 'failed' ? 1 : 0 });
  const args = ['all', '--provider', control === '--provider=codex' ? 'codex' : 'factory', '--target', project,
    ...(json ? ['--json'] : []), ...(control === '--dry-run' ? ['--dry-run'] : []),
    ...(control === 'user-scope' ? ['--scope', 'user'] : [])];
  return handler.execute({ cwd: project, frameworkRoot, args, rawArgs: ['use', ...args] });
}
