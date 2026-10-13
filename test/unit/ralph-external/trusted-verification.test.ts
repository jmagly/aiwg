/**
 * Unit/conformance tests for Tier 0 trusted verification outside the
 * worker sandbox (FR-OG-039, FR-OG-042, FR-OG-068, #2889 / B-OG-13).
 *
 * Uses real temp directories, real symlinks/hardlinks, and real spawned
 * fixture processes (not mocked logic) for the security-relevant
 * assertions. Live-systemd confinement proofs are gated on an actual
 * reachable `systemd-run --user` manager and `ctx.skip()` otherwise
 * (guidance: a systemd user manager may not exist in CI); permission-bit
 * tests skip under root (CI runs as root, where DAC is not enforced).
 * T-OG-04 (isolation/verification) and T-OG-10 (security negatives) scope.
 *
 * @source @tools/ralph-external/lib/trusted-verification.mjs
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProtectedCheckViolationError,
  WorktreeEscapeError,
  assertAllowedCheckBinary,
  assertInterpreterArgsSafeForDegradedConfinement,
  assertNoNestedMounts,
  assertNoSecretLookingEnvNames,
  assertNotPackageScriptInvocation,
  assertRootIdentityUnchanged,
  assertWithinWorktree,
  computeWorktreeTreeDigest,
  openPinnedWithinWorktree,
  pinArtifact,
  pinRootIdentity,
  resolveRealpath,
  resolveWorktreeRoot,
  runProtectedCheck,
  verifyWorkerArtifact,
} from '../../../tools/ralph-external/lib/trusted-verification.mjs';
import { probeVerificationIsolationCapabilities } from '../../../tools/ralph-external/lib/verification-isolation.mjs';

const fixturesRoot = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const sandboxFixture = path.join(fixturesRoot, 'simulate-sandbox-error.mjs');

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tmpWorktree() {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-trusted-verify-worktree-'));
  roots.push(root);
  return root;
}

function tmpOutside() {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-trusted-verify-outside-'));
  roots.push(root);
  return root;
}

// Live-systemd-only tests below gate on this, computed once and reused so
// the (bounded, single-call) capability probe does not run per-test.
const liveIsolation = probeVerificationIsolationCapabilities({});
const hasLiveIsolation = liveIsolation.mode === 'systemd-unit';

/** A fake confined-spawn used by pure classification tests (B3): it never
 * shells out to systemd-run, so these tests run everywhere and fast, while
 * still exercising the exact classification code path `runProtectedCheck`
 * uses against a `runConfinedCheck`-shaped result. */
function fakeConfinedRunner(responder: (opts: Record<string, unknown>) => Record<string, unknown>) {
  return (opts: Record<string, unknown>) => ({
    isolation: { mode: 'systemd-unit', degraded: [] },
    ...responder(opts),
  });
}

describe('path-safety: symlink and hardlink escape are blocked (T-OG-04)', () => {
  it('denies a symlink inside the worktree pointing outside, regardless of target', () => {
    const worktree = tmpWorktree();
    const outside = tmpOutside();
    const secret = path.join(outside, 'secret.txt');
    writeFileSync(secret, 'TOP SECRET\n');
    const link = path.join(worktree, 'planted-symlink.txt');
    symlinkSync(secret, link);

    const worktreeRootReal = resolveWorktreeRoot(worktree);
    expect(() => assertWithinWorktree(worktreeRootReal, link)).toThrow(WorktreeEscapeError);
    expect(() => assertWithinWorktree(worktreeRootReal, link)).toThrow(/outside the worktree/);
  });

  it('m1: allows a symlink inside the worktree whose target also stays inside it (node_modules/.bin-style layouts)', () => {
    const worktree = tmpWorktree();
    const real = path.join(worktree, 'real.txt');
    writeFileSync(real, 'ok\n');
    const link = path.join(worktree, 'inside-link.txt');
    symlinkSync(real, link);

    const worktreeRootReal = resolveWorktreeRoot(worktree);
    expect(assertWithinWorktree(worktreeRootReal, link)).toBe(real);
  });

  it('denies a hardlink to a file outside the worktree when validating the ARTIFACT specifically (pinArtifact)', () => {
    const worktree = tmpWorktree();
    const outside = tmpOutside();
    const target = path.join(outside, 'shared-dependency.txt');
    writeFileSync(target, 'mutable shared content\n');
    const hardlink = path.join(worktree, 'planted-hardlink.txt');
    linkSync(target, hardlink);

    const worktreeRootReal = resolveWorktreeRoot(worktree);
    expect(() => pinArtifact(worktreeRootReal, hardlink)).toThrow(/multiply-linked/);
  });

  it('m1: a multiply-linked file is NOT denied by the general path check (assertWithinWorktree) used for cwd/binary resolution, only by pinArtifact', () => {
    // Legitimate npm/pnpm installs routinely hardlink node_modules content
    // from a shared store; general path resolution must not blanket-deny
    // nlink > 1, or every real install would be refused.
    const worktree = tmpWorktree();
    const outside = tmpOutside();
    const target = path.join(outside, 'store-file.txt');
    writeFileSync(target, 'package-manager store content\n');
    const hardlink = path.join(worktree, 'node_modules-style-hardlink.txt');
    linkSync(target, hardlink);

    const worktreeRootReal = resolveWorktreeRoot(worktree);
    expect(assertWithinWorktree(worktreeRootReal, hardlink)).toBe(hardlink);
  });

  it('accepts a plain regular file created fresh inside the worktree', () => {
    const worktree = tmpWorktree();
    const file = path.join(worktree, 'normal.txt');
    writeFileSync(file, 'fine\n');
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    expect(assertWithinWorktree(worktreeRootReal, file)).toBe(file);
  });

  it('denies a path that literally resolves outside the worktree even with no symlink involved', () => {
    const worktree = tmpWorktree();
    const outside = tmpOutside();
    const outsideFile = path.join(outside, 'not-in-worktree.txt');
    writeFileSync(outsideFile, 'nope\n');
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    expect(() => assertWithinWorktree(worktreeRootReal, outsideFile)).toThrow(/outside the worktree/);
  });

  it('requires absolute paths for both the worktree root and the target path', () => {
    expect(() => resolveWorktreeRoot('relative/path')).toThrow(WorktreeEscapeError);
    const worktree = tmpWorktree();
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    expect(() => assertWithinWorktree(worktreeRootReal, 'relative.txt')).toThrow(/absolute/);
  });

  it('refuses a worktree root that is itself a symlink, rather than silently canonicalizing it', () => {
    const real = tmpWorktree();
    const outerDir = tmpOutside();
    const link = path.join(outerDir, 'root-link');
    symlinkSync(real, link);
    expect(() => resolveWorktreeRoot(link)).toThrow(/must not itself be a symlink/);
  });
});

