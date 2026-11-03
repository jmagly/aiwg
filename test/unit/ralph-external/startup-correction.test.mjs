import { rmSync as removeWorkerTree } from '../../helpers/worker-capture-cleanup.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { prepareWorkerInvocation, resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { importImpl } from '../../../tools/_resolve-impl.mjs';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { SessionLauncher, publishWorkerRecord, resetInProcessAllowanceLedger } from '../../../tools/ralph-external/session-launcher.mjs';

// Match the launcher's owner before fixture-time source overrides. A built
// checkout otherwise registers source capabilities against a dist owner.
const { registerWorkerRecoveryCapabilities } = await importImpl(import.meta.url, 'models/worker-installation.mjs');

const roots = [];
const breakers = [];
afterEach(() => {
  vi.unstubAllEnvs();
  resetInProcessAllowanceLedger();
  for (const breaker of breakers.splice(0)) breaker.destroy();
  for (const root of roots.splice(0)) removeWorkerTree(root, { recursive: true, force: true });
});

async function fixture(settings = {}) {
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-startup-correction-'));
  roots.push(root);
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  const captureRoot = path.join(root, 'ledger');
  fs.mkdirSync(captureRoot, { mode: 0o700 });
  const f = workerResolutionFixture();
  f.snapshot.config.parallelism.retry = { maxAttempts: settings.maxAttempts ?? 3 };
  f.snapshot.config.parallelism.health = { hardTimeoutSeconds: 5, terminateGraceSeconds: 1 };
  const adapter = f.snapshot.registry.providers.codex.workerAdapter;
  adapter.invocationProfiles['fixture-shell'].health = { version: 1, handshake: 'process-only', outputFraming: 'jsonl',
    signalParser: 'fixture:jsonl', sessionLogLocator: null, progressEvidence: [], stopEvidence: 'fixture:wait-only',
    fixtureRef: 'fixture:one-shot', qualifiedAt: f.request.now, statusOperation: null, cancelOperation: null };
  const brief = path.join(root, 'brief');
  fs.writeFileSync(brief, 'synthetic correction task');
  let executable = '/qualified/old-worker';
  let extraArgument = 'same';
  let loads = 0;
  let dispatches = 0;
  let now = 1_000;
  let cancelled = false;
  const finalClaims = { version: 1, status: 'completed', summary: 'Synthetic corrected worker',
    claims: [], artifacts: [], checks: [], limitations: [] };
  const driver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0',
    boundary: { kind: 'os', identity: 'fixture:boundary', digest: qualificationDigest('boundary'), controls: ['sandbox'] } },
    buildInvocation: async input => ({ argv: [executable, '--final-output', input.finalPath,
      settings.embeddedOutput ? `unrelated-prefix:${input.finalPath}` : extraArgument], stdin: 'closed', envNames: [] }),
    extractFinal: text => { try { return JSON.parse(text).result; } catch { return null; } } };
  if (settings.requalify) {
    const evidence = { scopeDigest: qualificationDigest('old binary identity'), fixtureDigest: qualificationDigest('negative fixtures'),
      verifiedAt: f.request.now, evidenceRef: 'fixture:qualified-binary' };
    adapter.invocationProfiles['fixture-shell'].installationQualification = { ...evidence };
    driver.qualification.installation = { executable, evidence: { ...evidence }, cwd,
      workerWritableRoots: [cwd], boundary: driver.qualification.boundary };
    // Simulated installed-owner recheck: the resolver still validates the
    // production installation/selection proof shape, without touching a host
    // installation or any credential store.
    driver.prepareWorkerInvocation = async (invocation, qualification) => {
      expect(qualification.installation.executable).toBe(invocation.argv[0]);
      expect(qualification.installation.evidence.scopeDigest).toBe(invocation.selected.qualificationDigest);
      return prepareWorkerInvocation(invocation, qualification);
    };
  }
  registerWorkerRecoveryCapabilities(driver, { parseWorkerAttemptFinal: async () => ({ status: 'completed' }) });
  f.snapshot.installations.codex.boundary = driver.qualification.boundary;
  const drivers = { codex: driver };
  const breaker = new ScopedFailureBreaker({ nowMs: () => now, jitterMs: () => 0 });
  breakers.push(breaker);
  const launch = async (name = 'initial') => {
    const request = { role: 'coding', task: 'implementation', group: 'workers', brief, workdir: cwd,
      final_output: path.join(root, `final-${name}`) };
    const plan = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
    expect(plan.invocation, JSON.stringify(plan.diagnostics)).toBeDefined();
    const invocationPath = path.join(root, `plan-${name}.json`);
    fs.writeFileSync(invocationPath, JSON.stringify(plan));
    return new SessionLauncher().launchWorker({ invocationPath, runDir: path.join(root, `run-${name}`), captureRoot,
      loadInputs: async () => {
        loads += 1;
        if (loads === 3 && settings.expireOnRefresh) now = 6_000;
        if (loads === 3 && settings.cancelOnRefresh) cancelled = true;
        if (loads === 4 && settings.cancelBeforeRetry) cancelled = true;
        if (loads === 3 && settings.invalidateStop) {
          const filename = path.join(root, `run-${name}`, 'exit.json');
          const record = JSON.parse(fs.readFileSync(filename));
          fs.writeFileSync(filename, JSON.stringify({ ...record, termination: 'uncertain' }), { mode: 0o600 });
        }
        if (settings.refuseQualification && dispatches > 0) throw new Error('synthetic qualification refusal');
        return { snapshot: f.snapshot, drivers };
      },
      now: f.request.now, scopedBreaker: settings.disabled ? null : breaker,
      publishRecord: async (runDir, name, record, inspect) => {
        if (settings.recordFailure && record.startupCorrection?.state === 'applied') throw new Error('synthetic correction record refusal');
        return publishWorkerRecord(runDir, name, record, inspect);
      },
      dispatchGuard: { nowMs: () => now, deadlineAtMs: 6_000, isCancelled: () => cancelled },
      checkDispatch: () => ({ enabled: !settings.disabled, ok: true, failures: [] }),
      isolation: { mode: 'degraded' }, allowDegraded: true,
      launchIsolated: async ({ onDispatchCommit, command }) => {
        await onDispatchCommit?.();
        dispatches += 1;
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
        if (settings.unconfirmed) child.pid = 2_000_000_000;
        setImmediate(() => {
          if (dispatches === 1) {
            if (!settings.unchanged) executable = '/qualified/refreshed-worker';
            if (settings.changeArgument) extraArgument = 'changed';
            if (settings.changeModel) f.snapshot.config.parallelism.groups.workers.members[0].model = 'synthetic-alternate';
            if (settings.changeBoundary) driver.qualification.boundary.identity = 'fixture:changed-boundary';
            if (settings.requalify) {
              const proof = adapter.invocationProfiles['fixture-shell'].installationQualification;
              proof.scopeDigest = qualificationDigest('new binary identity');
              driver.qualification.installation.executable = executable;
              driver.qualification.installation.evidence = { ...proof };
            }
            if (settings.cancel) cancelled = true;
            if (settings.expire) now = 6_000;
          }
          if (settings.rotateEachAttempt && dispatches > 2) executable = `/qualified/refreshed-worker-${dispatches}`;
          if (settings.workerText) {
            child.stderr.write('ENOENT command not found; MODEL; login required; waiting for stdin');
            child.emit('exit', 1, null);
          } else if (dispatches === 2 && settings.success) {
            expect(command).toBe('/qualified/refreshed-worker');
            child.stdout.write(`${JSON.stringify({ type: 'result', result: finalClaims })}\n`);
            child.emit('exit', 0, null);
          } else {
            child.emit('error', Object.assign(new Error('synthetic spawn error'), { code: settings.code ?? 'ENOENT' }));
          }
          child.stdout.end(); child.stderr.end(); child.emit('close');
        });
        return { mode: 'degraded', child };
      } });
  };
  return { root, launch, get dispatches() { return dispatches; }, get loads() { return loads; } };
}

