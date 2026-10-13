/**
 * Pure-logic unit tests for Tier 0 verification confinement probing
 * (#2889 B1, round 2 CRITICAL fail-closed hardening). Every test here uses
 * an injected `spawn` fake. PATH-resolution regressions additionally spawn
 * temporary executable shims and skip if the sandbox denies real spawn.
 * No test requires a live systemd user manager.
 *
 * @source @tools/ralph-external/lib/verification-isolation.mjs
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { systemdClientFixture } from '../../fixtures/systemd-client.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildVerificationExtraProperties,
  missingRequiredCapabilities,
  probeVerificationIsolationCapabilities,
  REQUIRED_VERIFICATION_CAPABILITIES,
  resetVerificationIsolationCapabilityCache,
  runConfinedCheck,
} from '../../../tools/ralph-external/lib/verification-isolation.mjs';

let clientFixture: ReturnType<typeof systemdClientFixture>;
const clientRoots: string[] = [];
beforeEach(() => {
  resetVerificationIsolationCapabilityCache();
  clientFixture = systemdClientFixture(); clientRoots.push(clientFixture.root); vi.stubEnv('PATH', clientFixture.root);
});
afterEach(() => {
  resetVerificationIsolationCapabilityCache();
  vi.unstubAllEnvs();
  for (const root of clientRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SYSTEMD_UNIT_FIELDS = {
  NONEWPRIVS: '1',
  NETNS: 'net:[probe]',
  HOMECOUNT: '0',
  TMPMARK: '/tmp/does-not-exist-marker',
  SCRATCHWRITE: '0',
  TMPWRITE: '1',
  VARTMPWRITE: '1',
  HOMEWRITE: '1',
  DONE: '1',
};

function stdoutFromFields(fields: Record<string, string>) {
  return Object.entries(fields).map(([key, value]) => `${key}:${value}`).join('\n') + '\n';
}

/** A fake spawn that answers `systemd-run --version` / `systemctl --user show` /
 * the host `readlink` baseline, then hands `probeStdout`/`probeResult` back
 * for the actual probe-unit invocation (`systemd-run --user --pipe ...`). */
function fakeSpawnFactory({
  probeStdout,
  probeStatus = 0,
  probeError = null,
  hostNetNs = 'net:[host]',
  hostNetNsFails = false,
}: {
  probeStdout?: string;
  probeStatus?: number | null;
  probeError?: { code: string; message: string } | null;
  hostNetNs?: string;
  hostNetNsFails?: boolean;
}) {
  return (cmd: string, args: string[] = []) => {
    if (path.basename(cmd) === 'systemd-run' && args[0] === '--version') return { status: 0, stdout: 'systemd 259\n', stderr: '', error: null };
    if (path.basename(cmd) === 'systemctl' && args.includes('show') && args.includes('Version')) return { status: 0, stdout: '259\n', stderr: '', error: null };
    if (cmd === 'readlink') {
      if (hostNetNsFails) return { status: 1, stdout: '', stderr: 'denied', error: null };
      return { status: 0, stdout: `${hostNetNs}\n`, stderr: '', error: null };
    }
    if (path.basename(cmd) === 'systemd-run') {
      // The actual probe-unit invocation.
      return { status: probeStatus, stdout: probeStdout ?? '', stderr: '', error: probeError };
    }
    throw new Error(`unexpected spawn in fake: ${cmd} ${args.join(' ')}`);
  };
}

