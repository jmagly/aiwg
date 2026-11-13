/**
 * Worker AIWG context providers and launch-time bootstrap ensure (#3685).
 *
 * Orchestration must automatically `aiwg use` the providers configured for
 * it, so any new worker process starts with the AIWG bootstrap in place.
 * This module owns the config-side half: resolving WHICH providers
 * (config `providers` plus every CLI configured under
 * `parallelism.clis` / `parallelism.groups.*.members`, mapped through the
 * provider registry) and checking/ensuring that bootstrap inside exactly
 * one worker workdir (never outside it).
 *
 * The tools/ half (`tools/ralph-external/lib/worker-context.mjs`) loads the
 * config through `readAiwgConfig` and injects it here; direct callers may
 * pass an already-loaded config object instead.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  getProviderArtifactPathStrings,
  getProviderDefinition,
  normalizeProviderDefinitionId,
} from '../providers/provider-definitions.js';
import {
  emptyConfig,
  readAiwgConfig,
  writeAiwgConfig,
  type AiwgConfig,
} from './aiwg-config.js';

/** Minimal structural config input; the full AiwgConfig satisfies this. */
export interface WorkerContextConfig {
  providers?: unknown;
  parallelism?: {
    clis?: Record<string, { adapter?: unknown } | undefined | null> | undefined | null;
    groups?: Record<string, { members?: Array<{ cli?: unknown }> | undefined } | undefined | null> | undefined | null;
  } | undefined | null;
}

/**
 * Typed refusal when a worker's AIWG bootstrap cannot be ensured.
 * `remedy` names the operator action that unblocks the launch.
 */
export class WorkerContextBootstrapError extends Error {
  readonly code = 'OG_WORKER_CONTEXT_UNAVAILABLE';
  readonly remedy: string;
  readonly provider?: string;
  readonly workdir?: string;

  constructor(message: string, remedy: string, opts?: { provider?: string; workdir?: string }) {
    super(message);
    this.name = 'WorkerContextBootstrapError';
    this.remedy = remedy;
    if (opts?.provider !== undefined) this.provider = opts.provider;
    if (opts?.workdir !== undefined) this.workdir = opts.workdir;
  }
}

/** Explicit provider lists must be non-empty arrays of deployable ids. */
export function validateExplicitWorkerContextProviders(providers: unknown): string[] {
  if (!Array.isArray(providers) || providers.length === 0
    || providers.some(p => typeof p !== 'string' || p.length === 0 || p.includes('\0') || p.includes(','))) {
    throw new WorkerContextBootstrapError(
      'worker context providers must be a non-empty array of provider ids',
      'pass an explicit non-empty provider list, or configure providers plus orchestration CLIs in .aiwg/aiwg.config',
    );
  }
  return [...new Set(providers)];
}

const ADAPTER_REFERENCE = /^(providers|workerAdapters):([a-z][a-z0-9-]{0,62})$/;

/**
 * Map one orchestration CLI id to its AIWG provider id.
 * A CLI without an explicit `parallelism.clis` entry defaults to
 * `providers:<cli>` (the same default `resolveWorkerGroupInstallation`
 * applies). Non-provider adapters (e.g. `workerAdapters:local-http`) and
 * ids the registry does not know are reported as skipped, never guessed.
 */
export function mapCliToProviderId(
  cli: unknown,
  parallelism?: WorkerContextConfig['parallelism'],
): { provider: string } | { skipped: string } {
  if (typeof cli !== 'string' || cli.length === 0) {
    return { skipped: `empty CLI reference` };
  }
  const raw = typeof parallelism?.clis?.[cli]?.adapter === 'string'
    && (parallelism.clis[cli] as { adapter: string }).adapter.length > 0
    ? (parallelism.clis[cli] as { adapter: string }).adapter
    : `providers:${cli}`;
  const match = ADAPTER_REFERENCE.exec(raw);
  if (!match || match[1] !== 'providers') {
    return { skipped: `clis/${cli}: ${raw}` };
  }
  const provider = normalizeProviderDefinitionId(match[2]);
  if (!provider) return { skipped: `clis/${cli}: ${raw} (unknown provider)` };
  return { provider };
}

/**
 * Resolve the full worker-context provider set: the union of the config's
 * own `providers` and every CLI configured for orchestration
 * (`parallelism.clis` keys/adapters and the `cli` of every
 * `parallelism.groups.*.members[]`), mapped to AIWG provider ids through
 * the provider registry. Non-provider adapters are skipped and reported.
 * Fails closed when the union is empty.
 */