describe('B2: TOCTOU — a path validated before use is pinned by file descriptor, not re-resolved later', () => {
  it('a symlink swapped in after a path was first validated is denied on the later access that actually uses it', () => {
    const worktree = tmpWorktree();
    const outside = tmpOutside();
    const secret = path.join(outside, 'secret-after-swap.txt');
    writeFileSync(secret, 'TOP SECRET\n');
    const target = path.join(worktree, 'cwd-or-artifact');
    writeFileSync(target, 'originally a plain file\n');
    const worktreeRootReal = resolveWorktreeRoot(worktree);

    // "Check": validated while it is still a plain in-worktree file.
    const first = openPinnedWithinWorktree(worktreeRootReal, target);
    expect(first.realPath).toBe(target);
    // The fd pins THIS inode; reading it still returns the original content
    // even after the name is swapped underneath it (proves "use" of an
    // already-pinned fd cannot be redirected).
    unlinkSync(target);
    symlinkSync(secret, target);
    const bytes = Buffer.alloc(64);
    const read = readSync(first.fd, bytes, 0, 64, 0);
    expect(bytes.subarray(0, read).toString('utf8')).toBe('originally a plain file\n');
    closeSync(first.fd);

    // "Use": a later, independent access to the same path (the swap is now
    // in place) must be denied, not silently follow the planted symlink.
    expect(() => openPinnedWithinWorktree(worktreeRootReal, target)).toThrow(WorktreeEscapeError);
  });

  it('B2 (round 2): a cwd directory swapped out from under the pinned fd DURING the confined run is detected on return, not trusted', () => {
    const worktree = tmpWorktree();
    const sub = path.join(worktree, 'cwd-dir');
    mkdirSync(sub);
    const worktreeRootReal = resolveWorktreeRoot(worktree);

    expect(() => runProtectedCheck({
      id: 'swap-during-run', command: '/bin/echo', args: ['ok'], cwd: sub, worktreeRootReal,
      allowedCheckBinaries: ['/bin/echo'],
      runConfined: () => {
        // Simulate an attacker swapping the cwd directory entry out from
        // under the already-pinned fd WHILE the "confined" check "runs" —
        // the fd was opened before this callback and is still held open by
        // runProtectedCheck across this entire call (B2: held open across
        // probe+launch, not closed beforehand).
        rmdirSync(sub);
        symlinkSync('/etc', sub);
        return { isolation: { mode: 'systemd-unit', degraded: [] }, status: 0, stdout: 'ok\n', stderr: '', error: null };
      },
    })).toThrow(WorktreeEscapeError);
  });

  it('B2 (round 2): a normal run (no swap) still re-verifies cleanly and returns the real classification', () => {
    const worktree = tmpWorktree();
    const sub = path.join(worktree, 'cwd-dir');
    mkdirSync(sub);
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    const outcome = runProtectedCheck({
      id: 'no-swap', command: '/bin/echo', args: ['ok'], cwd: sub, worktreeRootReal,
      allowedCheckBinaries: ['/bin/echo'],
      runConfined: () => ({ isolation: { mode: 'systemd-unit', degraded: [] }, status: 0, stdout: 'ok\n', stderr: '', error: null }),
    });
    expect(outcome.classification).toBe('passed');
  });
});

describe('M1 residual: the ALLOWLIST-RESOLVED real path is launched, never the original (possibly-symlinked) command spelling', () => {
  it('runProtectedCheck launches the resolved realpath, not the symlink string that was validated', () => {
    const worktree = tmpWorktree();
    const outside = tmpOutside();
    const link = path.join(outside, 'echo-link');
    symlinkSync('/bin/echo', link);
    const real = resolveRealpath(link);
    const worktreeRootReal = resolveWorktreeRoot(worktree);

    let seenCommand: string | undefined;
    const outcome = runProtectedCheck({
      id: 'resolved-launch', command: link, args: ['ok'], worktreeRootReal,
      allowedCheckBinaries: [link],
      runConfined: opts => {
        seenCommand = opts.command as string;
        return { isolation: { mode: 'systemd-unit', degraded: [] }, status: 0, stdout: 'ok\n', stderr: '', error: null };
      },
    });
    expect(outcome.classification).toBe('passed');
    expect(seenCommand).toBe(real);
    expect(seenCommand).not.toBe(link);
  });
});

