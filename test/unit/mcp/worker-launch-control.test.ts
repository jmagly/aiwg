// Exercise MCP launch admission and control contracts with a synthetic capture owner.
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { launchMcpShellWorker } from '../../../tools/ralph-external/lib/mcp-worker-launch.mjs';

const doubles = vi.hoisted(() => ({
  launch: vi.fn(), direct: vi.fn(), isolated: vi.fn(), check: vi.fn(), owners: [] as any[],
}));
vi.mock('../../../tools/ralph-external/session-launcher.mjs', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    SessionLauncher: class extends EventEmitter {
      constructor() { super(); doubles.owners.push(this); }
      launchWorker(options: any) { return doubles.launch(this, options); }
    },
    planDirectWorkerLaunch: doubles.direct,
  };
});
vi.mock('../../../tools/ralph-external/lib/worker-isolation.mjs', () => ({
  checkWorkerDispatch: doubles.check, launchIsolatedWorker: doubles.isolated,
}));

const roots: string[] = [];
const finishers: Array<() => void> = [];
afterEach(async () => {
  for (const finish of finishers.splice(0)) finish();
  vi.useRealTimers();
  doubles.owners.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-mcp-control-'));
  roots.push(root);
  let complete!: (value: any) => void;
  let fail!: (error: Error) => void;
  const completion = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  finishers.push(() => complete({ exitCode: 0, termination: 'confirmed' }));
  const child = Object.assign(new EventEmitter(), { pid: 12345 });
  const launch = { mode: 'native-sandbox', pid: child.pid, child };
  doubles.isolated.mockResolvedValue(launch);
  doubles.direct.mockResolvedValue(launch);
  const stop = vi.fn();
  const spawnOptions = { command: 'synthetic-worker', args: ['--fixture'], cwd: root };
  doubles.launch.mockImplementation(async (owner, options) => {
    await options.launchIsolated(spawnOptions);
    owner.workerStop = stop;
    owner.emit('launched');
    return completion;
  });
  const invocation = { id: 'synthetic-invocation' };
  const options = {
    plan: { invocation }, invocationId: 'mcp-control', servedRoot: root,
    releaseOutput: vi.fn(async () => {}), onRunDir: vi.fn(), loadInputs: vi.fn(),
    now: () => new Date('2026-11-12T12:00:00Z'),
    spawn: vi.fn(), spawnAsync: vi.fn(), isolation: { mode: 'native-sandbox' },
    live: { supported: true }, readers: { marker: 'reader' }, thresholdOverlay: { workers: 2 },
  };
  return { root, invocation, options, launch, child, stop, spawnOptions, complete, fail,
    start: (extra: object = {}) => launchMcpShellWorker(invocation, { ...options, ...extra }) };
}

it.each([0, -1, NaN, Infinity, -Infinity])('refuses invalid memory ceiling %s before reserving outputs', async memoryMaxGb => {
  const h = await harness();
  await expect(h.start({ memoryMaxGb })).rejects.toThrow('positive memoryMaxGb ceiling');
  expect(await readdir(h.root)).toEqual([]);
  expect(h.options.releaseOutput).not.toHaveBeenCalled();
  expect(doubles.launch).not.toHaveBeenCalled();
});

it('passes borrowed admission and its dispatch guard to the direct planner after releasing outputs', async () => {
  const h = await harness();
  const admission = { reservationId: 'borrowed-admission' };
  const dispatchGuard = vi.fn();
  doubles.direct.mockImplementation(async options => {
    expect(h.options.releaseOutput).toHaveBeenCalledExactlyOnceWith();
    expect(h.options.onRunDir).toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(h.options.onRunDir.mock.calls[0][0], '..', 'plan.json'), 'utf8')))
      .toEqual(h.options.plan);
    return h.launch;
  });
  const result = await h.start({ admission, dispatchGuard, memoryMaxGb: 4 });
  expect(doubles.direct).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    ...h.spawnOptions, invocation: h.invocation, invocationId: h.options.invocationId,
    admission, dispatchGuard, live: h.options.live, readers: h.options.readers,
    thresholdOverlay: h.options.thresholdOverlay, spawn: h.options.spawn, spawnAsync: h.options.spawnAsync,
    onSpawnAttempt: expect.any(Function),
  }));
  expect(doubles.isolated).not.toHaveBeenCalled();
  const ownerOptions = doubles.launch.mock.calls[0][1];
  expect(ownerOptions).toMatchObject({ memoryMaxGb: 4, scopedBreaker: null, isolation: h.options.isolation });
  expect(ownerOptions.now()).toBe('2026-11-12T12:00:00.000Z');
  const gateOptions = { config: { enabled: true } };
  ownerOptions.checkDispatch(gateOptions);
  expect(doubles.check).toHaveBeenCalledExactlyOnceWith({ ...gateOptions,
    live: h.options.live, readers: h.options.readers, thresholdOverlay: h.options.thresholdOverlay });
  const planPath = join(result.runDir, '..', 'plan.json');
  expect((await stat(planPath)).mode & 0o777).toBe(0o600);
  expect(result).toMatchObject({ launchAttempted: true, ownedGroup: true });
  h.complete({ exitCode: 0, termination: 'confirmed' });
  await expect(result.cleanup()).resolves.toBe(h.launch);
});

