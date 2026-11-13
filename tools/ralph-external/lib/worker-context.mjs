/**
 * Worker AIWG context loading and launch-time ensure, tools side (#3685).
 *
 * The provider-set UNION lives in `src/config/worker-context.ts` and the
 * config loads through the existing `readAiwgConfig` loader (never ad-hoc
 * JSON). Both cross the tools/src boundary through `importImpl`, so this
 * module stays runnable from an installed package (`dist/src`) and a
 * checkout (`src/`); every such seam is injectable for synthetic tests.
 * `src/` must never import `tools/`, so the src module is always the
 * callee, never the caller.
 *
 * Also home to the single-pass deploy, section verifier, and
 * skip-worktree helpers extracted from `worktree-preparation.mjs` (which
 * re-exports them) so that file stays agent-friendly.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';

/** Load the project config through the existing loader. */
async function defaultReadConfig(repoRoot) {
  const { readAiwgConfig } = await importImpl(import.meta.url, 'config/aiwg-config.js');
  return readAiwgConfig(repoRoot);
}

/** Resolve the provider union through the src-side pure function. */
async function defaultResolveFromConfig(config) {
  const { resolveWorkerContextProvidersFromConfig } = await importImpl(import.meta.url, 'config/worker-context.js');
  return resolveWorkerContextProvidersFromConfig(config);
}

/** Map one orchestration CLI id through the src-side registry mapping. */
async function defaultMapCli(cli, parallelism) {
  const { mapCliToProviderId } = await importImpl(import.meta.url, 'config/worker-context.js');
  return mapCliToProviderId(cli, parallelism);
}

/**
 * Resolve the worker-context provider set (#3685 round 2): the union of
 * `.aiwg/aiwg.config` `providers` and every CLI configured for
 * orchestration (`parallelism.clis` keys/adapters and the `cli` of every
 * `parallelism.groups.*.members[]`), mapped through the provider
 * registry. An explicit list wins and is returned verbatim.
 *
 * @returns {Promise<{providers: string[], skipped: string[]}>}
 */
export async function resolveWorkerContextProviders({ repoRoot, providers = null, readConfig = null, resolveFromConfig = null } = {}) {
  if (providers !== null && providers !== undefined) {
    if (!Array.isArray(providers) || providers.length === 0
      || providers.some(p => typeof p !== 'string' || p.length === 0 || p.includes('\0') || p.includes(','))) {
      throw new Error('worker context providers must be a non-empty array of provider ids');
    }
    return { providers: [...new Set(providers)], skipped: [] };
  }
  if (typeof repoRoot !== 'string' || !repoRoot) {
    throw new Error('worker context providers need a repoRoot or an explicit provider list');
  }
  const config = await (readConfig ?? defaultReadConfig)(repoRoot);
  if (!config) {
    throw new Error(`worker context deployment needs configured providers: cannot read ${path.join(repoRoot, '.aiwg', 'aiwg.config')} (missing or invalid); configure providers and orchestration CLIs, or pass an explicit provider list`);
  }
  return (resolveFromConfig ?? defaultResolveFromConfig)(config);
}

/**
 * Ensure a worker workdir carries its CLI's AIWG bootstrap before launch.
 * Resolves the worker CLI to its provider (from the project config, so
 * orchestration CLIs map through the registry), checks presence, and
 * deploys only that provider with project scope when missing. The deploy
 * target is always exactly `workdir` — never anywhere else.
 *
 * Injectable for synthetic tests: `ensureFn` stubs the whole ensure,
 * otherwise `mapCli`, `readConfig`, `resolveFromConfig`, `deployFn`,
 * `statusFn`, and `skipWorktreeFn` stub each seam.
 *
 * @returns {Promise<{ensured: boolean, provider: string, providers: string[], skippedBridges: string[], skipped: string[]}>}
 */
