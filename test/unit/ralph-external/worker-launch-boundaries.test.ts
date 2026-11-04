// Exercise pre-spawn ownership, publication and signal authority boundaries.
import { workerInvocationFixture } from '../../fixtures/worker-single-invocation.js';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink, readdir, open, rename } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkerInvocation, revalidateWorkerInvocationPlan } from '../../../src/serve/worker-invocation.js';
import { signalOwnedWorker, publishWorkerRecord, beneath, realBeneath } from '../../../tools/ralph-external/session-launcher.mjs';
import { parseWorkerLaunchArgs, workerExitCode } from '../../../tools/ralph-external/index.mjs';
import { sampleWorkerIdentity } from '../../../tools/ralph-external/process-monitor.mjs';
import { launchIsolatedWorker } from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { observeChildClose, stopAndReap } from '../../helpers/worker-lifecycle.mjs';

const roots: string[] = [];
const breakers: ScopedFailureBreaker[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const breaker of breakers.splice(0)) breaker.destroy();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const fixture = (options: any = {}) => workerInvocationFixture(options, { roots, breakers });

describe('T-OG-23 pre-spawn boundaries and ownership', () => {
  it.each(['argv', 'brief', 'expired', 'digests'])('rejects changed %s before any launch', async kind => {
    const f = await fixture();
    if (kind === 'argv') f.plan.invocation!.argv!.push('--dangerously-skip-permissions');
    if (kind === 'brief') await writeFile(f.brief, 'changed');
    if (kind === 'expired') f.plan.invocation!.expiresAt = '2001-01-01T00:00:00Z';
    if (kind === 'digests') f.plan.digests.configDigest = qualificationDigest('changed');
    await writeFile(f.invocationPath, JSON.stringify(f.plan));
    await expect(f.launch({ launchIsolated: f.launchSpy })).rejects.toThrow();
    expect(f.launchSpy).not.toHaveBeenCalled();
    await expect(lstat(f.runDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reloads policy and expiry immediately before spawn', async () => {
    const f = await fixture();
    let loads = 0;
    await expect(f.launch({ loadInputs: async () => {
      if (++loads === 2) f.snapshot.config.parallelism!.worker_dispatch = false;
      return { snapshot: f.snapshot, drivers: f.drivers };
    }, launchIsolated: f.launchSpy })).rejects.toThrow(/differs|plan|disabled/);
    expect(loads).toBe(2);
    expect(f.launchSpy).not.toHaveBeenCalled();
  });

  it.each(['EROFS', 'EPERM'])('capture open %s prevents helper spawn and publishes no fake success', async code => {
    const f = await fixture();
    await expect(f.launch({ openCapture: async () => { throw Object.assign(new Error('synthetic capture open'), { code }); },
      launchIsolated: f.launchSpy })).rejects.toMatchObject({ code });
    expect(f.launchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8'))).toMatchObject({ exitCode: null, descendants: 'not-started', errorCode: code });
  });

  it('pins output ancestors while opening and refuses a replaced symlink before spawn', async () => {
    const f = await fixture();
    const outputDir = path.join(f.root, 'output'); await mkdir(outputDir);
    const outside = path.join(f.root, 'outside'); await mkdir(outside);
    const request = { ...f.plan.request!, final_output: path.join(outputDir, 'final.json') };
    const plan = await resolveWorkerInvocation(f.snapshot, request, f.drivers, f.request.now);
    await writeFile(f.invocationPath, JSON.stringify(plan));
    let replaced = false;
    await expect(f.launch({ launchIsolated: f.launchSpy, openCapture: async (target: string, flags: number, mode: number) => {
      if (!replaced) {
        replaced = true;
        await rename(outputDir, `${outputDir}-original`);
        await symlink(outside, outputDir);
      }
      return open(target, flags, mode);
    } })).rejects.toThrow();
    expect(f.launchSpy).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(`${outputDir}-original`)).toHaveLength(1);
  });

  it.each(['run-symlink', 'prompt-symlink', 'traversal', 'writable-root', 'prior-final'])('rejects %s before spawn', async kind => {
    const f = await fixture();
    let extra: any = {};
    if (kind === 'run-symlink') await symlink(f.cwd, f.runDir);
    if (kind === 'prompt-symlink') { await rm(f.brief); await symlink(f.invocationPath, f.brief); }
    if (kind === 'traversal') extra.runDir = `${f.root}/work tree/../run`;
    if (kind === 'writable-root') extra.runDir = path.join(f.cwd, 'run');
    if (kind === 'prior-final') await writeFile(f.final, 'prior final');
    await expect(f.launch({ ...extra, launchIsolated: f.launchSpy })).rejects.toThrow();
    expect(f.launchSpy).not.toHaveBeenCalled();
  });

  it('refuses an unavailable boundary without explicit degraded selection and resource denial', async () => {
    const f = await fixture();
    await expect(f.launch({ allowDegraded: false, launchIsolated: f.launchSpy })).rejects.toThrow(/allow-degraded/);
    await expect(f.launch({ checkDispatch: () => ({ enabled: true, ok: false }), launchIsolated: f.launchSpy })).rejects.toThrow(/gate/);
    expect(f.launchSpy).not.toHaveBeenCalled();
  });

  it.each(['pid-reuse', 'pgid-reuse', 'conductor', 'unowned', 'unknown', 'zero', 'init', 'negative', 'fractional', 'missing-supervisor'])('never signals %s', kind => {
    const own = sampleWorkerIdentity(process.pid)!;
    const identity: any = { ...own, pid: 54321, pgid: 54321 };
    const actual = { ...identity };
    if (kind === 'pid-reuse') actual.startTicks = `${own.startTicks}9`;
    if (kind === 'pgid-reuse') actual.pgid = 123;
    if (kind === 'conductor') { identity.pgid = own.pgid; identity.pid = own.pgid; Object.assign(actual, identity); }
    if (kind === 'unowned') identity.uid += 1;
    const unsafePid = new Map<string, number>([['zero', 0], ['init', 1], ['negative', -1], ['fractional', 1.5]]).get(kind);
    if (unsafePid !== undefined) { identity.pid = unsafePid; identity.pgid = unsafePid; Object.assign(actual, identity); }
    const kill = vi.fn();
    expect(signalOwnedWorker(kind === 'unknown' ? null : identity, 'SIGKILL', {
      sample: () => actual, group: () => [actual], kill, supervisor: kind === 'missing-supervisor' ? null : own,
    })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('adopts only explicit partial manual records and supports no-scratch context with unknowns', async () => {
    const f = await fixture();
    await mkdir(f.runDir, { mode: 0o700 });
    await writeFile(path.join(f.runDir, 'process.json'), JSON.stringify({ worker: { pid: process.pid }, exitCode: 0 }), { mode: 0o600 });
    const record = await f.launcher.adoptWorker({ runDir: f.runDir });
    expect(record).toMatchObject({ origin: 'manual', worker: { pid: process.pid, pgid: null, startTicks: null },
      exitCode: null, termination: 'uncertain', ownership: 'unknown' });
    expect(record.unavailable).toContain('confirmed-stop');
    const context = await f.launcher.adoptWorker({ worker: { pid: process.pid } });
    expect(context).toMatchObject({ runDir: null, coverage: 'conductor-context-only', ownership: 'unknown' });
    expect(context.observedWorker.pid).toBe(process.pid);
    const plan = f.plan;
    await expect(revalidateWorkerInvocationPlan(plan, f.snapshot, f.drivers, '2001-01-01T00:00:00Z')).rejects.toThrow();
  });

  it('rejects legacy bypass/loop flags in the one-shot parser', () => {
    const args = ['--launch-worker', '--invocation', '/plan.json', '--run-dir', '/run'];
    expect(parseWorkerLaunchArgs([...args, '--allow-degraded-worker'])).toMatchObject({ allowDegraded: true });
    for (const flag of ['--resume', '--provider', '--budget', '--dangerously-skip-permissions', '--launch-worker']) {
      expect(() => parseWorkerLaunchArgs([...args, flag])).toThrow();
    }
  });

  it('rejects relative launch paths at parse time, naming the flag (#3857)', () => {
    const base = { '--invocation': '/plan.json', '--run-dir': '/run' };
    for (const [flag, relative] of [['--invocation', 'plan.json'], ['--run-dir', '.eval-control/run'], ['--retry-of-run-dir', 'prev-run']] as const) {
      const values: Record<string, string> = { ...base, [flag]: relative };
      const args = ['--launch-worker', ...Object.entries(values).flat()];
      expect(() => parseWorkerLaunchArgs(args)).toThrow(`${flag} must be an absolute path; relative paths are not resolved against cwd.`);
    }
  });

  it('#2915 step 4: explicit retry IDs require a run directory', () => {
    const args = ['--launch-worker', '--invocation', '/plan.json', '--run-dir', '/run'];
    expect(parseWorkerLaunchArgs(args)).not.toHaveProperty('retryOf');
    expect(parseWorkerLaunchArgs([...args, '--retry-of', 'prev-1', '--retry-of-run-dir', '/prev-run']))
      .toMatchObject({ retryOf: { invocationId: 'prev-1', runDir: '/prev-run' } });
    expect(() => parseWorkerLaunchArgs([...args, '--retry-of', 'prev-1'])).toThrow(/together/);
    expect(parseWorkerLaunchArgs([...args, '--retry-of-run-dir', '/prev-run'])).toMatchObject({ retryOf: { runDir: '/prev-run' } });
  });

  it('T-OG-14 rejects unsupported platforms before helper spawn', async () => {
    const f = await fixture();
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await expect(f.launch({ launchIsolated: f.launchSpy })).rejects.toThrow(/qualified|plan|platform/);
      expect(f.launchSpy).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, 'platform', descriptor); }
  });
});

describe('MINOR regression (#2895): beneath() resolves symlinks, not just lexical prefixes', () => {
  it('a symlinked root and its real target are recognized as the same location', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-beneath-')); roots.push(root);
    const real = path.join(root, 'real'); await mkdir(real);
    const link = path.join(root, 'link'); await symlink(real, link);
    const nested = path.join(real, 'nested');
    // Lexically "link" and "real/nested" share no textual prefix at all, so
    // the lexical-only check this replaces would (unsafely) say "not
    // beneath" even though the symlink resolves to the exact same directory.
    expect(beneath(link, nested)).toBe(false);
    expect(await realBeneath(link, nested)).toBe(true);
    // And the reverse direction: a target reached only through the symlink
    // must also resolve as beneath the real root.
    const throughLink = path.join(link, 'nested');
    expect(beneath(real, throughLink)).toBe(false);
    expect(await realBeneath(real, throughLink)).toBe(true);
    // A genuinely unrelated directory stays not-beneath either way.
    const unrelated = path.join(root, 'elsewhere'); await mkdir(unrelated);
    expect(await realBeneath(link, unrelated)).toBe(false);
  });

  it('end-to-end: a symlinked worker-writable root cannot hide the run directory inside it', async () => {
    const f = await fixture();
    const real = path.join(f.root, 'real-writable'); await mkdir(real);
    const link = path.join(f.root, 'writable-link'); await symlink(real, link);
    (f.drivers as any).codex.qualification.installation = { workerWritableRoots: [link] };
    const runDir = path.join(real, 'nested-run');
    await expect(f.launch({ runDir, launchIsolated: f.launchSpy })).rejects.toThrow(/worker-writable/);
    expect(f.launchSpy).not.toHaveBeenCalled();
  });

  it('a missing run directory parent fails before spawn with an actionable error', async () => {
    const f = await fixture();
    const runDir = path.join(f.root, 'missing-parent', 'attempt-1');
    await expect(f.launch({ runDir, launchIsolated: f.launchSpy }))
      .rejects.toThrow(/run directory parent does not exist: .*missing-parent; create it \(mode 0700\)/);
    expect(f.launchSpy).not.toHaveBeenCalled();
  });
});

describe('#2895 round 2, item 2: workerExitCode precedence — uncertainty dominates', () => {
  it.each([
    { label: 'timeout-uncertain', result: { termination: 'uncertain', timedOut: true, errorCode: null, exitCode: null }, expected: 2 },
    { label: 'invalid-final-uncertain', result: { termination: 'uncertain', timedOut: false, errorCode: 'FINAL_OUTPUT_INVALID', exitCode: 0 }, expected: 2 },
    { label: 'confirmed non-zero', result: { termination: 'confirmed', timedOut: false, errorCode: null, exitCode: 7 }, expected: 1 },
    { label: 'confirmed zero', result: { termination: 'confirmed', timedOut: false, errorCode: null, exitCode: 0 }, expected: 0 },
    { label: 'degraded clean-looking', result: { termination: 'uncertain', timedOut: false, errorCode: null, exitCode: 0 }, expected: 2 },
    { label: 'confirmed with stale errorCode', result: { termination: 'confirmed', timedOut: false, errorCode: 'FINAL_OUTPUT_INVALID', exitCode: 0 }, expected: 1 },
  ])('$label maps to exit code $expected', ({ result, expected }) => {
    expect(workerExitCode(result as any)).toBe(expected);
  });
});

describe('#2895 round 2, item 3: the final exit.json publish is always attempted', () => {
  it('a failing FINAL recordProcess() still results in a published exit.json', async () => {
    // Preparation must not consume the one-second dispatch budget merely
    // because a loaded runner delays filesystem work. Capture's real worker
    // timeout remains active; dispatch deadline enforcement is tested below.
    const f = await fixture({ recoveryClock: () => 0 });
    let processJsonAttempts = 0;
    const result = await f.launch({
      // Bypass the attached transport wrapper so there is no transport to
      // poll for identity (hasTransport stays false): the only identity
      // source is the launcher's own synchronous, pre-spawn `sampleIdentity`
      // call.
      //
      // That single call is pinned here rather than left to the real spawned
      // process: `observeIdentity()` only records its own post-spawn
      // process.json write when `identity` is already resolved (or its
      // 250ms capture window has expired) -- see session-launcher.mjs
      // `observeIdentity`'s `if (!identity && !identityCapture.expired())`
      // guard, which schedules a retry and returns *before* reaching the
      // write. A real worker that happens to exit (and get reaped) before
      // this synchronous sample runs leaves `identity` null, so that guard
      // fires and the post-spawn write never happens -- collapsing the
      // write count from 3 (pre-spawn, post-spawn, FINAL) to 2 (pre-spawn,
      // FINAL) purely depending on real process-exit timing (#3010 CI
      // flake: `expected 2 to be 3`). Injecting a deterministic
      // `sampleIdentity` that always resolves the launcher's own direct
      // child on its one synchronous call removes that race entirely: the
      // write count is pinned to exactly 3 regardless of host scheduling,
      // and the FINAL write (from finish()) is unambiguously the third and
      // last `process.json` publish attempt -- the one this test fails.
      sampleIdentity: (pid: number) => ({ pid, pgid: pid, uid: process.getuid!(), parentPid: process.pid,
        sessionId: pid, host: os.hostname(), bootId: 'fixture-boot-id', startTicks: '1',
        executable: process.execPath, state: 'R', cpuTicks: 0 }),
      launchIsolated: (opts: any) => (launchIsolatedWorker as any)({ ...opts, attached: false }),
      publishRecord: async (runDir: string, name: string, value: unknown, inspect: any) => {
        if (name === 'process.json') {
          processJsonAttempts += 1;
          if (processJsonAttempts === 3) throw new Error('synthetic final recordProcess failure');
        }
        return publishWorkerRecord(runDir, name, value, inspect);
      },
    });
    expect(processJsonAttempts).toBe(3);
    // Before the fix, recordProcess() and publish('exit.json', ...) were
    // chained in one try block, so this thrown failure skipped exit.json
    // entirely -- this read would reject ENOENT.
    const exit = JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8'));
    expect(exit.invocationId).toBe(result.invocationId);
    expect(exit.termination).toBe('uncertain');
    expect(exit.errorCode).toBe('METADATA_WRITE');
  });
});

describe('#3505: launch refusals preserve the underlying diagnostic', () => {
  it('reports a deadline exhausted during preparation without spawning a child', async () => {
    let now = 0;
    const f = await fixture({ recoveryClock: () => now, hardTimeoutSeconds: 1 });
    const spawnAsync = vi.fn();
    const launchIsolated = vi.fn((opts: any) => {
      expect(opts.onDispatchCommit).toBeTypeOf('function');
      // No sleep: admission succeeded at time zero, but preparation used
      // the entire one-second budget before the actual dispatch commit.
      now = 1000;
      return launchIsolatedWorker({ ...opts, attached: false, spawnAsync });
    });
    await expect(f.launch({ launchIsolated })).rejects.toThrow(
      'Worker launch refused: dispatch-commit: Worker dispatch refused: deadline exceeded before process start');
    expect(launchIsolated).toHaveBeenCalledOnce();
    expect(spawnAsync).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8'))).toMatchObject({
      termination: 'confirmed', descendants: 'not-started', errorCode: 'LAUNCH_REFUSED',
    });
  });

  it.each([
    { outcome: { blocked: true, failures: [{ signal: 'gate', reason: 'synthetic gate refusal' }] }, reason: 'gate: synthetic gate refusal' },
    { outcome: { launched: false, diagnostic: 'synthetic manager preparation failure' }, reason: 'synthetic manager preparation failure' },
    { outcome: { launched: false, error: 'synthetic spawn failure' }, reason: 'synthetic spawn failure' },
    { outcome: undefined, reason: 'Worker launch did not return an attached child' },
  ])('preserves $reason with recovery enabled and disabled', async ({ outcome, reason }) => {
    for (const recoveryEnabled of [true, false]) {
      const f = await fixture({ recoveryClock: () => 0 });
      await expect(f.launch({ ...(recoveryEnabled ? {} : { scopedBreaker: null }),
        launchIsolated: () => outcome })).rejects.toThrow(reason);
    }
  });
});

