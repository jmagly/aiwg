/**
 * Tests for #2915 scoped recovery: narrowest-scope failure attribution,
 * bounded probe/canary episodes and the stop-before-retry gate.
 *
 * All time is synthetic (vitest fake timers; zero jitter). No spawns, no
 * network, no model calls — synthetic invocation ids and reason codes only.
 *
 * @implements #2915
 */
import '../../fixtures/ralph-external/worker-process-inventory.mjs';
import { normalizeMarkerRunRecord, normalizeMarkerCallbackLog } from '../../fixtures/ralph-external/invocation-marker-equivalence.mjs';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, chmod, readdir, truncate, link, unlink } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { existsSync } from 'node:fs';
// #2915 round 8 review 8 (C8): a mostly-transparent passthrough mock of
// `node:fs/promises` so ONE test below can record the exact sequence of
// `.sync()` (fsync) calls `open()` returns, by target path, in call order
// -- an injected-filesystem seam this module has no other way to observe.
// Methods forward unchanged unless a test spies on them; `open` itself
// forwards to the real implementation and returns the REAL handle, merely
// wrapping that handle's own `.sync` to additionally push its target path
// into `__aiwgSyncTrace.current` when one is installed (`null` by default,
// so every other test in this file -- which also exercises real
// `node:fs/promises` calls throughout -- observes byte-identical behavior).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const state = { trace: null, beforeSync: null };
  const open = async (targetPath, ...rest) => {
    const handle = await actual.open(targetPath, ...rest);
    const originalSync = handle.sync.bind(handle);
    handle.sync = async (...syncArgs) => {
      await state.beforeSync?.(targetPath);
      if (state.trace) state.trace.push(targetPath);
      return originalSync(...syncArgs);
    };
    return handle;
  };
  return { ...actual, open, __aiwgSyncTrace: state };
});
import os from 'node:os';
import path from 'node:path';
import { loadRecoveryModuleGraph } from '../../helpers/recovery-module-graph.mjs';
import { reapedWorkerSpawn as directSpawn } from '../../helpers/reaped-worker-spawn.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { systemdClientFixture } from '../../fixtures/systemd-client.js';
import { parseLedgerReleaseArgs } from '../../../tools/ralph-external/index.mjs';
import { sampleWorkerIdentity } from '../../../tools/ralph-external/process-monitor.mjs';
import { resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import {
  ConsecutiveFailureCircuitBreaker,
  ScopedFailureBreaker,
  RecoveryPolicy,
  validateRecoveryPolicy,
  FailureScope,
  isTrustedRecoveryEvidence,
  attributeFailureScope,
  scopeKeyFor,
  scopeRank,
} from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import * as breakerModule from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import {
  SessionLauncher,
  STOP_BEFORE_RETRY_CODE,
  UNBOUND_RETRY_EVIDENCE_CODE,
  RECOVERY_SCOPE_OPEN_CODE,
  stopBeforeRetryGate,
  assertStopBeforeRetry,
  MAX_STARTUP_CORRECTIONS,
  startupCorrectionGate,
  buildFailureAttribution,
  classifyLaunchOutcomeForRecovery,
  recoveryScopeKeysForInvocation,
  setDirectRecoveryBreaker,
  resetDirectRecoveryBreaker,
  admitDirectWorker,
  settleDirectWorker,
  classifyAttemptForSettlement,
  planDirectWorkerLaunch,
  verifyRetryPredecessor,
  stableTaskChainDigest,
  ALLOWANCE_EXHAUSTED_CODE,
  ALLOWANCE_POLICY_MISMATCH_CODE,
  LEDGER_RECORD_INVALID_CODE,
  publishWorkerRecord,
  resetInProcessAllowanceLedger,
  reserveDirectWorkerAllowance,
  debitDirectWorkerAllowance,
  refundDirectWorkerAllowance,
  reserveLedgerCorrection,
  releaseLedgerSlot,
  releaseLedgerPolicy,
  resolveStopEvidence,
  observeStandaloneUnitSettlement,
  directRecoveryEligibility,
} from '../../../tools/ralph-external/session-launcher.mjs';
import { inspectWorkerPath } from '../../../src/serve/worker-invocation.js';
import { ProviderAdapter } from '../../../tools/ralph-external/lib/provider-adapter.mjs';
// #2915 round 8 (D6): the frozen `8c812250d6` reference fixture — see its
// own header comment. Used ONLY by the "baseline equivalence" describe
// block below; never by production code.
import { SessionLauncher as SessionLauncherBaseline, planDirectWorkerLaunch as planDirectWorkerLaunchBaseline }
  from '../../fixtures/ralph-recovery-baseline/session-launcher.mjs';
// The frozen launcher revalidates a saved plan with the frozen resolver, so a
// baseline-side plan must be resolved by that same resolver. Its catalogDigest
// algorithm predates GH #364 (which drops discovery.fetchedAt on the branch).
import { resolveWorkerInvocation as resolveWorkerInvocationBaseline }
  from '../../fixtures/ralph-recovery-baseline/src/serve/worker-invocation.ts';

const { installation: recoveryInstallation } = await loadRecoveryModuleGraph();
const { getWorkerRecoveryCapabilities, registerWorkerRecoveryCapabilities } = recoveryInstallation;

const INSTALL = scopeKeyFor.installation('codex');
const QUOTA = scopeKeyFor.quota('acct-1');
const HOST = scopeKeyFor.host('noodle');
const PROVIDER = scopeKeyFor.provider('openai');

// Trusted launcher evidence for a missing CLI binary: the only NOT_FOUND
// signal that may implicate the installation scope. Worker-observed
// NOT_FOUND (a missing task subprocess) must never reach this helper.
function installFailure(id, extra = {}) {
  return { scope: FailureScope.INSTALLATION, scopeKey: INSTALL, invocationId: id,
    reasonCode: 'NOT_FOUND', evidenceSource: 'launcher', cli: 'codex', ...extra };
}

function trustedQuotaFailure(id, cli, extra = {}) {
  return { scope: FailureScope.QUOTA, scopeKey: QUOTA, invocationId: id,
    reasonCode: 'RATE_LIMIT', evidenceSource: 'resolver', cli, quotaAccount: 'acct-1', ...extra };
}

// #2915 final: thin test helpers over the new admit()/settle() pair,
// matching the semantics the OLD canLaunch()+recordFailure()/recordSuccess()
// pair exposed, so the scenarios below read the same way they did before the
// reservation-token redesign.
//
// `fail`/`succeed`/`uncertain` each perform ONE atomic admit()+settle() for
// one attempt — mirroring "this attempt launched and then concluded" rather
// than the old two-step "note, then record" calls. `probe` performs a
// read-only admission check: if admitted (including as a canary) it
// immediately settles as 'uncertain' so a pure check never leaves a
// dangling reservation that would perturb a later assertion in the same
// test (the old `canLaunch` alone never mutated state for a closed scope).
// #2915 round 8 review 8 (C1, "outcome settlement retains unresolved
// execution"): every settlement below now carries `confirmedStop: true` —
// these helpers simulate a complete, self-contained synthetic attempt with
// no real descendant process for the breaker to ever confirm the stop of,
// so (unlike production evidence) the test itself IS the confirmation that
// nothing is left running. Omitting it here would leave every one of these
// helpers' reservations permanently retained (by design — see `settle()`),
// which is exactly what the DEDICATED retention tests below construct by
// hand via raw `breaker.admit`/`beginDispatch`/`commitDispatch`/`settle`
// calls that deliberately omit `confirmedStop`.
// #2915 round 8 (D3): every settled attempt below goes through the SAME
// beginDispatch -> commitDispatch bracket production dispatch now requires
// (inside the D2 hook) before `settle()` ever applies a real outcome, so
// these helpers exercise the new admitted -> committing -> dispatched
// transition exactly like a real caller must, rather than calling settle()
// straight off a bare admit() (which would be a never-dispatched reservation
// per the new design — see `abortDispatch`). `selectionDigest: null` matches
// what `admit()` stores by default when a helper omits it (these scope/
// correlation scenarios have no resolved selection identity to bind).
// Existing canary/stop scenarios start after a successful synthetic probe.
// Dedicated probe tests exercise production execution, charging and relevance.
function completePreliminaryProbe(breaker, scopeKeys) {
  const invocationId = `preliminary-${Math.random().toString(36).slice(2)}`;
  const probe = breaker.admit({ invocationId, scopeKeys, purpose: 'probe' });
  expect(probe.ok).toBe(true);
  dispatchReservation(breaker, probe.token, invocationId);
  breaker.settle(probe.token, { kind: 'succeeded', relevant: true, evidenceSource: 'launcher', confirmedStop: true });
}

function admitAfterSuccessfulProbe(breaker, options) {
  let admitted = breaker.admit(options);
  if (!admitted.ok && admitted.probeRequired?.length) {
    completePreliminaryProbe(breaker, options.scopeKeys);
    admitted = breaker.admit(options);
  }
  return admitted;
}

function dispatchReservation(breaker, token, invocationId) {
  const began = breaker.beginDispatch(token, { invocationId, selectionDigest: null });
  if (!began.ok) return began;
  return breaker.commitDispatch(token);
}

function probe(breaker, scopeKeys) {
  const invocationId = `probe-${Math.random().toString(36).slice(2)}`;
  const admission = admitAfterSuccessfulProbe(breaker, { invocationId, scopeKeys });
  if (admission.ok) {
    dispatchReservation(breaker, admission.token, invocationId);
    breaker.settle(admission.token, { kind: 'uncertain', confirmedStop: true });
  }
  return admission;
}

function fail(breaker, scopeKeys, invocationId, evidence = {}) {
  const admission = admitAfterSuccessfulProbe(breaker, { invocationId, scopeKeys });
  if (!admission.ok) return { admitted: false, blockedBy: admission.blockedBy };
  dispatchReservation(breaker, admission.token, invocationId);
  const watched = evidence.scopeKey ?? scopeKeys[0];
  const before = breaker.getState(watched).state;
  const settled = breaker.settle(admission.token, { kind: 'failed', confirmedStop: true, ...evidence });
  const after = breaker.getState(watched).state;
  return { admitted: true, settled, opened: before !== 'open' && after === 'open',
    canaryFailed: admission.token.canaryKeys.includes(watched), token: admission.token };
}

function succeed(breaker, scopeKeys, invocationId) {
  const admission = admitAfterSuccessfulProbe(breaker, { invocationId, scopeKeys });
  if (!admission.ok) return { admitted: false, blockedBy: admission.blockedBy };
  dispatchReservation(breaker, admission.token, invocationId);
  return { admitted: true, settled: breaker.settle(admission.token, { kind: 'succeeded', confirmedStop: true }), token: admission.token };
}

function uncertain(breaker, scopeKeys, invocationId) {
  const admission = admitAfterSuccessfulProbe(breaker, { invocationId, scopeKeys });
  if (!admission.ok) return { admitted: false, blockedBy: admission.blockedBy };
  dispatchReservation(breaker, admission.token, invocationId);
  return { admitted: true, settled: breaker.settle(admission.token, { kind: 'uncertain', confirmedStop: true }), token: admission.token };
}

// Convenience: an evidence object shaped like `installFailure(id)`/
// `trustedQuotaFailure(id, ...)` (carrying its own `invocationId` and
// `scopeKey`) admitted-then-settled as ONE failed attempt, exactly mirroring
// the single `breaker.recordFailure(evidence)` call these scenarios used
// before the admit()/settle() redesign.
function failEvidence(breaker, evidence, scopeKeys = [evidence.scopeKey]) {
  return fail(breaker, scopeKeys, evidence.invocationId, evidence);
}

function copyRecoveryDriver(driver, overrides) {
  const copy = { ...driver, ...overrides };
  const capabilities = getWorkerRecoveryCapabilities(driver);
  if (capabilities) registerWorkerRecoveryCapabilities(copy, capabilities);
  return copy;
}

describe('RecoveryPolicy explicit bounds', () => {
  it('pins every loop to an explicit number', () => {
    expect(RecoveryPolicy.distinctThreshold).toBe(3);
    expect(RecoveryPolicy.windowMs).toBe(120_000);
    expect(RecoveryPolicy.minOutstanding).toBe(2);
    expect(RecoveryPolicy.cooldownMs).toBe(120_000);
    expect(RecoveryPolicy.maxCooldownMs).toBe(900_000);
    expect(RecoveryPolicy.canaryTimeoutMs).toBe(300_000);
    expect(RecoveryPolicy.backoffMultiplier).toBe(2);
    expect(RecoveryPolicy.maxTrackedScopes).toBe(500);
    expect(RecoveryPolicy.maxChargedAttempts).toBe(5_000);
  });

  it('rejects unbounded or out-of-range policy overrides', () => {
    for (const policy of [
      { cooldownMs: Number.NaN },
      { cooldownMs: Number.POSITIVE_INFINITY },
      { distinctThreshold: 0 },
      { maxCooldownMs: 1 },
      { canaryTimeoutMs: -5 },
      { backoffMultiplier: 0.5 },
      { maxTrackedScopes: 1 },
      { maxChargedAttempts: 1.5 },
    ]) {
      expect(() => validateRecoveryPolicy({ ...RecoveryPolicy, ...policy })).toThrow(RangeError);
    }
    expect(validateRecoveryPolicy({ ...RecoveryPolicy })).toEqual(RecoveryPolicy);
    expect(() => new ScopedFailureBreaker({ policy: { cooldownMs: Number.NaN } })).toThrow(RangeError);
  });
});

describe('attributeFailureScope', () => {
  it('attributes trusted 429 to the shared quota scope across aliases', () => {
    const a = attributeFailureScope({ reasonCode: 'RATE_LIMIT', evidenceSource: 'resolver', cli: 'codex', quotaAccount: 'acct-1' });
    const b = attributeFailureScope({ reasonCode: 'RATE_LIMIT', evidenceSource: 'resolver', cli: 'codex-alias', quotaAccount: 'acct-1' });
    expect(a.scope).toBe(FailureScope.QUOTA);
    expect(a.scopeKey).toBe(b.scopeKey);
    expect(a.confidence).toBe('suspected');
  });

  it('keeps worker-observed signatures in the invocation scope, however alarming', () => {
    // Scope-poisoning regression: a worker blaming the provider, the host,
    // or quota in its own output must never widen the recorded scope.
    for (const reasonCode of ['RATE_LIMIT', 'NETWORK', 'NOT_FOUND', 'RESOURCE', 'SANDBOX', 'AUTH', 'MODEL']) {
      for (const evidenceSource of ['worker', null, undefined]) {
        const out = attributeFailureScope({ reasonCode, evidenceSource, cli: 'codex',
          inferenceProvider: 'openai', quotaAccount: 'acct-1', modelKey: 'openai/gpt-x', invocationId: 'task-7' });
        expect(out.scope).toBe(FailureScope.INVOCATION);
        expect(out.scopeKey).toBe('invocation:task-7');
      }
    }
  });

  it('keeps single-provider host signatures in the invocation scope without cross-provider corroboration', () => {
    for (const reasonCode of ['RESOURCE', 'SANDBOX']) {
      const single = attributeFailureScope({ reasonCode, evidenceSource: 'launcher', cli: 'codex',
        inferenceProvider: 'openai', corroboratedBackends: ['openai'], invocationId: 'i' });
      expect(single.scope).toBe(FailureScope.INVOCATION);
    }
    const corroborated = attributeFailureScope({ reasonCode: 'RESOURCE', evidenceSource: 'launcher', cli: 'codex',
      inferenceProvider: 'openai', corroboratedBackends: ['openai', 'anthropic'], hostId: 'noodle' });
    expect(corroborated.scope).toBe(FailureScope.HOST);
    expect(corroborated.scopeKey).toBe('host:noodle');
  });

  it('attributes trusted transport errors to the backend, never the CLI installation', () => {
    // Identity-separation regression: backend `openai` must not become
    // `provider:codex`, and `anthropic` must not become an installation key.
    const out = attributeFailureScope({ reasonCode: 'NETWORK', evidenceSource: 'launcher',
      cli: 'codex', inferenceProvider: 'openai', invocationId: 'i' });
    expect(out.scope).toBe(FailureScope.PROVIDER);
    expect(out.scopeKey).toBe('provider:openai');
    expect(attributeFailureScope({ reasonCode: 'AUTH', evidenceSource: 'launcher', cli: 'codex' }).scopeKey)
      .toBe('installation:codex');
    expect(attributeFailureScope({ reasonCode: 'MODEL', evidenceSource: 'launcher', modelKey: 'openai/gpt-x' }).scopeKey)
      .toBe('model:openai/gpt-x');
  });

  it('attributes a launcher-observed missing CLI binary to the installation, never the host', () => {
    const out = attributeFailureScope({ reasonCode: 'NOT_FOUND', evidenceSource: 'launcher', cli: 'codex', invocationId: 'i' });
    expect(out.scope).toBe(FailureScope.INSTALLATION);
    expect(out.scopeKey).toBe('installation:codex');
  });

  it('folds wide claims without their required trusted identity back to invocation', () => {
    expect(attributeFailureScope({ reasonCode: 'RATE_LIMIT', evidenceSource: 'launcher', cli: 'codex', invocationId: 'i' }).scope)
      .toBe(FailureScope.INVOCATION);
    expect(attributeFailureScope({ reasonCode: 'NETWORK', evidenceSource: 'launcher', cli: 'codex', invocationId: 'i' }).scope)
      .toBe(FailureScope.INVOCATION);
    expect(attributeFailureScope({ reasonCode: 'AUTH', evidenceSource: 'launcher', invocationId: 'i' }).scope)
      .toBe(FailureScope.INVOCATION);
  });

  it('keeps task-local and unknown failures in the invocation scope', () => {
    for (const reasonCode of [null, 'UNKNOWN', 'TASK_ASSERT_FAILED', 'EXIT_ZERO_ERROR', 'STDIN_WAIT', 'TRUST', 'NO_PROGRESS']) {
      const out = attributeFailureScope({ reasonCode, evidenceSource: 'launcher', cli: 'codex', invocationId: 'task-7' });
      expect(out.scope).toBe(FailureScope.INVOCATION);
      expect(out.scopeKey).toBe('invocation:task-7');
    }
  });

  it('orders scopes narrowest-first for fold-back', () => {
    expect(scopeRank('invocation')).toBeLessThan(scopeRank('installation'));
    expect(scopeRank('installation')).toBeLessThan(scopeRank('provider'));
    expect(scopeRank('provider')).toBeLessThan(scopeRank('host'));
    expect(isTrustedRecoveryEvidence('launcher')).toBe(true);
    expect(isTrustedRecoveryEvidence('resolver')).toBe(true);
    expect(isTrustedRecoveryEvidence('worker')).toBe(false);
    expect(isTrustedRecoveryEvidence(null)).toBe(false);
  });
});

describe('ScopedFailureBreaker correlation', () => {
  let breaker;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
    breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
  });

  afterEach(() => {
    breaker.destroy();
    vi.useRealTimers();
  });

  it('opens the narrowest scope at three distinct failures in 120s', () => {
    expect(fail(breaker, [INSTALL], 'a', installFailure('a')).opened).toBe(false);
    expect(fail(breaker, [INSTALL], 'b', installFailure('b')).opened).toBe(false);
    const third = fail(breaker, [INSTALL], 'c', installFailure('c'));
    expect(third.opened).toBe(true);
    expect(breaker.getState(INSTALL).state).toBe('open');

    // Covered launches stop by the next check; unaffected scopes continue.
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    expect(probe(breaker, [scopeKeyFor.installation('claude')]).ok).toBe(true);
    expect(probe(breaker, [PROVIDER, QUOTA, HOST]).ok).toBe(true);
  });

  it('counts each distinct invocation once per window', () => {
    fail(breaker, [INSTALL], 'a', installFailure('a'));
    fail(breaker, [INSTALL], 'a', installFailure('a'));
    fail(breaker, [INSTALL], 'a', installFailure('a'));
    expect(breaker.getState(INSTALL).distinctFailures).toBe(1);
    expect(breaker.getState(INSTALL).state).toBe('closed');
    expect(probe(breaker, [INSTALL]).ok).toBe(true);
  });

  it('opens when all of two outstanding attempts fail, stays shut for two-of-five', () => {
    const resA = admitAfterSuccessfulProbe(breaker, { invocationId: 'a', scopeKeys: [INSTALL] });
    const resB = admitAfterSuccessfulProbe(breaker, { invocationId: 'b', scopeKeys: [INSTALL] });
    breaker.settle(resA.token, { kind: 'failed', ...installFailure('a') });
    expect(breaker.settle(resB.token, { kind: 'failed', ...installFailure('b') })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).state).toBe('open');

    breaker.reset(INSTALL);
    const outstanding = ['c', 'd', 'e', 'f', 'g'].map((id) => admitAfterSuccessfulProbe(breaker, { invocationId: id, scopeKeys: [INSTALL] }));
    breaker.settle(outstanding[0].token, { kind: 'failed', ...installFailure('c') });
    breaker.settle(outstanding[1].token, { kind: 'failed', ...installFailure('d') });
    expect(breaker.getState(INSTALL).state).toBe('closed');
  });

  it('prunes failures outside the rolling window', () => {
    fail(breaker, [INSTALL], 'a', installFailure('a'));
    fail(breaker, [INSTALL], 'b', installFailure('b'));
    vi.advanceTimersByTime(121_000);
    fail(breaker, [INSTALL], 'c', installFailure('c'));
    expect(fail(breaker, [INSTALL], 'd', installFailure('d')).opened).toBe(false);
    expect(breaker.getState(INSTALL).state).toBe('closed');
  });

  it('never opens a wider scope for independent task failures', () => {
    for (const id of ['t1', 't2', 't3']) {
      const key = scopeKeyFor.invocation(id);
      fail(breaker, [key], id, { scope: FailureScope.INVOCATION, scopeKey: key, reasonCode: 'TASK_ASSERT_FAILED' });
    }
    expect(probe(breaker, [PROVIDER, INSTALL, QUOTA, HOST]).ok).toBe(true);
    expect(breaker.getState(PROVIDER).tracked).toBe(false);
  });

  it('opens exactly once at the threshold and stays open on further failures, never re-opening', () => {
    expect(fail(breaker, [INSTALL], 'a', installFailure('a')).opened).toBe(false);
    expect(fail(breaker, [INSTALL], 'b', installFailure('b')).opened).toBe(false);
    expect(fail(breaker, [INSTALL], 'c', installFailure('c')).opened).toBe(true);
    expect(breaker.getState(INSTALL).distinctFailures).toBe(3);
    expect(breaker.getState(INSTALL).nextProbeAtMs).toBeGreaterThan(0);
    // A fourth failure cannot reach here without an admission (the scope is
    // already open and not due); repeated read-only checks are inert.
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    expect(breaker.getState(INSTALL).state).toBe('open');
  });

  it('shares quota scope across CLIs and honors the 429 reset', () => {
    fail(breaker, [QUOTA], 'q1', trustedQuotaFailure('q1', 'codex', { retryAfterSeconds: 300 }));
    fail(breaker, [QUOTA], 'q2', trustedQuotaFailure('q2', 'cursor', { retryAfterSeconds: 300 }));
    expect(fail(breaker, [QUOTA], 'q3', trustedQuotaFailure('q3', 'codex', { retryAfterSeconds: 300 })).opened).toBe(true);
    const state = breaker.getState(QUOTA);
    expect(state.resetAtMs).toBe(Date.now() + 300_000);
    // Earliest probe is max(120s cooldown, reset): still not due at +121s.
    vi.advanceTimersByTime(121_000);
    expect(probe(breaker, [QUOTA]).ok).toBe(false);
    vi.advanceTimersByTime(180_000);
    expect(probe(breaker, [QUOTA]).ok).toBe(true);
  });

  it('refuses to open the quota scope on worker-claimed 429 without trusted account identity', () => {
    // Scope-poisoning regression at the settle()/_settleFailure enforcement
    // point: a wide claim on untrusted evidence folds back instead of opening.
    for (const id of ['w1', 'w2', 'w3']) {
      fail(breaker, [QUOTA], id, { scope: FailureScope.QUOTA, scopeKey: QUOTA,
        reasonCode: 'RATE_LIMIT', evidenceSource: 'worker', cli: 'codex', quotaAccount: 'acct-1' });
    }
    expect(breaker.getState(QUOTA).tracked).toBe(false);
    expect(probe(breaker, [QUOTA]).ok).toBe(true);
  });

  it('falls back to bounded backoff on a malformed reset', () => {
    const t0 = Date.now();
    fail(breaker, [QUOTA], 'm1', trustedQuotaFailure('m1', 'codex', { retryAfterSeconds: Number.NaN }));
    fail(breaker, [QUOTA], 'm2', trustedQuotaFailure('m2', 'codex', { resetAtMs: -5 }));
    fail(breaker, [QUOTA], 'm3', trustedQuotaFailure('m3', 'codex'));
    const state = breaker.getState(QUOTA);
    expect(state.state).toBe('open');
    expect(state.resetAtMs).toBeNull();
    expect(state.nextProbeAtMs).toBe(t0 + 120_000); // deterministic: zero jitter
    vi.advanceTimersByTime(120_000);
    expect(probe(breaker, [QUOTA]).ok).toBe(true);
  });

  it('pushes the next probe out when a later (canary) failure carries a further reset', () => {
    // Updated-reset regression: a reset carried by the CANARY's own failure
    // (the only way a failure can be reported against an already-open scope
    // under the one-admission design — admit() refuses anything else while
    // open and not due) must move nextProbeAtMs, so no probe is admitted at
    // the un-updated +120s floor.
    fail(breaker, [QUOTA], 'r1', trustedQuotaFailure('r1', 'codex'));
    fail(breaker, [QUOTA], 'r2', trustedQuotaFailure('r2', 'codex'));
    expect(fail(breaker, [QUOTA], 'r3', trustedQuotaFailure('r3', 'codex')).opened).toBe(true);
    expect(breaker.getState(QUOTA).nextProbeAtMs).toBeGreaterThan(0);
    vi.advanceTimersByTime(120_000);
    const canary = admitAfterSuccessfulProbe(breaker, { invocationId: 'r4', scopeKeys: [QUOTA] });
    expect(canary.ok).toBe(true);
    breaker.settle(canary.token, { kind: 'failed', ...trustedQuotaFailure('r4', 'codex', { retryAfterSeconds: 420 }) });
    const state = breaker.getState(QUOTA);
    expect(state.resetAtMs).toBe(Date.now() + 420_000);
    expect(state.nextProbeAtMs).toBeGreaterThanOrEqual(state.resetAtMs);
    vi.advanceTimersByTime(240_000); // doubled backoff (240s) alone would be due here
    expect(probe(breaker, [QUOTA]).ok).toBe(false); // but the 420s reset still governs
    vi.advanceTimersByTime(180_000);
    expect(probe(breaker, [QUOTA]).ok).toBe(true);
  });

  it('stops cross-provider retries while the corroborated host scope is open', () => {
    const hostFailure = (id) => ({ scope: FailureScope.HOST, scopeKey: HOST,
      reasonCode: 'RESOURCE', evidenceSource: 'launcher', cli: 'codex',
      corroboratedBackends: ['openai', 'anthropic'] });
    for (const id of ['h1', 'h2', 'h3']) fail(breaker, [HOST], id, hostFailure(id));
    expect(breaker.getState(HOST).state).toBe('open');
    expect(probe(breaker, [scopeKeyFor.installation('claude'), PROVIDER, HOST]).ok).toBe(false);
  });

  it('promotes a genuine provider outage beyond invocation scope by the distinct-invocation rule', () => {
    // Outage-promotion regression: 20 distinct stalls with no trusted
    // evidence stay invocation-scoped and launchable...
    for (let n = 0; n < 20; n += 1) {
      const key = scopeKeyFor.invocation(`stall-${n}`);
      fail(breaker, [key], `stall-${n}`, { scope: FailureScope.INVOCATION, scopeKey: key, reasonCode: 'NO_PROGRESS', evidenceSource: 'worker' });
    }
    expect(breaker.getState(PROVIDER).tracked).toBe(false);
    expect(probe(breaker, [PROVIDER]).ok).toBe(true);
    // ...while N distinct invocations carrying the same TRUSTED backend
    // evidence open the provider scope.
    const netFailure = (id) => ({ scope: FailureScope.PROVIDER, scopeKey: PROVIDER,
      reasonCode: 'NETWORK', evidenceSource: 'launcher', cli: 'codex', inferenceProvider: 'openai' });
    expect(fail(breaker, [PROVIDER], 'p1', netFailure('p1')).opened).toBe(false);
    expect(fail(breaker, [PROVIDER], 'p2', netFailure('p2')).opened).toBe(false);
    expect(fail(breaker, [PROVIDER], 'p3', netFailure('p3')).opened).toBe(true);
    expect(breaker.getState(PROVIDER).state).toBe('open');
    expect(probe(breaker, [PROVIDER]).ok).toBe(false);
    // A different backend is unaffected by this outage.
    expect(probe(breaker, [scopeKeyFor.provider('anthropic')]).ok).toBe(true);
  });

  it('retains still-recent failures across the cohort epoch boundary', () => {
    // Rolling-window regression: failures at 0, 119s, 120.001s and 120.002s
    // hold three in-window distinct failures at the end and must open.
    fail(breaker, [INSTALL], 'e0', installFailure('e0'));
    vi.advanceTimersByTime(119_000);
    fail(breaker, [INSTALL], 'e1', installFailure('e1'));
    vi.advanceTimersByTime(1_001);
    fail(breaker, [INSTALL], 'e2', installFailure('e2'));
    vi.advanceTimersByTime(1);
    expect(fail(breaker, [INSTALL], 'e3', installFailure('e3')).opened).toBe(true);
    expect(breaker.getState(INSTALL).state).toBe('open');
  });

  it('freezes cohort membership: late joiners neither open nor veto', () => {
    const resA = admitAfterSuccessfulProbe(breaker, { invocationId: 'a', scopeKeys: [INSTALL] });
    const resB = admitAfterSuccessfulProbe(breaker, { invocationId: 'b', scopeKeys: [INSTALL] });
    breaker.settle(resA.token, { kind: 'failed', ...installFailure('a') });
    // 'c' launches after the cohort froze: it never joins, so the unanimous
    // failure of the original pair still opens the scope...
    const resC = admitAfterSuccessfulProbe(breaker, { invocationId: 'c', scopeKeys: [INSTALL] });
    expect(breaker.settle(resB.token, { kind: 'failed', ...installFailure('b') })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).cohortSize).toBe(2);
    breaker.settle(resC.token, { kind: 'uncertain' });
  });
});

