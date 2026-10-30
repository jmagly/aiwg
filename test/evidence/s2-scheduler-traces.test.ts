import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  bindManagedAdmissionPolicy,
  FileAdmissionStore,
  managedProjectAdmissionPolicy,
  SharedHostScheduler,
  type AdmissionRequest,
  type AdmissionSnapshot,
  type SharedHostPolicy,
} from '../../src/serve/shared-host-scheduler.js';
import { mcHandler } from '../../src/cli/handlers/mc.js';
import { resolveParallelism, workerActivationDigests, workerConfigDigest, readAiwgConfig, readAiwgConfigCandidate, type AiwgConfig } from '../../src/config/aiwg-config.js';
import { cancelManagedRalph, launchExternalRalph } from '../../src/cli/handlers/ralph-launcher.js';
import { validateWorkerPayload, type WorkerHealthSummary } from '../../src/mission-protocol/index.js';
import { fixtureJson, materialize } from '../conformance/mission-v1/worker-contract-fixtures.js';
import { managedMcWorkerFixture } from '../fixtures/managed-mc-worker.js';
import { loadWorkerInputs } from '../../src/cli/handlers/models.js';

// Process launch, operator configuration and trusted installation inputs are substituted. Scheduler,
// FileAdmissionStore, MC handler, codecs and all filesystem operations are real.
vi.mock('../../src/cli/handlers/ralph-launcher.js', () => ({
  launchExternalRalph: vi.fn(async () => ({ loopId: 'ralph-s2', pid: 4242, message: 'synthetic' })),
  cancelManagedRalph: vi.fn(async () => ({ state: 'uncertain', signalled: true })),
}));
vi.mock('../../src/config/aiwg-config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/config/aiwg-config.js')>(),
  readAiwgConfigCandidate: vi.fn(async () => ({ providers: ['codex'], parallelism: { max_parallel_mc_missions: 1 } })),
  readAiwgConfig: vi.fn(async () => ({
    providers: ['codex'], parallelism: { max_parallel_mc_missions: 1 },
  })),
}));
vi.mock('../../src/cli/handlers/models.js', () => ({ loadWorkerInputs: vi.fn() }));

const root = process.cwd();
const outputPath = resolve(process.env.S2_TRACE_PATH ?? join(root, 'test-results/evidence/s2-traces.json'));
const start = Date.parse('2026-10-08T00:00:01Z');
const dirs: string[] = [];
const traces: Trace[] = [];

// These are the exact synthetic health shapes from the T-OG-24 mapping suite.
// That suite keeps its helpers private, so pin their values here without
// importing a test file (which would also register the mocked-boundary tests).
const baseHealth: WorkerHealthSummary = {
  version: 1, state: 'active', coverage: 'full', handshake: 'semantic',
  lastObservedAt: '2026-10-08T00:00:01Z', lastActivityAt: '2026-10-08T00:00:01Z',
  lastProgressAt: '2026-10-08T00:00:01Z', reasonCode: 'PROGRESS', termination: 'running',
  transitionCount: 3, restartCount: 0, unavailableSignals: [], transitionRefs: [],
  observerGeneration: 7, startupDeadlineAt: null, hardDeadlineAt: null,
  maxCheckGapSeconds: 15, confidence: 'observed', handshakeAt: '2026-10-08T00:00:00Z', stalledAt: null,
};
const confirmed = (observerGeneration: number | null): WorkerHealthSummary => ({
  ...baseHealth, state: 'completed', termination: 'confirmed', reasonCode: 'OK', observerGeneration,
});
const uncertain = (observerGeneration: number | null): WorkerHealthSummary => ({
  ...baseHealth, state: 'active', termination: 'uncertain', lastProgressAt: null,
  reasonCode: 'DISCONNECTED', observerGeneration,
});
const terminalUnconfirmed = (observerGeneration: number | null): WorkerHealthSummary => ({
  ...baseHealth, state: 'completed', termination: 'uncertain', reasonCode: 'OK', observerGeneration,
});
const vectors = fixtureJson('mission-vectors.json');
const dispatch = materialize(vectors.find((vector: { id: string }) => vector.id === 'dispatch-health-feature'), vectors);

type Verdict = 'PASS' | 'FAIL' | 'NOT-EXPRESSIBLE';
interface Step {
  operation: string;
  input: unknown;
  outcome: 'returned' | 'threw' | 'absent';
  result: unknown;
  snapshot: AdmissionSnapshot;
  changes: Record<string, { from: string | null; to: string | null }>;
  caller?: unknown;
}
interface Trace {
  gate: string;
  boundary: 'B-OG-12' | 'B-OG-16';
  mode: string;
  verdict: Verdict;
  reason: string;
  evidence: string[];
  steps: Step[];
}

function source(file: string, marker: string): string {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  const line = lines.findIndex(value => value.includes(marker));
  expect(line, `${file}: ${marker}`).toBeGreaterThanOrEqual(0);
  return `${file}:${line + 1}`;
}

const schedulerEvidence = [
  source('src/serve/shared-host-scheduler.ts', 'export interface AdmissionRecord'),
  source('src/serve/shared-host-scheduler.ts', 'renew(requestId: string'),
  source('src/serve/shared-host-scheduler.ts', 'release(requestId: string)'),
  source('src/serve/shared-host-scheduler.ts', 'cancel(requestId: string'),
];
const mappingSource = 'test/conformance/orchestration-v1/worker-health-lease-mapping.test.ts';

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiwg-s2-evidence-'));
  dirs.push(dir);
  return dir;
}

function request(requestId: string): AdmissionRequest {
  return {
    requestId, orchestratorId: 's2-owner', environment: 'synthetic', provider: 'codex',
    runtimeKind: 'container', priority: 10, submittedAt: new Date(start).toISOString(),
    queueTimeoutMs: 60_000, preemptible: false,
  };
}

