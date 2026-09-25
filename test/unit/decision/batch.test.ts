import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  evaluateDecisionRuleset,
  artifactDigest,
  JevDecisionAdapter,
  validateDecisionDocument,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionRuleset,
  type DecisionAdapter,
  type AdapterObservation,
  type DecisionContextPolicy,
  type DecisionProjectionPolicy,
  CanonicalJsonByteEstimator,
  MemoryBatchReceiptStore,
  MemoryBatchResultStore,
  FileBatchReceiptStore,
  FileBatchResultStore,
  batchAccountingTotals,
  batchEnforcementCostMicros,
  decisionBatchQuestionId,
  planDecisionContext,
  compareContextUsage,
  planNativeDecisionBatches,
  DECISION_LIFECYCLE_SURFACES,
  DECISION_LIFECYCLE_VERSION,
  type DecisionLifecyclePolicy,
} from '../../../src/decision/index.js';
import { canonicalJson } from '../../../src/security/artifact-trust.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`examples/decision/${name}`, 'utf8')) as T;
const definitions = (): Record<string, DecisionDefinition> => ({
  category: fixture('decision-category.json'), severity: fixture('decision-severity.json'),
  core: fixture('decision-core_unavailable.json'),
});

const policy = (subjects: Record<string, string> = {
  category: 'ticket:42', severity: 'ticket:42', core_unavailable: 'ticket:42',
}) => ({
  enabled: true,
  evaluations: Object.fromEntries(Object.entries(subjects).map(([alias, decisionSubject]) => [alias,
    { decisionSubject, independent: true, egressPolicy: 'jev-public-v1', hostPolicy: 'host-policy-v1' }]))
});

function request(fetchImpl: typeof fetch, subjects?: Record<string, string>) {
  return {
    ruleset: fixture<DecisionRuleset>('ruleset.json'), binding: fixture<DecisionBinding>('binding-jev.json'),
    definitions: definitions(), input: fixture('input.json'), runId: 'run', invocationId: 'batch-run',
    adapters: { jev: new JevDecisionAdapter({ fetch: fetchImpl }) }, batching: policy(subjects),
    resolveCredential: async () => new TextEncoder().encode('token'),
  };
}

const batchIntegrityKey = randomBytes(32);
const batchEncryptionKey = randomBytes(32);
const batchLifecycle = (): DecisionLifecyclePolicy => ({ version: DECISION_LIFECYCLE_VERSION,
  surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, { classification: 'restricted',
    accessScopes: ['batch-owner'], retentionMs: 86_400_000, export: 'denied', deletion: 'tombstone',
    backup: 'expire-with-primary' }])) as DecisionLifecyclePolicy['surfaces'] });
function keyedFileStores(receiptDirectory: string, resultDirectory: string): [FileBatchReceiptStore, FileBatchResultStore] {
  const results = new FileBatchResultStore(resultDirectory, { integrityKey: batchIntegrityKey, lifecycle: batchLifecycle(),
    encryptionKeyReference: 'batch-results-2026', resolveEncryptionKey: async () => Buffer.from(batchEncryptionKey) });
  return [new FileBatchReceiptStore(receiptDirectory, { integrityKey: batchIntegrityKey, lifecycle: batchLifecycle(), results }), results];
}

function durableBatching(store: MemoryBatchReceiptStore | FileBatchReceiptStore = new MemoryBatchReceiptStore(),
  resultStore?: MemoryBatchResultStore | FileBatchResultStore) {
  const questionIds = ['category', 'severity', 'core_unavailable'].map(decisionBatchQuestionId);
  const estimator = new CanonicalJsonByteEstimator();
  const contextPlan = planDecisionContext({ subject: 'ticket:42', authorizedState: fixture('input.json'),
    authorizationDigest: `sha256:${'a'.repeat(64)}`, incompleteContext: false,
    questions: questionIds.map(id => ({ id, subject: 'ticket:42', entry: { question: id } })) },
  { id: 'jev', version: '1', estimator: { id: estimator.id, version: estimator.version },
    limits: { aggregateTokens: 100_000, stateAndLongestQuestionTokens: 100_000 }, safetyMarginBps: 0, requestEnvelopeTokens: 0 }, estimator);
  return { store, ...(resultStore ? { resultStore } : {}), tenantId: 'tenant', projectId: 'project', contextPlan,
    subjectHash: `sha256:${'b'.repeat(64)}` as const };
}

function contextRuntime(questionTokens = 1): DecisionContextPolicy {
  const estimator = {
    id: 'runtime-fixture', version: '1',
    estimate(value: unknown) {
      const tokens = (value as { tokens?: number }).tokens ?? 1;
      return { tokens, serializedBytes: tokens };
    },
  };
  return {
    input: { subject: 'ticket:42', authorizedState: { tokens: 1 },
      authorizationDigest: `sha256:${'c'.repeat(64)}` as const, incompleteContext: false,
      questions: ['category', 'severity', 'core_unavailable'].map(alias => ({
        id: decisionBatchQuestionId(alias), subject: 'ticket:42', entry: { tokens: questionTokens },
      })) },
    profile: { id: 'jev', version: 'runtime-1', estimator: { id: estimator.id, version: estimator.version },
      limits: { aggregateTokens: 45, stateAndLongestQuestionTokens: 45 }, safetyMarginBps: 0, requestEnvelopeTokens: 0 },
    estimator,
  };
}

function runtimeProjectionPolicy(): DecisionProjectionPolicy {
  return {
    version: '1.0.0', provider: 'jev', model: 'jev-latest', origin: 'https://api.typesafe.ai', region: 'us',
    purpose: 'triage', allowIncompleteContext: false,
    fields: [{ pointer: '/message', output: 'excerpt', source: 'caller', subject: 'ticket:42', trust: 'untrusted',
      sensitivity: 'internal', purpose: 'triage', retentionClass: 'ephemeral', accessScopes: ['decision-runtime'],
      exportPolicy: 'sanitized', deletionPolicy: 'erase', backupPolicy: 'not-persisted', allowedProviders: ['jev'],
      allowedModels: ['jev-latest'], allowedOrigins: ['https://api.typesafe.ai'], allowedRegions: ['us'] }],
  };
}

