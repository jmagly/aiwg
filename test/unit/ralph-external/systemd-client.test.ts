import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { systemdClientFixture } from '../../fixtures/systemd-client.js';
import { buildSystemdClientEnv, resolveSystemdClient, resolveSystemdRun, unitEnvironmentNames } from '../../../tools/ralph-external/lib/systemd-client.mjs';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('trusted systemd client', () => {
  it.skipIf(process.platform === 'win32')('skips relative/empty PATH entries, nonexecutables, and directories', () => {
    const first = systemdClientFixture(), last = systemdClientFixture();
    roots.push(first.root, last.root);
    rmSync(first.binary);
    mkdirSync(first.binary);
    vi.stubEnv('PATH', ['', '.', 'relative', first.root, last.root].join(path.delimiter));
    expect(resolveSystemdRun()).toBe(realpathSync(last.binary));
    rmSync(first.binary, { recursive: true });
    writeFileSync(first.binary, 'not executable', { mode: 0o600 });
    expect(resolveSystemdRun()).toBe(realpathSync(last.binary));
  });

  it.skipIf(process.platform === 'win32')('canonicalizes symlinks and treats writable absolute conductor directories as trusted', () => {
    const fixture = systemdClientFixture(); roots.push(fixture.root);
    const aliases = path.join(fixture.root, 'aliases'); mkdirSync(aliases, { mode: 0o777 }); chmodSync(aliases, 0o777);
    symlinkSync(fixture.binary, path.join(aliases, 'systemd-run'));
    symlinkSync(fixture.systemctl, path.join(aliases, 'systemctl'));
    vi.stubEnv('PATH', aliases);
    expect(resolveSystemdRun()).toBe(realpathSync(fixture.binary));
    expect(resolveSystemdClient('systemctl')).toBe(realpathSync(fixture.systemctl));
  });

  it.skipIf(process.platform === 'win32')('executes the fixture with a Node path containing spaces', ctx => {
    const fixture = systemdClientFixture(); roots.push(fixture.root);
    const nodeAlias = path.join(fixture.root, 'node with spaces'); symlinkSync(process.execPath, nodeAlias);
    const withSpaces = systemdClientFixture(nodeAlias); roots.push(withSpaces.root);
    const result = spawnSync(withSpaces.binary, ['argument with spaces'], { encoding: 'utf8' });
    if (result.error?.code === 'EPERM') { ctx.skip('sandbox denies real executable spawn'); return; }
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.stdout).args).toEqual(['argument with spaces']);
  });

  it('excludes all loader/runtime controls even when explicitly allowlisted', () => {
    const names = ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_DEBUG_OUTPUT', 'LD_FUTURE_CONTROL', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'GLIBC_TUNABLES'];
    const env = Object.fromEntries(names.map(name => [name, 'synthetic-bootstrap-control']));
    for (const name of names) vi.stubEnv(name, env[name]);
    const client = buildSystemdClientEnv({ env, envNames: [...names, 'SAFE_VALUE'] });
    for (const name of names) {
      expect(client).not.toHaveProperty(name);
      expect(() => unitEnvironmentNames([name])).toThrow(/trusted transport bootstrap/);
    }
  });

  it('deletes allowlisted caller PATH and HOME when undefined, keeping conductor-only connections', () => {
    vi.stubEnv('PATH', '/conductor/bin'); vi.stubEnv('HOME', '/conductor/home');
    vi.stubEnv('XDG_RUNTIME_DIR', '/conductor/runtime');
    const client = buildSystemdClientEnv({ env: { PATH: undefined, HOME: undefined, XDG_RUNTIME_DIR: undefined }, envNames: ['PATH', 'HOME', 'XDG_RUNTIME_DIR'] });
    expect(client).toEqual({ ...Object.fromEntries(['DBUS_SESSION_BUS_ADDRESS', 'SYSTEMD_BUS_ADDRESS'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])), XDG_RUNTIME_DIR: '/conductor/runtime' });
  });

  it('does not invent a manager connection when conductor connection variables are absent', () => {
    for (const name of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMD_BUS_ADDRESS']) vi.stubEnv(name, undefined);
    const env = buildSystemdClientEnv({
      env: { XDG_RUNTIME_DIR: '/run/user/caller', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/caller/bus', SYSTEMD_BUS_ADDRESS: 'unix:path=/caller/systemd-bus', TOKEN: 'caller' },
      envNames: ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMD_BUS_ADDRESS', 'TOKEN'],
    });
    expect(env.TOKEN).toBe('caller');
    for (const name of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMD_BUS_ADDRESS']) expect(env).not.toHaveProperty(name);
  });
});