/** Mock successful probes, including the scratch write checked on disk. */
function successfulProbeSpawn(launch: (args: string[], options: any) => any) {
  const baseline = fakeSpawnFactory({ probeStdout: stdoutFromFields(SYSTEMD_UNIT_FIELDS) });
  return (cmd: string, args: string[] = [], options?: any) => {
    if (path.basename(cmd) === 'systemd-run' && args.some(arg => arg.startsWith('--unit=aiwg-verify-isolation-probe-'))) {
      const scratchDir = args.find(arg => arg.startsWith('ReadWritePaths='))!.slice('ReadWritePaths='.length);
      writeFileSync(path.join(scratchDir, 'ok'), 'positive control');
      return { status: 0, stdout: stdoutFromFields({ ...SYSTEMD_UNIT_FIELDS,
        TMPMARK: path.join(scratchDir, 'private-marker') }), stderr: '', error: null };
    }
    if (path.basename(cmd) === 'systemctl' && args.includes('show-environment')) {
      return { status: 0, stdout: 'AIWG_UNLISTED_SECRET=synthetic-manager-secret\n', stderr: '', error: null };
    }
    if (cmd === clientFixture.binary && args.some(arg => arg.startsWith('--unit=aiwg-verify-'))) return launch(args, options);
    return baseline(cmd, args);
  };
}

