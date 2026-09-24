import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactPin, evaluateDecisionRuleset, executeQualificationPlan, JevDecisionAdapter,
  LlmSubagentDecisionAdapter, MemoryDecisionReceiptStore, verifyQualificationArtifacts,
  type AdapterObservation, type DecisionAdapter, type DecisionAdapterRequest, type DecisionBinding,
  type DecisionDefinition, type DecisionReceiptStore, type DecisionRuleset, type QualificationCaseExecutor,
} from '../../../src/decision/index.js';

const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(`examples/decision/${name}`, 'utf8')) as T;
const definitions = async () => ({ category: await fixture<DecisionDefinition>('decision-category.json'),
  severity: await fixture<DecisionDefinition>('decision-severity.json'), core: await fixture<DecisionDefinition>('decision-core_unavailable.json') });
let calls = 0;
const worker: DecisionAdapter = {
  id: 'jev', version: '1.0.0', capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'],
    features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10,
    confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true }),
  evaluate: async request => {
    calls++;
    const observation: AdapterObservation = { status: 'success', reason: 'none',
      value: request.alias === 'category' ? 'documentation' : request.alias === 'severity' ? 0.25 : 0.05,
      uncertainty: { source: 'provider', profile: request.alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1',
        calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
      actualModel: 'fixture', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: null };
    return observation;
  },
};
async function base(receiptStore: DecisionReceiptStore, invocationId: string) {
  return { ruleset: await fixture<DecisionRuleset>('ruleset.json'), binding: await fixture<DecisionBinding>('binding-jev.json'),
    definitions: await definitions(), input: await fixture('input.json'), runId: 'state-vectors', invocationId,
    adapters: { jev: worker }, receiptStore };
}
const ids = ['C24', 'C25', 'C26', 'C27', 'C28', 'C37', 'C38', 'C42'] as const;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); calls = 0; });