function context(gate: string, mode: string, boundary: Trace['boundary'] = 'B-OG-12', storePath = join(tempDir(), 'admission.json'), managed = false, boundPolicy?: SharedHostPolicy) {
  let now = start;
  const policy: SharedHostPolicy = boundPolicy ?? {
    maxConcurrent: 1, leaseTtlMs: 10_000, agingIntervalMs: 1000, allowPreemption: false,
    ...(managed ? { managed: { authorityRef: 'project' as const, projectId: 'a'.repeat(64),
      policyDigest: `sha256:${'b'.repeat(64)}`, maxQueued: 10, dimensionCaps: {}, installations: {}, members: {} } } : {}),
  };
  if (managed || boundPolicy?.managed) bindManagedAdmissionPolicy(new FileAdmissionStore(storePath), policy);
  const create = () => new SharedHostScheduler(new FileAdmissionStore(storePath), policy, () => now);
  let scheduler = create();
  const trace: Trace = {
    gate, boundary, mode, verdict: 'NOT-EXPRESSIBLE', reason: '', evidence: [...schedulerEvidence], steps: [],
  };
  let prior = scheduler.snapshot();
  function record(operation: string, input: unknown, outcome: Step['outcome'], result: unknown, caller?: unknown) {
    const snapshot = scheduler.snapshot();
    // `diagnostics` is a derived read-only projection (#2926), never persisted;
    // every durable field must still match the store exactly.
    const { diagnostics, ...durable } = snapshot;
    expect(durable).toEqual(new FileAdmissionStore(storePath).read());
    expect(diagnostics).toEqual(expect.objectContaining({ findings: expect.any(Array), truncated: expect.any(Number) }));
    const changes: Step['changes'] = {};
    for (const id of new Set([...Object.keys(prior.records), ...Object.keys(snapshot.records)])) {
      const from = prior.records[id]?.state ?? null;
      const to = snapshot.records[id]?.state ?? null;
      if (from !== to) changes[id] = { from, to };
    }
    trace.steps.push({ operation, input, outcome, result: structuredClone(result), snapshot, changes, ...(caller ? { caller } : {}) });
    prior = snapshot;
  }
  function op(operation: string, input: unknown, run: () => unknown) {
    const before = scheduler.snapshot();
    let result: unknown;
    try {
      result = run();
    } catch (error) {
      // Only scheduler errors involving deterministic synthetic request IDs.
      const message = (error as Error).message;
      record(operation, input, 'threw', { message });
      expect(scheduler.snapshot()).toEqual(before);
      return { message };
    }
    record(operation, input, 'returned', result);
    return result;
  }
  function absent(operation: string, input: unknown, missing: string) {
    // This baseline exercises legacy dispatch; managed-only methods may now
    // exist on the shared owner without being part of the legacy contract.
    const before = scheduler.snapshot();
    record(operation, input, 'absent', { unavailableLegacyApi: missing });
    expect(scheduler.snapshot()).toEqual(before);
  }
  function missingGeneration(operation: string, input: unknown, method: 'renew' | 'cancel') {
    record(operation, input, 'absent', { method, legacyCallOmits: 'observedGeneration' });
  }
  function restart() {
    const before = scheduler.snapshot();
    scheduler = create();
    record('crash/restart: discard instance; reopen same FileAdmissionStore', {}, 'returned', null);
    expect(scheduler.snapshot()).toEqual(before);
  }
  return {
    trace, record, op, absent, missingGeneration, restart,
    get scheduler() { return scheduler; },
    advance(ms: number) {
      now += ms;
      record('advance injected clock', { milliseconds: ms }, 'returned', new Date(now).toISOString());
    },
    finish(verdict: Verdict, reason: string) {
      trace.verdict = verdict;
      trace.reason = reason;
      restart();
      traces.push(trace);
    },
  };
}

