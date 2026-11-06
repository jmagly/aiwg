// Exercise headless handoff creation, mixed-format recovery, and the built CLI in temporary projects.
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkpointHandler } from '../../../../src/cli/handlers/checkpoint.js';
import { writeCheckpointHandoff } from '../../../../src/cli/handlers/checkpoint-handoff.js';

const repo = resolve(import.meta.dirname, '../../../..');
let project: string;
const run = (...args: string[]) => checkpointHandler.execute({
  args, rawArgs: ['checkpoint', ...args], cwd: project, frameworkRoot: repo,
});
const root = () => join(project, '.aiwg', 'checkpoints');
async function create(...args: string[]) {
  const result = await run('create', ...args);
  expect(result.exitCode, result.message).toBe(0);
  return result.message!;
}
async function record(id: string) {
  return JSON.parse(await readFile(join(root(), id, 'checkpoint.json'), 'utf8'));
}
async function snapshot(dir = project): Promise<unknown[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return Promise.all(entries.map(async entry => {
    const path = join(dir, entry.name);
    const info = await stat(path);
    return [path, info.mtimeMs, entry.isDirectory() ? await snapshot(path) : await readFile(path, 'utf8')];
  }));
}

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'aiwg-checkpoint-handoff-'));
  vi.stubEnv('AIWG_ARTIFACTS_PATH', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(project, { recursive: true, force: true });
});

