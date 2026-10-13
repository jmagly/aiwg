/**
 * Confinement for Tier 0 trusted verification checks (#2889 B1,
 * FR-OG-039/042/068). Extends the #2954/#2888 worker-isolation path
 * (`worker-isolation.mjs`) with the extra `systemd-run --user` properties a
 * *verification* check needs: checks execute worker-controlled code (the
 * worker's own tests, `vitest`/`tsconfig` configs, Makefiles, cwd-relative
 * runners) so they must never run with the conductor's full filesystem and
 * network access or an exposed `HOME`.
 *
 * This host (and, empirically, any Ubuntu host with
 * `kernel.apparmor_restrict_unprivileged_userns=1`, confirmed via
 * `dmesg`/`audit` showing `apparmor="DENIED" ... capability=21 sys_admin
 * profile=unprivileged_userns` on every `systemd-run --user` invocation)
 * cannot create the nested user namespace `systemd-run --user` wants for
 * namespace-creating confinement (`ProtectHome=`, `PrivateTmp=`,
 * `PrivateNetwork=`, `InaccessiblePaths=`, `TemporaryFileSystem=`): all five
 * silently no-op (`ProtectHome`/`PrivateTmp`/`InaccessiblePaths`) or log a
 * single degrade line and continue unconfined (`PrivateNetwork`) rather than
 * failing the unit. Only confinement implemented as a *remount* of an
 * already-mounted filesystem — `ReadOnlyPaths=`/`ReadWritePaths=`,
 * `NoNewPrivileges=`, and `PrivateUsers=`'s self-only uid map — is enforced
 * here without that extra privilege. `probeVerificationIsolationCapabilities`
 * never trusts that distinction from memory: it live-probes every property
 * on first use so a different host or a kernel/policy change is reflected
 * automatically instead of silently assumed.
 *
 * Round-2 fail-closed hardening (#2889 B1 CRITICAL): the probe is
 * fail-closed end to end. A probe spawn error, non-zero exit, timeout, or
 * ANY missing/ambiguous output field means the WHOLE probe is treated as
 * failed — every capability is reported `degraded`, nothing is cached, and
 * `runConfinedCheck` refuses to launch unless the caller explicitly opts
 * into degraded isolation. Every capability this module claims `enforced`
 * is positively demonstrated from OUTSIDE the probe unit, after it has
 * exited, never from the unit's own self-reported exit code alone: a write
 * sentinel outside the allowed paths must be observably ABSENT on the real
 * host filesystem after the unit ends (not merely "the shell said the write
 * failed"), and network isolation additionally requires the probe to have
 * positively confirmed it ran to completion (the `DONE` marker below) before
 * its reported network namespace id is trusted at all. The capability cache
 * has a short TTL (re-measured well within a single conductor run, but
 * never cached across a changing kernel/policy for the life of a long
 * process) and is invalidated immediately on any probe failure, never
 * reused stale. It is additionally keyed to the exact set of systemd
 * properties this probe exercises (`PROBE_PROFILE_KEY`), so a future change
 * to that set can never silently reuse an now-unrelated cached result.
 *
 * Given that split, this module's `runConfinedCheck` enforces EVERY
 * required capability (write confinement, home-read protection, and network
 * isolation — not write confinement alone) and reports every capability it
 * could not additionally enforce — most importantly, that readable paths
 * outside the worktree and home/tmp trees remain visible — as an
 * explicit, structured `degraded` list on every result. A launch requests
 * EXACTLY the systemd properties this host's live probe just proved
 * (`buildVerificationExtraProperties`): `ProtectHome=`, `PrivateTmp=`, and
 * `PrivateNetwork=` are each included only when their own probed capability
 * came back `enforced`, never requested unconditionally and never silently
 * omitted when they ARE available. Nothing is ever silently claimed
 * "isolated" when it is not: callers decide whether a degraded run is
 * acceptable (`allowDegradedIsolation: true`, a strict boolean — a string
 * `"false"` or any other truthy-but-not-`true` value is treated as `false`
 * and still refuses); the default is to refuse to run the check at all when
 * the per-host probe shows a required capability is unavailable.
 *
 * One more host-specific gap the live probe measures separately
 * (`tmpWriteConfinement`, never folded into `writeConfinement` and never
 * part of the REQUIRED set `runConfinedCheck` refuses on): on this host,
 * `systemd-run --user` leaves `/tmp` and `/var/tmp` writable EVERYWHERE,
 * not just inside the worktree/output-directory allow-list, regardless of
 * an explicit `ReadOnlyPaths=/tmp`/`ReadOnlyPaths=/var/tmp`.
 * `systemd.exec(5)` ties that specific lock-down to `PrivateTmp=` actually
 * engaging (which, per the same AppArmor restriction, it does not here);
 * every other path on the same filesystem (confirmed with `/opt`, `/srv`,
 * `/home`, `/var` directly) IS correctly confined. A worktree created
 * under a real repository checkout (the normal case — see
 * `worktree-preparation.mjs`) is unaffected; only a worktree or output
 * directory placed under `/tmp`/`/var/tmp` inherits this specific gap, and
 * it is reported, never assumed away.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildWorkerIsolationArgs,
  detectWorkerIsolation,
  resolveManagerEnvNames,
} from './worker-isolation.mjs';
import { buildSystemdClientEnv, resolveSystemdRun } from './systemd-client.mjs';

let cachedCapabilities;

/** Reset the process-lifetime capability cache. Test-only. */
export function resetVerificationIsolationCapabilityCache() {
  cachedCapabilities = undefined;
}

