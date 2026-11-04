// Verify lightweight checkpoint persistence and recovery using isolated temporary projects.
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkpointHandler } from '../../../../src/cli/handlers/checkpoint.js';

let project: string;
const run = (...args: string[]) => checkpointHandler.execute({
  args, rawArgs: ['checkpoint', ...args], cwd: project, frameworkRoot: project,
});
const root = () => join(project, '.aiwg', 'checkpoints');
async function create(...args: string[]) {
  const result = await run('create', ...args);
  expect(result.exitCode).toBe(0);
  return result.message!;
}

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'aiwg-checkpoint-'));
  vi.stubEnv('AIWG_ARTIFACTS_PATH', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(project, { recursive: true, force: true });
});

describe('checkpointHandler', () => {
  it('creates a named record with caller fields and no git requirement', async () => {
    const id = await create('--name', 't1', '--phase', 'p', '--step', 's',
      '--artifact', 'a.md', '--artifact', 'b.md', '--note', 'Continue here');
    expect(id).toMatch(/^ckpt_/);
    const record = JSON.parse(await readFile(join(root(), `${id}.json`), 'utf8'));
    expect(record).toEqual({ id, name: 't1', phase: 'p', step: 's',
      artifacts: ['a.md', 'b.md'], note: 'Continue here', cwd: project, createdAt: expect.any(String) });
    expect(new Date(record.createdAt).toISOString()).toBe(record.createdAt);
  });

  it('captures git HEAD when available', async () => {
    // A synthetic commit avoids depending on operator Git identity or signing settings.
    execFileSync('git', ['init', '--quiet', project]);
    const tree = execFileSync('git', ['hash-object', '-t', 'tree', '--stdin', '-w'], { cwd: project, input: '', encoding: 'utf8' }).trim();
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
    const head = execFileSync('git', ['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-m', 'fixture'], { cwd: project, env, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'HEAD', head], { cwd: project });
    const id = await create();
    expect(JSON.parse((await run('recover', id, '--json')).message!).gitHead).toBe(head);
  });

  it('lists newest first and recovers newest by default or duplicate name', async () => {
    const first = await create('--name', 'same');
    const second = await create('--name=same', '--phase=p', '--step=s');
    const firstFile = join(root(), `${first}.json`);
    const old = JSON.parse(await readFile(firstFile, 'utf8'));
    old.createdAt = '2000-01-01T00:00:00.000Z';
    await writeFile(firstFile, JSON.stringify(old));
    const listed = await run('list', '--json');
    expect(listed.rawOutput).toBe(true);
    expect(JSON.parse(listed.message!).map((r: { id: string }) => r.id)).toEqual([second, first]);
    expect((await run('list')).message!.indexOf(second)).toBeLessThan((await run('list')).message!.indexOf(first));
    expect(JSON.parse((await run('recover', '--json')).message!).id).toBe(second);
    expect(JSON.parse((await run('recover', 'same', '--json')).message!).id).toBe(second);
    expect(JSON.parse((await run('recover', first, '--json')).message!).id).toBe(first);
  });

  it('prints the complete resume position and leaves files unchanged', async () => {
    const id = await create('--name', 't1', '--phase', 'p', '--step', 's', '--note', 'next', '--artifact', 'plan.md');
    const file = join(root(), `${id}.json`);
    const before = await readFile(file, 'utf8');
    const result = await run('recover', 't1');
    expect(result.exitCode).toBe(0);
    for (const text of [id, 't1', project, 'Phase: p', 'Step: s', 'next', 'plan.md']) expect(result.message).toContain(text);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(project)).toEqual(['.aiwg']);
  });

  it('handles empty lists and empty recovery without creating directories', async () => {
    expect(await run('list')).toMatchObject({ exitCode: 0, message: 'No checkpoints found.' });
    expect(await run('list', '--json')).toMatchObject({ exitCode: 0, message: '[]', rawOutput: true });
    expect((await run('recover')).exitCode).toBe(1);
    expect(await readdir(project)).toEqual([]);
  });

  it('reports unknown IDs and treats lookup strings as data', async () => {
    await create();
    for (const key of ['unknown', '../../outside']) {
      expect(await run('recover', key)).toMatchObject({ exitCode: 1, message: `Checkpoint not found: ${key}` });
    }
  });

  it('uses external pointer storage for every action', async () => {
    const external = join(project, 'corpus');
    await mkdir(external);
    await writeFile(join(project, '.aiwg-location'), 'corpus\n');
    const id = await create('--name', 'external');
    expect(JSON.parse(await readFile(join(external, 'checkpoints', `${id}.json`), 'utf8')).id).toBe(id);
    expect(JSON.parse((await run('list', '--json')).message!)[0].id).toBe(id);
    expect((await run('recover', 'external')).exitCode).toBe(0);
    expect(await readdir(project)).not.toContain('.aiwg');
  });

  it('honors environment root overrides', async () => {
    const external = join(project, 'override');
    await mkdir(external);
    vi.stubEnv('AIWG_ARTIFACTS_PATH', external);
    const id = await create();
    expect(JSON.parse((await run('recover', id, '--json')).message!).id).toBe(id);
    expect(await readdir(external)).toEqual(['checkpoints']);
  });

  it('fails on unavailable external storage without local fallback', async () => {
    await writeFile(join(project, '.aiwg-location'), 'offline\n');
    for (const action of ['create', 'list', 'recover']) {
      expect(await run(action)).toMatchObject({ exitCode: 1, message: expect.stringContaining('external AIWG artifact root is unavailable') });
    }
    expect(await readdir(project)).toEqual(['.aiwg-location']);
  });

  it.each(['name', 'phase', 'step', 'artifact', 'note'])('rejects missing --%s values headlessly', async flag => {
    for (const args of [[`--${flag}`], [`--${flag}`, '--name', 'n'], [`--${flag}=`]]) {
      expect((await run('create', ...args)).exitCode).toBe(1);
    }
    expect(await readdir(project)).toEqual([]);
  });

  it.each([[], ['unknown'], ['list', 'extra'], ['recover', 'a', 'b'],
    ['create', '--unknown', 'v'], ['create', '--name', 'a', '--name', 'b'], ['list', '--json=true']])(
    'rejects invalid arguments %j', async (...args) => {
      expect((await run(...args)).exitCode).toBe(1);
      expect(await readdir(project)).toEqual([]);
    });

  it('reports malformed records instead of silently hiding them', async () => {
    await mkdir(root(), { recursive: true });
    await writeFile(join(root(), 'broken.json'), '{}');
    expect(await run('list')).toMatchObject({ exitCode: 1, message: 'Invalid checkpoint record: broken.json' });
  });

  it('shows help and supports a dry run without writes', async () => {
    expect((await run('--help')).message).toContain('checkpoint create');
    expect((await checkpointHandler.help!({ args: [], rawArgs: [], cwd: project, frameworkRoot: project })).exitCode).toBe(0);
    expect((await checkpointHandler.execute({ args: ['create'], rawArgs: [], cwd: project, frameworkRoot: project, dryRun: true })).message).toContain('Would create');
    expect(await readdir(project)).toEqual([]);
  });
});
