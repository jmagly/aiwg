import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  evaluateDecisionRuleset,
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
  batchAccountingTotals,
  decisionBatchQuestionId,
  planDecisionContext,
  planNativeDecisionBatches,
} from '../../../src/decision/index.js';

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

function durableBatching(store = new MemoryBatchReceiptStore(), resultStore?: MemoryBatchResultStore) {
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

  it('REC-BATCH runtime owns shared accounting once and emits reference-only result links', async () => {
    const store = new MemoryBatchReceiptStore();
    const fetchImpl = vi.fn(async (_url, options) => validResponse(
      JSON.parse(String(options?.body)) as Record<string, unknown>)) as typeof fetch;
    const result = await evaluateDecisionRuleset({ ...request(fetchImpl), batchReceipts: durableBatching(store) });
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
    expect(Object.values(second.spec.evaluations).every(result => result.spec.batchResult)).toBe(true);
    expect(Object.values(second.spec.evaluations).map(value => value.spec.attempts[0]!.usage))
      .toEqual(Array(3).fill({ inputTokens: null, outputTokens: null, costUsd: null }));
  });

  it('concurrent acquisition dispatches a durable native batch at most once', async () => {
    const store = new MemoryBatchReceiptStore();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn(async (_url, options) => {
      await blocked;
      return validResponse(JSON.parse(String(options?.body)) as Record<string, unknown>);
    }) as typeof fetch;
    const configured = { ...request(fetchImpl), batchReceipts: durableBatching(store) };
    const first = evaluateDecisionRuleset(configured);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const second = evaluateDecisionRuleset(configured);
    release();
    const [owned, replay] = await Promise.all([first, second]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect([owned, replay].some(value => Object.values(value.spec.evaluations).some(item => item.spec.batchResult))).toBe(true);
  });

  it('persists uncertain transport before replay and never redispatches after a crash boundary', async () => {
    const store = new MemoryBatchReceiptStore();
    const fetchImpl = vi.fn(async () => { throw new Error('connection lost after dispatch'); }) as typeof fetch;
    const configured = { ...request(fetchImpl), batchReceipts: durableBatching(store) };
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