describe('M1 residual: an allowlisted interpreter given a worktree-path argument depends on confinement, and is refused when confinement is degraded', () => {
  const degradedCapabilities = {
    mode: 'systemd-unit', writeConfinement: 'degraded', homeReadIsolation: 'degraded',
    networkIsolation: 'degraded', tmpIsolation: 'degraded', noNewPrivileges: 'enforced',
    tmpWriteConfinement: 'degraded', arbitraryPathReadIsolation: 'degraded', degraded: [],
  };
  const enforcedCapabilities = {
    mode: 'systemd-unit', writeConfinement: 'enforced', homeReadIsolation: 'enforced',
    networkIsolation: 'enforced', tmpIsolation: 'enforced', noNewPrivileges: 'enforced',
    tmpWriteConfinement: 'enforced', arbitraryPathReadIsolation: 'degraded',
    degraded: [{ capability: 'arbitraryPathReadIsolation', reason: 'other host paths remain readable' }],
  };

  it('refuses /usr/bin/node <worktree-script> when confinement is degraded and no explicit opt-in was given', () => {
    const worktree = tmpWorktree();
    const script = path.join(worktree, 'worker-script.js');
    writeFileSync(script, 'console.log("hi");\n');
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    expect(() => assertInterpreterArgsSafeForDegradedConfinement('/usr/bin/node', [script], {
      worktreeRootReal, capabilities: degradedCapabilities,
    })).toThrow(ProtectedCheckViolationError);
  });

  it('allows the same interpreter+worktree-arg combination with an explicit allowWorktreeInterpreterArgs: true opt-in', () => {
    const worktree = tmpWorktree();
    const script = path.join(worktree, 'worker-script.js');
    writeFileSync(script, 'console.log("hi");\n');
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    expect(() => assertInterpreterArgsSafeForDegradedConfinement('/usr/bin/node', [script], {
      worktreeRootReal, capabilities: degradedCapabilities, allowWorktreeInterpreterArgs: true,
    })).not.toThrow();
  });

  it('allows the same combination when required capabilities are enforced despite degraded arbitrary reads (no opt-in needed)', () => {
    const worktree = tmpWorktree();
    const script = path.join(worktree, 'worker-script.js');
    writeFileSync(script, 'console.log("hi");\n');
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    expect(() => assertInterpreterArgsSafeForDegradedConfinement('/usr/bin/node', [script], {
      worktreeRootReal, capabilities: enforcedCapabilities,
    })).not.toThrow();
  });

  it('does not refuse a non-interpreter binary even with a worktree-path argument and degraded confinement', () => {
    const worktree = tmpWorktree();
    const file = path.join(worktree, 'data.json');
    writeFileSync(file, '{}');
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    expect(() => assertInterpreterArgsSafeForDegradedConfinement('/usr/bin/jq', ['.', file], {
      worktreeRootReal, capabilities: degradedCapabilities,
    })).not.toThrow();
  });

  it('does not refuse an interpreter invocation whose args never reference the worktree at all', () => {
    const worktree = tmpWorktree();
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    expect(() => assertInterpreterArgsSafeForDegradedConfinement('/usr/bin/node', ['--version'], {
      worktreeRootReal, capabilities: degradedCapabilities,
    })).not.toThrow();
  });
});