export function resolveWorkerContextProvidersFromConfig(
  config: WorkerContextConfig | null | undefined,
): { providers: string[]; skipped: string[] } {
  const providers: string[] = [];
  const skipped: string[] = [];
  const add = (id: string): void => {
    if (!providers.includes(id)) providers.push(id);
  };
  const skip = (entry: string): void => {
    if (!skipped.includes(entry)) skipped.push(entry);
  };

  const configured = (config as { providers?: unknown } | null | undefined)?.providers;
  if (Array.isArray(configured)) {
    for (const entry of configured) {
      if (typeof entry !== 'string' || entry.length === 0) continue;
      // Configured providers deploy verbatim when the registry does not
      // know them: project-local provider adapters resolve at deploy time
      // (see the `use` handler's project-local resolution), so an unknown
      // id here is the deployer's decision, not this resolver's.
      add(normalizeProviderDefinitionId(entry) ?? entry);
    }
  }

  const parallelism = config?.parallelism;
  for (const cli of Object.keys(parallelism?.clis ?? {})) {
    const mapped = mapCliToProviderId(cli, parallelism);
    if ('provider' in mapped) add(mapped.provider);
    else skip(mapped.skipped);
  }
  for (const [groupId, group] of Object.entries(parallelism?.groups ?? {})) {
    for (const member of group?.members ?? []) {
      const cli = (member as { cli?: unknown } | null | undefined)?.cli;
      const mapped = mapCliToProviderId(cli, parallelism);
      if ('provider' in mapped) add(mapped.provider);
      else skip(typeof cli === 'string' && cli ? `groups/${groupId}/members cli '${cli}': ${mapped.skipped}` : `groups/${groupId}/members: ${mapped.skipped}`);
    }
  }

  if (providers.length === 0) {
    throw new WorkerContextBootstrapError(
      'worker context deployment needs configured providers: the union of config providers and orchestration CLIs is empty'
        + (skipped.length > 0 ? ` (skipped: ${skipped.join('; ')})` : ''),
      'configure providers and/or parallelism clis/groups in .aiwg/aiwg.config, or pass an explicit provider list',
    );
  }
  return { providers, skipped };
}

/** Complete managed sections are required; a bootstrap marker alone is insufficient. */
function ruleSection(content: string, owner: string): string {
  return content.match(new RegExp(`<!--\\s*AIWG:${owner}:start\\s*-->([\\s\\S]*?)<!--\\s*AIWG:${owner}:end\\s*-->`))?.[1].trim() ?? '';
}
function readNonempty(file: string): string {
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
}
function hasRuleBootstrap(content: string, workdir: string, provider: string, rulesDir: string | null): boolean {
  // Older complete inline deployments remain usable during migration.
  if (ruleSection(content, 'rule-startup')) return true;
  const hook = ruleSection(content, `rule-hook-${provider}`);
  if (!ruleSection(content, 'rule-core') || !rulesDir) return false;
  const entry = path.join(rulesDir, 'RULES-INDEX.md');
  if (!hook.includes(`\`${entry.replaceAll('\\', '/')}\``)) return false;
  const indexFile = path.resolve(workdir, entry);
  const index = readNonempty(indexFile);
  if (!index) return false;
  return [...index.matchAll(/\]\(\.\/([^)]*\.md)\)/g)]
    .every(match => Boolean(readNonempty(path.resolve(path.dirname(indexFile), match[1]))));
}

export interface WorkerContextBootstrapStatus {
  present: boolean;
  missing: string[];
}

/**
 * Check that a worker workdir already carries one provider's bootstrap:
 * the kernel artifact dirs (`use all` writes kernel skills, rules,
 * behaviors — never the full agent/command surface) and, for providers
 * whose contract targets AGENTS.md, the AIWG rule sections.
 */
export function workerContextBootstrapStatus(
  { workdir, provider }: { workdir: string; provider: string },
): WorkerContextBootstrapStatus {
  const missing: string[] = [];
  const definition = getProviderDefinition(provider);
  if (!definition) {
    return { present: false, missing: [`unknown provider '${provider}'`] };
  }
  const paths = getProviderArtifactPathStrings(provider);
  const kernelDirs = [
    definition.paths.kernelSkills,
    paths?.rules ?? null,
    paths?.behaviors ?? null,
  ].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
  const requiredDirs = kernelDirs.length > 0
    ? kernelDirs
    : Object.values(paths ?? {}).filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
  for (const dir of [...new Set(requiredDirs)]) {
    const absolute = path.isAbsolute(dir) ? dir : path.join(workdir, dir);
    let entries: string[] | null = null;
    try {
      entries = readdirSync(absolute);
    } catch {
      entries = null;
    }
    if (!entries || entries.length === 0 || (dir === paths?.rules &&
      !entries.some(name => /\.(md|mdc)$/.test(name) && readNonempty(path.join(absolute, name))))) {
      missing.push(`provider dir '${dir}'`);
    }
  }
  if ((definition.context?.bootstrapTargets ?? []).includes('AGENTS.md')) {
    let content: string | null = null;
    try {
      content = readFileSync(path.join(workdir, 'AGENTS.md'), 'utf8');
    } catch {
      content = null;
    }
    if (!content || !hasRuleBootstrap(content, workdir, definition.id, paths?.rules ?? null)) {
      missing.push('AGENTS.md rule sections');
    }
  }
  return { present: missing.length === 0, missing };
}

