/**
 * AIWG MCP Worker-Invoke Bridge (#2892)
 *
 * MCP-only conductor: resolve and invoke a worker (run/status/cancel)
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
 * This module is the FIRST MCP-side consumer of that pipeline end-to-end,
 * without a shell/CLI round trip and without Mission/MC state. It is
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
 *      scratch directory created per run at all — the leak surface is
 *      removed rather than cleaned up after the fact. The only filesystem
 *      paths this module ever creates are the caller's own `workdir` and
 *      `final_output` locations, which it never deletes (they are the
 *      conductor's, not the bridge's).
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

import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import {
  realpath, readlink as fsReadlink, open as fsOpen,
} from 'node:fs/promises';
import { existsSync, readFileSync, constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mcpError, mcpJson } from '../helpers.mjs';

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
 * ceiling for it (the same gap exists, unexercised, on the shell transport's
 * launch path). Operator-overridable via `registerWorkerInvokeToolset`'s
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
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
  await handle.close();
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

  function terminalEntries() {
    return [...entries.values()].filter(entry => entry.terminalAt !== null).sort((a, b) => a.terminalAt - b.terminalAt);
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
      Object.assign(entry, patch);
      return entry;
    },
    markTerminal(invocationId, patch = {}) {
      const entry = entries.get(invocationId);
      if (!entry) return undefined;
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

async function defaultLaunchShellWorker(invocation, { allowDegraded, config, name, live, readers, thresholdOverlay }) {
  const { planDirectWorkerLaunch } = await loadRalphExternal('session-launcher.mjs');
  // `live`/`readers`/`thresholdOverlay` are the dispatch gate's own
  // test-only passthroughs (see `planDirectWorkerLaunch`'s doc comment);
  // production registration never sets `options.gateInputs` (see
  // `registerWorkerInvokeToolset`), so these are always undefined there and
  // `checkWorkerDispatch` samples the real host.
  const launch = await planDirectWorkerLaunch({ invocation, config, allowDegraded, name, live, readers, thresholdOverlay });
  if (!launch.launched && launch.diagnostic === undefined) {
    return { ...launch, diagnostic: describeGateFailures(launch.failures) };
  }
  return launch;
}

/** Poll an already-launched systemd-unit worker to termination, bounded by
 * `deadlineMs`. Degraded-mode launches instead hand back a live `child`
 * (ChildProcess); callers await its `close`/`error` events directly and
 * never reach this poller. */
async function waitForUnitTermination(unit, deadlineMs, { pollIntervalMs = 2000, sleep = ms => new Promise(r => setTimeout(r, ms)), clock = () => Date.now() } = {}) {
  const { getWorkerIsolationStatus } = await loadRalphExternal('lib/worker-isolation.mjs');
  const deadline = clock() + deadlineMs;
  while (clock() < deadline) {
    let status;
    try { status = getWorkerIsolationStatus(unit); } catch { return { termination: 'uncertain', exitCode: null }; }
    if (!status.active) {
      return { termination: 'confirmed', exitCode: status.result === 'success' ? 0 : status.execMainStatus || 1 };
    }
    await sleep(pollIntervalMs);
  }
  return { termination: 'uncertain', exitCode: null, timedOut: true };
}

/** #2892 M2: actually stop a shell-transport worker on an explicit cancel,
 * rather than only recording that cancellation was requested. Best-effort —
 * failures are reported as `false` (not delivered), never thrown. */
