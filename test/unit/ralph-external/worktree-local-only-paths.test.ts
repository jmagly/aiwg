// Prove local-only exclusions against disposable git worktrees and synthetic policies (T-OG-04).
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareWorkerWorktree, WorktreeClaimRegistry } from '../../../tools/ralph-external/lib/worktree-preparation.mjs';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-worktree-local-only-'));
  roots.push(root);
  const repoRoot = path.join(root, 'project'), userConfig = path.join(root, 'user-config');
  mkdirSync(repoRoot); mkdirSync(userConfig);
  vi.stubEnv('AIWG_CONFIG', userConfig);
  const write = (relative: string, content = 'synthetic local input\n') => {
    const target = path.join(repoRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const policy = (paths: string[]) => write('models.json', JSON.stringify({
    defaults: { workerSelection: { dataPolicy: { localOnlyPaths: paths } } },
  }));
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.name', 'Synthetic Conductor']);
  git(repoRoot, ['config', 'user.email', 'conductor@example.test']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  write('public.txt', 'public fixture\n');
  const seal = () => {
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-qm', 'synthetic base']);
  };
  const options = {
    repoRoot, worktreesRoot: path.join(root, 'workers'), ownerId: 'test',
    registry: new WorktreeClaimRegistry(), deployContext: false,
  };
  return { root, repoRoot, userConfig, write, policy, seal, options };
}

it('T-OG-04 removes a tracked local-only file before context deploy and sets skip-worktree only in the worker', async () => {
  const f = fixture();
  f.write('local.txt'); f.policy(['local.txt', 'missing.txt']); f.seal();
  // The conductor policy may have changed since the worker base was committed.
  f.write('latest.txt'); f.policy(['local.txt', 'missing.txt', 'latest.txt']);
  const before = git(f.repoRoot, ['status', '--porcelain']);
  const deploy = vi.fn(({ worktreePath }) => {
    expect(existsSync(path.join(worktreePath, 'local.txt'))).toBe(false);
    expect(git(worktreePath, ['ls-files', '-v', '--', 'local.txt'])).toBe('S local.txt');
  });
  const result = await prepareWorkerWorktree({ ...f.options, deployContext: true,
    contextProviders: ['codex'], deployContextFn: deploy, verifyContextFn: () => ({ verified: true }),
  });
  expect(deploy).toHaveBeenCalledOnce();
  expect(result.excludedLocalOnlyPaths).toEqual(['local.txt']);
  expect(readFileSync(path.join(result.path!, 'public.txt'), 'utf8')).toBe('public fixture\n');
  expect(git(result.path!, ['status', '--porcelain'])).toBe('');
  expect(readFileSync(path.join(f.repoRoot, 'local.txt'), 'utf8')).toBe('synthetic local input\n');
  expect(git(f.repoRoot, ['ls-files', '-v', '--', 'local.txt'])).toBe('H local.txt');
  expect(git(f.repoRoot, ['status', '--porcelain'])).toBe(before);
});

it('T-OG-04 removes directory subtrees, including untracked children, without following descendant symlinks', async () => {
  const f = fixture();
  f.write('private/nested/input.txt'); f.write('private/ spaced\nname.txt');
  f.write('private-neighbour/input.txt', 'keep neighbour');
  const outside = path.join(f.root, 'outside.txt'); writeFileSync(outside, 'keep outside');
  symlinkSync(outside, path.join(f.repoRoot, 'private', 'link'));
  f.policy(['private/nested/input.txt', 'private', 'absent']); f.seal();
  const spawn: typeof spawnSync = ((command: string, args: string[], options: any) => {
    const result = spawnSync(command, args, { ...options, timeout: 30_000 });
    if (args[0] === 'worktree' && args[1] === 'add' && result.status === 0) {
      writeFileSync(path.join(args[3], 'private', 'untracked.txt'), 'untracked fixture');
    }
    return result;
  }) as typeof spawnSync;
  const result = await prepareWorkerWorktree({ ...f.options, spawn });
  expect(result.excludedLocalOnlyPaths).toEqual(['private', 'private/nested/input.txt']);
  expect(existsSync(path.join(result.path!, 'private'))).toBe(false);
  expect(git(result.path!, ['ls-files', '-v', '-z', '--', 'private']).split('\0').filter(Boolean))
    .toEqual(['S private/ spaced\nname.txt', 'S private/link', 'S private/nested/input.txt']);
  expect(git(result.path!, ['status', '--porcelain'])).toBe('');
  expect(readFileSync(path.join(result.path!, 'private-neighbour/input.txt'), 'utf8')).toBe('keep neighbour');
  expect(readFileSync(outside, 'utf8')).toBe('keep outside');
  expect(lstatSync(path.join(f.repoRoot, 'private/link')).isSymbolicLink()).toBe(true);
  expect(existsSync(path.join(f.repoRoot, 'private/nested/input.txt'))).toBe(true);
});

it('T-OG-04 unions inherited, named-class, group and template paths from the conductor policy', async () => {
  const f = fixture();
  for (const name of ['inherited', 'class', 'group', 'template', 'project']) f.write(`${name}.txt`);
  writeFileSync(path.join(f.userConfig, 'models.json'), JSON.stringify({ defaults: { workerSelection: {
    dataPolicy: { localOnlyPaths: ['inherited.txt'] },
    dataClasses: { private: { localOnlyPaths: ['class.txt'] } },
  } } }));
  f.policy(['project.txt']);
  f.write('.aiwg/aiwg.config', JSON.stringify({ version: '1.0', parallelism: {
    clis: { codex: { adapter: 'providers:codex', accountScope: 'synthetic', quotaScope: 'synthetic' } },
    groups: { private: { members: [{ id: 'synthetic', cli: 'codex', model: 'synthetic', roles: ['coding'] }],
      dataPolicy: { localOnlyPaths: ['group.txt'] } } },
    groupTemplates: { private: { dataPolicy: { localOnlyPaths: ['template.txt'] } } },
  } }));
  f.seal();
  const result = await prepareWorkerWorktree(f.options);
  expect(result.excludedLocalOnlyPaths).toEqual(['class.txt', 'group.txt', 'inherited.txt', 'project.txt', 'template.txt']);
  for (const relative of result.excludedLocalOnlyPaths!) expect(existsSync(path.join(result.path!, relative))).toBe(false);
});

it.each(['link/input.txt', 'link', 'dangling/input.txt'])('T-OG-04 refuses symlinked component %s and releases the claim before deployment', async relative => {
  const f = fixture();
  f.write('private/input.txt', 'conductor must retain this');
  symlinkSync(path.join(f.repoRoot, 'private'), path.join(f.repoRoot, 'link'));
  symlinkSync(path.join(f.root, 'missing'), path.join(f.repoRoot, 'dangling'));
  f.policy([relative]); f.seal();
  const deploy = vi.fn();
  await expect(prepareWorkerWorktree({ ...f.options, claims: { files: [path.join(f.repoRoot, 'public.txt')] },
    deployContext: true, contextProviders: ['codex'], deployContextFn: deploy,
  })).rejects.toThrow(/refusing symlinked local-only path component/);
  expect(deploy).not.toHaveBeenCalled();
  expect(f.options.registry.list()).toEqual([]);
  expect(git(f.repoRoot, ['worktree', 'list']).split('\n')).toHaveLength(1);
  expect(readFileSync(path.join(f.repoRoot, 'private/input.txt'), 'utf8')).toBe('conductor must retain this');
  expect(lstatSync(path.join(f.repoRoot, 'link')).isSymbolicLink()).toBe(true);
});

it('T-OG-04 removes nothing and reports an empty list without a policy', async () => {
  const f = fixture(); f.write('local.txt'); f.seal();
  const result = await prepareWorkerWorktree(f.options);
  expect(result.excludedLocalOnlyPaths).toEqual([]);
  expect(readFileSync(path.join(result.path!, 'local.txt'), 'utf8')).toBe('synthetic local input\n');
  expect(git(result.path!, ['ls-files', '-v', '--', 'local.txt'])).toBe('H local.txt');
  expect(git(result.path!, ['status', '--porcelain'])).toBe('');
});

it('T-OG-04 fails closed when skip-worktree fails, before removing local inputs', async () => {
  const f = fixture(); f.write('local.txt'); f.policy(['local.txt']); f.seal();
  let workerPath = '';
  const spawn: typeof spawnSync = ((command: string, args: string[], options: any) => {
    if (args[0] === 'update-index') {
      workerPath = options.cwd;
      expect(existsSync(path.join(workerPath, 'local.txt'))).toBe(true);
      return { status: 1, stderr: 'synthetic index failure' };
    }
    return spawnSync(command, args, { ...options, timeout: 30_000 });
  }) as typeof spawnSync;
  await expect(prepareWorkerWorktree({ ...f.options, spawn })).rejects.toThrow(/synthetic index failure/);
  expect(workerPath).not.toBe('');
  expect(existsSync(workerPath)).toBe(false);
  expect(f.options.registry.list()).toEqual([]);
  expect(existsSync(path.join(f.repoRoot, 'local.txt'))).toBe(true);
});