afterEach(() => {
  process.chdir(root);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(launchExternalRalph).mockReset();
  vi.mocked(cancelManagedRalph).mockClear();
  const legacyConfig = { providers: ['codex'], parallelism: { max_parallel_mc_missions: 1 } } as AiwgConfig;
  vi.mocked(readAiwgConfig).mockResolvedValue(legacyConfig);
  vi.mocked(readAiwgConfigCandidate).mockResolvedValue(legacyConfig);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const gates = [
  'renew-never-updates-progress',
  'expiry-never-releases',
  'cancel-disconnect-without-proof-retains-uncertainty',
  'stale-generation-denies-all-four-operations',
  'stale-confirmed-final-never-poisons-stop-proof',
  'late-final-after-cancel-disconnect-never-releases-while-uncertain',
  'confirmed-proof-settles-exactly-once',
  'uncertain-proof-never-settles',
  'confirmed-proof-generation-must-match-current-generation',
] as const;

describe.each(['uninterrupted', 'crash/restart'])('T-OG-24 real scheduler: %s', mode => {
  it.each(gates)('%s', gate => {
    const c = context(gate, mode);
    c.op('submit', request('r1'), () => c.scheduler.submit(request('r1')));
    c.op('submit capacity probe', request('waiting'), () => c.scheduler.submit(request('waiting')));
    expect(c.scheduler.snapshot().records.r1.state).toBe('admitted');
    expect(c.scheduler.snapshot().records.waiting.state).toBe('queued');
    if (mode === 'crash/restart') c.restart();

    if (gate === 'renew-never-updates-progress') {
      c.absent('admit health/progress at generation 3', { ...baseHealth, observerGeneration: 3 }, 'observeHealth');
      for (let index = 0; index < 2; index += 1) {
        c.advance(1000);
        const before = c.scheduler.snapshot().records.r1;
        c.op('renew', { requestId: 'r1', generationArgument: 'absent in API' }, () => c.scheduler.renew('r1'));
        expect(c.scheduler.snapshot().records.r1).toEqual({
          ...before, leaseExpiresAt: new Date(start + (index + 1) * 1000 + 10_000).toISOString(),
          revision: before.revision + 1, reason: 'lease renewed',
        });
      }
      expect(c.scheduler.snapshot().records.r1).not.toHaveProperty('lastProgressAt');
      c.finish('NOT-EXPRESSIBLE', 'Renew changes only lease expiry, revision and reason. The real record has no health/progress field or health ingestion API, so the progress-preservation gate needs the managed tier (#2919–#2924).');
    } else if (gate === 'expiry-never-releases') {
      c.advance(11_000);
      if (mode === 'crash/restart') c.restart();
      c.op('reconcileNow (lease expiry)', {}, () => c.scheduler.reconcileNow());
      expect(c.scheduler.snapshot().records.r1.state).toBe('timed-out');
      expect(c.scheduler.snapshot().records.waiting.state).toBe('admitted');
      c.op('renew expired lease', { requestId: 'r1' }, () => c.scheduler.renew('r1'));
      expect(c.trace.steps.at(-1)?.result).toEqual({ message: 'cannot renew timed-out admission' });
      c.absent('settle expired lease', { requestId: 'r1', observedGeneration: 3 }, 'settle');
      c.trace.evidence.push(source('src/serve/shared-host-scheduler.ts', 'admission lease expired; capacity recovered'));
      c.finish('FAIL', 'Expiry recovers capacity without stop proof: r1 becomes timed-out and waiting is admitted. Record retention is not capacity retention. Managed uncertainty/stop-proof behavior requires #2919–#2924.');
    } else if (gate === 'cancel-disconnect-without-proof-retains-uncertainty') {
      c.op('cancel without stop proof', { requestId: 'r1' }, () => c.scheduler.cancel('r1'));
      expect(c.scheduler.snapshot().records.r1.state).toBe('cancelled');
      expect(c.scheduler.snapshot().records.waiting.state).toBe('admitted');
      c.absent('disconnect', { requestId: 'r1', observedGeneration: 3 }, 'cancelDisconnect');
      c.finish('FAIL', 'The cancel path releases capacity without stop proof; no uncertain state or disconnect API exists. Disconnect itself is NOT-EXPRESSIBLE until the managed tier (#2919–#2924).');
    } else if (gate === 'stale-generation-denies-all-four-operations') {
      c.absent('observeHealth current proof', { requestId: 'r1', health: confirmed(3) }, 'observeHealth');
      c.missingGeneration('renew with observedGeneration=2', { requestId: 'r1', observedGeneration: 2 }, 'renew');
      c.op('unfenced renew probe (only real argument: requestId)', { requestId: 'r1' }, () => c.scheduler.renew('r1'));
      c.missingGeneration('cancel with observedGeneration=4', { requestId: 'r1', observedGeneration: 4 }, 'cancel');
      c.op('unfenced cancel probe (only real argument: requestId)', { requestId: 'r1' }, () => c.scheduler.cancel('r1'));
      c.absent('settle stale generation', { requestId: 'r1', observedGeneration: 2 }, 'settle');
      c.absent('acceptFinal stale generation', { requestId: 'r1', final: { late: true }, health: confirmed(4) }, 'acceptFinal');
      expect(c.scheduler.snapshot().records.r1.state).toBe('cancelled');
      expect(c.scheduler.snapshot().records.r1).not.toHaveProperty('generation');
      c.finish('NOT-EXPRESSIBLE', 'Renew/cancel take only requestId; no generation-bearing renew/cancel, settle or acceptFinal API exists. Unfenced probes are successful but are not stale-generation tests. Requires managed fencing (#2919–#2924).');
    } else if (gate === 'stale-confirmed-final-never-poisons-stop-proof') {
      c.absent('acceptFinal stale proof', { requestId: 'r1', final: { stale: true }, health: confirmed(2) }, 'acceptFinal');
      c.absent('settle current claim without proof', { requestId: 'r1', observedGeneration: 3 }, 'settle');
      c.absent('observeHealth current proof', { requestId: 'r1', health: confirmed(3) }, 'observeHealth');
      c.absent('settle current proof', { requestId: 'r1', observedGeneration: 3 }, 'settle');
      c.finish('NOT-EXPRESSIBLE', 'No final acceptance, stored health/stop proof, generation or settlement API. Stale-proof poisoning cannot be traced before managed tier #2919–#2924.');
    } else if (gate === 'late-final-after-cancel-disconnect-never-releases-while-uncertain') {
      c.op('available cancel path', { requestId: 'r1' }, () => c.scheduler.cancel('r1'));
      c.absent('cancelDisconnect', { requestId: 'r1', observedGeneration: 3 }, 'cancelDisconnect');
      c.absent('acceptFinal terminal but uncertain', { requestId: 'r1', final: { late: true }, health: terminalUnconfirmed(3) }, 'acceptFinal');
      c.absent('settle', { requestId: 'r1', observedGeneration: 3 }, 'settle');
      expect(c.scheduler.snapshot().records.waiting.state).toBe('admitted');
      c.finish('NOT-EXPRESSIBLE', 'Cancel already recovers capacity; uncertain ownership, disconnect, final acceptance and settlement do not exist. No claim about late-final handling is possible until managed tier #2919–#2924.');
    } else if (gate === 'confirmed-proof-settles-exactly-once') {
      c.absent('settle before proof', { requestId: 'r1', observedGeneration: 3 }, 'settle');
      c.absent('observeHealth confirmed', { requestId: 'r1', health: confirmed(3) }, 'observeHealth');
      c.absent('settle confirmed', { requestId: 'r1', observedGeneration: 3 }, 'settle');
      c.absent('settle replay', { requestId: 'r1', observedGeneration: 3 }, 'settle');
      c.absent('acceptFinal replay', { requestId: 'r1', final: { replay: true }, health: confirmed(3) }, 'acceptFinal');
      // Diagnostic only: release is not an alias for proof-checked settlement.
      c.op('unguarded release probe', { requestId: 'r1' }, () => c.scheduler.release('r1'));
      c.op('unguarded release replay probe', { requestId: 'r1' }, () => c.scheduler.release('r1'));
      expect(c.trace.steps.at(-1)?.result).toEqual({ message: "unknown admission request 'r1'" });
      c.finish('NOT-EXPRESSIBLE', 'release deletes a record without proof and its replay throws unknown request; this is not managed exactly-once settlement. observeHealth/settle/acceptFinal require #2919–#2924.');
    } else if (gate === 'uncertain-proof-never-settles') {
      c.absent('observeHealth uncertain', { requestId: 'r1', health: uncertain(3) }, 'observeHealth');
      c.absent('settle uncertain', { requestId: 'r1', observedGeneration: 3 }, 'settle');
      c.absent('acceptFinal uncertain', { requestId: 'r1', final: { tentative: true }, health: uncertain(3) }, 'acceptFinal');
      c.finish('NOT-EXPRESSIBLE', 'No health ingestion, proof storage, settle or acceptFinal API exists. Uncertain-proof settlement needs managed tier #2919–#2924.');
    } else {
      c.absent('settle stale proof with current asserted generation', {
        requestId: 'r1', leaseGeneration: 3, observedGeneration: 3, health: confirmed(2), settled: false,
      }, 'settle');
      c.absent('settle current proof with current asserted generation', {
        requestId: 'r1', leaseGeneration: 3, observedGeneration: 3, health: confirmed(3), settled: false,
      }, 'settle');
      c.absent('acceptFinal null observerGeneration (zero bridge vector)', {
        requestId: 'r1', final: { late: true }, health: confirmed(null),
      }, 'acceptFinal');
      c.absent('acceptFinal null observerGeneration for generation-zero lease', {
        requestId: 'r0', leaseGeneration: 0, final: { final: true }, health: confirmed(null),
      }, 'acceptFinal');
      c.finish('NOT-EXPRESSIBLE', 'Neither current lease generation nor proof generation is represented; no settlement/final acceptance boundary exists. The pure mapping function is not a runtime substitute. Requires #2919–#2924.');
    }
  });
});

// Managed runtime cases are separate from the legacy diagnostic baseline above.
// They use the same T-OG-24 health vectors and durable scheduler boundary.
describe.each(['uninterrupted', 'crash/restart'])('T-OG-24 managed scheduler: %s', mode => {
  it.each(gates)('%s', gate => {
    const c = context(gate, `managed ${mode}`, 'B-OG-12', join(tempDir(), 'managed.json'), true);
    const managedRequest = (id: string): AdmissionRequest => ({
      ...request(id), managed: { kind: 'native' },
      allowance: { runId: 's2-owner', taskId: id, reservation: { tokens: 1, costUsd: 1 } },
    });
    const usage = { quality: 'unknown' as const, inputTokens: null, outputTokens: null, cacheTokens: null,
      reasoningTokens: null, costUsd: null, reservedTokens: 1, reservedUsd: 1 };
    c.op('managed submit', managedRequest('r1'), () => c.scheduler.submit(managedRequest('r1')));
    c.op('managed capacity probe', managedRequest('waiting'), () => c.scheduler.submit(managedRequest('waiting')));
    const generation = c.scheduler.snapshot().records.r1.leaseGeneration!;
    const proof = confirmed(generation);
    const pending = uncertain(generation);
    const stale = confirmed(generation - 1);
    const health = { ...baseHealth, observerGeneration: generation };
    expect(generation).toBeGreaterThan(0);
    expect(c.scheduler.snapshot().records.waiting.state).toBe('queued');
    if (mode === 'crash/restart') c.restart();
    const retains = () => {
      expect(c.scheduler.snapshot().records.r1.state).toBe('uncertain');
      expect(c.scheduler.snapshot().records.waiting.state).toBe('queued');
    };
    const settle = (value: WorkerHealthSummary | null = proof) =>
      c.op('managed settle', { requestId: 'r1', observedGeneration: generation, health: value },
        () => c.scheduler.settle('r1', generation, value, usage));
    const final = (value: WorkerHealthSummary, observedGeneration = generation) =>
      c.op('managed acceptFinal', { requestId: 'r1', observedGeneration, health: value },
        () => c.scheduler.acceptFinal('r1', observedGeneration, value));

    if (gate === 'renew-never-updates-progress') {
      c.op('managed observeHealth', { requestId: 'r1', health }, () => c.scheduler.observeHealth('r1', generation, health));
      for (let index = 0; index < 2; index += 1) {
        c.advance(1000);
        const before = c.scheduler.snapshot().records.r1;
        c.op('managed renew', { requestId: 'r1', generation }, () => c.scheduler.renew('r1', generation));
        const after = c.scheduler.snapshot().records.r1;
        expect(after).toEqual({ ...before, leaseExpiresAt: new Date(start + (index + 1) * 1000 + 10_000).toISOString(),
          revision: before.revision + 1, reason: 'lease renewed' });
      }
    } else if (gate === 'expiry-never-releases') {
      c.advance(11_000);
      if (mode === 'crash/restart') c.restart();
      c.op('managed reconcile expiry', {}, () => c.scheduler.reconcileNow());
      retains();
      settle(null);
      retains();
    } else if (gate === 'cancel-disconnect-without-proof-retains-uncertainty') {
      c.op('managed stop', { requestId: 'r1', generation }, () => c.scheduler.stop('r1', generation, 'cancel'));
      retains();
      c.op('managed disconnect', { requestId: 'r1', generation }, () => c.scheduler.disconnect('r1', generation));
      retains();
      for (const reason of ['observer-loss', 'preempt'] as const) {
        c.op(`managed ${reason}`, { requestId: 'r1', generation }, () => c.scheduler.stop('r1', generation, reason));
        retains();
      }
      settle(null);
      retains();
    } else if (gate === 'stale-generation-denies-all-four-operations') {
      c.op('managed observe current proof', { health: proof }, () => c.scheduler.observeHealth('r1', generation, proof));
      const before = c.scheduler.snapshot();
      for (const [name, run] of [
        ['renew', () => c.scheduler.renew('r1', generation - 1)],
        ['stop', () => c.scheduler.stop('r1', generation + 1)],
        ['settle', () => c.scheduler.settle('r1', generation - 1, proof, usage)],
        ['acceptFinal', () => c.scheduler.acceptFinal('r1', generation + 1, confirmed(generation + 1))],
      ] as const) {
        c.op(`managed stale ${name}`, { observedGeneration: name === 'stop' || name === 'acceptFinal' ? generation + 1 : generation - 1 }, run);
        expect(c.trace.steps.at(-1)?.outcome).toBe('threw');
        expect(c.scheduler.snapshot()).toEqual(before);
      }
    } else if (gate === 'stale-confirmed-final-never-poisons-stop-proof') {
      final(stale, generation - 1);
      expect(c.trace.steps.at(-1)?.outcome).toBe('threw');
      expect(c.scheduler.snapshot().records.r1.accounting?.stopEvidence).toBeUndefined();
      settle(null);
      retains();
      c.op('managed observe current proof', { health: proof }, () => c.scheduler.observeHealth('r1', generation, proof));
      settle();
      expect(c.scheduler.snapshot().records.r1.state).toBe('settled');
      expect(c.scheduler.snapshot().records.r1.accounting?.stopEvidence?.observerGeneration).toBe(generation);
    } else if (gate === 'late-final-after-cancel-disconnect-never-releases-while-uncertain') {
      c.op('managed cancel', { generation }, () => c.scheduler.cancel('r1', generation));
      c.op('managed disconnect', { generation }, () => c.scheduler.disconnect('r1', generation));
      final(terminalUnconfirmed(generation));
      retains();
      settle(terminalUnconfirmed(generation));
      retains();
    } else if (gate === 'confirmed-proof-settles-exactly-once') {
      settle(null);
      retains();
      c.op('managed observe confirmed', { health: proof }, () => c.scheduler.observeHealth('r1', generation, proof));
      settle();
      expect(c.scheduler.snapshot().records.r1.state).toBe('settled');
      expect(c.scheduler.snapshot().records.waiting.state).toBe('admitted');
      const once = c.scheduler.snapshot().records.r1;
      settle();
      expect(c.scheduler.snapshot().records.r1).toEqual(once);
      final(proof);
      expect(c.scheduler.snapshot().records.r1.state).toBe('settled');
      expect(c.scheduler.snapshot().records.waiting.accounting?.attemptNumber).toBe(1);
    } else if (gate === 'uncertain-proof-never-settles') {
      c.op('managed observe uncertain', { health: pending }, () => c.scheduler.observeHealth('r1', generation, pending));
      settle(pending);
      retains();
      final(pending);
      retains();
    } else {
      settle(stale);
      retains();
      expect(c.scheduler.snapshot().records.r1.accounting?.stopEvidence).toBeUndefined();
      final(confirmed(null));
      expect(c.trace.steps.at(-1)?.outcome).toBe('threw');
      retains();
      settle();
      expect(c.scheduler.snapshot().records.r1.state).toBe('settled');
      expect(c.scheduler.snapshot().records.waiting.state).toBe('admitted');
    }
    c.finish('PASS', 'Managed current-generation runtime assertions passed with retained uncertain capacity and proof-checked settlement; reopened durable state is unchanged.');
  });
});

describe('B-OG-16 real MC caller binding', () => {
  const events = ['running', 'completed', 'failed', 'crashed', 'aborted', 'paused', 'missing-state', 'abort-command', 'launch-failure', 'worker-dispatch'] as const;
  it.each(events)('%s', async event => {
    const dir = tempDir();
    const sessionDir = join(dir, '.aiwg/ralph-external/mc/sessions/mc-s2');
    const storePath = join(dir, '.aiwg/ralph-external/mc/admission.json');
    const statePath = join(dir, '.aiwg/ralph-external/loops/ralph-s2/session-state.json');
    const c = context(`mc-${event}`, 'real handler with synthetic Ralph state', 'B-OG-16', storePath);
    c.trace.evidence = [
      source('src/cli/handlers/mc-run.ts', 'const admission = scheduler.submit('),
      source('src/cli/handlers/mc-status.ts', 'const ralphStatus = String(state.status'),
      source('src/cli/handlers/mc-status.ts', 'try { scheduler.release(mission.admissionRequestId); }'),
      source('src/cli/handlers/mc-status.ts', 'const renewed = managed'),
      source('src/cli/handlers/mc-control.ts', 'scheduler.cancel(mission.admissionRequestId)'),
    ];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    vi.stubEnv('AIWG_ENVIRONMENT', 'synthetic');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.chdir(dir);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      id: 'mc-s2', name: 'synthetic', state: 'active', maxMissions: 2,
      createdAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString(),
      missions: [{
        id: 'm1', objective: 'Synthetic task', completion: 'Synthetic check passes',
        status: 'queued', loop: 0, maxIterations: 1, priority: 'normal', mode: 'direct',
        ...(event === 'worker-dispatch' ? { extensions: { 'aiwg.worker-dispatch': dispatch } } : {}),
      }],
    }));
    function caller() {
      const session = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8'));
      const mission = session.missions[0];
      return { sessionState: session.state, missionStatus: mission.status, loop: mission.loop,
        admissionState: mission.admissionState ?? null, admissionRequestId: mission.admissionRequestId ?? null };
    }
    let inCommand = false;
    function observe<T>(operation: string, input: unknown, run: () => T): T {
      if (!inCommand) return run();
      let result: T;
      try {
        result = run();
      } catch (error) {
        c.record(operation, input, 'threw', { message: (error as Error).message }, caller());
        throw error;
      }
      c.record(operation, input, 'returned', result, caller());
      return result;
    }
    // Pass-through observers capture every internal scheduler operation, even
    // submit followed by release within one failed MC launch command.
    const { submit, renew, cancel, release } = SharedHostScheduler.prototype;
    vi.spyOn(SharedHostScheduler.prototype, 'submit').mockImplementation(function (this: SharedHostScheduler, input) {
      return observe('scheduler.submit (MC caller)', input, () => submit.call(this, input));
    });
    vi.spyOn(SharedHostScheduler.prototype, 'renew').mockImplementation(function (this: SharedHostScheduler, requestId) {
      return observe('scheduler.renew (MC caller)', { requestId }, () => renew.call(this, requestId));
    });
    vi.spyOn(SharedHostScheduler.prototype, 'cancel').mockImplementation(function (this: SharedHostScheduler, requestId) {
      return observe('scheduler.cancel (MC caller)', { requestId }, () => cancel.call(this, requestId));
    });
    vi.spyOn(SharedHostScheduler.prototype, 'release').mockImplementation(function (this: SharedHostScheduler, requestId) {
      return observe('scheduler.release (MC caller)', { requestId }, () => release.call(this, requestId));
    });
    async function command(args: string[]) {
      inCommand = true;
      let result;
      try {
        result = await mcHandler.execute({ args, rawArgs: ['mc', ...args], cwd: dir, frameworkRoot: root });
      } finally {
        inCommand = false;
      }
      c.record(`mc ${args[0]}`, { args }, 'returned', { exitCode: result.exitCode }, caller());
      expect(result.exitCode).toBe(['launch-failure', 'worker-dispatch'].includes(event) && args[0] === 'run' ? 1 : 0);
      return result;
    }
    c.record('seed synthetic MC session', { sessionId: 'mc-s2', missionId: 'm1' }, 'returned', null, caller());
    if (event === 'launch-failure') vi.mocked(launchExternalRalph).mockRejectedValueOnce(new Error('synthetic launch failure'));
    else vi.mocked(launchExternalRalph).mockResolvedValueOnce({ loopId: 'ralph-s2', pid: 4242, message: 'synthetic' });
    const runResult = await command(['run', 'mc-s2', '--accept-cost']);
    if (event === 'worker-dispatch') {
      expect(runResult.message).toContain('OG_CONTRACT_UNSUPPORTED');
      expect(launchExternalRalph).not.toHaveBeenCalled();
      expect(c.scheduler.snapshot().records).toEqual({});
      expect(caller().missionStatus).toBe('queued');
      c.trace.evidence.push(source('src/cli/handlers/mc-run.ts', "assertMissionWorkerHandoff(mission, 'mc-cli', support)"));
      c.finish('NOT-EXPRESSIBLE', 'The shared dispatch-health-feature fixture is rejected with OG_CONTRACT_UNSUPPORTED before admission or launch. Legacy MC binding exists, but managed health caller events require #2919–#2924.');
      return;
    }
    expect(launchExternalRalph).toHaveBeenCalledTimes(1);
    if (event === 'launch-failure') {
      expect(c.scheduler.snapshot().records).toEqual({});
      expect(caller().missionStatus).toBe('failed');
      c.finish('PASS', 'Observed legacy launch-error path: MC releases admission and marks failed. Process launch is stubbed; no managed stop-proof claim.');
      return;
    }
    expect(c.scheduler.snapshot().records['mc-s2.m1'].state).toBe('admitted');
    // MC uses a five-minute lease; the waiting request proves capacity effects.
    c.op('submit capacity probe', request('waiting'), () => c.scheduler.submit(request('waiting')));
    c.restart();
    if (event === 'abort-command') {
      await command(['abort', 'mc-s2', 'm1', '--request-id', 'cancel-s2']);
      expect(c.scheduler.snapshot().records['mc-s2.m1'].state).toBe('cancelled');
      expect(c.scheduler.snapshot().records.waiting.state).toBe('admitted');
      const cancelled = c.scheduler.snapshot();
      await command(['abort', 'mc-s2', 'm1', '--request-id', 'cancel-s2']);
      expect(c.scheduler.snapshot()).toEqual(cancelled);
      c.finish('FAIL', 'Real MC abort cancels admission and admits waiting work without stop proof; idempotent command replay leaves the snapshot unchanged. Managed uncertainty retention requires #2919–#2924.');
      return;
    }
    if (event !== 'missing-state') {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ status: event, iteration: 2 }));
      c.record('write synthetic Ralph status', { status: event, iteration: 2 }, 'returned', null, caller());
    } else {
      c.record('Ralph state absent (disconnect proxy, not a health event)', {}, 'returned', null, caller());
    }
    vi.setSystemTime(start + 1000);
    c.record('advance MC Date clock', { milliseconds: 1000 }, 'returned', null, caller());
    const before = c.scheduler.snapshot();
    await command(['status', 'mc-s2', '--json']);
    if (event === 'running') {
      expect(caller().missionStatus).toBe('running');
      expect(caller().loop).toBe(2);
      expect(c.scheduler.snapshot().records['mc-s2.m1'].leaseExpiresAt).toBe(new Date(start + 301_000).toISOString());
      expect(c.scheduler.snapshot().records.waiting.state).toBe('queued');
      c.finish('PASS', 'Observed legacy running status: iteration is copied and admission renewed. No health/progress credit or managed-generation claim.');
    } else if (event === 'missing-state') {
      expect(c.scheduler.snapshot()).toEqual(before);
      expect(caller().missionStatus).toBe('running');
      c.finish('NOT-EXPRESSIBLE', 'Missing Ralph state leaves status/lease unchanged, but no WorkerHealthSummary disconnect/uncertain event is bound to the scheduler. B-OG-16 health mapping requires #2919–#2924.');
    } else {
      expect(caller().missionStatus).toBe(event === 'completed' ? 'done' : event === 'crashed' ? 'failed' : event);
      expect(c.scheduler.snapshot().records['mc-s2.m1']).toBeUndefined();
      expect(c.scheduler.snapshot().records.waiting.state).toBe('admitted');
      const released = c.scheduler.snapshot();
      await command(['status', 'mc-s2', '--json']);
      expect(c.scheduler.snapshot()).toEqual(released);
      c.finish('FAIL', `Real MC maps Ralph ${event} to a terminal/paused mission and releases capacity based only on a status string, without health/stop proof. Managed proof-gated B-OG-16 behavior requires #2919–#2924.`);
    }
  });
});

