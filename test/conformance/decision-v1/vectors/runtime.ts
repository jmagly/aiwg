import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  evaluateDecisionRuleset, JevDecisionAdapter, type AdapterObservation, type DecisionAdapter,
  type DecisionAdapterRequest, type DecisionBinding, type DecisionDefinition, type DecisionRuleset,
  type QualificationCaseExecutor,
} from '../../../../src/decision/index.js';

const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
const definitions = async (): Promise<Record<string, DecisionDefinition>> => ({
  category: await fixture('decision-category.json'), severity: await fixture('decision-severity.json'),
  core: await fixture('decision-core_unavailable.json'),
});
const success = (value: string | number): AdapterObservation => ({
  status: 'success', reason: 'none', value, actualModel: 'fixture', requestId: 'synthetic-request',
  usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
  uncertainty: { source: 'provider', profile: 'typesafe-distribution-v1', calibration: 'vendor-claimed',
    confidence: 0.9, distribution: null, calibrationRef: null },
});
const values = (alias: string) => success(alias === 'category' ? 'documentation' : alias === 'severity' ? 0.25 : 0.05);
function adapter(observe: (alias: string) => AdapterObservation, id: 'jev' | 'llm-subagent' = 'jev'): DecisionAdapter {
  return { id, version: '1.0.0', capabilities: async () => ({
    answerKinds: ['choice', 'ordinal-score', 'truth-probability'], features: ['choice', 'ordinal-score', 'truth-probability'],
    maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true, egress: { mode: 'none' as const },
  }), evaluate: async request => observe(request.alias) };
}
async function evaluate(
  binding: DecisionBinding, adapters: Record<string, DecisionAdapter>, invocationId: string,
  input?: unknown,
) {
  return evaluateDecisionRuleset({ ruleset: await fixture<DecisionRuleset>('ruleset.json'), binding,
    definitions: await definitions(), input: input === undefined ? await fixture('input.json') : input, runId: 'runtime-vectors',
    invocationId, adapters, delay: async () => undefined });
}
export const CASE_IDS = ['C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17', 'C18'] as const;

export const executors: Record<(typeof CASE_IDS)[number], QualificationCaseExecutor> = {
  C11: async () => {
    const a = adapter(values); let calls = 0;
    a.capabilities = async () => ({ answerKinds: ['ordinal-score'], features: ['ordinal-score'],
      maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1'], executable: true, egress: { mode: 'none' as const } });
    a.evaluate = async request => { if (request.alias === 'category') calls++; return values(request.alias); };
    const result = await evaluate(await fixture('binding-jev.json'), { jev: a }, 'unsupported');
    assert.equal(result.spec.evaluations.category?.spec.reason, 'unsupported-capability');
    assert.equal(calls, 0);
    return { outcome: 'pass' };
  },
  C12: async () => {
    const a = adapter(values);
    let calls = 0;
    a.evaluate = async request => { calls++; return values(request.alias); };
    const invalid = await evaluate(await fixture('binding-jev.json'), { jev: a }, 'missing-input', {});
    assert.equal(invalid.spec.reason, 'invalid-input');
    const binding = await fixture<DecisionBinding>('binding-jev.json');
    binding.spec.ruleset.digest = `sha256:${'0'.repeat(64)}`;
    const mismatch = await evaluate(binding, { jev: a }, 'digest-mismatch');
    assert.equal(mismatch.spec.reason, 'digest-mismatch');
    assert.equal(calls, 0);
    return { outcome: 'pass' };
  },
  C13: async () => {
    const binding = await fixture<DecisionBinding>('binding-jev.json');
    binding.spec.evaluations.category!.targets[0]!.retry.maxRetries = 0;
    let calls = 0;
    const result = await evaluate(binding, { jev: adapter(alias => {
      if (alias === 'category') { calls++; return { ...success('documentation'), status: 'error', reason: 'timeout' }; }
      return values(alias);
    }) }, 'timeout-budget');
    assert.equal(result.spec.evaluations.category?.spec.reason, 'timeout');
    assert.equal(result.spec.evaluations.category?.spec.attempts.length, 1);
    assert.equal(calls, 1);
    return { outcome: 'pass' };
  },
  C14: async () => {
    for (const reason of ['rate-limited', 'overloaded'] as const) {
      const binding = await fixture<DecisionBinding>('binding-jev.json');
      binding.spec.maxAttempts = 4;
      binding.spec.evaluations.category!.targets[0]!.retry.maxRetries = 1;
      let calls = 0;
      const result = await evaluate(binding, { jev: adapter(alias => {
        if (alias !== 'category') return values(alias);
        return ++calls === 1 ? { ...success('documentation'), status: 'error', reason } : success('documentation');
      }) }, `retry-${reason}`);
      assert.equal(calls, 2);
      assert.deepEqual(result.spec.evaluations.category?.spec.attempts.map(attempt => attempt.reason), [reason, 'none']);
    }
    return { outcome: 'pass' };
  },
  C15: async () => {
    const binding = await fixture<DecisionBinding>('binding-jev.json');
    const definition = await fixture<DecisionDefinition>('decision-category.json');
    for (const status of [401, 422]) {
      let calls = 0;
      const request: DecisionAdapterRequest = {
        alias: 'category', definition, input: await fixture('input.json'),
        target: binding.spec.evaluations.category!.targets[0]!, invocationId: `status-${status}`,
        deadlineEpochMs: Date.now() + 10_000, signal: new AbortController().signal,
        resolveCredential: async () => new TextEncoder().encode('synthetic-credential'),
      };
      const observed = await new JevDecisionAdapter({ fetch: async () => { calls++; return new Response('{}', { status }); } }).evaluate(request);
      assert.equal(calls, 1);
      assert.equal(observed.reason, status === 401 ? 'authentication' : 'invalid-request');
    }
    return { outcome: 'pass' };
  },
  C16: async () => {
    const result = await evaluate(await fixture('binding-fallback.json'), {
      jev: adapter(alias => alias === 'category' ? { ...success('documentation'), status: 'error', reason: 'service-error' } : values(alias)),
      'llm-subagent': adapter(values, 'llm-subagent'),
    }, 'declared-fallback');
    assert.equal(result.spec.status, 'completed');
    assert.deepEqual(result.spec.evaluations.category?.spec.attempts.map(attempt => attempt.adapter), ['jev', 'llm-subagent']);
    return { outcome: 'pass' };
  },
  C17: async () => {
    const result = await evaluate(await fixture('binding-jev.json'), {
      jev: adapter(alias => alias === 'category' ? { ...success('documentation'), status: 'error', reason: 'service-error' } : values(alias)),
      'llm-subagent': adapter(values, 'llm-subagent'),
    }, 'undeclared-fallback');
    assert.notEqual(result.spec.evaluations.category?.spec.status, 'success');
    assert.deepEqual(result.spec.evaluations.category?.spec.attempts.map(attempt => attempt.adapter), ['jev']);
    return { outcome: 'pass' };
  },
  C18: async () => {
    const binding = await fixture<DecisionBinding>('binding-fallback.json');
    binding.spec.maxAttempts = 1;
    let calls = 0;
    const result = await evaluate(binding, {
      jev: adapter(alias => { calls++; return alias === 'category'
        ? { ...success('documentation'), status: 'error', reason: 'service-error' } : values(alias); }),
      'llm-subagent': adapter(alias => { calls++; return values(alias); }, 'llm-subagent'),
    }, 'fallback-budget');
    assert.equal(calls, 1);
    assert.equal(result.spec.evaluations.category?.spec.attempts.length, 1);
    return { outcome: 'pass' };
  },
};
