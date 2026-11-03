/**
 * AIWG MCP Worker-Invoke Bridge (#2892)
 *
 * MCP-only conductor: resolve and invoke a worker (run/status/cancel/reconcile_stopped/reset_recovery_scope)
 * WITHOUT any Mission/MC session, daemon, admission store, or activation
 * marker. Reuses, rather than reimplements, the existing Tier 0 primitives:
 *
 *   - #2887 resolveWorkerInvocation / prepareWorkerInvocation
 *     (src/serve/worker-invocation.ts, via the CLI's own loadWorkerInputs)
 *   - #2954 planDirectWorkerLaunch + launchIsolatedWorker
 *     (tools/ralph-external/session-launcher.mjs, lib/worker-isolation.mjs)
 *   - #2890 ProviderAdapter.parseWorkerFinal + assembleWorkerResult
 *     (tools/ralph-external/lib/provider-adapter.mjs, mission-protocol/codecs.ts)
 *
 * This bridge runs without a shell/CLI round trip or Mission/MC state. It is
 * intentionally conservative where the pipeline cannot yet produce a fully
 * attested identity: verification is always left `pending` here (never
 * self-accepted) — a separate verifier is required before a direct result is
 * treated as accepted, per the brief's "worker verification ... remains
 * required."
 *
 * ---------------------------------------------------------------------------
 * Hardening vs. the #2896 reference bridge review (this issue moves +
 * redesigns that bridge; see .aiwg/working/s1-scratch/brief-2892.md):
 *
 *   1. BLOCKER (arbitrary path read / config root choice): every path this
 *      tool accepts (`brief`, `workdir`, `final_output`) must resolve
 *      (realpath, no symlink escape) beneath the served project root the
 *      MCP server was started for. `project_dir` is NOT a client-facing
 *      field at all — there is exactly one root, fixed at toolset
 *      registration time, never per-request. Each path is additionally
 *      checked against the existing in-process repo-access semantics
 *      (`src/policy/repo-access.ts` `checkRepoAccess`) when a workspace
 *      manifest is configured. See `assertServedPath` / `resolveServedProjectRoot`.
 *   2. BLOCKER (client-settable degraded isolation): there is no
 *      `allow_degraded` (or similarly named) field in the tool's input
 *      schema. Degraded isolation is an operator opt-in read once from the
 *      server environment at registration time (`AIWG_MCP_WORKER_ALLOW_DEGRADED=1`)
 *      and is reported in every result (`execution.isolation`). See
 *      `resolveServerAllowDegraded`.
 *   3. MAJOR (unbounded registry / permanent lockout): `createInvocationRegistry`
 *      counts only LIVE (non-terminal) runs against `maxActive`; terminal
 *      entries are evicted by TTL and, independently, by an over-capacity
 *      oldest-terminal-first sweep. Capacity is therefore never exhausted by
 *      the accumulation of *completed* runs — only by concurrently *live* ones.
 *   4. Toolset wildcard: `workers` is registered under its own explicit
 *      opt-in toolset name and is excluded from `AIWG_MCP_TOOLSETS=all`
 *      (see `src/mcp/tools/subsystems.mjs`).
 *   5. Minor (leaking temp dirs on uncertain runs): the #2896 reference
 *      bridge wrote a scratch plan.json to hand an invocation to a spawned
 *      launcher subprocess over IPC, and had to remember to clean that
 *      directory up on every exit path including `uncertain` ones. This
 *      design calls `planDirectWorkerLaunch`/`resolveWorkerInvocation`
 *      in-process instead of through a relay subprocess, so there is no
 *      scratch plan directory. Shell stdin framing uses a private runtime
 *      file, removed on refusal or confirmed termination. Unused
 *      final_output reservations are also removed on pre-launch refusal.
 * ---------------------------------------------------------------------------
 *
 * Fix pass (.aiwg/working/s1-scratch/fix-2892-r1.md, round 1 — two
 * independent reviews, probe-confirmed):
 *
 *   B1. The served root used to be resolved LAZILY, on the first request
 *       (`resolveServedProjectRoot(options.projectRoot)` defaulted its
 *       argument to `process.cwd()` at CALL time, and the toolset was always
 *       registered regardless). Fixed: the root is resolved ONCE, eagerly,
 *       inside `registerWorkerInvokeToolset` itself, from the caller-supplied
 *       `options.projectRoot` only; `resolveServedProjectRoot` no longer has
 *       a `process.cwd()` default at all, and the toolset refuses to
 *       register (logs a diagnostic, returns without calling
 *       `server.registerTool`) when no explicit root is supplied. See
 *       `src/mcp/server.mjs` (resolves via `findProjectRoot()` before calling
 *       `registerOptInToolsets`) and `src/mcp/tools/subsystems.mjs`
 *       (`registerOptInToolsets` threads `options` through).
 *   B2. The `mcp` transport used to construct a bare SDK `StdioClientTransport`
 *       directly, bypassing the #2954 resource gate and `launchIsolatedWorker`
 *       entirely, AND the SDK always merges its own `getDefaultEnvironment()`
 *       (HOME/LOGNAME/PATH/SHELL/TERM/USER from the CONDUCTOR's own
 *       `process.env`) into whatever `env` is supplied — silently widening
 *       the qualified allowlist. Fixed: an MCP worker server process now
 *       goes through the exact same gate-then-launch pipeline as a shell
 *       worker (`planDirectWorkerLaunch` → `launchIsolatedWorker`), using the
 *       new `attached: true` mode (`--pipe --wait` under systemd-run; a live
 *       stdio pipe in degraded mode) so the conductor gets a real child
 *       process whose stdio IS the MCP transport — never the SDK's own
 *       spawn. See `ChildProcessTransport` / `defaultLaunchMcpWorkerProcess`.
 *   B3. `assertServedPath` used to return the REQUESTED (non-canonical) path
 *       after validating containment against the canonical ancestor — a
 *       TOCTOU gap between validation and use. Fixed: it now returns the
 *       canonical path (canonicalized existing ancestor + literal
 *       not-yet-existing tail). `workdir` must now be a strict subdirectory
 *       of the served root (never the root itself, never `.git`/`.aiwg`);
 *       `final_output` must resolve inside the validated `workdir` and is
 *       reserved via an exclusive (`O_CREAT|O_EXCL|O_NOFOLLOW`) create before
 *       any launch. `readBoundedFile` opens with `O_NOFOLLOW`, verifies
 *       `nlink === 1`/regular-file/size-bound via `fstat`, and re-verifies
 *       containment from the opened fd's own `/proc/self/fd/<n>` target
 *       (not the pre-open path string) before reading.
 *   M1. Admission used to check capacity/identity (reads) BEFORE
 *       `await validatedRequest(input)`, but only RESERVE them (the mutating
 *       `registry.create()`) AFTER that await — any number of concurrent
 *       `run` calls could pass the checks before any of them reserved.
 *       Fixed: `request_id` is required for `run`, and capacity+identity
 *       reservation (`registry.create()`) happens synchronously, with no
 *       `await` between the checks and the reservation — atomic with
 *       respect to any other concurrent `run()` invocation.
 *   M2. An unconfirmed ("uncertain") worker used to be marked TERMINAL
 *       (`markTerminal`), freeing its capacity reservation without any stop
 *       proof, and `cancel` only ever flipped a flag without delivering
 *       anything anywhere. Fixed: uncertain outcomes use `registry.update`
 *       (stays LIVE, capacity held) instead of `markTerminal`; `cancel`
 *       invokes a live `entry.control.stop()` handle registered by `run()`
 *       for the duration of the in-flight transport call (MCP: sends
 *       `notifications/cancelled` over the live client; shell: stops the
 *       isolated unit / kills the child) and only reports `cancelDelivered`
 *       when that actually succeeds. A later completion for a run whose
 *       `cancelRequested` flag is set is recorded as `cancelled`, never
 *       `completed`.
 *   M3. No live schema-drift check existed before sending a brief to an MCP
 *       worker tool. Fixed: on every connect, `defaultCallMcpWorker` lists
 *       tools and compares the live tool's input/output schema against the
 *       #2887 installation-owner-trusted schema object (`mcpSchemas`),
 *       canonically (`canonicalSchemaDigest`, sorted-key — robust to the
 *       SDK's own zod-validation round trip reordering keys without
 *       changing meaning); any mismatch (or the tool no longer being
 *       advertised at all) refuses before any brief is sent.
 *   M4. `seenRequestIds` (replay protection) was a plain `Map` that NEVER
 *       shrank. Fixed: `createInvocationRegistry` now sweeps it on the same
 *       cadence as the main registry (TTL + over-capacity oldest-first),
 *       restricted to request ids whose invocation entry has already left
 *       the main registry — a request id is never evicted while its
 *       invocation is still live, uncertain, or terminal-but-retained.
 *   M5. `tryAssembleDirectResult` re-read the brief at result time without
 *       ever comparing it to what was pinned at launch (`invocation.briefDigest`),
 *       and the `parseWorkerFinal` failure path forwarded the raw parser
 *       error message into client-visible diagnostics — a duplicate-key
 *       probe showed this can reflect attacker-controlled text straight
 *       back out. Fixed: the brief's digest is re-verified against the
 *       launch-time pin before assembling a result (mismatch →
 *       `OG_BRIEF_EVIDENCE_CONFLICT`, never silently assembled); diagnostics
 *       for a parse failure use the error's own bounded `.code` (a
 *       fixed-vocabulary `WorkerContractError`/`WorkerPolicyError` token)
 *       instead of `.message`.
 *   D1. The registry's default `maxActive` is now
 *       `min(DEFAULT_MAX_ACTIVE, resolveParallelism(config.parallelism).max_parallel_subagents)`
 *       (the existing project-wide parallelism resolver); the terminal TTL
 *       is operator-configurable via `AIWG_MCP_WORKER_TTL_MS`, falling back
 *       to the code default.
 *   D2. The per-`serverRef` MCP call queue (`'per-instance'`/`'serialized'`
 *       sessionIsolation) is now explicitly bounded (refuses rather than
 *       queuing unboundedly once `MAX_MCP_SERVER_QUEUE_DEPTH` calls are
 *       already waiting) and rechecks the server's registry qualification
 *       immediately before each queued launch, not just at admission time.
 * ---------------------------------------------------------------------------
 *
 * @issues #2892, #2896 (review reference, not reused as-is)
 */

import { workerFailureDiagnostics } from './worker-failure-diagnostics.mjs';
import { signalChild } from '../../process/signal-child.mjs';
import { z } from 'zod';

// Keep accepting existing UUID-shaped identifiers regardless of version bits.
const invocationUuid = () => z.string().check(ctx => {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(ctx.value)) {
    ctx.issues.push({ code: 'invalid_format', format: 'uuid', input: ctx.value, message: 'Invalid uuid' });
  }
}).meta({ format: 'uuid' });
import { createHash, randomUUID } from 'node:crypto';
import {
  realpath, readlink as fsReadlink, open as fsOpen, lstat, unlink,
} from 'node:fs/promises';
import { existsSync, readFileSync, constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mcpError, mcpJson } from '../helpers.mjs';
import { buildShellStopControl, waitForUnitTermination } from './worker-shell-control.mjs';
import { launchPreparedShellWorker, sweepWorkerStdin, markWorkerServer } from './worker-stdin-runtime.mjs';
// NOTE: no static import of ../../config/worker-context.js here. That
// module is TypeScript: a literal relative import resolves under vitest
// but throws ERR_MODULE_NOT_FOUND under raw node (e.g. `node
// src/mcp/cli.mjs`, which test/unit/mcp exercises directly). The
// request-time loader below resolves it through importImpl (dist when
// built, source otherwise), so merely loading this bridge never touches
// it. See tools/_resolve-impl.mjs (#3062).

const execFileAsync = promisify(execFile);

/**
 * Find the AIWG package root by walking up from THIS file's own location
 * (never from `AIWG_ROOT`/`process.cwd()`, which name the *served project*,
 * not necessarily where this module's own package lives). Depth-independent
 * on purpose: this file ships at `src/mcp/tools/worker-invoke.mjs` in a dev
 * checkout and at `dist/src/mcp/tools/worker-invoke.mjs` in the published
 * package — a fixed-depth relative specifier into `tools/` (which ships
 * unchanged at the package root in both cases) would be correct in one and
 * wrong in the other. Mirrors `tools/_resolve-impl.mjs`'s own `findPackageRoot`.
 */
function findOwnPackageRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'aiwg' || pkg.name === '@aiwg/cli') return dir;
      } catch { /* keep walking */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate the AIWG package root from worker-invoke.mjs');
}

async function importImpl(relativeFromSrc) {
  const root = findOwnPackageRoot();
  const { importImpl: delegate } = await import(pathToFileURL(path.join(root, 'tools/_resolve-impl.mjs')).href);
  return delegate(import.meta.url, relativeFromSrc);
}

export const WORKERS_TOOLSET_NAME = 'workers';
export const DEFAULT_MAX_ACTIVE = 8;
export const DEFAULT_MAX_RETAINED = 128;
export const DEFAULT_TERMINAL_TTL_MS = 10 * 60 * 1000;
/** #2892 D2: bound on how many calls may wait behind one 'per-instance'/
 * 'serialized' MCP server's queue before new ones are refused outright. */
export const MAX_MCP_SERVER_QUEUE_DEPTH = 32;
/** #2892 B2: `launchIsolatedWorker`'s systemd-unit path requires a positive
 * `memoryMaxGb` ceiling even for an attached (`--pipe --wait`) launch — the
 * MCP worker SERVER process is a separate resource-confined unit from the
 * conductor, and no project-level config currently supplies a per-worker
 * ceiling for it. Shell workers use this fallback in systemd mode only.
 * Operator-overridable via `registerWorkerInvokeToolset`'s
 * `mcpWorkerMemoryMaxGb` option; this is the fallback. */
export const DEFAULT_MCP_WORKER_MEMORY_MAX_GB = 2;
/** Raw per-frame budget, including malformed/unterminated frames. */
export const MAX_MCP_FRAME_BYTES = 10 * 1024 * 1024;
/** #2892 B3: a worker's `workdir` may never be the conductor-managed control
 * plane or VCS metadata directory, even as a strict subdirectory name. */
const RESERVED_WORKDIR_NAMES = new Set(['.git', '.aiwg']);

// ===========================================================================
// Defect 2: degraded isolation is a server-side-only operator opt-in.
// ===========================================================================

/** Read once at registration time, from the server's own environment — never
 * from a request. There is no `allow_degraded` field on the tool schema. */
export function resolveServerAllowDegraded(env = process.env) {
  const raw = env.AIWG_MCP_WORKER_ALLOW_DEGRADED;
  return raw === '1' || raw === 'true';
}

/** #2892 D1: terminal-entry TTL is operator-configurable (server env, read
 * once at registration — same posture as `resolveServerAllowDegraded`), code
 * default as fallback. */
export function resolveServerTerminalTtlMs(env = process.env) {
  const raw = Number(env.AIWG_MCP_WORKER_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TERMINAL_TTL_MS;
}

// ===========================================================================
// Defect 1 / B1: path containment beneath the served project root, pinned
// once at registration time — never re-resolved from `process.cwd()`.
// ===========================================================================

/** Canonicalize an EXPLICIT served-root candidate. Throws if it does not
 * exist, or if no candidate is given at all (#2892 B1: there is no implicit
 * `process.cwd()` fallback here — a caller with no explicit root must not
 * call this at all; see `registerWorkerInvokeToolset`'s own refusal path). */
export async function resolveServedProjectRoot(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error('resolveServedProjectRoot requires an explicit root; it never falls back to process.cwd()');
  }
  return realpath(path.resolve(candidate));
}

/**
 * Walk up to the nearest existing ancestor, requiring every already-existing
 * segment to be free of symlinks (mirrors #2887's own `inspectPath`), then
 * require that ancestor's canonical path to sit inside `servedRootReal`.
 * A target that does not exist yet (e.g. `final_output`) is allowed as long
 * as its nearest existing ancestor directory is contained and symlink-free;
 * `resolveWorkerInvocation` independently re-validates the target itself.
 *
 * #2892 B3: returns the CANONICAL path (the canonicalized existing ancestor
 * joined with whatever tail segments do not exist yet — those cannot be
 * symlinks, they do not exist, but are preserved literally), not the
 * caller-supplied string. The previous version validated containment against
 * the canonical ancestor but then returned `path.resolve(candidatePath)` —
 * the requested, non-canonical path — leaving a TOCTOU gap between this
 * check and whatever later opens that same path.
 */
async function assertServedPath(servedRootReal, candidatePath, label) {
  if (typeof candidatePath !== 'string' || !path.isAbsolute(candidatePath) || candidatePath.includes('\0')) {
    throw new Error(`${label} must be an absolute, NUL-free path`);
  }
  const target = path.resolve(candidatePath);
  let current = target;
  while (true) {
    try {
      const canonical = await realpath(current);
      if (canonical !== current) throw new Error(`${label} resolves through a symlink`);
      const rel = path.relative(servedRootReal, canonical);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new Error(`${label} escapes the served project root`);
      }
      const tail = path.relative(current, target);
      return tail === '' ? canonical : path.join(canonical, tail);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`${label} has no resolvable ancestor beneath the served root`);
      current = parent;
    }
  }
}

/** #2892 F1: the default location for conductor-prepared writer worktrees
 * — identical to #2889's own `prepareWorkerWorktree` default
 * (`tools/ralph-external/lib/worktree-preparation.mjs`), so an operator who
 * never overrides either stays consistent between the two. */
const DEFAULT_WORKER_WORKTREES_SUBDIR = ['.aiwg', 'working', 'worktrees'];

/** #2892 F1: resolve the conductor worktrees root ONCE, at registration —
 * same posture as the served root itself (B1). An operator may point it
 * elsewhere via `registerWorkerInvokeToolset`'s `workerWorktreesRoot`
 * option; otherwise it defaults to `<servedRoot>/.aiwg/working/worktrees`.
 * Canonicalized via realpath when the directory already exists (so a
 * symlinked worktrees root cannot be used to smuggle a workdir in from
 * outside it); a not-yet-created root resolves to its literal path —
 * nothing can be "nested under" a directory that does not exist yet, so an
 * unresolvable root never over-grants, it only ever under-grants. */
async function resolveWorkerWorktreesRoot(servedRootReal, candidate) {
  const resolved = candidate !== undefined ? path.resolve(candidate) : path.join(servedRootReal, ...DEFAULT_WORKER_WORKTREES_SUBDIR);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

/** #2892 F1: list the served repository's own registered git worktrees
 * (absolute, canonical paths), via `git worktree list --porcelain` run
 * with a SANITIZED environment (only `PATH`/`HOME`; never the conductor's
 * own `GIT_*` overrides, credential helpers, or pager settings) and
 * `-c core.fsmonitor=false -c core.hooksPath=/dev/null`, so merely
 * answering this read-only query can never execute a repo-local hook or
 * fsmonitor helper. Never throws: a worktree-less served root (no `.git`
 * at all, or `git` itself unavailable) simply has no registered worktrees
 * — the caller falls back to the `workerWorktreesRoot` check instead. */
async function defaultListGitWorktrees(servedRootReal) {
  try {
    const { stdout } = await execFileAsync('git', [
      '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
      '-C', servedRootReal, 'worktree', 'list', '--porcelain',
    ], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      timeout: 10000, maxBuffer: 1024 * 1024,
    });
    const entries = stdout.split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).trim());
    const canonical = await Promise.all(entries.map(entry => realpath(entry).catch(() => null)));
    return canonical.filter(Boolean);
  } catch {
    return [];
  }
}

/** #2892 F1 (fix-2892-r2, formerly B3): `workdir` must be a strict
 * subdirectory of the served root AND a conductor-prepared git worktree —
 * never an ordinary in-repo subdirectory, even one that is otherwise
 * strict, symlink-free, and correctly contained. The round-1 fix only
 * enforced containment (not the root itself, not `.git`/`.aiwg`); a probe
 * showed any ordinary strict subdirectory such as `src/` was still
 * accepted. Fixed: `workdir` is accepted only when EITHER (a) it is itself
 * one of the served repository's own registered git worktrees (verified
 * via `git worktree list` / `.git/worktrees` metadata — real git state a
 * caller cannot forge merely by `mkdir`ing a directory), OR (b) it is
 * nested under the explicitly configured (or defaulted)
 * `workerWorktreesRoot` — the same directory #2889's own
 * `prepareWorkerWorktree` already treats as exclusively conductor-managed.
 * `.git`/`.aiwg` remain reserved (never acceptable as a bare workdir)
 * whenever neither acceptance path applies. */
