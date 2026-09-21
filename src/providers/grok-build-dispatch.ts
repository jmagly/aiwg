/** AIWG-controlled Grok Build dispatch: budgets, cap admission and isolation. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readAiwgConfig, resolveParallelism } from '../config/aiwg-config.js';
import { runGrokHeadless, type GrokHeadlessOptions, type GrokHeadlessResult } from './grok-build-headless.js';

const git = promisify(execFile);
const dispatchers = new Map<string, GrokBuildDispatcher>();

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

  private constructor(maxParallel: number) { this.maxParallel = maxParallel; }

  static async forProject(projectRoot: string): Promise<GrokBuildDispatcher> {
    const config = await readAiwgConfig(projectRoot);
    const cap = resolveParallelism(config?.parallelism, 'grok-build').max_parallel_subagents;
    if (!Number.isInteger(cap) || cap < 1) throw new Error('Invalid Grok Build project parallelism cap');
    const key = resolve(projectRoot);
    const existing = dispatchers.get(key);
    if (existing) {
      existing.maxParallel = cap;
      return existing;
    }
    const dispatcher = new GrokBuildDispatcher(cap);
    dispatchers.set(key, dispatcher);
    return dispatcher;
  }

  get activeDispatches(): number { return this.active; }

  async dispatch(options: GrokDispatchOptions): Promise<{ result: GrokHeadlessResult; worktree?: GrokWorktreeRecord }> {
    if (this.active >= this.maxParallel) throw new Error(`Grok Build project parallelism cap ${this.maxParallel} reached`);
    if (!await options.authorize()) throw new Error('Grok Build dispatch authorization gate denied');
    if (!await options.budgetRemaining()) throw new Error('Grok Build orchestration budget exhausted');
    this.active += 1;
    try {
      const worktree = options.isolate ? await prepareGrokWorktree(options.projectRoot) : undefined;
      // Grok's internal autonomous subagent fan-out has no documented hard
      // project cap. Disable it in AIWG-controlled headless workers so every
      // parallel worker consumes one dispatcher slot. Interactive Grok use
      // remains outside this bounded API and must not be claimed as enforced.
      const env = { ...process.env, ...options.env, GROK_SUBAGENTS: '0' };
      const result = await runGrokHeadless({ ...options, cwd: worktree?.path ?? options.projectRoot, env });
      return { result, ...(worktree ? { worktree } : {}) };
    } finally { this.active -= 1; }
  }
}
