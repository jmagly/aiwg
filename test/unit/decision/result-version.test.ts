import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  artifactPin,
  assertDecisionResultWriterVersion,
  DECISION_RESULT_V1ALPHA2_FIELDS,
  decisionResultV1Alpha2Fields,
  DecisionValidationError,
  evaluateDecisionRuleset,
  MemoryDecisionReceiptStore,
  nextReceipt,
  readDecisionDocumentForRollback,
  validateDecisionDocument,
  type AdapterObservation,
  type DecisionAdapter,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionEvaluationRequest,
  type DecisionResult,
  type DecisionRuleset,
  type ProviderPrefixIdentity,
  type RulesetResult,
} from '../../../src/decision/index.js';

const V1 = 'decision.aiwg.io/v1alpha1';
const V2 = 'decision.aiwg.io/v1alpha2';
const fixture = <T>(name: string): T => JSON.parse(readFileSync(`examples/decision/${name}`, 'utf8')) as T;
type Spec = Record<string, unknown> & { attempts: Array<Record<string, unknown>> };
const specOf = (value: DecisionResult): Spec => value.spec as unknown as Spec;

/** One v1alpha1 anti-fixture per v1alpha2-only field, built from the released v1alpha1 example. */
function decisionAntiFixtures(): Array<{ field: string; document: DecisionResult }> {
  const source = specOf(fixture<DecisionResult>('result-category-batch.v1alpha2.json'));
  return DECISION_RESULT_V1ALPHA2_FIELDS.filter(entry => entry.scope !== 'ruleset')
    .filter(entry => entry.field in source || entry.field in source.attempts[0]!)
    .map(entry => {
      const document = fixture<DecisionResult>('result-category.json');
      if (entry.scope === 'decision') specOf(document)[entry.field] = structuredClone(source[entry.field]);
      else specOf(document).attempts[0]![entry.field] = structuredClone(source.attempts[0]![entry.field]);
      return { field: entry.field, document };
    });
}

