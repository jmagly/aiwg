/**
 * Bounded synchronous child-process wrappers (#3062).
 *
 * `execSync`/`execFileSync`/`spawnSync` block the calling thread for as long
 * as the child — or any grandchild still holding an inherited pipe — lives.
 * With no timeout that is unbounded: it hung the test suite once and can
 * hang the CLI when it runs without a terminal. These wrappers make every
 * call bounded by construction: a required `tier` selects the wall-clock
 * cap, the call never inherits stdin, and a timeout always surfaces as the
 * normal Node `ETIMEDOUT` error/result with a message that names the
 * command, tier and bound.
 *
 * Tiers (see `SYNC_PROCESS_TIER_BOUNDS_MS`):
 *   - `quick`   30s  — local queries: git status/rev-parse/config, version
 *                      probes, `which`/`where`, `df`, tmux queries.
 *   - `network` 2m   — git fetch/pull/ls-remote/push, `gh`/API calls.
 *   - `long`    10m  — installs, clones, docker, builds, test runs launched
 *                      by scripts. Overridable via `AIWG_SYNC_LONG_TIMEOUT_MS`
 *                      (see `resolveSyncProcessTimeoutMs`); `quick`/`network`
 *                      are not overridable.
 *
 * Choose the tier by what the command does, not by where the call site
 * lives.
 *
 * Interactive-by-design calls (an editor, a login flow, launching a harness
 * binary the user is meant to talk to) do not belong here — bounding them
 * would just make the interactive session time out. Leave those sites on
 * the plain Node APIs.
 *
 * ## Why timeout kills with SIGKILL, not SIGTERM-then-SIGKILL
 *
 * Node's own `timeout`/`killSignal` option sends `killSignal` exactly once
 * when the bound elapses, then keeps blocking until the child actually
 * exits. If the child ignores that signal — trivial to do for SIGTERM, and
 * exactly the "grandchild holding an inherited pipe" scenario this gate
 * exists to catch — the call hangs forever regardless of the configured
 * timeout; killSignal only picks *which* signal is sent once, not whether
 * the wait ever ends. There is no portable way to schedule a second signal
 * from inside a single blocking native call: the calling thread is blocked
 * in a C++ synchronous spawn, so no JS timer can run to escalate.
 *
 * These wrappers therefore always kill with `killSignal: 'SIGKILL'` and
 * ignore any `killSignal` a caller passes in `options` — honoring a
 * caller-supplied `'SIGTERM'` would silently reopen exactly the hang this
 * module exists to close for a child that traps and ignores it. SIGKILL
 * cannot be caught, blocked or ignored, so the *direct child* reliably dies
 * at the bound — confirmed with a real child that traps and ignores SIGTERM
 * (see `test/unit/process/bounded-child-process.test.mjs`): with
 * `killSignal: 'SIGTERM'` the call hangs indefinitely; with `'SIGKILL'` it
 * returns at the bound, every time.
 *
 * ## What SIGKILL does *not* guarantee: descendant cleanup
 *
 * These wrappers bound one synchronous call to one direct child process.
 * SIGKILL is sent to that child only — never to a process group or a
 * descendant tree. A direct child that itself spawned a grandchild (for
 * example a backgrounded, detached, or double-forked process) is not
 * supervised here: that grandchild is not signaled, is not waited for, and
 * may keep running after this call returns (see
 * `test/fixtures/process/spawn-detached-pipe-holder.mjs` and its test for a
 * concrete case). A synchronous Node call cannot supervise a process tree —
 * doing so needs an asynchronous process-group/session owner, which is a
 * different mechanism than what `execSync`/`execFileSync`/`spawnSync` give
 * us. Callers that spawn a tool known to background work of its own are
 * responsible for that tool's own cleanup contract; this module only
 * guarantees the direct child is gone and the calling thread is unblocked
 * by the stated bound.
 *
 * @module src/process/bounded-child-process
 */

import {
  spawn,
  execSync as nodeExecSync,
  execFileSync as nodeExecFileSync,
  spawnSync as nodeSpawnSync,
} from 'node:child_process';
import { signalChild } from './signal-child.mjs';

/** Env var that raises or disables the `long` tier bound. `0` disables it (no timeout). */
export const AIWG_SYNC_LONG_TIMEOUT_MS_ENV = 'AIWG_SYNC_LONG_TIMEOUT_MS';

/**
 * Default wall-clock bounds per tier, in milliseconds. `quick` and `network`
 * are fixed; `long` is the default absent `AIWG_SYNC_LONG_TIMEOUT_MS`.
 */
export const SYNC_PROCESS_TIER_BOUNDS_MS = Object.freeze({
  quick: 30_000,
  network: 120_000,
  long: 600_000,
});

const VALID_TIERS = new Set(Object.keys(SYNC_PROCESS_TIER_BOUNDS_MS));

