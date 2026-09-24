import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  applyPrimitiveAcceptance, artifactPin, assertContextQualified, compareContextUsage, DecisionAdmissionController,
  evaluateDecisionRuleset, JevDecisionAdapter, measureCategoricalDrift, measureLabelStability, planDecisionContext,
  runBoundedFair, type AdapterObservation, type ContextComparison, type ContextProviderProfile, type ContextTokenEstimator,
  type DecisionAdapterRequest, type DecisionAdmissionLimits, type DecisionBinding, type DecisionDefinition,
  type DecisionEvaluationRequest, type DecisionRuleset, type PrimitiveAcceptancePolicy, type QualificationCaseExecutor,
  type RulesetResult,
} from '../../../../src/decision/index.js';

export const VENDOR_CATALOG = 'test/fixtures/decision/vendor-vectors-v1.json';
export const CASE_IDS = ['TV02', 'TV06', 'TV07', 'TV09', 'TV12', 'TV13', 'TV14', 'TV15', 'TV16', 'TV17', 'TV18',
  'TV19', 'TV20', 'TV21', 'TV23', 'TV24', 'TV25'] as const;
type CaseId = (typeof CASE_IDS)[number];

/** Named master-test-plan evidence proven by each vendor executor. */
export const EVIDENCE_IDS: Readonly<Partial<Record<CaseId, readonly string[]>>> = {
  TV02: ['BCH-INVALID-ANSWER-01'],
  TV12: ['CTX-64K-01', 'CTX-32K-01', 'CTX-QUALIFY-01'],
  TV13: ['RTY-STATUS-01'],
  TV14: ['RTY-HEADER-01'],
  TV15: ['RTY-DEADLINE-01'],
  TV16: ['CAN-CALLER-01', 'CAN-DISPATCHED-01'],
  TV17: ['CNC-ORDER-01', 'CNC-FAIR-01', 'CNC-QUEUE-01', 'CNC-CANCEL-01', 'CNC-RETRY-OWNER-01'],
  TV19: ['SEC-REQUEST-ID-01'],
  TV20: ['DRF-OUTPUT-01', 'DRF-POPULATION-01', 'DRF-LABEL-01', 'DRF-INSUFFICIENT-01'],
  TV21: ['SEC-EGRESS-01'],
  TV24: ['SEC-RESPONSE-01'],
  TV25: ['SEC-ADV-OVERRIDE-01', 'SEC-ADV-AUTHORITY-01', 'SEC-ADV-DELIMITER-01', 'SEC-ADV-FAKE-SYSTEM-01'],
};

export interface VendorVector {
  id: string; title: string; basis: string; assumption: string; suite: string;
  recorded?: Record<string, any>; expected: Record<string, any>;
}
let catalog: Promise<VendorVector[]> | undefined;
export const vendorCatalog = (): Promise<VendorVector[]> => (catalog ??= readFile(VENDOR_CATALOG, 'utf8')
  .then(text => (JSON.parse(text) as { vectors: VendorVector[] }).vectors));
const vector = async (id: CaseId): Promise<VendorVector> => (await vendorCatalog()).find(item => item.id === id)!;

const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(`examples/decision/${name}`, 'utf8')) as T;
async function workload() {
  return { ruleset: await fixture<DecisionRuleset>('ruleset.json'), binding: await fixture<DecisionBinding>('binding-jev.json'),
    definitions: { category: await fixture<DecisionDefinition>('decision-category.json'),
      severity: await fixture<DecisionDefinition>('decision-severity.json'),
      core: await fixture<DecisionDefinition>('decision-core_unavailable.json') } as Record<string, DecisionDefinition>,
    input: await fixture<{ message: string }>('input.json') };
}
type Workload = Awaited<ReturnType<typeof workload>>;
/** Re-pins the ruleset and binding after a definition changes, as a host would after authoring. */
function repin(work: Workload): Workload {
  const byId = new Map(Object.values(work.definitions).map(definition => [definition.metadata.id, definition]));
  work.ruleset.spec.evaluations = work.ruleset.spec.evaluations.map(item => ({ ...item, decision: artifactPin(byId.get(item.decision.id)!) }));
  work.binding.spec.ruleset = artifactPin(work.ruleset);
  return work;
}