function buildShellStopControl(launch) {
  return {
    stop: async () => {
      if (launch.mode === 'systemd-unit' && launch.unit) {
        try {
          const { stopWorkerUnit } = await loadRalphExternal('lib/worker-isolation.mjs');
          return !!stopWorkerUnit(launch.unit).ok;
        } catch { return false; }
      }
      if (launch.child) {
        try { launch.child.kill('SIGTERM'); return true; } catch { return false; }
      }
      return false;
    },
  };
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
export class ChildProcessTransport {
  constructor(child, { terminate = () => child.kill('SIGKILL') } = {}) {
    this._child = child;
    this._terminate = terminate;
    this._failure = undefined;
    this._closed = false;
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
        let frameBytes = this._buffer?.length ?? 0;
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
        this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
        this._drain();
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
    this._rawResponses.clear();
    this.onclose?.();
  }

  _overflow(code) {
    if (this._failure) return;
    this._failure = Object.assign(new Error(code), { code });
    this._buffer = undefined;
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
  _drain() {
    while (this._buffer) {
      const index = this._buffer.indexOf('\n');
      if (index === -1) return;
      const line = this._buffer.toString('utf8', 0, index).replace(/\r$/, '');
      this._buffer = this._buffer.subarray(index + 1);
      this._handleLine(line);
      if (this._buffer?.length === 0) this._buffer = undefined;
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
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000).unref?.())]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    this._buffer = undefined;
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
async function defaultLaunchMcpWorkerProcess(server, { allowDegraded, config, name, cwd, memoryMaxGb = DEFAULT_MCP_WORKER_MEMORY_MAX_GB, live, readers, thresholdOverlay }) {
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

async function defaultCallMcpWorker(mcpBinding, server, options = {}) {
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
    const launch = await defaultLaunchMcpWorkerProcess(server, { allowDegraded, config, name, cwd, live, readers, thresholdOverlay, ...(memoryMaxGb !== undefined ? { memoryMaxGb } : {}) });
    if (!launch.launched) {
      return { outcome: 'blocked', diagnostic: launch.diagnostic ?? 'worker MCP process launch was refused' };
    }
    const child = launch.child;
    const transport = new ChildProcessTransport(child, { terminate: () => stopOverflowWorker(launch) });
    let disconnected = false;
    transport.onclose = () => { disconnected = true; };
    const control = {
      stop: async () => {
        try {
          // F2: the ACTUAL in-flight JSON-RPC request id (captured at the
          // transport layer — see `ChildProcessTransport.send`), never the
          // caller's own opaque `mcpBinding.requestId`, which the worker has
          // no way to relate to anything it is actually processing.
          await client.notification({ method: 'notifications/cancelled', params: { requestId: transport.lastRequestId, reason: 'operator-cancel' } });
          return true;
        } catch {
          try { child.kill('SIGTERM'); return true; } catch { return false; }
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
      return { outcome: disconnected ? 'disconnected' : isTimeout ? 'timeout' : 'error', error: transport._failure ?? error,
        ...(transport._failure ? { termination: termination?.termination ?? 'uncertain',
          diagnostic: [transport._failure.code, termination?.diagnostic].filter(Boolean).join('; ') } : {}) };
    } finally {
      try { registerControl?.(null); }
      finally { try { await client.close(); } catch { /* already closed */ } }
    }
  };
  return sessionIsolation === 'per-call' ? run() : withServerQueue(mcpBinding.serverRef, run);
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

const inputSchema = z.object({
  operation: z.enum(['run', 'status', 'cancel']),
  invocation_id: z.string().uuid().optional(),
  request_id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
  role: z.enum(['efficiency', 'coding', 'reasoning']).optional(),
  task: z.string().min(1).max(256).optional(),
  group: z.string().min(1).regex(/^[a-z][a-z0-9-]{0,62}$/).optional(),
  brief: z.string().min(1).optional(),
  workdir: z.string().min(1).optional(),
  final_output: z.string().min(1).optional(),
  transport: z.enum(['shell', 'mcp']).default('shell'),
}).strict();

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
  const waitForUnitImpl = options.waitForUnitTermination ?? waitForUnitTermination;
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

  async function run(input) {
    // M1: request_id is required, and admission (capacity + replay check +
    // reservation) is entirely synchronous — no `await` between the checks
    // and `registry.create()` — so no concurrent `run()` call can observe a
    // stale "capacity available" / "request_id unused" read.
    if (!input.request_id) throw new Error('Worker invocation requires request_id (identity-bound atomic admission)');
    if (!input.role || !input.task || !input.group || !input.brief || !input.workdir || !input.final_output) {
      throw new Error('Incomplete worker invocation');
    }
    if (!registry.canStart()) throw new Error('Worker invocation capacity is reserved; no live run slot is available');
    const existing = registry.claimRequestId(input.request_id);
    if (existing) throw new Error('Worker request_id was already used; mint a fresh request_id instead of replaying');
    const entry = registry.create({ requestId: input.request_id, transport: input.transport, status: 'running', termination: 'running' });
    let request;
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
    try {
      try {
        await reserveFinalOutput(request.final_output);
      } catch {
        return registry.markTerminal(entry.invocationId, { status: 'blocked', termination: 'confirmed', diagnostics: ['final_output already exists or is not reservable as a fresh plain file'] });
      }
      const root = await servedRoot();
      const { snapshot, drivers } = await loadWorkerInputsImpl(root);
      const { resolveWorkerInvocation } = await loadServeWorkerInvocation();
      const plan = await resolveWorkerInvocation(snapshot, request, drivers, now().toISOString());
      if (plan.invocation?.readiness !== 'launchable') {
        return registry.markTerminal(entry.invocationId, { status: 'blocked', termination: 'confirmed', diagnostics: plan.diagnostics ?? [] });
      }
      const invocation = plan.invocation;
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
          return registry.markTerminal(entry.invocationId, { status: 'blocked', termination: 'confirmed', diagnostics: ['OG_BRIEF_UNREADABLE'] });
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
          return registry.markTerminal(entry.invocationId, { status: 'blocked', termination: 'confirmed', diagnostics: [typeof error?.code === 'string' ? error.code : 'OG_BRIEF_NOT_STRUCTURED'] });
        }
        mcpBriefDigest = `sha256:${createHash('sha256').update(briefBytes).digest('hex')}`;
      }
      const deadlineMs = Math.min(invocation.health?.hardTimeoutSeconds ?? invocation.limits.wallSeconds, invocation.limits.wallSeconds) * 1000;
      let observation;
      let rawOutput;
      if (invocation.transport === 'shell') {
        const launch = await launchShellWorkerImpl(invocation, { allowDegraded, config: snapshot.config, name: `mcp-${entry.invocationId.slice(0, 8)}`, ...gateInputs });
        registry.update(entry.invocationId, { isolationMode: launch.mode ?? null });
        if (!launch.launched) {
          return registry.markTerminal(entry.invocationId, { status: 'blocked', termination: 'confirmed', diagnostics: [launch.diagnostic ?? 'worker launch was refused'] });
        }
        // M2: a live stop handle for the duration of this call, so an
        // explicit `cancel` can actually stop the isolated unit / kill the
        // child, not just record that cancellation was requested.
        registry.update(entry.invocationId, { control: buildShellStopControl(launch) });
        let outcome;
        if (launch.mode === 'systemd-unit') outcome = await waitForUnitImpl(launch.unit, deadlineMs);
        else {
          outcome = await new Promise(resolve => {
            launch.child.once('close', code => resolve({ termination: 'confirmed', exitCode: code }));
            launch.child.once('error', () => resolve({ termination: 'uncertain', exitCode: null }));
            setTimeout(() => { try { launch.child.kill('SIGTERM'); } catch { /* already gone */ } resolve({ termination: 'uncertain', exitCode: null, timedOut: true }); }, deadlineMs);
          });
        }
        registry.update(entry.invocationId, { control: null });
        observation = { transport: 'shell', status: outcome.termination === 'confirmed' && outcome.exitCode === 0 ? 'completed' : 'failed', termination: outcome.termination, exitCode: outcome.exitCode };
        if (outcome.termination !== 'confirmed') {
          // M2: stays LIVE — capacity is held until a stop is proven or the
          // conductor disposes of it explicitly, never freed on a mere
          // unconfirmed-termination timeout.
          return registry.update(entry.invocationId, { status: 'uncertain', termination: 'uncertain', diagnostics: ['worker termination could not be confirmed before the deadline'] });
        }
        try { rawOutput = await readBoundedFile(invocation.finalPath, invocation.maxOutputBytes, root); } catch {
          return registry.markTerminal(entry.invocationId, { status: 'failed', termination: 'confirmed', diagnostics: ['worker final output was not written'] });
        }
      } else {
        const { mcpRegistry, qualification } = drivers[invocation.selected.cli];
        const mcpServer = await mcpRegistry.get(invocation.mcp.serverRef);
        if (!mcpServer) return registry.markTerminal(entry.invocationId, { status: 'blocked', termination: 'confirmed', diagnostics: ['worker MCP server is not registered'] });
        // F5: pin the qualified server's definition digest NOW, at
        // admission, so a queued launch can detect a registry edit that
        // happened while it was waiting (see `serverDefinitionDigest`).
        const qualifiedServerDigest = serverDefinitionDigest(mcpServer);
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
          // Overflow releases capacity after the stop attempt, preserving uncertainty.
          if (result.diagnostic?.includes('OG_WORKER_MCP_FRAME_TOO_LARGE')) {
            return registry.markTerminal(entry.invocationId, { status: result.termination === 'confirmed' ? 'failed' : 'uncertain',
              termination: result.termination ?? 'uncertain', diagnostics: [result.diagnostic] });
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
        return registry.markTerminal(entry.invocationId, { status: 'failed', termination: 'confirmed', diagnostics: [typeof error?.code === 'string' ? error.code : 'OG_WORKER_FINAL_INVALID'] });
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
      // #2892 F2 (fix-2892-r2, formerly part of M2): a thrown error from
      // anywhere in the launch/observe/parse pipeline (e.g. the MCP
      // transport itself throwing rather than resolving to a `result.outcome`
      // the `else` branch above already handles) used to call `markTerminal`
      // here — freeing the capacity reservation with ZERO stop proof, the
      // exact hole M2 closed for the timeout/disconnect paths. `update`
      // keeps the entry LIVE (reservation held) for the same reason as
      // every other uncertain-termination path in this function.
      return registry.update(entry.invocationId, { status: 'uncertain', termination: 'uncertain', diagnostics: [error.message] });
    }
    // No `finally`-cleanup block: see the module doc's defect-5 note — this
    // bridge never creates a scratch/plan directory in the first place
    // (it calls the launcher in-process rather than through a relay
    // subprocess), so there is nothing left behind on any exit path.
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
    const entry = registry.get(input.invocation_id);
    if (!entry) throw new Error('Unknown invocation_id');
    return publicStatus(entry, healthHook);
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
      try { delivered = !!(await entry.control.stop()); } catch { delivered = false; }
      registry.update(entry.invocationId, { cancelDelivered: delivered });
    }
    // Cancellation delivery is recorded; it is NEVER treated as stop proof.
    // The run's own completion path is the only thing that can confirm
    // termination (#2896 defect: "cancellation proof required before replacement").
    return publicStatus(registry.get(entry.invocationId), healthHook);
  }

  server.registerTool('worker-invoke', {
    title: 'Invoke or Observe a Direct-Handoff Worker',
    description: 'Run, check, or cancel a qualified worker without any Mission/MC session — same policy/brief/claims path as the shell direct-handoff tier. Degraded isolation is a server-side operator setting only; there is no client-facing switch. Cancel delivery is not stop confirmation.',
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async input => {
    try {
      if (input.operation === 'run') return mcpJson(publicStatus(await run(input), healthHook));
      if (input.operation === 'status') return mcpJson(await status(input));
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
