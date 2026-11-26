import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcAdmissionScheduler, createMcFlowAdapter, mcHandler } from '../../../../src/cli/handlers/mc.js';
import { resolveParallelism, workerConfigDigest } from '../../../../src/config/aiwg-config.js';
import { bindManagedAdmissionPolicy, FileAdmissionStore, managedProjectAdmissionPolicy, projectAdmissionAuthority } from '../../../../src/serve/shared-host-scheduler.js';
import { revalidateWorkerInvocationPlan, resolveWorkerInvocation } from '../../../../src/serve/worker-invocation.js';
import * as invocationResolver from '../../../../src/serve/worker-invocation.js';
import { managedMcWorkerFixture } from '../../../fixtures/managed-mc-worker.js';

const mocks = vi.hoisted(() => ({ inputs: vi.fn(), config: vi.fn(), launch: vi.fn(), cancel: vi.fn() }));
vi.mock('../../../../src/cli/handlers/models.js', () => ({ loadWorkerInputs: mocks.inputs }));
vi.mock('../../../../src/config/aiwg-config.js', async original => ({
  ...await original<typeof import('../../../../src/config/aiwg-config.js')>(),
  readAiwgConfig: mocks.config, readAiwgConfigCandidate: mocks.config,
}));
vi.mock('../../../../src/cli/handlers/ralph-launcher.js', () => ({ launchExternalRalph: mocks.launch, cancelManagedRalph: mocks.cancel }));

let root: string;
let f: Awaited<ReturnType<typeof managedMcWorkerFixture>>;
let store: FileAdmissionStore;
const sessionId = 'mc-synthetic';
const requestId = 'synthetic-dispatch';
const missionId = `m-${createHash('sha256').update(requestId).digest('hex').slice(0, 16)}`;
const sessionRelative = `.aiwg/ralph-external/mc/sessions/${sessionId}/session.json`;
const frameworkRoot = process.cwd();
const call = (...args: string[]) => mcHandler.execute({ args, rawArgs: ['mc', ...args], cwd: root, frameworkRoot });
const current = async () => JSON.parse(await fs.readFile(join(root, sessionRelative), 'utf8'));
const dispatch = () => call('dispatch', sessionId, 'synthetic', '--completion', 'independent checks pass',
  '--request-id', requestId, '--worker-dispatch', f.paths.dispatch);
const health = (overrides = {}) => ({ version: 1, state: 'active', reasonCode: 'OK', termination: 'running',
  coverage: 'full', handshake: 'semantic', lastObservedAt: f.now, lastProgressAt: null, lastActivityAt: f.now,
  transitionCount: 1, restartCount: 0, transitionRefs: [], unavailableSignals: [],
  observerGeneration: 1, startupDeadlineAt: null, hardDeadlineAt: null, maxCheckGapSeconds: 15,
  confidence: 'observed', handshakeAt: f.now, stalledAt: null, ...overrides });

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'mc-worker-binding-'));
  f = await managedMcWorkerFixture(root, { sessionId, missionId });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(f.now));
  mocks.config.mockResolvedValue(f.cfg);
  mocks.inputs.mockResolvedValue({ snapshot: f.snapshot, drivers: f.drivers });
  mocks.launch.mockResolvedValue({ loopId: 'loop-synthetic', pid: 2147483601,
    execution: { pid: 2147483601, startedAt: 'synthetic-boot:123:1000' } });
  const parallelism = resolveParallelism(f.cfg.parallelism, 'codex');
  store = new FileAdmissionStore(projectAdmissionAuthority(root).path);
  bindManagedAdmissionPolicy(store, managedProjectAdmissionPolicy(root, parallelism,
    workerConfigDigest(parallelism.activation), parallelism.max_parallel_subagents));
  await fs.mkdir(join(root, `.aiwg/ralph-external/mc/sessions/${sessionId}`), { recursive: true });
  await fs.writeFile(join(root, sessionRelative), JSON.stringify({ id: sessionId, name: 'synthetic', state: 'active',
    maxMissions: 4, createdAt: f.now, updatedAt: f.now, missions: [] }));
  // MC's historical session paths are relative; map them without changing the
  // process working directory shared by concurrent suites.
  const rooted = (filename: any) => typeof filename === 'string' && !isAbsolute(filename) ? join(root, filename) : filename;
  for (const name of ['readFile', 'writeFile', 'mkdir', 'appendFile', 'open', 'unlink'] as const) {
    const original = fs[name].bind(fs) as (...args: any[]) => Promise<any>;
    vi.spyOn(fs, name as any).mockImplementation(((filename: any, ...args: any[]) => original(rooted(filename), ...args)) as any);
  }
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation((from, to) => rename(rooted(from), rooted(to)));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});

