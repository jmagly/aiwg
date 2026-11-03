import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { importImpl } from '../../_resolve-impl.mjs';
import {
  createRuleDeploymentInputPool,
  describeRuleDeploymentInputPool,
  disposeRuleDeploymentInputPool,
  adoptRuleDeploymentPlan,
  commitRuleDeploymentPlan,
  disposeRuleDeploymentPlan,
} from './rule-delivery.mjs';

const { trackTemporaryDirectory } = await importImpl(import.meta.url, 'utils/temporary-directory.js');
const { acquireProviderDeploymentLock } = await importImpl(import.meta.url, 'providers/deployment-lock.js');
const { signalChild } = await importImpl(import.meta.url, 'process/signal-child.mjs');
const DEFAULT_WORKER = fileURLToPath(new URL('./provider-prepare-worker.mjs', import.meta.url));
const CHECKOUT_NEEDS_TS_TRANSFORM = !fs.existsSync(fileURLToPath(new URL('../../../dist/src', import.meta.url)));
const PLAN_LIMIT = 256 * 1024 * 1024;

const defaultTransaction = {
  createPool: createRuleDeploymentInputPool,
  describePool: describeRuleDeploymentInputPool,
  disposePool: disposeRuleDeploymentInputPool,
  adopt: adoptRuleDeploymentPlan,
  commit: commitRuleDeploymentPlan,
  disposePlan: disposeRuleDeploymentPlan,
  isStale: error => error?.code === 'AIWG_RULE_DEPLOYMENT_STALE',
};

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validateJob(job, expectedOrder) {
  if (!job || job.order !== expectedOrder || !Number.isSafeInteger(job.order) ||
      typeof job.provider !== 'string' || !job.provider || typeof job.target !== 'string' || !path.isAbsolute(job.target) ||
      !Array.isArray(job.args) || job.args.some(value => typeof value !== 'string')) {
    throw new Error(`Invalid provider preparation job at order ${expectedOrder}`);
  }
}

function readPlan(response, expectedPath) {
  if (!exactKeys(response.plan, ['path', 'size', 'sha256']) || response.plan.path !== expectedPath ||
      !Number.isSafeInteger(response.plan.size) || response.plan.size < 2 || response.plan.size > PLAN_LIMIT ||
      !/^[a-f0-9]{64}$/.test(response.plan.sha256)) throw new Error('Invalid provider preparation plan descriptor');
  const stat = fs.lstatSync(expectedPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== response.plan.size) throw new Error('Invalid provider preparation plan file');
  const body = fs.readFileSync(expectedPath);
  if (body.length !== response.plan.size || createHash('sha256').update(body).digest('hex') !== response.plan.sha256) {
    throw new Error('Provider preparation plan digest mismatch');
  }
  return JSON.parse(body.toString('utf8'));
}

function prepareInChild({ job, attempt, sessionRoot, poolDescriptor, workerPath, workerEnv, activeChildren, timeoutMs }) {
  const scratch = path.join(sessionRoot, `${job.order}-${attempt}-${randomUUID()}`);
  fs.mkdirSync(scratch, { mode: 0o700 });
  const capability = randomBytes(32).toString('hex');
  const jobId = randomUUID();
  const expectedPlan = path.join(scratch, 'plan.json');
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], {
      cwd: process.cwd(),
      env: { ...process.env, ...workerEnv },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
      execArgv: CHECKOUT_NEEDS_TS_TRANSFORM ? ['--import', 'tsx'] : [],
    });
    activeChildren.add(child);
    const stderr = [];
    let stderrBytes = 0;
    child.stderr?.on('data', chunk => {
      const retained = chunk.subarray(0, Math.max(0, 1024 * 1024 - stderrBytes));
      if (retained.length) { stderr.push(Buffer.from(retained)); stderrBytes += retained.length; }
    });
    let settled = false;
    let outcome;
    let killTimer;
    let timedOut = false;
    let exited = false;
    let disconnected = false;
    let exitCode;
    let exitSignal;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      activeChildren.delete(child);
      if (child.connected) { try { child.disconnect(); } catch {} }
      if (outcome?.error) reject(outcome.error); else if (outcome) resolve(outcome.value);
      else reject(new Error(`Provider preparation worker exited ${child.exitCode ?? 'without status'} for ${job.provider}${stderrBytes ? `: ${Buffer.concat(stderr).toString('utf8').trim()}` : ''}`));
    };
    const stop = error => {
      if (settled) return;
      outcome = { error };
      try { signalChild(child, 'SIGTERM'); } catch {}
      if (!killTimer) {
        killTimer = setTimeout(() => { try { signalChild(child, 'SIGKILL'); } catch {} }, 2_000);
        killTimer.unref?.();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop(new Error(`Provider preparation timed out for ${job.provider}`));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', error => {
      // A spawn failure has no operating-system child to reap. Every error
      // after a pid is assigned still waits for exit and IPC disconnect below.
      if (!child.pid) { outcome = { error }; finish(); }
      else stop(error);
    });
    // Exit confirms termination; disconnect confirms pending IPC messages have
    // drained. Either event can arrive first. Keep workers active until both,
    // including workers that respond and retain an unexpected live handle.
    const finishAfterDisconnectAndExit = () => {
      if (!exited || !disconnected) return;
      if (outcome?.value && (exitCode !== 0 || exitSignal)) {
        outcome = { error: new Error(`Provider preparation worker exited ${exitSignal || exitCode || 'without status'} after responding for ${job.provider}`) };
      }
      if (!outcome) outcome = { error: new Error(`${timedOut ? 'Provider preparation timed out' : `Provider preparation worker exited ${exitCode ?? 'without status'}`} for ${job.provider}${stderrBytes ? `: ${Buffer.concat(stderr).toString('utf8').trim()}` : ''}`) };
      finish();
    };
    child.once('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      finishAfterDisconnectAndExit();
    });
    child.once('disconnect', () => {
      disconnected = true;
      finishAfterDisconnectAndExit();
    });
    child.once('message', response => {
      try {
        if (timedOut) throw new Error(`Provider preparation timed out for ${job.provider}`);
        if (!exactKeys(response, response?.type === 'error'
          ? ['version', 'type', 'capability', 'jobId', 'error']
          : ['version', 'type', 'capability', 'jobId', 'plan']) ||
          response.version !== 1 || response.capability !== capability || response.jobId !== jobId) {
          throw new Error('Invalid provider preparation worker response');
        }
        if (response.type === 'error') {
          if (!exactKeys(response.error, ['message']) || typeof response.error.message !== 'string') throw new Error('Invalid provider preparation worker error');
          throw new Error(`${job.provider}: ${response.error.message}`);
        }
        if (response.type !== 'prepared') throw new Error('Invalid provider preparation worker response type');
        outcome = { value: { detached: readPlan(response, expectedPlan), scratch, attempt } };
        // Closing the IPC channel lets the single-request worker exit normally;
        // the exit/disconnect handlers confirm termination and IPC drainage.
        if (child.connected) { try { child.disconnect(); } catch {} }
      } catch (error) { stop(error); }
    });
    child.send({ version: 1, type: 'prepare', capability, jobId, order: job.order, attempt, provider: job.provider,
      target: job.target, args: job.args, scratch, inputPool: poolDescriptor }, error => { if (error) stop(error); });
  });
}

