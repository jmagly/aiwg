import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '../../../src/decision/types.js';

vi.mock('../../../src/decision/evaluate.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/decision/evaluate.js')>();
  return { ...actual, evaluateDecisionRuleset: vi.fn(actual.evaluateDecisionRuleset) };
});

const { evaluateDecisionRuleset } = await import('../../../src/decision/evaluate.js');
const {
  decisionPatternPacks,
  getDecisionPatternPack,
  listDecisionPatterns,
  planLiveDecisionPattern,
  recordedChoice,
  recordedNoul,
  recordedScore,
  runLiveDecisionPattern,
  runOfflineDecisionPattern,
  resolveDecisionPatternArtifact,
  runOfflineDurableReviewFixture,
  runOfflineReviewAuthorizationFixture,
  runOfflineReviewMatrixFixture,
  validateDecisionPattern,
} = await import('../../../src/decision/patterns/index.js');

const evaluateSpy = vi.mocked(evaluateDecisionRuleset);
const fixtureDirectories: string[] = [];
beforeEach(() => { evaluateSpy.mockClear(); });
afterEach(async () => Promise.all(fixtureDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))));

const available = () => decisionPatternPacks.filter(candidate => candidate.status !== 'unavailable');
const answers = (value: Record<string, Record<string, JsonValue>>, usage?: { input_tokens: number; output_tokens: number }) =>
  ({ answers: value, ...(usage ? { usage } : {}) }) as Record<string, JsonValue>;