describe('decision result version ownership', () => {
  it('keeps released v1alpha1 results readable and accepts v1alpha2 batch evidence fixtures', () => {
    for (const name of ['result-category.json', 'result-severity.json', 'result-core_unavailable.json', 'ruleset-result.json', 'llm-ruleset-result.json']) {
      const document = fixture<DecisionResult | RulesetResult>(name);
      expect(document.apiVersion).toBe(V1);
      expect(decisionResultV1Alpha2Fields(document)).toEqual([]);
      assertDecisionResultWriterVersion(document);
    }
    const single = fixture<DecisionResult>('result-category-batch.v1alpha2.json');
    const composed = fixture<RulesetResult>('ruleset-result-batch.v1alpha2.json');
    for (const document of [single, composed]) {
      expect(document.apiVersion).toBe(V2);
      validateDecisionDocument(document);
      assertDecisionResultWriterVersion(document);
    }
    expect(decisionResultV1Alpha2Fields(single)).toEqual(expect.arrayContaining([
      '$.spec.batchResult', '$.spec.context', '$.spec.attempts[0].batch', '$.spec.attempts[0].admission', '$.spec.attempts[0].providerPrefix']));
    expect(decisionResultV1Alpha2Fields(composed)).toContain('$.spec.context');
    expect(decisionResultV1Alpha2Fields(composed)).toContain('$.spec.evaluations.category.spec.batchResult');
  });

  it('rejects every v1alpha2-only field under a v1alpha1 label in the reader and the writer gate', () => {
    const cases = decisionAntiFixtures();
    expect(cases.map(item => item.field).sort()).toEqual(['admission', 'batch', 'batchResult', 'context', 'providerPrefix']);
    for (const { field, document } of cases) {
      expect(() => validateDecisionDocument(document), field).toThrow(DecisionValidationError);
      expect(() => assertDecisionResultWriterVersion(document), field).toThrow(DecisionValidationError);
      expect(() => assertDecisionResultWriterVersion(document), field).toThrow(new RegExp(`${field}.*requires ${V2}`));
      // Relabelling the same evidence as v1alpha2 is the only accepted representation.
      const upgraded = { ...structuredClone(document), apiVersion: V2 } as unknown as DecisionResult;
      assertDecisionResultWriterVersion(upgraded);
    }
    const composed = fixture<RulesetResult>('ruleset-result.json');
    (composed.spec as unknown as Record<string, unknown>).context = structuredClone(
      fixture<RulesetResult>('ruleset-result-batch.v1alpha2.json').spec.context);
    expect(() => validateDecisionDocument(composed)).toThrow(DecisionValidationError);
    expect(() => assertDecisionResultWriterVersion(composed)).toThrow(/\$\.spec\.context requires/);
    const rejected = fixture<RulesetResult>('ruleset-result.json');
    Object.assign(rejected.spec, { status: 'error', reason: 'context-plan-stale', matchedRules: [], evaluations: {},
      contextFailure: { schemaVersion: 'decision-context-failure/v1', reason: 'stale-plan' } });
    delete (rejected.spec as { outcome?: unknown }).outcome;
    expect(() => assertDecisionResultWriterVersion(rejected)).toThrow(/\$\.spec\.contextFailure requires/);
    expect(() => assertDecisionResultWriterVersion({ ...rejected, apiVersion: V2 })).not.toThrow();
    const nested = fixture<RulesetResult>('ruleset-result.json');
    nested.spec.evaluations.category = decisionAntiFixtures().find(item => item.field === 'batchResult')!.document;
    expect(() => validateDecisionDocument(nested)).toThrow(DecisionValidationError);
    expect(() => assertDecisionResultWriterVersion(nested)).toThrow(/evaluations\.category\.spec\.batchResult requires/);
    const mixed = fixture<RulesetResult>('ruleset-result-batch.v1alpha2.json');
    mixed.spec.evaluations.category!.apiVersion = V1 as typeof mixed.apiVersion;
    expect(() => assertDecisionResultWriterVersion(mixed)).toThrow(DecisionValidationError);
    expect(() => assertDecisionResultWriterVersion(fixture('ruleset.json'))).toThrow(/accepts only DecisionResult or RulesetResult/);
  });

  it('refuses a v1alpha1-labelled D07 result at the invocation receipt writer', async () => {
    const store = new MemoryDecisionReceiptStore();
    let receipt = (await store.acquire('gate', 'project', `sha256:${'a'.repeat(64)}`)).receipt;
    const smuggled = decisionAntiFixtures().find(item => item.field === 'batchResult')!.document;
    smuggled.spec.alias = 'category';
    smuggled.spec.invocationId = 'gate';
    expect(() => nextReceipt(receipt, 'observation-received', { evaluations: { category: smuggled } }))
      .toThrow(DecisionValidationError);
    const accepted = { ...structuredClone(smuggled), apiVersion: V2 } as unknown as DecisionResult;
    let next = nextReceipt(receipt, 'observation-received', { evaluations: { category: accepted } });
    expect(await store.compareAndSwap('gate', 'project', receipt.revision, next)).toBe(true);
    receipt = next;
    next = nextReceipt(receipt, 'composed');
    expect(await store.compareAndSwap('gate', 'project', receipt.revision, next)).toBe(true);
    receipt = next;
    const result = fixture<RulesetResult>('ruleset-result.json');
    result.spec.invocationId = 'gate';
    (result.spec.evaluations.category!.spec as unknown as Record<string, unknown>).batchResult = accepted.spec.batchResult;
    expect(() => nextReceipt(receipt, 'completed', { result })).toThrow(/batchResult requires decision\.aiwg\.io\/v1alpha2/);
    expect((await store.read('gate', 'project'))?.state).toBe('composed');
  });

  it('keeps new v1alpha2 results read-only under rollback execution', () => {
    for (const name of ['result-category-batch.v1alpha2.json', 'ruleset-result-batch.v1alpha2.json']) {
      const document = fixture<DecisionResult | RulesetResult>(name);
      const digest = artifactPin(document).digest;
      expect(() => readDecisionDocumentForRollback(document, 'execute')).toThrow(/cannot execute/);
      const inspection = readDecisionDocumentForRollback(document, 'read-only');
      expect(inspection.writable).toBe(false);
      expect(Object.isFrozen(inspection.document.spec)).toBe(true);
      expect(artifactPin(document).digest).toBe(digest);
    }
    expect(readDecisionDocumentForRollback(fixture('ruleset-result.json'), 'execute').writable).toBe(true);
  });
});

