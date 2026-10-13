import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { ChildProcessTransport } from '../../../src/mcp/tools/worker-invoke.mjs';
import { stopOverflowWorker } from '../../../tools/ralph-external/lib/worker-overflow.mjs';
import { sampleWorkerGroup, sampleWorkerIdentity } from '../../../tools/ralph-external/process-monitor.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('MCP overflow stop authority', () => {
  const unit = { mode: 'systemd-unit', unit: 'aiwg-overflow-test.service' };

  it.each([true, false])('requires inactive state after unit stop delivery (ok: %s)', async ok => {
    const stopUnit = vi.fn(() => ({ ok }));
    const unitStatus = vi.fn(() => ({ active: true }));
    const result = await stopOverflowWorker(unit, { stopUnit, unitStatus, deadlineMs: 0 });
    expect(stopUnit).toHaveBeenCalledWith(unit.unit, { timeoutMs: 1 });
    expect(unitStatus).toHaveBeenCalledWith(unit.unit, { timeoutMs: 1 });
    expect(result).toEqual({ termination: 'uncertain',
      diagnostic: ok ? 'OG_WORKER_MCP_STOP_UNCONFIRMED' : 'OG_WORKER_MCP_STOP_FAILED' });
  });

  it.each([true, false])('waits for inactive unit state and retains stop failures (ok: %s)', async ok => {
    const unitStatus = vi.fn().mockReturnValueOnce({ active: true }).mockReturnValue({ active: false });
    const result = await stopOverflowWorker(unit, { stopUnit: () => ({ ok }), unitStatus });
    expect(result).toEqual({ termination: 'confirmed', ...(ok ? {} : { diagnostic: 'OG_WORKER_MCP_STOP_FAILED' }) });
    expect(unitStatus).toHaveBeenCalledTimes(2);
  });

  it('cannot prove termination when unit state is unavailable', async () => {
    expect(await stopOverflowWorker(unit, { stopUnit: () => ({ ok: true }),
      unitStatus: () => { throw new Error('manager unavailable'); }, deadlineMs: 0,
    })).toEqual({ termination: 'uncertain', diagnostic: 'OG_WORKER_MCP_STOP_UNCONFIRMED' });
  });

  it.each(['parent', 'birth', 'exited', 'ambiguous'])('refuses group signaling with invalid supervisor ownership (%s)', async failure => {
    const supervisor = { pid: 123, parentPid: process.pid, uid: process.getuid?.(), startTicks: '1' };
    const child = { pid: supervisor.pid, exitCode: failure === 'exited' ? 0 : null, signalCode: null };
    const sample = vi.fn().mockReturnValueOnce(failure === 'parent' ? { ...supervisor, parentPid: 1 } : supervisor)
      .mockReturnValue(failure === 'birth' ? { ...supervisor, startTicks: '2' } : supervisor);
    const worker = { pid: 456, parentPid: supervisor.pid };
    const signal = vi.fn();
    const result = await stopOverflowWorker({ mode: 'degraded', child, transportSupervisor: true }, {
      platform: 'linux', sample, children: () => failure === 'ambiguous' ? [worker, worker] : [worker], signal,
    });
    expect(result.termination).toBe('uncertain');
    expect(signal).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'])('attempts direct-child kill on %s without claiming tree termination', async platform => {
    const child = { kill: vi.fn(() => true) };
    const sample = vi.fn(); const signal = vi.fn();
    expect(await stopOverflowWorker({ mode: 'degraded', child }, { platform, sample, signal }))
      .toEqual({ termination: 'uncertain', diagnostic: 'OG_WORKER_MCP_STOP_UNCONFIRMED' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(sample).not.toHaveBeenCalled(); expect(signal).not.toHaveBeenCalled();
  });

  it.each(['false', 'throw'])('reports failed direct-child kill (%s)', async failure => {
    const child = { kill: () => { if (failure === 'throw') throw new Error('failed'); return false; } };
    expect(await stopOverflowWorker({ mode: 'degraded', child }, { platform: 'win32' }))
      .toEqual({ termination: 'uncertain', diagnostic: 'OG_WORKER_MCP_STOP_FAILED' });
  });

  it('checks unit state after the final sleep at the deadline', async () => {
    let time = 0;
    const unitStatus = vi.fn(() => ({ active: time < 10 }));
    const stopUnit = vi.fn(() => ({ ok: true }));
    expect(await stopOverflowWorker(unit, { stopUnit, unitStatus, deadlineMs: 10,
      pollIntervalMs: 25, clock: () => time, sleep: async ms => { time += ms; },
    })).toEqual({ termination: 'confirmed' });
    expect(unitStatus.mock.calls).toEqual([[unit.unit, { timeoutMs: 10 }], [unit.unit, { timeoutMs: 1 }]]);
    expect(stopUnit).toHaveBeenCalledWith(unit.unit, { timeoutMs: 10 });
  });

  it('retries a transient status error until the unit becomes inactive', async () => {
    let time = 0;
    const unitStatus = vi.fn().mockImplementationOnce(() => { throw new Error('temporary'); })
      .mockReturnValue({ active: false });
    expect(await stopOverflowWorker(unit, { stopUnit: () => ({ ok: true }), unitStatus,
      clock: () => time, sleep: async ms => { time += ms; },
    })).toEqual({ termination: 'confirmed' });
    expect(unitStatus).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform !== 'linux').each([false, true])('overflow stays unconfirmed after group kill (escaped descendant: %s)', async escaped => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-worker-overflow-')); roots.push(root);
    const script = path.join(root, 'worker.mjs');
    const pidFile = path.join(root, 'worker.pid');
    const descendantFile = path.join(root, 'descendant.pid');
    const fifo = path.join(root, 'stdout.fifo');
    expect(spawnSync('mkfifo', [fifo], { stdio: 'ignore' }).status).toBe(0);
    // The descendant inherits a FIFO writer even when native pipes are prohibited.
    const writer = openSync(fifo, constants.O_RDWR);
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    writeFileSync(script, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(process.argv[2], String(process.pid));
spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);', process.argv[3]], { stdio: 'inherit', detached: ${escaped} });
process.stdout.write(Buffer.alloc(12 * 1024 * 1024, 120));
setInterval(() => {}, 1000);
`);
    const child = spawn(process.execPath, [path.resolve('tools/ralph-external/lib/worker-isolation.mjs'),
      '--worker-environment', '[]', '--', process.execPath, script, pidFile, descendantFile],
    { stdio: ['ignore', writer, writer] });
    closeSync(writer);
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    let workerPid = 0;
    let descendantPid = 0;
    try {
      const deadline = Date.now() + 5000;
      while (!descendantPid && Date.now() < deadline) {
        try { workerPid = Number(readFileSync(pidFile, 'utf8')); descendantPid = Number(readFileSync(descendantFile, 'utf8')); } catch { /* startup */ }
        if (!descendantPid) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(workerPid).toBeGreaterThan(0); expect(descendantPid).toBeGreaterThan(0);
      const groupPids = sampleWorkerGroup(workerPid)?.map((member: any) => member.pid);
      if (escaped) expect(groupPids).not.toContain(descendantPid);
      else expect(groupPids).toContain(descendantPid);
      const stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      const transport = new ChildProcessTransport({ stdout, once: child.once.bind(child) }, {
        terminate: () => stopOverflowWorker({ mode: 'degraded', child, transportSupervisor: true }),
      });
      transport.onerror = vi.fn();
      await transport.start();
      const overflowDeadline = Date.now() + 5000;
      while (!transport._failure && Date.now() < overflowDeadline) {
        const buffer = Buffer.alloc(64 * 1024);
        try {
          const size = readSync(reader, buffer, 0, buffer.length, null);
          if (size) stdout.emit('data', buffer.subarray(0, size));
        } catch (error: any) { if (error.code !== 'EAGAIN') throw error; }
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      expect(transport._failure?.code).toBe('OG_WORKER_MCP_FRAME_TOO_LARGE');
      expect(await transport._termination).toEqual({ termination: 'uncertain', diagnostic: 'OG_WORKER_MCP_STOP_UNCONFIRMED' });
      await closed;
      expect(sampleWorkerGroup(workerPid)).toEqual([]);
      if (escaped) {
        expect(sampleWorkerIdentity(descendantPid)).not.toBeNull();
        process.kill(descendantPid, 'SIGKILL');
        const exitDeadline = Date.now() + 2000;
        while (sampleWorkerIdentity(descendantPid) && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(sampleWorkerIdentity(descendantPid)).toBeNull();
      // Drain bytes already in the pipe; EOF proves every inherited writer closed.
      const eofDeadline = Date.now() + 2000;
      let eof = false;
      while (!eof && Date.now() < eofDeadline) {
        try { eof = readSync(reader, Buffer.alloc(64 * 1024), 0, 64 * 1024, null) === 0; }
        catch (error: any) { if (error.code !== 'EAGAIN') throw error; }
        if (!eof) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(eof).toBe(true);
    } finally {
      closeSync(reader);
      for (const pid of [workerPid, descendantPid]) if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  }, 10000);
});
