/**
 * Tier 0 writer worktree preparation and ownership (FR-OG-039, FR-OG-068,
 * #2889 / B-OG-13). Extends Rule 9 step 4 ("Prepare the worktree") with the
 * exact-base-digest binding and overlapping-claim refusal that step only
 * described narratively.
 *
 * The conductor — never the worker — owns worktree creation and the claim
 * registry below. A worktree is created at an exact recorded base digest
 * (`git rev-parse <revision>`, not a moving ref) so later acceptance can
 * bind to a specific tree; two writer claims on the same file or port
 * refuse to both proceed rather than silently interleave writes.
 *
 * This module adds no daemon, store, or scheduler: `WorktreeClaimRegistry`
 * is a plain in-memory ownership table the conductor process holds for the
 * duration of its own run, matching the Tier 0 "no admission store" scope.
 * Managed, cross-conductor disk reservations and leases remain Tier 1
 * (deferred to S2+; see `agentic/code/addons/aiwg-utils/rules/subagent-scoping.md`
 * Rule 9 and `08-security-and-threat-model.md`'s Tier 1 brief/retention
 * section).
 *
 * #3685: a fresh worktree holds only tracked files, so deployed provider
 * context (gitignored `.codex/`, `.claude/`, `.muse/`, `.agents/` and the
 * AIWG rule sections in `AGENTS.md`) is missing until the conductor puts
 * it there. Preparation therefore deploys that context by default
 * (`deployContext`, one `aiwg use all` pass for every configured provider
 * — never one deploy per provider, which clobbers other providers'
 * `AGENTS.md` sections), hides the deploy's tracked-bridge edits from the
 * worker diff with `git update-index --skip-worktree`, and verifies the
 * rule sections before reporting ready.
 *
 * #3685 round 2: the provider set is the union of the config `providers`
 * and every orchestration CLI, loaded through `readAiwgConfig` (see
 * `worker-context.mjs`, which also owns the single-pass deploy, the
 * section verifier, and the skip-worktree helpers extracted from here).
 * This module stays synchronous: callers preload the set with
 * `resolveWorkerContextProviders()` and pass it as `contextProviders`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { excludeWorkerLocalOnlyPaths } from './worker-local-only-paths.mjs';
import {
  defaultDeployWorkerContext,
  listDeployDirtiedBridges,
  resolveWorkerContextProviders,
  verifyWorkerContextSections,
} from './worker-context.mjs';

export {
  defaultDeployWorkerContext,
  listDeployDirtiedBridges,
  resolveWorkerContextProviders,
  verifyWorkerContextSections,
};

/** Thrown when a requested claim set collides with an already-held claim. */
export class WorktreeClaimConflictError extends Error {
  constructor(conflicts) {
    super(`worktree claim conflict: ${conflicts.map(c => `${c.claim} held by ${c.heldBy}`).join(', ')}`);
    this.name = 'WorktreeClaimConflictError';
    this.conflicts = conflicts;
  }
}

/**
 * M4: key a file claim by its realpath (and, for a file that already
 * exists, its `dev:inode` as a secondary disambiguator) rather than by
 * `path.resolve` alone. Two spellings of the same inode — a literal path
 * and a `/proc/self/cwd`-relative or symlinked-ancestor spelling — must
 * collide to the same claim key so two owners can never both be granted a
 * claim that is actually the same file; `path.resolve` alone cannot
 * guarantee that, since it only normalizes `.`/`..`/separators, never
 * symlinks. A not-yet-existing file (the common case — a worker hasn't
 * written it yet) keys on the realpath of its resolved *directory* plus
 * its own basename, since the file itself has no inode yet to read.
 */
