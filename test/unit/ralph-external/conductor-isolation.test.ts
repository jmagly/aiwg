import { describe, it, expect, vi } from 'vitest';
import { buildConductorArgs, parseConductorArgs, runConductor } from '../../../tools/ralph-external/lib/conductor-isolation.mjs';

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

it('dispatches conductor mode before interpreting flags in the conductor argv', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-conductor-dispatch-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../tools/ralph-external/index.mjs', import.meta.url)), '--run-conductor', '--conductor-root', 'relative', '--deliverable', '/absolute/deliver', '--', '/bin/sh', '--workers'], { cwd: root, env: { HOME: root, PATH: process.env.PATH }, encoding: 'utf8', timeout: 30_000 });
    expect(result.status).toBe(1); expect(result.stderr).toContain('Conductor grants require normalized absolute paths');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
