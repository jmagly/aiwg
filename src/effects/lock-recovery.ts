/**
 * Operator-authorized recovery of a stale effect ledger lock.
 *
 * Ledger locks (`locks/<name>.lock`) are same-host directory locks whose
 * `owner` file holds `<pid>:<uuid>`. A crashed writer leaves its lock behind,
 * and every later writer then times out rather than steal it. This module is
 * the only supported way to clear such a lock. It is modelled on the D16 quota
 * lock recovery (`recoverStaleJobQuotaLock`, `src/decision/job-quota.ts`):
 *
 * - it refuses a live owner, a PID that has been reused by a newer process,
 *   and any owner it cannot verify (malformed owner file, permission denied);
 * - it needs an explicit authorization callback, which must approve the exact
 *   inspected owner;
 * - it re-checks the owner after authorization and removes the lock only when
 *   the same dead owner still holds it;
 * - it records the recovery in the ledger as a signed, verified effect of kind
 *   `x.aiwg.ledger-lock-recovery` (intent before the removal, completed after
 *   the lock-state verifier confirms it).
 *
 * @see docs/contracts/effect-ledger.v1.md "Stale lock recovery"
 */

import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { EFFECT_EXIT_CODES, EffectLedgerError, usageError, type EffectExitCode } from './errors.js';
import { payloadDigest, sha256Digest } from './identity.js';
import { EffectLedger, lookupEffect, recordIntent, recordOutcome, recordReconciled, type EffectReceipt } from './ledger.js';
import { resolveLedgerPaths, type LedgerPaths } from './store.js';
import { createVerifierRegistry, runVerifier } from './verifiers/registry.js';
import { EffectVerifierError, type EffectVerifier } from './verifiers/types.js';
import type { EffectLinks, EffectScope, EffectVerification } from './types.js';

export const LOCK_RECOVERY_KIND = 'x.aiwg.ledger-lock-recovery' as const;
export const LOCK_RECOVERY_VERIFIER_VERSION = '1.0.0';
/** Lock names the ledger creates: one per writer, plus the checkpoint and keyring locks. */
export const LEDGER_LOCK_NAME_PATTERN = /^(?:writer-[a-z0-9][a-z0-9-]{0,63}|checkpoint|keyring)$/;

const OWNER_PATTERN = /^([1-9][0-9]{0,9}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const RECOVERY_GUARD = '.recover.guard';
/** A process that started this long after the owner file was written cannot be its owner. */
const PID_REUSE_TOLERANCE_MS = 2_000;

export type LedgerLockOwnerState = 'dead' | 'live' | 'reused' | 'unverifiable';

export interface LedgerLockInspection {
  lock: string;
  held: boolean;
  state?: LedgerLockOwnerState;
  /** `owner-dead`, `owner-live`, `owner-pid-reused`, `owner-unreadable`, `owner-malformed`, `owner-permission-denied` or `not-held`. */
  reason: string;
  pid?: number;
  /** `sha256:` over the owner file value. The value itself is never returned. */
  ownerDigest?: string;
  lockedAt?: string;
}

export interface LockRecoveryOptions {
  /** Must approve the exact inspected owner. A throw or `false` refuses. */
  authorize: (inspection: LedgerLockInspection) => Promise<boolean>;
  links?: EffectLinks;
}

export type LockRecoveryOutcome = 'recovered' | 'not-held' | 'refused' | 'not-authorized' | 'recovery-in-progress';

export interface LockRecoveryResult {
  outcome: LockRecoveryOutcome;
  lock: string;
  inspection: LedgerLockInspection;
  effectId?: string;
  intent?: EffectReceipt;
  completed?: EffectReceipt | null;
  verification?: EffectVerification;
  exitCode: EffectExitCode;
}

export function lockRecoveryTarget(scope: EffectScope, lock: string): string {
  return `x-aiwg:effects/${scope.subsystem}/locks/${lock}`;
}

function assertLockName(lock: unknown): asserts lock is string {
  if (typeof lock !== 'string' || !LEDGER_LOCK_NAME_PATTERN.test(lock)) throw usageError('Unknown effect ledger lock name', 'invalid-lock-name');
}

const lockDir = (paths: LedgerPaths, lock: string) => join(paths.locks, `${lock}.lock`);

/** Linux only: the process start time in epoch ms, or null when it cannot be read. */
async function processStartMs(pid: number): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTicks = Number(fields[19]);
    const bootLine = (await readFile('/proc/stat', 'utf8')).split('\n').find(line => line.startsWith('btime '));
    const bootSeconds = Number(bootLine?.split(/\s+/)[1]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(bootSeconds)) return null;
    // /proc reports start time in USER_HZ, which is 100 on Linux.
    return bootSeconds * 1000 + (startTicks / 100) * 1000;
  } catch { return null; }
}

