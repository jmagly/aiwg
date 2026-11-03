// Exercise settlement, stale events and real worker deadline races.
import { workerInvocationFixture } from '../../fixtures/worker-single-invocation.js';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleWorkerIdentity } from '../../../tools/ralph-external/process-monitor.mjs';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { observeChildClose, advanceUntilSettled, stopAndReap } from '../../helpers/worker-lifecycle.mjs';
import { waitForEmptyWorkerGroup } from '../../helpers/reaped-worker-spawn.mjs';

const roots: string[] = [];
const breakers: ScopedFailureBreaker[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const breaker of breakers.splice(0)) breaker.destroy();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const fixture = (options: any = {}) => workerInvocationFixture(options, { roots, breakers });

describe('launcher settlement races with controlled interleavings', () => {
  function attachedStandIn(pid: number) {
    const child: any = new EventEmitter();
    child.pid = pid; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    return child;
  }
  it('requires two matching leader observations of the same birth, not just one', async () => {
    const f = await fixture();
    const pid = 2147483646;
    const child = attachedStandIn(pid);
    const supervisor = sampleWorkerIdentity(process.pid)!;
    const leader = { ...supervisor, pid, pgid: pid, parentPid: process.pid, sessionId: pid, startTicks: '101' };
    const samples = [
      { ...leader, pgid: supervisor.pgid, sessionId: supervisor.sessionId }, // fork before setsid
      { ...leader, pgid: supervisor.pgid, sessionId: supervisor.sessionId },
      leader,
      leader,
    ];
    const sample = vi.fn(() => samples.shift() ?? { ...leader, startTicks: '101' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    const launched = new Promise(resolve => f.launcher.once('launched', resolve));
    const done = f.launch({ sampleIdentity: sample, launchIsolated: () => ({ mode: 'degraded', child }) });
    await launched;
    await vi.advanceTimersByTimeAsync(20);
    child.emit('exit', 0, null); child.emit('close');
    await done;
    const record = JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8'));
    expect(record.worker).toMatchObject({ pid, pgid: pid, startTicks: '101' });
    expect(record.ownership).toBe('owned-group');
    expect(sample.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('never captures a PID reused between its inherited-group and leader observations', async () => {
    const f = await fixture();
    const pid = 2147483646;
    const child = attachedStandIn(pid);
    const supervisor = sampleWorkerIdentity(process.pid)!;
    const leader = { ...supervisor, pid, pgid: pid, parentPid: process.pid, sessionId: pid, startTicks: '101' };
    const sample = vi.fn(() => leader).mockReturnValueOnce({ ...leader,
      pgid: supervisor.pgid, sessionId: supervisor.sessionId, startTicks: '100' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    const launched = new Promise(resolve => f.launcher.once('launched', resolve));
    const done = f.launch({ sampleIdentity: sample, launchIsolated: () => ({ mode: 'degraded', child }) });
    await launched;
    await vi.advanceTimersByTimeAsync(250);
    child.emit('exit', 0, null); child.emit('close');
    await done;
    expect(JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8')))
      .toMatchObject({ worker: null, ownership: 'unknown', identityObservation: 'no-stable-owned-group' });
  });

  it.each(['inherited group', 'unowned single leader'])('bounds capture and records no stable owned group for %s', async kind => {
    const f = await fixture();
    const pid = 2147483646;
    const child = attachedStandIn(pid);
    const leader = { ...sampleWorkerIdentity(process.pid), pid, pgid: pid, parentPid: 1, sessionId: pid, startTicks: '100' };
    const sample = vi.fn(() => kind === 'inherited group' ? { ...leader, pgid: process.pid } : null);
    if (kind === 'unowned single leader') sample.mockReturnValueOnce(leader);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    const launched = new Promise(resolve => f.launcher.once('launched', resolve));
    const done = f.launch({ sampleIdentity: sample, launchIsolated: () => ({ mode: 'degraded', child }) });
    await launched;
    await vi.advanceTimersByTimeAsync(250);
    expect(sample.mock.calls.length).toBeGreaterThanOrEqual(50);
    expect(sample.mock.calls.length).toBeLessThanOrEqual(51);
    const count = sample.mock.calls.length;
    // The expired window stops rapid resampling; discovery continues at 50 ms.
    await vi.advanceTimersByTimeAsync(250);
    expect(sample.mock.calls.length - count).toBe(5);
    child.emit('exit', 0, null); child.emit('close');
    await done;
    expect(JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8')))
      .toMatchObject({ worker: null, ownership: 'unknown', identityObservation: 'no-stable-owned-group' });
    expect(vi.getTimerCount()).toBe(0);
    const settledCount = sample.mock.calls.length;
    await vi.advanceTimersByTimeAsync(250);
    expect(sample).toHaveBeenCalledTimes(settledCount);
  });

  it('rejects two matching samples of an unrelated same-uid leader for the direct-child fallback', async () => {
    // The stability window alone (two matching samples) only proves the
    // *same* process answered twice -- it says nothing about whose child it
    // is. A direct-child candidate must also be launcher-parented before it
    // is even eligible for that window: otherwise an unrelated same-uid
    // group leader (e.g. the OS reusing `child.pid` for something else
    // entirely after our own child exited before the immediate sample) is
    // accepted merely for repeating on two polls.
    const f = await fixture();
    const pid = 2147483646;
    const child = attachedStandIn(pid);
    const unrelated = { ...sampleWorkerIdentity(process.pid), pid, pgid: pid, parentPid: 1, startTicks: '999' };
    const sample = vi.fn(() => unrelated);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    const launched = new Promise(resolve => f.launcher.once('launched', resolve));
    const done = f.launch({ sampleIdentity: sample, launchIsolated: () => ({ mode: 'degraded', child }) });
    await launched;
    await vi.advanceTimersByTimeAsync(250);
    expect(sample.mock.calls.length).toBeGreaterThanOrEqual(50);
    child.emit('exit', 0, null); child.emit('close');
    await done;
    expect(JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8')))
      .toMatchObject({ worker: null, ownership: 'unknown', identityObservation: 'no-stable-owned-group' });
  });

  it('finalization cannot recover ownership from an unverified worker-writable start record', async () => {
    const f = await fixture();
    const pid = 2147483646;
    const child = attachedStandIn(pid);
    const forged = { ...sampleWorkerIdentity(process.pid), pid, pgid: pid, startTicks: '100' };
    await f.launch({ launchIsolated: (opts: any) => {
      writeFileSync(path.join(f.runDir, 'worker-identity.json'), JSON.stringify({
        invocationId: opts.name, supervisor: sampleWorkerIdentity(process.pid), worker: forged,
      }), { mode: 0o600 });
      queueMicrotask(() => { child.emit('exit', 0, null); child.emit('close'); });
      return { mode: 'degraded', transportSupervisor: true, child };
    } });
    expect(JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8')))
      .toMatchObject({ worker: null, ownership: 'unknown', identityObservation: 'no-stable-owned-group' });
  });

  it('pins the transport birth synchronously, before the transport can exit and be reaped', async () => {
    // Root cause (#3003 residual): nativeSupervisor was previously sampled
    // only from inside observeIdentity's polling loop, after its first
    // `await transportRecord(...)` -- a real, unavoidable async disk read.
    // A worker fast enough to let the transport exit and be reaped during
    // that single await left nativeSupervisor permanently null (a dead pid
    // can never resample back to non-null), so finish()'s unverified-
    // diagnostic fallback could never fire and `worker` stayed null even
    // for a worker that ran completely normally. `sampleNativeSupervisor`
    // here returns a valid sample only until the first microtask turn --
    // i.e. only to a caller that samples synchronously, before any await --
    // deterministically reproducing that ordering without relying on real
    // process timing or host load.
    const f = await fixture();
    const pid = 2147483646;
    const child = attachedStandIn(pid);
    const transportBirth = { ...sampleWorkerIdentity(process.pid), pid: 987654, pgid: 987654, startTicks: '555' };
    let afterMicrotask = false;
    const sampleNativeSupervisor = vi.fn(() => (afterMicrotask ? null : transportBirth));
    const reported = { ...sampleWorkerIdentity(process.pid), pid: 555555, pgid: 555555,
      parentPid: transportBirth.pid, startTicks: '777' };
    await f.launch({ sampleNativeSupervisor, launchIsolated: (opts: any) => {
      writeFileSync(path.join(f.runDir, 'worker-identity.json'), JSON.stringify({
        invocationId: opts.name, supervisor: transportBirth, worker: reported,
      }), { mode: 0o600 });
      // `launchOneWorker` has its own real awaits (dynamic import, policy
      // revalidation, ...) before `captureOneWorker` even starts, so a
      // microtask queued before `f.launch(...)` is called fires too early
      // to distinguish anything -- it would have already run before the
      // early pin even has a chance to. Queuing it here, from inside
      // `launchIsolated`'s own synchronous callback, instead places it
      // immediately after that callback's synchronous return: still before
      // the capture loop's first real disk read (`await
      // transportRecord(...)`), which is the actual boundary this test
      // needs to straddle.
      queueMicrotask(() => { afterMicrotask = true; child.emit('exit', 0, null); child.emit('close'); });
      return { mode: 'degraded', transportSupervisor: true, child };
    } });
    // The pin happened before any await: the very first sample, taken
    // synchronously at capture start, is non-null.
    expect(sampleNativeSupervisor.mock.results[0]).toMatchObject({ value: transportBirth });
    expect(JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8')))
      .toMatchObject({ worker: reported, ownership: 'unknown', identityObservation: 'transport-reported-unverified',
        nativeSupervisor: transportBirth });
  });

  it('never re-acquires a worker identity once the transport has observably exited', async () => {
    // A transport pid can be reused by an unrelated process once the real
    // transport has exited; a children-scan or live resample keyed on that
    // pid number after that point could silently pivot onto it. Once
    // `sawExit` is true, the launcher must stop attempting any such live
    // resolution -- a dead transport can never produce a new, valid sample
    // anyway, so this is a pure safety stop. `close` (which settles
    // immediately) is withheld until after the mid-grace assertion so this
    // observes the launcher mid-poll, sawExit true but not yet settled --
    // not just its already-finished end state. `exit` is queued as a
    // microtask from inside `launchIsolated`'s own synchronous callback, so
    // it is enqueued -- and therefore runs -- strictly before the capture
    // loop's first `await transportRecord(...)` (a real disk read, never
    // faked) can even begin resolving. That ordering is deterministic;
    // *how long* the real read then takes is not, which is why the wait
    // below polls the real clock rather than assuming a fixed virtual-time
    // advance is enough real time for it to land -- the same reasoning as
    // `untilObserved` above, applied to a negative assertion: there is no
    // observable "it happened" event to wait for, so this waits a generous
    // real deadline while continuing to advance the capture loop's own
    // (fake) polling clock, and asserts the call never landed in that time.
    // This is exactly the in-flight case the entry-only check `!sawExit`
    // cannot catch by itself -- the condition is evaluated before that same
    // await, so a call already past it must re-check after resuming.
    const f = await fixture();
    const pid = 2147483646;
    const child = attachedStandIn(pid);
    const transportBirth = { ...sampleWorkerIdentity(process.pid), pid: 987654, pgid: 987654, startTicks: '555' };
    const sampleNativeSupervisor = vi.fn(() => transportBirth);
    const unrelatedChild = { ...sampleWorkerIdentity(process.pid), pid: 42, pgid: 42,
      parentPid: transportBirth.pid, startTicks: '999' };
    const sampleChildren = vi.fn(() => [unrelatedChild]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    const launched = new Promise(resolve => f.launcher.once('launched', resolve));
    const done = f.launch({ sampleNativeSupervisor, sampleChildren,
      launchIsolated: () => { queueMicrotask(() => child.emit('exit', 0, null));
        return { mode: 'degraded', transportSupervisor: true, child }; } });
    await launched;
    const deadline = Date.now() + 2000;
    while (!sampleChildren.mock.calls.length && Date.now() < deadline) {
      await vi.advanceTimersByTimeAsync(50);
      await new Promise(resolve => setImmediate(resolve));
    }
    // The children-scan fallback must never even be queried once the
    // transport's exit has been observed -- `unrelatedChild` passes every
    // shape check the fallback applies, so asserting the call never
    // happened is the only way to show it was never consulted at all.
    expect(sampleChildren).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    child.emit('close');
    await done;
    expect(JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8')))
      .toMatchObject({ worker: null, ownership: 'unknown', identityObservation: 'no-stable-owned-group' });
  });

  it.each(['withheld wait', 'zero wait', 'non-zero wait'])('reports delivered signal or observed status with %s', async wait => {
    const f = await fixture({ scenario: 'hang', hardTimeoutSeconds: 1 });
    // A real owned group exercises all production signal gates. Its wait
    // events are withheld from the launcher to model the transport blocked
    // in its synchronous exit-record fsync before mirroring the signal.
    const worker = spawn(process.execPath, ['-e',
      'const fs = require("fs"); fs.readFileSync(0); fs.writeSync(3, "EOF"); setInterval(() => {}, 1000);'],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    const closed = observeChildClose(worker);
    await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.stdio[3]!.once('data', resolve);
    });
    const child = attachedStandIn(worker.pid!);
    const actualKill = process.kill.bind(process);
    const delivered: any[] = [];
    let reaped: Promise<void> | undefined;
    const kill = vi.spyOn(process, 'kill').mockImplementation((target, sig) => {
      const ok = actualKill(target, sig);
      if (target === -worker.pid! && sig !== 0) {
        delivered.push([target, sig]);
        reaped = waitForEmptyWorkerGroup(worker.pid!).then(() => {
          if (wait !== 'withheld wait') {
            child.stdout.end(); child.stderr.end();
            child.emit('exit', wait === 'zero wait' ? 0 : 7, null); child.emit('close');
          }
        });
      }
      return ok;
    });
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
      const launched = new Promise(resolve => f.launcher.once('launched', resolve));
      const done = f.launch({ launchIsolated: () => ({ mode: 'degraded', child }) });
      await launched;
      const result = await advanceUntilSettled(done, { advance: vi.advanceTimersByTimeAsync,
        afterStep: async () => { await reaped; } });
      expect(delivered.length).toBeGreaterThan(0);
      expect(result).toMatchObject({ timedOut: true,
        exitCode: wait === 'withheld wait' ? null : wait === 'zero wait' ? 0 : 7,
        signal: wait === 'withheld wait' ? delivered.at(-1)![1] : null,
        workerTermination: wait === 'withheld wait' ? 'uncertain' : 'confirmed' });
      expect(JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8')).signal).toBe(result.signal);
      expect(vi.getTimerCount()).toBe(0);
      const attempts = kill.mock.calls.slice();
      child.emit('exit', 0, null); child.emit('close'); // stale wait cannot rewrite the record
      await vi.advanceTimersByTimeAsync(2000);
      expect(kill.mock.calls).toEqual(attempts);
      expect(vi.getTimerCount()).toBe(0);
      expect(JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8')).signal).toBe(result.signal);
    } finally { await stopAndReap(worker, closed, { ownedGroup: true }); }
  });
});


describe('worker lifecycle synchronization controls', () => {
  it('holds virtual time until the real-state barrier completes', async () => {
    let resolveBarrier!: () => void, resolveResult!: (value: string) => void;
    const barrier = new Promise<void>(resolve => { resolveBarrier = resolve; });
    const pending = new Promise<string>(resolve => { resolveResult = resolve; });
    const advance = vi.fn(async () => {});
    const driving = advanceUntilSettled(pending, { advance, afterStep: () => barrier, pause: async () => {} });
    await new Promise(resolve => setImmediate(resolve));
    expect(advance.mock.calls).toEqual([[5]]);
    resolveResult('confirmed'); resolveBarrier();
    expect(await driving).toBe('confirmed');
    expect(advance).toHaveBeenCalledOnce();
  });

  it('fails a never-settled worker without accepting missing termination proof', async () => {
    const advance = vi.fn(async () => {});
    await expect(advanceUntilSettled(new Promise(() => {}), { advance,
      maxMs: 12, pause: async () => {} })).rejects.toThrow('did not settle');
    expect(advance.mock.calls).toEqual([[5], [5], [2]]);
  });

  it('propagates a worker failure instead of accepting settlement', async () => {
    const failure = new Error('worker failed');
    await expect(advanceUntilSettled(Promise.reject(failure), {
      advance: async () => {}, pause: async () => {},
    })).rejects.toBe(failure);
  });

  it('subscribes before kill, drains both pipes and waits for close after exit', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn(() => { child.emit('exit', null, 'SIGKILL'); }) });
    const closed = observeChildClose(child);
    let reaped = false;
    const stopping = stopAndReap(child, closed).then(() => { reaped = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(reaped).toBe(false);
    expect(child.stdout.readableFlowing).toBe(true); expect(child.stderr.readableFlowing).toBe(true);
    child.emit('close', null, 'SIGKILL');
    await stopping;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(reaped).toBe(true);
  });
});