// Short TTL: long enough that a normal conductor run (many checks across one
// or a few verification passes) does not re-probe every call, short enough
// that a long-running process never trusts a kernel/AppArmor-policy change
// (or a one-off probe flake) for more than a few minutes.
const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;

// The exact systemd properties this probe exercises, used only to key the
// cache (see module doc comment): if a future change to this list is made
// without also bumping this key, the stale cache is used instead of being
// silently (and wrongly) treated as still valid for a DIFFERENT probe.
const PROBE_PROFILE_KEY = [
  'NoNewPrivileges=yes', 'ProtectHome=tmpfs', 'PrivateTmp=yes',
  'PrivateUsers=yes', 'PrivateNetwork=yes', 'ReadOnlyPaths=/', 'ReadWritePaths=<scratch>',
].join('|');

// Every capability a launch REQUIRES before it will proceed without an
// explicit `allowDegradedIsolation` opt-in (B1: "the refusal covers EVERY
// required capability ... not just write"). `tmpIsolation`/
// `tmpWriteConfinement`/`noNewPrivileges`/`arbitraryPathReadIsolation` are
// real, separately reported findings but are NOT required for launch —
// they are documented, known-degraded gaps on this host class (see module
// doc comment) that a caller may still accept as part of the overall
// degraded picture without blocking every launch outright.
export const REQUIRED_VERIFICATION_CAPABILITIES = ['writeConfinement', 'homeReadIsolation', 'networkIsolation'];

/** Which of `REQUIRED_VERIFICATION_CAPABILITIES` are NOT `'enforced'` on `capabilities`. */
export function missingRequiredCapabilities(capabilities) {
  if (!capabilities || capabilities.mode !== 'systemd-unit') return [...REQUIRED_VERIFICATION_CAPABILITIES];
  return REQUIRED_VERIFICATION_CAPABILITIES.filter(name => capabilities[name] !== 'enforced');
}

function runProbeUnit({ spawn, argv }) {
  return spawn(resolveSystemdRun(), argv.slice(1), { encoding: 'utf8', timeout: 20000, env: buildSystemdClientEnv({ envNames: [] }) });
}

function fullyDegradedResult(reason) {
  return {
    mode: 'systemd-unit',
    reason,
    writeConfinement: 'degraded',
    tmpWriteConfinement: 'degraded',
    noNewPrivileges: 'degraded',
    homeReadIsolation: 'degraded',
    tmpIsolation: 'degraded',
    networkIsolation: 'degraded',
    arbitraryPathReadIsolation: 'degraded',
    degraded: [{ capability: 'probe', reason }],
  };
}

const PROBE_REQUIRED_FIELDS = [
  'NONEWPRIVS', 'NETNS', 'HOMECOUNT', 'TMPMARK',
  'SCRATCHWRITE', 'TMPWRITE', 'VARTMPWRITE', 'HOMEWRITE', 'DONE',
];