describe('B-OG-16 managed real MC caller binding', () => {
  const events = ['running', 'completed', 'failed', 'crashed', 'aborted', 'paused', 'missing-state', 'abort-command', 'launch-failure', 'worker-dispatch'] as const;
  it.each(events)('%s', async event => {
    const dir = tempDir();
    const sessionDir = join(dir, '.aiwg/ralph-external/mc/sessions/mc-s2');
    const sessionPath = join(sessionDir, 'session.json');
    const storePath = join(dir, '.aiwg/ralph-external/mc/admission.json');
    const statePath = join(dir, '.aiwg/ralph-external/loops/ralph-s2/session-state.json');
    let cfg = {
      version: '1', providers: ['codex'], installed: {}, scripts: {},
      parallelism: { worker_dispatch: true, worker_mode: 'managed', max_parallel_subagents: 1,
        groups: { coding: { members: [{ id: 'spark', cli: 'first', model: 'model', roles: ['coding'] }] } },
        clis: { first: { adapter: 'providers:codex', accountScope: 'synthetic-account', quotaScope: 'synthetic-quota' } },
        admission: { maxQueued: 2, queueTimeoutSeconds: 60 },
        budgets: { perTask: { tokens: 10, costUsd: 1 } },
      },
    } as AiwgConfig;
    cfg.parallelism!.activation = { revision: 1, ...workerActivationDigests(cfg), snapshotRef: 'synthetic:activation' };
    const worker = event === 'worker-dispatch' ? await managedMcWorkerFixture(dir, {
      sessionId: 'mc-s2', missionId: 'm1', objective: 'Synthetic task', now: new Date(start).toISOString(),
    }) : undefined;
    if (worker) {
      cfg = worker.cfg;
      vi.mocked(loadWorkerInputs).mockResolvedValue({ snapshot: worker.snapshot, drivers: worker.drivers });
    }
    mkdirSync(join(dir, '.aiwg'), { recursive: true }); writeFileSync(join(dir, '.aiwg/aiwg.config'), JSON.stringify(cfg));
    const parallelism = resolveParallelism(cfg.parallelism, 'codex');
    const policy = managedProjectAdmissionPolicy(dir, parallelism, workerConfigDigest(parallelism.activation), parallelism.max_parallel_subagents);
    const c = context(`mc-${event}`, 'managed real handler with synthetic Ralph state', 'B-OG-16', storePath, true, policy);
    vi.mocked(readAiwgConfig).mockResolvedValue(cfg);
    vi.mocked(readAiwgConfigCandidate).mockResolvedValue(cfg);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    vi.stubEnv('AIWG_ENVIRONMENT', 'synthetic');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.chdir(dir);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(sessionPath, JSON.stringify({
      id: 'mc-s2', name: 'synthetic', state: 'active', maxMissions: 2,
      createdAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString(),
      missions: [{ id: 'm1', objective: 'Synthetic task', completion: 'Synthetic check passes',
        status: 'queued', loop: 0, maxIterations: 1, priority: 'normal', mode: 'direct',
        ...(event === 'worker-dispatch' ? { extensions: { 'aiwg.worker-dispatch': worker!.dispatch } } : {}),
      }],
    }));
    const caller = () => {
      const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
      const mission = session.missions[0];
      return { sessionState: session.state, missionStatus: mission.status, loop: mission.loop,
        admissionState: mission.admissionState ?? null, admissionGeneration: mission.admissionGeneration ?? null,
        admissionExecution: mission.admissionExecution ?? null, admissionRequestId: mission.admissionRequestId ?? null };
    };
    let inCommand = false;
    function observe<T>(operation: string, input: unknown, run: () => T): T {
      if (!inCommand) return run();
      try {
        const result = run();
        c.record(operation, input, 'returned', result, caller());
        return result;
      } catch (error) {
        c.record(operation, input, 'threw', { message: (error as Error).message }, caller());
        throw error;
      }
    }
    const { submit, renew, cancel, stop, disconnect, claimLaunch, bindExecution } = SharedHostScheduler.prototype;
    vi.spyOn(SharedHostScheduler.prototype, 'submit').mockImplementation(function (this: SharedHostScheduler, input) {
      return observe('managed scheduler.submit (MC caller)', input, () => submit.call(this, input));
    });
    vi.spyOn(SharedHostScheduler.prototype, 'renew').mockImplementation(function (this: SharedHostScheduler, requestId, generation) {
      return observe('managed scheduler.renew (MC caller)', { requestId, generation }, () => renew.call(this, requestId, generation));
    });
    vi.spyOn(SharedHostScheduler.prototype, 'cancel').mockImplementation(function (this: SharedHostScheduler, requestId, generation) {
      return observe('managed scheduler.cancel (MC caller)', { requestId, generation }, () => cancel.call(this, requestId, generation));
    });
    vi.spyOn(SharedHostScheduler.prototype, 'stop').mockImplementation(function (this: SharedHostScheduler, requestId, generation, reason) {
      return observe('managed scheduler.stop (MC caller)', { requestId, generation, reason }, () => stop.call(this, requestId, generation, reason));
    });
    vi.spyOn(SharedHostScheduler.prototype, 'disconnect').mockImplementation(function (this: SharedHostScheduler, requestId, generation) {
      return observe('managed scheduler.disconnect (MC caller)', { requestId, generation }, () => disconnect.call(this, requestId, generation));
    });
    vi.spyOn(SharedHostScheduler.prototype, 'claimLaunch').mockImplementation(function (this: SharedHostScheduler, requestId, generation) {
      return observe('managed scheduler.claimLaunch (MC caller)', { requestId, generation }, () => claimLaunch.call(this, requestId, generation));
    });
    vi.spyOn(SharedHostScheduler.prototype, 'bindExecution').mockImplementation(function (this: SharedHostScheduler, requestId, generation, execution) {
      return observe('managed scheduler.bindExecution (MC caller)', { requestId, generation, execution }, () => bindExecution.call(this, requestId, generation, execution));
    });
    async function command(args: string[]) {
      inCommand = true;
      let result;
      try { result = await mcHandler.execute({ args, rawArgs: ['mc', ...args], cwd: dir, frameworkRoot: root }); }
      finally { inCommand = false; }
      c.record(`managed mc ${args[0]}`, { args }, 'returned', { exitCode: result.exitCode }, caller());
      expect(result.exitCode).toBe(event === 'launch-failure' && args[0] === 'run' ? 1 : 0);
      return result;
    }
    const execution = { pid: 4242, startedAt: 'synthetic-boot:4242:1000' };
    if (event === 'launch-failure') vi.mocked(launchExternalRalph).mockRejectedValueOnce(new Error('synthetic launch failure'));
    else vi.mocked(launchExternalRalph).mockResolvedValueOnce({ loopId: 'ralph-s2', pid: 4242, execution, message: 'synthetic' });
    await command(['run', 'mc-s2', '--accept-cost']);
    expect(launchExternalRalph).toHaveBeenCalledTimes(1);
    c.op('managed MC capacity probe', { requestId: 'waiting' }, () => c.scheduler.submit({
      ...request('waiting'), managed: { kind: 'native' },
      allowance: { runId: 's2-owner', taskId: 'waiting', reservation: { tokens: 1, costUsd: 1 } },
    }));
    c.restart();
    const retained = () => {
      expect(c.scheduler.snapshot().records['mc-s2.m1'].state).toBe('uncertain');
      expect(c.scheduler.snapshot().records.waiting.state).toBe('queued');
      expect(c.scheduler.snapshot().records['mc-s2.m1'].accounting?.stopEvidence).toBeUndefined();
    };
    if (event === 'launch-failure') {
      retained();
      expect(caller().missionStatus).toBe('failed');
      c.finish('PASS', 'Managed launch failure retains uncertain capacity across durable reopen without process termination proof.');
      return;
    }
    expect(caller().admissionGeneration).toBe(1);
    expect(caller().admissionExecution).toEqual(execution);
    expect(c.scheduler.snapshot().records['mc-s2.m1'].execution).toEqual(execution);
    if (event === 'worker-dispatch') {
      const checkpoint = JSON.parse(readFileSync(sessionPath, 'utf8')).missions[0];
      expect(c.scheduler.snapshot().records['mc-s2.m1'].managed).toMatchObject({
        kind: 'external', group: 'workers', member: 'primary', cli: 'codex', model: worker!.plan.selected!.modelKey,
      });
      mkdirSync(checkpoint.managedWorker.runDir, { recursive: true });
      const healthPath = join(checkpoint.managedWorker.runDir, 'health.json');
      writeFileSync(healthPath, JSON.stringify({ invocationId: worker!.dispatch.invocationId,
        health: { ...baseHealth, observerGeneration: 1 } }));
      await command(['status', 'mc-s2', '--json']);
      expect(c.scheduler.snapshot().records['mc-s2.m1'].health?.observerGeneration).toBe(1);
      expect(c.scheduler.snapshot().records['mc-s2.m1'].state).toBe('admitted');
      expect(c.scheduler.snapshot().records.waiting.state).toBe('queued');
      writeFileSync(healthPath, JSON.stringify({ invocationId: worker!.dispatch.invocationId, health: uncertain(1) }));
      await command(['status', 'mc-s2', '--json']);
      retained();
      c.finish('PASS', 'Managed worker dispatch resolves the qualified selection, reserves external dimensions, launches Ralph once and maps current-generation health without releasing uncertain capacity.');
      return;
    }
    if (event === 'abort-command') {
      const started = Date.now();
      await command(['abort', 'mc-s2', 'm1', '--request-id', 'cancel-managed-s2']);
      expect(Date.now() - started).toBeLessThanOrEqual(10_000);
      retained();
      expect(cancelManagedRalph).toHaveBeenCalledWith(root, dir, 'ralph-s2', expect.objectContaining({ generation: 1, execution }));
      const cancelled = c.scheduler.snapshot();
      await command(['abort', 'mc-s2', 'm1', '--request-id', 'cancel-managed-s2']);
      // Scheduler construction reconciles the authority and advances its store
      // revision; command replay leaves attempt records and balances unchanged.
      const replayed = c.scheduler.snapshot();
      expect({ ...replayed, revision: cancelled.revision }).toEqual(cancelled);
      c.finish('PASS', 'Managed abort reaches uncertain before bounded owned-process signalling; idempotent command replay preserves the reservation.');
      return;
    }
    if (event !== 'missing-state') {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ status: event, iteration: 2 }));
      c.record('write managed synthetic Ralph status', { status: event }, 'returned', null, caller());
    }
    vi.setSystemTime(start + 1000);
    const before = c.scheduler.snapshot().records['mc-s2.m1'];
    await command(['status', 'mc-s2', '--json']);
    if (event === 'running') {
      const after = c.scheduler.snapshot().records['mc-s2.m1'];
      expect(after.state).toBe('admitted');
      expect(Date.parse(after.leaseExpiresAt!)).toBe(Date.parse(before.leaseExpiresAt!) + 1000);
      expect(after.lastProgressAt).toEqual(before.lastProgressAt);
      expect(after.health).toEqual(before.health);
      expect(c.scheduler.snapshot().records.waiting.state).toBe('queued');
      expect(caller().loop).toBe(2);
      c.finish('PASS', 'Managed running status renews current-generation ownership without semantic progress credit or capacity release.');
    } else {
      retained();
      expect(caller().missionStatus).toBe(event === 'missing-state' ? 'running' : event === 'completed' ? 'done' : event === 'crashed' ? 'failed' : event);
      expect(caller().admissionState).toBe('uncertain');
      c.finish('PASS', `Managed ${event} retains uncertain capacity without termination proof and persists its current generation.`);
    }
  });
});