export interface SyncWorkerContextProvidersOptions {
  /** Worker workdir whose `.aiwg/aiwg.config` receives the union set. */
  workdir: string;
  /** Union providers (config `providers` plus orchestration CLIs). */
  providers: string[];
  readConfig?: (workdir: string) => Promise<WorkerContextConfig | null>;
  writeConfig?: (workdir: string, config: AiwgConfig) => Promise<void>;
}

/**
 * Materialize the union provider set into the worker workdir's own config
 * through the existing loader/writer (never ad-hoc JSON). Existing entries
 * keep their order; union members absent from the worktree base are
 * appended. A missing config is created minimal. An already-current config
 * is left untouched so the deploy below stays the only writer.
 */
export async function syncWorkerContextProviders(
  options: SyncWorkerContextProvidersOptions,
): Promise<{ providers: string[]; updated: boolean }> {
  const { workdir } = options;
  if (typeof workdir !== 'string' || !path.isAbsolute(workdir)) {
    throw new WorkerContextBootstrapError(
      `worker context sync needs an absolute workdir, got ${JSON.stringify(workdir)}`,
      'sync worker context providers only into the worker workdir',
      { workdir: typeof workdir === 'string' ? workdir : undefined },
    );
  }
  const providers = validateExplicitWorkerContextProviders(options.providers);
  const read = options.readConfig ?? ((dir: string) => readAiwgConfig(dir) as Promise<WorkerContextConfig | null>);
  const existing = await read(workdir);
  const current = Array.isArray(existing?.providers)
    ? existing.providers.filter((entry: unknown): entry is string => typeof entry === 'string')
    : [];
  const merged = [...current];
  for (const provider of providers) {
    if (!merged.includes(provider)) merged.push(provider);
  }
  const unchanged = merged.length === current.length && merged.every((entry, index) => entry === current[index]);
  if (unchanged) return { providers: merged, updated: false };
  const base = existing !== null && typeof existing === 'object' && 'version' in existing
    ? (existing as unknown as Record<string, unknown>)
    : {};
  const next: AiwgConfig = { ...emptyConfig(merged), ...base, providers: merged };
  const write = options.writeConfig ?? ((dir: string, config: AiwgConfig) => writeAiwgConfig(dir, config));
  await write(workdir, next);
  return { providers: merged, updated: true };
}

/**
 * Canonical one-pass deploy argv: a single `aiwg use all` invocation
 * covering every listed provider, or explicitly selecting one project-local
 * launch provider. Never one deploy per provider in a union preparation:
 * per-provider invocations rewrite AGENTS.md piecemeal and clobber each
 * other's rule sections, while one pass keeps them all. No `--providers`
 * flag: it feeds only the global bootstrap and the orchestrated
 * verification report — `executeCore` resolves project-scope providers
 * from config (`src/cli/handlers/use.ts`), ignoring both the flag and any
 * explicitly resolved list. The supported project-scope mechanism is the
 * configured-provider path: `syncWorkerContextProviders` first, then this
 * single pass reads the union back from the worktree config.
 */
export function buildWorkerContextDeployArgs(
  { providers, target, selectedProvider }: { providers: string[]; target: string; selectedProvider?: string },
): string[] {
  // Fail fast on a hostile list; the synced worktree config carries the set.
  validateExplicitWorkerContextProviders(providers);
  if (selectedProvider !== undefined) {
    validateExplicitWorkerContextProviders([selectedProvider]);
    return ['use', 'all', '--provider', selectedProvider, '--scope', 'project', '--target', target, '--yes'];
  }
  return ['use', 'all', '--target', target, '--yes'];
}