async function ownerState(pid: number, lockedAtMs: number): Promise<{ state: LedgerLockOwnerState; reason: string }> {
  try { process.kill(pid, 0); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { state: 'dead', reason: 'owner-dead' };
    return { state: 'unverifiable', reason: code === 'EPERM' ? 'owner-permission-denied' : 'owner-unreadable' };
  }
  const started = await processStartMs(pid);
  if (started !== null && started > lockedAtMs + PID_REUSE_TOLERANCE_MS) return { state: 'reused', reason: 'owner-pid-reused' };
  return { state: 'live', reason: 'owner-live' };
}

async function inspectAt(paths: LedgerPaths, lock: string): Promise<LedgerLockInspection & { token?: string }> {
  const dir = lockDir(paths, lock);
  let info;
  try { info = await lstat(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { lock, held: false, reason: 'not-held' };
    return { lock, held: true, state: 'unverifiable', reason: 'owner-unreadable' };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return { lock, held: true, state: 'unverifiable', reason: 'owner-malformed' };
  const ownerFile = join(dir, 'owner');
  let token: string;
  let ownerInfo;
  try {
    ownerInfo = await lstat(ownerFile);
    if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || (ownerInfo.mode & 0o077) !== 0) {
      return { lock, held: true, state: 'unverifiable', reason: 'owner-malformed' };
    }
    token = (await readFile(ownerFile, 'utf8')).trim();
  } catch {
    return { lock, held: true, state: 'unverifiable', reason: 'owner-unreadable' };
  }
  const match = OWNER_PATTERN.exec(token);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    return { lock, held: true, state: 'unverifiable', reason: 'owner-malformed', lockedAt: ownerInfo.mtime.toISOString() };
  }
  const pid = Number(match[1]);
  const lockedAtMs = ownerInfo.mtimeMs;
  const state = pid === process.pid ? { state: 'live' as const, reason: 'owner-live' } : await ownerState(pid, lockedAtMs);
  return { lock, held: true, ...state, pid, ownerDigest: sha256Digest(token), lockedAt: new Date(lockedAtMs).toISOString(), token };
}

function publicInspection(inspection: LedgerLockInspection & { token?: string }): LedgerLockInspection {
  const { token: _token, ...rest } = inspection;
  return rest;
}

/** Inspect one ledger lock. Read-only. */
export async function inspectLedgerLock(ledger: EffectLedger, lock: string): Promise<LedgerLockInspection> {
  assertLockName(lock);
  return publicInspection(await inspectAt(ledger.paths(), lock));
}