describe('M1: check binary allowlist (not a denylist) — fail closed, outside the worktree, exact match', () => {
  it('refuses when no allowedCheckBinaries are configured at all (fail closed)', () => {
    expect(() => assertAllowedCheckBinary('/bin/echo', { allowedCheckBinaries: [] })).toThrow(ProtectedCheckViolationError);
  });

  it('refuses a relative/bare command name outright, even if it would otherwise be allowlisted', () => {
    expect(() => assertAllowedCheckBinary('echo', { allowedCheckBinaries: ['/bin/echo'] })).toThrow(/absolute/);
  });

  it('refuses a check binary that resolves inside the worktree (node_modules/.bin, a worker-written script), regardless of any allowlist', () => {
    const worktree = tmpWorktree();
    const workerBin = path.join(worktree, 'node_modules', '.bin', 'vitest');
    mkdirSync(path.dirname(workerBin), { recursive: true });
    writeFileSync(workerBin, '#!/bin/sh\necho pwned\n');
    chmodSync(workerBin, 0o755);
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    expect(() => assertAllowedCheckBinary(workerBin, { allowedCheckBinaries: [workerBin], worktreeRootReal })).toThrow(/resolves inside the worktree/);
  });

  it('refuses a binary outside the worktree that is not in the allowlist (denylist-only would have let this through: make/env/./evil.sh are not package managers)', () => {
    const worktree = tmpWorktree();
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    // /bin/true and /bin/false both exist but resolve to distinct real
    // binaries on this host; neither is a package manager, so the OLD
    // denylist would have let either through unconditionally.
    expect(() => assertAllowedCheckBinary('/bin/true', { allowedCheckBinaries: ['/bin/false'], worktreeRootReal })).toThrow(/not in the conductor's allowedCheckBinaries/);
  });

  it('allows a binary that is both outside the worktree and exactly allowlisted', () => {
    const worktree = tmpWorktree();
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    const real = assertAllowedCheckBinary('/bin/true', { allowedCheckBinaries: ['/bin/true'], worktreeRootReal });
    expect(real.endsWith('true')).toBe(true);
  });

  it('a conductor allowlist entry that does not resolve on this host is skipped (never crashes), it simply matches nothing', () => {
    const worktree = tmpWorktree();
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    expect(() => assertAllowedCheckBinary('/bin/true', { allowedCheckBinaries: ['/no/such/binary-on-this-host', '/bin/true'], worktreeRootReal })).not.toThrow();
    expect(() => assertAllowedCheckBinary('/bin/false', { allowedCheckBinaries: ['/no/such/binary-on-this-host'], worktreeRootReal })).toThrow(ProtectedCheckViolationError);
  });
});

describe('m2: env allowlist names must never look like a secret', () => {
  it('refuses envNames containing an obvious secret-shaped name', () => {
    expect(() => assertNoSecretLookingEnvNames(['PATH', 'HOME', 'GITHUB_TOKEN'])).toThrow(ProtectedCheckViolationError);
    expect(() => assertNoSecretLookingEnvNames(['AWS_SECRET_ACCESS_KEY'])).toThrow(ProtectedCheckViolationError);
  });

  it('allows ordinary names, and allows an explicit, named override', () => {
    expect(() => assertNoSecretLookingEnvNames(['PATH', 'HOME', 'LANG'])).not.toThrow();
    expect(() => assertNoSecretLookingEnvNames(['PATH', 'MY_KEYBOARD_LAYOUT'], { allowSecretLookingNames: ['MY_KEYBOARD_LAYOUT'] })).not.toThrow();
  });
});

describe('protected checks: no worker-defined invocation shape, ever (defense-in-depth denylist, T-OG-10)', () => {
  it('refuses npm test/run/ci/install invocations outright, as a protected-check *definition* error, not a runtime failure', () => {
    for (const args of [['test'], ['run', 'build'], ['ci'], ['install'], ['run-script', 'start']]) {
      expect(() => assertNotPackageScriptInvocation('npm', args)).toThrow(ProtectedCheckViolationError);
    }
    expect(() => assertNotPackageScriptInvocation('yarn', ['test'])).toThrow(ProtectedCheckViolationError);
    expect(() => assertNotPackageScriptInvocation('pnpm', ['run', 'build'])).toThrow(ProtectedCheckViolationError);
    expect(() => assertNotPackageScriptInvocation('/usr/local/bin/npm', ['test'])).toThrow(ProtectedCheckViolationError);
  });

  it('allows a direct binary/file invocation that is not a package manager', () => {
    expect(() => assertNotPackageScriptInvocation('/usr/bin/node', ['--test', 'suite.js'])).not.toThrow();
  });
});

describe('B3: sandbox classification comes only from spawn-level errno or isolation status, never from check output text', () => {
  it('a check that fakes "EPERM" in its own stderr with a real failing exit is classified "failed", never downgraded to "sandbox"/"blocked"', () => {
    const worktree = tmpWorktree();
    const outcome = runProtectedCheck({
      id: 'fake-eperm', command: '/bin/echo', worktreeRootReal: resolveWorktreeRoot(worktree),
      allowedCheckBinaries: ['/bin/echo'],
      runConfined: fakeConfinedRunner(() => ({ status: 1, stdout: '', stderr: 'EPERM fake\n', error: null })),
    });
    expect(outcome.classification).toBe('failed');
  });

  it('a check that fakes "EROFS" in stdout with a real failing exit is classified "failed"', () => {
    const worktree = tmpWorktree();
    const outcome = runProtectedCheck({
      id: 'fake-erofs', command: '/bin/echo', worktreeRootReal: resolveWorktreeRoot(worktree),
      allowedCheckBinaries: ['/bin/echo'],
      runConfined: fakeConfinedRunner(() => ({ status: 1, stdout: 'EROFS fake\n', stderr: '', error: null })),
    });
    expect(outcome.classification).toBe('failed');
  });

  it('exit 0 with EPERM-shaped text in output is "passed" (output content is never inspected either way)', () => {
    const worktree = tmpWorktree();
    const outcome = runProtectedCheck({
      id: 'noisy-pass', command: '/bin/echo', worktreeRootReal: resolveWorktreeRoot(worktree),
      allowedCheckBinaries: ['/bin/echo'],
      runConfined: fakeConfinedRunner(() => ({ status: 0, stdout: 'warning: EPERM seen earlier but recovered\n', stderr: '', error: null })),
    });
    expect(outcome.classification).toBe('passed');
  });

  it('classifies a spawn-level EPERM errno as "sandbox", never "failed"', () => {
    const worktree = tmpWorktree();
    const outcome = runProtectedCheck({
      id: 'build', command: '/bin/echo', worktreeRootReal: resolveWorktreeRoot(worktree),
      allowedCheckBinaries: ['/bin/echo'],
      runConfined: fakeConfinedRunner(() => ({ status: null, stdout: '', stderr: '', error: { code: 'EPERM', message: 'eperm' } })),
    });
    expect(outcome).toMatchObject({ classification: 'sandbox', ok: false, reason: 'EPERM' });
  });

  it('classifies a spawn-level EROFS errno as "sandbox", never "failed"', () => {
    const worktree = tmpWorktree();
    const outcome = runProtectedCheck({
      id: 'build', command: '/bin/echo', worktreeRootReal: resolveWorktreeRoot(worktree),
      allowedCheckBinaries: ['/bin/echo'],
      runConfined: fakeConfinedRunner(() => ({ status: null, stdout: '', stderr: '', error: { code: 'EROFS', message: 'erofs' } })),
    });
    expect(outcome).toMatchObject({ classification: 'sandbox', ok: false, reason: 'EROFS' });
  });

  it('classifies isolation-unavailable (confinement required but not present, not allowed-degraded) as "sandbox"', () => {
    const worktree = tmpWorktree();
    const outcome = runProtectedCheck({
      id: 'build', command: '/bin/echo', worktreeRootReal: resolveWorktreeRoot(worktree),
      allowedCheckBinaries: ['/bin/echo'],
      runConfined: fakeConfinedRunner(() => ({ status: null, stdout: '', stderr: '', error: { code: 'ISOLATION_UNAVAILABLE', message: 'no systemd user manager' } })),
    });
    expect(outcome).toMatchObject({ classification: 'sandbox', reason: 'ISOLATION_UNAVAILABLE' });
  });

  it('classifies a timeout distinctly', () => {
    const worktree = tmpWorktree();
    const outcome = runProtectedCheck({
      id: 'build', command: '/bin/echo', worktreeRootReal: resolveWorktreeRoot(worktree),
      allowedCheckBinaries: ['/bin/echo'],
      runConfined: fakeConfinedRunner(() => ({ status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT', message: 'timed out' } })),
    });
    expect(outcome.classification).toBe('timeout');
  });

  it('classifies an ordinary non-zero exit with no special errno as a real "failed" check', () => {
    const worktree = tmpWorktree();
    const outcome = runProtectedCheck({
      id: 'build', command: '/bin/echo', worktreeRootReal: resolveWorktreeRoot(worktree),
      allowedCheckBinaries: ['/bin/echo'],
      runConfined: fakeConfinedRunner(() => ({ status: 7, stdout: '', stderr: 'assertion mismatch\n', error: null })),
    });
    expect(outcome).toMatchObject({ classification: 'failed', ok: false });
  });

  it('classifies exit 0 as "passed" and always attaches the isolation diagnostic, even on a clean pass', () => {
    const worktree = tmpWorktree();
    const outcome = runProtectedCheck({
      id: 'build', command: '/bin/echo', worktreeRootReal: resolveWorktreeRoot(worktree),
      allowedCheckBinaries: ['/bin/echo'],
      runConfined: fakeConfinedRunner(() => ({ status: 0, stdout: 'ok\n', stderr: '', error: null })),
    });
    expect(outcome).toMatchObject({ classification: 'passed', ok: true });
    expect(outcome.isolation).toEqual({ mode: 'systemd-unit', degraded: [] });
  });

  it('refuses to run a check whose binary is not allowlisted before ever invoking the confined spawn', () => {
    const worktree = tmpWorktree();
    let invoked = false;
    expect(() => runProtectedCheck({
      id: 'never-runs', command: '/bin/echo', worktreeRootReal: resolveWorktreeRoot(worktree),
      allowedCheckBinaries: ['/bin/false'], // /bin/echo is not in this list
      runConfined: fakeConfinedRunner(() => { invoked = true; return { status: 0, stdout: '', stderr: '', error: null }; }),
    })).toThrow(ProtectedCheckViolationError);
    expect(invoked).toBe(false);
  });
});

describe('verifyWorkerArtifact: digest-bound acceptance (pre+post), no auto-merge, dirty work retained (T-OG-04, T-OG-10)', () => {
  function echoCheck(id = 'echo-check') {
    return {
      id, command: '/bin/echo', args: ['ok'],
      runConfined: fakeConfinedRunner(() => ({ status: 0, stdout: 'ok\n', stderr: '', error: null })),
    };
  }

  it('accepts only when every protected check passes, binding acceptance to the exact artifact digest and reporting isolation', () => {
    const worktree = tmpWorktree();
    const artifact = path.join(worktree, 'final.json');
    writeFileSync(artifact, JSON.stringify({ type: 'result', result: { status: 'completed' } }));

    const verified = verifyWorkerArtifact({
      worktreeRoot: worktree, artifactPath: artifact,
      allowedCheckBinaries: ['/bin/echo'],
      checks: [echoCheck()],
    });

    expect(verified.status).toBe('accepted');
    expect(verified.artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verified.evidence).toHaveLength(1);
    expect(verified.isolation).toBeDefined();
    expect(Array.isArray(verified.isolation.degraded)).toBe(true);
  });

  it('a later edit to the artifact invalidates the digest the prior run accepted', () => {
    const worktree = tmpWorktree();
    const artifact = path.join(worktree, 'final.json');
    writeFileSync(artifact, 'version-1\n');
    const first = verifyWorkerArtifact({ worktreeRoot: worktree, artifactPath: artifact, checks: [] });
    writeFileSync(artifact, 'version-2-edited-after-acceptance\n');
    const second = verifyWorkerArtifact({ worktreeRoot: worktree, artifactPath: artifact, checks: [] });
    expect(first.artifactDigest).not.toBe(second.artifactDigest);
  });

  it('M3: rejects when the worktree tree changes DURING the checks, even though the single artifact file itself is untouched', () => {
    const worktree = tmpWorktree();
    const artifact = path.join(worktree, 'final.json');
    writeFileSync(artifact, 'ok\n');
    // Seed a real git repo so computeWorktreeTreeDigest has something to
    // bind to; the check itself plants a NEW file mid-run.
    spawnSync('git', ['init', '-q'], { cwd: worktree, timeout: 10000 });
    spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: worktree, timeout: 10000 });
    spawnSync('git', ['config', 'user.name', 'a'], { cwd: worktree, timeout: 10000 });
    spawnSync('git', ['add', '-A'], { cwd: worktree, timeout: 10000 });
    spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: worktree, timeout: 10000 });

    const mutatingCheck = {
      id: 'mutates-tree', command: '/bin/echo', args: ['ok'],
      runConfined: fakeConfinedRunner(() => {
        writeFileSync(path.join(worktree, 'planted-during-check.txt'), 'surprise\n');
        return { status: 0, stdout: 'ok\n', stderr: '', error: null };
      }),
    };

    const verified = verifyWorkerArtifact({
      worktreeRoot: worktree, artifactPath: artifact,
      allowedCheckBinaries: ['/bin/echo'],
      checks: [mutatingCheck],
    });

    expect(verified.status).toBe('rejected');
    expect(verified.findings.join(';')).toMatch(/tree digest changed during verification/);
  });

  it('M3: a clean run with no mutation computes a stable fd-walk tree digest across pre/post', () => {
    const worktree = tmpWorktree();
    const artifact = path.join(worktree, 'final.json');
    writeFileSync(artifact, 'ok\n');

    const verified = verifyWorkerArtifact({
      worktreeRoot: worktree, artifactPath: artifact,
      allowedCheckBinaries: ['/bin/echo'],
      checks: [echoCheck()],
    });
    expect(verified.status).toBe('accepted');
    expect(verified.treeDigest).toMatch(/^fd-tree:sha256:[a-f0-9]{64}$/);
  });

  it('M3 (round 2): computes a real digest without git — no longer null, no longer dependent on the worktree being a git repository at all', () => {
    const worktree = tmpWorktree();
    writeFileSync(path.join(worktree, 'plain.txt'), 'no git here\n');
    const digest = computeWorktreeTreeDigest(worktree);
    expect(digest).toMatch(/^fd-tree:sha256:[a-f0-9]{64}$/);
  });

  it('M3 (round 2): a digest computation failure REJECTS verification outright, never silently falls back to "unchanged"', () => {
    const worktree = tmpWorktree();
    const artifact = path.join(worktree, 'final.json');
    writeFileSync(artifact, 'ok\n');
    const unreadableDir = path.join(worktree, 'unreadable');
    mkdirSync(unreadableDir);
    writeFileSync(path.join(unreadableDir, 'secret.txt'), 'x\n');
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) {
      // DAC is not enforced for root; this specific failure mode (a
      // permission-denied directory) cannot be produced as root. Pure
      // logic (digest failure -> reject, never accept) is covered by the
      // no-git/empty-dir digest success case above and by
      // `verifyWorkerArtifact`'s explicit catch/reject wiring, which this
      // test cannot exercise meaningfully under root.
      return;
    }
    chmodSync(unreadableDir, 0o000);
    try {
      const verified = verifyWorkerArtifact({
        worktreeRoot: worktree, artifactPath: artifact,
        allowedCheckBinaries: ['/bin/echo'],
        checks: [echoCheck()],
      });
      expect(verified.status).toBe('rejected');
      expect(verified.findings.join(';')).toMatch(/tree digest \(pre-check\) could not be computed/);
    } finally {
      chmodSync(unreadableDir, 0o700);
    }
  });

  it('M3 (round 2): never shells out to git for the tree digest — a worker-planted filter/fsmonitor/hook never executes', () => {
    const worktree = tmpWorktree();
    spawnSync('git', ['init', '-q'], { cwd: worktree, timeout: 10000 });
    spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: worktree, timeout: 10000 });
    spawnSync('git', ['config', 'user.name', 'a'], { cwd: worktree, timeout: 10000 });
    writeFileSync(path.join(worktree, 'f.txt'), 'content\n');
    const marker = path.join(worktree, 'MARKER_FILTER_RAN');
    // A worker-controlled .git/config and .gitattributes that would run a
    // marker-writing command if (and only if) something invoked `git add`/
    // `git write-tree` with this worktree's own inherited config.
    const configAppend = `[core]\n\tfsmonitor = /bin/sh -c "touch ${marker}; echo 0"\n[filter "evil"]\n\tclean = /bin/sh -c "touch ${marker}; cat"\n`;
    const existingConfig = readFileSync(path.join(worktree, '.git', 'config'), 'utf8');
    writeFileSync(path.join(worktree, '.git', 'config'), existingConfig + configAppend);
    writeFileSync(path.join(worktree, '.gitattributes'), 'f.txt filter=evil\n');

    computeWorktreeTreeDigest(worktree);
    expect(existsSync(marker)).toBe(false);
  });

  it('M3 (round 2): a root swap-and-restore (root renamed away, an identical-looking replacement created at the same path) is rejected, even though content alone would match', () => {
    // Defense-in-depth: whenever at least one check runs, B2's own pinned-
    // cwd identity re-check (the check's cwd defaults to the worktree
    // root) ALSO independently detects this exact swap, because the cwd fd
    // is physically relocated along with the root rename. The DEDICATED
    // root-identity pin added for M3 (`pinRootIdentity`/
    // `assertRootIdentityUnchanged`, held open for the whole
    // `verifyWorkerArtifact` call) exists specifically for the case this
    // test cannot black-box-drive synchronously: zero protected checks
    // (no cwd ever gets pinned) racing an external/concurrent mutation of
    // the root between the pre- and post-check tree digests. Both layers
    // reject; this test asserts the externally-observable outcome
    // (rejected, never silently accepted as "unchanged") rather than
    // which specific internal layer fired first.
    const worktree = tmpWorktree();
    const artifact = path.join(worktree, 'final.json');
    const artifactContent = JSON.stringify({ type: 'result', result: { status: 'completed' } });
    writeFileSync(artifact, artifactContent);

    const swappedAway = `${worktree}-swapped-away`;
    roots.push(swappedAway);

    const verified = verifyWorkerArtifact({
      worktreeRoot: worktree, artifactPath: artifact,
      allowedCheckBinaries: ['/bin/echo'],
      checks: [{
        id: 'root-swap', command: '/bin/echo', args: ['ok'],
        runConfined: fakeConfinedRunner(() => {
          // Swap-and-restore: move the ORIGINAL root directory out of the
          // way, then create a brand-new directory at the SAME path with
          // byte-for-byte identical content. A content-only tree digest
          // cannot distinguish this from "nothing happened".
          renameSync(worktree, swappedAway);
          mkdirSync(worktree);
          writeFileSync(path.join(worktree, 'final.json'), artifactContent);
          return { status: 0, stdout: 'ok\n', stderr: '', error: null };
        }),
      }],
    });

    expect(verified.status).toBe('rejected');
    expect(verified.findings.join(';')).toMatch(/identity changed|root identity check failed|swap-and-restore/);
  });

  it('returns "blocked" (not "accepted" and not "rejected") when a check hits a sandbox/isolation failure, distinguishing infra noise from a real verdict', () => {
    const worktree = tmpWorktree();
    const artifact = path.join(worktree, 'final.json');
    writeFileSync(artifact, 'ok\n');
    const verified = verifyWorkerArtifact({
      worktreeRoot: worktree, artifactPath: artifact,
      allowedCheckBinaries: ['/bin/echo'],
      checks: [{
        id: 'isolation-unavailable', command: '/bin/echo', args: ['ok'],
        runConfined: fakeConfinedRunner(() => ({ status: null, stdout: '', stderr: '', error: { code: 'ISOLATION_UNAVAILABLE', message: 'degraded host' } })),
      }],
    });
    expect(verified.status).toBe('blocked');
    expect(verified.artifactDigest).toBeNull();
  });

  it('returns "rejected" when a real check fails', () => {
    const worktree = tmpWorktree();
    const artifact = path.join(worktree, 'final.json');
    writeFileSync(artifact, 'ok\n');
    const verified = verifyWorkerArtifact({
      worktreeRoot: worktree, artifactPath: artifact,
      allowedCheckBinaries: ['/bin/echo'],
      checks: [{
        id: 'real-fail', command: '/bin/echo', args: ['ok'],
        runConfined: fakeConfinedRunner(() => ({ status: 1, stdout: '', stderr: 'assertion mismatch\n', error: null })),
      }],
    });
    expect(verified.status).toBe('rejected');
  });

  it('rejects immediately on an artifact-path escape attempt without running any checks', () => {
    const worktree = tmpWorktree();
    const outside = tmpOutside();
    const secret = path.join(outside, 'secret.txt');
    writeFileSync(secret, 'nope\n');
    const link = path.join(worktree, 'escape.json');
    symlinkSync(secret, link);

    let ran = false;
    const verified = verifyWorkerArtifact({
      worktreeRoot: worktree, artifactPath: link,
      allowedCheckBinaries: ['/bin/echo'],
      checks: [{
        id: 'never-runs', command: '/bin/echo', args: ['ok'],
        runConfined: fakeConfinedRunner(() => { ran = true; return { status: 0, stdout: '', stderr: '', error: null }; }),
      }],
    });
    expect(ran).toBe(false);
    expect(verified.status).toBe('rejected');
  });

  it('never mutates the worktree: a rejected verification leaves the artifact and all files exactly as found (dirty work retained)', () => {
    const worktree = tmpWorktree();
    const artifact = path.join(worktree, 'final.json');
    const dirty = path.join(worktree, 'uncommitted.txt');
    writeFileSync(artifact, 'ok\n');
    writeFileSync(dirty, 'dirty worker output\n');
    verifyWorkerArtifact({
      worktreeRoot: worktree, artifactPath: artifact,
      allowedCheckBinaries: ['/bin/echo'],
      checks: [{
        id: 'real-fail', command: '/bin/echo', args: ['ok'],
        runConfined: fakeConfinedRunner(() => ({ status: 1, stdout: '', stderr: 'assertion mismatch\n', error: null })),
      }],
    });
    expect(existsSync(worktree)).toBe(true);
    expect(readFileSync(artifact, 'utf8')).toBe('ok\n');
    expect(readFileSync(dirty, 'utf8')).toBe('dirty worker output\n');
  });

  it('exposes no merge/integrate entry point: verification is read-only, and binding the verified digest elsewhere is a separate explicit step the caller owns', async () => {
    const moduleExports = await import('../../../tools/ralph-external/lib/trusted-verification.mjs');
    const mergeLike = Object.keys(moduleExports).filter(name => /merge|integrate|publish/i.test(name));
    expect(mergeLike).toEqual([]);
  });
});