async function assertWorkdirIsConductorWorktree(servedRootReal, workdirCanonical, { worktreesRoot, listWorktrees = defaultListGitWorktrees } = {}) {
  const rel = path.relative(servedRootReal, workdirCanonical);
  if (rel === '') {
    throw new Error('workdir must be a strict subdirectory of the served project root, not the root itself');
  }
  const registered = await listWorktrees(servedRootReal);
  if (registered.includes(workdirCanonical)) return;
  if (worktreesRoot) {
    const underRoot = path.relative(worktreesRoot, workdirCanonical);
    if (underRoot !== '..' && !underRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(underRoot)) return;
  }
  const [first] = rel.split(path.sep);
  if (RESERVED_WORKDIR_NAMES.has(first)) {
    throw new Error(`workdir must not be inside the reserved '${first}' directory`);
  }
  throw new Error('workdir must be a conductor-prepared git worktree (registered via git worktree, or nested under the configured worker worktrees root), not an ordinary subdirectory');
}

/** #2892 B3: `final_output` must resolve inside the already-scoped `workdir`
 * — not merely somewhere under the served root — so a worker's own claimed
 * output always lands in its own conductor-prepared worktree. */
function assertWithinWorkdir(workdirCanonical, candidateCanonical) {
  const rel = path.relative(workdirCanonical, candidateCanonical);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('final_output must resolve inside workdir');
  }
}

/** #2892 B3: claim `final_output` before any launch via an exclusive create
 * (`O_CREAT|O_EXCL|O_NOFOLLOW`) — refuses if anything (file, symlink, or
 * directory) already sits at that exact path, closing the TOCTOU window
 * between path validation and whatever later writes the worker's result
 * there. The worker's own later `O_TRUNC` write reuses this same inode. */
async function reserveFinalOutput(finalOutputPath) {
  const handle = await fsOpen(finalOutputPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try { return await handle.stat(); } finally { await handle.close(); }
}

/** Defense in depth, on top of the hard root check above: when the project
 * participates in a multi-repo workspace manifest, the path must also be
 * allowed there. Single-project deployments (no workspace manifest) have
 * nothing to consult and rely on the hard root boundary alone. */
async function assertRepoAccessAllowed(servedRoot, candidatePath, action, repoAccess) {
  const manifestPath = repoAccess.findRepoAccessManifest(servedRoot);
  if (!manifestPath) return;
  const manifest = repoAccess.loadRepoAccessManifest(servedRoot);
  const decision = repoAccess.checkRepoAccess(manifest, candidatePath, action, servedRoot);
  if (!decision.allowed) {
    throw new Error(`repo-access denies ${action} for this path: ${decision.reason}`);
  }
}

// ===========================================================================
// Defect 3 / M4: TTL + live-only bounded invocation registry, with a
// matching bound on replay-protection memory.
// ===========================================================================

/**
 * Terminal entries are pruned by TTL and, independently, by an
 * over-`maxRetained` oldest-terminal-first sweep. `maxActive` is checked
 * against LIVE entries only, so no accumulation of completed runs can ever
 * lock out a new one — only concurrently *live* work can (an "uncertain" run
 * — #2892 M2 — is LIVE, by design, until something proves it stopped).
 *
 * `seenRequestIds` (M4) tracks `{ invocationId, recordedAt }` and is swept on
 * the same cadence, but only ever evicts a request id once its invocation
 * entry has ALREADY left `entries` (pruned away) — replay protection for any
 * live, uncertain, or still-retained-terminal invocation is never weakened
 * by this sweep, only the unbounded-growth tail is.
 */
export function createInvocationRegistry({
  maxActive = DEFAULT_MAX_ACTIVE,
  maxRetained = DEFAULT_MAX_RETAINED,
  ttlMs = DEFAULT_TERMINAL_TTL_MS,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();
  const seenRequestIds = new Map(); // request_id -> { invocationId, recordedAt }

  // Pin one bounded breaker owner for this registry's lifetime. Replacing
  // it could accumulate protected entries across independently capped owners
  // and orphan the original reconciliation mapping.
  let recoveryOwner;
  function bindRecoveryOwner(breaker) {
    if (!breaker) return;
    if (recoveryOwner && recoveryOwner !== breaker) {
      throw new Error('Invocation registry already has a recovery breaker owner; reuse that owner and reconcile_stopped for unresolved reservations');
    }
    recoveryOwner = breaker;
  }
  // Unresolved entries and their replay identities survive ordinary pruning.
  // Their aggregate bound is the single owner's reservation cap.
  function hasUnresolvedStopMarker(entry) {
    return typeof entry.recoveryBreaker?.hasUnresolvedStop === 'function'
      && entry.recoveryBreaker.hasUnresolvedStop(entry.invocationId);
  }
  function terminalEntries() {
    return [...entries.values()].filter(entry => entry.terminalAt !== null && !hasUnresolvedStopMarker(entry))
      .sort((a, b) => a.terminalAt - b.terminalAt);
  }
  function pruneSeenRequestIds() {
    const cutoff = now() - ttlMs;
    // Only a request id whose invocation has already left `entries` is even
    // a candidate for eviction — live/uncertain/retained-terminal replay
    // protection is never weakened by this sweep.
    const candidates = [...seenRequestIds.entries()]
      .filter(([, v]) => !entries.has(v.invocationId))
      .sort((a, b) => a[1].recordedAt - b[1].recordedAt);
    for (const [requestId, v] of candidates) {
      if (v.recordedAt <= cutoff) seenRequestIds.delete(requestId);
    }
    let over = seenRequestIds.size - maxRetained;
    if (over > 0) {
      for (const [requestId] of candidates) {
        if (over <= 0) break;
        if (seenRequestIds.delete(requestId)) over -= 1;
      }
    }
  }
  function prune() {
    const cutoff = now() - ttlMs;
    for (const entry of terminalEntries()) if (entry.terminalAt <= cutoff) entries.delete(entry.invocationId);
    let over = entries.size - maxRetained;
    if (over > 0) for (const entry of terminalEntries()) {
      if (over <= 0) break;
      entries.delete(entry.invocationId);
      over -= 1;
    }
    pruneSeenRequestIds();
  }
  function liveCount() {
    return [...entries.values()].filter(entry => entry.terminalAt === null).length;
  }
  return {
    prune,
    liveCount,
    bindRecoveryOwner,
    get recoveryOwner() { return recoveryOwner; },
    get size() { return entries.size; },
    /** Test/diagnostic only — not consulted by any admission decision. */
    get seenCount() { return seenRequestIds.size; },
    canStart() { prune(); return liveCount() < maxActive; },
    /** Never replay the same request_id, terminal or not (#2896 defect: "never blind replay"). */
    claimRequestId(requestId) {
      prune();
      return seenRequestIds.get(requestId)?.invocationId ?? null;
    },
    create(partial) {
      bindRecoveryOwner(partial.recoveryBreaker);
      prune();
      const invocationId = partial.invocationId ?? randomUUID();
      const entry = { invocationId, terminalAt: null, createdAt: now(), ...partial, invocationId };
      entries.set(invocationId, entry);
      if (partial.requestId) seenRequestIds.set(partial.requestId, { invocationId, recordedAt: now() });
      return entry;
    },
    get(invocationId) { prune(); return entries.get(invocationId); },
    update(invocationId, patch) {
      const entry = entries.get(invocationId);
      if (!entry) return undefined;
      bindRecoveryOwner(patch.recoveryBreaker);
      Object.assign(entry, patch);
      return entry;
    },
    markTerminal(invocationId, patch = {}) {
      const entry = entries.get(invocationId);
      if (!entry) return undefined;
      bindRecoveryOwner(patch.recoveryBreaker);
      if (entry.terminalAt === null) entry.terminalAt = now();
      Object.assign(entry, patch);
      // An entry becomes eligible for over-capacity eviction the moment it
      // turns terminal; prune immediately rather than waiting for the next
      // unrelated registry call (otherwise a long idle period after the last
      // run leaves the registry transiently over `maxRetained`).
      prune();
      return entry;
    },
    values() { prune(); return [...entries.values()]; },
  };
}

// ===========================================================================
// Reuse wiring — load TS-authored contract modules through the repo's own
// src/dist-aware resolver (tools/_resolve-impl.mjs), exactly as the Ralph
// provider adapter does for the same reason: this file ships unchanged at
// `(dist/)src/mcp/tools/worker-invoke.mjs` in both dev and the published
// package, so a bare relative `.js` specifier into `src/serve/...ts` would
// only resolve once `dist/src/...` has been built.
// ===========================================================================

async function loadServeWorkerInvocation() {
  return importImpl('serve/worker-invocation.js');
}
async function loadModelsHandlerInternals() {
  return importImpl('cli/handlers/models.js');
}
async function loadMissionProtocol() {
  return importImpl('mission-protocol/index.js');
}
async function loadRepoAccessModule() {
  return importImpl('policy/repo-access.js');
}
async function loadAiwgConfigModule() {
  return importImpl('config/aiwg-config.js');
}

/** `tools/` ships unchanged at the package root in both dev and the
 * published package (unlike `src/`, which only ships as `dist/src/`), so an
 * AIWG_ROOT-absolute path is the robust way in rather than a relative
 * specifier (whose depth from this file differs between `src/mcp/tools/`
 * and `dist/src/mcp/tools/`). */
// #2915 final (step 3): the former `resolveRunRecovery` + per-site
// `canLaunch`/`noteLaunched`/`recordDirectWorkerOutcome` triple is replaced
// by `run()`'s own single `admitDirectWorker`/`settleDirectWorker` pair
// (session-launcher.mjs), which `defaultLaunchShellWorker` below BORROWS
// rather than re-resolving — deleting the duplicate gate that previously
// rejected its own already-admitted canary (#2915 final review, finding 4).

async function loadRalphExternal(relativeFromToolsRoot) {
  const absolute = path.join(findOwnPackageRoot(), 'tools/ralph-external', relativeFromToolsRoot);
  return import(pathToFileURL(absolute).href);
}

/** The CLI's own default loader (`ModelsWorkerServices.load`), reused
 * in-process instead of shelling out to `aiwg models resolve`. */
async function defaultLoadWorkerInputs(servedRoot) {
  const { loadWorkerInputs } = await loadModelsHandlerInternals();
  return loadWorkerInputs({ cwd: servedRoot, args: ['resolve'], rawArgs: ['models', 'resolve'], frameworkRoot: findOwnPackageRoot() });
}

/** #2892 D1: the registry's default `maxActive` respects the project's own
 * parallelism policy (`.aiwg/aiwg.config` `parallelism.max_parallel_subagents`,
 * via the existing `resolveParallelism` resolver) — never more than the code
 * default, possibly fewer. Best-effort: any failure (no config, malformed
 * config, resolver error) falls back to `DEFAULT_MAX_ACTIVE` rather than
 * blocking registration. */
async function resolveDefaultMaxActive(servedRootReal) {
  try {
    const { readAiwgConfig, resolveParallelism, emptyConfig } = await loadAiwgConfigModule();
    const config = (await readAiwgConfig(servedRootReal)) ?? emptyConfig();
    const resolved = resolveParallelism(config.parallelism);
    const fromConfig = resolved?.max_parallel_subagents;
    return Number.isFinite(fromConfig) && fromConfig > 0 ? Math.min(DEFAULT_MAX_ACTIVE, fromConfig) : DEFAULT_MAX_ACTIVE;
  } catch {
    return DEFAULT_MAX_ACTIVE;
  }
}

// ===========================================================================
// Launch — shell transport reuses #2954's gate-then-launch composition.
// ===========================================================================

/** `planDirectWorkerLaunch` returns a blocked gate as `{ failures, gate }`
 * only — it never sets `diagnostic` (that field is reserved for the
 * degraded-isolation-unavailable case; see `worker-isolation.mjs`). Name
 * the specific failing signal(s) here so a dispatch-gate refusal is
 * distinguishable from every other blocked-launch reason in this bridge's
 * own diagnostics, instead of collapsing to one generic string. */
function describeGateFailures(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return undefined;
  return `worker dispatch gate blocked: ${failures.map(f => `${f.signal} (${f.reason})`).join('; ')}`;
}

/** Request-time loader for the TypeScript worker-context module (see the
 * import note above): resolved through importImpl so production uses the
 * compiled `dist` tree while a checkout falls back to source. Cached for
 * the process lifetime; only request paths that actually ensure worker
 * context ever trigger the load. */
let cachedWorkerContextModule = null;
async function loadWorkerContextModule() {
  if (!cachedWorkerContextModule) cachedWorkerContextModule = await importImpl('config/worker-context.js');
  return cachedWorkerContextModule;
}

/** Map the worker CLI to its provider and ensure its bootstrap is present
 * in the worker workdir (#3685 round 2). Deploys the resolved union set
 * (config providers plus orchestration CLIs) in one pass when the worker
 * provider's bootstrap is missing; an unmappable CLI refuses with the
 * typed diagnostic, since no deploy could target it. */
async function ensureWorkerContextForInvocation({ invocation, config }) {
  const { ensureWorkerContextBootstrap, mapCliToProviderId, resolveWorkerContextProvidersFromConfig, WorkerContextBootstrapError } =
    await loadWorkerContextModule();
  const cli = invocation?.selected?.cli;
  const mapped = mapCliToProviderId(cli, config?.parallelism);
  if (!('provider' in mapped) || !mapped.provider) {
    throw new WorkerContextBootstrapError(
      `cannot ensure worker context: CLI '${cli}' maps to no AIWG provider (${mapped.skipped ?? 'unmapped'})`,
      `configure parallelism.clis.${cli} with a providers:<id> adapter, or dispatch a CLI whose adapter maps to a known provider`,
      { workdir: invocation?.cwd },
    );
  }
  let providers = [mapped.provider];
  try {
    providers = [...new Set([...resolveWorkerContextProvidersFromConfig(config).providers, mapped.provider])];
  } catch {
    providers = [mapped.provider];
  }
  return ensureWorkerContextBootstrap({ workdir: invocation?.cwd, provider: mapped.provider, providers });
}

/** Refuse a failed bootstrap ensure as a typed blocked diagnostic that
 * names the remedy — never a bare string the operator cannot act on.
 * `code`/`remedy`/`provider`/`workdir` survive on any error object that
 * carries them (the tools-side ensure throws a duck-typed refusal, not
 * necessarily this module's class instance); only genuinely bare failures
 * fall back to the generic code and remedy. */
function toWorkerContextDiagnostic(error) {
  const fields = (error !== null && typeof error === 'object') ? error : {};
  // Duck-typed on purpose: the worker-context module loads lazily (see
  // above), so no class identity is available at module scope. Every
  // refusal path sets `code`/`remedy` on the thrown object instead.
  const code = (typeof fields.code === 'string' && fields.code ? fields.code : 'OG_WORKER_CONTEXT_UNAVAILABLE');
  const remedy = (typeof fields.remedy === 'string' && fields.remedy ? fields.remedy
    : 'ensure the worker CLI maps to a known AIWG provider and the aiwg CLI is installed (AIWG_BIN), then retry the run');
  return { code,
    message: error instanceof Error ? error.message : String(error?.message ?? error),
    remedy,
    ...(fields.provider !== undefined ? { provider: fields.provider } : {}),
    ...(fields.workdir !== undefined ? { workdir: fields.workdir } : {}) };
}

// Audited observer; refresh the historical baseline graph after rebase.
const waitForUnitTerminationBaseline = waitForUnitTermination;
export { waitForUnitTerminationBaseline as __testOnlyWaitForUnitTerminationBaseline };

// Recovery-disabled dispatch uses the audited preparation path and direct
// gate/isolation primitives, without entering the current planner's admission.
// The historical baseline pin/fixture graph must be refreshed after rebase.
async function defaultLaunchShellWorkerBaseline(invocation, { memoryMaxGb = DEFAULT_MCP_WORKER_MEMORY_MAX_GB, ...options }) {
  const loadBaselineLaunch = async relative => {
    if (relative !== 'session-launcher.mjs') return loadRalphExternal(relative);
    const { checkWorkerDispatch, launchIsolatedWorker } = await loadRalphExternal('lib/worker-isolation.mjs');
    return {
      planDirectWorkerLaunch: ({ invocation, live, readers, thresholdOverlay, ...launchOptions }) => {
        // Shared preparation must provide the conductor-framed params file;
        // never send the raw brief or launch without it for brief-json.
        if (invocation?.stdin === 'brief-json' && launchOptions.stdinPath === undefined) {
          throw new Error('brief-json stdin requires an explicit conductor-framed params file (stdinPath)');
        }
        const cwd = invocation?.cwd;
        const gate = checkWorkerDispatch({ config: launchOptions.config, live, readers, thresholdOverlay,
          paths: typeof cwd === 'string' && cwd ? [cwd] : undefined });
        if (!gate.ok) return { launched: false, blocked: true, failures: gate.failures ?? [],
          diagnostic: describeGateFailures(gate.failures) };
        return launchIsolatedWorker({
          command: invocation?.argv?.[0], args: invocation?.argv?.slice(1) ?? [], cwd,
          stdoutPath: invocation?.stdoutPath, stderrPath: invocation?.stderrPath, envNames: invocation?.envNames,
          ...launchOptions, gate,
        });
      },
    };
  };
  return launchPreparedShellWorker(invocation, { ...options, memoryMaxGb },
    { loadRalphExternal: loadBaselineLaunch, readBoundedFile, importImpl, describeGateFailures });
}

async function defaultLaunchShellWorker(invocation, { memoryMaxGb = DEFAULT_MCP_WORKER_MEMORY_MAX_GB, ...options }) {
  if (options.admission === undefined) {
    return defaultLaunchShellWorkerBaseline(invocation, { ...options, memoryMaxGb });
  }
  return launchPreparedShellWorker(invocation, { ...options, memoryMaxGb },
    { loadRalphExternal, readBoundedFile, importImpl, describeGateFailures });
}

// ===========================================================================
// Launch — mcp transport (#2892 B2). The MCP worker SERVER process is
// launched through the SAME gate-then-launch pipeline as a shell worker
// (`planDirectWorkerLaunch` → `launchIsolatedWorker`, `attached: true`), and
// the MCP client speaks to it over the launched child's own stdio via
// `ChildProcessTransport` — never the SDK's `StdioClientTransport`, which
// spawns its own child and always merges `getDefaultEnvironment()`
// (HOME/LOGNAME/PATH/SHELL/TERM/USER from the CONDUCTOR's process.env) into
// whatever `env` is given, silently widening the qualified allowlist.
//
// `sessionIsolation: 'per-call'` opens a fresh connection per call; anything
// else ('per-instance'/'serialized') is additionally serialized through a
// bounded per-serverRef queue (#2892 D2) so no two concurrent calls ever
// share one live connection, and each queued call rechecks the server's own
// registry qualification immediately before ITS launch, not just at the
// time it was enqueued.
// ===========================================================================

/**
 * A minimal MCP `Transport` over an already-spawned child process's own
 * stdio, for a child launched by `launchIsolatedWorker({ attached: true })`.
 * Mirrors the SDK's own `StdioClientTransport` framing (newline-delimited
 * JSON-RPC via `ReadBuffer`/`serializeMessage`) but never spawns anything
 * itself and never touches environment variables — the child already exists,
 * already resource-confined, already running with exactly its allowlisted
 * environment.
 */
const MCP_TRANSPORT_MAX_BUFFER_BYTES = MAX_MCP_FRAME_BYTES;

export class ChildProcessTransport {
  constructor(child, { terminate = () => signalChild(child, 'SIGKILL'),
    deadlineAtMs = null, now = () => Date.now(), isCancelled } = {}) {
    this._child = child;
    this._terminate = terminate;
    this._failure = undefined;
    this._closed = false;
    this._deadlineAtMs = deadlineAtMs;
    this._now = now;
    // #2915 round 8 review 8 (C3): optional cancellation predicate, checked
    // at the write boundary alongside the deadline — `undefined` whenever
    // this call is not gated, matching origin/main's own unbounded
    // transport exactly (see `send()` below).
    this._isCancelled = typeof isCancelled === 'function' ? isCancelled : undefined;
    this.onmessage = undefined;
    this.onerror = undefined;
    this.onclose = undefined;
    // #2892 F2 (fix-2892-r2): the SDK's own `Client.callTool()`/`request()`
    // generates its JSON-RPC request id internally and never returns it to
    // the caller — the only place that real id is ever actually observable
    // is here, at the transport, the instant the framed request is handed
    // off to be written. A `notifications/cancelled` sent with any other
    // value (the caller's own opaque `mcpBinding.requestId`, which has no
    // relationship whatsoever to the wire protocol) means nothing to a
    // worker trying to honor it.
    this.lastRequestId = null;
    // #2892 F3 (fix-2892-r2): the raw (plain `JSON.parse`-only, never
    // zod-round-tripped) response body for each inbound message that has an
    // `id`, keyed by that id. The SDK's own `ToolSchema`/`ListToolsResultSchema`
    // zod validation reconstructs `inputSchema.properties`/
    // `outputSchema.properties` via `z.record()`, whose generated parser
    // writes each member with plain bracket assignment
    // (`result[key] = value`) rather than `Object.defineProperty` —
    // verified empirically against this installed SDK version: a member
    // literally named `__proto__` silently vanishes from the zod-parsed
    // object (the assignment invokes the inherited prototype SETTER
    // instead of creating an own property), while `JSON.parse` itself
    // always creates `__proto__` as an ordinary own data property. Two
    // schemas that differ only in a `__proto__` member therefore digest
    // IDENTICALLY once passed through `client.listTools()` — comparing
    // against this raw map instead closes that gap. Bounded to a small
    // cap since a long-lived connection could otherwise grow it unbounded.
    this._rawResponses = new Map();
    this._buffer = undefined;
    this._bufferBytes = 0;
  }

  async start() {
    const { JSONRPCMessageSchema } = await import('@modelcontextprotocol/sdk/types.js');
    this._messageSchema = JSONRPCMessageSchema;
    const child = this._child;
    child.stdout?.on('data', chunk => {
      if (this._failure || this._closed) return;
      try {
        // Check each frame BEFORE concatenation or UTF-8 decoding.
        let offset = 0;
        let frameBytes = this._bufferBytes;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const end = newline === -1 ? chunk.length : newline;
          frameBytes += end - offset;
          if (frameBytes > MAX_MCP_FRAME_BYTES) {
            this._overflow('OG_WORKER_MCP_FRAME_TOO_LARGE');
            return;
          }
          if (newline === -1) break;
          frameBytes = 0;
          offset = newline + 1;
        }
        this._drain(chunk);
      } catch (error) { this.onerror?.(error); }
    });
    child.stdout?.on('error', error => this.onerror?.(error));
    child.stdin?.on('error', error => this.onerror?.(error));
    // The attached child's stderr is never consumed elsewhere; drain it so a
    // chatty worker cannot block on a full pipe buffer.
    child.stderr?.resume();
    child.once('close', () => this._notifyClose());
    child.once('error', error => this.onerror?.(error));
  }

  _notifyClose() {
    if (this._closed) return;
    this._closed = true;
    this._buffer = undefined;
    this._bufferBytes = 0;
    this._rawResponses.clear();
    this.onclose?.();
  }

  _overflow(code) {
    if (this._failure) return;
    this._failure = Object.assign(new Error(code), { code });
    this._buffer = undefined;
    this._bufferBytes = 0;
    this._rawResponses.clear();
    // Start stopping before pipe closure can exit the leader; onclose rejects
    // pending SDK requests immediately while termination proof is awaited.
    try {
      this._termination = Promise.resolve(this._terminate()).then(result =>
        ['confirmed', 'uncertain'].includes(result?.termination) ? result : { termination: 'uncertain', diagnostic: 'OG_WORKER_MCP_STOP_UNCONFIRMED' }).catch(() => ({ termination: 'uncertain', diagnostic: 'OG_WORKER_MCP_STOP_FAILED' }));
    } catch { this._termination = Promise.resolve({ termination: 'uncertain', diagnostic: 'OG_WORKER_MCP_STOP_FAILED' }); }
    this._child.stdout?.destroy();
    this._child.stdin?.destroy();
    try { this.onerror?.(this._failure); } finally { this._notifyClose(); }
  }

  // Reimplements the SDK's own `ReadBuffer`'s newline-delimited framing
  // directly (rather than delegating to it) so this transport can parse
  // each line TWICE from the exact same bytes: once with plain `JSON.parse`
  // (own-property-preserving, retained in `_rawResponses` — see
  // constructor doc) and once through the SDK's own `JSONRPCMessageSchema`
  // (routed to `onmessage`, unchanged behavior for the Client/Protocol).
  _drain(chunk) {
    // Retain fragments without copying or rescanning the growing partial
    // frame on every pipe read. Join once, only when a newline arrives.
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      if (end > offset) {
        (this._buffer ??= []).push(chunk.subarray(offset, end));
        this._bufferBytes += end - offset;
      }
      if (newline === -1) return;
      const frame = this._buffer?.length === 1
        ? this._buffer[0] : Buffer.concat(this._buffer ?? [], this._bufferBytes);
      const line = frame.toString('utf8').replace(/\r$/, '');
      this._buffer = undefined;
      this._bufferBytes = 0;
      this._handleLine(line);
      if (this._closed || this._failure) return;
      offset = newline + 1;
    }
  }

  _handleLine(line) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (error) { this.onerror?.(error); return; }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.id !== undefined && raw.id !== null) {
      this._rawResponses.set(raw.id, raw);
      if (this._rawResponses.size > 64) {
        const oldest = this._rawResponses.keys().next().value;
        this._rawResponses.delete(oldest);
      }
    }
    let message;
    try {
      message = this._messageSchema.parse(raw);
    } catch (error) { this.onerror?.(error); return; }
    this.onmessage?.(message);
  }

  async send(message) {
    if (this._failure) throw this._failure;
    if (this._closed) throw new Error('worker MCP transport is closed');
    // #2892 F2: a JSON-RPC REQUEST (never a notification or response) is the
    // only message shape with both `method` and `id` — track the most
    // recently sent one's id so an in-flight `stop()`/error-path cancel can
    // reference the worker's own actual request, not a caller-supplied
    // value unrelated to this connection's wire protocol.
    if (message && typeof message === 'object' && typeof message.method === 'string' && message.id !== undefined) {
      this.lastRequestId = message.id;
    }
    const { serializeMessage } = await import('@modelcontextprotocol/sdk/shared/stdio.js');
    // #2915 round 8 (D5): the write boundary — AFTER the dynamic import's
    // own `await` (review 7 finding 4: "checking before an SDK call can
    // precede the actual send by an await... a request can cross its
    // deadline during that gap"). Stop/cancel cleanup traffic
    // (`notifications/cancelled`) is exempt — it must always be allowed to
    // reach the worker, deadline or not.
    const isStopTraffic = message && typeof message === 'object' && message.method === 'notifications/cancelled';
    if (this._deadlineAtMs !== null && !isStopTraffic && this._now() >= this._deadlineAtMs) {
      throw Object.assign(new Error('worker MCP transport deadline exceeded before write'), { code: -32001 });
    }
    // #2915 round 8 review 8 (C3): cancellation at the write boundary,
    // exempting stop/cleanup traffic for the same reason as the deadline
    // check above — a `notifications/cancelled` notification must always be
    // allowed to reach the worker, cancelled or not.
    if (!isStopTraffic && this._isCancelled?.()) {
      throw Object.assign(new Error('worker MCP transport refused: cancelled before write'), { code: -32800 });
    }
    return new Promise((resolve, reject) => {
      if (!this._child.stdin) { reject(new Error('worker MCP process has no stdin')); return; }
      const json = serializeMessage(message);
      if (this._child.stdin.write(json)) resolve();
      else this._child.stdin.once('drain', resolve);
    });
  }

  async close() {
    const child = this._child;
    const closed = new Promise(resolve => child.once('close', resolve));
    try { child.stdin?.end(); } catch { /* already gone */ }
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000).unref?.())]);
    if (child.exitCode === null && child.signalCode === null) {
      try { signalChild(child, 'SIGTERM'); } catch { /* already gone */ }
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000).unref?.())]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      try { signalChild(child, 'SIGKILL'); } catch { /* already gone */ }
    }
    this._buffer = undefined;
    this._bufferBytes = 0;
  }
}