let warnedInvalidLongTimeoutEnv = false;

/**
 * Resolve the `long` tier bound, honoring `AIWG_SYNC_LONG_TIMEOUT_MS`.
 *
 * - Unset/empty → the default (`SYNC_PROCESS_TIER_BOUNDS_MS.long`).
 * - `"0"` → disabled: no bound is applied to the `long` tier at all.
 * - A positive integer → that many milliseconds.
 * - Anything else → the default, with one warning to stderr per process.
 *
 * @returns {number} Milliseconds, or `0` meaning "no bound".
 */
function resolveLongTierTimeoutMs() {
  const raw = process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV];
  if (raw === undefined || raw.trim() === '') return SYNC_PROCESS_TIER_BOUNDS_MS.long;
  const trimmed = raw.trim();
  if (trimmed === '0') return 0;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    if (!warnedInvalidLongTimeoutEnv) {
      warnedInvalidLongTimeoutEnv = true;
      console.warn(
        `[aiwg] ${AIWG_SYNC_LONG_TIMEOUT_MS_ENV}=${JSON.stringify(raw)} is not a positive integer or "0"; ` +
        `using the default long-tier bound (${SYNC_PROCESS_TIER_BOUNDS_MS.long}ms).`,
      );
    }
    return SYNC_PROCESS_TIER_BOUNDS_MS.long;
  }
  return parsed;
}

/**
 * Exposed for tests and for the gate/report tooling: resolve the effective
 * bound for a tier right now (reads the env override for `long` each call,
 * same as the wrappers do).
 *
 * @param {'quick'|'network'|'long'} tier
 * @returns {number} Milliseconds; `0` means "no bound" (long tier disabled).
 */
export function resolveSyncProcessTimeoutMs(tier) {
  assertValidTier(tier);
  if (tier === 'long') return resolveLongTierTimeoutMs();
  return SYNC_PROCESS_TIER_BOUNDS_MS[tier];
}

function assertValidTier(tier) {
  if (!VALID_TIERS.has(tier)) {
    throw new TypeError(
      `Sync process tier must be one of ${[...VALID_TIERS].map((t) => `'${t}'`).join(', ')}; got ${JSON.stringify(tier)}.`,
    );
  }
}

/**
 * The bound actually applied to one call: the tier bound, unless the
 * caller's own `options.timeout` is a smaller positive number (an explicit
 * smaller timeout always wins; a zero/negative/non-numeric one is ignored —
 * a call site cannot silently opt out of the tier bound by passing
 * `timeout: 0` itself; only the `long`-tier env var can disable a bound).
 *
 * @param {'quick'|'network'|'long'} tier
 * @param {{timeout?: number}} [options]
 * @returns {number}
 */
function effectiveTimeoutMs(tier, options) {
  const bound = resolveSyncProcessTimeoutMs(tier);
  const explicit = options?.timeout;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0 && (bound === 0 || explicit < bound)) {
    return explicit;
  }
  return bound;
}

/**
 * Clamp a caller-controlled value to a guaranteed-positive millisecond
 * bound, for the one case `boundedExecSync`/`boundedExecFileSync`/
 * `boundedSpawnSync` don't cover by themselves: a *raw* `execSync`/
 * `execFileSync`/`spawnSync` call site whose `timeout` option is computed
 * from caller input (a CLI flag, a config value, a converted unit) rather
 * than a literal — `timeout: options.timeout` or `timeout: timeoutSec *
 * 1000` with an untrusted `timeoutSec`, for example. `tools/testing/
 * check-sync-child-process-timeouts.mjs` (#3062 B/C finding 8) recognizes
 * a call to this function, by binding, as a provably positive timeout —
 * so wrap the dynamic value here instead of passing it through directly.
 *
 * `value` passes through only when it is itself a finite number `> 0`;
 * anything else (`0`, a negative number, `NaN`, `undefined`, a string,
 * ...) falls back to `fallbackMs` — so a caller-controlled `timeoutSec: 0`
 * cannot disable the bound. `fallbackMs` itself falls back to the `quick`
 * tier bound if it is not a valid positive number, so this function can
 * never itself return a non-positive or non-finite value.
 *
 * @param {unknown} value
 * @param {number} fallbackMs
 * @returns {number}
 */
export function positiveTimeoutMs(value, fallbackMs) {
  const resolvedFallback = typeof fallbackMs === 'number' && Number.isFinite(fallbackMs) && fallbackMs > 0
    ? fallbackMs
    : SYNC_PROCESS_TIER_BOUNDS_MS.quick;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : resolvedFallback;
}