it('uses isolated launch without admission and retains close as observation only', async () => {
  const h = await harness();
  const result = await h.start();
  expect(doubles.isolated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    ...h.spawnOptions, spawn: h.options.spawn, spawnAsync: h.options.spawnAsync,
  }));
  expect(doubles.direct).not.toHaveBeenCalled();
  h.child.emit('close', 0, null);
  expect(h.launch).toHaveProperty('spawnObservation', { closed: true, exitCode: 0, signalCode: null });
  expect(await result.control.stop()).toBe(true);
  expect(h.stop).toHaveBeenCalledExactlyOnceWith();
  h.complete({ exitCode: 0, termination: 'uncertain', descendants: 'unknown' });
  await expect(result.control.wait(1000)).resolves.toMatchObject({ termination: 'uncertain', stopped: false });
});

it('reports stop unavailable after the owner releases its stop authority', async () => {
  const h = await harness();
  const result = await h.start();
  doubles.owners[0].workerStop = null;
  expect(await result.control.stop()).toBe(false);
  expect(h.stop).not.toHaveBeenCalled();
  h.complete({ exitCode: 0, termination: 'confirmed' });
  await expect(result.control.stopAndConfirm()).resolves.toMatchObject({ stopped: false, termination: 'confirmed' });
  result.control.dispose();
});

it('stopAndConfirm waits for the capture owner even after requesting cancellation', async () => {
  const h = await harness();
  const result = await h.start();
  const observed = vi.fn();
  const pending = result.control.stopAndConfirm().then(observed);
  expect(h.stop).toHaveBeenCalledExactlyOnceWith();
  await Promise.resolve();
  expect(observed).not.toHaveBeenCalled();
  h.complete({ cancelled: true, termination: 'uncertain', descendants: 'unknown' });
  await pending;
  expect(observed).toHaveBeenCalledExactlyOnceWith({
    cancelled: true, stopped: true, termination: 'uncertain', descendants: 'unknown',
  });
});

it.each([
  { deadlineMs: 100, deadlineAtMs: 1040, nowMs: 1000, remaining: 40 },
  { deadlineMs: 20, deadlineAtMs: 1040, nowMs: 1000, remaining: 20 },
  { deadlineMs: 100, deadlineAtMs: 900, nowMs: 1000, remaining: 0 },
  { deadlineMs: 30, deadlineAtMs: undefined, nowMs: 1000, remaining: 30 },
])('wait stops at the earlier relative/absolute deadline: %j', async clock => {
  const h = await harness();
  const result = await h.start();
  vi.useFakeTimers();
  const nowMs = vi.fn(() => clock.nowMs);
  const observed = vi.fn();
  const pending = result.control.wait(clock.deadlineMs, { deadlineAtMs: clock.deadlineAtMs, nowMs }).then(observed);
  expect(nowMs).toHaveBeenCalledExactlyOnceWith();
  if (clock.remaining > 0) await vi.advanceTimersByTimeAsync(clock.remaining - 1);
  expect(h.stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(clock.remaining > 0 ? 1 : 0);
  expect(h.stop).toHaveBeenCalledExactlyOnceWith('HARD_DEADLINE');
  expect(observed).not.toHaveBeenCalled();
  h.complete({ cancelled: true, termination: 'confirmed' });
  await pending;
  expect(observed).toHaveBeenCalledExactlyOnceWith({ cancelled: true, termination: 'confirmed', stopped: true });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['completed', 'failed'])('wait clears its deadline when capture %s before timeout', async outcome => {
  const h = await harness();
  const result = await h.start();
  vi.useFakeTimers();
  const pending = result.control.wait(100);
  expect(vi.getTimerCount()).toBe(1);
  if (outcome === 'completed') {
    h.complete({ exitCode: 0, termination: 'confirmed' });
    await expect(pending).resolves.toMatchObject({ stopped: false });
  } else {
    const error = new Error('synthetic capture failure');
    const cleanup = expect(result.cleanup()).rejects.toBe(error);
    h.fail(error);
    await expect(pending).rejects.toBe(error);
    await cleanup;
  }
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.stop).not.toHaveBeenCalled();
});

it.each([
  { mode: 'native-sandbox', pid: 12345, expected: true },
  { mode: 'degraded', pid: 12345, expected: true },
  { mode: 'degraded', pid: undefined, expected: false },
  { mode: 'systemd-unit', pid: 12345, expected: false },
  { mode: 'native-sandbox', pid: 12345, ownedGroup: false, expected: false },
  { mode: 'systemd-unit', pid: undefined, ownedGroup: true, expected: true },
])('preserves explicit group ownership and otherwise derives it from mode/pid: %j', async scenario => {
  const h = await harness();
  const { expected, ...launch } = scenario;
  doubles.isolated.mockResolvedValue(launch);
  const result = await h.start({ runDir: join(h.root, 'chosen-run') });
  expect(result).toMatchObject({ runDir: join(h.root, 'chosen-run'), ownedGroup: expected, launchAttempted: false });
  h.complete({ exitCode: 0 });
  await result.cleanup();
});
