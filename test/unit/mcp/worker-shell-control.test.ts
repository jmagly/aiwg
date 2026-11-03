import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — .mjs untyped
import { buildShellStopControl, parseShellUnitStatus, waitForUnitTermination, defaultStopShellUnit, defaultKillShellUnit } from '../../../src/mcp/tools/worker-shell-control.mjs';
// @ts-expect-error — .mjs untyped
import { prepareWorkerStdin, sweepWorkerStdin, launchPreparedShellWorker } from '../../../src/mcp/tools/worker-stdin-runtime.mjs';
// @ts-expect-error — .mjs untyped
import { resolveSystemdClient } from '../../../tools/ralph-external/lib/systemd-client.mjs';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'worker-control-test-'));
  roots.push(root);
  return root;
}
function childFixture() {
  const child: any = new EventEmitter();
  child.pid = 987654321;
  child.kill = vi.fn(() => true);
  return child;
}
/** Conductor PATH fixture holding an executable `systemctl`, plus a synthetic
 * hostile process environment: loader/bootstrap controls and an unlisted
 * value that must never reach an async control client, and one permitted
 * manager connection that must survive. Restored by afterEach. */
function stubConductorClientEnv() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'worker-shell-client-')));
  roots.push(root);
  const binary = path.join(root, 'systemctl');
  copyFileSync(process.execPath, binary);
  chmodSync(binary, 0o700);
  vi.stubEnv('PATH', root);
  vi.stubEnv('HOME', '/conductor/home');
  vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/synthetic-conductor');
  vi.stubEnv('LD_TRACE_LOADED_OBJECTS', '1');
  vi.stubEnv('NODE_OPTIONS', 'synthetic-node-options');
  vi.stubEnv('AIWG_TEST_UNLISTED', 'unlisted-value');
  return { root, binary };
}

function expectIsolatedClientEnv(env: any, root: string) {
  expect(env).toMatchObject({ PATH: root, HOME: '/conductor/home', XDG_RUNTIME_DIR: '/run/user/synthetic-conductor' });
  for (const name of ['LD_TRACE_LOADED_OBJECTS', 'NODE_OPTIONS', 'AIWG_TEST_UNLISTED']) {
    expect(env).not.toHaveProperty(name);
  }
}

const active = 'LoadState=loaded\nActiveState=active\nResult=success\nExecMainStatus=0\nExecMainCode=0\nMainPID=42\n';
const success = 'LoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\nExecMainCode=1\nMainPID=0\n';
const failed = 'LoadState=loaded\nActiveState=failed\nResult=exit-code\nExecMainStatus=7\nExecMainCode=1\nMainPID=0\n';
const killed = 'LoadState=loaded\nActiveState=failed\nResult=signal\nExecMainStatus=9\nExecMainCode=2\nMainPID=0\n';
const collected = 'LoadState=not-found\nActiveState=inactive\nResult=\nExecMainStatus=0\nExecMainCode=0\nMainPID=0\n';