/**
 * Live-probe which confinement properties this host's `systemd-run --user`
 * actually enforces, rather than assuming from a fixed list. Runs ONE
 * combined throwaway unit (bounded, single call — `tool-quota`) that
 * exercises each property against disposable fixtures it creates and tears
 * down itself; nothing it touches is a real secret or a real worktree.
 *
 * Fail-closed (B1): a probe spawn error, non-zero exit, or any missing
 * expected output field means the probe is treated as having failed
 * entirely — every capability comes back `degraded` with a `probe`-level
 * reason, and the result is NOT cached (so the very next call re-probes
 * rather than wedging on a transient failure). A successful probe is
 * cached for `CAPABILITY_CACHE_TTL_MS` and keyed to `PROBE_PROFILE_KEY`;
 * pass `force: true` to bypass the cache outright (tests only).
 */
export function probeVerificationIsolationCapabilities({ spawn = spawnSync, force = false } = {}) {
  if (cachedCapabilities && !force) {
    const fresh = Date.now() - cachedCapabilities._probedAt < CAPABILITY_CACHE_TTL_MS;
    const sameProfile = cachedCapabilities._profileKey === PROBE_PROFILE_KEY;
    if (fresh && sameProfile) return cachedCapabilities;
    cachedCapabilities = undefined;
  }

  const detected = detectWorkerIsolation({ spawn });
  if (detected.mode !== 'systemd-unit') {
    const result = {
      mode: 'degraded',
      reason: detected.reason,
      writeConfinement: 'degraded',
      tmpWriteConfinement: 'degraded',
      noNewPrivileges: 'degraded',
      homeReadIsolation: 'degraded',
      tmpIsolation: 'degraded',
      networkIsolation: 'degraded',
      arbitraryPathReadIsolation: 'degraded',
      degraded: [{ capability: 'systemd-unit', reason: detected.reason }],
    };
    // This is a durable, legitimate finding (no systemd user manager at
    // all), not a probe failure -- caching it avoids re-shelling out to
    // `systemd-run --version`/`systemctl --user show` on every call.
    cachedCapabilities = { ...result, _probedAt: Date.now(), _profileKey: PROBE_PROFILE_KEY };
    return cachedCapabilities;
  }

  // B1: a failed/ambiguous host-netns lookup must never be read as "the
  // probe's reported namespace differs, so isolation is enforced" -- fail
  // the WHOLE probe closed rather than comparing against an empty/unknown
  // baseline.
  let hostNetNs;
  try {
    hostNetNs = spawn('readlink', ['/proc/self/ns/net'], { encoding: 'utf8', timeout: 5000 });
  } catch (error) {
    return fullyDegradedResult(`could not determine this host's own network namespace: ${error.message}`);
  }
  if (hostNetNs.error || hostNetNs.status !== 0) {
    return fullyDegradedResult(`could not determine this host's own network namespace: ${hostNetNs.error?.message ?? `readlink exited ${hostNetNs.status}`}`);
  }
  const hostNetNsId = String(hostNetNs.stdout ?? '').trim();
  if (!hostNetNsId) {
    return fullyDegradedResult('host network namespace lookup returned no output');
  }

  // A disposable scratch directory stands in for a real worktree/output
  // directory, exercising the exact same `ReadOnlyPaths=/`+`ReadWritePaths=`
  // pair `buildVerificationExtraProperties` builds for a real check — so
  // this probe measures the real mechanism, not a simplified stand-in.
  //
  // Uniqueness note: `process.pid` is identical across Vitest worker
  // THREADS (they share one OS process), so two test files running
  // concurrent live probes with `${process.pid}`-only escape-sentinel
  // names raced each other's writes/cleanup of the SAME host path — one
  // probe's cleanup could delete another concurrent probe's still-pending
  // sentinel, producing a flaky "enforced" reading for `writeConfinement`/
  // `tmpWriteConfinement` that depends on nothing but scheduling luck.
  // `mkdtempSync` already gives the scratch directory a unique name; the
  // escape-sentinel filenames and the systemd unit name get an explicit
  // random suffix for the same reason a `systemd-run --unit=` name must
  // also never collide across concurrent probes.
  const probeNonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const scratchDir = mkdtempSync(path.join(tmpdir(), 'aiwg-verify-probe-scratch-'));
  const escapeOutsideScratchButInTmp = path.join(tmpdir(), `aiwg-verify-probe-tmp-escape-${probeNonce}`);
  const escapeInVarTmp = path.join('/var/tmp', `aiwg-verify-probe-vartmp-escape-${probeNonce}`);
  const escapeInHome = path.join(homedir(), `.aiwg-verify-probe-home-escape-${probeNonce}`);
  rmSync(escapeOutsideScratchButInTmp, { force: true });
  rmSync(escapeInVarTmp, { force: true });
  rmSync(escapeInHome, { force: true });

  const cleanupScratchFixtures = () => {
    try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(escapeOutsideScratchButInTmp, { force: true }); } catch { /* best effort */ }
    try { rmSync(escapeInVarTmp, { force: true }); } catch { /* best effort */ }
    try { rmSync(escapeInHome, { force: true }); } catch { /* best effort */ }
  };

  const unit = `aiwg-verify-isolation-probe-${probeNonce}`;
  // B1: the probe no longer deletes its own /tmp marker from INSIDE the
  // unit (`rm -f "$MARK"` used to run before the conductor ever looked at
  // it, which meant the marker was always gone by the time the degraded
  // check below ran — a host where PrivateTmp is degraded and the write
  // landed on the REAL /tmp would still read back "enforced" because the
  // unit had already erased the only evidence of its own failure). Cleanup
  // of any marker that DID leak onto the real host /tmp now happens only
  // from OUTSIDE, after the unit has exited, by this function itself.
  const argv = ['systemd-run', '--user', '--pipe', '--wait', '--quiet', `--unit=${unit}`,
    '-p', 'NoNewPrivileges=yes', '-p', 'ProtectHome=tmpfs', '-p', 'PrivateTmp=yes',
    '-p', 'PrivateUsers=yes', '-p', 'PrivateNetwork=yes',
    '-p', 'ReadOnlyPaths=/', '-p', `ReadWritePaths=${scratchDir}`,
    '--', '/bin/sh', '-c',
    'echo NONEWPRIVS:$(grep -c "NoNewPrivs:\\s1" /proc/self/status);' +
    'echo NETNS:$(readlink /proc/self/ns/net);' +
    'echo HOMECOUNT:$(ls -A "$HOME" 2>/dev/null | wc -l);' +
    'MARK=/tmp/aiwg-verify-probe-$$; echo x > "$MARK" 2>/dev/null; echo TMPMARK:$MARK;' +
    `(echo x > '${scratchDir}/ok') 2>/dev/null; echo SCRATCHWRITE:$?;` +
    `(echo x > '${escapeOutsideScratchButInTmp}') 2>/dev/null; echo TMPWRITE:$?;` +
    `(echo x > '${escapeInVarTmp}') 2>/dev/null; echo VARTMPWRITE:$?;` +
    `(echo x > '${escapeInHome}') 2>/dev/null; echo HOMEWRITE:$?;` +
    'echo DONE:1'];

  let result;
  try {
    result = runProbeUnit({ spawn, argv });
  } catch (error) {
    cleanupScratchFixtures();
    return fullyDegradedResult(`probe unit could not be spawned: ${error.message}`);
  }
  // B1: a spawn-level error, timeout (ETIMEDOUT leaves `status: null`), or
  // non-zero exit means we got nothing trustworthy -- never parse partial
  // stdout from a probe that did not cleanly finish.
  if (result.error || result.status !== 0) {
    cleanupScratchFixtures();
    const reason = result.error
      ? `probe unit failed to run: ${result.error.code ?? result.error.message}`
      : `probe unit exited ${result.status}`;
    return fullyDegradedResult(reason);
  }

  const stdout = String(result.stdout ?? '');
  const fields = {};
  for (const line of stdout.split('\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    fields[line.slice(0, index)] = line.slice(index + 1);
  }

  // B1: a timed-out or otherwise truncated probe can still exit 0 with
  // partial output (e.g. the pipe closed mid-write); require every expected
  // field to be present before trusting ANY of them, rather than letting
  // missing fields silently default into "enforced" one at a time.
  const missingFields = PROBE_REQUIRED_FIELDS.filter(name => fields[name] === undefined);
  if (missingFields.length > 0) {
    cleanupScratchFixtures();
    return fullyDegradedResult(`probe output incomplete (missing: ${missingFields.join(', ')}); refusing to trust a partial probe`);
  }

  const degraded = [];
  const noNewPrivileges = fields.NONEWPRIVS === '1' ? 'enforced' : 'degraded';
  if (noNewPrivileges === 'degraded') degraded.push({ capability: 'noNewPrivileges', reason: 'NoNewPrivs was not set to 1 inside the probe unit' });

  // B1: network isolation is positively shown by (a) the probe having
  // positively confirmed it ran to completion (the DONE marker, checked
  // above as part of "every field present") and (b) the probe's own
  // reported namespace id actually differing from the HOST's own id, which
  // was independently resolved (and error-checked) above.
  const networkIsolation = fields.NETNS !== hostNetNsId ? 'enforced' : 'degraded';
  if (networkIsolation === 'degraded') degraded.push({ capability: 'networkIsolation', reason: `PrivateNetwork=yes did not change the net namespace (host: ${hostNetNsId}, probe: ${fields.NETNS}); this host's AppArmor policy denies the CAP_SYS_ADMIN unprivileged-userns needs to create one` });

  // A real $HOME is never empty on a developer/CI host; ProtectHome=tmpfs
  // enforced would make it 0 (a fresh empty tmpfs). Any positive count means
  // the real HOME directory is still visible.
  const homeCount = Number(fields.HOMECOUNT);
  const homeReadIsolation = Number.isFinite(homeCount) && homeCount === 0 ? 'enforced' : 'degraded';
  if (homeReadIsolation === 'degraded') degraded.push({ capability: 'homeReadIsolation', reason: `ProtectHome=tmpfs did not hide $HOME (still ${fields.HOMECOUNT ?? 'unknown'} entries visible); same AppArmor unprivileged-userns restriction` });

  // B1: PrivateTmp enforced is now positively demonstrated from OUTSIDE,
  // after the unit has exited: the marker the probe wrote under its own
  // /tmp must be ABSENT from the real host /tmp. The unit no longer deletes
  // it itself (see argv comment above), so this is the first and only
  // place it is removed.
  const tmpMarkerPath = fields.TMPMARK;
  const tmpMarkerLeaked = existsSync(tmpMarkerPath);
  const tmpIsolation = tmpMarkerLeaked ? 'degraded' : 'enforced';
  if (tmpMarkerLeaked) {
    degraded.push({ capability: 'tmpIsolation', reason: 'PrivateTmp=yes did not isolate /tmp: the probe\'s own tmp marker was visible on the real host /tmp after the unit exited' });
    try { rmSync(tmpMarkerPath, { force: true }); } catch { /* best effort cleanup of the leaked marker */ }
  }

  // ProtectHome/PrivateTmp hide their trees; ReadOnlyPaths=/ leaves other reads visible.
  const arbitraryPathReadIsolation = 'degraded';
  degraded.push({ capability: 'arbitraryPathReadIsolation', reason: 'the verification profile does not confine reads to the worktree and output directory: ProtectHome/PrivateTmp hide only home and temporary paths, and ReadOnlyPaths=/ prevents writes but leaves other readable host paths accessible' });

  // B1: writeConfinement is positively demonstrated from OUTSIDE, after
  // the unit exits, on BOTH sides: the allow-listed scratch write must be
  // observably present (the mechanism actually works, not merely "the
  // shell said exit 0"), and the disallowed $HOME write must be observably
  // ABSENT (not merely "the shell said it failed"). A missing/ambiguous
  // self-reported exit code (`fields.SCRATCHWRITE`/`HOMEWRITE`) is already
  // ruled out above (every field is required to be present), so these are
  // now a secondary corroborating signal, never the sole evidence.
  const scratchWriteLanded = existsSync(path.join(scratchDir, 'ok'));
  const homeWriteLeaked = existsSync(escapeInHome);
  const writeConfinement = (scratchWriteLanded && !homeWriteLeaked) ? 'enforced' : 'degraded';
  if (!scratchWriteLanded) degraded.push({ capability: 'writeConfinement', reason: 'the ReadWritePaths= allow-list itself did not work: the write inside the granted scratch directory was not observed to land (checked from outside the unit)' });
  if (homeWriteLeaked) degraded.push({ capability: 'writeConfinement', reason: 'ReadOnlyPaths=/ did not block a write to an ordinary path outside the allow-list ($HOME): the sentinel was observed to exist after the unit exited' });

  const tmpWriteLeaked = existsSync(escapeOutsideScratchButInTmp);
  const varTmpWriteLeaked = existsSync(escapeInVarTmp);
  const tmpWriteConfinement = (!tmpWriteLeaked && !varTmpWriteLeaked) ? 'enforced' : 'degraded';
  if (tmpWriteLeaked) degraded.push({ capability: 'tmpWriteConfinement', reason: '/tmp is writable outside the designated worktree/output-directory allow-list regardless of ReadOnlyPaths=/ (systemd exempts /tmp from path-based confinement unless PrivateTmp= is actually functioning, which it is not on this host)' });
  if (varTmpWriteLeaked) degraded.push({ capability: 'tmpWriteConfinement', reason: '/var/tmp is writable outside the designated worktree/output-directory allow-list, for the same reason as /tmp' });

  cleanupScratchFixtures();

  cachedCapabilities = {
    mode: 'systemd-unit',
    reason: detected.reason,
    writeConfinement,
    tmpWriteConfinement,
    noNewPrivileges,
    homeReadIsolation,
    tmpIsolation,
    networkIsolation,
    arbitraryPathReadIsolation,
    degraded,
    _probedAt: Date.now(),
    _profileKey: PROBE_PROFILE_KEY,
  };
  return cachedCapabilities;
}