export interface EnsureWorkerContextBootstrapOptions {
  /** Absolute worker workdir. The deploy target is always this directory. */
  workdir: string;
  /** The worker CLI's AIWG provider id. */
  provider: string;
  /** Wider set for the one-pass deploy; defaults to `[provider]`. */
  providers?: string[];
  /** Launch-time deploys select just this worker and refuse user-scope providers. */
  projectLocal?: boolean;
  aiwgBin?: string;
  spawn?: typeof spawnSync;
  timeoutMs?: number;
  statusFn?: typeof workerContextBootstrapStatus;
  deployFn?: (opts: { worktreePath: string; providers: string[]; aiwgBin: string }) => { providers: string[] } | Promise<{ providers: string[] }>;
  syncFn?: (opts: { workdir: string; providers: string[] }) => Promise<{ providers: string[]; updated: boolean }>;
  skipWorktreeFn?: (opts: { workdir: string }) => string[];
}

/** Keep CLI bootstrap state and caches local to a launch-time context deploy. */
export function workerContextDeployEnv(workdir: string, env = process.env, scratch?: string): NodeJS.ProcessEnv {
  const local = path.join(workdir, '.aiwg');
  // Data and cache hold regenerable deploy output (the framework search index
  // alone exceeds 100 MB). Inside the worker tree they break the verifier's
  // tree digest, so a scratch directory outside the tree takes them (#4150).
  return { ...env, HOME: workdir, USERPROFILE: workdir, AIWG_CONFIG: local,
    XDG_CONFIG_HOME: path.join(local, 'config'), XDG_CACHE_HOME: path.join(scratch ?? local, 'cache'),
    XDG_DATA_HOME: path.join(scratch ?? local, 'data'), XDG_STATE_HOME: path.join(local, 'state'),
    AIWG_USER_REGISTRY_PATH: path.join(local, 'installed.json'),
    AIWG_ARTIFACTS_PATH: local, AIWG_PROJECT_AIWG_DIR: local,
    CODEX_HOME: path.join(workdir, '.codex'), HERMES_HOME: path.join(workdir, '.hermes') };
}

/**
 * Ensure a worker workdir carries its CLI's AIWG bootstrap before launch.
 * Present: no-op. Missing: select one provider for projectLocal launches;
 * otherwise sync the union set into the workdir config,
 * then exactly one `aiwg use all` pass into the workdir (never anywhere
 * else), then re-verify. Impossible (no binary, failed deploy, still
 * missing afterwards): throw `WorkerContextBootstrapError` naming the
 * remedy — the caller refuses the launch rather than starting a
 * context-free worker.
 */
