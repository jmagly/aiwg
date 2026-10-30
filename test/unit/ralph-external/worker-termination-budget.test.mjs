// Synthetic scan clocks exercise the launcher's single exit-time scan budget.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleWorkerIdentity } from '../../../tools/ralph-external/process-monitor.mjs';
import { observeWorkerTermination } from '../../../tools/ralph-external/lib/worker-termination.mjs';
import { scanWorkerInvocationProcesses, WORKER_INVOCATION_MARKER } from '../../../tools/ralph-external/lib/worker-invocation-processes.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(contents = '', entryCount = 1) {
  const procRoot = fs.mkdtempSync(join(tmpdir(), 'aiwg-termination-budget-'));
  roots.push(procRoot);
  for (let index = 0; index < entryCount; index++) {
    const path = join(procRoot, String(123 + index));
    fs.mkdirSync(path);
    fs.writeFileSync(join(path, 'environ'), contents);
  }
  const supervisor = sampleWorkerIdentity(process.pid);
  return { procRoot, base: { workerExited: true, invocationId: 'budget-test', supervisor,
    identity: { ...supervisor, pid: 2147483646, pgid: 2147483646, startTicks: '100' },
    kill: () => { throw Object.assign(new Error(), { code: 'ESRCH' }); } } };
}

describe('T-OG-04 exit-time termination budget (#3781)', () => {
  it('completes one six-entry scan costing 30 ms per entry within the whole budget', () => {
    const { procRoot, base } = fixture('OTHER=value\0', 6);
    let clock = 0;
    const scan = vi.fn(input => scanWorkerInvocationProcesses({ ...input, procRoot,
      fs: { ...fs, statSync: (...args) => {
        clock += 30;
        return fs.statSync(...args);
      } } }));
    expect(observeWorkerTermination({ ...base, now: () => clock, scan }))
      .toMatchObject({ confirmed: true, missing: null });
    expect(clock).toBe(180);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0][0].deadline).toBe(2000);
  });

  it('does not retry a present marker even if another scan could confirm', () => {
    const { procRoot, base } = fixture(`${WORKER_INVOCATION_MARKER}=budget-test\0`);
    const scan = vi.fn(input => {
      const evidence = scanWorkerInvocationProcesses({ ...input, procRoot });
      fs.writeFileSync(join(procRoot, '123/environ'), '');
      return evidence;
    });
    expect(observeWorkerTermination({ ...base, now: () => 0, scan }))
      .toMatchObject({ confirmed: false, markerPresent: true });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scanWorkerInvocationProcesses({ procRoot, invocationId: 'budget-test' }).confirmed).toBe(true);
  });

  it.each(['unreadable', 'byte-bound'])('keeps %s evidence when the scan later reaches its time bound', reason => {
    const { procRoot, base } = fixture('oversized');
    fs.writeFileSync(join(procRoot, '123/stat'), `123 (post-start) S ${Array(18).fill('1').join(' ')} 101 0\n`);
    let clock = 0;
    const scan = vi.fn(input => scanWorkerInvocationProcesses({ ...input, procRoot,
      maxEnvironmentBytes: reason === 'byte-bound' ? 1 : 1048576,
      fs: { ...fs, openSync: (filename, ...args) => {
        if (reason === 'unreadable' && filename.endsWith('/environ')) {
          clock = input.deadline;
          throw Object.assign(new Error(), { code: 'EACCES' });
        }
        return fs.openSync(filename, ...args);
      }, readSync: (...args) => {
        const size = fs.readSync(...args);
        if (reason === 'byte-bound') clock = input.deadline;
        return size;
      } } }));
    const result = observeWorkerTermination({ ...base, now: () => clock, scan });
    expect(result).toMatchObject({ confirmed: false,
      missing: expect.stringContaining(reason === 'unreadable' ? 'unreadable same-uid' : 'byte bound') });
    expect(result.timeBoundReached).toBeUndefined();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('does not retry the count bound or scan a live group', () => {
    const { procRoot, base } = fixture();
    const scan = vi.fn(input => scanWorkerInvocationProcesses({ ...input, procRoot, maxEntries: 0 }));
    expect(observeWorkerTermination({ ...base, now: () => 0, scan }))
      .toMatchObject({ confirmed: false, missing: expect.stringContaining('count bound') });
    expect(scan).toHaveBeenCalledTimes(1);
    scan.mockClear();
    expect(observeWorkerTermination({ ...base, kill: () => {}, scan }))
      .toMatchObject({ confirmed: false, missing: expect.stringContaining('still finds members') });
    expect(scan).not.toHaveBeenCalled();
  });

  it('returns the time-bound uncertainty when a full scan would exceed two seconds', () => {
    const { procRoot, base } = fixture('', 6);
    let clock = 0;
    const scan = vi.fn(input => scanWorkerInvocationProcesses({ ...input, procRoot,
      fs: { ...fs, statSync: (...args) => {
        clock += 400;
        return fs.statSync(...args);
      } } }));
    expect(observeWorkerTermination({ ...base, now: () => clock, scan }))
      .toMatchObject({ confirmed: false, timeBoundReached: true,
        missing: expect.stringContaining('scan time bound reached') });
    expect(clock).toBe(2000);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0][0].deadline).toBe(2000);
  });

  it('scans once with a stationary clock and leaves explicit deadlines to the caller', () => {
    const { procRoot, base } = fixture();
    const scan = vi.fn(input => scanWorkerInvocationProcesses({ ...input, procRoot, now: () => input.deadline }));
    expect(observeWorkerTermination({ ...base, now: () => 0, scan }))
      .toMatchObject({ confirmed: false, timeBoundReached: true });
    expect(scan).toHaveBeenCalledTimes(1);
    scan.mockClear();
    expect(observeWorkerTermination({ ...base, deadline: 50, now: () => 0, scan }))
      .toMatchObject({ confirmed: false, timeBoundReached: true });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0][0].deadline).toBe(50);
  });
});
