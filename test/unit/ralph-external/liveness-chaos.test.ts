import { trackWorkerProcess } from '../../fixtures/ralph-external/worker-process-inventory.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { resolveWorkerEffectiveHealth, resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { SessionLauncher, signalOwnedWorker, stopBeforeRetryGate, classifyLaunchOutcomeForRecovery, resetInProcessAllowanceLedger } from '../../../tools/ralph-external/session-launcher.mjs';
import { sampleWorkerIdentity, sampleWorkerGroup, sampleWorkerStatus } from '../../../tools/ralph-external/process-monitor.mjs';
import { CodexAdapter } from '../../../tools/ralph-external/lib/codex-adapter.mjs';
import { ScopedFailureBreaker, attributeFailureScope } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { signalChild } from '../../../src/process/signal-child.mjs';
function monotonicClock() {
  let time = 0;
  return { now: () => time, advance(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Clock must advance monotonically');
    time += ms;
  } };
}

const fixtures: any[] = [];
const roots: string[] = [];
function temporaryRoot(prefix: string) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    // Only the birth identity of this fixture's detached child authorizes cleanup.
    if (f.identity) signalOwnedWorker(f.identity, 'SIGKILL');
    if (f.child && f.child.exitCode === null && f.child.signalCode === null) await f.closed;
    await f.result;
    expect(f.signals.every(([pid]: [number]) => pid === -f.identity?.pgid)).toBe(true);
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetInProcessAllowanceLedger();
});

// Every wait has a failure bound; logical health deadlines never use wall time.
function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Fixture wait exceeded 5s')), 5000);
  })]).finally(() => clearTimeout(timer));
}

