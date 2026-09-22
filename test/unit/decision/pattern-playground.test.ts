import { describe, expect, it } from 'vitest';
import {
  decisionPatternPacks,
  getDecisionPatternPack,
  listDecisionPatterns,
  planLiveDecisionPattern,
  runOfflineDecisionPattern,
  resolveDecisionPatternArtifact,
  validateDecisionPattern,
} from '../../../src/decision/patterns/index.js';

describe('PAT decision pattern playground', () => {
  it('discovers every required pack with governed artifacts and offline fixtures', () => {
    expect(listDecisionPatterns().map(pack => pack.id)).toEqual([
      'intent-routing', 'rag-screen', 'citation-support', 'guardrails',
      'tool-risk-preflight', 'bounded-classification', 'ordinal-scoring',
      'function-selection', 'same-subject-batch', 'dependent-two-stage',
      'durable-review', 'candidate-selection',
    ]);
    for (const pack of decisionPatternPacks) expect(validateDecisionPattern(pack)).toEqual([]);
    expect(getDecisionPatternPack('durable-review').status).toBe('experimental');
    expect(getDecisionPatternPack('dependent-two-stage').status).toBe('unavailable');
  });

  it('resolves every advertised artifact through the installed package API', () => {
    for (const pack of decisionPatternPacks) {
      for (const value of Object.values(pack.artifacts)) {
        for (const reference of Array.isArray(value) ? value : [value]) {
          expect(resolveDecisionPatternArtifact(reference)).toMatchObject({
            schema: 'decision-pattern-artifact/v1', patternId: pack.id, patternVersion: pack.version,
          });
        }
      }
    }
  });

  it('runs all available fixtures offline with normalized, non-live receipts', () => {
    for (const pack of decisionPatternPacks.filter(candidate => candidate.status !== 'unavailable')) {
      for (const fixture of pack.fixtures) {
        const receipt = runOfflineDecisionPattern(pack.id, fixture.id);
        expect(receipt).toMatchObject({
          schema: 'decision-pattern-receipt/v1', executionMode: 'offline-recorded',
          evidenceOrigin: 'sanitized-recorded-fixture', requestedModel: 'offline-fixture',
          actualModel: null, attempts: 0, action: { status: 'unexecuted' },
          usage: { inputTokens: null, outputTokens: null, costUsd: null, availability: 'unavailable' },
        });
        expect(receipt.route).toBe(fixture.expected.route);
        expect(receipt.reason).toBe(fixture.expected.reason);
      }
    }
  });

  it('keeps deterministic denial stronger than conflicting model evidence', () => {
    for (const id of ['rag-screen', 'guardrails', 'tool-risk-preflight'] as const) {
      const receipt = runOfflineDecisionPattern(id);
      expect(receipt.route).toBe('deny');
      expect(receipt.reason).toBe('deterministic-policy-deny');
      expect(receipt.action).toEqual({ status: 'unexecuted', candidate: null });
    }
  });

  it.each(['root', 'admin', 'deleteAll', '__proto__', ''])('never expands routing or function authority for %j', selected => {
    expect(runOfflineDecisionPattern('intent-routing', 'route-authorized', { selected, confidence: 1 }).route).toBe('review');
    expect(runOfflineDecisionPattern('function-selection', 'function-unauthorized', { selected, arguments: {} }).route).toBe('deny');
  });

  it.each([
    { selected: 'allow', distribution: { allow: 1, deny: 0 } },
    { selected: 'deny', distribution: { allow: 0, deny: 1 } },
    { selected: 'other', distribution: { allow: 0.5, deny: 0.5 } },
  ])('keeps tool policy deny across recorded output %#', evidence => {
    expect(runOfflineDecisionPattern('tool-risk-preflight', 'tool-deny-conflict', evidence)).toMatchObject({
      route: 'deny', reason: 'deterministic-policy-deny', action: { status: 'unexecuted', candidate: null },
    });
  });

  it('independently rejects fabricated citations and preserves valid locators', () => {
    expect(runOfflineDecisionPattern('citation-support', 'citation-valid')).toMatchObject({ route: 'accept', action: { candidate: 'doc:1#p2' } });
    expect(runOfflineDecisionPattern('citation-support', 'citation-fabricated')).toMatchObject({ route: 'review', action: { candidate: null } });
  });

  it('accepts one-subject heterogeneous batches and rejects multiple subjects', () => {
    expect(runOfflineDecisionPattern('same-subject-batch', 'batch-one-subject').route).toBe('accept');
    expect(runOfflineDecisionPattern('same-subject-batch', 'batch-multi-subject')).toMatchObject({ route: 'deny', reason: 'multi-subject-batch-rejected' });
  });

  it('preserves ordinal distribution evidence without severity relabeling', () => {
    const receipt = runOfflineDecisionPattern('ordinal-scoring');
    expect(receipt.uncertainty.distribution).toEqual({ low: 0.2, medium: 0.5, high: 0.3 });
    expect(receipt.checks).toEqual(expect.arrayContaining(['legend-preserved', 'mean-preserved', 'dispersion-preserved']));
  });

  it('plans bounded live readiness but never executes or disguises a mock as live', () => {
    expect(planLiveDecisionPattern('intent-routing', { explicitOptIn: false, credentialResolved: true, egressApproved: true })).toMatchObject({ status: 'skipped', reason: 'explicit-opt-in-required', executes: false });
    expect(planLiveDecisionPattern('intent-routing', { explicitOptIn: true, credentialResolved: false, egressApproved: true })).toMatchObject({ status: 'skipped', reason: 'credential-unavailable', executes: false });
    expect(planLiveDecisionPattern('intent-routing', { explicitOptIn: true, credentialResolved: true, egressApproved: false })).toMatchObject({ status: 'denied', reason: 'egress-denied', executes: false });
    expect(planLiveDecisionPattern('intent-routing', { explicitOptIn: true, credentialResolved: true, egressApproved: true })).toMatchObject({ status: 'ready', reason: 'ready', executes: false, limits: { allowUnknownCost: false, maxCalls: 2 } });
  });
});