/**
 * Whether a `stdio[0]` (stdin slot) value describes the parent's own stdin —
 * the form Node would otherwise inherit from. Covers the string shorthand,
 * the literal fd `0`, and the `process.stdin` stream object itself; leaves
 * `'pipe'`, `'ignore'`, other fds, and unrelated stream objects alone.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isParentStdinDescriptor(value) {
  return value === 'inherit' || value === 0 || value === process.stdin;
}

/**
 * A bounded call never inherits stdin; stdout/stderr may still be inherited
 * for progress output. When the caller supplies `input`, an inherited
 * stdin form is normalized to `'pipe'` instead of `'ignore'` — `input`
 * needs a real pipe to deliver its payload through, and `'ignore'` would
 * silently drop it (#3062 B/C finding 9). `options` is otherwise left
 * untouched when stdin was not going to be inherited anyway.
 *
 * @param {Record<string, unknown>} options
 * @returns {Record<string, unknown>}
 */
function withoutInheritedStdin(options) {
  if (options.input !== undefined) {
    // `input` needs stdin to actually be a pipe to deliver its payload —
    // a caller-specified inherited-stdin form in `stdio[0]` must not win
    // over that (#3062 B/C finding 9: an earlier version returned
    // `options` completely untouched here, so `input` combined with
    // `stdio: 'inherit'`/fd `0`/`process.stdin` could still leave stdin
    // connected to the parent's real stdin instead of the pipe `input`
    // is written to). stdout/stderr and the payload itself are untouched.
    if (options.stdio === 'inherit') {
      return { ...options, stdio: ['pipe', 'inherit', 'inherit'] };
    }
    if (Array.isArray(options.stdio) && isParentStdinDescriptor(options.stdio[0])) {
      const stdio = options.stdio.slice();
      stdio[0] = 'pipe';
      return { ...options, stdio };
    }
    return options;
  }
  if (options.stdio === 'inherit') {
    return { ...options, stdio: ['ignore', 'inherit', 'inherit'] };
  }
  if (Array.isArray(options.stdio) && isParentStdinDescriptor(options.stdio[0])) {
    const stdio = options.stdio.slice();
    stdio[0] = 'ignore';
    return { ...options, stdio };
  }
  return options;
}

/**
 * Build the final Node options: bounded stdin, resolved timeout, and a
 * forced `killSignal: 'SIGKILL'`. Unlike `timeout`, `killSignal` is not
 * negotiable: a caller-supplied `killSignal` (e.g. `'SIGTERM'`) is
 * overwritten, not honored, because a child that ignores it would defeat
 * the bound this module exists to guarantee (see the module header).
 *
 * @param {Record<string, unknown> | undefined} options
 * @param {number} boundMs
 * @returns {Record<string, unknown>}
 */
function toNodeOptions(options, boundMs) {
  const base = withoutInheritedStdin(options ?? {});
  return {
    ...base,
    timeout: boundMs,
    killSignal: 'SIGKILL',
  };
}

function describeCommand(command, args) {
  if (args === undefined) return command;
  return [command, ...args].join(' ');
}

/**
 * On timeout (`error.code === 'ETIMEDOUT'`), prepend a message naming the
 * command, tier and bound. Leaves every other field (`code`, `signal`,
 * `status`, `killed`) exactly as Node set them, and leaves non-timeout
 * errors untouched, so existing catch blocks that inspect those fields (or
 * just catch-and-ignore) keep working.
 *
 * `signal` disambiguates *why* `ETIMEDOUT` fired: when it is `'SIGKILL'` the
 * direct child itself was still running and got killed at the bound: the
 * common case. When it is anything else (including `null`), the direct
 * child had already exited — `status`/`signal` on the result reflect its
 * real exit — but this call was still blocked waiting for its stdout/stderr
 * pipe to reach EOF, which only happens once every process holding that
 * pipe's write end (the child *and* any surviving descendant it handed the
 * fd to) has closed it. A surviving, pipe-holding descendant reproduces
 * that even though the child it came from is long gone (see
 * `test/fixtures/process/spawn-detached-pipe-holder.mjs`).
 *
 * @template {Error & {code?: string, signal?: string | null}} E
 * @param {E | null | undefined} error
 * @param {{description: string, tier: string, boundMs: number, signal?: string | null}} context
 * @returns {E | null | undefined}
 */
function enrichTimeoutError(error, { description, tier, boundMs, signal }) {
  if (!error || error.code !== 'ETIMEDOUT') return error;
  const effectiveSignal = signal !== undefined ? signal : error.signal;
  const killClause = effectiveSignal === 'SIGKILL'
    ? 'the direct child was killed (SIGKILL)'
    : 'the direct child had already exited, but this call was still waiting for its stdout/stderr pipe to close';
  error.message =
    `\`${description}\` exceeded the '${tier}' tier bound of ${boundMs}ms; ${killClause}. ` +
    `Any descendant the child spawned (detached, backgrounded, or otherwise ignoring signals) is not supervised ` +
    `by this call and may still be running — holding that pipe open is enough to trigger this timeout even after ` +
    `the child itself has exited. ` +
    (tier === 'long' ? `Set ${AIWG_SYNC_LONG_TIMEOUT_MS_ENV} to a larger number of milliseconds, or 0 to remove the bound. ` : '') +
    error.message;
  return error;
}