describe('T-OG-08 managed MC worker binding', () => {
  it('revalidates saved managed invocation through the shared resolver without admission', async () => {
    const invocation = await revalidateWorkerInvocationPlan(f.plan, f.snapshot, f.drivers, f.now);
    expect(invocation).toEqual(f.plan.invocation);
    expect(invocation.mode).toBe('managed');
    expect(Object.keys(store.read().records)).toHaveLength(0);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('rejects managed task authority on the direct resolver path', async () => {
    f.cfg.parallelism!.worker_mode = 'direct';
    const plan = await resolveWorkerInvocation(f.snapshot, f.request, f.drivers, f.now);
    expect(plan.invocation).toBeUndefined();
    expect(plan.status).toBe('blocked');
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('never renders a launchable direct command for managed config without parent authority', async () => {
    const { managedIntent, ...request } = f.request;
    const rejected = await resolveWorkerInvocation(f.snapshot, request, f.drivers, f.now);
    expect(rejected.invocation).toBeUndefined();
    expect(rejected.diagnostics.length).toBeGreaterThan(0);
    const brief = join(f.paths.workdir, 'direct-brief.txt');
    await fs.writeFile(brief, 'Synthetic direct task');
    const plan = await resolveWorkerInvocation(f.snapshot, { ...request, brief }, f.drivers, f.now);
    expect(plan.selected).toMatchObject({ group: 'workers', member: 'primary', cli: 'codex', model: f.brief.selected.model });
    expect(plan.invocation).toBeUndefined();
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code: 'OG_CONFIG_REFERENCE',
      message: expect.stringMatching(/managed.*parent/i) }));
    expect(Object.keys(store.read().records)).toHaveLength(0);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('queues prepared dispatch before run launches through shared external dimensions', async () => {
    expect((await dispatch()).exitCode).toBe(0);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(Object.keys(store.read().records)).toHaveLength(0);
    expect((await current()).missions[0].status).toBe('queued');
    expect((await call('run', sessionId, '--accept-cost')).exitCode).toBe(0);
    const record = store.read().records[f.intent.requestId]!;
    expect(record).toMatchObject({ state: 'admitted', reservedSlots: 1, leaseGeneration: 1,
      managed: { kind: 'external', group: 'workers', member: 'primary', cli: 'codex', quotaScope: 'synthetic-quota' } });
    const mission = (await current()).missions[0];
    expect(mission.extensions['aiwg.worker-dispatch']).toMatchObject({ invocationId: f.dispatch.invocationId, state: 'running' });
    expect(mocks.launch).toHaveBeenCalledWith(frameworkRoot, root, expect.objectContaining({
      managedAdmission: { requestId: f.intent.requestId, generation: 1 }, managedWorker: mission.managedWorker,
    }));
    const saved = JSON.parse(await fs.readFile(mission.managedWorker.invocationPath, 'utf8'));
    expect(saved.invocation).toMatchObject({ mode: 'managed', selected: f.brief.selected });
  });

  it('denies changed artifact bytes before admission or launch', async () => {
    await fs.appendFile(f.paths.intent, ' ');
    expect((await dispatch()).exitCode).toBe(1);
    expect((await current()).missions).toHaveLength(0);
    expect(Object.keys(store.read().records)).toHaveLength(0);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it.each(['symlink', 'hardlink', 'oversized'])('rejects %s artifacts before task data handoff', async kind => {
    if (kind === 'symlink') {
      const source = join(root, 'synthetic-intent.json');
      await fs.rename(f.paths.intent, source);
      await fs.symlink(source, f.paths.intent);
    } else if (kind === 'hardlink') {
      await fs.link(f.paths.intent, join(root, 'synthetic-intent.json'));
    } else await fs.appendFile(f.paths.intent, ' '.repeat(1048577));
    expect((await dispatch()).exitCode).toBe(1);
    expect((await current()).missions).toHaveLength(0);
    expect(Object.keys(store.read().records)).toHaveLength(0);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('rechecks prepared selection pins against the current qualified snapshot', async () => {
    expect((await dispatch()).exitCode).toBe(0);
    f.snapshot.constraints = { revokedModels: [f.plan.selected!.modelKey] };
    expect((await call('run', sessionId, '--accept-cost')).exitCode).toBe(1);
    expect(Object.keys(store.read().records)).toHaveLength(0);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('renews a running worker without assigning progress credit', async () => {
    await dispatch();
    await call('run', sessionId, '--accept-cost');
    const mission = (await current()).missions[0];
    const before = store.read().records[f.intent.requestId]!;
    await fs.mkdir(mission.managedWorker.runDir, { recursive: true });
    await fs.writeFile(join(mission.managedWorker.runDir, 'health.json'), JSON.stringify({ invocationId: f.dispatch.invocationId, health: health() }));
    vi.setSystemTime(new Date(Date.parse(f.now) + 1000));
    expect((await call('status', sessionId)).exitCode).toBe(0);
    const after = store.read().records[f.intent.requestId]!;
    expect(after.state).toBe('admitted');
    expect(Date.parse(after.leaseExpiresAt!)).toBeGreaterThan(Date.parse(before.leaseExpiresAt!));
    expect(after.lastProgressAt).toBeNull();
    expect((await current()).missions[0].status).toBe('running');
  });

  it.each(['missing', 'stale-generation'])('retains uncertain worker capacity for %s supervision', async scenario => {
    await dispatch();
    await call('run', sessionId, '--accept-cost');
    const mission = (await current()).missions[0];
    if (scenario === 'stale-generation') {
      await fs.mkdir(mission.managedWorker.runDir, { recursive: true });
      await fs.writeFile(join(mission.managedWorker.runDir, 'health.json'), JSON.stringify({ invocationId: f.dispatch.invocationId,
        health: health({ observerGeneration: 2, state: 'completed', termination: 'confirmed' }) }));
    }
    expect((await call('status', sessionId)).exitCode).toBe(0);
    const record = store.read().records[f.intent.requestId]!;
    expect(record).toMatchObject({ state: 'uncertain', reservedSlots: 1 });
    expect(record.finalEvidence).toBeUndefined();
    expect((await current()).missions[0].status).toBe('running');
    expect(mocks.launch).toHaveBeenCalledOnce();
  });

  it('keeps a successful worker final pending independent parent verification', async () => {
    expect((await dispatch()).exitCode).toBe(0);
    expect((await call('run', sessionId, '--accept-cost')).exitCode).toBe(0);
    const mission = (await current()).missions[0];
    await fs.mkdir(mission.managedWorker.runDir, { recursive: true });
    await fs.writeFile(join(mission.managedWorker.runDir, 'health.json'), JSON.stringify({ invocationId: f.dispatch.invocationId,
      health: health({ state: 'completed', termination: 'confirmed', lastProgressAt: f.now }) }));
    await fs.writeFile(join(mission.managedWorker.runDir, 'exit.json'), JSON.stringify({ invocationId: f.dispatch.invocationId,
      managedAdmission: { requestId: f.intent.requestId, generation: 1 }, exitCode: 0, endedAt: f.now,
      termination: 'confirmed', descendants: 'stopped' }));
    await fs.writeFile(f.paths.final, JSON.stringify({ version: 1, status: 'completed', summary: 'synthetic',
      claims: [], artifacts: [], checks: [], limitations: [] }));
    expect((await call('status', sessionId)).exitCode).toBe(0);
    const final = (await current()).missions[0];
    expect(final.status).toBe('paused');
    expect(final.completion).toBe('independent checks pass');
    const result = JSON.parse(await fs.readFile(fileURLToPath(final.extensions['aiwg.worker-dispatch'].result.ref), 'utf8'));
    expect(result).toMatchObject({ worker: { status: 'completed' }, verification: { status: 'pending' },
      execution: { usage: { quality: 'unknown', inputTokens: null, outputTokens: null } } });
  });
});

describe('T-OG-08 Flow project owner binding', () => {
  async function fixture() {
    f = await managedMcWorkerFixture(root, { sessionId, missionId, parentKind: 'flow' });
    mocks.config.mockResolvedValue(f.cfg);
    mocks.inputs.mockResolvedValue({ snapshot: f.snapshot, drivers: f.drivers });
    const prepareNode = vi.fn(async () => ({ objective: 'synthetic', dispatch: f.dispatch }));
    return { prepareNode, request: { runId: sessionId, node: { id: missionId },
      runResources: { tokens: 100000, activations: 4, timeMs: 1800000 } } };
  }

  it('shares native capacity and queues before calling the Flow execution owner', async () => {
    const { prepareNode, request } = await fixture();
    const scheduler = await createMcAdmissionScheduler(root, f.cfg);
    scheduler.submit({ requestId: 'native', orchestratorId: 'native-owner', environment: 'default', provider: 'codex',
      runtimeKind: 'host', priority: 10, submittedAt: f.now, queueTimeoutMs: 60000, managed: { kind: 'native' } });
    const invokeNode = vi.fn();
    const adapter = await createMcFlowAdapter({ args: [], rawArgs: [], cwd: root, frameworkRoot }, { prepareNode, invokeNode });
    await expect(adapter.invokeNode(request)).rejects.toMatchObject({ code: 'MANAGED_ADMISSION_BLOCKED' });
    expect(prepareNode).toHaveBeenCalledOnce();
    expect(invokeNode).not.toHaveBeenCalled();
    expect(store.read().records[f.intent.requestId]).toMatchObject({ state: 'queued',
      managed: { kind: 'external', group: 'workers', member: 'primary', cli: 'codex' } });
    expect(store.read().records.native).toMatchObject({ state: 'admitted', reservedSlots: 1 });
  });

  it('retains uncertain Flow capacity and spent usage after the execution owner returns', async () => {
    const { prepareNode, request } = await fixture();
    const resolve = vi.spyOn(invocationResolver, 'resolveWorkerInvocation');
    const invokeNode = vi.fn(async (_request: unknown, context: any) => {
      expect(context.prepared.routing).toMatchObject({ orchestrator: 'flow', resolved_tier: 'standard', resolved_model: f.plan.selected!.model });
      context.bindExecution({ pid: 2147483602, startedAt: 'synthetic-boot:123:1001' });
      return { outputs: { result: 'synthetic' }, usage: { tokens: 7, costUsd: null }, managedEvidence: {
        health: health({ state: 'completed', termination: 'uncertain' }),
        usage: { inputTokens: 5, outputTokens: 2, cacheTokens: null, reasoningTokens: null, costUsd: null,
          quality: 'reported', reservedTokens: f.intent.limits.tokens, reservedUsd: null },
      } };
    });
    const adapter = await createMcFlowAdapter({ args: [], rawArgs: [], cwd: root, frameworkRoot }, { prepareNode, invokeNode });
    await expect(adapter.invokeNode(request)).rejects.toMatchObject({ usage: { tokens: 7, costUsd: null } });
    expect(invokeNode).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith(f.snapshot, expect.objectContaining({ role: f.intent.role }), f.drivers);
    expect(store.read().records[f.intent.requestId]).toMatchObject({ state: 'uncertain', reservedSlots: 1 });
  });

  it('delivers qualified MCP Flow values only after shared proof settlement', async () => {
    const projectRoot = join(root, 'mcp-flow');
    f = await managedMcWorkerFixture(projectRoot, { sessionId, missionId, parentKind: 'flow', transport: 'mcp' });
    mocks.config.mockResolvedValue(f.cfg);
    mocks.inputs.mockResolvedValue({ snapshot: f.snapshot, drivers: f.drivers });
    const parallelism = resolveParallelism(f.cfg.parallelism, 'codex');
    const authority = new FileAdmissionStore(projectAdmissionAuthority(projectRoot).path);
    bindManagedAdmissionPolicy(authority, managedProjectAdmissionPolicy(projectRoot, parallelism,
      workerConfigDigest(parallelism.activation), parallelism.max_parallel_subagents));
    const invokeNode = vi.fn(async (_request: unknown, context: any) => {
      expect(context.prepared.invocation).toMatchObject({ mode: 'managed', transport: 'mcp',
        mcp: { serverRef: 'fixture-server', tool: 'fixture-worker' } });
      context.bindExecution({ pid: 2147483603, startedAt: 'synthetic-boot:123:1002' });
      return { outputs: { result: 'synthetic' }, usage: { tokens: 7, costUsd: null }, managedEvidence: {
        health: health({ state: 'completed', termination: 'confirmed' }),
        usage: { inputTokens: 5, outputTokens: 2, cacheTokens: null, reasoningTokens: null, costUsd: null,
          quality: 'reported', reservedTokens: f.intent.limits.tokens, reservedUsd: null },
      } };
    });
    const adapter = await createMcFlowAdapter({ args: [], rawArgs: [], cwd: projectRoot, frameworkRoot }, {
      prepareNode: async () => ({ objective: 'synthetic', dispatch: f.dispatch }), invokeNode,
    });
    await expect(adapter.invokeNode({ runId: sessionId, node: { id: missionId },
      runResources: { tokens: 100000, activations: 4, timeMs: 1800000 } }))
      .resolves.toMatchObject({ outputs: { result: 'synthetic' }, usage: { tokens: 7, costUsd: null },
        managedAdmission: { state: 'settled', generation: 1, requestId: f.intent.requestId } });
    expect(invokeNode).toHaveBeenCalledOnce();
    expect(authority.read().records[f.intent.requestId]).toMatchObject({ state: 'settled' });
    const scheduler = await createMcAdmissionScheduler(projectRoot, f.cfg);
    expect(scheduler.submit({ requestId: 'after-settlement', orchestratorId: 'native-owner', environment: 'default',
      provider: 'codex', runtimeKind: 'host', priority: 10, submittedAt: f.now, queueTimeoutMs: 60000,
      managed: { kind: 'native' } }).state).toBe('admitted');
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('rejects disabled managed mode before preparing or invoking a Flow node', async () => {
    const { prepareNode } = await fixture();
    f.cfg.parallelism!.worker_mode = 'direct';
    const invokeNode = vi.fn();
    await expect(createMcFlowAdapter({ args: [], rawArgs: [], cwd: root, frameworkRoot }, { prepareNode, invokeNode }))
      .rejects.toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(prepareNode).not.toHaveBeenCalled();
    expect(invokeNode).not.toHaveBeenCalled();
    expect(Object.keys(store.read().records)).toHaveLength(0);
  });
});