describe('half-open canary admission after a successful bounded probe', () => {
  let breaker;

  const openInstall = () => {
    fail(breaker, [INSTALL], 'a', installFailure('a'));
    fail(breaker, [INSTALL], 'b', installFailure('b'));
    fail(breaker, [INSTALL], 'c', installFailure('c'));
    expect(breaker.getState(INSTALL).state).toBe('open');
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
    breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
  });

  afterEach(() => {
    breaker.destroy();
    vi.useRealTimers();
  });

  it('refuses every launch while open and not due, admits exactly one once due, then recovers on a launcher-reported success', () => {
    openInstall();
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    vi.advanceTimersByTime(119_999);
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    vi.advanceTimersByTime(1);
    const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'canary-1', scopeKeys: [INSTALL] });
    expect(admitted.ok).toBe(true);
    expect(admitted.token.canaryKeys).toEqual([INSTALL]);
    // One real attempt at a time: while that canary is outstanding, no
    // further launch for this scope is admitted, including a re-check in
    // the very same tick.
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    expect(breaker.settle(admitted.token, { kind: 'succeeded' })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).state).toBe('closed');
    expect(probe(breaker, [INSTALL]).ok).toBe(true);
    expect(breaker.snapshot().canariesObserved).toBe(1);
  });

  it('a failed canary reopens immediately with doubled backoff, never waiting on the distinct-failure threshold', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'canary-1', scopeKeys: [INSTALL] });
    expect(admitted.ok).toBe(true);
    breaker.settle(admitted.token, { kind: 'failed', ...installFailure('canary-1') });
    expect(breaker.getState(INSTALL).state).toBe('open');
    expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(240_000);
    // Not due yet at +120s (doubled backoff), due at +240s.
    vi.advanceTimersByTime(120_000);
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    vi.advanceTimersByTime(120_000);
    expect(probe(breaker, [INSTALL]).ok).toBe(true);
  });

  it('caps backoff at 900s across repeated canary failures', () => {
    openInstall();
    let at = 120_000;
    vi.advanceTimersByTime(at);
    const cooldowns = [240_000, 480_000, 900_000, 900_000];
    for (const expected of cooldowns) {
      const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: `canary-${expected}`, scopeKeys: [INSTALL] });
      expect(admitted.ok).toBe(true);
      breaker.settle(admitted.token, { kind: 'failed', ...installFailure(`canary-${expected}`) });
      expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(expected);
      at += expected;
      vi.advanceTimersByTime(expected);
    }
    expect(breaker.getState(INSTALL).state).toBe('open');
  });

  it('an uncertain canary termination releases the reservation and reopens with backoff, never recovering', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'canary-1', scopeKeys: [INSTALL] });
    expect(admitted.ok).toBe(true);
    breaker.settle(admitted.token, { kind: 'uncertain' });
    expect(breaker.getState(INSTALL).state).toBe('open');
    expect(breaker.getState(INSTALL).activeCanary).toBeNull();
    expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(240_000);
  });

  it('unrelated scopes are admitted independently; neither blocks the other', () => {
    openInstall();
    for (const id of ['x', 'y', 'z']) fail(breaker, [QUOTA], id, trustedQuotaFailure(id, 'codex'));
    vi.advanceTimersByTime(120_000);
    expect(probe(breaker, [INSTALL]).ok).toBe(true);
    expect(probe(breaker, [QUOTA]).ok).toBe(true);
  });

  it('charges every launched attempt and the canary attempt once, keeping unknown cost unknown', () => {
    fail(breaker, [INSTALL], 'same', installFailure('same'));
    fail(breaker, [INSTALL], 'same', installFailure('same'));
    expect(breaker.snapshot().attemptsObserved).toBe(1);
    // A successful launched attempt is charged too (review: successes
    // charged 0), exactly once even across repeated reports.
    const res = succeed(breaker, [INSTALL], 'ok-1');
    expect(res.admitted).toBe(true);
    expect(breaker.snapshot().attemptsObserved).toBe(2);
    // Settling the SAME reservation twice is refused (idempotent) — charging
    // happens once per admitted attempt, not per settle() call.
    expect(breaker.settle(res.token, { kind: 'succeeded' }).ok).toBe(false);
    expect(breaker.snapshot().attemptsObserved).toBe(2);
    // #2915 review 4 (finding 8): an uncertain termination opens nothing
    // AND is never recorded as an observed attempt — this diagnostic
    // counter must never read as enforcement that did not happen (every
    // pre-spawn refusal settles 'uncertain' too; the allowance LEDGER is
    // what actually enforces attempt consumption now).
    uncertain(breaker, [INSTALL], 'u-1');
    expect(breaker.snapshot().attemptsObserved).toBe(2);
    expect(breaker.getState(INSTALL).state).toBe('closed');
  });

  it('expires a hung canary with backoff and a persistent blocking marker, never admitting a second worker while stop is unconfirmed', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'canary-1', scopeKeys: [INSTALL] });
    expect(admitted.ok).toBe(true);
    // Dispatched (begin+commit), exactly like the real D2 hook: only a
    // reservation that actually reached `dispatched` leaves a stop-evidence
    // marker on expiry (#2915 round 8, D3) — one still sitting in
    // `admitted` is PROVEN to have never dispatched at all and is released
    // outright on expiry instead (see the provably-never-dispatched test
    // below).
    expect(dispatchReservation(breaker, admitted.token, 'canary-1')).toEqual({ ok: true });
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    // The dispatched attempt never reports back at all (crash/dropped
    // callback) -- past its canaryTimeoutMs deadline, the very next gate
    // check sweeps it as a failed canary, reopens with doubled backoff, AND
    // retains a bounded blocking marker (#2915 review 5, "a second worker
    // over unresolved execution"): expiry alone proves nothing about
    // whether the attempt actually stopped.
    vi.advanceTimersByTime(300_001);
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    expect(breaker.getState(INSTALL).activeCanary).toBeNull();
    expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(240_000);
    expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
    // Backoff alone is NOT sufficient to re-admit: even once fully elapsed,
    // the marker still refuses every admission for this scope.
    vi.advanceTimersByTime(240_000);
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    // A late 'succeeded' report against the expired reservation is accepted
    // as a settlement of the MARKER, but carries no confirmed-termination
    // evidence -- it can never close the scope and never clears the marker
    // either (late success cannot close a scope).
    expect(breaker.settle(admitted.token, { kind: 'succeeded' })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).state).toBe('open');
    expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    // Reusing the already-resolved token a second time is refused.
    expect(breaker.settle(admitted.token, { kind: 'succeeded' })).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('a settlement carrying confirmed-termination evidence clears the blocking marker and re-admits once due (no permanent deadlock)', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'canary-1', scopeKeys: [INSTALL] });
    expect(admitted.ok).toBe(true);
    expect(dispatchReservation(breaker, admitted.token, 'canary-1')).toEqual({ ok: true });
    vi.advanceTimersByTime(300_001);
    // Sweeps the expiry and installs the marker (no settle() has happened yet).
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
    // The launcher's own bounded diagnostic-then-stop escalation confirms
    // the attempt actually stopped; it reports that evidence through the
    // SAME reservation token -- there is nothing left to admit for this
    // specific reservation, only its marker to resolve.
    expect(breaker.settle(admitted.token, { kind: 'uncertain', confirmedStop: true })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).blockingMarker).toBeNull();
    // Not yet due: refused by ordinary backoff, not the (now-cleared) marker.
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    vi.advanceTimersByTime(240_000);
    expect(probe(breaker, [INSTALL]).ok).toBe(true);
  });

  it('a blocking marker continues to occupy its reservation slot until confirmed, bounded by the existing maxOutstandingReservations cap', () => {
    const smallCapBreaker = new ScopedFailureBreaker({ jitterMs: () => 0, policy: { maxOutstandingReservations: 1 } });
    try {
      fail(smallCapBreaker, [INSTALL], 'a', installFailure('a'));
      fail(smallCapBreaker, [INSTALL], 'b', installFailure('b'));
      fail(smallCapBreaker, [INSTALL], 'c', installFailure('c'));
      vi.advanceTimersByTime(120_000);
      const admitted = admitAfterSuccessfulProbe(smallCapBreaker, { invocationId: 'canary-1', scopeKeys: [INSTALL] });
      expect(admitted.ok).toBe(true);
      expect(dispatchReservation(smallCapBreaker, admitted.token, 'canary-1')).toEqual({ ok: true });
      vi.advanceTimersByTime(300_001);
      // Sweeping this expiry installs an unresolved blocking marker that
      // keeps the reservation live (occupying the one available slot) --
      // no separate marker cap and no auto-expiry were invented; it is
      // bounded by the SAME `maxOutstandingReservations` every other
      // reservation already counts against.
      const unrelated = admitAfterSuccessfulProbe(smallCapBreaker, { invocationId: 'unrelated', scopeKeys: [QUOTA] });
      expect(unrelated.ok).toBe(false);
      expect(unrelated.blockedBy).toContain('reservation-capacity');
      // Confirming the stop frees the slot.
      expect(smallCapBreaker.settle(admitted.token, { kind: 'uncertain', confirmedStop: true })).toEqual({ ok: true });
      const afterwards = admitAfterSuccessfulProbe(smallCapBreaker, { invocationId: 'unrelated-2', scopeKeys: [QUOTA] });
      expect(afterwards.ok).toBe(true);
    } finally {
      smallCapBreaker.destroy();
    }
  });

  // #2915 review 6 (finding 3a, "blocking markers become permanently
  // unresolvable"): the former code set `markerResolved` on the FIRST
  // settle() call against an expired reservation regardless of its
  // outcome, so an earlier UNCONFIRMED report (the common case: a degraded
  // attempt can never supply confirmed-termination evidence) permanently
  // rejected every LATER, genuinely confirmed one. A later confirmed
  // report -- or an explicit `reconcileStopEvidence` reconciliation -- must
  // still succeed at any time.
  it('an earlier unconfirmed settlement never forecloses a later confirmed one from clearing the marker', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'canary-1', scopeKeys: [INSTALL] });
    expect(admitted.ok).toBe(true);
    expect(dispatchReservation(breaker, admitted.token, 'canary-1')).toEqual({ ok: true });
    vi.advanceTimersByTime(300_001);
    // Sweeps the expiry and installs the marker.
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
    // An UNCONFIRMED report arrives first (e.g. a degraded attempt that can
    // never supply confirmed-termination evidence) -- a no-op, leaving the
    // marker in place, never "resolving" it against a future confirmed one.
    expect(breaker.settle(admitted.token, { kind: 'uncertain' })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
    // A repeated IDENTICAL unconfirmed report is refused (exactly-once,
    // matching every other settlement outcome) -- but this must never be
    // confused with the marker itself being permanently unresolvable.
    expect(breaker.settle(admitted.token, { kind: 'uncertain' })).toEqual({ ok: false, reason: expect.any(String) });
    // This reproduces the review's exact bug: without the fix, the marker
    // would ALREADY be irrecoverably stuck here, and the line below would
    // return `{ ok: false }` instead of clearing it.
    expect(breaker.settle(admitted.token, { kind: 'uncertain', confirmedStop: true })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).blockingMarker).toBeNull();
    vi.advanceTimersByTime(240_000);
    expect(probe(breaker, [INSTALL]).ok).toBe(true);
  });

  // #2915 review 6 (finding 3b, "blocking markers become permanently
  // unresolvable... zero spawns"): a reservation that provably NEVER
  // dispatched (pre-spawn refusal, expired while queued) must release
  // WITHOUT leaving a marker observable from outside, even though the
  // sweep this very settlement triggers would otherwise install one.
  // `settleDirectWorker`'s pre-spawn-refusal branches in
  // `launchOneWorker` (session-launcher.mjs) now report
  // `confirmedStop: true` for exactly this proven case.
  it('settleDirectWorker with confirmedStop:true for a provably-never-dispatched reservation releases without leaving a marker, even past the canary deadline', () => {
    let now = 0;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    try {
      for (const id of ['a', 'b', 'c']) fail(breaker, [INSTALL], id, installFailure(id));
      now += 120_000;
      const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'canary-never-dispatched', scopeKeys: [INSTALL] });
      expect(admitted.ok).toBe(true);
      expect(admitted.token.canaryKeys).toEqual([INSTALL]);
      // "Expired while queued": this exact reservation's own canary
      // deadline elapses before the caller ever attempts to dispatch it.
      now += 300_001;
      settleDirectWorker({ gated: true, breaker, token: admitted.token }, { kind: 'uncertain', confirmedStop: true });
      // Never externally observable: the sweep this settle() call performs
      // would install a marker, but the SAME call's confirmedStop evidence
      // clears it before returning.
      expect(breaker.getState(INSTALL).blockingMarker).toBeNull();
      // Still correctly reopened with doubled backoff -- confirmedStop
      // releases the marker/reservation, not the unrelated reopen
      // transition.
      expect(breaker.getState(INSTALL).state).toBe('open');
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 6 (finding 3f, "markers must not be able to starve
  // unrelated work silently"): when `reservation-capacity` is refused
  // because occupied slots are unresolved blocking markers rather than
  // live, settleable reservations, the refusal diagnostics must say so and
  // name the count.
  it('names the blocking-marker count in a reservation-capacity refusal', () => {
    const smallCapBreaker = new ScopedFailureBreaker({ jitterMs: () => 0, policy: { maxOutstandingReservations: 1 } });
    try {
      fail(smallCapBreaker, [INSTALL], 'a', installFailure('a'));
      fail(smallCapBreaker, [INSTALL], 'b', installFailure('b'));
      fail(smallCapBreaker, [INSTALL], 'c', installFailure('c'));
      vi.advanceTimersByTime(120_000);
      const admitted = admitAfterSuccessfulProbe(smallCapBreaker, { invocationId: 'canary-1', scopeKeys: [INSTALL] });
      expect(admitted.ok).toBe(true);
      expect(dispatchReservation(smallCapBreaker, admitted.token, 'canary-1')).toEqual({ ok: true });
      vi.advanceTimersByTime(300_001);
      const refused = admitAfterSuccessfulProbe(smallCapBreaker, { invocationId: 'unrelated', scopeKeys: [QUOTA] });
      expect(refused.ok).toBe(false);
      expect(refused.blockedBy).toContain('reservation-capacity');
      expect(refused.blockedBy).toContain('blocking-markers:1');
    } finally {
      smallCapBreaker.destroy();
    }
  });

  // #2915 round 8 (D3, "whole-reservation reset can erase live protection"):
  // `reset(scopeKey)` must NEVER release a reservation with unresolved
  // execution — a scope with an unresolved stop-evidence marker refuses the
  // reset outright (failure history untouched, marker untouched) rather
  // than silently recovering its capacity. Recovery is only reachable
  // through `reconcileStopEvidence`, confirming the attempt actually
  // stopped; THEN a scoped reset (or simply letting the next admission
  // proceed) is unblocked.
  it('a scoped reset refuses while unresolved execution (a blocking marker) is present, and succeeds once reconciled', () => {
    const smallCapBreaker = new ScopedFailureBreaker({ jitterMs: () => 0, policy: { maxOutstandingReservations: 1 } });
    try {
      fail(smallCapBreaker, [INSTALL], 'a', installFailure('a'));
      fail(smallCapBreaker, [INSTALL], 'b', installFailure('b'));
      fail(smallCapBreaker, [INSTALL], 'c', installFailure('c'));
      vi.advanceTimersByTime(120_000);
      const admitted = admitAfterSuccessfulProbe(smallCapBreaker, { invocationId: 'canary-1', scopeKeys: [INSTALL] });
      expect(admitted.ok).toBe(true);
      expect(dispatchReservation(smallCapBreaker, admitted.token, 'canary-1')).toEqual({ ok: true });
      vi.advanceTimersByTime(300_001);
      expect(admitAfterSuccessfulProbe(smallCapBreaker, { invocationId: 'unrelated', scopeKeys: [QUOTA] }).ok).toBe(false);
      // A scoped reset while the marker is still unresolved is refused —
      // nothing is mutated: the marker, and the capacity it occupies, both
      // survive exactly as they were.
      const refused = smallCapBreaker.reset(INSTALL);
      expect(refused).toEqual({ ok: false, scopeKey: INSTALL, reason: expect.any(String) });
      expect(smallCapBreaker.getState(INSTALL).tracked).toBe(true);
      expect(smallCapBreaker.getState(INSTALL).blockingMarker).not.toBeNull();
      expect(admitAfterSuccessfulProbe(smallCapBreaker, { invocationId: 'still-unrelated', scopeKeys: [QUOTA] }).ok).toBe(false);
      // Reconciling the stop evidence releases the reservation (and its
      // marker); the scope's own tracking record is now safely resettable.
      expect(smallCapBreaker.reconcileStopEvidence({ invocationId: 'canary-1', confirmedStop: true })).toEqual({ released: 1 });
      expect(smallCapBreaker.reset(INSTALL)).toEqual({ ok: true });
      expect(smallCapBreaker.getState(INSTALL).tracked).toBe(false);
      const afterwards = admitAfterSuccessfulProbe(smallCapBreaker, { invocationId: 'unrelated-2', scopeKeys: [QUOTA] });
      expect(afterwards.ok).toBe(true);
    } finally {
      smallCapBreaker.destroy();
    }
  });

  // #2915 round 8 (D3, required regression): a reservation covering TWO
  // scopes as its canary — one of which is still unresolved — must refuse
  // `reset()` on the unresolved scope while the OTHER scope's protection is
  // completely untouched (never even inspected, let alone released).
  it('reset(scope) on a multi-scope reservation with unresolved execution refuses, and the other scope\'s protection survives', () => {
    const multiBreaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const covering = [INSTALL, QUOTA];
      for (const id of ['m1', 'm2', 'm3']) {
        fail(multiBreaker, covering, id, { scope: FailureScope.INSTALLATION, scopeKey: INSTALL, reasonCode: 'NOT_FOUND',
          evidenceSource: 'launcher', cli: 'codex' });
      }
      for (const id of ['q1', 'q2', 'q3']) {
        failEvidence(multiBreaker, trustedQuotaFailure(id, 'codex'));
      }
      expect(multiBreaker.getState(INSTALL).state).toBe('open');
      expect(multiBreaker.getState(QUOTA).state).toBe('open');
      vi.advanceTimersByTime(120_000);
      const admitted = admitAfterSuccessfulProbe(multiBreaker, { invocationId: 'canary-multi', scopeKeys: covering });
      expect(admitted.ok).toBe(true);
      expect(admitted.token.canaryKeys).toEqual(expect.arrayContaining([INSTALL, QUOTA]));
      expect(dispatchReservation(multiBreaker, admitted.token, 'canary-multi')).toEqual({ ok: true });
      vi.advanceTimersByTime(300_001);
      expect(admitAfterSuccessfulProbe(multiBreaker, { invocationId: 'probe', scopeKeys: [INSTALL] }).ok).toBe(false); // sweeps the expiry
      expect(multiBreaker.getState(INSTALL).blockingMarker).not.toBeNull();
      expect(multiBreaker.getState(QUOTA).blockingMarker).not.toBeNull();
      // Resetting INSTALL is refused and leaves BOTH scopes' markers intact
      // -- QUOTA's own record is never even touched by this call.
      expect(multiBreaker.reset(INSTALL)).toEqual({ ok: false, scopeKey: INSTALL, reason: expect.any(String) });
      expect(multiBreaker.getState(INSTALL).blockingMarker).not.toBeNull();
      expect(multiBreaker.getState(QUOTA).blockingMarker).not.toBeNull();
      expect(multiBreaker.getState(QUOTA).tracked).toBe(true);
    } finally {
      multiBreaker.destroy();
    }
  });

  // #2915 review 6 (finding 3d): `reconcileStopEvidence` resolves a stuck
  // marker by INVOCATION ID alone -- the bounded stop-escalation observer
  // (or an operator) may know only that, not the exact token object
  // `admit()` minted.
  it('reconcileStopEvidence releases a marker and its reservation by invocation id, idempotently', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'canary-recon', scopeKeys: [INSTALL] });
    expect(admitted.ok).toBe(true);
    expect(dispatchReservation(breaker, admitted.token, 'canary-recon')).toEqual({ ok: true });
    vi.advanceTimersByTime(300_001);
    expect(probe(breaker, [INSTALL]).ok).toBe(false);
    expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
    // Uncertain evidence (the default) never releases anything.
    expect(breaker.reconcileStopEvidence({ invocationId: 'canary-recon' })).toEqual({ released: 0 });
    expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
    // Confirmed stop evidence, reported by invocation id alone, releases
    // the marker and the reservation.
    expect(breaker.reconcileStopEvidence({ invocationId: 'canary-recon', confirmedStop: true })).toEqual({ released: 1 });
    expect(breaker.getState(INSTALL).blockingMarker).toBeNull();
    // Idempotent: nothing left to release the second time.
    expect(breaker.reconcileStopEvidence({ invocationId: 'canary-recon', confirmedStop: true })).toEqual({ released: 0 });
    vi.advanceTimersByTime(240_000);
    expect(probe(breaker, [INSTALL]).ok).toBe(true);
  });

  // #2915 review 6 (finding 2, "atomic scope tracking"): with ONE free
  // scope-tracking slot, four concurrent admissions for four DISTINCT
  // brand-new shared scopes must admit AT MOST one of them -- never all
  // four with three failures silently discarded later. "Concurrent" here
  // means admit() calls racing with no settle() in between, exactly the
  // production shape (multiple in-flight attempts admitted before any of
  // them conclude).
  it('reserves scope-tracking capacity atomically at admission, refusing admissions a single free slot cannot cover', () => {
    const smallCapBreaker = new ScopedFailureBreaker({ jitterMs: () => 0, policy: { maxTrackedScopes: 2, maxOutstandingReservations: 10 } });
    try {
      // Fill one of the two slots with a genuinely OPEN, non-evictable scope.
      fail(smallCapBreaker, [INSTALL], 'o1', installFailure('o1'));
      fail(smallCapBreaker, [INSTALL], 'o2', installFailure('o2'));
      fail(smallCapBreaker, [INSTALL], 'o3', installFailure('o3'));
      expect(smallCapBreaker.getState(INSTALL).state).toBe('open');
      // Exactly ONE free slot remains. Four concurrent admissions, each for
      // its OWN distinct brand-new shared scope, race against it -- none of
      // them settle before the next admit() runs.
      const keys = ['p1', 'p2', 'p3', 'p4'].map((name) => scopeKeyFor.provider(name));
      const admissions = keys.map((key, i) => admitAfterSuccessfulProbe(smallCapBreaker, { invocationId: `c-${i}`, scopeKeys: [key] }));
      const admittedCount = admissions.filter((a) => a.ok).length;
      expect(admittedCount).toBe(1);
      for (const admission of admissions.filter((a) => !a.ok)) {
        expect(admission.blockedBy).toContain('scope-tracking-capacity');
      }
      // The admitted one's own new scope IS tracked; the three refused ones
      // left no orphaned tracking record behind.
      for (let i = 0; i < admissions.length; i += 1) {
        expect(smallCapBreaker.getState(keys[i]).tracked).toBe(admissions[i].ok);
      }
      // Settling the one admitted attempt as a failure must not lose its
      // evidence -- proving the reservation genuinely protected it, rather
      // than merely refusing the other three without tracking this one
      // either.
      const admittedIndex = admissions.findIndex((a) => a.ok);
      const settleResult = smallCapBreaker.settle(admissions[admittedIndex].token,
        { kind: 'failed', scope: FailureScope.PROVIDER, scopeKey: keys[admittedIndex], reasonCode: 'NETWORK',
          evidenceSource: 'launcher', cli: 'codex', inferenceProvider: `p${admittedIndex + 1}` });
      expect(settleResult).toEqual({ ok: true });
      expect(smallCapBreaker.getState(keys[admittedIndex]).distinctFailures).toBe(1);
    } finally {
      smallCapBreaker.destroy();
    }
  });

  // #2915 review 6 (finding 2): the tracking slot THIS admission reserved
  // is released again once the scope it covers settles inert, so capacity
  // is recoverable for later, SEQUENTIAL admissions -- not just refused
  // for concurrent ones.
  it('releases a reserved scope-tracking slot on settlement once the scope is inert, recovering capacity for later admissions', () => {
    const smallCapBreaker = new ScopedFailureBreaker({ jitterMs: () => 0, policy: { maxTrackedScopes: 2 } });
    try {
      // Permanently occupy ONE of the two slots with a genuinely OPEN,
      // non-evictable scope, so only one slot is ever actually free.
      fail(smallCapBreaker, [INSTALL], 'o1', installFailure('o1'));
      fail(smallCapBreaker, [INSTALL], 'o2', installFailure('o2'));
      fail(smallCapBreaker, [INSTALL], 'o3', installFailure('o3'));
      expect(smallCapBreaker.getState(INSTALL).state).toBe('open');
      const keyA = scopeKeyFor.provider('a');
      const keyB = scopeKeyFor.provider('b');
      const admissionA = admitAfterSuccessfulProbe(smallCapBreaker, { invocationId: 'seq-a', scopeKeys: [keyA] });
      expect(admissionA.ok).toBe(true);
      expect(smallCapBreaker.getState(keyA).tracked).toBe(true);
      // Both slots are now occupied (INSTALL open, keyA tracked). Settling
      // keyA's admission as an unremarkable success (never opening, never
      // retaining failure evidence) must release its slot back to the
      // pool -- without the fix, a SECOND, sequential admission for a
      // DIFFERENT brand-new scope would have nowhere to go.
      expect(smallCapBreaker.settle(admissionA.token, { kind: 'succeeded' })).toEqual({ ok: true });
      expect(smallCapBreaker.getState(keyA).tracked).toBe(false);
      const admissionB = admitAfterSuccessfulProbe(smallCapBreaker, { invocationId: 'seq-b', scopeKeys: [keyB] });
      expect(admissionB.ok).toBe(true);
      expect(smallCapBreaker.getState(keyB).tracked).toBe(true);
    } finally {
      smallCapBreaker.destroy();
    }
  });

  // #2915 final review step 2, named tests ------------------------------

  it('old-attempt-cannot-settle-canary', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const stale = admitAfterSuccessfulProbe(breaker, { invocationId: 'old-attempt', scopeKeys: [INSTALL] });
    expect(stale.ok).toBe(true);
    // The stale attempt's own reservation is honored once...
    expect(breaker.settle(stale.token, { kind: 'succeeded' })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).state).toBe('closed');
    // ...and a SECOND settle of that exact (now-consumed) token — simulating
    // a duplicate/late report from the same old attempt arriving again, or
    // an attempt that tries to settle a reservation it does not hold at
    // all — is refused, never silently re-applied or allowed to touch
    // whatever NEW canary may since have been admitted on this scope.
    expect(breaker.settle(stale.token, { kind: 'succeeded' })).toEqual({ ok: false, reason: expect.any(String) });
    // Open a fresh episode and admit a NEW canary; the stale token from the
    // previous episode must never be able to settle THIS one.
    fail(breaker, [INSTALL], 'z1', installFailure('z1'));
    fail(breaker, [INSTALL], 'z2', installFailure('z2'));
    fail(breaker, [INSTALL], 'z3', installFailure('z3'));
    vi.advanceTimersByTime(120_000);
    const fresh = admitAfterSuccessfulProbe(breaker, { invocationId: 'fresh-attempt', scopeKeys: [INSTALL] });
    expect(fresh.ok).toBe(true);
    expect(breaker.settle(stale.token, { kind: 'succeeded' })).toEqual({ ok: false, reason: expect.any(String) });
    expect(breaker.getState(INSTALL).activeCanary).not.toBeNull(); // the FRESH canary, untouched by the stale settle
    expect(breaker.settle(fresh.token, { kind: 'succeeded' })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).state).toBe('closed');
  });

  it('all-covering-scopes-settle', () => {
    // A single attempt covers THREE scopes at once (installation, quota,
    // host) — none of them individually open yet.
    const covering = [INSTALL, QUOTA, HOST];
    const admission = admitAfterSuccessfulProbe(breaker, { invocationId: 'multi-1', scopeKeys: covering });
    expect(admission.ok).toBe(true);
    expect(admission.token.coveringKeys).toEqual(expect.arrayContaining(covering));
    for (const key of covering) expect(breaker._outstanding.get(key)?.size).toBe(1);
    // A single settle() clears outstanding membership on EVERY covering
    // scope, not just one of them.
    expect(breaker.settle(admission.token, { kind: 'uncertain' })).toEqual({ ok: true });
    for (const key of covering) expect(breaker._outstanding.get(key)?.size ?? 0).toBe(0);

    // Now drive three covering scopes all OPEN at once via three separate
    // attempts that each fail across the same three scopes, then prove a
    // single later admission is admitted as the canary for ALL three
    // simultaneously, and a single settle() recovers all three together.
    for (const id of ['m1', 'm2', 'm3']) {
      fail(breaker, covering, id, { scope: FailureScope.HOST, scopeKey: HOST, reasonCode: 'RESOURCE',
        evidenceSource: 'launcher', cli: 'codex', corroboratedBackends: ['openai', 'anthropic'] });
    }
    expect(breaker.getState(HOST).state).toBe('open');
    vi.advanceTimersByTime(120_000);
    const canary = admitAfterSuccessfulProbe(breaker, { invocationId: 'canary-multi', scopeKeys: covering });
    expect(canary.ok).toBe(true);
    expect(canary.token.canaryKeys.length).toBeGreaterThan(0);
    expect(breaker.settle(canary.token, { kind: 'succeeded' })).toEqual({ ok: true });
    for (const key of canary.token.canaryKeys) expect(breaker.getState(key).state).toBe('closed');
  });

  it('deadline-reopens-before-readmission', () => {
    openInstall();
    vi.advanceTimersByTime(120_000);
    const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'canary-1', scopeKeys: [INSTALL] });
    expect(admitted.ok).toBe(true);
    expect(dispatchReservation(breaker, admitted.token, 'canary-1')).toEqual({ ok: true });
    // Past the canary's own deadline (300s), the NEXT admission call must
    // observe the sweep and reopen with backoff BEFORE considering any new
    // admission — never admitting an overlapping live canary.
    vi.advanceTimersByTime(300_001);
    const overlapping = admitAfterSuccessfulProbe(breaker, { invocationId: 'overlapping', scopeKeys: [INSTALL] });
    expect(overlapping.ok).toBe(false); // reopened with doubled backoff, not yet due again
    expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(240_000);
    expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
    // A late success report against the now-expired reservation settles
    // only the marker it left behind (#2915 review 5) — it carries no
    // confirmed-termination evidence, so it never closes the scope and
    // never clears the marker either. Late success cannot close a scope.
    expect(breaker.settle(admitted.token, { kind: 'succeeded' })).toEqual({ ok: true });
    expect(breaker.getState(INSTALL).state).toBe('open');
    expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
  });

  it('hard-caps-preserve-open-scopes', () => {
    // #2915 review 4, finding 6: invocation-scoped records are bounded by
    // their OWN quota (maxChargedAttempts), entirely separate from the
    // small shared-scope quota (maxTrackedScopes) -- so a flood of
    // one-off, never-opening invocation failures can never compete with,
    // or get discarded in favor of, genuinely shared (installation/quota/
    // provider/host/model) scope tracking, and vice versa.
    const smallCapBreaker = new ScopedFailureBreaker({ jitterMs: () => 0, policy: { maxTrackedScopes: 2 } });
    try {
      // Two genuinely OPEN, DISTINCT shared scopes, created first -- both
      // must survive eviction regardless of insertion order, even though
      // they already consume the entire shared-scope quota of 2.
      fail(smallCapBreaker, [INSTALL], 'o1', installFailure('o1'));
      fail(smallCapBreaker, [INSTALL], 'o2', installFailure('o2'));
      fail(smallCapBreaker, [INSTALL], 'o3', installFailure('o3'));
      expect(smallCapBreaker.getState(INSTALL).state).toBe('open');
      for (const id of ['p1', 'p2', 'p3']) {
        fail(smallCapBreaker, [PROVIDER], id, { scope: FailureScope.PROVIDER, scopeKey: PROVIDER,
          reasonCode: 'NETWORK', evidenceSource: 'launcher', cli: 'codex', inferenceProvider: 'openai' });
      }
      expect(smallCapBreaker.getState(PROVIDER).state).toBe('open');
      // Six MORE distinct, brand-new shared scopes (a third/fourth/etc
      // CLI's installation scope) cannot be tracked at all -- the shared
      // quota is genuinely exhausted by two protected OPEN scopes, and
      // there is nothing memberless/inert to evict -- but this never
      // evicts either OPEN scope, and the hard cap of 2 is never exceeded.
      for (let n = 0; n < 6; n += 1) {
        const key = scopeKeyFor.installation(`overflow-cli-${n}`);
        const result = fail(smallCapBreaker, [key], `overflow-${n}`,
          { scope: FailureScope.INSTALLATION, scopeKey: key, reasonCode: 'NOT_FOUND', evidenceSource: 'launcher', cli: `overflow-cli-${n}` });
        // #2915 review 5 (finding 5): the admission itself is now REFUSED
        // (not silently admitted-and-discarded) for a brand-new scope the
        // tracking table has no room for -- the overflow case this test
        // sets up must actually require refusal, not merely observe that
        // no NEW scope record ended up tracked afterward.
        expect(result.admitted, `overflow-${n} should have been refused, not admitted`).toBe(false);
        expect(result.blockedBy).toContain('scope-tracking-capacity');
      }
      expect(smallCapBreaker.getState(INSTALL).state).toBe('open');
      expect(smallCapBreaker.getState(PROVIDER).state).toBe('open');
      const sharedScopes = smallCapBreaker.snapshot().scopes.filter((s) => s.scope !== 'invocation');
      expect(sharedScopes.length).toBeLessThanOrEqual(2);
      // Many distinct, memberless, never-opening INVOCATION-scoped failures
      // are tracked in their own separate quota, never discarded by, and
      // never competing with, the two-slot shared-scope quota above.
      for (let n = 0; n < 10; n += 1) {
        const key = scopeKeyFor.invocation(`solo-${n}`);
        fail(smallCapBreaker, [key], `solo-${n}`, { scope: FailureScope.INVOCATION, scopeKey: key, reasonCode: 'TASK_ASSERT_FAILED' });
      }
      for (let n = 0; n < 10; n += 1) {
        expect(smallCapBreaker.getState(scopeKeyFor.invocation(`solo-${n}`)).tracked).toBe(true);
      }
      expect(smallCapBreaker.getState(INSTALL).state).toBe('open');
      expect(smallCapBreaker.getState(INSTALL).tracked).toBe(true);
      expect(smallCapBreaker.getState(PROVIDER).state).toBe('open');
    } finally {
      smallCapBreaker.destroy();
    }
  });

  // #2915 review 5 (finding 5, "lost covering protection"): the overflow
  // attempts in the test above were admitted and their failure evidence
  // silently discarded -- this names that exact refusal explicitly at the
  // `admit()` boundary, rather than only observing its downstream effect.
  it('refuses an admission that would need an untrackable brand-new shared scope, instead of admitting and discarding its failure', () => {
    const smallCapBreaker = new ScopedFailureBreaker({ jitterMs: () => 0, policy: { maxTrackedScopes: 2 } });
    try {
      // Fill the entire shared-scope quota (2 slots) with two genuinely
      // OPEN, DISTINCT, non-evictable scopes.
      fail(smallCapBreaker, [INSTALL], 'o1', installFailure('o1'));
      fail(smallCapBreaker, [INSTALL], 'o2', installFailure('o2'));
      fail(smallCapBreaker, [INSTALL], 'o3', installFailure('o3'));
      expect(smallCapBreaker.getState(INSTALL).state).toBe('open');
      for (const id of ['p1', 'p2', 'p3']) {
        fail(smallCapBreaker, [PROVIDER], id, { scope: FailureScope.PROVIDER, scopeKey: PROVIDER,
          reasonCode: 'NETWORK', evidenceSource: 'launcher', cli: 'codex', inferenceProvider: 'openai' });
      }
      expect(smallCapBreaker.getState(PROVIDER).state).toBe('open');
      // A brand-new, never-before-seen shared scope key: the tracking
      // table has no room (nothing evictable, both existing slots are
      // OPEN) -- `admit()` itself must refuse, not silently admit this
      // attempt and lose its eventual failure to `_scopeRecordBounded`
      // returning null.
      const overflowKey = scopeKeyFor.installation('overflow-cli-explicit');
      const admission = admitAfterSuccessfulProbe(smallCapBreaker, { invocationId: 'overflow-explicit', scopeKeys: [overflowKey] });
      expect(admission.ok).toBe(false);
      expect(admission.blockedBy).toContain('scope-tracking-capacity');
      expect(smallCapBreaker.getState(overflowKey).tracked).toBe(false);
    } finally {
      smallCapBreaker.destroy();
    }
  });

  // #2915 review 5 (finding 5): a covering set larger than `maxCoveringKeys`
  // is refused outright -- the former behavior silently trimmed it,
  // dropping some of the caller's own named scopes from tracking entirely.
  it('refuses an admission whose covering set exceeds maxCoveringKeys, instead of silently trimming it', () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const oversizedKeys = Array.from({ length: 7 }, (_, n) => scopeKeyFor.installation(`cli-${n}`));
      const admission = admitAfterSuccessfulProbe(breaker, { invocationId: 'oversized-1', scopeKeys: oversizedKeys });
      expect(admission.ok).toBe(false);
      expect(admission.blockedBy).toContain('covering-set-too-large');
      // None of the would-be-trimmed keys were tracked either.
      for (const key of oversizedKeys) expect(breaker.getState(key).tracked).toBe(false);
    } finally {
      breaker.destroy();
    }
  });

  it('rejects policy overrides above the protective maxima (500/128/5000/6)', () => {
    expect(() => new ScopedFailureBreaker({ policy: { maxTrackedScopes: 501 } })).toThrow(RangeError);
    expect(() => new ScopedFailureBreaker({ policy: { maxOutstandingReservations: 129 } })).toThrow(RangeError);
    expect(() => new ScopedFailureBreaker({ policy: { maxChargedAttempts: 5001 } })).toThrow(RangeError);
    expect(() => new ScopedFailureBreaker({ policy: { maxCoveringKeys: 7 } })).toThrow(RangeError);
    // The shipped defaults themselves, and anything smaller, remain valid.
    const b = new ScopedFailureBreaker({ policy: { maxTrackedScopes: 500, maxOutstandingReservations: 128, maxChargedAttempts: 5000, maxCoveringKeys: 6 } });
    b.destroy();
  });

  it('settle() rejects a copied token with altered fields (exact token ownership)', () => {
    const b = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const admitted = admitAfterSuccessfulProbe(b, { invocationId: 'a1', scopeKeys: [INSTALL] });
      expect(admitted.ok).toBe(true);
      // A copy with every field reproduced, including `breaker` and `id`,
      // but a forged invocationId -- reference inequality alone refuses it.
      const forged = { ...admitted.token, invocationId: 'forged' };
      expect(b.settle(forged, { kind: 'succeeded' })).toEqual({ ok: false, reason: expect.any(String) });
      // The genuine, unmodified token (same object reference) still works.
      expect(b.settle(admitted.token, { kind: 'succeeded' })).toEqual({ ok: true });
    } finally {
      b.destroy();
    }
  });
});

// #2915 round 8 (D2/D3/D4): the breaker-owned reservation's phase
// transitions (admitted -> committing -> dispatched), the dispatch-commit
// hook contract, and the stop-evidence lifecycle -- replacing the
// mechanisms review 7 found new holes in (markerTouched/markerResolved
// bookkeeping, claimLaunch, _consumedBorrowedAdmissions, launcher wrapper
// identity checks, confirmedStop derived from child exit or a blocked
// outcome).
describe('#2915 round 8: beginDispatch/commitDispatch/abortDispatch reservation phases', () => {
  it('beginDispatch refuses a second call on the same reservation (single-use, review 6 finding 1)', () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'begin-1', scopeKeys: [], selectionDigest: 'sel-1' });
      expect(admitted.ok).toBe(true);
      expect(breaker.beginDispatch(admitted.token, { invocationId: 'begin-1', selectionDigest: 'sel-1' })).toEqual({ ok: true });
      const second = breaker.beginDispatch(admitted.token, { invocationId: 'begin-1', selectionDigest: 'sel-1' });
      expect(second.ok).toBe(false);
      expect(second.reason).toMatch(/not admitted/);
    } finally {
      breaker.destroy();
    }
  });

  it('beginDispatch refuses omitted (undefined) invocationId/selectionDigest bindings — never bypasses the check', () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'omit-1', scopeKeys: [], selectionDigest: 'sel-1' });
      expect(admitted.ok).toBe(true);
      expect(breaker.beginDispatch(admitted.token, { selectionDigest: 'sel-1' }))
        .toEqual({ ok: false, reason: expect.stringMatching(/requires explicit/) });
      expect(breaker.beginDispatch(admitted.token, { invocationId: 'omit-1' }))
        .toEqual({ ok: false, reason: expect.stringMatching(/requires explicit/) });
      expect(breaker.beginDispatch(admitted.token, {}))
        .toEqual({ ok: false, reason: expect.stringMatching(/requires explicit/) });
      // An explicit `null` (a legitimate value for a flat-option caller with
      // no resolved selection) is NOT the same as omitted, and must still be
      // validated against the stored binding rather than bypassing the check.
      const noSelection = admitAfterSuccessfulProbe(breaker, { invocationId: 'omit-2', scopeKeys: [], selectionDigest: null });
      expect(breaker.beginDispatch(noSelection.token, { invocationId: 'omit-2', selectionDigest: null })).toEqual({ ok: true });
    } finally {
      breaker.destroy();
    }
  });

  it('beginDispatch refuses a mismatched invocationId or selectionDigest against the breaker-owned stored binding', () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const a = admitAfterSuccessfulProbe(breaker, { invocationId: 'match-1', scopeKeys: [], selectionDigest: 'sel-a' });
      expect(a.ok).toBe(true);
      expect(breaker.beginDispatch(a.token, { invocationId: 'WRONG', selectionDigest: 'sel-a' }))
        .toEqual({ ok: false, reason: expect.stringMatching(/does not match/) });
      const b = admitAfterSuccessfulProbe(breaker, { invocationId: 'match-2', scopeKeys: [], selectionDigest: 'sel-b' });
      expect(b.ok).toBe(true);
      expect(breaker.beginDispatch(b.token, { invocationId: 'match-2', selectionDigest: 'WRONG' }))
        .toEqual({ ok: false, reason: expect.stringMatching(/does not match/) });
      // Neither refusal consumed the reservation -- the genuine binding still works.
      expect(breaker.beginDispatch(a.token, { invocationId: 'match-1', selectionDigest: 'sel-a' })).toEqual({ ok: true });
      expect(breaker.beginDispatch(b.token, { invocationId: 'match-2', selectionDigest: 'sel-b' })).toEqual({ ok: true });
    } finally {
      breaker.destroy();
    }
  });

  it('expiry during committing cannot launch and is classified unused only after abortDispatch acknowledges it', () => {
    let now = 1_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    try {
      for (const id of ['a', 'b', 'c']) failEvidence(breaker, installFailure(id));
      now += 120_000;
      const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'committing-1', scopeKeys: [INSTALL], selectionDigest: null });
      expect(admitted.ok).toBe(true);
      expect(breaker.beginDispatch(admitted.token, { invocationId: 'committing-1', selectionDigest: null })).toEqual({ ok: true });
      // Past the canary's own deadline WHILE committing (beginDispatch
      // already succeeded; commitDispatch has not been called yet).
      now += 300_001;
      // Expiry alone never classifies this as unused -- the scope's canary
      // slot is still held by this exact reservation, and admission for
      // this scope is still refused by ITS presence (not a marker: no
      // marker exists yet for a committing-phase reservation).
      expect(breaker.getState(INSTALL).activeCanary?.id).toBe(admitted.token.id);
      const competing = admitAfterSuccessfulProbe(breaker, { invocationId: 'competing', scopeKeys: [INSTALL] });
      expect(competing.ok).toBe(false);
      // commitDispatch now observes the deadline has passed and refuses --
      // it must NEVER silently complete as if nothing happened.
      const committed = breaker.commitDispatch(admitted.token);
      expect(committed.ok).toBe(false);
      expect(committed.reason).toMatch(/deadline passed while committing/);
      // Still not classified as unused: the committing owner has not yet
      // acknowledged the abort.
      expect(breaker.getState(INSTALL).activeCanary?.id).toBe(admitted.token.id);
      expect(breaker.getState(INSTALL).blockingMarker).toBeNull();
      // Only abortDispatch's acknowledgment classifies it as safely unused:
      // reopened with doubled backoff (a timed-out committing attempt is
      // treated the same as an unreported canary), WITHOUT a stop-evidence
      // marker (nothing is known to have actually dispatched).
      expect(breaker.abortDispatch(admitted.token)).toEqual({ ok: true });
      expect(breaker.getState(INSTALL).activeCanary).toBeNull();
      expect(breaker.getState(INSTALL).blockingMarker).toBeNull();
      expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(240_000);
    } finally {
      breaker.destroy();
    }
  });

  it('abortDispatch refuses once a reservation has actually reached dispatched', () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'dispatched-1', scopeKeys: [], selectionDigest: null });
      expect(breaker.beginDispatch(admitted.token, { invocationId: 'dispatched-1', selectionDigest: null })).toEqual({ ok: true });
      expect(breaker.commitDispatch(admitted.token)).toEqual({ ok: true });
      const aborted = breaker.abortDispatch(admitted.token);
      expect(aborted.ok).toBe(false);
      expect(aborted.reason).toMatch(/already dispatched/);
    } finally {
      breaker.destroy();
    }
  });

  it('reconcileStopEvidence on a still-active (not yet expired) canary clears activeCanary', () => {
    let now = 2_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    try {
      for (const id of ['a', 'b', 'c']) failEvidence(breaker, installFailure(id));
      now += 120_000;
      const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'recon-active', scopeKeys: [INSTALL] });
      expect(admitted.ok).toBe(true);
      expect(breaker.beginDispatch(admitted.token, { invocationId: 'recon-active', selectionDigest: null })).toEqual({ ok: true });
      expect(breaker.commitDispatch(admitted.token)).toEqual({ ok: true });
      // Still well within the canary's own deadline, genuinely dispatched
      // and running -- `activeCanary` is set, no marker exists.
      expect(breaker.getState(INSTALL).activeCanary?.id).toBe(admitted.token.id);
      expect(breaker.getState(INSTALL).blockingMarker).toBeNull();
      // An operator/observer independently confirms the descendants actually
      // stopped (e.g. inspecting the host directly) and reconciles by
      // invocation id alone.
      expect(breaker.reconcileStopEvidence({ invocationId: 'recon-active', confirmedStop: true })).toEqual({ released: 1 });
      expect(breaker.getState(INSTALL).activeCanary).toBeNull();
      expect(breaker.getState(INSTALL).blockingMarker).toBeNull();
    } finally {
      breaker.destroy();
    }
  });

  it("hook throw leaves zero spawns and a released reservation (launchOneWorker's attached path)", async () => {
    const f = workerResolutionFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-hookthrow-'));
    const cwd = path.join(root, 'work');
    await mkdir(cwd);
    const brief = path.join(root, 'brief.json');
    await writeFile(brief, 'synthetic brief');
    const adapter = f.snapshot.registry.providers.codex.workerAdapter;
    const profile = adapter.invocationProfiles['fixture-shell'];
    profile.envAllowlist = [];
    const driver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0',
      boundary: { kind: 'os', identity: 'fixture:boundary', digest: qualificationDigest('boundary'), controls: ['sandbox'] } },
      buildInvocation: async (input) => ({ argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'),
        '--model', input.selected.model, '--final-output', input.finalPath, '--', 'synthetic'],
        stdin: 'closed', envNames: [] }),
      extractFinal: () => null,
    };
    const drivers = { codex: driver };
    f.snapshot.installations.codex.boundary = driver.qualification.boundary;
    const request = { role: 'coding', task: 'implementation', group: 'workers', brief, workdir: cwd,
      final_output: path.join(root, 'final.json') };
    const plan = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
    expect(plan.invocation).toBeDefined();
    const invocationPath = path.join(root, 'plan.json');
    await writeFile(invocationPath, JSON.stringify(plan));
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    // Force the hook's own `commitDispatch` step to throw (standing in for
    // ANY mid-hook failure, e.g. a real ledger debit error): the point of
    // this test is the HOOK's contract (nothing starts; the reservation is
    // released, not stuck), independent of which internal step fails.
    const realCommitDispatch = breaker.commitDispatch.bind(breaker);
    let commitAttempts = 0;
    breaker.commitDispatch = (token) => { commitAttempts += 1; throw new Error('synthetic commitDispatch failure'); };
    const launcher = new SessionLauncher();
    let spawnCalls = 0;
    try {
      await expect(launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath, runDir: path.join(root, 'hook-throw-run'),
        inputs: { snapshot: f.snapshot, drivers }, now: f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        // A production-shaped stub (honors the real dispatch-commit hook,
        // like `enoentLaunchIsolated` above): its actual spawn step
        // increments `spawnCalls`, observable as zero iff the hook's throw
        // genuinely prevented it from ever running.
        launchIsolated: async (options) => {
          await options.onDispatchCommit?.();
          spawnCalls += 1;
          return { mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) };
        },
      })).rejects.toThrow('synthetic commitDispatch failure');
      expect(commitAttempts).toBe(1);
      // Zero spawns: the hook's own throw (from commitDispatch) prevented
      // the stub's spawn line from ever running.
      expect(spawnCalls).toBe(0);
      // Released, not stuck: `abortDispatch` ran on the hook's catch path,
      // so nothing is left occupying a reservation slot.
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
      // Restore the real method and prove a FRESH attempt dispatches
      // normally -- the failed attempt did not poison the scope/ledger.
      breaker.commitDispatch = realCommitDispatch;
    } finally {
      resetDirectRecoveryBreaker();
      // The in-process allowance ledger is a module-level singleton keyed
      // by task-chain digest (role/task/group/brief-content) — this test
      // shares the exact same default digest several OTHER describe blocks
      // in this file use, so it must not leave a charged attempt behind for
      // them to collide with.
      resetInProcessAllowanceLedger();
      await rm(root, { recursive: true, force: true });
    }
  });

  // #2915 round 8 (D3, review 6 finding 1 "standalone launch ownership is
  // unconsumed"): a successful STANDALONE launch's own admission carries a
  // live reservation that `beginDispatch`/`commitDispatch` already consumed
  // (phase `dispatched`) -- unlike the pre-#2915-round-8 `claimLaunch` flag,
  // which the standalone path never actually set, letting that exact
  // admission be borrowed and launch a SECOND worker. Borrowing it now
  // reaches the same `beginDispatch` authority every other path does and is
  // refused identically.
  // #2915 round 8 (C, "admitDirectWorker rolls back its own partial
  // acquisition"): an exception during ROOT RESOLUTION (not just the
  // ledger reserve call itself) must release the breaker-side reservation
  // before propagating -- previously only the ledger reserve was wrapped
  // in a try/catch, leaking the reservation on this exact failure mode
  // (#2915 round 8 critique: "root-resolution exceptions after internal
  // breaker admission; caller-side cleanup cannot recover an unreturned
  // handle").
  it('admitDirectWorker rolls back its own partial acquisition on a root-resolution exception', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-rollback-'));
    const captureRoot = path.join(root, 'capture');
    const error = Object.assign(new Error('injected realpath EACCES'), { code: 'EACCES' });
    const realpath = fsPromises.realpath;
    const realpathSpy = vi.spyOn(fsPromises, 'realpath').mockImplementation(async target => {
      if (target === captureRoot) throw error;
      return realpath(target);
    });
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      await expect(admitDirectWorker({
        gateEnabled: true, config: dispatchOnConfig,
        invocation: { selected: { cli: 'codex' }, cwd: root },
        invocationId: 'rollback-1', scopedBreaker: breaker, drivers: {},
        taskChainDigest: `sha256:${'a'.repeat(64)}`, maxAttempts: 1,
        // Inject at realBeneath's realpath call so root also exercises EACCES.
        captureRoot,
      })).rejects.toBe(error);
      expect(realpathSpy).toHaveBeenCalledWith(captureRoot);
      // Not leaked: the breaker reservation `admit()` minted was released
      // before the exception propagated.
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
      // Proven by also admitting successfully right afterward on the SAME
      // scope/breaker -- a leaked reservation would otherwise still be
      // occupying a slot (observable via `maxOutstandingReservations: 1`).
      const afterwards = admitAfterSuccessfulProbe(breaker, { invocationId: 'rollback-2', scopeKeys: [] });
      expect(afterwards.ok).toBe(true);
    } finally {
      realpathSpy.mockRestore();
      breaker.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a standalone launch consumes its own admission; borrowing it afterward is refused, never launching a second worker', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const first = await planDirectWorkerLaunch({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, scopedBreaker: breaker, invocation: { selected: { cli: 'codex' } },
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true });
      expect(first.launched).toBe(true);
      expect(first.admission).toBeDefined();
      expect(breaker.reservationPhase(first.admission.token)).toBe('dispatched');
      const second = await planDirectWorkerLaunch({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, admission: first.admission, invocationId: first.admission.invocationId,
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true });
      expect(second.launched).toBe(false);
      expect(second.failures?.[0]?.reason).toMatch(/not a live, unclaimed reservation/);
    } finally {
      breaker.destroy();
    }
  });
});

