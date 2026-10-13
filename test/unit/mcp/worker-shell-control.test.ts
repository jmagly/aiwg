import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — .mjs untyped
import { buildShellStopControl, parseShellUnitStatus, waitForUnitTermination, defaultStopShellUnit, defaultKillShellUnit } from '../../../src/mcp/tools/worker-shell-control.mjs';
// @ts-expect-error — .mjs untyped
import { prepareWorkerStdin, sweepWorkerStdin } from '../../../src/mcp/tools/worker-stdin-runtime.mjs';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
const active = 'LoadState=loaded\nActiveState=active\nResult=success\nExecMainStatus=0\nExecMainCode=0\nMainPID=42\n';
const success = 'LoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\nExecMainCode=1\nMainPID=0\n';
const failed = 'LoadState=loaded\nActiveState=failed\nResult=exit-code\nExecMainStatus=7\nExecMainCode=1\nMainPID=0\n';
const killed = 'LoadState=loaded\nActiveState=failed\nResult=signal\nExecMainStatus=9\nExecMainCode=2\nMainPID=0\n';
const collected = 'LoadState=not-found\nActiveState=inactive\nResult=\nExecMainStatus=0\nExecMainCode=0\nMainPID=0\n';

describe('async systemd status and command path', () => {
  it.each([
    [active, { termination: 'uncertain', exitCode: null }],
    [success, { termination: 'confirmed', exitCode: 0 }],
    [failed, { termination: 'confirmed', exitCode: 7 }],
    [killed, { termination: 'confirmed', exitCode: 9, signalCode: 9 }],
    [collected, { termination: 'confirmed', exitCode: null }],
  ])('parses recorded show properties: %s', (stdout, expected) => {
    expect(parseShellUnitStatus(stdout)).toEqual(expected);
  });
  it.each(['', 'ActiveState=inactive', success.replace('ExecMainStatus=0', 'ExecMainStatus=bad'),
    collected.replace('ActiveState=inactive', 'ActiveState=active')])('rejects incomplete/unverified stop proof: %s', stdout => {
    expect(() => parseShellUnitStatus(stdout)).toThrow(/status unavailable/);
  });
  it('retries a transient show error without stopping and gives short probes a timeout floor', async () => {
    let clock = 0;
    const exec = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce({ stdout: active })
      .mockResolvedValueOnce({ stdout: success });
    const abort = new AbortController();
    const outcome = await waitForUnitTermination('test.service', 80, { signal: abort.signal, exec,
      pollIntervalMs: 10, clock: () => clock, sleep: async (ms: number) => { clock += ms; } });
    expect(outcome).toEqual({ termination: 'confirmed', exitCode: 0 });
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls[0][0]).toBe('systemctl');
    expect(exec.mock.calls[0][1]).toEqual(expect.arrayContaining(['LoadState', 'ActiveState', 'MainPID']));
    expect(exec.mock.calls.every(call => call[2].timeout >= 1000 && call[2].signal === abort.signal)).toBe(true);
  });
  it('accepts a verified collected unit even when systemctl show exits nonzero', async () => {
    const exec = vi.fn().mockRejectedValue({ code: 4, stdout: collected, stderr: 'Unit could not be found.' });
    expect(await waitForUnitTermination('test.service', 100, { exec }))
      .toEqual({ termination: 'confirmed', exitCode: null });
    expect(exec).toHaveBeenCalledOnce();
  });
  it('cancels an in-flight show and produces no more probes after abort', async () => {
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
  });
  it.each([['stop', defaultStopShellUnit], ['kill', defaultKillShellUnit]])('bounds the default %s command', async (verb, command) => {
    const exec = vi.fn(async () => ({ stdout: '' }));
    const abort = new AbortController();
    expect(await command('test.service', { exec, signal: abort.signal, timeout: 17 })).toEqual({ ok: true });
    expect(exec).toHaveBeenCalledWith('systemctl', expect.arrayContaining(['--user', verb, 'test.service']),
      { signal: abort.signal, timeout: 17 });
    if (verb === 'kill') expect(exec.mock.calls[0][1]).toEqual(expect.arrayContaining(['--kill-who=all', '--signal=SIGKILL']));
    exec.mockRejectedValueOnce(new Error('unavailable'));
    expect(await command('test.service', { exec })).toEqual({ ok: false });
  });
});

describe('shell control lifetimes', () => {
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