/**
 * Bounded `child_process.execSync`. Same arguments and return value as
 * Node's `execSync(command, options)`, with a required `tier` inserted
 * before `options`.
 *
 * @param {string} command
 * @param {'quick'|'network'|'long'} tier
 * @param {Record<string, unknown>} [options]
 * @returns {Buffer | string}
 */
export function boundedExecSync(command, tier, options) {
  assertValidTier(tier);
  const boundMs = effectiveTimeoutMs(tier, options);
  const nodeOptions = toNodeOptions(options, boundMs);
  try {
    return nodeExecSync(command, nodeOptions);
  } catch (error) {
    throw enrichTimeoutError(error, { description: command, tier, boundMs });
  }
}

/**
 * Bounded `child_process.execFileSync`. Same arguments and return value as
 * Node's `execFileSync(file, args, options)`, with a required `tier`
 * inserted before `options`. Unlike the native API, `args` is always
 * required (pass `[]` for none) so tier can occupy a fixed position.
 *
 * @param {string} file
 * @param {readonly string[]} args
 * @param {'quick'|'network'|'long'} tier
 * @param {Record<string, unknown>} [options]
 * @returns {Buffer | string}
 */
export function boundedExecFileSync(file, args, tier, options) {
  assertValidTier(tier);
  const boundMs = effectiveTimeoutMs(tier, options);
  const nodeOptions = toNodeOptions(options, boundMs);
  try {
    return nodeExecFileSync(file, args, nodeOptions);
  } catch (error) {
    throw enrichTimeoutError(error, { description: describeCommand(file, args), tier, boundMs });
  }
}

/**
 * Bounded `child_process.spawnSync`. Same arguments and return shape as
 * Node's `spawnSync(command, args, options)`, with a required `tier`
 * inserted before `options`. Unlike the native API, `args` is always
 * required (pass `[]` for none) so tier can occupy a fixed position.
 *
 * `spawnSync` never throws; on timeout the returned object has an `error`
 * with `code: 'ETIMEDOUT'` whose message has been enriched in place. In the
 * common case the direct child was still running and gets killed at the
 * bound, so `status: null` and `signal: 'SIGKILL'`. If the direct child had
 * already exited but a surviving descendant is still holding its
 * stdout/stderr pipe open, `status`/`signal` instead reflect that real exit
 * (e.g. `status: 0`, `signal: null`) while `error.code` is still
 * `'ETIMEDOUT'` — check `error`, not just `status`/`signal`, to detect the
 * timeout in that case.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {'quick'|'network'|'long'} tier
 * @param {Record<string, unknown>} [options]
 * @returns {import('node:child_process').SpawnSyncReturns<Buffer | string>}
 */
export function boundedSpawnSync(command, args, tier, options) {
  assertValidTier(tier);
  const boundMs = effectiveTimeoutMs(tier, options);
  const nodeOptions = toNodeOptions(options, boundMs);
  const result = nodeSpawnSync(command, args, nodeOptions);
  enrichTimeoutError(result.error, { description: describeCommand(command, args), tier, boundMs, signal: result.signal });
  return result;
}

/** Async counterpart for launches that must clean owned files on termination.
 * Like the sync wrappers, this supervises the direct child only. */
export async function boundedSpawn(command, args, tier, options, onTermination = () => {}) {
  assertValidTier(tier);
  const boundMs = effectiveTimeoutMs(tier, options);
  const { timeout: _timeout, killSignal: _killSignal, ...nodeOptions } = toNodeOptions(options, boundMs);
  let child;
  let timer;
  let timedOut = false;
  const handlers = new Map();
  try {
    child = spawn(command, args, nodeOptions);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        try { onTermination(); }
        finally {
          signalChild(child, 'SIGKILL');
          // Restore the signal's normal exit semantics after cleanup.
          process.removeListener(signal, handler);
          process.kill(process.pid, signal);
        }
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    if (boundMs > 0) timer = setTimeout(() => { timedOut = true; signalChild(child, 'SIGKILL'); }, boundMs);
    return await new Promise(resolve => {
      let spawnError;
      child.once('error', error => { spawnError = error; });
      child.once('close', (status, signal) => {
        const error = timedOut ? Object.assign(new Error(`Command timed out after ${boundMs}ms`), { code: 'ETIMEDOUT' }) : spawnError;
        enrichTimeoutError(error, { description: describeCommand(command, args), tier, boundMs, signal });
        resolve({ status, signal, error, pid: child.pid, stdout: null, stderr: null, output: [] });
      });
    });
  } finally {
    clearTimeout(timer);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}