afterAll(() => {
  const inventory = [
    { owner: 'Mission', verdict: 'NOT-EXPRESSIBLE', reason: 'Routes worker cycles and rejects unsupported worker handoffs; no SharedHostScheduler binding.', evidence: [source('src/serve/mission-conductor.ts', 'assertMissionWorkerHandoff(plan'), source('src/serve/mission-conductor.ts', "import { routeMission }")] },
    { owner: 'Fleet Mission', verdict: 'NOT-EXPRESSIBLE', reason: 'Fleet lifecycle aggregation exists, but no SharedHostScheduler binding.', evidence: [source('src/serve/fleet-mission-conductor.ts', 'assertMissionWorkerHandoff(plan'), source('src/serve/fleet-mission-conductor.ts', 'function lifecycleSatisfied')] },
    { owner: 'Flow', verdict: 'NOT-EXPRESSIBLE', reason: 'Managed Flow uses the MC project adapter; separate unit fixtures cover its schema/accounting boundary, while this trace lane exercises MC callers.', evidence: [source('src/cli/handlers/mc-worker.ts', 'export async function createMcFlowAdapter'), source('agentic/code/addons/composition-engine/lib/runtime.mjs', 'export function createManagedCompositionAdapter')] },
    { owner: 'Ralph', verdict: 'NOT-EXPRESSIBLE', reason: 'Managed Ralph capture validates shared MC authority and fenced health; this trace lane substitutes process launch and tests MC ingestion, with capture covered in its unit lane.', evidence: [source('src/cli/handlers/mc-status.ts', 'const ralphStatus = String(state.status'), source('tools/ralph-external/session-launcher.mjs', 'assertManagedWorkerLaunch')] },
  ];
  for (const trace of traces) {
    for (const step of trace.steps) {
      const input = step.input as { health?: unknown };
      if (input?.health) expect(validateWorkerPayload('workerHealthSummary', input.health).valid).toBe(true);
    }
  }
  expect(validateWorkerPayload('workerDispatch', dispatch).valid).toBe(true);
  for (const health of [baseHealth, confirmed(3), confirmed(2), confirmed(4), uncertain(3), terminalUnconfirmed(3), confirmed(null)]) {
    expect(validateWorkerPayload('workerHealthSummary', health).valid).toBe(true);
  }
  expect(traces.filter(trace => trace.boundary === 'B-OG-12' && !trace.mode.startsWith('managed '))).toHaveLength(gates.length * 2);
  expect(traces.filter(trace => trace.boundary === 'B-OG-12' && trace.mode.startsWith('managed '))).toHaveLength(gates.length * 2);
  expect(traces.filter(trace => trace.boundary === 'B-OG-16' && !trace.mode.startsWith('managed '))).toHaveLength(10);
  expect(traces.filter(trace => trace.boundary === 'B-OG-16' && trace.mode.startsWith('managed '))).toHaveLength(10);
  const count = (rows: Trace[]) => Object.fromEntries(['PASS', 'FAIL', 'NOT-EXPRESSIBLE'].map(verdict => [verdict, rows.filter(row => row.verdict === verdict).length]));
  const payload = {
    version: 1, issue: '#2917', contract: 'T-OG-24 / B-OG-12 / B-OG-16',
    scheduler: 'src/serve/shared-host-scheduler.ts', store: 'FileAdmissionStore', clockStart: new Date(start).toISOString(),
    scope: 'Current worktree sources; no live providers or transcripts. Baseline rows preserve legacy observations and managed-only unavailable operations. Separate managed rows exercise the generation-bearing runtime APIs with a bound policy and real durable store.',
    restartModel: 'Abrupt owner loss between completed operations: discard scheduler and FileAdmissionStore instances, reopen the same durable file. No subprocess crash, mid-write failure, or stale-lock recovery is claimed.',
    substitutions: ['Ralph process launcher (synthetic result/error)', 'operator config reader (synthetic provider and concurrency)', 'trusted installation inputs (offline synthetic qualified driver/catalog for managed worker dispatch)', 'Date for MC (scheduler tests inject clock directly)'],
    instrumentation: 'MC scheduler methods have pass-through observers calling their original implementations; snapshots include each internal scheduler operation and the enclosing command.',
    fixtureSources: [source(mappingSource, 'const baseHealth:'), source(mappingSource, 'const confirmedTerminal'), source(mappingSource, 'const uncertainTermination'), source(mappingSource, 'const terminalUnconfirmed'), 'test/conformance/mission-v1/fixtures/worker-contracts/mission-vectors.json#dispatch-health-feature'],
    sourceDigests: Object.fromEntries([
      'src/serve/shared-host-scheduler.ts', 'src/cli/handlers/mc.ts', 'src/cli/handlers/mc-admission.ts', 'src/config/worker-activation-gate.ts', 'src/models/resolver.ts', 'src/serve/worker-invocation.ts', 'test/fixtures/managed-mc-worker.ts', mappingSource,
      'test/conformance/mission-v1/fixtures/worker-contracts/mission-vectors.json',
    ].map(file => [file, `sha256:${createHash('sha256').update(readFileSync(join(root, file))).digest('hex')}`])),
    healthVectors: { baseHealth, currentProof: confirmed(3), staleProof: confirmed(2), futureProof: confirmed(4), uncertain: uncertain(3), terminalUnconfirmed: terminalUnconfirmed(3), nullGeneration: confirmed(null) },
    unsupportedOwners: inventory,
    counts: { scheduler: count(traces.filter(trace => trace.boundary === 'B-OG-12' && !trace.mode.startsWith('managed '))), managedScheduler: count(traces.filter(trace => trace.boundary === 'B-OG-12' && trace.mode.startsWith('managed '))), callers: count(traces.filter(trace => trace.boundary === 'B-OG-16' && !trace.mode.startsWith('managed '))), managedCallers: count(traces.filter(trace => trace.boundary === 'B-OG-16' && trace.mode.startsWith('managed '))) },
    traces,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
});
