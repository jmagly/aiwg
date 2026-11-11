// Deterministic proc races distinguish vanished processes from incomplete termination proof.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanWorkerInvocationProcesses, WORKER_INVOCATION_MARKER } from '../../../tools/ralph-external/lib/worker-invocation-processes.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const error = code => Object.assign(new Error(code), { code });
function fixture() {
  const procRoot = fs.mkdtempSync(join(tmpdir(), 'aiwg-termination-race-'));
  roots.push(procRoot);
  fs.mkdirSync(join(procRoot, '123'));
  fs.writeFileSync(join(procRoot, '123/environ'), 'OTHER=value\0');
  fs.writeFileSync(join(procRoot, '123/stat'),
    `123 (candidate) S 1 123 123 ${Array(15).fill('0').join(' ')} 101 0\n`);
  return { invocationId: 'race', procRoot, uid: process.getuid(), startTicks: '100',
    workerPid: 456, workerPgid: 456, workerSession: 456,
    workerCgroup: null, selfCgroup: null, now: () => 0, deadline: 2000 };
}

describe('T-OG-04 termination scan races (#3835)', () => {
  it.each(['ENOENT', 'ESRCH'])('ignores a process that vanishes at each direct read: %s', code => {
    for (const operation of ['statSync', 'openSync', 'readSync']) {
      const input = fixture();
      const injected = { ...fs, [operation]: () => { throw error(code); } };
      expect(scanWorkerInvocationProcesses({ ...input, fs: injected })).toEqual({ confirmed: true, missing: null });
    }
  });

  it.each(['EACCES', 'EIO'])('keeps a genuinely unreadable post-start process uncertain: %s', code => {
    const input = fixture();
    const injected = { ...fs, openSync: (filename, ...args) => {
      if (filename.endsWith('/environ')) throw error(code);
      return fs.openSync(filename, ...args);
    } };
    expect(scanWorkerInvocationProcesses({ ...input, fs: injected })).toMatchObject({
      confirmed: false, missing: expect.stringContaining('unreadable same-uid') });
  });

  it('fails closed when a busy host consumes the whole scan deadline', () => {
    const input = fixture();
    let clock = 0;
    const injected = { ...fs, statSync: (...args) => {
      clock = input.deadline;
      return fs.statSync(...args);
    } };
    expect(scanWorkerInvocationProcesses({ ...input, now: () => clock, fs: injected }))
      .toMatchObject({ confirmed: false, timeBoundReached: true,
        missing: expect.stringContaining('scan time bound reached') });
  });

  it('fails closed when the inventory exceeds the entry bound, even with an unread marker beyond it', () => {
    const input = fixture();
    fs.mkdirSync(join(input.procRoot, '124'));
    fs.writeFileSync(join(input.procRoot, '124/environ'), `${WORKER_INVOCATION_MARKER}=race\0`);
    let index = 0;
    const closeSync = vi.fn();
    const injected = { ...fs, opendirSync: () => ({
      readSync: () => [{ name: '123' }, { name: '124' }][index++], closeSync,
    }) };
    expect(scanWorkerInvocationProcesses({ ...input, maxEntries: 1, fs: injected }))
      .toMatchObject({ confirmed: false, missing: expect.stringContaining('count bound reached') });
    expect(closeSync).toHaveBeenCalledOnce();
  });
});

// Use the real scan with synthetic reads and a logical clock: no timing sleeps.
import * as termination from '../../../tools/ralph-external/lib/worker-termination.mjs';
import { sampleWorkerIdentity } from '../../../tools/ralph-external/process-monitor.mjs';
function exitFixture() {
  const input = fixture();
  const supervisor = sampleWorkerIdentity(process.pid);
  return { input, base: { workerExited: true, invocationId: input.invocationId, supervisor,
    identity: { ...supervisor, pid: 456, pgid: 456, sessionId: 456, startTicks: '100' },
    kill: () => { throw error('ESRCH'); } } };
}