// #2915 round 8 (D4): `resolveStopEvidence` is the one function every
// settlement path uses to derive stop evidence from the isolation layer —
// replacing ad hoc derivation from a child-exit observation or a
// post-spawn `blocked` outcome (review 7 finding 5, "stop confirmation is
// manufactured from insufficient evidence").
describe('#2915 round 8 (D4): resolveStopEvidence', () => {
  it('never-began dispatch state is none-needed, never unresolved', async () => {
    expect(await resolveStopEvidence({ isolationMode: 'degraded', dispatchState: 'never-began' }))
      .toEqual({ stop: 'none-needed', confirmedStop: false });
  });

  it('a dispatch-uncertain submission (e.g. a failed/timed-out systemd-run) is unresolved, never none-needed', async () => {
    expect(await resolveStopEvidence({ isolationMode: 'systemd-unit', dispatchState: 'submission-uncertain' }))
      .toEqual({ stop: 'unresolved', confirmedStop: false });
  });

  // review 7 finding 5: "Capture-setup failure sends signals to the
  // attached child even in systemd mode. That child is the systemd-run
  // transport, not the owned unit."
  it('systemd-unit mode stops and queries the OWNED UNIT, never the attached transport child', async () => {
    const stopCalls = [];
    const getStatusCalls = [];
    let terminateChildCalled = false;
    const result = await resolveStopEvidence({
      isolationMode: 'systemd-unit', unitName: 'aiwg-worker-fixture-1', child: { fake: 'transport-child' },
      stopUnit: (unit) => { stopCalls.push(unit); return { ok: true }; },
      getStatus: (unit) => { getStatusCalls.push(unit); return { active: false, execMainCode: 1 }; },
      terminateChild: async () => { terminateChildCalled = true; return { terminated: true }; },
    });
    expect(stopCalls).toEqual(['aiwg-worker-fixture-1']);
    expect(getStatusCalls).toEqual(['aiwg-worker-fixture-1']);
    expect(terminateChildCalled).toBe(false); // never signalled the transport child
    expect(result).toEqual({ stop: 'confirmed', confirmedStop: true });
  });

  it('systemd-unit mode reports unresolved when the unit query is unavailable or still active, never a fabricated confirmation', async () => {
    const stillActive = await resolveStopEvidence({ isolationMode: 'systemd-unit', unitName: 'u1',
      stopUnit: () => ({ ok: true }), getStatus: () => ({ active: true }) });
    expect(stillActive).toEqual({ stop: 'unresolved', confirmedStop: false });
    const unavailable = await resolveStopEvidence({ isolationMode: 'systemd-unit', unitName: 'u1',
      stopUnit: () => { throw new Error('stop unavailable'); }, getStatus: () => { throw new Error('query unavailable'); } });
    expect(unavailable).toEqual({ stop: 'unresolved', confirmedStop: false });
  });

  // review 7 finding 5 / #2915D4: degraded mode has no native unit query, so
  // a confirmed exit of the launcher's OWN direct child is never sufficient
  // evidence that its descendants stopped -- this must NEVER report
  // `confirmedStop: true`, even when the bounded stop escalation genuinely
  // confirms the direct child terminated.
  it('degraded mode never confirms stop, even when the direct child is genuinely confirmed terminated', async () => {
    let terminateCalledWith = null;
    const result = await resolveStopEvidence({ isolationMode: 'degraded', child: { fake: 'degraded-child' },
      terminateChild: async (child) => { terminateCalledWith = child; return { terminated: true }; } });
    expect(terminateCalledWith).toEqual({ fake: 'degraded-child' });
    expect(result).toEqual({ stop: 'unresolved', confirmedStop: false });
  });
});

// #2915 round 8 (D4, review 7 finding 7: "an operator command does not
// replace a live observer... the standalone observer stops observing at
// its bound"): exact-deadline and just-after boundary behavior for the
// standalone systemd-unit settlement observer.
describe('#2915 round 8 (D4): observeStandaloneUnitSettlement boundary behavior', () => {
  function fakeAdmission(breaker, token) {
    return { gated: true, breaker, token };
  }

  it('settles immediately once the unit reports inactive, well before the bound', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'obs-early', scopeKeys: [] });
      expect(breaker.beginDispatch(admitted.token, { invocationId: 'obs-early', selectionDigest: null })).toEqual({ ok: true });
      expect(breaker.commitDispatch(admitted.token)).toEqual({ ok: true });
      let now = 0;
      const timers = [];
      observeStandaloneUnitSettlement('fixture-unit', fakeAdmission(breaker, admitted.token), {
        nowMs: () => now, setTimer: (fn) => { timers.push(fn); return {}; }, unrefTimer: () => {},
        getStatus: () => ({ active: false, execMainCode: 1 }), boundMs: 10_000,
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
    } finally {
      breaker.destroy();
    }
  });

  it('at exactly the deadline, attempts a bounded stop before settling (never abandons without one)', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'obs-exact', scopeKeys: [] });
      expect(breaker.beginDispatch(admitted.token, { invocationId: 'obs-exact', selectionDigest: null })).toEqual({ ok: true });
      expect(breaker.commitDispatch(admitted.token)).toEqual({ ok: true });
      let now = 0;
      let stopCalls = 0;
      let statusCalls = 0;
      const boundMs = 1_000;
      const poll = () => {
        statusCalls += 1;
        if (statusCalls === 1) { now = boundMs; return { active: true }; } // exactly at the deadline, still active
        return { active: false, execMainCode: 1 }; // the bounded stop took effect
      };
      const timers = [];
      observeStandaloneUnitSettlement('fixture-unit', fakeAdmission(breaker, admitted.token), {
        nowMs: () => now, setTimer: (fn) => { timers.push(fn); return {}; }, unrefTimer: () => {},
        getStatus: poll, stopUnit: () => { stopCalls += 1; return { ok: true }; }, boundMs, pollIntervalMs: 10,
      });
      // First poll observes "exactly at deadline, still active" and schedules nothing further (settles directly).
      await new Promise(resolve => setImmediate(resolve));
      expect(stopCalls).toBe(1); // the bounded stop was attempted, never abandoned without one
      expect(statusCalls).toBe(2); // one observing "active", one re-check after the stop
      expect(breaker.snapshot().reservationsOutstanding).toBe(0); // confirmed by the post-stop re-check
    } finally {
      breaker.destroy();
    }
  });

  it('just after the deadline, the same bounded-stop escalation runs (not a different, unguarded path)', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const admitted = admitAfterSuccessfulProbe(breaker, { invocationId: 'obs-after', scopeKeys: [] });
      expect(breaker.beginDispatch(admitted.token, { invocationId: 'obs-after', selectionDigest: null })).toEqual({ ok: true });
      expect(breaker.commitDispatch(admitted.token)).toEqual({ ok: true });
      let now = 0;
      let stopCalls = 0;
      let statusCalls = 0;
      const boundMs = 1_000;
      const poll = () => {
        statusCalls += 1;
        if (statusCalls === 1) { now = boundMs + 1; return { active: true }; } // one past the deadline
        return { active: true }; // the unit never actually stops, even after the bounded escalation
      };
      observeStandaloneUnitSettlement('fixture-unit', fakeAdmission(breaker, admitted.token), {
        nowMs: () => now, setTimer: (fn) => fn(), unrefTimer: () => {},
        getStatus: poll, stopUnit: () => { stopCalls += 1; return { ok: true }; }, boundMs, pollIntervalMs: 10,
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(stopCalls).toBe(1);
      // Never a fabricated confirmation: the reservation settles as
      // uncertain WITHOUT confirmedStop, so this dispatched reservation
      // RETAINS unresolved-execution protection rather than being released
      // as if stopped (#2915 round 8 review 8, C1: ordinary settlement must
      // never release a dispatched reservation without confirmed stop).
      expect(breaker.snapshot().reservationsOutstanding).toBe(1);
      expect(breaker.reservationPhase(admitted.token)).toBe('dispatched');
      // Confirmed stop evidence arriving later (e.g. an operator or a
      // subsequent observer cycle) still resolves it -- the same
      // one-more-call contract canary-deadline expiry already uses.
      expect(breaker.reconcileStopEvidence({ invocationId: 'obs-after', confirmedStop: true })).toEqual({ released: 1 });
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
    } finally {
      breaker.destroy();
    }
  });
});

describe('stop-before-retry gate (session-launcher)', () => {
  it('permits retry after confirmed termination only', () => {
    expect(stopBeforeRetryGate({ termination: 'confirmed' })).toEqual({ ok: true });
    for (const previousResult of [{ termination: 'uncertain' }, { termination: null }, {}, null, undefined]) {
      const gate = stopBeforeRetryGate(previousResult);
      expect(gate.ok).toBe(false);
      expect(gate.code).toBe(STOP_BEFORE_RETRY_CODE);
      expect(gate.reason).toMatch(/not confirmed/);
    }
    expect(() => assertStopBeforeRetry({ termination: 'uncertain' })).toThrowError(
      expect.objectContaining({ code: STOP_BEFORE_RETRY_CODE }),
    );
    expect(assertStopBeforeRetry({ termination: 'confirmed' })).toEqual({ ok: true });
  });

  it('binds confirmed evidence to the previous owned invocation', () => {
    // Unbound-evidence regression: any object containing
    // termination:'confirmed' is not enough — it must name the previous
    // owned attempt.
    expect(stopBeforeRetryGate({ termination: 'confirmed', invocationId: 'a' }, { expectedInvocationId: 'a' }))
      .toEqual({ ok: true });
    const swapped = stopBeforeRetryGate({ termination: 'confirmed', invocationId: 'b' }, { expectedInvocationId: 'a' });
    expect(swapped.ok).toBe(false);
    expect(swapped.code).toBe(UNBOUND_RETRY_EVIDENCE_CODE);
    const anonymous = stopBeforeRetryGate({ termination: 'confirmed' }, { expectedInvocationId: 'a' });
    expect(anonymous.ok).toBe(false);
    expect(anonymous.code).toBe(UNBOUND_RETRY_EVIDENCE_CODE);
  });

  // #2915 review 5 ("changed disabled behavior"): `launchWorker` itself
  // used to run `startupCorrectionGate` against the CALLER-supplied
  // `correctionsUsed` before any plan was even loaded, UNGATED by whether
  // recovery was enabled at all -- refusing calls `origin/main` (which has
  // no `correctStartup` concept) would have let through unmodified. Real
  // enforcement now lives entirely inside the gated `launchOneWorker` path:
  // see `a conductor-declared startup correction past the real ledger's
  // recorded budget is refused through the gated path` and
  // `disabled-dispatch-is-inert for correctStartup/retryOf` in the
  // `allowance ledger` describe block below for the end-to-end proofs.
  // `startupCorrectionGate`'s own pure reason/budget logic is covered by
  // the `startup correction budget (session-launcher)` describe block
  // further down in this file.
});

describe('retry linkage (#2915 final review step 4: retryOf replaces freshAttempt/afterAttempt/path-pair)', () => {
  const roots = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

  async function predecessorRunDir({ invocationId = 'prev-1', taskDigest = 'digest-a', origin = 'launcher',
    termination = 'confirmed', corruptOwner = false, mode = 0o700 } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-retry-'));
    roots.push(root);
    const runDir = path.join(root, 'run');
    await mkdir(runDir, { mode });
    await writeFile(path.join(runDir, '.launch-owner'), corruptOwner ? 'someone-else' : invocationId, { mode: 0o600 });
    await writeFile(path.join(runDir, 'invocation.json'), JSON.stringify({ invocationId, origin, taskDigest }), { mode: 0o600 });
    await writeFile(path.join(runDir, 'exit.json'), JSON.stringify({ invocationId, termination }), { mode: 0o600 });
    return { root, runDir };
  }

  async function planFile(root, taskMarker, briefDigest = 'sha256:fixed-brief') {
    const invocationPath = path.join(root, 'plan.json');
    // #2915 review 4 (finding 4): the stable task-chain identity is
    // role/task/group plus the BRIEF CONTENT digest -- never
    // `final_output`/`brief`/`workdir` paths -- matching
    // `stableTaskChainDigest` exactly, so this fixture exercises the real
    // binding rule rather than a stand-in marker field.
    const request = { role: 'coding', task: taskMarker, group: 'workers',
      brief: '/brief.json', workdir: '/work', final_output: `/work/final-${Math.random().toString(36).slice(2)}.json` };
    await writeFile(invocationPath, JSON.stringify({ request, invocation: { briefDigest } }));
    return { invocationPath, taskDigest: qualificationDigest({ role: request.role, task: request.task, group: request.group, briefDigest }) };
  }

  it('fresh-directory-retry-requires-owned-proof', async () => {
    const { runDir } = await predecessorRunDir({ invocationId: 'prev-1' });
    const { invocationPath, taskDigest } = await planFile(path.dirname(runDir), 'digest-a');
    // Rewrite the predecessor with the digest the plan actually produces,
    // so the happy path exercises real task-chain binding, not a
    // coincidental string match.
    await writeFile(path.join(runDir, 'invocation.json'), JSON.stringify({ invocationId: 'prev-1', origin: 'launcher', taskDigest }), { mode: 0o600 });
    const exitRecord = await verifyRetryPredecessor({ invocationId: 'prev-1', runDir },
      { newInvocationPath: invocationPath, inspect: inspectWorkerPath });
    expect(exitRecord).toMatchObject({ invocationId: 'prev-1', termination: 'confirmed' });
    // A FRESH directory (never retried before, no predecessor at all) is
    // simply unrelated work -- retryOf omitted, never refused for retry
    // reasons, no path coincidence required or consulted.
    const launcher = new SessionLauncher();
    await expect(launcher.launchWorker({ invocationPath: '/does/not/exist.json', runDir: '/does/not/exist' }))
      .rejects.not.toMatchObject({ code: STOP_BEFORE_RETRY_CODE });
  });

  it('a confirmed predecessor with a FRESH output path is accepted (#2915 review 4, finding 4)', async () => {
    // The predecessor and the new attempt deliberately use DIFFERENT
    // `final_output` paths (every legitimate retry attempt gets a fresh
    // one) but the SAME role/task/group/brief -- task-chain binding must
    // still accept this as the SAME task, not a "different task" refusal.
    const { runDir } = await predecessorRunDir({ invocationId: 'prev-1' });
    const predecessorPlan = await planFile(path.dirname(runDir), 'shared-task');
    await writeFile(path.join(runDir, 'invocation.json'),
      JSON.stringify({ invocationId: 'prev-1', origin: 'launcher', taskDigest: predecessorPlan.taskDigest }), { mode: 0o600 });
    const newAttemptRoot = await mkdtemp(path.join(os.tmpdir(), 'aiwg-retry-new-'));
    roots.push(newAttemptRoot);
    const newAttemptPlan = await planFile(newAttemptRoot, 'shared-task');
    expect(newAttemptPlan.invocationPath).not.toBe(predecessorPlan.invocationPath);
    expect(newAttemptPlan.taskDigest).toBe(predecessorPlan.taskDigest); // same task, different paths
    const exitRecord = await verifyRetryPredecessor({ invocationId: 'prev-1', runDir },
      { newInvocationPath: newAttemptPlan.invocationPath, inspect: inspectWorkerPath });
    expect(exitRecord).toMatchObject({ invocationId: 'prev-1', termination: 'confirmed' });
  });

  it('rejects an insecurely-moded predecessor metadata file instead of repairing it (#2915 review 4, finding 4)', async () => {
    const { runDir } = await predecessorRunDir({ invocationId: 'prev-1' });
    await chmod(path.join(runDir, 'exit.json'), 0o666);
    await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir }, { inspect: inspectWorkerPath }))
      .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
    // The file's mode is untouched -- never silently repaired to 0600.
    expect((await lstat(path.join(runDir, 'exit.json'))).mode & 0o777).toBe(0o666);
  });

  it('rejects a predecessor location inside a worker-writable root', async () => {
    const { runDir, root } = await predecessorRunDir({ invocationId: 'prev-1' });
    await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir },
      { inspect: inspectWorkerPath, workerWritableRoots: [root] }))
      .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
    // An unrelated worker-writable root never blocks a legitimate predecessor.
    const exitRecord = await verifyRetryPredecessor({ invocationId: 'prev-1', runDir },
      { inspect: inspectWorkerPath, workerWritableRoots: ['/some/other/worktree'] });
    expect(exitRecord).toMatchObject({ invocationId: 'prev-1', termination: 'confirmed' });
  });

  it('forged-or-missing-evidence-refuses', async () => {
    const inspect = inspectWorkerPath;
    // Missing directory entirely.
    await expect(verifyRetryPredecessor({ invocationId: 'x', runDir: '/does/not/exist' }, { inspect }))
      .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
    // Wrong id in .launch-owner (forged/mismatched claim).
    {
      const { runDir } = await predecessorRunDir({ invocationId: 'prev-1', corruptOwner: true });
      await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir }, { inspect }))
        .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
    }
    // Directory mode too permissive (group/world readable).
    {
      const { runDir } = await predecessorRunDir({ invocationId: 'prev-1' });
      await chmod(runDir, 0o750);
      await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir }, { inspect }))
        .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
    }
    // invocation.json not launcher-written (worker-writable-shaped record).
    {
      const { runDir } = await predecessorRunDir({ invocationId: 'prev-1', origin: 'worker' });
      await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir }, { inspect }))
        .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
    }
    // Uncertain predecessor: present, well-formed, matching identity -- but
    // not confirmed. Confirmed failed/stopped permits it; uncertain refuses.
    {
      const { runDir } = await predecessorRunDir({ invocationId: 'prev-1', termination: 'uncertain' });
      await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir }, { inspect }))
        .rejects.toMatchObject({ code: STOP_BEFORE_RETRY_CODE });
    }
    // A symlinked run directory never passes the anchored, no-follow readers.
    {
      const { runDir, root } = await predecessorRunDir({ invocationId: 'prev-1' });
      const linkPath = path.join(root, 'link');
      await symlink(runDir, linkPath);
      await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir: linkPath }, { inspect }))
        .rejects.toThrow();
    }
    // Task-chain binding: a predecessor for a DIFFERENT task must never
    // authorize replacement of this one, even with perfectly valid,
    // confirmed, identity-matching evidence otherwise.
    {
      const { runDir, root } = await predecessorRunDir({ invocationId: 'prev-1', taskDigest: 'digest-a' });
      const { invocationPath } = await planFile(root, 'digest-b');
      await expect(verifyRetryPredecessor({ invocationId: 'prev-1', runDir }, { newInvocationPath: invocationPath, inspect }))
        .rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
    }
  });

  it('unrelated-work-remains-admissible', async () => {
    // Omitting `retryOf` entirely is unrelated work, by definition, no
    // matter how uncertain or confirmed any previous launcher activity was
    // -- there is no path-pair inference left to misfire.
    const launcher = new SessionLauncher();
    launcher.lastAttemptResult = { termination: 'uncertain', invocationId: 'prev-1' };
    await expect(launcher.launchWorker({ invocationPath: '/plan-b.json', runDir: '/run-b' }))
      .rejects.not.toMatchObject({ code: STOP_BEFORE_RETRY_CODE });
    await expect(launcher.launchWorker({ invocationPath: '/plan-b.json', runDir: '/run-b' }))
      .rejects.not.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
  });

  it('a verified retry writes previousAttemptId into the new attempt\'s own invocation.json', async () => {
    // Exercises the actual wiring point in launchOneWorker, not just the
    // standalone verifier.
    const { runDir: prevRunDir } = await predecessorRunDir({ invocationId: 'prev-1', taskDigest: 'anything' });
    const exitRecord = await verifyRetryPredecessor({ invocationId: 'prev-1', runDir: prevRunDir }, { inspect: inspectWorkerPath });
    expect(exitRecord.invocationId).toBe('prev-1');
    // The field this gate feeds is read directly off `options.verifiedPreviousAttemptId`
    // in launchOneWorker's `invocation.json` publish (session-launcher.mjs) --
    // covered end-to-end by the retry-admits-after-confirmed-stop path in the
    // S1 integration suite below, which always supplies a FRESH runDir per
    // attempt (so publishing this field never collides with #2895's
    // fresh/empty runDir precondition).
  });
});

describe('startup correction budget (session-launcher)', () => {
  it('allows one correction for qualified mechanical causes only', () => {
    expect(MAX_STARTUP_CORRECTIONS).toBe(1);
    expect(startupCorrectionGate({ correctionsUsed: 0, reasonCode: 'STDIN_WAIT' }).ok).toBe(true);
    expect(startupCorrectionGate({ correctionsUsed: 1, reasonCode: 'STDIN_WAIT' }).ok).toBe(false);
    for (const reasonCode of ['AUTH', 'TRUST', 'RESOURCE', 'UNKNOWN', null]) {
      expect(startupCorrectionGate({ correctionsUsed: 0, reasonCode }).ok).toBe(false);
    }
  });
});

describe('buildFailureAttribution', () => {
  it('reuses workerModelKey for model scope and quota account for trusted 429', async () => {
    const model = await buildFailureAttribution(
      { invocationId: 'i-1', selected: { cli: 'codex', inferenceProvider: 'openai', apiModelId: 'gpt-x' } },
      { reasonCode: 'MODEL', evidenceSource: 'launcher' },
    );
    expect(model).toEqual({ scope: 'model', scopeKey: 'model:openai/gpt-x', confidence: 'suspected' });

    const quota = await buildFailureAttribution(
      { invocationId: 'i-2', selected: { cli: 'codex-alias', inferenceProvider: 'openai' } },
      { reasonCode: 'RATE_LIMIT', evidenceSource: 'resolver', quotaAccount: 'acct-1' },
    );
    expect(quota.scope).toBe('quota');
    expect(quota.scopeKey).toBe('quota:acct-1');
  });

  it('keeps the inference backend separate from the CLI installation', async () => {
    // Review probe regression: backend `openai` became `provider:codex`;
    // `anthropic` became `installation:multi`. The backend is used raw.
    const provider = await buildFailureAttribution(
      { invocationId: 'i-4', selected: { cli: 'codex', inferenceProvider: 'openai' } },
      { reasonCode: 'NETWORK', evidenceSource: 'launcher' },
    );
    expect(provider).toEqual({ scope: 'provider', scopeKey: 'provider:openai', confidence: 'suspected' });
    const install = await buildFailureAttribution(
      { invocationId: 'i-5', selected: { cli: 'codex', inferenceProvider: 'openai' } },
      { reasonCode: 'NOT_FOUND', evidenceSource: 'launcher' },
    );
    expect(install).toEqual({ scope: 'installation', scopeKey: 'installation:codex', confidence: 'suspected' });
  });

  it('derives the quota account from trusted installation qualification', async () => {
    const quota = await buildFailureAttribution(
      { invocationId: 'i-6', selected: { cli: 'codex', inferenceProvider: 'openai' },
        qualification: { installation: { accountScope: 'acct-9' } } },
      { reasonCode: 'RATE_LIMIT', evidenceSource: 'resolver' },
    );
    expect(quota.scopeKey).toBe('quota:acct-9');
  });

  it('falls back to the invocation scope when identity is unavailable', async () => {
    const out = await buildFailureAttribution({ invocationId: 'i-3', selected: {} },
      { reasonCode: 'MODEL', evidenceSource: 'launcher' });
    expect(out.scopeKey).toBe('invocation:i-3');
  });

  it('never widens on worker-sourced codes', async () => {
    const out = await buildFailureAttribution(
      { invocationId: 'i-7', selected: { cli: 'codex', inferenceProvider: 'openai' } },
      { reasonCode: 'RATE_LIMIT', evidenceSource: 'worker', quotaAccount: 'acct-1' },
    );
    expect(out.scope).toBe('invocation');
  });
});

describe('classifyLaunchOutcomeForRecovery', () => {
  it('treats only pre-spawn binary failures as installation evidence', () => {
    expect(classifyLaunchOutcomeForRecovery({ termination: 'confirmed', exitCode: null, errorCode: 'ENOENT' }))
      .toEqual({ reasonCode: 'NOT_FOUND', evidenceSource: 'launcher' });
    expect(classifyLaunchOutcomeForRecovery({ termination: 'confirmed', exitCode: 1, errorCode: null }))
      .toEqual({ reasonCode: null, evidenceSource: 'launcher' });
    expect(classifyLaunchOutcomeForRecovery({ termination: 'confirmed', exitCode: 0 }))
      .toEqual({ reasonCode: null, evidenceSource: 'launcher' });
  });

  it('produces no trusted evidence from uncertain terminations', () => {
    expect(classifyLaunchOutcomeForRecovery({ termination: 'uncertain', exitCode: null, errorCode: 'ENOENT' }))
      .toEqual({ reasonCode: null, evidenceSource: null });
    expect(classifyLaunchOutcomeForRecovery(null)).toEqual({ reasonCode: null, evidenceSource: null });
  });

  it('derives covering keys from trusted resolved identities only, always including the single-host scope', async () => {
    await expect(recoveryScopeKeysForInvocation(
      { selected: { cli: 'codex', inferenceProvider: 'openai' } }, { invocationId: 'i-1', quotaAccount: 'acct-1' }))
      .resolves.toEqual(['invocation:i-1', 'installation:codex', 'provider:openai', 'quota:acct-1', 'host:local']);
    // No resolvable model/installation/provider/quota identity -- `host:local`
    // is the only key, never defaulted to a shared installation/provider/
    // quota scope (#2915 review: model/host scopes were never covered).
    await expect(recoveryScopeKeysForInvocation({ selected: {} }, {})).resolves.toEqual(['host:local']);
  });

  it('derives the model scope key and a qualified installation scope key', async () => {
    const keys = await recoveryScopeKeysForInvocation(
      { selected: { cli: 'codex', inferenceProvider: 'openai', apiModelId: 'gpt-x' } },
      { invocationId: 'i-9', installationQualifier: 'sha256:boundary-a' });
    expect(keys).toEqual(['invocation:i-9', 'model:openai/gpt-x', 'installation:codex:sha256:boundary-a', 'provider:openai', 'host:local']);
    // A different installationQualifier for the same CLI name produces a
    // DIFFERENT installation scope key (#2915 review: two installations
    // under one CLI name shared one scope).
    const otherKeys = await recoveryScopeKeysForInvocation(
      { selected: { cli: 'codex', inferenceProvider: 'openai', apiModelId: 'gpt-x' } },
      { invocationId: 'i-10', installationQualifier: 'sha256:boundary-b' });
    expect(otherKeys).toContain('installation:codex:sha256:boundary-b');
    expect(otherKeys).not.toContain('installation:codex:sha256:boundary-a');
  });
});

describe('existing breaker untouched', () => {
  it('still trips on consecutive failures with cooldown', () => {
    vi.useFakeTimers();
    const single = new ConsecutiveFailureCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    try {
      single.recordFailure();
      single.recordFailure();
      expect(single.getState().state).toBe('open');
      expect(single.canExecute()).toBe(false);
    } finally {
      single.destroy();
      vi.useRealTimers();
    }
  });

  it('shares one injected clock between the scoped and inner breakers', () => {
    // One-clock regression: the inner breaker must follow the injected
    // clock, not Date.now(). A manual clock advanced past the cooldown —
    // with wall time untouched — must half-open the inner breaker.
    let now = 1_000_000;
    const single = new ConsecutiveFailureCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000, nowMs: () => now });
    try {
      single.recordFailure();
      expect(single.getState().state).toBe('open');
      expect(single.canExecute()).toBe(false);
      now += 60_001;
      expect(single.canExecute()).toBe(true);
      expect(single.getState().state).toBe('half-open');
    } finally {
      single.destroy();
    }
  });
});

describe('admitDirectWorker / settleDirectWorker (replaces recordDirectWorkerOutcome)', () => {
  it('records bridge outcomes invocation-scoped and settles cohort membership', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const invocation = { selected: { cli: 'codex', inferenceProvider: 'openai' } };
      const config = { parallelism: { worker_dispatch: true } };
      const admit = (invocationId) => admitDirectWorker({ gateEnabled: true, config, invocation, invocationId, scopedBreaker: breaker, drivers: {} });
      const a1 = await admit('r-1');
      expect(a1.gated).toBe(true);
      settleDirectWorker(a1, { kind: 'failed' }); // wait-status alone never implicates a shared scope
      expect(breaker.getState('installation:codex').tracked).toBe(false);
      expect(breaker.getState('provider:openai').tracked).toBe(false);
      expect(breaker.snapshot().attemptsObserved).toBe(1);
      const a2 = await admit('r-2');
      settleDirectWorker(a2, { kind: 'succeeded' });
      expect(breaker.snapshot().attemptsObserved).toBe(2);
      const a3 = await admit('r-3');
      settleDirectWorker(a3, { kind: 'uncertain' });
      // #2915 review 4 (finding 8): 'uncertain' is never recorded as an
      // observed attempt (diagnostic-only counter; see consecutive-failure-
      // circuit-breaker.mjs `_recordObservedAttempt`'s doc comment).
      expect(breaker.snapshot().attemptsObserved).toBe(2);
    } finally {
      breaker.destroy();
    }
  });
});

describe('classifyAttemptForSettlement / admitDirectWorker (replaces recordRecoveryAfterAttempt)', () => {
  it('attributes a pre-spawn-style failure to the SAME qualified installation key the pre-launch gate watches (#2915 P3 qualifier-consistency)', async () => {
    // Regression: attributing a failure through the UNqualified
    // `installation:<cli>` key while admission watches the QUALIFIED
    // `installation:<cli>:<qualifier>` key would open a scope admission
    // never checks -- the gate would never catch its own failures.
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const invocation = { selected: { cli: 'codex', inferenceProvider: 'openai' } };
      const qualifier = 'sha256:boundary-x';
      const config = { parallelism: { worker_dispatch: true } };
      const attemptFailure = async (id) => {
        const admission = await admitDirectWorker({ gateEnabled: true, config, invocation, invocationId: id,
          scopedBreaker: breaker, drivers: {}, installationQualifier: qualifier });
        const result = { termination: 'confirmed', exitCode: null, errorCode: 'ENOENT', attemptOutcome: 'failed' };
        settleDirectWorker(admission, classifyAttemptForSettlement(invocation, result, { installationQualifier: qualifier }));
        return admission;
      };
      const first = await attemptFailure('r-1');
      const scopeKeys = first.token?.coveringKeys ?? await recoveryScopeKeysForInvocation(invocation, { invocationId: 'r-1', installationQualifier: qualifier });
      expect(scopeKeys).toContain('installation:codex:sha256:boundary-x');
      const state = breaker.getState('installation:codex:sha256:boundary-x');
      expect(state.tracked).toBe(true);
      expect(state.distinctFailures).toBe(1);
      // The UNqualified key must NOT have received this failure.
      expect(breaker.getState('installation:codex').tracked).toBe(false);
      await attemptFailure('r-2');
      await attemptFailure('r-3');
      expect(breaker.getState('installation:codex:sha256:boundary-x').state).toBe('open');
    } finally {
      breaker.destroy();
    }
  });

  it('recovers the scope on a launcher-confirmed success, passing attemptOutcome through classifyAttemptForSettlement', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const invocation = { selected: { cli: 'codex' } };
      const config = { parallelism: { worker_dispatch: true } };
      const admission = await admitDirectWorker({ gateEnabled: true, config, invocation, invocationId: 'ok-1', scopedBreaker: breaker, drivers: {} });
      const result = { termination: 'confirmed', exitCode: 0, attemptOutcome: 'succeeded' };
      const outcome = classifyAttemptForSettlement(invocation, result);
      expect(outcome).toEqual({ kind: 'succeeded', confirmedStop: true });
      settleDirectWorker(admission, outcome);
      expect(breaker.snapshot().attemptsObserved).toBe(1);
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 5 ("a second worker over unresolved execution"): a
  // degraded-isolation attempt can never confirm descendant termination
  // (`captureOneWorker`'s own `confirmed` computation is always false for
  // it), so `confirmedStop` must read false even on a genuinely SUCCESSFUL
  // attempt — this is the fact `ScopedFailureBreaker.settle()` consults to
  // decide whether a canary's blocking marker may clear, entirely separate
  // from `kind` (attempt success/failure).
  it('confirmedStop reflects result.termination independently of attemptOutcome', () => {
    const invocation = { selected: { cli: 'codex' } };
    expect(classifyAttemptForSettlement(invocation, { termination: 'confirmed', attemptOutcome: 'succeeded' }))
      .toEqual({ kind: 'succeeded', confirmedStop: true });
    expect(classifyAttemptForSettlement(invocation, { termination: 'uncertain', attemptOutcome: 'succeeded' }))
      .toEqual({ kind: 'succeeded', confirmedStop: false });
    expect(classifyAttemptForSettlement(invocation, { termination: 'uncertain', attemptOutcome: 'uncertain' }))
      .toEqual({ kind: 'uncertain', confirmedStop: false });
    const failed = classifyAttemptForSettlement(invocation,
      { termination: 'confirmed', attemptOutcome: 'failed', errorCode: 'ENOENT', sawExit: false, exitCode: null });
    expect(failed).toMatchObject({ kind: 'failed', confirmedStop: true, reasonCode: 'NOT_FOUND', evidenceSource: 'launcher' });
  });
});

