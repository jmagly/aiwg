// Replay corrected-brief/group retries using local owned-process evidence.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { trackWorkerProcess } from '../../fixtures/ralph-external/worker-process-inventory.mjs';
import { resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { SessionLauncher, resetInProcessAllowanceLedger } from '../../../tools/ralph-external/session-launcher.mjs';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { parseWorkerLaunchArgs } from '../../../tools/ralph-external/lib/worker-launch-cli.mjs';

const roots = [], breakers = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const breaker of breakers.splice(0)) breaker.destroy();
  resetInProcessAllowanceLedger();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const record = async (root, n, name = 'invocation') => JSON.parse(await readFile(join(root, `run-${n}`, `${name}.json`), 'utf8'));

async function fixture(recovery = true) {
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const root = await mkdtemp(join(tmpdir(), 'aiwg-retry-correction-')); roots.push(root);
  const work = join(root, 'work'); await mkdir(work);
  const brief = join(root, 'brief'); await writeFile(brief, 'Original synthetic instructions.');
  const f = workerResolutionFixture();
  f.snapshot.config.parallelism.groups.corrected = structuredClone(f.snapshot.config.parallelism.groups.workers);
  f.snapshot.models.defaults.workerSelection.roleGuidance.coding.groups.push('corrected');
  f.snapshot.models.defaults.workerSelection.taskClasses.bugfix = 'coding';
  f.snapshot.config.parallelism.retry = { maxAttempts: 4 };
  f.snapshot.config.parallelism.health = { hardTimeoutSeconds: 10, terminateGraceSeconds: 1 };
  const adapter = f.snapshot.registry.providers.codex.workerAdapter;
  const driver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0' },
    buildInvocation: async input => ({ argv: [process.execPath, resolve('test/fixtures/ralph-external/termination-worker.mjs'),
      'empty', input.finalPath, join(root, 'child.pid')], stdin: 'closed', envNames: [] }),
    extractFinal: () => ({ summary: 'Synthetic retry result.' }) };
  const inputs = { snapshot: f.snapshot, drivers: { codex: driver } };
  const breaker = new ScopedFailureBreaker({ nowMs: () => 0 }); breakers.push(breaker);
  const launchIsolated = vi.fn(options => {
    const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env,
      detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    trackWorkerProcess(child.pid);
    return { mode: 'degraded', child };
  });
  const plans = new Map();
  const attempt = async (n, { group = 'workers', task = 'implementation', workdir = work, ...extra } = {}) => {
    const plan = plans.get(n) ?? await resolveWorkerInvocation(f.snapshot, { role: 'coding', task, group,
      brief, workdir, final_output: join(root, `final-${n}`) }, inputs.drivers, f.request.now);
    expect(plan.invocation, JSON.stringify(plan.diagnostics)).toBeDefined();
    plans.set(n, plan); // Refused retries replay the same saved plan byte-for-byte.
    const invocationPath = join(root, `plan-${n}.json`); await writeFile(invocationPath, JSON.stringify(plan));
    return new SessionLauncher().launchWorker({ invocationPath, runDir: join(root, `run-${n}`), inputs, now: f.request.now,
      scopedBreaker: recovery ? breaker : null, allowDegraded: true,
      dispatchGuard: { nowMs: () => 0, deadlineAtMs: 10000 },
      checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
      isolation: { mode: 'degraded' }, launchIsolated, ...extra });
  };
  const uncertain = async n => {
    const exit = await record(root, n, 'exit');
    await writeFile(join(root, `run-${n}/exit.json`), JSON.stringify({ ...exit, termination: 'uncertain', descendants: 'unknown' }));
  };
  return { root, work, brief, attempt, uncertain, launchIsolated };
}

