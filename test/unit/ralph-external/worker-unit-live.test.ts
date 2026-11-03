// Real systemd cases clean up their own units and assert the manager has no failed workers.
import { workerInvocationFixture } from '../../fixtures/worker-single-invocation.js';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rmSync } from '../../helpers/worker-capture-cleanup.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as workerIsolation from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import { buildSystemdClientEnv, resolveSystemdClient } from '../../../tools/ralph-external/lib/systemd-client.mjs';
import { publishWorkerUnitExit } from '../../../tools/ralph-external/lib/worker-unit-cleanup.mjs';
const { detectWorkerIsolation, launchIsolatedWorker, stopWorkerUnit } = workerIsolation;
const roots: string[] = [];
const breakers: any[] = [];
const fixture = (options: any) => workerInvocationFixture(options, { roots, breakers });
const tmpWorktree = () => { const root = mkdtempSync(path.join(tmpdir(), 'aiwg-live-unit-')); roots.push(root); return root; };
afterEach(() => { for (const breaker of breakers.splice(0)) breaker.destroy(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// This is an actual OOM containment probe; absence of a user manager is a skip.
describe('worker isolation live systemd-run', () => {
  it('kills an over-ceiling allocator while the parent survives', async ctx => {
    if (detectWorkerIsolation().mode !== 'systemd-unit') { ctx.skip(); return; }
    const { spawnSync } = await import('node:child_process');
    const unit = `aiwg-worker-oom-probe-${process.pid}-${Date.now()}`;
    const parentPid = process.pid;
    try {
      const outcome = launchIsolatedWorker({
        memoryMaxGb: 64 / 1024, command: process.execPath,
        args: ['-e', 'const held=Array.from({length:25},()=>Buffer.alloc(8*1024*1024,1)); setInterval(()=>{ if (!held.length) process.exit(1); },1000);'],
        cwd: '/tmp', gate: { enabled: true, ok: true, failures: [] },
        isolation: { mode: 'systemd-unit', reason: 'live probe' }, proposeUnit: () => unit,
      });
      expect(outcome.launched).toBe(true);
      let status;
      const deadline = Date.now() + 20000;
      do {
        status = workerIsolation.getWorkerIsolationStatus(unit);
        if (!status.active && (status.result === 'oom-kill' || status.execMainStatus === 9)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      expect(status.active).toBe(false);
      expect(status.result === 'oom-kill' || status.execMainStatus === 9).toBe(true);
      expect(status.memoryMax).toBeCloseTo(64 * 1024 * 1024, -3);
      expect(process.pid).toBe(parentPid);
      expect(() => process.kill(parentPid, 0)).not.toThrow();
    } finally {
      spawnSync('systemctl', ['--user', 'stop', unit], { timeout: 10000 });
      spawnSync('systemctl', ['--user', 'reset-failed', unit], { timeout: 10000 });
    }
  }, 30000);

  it.skipIf(process.platform !== 'linux')('prints the real unit environment with caller precedence and no conductor/manager secrets or connections', async ctx => {
    if (detectWorkerIsolation().mode !== 'systemd-unit') { ctx.skip('no reachable user manager'); return; }
    const root = tmpWorktree();
    const unit = `aiwg-worker-env-probe-${process.pid}-${Date.now()}`;
    const suffix = `${process.pid}_${Date.now()}`;
    const managerSecret = `AIWG_MANAGER_SECRET_${suffix}`;
    const callerName = `AIWG_CALLER_VALUE_${suffix}`;
    const conductorSecret = `AIWG_CONDUCTOR_SECRET_${suffix}`;
    const logFile = path.join(root, 'environment.json');
    const systemctl = resolveSystemdClient('systemctl');
    const controlEnv = buildSystemdClientEnv({ envNames: [] });
    const control = (args: string[]) => realSpawnSync(systemctl, ['--user', ...args], { env: controlEnv, encoding: 'utf8', timeout: 10000 });
    vi.stubEnv(conductorSecret, 'synthetic-conductor-secret');
    vi.stubEnv(callerName, 'conductor-value');
    try {
      expect(control(['set-environment', `${managerSecret}=synthetic-manager-secret`, `${callerName}=manager-value`]).status).toBe(0);
      const callerValue = 'caller-only literal $HOME';
      const outcome = launchIsolatedWorker({ command: process.execPath,
        args: ['-e', 'console.log(JSON.stringify(process.env))'], memoryMaxGb: 0.25,
        cwd: root, logFile, gate: { enabled: true, ok: true, failures: [] }, proposeUnit: () => unit,
        env: { PATH: process.env.PATH, HOME: root, [callerName]: callerValue,
          XDG_RUNTIME_DIR: '/caller/runtime', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/caller/bus', SYSTEMD_BUS_ADDRESS: 'unix:path=/caller/systemd-bus' },
        envNames: ['PATH', 'HOME', callerName, 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMD_BUS_ADDRESS'],
      });
      expect(outcome.launched).toBe(true);
      const deadline = Date.now() + 10000;
      while (workerIsolation.getWorkerIsolationStatus(unit).active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      expect(workerIsolation.getWorkerIsolationStatus(unit)).toMatchObject({ active: false, result: 'success', execMainStatus: 0 });
      const inside = JSON.parse(readFileSync(logFile, 'utf8'));
      expect(inside[callerName]).toBe(callerValue);
      expect(inside.HOME).toBe(root);
      for (const name of [managerSecret, conductorSecret, 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMD_BUS_ADDRESS']) expect(inside).not.toHaveProperty(name);
    } finally {
      control(['stop', unit]); control(['reset-failed', unit]);
      control(['unset-environment', managerSecret, callerName]);
    }
  }, 20000);
});


describe('MAJOR regression (#2895): systemd-unit mode has real stop authority', () => {
  it('stops the unit via systemctl on hard timeout; confirmation comes from unit state, not the stop request', async ctx => {
    if (detectWorkerIsolation().mode !== 'systemd-unit') { ctx.skip(); return; }
    const { spawnSync } = await import('node:child_process');
    const f = await fixture({ scenario: 'hang', hardTimeoutSeconds: 1 });
    const unit = `aiwg-worker-stop-probe-${process.pid}-${Date.now()}`;
    const stopSpy = vi.fn((unit: string) => stopWorkerUnit(unit));
    try {
      const result = await f.launch({ isolation: { mode: 'systemd-unit', reason: 'live probe' }, stopUnit: stopSpy,
        launchIsolated: (options: any) => launchIsolatedWorker({ ...options, proposeUnit: () => unit }),
      });
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(result.isolation).toBe('systemd-unit');
      expect(result.timedOut).toBe(true);
      // Stop authority here is `systemctl --user stop`, not a best-effort
      // PID/PGID signal against an identity that may still be unresolved.
      // Confirmation still comes only from the unit's own retained state
      // (checked via getWorkerIsolationStatus inside finish()); issuing the
      // stop request is not itself proof of termination.
      expect(['confirmed', 'uncertain']).toContain(result.termination);
      if (result.termination === 'confirmed') expect(result.descendants).toBe('stopped');
    } finally {
      spawnSync('systemctl', ['--user', 'stop', unit], { timeout: 10000 });
      spawnSync('systemctl', ['--user', 'reset-failed', unit], { timeout: 10000 });
    }
  }, 20000);
});

it('records failed status before production cleanup and leaves its own unit reset', async ctx => {
  if (detectWorkerIsolation().mode !== 'systemd-unit') { ctx.skip('no reachable user manager'); return; }
  const root = tmpWorktree();
  const unit = `aiwg-worker-cleanup-${process.pid}-${Date.now()}`;
  const client = resolveSystemdClient('systemctl');
  const control = (args: string[]) => realSpawnSync(client, ['--user', ...args], {
    timeout: 1000, killSignal: 'SIGKILL', encoding: 'utf8', env: buildSystemdClientEnv({ envNames: [] }),
  });
  try {
    const outcome = launchIsolatedWorker({ command: '/bin/false', memoryMaxGb: 0.25,
      gate: { enabled: true, ok: true }, proposeUnit: () => unit });
    expect(outcome.launched).toBe(true);
    let native;
    const deadline = Date.now() + 10000;
    do {
      native = workerIsolation.getWorkerIsolationStatus(unit);
      if (native.active === false) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    expect(native).toMatchObject({ active: false, result: 'exit-code', execMainStatus: 1 });
    const log = vi.fn();
    await publishWorkerUnitExit(async (name: string, value: unknown) => {
      writeFileSync(path.join(root, name), JSON.stringify(value));
    }, outcome, native, {}, { log });
    expect(log).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path.join(root, 'exit.json'), 'utf8')))
      .toMatchObject({ nativeResult: 'exit-code', nativeExecMainStatus: 1 });
    // Check only the unit this test owns: other suites or worktrees on the same host may leave
    // their own units behind, which must not make this test depend on machine state.
    const failed = control(['list-units', '--failed', '--all', '--no-legend', '--plain', `${unit}.service`]);
    expect(failed.status, failed.stderr).toBe(0);
    expect(failed.stdout.trim()).toBe('');
  } finally { control(['stop', unit]); control(['reset-failed', unit]); }
}, 15000);
