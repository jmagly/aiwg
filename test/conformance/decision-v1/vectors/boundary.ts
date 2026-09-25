import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  artifactPin, evaluateDecisionRuleset, JevDecisionAdapter, type AdapterObservation, type DecisionAdapter,
  type DecisionAdapterRequest, type DecisionBinding, type DecisionDefinition, type DecisionEvaluationRequest,
  type DecisionRuleset, type QualificationCaseExecutor, type RulesetResult,
} from '../../../../src/decision/index.js';
import { GraphBudgetLedger } from '../../../../src/decision/graph-budget.js';
import { decisionRulesetFlowInvoker } from '../../../../src/decision/graph-decision-bridge.js';
import { admittedDecisionFlowAdapter, type GraphFlowRequest } from '../../../../src/decision/graph-flow-adapter.js';
import { decisionGraphToFlow } from '../../../../src/decision/graph-flow.js';
import { planDecisionGraph, type DecisionGraph } from '../../../../src/decision/graph.js';

export const CASE_IDS = ['C31', 'C33'] as const;

const run = promisify(execFile);
const DISPATCHER = 'agentic/code/addons/decision-engine/skills/decision-evaluate/scripts/decision-evaluate.mjs';
const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
const definitions = async (): Promise<Record<string, DecisionDefinition>> => ({
  category: await fixture('decision-category.json'), severity: await fixture('decision-severity.json'),
  core: await fixture('decision-core_unavailable.json'),
});

// Records, rather than performs, any outbound socket, DNS or fetch use in a child process.
const NETWORK_PROBE = `
import { appendFileSync } from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
const marker = process.env.C31_NETWORK_MARKER;
const record = kind => { appendFileSync(marker, kind + '\\n'); throw new Error('network disabled by C31 probe'); };
globalThis.fetch = async () => record('fetch');
net.Socket.prototype.connect = function () { return record('socket'); };
net.connect = net.createConnection = () => record('net');
tls.connect = () => record('tls');
dns.lookup = () => record('dns');
dns.promises.lookup = async () => record('dns');
`;

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