function claimKeyForFile(file) {
  // Returns the display key used in conflict reports plus every identity key
  // the registry indexes. An existing file is indexed by dev:inode (so
  // hardlink aliases collide) AND by its canonical path (so a claim made
  // before the file existed still collides once it appears). A file that does
  // not exist yet is indexed by its canonical directory plus basename.
  const resolved = path.resolve(file);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  let dirReal;
  try {
    dirReal = realpathSync(dir);
  } catch {
    // Parent directory does not exist yet either: key the resolved spelling.
    dirReal = dir;
  }
  const candidate = path.join(dirReal, base);
  try {
    const real = realpathSync(candidate);
    const stat = statSync(real);
    return { display: `file:${real}#${stat.dev}:${stat.ino}`, keys: [`inode:${stat.dev}:${stat.ino}`, `path:${real}`] };
  } catch {
    return { display: `file:${candidate}`, keys: [`path:${candidate}`] };
  }
}

function normalizeClaims({ files = [], ports = [] } = {}) {
  // File claims must already be absolute: resolving a relative claim
  // against the conductor process's own CWD (rather than the repo/worktree
  // the claim is actually about) would silently key two different intended
  // files identically or two identical intended files differently,
  // depending on wherever the process happened to be started from.
  for (const file of files) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) {
      throw new Error(`worktree claim requires absolute file paths, got ${JSON.stringify(file)}`);
    }
  }
  const fileEntries = files.map(claimKeyForFile);
  const portEntries = ports.map(port => {
    const key = `port:${Number(port)}`;
    if (!Number.isInteger(Number(port)) || Number(port) <= 0) {
      throw new Error(`worktree claim requires positive integer ports, got ${key}`);
    }
    return { display: key, keys: [key] };
  });
  return [...fileEntries, ...portEntries];
}

/**
 * Tracks which conductor-local owner currently holds which file/port
 * claims. One shared registry instance per conductor process/run — not a
 * cross-process store. `claim` is all-or-nothing: either every requested
 * claim is free and all are granted atomically, or none are granted and the
 * caller gets back the exact conflicts so it can serialize (wait and
 * retry) or fail the attempt. This is the mechanism Rule 9 step 6 assumes
 * when it says overlapping writer claims "serialize or fail."
 */
export class WorktreeClaimRegistry {
  constructor() {
    /** @type {Map<string, string>} claimKey -> ownerId */
    this._held = new Map();
    /** @type {Map<string, string[]>} ownerId -> claimKeys */
    this._byOwner = new Map();
  }

  /**
   * @param {string} ownerId
   * @param {{files?: string[], ports?: number[]}} claims
   * @returns {{granted: boolean, conflicts: Array<{claim: string, heldBy: string}>}}
   */
  claim(ownerId, claims) {
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
      throw new Error('worktree claim requires a non-empty ownerId');
    }
    const entries = normalizeClaims(claims);
    const conflicts = [];
    for (const entry of entries) {
      const heldBy = entry.keys.map(key => this._held.get(key)).find(owner => owner !== undefined && owner !== ownerId);
      if (heldBy !== undefined) conflicts.push({ claim: entry.display, heldBy });
    }
    if (conflicts.length > 0) {
      return { granted: false, conflicts };
    }
    const keys = entries.flatMap(entry => entry.keys);
    for (const key of keys) this._held.set(key, ownerId);
    const existing = this._byOwner.get(ownerId) ?? [];
    this._byOwner.set(ownerId, [...new Set([...existing, ...keys])]);
    return { granted: true, conflicts: [] };
  }

  /** Release every claim held by `ownerId`. Idempotent. */
  release(ownerId) {
    const keys = this._byOwner.get(ownerId) ?? [];
    for (const key of keys) {
      if (this._held.get(key) === ownerId) this._held.delete(key);
    }
    this._byOwner.delete(ownerId);
  }

  /** Snapshot of current claims for diagnostics/tests. */
  list() {
    return [...this._held.entries()].map(([claim, heldBy]) => ({ claim, heldBy }));
  }
}