/**
 * Build the extra confinement properties `runConfinedCheck` always requests.
 * B1: a launch requests EXACTLY the property set the live probe just
 * proved — never a fixed list assumed from memory. `NoNewPrivileges=`/
 * `PrivateUsers=` are requested unconditionally because they are pure
 * remounts/uid-map restrictions that can only narrow privilege (never grant
 * it) and are the two properties this host's AppArmor policy does NOT deny
 * (see module doc comment); `ReadOnlyPaths=`/`ReadWritePaths=`,
 * `ProtectHome=tmpfs`, `PrivateTmp=yes`, and `PrivateNetwork=yes` are each
 * included only when `capabilities` shows the matching capability
 * `'enforced'` on THIS host, so a degraded property is never requested as
 * if it worked.
 */
export function buildVerificationExtraProperties({ worktreeRootReal, outputDirReal, readWritePaths = [], capabilities } = {}) {
  if (typeof worktreeRootReal !== 'string' || worktreeRootReal.length === 0) {
    throw new Error('buildVerificationExtraProperties requires worktreeRootReal');
  }
  if (!capabilities || typeof capabilities !== 'object') {
    throw new Error('buildVerificationExtraProperties requires the live-probed capabilities, so a launch only requests what this host actually proved');
  }
  const properties = ['NoNewPrivileges=yes', 'PrivateUsers=yes'];
  if (capabilities.writeConfinement === 'enforced') {
    properties.push('ReadOnlyPaths=/', `ReadWritePaths=${worktreeRootReal}`);
    if (outputDirReal) properties.push(`ReadWritePaths=${outputDirReal}`);
    for (const extra of readWritePaths) properties.push(`ReadWritePaths=${extra}`);
  }
  if (capabilities.homeReadIsolation === 'enforced') properties.push('ProtectHome=tmpfs');
  if (capabilities.tmpIsolation === 'enforced') properties.push('PrivateTmp=yes');
  if (capabilities.networkIsolation === 'enforced') properties.push('PrivateNetwork=yes');
  return properties;
}