export async function ensureWorkerContextForLaunch({
  workdir,
  cli,
  config = null,
  repoRoot = null,
  providers = null,
  readConfig = null,
  resolveFromConfig = null,
  mapCli = null,
  ensureFn = null,
  statusFn = null,
  deployFn = null,
  skipWorktreeFn = null,
  aiwgBin = process.env.AIWG_BIN ?? 'aiwg',
} = {}) {
  if (typeof workdir !== 'string' || !workdir) throw new Error('worker context ensure needs a workdir');
  if (typeof cli !== 'string' || !cli) throw new Error('worker context ensure needs the worker CLI id');
  let resolved = Array.isArray(providers) && providers.length > 0 ? { providers: [...new Set(providers)], skipped: [] } : null;
  let loaded = config ?? null;
  if (!resolved) {
    if (!loaded && repoRoot) loaded = await (readConfig ?? defaultReadConfig)(repoRoot);
    if (loaded) {
      resolved = await (resolveFromConfig ?? defaultResolveFromConfig)(loaded);
    }
  }
  const map = mapCli ?? defaultMapCli;
  const mapped = await map(cli, loaded?.parallelism ?? null);
  if (!('provider' in mapped) || !mapped.provider) {
    // Typed-shaped refusal without importing the src error class (which
    // would couple this sync-throwing path to the compiled `dist`
    // layout): callers discriminate on `code`, never `instanceof`.
    throw Object.assign(
      new Error(`cannot ensure worker context: CLI '${cli}' maps to no AIWG provider (${mapped.skipped ?? 'unmapped'})`),
      { code: 'OG_WORKER_CONTEXT_UNAVAILABLE',
        remedy: `configure parallelism.clis.${cli} with a providers:<id> adapter, or use a CLI whose adapter maps to a known provider`,
        workdir },
    );
  }
  const provider = mapped.provider;
  const deployProviders = [provider];
  const ensure = ensureFn ?? (async (opts) => {
    const { ensureWorkerContextBootstrap } = await importImpl(import.meta.url, 'config/worker-context.js');
    return ensureWorkerContextBootstrap(opts);
  });
  const outcome = await ensure({
    workdir, provider, providers: deployProviders, projectLocal: true, aiwgBin,
    ...(statusFn ? { statusFn } : {}),
    ...(deployFn ? { deployFn } : {}),
    ...(skipWorktreeFn ? { skipWorktreeFn } : {}),
  });
  return { ...outcome, provider, skipped: resolved?.skipped ?? [] };
}

/** Materialize the union set into the worktree config through the src-side sync. */
async function defaultSyncProviders(worktreePath, providers) {
  const { syncWorkerContextProviders } = await importImpl(import.meta.url, 'config/worker-context.js');
  return syncWorkerContextProviders({ workdir: worktreePath, providers });
}

/** Single-pass argv through the src-side canonical builder (never `--providers`). */
async function defaultDeployArgv(providers, worktreePath) {
  const { buildWorkerContextDeployArgs } = await importImpl(import.meta.url, 'config/worker-context.js');
  return buildWorkerContextDeployArgs({ providers, target: worktreePath });
}

/**
 * Default single-pass AIWG context deploy (#3685): sync the union set
 * into the worktree config, then one `aiwg use all --target <worktree>`
 * covering every configured provider. Never one deploy per provider:
 * per-provider invocations rewrite AGENTS.md piecemeal and clobber each
 * other's rule sections, while a single pass keeps them all. No
 * `--providers` flag: it never reaches project-scope deploys
 * (`executeCore` resolves from config), so the configured-provider path
 * above is the supported mechanism. Injectable via
 * `prepareWorkerWorktree()`'s `deployContextFn` for synthetic tests;
 * `syncFn` stubs the config sync as `(worktreePath, providers)` and
 * `argvFn` stubs the argv builder as `(providers, target)`.
 *
 * @returns {Promise<{providers: string[]}>}
 */