/** Answers every requested question the way the recorded fake transport does. */
function answer(question: { type: string; criteria: unknown }): Record<string, unknown> {
  if (question.type === 'choice') {
    const ids = Object.keys(question.criteria as Record<string, string>);
    const chosen = ids.includes('documentation') ? 'documentation' : ids[0]!;
    return { type: 'choice', choice: chosen, confidence: 0.9,
      probabilities: Object.fromEntries(ids.map(id => [id, id === chosen ? 1 : 0])) };
  }
  if (question.type === 'score') {
    const levels = question.criteria as unknown[];
    return { type: 'score', score: 0, confidence: 0.8,
      probabilities: Object.fromEntries(levels.map((_, index) => [index, index === 0 ? 1 : 0])),
      legend: Object.fromEntries(levels.map((level, index) => [index, level])) };
  }
  return { type: 'noul', noul: 0.05 };
}
interface Recorder { calls: number; credentials: number; bodies: Record<string, any>[]; inits: RequestInit[] }
function transport(respond?: (body: Record<string, any>, recorder: Recorder) => Response | Promise<Response>) {
  const recorder: Recorder = { calls: 0, credentials: 0, bodies: [], inits: [] };
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    recorder.calls += 1;
    recorder.inits.push(init!);
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    recorder.bodies.push(body);
    if (respond) return respond(body, recorder);
    return new Response(JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 5, output_tokens: 1 },
      answers: Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([id, question]) => [id, answer(question)])) }));
  }) as typeof fetch;
  const resolveCredential = async () => { recorder.credentials += 1; return new TextEncoder().encode('synthetic-credential'); };
  return { recorder, fetchImpl, resolveCredential };
}
async function evaluate(work: Workload, fake: ReturnType<typeof transport>, invocationId: string,
  overrides: Partial<DecisionEvaluationRequest> = {}, adapter?: JevDecisionAdapter): Promise<RulesetResult> {
  return evaluateDecisionRuleset({ ...work, runId: 'vendor-vectors', invocationId,
    adapters: { jev: adapter ?? new JevDecisionAdapter({ fetch: fake.fetchImpl }) },
    resolveCredential: fake.resolveCredential, delay: async () => undefined, random: () => 0.5, ...overrides });
}
const sameSubject = (subject: (alias: string) => string) => ({ enabled: true, evaluations: Object.fromEntries(
  ['category', 'severity', 'core_unavailable'].map(alias => [alias,
    { decisionSubject: subject(alias), independent: true, egressPolicy: 'jev-public-v1', hostPolicy: 'host-policy-v1' }])) });

async function adapterRequest(overrides: Partial<DecisionAdapterRequest> = {}): Promise<DecisionAdapterRequest> {
  const work = await workload();
  return { alias: 'category', definition: work.definitions.category!, input: work.input,
    target: work.binding.spec.evaluations.category!.targets[0]!, invocationId: 'vendor-adapter',
    deadlineEpochMs: Date.now() + 10_000, signal: new AbortController().signal,
    resolveCredential: async () => new TextEncoder().encode('synthetic-credential'), ...overrides };
}
const statusResponse = (status: number, headers: Record<string, string> = {}, body = '{}') =>
  new Response(body, { status, headers });

const route = (disposition: 'act' | 'review' | 'reject') => ({ disposition } as const);
const policy = (overrides: Partial<PrimitiveAcceptancePolicy> = {}): PrimitiveAcceptancePolicy => ({
  mode: 'primitive-policy', version: '1.0.0', compatibleUncertaintyProfiles: ['typesafe-distribution-v1'],
  precedence: 'first-match', calibration: 'advisory', rules: [], defaultRoute: route('act'),
  missingEvidenceRoute: route('review'), invalidEvidenceRoute: route('reject'), tieRoute: route('review'), ...overrides,
});