/**
 * Run one check confined through `systemd-run --user` with the properties
 * this host actually enforces, `--pipe --wait` so stdout/stderr/exit code
 * return synchronously exactly like a plain `spawnSync` result.
 *
 * Returns `{ status, stdout, stderr, error, isolation }`. `isolation`
 * carries the mode and the full degraded-capability list from
 * `probeVerificationIsolationCapabilities` on every call — including
 * accepted/passed ones — so a caller can never mistake "the check passed"
 * for "the check was fully isolated."
 *
 * B1: the refusal-by-default gate now covers EVERY capability in
 * `REQUIRED_VERIFICATION_CAPABILITIES` (write confinement, home-read
 * protection, network isolation) — not write confinement alone. When this
 * host cannot even reach a systemd user manager, OR any required
 * capability is not `'enforced'`, the check is refused (`{ status: null,
 * error: {code: 'ISOLATION_UNAVAILABLE'}, isolation }`) unless
 * `allowDegradedIsolation` is the strict boolean `true` — a string
 * `"false"`, `1`, or any other truthy-but-not-literally-`true` value is
 * treated as `false` and still refuses, closing the JS-truthiness gap where
 * `!allowDegradedIsolation` would have let a stray `"false"` string through
 * as if it were an explicit opt-in. Refusing by default here — rather than
 * launching through `systemd-run` anyway and trusting its properties
 * silently no-op into a pass-through — is deliberate: a caller must
 * explicitly accept running genuinely unconfined, never discover it only
 * after reading `isolation.degraded`.
 */