/** Launch the MCP worker SERVER process through the gate-then-launch
 * pipeline, attached, so its stdio can back a `ChildProcessTransport`.
 * `cwd` is the resolved invocation's own worktree (`invocation.cwd`,
 * #2887's `request.workdir`) — the dispatch gate samples free disk on it
 * (`checkWorkerDispatch({ paths: [cwd] })`, see `planDirectWorkerLaunch`).
 * Without it the gate has no filesystem to sample and fails closed with
 * "free disk not detectable on this host" on EVERY host, regardless of
 * isolation mode, because an MCP server registry entry does not itself
 * carry a worktree path the way a resolved shell invocation does. A
 * registry-declared `server.cwd` (none of today's callers set one) still
 * wins when present, matching the pre-existing precedence for the actual
 * spawn directory. */
/** #2915 round 8 (D6): the MCP-native counterpart of
 * `defaultLaunchShellWorkerBaseline` — see its doc comment for why this
 * bypasses the CURRENT `planDirectWorkerLaunch` entirely rather than
 * omitting `admission` and letting that function's own standalone
 * admission branch run (review 7 finding 13's second bullet, which names
 * this exact function: "MCP native path, M:941... omitting the disabled
 * admission loses CLI identity before the flat planner. It performs a new
 * admission; at 128 occupied reservations, disabled work returns blocked
 * where baseline launches"). */
async function defaultLaunchMcpWorkerProcessBaseline(server, { allowDegraded, config, name, cwd, memoryMaxGb = DEFAULT_MCP_WORKER_MEMORY_MAX_GB, live, readers, thresholdOverlay }) {
  if (server?.type !== 'stdio') {
    return { launched: false, blocked: true, diagnostic: 'Only stdio MCP worker servers are qualified for direct handoff' };
  }
  const { checkWorkerDispatch, launchIsolatedWorker } = await loadRalphExternal('lib/worker-isolation.mjs');
  const envNames = Object.keys(server.env ?? {});
  const resolvedCwd = server.cwd ?? cwd;
  const gate = checkWorkerDispatch({ config, live, readers, thresholdOverlay, paths: typeof resolvedCwd === 'string' && resolvedCwd ? [resolvedCwd] : undefined });
  if (!gate.ok) return { launched: false, blocked: true, failures: gate.failures ?? [], diagnostic: describeGateFailures(gate.failures) };
  const launch = await launchIsolatedWorker({
    name, memoryMaxGb, command: server.command ?? '', args: server.args ?? [], cwd: resolvedCwd,
    envNames, env: server.env ?? {}, gate, config, allowDegraded, attached: true,
    // See `defaultLaunchMcpWorkerProcess`: an MCP stdio server needs a live,
    // writable stdin to receive JSON-RPC requests.
    stdin: 'open',
  });
  if (!launch.launched && launch.diagnostic === undefined) {
    return { ...launch, diagnostic: describeGateFailures(launch.failures) };
  }
  return launch;
}

async function defaultLaunchMcpWorkerProcess(server, { allowDegraded, config, name, cwd, memoryMaxGb = DEFAULT_MCP_WORKER_MEMORY_MAX_GB, live, readers, thresholdOverlay, admission, invocation, invocationId, dispatchGuard }) {
  server = markWorkerServer(server, invocation, invocationId);
  // #2915 round 8 (D6): see `defaultLaunchShellWorker`'s identical guard —
  // `admission` is only ever present when this attempt is actually gated.
  if (admission === undefined) {
    return defaultLaunchMcpWorkerProcessBaseline(server, { allowDegraded, config, name, cwd, memoryMaxGb, live, readers, thresholdOverlay });
  }
  if (server?.type !== 'stdio') {
    return { launched: false, blocked: true, diagnostic: 'Only stdio MCP worker servers are qualified for direct handoff' };
  }
  const { planDirectWorkerLaunch } = await loadRalphExternal('session-launcher.mjs');
  const envNames = Object.keys(server.env ?? {});
  const launch = await planDirectWorkerLaunch({
    name, memoryMaxGb, command: server.command ?? '', args: server.args ?? [], cwd: server.cwd ?? cwd,
    envNames, env: server.env ?? {}, config, allowDegraded, attached: true,
    // See `defaultLaunchShellWorker`: test-only dispatch-gate passthroughs,
    // always undefined for production registrations.
    live, readers, thresholdOverlay,
    // #2915 review 4 (finding 2): BORROW the caller's own already-admitted
    // reservation — never a second, independent planner admission for the
    // native-MCP launch path (the exact "one reservation-aware admission"
    // requirement `defaultLaunchShellWorker` already honored).
    //
    // #2915 round 8 review 8 (C6): the borrowed admission's dispatch
    // identity must be derived from THIS call's own trusted, resolved
    // `invocation`/`invocationId` — never the borrowed wrapper's own copies.
    // `planDirectWorkerLaunch`'s own top-level parameter destructuring
    // derives `stdinPath`/`stdoutPath`/`stderrPath`/`command`/`args`/`cwd`
    // AS DEFAULTS from a full `invocation` object when a caller omits them
    // — correct for the shell launch path, but `WorkerResolvedInvocation`
    // (src/serve/worker-invocation.ts) sets `stdoutPath`/`stderrPath`
    // unconditionally for EVERY transport, so passing the full object here
    // would leak them in and collide with `attached: true` (which forbids
    // stdio file redirection entirely). Pass only the minimal shape
    // `selectionDigestFor` actually reads (`{ selected }`) so the digest
    // still matches the original admission's own selection without
    // resurrecting any shell-specific field this attached launch never
    // uses.
    admission, invocation: invocation ? { selected: invocation.selected } : invocation, invocationId, dispatchGuard,
    // #2895's `attached` mode defaults `stdin: 'closed'` (stdio[0] 'ignore') —
    // correct for its own verification-runner callers, which only read a
    // worker's output. An MCP stdio server needs a live, writable stdin to
    // receive JSON-RPC requests; 'open' is the one additive, minimal change
    // this bridge needs on top of the reviewed #2895 attached launch (no
    // change to #2895's own default behavior for other callers).
    stdin: 'open',
  });
  if (!launch.launched && launch.diagnostic === undefined) {
    return { ...launch, diagnostic: describeGateFailures(launch.failures) };
  }
  return launch;
}

const mcpServerQueues = new Map(); // serverRef -> { promise: Promise<void>, depth: number }
/** Test-only observability into the module-level queue map's size — never
 * consulted by any admission/launch decision. */
export function __testOnlyMcpServerQueueCount() { return mcpServerQueues.size; }
export { ChildProcessTransport as __testOnlyChildProcessTransport, MCP_TRANSPORT_MAX_BUFFER_BYTES as __testOnlyMcpTransportMaxBufferBytes };
export { defaultCallMcpWorker as __testOnlyDefaultCallMcpWorker };

/** #2892 D2: bounded per-serverRef serialization queue. Refuses outright
 * (never silently queues unboundedly) once `MAX_MCP_SERVER_QUEUE_DEPTH`
 * calls are already waiting on this serverRef. */
export function withServerQueue(serverRef, task) {
  const state = mcpServerQueues.get(serverRef) ?? { promise: Promise.resolve(), depth: 0 };
  if (state.depth >= MAX_MCP_SERVER_QUEUE_DEPTH) {
    return Promise.resolve({
      outcome: 'blocked',
      diagnostic: `worker MCP server '${serverRef}' serialized queue is at capacity (${MAX_MCP_SERVER_QUEUE_DEPTH}); retry once in-flight calls complete`,
    });
  }
  state.depth += 1;
  mcpServerQueues.set(serverRef, state);
  const settled = state.promise.then(task, task);
  state.promise = settled.then(() => {}, () => {});
  return settled.finally(() => {
    state.depth -= 1;
    // F5 (fix-2892-r2): prune this serverRef's queue entry once nothing is
    // pending against it — otherwise every DISTINCT serverRef this process
    // ever sees (e.g. 100 one-off completed servers) permanently retains a
    // Map entry, even though its `depth` has long since returned to 0.
    // Guarded by object identity so a racing newer `state` already
    // installed in the map (depth > 0 again) is never deleted out from
    // under it.
    if (state.depth === 0 && mcpServerQueues.get(serverRef) === state) {
      mcpServerQueues.delete(serverRef);
    }
  });
}

/** #2892 F5 (fix-2892-r2, formerly D2): a digest over the server definition
 * fields that matter to the gate-then-launch pipeline (command, args, env
 * variable NAMES — never values) — used to detect a changed registry
 * definition between admission and a queued launch, which the pre-existing
 * `enabled` check alone did not catch (a registry edit that keeps `enabled:
 * true` but changes `command`/`args`/`env` still launched the STALE,
 * admission-time server object). Env names are sorted (a set, not an
 * ordered list) so insertion-order-only changes never false-positive. */
function serverDefinitionDigest(server) {
  return canonicalSchemaDigest({
    command: server?.command ?? null,
    args: Array.isArray(server?.args) ? server.args : [],
    envNames: Object.keys(server?.env ?? {}).sort(),
  });
}

/** M3: canonical (sorted-key) digest for comparing a live MCP tool schema
 * against the #2887 installation-owner-trusted schema object — robust to
 * the SDK's own zod-validation round trip, which can reorder keys without
 * changing meaning. Mirrors `workerConfigDigest`'s canonicalization
 * (src/config/aiwg-config.ts) applied to a schema specifically. */
