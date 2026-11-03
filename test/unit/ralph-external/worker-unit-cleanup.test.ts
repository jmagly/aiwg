// Retained status must survive best-effort cleanup, which requires a private launch owner.
import { EventEmitter } from 'node:events';
import { rmSync } from '../../helpers/worker-capture-cleanup.mjs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { systemdClientFixture } from '../../fixtures/systemd-client.js';
import { workerInvocationFixture } from '../../fixtures/worker-single-invocation.js';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { createWorkerUnitOwner, publishWorkerUnitExit, resetRecordedWorkerUnit, recordWorkerUnitStop, readRecordedWorkerUnitStop } from '../../../tools/ralph-external/lib/worker-unit-cleanup.mjs';
import { stopOverflowWorker } from '../../../tools/ralph-external/lib/worker-overflow.mjs';
import { launchIsolatedWorker } from '../../../tools/ralph-external/lib/worker-isolation.mjs';

const roots: string[] = [];
const breakers: any[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const breaker of breakers.splice(0)) breaker.destroy();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const native = { active: false, result: 'signal', execMainStatus: 9, execMainCode: 2, cgroupEmpty: true };
function setup(kind = 'unit') {
  const client = systemdClientFixture(); roots.push(client.root); vi.stubEnv('PATH', client.root);
  const owner = createWorkerUnitOwner('aiwg-worker-owned-1', kind);
  const outcome = owner.track({ mode: 'systemd-unit', unit: 'aiwg-worker-owned-1' });
  const description = owner.properties[0]?.slice('Description='.length);
  const spawn = vi.fn((_binary: string, args: string[]) => ({ status: 0, stdout: args.includes('show') ? description : '', stderr: '' }));
  return { client, owner, outcome, description, spawn, log: vi.fn() };
}