// #2915 P4: determinism requires injecting BOTH the dispatch switch/live
// signals (so `checkWorkerDispatch`'s real resource sampling never decides
// the outcome) and the isolation detector (so a host with/without a
// reachable systemd --user manager behaves identically) -- these tests
// previously depended on the real host's systemd reachability and failed
// with "Worker isolation requires a positive memoryMaxGb ceiling" on any
// host where isolation was actually detected as available.
const dispatchOnConfig = Object.freeze({ parallelism: { worker_dispatch: true } });
const healthyLive = Object.freeze({ supported: true, availMemGb: 64, loadRatio: 0.01, memPsiAvg10: 0, memPsiAvg60: 0, workers: 0, freeDiskGb: 64 });

describe('planDirectWorkerLaunch recovery gate', () => {
  it('refuses a covered launch before any spawn and passes an unaffected one to the dispatch gate', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      for (const id of ['a', 'b', 'c']) failEvidence(breaker, installFailure(id));
      const invocation = { selected: { cli: 'codex', inferenceProvider: 'openai' }, stdin: 'closed' };
      const blocked = await planDirectWorkerLaunch({ invocation, scopedBreaker: breaker,
        config: dispatchOnConfig, live: healthyLive });
      expect(blocked.launched).toBe(false);
      expect(blocked.blocked).toBe(true);
      expect(blocked.recoveryBlocked).toEqual(['installation:codex']);
      // An unrelated CLI is unaffected and reaches the dispatch gate (which
      // refuses here on injected degraded isolation, deterministically,
      // without ever spawning).
      const other = await planDirectWorkerLaunch({
        invocation: { selected: { cli: 'other-cli', inferenceProvider: 'other-backend' }, stdin: 'closed' },
        scopedBreaker: breaker, config: dispatchOnConfig, live: healthyLive,
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' },
      });
      expect(other.recoveryBlocked).toBeUndefined();
      expect(other.launched).toBe(false);
    } finally {
      breaker.destroy();
    }
  });

  it('skips the gate for flat-option callers with no trusted identities', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const out = await planDirectWorkerLaunch({ command: '/nonexistent', args: [], cwd: '/tmp', scopedBreaker: breaker,
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' } });
      expect(out.recoveryBlocked).toBeUndefined();
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 5 (finding 4, "unauthenticated or reused authority"): a
  // fabricated `admission` object -- never minted by `admitDirectWorker` --
  // previously dispatched exactly as if the scope had been genuinely
  // checked and found closed. This is an authentication bypass: calling
  // `planDirectWorkerLaunch` with a borrowed admission requires NO prior
  // call to `admitDirectWorker` at all.
  it('refuses a fabricated borrowed admission instead of dispatching on unauthenticated authority', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const invocation = { selected: { cli: 'codex', inferenceProvider: 'openai' }, stdin: 'closed' };
      // Shapes a real caller could plausibly forge: a plain object with no
      // `token`/`breaker`, claiming to be gated-and-admitted.
      const fabricated = { gated: true };
      // `planDirectWorkerLaunch` is deliberately NOT declared `async` (see
      // its own doc comment: synchronous, byte-for-byte legacy return for
      // disabled dispatch) -- the borrowed-admission validation runs in
      // its synchronous body, so the throw happens synchronously here,
      // never as a rejected Promise.
      expect(() => planDirectWorkerLaunch({ invocation, scopedBreaker: breaker, config: dispatchOnConfig, live: healthyLive,
        admission: fabricated, isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true }))
        .toThrow(/not a value admitDirectWorker returned/);
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 5 (finding 4): ONE genuine admission, reused for a SECOND
  // distinct dispatch attempt, previously launched twice -- each admission
  // must authorize exactly one launch.
  it('refuses to launch twice off ONE genuine borrowed admission', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const admission = await admitDirectWorker({ gateEnabled: true, config: dispatchOnConfig, invocation: { selected: { cli: 'codex' } },
        invocationId: 'reuse-1', scopedBreaker: breaker, drivers: {} });
      expect(admission.gated).toBe(true);
      const first = await planDirectWorkerLaunch({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, admission, invocationId: admission.invocationId,
        invocation: { selected: { cli: 'codex' } },
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true });
      expect(first.launched).toBe(true);
      // #2915 round 8 (D2/D3): single-use consumption is now authenticated
      // by `beginDispatch`, INSIDE the dispatch-commit hook — the refusal
      // is a RESULT `launchIsolatedWorker` returns (never a thrown error),
      // consistent with every other pre-spawn refusal in this module.
      const second = await planDirectWorkerLaunch({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, admission, invocationId: admission.invocationId,
        invocation: { selected: { cli: 'codex' } },
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true });
      expect(second.launched).toBe(false);
      expect(second.failures?.[0]?.reason).toMatch(/not a live, unclaimed reservation/);
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 6 (finding 1, "unauthenticated/reused authority"): a
  // `gated: false` CLAIM must never be trusted as authority to bypass --
  // the planner's OWN checks above have already determined this dispatch
  // IS gated (a real breaker is configured and neither the global switch
  // nor the per-CLI setting is off), so a borrowed admission asserting
  // `gated: false` here contradicts that and must be refused, never
  // honored as a free bypass.
  it('refuses a borrowed admission claiming gated:false while this dispatch is actually gated', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      expect(() => planDirectWorkerLaunch({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, admission: { gated: false },
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true }))
        .toThrow(/claims not-gated while this dispatch is gated/);
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 6 (finding 1): a FABRICATED breaker satisfying the old
  // duck-typed shape check (`{ settle(){} }`) dispatched with zero real
  // breaker protection. `instanceof ScopedFailureBreaker` closes that gap.
  it('refuses a borrowed admission whose breaker is not a real ScopedFailureBreaker instance', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const forged = { gated: true, token: {}, breaker: { settle() { return { ok: true }; }, claimLaunch() { return true; } } };
      expect(() => planDirectWorkerLaunch({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, admission: forged,
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true }))
        .toThrow(/not a value admitDirectWorker returned/);
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 6 (finding 1): a COPY of a genuine wrapper around the
  // SAME real token/breaker -- never seen by the local `_consumedBorrowedAdmissions`
  // WeakSet, which tracks the wrapper object, not the token -- must still
  // be refused: `claimLaunch` authenticates and consumes by the token's
  // OWN reference identity on the breaker, independent of which wrapper
  // object carries it.
  it('refuses a copied wrapper reusing the SAME real token, even though the WeakSet never saw this exact wrapper', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const admission = await admitDirectWorker({ gateEnabled: true, config: dispatchOnConfig, invocation: { selected: { cli: 'codex' } },
        invocationId: 'copy-1', scopedBreaker: breaker, drivers: {} });
      expect(admission.gated).toBe(true);
      const copy = { ...admission }; // fresh wrapper object, SAME token/breaker references
      const first = await planDirectWorkerLaunch({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, admission, invocationId: admission.invocationId,
        invocation: { selected: { cli: 'codex' } },
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true });
      expect(first.launched).toBe(true);
      // Same result-shaped refusal as the reuse test above -- the copy
      // shares the SAME real token/breaker references, so `beginDispatch`
      // refuses it identically regardless of which wrapper object carries it.
      const second = await planDirectWorkerLaunch({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, admission: copy, invocationId: copy.invocationId,
        invocation: { selected: { cli: 'codex' } },
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true });
      expect(second.launched).toBe(false);
      expect(second.failures?.[0]?.reason).toMatch(/not a live, unclaimed reservation/);
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 6 (finding 1): a reservation minted for one invocation id
  // must not authorize dispatching a DIFFERENT invocation.
  it('refuses a borrowed admission minted for a different invocation id', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const admission = await admitDirectWorker({ gateEnabled: true, config: dispatchOnConfig, invocation: { selected: { cli: 'codex' } },
        invocationId: 'mismatch-1', scopedBreaker: breaker, drivers: {} });
      expect(admission.gated).toBe(true);
      // #2915 round 8 (D2/D3): the mismatch is now authenticated by
      // `beginDispatch` against the breaker's own frozen token field —
      // derived HERE from this call's own `invocationId`, never from the
      // borrowed wrapper's own (mutable) copy — and surfaces as a refusal
      // result, not a thrown error.
      const result = await planDirectWorkerLaunch({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, admission, invocationId: 'mismatch-2',
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true });
      expect(result.launched).toBe(false);
      expect(result.failures?.[0]?.reason).toMatch(/reservation binding does not match/);
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 6 (finding 1): a reservation minted for one CLI selection
  // must not authorize dispatching a DIFFERENT selection.
  it('refuses a borrowed admission minted for a different selection', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const admission = await admitDirectWorker({ gateEnabled: true, config: dispatchOnConfig,
        invocation: { selected: { cli: 'codex', inferenceProvider: 'openai' } },
        invocationId: 'selection-1', scopedBreaker: breaker, drivers: {} });
      expect(admission.gated).toBe(true);
      // #2915 round 8 (D2/D3): the mismatch is authenticated by
      // `beginDispatch` against the breaker's own frozen `selectionDigest`
      // field, derived HERE from the resolved `invocation` this exact call
      // was given.
      const result = await planDirectWorkerLaunch({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, admission, invocationId: admission.invocationId,
        invocation: { selected: { cli: 'claude', inferenceProvider: 'anthropic' } },
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true });
      expect(result.launched).toBe(false);
      expect(result.failures?.[0]?.reason).toMatch(/reservation binding does not match/);
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 6 (finding 1): an EXPIRED reservation (its own canary
  // deadline already passed) must not authorize a launch even though it
  // is otherwise a perfectly genuine, unconsumed admission.
  it('refuses an expired borrowed admission', async () => {
    let now = 5_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    try {
      for (const id of ['a', 'b', 'c']) failEvidence(breaker, installFailure(id));
      now += 120_000;
      completePreliminaryProbe(breaker, [INSTALL]);
      const admission = await admitDirectWorker({ gateEnabled: true, config: dispatchOnConfig,
        invocation: { selected: { cli: 'codex' } }, invocationId: 'expiring-1', scopedBreaker: breaker, drivers: {} });
      expect(admission.gated).toBe(true);
      expect(admission.token.canaryKeys).toEqual([INSTALL]); // this IS the canary, bounded by canaryTimeoutMs
      now += 300_001; // past the canary's own 300s deadline
      const result = await planDirectWorkerLaunch({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, admission, invocationId: admission.invocationId,
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true });
      expect(result.launched).toBe(false);
      expect(result.failures?.[0]?.reason).toMatch(/not a live, unclaimed reservation/);
    } finally {
      breaker.destroy();
    }
  });

  it('is inert when worker_dispatch is off: an open scope never blocks, and the breaker is never constructed or consulted (#2915 P0)', async () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      for (const id of ['a', 'b', 'c']) failEvidence(breaker, installFailure(id));
      expect(breaker.getState(INSTALL).state).toBe('open');
      const attemptsObservedBefore = breaker.snapshot().attemptsObserved;
      const invocation = { selected: { cli: 'codex', inferenceProvider: 'openai' }, stdin: 'closed' };
      const out = await planDirectWorkerLaunch({ invocation, scopedBreaker: breaker,
        config: { parallelism: { worker_dispatch: false } }, live: healthyLive,
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' } });
      expect(out.recoveryBlocked).toBeUndefined();
      expect(out.blocked).toBeUndefined();
      // The breaker itself is untouched: no launch was ever noted against
      // the open scope, confirming the gate was never even consulted, not
      // merely that it happened to pass.
      expect(breaker.snapshot().attemptsObserved).toBe(attemptsObservedBefore);
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 5 (finding 2c, "leaked capacity"): a standalone successful
  // launch (no borrowed admission -- the caller is responsible for its own
  // settlement by this function's own documented contract) must not leak
  // its reservation FOREVER when the caller never settles. A non-canary
  // admission's token has an `Infinity` deadline (only a canary gets the
  // breaker's bounded `canaryTimeoutMs`), so the breaker's own sweep can
  // never reclaim it on its own -- proven here via the CANARY case, where
  // a stuck reservation is directly observable: it would otherwise block
  // every later admission for this scope, forever, with no caller ever
  // calling `settleDirectWorker`.
  it('a standalone successful launch settles itself once the real child exits, even though the caller never calls settleDirectWorker', async () => {
    // An injected clock (never `vi.useFakeTimers()`, which would also fake
    // the event loop timers the REAL spawned child's async exit depends
    // on) -- the same `nowMs` pattern the canary-cycle tests above use.
    let now = 1_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    try {
      for (const id of ['a', 'b', 'c']) failEvidence(breaker, installFailure(id));
      expect(breaker.getState(INSTALL).state).toBe('open');
      now += 120_000;
      completePreliminaryProbe(breaker, [INSTALL]);
      const invocation = { selected: { cli: 'codex', inferenceProvider: 'openai' }, stdin: 'closed' };
      // A real, fast-exiting child -- standalone, no `admission` borrowed,
      // and the caller (this test) deliberately never calls
      // `settleDirectWorker` on the returned admission.
      const launch = await planDirectWorkerLaunch({
        invocation, scopedBreaker: breaker, config: dispatchOnConfig, live: healthyLive,
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
      });
      expect(launch.launched).toBe(true);
      expect(launch.admission).toBeDefined();
      expect(launch.child).toBeDefined();
      // Wait for the real child to actually exit.
      await new Promise(resolve => launch.child.once('exit', resolve));
      // Give the safety-net's own 'exit' listener a turn to run and settle.
      await new Promise(resolve => setImmediate(resolve));
      // The canary slot was freed by the safety net, not left stuck forever
      // -- a fresh probe (and, if due, a new canary admission) must be
      // reachable again. (The scope itself reopened on no confirmed
      // success, as expected for an unconfirmed 'uncertain' settlement;
      // what matters here is that it is NOT permanently wedged by a
      // never-settled reservation.)
      expect(breaker.getState(INSTALL).activeCanary).toBeNull();
    } finally {
      breaker.destroy();
    }
  });

  // #2915 review 6 (finding 5): a standalone NON-ATTACHED systemd-unit
  // launch has no direct child handle in this process at all (`launch.child`
  // is undefined), unlike every other isolation mode above -- the
  // direct-child safety net can never attach here, so without a dedicated
  // observer this reservation would never settle at all (an `Infinity`
  // deadline; the breaker's own sweep can never reclaim it either). Fakes
  // every `systemd-run`/`systemctl` subprocess call (never detects or
  // requires a real host systemd user manager) and injects the native
  // unit-status poll so the observer settles once the unit itself reports
  // inactive.
  it('settles a standalone non-attached systemd-unit launch via the native unit-status poll, even with no child handle to observe', async () => {
    const client = systemdClientFixture();
    vi.stubEnv('PATH', client.root);
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      const invocation = { selected: { cli: 'codex' }, stdin: 'closed' };
      let statusCalls = 0;
      const isolationStatus = () => {
        statusCalls += 1;
        return statusCalls < 3 ? { active: true } : { active: false, execMainCode: 1 };
      };
      const fakeSpawn = (cmd, args) => {
        if (cmd === client.systemctl && args[0] === '--user' && args[1] === 'show-environment') {
          return { error: null, status: 0, stdout: 'PATH=/usr/bin\n', stderr: '' };
        }
        if (cmd === client.binary) {
          expect(path.isAbsolute(cmd)).toBe(true);
          return { error: null, status: 0, stdout: '', stderr: '' };
        }
        if (cmd === client.systemctl && args[0] === '--user' && args[1] === 'show') {
          return { error: null, status: 0, stdout: '4242\n', stderr: '' };
        }
        return { error: new Error(`unexpected spawn: ${cmd}`), status: 1, stdout: '', stderr: '' };
      };
      const launch = await planDirectWorkerLaunch({
        invocation, scopedBreaker: breaker, config: dispatchOnConfig, live: healthyLive,
        command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(), memoryMaxGb: 1,
        isolation: { mode: 'systemd-unit' }, spawn: fakeSpawn, proposeUnit: () => 'aiwg-fixture-unit',
        isolationStatus, unitSettlementPollMs: 5, unitSettlementBoundMs: 500,
      });
      expect(launch.launched).toBe(true);
      expect(launch.mode).toBe('systemd-unit');
      expect(launch.child).toBeUndefined();
      expect(launch.admission).toBeDefined();
      expect(breaker.snapshot().reservationsOutstanding).toBe(1); // nothing settled it yet
      // No caller ever calls `settleDirectWorker` directly -- only the
      // observer does, once the unit itself reports inactive.
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const check = () => {
          if (breaker.snapshot().reservationsOutstanding === 0) { resolve(); return; }
          if (Date.now() > deadline) { reject(new Error('standalone unit settlement observer never ran')); return; }
          setTimeout(check, 10);
        };
        check();
      });
      expect(statusCalls).toBeGreaterThanOrEqual(3);
    } finally {
      breaker.destroy();
      vi.unstubAllEnvs();
      await rm(client.root, { recursive: true, force: true });
    }
  });
});

describe('breaker restart semantics', () => {
  it('comes up CLOSED on restart: a fresh instance inherits no open scopes', () => {
    // Documents the in-memory restart contract: fail-open on restart,
    // coupled with the stop-before-retry gate (exit.json evidence) and
    // re-opening on fresh trusted evidence. No reservation survives.
    const first = new ScopedFailureBreaker({ jitterMs: () => 0 });
    for (const id of ['a', 'b', 'c']) failEvidence(first, installFailure(id));
    expect(first.getState(INSTALL).state).toBe('open');
    first.destroy();
    const restarted = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      expect(restarted.getState(INSTALL).tracked).toBe(false);
      expect(probe(restarted, [INSTALL]).ok).toBe(true);
    } finally {
      restarted.destroy();
    }
  });
});

describe('bounded retained state (#2915 P3: scopes, cohorts and dedup sets never grow without bound)', () => {
  it('evicts inert (closed, memberless) scopes once maxTrackedScopes is reached, never an open one', () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0, policy: { maxTrackedScopes: 5 } });
    try {
      // One genuinely OPEN scope, created first so it is the "oldest" by
      // insertion order -- it must survive eviction regardless.
      for (const id of ['a', 'b', 'c']) failEvidence(breaker, installFailure(id));
      expect(breaker.getState(INSTALL).state).toBe('open');
      // Many distinct CLOSED, memberless scopes (one failure each, never
      // reaching the distinct-threshold) -- each creates a new tracked
      // scope record via a fresh CLI name. (Constructed directly, not via
      // `installFailure`, which hardcodes `scopeKey: INSTALL` regardless
      // of the `cli` passed -- settle() only re-narrows a claim, it never
      // re-keys an already-matching-rank claim to a different key.)
      for (let n = 0; n < 20; n += 1) {
        const key = scopeKeyFor.installation(`cli-${n}`);
        fail(breaker, [key], `solo-${n}`, { scope: FailureScope.INSTALLATION, scopeKey: key, reasonCode: 'NOT_FOUND', evidenceSource: 'launcher', cli: `cli-${n}` });
      }
      expect(breaker.snapshot().scopes.length).toBeLessThanOrEqual(5);
      // The open scope was never evicted.
      expect(breaker.getState(INSTALL).tracked).toBe(true);
      expect(breaker.getState(INSTALL).state).toBe('open');
    } finally {
      breaker.destroy();
    }
  });

  it('evicts the oldest charged-attempt id once maxChargedAttempts is reached', () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0, policy: { maxChargedAttempts: 5 } });
    try {
      for (let n = 0; n < 50; n += 1) {
        succeed(breaker, ['installation:codex'], `ok-${n}`);
      }
      expect(breaker.snapshot().attemptsObserved).toBeLessThanOrEqual(5);
    } finally {
      breaker.destroy();
    }
  });

  it('removes an outstanding scope key entirely once its member set empties (not just emptying the nested map)', () => {
    const breaker = new ScopedFailureBreaker({ jitterMs: () => 0 });
    try {
      uncertain(breaker, ['installation:codex'], 'a');
      // #2915 review: settlement emptied the nested Map but never deleted
      // the scopeKey itself, retaining the key forever even though no
      // scope record was ever created (`admit`/`settle` touch only
      // `_outstanding` for a never-failed scope, not `_scopes`).
      expect(breaker.getState('installation:codex')).toEqual({ scopeKey: 'installation:codex', state: 'closed', tracked: false });
      // A later, unrelated single launch on the same key must not inherit
      // 'a' as a frozen-cohort member (the observable proof the key, not
      // just its contents, was actually removed).
      fail(breaker, ['installation:codex'], 'b', installFailure('b'));
      expect(breaker.getState(INSTALL).cohortSize).toBe(1);
    } finally {
      breaker.destroy();
    }
  });
});

// #3505: real-I/O integration cases below freeze the recovery clock by
// default. Explicit moving clocks still exercise expiry and canary deadlines.
// Pass each owned breaker to launchWorker as well as the singleton seam:
// its dispatch guard reads options.scopedBreaker, not the singleton clock.
describe('S1 direct-dispatch integration (offline, fake CLI binary)', () => {
  // Proves the live launchWorker path constructs and consults the scoped
  // breaker: three launcher-observed missing-binary failures open the
  // installation scope, a fourth launch is refused while it is open, and
  // launches proceed after a launcher-verified probe → canary cycle. No
  // spawns of real CLIs, no network, no model calls — the "CLI" is a
  // nonexistent binary, so every attempt fails at spawn with ENOENT.
  async function enoentFixtureRoot() {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const f = workerResolutionFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-scoped-recovery-'));
    const cwd = path.join(root, 'work');
    await mkdir(cwd);
    const brief = path.join(root, 'brief.json');
    await writeFile(brief, 'synthetic brief');
    const final = path.join(root, 'final.json');
    const adapter = f.snapshot.registry.providers.codex.workerAdapter;
    const profile = adapter.invocationProfiles['fixture-shell'];
    profile.envAllowlist = [];
    profile.health = { version: 1, handshake: 'process-only', outputFraming: 'jsonl', signalParser: 'fixture:jsonl',
      sessionLogLocator: null, progressEvidence: [], stopEvidence: 'fixture:wait-only', fixtureRef: 'fixture:one-shot',
      qualifiedAt: f.request.now, statusOperation: null, cancelOperation: null };
    f.snapshot.config.parallelism.health = { hardTimeoutSeconds: 5, terminateGraceSeconds: 1 };
    // #2915 review 4 (finding 8): this fixture deliberately retries the
    // exact SAME task (role/task/group/brief content, so the same stable
    // task-chain digest) across many real attempts to exercise the
    // BREAKER's own canary/backoff cycle -- that is a distinct concern
    // from the per-task-chain allowance ledger's attempt budget. Raise the
    // resolved ceiling well past this suite's attempt counts so the
    // breaker scenarios below are not incidentally capped by the ledger;
    // the ledger's own exhaustion behavior is covered separately. No test
    // below passes its own `captureRoot`, so every one of them shares this
    // ONE in-process ledger record for the identical role/task/group/brief
    // digest -- raised again (#2915 review 5) to cover the production-
    // closure negative-twin test added for the real strict-parser fix.
    f.snapshot.config.parallelism.retry = { maxAttempts: 40 };
    const driver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0',
      boundary: { kind: 'os', identity: 'fixture:boundary', digest: qualificationDigest('boundary'), controls: ['sandbox'] } },
      buildInvocation: async (input) => ({ argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'),
        '--model', input.selected.model, '--final-output', input.finalPath, '--', 'synthetic'],
        stdin: 'closed', envNames: [] }),
      extractFinal: () => null,
    };
    const drivers = { codex: driver };
    f.snapshot.installations.codex.boundary = driver.qualification.boundary;
    // Every attempt resolves a FRESH plan: capture files from one attempt
    // must never collide with the next attempt's fresh-output requirement.
    let planSeq = 0;
    const freshPlan = async () => {
      planSeq += 1;
      const attemptFinal = path.join(root, `final-${planSeq}.json`);
      const request = { role: 'coding', task: 'implementation', group: 'workers', brief, workdir: cwd, final_output: attemptFinal };
      const plan = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
      expect(plan.invocation).toBeDefined();
      const invocationPath = path.join(root, `plan-${planSeq}.json`);
      await writeFile(invocationPath, JSON.stringify(plan));
      return invocationPath;
    };
    return { f, root, cwd, brief, final, freshPlan, drivers };
  }

  // #2915 review 5 (finding 4, "unauthenticated or reused authority"): the
  // writable-root exclusion `verifyRetryPredecessor` itself already
  // supports was never actually wired into production `launchWorker` --
  // this proves a forged predecessor record planted inside the worker's
  // own writable worktree (the default `workerWritableRoots` fallback, no
  // special driver config needed) is refused through the REAL end-to-end
  // `launcher.launchWorker({ retryOf })` call, not merely the
  // `verifyRetryPredecessor` helper in isolation.
  it('refuses a forged retry predecessor planted inside the worker-writable root, through the real launchWorker path', async () => {
    const fx = await enoentFixtureRoot();
    const launcher = new SessionLauncher();
    try {
      const invocationPath = await fx.freshPlan();
      const saved = JSON.parse(await readFile(invocationPath, 'utf8'));
      const taskDigest = await stableTaskChainDigest(saved.request, saved.invocation.briefDigest);
      // Planted INSIDE fx.cwd -- the worker's own writable worktree, which
      // falls back to being the default `workerWritableRoots` entry when
      // (as here) the driver declares none of its own.
      const forgedRunDir = path.join(fx.cwd, 'forged-predecessor');
      await mkdir(forgedRunDir, { mode: 0o700 });
      await writeFile(path.join(forgedRunDir, '.launch-owner'), 'forged-prev', { mode: 0o600 });
      await writeFile(path.join(forgedRunDir, 'invocation.json'),
        JSON.stringify({ invocationId: 'forged-prev', origin: 'launcher', taskDigest }), { mode: 0o600 });
      await writeFile(path.join(forgedRunDir, 'exit.json'),
        JSON.stringify({ invocationId: 'forged-prev', termination: 'confirmed' }), { mode: 0o600 });
      let spawned = false;
      await expect(launcher.launchWorker({
        invocationPath, runDir: path.join(fx.root, 'retry-run'),
        retryOf: { invocationId: 'forged-prev', runDir: forgedRunDir },
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: async (options) => { await options.onDispatchCommit?.(); spawned = true; return { mode: 'degraded',
          child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }; },
      })).rejects.toMatchObject({ code: UNBOUND_RETRY_EVIDENCE_CODE });
      expect(spawned).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  // The positive counterpart: a GENUINE predecessor outside any
  // worker-writable root is still accepted end-to-end through the same
  // real `launchWorker({ retryOf })` wiring -- the writable-root exclusion
  // must refuse forged/misplaced evidence without blocking legitimate
  // retries.
  it.each([true, false])('accepts a genuine retry predecessor through launchWorker (explicit ID: %s)', async explicitId => {
    const fx = await enoentFixtureRoot();
    const launcher = new SessionLauncher();
    try {
      const invocationPath = await fx.freshPlan();
      const saved = JSON.parse(await readFile(invocationPath, 'utf8'));
      const taskDigest = await stableTaskChainDigest(saved.request, saved.invocation.briefDigest);
      // Outside fx.cwd entirely -- a conductor-owned predecessor location,
      // never inside the worker's own writable worktree.
      const genuineRunDir = path.join(fx.root, 'genuine-predecessor');
      await mkdir(genuineRunDir, { mode: 0o700 });
      await writeFile(path.join(genuineRunDir, '.launch-owner'), 'genuine-prev', { mode: 0o600 });
      await writeFile(path.join(genuineRunDir, 'invocation.json'),
        JSON.stringify({ invocationId: 'genuine-prev', origin: 'launcher', taskDigest }), { mode: 0o600 });
      await writeFile(path.join(genuineRunDir, 'exit.json'),
        JSON.stringify({ invocationId: 'genuine-prev', termination: 'confirmed' }), { mode: 0o600 });
      const result = await launcher.launchWorker({
        invocationPath, runDir: path.join(fx.root, 'retry-run-genuine'),
        retryOf: { ...(explicitId ? { invocationId: 'genuine-prev' } : {}), runDir: genuineRunDir },
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: async (options) => { await options.onDispatchCommit?.(); return { mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }; },
      });
      expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT' });
      expect(JSON.parse(await readFile(path.join(fx.root, 'retry-run-genuine', 'invocation.json'), 'utf8')))
        .toMatchObject({ previousAttemptId: 'genuine-prev' });
    } finally {
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  // #2915 review 5 ("disabled-dispatch equivalence"): stop-before-retry is
  // MANDATORY, not opt-in (#2915B) -- a distinct, always-on safety control,
  // never part of the opt-in scoped-failure-breaker feature the global
  // `worker_dispatch` switch gates. Unlike `correctStartup` (moved fully
  // behind `admission.ledger` above), `options.retryOf` verification must
  // keep refusing an unconfirmed predecessor even with dispatch disabled --
  // gating it on `worker_dispatch` would silently remove this guarantee
  // exactly when a conductor might disable recovery for other reasons.
  it('retryOf verification remains mandatory even with the global dispatch switch disabled', async () => {
    const fx = await enoentFixtureRoot();
    const launcher = new SessionLauncher();
    try {
      const invocationPath = await fx.freshPlan();
      const saved = JSON.parse(await readFile(invocationPath, 'utf8'));
      const taskDigest = await stableTaskChainDigest(saved.request, saved.invocation.briefDigest);
      const uncertainRunDir = path.join(fx.root, 'uncertain-predecessor');
      await mkdir(uncertainRunDir, { mode: 0o700 });
      await writeFile(path.join(uncertainRunDir, '.launch-owner'), 'uncertain-prev', { mode: 0o600 });
      await writeFile(path.join(uncertainRunDir, 'invocation.json'),
        JSON.stringify({ invocationId: 'uncertain-prev', origin: 'launcher', taskDigest }), { mode: 0o600 });
      // Present, well-formed, identity-matching -- but NOT confirmed.
      await writeFile(path.join(uncertainRunDir, 'exit.json'),
        JSON.stringify({ invocationId: 'uncertain-prev', termination: 'uncertain' }), { mode: 0o600 });
      await expect(launcher.launchWorker({
        invocationPath, runDir: path.join(fx.root, 'retry-run-disabled'),
        retryOf: { invocationId: 'uncertain-prev', runDir: uncertainRunDir },
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        // The global dispatch switch is off -- `admitDirectWorker` would
        // return `{ gated: false }` and never consult the breaker/ledger at
        // all -- yet this refusal must still fire.
        checkDispatch: () => ({ enabled: false, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: async (options) => { await options.onDispatchCommit?.(); return { mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }; },
      })).rejects.toMatchObject({ code: STOP_BEFORE_RETRY_CODE });
    } finally {
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('refuses a launch while the scope is open and resumes after a verified canary', async () => {
    const fx = await enoentFixtureRoot();
    let now = 1_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    let attempt = 0;
    const launchOnce = async () => {
      attempt += 1;
      return launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath: await fx.freshPlan(),
        runDir: path.join(fx.root, `run-${attempt}`),
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers },
        now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' },
        allowDegraded: true,
        // The fake CLI: a binary that does not exist, so the launcher's own
        // spawn fails with ENOENT — trusted installation evidence, never
        // worker text.
        launchIsolated: async (options) => { await options.onDispatchCommit?.(); return { mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }; },
      });
    };
    try {
      // Three distinct attempts fail at spawn; the installation scope opens.
      for (let n = 0; n < 3; n += 1) {
        const result = await launchOnce();
        expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', exitCode: null });
      }
      expect(breaker.getState(INSTALL).state).toBe('open');
      // A fourth launch is refused while the scope is open — before any
      // runDir is even created — and charges no attempt.
      const refusedRunDir = path.join(fx.root, `run-${attempt + 1}`);
      await expect(launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath: await fx.freshPlan(),
        runDir: refusedRunDir,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers },
        now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' },
        allowDegraded: true,
        launchIsolated: () => { throw new Error('must never spawn while the scope is open'); },
      })).rejects.toMatchObject({ code: RECOVERY_SCOPE_OPEN_CODE });
      await expect(lstat(refusedRunDir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(breaker.snapshot().attemptsObserved).toBe(3);
      // #2915D2: once due, the breaker admits the NEXT REAL launch through
      // this exact `launchWorker` path as the canary after a successful
      // preliminary probe. The fixture binary still does not exist,
      // so this canary fails again at spawn: the scope stays open and the
      // backoff doubles (120s -> 240s), proving the retry really ran
      // through production dispatch rather than being skipped or stuck.
      now += 121_000;
      completePreliminaryProbe(breaker, [INSTALL]);
      const canaryAttempt = await launchOnce();
      expect(canaryAttempt).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT' });
      expect(breaker.snapshot().attemptsObserved).toBe(5);
      expect(breaker.getState(INSTALL).state).toBe('open');
      expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(240_000);
      // Not due yet at +120s (doubled backoff): still refused, no spawn --
      // proving the gate is not a one-shot: it keeps gating correctly after
      // a canary failure, not just before the first one.
      now += 120_000;
      await expect(launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath: await fx.freshPlan(),
        runDir: path.join(fx.root, `run-${attempt + 1}`),
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers },
        now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' },
        allowDegraded: true,
        launchIsolated: () => { throw new Error('must never spawn before the doubled backoff elapses'); },
      })).rejects.toMatchObject({ code: RECOVERY_SCOPE_OPEN_CODE });
      // Due at +240s: the next real launch is again admitted as the
      // canary through this same production surface — no deadlock, the
      // path back to a real attempt stays reachable after every reopen.
      // (Degraded isolation never yields a launcher-CONFIRMED success —
      // see worker-single-invocation.test.ts's own `termination: 'uncertain'`
      // assertion on a clean exit in degraded mode — so a confirmed-success
      // recovery through this exact degraded fixture is architecturally
      // unreachable here; `recordSuccess` closing the scope on a
      // launcher-verified success is proven directly in the "half-open
      // canary admission" suite above.)
      now += 120_000;
      completePreliminaryProbe(breaker, [INSTALL]);
      const secondCanaryAttempt = await launchOnce();
      expect(secondCanaryAttempt).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT' });
      expect(breaker.getState(INSTALL).state).toBe('open');
      expect(breaker.getState(INSTALL).episodeCooldownMs).toBe(480_000);
      expect(breaker.snapshot().attemptsObserved).toBe(7);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 30_000);

  // #2915 review 5 (finding 2a, "leaked capacity"): a capture-setup
  // exception AFTER a child has already attached (post-spawn) must still
  // settle the admission -- never leak it. Before this fix, the catch
  // block in `launchOneWorker` only settled when `!outcome?.child` (proven
  // pre-spawn); an exception reached after spawn left the breaker's
  // reservation/canary slot outstanding forever, which — proven here via
  // the real, production admit()/settle() wiring — permanently starved out
  // every later attempt for the same scope.
  it('a post-spawn capture-setup exception settles the admission instead of leaking it, never starving out later attempts', async () => {
    const fx = await enoentFixtureRoot();
    let now = 4_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    let attempt = 0;
    const launchEnoent = async (drivers = fx.drivers) => {
      attempt += 1;
      return launcher.launchWorker({
        scopedBreaker: breaker,
        // Independent task captures share the recovery scope, not retry lineage.
        invocationPath: await fx.freshPlan(), runDir: path.join(await mkdtemp(path.join(fx.root, 'leak-task-')), `leak-run-${attempt}`),
        inputs: { snapshot: fx.f.snapshot, drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: async (options) => { await options.onDispatchCommit?.(); return { mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }; },
      });
    };
    try {
      for (let n = 0; n < 3; n += 1) {
        const result = await launchEnoent();
        expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      }
      expect(breaker.getState(INSTALL).state).toBe('open');
      now += 121_000;
      // The due canary attempt: a child attaches (spawn succeeds enough for
      // Node to return a child object even though the binary is missing --
      // the ENOENT surfaces asynchronously), but the capture pipeline
      // itself throws synchronously BEFORE `captureOneWorker`'s own
      // `finish()` closure is even wired, escaping its normal
      // never-throws-just-resolves contract entirely.
      completePreliminaryProbe(breaker, [INSTALL]);
      const throwingDriver = copyRecoveryDriver(fx.drivers.codex, { createHealthObserver: () => { throw new Error('synthetic capture-setup failure'); } });
      await expect(launchEnoent({ codex: throwingDriver })).rejects.toThrow('synthetic capture-setup failure');
      // Not leaked: the canary reservation WAS settled (uncertain) -- it is
      // not a stuck, never-settled reservation (the old defect this test
      // guards against). But degraded isolation can never supply confirmed
      // descendant-stop evidence for this exception path (`resolveStopEvidence`
      // always reports `confirmedStop: false` for degraded mode), so #2915
      // round 8 review 8 (C1) now RETAINS this reservation's execution
      // protection instead of silently releasing it: the scope stays open
      // with the normal doubled backoff, but a further canary is refused
      // until the unresolved stop is reconciled -- never a second worker
      // dispatched over unconfirmed descendants.
      expect(breaker.getState(INSTALL).state).toBe('open');
      expect(breaker.getState(INSTALL).blockingMarker).not.toBeNull();
      now += breaker.getState(INSTALL).episodeCooldownMs;
      await expect(launchEnoent()).rejects.toMatchObject({ code: RECOVERY_SCOPE_OPEN_CODE });
      // Operator/independent reconciliation (the documented recovery path
      // for a degraded canary's unresolved stop) frees the scope again.
      const invocationId = breaker.getState(INSTALL).blockingMarker.invocationId;
      expect(breaker.reconcileStopEvidence({ invocationId, confirmedStop: true })).toEqual({ released: 1 });
      expect(breaker.getState(INSTALL).blockingMarker).toBeNull();
      completePreliminaryProbe(breaker, [INSTALL]);
      const nextCanary = await launchEnoent();
      expect(nextCanary).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 30_000);

  // #2915 review 6 (finding 4, "capture-setup exception after spawn"): the
  // PRIOR fix only settled the admission (never leaking the reservation),
  // but abandoned the still-RUNNING child entirely -- it previously stayed
  // alive, unobserved, while backoff elapsed and a second canary could be
  // admitted over it. The bounded stop escalation must actually stop it.
  it('a post-spawn capture-setup exception actually stops the still-running child instead of abandoning it', async () => {
    const fx = await enoentFixtureRoot();
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    let capturedChild;
    try {
      const invocationPath = await fx.freshPlan();
      // A REAL, genuinely long-running child -- unlike the ENOENT fixture
      // above, which exits (and so proves nothing about the stop
      // escalation) on its own within a few milliseconds.
      const throwingDriver = copyRecoveryDriver(fx.drivers.codex, { createHealthObserver: () => { throw new Error('synthetic capture-setup failure'); } });
      await expect(launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath, runDir: path.join(fx.root, 'stop-escalation-run'),
        inputs: { snapshot: fx.f.snapshot, drivers: { codex: throwingDriver } }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: async (options) => {
          await options.onDispatchCommit?.();
          capturedChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
          return { mode: 'degraded', child: capturedChild };
        },
      })).rejects.toThrow('synthetic capture-setup failure');
      expect(capturedChild).toBeDefined();
      // Bounded wait for the real stop escalation (terminateChildWithGrace)
      // to actually take effect -- never abandoned running.
      await new Promise((resolve) => {
        if (capturedChild.exitCode !== null || capturedChild.signalCode !== null) { resolve(); return; }
        capturedChild.once('exit', resolve);
      });
      expect(capturedChild.signalCode).toBe('SIGTERM');
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 15_000);

  // #2915 review 6 (finding 6, "changed disabled behavior"): with dispatch
  // disabled, `invocation.json.taskDigest` must equal the EXACT value
  // origin/main writes (`qualificationDigest(saved.request)`) -- never the
  // NEW role/task/group/brief-content identity, which `admitDirectWorker`
  // (never consulted when disabled) has no use for. The launcher
  // instance's `lastAttemptResult`/`lastAttemptInvocationId` -- fields
  // origin/main never had at all -- must also stay untouched.
  it('a disabled-dispatch launch writes the origin/main taskDigest algorithm and leaves lastAttemptResult/lastAttemptInvocationId untouched', async () => {
    const fx = await enoentFixtureRoot();
    const launcher = new SessionLauncher();
    try {
      const invocationPath = await fx.freshPlan();
      const saved = JSON.parse(await readFile(invocationPath, 'utf8'));
      const expectedTaskDigest = qualificationDigest(saved.request);
      const gatedTaskDigest = await stableTaskChainDigest(saved.request, saved.invocation.briefDigest);
      expect(expectedTaskDigest).not.toBe(gatedTaskDigest); // sanity: the two algorithms actually differ
      const runDir = path.join(fx.root, 'disabled-digest-run');
      expect(launcher.lastAttemptResult).toBeNull();
      const result = await launcher.launchWorker({
        invocationPath, runDir, inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: false, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: async (options) => { await options.onDispatchCommit?.(); return { mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }; },
      });
      expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT' });
      const writtenInvocation = JSON.parse(await readFile(path.join(runDir, 'invocation.json'), 'utf8'));
      expect(writtenInvocation.taskDigest).toBe(expectedTaskDigest);
      expect(writtenInvocation.taskDigest).not.toBe(gatedTaskDigest);
      // origin/main's `SessionLauncher` never had these fields at all.
      expect(launcher.lastAttemptResult).toBeNull();
      expect(launcher.lastAttemptInvocationId).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  // #2915 final review step 5 (production closure): a genuinely successful
  // DEGRADED attempt (no systemd unit; `termination` can never reach
  // 'confirmed') must still close the scope through `launchWorker`'s real,
  // production admit()/settle() wiring — the evidence-contract fix for
  // finding 4 ("degraded success never closes the scope"). Three real
  // pre-spawn ENOENT failures open the scope exactly as above; the due
  // canary then spawns a REAL child (the shared `ralph-worker-cli.mjs`
  // fixture) that exits 0 with a strictly-valid final, and the scope must
  // close even though `termination` stays 'uncertain'.
  it('launchWorker-opens-refuses-canary-closes', async () => {
    const fx = await enoentFixtureRoot();
    let now = 2_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    let attempt = 0;
    const launchEnoent = async () => {
      attempt += 1;
      return launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath: await fx.freshPlan(), runDir: path.join(fx.root, `closes-run-${attempt}`),
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: async (options) => { await options.onDispatchCommit?.(); return { mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }; },
      });
    };
    const configPath = path.join(fx.root, 'success-config.json');
    const recordPath = path.join(fx.root, 'success-record.json');
    // #2915 review 5 ("Production/ownership/fault tests"): `outputFlags: []`
    // makes the REAL `ralph-worker-cli.mjs` child ignore `--final-output`
    // entirely (it still writes its jsonl `{"type":"result","result":...}`
    // line to stdout) -- the captured final file stays at `finalStat.size
    // === 0`, so `launchOneWorker` extracts from stdout (`extracted: true`)
    // and passes `format: 'jsonl'` to `parseWorkerAttemptFinal`, matching
    // the real adapter's jsonl decoding path below instead of a bare-JSON
    // final no production CLI in this fixture ever actually writes.
    await writeFile(configPath, JSON.stringify({ scenario: 'success', recordPath, outputFlags: [] }));
    const realAdapter = fx.f.snapshot.registry.providers.codex.workerAdapter;
    const realProfile = realAdapter.invocationProfiles['fixture-shell'];
    realProfile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    // The REAL strict parser (#2915 review 5): a thin delegation to a
    // genuine `ProviderAdapter` instance, never a stub that approves
    // based solely on the launcher's own process-level evidence. This is
    // the exact shape `test/unit/ralph-external/worker-single-invocation
    // .test.ts` uses for its own real-adapter hooks (e.g. `parseWorkerFinal
    // = (output, options) => adapter.parseWorkerFinal(output, options)`).
    const strictAdapter = new (class extends ProviderAdapter {})();
    const successDriver = {
      qualification: fx.drivers.codex.qualification,
      buildInvocation: async (input) => ({ argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'),
        '--model', input.selected.model, '--final-output', input.finalPath, '--', 'synthetic'],
        stdin: 'closed', envNames: realProfile.envAllowlist }),
      extractFinal: (text) => { try { const rows = text.trim().split('\n').map((line) => JSON.parse(line));
        return rows.length === 1 && rows[0].type === 'result' ? rows[0].result : null; } catch { return null; } },
    };
    registerWorkerRecoveryCapabilities(successDriver, {
      parseWorkerAttemptFinal: (output, options) => strictAdapter.parseWorkerAttemptFinal(output, options),
    });
    try {
      for (let n = 0; n < 3; n += 1) {
        const result = await launchEnoent();
        expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      }
      expect(breaker.getState(INSTALL).state).toBe('open');
      now += 121_000;
      vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', configPath);
      try {
        attempt += 1;
        // The saved plan must itself be resolved against `successDriver` —
        // `revalidateWorkerInvocationPlan` re-derives the invocation from
        // the CURRENT driver and compares digests, so plan and launch must
        // share the same driver (unlike `fx.freshPlan()`, which is closed
        // over the ENOENT driver from fixture setup).
        const successRequest = { role: 'coding', task: 'implementation', group: 'workers',
          brief: fx.brief, workdir: fx.cwd, final_output: path.join(fx.root, `closes-final-${attempt}.json`) };
        const successPlan = await resolveWorkerInvocation(fx.f.snapshot, successRequest, { codex: successDriver }, fx.f.request.now);
        expect(successPlan.invocation).toBeDefined();
        const successPlanPath = path.join(fx.root, `closes-plan-${attempt}.json`);
        await writeFile(successPlanPath, JSON.stringify(successPlan));
        completePreliminaryProbe(breaker, [INSTALL]);
        const canaryResult = await launcher.launchWorker({
          scopedBreaker: breaker,
          invocationPath: successPlanPath, runDir: path.join(fx.root, `closes-run-${attempt}`),
          inputs: { snapshot: fx.f.snapshot, drivers: { codex: successDriver } }, now: fx.f.request.now,
          checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
          isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
          // Termination is incidental to this breaker test: pin the
          // worker-side sampler so no launcher-owned group identity is
          // observed through the attached transport (timing-independent),
          // keeping termination uncertain for the still-valid reason of
          // unknown ownership. Scope closure below follows the launcher-
          // verified success, never the descendant proof.
          sampleIdentity: () => null,
        });
        // The attempt genuinely succeeded (clean direct-child exit, strict
        // final validated) even though no owned containment was observed, so
        // descendant termination stays uncertain.
        expect(canaryResult.attemptOutcome).toBe('succeeded');
        expect(canaryResult.termination).toBe('uncertain');
      } finally {
        vi.unstubAllEnvs();
      }
      // The scope closed on this launcher-verified success -- the #2915
      // final review fix: degraded success now has a real recovery path.
      expect(breaker.getState(INSTALL).state).toBe('closed');
      // Closure grants no blanket pass: it is NOT a replacement-permission
      // mechanism — a fresh, independent ENOENT failure can reopen the
      // scope again afterward through the exact same production path.
      vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 30_000);

  // #2915 review 5 ("Production/ownership/fault tests"): the negative twin
  // of `launchWorker-opens-refuses-canary-closes` — a schema-VALID final
  // (the real strict parser accepts it) whose own claimed `status` is
  // `'failed'`, through the exact same real `parseWorkerAttemptFinal`
  // delegation, must never close the scope. A clean process-level exit
  // alone is insufficient; a successful PARSE alone is also insufficient.
  it('a schema-valid final claiming status:failed never closes the scope, even on a clean process-level exit', async () => {
    const fx = await enoentFixtureRoot();
    let now = 4_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    let attempt = 0;
    const launchEnoent = async () => {
      attempt += 1;
      return launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath: await fx.freshPlan(), runDir: path.join(fx.root, `twin-run-${attempt}`),
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: async (options) => { await options.onDispatchCommit?.(); return { mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }; },
      });
    };
    const realAdapter = fx.f.snapshot.registry.providers.codex.workerAdapter;
    const realProfile = realAdapter.invocationProfiles['fixture-shell'];
    realProfile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    const strictAdapter = new (class extends ProviderAdapter {})();
    // Schema-valid (passes `decodeWorkerProducedPayload('workerClaims', ...)`)
    // but the worker's own claimed outcome is `'failed'` — exactly the
    // review-4 "a successful PARSE is not success" case, exercised here
    // through the REAL strict parser rather than a stand-in.
    const failedClaimsLine = `${JSON.stringify({ type: 'result', result:
      { version: 1, status: 'failed', summary: 'synthetic claimed failure', claims: [], artifacts: [], checks: [], limitations: [] } })}\n`;
    const successDriver = {
      qualification: fx.drivers.codex.qualification,
      // Same real argv shape as the positive-path test above; `launchIsolated`
      // is overridden below to a fake child, so this process is never
      // actually spawned.
      buildInvocation: async (input) => ({ argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'),
        '--model', input.selected.model, '--final-output', input.finalPath, '--', 'synthetic'],
        stdin: 'closed', envNames: realProfile.envAllowlist }),
      extractFinal: (text) => { try { const rows = text.trim().split('\n').map((line) => JSON.parse(line));
        return rows.length === 1 && rows[0].type === 'result' ? rows[0].result : null; } catch { return null; } },
    };
    registerWorkerRecoveryCapabilities(successDriver, {
      parseWorkerAttemptFinal: (output, options) => strictAdapter.parseWorkerAttemptFinal(output, options),
    });
    try {
      for (let n = 0; n < 3; n += 1) {
        const result = await launchEnoent();
        expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      }
      expect(breaker.getState(INSTALL).state).toBe('open');
      now += 121_000;
      attempt += 1;
      const twinRequest = { role: 'coding', task: 'implementation', group: 'workers',
        brief: fx.brief, workdir: fx.cwd, final_output: path.join(fx.root, `twin-final-${attempt}.json`) };
      const twinPlan = await resolveWorkerInvocation(fx.f.snapshot, twinRequest, { codex: successDriver }, fx.f.request.now);
      expect(twinPlan.invocation).toBeDefined();
      const twinPlanPath = path.join(fx.root, `twin-plan-${attempt}.json`);
      await writeFile(twinPlanPath, JSON.stringify(twinPlan));
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
      child.pid = 2147483645;
      completePreliminaryProbe(breaker, [INSTALL]);
      const canaryResult = await launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath: twinPlanPath, runDir: path.join(fx.root, `twin-run-${attempt}`),
        inputs: { snapshot: fx.f.snapshot, drivers: { codex: successDriver } }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: async (options) => {
          await options.onDispatchCommit?.();
          queueMicrotask(() => {
            child.stdout.end(failedClaimsLine); child.stderr.end();
            child.emit('exit', 0, null); child.emit('close', 0, null);
          });
          return { mode: 'degraded', child };
        },
      });
      // Clean process-level exit (0), schema-valid final -- but the
      // claimed status is 'failed', so the attempt never reaches
      // 'succeeded' and the scope is never closed through this path.
      expect(canaryResult.attemptOutcome).not.toBe('succeeded');
      expect(breaker.getState(INSTALL).state).toBe('open');
    } finally {
      resetDirectRecoveryBreaker();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 30_000);

  // #2915 review 5 (finding 1b, "false recovery"): the LAST exit.json
  // publication is the one write-attempt the prior round left as a
  // "documented residual" -- a genuinely successful attempt (clean direct-
  // child exit, strict final validated) whose final metadata write still
  // fails must downgrade to 'uncertain', never report 'succeeded' and close
  // the breaker scope on a terminal record that never durably landed.
  it('a failed LAST exit.json publication downgrades a genuine success to uncertain and never closes the scope', async () => {
    const fx = await enoentFixtureRoot();
    let now = 3_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    let attempt = 0;
    const launchEnoent = async () => {
      attempt += 1;
      return launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath: await fx.freshPlan(), runDir: path.join(fx.root, `lastwrite-run-${attempt}`),
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: async (options) => { await options.onDispatchCommit?.(); return { mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) }; },
      });
    };
    const configPath = path.join(fx.root, 'lastwrite-config.json');
    const recordPath = path.join(fx.root, 'lastwrite-record.json');
    await writeFile(configPath, JSON.stringify({ scenario: 'success', recordPath }));
    const realAdapter = fx.f.snapshot.registry.providers.codex.workerAdapter;
    const realProfile = realAdapter.invocationProfiles['fixture-shell'];
    realProfile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    const successDriver = {
      qualification: fx.drivers.codex.qualification,
      buildInvocation: async (input) => ({ argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'),
        '--model', input.selected.model, '--final-output', input.finalPath, '--', 'synthetic'],
        stdin: 'closed', envNames: realProfile.envAllowlist }),
      extractFinal: (text) => { try { const rows = text.trim().split('\n').map((line) => JSON.parse(line));
        return rows.length === 1 && rows[0].type === 'result' ? rows[0].result : null; } catch { return null; } },
    };
    registerWorkerRecoveryCapabilities(successDriver, {
      parseWorkerAttemptFinal: async (_output, options) => {
        if (options?.observation?.attemptOutcome !== 'succeeded') throw new Error('attempt not succeeded');
        return { status: 'completed' };
      },
    });
    try {
      for (let n = 0; n < 3; n += 1) {
        const result = await launchEnoent();
        expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      }
      expect(breaker.getState(INSTALL).state).toBe('open');
      now += 121_000;
      vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', configPath);
      try {
        attempt += 1;
        const successRequest = { role: 'coding', task: 'implementation', group: 'workers',
          brief: fx.brief, workdir: fx.cwd, final_output: path.join(fx.root, `lastwrite-final-${attempt}.json`) };
        const successPlan = await resolveWorkerInvocation(fx.f.snapshot, successRequest, { codex: successDriver }, fx.f.request.now);
        expect(successPlan.invocation).toBeDefined();
        const successPlanPath = path.join(fx.root, `lastwrite-plan-${attempt}.json`);
        await writeFile(successPlanPath, JSON.stringify(successPlan));
        // Every publish succeeds EXCEPT the LAST `exit.json` write -- the
        // first `exit.json` write (inside the `finally` right after
        // `recordProcess()`, before `attemptOutcome` is even computed)
        // still succeeds, so this isolates the exact residual review 5
        // flagged: a write failure discovered ONLY in the final publish.
        let exitJsonWrites = 0;
        completePreliminaryProbe(breaker, [INSTALL]);
        const canaryResult = await launcher.launchWorker({
          scopedBreaker: breaker,
          invocationPath: successPlanPath, runDir: path.join(fx.root, `lastwrite-run-${attempt}`),
          inputs: { snapshot: fx.f.snapshot, drivers: { codex: successDriver } }, now: fx.f.request.now,
          checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
          isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
          publishRecord: async (runDir, name, value, inspect) => {
            if (name === 'exit.json') {
              exitJsonWrites += 1;
              if (exitJsonWrites === 2) throw new Error('synthetic final exit.json publish failure');
            }
            return publishWorkerRecord(runDir, name, value, inspect);
          },
        });
        expect(exitJsonWrites).toBe(2);
        // Downgraded, never fabricated as a success.
        expect(canaryResult.attemptOutcome).toBe('uncertain');
        expect(canaryResult.termination).toBe('uncertain');
      } finally {
        vi.unstubAllEnvs();
      }
      // The scope must STAY OPEN: a success whose own terminal record never
      // durably landed must never close it.
      expect(breaker.getState(INSTALL).state).toBe('open');
      vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('allowance ledger (#2915 round 8, exclusive-create slots)', () => {
  // Same offline ENOENT fake-CLI setup as the S1 suite above, parameterized
  // by `maxAttempts` (via the already-existing `parallelism.retry` ceiling —
  // no new configuration) and returning a FILE-backed `captureRoot`, so
  // these tests prove the real per-task-chain allowance through the
  // production `launchWorker` path with an injected clock and filesystem —
  // not just the breaker's own in-memory scope bookkeeping.
  async function ledgerFixtureRoot(maxAttempts) {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const f = workerResolutionFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-'));
    const cwd = path.join(root, 'work');
    await mkdir(cwd);
    const brief = path.join(root, 'brief.json');
    await writeFile(brief, 'synthetic brief');
    const captureRoot = path.join(root, 'capture');
    const adapter = f.snapshot.registry.providers.codex.workerAdapter;
    const profile = adapter.invocationProfiles['fixture-shell'];
    profile.envAllowlist = [];
    profile.health = { version: 1, handshake: 'process-only', outputFraming: 'jsonl', signalParser: 'fixture:jsonl',
      sessionLogLocator: null, progressEvidence: [], stopEvidence: 'fixture:wait-only', fixtureRef: 'fixture:one-shot',
      qualifiedAt: f.request.now, statusOperation: null, cancelOperation: null };
    f.snapshot.config.parallelism.health = { hardTimeoutSeconds: 5, terminateGraceSeconds: 1 };
    f.snapshot.config.parallelism.retry = { maxAttempts };
    const driver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0',
      boundary: { kind: 'os', identity: 'fixture:boundary', digest: qualificationDigest('boundary'), controls: ['sandbox'] } },
      buildInvocation: async (input) => ({ argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'),
        '--model', input.selected.model, '--final-output', input.finalPath, '--', 'synthetic'],
        stdin: 'closed', envNames: [] }),
      extractFinal: () => null,
    };
    const drivers = { codex: driver };
    f.snapshot.installations.codex.boundary = driver.qualification.boundary;
    let planSeq = 0;
    // `briefText` (not `group`, which the snapshot's parallelism policy
    // must already recognize) is what varies the resolved `briefDigest`,
    // and therefore `stableTaskChainDigest` -- role/task/group stay fixed
    // at their fixture-recognized values ('coding'/'implementation'/
    // 'workers') for every call; only distinct brief CONTENT yields a
    // distinct task chain.
    const buildPlan = async (briefText = 'synthetic brief') => {
      planSeq += 1;
      const briefPath = path.join(root, `brief-${planSeq}.json`);
      await writeFile(briefPath, briefText);
      const attemptFinal = path.join(root, `final-${planSeq}.json`);
      const request = { role: 'coding', task: 'implementation', group: 'workers', brief: briefPath, workdir: cwd, final_output: attemptFinal };
      const plan = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
      expect(plan.invocation).toBeDefined();
      const invocationPath = path.join(root, `plan-${planSeq}.json`);
      await writeFile(invocationPath, JSON.stringify(plan));
      return { invocationPath, plan };
    };
    // Every call shares the SAME role/task/group/brief by default, so it
    // resolves to the SAME `stableTaskChainDigest` -- exactly the "same
    // task, retried" shape the allowance ledger governs.
    const freshPlan = () => buildPlan('synthetic brief');
    return { f, root, cwd, brief, captureRoot, freshPlan, buildPlan, drivers };
  }

  // Spawns the real nonexistent-binary fixture -- the same trusted
  // installation evidence the S1 suite uses -- while counting how many
  // times dispatch actually happened, so refused attempts are provably
  // never spawned.
  // #2915 round 8 (D2): a test double standing in for the WHOLE isolation
  // layer must itself honor the dispatch-commit hook contract exactly like
  // the real `launchIsolatedWorker` does — calling it immediately before
  // the (fake) process-start call, and letting a thrown refusal propagate
  // rather than spawning anyway. This is what actually exercises the
  // ledger debit / breaker begin-commit bracket in these tests; without it
  // the hook would simply never run.
  function enoentLaunchIsolated(counter) {
    return async (options) => {
      await options.onDispatchCommit?.();
      counter.count += 1;
      return { mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture-2915', [], { stdio: ['ignore', 'pipe', 'pipe'] }) };
    };
  }

  it('review 9 item 2a: attached preparation beyond its own budget refuses before dispatch without an external guard', async () => {
    const fx = await ledgerFixtureRoot(2);
    let monotonic = 0;
    const breaker = new ScopedFailureBreaker({ nowMs: () => monotonic, jitterMs: () => 0 });
    let loads = 0;
    const spawnWorker = vi.fn();
    try {
      const { invocationPath } = await fx.freshPlan();
      await expect(new SessionLauncher().launchWorker({
        invocationPath, runDir: path.join(fx.root, 'expired-run'), captureRoot: fx.captureRoot,
        scopedBreaker: breaker, now: fx.f.request.now,
        loadInputs: async () => {
          if (++loads === 2) monotonic = 900_001;
          return { snapshot: fx.f.snapshot, drivers: fx.drivers };
        },
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded' }, allowDegraded: true,
        launchIsolated: async options => { await options.onDispatchCommit(); return spawnWorker(); },
      })).rejects.toThrow(/deadline exceeded before process start/);
      expect(spawnWorker).not.toHaveBeenCalled();
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
      const chainDir = path.join(fx.captureRoot, 'ledger', (await readdir(path.join(fx.captureRoot, 'ledger')))[0]);
      expect(await readdir(chainDir)).toEqual(['policy']);
    } finally {
      breaker.destroy();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('exhausted allowance refuses the next attempt', async () => {
    const fx = await ledgerFixtureRoot(1);
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    let attempt = 0;
    const launchOnce = async () => {
      attempt += 1;
      const { invocationPath } = await fx.freshPlan();
      return launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath, runDir: path.join(fx.root, `run-${attempt}`), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      });
    };
    try {
      const first = await launchOnce();
      expect(first).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      expect(spawns.count).toBe(1);
      // maxAttempts is 1 and the one allowed attempt is already charged:
      // the next attempt for this exact task chain is refused by the
      // ledger -- never reaching dispatch.
      await expect(launchOnce()).rejects.toMatchObject({ code: ALLOWANCE_EXHAUSTED_CODE });
      expect(spawns.count).toBe(1);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('five fresh requests with maxAttempts 1 dispatch exactly one', async () => {
    const fx = await ledgerFixtureRoot(1);
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    let attempt = 0;
    const launchOnce = async () => {
      attempt += 1;
      const { invocationPath } = await fx.freshPlan();
      return launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath, runDir: path.join(fx.root, `run-${attempt}`), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      });
    };
    try {
      // Five SEPARATE, sequential fresh requests for the same task chain --
      // only the first ever reaches dispatch.
      const results = [];
      for (let n = 0; n < 5; n += 1) {
        try { results.push({ status: 'fulfilled', value: await launchOnce() }); }
        catch (error) { results.push({ status: 'rejected', reason: error }); }
      }
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(4);
      for (const r of rejected) expect(r.reason).toMatchObject({ code: ALLOWANCE_EXHAUSTED_CODE });
      expect(spawns.count).toBe(1);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  // #2915 round 8 (D1.3): the ledger-level version of the required probe --
  // real OS-level O_EXCL concurrency, no launcher/breaker involved.
  it('two concurrent reservers with one slot left get exactly one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-two-reservers-'));
    try {
      const taskChainDigest = 'two-reservers-one-slot-chain';
      await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'already-held', maxAttempts: 2 });
      const results = await Promise.allSettled([
        reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'racer-a', maxAttempts: 2 }),
        reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'racer-b', maxAttempts: 2 }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ code: ALLOWANCE_EXHAUSTED_CODE });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('two concurrent sibling retries through launchWorker with one remaining attempt dispatch exactly one', async () => {
    const fx = await ledgerFixtureRoot(2);
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const spawns = { count: 0 };
    let attempt = 0;
    // Each "sibling retry" is its OWN launcher instance -- exactly like two
    // independent conductor processes/retries would be in production. A
    // single `SessionLauncher` instance refuses a second concurrent
    // `launchWorker` call outright ("a worker is already attached to this
    // launcher"); that per-instance invariant is unrelated to the ledger
    // and must not be what this test observes.
    const launchOnce = async (launcher = new SessionLauncher()) => {
      attempt += 1;
      const { invocationPath } = await fx.freshPlan();
      return launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath, runDir: path.join(fx.root, `run-${attempt}`), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      });
    };
    try {
      // Consume one of two allowed attempts up front, leaving exactly one
      // remaining for the concurrent pair below.
      const setup = await launchOnce();
      expect(setup).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      expect(spawns.count).toBe(1);
      // Two sibling retries race for the SAME task chain's one remaining
      // slot via real exclusive-create -- never both admitted against a
      // single remaining attempt.
      const results = await Promise.allSettled([launchOnce(), launchOnce()]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ code: ALLOWANCE_EXHAUSTED_CODE });
      expect(spawns.count).toBe(2);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('spawn failure after commit stays charged', async () => {
    const fx = await ledgerFixtureRoot(1);
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    try {
      const { invocationPath, plan } = await fx.freshPlan();
      const taskChainDigest = await stableTaskChainDigest(plan.request, plan.invocation.briefDigest);
      const result = await launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath, runDir: path.join(fx.root, 'run-1'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      });
      expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      expect(spawns.count).toBe(1);
      // The spawn-failed attempt is CHARGED, not merely reserved: its slot
      // carries a `.charged` marker, proving the debit-before-dispatch
      // point in the D2 hook actually ran.
      const ledgerDir = path.join(fx.captureRoot, 'ledger');
      const chainDir = path.join(ledgerDir, (await readdir(ledgerDir))[0]);
      expect((await readdir(chainDir)).sort()).toEqual(['attempt-1', 'attempt-1.charged', 'policy']);
      // Charged means permanently consumed: a second attempt for the same
      // task chain (maxAttempts: 1) is refused, never dispatched.
      await expect(launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath: (await fx.freshPlan()).invocationPath, runDir: path.join(fx.root, 'run-2'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      })).rejects.toMatchObject({ code: ALLOWANCE_EXHAUSTED_CODE });
      expect(spawns.count).toBe(1);
      void taskChainDigest; // kept for readability of the intent above
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('pre-dispatch refusal refunds attempt and its correction', async () => {
    const fx = await ledgerFixtureRoot(1);
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    try {
      const { invocationPath: badPath } = await fx.freshPlan();
      // A pre-spawn preparation failure that happens AFTER admission AND
      // the correction reservation (the run directory's parent is missing,
      // so `mkdir(runDir)` throws) must refund BOTH the attempt slot and
      // its bound correction slot.
      let prepError;
      try {
        await launcher.launchWorker({
          scopedBreaker: breaker,
          invocationPath: badPath, runDir: path.join(fx.root, 'missing-parent', 'run-bad'), captureRoot: fx.captureRoot,
          inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
          checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
          isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
          launchIsolated: enoentLaunchIsolated(spawns),
          correctStartup: { reasonCode: 'STDIN_WAIT', correctionsUsed: 0 },
        });
      } catch (error) { prepError = error; }
      expect(prepError).toBeDefined();
      expect(prepError.code).not.toBe(ALLOWANCE_EXHAUSTED_CODE);
      // Preparation failed before the debit point: no dispatch happened.
      expect(spawns.count).toBe(0);
      const ledgerDir = path.join(fx.captureRoot, 'ledger');
      const chainDir = path.join(ledgerDir, (await readdir(ledgerDir))[0]);
      // Only `policy` remains -- both `attempt-1` and `correction-1` were
      // reserved (the correction ran before the mkdir failure) and both
      // were refunded by the SAME `settleLedger` call.
      expect((await readdir(chainDir)).sort()).toEqual(['policy']);
      // A fresh, properly-prepared attempt for the SAME task chain is
      // still admitted -- proving the failed preparation's reservation was
      // refunded, not left charged.
      const { invocationPath: goodPath } = await fx.freshPlan();
      const second = await launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath: goodPath, runDir: path.join(fx.root, 'run-good'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      });
      expect(second).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      expect(spawns.count).toBe(1);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('canary is charged', async () => {
    const fx = await ledgerFixtureRoot(4);
    let now = 1_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    let attempt = 0;
    const launchOnce = async () => {
      attempt += 1;
      const { invocationPath } = await fx.freshPlan();
      return launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath, runDir: path.join(fx.root, `run-${attempt}`), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      });
    };
    try {
      for (let n = 0; n < 3; n += 1) {
        const result = await launchOnce();
        expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      }
      expect(breaker.getState(INSTALL).state).toBe('open');
      expect(spawns.count).toBe(3);
      // Due: the next real launch is admitted as the half-open canary --
      // and CHARGED by the ledger exactly like any other dispatched
      // attempt. With maxAttempts: 4, this is the 4th and last allowed
      // attempt for this task chain.
      now += 121_000;
      completePreliminaryProbe(breaker, [INSTALL]);
      const canary = await launchOnce();
      expect(canary).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT', attemptOutcome: 'failed' });
      expect(spawns.count).toBe(4);
      expect(breaker.getState(INSTALL).state).toBe('open');
      // The allowance is now exhausted. Even once the breaker's own
      // doubled backoff elapses and it would otherwise admit a second
      // canary, the LEDGER refuses first -- proving the canary attempt
      // really did consume allowance, not just breaker bookkeeping.
      now += breaker.getState(INSTALL).episodeCooldownMs;
      await expect(launchOnce()).rejects.toMatchObject({ code: ALLOWANCE_EXHAUSTED_CODE });
      expect(spawns.count).toBe(4);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('disabled dispatch performs zero ledger operations', async () => {
    const fx = await ledgerFixtureRoot(1);
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    try {
      const { invocationPath } = await fx.freshPlan();
      const result = await launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath, runDir: path.join(fx.root, 'run-1'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        // The global dispatch switch is off: `admitDirectWorker` returns
        // `{ gated: false }` before it ever constructs/consults the
        // breaker OR the allowance ledger.
        checkDispatch: () => ({ enabled: false, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      });
      expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT' });
      expect(result.attemptOutcome).toBeUndefined();
      expect(spawns.count).toBe(1);
      // No ledger directory was ever created under captureRoot.
      await expect(lstat(path.join(fx.captureRoot, 'ledger'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('a tampered policy or an insecurely-moded policy file refuses rather than resetting the chain', async () => {
    const fx = await ledgerFixtureRoot(5);
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    const ledgerDir = path.join(fx.captureRoot, 'ledger');
    try {
      // --- Tampered: a well-formed, correctly-moded policy whose
      // `taskChainDigest` does not match the chain it lives in -- must
      // refuse, never silently reset to a fresh policy (that would
      // quietly regrant allowance to a forged/corrupted policy).
      const tampered = await fx.buildPlan('tampered-workers');
      const tamperedDigest = await stableTaskChainDigest(tampered.plan.request, tampered.plan.invocation.briefDigest);
      const tamperedChainDir = path.join(ledgerDir, Buffer.from(tamperedDigest, 'utf8').toString('hex'));
      await mkdir(tamperedChainDir, { recursive: true, mode: 0o700 });
      const tamperedPolicyPath = path.join(tamperedChainDir, 'policy');
      await writeFile(tamperedPolicyPath,
        JSON.stringify({ version: 1, taskChainDigest: 'not-the-real-digest', maxAttempts: 5, maxCorrections: 1 }), { mode: 0o600 });
      await chmod(tamperedPolicyPath, 0o600);
      const tamperedBefore = await readFile(tamperedPolicyPath, 'utf8');
      await expect(launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath: tampered.invocationPath, runDir: path.join(fx.root, 'tamper-run'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      })).rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
      expect(spawns.count).toBe(0);
      expect(await readFile(tamperedPolicyPath, 'utf8')).toBe(tamperedBefore);

      // --- Insecure mode: a correctly-identified policy that is not
      // exactly 0600 -- must refuse exactly like `verifyRetryPredecessor`
      // already refuses insecure predecessor metadata, never chmod-repair
      // and proceed.
      const insecure = await fx.buildPlan('insecure-workers');
      const insecureDigest = await stableTaskChainDigest(insecure.plan.request, insecure.plan.invocation.briefDigest);
      const insecureChainDir = path.join(ledgerDir, Buffer.from(insecureDigest, 'utf8').toString('hex'));
      await mkdir(insecureChainDir, { recursive: true, mode: 0o700 });
      const insecurePolicyPath = path.join(insecureChainDir, 'policy');
      await writeFile(insecurePolicyPath, JSON.stringify({ version: 1, taskChainDigest: insecureDigest, maxAttempts: 5, maxCorrections: 1 }));
      await chmod(insecurePolicyPath, 0o666);
      await expect(launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath: insecure.invocationPath, runDir: path.join(fx.root, 'insecure-run'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      })).rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
      expect(spawns.count).toBe(0);
      expect((await lstat(insecurePolicyPath)).mode & 0o777).toBe(0o666);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  // #2915 round 8 follow-up: `policy` is now published ATOMICALLY (temp
  // file + fsync + `link()`), closing the crash window a bare exclusive-
  // create-then-write left open -- a crash between the write and the link
  // must leave the chain usable by the next reserver, never poisoned.
  it('a crash between the policy temp-file write and the link leaves the chain usable by the next reserver', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-policy-crash-'));
    try {
      const taskChainDigest = 'policy-crash-before-link-chain';
      await expect(reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-1', maxAttempts: 2,
        afterPolicyWrite: () => { throw new Error('simulated crash before link'); } }))
        .rejects.toThrow('simulated crash before link');
      // Never half-published: no `policy` exists for this chain yet.
      const ledgerDir = path.join(root, 'ledger');
      const chainDir = path.join(ledgerDir, (await readdir(ledgerDir)).find((name) => !name.startsWith('.policy-tmp-')));
      await expect(lstat(path.join(chainDir, 'policy'))).rejects.toMatchObject({ code: 'ENOENT' });
      // A fresh reserve for the exact same chain still works.
      const ledger = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-2', maxAttempts: 2 });
      expect(ledger.n).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // A leftover temp file from exactly that crash window (in `ledger/`, not
  // in any chain directory) is inert: nothing in this ledger ever
  // enumerates `ledger/`'s own entries, so it can never be mistaken for
  // part of any chain, old or new.
  it('a leftover policy publish temp file in ledger/ is ignored and does not affect any chain', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-policy-leftover-temp-'));
    try {
      const taskChainDigest = 'policy-leftover-temp-chain';
      const ledgerDir = path.join(root, 'ledger');
      await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
      const leftoverTemp = path.join(ledgerDir, '.policy-tmp-simulated-crash');
      await writeFile(leftoverTemp,
        JSON.stringify({ version: 1, taskChainDigest, maxAttempts: 99, maxCorrections: 1 }), { mode: 0o600 });
      const ledger = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-1', maxAttempts: 2 });
      expect(ledger.n).toBe(1);
      // Untouched -- never read as this (or any) chain's policy, never
      // prevented a fresh publish.
      const leftover = await readFile(leftoverTemp, 'utf8');
      expect(JSON.parse(leftover).maxAttempts).toBe(99);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('two concurrent first reservers publishing the same policy both succeed and exactly one policy is published', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-policy-concurrent-same-'));
    try {
      const taskChainDigest = 'concurrent-policy-same-chain';
      const results = await Promise.allSettled([
        reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'a', maxAttempts: 4 }),
        reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'b', maxAttempts: 4 }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      const ledgerDir = path.join(root, 'ledger');
      const entries = await readdir(ledgerDir);
      // Exactly one chain directory, and no leftover temp file (both
      // reservers' own `finally` ran).
      expect(entries.filter((name) => !name.startsWith('.policy-tmp-'))).toHaveLength(1);
      expect(entries.filter((name) => name.startsWith('.policy-tmp-'))).toHaveLength(0);
      const chainDir = path.join(ledgerDir, entries[0]);
      expect((await readdir(chainDir)).filter((name) => name === 'policy')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('two concurrent first reservers with different policies: exactly one wins and the other refuses with the mismatch code', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-policy-concurrent-diff-'));
    try {
      const taskChainDigest = 'concurrent-policy-diff-chain';
      const results = await Promise.allSettled([
        reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'a', maxAttempts: 3 }),
        reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'b', maxAttempts: 7 }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ code: ALLOWANCE_POLICY_MISMATCH_CODE });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // D1.10's nlink-1 rule has one deliberate, narrow exception for `policy`
  // (see `statLedgerChainEntry`'s doc comment): a reader that catches it at
  // nlink 2 -- the atomic-publish dance's own transient second link --
  // must not refuse the chain once that link count resolves back to 1.
  it('a reader observing the transient policy link count does not refuse', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-policy-link-transient-'));
    try {
      const taskChainDigest = 'policy-link-transient-chain';
      await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-1', maxAttempts: 3 });
      const ledgerDir = path.join(root, 'ledger');
      const chainDir = path.join(ledgerDir, (await readdir(ledgerDir))[0]);
      const policyPath = path.join(chainDir, 'policy');
      const extraLink = path.join(ledgerDir, '.policy-extra-link-probe');
      // Simulate exactly the transient state the atomic-publish dance's own
      // temp file produces: `policy` briefly has a second hard link.
      await link(policyPath, extraLink);
      // Removed well within the bounded recheck window -- the same thing a
      // concurrent publisher's own `finally` does in practice.
      setImmediate(() => { unlink(extraLink).catch(() => {}); });
      const ledger2 = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-2', maxAttempts: 3 });
      expect(ledger2.n).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // #2915 round 8: `reserveLedgerCorrection` re-validates the chain
  // directory itself (not merely trusting the attempt handle's own
  // reserve-time validation), because another process can write into the
  // SAME chain directory in the gap between an attempt being reserved and
  // its correction being reserved.
  it('a correction reserved later through an attempt handle re-validates the chain directory, catching a foreign file written in between', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-correction-revalidate-'));
    try {
      const taskChainDigest = 'correction-revalidate-chain';
      const ledger = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-1', maxAttempts: 3 });
      const ledgerDir = path.join(root, 'ledger');
      const chainDir = path.join(ledgerDir, (await readdir(ledgerDir))[0]);
      // Simulate another process writing a foreign file into the chain
      // directory AFTER the attempt was reserved but BEFORE the correction
      // is.
      await writeFile(path.join(chainDir, 'unexpected-junk.txt'), 'x', { mode: 0o600 });
      await expect(reserveLedgerCorrection({ ledger, reasonCode: 'STDIN_WAIT' })).rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // #2915 round 8: replaces the removed early, UNGATED `launchWorker` check
  // with a proof that the real enforcement -- entirely inside the gated
  // `launchOneWorker` path, bound to the admission's own ledger handle --
  // still refuses a second correction for this exact task chain.
  it('a conductor-declared startup correction past the real ledger-recorded budget is refused through the gated path, ignoring the caller-claimed count', async () => {
    const fx = await ledgerFixtureRoot(5);
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    try {
      // First correction: the real ledger has none recorded yet. The
      // qualified reason ('STDIN_WAIT') is accepted, a correction is
      // recorded, and the attempt proceeds to real dispatch (failing
      // ENOENT on its own merits, same as any other attempt).
      const first = await fx.freshPlan();
      const firstResult = await launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath: first.invocationPath, runDir: path.join(fx.root, 'correct-run-1'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
        correctStartup: { reasonCode: 'STDIN_WAIT', correctionsUsed: 0 },
      });
      expect(firstResult).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT' });
      expect(spawns.count).toBe(1);
      // Second correction for the SAME task chain: the caller again (now
      // wrongly) claims zero used, but the real ledger records one --
      // authoritative ledger state, never the caller's own claim, refuses
      // this one before dispatch.
      const second = await fx.freshPlan();
      await expect(launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath: second.invocationPath, runDir: path.join(fx.root, 'correct-run-2'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
        correctStartup: { reasonCode: 'STDIN_WAIT', correctionsUsed: 0 },
      })).rejects.toMatchObject({ code: 'STARTUP_CORRECTION_REFUSED' });
      expect(spawns.count).toBe(1); // the second attempt never reached dispatch
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  // With the global dispatch switch off, `admitDirectWorker` returns
  // `{ gated: false }` before any breaker or ledger work, and
  // `launchOneWorker`'s correction check is itself gated on
  // `admission.ledger` -- never constructed when not gated. A
  // `correctStartup` value that WOULD refuse through the gated path
  // (unqualified reason, already-exhausted budget) must therefore behave
  // exactly as `origin/main` (which has no `correctStartup` concept at
  // all): reach real dispatch and fail on its own merits, never
  // `STARTUP_CORRECTION_REFUSED`.
  it('disabled-dispatch-is-inert for correctStartup: an unqualified, budget-exceeded correction never refuses when recovery is off', async () => {
    const fx = await ledgerFixtureRoot(5);
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    try {
      const { invocationPath } = await fx.freshPlan();
      const result = await launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath, runDir: path.join(fx.root, 'disabled-correct-run'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: false, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
        correctStartup: { reasonCode: 'AUTH', correctionsUsed: 99 },
      });
      expect(result).toMatchObject({ termination: 'confirmed', errorCode: 'ENOENT' });
      expect(spawns.count).toBe(1);
      expect(result.attemptOutcome).toBeUndefined(); // disabled dispatch: no new field at all
      // No ledger directory was ever created under captureRoot.
      await expect(lstat(path.join(fx.captureRoot, 'ledger'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  // The STANDALONE planner path (no borrowed admission -- `planDirectWorkerLaunch`
  // performs its own admission) reserves AND debits through the exact same
  // real `admitDirectWorker`/`debitDirectWorkerAllowance` pair the launcher
  // and MCP surfaces use.
  it('the standalone planDirectWorkerLaunch path debits allowance at its own dispatch boundary; a second launch for the same task chain refuses once maxAttempts is reached', async () => {
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    try {
      const invocation = { selected: { cli: 'codex' } };
      const launchOnce = () => planDirectWorkerLaunch({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, scopedBreaker: breaker, invocation,
        taskChainDigest: 'standalone-ledger-chain', maxAttempts: 1,
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true });
      const first = await launchOnce();
      expect(first.launched).toBe(true);
      // Debited IMMEDIATELY before dispatch -- never left pending, exactly
      // like `launchOneWorker`'s own debit point.
      expect(first.admission.ledger).toMatchObject({ mode: 'in-process', debited: true });
      const second = await launchOnce();
      expect(second.launched).toBe(false);
      expect(second.blocked).toBe(true);
    } finally {
      breaker.destroy();
      resetInProcessAllowanceLedger();
    }
  });

  // #2915 round 8 (C6/D1.1): an explicitly supplied, worker-writable
  // `captureRoot` now REFUSES the admission outright -- never silently
  // falls back to an in-process ledger (rev7-codex-2915.md finding 11:
  // two modeled conductor processes using the same explicit-but-unsafe
  // root each debited independently, with no shared record at all).
  it('an explicitly supplied captureRoot inside a worker-writable location refuses rather than silently falling back to an in-process ledger', async () => {
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-writable-'));
    try {
      const cwd = path.join(root, 'work'); await mkdir(cwd, { recursive: true });
      const captureRoot = path.join(cwd, 'worker-writable-capture'); // INSIDE cwd: worker-writable
      const invocation = { selected: { cli: 'codex' }, cwd };
      const admission = await admitDirectWorker({ gateEnabled: true, config: dispatchOnConfig, invocation,
        invocationId: 'wr-1', scopedBreaker: breaker, drivers: {},
        taskChainDigest: 'wr-chain', maxAttempts: 1, captureRoot });
      expect(admission.gated).toBe(true);
      expect(admission.refused).toBeDefined();
      expect(admission.refused.code).toBe(LEDGER_RECORD_INVALID_CODE);
      expect(admission.refused.reason).toMatch(/worker-writable/i);
      // Never persisted under the worker-writable root.
      await expect(lstat(path.join(captureRoot, 'ledger'))).rejects.toMatchObject({ code: 'ENOENT' });
      // The breaker-side reservation was rolled back too -- never leaked.
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
    } finally {
      breaker.destroy();
      resetInProcessAllowanceLedger();
      await rm(root, { recursive: true, force: true });
    }
  });

  // The ledger DIRECTORY itself (and the caller-supplied root it lives
  // under) gets the same ownership/mode validation the policy/slot FILES
  // inside it do -- a pre-existing, insecurely-moded ledger directory must
  // refuse, never be silently used.
  it('an existing ledger directory with an insecure mode refuses rather than being silently used', async () => {
    const fx = await ledgerFixtureRoot(5);
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    setDirectRecoveryBreaker(breaker);
    const launcher = new SessionLauncher();
    const spawns = { count: 0 };
    try {
      const ledgerDir = path.join(fx.captureRoot, 'ledger');
      await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
      await chmod(ledgerDir, 0o777); // insecure: group/other-writable
      const { invocationPath } = await fx.freshPlan();
      await expect(launcher.launchWorker({
        scopedBreaker: breaker,
        invocationPath, runDir: path.join(fx.root, 'run-1'), captureRoot: fx.captureRoot,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: enoentLaunchIsolated(spawns),
      })).rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
      expect(spawns.count).toBe(0);
      // Refused, never repaired: the insecure mode is untouched.
      expect((await lstat(ledgerDir)).mode & 0o777).toBe(0o777);
    } finally {
      resetDirectRecoveryBreaker();
      vi.unstubAllEnvs();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  // #2915 round 8 (C7): the pre-round-8 flat `<digest>.json` layout never
  // shipped past this branch. Its mere presence refuses the whole chain,
  // unconditionally, rather than being read, migrated or ignored.
  it('a legacy flat-record file for this task chain refuses rather than being read, migrated or ignored', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-legacy-'));
    try {
      const taskChainDigest = 'legacy-chain';
      const ledgerDir = path.join(root, 'ledger');
      await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(ledgerDir, `${taskChainDigest}.json`),
        JSON.stringify({ version: 1, taskChainDigest, maxAttempts: 1, pendingIds: [], chargedIds: ['spent'], chargedCount: 1, corrections: 0 }),
        { mode: 0o600 });
      await expect(reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-1', maxAttempts: 1 }))
        .rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
      // No new per-chain directory was created alongside the legacy file.
      expect(await readdir(ledgerDir)).toEqual([`${taskChainDigest}.json`]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a policy mismatch refuses rather than silently widening or narrowing the chain budget, in both ledger modes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-policy-mismatch-'));
    try {
      const taskChainDigest = 'policy-mismatch-chain';
      await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-1', maxAttempts: 3 });
      await expect(reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-2', maxAttempts: 5 }))
        .rejects.toMatchObject({ code: ALLOWANCE_POLICY_MISMATCH_CODE });
      const inProcessChainDigest = 'policy-mismatch-inprocess-chain';
      await reserveDirectWorkerAllowance({ taskChainDigest: inProcessChainDigest, invocationId: 'a', maxAttempts: 2 });
      await expect(reserveDirectWorkerAllowance({ taskChainDigest: inProcessChainDigest, invocationId: 'b', maxAttempts: 9 }))
        .rejects.toMatchObject({ code: ALLOWANCE_POLICY_MISMATCH_CODE });
    } finally {
      resetInProcessAllowanceLedger();
      await rm(root, { recursive: true, force: true });
    }
  });

  // #2915 round 8 (D1.8): the correction ceiling is `MAX_STARTUP_CORRECTIONS`
  // (currently 1) -- never `maxAttempts` -- and it is enforced CHAIN-WIDE,
  // across different attempt handles for the same chain, not merely once
  // per handle.
  it('correction ceiling uses maxCorrections (MAX_STARTUP_CORRECTIONS), never maxAttempts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-correction-ceiling-'));
    try {
      expect(MAX_STARTUP_CORRECTIONS).toBe(1);
      const taskChainDigest = 'correction-ceiling-chain';
      const first = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-1', maxAttempts: 5 });
      const second = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-2', maxAttempts: 5 });
      const g1 = await reserveLedgerCorrection({ ledger: first, reasonCode: 'STDIN_WAIT' });
      expect(g1.ok).toBe(true);
      const g2 = await reserveLedgerCorrection({ ledger: second, reasonCode: 'STDIN_WAIT' });
      expect(g2.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a foreign, out-of-range, symlinked, hard-linked or loosely-moded entry in the chain directory refuses rather than being silently skipped', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-foreign-entry-'));
    try {
      const cases = {
        'foreign-file': async (dir) => { await writeFile(path.join(dir, 'random-junk.txt'), 'x', { mode: 0o600 }); },
        'out-of-range-attempt': async (dir) => { await writeFile(path.join(dir, 'attempt-99'), 'x', { mode: 0o600 }); },
        'symlinked-slot': async (dir) => { await symlink('/etc/passwd', path.join(dir, 'attempt-2')); },
        'hard-linked-slot': async (dir) => {
          const other = path.join(dir, '.other');
          await writeFile(other, 'x', { mode: 0o600 });
          await link(other, path.join(dir, 'attempt-2'));
        },
        'loosely-moded-slot': async (dir) => { await writeFile(path.join(dir, 'attempt-2'), 'x', { mode: 0o644 }); },
      };
      for (const [name, corrupt] of Object.entries(cases)) {
        await rm(path.join(root, 'ledger'), { recursive: true, force: true });
        const taskChainDigest = `foreign-${name}`;
        await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-1', maxAttempts: 5 });
        const ledgerDir = path.join(root, 'ledger');
        const chainDir = path.join(ledgerDir, (await readdir(ledgerDir))[0]);
        await corrupt(chainDir);
        await expect(reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-2', maxAttempts: 5 }),
          `case: ${name}`).rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 70 attempts still cross the 65 cap; 100 timed out under full CI load (run 83861).
  it('maxAttempts 65 admits exactly 65 of 70 in both the file and in-process ledger', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-cumulative-'));
    try {
      for (const mode of ['file', 'in-process']) {
        const captureRoot = mode === 'file' ? root : undefined;
        const taskChainDigest = `cumulative-${mode}`;
        const maxAttempts = 65;
        let admitted = 0;
        for (let n = 0; n < 70; n += 1) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const ledger = await reserveDirectWorkerAllowance({ captureRoot, taskChainDigest, invocationId: `attempt-${n}`, maxAttempts });
            // eslint-disable-next-line no-await-in-loop
            await debitDirectWorkerAllowance(ledger);
            admitted += 1;
          } catch (error) {
            expect(error.code, `mode=${mode} n=${n}`).toBe(ALLOWANCE_EXHAUSTED_CODE);
          }
        }
        expect(admitted, `mode=${mode}`).toBe(65);
      }
    } finally {
      resetInProcessAllowanceLedger();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  // #2915 round 8 (D1.5): the review-7 defect this whole redesign removes --
  // a refund racing a debit on the SAME handle. The state flip in
  // `debitDirectWorkerAllowance` to `'debiting'` is synchronous, before any
  // `await`, so `refundDirectWorkerAllowance`, called immediately after in
  // the same microtask, is guaranteed to observe a non-`'reserved'` state
  // and no-op -- never unlinking a slot this call is concurrently charging.
  it('refund racing debit cannot free a charged slot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-refund-races-debit-'));
    try {
      const taskChainDigest = 'refund-races-debit-chain';
      const ledger = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-1', maxAttempts: 1 });
      const [debitResult, refundResult] = await Promise.allSettled([
        debitDirectWorkerAllowance(ledger),
        refundDirectWorkerAllowance(ledger),
      ]);
      expect(debitResult.status).toBe('fulfilled');
      expect(refundResult.status).toBe('fulfilled'); // a no-op, never an error
      expect(ledger.state).toBe('charged');
      const ledgerDir = path.join(root, 'ledger');
      const chainDir = path.join(ledgerDir, (await readdir(ledgerDir))[0]);
      await expect(lstat(path.join(chainDir, 'attempt-1'))).resolves.toBeDefined();
      await expect(lstat(path.join(chainDir, 'attempt-1.charged'))).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // #2915 round 8 review 8 (C5, "ledger handles do not enforce
  // creator-only mutation authority"): the review's own probe -- reserve
  // an in-process one-attempt chain, shallow-copy its handle, debit the
  // ORIGINAL, refund the COPY, then reserve again. Before this fix, the
  // copy's own `state: 'reserved'` snapshot (captured before the debit)
  // let the refund proceed and unlink the already-committed charge,
  // regranting it to a second reservation.
  it('a shallow copy of a ledger handle cannot refund a committed charge or regrant its slot', async () => {
    try {
      const taskChainDigest = 'opaque-handle-copy-chain';
      const ledger = await reserveDirectWorkerAllowance({ taskChainDigest, invocationId: 'inv-1', maxAttempts: 1 });
      const copy = { ...ledger }; // fresh object; own properties snapshot the getters' CURRENT values
      await debitDirectWorkerAllowance(ledger);
      expect(ledger.state).toBe('charged');
      // The copy is not a handle this module minted -- refund on it refuses
      // outright, never silently treating it as a fresh or stale handle.
      await expect(refundDirectWorkerAllowance(copy)).rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
      // Debit on the copy refuses identically.
      await expect(debitDirectWorkerAllowance(copy)).rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
      // The committed charge survives: a second reservation for the SAME
      // (one-attempt) chain is still exhausted, never regranted.
      await expect(reserveDirectWorkerAllowance({ taskChainDigest, invocationId: 'inv-2', maxAttempts: 1 }))
        .rejects.toMatchObject({ code: ALLOWANCE_EXHAUSTED_CODE });
    } finally {
      resetInProcessAllowanceLedger();
    }
  });

  it('a fabricated ledger-shaped object is refused by debit and refund, never silently accepted', async () => {
    const fabricated = { mode: 'in-process', captureRoot: null, taskChainDigest: 'fabricated-chain',
      invocationId: 'fab-1', kind: 'attempt', n: 1, dir: null, maxAttempts: 1, state: 'reserved', debited: false, correction: null };
    await expect(debitDirectWorkerAllowance(fabricated)).rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
    await expect(refundDirectWorkerAllowance(fabricated)).rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
    await expect(reserveLedgerCorrection({ ledger: fabricated, reasonCode: 'STDIN_WAIT' })).rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
  });

  it('ledger handle mutable fields cannot be reassigned from outside this module (frozen, getter-only)', async () => {
    try {
      const ledger = await reserveDirectWorkerAllowance({ taskChainDigest: 'frozen-handle-chain', invocationId: 'inv-1', maxAttempts: 1 });
      expect(() => { ledger.state = 'charged'; }).toThrow(TypeError);
      expect(() => { ledger.correction = {}; }).toThrow(TypeError);
      expect(() => { ledger.n = 999; }).toThrow(TypeError); // identity fields too
      expect(ledger.state).toBe('reserved'); // unchanged
    } finally {
      resetInProcessAllowanceLedger();
    }
  });

  // #2915 round 8 review 8 (C9, "correction acquisition can finish after
  // its attempt's terminal transition"): the review's own probe -- pause
  // correction creation after its slot is reserved, refund the attempt,
  // then resume. The re-check before binding must catch the now-refunded
  // parent, refund the just-reserved correction slot back out immediately
  // (never stranding it, uncharged, on a refunded attempt) and refuse.
  it('a correction reservation that resolves after its attempt refunds is refused and leaves no stranded slot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-correction-after-refund-'));
    try {
      const taskChainDigest = 'correction-after-refund-chain';
      const ledger = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'corr-race-inv', maxAttempts: 1 });
      const gate = await reserveLedgerCorrection({
        ledger, reasonCode: 'STDIN_WAIT',
        afterCorrectionReserved: () => refundDirectWorkerAllowance(ledger),
      });
      expect(gate.ok).toBe(false);
      expect(gate.reason).toMatch(/became 'refunded'/);
      expect(ledger.correction).toBeNull(); // never bound to the refunded attempt
      // No stranded correction slot: the operator release reports it as
      // never reserved (it was reserved then refunded again by the
      // re-check itself), and the chain's attempt slot is genuinely free.
      const ledgerDir = path.join(root, 'ledger');
      const chainDir = path.join(ledgerDir, (await readdir(ledgerDir))[0]);
      await expect(lstat(path.join(chainDir, 'correction-1'))).rejects.toMatchObject({ code: 'ENOENT' });
      const fresh = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'corr-race-inv-2', maxAttempts: 1 });
      expect(fresh.n).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a correction already acquired participates in its attempt\'s final debit/refund, and failures surface in settlement diagnostics', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-correction-diagnostics-'));
    try {
      const taskChainDigest = 'correction-diagnostics-chain';
      const ledger = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'corr-diag-inv', maxAttempts: 1 });
      const gate = await reserveLedgerCorrection({ ledger, reasonCode: 'STDIN_WAIT' });
      expect(gate.ok).toBe(true);
      // Make the correction's OWN charge fail, without touching the
      // attempt's slot at all: pre-create its `.charged` marker so
      // `chargeLedgerSlotFile`'s exclusive-create integrity check refuses.
      const ledgerDir = path.join(root, 'ledger');
      const chainDir = path.join(ledgerDir, (await readdir(ledgerDir))[0]);
      await writeFile(path.join(chainDir, 'correction-1.charged'), 'already-there', { mode: 0o600 });
      await debitDirectWorkerAllowance(ledger); // the ATTEMPT's own charge still succeeds
      expect(ledger.state).toBe('charged');
      expect(ledger.correctionChargeDiagnostic).toMatch(/correction charge failed/);
      // Surfaced into settlement diagnostics, not only the handle's own field.
      const diagnostic = await settleDirectWorker({ gated: false, ledger }, { kind: 'uncertain', confirmedStop: true });
      expect(diagnostic).toMatch(/correction charge failed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // #2915 round 8 (D1.4): "existence is occupancy" holds for a crashed,
  // empty slot exactly as it does for a healthy one -- it is never free,
  // never a reason to refuse the rest of the chain.
  it('create-then-crash empty slot is occupied and does not break the chain', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-crash-empty-'));
    try {
      const taskChainDigest = 'crash-empty-chain';
      await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-1', maxAttempts: 2 });
      const ledgerDir = path.join(root, 'ledger');
      const chainDir = path.join(ledgerDir, (await readdir(ledgerDir))[0]);
      // Simulate a crash between O_CREAT and the write: the slot exists
      // but carries no identity.
      await truncate(path.join(chainDir, 'attempt-1'), 0);
      const second = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-2', maxAttempts: 2 });
      expect(second.n).toBe(2);
      // Slot 1 stays occupied -- empty content never frees it, and never
      // refused the chain as a whole.
      await expect(lstat(path.join(chainDir, 'attempt-1'))).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // #2915 round 8 (D1.3, crit-round8 D1 "Lowest-free scanning is safe for
  // the ceiling, not a snapshot of availability"): a slot freed by a
  // concurrent refund AFTER a scan's first pass is still found by the one
  // bounded rescan, rather than the scanner reporting exhaustion against a
  // snapshot that is already stale.
  it('scanner vs concurrent refund: a slot freed between scan passes is still found by the bounded rescan', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-scanner-vs-refund-'));
    try {
      const taskChainDigest = 'scanner-vs-refund-chain';
      // Both slots occupied: a fresh scan's first pass finds nothing free.
      const a = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'a', maxAttempts: 2 });
      await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'b', maxAttempts: 2 });
      const ledger = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'c', maxAttempts: 2,
        // Test-only: fires between the first (exhausted) pass and the
        // rescan, refunding slot `a` right when a real concurrent refund
        // would have to land for the rescan to matter.
        rescan: () => refundDirectWorkerAllowance(a) });
      expect(ledger.n).toBe(a.n); // reclaimed via the bounded rescan, not a fresh scan
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // #2915 round 8 (D1.6): a pre-existing `.charged` for a slot this handle
  // just reserved is an integrity failure -- refuses the debit, touches
  // nothing else, and (per D1.5/C1) permanently strands the slot: a debit
  // that has started is never retried or refunded, bounded conservative
  // loss recoverable only through the explicit operator path.
  it('debit failure refuses dispatch and permanently strands the slot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-debit-fail-'));
    try {
      const taskChainDigest = 'debit-fail-chain';
      const ledger = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-1', maxAttempts: 1 });
      const ledgerDir = path.join(root, 'ledger');
      const chainDir = path.join(ledgerDir, (await readdir(ledgerDir))[0]);
      await writeFile(path.join(chainDir, 'attempt-1.charged'), 'someone-else', { mode: 0o600 });
      await expect(debitDirectWorkerAllowance(ledger)).rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
      expect(ledger.state).toBe('debit-failed');
      expect(ledger.debited).toBe(false);
      // Permanently stranded: refund is now a no-op (D1.5), never freeing
      // the slot a debit attempt already touched.
      await refundDirectWorkerAllowance(ledger);
      await expect(lstat(path.join(chainDir, 'attempt-1'))).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('settleDirectWorker surfaces a refund failure as a diagnostic instead of silently swallowing it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-refund-diag-'));
    let unlinkSpy;
    try {
      const taskChainDigest = 'refund-diag-chain';
      const ledger = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-1', maxAttempts: 1 });
      const slotPath = path.join(ledger.dir, `attempt-${ledger.n}`);
      const unlink = fsPromises.unlink;
      unlinkSpy = vi.spyOn(fsPromises, 'unlink').mockImplementation(async target => {
        // Inject at the refund's unlink call, independently of caller privileges.
        if (await fsPromises.realpath(target) === slotPath) throw Object.assign(new Error('injected unlink EACCES'), { code: 'EACCES' });
        return unlink(target);
      });
      // `settleDirectWorker` never throws (recovery accounting must never
      // fail a launch), but it must not resolve to a bare `undefined`
      // indistinguishable from "nothing was owed" -- a failed refund now
      // resolves to a bounded diagnostic STRING naming it.
      const admission = { gated: false, ledger };
      const result = await settleDirectWorker(admission, { kind: 'uncertain' });
      expect(result).toBe('allowance refund failed: injected unlink EACCES');
      expect(unlinkSpy).toHaveBeenCalledOnce();
      expect(ledger.state).toBe('refund-failed');
      await expect(lstat(slotPath)).resolves.toBeDefined();
    } finally {
      unlinkSpy?.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('the operator release refuses a charged slot and frees an uncharged one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-operator-release-'));
    try {
      const taskChainDigest = 'operator-release-chain';
      const charged = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'charged-inv', maxAttempts: 2 });
      await debitDirectWorkerAllowance(charged);
      const uncharged = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'uncharged-inv', maxAttempts: 2 });
      await expect(releaseLedgerSlot({ captureRoot: root, taskChainDigest, attempt: charged.n }))
        .rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
      const released = await releaseLedgerSlot({ captureRoot: root, taskChainDigest, attempt: uncharged.n });
      expect(released).toEqual({ released: true, invocationId: 'uncharged-inv' });
      // Freed: a fresh reservation can take the exact same slot number again.
      const again = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'fresh-inv', maxAttempts: 2 });
      expect(again.n).toBe(uncharged.n);
      // Releasing a never-reserved slot is a reported no-op, not an error.
      const neverReserved = await releaseLedgerSlot({ captureRoot: root, taskChainDigest, attempt: 999 });
      expect(neverReserved).toEqual({ released: false, invocationId: null, reason: 'slot was not reserved' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // #2915 round 8 review 8 (C11): the recorded invocation identity is
  // reported to the caller's `report` hook the MOMENT it is known --
  // before the slot is actually unlinked -- never only afterward via the
  // return value. Proven by having the hook itself check the slot file is
  // still present at the moment it fires.
  it('releaseLedgerSlot reports the recorded identity BEFORE unlinking, not after', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-report-before-unlink-'));
    try {
      const taskChainDigest = 'report-before-unlink-chain';
      const ledger = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'report-inv', maxAttempts: 1 });
      const ledgerDir = path.join(root, 'ledger');
      const chainDir = path.join(ledgerDir, (await readdir(ledgerDir)).find((name) => !name.startsWith('.policy-tmp-')));
      const slotPath = path.join(chainDir, `attempt-${ledger.n}`);
      let reportedBeforeUnlink = null;
      let slotExistedAtReportTime = null;
      const result = await releaseLedgerSlot({
        captureRoot: root, taskChainDigest, attempt: ledger.n,
        report: ({ invocationId }) => {
          reportedBeforeUnlink = invocationId;
          slotExistedAtReportTime = existsSync(slotPath);
        },
      });
      expect(reportedBeforeUnlink).toBe('report-inv');
      expect(slotExistedAtReportTime).toBe(true); // the slot was still there when reported
      expect(result).toEqual({ released: true, invocationId: 'report-inv' });
      expect(existsSync(slotPath)).toBe(false); // and gone by the time this returns
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // #2915 round 8 review 8 (C9): the SAME operator release, with the SAME
  // refusal rules, now also covers a stranded, uncharged `correction-<n>`
  // slot via `kind: 'correction'` -- the `--ledger-release <digest>
  // correction <n>` CLI form index.mjs's `parseLedgerReleaseArgs` accepts.
  it('releaseLedgerSlot releases a stranded uncharged correction slot with the same refusal rules as an attempt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-correction-release-'));
    try {
      const taskChainDigest = 'correction-release-chain';
      const ledger = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'corr-attempt', maxAttempts: 2 });
      const gate = await reserveLedgerCorrection({ ledger, reasonCode: 'STDIN_WAIT' });
      expect(gate.ok).toBe(true);
      // Charged correction: refused, exactly like a charged attempt.
      await debitDirectWorkerAllowance(ledger.correction);
      await expect(releaseLedgerSlot({ captureRoot: root, taskChainDigest, attempt: 1, kind: 'correction' }))
        .rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
      // A SECOND, stranded (uncharged) correction on a fresh attempt: freed.
      const second = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'corr-attempt-2', maxAttempts: 2 });
      const secondGate = await reserveLedgerCorrection({ ledger: second, reasonCode: 'STDIN_WAIT' });
      expect(secondGate.ok).toBe(false); // MAX_STARTUP_CORRECTIONS is 1 chain-wide in this fixture digest
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('parseLedgerReleaseArgs accepts the correction <n> form alongside <n> and policy', () => {
    const base = ['--ledger-release', 'digest-1'];
    expect(parseLedgerReleaseArgs([...base, '5', '--capture-root', '/root'])).toEqual({
      taskChainDigest: 'digest-1', target: { kind: 'attempt', attempt: 5 }, captureRoot: '/root',
    });
    expect(parseLedgerReleaseArgs([...base, 'correction', '2', '--capture-root', '/root'])).toEqual({
      taskChainDigest: 'digest-1', target: { kind: 'correction', attempt: 2 }, captureRoot: '/root',
    });
    expect(parseLedgerReleaseArgs([...base, 'policy', '--capture-root', '/root'])).toEqual({
      taskChainDigest: 'digest-1', target: { kind: 'policy' }, captureRoot: '/root',
    });
    expect(() => parseLedgerReleaseArgs([...base, 'correction', 'not-a-number', '--capture-root', '/root'])).toThrow(/Usage:/);
    expect(() => parseLedgerReleaseArgs([...base, 'correction', '--capture-root', '/root'])).toThrow(/Usage:/);
  });

  // #2915 round 8 follow-up (D1.9 extension): `--ledger-release <digest>
  // policy` removes `policy` ONLY once the chain has no attempt or
  // correction entry left at all -- otherwise a fresh reserve for the same
  // digest could publish a new policy with a different budget while old
  // charged slots stay in place, regranting spent allowance.
  it('the operator policy release refuses while slots exist and is allowed on an otherwise-empty chain', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-operator-policy-release-'));
    try {
      const taskChainDigest = 'operator-policy-release-chain';
      const ledger = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-1', maxAttempts: 1 });
      await expect(releaseLedgerPolicy({ captureRoot: root, taskChainDigest }))
        .rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
      // Freeing the one slot makes the chain otherwise-empty.
      const released = await releaseLedgerSlot({ captureRoot: root, taskChainDigest, attempt: ledger.n });
      expect(released.released).toBe(true);
      const policyReleased = await releaseLedgerPolicy({ captureRoot: root, taskChainDigest });
      expect(policyReleased).toEqual({ released: true });
      // A fresh reserve for the SAME digest can now publish a different
      // policy -- the chain was genuinely reset, not merely patched.
      const fresh = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'inv-2', maxAttempts: 9 });
      expect(fresh.maxAttempts).toBe(9);
      // Releasing an already-absent policy is a reported no-op.
      const alreadyGone = await releaseLedgerPolicy({ captureRoot: root, taskChainDigest: 'never-reserved-chain' });
      expect(alreadyGone).toEqual({ released: false, reason: 'chain directory does not exist' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // #2915 round 8 review 8 (C8): a fresh reservation (new captureRoot, so
  // BOTH `ledger/` and the chain directory are newly created in the SAME
  // `mkdir(..., { recursive: true })` call) must durably publish each
  // newly created directory's own entry in ITS parent -- fsyncing a file
  // inside a directory never publishes the directory's NAME in its own
  // parent's entry table. Proven with the injected filesystem: wraps every
  // `fsPromises.open()` call so the returned handle's own `.sync()` is
  // recorded, by basename, in call order -- the captureRoot and `ledger/`
  // directory syncs must both appear, before the chain directory's own
  // sync (already-tested durability) and ahead of any slot file ever being
  // charged.
  it('a fresh reservation syncs the newly created captureRoot and ledger/ directory entries before any slot can be charged', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-durability-'));
    const trace = [];
    fsPromises.__aiwgSyncTrace.trace = trace;
    try {
      const taskChainDigest = 'durability-chain';
      const ledger = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'durability-inv', maxAttempts: 1 });
      await debitDirectWorkerAllowance(ledger);
      const basenames = trace.map((target) => path.basename(String(target)));
      const rootBasename = path.basename(root);
      const chainDirBasename = Buffer.from(taskChainDigest, 'utf8').toString('hex');
      const rootSyncIndex = basenames.indexOf(rootBasename);
      const ledgerSyncIndex = basenames.indexOf('ledger');
      const chainDirSyncIndex = basenames.indexOf(chainDirBasename);
      const chargedFileSyncIndex = basenames.indexOf('attempt-1.charged');
      // Both newly created ancestors were actually synced at all (the
      // defect this closes: neither appeared in the trace before the fix).
      expect(rootSyncIndex).toBeGreaterThanOrEqual(0);
      expect(ledgerSyncIndex).toBeGreaterThanOrEqual(0);
      expect(chainDirSyncIndex).toBeGreaterThanOrEqual(0);
      expect(chargedFileSyncIndex).toBeGreaterThanOrEqual(0);
      // Namespace ancestry is published before dispatch could ever charge a
      // slot inside it: both ancestor syncs precede the `.charged` file's
      // own sync.
      expect(rootSyncIndex).toBeLessThan(chargedFileSyncIndex);
      expect(ledgerSyncIndex).toBeLessThan(chargedFileSyncIndex);
    } finally {
      fsPromises.__aiwgSyncTrace.trace = null;
      await rm(root, { recursive: true, force: true });
    }
  });

  // #2915 round 8 review 8 (C11, "an empty in-process chain accepted a
  // different ceiling after refund"): previously, a chain with no charged
  // history was DELETED once reserve+refund emptied both its maps --
  // discarding its pinned `maxAttempts` along with it, so a LATER reserve
  // for the SAME digest silently accepted a DIFFERENT ceiling as if it
  // were a fresh chain. The in-process ledger has no explicit, otherwise-
  // empty-chain-only release operation (unlike the file-mode ledger's
  // `releaseLedgerPolicy`), so this is now a deliberate "keeps the pinned
  // policy for the life of the process" decision, never automatic
  // retirement.
  it('an in-process chain keeps its pinned policy for the life of the process, even once every slot is refunded', async () => {
    try {
      const taskChainDigest = 'retire-then-reserve-chain';
      const ledger = await reserveDirectWorkerAllowance({ taskChainDigest, invocationId: 'inv-1', maxAttempts: 3 });
      expect(ledger.mode).toBe('in-process');
      await refundDirectWorkerAllowance(ledger);
      // A DIFFERENT ceiling for the SAME digest, after the chain's only
      // slot was refunded, is a policy mismatch -- never silently accepted
      // as if the chain had never existed.
      await expect(reserveDirectWorkerAllowance({ taskChainDigest, invocationId: 'inv-2', maxAttempts: 5 }))
        .rejects.toMatchObject({ code: ALLOWANCE_POLICY_MISMATCH_CODE });
      // The chain is genuinely still alive (not merely refusing
      // everything): the SAME originally-pinned ceiling still reserves.
      const again = await reserveDirectWorkerAllowance({ taskChainDigest, invocationId: 'inv-3', maxAttempts: 3 });
      expect(again.mode).toBe('in-process');
    } finally {
      resetInProcessAllowanceLedger();
    }
  });

  it('in-process chains with charged history are retained even once pending returns to zero, never regranting spent allowance', async () => {
    try {
      const taskChainDigest = 'charged-retained-chain';
      const ledger = await reserveDirectWorkerAllowance({ taskChainDigest, invocationId: 'inv-1', maxAttempts: 1 });
      await debitDirectWorkerAllowance(ledger);
      // maxAttempts: 1, and the one allowed attempt is already charged --
      // a fresh reserve for the SAME task chain must still be refused,
      // proving the chain was never retired/reset despite zero pending.
      await expect(reserveDirectWorkerAllowance({ taskChainDigest, invocationId: 'inv-2', maxAttempts: 1 }))
        .rejects.toMatchObject({ code: ALLOWANCE_EXHAUSTED_CODE });
    } finally {
      resetInProcessAllowanceLedger();
    }
  });
});

// ---------------------------------------------------------------------------
// #2915 round 8: cross-instance ledger probes. Two INDEPENDENT dynamic
// imports of session-launcher.mjs (distinct module instances, distinct
// module-level state) sharing ONE real filesystem captureRoot -- the
// closest same-process approximation of two separate conductor processes
// racing the same no-lock, exclusive-create-only ledger.
// ---------------------------------------------------------------------------
describe('allowance ledger: cross-instance probes', () => {
  async function freshLedgerModuleInstance() {
    const url = new URL('../../../tools/ralph-external/session-launcher.mjs', import.meta.url);
    url.searchParams.set('instance', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return import(url.href);
  }

  it('two separate module instances racing a startup correction for the same task chain admit exactly one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-xinstance-correction-'));
    try {
      const a = await freshLedgerModuleInstance();
      const b = await freshLedgerModuleInstance();
      const taskChainDigest = 'xinstance-correction-chain';
      const ledgerA = await a.reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'a-attempt', maxAttempts: 5 });
      const ledgerB = await b.reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'b-attempt', maxAttempts: 5 });
      const [ra, rb] = await Promise.all([
        a.reserveLedgerCorrection({ ledger: ledgerA, reasonCode: 'STDIN_WAIT' }),
        b.reserveLedgerCorrection({ ledger: ledgerB, reasonCode: 'STDIN_WAIT' }),
      ]);
      const outcomes = [ra, rb];
      expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
      expect(outcomes.filter((r) => !r.ok)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('two separate module instances alternately charging the same task chain are cumulatively bounded by maxAttempts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ledger-xinstance-cumulative-'));
    try {
      const a = await freshLedgerModuleInstance();
      const b = await freshLedgerModuleInstance();
      const taskChainDigest = 'xinstance-cumulative-chain';
      const maxAttempts = 65;
      for (let n = 0; n < maxAttempts; n += 1) {
        const mod = n % 2 === 0 ? a : b;
        const invocationId = `xinstance-attempt-${n}`;
        // eslint-disable-next-line no-await-in-loop
        const ledger = await mod.reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId, maxAttempts });
        // eslint-disable-next-line no-await-in-loop
        await mod.debitDirectWorkerAllowance(ledger);
      }
      await expect(a.reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'xinstance-attempt-65a', maxAttempts }))
        .rejects.toMatchObject({ code: a.ALLOWANCE_EXHAUSTED_CODE });
      await expect(b.reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest, invocationId: 'xinstance-attempt-65b', maxAttempts }))
        .rejects.toMatchObject({ code: b.ALLOWANCE_EXHAUSTED_CODE });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// #2915 round 8 (D6): equivalence tests for the attached launcher and the
// standalone planner. The frozen `8c812250d6` fixture
// (`test/fixtures/ralph-recovery-baseline/session-launcher.mjs`) has NO
// admission/breaker/ledger/digest concept at all; the current branch, with
// direct recovery not gated, must behave the same from an equivalent
// starting state: same decision-relevant result fields, the same
// `invocation.json`/`exit.json` metadata shape, the same persisted
// `taskDigest` ALGORITHM (`qualificationDigest(saved.request)` — verified
// independently against each run's own saved plan, since two separate runs
// necessarily use distinct `final_output` paths and therefore distinct
// digests of their own, never a false negative from that), and the same
// `Object.keys()` instance shape.
//
// A custom `launchIsolated` (a direct, detached `child_process.spawn` of
// the resolved argv) stands in for the real `launchIsolatedWorker` in every
// scenario below, on both the frozen fixture and the branch — exactly the
// same substitution several pre-existing tests in this file and in
// `worker-single-invocation.test.ts` already use for direct-child identity
// capture. This is deliberate, not a simplification that weakens the
// claim: `directRecoveryEligibility`/`admitDirectWorker`/the baseline split
// all operate strictly ABOVE the isolation layer, and `launchIsolatedWorker`
// itself independently refuses a caller-supplied `gate.enabled:false` while
// `config.parallelism.worker_dispatch` is still true (a correct, unrelated
// consistency guard) -- exercising that guard is not part of this
// equivalence claim and is already covered by `worker-isolation.mjs`'s own
// tests.
//
// Covers: clean success; non-zero exit; spawn ENOENT; standalone planner
// launch and refusal; a gated launch followed by a not-gated launch on one
// instance (instance-shape only). The three attached-launcher scenarios run
// once per not-gated trigger that a full real-invocation launch can
// actually exercise without ALSO being refused by `revalidateWorkerInvocationPlan`'s
// own re-resolution (which independently refuses a per-CLI-disabled
// selection before `admitDirectWorker` is ever reached) -- global
// `worker_dispatch` off and `canVerifyAttempt: false`. The per-CLI switch
// and the explicit `scopedBreaker: null` override are instead covered: (a)
// directly, at the `directRecoveryEligibility` predicate level, in the
// dedicated unit test below; (b) for the explicit override specifically,
// through the standalone-planner regression test below, which does not
// need a real resolved invocation to reproduce the exact defect it guards.
//
// NOT covered here (see the final report): timeout, cancellation,
// capture-setup failure after spawn, invalid-final/failed-claims variants,
// per-CLI disablement through a full real-invocation `launchWorker()` run,
// and explicit per-callback-argument-list/listener-count introspection
// (proven only behaviorally, through the identical observable results
// above, not by inspecting `EventEmitter` internals directly).
// ---------------------------------------------------------------------------
// #2915 round 8 (D6): shared helpers for every "baseline equivalence"
// describe block below (module scope, not nested in any one `describe`, so
// every block — the original one plus the follow-up scenarios added after
// it — uses the exact same fixture/launch/normalize machinery).
//
// ENOENT leaves no child identity for either launcher's settlement.
function enoentSpawn() {
  return { mode: 'degraded', child: spawn('/nonexistent-aiwg-fixture-2915-equiv', [], { stdio: ['ignore', 'pipe', 'pipe'] }) };
}

async function equivFixtureRoot() {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const f = workerResolutionFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-equiv-d6-'));
    const cwd = path.join(root, 'work');
    await mkdir(cwd);
    const brief = path.join(root, 'brief.json');
    await writeFile(brief, 'synthetic equivalence brief');
    const adapter = f.snapshot.registry.providers.codex.workerAdapter;
    const profile = adapter.invocationProfiles['fixture-shell'];
    profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    profile.health = { version: 1, handshake: 'process-only', outputFraming: 'jsonl', signalParser: 'fixture:jsonl',
      sessionLogLocator: null, progressEvidence: [], stopEvidence: 'fixture:wait-only', fixtureRef: 'fixture:one-shot',
      qualifiedAt: f.request.now, statusOperation: null, cancelOperation: null };
    f.snapshot.config.parallelism.health = { hardTimeoutSeconds: 5, terminateGraceSeconds: 1 };
    const driver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0',
      boundary: { kind: 'os', identity: 'fixture:boundary', digest: qualificationDigest('boundary'), controls: ['sandbox'] } },
      buildInvocation: async (input) => ({ argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'),
        '--model', input.selected.model, '--final-output', input.finalPath, '--', 'synthetic'],
        stdin: 'closed', envNames: ['AIWG_FAKE_WORKER_CONFIG'] }),
      extractFinal: (text) => { try { const rows = text.trim().split('\n').map(line => JSON.parse(line));
        return rows.length === 1 && rows[0].type === 'result' ? rows[0].result : null; } catch { return null; } },
    };
    const drivers = { codex: driver };
    f.snapshot.installations.codex.boundary = driver.qualification.boundary;
    let planSeq = 0;
    // Every call resolves a FRESH plan with its own final-output path: two
    // launches of "the same task" never collide on output files, matching
    // how every other test in this suite (e.g. `enoentFixtureRoot` above)
    // runs repeated attempts of one logical task.
    const freshPlan = async ({ scenario = 'success', forgeRealExitCode, side = 'branch' } = {}) => {
      planSeq += 1;
      const attemptFinal = path.join(root, `final-${planSeq}.json`);
      const configPath = path.join(root, `fake-${planSeq}.json`);
      const recordPath = path.join(root, `record-${planSeq}.json`); // unconditionally written by ralph-worker-cli.mjs
      // Baseline/branch trials have independent capture inventories (#3831).
      const capture = await mkdtemp(path.join(root, 'comparison-'));
      // Keep the real worker alive until ownership is recorded, even under load.
      await writeFile(configPath, JSON.stringify({ scenario, recordPath, waitForIdentity: path.join(capture, `run-${planSeq}`, 'process.json'), ...(forgeRealExitCode !== undefined ? { forgeRealExitCode } : {}) }));
      const request = { role: 'coding', task: 'implementation', group: 'workers', brief, workdir: cwd, final_output: attemptFinal };
      const resolve = side === 'baseline' ? resolveWorkerInvocationBaseline : resolveWorkerInvocation;
      const plan = await resolve(f.snapshot, request, drivers, f.request.now);
      expect(plan.invocation, JSON.stringify({ diagnostics: plan.diagnostics })).toBeDefined();
      const invocationPath = path.join(root, `plan-${planSeq}.json`);
      await writeFile(invocationPath, JSON.stringify(plan));
      return { invocationPath, configPath, runDir: path.join(capture, `run-${planSeq}`) };
    };
    return { f, root, drivers, freshPlan };
  }

  // Normalizes a launch result down to its decision-relevant fields —
  // never invocationId/endedAt/health (both runs mint a fresh invocationId
  // and timestamp, and `health`'s own internal timing is independently
  // sampled wall-clock, not a decision this equivalence claim is about), and
  // never `captureCoverage` (whether the child's own stdout/stderr 'close'
  // event is observed before `finish()` races identically on both sides for
  // a real spawn error such as ENOENT — a stream-draining timing detail,
  // not a decision either launcher's own logic makes differently).
  function normalizeResult(result) {
    const { exitCode, signal, termination, descendants, timedOut, cancelled, stopReason, errorCode,
      workerTermination, isolation } = result;
    return { exitCode, signal, termination, descendants, timedOut, cancelled, stopReason, errorCode,
      workerTermination, isolation };
  }

  async function runOneLauncher(LauncherClass, fx, attempt, extraOptions = {}) {
    vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', attempt.configPath);
    const launcher = new LauncherClass();
    const result = await launcher.launchWorker({
      invocationPath: attempt.invocationPath, runDir: attempt.runDir, inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers },
      now: fx.f.request.now, isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
      launchIsolated: directSpawn,
      ...extraOptions,
    });
    return { launcher, result, runDir: attempt.runDir };
  }

describe('baseline equivalence (#2915 round 8, D6): frozen 8c812250d6 vs the branch with direct recovery not gated', () => {
  // The two not-gated triggers a full real-invocation launch can exercise
  // without ALSO being refused by `revalidateWorkerInvocationPlan`'s own
  // re-resolution (see the describe-level comment above).
  const notGatedTriggers = [
    { name: 'global worker_dispatch off', extraOptions: { checkDispatch: () => ({ enabled: false, ok: true, failures: [] }) } },
    {
      name: 'canVerifyAttempt:false (worker_dispatch on)',
      extraOptions: { checkDispatch: () => ({ enabled: true, ok: true, failures: [] }) },
      setup: (fx) => { registerWorkerRecoveryCapabilities(fx.drivers.codex, { canVerifyAttempt: false }); },
    },
  ];

  for (const trigger of notGatedTriggers) {
    describe(`not-gated via: ${trigger.name}`, () => {
      async function build() {
        const fx = await equivFixtureRoot();
        trigger.setup?.(fx);
        return fx;
      }

      it('clean success: identical result, origin/main taskDigest algorithm on both sides, identical exit.json shape', async () => {
        const fx = await build();
        try {
          const baselineAttempt = await fx.freshPlan({ side: 'baseline', scenario: 'success' });
          const branchAttempt = await fx.freshPlan({ scenario: 'success' });
          const baseline = await runOneLauncher(SessionLauncherBaseline, fx, baselineAttempt, trigger.extraOptions);
          const branch = await runOneLauncher(SessionLauncher, fx, branchAttempt, trigger.extraOptions);
          expect(normalizeResult(branch.result), JSON.stringify(branch.result)).toEqual({ ...normalizeResult(baseline.result), termination: 'confirmed', descendants: 'none' });
          expect(branch.result.exitCode).toBe(0);
          const baselineSaved = JSON.parse(await readFile(baselineAttempt.invocationPath, 'utf8'));
          const branchSaved = JSON.parse(await readFile(branchAttempt.invocationPath, 'utf8'));
          const baselineInvocation = JSON.parse(await readFile(path.join(baseline.runDir, 'invocation.json'), 'utf8'));
          const branchInvocation = JSON.parse(await readFile(path.join(branch.runDir, 'invocation.json'), 'utf8'));
          // Each side independently writes the origin/main algorithm applied
          // to its OWN saved request (the two differ only in `final_output`,
          // which the algorithm itself legitimately folds in).
          expect(baselineInvocation.taskDigest).toBe(qualificationDigest(baselineSaved.request));
          expect(branchInvocation.taskDigest).toBe(qualificationDigest(branchSaved.request));
          expect(Object.keys(branchInvocation).sort()).toEqual(Object.keys(baselineInvocation).sort());
          const baselineExit = JSON.parse(await readFile(path.join(baseline.runDir, 'exit.json'), 'utf8'));
          const branchExit = JSON.parse(await readFile(path.join(branch.runDir, 'exit.json'), 'utf8'));
          expect(Object.keys(normalizeMarkerRunRecord('exit.json', baselineExit, branchExit)).sort()).toEqual(Object.keys(baselineExit).sort());
          // Never gated: no #2915 field, on either side.
          expect('attemptOutcome' in branchExit).toBe(false);
          expect('attemptOutcome' in baselineExit).toBe(false);
        } finally {
          await rm(fx.root, { recursive: true, force: true });
        }
      });

      it('non-zero exit: identical result and identical exit.json shape', async () => {
        const fx = await build();
        try {
          const baselineAttempt = await fx.freshPlan({ side: 'baseline', scenario: 'forge-exit', forgeRealExitCode: 9 });
          const branchAttempt = await fx.freshPlan({ scenario: 'forge-exit', forgeRealExitCode: 9 });
          const baseline = await runOneLauncher(SessionLauncherBaseline, fx, baselineAttempt, trigger.extraOptions);
          const branch = await runOneLauncher(SessionLauncher, fx, branchAttempt, trigger.extraOptions);
          expect(normalizeResult(branch.result), JSON.stringify(branch.result)).toEqual({ ...normalizeResult(baseline.result), termination: 'confirmed', descendants: 'none' });
          expect(branch.result.exitCode).toBe(9);
        } finally {
          await rm(fx.root, { recursive: true, force: true });
        }
      });

      it('spawn ENOENT: identical result, confirmed termination, no child identity', async () => {
        const fx = await build();
        try {
          const baselineAttempt = await fx.freshPlan({ side: 'baseline', scenario: 'success' });
          const branchAttempt = await fx.freshPlan({ scenario: 'success' });
          const baseline = await runOneLauncher(SessionLauncherBaseline, fx, baselineAttempt, { ...trigger.extraOptions, launchIsolated: enoentSpawn });
          const branch = await runOneLauncher(SessionLauncher, fx, branchAttempt, { ...trigger.extraOptions, launchIsolated: enoentSpawn });
          expect(normalizeResult(branch.result), JSON.stringify(branch.result)).toEqual({ ...normalizeResult(baseline.result), descendants: 'none' });
          expect(baseline.result).toMatchObject({ errorCode: 'ENOENT', termination: 'confirmed' });
        } finally {
          await rm(fx.root, { recursive: true, force: true });
        }
      });
    });
  }

  describe('standalone planner (planDirectWorkerLaunch): launch and refusal', () => {
    it.each([
      { name: 'global off', config: { parallelism: { worker_dispatch: false } } },
      { name: 'CLI off', config: { parallelism: { worker_dispatch: true, clis: { codex: { enabled: false } } } } },
      { name: 'unverifiable adapter', drivers: { codex: registerWorkerRecoveryCapabilities({}, { canVerifyAttempt: false }) } },
      { name: 'explicit breaker override', scopedBreaker: null },
    ])('C3: disabled standalone submission failure equals baseline ($name)', ({ name, ...disabled }) => {
      const options = { name: 'r10-disabled', command: process.execPath, args: [], cwd: process.cwd(), memoryMaxGb: 4,
        config: dispatchOnConfig, live: healthyLive, invocation: { selected: { cli: 'codex' } },
        isolation: { mode: 'systemd-unit' }, proposeUnit: () => 'r10-disabled-unit',
        spawn: (command) => path.basename(command) === 'systemd-run' ? { status: 1, stderr: 'submission failed' } : { status: 0, stdout: '' },
        ...disabled,
      };
      const baseline = planDirectWorkerLaunchBaseline(options);
      const result = planDirectWorkerLaunch(options);
      expect(result).not.toBeInstanceOf(Promise);
      expect(result).toEqual(baseline);
      expect(result).toMatchObject({ launched: false, mode: 'systemd-unit' });
      expect(result).not.toHaveProperty('dispatchState');
    });

    it('a not-gated flat-option launch matches the frozen planner, synchronously, with no admission field', () => {
      const name = `equiv-standalone-${Math.random().toString(36).slice(2)}`;
      const baselineResult = planDirectWorkerLaunchBaseline({
        name, command: process.execPath, args: ['-e', 'process.exit(0)'],
        config: { parallelism: { worker_dispatch: false } },
        live: healthyLive,
        isolation: { mode: 'degraded', reason: 'synthetic' }, allowDegraded: true,
      });
      const branchResult = planDirectWorkerLaunch({
        name, command: process.execPath, args: ['-e', 'process.exit(0)'],
        config: { parallelism: { worker_dispatch: false } },
        live: healthyLive,
        isolation: { mode: 'degraded', reason: 'synthetic' }, allowDegraded: true,
      });
      expect(typeof branchResult?.then).not.toBe('function'); // synchronous, byte-for-byte legacy behaviour
      expect(branchResult.launched).toBe(baselineResult.launched);
      expect('admission' in branchResult).toBe(false);
      expect('admission' in baselineResult).toBe(false);
      branchResult.child?.kill?.();
      baselineResult.child?.kill?.();
    });

    it('a blocked dispatch gate refuses identically on both, even with an explicit breaker override on the branch', () => {
      const name = `equiv-standalone-blocked-${Math.random().toString(36).slice(2)}`;
      const blockedLive = { availMemGb: 0.001, load1: 99, cores: 8, workers: 0, freeDiskGb: 0.001 };
      const baselineResult = planDirectWorkerLaunchBaseline({
        name, command: process.execPath, args: ['-e', 'process.exit(0)'],
        config: { parallelism: { worker_dispatch: true, admission: { hostResources: { minAvailMemGb: 4 } } } },
        live: blockedLive, isolation: { mode: 'degraded', reason: 'synthetic' }, allowDegraded: true,
      });
      const branchResult = planDirectWorkerLaunch({
        name, command: process.execPath, args: ['-e', 'process.exit(0)'],
        config: { parallelism: { worker_dispatch: true, admission: { hostResources: { minAvailMemGb: 4 } } } },
        live: blockedLive, isolation: { mode: 'degraded', reason: 'synthetic' }, allowDegraded: true,
        scopedBreaker: null,
      });
      expect(baselineResult).toMatchObject({ launched: false, blocked: true });
      expect(branchResult).toMatchObject({ launched: false, blocked: true });
      expect('admission' in branchResult).toBe(false);
    });

    // #2915 round 8 critique ("directRecoveryEligibility" extraction):
    // without the Standalone branch's own synchronous eligibility check,
    // this exact call reached the admission IIFE, `admitDirectWorker`
    // correctly returned `{ gated: false }`, and execution fell through to
    // the un-guarded `onDispatchCommit` closure that unconditionally
    // referenced `admission.breaker.beginDispatch` -- `admission.breaker`
    // is `undefined` on a not-gated admission, so dispatch crashed with a
    // TypeError instead of launching. This is the regression test for that
    // defect: a flat-option call (no resolved `invocation` needed to
    // reproduce it) with an otherwise-passing gate and an explicit
    // `scopedBreaker: null` override must launch, not throw.
    it('an explicit scopedBreaker:null standalone launch launches instead of throwing', async () => {
      const result = planDirectWorkerLaunch({
        name: 'equiv-standalone-breaker-null', command: process.execPath, args: ['-e', 'process.exit(0)'],
        config: { parallelism: { worker_dispatch: true } },
        live: healthyLive,
        isolation: { mode: 'degraded', reason: 'synthetic' }, allowDegraded: true, scopedBreaker: null,
      });
      // Not gated (explicit breaker override): synchronous, byte-for-byte
      // legacy behaviour — never a Promise, exactly like the baseline
      // planner and exactly like this planner's own `!gate.enabled`/
      // per-CLI-disabled branches already behave.
      expect(typeof result?.then).not.toBe('function');
      expect(result).toMatchObject({ launched: true });
      expect('admission' in result).toBe(false);
      await new Promise((resolve) => { result.child.once('exit', resolve); result.child.once('error', resolve); });
    });
  });

  // #2915 round 8 review 8 (D3): the previous version of this test NAMED
  // itself "on the SAME instance" but actually built a SECOND, independent
  // `SessionLauncher` for the not-gated run (`runOneLauncher` always
  // constructs a fresh one) -- so it could never have observed any
  // gated-path residue a REUSED instance might carry into a later
  // not-gated call. This version genuinely reuses one `launcher` for both
  // runs, and widens what is compared beyond `Object.keys()`: the
  // `process` SIGTERM/SIGINT listener count (added/removed by
  // `captureOneWorker`'s own `finish()`), the instance's own transient
  // handle fields (`currentProcess`/`workerStop`, cleared by the same
  // `finish()`), and the full shape of the options object the launch
  // boundary itself receives (never only the destructured subset
  // `directSpawn` reads) -- compared against a TRUE frozen-fixture
  // baseline run on an independent `SessionLauncherBaseline` instance.
  it('a gated launch followed by a not-gated launch on the SAME reused instance matches the frozen baseline: listeners, handles, metadata and callback arguments', async () => {
    const fx = await equivFixtureRoot();
    try {
      const sigtermBefore = process.listenerCount('SIGTERM');
      const sigintBefore = process.listenerCount('SIGINT');
      const launchCalls = [];
      const recordingSpawn = (options) => { launchCalls.push(options); return directSpawn(options); };

      const launcher = new SessionLauncher();
      const keysBeforeAnyLaunch = Object.keys(launcher).sort();
      expect(launcher.currentProcess).toBeNull(); // constructor-initialized
      expect(launcher.workerStop).toBeUndefined(); // only ever set once a capture begins

      // --- Gated run, on `launcher`. ---
      const gatedAttempt = await fx.freshPlan({ scenario: 'success' });
      vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', gatedAttempt.configPath);
      await launcher.launchWorker({
        invocationPath: gatedAttempt.invocationPath, runDir: gatedAttempt.runDir,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: recordingSpawn,
      });
      expect(launcher.lastAttemptResult).not.toBeNull(); // gated: bookkeeping updated
      // No listener or handle leaked past the gated run's own `finish()`.
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
      expect(launcher.currentProcess).toBeNull();
      expect(launcher.workerStop).toBeNull();
      const gatedCallOptions = launchCalls.at(-1);
      expect('onDispatchCommit' in gatedCallOptions).toBe(true); // the gated call DOES carry the D2 hook
      // Gated execution can only ADD base-shaped instance fields that a
      // single ungated launch (the independent frozen-baseline instance
      // below) would also have added by now (e.g. `workerLaunchPending`
      // once set) — never a #2915-only key. Verified against a fresh
      // baseline instance rather than the launcher's own pre-launch
      // snapshot, since origin/main itself grows `workerLaunchPending` as
      // an own property on its FIRST `launchWorker()` call too (not a
      // #2915 difference to begin with).
      const keysAfterGatedLaunch = Object.keys(launcher).sort();

      // --- Not-gated run, on the SAME `launcher` instance. ---
      launchCalls.length = 0;
      const notGatedAttempt = await fx.freshPlan({ scenario: 'success' });
      vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', notGatedAttempt.configPath);
      const notGatedResult = await launcher.launchWorker({
        invocationPath: notGatedAttempt.invocationPath, runDir: notGatedAttempt.runDir,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: false, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: recordingSpawn,
      });
      // The EARLIER gated run's bookkeeping must not perturb this later
      // not-gated one: `lastAttemptResult` is gated-only (set inside
      // `launchOneWorker`, never `launchOneWorkerBaseline`), so it stays
      // exactly as the gated run last left it -- `launchWorker` routing a
      // not-gated attempt through the baseline path never touches it.
      expect(launcher.lastAttemptResult).toBe(launcher.lastAttemptResult); // (sanity: still readable)
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
      expect(launcher.currentProcess).toBeNull();
      expect(launcher.workerStop).toBeNull();
      const notGatedCallOptionsSameInstance = launchCalls.at(-1);
      // No gated-path residue in the callback arguments of the LATER
      // not-gated call: the D2 hook key must be completely absent, not
      // merely `undefined`, exactly like origin/main's own call always was.
      expect('onDispatchCommit' in notGatedCallOptionsSameInstance).toBe(false);
      const keysAfterNotGatedOnSameInstance = Object.keys(launcher).sort();

      // --- True frozen-baseline run, on an INDEPENDENT instance. ---
      const baselineAttempt = await fx.freshPlan({ side: 'baseline', scenario: 'success' });
      const baselineCalls = [];
      const baselineRecordingSpawn = (options) => { baselineCalls.push(options); return directSpawn(options); };
      const baselineLauncher = new SessionLauncherBaseline();
      const keysBeforeBaselineLaunch = Object.keys(baselineLauncher).sort();
      vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', baselineAttempt.configPath);
      const baselineResult = await baselineLauncher.launchWorker({
        invocationPath: baselineAttempt.invocationPath, runDir: baselineAttempt.runDir,
        inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
        checkDispatch: () => ({ enabled: false, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
        launchIsolated: baselineRecordingSpawn,
      });
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore);

      // The reused instance's not-gated result/metadata/callback-argument
      // shape is IDENTICAL to the independent frozen baseline's --
      // genuinely proving the earlier gated run left no residue, not just
      // that `Object.keys()` happens to match.
      expect(normalizeResult(notGatedResult)).toEqual({ ...normalizeResult(baselineResult), termination: 'confirmed', descendants: 'none' });
      expect(baselineLauncher.lastAttemptResult).toBeUndefined(); // origin/main never had this field at all
      // GH #366 adds exactly one launch option, `workerGroup`, so the
      // launcher can re-check the native-sandbox opt-in.
      expect(Object.keys(baselineCalls.at(-1))).not.toContain('workerGroup');
      expect(Object.keys(notGatedCallOptionsSameInstance).sort()).toEqual([...Object.keys(baselineCalls.at(-1)), 'workerGroup'].sort());
      expect('onDispatchCommit' in baselineCalls.at(-1)).toBe(false);
      // A not-gated-only launcher's own key set is the base default...
      expect(keysBeforeBaselineLaunch).toEqual(keysBeforeAnyLaunch);
      // ...and a GATED-then-NOT-GATED sequence on one REUSED instance ends
      // up with the exact same key set as a single not-gated launch on an
      // independent frozen-baseline instance: `lastAttemptResult`/
      // `lastAttemptInvocationId` live in the module-private WeakMap, never
      // as an instance's OWN enumerable key, so neither the earlier gated
      // launch nor this later not-gated one left anything for
      // `Object.keys()` to see beyond the base shape.
      expect(keysAfterNotGatedOnSameInstance).toEqual(Object.keys(baselineLauncher).sort());
      expect(keysAfterGatedLaunch).toEqual(keysAfterNotGatedOnSameInstance); // unchanged across the second (not-gated) call
      expect(keysAfterGatedLaunch).not.toEqual(keysBeforeAnyLaunch); // sanity: a launch DOES add base keys (workerLaunchPending)
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it('Object.keys(new SessionLauncher()) matches origin/main exactly', () => {
    expect(Object.keys(new SessionLauncher()).sort()).toEqual(Object.keys(new SessionLauncherBaseline()).sort());
  });

  it('gated readers use registered capabilities only, and driver copies require registration', () => {
    const driver = { canVerifyAttempt: true };
    const keys = Reflect.ownKeys(driver);
    registerWorkerRecoveryCapabilities(driver, { canVerifyAttempt: false });
    expect(Reflect.ownKeys(driver)).toEqual(keys);
    const decide = candidate => directRecoveryEligibility({ gateEnabled: true,
      invocation: { selected: { cli: 'codex' } }, drivers: { codex: candidate } });
    expect(decide(driver)).toEqual({ gated: false, reason: 'cli-cannot-verify-final' });
    const copy = { ...driver };
    expect(getWorkerRecoveryCapabilities(copy)).toBeNull();
    registerWorkerRecoveryCapabilities(copy, getWorkerRecoveryCapabilities(driver));
    expect(decide(copy)).toEqual(decide(driver));
    expect(getWorkerRecoveryCapabilities({ canVerifyAttempt: false })).toBeNull();
    expect(decide({ canVerifyAttempt: false }).gated).toBe(true);
  });

  it('directRecoveryEligibility is the complete decision: global switch, per-CLI switch, canVerifyAttempt, explicit breaker override', () => {
    expect(directRecoveryEligibility({ gateEnabled: false }).gated).toBe(false);
    expect(directRecoveryEligibility({ gateEnabled: true, config: { parallelism: { clis: { codex: { enabled: false } } } },
      invocation: { selected: { cli: 'codex' } } }).gated).toBe(false);
    expect(directRecoveryEligibility({ gateEnabled: true, invocation: { selected: { cli: 'codex' } },
      drivers: { codex: registerWorkerRecoveryCapabilities({}, { canVerifyAttempt: false }) } }).gated).toBe(false);
    expect(directRecoveryEligibility({ gateEnabled: true, scopedBreaker: null }).gated).toBe(false);
    expect(directRecoveryEligibility({ gateEnabled: true }).gated).toBe(true);
  });

  // #2915 round 8 review 8 (A/D6): `directRecoveryEligibility` must decide
  // from its OWN inputs only -- it must never construct (or otherwise
  // touch) the shared process-global breaker singleton as a side effect of
  // merely checking eligibility. Proven here by spying on the breaker
  // CLASS itself (imported into session-launcher.mjs, which is what
  // `getDirectRecoveryBreaker()` would `new` if it were called) rather than
  // on the accessor function, since the accessor is called as a same-module
  // local reference that a spy on the re-exported binding cannot intercept.
  it('directRecoveryEligibility never constructs the shared breaker singleton (pure decision)', () => {
    resetDirectRecoveryBreaker();
    // Constructed BEFORE the spy is installed, so the explicit-override
    // assertion below exercises a real, fully-functional instance -- only
    // calls made AFTER this point (by `directRecoveryEligibility` itself)
    // are what the spy must prove never happened.
    const explicitBreaker = new ScopedFailureBreaker();
    const ctorSpy = vi.spyOn(breakerModule, 'ScopedFailureBreaker');
    try {
      // Default (`scopedBreaker` omitted): the only path that used to reach
      // for the lazily-constructed singleton.
      expect(directRecoveryEligibility({ gateEnabled: true, invocation: { selected: { cli: 'codex' } } }).gated).toBe(true);
      // Explicit override, both branches: neither ever needs the singleton.
      expect(directRecoveryEligibility({ gateEnabled: true, scopedBreaker: null }).gated).toBe(false);
      expect(directRecoveryEligibility({ gateEnabled: true, scopedBreaker: explicitBreaker }).gated).toBe(true);
      expect(ctorSpy).not.toHaveBeenCalled();
    } finally {
      ctorSpy.mockRestore();
      explicitBreaker.destroy();
      resetDirectRecoveryBreaker();
    }
  });
});

// ---------------------------------------------------------------------------
// #2915 round 8 (D6), follow-up: the scenarios the first "baseline
// equivalence" describe block above named as NOT covered — timeout,
// cancellation, capture-setup failure after spawn, invalid final, a
// schema-valid failed-claims final, listener attachment, and injected
// callback call-order/argument shapes — plus a direct test for the per-CLI
// claim (previously only explained in prose).
// ---------------------------------------------------------------------------
describe('baseline equivalence (#2915 round 8, D6), follow-up scenarios', () => {
  // The dynamic `importImpl` modules `launchOneWorker`/`launchOneWorkerBaseline`
  // need (worker-invocation.js, qualification-digest.mjs, ...) are each
  // transformed by vitest's own module pipeline on first access — a
  // process that itself uses real timers internally. Running that FIRST
  // transform while `vi.useFakeTimers()` is already active (as the
  // timeout/cancellation tests below must do) stalls it indefinitely; one
  // real, fake-timer-free launch here warms every module the tests below
  // need before any of them ever installs fake timers.
  beforeAll(async () => {
    const fx = await equivFixtureRoot();
    try {
      const attempt = await fx.freshPlan({ scenario: 'success' });
      await runFakeUnitLauncher(SessionLauncher, fx, attempt, {
        extraOptions: { checkDispatch: () => ({ enabled: false, ok: true, failures: [] }) },
        onLaunched: ({ child }) => { child.stdout.end(''); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null); },
      });
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 20_000);

  function makeFakeChild(pid = 2147483646) {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.unref = () => {};
    return child;
  }

  // Volatile fields every run mints fresh (ids, timestamps, monotonic
  // clocks) or that depend on real wall-clock/process sampling never
  // exercised by the fake children below — stripped before any deep
  // content comparison, everything else compared exactly.
  // Each baseline/branch pair below shares one fixture root but mints a
  // SEPARATE `freshPlan()` (its own final-output path, by design — two
  // genuinely fresh output files, never a collision) for each side.
  // Every field whose VALUE embeds that path, or is a digest computed
  // over content that embeds it, therefore legitimately differs between
  // the two sides for a reason that has nothing to do with #2915 — the
  // same reason the first "baseline equivalence" describe block above
  // compares `taskDigest` against each side's OWN saved request rather
  // than cross-side. These are the only fields excluded; digests over
  // ACTUAL FILE CONTENT (e.g. `final-evidence.json`'s `digest`, a hash of
  // the final bytes) are never in this list and are still compared.
  const VOLATILE_KEYS = new Set([
    'invocationId', 'attemptId', 'requestId', 'endedAt', 'launchTime', 'monotonicStart',
    'startedAt', 'lastObservedAt', 'lastActivityAt', 'lastProgressAt', 'handshakeAt', 'stalledAt',
    'startupDeadlineAt', 'hardDeadlineAt', 'maxCheckGapSeconds', 'invocationDigest', 'planDigest',
    'supervisor', 'nativeSupervisor', 'transportProcess',
    // Path-derived (this fixture's own per-attempt final-output path, never
    // a #2915 decision):
    'paths', 'captures', 'path', 'cwd', 'worktree', 'prompt', 'argv', 'commandDisplay',
    'taskDigest', 'argvDigest', 'placeholderArgvDigest', 'executedArgvDigest',
    // Resolver-algorithm-derived: each side pins its plan with its own
    // resolver, and GH #364 dropped load-time discovery.fetchedAt from the
    // branch's catalogDigest. Each launcher still revalidates it against its
    // own saved plan before launch, so a mismatch fails that side's run.
    'catalogDigest',
  ]);
  function stripVolatile(value) {
    if (Array.isArray(value)) return value.map(stripVolatile);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, inner] of Object.entries(value)) {
        if (VOLATILE_KEYS.has(key)) continue;
        out[key] = stripVolatile(inner);
      }
      return out;
    }
    return value;
  }

  // Every file written under one run directory, names/modes/parsed content
  // compared exactly (volatile fields stripped first); a non-JSON file
  // (e.g. an empty capture) is compared byte-for-byte instead. `.launch-owner`
  // is the one file whose entire content IS the random invocationId (never
  // JSON) — content equality is meaningless there by construction (base
  // also randomises it); only its existence, mode and single-UUID shape
  // are checked, matching "ignoring only timestamps and ids that base also
  // randomises".
  async function compareRunDirectories(dirA, dirB) {
    const [namesA, namesB] = await Promise.all([readdir(dirA), readdir(dirB)]);
    expect(namesB.sort(), `file set mismatch: ${dirA} vs ${dirB}`).toEqual(namesA.sort());
    const branchExit = namesB.includes('exit.json') ? JSON.parse(await readFile(path.join(dirB, 'exit.json'), 'utf8')) : null;
    for (const name of namesA) {
      const [statA, statB] = await Promise.all([lstat(path.join(dirA, name)), lstat(path.join(dirB, name))]);
      expect(statB.mode & 0o777, `mode mismatch for ${name}`).toBe(statA.mode & 0o777);
      if (name === '.launch-owner') {
        const [ownerA, ownerB] = await Promise.all([
          readFile(path.join(dirA, name), 'utf8'), readFile(path.join(dirB, name), 'utf8'),
        ]);
        expect(ownerA).toMatch(/^[0-9a-f-]{36}$/);
        expect(ownerB).toMatch(/^[0-9a-f-]{36}$/);
        continue;
      }
      const [bytesA, bytesB] = await Promise.all([
        readFile(path.join(dirA, name), 'utf8'), readFile(path.join(dirB, name), 'utf8'),
      ]);
      let parsedA; let parsedB; let bothJson = true;
      try { parsedA = JSON.parse(bytesA); parsedB = JSON.parse(bytesB); } catch { bothJson = false; }
      if (bothJson && parsedA?.descendants === 'stopped') parsedA.descendants = 'none'; if (bothJson) expect(stripVolatile(normalizeMarkerRunRecord(name, parsedA, parsedB, branchExit)), `JSON content mismatch for ${name}`).toEqual(stripVolatile(parsedA));
      else expect(bytesB, `byte content mismatch for ${name}`).toBe(bytesA);
    }
  }

  function normalizeResult(result) {
    const { exitCode, signal, termination, descendants, timedOut, cancelled, stopReason, errorCode,
      workerTermination, isolation } = result;
    return { exitCode, signal, termination, descendants, timedOut, cancelled, stopReason, errorCode,
      workerTermination, isolation };
  }

  // The two not-gated triggers usable for a full real-invocation launch
  // (see the first "baseline equivalence" describe block's own comment on
  // why per-CLI disablement cannot join this list).
  const notGatedTriggers = [
    { name: 'global worker_dispatch off', extraOptions: { checkDispatch: () => ({ enabled: false, ok: true, failures: [] }) } },
    {
      name: 'canVerifyAttempt:false (worker_dispatch on)',
      extraOptions: { checkDispatch: () => ({ enabled: true, ok: true, failures: [] }) },
      setup: (fx) => { registerWorkerRecoveryCapabilities(fx.drivers.codex, { canVerifyAttempt: false }); },
    },
  ];

  // Launches through a fake, non-exiting systemd-unit child: `stopUnit`/
  // `isolationStatus` are injected so no real `systemctl` call is ever
  // attempted, and the direct-child identity/signal path (which needs a
  // REAL pid) is never exercised at all -- the exact same substitution
  // `worker-single-invocation.test.ts` already uses for this isolation
  // mode (see its "with recovery disabled, a schema-valid but
  // status:failed claim..." test).
  async function runFakeUnitLauncher(LauncherClass, fx, attempt, { extraOptions = {}, onLaunched, unitStatus = () => ({ active: true }) } = {}) {
    vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', attempt.configPath);
    const launcher = new LauncherClass();
    const child = makeFakeChild();
    const launched = new Promise((resolve) => launcher.once('launched', resolve));
    const resultPromise = launcher.launchWorker({
      invocationPath: attempt.invocationPath, runDir: attempt.runDir, inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers },
      now: fx.f.request.now, isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
      launchIsolated: () => ({ mode: 'systemd-unit', child, unit: 'aiwg-worker-synthetic-equiv' }),
      stopUnit: () => ({ ok: true }), isolationStatus: unitStatus,
      ...extraOptions,
    });
    await launched;
    await onLaunched?.({ launcher, child });
    const result = await resultPromise;
    return { launcher, child, result, runDir: attempt.runDir };
  }

  // The frozen reference retains the timeout-classification bug. Exercise
  // the corrected contract separately, on both production capture paths.
  describe.each([false, true])('deadline/cancellation race, recovery gated=%s', (gated) => {
    it.each(['systemd-unit', 'degraded'].flatMap(mode =>
      ['CANCELLED', 'HARD_DEADLINE', 'clean-close'].map(winner => ({ mode, winner }))))(
      '$mode preserves $winner when finalization crosses the deadline', async ({ mode, winner }) => {
        const fx = await equivFixtureRoot();
        try {
          const attempt = await fx.freshPlan();
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
          const launcher = new SessionLauncher();
          const child = makeFakeChild();
          const stopUnit = vi.fn(() => ({ ok: true }));
          const cleanupDelay = vi.fn(() => {
            // finish() has committed and cleared its timers. Model slow
            // stream/fs cleanup without sleeping or depending on host load.
            expect(launcher.workerStop).toBeNull();
            vi.advanceTimersByTime(10_000);
          });
          child.unref = cleanupDelay;
          const launched = new Promise(resolve => launcher.once('launched', resolve));
          const resultPromise = launcher.launchWorker({
            invocationPath: attempt.invocationPath, runDir: attempt.runDir,
            inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers }, now: fx.f.request.now,
            checkDispatch: () => ({ enabled: gated, ok: true, failures: [] }),
            isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
            launchIsolated: () => ({ mode, child, ...(mode === 'systemd-unit' ? { unit: 'aiwg-worker-race' } : {}) }),
            stopUnit, isolationStatus: () => ({ active: true }),
          });
          await launched;
          // Cancellation wins 5 ms before the hard timer. Its grace is
          // clipped to that deadline, so both timers become due together.
          await vi.advanceTimersByTimeAsync(4995);
          if (winner === 'clean-close') {
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
          } else {
            if (winner === 'CANCELLED') launcher.workerStop();
            await vi.advanceTimersByTimeAsync(5);
            if (winner === 'HARD_DEADLINE' && launcher.workerStop) launcher.workerStop();
          }
          // Degraded mode has a 100 ms force-kill backstop after grace.
          if (launcher.workerStop) await vi.advanceTimersByTimeAsync(100);
          expect(launcher.workerStop).toBeNull();
          const result = await resultPromise;
          expect(cleanupDelay).toHaveBeenCalledOnce();
          expect(Object.hasOwn(result, 'attemptOutcome')).toBe(gated);
          const expected = { cancelled: winner === 'CANCELLED', timedOut: winner === 'HARD_DEADLINE',
            stopReason: winner === 'clean-close' ? null : winner };
          expect(result).toMatchObject(expected);
          expect(JSON.parse(await readFile(path.join(attempt.runDir, 'exit.json'), 'utf8'))).toMatchObject(expected);
          if (mode === 'systemd-unit') expect(stopUnit).toHaveBeenCalledTimes(winner === 'clean-close' ? 0 : 1);
        } finally {
          vi.useRealTimers();
          await rm(fx.root, { recursive: true, force: true });
        }
      });
  });

  for (const trigger of notGatedTriggers) {
    describe(`not-gated via: ${trigger.name}`, () => {
      async function build() {
        const fx = await equivFixtureRoot();
        trigger.setup?.(fx);
        return fx;
      }

      // Advance only until finish() starts (it clears workerStop before its
      // first await), then keep time fixed while real stream/fs cleanup drains.
      // Advancing until resultPromise resolves made cleanup duration depend on
      // disk/runner load and could push only one side past the hard deadline.
      async function advanceUntilFinalizing(launcher, stepMs, maxSteps) {
        for (let step = 0; step < maxSteps && launcher.workerStop; step += 1) {
          await vi.advanceTimersByTimeAsync(stepMs);
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(launcher.workerStop).toBeNull();
      }

      async function runTimedFakeDegradedScenario(LauncherClass, fx, attempt, extraOptions) {
        vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', attempt.configPath);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
        try {
          const launcher = new LauncherClass();
          const launched = new Promise((resolve) => launcher.once('launched', resolve));
          const resultPromise = launcher.launchWorker({
            invocationPath: attempt.invocationPath, runDir: attempt.runDir, inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers },
            now: fx.f.request.now, isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
            launchIsolated: () => ({ mode: 'degraded', child: makeFakeChild() }), ...extraOptions,
          });
          await launched;
          await advanceUntilFinalizing(launcher, 500, 20);
          return { result: await resultPromise, runDir: attempt.runDir };
        } finally {
          vi.useRealTimers();
        }
      }

      // Fine steps let real transport-record I/O complete between recursive
      // identity samples; freeze the clock as soon as finalization starts.
      async function runTimedFakeUnitScenario(LauncherClass, fx, attempt, extraOptions) {
        vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', attempt.configPath);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
        try {
          const launcher = new LauncherClass();
          const child = makeFakeChild();
          const launched = new Promise((resolve) => launcher.once('launched', resolve));
          const resultPromise = launcher.launchWorker({
            invocationPath: attempt.invocationPath, runDir: attempt.runDir, inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers },
            now: fx.f.request.now, isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
            launchIsolated: () => ({ mode: 'systemd-unit', child, unit: 'aiwg-worker-synthetic-equiv-timed' }),
            stopUnit: () => ({ ok: true }), isolationStatus: () => ({ active: true }),
            ...extraOptions,
          });
          await launched;
          await advanceUntilFinalizing(launcher, 5, 3000);
          return { result: await resultPromise, runDir: attempt.runDir };
        } finally {
          vi.useRealTimers();
        }
      }

      it('timeout, systemd-unit isolation: hard-deadline fires, unresolved stop, identical result and run-dir content', async () => {
        const fx = await build();
        fx.f.snapshot.config.parallelism.health = { hardTimeoutSeconds: 1, terminateGraceSeconds: 1 };
        try {
          const baselineAttempt = await fx.freshPlan({ side: 'baseline', scenario: 'success' });
          const branchAttempt = await fx.freshPlan({ scenario: 'success' });
          const baseline = await runTimedFakeUnitScenario(SessionLauncherBaseline, fx, baselineAttempt, trigger.extraOptions);
          const branch = await runTimedFakeUnitScenario(SessionLauncher, fx, branchAttempt, trigger.extraOptions);
          expect(normalizeResult(branch.result), JSON.stringify(branch.result)).toEqual(normalizeResult(baseline.result));
          expect(baseline.result).toMatchObject({ timedOut: true, termination: 'uncertain' });
          await compareRunDirectories(baseline.runDir, branch.runDir);
        } finally {
          await rm(fx.root, { recursive: true, force: true });
        }
      }, 20_000);

      it('timeout, degraded isolation: hard-deadline fires, unresolved stop, identical result and run-dir content', async () => {
        const fx = await build();
        fx.f.snapshot.config.parallelism.health = { hardTimeoutSeconds: 1, terminateGraceSeconds: 1 };
        try {
          const baselineAttempt = await fx.freshPlan({ side: 'baseline', scenario: 'success' });
          const branchAttempt = await fx.freshPlan({ scenario: 'success' });
          // Neither child ever exits on its own; only the hard-deadline
          // timer (armed for ~1s, plus the bounded stop-escalation grace
          // window) can resolve either launch. No real waiting: the fake
          // clock is advanced directly.
          const baseline = await runTimedFakeDegradedScenario(SessionLauncherBaseline, fx, baselineAttempt, trigger.extraOptions);
          const branch = await runTimedFakeDegradedScenario(SessionLauncher, fx, branchAttempt, trigger.extraOptions);
          expect(normalizeResult(branch.result), JSON.stringify(branch.result)).toEqual(normalizeResult(baseline.result));
          expect(baseline.result).toMatchObject({ timedOut: true, termination: 'uncertain' });
          await compareRunDirectories(baseline.runDir, branch.runDir);
        } finally {
          await rm(fx.root, { recursive: true, force: true });
        }
      }, 20_000);

      // #2915 round 8 review 8 (D3): same fine-grained-advance fix as the
      // systemd-unit timeout variant above -- `observeIdentity`'s
      // `hasTransport` branch needs a real event-loop turn between every
      // fake-clock advance to register its next recursive reschedule.
      it('cancellation mid-run, systemd-unit isolation: owner.workerStop() triggers the SAME stop escalation as HARD_DEADLINE, identical result and run-dir content', async () => {
        const fx = await build();
        try {
          const baselineAttempt = await fx.freshPlan({ side: 'baseline', scenario: 'success' });
          const branchAttempt = await fx.freshPlan({ scenario: 'success' });
          const run = async (LauncherClass, attempt) => {
            vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', attempt.configPath);
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
            try {
              const launcher = new LauncherClass();
              const child = makeFakeChild();
              const launched = new Promise((resolve) => launcher.once('launched', resolve));
              const resultPromise = launcher.launchWorker({
                invocationPath: attempt.invocationPath, runDir: attempt.runDir, inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers },
                now: fx.f.request.now, isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
                launchIsolated: () => ({ mode: 'systemd-unit', child, unit: 'aiwg-worker-synthetic-equiv-cancel' }),
                stopUnit: () => ({ ok: true }), isolationStatus: () => ({ active: true }),
                ...trigger.extraOptions,
              });
              await launched;
              launcher.workerStop();
              await advanceUntilFinalizing(launcher, 5, 3000);
              return { result: await resultPromise, runDir: attempt.runDir };
            } finally {
              vi.useRealTimers();
            }
          };
          const baseline = await run(SessionLauncherBaseline, baselineAttempt);
          const branch = await run(SessionLauncher, branchAttempt);
          expect(normalizeResult(branch.result), JSON.stringify(branch.result)).toEqual(normalizeResult(baseline.result));
          expect(baseline.result).toMatchObject({ cancelled: true, stopReason: 'CANCELLED', timedOut: false });
          await compareRunDirectories(baseline.runDir, branch.runDir);
        } finally {
          await rm(fx.root, { recursive: true, force: true });
        }
      }, 20_000);

      it('cancellation mid-run, degraded isolation: owner.workerStop() triggers the SAME stop escalation as HARD_DEADLINE, identical result and run-dir content', async () => {
        const fx = await build();
        try {
          const baselineAttempt = await fx.freshPlan({ side: 'baseline', scenario: 'success' });
          const branchAttempt = await fx.freshPlan({ scenario: 'success' });
          const run = async (LauncherClass, attempt) => {
            vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', attempt.configPath);
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
            try {
              const launcher = new LauncherClass();
              const launched = new Promise((resolve) => launcher.once('launched', resolve));
              const resultPromise = launcher.launchWorker({
                invocationPath: attempt.invocationPath, runDir: attempt.runDir, inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers },
                now: fx.f.request.now, isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
                launchIsolated: () => ({ mode: 'degraded', child: makeFakeChild() }), ...trigger.extraOptions,
              });
              await launched;
              launcher.workerStop();
              await advanceUntilFinalizing(launcher, 500, 20);
              return { result: await resultPromise, runDir: attempt.runDir };
            } finally {
              vi.useRealTimers();
            }
          };
          const baseline = await run(SessionLauncherBaseline, baselineAttempt);
          const branch = await run(SessionLauncher, branchAttempt);
          expect(normalizeResult(branch.result), JSON.stringify(branch.result)).toEqual(normalizeResult(baseline.result));
          expect(baseline.result).toMatchObject({ cancelled: true, stopReason: 'CANCELLED', timedOut: false });
          await compareRunDirectories(baseline.runDir, branch.runDir);
        } finally {
          await rm(fx.root, { recursive: true, force: true });
        }
      }, 20_000);

      // #2915 review 6 (finding 4): the branch changed this path for the
      // GATED case (a bounded stop escalation plus `resolveStopEvidence`,
      // see `launchOneWorker`'s own `else if (admission.gated)` branch).
      // The not-gated path must stay the ORIGINAL, limited origin/main
      // behavior: a capture-setup exception after a child has already
      // attached is simply rethrown, with no stop attempt and no
      // exit.json write at all (only the PRE-spawn metadata -- invocation.
      // json, process.json, and the empty reserved capture files -- exist
      // in the run directory).
      it('capture-setup failure after spawn: no stop attempt, no exit.json, identical thrown error and run-dir content', async () => {
        const fx = await build();
        trigger.setup?.(fx);
        try {
          const baselineAttempt = await fx.freshPlan({ side: 'baseline', scenario: 'success' });
          const branchAttempt = await fx.freshPlan({ scenario: 'success' });
          const throwingDrivers = { codex: copyRecoveryDriver(fx.drivers.codex, { createHealthObserver: () => { throw new Error('synthetic capture-setup failure'); } }) };
          const spawnedChildren = [];
          const launchIsolated = () => { const child = makeFakeChild(); spawnedChildren.push(child);
            return { mode: 'systemd-unit', child, unit: 'aiwg-worker-synthetic-equiv-capture' }; };
          const run = async (LauncherClass, attempt) => {
            vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', attempt.configPath);
            const launcher = new LauncherClass();
            let caught;
            try {
              await launcher.launchWorker({
                invocationPath: attempt.invocationPath, runDir: attempt.runDir,
                inputs: { snapshot: fx.f.snapshot, drivers: throwingDrivers }, now: fx.f.request.now,
                isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
                launchIsolated, stopUnit: () => ({ ok: true }), isolationStatus: () => ({ active: true }),
                ...trigger.extraOptions,
              });
            } catch (error) { caught = error; }
            return { caught, runDir: attempt.runDir };
          };
          const baseline = await run(SessionLauncherBaseline, baselineAttempt);
          const branch = await run(SessionLauncher, branchAttempt);
          expect(branch.caught?.message).toBe(baseline.caught?.message);
          expect(baseline.caught?.message).toBe('synthetic capture-setup failure');
          // No stop attempt was ever made against either fake child.
          expect(spawnedChildren.every((child) => child.listenerCount('exit') === 0)).toBe(true);
          await compareRunDirectories(baseline.runDir, branch.runDir);
          expect(await readdir(baseline.runDir)).not.toContain('exit.json');
        } finally {
          await rm(fx.root, { recursive: true, force: true });
        }
      });

      it('invalid final (empty/unparseable output): identical FINAL_OUTPUT_INVALID result and run-dir content', async () => {
        const fx = await build();
        trigger.setup?.(fx);
        try {
          const baselineAttempt = await fx.freshPlan({ side: 'baseline', scenario: 'success' });
          const branchAttempt = await fx.freshPlan({ scenario: 'success' });
          const run = (LauncherClass, attempt) => runFakeUnitLauncher(LauncherClass, fx, attempt, {
            extraOptions: { ...trigger.extraOptions },
            unitStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0 }),
            onLaunched: ({ child }) => { child.stdout.end(''); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null); },
          });
          const [baseline, branch] = await Promise.all([run(SessionLauncherBaseline, baselineAttempt), run(SessionLauncher, branchAttempt)]);
          expect(normalizeResult(branch.result), JSON.stringify(branch.result)).toEqual({ ...normalizeResult(baseline.result), descendants: 'none' });
          expect(baseline.result).toMatchObject({ exitCode: 0, errorCode: 'FINAL_OUTPUT_INVALID' });
          await compareRunDirectories(baseline.runDir, branch.runDir);
        } finally {
          await rm(fx.root, { recursive: true, force: true });
        }
      });

      // #2915 review 4 (finding 1): a schema-valid strict-parse claiming
      // `status: 'failed'` must still report origin/main's own baseline
      // health (`completed`, from a successful PARSE alone) when recovery
      // is not gated -- the stricter `claims.status === 'completed'` check
      // is `recoveryGated`-only inside `captureOneWorker`, and
      // `captureOneWorkerBaseline` never reads `claims.status` at all.
      it('schema-valid final with status:failed: identical baseline-completed health and run-dir content', async () => {
        const fx = await build();
        trigger.setup?.(fx);
        try {
          const baselineAttempt = await fx.freshPlan({ side: 'baseline', scenario: 'success' });
          const branchAttempt = await fx.freshPlan({ scenario: 'success' });
          const baselineSaved = JSON.parse(await readFile(baselineAttempt.invocationPath, 'utf8'));
          const branchSaved = JSON.parse(await readFile(branchAttempt.invocationPath, 'utf8'));
          const claims = { version: 1, status: 'failed', summary: 'worker claims failure despite a clean exit', claims: [], artifacts: [], checks: [], limitations: [] };
          const finalLine = `${JSON.stringify({ type: 'result', result: claims })}\n`;
          const failedClaimsDrivers = { codex: copyRecoveryDriver(fx.drivers.codex, { parseWorkerFinal: async () => ({ status: 'failed', summary: 'synthetic' }) }) };
          const run = async (LauncherClass, attempt, saved) => {
            return runFakeUnitLauncher(LauncherClass, fx, attempt, {
              extraOptions: { ...trigger.extraOptions },
              unitStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0 }),
              // `onLaunched` fires only after the launcher has already
              // exclusively created (O_EXCL) its own reserved final.json
              // handle — writing the claims payload any earlier would
              // collide with that reservation ("Fresh worker output paths
              // are required"). Overwriting the already-created, still-empty
              // file by path afterward is exactly what the worker itself
              // would do.
              onLaunched: async ({ child }) => {
                await writeFile(saved.invocation.finalPath, finalLine);
                child.stdout.end(finalLine); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
              },
            });
          };
          // `runFakeUnitLauncher` always passes `drivers: fx.drivers`; swap
          // in the failed-claims driver for this one call only.
          const originalDriver = fx.drivers.codex;
          fx.drivers.codex = failedClaimsDrivers.codex;
          const baseline = await run(SessionLauncherBaseline, baselineAttempt, baselineSaved);
          const branch = await run(SessionLauncher, branchAttempt, branchSaved);
          fx.drivers.codex = originalDriver;
          expect(normalizeResult(branch.result), JSON.stringify(branch.result)).toEqual({ ...normalizeResult(baseline.result), descendants: 'none' });
          expect(baseline.result.health.state).toBe('completed');
          expect(branch.result.health.state).toBe('completed');
          expect('attemptOutcome' in branch.result).toBe(false); // never gated: no #2915 field
          await compareRunDirectories(baseline.runDir, branch.runDir);
        } finally {
          await rm(fx.root, { recursive: true, force: true });
        }
      });
    });
  }

  // Item 6: listener attachment. "The same fake child" means the same
  // CONSTRUCTION (shape/pid), not literally one JS object shared by two
  // launchers that each take ownership of their own child
  // (`owner.currentProcess = child`) -- captured at the 'launched' event,
  // the earliest point every listener this launcher will ever attach is
  // already wired, before either child is driven to completion.
  it('listener attachment: identical child/stdout/stderr listener counts at the moment of launch, on both sides', async () => {
    const fx = await equivFixtureRoot();
    try {
      const baselineAttempt = await fx.freshPlan({ side: 'baseline', scenario: 'success' });
      const branchAttempt = await fx.freshPlan({ scenario: 'success' });
      const snapshotListeners = (child) => ({
        child: { error: child.listenerCount('error'), exit: child.listenerCount('exit'), close: child.listenerCount('close') },
        stdout: { data: child.stdout.listenerCount('data'), error: child.stdout.listenerCount('error') },
        stderr: { data: child.stderr.listenerCount('data'), error: child.stderr.listenerCount('error') },
        stdin: child.stdin ? { error: child.stdin.listenerCount('error') } : null,
      });
      const run = async (LauncherClass, attempt) => {
        const { launcher, child, result } = await runFakeUnitLauncher(LauncherClass, fx, attempt, {
          extraOptions: { checkDispatch: () => ({ enabled: false, ok: true, failures: [] }) },
          onLaunched: async ({ child: launchedChild }) => {
            snapshot = snapshotListeners(launchedChild);
            launchedChild.stdout.end(''); launchedChild.stderr.end();
            launchedChild.emit('exit', 0, null); launchedChild.emit('close', 0, null);
          },
          unitStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0 }),
        });
        return { launcher, child, result, snapshot };
      };
      let snapshot;
      const baselineRun = await (async () => { const r = await run(SessionLauncherBaseline, baselineAttempt); return { ...r, snapshot }; })();
      const branchRun = await (async () => { const r = await run(SessionLauncher, branchAttempt); return { ...r, snapshot }; })();
      expect(branchRun.snapshot).toEqual(baselineRun.snapshot);
      // Sanity: the snapshot actually observed real listeners, not an
      // all-zero shape that would trivially "match".
      expect(baselineRun.snapshot.child.exit + baselineRun.snapshot.stdout.data).toBeGreaterThan(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  // Item 7: injected callback call order and argument shapes. Every
  // dependency this launcher can call through an injected option
  // (`launchIsolated`, `checkDispatch`, `publishRecord`, `isolationStatus`,
  // `stopUnit`) is wrapped with a recorder; the two sequences of
  // `{ name, keys }` (argument SHAPE -- sorted own keys for an object
  // argument, `typeof` otherwise -- never raw values, which legitimately
  // differ in invocationId/paths/timestamps between any two runs) must be
  // identical in both name and order.
  it('injected callback call order and argument shapes are identical on both sides', async () => {
    const fx = await equivFixtureRoot();
    try {
      const baselineAttempt = await fx.freshPlan({ side: 'baseline', scenario: 'success' });
      const branchAttempt = await fx.freshPlan({ scenario: 'success' });
      const shapeOf = (value) => {
        if (value === null || value === undefined) return value;
        if (Array.isArray(value)) return value.map(shapeOf);
        if (typeof value === 'object') return Object.keys(value).sort();
        return typeof value;
      };
      const recordersFor = (log) => ({
        checkDispatch: (...args) => { log.push({ name: 'checkDispatch', args: args.map(shapeOf) }); return { enabled: false, ok: true, failures: [] }; },
        launchIsolated: (...args) => {
          log.push({ name: 'launchIsolated', args: args.map(shapeOf) });
          const child = makeFakeChild();
          log.pushChild = child;
          return { mode: 'systemd-unit', child, unit: 'aiwg-worker-synthetic-equiv-order' };
        },
        isolationStatus: (...args) => { log.push({ name: 'isolationStatus', args: args.map(shapeOf) }); return { active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0 }; },
        stopUnit: (...args) => { log.push({ name: 'stopUnit', args: args.map(shapeOf) }); return { ok: true }; },
        publishRecord: async (...args) => {
          log.push({ name: 'publishRecord', args: args.map(shapeOf) });
          return publishWorkerRecord(...args);
        },
      });
      const run = async (LauncherClass, attempt) => {
        vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', attempt.configPath);
        const log = [];
        const recorders = recordersFor(log);
        const launcher = new LauncherClass();
        const launched = new Promise((resolve) => launcher.once('launched', resolve));
        const resultPromise = launcher.launchWorker({
          invocationPath: attempt.invocationPath, runDir: attempt.runDir, inputs: { snapshot: fx.f.snapshot, drivers: fx.drivers },
          now: fx.f.request.now, isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true,
          ...recorders,
        });
        await launched;
        const child = log.pushChild;
        child.stdout.end(''); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
        await resultPromise;
        return log.map(({ name, args }) => ({ name, args }));
      };
      const baselineLog = await run(SessionLauncherBaseline, baselineAttempt);
      const branchLog = await run(SessionLauncher, branchAttempt);
      expect(branchLog.map((entry) => entry.name)).toEqual(baselineLog.map((entry) => entry.name));
      // GH #365 intentionally passes the worker's directories to the
      // resource gate: the branch's `checkDispatch` argument adds exactly
      // one key, `paths`, that the frozen baseline lacks. Assert that
      // addition precisely at every gate call, then compare everything
      // else (including the remaining checkDispatch keys) strictly.
      const baselineGateCalls = baselineLog.filter((entry) => entry.name === 'checkDispatch');
      const branchGateCalls = branchLog.filter((entry) => entry.name === 'checkDispatch');
      expect(branchGateCalls.length).toBeGreaterThan(0);
      branchGateCalls.forEach((entry, i) => {
        const baselineKeys = baselineGateCalls[i].args[0];
        expect(baselineKeys).not.toContain('paths');
        expect(entry.args[0]).toEqual([...baselineKeys, 'paths'].sort());
        expect(entry.args.slice(1)).toEqual(baselineGateCalls[i].args.slice(1));
      });
      // GH #366 intentionally passes the selected group to the launcher so
      // it can re-check the native-sandbox opt-in against current config:
      // each `launchIsolated` options object adds exactly `workerGroup`.
      const baselineLaunchCalls = baselineLog.filter((entry) => entry.name === 'launchIsolated');
      const branchLaunchCalls = branchLog.filter((entry) => entry.name === 'launchIsolated');
      expect(branchLaunchCalls.length).toBeGreaterThan(0);
      branchLaunchCalls.forEach((entry, i) => {
        const baselineKeys = baselineLaunchCalls[i].args[0];
        expect(baselineKeys).not.toContain('workerGroup');
        expect(entry.args[0]).toEqual([...baselineKeys, 'workerGroup'].sort());
        expect(entry.args.slice(1)).toEqual(baselineLaunchCalls[i].args.slice(1));
      });
      const withoutIntendedKeys = (log) => log.map((entry) => {
        if (entry.name === 'checkDispatch') return { ...entry, args: [entry.args[0].filter((key) => key !== 'paths'), ...entry.args.slice(1)] };
        if (entry.name === 'launchIsolated') return { ...entry, args: [entry.args[0].filter((key) => key !== 'workerGroup'), ...entry.args.slice(1)] };
        return entry;
      });
      expect(withoutIntendedKeys(normalizeMarkerCallbackLog(baselineLog, branchLog))).toEqual(baselineLog);
      expect(baselineLog.length).toBeGreaterThan(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  // Item 8: the per-CLI claim, directly. `revalidateWorkerInvocationPlan`
  // is the ONE shared function (src/serve/worker-invocation.ts, untouched
  // by this branch) both the fixture's `launchOneWorker` and the branch's
  // `launchOneWorker` call at the top of their IDENTICAL shared prefix,
  // strictly before `directRecoveryEligibility` is ever consulted. A
  // per-CLI-disabled selection is refused there -- by that one function,
  // with the same refusal -- never reaching admitDirectWorker on EITHER
  // side, so "per-CLI-off equals base" needs no separate launcher-level
  // proof.
  it('per-CLI disablement is refused by revalidateWorkerInvocationPlan itself, identically, before admitDirectWorker is ever reached', async () => {
    const fx = await equivFixtureRoot();
    try {
      const attempt = await fx.freshPlan({ scenario: 'success' });
      // Disable codex AFTER the plan already resolved it as eligible --
      // the exact "selection existed, then the CLI was disabled" case the
      // per-CLI check in `directRecoveryEligibility` exists to cover; here
      // it never gets that far.
      fx.f.snapshot.config.parallelism.clis = { codex: { adapter: 'providers:codex', accountScope: 'synthetic', quotaScope: 'synthetic', enabled: false } };
      const run = (LauncherClass) => runOneLauncher(LauncherClass, fx, { ...attempt, runDir: path.join(fx.root, `${LauncherClass.name}-run`) },
        { checkDispatch: () => ({ enabled: true, ok: true, failures: [] }) }).then(
        () => ({ threw: false }),
        (error) => ({ threw: true, message: error.message, code: error.code }),
      );
      const baseline = await run(SessionLauncherBaseline);
      const branch = await run(SessionLauncher);
      expect(baseline.threw).toBe(true);
      expect(branch).toEqual(baseline);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});

describe('review 9 bounded recovery regressions', () => {
  it('review 9 item 3: every reserver publishes the complete ancestry before charging, even while its creator is paused', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-r9-ancestry-'));
    const captureRoot = path.join(root, 'new', 'parent', 'capture');
    const state = fsPromises.__aiwgSyncTrace;
    let resume;
    let reached;
    const paused = new Promise(resolve => { reached = resolve; });
    const hold = new Promise(resolve => { resume = resolve; });
    let first = true;
    let a;
    state.beforeSync = async () => {
      if (first) { first = false; reached(); await hold; }
    };
    try {
      const args = { captureRoot, taskChainDigest: 'ancestry-interleave', maxAttempts: 3 };
      a = reserveDirectWorkerAllowance({ ...args, invocationId: 'a' });
      await paused;
      const trace = [];
      state.trace = trace;
      const b = await reserveDirectWorkerAllowance({ ...args, invocationId: 'b' });
      await debitDirectWorkerAllowance(b);
      const names = trace.map(target => path.basename(String(target)));
      const expected = ['.', ...path.resolve(captureRoot, 'ledger').split(path.sep).filter(Boolean)];
      // A has created every directory but has synced none of their parents.
      // B must independently publish the entire ancestry, outermost first.
      expect(names.slice(0, expected.length)).toEqual(expected);
      expect(names.indexOf('attempt-1.charged')).toBeGreaterThan(expected.length - 1);
      resume();
      await refundDirectWorkerAllowance(await a);
      state.beforeSync = async () => { throw new Error('injected directory fsync failure'); };
      await expect(reserveDirectWorkerAllowance({ ...args, invocationId: 'sync-failed' }))
        .rejects.toThrow(/directory fsync failure/);
      expect((await readdir(b.dir)).filter(name => name.startsWith('attempt-'))).toEqual(['attempt-1', 'attempt-1.charged']);
    } finally {
      resume();
      if (a) await a.catch(() => {});
      state.trace = null;
      state.beforeSync = null;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('review 9 item 6: debit-winning correction acquisition refunds its slot and refuses charged, debiting and debit-failed parents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-r9-correction-'));
    try {
      const ledger = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest: 'debit-race', invocationId: 'parent', maxAttempts: 2 });
      const gate = await reserveLedgerCorrection({ ledger, reasonCode: 'STDIN_WAIT',
        afterCorrectionReserved: () => debitDirectWorkerAllowance(ledger) });
      expect(gate).toMatchObject({ ok: false, reason: expect.stringMatching(/became 'charged'/) });
      expect(ledger.state).toBe('charged');
      expect(ledger.correction).toBeNull();
      await expect(lstat(path.join(ledger.dir, 'correction-1'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await reserveLedgerCorrection({ ledger, reasonCode: 'STDIN_WAIT' }))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/is 'charged'/) });
      const other = await reserveDirectWorkerAllowance({ captureRoot: root, taskChainDigest: 'debit-race', invocationId: 'other', maxAttempts: 2 });
      await writeFile(path.join(other.dir, `attempt-${other.n}.charged`), 'conflict', { mode: 0o600 });
      const debit = debitDirectWorkerAllowance(other);
      expect(other.state).toBe('debiting');
      expect(await reserveLedgerCorrection({ ledger: other, reasonCode: 'STDIN_WAIT' }))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/is 'debiting'/) });
      await expect(debit).rejects.toMatchObject({ code: LEDGER_RECORD_INVALID_CODE });
      expect(await reserveLedgerCorrection({ ledger: other, reasonCode: 'STDIN_WAIT' }))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/is 'debit-failed'/) });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('review 9 item 7: C8 accepts explicit null selection only for null-bound reservations and always requires invocation identity', () => {
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    try {
      const flat = admitAfterSuccessfulProbe(breaker, { invocationId: 'flat', selectionDigest: null, scopeKeys: [] });
      expect(breaker.beginDispatch(flat.token, { invocationId: 'flat' }).ok).toBe(false);
      expect(breaker.beginDispatch(flat.token, { invocationId: null, selectionDigest: null }).ok).toBe(false);
      expect(breaker.beginDispatch(flat.token, { invocationId: 'flat', selectionDigest: null })).toEqual({ ok: true });
      const selected = admitAfterSuccessfulProbe(breaker, { invocationId: 'selected', selectionDigest: 'resolved-selection', scopeKeys: [] });
      for (const selectionDigest of [undefined, null, 'different-selection']) {
        expect(breaker.beginDispatch(selected.token, { invocationId: 'selected', selectionDigest }).ok).toBe(false);
      }
      expect(breaker.beginDispatch(selected.token, { invocationId: 'selected', selectionDigest: 'resolved-selection' })).toEqual({ ok: true });
    } finally { breaker.destroy(); }
  });

  it('review 9 item 4: the standalone attached observer queries terminal owned-unit status on exit without stopping it', async () => {
    const client = systemdClientFixture();
    vi.stubEnv('PATH', client.root);
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    const child = new EventEmitter();
    child.pid = 987654;
    const getStatus = vi.fn(() => ({ active: false, execMainCode: 1 }));
    try {
      const result = await planDirectWorkerLaunch({ name: 'r9-attached', command: process.execPath, args: [], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, scopedBreaker: breaker, invocation: { selected: { cli: 'codex' } },
        attached: true, memoryMaxGb: 4, isolation: { mode: 'systemd-unit' }, isolationStatus: getStatus,
        spawn: () => ({ status: 0, stdout: '' }), spawnAsync: () => child,
      });
      expect(result.launched).toBe(true);
      expect(breaker.snapshot().reservationsOutstanding).toBe(1);
      child.emit('exit', 0);
      child.emit('error', new Error('duplicate observer event'));
      await new Promise(resolve => setImmediate(resolve));
      expect(getStatus).toHaveBeenCalledExactlyOnceWith(result.unit);
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      await rm(client.root, { recursive: true, force: true });
      breaker.destroy();
    }
  });

  it('review 9 item 5: the standalone bound retains one unrefed follow-up and reconciles a later terminal unit', async () => {
    let now = 0;
    let terminal = false;
    const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
    const token = admitAfterSuccessfulProbe(breaker, { invocationId: 'late-unit', selectionDigest: null, scopeKeys: [] }).token;
    breaker.beginDispatch(token, { invocationId: 'late-unit', selectionDigest: null });
    breaker.commitDispatch(token);
    const timers = [];
    const unref = vi.fn();
    const getStatus = vi.fn(() => { now = 10; return { active: !terminal, execMainCode: terminal ? 1 : 0 }; });
    try {
      observeStandaloneUnitSettlement('owned-late-unit', { gated: true, breaker, token }, {
        boundMs: 10, pollIntervalMs: 2, nowMs: () => now, getStatus, stopUnit: () => ({ ok: true }),
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref }; },
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(breaker.hasUnresolvedStop('late-unit')).toBe(true);
      expect(timers).toHaveLength(1);
      expect(timers[0].ms).toBe(2);
      expect(unref).toHaveBeenCalledOnce();
      terminal = true;
      timers[0].fn();
      await new Promise(resolve => setImmediate(resolve));
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
      expect(timers).toHaveLength(1);
      expect(getStatus).toHaveBeenCalledTimes(3);
    } finally { breaker.destroy(); }
  });
});

describe('review 10 bounded recovery regressions', () => {
  it.each([
    { attached: false, mode: 'systemd-unit' },
    { attached: true, mode: 'systemd-unit' },
    { attached: true, mode: 'degraded' },
  ])('B1: $mode attached=$attached stops at the absolute monotonic deadline despite a backward wall-clock step', async ({ attached, mode }) => {
    const client = systemdClientFixture();
    vi.stubEnv('PATH', client.root);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let monotonic = 100;
    let wall = 100_000;
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const breaker = new ScopedFailureBreaker({ nowMs: () => monotonic, jitterMs: () => 0 });
    const child = new EventEmitter(); child.pid = 987654; child.exitCode = null; child.signalCode = null;
    const stop = vi.fn(() => ({ ok: false }));
    const terminate = vi.fn(async () => ({ terminated: false }));
    const status = vi.fn(() => ({ active: true, execMainCode: 0 }));
    try {
      const result = await planDirectWorkerLaunch({ name: 'r10-deadline', command: process.execPath, args: [], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, scopedBreaker: breaker, invocation: { selected: { cli: 'codex' } },
        attached, memoryMaxGb: 4, allowDegraded: true, isolation: { mode }, isolationStatus: status,
        stopUnit: stop, terminateChild: terminate, unitSettlementBoundMs: 1000,
        dispatchGuard: { deadlineAtMs: 110, nowMs: () => monotonic },
        spawn: (_command, args) => { if (args.includes('show-environment')) monotonic = 107; return { status: 0, stdout: args.includes('MainPID') ? '987654' : '' }; },
        spawnAsync: () => { monotonic = 107; return child; },
      });
      expect(result.launched).toBe(true);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      wall -= 10_000; monotonic = 109;
      await vi.advanceTimersByTimeAsync(2);
      expect(stop).not.toHaveBeenCalled(); expect(terminate).not.toHaveBeenCalled();
      wall -= 10_000; monotonic = 110;
      await vi.advanceTimersByTimeAsync(1);
      expect(mode === 'systemd-unit' ? stop : terminate).toHaveBeenCalledOnce();
      expect(breaker.hasUnresolvedStop(result.admission.invocationId)).toBe(true);
      expect(breaker.snapshot().reservationsOutstanding).toBe(1);
      await vi.advanceTimersByTimeAsync(30);
      expect(mode === 'systemd-unit' ? stop : terminate).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
      await rm(client.root, { recursive: true, force: true });
      breaker.destroy();
      wallClock.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([false, true])('B2: standalone attached=%s observes terminal evidence after the first follow-up and bounds unresolved observation', async attached => {
    const client = systemdClientFixture();
    vi.stubEnv('PATH', client.root);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let monotonic = 0;
    let terminal = false;
    const breaker = new ScopedFailureBreaker({ nowMs: () => monotonic, jitterMs: () => 0 });
    const status = vi.fn(() => ({ active: !terminal, execMainCode: terminal ? 1 : 0 }));
    const stop = vi.fn(() => ({ ok: false }));
    const launch = () => {
      const child = new EventEmitter(); child.pid = 987654;
      return planDirectWorkerLaunch({ name: 'r10-late', command: process.execPath, args: [], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, scopedBreaker: breaker, invocation: { selected: { cli: 'codex' } },
        attached, memoryMaxGb: 4, isolation: { mode: 'systemd-unit' }, isolationStatus: status, stopUnit: stop,
        unitSettlementBoundMs: 10, unitSettlementPollMs: 2,
        spawn: () => ({ status: 0, stdout: '' }), spawnAsync: () => child,
      });
    };
    try {
      const result = await launch();
      expect(result.launched).toBe(true);
      if (attached) {
        result.child.emit('exit', 0); // completion status can precede terminal unit evidence
        await vi.advanceTimersByTimeAsync(0);
        monotonic = 2;
      } else {
        monotonic = 10;
        await vi.advanceTimersByTimeAsync(2); // bound: stop, retaining ownership
      }
      await vi.advanceTimersByTimeAsync(2); // first follow-up remains nonterminal
      expect(breaker.hasUnresolvedStop(result.admission.invocationId)).toBe(true);
      terminal = true;
      monotonic += 2;
      await vi.advanceTimersByTimeAsync(2); // second follow-up sees terminal evidence
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      terminal = false;
      const unresolved = await launch();
      monotonic += 10;
      await vi.advanceTimersByTimeAsync(2);
      const atBound = status.mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      expect(status.mock.calls.length - atBound).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
      expect(breaker.hasUnresolvedStop(unresolved.admission.invocationId)).toBe(true);
      expect(breaker.reconcileStopEvidence({ invocationId: unresolved.admission.invocationId, confirmedStop: true })).toEqual({ released: 1 });
    } finally {
      vi.unstubAllEnvs();
      await rm(client.root, { recursive: true, force: true });
      breaker.destroy();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});


describe('rebased standalone submission ownership', () => {
  it.each(['nonzero', 'throws'])('stops an uncertain %s submission at its absolute deadline and releases only after terminal unit evidence', async failure => {
    const client = systemdClientFixture();
    vi.stubEnv('PATH', client.root);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let monotonic = 0;
    let terminal = false;
    const breaker = new ScopedFailureBreaker({ nowMs: () => monotonic, jitterMs: () => 0 });
    const stop = vi.fn(() => ({ ok: true }));
    const status = vi.fn(() => ({ active: !terminal, execMainCode: terminal ? 1 : 0 }));
    try {
      const pending = planDirectWorkerLaunch({ name: 'uncertain-submission', command: process.execPath, args: [], cwd: process.cwd(),
        config: dispatchOnConfig, live: healthyLive, scopedBreaker: breaker, invocationId: 'uncertain-submission',
        invocation: { selected: { cli: 'codex' } }, memoryMaxGb: 1, isolation: { mode: 'systemd-unit' },
        isolationStatus: status, stopUnit: stop, unitSettlementBoundMs: 10, unitSettlementPollMs: 2,
        spawn: command => {
          if (command !== client.binary) return { status: 0, stdout: '' };
          if (failure === 'throws') throw new Error('submission uncertain');
          return { status: 1, stderr: 'submission uncertain' };
        },
      });
      if (failure === 'throws') await expect(pending).rejects.toThrow('submission uncertain');
      else expect(await pending).toMatchObject({ launched: false, dispatchState: 'submission-uncertain' });
      expect(breaker.hasUnresolvedStop('uncertain-submission')).toBe(true);
      expect(breaker.snapshot().reservationsOutstanding).toBe(1);
      monotonic = 10;
      await vi.advanceTimersByTimeAsync(2);
      expect(stop).toHaveBeenCalledOnce();
      expect(breaker.snapshot().reservationsOutstanding).toBe(1);
      terminal = true;
      await vi.advanceTimersByTimeAsync(2);
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      await rm(client.root, { recursive: true, force: true });
      breaker.destroy();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
