/** AIWG-controlled Grok Build dispatch: budgets, cap admission and isolation. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readAiwgConfig, resolveParallelism } from '../config/aiwg-config.js';
import { runGrokHeadless, type GrokHeadlessOptions, type GrokHeadlessResult } from './grok-build-headless.js';

const git = promisify(execFile);
const dispatchers = new Map<string, GrokBuildDispatcher>();

async function projectKey(projectRoot: string): Promise<string> {
  const root = await realpath(projectRoot);
  try { return await realpath(await gitOut(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')); }
  catch (error) {
    if (/not a git repository/i.test(String((error as { stderr?: string }).stderr ?? ''))) return root;
    throw new Error('Cannot resolve Grok Build project Git identity; dispatch refused', { cause: error });
  }
}

async function slotDirectory(key: string): Promise<string> {
  const isGitDir = await lstat(join(key, 'objects')).then(info => info.isDirectory(), () => false)
    && await lstat(join(key, 'HEAD')).then(info => info.isFile(), () => false);
  const dir = isGitDir
    ? join(key, 'aiwg-grok-dispatch-slots')
    : join(tmpdir(), `aiwg-grok-dispatch-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(key).digest('hex')}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
    throw new Error('Grok Build dispatch slot directory is not private to this user');
  }
  return dir;
}

/** Atomic project slots are shared by independent AIWG processes and Git worktrees. */
export async function acquireGrokProjectSlot(key: string, limit: number): Promise<() => Promise<void>> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid Grok Build project parallelism cap');
  const dir = await slotDirectory(key);
  const occupied = await readdir(dir);
  if (occupied.some(name => /^\d+\.json$/.test(name) && Number.parseInt(name, 10) >= limit)) {
    throw new Error('Grok Build project parallelism cap was lowered while workers are active; wait for them to finish');
  }
  slot: for (let index = 0; index < limit; index++) {
    const file = join(dir, `${index}.json`);
    const token = randomUUID();
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let info;
      try { info = await lstat(file); }
      catch (race) {
        if ((race as NodeJS.ErrnoException).code === 'ENOENT') { index--; continue slot; }
        throw race;
      }
      if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
        throw new Error(`Unsafe Grok Build dispatch slot ${index}; review ownership before retrying`);
      }
      let owner: { pid?: number; token?: string } | undefined;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { owner = JSON.parse(await readFile(file, 'utf8')) as typeof owner; break; }
        catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') { index--; continue slot; }
          if (attempt === 19) throw new Error(`Incomplete Grok Build dispatch slot ${index}; review ownership before retrying`);
          await new Promise(resolveWait => setTimeout(resolveWait, 10));
        }
      }
      if (!owner) throw new Error(`Incomplete Grok Build dispatch slot ${index}; review ownership before retrying`);
      if (!Number.isInteger(owner.pid) || (owner.pid ?? 0) < 1 || typeof owner.token !== 'string') {
        throw new Error(`Invalid Grok Build dispatch slot ${index}; review ownership before retrying`);
      }
      try { process.kill(owner.pid!, 0); }
      catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') {
          throw new Error(`Stale Grok Build dispatch slot ${index}; confirm no worker remains, then remove it explicitly`);
        }
        if ((probeError as NodeJS.ErrnoException).code !== 'EPERM') throw probeError;
      }
      continue;
    }
    try { await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, limit })}\n`); }
    catch (error) { await handle.close(); await unlink(file); throw error; }
    await handle.close();
    let released = false;
    return async () => {
      if (released) return;
      const owner = JSON.parse(await readFile(file, 'utf8')) as { token?: string };
      if (owner.token !== token) throw new Error('Grok Build dispatch slot ownership changed; refusing to release another worker');
      await unlink(file);
      released = true;
    };
  }
  throw new Error(`Grok Build project parallelism cap ${limit} reached`);
}

export interface GrokWorktreeRecord {
  schema: 'aiwg.grok-build.worktree.v1';
  owner: string;
  source: string;
  path: string;
  baseCommit: string;
  createdAt: string;
  recovery: string;
}

async function gitOut(cwd: string, ...args: string[]): Promise<string> {
  const result = await git('git', args, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

/** Create a detached worktree and save its record in Git's per-worktree metadata. */
export async function prepareGrokWorktree(source: string, owner = randomUUID()): Promise<GrokWorktreeRecord> {
  const root = await gitOut(source, 'rev-parse', '--show-toplevel');
  const dirty = await gitOut(root, 'status', '--porcelain');
  if (dirty) throw new Error('Grok Build worktree dispatch requires a clean source checkout; commit or preserve current changes before dispatch');
  const baseCommit = await gitOut(root, 'rev-parse', 'HEAD');
  const worktree = await mkdtemp(join(tmpdir(), 'aiwg-grok-worktree-'));
  await gitOut(root, 'worktree', 'add', '--detach', worktree, baseCommit);
  const gitDir = await gitOut(worktree, 'rev-parse', '--absolute-git-dir');
  const record: GrokWorktreeRecord = {
    schema: 'aiwg.grok-build.worktree.v1', owner, source: resolve(root), path: worktree,
    baseCommit, createdAt: new Date().toISOString(),
    recovery: `git -C ${JSON.stringify(root)} worktree list --porcelain`,
  };
  await writeFile(join(gitDir, 'aiwg-grok-owner.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return record;
}

export interface GrokDispatchOptions extends Omit<GrokHeadlessOptions, 'cwd' | 'env'> {
  projectRoot: string;
  isolate?: boolean;
  /** Caller-supplied budget gate; the dispatcher never silently approves work. */
  authorize: () => boolean | Promise<boolean>;
  budgetRemaining: () => boolean | Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}

export class GrokBuildDispatcher {
  private active = 0;
  maxParallel: number;
  private readonly key: string;

  private constructor(maxParallel: number, key: string) { this.maxParallel = maxParallel; this.key = key; }

  static async forProject(projectRoot: string): Promise<GrokBuildDispatcher> {
    const config = await readAiwgConfig(projectRoot);
    const cap = resolveParallelism(config?.parallelism, 'grok-build').max_parallel_subagents;
    if (!Number.isInteger(cap) || cap < 1) throw new Error('Invalid Grok Build project parallelism cap');
    const key = await projectKey(projectRoot);
    const existing = dispatchers.get(key);
    if (existing) {
      existing.maxParallel = cap;
      return existing;
    }
    const dispatcher = new GrokBuildDispatcher(cap, key);
    dispatchers.set(key, dispatcher);
    return dispatcher;
  }

  get activeDispatches(): number { return this.active; }

  async dispatch(options: GrokDispatchOptions): Promise<{ result: GrokHeadlessResult; worktree?: GrokWorktreeRecord }> {
    if (await projectKey(options.projectRoot) !== this.key) throw new Error('Grok Build dispatcher project root changed');
    if (this.active >= this.maxParallel) throw new Error(`Grok Build project parallelism cap ${this.maxParallel} reached`);
    if (!await options.authorize()) throw new Error('Grok Build dispatch authorization gate denied');
    if (!await options.budgetRemaining()) throw new Error('Grok Build orchestration budget exhausted');
    const release = await acquireGrokProjectSlot(this.key, this.maxParallel);
    this.active += 1;
    try {
      const worktree = options.isolate ? await prepareGrokWorktree(options.projectRoot) : undefined;
      // Grok's internal autonomous subagent fan-out has no documented hard
      // project cap. Disable it in AIWG-controlled headless workers so every
      // parallel worker consumes one dispatcher slot. Interactive Grok use
      // remains outside this bounded API and must not be claimed as enforced.
      const env = { ...process.env, ...options.env, GROK_SUBAGENTS: '0' };
      const result = await runGrokHeadless({ ...options, cwd: worktree?.path ?? options.projectRoot, env, disableSubagents: true });
      return { result, ...(worktree ? { worktree } : {}) };
    } finally { this.active -= 1; await release(); }
  }
}