describe('async systemd status and command path', () => {
  it.each([
    [active, { termination: 'uncertain', exitCode: null }],
    [success, { termination: 'confirmed', exitCode: 0, nativeResult: 'success' }],
    [failed, { termination: 'confirmed', exitCode: 7, nativeResult: 'exit-code' }],
    [killed, { termination: 'confirmed', exitCode: 9, signalCode: 9, nativeResult: 'signal' }],
    [collected, { termination: 'confirmed', exitCode: null }],
  ])('parses recorded show properties: %s', (stdout, expected) => {
    expect(parseShellUnitStatus(stdout)).toEqual(expected);
  });
  it('retains a loaded inactive unit without a terminal execution code', () => {
    expect(parseShellUnitStatus(success.replace('ExecMainCode=1', 'ExecMainCode=0')))
      .toEqual({ termination: 'uncertain', exitCode: null });
  });
  it.each(['', 'ActiveState=inactive', success.replace('ExecMainStatus=0', 'ExecMainStatus=bad'),
    collected.replace('ActiveState=inactive', 'ActiveState=active')])('rejects incomplete/unverified stop proof: %s', stdout => {
    expect(() => parseShellUnitStatus(stdout)).toThrow(/status unavailable/);
  });
  it('retries a transient show error without stopping and gives short probes a timeout floor', async () => {
    const { root, binary } = stubConductorClientEnv();
    let clock = 0;
    const exec = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce({ stdout: active })
      .mockResolvedValueOnce({ stdout: success });
    const abort = new AbortController();
    const outcome = await waitForUnitTermination('test.service', 80, { signal: abort.signal, exec,
      pollIntervalMs: 10, clock: () => clock, sleep: async (ms: number) => { clock += ms; } });
    expect(outcome).toEqual({ termination: 'confirmed', exitCode: 0, nativeResult: 'success' });
    expect(exec).toHaveBeenCalledTimes(3);
    for (const call of exec.mock.calls) {
      expect(path.isAbsolute(call[0])).toBe(true);
      expect(call[0]).not.toBe('systemctl');
      expect(call[0]).toBe(resolveSystemdClient('systemctl'));
      expect(call[0]).toBe(realpathSync(binary));
      expect(call[2].env).toBeDefined();
      expectIsolatedClientEnv(call[2].env, root);
    }
    expect(exec.mock.calls[0][1]).toEqual(expect.arrayContaining(['LoadState', 'ActiveState', 'MainPID']));
    expect(exec.mock.calls.every(call => call[2].timeout >= 1000 && call[2].signal === abort.signal)).toBe(true);
  });
  it('accepts a verified collected unit even when systemctl show exits nonzero', async () => {
    const { root, binary } = stubConductorClientEnv();
    const exec = vi.fn().mockRejectedValue({ code: 4, stdout: collected, stderr: 'Unit could not be found.' });
    expect(await waitForUnitTermination('test.service', 100, { exec }))
      .toEqual({ termination: 'confirmed', exitCode: null });
    expect(exec).toHaveBeenCalledOnce();
    const [invoked, args, options]: any[] = exec.mock.calls[0];
    expect(invoked).toBe(resolveSystemdClient('systemctl'));
    expect(invoked).toBe(realpathSync(binary));
    expect(args).toEqual(expect.arrayContaining(['--user', 'show', 'test.service']));
    expectIsolatedClientEnv(options.env, root);
  });
  it('cancels an in-flight show and produces no more probes after abort', async () => {
    const { root, binary } = stubConductorClientEnv();
    const abort = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const exec = vi.fn((_command: string, _args: string[], options: any) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      entered();
    }));
    const pending = waitForUnitTermination('test.service', 60000, { signal: abort.signal, exec });
    await ready;
    abort.abort();
    expect(await pending).toMatchObject({ termination: 'uncertain' });
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0][2].env).toBeDefined();
    const [invoked, args, options]: any[] = exec.mock.calls[0];
    expect(invoked).toBe(resolveSystemdClient('systemctl'));
    expect(invoked).toBe(realpathSync(binary));
    expect(args).toEqual(expect.arrayContaining(['--user', 'show', 'test.service']));
    expectIsolatedClientEnv(options.env, root);
  });
  it.each([['stop', defaultStopShellUnit], ['kill', defaultKillShellUnit]])('routes the default %s command through the canonical client with a filtered environment', async (verb, command) => {
    const { root, binary } = stubConductorClientEnv();
    const exec = vi.fn(async () => ({ stdout: '' }));
    const abort = new AbortController();
    expect(await command('test.service', { exec, signal: abort.signal, timeout: 17 })).toEqual({ ok: true });
    expect(exec).toHaveBeenCalledOnce();
    const [invoked, args, options]: any[] = exec.mock.calls[0];
    expect(invoked).toBe(resolveSystemdClient('systemctl'));
    expect(invoked).toBe(realpathSync(binary));
    expect(args).toEqual(expect.arrayContaining(['--user', verb, 'test.service']));
    if (verb === 'kill') expect(args).toEqual(expect.arrayContaining(['--kill-who=all', '--signal=SIGKILL']));
    expect(options.signal).toBe(abort.signal);
    expect(options.timeout).toBe(17);
    expectIsolatedClientEnv(options.env, root);
    exec.mockRejectedValueOnce(new Error('unavailable'));
    expect(await command('test.service', { exec })).toEqual({ ok: false });
  });
  it('isolates status probes from loader controls while keeping the manager connection', async () => {
    const { root, binary } = stubConductorClientEnv();
    const exec = vi.fn(async () => ({ stdout: success }));
    expect(await waitForUnitTermination('test.service', 100, { exec }))
      .toEqual({ termination: 'confirmed', exitCode: 0, nativeResult: 'success' });
    expect(exec).toHaveBeenCalledOnce();
    const [invoked, args, options]: any[] = exec.mock.calls[0];
    expect(invoked).toBe(resolveSystemdClient('systemctl'));
    expect(invoked).toBe(realpathSync(binary));
    expect(args).toEqual(expect.arrayContaining(['--user', 'show', 'test.service']));
    expect(options.timeout).toBeGreaterThanOrEqual(1000);
    expectIsolatedClientEnv(options.env, root);
  });
  it.skipIf(process.platform === 'win32')('executes a real stop/kill client under loader hijack instead of inheriting it', async ctx => {
    if (!existsSync('/bin/false')) { ctx.skip('no failing ELF binary available'); return; }
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'worker-shell-hijack-')));
    roots.push(root);
    const binary = path.join(root, 'systemctl');
    copyFileSync(realpathSync('/bin/false'), binary);
    chmodSync(binary, 0o700);
    vi.stubEnv('PATH', root);
    vi.stubEnv('LD_TRACE_LOADED_OBJECTS', '1');
    vi.stubEnv('NODE_OPTIONS', 'synthetic-node-options');
    // A hijacked loader prints its trace and exits 0 without running the
    // client, so only a real execution (exit 1 here) reports { ok: false }.
    expect(await defaultStopShellUnit('test.service')).toEqual({ ok: false });
    expect(await defaultKillShellUnit('test.service')).toEqual({ ok: false });
  });
});