describe('checkpoint handoffs', () => {
  it.each([
    { artifacts: [], links: '- [TODO: Link relevant artifacts and references.]' },
    { artifacts: ['docs/plan.md', 'src/feature.ts'], links: '- docs/plan.md\n- src/feature.ts' },
  ])('renders Links explicitly for artifacts $artifacts', async ({ artifacts, links }) => {
    const id = await create('--handoff', ...artifacts.flatMap(path => ['--artifact', path]));
    const saved = await record(id);
    const handoff = await readFile(saved.handoffPath, 'utf8');
    expect(handoff.split('## Links\n')[1]?.trim()).toBe(links);
  });

  it('validates the completed handoff record before writing documents or JSON', async () => {
    await mkdir(root(), { recursive: true });
    await expect(writeCheckpointHandoff(repo, root(), {
      id: 'ckpt_invalid', createdAt: 'not-a-date', cwd: project, artifacts: [],
    }, { todos: [], constraints: [] })).rejects.toThrow('Invalid checkpoint record:');
    expect(await readdir(root())).toEqual([]);
  });

  it('loads a 2026.11.1 record alongside a handoff without adding fields to the old record', async () => {
    const id = await create('--handoff');
    const bytes = await readFile(join(repo, 'test/fixtures/artifacts/checkpoints/valid/record.2026.11.1.json'), 'utf8');
    const old = JSON.parse(bytes);
    const file = join(root(), `${old.id}.json`);
    await writeFile(file, bytes);
    const listed = await run('list', '--json');
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.message!)).toEqual([await record(id), old]);
    expect(JSON.parse((await run('recover', 'legacy', '--json')).message!)).toEqual(old);
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });

  it('writes both documents beside the record and fills all five template sections', async () => {
    const id = await create('--handoff', '--name', 'next', '--scope', 'Feature ownership: next session',
      '--phase', 'construction', '--step', 'verification', '--note', 'Code ready; tests pending',
      '--todo', 'Run tests', '--todo=Review diff', '--constraint', 'No commits',
      '--constraint=Stay in worktree', '--artifact', 'docs/plan.md', '--artifact=src/feature.ts');
    const saved = await record(id);
    expect(saved).toMatchObject({ id, name: 'next', artifacts: ['docs/plan.md', 'src/feature.ts'],
      handoffPath: join(root(), id, 'handoff.md'),
      nextSessionPromptPath: join(root(), id, 'next-session-prompt.md') });
    expect(await readdir(join(root(), id))).toEqual(['checkpoint.json', 'handoff.md', 'next-session-prompt.md']);
    const handoff = await readFile(saved.handoffPath, 'utf8');
    for (const text of ['## Scope and ownership', '## State at handoff', '## To do (ordered)',
      '## Binding constraints', '## Links', 'Feature ownership: next session', 'Phase: construction',
      'Step: verification', 'Code ready; tests pending', '1. Run tests\n2. Review diff',
      '- No commits\n- Stay in worktree', 'docs/plan.md', 'src/feature.ts']) expect(handoff).toContain(text);
    expect(handoff).not.toMatch(/\[TODO:|\{\{/);
    const prompt = await readFile(saved.nextSessionPromptPath, 'utf8');
    for (const text of [id, 'next', project, saved.handoffPath, 'binding constraints', 'ordered to-do']) {
      expect(prompt).toContain(text);
    }
  });

  it('creates a handoff headlessly with explicit placeholders for omitted context', async () => {
    const id = await create('--handoff');
    const saved = await record(id);
    const handoff = await readFile(saved.handoffPath, 'utf8');
    for (const text of ['Define scope and ownership', 'Record current phase', 'Record current step',
      'Describe completed work', 'List remaining work', 'Record binding constraints', 'Link relevant artifacts']) {
      expect(handoff).toContain(`[TODO: ${text}`);
    }
    expect(handoff).not.toContain('{{');
    expect(await readFile(saved.nextSessionPromptPath, 'utf8')).toContain(saved.handoffPath);
  });

  it('lists legacy and handoff records together and marks only handoffs', async () => {
    const plain = await create('--name', 'plain');
    const id = await create('--handoff', '--name', 'handoff');
    const listed = await run('list');
    expect(listed.message).toContain('Handoff');
    expect(listed.message!.split('\n').find(line => line.startsWith(id))).toMatch(/\tyes$/);
    expect(listed.message!.split('\n').find(line => line.startsWith(plain))).toMatch(/\t-$/);
    const json = JSON.parse((await run('list', '--json')).message!);
    expect(json).toHaveLength(2);
    expect(json.find((item: { id: string }) => item.id === id)).toEqual(await record(id));
    expect(JSON.parse((await run('recover', plain, '--json')).message!).id).toBe(plain);
  });

  it('recovers by name, ID, or newest with prompt and paths, and never writes', async () => {
    const id = await create('--handoff', '--name', 'next');
    const saved = await record(id);
    // Recover must print the saved text, including edits made after creation.
    await writeFile(saved.nextSessionPromptPath, 'Resume with this saved prompt.\n');
    const before = await snapshot();
    for (const lookup of [['next'], [id], []]) {
      const result = await run('recover', ...lookup);
      expect(result.exitCode).toBe(0);
      for (const text of [saved.handoffPath, saved.nextSessionPromptPath, 'Resume with this saved prompt.\n']) {
        expect(result.message).toContain(text);
      }
      expect(JSON.parse((await run('recover', ...lookup, '--json')).message!)).toEqual(saved);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('places the record and documents in the configured external artifact root', async () => {
    const external = join(project, 'corpus');
    await mkdir(external);
    await writeFile(join(project, '.aiwg-location'), 'corpus\n');
    const id = await create('--handoff');
    const saved = JSON.parse((await run('recover', id, '--json')).message!);
    expect(saved.handoffPath).toBe(join(external, 'checkpoints', id, 'handoff.md'));
    expect(saved.nextSessionPromptPath).toBe(join(external, 'checkpoints', id, 'next-session-prompt.md'));
    expect((await run('recover', id)).exitCode).toBe(0);
    expect(await readdir(project)).not.toContain('.aiwg');
  });

  it.each(['scope', 'todo', 'constraint'])('rejects missing or blank --%s values without writes', async flag => {
    for (const args of [[`--${flag}`], [`--${flag}=`], [`--${flag}`, '--todo', 'task'], [`--${flag}`, '  ']]) {
      expect(await run('create', '--handoff', ...args)).toMatchObject({ exitCode: 1,
        message: `--${flag} requires a value` });
    }
    expect(await readdir(project)).toEqual([]);
  });

  it.each([['--scope', 'scope'], ['--todo', 'task'], ['--constraint', 'rule'],
    ['--handoff', '--scope', 'a', '--scope', 'b'], ['--handoff', '--handoff'], ['--handoff=true']])(
    'rejects invalid or ignored handoff options %j', async (...args) => {
      expect((await run('create', ...args)).exitCode).toBe(1);
      expect(await readdir(project)).toEqual([]);
    });

  it('reports missing prompt files without recreating them', async () => {
    const id = await create('--handoff');
    await rm((await record(id)).nextSessionPromptPath);
    const before = await snapshot();
    expect((await run('recover', id)).exitCode).toBe(1);
    expect(await snapshot()).toEqual(before);
  });

  it.each([{ handoffPath: 42, nextSessionPromptPath: 'prompt' },
    { handoffPath: 'handoff' }, { nextSessionPromptPath: 'prompt' },
    { handoffPath: '', nextSessionPromptPath: 'prompt' }])('rejects malformed handoff paths %j', async fields => {
    const id = await create();
    const path = join(root(), `${id}.json`);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...saved, ...fields }));
    expect(await run('list')).toMatchObject({ exitCode: 1, message: `Invalid checkpoint record: ${id}.json` });
  });

  it('shows handoff help and dry-runs without writes', async () => {
    expect((await run('--help')).message).toContain('--handoff');
    expect(await checkpointHandler.execute({ args: ['create', '--handoff'], rawArgs: [],
      cwd: project, frameworkRoot: repo, dryRun: true })).toMatchObject({ exitCode: 0 });
    expect(await readdir(project)).toEqual([]);
  });

  it('creates, lists, and recovers handoffs through the built CLI without interactive input', async () => {
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(repo, 'bin/aiwg.mjs'), 'checkpoint', ...args], {
      cwd: project, encoding: 'utf8', input: '', timeout: 10_000,
      env: { ...process.env, AIWG_ROOT: repo, AIWG_CONFIG: join(project, 'home/.aiwg'),
        HOME: join(project, 'home'), USERPROFILE: join(project, 'home'),
        XDG_CONFIG_HOME: join(project, 'home/.config'), XDG_DATA_HOME: join(project, 'home/.local/share'),
        AIWG_LOG_DISABLE: '1', AIWG_NO_UPDATE_CHECK: '1', NO_COLOR: '1' },
    });
    const created = cli('create', '--handoff', '--name', 'cli-next', '--todo', 'Run tests');
    expect(created.status, created.stderr).toBe(0);
    const listed = cli('list', '--json');
    expect(listed.status, listed.stderr).toBe(0);
    const saved = JSON.parse(listed.stdout)[0];
    expect(saved.id).toBe(created.stdout.trim());
    expect(await readFile(saved.handoffPath, 'utf8')).toContain('1. Run tests');
    const before = await snapshot();
    const recovered = cli('recover', 'cli-next');
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain(await readFile(saved.nextSessionPromptPath, 'utf8'));
    expect(recovered.stdout).toContain(saved.handoffPath);
    expect(await snapshot()).toEqual(before);
    expect(cli('create', '--handoff', '--todo').status).toBe(1);
  });
});