/**
 * M5 (round 2): create a directory tree with NO exposure window, instead of
 * `mkdirSync({ recursive: true })` (default mode, i.e. `0o777 & ~umask`)
 * followed by a separate `chmodSync` — between those two calls the
 * directory briefly exists at whatever the ambient umask left it at
 * (`0775`/`0777` on a `0002`/`0000` umask host), which is a real exposure
 * window for anything racing to open/traverse it before the chmod lands.
 *
 * Instead, each path component this call actually creates passes
 * `mode: 0o700` directly to the SAME `mkdirSync` syscall that creates it:
 * `mkdir(2)` is atomic, so the directory never exists at any wider mode
 * even momentarily — there is no second step for a race to land in. This
 * deliberately does NOT touch `process.umask()` to "neutralize" the
 * ambient umask (that setter throws `TypeError: Setting process.umask() is
 * not supported in workers` inside a worker-thread test runner such as
 * Vitest's default pool, and is unnecessary besides: `mode & ~umask` can
 * only ever CLEAR bits from the requested `0o700`, never add any, so an
 * ordinary umask — which conventionally narrows group/other bits that
 * `0o700` does not request in the first place — leaves the result
 * unchanged). Every created component is still verified with `lstatSync`
 * immediately afterward and this throws (never silently `chmod`s) if the
 * resulting mode is not EXACTLY `0o700` — catching, rather than silently
 * tolerating, an unusual host umask that narrows even owner bits. Existing
 * ancestor components (e.g. the repo root, or `/tmp`) are left
 * untouched — this only tightens components it creates itself.
 */
export function mkdirOwnerOnlySync(dirPath) {
  const resolved = path.resolve(dirPath);
  const segments = resolved.split(path.sep).filter(Boolean);
  let current = path.isAbsolute(resolved) ? path.sep : '';
  for (const segment of segments) {
    current = current === path.sep ? path.join(current, segment) : (current ? path.join(current, segment) : segment);
    if (existsSync(current)) {
      const existingStat = lstatSync(current);
      if (!existingStat.isDirectory()) {
        throw new Error(`refusing to use ${current} as a directory: it already exists and is not a directory`);
      }
      continue; // pre-existing ancestor: leave its permissions as found.
    }
    mkdirSync(current, { mode: 0o700 });
    const created = lstatSync(current);
    const createdMode = created.mode & 0o777;
    if (createdMode !== 0o700) {
      throw new Error(`refusing ${current}: expected mode 0700 immediately after creation, got ${createdMode.toString(8)} (never widened via chmod-after-the-fact)`);
    }
  }
  return resolved;
}

/**
 * Back-compat alias kept for any external caller still naming the old
 * "mkdir then chmod" step; now routes through the exposure-window-free
 * `mkdirOwnerOnlySync`. Prefer `mkdirOwnerOnlySync` directly in new code.
 */
export function forceOwnerOnlyDir(dirPath) {
  if (existsSync(dirPath)) {
    const stat = lstatSync(dirPath);
    if (!stat.isDirectory()) throw new Error(`refusing to use ${dirPath} as a directory: it already exists and is not a directory`);
    return dirPath;
  }
  return mkdirOwnerOnlySync(dirPath);
}

function runGit(args, { cwd, spawn = spawnSync, timeoutMs = 30000 } = {}) {
  const result = spawn('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs });
  if (result.error) throw new Error(`git ${args.join(' ')} failed to run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${String(result.stderr ?? '').trim()}`);
  }
  return String(result.stdout ?? '').trim();
}

/**
 * Resolve `revision` to an exact, immutable base digest (full commit SHA).
 * Never pass a moving ref (branch name, `HEAD`) onward as the recorded
 * base — resolve it here first so the brief's `workspace.baseRevision`
 * (schemas/mission-v1.schema.json `$defs/workerDirectBrief`) is a digest,
 * not a pointer that can move after the worktree is created.
 */
export function resolveBaseDigest({ repoRoot, revision = 'HEAD', spawn = spawnSync, timeoutMs = 30000 } = {}) {
  const digest = runGit(['rev-parse', '--verify', `${revision}^{commit}`], { cwd: repoRoot, spawn, timeoutMs });
  if (!/^[a-f0-9]{40}$/i.test(digest)) {
    throw new Error(`git rev-parse did not return a commit SHA for ${revision}: ${digest}`);
  }
  return digest;
}

