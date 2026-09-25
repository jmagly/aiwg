import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlOperatorDecisionStore, verifyDecisionChain } from '../../../src/audit/operator-decision.js';
import {
  CanonicalJsonByteEstimator, DECISION_API_VERSION_STRUCTURED, DecisionResultCache, DecisionReviewService,
  FileDecisionReviewStore, JevDecisionAdapter, MemoryBatchReceiptStore, MemoryBatchResultStore,
  MemoryDecisionReceiptStore, MemoryResultCacheStore, RESULT_CACHE_KEY_VERSION, artifactPin, decisionBatchQuestionId,
  digestCachedResult, evaluateDecisionRuleset, extractTraceContext, planDecisionContext, sanitizedTelemetryExport,
  scanTelemetryCanaries, tombstoneOrphanedLinks,
  type AdapterObservation, type DecisionAdapter, type DecisionAdapterRequest, type DecisionBinding,
  type DecisionDefinition, type DecisionEvaluationRequest, type DecisionRuleset, type DecisionTelemetrySpan,
  type DecisionTelemetryTrace, type PrimitiveAcceptancePolicy,
} from '../../../src/decision/index.js';
import { admittedJobItemExecutor } from '../../../src/decision/job-evaluate.js';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { DecisionJobRuntime, recount } from '../../../src/decision/job-runtime.js';
import { MemoryJobStore } from '../../../src/decision/job-store.js';
import { OfflineJobWorker } from '../../../src/decision/job-worker.js';
import { artifactDigest } from '../../../src/decision/validate.js';

/**
 * Executed D14 golden traces. Every scenario runs the real evaluator, job,
 * cache or review runtime against offline fakes and compares a structural
 * projection of the recorded spans with telemetry-golden-v1.json.
 */
const golden = JSON.parse(readFileSync('test/fixtures/decision/telemetry-golden-v1.json', 'utf8')) as {
  schemaVersion: string; scenarios: Array<{ id: string; name: string; expected: Record<string, unknown> }>;
};
const fixture = <T>(name: string): T => JSON.parse(readFileSync(`examples/decision/${name}`, 'utf8')) as T;
const CANARY = 'CANARY-BODY-7731';
const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))));

const definitions = (): Record<string, DecisionDefinition> => ({
  category: fixture('decision-category.json'), severity: fixture('decision-severity.json'),
  core: fixture('decision-core_unavailable.json'),
});
const success = (alias: string): AdapterObservation => ({
  status: 'success', reason: 'none', value: alias === 'category' ? 'documentation' : alias === 'severity' ? 0.25 : 0.05,
  uncertainty: { source: 'provider', profile: alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1',
    calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
  actualModel: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: 'request-internal-9',
});

function ids(seed = '1') {
  let span = 1;
  return { traceId: () => seed.repeat(32), spanId: () => (span++).toString(16).padStart(16, '0') };
}

function adapter(id: string, evaluate: DecisionAdapter['evaluate']): DecisionAdapter {
  return { id, version: '1.0.0', evaluate,
    capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'],
      features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10,
      confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true }) };
}

/** A clock advanced only by adapter work, so live span durations are observable. */
function clock() {
  const state = { value: 1_000 };
  return { now: () => state.value, advance: (ms: number) => { state.value += ms; } };
}

function base(spans: DecisionTelemetrySpan[], adapters: Record<string, DecisionAdapter>, now: () => number): DecisionEvaluationRequest {
  return {
    ruleset: fixture<DecisionRuleset>('ruleset.json'), binding: fixture<DecisionBinding>('binding-jev.json'),
    definitions: definitions(), input: { message: CANARY }, runId: 'run', invocationId: 'golden',
    adapters, resolveCredential: async () => new TextEncoder().encode('fixture-token'), now, random: () => 0.5, delay: async () => undefined,
    telemetry: { hook: { emit: span => { spans.push(span); } }, ids: ids() },
  };
}

/** Structural projection: stable names/status/key attributes, never absolute times or IDs. */
function project(spans: DecisionTelemetrySpan[]) {
  return spans.map(span => {
    const pick = ['aiwg.decision.alias', 'aiwg.decision.reason', 'aiwg.adapter.id', 'aiwg.route.fallback',
      'aiwg.acceptance.disposition', 'aiwg.usage.scope', 'aiwg.validation.outcome', 'aiwg.cache.result']
      .filter(key => span.attributes[key] !== undefined && span.attributes[key] !== null)
      .map(key => `${key.replace(/^aiwg\./, '')}=${String(span.attributes[key])}`);
    return [`${span.name}:${span.status}`, ...pick].join(' ');
  });
}

