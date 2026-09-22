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
});
