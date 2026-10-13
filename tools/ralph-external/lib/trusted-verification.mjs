/**
 * Tier 0 trusted verification, outside the worker sandbox (FR-OG-039,
 * FR-OG-042, FR-OG-068, #2889 / B-OG-13). Extends Rule 9 step 8 ("Verify
 * independently, outside the worker sandbox") with an executable runner for
 * the behavior that step only described: checks are conductor/policy
 * defined and protected (never read from a worker-writable manifest or
 * script), a check binary must be an explicitly allowlisted, conductor-owned
 * binary outside the worktree (never derived from worktree content), every
 * path is pinned by file descriptor before use so a planted symlink/hardlink
 * or a mid-run swap cannot redirect a later read/spawn, checks run through
 * `verification-isolation.mjs`'s confined `systemd-run --user` path (never
 * with the conductor's own filesystem/network access), and a sandbox
 * permission failure is classified only from a spawn-level errno or this
 * module's own isolation-unavailable signal — never from worker-controlled
 * stdout/stderr text, which a worker can forge in either direction.
 *
 * This module never merges, integrates, or mutates the worktree — it only
 * reads the artifact and runs the supplied protected checks — and it never
 * derives a command from the worktree's own `package.json` (or any other
 * worker-writable manifest): `assertNotPackageScriptInvocation` is kept as
 * defense-in-depth, but the actual protection against worker-controlled
 * check code is `verification-isolation.mjs`'s confinement (checks still
 * run worker code — that is what tests are) plus the binary allowlist
 * (`assertAllowedCheckBinary`), which refuses any check binary that is not
 * both absolute and pre-registered by the conductor outside the worktree.
 * Acceptance binds the exact digest of the artifact *and* a whole-worktree
 * tree digest taken immediately before and after the checks run
 * (schemas/mission-v1.schema.json `$defs/workerDirectVerification`); a
 * later edit, or any mutation that happens *during* the checks, invalidates
 * it.
 */

import { createHash } from 'node:crypto';
import {
  closeSync, constants as fsConstants, fstatSync, lstatSync, openSync,
  readFileSync, readSync, opendirSync, readlinkSync, realpathSync,
} from 'node:fs';
import path from 'node:path';
import { missingRequiredCapabilities, probeVerificationIsolationCapabilities, runConfinedCheck } from './verification-isolation.mjs';

export class WorktreeEscapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorktreeEscapeError';
  }
}

export class ProtectedCheckViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtectedCheckViolationError';
  }
}

/** M3: a tree digest could not be computed at all (unreadable entry, broken
 * symlink elsewhere in the tree, permission denial, ...). Distinct from a
 * digest MISMATCH (which `verifyWorkerArtifact` reports as `rejected` with a
 * "changed during verification" finding) — this is "we could not establish
 * trust at all," which must also reject, never silently fall back to "we
 * don't know, so treat it as unchanged." */
export class TreeDigestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TreeDigestError';
  }
}

// M1 residual: an allowlisted check binary that is itself a general-purpose
// interpreter (handed a worktree-relative script/path as an argument) is not
// refused by `assertAllowedCheckBinary` — the interpreter binary legitimately
// resolves outside the worktree, and running worker-controlled code through
// it is exactly what a protected check is for. Its safety therefore depends
// entirely on `verification-isolation.mjs` confinement actually being
// enforced. When confinement is degraded on this host, a check that both (a)
// invokes a known interpreter and (b) passes it an argument resolving inside
// the worktree is refused outright unless the conductor explicitly opts in
// (`allowWorktreeInterpreterArgs: true`) — see Rule 9 step 8.
const INTERPRETER_BASENAMES = new Set([
  'node', 'nodejs', 'node.js', 'python', 'python3', 'python2',
  'ruby', 'perl', 'sh', 'bash', 'dash', 'ksh', 'zsh', 'env',
]);

const PACKAGE_MANAGER_BINARIES = new Set(['npm', 'npx', 'yarn', 'pnpm', 'corepack', 'bun']);
// Any subcommand that can trigger a worker-writable script: explicit script
// runners (`run`, `test`, `start`, etc.) and install-family commands, which
// also execute pre/postinstall lifecycle scripts from a worker-writable
// package.json.
const SCRIPT_TRIGGERING_ARGS = new Set([
  'run', 'run-script', 'test', 'start', 'build', 'exec', 'dlx',
  'install', 'ci', 'i', 'add', 'update', 'rebuild',
]);
// Conductor-supplied env allowlist names must never themselves look like a
// secret name (m2): a conductor who accidentally allowlists
// `GITHUB_TOKEN`/`OPENBAO_...` would forward it straight into worker-
// controlled check code. This is a name-pattern guard, not a value scan.
const SECRET_LOOKING_ENV_NAME = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i;

// Conductor-owned budget, independent of worker-reported metadata.
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const ARTIFACT_HASH_CHUNK_BYTES = 64 * 1024;
export const MAX_TREE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TREE_BYTES = 100 * 1024 * 1024;
export const MAX_TREE_ENTRIES = 10000;
const MAX_TREE_DEPTH = 128;

/**
 * Refuse any check definition that would end up executing a script a
 * worker could have written (package.json `scripts`, install lifecycle
 * hooks). Defense-in-depth only (M1): the actual protection against
 * worker-controlled check *code* is confinement
 * (`verification-isolation.mjs`) plus `assertAllowedCheckBinary`'s
 * allowlist, because a protected check still legitimately runs worker code
 * (that is what a test run is) — this function exists only to keep an
 * obviously-wrong check definition (an `npm test` style invocation) from
 * ever being accepted as "protected" in the first place.
 */
export function assertNotPackageScriptInvocation(command, args = []) {
  const base = path.basename(String(command));
  if (!PACKAGE_MANAGER_BINARIES.has(base)) return;
  const hasTrigger = args.some(token => SCRIPT_TRIGGERING_ARGS.has(String(token)));
  // Even a bare `npm` call with no recognized subcommand is refused: package
  // managers accept run-script shorthand (`npm <script>`) that this
  // allowlist cannot enumerate exhaustively, so the only safe default for a
  // "protected check" is to deny every package-manager invocation outright.
  throw new ProtectedCheckViolationError(
    `protected checks must not invoke a package manager (${base}${hasTrigger ? ` ${args.join(' ')}` : ''}): ` +
    'this would run a script a worker could have edited under conductor authority; ' +
    'define the check as a direct binary or file invocation instead',
  );
}

