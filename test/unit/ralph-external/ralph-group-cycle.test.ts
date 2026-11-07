import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { managedMcWorkerFixture } from '../../fixtures/managed-mc-worker.js';
import { loadWorkerInputs } from '../../../src/cli/handlers/models.js';
import { bindManagedAdmissionPolicy, FileAdmissionStore, managedProjectAdmissionPolicy, projectAdmissionAuthority } from '../../../src/serve/shared-host-scheduler.js';
import { resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { StateManager } from '../../../tools/ralph-external/state-manager.mjs';
import { launchRalphCycle } from '../../../tools/ralph-external/lib/ralph-cycle-launch.mjs';
import { assertManagedWorkerLaunch, SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';
import { managedWorkerAttempt, validateManagedAttempt } from '../../../tools/ralph-external/lib/managed-worker-attempt.mjs';
import { SharedHostScheduler } from '../../../src/serve/shared-host-scheduler.js';

vi.mock('../../../src/cli/handlers/models.js', () => ({ loadWorkerInputs: vi.fn() }));
const now = '2026-10-22T12:00:00.000Z';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ralph-group-'));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  vi.stubEnv('RALPH_LOOP_ID', 'ralph-parent');
  vi.useFakeTimers(); vi.setSystemTime(new Date(now));
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function fixture(time = now) {
  const f = await managedMcWorkerFixture(root, { now: time, parentKind: 'ralph', sessionId: 'ralph-parent' });
  f.intent.limits.tokens = 100000;
  f.brief.intentDigest = workerConfigDigest(f.intent);
  await writeFile(f.paths.brief, JSON.stringify(f.brief));
  f.plan = await resolveWorkerInvocation(f.snapshot, f.request, f.drivers, time);
  const policy = managedProjectAdmissionPolicy(root, f.cfg.parallelism!, workerConfigDigest(f.cfg.parallelism!.activation), 1);
  const store = new FileAdmissionStore(projectAdmissionAuthority(root).path);
  bindManagedAdmissionPolicy(store, policy);
  vi.mocked(loadWorkerInputs).mockResolvedValue({ snapshot: f.snapshot, drivers: f.drivers } as any);
  const stateManager = new StateManager(root);
  const state = stateManager.initialize({ loopId: 'ralph-parent', objective: 'synthetic', completionCriteria: 'parent checks',
    groupWorker: f.request, maxIterations: 3, enableCheckpoints: false });
  const health = { version: 1, state: 'completed', termination: 'confirmed', coverage: 'full', handshake: 'semantic',
    lastObservedAt: now, lastActivityAt: null, lastProgressAt: null, reasonCode: 'FINAL', transitionCount: 1,
    restartCount: 0, unavailableSignals: [], transitionRefs: [], observerGeneration: 1,
    startupDeadlineAt: null, hardDeadlineAt: null, maxCheckGapSeconds: 1, confidence: 'observed', handshakeAt: null, stalledAt: null };
  const sessionLauncher = { kill: vi.fn(), launch: vi.fn(), launchWorker: vi.fn(async (options: any) => {
    const before = store.read();
    await assertManagedWorkerLaunch(options, options.invocation, options.inputs, root);
    await assertManagedWorkerLaunch(options, options.invocation, options.inputs, root);
    expect(store.read().records).toEqual(before.records);
    expect(store.read().allowances).toEqual(before.allowances); // Reused claimed reservation is never resubmitted or charged.
    await writeFile(options.invocation.stdoutPath, 'synthetic candidate');
    await writeFile(options.invocation.stderrPath, '');
    return { exitCode: 0, timedOut: false, health };
  }) };
  const owner = { projectRoot: root, stateManager, sessionLauncher };
  const cycle = async (timeoutMs = 5000) => {
    state.currentIteration++;
    const dir = join(root, `cycle-${state.currentIteration}`); await mkdir(dir);
    return launchRalphCycle(owner, state, { prompt: 'parent prompt', outputPaths: { stdout: join(dir, 'stdout'), stderr: join(dir, 'stderr') },
      iterationDir: dir, timeoutMs });
  };
  return { ...f, store, state, owner, cycle, health };
}

describe('T-OG-08/13 standalone Ralph group cycles', () => {
  it('executes the existing fake CLI through managed validation and writes fresh-attempt receipts', async () => {
    // Keep wall and monotonic clocks frozen while real child I/O runs. Success
    // settles on child completion; deadline behavior is driven separately below.
    const f = await fixture();
    const settings = join(root, 'fake.json');
    await writeFile(settings, JSON.stringify({ scenario: 'success', recordPath: join(root, 'work', 'record.json') }));
    vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', settings);
    const profile = f.snapshot.registry.providers.codex.workerAdapter!.invocationProfiles!['fixture-shell'];
    profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    f.drivers.codex.buildInvocation = async (input: any) => ({
      argv: [process.execPath, resolve('test/fixtures/ralph-worker-cli.mjs'), '--model', input.selected.model,
        '--final-output', input.finalPath], stdin: 'closed', envNames: profile.envAllowlist });
    const launcher = new SessionLauncher();
    f.owner.sessionLauncher.launchWorker.mockImplementation(options => launcher.launchWorker({ ...options,
      isolation: { mode: 'degraded', reason: 'synthetic fixture' }, allowDegraded: true,
      checkDispatch: () => ({ enabled: true, ok: true, failures: [] }) }));
    // Even a tiny logical budget must not turn host scheduling latency into a failure.
    const result = await f.cycle(1);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    const record = JSON.parse(await readFile(join(root, 'work', 'record.json'), 'utf8'));
    expect(record).toMatchObject({ scenario: 'success', cwd: f.paths.workdir });
    expect(Object.keys(f.store.read().records)).toHaveLength(1);
    const receipt = JSON.parse(await readFile(join(root, 'cycle-1/worker-run/invocation.json'), 'utf8'));
    expect(receipt.attempt).toMatchObject({ kind: 'fresh', reason: 'one-shot-profile' });
    const recheck = JSON.parse(await readFile(join(root, 'cycle-1/worker-plan.json.attempt.json'), 'utf8'));
    expect(recheck).toMatchObject({ kind: 'fresh', changes: [], status: 'prepared' });
    expect(loadWorkerInputs.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops a pending group cycle only when its logical deadline expires', async () => {
    const f = await fixture();
    const launch = f.owner.sessionLauncher.launchWorker.getMockImplementation()!;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const stop = vi.fn();
    Object.assign(f.owner.sessionLauncher, { workerStop: stop });
    f.owner.sessionLauncher.launchWorker.mockImplementation(async options => {
      const result = await launch(options);
      return new Promise<any>(resolve => {
        stop.mockImplementation(() => resolve({ ...result, exitCode: null, timedOut: true,
          health: { ...f.health, state: 'hung', reasonCode: 'HARD_DEADLINE' } }));
        started();
      });
    });
    const pending = f.cycle();
    await ready;
    await vi.advanceTimersByTimeAsync(4999);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ exitCode: null, timedOut: true });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-resolves cycles and nested retries within one original task allowance and deadline', async () => {
    const f = await fixture();
    const first = await f.cycle();
    const scopes = Object.values(f.store.read().allowances!);
    expect(scopes).toHaveLength(2);
    vi.setSystemTime(new Date(Date.parse(now) + 10_000));
    const second = await f.cycle();
    const records = Object.values(f.store.read().records);
    expect(records).toHaveLength(2);
    expect(records[1]!.accounting).toMatchObject({ runKey: records[0]!.accounting!.runKey,
      taskKey: records[0]!.accounting!.taskKey, attemptCount: 1, attemptNumber: 2 });
    expect(records[1]!.allowance!.previousRequestId).toBe(records[0]!.requestId);
    expect(Object.values(f.store.read().allowances!).map(s => s.deadlineAt)).toEqual(scopes.map(s => s.deadlineAt));
    expect(first.attempt).toMatchObject({ kind: 'fresh', reason: 'one-shot-profile', status: 'settled' });
    expect(second.attempt.previousAttemptId).toBe(first.attempt.attemptId);
    expect(loadWorkerInputs).toHaveBeenCalledTimes(2);
    await expect(f.cycle()).rejects.toThrow(/attempt allowance exhausted/);
    expect(f.owner.sessionLauncher.launchWorker).toHaveBeenCalledTimes(2);
    expect(f.owner.sessionLauncher.launch).not.toHaveBeenCalled();
    expect(f.state.status).toBe('running'); // Worker success remains evidence for Ralph's next evaluation.
  });

  it('retains unknown execution and blocks replacement without stop proof', async () => {
    const f = await fixture();
    f.health.termination = 'uncertain';
    await f.cycle();
    await expect(f.cycle()).rejects.toThrow(/reconciliation/);
    expect(f.owner.sessionLauncher.launchWorker).toHaveBeenCalledTimes(1);
  });

  it('applies tighter Ralph ceilings before resolving and reserves the bounded result', async () => {
    const f = await fixture();
    f.state.config.budgetLimits = { total_tokens: 10000, wall_clock_minutes: 0.5 };
    await f.cycle();
    const record = Object.values(f.store.read().records)[0]!;
    expect(record.accounting!.reservation.tokens).toBe(10000);
    expect(record.allowance!.runBudgets).toMatchObject({ maxTokens: 10000, timeoutSeconds: 30 });
    vi.setSystemTime(new Date(Date.parse(now) + 30_000));
    await expect(f.cycle()).rejects.toThrow(/original deadline/);
    expect(f.owner.sessionLauncher.launchWorker).toHaveBeenCalledTimes(1);
  });

  it('waits for capacity on the same uncharged reservation', async () => {
    const f = await fixture();
    const policy = managedProjectAdmissionPolicy(root, f.cfg.parallelism!, workerConfigDigest(f.cfg.parallelism!.activation), 1);
    const scheduler = new SharedHostScheduler(f.store, policy);
    scheduler.submit({ requestId: 'blocker', orchestratorId: 'other', environment: 'default', provider: 'synthetic',
      runtimeKind: 'host', priority: 10, submittedAt: now, queueTimeoutMs: 60_000, managed: { kind: 'native' },
      allowance: { runId: 'other', taskId: 'other' } });
    const pending = f.cycle();
    await vi.waitFor(() => expect(Object.values(f.store.read().records).find(r => r.requestId !== 'blocker')?.state).toBe('queued'));
    const queued = Object.values(f.store.read().records).find(r => r.requestId !== 'blocker')!;
    expect(queued.accounting!.attemptNumber).toBeUndefined();
    scheduler.settle('blocker', 1, f.health as any, { quality: 'unknown', inputTokens: null, outputTokens: null,
      cacheTokens: null, reasoningTokens: null, costUsd: null, reservedTokens: 0, reservedUsd: null });
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(Object.values(f.store.read().records)).toHaveLength(2);
    expect(f.store.read().records[queued.requestId]!.accounting!.attemptNumber).toBe(1);
    expect(f.owner.sessionLauncher.launchWorker).toHaveBeenCalledTimes(1);
  });

  it.each(['execution', 'dispatch', 'mode'])('discloses %s drift before the existing resolver blocks a new launch', async change => {
    const f = await fixture(); await f.cycle();
    if (change === 'execution') f.cfg.parallelism!.groups!.workers.execution = { sandbox: 'none', approval: 'never' } as any;
    if (change === 'dispatch') f.cfg.parallelism!.worker_dispatch = false;
    if (change === 'mode') f.cfg.parallelism!.worker_mode = 'direct';
    await expect(f.cycle()).rejects.toThrow(/current launchable/);
    const evidence = JSON.parse(await readFile(join(root, 'cycle-2/session-attempt.json'), 'utf8'));
    expect(evidence.status).toBe('blocked');
    expect(evidence.changes.length).toBeGreaterThan(0);
    expect(f.owner.sessionLauncher.launchWorker).toHaveBeenCalledTimes(1);
  });

  it('compares saved managed bindings with fresh resolver bindings before continuation/fresh evidence', async () => {
    const f = await fixture();
    const options = { managedAdmission: { requestId: f.intent.requestId, generation: 1 } };
    const first = await managedWorkerAttempt(options, f.plan, { snapshot: f.snapshot, drivers: f.drivers }, now);
    expect(first).toMatchObject({ kind: 'fresh', reason: 'one-shot-profile', changes: [] });
    expect(await managedWorkerAttempt({ ...options, resumeSession: 'native-session' }, f.plan,
      { snapshot: f.snapshot, drivers: f.drivers }, now)).toMatchObject({ kind: 'fresh', reason: 'one-shot-continuation-unsupported' });
    f.snapshot.config.parallelism!.worker_dispatch = false;
    const changed = await managedWorkerAttempt({ ...options, attempt: first }, f.plan, { snapshot: f.snapshot, drivers: f.drivers }, now);
    expect(changed.status).toBe('blocked');
    expect(changed.changes.length).toBeGreaterThan(0);
    const published: any[] = [];
    const validation = vi.fn(async () => { throw new Error('unsafe binding change'); });
    await expect(validateManagedAttempt(options, f.plan, { snapshot: f.snapshot, drivers: f.drivers }, now,
      validation, async (attempt: any) => { published.push(structuredClone(attempt)); })).rejects.toThrow(/unsafe binding change/);
    expect(published.at(-1)).toMatchObject({ status: 'blocked', errorCode: 'PLAN_REVALIDATION_FAILED' });
    expect(published.at(-1).changes.length).toBeGreaterThan(0);
  });

  it('keeps SDLC synthesis and phase gates as completion owners', async () => {
    const skill = await readFile('agentic/code/frameworks/sdlc-complete/skills/orchestrate-project/SKILL.md', 'utf8');
    expect(skill).toContain('existing Ralph cycle or Mission/Flow owner');
    expect(skill).toContain('This skill does not dispatch workers');
    expect(skill).toContain('SDLC phase gates retain completion authority');
    const orchestrator = await readFile('tools/ralph-external/orchestrator.mjs', 'utf8');
    const launchIndex = orchestrator.indexOf('launchRalphCycle(this, state');
    expect(launchIndex).toBeGreaterThan(0);
    expect(orchestrator.indexOf('this.evalHarness.run(', launchIndex)).toBeGreaterThan(launchIndex);
    expect(orchestrator).toContain("state.status === 'budget_exhausted'");
  });
});