function validPayload(body: Record<string, unknown>, omitLast = false): Record<string, unknown> {
  const ids = Object.keys(body.questions as object);
  const answers: Record<string, unknown> = {};
  for (const id of [...ids].reverse().slice(omitLast ? 1 : 0)) {
    const question = (body.questions as Record<string, { type: string }>)[id]!;
    answers[id] = question.type === 'choice'
      ? { type: 'choice', choice: 'documentation', probabilities: { documentation: 1, runtime: 0, other: 0 }, confidence: 1 }
      : question.type === 'score'
        ? { type: 'score', score: 0.25, probabilities: { 0: 0.75, 1: 0.25, 2: 0 },
            legend: { 0: 'Cosmetic or documentation issue; core functions work.', 1: 'A feature fails but has a workaround.', 2: 'Core functions unavailable.' }, confidence: 0.8 }
        : { type: 'noul', noul: 0.05 };
  }
  return { answers, model: 'jev-fixture', usage: { input_tokens: 9, output_tokens: 3 } };
}

function validResponse(body: Record<string, unknown>, omitLast = false): Response {
  return new Response(JSON.stringify(validPayload(body, omitLast)), { status: 200 });
}

function malformedResponse(body: Record<string, unknown>, kind: 'missing' | 'extra' | 'duplicate' | 'swapped' | 'wrong-primitive'): Response {
  const payload = validPayload(body) as { answers: Record<string, unknown>; model: string; usage: Record<string, number> };
  const ids = Object.keys(payload.answers);
  if (kind === 'missing') delete payload.answers[ids.at(-1)!];
  if (kind === 'extra') payload.answers.q_unrequested = { type: 'noul', noul: 0.5 };
  if (kind === 'swapped') [payload.answers[ids[0]!], payload.answers[ids[1]!]] =
    [payload.answers[ids[1]!]!, payload.answers[ids[0]!]!];
  if (kind === 'wrong-primitive') {
    const wrongId = Object.keys(body.questions as object).find(id =>
      (body.questions as Record<string, { type: string }>)[id]!.type !== 'noul')!;
    payload.answers[wrongId] = { type: 'noul', noul: 0.5 };
  }
  if (kind !== 'duplicate') return new Response(JSON.stringify(payload), { status: 200 });
  const [first, ...rest] = Object.entries(payload.answers);
  const duplicateAnswers = [[first![0], first![1]], [first![0], first![1]], ...rest]
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',');
  return new Response(`{"answers":{${duplicateAnswers}},"model":"jev-fixture","usage":{"input_tokens":9,"output_tokens":3}}`,
    { status: 200 });
}