function withinRoot(rootReal, candidateReal) {
  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return candidateReal === rootReal || candidateReal.startsWith(rootWithSep);
}

/**
 * Resolve `targetPath` to its real (fully symlink-resolved) path WITHOUT
 * any worktree-containment requirement — used for resolving a check
 * *binary*, which by definition (M1) must live outside the worktree.
 * Fails closed on a missing path.
 */
export function resolveRealpath(targetPath) {
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath) || targetPath.includes('\0')) {
    throw new WorktreeEscapeError(`requires an absolute NUL-free path, got ${JSON.stringify(targetPath)}`);
  }
  try {
    return realpathSync(path.resolve(targetPath));
  } catch (error) {
    throw new WorktreeEscapeError(`cannot resolve real path: ${targetPath}: ${error.message}`);
  }
}

/**
 * M1: a protected check's binary must be an absolute, conductor-registered
 * path that resolves OUTSIDE the worktree. A worker-writable binary
 * (anything resolving inside the worktree — `node_modules/.bin/*`, a
 * worker-written `./evil.sh`, `env`, `make` invoked with a worktree-local
 * makefile, etc.) is refused outright, regardless of a denylist match.
 * `allowedCheckBinaries` is the conductor's own fixed list (absolute
 * paths); this function resolves each entry's real path once and compares
 * by exact real-path membership — no prefix/glob matching, so a conductor
 * cannot accidentally allowlist an entire directory the worker controls.
 */
export function assertAllowedCheckBinary(command, { allowedCheckBinaries = [], worktreeRootReal } = {}) {
  if (typeof command !== 'string' || !path.isAbsolute(command)) {
    throw new ProtectedCheckViolationError(`protected check binary must be an absolute, conductor-defined path, got ${JSON.stringify(command)}`);
  }
  const real = resolveRealpath(command);
  if (worktreeRootReal && withinRoot(worktreeRootReal, real)) {
    throw new ProtectedCheckViolationError(`protected check binary resolves inside the worktree (${real}): a worker-writable binary is never a protected check, regardless of the allowlist`);
  }
  if (!Array.isArray(allowedCheckBinaries) || allowedCheckBinaries.length === 0) {
    throw new ProtectedCheckViolationError('no conductor allowedCheckBinaries were supplied: protected checks are refused by default (fail closed), never derived from the worktree');
  }
  // An allowlist entry that does not resolve on this host (missing binary,
  // different environment) is skipped rather than crashing the whole
  // check: it simply matches nothing, which is the correct "not allowed"
  // outcome for a check that names it, without turning a conductor
  // configuration mismatch into an unrelated WorktreeEscapeError.
  const allowedReal = new Set();
  for (const entry of allowedCheckBinaries) {
    try { allowedReal.add(resolveRealpath(entry)); } catch { /* unresolvable entry: matches nothing */ }
  }
  if (!allowedReal.has(real)) {
    throw new ProtectedCheckViolationError(`protected check binary ${real} is not in the conductor's allowedCheckBinaries list`);
  }
  return real;
}

/**
 * m2: refuse an env allowlist name that looks like a secret, unless the
 * caller explicitly overrides it (`allowSecretLookingNames`). This is a
 * name-pattern guard on the conductor's OWN `envNames` declaration — it
 * cannot inspect values, only catch an accidental
 * `envNames: ['PATH', 'HOME', 'GITHUB_TOKEN']`-style mistake before it ever
 * forwards a credential into worker-controlled check code.
 */
export function assertNoSecretLookingEnvNames(envNames = [], { allowSecretLookingNames = [] } = {}) {
  const allowed = new Set(allowSecretLookingNames);
  for (const name of envNames) {
    if (SECRET_LOOKING_ENV_NAME.test(name) && !allowed.has(name)) {
      throw new ProtectedCheckViolationError(
        `envNames allowlist contains ${name}, which matches a secret-name pattern (TOKEN/SECRET/KEY/PASSWORD/CREDENTIAL); ` +
        'protected-check env allowlists are conductor-owned and must never carry secret names — ' +
        'pass it in allowSecretLookingNames explicitly if this is genuinely intended',
      );
    }
  }
}

/**
 * M1 residual: an allowlisted check binary that is a general-purpose
 * interpreter is not, by itself, evidence that running worker-controlled
 * code through it is safe — that depends entirely on
 * `verification-isolation.mjs` confinement being enforced. `capabilities`
 * must be the live-probed result (`probeVerificationIsolationCapabilities`)
 * for THIS host; when any `REQUIRED_VERIFICATION_CAPABILITIES` capability is
 * not `'enforced'` (or there is no systemd user manager at all) AND the
 * check's own argv references a path resolving inside the worktree, this
 * refuses outright unless `allowWorktreeInterpreterArgs` is explicitly
 * `true`. A non-interpreter binary, a fully-enforced host, or an explicit
 * opt-in all pass through untouched.
 */
export function assertInterpreterArgsSafeForDegradedConfinement(command, args = [], { worktreeRootReal, capabilities, allowWorktreeInterpreterArgs = false } = {}) {
  if (allowWorktreeInterpreterArgs === true) return;
  const base = path.basename(String(command));
  if (!INTERPRETER_BASENAMES.has(base)) return;
  const degraded = !capabilities || capabilities.mode !== 'systemd-unit' || missingRequiredCapabilities(capabilities).length > 0;
  if (!degraded) return;
  const referencesWorktree = worktreeRootReal && args.some(token => {
    if (typeof token !== 'string' || token.length === 0) return false;
    if (withinRoot(worktreeRootReal, token)) return true;
    if (!path.isAbsolute(token)) return false;
    try { return withinRoot(worktreeRootReal, realpathSync(token)); } catch { return false; }
  });
  if (referencesWorktree) {
    throw new ProtectedCheckViolationError(
      `protected check invokes allowlisted interpreter ${base} with an argument that references the worktree (${args.join(' ')}) while required ` +
      'confinement capabilities are not enforced on this host: an interpreter check given worker-controlled code depends entirely on the ' +
      'write/home/network confinement that is currently degraded; pass allowWorktreeInterpreterArgs: true to explicitly accept this residual risk, ' +
      'or run this check only on a host where confinement is fully enforced',
    );
  }
}

