import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { evaluateDecisionRuleset } from '../../../src/decision/evaluate.js';
import { MemoryDecisionReceiptStore } from '../../../src/decision/receipts.js';
import { DecisionResultCache, FileResultCacheStore, MemoryResultCacheStore, RESULT_CACHE_KEY_VERSION, digestCachedResult, digestResultCacheIdentity, entryIntegrityDigest } from '../../../src/decision/result-cache/index.js';
import { artifactPin } from '../../../src/decision/validate.js';
import type { DecisionAdapter, DecisionBinding, DecisionDefinition, DecisionEvaluationRequest, DecisionRuleset } from '../../../src/decision/types.js';
import type { DecisionTelemetrySpan } from '../../../src/decision/telemetry/types.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
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
    capabilities: async () => ({ answerKinds: ['choice'], features: ['choice'], maxOptions: null, maxLevels: null, confidenceProfiles: [], executable: true }),
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
    const workload = JSON.parse(readFileSync('test/fixtures/decision/result-cache-workload.json', 'utf8')) as { calls: Array<{ invocationId: string; offsetMs: number; expected: string }>;
      expected: { providerCalls: number; originalInputTokens: number; originalOutputTokens: number;
        counterfactualInputTokens: number; counterfactualOutputTokens: number } };
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