describe('#2895 round 2, item 4: a planted worker-exit.json cannot crash the transport into reporting the wrong exit code', () => {
  it('the reported exit code is the real worker exit, and the collision is a recorded anomaly, not a crash', async () => {
    const f = await fixture({ scenario: 'forge-exit', forgeRealExitCode: 42 });
    const result = await f.launch();
    // The forged worker-exit.json (planted by the worker itself, claiming a
    // clean exit) is still readable back as an unauthenticated hint.
    expect(result.workerReportedExit).toMatchObject({ exitCode: 0, signal: null, errorCode: null });
    // Before the fix, the trusted transport's own attempt to write the real
    // worker-exit.json after the forged file already existed threw
    // uncaught inside the `exit` handler, crashing the transport itself
    // before it ever reached `process.exitCode = code`. Node's default
    // exit code for an uncaught exception is 1 -- a different wrong value
    // than 42, silently losing the real exit code rather than merely
    // "not reporting 0".
    expect(result.exitCode).toBe(42);
    const anomaly = JSON.parse(await readFile(path.join(f.runDir, 'worker-exit.json.transport-anomaly.json'), 'utf8'));
    expect(anomaly.filename).toBe('worker-exit.json');
    expect(anomaly.invocationId).toBe(result.invocationId);
  });
});