/**
 * Open `targetPath` pinned by file descriptor (B2 TOCTOU fix): resolve its
 * real path once, then open THAT resolved path with `O_NOFOLLOW` so a
 * symlink planted at the resolved location between the resolve and the
 * open fails the open rather than being silently followed. Every
 * subsequent containment check in this call, and every read of the
 * artifact specifically (which stays in this process and keeps using the
 * fd directly — `digestArtifactFd`), operates on the returned fd or on
 * `realPath` taken from it — never on the original path string again — so
 * a swap that happens *after* this call can no longer redirect the
 * validation itself. `realPath` (not the fd) is what a cross-process
 * confined launch receives as its working directory, because
 * `/proc/self/fd/<fd>` only resolves correctly within the SAME process
 * that holds the fd; a `systemd-unit` launch crosses into the systemd user
 * manager and `systemd-executor`, which do not share this process's fd
 * table (confirmed empirically — passing it there is rejected as "a bad
 * unit file setting"). That cross-process string handoff is the one
 * narrow residual TOCTOU window this module cannot close with fd-pinning
 * alone; it is as small as the time between this call returning and
 * `runConfinedCheck` issuing its own request, and it is accepted and
 * documented here rather than silently assumed away.
 *
 * Containment itself is re-derived from the fd via `/proc/self/fd/<fd>`
 * (the kernel's own answer for what this fd actually points at), not from
 * the pre-open realpath, so whatever got opened is what gets checked.
 *
 * m1: a symlink is allowed when its fully-resolved target stays inside
 * `worktreeRootReal` (`node_modules/.bin`, pnpm-style layouts); only a
 * symlink that resolves outside the worktree is denied. A `nlink > 1`
 * regular file is NOT denied here — that check is scoped to the verified
 * artifact only (`assertArtifactPinned`), because legitimate
 * npm/pnpm-installed dependencies are routinely hardlinked from a shared
 * package-manager store and this function is used for general
 * cwd/binary/path resolution, not artifact acceptance.
 *
 * M2: refuses a target whose resolved path crosses a mount boundary
 * relative to the worktree root (`st_dev` mismatch), and refuses a
 * worktree root that has any mount point nested inside it
 * (`/proc/self/mountinfo`) — both would let a conductor-trusted worktree
 * path silently point at filesystem content the worktree preparation step
 * never put there.
 *
 * Returns `{ fd, stat, realPath }`. The caller owns closing `fd`.
 */