async function fixture({ missing = false, effort = 'medium', retained = false, scopedBreaker = null as any,
  beforeSpawn = null as null | (() => Promise<void>) } = {}) {
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const root = temporaryRoot('liveness-');
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  if (retained) await writeFile(path.join(cwd, 'partial.txt'), 'retained partial\n');
  const brief = path.join(root, 'brief'); await writeFile(brief, 'synthetic task');
  const finalPath = path.join(root, 'final.json');
  const runDir = path.join(root, 'run');
  const f: any = { root, cwd, finalPath, runDir, clock: monotonicClock(), trace: ['launching'], signals: [] };
  fixtures.push(f);
  const base = workerResolutionFixture();
  if (scopedBreaker) base.snapshot.config.parallelism!.retry = { maxAttempts: 5 };
  if (effort === 'max') {
    // The direct task ceiling is 900s; keep diagnostic grace inside it.
    base.snapshot.config.parallelism!.health = { stallSeconds: 240 };
    for (const row of base.snapshot.catalog.discovery!.instances!.codex.models) {
      row.worker!.efforts!.push({ id: 'max', selfDelegates: false });
      row.reasoningEfforts!.push('max');
    }
  }
  base.snapshot.models.defaults.workerSelection!.roleGuidance!.coding.initialEffort = effort;
  if (effort === 'max') base.snapshot.models.defaults.workerSelection!.roleGuidance!.coding.effortLadder.push('max');
  const adapter = base.snapshot.registry.providers.codex.workerAdapter!;
  const profile = adapter.invocationProfiles!['fixture-shell'];
  profile.health = { version: 1, handshake: 'semantic', outputFraming: 'jsonl', signalParser: 'fixture:codex',
    sessionLogLocator: null, progressEvidence: ['item.completed'], stopEvidence: 'fixture:wait',
    fixtureRef: 'fixture:liveness', qualifiedAt: base.request.now, statusOperation: null, cancelOperation: null };
  const boundary = { kind: 'os' as const, identity: 'fixture:boundary', digest: qualificationDigest('boundary'), controls: ['sandbox'] };
  base.snapshot.installations.codex.boundary = boundary;
  const parser = new CodexAdapter();
  const record = () => {
    const state = f.observer.snapshot().state;
    if (f.trace.at(-1) !== state) f.trace.push(state);
  };
  const driver: any = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0', boundary },
    buildInvocation: async (input: any) => ({ argv: [missing ? path.join(root, 'missing-cli') : process.execPath,
      path.resolve('test/fixtures/ralph-liveness-cli.mjs'), '--effort', input.selected.effort.value,
      '--final-output', input.finalPath], stdin: 'closed', envNames: [] }),
    extractFinal: (text: string) => { try { return JSON.parse(text); } catch { return null; } },
    parseWorkerFinal: (bytes: any, options: any) => parser.parseWorkerFinal(bytes, options),
    createHealthObserver: (options: any) => {
      f.observer = parser.createHealthObserver({ ...options, now: f.clock.now, startedAt: 0 });
      // Record transitions at their source, including transitions inside feed/finish.
      for (const key of ['feed', 'observe', 'check', 'finish', 'processStarted']) {
        const original = f.observer[key];
        f.observer[key] = (...args: any[]) => { const value = original(...args); record(); return value; };
      }
      return f.observer;
    },
  };
  const plan = await resolveWorkerInvocation(base.snapshot, { role: 'coding', task: 'implementation', group: 'workers',
    brief, workdir: cwd, final_output: finalPath }, { codex: driver }, base.request.now);
  expect(plan.invocation, JSON.stringify(plan.diagnostics)).toBeDefined();
  f.plan = plan;
  const invocationPath = path.join(root, 'plan.json'); await writeFile(invocationPath, JSON.stringify(plan));
  const launcher = new SessionLauncher(); f.launcher = launcher;
  let output = '';
  const barriers = new Map<string, (value: any) => void>();
  const barrier = (id: string) => bounded(new Promise<any>(resolve => barriers.set(id, resolve)));
  launcher.on('stdout', (chunk: Buffer) => {
    output += chunk.toString();
    for (let newline; (newline = output.indexOf('\n')) >= 0;) {
      const row = JSON.parse(output.slice(0, newline)); output = output.slice(newline + 1);
      if (row.fixtureStep) { barriers.get(row.fixtureStep)?.(row); barriers.delete(row.fixtureStep); }
    }
  });
  const ready = missing ? null : barrier('ready');
  const initialHealth = new Promise(resolve => launcher.once('health', resolve));
  f.result = launcher.launchWorker({ invocationPath, runDir, inputs: { snapshot: base.snapshot, drivers: { codex: driver } },
    now: base.request.now, scopedBreaker, healthArtifacts: ['partial.txt'],
    isolation: { mode: 'degraded', reason: 'fixture-owned group' }, allowDegraded: true,
    checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
    launchIsolated: (options: any) => {
      const launch = () => {
        const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, detached: true,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
        f.child = child; trackWorkerProcess(child.pid);
        f.closed = bounded(new Promise<void>(resolve => child.once('close', () => resolve())));
        f.identity = sampleWorkerIdentity(child.pid);
        return { mode: 'degraded', child };
      };
      return options.onDispatchCommit ? (async () => {
        await options.onDispatchCommit();
        await beforeSpawn?.();
        return launch();
      })() : launch();
    } });
  if (ready) [f.ready] = await Promise.all([ready, bounded(initialHealth)]);
  let sequence = 0;
  f.step = async (step: string) => {
    const id = String(++sequence), done = barrier(id);
    const diagnostic = ['rate-limit', 'reset'].includes(step)
      ? bounded(new Promise(resolve => launcher.once('stderr', resolve))) : Promise.resolve();
    f.child.send({ step, id });
    const [row] = await Promise.all([done, diagnostic]);
    return row;
  };
  f.tick = (ms: number) => {
    // Stay on the baseline check cadence, including exact fractional boundaries.
    while (ms > 0) { const delta = Math.min(ms, 15000); f.clock.advance(delta); f.observer.check(); ms -= delta; }
    return f.observer.snapshot();
  };
  f.cancel = (signal: string) => signalOwnedWorker(f.identity, signal, { kill: (pid: number, value: any) => {
    f.signals.push([pid, value]); return process.kill(pid, value);
  } });
  return f;
}