/** Invariants shared by every executed golden. */
function assertTraceInvariants(spans: DecisionTelemetrySpan[], externalParents: string[] = []): void {
  const byId = new Map(spans.map(span => [span.context.spanId, span]));
  for (const span of spans) {
    expect(span.endTimeUnixMs).toBeGreaterThanOrEqual(span.startTimeUnixMs);
    expect(span.status).not.toBe('unset');
    if (span.parentSpanId === null) continue;
    const parent = byId.get(span.parentSpanId);
    if (!parent) { expect(externalParents).toContain(span.parentSpanId); continue; }
    expect(span.context.traceId).toBe(parent.context.traceId);
    expect(span.startTimeUnixMs).toBeGreaterThanOrEqual(parent.startTimeUnixMs);
    expect(span.endTimeUnixMs).toBeLessThanOrEqual(parent.endTimeUnixMs);
  }
  const serialized = JSON.stringify(spans);
  expect(serialized).not.toContain(CANARY);
  expect(serialized).not.toMatch(/documentation|Bearer|state|prompt/);
  const exported = sanitizedTelemetryExport({ schemaVersion: 'decision-telemetry/v1', traceId: spans[0]!.context.traceId, spans },
    { canaries: [CANARY] });
  expect(scanTelemetryCanaries(exported, [CANARY, 'request-internal-9'])).toEqual([]);
}

function batchContext() {
  const questionIds = ['category', 'severity', 'core_unavailable'].map(decisionBatchQuestionId);
  const estimator = new CanonicalJsonByteEstimator();
  const contextPlan = planDecisionContext({ subject: 'ticket:42', authorizedState: { message: CANARY },
    authorizationDigest: `sha256:${'a'.repeat(64)}`, incompleteContext: false,
    questions: questionIds.map(id => ({ id, subject: 'ticket:42', entry: { question: id } })) },
  { id: 'jev', version: '1', estimator: { id: estimator.id, version: estimator.version },
    limits: { aggregateTokens: 100_000, stateAndLongestQuestionTokens: 100_000 }, safetyMarginBps: 0, requestEnvelopeTokens: 0 }, estimator);
  return { store: new MemoryBatchReceiptStore(), resultStore: new MemoryBatchResultStore(), tenantId: 'tenant', projectId: 'project',
    contextPlan, subjectHash: `sha256:${'b'.repeat(64)}` as const };
}

function jevBatchAnswer(body: Record<string, unknown>): Response {
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(body.questions as Record<string, { type: string }>)) {
    answers[id] = question.type === 'choice'
      ? { type: 'choice', choice: 'documentation', probabilities: { documentation: 1, runtime: 0, other: 0 }, confidence: 1 }
      : question.type === 'score'
        ? { type: 'score', score: 0.25, probabilities: { 0: 0.75, 1: 0.25, 2: 0 },
            legend: { 0: 'Cosmetic or documentation issue; core functions work.', 1: 'A feature fails but has a workaround.', 2: 'Core functions unavailable.' }, confidence: 0.8 }
        : { type: 'noul', noul: 0.05 };
  }
  return new Response(JSON.stringify({ answers, model: 'jev-fixture', usage: { input_tokens: 9, output_tokens: 3 } }),
    { status: 200, headers: { 'x-request-id': 'request-internal-9' } });
}