describe('decision evaluator result version', () => {
  const definitions = (): Record<string, DecisionDefinition> => ({
    category: fixture('decision-category.json'), severity: fixture('decision-severity.json'),
    core: fixture('decision-core_unavailable.json'),
  });
  const success = (value: string | number, profile = 'typesafe-distribution-v1'): AdapterObservation => ({
    status: 'success', reason: 'none', value,
    uncertainty: { source: 'provider', profile, calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
    actualModel: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: 'fixture-request',
  });
  const adapter: DecisionAdapter = {
    id: 'jev', version: '1.0.0',
    capabilities: async () => ({
      answerKinds: ['choice', 'ordinal-score', 'truth-probability'] as const,
      features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10,
      confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true,
    }),
    evaluate: async request => request.alias === 'category' ? success('documentation')
      : request.alias === 'severity' ? success(0.25) : success(0.05, 'typesafe-truth-v1'),
  };
  const request = (invocationId: string, extra: Partial<DecisionEvaluationRequest> = {}): DecisionEvaluationRequest => ({
    ruleset: fixture<DecisionRuleset>('ruleset.json'), binding: fixture<DecisionBinding>('binding-jev.json'),
    definitions: definitions(), input: fixture('input.json'), runId: 'run', invocationId, adapters: { jev: adapter }, ...extra,
  });
  const limits = { concurrency: 3, maxQueueLength: 8, maxQueueWaitMs: 1_000 };
  const digest = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`;
  const prefixIdentity: ProviderPrefixIdentity = { schemaVersion: 'decision-provider-prefix-identity/v1', orderedPrefixDigest: digest('c'),
    provider: 'jev', backend: 'structured', requestedModel: 'jev-1', actualModel: 'jev-1.0', apiRevision: 'v1',
    policy: { id: 'documented', version: '1', ttlMs: 1_000 }, tenantId: 'tenant', workspaceId: 'project', dataClass: 'internal',
    region: 'us', egressPolicyDigest: digest('d') };

  const assertVersion = (result: RulesetResult, version: string, field: string | null) => {
    expect(result.spec.status).not.toBe('error');
    expect(result.apiVersion).toBe(version);
    for (const evaluation of Object.values(result.spec.evaluations)) expect(evaluation.apiVersion).toBe(version);
    if (field) expect(decisionResultV1Alpha2Fields(result).some(path => path.endsWith(field))).toBe(true);
    else expect(decisionResultV1Alpha2Fields(result)).toEqual([]);
    assertDecisionResultWriterVersion(result);
  };

  it('writes v1alpha1 only when a v1alpha1 request carries no new-semantics evidence', async () => {
    assertVersion(await evaluateDecisionRuleset(request('plain')), V1, null);
  });

  it('upgrades v1alpha1 inputs to a v1alpha2 result for D04 batch, D05 admission and D30 prefix evidence', async () => {
    assertVersion(await evaluateDecisionRuleset(request('batch', { batching: { enabled: false, evaluations: {} } })), V2, '.batch');
    assertVersion(await evaluateDecisionRuleset(request('admission', { scheduler: { enabled: true, profileVersion: 'offline-v1',
      callerConcurrency: 1, graphConcurrency: 1, workspace: { id: 'workspace', limits }, principal: { id: 'principal', limits },
      providers: { jev: limits } } })), V2, '.admission');
    assertVersion(await evaluateDecisionRuleset(request('prefix', { providerPrefix: { identityFor: () => prefixIdentity } })),
      V2, '.providerPrefix');
  });

  it('persists the v1alpha2 label through the invocation receipt payload', async () => {
    const receiptStore = new MemoryDecisionReceiptStore();
    const result = await evaluateDecisionRuleset(request('receipt', { receiptStore,
      batching: { enabled: false, evaluations: {} } }));
    assertVersion(result, V2, '.batch');
    const receipt = await receiptStore.read('receipt', 'default');
    expect(receipt?.result).toEqual(result);
    for (const evaluation of Object.values(receipt!.evaluations)) expect(evaluation.apiVersion).toBe(V2);
  });
});