describe('T-OG-20–23 deterministic direct lifecycle traces', () => {
  it.each([
    { elapsed: 4999, phase: 'before-row', complete: true, finding: null, workers: 1 },
    { elapsed: 5000, phase: 'before-row', complete: false, finding: 'SAMPLE_BUDGET', workers: 0 },
    { elapsed: 5000, phase: 'after-row', complete: false, finding: 'SAMPLE_OVERRUN', workers: 1 },
  ])('bounds status sampling at $elapsed ms ($phase) on the injected clock', async ({ elapsed, phase, complete, finding, workers }) => {
    const runDir = temporaryRoot('status-budget-');
    await writeFile(path.join(runDir, 'process.json'), JSON.stringify({ invocationId: 'manual', origin: 'manual' }), { mode: 0o600 });
    const clock = monotonicClock();
    let reads = 0;
    const report = await sampleWorkerStatus({ runDir, bootId: 'fixture-boot', monotonicNow: () => {
      // Reads: start, snapshot, before row, after row. Advance only at the
      // selected boundary, without a timer or a real filesystem delay.
      if (++reads === (phase === 'before-row' ? 3 : 4)) clock.advance(elapsed);
      return clock.now();
    } });
    expect(report.complete).toBe(complete);
    expect(report.workers).toHaveLength(workers);
    expect(report.findings).toEqual(finding ? [expect.stringContaining(finding)] : []);
  });

  it('T-OG-21 silent max hand-launch crosses the default 270/900/960 second boundaries', async () => {
    const root = temporaryRoot('silent-max-');
    const clock = monotonicClock();
    const effectiveHealth = resolveWorkerEffectiveHealth(undefined, { role: 'reasoning', effort: 'max',
      modelKey: 'fixture/model', profileRef: 'fixture', wallSeconds: 1800, stepEnforcement: 'unavailable' });
    const observer = new CodexAdapter().createHealthObserver({ invocationId: 'silent-max', now: clock.now, startedAt: 0,
      health: { handshake: 'semantic', outputFraming: 'jsonl', progressEvidence: ['item.completed'] }, effectiveHealth });
    const child = spawn(process.execPath, [path.resolve('test/fixtures/ralph-liveness-cli.mjs'),
      '--effort', 'max', '--final-output', path.join(root, 'final.json')],
    { cwd: root, env: {}, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const closed = bounded(new Promise<void>(resolve => child.once('close', () => resolve())));
    const identity = sampleWorkerIdentity(child.pid);
    let ready!: (row: any) => void, accepted!: () => void, bytes = 0, buffer = '';
    const started = bounded(new Promise<any>(resolve => { ready = resolve; }));
    const handshake = new Promise<void>(resolve => { accepted = resolve; });
    child.stdout!.on('data', chunk => {
      observer.feed(chunk, { kind: 'stdout', id: 'stdout', generation: 0, offset: bytes }); bytes += chunk.length;
      buffer += chunk.toString();
      for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
        const row = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (row.fixtureStep === 'ready') ready(row);
        if (row.fixtureStep === 'accepted') accepted();
      }
    });
    child.stderr!.resume();
    try {
      expect((await started).effort).toBe('max');
      observer.processStarted(identity);
      child.send({ step: 'accept', id: 'accepted' }); await bounded(handshake);
      const trace = ['launching', observer.snapshot().state];
      const quietBytes = bytes;
      const tick = (target: number) => {
        while (clock.now() < target) { clock.advance(Math.min(15_000, target - clock.now())); observer.check(); }
        const state = observer.snapshot().state;
        if (state !== trace.at(-1)) trace.push(state);
        return state;
      };
      expect(effectiveHealth).toMatchObject({ quietSeconds: 270, stallSeconds: 900, hardTimeoutSeconds: 1800 });
      expect(tick(180_001)).toBe('started');
      expect(observer.shouldStop()).toBe(false);
      expect(tick(269_999)).toBe('started'); expect(tick(270_000)).toBe('quiet');
      expect(tick(899_999)).toBe('quiet'); expect(tick(900_000)).toBe('stalled');
      expect(tick(959_999)).toBe('stalled'); expect(tick(960_000)).toBe('hung');
      expect(trace).toEqual(['launching', 'started', 'quiet', 'stalled', 'hung']);
      expect(observer.evidence().gaps).toEqual([]);
      expect(bytes).toBe(quietBytes); expect(child.exitCode).toBeNull();
    } finally {
      if (identity) signalOwnedWorker(identity, 'SIGKILL'); else signalChild(child, 'SIGKILL');
      await closed;
    }
  });

  it.each([[true, false], [false, false], [true, true]])('T-OG-23 observes a shell hand-launch with run directory=%s without managed state (host pause=%s)', async (withDirectory, hostPause) => {
    const root = temporaryRoot('hand-launch-');
    const clock = monotonicClock();
    const runDir = path.join(root, 'run');
    const child = spawn('/bin/sh', ['-c',
      'umask 077; if [ "$1" = with-dir ]; then mkdir "$2"; exec >"$2/stdout.log" 2>"$2/stderr.log"; fi; exec "$3" "$4" --hand-launch --final-output "$5"',
      'fixture-shell', withDirectory ? 'with-dir' : 'no-dir', runDir, process.execPath,
      path.resolve('test/fixtures/ralph-liveness-cli.mjs'), path.join(root, 'final.json')],
    { cwd: root, env: {}, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const closed = bounded(new Promise<void>(resolve => child.once('close', () => resolve())));
    const barriers = new Map<string, () => void>();
    const barrier = (id: string) => bounded(new Promise<void>(resolve => barriers.set(id, resolve)));
    const ready = barrier('ready');
    child.on('message', (message: any) => { barriers.get(message.fixtureStep)?.(); barriers.delete(message.fixtureStep); });
    child.stdout!.resume(); child.stderr!.resume();
    let identity: any;
    try {
      await ready;
      identity = sampleWorkerIdentity(child.pid);
      expect(identity).toMatchObject({ pid: child.pid, pgid: child.pid });
      const launcher = new SessionLauncher();
      const trace: string[] = [];
      if (withDirectory) await writeFile(path.join(runDir, 'process.json'), JSON.stringify({
        invocationId: 'hand-launch', origin: 'manual', worker: identity,
      }), { mode: 0o600 });
      const evidence = async () => Promise.all((await readdir(root, { recursive: true })).sort().map(async name => {
        const filename = path.join(root, name), stat = await lstat(filename);
        return { name, mode: stat.mode, mtime: stat.mtimeMs, bytes: stat.isFile() ? await readFile(filename, 'utf8') : null };
      }));
      const sample = async () => {
        if (!withDirectory) {
          const observed = await launcher.adoptWorker({ worker: identity });
          expect(observed).toMatchObject({ runDir: null, coverage: 'conductor-context-only', ownership: 'unknown',
            termination: 'uncertain', health: { coverage: 'unobserved', lastProgressAt: null,
              startupDeadlineAt: null, hardDeadlineAt: null } });
          return observed.observedWorker ? 'live-unobserved' : 'absent-uncertain';
        }
        // Simulate descheduling across the sampler's five-second budget. The
        // lifecycle clock stays fixed until the fixture acknowledges a step.
        const hostNow = process.hrtime.bigint.bind(process.hrtime);
        let hostElapsed = 0n;
        const hostClock = hostPause ? vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => {
          hostElapsed += 5_000_000_000n;
          return hostNow() + hostElapsed;
        }) : null;
        let report;
        try { report = await sampleWorkerStatus({ runDir, monotonicNow: clock.now }); }
        finally { hostClock?.mockRestore(); }
        expect(report, JSON.stringify(report)).toMatchObject({ complete: true, observerCoverage: 'unobserved', breakers: [] });
        expect(report.workers).toHaveLength(1);
        const row = report.workers[0];
        expect(row).toMatchObject({ invocationId: 'hand-launch', transport: 'shell', terminal: false,
          elapsedSeconds: null, remainingSeconds: null, thresholds: null,
          health: { coverage: 'unobserved', lastProgressAt: null, hardDeadlineAt: null }, counters: { exitCode: null } });
        return row.termination === 'running' ? 'live-unobserved' : 'absent-uncertain';
      };
      let before = await evidence();
      trace.push(await sample());
      expect(await evidence()).toEqual(before);
      const accepted = barrier('accepted'); child.send({ step: 'accept', id: 'accepted' }); await accepted;
      before = await evidence();
      trace.push(await sample());
      expect(await evidence()).toEqual(before);
      child.send({ step: 'exit' }); await closed;
      before = await evidence();
      trace.push(await sample());
      expect(trace).toEqual(['live-unobserved', 'live-unobserved', 'absent-uncertain']);
      expect(await evidence()).toEqual(before);
      expect((await readdir(root)).sort()).toEqual(withDirectory ? ['run'] : []);
      if (withDirectory) expect((await readdir(runDir)).sort()).toEqual(['process.json', 'stderr.log', 'stdout.log']);
    } finally {
      if (identity) signalOwnedWorker(identity, 'SIGKILL');
      else if (child.exitCode === null && child.signalCode === null) signalChild(child, 'SIGKILL');
      await closed;
    }
  });

  it('T-OG-21 silent max executable crosses exact quiet, stall and hung boundaries', async () => {
    const f = await fixture({ effort: 'max' });
    expect(f.plan.invocation.selected.effort.value).toBe('max');
    expect(f.ready.effort).toBe('max');
    expect(f.plan.invocation.health).toMatchObject({ quietSeconds: 270, stallSeconds: 720, diagnosticGraceSeconds: 60, hardTimeoutSeconds: 900 });
    await f.step('accept');
    const activity = f.observer.snapshot().lastActivityAt;
    expect(f.tick(180001).state).toBe('started');
    expect(f.observer.shouldStop()).toBe(false);
    expect(f.tick(89998).state).toBe('started');
    expect(f.tick(1).state).toBe('quiet');
    expect(f.tick(449999).state).toBe('quiet');
    expect(f.tick(1)).toMatchObject({ state: 'stalled', reasonCode: 'NO_PROGRESS' });
    expect(f.tick(59999).state).toBe('stalled');
    expect(f.tick(1).state).toBe('hung');
    expect(f.child.exitCode).toBeNull();
    expect(f.observer.snapshot().lastActivityAt).toBe(activity);
    expect(f.observer.evidence().gaps).toEqual([]);
    expect(f.trace).toEqual(['launching', 'started', 'quiet', 'stalled', 'hung']);
    f.launcher.workerStop('NO_PROGRESS');
    expect((await bounded(f.result)).health.state).not.toBe('completed');
  });

  it('T-OG-22 admits five executable failures before dispatch and pauses subsequent launches', async () => {
    const clock = monotonicClock();
    const breaker = new ScopedFailureBreaker({ nowMs: clock.now, jitterMs: () => 0 });
    const trace = ['closed'];
    breaker.on('transition', (event: any) => { if (event.scopeKey === 'installation:codex') trace.push(event.to); });
    let release!: () => void, entered!: () => void, count = 0;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const allDispatched = new Promise<void>(resolve => { entered = resolve; });
    const workers: any[] = [];
    try {
      workers.push(...await Promise.all(Array.from({ length: 5 }, () => fixture({ missing: true, retained: true,
        scopedBreaker: breaker, beforeSpawn: async () => { if (++count === 5) entered(); await pending; } }))));
      await bounded(allDispatched);
      expect(breaker.snapshot()).toMatchObject({ attemptsObserved: 0, reservationsOutstanding: 5 });
      release();
      const results = await bounded(Promise.all(workers.map(f => f.result)));
      for (const [index, result] of results.entries()) {
        expect(result).toMatchObject({ exitCode: null, errorCode: 'ENOENT', attemptOutcome: 'failed' });
        expect(workers[index].trace).toEqual(['launching', 'failed-to-start', 'failed']);
        expect(await readFile(path.join(workers[index].cwd, 'partial.txt'), 'utf8')).toBe('retained partial\n');
      }
      expect(trace).toEqual(['closed', 'open']);
      expect(breaker.getState('installation:codex')).toMatchObject({ state: 'open', distinctFailures: 5 });
      expect(breaker.snapshot()).toMatchObject({ attemptsObserved: 5, reservationsOutstanding: 0 });
      const denied = await fixture({ missing: true, scopedBreaker: breaker });
      await expect(bounded(denied.result)).rejects.toMatchObject({ code: 'RECOVERY_SCOPE_OPEN' });
      denied.result = Promise.resolve();
      expect(denied.child).toBeUndefined();
      expect(breaker.snapshot().attemptsObserved).toBe(5);
    } finally { release(); await Promise.allSettled(workers.map(f => f.result)); breaker.destroy(); }
  });

  it('never executes a missing CLI and records failed start without exit zero', async () => {
    const f = await fixture({ missing: true });
    const result = await bounded(f.result);
    expect(result.exitCode).toBeNull();
    expect(result.health.state).toBe('failed');
    expect(f.trace).toEqual(['launching', 'failed-to-start', 'failed']);
    expect(JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8')).exitCode).toBeNull();
  });

  it('diagnoses a process with no handshake at the exact startup deadline', async () => {
    const f = await fixture();
    expect(f.tick(59999).state).toBe('launching');
    expect(f.tick(1)).toMatchObject({ state: 'failed-to-start', reasonCode: 'STARTUP_DEADLINE' });
    expect(f.trace).toEqual(['launching', 'failed-to-start']);
    f.cancel('SIGTERM');
    expect((await bounded(f.result)).health.state).not.toBe('completed');
  });

  it('keeps a quiet high-effort worker live and resumes on novel progress', async () => {
    const f = await fixture({ effort: 'high' });
    expect(f.plan.invocation.selected.effort.value).toBe('high');
    await f.step('accept');
    expect(f.tick(90000)).toMatchObject({ state: 'quiet', reasonCode: 'QUIET' });
    expect(f.observer.evidence().gaps).toEqual([]);
    expect(f.observer.shouldStop()).toBe(false);
    expect(f.child.exitCode).toBeNull();
    await f.step('edit');
    expect(f.trace).toEqual(['launching', 'started', 'quiet', 'active']);
    await f.step('final');
    f.child.send({ step: 'exit' });
    const result = await bounded(f.result);
    // A confirmed exit plus ESRCH proves the owned group empty despite degraded health.
    expect(result).toMatchObject({ exitCode: 0, termination: 'confirmed', descendants: 'none' });
    expect(stopBeforeRetryGate(result).ok).toBe(true);
  });

  it.each([false, true])('detects stall with partial edit=%s despite identical output churn', async edit => {
    const f = await fixture(); await f.step('accept');
    if (edit) await f.step('edit');
    const progress = f.observer.snapshot().lastProgressAt;
    expect(f.tick(90000).state).toBe('quiet');
    await f.step(edit ? 'churn' : 'noise');
    const lastProgress = f.observer.snapshot().lastProgressAt;
    if (edit) expect(lastProgress).toBe(progress);
    expect(f.tick(210000)).toMatchObject({ state: 'stalled', reasonCode: 'NO_PROGRESS' });
    expect(f.tick(60000).state).toBe('hung');
    expect(f.observer.evidence().gaps).toEqual([]);
    expect(f.trace).toEqual(edit ? ['launching', 'started', 'active', 'quiet', 'active', 'quiet', 'stalled', 'hung']
      : ['launching', 'started', 'quiet', 'stalled', 'hung']);
    f.launcher.workerStop('NO_PROGRESS');
    const result = await bounded(f.result);
    expect(result.health.state).not.toBe('completed');
    expect(stopBeforeRetryGate(result).ok).toBe(true);
    if (edit) expect(await readFile(path.join(f.cwd, 'partial.txt'), 'utf8')).toBe('synthetic partial work\n');
  });

  it.each([false, true])('preserves partial work on abnormal exit with final=%s', async final => {
    const f = await fixture(); await f.step('accept'); await f.step('edit');
    if (final) await f.step('final');
    f.child.send({ step: 'crash' });
    const result = await bounded(f.result);
    expect(result).toMatchObject({ exitCode: 17, termination: 'confirmed', descendants: 'none' });
    expect(f.trace).toEqual(['launching', 'started', 'active', 'failed']);
    expect(await readFile(path.join(f.cwd, 'partial.txt'), 'utf8')).toBe('synthetic partial work\n');
    expect(result.health.state).not.toBe('completed');
  });

  it.each([['rate-limit', 'RATE_LIMIT'], ['reset', 'NETWORK']])('captures %s without treating worker text as shared failure authority', async (step, code) => {
    const f = await fixture(); await f.step(step);
    expect(f.observer.snapshot()).toMatchObject({ state: 'failed-to-start', reasonCode: code });
    f.child.send({ step: 'crash' });
    const result = await bounded(f.result);
    expect(await readFile(path.join(f.runDir, 'stderr.log'), 'utf8')).toContain(step === 'rate-limit' ? '429' : 'ECONNRESET');
    expect(result.health.state).not.toBe('completed');
    expect(attributeFailureScope({ reasonCode: code, evidenceSource: 'worker', invocationId: result.invocationId,
      quotaAccount: 'synthetic', inferenceProvider: 'fixture-backend', cli: 'codex' })).toMatchObject({
      scope: 'invocation', scopeKey: `invocation:${result.invocationId}`,
    });
  });

  it('gives the hard ceiling priority over a pending startup diagnosis', async () => {
    const f = await fixture();
    f.clock.advance(1800000);
    expect(f.observer.check()).toMatchObject({ state: 'launching', reasonCode: 'HARD_DEADLINE' });
    expect(f.observer.nextDelayMs()).toBe(1);
    f.launcher.workerStop('HARD_DEADLINE');
    const result = await bounded(f.result);
    expect(result.timedOut).toBe(true);
    expect(result.health.state).not.toBe('completed');
  });

  it('reads captured abnormal exit status without mutating run evidence or accepting partial work', async () => {
    const f = await fixture(); await f.step('accept'); await f.step('edit');
    f.child.send({ step: 'crash' });
    const result = await bounded(f.result);
    const evidence = async () => Promise.all((await readdir(f.runDir)).sort().map(async name => {
      const filename = path.join(f.runDir, name), stat = await lstat(filename);
      return { name, bytes: await readFile(filename, 'utf8'), mtime: stat.mtimeMs, mode: stat.mode };
    }));
    const before = await evidence();
    const processRecord = JSON.parse(await readFile(path.join(f.runDir, 'process.json'), 'utf8'));
    const status = await sampleWorkerStatus({ runDir: f.runDir,
      now: () => Date.parse(result.endedAt) + 1000,
      monotonicNow: () => Number(BigInt(processRecord.monotonicStart)) / 1e6 + 1000,
      bootId: f.identity.bootId, sampleIdentity: () => null });
    expect(status.workers).toHaveLength(1);
    expect(status.workers[0]).toMatchObject({ counters: { exitCode: 17 }, termination: 'confirmed', terminal: true });
    expect(await evidence()).toEqual(before);
    expect(await readFile(path.join(f.cwd, 'partial.txt'), 'utf8')).toBe('synthetic partial work\n');
  });

  it('pauses five common failed starts, admits one relevant probe and one canary, and preserves work', async () => {
    const clock = monotonicClock();
    const breaker = new ScopedFailureBreaker({ nowMs: clock.now, jitterMs: () => 0 });
    const key = 'installation:codex';
    const trace = ['closed'];
    breaker.on('transition', (event: any) => { if (event.scopeKey === key) trace.push(event.to); });
    const dispatch = (id: string, purpose = 'task') => {
      const admission = breaker.admit({ invocationId: id, scopeKeys: [key], purpose });
      expect(admission.ok).toBe(true);
      expect(breaker.beginDispatch(admission.token, { invocationId: id, selectionDigest: null }).ok).toBe(true);
      expect(breaker.commitDispatch(admission.token).ok).toBe(true);
      return admission.token;
    };
    try {
      const workers = await Promise.all(Array.from({ length: 5 }, () => fixture({ missing: true, retained: true })));
      const results = await Promise.all(workers.map(f => f.result));
      const tokens = results.map(result => dispatch(result.invocationId));
      for (const [index, token] of tokens.entries()) {
        const result = results[index];
        expect(result).toMatchObject({ exitCode: null, errorCode: 'ENOENT' });
        const evidence = classifyLaunchOutcomeForRecovery(result);
        expect(evidence).toMatchObject({ reasonCode: 'NOT_FOUND', evidenceSource: 'launcher' });
        const outcome = { kind: 'failed', ...evidence, cli: workers[index].plan.invocation.selected.cli,
          confirmedStop: result.termination === 'confirmed' };
        expect(breaker.settle(token, outcome).ok).toBe(true);
        expect(breaker.settle(token, outcome).ok).toBe(false);
      }
      expect(breaker.getState(key)).toMatchObject({ state: 'open', distinctFailures: 5, attemptsObserved: 5 });
      expect(breaker.admit({ invocationId: 'paused', scopeKeys: [key] }).ok).toBe(false);
      clock.advance(119999);
      expect(breaker.admit({ invocationId: 'early-probe', scopeKeys: [key], purpose: 'probe' }).ok).toBe(false);
      clock.advance(1);
      expect(breaker.admit({ invocationId: 'task-before-probe', scopeKeys: [key] }).probeRequired).toEqual([key]);
      const probe = dispatch('relevant-probe', 'probe');
      expect(breaker.admit({ invocationId: 'second-probe', scopeKeys: [key], purpose: 'probe' }).ok).toBe(false);
      expect(breaker.settle(probe, { kind: 'succeeded', relevant: true, evidenceSource: 'launcher', confirmedStop: true }).ok).toBe(true);
      const canary = dispatch('canary');
      expect(breaker.admit({ invocationId: 'second-canary', scopeKeys: [key] }).ok).toBe(false);
      expect(breaker.settle(canary, { kind: 'succeeded', evidenceSource: 'launcher', confirmedStop: true }).ok).toBe(true);
      expect(trace).toEqual(['closed', 'open', 'half-open', 'canary-ready', 'canary', 'closed']);
      expect(breaker.snapshot()).toMatchObject({ reservationsOutstanding: 0, canariesObserved: 1 });
      for (const f of workers) expect(await readFile(path.join(f.cwd, 'partial.txt'), 'utf8')).toBe('retained partial\n');
    } finally { breaker.destroy(); }
  });

  it('cancels only the owned group with TERM then KILL, including its descendant', async () => {
    const f = await fixture(); await f.step('accept'); await f.step('edit');
    const { descendant } = await f.step('ignore-term');
    expect(sampleWorkerIdentity(descendant)?.pgid).toBe(f.identity.pgid);
    expect(f.cancel('SIGTERM')).toBe(true);
    await f.step('churn'); // Parent acknowledged after TERM; it really ignored TERM.
    expect(f.cancel('SIGKILL')).toBe(true);
    const result = await bounded(f.result);
    expect(result).toMatchObject({ signal: 'SIGKILL', termination: 'confirmed', descendants: 'none' });
    expect(f.signals).toEqual([[-f.identity.pgid, 'SIGTERM'], [-f.identity.pgid, 'SIGKILL']]);
    expect(sampleWorkerGroup(f.identity.pgid).filter((member: any) => member.state !== 'Z')).toEqual([]);
    expect(await readFile(path.join(f.cwd, 'partial.txt'), 'utf8')).toBe('synthetic partial work\n');
  });
});