describe('B1: confinement is live-probed, never assumed (skips when no systemd user manager is reachable)', () => {
  // This host's `systemd-run --user` cannot create the nested user
  // namespace `ReadOnlyPaths=`/`ReadWritePaths=` need (AppArmor
  // `unprivileged_userns` denies the CAP_SYS_ADMIN they require for
  // --user-manager units per systemd.exec(5)): write confinement is
  // measured, found degraded, and these tests assert the CORRECT response
  // to that finding (refuse by default, run only on explicit opt-in, and
  // always report it) rather than a false claim that writes are blocked.
  // On a host where the live probe finds EVERY required capability
  // enforced, the same tests assert the opposite, enforcing branch. Round
  // 2 (B1): the refusal gate now covers ALL of
  // `REQUIRED_VERIFICATION_CAPABILITIES` (write confinement, home-read
  // protection, network isolation) — not write confinement alone — so the
  // skip condition here must require ALL three, not just write. A host
  // where write happens to be enforced but home/network are not would
  // otherwise flake this suite: `runConfinedCheck` correctly refuses on
  // the missing home/network capability regardless of write, but a
  // write-only skip gate would let the "enforcing" branch run anyway and
  // see an unexpected `'sandbox'` classification instead of `'passed'`.
  const allRequiredEnforced = hasLiveIsolation
    && liveIsolation.writeConfinement === 'enforced'
    && liveIsolation.homeReadIsolation === 'enforced'
    && liveIsolation.networkIsolation === 'enforced';

  it('refuses to run a check at all when a required capability is not enforced and allowDegradedIsolation was not given (fail closed, never silently unconfined)', async context => {
    if (!hasLiveIsolation) { context.skip('no reachable systemd --user manager on this host'); return; }
    if (allRequiredEnforced) { context.skip('this host enforces every required capability; the refuse-by-default path is exercised on degraded hosts only'); return; }
    const worktree = tmpWorktree();
    const escapeTarget = path.join(homedir(), `.aiwg-b1-refused-${process.pid}.txt`);
    rmSync(escapeTarget, { force: true });
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    const outcome = runProtectedCheck({
      id: 'refused-by-default', command: '/bin/sh', args: ['-c', `echo should-not-run > ${JSON.stringify(escapeTarget)}`],
      worktreeRootReal, allowedCheckBinaries: ['/bin/sh'],
    });
    expect(outcome.classification).toBe('sandbox');
    expect(outcome.reason).toBe('ISOLATION_UNAVAILABLE');
    expect(existsSync(escapeTarget)).toBe(false);
    rmSync(escapeTarget, { force: true });
  }, 20000);

  it('on this degraded host, an explicit allowDegradedIsolation opt-in runs the check unconfined and the write succeeds — documented, never silent', async context => {
    if (!hasLiveIsolation) { context.skip('no reachable systemd --user manager on this host'); return; }
    if (allRequiredEnforced) { context.skip('this host enforces every required capability; nothing to demonstrate here'); return; }
    const worktree = tmpWorktree();
    const escapeTarget = path.join(homedir(), `.aiwg-b1-degraded-allowed-${process.pid}.txt`);
    rmSync(escapeTarget, { force: true });
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    const outcome = runProtectedCheck({
      id: 'explicit-degraded', command: '/bin/sh', args: ['-c', `echo allowed-degraded > ${JSON.stringify(escapeTarget)}`],
      worktreeRootReal, allowedCheckBinaries: ['/bin/sh'], allowDegradedIsolation: true,
    });
    expect(outcome.classification).toBe('passed');
    expect(existsSync(escapeTarget)).toBe(true);
    expect(outcome.isolation.degraded.some(entry => entry.capability === 'writeConfinement')).toBe(true);
    rmSync(escapeTarget, { force: true });
  }, 20000);

  it('on a host that enforces every required capability, a check cannot write outside the worktree, and CAN write inside it', async context => {
    if (!allRequiredEnforced) { context.skip('this host does not enforce every required capability; the enforcing-host branch is exercised elsewhere'); return; }
    const worktree = tmpWorktree();
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    const escapeTarget = path.join(homedir(), `.aiwg-b1-enforced-${process.pid}.txt`);
    rmSync(escapeTarget, { force: true });
    const outsideOutcome = runProtectedCheck({
      id: 'write-outside', command: '/bin/sh', args: ['-c', `echo should-not-land > ${JSON.stringify(escapeTarget)}`],
      worktreeRootReal, allowedCheckBinaries: ['/bin/sh'],
    });
    expect(existsSync(escapeTarget)).toBe(false);
    expect(outsideOutcome.classification).not.toBe('passed');

    const insideOutcome = runProtectedCheck({
      id: 'write-inside', command: '/bin/sh', args: ['-c', 'echo fine > ok.txt && cat ok.txt'],
      worktreeRootReal, cwd: worktree, allowedCheckBinaries: ['/bin/sh'],
    });
    expect(insideOutcome.classification).toBe('passed');
    expect(insideOutcome.stdout).toContain('fine');
  }, 20000);

  it('always reports this host\'s degraded isolation capabilities explicitly on the result, never silently claiming full isolation', async context => {
    if (!hasLiveIsolation) { context.skip('no reachable systemd --user manager on this host'); return; }
    const worktree = tmpWorktree();
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    const outcome = runProtectedCheck({
      id: 'degraded-visible', command: '/bin/echo', args: ['ok'],
      worktreeRootReal, allowedCheckBinaries: ['/bin/echo'], allowDegradedIsolation: true,
    });
    expect(['systemd-unit', 'degraded']).toContain(outcome.isolation.mode);
    // This is a reporting-shape assertion, not a claim about which specific
    // capabilities degrade on any given host: whatever the live probe found
    // degraded must show up here, unconditionally, never only on failure.
    expect(outcome.isolation.degraded).toEqual(liveIsolation.degraded);
  }, 20000);
});

