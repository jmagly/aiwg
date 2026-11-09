import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  executeFlowGraph,
  flowWorkerConsumerSupport,
  createManagedCompositionAdapter,
  FlowGraphRuntimeError,
} from '../../../agentic/code/addons/composition-engine/lib/runtime.mjs';
import compositionRun from '../../../agentic/code/addons/composition-engine/commands/composition-run.mjs';
import { bindManagedAdmissionPolicy, InMemoryAdmissionStore, managedAllowanceFromOwner, SharedHostScheduler, type SharedHostPolicy } from '../../../src/serve/shared-host-scheduler.js';

const ROOT = resolve('agentic/code/addons/composition-engine');

function fixture(name = 'linear-flow'): any {
  return JSON.parse(readFileSync(resolve(ROOT, 'fixtures', `${name}.json`), 'utf8'));
}

function valuesFor(node: any, value: unknown): Record<string, unknown> {
  return Object.fromEntries(node.outputs.map((output: any) => [output.name, value]));
}

const echoAdapter = async ({ node, inputs, activation }: any) => ({
  outputs: Object.fromEntries(node.outputs.map((output: any) => [
    output.name,
    output.schema.type === 'integer' ? activation
      : output.schema.type === 'array' ? [node.id]
        : output.schema.type === 'object' ? { node: node.id, inputs }
          : `${node.id}:${Object.values(inputs).join('|')}`,
  ])),
  usage: { tokens: 10, costUsd: 0.01, timeMs: 2 },
});