describe('native shared-state decision batching', () => {
  it('CTX-RUNTIME partitions provider calls and attaches estimate-versus-actual evidence', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      bodies.push(body);
      return validResponse(body);
    }) as typeof fetch;
    const result = await evaluateDecisionRuleset({ ...request(fetchImpl), context: contextRuntime(20) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies.map(body => Object.keys(body.questions as object).length).sort()).toEqual([1, 2]);
    expect(result.spec.context?.plan.partitions.map(partition => partition.questionIds.length)).toEqual([2, 1]);
    expect(result.spec.context?.actualUsage).toHaveLength(2);
    expect(result.spec.context?.actualUsage.every(item => item.actualInputTokens === 9)).toBe(true);
    expect(Object.values(result.spec.evaluations).every(item => item.spec.context?.plan.planDigest === result.spec.context?.plan.planDigest)).toBe(true);
    Object.values(result.spec.evaluations).forEach(validateDecisionDocument);
    // D06 context evidence from v1alpha1 inputs is written only as v1alpha2.
    expect(result.apiVersion).toBe('decision.aiwg.io/v1alpha2');
    validateDecisionDocument(result);
  });

  it('CTX-RUNTIME records request-accurate usage when compatible batch is a subset of a context partition', async () => {
    const fetchImpl = vi.fn(async (_url, options) => validResponse(JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
    const runtime = contextRuntime();
    runtime.profile.limits.aggregateTokens = 100;
    runtime.profile.limits.stateAndLongestQuestionTokens = 100;
    const batching = policy();
    batching.evaluations.severity!.egressPolicy = 'another-egress-policy';
    const result = await evaluateDecisionRuleset({ ...request(fetchImpl), batching, context: runtime });
    expect(result.spec.context?.plan.partitions).toHaveLength(1);
    const usage = result.spec.context?.actualUsage ?? [];
    expect(usage).toHaveLength(2);
    const pair = usage.find(item => item.questionIds.length === 2);
    expect(pair?.estimatedInputTokens).toBe(3);
    expect(pair?.questionIds).toEqual([decisionBatchQuestionId('category'), decisionBatchQuestionId('core_unavailable')].sort());
    expect(usage.find(item => item.questionIds.length === 1)?.estimatedInputTokens).toBe(2);
  });

  it('CTX-ROLLOUT observes only single calls and blocks unqualified enforcement before credentials', async () => {
    const fetchImpl = vi.fn(async (_url, options) => validResponse(JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
    const runtime = contextRuntime();
    runtime.profile.limits.aggregateTokens = 100;
    runtime.profile.limits.stateAndLongestQuestionTokens = 100;
    runtime.rollout = { mode: 'observe-only' };
    const observed = await evaluateDecisionRuleset({ ...request(fetchImpl), context: runtime });
    expect(observed.spec.context?.actualUsage).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const credential = vi.fn(async () => new TextEncoder().encode('token'));
    const qualification = compareContextUsage([{ caseId: 'offline', input: runtime.input,
      actualInputTokens: 3, source: 'synthetic', usageRef: 'fixture:offline' }], runtime.profile, runtime.estimator);
    runtime.rollout = { mode: 'enforce', qualification };
    const rejected = await evaluateDecisionRuleset({ ...request(fetchImpl), resolveCredential: credential, context: runtime });
    expect(rejected.spec.reason).toBe('invalid-input');
    expect(credential).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('CTX-RUNTIME rejects stale plans before capability, credential, or transport access', async () => {
    const runtime = contextRuntime();
    runtime.plan = planDecisionContext(runtime.input, runtime.profile, runtime.estimator);
    runtime.input.authorizationDigest = `sha256:${'d'.repeat(64)}`;
    const adapter = new JevDecisionAdapter({ fetch: vi.fn() as unknown as typeof fetch });
    const capabilities = vi.spyOn(adapter, 'capabilities');
    const credential = vi.fn(async () => new TextEncoder().encode('token'));
    const result = await evaluateDecisionRuleset({ ...request(vi.fn() as unknown as typeof fetch),
      adapters: { jev: adapter }, resolveCredential: credential, context: runtime });
    expect(result.spec.reason).toBe('invalid-input');
    expect(capabilities).not.toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
  });

  it('CTX-RUNTIME rejects mixed subjects before transport access', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const runtime = contextRuntime();
    runtime.input.questions[1]!.subject = 'ticket:other';
    const result = await evaluateDecisionRuleset({ ...request(fetchImpl), context: runtime });
    expect(result.spec.reason).toBe('invalid-input');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('PROJ-RUNTIME projects trusted host state before credential lookup for single requests', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      bodies.push(body);
      return validResponse(body);
    }) as typeof fetch;
    const configured = request(fetchImpl);
    configured.batching.enabled = false;
    const credential = vi.fn(async () => new TextEncoder().encode('token'));
    const evidence = vi.fn();
    const result = await evaluateDecisionRuleset({ ...configured, resolveCredential: credential,
      projection: { resolve: runtimeProjectionPolicy, onEvidence: evidence } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(credential).toHaveBeenCalledTimes(3);
    expect(bodies.every(body => JSON.stringify(body.state) === JSON.stringify({
      excerpt: 'The documentation link on the settings page is broken. The application otherwise works.',
    }))).toBe(true);
    expect(evidence).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(evidence.mock.calls)).not.toContain('The documentation link');
    expect(Object.values(result.spec.evaluations).every(item => item.spec.status === 'success')).toBe(true);
  });

  it('PROJ-DEBUG captures only minimized state and denies capture failure before credentials', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const credential = vi.fn(async () => new TextEncoder().encode('fixture-token'));
    const configured = request(fetchImpl);
    configured.batching.enabled = false;
    const captured: string[] = [];
    const capture = vi.fn(async (_scope: string, bytes: Uint8Array) => {
      captured.push(new TextDecoder().decode(bytes));
      throw new Error('synthetic-debug-secret-canary');
    });
    const result = await evaluateDecisionRuleset({ ...configured, resolveCredential: credential,
      projection: { resolve: runtimeProjectionPolicy, debugCapture: { scope: 'case-7', capture } } });
    expect(capture).toHaveBeenCalled();
    expect(captured.every(value => JSON.stringify(JSON.parse(value)) === JSON.stringify({
      excerpt: 'The documentation link on the settings page is broken. The application otherwise works.',
    }))).toBe(true);
    expect(credential).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('synthetic-debug-secret-canary');
    expect(Object.values(result.spec.evaluations).every(value => value.spec.reason === 'data-boundary-denied')).toBe(true);
  });

  it('PROJ-DEBUG succeeds with a host capture sink without leaking ambient state', async () => {
    const fetchImpl = vi.fn(async (_url, options) => validResponse(JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
    const configured = request(fetchImpl);
    configured.batching.enabled = false;
    const captures: string[] = [];
    const capture = vi.fn(async (_scope: string, data: Uint8Array) => {
      captures.push(new TextDecoder().decode(data));
      return 'opaque-debug-reference';
    });
    const result = await evaluateDecisionRuleset({ ...configured,
      projection: { resolve: runtimeProjectionPolicy, debugCapture: { scope: 'case-7', capture } } });
    expect(Object.values(result.spec.evaluations).every(value => value.spec.status === 'success')).toBe(true);
    expect(captures).toHaveLength(3);
    expect(captures.every(value => JSON.stringify(JSON.parse(value)) === JSON.stringify({
      excerpt: 'The documentation link on the settings page is broken. The application otherwise works.',
    }))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('opaque-debug-reference');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('PROJ-DEBUG denies a native batch when one projected capture fails', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const credential = vi.fn(async () => new TextEncoder().encode('fixture-token'));
    const capture = vi.fn(async () => { throw new Error('synthetic-debug-secret-canary'); });
    const result = await evaluateDecisionRuleset({ ...request(fetchImpl), resolveCredential: credential,
      projection: { resolve: runtimeProjectionPolicy, debugCapture: { scope: 'case-7', capture } } });
    expect(capture).toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('synthetic-debug-secret-canary');
  });

  it('PROJ-RUNTIME fails a native batch closed before credential lookup or transport', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const credential = vi.fn(async () => new TextEncoder().encode('token'));
    const configured = request(fetchImpl);
    const result = await evaluateDecisionRuleset({ ...configured, resolveCredential: credential,
      projection: { resolve: ({ alias }) => ({ ...runtimeProjectionPolicy(),
        ...(alias === 'severity' ? { model: 'unapproved-model' } : {}) }) } });
    expect(credential).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(Object.values(result.spec.evaluations).map(item => item.spec.reason)).toEqual([
      'data-boundary-denied', 'data-boundary-denied', 'data-boundary-denied',
    ]);
  });

  it('CTX-RUNTIME preserves dependency waves when partitions degrade to single requests', async () => {
    const pending = new Map<string, () => void>();
    const started: string[] = [];
    const fetchImpl = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      const id = Object.keys(body.questions as object)[0]!;
      started.push(id);
      await new Promise<void>(resolve => pending.set(id, resolve));
      return validResponse(body);
    }) as typeof fetch;
    const configured = request(fetchImpl);
    configured.batching.enabled = false;
    configured.binding.spec.concurrency = 3;
    const sharedLimits = { concurrency: 3, maxQueueLength: 8, maxQueueWaitMs: 1_000 };
    configured.scheduler = { enabled: true, profileVersion: 'offline-v1', callerConcurrency: 3,
      workspace: { id: 'workspace', limits: sharedLimits }, principal: { id: 'principal', limits: sharedLimits },
      providers: { jev: sharedLimits } };
    const runtime = contextRuntime();
    runtime.input.questions.find(question => question.id === decisionBatchQuestionId('severity'))!.dependsOn = [
      decisionBatchQuestionId('category'),
    ];
    const evaluation = evaluateDecisionRuleset({ ...configured, context: runtime });
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started).not.toContain('severity');
    for (const resolve of pending.values()) resolve();
    await vi.waitFor(() => expect(started).toContain('severity'));
    pending.get('severity')!();
    const result = await evaluation;
    expect(result.spec.context?.actualUsage).toHaveLength(3);
    expect(result.spec.context?.actualUsage.map(item => item.questionIds)).toEqual(expect.arrayContaining([
      [decisionBatchQuestionId('category')], [decisionBatchQuestionId('core_unavailable')], [decisionBatchQuestionId('severity')],
    ]));
  });

  it('BCH-001/006 sends heterogeneous questions once and normalizes in declaration order', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      bodies.push(body);
      return validResponse(body);
    }) as typeof fetch;
    const result = await evaluateDecisionRuleset(request(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodies[0]?.state).toEqual(fixture('input.json'));
    expect(Object.keys(bodies[0]?.questions as object)).toHaveLength(3);
    expect(Object.keys(result.spec.evaluations)).toEqual(['category', 'severity', 'core_unavailable']);
    expect(Object.values(result.spec.evaluations).map(value => value.spec.attempts[0]?.batch?.mode)).toEqual(['native', 'native', 'native']);
    expect(new Set(Object.values(result.spec.evaluations).map(value => value.spec.attempts[0]?.batch?.groupId)).size).toBe(1);
    validateDecisionDocument(result.spec.evaluations.category!);
  });

  it.each(['missing', 'extra', 'duplicate', 'swapped', 'wrong-primitive'] as const)(
    'BCH-004/005 rejects a %s atomic response for every sibling', async kind => {
    const fetchImpl = vi.fn(async (_url, options) => malformedResponse(
      JSON.parse(String(options?.body)) as Record<string, unknown>, kind)) as typeof fetch;
    const result = await evaluateDecisionRuleset(request(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Object.values(result.spec.evaluations).map(value => value.spec.reason)).toEqual([
      'invalid-output', 'invalid-output', 'invalid-output',
    ]);
    expect(result.spec.status).toBe('review');
  });

  it('includes trusted host-policy identity in batch eligibility', async () => {
    const fetchImpl = vi.fn(async (_url, options) => validResponse(
      JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
    const configured = request(fetchImpl);
    configured.batching.evaluations.category!.hostPolicy = 'isolated-host-policy';
    const result = await evaluateDecisionRuleset(configured);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.spec.evaluations.category!.spec.attempts[0]!.batch!.mode).toBe('single');
    expect(result.spec.evaluations.severity!.spec.attempts[0]!.batch!.mode).toBe('native');
    expect(result.spec.evaluations.core_unavailable!.spec.attempts[0]!.batch!.mode).toBe('native');
  });

  it.each([
    ['adapter', (candidate: ReturnType<typeof candidatesForMatrix>[number]) => {
      candidate.adapter = { ...candidate.adapter, id: 'jev-alternate' };
    }],
    ['target', (candidate: ReturnType<typeof candidatesForMatrix>[number]) => {
      candidate.target = { ...candidate.target, subagent: { id: 'worker', version: '2', digest: `sha256:${'d'.repeat(64)}` } };
    }],
    ['model', (candidate: ReturnType<typeof candidatesForMatrix>[number]) => {
      candidate.target = { ...candidate.target, model: 'different-model' };
    }],
    ['credential', (candidate: ReturnType<typeof candidatesForMatrix>[number]) => {
      candidate.target = { ...candidate.target, credentialRef: 'typesafe:jev/other' };
    }],
    ['egress', (_candidate: ReturnType<typeof candidatesForMatrix>[number], batchPolicy: ReturnType<typeof policy>) => {
      batchPolicy.evaluations.category!.egressPolicy = 'different-egress-policy';
    }],
    ['deadline', (candidate: ReturnType<typeof candidatesForMatrix>[number]) => {
      candidate.target = { ...candidate.target, timeoutMs: candidate.target.timeoutMs + 1 };
    }],
  ] as const)('AC3 isolates an incompatible %s envelope', async (_dimension, mutate) => {
    const candidates = await candidatesForMatrix();
    const batchPolicy = policy();
    mutate(candidates[0]!, batchPolicy);
    const plans = planNativeDecisionBatches(candidates, batchPolicy);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.candidates.map(candidate => candidate.alias)).toEqual(['severity', 'core_unavailable']);
  });

  it('orders independent batch groups by dependency stage and never combines stages', async () => {
    const adapter = new JevDecisionAdapter({ fetch: vi.fn() as unknown as typeof fetch });
    const capabilities = await adapter.capabilities();
    const target = fixture<DecisionBinding>('binding-jev.json').spec.evaluations.category!.targets[0]!;
    const definition = definitions().category!;
    const aliases = ['later-a', 'earlier-a', 'later-b', 'earlier-b'];
    const candidates = aliases.map(alias => ({ alias, definition, input: fixture('input.json'), target, adapter, capabilities }));
    const evaluations = Object.fromEntries(aliases.map(alias => [alias, {
      decisionSubject: 'ticket:42', independent: true, egressPolicy: 'jev-public-v1', hostPolicy: 'host-policy-v1',
      stage: alias.startsWith('later') ? 1 : 0,
    }]));
    const plans = planNativeDecisionBatches(candidates, { enabled: true, evaluations });
    expect(plans.map(plan => [plan.stage, plan.candidates.map(candidate => candidate.alias).sort()])).toEqual([
      [0, ['earlier-a', 'earlier-b']], [1, ['later-a', 'later-b']],
    ]);
  });

  it('BCH-002/003/009 fans out different subjects despite identical projected state', async () => {
    const fetchImpl = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      return validResponse(body);
    }) as typeof fetch;
    const result = await evaluateDecisionRuleset(request(fetchImpl, {
      category: 'ticket:1', severity: 'ticket:2', core_unavailable: 'ticket:3',
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(Object.values(result.spec.evaluations).map(value => value.spec.attempts[0]?.batch?.mode)).toEqual(['single', 'single', 'single']);
  });

  it('BCH-007 preserves the single-call adapter path and records unsupported degradation', async () => {
    const observe = (alias: string): AdapterObservation => ({
      status: 'success', reason: 'none', value: alias === 'category' ? 'documentation' : alias === 'severity' ? 0.25 : 0.05,
      uncertainty: null, actualModel: 'fixture', usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestId: null,
    });
    const adapter: DecisionAdapter = {
      id: 'jev', version: '1.0.0',
      capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'],
        features: [], maxOptions: 255, maxLevels: 10, confidenceProfiles: [], executable: true }),
      evaluate: vi.fn(async value => observe(value.alias)),
    };
    const base = request(vi.fn() as unknown as typeof fetch);
    const result = await evaluateDecisionRuleset({ ...base, adapters: { jev: adapter } });
    expect(adapter.evaluate).toHaveBeenCalledTimes(3);
    expect(Object.values(result.spec.evaluations).map(value => value.spec.attempts[0]?.batch?.degradationReason))
      .toEqual(['unsupported', 'unsupported', 'unsupported']);
  });

  it('BCH-CONFORMANCE preserves primitive and domain semantics between native batch and single calls', async () => {
    const batchFetch = vi.fn(async (_url, options) => validResponse(
      JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
    const singleFetch = vi.fn(async (_url, options) => validResponse(
      JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
    const batched = await evaluateDecisionRuleset(request(batchFetch));
    const singles = await evaluateDecisionRuleset({ ...request(singleFetch), batching: { enabled: false, evaluations: {} } });
    const semantics = (result: typeof batched) => Object.fromEntries(Object.entries(result.spec.evaluations)
      .map(([alias, evaluation]) => [alias, {
        status: evaluation.spec.status, reason: evaluation.spec.reason, value: evaluation.spec.value,
        uncertainty: evaluation.spec.uncertainty,
      }]));
    expect(semantics(batched)).toEqual(semantics(singles));
    expect(batchFetch).toHaveBeenCalledTimes(1);
    expect(singleFetch).toHaveBeenCalledTimes(3);
    Object.values(batched.spec.evaluations).forEach(validateDecisionDocument);
    Object.values(singles.spec.evaluations).forEach(validateDecisionDocument);
  });

  it('BCH-CONFORMANCE does not assume batch and single probabilities are numerically invariant', async () => {
    const batchFetch = vi.fn(async (_url, options) => validResponse(
      JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
    const singleFetch = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      const payload = validPayload(body) as { answers: Record<string, Record<string, unknown>>; model: string; usage: Record<string, number> };
      const [answer] = Object.values(payload.answers);
      if (answer?.type === 'choice') {
        answer.probabilities = { documentation: 0.6, runtime: 0.3, other: 0.1 };
        answer.confidence = 0.7;
      } else if (answer?.type === 'score') {
        answer.score = 0.4;
        answer.probabilities = { 0: 0.6, 1: 0.4, 2: 0 };
        answer.confidence = 0.65;
      } else if (answer?.type === 'noul') {
        answer.noul = 0.15;
      }
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
    const batched = await evaluateDecisionRuleset(request(batchFetch));
    const singles = await evaluateDecisionRuleset({ ...request(singleFetch), batching: { enabled: false, evaluations: {} } });

    expect(batchFetch).toHaveBeenCalledTimes(1);
    expect(singleFetch).toHaveBeenCalledTimes(3);
    expect(Object.values(batched.spec.evaluations).map(value => value.spec.status)).toEqual(['success', 'success', 'success']);
    expect(Object.values(singles.spec.evaluations).map(value => value.spec.status)).toEqual(['success', 'success', 'success']);
    expect(singles.spec.evaluations.category?.spec.value).toBe('documentation');
    expect(singles.spec.evaluations.severity?.spec.value).toBe(0.4);
    expect(singles.spec.evaluations.core_unavailable?.spec.value).toBe(0.15);
    expect(singles.spec.evaluations.category?.spec.uncertainty?.distribution)
      .not.toEqual(batched.spec.evaluations.category?.spec.uncertainty?.distribution);
    Object.values(batched.spec.evaluations).forEach(validateDecisionDocument);
    Object.values(singles.spec.evaluations).forEach(validateDecisionDocument);
  });

  it('REC-BATCH-003 persists failed and successful transport attempts with additive accounting', async () => {
    const store = new MemoryBatchReceiptStore();
    const resultStore = new MemoryBatchResultStore();
    const fetchImpl = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      return fetchImpl.mock.calls.length === 1
        ? new Response('unavailable', { status: 503, headers: { 'x-request-id': 'req_failed' } })
        : new Response(JSON.stringify(validPayload(body)), { status: 200, headers: { 'x-request-id': 'req_success' } });
    }) as typeof fetch;
    const configured = request(fetchImpl);
    configured.binding.spec.maxAttempts = 6;
    for (const target of Object.values(configured.binding.spec.evaluations)) target.targets[0]!.retry.maxRetries = 1;
    const settings = { ...configured, batchReceipts: { ...durableBatching(store, resultStore),
      priceCatalog: { id: 'fixture', version: '2026-09-20', effectiveAt: '2026-09-20T00:00:00Z',
        currency: 'USD' as const, inputMicrosPerMillionTokens: 42_000, outputMicrosPerMillionTokens: 0 },
      unknownCostBound: { upperBoundMicros: 100, policyId: 'conservative', policyVersion: '1' } } };
    const first = await evaluateDecisionRuleset(settings);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const id = Object.values(first.spec.evaluations)[0]!.spec.batchResult!.batchId;
    const receipt = (await store.read(id, 'tenant', 'project'))!;
    expect(receipt.attempts.map(attempt => [attempt.status, attempt.providerRequestId]))
      .toEqual([['failed', 'req_failed'], ['succeeded', 'req_success']]);
    expect(batchAccountingTotals(receipt).usage).toEqual({ inputTokens: null, outputTokens: null });
    expect(receipt.allocations.every(allocation => allocation.inputTokens === null)).toBe(true);
    expect(receipt.attempts.map(attempt => attempt.cost.kind)).toEqual(['bounded-unknown', 'client-derived']);
    expect(batchEnforcementCostMicros(receipt)).toBe(100);
    expect(Object.values(first.spec.evaluations).every(value => value.spec.attempts.length === 2)).toBe(true);
    const replay = await evaluateDecisionRuleset(settings);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(Object.values(replay.spec.evaluations).map(value => value.spec.batchResult))
      .toEqual(Object.values(first.spec.evaluations).map(value => value.spec.batchResult));
  });

  it('REC-BATCH-003 counts failed transport usage once before successful retry', async () => {
    const store = new MemoryBatchReceiptStore();
    const resultStore = new MemoryBatchResultStore();
    const fetchImpl = vi.fn(async (_url, options) => new Response(
      JSON.stringify(validPayload(JSON.parse(String(options?.body)) as Record<string, unknown>)),
      { status: 200, headers: { 'x-request-id': `req_${fetchImpl.mock.calls.length}` } })) as typeof fetch;
    const configured = request(fetchImpl);
    configured.binding.spec.maxAttempts = 6;
    for (const target of Object.values(configured.binding.spec.evaluations)) target.targets[0]!.retry.maxRetries = 1;
    const original = configured.adapters.jev.evaluateMany.bind(configured.adapters.jev);
    vi.spyOn(configured.adapters.jev, 'evaluateMany').mockImplementationOnce(async batch => {
      const response = await original(batch);
      return { ...response, answers: response.answers.map(answer => ({ ...answer,
        observation: { ...answer.observation, status: 'error', reason: 'service-error', value: undefined },
      })) };
    });
    const result = await evaluateDecisionRuleset({ ...configured, batchReceipts: durableBatching(store, resultStore) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const receipt = (await store.read(Object.values(result.spec.evaluations)[0]!.spec.batchResult!.batchId,
      'tenant', 'project'))!;
    expect(receipt.attempts.map(value => value.status)).toEqual(['failed', 'succeeded']);
    expect(receipt.attempts.map(value => value.providerRequestId)).toEqual(['req_1', 'req_2']);
    expect(batchAccountingTotals(receipt).usage).toEqual({ inputTokens: 18, outputTokens: 6 });
    expect(receipt.allocations.reduce((sum, value) => sum + value.inputTokens!, 0)).toBe(18);
    expect(Object.values(result.spec.evaluations).every(value => value.spec.attempts.length === 2)).toBe(true);
    expect(Object.values(result.spec.evaluations).every(value => value.spec.attempts.every(attempt =>
      attempt.usage.inputTokens === null && attempt.requestId === null))).toBe(true);
  });

  it('REC-BATCH-003 persists native fallback lineage and replays without redispatch', async () => {
    const store = new MemoryBatchReceiptStore();
    const resultStore = new MemoryBatchResultStore();
    const fetchImpl = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      return fetchImpl.mock.calls.length === 1
        ? new Response('unavailable', { status: 503, headers: { 'x-request-id': 'req_first' } })
        : new Response(JSON.stringify(validPayload(body)), { status: 200, headers: { 'x-request-id': 'req_fallback' } });
    }) as typeof fetch;
    const configured = request(fetchImpl);
    configured.binding.spec.maxAttempts = 6;
    for (const evaluation of Object.values(configured.binding.spec.evaluations)) {
      evaluation.targets.push({ ...structuredClone(evaluation.targets[0]!), model: 'jev-fallback' });
      evaluation.fallbackOn.push('service-error');
    }
    const settings = { ...configured, batchReceipts: durableBatching(store, resultStore) };
    const result = await evaluateDecisionRuleset(settings);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([, options]) =>
      (JSON.parse(String(options?.body)) as { model: string }).model)).toEqual(['jev-latest', 'jev-fallback']);
    const receipt = (await store.read(Object.values(result.spec.evaluations)[0]!.spec.batchResult!.batchId,
      'tenant', 'project'))!;
    expect(receipt.attempts.map(value => [value.status, value.requestedModel, value.fallbackFromAttemptOrdinal]))
      .toEqual([['failed', 'jev-latest', null], ['succeeded', 'jev-fallback', 1]]);
    expect(receipt.attempts.map(value => value.providerRequestId)).toEqual(['req_first', 'req_fallback']);
    const replay = await evaluateDecisionRuleset(settings);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(Object.values(replay.spec.evaluations).map(value => value.spec.attempts))
      .toEqual(Object.values(result.spec.evaluations).map(value => value.spec.attempts));
  });

  it('preflights fallback egress before sending the first shared request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const credential = vi.fn(async () => new TextEncoder().encode('token'));
    const configured = request(fetchImpl);
    configured.binding.spec.maxAttempts = 6;
    for (const evaluation of Object.values(configured.binding.spec.evaluations)) {
      evaluation.targets.push({ ...structuredClone(evaluation.targets[0]!), model: 'jev-fallback' });
      evaluation.fallbackOn.push('service-error');
    }
    const result = await evaluateDecisionRuleset({ ...configured, resolveCredential: credential,
      projection: { resolve: runtimeProjectionPolicy },
      batchReceipts: durableBatching(new MemoryBatchReceiptStore(), new MemoryBatchResultStore()) });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
    expect(Object.values(result.spec.evaluations).every(value => value.spec.reason === 'data-boundary-denied')).toBe(true);
  });

  it('blocks a retry when failed-attempt consumption exhausts the conservative cost ceiling', async () => {
    const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503,
      headers: { 'x-request-id': 'req_failure' } })) as typeof fetch;
    const configured = request(fetchImpl);
    configured.binding.spec.maxAttempts = 6;
    for (const target of Object.values(configured.binding.spec.evaluations)) target.targets[0]!.retry.maxRetries = 1;
    const store = new MemoryBatchReceiptStore();
    const result = await evaluateDecisionRuleset({ ...configured, batchReceipts: {
      ...durableBatching(store, new MemoryBatchResultStore()),
      unknownCostBound: { upperBoundMicros: 100, policyId: 'limit', policyVersion: '1' }, maxCostMicros: 100 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Object.values(result.spec.evaluations).every(value => value.spec.batchResult === undefined
      && value.spec.attempts.length === 1 && value.spec.reason === 'service-error')).toBe(true);
  });

  it('BCH-001 persists separate provider totals for split partitions of one plan', async () => {
    const context = contextRuntime(20);
    const extraAlias = 'category_second';
    context.input.questions.push({ id: decisionBatchQuestionId(extraAlias), subject: 'ticket:42', entry: { tokens: 20 } });
    const contextPlan = planDecisionContext(context.input, context.profile, context.estimator);
    expect(contextPlan.partitions.map(partition => partition.questionIds.length).sort()).toEqual([2, 2]);
    const store = new MemoryBatchReceiptStore();
    const resultStore = new MemoryBatchResultStore();
    const calls: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      calls.push(body);
      return validResponse(body);
    }) as typeof fetch;
    const configured = request(fetchImpl);
    configured.ruleset.spec.evaluations.push({ ...configured.ruleset.spec.evaluations[0]!, alias: extraAlias });
    configured.binding.spec.ruleset.digest = artifactDigest(configured.ruleset);
    configured.binding.spec.evaluations[extraAlias] = structuredClone(configured.binding.spec.evaluations.category!);
    configured.binding.spec.maxAttempts = 4;
    configured.definitions[extraAlias] = configured.definitions.category!;
    configured.batching.evaluations[extraAlias] = structuredClone(configured.batching.evaluations.category!);
    const settings = { ...configured, context, batchReceipts: { ...durableBatching(store, resultStore), contextPlan } };
    const result = await evaluateDecisionRuleset(settings);
    expect(calls).toHaveLength(2);
    const references = Object.values(result.spec.evaluations).map(value => value.spec.batchResult!);
    expect(references.every(Boolean)).toBe(true);
    const batchIds = [...new Set(references.map(ref => ref.batchId))];
    expect(batchIds).toHaveLength(2);
    const receipts = await Promise.all(batchIds.map(id => store.read(id, 'tenant', 'project')));
    expect(new Set(receipts.map(receipt => receipt!.plan.planDigest))).toEqual(new Set([contextPlan.planDigest]));
    expect(new Set(receipts.map(receipt => receipt!.plan.partitionId)).size).toBe(2);
    expect(receipts.map(receipt => receipt!.attempts[0]!.usage.inputTokens)).toEqual([9, 9]);
    expect(receipts.reduce((sum, receipt) => sum + batchAccountingTotals(receipt!).usage.inputTokens!, 0)).toBe(18);
    const replay = await evaluateDecisionRuleset(settings);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(Object.values(replay.spec.evaluations).map(value => value.spec.batchResult)).toEqual(references);
  });

  it('caps partition admission using receipt totals rather than per-answer estimates', async () => {
    const context = contextRuntime(20);
    const alias = 'category_second';
    context.input.questions.push({ id: decisionBatchQuestionId(alias), subject: 'ticket:42', entry: { tokens: 20 } });
    const contextPlan = planDecisionContext(context.input, context.profile, context.estimator);
    const store = new MemoryBatchReceiptStore();
    const fetchImpl = vi.fn(async (_url, options) => validResponse(
      JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
    const configured = request(fetchImpl);
    configured.ruleset.spec.evaluations.push({ ...configured.ruleset.spec.evaluations[0]!, alias });
    configured.binding.spec.ruleset.digest = artifactDigest(configured.ruleset);
    configured.binding.spec.evaluations[alias] = structuredClone(configured.binding.spec.evaluations.category!);
    configured.binding.spec.maxAttempts = 4;
    configured.definitions[alias] = configured.definitions.category!;
    configured.batching.evaluations[alias] = structuredClone(configured.batching.evaluations.category!);
    const policy = { ...durableBatching(store, new MemoryBatchResultStore()), contextPlan,
      unknownCostBound: { upperBoundMicros: 100, policyId: 'limit', policyVersion: '1' }, maxCostMicros: 100 };
    const result = await evaluateDecisionRuleset({ ...configured, context, batchReceipts: policy });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Object.values(result.spec.evaluations).filter(value => value.spec.reason === 'budget-exhausted')).toHaveLength(2);
    expect(Object.values(result.spec.evaluations).filter(value => value.spec.batchResult)).toHaveLength(2);
    const withoutBound = await evaluateDecisionRuleset({ ...configured, context,
      batchReceipts: { ...policy, unknownCostBound: undefined } });
    expect(withoutBound.spec.reason).toBe('budget-exhausted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('REC-BATCH runtime owns shared accounting once and emits reference-only result links', async () => {
    const store = new MemoryBatchReceiptStore();
    const fetchImpl = vi.fn(async (_url, options) => validResponse(
      JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
    const result = await evaluateDecisionRuleset({ ...request(fetchImpl), batchReceipts: durableBatching(store, new MemoryBatchResultStore()) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const references = Object.values(result.spec.evaluations).map(value => value.spec.batchResult);
    expect(references.every(Boolean)).toBe(true);
    expect(new Set(references.map(value => value!.batchId)).size).toBe(1);
    expect(Object.values(result.spec.evaluations).map(value => value.spec.attempts[0]!.usage))
      .toEqual(Array(3).fill({ inputTokens: null, outputTokens: null, costUsd: null }));
    const receipt = await store.read(references[0]!.batchId, 'tenant', 'project');
    expect(receipt?.answerReferences).toHaveLength(3);
    expect(batchAccountingTotals(receipt!).usage).toEqual({ inputTokens: 9, outputTokens: 3 });
    Object.values(result.spec.evaluations).forEach(validateDecisionDocument);
    // D07 batch receipt references from v1alpha1 inputs are written only as v1alpha2.
    expect(result.apiVersion).toBe('decision.aiwg.io/v1alpha2');
    expect(Object.values(result.spec.evaluations).every(value => value.apiVersion === 'decision.aiwg.io/v1alpha2')).toBe(true);
    validateDecisionDocument(result);
  });

  it('contains malformed high-cardinality transport request IDs in the batch receipt', async () => {
    const store = new MemoryBatchReceiptStore();
    const fetchImpl = vi.fn(async (_url, options) => new Response(
      JSON.stringify(validPayload(JSON.parse(String(options?.body)) as Record<string, unknown>)),
      { status: 200, headers: { 'x-request-id': 'x'.repeat(257) } })) as typeof fetch;
    const result = await evaluateDecisionRuleset({ ...request(fetchImpl),
      batchReceipts: durableBatching(store, new MemoryBatchResultStore()) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const id = Object.values(result.spec.evaluations)[0]!.spec.batchResult!.batchId;
    const receipt = (await store.read(id, 'tenant', 'project'))!;
    expect(receipt.attempts[0]!.providerRequestId).toBeNull();
    expect(Object.values(result.spec.evaluations).every(value => value.spec.attempts[0]!.requestId === null)).toBe(true);
  });

  it('reconstructs completed durable batch values from governed result repository without redispatch', async () => {
    const store = new MemoryBatchReceiptStore();
    const resultStore = new MemoryBatchResultStore();
    const fetchImpl = vi.fn(async (_url, options) => validResponse(
      JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
    const configured = { ...request(fetchImpl), batchReceipts: durableBatching(store, resultStore) };
    const first = await evaluateDecisionRuleset(configured);
    const firstReference = Object.values(first.spec.evaluations)[0]?.spec.batchResult;
    expect(firstReference).toBeTruthy();
    const receipt = await store.read(firstReference!.batchId, 'tenant', 'project');
    expect(receipt).toBeTruthy();
    const stored = await resultStore.readMany(receipt!);
    expect([...stored.values()].map(value => [value.status, value.reason])).toEqual([
      ['success', 'none'], ['success', 'none'], ['success', 'none'],
    ]);
    const second = await evaluateDecisionRuleset(configured);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Object.values(second.spec.evaluations).map(result => [result.spec.status, result.spec.reason])).toEqual([
      ['success', 'none'], ['success', 'none'], ['success', 'none'],
    ]);
    expect(Object.fromEntries(Object.entries(second.spec.evaluations).map(([alias, result]) => [alias, result.spec.value])))
      .toEqual(Object.fromEntries(Object.entries(first.spec.evaluations).map(([alias, result]) => [alias, result.spec.value])));
    expect(Object.values(second.spec.evaluations).map(result => result.spec.batchResult))
      .toEqual(Object.values(first.spec.evaluations).map(result => result.spec.batchResult));
    expect(Object.values(second.spec.evaluations).map(result => result.spec.attempts[0]!.durationMs))
      .toEqual(Object.values(first.spec.evaluations).map(result => result.spec.attempts[0]!.durationMs));
    expect(Object.values(second.spec.evaluations).map(value => value.spec.attempts[0]!.usage))
      .toEqual(Array(3).fill({ inputTokens: null, outputTokens: null, costUsd: null }));
  });

  it('reconstructs results after filesystem-store restart without a second provider call', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-batch-restart-'));
    try {
      const fetchImpl = vi.fn(async (_url, options) => validResponse(
        JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
      const receiptDirectory = join(directory, 'receipts');
      const resultDirectory = join(directory, 'results');
      const first = await evaluateDecisionRuleset({ ...request(fetchImpl), batchReceipts: durableBatching(
        ...keyedFileStores(receiptDirectory, resultDirectory)) });
      const second = await evaluateDecisionRuleset({ ...request(fetchImpl), batchReceipts: durableBatching(
        ...keyedFileStores(receiptDirectory, resultDirectory)) });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(Object.values(second.spec.evaluations).map(result => result.spec.value))
        .toEqual(Object.values(first.spec.evaluations).map(result => result.spec.value));
      expect(Object.values(second.spec.evaluations).every(result => result.spec.status === 'success')).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never re-dispatches after an erased receipt cascades to its results and reports batch-record-unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-batch-erase-'));
    try {
      const fetchImpl = vi.fn(async (_url, options) => validResponse(
        JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
      const receiptDirectory = join(directory, 'receipts');
      const resultDirectory = join(directory, 'results');
      const [receipts, results] = keyedFileStores(receiptDirectory, resultDirectory);
      const first = await evaluateDecisionRuleset({ ...request(fetchImpl), batchReceipts: durableBatching(receipts, results) });
      const reference = Object.values(first.spec.evaluations)[0]!.spec.batchResult!;
      await receipts.erase(receipts.lifecycleReference(reference.batchId, 'tenant', 'project').opaqueId);
      expect((await readdir(resultDirectory)).filter(name => name.endsWith('.sealed.json'))).toEqual([]);
      expect((await readdir(receiptDirectory)).filter(name => name.endsWith('.sealed.json'))).toEqual([]);
      const replay = await evaluateDecisionRuleset({ ...request(fetchImpl), batchReceipts: durableBatching(
        ...keyedFileStores(receiptDirectory, resultDirectory)) });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(Object.values(replay.spec.evaluations).map(result => [result.spec.status, result.spec.reason]))
        .toEqual(Array(3).fill(['error', 'batch-record-unavailable']));
      expect(replay.apiVersion).toBe('decision.aiwg.io/v1alpha2');
      // The dedicated reason is v1alpha2-only: stripped of v1alpha2 evidence, the same result
      // validates as v1alpha1 only with a released reason.
      const legacy = structuredClone(Object.values(replay.spec.evaluations)[0]!) as unknown as {
        apiVersion: string; spec: Record<string, unknown> & { reason: string; attempts: Array<Record<string, unknown>> } };
      legacy.apiVersion = 'decision.aiwg.io/v1alpha1';
      for (const field of ['batchResult', 'context']) delete legacy.spec[field];
      for (const attempt of legacy.spec.attempts) for (const field of ['batch', 'admission', 'providerPrefix']) delete attempt[field];
      expect(() => validateDecisionDocument(legacy)).toThrow();
      legacy.spec.reason = 'persistence-error';
      legacy.spec.attempts.forEach(attempt => { attempt.reason = 'persistence-error'; });
      expect(() => validateDecisionDocument(legacy)).not.toThrow();
      expect(Object.values(replay.spec.evaluations).every(result => !result.spec.batchResult)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never serves a stale value when a sealed result snapshot is tampered with', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-batch-tamper-'));
    try {
      const fetchImpl = vi.fn(async (_url, options) => validResponse(
        JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
      const receiptDirectory = join(directory, 'receipts');
      const resultDirectory = join(directory, 'results');
      await evaluateDecisionRuleset({ ...request(fetchImpl), batchReceipts: durableBatching(
        ...keyedFileStores(receiptDirectory, resultDirectory)) });
      const target = join(resultDirectory, (await readdir(resultDirectory)).find(name => name.endsWith('.sealed.json'))!);
      const envelope = JSON.parse(await readFile(target, 'utf8')) as { tag: string };
      envelope.tag = Buffer.alloc(16).toString('base64url');
      await writeFile(target, `${canonicalJson(envelope)}\n`);
      const replay = await evaluateDecisionRuleset({ ...request(fetchImpl), batchReceipts: durableBatching(
        ...keyedFileStores(receiptDirectory, resultDirectory)) });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(Object.values(replay.spec.evaluations).map(result => result.spec.reason)).toEqual(Array(3).fill('persistence-error'));
      expect(Object.values(replay.spec.evaluations).every(result => result.spec.value === undefined)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('concurrent acquisition dispatches a durable native batch at most once', async () => {
    const store = new MemoryBatchReceiptStore();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn(async (_url, options) => {
      await blocked;
      return validResponse(JSON.parse(String(options?.body)) as Record<string, unknown>);
    }) as typeof fetch;
    const configured = { ...request(fetchImpl), batchReceipts: durableBatching(store, new MemoryBatchResultStore()) };
    const first = evaluateDecisionRuleset(configured);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const second = evaluateDecisionRuleset(configured);
    release();
    const [owned, replay] = await Promise.all([first, second]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect([owned, replay].some(value => Object.values(value.spec.evaluations).some(item => item.spec.batchResult))).toBe(true);
  });

  it('never commits a completed receipt when value publication fails', async () => {
    const store = new MemoryBatchReceiptStore();
    const resultStore = new MemoryBatchResultStore();
    vi.spyOn(resultStore, 'writeMany').mockRejectedValueOnce(new Error('disk unavailable'));
    const fetchImpl = vi.fn(async (_url, options) => validResponse(
      JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
    const configured = { ...request(fetchImpl), batchReceipts: durableBatching(store, resultStore) };
    const first = await evaluateDecisionRuleset(configured);
    const second = await evaluateDecisionRuleset(configured);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Object.values(first.spec.evaluations).every(result => result.spec.status !== 'success')).toBe(true);
    expect(Object.values(second.spec.evaluations).every(result => !result.spec.batchResult)).toBe(true);
  });

  it('requires a governed result repository before durable batch dispatch', async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    const result = await evaluateDecisionRuleset({ ...request(fetchImpl), batchReceipts: durableBatching() });
    expect(result.spec.reason).toBe('persistence-error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('persists uncertain transport before replay and never redispatches after a crash boundary', async () => {
    const store = new MemoryBatchReceiptStore();
    const fetchImpl = vi.fn(async () => { throw new Error('connection lost after dispatch'); }) as typeof fetch;
    const configured = { ...request(fetchImpl), batchReceipts: durableBatching(store, new MemoryBatchResultStore()) };
    const first = await evaluateDecisionRuleset(configured);
    const second = await evaluateDecisionRuleset(configured);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Object.values(first.spec.evaluations).every(value => value.spec.reason === 'execution-uncertain')).toBe(true);
    expect(second.spec.status).not.toBe('completed');
  });
});

async function candidatesForMatrix() {
  const adapter = new JevDecisionAdapter({ fetch: vi.fn() as unknown as typeof fetch });
  const capabilities = await adapter.capabilities();
  const binding = fixture<DecisionBinding>('binding-jev.json');
  return ['category', 'severity', 'core_unavailable'].map(alias => ({
    alias,
    definition: definitions()[alias]!,
    input: fixture('input.json'),
    target: structuredClone(binding.spec.evaluations[alias]!.targets[0]!),
    adapter: adapter as DecisionAdapter,
    capabilities,
  }));
}
