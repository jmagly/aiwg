import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { systemdClientFixture } from '../../fixtures/systemd-client.js';
import { WORKER_OPERATOR_APPROVAL } from '../../../src/models/provider-policy.js';
import { resolveWorkerInvocation, revalidateWorkerInvocationPlan } from '../../../src/serve/worker-invocation.js';
import { SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';
import { launchIsolatedWorker } from '../../../tools/ralph-external/lib/worker-isolation.mjs';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(mode: 'systemd-unit' | 'native-sandbox' = 'systemd-unit', sandbox: 'workspace-write' | 'read-only' = 'workspace-write', hardTimeoutSeconds = 30) {
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const clients = systemdClientFixture(); roots.push(clients.root);
  vi.stubEnv('PATH', clients.root);
  const root = await mkdtemp(join(tmpdir(), 'launcher-native-sandbox-')); roots.push(root);
  const f = workerResolutionFixture();
  f.snapshot.config.parallelism!.health = { hardTimeoutSeconds, terminateGraceSeconds: 1 };
  const cwd = join(root, 'work'); await mkdir(cwd);
  const brief = join(root, 'brief'); await writeFile(brief, 'Synthetic task.');
  const final = join(root, 'final.json');
  const runDir = join(root, 'run');
  const group = f.snapshot.config.parallelism!.groups!.workers;
  group.execution = { sandbox, approval: 'never', network: 'deny', transport: 'shell',
    ...(mode === 'native-sandbox' ? { launchMode: mode } : {}) };
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  adapter.provider = 'codex';
  adapter.qualification.evidenceRef = WORKER_OPERATOR_APPROVAL;
  adapter.invocationProfiles!['fixture-shell'].envAllowlist = [];
  const driver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0' },
    buildInvocation: async (input: any) => ({ argv: ['/synthetic/codex', '--no-daemon', 'exec', '--ignore-user-config',
      '-m', input.selected.model, '-s', input.permissions.sandbox,
      '-c', `model_reasoning_effort=${JSON.stringify(input.selected.effort.value)}`,
      '-c', 'approval_policy="never"', '-C', cwd, '-o', final, '--json', '-'], stdin: 'closed', envNames: [] }),
    extractFinal: () => ({ summary: 'Synthetic result.' }) };
  const inputs = { snapshot: f.snapshot, drivers: { codex: driver } };
  const request = { role: 'coding' as const, task: 'implementation', group: 'workers', brief, workdir: cwd, final_output: final };
  const resolve = () => resolveWorkerInvocation(f.snapshot, request, inputs.drivers, f.request.now);
  const plan = await resolve();
  expect(plan.invocation, JSON.stringify(plan)).toBeDefined();
  const invocationPath = join(root, 'plan.json'); await writeFile(invocationPath, JSON.stringify(plan));
  const syncSpawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
  const asyncSpawn = vi.fn(() => {
    const child: any = new EventEmitter();
    child.pid = 2147483646; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
    setImmediate(() => {
      writeFileSync(final, JSON.stringify({ summary: 'Synthetic result.' }));
      child.stdout.end(); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
    });
    return child;
  });
  const launchIsolated = vi.fn(options => launchIsolatedWorker({ ...options, spawn: syncSpawn, spawnAsync: asyncSpawn }));
  const probeNativeSandbox = vi.fn(() => ({ ok: true, mode: 'systemd-unit' }));
  const launcher = new SessionLauncher();
  // #3505: policy/isolation tests must not consume the fixture's one-second
  // dispatch budget on real preparation I/O under load. Worker timers remain real.
  const options = { dispatchGuard: { nowMs: () => 0, deadlineAtMs: 1000 },
    invocationPath, runDir, inputs, now: f.request.now, scopedBreaker: null,
    checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
    isolation: { mode: 'systemd-unit', reason: 'Synthetic manager' }, probeNativeSandbox, launchIsolated,
    isolationStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0, result: 'success' }) };
  return { ...f, root, runDir, plan, resolve, group, inputs, launcher, options, syncSpawn, asyncSpawn, launchIsolated, probeNativeSandbox };
}

