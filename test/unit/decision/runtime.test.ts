import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  artifactDigest,
  artifactPin,
  composeRuleset,
  evaluateDecisionRuleset,
  evaluatePredicate,
  JevDecisionAdapter,
  LlmSubagentDecisionAdapter,
  MemoryDecisionReceiptStore,
  validateBinding,
  validateDecisionDocument,
  validateDefinition,
  validateRuleset,
  type AdapterObservation,
  type DecisionAdapter,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionResult,
  type DecisionRuleset,
} from '../../../src/decision/index.js';
import { parseDecisionDoc } from '../../../src/artifacts/index-builder.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`examples/decision/${name}`, 'utf8')) as T;
const definitions = (): Record<string, DecisionDefinition> => ({
  category: fixture('decision-category.json'),
  severity: fixture('decision-severity.json'),
  core: fixture('decision-core_unavailable.json'),
});

const success = (value: string | number, profile = 'typesafe-distribution-v1'): AdapterObservation => ({
  status: 'success', reason: 'none', value,
  uncertainty: { source: 'provider', profile, calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
  actualModel: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: 'fixture-request',
});

class FixtureAdapter implements DecisionAdapter {
  readonly version = '1.0.0';
  constructor(readonly id: 'jev' | 'llm-subagent', private readonly observe: (alias: string) => AdapterObservation) {}
  async capabilities() {
    return {
      answerKinds: ['choice', 'ordinal-score', 'truth-probability'] as const,
      features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10,
      confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1', 'llm-self-report-v1'], executable: true,
    };
  }
  async evaluate(request: Parameters<DecisionAdapter['evaluate']>[0]) { return this.observe(request.alias); }
}

function values(alias: string): AdapterObservation {
  if (alias === 'category') return success('documentation');
  if (alias === 'severity') return success(0.25);
  return success(0.05, 'typesafe-truth-v1');
}

function decisionResult(alias: string, value: string | number): DecisionResult {
  const definition = definitions()[alias === 'core_unavailable' ? 'core' : alias]!;
  const ruleset = fixture<DecisionRuleset>('ruleset.json');
  return {
    apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionResult',
    metadata: { id: alias, version: '1.0.0', description: alias },
    spec: {
      decision: artifactPin(definition), ruleset: artifactPin(ruleset), binding: artifactPin(fixture('binding-jev.json')),
      alias, runId: 'run', invocationId: 'invocation', status: 'success', value, reason: 'none', uncertainty: null,
      attempts: [{ ordinal: 1, adapter: 'fixture', adapterVersion: '1', requestedModel: 'fixture', actualModel: 'fixture', subagent: null, status: 'success', reason: 'none', durationMs: 0, usage: { inputTokens: 0, outputTokens: 0, costUsd: null }, requestId: null }],
    },
  };
}

describe('normalized decision contracts', () => {
  it('validates reviewed definitions, rulesets, bindings, and their pins', () => {
    const ruleset = fixture<DecisionRuleset>('ruleset.json');
    Object.values(definitions()).forEach(validateDefinition);
    validateRuleset(ruleset);
    validateBinding(fixture('binding-jev.json'), ruleset);
    expect(artifactDigest(ruleset)).toBe(fixture<DecisionBinding>('binding-jev.json').spec.ruleset.digest);
    for (const name of [
      'result-category.json', 'result-severity.json', 'result-core_unavailable.json', 'ruleset-result.json',
      'llm-result-category.json', 'llm-result-severity.json', 'llm-result-core_unavailable.json', 'llm-ruleset-result.json',
    ]) validateDecisionDocument(fixture(name));
  });

  it('rejects unknown authoring fields and remote schema references', () => {
    const definition = { ...definitions().category, unexpected: true };
    expect(() => validateDecisionDocument(definition)).toThrow(/additional properties/i);
    const remote = structuredClone(definitions().category);
    remote.spec.inputSchema = { $ref: 'https://example.invalid/schema.json' };
    expect(() => validateDefinition(remote)).toThrow(/non-local/);
  });

  it('classifies authored decision artifacts for discovery', () => {
    const source = readFileSync('examples/decision/decision-category.json', 'utf8');
    expect(parseDecisionDoc(source, 'decisions/category.json')).toMatchObject({
      type: 'decision-definition', kind: 'DecisionDefinition', name: 'example-category',
    });
    expect(parseDecisionDoc('{"kind":"DecisionDefinition"}', 'decisions/broken.json')).toBeNull();
  });

  it('uses three-valued predicates without coercion', () => {
    expect(evaluatePredicate({ op: 'eq', left: { source: 'input', pointer: '/missing' }, right: 1 }, {}, {})).toBe('unknown');
    expect(evaluatePredicate({ all: [
      { op: 'eq', left: { source: 'input', pointer: '/missing' }, right: 1 },
      { op: 'eq', left: { source: 'input', pointer: '/flag' }, right: false },
    ] }, { flag: true }, {})).toBe(false);
    expect(evaluatePredicate({ op: 'eq', left: { source: 'input', pointer: '/value' }, right: 1 }, { value: '1' }, {})).toBe(false);
  });

  it('deduplicates equal top outcomes and applies explicit conflict review', () => {
    const ruleset = fixture<DecisionRuleset>('ruleset.json');
    ruleset.spec.rules = [
      { id: 'a', priority: 10, when: { op: 'exists', left: { source: 'input', pointer: '' } }, outcome: 'docs-review' },
      { id: 'b', priority: 10, when: { op: 'exists', left: { source: 'input', pointer: '' } }, outcome: 'docs-review' },
    ];
    const equal = composeRuleset(ruleset, {}, {});
    expect(equal).toMatchObject({ status: 'completed', outcome: 'docs-review', matchedRules: ['a', 'b'] });
    ruleset.spec.rules[1]!.outcome = 'runtime-review';
    expect(composeRuleset(ruleset, {}, {})).toMatchObject({ status: 'review', reason: 'conflicting-outcomes', outcome: 'manual-review' });
  });

  it('sorts collect outcomes deterministically and validates the final array', () => {
    const ruleset = fixture<DecisionRuleset>('ruleset-collect.json');
    const result = composeRuleset(ruleset, fixture('input.json'), {
      category: decisionResult('category', 'documentation'),
      severity: decisionResult('severity', 0.25),
      core_unavailable: decisionResult('core_unavailable', 0.05),
    });
    expect(result.status).toBe('completed');
    expect(result.matchedRules).toEqual([...result.matchedRules].sort((a, b) => a.localeCompare(b)));
  });
});

describe('shared evaluator', () => {
  it('executes independently under the minimum ceiling and serializes results canonically', async () => {
    const binding = fixture<DecisionBinding>('binding-jev.json');
    binding.spec.concurrency = 4;
    let active = 0;
    let maximum = 0;
    const completion: string[] = [];
    const adapter: DecisionAdapter = {
      id: 'jev', version: '1.0.0',
      capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'],
        features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10,
        confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true }),
      evaluate: async request => {
        active += 1;
        maximum = Math.max(maximum, active);
        const delays: Record<string, number> = { category: 20, severity: 10, core_unavailable: 1 };
        await new Promise(resolve => setTimeout(resolve, delays[request.alias] ?? 1));
        active -= 1;
        completion.push(request.alias);
        return values(request.alias);
      },
    };
    const sharedLimits = { concurrency: 3, maxQueueLength: 8, maxQueueWaitMs: 1_000 };
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof evaluateDecisionRuleset>>;
    try {
      const running = evaluateDecisionRuleset({
        ruleset: fixture('ruleset.json'), binding, definitions: definitions(), input: fixture('input.json'),
        runId: 'run', invocationId: 'concurrent', adapters: { jev: adapter },
        scheduler: { enabled: true, profileVersion: 'offline-v1', callerConcurrency: 2, graphConcurrency: 3,
          workspace: { id: 'workspace', limits: sharedLimits }, principal: { id: 'principal', limits: sharedLimits },
          providers: { jev: sharedLimits } },
      });
      // Advance past the longest adapter delay only; binding timeouts stay pending and are cleared.
      await vi.advanceTimersByTimeAsync(25);
      result = await running;
    } finally {
      vi.useRealTimers();
    }
    expect(maximum).toBe(2);
    expect(completion[0]).not.toBe('category');
    expect(Object.keys(result.spec.evaluations)).toEqual(['category', 'severity', 'core_unavailable']);
    expect(result.spec.evaluations.category?.spec.attempts[0]?.admission).toMatchObject({ decision: 'admit', reason: 'admitted' });
  });

  it('preserves one global attempt budget under concurrent evaluation', async () => {
    const binding = fixture<DecisionBinding>('binding-jev.json');
    binding.spec.concurrency = 3;
    binding.spec.maxAttempts = 2;
    let calls = 0;
    const adapter = new FixtureAdapter('jev', alias => { calls += 1; return values(alias); });
    const sharedLimits = { concurrency: 3, maxQueueLength: 8, maxQueueWaitMs: 1_000 };
    const result = await evaluateDecisionRuleset({
      ruleset: fixture('ruleset.json'), binding, definitions: definitions(), input: fixture('input.json'),
      runId: 'run', invocationId: 'attempt-budget', adapters: { jev: adapter },
      scheduler: { enabled: true, profileVersion: 'offline-v1', callerConcurrency: 3,
        workspace: { id: 'workspace', limits: sharedLimits }, principal: { id: 'principal', limits: sharedLimits },
        providers: { jev: sharedLimits } },
    });
    expect(calls).toBe(2);
    expect(Object.values(result.spec.evaluations).reduce((sum, evaluation) => sum + evaluation.spec.attempts.length, 0)).toBe(2);
    expect(Object.values(result.spec.evaluations).some(evaluation => evaluation.spec.reason === 'budget-exhausted')).toBe(true);
  });

  it('switches Jev and subagent backends by binding only', async () => {
    const common = {
      ruleset: fixture<DecisionRuleset>('ruleset.json'), definitions: definitions(), input: fixture('input.json'),
      runId: 'run', adapters: {
        jev: new FixtureAdapter('jev', values),
        'llm-subagent': new FixtureAdapter('llm-subagent', values),
      },
    };
    const jev = await evaluateDecisionRuleset({ ...common, binding: fixture('binding-jev.json'), invocationId: 'jev-run' });
    const llm = await evaluateDecisionRuleset({ ...common, binding: fixture('binding-llm-subagent.json'), invocationId: 'llm-run' });
    expect(jev.spec).toMatchObject({ status: 'completed', outcome: 'docs-review' });
    expect(llm.spec).toMatchObject({ status: 'completed', outcome: 'docs-review' });
    expect(jev.spec.ruleset).toEqual(llm.spec.ruleset);
    expect(jev.spec.evaluations.category?.spec.attempts[0]?.adapter).toBe('jev');
    expect(llm.spec.evaluations.category?.spec.attempts[0]?.adapter).toBe('llm-subagent');
  });

  it('uses only declared fallback reasons and preserves attempt lineage', async () => {
    const binding = fixture<DecisionBinding>('binding-fallback.json');
    const result = await evaluateDecisionRuleset({
      ruleset: fixture('ruleset.json'), binding, definitions: definitions(), input: fixture('input.json'),
      runId: 'run', invocationId: 'fallback',
      adapters: {
        jev: new FixtureAdapter('jev', () => ({ ...success(0), status: 'error', reason: 'service-error' })),
        'llm-subagent': new FixtureAdapter('llm-subagent', values),
      },
      delay: async () => undefined,
    });
    expect(result.spec.status).toBe('completed');
    expect(result.spec.evaluations.category?.spec.attempts.map(attempt => attempt.adapter)).toEqual(['jev', 'llm-subagent']);
  });

  it('rejects incompatible confidence and capabilities before credential resolution', async () => {
    const binding = fixture<DecisionBinding>('binding-jev.json');
    binding.spec.evaluations.category!.targets[0]!.acceptance = { mode: 'confidence-threshold', profile: 'unknown-profile', minimumBps: 5000 };
    const credentials = vi.fn(async () => new Uint8Array());
    const result = await evaluateDecisionRuleset({
      ruleset: fixture('ruleset.json'), binding, definitions: definitions(), input: fixture('input.json'),
      runId: 'run', invocationId: 'capability', adapters: { jev: new FixtureAdapter('jev', values) }, resolveCredential: credentials,
    });
    expect(result.spec.status).toBe('review');
    expect(result.spec.evaluations.category?.spec.reason).toBe('confidence-profile-mismatch');
    expect(credentials).not.toHaveBeenCalled();
  });

  it('rejects unsupported answer capabilities before adapter execution', async () => {
    const adapter = new FixtureAdapter('jev', values);
    adapter.capabilities = async () => ({
      answerKinds: ['ordinal-score'] as const,
      features: ['ordinal-score'], maxOptions: 255, maxLevels: 10,
      confidenceProfiles: ['typesafe-distribution-v1'], executable: true,
    });
    adapter.evaluate = vi.fn(adapter.evaluate.bind(adapter));
    const result = await evaluateDecisionRuleset({
      ruleset: fixture('ruleset.json'), binding: fixture('binding-jev.json'), definitions: definitions(),
      input: fixture('input.json'), runId: 'run', invocationId: 'unsupported', adapters: { jev: adapter },
    });
    expect(result.spec.evaluations.category?.spec).toMatchObject({ status: 'unsupported', reason: 'unsupported-capability' });
    expect(vi.mocked(adapter.evaluate).mock.calls.some(([request]) => request.alias === 'category')).toBe(false);
  });

  it.each([
    { confidence: null, reason: 'missing-confidence' },
    { confidence: 0.4, reason: 'low-confidence' },
  ])('abstains on $reason under threshold acceptance', async ({ confidence, reason }) => {
    const ruleset = fixture<DecisionRuleset>('ruleset.json');
    const binding = fixture<DecisionBinding>('binding-jev.json');
    binding.spec.evaluations.category!.targets[0]!.acceptance = {
      mode: 'confidence-threshold', profile: 'typesafe-distribution-v1', minimumBps: 8000,
    };
    const result = await evaluateDecisionRuleset({
      ruleset, binding, definitions: definitions(), input: fixture('input.json'), runId: 'run', invocationId: `threshold-${reason}`,
      adapters: { jev: new FixtureAdapter('jev', alias => alias === 'category'
        ? { ...success('documentation'), uncertainty: { ...success('documentation').uncertainty!, confidence } }
        : values(alias)) },
    });
    expect(result.spec.evaluations.category?.spec).toMatchObject({ status: 'abstained', reason });
    expect(result.spec).toMatchObject({ status: 'review', outcome: 'manual-review' });
  });

  it('retries only bounded transport failures', async () => {
    const ruleset = fixture<DecisionRuleset>('ruleset.json');
    const binding = fixture<DecisionBinding>('binding-jev.json');
    binding.spec.maxAttempts = 4;
    binding.spec.evaluations.category!.targets[0]!.retry.maxRetries = 1;
    let categoryCalls = 0;
    const result = await evaluateDecisionRuleset({
      ruleset, binding, definitions: definitions(), input: fixture('input.json'), runId: 'run', invocationId: 'retry',
      adapters: { jev: new FixtureAdapter('jev', alias => {
        if (alias !== 'category') return values(alias);
        categoryCalls += 1;
        return categoryCalls === 1 ? { ...success('documentation'), status: 'error', reason: 'rate-limited' } : success('documentation');
      }) },
      delay: async () => undefined,
    });
    expect(result.spec.status).toBe('completed');
    expect(categoryCalls).toBe(2);
    expect(result.spec.evaluations.category?.spec.attempts.map(attempt => attempt.reason)).toEqual(['rate-limited', 'none']);
  });

  it('enforces target timeout when an adapter ignores cancellation', async () => {
    const binding = fixture<DecisionBinding>('binding-jev.json');
    binding.spec.maxAttempts = 1;
    binding.spec.evaluations.category!.targets[0]!.timeoutMs = 5;
    const stalled = new FixtureAdapter('jev', values);
    stalled.evaluate = async () => new Promise<AdapterObservation>(() => undefined);
    const result = await evaluateDecisionRuleset({
      ruleset: fixture('ruleset.json'), binding, definitions: definitions(), input: fixture('input.json'),
      runId: 'run', invocationId: 'timeout', adapters: { jev: stalled },
    });
    expect(result.spec.evaluations.category?.spec).toMatchObject({ status: 'error', reason: 'timeout' });
    expect(result.spec.evaluations.category?.spec.attempts).toHaveLength(1);
    expect(result.spec).toMatchObject({ status: 'review', outcome: 'manual-review' });
  });

  it('reuses exact receipts and rejects changed-input replay', async () => {
    const store = new MemoryDecisionReceiptStore();
    const adapter = new FixtureAdapter('jev', vi.fn(values));
    const base = {
      ruleset: fixture<DecisionRuleset>('ruleset.json'), binding: fixture<DecisionBinding>('binding-jev.json'), definitions: definitions(),
      input: fixture('input.json'), runId: 'run', invocationId: 'replay', adapters: { jev: adapter }, receiptStore: store,
    };
    const first = await evaluateDecisionRuleset(base);
    const second = await evaluateDecisionRuleset(base);
    expect(second).toEqual(first);
    const mismatch = await evaluateDecisionRuleset({ ...base, input: { message: 'changed' } });
    expect(mismatch.spec.reason).toBe('replay-mismatch');
  });
});