export function runConfinedCheck({
  command,
  args = [],
  cwd,
  worktreeRootReal,
  outputDirReal,
  envNames = ['PATH', 'HOME'],
  env = process.env,
  timeoutMs = 60000,
  spawn = spawnSync,
  allowDegradedIsolation = false,
} = {}) {
  const capabilities = probeVerificationIsolationCapabilities({ spawn });
  const isolation = { mode: capabilities.mode, degraded: capabilities.degraded };
  const missingRequired = missingRequiredCapabilities(capabilities);
  const confinementUnavailable = capabilities.mode !== 'systemd-unit' || missingRequired.length > 0;
  const degradedOptIn = allowDegradedIsolation === true;

  if (confinementUnavailable) {
    if (!degradedOptIn) {
      const reason = capabilities.mode !== 'systemd-unit'
        ? capabilities.reason
        : `required confinement capabilities are not enforced on this host for systemd --user units: ${missingRequired.join(', ')}`;
      return { status: null, stdout: '', stderr: '', error: { code: 'ISOLATION_UNAVAILABLE', message: reason }, isolation };
    }
    // HIGH m2 regression (round 2): a degraded launch has no systemd unit
    // to isolate the environment, so it MUST build its own allowlisted
    // environment and pass it as the child's *entire* environment (the
    // `env` option REPLACES, never merges with, the current process
    // environment — the functional equivalent of `env -i NAME=value ...`,
    // matching `worker-isolation.mjs`'s `launchIsolatedWorker` degraded
    // path). The previous version forwarded `env` (defaulting to
    // `process.env`, the conductor's FULL environment, secrets included)
    // straight into worker-controlled check code — confirmed by an
    // unlisted synthetic secret surviving into the degraded child's
    // environment. Only names present in `envNames` ever cross this
    // boundary now, exactly like the confined (`systemd-unit`) path's own
    // `--setenv=` allowlist.
    const allowedEnv = {};
    for (const name of envNames) {
      const value = env?.[name];
      if (value !== undefined) allowedEnv[name] = value;
    }
    const result = spawn(command, args, { cwd, env: allowedEnv, encoding: 'utf8', timeout: timeoutMs });
    return { ...result, isolation };
  }

  let managerEnvNames, systemdRun;
  try {
    managerEnvNames = resolveManagerEnvNames({ spawn });
    systemdRun = resolveSystemdRun();
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error: { code: 'ISOLATION_UNAVAILABLE', message: `unable to resolve the user manager's environment or trusted systemd-run client: ${error.message}` }, isolation };
  }

  const unit = `aiwg-verify-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const extraProperties = buildVerificationExtraProperties({ worktreeRootReal, outputDirReal, capabilities });
  const argv = buildWorkerIsolationArgs({
    unit, memoryMax: '2G', command, args, cwd, env, envNames, managerEnvNames,
    kind: 'unit', extraProperties, pipe: true, wait: true,
  });
  const result = spawn(systemdRun, argv.slice(1), { encoding: 'utf8', timeout: timeoutMs, env: buildSystemdClientEnv({ env, envNames }) });
  return { ...result, isolation };
}
