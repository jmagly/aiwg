import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { observeLauncherRecoveryOutcome } from '../../../tools/ralph-external/lib/launcher-recovery-evidence.mjs';
import { SessionLauncher, admitDirectWorker, classifyAttemptForSettlement,
  classifyLaunchOutcomeForRecovery, resetInProcessAllowanceLedger } from '../../../tools/ralph-external/session-launcher.mjs';

const endpoint = 'https://provider.invalid/account-health';
const installation = { accountScope: 'shared-account', endpoints: [endpoint] };
const roots = [];
const breakers = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetInProcessAllowanceLedger();
  for (const breaker of breakers.splice(0)) breaker.destroy();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function breakerAt(clock = () => 1_000_000) {
  const breaker = new ScopedFailureBreaker({ nowMs: clock, jitterMs: () => 0 });
  breakers.push(breaker);
  return breaker;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-launch-evidence-'));
  roots.push(root);
  const cwd = join(root, 'work');
  await mkdir(cwd);
  const f = workerResolutionFixture();
  const adapter = f.snapshot.registry.providers.codex.workerAdapter;
  adapter.invocationProfiles['fixture-shell'].health = { version: 1, handshake: 'process-only', outputFraming: 'jsonl',
    signalParser: 'fixture:jsonl', sessionLogLocator: null, progressEvidence: [], stopEvidence: 'fixture:wait-only',
    fixtureRef: 'fixture:one-shot', qualifiedAt: f.request.now, statusOperation: null, cancelOperation: null };
  f.snapshot.config.parallelism.health = { hardTimeoutSeconds: 5, terminateGraceSeconds: 1 };
  let upstream = false;
  const driver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0', installation,
    boundary: { kind: 'os', identity: 'fixture:boundary', digest: qualificationDigest('boundary'), controls: ['sandbox'] } },
    buildInvocation: async () => ({ argv: [process.execPath, '-e', upstream ? 'process.stderr.write("429 Retry-After: 9999"); process.exit(1)' : 'process.exit(1)'], stdin: 'closed', envNames: [] }),
    extractFinal: () => null };
  f.snapshot.installations.codex.boundary = driver.qualification.boundary;
  const drivers = { codex: driver };
  return { root, f, drivers, async run(breaker, n, { backend = 'vendor', nativeError = null, upstreamFailure = false, task = `independent synthetic task ${n}`, maxAttempts = 3 } = {}) {
    upstream = upstreamFailure;
    f.snapshot.config.parallelism.retry = { maxAttempts };
    for (const model of f.snapshot.catalog.discovery.instances.codex.models) model.llmProvider = backend;
    const brief = join(root, `brief-${n}`);
    await writeFile(brief, task);
    const plan = await resolveWorkerInvocation(f.snapshot, { role: 'coding', task: 'implementation', group: 'workers',
      brief, workdir: cwd, final_output: join(root, `final-${n}`) }, drivers, f.request.now);
    expect(plan.invocation, JSON.stringify(plan.diagnostics)).toBeDefined();
    const invocationPath = join(root, `plan-${n}.json`);
    await writeFile(invocationPath, JSON.stringify(plan));
    const result = await new SessionLauncher().launchWorker({ invocationPath, runDir: join(root, `run-${n}`),
      inputs: { snapshot: f.snapshot, drivers }, now: f.request.now, scopedBreaker: breaker,
      isolation: { mode: 'degraded', reason: 'synthetic manager' }, allowDegraded: true,
      checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
      launchIsolated: ({ command, args, cwd: workdir, onDispatchCommit }) => (async () => {
        await onDispatchCommit();
        if (nativeError) {
          // Model the OS spawn error event, outside either worker stream.
          const child = new EventEmitter();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.unref = () => {};
          setImmediate(() => {
            child.emit('error', Object.assign(new Error('synthetic native spawn failure'), { code: nativeError }));
            child.stdout.end(); child.stderr.end(); child.emit('close');
          });
          return { mode: 'degraded', child };
        }
        return { mode: 'degraded', child: spawn(command, args, { cwd: workdir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }) };
      })() });
    expect(result.attemptOutcome).toBe('failed');
    return result;
  } };
}