describe('#2895 round 2, item 1: a forged identity record cannot authorize a signal against an unrelated process', () => {
  it('no signal reaches the unrelated process, and identity resolution stays uncertain', async () => {
    const f = await fixture({ scenario: 'hang', hardTimeoutSeconds: 1 });
    // Two independent, unrelated real processes, both owned by this test's
    // UID. `transportStandIn` stands in for the launcher's own trusted
    // transport child (`nativeSupervisor`); `victim` is the unrelated
    // same-UID process a forged worker-identity.json will name as the
    // "worker". Neither is an ancestor of the other -- only this test
    // process is their common parent -- so a correct kernel ancestry walk
    // from `victim` must never resolve to `transportStandIn`.
    const transportStandIn = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const victim = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const closed = [transportStandIn, victim].map(observeChildClose);
    const kill = vi.spyOn(process, 'kill');
    try {
      // Attach both 'spawn' listeners before awaiting either: the event can
      // fire as soon as the next tick, so awaiting the first process's
      // promise before even constructing the second one risks missing an
      // already-fired, one-shot 'spawn' event on the second process.
      await Promise.all([
        new Promise(resolve => transportStandIn.once('spawn', resolve)),
        new Promise(resolve => victim.once('spawn', resolve)),
      ]);
      const victimIdentity = sampleWorkerIdentity(victim.pid)!;
      const supervisorIdentity = sampleWorkerIdentity(transportStandIn.pid)!;
      const result = await f.launch({ launchIsolated: (opts: any) => {
        const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
        child.pid = transportStandIn.pid;
        // Forge worker-identity.json naming the unrelated victim as the
        // "worker", with a supervisor record that matches the real
        // transportStandIn exactly (same-UID worker can read /proc for
        // both and copy the fields verbatim).
        writeFileSync(path.join(opts.runDir, 'worker-identity.json'), JSON.stringify({
          invocationId: opts.name, supervisor: supervisorIdentity, worker: victimIdentity,
        }), { mode: 0o600 });
        return { mode: 'degraded', transportSupervisor: true, child };
      } });
      // The forged record resamples successfully (the victim is a real,
      // unchanged process) but fails kernel containment: no signal must
      // ever reach it.
      const signalsToVictim = kill.mock.calls.filter(call => call[0] === victim.pid || call[0] === -victim.pid);
      expect(signalsToVictim).toHaveLength(0);
      expect(victim.exitCode).toBeNull();
      expect(victim.signalCode).toBeNull();
      expect(result.termination).toBe('uncertain');
    } finally {
      await Promise.all([transportStandIn, victim].map((proc, index) =>
        stopAndReap(proc, closed[index], { ownedGroup: true })));
    }
  }, 15000);
});