function canonicalSchemaDigest(schema) {
  const canonical = node => {
    if (Array.isArray(node)) return node.map(canonical);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.keys(node).sort().filter(key => node[key] !== undefined).map(key => [key, canonical(node[key])]));
    }
    return node ?? null;
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(schema))).digest('hex')}`;
}

// Audited native MCP lifecycle, without recovery admission.
async function defaultCallMcpWorkerBaseline(mcpBinding, server, options = {}) {
  const {
    sessionIsolation, mcpRegistry, allowDegraded = false, config, name = 'mcp-worker', registerControl,
    memoryMaxGb, mcpSchemas, qualifiedServerDigest, cwd,
    // See `defaultLaunchShellWorker`: test-only dispatch-gate passthroughs,
    // always undefined for production registrations.
    live, readers, thresholdOverlay,
  } = options;
  const run = async () => {
    // D2/F5: recheck the server's own registry qualification immediately
    // before THIS launch — a serialized/per-instance queue may have held
    // this call for a while before its turn came up. Checking `enabled`
    // alone is not requalification: an operator can edit a registry entry's
    // command/args/env while leaving `enabled: true`, and the ORIGINAL
    // (admission-time) `server` object passed into this function would
    // still be the one that gets launched below unless the FRESH
    // definition is also compared against what was qualified.
    if (mcpRegistry) {
      const requalified = await mcpRegistry.get(mcpBinding.serverRef);
      if (!requalified || requalified.enabled === false) {
        return { outcome: 'blocked', diagnostic: 'worker MCP server is no longer registered/enabled' };
      }
      if (qualifiedServerDigest && serverDefinitionDigest(requalified) !== qualifiedServerDigest) {
        return { outcome: 'blocked', diagnostic: 'worker MCP server definition changed since qualification; resolve again' };
      }
    }
    // Resolve fallible dependencies and construct the client before spawning.
    const { stopOverflowWorker } = await loadRalphExternal('lib/worker-overflow.mjs');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const client = new Client({ name: 'aiwg-mcp-worker-invoke', version: '1.0.0' }, { capabilities: {} });
    // B2: gate + launch the MCP worker SERVER process through the same
    // pipeline a shell worker uses — never a bare SDK StdioClientTransport.
    const launch = await defaultLaunchMcpWorkerProcessBaseline(server, { allowDegraded, config, name, cwd, live, readers, thresholdOverlay, ...(memoryMaxGb !== undefined ? { memoryMaxGb } : {}) });
    if (!launch.launched) {
      return { outcome: 'blocked', diagnostic: launch.diagnostic ?? 'worker MCP process launch was refused' };
    }
    const child = launch.child;
    const transport = new ChildProcessTransport(child, { terminate: () => stopOverflowWorker(launch) });
    let disconnected = false;
    let retainOverflowControl = false;
    transport.onclose = () => { disconnected = true; };
    const control = {
      stop: async () => {
        if (transport._failure) {
          // The connection is closed after overflow. Reuse the owned launch's
          // stop authority, including its termination proof, on explicit cancel.
          await transport._termination;
          return stopOverflowWorker(launch);
        }
        try {
          // F2: the ACTUAL in-flight JSON-RPC request id (captured at the
          // transport layer — see `ChildProcessTransport.send`), never the
          // caller's own opaque `mcpBinding.requestId`, which the worker has
          // no way to relate to anything it is actually processing.
          await client.notification({ method: 'notifications/cancelled', params: { requestId: transport.lastRequestId, reason: 'operator-cancel' } });
          return true;
        } catch {
          try { return signalChild(child, 'SIGTERM'); } catch { return false; }
        }
      },
    };
    try {
      registerControl?.(control);
      await client.connect(transport);
      // M3: refuse before any brief is sent if the live tool schema has
      // drifted from what was qualified. Compared CANONICALLY (sorted
      // keys) on both sides, not via the raw `#2887 mcpToolSchemaDigest`
      // pin directly — the SDK's own `listTools()` round-trips the wire
      // JSON through its zod validators, which can legitimately reorder
      // object keys without changing meaning; a byte-exact digest of the
      // POST-validation object against a PRE-validation pin would false-
      // positive on every call. `mcpSchemas` (the #2887 installation-
      // owner-trusted schema objects, not a client-supplied digest) is the
      // comparison's source of truth here.
      const listed = await client.listTools();
      const tool = listed?.tools?.find(t => t.name === mcpBinding.tool);
      if (!tool) {
        return { outcome: 'blocked', diagnostic: 'qualified MCP tool is no longer advertised by the server' };
      }
      // F3 (fix-2892-r2): digest the RAW wire response (plain `JSON.parse`,
      // retained by the transport — see `ChildProcessTransport`'s doc
      // comment), never `tool.inputSchema`/`tool.outputSchema` from the
      // zod-validated `listed` object above — zod's own `z.record()`
      // reconstruction of `properties` silently drops a member literally
      // named `__proto__`, so two schemas differing only in that member
      // would otherwise digest identically and the brief would still be
      // sent. A raw response this transport cannot account for at all
      // (should be unreachable — `listed` only resolved because SOME
      // response arrived) fails closed rather than falling back to the
      // lossy object.
      const rawToolsList = transport._rawResponses.get(transport.lastRequestId);
      const rawTool = rawToolsList?.result?.tools?.find(t => t && t.name === mcpBinding.tool);
      if (!rawTool) {
        return { outcome: 'blocked', diagnostic: 'worker MCP tool schema could not be verified against the raw wire response' };
      }
      if (mcpSchemas?.input && canonicalSchemaDigest(rawTool.inputSchema) !== canonicalSchemaDigest(mcpSchemas.input)) {
        return { outcome: 'blocked', diagnostic: 'worker MCP tool input schema digest drifted from the qualified pin' };
      }
      if (mcpSchemas?.output) {
        // A qualified descriptor that requires an output schema is never
        // satisfied by a worker that stopped advertising one at all —
        // missing is drift, not "nothing to compare".
        if (!rawTool.outputSchema) {
          return { outcome: 'blocked', diagnostic: 'worker MCP tool no longer advertises an output schema the qualified descriptor requires' };
        }
        if (canonicalSchemaDigest(rawTool.outputSchema) !== canonicalSchemaDigest(mcpSchemas.output)) {
          return { outcome: 'blocked', diagnostic: 'worker MCP tool output schema digest drifted from the qualified pin' };
        }
      }
      const response = await client.callTool({ name: mcpBinding.tool, arguments: mcpBinding.arguments }, undefined, { timeout: mcpBinding.timeoutSeconds * 1000 });
      return { outcome: 'responded', response };
    } catch (error) {
      const isTimeout = error?.code === -32001 || /timeout/i.test(String(error?.message ?? ''));
      try { await client.notification({ method: 'notifications/cancelled', params: { requestId: transport.lastRequestId, reason: isTimeout ? 'timeout' : 'error' } }); } catch { /* delivery only, never stop proof */ }
      const termination = transport._failure ? await transport._termination : await stopOverflowWorker(launch);
      retainOverflowControl = !!transport._failure && termination?.termination !== 'confirmed';
      return { outcome: disconnected ? 'disconnected' : isTimeout ? 'timeout' : 'error', error: transport._failure ?? error,
        ...(transport._failure ? { termination: termination?.termination ?? 'uncertain',
          diagnostic: [transport._failure.code, termination?.diagnostic].filter(Boolean).join('; ') } : {}) };
    } finally {
      try { if (!retainOverflowControl) registerControl?.(null); }
      finally { try { await client.close(); } catch { /* already closed */ } }
    }
  };
  return sessionIsolation === 'per-call' ? run() : withServerQueue(mcpBinding.serverRef, run);
}


/** #2915 round 8 (D6): the GATED implementation — reached only through the
 * router below when `options.admission` is present (never omitted-but-falsy;
 * `run()`'s own `continueGated` always supplies a truthily-gated admission).
 * No branch here needs to re-check `admission.gated`; by construction it is
 * always true for the duration of this function. */
async function defaultCallMcpWorkerGated(mcpBinding, server, options = {}) {
  const {
    sessionIsolation, mcpRegistry, allowDegraded = false, config, name = 'mcp-worker', registerControl,
    memoryMaxGb, mcpSchemas, qualifiedServerDigest, cwd, admission, invocation, invocationId,
    // #2915 round 8 (D5): the ONE absolute deadline `run()` computed once,
    // unchanged. Never re-derived here from `mcpBinding.timeoutSeconds` or
    // `admission.token.mintedAtMs` (that double-subtracted preparation
    // time — round 8 critique, D5/review 7 finding 4's last bullet).
    deadlineAtMs = null,
    // #2915 round 8 review 8 (C3): optional cancellation predicate, checked
    // alongside every deadline check below (connect/listTools/callTool) and
    // forwarded into `ChildProcessTransport` for the write boundary. Also
    // folded into the `dispatchGuard` passed to the launch itself so
    // cancellation during pre-spawn preparation prevents the spawn too.
    isCancelled,
    dispatchGuard,
    observeStop,
    // See `defaultLaunchShellWorker`: test-only dispatch-gate passthroughs,
    // always undefined for production registrations.
    live, readers, thresholdOverlay,
  } = options;
  const run = async () => {
    try {
      // D2/F5: recheck the server's own registry qualification immediately
      // before THIS launch — a serialized/per-instance queue may have held
      // this call for a while before its turn came up. Checking `enabled`
      // alone is not requalification: an operator can edit a registry entry's
      // command/args/env while leaving `enabled: true`, and the ORIGINAL
      // (admission-time) `server` object passed into this function would
      // still be the one that gets launched below unless the FRESH
      // definition is also compared against what was qualified.
      if (mcpRegistry) {
        const requalified = await mcpRegistry.get(mcpBinding.serverRef);
        if (!requalified || requalified.enabled === false) {
          return { outcome: 'blocked', diagnostic: 'worker MCP server is no longer registered/enabled', dispatchState: 'never-began' };
        }
        if (qualifiedServerDigest && serverDefinitionDigest(requalified) !== qualifiedServerDigest) {
          return { outcome: 'blocked', diagnostic: 'worker MCP server definition changed since qualification; resolve again', dispatchState: 'never-began' };
        }
      }
      // #2915 review 5 ("a second worker over unresolved execution") /
      // round 8 (D5): a serialized/per-instance queue (D2, below) may have
      // held this call long enough that the admitted attempt's deadline —
      // the ONE absolute `deadlineAtMs` `run()` computed once, which
      // already folds in the canary's own bounded window (min(task
      // deadline, admission+300s)) when applicable — has since passed. For
      // a canary, the breaker's own sweep reopens the scope and installs a
      // blocking marker the moment anything next calls `admit()`/`settle()`
      // on it (possibly a sibling request), regardless of whether THIS
      // queued call ever actually launches. Revalidate immediately before
      // launch, matching the registry-qualification recheck just above:
      // an expired admission must never launch. Falls back to the
      // canary-only `admission.token.deadlineMs` check when no caller
      // supplies `deadlineAtMs` (back-compat for any caller that does
      // not thread it through) — review 7 finding 4: "an ordinary request
      // queued beyond its 900-second budget still spawned and completed"
      // is exactly the plain (non-canary) task-deadline case this widens
      // to cover.
      const nowForExpiry = admission.breaker?.nowMs?.() ?? Date.now();
      const admissionExpired = deadlineAtMs !== null
        ? nowForExpiry >= deadlineAtMs
        : !!(admission.token && nowForExpiry > admission.token.deadlineMs);
      if (admissionExpired) {
        return { outcome: 'blocked', diagnostic: 'worker admission expired while queued; recovery scope may have reopened', dispatchState: 'never-began' };
      }
      // #2915 round 8 review 8 (C3): cancellation requested while this call
      // was queued (or during the checks above) must prevent the spawn too,
      // exactly like an expired deadline — never dispatch after the operator
      // already asked to stop.
      if (typeof isCancelled === 'function' && isCancelled()) {
        return { outcome: 'blocked', diagnostic: 'worker dispatch refused: cancelled before process start', dispatchState: 'never-began' };
      }
    } catch (error) {
      // #2915 review 6 (finding 2, "leaked capacity"): a thrown pre-spawn
      // requalification/expiry check — nothing has been dispatched yet — must
      // settle the same way an ordinary blocked requalification does, never
      // propagate as an exception. `continueGated`'s own caller sets
      // `spawnAttempted` BEFORE invoking this function (it cannot know in
      // advance whether a real spawn is about to happen), so letting this
      // throw escape would be treated as genuinely post-spawn uncertainty
      // and leak the registry's run-slot forever — the exact gap a
      // native-MCP requalification error (`mcpRegistry.get` throwing rather
      // than returning falsy/disabled) left open.
      return { outcome: 'blocked', diagnostic: `worker MCP pre-spawn requalification failed: ${error?.message ?? String(error)}`, dispatchState: 'never-began' };
    }
    let stopOverflowWorker;
    let client;
    try {
      // Resolve fallible dependencies and construct the client before spawning.
      ({ stopOverflowWorker } = await loadRalphExternal('lib/worker-overflow.mjs'));
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      client = new Client({ name: 'aiwg-mcp-worker-invoke', version: '1.0.0' }, { capabilities: {} });
      // Async setup may consume the remaining admitted canary budget.
      if (admission?.gated && admission.token
        && (admission.breaker?.nowMs?.() ?? Date.now()) > admission.token.deadlineMs) {
        return { outcome: 'blocked', diagnostic: 'worker admission expired while queued; recovery scope may have reopened' };
      }
    } catch (error) {
      return { outcome: 'blocked', diagnostic: `worker MCP pre-spawn setup failed: ${error?.message ?? String(error)}`, dispatchState: 'never-began' };
    }
    // B2: gate + launch the MCP worker SERVER process through the same
    // pipeline a shell worker uses — never a bare SDK StdioClientTransport.
    const launch = await defaultLaunchMcpWorkerProcess(server, { allowDegraded, config, name, cwd, live, readers, thresholdOverlay, admission, invocation, invocationId, dispatchGuard, ...(memoryMaxGb !== undefined ? { memoryMaxGb } : {}) });
    if (!launch.launched) {
      // #2915 round 8 review 8 (C2): a failed/timed-out `systemd-run`
      // submission does not prove nothing dispatched — carry `launch`'s own
      // `dispatchState: 'submission-uncertain'` forward so the caller's stop
      // evidence resolution never treats this as a proven zero-dispatch
      // refusal. Every other `!launched` case (gate blocked, dispatch-commit
      // hook abort, degraded-without-allowDegraded) is a proven pre-spawn
      // refusal: `never-began`.
      return { outcome: 'blocked', diagnostic: launch.diagnostic ?? 'worker MCP process launch was refused',
        dispatchState: launch.dispatchState === 'submission-uncertain' ? 'submission-uncertain' : 'never-began',
        isolationMode: launch.mode ?? null, unitName: launch.unit ?? null, child: launch.child ?? null };
    }
    const child = launch.child;
    // #2915 round 8 review 8 (C2): from here on a real process-start call
    // happened — every outcome below (including a post-connect 'blocked'
    // schema-drift refusal) carries this evidence forward so settlement
    // never manufactures a confirmed stop from an outcome label alone.
    const isolationEvidence = { dispatchState: 'dispatched', isolationMode: launch.mode ?? null, unitName: launch.unit ?? null, child: child ?? null };
    // #2915 review 6 (finding 3, "one absolute deadline") / round 8 (D5):
    // `deadlineAtMs` is the ONE fixed absolute wall-clock deadline `run()`
    // computed once at admission — never re-derived here. `nowMsFn` is
    // needed before constructing the transport below, so it moves up from
    // its former position just before the `connect()` call.
    const nowMsFn = () => admission.breaker?.nowMs?.() ?? Date.now();
    const absoluteDeadlineMs = deadlineAtMs;
    // #2915 review 6 (finding 6b, "changed disabled behavior"): the 10 MiB
    // unterminated-frame transport bound AND the deadline write-boundary
    // check (D5) are both enforced unconditionally here — this function is
    // reached only when gated (see `ChildProcessTransport`'s own doc
    // comment).
    const transport = new ChildProcessTransport(child, { terminate: () => stopOverflowWorker(launch),
      deadlineAtMs: absoluteDeadlineMs, now: nowMsFn, isCancelled });
    let disconnected = false;
    let retainOverflowControl = false;
    transport.onclose = () => { disconnected = true; };
    const control = {
      stop: async () => {
        if (transport._failure) {
          // The connection is closed after overflow. Reuse the owned launch's
          // stop authority, including its termination proof, on explicit cancel.
          await transport._termination;
          return stopOverflowWorker(launch);
        }
        try {
          // F2: the ACTUAL in-flight JSON-RPC request id (captured at the
          // transport layer — see `ChildProcessTransport.send`), never the
          // caller's own opaque `mcpBinding.requestId`, which the worker has
          // no way to relate to anything it is actually processing.
          await client.notification({ method: 'notifications/cancelled', params: { requestId: transport.lastRequestId, reason: 'operator-cancel' } });
          return true;
        } catch {
          try { return signalChild(child, 'SIGTERM'); } catch { return false; }
        }
      },
    };
    // #2915 review 6 (finding 3, "one absolute deadline"): derive EVERY
    // stage's timeout (connect/initialize, list, call) from ONE fixed
    // absolute wall-clock deadline, recomputed fresh immediately before
    // each stage from the time ACTUALLY remaining — never a per-stage
    // default (the SDK's own 60s `DEFAULT_REQUEST_TIMEOUT_MSEC`) and never a
    // budget computed once before a serialized/per-instance queue wait that
    // can itself consume most of it. Reproduced: a native request queued
    // 250s into a 300s canary window still received a fresh 300-SECOND SDK
    // call timeout with only 50s actually remaining, while connect/list each
    // separately spent up to another 60s on top of that — vastly overrunning
    // the breaker's own canary window.
    //
    // #2915 round 8 (D5): `remaining <= 0` REFUSES outright (client-side)
    // rather than merely passing `timeout: 0` through to the SDK and
    // trusting its own timer delivery — review 7 finding 4: "at exactly the
    // canary deadline, connect/list/call all received timeout 0, sent
    // requests, and completed successfully."
    // #2915 round 8 review 8 (C3): checked alongside every deadline check
    // below — cancellation requested while a request is in flight (or
    // between stages) must prevent the NEXT request, never retroactively
    // the one already sent.
    const cancelledNow = () => typeof isCancelled === 'function' && isCancelled();
    try {
      registerControl?.(control);
      if (absoluteDeadlineMs !== null && nowMsFn() >= absoluteDeadlineMs) throw Object.assign(new Error('worker MCP deadline already passed before connect'), { code: -32001 });
      if (cancelledNow()) throw Object.assign(new Error('worker MCP call cancelled before connect'), { code: -32800 });
      if (absoluteDeadlineMs !== null) {
        await client.connect(transport, { timeout: Math.max(0, absoluteDeadlineMs - nowMsFn()) });
      } else {
        await client.connect(transport);
      }
      // M3: refuse before any brief is sent if the live tool schema has
      // drifted from what was qualified. Compared CANONICALLY (sorted
      // keys) on both sides, not via the raw `#2887 mcpToolSchemaDigest`
      // pin directly — the SDK's own `listTools()` round-trips the wire
      // JSON through its zod validators, which can legitimately reorder
      // object keys without changing meaning; a byte-exact digest of the
      // POST-validation object against a PRE-validation pin would false-
      // positive on every call. `mcpSchemas` (the #2887 installation-
      // owner-trusted schema objects, not a client-supplied digest) is the
      // comparison's source of truth here.
      if (absoluteDeadlineMs !== null && nowMsFn() >= absoluteDeadlineMs) {
        throw Object.assign(new Error('worker MCP deadline already passed before listTools'), { code: -32001 });
      }
      if (cancelledNow()) throw Object.assign(new Error('worker MCP call cancelled before listTools'), { code: -32800 });
      const listed = absoluteDeadlineMs !== null
        ? await client.listTools(undefined, { timeout: Math.max(0, absoluteDeadlineMs - nowMsFn()) })
        : await client.listTools();
      const tool = listed?.tools?.find(t => t.name === mcpBinding.tool);
      if (!tool) {
        return { outcome: 'blocked', diagnostic: 'qualified MCP tool is no longer advertised by the server', ...isolationEvidence };
      }
      // F3 (fix-2892-r2): digest the RAW wire response (plain `JSON.parse`,
      // retained by the transport — see `ChildProcessTransport`'s doc
      // comment), never `tool.inputSchema`/`tool.outputSchema` from the
      // zod-validated `listed` object above — zod's own `z.record()`
      // reconstruction of `properties` silently drops a member literally
      // named `__proto__`, so two schemas differing only in that member
      // would otherwise digest identically and the brief would still be
      // sent. A raw response this transport cannot account for at all
      // (should be unreachable — `listed` only resolved because SOME
      // response arrived) fails closed rather than falling back to the
      // lossy object.
      const rawToolsList = transport._rawResponses.get(transport.lastRequestId);
      const rawTool = rawToolsList?.result?.tools?.find(t => t && t.name === mcpBinding.tool);
      if (!rawTool) {
        return { outcome: 'blocked', diagnostic: 'worker MCP tool schema could not be verified against the raw wire response', ...isolationEvidence };
      }
      if (mcpSchemas?.input && canonicalSchemaDigest(rawTool.inputSchema) !== canonicalSchemaDigest(mcpSchemas.input)) {
        return { outcome: 'blocked', diagnostic: 'worker MCP tool input schema digest drifted from the qualified pin', ...isolationEvidence };
      }
      if (mcpSchemas?.output) {
        // A qualified descriptor that requires an output schema is never
        // satisfied by a worker that stopped advertising one at all —
        // missing is drift, not "nothing to compare".
        if (!rawTool.outputSchema) {
          return { outcome: 'blocked', diagnostic: 'worker MCP tool no longer advertises an output schema the qualified descriptor requires', ...isolationEvidence };
        }
        if (canonicalSchemaDigest(rawTool.outputSchema) !== canonicalSchemaDigest(mcpSchemas.output)) {
          return { outcome: 'blocked', diagnostic: 'worker MCP tool output schema digest drifted from the qualified pin', ...isolationEvidence };
        }
      }
      if (absoluteDeadlineMs !== null && nowMsFn() >= absoluteDeadlineMs) {
        throw Object.assign(new Error('worker MCP deadline already passed before callTool'), { code: -32001 });
      }
      if (cancelledNow()) throw Object.assign(new Error('worker MCP call cancelled before callTool'), { code: -32800 });
      const callTimeoutMs = absoluteDeadlineMs !== null
        ? Math.max(0, absoluteDeadlineMs - nowMsFn())
        : mcpBinding.timeoutSeconds * 1000;
      const response = await client.callTool({ name: mcpBinding.tool, arguments: mcpBinding.arguments }, undefined, { timeout: callTimeoutMs });
      // #2915 round 8 (D5): "a response arriving after deadlineAt is a
      // timeout regardless of SDK timer delivery" — review 7 finding 4: "a
      // response arriving after the deadline could still return completed."
      if (absoluteDeadlineMs !== null && nowMsFn() >= absoluteDeadlineMs) {
        return { outcome: 'timeout', error: new Error('worker MCP response arrived after the deadline'), ...isolationEvidence };
      }
      return { outcome: 'responded', response, ...isolationEvidence };
    } catch (error) {
      const isTimeout = error?.code === -32001 || /timeout/i.test(String(error?.message ?? ''));
      const isCancelledError = error?.code === -32800;
      try { await client.notification({ method: 'notifications/cancelled', params: { requestId: transport.lastRequestId, reason: isTimeout ? 'timeout' : isCancelledError ? 'cancelled' : 'error' } }); } catch { /* delivery only, never stop proof */ }
      const termination = transport._failure ? await transport._termination : await stopOverflowWorker(launch);
      retainOverflowControl = !!transport._failure && termination?.termination !== 'confirmed';
      return { outcome: disconnected ? 'disconnected' : isTimeout ? 'timeout' : 'error', error: transport._failure ?? error,
        ...isolationEvidence,
        ...(transport._failure ? { termination: termination?.termination ?? 'uncertain',
          diagnostic: [transport._failure.code, termination?.diagnostic].filter(Boolean).join('; ') } : {}) };
    } finally {
      try { if (!retainOverflowControl) registerControl?.(null); }
      finally {
        try {
          const stopping = client.close();
          observeStop?.(stopping, isolationEvidence);
          await stopping;
        } catch { /* already closed */ }
      }
    }
  };
  return sessionIsolation === 'per-call' ? run() : withServerQueue(mcpBinding.serverRef, run);
}