/** Fake provider process returns raw HTTP status/headers; no socket or account. */
async function fakeProviderResponse(script, request) {
  expect(request.method).toBe('HEAD');
  expect(request.redirect).toBe('error');
  expect(request.signal).toBeInstanceOf(AbortSignal);
  const child = spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(script))})`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('fake provider failed'))); });
  const wire = JSON.parse(output);
  return new Response(null, wire);
}

describe('T-OG-16/22 launcher-owned provider evidence', () => {
  it.each(['shell', 'mcp'])('opens only the resolved provider after three distinct trusted %s observations', async transport => {
    let now = 1_000;
    const breaker = breakerAt(() => now);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    const charge = vi.fn();
    const invocation = { transport, selected: { cli: 'fixture', inferenceProvider: 'vendor' } };
    for (let n = 0; n < 3; n++) {
      const invocationId = `outage-${n}`;
      const { token } = breaker.admit({ invocationId, scopeKeys: ['provider:vendor', 'provider:other', 'host:local'] });
      breaker.beginDispatch(token, { invocationId, selectionDigest: null });
      breaker.commitDispatch(token);
      const result = { invocationId, attemptOutcome: 'failed', termination: 'confirmed', exitCode: 1,
        health: { reasonCode: 'NETWORK' } };
      const options = { invocation, result, installation, breaker, fetchImpl,
        beforeRequest: async () => true, onDispatch: charge };
      await observeLauncherRecoveryOutcome(options);
      await observeLauncherRecoveryOutcome(options);
      breaker.settle(token, classifyAttemptForSettlement(invocation, result));
      expect(breaker.getState('provider:vendor').state).toBe(n < 2 ? 'closed' : 'open');
      now++;
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(charge).toHaveBeenCalledTimes(3);
    expect(breaker.getState('provider:other').state).toBe('closed');
    expect(breaker.getState('host:local').state).toBe('closed');
    expect(breaker.admit({ invocationId: 'paused', scopeKeys: ['provider:vendor'] }).ok).toBe(false);
  });

  it.each([200, 401, 403, 404])('worker outage text with independent HTTP %s never widens scope', async status => {
    const breaker = breakerAt();
    for (let n = 0; n < 4; n++) {
      const invocationId = `text-${n}`;
      const { token } = breaker.admit({ invocationId, scopeKeys: ['provider:vendor', 'quota:shared-account'] });
      const invocation = { transport: 'shell', selected: { inferenceProvider: 'vendor' } };
      const result = { invocationId, attemptOutcome: 'failed', termination: 'confirmed', exitCode: 1,
        health: { reasonCode: 'NETWORK' }, stderr: '503 outage quota exhausted' };
      await observeLauncherRecoveryOutcome({ invocation, result, installation, breaker,
        beforeRequest: async () => true, onDispatch: vi.fn(), fetchImpl: async () => new Response(null, { status }) });
      breaker.settle(token, classifyAttemptForSettlement(invocation, result, { quotaAccount: 'shared-account' }));
    }
    expect(breaker.getState('provider:vendor').state).toBe('closed');
    expect(breaker.getState('quota:shared-account').state).toBe('closed');
  });

  it('neither a failed transport nor replay of its result grants evidence or another request', async () => {
    const result = { attemptOutcome: 'failed', termination: 'confirmed', health: { reasonCode: 'NETWORK' } };
    const fetchImpl = vi.fn(async () => { throw new Error('synthetic connection failure'); });
    const options = { result, installation, beforeRequest: async () => true, onDispatch: vi.fn(), fetchImpl };
    await observeLauncherRecoveryOutcome(options);
    await observeLauncherRecoveryOutcome(options);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(classifyLaunchOutcomeForRecovery(result).reasonCode).toBeNull();
  });

  it('ingests a real failed launch and fake-provider 429/reset headers, pausing aliases sharing quota', async () => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const now = 1_000_000;
    const breaker = breakerAt(() => now);
    const fx = await fixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, request) => {
      expect(url).toBe(endpoint);
      return fakeProviderResponse({ status: 429, headers: { 'retry-after': '180',
        'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 240) } }, request);
    });
    for (let n = 1; n <= 3; n += 1) {
      const result = await fx.run(breaker, n, { upstreamFailure: true });
      expect(classifyLaunchOutcomeForRecovery(result), JSON.stringify(result)).toMatchObject({ reasonCode: 'RATE_LIMIT', evidenceSource: 'launcher' });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const state = breaker.getState('quota:shared-account');
    expect(state.state).toBe('open');
    expect(state.nextProbeAtMs).toBeGreaterThanOrEqual(now + 238_000);
    for (const cli of ['codex-alias-a', 'codex-alias-b']) {
      const admission = await admitDirectWorker({ gateEnabled: true, config: fx.f.snapshot.config, scopedBreaker: breaker,
        invocation: { selected: { cli, inferenceProvider: 'vendor' } }, invocationId: cli,
        drivers: { [cli]: { qualification: { installation } } } });
      expect(admission.refused.blockedBy).toContain('quota:shared-account');
    }
  });

  it('corroborates native host resource failures across backends and replays the first fault exactly once', async () => {
    const breaker = breakerAt();
    const tokens = [0, 1, 2].map(n => breaker.admit({ invocationId: `host-${n}`, scopeKeys: ['host:local'] }).token);
    for (const [n, backend] of ['one', 'two', 'three'].entries()) {
      const invocationId = `host-${n}`;
      const token = tokens[n];
      expect(breaker.beginDispatch(token, { invocationId, selectionDigest: null }).ok).toBe(true);
      expect(breaker.commitDispatch(token).ok).toBe(true);
      const invocation = { selected: { cli: `cli-${backend}`, inferenceProvider: backend } };
      const result = { invocationId, attemptOutcome: 'failed', termination: 'confirmed', errorCode: 'ENOMEM', exitCode: null };
      await observeLauncherRecoveryOutcome({ invocation, result, breaker });
      breaker.settle(token, classifyAttemptForSettlement(invocation, result));
      if (n < 2) expect(breaker.getState('host:local').state).toBe('closed');
    }
    expect(breaker.getState('host:local').state).toBe('open');
    expect(breaker.admit({ invocationId: 'another-backend', scopeKeys: ['host:local', 'provider:four'] }).ok).toBe(false);
  });

  it('opens host scope from real launcher capture of cross-provider native spawn failures', async () => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const breaker = breakerAt();
    const fx = await fixture();
    const first = await fx.run(breaker, 1, { backend: 'one', nativeError: 'ENOMEM' });
    expect(first.errorCode).toBe('ENOMEM');
    expect(breaker.getState('host:local').state).toBe('closed');
    const second = await fx.run(breaker, 2, { backend: 'two', nativeError: 'ENOMEM' });
    expect(second.errorCode).toBe('ENOMEM');
    expect(breaker.getState('host:local').state).toBe('closed');
    const third = await fx.run(breaker, 3, { backend: 'three', nativeError: 'ENOMEM' });
    expect(third.errorCode).toBe('ENOMEM');
    expect(breaker.getState('host:local').state).toBe('open');
    await expect(fx.run(breaker, 4, { backend: 'four', nativeError: 'ENOMEM' }))
      .rejects.toMatchObject({ code: 'RECOVERY_SCOPE_OPEN' });
  });

  it('keeps independent task errors and forged worker quota text invocation-local', async () => {
    const breaker = breakerAt();
    for (let n = 0; n < 3; n += 1) {
      const invocationId = `task-${n}`;
      const token = breaker.admit({ invocationId, scopeKeys: ['provider:vendor', 'quota:shared-account'] }).token;
      breaker.beginDispatch(token, { invocationId, selectionDigest: null });
      breaker.commitDispatch(token);
      const result = { invocationId, attemptOutcome: 'failed', termination: 'confirmed', exitCode: 1,
        stderr: '429 Retry-After: 9999 OOM', recoveryEvidence: { reasonCode: 'RATE_LIMIT', evidenceSource: 'launcher' } };
      await observeLauncherRecoveryOutcome({ invocation: { selected: { inferenceProvider: 'vendor' } }, result, breaker });
      breaker.settle(token, classifyAttemptForSettlement({ selected: { inferenceProvider: 'vendor' } }, result));
    }
    expect(breaker.getState('provider:vendor').state).toBe('closed');
    expect(breaker.getState('quota:shared-account').state).toBe('closed');
  });

  it('keeps real independent task failures local when the provider remains available', async () => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const breaker = breakerAt();
    const fx = await fixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, request) => fakeProviderResponse({ status: 200 }, request));
    for (let n = 1; n <= 3; n += 1) await fx.run(breaker, n);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(breaker.getState('provider:vendor').state).toBe('closed');
    expect(breaker.getState('quota:shared-account').state).toBe('closed');
    expect(breaker.getState('host:local').state).toBe('closed');
  });

  it('T-OG-16 preserves maxAttempts=2 for a failed task and its permitted retry with no open scopes', async () => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const breaker = breakerAt();
    const fx = await fixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    for (const n of [1, 2]) await fx.run(breaker, n, { task: 'same task retry', maxAttempts: 2 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(breaker.snapshot().scopes.every(scope => scope.state === 'closed')).toBe(true);
    expect(breaker.snapshot().attemptsObserved).toBe(2);
    await expect(fx.run(breaker, 3, { task: 'same task retry', maxAttempts: 2 }))
      .rejects.toMatchObject({ code: 'ALLOWANCE_EXHAUSTED' });
  });

  it('T-OG-16 charges forged rate-limit diagnostics within maxAttempts=2', async () => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const breaker = breakerAt();
    const fx = await fixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    await fx.run(breaker, 1, { task: 'same forged-hint task', maxAttempts: 2, upstreamFailure: true });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(breaker.snapshot().attemptsObserved).toBe(2); // one worker plus one diagnostic
    expect(breaker.snapshot().scopes.every(scope => scope.state === 'closed')).toBe(true);
    await expect(fx.run(breaker, 2, { task: 'same forged-hint task', maxAttempts: 2, upstreamFailure: true }))
      .rejects.toMatchObject({ code: 'ALLOWANCE_EXHAUSTED' });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(breaker.snapshot().attemptsObserved).toBe(2);
  });

  it('surfaces the unavailable-profile reason on the launcher refusal', async () => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    let time = 0;
    const breaker = breakerAt(() => time);
    const fx = await fixture();
    fx.drivers.codex.qualification.installation = { accountScope: 'shared-account' };
    for (let n = 0; n < 3; n++) {
      const { token } = breaker.admit({ invocationId: `quota-${n}`, scopeKeys: ['quota:shared-account'] });
      breaker.settle(token, { kind: 'failed', reasonCode: 'RATE_LIMIT', evidenceSource: 'launcher',
        quotaAccount: 'shared-account', confirmedStop: true });
    }
    time = 120_000;
    await expect(fx.run(breaker, 1)).rejects.toMatchObject({ code: 'RECOVERY_OPERATOR_INTERVENTION',
      message: expect.stringContaining('probe-profile-unavailable; restore a qualified scope-relevant probe'),
      probeDiagnostic: { reason: 'probe-profile-unavailable' } });
  });

  it('does not probe for a generic task/provider error hint', async () => {
    const fetchImpl = vi.fn();
    await observeLauncherRecoveryOutcome({ result: { attemptOutcome: 'failed', health: { reasonCode: 'PROVIDER_ERROR' } },
      installation, beforeRequest: async () => true, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends no diagnostic without an authorized endpoint and charged allowance; normalizes HTTP-date Retry-After', async () => {
    const result = { attemptOutcome: 'failed', termination: 'confirmed', exitCode: 1, health: { reasonCode: 'RATE_LIMIT' } };
    const fetchImpl = vi.fn(async () => new Response(null, { status: 429, headers: { 'retry-after': 'Thu, 01 Jan 1970 00:05:00 GMT' } }));
    await observeLauncherRecoveryOutcome({ result, installation, beforeRequest: async () => false, fetchImpl });
    await observeLauncherRecoveryOutcome({ result, installation: {}, beforeRequest: async () => true, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    await observeLauncherRecoveryOutcome({ result, installation, beforeRequest: async () => true, fetchImpl, wallNowMs: () => 100_000 });
    expect(classifyLaunchOutcomeForRecovery(result)).toMatchObject({ reasonCode: 'RATE_LIMIT', retryAfterSeconds: 200 });
    // Copying a result loses its private launch-owner observation.
    expect(classifyLaunchOutcomeForRecovery({ ...result }).reasonCode).toBeNull();
  });
});