describe('adapters', () => {
  it('maps and validates a Jev Choice without exposing credentials', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(String(init?.headers && (init.headers as Record<string, string>).authorization)).toContain('secret');
      const sent = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      expect(Object.keys(sent.questions)).toEqual(['category']);
      return new Response(JSON.stringify({
        model: 'jev-1.13.0', answers: { category: { type: 'choice', choice: 'documentation', confidence: 0.9, probabilities: { documentation: 0.9, runtime: 0.1, other: 0 } } },
        usage: { input_tokens: 4, output_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const target = fixture<DecisionBinding>('binding-jev.json').spec.evaluations.category!.targets[0]!;
    const result = await new JevDecisionAdapter({ fetch: fetchMock as typeof fetch }).evaluate({
      alias: 'category', definition: definitions().category, input: fixture('input.json'), target,
      invocationId: 'jev', deadlineEpochMs: Date.now() + 1000, signal: new AbortController().signal,
      resolveCredential: async () => new TextEncoder().encode('secret'),
    });
    expect(result).toMatchObject({ status: 'success', value: 'documentation', actualModel: 'jev-1.13.0' });
  });

  it('rejects malformed Jev domains and maps non-retriable HTTP errors', async () => {
    const target = fixture<DecisionBinding>('binding-jev.json').spec.evaluations.category!.targets[0]!;
    const request = {
      alias: 'category', definition: definitions().category, input: fixture('input.json'), target,
      invocationId: 'jev-invalid', deadlineEpochMs: Date.now() + 1000, signal: new AbortController().signal,
      resolveCredential: async () => new TextEncoder().encode('secret'),
    };
    const malformed = new JevDecisionAdapter({ fetch: async () => new Response(JSON.stringify({
      model: 'jev-1.13.0', answers: { category: { type: 'choice', choice: 'unknown', confidence: 0.5, probabilities: { documentation: 0.5, runtime: 0.5, other: 0 } } }, usage: {},
    }), { status: 200 }) });
    expect((await malformed.evaluate(request)).reason).toBe('invalid-output');
    const authentication = new JevDecisionAdapter({ fetch: async () => new Response('{}', { status: 401 }) });
    expect((await authentication.evaluate(request)).reason).toBe('authentication');
  });

  it('requires actual terminal subagent output and rejects prose', async () => {
    const worker = fixture<Record<string, unknown>>('worker-fixture.json');
    const pin = artifactPin(worker as { metadata: { id: string; version: string } });
    const target = { ...fixture<DecisionBinding>('binding-llm-subagent.json').spec.evaluations.category!.targets[0]!, subagent: pin };
    const planOnly = new LlmSubagentDecisionAdapter({ resolveWorker: async () => worker as never, runWorker: async () => ({ started: false, terminal: false }) });
    const prose = new LlmSubagentDecisionAdapter({ resolveWorker: async () => worker as never, runWorker: async () => ({ started: true, terminal: true, output: '```json\n{}\n```' }) });
    const request = {
      alias: 'category', definition: definitions().category, input: fixture('input.json'), target,
      invocationId: 'worker', deadlineEpochMs: Date.now() + 1000, signal: new AbortController().signal,
      resolveCredential: async () => new Uint8Array(),
    };
    expect((await planOnly.evaluate(request)).reason).toBe('executor-unavailable');
    expect((await prose.evaluate(request)).reason).toBe('invalid-output');
  });
});