export const executors: Record<CaseId, QualificationCaseExecutor> = {
  TV02: async () => {
    const { recorded, expected } = await vector('TV02');
    for (const mutation of recorded!.mutations as string[]) {
      const fake = transport(body => {
        const ids = Object.keys(body.questions);
        const answers: Record<string, unknown> = Object.fromEntries(ids.map(id => [id, answer(body.questions[id])]));
        if (mutation === 'missing-answer') delete answers[ids[0]!];
        if (mutation === 'extra-answer') answers.q_unrequested = answers[ids[0]!];
        let text = JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 5, output_tokens: 1 }, answers });
        if (mutation === 'duplicate-answer') {
          text = text.replace('"answers":{', `"answers":{${JSON.stringify(ids[0])}:${JSON.stringify(answers[ids[0]!])},`);
        }
        return new Response(text);
      });
      const result = await evaluate(await workload(), fake, `tv02-${mutation}`, { batching: sameSubject(() => 'ticket:42') });
      assert.equal(fake.recorder.calls, expected.providerCalls, mutation);
      for (const [alias, evaluation] of Object.entries(result.spec.evaluations)) {
        assert.equal(evaluation.spec.status, expected.status, `${mutation}:${alias}`);
        assert.equal(evaluation.spec.reason, expected.reason, `${mutation}:${alias}`);
        assert.equal(evaluation.spec.value, undefined, `${mutation}:${alias}`);
      }
    }
    return { outcome: 'pass' };
  },
  TV06: async () => {
    const { recorded, expected } = await vector('TV06');
    const withOptions = async (count: number) => {
      const work = await workload();
      const answerSpec = work.definitions.category!.spec.answer as { kind: 'choice'; options: Array<{ id: string; description: string }> };
      answerSpec.options = [...answerSpec.options, ...Array.from({ length: count - answerSpec.options.length },
        (_, index) => ({ id: `option-${index + 4}`, description: `Synthetic option ${index + 4}.` }))];
      const fake = transport();
      const result = await evaluate(repin(work), fake, `tv06-${count}`);
      const categoryCalls = fake.recorder.bodies.filter(body => 'category' in body.questions).length;
      return { result, categoryCalls, fake };
    };
    const within = await withOptions(recorded!.maxOptions);
    assert.equal(within.result.spec.evaluations.category!.spec.status, 'success');
    assert.equal(within.categoryCalls, expected.withinLimitCalls);
    // The definition contract caps Choice at 255 options, so the whole invocation stops before any credential or call.
    const over = await withOptions(recorded!.maxOptions + 1);
    assert.equal(over.result.spec.reason, expected.overLimitReason);
    assert.equal(over.fake.recorder.calls, expected.overLimitCalls);
    assert.equal(over.fake.recorder.credentials, expected.overLimitCredentials);
    const work = await workload();
    const tied: AdapterObservation = { status: 'success', reason: 'none', value: 'documentation', actualModel: 'jev-fixture',
      requestId: null, usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
      uncertainty: { source: 'provider', profile: 'typesafe-distribution-v1', calibration: 'vendor-claimed', confidence: 0.45,
        distribution: recorded!.tie, calibrationRef: null } };
    const routed = applyPrimitiveAcceptance(work.definitions.category!, policy(), tied);
    assert.equal(routed.acceptance?.disposition, expected.tieDisposition);
    assert.equal(routed.acceptance?.reason, expected.tieReason);
    return { outcome: 'pass' };
  },
  TV07: async () => {
    const { recorded, expected } = await vector('TV07');
    const withLevels = async (count: number, legend?: (levels: unknown[]) => Record<string, unknown>) => {
      const work = await workload();
      const answerSpec = work.definitions.severity!.spec.answer as { kind: 'ordinal-score'; levels: string[] };
      answerSpec.levels = Array.from({ length: count }, (_, index) => answerSpec.levels[index] ?? `Synthetic level ${index}.`);
      const fake = transport(body => new Response(JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 5, output_tokens: 1 },
        answers: Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([id, question]) => {
          const value = answer(question);
          return [id, legend && question.type === 'score' ? { ...value, legend: legend(question.criteria) } : value];
        })) })));
      const result = await evaluate(repin(work), fake, `tv07-${count}`);
      return { result, fake, severityCalls: fake.recorder.bodies.filter(body => 'severity' in body.questions).length };
    };
    const within = await withLevels(recorded!.maxLevels);
    assert.equal(within.result.spec.evaluations.severity!.spec.status, 'success');
    assert.equal(within.severityCalls, expected.withinLimitCalls);
    const over = await withLevels(recorded!.maxLevels + 1);
    assert.equal(over.result.spec.reason, expected.overLimitReason);
    assert.equal(over.fake.recorder.calls, expected.overLimitCalls);
    assert.equal(over.fake.recorder.credentials, expected.overLimitCredentials);
    const mismatch = await withLevels(3, levels => Object.fromEntries(levels.map((_, index) => [index, `renamed ${index}`])));
    assert.equal(mismatch.result.spec.evaluations.severity!.spec.reason, expected.legendMismatchReason);
    return { outcome: 'pass' };
  },
  TV09: async () => {
    const { expected } = await vector('TV09');
    const fake = transport();
    const observed = await new JevDecisionAdapter({ fetch: fake.fetchImpl }).evaluate(await adapterRequest());
    assert.equal(observed.uncertainty?.calibration, expected.calibration);
    assert.equal(observed.uncertainty?.calibrationRef, expected.calibrationRef);
    assert.equal(observed.uncertainty?.calibratedRisk, undefined);
    const work = await workload();
    const required = applyPrimitiveAcceptance(work.definitions.category!, policy({ calibration: 'required' }), observed);
    assert.equal(required.acceptance?.reason, expected.requiredCalibrationReason);
    assert.equal(required.acceptance?.disposition, expected.requiredCalibrationDisposition);
    assert.equal(required.acceptance?.values['native-confidence']?.provenance, 'provider-confidence');
    return { outcome: 'pass' };
  },
  TV12: async () => {
    const { recorded, expected } = await vector('TV12');
    const estimator: ContextTokenEstimator = { id: 'fixture', version: '1',
      estimate: value => ({ tokens: (value as { tokens?: number }).tokens ?? 0, serializedBytes: 1 }) };
    const profile = (safetyMarginBps: number): ContextProviderProfile => ({ id: 'jev', version: 'fixture',
      estimator: { id: 'fixture', version: '1' }, safetyMarginBps, requestEnvelopeTokens: 10,
      limits: { aggregateTokens: recorded!.aggregateTokens, stateAndLongestQuestionTokens: recorded!.stateAndLongestQuestionTokens } });
    const input = (state: number, questions: number[]) => ({ subject: 'tv12', authorizationDigest: `sha256:${'a'.repeat(64)}` as const,
      incompleteContext: false, authorizedState: { tokens: state },
      questions: questions.map((tokens, index) => ({ id: `q${index}`, subject: 'tv12', entry: { tokens } })) });
    // Planner boundaries: 64k aggregate splits, 32k state-plus-longest question is refused before dispatch.
    assert.equal(planDecisionContext(input(1_000, [21_000, 21_000, 20_990]), profile(0), estimator).partitions.length, 1);
    assert.equal(planDecisionContext(input(1_000, [21_000, 21_000, 20_991]), profile(0), estimator).partitions.length,
      expected.over64kPartitions);
    assert.equal(planDecisionContext(input(1_000, [30_990]), profile(0), estimator).rawEstimate.stateAndLongestQuestionTokens, 32_000);
    assert.throws(() => planDecisionContext(input(1_000, [30_991]), profile(0), estimator),
      (error: { reason?: string }) => error.reason === expected.over32kReason);
    const sample = (caseId: string, actual: number, source: ContextComparison['source']): ContextComparison => ({
      caseId, actualInputTokens: actual, source, usageRef: `receipt:${caseId}`, input: input(100, [890]) });
    const margin = profile(recorded!.safetyMarginBps);
    assert.equal(compareContextUsage([sample('a', 1_100, 'synthetic')], margin, estimator).reason, expected.syntheticReason);
    assert.equal(compareContextUsage([sample('a', 1_300, 'provider')], margin, estimator).reason, expected.overMarginReason);
    const within = compareContextUsage([sample('a', 900, 'provider'), sample('b', 1_100, 'provider')], margin, estimator);
    assert.equal(within.reason, expected.withinMarginReason);
    assertContextQualified(within, margin, estimator);
    assert.throws(() => assertContextQualified(within, { ...margin, version: 'next' }, estimator));
    const split = sample('split', 100, 'provider');
    split.input.questions = Array.from({ length: 80 }, (_, n) => ({ id: `q${n}`, subject: 'tv12', entry: { tokens: 890 } }));
    assert.throws(() => compareContextUsage([split], margin, estimator));
    return { outcome: 'pass' };
  },
  TV13: async () => {
    const { expected } = await vector('TV13');
    const statuses = Object.keys(expected).filter(key => /^\d{3}$/.test(key)).map(Number);
    for (const status of statuses) {
      const fake = transport(() => statusResponse(status));
      const observed = await new JevDecisionAdapter({ fetch: fake.fetchImpl }).evaluate(await adapterRequest());
      assert.equal(observed.reason, expected[String(status)], String(status));
      assert.equal(fake.recorder.calls, 1, `adapter retried ${status}`);
      const work = await workload();
      work.binding.spec.maxAttempts = 6;
      work.binding.spec.evaluations.category!.targets[0]!.retry.maxRetries = 1;
      let first = true;
      const binding = transport(body => {
        if ('category' in body.questions && first) { first = false; return statusResponse(status); }
        return new Response(JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 1, output_tokens: 1 },
          answers: Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([id, q]) => [id, answer(q)])) }));
      });
      await evaluate(work, binding, `tv13-${status}`);
      const categoryCalls = binding.recorder.bodies.filter(body => 'category' in body.questions).length;
      const retryable = ['timeout', 'rate-limited', 'overloaded', 'service-error'].includes(expected[String(status)]);
      assert.equal(categoryCalls, retryable ? expected.retryableCalls : expected.terminalCalls, `binding calls for ${status}`);
    }
    return { outcome: 'pass' };
  },
  TV14: async () => {
    const { recorded, expected } = await vector('TV14');
    const now = Date.parse(recorded!.now);
    for (const item of recorded!.headers as Array<{ name: string; headers: Record<string, string>; expectedMs: number | null }>) {
      const adapter = new JevDecisionAdapter({ fetch: async () => statusResponse(429, item.headers), now: () => now });
      const observed = await adapter.evaluate(await adapterRequest({ deadlineEpochMs: now + 10_000 }));
      assert.equal(observed.reason, 'rate-limited', item.name);
      assert.equal(observed.retryAfterMs ?? null, item.expectedMs, item.name);
    }
    for (const [maxDelayMs, waited] of [[60_000, expected.boundedWaitMs], [500, 500]] as const) {
      const work = await workload();
      work.binding.spec.maxAttempts = 6;
      work.binding.spec.evaluations.category!.targets[0]!.retry = { maxRetries: 1, initialDelayMs: 1, maxDelayMs };
      let first = true;
      const waits: number[] = [];
      const fake = transport(body => {
        if ('category' in body.questions && first) { first = false; return statusResponse(429, { 'retry-after': '2' }); }
        return new Response(JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 1, output_tokens: 1 },
          answers: Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([id, q]) => [id, answer(q)])) }));
      });
      const result = await evaluate(work, fake, `tv14-${maxDelayMs}`, { delay: async ms => { waits.push(ms); } });
      assert.deepEqual(waits, [waited]);
      assert.equal(result.spec.evaluations.category!.spec.attempts[0]!.retryDelayMs, waited);
    }
    return { outcome: 'pass' };
  },
  TV15: async () => {
    const { expected } = await vector('TV15');
    let calls = 0;
    const now = 5_000_000;
    const expired = await new JevDecisionAdapter({ fetch: async () => { calls += 1; return statusResponse(200); }, now: () => now })
      .evaluate(await adapterRequest({ deadlineEpochMs: now }));
    assert.equal(expired.reason, 'timeout');
    assert.equal(expired.termination, expected.adapterTimeout);
    assert.equal(expired.dispatchCertainty, 'not-sent');
    assert.equal(calls, 0);
    const work = await workload();
    work.binding.spec.totalTimeoutMs = 1_000;
    work.binding.spec.evaluations.category!.targets[0]!.retry = { maxRetries: 5, initialDelayMs: 250, maxDelayMs: 60_000 };
    let clock = 1_000_000;
    const waits: number[] = [];
    const fake = transport(body => 'category' in body.questions ? statusResponse(503, { 'retry-after': '30' })
      : new Response(JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 1, output_tokens: 1 },
        answers: Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([id, q]) => [id, answer(q)])) })));
    const adapter = new JevDecisionAdapter({ fetch: fake.fetchImpl, now: () => clock });
    const result = await evaluate(work, fake, 'tv15-deadline', { now: () => clock, delay: async ms => { waits.push(ms); clock += ms; } }, adapter);
    assert.deepEqual(waits, []);
    assert.equal(result.spec.evaluations.category!.spec.attempts.length, expected.deadlineAttempts);
    assert.notEqual(result.spec.evaluations.category!.spec.status, 'success');
    return { outcome: 'pass' };
  },
  TV16: async () => {
    const { expected } = await vector('TV16');
    const before = new AbortController();
    before.abort();
    let calls = 0;
    const early = await new JevDecisionAdapter({ fetch: async () => { calls += 1; return statusResponse(200); } })
      .evaluate(await adapterRequest({ signal: before.signal }));
    assert.equal(early.reason, expected.reason);
    assert.equal(early.termination, expected.termination);
    assert.equal(early.dispatchCertainty, expected.beforeDispatch);
    assert.equal(calls, 0);
    const during = new AbortController();
    const late = await new JevDecisionAdapter({ fetch: async () => {
      calls += 1;
      during.abort();
      throw new DOMException('Aborted', 'AbortError');
    } }).evaluate(await adapterRequest({ signal: during.signal }));
    assert.equal(calls, 1);
    assert.equal(late.reason, expected.reason);
    assert.equal(late.termination, expected.termination);
    assert.equal(late.dispatchCertainty, expected.afterDispatch);
    assert.equal(late.remoteExecution, 'unknown');
    return { outcome: 'pass' };
  },
  TV17: async () => {
    const { expected } = await vector('TV17');
    // CNC-ORDER-01: concurrency 1/N/N+1 with barrier-controlled reverse completion keeps input order.
    for (const ceiling of [1, 2, 3]) {
      const release = new Map<number, () => void>();
      let active = 0;
      let maximum = 0;
      const work = Array.from({ length: ceiling + 1 }, (_, value) => ({ value, lane: `lane-${value}` }));
      const running = runBoundedFair(work, ceiling, async value => {
        active += 1; maximum = Math.max(maximum, active);
        await new Promise<void>(resolve => release.set(value, resolve));
        active -= 1;
        return value;
      });
      for (let value = ceiling - 1; value >= 0; value -= 1) {
        release.get(value)!();
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      release.get(ceiling)!();
      assert.deepEqual(await running, work.map(item => item.value));
      assert.equal(maximum, ceiling);
    }
    const limits = (overrides: Partial<DecisionAdmissionLimits> = {}): DecisionAdmissionLimits =>
      ({ concurrency: 1, maxCostUsd: 1, allowUnknownCost: false, maxQueueLength: 64, maxQueueWaitMs: 60_000, ...overrides });
    const request = (principalId: string, budgetId: string, signal = new AbortController().signal) => ({ budgetId, principalId,
      workspaceId: 'workspace', providerId: 'jev', estimate: { costUsd: 0.01 }, deadlineEpochMs: Date.now() + 60_000, signal });
    // CNC-FAIR-01: a noisy principal cannot starve a quiet one.
    const shared = limits();
    const fair = new DecisionAdmissionController(() => ({ principal: shared, workspace: shared, provider: shared }));
    const held = await fair.acquire(request('noisy', 'noisy-0'));
    const order: string[] = [];
    const noisy = Array.from({ length: 6 }, (_, index) => fair.acquire(request('noisy', `noisy-${index + 1}`))
      .then(lease => { order.push(`noisy-${index + 1}`); lease.release({ success: true }); }));
    const quiet = fair.acquire(request('quiet', 'quiet')).then(lease => { order.push('quiet'); lease.release({ success: true }); });
    held.release({ success: true });
    await Promise.all([...noisy, quiet]);
    assert.ok(order.indexOf('quiet') <= expected.quietPosition, order.join(','));
    // CNC-QUEUE-01 and CNC-CANCEL-01: a full queue sheds load; a cancelled waiter takes no permit.
    const bounded = limits({ maxQueueLength: 1 });
    const queue = new DecisionAdmissionController(() => ({ principal: bounded, workspace: bounded, provider: bounded }));
    const first = await queue.acquire(request('p', 'b1'));
    const abort = new AbortController();
    const waiting = queue.acquire(request('p', 'b2', abort.signal));
    await assert.rejects(queue.acquire(request('p', 'b3')), (error: any) => error.evidence.reason === expected.queueFullReason);
    abort.abort();
    await assert.rejects(waiting, (error: any) => error.evidence.reason === expected.cancelledReason);
    first.release({ success: true });
    const next = await queue.acquire(request('p', 'b4'));
    assert.equal(next.evidence.reason, 'admitted');
    next.release({ success: true });
    // CNC-RETRY-OWNER-01: under a 429 storm the adapter never retries; each request is one fetch with its hint.
    let fetches = 0;
    const adapter = new JevDecisionAdapter({ fetch: async () => { fetches += 1; return statusResponse(429, { 'retry-after-ms': '40' }); } });
    const storm = await Promise.all(Array.from({ length: 8 }, async () => adapter.evaluate(await adapterRequest())));
    assert.equal(fetches, 8);
    assert.ok(storm.every(item => item.reason === 'rate-limited' && item.retryAfterMs === 40));
    return { outcome: 'pass' };
  },
  TV18: async () => {
    const { recorded, expected } = await vector('TV18');
    const request = await adapterRequest();
    assert.equal(request.target.model, recorded!.requestedModel);
    const body = (usage?: unknown) => (sent: Record<string, any>) => new Response(JSON.stringify({ model: recorded!.servedModel,
      ...(usage ? { usage } : {}), answers: { category: answer(sent.questions.category) } }));
    const reported = await new JevDecisionAdapter({ fetch: transport(body(recorded!.usage)).fetchImpl }).evaluate(request);
    assert.equal(reported.actualModel, recorded!.servedModel);
    assert.notEqual(reported.actualModel, request.target.model);
    assert.deepEqual(reported.usage, { inputTokens: recorded!.usage.input_tokens, outputTokens: recorded!.usage.output_tokens,
      costUsd: expected.costUsd });
    const missing = await new JevDecisionAdapter({ fetch: transport(body()).fetchImpl }).evaluate(await adapterRequest());
    assert.deepEqual(missing.usage, { inputTokens: expected.missingUsage, outputTokens: expected.missingUsage, costUsd: null });
    const result = await evaluate(await workload(), transport(sent => new Response(JSON.stringify({ model: recorded!.servedModel,
      usage: recorded!.usage, answers: Object.fromEntries(Object.entries(sent.questions as Record<string, any>).map(([id, q]) => [id, answer(q)])) }))),
    'tv18-runtime');
    const attempt = result.spec.evaluations.category!.spec.attempts[0]!;
    assert.equal(attempt.requestedModel, recorded!.requestedModel);
    assert.equal(attempt.actualModel, recorded!.servedModel);
    assert.equal(attempt.usage.costUsd, null);
    return { outcome: 'pass' };
  },
  TV19: async () => {
    const { recorded, expected } = await vector('TV19');
    const cases = [...recorded!.cases as Array<{ name: string; headers: Record<string, string>; expected: [string | null, string | null] }>,
      { name: 'oversized', headers: { 'x-typesafe-request-id': 'r'.repeat(expected.maxLength + 1) }, expected: [null, null] as [null, null] },
      { name: 'at-limit', headers: { 'x-typesafe-request-id': 'r'.repeat(expected.maxLength) },
        expected: ['r'.repeat(expected.maxLength), 'typesafe'] as [string, string] }];
    for (const item of cases) {
      const observed = await new JevDecisionAdapter({ fetch: transport(sent => new Response(JSON.stringify({ model: 'jev-fixture',
        answers: { category: answer(sent.questions.category) } }), { headers: item.headers })).fetchImpl }).evaluate(await adapterRequest());
      assert.equal(observed.requestId, item.expected[0], item.name);
      assert.equal(observed.requestIdSource ?? null, item.expected[1], item.name);
    }
    const fromBody = await new JevDecisionAdapter({ fetch: async () => statusResponse(500, { 'content-type': 'application/json' },
      JSON.stringify({ request_id: 'req_body_1' })) }).evaluate(await adapterRequest());
    assert.equal(fromBody.requestId, 'req_body_1');
    assert.equal(fromBody.requestIdSource, expected.errorBodySource);
    const headerWins = await new JevDecisionAdapter({ fetch: async () => statusResponse(500,
      { 'content-type': 'application/json', 'x-typesafe-request-id': 'req_header' }, JSON.stringify({ request_id: 'req_body_2' })) })
      .evaluate(await adapterRequest());
    assert.equal(headerWins.requestId, 'req_header');
    return { outcome: 'pass' };
  },
  TV20: async () => {
    const { expected } = await vector('TV20');
    const plan = { minimumN: 50, maximumTotalVariation: 0.1, maximumPopulationStability: 0.1 };
    const repeat = (counts: Record<string, number>) => Object.entries(counts).flatMap(([label, n]) => Array<string>(n).fill(label));
    const reference = repeat({ documentation: 60, runtime: 30, other: 10 });
    // DRF-OUTPUT-01: identical and shifted output distributions.
    const same = measureCategoricalDrift(reference, repeat({ documentation: 58, runtime: 31, other: 11 }), plan);
    assert.equal(same.decision === 'drift', expected.stableDrift);
    const shifted = measureCategoricalDrift(reference, repeat({ documentation: 30, runtime: 60, other: 10 }), plan);
    assert.equal(shifted.decision === 'drift', expected.shiftedDrift);
    assert.ok(shifted.reasons.includes('total-variation'));
    // DRF-POPULATION-01: a new input slice appearing in production is a population shift.
    const population = measureCategoricalDrift(repeat({ web: 80, mobile: 20 }), repeat({ web: 40, mobile: 20, api: 40 }), plan);
    assert.equal(population.decision, 'drift');
    assert.ok(population.categories.includes('api'));
    // DRF-LABEL-01: repeated-run label movement is measured with an interval.
    const pairs = (changed: number, n: number) => Array.from({ length: n }, (_, index) => ({ id: `item-${index}`,
      control: 'documentation', observed: index < changed ? 'runtime' : 'documentation' }));
    assert.equal(measureLabelStability(pairs(0, 200), 0.05).decision, 'stable');
    assert.equal(measureLabelStability(pairs(60, 200), 0.05).decision, 'drift');
    // DRF-INSUFFICIENT-01: small samples cannot be reported stable.
    assert.equal(measureLabelStability(pairs(0, 10), 0.05).decision, 'insufficient-evidence');
    assert.equal(measureCategoricalDrift(reference.slice(0, 10), reference.slice(0, 10), plan).decision, 'insufficient-evidence');
    return { outcome: 'pass' };
  },
  TV21: async () => {
    const { expected } = await vector('TV21');
    const cases: Array<[string, ConstructorParameters<typeof JevDecisionAdapter>[0]]> = [
      ['unapproved-origin', { endpoint: 'https://decisions.example.test/v1/systemone' }],
      ['literal-ip', { endpoint: 'https://203.0.113.10/v1/systemone', allowedOrigins: ['https://203.0.113.10/'] }],
      ['private-dns', { endpoint: 'https://jev.example.test/v1', allowedOrigins: ['https://jev.example.test/'], resolveAddresses: async () => ['10.0.0.8'] }],
      ['ipv6-dns', { endpoint: 'https://jev.example.test/v1', allowedOrigins: ['https://jev.example.test/'], resolveAddresses: async () => ['2001:db8::1'] }],
      ['mixed-dns', { endpoint: 'https://jev.example.test/v1', allowedOrigins: ['https://jev.example.test/'], resolveAddresses: async () => ['93.184.216.34', '127.0.0.1'] }],
      ['userinfo', { endpoint: 'https://user:pass@api.typesafe.ai/v1/systemone' }],
      ['plain-http', { endpoint: 'http://api.typesafe.ai/v1/systemone' }],
    ];
    for (const [name, options] of cases) {
      let calls = 0;
      let credentials = 0;
      const adapter = new JevDecisionAdapter({ ...options, fetch: async () => { calls += 1; return statusResponse(200); },
        pinnedFetch: async () => { calls += 1; return statusResponse(200); } });
      const observed = await adapter.evaluate(await adapterRequest({
        resolveCredential: async () => { credentials += 1; return new TextEncoder().encode('synthetic-credential'); } }));
      assert.equal(observed.reason, expected.reason, name);
      assert.equal(observed.dispatchCertainty, expected.dispatchCertainty, name);
      assert.equal(credentials, expected.credentials, name);
      assert.equal(calls, expected.calls, name);
    }
    return { outcome: 'pass' };
  },
  TV23: async () => {
    const { expected } = await vector('TV23');
    const fake = transport();
    const result = await evaluate(await workload(), fake, 'tv23-mixed', { batching: sameSubject(alias => `ticket:${alias}`) });
    assert.equal(fake.recorder.calls, expected.providerCalls);
    assert.ok(fake.recorder.bodies.every(body => Object.keys(body.questions).length === 1));
    for (const evaluation of Object.values(result.spec.evaluations)) {
      assert.equal(evaluation.spec.status, 'success');
      assert.equal(evaluation.spec.attempts[0]!.batch?.mode, expected.mode);
      assert.equal(evaluation.spec.attempts[0]!.batch?.degradationReason, expected.degradationReason);
    }
    return { outcome: 'pass' };
  },
  TV24: async () => {
    const { expected } = await vector('TV24');
    const withUrl = (response: Response, url: string) => { Object.defineProperty(response, 'url', { value: url }); return response; };
    const redirect = transport(() => statusResponse(302, { location: 'https://elsewhere.example.test/' }));
    const redirected = await new JevDecisionAdapter({ fetch: redirect.fetchImpl }).evaluate(await adapterRequest());
    assert.equal(redirected.reason, expected.redirectReason);
    assert.equal(redirect.recorder.inits[0]!.redirect, expected.redirectMode);
    const crossOrigin = await new JevDecisionAdapter({ fetch: transport(sent => withUrl(new Response(JSON.stringify({
      model: 'jev-fixture', answers: { category: answer(sent.questions.category) } })), 'https://elsewhere.example.test/v1')).fetchImpl })
      .evaluate(await adapterRequest());
    assert.equal(crossOrigin.reason, expected.crossOriginReason);
    assert.equal(crossOrigin.value, undefined);
    const declared = await new JevDecisionAdapter({ fetch: async () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024) } }) })
      .evaluate(await adapterRequest());
    assert.equal(declared.reason, expected.oversizedReason);
    const streamed = await new JevDecisionAdapter({ fetch: async () => new Response(`{"pad":"${'x'.repeat(1024 * 1024 + 16)}"}`) })
      .evaluate(await adapterRequest());
    assert.equal(streamed.reason, expected.oversizedReason);
    assert.equal(streamed.value, undefined);
    return { outcome: 'pass' };
  },
  TV25: async () => {
    const { recorded, expected } = await vector('TV25');
    const baseline = transport();
    await evaluate(await workload(), baseline, 'tv25-baseline');
    const questions = (fake: ReturnType<typeof transport>) => JSON.stringify(fake.recorder.bodies
      .map(body => body.questions).sort((a, b) => Object.keys(a)[0]!.localeCompare(Object.keys(b)[0]!)));
    for (const [slice, text] of Object.entries(recorded!.slices as Record<string, string>)) {
      const work = await workload();
      work.input = { message: text };
      const fake = transport();
      const result = await evaluate(work, fake, `tv25-${slice}`);
      assert.equal(result.spec.outcome, expected.outcome, slice);
      assert.equal(result.spec.evaluations.category!.spec.value, expected.value, slice);
      assert.equal(questions(fake), questions(baseline), slice);
      for (const body of fake.recorder.bodies) {
        assert.deepEqual(body.state, { message: text }, slice);
        assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state'], slice);
        assert.equal(JSON.stringify({ ...body, state: null }).includes(text), false, slice);
        assert.equal(JSON.stringify(body).includes('synthetic-credential'), false, slice);
      }
      assert.equal(JSON.stringify(result).includes('synthetic-credential'), false, slice);
    }
    return { outcome: 'pass' };
  },
};