/**
 * Create a unique writer worktree at an exact base digest, after claiming
 * ownership of the requested files/ports. Fails closed: a claim conflict
 * or a failing `git worktree add` leaves no worktree behind and (on the
 * git-failure path) releases the claim it just took, so a failed
 * preparation never leaks ownership of files/ports nobody can use.
 *
 * @param {object} options
 * @param {string} options.repoRoot - Absolute path to the repository the worktree is cut from.
 * @param {string} options.ownerId - Conductor-local id for this writer attempt (unique per attempt).
 * @param {string} options.name - Human-readable worktree label (used in the directory name only).
 * @param {string} [options.revision='HEAD'] - Revision to resolve into an exact base digest.
 * @param {{files?: string[], ports?: number[]}} [options.claims] - Ownership claims to hold for this writer (files must be absolute paths).
 * @param {WorktreeClaimRegistry} options.registry - Shared claim registry for this conductor run.
 * @param {string} [options.worktreesRoot] - Parent directory for writer worktrees (defaults under `.aiwg/working/worktrees`).
 * @param {boolean} [options.deployContext=true] - Deploy AIWG context for the configured providers into the new worktree (Tier 0 default on, #3685).
 * @param {string[]|null} [options.contextProviders=null] - Explicit provider ids, or null to resolve the union of
 *   config providers and orchestration CLIs via `readAiwgConfig` (round 2; never ad-hoc JSON).
 * @param {string} [options.aiwgBin='aiwg'] - Binary for the default single-pass deploy.
 * @param {(opts: object) => object} [options.deployContextFn] - Injectable single-pass deploy (defaults to `defaultDeployWorkerContext`).
 * @param {(opts: object) => object} [options.verifyContextFn] - Injectable rule-section verifier (defaults to `verifyWorkerContextSections`).
 * @param {(cmd: string, args: string[], opts: object) => object} [options.spawn=spawnSync]
 * @param {(repoRoot: string) => Promise<object|null>} [options.contextReadConfig] - Injectable config loader (defaults to `readAiwgConfig`).
 * @param {(config: object) => object} [options.contextResolveFromConfig] - Injectable union resolver (defaults to the src-side pure function).
 * @returns {Promise<{created: boolean, blocked?: boolean, conflicts?: Array, path?: string, baseDigest?: string, context?: object, excludedLocalOnlyPaths?: string[]}>}
 */
