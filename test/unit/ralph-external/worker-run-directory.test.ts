// Exercise parent creation boundaries independently of invocation path preflight.
import { mkdtemp, mkdir, lstat, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAttemptRunDirectory } from '../../../tools/ralph-external/lib/worker-run-directory.mjs';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-run-parent-'));
  roots.push(root);
  const project = path.join(root, 'project');
  await mkdir(project);
  return { root, project };
}

it.each(['inside', 'outside', 'dangling'])('refuses an existing %s symlink component without creating descendants', async kind => {
  const { root, project } = await fixture();
  const target = kind === 'inside' ? path.join(project, 'target') : path.join(root, 'target');
  if (kind !== 'dangling') await mkdir(target);
  await symlink(target, path.join(project, 'runs'));
  await expect(createAttemptRunDirectory(path.join(project, 'runs', 'nested', 'attempt'), project)).rejects.toThrow(/symlink/);
  await expect(lstat(path.join(target, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a missing parent in a sibling with a matching project-name prefix', async () => {
  const { project } = await fixture();
  const parent = `${project}-outside`;
  await expect(createAttemptRunDirectory(path.join(parent, 'attempt'), project)).rejects.toThrow(/parent does not exist/);
  await expect(lstat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('requires the conductor project root to exist before creating any chain', async () => {
  const { root } = await fixture();
  const project = path.join(root, 'missing', 'project');
  await expect(createAttemptRunDirectory(path.join(project, 'runs', 'attempt'), project)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(path.dirname(project))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses an existing file component and preserves its bytes', async () => {
  const { project } = await fixture();
  const parent = path.join(project, 'runs');
  await writeFile(parent, 'keep');
  await expect(createAttemptRunDirectory(path.join(parent, 'attempt'), project)).rejects.toThrow(/directory without symlinks/);
  expect((await lstat(parent)).isFile()).toBe(true);
});

it('preserves exclusive attempt creation with an existing external parent', async () => {
  const { root, project } = await fixture();
  const run = path.join(root, 'attempt');
  await createAttemptRunDirectory(run, project);
  expect((await lstat(run)).mode & 0o777).toBe(0o700);
  await expect(createAttemptRunDirectory(run, project)).rejects.toMatchObject({ code: 'EEXIST' });
});
