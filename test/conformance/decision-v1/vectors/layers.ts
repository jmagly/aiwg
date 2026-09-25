import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DecisionResultCache, evaluateDecisionRuleset, MemoryCompileCache, MemoryDecisionReceiptStore, MemoryResultCacheStore,
  RESULT_CACHE_KEY_VERSION, type AdapterObservation, type CompileCacheIdentity, type DecisionAdapter, type DecisionBinding,
  type DecisionDefinition, type DecisionRuleset, type QualificationCaseExecutor, type QualificationReleaseInputs,
  type ResultCacheSemanticIdentity,
} from '../../../../src/decision/index.js';

/**
 * Cache-layer evidence for the release record (AC15). Each layer runs as its
 * own qualification run so D30 compile/prefix reuse, D03 receipt replay and
 * D15 result caching stay distinguishable.
 */
export const CACHE_LAYERS = {
  compilePrefixCache: { runId: 'd30-compile-prefix-cache', caseId: 'D30-CCP', sources: ['src/decision/compile-cache/store.ts'] },
  receiptReplay: { runId: 'd03-receipt-replay', caseId: 'D03-REPLAY', sources: ['src/decision/receipts.ts', 'examples/decision/input.json'] },
  resultCache: { runId: 'd15-result-cache', caseId: 'D15-RESULT-CACHE', sources: ['src/decision/result-cache/service.ts'] },
} as const satisfies Record<keyof NonNullable<QualificationReleaseInputs['cacheLayers']>, { runId: string; caseId: string; sources: string[] }>;

const digest = (c: string) => `sha256:${c.repeat(64)}` as const;
const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(`examples/decision/${name}`, 'utf8')) as T;

export const executors: Record<string, QualificationCaseExecutor> = {
  // D30: a compiled definition is reused only for an identical identity.
  'D30-CCP': async () => {
    const identity = (requested = 'jev-1'): CompileCacheIdentity => ({ identityVersion: 'decision-compile-cache-identity/v1',
      layer: 'definition-compilation', sourceArtifactDigests: [digest('a')], compiler: { id: 'decision', version: '1' },
      runtimeVersion: 'node-22', schemaVersion: 'decision-v1alpha2', canonicalizer: { id: 'rfc8785', version: '1' },
      adapter: { id: 'jev', version: '1', promptVersion: 'p1' }, backendCapabilityMode: 'json-schema',
      modelPolicy: { requested, compatibleActualModels: [`${requested}.0`] }, featureFlags: { strict: true },
      tenantId: 'tenant', projectId: 'project', dataClass: 'internal' });
    const context = (nowEpochMs: number) => ({ tenantId: 'tenant', projectId: 'project', nowEpochMs, authorize: () => true });
    const cache = new MemoryCompileCache<string>();
    let compilations = 0;
    const compile = async () => `compiled-${++compilations}`;
    const outcomes = [(await cache.getOrCompile(identity(), context(100), 1_000, compile)).outcome,
      (await cache.getOrCompile(identity(), context(101), 1_000, compile)).outcome,
      (await cache.getOrCompile(identity('jev-2'), context(102), 1_000, compile)).outcome];
    assert.deepEqual(outcomes, ['miss', 'hit', 'miss']);
    assert.equal(compilations, 2);
    return { outcome: 'pass' };
  },
  // D03: an identical invocation replays its receipt without a new provider call.
  'D03-REPLAY': async () => {
    let calls = 0;
    const adapter: DecisionAdapter = { id: 'jev', version: '1.0.0', capabilities: async () => ({
      answerKinds: ['choice', 'ordinal-score', 'truth-probability'], features: ['choice', 'ordinal-score', 'truth-probability'],
      maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true,
    }), evaluate: async (request): Promise<AdapterObservation> => { calls += 1; return { status: 'success', reason: 'none',
      value: request.alias === 'category' ? 'documentation' : request.alias === 'severity' ? 0.25 : 0.05, actualModel: 'fixture',
      requestId: null, usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
      uncertainty: { source: 'provider', profile: request.alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1',
        calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null } }; } };
    const request = { ruleset: await fixture<DecisionRuleset>('ruleset.json'), binding: await fixture<DecisionBinding>('binding-jev.json'),
      definitions: { category: await fixture<DecisionDefinition>('decision-category.json'),
        severity: await fixture<DecisionDefinition>('decision-severity.json'), core: await fixture<DecisionDefinition>('decision-core_unavailable.json') },
      input: await fixture('input.json'), runId: 'd03', invocationId: 'd03-replay', adapters: { jev: adapter },
      receiptStore: new MemoryDecisionReceiptStore() };
    const first = await evaluateDecisionRuleset(request);
    const afterFirst = calls;
    const replay = await evaluateDecisionRuleset(request);
    assert.equal(calls, afterFirst);
    assert.equal(replay.spec.outcome, first.spec.outcome);
    return { outcome: 'pass' };
  },
  // D15: a semantic result is reused with its original provenance and no provider attempt.
  'D15-RESULT-CACHE': async () => {
    const actor = { tenantId: 't1', projectId: 'p1', workspaceId: 'w1', subjectId: 'user', permissions: ['read', 'write', 'invalidate', 'export', 'delete'] } as const;
    const policy = { enabled: true, sideEffectFree: true, policyVersion: 'p1', ttlMs: 1_000, scope: 'workspace', sensitivity: 'internal' } as const;
    const identity: ResultCacheSemanticIdentity = { keyVersion: RESULT_CACHE_KEY_VERSION, definition: { id: 'd', version: '1', digest: digest('1') },
      ruleset: { id: 'r', version: '1', digest: digest('2') }, binding: { id: 'b', version: '1', digest: digest('3') }, adapter: { id: 'jev', version: '1' },
      promptDigest: digest('4'), acceptancePolicyDigest: digest('5'), calibrationDigest: digest('6'), runtimePolicyDigest: digest('b'),
      backend: 'provider', requestedModel: 'model-v1', modelCompatibility: { mode: 'pinned', actualModel: 'model-v1' }, primitive: 'choice',
      projectedInput: { a: 1 }, subjectIdentityDigest: digest('7'), projectionPolicyDigest: digest('8'), egressPolicyDigest: digest('9'), capabilityMode: 'json' };
    let fills = 0;
    const fill = async () => { fills += 1; return { result: { answer: 'yes' }, resultDigest: digest('0'), sourceInvocationId: 'source',
      sourceReceiptId: 'receipt', evaluatedAtEpochMs: 900, actualModel: 'model-v1', uncertainty: { confidence: 0.9 }, calibrationStatus: 'approved' as const,
      durationMs: 5, usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, status: 'success' as const, failureReason: 'none' as const }; };
    const cache = new DecisionResultCache(new MemoryResultCacheStore());
    await cache.evaluate({ actor: { ...actor, permissions: [...actor.permissions] }, policy, identity, callerInvocationId: 'a', nowEpochMs: 1_000 }, fill);
    const hit = await cache.evaluate({ actor: { ...actor, permissions: [...actor.permissions] }, policy, identity, callerInvocationId: 'b', nowEpochMs: 1_100 }, fill);
    assert.equal(fills, 1);
    assert.equal(hit.receipt.disposition, 'cache-hit');
    assert.equal(hit.receipt.providerAttempted, false);
    return { outcome: 'pass' };
  },
};