const values = (alias: string): AdapterObservation => ({
  status: 'success', reason: 'none', value: alias === 'category' ? 'documentation' : alias === 'severity' ? 0.25 : 0.05,
  actualModel: 'fixture', requestId: null, usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
  uncertainty: { source: 'provider', profile: alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1',
    calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
});
function adapter(observe: (alias: string) => AdapterObservation, calls: string[]): DecisionAdapter {
  return { id: 'jev', version: '1.0.0', capabilities: async () => ({
    answerKinds: ['choice', 'ordinal-score', 'truth-probability'], features: ['choice', 'ordinal-score', 'truth-probability'],
    maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true, egress: { mode: 'none' as const },
  }), evaluate: async request => { calls.push(request.alias); return observe(request.alias); } };
}
const semantics = (result: RulesetResult) => ({
  status: result.spec.status, reason: result.spec.reason, outcome: result.spec.outcome,
  evaluations: Object.fromEntries(Object.entries(result.spec.evaluations).map(([alias, evaluation]) => [alias, {
    status: evaluation.spec.status, reason: evaluation.spec.reason, value: evaluation.spec.value,
    attempts: evaluation.spec.attempts.map(attempt => [attempt.adapter, attempt.reason]),
  }])),
});

/** C31 part 1: the packaged dispatcher refuses before loading the runtime or touching the network. */
async function disabledDispatcher(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'decision-c31-'));
  try {
    const probe = join(root, 'network-probe.mjs');
    const marker = join(root, 'network.log');
    await writeFile(probe, NETWORK_PROBE);
    const request = join(root, 'request.json');
    await writeFile(request, JSON.stringify({ rulesetPath: 'missing.json', bindingPath: 'missing.json', inputPath: 'missing.json',
      receiptDirectory: 'receipts', runId: 'c31', invocationId: 'c31' }));
    // The probe must observe network use when it happens, or its silence proves nothing.
    const control = join(root, 'control.mjs');
    await writeFile(control, "await fetch('https://api.typesafe.ai/v1/systemone').catch(() => undefined);\n");
    const env = { ...process.env, C31_NETWORK_MARKER: marker };
    delete env.AIWG_DECISION_ENABLED;
    await run(process.execPath, ['--import', pathToFileURL(probe).href, control], { env });
    assert.equal((await readFile(marker, 'utf8')).trim(), 'fetch');
    await rm(marker);

    for (const flag of [undefined, '0', 'true']) {
      const childEnv = { ...env, ...(flag === undefined ? {} : { AIWG_DECISION_ENABLED: flag }) };
      const outcome = await run(process.execPath, ['--import', pathToFileURL(probe).href, resolve(DISPATCHER), '--request', request],
        { env: childEnv }).then(() => ({ code: 0, stdout: 'unexpected success', stderr: '' }),
        (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
      assert.equal(outcome.code, 2);
      assert.equal(outcome.stdout, '');
      assert.match(outcome.stderr, /Decision evaluation is disabled/);
      assert.equal(await exists(marker), false);
      assert.equal(await exists(join(root, 'receipts')), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** C31 part 2: disabled opt-in runtime features leave an existing evaluation byte-for-byte unchanged in behavior. */
async function disabledFeaturesUnchanged(): Promise<void> {
  const limits = { concurrency: 1, maxCostUsd: 1, allowUnknownCost: false, maxQueueLength: 1, maxQueueWaitMs: 1 };
  const variants: Array<[string, Partial<DecisionEvaluationRequest>]> = [
    ['baseline', {}],
    ['batching-disabled', { batching: { enabled: false, evaluations: {} } }],
    ['scheduler-disabled', { scheduler: { enabled: false, profileVersion: 'c31', workspace: { id: 'w', limits },
      principal: { id: 'p', limits }, providers: { jev: limits } } }],
  ];
  const observed: Array<{ name: string; calls: string[]; semantics: unknown }> = [];
  for (const [name, overrides] of variants) {
    const calls: string[] = [];
    const result = await evaluateDecisionRuleset({ ruleset: await fixture<DecisionRuleset>('ruleset.json'),
      binding: await fixture<DecisionBinding>('binding-jev.json'), definitions: await definitions(),
      input: await fixture('input.json'), runId: 'c31', invocationId: `c31-${name}`,
      adapters: { jev: adapter(values, calls) }, delay: async () => undefined, ...overrides });
    observed.push({ name, calls: [...calls].sort(), semantics: semantics(result) });
  }
  const [baseline, ...rest] = observed;
  assert.equal(baseline!.calls.length, 3);
  for (const variant of rest) {
    assert.deepEqual(variant.calls, baseline!.calls, variant.name);
    assert.deepEqual(variant.semantics, baseline!.semantics, variant.name);
  }
}

const graphPin = { id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` as const };
const retryGraph: DecisionGraph = { schemaVersion: 'decision-graph/v1', id: 'retry-owner', entry: 'first', terminals: ['first'],
  nodes: [{ id: 'first', stage: 0, subject: 'case', target: 'jev', model: 'm', egress: 'local',
    stateDigest: `sha256:${'b'.repeat(64)}`, definition: graphPin, binding: graphPin, input: [], output: ['result'] }],
  edges: [], budget: { attempts: 2, deadlineMs: 5_000, tokens: 100, costMicros: 100, fanOut: 1, beamWidth: 1, depth: 1, concurrency: 1 } };

/** C33: retries are owned by the binding only; the graph cannot add another retry layer, and caps are global. */
async function singleRetryOwner(): Promise<void> {
  // 1. The graph compiler emits Flow nodes with no retry, and the host admission refuses any node that asks for one.
  const flow = decisionGraphToFlow(retryGraph, { resolvedPins: new Set([graphPin.digest]),
    decisionSkillId: 'aiwg:skill:7763181ed98b5100', terminal: 'first' });
  assert.ok(flow.spec.nodes.every(node => node.retry.limit === 0));
  const plan = planDecisionGraph(retryGraph, new Set([graphPin.digest]));
  const flowRequest = (limit: number): GraphFlowRequest => ({ node: { id: 'first', kind: 'skill', phase: 'stage-0',
    retry: { limit }, sideEffectMode: 'none' }, inputs: {}, runId: 'c33', nodeRunId: 'c33:first',
  activationId: 'c33:activation:1', invocationKey: 'c33-first' });
  let invoked = 0;
  const graphRetry = admittedDecisionFlowAdapter(new GraphBudgetLedger(retryGraph, plan),
    () => ({ attempts: 1, tokens: 1, costMicros: 1 }),
    async () => { invoked += 1; return { outputs: { result: 'ok' }, attempts: 1, usage: { tokens: 1, costUsd: 0.000001, timeMs: 1 } }; });
  await assert.rejects(graphRetry(flowRequest(1)), /unauthorized graph Flow node/);
  assert.equal(invoked, 0);

  // 2. The adapter/SDK layer never retries: one 429 is one fetch, surfaced to the binding with its retry hint.
  const binding = await fixture<DecisionBinding>('binding-jev.json');
  const definition = await fixture<DecisionDefinition>('decision-category.json');
  let fetches = 0;
  const request: DecisionAdapterRequest = { alias: 'category', definition, input: await fixture('input.json'),
    target: binding.spec.evaluations.category!.targets[0]!, invocationId: 'c33-adapter',
    deadlineEpochMs: Date.now() + 10_000, signal: new AbortController().signal,
    resolveCredential: async () => new TextEncoder().encode('synthetic-credential') };
  const observed = await new JevDecisionAdapter({ fetch: async () => { fetches += 1;
    return new Response('{}', { status: 429, headers: { 'retry-after-ms': '5' } }); } }).evaluate(request);
  assert.equal(fetches, 1);
  assert.equal(observed.reason, 'rate-limited');
  assert.equal(observed.retryAfterMs, 5);

  // 3. The binding's global attempt cap bounds retries even when a target asks for more.
  const capped = structuredClone(binding);
  capped.spec.maxAttempts = 4;
  capped.spec.evaluations.category!.targets[0]!.retry.maxRetries = 10;
  const calls: string[] = [];
  const failing = (alias: string): AdapterObservation => alias === 'category'
    ? { ...values(alias), status: 'error', reason: 'rate-limited', value: undefined, uncertainty: null } : values(alias);
  const limited = await evaluateDecisionRuleset({ ruleset: await fixture<DecisionRuleset>('ruleset.json'), binding: capped,
    definitions: await definitions(), input: await fixture('input.json'), runId: 'c33', invocationId: 'c33-attempt-cap',
    adapters: { jev: adapter(failing, calls) }, delay: async () => undefined, random: () => 0.5 });
  assert.ok(calls.length <= capped.spec.maxAttempts, `calls ${calls.length} exceed maxAttempts`);
  const categoryAttempts = limited.spec.evaluations.category!.spec.attempts;
  assert.ok(categoryAttempts.length >= 1 && categoryAttempts.length < 11);
  assert.equal(calls.filter(alias => alias === 'category').length, categoryAttempts.length);

  // 4. The binding's total deadline also caps retries: a retry hint past the deadline stops the loop without waiting.
  const deadline = structuredClone(binding);
  deadline.spec.totalTimeoutMs = 1_000;
  deadline.spec.evaluations.category!.targets[0]!.retry = { maxRetries: 5, initialDelayMs: 250, maxDelayMs: 60_000 };
  let clock = 1_000_000;
  const waits: number[] = [];
  const deadlineCalls: string[] = [];
  const hinted = (alias: string): AdapterObservation => alias === 'category'
    ? { ...failing(alias), retryAfterMs: 30_000 } : values(alias);
  const stopped = await evaluateDecisionRuleset({ ruleset: await fixture<DecisionRuleset>('ruleset.json'), binding: deadline,
    definitions: await definitions(), input: await fixture('input.json'), runId: 'c33', invocationId: 'c33-deadline',
    adapters: { jev: adapter(hinted, deadlineCalls) }, now: () => clock,
    delay: async ms => { waits.push(ms); clock += ms; } });
  assert.deepEqual(waits, []);
  assert.equal(stopped.spec.evaluations.category!.spec.attempts.length, 1);
  assert.notEqual(stopped.spec.evaluations.category!.spec.status, 'success');

  // 5. The graph ledger caps the attempts that the binding actually used: reporting more than was reserved
  //    cancels the ledger, and no further node may dispatch.
  const ledger = new GraphBudgetLedger(retryGraph, plan);
  const resolved = { binding: { metadata: { id: 'binding', version: 'v1' }, kind: 'DecisionBinding' },
    definitions: { d: { metadata: { id: 'definition', version: 'v1' }, kind: 'DecisionDefinition' } },
    input: {}, runId: 'old', invocationId: 'old' } as unknown as DecisionEvaluationRequest;
  const pinGraph: DecisionGraph = { ...retryGraph, nodes: retryGraph.nodes.map(node => ({ ...node,
    definition: artifactPin(resolved.definitions.d), binding: artifactPin(resolved.binding) })) };
  const pinPlan = planDecisionGraph(pinGraph, new Set([artifactPin(resolved.definitions.d).digest, artifactPin(resolved.binding).digest]));
  const twoAttempts = { spec: { status: 'completed', evaluations: { d: { spec: { attempts: [
    { usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, durationMs: 1 },
    { usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, durationMs: 1 },
  ] } } } } } as unknown as RulesetResult;
  let evaluations = 0;
  const invoker = decisionRulesetFlowInvoker(pinGraph, { resolve: () => resolved, project: () => ({ result: 'ok' }),
    unknownCostBoundUsd: 0.000001, evaluate: async () => { evaluations += 1; return twoAttempts; } });
  const pinLedger = new GraphBudgetLedger(pinGraph, pinPlan);
  const guarded = admittedDecisionFlowAdapter(pinLedger, () => ({ attempts: 1, tokens: 10, costMicros: 10 }), invoker);
  await assert.rejects(guarded(flowRequest(0)), /exceeded reservation/);
  await assert.rejects(guarded(flowRequest(0)), /cancelled/);
  assert.equal(evaluations, 1);
  assert.throws(() => ledger.reserve(0, { attempts: 3, tokens: 1, costMicros: 1 }), /budget exhausted/);
}

export const executors: Record<(typeof CASE_IDS)[number], QualificationCaseExecutor> = {
  C31: async () => {
    await disabledDispatcher();
    await disabledFeaturesUnchanged();
    return { outcome: 'pass', details: { dispatcherExit: 2, networkUse: 0, unchangedVariants: 2 } };
  },
  C33: async () => {
    await singleRetryOwner();
    return { outcome: 'pass', details: { graphRetryLimit: 0, adapterRetries: 0, owner: 'binding' } };
  },
};