describe('shell control lifetimes', () => {
  it.each([true, false])('bounds a never-executed inactive unit with stop then recheck (stop accepted: %s)', async accepted => {
    stubConductorClientEnv();
    let now = 0;
    const stdout = success.replace('ExecMainCode=1', 'ExecMainCode=0');
    const exec = vi.fn(async () => ({ stdout }));
    const stop = vi.fn(async () => ({ ok: accepted }));
    const kill = vi.fn(async () => ({ ok: false }));
    const onConfirmed = vi.fn();
    const control = buildShellStopControl({ launched: true, mode: 'systemd-unit', unit: 'never-exec.service' }, {
      graceMs: 10, nowMs: () => now, stopUnit: stop, killUnit: kill, onConfirmed, recheckMaxAttempts: 0,
      waitForUnit: (unit: string, ms: number, options: any) => waitForUnitTermination(unit, ms, {
        ...options, exec, clock: () => now, pollIntervalMs: 1000, sleep: async (delay: number) => { now += delay; },
      }),
    });
    try {
      const outcome = await control.wait(1);
      expect(stop).toHaveBeenCalledOnce();
      expect(exec.mock.calls.length).toBeGreaterThanOrEqual(2); // before stop and fresh recheck
      if (accepted) {
        expect(outcome).toMatchObject({ termination: 'confirmed', exitCode: null, neverExecuted: true, timedOut: true });
        expect(onConfirmed).toHaveBeenCalledOnce();
        expect(kill).not.toHaveBeenCalled();
      } else {
        expect(outcome).toMatchObject({ termination: 'uncertain', timedOut: true });
        expect(onConfirmed).not.toHaveBeenCalled();
        expect(kill).toHaveBeenCalledOnce();
      }
      expect(control.pollingStopped).toBe(true);
    } finally { control.dispose(); }
  });
  it('rejects epoch deadlines without the matching clock before polling or stopping', async () => {
    const observe = vi.fn();
    const stop = vi.fn();
    const control = buildShellStopControl({ launched: true, mode: 'systemd-unit', unit: 'clock.service' },
      { graceMs: 10, waitForUnit: observe, stopUnit: stop });
    try {
      await expect(control.wait(1000, { deadlineAtMs: Date.now() + 1000 })).rejects.toThrow(/same clock/);
      await expect(waitForUnitTermination('clock.service', 1000, { deadlineAtMs: Date.now() + 1000 }))
        .rejects.toThrow(/same clock/);
      expect(observe).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    } finally { control.dispose(); }
  });
  it('accepts an epoch deadline with an explicitly matching clock', async () => {
    const observe = vi.fn(async (_unit: string, _ms: number) => ({ termination: 'confirmed', exitCode: 0 }));
    const now = Date.now();
    const control = buildShellStopControl({ launched: true, mode: 'systemd-unit', unit: 'clock.service' },
      { graceMs: 10, waitForUnit: observe });
    try {
      await expect(control.wait(1000, { deadlineAtMs: now + 1000, nowMs: () => now }))
        .resolves.toMatchObject({ termination: 'confirmed', exitCode: 0 });
      expect(observe).toHaveBeenCalledOnce();
      expect(observe.mock.calls[0][1]).toBe(1000);
    } finally { control.dispose(); }
  });
  it('deadline escalation catches rejecting asynchronous stop and kill helpers and resolves uncertain', async () => {
    const stop = vi.fn(async () => { throw new Error('stop rejected'); });
    const kill = vi.fn(async () => { throw new Error('kill rejected'); });
    const control = buildShellStopControl({ launched: true, mode: 'systemd-unit', unit: 'rejecting.service' }, {
      graceMs: 10, stopUnit: stop, killUnit: kill, recheckMaxAttempts: 0,
      waitForUnit: async () => ({ termination: 'uncertain', exitCode: null, timedOut: true }),
    });
    try {
      await expect(control.wait(0)).resolves.toMatchObject({ termination: 'uncertain', exitCode: null, timedOut: true });
      expect(stop).toHaveBeenCalledOnce();
      expect(kill).toHaveBeenCalledOnce();
    } finally { control.dispose(); }
  });
  it('uses the absolute recovery deadline despite a backward wall clock and gives stop its own grace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let monotonic = 100;
    let wall = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const observe = vi.fn((_unit: string, _ms: number, options: any) => new Promise(resolve => {
      options.signal.addEventListener('abort', () => resolve({ termination: 'uncertain' }), { once: true });
    }));
    const stop = vi.fn(async () => ({ ok: true }));
    const kill = vi.fn(async () => ({ ok: true }));
    const control = buildShellStopControl({ launched: true, mode: 'systemd-unit', unit: 'test.service' },
      { graceMs: 10, nowMs: () => monotonic, waitForUnit: observe, stopUnit: stop, killUnit: kill, recheckMaxAttempts: 0 });
    const pending = control.wait(1000, { deadlineAtMs: 110, nowMs: () => monotonic });
    await vi.advanceTimersByTimeAsync(0);
    expect(observe.mock.calls[0][1]).toBe(10);
    expect(observe.mock.calls[0][2].deadlineAtMs).toBe(110);
    wall -= 10_000; monotonic = 110;
    await vi.advanceTimersByTimeAsync(10);
    expect(stop).toHaveBeenCalledOnce();
    expect(observe.mock.calls[1][1]).toBe(1000);
    expect(observe.mock.calls[1][2]).not.toHaveProperty('deadlineAtMs');
    wall -= 10_000; monotonic = 1110;
    await vi.advanceTimersByTimeAsync(1000);
    expect(kill).toHaveBeenCalledOnce();
    monotonic = 2110;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ termination: 'uncertain', timedOut: true });
    expect(vi.getTimerCount()).toBe(0);
    control.dispose();
  });
  it('retries observation failure without killing a healthy unit before its deadline', async () => {
    const observe = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce({ termination: 'uncertain' })
      .mockResolvedValue({ termination: 'confirmed', exitCode: 0 });
    const stop = vi.fn();
    const kill = vi.fn();
    const control = buildShellStopControl({ launched: true, mode: 'systemd-unit', unit: 'test.service' },
      { graceMs: 10, waitForUnit: observe, stopUnit: stop, killUnit: kill });
    expect(await control.wait(1000)).toMatchObject({ termination: 'confirmed', exitCode: 0, stopped: false });
    expect(stop).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });
  it('cancels losing wait polls when concurrent stop proof confirms termination', async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let aborted = 0;
    const observe = vi.fn((_unit: string, _ms: number, { signal }: any) => {
      if (observe.mock.calls.length > 1) return Promise.resolve({ termination: 'confirmed', exitCode: 1 });
      return new Promise(resolve => {
        signal.addEventListener('abort', () => { aborted++; resolve({ termination: 'uncertain' }); }, { once: true });
        started();
      });
    });
    const control = buildShellStopControl({ launched: true, mode: 'systemd-unit', unit: 'test.service' },
      { graceMs: 10, waitForUnit: observe, stopUnit: async () => ({ ok: true }) });
    const waiting = control.wait(60000);
    await ready;
    expect(await control.stopAndConfirm()).toMatchObject({ termination: 'confirmed' });
    expect(await waiting).toMatchObject({ termination: 'confirmed' });
    expect(aborted).toBe(1);
    expect(observe).toHaveBeenCalledTimes(2);
  });
  it('caps automatic rechecks, retains uncertain proof, and supports disposal', async () => {
    vi.useFakeTimers();
    const observe = vi.fn(async () => ({ termination: 'uncertain', timedOut: true }));
    const stop = vi.fn(async () => ({ ok: true }));
    const kill = vi.fn(async () => ({ ok: true }));
    const control = buildShellStopControl({ launched: true, mode: 'systemd-unit', unit: 'test.service' },
      { graceMs: 10, waitForUnit: observe, stopUnit: stop, killUnit: kill, recheckMaxAttempts: 2, recheckDelayMs: 10 });
    expect(await control.stopAndConfirm()).toMatchObject({ termination: 'uncertain' });
    await vi.advanceTimersByTimeAsync(10000);
    expect(observe).toHaveBeenCalledTimes(4); // two stop observations + two background probes
    expect(control.pollingStopped).toBe(true);
    await vi.advanceTimersByTimeAsync(100000);
    expect(observe).toHaveBeenCalledTimes(4);
    control.dispose();
    expect(stop).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
  });
  it('bounds stalled stop/kill commands and aborts each losing operation', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const stalled = vi.fn((_unit: string, { signal }: any) => { signals.push(signal); return new Promise(() => {}); });
    const control = buildShellStopControl({ launched: true, mode: 'systemd-unit', unit: 'test.service' },
      { graceMs: 10, waitForUnit: async () => ({ termination: 'uncertain' }), stopUnit: stalled, killUnit: stalled,
        recheckMaxAttempts: 0 });
    const pending = control.stopAndConfirm();
    await vi.advanceTimersByTimeAsync(2005);
    expect(await pending).toMatchObject({ termination: 'uncertain' });
    expect(stalled).toHaveBeenCalledTimes(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });
  it('does not turn child error or exitCode into close proof, and preserves signalCode', async () => {
    vi.useFakeTimers();
    const child = childFixture();
    child.exitCode = null;
    child.signalCode = 'SIGTERM';
    const confirmed = vi.fn(() => { throw new Error('registry callback failed'); });
    const control = buildShellStopControl({ launched: true, mode: 'degraded', child }, { graceMs: 10, onConfirmed: confirmed });
    let finished = false;
    const waiting = control.wait(5000).then((outcome: any) => { finished = true; return outcome; });
    child.emit('error', new Error('observation unavailable'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(finished).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    expect(() => child.emit('close', null, 'SIGTERM')).not.toThrow();
    expect(await waiting).toMatchObject({ termination: 'confirmed', exitCode: null, signalCode: 'SIGTERM' });
    expect(confirmed).toHaveBeenCalledOnce();
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });
  it('accepts a recorded real close that happened before control was attached', async () => {
    const child = childFixture();
    const control = buildShellStopControl({ launched: true, mode: 'degraded', child,
      spawnObservation: { closed: true, exitCode: 0, signalCode: null } }, { graceMs: 10 });
    expect(await control.wait(5000)).toMatchObject({ termination: 'confirmed', exitCode: 0 });
    expect(child.kill).not.toHaveBeenCalled();
  });
  it.each(['win32', 'darwin'])('uses the %s signal strategy with ownedGroup', async platform => {
    const child = childFixture();
    const groupKill = vi.spyOn(process, 'kill').mockImplementation((() => {
      if (child.closed) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);
    child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; });
    const control = buildShellStopControl({ launched: true, mode: 'degraded', child, ownedGroup: true },
      { graceMs: 10, platform });
    const waiting = control.stopAndConfirm();
    if (platform === 'darwin') { child.closed = true; child.emit('close', null, 'SIGTERM'); }
    expect(await waiting).toMatchObject({ termination: 'confirmed' });
    if (platform === 'win32') {
      expect(groupKill).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    } else {
      expect(groupKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
      expect(child.kill).not.toHaveBeenCalled();
    }
  });
  it.each([0, 1, -1, 1.5, NaN, undefined, process.pid])('refuses unsafe owned group %s without manufacturing close proof', async pid => {
    const child = childFixture();
    child.pid = pid;
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const control = buildShellStopControl({ launched: true, mode: 'degraded', child, ownedGroup: true },
      { graceMs: 1, platform: 'linux', recheckMaxAttempts: 0 });
    child.emit('close', 0);
    expect(await control.stopAndConfirm()).toMatchObject({ termination: 'uncertain' });
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    control.dispose();
  });
  it.skipIf(process.platform !== 'linux')('refuses the caller process group', async () => {
    const stat = await readFile('/proc/self/stat', 'utf8');
    const child = childFixture();
    child.pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[2]);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const control = buildShellStopControl({ launched: true, mode: 'degraded', child, ownedGroup: true },
      { graceMs: 1, recheckMaxAttempts: 0 });
    expect(await control.stopAndConfirm()).toMatchObject({ termination: 'uncertain' });
    expect(kill).not.toHaveBeenCalled();
    control.dispose();
  });
  it.skipIf(process.platform === 'win32').each(['exit', 'close'])('does not signal a possibly reused PGID after its post-reap sweep on %s', async event => {
    const child = childFixture();
    const groupKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const control = buildShellStopControl({ launched: true, mode: 'degraded', child, ownedGroup: true },
      { graceMs: 1, recheckMaxAttempts: 0 });
    child.exitCode = 0;
    if (event === 'close') child.emit('close', 0);
    expect(await control.stopAndConfirm()).toMatchObject({ termination: 'uncertain' });
    const sweepCalls = groupKill.mock.calls.filter(call => call[1] !== 0);
    expect(sweepCalls).toEqual([[-child.pid, 'SIGTERM'], [-child.pid, 'SIGKILL']]);
    await control.stopAndConfirm();
    expect(groupKill.mock.calls.filter(call => call[1] !== 0)).toEqual(sweepCalls);
    control.dispose();
  });
  it('waits for a real grandchild holding stdio after the leader exit', async () => {
    const root = await tempRoot();
    const output = path.join(root, 'late-output');
    const child = spawn(process.execPath, ['-e', `const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "late output"), 400)', process.argv[1]], { stdio: ['ignore', 1, 2] });
grandchild.once('spawn', () => process.exit(0));`, output], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.resume();
    child.stderr!.resume();
    await once(child, 'exit');
    const control = buildShellStopControl({ launched: true, mode: 'degraded', child }, { graceMs: 10 });
    expect(child.exitCode).toBe(0);
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await control.wait(3000)).toMatchObject({ termination: 'confirmed', exitCode: 0 });
    expect(await readFile(output, 'utf8')).toBe('late output');
  });
  it.skipIf(process.platform === 'win32')('documents that a detached setsid descendant escapes degraded stop proof', async () => {
    const root = await tempRoot();
    const marker = path.join(root, 'escaped-pid');
    const child = spawn(process.execPath, ['-e', `const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
writeFileSync(process.argv[1], String(escaped.pid)); escaped.unref();`, marker], { detached: true, stdio: 'ignore' });
    const control = buildShellStopControl({ launched: true, mode: 'degraded', child, ownedGroup: true }, { graceMs: 10 });
    let escapedPid: number | undefined;
    try {
      expect(await control.wait(3000)).toMatchObject({ termination: 'confirmed', exitCode: 0 });
      escapedPid = Number(await readFile(marker, 'utf8'));
      expect(() => process.kill(escapedPid!, 0)).not.toThrow();
    } finally {
      escapedPid ??= Number(await readFile(marker, 'utf8').catch(() => '0'));
      if (escapedPid) { try { process.kill(escapedPid, 'SIGKILL'); } catch { /* already stopped */ } }
      control.dispose();
    }
  });
});

