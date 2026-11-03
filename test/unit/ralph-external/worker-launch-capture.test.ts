// Exercise launcher identity capture with controlled process observations.
import { workerInvocationFixture } from '../../fixtures/worker-single-invocation.js';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, lstat, open, rename } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishWorkerRecord } from '../../../tools/ralph-external/session-launcher.mjs';
import { sampleWorkerIdentity, createWorkerIdentityCapture } from '../../../tools/ralph-external/process-monitor.mjs';
import { launchIsolatedWorker, runWorkerTransport } from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { waitForCondition, advanceUntilSettled, observeChildClose, stopAndReap } from '../../helpers/worker-lifecycle.mjs';

const roots: string[] = [];
const breakers: ScopedFailureBreaker[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const breaker of breakers.splice(0)) breaker.destroy();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const fixture = (options: any = {}) => workerInvocationFixture(options, { roots, breakers });

describe('launcher load races with controlled interleavings', () => {
  afterEach(() => vi.useRealTimers());

  // process.json publishes go through the launcher's real (never faked)
  // sequential fs-write chain (open/write/fsync/rename), so a fake-timer
  // advance alone does not bound when a given write actually lands in
  // `observations` — only how many virtual ms of launcher polling preceded
  // it. A fixed iteration count of real-event-loop yields is itself a
  // disguised wall-clock assumption (each yield can resolve in well under a
  // millisecond, so it burns through any count near-instantly while real
  // disk I/O is still in flight). Poll on the real, unfaked clock instead:
  // the *condition* checked is always the real observed state (never a
  // guessed delay), and the deadline is only a generous safety net against
  // a genuinely hung write, not a correctness assumption.
  async function untilObserved(observations: any[], match: (value: any) => boolean, timeoutMs = 10000) {
    await waitForCondition(() => observations.some(match), timeoutMs);
  }

  function attachedStandIn(pid: number) {
    const child: any = new EventEmitter();
    child.pid = pid; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    return child;
  }

  it.each([true, false])('kills an attached transport whose startup is still blocked at the hard deadline, recovery=%s (#3532)', async recoveryEnabled => {
    const f = await fixture({ scenario: 'hang', hardTimeoutSeconds: 1 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    let transport: ReturnType<typeof spawn> | undefined;
    let closed!: Promise<unknown>;
    let stop!: ReturnType<typeof vi.spyOn>;
    let ready!: Promise<unknown>;
    const launched = new Promise(resolve => f.launcher.once('launched', resolve));
    const done = f.launch({ ...(recoveryEnabled ? {} : { scopedBreaker: null }),
      launchIsolated: (opts: any) => launchIsolatedWorker({ ...opts,
        isolation: { mode: 'degraded', reason: 'blocked transport fixture' }, allowDegraded: true,
        // Hold the real transport before its module loads, as when CI starves
        // startup. IPC is a gate, not a fixture-side timer or an early EOF.
        spawnAsync: (command: string, args: string[], options: any) => {
          const bootstrap = `process.send('ready'); await new Promise(resolve => process.once('message', resolve));
            process.argv = ${JSON.stringify([process.execPath, ...args])};
            await import(${JSON.stringify(new URL('../../../tools/ralph-external/lib/worker-isolation.mjs', import.meta.url).href)});`;
          transport = spawn(command, ['--input-type=module', '--eval', bootstrap], {
            ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          });
          closed = observeChildClose(transport);
          stop = vi.spyOn(transport, 'kill');
          ready = new Promise(resolve => transport!.once('message', resolve));
          return transport;
        },
      }) });
    try {
      await launched;
      await ready;
      expect(transport!.exitCode).toBeNull();
      expect(transport!.signalCode).toBeNull();
      await expect(lstat(f.recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const result = await advanceUntilSettled(done, { advance: vi.advanceTimersByTimeAsync,
        afterStep: async () => { if (stop.mock.calls.length) await closed; } });
      expect(result).toMatchObject({ timedOut: true, exitCode: null, termination: 'uncertain' });
      expect(['SIGTERM', 'SIGKILL']).toContain(result.signal);
      expect(transport!.signalCode).toBe(result.signal);
      expect(result.workerReportedExit).toBeNull();
      expect(JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8')).signal).toBe(result.signal);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.launcher.getPid()).toBeNull();
    } finally {
      if (transport) await stopAndReap(transport, closed);
    }
  });

  it.each([true, false])('reports TERM when attached transport exit arrives after KILL was also delivered, recovery=%s (#3532)', async recovery => {
    const f = await fixture({ hardTimeoutSeconds: 1 });
    const child = attachedStandIn(2147483646);
    child.exitCode = null; child.signalCode = null;
    // Closed pipes must not accidentally delay finish() long enough to hide
    // the race. Only the controlled exit event supplies the observed signal.
    child.stdout.end(); child.stderr.end();
    child.kill = vi.fn((signal: string) => {
      if (signal === 'SIGTERM') setTimeout(() => {
        child.signalCode = 'SIGTERM';
        child.emit('exit', null, child.signalCode);
        // Withhold close as well: the exit observation alone must win.
      }, 500);
      return true;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    const launched = new Promise(resolve => f.launcher.once('launched', resolve));
    const done = f.launch({ ...(recovery ? {} : { scopedBreaker: null }),
      sampleIdentity: () => null, sampleNativeSupervisor: () => null, sampleChildren: () => [],
      launchIsolated: () => ({ mode: 'degraded', transportSupervisor: true, child }) });
    await launched;
    // Hard deadline sends both signals; the kernel's TERM status is delivered
    // 500ms later, beyond the old fixed 100ms finalization tick.
    await vi.advanceTimersByTimeAsync(2100);
    const result = await done;
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(child.signalCode).toBe('SIGTERM');
    expect(result.signal).toBe(child.signalCode);
    expect(result).toMatchObject({ timedOut: true, stopReason: 'HARD_DEADLINE', termination: 'uncertain' });
    expect(JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8')).signal).toBe(child.signalCode);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])('keeps bounded uncertain KILL fallback when attached transport exit never arrives, recovery=%s (#3532)', async recovery => {
    const f = await fixture({ hardTimeoutSeconds: 1 });
    const child = attachedStandIn(2147483646);
    child.stdout.end(); child.stderr.end(); child.kill = vi.fn(() => true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    const launched = new Promise(resolve => f.launcher.once('launched', resolve));
    const done = f.launch({ ...(recovery ? {} : { scopedBreaker: null }),
      sampleIdentity: () => null, sampleNativeSupervisor: () => null, sampleChildren: () => [],
      launchIsolated: () => ({ mode: 'degraded', transportSupervisor: true, child }) });
    await launched;
    await vi.advanceTimersByTimeAsync(2100);
    expect(await done).toMatchObject({ signal: 'SIGKILL', timedOut: true, termination: 'uncertain' });
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records a fast-exiting direct worker from its single immediate owned leader sample', async () => {
    const f = await fixture();
    const pid = 2147483646;
    const child = attachedStandIn(pid);
    const leader = { ...sampleWorkerIdentity(process.pid), pid, pgid: pid,
      parentPid: process.pid, sessionId: pid, startTicks: '101' };
    const sample = vi.fn(() => null).mockReturnValueOnce(leader);
    await f.launch({ sampleIdentity: sample, launchIsolated: () => {
      queueMicrotask(() => { child.emit('exit', 0, null); child.emit('close'); });
      return { mode: 'degraded', child };
    } });
    expect(sample).toHaveBeenCalledExactlyOnceWith(pid);
    expect(JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8')))
      .toMatchObject({ worker: leader, ownership: 'owned-group', identityObservation: 'stable-owned-group' });
  });

  it('transport main records its fast-exiting direct worker from one owned leader sample', () => {
    const pid = 2147483646;
    const child = attachedStandIn(pid);
    const supervisor = sampleWorkerIdentity(process.pid)!;
    const leader = { ...supervisor, pid, pgid: pid, parentPid: process.pid, sessionId: pid, startTicks: '101' };
    const sample = vi.fn((target: number) => target === process.pid ? supervisor : null)
      .mockImplementationOnce(() => supervisor).mockImplementationOnce(() => leader);
    const record = vi.fn();
    const spawnWorker = vi.fn(() => child);
    const setExitCode = vi.fn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    runWorkerTransport({ command: '/fixture/worker', args: [], environment: {}, record,
      spawn: spawnWorker, sampleIdentity: sample, setExitCode, propagateSignal: vi.fn() });
    child.emit('exit', 0, null);
    expect(spawnWorker).toHaveBeenCalledWith('/fixture/worker', [], { env: {}, detached: true, stdio: 'inherit' });
    expect(sample.mock.calls.filter(([target]) => target === pid)).toHaveLength(1);
    expect(record.mock.calls.filter(([name]) => name === 'worker-identity.json')).toEqual([
      ['worker-identity.json', { supervisor, worker: leader, identityObservation: 'stable-owned-group' }],
    ]);
    expect(record).toHaveBeenCalledWith('worker-exit.json', expect.objectContaining({ worker: leader, exitCode: 0, signal: null }));
    expect(setExitCode).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts the capture window only when a valid candidate first becomes visible', () => {
    let clock = 0;
    const capture = createWorkerIdentityCapture({ now: () => clock });
    const pid = 2147483646;
    const leader = { ...sampleWorkerIdentity(process.pid), pid, pgid: pid, startTicks: '101' };
    for (clock = 0; clock <= 300; clock += 50) {
      expect(capture.observe(null)).toBeNull();
      expect(capture.observe({ pid: -1 })).toBeNull();
      expect(capture.expired()).toBe(false);
      expect(capture.started()).toBe(false);
    }
    expect(capture.observe(leader)).toBeNull();
    clock += 5;
    expect(capture.observe(leader)).toEqual(leader);
  });

  it('stalls the matching leader streak on null or invalid samples', () => {
    let clock = 0;
    const capture = createWorkerIdentityCapture({ now: () => clock });
    const pid = 2147483646;
    const leader = { ...sampleWorkerIdentity(process.pid), pid, pgid: pid, startTicks: '101' };
    expect(capture.observe(leader)).toBeNull();
    clock = 5;
    expect(capture.observe(null)).toBeNull();
    expect(capture.observe({ pid: -1 })).toBeNull();
    clock = 10;
    expect(capture.observe(leader)).toEqual(leader);
  });

  it('captures a leader first visible after more than 250 ms of null launcher samples', async () => {
    const f = await fixture();
    const pid = 2147483646;
    const child = attachedStandIn(pid);
    const leader = { ...sampleWorkerIdentity(process.pid), pid, pgid: pid, parentPid: process.pid, startTicks: '101' };
    const sample = vi.fn(() => null as any);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    const launched = new Promise(resolve => f.launcher.once('launched', resolve));
    const done = f.launch({ sampleIdentity: sample, launchIsolated: () => ({ mode: 'degraded', child }) });
    await launched;
    await vi.advanceTimersByTimeAsync(300);
    expect(sample).toHaveBeenCalledTimes(7); // Previous 50 ms cadence before visibility.
    sample.mockReturnValue(leader);
    await vi.advanceTimersByTimeAsync(55);
    expect(sample).toHaveBeenCalledTimes(9); // First leader at 350 ms, matching one at 355 ms.
    child.emit('exit', 0, null); child.emit('close');
    await done;
    expect(JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8')))
      .toMatchObject({ worker: leader, identityObservation: 'stable-owned-group' });
  });

  it('opens a fresh window for a stable candidate after a non-leader window expires', async () => {
    const f = await fixture();
    const pid = 2147483646;
    const child = attachedStandIn(pid);
    const leader = { ...sampleWorkerIdentity(process.pid), pid, pgid: pid, parentPid: process.pid, startTicks: '101' };
    const sample = vi.fn(() => ({ ...leader, pgid: process.pid }));
    const observations: any[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    const launched = new Promise(resolve => f.launcher.once('launched', resolve));
    const done = f.launch({ sampleIdentity: sample, launchIsolated: () => ({ mode: 'degraded', child }),
      publishRecord: async (runDir: string, name: string, value: any, inspect: any) => {
        if (name === 'process.json') observations.push(value);
        return publishWorkerRecord(runDir, name, value, inspect);
      } });
    await launched;
    await vi.advanceTimersByTimeAsync(250);
    expect(sample.mock.calls.length).toBeGreaterThanOrEqual(50);
    await untilObserved(observations, o => o.identityObservation === 'no-stable-owned-group');
    expect(observations).toContainEqual(expect.objectContaining({ identityObservation: 'no-stable-owned-group' }));
    sample.mockReturnValue(leader);
    await vi.advanceTimersByTimeAsync(55);
    child.emit('exit', 0, null); child.emit('close');
    await done;
    expect(JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8')))
      .toMatchObject({ worker: leader, identityObservation: 'stable-owned-group' });
  });

  it('keeps PID-reuse poisoning across fresh capture windows', () => {
    let clock = 0;
    const capture = createWorkerIdentityCapture({ now: () => clock });
    const pid = 2147483646;
    const leader = { ...sampleWorkerIdentity(process.pid), pid, pgid: pid, startTicks: '101' };
    expect(capture.observe({ ...leader, pgid: process.pid, startTicks: '100' })).toBeNull();
    clock = 300;
    expect(capture.expired()).toBe(true);
    expect(capture.observe(leader)).toBeNull();
    clock += 5;
    expect(capture.observe(leader)).toBeNull();
  });

  it('opens a fresh window when a candidate reappears after an expired window and null samples', () => {
    let clock = 0;
    const capture = createWorkerIdentityCapture({ now: () => clock });
    const pid = 2147483646;
    const leader = { ...sampleWorkerIdentity(process.pid), pid, pgid: pid, startTicks: '101' };
    expect(capture.observe(leader)).toBeNull();
    clock = 250;
    expect(capture.observe(null)).toBeNull();
    expect(capture.expired()).toBe(true);
    clock = 300;
    expect(capture.observe(leader)).toBeNull();
    expect(capture.expired()).toBe(false);
    clock += 5;
    expect(capture.observe(leader)).toEqual(leader);
  });

  it('transport main publishes identity once when group stabilization takes more than 250 ms', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-transport-capture-')); roots.push(root);
    const pid = 2147483646;
    const child = attachedStandIn(pid);
    const supervisor = sampleWorkerIdentity(process.pid)!;
    const leader = { ...supervisor, pid, pgid: pid, parentPid: process.pid, startTicks: '101' };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    const now = () => Number(process.hrtime.bigint()) / 1e6;
    const started = now();
    const sample = vi.fn((target: number) => target === process.pid ? supervisor
      : now() - started < 300 ? { ...leader, pgid: supervisor.pgid } : leader);
    const record = vi.fn((name: string, value: any) => writeFileSync(path.join(root, name), JSON.stringify(value)));
    const setExitCode = vi.fn();
    runWorkerTransport({ command: '/fixture/worker', args: [], environment: {}, record,
      spawn: () => child, sampleIdentity: sample, now, setExitCode, propagateSignal: vi.fn() });
    await vi.advanceTimersByTimeAsync(300);
    expect(sample.mock.calls.filter(([target]) => target === pid).length).toBeGreaterThanOrEqual(61);
    expect(record.mock.calls.filter(([name]) => name === 'worker-identity.json')).toHaveLength(0);
    await expect(readFile(path.join(root, 'worker-identity.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await vi.advanceTimersByTimeAsync(5);
    expect(JSON.parse(await readFile(path.join(root, 'worker-identity.json'), 'utf8')))
      .toMatchObject({ worker: leader, identityObservation: 'stable-owned-group' });
    child.emit('exit', 7, null);
    await vi.advanceTimersByTimeAsync(500);
    expect(record.mock.calls.filter(([name]) => name === 'worker-identity.json')).toHaveLength(1);
    expect(setExitCode).toHaveBeenCalledExactlyOnceWith(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['exit', 'error'])('transport main publishes null once only when the worker emits %s before stabilizing', async event => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-transport-capture-')); roots.push(root);
    const pid = 2147483646;
    const child = attachedStandIn(pid);
    const supervisor = sampleWorkerIdentity(process.pid)!;
    const nonLeader = { ...supervisor, pid, pgid: supervisor.pgid, parentPid: process.pid, startTicks: '101' };
    const sample = vi.fn((target: number) => target === process.pid ? supervisor : nonLeader);
    const record = vi.fn((name: string, value: any) => writeFileSync(path.join(root, name), JSON.stringify(value)));
    const setExitCode = vi.fn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    runWorkerTransport({ command: '/fixture/worker', args: [], environment: {}, record,
      spawn: () => child, sampleIdentity: sample, now: () => Number(process.hrtime.bigint()) / 1e6,
      setExitCode, propagateSignal: vi.fn() });
    await vi.advanceTimersByTimeAsync(300);
    expect(sample.mock.calls.filter(([target]) => target === pid).length).toBeGreaterThanOrEqual(61);
    expect(record.mock.calls.filter(([name]) => name === 'worker-identity.json')).toHaveLength(0);
    if (event === 'exit') child.emit('exit', 7, null);
    else child.emit('error', Object.assign(new Error('fixture spawn error'), { code: 'ENOENT' }));
    expect(JSON.parse(await readFile(path.join(root, 'worker-identity.json'), 'utf8')))
      .toMatchObject({ worker: null, identityObservation: 'no-stable-owned-group' });
    const count = sample.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(sample).toHaveBeenCalledTimes(count);
    expect(record.mock.calls.filter(([name]) => name === 'worker-identity.json')).toHaveLength(1);
    expect(setExitCode).toHaveBeenCalledExactlyOnceWith(event === 'exit' ? 7 : 127);
    expect(vi.getTimerCount()).toBe(0);
  });

});