/** #2915 round 8 (D6): thin router, mirroring
 * `defaultLaunchShellWorker`/`defaultLaunchMcpWorkerProcess`'s identical
 * pattern — `options.admission` is only ever present when this call is
 * actually gated (`continueGated` always supplies one; `continueBaseline`
 * never includes the key at all). Absent routes to the literal baseline
 * reimplementation; present routes to the gated implementation. */
async function defaultCallMcpWorker(mcpBinding, server, options = {}) {
  if (options.admission === undefined) {
    return defaultCallMcpWorkerBaseline(mcpBinding, server, options);
  }
  return defaultCallMcpWorkerGated(mcpBinding, server, options);
}

// ===========================================================================
// Health hook extension point (documented, no dependency on #2896 code).
// ===========================================================================

/**
 * `healthHook`, when supplied to `registerWorkerInvokeToolset`, is called as
 * `healthHook(entry)` while building a `status` response and may return a
 * richer health object to merge in. This bridge reports only process/
 * transport-observed state (`entry.health` below); richer liveness signals
 * (quiet/stalled/hung classification) are intentionally out of scope here —
 * #2896 (or any later health-observer work) can supply them through this
 * hook without this module depending on that package.
 */
function publicStatus(entry, healthHook) {
  const base = {
    invocationId: entry.invocationId,
    requestId: entry.requestId,
    status: entry.status ?? (entry.terminalAt === null ? 'running' : 'uncertain'),
    termination: entry.termination ?? 'running',
    cancelRequested: !!entry.cancelRequested,
    cancelDelivered: !!entry.cancelDelivered,
    isolationMode: entry.isolationMode ?? null,
    createdAt: entry.createdAt,
    terminalAt: entry.terminalAt,
    diagnostics: entry.diagnostics ?? [],
    result: entry.result ?? null,
    health: entry.health ?? null,
  };
  if (typeof healthHook === 'function') {
    try {
      const extra = healthHook(entry);
      if (extra && typeof extra === 'object') base.health = { ...base.health, ...extra };
    } catch { /* extension-point failures never break status reporting */ }
  }
  return base;
}

// ===========================================================================
// Tool registration.
// ===========================================================================

const inputSchema = z.strictObject({
  // #2915 round 8 (D4): `reconcile_stopped` is an explicit operator-
  // authorized reconciliation operation on this SAME handler (never a
  // mailbox file, never a new breaker) — see `reconcileStopped` below.
  operation: z.enum(['run', 'status', 'cancel', 'reconcile_stopped', 'reset_recovery_scope']),
  invocation_id: invocationUuid().optional(),
  scope_id: z.string().min(1).max(512).optional(),
  request_id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
  role: z.enum(['efficiency', 'coding', 'reasoning']).optional(),
  task: z.string().min(1).max(256).optional(),
  group: z.string().min(1).regex(/^[a-z][a-z0-9-]{0,62}$/).optional(),
  brief: z.string().min(1).optional(),
  workdir: z.string().min(1).optional(),
  final_output: z.string().min(1).optional(),
  transport: z.enum(['shell', 'mcp']).default('shell'),
  // #2915 step 4 (retry linkage): conductor-declared predecessor invocation
  // id. Accepted and shape-validated here; `run()` below refuses explicitly
  // rather than silently ignoring it (no server-owned capture-root
  // configuration exists yet for the MCP shell-launch path — see
  // session-launcher.mjs `verifyRetryPredecessor`, which the CLI entry
  // point already uses). Omission is unrelated work, as always.
  retry_of: invocationUuid().optional(),
});

/**
 * #2892 B1: `options.projectRoot` is REQUIRED — the caller (`server.mjs`,
 * via `subsystems.mjs`'s `registerOptInToolsets`) must resolve the served
 * project root itself (e.g. `findProjectRoot()`) before registration. This
 * function never falls back to `process.cwd()`, and refuses to register the
 * `worker-invoke` tool at all when no explicit root is supplied — a
 * worker-invoke tool with no real root to bind to is a bug, not a degraded
 * mode. `registerOptInToolsets` awaits this function's returned Promise, so
 * callers that need the tool registered before proceeding must `await` it.
 */
