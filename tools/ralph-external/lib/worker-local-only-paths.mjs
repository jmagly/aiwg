// Remove declared local-only inputs from conductor-owned worker worktrees before deployment.
import { spawnSync } from 'node:child_process';
import { lstatSync, rmSync } from 'node:fs';
import path from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';

function existingTarget(worktreePath, relative) {
  let target = worktreePath;
  for (const component of relative.split('/')) {
    target = path.join(target, component);
    let info;
    try { info = lstatSync(target); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`refusing symlinked local-only path component: ${relative}`);
  }
  return target;
}

export async function excludeWorkerLocalOnlyPaths({ repoRoot, worktreePath, spawn = spawnSync, timeoutMs = 30000 }) {
  const { readAiwgConfig } = await importImpl(import.meta.url, 'config/aiwg-config.js');
  const { ConfigLoader } = await importImpl(import.meta.url, 'models/config-loader.js');
  const { collectLocalOnlyPaths } = await importImpl(import.meta.url, 'models/conductor-data-policy.mjs');
  const config = await readAiwgConfig(repoRoot);
  const models = await new ConfigLoader(repoRoot).load(config?.parallelism);
  const paths = collectLocalOnlyPaths(models.defaults.workerSelection, config?.parallelism);
  // Validate every component before changing the index or removing anything.
  const targets = paths.map(relative => ({ relative, target: existingTarget(worktreePath, relative) }))
    .filter(entry => entry.target !== null);
  if (!targets.length) return [];

  const git = (args, input) => {
    const result = spawn('git', args, { cwd: worktreePath, encoding: 'utf8', timeout: timeoutMs, input });
    if (result.error) throw new Error(`git ${args.join(' ')} failed to run: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited ${result.status}: ${String(result.stderr ?? '').trim()}`);
    return String(result.stdout ?? '');
  };
  // Literal pathspecs include tracked descendants, without treating names as glob syntax.
  const tracked = git(['ls-files', '-z', '--', ...targets.map(({ relative }) => `:(literal)${relative}`)]);
  if (tracked) git(['update-index', '--skip-worktree', '-z', '--stdin'], tracked);
  // rm unlinks descendant symlinks themselves; it never traverses their targets.
  for (const { target } of targets) rmSync(target, { recursive: true, force: true });
  return targets.map(({ relative }) => relative);
}