describe('private stdin runtime', () => {
  it('creates private stdin outside the workdir and tolerates replacement by a directory', async () => {
    const root = await tempRoot();
    const prepared = await prepareWorkerStdin('sensitive brief', root);
    expect(await readFile(prepared.stdinPath, 'utf8')).toBe('sensitive brief');
    if (process.platform !== 'win32') {
      expect((await stat(prepared.stdinPath)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(prepared.stdinPath))).mode & 0o777).toBe(0o700);
    }
    await rm(prepared.stdinPath);
    await mkdir(prepared.stdinPath);
    await prepared.cleanup();
    await prepared.cleanup();
    expect(await readdir(root)).toEqual([]);
  });
  it.skipIf(process.platform === 'win32')('sweeps only old dead-conductor directories, preserving live, fresh, and symlink paths', async () => {
    const root = await tempRoot();
    const old = path.join(root, 'aiwg-worker-stdin-100-old');
    const live = path.join(root, 'aiwg-worker-stdin-101-live');
    const fresh = path.join(root, 'aiwg-worker-stdin-102-fresh');
    const link = path.join(root, 'aiwg-worker-stdin-103-link');
    for (const directory of [old, live, fresh]) {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(path.join(directory, 'stdin'), 'brief');
    }
    await symlink(live, link);
    for (const directory of [old, live]) await utimes(directory, new Date(0), new Date(0));
    await sweepWorkerStdin(root, { isAlive: (pid: number) => pid === 101 });
    expect((await readdir(root)).sort()).toEqual([path.basename(live), path.basename(fresh), path.basename(link)].sort());
    expect(await readFile(path.join(live, 'stdin'), 'utf8')).toBe('brief');
  });
});