describe('direct startup executable correction', () => {
  it('refreshes one qualified binding with fresh plan/output/run paths and keeps both attempts', async () => {
    const fx = await fixture({ success: true });
    const result = await fx.launch();
    expect(result.attemptOutcome).toBe('succeeded');
    expect(result.startupCorrection).toMatchObject({ action: 'refresh-executable-binding', state: 'applied',
      reasonCode: 'NOT_FOUND', retryInvocationId: result.invocationId });
    expect(fx.dispatches).toBe(2);
    const runs = fs.readdirSync(fx.root).filter(name => name.startsWith('run-'));
    expect(runs).toHaveLength(2);
    const records = runs.map(name => JSON.parse(fs.readFileSync(path.join(fx.root, name, 'process.json'))));
    expect(records.every(record => record.startupCorrection.state === 'applied')).toBe(true);
    const invocations = runs.map(name => JSON.parse(fs.readFileSync(path.join(fx.root, name, 'invocation.json'))));
    expect(new Set(invocations.map(record => record.paths.final)).size).toBe(2);
    expect(invocations.find(record => record.invocationId === result.invocationId).previousAttemptId)
      .toBe(result.startupCorrection.previousInvocationId);
    const chain = fs.readdirSync(path.join(fx.root, 'ledger', 'ledger'))[0];
    const ledgerFiles = fs.readdirSync(path.join(fx.root, 'ledger', 'ledger', chain));
    expect(ledgerFiles.filter(name => /^correction-\d+\.charged$/.test(name))).toHaveLength(1);
    expect(ledgerFiles.filter(name => /^attempt-\d+\.charged$/.test(name))).toHaveLength(2);
  });

  it.each([
    ['remaining attempt allowance', { maxAttempts: 1 }, 'ATTEMPT_LIMIT'],
    ['cancellation', { cancel: true }, 'CANCELLED'],
    ['original deadline', { expire: true }, 'DEADLINE'],
    ['deadline during refresh', { expireOnRefresh: true }, 'DEADLINE'],
    ['cancellation during refresh', { cancelOnRefresh: true }, 'CANCELLED'],
    ['cancellation before retry dispatch', { cancelBeforeRetry: true }, 'CANCELLED'],
    ['disk-verified predecessor stop', { invalidateStop: true }, 'RETRY_REFUSED'],
    ['unchanged executable', { unchanged: true }, 'UNCHANGED_EXECUTABLE'],
    ['failed fresh qualification', { refuseQualification: true }, 'QUALIFICATION_REFUSED'],
    ['changed argument', { changeArgument: true }, 'BINDING_CHANGED'],
    ['changed model', { changeModel: true }, 'BINDING_CHANGED'],
    ['changed qualified boundary', { changeBoundary: true }, 'BINDING_CHANGED'],
    ['unrelated argument containing an output path', { embeddedOutput: true }, 'BINDING_CHANGED'],
    ['operator record publication', { recordFailure: true }, 'RETRY_REFUSED'],
  ])('stops at the %s bound', async (_name, settings, stopCode) => {
    const fx = await fixture(settings);
    const result = await fx.launch();
    expect(fx.dispatches).toBe(1);
    expect(result.startupCorrection).toMatchObject({ state: 'stopped', stopCode });
  });

  it('stops after one failed correction without a third automatic launch', async () => {
    const fx = await fixture();
    const result = await fx.launch();
    expect(fx.dispatches).toBe(2);
    expect(result.startupCorrection).toMatchObject({ state: 'stopped', stopCode: 'RETRY_FAILED' });
  });

  it('accepts freshly qualified installation proof digests while retaining effective controls', async () => {
    const fx = await fixture({ requalify: true, success: true });
    const result = await fx.launch();
    expect(result.attemptOutcome).toBe('succeeded');
    expect(result.startupCorrection.state).toBe('applied');
    expect(fx.dispatches).toBe(2);
  });

  it('retains the one-correction ceiling across subsequent invocations in the same task chain', async () => {
    const fx = await fixture({ success: true, rotateEachAttempt: true, maxAttempts: 4 });
    expect((await fx.launch()).startupCorrection.state).toBe('applied');
    const result = await fx.launch('again');
    expect(fx.dispatches).toBe(3);
    expect(result.startupCorrection).toMatchObject({ state: 'stopped', stopCode: 'RETRY_REFUSED' });
  });

  it.each(['EACCES', 'AUTH', 'TRUST', 'RESOURCE', 'MODEL', 'STDIN_WAIT'])('never corrects %s', async code => {
    const fx = await fixture({ code });
    const result = await fx.launch();
    expect(fx.dispatches).toBe(1);
    expect(result.startupCorrection).toBeUndefined();
    expect(fx.loads).toBe(2);
  });

  it.each([{ workerText: true }, { unconfirmed: true }, { disabled: true }])('requires trusted evidence, confirmed stop and enabled recovery: %j', async settings => {
    const fx = await fixture(settings);
    const result = await fx.launch();
    expect(fx.dispatches).toBe(1);
    expect(result.startupCorrection).toBeUndefined();
    expect(fx.loads).toBe(2);
  });
});
