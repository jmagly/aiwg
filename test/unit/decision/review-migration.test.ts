import { describe, expect, it } from 'vitest';
import { durableReviewInputFromRuleset, type RulesetResult } from '../../../src/decision/index.js';

const pin = (id: string) => ({ id, version: '1.0.0', digest: `sha256:${id.padEnd(64, '0').slice(0, 64)}` as const });
const result = (): RulesetResult => ({
  apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'RulesetResult',
  metadata: { id: 'review-result', version: '1.0.0', description: 'review result' },
  spec: {
    ruleset: pin('a'), binding: pin('b'), runId: 'run', invocationId: 'invocation',
    status: 'review', reason: 'conflicting-outcomes', outcome: { route: 'manual' }, matchedRules: [],
    evaluations: {
      second: { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionResult', metadata: { id: 'second', version: '1.0.0', description: 'second' },
        spec: { decision: pin('d'), ruleset: pin('a'), binding: pin('b'), alias: 'second', runId: 'run', invocationId: 'invocation',
          status: 'success', value: 'yes', reason: 'none', uncertainty: null, attempts: [] } },
      first: { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionResult', metadata: { id: 'first', version: '1.0.0', description: 'first' },
        spec: { decision: pin('c'), ruleset: pin('a'), binding: pin('b'), alias: 'first', runId: 'run', invocationId: 'invocation',
          status: 'success', value: 'no', reason: 'none', uncertainty: null, attempts: [] } },
    },
  },
});
const options = { enabled: true, reviewId: 'review-1', continuationId: 'continue-1', resumeToken: 'secret',
  expiresAtEpochMs: 10_000, rationale: 'conflict requires review', riskTier: 'high', reasonCodes: ['conflict'] };

describe('durable review migration', () => {
  it('leaves existing review results unchanged unless explicitly enabled', () => {
    expect(durableReviewInputFromRuleset(result(), { ...options, enabled: false })).toBeNull();
  });

  it('creates deterministic pinned review input without executing or persisting', () => {
    const input = durableReviewInputFromRuleset(result(), options)!;
    expect(input.action).toEqual({ route: 'manual' });
    expect(input.evidencePins.map(item => item.id)).toEqual(['c', 'd']);
    expect(input.policyPins.map(item => item.id)).toEqual(['a', 'b']);
    expect(input.sourceReceipt).toMatchObject({ id: 'invocation' });
    expect(input.sourceReceipt.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects automatic migration of non-review or actionless results', () => {
    const completed = result(); completed.spec.status = 'completed';
    expect(() => durableReviewInputFromRuleset(completed, options)).toThrow(/Only a review/);
    const actionless = result(); delete actionless.spec.outcome;
    expect(() => durableReviewInputFromRuleset(actionless, options)).toThrow(/proposed outcome/);
  });
});