export async function ensureWorkerContextBootstrap(
  options: EnsureWorkerContextBootstrapOptions,
): Promise<{ ensured: boolean; providers: string[]; skippedBridges: string[] }> {
  const {
    workdir,
    provider,
    aiwgBin = process.env.AIWG_BIN ?? 'aiwg',
    spawn = spawnSync,
    timeoutMs = 300000,
    statusFn = workerContextBootstrapStatus,
  } = options;
  if (typeof workdir !== 'string' || !path.isAbsolute(workdir) || !existsSync(workdir)) {
    throw new WorkerContextBootstrapError(
      `worker context bootstrap needs an existing absolute workdir, got ${JSON.stringify(workdir)}`,
      'launch the worker with its resolved absolute workdir',
      { provider, workdir: typeof workdir === 'string' ? workdir : undefined },
    );
  }
  const status = statusFn({ workdir, provider });
  if (status.present) return { ensured: false, providers: [provider], skippedBridges: [] };
  const providers = options.providers && options.providers.length > 0
    ? validateExplicitWorkerContextProviders(options.providers)
    : [provider];
  // The configured-provider path: the single pass below resolves its set
  // from the workdir config, so the union must be materialized there
  // first — `--providers` never reaches project-scope deploys.
  const sync = options.syncFn ?? syncWorkerContextProviders;
  let synced: { providers: string[]; updated: boolean };
  try {
    synced = options.projectLocal ? { providers: [provider], updated: false } : await sync({ workdir, providers });
  } catch (error) {
    if (error instanceof WorkerContextBootstrapError) throw error;
    throw new WorkerContextBootstrapError(
      `worker context sync failed: ${error instanceof Error ? error.message : String(error)}`,
      `write the union providers into ${path.join(workdir, '.aiwg', 'aiwg.config')} (or run 'aiwg use all --target ${workdir} --yes' manually) before launch`,
      { provider, workdir },
    );
  }
  const argv = buildWorkerContextDeployArgs({ providers: synced.providers, target: workdir,
    ...(options.projectLocal ? { selectedProvider: provider } : {}) });
  const deploy = options.deployFn ?? (({ worktreePath, providers: deployProviders, aiwgBin: bin }: { worktreePath: string; providers: string[]; aiwgBin: string }) => {
    // worktreePath IS the worker workdir by construction: the only
    // `--target` ever passed is `workdir` above, and the spawn cwd is the
    // same directory, so no deploy write can land outside it.
    if (path.resolve(worktreePath) !== path.resolve(workdir)) {
      throw new WorkerContextBootstrapError(
        `refusing worker context deploy outside the worker workdir (${worktreePath} !== ${workdir})`,
        'deploy worker context only into the worker workdir',
        { provider, workdir },
      );
    }
    const scratch = options.projectLocal ? mkdtempSync(path.join(tmpdir(), 'aiwg-worker-deploy-')) : undefined;
    let result;
    try {
      result = spawn(bin, argv, { cwd: workdir, encoding: 'utf8', timeout: timeoutMs,
        ...(options.projectLocal ? { env: workerContextDeployEnv(workdir, process.env, scratch) } : {}) });
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
    if ((result as { error?: Error }).error) {
      throw new WorkerContextBootstrapError(
        `worker context deploy failed to run (${(result as { error?: Error }).error?.message});`
          + ` missing in ${workdir}: ${status.missing.join('; ')}`,
        `install the aiwg CLI on PATH or set AIWG_BIN to its location (tried '${bin}'),`
          + ` or run 'aiwg ${argv.join(' ')}' manually before launch`,
        { provider, workdir },
      );
    }
    if (result.status !== 0) {
      throw new WorkerContextBootstrapError(
        `worker context deploy exited ${result.status}: ${String(result.stderr ?? '').trim().slice(0, 2000)};`
          + ` missing in ${workdir}: ${status.missing.join('; ')}`,
        `run 'aiwg ${argv.join(' ')}' manually and resolve the reported failure before launch`,
        { provider, workdir },
      );
    }
    return { providers: [...deployProviders] };
  });
  let deployed: { providers: string[] };
  try {
    deployed = await deploy({ worktreePath: workdir, providers: synced.providers, aiwgBin });
  } catch (error) {
    if (error instanceof WorkerContextBootstrapError) throw error;
    throw new WorkerContextBootstrapError(
      `worker context deploy failed: ${error instanceof Error ? error.message : String(error)};`
        + ` missing in ${workdir}: ${status.missing.join('; ')}`,
      `run 'aiwg ${argv.join(' ')}' manually and resolve the reported failure before launch`,
      { provider, workdir },
    );
  }
  const after = statusFn({ workdir, provider });
  if (!after.present) {
    throw new WorkerContextBootstrapError(
      `worker context deploy did not produce the bootstrap: still missing in ${workdir}: ${after.missing.join('; ')}`,
      `run 'aiwg ${argv.join(' ')}' manually and verify the provider bootstrap before launch`,
      { provider, workdir },
    );
  }
  // Keep deploy-touched tracked bridges out of the worker diff. A workdir
  // outside any git repository has no tracked files; skip silently there.
  let skippedBridges: string[] = [];
  if (options.skipWorktreeFn) {
    skippedBridges = options.skipWorktreeFn({ workdir });
  } else {
    try {
      skippedBridges = flagDeployDirtiedSkipWorktree({ workdir, spawn, timeoutMs });
    } catch {
      skippedBridges = [];
    }
  }
  return { ensured: true, providers: [...deployed.providers], skippedBridges };
}

/** Tracked files the deploy modified, hidden from the worker diff. */
export function flagDeployDirtiedSkipWorktree(
  { workdir, spawn = spawnSync, timeoutMs = 30000 }: { workdir: string; spawn?: typeof spawnSync; timeoutMs?: number },
): string[] {
  const status = spawn('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: workdir, encoding: 'utf8', timeout: timeoutMs });
  if ((status as { error?: Error }).error) throw new Error(`git status failed: ${(status as { error?: Error }).error?.message}`);
  if (status.status !== 0) throw new Error(`git status exited ${status.status}`);
  const files: string[] = [];
  for (const line of String(status.stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    const raw = line.slice(3);
    const arrow = raw.indexOf(' -> ');
    const rel = arrow >= 0 ? raw.slice(arrow + 4) : raw;
    if (!rel || rel.startsWith('"')) throw new Error(`worker context deploy dirtied an unflaggeable path: ${line}`);
    files.push(rel);
  }
  if (files.length > 0) {
    const flag = spawn('git', ['update-index', '--skip-worktree', '--', ...files], { cwd: workdir, encoding: 'utf8', timeout: timeoutMs });
    if ((flag as { error?: Error }).error || flag.status !== 0) {
      throw new Error(`git update-index --skip-worktree failed: ${(flag as { error?: Error }).error?.message ?? String(flag.stderr ?? '').trim()}`);
    }
  }
  return files;
}