export async function defaultDeployWorkerContext({ worktreePath, providers, aiwgBin = 'aiwg', spawn = spawnSync, timeoutMs = 300000, syncFn = null, argvFn = null } = {}) {
  if (typeof worktreePath !== 'string' || !worktreePath || typeof aiwgBin !== 'string' || !aiwgBin) {
    throw new Error('worker context deploy requires a worktree path and an aiwg binary');
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('worker context deploy requires a non-empty provider list');
  }
  const sync = syncFn ?? defaultSyncProviders;
  const synced = await sync(worktreePath, providers);
  const syncedProviders = Array.isArray(synced?.providers) && synced.providers.length > 0 ? synced.providers : [...providers];
  const buildArgv = argvFn ?? defaultDeployArgv;
  const argv = await buildArgv(syncedProviders, worktreePath);
  const result = spawn(aiwgBin, argv, { cwd: worktreePath, encoding: 'utf8', timeout: timeoutMs });
  if (result.error) throw new Error(`aiwg ${argv.join(' ')} failed to run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`aiwg ${argv.join(' ')} exited ${result.status}: ${String(result.stderr ?? '').trim().slice(0, 2000)}`);
  }
  return { providers: [...syncedProviders] };
}

/** AIWG-managed rule-section markers written into a deployed AGENTS.md. */
const WORKER_CONTEXT_RULE_MARKER = /<!--\s*AIWG:[A-Za-z0-9_-]+:(start|end)\s*-->/;

/**
 * Verify a prepared worktree actually carries AIWG rule sections (#3685):
 * the worktree's AGENTS.md must exist and contain AIWG-managed section
 * markers. Throws before launch otherwise — a worktree without them would
 * run the worker with no project rules/skills/hooks. Injectable via
 * `prepareWorkerWorktree()`'s `verifyContextFn` for synthetic tests.
 *
 * @returns {{verified: boolean, providers: string[]}}
 */
export function verifyWorkerContextSections({ worktreePath, providers = [] } = {}) {
  const agentsMd = path.join(worktreePath, 'AGENTS.md');
  let content;
  try {
    content = readFileSync(agentsMd, 'utf8');
  } catch {
    throw new Error(`worker context verification failed: ${agentsMd} is missing; the worker would run without AIWG rule sections`);
  }
  if (!WORKER_CONTEXT_RULE_MARKER.test(content)) {
    throw new Error(`worker context verification failed: ${agentsMd} has no AIWG rule sections (expected <!-- AIWG:<rule>:start --> markers for ${[...providers].join(',') || 'the configured providers'})`);
  }
  return { verified: true, providers: [...providers] };
}

/**
 * Tracked files the context deploy modified, so the caller can hide them
 * from the worker diff. Parses `git status --porcelain=v1` with untracked
 * files excluded: every remaining entry is a tracked modification (the
 * fresh worktree starts clean, so each one is deploy-caused).
 *
 * @returns {string[]} Repo-relative paths of tracked-modified files.
 */
export function listDeployDirtiedBridges({ worktreePath, spawn = spawnSync, timeoutMs = 30000 } = {}) {
  // Raw spawn output, never a trimmed helper: trim would eat the
  // significant leading space of the first porcelain line (` M AGENTS.md`
  // trims to `M AGENTS.md`, shifting slice(3) one byte into the filename).
  const result = spawn('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: worktreePath, encoding: 'utf8', timeout: timeoutMs });
  if (result.error) throw new Error(`git status failed to run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git status exited ${result.status}: ${String(result.stderr ?? '').trim()}`);
  }
  const files = [];
  for (const line of String(result.stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    // `XY PATH` or `XY ORIG -> NEW` for renames; take the new path, which is
    // what the worker diff would report.
    const raw = line.slice(3);
    const arrow = raw.indexOf(' -> ');
    const rel = arrow >= 0 ? raw.slice(arrow + 4) : raw;
    // Porcelain quotes paths with special bytes; a deploy that creates such
    // a name is refused rather than mis-flagged.
    if (!rel || rel.startsWith('"')) throw new Error(`worker context deploy dirtied an unflaggeable path: ${line}`);
    files.push(rel);
  }
  return files;
}
