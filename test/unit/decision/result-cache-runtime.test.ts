import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { evaluateDecisionRuleset } from '../../../src/decision/evaluate.js';
import { MemoryDecisionReceiptStore } from '../../../src/decision/receipts.js';
import { DecisionResultCache, FileResultCacheStore, MemoryResultCacheStore, RESULT_CACHE_KEY_VERSION, digestCachedResult, digestResultCacheIdentity, entryIntegrityDigest } from '../../../src/decision/result-cache/index.js';
import { artifactPin, assertDecisionResultWriterVersion, validateDecisionDocument } from '../../../src/decision/validate.js';
import { BoundedDecisionMetrics } from '../../../src/decision/telemetry/metrics.js';
import { CalibrationRegistry, calibrationIdentityDigest } from '../../../src/decision/calibration/registry.js';
import type { CalibrationIdentity } from '../../../src/decision/calibration/types.js';
import type { ModelCompatibilityPolicy } from '../../../src/decision/result-cache/index.js';
import type { DecisionAdapter, DecisionBinding, DecisionDefinition, DecisionEvaluationRequest, DecisionRuleset } from '../../../src/decision/types.js';
import type { DecisionTelemetrySpan } from '../../../src/decision/telemetry/types.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`examples/decision/${name}`, 'utf8')) as T;
const sha = (c: string) => `sha256:${c.repeat(64)}` as const;
const actor = { tenantId: 'tenant', projectId: 'project', workspaceId: 'workspace', subjectId: 'caller', permissions: ['read', 'write', 'invalidate', 'export', 'delete'] as Array<'read' | 'write' | 'invalidate' | 'export' | 'delete'> };
const policy = { enabled: true, sideEffectFree: true, policyVersion: 'cache-policy-v1', ttlMs: 10_000, scope: 'workspace' as const, sensitivity: 'internal' as const };
function setup() {
  const ruleset = fixture<DecisionRuleset>('ruleset.json');
  ruleset.spec.evaluations = ruleset.spec.evaluations.filter(value => value.alias === 'category');
  ruleset.spec.rules = ruleset.spec.rules.filter(value => value.id === 'docs');
  const binding = fixture<DecisionBinding>('binding-jev.json');
  binding.spec.ruleset = artifactPin(ruleset);
  binding.spec.evaluations = { category: binding.spec.evaluations.category! };
  const definition = fixture<DecisionDefinition>('decision-category.json');
  const target = binding.spec.evaluations.category!.targets[0]!;
  const adapter: DecisionAdapter = { id: 'jev', version: '1.0.0',
    capabilities: async () => ({ answerKinds: ['choice'], features: ['choice'], maxOptions: null, maxLevels: null, confidenceProfiles: [], executable: true, egress: { mode: 'none' as const } }),
    evaluate: vi.fn(async () => ({ status: 'success' as const, reason: 'none' as const, value: 'documentation', uncertainty: null,
      actualModel: target.model, usage: { inputTokens: 12, outputTokens: 2, costUsd: 0.01 }, requestId: 'remote' })) };
  const receiptStore = new MemoryDecisionReceiptStore();
  const store = new MemoryResultCacheStore();
  const events: string[] = [];
  const callerReceipts: Array<{ callerInvocationId: string; disposition: string }> = [];
  const service = new DecisionResultCache(store, event => events.push(event.event));
  const identityFor: NonNullable<DecisionEvaluationRequest['resultCache']>['identityFor'] = ({ definition: def, target: execution, projectedInput }) => ({
    keyVersion: RESULT_CACHE_KEY_VERSION, definition: artifactPin(def), ruleset: artifactPin(ruleset), binding: artifactPin(binding),
    adapter: { id: execution.adapter, version: execution.adapterVersion }, promptDigest: sha('a'),
    acceptancePolicyDigest: digestCachedResult(execution.acceptance), calibrationDigest: sha('b'), runtimePolicyDigest: sha('c'),
    backend: 'fixture', requestedModel: execution.model, modelCompatibility: { mode: 'pinned', actualModel: execution.model },
    primitive: def.spec.answer.kind, projectedInput, subjectIdentityDigest: sha('d'), projectionPolicyDigest: sha('e'),
    egressPolicyDigest: sha('f'), capabilityMode: 'choice',
  });
  const base: DecisionEvaluationRequest = { ruleset, binding, definitions: { category: definition }, input: fixture('input.json'),
    runId: 'run', invocationId: 'source', adapters: { jev: adapter }, receiptStore, receiptProjectId: 'project',
    policyPin: { id: 'policy', version: '1', digest: sha('c') }, calibrationPin: { id: 'calibration', version: '1', digest: sha('b') },
    resultCache: { service, actor, policy, identityFor, recordCallerReceipt: async receipt => { callerReceipts.push(receipt); } } };
  return { base, adapter, receiptStore, store, events, target, callerReceipts };
}