describe('T-OG-04 bounded exit-time settlement (#3835)', () => {
  it.each(['readable', 'ENOENT', 'ESRCH'])(
    'rechecks a transiently unreadable same-uid process that becomes %s', async outcome => {
      const { input, base } = exitFixture();
      let clock = 0, transient = true;
      const injected = { ...fs, openSync: (filename, ...args) => {
        if (filename.endsWith('/environ') && transient) throw error('EACCES');
        if (filename.endsWith('/environ') && outcome !== 'readable') throw error(outcome);
        return fs.openSync(filename, ...args);
      } };
      const scan = vi.fn(options => scanWorkerInvocationProcesses({ ...input, ...options, fs: injected }));
      const wait = vi.fn(async ms => { clock += ms; transient = false; });
      expect(await termination.settleWorkerTermination({ ...base, scan, now: () => clock, wait }))
        .toMatchObject({ confirmed: true, missing: null });
      expect(scan).toHaveBeenCalledTimes(2);
      expect(wait).toHaveBeenCalledTimes(1);
      for (const [options] of scan.mock.calls) expect(options.deadline).toBe(2000);
    });

  it('waits for an exited group to disappear before performing the marker scan', async () => {
    const { input, base } = exitFixture();
    let clock = 0;
    const scan = vi.fn(options => scanWorkerInvocationProcesses({ ...input, ...options }));
    const kill = vi.fn(() => { if (clock > 0) throw error('ESRCH'); });
    expect(await termination.settleWorkerTermination({ ...base, scan, kill, now: () => clock,
      wait: async ms => { clock += ms; } })).toMatchObject({ confirmed: true });
    expect(kill).toHaveBeenCalledTimes(2);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('keeps a permanently unreadable possible descendant uncertain within two seconds', async () => {
    const { input, base } = exitFixture();
    let clock = 0;
    const injected = { ...fs, openSync: (filename, ...args) => {
      if (filename.endsWith('/environ')) throw error('EACCES');
      return fs.openSync(filename, ...args);
    } };
    const scan = vi.fn(options => scanWorkerInvocationProcesses({ ...input, ...options, fs: injected }));
    expect(await termination.settleWorkerTermination({ ...base, scan, now: () => clock,
      wait: async ms => { clock += ms; } })).toMatchObject({ confirmed: false,
        missing: expect.stringContaining('unreadable same-uid') });
    expect(clock).toBe(2000);
    expect(scan.mock.calls.length).toBeLessThanOrEqual(21);
  });

  it.each(['marker', 'time', 'count', 'bytes'])('does not retry %s evidence', async reason => {
    const { input, base } = exitFixture();
    if (reason === 'marker') fs.writeFileSync(join(input.procRoot, '123/environ'), `${WORKER_INVOCATION_MARKER}=race\0`);
    const scan = vi.fn(options => scanWorkerInvocationProcesses({ ...input, ...options,
      ...(reason === 'time' ? { now: () => options.deadline } : {}),
      ...(reason === 'count' ? { maxEntries: 0 } : {}),
      ...(reason === 'bytes' ? { maxEnvironmentBytes: 1 } : {}) }));
    const wait = vi.fn();
    expect(await termination.settleWorkerTermination({ ...base, scan, now: () => 0, wait }))
      .toMatchObject({ confirmed: false });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});

describe('T-OG-04 detached spawn evidence without a captured birth (#4077)', () => {
  function uncaptured() {
    const { input, base } = exitFixture();
    const scan = vi.fn(options => scanWorkerInvocationProcesses({ ...input, ...options }));
    return { input, scan, options: { ...base, identity: null, detachedPid: 456,
      supervisor: { ...base.supervisor, startTicks: '100' }, scan } };
  }

  it('proves empty containment with the launcher birth as a conservative scan bound', () => {
    const { options, scan } = uncaptured();
    const kill = vi.fn(options.kill);
    expect(termination.observeWorkerTermination({ ...options, kill })).toEqual({ confirmed: true, missing: null });
    expect(kill).toHaveBeenCalledExactlyOnceWith(-456, 0);
    expect(scan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ startTicks: '100', uid: process.getuid() }));
    expect(scan.mock.calls[0][0]).not.toHaveProperty('workerPid');
  });

  it.each(['marker', 'unreadable', 'count', 'bytes', 'deadline'])(
    'keeps possible descendants uncertain when the scan finds %s', reason => {
      const { input, options } = uncaptured();
      if (reason === 'marker') fs.writeFileSync(join(input.procRoot, '123/environ'), `${WORKER_INVOCATION_MARKER}=race\0`);
      const denied = { ...fs, openSync: (filename, ...args) => {
        if (filename.endsWith('/environ')) throw error('EACCES');
        return fs.openSync(filename, ...args);
      } };
      const scan = data => scanWorkerInvocationProcesses({ ...input, ...data,
        ...(reason === 'unreadable' ? { fs: denied } : {}),
        ...(reason === 'count' ? { maxEntries: 0 } : {}),
        ...(reason === 'bytes' ? { maxEnvironmentBytes: 1 } : {}),
        ...(reason === 'deadline' ? { now: () => data.deadline } : {}) });
      expect(termination.observeWorkerTermination({ ...options, scan })).toMatchObject({ confirmed: false });
    });

  it('requires an observed exit, detached PID, safe group and launcher birth', () => {
    const { options, scan } = uncaptured();
    for (const missing of [
      { workerExited: false }, { detachedPid: undefined }, { detachedPid: 1 }, { detachedPid: process.pid },
      { detachedPid: options.supervisor.pgid }, { detachedPid: 1.5 }, { supervisor: null },
      { supervisor: { ...options.supervisor, pid: 456 } },
      { supervisor: { ...options.supervisor, startTicks: null } },
      { supervisor: { ...options.supervisor, uid: process.getuid() + 1 } },
    ]) expect(termination.observeWorkerTermination({ ...options, ...missing })).toMatchObject({ confirmed: false });
    expect(scan).not.toHaveBeenCalled();
  });

  it.each(['live', 'EPERM'])('refuses a %s group without a birth sample', reason => {
    const { options, scan } = uncaptured();
    const kill = () => { if (reason === 'EPERM') throw error(reason); };
    expect(termination.observeWorkerTermination({ ...options, kill,
      groupStates: () => ({ live: 1, zombies: 0, unreadable: 0 }) })).toMatchObject({ confirmed: false });
    expect(scan).not.toHaveBeenCalled();
  });
});