describe('owned unit result cleanup', () => {
  it('waits for successful recording before exact bounded reset and preserves raw signal status', async () => {
    const f = setup();
    let recorded: any;
    let release!: () => void;
    const result = { exitCode: null, signal: 'SIGKILL' };
    const publish = vi.fn(async (name: string, value: any) => {
      expect(name).toBe('exit.json');
      recorded = structuredClone(value);
      await new Promise<void>(resolve => { release = resolve; });
    });
    const done = publishWorkerUnitExit(publish, f.outcome, native, result, f);
    expect(f.spawn).not.toHaveBeenCalled();
    release(); await done;
    expect(recorded).toMatchObject({ nativeResult: 'signal', nativeExecMainStatus: 9 });
    expect(result).toEqual(recorded);
    expect(f.spawn.mock.calls[1]).toEqual([f.client.systemctl, ['--user', 'reset-failed', '--', f.outcome.unit], expect.objectContaining({
      timeout: 500, killSignal: 'SIGKILL', encoding: 'utf8', env: expect.any(Object),
    })]);
    expect(f.spawn.mock.calls[1][2].env).not.toHaveProperty('NODE_OPTIONS');
    expect(f.log).not.toHaveBeenCalled();
    resetRecordedWorkerUnit(f.outcome, native, f);
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });

  it('retains status on a failed write so a later successful recording can clean it', async () => {
    const f = setup();
    await expect(publishWorkerUnitExit(async () => { throw new Error('disk full'); }, f.outcome, native, {}, f)).rejects.toThrow('disk full');
    expect(f.spawn).not.toHaveBeenCalled();
    await publishWorkerUnitExit(async () => {}, f.outcome, native, {}, f);
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { unit: 'aiwg-worker-owned-1', mode: 'systemd-unit' }])('never resets a caller-supplied outcome %j', outcome => {
    const f = setup();
    resetRecordedWorkerUnit(outcome, native, f);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('never resets a scope', () => {
    const f = setup('scope');
    resetRecordedWorkerUnit(f.outcome, native, f);
    expect(f.owner.properties).toEqual([]);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each([null, { ...native, active: true }, { ...native, active: null }, { ...native, result: undefined },
    { ...native, execMainStatus: undefined }, { ...native, execMainStatus: NaN }])('retains incomplete or live status %j', status => {
    const f = setup();
    resetRecordedWorkerUnit(f.outcome, status, f);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('refuses same-name foreign units, including failed async submissions', async () => {
    const f = setup();
    f.spawn.mockReturnValue({ status: 0, stdout: 'some other launcher', stderr: '' });
    await publishWorkerUnitExit(async () => {}, f.outcome, native, {}, f);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('ownership does not match'));
  });

  it.each(['query-error', 'query-nonzero', 'reset-error', 'reset-nonzero', 'throw', 'missing-client', 'logger-throw'])('logs %s without changing the recorded result', async failure => {
    const f = setup();
    if (failure === 'missing-client') rmSync(f.client.systemctl);
    if (failure === 'throw') f.spawn.mockImplementation(() => { throw new Error('spawn failed'); });
    if (failure === 'logger-throw') f.log.mockImplementation(() => { throw new Error('logger failed'); });
    if (failure.startsWith('query')) f.spawn.mockReturnValue({ status: 1, stdout: '', stderr: 'query failed',
      ...(failure === 'query-error' ? { error: new Error('timeout') } : {}) } as any);
    if (failure.startsWith('reset') || failure === 'logger-throw') f.spawn.mockImplementation((_binary, args) => args.includes('show')
      ? { status: 0, stdout: f.description, stderr: '' }
      : { status: 1, stdout: '', stderr: 'reset failed', ...(failure === 'reset-error' ? { error: new Error('timeout') } : {}) } as any);
    let recorded: any;
    const result = { exitCode: 7, errorCode: 'PROVIDER_ERROR' };
    await publishWorkerUnitExit(async (_name: string, value: any) => { recorded = structuredClone(value); }, f.outcome, native, result, f);
    expect(result).toEqual(recorded);
    expect(result).toMatchObject({ exitCode: 7, errorCode: 'PROVIDER_ERROR', nativeResult: 'signal', nativeExecMainStatus: 9 });
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('Worker unit cleanup failed'));
  });

  it.each(['query', 'reset'])('retries cleanup after a transient %s failure', failure => {
    const f = setup();
    const successful = f.spawn.getMockImplementation()!;
    let failed = false;
    f.spawn.mockImplementation((binary, args) => {
      if (!failed && args.includes(failure === 'query' ? 'show' : 'reset-failed')) {
        failed = true;
        return { status: 1, stdout: '', stderr: 'temporary failure' };
      }
      return successful(binary, args);
    });
    expect(resetRecordedWorkerUnit(f.outcome, native, f)).toBeUndefined();
    expect(resetRecordedWorkerUnit(f.outcome, native, f)).toBe(true);
    const calls = f.spawn.mock.calls.length;
    resetRecordedWorkerUnit(f.outcome, native, f);
    expect(f.spawn).toHaveBeenCalledTimes(calls);
    expect(f.log).toHaveBeenCalledTimes(1);
  });

  it('retires ownership after a confirmed mismatch', () => {
    const f = setup();
    f.spawn.mockReturnValueOnce({ status: 0, stdout: 'foreign description', stderr: '' });
    resetRecordedWorkerUnit(f.outcome, native, f);
    resetRecordedWorkerUnit(f.outcome, native, f);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('finish preserves overflow stop evidence after unit unload with recovery disabled=%s', async disabled => {
    const f = await workerInvocationFixture({}, { roots, breakers });
    const cleanup = setup();
    const child = Object.assign(new EventEmitter(), { pid: 2147483646,
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), unref() {} });
    const outcome = cleanup.owner.track({ ...cleanup.outcome, child });
    let unloaded = false;
    const isolationStatus = vi.fn(() => {
      if (unloaded) {
        if (disabled) throw new Error('unit unloaded');
        return null;
      }
      return native;
    });
    const launched = new Promise<void>(resolve => f.launcher.once('launched', () => resolve()));
    const done = f.launch({ isolation: { mode: 'systemd-unit' }, isolationStatus,
      ...(disabled ? { scopedBreaker: null } : {}), launchIsolated: () => outcome });
    await launched;
    const stopped = await stopOverflowWorker(outcome, { stopUnit: () => ({ ok: true }),
      unitStatus: isolationStatus,
      recordUnitResult: (launch: any, status: any, result: any) => recordWorkerUnitStop(launch, status, result, cleanup) });
    expect(stopped.termination).toBe('confirmed');
    expect(cleanup.spawn.mock.calls[1][1]).toContain('reset-failed');
    unloaded = true;
    // The wrapper wait status deliberately disagrees with the native SIGKILL.
    child.stdout.end(); child.stderr.end(); child.emit('exit', 0, null); child.emit('close');
    const result = await done;
    expect(isolationStatus.mock.results.at(-1)).toMatchObject(disabled ? { type: 'throw' } : { value: null });
    for (const record of [result, JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8'))]) {
      expect(record).toMatchObject({ nativeResult: 'signal', nativeExecMainStatus: 9,
        exitCode: null, signal: 'SIGKILL', termination: 'confirmed' });
    }
  });

  it('uses a literal pinned unit rather than a mutated outcome name and handles zero status', async () => {
    const f = setup(); f.outcome.unit = 'foreign.service';
    await publishWorkerUnitExit(async () => {}, f.outcome, { ...native, execMainStatus: 0 }, {}, f);
    expect(f.spawn.mock.calls[1][1]).toEqual(['--user', 'reset-failed', '--', 'aiwg-worker-owned-1']);
  });

  it('treats even an option-looking owned name literally', async () => {
    const f = setup();
    const owner = createWorkerUnitOwner('--all', 'unit');
    const outcome = owner.track({});
    f.spawn.mockImplementation((_binary, args) => ({ status: 0, stdout: args.includes('show') ? owner.properties[0].slice('Description='.length) : '', stderr: '' }));
    await publishWorkerUnitExit(async () => {}, outcome, native, {}, f);
    expect(f.spawn.mock.calls[0][1].slice(-2)).toEqual(['--', '--all']);
    expect(f.spawn.mock.calls[1][1]).toEqual(['--user', 'reset-failed', '--', '--all']);
  });

  it('records and cleans MCP overflow status through its existing stop owner', async () => {
    const f = setup();
    const result = await stopOverflowWorker(f.outcome, {
      stopUnit: () => ({ ok: true }), unitStatus: () => native,
      recordUnitResult: (outcome: any, status: any, result: any) => recordWorkerUnitStop(outcome, status, result, f),
    });
    expect(result).toEqual({ termination: 'confirmed', delivered: true, nativeResult: 'signal', nativeExecMainStatus: 9 });
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });

  it('keeps a private child owner across MCP result wrappers and cleans it only once', () => {
    const f = setup();
    const child = new EventEmitter();
    const launch = f.owner.track({ mode: 'systemd-unit', unit: 'aiwg-worker-owned-1', child });
    const wrapped = { ...launch, admission: {} };
    const result = recordWorkerUnitStop(wrapped, native, {}, f);
    expect(result).toMatchObject({ nativeResult: 'signal', nativeExecMainStatus: 9 });
    resetRecordedWorkerUnit(launch, native, f);
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });

  it('reuses verified MCP stop evidence after reset unloads the unit', async () => {
    const f = setup();
    const child = new EventEmitter();
    const launch = f.owner.track({ ...f.outcome, child });
    const stopUnit = vi.fn(() => ({ ok: true }));
    const unitStatus = vi.fn(() => native);
    const result = await stopOverflowWorker(launch, { stopUnit, unitStatus,
      recordUnitResult: (outcome: any, status: any, result: any) => recordWorkerUnitStop(outcome, status, result, f) });
    result.termination = 'uncertain';
    unitStatus.mockImplementation(() => { throw new Error('unit unloaded'); });
    const repeated = await stopOverflowWorker({ ...launch }, { stopUnit, unitStatus });
    expect(repeated).toEqual({ termination: 'confirmed', delivered: true, nativeResult: 'signal', nativeExecMainStatus: 9 });
    repeated.termination = 'uncertain';
    expect(readRecordedWorkerUnitStop(launch)?.termination).toBe('confirmed');
    const snapshot = readRecordedWorkerUnitStop(launch, { native: true });
    expect(snapshot).toEqual(native);
    snapshot.execMainStatus = 0;
    expect(readRecordedWorkerUnitStop(launch, { native: true })).toEqual(native);
    expect(readRecordedWorkerUnitStop({}, { native: true })).toBeNull();
    expect(stopUnit).toHaveBeenCalledTimes(1);
    expect(unitStatus).toHaveBeenCalledTimes(1);
    expect(readRecordedWorkerUnitStop({ ...launch, child: new EventEmitter() })).toBeNull();
  });

  it('does not cache a stop result when reset did not verify ownership', () => {
    const f = setup();
    f.spawn.mockReturnValue({ status: 0, stdout: 'foreign description', stderr: '' });
    recordWorkerUnitStop(f.outcome, native, { termination: 'confirmed' }, f);
    expect(readRecordedWorkerUnitStop(f.outcome)).toBeNull();
  });

  it('uses a concurrent verified stop observed while polling', async () => {
    const f = setup();
    let time = 0;
    const result = await stopOverflowWorker(f.outcome, { stopUnit: () => ({ ok: true }),
      unitStatus: () => { throw new Error('not yet available'); }, clock: () => time,
      sleep: async ms => { time += ms; recordWorkerUnitStop(f.outcome, native, { termination: 'confirmed', delivered: true }, f); },
    });
    expect(result).toMatchObject({ termination: 'confirmed', nativeResult: 'signal', nativeExecMainStatus: 9 });
  });

  it('preserves the result shape of unowned baseline and injected outcomes', async () => {
    const f = setup(); const result = { nativeResult: null };
    await publishWorkerUnitExit(async () => {}, { unit: 'foreign' }, native, result, f);
    expect(result).toEqual({ nativeResult: null });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('does not manufacture raw status when the query failed', async () => {
    const f = setup(); const result = { nativeResult: null };
    await publishWorkerUnitExit(async () => {}, f.outcome, null, result, f);
    expect(result).toEqual({ nativeResult: null }); expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each([true, false])('launch registers its private owner for attached=%s', async attached => {
    const f = setup(); let description = '';
    const child = Object.assign(new EventEmitter(), { pid: 12345 });
    const spawn = vi.fn((_binary: string, args: string[]) => {
      if (args.some(arg => arg.startsWith('Description='))) description = args.find(arg => arg.startsWith('Description='))!.slice('Description='.length);
      return { status: 0, stdout: args.includes('show-environment') ? 'LANG=C' : '12345', stderr: '' };
    });
    const outcome = await launchIsolatedWorker({ command: '/bin/false', memoryMaxGb: 1,
      gate: { enabled: true, ok: true }, isolation: { mode: 'systemd-unit' }, attached,
      spawn, spawnAsync: (_binary: string, args: string[]) => {
        description = args.find(arg => arg.startsWith('Description='))!.slice('Description='.length); return child;
      } });
    f.spawn.mockImplementation((_binary, args) => ({ status: 0, stdout: args.includes('show') ? description : '', stderr: '' }));
    await publishWorkerUnitExit(async () => {}, outcome, native, {}, f);
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('launcher records before cleanup with recovery disabled=%s', async disabled => {
    const f = await workerInvocationFixture({}, { roots, breakers });
    const client = systemdClientFixture(); roots.push(client.root); vi.stubEnv('PATH', client.root);
    let description = '';
    const child = Object.assign(new EventEmitter(), { pid: 2147483646, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), unref() {} });
    const spawn = vi.fn((_binary: string, args: string[]) => ({ status: 0, stdout: args.includes('show-environment') ? 'LANG=C' : '', stderr: '' }));
    const reset = vi.fn();
    // Exercise the production owner while substituting only its OS clients.
    const { publishWorkerRecord } = await import('../../../tools/ralph-external/session-launcher.mjs');
    const launched = new Promise<void>(resolve => f.launcher.once('launched', () => resolve()));
    const done = f.launch({ isolation: { mode: 'systemd-unit' }, isolationStatus: () => native,
      ...(disabled ? { scopedBreaker: null } : {}),
      launchIsolated: (options: any) => launchIsolatedWorker({ ...options, spawn,
        spawnAsync: (_binary: string, args: string[]) => {
          description = args.find(arg => arg.startsWith('Description='))!.slice('Description='.length); return child;
        } }),
      publishRecord: async (...args: any[]) => {
        await publishWorkerRecord(...args);
        if (args[1] === 'exit.json') reset(JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8')));
      },
    });
    await Promise.race([launched, done.then(() => { throw new Error('finished before launch'); })]);
    // Cleanup's real client is a local fixture; return the marker for its show query.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(client.root, 'client.js'), `
      const fs = require('node:fs');
      if (process.argv.includes('reset-failed')) fs.writeFileSync(${JSON.stringify(path.join(f.root, 'at-reset.json'))}, fs.readFileSync(${JSON.stringify(path.join(f.runDir, 'exit.json'))}));
      else console.log(${JSON.stringify(description)});
    `);
    child.stdout.end(); child.stderr.end(); child.emit('exit', null, 'SIGKILL'); child.emit('close');
    const result = await done;
    expect(reset).toHaveBeenCalledWith(expect.objectContaining({ nativeResult: 'signal', nativeExecMainStatus: 9 }));
    expect(result).toMatchObject({ nativeResult: 'signal', nativeExecMainStatus: 9 });
    expect(JSON.parse(await readFile(path.join(f.root, 'at-reset.json'), 'utf8')))
      .toMatchObject({ nativeResult: 'signal', nativeExecMainStatus: 9 });
  });
});