describe('composition-engine deterministic runtime', () => {
  it.each(['workerName', 'workerBrief'])('runs legacy Flow schemas with their own local $defs/%s', async name => {
    const baseline = await executeFlowGraph(fixture(), { runId: 'legacy-local-ref', invokeNode: echoAdapter });
    const graph = fixture();
    graph.spec.nodes[0].inputs[0].schema = {
      ...(name === 'workerBrief' ? { $id: 'https://synthetic.invalid/legacy-flow-input' } : {}),
      $defs: { [name]: { type: 'string' } },
      $ref: `#/$defs/${name}`,
    };
    const report = await executeFlowGraph(graph, { runId: 'legacy-local-ref', invokeNode: echoAdapter });
    expect(report.status).toBe('completed');
    expect(report).toEqual(baseline);
  });

  it('treats worker-like keys and references in schema literals as ordinary Flow data', async () => {
    const graph = fixture();
    graph.spec.nodes[0].inputs[0].schema = {
      type: 'string',
      default: { extensions: { 'aiwg.worker-dispatch': { type: 'string' } }, $ref: 'https://aiwg.io/schemas/mission.aiwg.io/v1#/$defs/workerBrief' },
    };
    const report = await executeFlowGraph(graph, { invokeNode: echoAdapter });
    expect(report.status).toBe('completed');
  });

  it('treats named values called extensions or metadata as data, but rejects a Mission value with a worker binding', async () => {
    const userData = { 'aiwg.worker-dispatch': 'ordinary user data' };
    const withValue = (value: unknown) => async ({ node }: any) => ({
      outputs: valuesFor(node, value),
      usage: { tokens: 1, costUsd: 0, timeMs: 1 },
    });
    const graph = () => {
      const g = fixture();
      for (const node of g.spec.nodes) for (const output of node.outputs) output.schema = { type: 'object' };
      g.spec.nodes[1].inputs[0].schema = { type: 'object' };
      g.spec.output.schema = { type: 'object' };
      return g;
    };
    const ordinary = await executeFlowGraph(graph(), { invokeNode: withValue({ extensions: userData, metadata: userData }) });
    expect(ordinary.status).toBe('completed');

    const mission = { apiVersion: 'mission.aiwg.io/v1', kind: 'Mission', metadata: {}, spec: {}, status: {}, provenance: {}, extensions: { 'aiwg.worker-dispatch': { version: 999 } } };
    const blocked = await executeFlowGraph(graph(), { invokeNode: withValue(mission) });
    expect(blocked.status).toBe('failed');
    expect(JSON.stringify(blocked)).toContain('OG_CONTRACT_UNSUPPORTED');
  });

  it('replays a linear graph with identical activation, route, and join order', async () => {
    const first = await executeFlowGraph(fixture(), { runId: 'replay', adapterId: 'codex', invokeNode: echoAdapter });
    const second = await executeFlowGraph(fixture(), { runId: 'replay', adapterId: 'codex', invokeNode: echoAdapter });
    expect(first.status).toBe('completed');
    expect(second.trace).toEqual(first.trace);
    expect(first.trace.filter((event: any) => event.type === 'node-started').map((event: any) => event.nodeId)).toEqual(['draft', 'polish']);
  });

  it('runs same-phase tracks through parallel-dispatch but commits in stable plan order', async () => {
    const graph = fixture('phased-multi-track');
    const report = await executeFlowGraph(graph, {
      runId: 'parallel',
      invokeNode: echoAdapter,
      parallelDispatch: async (requests: any[], invoke: any) => Promise.all(
        requests.map(async (request) => {
          if (request.node.id === 'architecture') await new Promise((done) => setTimeout(done, 10));
          return invoke(request);
        }),
      ),
    });
    const completed = report.trace.filter((event: any) => event.type === 'node-completed').map((event: any) => event.nodeId);
    expect(completed).toEqual(['intake', 'architecture', 'security', 'decision']);
    expect(report.realizedResources.maxConcurrency).toBe(2);
  });

  it('synchronizes period-four and period-five sources at activation 20', async () => {
    const report = await executeFlowGraph(fixture('lcm-4x5'), { runId: 'lcm', invokeNode: echoAdapter });
    const joined = report.trace.find((event: any) => event.type === 'join-evaluated' && event.satisfied);
    expect(joined).toMatchObject({ joinId: 'twentieth-activation', activation: 20, policy: 'lcm', reason: 'lcm:20' });
    expect(report.output).toBe(20);
    expect(report.realizedResources.activations).toBe(20);
  });

  it('stops a converged join as soon as its typed state threshold is met', async () => {
    const graph = fixture();
    graph.spec.state.fields = [{ name: 'iterations', schema: { type: 'integer' }, reducer: 'sum', initial: 0 }];
    graph.spec.nodes[0].outputs[0].schema = { type: 'integer' };
    graph.spec.nodes[0].outputs[0].state = 'iterations';
    graph.spec.nodes[1].inputs = [{ name: 'iterations', schema: { type: 'integer' }, state: 'iterations' }];
    graph.spec.routes = [];
    delete graph.spec.nodes[1].dependsOn;
    graph.spec.joins = [{
      id: 'quality-threshold',
      sources: ['draft'],
      target: 'polish',
      policy: { mode: 'converged', predicate: { language: 'cel', expression: 'state.iterations >= 3' }, maxIterations: 7 },
    }];
    const report = await executeFlowGraph(graph, {
      runId: 'converged',
      invokeNode: async ({ node, inputs }: any) => ({
        outputs: node.id === 'draft' ? valuesFor(node, 1) : valuesFor(node, `iterations:${inputs.iterations}`),
        usage: { tokens: 1, costUsd: 0, timeMs: 1 },
      }),
    });
    expect(report.status).toBe('completed');
    expect(report.state.iterations).toBe(3);
    expect(report.trace.find((event: any) => event.type === 'join-evaluated' && event.satisfied)).toMatchObject({ iteration: 3, reason: 'converged' });
  });

  it('executes guarded feedback and stops at the declared cycle ceiling', async () => {
    const graph = fixture();
    graph.spec.ceilings.activations = 10;
    graph.spec.state.fields = [{ name: 'iterations', schema: { type: 'integer' }, reducer: 'sum', initial: 0 }];
    graph.spec.nodes[0].outputs.push({ name: 'iteration', schema: { type: 'integer' }, state: 'iterations' });
    graph.spec.routes.push({
      id: 'polish-to-draft', from: 'polish', to: 'draft',
      guard: { language: 'cel', expression: 'true' }, maxIterations: 2,
    });
    const report = await executeFlowGraph(graph, {
      runId: 'guarded-cycle',
      invokeNode: async (request: any) => {
        const result = await echoAdapter(request);
        if (request.node.id === 'draft') result.outputs.iteration = 1;
        return result;
      },
    });
    expect(report.status).toBe('failed');
    expect(report.stopReason).toContain('exhausted maxIterations 2');
    expect(report.state.iterations).toBe(3);
    expect(report.trace.filter((event: any) => event.type === 'node-completed' && event.nodeId === 'draft')).toHaveLength(3);
    expect(report.trace.find((event: any) => event.type === 'route-evaluated' && event.exhausted)).toMatchObject({ routeId: 'polish-to-draft', iteration: 2, maxIterations: 2 });
  });

  it('stops a guarded cycle before its budget ceiling when progress is flat', async () => {
    const graph = fixture('human-decision-cycle');
    const first = await executeFlowGraph(graph, {
      runId: 'flat-progress',
      invokeNode: async ({node}: any) => ({outputs: valuesFor(node, node.id === 'check' ? 2 : 1), usage: {tokens: 1, costUsd: 0, timeMs: 1}}),
    });
    expect(first.status).toBe('paused');
    const resumed = await executeFlowGraph(graph, {
      runId: 'flat-progress', resumeFrom: first.checkpoint, approvedGates: ['approve'],
      invokeNode: async ({node}: any) => ({outputs: valuesFor(node, node.id === 'check' ? 2 : 1), usage: {tokens: 1, costUsd: 0, timeMs: 1}}),
    });
    expect(resumed.status).toBe('failed');
    expect(resumed.stopReason).toContain('did not strictly decrease');
    expect(resumed.realizedResources.activations).toBeLessThan(graph.spec.ceilings.activations);
    expect(resumed.trace.find((event: any) => event.type === 'route-evaluated' && event.progress?.progressed === false)).toBeTruthy();
  });

  it('pauses approval-required work, resumes from checkpoint, and supports operator cancellation', async () => {
    const graph = fixture('human-decision-cycle');
    const first = await executeFlowGraph(graph, {
      runId: 'human-decision',
      invokeNode: async ({node}: any) => ({outputs: valuesFor(node, 2), usage: {tokens: 1, costUsd: 0, timeMs: 1}}),
    });
    expect(first.status).toBe('paused');
    expect(first.trace.some((event: any) => event.type === 'run-paused' && event.nodeId === 'approve')).toBe(true);

    const waiting = [1, 0];
    const resumed = await executeFlowGraph(graph, {
      runId: 'human-decision', resumeFrom: first.checkpoint, approvedGates: ['approve'],
      invokeNode: async ({node}: any) => ({
        outputs: valuesFor(node, node.id === 'check' ? waiting.shift() : 1),
        usage: {tokens: 1, costUsd: 0, timeMs: 1},
      }),
    });
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe(0);

    const cancelled = await executeFlowGraph(graph, {
      runId: 'human-decision', resumeFrom: first.checkpoint, cancelledGates: ['approve'],
      invokeNode: echoAdapter,
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.stopReason).toContain('cancelled');
  });

  it('honors an operator stop before invoking any node', async () => {
    let calls = 0;
    const report = await executeFlowGraph(fixture(), {
      operatorAction: 'stop',
      invokeNode: async (request: any) => { calls += 1; return echoAdapter(request); },
    });
    expect(report.status).toBe('cancelled');
    expect(report.stopReason).toBe('operator requested stop');
    expect(calls).toBe(0);
  });

  it('never exceeds a convergence hard ceiling and returns the declared partial shape', async () => {
    const graph = fixture();
    graph.spec.ceilings.activations = 3;
    graph.spec.state.fields = [{ name: 'iterations', schema: { type: 'integer' }, reducer: 'sum', initial: 0 }];
    graph.spec.nodes[0].outputs[0].schema = { type: 'integer' };
    graph.spec.nodes[0].outputs[0].state = 'iterations';
    graph.spec.nodes[1].inputs = [{ name: 'iterations', schema: { type: 'integer' }, state: 'iterations' }];
    graph.spec.routes = [];
    delete graph.spec.nodes[1].dependsOn;
    graph.spec.joins = [{
      id: 'never', sources: ['draft'], target: 'polish',
      policy: { mode: 'converged', predicate: { language: 'cel', expression: 'state.iterations >= 99' }, maxIterations: 9 },
    }];
    graph.spec.failure = { onNodeFailure: 'partial-synthesis', maxFailures: 1 };
    graph.spec.output.mode = 'final-only';
    const report = await executeFlowGraph(graph, {
      invokeNode: async ({ node }: any) => ({ outputs: valuesFor(node, 1), usage: { tokens: 1, costUsd: 0, timeMs: 1 } }),
    });
    expect(report.status).toBe('partial');
    expect(report.realizedResources.activations).toBe(3);
    expect(report.output).toMatchObject({ partial: true, stopReason: expect.stringContaining('join') });
  });

  it('returns typed terminal failure when an adapter would exceed a budget', async () => {
    const graph = fixture();
    graph.spec.ceilings.costUsd = 0.5;
    graph.spec.output.mode = 'typed-terminal-failure';
    graph.spec.output.failureSchema = { type: 'object', required: ['code'] };
    const report = await executeFlowGraph(graph, {
      invokeNode: async ({ node }: any) => ({ outputs: valuesFor(node, 'x'), usage: { tokens: 0, costUsd: 0.6, timeMs: 0 } }),
    });
    expect(report.status).toBe('failed');
    expect(report.output.code).toBe('RESOURCE_CEILING_WOULD_EXCEED');
    expect(report.realizedResources.costUsd).toBe(0);
  });

  it('executes a budget join with a deterministic budget stop reason', async () => {
    const graph = fixture();
    graph.spec.routes = [];
    delete graph.spec.nodes[1].dependsOn;
    graph.spec.joins = [{ id: 'bounded', sources: ['draft'], target: 'polish', policy: { mode: 'budget', maxCostUsd: 0.02 } }];
    const report = await executeFlowGraph(graph, { invokeNode: echoAdapter });
    expect(report.status).toBe('completed');
    expect(report.trace.find((event: any) => event.type === 'join-evaluated' && event.satisfied)).toMatchObject({
      joinId: 'bounded', iteration: 2, reason: 'budget-reached',
    });
  });

  it('skips a declared optional failure and continues independent work', async () => {
    const graph = fixture();
    graph.spec.entry = ['draft', 'polish'];
    graph.spec.routes = [];
    graph.spec.nodes[0].optional = true;
    delete graph.spec.nodes[1].dependsOn;
    graph.spec.nodes[1].inputs = [{ name: 'draft', schema: { type: 'string' }, value: 'fallback input' }];
    graph.spec.failure = { onNodeFailure: 'skip-optional', maxFailures: 1 };
    const report = await executeFlowGraph(graph, {
      invokeNode: async (request: any) => {
        if (request.node.id === 'draft') throw new Error('optional failure');
        return echoAdapter(request);
      },
    });
    expect(report.status).toBe('completed');
    expect(report.trace.some((event: any) => event.type === 'node-skipped' && event.nodeId === 'draft')).toBe(true);
  });

  it('reuses one stable invocation key across a bounded exactly-once retry', async () => {
    const graph = fixture();
    graph.spec.nodes[0].sideEffectMode = 'exactly-once';
    graph.spec.nodes[0].idempotencyKey = 'create-draft';
    graph.spec.nodes[0].retry = { limit: 1, backoff: 'none', on: ['failure'] };
    const keys: string[] = [];
    let attempts = 0;
    const report = await executeFlowGraph(graph, {
      invokeNode: async (request: any) => {
        keys.push(request.invocationKey);
        attempts += 1;
        if (attempts === 1) throw new Error('injected transient failure');
        return echoAdapter(request);
      },
    });
    expect(report.status).toBe('completed');
    expect(keys[0]).toBe(keys[1]);
    expect(report.realizedResources.retries).toBe(1);
    expect(Object.keys(report.checkpoint.receipts)).toEqual([keys[0]]);
  });

  it('records duplicate exactly-once attempts and suppressions without exposing the declared key', async () => {
    const graph = fixture();
    graph.spec.ceilings.activations = 10;
    graph.spec.nodes[0].sideEffectMode = 'exactly-once';
    graph.spec.nodes[0].idempotencyKey = 'private-business-key';
    graph.spec.routes.push({id: 'repeat', from: 'polish', to: 'draft', guard: {language: 'cel', expression: 'true'}, maxIterations: 1});
    const report = await executeFlowGraph(graph, {invokeNode: echoAdapter});
    expect(report.evidence.sideEffects.draft).toMatchObject({attempts: 2, duplicateDetections: 1, suppressions: 1});
    expect(report.trace.some((event: any) => event.type === 'node-replayed' && event.suppressed)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('private-business-key');
  });

  it('fails closed before adapter invocation when runtime authority is narrower', async () => {
    const graph = fixture('agent-tool-flow');
    const called: string[] = [];
    const report = await executeFlowGraph(graph, {
      allowedCapabilities: [],
      allowedPermissions: [],
      invokeNode: async (request: any) => {
        called.push(request.node.id);
        return echoAdapter(request);
      },
    });
    expect(report.status).toBe('failed');
    expect(called).not.toContain('execute');
    expect(report.trace.some((event: any) => event.code === 'CAPABILITY_DENIED')).toBe(true);
  });

  it('records requested versus realized resources and redacts configured full-I/O paths', async () => {
    const graph = fixture();
    graph.spec.trace = { level: 'full-io', redact: ['/topic/secret'] };
    graph.spec.nodes[0].inputs[0] = { name: 'topic', schema: { type: 'object' }, value: { secret: 'token', public: 'ok' } };
    const report = await executeFlowGraph(graph, {
      invokeNode: async ({ node }: any) => ({ outputs: valuesFor(node, 'safe'), usage: { tokens: 4, costUsd: 0.1, timeMs: 3 } }),
    });
    expect(report.requestedResources).toEqual(graph.spec.ceilings);
    expect(report.realizedResources).toMatchObject({ tokens: 8, costUsd: 0.2, timeMs: 6 });
    expect(JSON.stringify(report.trace)).not.toContain('"secret":"token"');
    expect(JSON.stringify(report.trace)).toContain('[REDACTED]');
  });

  it('records declared versus observed scope, empty coverage, and observation limitations', async () => {
    const graph = fixture();
    graph.spec.nodes[0].scope = {files: ['a.md', 'b.md'], resources: ['repo:read']};
    graph.spec.nodes[1].scope = {files: ['result.md']};
    const report = await executeFlowGraph(graph, {
      invokeNode: async ({node}: any) => ({
        outputs: valuesFor(node, 'safe'), usage: {tokens: 1, costUsd: 0, timeMs: 1},
        observedTouches: node.id === 'draft' ? {files: ['a.md', 'outside.md'], resources: ['repo:read']} : {},
        observationComplete: node.id === 'draft',
      }),
    });
    expect(report.evidence.nodes.draft.scope).toMatchObject({
      files: {undeclared: ['outside.md'], unobserved: ['b.md']},
      resources: {undeclared: [], unobserved: []},
      observationComplete: true,
    });
    expect(report.evidence.nodes.polish.scope).toMatchObject({coverage: 'empty', observationComplete: false});
  });

  it('attributes resources per node, branch, and join', async () => {
    const report = await executeFlowGraph(fixture('phased-multi-track'), {
      invokeNode: echoAdapter,
      parallelDispatch: async (requests: any[], invoke: any) => Promise.all(requests.map(invoke)),
    });
    expect(report.evidence.nodes.architecture.resources).toEqual({runs: 1, tokens: 10, costUsd: 0.01, timeMs: 2});
    expect(report.evidence.branches.architecture.timeMs).toBe(2);
    expect(report.evidence.branches.security.timeMs).toBe(2);
    expect(report.evidence.joins['analysis-quorum']).toMatchObject({
      sources: ['architecture', 'security'], resources: {runs: 2, tokens: 20, costUsd: 0.02, timeMs: 4},
    });
  });

  it('keeps core semantics equivalent across the Codex and Claude Code adapters', async () => {
    const reports = await Promise.all(['codex', 'claude-code'].map((adapterId) => (
      executeFlowGraph(fixture(), { runId: 'provider-conformance', adapterId, invokeNode: echoAdapter })
    )));
    const semantics = reports.map((report) => report.trace.map(({ type, nodeId, activation, active }: any) => ({ type, nodeId, activation, active })));
    expect(semantics[1]).toEqual(semantics[0]);
    expect(reports[0].output).toEqual(reports[1].output);
    expect(JSON.stringify(fixture())).not.toContain('provider');
  });

  it('resumes a completed checkpoint without re-invoking nodes', async () => {
    const first = await executeFlowGraph(fixture(), { runId: 'resume', invokeNode: echoAdapter });
    let calls = 0;
    const resumed = await executeFlowGraph(fixture(), {
      runId: 'resume',
      resumeFrom: first.checkpoint,
      invokeNode: async (request: any) => {
        calls += 1;
        return echoAdapter(request);
      },
    });
    expect(calls).toBe(0);
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toEqual(first.output);
  });

  it('rejects execution without an explicit adapter seam', async () => {
    await expect(executeFlowGraph(fixture())).rejects.toMatchObject<Partial<FlowGraphRuntimeError>>({ code: 'ADAPTER_REQUIRED' });
  });

  it('exposes machine-readable CLI execution and atomic checkpoint output', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'aiwg-composition-runtime-'));
    try {
      const checkpoint = resolve(directory, 'checkpoint.json');
      const result = await compositionRun([
        resolve(ROOT, 'fixtures', 'linear-flow.json'),
        '--format', 'json',
        '--run-id', 'cli-run',
        '--checkpoint', checkpoint,
      ], {
        cwd: process.cwd(),
        compositionAdapter: { id: 'test', invokeNode: echoAdapter },
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.message)).toMatchObject({
        schemaVersion: 'flow.aiwg.io/v1alpha1',
        kind: 'FlowGraphRunReport',
        runId: 'cli-run',
        status: 'completed',
      });
      expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toMatchObject({
        schemaVersion: 'flow.aiwg.io/v1alpha1',
        kind: 'FlowGraphCheckpoint',
        runId: 'cli-run',
      });

      const missing = await compositionRun([resolve(ROOT, 'fixtures', 'linear-flow.json'), '--format', 'json'], { cwd: process.cwd() });
      expect(missing.exitCode).toBe(2);
      expect(JSON.parse(missing.message).code).toBe('ADAPTER_REQUIRED');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});


describe('T-OG-08 managed Flow value and usage binding', () => {
  function managed(options: any = {}) {
    const now = Date.parse('2026-10-22T12:00:00Z');
    const policy: SharedHostPolicy = { maxConcurrent: 8, defaultHostQuota: 8, leaseTtlMs: 60000, agingIntervalMs: 1000, allowPreemption: false,
      managed: { authorityRef: 'project', projectId: 'a'.repeat(64), policyDigest: `sha256:${'b'.repeat(64)}`, maxQueued: 20,
        dimensionCaps: {}, installations: {}, members: {} } };
    const store = new InMemoryAdmissionStore();
    bindManagedAdmissionPolicy(store, policy);
    let currentTime = now;
    const scheduler = options.scheduler ?? new SharedHostScheduler(store, policy, () => currentTime);
    const invoke = options.invokeNode ?? echoAdapter;
    let processId = 42000;
    const adapter = (options.factory ?? createManagedCompositionAdapter)({ scheduler, allowanceFromOwner: managedAllowanceFromOwner,
      prepareNode: async (request: any) => {
        if (request.attempt > 1) currentTime += 1000;
        return { admission: {
        requestId: request.invocationId, orchestratorId: request.runId, environment: 'synthetic', provider: 'synthetic',
        runtimeKind: 'host', priority: 10, submittedAt: new Date(now).toISOString(), queueTimeoutMs: 60000,
        managed: { kind: 'native' }, allowance: { runId: request.runId, taskId: request.node.id,
          reservation: { tokens: request.requestedResources.tokens, costUsd: request.requestedResources.costUsd } },
      } };
      },
      invokeNode: async (request: any, owner: any) => {
        if (options.bindExecution !== false) owner.bindExecution({ pid: ++processId, startedAt: `synthetic:${processId}` });
        const evidence = (source: any, state: string) => ({
          health: { version: 1, state, termination: 'confirmed', coverage: 'full', handshake: 'semantic',
            lastObservedAt: new Date(now).toISOString(), lastActivityAt: null, lastProgressAt: null,
            reasonCode: 'SYNTHETIC_FINAL', transitionCount: 1, restartCount: 0, unavailableSignals: [], transitionRefs: [],
            observerGeneration: owner.admission.attemptGeneration, startupDeadlineAt: null, hardDeadlineAt: null,
            maxCheckGapSeconds: 1, confidence: 'observed', handshakeAt: new Date(now).toISOString(), stalledAt: null },
          ...(state === 'failed' && source?.code === 'TIMEOUT' ? { failure: { class: 'timeout', retryable: true } } : {}),
          usage: { inputTokens: source?.usage?.tokens ?? null, outputTokens: source?.usage?.tokens === undefined ? null : 0,
            cacheTokens: source?.usage?.tokens === undefined ? null : 0, reasoningTokens: source?.usage?.tokens === undefined ? null : 0, costUsd: source?.usage?.costUsd ?? null,
            quality: source?.usage?.tokens === undefined ? 'unknown' : 'reported',
            reservedTokens: request.requestedResources.tokens, reservedUsd: request.requestedResources.costUsd },
        });
        try {
          const raw = await invoke(request);
          const proof = evidence(raw, 'completed');
          options.mutateProof?.(proof);
          return options.proof === false ? raw : { ...raw, managedEvidence: proof };
        } catch (error) { throw Object.assign(error as object, { managedEvidence: evidence(error, 'failed') }); }
      },
      parallelDispatch: options.parallelDispatch,
    });
    return { ...options, ...adapter, scheduler, ...(options.workerConsumer ? { workerConsumer: options.workerConsumer } : {}) };
  }
  const artifact = { ref: 'artifact:synthetic', digest: `sha256:${'a'.repeat(64)}` };
  function artifactGraph(): any {
    const graph = fixture();
    const schema = { $ref: 'https://aiwg.io/schemas/mission.aiwg.io/v1#/$defs/workerArtifact' };
    for (const node of graph.spec.nodes) {
      for (const binding of [...node.inputs, ...node.outputs]) binding.schema = schema;
    }
    graph.spec.nodes[0].inputs[0].value = artifact;
    graph.spec.output.schema = schema;
    return graph;
  }

  it('rejects metadata-only managed invocation without the shared owner binding', async () => {
    await expect(executeFlowGraph(fixture(), { workerMode: 'managed', workerConsumer: flowWorkerConsumerSupport(), invokeNode: echoAdapter }))
      .rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
  });

  it('submits every node through the shared owner and retains its fenced admission in results', async () => {
    const adapter = managed();
    const report = await executeFlowGraph(fixture(), adapter);
    expect(report.status).toBe('completed');
    const records: any[] = Object.values(adapter.scheduler.snapshot().records);
    expect(records).toHaveLength(2);
    expect(records.every(record => record.state === 'settled' && record.launchClaimedAt && record.execution)).toBe(true);
    expect(report.results.draft.admission).toMatchObject({ requestId: records[0].requestId, generation: 1, state: 'settled' });
    expect(adapter.scheduler.snapshot().allowances[records[0].accounting.runKey].limits.maxTokens).toBe(fixture().spec.ceilings.tokens);
  });

  it.each(['missing-proof', 'uncertain-proof', 'stale-proof', 'missing-identity'])('retains shared capacity and withholds outputs for %s', async kind => {
    const adapter = managed({ proof: kind !== 'missing-proof', bindExecution: kind !== 'missing-identity',
      mutateProof: (proof: any) => {
        if (kind === 'uncertain-proof') proof.health.termination = 'uncertain';
        if (kind === 'stale-proof') proof.health.observerGeneration = 0;
      },
    });
    const report = await executeFlowGraph(fixture(), adapter);
    const records: any[] = Object.values(adapter.scheduler.snapshot().records);
    expect(report.status).toBe('failed');
    expect(report.output).toBeUndefined();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ state: 'uncertain', reservedSlots: 1 });
    expect(report.realizedResources.tokens).toBe(10);
  });

  it.each(['features', 'bundleDigest', 'revision', 'lossless'])('rejects incompatible adapter %s before task handoff', async key => {
    const consumer: any = flowWorkerConsumerSupport();
    consumer[key] = key === 'features' ? consumer.features.filter((feature: string) => feature !== 'worker-flow-values.v1')
      : key === 'lossless' ? false : key === 'revision' ? 0 : 'sha256:stale';
    let calls = 0;
    await expect(executeFlowGraph(artifactGraph(), managed({ workerConsumer: consumer, invokeNode: async () => { calls += 1; } })))
      .rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
    expect(calls).toBe(0);
  });

  it('resolves bundled Mission 2020-12 worker values offline and preserves exact values across resume', async () => {
    const invokeNode = async ({ node }: any) => ({ outputs: valuesFor(node, artifact), usage: { tokens: 2, costUsd: 0, timeMs: 1 } });
    const first = await executeFlowGraph(artifactGraph(), managed({ invokeNode }));
    expect(first.status).toBe('completed');
    expect(first.output).toEqual(artifact);
    let calls = 0;
    const resumed = await executeFlowGraph(artifactGraph(), managed({ resumeFrom: first.checkpoint, invokeNode: async () => { calls += 1; } }));
    expect(calls).toBe(0);
    expect(resumed.output).toEqual(artifact);
    expect(resumed.accounting).toEqual(first.accounting);
    expect(resumed.realizedResources.tokens).toBe(4);
  });

  it('resolves 2020-12 Mission references inside an explicit draft-07 schema without changing dialects', async () => {
    const graph = artifactGraph();
    for (const node of graph.spec.nodes) for (const binding of [...node.inputs, ...node.outputs]) binding.schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      allOf: [binding.schema],
    };
    const report = await executeFlowGraph(graph, managed({ invokeNode: async ({ node }: any) => ({ outputs: valuesFor(node, artifact), usage: { tokens: 1, costUsd: 0, timeMs: 1 } }) }));
    expect(report.status).toBe('completed');
    expect(report.output).toEqual(artifact);
  });

  it('validates draft-07 local definitions and present invalid input before invocation', async () => {
    const graph = fixture();
    graph.spec.nodes[0].inputs[0].schema = {
      $schema: 'http://json-schema.org/draft-07/schema#', definitions: { topic: { type: 'string', minLength: 40 } }, $ref: '#/definitions/topic',
    };
    let calls = 0;
    await expect(executeFlowGraph(graph, managed({ invokeNode: async () => { calls += 1; } }))).rejects.toMatchObject({ code: 'INVALID_TYPED_INPUT' });
    expect(calls).toBe(0);
  });

  it.each(['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema'])('checks date-time formats in %s', async dialect => {
    const graph = fixture();
    graph.spec.nodes[0].inputs[0] = { name: 'topic', schema: { $schema: dialect, type: 'string', format: 'date-time' }, value: '2026-02-31T25:00:00Z' };
    await expect(executeFlowGraph(graph, managed())).rejects.toMatchObject({ code: 'INVALID_TYPED_INPUT' });
  });

  it('rejects unbundled schema references before invocation', async () => {
    const graph = fixture();
    graph.spec.nodes[1].outputs[0].schema = { $ref: 'https://synthetic.invalid/unavailable.schema.json' };
    let calls = 0;
    await expect(executeFlowGraph(graph, managed({ invokeNode: async () => { calls += 1; } }))).rejects.toMatchObject({ code: 'FLOW_SCHEMA_UNRESOLVED' });
    expect(calls).toBe(0);
  });

  it('charges a present invalid worker output before rejecting it without delivering output', async () => {
    const report = await executeFlowGraph(artifactGraph(), managed({
      invokeNode: async ({ node }: any) => ({ outputs: valuesFor(node, { ...artifact, digest: 'invalid' }), usage: { tokens: 7, costUsd: 0.2, timeMs: 3 } }),
    }));
    expect(report.status).toBe('failed');
    expect(report.output).toBeUndefined();
    expect(report.trace.some((event: any) => event.code === 'INVALID_TYPED_OUTPUT')).toBe(true);
    expect(report.realizedResources).toMatchObject({ nodeRuns: 1, tokens: 7, costUsd: 0.2, timeMs: 3 });
    expect(report.evidence.nodes.draft.resources.tokens).toBe(7);
    expect(Object.keys(report.accounting.attempts)).toHaveLength(1);
  });

  it('preserves spent then failed attempts and reduces the next attempt allowance', async () => {
    const graph = fixture();
    graph.spec.nodes[0].retry = { limit: 1, backoff: 'none', on: ['timeout'] };
    graph.spec.ceilings.tokens = 10;
    const allowances: number[] = [];
    const report = await executeFlowGraph(graph, managed({ invokeNode: async (request: any) => {
      allowances.push(request.requestedResources.tokens);
      if (request.node.id === 'draft' && request.attempt === 1) throw Object.assign(new Error('spent failure'), { code: 'TIMEOUT', usage: { tokens: 3, costUsd: 0.1, timeMs: 2 } });
      return { outputs: valuesFor(request.node, 'valid'), usage: { tokens: 2, costUsd: 0, timeMs: 1 } };
    } }));
    expect(report.status, JSON.stringify(report.trace)).toBe('completed');
    expect(allowances).toEqual([10, 7, 5]);
    expect(report.realizedResources).toMatchObject({ nodeRuns: 3, tokens: 7, costUsd: 0.1, timeMs: 4 });
    expect(report.evidence.nodes.draft.resources).toMatchObject({ runs: 2, tokens: 5 });
    expect(Object.keys(report.accounting.attempts)).toHaveLength(3);
  });

  it('retains unknown serial usage and conservative allowances across checkpoint resume', async () => {
    const graph = fixture();
    let calls = 0;
    const first = await executeFlowGraph(graph, managed({ invokeNode: async ({ node }: any) => {
      calls += 1;
      return { outputs: valuesFor(node, 'valid') };
    } }));
    expect(calls).toBe(1);
    expect(first.status).toBe('failed');
    expect(first.realizedResources).toMatchObject({ nodeRuns: 1, tokens: null, costUsd: null, timeMs: null });
    expect(first.accounting.reserved).toEqual({ tokens: graph.spec.ceilings.tokens, costUsd: graph.spec.ceilings.costUsd, timeMs: graph.spec.ceilings.timeMs });
    const resumed = await executeFlowGraph(graph, managed({ resumeFrom: first.checkpoint, invokeNode: async () => { calls += 1; } }));
    expect(calls).toBe(1);
    expect(resumed.accounting).toEqual(first.accounting);
    expect(resumed.realizedResources.tokens).toBeNull();
  });

  it('retains every parallel spend when the first result is invalid', async () => {
    const graph = fixture('phased-multi-track');
    graph.spec.failure = { onNodeFailure: 'fail', maxFailures: 0 };
    const report = await executeFlowGraph(graph, managed({
      invokeNode: async (request: any) => {
        const raw = await echoAdapter(request);
        if (request.node.id === 'architecture') raw.outputs = valuesFor(request.node, 42);
        return raw;
      },
      parallelDispatch: async (requests: any[], invoke: any) => Promise.all(requests.map(invoke)),
    }));
    expect(report.status).toBe('failed');
    expect(report.realizedResources.tokens, JSON.stringify(report.trace)).toBe(30);
    expect(report.evidence.nodes.architecture.resources.tokens).toBe(10);
    expect(report.evidence.nodes.security.resources.tokens).toBe(10);
    expect(Object.keys(report.accounting.attempts)).toHaveLength(3);
    expect(report.results.security).toBeTruthy();
  });

  it('waits for sibling accounting when parallel dispatch rejects after a spent failure', async () => {
    const graph = fixture('phased-multi-track');
    graph.spec.failure = { onNodeFailure: 'fail', maxFailures: 0 };
    const report = await executeFlowGraph(graph, managed({
      invokeNode: async (request: any) => {
        if (request.node.id === 'architecture') throw Object.assign(new Error('spent failure'), { usage: { tokens: 4, costUsd: 0.1, timeMs: 2 } });
        if (request.node.id === 'security') await new Promise(done => setTimeout(done, 5));
        return echoAdapter(request);
      },
      parallelDispatch: async (requests: any[], invoke: any) => Promise.all(requests.map(invoke)),
    }));
    expect(report.status).toBe('failed');
    expect(report.realizedResources.tokens).toBe(24);
    expect(report.evidence.nodes.security.resources.tokens).toBe(10);
    expect(report.accounting.pending).toEqual({});
  });

  it('retains missing parallel usage as unknown in branch and join evidence', async () => {
    const graph = fixture('phased-multi-track');
    graph.spec.failure = { onNodeFailure: 'fail', maxFailures: 0 };
    const report = await executeFlowGraph(graph, managed({
      invokeNode: async (request: any) => {
        const raw: any = await echoAdapter(request);
        if (['architecture', 'security'].includes(request.node.id)) delete raw.usage;
        return raw;
      },
      parallelDispatch: async (requests: any[], invoke: any) => Promise.all(requests.map(invoke)),
    }));
    expect(report.realizedResources.tokens).toBeNull();
    expect(report.evidence.branches.architecture.tokens).toBeNull();
    expect(report.evidence.joins['analysis-quorum'].resources.tokens).toBeNull();
    expect(report.accounting.reserved.tokens).toBe(graph.spec.ceilings.tokens - 10);
  });

  it.each(['aiwg', '@aiwg/cli'])('T-OG-14 loads managed Flow from the %s installed layout', async packageName => {
    const directory = mkdtempSync(resolve(tmpdir(), 'composition-installed-'));
    try {
      const manifest = JSON.parse(readFileSync(resolve(packageName === 'aiwg' ? 'package.json' : 'packages/cli/package.json'), 'utf8'));
      const paths = [
        'agentic/code/addons/composition-engine/lib/runtime.mjs',
        'agentic/code/addons/composition-engine/lib/authority.mjs',
        'agentic/code/addons/composition-engine/lib/validator.mjs',
        'agentic/code/addons/composition-engine/schemas/flow-graph.schema.json',
        'schemas/mission-v1.schema.json',
        'schemas/models/model-catalog.v1.schema.json',
        'schemas/models/model-policy.v1.schema.json',
        'schemas/models/model-config-compatibility.v1.schema.json',
        'schemas/models/provider-model-capabilities.v1.schema.json',
        'vscode-extension/schemas/aiwg.config.v1.json',
      ];
      for (const filename of paths) {
        expect(manifest.files.some((entry: string) => entry === filename || (entry.endsWith('/') && filename.startsWith(entry))), filename).toBe(true);
        mkdirSync(dirname(resolve(directory, filename)), { recursive: true });
        copyFileSync(resolve(filename), resolve(directory, filename));
      }
      writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ name: packageName, type: 'module' }));
      symlinkSync(resolve('node_modules'), resolve(directory, 'node_modules'), 'dir');
      const installed = await import(pathToFileURL(resolve(directory, paths[0])).href);
      expect(installed.flowWorkerConsumerSupport()).toEqual(flowWorkerConsumerSupport());
      const report = await installed.executeFlowGraph(artifactGraph(), managed({ factory: installed.createManagedCompositionAdapter,
        invokeNode: async ({ node }: any) => ({ outputs: valuesFor(node, artifact), usage: { tokens: 1, costUsd: 0, timeMs: 1 } }),
      }));
      expect(report.status).toBe('completed');
      expect(report.output).toEqual(artifact);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('refuses to replay a checkpoint interrupted at the invocation boundary', async () => {
    let checkpoint: any;
    const first = await executeFlowGraph(fixture(), managed({
      saveCheckpoint: async (candidate: any) => { if (!checkpoint && Object.keys(candidate.accounting.pending).length) checkpoint = candidate; },
    }));
    let calls = 0;
    const resumed = await executeFlowGraph(fixture(), managed({ resumeFrom: checkpoint, invokeNode: async () => { calls += 1; } }));
    expect(first.status).toBe('completed');
    expect(calls).toBe(0);
    expect(resumed.status).toBe('failed');
    expect(resumed.stopReason).toContain('awaiting owner reconciliation');
  });
});
