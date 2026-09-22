import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decisionPatternPacks,
  getDecisionPatternPack,
  listDecisionPatterns,
  planLiveDecisionPattern,
  runLiveDecisionPattern,
  runOfflineDecisionPattern,
  resolveDecisionPatternArtifact,
  runOfflineDurableReviewFixture,
  validateDecisionPattern,
} from '../../../src/decision/patterns/index.js';

const fixtureDirectories: string[] = [];
afterEach(async () => Promise.all(fixtureDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))));

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
    for (const [id, fixture] of [['rag-screen', 'rag-policy-deny'], ['guardrails', undefined], ['tool-risk-preflight', undefined]] as const) {
      const receipt = runOfflineDecisionPattern(id, fixture);
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
    { selected: 'admin', confidence: 1, installCapability: true },
    { selected: 'root', confidence: 1, permissions: ['*'] },
    { selected: 'deleteAll', confidence: 1, execute: true },
    { selected: '__proto__', confidence: 1, policy: { allow: true } },
    { selected: 'search', confidence: 1, authorizedCandidates: ['search', 'admin'] },
  ])('PAT-AUTH-PROP routing evidence cannot add authority %#', evidence => {
    const receipt = runOfflineDecisionPattern('intent-routing', 'route-authorized', evidence);
    expect(receipt.action.status).toBe('unexecuted');
    if (evidence.selected === 'search') expect(receipt).toMatchObject({ route: 'accept', action: { candidate: 'search' } });
    else expect(receipt).toMatchObject({ route: 'review', action: { candidate: null } });
  });

  it.each([
    { selected: 'deleteAll', arguments: {}, execute: true },
    { selected: 'lookup', arguments: { query: 'safe' }, grant: 'admin' },
    { selected: 'lookup', arguments: { query: 'safe' }, legalFunctions: ['deleteAll'] },
    { selected: 'lookup', arguments: { query: 'safe' }, policyOverride: 'allow' },
  ])('PAT-AUTH-PROP function evidence cannot expand or execute authority %#', evidence => {
    const receipt = runOfflineDecisionPattern('function-selection', 'function-valid', evidence);
    expect(receipt.action.status).toBe('unexecuted');
    if (evidence.selected === 'lookup') expect(receipt).toMatchObject({ route: 'accept', action: { candidate: 'lookup' } });
    else expect(receipt).toMatchObject({ route: 'deny', action: { candidate: null } });
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

  it('evaluates RAG relevance, contradiction, and injection as distinct evidence', () => {
    expect(runOfflineDecisionPattern('rag-screen', 'rag-relevant')).toMatchObject({ route: 'accept', reason: 'relevant-no-conflict' });
    expect(runOfflineDecisionPattern('rag-screen', 'rag-contradiction')).toMatchObject({ route: 'review', reason: 'source-contradiction' });
    expect(runOfflineDecisionPattern('rag-screen', 'rag-injection')).toMatchObject({ route: 'deny', reason: 'prompt-injection-detected' });
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

  it('runs only bounded synthetic live probes and retains actual model identity', async () => {
    const options = { explicitOptIn: true, credentialResolved: true, egressApproved: true };
    await expect(runLiveDecisionPattern('intent-routing', { synthetic: true, input: { text: 'synthetic' } }, options, async (_request, limits) => {
      expect(limits).toMatchObject({ maxCalls: 2, maxAttempts: 1, allowUnknownCost: false });
      return { requestedModel: 'jev:test', actualModel: 'jev:test-2026-09', output: { selected: 'search' }, attempts: 1, usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.001 } };
    })).resolves.toMatchObject({ executionMode: 'live', evidenceOrigin: 'live-synthetic', actualModel: 'jev:test-2026-09', action: { status: 'unexecuted' } });
    await expect(runLiveDecisionPattern('intent-routing', { synthetic: true, input: {} }, options, async () => ({
      requestedModel: 'jev:test', actualModel: 'jev:test', output: {}, attempts: 2, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
    }))).rejects.toThrow('attempt limit');
    await expect(runLiveDecisionPattern('intent-routing', { synthetic: true, input: {} }, options, async () => ({
      requestedModel: 'jev:test', actualModel: 'jev:test', output: {}, attempts: 1, usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
    }))).rejects.toThrow('cost unavailable');
  });

  it('PAT-DURABLE-001 uses the real offline store across restart and resumes idempotently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiwg-pattern-review-'));
    fixtureDirectories.push(directory);
    await expect(runOfflineDurableReviewFixture(directory)).resolves.toMatchObject({
      schema: 'decision-pattern-durable-review-fixture/v1', executionMode: 'offline-local',
      networkAllowed: false, credentialRequired: false, store: 'file-decision-review-store',
      restarted: true, reviewId: 'durable-review-fixture', executorCalls: 1,
      duplicateResumeReturnedReceipt: true,
    });
  });
});