/** Prepare provider projections in at most two subprocesses. The returned
 * session owns every stage and promotes them only through ordered commit(). */
export async function prepareProviderDeployments({
  srcRoot,
  jobs,
  maxConcurrency = 2,
  workerPath = DEFAULT_WORKER,
  workerEnv = {},
  timeoutMs = 120_000,
  transaction = defaultTransaction,
  onSessionRoot,
  signal = signalChild,
}) {
  if (typeof srcRoot !== 'string' || !path.isAbsolute(srcRoot) || !Array.isArray(jobs) || !jobs.length) throw new Error('Invalid provider preparation request');
  jobs.forEach(validateJob);
  const concurrency = Math.max(1, Math.min(2, Number.isSafeInteger(maxConcurrency) ? maxConcurrency : 2, jobs.length));
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-provider-prepare-'));
  const removeSession = trackTemporaryDirectory(sessionRoot);
  onSessionRoot?.(sessionRoot);
  const activeChildren = new Set();
  let pool;
  let poolDescriptor;
  let releaseLock;
  try {
    // Workers stage only; retain the shared lease through ordered promotion
    // and finalization so another project cannot invalidate their snapshots.
    releaseLock = await acquireProviderDeploymentLock();
    pool = transaction.createPool(srcRoot);
    poolDescriptor = transaction.describePool(pool);
  } catch (error) {
    try { if (pool) transaction.disposePool(pool); removeSession(); }
    finally { await releaseLock?.(); }
    throw error;
  }
  const prepared = new Array(jobs.length);
  let next = 0;
  let closed = false;
  let nextCommit = 0;
  const stopChildren = async () => {
    const children = [...activeChildren];
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return resolve();
      const hardKill = setTimeout(() => { try { signal(child, 'SIGKILL'); } catch {} }, 2_000);
      hardKill.unref?.();
      child.once('exit', () => { clearTimeout(hardKill); resolve(); });
      try { signal(child, 'SIGTERM'); } catch { /* escalation and exit confirmation remain required */ }
    })));
  };
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    try {
      await stopChildren();
      for (const item of prepared) if (item?.plan && !item.committed) transaction.disposePlan(item.plan);
      transaction.disposePool(pool);
      removeSession();
    } finally { await releaseLock(); }
  };
  const prepareOne = async (index, attempt = 0) => {
    // Never start a worker once the session is closed: it would outlive
    // cleanup, and anything it writes (e.g. the shared binding-index cache)
    // would land after its owner removed it.
    if (closed) throw new Error('Provider preparation session is closed');
    const raw = await prepareInChild({ job: jobs[index], attempt, sessionRoot, poolDescriptor, workerPath, workerEnv, activeChildren, timeoutMs });
    const plan = transaction.adopt(raw.detached, {
      scratch: raw.scratch,
      target: jobs[index].target,
      inputPool: pool,
      cleanup: () => fs.rmSync(raw.scratch, { recursive: true, force: true }),
    });
    return { ...raw, plan, committed: false };
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (;;) {
        if (closed) return;
        const index = next++;
        if (index >= jobs.length) return;
        prepared[index] = await prepareOne(index);
      }
    }));
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    get providers() { return jobs.map(job => job.provider); },
    run(work) { return releaseLock.run(work); },
    async commit(index) {
      if (closed) throw new Error('Provider preparation session is closed');
      if (index !== nextCommit) throw new Error(`Provider plans must commit in order: expected ${nextCommit}, received ${index}`);
      let item = prepared[index];
      try {
        let report;
        try { report = transaction.commit(item.plan); }
        catch (error) {
          if (!transaction.isStale(error) || item.attempt >= 1) throw error;
          item = prepared[index] = await prepareOne(index, item.attempt + 1);
          report = transaction.commit(item.plan);
        }
        item.committed = true;
        return report;
      } finally { nextCommit++; }
    },
    async dispose() { await cleanup(); },
  };
}