function structuredRuleset(route: 'act' | 'review') {
  const raw = fixture<DecisionRuleset>('ruleset.json');
  const ruleset: DecisionRuleset = { ...raw, apiVersion: DECISION_API_VERSION_STRUCTURED,
    spec: { ...raw.spec, evaluations: raw.spec.evaluations.filter(item => item.alias === 'category'),
      rules: raw.spec.rules.filter(rule => rule.id === 'docs') } };
  const decision: DecisionDefinition = {
    apiVersion: DECISION_API_VERSION_STRUCTURED, kind: 'DecisionDefinition',
    metadata: { id: ruleset.spec.evaluations[0]!.decision.id, version: '1.0.0', description: 'choice' },
    spec: { purpose: 'fixture', inputSchema: { type: 'object' }, question: 'question', requiredCapabilities: [],
      answer: { kind: 'choice', options: [{ id: 'yes', description: 'yes' }, { id: 'no', description: 'no' }, { id: 'none', description: 'none' }] } },
  } as DecisionDefinition;
  ruleset.spec.evaluations[0]!.decision = artifactPin(decision);
  const bindingRaw = fixture<DecisionBinding>('binding-jev.json');
  const target = bindingRaw.spec.evaluations.category!.targets[0]!;
  const acceptance: PrimitiveAcceptancePolicy = { mode: 'primitive-policy', version: '1.0.0', compatibleUncertaintyProfiles: ['fixture'],
    precedence: 'first-match', calibration: 'advisory', rules: [], defaultRoute: { disposition: route },
    missingEvidenceRoute: { disposition: 'review' }, invalidEvidenceRoute: { disposition: 'reject' }, tieRoute: { disposition: 'review' } };
  target.acceptance = acceptance;
  const binding: DecisionBinding = { ...bindingRaw, apiVersion: DECISION_API_VERSION_STRUCTURED,
    spec: { ...bindingRaw.spec, ruleset: artifactPin(ruleset), evaluations: { category: { targets: [target], fallbackOn: [] } } } };
  const structured = adapter('jev', async () => ({ status: 'success', reason: 'none', value: 'yes', actualModel: 'fixture-1',
    requestId: null, usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
    uncertainty: { source: 'provider', profile: 'fixture', calibration: 'uncalibrated', confidence: 0.8,
      distribution: { yes: 0.7, no: 0.2, none: 0.1 }, calibrationRef: null } }));
  structured.capabilities = async () => ({ answerKinds: ['choice'], features: ['structured-entries'], maxOptions: 255,
    maxLevels: 10, confidenceProfiles: [], executable: true });
  return { ruleset, binding, definitions: { category: decision }, adapter: structured };
}

function cacheSetup(spans: DecisionTelemetrySpan[]) {
  const sha = (c: string) => `sha256:${c.repeat(64)}` as const;
  const ruleset = fixture<DecisionRuleset>('ruleset.json');
  ruleset.spec.evaluations = ruleset.spec.evaluations.filter(value => value.alias === 'category');
  ruleset.spec.rules = ruleset.spec.rules.filter(value => value.id === 'docs');
  const binding = fixture<DecisionBinding>('binding-jev.json');
  binding.spec.ruleset = artifactPin(ruleset);
  binding.spec.evaluations = { category: binding.spec.evaluations.category! };
  const evaluate = vi.fn(async () => success('category'));
  const actor = { tenantId: 'tenant', projectId: 'project', workspaceId: 'workspace', subjectId: 'caller',
    permissions: ['read', 'write'] as Array<'read' | 'write'> };
  const policy = { enabled: true, sideEffectFree: true, policyVersion: 'cache-policy-v1', ttlMs: 10_000,
    scope: 'workspace' as const, sensitivity: 'internal' as const };
  const identityFor: NonNullable<DecisionEvaluationRequest['resultCache']>['identityFor'] = ({ definition, target, projectedInput }) => ({
    keyVersion: RESULT_CACHE_KEY_VERSION, definition: artifactPin(definition), ruleset: artifactPin(ruleset), binding: artifactPin(binding),
    adapter: { id: target.adapter, version: target.adapterVersion }, promptDigest: sha('a'),
    acceptancePolicyDigest: digestCachedResult(target.acceptance), calibrationDigest: sha('b'), runtimePolicyDigest: sha('c'),
    backend: 'fixture', requestedModel: target.model, modelCompatibility: { mode: 'pinned', actualModel: target.model },
    primitive: definition.spec.answer.kind, projectedInput, subjectIdentityDigest: sha('d'), projectionPolicyDigest: sha('e'),
    egressPolicyDigest: sha('f'), capabilityMode: 'choice',
  });
  const request: DecisionEvaluationRequest = { ruleset, binding, definitions: { category: fixture<DecisionDefinition>('decision-category.json') },
    input: { message: CANARY }, runId: 'run', invocationId: 'source', receiptStore: new MemoryDecisionReceiptStore(),
    receiptProjectId: 'project', adapters: { jev: adapter('jev', async () => { const value = await evaluate(); return { ...value, actualModel: 'jev-latest' }; }) },
    resolveCredential: async () => new Uint8Array([1]),
    policyPin: { id: 'policy', version: '1', digest: sha('c') }, calibrationPin: { id: 'calibration', version: '1', digest: sha('b') },
    resultCache: { service: new DecisionResultCache(new MemoryResultCacheStore()), actor, policy, identityFor,
      recordCallerReceipt: async () => undefined },
    telemetry: { hook: { emit: span => { spans.push(span); } }, ids: ids('2') } };
  return { request, evaluate };
}

