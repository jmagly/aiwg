import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, readlinkSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync as realSpawnSync, spawn as realSpawn } from 'node:child_process';
import { once } from 'node:events';
import { systemdClientFixture } from '../../fixtures/systemd-client.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSystemdClientEnv, resolveSystemdClient } from '../../../tools/ralph-external/lib/systemd-client.mjs';
import * as workerIsolation from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import {
  buildWorkerIsolationArgs,
  detectWorkerIsolation,
  launchIsolatedWorker,
  proposeWorkerUnitName,
  stopWorkerUnit,
} from '../../../tools/ralph-external/lib/worker-isolation.mjs';

const ENV = { PATH: '/usr/bin:/bin', HOME: '/home/conductor' };
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tmpWorktree() {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-worker-isolation-'));
  roots.push(root);
  return root;
}

describe('worker isolation argument construction (FR-OG-108)', () => {
  it('builds a unit launch with memory ceiling, no swap, env *names* (never values) in argv, and truncating output', () => {
    const argv = buildWorkerIsolationArgs({
      unit: 'aiwg-worker-demo-123',
      memoryMaxGb: 4,
      command: '/usr/bin/codex',
      args: ['exec', '--sandbox', 'workspace-write'],
      cwd: '/tmp/work',
      logFile: '/tmp/work/worker.log',
      env: ENV,
    });
    expect(argv).toEqual([
      'systemd-run', '--user', '--expand-environment=no',
      '--unit=aiwg-worker-demo-123',
      '--setenv=PATH',
      '--setenv=HOME',
      '-p', 'UnsetEnvironment=XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS SYSTEMD_BUS_ADDRESS',
      '-p', 'StandardInput=null',
      '-p', 'MemoryMax=4G',
      '-p', 'MemorySwapMax=0',
      '-p', 'StandardOutput=truncate:/tmp/work/worker.log',
      '-p', 'StandardError=truncate:/tmp/work/worker.log',
      '--working-directory=/tmp/work',
      '--', '/usr/bin/codex', 'exec', '--sandbox', 'workspace-write',
    ]);
    // No token carries an environment *value* — `--setenv=NAME` (bare) is
    // the only form emitted; the actual PATH/HOME values are imported by
    // systemd-run from its own invoking process environment, never written
    // into this argv (the fix for the /proc/*/cmdline secret leak).
    for (const token of argv) {
      expect(token).not.toContain(ENV.PATH);
      expect(token).not.toContain(ENV.HOME);
      expect(token).not.toMatch(/^--setenv=.+=/);
    }
  });

  it('unsets every manager-injected environment name that is not on the allowlist, for unit launches only', () => {
    const managerEnvNames = ['PATH', 'HOME', 'LANG', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK'];
    const unitArgv = buildWorkerIsolationArgs({
      unit: 'aiwg-worker-demo-9', memoryMaxGb: 1, command: '/bin/true', env: ENV, managerEnvNames,
    });
    // Connection coordinates belong only to the conductor's clients.
    expect(unitArgv).toContain('UnsetEnvironment=LANG XDG_RUNTIME_DIR SSH_AUTH_SOCK DBUS_SESSION_BUS_ADDRESS SYSTEMD_BUS_ADDRESS');
    // The same manager-env snapshot against a scope launch has no unset
    // property at all: `--scope` ignores UnsetEnvironment (verified against
    // a live systemd-run --user --scope), so emitting it there would be a
    // no-op guarantee masquerading as a real one.
    const scopeArgv = buildWorkerIsolationArgs({
      unit: 'aiwg-worker-demo-9', memoryMaxGb: 1, command: '/bin/true', env: ENV, managerEnvNames, kind: 'scope',
    });
    expect(scopeArgv.some(token => token.startsWith('UnsetEnvironment='))).toBe(false);
  });

  it('builds a scope launch without unit/collect/output bindings', () => {
    expect(buildWorkerIsolationArgs({
      unit: 'aiwg-worker-demo-123',
      memoryMaxGb: 2,
      command: '/bin/true',
      env: {},
      kind: 'scope',
    })).toEqual([
      'systemd-run', '--user', '--expand-environment=no', '--scope',
      '-p', 'StandardInput=null',
      '-p', 'MemoryMax=2G',
      '-p', 'MemorySwapMax=0',
      '--', '/bin/true',
    ]);
  });

  it('rejects unsafe unit names, ceilings, and paths', () => {
    const base = { unit: 'aiwg-worker-ok-1', memoryMaxGb: 1, command: '/bin/true', env: {} };
    expect(() => buildWorkerIsolationArgs({ ...base, unit: 'bad; rm -rf' })).toThrow(/unit-safe/);
    expect(() => buildWorkerIsolationArgs({ ...base, memoryMaxGb: 0 })).toThrow(/positive/);
    expect(() => buildWorkerIsolationArgs({ ...base, command: 'relative/true' })).toThrow(/absolute/);
    expect(() => buildWorkerIsolationArgs({ ...base, args: ['ok', 'bad\0x'] })).toThrow(/NUL-free/);
    expect(() => buildWorkerIsolationArgs({ ...base, kind: 'cgroup' })).toThrow(/kind/);
  });

  // #2892 B2: an MCP worker server must be launchable through the SAME
  // gate-then-launch pipeline as a shell worker, attached (`--wait --pipe
  // --quiet`, #2895) instead of fire-and-forget, so the conductor gets a
  // live stdio handle confined by the same resource ceiling and
  // environment allowlist.
  it('builds an attached launch: --wait --pipe --quiet, cgroup kill/exit hardening, no stdio-file bindings', () => {
    const argv = buildWorkerIsolationArgs({
      unit: 'aiwg-worker-mcp-9', memoryMaxGb: 1, command: '/usr/bin/node', args: ['server.js'],
      env: ENV, attached: true,
    });
    expect(argv).toEqual([
      'systemd-run', '--user', '--expand-environment=no',
      '--wait', '--pipe', '--quiet',
      '-p', 'KillMode=control-group', '-p', 'ExitType=cgroup', '-p', 'UMask=0077',
      '-p', 'UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT',
      '--unit=aiwg-worker-mcp-9',
      '--setenv=PATH', '--setenv=HOME',
      '-p', 'UnsetEnvironment=XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS SYSTEMD_BUS_ADDRESS',
      '-p', 'MemoryMax=1G',
      '-p', 'MemorySwapMax=0',
      '--', '/usr/bin/node', 'server.js',
    ]);
    expect(argv.join(' ')).not.toMatch(/StandardInput|StandardOutput|StandardError/);
  });

  it('rejects attached mode combined with any stdio-file redirection', () => {
    const base = { unit: 'aiwg-worker-pipe-1', memoryMaxGb: 1, command: '/bin/true', env: {}, attached: true as const };
    expect(() => buildWorkerIsolationArgs({ ...base, stdinPath: '/tmp/in' })).toThrow(/attached/);
    expect(() => buildWorkerIsolationArgs({ ...base, stdoutPath: '/tmp/out' })).toThrow(/attached/);
    expect(() => buildWorkerIsolationArgs({ ...base, logFile: '/tmp/log' })).toThrow(/attached/);
  });

  it.for(['unit', 'scope', 'attached'])('refuses loader/client controls before launching %s', mode => {
    for (const name of ['LD_PRELOAD', 'LD_FUTURE_CONTROL', 'DYLD_INSERT_LIBRARIES', 'GLIBC_TUNABLES', 'NODE_OPTIONS', 'NODE_PATH']) {
      expect(() => buildWorkerIsolationArgs({ unit: 'test', memoryMaxGb: 1, command: '/bin/true',
        kind: mode === 'scope' ? 'scope' : 'unit', attached: mode === 'attached', envNames: [name], env: { [name]: 'synthetic' } })).toThrow(/trusted transport bootstrap/);
    }
  });

  it('derives unit-safe names', () => {
    expect(proposeWorkerUnitName('review #1/x', 42)).toBe('aiwg-worker-review--1-x-42');
    expect(proposeWorkerUnitName(';;;', 7)).toBe('aiwg-worker-worker-7');
  });
});

describe('worker isolation detection', () => {
  beforeEach(() => { const fixture = systemdClientFixture(); roots.push(fixture.root); vi.stubEnv('PATH', fixture.root); });
  const okSpawn = (binary: string) => {
    if (path.basename(binary) === 'systemd-run') return { status: 0, stdout: 'systemd 255\n', error: null };
    return { status: 0, stdout: '255\n', error: null };
  };

  it.skipIf(process.platform !== 'linux')('reports systemd-unit when the user manager is reachable', () => {
    expect(detectWorkerIsolation({ spawn: okSpawn }).mode).toBe('systemd-unit');
  });

  it.skipIf(process.platform !== 'linux')('uses absolute clients and conductor-only discovery/control environments', () => {
    vi.stubEnv('XDG_RUNTIME_DIR', '/conductor/runtime'); vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/conductor/bus');
    vi.stubEnv('SYSTEMD_BUS_ADDRESS', 'unix:path=/conductor/systemd-bus'); vi.stubEnv('NODE_OPTIONS', '--require=/synthetic/bootstrap');
    vi.stubEnv('AIWG_UNLISTED_SECRET', 'conductor-secret');
    const calls: string[] = [];
    const spawn = ((binary: string, args: string[], options: any) => {
      expect(binary).toBe(resolveSystemdClient(args.includes('--version') ? 'systemd-run' : 'systemctl'));
      expect(options.env).toMatchObject({ XDG_RUNTIME_DIR: '/conductor/runtime', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/conductor/bus', SYSTEMD_BUS_ADDRESS: 'unix:path=/conductor/systemd-bus' });
      expect(options.env).not.toHaveProperty('NODE_OPTIONS'); expect(options.env).not.toHaveProperty('AIWG_UNLISTED_SECRET');
      calls.push(args.join(' '));
      return { status: 0, stdout: args.includes('ControlGroup') ? '/synthetic/group\n' : args.includes('ActiveState') ? 'ActiveState=active\nResult=success\nExecMainStatus=0\nMemoryMax=1024\n' : 'Version=259\n' };
    }) as never;
    expect(detectWorkerIsolation({ spawn }).mode).toBe('systemd-unit');
    workerIsolation.resolveManagerEnvNames({ spawn });
    workerIsolation.getWorkerIsolationStatus('test', { spawn });
    expect(workerIsolation.readUnitControlGroup('test', { spawn })).toBe('/synthetic/group');
    expect(stopWorkerUnit('test', { spawn }).ok).toBe(true);
    expect(calls).toHaveLength(6);
  });

  it.skipIf(process.platform !== 'linux')('reports degraded without a systemd-run binary', () => {
    const missing = detectWorkerIsolation({ spawn: () => { throw new Error('spawn ENOENT'); } });
    expect(missing.mode).toBe('degraded');
    expect(missing.reason).toContain('systemd-run is unavailable');
  });

  it.skipIf(process.platform !== 'linux')('reports degraded when the user manager is unreachable', () => {
    const noManager = detectWorkerIsolation({
      spawn: (binary: string) => (path.basename(binary) === 'systemd-run'
        ? { status: 0, stdout: 'systemd 255\n', error: null }
        : { status: 1, stdout: '', error: null }),
    });
    expect(noManager.mode).toBe('degraded');
    expect(noManager.reason).toContain('user manager is unreachable');
  });

  it('reports degraded off Linux', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const result = detectWorkerIsolation({ spawn: okSpawn });
      expect(result.mode).toBe('degraded');
      expect(result.reason).toContain('darwin');
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('launchIsolatedWorker gate-then-launch', () => {
  let trustedBinary: string;
  beforeEach(() => {
    const fixture = systemdClientFixture();
    roots.push(fixture.root);
    trustedBinary = fixture.binary;
    vi.stubEnv('PATH', fixture.root);
  });
  const passingGate = { enabled: true, ok: true, failures: [] };
  // Synthetic user-manager environment: these tests must not depend on the
  // host having a systemd user manager (CI containers have none).
  const managerSpawn = (() => ({ status: 0, stdout: 'LANG=C.UTF-8\nNODE_OPTIONS=--synthetic\nLD_PRELOAD=/synthetic.so\n', stderr: '' })) as never;

  it.skipIf(process.platform === 'win32').for(['unit', 'scope', 'missing-path'])('uses the conductor executable with real spawn resolution for %s', (kind, ctx) => {
    const callerRoot = tmpWorktree();
    const callerBinary = path.join(callerRoot, 'systemd-run');
    writeFileSync(callerBinary, `#!/bin/sh\nprintf 'CALLER_EXECUTABLE_RAN\\n'\n`, { mode: 0o700 });
    const callerPath = kind === 'missing-path' ? path.join(callerRoot, 'missing') : callerRoot;
    let clientResult: ReturnType<typeof realSpawnSync>;
    const outcome = launchIsolatedWorker({ command: '/bin/true', memoryMaxGb: 1, gate: passingGate,
      isolation: { mode: 'systemd-unit', reason: 'fixture' }, kind: kind === 'scope' ? 'scope' : 'unit',
      env: { PATH: callerPath, AIWG_ISOLATION_TOKEN: 'caller-token' }, envNames: ['PATH', 'AIWG_ISOLATION_TOKEN'],
      spawn: ((binary: string, args: string[], options: any) => {
        if (path.basename(binary) === 'systemctl') return { status: 0, stdout: '', stderr: '', error: null };
        clientResult = realSpawnSync(binary, args, options);
        return clientResult;
      }) as never,
    });
    if (clientResult!.error?.code === 'EPERM') { ctx.skip('sandbox denies real executable spawn'); return; }
    expect(clientResult!.error).toBeUndefined();
    expect(outcome.launched).toBe(true);
    const output = JSON.parse(String(clientResult!.stdout));
    expect(output).toMatchObject({ source: 'conductor', env: { PATH: callerPath, AIWG_ISOLATION_TOKEN: 'caller-token' } });
    expect(output.args).toContain('--setenv=PATH');
    expect(output.args.join(' ')).not.toContain('caller-token');
  });

  it.skipIf(process.platform === 'win32')('uses the conductor executable for a real asynchronous attached launch', async ctx => {
    const preflight = realSpawnSync(trustedBinary, [], { encoding: 'utf8' });
    if (preflight.error?.code === 'EPERM') { ctx.skip('sandbox denies real executable spawn'); return; }
    expect(preflight.error).toBeUndefined();
    const callerRoot = tmpWorktree();
    writeFileSync(path.join(callerRoot, 'systemd-run'), `#!/bin/sh\nprintf 'CALLER_EXECUTABLE_RAN\\n'\n`, { mode: 0o700 });
    const outcome = launchIsolatedWorker({ command: '/bin/true', memoryMaxGb: 1, gate: passingGate, attached: true,
      isolation: { mode: 'systemd-unit', reason: 'fixture' },
      env: { PATH: callerRoot, AIWG_ISOLATION_TOKEN: 'caller-token' }, envNames: ['PATH', 'AIWG_ISOLATION_TOKEN'],
      spawn: managerSpawn, spawnAsync: realSpawn,
    });
    expect(outcome.launched).toBe(true);
    let stdout = '';
    outcome.child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    expect(await once(outcome.child, 'close')).toEqual([0, null]);
    expect(JSON.parse(stdout)).toMatchObject({ source: 'conductor', env: { PATH: callerRoot, AIWG_ISOLATION_TOKEN: 'caller-token' } });
  });

  it('refuses launch when no trusted executable exists, even if the caller PATH has one', () => {
    const callerPath = path.dirname(trustedBinary);
    vi.stubEnv('PATH', tmpWorktree());
    const asyncSpawn = vi.fn();
    const outcome = launchIsolatedWorker({ command: '/bin/true', memoryMaxGb: 1, gate: passingGate, attached: true,
      isolation: { mode: 'systemd-unit', reason: 'fixture' }, env: { PATH: callerPath },
      spawn: managerSpawn, spawnAsync: asyncSpawn,
    });
    expect(outcome.launched).toBe(false);
    expect(outcome.diagnostic).toContain("systemctl is unavailable on the conductor's absolute PATH");
    expect(asyncSpawn).not.toHaveBeenCalled();
  });

  it('attaches separate pipes and passes only environment names in systemd argv', () => {
    let binary: string | undefined;
    let argv: string[] = [];
    let options: any;
    const child = { pid: 4242, once: () => {} };
    const outcome = launchIsolatedWorker({ command: '/qualified/worker', args: ['literal $HOME'], memoryMaxGb: 2,
      gate: passingGate, attached: true, ownedGroup: true, stdin: 'brief-text',
      isolation: { mode: 'systemd-unit', reason: 'synthetic' },
      env: { SYNTHETIC_SECRET: 'never-in-argv' }, envNames: ['SYNTHETIC_SECRET'], spawn: managerSpawn,
      spawnAsync: ((command: string, args: string[], opts: any) => { binary = command; argv = args; options = opts; return child; }) as never,
    });
    expect(outcome).toMatchObject({ mode: 'systemd-unit', child, launched: true });
    expect(binary).toBe(trustedBinary);
    expect(argv).toContain('--wait');
    expect(argv).toContain('--pipe');
    expect(argv).toContain('KillMode=control-group');
    expect(argv).toContain('ExitType=cgroup');
    expect(argv.some(token => token.startsWith('UnsetEnvironment=') && token.includes('NODE_OPTIONS') && token.includes('LD_PRELOAD'))).toBe(true);
    expect(argv).toContain('--setenv=SYNTHETIC_SECRET');
    expect(argv.join(' ')).not.toContain('never-in-argv');
    expect(argv).toContain('--worker-environment');
    expect(argv.slice(-2)).toEqual(['/qualified/worker', 'literal $HOME']);
    expect(options.env.SYNTHETIC_SECRET).toBe('never-in-argv');
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(options.detached).toBe(true);
  });

  it.each(['NODE_OPTIONS', 'LD_PRELOAD'])('refuses %s before trusted transport bootstrap', name => {
    const spawnAsync = vi.fn();
    for (const mode of ['systemd-unit', 'degraded']) {
      expect(() => launchIsolatedWorker({ command: '/qualified/worker', memoryMaxGb: 2, gate: passingGate,
        attached: true, runDir: '/private/run', allowDegraded: true,
        isolation: { mode, reason: 'synthetic' }, env: { [name]: 'synthetic-unsafe-bootstrap' }, envNames: [name],
        spawn: managerSpawn, spawnAsync })).toThrow(/transport bootstrap/);
    }
    expect(spawnAsync).not.toHaveBeenCalled();
  });

  it('never spawns when the resource gate blocks', () => {
    let calls = 0;
    const outcome = launchIsolatedWorker({
      name: 'blocked', memoryMaxGb: 1, command: '/bin/true',
      gate: { enabled: true, ok: false, failures: [{ signal: 'mem-psi-avg60', reason: 'hot' }] },
      spawn: (() => { calls += 1; throw new Error('must not spawn'); }) as never,
    });
    expect(outcome).toMatchObject({ launched: false, blocked: true });
    expect(calls).toBe(0);
  });

  it('a blocked gate prevents the spawn even in attached mode (#2892 B2)', () => {
    let syncCalls = 0;
    let asyncCalls = 0;
    const outcome = launchIsolatedWorker({
      name: 'blocked-mcp', memoryMaxGb: 1, command: '/usr/bin/node', attached: true,
      gate: { enabled: true, ok: false, failures: [{ signal: 'mem-psi-avg60', reason: 'hot' }] },
      spawn: (() => { syncCalls += 1; throw new Error('must not spawn'); }) as never,
      spawnAsync: (() => { asyncCalls += 1; throw new Error('must not spawn'); }) as never,
    });
    expect(outcome).toMatchObject({ launched: false, blocked: true });
    expect(syncCalls).toBe(0);
    expect(asyncCalls).toBe(0);
  });

  it('refuses silent unconfined launch and requires explicit degraded opt-in', () => {
    const degraded = { mode: 'degraded', reason: 'no user manager here' } as const;
    const refused = launchIsolatedWorker({
      name: 'x', memoryMaxGb: 1, command: '/bin/true', gate: passingGate, isolation: degraded,
    });
    expect(refused).toMatchObject({ launched: false, mode: 'degraded' });
    expect(refused.diagnostic).toContain('allowDegraded');

    const calls: string[][] = [];
    const allowed = launchIsolatedWorker({
      name: 'x', memoryMaxGb: 1, command: '/bin/true', args: ['--help'],
      gate: passingGate, isolation: degraded, allowDegraded: true,
      spawnAsync: ((binary: string, argv: string[]) => {
        calls.push([binary, ...argv]);
        return { pid: 4242, once: () => {} };
      }) as never,
    });
    expect(allowed).toMatchObject({ launched: true, mode: 'degraded' });
    expect(allowed.diagnostic).toContain('without resource confinement');
    expect(calls).toEqual([['/bin/true', '--help']]);
  });

  it('launches through systemd-run and reads back the MainPID', () => {
    const calls: string[][] = [];
    const outcome = launchIsolatedWorker({
      name: 'demo', memoryMaxGb: 4, command: '/usr/bin/codex', args: ['exec'],
      cwd: '/tmp/work', logFile: '/tmp/work/worker.log',
      gate: passingGate,
      isolation: { mode: 'systemd-unit', reason: 'fake' },
      proposeUnit: () => 'aiwg-worker-demo-9',
      spawn: ((binary: string, argv: string[]) => {
        calls.push([binary, ...argv]);
        if (path.basename(binary) === 'systemctl' && argv.includes('show-environment')) return { status: 0, stdout: 'PATH=/x\nLANG=en_US.UTF-8\n', stderr: '', error: null };
        if (path.basename(binary) === 'systemctl') return { status: 0, stdout: '4242\n', stderr: '', error: null };
        return { status: 0, stdout: '', stderr: '', error: null };
      }) as never,
    });
    expect(outcome).toMatchObject({ launched: true, mode: 'systemd-unit', unit: 'aiwg-worker-demo-9', pid: 4242 });
    const launchCall = calls.find(call => call[0] === trustedBinary)!;
    expect(launchCall.slice(0, 4)).toEqual([trustedBinary, '--user', '--expand-environment=no', '--unit=aiwg-worker-demo-9']);
    expect(launchCall).toContain('MemoryMax=4G');
    expect(launchCall).toContain('MemorySwapMax=0');
    // LANG was reported by the simulated manager environment and is not
    // allowlisted: it must be explicitly unset, not silently inherited.
    expect(launchCall.join(' ')).toContain('UnsetEnvironment=LANG');
  });

  it.each(['unit', 'scope', 'attached'])('imports caller values into the %s client without unrelated secrets or values in argv', kind => {
    const cwd = tmpWorktree();
    vi.stubEnv('AIWG_ISOLATION_TOKEN', 'conductor-token');
    vi.stubEnv('AIWG_OMITTED_TOKEN', 'conductor-only-token');
    vi.stubEnv('AIWG_UNLISTED_SECRET', 'conductor-secret');
    vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/synthetic');
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/synthetic/conductor-bus');
    vi.stubEnv('SYSTEMD_BUS_ADDRESS', 'unix:path=/synthetic/conductor-systemd-bus');
    vi.stubEnv('NODE_OPTIONS', '--require=/synthetic/bootstrap');
    let clientEnv: NodeJS.ProcessEnv | undefined;
    let launchArgs: string[] = [];
    const outcome = launchIsolatedWorker({
      command: '/bin/true', cwd, memoryMaxGb: 1, gate: passingGate,
      kind: kind === 'scope' ? 'scope' : 'unit', attached: kind === 'attached',
      isolation: { mode: 'systemd-unit', reason: 'fake' },
      envNames: ['PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMD_BUS_ADDRESS', 'AIWG_ISOLATION_TOKEN', 'AIWG_CALLER_ONLY', 'AIWG_OMITTED_TOKEN'],
      env: { PATH: '/synthetic/bin', XDG_RUNTIME_DIR: '/run/user/caller',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/synthetic/caller-bus', SYSTEMD_BUS_ADDRESS: 'unix:path=/synthetic/caller-systemd-bus',
        AIWG_ISOLATION_TOKEN: 'caller-token', AIWG_CALLER_ONLY: 'caller-only-token', AIWG_UNLISTED_SECRET: 'caller-secret' },
      spawn: ((binary: string, argv: string[], options: any) => {
        if (binary === trustedBinary) { clientEnv = options.env; launchArgs = argv; }
        else expect(options.env ?? process.env).toMatchObject({ XDG_RUNTIME_DIR: '/run/user/synthetic',
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/synthetic/conductor-bus', SYSTEMD_BUS_ADDRESS: 'unix:path=/synthetic/conductor-systemd-bus' });
        return { status: 0, stdout: argv.includes('show-environment')
          ? 'CONDUCTOR_MANAGER_ONLY=synthetic\n' : '', stderr: '', error: null };
      }) as never,
      spawnAsync: ((binary: string, argv: string[], options: any) => {
        expect(binary).toBe(trustedBinary); clientEnv = options.env; launchArgs = argv;
        return { pid: 4242, once: () => {} };
      }) as never,
    });
    expect(outcome.launched).toBe(true);
    expect(clientEnv).toMatchObject({ PATH: '/synthetic/bin', XDG_RUNTIME_DIR: '/run/user/synthetic',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/synthetic/conductor-bus',
      SYSTEMD_BUS_ADDRESS: 'unix:path=/synthetic/conductor-systemd-bus',
      AIWG_ISOLATION_TOKEN: 'caller-token', AIWG_CALLER_ONLY: 'caller-only-token' });
    for (const name of ['AIWG_UNLISTED_SECRET', 'AIWG_OMITTED_TOKEN', 'NODE_OPTIONS']) {
      expect(clientEnv).not.toHaveProperty(name);
      expect(launchArgs).not.toContain(`--setenv=${name}`);
    }
    for (const name of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMD_BUS_ADDRESS']) expect(launchArgs).not.toContain(`--setenv=${name}`);
    if (kind === 'scope' || kind === 'attached') {
      const names = JSON.parse(launchArgs[launchArgs.indexOf('--worker-environment') + 1]);
      for (const name of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMD_BUS_ADDRESS']) expect(names).not.toContain(name);
    }
    expect(launchArgs).toContain('--setenv=AIWG_ISOLATION_TOKEN');
    expect(launchArgs).toContain('--setenv=AIWG_CALLER_ONLY');
    if (kind !== 'scope') expect(launchArgs).toContain('UnsetEnvironment=CONDUCTOR_MANAGER_ONLY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS SYSTEMD_BUS_ADDRESS');
    expect(launchArgs.join(' ')).not.toMatch(/caller-token|caller-only-token|conductor-token|caller-secret/);
  });

  it('refuses to launch when the manager environment cannot be determined, rather than guessing at isolation', () => {
    const outcome = launchIsolatedWorker({
      name: 'demo', memoryMaxGb: 4, command: '/usr/bin/codex',
      gate: passingGate,
      isolation: { mode: 'systemd-unit', reason: 'fake' },
      spawn: (() => ({ status: 1, stdout: '', stderr: 'manager unreachable', error: null })) as never,
    });
    expect(outcome).toMatchObject({ launched: false, mode: 'systemd-unit' });
    expect(outcome.diagnostic).toContain("unable to determine the user manager's inherited environment");
  });

  it('reports systemd-run failures without claiming a launch', () => {
    const outcome = launchIsolatedWorker({
      name: 'demo', memoryMaxGb: 4, command: '/usr/bin/codex',
      gate: passingGate,
      isolation: { mode: 'systemd-unit', reason: 'fake' },
      spawn: ((binary: string, argv: string[]) => {
        if (path.basename(binary) === 'systemctl' && argv.includes('show-environment')) return { status: 0, stdout: '', stderr: '', error: null };
        return { status: 1, stdout: '', stderr: 'Failed to connect', error: null };
      }) as never,
    });
    expect(outcome).toMatchObject({ launched: false, mode: 'systemd-unit' });
    expect(outcome.diagnostic).toContain('systemd-run launch failed');
  });

  // #2892 B2: MCP worker servers go through this SAME gate-then-launch
  // pipeline, attached (`attached: true`), instead of the direct
  // `new StdioClientTransport({ command, args, env })` spawn the #2892
  // bridge used to perform (bypassing the gate AND the environment
  // allowlist — the SDK always merges its own `getDefaultEnvironment()`).
  it('rejects attached mode combined with any stdio-file option (confined path)', () => {
    expect(() => launchIsolatedWorker({
      command: '/bin/true', memoryMaxGb: 1, gate: passingGate, attached: true, stdinPath: '/tmp/in',
      isolation: { mode: 'systemd-unit', reason: 'fake' },
      spawn: (() => ({ status: 0, stdout: '', stderr: '', error: null })) as never,
    })).toThrow(/attached/);
  });

  // CI fix for #2892/#2954: the MCP worker-invoke bridge always launches
  // `attached: true` (its worker is a live stdio MCP server, never a
  // fire-and-forget shell command). On a host with no reachable systemd
  // user manager (e.g. a root CI container) AND no server-side
  // `allowDegraded` opt-in, the attached path must refuse exactly like the
  // non-attached path above — never silently fall through to an unconfined
  // launch just because stdio happens to be piped rather than redirected
  // to files.
  it('attached launch without allowDegraded refuses when no systemd user manager is reachable (#2892 CI fix: fail-closed contract)', () => {
    const refused = launchIsolatedWorker({
      name: 'mcp-worker', memoryMaxGb: 1, command: '/bin/true', gate: passingGate, attached: true, stdin: 'open',
      isolation: { mode: 'degraded', reason: 'no user manager here' },
    });
    expect(refused).toMatchObject({ launched: false, mode: 'degraded' });
    expect(refused.diagnostic).toContain('allowDegraded');
    expect(refused.child).toBeUndefined();
  });

  it("attached degraded launch pipes stdin when stdin is not 'closed'", () => {
    let options: any;
    const outcome = launchIsolatedWorker({
      command: '/bin/true', gate: passingGate, attached: true, allowDegraded: true, stdin: 'open',
      isolation: { mode: 'degraded', reason: 'fake' },
      spawnAsync: ((_binary: string, _args: string[], opts: any) => { options = opts; return { pid: 99, once: () => {} }; }) as never,
    });
    expect(outcome).toMatchObject({ launched: true, mode: 'degraded' });
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it("attached degraded launch defaults stdin to 'closed' (ignore) unless the caller opts in", () => {
    let options: any;
    launchIsolatedWorker({
      command: '/bin/true', gate: passingGate, attached: true, allowDegraded: true,
      isolation: { mode: 'degraded', reason: 'fake' },
      spawnAsync: ((_binary: string, _args: string[], opts: any) => { options = opts; return { pid: 1, once: () => {} }; }) as never,
    });
    expect(options.stdio[0]).toBe('ignore');
  });

  // #2892 F6: without a `runDir` (the MCP bridge's own `attached` launch
  // never supplies one — it has no need for the wrapper's identity/exit
  // record files, only a live stdio pipe), an attached DEGRADED launch used
  // to spawn the real worker command DIRECTLY, bypassing both the private
  // transport wrapper AND its transport-bootstrap-variable refusal. Fixed:
  // the wrapper routing and the refusal both apply to every attached
  // launch, with or without `runDir`.
  it('attached degraded launch with NO runDir still routes through the private transport wrapper, never the worker directly (#2892 F6)', () => {
    let binary: string | undefined;
    let argv: string[] = [];
    const outcome = launchIsolatedWorker({
      command: '/qualified/worker', args: ['--flag'], gate: passingGate, attached: true, allowDegraded: true,
      isolation: { mode: 'degraded', reason: 'fake' },
      env: {}, envNames: [],
      spawnAsync: ((cmd: string, args: string[]) => { binary = cmd; argv = args; return { pid: 123, once: () => {} }; }) as never,
    });
    expect(outcome).toMatchObject({ launched: true, mode: 'degraded', transportSupervisor: true });
    // The wrapper (this module, invoked with --worker-environment), never
    // the real worker binary directly — the real command/args appear only
    // after the wrapper's own `--` separator.
    expect(binary).toBe(process.execPath);
    expect(argv).toContain('--worker-environment');
    expect(argv).not.toContain('--run-dir');
    expect(argv.slice(-2)).toEqual(['/qualified/worker', '--flag']);
  });

  it.each(['NODE_OPTIONS', 'LD_PRELOAD'])('refuses %s on an attached DEGRADED launch even with NO runDir (#2892 F6)', name => {
    const spawnAsync = vi.fn();
    expect(() => launchIsolatedWorker({
      command: '/qualified/worker', gate: passingGate, attached: true, allowDegraded: true,
      isolation: { mode: 'degraded', reason: 'fake' }, env: { [name]: 'synthetic-unsafe-bootstrap' }, envNames: [name],
      spawnAsync,
    })).toThrow(/transport bootstrap/);
    expect(spawnAsync).not.toHaveBeenCalled();
  });

  it("attached degraded launch (no runDir) env is exactly the allowlist — never the conductor's own process.env (#2892 F6)", () => {
    let options: any;
    const previous = process.env.AIWG_FIXTURE_SECRET;
    process.env.AIWG_FIXTURE_SECRET = 'never-forwarded';
    try {
      launchIsolatedWorker({
        command: '/bin/true', gate: passingGate, attached: true, allowDegraded: true,
        isolation: { mode: 'degraded', reason: 'fake' },
        env: { AIWG_FAKE_WORKER_CONFIG: 'fixture-config' }, envNames: ['AIWG_FAKE_WORKER_CONFIG'],
        spawnAsync: ((_binary: string, _args: string[], opts: any) => { options = opts; return { pid: 1, once: () => {} }; }) as never,
      });
    } finally {
      if (previous === undefined) delete process.env.AIWG_FIXTURE_SECRET; else process.env.AIWG_FIXTURE_SECRET = previous;
    }
    expect(options.env).toEqual({ AIWG_FAKE_WORKER_CONFIG: 'fixture-config' });
  });

  it('attached confined launch spawns systemd-run asynchronously through the private transport wrapper, never spawnSync', () => {
    const syncCalls: string[][] = [];
    let asyncArgv: string[] | undefined;
    let asyncOptions: any;
    const outcome = launchIsolatedWorker({
      name: 'mcp-demo', memoryMaxGb: 1, command: '/usr/bin/node', args: ['server.js'],
      env: {}, gate: passingGate,
      isolation: { mode: 'systemd-unit', reason: 'fake' },
      attached: true,
      proposeUnit: () => 'aiwg-worker-mcp-demo-9',
      spawn: ((binary: string, argv: string[]) => {
        syncCalls.push([binary, ...argv]);
        if (path.basename(binary) === 'systemctl' && argv.includes('show-environment')) return { status: 0, stdout: '', stderr: '', error: null };
        throw new Error('attached mode must never call the synchronous spawn for the launch itself');
      }) as never,
      spawnAsync: ((binary: string, argv: string[], opts: any) => {
        asyncArgv = [binary, ...argv];
        asyncOptions = opts;
        return { pid: 777, once: () => {} };
      }) as never,
    });
    expect(outcome).toMatchObject({ launched: true, mode: 'systemd-unit', unit: 'aiwg-worker-mcp-demo-9' });
    expect(asyncArgv![0]).toBe(trustedBinary);
    expect(asyncArgv).toEqual(expect.arrayContaining(['--wait', '--pipe', '--quiet',
      '-p', 'KillMode=control-group', '-p', 'ExitType=cgroup', '-p', 'UMask=0077',
      '--unit=aiwg-worker-mcp-demo-9', '-p', 'MemoryMax=1G']));
    // The private host-owned transport wrapper (this very module, invoked
    // with --worker-environment) is the actual command run inside the
    // unit — never the real worker binary/args directly in argv, which
    // instead appear after the wrapper's OWN `--` separator.
    expect(asyncArgv).toEqual(expect.arrayContaining(['--worker-environment', '--', '/usr/bin/node', 'server.js']));
    expect(asyncOptions.stdio).toEqual(['ignore', 'pipe', 'pipe']); // stdin defaults to 'closed' here (not overridden)
    // Only the manager-environment query used the synchronous spawn; the
    // launch itself never did.
    expect(syncCalls.every(call => path.basename(call[0]) === 'systemctl')).toBe(true);
  });
});

describe('stopWorkerUnit (#2892 M2)', () => {
  beforeEach(() => { const fixture = systemdClientFixture(); roots.push(fixture.root); vi.stubEnv('PATH', fixture.root); });
  it('requests systemctl --user stop and reports success', () => {
    const calls: string[][] = [];
    const result = stopWorkerUnit('aiwg-worker-demo-9', {
      spawn: ((binary: string, argv: string[]) => { calls.push([binary, ...argv]); return { status: 0, stdout: '', stderr: '', error: null }; }) as never,
    });
    expect(calls).toEqual([[resolveSystemdClient('systemctl'), '--user', 'stop', 'aiwg-worker-demo-9']]);
    expect(result).toMatchObject({ ok: true });
  });

  it('reports failure without throwing when the unit is already gone', () => {
    const result = stopWorkerUnit('aiwg-worker-demo-9', {
      spawn: (() => ({ status: 1, stdout: '', stderr: 'Unit not loaded.', error: null })) as never,
    });
    expect(result).toMatchObject({ ok: false, diagnostic: 'Unit not loaded.' });
  });

  it('rejects an unsafe unit name', () => {
    expect(() => stopWorkerUnit('bad; rm -rf')).toThrow(/unit-safe/);
  });
});


it('preserves literal environment references in prepared argv', () => {
  const args = ['$HOME', '${HOME}', '/home/roctinam', 'literal $PATH'];
  const argv = buildWorkerIsolationArgs({ unit: 'aiwg-worker-literal', memoryMaxGb: 1, command: '/bin/echo', args, env: ENV });
  expect(argv).toContain('--expand-environment=no');
  expect(argv.slice(-args.length)).toEqual(args);
  expect(argv).not.toContain('--collect');
});

describe('degraded-mode output/fd hygiene (#2888 fix round 2)', () => {
  it('truncates a pre-existing output file instead of appending to it', async () => {
    const root = tmpWorktree();
    const stdoutPath = path.join(root, 'worker.stdout');
    writeFileSync(stdoutPath, 'STALE CONTENT FROM A PRIOR LAUNCH THAT MUST NOT SURVIVE\n');
    const outcome = launchIsolatedWorker({
      command: process.execPath, args: ['-e', 'process.stdout.write("fresh\\n")'],
      gate: { enabled: true, ok: true, failures: [] },
      isolation: { mode: 'degraded', reason: 'truncation test' }, allowDegraded: true,
      stdoutPath,
    }) as { launched: boolean; child: { once: (event: string, cb: () => void) => void } };
    expect(outcome.launched).toBe(true);
    await new Promise<void>(resolve => outcome.child.once('exit', resolve));
    const content = readFileSync(stdoutPath, 'utf8');
    expect(content).toBe('fresh\n');
    expect(content).not.toContain('STALE CONTENT');
  });

  it('does not leak file descriptors across repeated degraded launches', async () => {
    if (process.platform !== 'linux') return;
    const root = tmpWorktree();
    // Count only descriptors pointing at this test's own output files, so
    // concurrent suites sharing the process cannot perturb the measurement.
    const countFds = () => readdirSync('/proc/self/fd').filter(fd => {
      try { return readlinkSync(`/proc/self/fd/${fd}`).startsWith(root); } catch { return false; }
    }).length;
    const launchOnce = async (label: string) => {
      const stdoutPath = path.join(root, `out-${label}.log`);
      const stderrPath = path.join(root, `err-${label}.log`);
      const outcome = launchIsolatedWorker({
        command: process.execPath, args: ['-e', 'process.exit(0)'],
        gate: { enabled: true, ok: true, failures: [] },
        isolation: { mode: 'degraded', reason: 'fd-leak test' }, allowDegraded: true,
        stdoutPath, stderrPath,
      }) as { launched: boolean; child: { once: (event: string, cb: () => void) => void } };
      expect(outcome.launched).toBe(true);
      await new Promise<void>(resolve => outcome.child.once('exit', resolve));
    };
    // Warm up: let any one-time lazy fd allocation (libuv thread pool, etc.,
    // which the rest of the shared vitest process may also be doing) settle
    // before measuring, so the assertion below isolates THIS function's
    // behavior rather than ambient process activity.
    for (let i = 0; i < 3; i++) await launchOnce(`warmup-${i}`);
    const before = countFds();
    const iterations = 20;
    for (let i = 0; i < iterations; i++) await launchOnce(`measured-${i}`);
    const after = countFds();
    // Before the fix: 2 fds (stdout+stderr) per launch stayed open on these
    // output files, so 20 launches would leave ~40 open. After the fix the
    // parent's copies are closed immediately post-spawn.
    expect(after - before).toBe(0);
  });
});

it('returns an async child handle without any worker deadline in degraded mode', () => {
  const child = { pid: 1234, once: () => {} };
  let options: any;
  const outcome = launchIsolatedWorker({
    command: '/bin/true', gate: { enabled: true, ok: true }, allowDegraded: true,
    isolation: { mode: 'degraded', reason: 'fake' },
    spawn: (() => { throw new Error('blocking spawn forbidden'); }) as never,
    spawnAsync: ((_binary: string, _args: string[], opts: any) => { options = opts; return child; }) as never,
  });
  expect(outcome).toMatchObject({ launched: true, pid: 1234, child });
  expect(options.timeout).toBeUndefined();
  expect(options.stdio[0]).toBe('ignore');
});

it('refuses missing gates and disabled gates when dispatch is on', () => {
  for (const gate of [undefined, 'disabled', {}, { ok: true }, { config: {} }, { enabled: false, ok: true }]) {
    const result = launchIsolatedWorker({ command: '/bin/true', gate, config: { parallelism: { worker_dispatch: true } },
      spawn: (() => { throw new Error('must not launch'); }) as never });
    expect(result).toMatchObject({ launched: false, blocked: true });
  }
  expect(launchIsolatedWorker({ command: '/bin/true', gate: 'disabled', config: { parallelism: { worker_dispatch: false } },
    isolation: { mode: 'degraded', reason: 'fake' }, allowDegraded: true,
    spawnAsync: (() => ({ pid: 5, once: () => {} })) as never })).toMatchObject({ launched: true, gate: { enabled: false } });
});

it('reports retained systemd OOM result, status and ceiling', () => {
  const fixture = systemdClientFixture(); roots.push(fixture.root); vi.stubEnv('PATH', fixture.root);
  const status = workerIsolation.getWorkerIsolationStatus('aiwg-worker-test', { spawn: (() => ({
    status: 0, stdout: 'ActiveState=failed\nResult=oom-kill\nExecMainStatus=9\nMemoryMax=67108864\n',
  })) as never });
  expect(status).toEqual({ active: false, result: 'oom-kill', execMainStatus: 9, memoryMax: 67108864 });
});

it('documents serialized heavy verification and checkpointing before heavy steps (NFR-OG-023)', () => {
  const doc = readFileSync(new URL('../../../docs/providers/worker-invocation-packaging.md', import.meta.url), 'utf8');
  expect(doc).toMatch(/serializ[^.]*per host/i);
  expect(doc).toMatch(/checkpoint[^.]*before[^.]*heavy/i);
  expect(doc).toContain('reset-failed');
  expect(doc).toContain('#2888');
});

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


it('fails status queries explicitly instead of manufacturing a successful outcome', () => {
  const fixture = systemdClientFixture(); roots.push(fixture.root); vi.stubEnv('PATH', fixture.root);
  expect(() => workerIsolation.getWorkerIsolationStatus('aiwg-worker-test', { spawn: (() => ({ status: 1, stderr: 'manager unavailable' })) as never })).toThrow(/unavailable/);
  expect(() => workerIsolation.getWorkerIsolationStatus('aiwg-worker-test', { spawn: (() => ({ status: 0, stdout: '' })) as never })).toThrow(/missing systemd properties/);
});