const route = (selected: string, probability: number) => recordedChoice(['search', 'summarize', 'admin', 'none', 'manual-review'], selected, probability);
const LEVELS = ['low', 'medium', 'high'];

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

  it('resolves every advertised artifact, including one definition per evaluation alias', () => {
    for (const pack of decisionPatternPacks) {
      for (const value of Object.values(pack.artifacts)) {
        for (const reference of Array.isArray(value) ? value : [value]) {
          expect(resolveDecisionPatternArtifact(reference)).toMatchObject({
            schema: 'decision-pattern-artifact/v1', patternId: pack.id, patternVersion: pack.version,
          });
        }
      }
    }
    expect(getDecisionPatternPack('rag-screen').artifacts.definitions).toHaveLength(3);
    expect(() => resolveDecisionPatternArtifact('aiwg://decision-patterns/rag-screen/1.0.0/definition.unknown')).toThrow('Malformed');
  });

  it('PAT-RUNTIME runs every available fixture through the production evaluator and recorded Jev transport', async () => {
    for (const pack of available()) {
      for (const fixture of pack.fixtures) {
        evaluateSpy.mockClear();
        const receipt = await runOfflineDecisionPattern(pack.id, fixture.id);
        expect(receipt).toMatchObject({
          schema: 'decision-pattern-receipt/v2', executionMode: 'offline-recorded',
          evidenceOrigin: 'sanitized-recorded-fixture', requestedModel: 'offline:recorded-fixture', actualModel: null,
          runtime: { evaluator: 'evaluateDecisionRuleset', adapter: 'jev@1.0.0', transport: 'recorded-replay' },
          action: { status: 'unexecuted' },
        });
        expect([receipt.route, receipt.reason], `${pack.id}/${fixture.id}`).toEqual([fixture.expected.route, fixture.expected.reason]);
        if (receipt.result) {
          expect(evaluateSpy, `${pack.id}/${fixture.id}`).toHaveBeenCalled();
          expect(receipt.runtime.transportCalls).toBeGreaterThan(0);
          expect(receipt.result.kind).toBe('RulesetResult');
          expect(receipt.checks).toContain('evaluated-by-decision-runtime');
        } else {
          expect(evaluateSpy).not.toHaveBeenCalled();
          expect(receipt.runtime.transportCalls).toBe(0);
        }
      }
    }
  });

  it('PAT-RUNTIME computes each route and never reads the fixture expectation', async () => {
    for (const pack of available()) {
      for (const fixture of pack.fixtures) {
        const original = { ...fixture.expected };
        const tampered = decisionPatternPacks.find(candidate => candidate.id === pack.id)!.fixtures.find(candidate => candidate.id === fixture.id)!;
        tampered.expected = { route: original.route === 'accept' ? 'deny' : 'accept', reason: 'tampered-expectation' };
        try {
          const receipt = await runOfflineDecisionPattern(pack.id, fixture.id);
          expect(receipt.route, `${pack.id}/${fixture.id}`).toBe(original.route);
          expect(receipt.reason).toBe(original.reason);
          expect(receipt.route).not.toBe(tampered.expected.route);
        } finally {
          tampered.expected = original;
        }
      }
    }
  });

  it.each([
    ['intent-routing', 'route-authorized', answers({ route: route('search', 0.6) }), 'review', 'evidence-not-accepted'],
    ['intent-routing', 'route-authorized', answers({ route: route('none', 0.9) }), 'review', 'no-authorized-candidate'],
    ['rag-screen', 'rag-relevant', answers({ relevant: recordedNoul(0.95), contradiction: recordedNoul(0.03), injection: recordedNoul(0.9) }), 'deny', 'prompt-injection-detected'],
    ['rag-screen', 'rag-relevant', answers({ relevant: recordedNoul(0.5), contradiction: recordedNoul(0.03), injection: recordedNoul(0.02) }), 'review', 'evidence-not-accepted'],
    ['citation-support', 'citation-valid', answers({ support: recordedChoice(['supported', 'unclear', 'unsupported'], 'unclear', 0.9) }), 'review', 'support-unclear'],
    ['citation-support', 'citation-valid', answers({ support: recordedChoice(['supported', 'unclear', 'unsupported'], 'supported', 0.6) }), 'review', 'evidence-not-accepted'],
    ['guardrails', 'guardrail-permit', answers({ screen: recordedNoul(0.1) }), 'deny', 'guardrail-flagged'],
    ['guardrails', 'guardrail-permit', answers({ screen: recordedNoul(0.79) }), 'review', 'evidence-not-accepted'],
    ['tool-risk-preflight', 'tool-advisory-allow', answers({ risk: recordedChoice(['allow', 'deny', 'review'], 'review', 0.9) }), 'review', 'advisory-review'],
    ['tool-risk-preflight', 'tool-advisory-allow', answers({ risk: recordedChoice(['allow', 'deny', 'review'], 'allow', 0.5) }), 'review', 'evidence-not-accepted'],
    ['bounded-classification', 'classification-known', answers({ category: recordedChoice(['bug', 'feature', 'sales', 'none'], 'bug', 0.5) }), 'review', 'evidence-not-accepted'],
    ['ordinal-scoring', 'ordinal-full', answers({ severity: recordedScore(LEVELS, [0.5, 0, 0.5]) }), 'review', 'evidence-not-accepted'],
    ['function-selection', 'function-valid', answers({ function: recordedChoice(['lookup', 'deleteAll', 'none'], 'lookup', 0.5) }), 'deny', 'evidence-not-accepted'],
    ['same-subject-batch', 'batch-one-subject', answers({ risk: recordedScore(LEVELS, [0.7, 0.2, 0.1]), route: recordedChoice(['self-serve', 'escalate'], 'escalate', 0.9), urgent: recordedNoul(0.1) }, { input_tokens: 20, output_tokens: 4 }), 'review', 'escalation-recommended'],
    ['same-subject-batch', 'batch-one-subject', answers({ risk: recordedScore(LEVELS, [0.7, 0.2, 0.1]), route: recordedChoice(['self-serve', 'escalate'], 'self-serve', 0.9), urgent: recordedNoul(0.5) }, { input_tokens: 20, output_tokens: 4 }), 'review', 'evidence-not-accepted'],
    ['durable-review', 'review-resume', answers({ review: recordedChoice(['route-to-reviewer', 'insufficient-context'], 'insufficient-context', 0.9) }), 'review', 'review-context-insufficient'],
    ['candidate-selection', 'candidate-bounded', answers({ candidate: recordedChoice(['alpha', 'beta', 'gamma', 'none'], 'beta', 0.5) }), 'review', 'evidence-not-accepted'],
  ] as const)('PAT-ACCEPT %s/%s: changed recorded evidence moves the route as its acceptance policy predicts (%#)', async (id, fixtureId, recordedEvidence, expectedRoute, expectedReason) => {
    const baseline = await runOfflineDecisionPattern(id, fixtureId);
    evaluateSpy.mockClear();
    const receipt = await runOfflineDecisionPattern(id, fixtureId, { recordedEvidence });
    expect(evaluateSpy).toHaveBeenCalled();
    expect([receipt.route, receipt.reason]).toEqual([expectedRoute, expectedReason]);
    expect([receipt.route, receipt.reason]).not.toEqual([baseline.route, baseline.reason]);
  });

  it('PAT-NOUL-050 routes a truth probability of exactly 0.5 to review and never labels it medium', async () => {
    const receipt = await runOfflineDecisionPattern('guardrails', 'guardrail-noul-midpoint');
    expect(receipt.route).toBe('review');
    expect(receipt.route).not.toBe('accept');
    expect(receipt.evaluations).toEqual([expect.objectContaining({
      alias: 'screen', primitive: 'truth-probability', status: 'abstained', reason: 'low-confidence', value: null,
      acceptance: expect.objectContaining({ disposition: 'review', reason: 'default' }),
    })]);
    expect(receipt.result?.spec.evaluations.screen?.spec.acceptance?.values['yes-probability']?.normalizedBps).toBe(5000);
    expect(JSON.stringify(receipt)).not.toMatch(/medium/i);
  });

  it('PAT-BATCH executes the same-subject pack as one native request with request-level usage only', async () => {
    const receipt = await runOfflineDecisionPattern('same-subject-batch', 'batch-one-subject');
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    expect(receipt.runtime.transportCalls).toBe(1);
    expect(receipt.usage).toEqual({ inputTokens: 20, outputTokens: 4, costUsd: null, availability: 'recorded', scope: 'request' });
    expect(receipt.evaluations.map(evaluation => evaluation.primitive)).toEqual(['ordinal-score', 'choice', 'truth-probability']);
    expect(receipt.evaluations.every(evaluation => evaluation.usage.inputTokens === null && evaluation.usage.outputTokens === null)).toBe(true);
    const attempts = Object.values(receipt.result!.spec.evaluations).map(evaluation => evaluation.spec.attempts[0]!);
    expect(new Set(attempts.map(attempt => attempt.batch?.groupId)).size).toBe(1);
    expect(attempts.every(attempt => attempt.batch?.mode === 'native')).toBe(true);
    expect(receipt.checks).toEqual(expect.arrayContaining(['same-subject', 'request-usage-once']));

    evaluateSpy.mockClear();
    const multi = await runOfflineDecisionPattern('same-subject-batch', 'batch-multi-subject');
    expect(multi).toMatchObject({ route: 'deny', reason: 'multi-subject-batch-rejected', result: null, runtime: { transportCalls: 0 } });
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it('keeps deterministic denial stronger than conflicting model evidence', async () => {
    for (const [id, fixture] of [['rag-screen', 'rag-policy-deny'], ['guardrails', 'guardrail-conflict'], ['tool-risk-preflight', 'tool-deny-conflict']] as const) {
      const receipt = await runOfflineDecisionPattern(id, fixture);
      expect(receipt.route).toBe('deny');
      expect(receipt.reason).toBe('deterministic-policy-deny');
      expect(receipt.action).toEqual({ status: 'unexecuted', candidate: null });
      expect(receipt.checks).toContain('deterministic-policy-precedence');
    }
  });

  it.each(['root', 'admin', 'deleteAll', '__proto__', ''])('never expands routing or function authority for %j', async selected => {
    const routing = await runOfflineDecisionPattern('intent-routing', 'route-authorized', { recordedEvidence: answers({ route: { type: 'choice', choice: selected, probabilities: { [selected]: 1 }, confidence: 1 } }) });
    expect(routing).toMatchObject({ route: 'review', action: { candidate: null } });
    const fn = await runOfflineDecisionPattern('function-selection', 'function-valid', { recordedEvidence: answers({ function: { type: 'choice', choice: selected, probabilities: { [selected]: 1 }, confidence: 1 } }) });
    expect(fn).toMatchObject({ route: 'deny', action: { candidate: null } });
  });

  it.each([
    [route('admin', 0.99), { authorizedCandidates: ['summarize'] }],
    [{ ...route('search', 0.95), installCapability: true }, { authorizedCandidates: ['summarize'] }],
    [{ ...route('search', 0.95), permissions: ['*'] }, { authorizedCandidates: ['admin'] }],
    [route('search', 0.95), { authorizedCandidates: ['search'] }],
  ] as const)('PAT-AUTH-PROP routing evidence cannot add authority %#', async (recorded, input) => {
    const receipt = await runOfflineDecisionPattern('intent-routing', 'route-authorized', { recordedEvidence: answers({ route: recorded as Record<string, JsonValue> }), input: input as Record<string, JsonValue> });
    expect(receipt.action.status).toBe('unexecuted');
    if (input.authorizedCandidates.includes('search') && recorded.choice === 'search' && !('installCapability' in recorded) && !('permissions' in recorded)) {
      expect(receipt).toMatchObject({ route: 'accept', action: { candidate: 'search' } });
    } else expect(receipt).toMatchObject({ route: 'review', action: { candidate: null } });
  });

  it.each([
    [{ query: 'safe' }, 'lookup', 'accept'],
    [{ query: 'safe', grant: 'admin' }, 'lookup', 'deny'],
    [{}, 'lookup', 'deny'],
    [{ query: 'safe' }, 'deleteAll', 'deny'],
  ] as const)('PAT-AUTH-PROP function evidence cannot expand or execute authority %#', async (proposedArguments, selected, expectedRoute) => {
    const input = { ...getDecisionPatternPack('function-selection').fixtures[0]!.input, proposedArguments } as Record<string, JsonValue>;
    const receipt = await runOfflineDecisionPattern('function-selection', 'function-valid', { input, recordedEvidence: answers({ function: recordedChoice(['lookup', 'deleteAll', 'none'], selected, 0.95) }) });
    expect(receipt.action.status).toBe('unexecuted');
    expect(receipt.route).toBe(expectedRoute);
    expect(receipt.action.candidate).toBe(expectedRoute === 'accept' ? 'lookup' : null);
  });

  it.each([
    recordedChoice(['allow', 'deny', 'review'], 'allow', 1),
    recordedChoice(['allow', 'deny', 'review'], 'deny', 1),
    { type: 'choice', choice: 'other', probabilities: { allow: 0.5, deny: 0.5 }, confidence: 0.5 },
  ])('PAT-AUTH-PROP keeps tool policy deny across recorded output %#', async recorded => {
    expect(await runOfflineDecisionPattern('tool-risk-preflight', 'tool-deny-conflict', { recordedEvidence: answers({ risk: recorded as Record<string, JsonValue> }) })).toMatchObject({
      route: 'deny', reason: 'deterministic-policy-deny', action: { status: 'unexecuted', candidate: null },
    });
  });

  it.each([
    { locator: 'doc:admin', digest: `sha256:${'a'.repeat(64)}` },
    { locator: 'doc:1#p2', digest: `sha256:${'f'.repeat(64)}` },
    { locator: '__proto__', digest: `sha256:${'0'.repeat(64)}` },
  ])('PAT-AUTH-PROP citation evidence cannot create provenance %#', async citation => {
    const input = { ...getDecisionPatternPack('citation-support').fixtures[0]!.input, citation } as Record<string, JsonValue>;
    expect(await runOfflineDecisionPattern('citation-support', 'citation-valid', { input })).toMatchObject({
      route: 'review', reason: 'citation-provenance-unverified', action: { status: 'unexecuted', candidate: null },
    });
  });

  it('rejects an unverified source even when the locator and digest match', async () => {
    const fixture = getDecisionPatternPack('citation-support').fixtures[0]!;
    const sources = (fixture.input.sources as Array<Record<string, JsonValue>>).map(source => ({ ...source, provenanceVerified: false }));
    expect(await runOfflineDecisionPattern('citation-support', 'citation-valid', { input: { ...fixture.input, sources } })).toMatchObject({ route: 'review', action: { candidate: null } });
    expect(await runOfflineDecisionPattern('citation-support', 'citation-valid')).toMatchObject({ route: 'accept', action: { candidate: 'doc:1#p2' } });
  });

  it.each([
    { type: 'noul', noul: 1 },
    { type: 'noul', noul: 1, policyOverride: 'allow' },
    { type: 'noul', noul: 2, grant: 'admin' },
  ])('PAT-AUTH-PROP guardrail output cannot override deterministic denial %#', async recorded => {
    expect(await runOfflineDecisionPattern('guardrails', 'guardrail-conflict', { recordedEvidence: answers({ screen: recorded as Record<string, JsonValue> }) })).toMatchObject({
      route: 'deny', reason: 'deterministic-policy-deny', action: { status: 'unexecuted', candidate: null },
    });
  });

  it('evaluates RAG relevance, contradiction, and injection as distinct evaluations', async () => {
    const relevant = await runOfflineDecisionPattern('rag-screen', 'rag-relevant');
    expect(relevant.evaluations.map(evaluation => evaluation.alias)).toEqual(['relevant', 'contradiction', 'injection']);
    expect(relevant.runtime.transportCalls).toBe(3);
    expect(await runOfflineDecisionPattern('rag-screen', 'rag-contradiction')).toMatchObject({ route: 'review', reason: 'source-contradiction' });
    expect(await runOfflineDecisionPattern('rag-screen', 'rag-injection')).toMatchObject({ route: 'deny', reason: 'prompt-injection-detected' });
  });

  it('preserves the full ordinal distribution and fractional mean from the runtime result', async () => {
    const receipt = await runOfflineDecisionPattern('ordinal-scoring', 'ordinal-full');
    expect(receipt.uncertainty.distribution).toEqual({ 0: 0.2, 1: 0.5, 2: 0.3 });
    expect(receipt.evaluations[0]!.value).toBeCloseTo(1.1, 9);
    expect(receipt.result?.spec.evaluations.severity?.spec.acceptance?.values.dispersion?.value).toBeCloseTo(0.49, 9);
  });

  it('PAT-DURABLE-RUNTIME resumes idempotently through the production receipt store', async () => {
    const receipt = await runOfflineDecisionPattern('durable-review', 'review-resume');
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
    expect(receipt.runtime).toMatchObject({ invocations: 2, transportCalls: 1 });
    expect(receipt.checks).toContain('idempotent-resume');
  });

  it('plans bounded live readiness but never executes or disguises a mock as live', () => {
    expect(planLiveDecisionPattern('intent-routing', { explicitOptIn: false, credentialResolved: true, egressApproved: true })).toMatchObject({ status: 'skipped', reason: 'explicit-opt-in-required', executes: false });
    expect(planLiveDecisionPattern('intent-routing', { explicitOptIn: true, credentialResolved: false, egressApproved: true })).toMatchObject({ status: 'skipped', reason: 'credential-unavailable', executes: false });
    expect(planLiveDecisionPattern('intent-routing', { explicitOptIn: true, credentialResolved: true, egressApproved: false })).toMatchObject({ status: 'denied', reason: 'egress-denied', executes: false });
    expect(planLiveDecisionPattern('intent-routing', { explicitOptIn: true, credentialResolved: true, egressApproved: true })).toMatchObject({ status: 'ready', reason: 'ready', executes: false, limits: { allowUnknownCost: false, maxCalls: 1 } });
    expect(planLiveDecisionPattern('dependent-two-stage', { explicitOptIn: true, credentialResolved: true, egressApproved: true })).toMatchObject({ status: 'skipped', reason: 'live-binding-unavailable' });
  });

  describe('PAT-LIVE-CAPS bounded synthetic live variant', () => {
    const options = { explicitOptIn: true, credentialResolved: true, egressApproved: true };
    const credential = async () => new TextEncoder().encode('synthetic-test-token');
    /** Fake Jev transport answering every requested question; it records starts and aborts. */
    function fakeTransport(behaviour: 'answer' | 'hang' = 'answer') {
      const started: string[][] = [];
      const aborted: boolean[] = [];
      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string; criteria: Record<string, unknown> }> };
        started.push(Object.keys(body.questions));
        if (behaviour === 'hang') {
          return await new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => {
            aborted.push(true);
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true }));
        }
        const answered = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
          if (question.type === 'noul') return [id, { type: 'noul', noul: 0.05 }];
          const options = Object.keys(question.criteria);
          return [id, recordedChoice(options, options[0]!, 0.9)];
        }));
        return new Response(JSON.stringify({ answers: answered, model: 'jev:test-2026-09', usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
      }) as unknown as typeof globalThis.fetch;
      return { fetch, started, aborted };
    }

    // The fake transport never leaves the process, so the host opts out of projection.
    const localProjection = { mode: 'unprojected-local' } as const;

    it('PAT-LIVE-PROJECTION denies dispatch without a host projection boundary', async () => {
      const transport = fakeTransport();
      const receipt = await runLiveDecisionPattern('intent-routing', { synthetic: true, input: { authorizedCandidates: ['search'] } }, options,
        { fetch: transport.fetch, resolveCredential: credential, estimate: () => ({ tokens: 100, costUsd: 0.001 }), model: 'jev:test' });
      expect(transport.fetch).not.toHaveBeenCalled();
      expect(receipt.calls).toBe(0);
      expect(receipt.result.spec.evaluations.route?.spec.reason).toBe('data-boundary-denied');
      expect(receipt.route).not.toBe('accept');
    });

    it('runs through the evaluator and retains the actual model identity', async () => {
      const transport = fakeTransport();
      const receipt = await runLiveDecisionPattern('intent-routing', { synthetic: true, input: { authorizedCandidates: ['search'] } }, options,
        { fetch: transport.fetch, resolveCredential: credential, estimate: () => ({ tokens: 100, costUsd: 0.001 }), model: 'jev:test', projection: localProjection });
      expect(evaluateSpy).toHaveBeenCalledTimes(1);
      expect(receipt).toMatchObject({ schema: 'decision-pattern-live-receipt/v2', executionMode: 'live', evidenceOrigin: 'live-synthetic',
        requestedModel: 'jev:test', actualModel: 'jev:test-2026-09', calls: 1, route: 'accept', action: { status: 'unexecuted' },
        usage: { inputTokens: 10, outputTokens: 2, reservedTokens: 100, reservedCostUsd: 0.001, reportedCostUsd: null } });
      expect(receipt.admission).toEqual([{ alias: 'route', decision: 'admit', reason: 'admitted' }]);
    });

    it('never starts the call that would exceed a limit of N calls', async () => {
      const transport = fakeTransport();
      const receipt = await runLiveDecisionPattern('rag-screen', { synthetic: true, input: { sourceLocator: 'doc:synthetic' } }, { ...options, limits: { maxCalls: 1 } },
        { fetch: transport.fetch, resolveCredential: credential, estimate: () => ({ tokens: 100, costUsd: 0.001 }), model: 'jev:test', projection: localProjection });
      expect(transport.fetch).toHaveBeenCalledTimes(1);
      expect(receipt.calls).toBe(1);
      expect(receipt.admission.filter(entry => entry.decision === 'reject').map(entry => entry.reason)).toEqual(['attempts', 'attempts']);
      expect(Object.values(receipt.result.spec.evaluations).filter(evaluation => evaluation.spec.reason === 'budget-exhausted')).toHaveLength(2);
      expect(receipt.route).toBe('review');
    });

    it.each([
      ['tokens', { maxTokens: 150 }, () => ({ tokens: 100, costUsd: 0.001 }), 1, 'tokens'],
      ['cost', { maxCostUsd: 0.015 }, () => ({ tokens: 10, costUsd: 0.01 }), 1, 'cost'],
      ['unknown cost', {}, () => ({ tokens: 10, costUsd: null }), 0, 'unknown-cost'],
    ] as const)('reserves %s before dispatch', async (_label, limits, estimate, expectedCalls, reason) => {
      const transport = fakeTransport();
      const receipt = await runLiveDecisionPattern('rag-screen', { synthetic: true, input: { sourceLocator: 'doc:synthetic' } }, { ...options, limits },
        { fetch: transport.fetch, resolveCredential: credential, estimate, model: 'jev:test', projection: localProjection });
      expect(transport.fetch).toHaveBeenCalledTimes(expectedCalls);
      expect(receipt.calls).toBe(expectedCalls);
      expect(receipt.admission.some(entry => entry.decision === 'reject' && entry.reason === reason)).toBe(true);
      expect(receipt.route).toBe('review');
    });

    it('aborts the in-flight transport through its signal at the deadline', async () => {
      const transport = fakeTransport('hang');
      const receipt = await runLiveDecisionPattern('intent-routing', { synthetic: true, input: { authorizedCandidates: ['search'] } }, { ...options, limits: { deadlineMs: 50 } },
        { fetch: transport.fetch, resolveCredential: credential, estimate: () => ({ tokens: 10, costUsd: 0.001 }), model: 'jev:test', projection: localProjection });
      expect(transport.started).toHaveLength(1);
      expect(transport.aborted).toEqual([true]);
      expect(receipt.result.spec.evaluations.route?.spec.reason).toBe('timeout');
      expect(receipt.route).toBe('review');
    });

    it('rejects loosened limits, missing models and non-synthetic input', async () => {
      const transport = { fetch: fakeTransport().fetch, resolveCredential: credential, estimate: () => ({ tokens: 1, costUsd: 0.001 }), model: 'jev:test', projection: localProjection };
      await expect(runLiveDecisionPattern('intent-routing', { synthetic: true, input: {} }, { ...options, limits: { maxCalls: 5 } }, transport)).rejects.toThrow('only be tightened');
      await expect(runLiveDecisionPattern('intent-routing', { synthetic: true, input: {} }, options, { ...transport, model: ' ' })).rejects.toThrow('explicit requested model');
      await expect(runLiveDecisionPattern('intent-routing', { synthetic: false as true, input: {} }, options, transport)).rejects.toThrow('synthetic');
      await expect(runLiveDecisionPattern('intent-routing', { synthetic: true, input: {} }, { ...options, explicitOptIn: false }, transport)).rejects.toThrow('explicit-opt-in-required');
    });
  });

  it('PAT-REVIEW-MATRIX exercises low-confidence, policy conflict, edit, reject, expiry, escalation and replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiwg-pattern-review-matrix-'));
    fixtureDirectories.push(directory);
    await expect(runOfflineReviewMatrixFixture(directory)).resolves.toEqual({
      schema: 'decision-review-offline-matrix/v1', executionMode: 'offline-local', networkAllowed: false,
      credentialRequired: false, restarted: true, claimed: 'claimed', rejected: 'rejected', editedVersion: 2,
      expired: 'expired', escalated: 'escalated', lateDenied: true, executorCalls: 1,
      duplicateResumeReturnedReceipt: true,
    });
  });

  it('PAT-REVIEW-AUTHZ-001 non-permissive pinned authorization produces zero unauthorized effects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiwg-pattern-review-authz-'));
    fixtureDirectories.push(directory);
    await expect(runOfflineReviewAuthorizationFixture(directory)).resolves.toEqual({
      schema: 'decision-review-offline-authorization/v1', executionMode: 'offline-local', networkAllowed: false,
      credentialRequired: false, authorization: 'pinned-review-authorization', restarted: true,
      deniedAttempts: ['resume-before-approval', 'self-approval', 'unauthenticated-reviewer', 'requester-claim',
        'reviewer-as-executor', 'foreign-project-executor', 'unknown-principal', 'stale-resume-token',
        'action-authorization-revoked', 'policy-replaced', 'reviewer-role-revoked'],
      unauthorizedEffects: 0, authorizedEffects: 1, authorizationDeniedEvents: 2, duplicateResumeReturnedReceipt: true,
    });
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