export function openPinnedWithinWorktree(worktreeRootReal, targetPath, { directory = false } = {}) {
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath) || targetPath.includes('\0')) {
    throw new WorktreeEscapeError(`worktree-escape check requires an absolute NUL-free path, got ${JSON.stringify(targetPath)}`);
  }
  const literal = path.resolve(targetPath);
  let resolved;
  try {
    resolved = realpathSync(literal);
  } catch (error) {
    throw new WorktreeEscapeError(`cannot resolve real path for worktree-escape check: ${literal}: ${error.message}`);
  }
  const flags = fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_RDONLY | (directory ? fsConstants.O_DIRECTORY : 0);
  let fd;
  try {
    fd = openSync(resolved, flags);
  } catch (error) {
    throw new WorktreeEscapeError(`refusing to open ${literal} -> ${resolved}: ${error.message} (a symlink may have been swapped in after the path was resolved)`);
  }
  try {
    const stat = fstatSync(fd);
    let realPath;
    try {
      realPath = readlinkSync(`/proc/self/fd/${fd}`);
    } catch (error) {
      throw new WorktreeEscapeError(`cannot resolve the pinned file descriptor's own path: ${error.message}`);
    }
    if (!withinRoot(worktreeRootReal, realPath)) {
      throw new WorktreeEscapeError(`pinned path resolves outside the worktree: ${realPath} is not under ${worktreeRootReal}`);
    }
    const rootStat = lstatSync(worktreeRootReal);
    if (stat.dev !== rootStat.dev) {
      throw new WorktreeEscapeError(`pinned path ${realPath} is on a different filesystem/mount (dev ${stat.dev}) than the worktree root (dev ${rootStat.dev}); refusing a mount-boundary crossing`);
    }
    return { fd, stat, realPath };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * M2: refuse a worktree root that has anything else mounted inside it.
 * Reads `/proc/self/mountinfo` (Linux-only; no-op elsewhere) and throws if
 * any mount point other than the root itself is nested under it — the
 * worktree is expected to be a plain subtree of its own filesystem, never
 * a path with something bind-mounted into it after preparation.
 */
export function assertNoNestedMounts(worktreeRootReal, { mountinfoText } = {}) {
  if (process.platform !== 'linux' && mountinfoText === undefined) return;
  let mountinfo = mountinfoText;
  if (mountinfo === undefined) try {
    mountinfo = readFileSync('/proc/self/mountinfo', 'utf8');
  } catch (error) {
    // Fail closed: without the mount table a bind mount into the worktree
    // cannot be ruled out.
    throw new WorktreeEscapeError(`cannot read /proc/self/mountinfo to rule out nested mounts: ${error.message}`);
  }
  const rootWithSep = worktreeRootReal.endsWith(path.sep) ? worktreeRootReal : worktreeRootReal + path.sep;
  const nested = [];
  for (const line of mountinfo.split('\n')) {
    const fields = line.split(' ');
    // The kernel octal-escapes space, tab, newline and backslash (\040,
    // \011, \012, \134) in mount points; decode before comparing.
    const mountPoint = fields[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (!mountPoint) continue;
    if (mountPoint !== worktreeRootReal && mountPoint.startsWith(rootWithSep)) nested.push(mountPoint);
  }
  if (nested.length > 0) {
    throw new WorktreeEscapeError(`worktree root has nested mount point(s), refusing: ${nested.join(', ')}`);
  }
}

/** Canonicalize and validate the worktree root itself before using it as a trust boundary. */
export function resolveWorktreeRoot(worktreeRoot) {
  if (typeof worktreeRoot !== 'string' || !path.isAbsolute(worktreeRoot) || worktreeRoot.includes('\0')) {
    throw new WorktreeEscapeError(`worktree root must be an absolute NUL-free path, got ${JSON.stringify(worktreeRoot)}`);
  }
  // M2: a symlinked worktree root is refused outright (`/proc/self/cwd`
  // style roots, or a root that is itself a symlink) rather than silently
  // canonicalized, so a caller cannot accidentally hand this module a
  // moving target as the trust boundary itself.
  let lst;
  try {
    lst = lstatSync(worktreeRoot);
  } catch (error) {
    throw new WorktreeEscapeError(`cannot stat worktree root: ${worktreeRoot}: ${error.message}`);
  }
  if (lst.isSymbolicLink()) {
    throw new WorktreeEscapeError(`worktree root must not itself be a symlink: ${worktreeRoot}`);
  }
  let real;
  try {
    real = realpathSync(worktreeRoot);
  } catch (error) {
    throw new WorktreeEscapeError(`cannot resolve worktree root: ${worktreeRoot}: ${error.message}`);
  }
  if (real !== worktreeRoot) {
    throw new WorktreeEscapeError(`worktree root has a symlinked ancestor directory: ${worktreeRoot} -> ${real}; refusing a non-canonical root as the trust boundary`);
  }
  assertNoNestedMounts(real);
  return real;
}

/**
 * m1 + B2: validate (and, on success, return the canonical real path for)
 * a path that must stay inside the worktree, WITHOUT pinning a long-lived
 * fd — used by `verifyWorkerArtifact` for the artifact path check where a
 * fresh fd is opened separately for digesting. Kept as a thin wrapper over
 * `openPinnedWithinWorktree` so every path-containment decision in this
 * module goes through the same fd-pinned logic; the fd is opened and
 * immediately closed here since only the validated real path is needed by
 * the caller.
 */
export function assertWithinWorktree(worktreeRootReal, targetPath) {
  const { fd, realPath } = openPinnedWithinWorktree(worktreeRootReal, targetPath, { directory: false });
  closeSync(fd);
  return realPath;
}

/**
 * An artifact must be a bounded regular file with exactly one hard link.
 * These requirements do not apply to general path/cwd resolution (m1). A
 * freshly checked-out or worker-written artifact is expected to have
 * exactly one hard link; more than one is treated as an escape attempt (a
 * worker-planted hardlink aliasing a file outside the worktree, or a
 * mutable shared dependency) specifically for the thing acceptance is
 * about to bind a digest to.
 */
export function pinArtifact(worktreeRootReal, artifactPath) {
  const pinned = openPinnedWithinWorktree(worktreeRootReal, artifactPath, { directory: false });
  try {
    if (!pinned.stat.isFile()) {
      throw new WorktreeEscapeError(`verified artifact must be a regular file: ${pinned.realPath}`);
    }
    if (pinned.stat.nlink > 1) {
      throw new WorktreeEscapeError(`refusing a multiply-linked artifact: ${pinned.realPath} (nlink=${pinned.stat.nlink}; the verified artifact is expected to have exactly one hard link)`);
    }
    assertArtifactSize(pinned.stat.size);
    return pinned;
  } catch (error) {
    closeSync(pinned.fd);
    throw error;
  }
}

function assertArtifactSize(size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARTIFACT_BYTES) {
    throw new WorktreeEscapeError(`artifact exceeds maximum size of ${MAX_ARTIFACT_BYTES} bytes (reported size: ${size})`);
  }
}

function digestOf(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Digest the artifact pinned at `pinned.fd` (read via the fd, never by re-opening the path). */
function digestArtifactFd(pinned) {
  const size = pinned.stat.size;
  assertArtifactSize(size);
  const current = fstatSync(pinned.fd);
  assertArtifactSize(current.size);
  if (current.size !== size) throw new WorktreeEscapeError('artifact size changed before hashing');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(ARTIFACT_HASH_CHUNK_BYTES);
  let offset = 0;
  while (offset < size) {
    const read = readSync(pinned.fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (read === 0) throw new WorktreeEscapeError('artifact truncated during hashing');
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  // Check EOF without following an indefinitely growing file.
  if (readSync(pinned.fd, buffer, 0, 1, offset) !== 0 || fstatSync(pinned.fd).size !== size) {
    throw new WorktreeEscapeError('artifact size changed during hashing');
  }
  return `sha256:${hash.digest('hex')}`;
}

// M3 (round 2, CRITICAL): the previous implementation ran `git add -A` /
// `git write-tree` with a disposable `GIT_INDEX_FILE` but otherwise
// inherited the worktree's own git config and process environment. A
// worker-controlled `.gitattributes` (`filter=`), `.git/config`
// (`core.fsmonitor`, `core.hooksPath`, `include`/`includeIf`), or a
// worker-planted hook executes with CONDUCTOR authority the instant `git
// add`/`write-tree` runs — confirmed by an independent review spawning a
// marker-writing filter. Rather than trying to sanitize git's environment
// and config well enough to be trusted with worker-controlled input (the
// documented fallback option (b)), this computes the tree digest WITHOUT
// git at all: a deterministic, content-addressed walk of the real
// filesystem, opened by file descriptor at every step.
function digestFileContentsFd(fd, size) {
  if (fstatSync(fd).size !== size) throw new TreeDigestError('tree file size changed before hashing');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(ARTIFACT_HASH_CHUNK_BYTES);
  let offset = 0;
  while (offset < size) {
    const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (read === 0) throw new TreeDigestError('tree file truncated during hashing');
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  if (readSync(fd, buffer, 0, 1, offset) !== 0 || fstatSync(fd).size !== size) {
    throw new TreeDigestError('tree file size changed during hashing');
  }
  return hash.digest('hex');
}

/**
 * Open a child of an already-open directory fd by name, WITHOUT ever
 * re-resolving the parent's path as a string (the openat(2)-equivalent this
 * module uses throughout — `/proc/self/fd/<fd>/<name>` resolves against the
 * kernel's own view of the open directory, not a mutable path, so a rename
 * of an ancestor directory after it was opened cannot redirect this). Never
 * follows a symlink (`O_NOFOLLOW`): a symlinked entry's TYPE is always
 * determined by `lstatSync` first, and only a plain file/directory is ever
 * opened this way.
 */
function openChildNoFollow(dirFd, name, { directory = false } = {}) {
  const flags = fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_RDONLY | (directory ? fsConstants.O_DIRECTORY : 0);
  return openSync(`/proc/self/fd/${dirFd}/${name}`, flags);
}

function statChildOfDirFd(dirFd, name) {
  return lstatSync(`/proc/self/fd/${dirFd}/${name}`);
}

function listDirFd(dirFd, budget) {
  // Enforce the entry budget before allocating the whole directory listing.
  const directory = opendirSync(`/proc/self/fd/${dirFd}`);
  const names = [];
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (++budget.entries > MAX_TREE_ENTRIES) throw new TreeDigestError('tree entry budget exceeded');
      names.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return names.sort();
}

const TREE_DIGEST_EXCLUDED_ENTRIES = new Set(['.git']);

/**
 * Recursively walk one already-open directory fd, appending a
 * `{ path, type, ... }` descriptor for every entry to `entries`. Includes
 * UNTRACKED and IGNORED files (there is no git index/gitignore involved at
 * all); excludes only the worktree's own top-level `.git` entry (recorded
 * explicitly, never silently). A symlink's type is taken from `lstat` and
 * its target string is hashed as DATA — the target is never followed, so a
 * symlink to secret content outside the worktree contributes only its own
 * target string to the digest, never that content.
 */
function walkDirectoryFd(dirFd, relPrefix, entries, budget, depth = 0) {
  if (depth > MAX_TREE_DEPTH) throw new TreeDigestError('tree depth budget exceeded');
  const names = listDirFd(dirFd, budget);
  for (const name of names) {
    if (relPrefix === '' && TREE_DIGEST_EXCLUDED_ENTRIES.has(name)) {
      entries.push({ relPath: name, type: 'excluded' });
      continue;
    }
    const relPath = relPrefix ? `${relPrefix}/${name}` : name;
    let stat;
    try {
      stat = statChildOfDirFd(dirFd, name);
    } catch (error) {
      throw new TreeDigestError(`cannot stat ${relPath}: ${error.message}`);
    }
    if (stat.isSymbolicLink()) {
      let target;
      try {
        target = readlinkSync(`/proc/self/fd/${dirFd}/${name}`);
      } catch (error) {
        throw new TreeDigestError(`cannot read symlink target for ${relPath}: ${error.message}`);
      }
      entries.push({ relPath, type: 'symlink', mode: stat.mode & 0o777, target });
    } else if (stat.isDirectory()) {
      let childFd;
      try {
        childFd = openChildNoFollow(dirFd, name, { directory: true });
      } catch (error) {
        throw new TreeDigestError(`cannot open directory ${relPath}: ${error.message}`);
      }
      try {
        entries.push({ relPath, type: 'dir', mode: stat.mode & 0o777 });
        walkDirectoryFd(childFd, relPath, entries, budget, depth + 1);
      } finally {
        closeSync(childFd);
      }
    } else if (stat.isFile()) {
      let childFd;
      try {
        childFd = openChildNoFollow(dirFd, name);
      } catch (error) {
        throw new TreeDigestError(`cannot open file ${relPath}: ${error.message}`);
      }
      try {
        const openedStat = fstatSync(childFd);
        if (!openedStat.isFile()) throw new TreeDigestError(`file ${relPath} changed to a non-regular file before hashing`);
        if (openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) {
          throw new TreeDigestError(`file ${relPath} identity changed before hashing`);
        }
        if (!Number.isSafeInteger(openedStat.size) || openedStat.size < 0 || openedStat.size > MAX_TREE_FILE_BYTES) {
          throw new TreeDigestError(`tree file ${relPath} exceeds maximum size of ${MAX_TREE_FILE_BYTES} bytes`);
        }
        budget.bytes += openedStat.size;
        if (budget.bytes > MAX_TREE_BYTES) throw new TreeDigestError('tree byte budget exceeded');
        const contentHash = digestFileContentsFd(childFd, openedStat.size);
        entries.push({ relPath, type: 'file', mode: openedStat.mode & 0o777, size: openedStat.size, contentHash });
      } finally {
        closeSync(childFd);
      }
    } else {
      // Device/socket/FIFO: record identity metadata only, never attempt a
      // content read (which could block indefinitely on a FIFO/socket).
      entries.push({ relPath, type: 'other', mode: stat.mode & 0o777 });
    }
  }
}

/**
 * M3: a deterministic, content-addressed digest of the entire worktree
 * tree (`fd-tree:sha256:<hex>`), computed via a pure file-descriptor-pinned
 * walk — no git, no worker-controlled config/filters/hooks/fsmonitor ever
 * executes. Used to bind acceptance to "the tree did not change while the
 * checks ran," not just the single artifact file. Includes untracked AND
 * ignored files; excludes only the worktree's own top-level `.git` entry.
 *
 * THROWS `TreeDigestError` on any failure (unreadable entry, permission
 * denial, a symlink loop surfacing as ELOOP, ...) rather than returning
 * `null` — a digest failure must REJECT verification, never be silently
 * treated as "we don't know, so assume unchanged."
 */
export function computeWorktreeTreeDigest(worktreeRootReal) {
  let rootFd;
  try {
    rootFd = openSync(worktreeRootReal, fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_RDONLY);
  } catch (error) {
    throw new TreeDigestError(`cannot open worktree root for tree digest: ${error.message}`);
  }
  const entries = [];
  try {
    walkDirectoryFd(rootFd, '', entries, { entries: 0, bytes: 0 });
  } finally {
    closeSync(rootFd);
  }
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const hash = createHash('sha256');
  for (const entry of entries) {
    if (entry.type === 'excluded') { hash.update(`excluded\u0000${entry.relPath}\n`); continue; }
    if (entry.type === 'symlink') { hash.update(`symlink\u0000${entry.relPath}\u0000${entry.mode.toString(8)}\u0000${entry.target}\n`); continue; }
    if (entry.type === 'dir') { hash.update(`dir\u0000${entry.relPath}\u0000${entry.mode.toString(8)}\n`); continue; }
    if (entry.type === 'file') { hash.update(`file\u0000${entry.relPath}\u0000${entry.mode.toString(8)}\u0000${entry.size}\u0000${entry.contentHash}\n`); continue; }
    hash.update(`other\u0000${entry.relPath}\u0000${entry.mode.toString(8)}\n`);
  }
  return `fd-tree:sha256:${hash.digest('hex')}`;
}

/**
 * Run one conductor-defined protected check outside the worker sandbox,
 * through `verification-isolation.mjs`'s confined `systemd-run --user`
 * path. `command`/`args`/`cwd` must come from the conductor's own check
 * definitions, never from worker output or a worker-writable manifest;
 * `command` is additionally required to resolve to an allowlisted binary
 * outside the worktree (M1).
 *
 * Returns a classification distinguishing a sandbox/isolation failure
 * from a real check failure, derived ONLY from a spawn-level errno or this
 * module's own isolation-unavailable signal — NEVER from the check's own
 * stdout/stderr content, which worker-controlled code fully controls and
 * can forge in either direction (B3):
 *  - `'passed'`   — exit 0.
 *  - `'sandbox'`  — spawn-level EPERM/EROFS, or confinement was required
 *                   but unavailable on this host and the caller did not
 *                   opt into `allowDegradedIsolation`.
 *  - `'timeout'`  — the check did not finish within `timeoutMs`.
 *  - `'failed'`   — any other non-zero exit; a real check failure,
 *                   regardless of what its output says.
 *  - `'error'`    — the check could not be spawned at all (e.g. ENOENT).
 *
 * `isolation` is always attached to the result (mode + the full degraded-
 * capability list from the live per-host probe), on every classification,
 * so a caller can never read "passed"/"accepted" as "fully isolated"
 * without also seeing what this host could not enforce.
 */
export function runProtectedCheck({
  id,
  command,
  args = [],
  worktreeRootReal,
  cwd,
  envNames = ['PATH', 'HOME'],
  env = process.env,
  timeoutMs = 60000,
  allowedCheckBinaries = [],
  allowSecretLookingEnvNames = [],
  allowDegradedIsolation = false,
  allowWorktreeInterpreterArgs = false,
  outputDirReal,
  spawn,
  runConfined = runConfinedCheck,
} = {}) {
  assertNotPackageScriptInvocation(command, args);
  // M1 residual: use the ALLOWLIST-RESOLVED canonical real path for the
  // actual launch, not the original `command` spelling. `command` may be a
  // symlink that was valid (resolved to an allowlisted real path) at the
  // instant `assertAllowedCheckBinary` checked it; launching the original
  // spelling again would re-resolve it a second time at spawn — a window in
  // which the symlink could have been retargeted. Launching the already-
  // resolved real path removes that second resolution entirely.
  const resolvedCommand = assertAllowedCheckBinary(command, { allowedCheckBinaries, worktreeRootReal });
  assertNoSecretLookingEnvNames(envNames, { allowSecretLookingNames: allowSecretLookingEnvNames });
  // M1 residual: an allowlisted interpreter handed a worktree-path argument
  // is only as safe as the confinement it runs under. Refuse outright when
  // confinement is degraded on this host, unless explicitly opted in.
  // `probeVerificationIsolationCapabilities` is cached per-process, so this
  // costs a real probe only once per host per cache TTL, not per check.
  const base = path.basename(resolvedCommand);
  if (INTERPRETER_BASENAMES.has(base) && allowWorktreeInterpreterArgs !== true) {
    const capabilities = spawn ? probeVerificationIsolationCapabilities({ spawn }) : probeVerificationIsolationCapabilities();
    assertInterpreterArgsSafeForDegradedConfinement(resolvedCommand, args, { worktreeRootReal, capabilities, allowWorktreeInterpreterArgs });
  }
  // Pin-validate the cwd (containment, mount-crossing, symlink-swap
  // detection — B2/M2). The fd is held OPEN across the entire confined
  // probe+launch (B2 round 2): closing it immediately after resolving
  // `cwdRealPath`, as the previous version did, left the whole probe+launch
  // duration as an unguarded TOCTOU window. Holding it open lets this
  // function re-verify, the MOMENT the launch returns, that the fd still
  // points at the same real path and the same filesystem/mount as the
  // worktree root — narrowing the residual window to just the handoff
  // between that re-check and the cross-process launch call itself (the
  // one window fd-pinning alone cannot close, documented below and on
  // `openPinnedWithinWorktree`): a confined (`systemd-unit`) launch crosses
  // into the systemd user *manager* and `systemd-executor`, neither of
  // which shares this process's file descriptor table, so
  // `/proc/self/fd/<fd>` cannot be handed to them directly (confirmed
  // empirically — the manager rejects it as "a bad unit file setting"), so
  // the real path STRING is still what is handed onward as `cwd`.
  const pinnedCwd = openPinnedWithinWorktree(worktreeRootReal, cwd ?? worktreeRootReal, { directory: true });
  const cwdRealPath = pinnedCwd.realPath;
  let result;
  try {
    const confinedSpawnOptions = { command: resolvedCommand, args, worktreeRootReal, outputDirReal, envNames, env, timeoutMs, allowDegradedIsolation, cwd: cwdRealPath };
    if (spawn) confinedSpawnOptions.spawn = spawn;
    result = runConfined(confinedSpawnOptions);
    // B2: re-verify, while the fd is STILL open, that the path it is
    // pinned to has not been swapped for a different inode/mount during
    // the probe+launch window that just ran.
    let postLaunchRealPath;
    try {
      postLaunchRealPath = readlinkSync(`/proc/self/fd/${pinnedCwd.fd}`);
    } catch (error) {
      throw new WorktreeEscapeError(`cannot re-verify the pinned cwd after the check ran: ${error.message}`);
    }
    if (postLaunchRealPath !== cwdRealPath) {
      throw new WorktreeEscapeError(`cwd identity changed during the check (was ${cwdRealPath}, now ${postLaunchRealPath}): refusing to trust the result`);
    }
    const postStat = fstatSync(pinnedCwd.fd);
    const rootStat = lstatSync(worktreeRootReal);
    if (postStat.dev !== rootStat.dev) {
      throw new WorktreeEscapeError(`cwd is on a different filesystem/mount after the check ran than the worktree root: refusing to trust the result`);
    }
    assertNoNestedMounts(worktreeRootReal);
  } finally {
    closeSync(pinnedCwd.fd);
  }
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const isolation = result.isolation ?? { mode: 'unknown', degraded: [] };
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      return { id, classification: 'timeout', ok: false, reason: result.error.code, stdout, stderr, isolation };
    }
    if (result.error.code === 'EPERM' || result.error.code === 'EROFS' || result.error.code === 'ISOLATION_UNAVAILABLE') {
      return { id, classification: 'sandbox', ok: false, reason: result.error.code, stdout, stderr, isolation, diagnostic: result.error.message };
    }
    return { id, classification: 'error', ok: false, reason: result.error.code ?? result.error.message, stdout, stderr, isolation };
  }
  if (result.status !== 0) {
    return { id, classification: 'failed', ok: false, reason: `exit ${result.status}`, stdout, stderr, exitCode: result.status, isolation };
  }
  return { id, classification: 'passed', ok: true, stdout, stderr, exitCode: 0, isolation };
}

/**
 * Verify one worker artifact with a fixed set of conductor-defined
 * protected checks, entirely outside the worker sandbox, and return a
 * `workerDirectVerification`-shaped result
 * (schemas/mission-v1.schema.json `$defs/workerDirectVerification`:
 * `status`/`verifierId`/`runnerRef`/`artifactDigest`/`evidence`/`findings`/
 * `controlledContext`), extended with `isolation` (the confinement mode
 * and every degraded capability this host could not enforce, reported
 * unconditionally — never only on failure).
 *
 * Status mapping:
 *  - `'rejected'` — a path escape/protected-check violation was caught, at
 *    least one check classified `'failed'`/`'error'`/`'timeout'`, or the
 *    worktree tree digest changed between the pre- and post-check
 *    snapshots (M3: the tree was mutated *during* verification). This is a
 *    real-failure or security verdict, not infrastructure noise.
 *  - `'blocked'`  — no real failure, but at least one check classified
 *    `'sandbox'`: the verification environment itself could not run the
 *    check (including "confinement was required but unavailable and not
 *    explicitly allowed-degraded"), which is infrastructure evidence,
 *    never a pass and never promoted to "the code failed."
 *  - `'accepted'` — every check passed; `artifactDigest` binds acceptance
 *    to the exact bytes verified AFTER the checks ran (re-read via a fresh
 *    pinned fd), and `treeDigest` binds it to the whole-worktree tree
 *    snapshot taken immediately before and immediately after the checks.
 *
 * This function never deletes, moves, or merges anything — on any
 * non-accepted outcome the worktree and its dirty state are left exactly
 * as found, matching the retention default in
 * `08-security-and-threat-model.md`. There is no "auto-merge" code path:
 * integrating the verified digest elsewhere is a separate, explicit step
 * the caller takes (Rule 9 step 9), never this function.
 */
/**
 * M3: pin the worktree ROOT itself by file descriptor, independent of the
 * content-level tree digest, so a check that mutates the tree and then
 * restores it byte-for-byte (a "swap-and-restore" — e.g. unmount/remount a
 * different filesystem at the same path, or replace the root directory
 * entry itself) cannot escape detection merely because the pre/post
 * CONTENT digests happen to match. Returns `{ fd, dev, ino }`; the caller
 * holds the fd open across the entire check run and calls
 * `assertRootIdentityUnchanged` afterward, then closes it.
 */
export function pinRootIdentity(worktreeRootReal) {
  const fd = openSync(worktreeRootReal, fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_RDONLY);
  const stat = fstatSync(fd);
  return { fd, dev: stat.dev, ino: stat.ino };
}

/**
 * M3: re-verify, after the checks have run, that the pinned root fd still
 * resolves to the SAME path and the SAME `dev:ino` identity as a fresh
 * `lstat` of `worktreeRootReal`, and that no mount has appeared inside the
 * root since preparation. Throws `WorktreeEscapeError` on any mismatch.
 */
export function assertRootIdentityUnchanged(pinnedRoot, worktreeRootReal) {
  let currentPath;
  try {
    currentPath = readlinkSync(`/proc/self/fd/${pinnedRoot.fd}`);
  } catch (error) {
    throw new WorktreeEscapeError(`cannot re-verify the pinned worktree root after checks ran: ${error.message}`);
  }
  if (currentPath !== worktreeRootReal) {
    throw new WorktreeEscapeError(`worktree root identity changed during verification (was ${worktreeRootReal}, now ${currentPath}): refusing to trust the result (swap-and-restore detected)`);
  }
  let freshStat;
  try {
    freshStat = lstatSync(worktreeRootReal);
  } catch (error) {
    throw new WorktreeEscapeError(`cannot re-stat the worktree root after checks ran: ${error.message}`);
  }
  if (freshStat.dev !== pinnedRoot.dev || freshStat.ino !== pinnedRoot.ino) {
    throw new WorktreeEscapeError(`worktree root dev:inode changed during verification (was ${pinnedRoot.dev}:${pinnedRoot.ino}, now ${freshStat.dev}:${freshStat.ino}): refusing to trust the result (swap-and-restore detected)`);
  }
  assertNoNestedMounts(worktreeRootReal);
}

export function verifyWorkerArtifact({
  worktreeRoot,
  artifactPath,
  checks = [],
  allowedCheckBinaries = [],
  outputDirReal,
  verifierId = 'trusted-verification@1',
  runnerRef = null,
} = {}) {
  let worktreeRootReal;
  try {
    worktreeRootReal = resolveWorktreeRoot(worktreeRoot);
  } catch (error) {
    return rejected(verifierId, runnerRef, [`worktree root invalid: ${error.message}`], 'resolving the worktree root');
  }

  // M3: pin the root's own identity BEFORE anything else, held open across
  // the entire check run (closed in the `finally` below) so a
  // swap-and-restore of the root itself — not just its content — is
  // independently detectable even if the content-level tree digest is
  // made to match.
  let pinnedRoot;
  try {
    pinnedRoot = pinRootIdentity(worktreeRootReal);
  } catch (error) {
    return rejected(verifierId, runnerRef, [`cannot pin worktree root identity: ${error.message}`], 'pinning the worktree root');
  }

  try {
    return verifyWorkerArtifactPinned({ worktreeRootReal, artifactPath, checks, allowedCheckBinaries, outputDirReal, verifierId, runnerRef, pinnedRoot });
  } finally {
    closeSync(pinnedRoot.fd);
  }
}

function verifyWorkerArtifactPinned({ worktreeRootReal, artifactPath, checks, allowedCheckBinaries, outputDirReal, verifierId, runnerRef, pinnedRoot }) {
  let preCheckArtifact;
  try {
    preCheckArtifact = pinArtifact(worktreeRootReal, artifactPath);
  } catch (error) {
    return rejected(verifierId, runnerRef, [`artifact path escape check failed: ${error.message}`], 'validating the artifact path');
  }
  let preDigest;
  try {
    preDigest = digestArtifactFd(preCheckArtifact);
  } catch (error) {
    return rejected(verifierId, runnerRef, [`artifact digest failed: ${error.message}`], 'hashing the artifact');
  } finally {
    closeSync(preCheckArtifact.fd);
  }

  // M3: a tree-digest FAILURE must reject, never be silently treated as "we
  // don't know, so assume unchanged" — fail closed before any check runs.
  let preTreeDigest;
  try {
    preTreeDigest = computeWorktreeTreeDigest(worktreeRootReal);
  } catch (error) {
    return rejected(verifierId, runnerRef, [`worktree tree digest (pre-check) could not be computed: ${error.message}`], 'computing the pre-check worktree tree digest');
  }

  const outcomes = [];
  for (const check of checks) {
    try {
      outcomes.push(runProtectedCheck({ ...check, worktreeRootReal, allowedCheckBinaries, outputDirReal }));
    } catch (error) {
      if (error instanceof ProtectedCheckViolationError || error instanceof WorktreeEscapeError) {
        outcomes.push({ id: check.id, classification: 'rejected-definition', ok: false, reason: error.message, isolation: { mode: 'n/a', degraded: [] } });
        continue;
      }
      throw error;
    }
  }

  // M3: re-verify the PINNED ROOT's own identity and mount state before
  // trusting anything computed from a fresh read of `worktreeRootReal`
  // below — a swap-and-restore of the root itself is caught here even if
  // it would otherwise leave the content-level tree digest unchanged.
  try {
    assertRootIdentityUnchanged(pinnedRoot, worktreeRootReal);
  } catch (error) {
    return rejected(verifierId, runnerRef, [`worktree root identity check failed after checks ran: ${error.message}`], 're-verifying the worktree root identity after checks');
  }

  // M3: same fail-closed treatment for the post-check digest — a failure
  // here must also reject, not fall through to "accepted" without ever
  // having proven the tree was untouched.
  let postTreeDigest;
  try {
    postTreeDigest = computeWorktreeTreeDigest(worktreeRootReal);
  } catch (error) {
    return rejected(verifierId, runnerRef, [`worktree tree digest (post-check) could not be computed: ${error.message}`], 'computing the post-check worktree tree digest');
  }
  const treeChangedDuringChecks = preTreeDigest !== postTreeDigest;

  const allDegraded = outcomes.flatMap(outcome => (outcome.isolation?.degraded ?? []).map(entry => `${outcome.id}: isolation degraded (${entry.capability}): ${entry.reason}`));

  const findings = outcomes.map(outcome =>
    `${outcome.id}: ${outcome.classification}${outcome.reason ? ` (${outcome.reason})` : ''}`);
  const hasRealFailure = outcomes.some(outcome =>
    ['failed', 'error', 'timeout', 'rejected-definition'].includes(outcome.classification));
  const hasSandboxFailure = outcomes.some(outcome => outcome.classification === 'sandbox');

  const isolationSummary = {
    mode: outcomes[0]?.isolation?.mode ?? 'n/a',
    degraded: outcomes.flatMap(outcome => outcome.isolation?.degraded ?? []),
  };

  if (treeChangedDuringChecks) {
    return {
      status: 'rejected', verifierId, runnerRef, artifactDigest: null, evidence: [],
      findings: [...findings, `worktree tree digest changed during verification (pre: ${preTreeDigest}, post: ${postTreeDigest}): the tree was mutated while checks ran`, ...allDegraded],
      controlledContext: 'conductor-controlled check environment, outside worker sandbox',
      isolation: isolationSummary,
    };
  }
  if (hasRealFailure) {
    return {
      status: 'rejected', verifierId, runnerRef, artifactDigest: null, evidence: [],
      findings: [...findings, ...allDegraded],
      controlledContext: 'conductor-controlled check environment, outside worker sandbox',
      isolation: isolationSummary,
    };
  }
  if (hasSandboxFailure) {
    return {
      status: 'blocked', verifierId, runnerRef, artifactDigest: null, evidence: [],
      findings: [...findings, ...allDegraded],
      controlledContext: 'conductor-controlled check environment reported a sandbox/isolation failure, not a code verdict',
      isolation: isolationSummary,
    };
  }

  // Acceptance re-reads the artifact and re-derives the tree digest AFTER
  // the checks ran (M3): the digest being bound is the post-check state,
  // not a stale pre-check snapshot.
  let postCheckArtifact;
  try {
    postCheckArtifact = pinArtifact(worktreeRootReal, artifactPath);
  } catch (error) {
    return rejected(verifierId, runnerRef, [`artifact path escape check failed after checks ran: ${error.message}`, ...allDegraded], 're-validating the artifact path after checks');
  }
  let postDigest;
  try {
    postDigest = digestArtifactFd(postCheckArtifact);
  } catch (error) {
    return rejected(verifierId, runnerRef, [`artifact digest failed after checks ran: ${error.message}`, ...allDegraded], 'hashing the artifact after checks');
  } finally {
    closeSync(postCheckArtifact.fd);
  }
  if (postDigest !== preDigest) {
    return rejected(verifierId, runnerRef, [`artifact changed during verification (pre: ${preDigest}, post: ${postDigest})`, ...allDegraded], 'comparing pre- and post-check artifact digests');
  }

  const evidence = outcomes.map(outcome => ({
    ref: outcome.id,
    digest: digestOf(`${outcome.stdout ?? ''}\u0000${outcome.stderr ?? ''}`),
  }));
  return {
    status: 'accepted', verifierId, runnerRef, artifactDigest: postDigest, treeDigest: postTreeDigest, evidence,
    findings: findings.length > 0 ? [...findings, ...allDegraded] : ['no protected checks were supplied; artifact path/escape checks passed', ...allDegraded],
    controlledContext: 'conductor-controlled check environment, outside worker sandbox',
    isolation: isolationSummary,
  };
}

function rejected(verifierId, runnerRef, findings, controlledContext) {
  return { status: 'rejected', verifierId, runnerRef, artifactDigest: null, evidence: [], findings, controlledContext, isolation: { mode: 'n/a', degraded: [] } };
}
