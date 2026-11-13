import { describe, it, expect, vi } from 'vitest';
import { buildConductorArgs, parseConductorArgs, runConductor, stopConductorUnit } from '../../../tools/ralph-external/lib/conductor-isolation.mjs';

const options = { conductorRoot: '/srv/conductor', deliverables: ['/srv/conductor/deliver'], binds: ['/home/test/.codex'], envNames: ['API_KEY'], command: ['/bin/sh', '-c', 'true'] };
const enforced = { mode: 'systemd-unit', writeConfinement: 'enforced', homeReadIsolation: 'enforced', tmpIsolation: 'enforced' };
describe('T-OG-04 confined conductor', () => {
  it('binds every grant, protects every deliverable, keeps network and removes manager connections', () => {
    const args = buildConductorArgs(options);
    for (const property of ['BindPaths=/srv/conductor', 'BindPaths=/home/test/.codex', 'ReadOnlyPaths=/srv/conductor/deliver', 'ProtectHome=tmpfs', 'PrivateTmp=yes', 'NoNewPrivileges=yes', 'InaccessiblePaths=/run/user /run/dbus']) expect(args).toContain(property);
    expect(args).toContain('--pipe'); expect(args).toContain('--wait');
    expect(args).toContain('--setenv=API_KEY');
    expect(args.join(' ')).toContain('UnsetEnvironment=DBUS_SESSION_BUS_ADDRESS SYSTEMD_BUS_ADDRESS XDG_RUNTIME_DIR');
    expect(args.join(' ')).not.toContain('PrivateNetwork=yes');
    expect(args.join(' ')).toContain('systemctl');
  });
  it.each(['writeConfinement', 'homeReadIsolation', 'tmpIsolation'])('fails closed for degraded %s', capability => {
    const spawn = vi.fn();
    expect(() => runConductor(options, { probe: () => ({ ...enforced, [capability]: 'degraded' }), spawn })).toThrow(/ISOLATION_UNAVAILABLE/);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('passes values only through the client environment', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    expect(runConductor(options, { probe: () => enforced, spawn, resolveRun: () => '/usr/bin/systemd-run', env: { API_KEY: 'synthetic-value' } })).toBe(0);
    expect(spawn.mock.calls[0][1].join(' ')).not.toContain('synthetic-value');
    expect(spawn.mock.calls[0][2].env.API_KEY).toBe('synthetic-value');
  });
  it('names the unit, caps runtime and stops the unit from outside after systemd-run returns', () => {
    // Killing systemd-run alone leaves a --pipe --wait unit running (noodle, 2026-11-12).
    const spawn = vi.fn(() => ({ status: 0 }));
    expect(runConductor({ ...options, maxRuntimeSeconds: 1200, unitName: 'aiwg-conductor-test-1' }, { probe: () => enforced, spawn, resolveRun: () => '/usr/bin/systemd-run', env: {} })).toBe(0);
    const runArgs = spawn.mock.calls[0][1];
    expect(runArgs).toContain('--unit=aiwg-conductor-test-1');
    expect(runArgs).toContain('RuntimeMaxSec=1200');
    expect(spawn.mock.calls[1][0]).toBe('systemctl');
    expect(spawn.mock.calls[1][1]).toEqual(['--user', 'stop', 'aiwg-conductor-test-1']);
  });
  it('generates a unit name by default and reports a signal received while systemd-run ran', () => {
    const listenersBefore = process.listenerCount('SIGTERM');
    const spawn = vi.fn((command: string) => { if (command !== 'systemctl') process.emit('SIGTERM' as any); return { status: 0, signal: null }; });
    expect(runConductor(options, { probe: () => enforced, spawn, resolveRun: () => '/usr/bin/systemd-run', env: {} })).toBe(143);
    const unit = spawn.mock.calls[0][1].find((arg: string) => arg.startsWith('--unit='))!.slice('--unit='.length);
    expect(unit).toMatch(/^aiwg-conductor-\d+-\d+$/);
    expect(spawn.mock.calls[1][1]).toEqual(['--user', 'stop', unit]);
    expect(process.listenerCount('SIGTERM')).toBe(listenersBefore); // handlers removed in finally
  });
  it('refuses bad runtime caps and unit names; stop is best effort', () => {
    for (const value of ['0', '-1', '1.5', 'x', '']) {
      expect(() => parseConductorArgs(['--run-conductor', '--conductor-root', '/srv/c', '--deliverable', '/srv/c/d', '--max-runtime-seconds', value, '--', '/bin/sh'])).toThrow(/positive integer/);
    }
    expect(parseConductorArgs(['--run-conductor', '--conductor-root', '/srv/c', '--deliverable', '/srv/c/d', '--max-runtime-seconds', '900', '--', '/bin/sh']).maxRuntimeSeconds).toBe(900);
    expect(() => buildConductorArgs({ ...options, unitName: 'other-unit' })).toThrow(/Invalid conductor unit name/);
    expect(stopConductorUnit('aiwg-conductor-x', { spawn: vi.fn(() => ({ status: 5 })) as any })).toBe(false);
    expect(stopConductorUnit('aiwg-conductor-x', { spawn: vi.fn(() => ({ status: 0 })) as any })).toBe(true);
  });
  it('parses repeated grants and rejects bus bindings, environment assignments and degraded flags', () => {
    expect(parseConductorArgs(['--run-conductor', '--conductor-root', '/srv/conductor', '--deliverable', '/srv/conductor/deliver', '--bind', '/home/test/.codex', '--setenv', 'API_KEY', '--', '/bin/sh'])).toMatchObject({ ...options, command: ['/bin/sh'] });
    for (const extra of [['--setenv', 'KEY=value'], ['--bind', '/run'], ['--bind', '/'], ['--setenv', 'DBUS_SESSION_BUS_ADDRESS'], ['--allow-degraded']]) {
      expect(() => parseConductorArgs(['--run-conductor', '--conductor-root', '/srv/c', '--deliverable', '/srv/c/d', ...extra, '--', '/bin/sh'])).toThrow();
    }
  });
});

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runConductorCli } from '../../../tools/ralph-external/lib/conductor-isolation.mjs';
it('validates real grants and existing deliverables before dispatch without launching a real unit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-conductor-args-'));
  const deliver = path.join(root, 'deliver'); mkdirSync(deliver);
  const base = ['--run-conductor', '--conductor-root', root, '--deliverable', deliver];
  const run = vi.fn(() => 7), stderr = vi.fn();
  try {
    expect(await runConductorCli([...base, '--', '/bin/sh'], { run, stderr })).toBe(7);
    expect(run).toHaveBeenCalledOnce();
    for (const args of [[], [...base, '--bad'], [...base, '--conductor-root', root, '--', 'true'], [...base, '--setenv', 'NODE_OPTIONS', '--', 'true'], [...base, '--bind', '/srv/a b', '--', 'true']]) {
      expect(await runConductorCli(args, { run, stderr })).toBe(1);
    }
    symlinkSync(deliver, path.join(root, 'link'));
    expect(await runConductorCli(['--run-conductor', '--conductor-root', root, '--deliverable', path.join(root, 'link'), '--', 'true'], { run, stderr })).toBe(1);
    expect(await runConductorCli(['--run-conductor', '--conductor-root', deliver, '--deliverable', root, '--', 'true'], { run, stderr })).toBe(1);
    expect(await runConductorCli(['--run-conductor', '--conductor-root', path.join(root, 'link'), '--deliverable', deliver, '--', 'true'], { run, stderr })).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('reports unit errors and signal exits without accepting degradation', () => {
  expect(runConductor(options, { probe: () => enforced, spawn: () => ({ status: null }), resolveRun: () => '/fake' })).toBe(1);
  expect(() => runConductor(options, { probe: () => enforced, spawn: () => ({ error: Error('spawn failed') }), resolveRun: () => '/fake' })).toThrow('spawn failed');
  expect(() => buildConductorArgs({ ...options, deliverables: [] })).toThrow('Usage');
  expect(() => buildConductorArgs({ ...options, binds: ['/srv/conductor/deliver/sub'] })).toThrow('Writable grants');
  expect(() => runConductor(options, { probe: () => ({ mode: 'degraded' }) })).toThrow('ISOLATION_UNAVAILABLE');
});

it('T-OG-04 adds read-only binds without a writable grant and refuses writable descendants', () => {
  const parsed = parseConductorArgs(['--run-conductor', '--conductor-root', '/srv/conductor',
    '--deliverable', '/srv/conductor/deliver', '--bind-ro', '/home/test/.local', '--', '/bin/sh']);
  expect(parsed.readOnlyBinds).toEqual(['/home/test/.local']);
  const args = buildConductorArgs(parsed);
  expect(args).toContain('BindReadOnlyPaths=/home/test/.local');
  expect(args).not.toContain('BindPaths=/home/test/.local');
  expect(args).not.toContain('ReadWritePaths=/home/test/.local');
  for (const readOnlyBinds of [['/srv/conductor'], ['/srv'], ['/run/user'], ['/srv/non canonical']]) {
    expect(() => buildConductorArgs({ ...options, readOnlyBinds })).toThrow();
  }
});

it('T-OG-04 validates canonical read-only directories before dispatch', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-conductor-ro-'));
  const control = path.join(root, 'control'), install = path.join(root, 'install');
  mkdirSync(control); mkdirSync(install); mkdirSync(path.join(control, 'deliver'));
  symlinkSync(install, path.join(root, 'link'));
  const run = vi.fn(() => 0), stderr = vi.fn();
  const base = ['--run-conductor', '--conductor-root', control, '--deliverable', path.join(control, 'deliver')];
  try {
    expect(await runConductorCli([...base, '--bind-ro', install, '--', 'true'], { run, stderr })).toBe(0);
    run.mockClear();
    for (const dir of [path.join(root, 'link'), path.join(root, 'missing')]) {
      expect(await runConductorCli([...base, '--bind-ro', dir, '--', 'true'], { run, stderr })).toBe(1);
    }
    expect(run).not.toHaveBeenCalled();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('dispatches conductor mode before interpreting flags in the conductor argv', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-conductor-dispatch-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../tools/ralph-external/index.mjs', import.meta.url)), '--run-conductor', '--conductor-root', 'relative', '--deliverable', '/absolute/deliver', '--', '/bin/sh', '--workers'], { cwd: root, env: { HOME: root, PATH: process.env.PATH }, encoding: 'utf8', timeout: 30_000 });
    expect(result.status).toBe(1); expect(result.stderr).toContain('Conductor grants require normalized absolute paths');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