describe('policy-selected native sandbox launch', () => {
  it.each([null, undefined])('refuses a failed unit probe before spawn or run directory creation (breaker=%s)', async scopedBreaker => {
    const f = await fixture();
    f.probeNativeSandbox.mockReturnValue({ ok: false, mode: 'systemd-unit', mechanism: 'bwrap', detail: 'uid_map: Operation not permitted' } as any);
    const error = await f.launcher.launchWorker({ ...f.options, scopedBreaker }).catch((error: Error) => error);
    expect(error).toMatchObject({ name: 'WorkerPolicyError', code: 'OG_NATIVE_SANDBOX_UNAVAILABLE' });
    expect(error.message).toMatch(/^OG_NATIVE_SANDBOX_UNAVAILABLE:/);
    expect(error.message).toContain('bwrap probe failed inside a systemd user unit');
    expect(error.message).toContain('uid_map: Operation not permitted');
    expect(error.message).not.toMatch(/AppArmor|launchMode=/);
    expect(f.launchIsolated).not.toHaveBeenCalled();
    await expect(lstat(f.runDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses current execution policy for the probe even if saved selection metadata is altered', async () => {
    const f = await fixture();
    f.plan.selected!.permissions.sandbox = 'external';
    await writeFile(f.options.invocationPath, JSON.stringify(f.plan));
    f.probeNativeSandbox.mockReturnValue({ ok: false, mode: 'systemd-unit', mechanism: 'bwrap', detail: 'uid_map: Operation not permitted' } as any);
    await expect(f.launcher.launchWorker(f.options)).rejects.toMatchObject({ code: 'OG_NATIVE_SANDBOX_UNAVAILABLE' });
    expect(f.probeNativeSandbox).toHaveBeenCalledOnce();
    expect(f.launchIsolated).not.toHaveBeenCalled();
  });

  it('defaults to the systemd unit after a passing probe; an environment variable cannot opt in', async () => {
    vi.stubEnv('AIWG_WORKER_LAUNCH_MODE', 'native-sandbox');
    const f = await fixture();
    const result = await f.launcher.launchWorker(f.options);
    expect(result.isolation).toBe('systemd-unit');
    expect(f.probeNativeSandbox).toHaveBeenCalledOnce();
    expect(f.syncSpawn).toHaveBeenCalled();
    expect(f.asyncSpawn.mock.calls[0][0]).toMatch(/systemd-run$/);
    expect(f.plan.invocation!.isolation).toBe('systemd-unit');
  });

  it.each([null, undefined])('uses an owned process group and records native evidence and events (breaker=%s)', async scopedBreaker => {
    const f = await fixture('native-sandbox');
    const events = vi.fn(); f.launcher.on('launched', events);
    const result = await f.launcher.launchWorker({ ...f.options, scopedBreaker });
    expect(result).toMatchObject({ isolation: 'native-sandbox', termination: 'uncertain', descendants: 'unknown' });
    expect(f.probeNativeSandbox).not.toHaveBeenCalled();
    expect(f.syncSpawn).not.toHaveBeenCalled();
    expect(f.asyncSpawn.mock.calls[0][0]).toBe(process.execPath);
    expect(f.asyncSpawn.mock.calls[0][2]).toMatchObject({ detached: true });
    expect(events.mock.calls[0][0]).toMatchObject({ isolation: 'native-sandbox' });
    for (const file of ['process.json', 'exit.json']) {
      expect(JSON.parse(await readFile(join(f.runDir, file), 'utf8')).isolation).toBe('native-sandbox');
    }
    expect(JSON.parse(await readFile(join(f.runDir, 'invocation.json'), 'utf8')).isolation)
      .toEqual({ mode: 'native-sandbox', memoryMaxGb: null });
  });

  it('permits the verified read-only native renderer', async () => {
    const f = await fixture('native-sandbox', 'read-only');
    const result = await f.launcher.launchWorker(f.options);
    expect(result.isolation).toBe('native-sandbox');
    expect(f.probeNativeSandbox).not.toHaveBeenCalled();
    expect(f.syncSpawn).not.toHaveBeenCalled();
  });

  it.each(['external', 'none', 'danger-full-access', 'unknown'])('refuses native-sandbox with sandbox=%s', async sandbox => {
    const f = await fixture('native-sandbox');
    f.group.execution!.sandbox = sandbox as any;
    const plan = await f.resolve();
    expect(plan.status).toBe('blocked');
    expect(plan.invocation).toBeUndefined();
    expect(f.asyncSpawn).not.toHaveBeenCalled();
  });

  it.each(['systemd-unit', 'native-sandbox'] as const)('refuses a saved %s plan when launch mode changes', async mode => {
    const f = await fixture(mode);
    f.group.execution!.launchMode = mode === 'native-sandbox' ? 'systemd-unit' : 'native-sandbox';
    await expect(revalidateWorkerInvocationPlan(f.plan, f.snapshot, f.inputs.drivers, f.request.now))
      .rejects.toMatchObject({ code: 'OG_PIN_MISMATCH' });
    await expect(f.launcher.launchWorker(f.options)).rejects.toMatchObject({ code: 'OG_PIN_MISMATCH' });
    expect(f.launchIsolated).not.toHaveBeenCalled();
  });

  it('revalidates native launch policy again immediately before spawn', async () => {
    const f = await fixture('native-sandbox');
    let loads = 0;
    await expect(f.launcher.launchWorker({ ...f.options, loadInputs: async () => {
      if (++loads === 2) f.group.execution!.launchMode = 'systemd-unit';
      return f.inputs;
    } })).rejects.toMatchObject({ code: 'OG_PIN_MISMATCH' });
    expect(loads).toBe(2);
    expect(f.launchIsolated).not.toHaveBeenCalled();
  });

  it.each([1, 2])('keeps resource gate %s before a native-sandbox launch', async at => {
    const f = await fixture('native-sandbox');
    let calls = 0;
    await expect(f.launcher.launchWorker({ ...f.options,
      checkDispatch: () => ++calls === at ? { enabled: true, ok: false, failures: [{ signal: 'avail-mem', reason: 'Synthetic memory pressure' }] }
        : { enabled: true, ok: true, failures: [] } }))
      .rejects.toThrow('Worker dispatch resource gate refused launch: avail-mem: Synthetic memory pressure');
    expect(f.launchIsolated).not.toHaveBeenCalled();
    if (at === 1) await expect(lstat(f.runDir)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(JSON.parse(await readFile(join(f.runDir, 'exit.json'), 'utf8')))
      .toMatchObject({ isolation: 'native-sandbox', descendants: 'not-started' });
  });

  it('bounds a timed-out native process group without claiming descendant termination', async () => {
    const f = await fixture('native-sandbox', 'workspace-write', 1);
    f.asyncSpawn.mockImplementation(() => {
      const child: any = new EventEmitter(); child.pid = 2147483646;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
      return child;
    });
    const result = await f.launcher.launchWorker(f.options);
    expect(result).toMatchObject({ isolation: 'native-sandbox', timedOut: true, termination: 'uncertain', descendants: 'unknown' });
    expect(f.launcher.currentProcess).toBeNull();
    expect(f.syncSpawn).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'systemd-unit', signature: 'loopback: Failed RTM_NEWADDR: Operation not permitted', recovery: false },
    { mode: 'systemd-unit', signature: 'uid_map: Operation not permitted', recovery: false },
    { mode: 'systemd-unit', signature: 'uid_map: Operation not permitted', recovery: true },
    { mode: 'native-sandbox', signature: 'uid_map: Operation not permitted', recovery: false },
  ] as const)('maps $mode runtime namespace failure $signature to its specific code (recovery=$recovery)', async ({ mode, signature, recovery }) => {
      const f = await fixture(mode);
      f.asyncSpawn.mockImplementation(() => {
        const child: any = new EventEmitter(); child.pid = 2147483646;
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
        setImmediate(() => {
          child.stderr.write(signature.slice(0, 12)); child.stderr.end(signature.slice(12) + 'x'.repeat(2048));
          child.stdout.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
        });
        return child;
      });
      const result = await f.launcher.launchWorker({ ...f.options, scopedBreaker: recovery ? undefined : null });
      if (recovery) expect(result.attemptOutcome).toBe('failed');
      expect(result.errorCode).toBe('OG_NATIVE_SANDBOX_UNAVAILABLE');
      expect(JSON.parse(await readFile(join(f.runDir, 'exit.json'), 'utf8')).errorCode).toBe(result.errorCode);
    });
});
