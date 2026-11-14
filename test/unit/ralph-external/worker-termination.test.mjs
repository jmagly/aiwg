// Synthetic containment evidence exercises the real launcher and retry gate.
import { trackWorkerProcess, trackWorkerPidFile } from '../../fixtures/ralph-external/worker-process-inventory.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { inspectWorkerPath } from '../../../src/serve/worker-invocation-paths.js';
import { SessionLauncher, verifyRetryPredecessor } from '../../../tools/ralph-external/session-launcher.mjs';
import { resolveRetryReference } from '../../../tools/ralph-external/lib/worker-launch-cli.mjs';
import { observeWorkerTermination, recheckWorkerTermination, sampleGroupStates } from '../../../tools/ralph-external/lib/worker-termination.mjs';
import { getWorkerIsolationStatus } from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import { sampleWorkerIdentity } from '../../../tools/ralph-external/process-monitor.mjs';
import { systemdClientFixture } from '../../fixtures/systemd-client.js';
import { buildWorkerInvocationEnvironment, scanWorkerInvocationProcesses, WORKER_INVOCATION_MARKER } from '../../../tools/ralph-external/lib/worker-invocation-processes.mjs';
import * as fs from 'node:fs';

const roots = [], descendants = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const pid of descendants.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(mode = 'degraded', scenario = 'empty', recovery = true, ownedGroup = false) {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-termination-')); roots.push(root);
  const work = join(root, 'work'); await mkdir(work);
  const brief = join(root, 'brief'); await writeFile(brief, 'Synthetic termination task.');
  const f = workerResolutionFixture();
  f.snapshot.config.parallelism.health = { hardTimeoutSeconds: 10, terminateGraceSeconds: 1 };
  const adapter = f.snapshot.registry.providers.codex.workerAdapter;
  const driver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0' },
    buildInvocation: async input => ({ argv: [process.execPath, resolve('test/fixtures/ralph-external/termination-worker.mjs'),
      scenario, input.finalPath, join(root, 'child.pid')], stdin: 'closed', envNames: [] }),
    extractFinal: () => ({ summary: 'Synthetic termination result.' }) };
  const inputs = { snapshot: f.snapshot, drivers: { codex: driver } };
  trackWorkerPidFile(join(root, 'child.pid'));
  const launchIsolated = options => {
    const child = spawn(options.command, options.args,
      { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    trackWorkerProcess(child.pid);
    return { mode, child, ownedGroup };
  };
  const attempt = async (n, extra = {}) => {
    const plan = await resolveWorkerInvocation(f.snapshot, { role: 'coding', task: 'implementation', group: 'workers',
      brief, workdir: work, final_output: join(root, `final-${n}`) }, inputs.drivers, f.request.now);
    expect(plan.invocation, JSON.stringify(plan)).toBeDefined();
    const invocationPath = join(root, `plan-${n}.json`); await writeFile(invocationPath, JSON.stringify(plan));
    return new SessionLauncher().launchWorker({ invocationPath, runDir: join(root, `run-${n}`), inputs, now: f.request.now,
      scopedBreaker: recovery ? undefined : null, allowDegraded: true,
      dispatchGuard: { nowMs: () => 0, deadlineAtMs: 10000 },
      checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
      isolation: { mode: 'degraded', reason: 'synthetic degraded manager' }, launchIsolated, ...extra });
  };
  return { root, work, attempt };
}

const reference = runDir => resolveRetryReference({ runDir }, { inspect: inspectWorkerPath });

describe('T-OG-04 confirmed owned containment (#3674)', () => {
  it.each(['degraded', 'native-sandbox'])('links an empty %s group despite degraded observer coverage', async mode => {
    const f = await fixture(mode);
    const first = await f.attempt(1);
    expect(first).toMatchObject({ exitCode: 0, termination: 'confirmed', descendants: 'none', groupMembersRemaining: 0 });
    expect(first.health.coverage).toBe('degraded');
    expect(await readFile(join(f.root, 'child.pid.env'), 'utf8')).toBe(first.invocationId);
    expect(JSON.parse(await readFile(join(f.root, 'run-1/exit.json'), 'utf8')).termination).toBe('confirmed');
    const retryOf = await reference(join(f.root, 'run-1'));
    const second = await f.attempt(2, { retryOf });
    expect(second.termination).toBe('confirmed');
    expect(JSON.parse(await readFile(join(f.root, 'run-2/invocation.json'), 'utf8')).previousAttemptId).toBe(first.invocationId);
  });

  it('also links empty containment with recovery disabled using the legacy bound task digest', async () => {
    const f = await fixture('degraded', 'empty', false);
    expect(await f.attempt(1)).toMatchObject({ termination: 'confirmed', descendants: 'none' });
    const retryOf = await reference(join(f.root, 'run-1'));
    expect(await f.attempt(2, { retryOf })).toMatchObject({ termination: 'confirmed' });
    await writeFile(join(f.root, 'brief'), 'Different instructions.');
    await expect(f.attempt(3, { retryOf })).rejects.toThrow(/task-chain binding/);
  });

  it('refuses a live descendant even with a confirmed worker exit and names a bounded remedy', async () => {
    const f = await fixture('degraded', 'live');
    const first = await f.attempt(1);
    descendants.push(Number(await readFile(join(f.root, 'child.pid'), 'utf8')));
    expect(first).toMatchObject({ exitCode: 0, workerTermination: 'confirmed', termination: 'uncertain', descendants: 'unknown' });
    const retryOf = await reference(join(f.root, 'run-1'));
    await expect(f.attempt(2, { retryOf })).rejects.toMatchObject({ code: 'UNCERTAIN_TERMINATION', message: expect.stringContaining('--check-descendants') });
    await expect(verifyRetryPredecessor(retryOf, { inspect: inspectWorkerPath, workerWritableRoots: [f.work], checkDescendants: true }))
      .rejects.toThrow(/signal-0 still finds members.*--check-descendants/);
    expect(JSON.parse(await readFile(join(f.root, 'run-1/exit.json'), 'utf8')).termination).toBe('uncertain');
  });

  it.each([true, false])('confirms an uncaptured detached worker with empty containment (recovery %s)', async recovery => {
    const f = await fixture('degraded', 'empty', recovery, true);
    const first = await f.attempt(1, { sampleIdentity: () => null });
    expect(first).toMatchObject({ workerTermination: 'confirmed', termination: 'confirmed', descendants: 'none' });
    expect(JSON.parse(await readFile(join(f.root, 'run-1/process.json'), 'utf8')))
      .toMatchObject({ worker: null, ownership: 'unknown' });
    const retryOf = await reference(join(f.root, 'run-1'));
    expect(await f.attempt(2, { retryOf, sampleIdentity: () => null })).toMatchObject({ termination: 'confirmed' });
  });

  it.each(['live', 'escaped'])('blocks retry after an uncaptured detached worker leaves a %s descendant', async scenario => {
    const f = await fixture('degraded', scenario, true, true);
    const first = await f.attempt(1, { sampleIdentity: () => null });
    descendants.push(Number(await readFile(join(f.root, 'child.pid'), 'utf8')));
    expect(first).toMatchObject({ workerTermination: 'confirmed', termination: 'uncertain', descendants: 'unknown' });
    expect(first.terminationMissing).toContain(scenario === 'live' ? 'signal-0 still finds members' : 'still carries invocation marker');
    expect(JSON.parse(await readFile(join(f.root, 'run-1/process.json'), 'utf8')))
      .toMatchObject({ worker: null, ownership: 'unknown' });
    await expect(f.attempt(2)).rejects.toMatchObject({ code: 'OPEN_TASK_PREDECESSOR' });
    await expect(f.attempt(3, { retryOf: await reference(join(f.root, 'run-1')) }))
      .rejects.toMatchObject({ code: 'UNCERTAIN_TERMINATION' });
  });

  it('reconciles historical uncertain empty-group evidence before linking a retry', async () => {
    const f = await fixture();
    const first = await f.attempt(1);
    const file = join(f.root, 'run-1/exit.json');
    await writeFile(file, JSON.stringify({ ...first, termination: 'uncertain', descendants: 'unknown',
      terminationMissing: 'historical uncertain scan', healthEvidence: { ...first.healthEvidence, terminationMissing: 'historical uncertain scan' } }));
    const retryOf = await reference(join(f.root, 'run-1'));
    expect(await f.attempt(2, { retryOf, checkDescendants: true })).toMatchObject({ termination: 'confirmed' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ termination: 'confirmed', descendants: 'none', terminationMissing: null,
      healthEvidence: { terminationMissing: null } });
  });

  it.each(['native-sandbox', 'degraded'])('refuses an escaped setsid descendant in %s, including recheck', async mode => {
    const f = await fixture(mode, 'escaped');
    const first = await f.attempt(1);
    const pid = Number(await readFile(join(f.root, 'child.pid'), 'utf8')); descendants.push(pid);
    expect(sampleWorkerIdentity(pid).pgid).toBe(pid);
    expect(first).toMatchObject({ exitCode: 0, workerTermination: 'confirmed', groupMembersRemaining: 0,
      termination: 'uncertain', descendants: 'unknown' });
    expect(first.terminationMissing).toContain('same-uid process still carries invocation marker');
    expect(first.healthEvidence.terminationMissing).toBe(first.terminationMissing);
    expect(await readFile(join(f.root, 'child.pid.env'), 'utf8')).toBe(first.invocationId);
    const retryOf = await reference(join(f.root, 'run-1'));
    await expect(f.attempt(2, { retryOf })).rejects.toThrow(/escaped-descendant evidence/);
    await expect(f.attempt(3, { retryOf, checkDescendants: true }))
      .rejects.toThrow(/escaped-descendant evidence: same-uid process still carries invocation marker/);
    expect(JSON.parse(await readFile(join(f.root, 'run-1/exit.json'), 'utf8')).termination).toBe('uncertain');
  });

  it('never treats unknown identity, EPERM or a proc-list count as proof of emptiness', () => {
    const supervisor = sampleWorkerIdentity(process.pid);
    const identity = { ...supervisor, pid: 2147483646, pgid: 2147483646 };
    const base = { workerExited: true, identity, supervisor, invocationId: 'synthetic-absent-invocation' };
    expect(observeWorkerTermination({ ...base, kill: () => { throw Object.assign(new Error(), { code: 'ESRCH' }); } }).confirmed).toBe(true);
    for (const evidence of [
      { ...base, kill: () => {} },
      { ...base, kill: () => { throw Object.assign(new Error(), { code: 'EPERM' }); } },
      { ...base, identity: null }, { ...base, workerExited: false },
    ]) expect(observeWorkerTermination(evidence).confirmed).toBe(false);
  });

  it('treats a group whose observed members are all zombies as empty, and nothing weaker (#3853)', () => {
    const supervisor = sampleWorkerIdentity(process.pid);
    const identity = { ...supervisor, pid: 2147483646, pgid: 2147483646 };
    const scan = vi.fn(() => ({ confirmed: true, missing: null }));
    const base = { workerExited: true, identity, supervisor, invocationId: 'synthetic-zombie-invocation', kill: () => {}, scan };
    expect(observeWorkerTermination({ ...base, groupStates: () => ({ zombies: 2, live: 0, unreadable: 0 }) }).confirmed).toBe(true);
    expect(scan).toHaveBeenCalledTimes(1);
    for (const groupStates of [() => ({ zombies: 0, live: 0, unreadable: 0 }), () => ({ zombies: 1, live: 1, unreadable: 0 }),
      () => ({ zombies: 1, live: 0, unreadable: 1 }), () => null]) {
      expect(observeWorkerTermination({ ...base, groupStates })).toMatchObject({ confirmed: false, retryable: true });
    }
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform === 'linux')('counts a real unreaped child as a zombie member of its group', async () => {
    // The shell starts a child, then execs sleep, which never waits for it.
    const leader = spawn('sh', ['-c', 'sleep 0 & exec sleep 5'], { detached: true, stdio: 'ignore' });
    trackWorkerProcess(leader.pid);
    try {
      let states = null;
      for (let i = 0; i < 50 && !(states?.zombies > 0); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        states = sampleGroupStates(leader.pid);
      }
      expect(states).toMatchObject({ zombies: 1, live: 1 });
    } finally { try { process.kill(-leader.pid, 'SIGKILL'); } catch {} }
  });

  it('requires unit exit, inactivity and a positively empty cgroup, independent of leader group', () => {
    const clients = systemdClientFixture(); roots.push(clients.root); vi.stubEnv('PATH', clients.root);
    const native = getWorkerIsolationStatus('synthetic-unit', { spawn: () => ({ status: 0,
      stdout: 'ActiveState=inactive\nResult=success\nExecMainStatus=0\nExecMainCode=1\nMemoryMax=1024\nTasksCurrent=0\n' }) });
    expect(observeWorkerTermination({ mode: 'systemd-unit', native }).confirmed).toBe(true);
    for (const override of [{ active: true }, { execMainCode: 0 }, { cgroupEmpty: false }, { cgroupEmpty: undefined }]) {
      expect(observeWorkerTermination({ mode: 'systemd-unit', native: { ...native, ...override } }).confirmed).toBe(false);
    }
  });

  it('accepts an exited scope with no retained cgroup and refuses contradictory or unknown unit state', () => {
    const clients = systemdClientFixture(); roots.push(clients.root); vi.stubEnv('PATH', clients.root);
    const status = (extra = '') => getWorkerIsolationStatus('synthetic-scope', { spawn: () => ({ status: 0,
      stdout: `ActiveState=inactive\nResult=success\nMemoryMax=1024\nLoadState=loaded\nControlGroup=\n${extra}` }) });
    expect(observeWorkerTermination({ mode: 'systemd-unit', workerExited: true, native: status() }).confirmed).toBe(true);
    expect(observeWorkerTermination({ mode: 'systemd-unit', workerExited: true, native: status('TasksCurrent=1\n') }).confirmed).toBe(false);
    expect(observeWorkerTermination({ mode: 'systemd-unit', native: status() }).confirmed).toBe(false);
    expect(observeWorkerTermination({ mode: 'systemd-unit', workerExited: true, native: status('ActiveState=unknown\n') }).confirmed).toBe(false);
  });

  it('#4158 treats a garbage-collected successful unit as an empty cgroup only with exit evidence', () => {
    const clients = systemdClientFixture(); roots.push(clients.root); vi.stubEnv('PATH', clients.root);
    const status = (extra = '') => getWorkerIsolationStatus('synthetic-collected', { spawn: () => ({ status: 0,
      stdout: `ActiveState=inactive\nResult=success\nMemoryMax=infinity\nLoadState=not-found\nMainPID=0\nControlGroup=\n${extra}` }) });
    expect(status().cgroupEmpty).toBe(true);
    expect(observeWorkerTermination({ mode: 'systemd-unit', workerExited: true, native: status() }).confirmed).toBe(true);
    expect(observeWorkerTermination({ mode: 'systemd-unit', native: status() }).confirmed).toBe(false);
    expect(status('MainPID=42\n').cgroupEmpty).toBeUndefined();
    expect(status('TasksCurrent=1\n').cgroupEmpty).toBeUndefined();
  });

  it.each(['empty', 'populated', 'missing', 'denied'])('reads recursive cgroup evidence conservatively: %s', state => {
    const clients = systemdClientFixture(); roots.push(clients.root); vi.stubEnv('PATH', clients.root);
    const native = getWorkerIsolationStatus('synthetic-unit', { spawn: () => ({ status: 0,
      stdout: 'ActiveState=inactive\nResult=success\nExecMainCode=1\nMemoryMax=1024\nControlGroup=/synthetic/unit\n' }),
      readCgroup: filename => {
        expect(filename).toBe('/sys/fs/cgroup/synthetic/unit/cgroup.events');
        if (state === 'missing' || state === 'denied') throw Object.assign(new Error(), { code: state === 'missing' ? 'ENOENT' : 'EACCES' });
        return state === 'empty' ? 'populated 0\n' : 'populated 1\n';
      } });
    expect(observeWorkerTermination({ mode: 'systemd-unit', native }).confirmed).toBe(['empty', 'missing'].includes(state));
  });

  it('keeps an exited worker with unknown owned identity uncertain and names the required evidence', async () => {
    const f = await fixture();
    const first = await f.attempt(1, { sampleIdentity: () => null });
    expect(first).toMatchObject({ exitCode: 0, termination: 'uncertain', descendants: 'unknown',
      terminationMissing: expect.stringContaining('launcher-owned process group identity') });
    expect(first.healthEvidence.terminationMissing).toBe(first.terminationMissing);
    expect(JSON.parse(await readFile(join(f.root, 'run-1/exit.json'), 'utf8')).terminationMissing).toBe(first.terminationMissing);
    expect(JSON.parse(await readFile(join(f.root, 'run-1/health.json'), 'utf8')).evidence.terminationMissing).toBe(first.terminationMissing);
    await expect(verifyRetryPredecessor(await reference(join(f.root, 'run-1')), { inspect: inspectWorkerPath, checkDescendants: true }))
      .rejects.toThrow(/launcher-owned process group identity.*--check-descendants/);
  });

  it('bounds unavailable observer checks and refuses unverified transport identities', async () => {
    let calls = 0;
    const result = await recheckWorkerTermination({ processRecord: { invocationId: 'one', origin: 'launcher',
      invocationMarker: 'one', supervisor: sampleWorkerIdentity(process.pid), isolation: 'degraded', identityObservation: 'transport-reported-unverified', worker: sampleWorkerIdentity(process.pid) },
      exitRecord: { invocationId: 'one', isolation: 'degraded', exitCode: 0 }, now: () => 0, wait: async () => {},
      observe: input => { calls++; expect(input.identity).toBeNull(); return { confirmed: false }; } });
    expect(result.confirmed).toBe(false); expect(calls).toBe(21);
  });

  it('refuses historical non-cgroup evidence without a launcher-bound marker', async () => {
    const result = await recheckWorkerTermination({ processRecord: { invocationId: 'old', origin: 'launcher',
      supervisor: sampleWorkerIdentity(process.pid), isolation: 'native-sandbox' },
      exitRecord: { invocationId: 'old', isolation: 'native-sandbox', exitCode: 0 } });
    expect(result).toMatchObject({ confirmed: false, missing: expect.stringContaining('launcher-bound invocation marker') });
  });
});

describe('bounded invocation-marker evidence', () => {
  it('builds an explicit allowlist and overrides inherited markers without mutating the environment', () => {
    const inherited = { PATH: '/synthetic', SECRET: 'excluded', [WORKER_INVOCATION_MARKER]: 'old' };
    expect(buildWorkerInvocationEnvironment(['PATH', WORKER_INVOCATION_MARKER], 'new', inherited)).toEqual({
      env: { PATH: '/synthetic', [WORKER_INVOCATION_MARKER]: 'new' }, envNames: ['PATH', WORKER_INVOCATION_MARKER] });
    expect(inherited[WORKER_INVOCATION_MARKER]).toBe('old');
  });

  async function procFixture(contents = '') {
    const procRoot = await mkdtemp(join(tmpdir(), 'aiwg-marker-proc-')); roots.push(procRoot);
    await mkdir(join(procRoot, '123')); await writeFile(join(procRoot, '123/environ'), contents);
    return { procRoot, invocationId: 'exact', platform: 'linux' };
  }

  it.each(['exact', '雪'])('matches complete NUL-delimited %s markers across read boundaries', async invocationId => {
    const marker = `${WORKER_INVOCATION_MARKER}=${invocationId}`;
    const padding = 'x'.repeat(65534 - Buffer.byteLength(`${WORKER_INVOCATION_MARKER}=`));
    const fixture = { ...await procFixture(`${padding}\0${marker}\0`), invocationId };
    expect(scanWorkerInvocationProcesses(fixture)).toMatchObject({ confirmed: false, missing: expect.stringContaining('still carries') });
    await writeFile(join(fixture.procRoot, '123/environ'), `OTHER_${marker}\0${marker}-other\0`);
    expect(scanWorkerInvocationProcesses(fixture).confirmed).toBe(true);
  });

  it('keeps unreadable same-uid entries unknown while ignoring other uids and vanished entries', async () => {
    const fixture = await procFixture();
    const denied = { ...fs, openSync: () => { throw Object.assign(new Error(), { code: 'EACCES' }); } };
    expect(scanWorkerInvocationProcesses({ ...fixture, fs: denied })).toMatchObject({ confirmed: false,
      missing: expect.stringContaining('unreadable same-uid') });
    expect(scanWorkerInvocationProcesses({ ...fixture, fs: { ...denied, statSync: () => ({ uid: process.getuid() + 1 }) } }).confirmed).toBe(true);
    expect(scanWorkerInvocationProcesses({ ...fixture, fs: { ...fs,
      openSync: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } } }).confirmed).toBe(true);
  });

  async function timedProcFixture(ticks, comm = 'synthetic worker') {
    const fixture = await procFixture();
    // Fields 3..21, then field 22 (starttime), followed by the remaining fields.
    await writeFile(join(fixture.procRoot, '123/stat'),
      `123 (${comm}) S ${Array(18).fill('0').join(' ')} ${ticks} 0 0\n`);
    const denied = { ...fs, openSync: (filename, ...args) => {
      if (filename.endsWith('/environ')) throw Object.assign(new Error(), { code: 'EACCES' });
      return fs.openSync(filename, ...args);
    } };
    return { ...fixture, startTicks: '100', fs: denied };
  }

  it.each([['99', true], ['100', false], ['101', false]])(
    'ignores unreadable environments only for strictly earlier starts: %s', async (ticks, confirmed) => {
      expect(scanWorkerInvocationProcesses(await timedProcFixture(ticks)).confirmed).toBe(confirmed);
    });

  it('keeps missing worker starts, unreadable/malformed stat and unknown ownership uncertain', async () => {
    const fixture = await timedProcFixture('99');
    expect(scanWorkerInvocationProcesses({ ...fixture, startTicks: undefined }).confirmed).toBe(false);
    expect(scanWorkerInvocationProcesses({ ...fixture, fs: { ...fixture.fs, statSync: () => {
      throw Object.assign(new Error(), { code: 'EACCES' });
    } } }).confirmed).toBe(false);
    for (const stat of ['', '123 (worker) S', '123 worker S', `123 (worker) S ${Array(18).fill('0').join(' ')} invalid`]) {
      await writeFile(join(fixture.procRoot, '123/stat'), stat);
      expect(scanWorkerInvocationProcesses(fixture).confirmed).toBe(false);
    }
    await rm(join(fixture.procRoot, '123/stat'));
    expect(scanWorkerInvocationProcesses(fixture).confirmed).toBe(false);
    expect(scanWorkerInvocationProcesses({ ...fixture, fs: { ...fixture.fs, openSync: () => {
      throw Object.assign(new Error(), { code: 'EACCES' });
    } } }).confirmed).toBe(false);
  });

  it('still finds a readable marked process started after the worker', async () => {
    const fixture = await timedProcFixture('101');
    await writeFile(join(fixture.procRoot, '123/environ'), `${WORKER_INVOCATION_MARKER}=exact\0`);
    expect(scanWorkerInvocationProcesses({ ...fixture, fs })).toMatchObject({ confirmed: false, markerPresent: true });
  });

  it.each([['99', true], ['101', false]])('parses starttime after the last comm parenthesis: %s', async (ticks, confirmed) => {
    const fixture = await timedProcFixture(ticks, 'worker) 99 (');
    expect(scanWorkerInvocationProcesses(fixture).confirmed).toBe(confirmed);
  });

  it('passes recorded leader start ticks through immediate observation and descendant rechecks', async () => {
    const fixture = await timedProcFixture('99');
    const supervisor = sampleWorkerIdentity(process.pid);
    const identity = { ...supervisor, pid: 2147483646, pgid: 2147483646, startTicks: '100' };
    const scan = vi.fn(input => scanWorkerInvocationProcesses({ ...fixture, ...input }));
    const observe = input => observeWorkerTermination({ ...input, supervisor, scan,
      kill: () => { throw Object.assign(new Error(), { code: 'ESRCH' }); } });
    expect(observe({ workerExited: true, identity, invocationId: 'exact' }).confirmed).toBe(true);
    expect(await recheckWorkerTermination({ processRecord: { invocationId: 'exact', invocationMarker: 'exact',
      origin: 'launcher', supervisor, isolation: 'degraded', identityObservation: 'stable-owned-group',
      ownership: 'owned-group', worker: identity },
      exitRecord: { invocationId: 'exact', isolation: 'degraded', exitCode: 0 }, observe })).toMatchObject({ confirmed: true });
    expect(scan).toHaveBeenCalledTimes(2);
    for (const [input] of scan.mock.calls) expect(input).toMatchObject({ invocationId: 'exact', startTicks: '100',
      workerPid: 2147483646, workerPgid: 2147483646, workerSession: supervisor.sessionId });
  });

  // Fake-/proc fixtures for ancestry discrimination: every entry is a real
  // temp file, but `openSync` refuses the listed environ paths with EACCES to
  // simulate hardened (non-dumpable) workers whose stat/cgroup stay readable.
  async function ancestryFixture(entries, { deniedEnviron = [], uid = process.getuid() } = {}) {
    const procRoot = await mkdtemp(join(tmpdir(), 'aiwg-ancestry-proc-')); roots.push(procRoot);
    for (const [pid, spec] of Object.entries(entries)) {
      await mkdir(join(procRoot, pid));
      await writeFile(join(procRoot, pid, 'environ'), spec.environ ?? '');
      if (spec.stat !== undefined) await writeFile(join(procRoot, pid, 'stat'), spec.stat);
      if (spec.cgroup !== undefined) await writeFile(join(procRoot, pid, 'cgroup'), spec.cgroup);
    }
    const denied = new Set(deniedEnviron.map(String));
    const fixtureFs = { ...fs, openSync: (filename, ...args) => {
      const match = /\/(\d+)\/environ$/.exec(String(filename));
      if (match && denied.has(match[1])) throw Object.assign(new Error(), { code: 'EACCES' });
      return fs.openSync(filename, ...args);
    } };
    return { procRoot, platform: 'linux', invocationId: 'exact', uid, fs: fixtureFs };
  }

  // Stat fields after comm: state, ppid, pgrp, session, then 15 counters,
  // then the start time at index 19.
  const ancestryStat = (pid, comm, ppid, pgrp, session, start) =>
    `${pid} (${comm}) S ${ppid} ${pgrp} ${session} ${Array(15).fill('0').join(' ')} ${start} 0 0\n`;

  const ancestryBase = { invocationId: 'exact', platform: 'linux', startTicks: '500',
    workerPid: 100, workerPgid: 100, workerSession: 100,
    workerCgroup: '/worker/unit', selfCgroup: '/session/shared' };

  it('confirms an unrelated unreadable post-start process owned by another parent', async () => {
    // The worker leader (100) has already exited, as in a retry recheck; the
    // parallel worker (200) descends from an older conductor (150).
    const fixture = await ancestryFixture({
      150: { stat: ancestryStat(150, 'conductor', 1, 150, 150, '100'), cgroup: '0::/session/shared\n' },
      200: { stat: ancestryStat(200, 'codex', 150, 200, 200, '600'), cgroup: '0::/session/shared\n' },
    }, { deniedEnviron: ['200'] });
    expect(scanWorkerInvocationProcesses({ ...ancestryBase, ...fixture }))
      .toMatchObject({ confirmed: true, missing: null });
  });

  it('refuses an unreadable setsid child whose ppid chain reaches the worker leader', async () => {
    const fixture = await ancestryFixture({
      90: { stat: ancestryStat(90, 'launcher', 1, 90, 90, '100'), cgroup: '0::/session/shared\n' },
      100: { stat: ancestryStat(100, 'worker', 90, 100, 100, '500'), cgroup: '0::/worker/unit\n' },
      201: { stat: ancestryStat(201, 'escapee', 100, 201, 201, '600'), cgroup: '0::/session/shared\n' },
    }, { deniedEnviron: ['201'] });
    expect(scanWorkerInvocationProcesses({ ...ancestryBase, ...fixture }))
      .toMatchObject({ confirmed: false, missing: expect.stringContaining('links to the worker') });
  });

  it('refuses a cgroup-shared unreadable process even with an unrelated ancestry', async () => {
    const fixture = await ancestryFixture({
      150: { stat: ancestryStat(150, 'conductor', 1, 150, 150, '100'), cgroup: '0::/session/shared\n' },
      202: { stat: ancestryStat(202, 'codex', 150, 202, 202, '600'), cgroup: '0::/worker/unit\n' },
    }, { deniedEnviron: ['202'] });
    expect(scanWorkerInvocationProcesses({ ...ancestryBase, ...fixture }))
      .toMatchObject({ confirmed: false, missing: expect.stringContaining('links to the worker') });
  });

  it('keeps a reparented-to-init unreadable process unknown', async () => {
    const fixture = await ancestryFixture({
      203: { stat: ancestryStat(203, 'orphan', 1, 203, 203, '600'), cgroup: '0::/session/shared\n' },
    }, { deniedEnviron: ['203'] });
    expect(scanWorkerInvocationProcesses({ ...ancestryBase, ...fixture }))
      .toMatchObject({ confirmed: false, missing: expect.stringContaining('links to the worker') });
  });

  it('refuses an unreadable process that keeps the worker process group', async () => {
    const fixture = await ancestryFixture({
      150: { stat: ancestryStat(150, 'conductor', 1, 150, 150, '100'), cgroup: '0::/session/shared\n' },
      204: { stat: ancestryStat(204, 'escapee', 150, 100, 204, '600'), cgroup: '0::/session/shared\n' },
    }, { deniedEnviron: ['204'] });
    expect(scanWorkerInvocationProcesses({ ...ancestryBase, ...fixture }))
      .toMatchObject({ confirmed: false, missing: expect.stringContaining('links to the worker') });
  });

  it('lets ancestry clear an unrelated process when the worker shares the launcher cgroup', async () => {
    // A degraded worker shares its session cgroup with every sibling, so the
    // cgroup match alone must not block: the older ancestry clears it.
    const fixture = await ancestryFixture({
      150: { stat: ancestryStat(150, 'conductor', 1, 150, 150, '100'), cgroup: '0::/session/shared\n' },
      200: { stat: ancestryStat(200, 'codex', 150, 200, 200, '600'), cgroup: '0::/session/shared\n' },
    }, { deniedEnviron: ['200'] });
    expect(scanWorkerInvocationProcesses({ ...ancestryBase, ...fixture,
      workerCgroup: '/session/shared', selfCgroup: '/session/shared' }))
      .toMatchObject({ confirmed: true, missing: null });
  });

  it('reads the worker cgroup from /proc when the caller does not supply it', async () => {
    const fixture = await ancestryFixture({
      100: { stat: ancestryStat(100, 'worker', 90, 100, 100, '500'), cgroup: '0::/worker/unit\n' },
      150: { stat: ancestryStat(150, 'conductor', 1, 150, 150, '100'), cgroup: '0::/session/shared\n' },
      202: { stat: ancestryStat(202, 'codex', 150, 202, 202, '600'), cgroup: '0::/worker/unit\n' },
    }, { deniedEnviron: ['202'] });
    expect(scanWorkerInvocationProcesses({ ...ancestryBase, ...fixture, workerCgroup: undefined }))
      .toMatchObject({ confirmed: false, missing: expect.stringContaining('links to the worker') });
  });

  it('reconciles a recorded systemd-unit scope from retained unit state', async () => {
    const supervisor = sampleWorkerIdentity(process.pid);
    const processRecord = { invocationId: 'unit-one', origin: 'launcher', supervisor,
      isolation: 'systemd-unit', unit: 'synthetic-unit', identityObservation: 'stable-owned-group',
      ownership: 'owned-group', worker: supervisor, invocationMarker: 'unit-one' };
    const exitRecord = { invocationId: 'unit-one', isolation: 'systemd-unit', exitCode: 0 };
    const status = vi.fn(() => ({ active: false, cgroupEmpty: true,
      execMainCode: 1, execMainStatus: 0, result: 'success' }));
    expect(await recheckWorkerTermination({ processRecord, exitRecord, status,
      now: () => 0, wait: async () => {} })).toMatchObject({ confirmed: true });
    expect(status).toHaveBeenCalledWith('synthetic-unit', expect.anything());
    const unavailable = () => { throw new Error('no manager'); };
    expect((await recheckWorkerTermination({ processRecord, exitRecord, status: unavailable,
      now: () => 0, wait: async () => {} })).confirmed).toBe(false);
  });

  it('queries a recorded unit whenever present but confirms from it only in unit mode', async () => {
    const supervisor = sampleWorkerIdentity(process.pid);
    const status = vi.fn(() => ({ active: false, cgroupEmpty: true,
      execMainCode: 1, execMainStatus: 0, result: 'success' }));
    const result = await recheckWorkerTermination({
      processRecord: { invocationId: 'unit-one', invocationMarker: 'unit-one', origin: 'launcher',
        supervisor, isolation: 'degraded', unit: 'synthetic-unit' },
      exitRecord: { invocationId: 'unit-one', isolation: 'degraded', exitCode: 0 },
      status, now: () => 0, wait: async () => {} });
    expect(status).toHaveBeenCalledWith('synthetic-unit', expect.anything());
    expect(result.confirmed).toBe(false);
  });

  it('fails closed at time, entry and environment byte bounds and on non-Linux platforms', async () => {
    const fixture = await procFixture('too large');
    for (const options of [{ deadline: 0 }, { maxEntries: 0 }, { maxEnvironmentBytes: 3 },
      { platform: 'darwin' }, { invocationId: undefined }]) {
      expect(scanWorkerInvocationProcesses({ ...fixture, ...options })).toMatchObject({ confirmed: false,
        missing: expect.stringContaining('escaped-descendant evidence') });
    }
    const supervisor = sampleWorkerIdentity(process.pid);
    const result = observeWorkerTermination({ workerExited: true, supervisor,
      identity: { ...supervisor, pid: 2147483646, pgid: 2147483646 }, invocationId: 'exact',
      kill: () => { throw Object.assign(new Error(), { code: 'ESRCH' }); },
      scan: input => scanWorkerInvocationProcesses({ ...input, platform: 'darwin' }) });
    expect(result).toMatchObject({ confirmed: false, missing: expect.stringContaining('requires Linux /proc') });
  });
});