export async function prepareWorkerWorktree({
  repoRoot,
  ownerId,
  name = 'writer',
  revision = 'HEAD',
  claims = {},
  registry,
  worktreesRoot,
  deployContext = true,
  contextProviders = null,
  aiwgBin = 'aiwg',
  deployContextFn = null,
  verifyContextFn = null,
  contextReadConfig = null,
  contextResolveFromConfig = null,
  spawn = spawnSync,
  timeoutMs = 30000,
} = {}) {
  if (!registry || typeof registry.claim !== 'function') {
    throw new Error('prepareWorkerWorktree requires a WorktreeClaimRegistry');
  }
  // Resolve the base digest before claiming anything: an unresolvable
  // revision should never hold a claim even transiently.
  const baseDigest = resolveBaseDigest({ repoRoot, revision, spawn, timeoutMs });
  const grant = registry.claim(ownerId, claims);
  if (!grant.granted) {
    return { created: false, blocked: true, conflicts: grant.conflicts };
  }
  // Every failure from here on must release the claim it just took, so a
  // failed preparation never leaks ownership of files/ports nobody can use.
  try {
    const root = worktreesRoot ?? path.join(repoRoot, '.aiwg', 'working', 'worktrees');
    // M5: create (every newly-created component of) the worktrees-root at
    // mode 0700 from the moment it is created — never default-mode-then-
    // chmod — so there is no window where it is briefly wider than intended.
    mkdirOwnerOnlySync(root);
    const stem = `${name}-${ownerId}`.replace(/[^A-Za-z0-9_.-]/g, '-');
    const worktreePath = path.join(root, stem);
    if (existsSync(worktreePath)) {
      throw new Error(`worktree path already exists: ${worktreePath} (ownership not held twice for one path)`);
    }
    // M5: pre-create the worktree's own directory at mode 0700 (same
    // exposure-window-free helper) BEFORE `git worktree add` ever touches
    // it. `git worktree add` happily adopts a pre-existing EMPTY directory
    // without altering its mode (verified empirically), so the directory is
    // 0700 from its very first instant on disk instead of being created by
    // git at a default mode and chmod-ed afterward.
    mkdirOwnerOnlySync(worktreePath);
    runGit(['worktree', 'add', '--detach', worktreePath, baseDigest], { cwd: repoRoot, spawn, timeoutMs });
    const finalMode = statSync(worktreePath).mode & 0o777;
    if (finalMode !== 0o700) {
      throw new Error(`refusing worktree ${worktreePath}: expected mode 0700 after git worktree add, got ${finalMode.toString(8)}`);
    }
    try {
      const excludedLocalOnlyPaths = await excludeWorkerLocalOnlyPaths({ repoRoot, worktreePath, spawn, timeoutMs });
      // #3685: a fresh worktree contains only tracked files, so deployed
      // provider context (.codex/, .claude/, .muse/, .agents/, AGENTS.md rule
      // sections) is missing until the conductor deploys it. Default on for
      // Tier 0; pass deployContext:false only to test worktree mechanics.
      let context = { deployed: false, providers: [], skippedBridges: [] };
      if (deployContext) {
        // The union needs `readAiwgConfig` (async): an explicit list wins
        // verbatim, otherwise the config providers plus orchestration CLIs.
        // Deploying a guessed set would leave the worker with the wrong (or
        // no) context, so resolution failure throws before anything is made.
        const { providers } = await resolveWorkerContextProviders({
          repoRoot, providers: contextProviders,
          ...(contextReadConfig ? { readConfig: contextReadConfig } : {}),
          ...(contextResolveFromConfig ? { resolveFromConfig: contextResolveFromConfig } : {}),
        });
        const deploy = deployContextFn ?? defaultDeployWorkerContext;
        await deploy({ worktreePath, repoRoot, providers, aiwgBin, spawn, timeoutMs });
        // Keep the deploy's tracked-bridge edits out of the worker diff:
        // flag each deploy-dirtied tracked file skip-worktree (content
        // stays on disk for the worker; only git status/diff hides it).
        const dirtied = listDeployDirtiedBridges({ worktreePath, spawn, timeoutMs });
        if (dirtied.length > 0) {
          runGit(['update-index', '--skip-worktree', '--', ...dirtied], { cwd: worktreePath, spawn, timeoutMs });
        }
        const verify = verifyContextFn ?? verifyWorkerContextSections;
        verify({ worktreePath, providers });
        context = { deployed: true, providers, skippedBridges: dirtied };
      }
      return { created: true, path: worktreePath, baseDigest, ownerId, context, excludedLocalOnlyPaths };
    } catch (error) {
      // Policy, exclusion and context failures leave no worker tree or claim.
      try {
        runGit(['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot, spawn, timeoutMs });
      } catch { /* best-effort cleanup; report the preparation failure */ }
      throw error;
    }
  } catch (error) {
    registry.release(ownerId);
    throw error;
  }
}

/**
 * Release a writer's ownership claims. Dirty/failed work is retained by
 * default (08's retention rule: never force-delete unexplained dirty
 * work) — only release the registry bookkeeping. Pass `remove: true` only
 * after the caller has made and recorded an explicit disposition decision
 * (accepted-and-integrated, or explicitly discarded); that decision is a
 * workflow/operator concern this module does not make on its own.
 */
export function releaseWorkerWorktree({
  registry,
  ownerId,
  repoRoot,
  worktreePath,
  remove = false,
  spawn = spawnSync,
  timeoutMs = 30000,
} = {}) {
  if (!registry || typeof registry.release !== 'function') {
    throw new Error('releaseWorkerWorktree requires a WorktreeClaimRegistry');
  }
  registry.release(ownerId);
  if (!remove) return { removed: false, retained: true, path: worktreePath };
  runGit(['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot, spawn, timeoutMs });
  return { removed: true, retained: false, path: worktreePath };
}