describe('M3 (round 2): pinRootIdentity/assertRootIdentityUnchanged in isolation from B2 (the dedicated no-check-ran / external-race case)', () => {
  it('passes cleanly when nothing touches the root between pin and re-check', () => {
    const worktree = tmpWorktree();
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    const pinned = pinRootIdentity(worktreeRootReal);
    try {
      expect(() => assertRootIdentityUnchanged(pinned, worktreeRootReal)).not.toThrow();
    } finally {
      closeSync(pinned.fd);
    }
  });

  it('detects a root rename-and-replace with NO check in between (the scenario B2 cannot see because no cwd was ever pinned)', () => {
    const worktree = tmpWorktree();
    const worktreeRootReal = resolveWorktreeRoot(worktree);
    const pinned = pinRootIdentity(worktreeRootReal);
    const swappedAway = `${worktree}-direct-swap-away`;
    roots.push(swappedAway);
    try {
      // Nothing resembling a "check" ran here at all -- this directly
      // exercises the dedicated root pin/re-check pair, independent of
      // `runProtectedCheck`'s own (B2) cwd pinning.
      renameSync(worktree, swappedAway);
      mkdirSync(worktree);
      expect(() => assertRootIdentityUnchanged(pinned, worktreeRootReal)).toThrow(WorktreeEscapeError);
      expect(() => assertRootIdentityUnchanged(pinned, worktreeRootReal)).toThrow(/swap-and-restore detected/);
    } finally {
      closeSync(pinned.fd);
    }
  });
});