/** Inspect every lock currently present in the ledger. Read-only. */
export async function inspectLedgerLocks(ledger: EffectLedger): Promise<LedgerLockInspection[]> {
  const paths = ledger.paths();
  let names: string[];
  try { names = await readdir(paths.locks); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const locks = names.filter(name => name.endsWith('.lock')).map(name => name.slice(0, -'.lock'.length))
    .filter(name => LEDGER_LOCK_NAME_PATTERN.test(name)).sort();
  const out: LedgerLockInspection[] = [];
  for (const lock of locks) out.push(publicInspection(await inspectAt(paths, lock)));
  return out;
}

/**
 * The lock-state verifier for recovery effects. `present` when the recovered
 * owner no longer holds the lock, `absent` when it still does.
 */
export function ledgerLockRecoveryVerifier(options: { projectDir: string }): EffectVerifier {
  return {
    kind: LOCK_RECOVERY_KIND,
    version: LOCK_RECOVERY_VERIFIER_VERSION,
    canReportAbsent: true,
    async verify(request) {
      const lock = request.context.lock;
      const ownerDigest = request.context.ownerDigest;
      if (typeof lock !== 'string' || !LEDGER_LOCK_NAME_PATTERN.test(lock) || typeof ownerDigest !== 'string'
        || request.target !== lockRecoveryTarget(request.scope, lock)) {
        throw new EffectVerifierError('malformed-response', 'Lock recovery effect has an unexpected target or context');
      }
      let paths: LedgerPaths;
      try { paths = resolveLedgerPaths(options.projectDir, request.scope.subsystem); }
      catch { throw new EffectVerifierError('container-unreadable', 'Effect ledger root is unavailable'); }
      const current = await inspectAt(paths, lock);
      if (current.held && current.reason === 'owner-unreadable') throw new EffectVerifierError('container-unreadable', 'Lock owner is unreadable');
      if (current.held && current.ownerDigest === ownerDigest) {
        return { result: 'absent', reason: 'complete-query-no-match', complete: true, evidence: { lock, held: true } };
      }
      return { result: 'present', reason: 'state-match', complete: true, evidence: { lock, held: current.held } };
    },
  };
}

/** A handle on the same ledger that appends under another writer, so recovering our own writer lock never deadlocks. */
function recoveryWriter(ledger: EffectLedger, lock: string): EffectLedger {
  if (lock !== `writer-${ledger.writer}`) return ledger;
  const writer = ledger.writer === 'lock-recovery' ? 'lock-recovery-alt' : 'lock-recovery';
  return new EffectLedger({
    projectDir: ledger.projectDir, scope: ledger.scope, writer,
    keyProvider: { name: 'delegated', load: () => ledger.signingKey() },
    clock: () => Date.parse(ledger.now()), sink: ledger.sink, verifiers: ledger.verifiers, lockTimeoutMs: ledger.lockTimeoutMs,
  });
}

/**
 * Remove a stale ledger lock after explicit authorization and record the
 * recovery in the ledger. A live, reused or unverifiable owner is refused and
 * nothing is removed or recorded.
 */
export async function recoverStaleLedgerLock(ledger: EffectLedger, lock: string, options: LockRecoveryOptions): Promise<LockRecoveryResult> {
  assertLockName(lock);
  if (!options || typeof options.authorize !== 'function') throw usageError('Lock recovery requires an explicit authorization', 'authorization-required');
  const paths = ledger.paths();
  const refuse = (outcome: LockRecoveryOutcome, inspection: LedgerLockInspection, exitCode: EffectExitCode): LockRecoveryResult => ({
    outcome, lock, inspection: publicInspection(inspection), exitCode,
  });
  const first = await inspectAt(paths, lock);
  if (!first.held) return refuse('not-held', first, EFFECT_EXIT_CODES.absent);
  const guard = join(paths.locks, RECOVERY_GUARD);
  try { await mkdir(guard, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return refuse('recovery-in-progress', first, EFFECT_EXIT_CODES.conflict);
    throw error;
  }
  try {
    const inspection = await inspectAt(paths, lock);
    if (!inspection.held) return refuse('not-held', inspection, EFFECT_EXIT_CODES.absent);
    if (inspection.state !== 'dead') {
      return refuse('refused', inspection, inspection.state === 'unverifiable' ? EFFECT_EXIT_CODES.unknown : EFFECT_EXIT_CODES.conflict);
    }
    let approved = false;
    try { approved = (await options.authorize(publicInspection(inspection))) === true; } catch { approved = false; }
    if (!approved) return refuse('not-authorized', inspection, EFFECT_EXIT_CODES.usage);

    const recorder = recoveryWriter(ledger, lock);
    await recorder.signingKey();
    const context = { lock, ownerPid: inspection.pid!, ownerDigest: inspection.ownerDigest! };
    const digest = payloadDigest({ schemaVersion: 'aiwg.effect.lock-recovery.v1', ...context, authorizedBy: 'operator' });
    const identity = { kind: LOCK_RECOVERY_KIND, target: lockRecoveryTarget(ledger.scope, lock), context };
    const intent = await recordIntent(recorder, { ...identity, payloadDigest: digest, links: options.links });

    const recheck = await inspectAt(paths, lock);
    if (recheck.held && (recheck.state !== 'dead' || recheck.ownerDigest !== inspection.ownerDigest)) {
      return { ...refuse('refused', recheck, EFFECT_EXIT_CODES.conflict), effectId: intent.effectId, intent };
    }
    if (recheck.held) await rm(lockDir(paths, lock), { recursive: true });

    const found = await lookupEffect(recorder, intent.effectId);
    const intentAt = found.records.find(record => record.phase === 'intent')?.recordedAt ?? recorder.now();
    const run = await runVerifier(createVerifierRegistry([ledgerLockRecoveryVerifier({ projectDir: ledger.projectDir })]).get(LOCK_RECOVERY_KIND), {
      effectId: intent.effectId, scope: structuredClone(ledger.scope), kind: LOCK_RECOVERY_KIND, target: identity.target,
      context, payloadDigest: digest, intentRecordedAt: intentAt, expected: {},
    });
    const verification: EffectVerification = { verifier: run.verifier, ...run.observation, checkedAt: recorder.now() };
    let completed: EffectReceipt | null = null;
    if (verification.result === 'present') {
      completed = await recordOutcome(recorder, intent.effectId, { phase: 'completed', payloadDigest: digest, verification, links: options.links });
    } else {
      await recordReconciled(recorder, intent.effectId, verification, options.links);
    }
    const exitCode = verification.result === 'present' ? EFFECT_EXIT_CODES.ok : verification.result === 'absent' ? EFFECT_EXIT_CODES.absent : EFFECT_EXIT_CODES.unknown;
    return {
      outcome: verification.result === 'present' ? 'recovered' : 'refused', lock, inspection: publicInspection(inspection),
      effectId: intent.effectId, intent, completed, verification, exitCode,
    };
  } catch (error) {
    if (error instanceof EffectLedgerError) throw error;
    throw new EffectLedgerError('internal', 'Effect ledger lock recovery failed', 'lock-recovery-failed');
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}
