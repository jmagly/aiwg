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
  CanonicalJsonByteEstimator,
  MemoryBatchReceiptStore,
  batchAccountingTotals,
  decisionBatchQuestionId,
  planDecisionContext,
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
    { decisionSubject, independent: true, egressPolicy: 'jev-public-v1' }]))
});

function request(fetchImpl: typeof fetch, subjects?: Record<string, string>) {
  return {
    ruleset: fixture<DecisionRuleset>('ruleset.json'), binding: fixture<DecisionBinding>('binding-jev.json'),
    definitions: definitions(), input: fixture('input.json'), runId: 'run', invocationId: 'batch-run',
    adapters: { jev: new JevDecisionAdapter({ fetch: fetchImpl }) }, batching: policy(subjects),
    resolveCredential: async () => new TextEncoder().encode('token'),
  };
}

function durableBatching(store = new MemoryBatchReceiptStore()) {
  const questionIds = ['category', 'severity', 'core_unavailable'].map(decisionBatchQuestionId);
  const estimator = new CanonicalJsonByteEstimator();
  const contextPlan = planDecisionContext({ subject: 'ticket:42', authorizedState: fixture('input.json'),
    authorizationDigest: `sha256:${'a'.repeat(64)}`, incompleteContext: false,
    questions: questionIds.map(id => ({ id, subject: 'ticket:42', entry: { question: id } })) },
  { id: 'jev', version: '1', estimator: { id: estimator.id, version: estimator.version },
    limits: { aggregateTokens: 100_000, stateAndLongestQuestionTokens: 100_000 }, safetyMarginBps: 0, requestEnvelopeTokens: 0 }, estimator);
  return { store, tenantId: 'tenant', projectId: 'project', contextPlan,
    subjectHash: `sha256:${'b'.repeat(64)}` as const };
}

function validResponse(body: Record<string, unknown>, omitLast = false): Response {
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
  return new Response(JSON.stringify({ answers, model: 'jev-fixture', usage: { input_tokens: 9, output_tokens: 3 } }), { status: 200 });
}

describe('native shared-state decision batching', () => {
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

  it('BCH-004/005 rejects a malformed atomic response for every sibling', async () => {
    const fetchImpl = vi.fn(async (_url, options) => validResponse(JSON.parse(String(options?.body)) as Record<string, unknown>, true)) as typeof fetch;
    const result = await evaluateDecisionRuleset(request(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Object.values(result.spec.evaluations).map(value => value.spec.reason)).toEqual([
      'invalid-output', 'invalid-output', 'invalid-output',
    ]);
    expect(result.spec.status).toBe('review');
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