export async function registerWorkerInvokeToolset(server, options = {}) {
  const allowDegraded = options.allowDegraded ?? resolveServerAllowDegraded();
  if (!options.projectRoot) {
    console.error("[AIWG MCP] 'workers' toolset refused: no explicit served project root was supplied at registration time (never falls back to process.cwd()).");
    return;
  }
  const servedRootReal = await resolveServedProjectRoot(options.projectRoot);
  await sweepWorkerStdin(options.stdinRuntimeRoot);
  // Pinned once, here, at registration — never re-resolved per request, and
  // never re-derived from `process.cwd()` (#2892 B1).
  const servedRoot = async () => servedRootReal;
  // #2892 F1: resolved once, at registration, same posture as the served
  // root itself.
  const workerWorktreesRootReal = await resolveWorkerWorktreesRoot(servedRootReal, options.workerWorktreesRoot);
  const listWorktreesImpl = options.listWorktrees ?? defaultListGitWorktrees;
  const maxActive = options.maxActive ?? await resolveDefaultMaxActive(servedRootReal);
  const ttlMs = options.ttlMs ?? resolveServerTerminalTtlMs();
  const registry = options.registry ?? createInvocationRegistry({ now: options.now, maxActive, ttlMs });
  const loadWorkerInputsImpl = options.loadWorkerInputs ?? defaultLoadWorkerInputs;
  const launchShellWorkerImpl = options.launchShellWorker ?? defaultLaunchShellWorker;
  const callMcpWorkerImpl = options.callMcpWorker ?? defaultCallMcpWorker;
  // Both continuations use the audited observer and hardened stop controls.
  const waitForUnitTerminationOverride = options.waitForUnitTermination;
  // #2915 review 5 ("a second worker over unresolved execution"): the
  // degraded-isolation shell wait path below shares the launcher's own
  // bounded SIGTERM-then-SIGKILL escalation (`terminateChildWithGrace`)
  // rather than sending an unobserved SIGTERM alone.
  const terminateChildImpl = options.terminateChildWithGrace
    ?? (async child => (await loadRalphExternal('session-launcher.mjs')).terminateChildWithGrace(child));
  const mcpWorkerMemoryMaxGb = options.mcpWorkerMemoryMaxGb; // undefined -> defaultLaunchMcpWorkerProcess's own fallback
  // Test-only: `planDirectWorkerLaunch`'s own dispatch-gate passthroughs
  // (`checkWorkerDispatch({ live, readers, thresholdOverlay })`), forwarded
  // through to the default shell/mcp launchers below so the REAL
  // gate-then-launch pipeline still runs against fixed synthetic host
  // signals instead of the current host's actual load/memory/PSI/disk.
  // Production registrations never set `options.gateInputs` — omitted,
  // every field here is `undefined` and the gate samples the real host.
  const gateInputs = options.gateInputs ?? {};
  const healthHook = options.healthHook;
  const now = options.now ?? (() => new Date());
  const repoAccess = options.repoAccess; // injected lazily below when absent
  const repoAccessModule = async () => repoAccess ?? loadRepoAccessModule();

  async function validatedRequest(input) {
    const root = await servedRoot();
    const access = await repoAccessModule();
    const brief = await assertServedPath(root, input.brief, 'brief');
    await assertRepoAccessAllowed(root, brief, 'read', access);
    const workdir = await assertServedPath(root, input.workdir, 'workdir');
    await assertWorkdirIsConductorWorktree(root, workdir, { worktreesRoot: workerWorktreesRootReal, listWorktrees: listWorktreesImpl });
    await assertRepoAccessAllowed(root, workdir, 'write', access);
    const finalOutput = await assertServedPath(root, input.final_output, 'final_output');
    assertWithinWorkdir(workdir, finalOutput);
    await assertRepoAccessAllowed(root, finalOutput, 'write', access);
    return { role: input.role, task: input.task, group: input.group, brief, workdir, final_output: finalOutput, transport: input.transport };
  }

  /**
   * #2915 round 8 (D5, review 7 finding 9): "MCP discards the settlement
   * promise and its diagnostic." `runInner` is the full implementation
   * (unchanged below); `captureSettlementPromise`, when called, hands this
   * run's ONE cached ledger-settlement promise (`settleDirectWorker`'s own
   * return value, see `settleRecovery` below) up to `run()`'s thin wrapper,
   * which awaits it at this function's one true return boundary and folds
   * any refund-failure diagnostic it carries into the result — instead of
   * letting that promise, and whatever it resolves to, simply vanish.
   */
  async function run(input) {
    let settlementPromise = null;
    const transitions = [];
    let result = await runInner(input, promise => { settlementPromise = promise; }, event => {
      transitions.push(event.summary);
      (options.onRecoveryTransition ?? (event => console.error(event.summary)))(event);
    });
    if (settlementPromise) {
      let diagnostic = null;
      try { diagnostic = await settlementPromise; } catch { /* never fail a run on diagnostic retrieval */ }
      if (diagnostic && result?.invocationId) {
        const current = registry.get(result.invocationId);
        if (current) {
          result = registry.update(result.invocationId, { diagnostics: [...(current.diagnostics ?? []), diagnostic] });
        }
      }
    }
    if (transitions.length && result?.invocationId) {
      result = registry.update(result.invocationId, { diagnostics: [...(result.diagnostics ?? []), ...transitions] });
    }
    return result;
  }

  async function runInner(input, captureSettlementPromise, onTransition) {
    // M1: request_id is required, and admission (capacity + replay check +
    // reservation) is entirely synchronous — no `await` between the checks
    // and `registry.create()` — so no concurrent `run()` call can observe a
    // stale "capacity available" / "request_id unused" read.
    if (!input.request_id) throw new Error('Worker invocation requires request_id (identity-bound atomic admission)');
    if (!input.role || !input.task || !input.group || !input.brief || !input.workdir || !input.final_output) {
      throw new Error('Incomplete worker invocation');
    }
    // #2915 step 4: `retry_of` has no server-owned capture-root
    // configuration to verify a predecessor against on this bridge yet
    // (see the schema comment above) — refuse explicitly, before any
    // capacity is reserved, rather than silently accepting and ignoring a
    // conductor's retry declaration. Predates round 8 and applies
    // unconditionally (not a gating concern): `retry_of` support is simply
    // not implemented on this bridge yet, for gated or not-gated callers
    // alike, so origin/main's own schema (which has no `retry_of` field at
    // all) never had an equivalent case to diverge from.
    if (input.retry_of !== undefined) throw new Error('retry_of is not yet supported on the MCP worker-invoke bridge (OG_RETRY_UNSUPPORTED_MCP)');
    if (!registry.canStart()) throw new Error('Worker invocation capacity is reserved; no live run slot is available');
    const existing = registry.claimRequestId(input.request_id);
    if (existing) throw new Error('Worker request_id was already used; mint a fresh request_id instead of replaying');
    const entry = registry.create({ requestId: input.request_id, transport: input.transport, status: 'running', termination: 'running' });
    let request;
    let outputReservation;
    const execution = { mayHaveLaunched: false };
    let reservationCleanup;
    const cleanupReservation = () => reservationCleanup ??= (async () => {
      if (!outputReservation) return;
      try {
        const current = await lstat(request.final_output);
        // Best effort: the pathname can change between lstat and unlink.
        if (current.dev === outputReservation.dev && current.ino === outputReservation.ino && current.size === 0) {
          await unlink(request.final_output);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') console.error('[worker-invoke] output reservation cleanup failed');
      }
    })();
    const markTerminal = async update => {
      if (!execution.mayHaveLaunched) await cleanupReservation();
      return registry.markTerminal(entry.invocationId, update);
    };
    try {
      request = await validatedRequest(input);
    } catch (error) {
      // M1: release the capacity/identity reservation on validation failure
      // ("release on validation failure"), but preserve the pre-existing
      // malformed/escaping-input contract (an MCP tool error, not a status
      // envelope) by rethrowing after releasing — the outer handler below
      // converts this into `mcpError(...)`.
      registry.markTerminal(entry.invocationId, { status: 'blocked', termination: 'confirmed', diagnostics: [error.message] });
      throw error;
    }

    // Shared pre-dispatch preparation owns capacity and output cleanup.
    let prefix;
    try {
      try {
        outputReservation = await reserveFinalOutput(request.final_output);
      } catch {
        return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: ['final_output already exists or is not reservable as a fresh plain file'] });
      }
      const root = await servedRoot();
      const { snapshot, drivers } = await loadWorkerInputsImpl(root);
      const { resolveWorkerInvocation } = await loadServeWorkerInvocation();
      const plan = await resolveWorkerInvocation(snapshot, request, drivers, now().toISOString());
      if (plan.invocation?.readiness !== 'launchable') {
        return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: plan.diagnostics ?? [] });
      }
      if (plan.invocation.isolation === 'native-sandbox') {
        return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: [{
          code: 'OG_POLICY_RELAXATION', pointer: '/worker/isolation',
          message: 'MCP worker-invoke run does not support pinned native-sandbox isolation',
        }] });
      }
      prefix = { root, snapshot, drivers, invocation: plan.invocation };
    } catch (error) {
      return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: [error.message] });
    }
    const { root, snapshot, drivers, invocation } = prefix;

    // #3685 round 2: the worker CLI's AIWG bootstrap must be present in
    // the worker workdir before dispatch — a context-free worker would run
    // with no project rules/skills/hooks. Present: no-op. Missing: exactly
    // one `aiwg use all` pass into the workdir (never elsewhere). A failed
    // ensure refuses as `blocked` with the typed diagnostic (never a
    // launch). Default on; `ensureWorkerContext: false` skips (synthetic
    // tests), a function value replaces the ensure.
    if (options.ensureWorkerContext !== false) {
      try {
        const ensure = typeof options.ensureWorkerContext === 'function'
          ? options.ensureWorkerContext
          : ensureWorkerContextForInvocation;
        await ensure({ invocation, config: snapshot.config });
      } catch (error) {
        return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: [toWorkerContextDiagnostic(error)] });
      }
    }

    // =========================================================================
    // #2915 round 8 (D6): ONE decision, immediately after the prefix, from
    // the launcher's own pure eligibility predicate,
    // `directRecoveryEligibility` (session-launcher.mjs) — the SAME
    // function `launchOneWorker`'s own not-gated/gated split and
    // `admitDirectWorker` itself both call, so this decision cannot drift
    // out of sync with either (round 8 critique, D6; the decision is
    // structurally one function, not three matching conditions). It
    // consults, in order, the global switch, the per-CLI switch,
    // `canVerifyAttempt`, and an explicit breaker override, and reserves
    // nothing — every ineligible answer returns `{ gated: false }` before
    // ever touching the breaker or the ledger. The only check made BEFORE
    // even importing the recovery module is the global switch
    // (`config.parallelism.worker_dispatch`) — matching the SAME field
    // `session-launcher.mjs`'s own call sites resolve as `gate.enabled`
    // (`checkWorkerDispatch`) — so a globally disabled deployment never
    // imports the recovery module at all (#2915 review 4 finding 7),
    // exactly like origin/main never having this feature.
    // =========================================================================
    const dispatchGateEnabled = !!snapshot.config?.parallelism?.worker_dispatch;
    let admission;
    let recoveryModule;
    let admissionGuard;
    if (!dispatchGateEnabled) {
      admission = { gated: false };
    } else {
      try {
        recoveryModule = await loadRalphExternal('session-launcher.mjs');
        const eligibility = recoveryModule.directRecoveryEligibility({
          gateEnabled: dispatchGateEnabled, config: snapshot.config, invocation, drivers, scopedBreaker: options.scopedBreaker,
        });
        if (!eligibility.gated) {
          // Not eligible (per-CLI switch, `canVerifyAttempt`, or an
          // explicit breaker override) — nothing was reserved; `admission`
          // is exactly the predicate's own `{ gated: false, reason? }`.
          admission = eligibility;
        } else {
          // #2915 review 4 (finding 8): consult the same per-task-chain
          // allowance ledger the launcher path uses, keyed off the SAME
          // stable digest and the SAME resolved `invocation.limits.
          // maxAttempts` -- no new configuration, just the existing
          // ceiling already resolved above by `resolveWorkerInvocation`.
          // MCP has no server-owned capture root to persist a
          // cross-process ledger file under, so `captureRoot` is
          // intentionally omitted: the ledger falls back to this
          // process's own in-memory map (see `reserveDirectWorkerAllowance`
          // in session-launcher.mjs). That still enforces the allowance
          // correctly WITHIN this server process -- including across
          // concurrent sibling retries, which serialize on the same
          // in-process reservation check -- but it is explicitly NOT
          // cross-process-safe: a second MCP server process, or a restart
          // of this one, starts the count over for the same task chain.
          const breaker = options.scopedBreaker ?? recoveryModule.getDirectRecoveryBreaker();
          registry.bindRecoveryOwner(breaker);
          const startedAtMs = breaker.nowMs();
          admissionGuard = {
            nowMs: () => breaker.nowMs(),
            deadlineAtMs: startedAtMs + Math.min(invocation.health?.hardTimeoutSeconds ?? Infinity,
              invocation.limits.wallSeconds, invocation.transport === 'mcp' ? invocation.mcp.timeoutSeconds : Infinity) * 1000,
            isCancelled: () => !!registry.get(entry.invocationId)?.cancelRequested,
          };
          const taskChainDigest = await recoveryModule.stableTaskChainDigest(request, invocation.briefDigest ?? null);
          admission = await recoveryModule.admitDirectWorker({
            gateEnabled: dispatchGateEnabled, config: snapshot.config,
            invocation, invocationId: entry.invocationId, drivers, scopedBreaker: breaker, dispatchGuard: admissionGuard,
            taskChainDigest, maxAttempts: invocation.limits?.maxAttempts, onTransition,
          });
        }
      } catch (error) {
        // #2915 P0 (fail closed, no leaked slot): this admission call runs
        // AFTER `registry.create()` already reserved this run's capacity/
        // identity slot. Any exception here (bad breaker state, a thrown
        // import, a malformed gate result) must refuse the launch the same
        // way an ordinary recovery-scope refusal does — `markTerminal`,
        // freeing the reservation. A pre-spawn breaker error is not an
        // uncertain worker outcome: no worker ever ran.
        return markTerminal({ status: 'blocked', termination: 'confirmed',
          diagnostics: [`recovery admission failed closed: ${error?.message ?? String(error)}`] });
      }
    }
    if (admission.refused) {
      // #2915 review 4 (finding 8): a ledger-exhaustion refusal has no
      // covering scope (`blockedBy` is empty) -- fall back to the
      // refusal's own code/reason so the diagnostic is never an empty
      // "recovery scope open: " for that case.
      const blockedBy = admission.refused.blockedBy?.length ? admission.refused.blockedBy.join(', ')
        : (admission.refused.code ?? admission.refused.reason ?? 'unknown');
      // #2915 round 8 (D4, C4): a `blocking-markers:<N>` component names
      // genuinely unresolved execution occupying reservation slots (never
      // mere backoff) — point at the exact reachable reconciliation route
      // for it, this tool's own `reconcile_stopped` operation, rather than
      // leaving the operator to go looking for one.
      const markerNote = admission.refused.blockedBy?.some(b => b.startsWith('blocking-markers:'))
        ? "; unresolved reservations can be reconciled via this tool's 'reconcile_stopped' operation (see 'status' with no invocation_id for the pending list)"
        : '';
      return markTerminal({ status: 'blocked', termination: 'confirmed',
        diagnostics: [`recovery scope open: ${blockedBy}${markerNote}${admission.refused.reason ? `; ${admission.refused.reason}` : ''}`] });
    }
    // #2915 round 8 (D4): track which breaker instance actually owns this
    // invocation's reservation (when gated) — the `reconcile_stopped`
    // operation and the no-id `status` listing both need to reach the
    // SAME breaker a later `admitDirectWorker` call used, not a fresh
    // default. Internal bookkeeping only — never surfaced by `publicStatus`.
    if (admission.breaker) {
      try {
        registry.update(entry.invocationId, { recoveryBreaker: admission.breaker });
      } catch (error) {
        const diagnostic = await recoveryModule.settleDirectWorker(admission, { kind: 'uncertain', confirmedStop: true });
        return markTerminal({ status: 'blocked', termination: 'confirmed',
          diagnostics: [error.message, diagnostic].filter(Boolean) });
      }
    }

    // Share reservation ownership; recovery accounting belongs only to the gated continuation.
    const ctx = { entry, request, root, snapshot, drivers, invocation, execution, cleanupReservation, markTerminal };
    if (admission.gated) {
      return continueGated(ctx, { admission, recoveryModule, captureSettlementPromise, admissionGuard });
    }
    return continueBaseline(ctx);
  }

  // Recovery-disabled execution follows current main's audited lifecycle.
  // Only recovery admission/accounting is omitted; stop and cleanup stay active.
  async function continueBaseline(ctx) {
    const { entry, request, root, snapshot, drivers, invocation, execution, cleanupReservation, markTerminal } = ctx;
    try {
      // F4 (fix-2892-r2, formerly part of M5): per operator decision, the
      // MCP path REQUIRES the structured WorkerDirectBrief — a probe showed
      // a plaintext brief (or a JSON brief swapped to plaintext between
      // launch and result assembly) was accepted, bypassing digest
      // verification entirely and completing anyway, because
      // `tryAssembleDirectResult` below treats a non-JSON brief as "nothing
      // to assemble against" and best-effort no-ops rather than refusing.
      // Fixed: for `mcp` transport ONLY, validate — AT ADMISSION, BEFORE any
      // launch — that the brief parses as a WorkerDirectBrief (#2890/#2879
      // codec), and pin ITS digest ourselves (never relying on whatever
      // `invocation.briefDigest` #2887's own resolver may or may not have
      // set for this transport). A non-structured or schema-invalid brief
      // refuses before any worker ever runs.
      let mcpBriefDigest;
      if (invocation.transport === 'mcp') {
        let briefBytes;
        try {
          briefBytes = await readBoundedFile(request.brief, 262144, root);
        } catch {
          return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: ['OG_BRIEF_UNREADABLE'] });
        }
        try {
          const { assertValidWorkerPayload } = await loadMissionProtocol();
          assertValidWorkerPayload('workerDirectBrief', JSON.parse(briefBytes.toString('utf8')));
        } catch (error) {
          // Fixed-vocabulary diagnostic only — NEVER the raw JSON.parse/
          // validator message, exactly like M5's own `parseWorkerFinal`
          // diagnostic below. A duplicate-key/planted-marker probe showed
          // this exact kind of path can otherwise reflect attacker/worker-
          // controlled input text straight back out to the caller.
          return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: workerFailureDiagnostics(error, 'workerDirectBrief', 'OG_BRIEF_NOT_STRUCTURED') });
        }
        mcpBriefDigest = `sha256:${createHash('sha256').update(briefBytes).digest('hex')}`;
      }
      const deadlineMs = Math.min(invocation.health?.hardTimeoutSeconds ?? invocation.limits.wallSeconds, invocation.limits.wallSeconds) * 1000;
      let observation;
      let rawOutput;
      if (invocation.transport === 'shell') {
        execution.mayHaveLaunched = true;
        const launch = await launchShellWorkerImpl(invocation, { allowDegraded, config: snapshot.config,
          name: `mcp-${entry.invocationId.slice(0, 8)}`, memoryMaxGb: options.shellWorkerMemoryMaxGb,
          driver: drivers[invocation.selected.cli], servedRoot: root, stdinRuntimeRoot: options.stdinRuntimeRoot, ...gateInputs });
        registry.update(entry.invocationId, { isolationMode: launch.mode ?? null });
        if (!launch.launched && !launch.launchAttempted) {
          execution.mayHaveLaunched = false;
          return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: [launch.diagnostic ?? 'worker launch was refused'] });
        }
        // M2: a live stop handle for the duration of this call, so an
        // explicit `cancel` can actually stop the isolated unit / kill the
        // child, not just record that cancellation was requested.
        const control = buildShellStopControl(launch, {
          waitForUnit: (waitForUnitTerminationOverride ?? waitForUnitTerminationBaseline),
          stopUnit: options.stopWorkerUnit,
          killUnit: options.killWorkerUnit,
          graceMs: options.shellStopGraceMs ?? (invocation.health?.terminateGraceSeconds ?? 1) * 1000,
          onConfirmed: async () => {
            if (!launch.launched) await cleanupReservation();
            await Promise.resolve().then(() => launch.cleanup?.()).catch(() => {});
            const live = registry.get(entry.invocationId);
            if (live?.terminalAt !== null) return;
            if (live.status === 'uncertain' || live.status === 'blocked') {
              registry.markTerminal(entry.invocationId, { control: null, termination: 'confirmed',
                status: live.cancelRequested ? 'cancelled' : 'failed' });
            } else registry.update(entry.invocationId, { control: null, termination: 'confirmed' });
          },
        });
        if (registry.get(entry.invocationId)?.termination !== 'confirmed') {
          registry.update(entry.invocationId, { control });
        }
        // Honor a cancel that arrived while the launcher was still pending.
        if (registry.get(entry.invocationId)?.cancelRequested) await control.stop();
        const outcome = launch.launched ? await control.wait(deadlineMs) : await control.stopAndConfirm();
        observation = { transport: 'shell', status: outcome.termination === 'confirmed' && outcome.exitCode === 0 ? 'completed' : 'failed', termination: outcome.termination, exitCode: outcome.exitCode };
        if (outcome.termination !== 'confirmed') {
          // M2: stays LIVE — capacity is held until a stop is proven or the
          // conductor disposes of it explicitly, never freed on a mere
          // unconfirmed-termination timeout.
          return registry.update(entry.invocationId, { status: 'uncertain', termination: 'uncertain', diagnostics: ['worker termination could not be confirmed before the deadline'] });
        }
        await Promise.resolve().then(() => launch.cleanup?.()).catch(() => {
          console.error('[worker-invoke] stdin cleanup failed after confirmed termination');
        });
        if (!launch.launched) {
          execution.mayHaveLaunched = false;
          return markTerminal({ control: null, status: 'failed', termination: 'confirmed',
            diagnostics: [launch.diagnostic ?? 'worker launch failed; termination confirmed'] });
        }
        if (outcome.timedOut || outcome.stopped) {
          return registry.markTerminal(entry.invocationId, { control: null, termination: 'confirmed',
            status: registry.get(entry.invocationId)?.cancelRequested ? 'cancelled' : 'failed',
            diagnostics: [outcome.timedOut ? 'worker deadline exceeded; termination confirmed' : 'worker stopped; termination confirmed'] });
        }
        try { rawOutput = await readBoundedFile(invocation.finalPath, invocation.maxOutputBytes, root); } catch {
          return registry.markTerminal(entry.invocationId, { status: 'failed', termination: 'confirmed', diagnostics: ['worker final output was not written'] });
        }
      } else {
        const { mcpRegistry, qualification } = drivers[invocation.selected.cli];
        const mcpServer = await mcpRegistry.get(invocation.mcp.serverRef);
        if (!mcpServer) return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: ['worker MCP server is not registered'] });
        // F5: pin the qualified server's definition digest NOW, at
        // admission, so a queued launch can detect a registry edit that
        // happened while it was waiting (see `serverDefinitionDigest`).
        const qualifiedServerDigest = serverDefinitionDigest(mcpServer);
        execution.mayHaveLaunched = true;
        const result = await callMcpWorkerImpl(invocation.mcp, mcpServer, {
          sessionIsolation: invocation.mcp.sessionIsolation, mcpRegistry, allowDegraded, config: snapshot.config,
          // #2892 (CI fix): the resolved invocation's own worktree
          // (`invocation.cwd`, #2887's `request.workdir`) — without it the
          // dispatch gate's free-disk sample has no filesystem to read and
          // fails closed on every host, never reaching isolation at all.
          // See `defaultLaunchMcpWorkerProcess`'s doc comment.
          cwd: invocation.cwd,
          name: `mcp-${entry.invocationId.slice(0, 8)}`, memoryMaxGb: mcpWorkerMemoryMaxGb, mcpSchemas: qualification?.mcpSchemas,
          qualifiedServerDigest, registerControl: control => registry.update(entry.invocationId, { control }),
          ...gateInputs,
        });
        if (result.outcome === 'blocked') {
          return registry.markTerminal(entry.invocationId, { status: 'blocked', termination: 'confirmed', diagnostics: [result.diagnostic ?? 'worker MCP launch was refused'] });
        }
        if (result.outcome !== 'responded') {
          // Overflow holds capacity and stop control until termination is proven.
          if (result.diagnostic?.includes('OG_WORKER_MCP_FRAME_TOO_LARGE')) {
            // An explicit cancel can have confirmed termination while this run
            // was awaiting its initial overflow evidence.
            if (entry.terminalAt !== null) return entry;
            const patch = { status: result.termination === 'confirmed' ? 'failed' : 'uncertain',
              termination: result.termination ?? 'uncertain', diagnostics: [result.diagnostic] };
            return result.termination === 'confirmed'
              ? registry.markTerminal(entry.invocationId, { ...patch, control: null })
              : registry.update(entry.invocationId, patch);
          }
          // M2: stays LIVE for the same reason as the shell timeout path above.
          return registry.update(entry.invocationId, { status: 'uncertain', termination: 'uncertain', diagnostics: [`worker ${result.outcome}; cancellation delivered, not confirmed stopped`] });
        }
        rawOutput = result.response;
        observation = { transport: 'mcp', status: result.response.isError ? 'failed' : 'completed', termination: 'confirmed', exitCode: result.response.isError ? 1 : null, isError: !!result.response.isError };
        if (result.response.isError) {
          return registry.markTerminal(entry.invocationId, { status: 'failed', termination: 'confirmed', diagnostics: ['worker reported isError'] });
        }
      }
      const { ProviderAdapter } = await loadRalphExternal('lib/provider-adapter.mjs');
      let claims;
      try {
        claims = await new (class extends ProviderAdapter {})().parseWorkerFinal(rawOutput, {
          format: invocation.transport === 'shell' ? 'jsonl' : 'mcp', observation, maxOutputBytes: invocation.maxOutputBytes,
        });
      } catch (error) {
        // M5: bounded, fixed-vocabulary diagnostic only — never the raw
        // parser error message, which can echo attacker/worker-controlled
        // input text back out (a duplicate-key probe reflected a planted
        // marker through this exact path before the fix).
        return registry.markTerminal(entry.invocationId, { status: 'failed', termination: 'confirmed', diagnostics: workerFailureDiagnostics(error, 'workerClaims', 'OG_WORKER_FINAL_INVALID') });
      }
      const assembled = await tryAssembleDirectResult({ request, invocation, observation, claims, root,
        briefDigest: mcpBriefDigest, requireStructuredBrief: invocation.transport === 'mcp' });
      if (assembled?.conflict) {
        // M5: the brief changed between launch and result assembly — never
        // silently assemble a result against a different brief than the one
        // the worker was actually launched against.
        return registry.markTerminal(entry.invocationId, { status: 'failed', termination: 'confirmed', diagnostics: ['OG_BRIEF_EVIDENCE_CONFLICT'] });
      }
      // M2: a cancel requested at ANY point during this run's lifetime —
      // even before a live `control` handle existed to deliver it to — means
      // this result is never trusted as `completed`, regardless of what the
      // worker itself claims.
      const liveEntry = registry.get(entry.invocationId);
      return registry.markTerminal(entry.invocationId, {
        status: liveEntry?.cancelRequested ? 'cancelled' : (claims.status === 'completed' ? 'completed' : 'failed'),
        termination: 'confirmed',
        result: assembled?.result ?? { claims },
      });
    } catch (error) {
      if (error.workerNotLaunched) execution.mayHaveLaunched = false;
      if (!execution.mayHaveLaunched) {
        return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: [error.message] });
      }
      if (registry.get(entry.invocationId)?.termination === 'confirmed') {
        return registry.markTerminal(entry.invocationId, { control: null,
          status: registry.get(entry.invocationId)?.cancelRequested ? 'cancelled' : 'failed',
          termination: 'confirmed', diagnostics: [error.message] });
      }
      // An exception after launch is not proof that a worker stopped.
      return registry.update(entry.invocationId, { status: 'uncertain', termination: 'uncertain', diagnostics: [error.message] });
    }
  }

  /**
   * #2915 round 8 (D6): the GATED continuation — reached only when the
   * decision point in `runInner` already admitted (or is borrowing) a
   * breaker reservation. `admission.gated` is therefore always true for the
   * duration of this function; no branch here needs to re-check it (the
   * previous worker's scattered `admission?.gated` conditionals are gone by
   * construction, not by review).
   */
  async function continueGated(ctx, { admission, recoveryModule, captureSettlementPromise, admissionGuard }) {
    const { entry, request, root, snapshot, drivers, invocation, execution, cleanupReservation, markTerminal } = ctx;
    // #2915 final: `recoverySettled`/`spawnAttempted` are function-scoped
    // (not inside the try block below) so the catch-all at the end of this
    // function can also settle this run's admission (#2915 final review,
    // finding 2: a thrown error reaching that catch previously left the
    // reservation live with zero capacity recovered — the exact "slot leak"
    // the final review named).
    let recoverySettled = false;
    // #2915 review 5 (finding 2b, "leaked capacity"): distinguishes PROVEN
    // pre-spawn exceptions (nothing ever ran -- the registry run-slot must
    // be released) from post-spawn uncertainty (a worker process/call
    // genuinely started and may still be running -- the slot correctly
    // stays live per M2). Set true only once a shell launch or MCP call is
    // confirmed to have actually started (past every "never launched"/
    // "blocked" refusal below), never merely attempted.
    let spawnAttempted = false;
    let isolationEvidence = null;
    let settlementPromise;
    let settlementStarted;
    let cancelFollowUp;
    let neverExecutedStop = false;
    const settlementReady = new Promise(resolve => { settlementStarted = resolve; });
    const resolveEvidence = evidence => neverExecutedStop && evidence?.isolationMode === 'systemd-unit'
      && evidence.unitName === isolationEvidence?.unitName
      ? Promise.resolve({ stop: 'confirmed', confirmedStop: true }) : recoveryModule.resolveStopEvidence({
      ...evidence, getStatus: options.isolationStatus, stopUnit: options.stopUnit,
      terminateChild: terminateChildImpl,
    });
    const reconcileEvidence = async evidence => {
      await settlementReady;
      await settlementPromise;
      if (!admission.breaker?.hasUnresolvedStop?.(entry.invocationId)) return true;
      const resolved = await resolveEvidence({ ...evidence, stopFirst: false });
      if (resolved.confirmedStop) {
        cancelFollowUp?.();
        const reconciled = admission.breaker?.reconcileStopEvidence?.({ invocationId: entry.invocationId, confirmedStop: true });
        if ((reconciled?.released ?? 0) > 0) registry.markTerminal(entry.invocationId, {});
      }
      return resolved.confirmedStop;
    };
    // The outward result and execution protection have independent lifetimes.
    // Retain pending escalation and a fixed, bounded sequence of unit observations.
    const observeStop = (stopping, evidence) => {
      Promise.resolve(stopping).then(() => reconcileEvidence(evidence)).catch(() => {});
    };
    let followUpScheduled = false;
    const observeLater = evidence => {
      if (followUpScheduled || evidence?.isolationMode !== 'systemd-unit' || !evidence.unitName) return;
      followUpScheduled = true;
      cancelFollowUp = recoveryModule.observeLateStopEvidence(() => reconcileEvidence(evidence));
    };
    const settleRecovery = (outcome) => {
      if (recoverySettled) return;
      recoverySettled = true;
      try {
        // #2915 round 8 (D5, review 7 finding 9): `settleDirectWorker`
        // RETURNS a promise (resolving to a bounded refund-failure
        // diagnostic string, or `null`) — capture it instead of discarding
        // it, so `run()`'s wrapper above can await it and surface the
        // diagnostic in the result.
        settlementPromise = recoveryModule.settleDirectWorker(admission, {
          ...outcome, callerAborted: !!registry.get(entry.invocationId)?.cancelRequested,
        });
        captureSettlementPromise?.(settlementPromise);
      } catch { /* recovery accounting must never fail a run */ }
      settlementStarted();
      if (!outcome.confirmedStop) observeLater(isolationEvidence);
    };
    let recoveryDeadlineAtMs = 0;
    const settleObservedFailure = async (result, failureHint = '') => {
      await recoveryModule.observeLauncherRecoveryOutcome({ invocation, result, failureHint,
        installation: drivers[invocation.selected.cli]?.qualification?.installation, breaker: admission.breaker,
        timeoutMs: () => Math.min(10_000, recoveryDeadlineAtMs - admission.breaker.nowMs()),
        beforeRequest: async () => !registry.get(entry.invocationId)?.cancelRequested,
        onDispatch: () => recoveryModule.chargeDirectWorkerDiagnostic(admission, {
          deadlineAtMs: recoveryDeadlineAtMs, nowMs: admission.breaker.nowMs,
          isCancelled: () => !!registry.get(entry.invocationId)?.cancelRequested }) });
      settleRecovery({ ...recoveryModule.classifyAttemptForSettlement(invocation, result, admission),
        confirmedStop: result.confirmedStop });
    };
    try {
      // #2915 round 8 review 8 (C3): ONE absolute wall-clock deadline for
      // this attempt, computed HERE — at the very top of this function,
      // BEFORE any brief preparation — as the minimum of the task/health
      // budget, the transport (mcp per-call) budget when this is an
      // mcp-transport attempt, and the canary's own bounded window when
      // this admission is the breaker's canary, on the admission's own
      // monotonic clock. Passed down UNCHANGED from here on; NEVER
      // re-derived from an already-shortened duration. Computing this AFTER
      // brief preparation (the former position, right before the
      // transport-specific branches below) let preparation time elapse for
      // free: reproduced spending 60s in post-admission brief
      // validation/digest computation while a 30s native MCP call still
      // spawned and completed, because the deadline was derived from a
      // fresh `deadlineClockNow()` reading taken only after that
      // preparation finished (round 8 review 8, C3; review 7 finding 4's
      // last bullet).
      const taskDeadlineMs = Math.min(invocation.health?.hardTimeoutSeconds ?? invocation.limits.wallSeconds, invocation.limits.wallSeconds) * 1000;
      const deadlineClockNow = () => admission.breaker?.nowMs?.() ?? Date.now();
      const deadlineCandidatesMs = [admissionGuard?.deadlineAtMs ?? ((admission.startedAtMs ?? deadlineClockNow()) + taskDeadlineMs)];
      if (invocation.transport === 'mcp') deadlineCandidatesMs.push((admission.startedAtMs ?? deadlineClockNow()) + invocation.mcp.timeoutSeconds * 1000);
      if (admission.token?.canaryKeys?.length > 0) deadlineCandidatesMs.push(admission.token.deadlineMs);
      const deadlineAtMs = Math.min(...deadlineCandidatesMs);
      recoveryDeadlineAtMs = deadlineAtMs;
      // #2915 round 8 review 8 (C3): cancellation predicate, read from the
      // registry's own live `cancelRequested` flag — set by `cancel()`
      // (M2) at any point during this run's lifetime, including before any
      // launch/control handle exists. Folded into `dispatchGuard` below so
      // the leaf dispatch-commit hook (D2) refuses to spawn a cancelled
      // attempt, and threaded into the native-MCP per-request/write-boundary
      // checks so cancellation during pre-spawn preparation prevents the
      // spawn and any request (round 8 review 8, C3).
      const isCancelled = () => !!registry.get(entry.invocationId)?.cancelRequested;
      // #2915 round 8 review 8 (C3): passed to both launch paths so the D2
      // leaf hook re-checks deadline/cancellation immediately before the
      // real process-start call, after every preparation step has run.
      const dispatchGuard = { deadlineAtMs, nowMs: deadlineClockNow, isCancelled };
      // F4 (fix-2892-r2, formerly part of M5): per operator decision, the
      // MCP path REQUIRES the structured WorkerDirectBrief — a probe showed
      // a plaintext brief (or a JSON brief swapped to plaintext between
      // launch and result assembly) was accepted, bypassing digest
      // verification entirely and completing anyway, because
      // `tryAssembleDirectResult` below treats a non-JSON brief as "nothing
      // to assemble against" and best-effort no-ops rather than refusing.
      // Fixed: for `mcp` transport ONLY, validate — AT ADMISSION, BEFORE any
      // launch — that the brief parses as a WorkerDirectBrief (#2890/#2879
      // codec), and pin ITS digest ourselves (never relying on whatever
      // `invocation.briefDigest` #2887's own resolver may or may not have
      // set for this transport). A non-structured or schema-invalid brief
      // refuses before any worker ever runs.
      let mcpBriefDigest;
      if (invocation.transport === 'mcp') {
        let briefBytes;
        try {
          briefBytes = await readBoundedFile(request.brief, 262144, root);
        } catch {
          // #2915 review 4 (finding 2): this pre-spawn refusal happens
          // AFTER admission (above) but was never settling it — a leaked
          // reservation on every unreadable MCP brief.
          //
          // #2915 review 6 (finding 4, "stop evidence on every settlement"):
          // zero workers were ever dispatched for this reservation — settle
          // with `confirmedStop: true` so a canary whose own deadline has
          // already passed (e.g. an expired queued request) releases its
          // reservation outright instead of leaving a permanent blocking
          // marker behind for an attempt that never ran at all.
          settleRecovery({ kind: 'uncertain', confirmedStop: true });
          return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: ['OG_BRIEF_UNREADABLE'] });
        }
        try {
          const { assertValidWorkerPayload } = await loadMissionProtocol();
          assertValidWorkerPayload('workerDirectBrief', JSON.parse(briefBytes.toString('utf8')));
        } catch (error) {
          // Fixed-vocabulary diagnostic only — NEVER the raw JSON.parse/
          // validator message, exactly like M5's own `parseWorkerFinal`
          // diagnostic below. A duplicate-key/planted-marker probe showed
          // this exact kind of path can otherwise reflect attacker/worker-
          // controlled input text straight back out to the caller.
          //
          // #2915 review 6 (finding 4): zero workers dispatched — same
          // proven-never-dispatched settlement as above.
          settleRecovery({ kind: 'uncertain', confirmedStop: true });
          return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: workerFailureDiagnostics(error, 'workerDirectBrief', 'OG_BRIEF_NOT_STRUCTURED') });
        }
        mcpBriefDigest = `sha256:${createHash('sha256').update(briefBytes).digest('hex')}`;
      }
      let observation;
      let rawOutput;
      // #2915 review 5 ("a second worker over unresolved execution"): a
      // SEPARATE fact from `kind` threaded into every `settleRecovery` call
      // below — whether THIS attempt's own descendant tree is launcher-
      // confirmed stopped, so a settlement arriving against an already-
      // canary-deadline-expired reservation can resolve that reservation's
      // blocking marker (see `ScopedFailureBreaker.settle()`). Stays false
      // for native MCP (response completion is not stop proof).
      let confirmedStop = false;
      if (invocation.transport === 'shell') {
        // #2915 round 8 (D2, replaces the former `await debitRecovery()`
        // call here): the ledger debit now happens INSIDE the dispatch-
        // commit hook `planDirectWorkerLaunch`'s borrowed-admission branch
        // constructs (session-launcher.mjs), invoked by `launchIsolatedWorker`
        // itself immediately before the real process-start call — never
        // here, before the dispatch resource gate inside `launchShellWorkerImpl`
        // has even run. This closes the "MCP debits before queue/resource
        // refusals" gap (#2915 round 8 critique, D2): a resource-gate
        // refusal below now spends nothing.
        //
        // #2915 round 8 (D5): checked before spawn. A deadline already
        // passed before this bridge even attempted to spawn is a proven
        // zero-dispatch refusal, exactly like any other pre-spawn gate
        // refusal.
        //
        // #2915 round 8 review 8 (C3): cancellation itself is deliberately
        // NOT re-checked here (unlike the deadline) -- the authoritative
        // "prevent the spawn" enforcement for cancellation lives in
        // `dispatchGuard` below, re-checked inside the LEAF dispatch-commit
        // hook (D2) after every real preparation step the actual launch
        // performs. Adding a second, earlier check at this bridge level,
        // ahead of even invoking `launchShellWorkerImpl`, would race an
        // operator cancel arriving while an in-flight (but not yet
        // resolved) launch call is still legitimately starting, and
        // mis-refuse a launch that was already under way.
        if (deadlineClockNow() >= deadlineAtMs) {
          settleRecovery({ kind: 'uncertain', confirmedStop: true });
          return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: ['worker dispatch deadline already passed before spawn'] });
        }
        // `spawnAttempted` is still set BEFORE calling, not after inspecting
        // the result -- `launchShellWorkerImpl` itself may already have side
        // effects (dispatch gate sampling, resource checks, or a genuine
        // spawn) before it returns or throws, so a throw from WITHIN it can
        // never be proven to be pre-spawn. From here on, any exception
        // reaching the outer catch-all is post-spawn uncertainty.
        spawnAttempted = true;
        execution.mayHaveLaunched = true;
        const launch = await launchShellWorkerImpl(invocation, { allowDegraded, config: snapshot.config,
          name: `mcp-${entry.invocationId.slice(0, 8)}`, memoryMaxGb: options.shellWorkerMemoryMaxGb,
          driver: drivers[invocation.selected.cli], servedRoot: root, stdinRuntimeRoot: options.stdinRuntimeRoot, admission, invocationId: entry.invocationId, dispatchGuard, ...gateInputs });
        let failureHint = Buffer.alloc(0);
        const observeHint = chunk => {
          if (failureHint.length < 8192) failureHint = Buffer.concat([failureHint, Buffer.from(chunk).subarray(0, 8192 - failureHint.length)]);
        };
        launch.child?.stderr?.on('data', observeHint);
        isolationEvidence = { isolationMode: launch.mode ?? null, unitName: launch.unit ?? null, child: launch.child ?? null,
          dispatchState: launch.dispatchState === 'submission-uncertain' ? 'submission-uncertain' : (launch.launched || launch.launchAttempted) ? 'dispatched' : 'never-began' };
        registry.update(entry.invocationId, { isolationMode: launch.mode ?? null });
        if (!launch.launched && !launch.launchAttempted && launch.dispatchState !== 'submission-uncertain') {
          execution.mayHaveLaunched = false;
          settleRecovery({ kind: 'uncertain', confirmedStop: true });
          return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: [launch.diagnostic ?? 'worker launch was refused'] });
        }
        // M2: a live stop handle for the duration of this call, so an
        // explicit `cancel` can actually stop the isolated unit / kill the
        // child, not just record that cancellation was requested.
        // #2915 review 4 (finding 3) / round 8 (D5): clipped to the ONE
        // absolute `deadlineAtMs` computed above (which already folds in the
        // admitted canary's own 300s window) — never re-derived from
        // `taskDeadlineMs` independently of it, and always measured as
        // "remaining from right now" so time already spent launching is
        // never double-counted.
        let deadlineMs = Math.max(0, deadlineAtMs - deadlineClockNow());
        const control = buildShellStopControl(launch, {
          waitForUnit: (unit, budgetMs, observerOptions) => (waitForUnitTerminationOverride ?? waitForUnitTermination)(unit,
            budgetMs, { ...observerOptions, clock: deadlineClockNow }),
          nowMs: deadlineClockNow,
          stopUnit: options.stopWorkerUnit ?? options.stopUnit,
          killUnit: options.killWorkerUnit,
          graceMs: options.shellStopGraceMs ?? (invocation.health?.terminateGraceSeconds ?? 1) * 1000,
          onConfirmed: async outcome => {
            // The shell observer proved an accepted stop plus a fresh inactive
            // unit that never exec'd; ExecMainCode alone cannot retain it.
            neverExecutedStop = outcome.neverExecuted === true;
            const stopEvidence = await resolveEvidence({ ...isolationEvidence, stopFirst: false });
            confirmedStop = stopEvidence.confirmedStop;
            observeStop(Promise.resolve(), isolationEvidence);
            if (!launch.launched) await cleanupReservation();
            await Promise.resolve().then(() => launch.cleanup?.()).catch(() => {});
            const live = registry.get(entry.invocationId);
            if (live?.terminalAt !== null) return;
            if (live.status === 'uncertain' || live.status === 'blocked') {
              registry.markTerminal(entry.invocationId, { control: null, termination: 'confirmed',
                status: live.cancelRequested ? 'cancelled' : 'failed' });
            } else registry.update(entry.invocationId, { control: null, termination: 'confirmed' });
          },
        });
        if (registry.get(entry.invocationId)?.termination !== 'confirmed') {
          registry.update(entry.invocationId, { control });
        }
        // Honor a cancel that arrived while the launcher was still pending.
        if (registry.get(entry.invocationId)?.cancelRequested) await control.stop();
        let outcome = launch.launched ? await control.wait(deadlineMs, { deadlineAtMs, nowMs: deadlineClockNow }) : await control.stopAndConfirm();
        // Preserve the control's timeout latch and refuse a late clean outcome.
        if (outcome.termination === 'confirmed' && !outcome.timedOut && deadlineClockNow() >= deadlineAtMs) {
          outcome = { ...outcome, timedOut: true };
        }
        const stopEvidence = await resolveEvidence({ ...isolationEvidence, stopFirst: false });
        confirmedStop = stopEvidence.confirmedStop;
        // #2915 review 6 (finding 1, "false recovery after timeout"): a
        // forced stop at the attempt's own deadline is never treated as a
        // candidate success, regardless of the exit code the forced stop
        // happened to observe (a systemd unit whose main process had
        // already legitimately exited 0 right before the stop escalation
        // fired reports exactly that exit code even though the attempt
        // itself was never allowed to run to its own completion). Preserved
        // independently of `outcome.exitCode`/`outcome.termination` through
        // to the candidate-success gate below (`strictlyCompleted`).
        observation = { transport: 'shell', status: outcome.termination === 'confirmed' && outcome.exitCode === 0 && !outcome.timedOut ? 'completed' : 'failed', termination: outcome.termination, exitCode: outcome.exitCode, timedOut: !!outcome.timedOut };
        // #2915 final (evidence contract): the attempt-level fact is derived
        // from this bridge's own launcher-observed wait status — never a
        // worker claim — independent of `termination`/`descendants` above.
        // `termination === 'confirmed'` here already reflects THIS bridge's
        // own trusted observation (systemd-unit query, or this process's own
        // `child.close` event).
        //
        // #2915 review 5 (finding 1a, "false recovery"): a definite BAD exit
        // is trustworthy failure evidence regardless of what happens
        // downstream, so it settles immediately. A confirmed CLEAN exit
        // (`exitCode === 0`) is only a CANDIDATE success -- settlement is
        // deferred past strict final-claims validation, brief-evidence
        // matching and the cancellation check below (common code, shared
        // with the MCP branch), so a worker that exits 0 but never produces
        // a valid, matching, uncancelled completed claim can never close a
        // scope through this path. Uncertain termination never implicates
        // anything either way.
        launch.child?.stderr?.removeListener('data', observeHint);
        if (outcome.termination !== 'confirmed') {
          settleRecovery({ kind: 'uncertain', confirmedStop });
          // M2: stays LIVE — capacity is held until a stop is proven or the
          // conductor disposes of it explicitly, never freed on a mere
          // unconfirmed-termination timeout.
          return (confirmedStop ? registry.markTerminal : registry.update)(entry.invocationId, {
            status: launch.launched ? 'uncertain' : 'blocked', termination: confirmedStop ? 'confirmed' : 'uncertain',
            diagnostics: ['worker termination could not be confirmed before the deadline'],
          });
        }
        if (outcome.exitCode !== 0) {
          if (!failureHint.length && invocation.stderrPath) {
            try { failureHint = await readBoundedFile(invocation.stderrPath, 8192, root); } catch { /* no usable hint */ }
          }
          await settleObservedFailure({ ...outcome, invocationId: entry.invocationId, attemptOutcome: 'failed',
            cancelled: !!registry.get(entry.invocationId)?.cancelRequested, confirmedStop }, failureHint.toString('utf8'));
        }
        await Promise.resolve().then(() => launch.cleanup?.()).catch(() => {
          console.error('[worker-invoke] stdin cleanup failed after confirmed termination');
        });
        if (!launch.launched) {
          settleRecovery({ kind: 'uncertain', confirmedStop });
          execution.mayHaveLaunched = false;
          return markTerminal({ control: null, status: 'failed', termination: 'confirmed',
            diagnostics: [launch.diagnostic ?? 'worker launch failed; termination confirmed'] });
        }
        if (outcome.timedOut || outcome.stopped) {
          settleRecovery({ kind: registry.get(entry.invocationId)?.cancelRequested ? 'uncertain' : 'failed', confirmedStop });
          return registry.markTerminal(entry.invocationId, { control: null, termination: 'confirmed',
            status: registry.get(entry.invocationId)?.cancelRequested ? 'cancelled' : 'failed',
            diagnostics: [outcome.timedOut ? 'worker deadline exceeded; termination confirmed' : 'worker stopped; termination confirmed'] });
        }
        try { rawOutput = await readBoundedFile(invocation.finalPath, invocation.maxOutputBytes, root); } catch {
          // #2915 review 5 (finding 1a): a confirmed clean exit that never
          // produced a readable final output is not a success -- settle
          // failed now rather than leaving it candidate-success forever
          // (the bad-exit branch above already settled; this is a no-op
          // there).
          settleRecovery({ kind: 'failed', confirmedStop });
          return registry.markTerminal(entry.invocationId, { status: 'failed', termination: 'confirmed', diagnostics: ['worker final output was not written'] });
        }
      } else {
        const { mcpRegistry, qualification } = drivers[invocation.selected.cli];
        const mcpServer = await mcpRegistry.get(invocation.mcp.serverRef);
        if (!mcpServer) {
          // #2915 review 4 (finding 2): another pre-spawn refusal after
          // admission that was never settling it.
          //
          // #2915 review 6 (finding 4): proven zero dispatch.
          settleRecovery({ kind: 'uncertain', confirmedStop: true });
          return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: ['worker MCP server is not registered'] });
        }
        // F5: pin the qualified server's definition digest NOW, at
        // admission, so a queued launch can detect a registry edit that
        // happened while it was waiting (see `serverDefinitionDigest`).
        const qualifiedServerDigest = serverDefinitionDigest(mcpServer);
        // #2915 review 5 ("a second worker over unresolved execution") /
        // round 8 (D5): clipped to the ONE absolute `deadlineAtMs` computed
        // above — never re-derived independently of it (that re-derivation,
        // against `admission.token.deadlineMs` alone, used to miss the
        // plain task-deadline case entirely and was also the source of the
        // "subtracts preparation time twice" defect once `defaultCallMcpWorker`
        // added its OWN mint-time-relative re-derivation on top — round 8
        // critique, D5/review 7 finding 4's last bullet). This clip exists
        // for callers that only ever see `mcpBinding.timeoutSeconds` (every
        // existing injected `callMcpWorker` test double, and the ACTUAL
        // enforcement inside `defaultCallMcpWorker` uses the separately
        // threaded `deadlineAtMs` below, never re-adding onto
        // `admission.token.mintedAtMs`.
        let mcpBinding = invocation.mcp;
        const remainingSeconds = Math.max(0, (deadlineAtMs - deadlineClockNow()) / 1000);
        if (remainingSeconds < mcpBinding.timeoutSeconds) mcpBinding = { ...mcpBinding, timeoutSeconds: remainingSeconds };
        // #2915 round 8 (D2, replaces the former `await debitRecovery()`
        // call here): same reasoning as the shell path above — the ledger
        // debit now happens inside the dispatch-commit hook, deep inside
        // `defaultLaunchMcpWorkerProcess` -> `planDirectWorkerLaunch` ->
        // `launchIsolatedWorker`, immediately before the real MCP worker
        // SERVER process actually starts.
        //
        // `spawnAttempted` is still set BEFORE calling, not after
        // inspecting `result.outcome` -- `callMcpWorkerImpl` itself may
        // already have launched a real MCP server process and sent bytes
        // before it returns or throws (#2892 F2's own "thrown MCP transport
        // error stays LIVE" case is exactly this), so a throw from WITHIN
        // it can never be proven to be pre-spawn.
        spawnAttempted = true;
        execution.mayHaveLaunched = true;
        const result = await callMcpWorkerImpl(mcpBinding, mcpServer, {
          sessionIsolation: invocation.mcp.sessionIsolation, mcpRegistry, allowDegraded, config: snapshot.config,
          // #2915 round 8 (D5): the ONE absolute deadline for this call,
          // computed once above.
          deadlineAtMs,
          // #2892 (CI fix): the resolved invocation's own worktree
          // (`invocation.cwd`, #2887's `request.workdir`) — without it the
          // dispatch gate's free-disk sample has no filesystem to read and
          // fails closed on every host, never reaching isolation at all.
          // See `defaultLaunchMcpWorkerProcess`'s doc comment.
          cwd: invocation.cwd,
          name: `mcp-${entry.invocationId.slice(0, 8)}`, memoryMaxGb: mcpWorkerMemoryMaxGb, mcpSchemas: qualification?.mcpSchemas,
          qualifiedServerDigest, registerControl: control => registry.update(entry.invocationId, { control }),
          // #2915 review 4 (finding 2): the SAME top-level admission this
          // run() already holds, borrowed through to the native-MCP launch
          // path — never a second, independent planner reservation. See
          // `defaultLaunchMcpWorkerProcess`.
          admission,
          // #2915 round 8 review 8 (C6/C3): independently resolved dispatch
          // identity (never derived from the borrowed admission wrapper) and
          // the one dispatch-commit deadline/cancellation guard, threaded
          // all the way to the leaf hook.
          invocation, invocationId: entry.invocationId, dispatchGuard, isCancelled, observeStop,
          ...gateInputs,
        });
        isolationEvidence = { isolationMode: result.isolationMode ?? null, unitName: result.unitName ?? null,
          child: result.child ?? null, dispatchState: result.dispatchState ?? 'dispatched' };
        if (result.outcome === 'blocked') {
          // Never launched (dispatch gate or queue refusal): settle with no
          // failure evidence.
          //
          // #2915 round 8 review 8 (C2): a `blocked` outcome does NOT always
          // mean proven zero dispatch -- a schema-drift refusal (or any
          // other post-connect `blocked` return) happens AFTER a real MCP
          // worker server process was spawned and connected to
          // (`result.dispatchState === 'dispatched'`). Resolve REAL stop
          // evidence for that case through the shared `resolveStopEvidence`
          // (a server that ignores close/TERM/KILL must never be reported
          // confirmed-stopped) rather than hardcoding `confirmedStop: true`
          // for every `blocked` label (review 8, C section finding 2: "an
          // MCP blocked result AFTER a process was spawned is dispatched").
          // Every pre-spawn `blocked` path inside `callMcpWorkerImpl`
          // (registry requalification, admission-expiry, a thrown
          // pre-launch exception, or a proven pre-spawn launch refusal)
          // carries `dispatchState: 'never-began'` (or `'submission-
          // uncertain'` for a failed/timed-out systemd-run submission) and
          // is handled accordingly — ALWAYS proven zero dispatch only for
          // `'never-began'`.
          let blockedConfirmedStop;
          if (result.dispatchState === 'dispatched' || result.dispatchState === 'submission-uncertain') {
            const evidence = await resolveEvidence(isolationEvidence);
            blockedConfirmedStop = evidence.confirmedStop;
          } else {
            blockedConfirmedStop = true;
            execution.mayHaveLaunched = false;
          }
          settleRecovery({ kind: 'uncertain', confirmedStop: blockedConfirmedStop });
          return blockedConfirmedStop ? markTerminal({
            status: 'blocked', termination: 'confirmed',
            diagnostics: [result.diagnostic ?? 'worker MCP launch was refused'],
          }) : registry.update(entry.invocationId, {
            status: 'blocked', termination: blockedConfirmedStop ? 'confirmed' : 'uncertain',
            diagnostics: [result.diagnostic ?? 'worker MCP launch was refused'],
          });
        }
        confirmedStop = (await resolveEvidence({ ...isolationEvidence, stopFirst: false })).confirmedStop;
        if (result.outcome !== 'responded') {
          // Overflow holds capacity and stop control until termination is proven.
          if (result.diagnostic?.includes('OG_WORKER_MCP_FRAME_TOO_LARGE')) {
            settleRecovery({ kind: 'uncertain', confirmedStop });
            // An explicit cancel can have confirmed termination while this run
            // was awaiting its initial overflow evidence.
            if (entry.terminalAt !== null) return entry;
            const patch = { status: result.termination === 'confirmed' ? 'failed' : 'uncertain',
              termination: result.termination ?? 'uncertain', diagnostics: [result.diagnostic] };
            return result.termination === 'confirmed'
              ? registry.markTerminal(entry.invocationId, { ...patch, control: null })
              : registry.update(entry.invocationId, patch);
          }
          // M2: stays LIVE for the same reason as the shell timeout path above.
          settleRecovery({ kind: 'uncertain', confirmedStop });
          return (confirmedStop ? registry.markTerminal : registry.update)(entry.invocationId, {
            status: 'uncertain', termination: confirmedStop ? 'confirmed' : 'uncertain',
            diagnostics: [`worker ${result.outcome}; cancellation delivered`],
          });
        }
        rawOutput = result.response;
        observation = { transport: 'mcp', status: result.response.isError ? 'failed' : 'completed', termination: 'confirmed', exitCode: result.response.isError ? 1 : null, isError: !!result.response.isError };
        // #2915 final (evidence contract): a transport-correlated response
        // that is not `isError` is a CANDIDATE successful attempt even
        // though `exitCode` is legitimately `null` for MCP (#2915 final
        // review, finding 4: "successful responses produce exitCode:null...
        // recorded one invocation failure and left the shared canary
        // active" — the former exitCode-based classification treated every
        // successful MCP response as a failure). Descendant-stop evidence is
        // a separate, independent fact this bridge never claims here.
        //
        // #2915 review 5 (finding 1a): an `isError` response IS trustworthy
        // failure evidence and settles immediately, exactly like a
        // confirmed bad exit above. A non-error response is only a
        // CANDIDATE -- settlement is deferred to the common code below,
        // past strict final-claims validation, brief-evidence matching and
        // the cancellation check, so a transport-correlated response alone
        // can never close a scope.
        if (result.response.isError) {
          await settleObservedFailure({ invocationId: entry.invocationId, attemptOutcome: 'failed',
            termination: 'confirmed', exitCode: 1, confirmedStop,
            cancelled: !!registry.get(entry.invocationId)?.cancelRequested }, JSON.stringify(result.response).slice(0, 8192));
          return registry.markTerminal(entry.invocationId, { status: 'failed', termination: 'confirmed', diagnostics: ['worker reported isError'] });
        }
      }
      const { ProviderAdapter } = await loadRalphExternal('lib/provider-adapter.mjs');
      let claims;
      try {
        claims = await new (class extends ProviderAdapter {})().parseWorkerFinal(rawOutput, {
          format: invocation.transport === 'shell' ? 'jsonl' : 'mcp', observation, maxOutputBytes: invocation.maxOutputBytes,
        });
      } catch (error) {
        // #2915 review 5 (finding 1a): the strict parse itself rejected the
        // claims -- the candidate success from above is settled failed
        // here, never left to default to an earlier premature success.
        //
        // #2915 review 6 (finding 4, "stop evidence on every settlement"):
        // thread the shell path's own launcher-confirmed termination fact
        // (`confirmedStop`) through here too — a late systemd completion
        // with confirmed termination but invalid claims must not retain a
        // permanent blocking marker merely because this rejection path
        // omitted it. Stays `false` for native MCP (unaffected).
        settleRecovery({ kind: 'failed', confirmedStop });
        // M5: bounded, fixed-vocabulary diagnostic only — never the raw
        // parser error message, which can echo attacker/worker-controlled
        // input text back out (a duplicate-key probe reflected a planted
        // marker through this exact path before the fix).
        return registry.markTerminal(entry.invocationId, { status: 'failed', termination: 'confirmed', diagnostics: workerFailureDiagnostics(error, 'workerClaims', 'OG_WORKER_FINAL_INVALID') });
      }
      const assembled = await tryAssembleDirectResult({ request, invocation, observation, claims, root,
        briefDigest: mcpBriefDigest, requireStructuredBrief: invocation.transport === 'mcp' });
      if (assembled?.conflict) {
        // #2915 review 5 (finding 1a): the brief changed between launch and
        // result assembly -- a candidate success settles failed here, never
        // silently assembled (or recorded recovered) against a different
        // brief than the one the worker was actually launched against.
        //
        // #2915 review 6 (finding 4): same `confirmedStop` threading as the
        // parse-failure path above.
        settleRecovery({ kind: 'failed', confirmedStop });
        return registry.markTerminal(entry.invocationId, { status: 'failed', termination: 'confirmed', diagnostics: ['OG_BRIEF_EVIDENCE_CONFLICT'] });
      }
      // M2: a cancel requested at ANY point during this run's lifetime —
      // even before a live `control` handle existed to deliver it to — means
      // this result is never trusted as `completed`, regardless of what the
      // worker itself claims.
      const liveEntry = registry.get(entry.invocationId);
      const cancelled = !!liveEntry?.cancelRequested;
      // #2915 review 6 (finding 1, "false recovery after timeout"): a
      // timed-out attempt (the shell path's own forced-stop-at-deadline
      // observation, see `observation.timedOut` above) is never treated as
      // strictly completed, regardless of what a worker claim says or what
      // exit code the forced stop happened to observe.
      const strictlyCompleted = claims.status === 'completed' && !observation?.timedOut;
      // #2915 review 5 (finding 1a): this is the ONE place a candidate
      // success (deferred above) is finally settled -- only after strict
      // completed claims, matching brief evidence (no conflict, checked
      // above) and the cancellation check all agree. A cancelled run never
      // settles 'succeeded' even with valid claims (the operator asked to
      // stop it); an invalid/non-completed claim settles 'failed', exactly
      // like every other claim-rejection path above.
      settleRecovery({ kind: cancelled ? 'uncertain' : strictlyCompleted ? 'succeeded' : 'failed', confirmedStop });
      return registry.markTerminal(entry.invocationId, {
        status: cancelled ? 'cancelled' : (strictlyCompleted ? 'completed' : 'failed'),
        termination: 'confirmed',
        result: assembled?.result ?? { claims },
      });
    } catch (error) {
      // Registry status and an error label do not establish descendant stop.
      if (error.workerNotLaunched) execution.mayHaveLaunched = false;
      const neverDispatched = !spawnAttempted || !!error.workerNotLaunched;
      const confirmedStop = neverDispatched || (await resolveEvidence({ ...isolationEvidence, stopFirst: false })).confirmedStop;
      settleRecovery({ kind: 'uncertain', confirmedStop });
      if (neverDispatched) {
        return markTerminal({ status: 'blocked', termination: 'confirmed', diagnostics: [error.message] });
      }
      if (confirmedStop) {
        return registry.markTerminal(entry.invocationId, { control: null,
          status: registry.get(entry.invocationId)?.cancelRequested ? 'cancelled' : 'failed',
          termination: 'confirmed', diagnostics: [error.message] });
      }
      // Keep capacity and stop control while execution remains unresolved.
      return registry.update(entry.invocationId, { status: 'uncertain', termination: 'uncertain', diagnostics: [error.message] });
    }
  }

  async function tryAssembleDirectResult({ request, invocation, observation, claims, root, briefDigest, requireStructuredBrief }) {
    // M5 (and F4 for mcp): `briefDigest` (fix-2892-r2) is THIS run's own
    // admission-time pin for the `mcp` transport — computed and validated
    // BEFORE launch, in `run()` — and always takes priority over
    // `invocation.briefDigest` (which #2887's own resolver populates for
    // EVERY transport, structured brief or not); falling back to the
    // latter preserves the shell path's pre-existing behavior unchanged.
    const pinnedDigest = briefDigest ?? invocation.briefDigest;
    try {
      const briefBytes = await readBoundedFile(request.brief, 262144, root);
      const text = briefBytes.toString('utf8');
      if (!text.trimStart().startsWith('{')) {
        // F4: `requireStructuredBrief` (true only for `mcp`, where THIS
        // run's own admission already proved the brief was structured
        // JSON) is the signal here — NOT merely "a digest happens to be
        // pinned", since #2887's resolver pins `invocation.briefDigest` for
        // every transport, plain-text brief or not. Without that
        // distinction, an ordinary plain-text SHELL brief (never required
        // to be structured) would be misreported as a changed-brief
        // conflict merely because a digest existed. For `mcp`, a brief
        // that is no longer JSON at all by result-assembly time IS itself
        // evidence of a changed brief — without this, swapping a JSON
        // brief to plaintext between launch and assembly bypassed digest
        // verification entirely and still completed.
        if (requireStructuredBrief) return { conflict: true };
        return null; // plain-text brief; no WorkerDirectBrief to assemble against
      }
      if (pinnedDigest) {
        const liveDigest = `sha256:${createHash('sha256').update(briefBytes).digest('hex')}`;
        if (liveDigest !== pinnedDigest) return { conflict: true };
      }
      const { assertValidWorkerPayload, assembleWorkerResult } = await loadMissionProtocol();
      const brief = JSON.parse(text);
      assertValidWorkerPayload('workerDirectBrief', brief);
      const execution = {
        status: observation.status === 'completed' ? 'completed' : 'failed',
        exitCode: observation.exitCode, requested: invocation.selected,
        observedModel: null, observedFamily: null, observedEffort: null,
        identityEvidence: [], identityQuality: 'unavailable',
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), termination: observation.termination,
        usage: { inputTokens: null, outputTokens: null, cacheTokens: null, reasoningTokens: null, costUsd: null, quality: 'unknown', reservedTokens: 0, reservedUsd: null },
        failure: observation.status === 'completed' ? null : { class: 'unknown', message: 'Worker did not report a completed claim', retryable: false },
      };
      // Never self-accept: acceptance requires a separate verifier with an
      // independently-verified artifact digest. This bridge only proves
      // observed process/transport termination and parsed claims.
      const verification = { status: 'pending', verifierId: null, runnerRef: null, artifactDigest: null, evidence: [], findings: [], controlledContext: null };
      return { result: assembleWorkerResult({ brief, execution, worker: claims, verification }) };
    } catch {
      // F4: the same `requireStructuredBrief` reasoning as above — a brief
      // that was provably structured at admission (mcp only) but now fails
      // to re-parse/re-validate at all is a conflict, not a silent no-op.
      if (requireStructuredBrief) return { conflict: true };
      return null; // best-effort enrichment only; the bounded claims result above always stands
    }
  }

  async function status(input) {
    const { projectRecoveryStatus, mergeRecoveryStatuses } = await importImpl('mission-protocol/worker-status.js');
    const recoveryStatus = breaker => projectRecoveryStatus(typeof breaker?.recoveryStatus === 'function'
      ? { ...breaker.recoveryStatus(), observedAt: now().toISOString() } : null, 'live');
    if (!input.invocation_id) {
      // #2915 round 8 (D4): ordinary status, read-only, no id — lists every
      // invocation this server currently tracks as a `dispatched` reservation
      // with `stop: 'unresolved'`, across every distinct breaker instance
      // any tracked invocation's gated admission used. Never mutates
      // anything (`listUnresolvedStops` is a pure read accessor on the
      // breaker); this is the "reachable for every long-lived owner" route
      // C4 requires, surfaced here rather than printed-only.
      const breakers = new Set(registry.recoveryOwner ? [registry.recoveryOwner] : []);
      for (const entry of registry.values()) if (entry.recoveryBreaker) breakers.add(entry.recoveryBreaker);
      const unresolvedReservations = [];
      for (const breaker of breakers) {
        if (typeof breaker.listUnresolvedStops === 'function') unresolvedReservations.push(...breaker.listUnresolvedStops());
      }
      const interventionScopes = [...breakers].flatMap(breaker => (breaker.snapshot?.().scopes ?? [])
        .filter(scope => scope.state === 'operator-intervention')
        .map(scope => ({ scopeId: scope.scopeKey, reason: scope.operatorReason,
          resetInstruction: { operation: 'reset_recovery_scope', scope_id: scope.scopeKey } })));
      const recovery = mergeRecoveryStatuses([...breakers].map((breaker, index) => {
        const status = recoveryStatus(breaker);
        if (breakers.size > 1) {
          for (const scope of status.scopes) scope.owner = `owner-${index + 1}`;
          for (const transition of status.transitions) transition.owner = `owner-${index + 1}`;
        }
        return status;
      }));
      return { unresolvedReservations, interventionScopes, recovery };
    }
    const entry = registry.get(input.invocation_id);
    if (!entry) throw new Error('Unknown invocation_id');
    return { ...publicStatus(entry, healthHook), recovery: recoveryStatus(entry.recoveryBreaker ?? registry.recoveryOwner) };
  }

  /**
   * #2915 round 8 (D4, "reconciliation route"): the explicit operator-
   * authorized reconciliation operation on this SAME `worker-invoke`
   * status/cancel handler — it already runs inside the owning server and
   * closes over its registry. Accepted ONLY for an invocation whose stored
   * reservation is `dispatched` with `stop: 'unresolved'` (verified via
   * `ScopedFailureBreaker.hasUnresolvedStop`, a pure read accessor — never
   * inferred from this registry's own, separately-maintained status
   * fields). Applied to THAT invocation's actual breaker (`entry.
   * recoveryBreaker`, pinned at admission — never a fresh default breaker).
   * Idempotent: a second call finds nothing left to reconcile and reports
   * why, rather than throwing or re-applying anything. No mailbox files;
   * nothing is written anywhere other than the breaker's own in-memory
   * reservation table.
   */
  async function reconcileStopped(input) {
    if (!input.invocation_id) throw new Error('reconcile_stopped requires invocation_id');
    const entry = registry.get(input.invocation_id);
    if (!entry) throw new Error('Unknown invocation_id');
    const breaker = entry.recoveryBreaker ?? null;
    const base = publicStatus(entry, healthHook);
    if (!breaker || typeof breaker.hasUnresolvedStop !== 'function') {
      return { ...base, reconciled: false, reconcileReason: 'this invocation has no tracked gated reservation to reconcile' };
    }
    if (!breaker.hasUnresolvedStop(entry.invocationId)) {
      return { ...base, reconciled: false, reconcileReason: 'no dispatched reservation with unresolved stop evidence exists for this invocation (already reconciled, never dispatched, or already confirmed stopped)' };
    }
    const result = breaker.reconcileStopEvidence({ invocationId: entry.invocationId, confirmedStop: true });
    const applied = (result?.released ?? 0) > 0;
    // #2915 round 8 review 8 (C7): applying a confirmed stop must ALSO
    // finalize this invocation's registry capacity -- a dispatched
    // reservation with unresolved stop kept this entry's run-slot
    // effectively pinned (the registry's own `hasUnresolvedStopMarker`
    // exemption, above, retains it past the ordinary terminal sweep for
    // exactly this reason). `markTerminal({})` sets `terminalAt` without
    // touching `status` -- a truthful terminal state that never invents
    // task success for an attempt whose own outcome this bridge still
    // never confirmed. Idempotent: a no-op if the entry was already
    // terminal.
    if (applied) registry.markTerminal(entry.invocationId, {});
    return {
      ...publicStatus(entry, healthHook),
      reconciled: applied,
      ...(applied ? {} : { reconcileReason: 'reservation was already reconciled or no longer exists' }),
    };
  }

  async function resetRecoveryScope(input) {
    if (!input.scope_id) throw new Error('reset_recovery_scope requires scope_id');
    const breaker = registry.recoveryOwner;
    if (!breaker) throw new Error('No recovery breaker owner is bound to this registry');
    return { scopeId: input.scope_id, ...breaker.reset(input.scope_id) };
  }

  async function cancel(input) {
    const entry = registry.get(input.invocation_id);
    if (!entry) throw new Error('Unknown invocation_id');
    registry.update(entry.invocationId, { cancelRequested: true });
    // M2: actually deliver the cancellation when a live control handle
    // exists (the run has an in-flight shell/MCP transport call right now);
    // `cancelDelivered` reports delivery accurately — it is set ONLY when
    // the stop signal was actually transmitted, never unconditionally.
    if (entry.terminalAt === null && entry.control) {
      let delivered = false;
      let evidence;
      try {
        const result = await entry.control.stop();
        evidence = result && typeof result === 'object' ? result : undefined;
        delivered = evidence ? evidence.delivered === true : !!result;
      } catch { delivered = false; }
      registry.update(entry.invocationId, { cancelDelivered: delivered });
      if (evidence?.termination === 'confirmed') {
        registry.markTerminal(entry.invocationId, { status: 'cancelled', termination: 'confirmed', control: null });
      }
    }
    // Cancellation delivery is recorded; it is NEVER treated as stop proof.
    // Overflow's retained control can separately prove termination through the
    // same stop authority used by the run; delivery alone never frees capacity.
    return publicStatus(registry.get(entry.invocationId), healthHook);
  }

  server.registerTool('worker-invoke', {
    title: 'Invoke or Observe a Direct-Handoff Worker',
    description: "Run, check, cancel, or reconcile stop evidence for a qualified worker without any Mission/MC session — same policy/brief/claims path as the shell direct-handoff tier. Degraded isolation is a server-side operator setting only; there is no client-facing switch. Cancel delivery is not stop confirmation. 'status' with no invocation_id lists invocations still awaiting stop-evidence reconciliation; 'reconcile_stopped' applies that reconciliation for one invocation_id once the operator has independently established its worker actually stopped. 'status' also lists interventionScopes with their reason and reset instruction; 'reset_recovery_scope' requires scope_id and resets only that owning scope after all active or unresolved executions stop, preserving cumulative allowance.",
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async input => {
    try {
      if (input.operation === 'run') return mcpJson(publicStatus(await run(input), healthHook));
      if (input.operation === 'status') return mcpJson(await status(input));
      if (input.operation === 'reset_recovery_scope') return mcpJson(await resetRecoveryScope(input));
      if (input.operation === 'reconcile_stopped') return mcpJson(await reconcileStopped(input));
      return mcpJson(await cancel(input));
    } catch (error) {
      return mcpError(`worker-invoke: ${error.message}`);
    }
  });
}

/**
 * #2892 B3: open with `O_NOFOLLOW` (never follow a symlink planted at the
 * leaf after `assertServedPath` validated it), verify via `fstat` that the
 * opened file is a regular, unaliased (`nlink === 1`) file within the byte
 * bound, and re-verify containment from the OPENED fd's own
 * `/proc/self/fd/<n>` target — not the pre-open path string — before
 * reading. This closes the gap where a path swap between validation and
 * this read could otherwise exfiltrate an arbitrary file's bytes into the
 * parsed worker claims.
 */
async function readBoundedFile(filePath, maxBytes, servedRootReal) {
  const handle = await fsOpen(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) {
      throw new Error('worker output exceeds the bounded size or is not a regular unaliased file');
    }
    if (servedRootReal !== undefined) {
      const target = await fsReadlink(`/proc/self/fd/${handle.fd}`);
      const rel = path.relative(servedRootReal, target);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new Error('worker output resolved outside the served project root after open');
      }
    }
    const buffer = Buffer.alloc(info.size);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