describe('experimental evaluator result-cache integration', () => {
  it('persists original receipt, returns independently correlated caller receipts and leaves replay unchanged', async () => {
    const { base, adapter, receiptStore } = setup();
    const original = await evaluateDecisionRuleset(base);
    expect(original.spec.status).toBe('completed');
    expect(original.spec.cache).toMatchObject({ disposition: 'cache-miss-fill', callerInvocationId: 'source', providerAttempted: true });
    const hit = await evaluateDecisionRuleset({ ...base, invocationId: 'caller' });
    expect(hit.spec.cache).toMatchObject({ disposition: 'cache-hit', callerInvocationId: 'caller', sourceInvocationId: 'source',
      sourceReceiptId: 'source', providerAttempted: false });
    expect(hit.spec.evaluations.category?.spec.invocationId).toBe('source');
    expect(hit.spec.evaluations.category?.spec.attempts).toEqual(original.spec.evaluations.category?.spec.attempts);
    expect(hit.spec.cache?.originalEvaluatedAtEpochMs).toBe((await receiptStore.read('source', 'project'))?.completedAtEpochMs);
    expect(vi.mocked(adapter.evaluate)).toHaveBeenCalledOnce();
    const replay = await evaluateDecisionRuleset(base);
    expect(replay.spec.cache).toBeUndefined();
    expect(replay).toEqual((await receiptStore.read('source', 'project'))?.result);
    expect((await evaluateDecisionRuleset({ ...base, input: { message: 'changed' } })).spec.reason).toBe('replay-mismatch');
  });

  it('emits a cache span without replaying historical provider usage as new attempt spans', async () => {
    const { base } = setup();
    const spans: DecisionTelemetrySpan[] = [];
    const traced = { ...base, telemetry: { hook: { emit: (span: DecisionTelemetrySpan) => { spans.push(span); } } } };
    await evaluateDecisionRuleset(traced);
    spans.length = 0;
    await evaluateDecisionRuleset({ ...traced, invocationId: 'cached' });
    expect(spans.map(span => span.name)).toContain('decision.cache');
    expect(spans.map(span => span.name)).not.toContain('decision.attempt');
    expect(JSON.stringify(spans)).not.toContain('gen_ai.usage.input_tokens');
  });

  it('misses on changed input and validates every host-provided runtime pin before dispatch', async () => {
    const { base, adapter } = setup();
    await evaluateDecisionRuleset(base);
    const miss = await evaluateDecisionRuleset({ ...base, invocationId: 'changed', input: { message: 'different' } });
    expect(miss.spec.cache?.disposition).toBe('cache-miss-fill');
    expect(vi.mocked(adapter.evaluate)).toHaveBeenCalledTimes(2);
    const identityFor = base.resultCache!.identityFor;
    await expect(evaluateDecisionRuleset({ ...base, invocationId: 'invalid', resultCache: { ...base.resultCache!,
      identityFor: context => ({ ...identityFor(context), calibrationDigest: sha('0') }) } })).rejects.toThrow('identity');
    expect(vi.mocked(adapter.evaluate)).toHaveBeenCalledTimes(2);
  });

  it('rejects byte-distinct non-NFC projected input before a normalized-key lookup', async () => {
    const { base, adapter } = setup();
    await expect(evaluateDecisionRuleset({ ...base, input: { message: 'e\u0301' } })).rejects.toThrow('NFC');
    expect(vi.mocked(adapter.evaluate)).not.toHaveBeenCalled();
  });

  it('revalidates alias registry snapshots on every lookup and bypasses unknown or moved versions', async () => {
    const { base, adapter } = setup();
    const pin = base.resultCache!.identityFor;
    const verify = vi.fn(async () => true);
    const validUntilEpochMs = Date.now() + 100_000;
    const alias = { ...base, resultCache: { ...base.resultCache!,
      identityFor: ((context: Parameters<typeof pin>[0]) => ({ ...pin(context),
        modelCompatibility: { mode: 'alias' as const, alias: context.target.model, snapshotId: 'registry-1',
          approvedActualModels: [context.target.model], validUntilEpochMs } })),
      verifyAliasSnapshot: verify } };
    expect((await evaluateDecisionRuleset(alias)).spec.cache?.disposition).toBe('cache-miss-fill');
    expect((await evaluateDecisionRuleset({ ...alias, invocationId: 'alias-hit' })).spec.cache?.disposition).toBe('cache-hit');
    expect(verify).toHaveBeenCalledTimes(2);
    verify.mockResolvedValue(false);
    expect((await evaluateDecisionRuleset({ ...alias, invocationId: 'registry-unknown' })).spec.cache?.disposition).toBe('bypass');
    expect(vi.mocked(adapter.evaluate)).toHaveBeenCalledTimes(2);
    const moved = { ...alias, invocationId: 'alias-moved', resultCache: { ...alias.resultCache,
      identityFor: ((context: Parameters<typeof pin>[0]) => ({ ...pin(context),
        modelCompatibility: { mode: 'alias' as const, alias: context.target.model, snapshotId: 'registry-2',
          approvedActualModels: ['different-model'], validUntilEpochMs } })),
      verifyAliasSnapshot: async () => true } };
    expect((await evaluateDecisionRuleset(moved)).spec.cache?.disposition).toBe('cache-miss-fill');
    expect((await evaluateDecisionRuleset({ ...moved, invocationId: 'alias-moved-again' })).spec.cache?.disposition).toBe('cache-miss-fill');
    expect(vi.mocked(adapter.evaluate)).toHaveBeenCalledTimes(4);
  });

  it('collapses concurrent distinct invocations and refuses to publish uncertain fills', async () => {
    const { base, adapter, events } = setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalEvaluate = adapter.evaluate;
    adapter.evaluate = vi.fn(async input => { await gate; return originalEvaluate(input); });
    const first = evaluateDecisionRuleset(base);
    const second = evaluateDecisionRuleset({ ...base, invocationId: 'second' });
    release(); const [one, two] = await Promise.all([first, second]);
    expect(one.spec.cache?.callerInvocationId).toBe('source');
    expect(two.spec.cache?.callerInvocationId).toBe('second');
    expect(vi.mocked(adapter.evaluate)).toHaveBeenCalledOnce();
    expect(events).toContain('single-flight');
  });

  it('measures synthetic stable replay savings and TTL refresh without counting hits as provider usage', async () => {
    const { base, adapter } = setup();
    const workload = fixture<{ calls: Array<{ invocationId: string; offsetMs: number; expected: string }>;
      expected: { providerCalls: number; originalInputTokens: number; originalOutputTokens: number;
        counterfactualInputTokens: number; counterfactualOutputTokens: number } }>('../../test/fixtures/decision/result-cache-workload.json');
    const epoch = Date.now();
    const results = [];
    for (const call of workload.calls) {
      const result = await evaluateDecisionRuleset({ ...base, invocationId: call.invocationId, now: () => epoch + call.offsetMs });
      expect(result.spec.cache?.disposition).toBe(call.expected);
      results.push(result);
    }
    const dispatched = results.filter(result => result.spec.cache?.providerAttempted);
    const usage = dispatched.map(result => result.spec.evaluations.category!.spec.attempts[0]!.usage);
    expect(vi.mocked(adapter.evaluate)).toHaveBeenCalledTimes(workload.expected.providerCalls);
    expect(usage.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0)).toBe(workload.expected.originalInputTokens);
    expect(usage.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0)).toBe(workload.expected.originalOutputTokens);
    expect(workload.expected.counterfactualInputTokens - workload.expected.originalInputTokens).toBe(24);
    expect(workload.expected.counterfactualOutputTokens - workload.expected.originalOutputTokens).toBe(4);
  });

  it('does not publish transient or execution-uncertain evaluator results', async () => {
    const { base, adapter, store } = setup();
    adapter.evaluate = vi.fn(async () => ({ status: 'error' as const, reason: 'network-transient' as const,
      uncertainty: null, actualModel: null, usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestId: null }));
    const first = await evaluateDecisionRuleset(base);
    const second = await evaluateDecisionRuleset({ ...base, invocationId: 'retry' });
    expect(first.spec.status).not.toBe('completed');
    expect(second.spec.cache?.disposition).not.toBe('cache-hit');
    expect(vi.mocked(adapter.evaluate)).toHaveBeenCalledTimes(2);
    const identity = base.resultCache!.identityFor({ alias: 'category', definition: base.definitions.category!,
      target: base.binding.spec.evaluations.category!.targets[0]!, projectedInput: base.input as { message: string } });
    expect(await store.export(actor, digestResultCacheIdentity(identity))).toBeNull();
  });

  it('rejects a forged cached result even when an attacker recomputes the entry digest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'result-cache-forged-source-'));
    try {
      const { base, adapter } = setup();
      base.resultCache!.service = new DecisionResultCache(new FileResultCacheStore(dir));
      await evaluateDecisionRuleset(base);
      const file = join(dir, (await readdir(dir)).find(name => name.endsWith('.json'))!);
      const entry = JSON.parse(await readFile(file, 'utf8'));
      entry.evidence.result.spec.outcome = 'runtime-review';
      entry.evidence.resultDigest = digestCachedResult(entry.evidence.result);
      const { integrityDigest: _old, ...unsigned } = entry;
      entry.integrityDigest = entryIntegrityDigest(unsigned);
      await writeFile(file, JSON.stringify(entry));
      await expect(evaluateDecisionRuleset({ ...base, invocationId: 'victim' })).rejects.toThrow('source receipt');
      expect(vi.mocked(adapter.evaluate)).toHaveBeenCalledOnce();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('labels every cache disposition v1alpha2 so spec.cache validates against the result schema', async () => {
    const { base } = setup();
    const fill = await evaluateDecisionRuleset(base);
    const hit = await evaluateDecisionRuleset({ ...base, invocationId: 'hit' });
    const bypass = await evaluateDecisionRuleset({ ...base, invocationId: 'bypass', resultCache: { ...base.resultCache!,
      identityFor: context => ({ ...base.resultCache!.identityFor(context), modelCompatibility: { mode: 'alias' as const,
        alias: context.target.model, snapshotId: 'registry', approvedActualModels: [context.target.model], validUntilEpochMs: Date.now() + 10_000 } }),
      verifyAliasSnapshot: async () => false } });
    expect([fill, hit, bypass].map(result => result.spec.cache?.disposition)).toEqual(['cache-miss-fill', 'cache-hit', 'bypass']);
    for (const result of [fill, hit, bypass]) {
      expect(result.apiVersion).toBe('decision.aiwg.io/v1alpha2');
      expect(Object.values(result.spec.evaluations).every(value => value.apiVersion === result.apiVersion)).toBe(true);
      validateDecisionDocument(result);
      assertDecisionResultWriterVersion(result);
    }
    // The schema binds the hit invariants, not just the shape.
    const forged = structuredClone(hit);
    forged.spec.cache!.providerAttempted = true;
    expect(() => validateDecisionDocument(forged)).toThrow();
  });

  it('refuses to release a legacy v1alpha1 historical entry with a v1alpha2-only caller receipt', async () => {
    const { base, target, callerReceipts, adapter } = setup();
    const { resultCache: _cache, ...plain } = base;
    const legacy = await evaluateDecisionRuleset(plain);
    expect(legacy.apiVersion).toBe('decision.aiwg.io/v1alpha1');
    const source = (await base.receiptStore!.read('source', 'project'))!;
    const identity = base.resultCache!.identityFor({ alias: 'category', definition: base.definitions.category!,
      target: base.binding.spec.evaluations.category!.targets[0]!, projectedInput: base.input as { message: string } });
    const key = digestResultCacheIdentity(identity);
    const unsigned = { schemaVersion: 'decision-result-cache/v1' as const, revision: 1 as const, entryId: 'legacy-entry',
      scope: { tenantId: actor.tenantId, projectId: actor.projectId, workspaceId: actor.workspaceId }, keyDigest: key, identityDigest: key,
      policyVersion: policy.policyVersion, sensitivity: policy.sensitivity, createdAtEpochMs: source.completedAtEpochMs!,
      expiresAtEpochMs: Date.now() + 60_000, evidence: { result: source.result as never, resultDigest: digestCachedResult(source.result),
        sourceInvocationId: 'source', sourceReceiptId: 'source', evaluatedAtEpochMs: source.completedAtEpochMs!, actualModel: target.model,
        uncertainty: null, calibrationStatus: 'pinned', durationMs: 1, usage: { inputTokens: null, outputTokens: null, costUsd: null },
        status: 'success' as const, failureReason: 'none' as const } };
    const fresh = new MemoryResultCacheStore();
    await fresh.putIfAbsent(actor, { ...unsigned, integrityDigest: entryIntegrityDigest(unsigned) });
    base.resultCache!.service = new DecisionResultCache(fresh);
    await expect(evaluateDecisionRuleset({ ...base, invocationId: 'caller' })).rejects.toThrow(/\$\.spec\.cache requires decision\.aiwg\.io\/v1alpha2/);
    expect(callerReceipts).toEqual([]);
    expect(vi.mocked(adapter.evaluate)).toHaveBeenCalledOnce();
  });

  it('records hit throughput in D14 metrics without recounting historical provider usage', async () => {
    const { base } = setup();
    const metrics = new BoundedDecisionMetrics();
    const traced = { ...base, telemetry: { hook: { emit: () => {} }, metrics } };
    await evaluateDecisionRuleset(traced);
    const before = metrics.snapshot().filter(point => point.name === 'decision.input_tokens').length;
    expect(before).toBe(1);
    await evaluateDecisionRuleset({ ...traced, invocationId: 'hit-metrics' });
    const points = metrics.snapshot();
    expect(points.filter(point => point.name === 'decision.throughput')).toHaveLength(2);
    expect(points.filter(point => point.name === 'decision.input_tokens')).toHaveLength(before);
    expect(points.filter(point => point.name === 'decision.attempts')).toHaveLength(1);
  });

  it('reuses only a stable alias from the real CalibrationRegistry and misses or bypasses after promotion, rollback or retirement', async () => {
    const { base, adapter, target } = setup();
    const registry = new CalibrationRegistry();
    const alias = target.model;
    const calibrationIdentity = (actualModel: string): CalibrationIdentity => ({ provider: 'jev', backend: 'fixture', actualModel,
      primitive: 'choice', definitionDigest: sha('a'), adapterVersion: target.adapterVersion, dataset: { id: 'workflow', hash: sha('b') },
      slice: { id: 'all', hash: sha('c') }, calibrator: { id: 'isotonic', version: '1', parametersDigest: sha('d') } });
    const head = () => registry.aliasHistory(alias).at(-1)!;
    // The registry, not the adapter, decides which actual model the alias serves.
    const originalEvaluate = adapter.evaluate;
    adapter.evaluate = vi.fn(async input => ({ ...await originalEvaluate(input), actualModel: head().actualModel }));
    const initial = registry.observeAlias(alias, calibrationIdentity('jev-2026-09-01'), '2026-09-01T00:00:00.000Z');
    const validUntilEpochMs = Date.now() + 100_000;
    const snapshot = (): Extract<ModelCompatibilityPolicy, { mode: 'alias' }> => {
      const current = head();
      return { mode: 'alias', alias, snapshotId: `${alias}@${current.revision}:${current.actualIdentityDigest}`,
        approvedActualModels: current.kind === 'retired' ? [] : [current.actualModel], validUntilEpochMs };
    };
    // Two-stage decision: the identity carries a registry snapshot, and every lookup re-checks it against the live head.
    const verifyAliasSnapshot = vi.fn(async (value: Extract<ModelCompatibilityPolicy, { mode: 'alias' }>) => {
      const current = head();
      return current.kind !== 'retired' && value.snapshotId === `${alias}@${current.revision}:${current.actualIdentityDigest}`
        && value.approvedActualModels.includes(current.actualModel);
    });
    const pinIdentity = base.resultCache!.identityFor;
    const withSnapshot = (take: () => ReturnType<typeof snapshot>) => ({ ...base.resultCache!, verifyAliasSnapshot,
      identityFor: (context: Parameters<typeof pinIdentity>[0]) => ({ ...pinIdentity(context), modelCompatibility: take() }) });
    const live = withSnapshot(snapshot);
    const run = async (invocationId: string, cache = live) => (await evaluateDecisionRuleset({ ...base, invocationId, resultCache: cache })).spec.cache?.disposition;

    expect(await run('fill')).toBe('cache-miss-fill');
    expect(await run('stable')).toBe('cache-hit');
    expect(vi.mocked(adapter.evaluate)).toHaveBeenCalledTimes(1);
    const stale = snapshot();
    const eligibility = registry.recordPromotionEligibility({ id: 'promotion-1', alias,
      candidateIdentityDigest: calibrationIdentityDigest(calibrationIdentity('jev-next')), candidateActualModel: 'jev-next',
      evaluationIntegrityReport: { id: 'eval-1', digest: sha('9') }, approvalReference: 'approval-1',
      rollbackTarget: { aliasRevision: initial.revision, identityDigest: initial.actualIdentityDigest }, eligible: true, reasons: [],
      recordedAt: '2026-09-10T00:00:00.000Z' });
    registry.promoteAlias(eligibility.id, '2026-09-11T00:00:00.000Z');
    // A host still holding the pre-promotion snapshot is refused by the live re-check.
    expect(await run('stale-after-promotion', withSnapshot(() => stale))).toBe('bypass');
    // A fresh snapshot names the new revision, so it is a different key: miss, then reuse.
    expect(await run('promoted')).toBe('cache-miss-fill');
    expect(await run('promoted-stable')).toBe('cache-hit');
    registry.rollbackAlias(alias, initial.revision, 'approval-2', '2026-09-12T00:00:00.000Z');
    // Rolling back to the original model is a new registry revision; the old entry is not resurrected.
    expect(await run('rolled-back')).toBe('cache-miss-fill');
    registry.retireAlias(alias, 'approval-3', '2026-09-13T00:00:00.000Z');
    expect(await run('retired')).toBe('bypass');
    expect(vi.mocked(adapter.evaluate)).toHaveBeenCalledTimes(5);
    expect(registry.aliasHistory(alias).map(event => event.kind)).toEqual(['observed', 'promoted', 'rolled-back', 'retired']);
  });

  it('does not reuse an unverified source receipt even if the cache entry is present', async () => {
    const { base, receiptStore } = setup();
    await evaluateDecisionRuleset(base);
    const fake = { ...base, invocationId: 'other', receiptStore: {
      read: async (invocationId: string, projectId?: string) => invocationId === 'source' ? null : receiptStore.read(invocationId, projectId),
      acquire: receiptStore.acquire.bind(receiptStore), compareAndSwap: receiptStore.compareAndSwap.bind(receiptStore),
      waitForTerminal: receiptStore.waitForTerminal.bind(receiptStore),
    } };
    await expect(evaluateDecisionRuleset(fake)).rejects.toThrow('source receipt');
  });
});