describe('prepared shell recovery authority', () => {
  it('forwards the existing admission, invocation identity and deadline after audited stdin preparation', async () => {
    const root = await tempRoot();
    const brief = Buffer.from('conductor brief');
    const { createHash } = await import('node:crypto');
    const invocation = { cwd: root, selected: { group: 'reviews' }, envNames: [], briefPath: path.join(root, 'brief'), briefDigest: `sha256:${createHash('sha256').update(brief).digest('hex')}` };
    const admission = Object.freeze({ gated: true, token: Object.freeze({ id: 'reserved' }) });
    const dispatchGuard = { deadlineAtMs: 110, nowMs: () => 100 };
    const plan = vi.fn(async (options: any) => {
      expect(await readFile(options.stdinPath)).toEqual(brief);
      expect((await stat(options.stdinPath)).mode & 0o777).toBe(0o600);
      return { launched: false, blocked: true };
    });
    const result = await launchPreparedShellWorker(invocation,
      { memoryMaxGb: 1, servedRoot: root, stdinRuntimeRoot: root, admission, invocationId: 'invocation', dispatchGuard },
      { loadRalphExternal: async () => ({ planDirectWorkerLaunch: plan }), readBoundedFile: async () => brief,
        importImpl: async () => ({ workerStdinBytes: () => brief }), describeGateFailures: () => 'refused' });
    expect(plan).toHaveBeenCalledOnce();
    expect(plan.mock.calls[0][0].admission).toBe(admission);
    expect(plan.mock.calls[0][0].invocationId).toBe('invocation');
    expect(plan.mock.calls[0][0].dispatchGuard).toBe(dispatchGuard);
    expect(plan.mock.calls[0][0].env).toMatchObject({ AIWG_WORKER_INVOCATION_ID: 'invocation', AIWG_WORKER_WORKSPACE: root, AIWG_WORKER_GROUP: 'reviews' });
    expect(result).toMatchObject({ launched: false, launchAttempted: false });
    expect(await readdir(root)).toEqual([]);
  });
});