function jobSetup() {
  const ruleset = fixture<DecisionRuleset>('ruleset.json');
  const binding = fixture<DecisionBinding>('binding-jev.json');
  const defs = definitions();
  const input = { message: CANARY };
  const digest = artifactDigest(input);
  const scope = { tenantId: 't', projectId: 'p', workspaceId: 'workspace', principalId: 'principal' };
  const job: DecisionJob = { schemaVersion: 'decision-job/v1', id: 'job-golden', scope, fingerprint: digest, state: 'validating',
    items: [{ id: 'subject', fingerprint: digest, subjectDigest: digest, bindingDigest: artifactDigest(binding),
      definitionDigest: artifactDigest(defs), rulesetDigest: artifactDigest(ruleset), state: 'queued', attempts: [] }],
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'],
    createdAtEpochMs: 10, expiresAtEpochMs: 100_000_000_000_000,
    budget: { maxAttempts: 3, maxTokens: 10_000, maxCostMicros: 1_000_000, maxConcurrency: 1 } };
  recount(job);
  const limits = { concurrency: 2, maxAttempts: 3, allowUnknownCost: false, maxCostUsd: 1, maxQueueLength: 5 };
  return { ruleset, binding, defs, input, scope, job, limits };
}

type Observe = () => Promise<Record<string, unknown>>;
const scenarios: Record<string, Observe> = {
  async 'OBS-001'() {
    const spans: DecisionTelemetrySpan[] = []; const time = clock(); const seen: DecisionAdapterRequest[] = [];
    const result = await evaluateDecisionRuleset(base(spans, { jev: adapter('jev', async request => {
      seen.push(request); time.advance(10); return success(request.alias);
    }) }, time.now));
    assertTraceInvariants(spans);
    const attempts = spans.filter(span => span.name === 'decision.attempt');
    return { status: result.spec.status, spans: project(spans),
      attemptDurationsMs: attempts.map(span => span.endTimeUnixMs - span.startTimeUnixMs),
      adapterReceivedOwnAttemptSpan: seen.every((request, index) =>
        extractTraceContext({ traceparent: request.traceContext?.traceparent })?.spanId === attempts[index]?.context.spanId),
      tracestateForwarded: seen.some(request => JSON.stringify(request.traceContext).includes('tracestate')) };
  },

  async 'OBS-002'() {
    const spans: DecisionTelemetrySpan[] = []; const headers: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      headers.push(init!.headers as Record<string, string>);
      return jevBatchAnswer(JSON.parse(String(init!.body)) as Record<string, unknown>);
    }) as unknown as typeof fetch;
    const batchReceipts = batchContext();
    const request: DecisionEvaluationRequest = { ...base(spans, { jev: new JevDecisionAdapter({ fetch: fetchImpl }) }, Date.now),
      now: undefined, invocationId: 'golden-batch', batchReceipts,
      batching: { enabled: true, evaluations: Object.fromEntries(['category', 'severity', 'core_unavailable'].map(alias => [alias,
        { decisionSubject: 'ticket:42', independent: true, egressPolicy: 'jev-public-v1', hostPolicy: 'host-policy-v1' }])) } };
    const result = await evaluateDecisionRuleset(request);
    assertTraceInvariants(spans);
    const root = spans[0]!; const batch = spans.filter(span => span.name === 'decision.batch.request');
    const answers = spans.filter(span => span.name === 'decision.attempt');
    const receipt = (await batchReceipts.store.read(result.spec.evaluations.category!.spec.batchResult!.batchId, 'tenant', 'project'))!;
    // Replay of the same invocation dispatches nothing and links back through the durable receipt.
    const replaySpans: DecisionTelemetrySpan[] = [];
    await evaluateDecisionRuleset({ ...request, telemetry: { hook: { emit: span => { replaySpans.push(span); } }, ids: ids('3') } });
    return { status: result.spec.status, spans: project(spans), transportCalls: fetchImpl.mock.calls.length,
      sharedUsage: batch.map(span => [span.attributes['gen_ai.usage.input_tokens'], span.attributes['gen_ai.usage.output_tokens'],
        span.attributes['aiwg.usage.scope'], span.provenance['gen_ai.usage.input_tokens']]),
      answersLinkedToRequest: answers.every(span => span.links.some(link => link.relationship === 'batch'
        && link.spanId === batch[0]!.context.spanId)),
      answersCarryUsage: answers.some(span => Object.keys(span.attributes).some(key => key.startsWith('gen_ai.usage'))),
      transportTraceparentIsRequestSpan: extractTraceContext({ traceparent: headers[0]!.traceparent })?.spanId === batch[0]!.context.spanId,
      transportTracestate: Object.hasOwn(headers[0]!, 'tracestate'),
      receiptTraceparentIsWorkflow: extractTraceContext({ traceparent: receipt.traceParent })?.spanId === root.context.spanId,
      replay: { spans: project(replaySpans), transportCalls: fetchImpl.mock.calls.length,
        linkedToOriginalWorkflow: replaySpans[0]!.links.some(link => link.relationship === 'batch'
          && link.traceId === root.context.traceId && link.spanId === root.context.spanId) } };
  },

  async 'OBS-003'() {
    const spans: DecisionTelemetrySpan[] = []; const time = clock(); let calls = 0;
    const request = base(spans, { jev: adapter('jev', async input => {
      calls += 1; time.advance(10);
      if (input.alias === 'category' && calls === 1) return { ...success(input.alias), status: 'error', reason: 'network-transient', value: null };
      return success(input.alias);
    }) }, time.now);
    request.binding.spec.maxAttempts = 4;
    request.binding.spec.evaluations.category!.targets[0]!.retry.maxRetries = 1;
    request.delay = async ms => { time.advance(ms); };
    const result = await evaluateDecisionRuleset(request);
    assertTraceInvariants(spans);
    const [first, second] = spans.filter(span => span.attributes['aiwg.decision.alias'] === 'category' && span.name === 'decision.attempt');
    return { status: result.spec.status, spans: project(spans),
      retryEvents: spans.flatMap(span => span.events).filter(event => event.name === 'retry.scheduled').length,
      retryStartsAfterBackoff: second!.startTimeUnixMs >= first!.endTimeUnixMs + Number(first!.attributes['aiwg.retry.delay_ms']) };
  },

  async 'OBS-004'() {
    const spans: DecisionTelemetrySpan[] = []; const time = clock();
    // A different backend, not a second target on the same adapter.
    const request = { ...base(spans, {
      jev: adapter('jev', async input => { time.advance(10);
        return input.alias === 'category' ? { ...success(input.alias), status: 'error', reason: 'service-error', value: null } : success(input.alias); }),
      'llm-subagent': adapter('llm-subagent', async input => { time.advance(10); return success(input.alias); }),
    }, time.now), binding: fixture<DecisionBinding>('binding-fallback.json') };
    const result = await evaluateDecisionRuleset(request);
    assertTraceInvariants(spans);
    return { status: result.spec.status, spans: project(spans) };
  },

  async 'OBS-005'() {
    const spans: DecisionTelemetrySpan[] = [];
    const result = await evaluateDecisionRuleset(base(spans, { jev: adapter('jev', async input =>
      input.alias === 'category' ? { ...success(input.alias), value: 'not-an-option' } : success(input.alias)) }, () => 1_000));
    assertTraceInvariants(spans);
    return { status: result.spec.status, reason: result.spec.reason, spans: project(spans) };
  },

  async 'OBS-006'() {
    const spans: DecisionTelemetrySpan[] = []; const controller = new AbortController();
    const request = base(spans, { jev: adapter('jev', async input => { controller.abort(); return success(input.alias); }) }, () => 1_000);
    request.signal = controller.signal;
    const result = await evaluateDecisionRuleset(request);
    assertTraceInvariants(spans);
    return { status: result.spec.status, spans: project(spans),
      terminations: spans.flatMap(span => span.events).filter(event => event.name === 'attempt.terminated')
        .map(event => event.attributes['aiwg.attempt.termination']) };
  },

  async 'OBS-007'() {
    const spans: DecisionTelemetrySpan[] = []; const time = clock();
    const request = base(spans, { jev: adapter('jev', async () => { time.advance(10); throw new Error('connection reset after write'); }) }, time.now);
    request.receiptStore = new MemoryDecisionReceiptStore();
    const result = await evaluateDecisionRuleset(request);
    assertTraceInvariants(spans);
    return { status: result.spec.status, reason: result.spec.reason, spans: project(spans),
      receiptState: (await request.receiptStore.read('golden', 'default'))?.state };
  },

  async 'OBS-008'() {
    const spans: DecisionTelemetrySpan[] = []; const structured = structuredRuleset('review');
    const result = await evaluateDecisionRuleset({ ...base(spans, { jev: structured.adapter }, () => 1_000),
      ruleset: structured.ruleset, binding: structured.binding, definitions: structured.definitions });
    assertTraceInvariants(spans);
    return { status: result.spec.status, spans: project(spans) };
  },

  async 'OBS-009'() {
    const spans: DecisionTelemetrySpan[] = []; const { request, evaluate } = cacheSetup(spans);
    await evaluateDecisionRuleset(request);
    const fill = project(spans); spans.length = 0;
    const hit = await evaluateDecisionRuleset({ ...request, invocationId: 'caller' });
    assertTraceInvariants(spans);
    return { disposition: hit.spec.cache?.disposition, fill, spans: project(spans), providerCalls: evaluate.mock.calls.length,
      rootInvocation: spans[0]!.attributes['aiwg.invocation.id'],
      replayedUsage: spans.some(span => Object.keys(span.attributes).some(key => key.startsWith('gen_ai.usage'))) };
  },

  async 'OBS-010'() {
    const jobSpans: DecisionTelemetrySpan[] = []; const spans: DecisionTelemetrySpan[] = [];
    const setup = jobSetup();
    const runtime = new DecisionJobRuntime(new MemoryJobStore(), () => 20, { emit: span => { jobSpans.push(span); } });
    const first = await runtime.submit(setup.job, setup.scope);
    const queued = structuredClone(first.job); queued.state = 'queued';
    await runtime.advance(setup.scope, setup.job.id, first, queued);
    let dispatch: DecisionTelemetrySpan | undefined;
    const executor = admittedJobItemExecutor(setup.job, (item, signal) => {
      // The host continues the async item under the job span that fenced its dispatch.
      dispatch = jobSpans.at(-1);
      return { ruleset: setup.ruleset, binding: setup.binding, definitions: setup.defs, input: setup.input, runId: 'run',
        invocationId: item.attempts.at(-1)!.id, adapters: { jev: adapter('jev', async input => ({ ...success(input.alias),
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } })) },
        resolveCredential: async () => new Uint8Array([1]), receiptStore: new MemoryDecisionReceiptStore(),
        receiptProjectId: setup.scope.projectId, signal,
        scheduler: { enabled: true, profileVersion: 'fixture', workspace: { id: setup.scope.workspaceId, limits: setup.limits },
          principal: { id: setup.scope.principalId, limits: setup.limits }, providers: { jev: setup.limits },
          estimate: () => ({ tokens: 3, costUsd: 0.001, attempts: 1 }) },
        telemetry: { hook: { emit: span => { spans.push(span); } }, ids: ids('4'), parent: dispatch!.context } };
    });
    const finished = await new OfflineJobWorker(runtime).run(setup.scope, setup.job.id, 'subject', executor, { tokens: 10, costMicros: 10_000 });
    assertTraceInvariants(spans, [dispatch!.context.spanId]);
    return { itemState: finished.job.items[0]!.state,
      jobOperations: jobSpans.map(span => `${span.attributes['aiwg.job.operation']}:${span.attributes['aiwg.job.status']}`),
      spans: project(spans), workflowParentIsJobDispatch: spans[0]!.parentSpanId === dispatch!.context.spanId
        && spans[0]!.context.traceId === dispatch!.context.traceId };
  },

  async 'OBS-011'() {
    const directory = await mkdtemp(join(tmpdir(), 'aiwg-telemetry-golden-')); directories.push(directory);
    // Continue from the policy-review workflow so the review chain shares its W3C trace.
    const workflowSpans: DecisionTelemetrySpan[] = []; const structured = structuredRuleset('review');
    await evaluateDecisionRuleset({ ...base(workflowSpans, { jev: structured.adapter }, () => 1_000),
      ruleset: structured.ruleset, binding: structured.binding, definitions: structured.definitions });
    const reviewSpan = workflowSpans.find(span => span.name === 'decision.review')!;
    const spans: DecisionTelemetrySpan[] = [];
    const audit = new JsonlOperatorDecisionStore(join(directory, 'audit.jsonl'));
    const authorization = { authorize: () => true, eligible: () => true, eligibleApproval: () => true, authorizeAction: () => true };
    const service = new DecisionReviewService(new FileDecisionReviewStore(join(directory, 'reviews'), new Uint8Array(32).fill(3)),
      authorization, () => 1_000, {
        operatorAudit: { store: audit, correlation: () => ({ flow_id: 'flow-golden' }), classification: 'internal' },
        telemetry: { hook: { emit: span => { spans.push(span); } }, ids: ids('5'), parent: reviewSpan.context } });
    const scope = (id: string) => ({ tenantId: 'tenant', projectId: 'project', actor: { id, roles: ['reviewer'], authorityContext: 'policy/v1' } });
    const create = (reviewId: string) => service.create(scope('requester'), { reviewId, sourceReceipt: { id: 'receipt', digest: `sha256:${'a'.repeat(64)}` },
      evidencePins: [], policyPins: [], reasonCodes: ['policy-review'], riskTier: 'medium', presentation: {},
      action: { kind: 'notify' }, rationale: 'review', expiresAtEpochMs: 2_000, continuationId: `continue-${reviewId}`, resumeToken: 'resume' });
    await create('review-approve'); await create('review-deny'); await create('review-escalate');
    await service.decide(scope('reviewer'), 'review-approve', 'approve', 'approved');
    await service.decide(scope('reviewer'), 'review-deny', 'reject', 'denied');
    await service.escalate(scope('reviewer'), 'review-escalate', 'needs owner');
    await service.resume(scope('reviewer'), 'review-approve', 'resume', async () => ({ delivered: true }));
    assertTraceInvariants(spans, [reviewSpan.context.spanId]);
    const records = await audit.read();
    const operatorSpans = spans.filter(span => span.attributes['aiwg.operator_decision.event_id'] !== undefined);
    const action = spans.find(span => span.name === 'decision.action')!;
    return { spans: project(spans).map((line, index) => `${line} review=${String(spans[index]!.attributes['aiwg.review.event'] ?? '-')}`),
      auditChainValid: verifyDecisionChain(records).ok, auditOutcomes: records.map(record => record.outcome),
      everyAuditRecordHasOneSpan: records.every(record => operatorSpans.filter(span =>
        span.name === 'decision.review' && span.attributes['aiwg.operator_decision.event_id'] === record.event_id).length === 1),
      auditTraceIsOtelTrace: records.every(record => record.correlation.trace_id === reviewSpan.context.traceId)
        && spans.every(span => span.context.traceId === reviewSpan.context.traceId),
      actionCitesApprovalEvent: action.attributes['aiwg.operator_decision.event_id'] === records.find(record => record.outcome === 'approved')?.event_id,
      actionLinkedToReview: action.links.some(link => link.relationship === 'review' && link.spanId === action.parentSpanId) };
  },

  async 'PRV-001'() {
    const spans: DecisionTelemetrySpan[] = [];
    await evaluateDecisionRuleset(base(spans, { jev: adapter('jev', async input => success(input.alias)) }, () => 1_000));
    spans[0]!.context.traceState = `vendor=${CANARY}`;
    spans[1]!.events.push({ name: 'debug.dump', timeUnixMs: 1, attributes: { 'aiwg.decision.reason': CANARY } });
    const trace: DecisionTelemetryTrace = { schemaVersion: 'decision-telemetry/v1', traceId: spans[0]!.context.traceId, spans };
    const internalRequestIds = spans.filter(span => span.attributes['aiwg.provider.request_id'] !== undefined).length;
    const exported = sanitizedTelemetryExport(trace, { canaries: [CANARY] });
    return { internalSpansWithRequestId: internalRequestIds,
      exportedSpans: exported.spans.length, leaked: scanTelemetryCanaries(exported, [CANARY, 'request-internal-9']),
      exportedTracestate: exported.spans.some(span => span.context.traceState !== undefined),
      exportedUnknownEvents: exported.spans.some(span => span.events.some(event => event.name === 'debug.dump')) };
  },

  async 'PRV-002'() {
    const spans: DecisionTelemetrySpan[] = [];
    await evaluateDecisionRuleset(base(spans, { jev: adapter('jev', async input => success(input.alias)) }, () => 1_000));
    const trace: DecisionTelemetryTrace = { schemaVersion: 'decision-telemetry/v1', traceId: spans[0]!.context.traceId, spans };
    // One link survives, one points at an expired review trace, one is an internal link.
    trace.spans[0]!.links.push(
      { traceId: '6'.repeat(32), spanId: '6'.repeat(16), relationship: 'review' },
      { traceId: '7'.repeat(32), spanId: '7'.repeat(16), relationship: 'continuation' },
      { traceId: trace.traceId, spanId: spans[1]!.context.spanId, relationship: 'evaluation' });
    const live = new Set([`${'7'.repeat(32)}:${'7'.repeat(16)}`]);
    const reconciled = tombstoneOrphanedLinks(trace, link => live.has(`${link.traceId}:${link.spanId}`), 5_000);
    const again = tombstoneOrphanedLinks(reconciled, () => false, 6_000);
    return { links: reconciled.spans[0]!.links.map(link => `${link.relationship}:${String(link.attributes?.['aiwg.link.state'] ?? 'live')}`),
      tombstones: reconciled.tombstones?.map(tombstone => `${tombstone.referenceType}:${tombstone.reason}`),
      idempotent: JSON.stringify(again.spans[0]!.links) === JSON.stringify(reconciled.spans[0]!.links.map(link =>
        link.relationship === 'continuation' ? { ...link, attributes: { 'aiwg.link.state': 'orphaned',
          'aiwg.link.tombstone': `${link.traceId}:${link.spanId}` } } : link)),
      exportKeepsTombstone: sanitizedTelemetryExport(reconciled).spans[0]!.links[0]!.attributes?.['aiwg.link.state'] };
  },
};