describe('verification client environment and read-isolation reporting', () => {
  it.skipIf(process.platform !== 'linux').for(['substitution', 'missing-path'])('uses the conductor executable with real spawn resolution for caller PATH %s', (scenario, ctx) => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-verify-path-'));
    try {
      writeFileSync(path.join(root, 'systemd-run'), `#!/bin/sh\nprintf 'CALLER_EXECUTABLE_RAN\\n'\n`, { mode: 0o700 });
      const callerPath = scenario === 'missing-path' ? path.join(root, 'missing') : root;
      const spawn = successfulProbeSpawn(vi.fn());
      // Spawn the selected command so bare names really use the caller PATH.
      const dispatch = (cmd: string, args: string[], options?: any) => {
        if (args.some(arg => arg.startsWith('--unit=aiwg-verify-') && !arg.startsWith('--unit=aiwg-verify-isolation-probe-'))) {
          return realSpawnSync(cmd, args, options);
        }
        return spawn(cmd, args, options);
      };
      const result = runConfinedCheck({ command: '/bin/true', cwd: root, worktreeRootReal: root, spawn: dispatch,
        env: { PATH: callerPath, AIWG_ISOLATION_TOKEN: 'caller-token' }, envNames: ['PATH', 'AIWG_ISOLATION_TOKEN'] });
      if (result.error?.code === 'EPERM') { ctx.skip('sandbox denies real executable spawn'); return; }
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const output = JSON.parse(String(result.stdout));
      expect(output).toMatchObject({ source: 'conductor', env: { PATH: callerPath, AIWG_ISOLATION_TOKEN: 'caller-token' } });
      expect(output.args).toContain('--setenv=PATH');
      expect(output.args.join(' ')).not.toContain('caller-token');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'linux')('imports caller allowlisted values even when conductor values conflict, retaining the session connection', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-verify-client-env-'));
    try {
      vi.stubEnv('AIWG_ISOLATION_TOKEN', 'conductor-token');
      vi.stubEnv('AIWG_OMITTED_TOKEN', 'conductor-only-token');
      vi.stubEnv('AIWG_UNLISTED_SECRET', 'conductor-secret');
      vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/synthetic');
      vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/synthetic/bus');
      vi.stubEnv('SYSTEMD_BUS_ADDRESS', 'unix:path=/synthetic/systemd-bus');
      vi.stubEnv('NODE_OPTIONS', '--require=/synthetic/bootstrap');
      let clientEnv: NodeJS.ProcessEnv | undefined;
      let launchArgs: string[] = [];
      const launchSpawn = successfulProbeSpawn((args, options) => {
        clientEnv = options.env;
        launchArgs = args;
        return { status: 0, stdout: '', stderr: '', error: null };
      });
      const spawn = (cmd: string, args: string[], options?: any) => {
        if (path.basename(cmd) === 'systemctl' || path.basename(cmd) === 'systemd-run') {
          expect(path.isAbsolute(cmd)).toBe(true);
          expect(options?.env).not.toHaveProperty('NODE_OPTIONS');
          expect(options?.env).not.toHaveProperty('AIWG_UNLISTED_SECRET');
          expect(options?.env ?? process.env).toMatchObject({ XDG_RUNTIME_DIR: '/run/user/synthetic',
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/synthetic/bus', SYSTEMD_BUS_ADDRESS: 'unix:path=/synthetic/systemd-bus' });
        }
        return launchSpawn(cmd, args, options);
      };
      const result = runConfinedCheck({ command: '/bin/true', cwd: root, worktreeRootReal: root, spawn,
        envNames: ['PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMD_BUS_ADDRESS', 'AIWG_ISOLATION_TOKEN', 'AIWG_CALLER_ONLY', 'AIWG_OMITTED_TOKEN'],
        env: { PATH: '/synthetic/bin', XDG_RUNTIME_DIR: '/run/user/caller',
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/caller/bus', SYSTEMD_BUS_ADDRESS: 'unix:path=/caller/systemd-bus', AIWG_ISOLATION_TOKEN: 'caller-token',
          AIWG_CALLER_ONLY: 'caller-only-token', AIWG_UNLISTED_SECRET: 'caller-secret' } });
      expect(result.status).toBe(0);
      expect(clientEnv).toMatchObject({ PATH: '/synthetic/bin', XDG_RUNTIME_DIR: '/run/user/synthetic',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/synthetic/bus', SYSTEMD_BUS_ADDRESS: 'unix:path=/synthetic/systemd-bus', AIWG_ISOLATION_TOKEN: 'caller-token',
        AIWG_CALLER_ONLY: 'caller-only-token' });
      for (const name of ['AIWG_UNLISTED_SECRET', 'AIWG_OMITTED_TOKEN', 'NODE_OPTIONS']) {
        expect(clientEnv).not.toHaveProperty(name);
        expect(launchArgs).not.toContain(`--setenv=${name}`);
      }
      for (const name of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMD_BUS_ADDRESS']) expect(launchArgs).not.toContain(`--setenv=${name}`);
      expect(launchArgs).toContain('--setenv=AIWG_ISOLATION_TOKEN');
      expect(launchArgs).toContain('--setenv=AIWG_CALLER_ONLY');
      expect(launchArgs).toContain('UnsetEnvironment=AIWG_UNLISTED_SECRET XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS SYSTEMD_BUS_ADDRESS');
      expect(launchArgs.join(' ')).not.toMatch(/caller-token|caller-only-token|conductor-token|caller-secret/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'linux')('reports arbitrary reads as degraded despite successful required probes', () => {
    const spawn = successfulProbeSpawn(args => {
      expect(args).toContain('ProtectHome=tmpfs');
      expect(args).toContain('PrivateTmp=yes');
      expect(args).toContain('ReadOnlyPaths=/');
      expect(args.some(arg => arg.startsWith('InaccessiblePaths=') || arg.startsWith('TemporaryFileSystem='))).toBe(false);
      return { status: 0, stdout: '', stderr: '', error: null };
    });
    const capabilities = probeVerificationIsolationCapabilities({ spawn, force: true });
    expect(capabilities).toMatchObject({ writeConfinement: 'enforced', homeReadIsolation: 'enforced',
      tmpIsolation: 'enforced', networkIsolation: 'enforced', arbitraryPathReadIsolation: 'degraded' });
    expect(missingRequiredCapabilities(capabilities)).toEqual([]);
    expect(capabilities.degraded).toEqual([{ capability: 'arbitraryPathReadIsolation', reason: expect.stringMatching(/does not confine reads/) }]);
    const result = runConfinedCheck({ command: '/bin/true', cwd: clientFixture.root,
      worktreeRootReal: clientFixture.root, env: {}, envNames: [], spawn });
    expect(result.status).toBe(0);
    expect(result.isolation.degraded).toContainEqual({ capability: 'arbitraryPathReadIsolation',
      reason: expect.stringMatching(/does not confine reads.*ReadOnlyPaths=\/ prevents writes/) });
  });
});

describe.skipIf(process.platform !== 'linux')('B1 (round 2): probe is fail-closed end to end', () => {
  it('a probe unit that times out (spawn-level error, partial stdout) reports EVERY capability degraded, never defaulting a missing field to enforced', () => {
    const spawn = fakeSpawnFactory({
      probeStdout: 'NONEWPRIVS:1\nNETNS:net:[probe]\n', // partial: missing SCRATCHWRITE/TMPWRITE/etc and DONE
      probeStatus: null,
      probeError: { code: 'ETIMEDOUT', message: 'timed out' },
    });
    const result = probeVerificationIsolationCapabilities({ spawn, force: true });
    expect(result.mode).toBe('systemd-unit');
    for (const capability of ['writeConfinement', 'tmpWriteConfinement', 'noNewPrivileges', 'homeReadIsolation', 'tmpIsolation', 'networkIsolation', 'arbitraryPathReadIsolation']) {
      expect(result[capability]).toBe('degraded');
    }
    expect(result.degraded.some(entry => entry.capability === 'probe')).toBe(true);
  });

  it('a probe unit that exits non-zero (no spawn-level error) is ALSO treated as a full probe failure, not partially parsed', () => {
    const spawn = fakeSpawnFactory({ probeStdout: stdoutFromFields(SYSTEMD_UNIT_FIELDS), probeStatus: 7, probeError: null });
    const result = probeVerificationIsolationCapabilities({ spawn, force: true });
    expect(result.writeConfinement).toBe('degraded');
    expect(result.tmpWriteConfinement).toBe('degraded');
    expect(result.degraded.some(entry => entry.capability === 'probe')).toBe(true);
  });

  it('a probe unit missing just the DONE completion marker (stdout cut off mid-write) is treated as fully incomplete, not "mostly fine"', () => {
    const fields = { ...SYSTEMD_UNIT_FIELDS };
    delete (fields as Record<string, string>).DONE;
    const spawn = fakeSpawnFactory({ probeStdout: stdoutFromFields(fields), probeStatus: 0, probeError: null });
    const result = probeVerificationIsolationCapabilities({ spawn, force: true });
    expect(result.networkIsolation).toBe('degraded');
    expect(result.writeConfinement).toBe('degraded');
    expect(result.degraded.some(entry => entry.capability === 'probe' && /missing/.test(entry.reason))).toBe(true);
  });

  it('a failed host-netns lookup fails the WHOLE probe closed, never implying isolation from an empty/unknown baseline', () => {
    const spawn = fakeSpawnFactory({ hostNetNsFails: true, probeStdout: stdoutFromFields(SYSTEMD_UNIT_FIELDS) });
    const result = probeVerificationIsolationCapabilities({ spawn, force: true });
    expect(result.networkIsolation).toBe('degraded');
    expect(result.writeConfinement).toBe('degraded'); // whole probe failed, not just network
    expect(result.degraded.some(entry => entry.capability === 'probe' && /network namespace/.test(entry.reason))).toBe(true);
  });

  it('a probe failure is NEVER cached: the very next call re-probes rather than reusing the failure', () => {
    let calls = 0;
    const countingFail = (cmd: string, args: string[] = []) => {
      calls++;
      return fakeSpawnFactory({ hostNetNsFails: true })(cmd, args);
    };
    probeVerificationIsolationCapabilities({ spawn: countingFail, force: true });
    const callsAfterFirst = calls;
    probeVerificationIsolationCapabilities({ spawn: countingFail }); // no force: true this time
    expect(calls).toBeGreaterThan(callsAfterFirst);
  });

  it('a successful probe IS cached: a second call with a call-counting spawn does not re-invoke it', () => {
    let calls = 0;
    const counting = (cmd: string, args: string[] = []) => {
      calls++;
      return fakeSpawnFactory({ probeStdout: stdoutFromFields(SYSTEMD_UNIT_FIELDS) })(cmd, args);
    };
    probeVerificationIsolationCapabilities({ spawn: counting, force: true });
    const callsAfterFirst = calls;
    probeVerificationIsolationCapabilities({ spawn: counting });
    expect(calls).toBe(callsAfterFirst);
  });

  it('the write-confinement outside check is positive: a scratch write that never actually lands (self-report says 0, reality says no) is degraded', () => {
    // SCRATCHWRITE:0 claims success, but since this is a pure fake (no real
    // systemd-run ran), no scratch directory was ever actually written to
    // -- proving writeConfinement depends on the OUTSIDE existsSync check,
    // not the self-reported shell exit code alone.
    const spawn = fakeSpawnFactory({ probeStdout: stdoutFromFields(SYSTEMD_UNIT_FIELDS) });
    const result = probeVerificationIsolationCapabilities({ spawn, force: true });
    expect(result.writeConfinement).toBe('degraded');
    expect(result.degraded.some(entry => entry.capability === 'writeConfinement' && /did not work/.test(entry.reason))).toBe(true);
  });
});

describe('B1 (round 2): runConfinedCheck refuses on EVERY required capability, not write confinement alone', () => {
  it('REQUIRED_VERIFICATION_CAPABILITIES names write confinement, home protection, and network', () => {
    expect(REQUIRED_VERIFICATION_CAPABILITIES).toEqual(['writeConfinement', 'homeReadIsolation', 'networkIsolation']);
  });

  it('missingRequiredCapabilities reports homeReadIsolation/networkIsolation gaps even when writeConfinement alone is enforced', () => {
    const capabilities = {
      mode: 'systemd-unit', writeConfinement: 'enforced', homeReadIsolation: 'degraded',
      networkIsolation: 'degraded', tmpIsolation: 'degraded', noNewPrivileges: 'enforced',
      tmpWriteConfinement: 'degraded', arbitraryPathReadIsolation: 'degraded', degraded: [],
    };
    expect(missingRequiredCapabilities(capabilities)).toEqual(['homeReadIsolation', 'networkIsolation']);
  });

  it.skipIf(process.platform !== 'linux')('runConfinedCheck refuses when writeConfinement is the ONLY degraded capability (old bug: refusal checked write confinement only, so this would previously still refuse correctly) AND when home/network are the only degraded ones (previously this would have WRONGLY proceeded)', () => {
    const fields = { ...SYSTEMD_UNIT_FIELDS, HOMECOUNT: '0' }; // homeReadIsolation would read as enforced
    const spawn = fakeSpawnFactory({ probeStdout: stdoutFromFields(fields) });
    // writeConfinement is degraded in this fixture (SCRATCHWRITE self-report
    // is not corroborated by a real outside write) -- refuses either way.
    const result = runConfinedCheck({ command: '/bin/echo', args: ['hi'], worktreeRootReal: '/tmp', spawn });
    expect(result.error?.code).toBe('ISOLATION_UNAVAILABLE');
    expect(result.error?.message).toMatch(/writeConfinement/);
  });
});

describe('B1 (round 2): allowDegradedIsolation is a strict boolean gate', () => {
  function degradedModeSpawn() {
    return () => ({ status: 1, stdout: '', stderr: 'no systemd-run', error: null });
  }

  it('rejects the string "false" as if it were false (closing the JS-truthiness gap in the old `!allowDegradedIsolation` check)', () => {
    const result = runConfinedCheck({ command: '/bin/echo', args: [], worktreeRootReal: '/tmp', spawn: degradedModeSpawn(), allowDegradedIsolation: 'false' as unknown as boolean });
    expect(result.error?.code).toBe('ISOLATION_UNAVAILABLE');
  });

  it('rejects other truthy-but-not-true values (e.g. the number 1)', () => {
    const result = runConfinedCheck({ command: '/bin/echo', args: [], worktreeRootReal: '/tmp', spawn: degradedModeSpawn(), allowDegradedIsolation: 1 as unknown as boolean });
    expect(result.error?.code).toBe('ISOLATION_UNAVAILABLE');
  });

  it('accepts only the literal boolean true', () => {
    const result = runConfinedCheck({ command: '/bin/echo', args: [], worktreeRootReal: '/tmp', spawn: degradedModeSpawn(), allowDegradedIsolation: true });
    expect(result.error?.code).not.toBe('ISOLATION_UNAVAILABLE');
  });

  it('defaults to refusing (false) when omitted', () => {
    const result = runConfinedCheck({ command: '/bin/echo', args: [], worktreeRootReal: '/tmp', spawn: degradedModeSpawn() });
    expect(result.error?.code).toBe('ISOLATION_UNAVAILABLE');
  });
});

describe('HIGH m2 regression: a degraded launch uses the SAME strict env allowlist as a confined launch', () => {
  it.skipIf(process.platform !== 'linux')('an unlisted synthetic secret in the conductor environment does not survive into the degraded child process', ctx => {
    // The probe-related calls report "no systemd" (forcing the degraded,
    // allowDegradedIsolation-opt-in branch); the ACTUAL check command is
    // delegated to the real spawnSync so this observes real child-process
    // environment behavior, not a mocked one.
    const fakeSpawn: typeof realSpawnSync = ((cmd: string, args: readonly string[] = [], opts: Record<string, unknown>) => {
      if (path.basename(cmd) === 'systemd-run' || path.basename(cmd) === 'systemctl' || cmd === 'readlink') {
        return { status: 1, stdout: '', stderr: 'no systemd', error: null } as ReturnType<typeof realSpawnSync>;
      }
      return realSpawnSync(cmd, args as string[], opts);
    }) as typeof realSpawnSync;

    const result = runConfinedCheck({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(String(process.env.MY_UNLISTED_SYNTHETIC_SECRET ?? "ABSENT"))'],
      cwd: process.cwd(),
      envNames: ['PATH'],
      env: { ...process.env, MY_UNLISTED_SYNTHETIC_SECRET: 'sk-test-should-not-leak' },
      spawn: fakeSpawn,
      allowDegradedIsolation: true,
      timeoutMs: 10000,
    });
    if (result.error?.code === 'EPERM') { ctx.skip('sandbox denies real executable spawn'); return; }
    expect(result.error).toBeUndefined();
    expect(String(result.stdout)).toBe('ABSENT');
  }, 15000);
});

describe('B1 (round 2): a launch requests EXACTLY the property set the probe proved', () => {
  it('requires the live-probed capabilities object; refuses to build a property list from memory', () => {
    expect(() => buildVerificationExtraProperties({ worktreeRootReal: '/tmp/wt' })).toThrow(/requires the live-probed capabilities/);
  });

  it('omits ProtectHome/PrivateTmp/PrivateNetwork/ReadOnlyPaths when their matching capability is degraded', () => {
    const capabilities = {
      mode: 'systemd-unit', writeConfinement: 'degraded', homeReadIsolation: 'degraded',
      tmpIsolation: 'degraded', networkIsolation: 'degraded', noNewPrivileges: 'enforced',
      tmpWriteConfinement: 'degraded', arbitraryPathReadIsolation: 'degraded', degraded: [],
    };
    const properties = buildVerificationExtraProperties({ worktreeRootReal: '/tmp/wt', capabilities });
    expect(properties).toEqual(['NoNewPrivileges=yes', 'PrivateUsers=yes']);
    expect(properties.some(p => p.startsWith('ReadOnlyPaths=') || p.startsWith('ReadWritePaths=') || p.startsWith('ProtectHome=') || p.startsWith('PrivateTmp=') || p.startsWith('PrivateNetwork='))).toBe(false);
  });

  it('includes ProtectHome/PrivateTmp/PrivateNetwork/ReadOnlyPaths+ReadWritePaths only when each matching capability is enforced (old bug: these were omitted from every launch regardless)', () => {
    const capabilities = {
      mode: 'systemd-unit', writeConfinement: 'enforced', homeReadIsolation: 'enforced',
      tmpIsolation: 'enforced', networkIsolation: 'enforced', noNewPrivileges: 'enforced',
      tmpWriteConfinement: 'degraded', arbitraryPathReadIsolation: 'degraded', degraded: [],
    };
    const properties = buildVerificationExtraProperties({ worktreeRootReal: '/tmp/wt', outputDirReal: '/tmp/out', capabilities });
    expect(properties).toContain('ReadOnlyPaths=/');
    expect(properties).toContain('ReadWritePaths=/tmp/wt');
    expect(properties).toContain('ReadWritePaths=/tmp/out');
    expect(properties).toContain('ProtectHome=tmpfs');
    expect(properties).toContain('PrivateTmp=yes');
    expect(properties).toContain('PrivateNetwork=yes');
  });

  it('a mixed capability set includes only the proven subset (e.g. network enforced but home degraded)', () => {
    const capabilities = {
      mode: 'systemd-unit', writeConfinement: 'enforced', homeReadIsolation: 'degraded',
      tmpIsolation: 'degraded', networkIsolation: 'enforced', noNewPrivileges: 'enforced',
      tmpWriteConfinement: 'degraded', arbitraryPathReadIsolation: 'degraded', degraded: [],
    };
    const properties = buildVerificationExtraProperties({ worktreeRootReal: '/tmp/wt', capabilities });
    expect(properties).toContain('PrivateNetwork=yes');
    expect(properties).not.toContain('ProtectHome=tmpfs');
    expect(properties).not.toContain('PrivateTmp=yes');
  });
});

describe.skipIf(process.platform !== 'linux')('B1 (round 2): the /tmp probe marker is checked and cleaned up from OUTSIDE the unit, never by the unit itself', () => {
  it('a marker left on the real filesystem by the fake "probe" is detected as a leak and removed afterward', () => {
    // Simulate a host where PrivateTmp is degraded: the marker path the
    // probe "reports" is a REAL file this test creates directly (standing
    // in for a write that actually landed on host /tmp), never deleted by
    // the (fake) unit itself -- proving the outside check, not a
    // self-report, is what detects and cleans it up.
    const scratchHome = mkdtempSync(path.join(tmpdir(), 'aiwg-verify-fake-tmpmark-'));
    const markerPath = path.join(scratchHome, 'leaked-marker');
    writeFileSync(markerPath, 'leaked\n');
    const fields = { ...SYSTEMD_UNIT_FIELDS, TMPMARK: markerPath };
    const spawn = fakeSpawnFactory({ probeStdout: stdoutFromFields(fields) });
    const result = probeVerificationIsolationCapabilities({ spawn, force: true });
    expect(result.tmpIsolation).toBe('degraded');
    expect(existsSync(markerPath)).toBe(false); // cleaned up by the probe function itself
    rmSync(scratchHome, { recursive: true, force: true });
  });

  it('a marker path that was never created (the realistic "PrivateTmp enforced" case) reports tmpIsolation enforced without error', () => {
    const notMarkDir = mkdtempSync(path.join(tmpdir(), 'aiwg-verify-fake-notmark-'));
    try {
      const fields = { ...SYSTEMD_UNIT_FIELDS, TMPMARK: path.join(notMarkDir, 'never-created') };
      const spawn = fakeSpawnFactory({ probeStdout: stdoutFromFields(fields) });
      const result = probeVerificationIsolationCapabilities({ spawn, force: true });
      expect(result.tmpIsolation).toBe('enforced');
    } finally {
      rmSync(notMarkDir, { recursive: true, force: true });
    }
  });
});

describe('B1 (round 2): a host with no systemd user manager at all is still cached (a durable finding, not a probe failure)', () => {
  it('caches the "no systemd" degraded result so repeated calls do not keep re-shelling out', () => {
    let calls = 0;
    const noSystemd = () => { calls++; return { status: 1, stdout: '', stderr: 'nope', error: null }; };
    probeVerificationIsolationCapabilities({ spawn: noSystemd, force: true });
    const callsAfterFirst = calls;
    probeVerificationIsolationCapabilities({ spawn: noSystemd });
    expect(calls).toBe(callsAfterFirst);
  });
});
