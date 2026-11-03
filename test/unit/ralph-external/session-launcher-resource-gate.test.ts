import { spawn, spawnSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { checkWorkerDispatch } from '../../../tools/scripts/resource-preflight.mjs';
import { SessionLauncher, resetInProcessAllowanceLedger } from '../../../tools/ralph-external/session-launcher.mjs';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const refuse = () => { throw new Error('Unexpected process spawn'); };
  return { ...actual, spawn: vi.fn(refuse), spawnSync: vi.fn(refuse) };
});

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, access: vi.fn(actual.access) };
});

const readers = {
  readText: (path: string) => {
    if (path === '/proc/meminfo') return 'MemAvailable: 67108864 kB\n';
    if (path === '/proc/loadavg') return '0.1 0.1 0.1 1/100 200\n';
    if (path === '/proc/pressure/memory') return 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
    throw new Error('Unexpected resource file');
  },
  coreCount: () => 8,
  countWorkers: () => 0,
};
const okLive = { supported: true, availMemGb: 64, loadRatio: 0.01,
  memPsiAvg10: 0, memPsiAvg60: 0, workers: 0, freeDiskGb: 64 };
let root: string;

beforeEach(async () => {
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  root = await mkdtemp(join(tmpdir(), 'launcher-resource-gate-'));
});
afterEach(async () => {
  expect(spawn).not.toHaveBeenCalled();
  expect(spawnSync).not.toHaveBeenCalled();
  resetInProcessAllowanceLedger();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function fixture(createRunDir = true) {
  const f = workerResolutionFixture();
  const cwd = join(root, 'work');
  const runDir = join(root, 'run');
  await mkdir(cwd);
  if (createRunDir) await mkdir(runDir, { mode: 0o700 });
  const brief = join(root, 'brief');
  await writeFile(brief, 'synthetic task');
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  const boundary = { kind: 'os' as const, identity: 'fixture:boundary',
    digest: qualificationDigest('boundary'), controls: ['sandbox'] };
  f.snapshot.installations.codex.boundary = boundary;
  const driver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0', boundary },
    buildInvocation: async () => ({ argv: ['/synthetic/worker'], stdin: 'closed', envNames: [] }),
    extractFinal: () => null };
  const inputs = { snapshot: f.snapshot, drivers: { codex: driver } };
  const plan = await resolveWorkerInvocation(f.snapshot, { role: 'coding', task: 'implementation', group: 'workers',
    brief, workdir: cwd, final_output: join(root, 'final.json') }, inputs.drivers, f.request.now);
  expect(plan.invocation, JSON.stringify(plan.diagnostics)).toBeDefined();
  const invocationPath = join(root, 'plan.json');
  await writeFile(invocationPath, JSON.stringify(plan), { mode: 0o600 });
  const launchIsolated = vi.fn(() => { throw new Error('Stubbed spawn boundary'); });
  return { cwd, runDir, inputs, invocationPath, now: f.request.now, launchIsolated,
    isolation: { mode: 'degraded', reason: 'synthetic manager' }, allowDegraded: true };
}

describe('saved-plan launcher resource gate', () => {
  it.each([
    { branch: 'recovery', createRunDir: true },
    { branch: 'baseline', createRunDir: true },
    { branch: 'recovery', createRunDir: false },
    { branch: 'baseline', createRunDir: false },
  ])('detects real free disk at both $branch gates with createRunDir=$createRunDir', async ({ branch, createRunDir }) => {
    const f = await fixture(createRunDir);
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0 });
    let calls = 0;
    const checkDispatch = vi.fn(options => {
      const diskPath = ++calls === 1 && !createRunDir ? root : f.runDir;
      expect(options).toEqual({ config: f.inputs.snapshot.config, paths: [f.cwd, diskPath] });
      const gate = checkWorkerDispatch({ ...options, readers });
      expect(Number.isFinite(gate.live.freeDiskGb)).toBe(true);
      expect(gate.live.freeDiskGb).toBeGreaterThanOrEqual(0);
      expect(gate.failures).not.toContainEqual(expect.objectContaining({ signal: 'free-disk', actual: undefined }));
      // Disk capacity varies by host; test path detection independently of capacity.
      return checkWorkerDispatch({ ...options, live: { ...gate.live, freeDiskGb: 64 } });
    });
    try {
      await expect(new SessionLauncher().launchWorker({ ...f, checkDispatch,
        scopedBreaker: branch === 'baseline' ? null : breaker })).rejects.toThrow('Stubbed spawn boundary');
      expect(checkDispatch).toHaveBeenCalledTimes(2);
      expect(f.launchIsolated).toHaveBeenCalledTimes(1);
    } finally { breaker.destroy(); }
  });

  it.each([
    { parts: ['attempt-1'] },
    { parts: ['missing', 'attempt-1'] },
  ])('samples the existing ancestor of absent $parts and leaves it absent on memory refusal', async ({ parts }) => {
    const f = await fixture(false);
    f.runDir = join(root, ...parts);
    const checkDispatch = vi.fn(options => {
      expect(options).toEqual({ config: f.inputs.snapshot.config, paths: [f.cwd, root] });
      const sampled = checkWorkerDispatch({ ...options, readers });
      expect(Number.isFinite(sampled.live.freeDiskGb)).toBe(true);
      expect(sampled.live.freeDiskGb).toBeGreaterThanOrEqual(0);
      expect(sampled.failures).not.toContainEqual(expect.objectContaining({ signal: 'free-disk', actual: undefined }));
      return checkWorkerDispatch({ ...options, live: { ...sampled.live, availMemGb: 1 } });
    });
    await expect(new SessionLauncher().launchWorker({ ...f, checkDispatch }))
      .rejects.toThrow('Worker dispatch resource gate refused launch: avail-mem: available 1.0GB < 8GB');
    expect(checkDispatch).toHaveBeenCalledTimes(1);
    expect(f.launchIsolated).not.toHaveBeenCalled();
    await expect(lstat(join(root, parts[0]))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(f.runDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed before spawn when the existing run ancestor is unreadable', async () => {
    const f = await fixture(false);
    vi.mocked(access).mockImplementation(async filename => {
      if (filename === root) throw Object.assign(new Error('Directory is unreadable'), { code: 'EACCES' });
    });
    const checkDispatch = vi.fn(options => {
      expect(options).toEqual({ config: f.inputs.snapshot.config, paths: [f.cwd, f.runDir] });
      const gate = checkWorkerDispatch({ ...options, readers });
      expect(gate.live.freeDiskGb).toBeUndefined();
      return gate;
    });
    await expect(new SessionLauncher().launchWorker({ ...f, checkDispatch }))
      .rejects.toThrow('Worker dispatch resource gate refused launch: free-disk: free disk not detectable on this host');
    expect(access).toHaveBeenCalledWith(root, expect.any(Number));
    expect(checkDispatch).toHaveBeenCalledTimes(1);
    expect(f.launchIsolated).not.toHaveBeenCalled();
    await expect(lstat(f.runDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed before spawn when only the root directory exists above the run path', async () => {
    const f = await fixture(false);
    f.runDir = join('/', `${basename(root)}-absent`, 'attempt-1');
    await expect(lstat(f.runDir)).rejects.toMatchObject({ code: 'ENOENT' });
    const checkDispatch = vi.fn(options => {
      expect(options).toEqual({ config: f.inputs.snapshot.config, paths: [f.cwd, f.runDir] });
      const gate = checkWorkerDispatch({ ...options, readers });
      expect(gate.live.freeDiskGb).toBeUndefined();
      return gate;
    });
    await expect(new SessionLauncher().launchWorker({ ...f, checkDispatch }))
      .rejects.toThrow('Worker dispatch resource gate refused launch: free-disk: free disk not detectable on this host');
    expect(checkDispatch).toHaveBeenCalledTimes(1);
    expect(f.launchIsolated).not.toHaveBeenCalled();
    await expect(lstat(f.runDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { branch: 'recovery', at: 1, signal: 'avail-mem', live: { ...okLive, availMemGb: 1 }, reason: 'available 1.0GB < 8GB' },
    { branch: 'baseline', at: 1, signal: 'free-disk', live: { ...okLive, freeDiskGb: 0.5 }, reason: 'free 0.5GB < 2GB' },
    { branch: 'recovery', at: 2, signal: 'free-disk', live: { ...okLive, freeDiskGb: 0.5 }, reason: 'free 0.5GB < 2GB' },
    { branch: 'baseline', at: 2, signal: 'avail-mem', live: { ...okLive, availMemGb: 1 }, reason: 'available 1.0GB < 8GB' },
  ])('refuses $signal before spawn at $branch gate $at with its reason', async ({ branch, at, signal, live, reason }) => {
    const f = await fixture();
    const breaker = new ScopedFailureBreaker({ nowMs: () => 0 });
    let calls = 0;
    const checkDispatch = vi.fn(options => {
      expect(options).toEqual({ config: f.inputs.snapshot.config, paths: [f.cwd, f.runDir] });
      return checkWorkerDispatch({ ...options, live: ++calls === at ? live : okLive });
    });
    try {
      await expect(new SessionLauncher().launchWorker({ ...f, checkDispatch,
        scopedBreaker: branch === 'baseline' ? null : breaker }))
        .rejects.toThrow(new Error(`Worker dispatch resource gate refused launch: ${signal}: ${reason}`));
      expect(checkDispatch).toHaveBeenCalledTimes(at);
      expect(f.launchIsolated).not.toHaveBeenCalled();
    } finally { breaker.destroy(); }
  });

  it('names multiple failing signals and bounds refusal diagnostics to one line', async () => {
    const f = await fixture();
    const checkDispatch = () => ({ enabled: true, ok: false, failures: [
      { signal: 'avail-mem', reason: 'low\nmemory' },
      { signal: 'free-disk', reason: 'x'.repeat(4096) },
      ...Array.from({ length: 20 }, () => ({ signal: 'load', reason: 'y'.repeat(4096) })),
    ] });
    const error = await new SessionLauncher().launchWorker({ ...f, checkDispatch }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('avail-mem: low memory; free-disk: ');
    expect(error.message).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(error.message.length).toBeLessThanOrEqual('Worker dispatch resource gate refused launch: '.length + 1024);
    expect(f.launchIsolated).not.toHaveBeenCalled();
  });

  it('preserves the generic Error message for a seam refusal without failures', async () => {
    const f = await fixture();
    await expect(new SessionLauncher().launchWorker({ ...f,
      checkDispatch: () => ({ enabled: true, ok: false }) }))
      .rejects.toThrow(new Error('Worker dispatch resource gate refused launch'));
    expect(f.launchIsolated).not.toHaveBeenCalled();
  });
});