// Recorded direct-26/direct-30: changed brief/group, refused retry, then the
// same plan/run-dir relaunched with the linkage flag removed. No kit paths or
// provider calls are needed to reproduce the policy decision.
describe('T-OG-04 open predecessor and explicit correction (#3831)', () => {
  it.each(['direct-26', 'direct-30'])('refuses the recorded %s flagless relaunch and names its predecessor', async () => {
    const f = await fixture();
    const first = await f.attempt(1);
    expect(first.termination).toBe('confirmed');
    // Historical captures have only the original task digest and prompt/group.
    expect(await record(f.root, 1)).not.toHaveProperty('taskBindingDigest');
    await f.uncertain(1);
    await writeFile(f.brief, 'Corrected synthetic instructions.');
    const retryOf = { runDir: join(f.root, 'run-1') };
    await expect(f.attempt(2, { group: 'corrected', retryOf })).rejects.toMatchObject({ code: 'UNBOUND_RETRY_EVIDENCE' });
    await expect(f.attempt(2, { group: 'corrected' })).rejects.toMatchObject({ code: 'OPEN_TASK_PREDECESSOR',
      previousAttemptId: first.invocationId, runDir: retryOf.runDir, message: expect.stringContaining(first.invocationId) });
    expect(f.launchIsolated).toHaveBeenCalledTimes(1);
    await expect(readFile(join(f.root, 'run-2/invocation.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await record(f.root, 1, 'exit')).termination).toBe('uncertain');
  });

  it.each([true, false])('links a correction only after owned-stop proof (recovery=%s)', async recovery => {
    const f = await fixture(recovery);
    const first = await f.attempt(1);
    const original = await record(f.root, 1);
    await f.uncertain(1);
    await writeFile(f.brief, 'Corrected synthetic instructions.');
    const retryOf = { runDir: join(f.root, 'run-1'), correction: true };
    await expect(f.attempt(2, { group: 'corrected', retryOf })).rejects.toMatchObject({ code: 'UNCERTAIN_TERMINATION' });
    const second = await f.attempt(2, { group: 'corrected', retryOf, checkDescendants: true });
    expect(second.termination).toBe('confirmed');
    const corrected = await record(f.root, 2);
    expect(corrected).toMatchObject({ previousAttemptId: first.invocationId, taskDigest: original.taskDigest,
      retryCorrection: { oldBriefDigest: original.prompt.digest, newBriefDigest: corrected.prompt.digest,
        oldGroupDigest: qualificationDigest('workers'), newGroupDigest: qualificationDigest('corrected') } });
    expect(corrected.prompt.digest).not.toBe(original.prompt.digest);
    expect((await record(f.root, 1, 'exit')).termination).toBe('confirmed');
    // An ordinary confirmed-exit retry of the corrected inputs still binds.
    const third = await f.attempt(3, { group: 'corrected', retryOf: { runDir: join(f.root, 'run-2') } });
    expect(third.termination).toBe('confirmed');
    expect(await record(f.root, 3)).toMatchObject({ previousAttemptId: second.invocationId, taskDigest: original.taskDigest });
    expect(await record(f.root, 1)).toEqual(original);
  });

  it('refuses a same-input flagless launch with no exit record, across launcher instances', async () => {
    const f = await fixture();
    const first = await f.attempt(1);
    await rm(join(f.root, 'run-1/exit.json'));
    await expect(f.attempt(2)).rejects.toMatchObject({ code: 'OPEN_TASK_PREDECESSOR', previousAttemptId: first.invocationId });
    expect(f.launchIsolated).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing stable chain bound when only the workdir path changes', async () => {
    const f = await fixture();
    const first = await f.attempt(1);
    await f.uncertain(1);
    const workdir = join(f.root, 'other-work'); await mkdir(workdir);
    await expect(f.attempt(2, { workdir })).rejects.toMatchObject({ code: 'OPEN_TASK_PREDECESSOR', previousAttemptId: first.invocationId });
    expect(f.launchIsolated).toHaveBeenCalledTimes(1);
  });

  it('does not let a retry of an older confirmed attempt bypass another open predecessor', async () => {
    const f = await fixture();
    await f.attempt(1);
    const second = await f.attempt(2, { retryOf: { runDir: join(f.root, 'run-1') } });
    await f.uncertain(2);
    await expect(f.attempt(3, { retryOf: { runDir: join(f.root, 'run-1') } }))
      .rejects.toMatchObject({ code: 'OPEN_TASK_PREDECESSOR', previousAttemptId: second.invocationId });
    expect(f.launchIsolated).toHaveBeenCalledTimes(2);
  });

  it('keeps different tasks separate and permits a fresh launch after confirmed exit', async () => {
    const f = await fixture();
    await f.attempt(1);
    expect((await f.attempt(2)).termination).toBe('confirmed');
    expect((await record(f.root, 2)).previousAttemptId).toBeNull();
    await f.uncertain(1);
    expect((await f.attempt(3, { task: 'bugfix' })).termination).toBe('confirmed');
  });

  it('requires a predecessor for the explicit correction option', () => {
    const args = ['--launch-worker', '--invocation', '/plan', '--run-dir', '/run'];
    expect(() => parseWorkerLaunchArgs([...args, '--retry-correction'])).toThrow(/requires --retry-of-run-dir/);
    expect(parseWorkerLaunchArgs([...args, '--retry-of-run-dir', '/previous', '--retry-correction']))
      .toMatchObject({ retryOf: { runDir: '/previous', correction: true } });
    expect(() => parseWorkerLaunchArgs([...args, '--retry-of-run-dir', '/previous', '--retry-correction', '--retry-correction']))
      .toThrow(/Duplicate/);
  });

  it('does not authorize a task change through a correction', async () => {
    const f = await fixture();
    await f.attempt(1);
    await writeFile(f.brief, 'Corrected instructions.');
    await expect(f.attempt(2, { task: 'bugfix', retryOf: { runDir: join(f.root, 'run-1'), correction: true } }))
      .rejects.toMatchObject({ code: 'UNBOUND_RETRY_EVIDENCE' });
    expect(f.launchIsolated).toHaveBeenCalledTimes(1);
  });

  it.each(['brief', 'group'])('accepts an explicit %s-only correction after a confirmed exit', async changed => {
    const f = await fixture();
    const first = await f.attempt(1);
    if (changed === 'brief') await writeFile(f.brief, 'Corrected instructions.');
    await f.attempt(2, { group: changed === 'group' ? 'corrected' : 'workers',
      retryOf: { runDir: join(f.root, 'run-1'), correction: true } });
    const next = await record(f.root, 2);
    expect(next.previousAttemptId).toBe(first.invocationId);
    expect(next.retryCorrection.oldBriefDigest === next.retryCorrection.newBriefDigest).toBe(changed === 'group');
    expect(next.retryCorrection.oldGroupDigest === next.retryCorrection.newGroupDigest).toBe(changed === 'brief');
  });

  it('cannot use correction or descendant recheck to bypass missing owned identity', async () => {
    const f = await fixture();
    expect((await f.attempt(1, { sampleIdentity: () => null })).termination).toBe('uncertain');
    await writeFile(f.brief, 'Corrected instructions.');
    await expect(f.attempt(2, { group: 'corrected', checkDescendants: true,
      retryOf: { runDir: join(f.root, 'run-1'), correction: true } }))
      .rejects.toMatchObject({ code: 'UNCERTAIN_TERMINATION' });
    expect(f.launchIsolated).toHaveBeenCalledTimes(1);
  });
});