const executors: Record<(typeof ids)[number], QualificationCaseExecutor> = {
  C24: async () => {
    const binding = await fixture<DecisionBinding>('binding-jev.json');
    const aborted = new AbortController(); aborted.abort();
    let fetchCalls = 0;
    const request: DecisionAdapterRequest = {
      alias: 'category', definition: await fixture('decision-category.json'), input: await fixture('input.json'),
      target: binding.spec.evaluations.category!.targets[0]!, invocationId: 'cancelled',
      deadlineEpochMs: Date.now() + 10_000, signal: aborted.signal,
      resolveCredential: async () => new TextEncoder().encode('synthetic-credential'),
    };
    const result = await new JevDecisionAdapter({ fetch: async () => { fetchCalls++; return new Response('{}'); } }).evaluate(request);
    assert.equal(result.reason, 'cancelled'); assert.equal(result.dispatchCertainty, 'not-sent'); assert.equal(fetchCalls, 0);
    return { outcome: 'pass' };
  },
  C25: async () => {
    const definition = await fixture<DecisionDefinition>('decision-category.json');
    const source = await fixture<DecisionBinding>('binding-llm-subagent.json');
    const workerDoc = await fixture<{ metadata: { id: string; version: string } }>('worker-fixture.json');
    const target = { ...source.spec.evaluations.category!.targets[0]!, subagent: artifactPin(workerDoc) };
    const request: DecisionAdapterRequest = { alias: 'category', definition, input: await fixture('input.json'), target,
      invocationId: 'worker-unavailable', deadlineEpochMs: Date.now() + 10_000,
      signal: new AbortController().signal, resolveCredential: async () => new Uint8Array() };
    const adapter = new LlmSubagentDecisionAdapter({ resolveWorker: async () => workerDoc as never,
      runWorker: async () => ({ started: false, terminal: false }) });
    const result = await adapter.evaluate(request);
    assert.equal(result.reason, 'executor-unavailable'); assert.equal(result.status, 'error');
    return { outcome: 'pass' };
  },
  C26: async () => {
    const definition = await fixture<DecisionDefinition>('decision-category.json');
    const source = await fixture<DecisionBinding>('binding-llm-subagent.json');
    const workerDoc = await fixture<{ metadata: { id: string; version: string } }>('worker-fixture.json');
    const target = { ...source.spec.evaluations.category!.targets[0]!, subagent: artifactPin(workerDoc) };
    const request: DecisionAdapterRequest = { alias: 'category', definition, input: await fixture('input.json'), target,
      invocationId: 'worker-prose', deadlineEpochMs: Date.now() + 10_000,
      signal: new AbortController().signal, resolveCredential: async () => new Uint8Array() };
    for (const output of ['```json\n{}\n```', 'The answer is documentation']) {
      const adapter = new LlmSubagentDecisionAdapter({ resolveWorker: async () => workerDoc as never,
        runWorker: async () => ({ started: true, terminal: true, output }) });
      assert.equal((await adapter.evaluate(request)).reason, 'invalid-output');
    }
    return { outcome: 'pass' };
  },
  C27: async () => {
    const store = new MemoryDecisionReceiptStore();
    const request = await base(store, 'identical-replay');
    const first = await evaluateDecisionRuleset(request);
    const initialCalls = calls;
    const replay = await evaluateDecisionRuleset(request);
    assert.equal(first.spec.status, 'completed'); assert.deepEqual(replay, first);
    assert.equal(calls, initialCalls);
    return { outcome: 'pass' };
  },
  C28: async () => {
    const delegate = new MemoryDecisionReceiptStore();
    const broken: DecisionReceiptStore = {
      read: delegate.read.bind(delegate), acquire: delegate.acquire.bind(delegate),
      waitForTerminal: delegate.waitForTerminal.bind(delegate),
      compareAndSwap: async (id, project, revision, next) => next.state === 'completed'
        ? Promise.reject(new Error('synthetic persistence failure')) : delegate.compareAndSwap(id, project, revision, next),
    };
    const request = await base(broken, 'atomic-persistence-failure');
    const result = await evaluateDecisionRuleset(request);
    assert.equal(result.spec.reason, 'persistence-error'); assert.equal(result.spec.outcome, undefined);
    return { outcome: 'pass' };
  },
  C37: async () => {
    const request = await base(new MemoryDecisionReceiptStore(), 'changed-input');
    assert.equal((await evaluateDecisionRuleset(request)).spec.status, 'completed');
    const before = calls;
    const mismatch = await evaluateDecisionRuleset({ ...request, input: { message: 'changed' } });
    assert.equal(mismatch.spec.reason, 'replay-mismatch'); assert.equal(calls, before);
    return { outcome: 'pass' };
  },
  C38: async () => {
    const request = await base(new MemoryDecisionReceiptStore(), 'changed-binding');
    assert.equal((await evaluateDecisionRuleset(request)).spec.status, 'completed');
    const before = calls;
    const binding = structuredClone(request.binding);
    binding.metadata.version = '1.0.1';
    const mismatch = await evaluateDecisionRuleset({ ...request, binding });
    assert.equal(mismatch.spec.reason, 'replay-mismatch'); assert.equal(calls, before);
    return { outcome: 'pass' };
  },
  C42: async () => {
    const store = new MemoryDecisionReceiptStore();
    const request = await base(store, 'uncertain-restart');
    const interrupted: DecisionReceiptStore = {
      read: store.read.bind(store), acquire: store.acquire.bind(store), waitForTerminal: store.waitForTerminal.bind(store),
      compareAndSwap: async (id, project, revision, next) => {
        const saved = await store.compareAndSwap(id, project, revision, next);
        if (next.state === 'dispatched') throw new Error('synthetic crash');
        return saved;
      },
    };
    assert.equal((await evaluateDecisionRuleset({ ...request, receiptStore: interrupted })).spec.reason, 'persistence-error');
    const restarted: DecisionReceiptStore = {
      read: store.read.bind(store), acquire: store.acquire.bind(store), compareAndSwap: store.compareAndSwap.bind(store),
      waitForTerminal: async () => { throw new Error('owner unavailable'); },
    };
    const before = calls;
    const result = await evaluateDecisionRuleset({ ...request, receiptStore: restarted });
    assert.equal(result.spec.reason, 'execution-uncertain'); assert.equal(calls, before);
    return { outcome: 'pass' };
  },
};

describe('C24-C28/C37-C38/C42 executable offline state vectors', () => {
  it('asserts cancellation, worker terminal contract and receipt replay/persistence outcomes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'decision-state-vectors-')); roots.push(root);
    const run = await executeQualificationPlan({ artifactRoot: root, executors, concurrency: 1,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'state-vectors',
        generatedAt: '2026-09-23T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true,
        cases: ids.map(id => ({ id, kind: 'baseline' as const, mandatory: true,
          candidateTests: ['test/conformance/decision-v1/state-vectors.test.ts'] })) },
    });
    expect(run.evidence.map(item => [item.caseId, item.outcome])).toEqual(ids.map(id => [id, 'pass']));
    expect((await verifyQualificationArtifacts(run, root)).every(item => item.verified)).toBe(true);
  });
});