describe('decision telemetry executed golden traces', () => {
  it('executes every required golden scenario', () => {
    expect(golden.schemaVersion).toBe('decision-telemetry/v1');
    expect(golden.scenarios.map(scenario => scenario.id)).toEqual(Object.keys(scenarios));
    expect(golden.scenarios.map(scenario => scenario.name)).toEqual([
      'single-success', 'heterogeneous-batch', 'retry-then-success', 'backend-fallback', 'invalid-output',
      'caller-cancellation', 'execution-uncertainty', 'policy-review', 'cache-hit', 'async-item',
      'approved-action-link', 'sanitized-incident-export', 'orphaned-links',
    ]);
  });

  it('links the telemetry, egress, credential and incident-evidence runbooks from the closure manifest', () => {
    const doc = readFileSync('docs/decision/telemetry.md', 'utf8');
    const runbooks = readFileSync('docs/decision/operations/README.md', 'utf8');
    const manifest = JSON.parse(readFileSync('docs/decision/operations/closure-manifest.v1.json', 'utf8')) as { runbooks: string[] };
    expect(doc).toContain('](operations/README.md)');
    for (const id of ['RUN-JEV-TELEMETRY-v1', 'RUN-JEV-EGRESS-v1', 'RUN-JEV-CREDENTIAL-v1', 'RUN-JEV-INCIDENT-EVIDENCE-v1']) {
      expect(doc).toContain(`\`${id}\``);
      expect(runbooks).toContain(`| \`${id}\` |`);
      expect(manifest.runbooks).toContain(id);
    }
  });

  it('stores the workflow traceparent in the invocation receipt and links a replay back to it', async () => {
    const spans: DecisionTelemetrySpan[] = []; const receiptStore = new MemoryDecisionReceiptStore();
    const evaluate = vi.fn(async (input: DecisionAdapterRequest) => success(input.alias));
    const request = { ...base(spans, { jev: adapter('jev', evaluate) }, () => 1_000), receiptStore };
    const original = await evaluateDecisionRuleset(request);
    const root = spans[0]!;
    const receipt = (await receiptStore.read('golden', 'default'))!;
    expect(extractTraceContext({ traceparent: receipt.traceParent })).toMatchObject({
      traceId: root.context.traceId, spanId: root.context.spanId });
    const replaySpans: DecisionTelemetrySpan[] = [];
    const replay = await evaluateDecisionRuleset({ ...request, telemetry: { hook: { emit: span => { replaySpans.push(span); } }, ids: ids('8') } });
    expect(replay).toEqual(original);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(replaySpans[0]!.context.traceId).not.toBe(root.context.traceId);
    expect(replaySpans[0]!.links).toEqual([{ traceId: root.context.traceId, spanId: root.context.spanId, relationship: 'continuation' }]);
    expect(replaySpans.some(span => span.name === 'decision.attempt')).toBe(false);
    assertTraceInvariants(replaySpans);
  });

  for (const scenario of golden.scenarios) {
    it(`${scenario.id} ${scenario.name}`, async () => {
      const observed = await scenarios[scenario.id]!();
      if (process.env.AIWG_PRINT_TELEMETRY_GOLDEN) console.log(JSON.stringify({ id: scenario.id, observed }));
      expect(observed).toEqual(scenario.expected);
    });
  }
});