describe('M2: mount-boundary crossing is refused (root-only: creating a bind mount needs privilege)', () => {
  it('refuses a worktree root that has a nested mount point underneath it (resolveWorktreeRoot itself detects it)', async context => {
    if (process.getuid?.() !== 0) { context.skip('requires root to create a bind mount for this probe'); return; }
    const worktree = tmpWorktree();
    const mounted = path.join(worktree, 'mounted-elsewhere');
    mkdirSync(mounted);
    const source = tmpOutside();
    const mount = spawnSync('mount', ['--bind', source, mounted], { timeout: 10000 });
    if (mount.status !== 0) { context.skip(`bind mount unavailable in this environment: ${String(mount.stderr)}`); return; }
    try {
      // CI fix (round 2): when bind-mounting succeeds (always true as
      // root), `resolveWorktreeRoot` ITSELF throws (via
      // `assertNoNestedMounts`) because the worktree now has a nested
      // mount point underneath it. The throw must be INSIDE this
      // `expect(...).toThrow(...)` — the previous version called
      // `resolveWorktreeRoot` above/outside the `expect`, so the throw
      // escaped uncaught and the privileged branch of this test always
      // failed instead of exercising the denial it meant to assert.
      expect(() => resolveWorktreeRoot(worktree)).toThrow(/nested mount/);
    } finally {
      spawnSync('umount', [mounted], { timeout: 10000 });
    }
  });

  it('refuses a path that crosses a mount boundary via st_dev, independent of the nested-mount check above (root-only)', async context => {
    if (process.getuid?.() !== 0) { context.skip('requires root to create a bind mount for this probe'); return; }
    const worktree = tmpWorktree();
    const mounted = path.join(worktree, 'mounted-elsewhere');
    mkdirSync(mounted);
    const source = tmpOutside();
    const mount = spawnSync('mount', ['--bind', source, mounted], { timeout: 10000 });
    if (mount.status !== 0) { context.skip(`bind mount unavailable in this environment: ${String(mount.stderr)}`); return; }
    try {
      // Bypass `resolveWorktreeRoot`'s nested-mount gate deliberately here
      // (tested above) to exercise the SEPARATE `st_dev`-mismatch check
      // inside `openPinnedWithinWorktree`/`assertWithinWorktree` on its
      // own — proving that mechanism independently denies the crossing,
      // not just the nested-mount pre-check.
      const worktreeRootReal = realpathSync(worktree);
      expect(() => assertWithinWorktree(worktreeRootReal, mounted)).toThrow(/different filesystem|mount/);
    } finally {
      spawnSync('umount', [mounted], { timeout: 10000 });
    }
  });
});

describe('#2889 conductor adjudication: mount table checks are decoded and fail closed', () => {
  const line = (mountPoint: string) => `36 25 0:32 / ${mountPoint} rw,relatime shared:1 - ext4 /dev/x rw`;
  it('detects a nested mount whose mount point the kernel octal-escaped', () => {
    const root = '/worker space';
    const mountinfo = [line('/'), line('/worker\\040space/mounted')].join('\n');
    expect(() => assertNoNestedMounts(root, { mountinfoText: mountinfo })).toThrow(/nested mount/);
  });
  it('decodes tab, newline and backslash escapes too', () => {
    for (const [raw, decoded] of [['\\011', '\t'], ['\\012', '\n'], ['\\134', '\\']]) {
      const root = `/w${decoded}x`;
      expect(() => assertNoNestedMounts(root, { mountinfoText: line(`/w${raw}x/m`) })).toThrow(/nested mount/);
    }
  });
  it('accepts a mount table with no mount under the root', () => {
    expect(() => assertNoNestedMounts('/worker space', { mountinfoText: [line('/'), line('/other\\040dir')].join('\n') })).not.toThrow();
  });
});
