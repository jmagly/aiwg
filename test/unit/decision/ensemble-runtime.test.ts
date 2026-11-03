import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildEnsembleIntegrityReport,
  championChallengerInputSetDigest,
  championChallengerShadowBaseline,
  ensembleContractDigest,
  aggregateEnsembleResults,
  BoundedDecisionMetrics,
  executeDecisionEnsemble,
  executeDriftResponse,
  pinChampionForRun,
  preregisterChampionChallengerThresholds,
  promoteChampionChallenger,
  rollbackChampionForNewRuns,
  runChampionChallengerShadow,
  validateEnsembleIntegrityReport,
  validateEnsemblePolicy,
  evaluateDecisionRuleset,
  type AliasEvent,
  type ChampionChallengerObservation,
  type DecisionAdapter,
  type DecisionBinding,
  type DecisionChampionChallenger,
  type DecisionDefinition,
  type DecisionDriftResponse,
  type DecisionEnsemblePolicy,
  type DecisionResult,
  type DecisionTelemetrySpan,
  type DriftSignal,
  type EnsembleMember,
  type EnsembleMemberResult,
  type IntegrityGateDecision,
  type PromotionEligibility,
  type QualificationIntegrityMetadata,
  type CalibrationIdentity,
  CalibrationRegistry,
  calibrationIdentityDigest,
} from '../../../src/decision/index.js';
import { readFixture, records } from './ensemble-fixtures.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const policies = records<DecisionEnsemblePolicy>('ensemble-policy.v1.valid.json');
const ccBase = records<DecisionChampionChallenger>('champion-challenger.v1.valid.json').get('triage-champion-challenger-2026-09')!;
const driftPolicy = records<DecisionDriftResponse>('drift-response.v1.valid.json').get('triage-drift-response')!;

function decisionResult(member: EnsembleMember, sampleIndex: number, status: DecisionResult['spec']['status'] = 'success'): DecisionResult {
  const success = status === 'success';
  return {
    apiVersion: 'decision.aiwg.io/v1alpha1',
    kind: 'DecisionResult',
    metadata: { id: `${member.id}-${sampleIndex}`, version: '1.0.0', description: member.id },
    spec: {
      decision: member.definition,
      ruleset: member.definition,
      binding: member.binding,
      alias: member.id,
      runId: 'ensemble-run',
      invocationId: `${member.id}:${sampleIndex}`,
      status,
      ...(success ? { value: member.id === 'jev-c' ? 'deny' : 'approve' } : {}),
      reason: success ? 'none' : status === 'abstained' ? 'insufficient-information' : 'service-error',
      uncertainty: success ? {
        source: 'provider',
        profile: member.uncertaintyProfile,
        calibration: 'vendor-claimed',
        confidence: 0.9,
        distribution: { approve: 0.7, deny: 0.2, escalate: 0.1 },
        calibrationRef: null,
      } : null,
      attempts: [{ ordinal: 1, adapter: member.adapter.id, adapterVersion: member.adapter.version,
        requestedModel: member.model.requested, actualModel: member.model.pinnedVersion, subagent: null,
        status, reason: success ? 'none' : 'service-error', durationMs: 5,
        usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.001 }, requestId: `${member.id}-${sampleIndex}` }],
    },
  };
}

function smallPolicy(overrides: Partial<DecisionEnsemblePolicy> = {}): DecisionEnsemblePolicy {
  const policy = structuredClone(policies.get('triage-choice-ensemble')!);
  policy.members = [policy.members[0]!];
  policy.members[0]!.fallbackDepth = 0;
  policy.members[0]!.estimate = { attemptsPerSample: 1, tokensPerAttempt: 10, costMicrosPerAttempt: 10, deadlineMsPerAttempt: 5 };
  policy.acceptance.minimumSuccessfulMembers = 1;
  policy.ceilings = { ...policy.ceilings, members: 1, attempts: 1, tokens: 100, costMicros: 100, concurrency: 1, fallbackDepth: 0, deadlineMs: 10 };
  return { ...policy, ...overrides };
}

function withAttempts(member: EnsembleMember, sampleIndex: number, attempts: number, usage: DecisionResult['spec']['attempts'][number]['usage']): DecisionResult {
  const result = decisionResult(member, sampleIndex);
  result.spec.attempts = Array.from({ length: attempts }, (_, index) => ({
    ordinal: index + 1,
    adapter: member.adapter.id,
    adapterVersion: member.adapter.version,
    requestedModel: member.model.requested,
    actualModel: member.model.pinnedVersion,
    subagent: null,
    status: 'success',
    reason: 'none',
    durationMs: 5,
    usage,
    requestId: `${member.id}-${sampleIndex}-${index}`,
  }));
  return result;
}

function definitions(): Record<string, DecisionDefinition> {
  return {
    category: fixture('decision-category.json'),
    severity: fixture('decision-severity.json'),
    core: fixture('decision-core_unavailable.json'),
  };
}

class FixtureAdapter implements DecisionAdapter {
  readonly id = 'jev' as const;
  readonly version = '1.0.0';
  async capabilities() {
    return { answerKinds: ['choice', 'ordinal-score', 'truth-probability'] as const,
      features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10,
      confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true, egress: { mode: 'none' as const } };
  }
  async evaluate(request: Parameters<DecisionAdapter['evaluate']>[0]) {
    const value = request.alias === 'severity' ? 0.25 : request.alias === 'core_unavailable' ? 0.05 : 'documentation';
    return { status: 'success' as const, reason: 'none' as const, value,
      uncertainty: { source: 'provider' as const, profile: request.alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1',
        calibration: 'vendor-claimed' as const, confidence: 0.9, distribution: null, calibrationRef: null },
      actualModel: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: 'fixture-request' };
  }
}

function tinyChampionChallenger(mutate: (record: DecisionChampionChallenger) => void = () => undefined) {
  const items = [{ id: 'a', input: { text: 'alpha' }, slice: 'all' }, { id: 'b', input: { text: 'beta' }, slice: 'all' }];
  const record = structuredClone(ccBase);
  record.inputSet = { ...record.inputSet, itemCount: items.length, digest: championChallengerInputSetDigest(items) };
  record.pairedMetrics = record.pairedMetrics.map(metric => ({ ...metric, minimumPairs: metric.metric === 'slice' ? 1 : 2 }));
  mutate(record);
  const registered = preregisterChampionChallengerThresholds(record);
  // Stands in for a completed shadow run whose deltas are the passing zeros most promotion tests use.
  const shadow = { status: 'completed' as const, pairedDeltas: registered.pairedMetrics.map(metric => ({ metric: metric.metric, delta: 0, pairs: metric.minimumPairs })),
    receipts: items.map(item => ({ itemId: item.id, champion: hash('a'), challenger: hash('c') })) };
  const promoteIntegrity = bindShadow(integrity('PROMOTE'), registered, shadow);
  return { record: bindIntegrity(registered, promoteIntegrity), items, promoteIntegrity };
}

function bindShadow(fields: QualificationIntegrityMetadata, record: DecisionChampionChallenger,
  shadow: Parameters<typeof championChallengerShadowBaseline>[1]): QualificationIntegrityMetadata {
  return { ...fields, paired_baseline: { id: 'champion-shadow', championChallengerShadow: championChallengerShadowBaseline(record, shadow) } };
}

/** Pins the record (and so its D09 eligibility) to exactly these integrity fields. */
function bindIntegrity(record: DecisionChampionChallenger, fields: QualificationIntegrityMetadata): DecisionChampionChallenger {
  return { ...record, evaluationIntegrityReport: { ...record.evaluationIntegrityReport, digest: ensembleContractDigest(fields) } };
}

function eligibility(record: DecisionChampionChallenger): PromotionEligibility {
  return {
    id: record.eligibilityId,
    alias: record.alias,
    candidateIdentityDigest: record.challenger.identityDigest,
    candidateActualModel: record.challenger.actualModel,
    evaluationIntegrityReport: record.evaluationIntegrityReport,
    approvalReference: record.approval.reference,
    rollbackTarget: record.rollbackTarget,
    eligible: true,
    reasons: [],
    recordedAt: '2026-09-05T00:00:00.000Z',
  };
}

function integrity(decision: IntegrityGateDecision): QualificationIntegrityMetadata {
  return {
    sample_n: 2,
    uncertainty: { method: 'paired-bootstrap', level: 0.95 },
    paired_baseline: { id: 'champion-shadow' },
    integrity_mode: 'isolated',
    fresh_workspace_required: true,
    fresh_workspace_verified: true,
    integrity_state: 'verified',
    trusted_score_source: 'signed-runner',
    compromise_labels: [],
    weak_signal_reason: null,
    release_gate: { decision, reasons: [] },
  };
}

describe('D17 ensemble runtime (#2611)', () => {
  it('is default-off and leaves existing decision evaluation byte-identical when unused', async () => {
    const binding = fixture<DecisionBinding>('binding-jev.json');
    const request = { ruleset: fixture('ruleset.json'), binding, definitions: definitions(), input: fixture('input.json'),
      runId: 'run', invocationId: 'baseline', adapters: { jev: new FixtureAdapter() } };
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const before = await evaluateDecisionRuleset(request);
      vi.setSystemTime(1_000);
      const disabled = await executeDecisionEnsemble(policies.get('triage-choice-ensemble')!, {
        invocationId: 'disabled',
        dispatch: async () => { throw new Error('dispatch should not run while disabled'); },
      });
      vi.setSystemTime(1_000);
      const after = await evaluateDecisionRuleset(request);
      expect(disabled).toMatchObject({ status: 'disabled', aggregate: null, memberResults: [] });
      expect(before).toMatchObject({
        apiVersion: 'decision.aiwg.io/v1alpha1',
        kind: 'RulesetResult',
        spec: { status: 'completed', reason: 'none', outcome: 'docs-review', matchedRules: ['docs'] },
      });
      expect(after).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ENS-RUN-01 enforces authorization, budget preflight, concurrency and retained member evidence', async () => {
    const policy = policies.get('triage-choice-ensemble')!;
    const spans: unknown[] = [];
    let active = 0;
    let maximum = 0;
    const calls: string[] = [];
    vi.useFakeTimers();
    try {
      const running = executeDecisionEnsemble(policy, {
        enabled: true,
        invocationId: 'ens-run',
        hostCeilings: [{ concurrency: 2 }],
        authorizeMember: member => {
          calls.push(`auth:${member.id}`);
          return true;
        },
        dispatch: async request => {
          calls.push(`dispatch:${request.member.id}`);
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise(resolve => setTimeout(resolve, request.member.id === 'jev-a' ? 20 : 5));
          active -= 1;
          return decisionResult(request.member, request.sampleIndex);
        },
        telemetry: { hook: { emit: span => { spans.push(span); } } },
      });
      await vi.advanceTimersByTimeAsync(25);
      const result = await running;
      expect(maximum).toBe(2);
      expect(calls.slice(0, 3)).toEqual(['auth:jev-a', 'auth:jev-c', 'auth:llm-b']);
      expect(result.aggregate?.outcome).toMatchObject({ disposition: 'accept', value: 'approve' });
      expect(Object.keys(result.retainedResults).sort()).toEqual(result.memberResults.map(item => item.resultDigest).sort());
      expect(spans).toHaveLength(1);
      expect(JSON.stringify(spans)).not.toContain('alpha');
      const exhausted = structuredClone(policy);
      exhausted.ceilings.concurrency = 1;
      let dispatched = 0;
      const budgeted = await executeDecisionEnsemble(exhausted, {
        enabled: true,
        invocationId: 'ens-budget',
        authorizeMember: () => true,
        dispatch: async request => {
          dispatched += 1;
          return withAttempts(request.member, request.sampleIndex, 1, { inputTokens: 40_000, outputTokens: 0, costUsd: 0.001 });
        },
      });
      expect(dispatched).toBe(1);
      expect(budgeted.aggregate?.outcome).toMatchObject({ disposition: 'defer', reason: 'insufficient-members' });
      expect(budgeted.memberResults.every(item => item.status === 'failed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ENS-RUN-02 refuses disallowed members and budget/unknown-cost violations before dispatch', async () => {
    const policy = policies.get('triage-choice-ensemble')!;
    let dispatched = false;
    await expect(executeDecisionEnsemble(policy, {
      enabled: true,
      invocationId: 'denied',
      authorizeMember: member => member.id !== 'llm-b',
      dispatch: async request => { dispatched = true; return decisionResult(request.member, request.sampleIndex); },
    })).rejects.toThrow(/authorization/);
    expect(dispatched).toBe(false);
    expect(() => validateEnsemblePolicy(policy, { hostCeilings: [{ attempts: 2 }] })).toThrow(/attempts demand/);
    const unknownCost = structuredClone(policy);
    unknownCost.members[0]!.estimate.costMicrosPerAttempt = null;
    expect(() => validateEnsemblePolicy(unknownCost)).toThrow(/unknown cost/);
    await expect(executeDecisionEnsemble(policy, {
      enabled: true,
      invocationId: 'missing-auth',
      dispatch: async request => decisionResult(request.member, request.sampleIndex),
    })).rejects.toThrow(/authorization callback is required/);
    await expect(executeDecisionEnsemble(policy, {
      enabled: true,
      invocationId: 'member-ceiling',
      hostCeilings: [{ members: 2 }],
      authorizeMember: () => true,
      dispatch: async request => decisionResult(request.member, request.sampleIndex),
    })).rejects.toThrow(/members demand/);
    await expect(executeDecisionEnsemble(policy, {
      enabled: true,
      invocationId: 'attempt-ceiling',
      hostCeilings: [{ attempts: 2 }],
      authorizeMember: () => true,
      dispatch: async request => decisionResult(request.member, request.sampleIndex),
    })).rejects.toThrow(/attempts demand/);
  });

  it('ENS-RUN-04 records timeout, dispatch, fallback-depth, token, cost and unknown-cost failures without rejecting', async () => {
    const policy = smallPolicy();
    vi.useFakeTimers();
    try {
      const timed = executeDecisionEnsemble(policy, {
        enabled: true,
        invocationId: 'timeout',
        authorizeMember: () => true,
        dispatch: async () => new Promise<DecisionResult>(resolve => setTimeout(() => resolve(decisionResult(policy.members[0]!, 0)), 100)),
        delay: (ms, signal) => new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true });
        }),
      });
      await vi.advanceTimersByTimeAsync(11);
      await expect(timed).resolves.toMatchObject({ status: 'completed', memberResults: [{ status: 'failed', value: null }] });
    } finally {
      vi.useRealTimers();
    }

    const cases: Array<{ name: string; result: (member: EnsembleMember) => DecisionResult; reason: string }> = [
      { name: 'dispatch', result: () => { throw new Error('transport down'); }, reason: 'service-error' },
      { name: 'fallback', result: member => withAttempts(member, 0, 2, { inputTokens: 1, outputTokens: 1, costUsd: 0.000001 }), reason: 'budget-exhausted' },
      { name: 'tokens', result: member => withAttempts(member, 0, 1, { inputTokens: 101, outputTokens: 0, costUsd: 0.000001 }), reason: 'budget-exhausted' },
      { name: 'cost', result: member => withAttempts(member, 0, 1, { inputTokens: 1, outputTokens: 1, costUsd: 0.000101 }), reason: 'budget-exhausted' },
      { name: 'unknown-cost', result: member => withAttempts(member, 0, 1, { inputTokens: 1, outputTokens: 1, costUsd: null }), reason: 'budget-exhausted' },
    ];
    // Real timers: give these cases a deadline they cannot hit, so a loaded host
    // cannot turn a dispatch or budget failure into a timeout. The timeout case
    // above keeps the 10ms deadline under fake timers.
    const untimed = smallPolicy({ ceilings: { ...policy.ceilings, deadlineMs: 60_000 } });
    for (const item of cases) {
      const result = await executeDecisionEnsemble(untimed, {
        enabled: true,
        invocationId: item.name,
        authorizeMember: () => true,
        dispatch: async request => item.result(request.member),
      });
      expect(result.memberResults).toEqual([expect.objectContaining({ status: 'failed', value: null })]);
      expect(Object.values(result.retainedResults)[0]?.spec).toMatchObject({ status: 'error', reason: item.reason });
      expect(Object.values(result.retainedResults)[0]?.spec.attempts.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.retainedResults)).not.toContain('undefined');
    }
  });

  it('ENS-RUN-05 emits unique telemetry IDs when no trace context is supplied', async () => {
    const spans: DecisionTelemetrySpan[] = [];
    for (const invocationId of ['span-a', 'span-b']) {
      await executeDecisionEnsemble(policies.get('triage-choice-ensemble')!, {
        invocationId,
        dispatch: async request => decisionResult(request.member, request.sampleIndex),
        telemetry: { hook: { emit: span => { spans.push(span); } } },
      });
    }
    expect(spans).toHaveLength(2);
    expect(new Set(spans.map(span => `${span.context.traceId}:${span.context.spanId}`)).size).toBe(2);
    expect(spans.every(span => span.context.traceId !== '11111111111111111111111111111111')).toBe(true);
  });

  it('DRF-RUN-01 runs paired shadow on identical immutable inputs and reports required deltas', async () => {
    const { record, items } = tinyChampionChallenger();
    const seen: string[] = [];
    const result = await runChampionChallengerShadow(record, {
      enabled: true,
      invocationId: 'shadow',
      items,
      eligibility: eligibility(record),
      aliasHistory: [{ revision: 1, alias: record.alias, actualIdentityDigest: record.champion.identityDigest,
        actualModel: record.champion.actualModel, recordedAt: '2026-09-01T00:00:00.000Z', kind: 'observed', promotionEligibilityId: null }],
      evaluate: async ({ role, item }): Promise<ChampionChallengerObservation> => {
        seen.push(`${item.id}:${role}:${ensembleContractDigest(item.input)}`);
        const challenger = role === 'challenger';
        return { inputDigest: ensembleContractDigest(item.input), receiptDigest: hash(challenger ? 'c' : 'a'),
          quality: challenger ? 0.91 : 0.9, calibration: challenger ? 0.051 : 0.05, riskCoverage: challenger ? 0.8 : 0.78,
          abstention: challenger ? 0.1 : 0.11, latencyMs: challenger ? 120 : 100, tokens: challenger ? 50 : 45,
          costMicros: challenger ? 20 : 15, slice: challenger ? 0.92 : 0.9 };
      },
    });
    expect(result.status).toBe('completed');
    expect(result.pairedDeltas.map(item => item.metric).sort()).toEqual(
      ['abstention', 'calibration', 'cost', 'latency', 'quality', 'risk-coverage', 'slice', 'tokens']);
    expect(result.pairedDeltas.find(item => item.metric === 'quality')).toEqual({ metric: 'quality', delta: 0.01, pairs: 2 });
    expect(seen[0]!.split(':').at(-1)).toBe(seen[1]!.split(':').at(-1));
  });

  it('DRF-RUN-02 gates promotion on D09 plus eval-integrity and rolls back only new run pins', () => {
    const { record, promoteIntegrity } = tinyChampionChallenger();
    const active = pinChampionForRun(record, 'active-run');
    const history: AliasEvent[] = [{ revision: 1, alias: record.alias, actualIdentityDigest: record.champion.identityDigest,
      actualModel: record.champion.actualModel, recordedAt: '2026-09-01T00:00:00.000Z', kind: 'observed', promotionEligibilityId: null }];
    const gateway = {
      aliasHistory: () => history,
      promotionEligibility: () => eligibility(record),
      promoteAlias: (eligibilityId: string, at: string) => {
        const event: AliasEvent = { revision: history.length + 1, alias: record.alias, actualIdentityDigest: record.challenger.identityDigest,
          actualModel: record.challenger.actualModel, recordedAt: at, kind: 'promoted', promotionEligibilityId: eligibilityId };
        history.push(event);
        return event;
      },
      rollbackAlias: (alias: string, targetRevision: number, approvalReference: string, at: string) => {
        const target = history.find(item => item.revision === targetRevision)!;
        const event: AliasEvent = { ...target, revision: history.length + 1, alias, recordedAt: at,
          kind: 'rolled-back', promotionEligibilityId: `rollback-approval:${approvalReference}` };
        history.push(event);
        return event;
      },
    };
    const deltas = record.pairedMetrics.map(metric => ({ metric: metric.metric, delta: metric.metric === 'quality' || metric.metric === 'slice' ? 0 : 0,
      pairs: metric.minimumPairs }));
    const report = buildEnsembleIntegrityReport({ record, integrity: promoteIntegrity, pairedDeltas: deltas, eligibility: eligibility(record) });
    const holdReport = buildEnsembleIntegrityReport({ record, integrity: integrity('HOLD'), pairedDeltas: deltas, eligibility: eligibility(record) });
    expect(() => promoteChampionChallenger({ record, integrityReport: holdReport, eligibility: eligibility(record), gateway, at: '2026-09-06T00:00:00.000Z' }))
      .toThrow(/promotion requires/);
    const forged = { ...holdReport, decision: 'PROMOTE' as const };
    expect(() => promoteChampionChallenger({ record, integrityReport: forged, eligibility: eligibility(record), gateway, at: '2026-09-06T00:00:00.000Z' }))
      .toThrow(/integrity report/);
    expect(promoteChampionChallenger({ record, integrityReport: report, eligibility: eligibility(record), gateway, at: '2026-09-06T00:00:00.000Z' }))
      .toMatchObject({ kind: 'promoted', actualIdentityDigest: record.challenger.identityDigest });
    expect(() => rollbackChampionForNewRuns({ record, gateway, approvalReference: ' ', at: '2026-09-07T00:00:00.000Z' }))
      .toThrow(/approval reference/);
    expect(rollbackChampionForNewRuns({ record, gateway, approvalReference: 'incident-1', at: '2026-09-07T00:00:00.000Z' }))
      .toMatchObject({ kind: 'rolled-back', actualIdentityDigest: record.champion.identityDigest });
    expect(active).toEqual({ runId: 'active-run', alias: record.alias, aliasRevision: 1,
      identityDigest: record.champion.identityDigest, actualModel: record.champion.actualModel });
    expect(history.map(item => item.kind)).toEqual(['observed', 'promoted', 'rolled-back']);
  });

  it('DRF-RUN-03 executes the exact configured drift response and rejects stale threshold versions', async () => {
    const signal: DriftSignal = { source: 'output-distribution', id: 'dist-1', alias: driftPolicy.alias,
      metric: 'population-stability-index-v1', valueBps: 3000, sampleN: 300, thresholdsVersion: driftPolicy.thresholds.version,
      observedAt: '2026-09-10T00:00:00.000Z' };
    const executed: string[] = [];
    const metrics = new BoundedDecisionMetrics();
    const { decision } = await executeDriftResponse(driftPolicy, signal, {
      'reduce-coverage': item => { executed.push(`${item.signalId}:${item.response}`); },
    }, { metrics });
    expect(decision).toMatchObject({ state: 'breached', response: 'reduce-coverage', evidence: 'unlabeled-distribution-warning' });
    expect(executed).toEqual(['dist-1:reduce-coverage']);
    expect(metrics.snapshot()).toEqual(expect.arrayContaining([{ name: 'decision.drift', value: 3000, dimensions: {} }]));
    await expect(executeDriftResponse(driftPolicy, signal, {})).rejects.toThrow(/no registered handler/);
    await expect(executeDriftResponse(driftPolicy, { ...signal, thresholdsVersion: 'old' })).rejects.toThrow(/different threshold/);
  });

  it('ENS-RUN-03 keeps agreement as a stability signal, not a calibration gate', async () => {
    const { cases } = readFixture<{ cases: Array<{ id: string; policy: string; results: EnsembleMemberResult[] }> }>('aggregation-vectors.v1.json');
    const shared = cases.find(item => item.id === 'ENS-SHARED-01')!;
    const aggregate = aggregateEnsembleResults(policies.get(shared.policy)!, shared.results);
    expect(aggregate.warnings).toEqual(expect.arrayContaining(['high-agreement-not-correctness', 'shared-systematic-error-risk']));
    expect(aggregate.correctnessGate.status).toBe('not-satisfied');
  });

  describe('round-2 review regressions', () => {
    const at = '2026-09-06T00:00:00.000Z';
    function aliasGateway(record: DecisionChampionChallenger) {
      const history: AliasEvent[] = [{ revision: 1, alias: record.alias, actualIdentityDigest: record.champion.identityDigest,
        actualModel: record.champion.actualModel, recordedAt: '2026-09-01T00:00:00.000Z', kind: 'observed', promotionEligibilityId: null }];
      const calls: string[] = [];
      return {
        history,
        calls,
        aliasHistory: () => history,
        promotionEligibility: () => eligibility(record),
        promoteAlias: (eligibilityId: string, when: string) => {
          calls.push(`promote:${eligibilityId}`);
          const event: AliasEvent = { revision: history.length + 1, alias: record.alias, actualIdentityDigest: record.challenger.identityDigest,
            actualModel: record.challenger.actualModel, recordedAt: when, kind: 'promoted', promotionEligibilityId: eligibilityId };
          history.push(event);
          return event;
        },
        rollbackAlias: (alias: string, targetRevision: number, approvalReference: string, when: string) => {
          calls.push(`rollback:${targetRevision}`);
          const target = history.find(item => item.revision === targetRevision)!;
          const event: AliasEvent = { ...target, revision: history.length + 1, alias, recordedAt: when,
            kind: 'rolled-back', promotionEligibilityId: `rollback-approval:${approvalReference}` };
          history.push(event);
          return event;
        },
      };
    }
    const passingDeltas = (record: DecisionChampionChallenger) => record.pairedMetrics.map(metric => ({ metric: metric.metric, delta: 0, pairs: metric.minimumPairs }));
    const redigest = <T extends { digest: string }>(report: T): T => {
      const { digest: _digest, ...payload } = report;
      return { ...payload, digest: ensembleContractDigest(payload) } as T;
    };

    it('R2-01 refuses the reviewer forgery: an honest HOLD relabelled PROMOTE with findings stripped and the digest recomputed', () => {
      const { record } = tinyChampionChallenger();
      const gateway = aliasGateway(record);
      const honestIntegrity: QualificationIntegrityMetadata = { ...integrity('PROMOTE'), integrity_state: 'unverified',
        trusted_score_source: 'local-unverified', weak_signal_reason: 'small-effect' };
      const honest = buildEnsembleIntegrityReport({ record, integrity: honestIntegrity, eligibility: eligibility(record),
        pairedDeltas: record.pairedMetrics.map(metric => ({ metric: metric.metric, delta: -999, pairs: metric.minimumPairs })) });
      expect(honest.decision).toBe('HOLD');
      const forged = redigest({ ...honest, findings: [], decision: 'PROMOTE' as const,
        pairedDeltas: honest.pairedDeltas.map(item => ({ ...item, passed: true })) });
      expect(() => promoteChampionChallenger({ record, integrityReport: forged, eligibility: eligibility(record), gateway, at })).toThrow();
      expect(gateway.calls).toEqual([]);
      expect(gateway.history).toHaveLength(1);
    });

    it('R2-02 rebuilds the report on promotion: loosened thresholds and a different integrity report cannot promote', () => {
      const { record, promoteIntegrity } = tinyChampionChallenger();
      const gateway = aliasGateway(record);
      const failing = buildEnsembleIntegrityReport({ record, integrity: integrity('PROMOTE'), eligibility: eligibility(record),
        pairedDeltas: record.pairedMetrics.map(metric => ({ metric: metric.metric, delta: metric.metric === 'quality' ? -0.5 : 0, pairs: metric.minimumPairs })) });
      expect(failing.findings).toEqual(['paired-delta-failed:quality']);
      const loosened = redigest({ ...failing, findings: [], decision: 'PROMOTE' as const,
        pairedDeltas: failing.pairedDeltas.map(item => item.metric === 'quality' ? { ...item, bound: -1, passed: true } : item) });
      expect(() => promoteChampionChallenger({ record, integrityReport: loosened, eligibility: eligibility(record), gateway, at }))
        .toThrow(/does not match the report rebuilt/);
      const otherIntegrity = buildEnsembleIntegrityReport({ record, integrity: { ...promoteIntegrity, sample_n: 3 },
        eligibility: eligibility(record), pairedDeltas: passingDeltas(record) });
      expect(otherIntegrity.decision).toBe('PROMOTE');
      expect(() => promoteChampionChallenger({ record, integrityReport: otherIntegrity, eligibility: eligibility(record), gateway, at }))
        .toThrow(/evaluation-integrity report digest/);
      expect(gateway.calls).toEqual([]);
      const honest = buildEnsembleIntegrityReport({ record, integrity: promoteIntegrity, eligibility: eligibility(record), pairedDeltas: passingDeltas(record) });
      expect(promoteChampionChallenger({ record, integrityReport: honest, eligibility: eligibility(record), gateway, at })).toMatchObject({ kind: 'promoted' });
    });

    it('R2-03 validator cross-checks findings, passed flags and decision against integrity and thresholds', () => {
      const { record } = tinyChampionChallenger();
      const base = buildEnsembleIntegrityReport({ record, integrity: integrity('PROMOTE'), eligibility: eligibility(record), pairedDeltas: passingDeltas(record) });
      const unverified = redigest({ ...base, integrity: { ...base.integrity, integrity_state: 'unverified' as const } });
      expect(() => validateEnsembleIntegrityReport(unverified)).toThrow(/integrity-not-verified/);
      const failedDelta = redigest({ ...base, pairedDeltas: base.pairedDeltas.map(item => item.metric === 'quality' ? { ...item, delta: -0.5 } : item) });
      expect(() => validateEnsembleIntegrityReport(failedDelta)).toThrow(/quality/);
      const lostFinding = redigest({ ...base, decision: 'HOLD' as const, pairedDeltas: base.pairedDeltas.map(item => item.metric === 'quality' ? { ...item, delta: -0.5, passed: false } : item) });
      expect(() => validateEnsembleIntegrityReport(lostFinding)).toThrow(/paired-delta-failed:quality/);
      const missingMetric = redigest({ ...base, pairedDeltas: base.pairedDeltas.filter(item => item.metric !== 'cost') });
      expect(() => validateEnsembleIntegrityReport(missingMetric)).toThrow(/every required metric/);
      const needlessHold = redigest({ ...base, decision: 'HOLD' as const });
      expect(() => validateEnsembleIntegrityReport(needlessHold)).toThrow(/decision/);
    });

    it('R2-04 reserves actual spend plus in-flight reservations before every dispatch', async () => {
      for (const usage of [{ inputTokens: 95, outputTokens: 0, costUsd: 0.000001 }, { inputTokens: 1, outputTokens: 0, costUsd: 0.000095 }]) {
        const policy = smallPolicy();
        policy.members[0]!.samples = 2;
        policy.ceilings = { ...policy.ceilings, attempts: 2 };
        let dispatched = 0;
        const result = await executeDecisionEnsemble(policy, {
          enabled: true,
          invocationId: 'reserve-actual',
          // Fixed clock and a deadline that never fires keep the budget assertions independent of host load.
          now: () => 0,
          delay: () => new Promise(() => undefined),
          authorizeMember: () => true,
          dispatch: async request => { dispatched += 1; return withAttempts(request.member, request.sampleIndex, 1, usage); },
        });
        // Sample 0 overran its 10-unit reservation (a budget violation), so sample 1 is never dispatched.
        expect(dispatched).toBe(1);
        expect(result.memberResults.map(item => item.status)).toEqual(['failed', 'failed']);
        expect(result.retainedResults[result.memberResults[1]!.resultDigest]?.spec).toMatchObject({ status: 'error', reason: 'budget-exhausted' });
      }
      const concurrent = smallPolicy();
      concurrent.members[0]!.samples = 3;
      concurrent.members[0]!.estimate.tokensPerAttempt = 40;
      concurrent.ceilings = { ...concurrent.ceilings, attempts: 3, concurrency: 2 };
      expect(() => validateEnsemblePolicy(concurrent)).toThrow(/tokens demand/);
      concurrent.ceilings.tokens = 120;
      const started: number[] = [];
      vi.useFakeTimers();
      try {
        const running = executeDecisionEnsemble(concurrent, {
          enabled: true,
          invocationId: 'reserve-in-flight',
          authorizeMember: () => true,
          delay: () => new Promise(() => undefined),
          dispatch: async request => {
            started.push(request.sampleIndex);
            await new Promise(resolve => setTimeout(resolve, request.sampleIndex === 0 ? 1 : 3));
            return withAttempts(request.member, request.sampleIndex, 1, { inputTokens: 70, outputTokens: 0, costUsd: 0.000001 });
          },
        });
        await vi.advanceTimersByTimeAsync(5);
        const result = await running;
        // Sample 0 overran its 40-token reservation while sample 1 was in flight; the overrun stops sample 2.
        expect(started).toEqual([0, 1]);
        expect(result.memberResults.map(item => item.status)).toEqual(['failed', 'failed', 'failed']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('R2-05 converts malformed member DecisionResults into failed members without losing completed members', async () => {
      const policy = structuredClone(policies.get('triage-choice-ensemble')!);
      policy.ceilings.concurrency = 1;
      const result = await executeDecisionEnsemble(policy, {
        enabled: true,
        invocationId: 'malformed',
        authorizeMember: () => true,
        dispatch: async request => {
          if (request.member.id === 'jev-a') return { spec: {} } as unknown as DecisionResult;
          const valid = decisionResult(request.member, request.sampleIndex);
          if (request.member.id === 'jev-c') (valid.spec.attempts[0] as { requestId: unknown }).requestId = undefined;
          return valid;
        },
      });
      expect(result.status).toBe('completed');
      expect(result.memberResults.map(item => [item.memberId, item.status])).toEqual([['jev-a', 'failed'], ['jev-c', 'failed'], ['llm-b', 'succeeded']]);
      for (const item of result.memberResults.slice(0, 2)) {
        expect(result.retainedResults[item.resultDigest]?.spec).toMatchObject({ status: 'error', reason: 'invalid-output' });
      }
      expect(result.retainedResults[result.memberResults[2]!.resultDigest]?.spec).toMatchObject({ status: 'success', value: 'approve' });
    });

    it('R2-06 charges a timed-out sample its reserved bound instead of discarding its usage', async () => {
      const policy = smallPolicy();
      const spans: DecisionTelemetrySpan[] = [];
      vi.useFakeTimers();
      try {
        const timed = executeDecisionEnsemble(policy, {
          enabled: true,
          invocationId: 'late-usage',
          authorizeMember: () => true,
          dispatch: async request => new Promise<DecisionResult>(resolve => setTimeout(() =>
            resolve(withAttempts(request.member, 0, 1, { inputTokens: 9, outputTokens: 0, costUsd: 0.000009 })), 100)),
          delay: (ms, signal) => new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true });
          }),
          telemetry: { hook: { emit: span => { spans.push(span); } } },
        });
        await vi.advanceTimersByTimeAsync(11);
        await expect(timed).resolves.toMatchObject({ memberResults: [{ status: 'failed' }] });
      } finally {
        vi.useRealTimers();
      }
      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes).toMatchObject({
        'aiwg.budget.attempts.actual': 1,
        'aiwg.budget.tokens.actual': 10,
        'aiwg.budget.cost_micros.actual': 10,
      });
    });

    it('R2-07 rollback refuses, without appending an event, unless the alias currently holds the promoted challenger', () => {
      const { record, promoteIntegrity } = tinyChampionChallenger();
      const gateway = aliasGateway(record);
      expect(() => rollbackChampionForNewRuns({ record, gateway, approvalReference: 'incident-1', at }))
        .toThrow(/promoted challenger/);
      expect(gateway.calls).toEqual([]);
      gateway.history.push({ revision: 2, alias: record.alias, actualIdentityDigest: hash('9'), actualModel: 'someone-else',
        recordedAt: at, kind: 'promoted', promotionEligibilityId: 'other-eligibility' });
      expect(() => rollbackChampionForNewRuns({ record, gateway, approvalReference: 'incident-1', at })).toThrow(/promoted challenger/);
      expect(gateway.calls).toEqual([]);
      gateway.history.pop();
      const report = buildEnsembleIntegrityReport({ record, integrity: promoteIntegrity, eligibility: eligibility(record), pairedDeltas: passingDeltas(record) });
      promoteChampionChallenger({ record, integrityReport: report, eligibility: eligibility(record), gateway, at });
      expect(rollbackChampionForNewRuns({ record, gateway, approvalReference: 'incident-1', at })).toMatchObject({ kind: 'rolled-back', revision: 3 });
      expect(() => rollbackChampionForNewRuns({ record, gateway, approvalReference: 'incident-2', at })).toThrow(/promoted challenger/);
      expect(gateway.history.map(item => item.kind)).toEqual(['observed', 'promoted', 'rolled-back']);
    });
  });

  describe('round-3 review regressions', () => {
    const at = '2026-09-06T00:00:00.000Z';
    const sha = (character: string) => `sha256:${character.repeat(64)}` as const;
    const identity = (actualModel: string): CalibrationIdentity => ({ provider: 'jev', backend: 'fixture', actualModel, primitive: 'choice',
      definitionDigest: sha('a'), adapterVersion: '1.0.0', dataset: { id: 'workflow', hash: sha('b') }, slice: { id: 'all', hash: sha('c') },
      calibrator: { id: 'isotonic', version: '1', parametersDigest: sha('d') } });
    const passing = (record: DecisionChampionChallenger) => record.pairedMetrics.map(metric => ({ metric: metric.metric, delta: 0, pairs: metric.minimumPairs }));
    /** A record whose roles use real D09 identity digests, so the real CalibrationRegistry can act as the gateway. */
    function registryScenario() {
      const champion = identity('jev-2026-09-01');
      const challenger = identity('jev-2026-10-01');
      const registry = new CalibrationRegistry();
      const scenario = tinyChampionChallenger(record => {
        record.champion = { ...record.champion, identityDigest: calibrationIdentityDigest(champion), actualModel: champion.actualModel, aliasRevision: 1 };
        record.challenger = { ...record.challenger, identityDigest: calibrationIdentityDigest(challenger), actualModel: challenger.actualModel };
        record.rollbackTarget = { aliasRevision: 1, identityDigest: calibrationIdentityDigest(champion) };
      });
      registry.observeAlias(scenario.record.alias, champion, '2026-09-01T00:00:00.000Z');
      return { ...scenario, registry, champion, challenger };
    }
    const report = (record: DecisionChampionChallenger, integrityFields: QualificationIntegrityMetadata) =>
      buildEnsembleIntegrityReport({ record, integrity: integrityFields, eligibility: eligibility(record), pairedDeltas: passing(record) });

    it('R3-01 (P9) validates the eligibility D09 actually promotes, not a caller-supplied copy', () => {
      const { record, registry, promoteIntegrity } = registryScenario();
      const heldIntegrity: QualificationIntegrityMetadata = { ...integrity('HOLD'), integrity_state: 'unverified' };
      registry.recordPromotionEligibility({ ...eligibility(record),
        evaluationIntegrityReport: { ...record.evaluationIntegrityReport, digest: ensembleContractDigest(heldIntegrity) } });
      expect(() => promoteChampionChallenger({ record, integrityReport: report(record, promoteIntegrity), eligibility: eligibility(record), gateway: registry, at }))
        .toThrow(/eligibility/);
      expect(registry.aliasHistory(record.alias).map(event => event.kind)).toEqual(['observed']);
    });

    it('R3-02 (P8) refuses to promote a stale record over a newer champion, in the runtime and in the D09 registry', () => {
      const { record, registry, promoteIntegrity } = registryScenario();
      registry.recordPromotionEligibility(eligibility(record));
      registry.observeAlias(record.alias, identity('jev-2026-09-15'), '2026-09-15T00:00:00.000Z');
      expect(() => promoteChampionChallenger({ record, integrityReport: report(record, promoteIntegrity), eligibility: eligibility(record), gateway: registry, at }))
        .toThrow(/champion/);
      expect(() => registry.promoteAlias(record.eligibilityId, at)).toThrow(/champion/);
      expect(registry.aliasHistory(record.alias).map(event => event.kind)).toEqual(['observed', 'observed']);
    });

    it('R3-03 (P12) rollback refuses when the promotion did not directly replace the pinned champion', () => {
      const { record } = tinyChampionChallenger();
      const history: AliasEvent[] = [
        { revision: 1, alias: record.alias, actualIdentityDigest: record.champion.identityDigest, actualModel: record.champion.actualModel,
          recordedAt: '2026-09-01T00:00:00.000Z', kind: 'observed', promotionEligibilityId: null },
        { revision: 2, alias: record.alias, actualIdentityDigest: hash('7'), actualModel: 'newer-champion',
          recordedAt: '2026-09-02T00:00:00.000Z', kind: 'observed', promotionEligibilityId: null },
        { revision: 3, alias: record.alias, actualIdentityDigest: record.challenger.identityDigest, actualModel: record.challenger.actualModel,
          recordedAt: '2026-09-03T00:00:00.000Z', kind: 'promoted', promotionEligibilityId: record.eligibilityId },
      ];
      const rollbackAlias = vi.fn();
      expect(() => rollbackChampionForNewRuns({ record, approvalReference: 'incident-1', at,
        gateway: { aliasHistory: () => history, promoteAlias: vi.fn(), rollbackAlias, promotionEligibility: () => eligibility(record) } }))
        .toThrow(/champion/);
      expect(rollbackAlias).not.toHaveBeenCalled();
    });

    it('R3-04 (P7) refuses to replay a promotion after an incident rollback', () => {
      const { record, registry, promoteIntegrity } = registryScenario();
      registry.recordPromotionEligibility(eligibility(record));
      const integrityReport = report(record, promoteIntegrity);
      promoteChampionChallenger({ record, integrityReport, eligibility: eligibility(record), gateway: registry, at });
      rollbackChampionForNewRuns({ record, gateway: registry, approvalReference: 'incident-1', at: '2026-09-07T00:00:00.000Z' });
      expect(() => promoteChampionChallenger({ record, integrityReport, eligibility: eligibility(record), gateway: registry, at: '2026-09-08T00:00:00.000Z' }))
        .toThrow();
      expect(() => registry.promoteAlias(record.eligibilityId, '2026-09-08T00:00:00.000Z')).toThrow();
      expect(registry.aliasHistory(record.alias).map(event => event.kind)).toEqual(['observed', 'promoted', 'rolled-back']);
    });

    it('R3-05 (P3) passes each call its reservation as a hard limit and treats overruns as budget violations that stop dispatch', async () => {
      const concurrent = smallPolicy();
      concurrent.members[0]!.samples = 3;
      concurrent.ceilings = { ...concurrent.ceilings, attempts: 3, concurrency: 3 };
      const limits: unknown[] = [];
      const spans: DecisionTelemetrySpan[] = [];
      const result = await executeDecisionEnsemble(concurrent, {
        enabled: true,
        invocationId: 'per-call-cap',
          // Fixed clock and a deadline that never fires keep the budget assertions independent of host load.
          now: () => 0,
          delay: () => new Promise(() => undefined),
        authorizeMember: () => true,
        dispatch: async request => {
          limits.push((request as { limits?: unknown }).limits);
          return withAttempts(request.member, request.sampleIndex, 1, { inputTokens: 95, outputTokens: 0, costUsd: 0.000001 });
        },
        telemetry: { hook: { emit: span => { spans.push(span); } } },
      });
      expect(limits).toEqual(Array.from({ length: 3 }, () => ({ attempts: 1, tokens: 10, costMicros: 10 })));
      expect(result.memberResults.map(item => item.status)).toEqual(['failed', 'failed', 'failed']);
      expect(result.aggregate?.outcome).toMatchObject({ disposition: 'defer' });
      expect(spans[0]!.attributes['aiwg.budget.tokens.actual']).toBe(285);

      const serial = smallPolicy();
      serial.members[0]!.samples = 4;
      serial.ceilings = { ...serial.ceilings, attempts: 4, tokens: 1000, costMicros: 1000, deadlineMs: 20 };
      let dispatched = 0;
      const stopped = await executeDecisionEnsemble(serial, {
        enabled: true,
        invocationId: 'overrun-stops',
          // Fixed clock and a deadline that never fires keep the budget assertions independent of host load.
          now: () => 0,
          delay: () => new Promise(() => undefined),
        authorizeMember: () => true,
        dispatch: async request => {
          dispatched += 1;
          return withAttempts(request.member, request.sampleIndex, 1, { inputTokens: 95, outputTokens: 0, costUsd: 0.000001 });
        },
      });
      expect(dispatched).toBe(1);
      expect(stopped.memberResults.every(item => item.status === 'failed')).toBe(true);
    });

    it('R3-06 (P10) refuses paired deltas that are not bound to a shadow run, and promotes deltas from a real one', async () => {
      const { record: unbound, items } = tinyChampionChallenger();
      const history: AliasEvent[] = [{ revision: 1, alias: unbound.alias, actualIdentityDigest: unbound.champion.identityDigest,
        actualModel: unbound.champion.actualModel, recordedAt: '2026-09-01T00:00:00.000Z', kind: 'observed', promotionEligibilityId: null }];
      const gatewayFor = (record: DecisionChampionChallenger) => ({ aliasHistory: () => history,
        promoteAlias: vi.fn((eligibilityId: string, when: string): AliasEvent => ({ revision: 2, alias: record.alias,
          actualIdentityDigest: record.challenger.identityDigest, actualModel: record.challenger.actualModel, recordedAt: when,
          kind: 'promoted', promotionEligibilityId: eligibilityId })),
        rollbackAlias: vi.fn(), promotionEligibility: () => eligibility(record) });
      // Fabricated: no shadow run at all, the approved integrity fields just name a baseline ID.
      const noShadow = { ...integrity('PROMOTE'), paired_baseline: { id: 'champion-shadow' } };
      const fabricated = bindIntegrity(unbound, noShadow);
      const fabricatedGateway = gatewayFor(fabricated);
      expect(() => promoteChampionChallenger({ record: fabricated, integrityReport: report(fabricated, noShadow), eligibility: eligibility(fabricated), at,
        gateway: fabricatedGateway })).toThrow(/shadow/);
      expect(fabricatedGateway.promoteAlias).not.toHaveBeenCalled();

      const shadow = await runChampionChallengerShadow(unbound, {
        enabled: true, invocationId: 'bound-shadow', items,
        evaluate: async ({ role, item }): Promise<ChampionChallengerObservation> => {
          const challenger = role === 'challenger';
          return { inputDigest: ensembleContractDigest(item.input), receiptDigest: hash(challenger ? 'c' : 'a'),
            quality: challenger ? 0.91 : 0.9, calibration: challenger ? 0.051 : 0.05, riskCoverage: challenger ? 0.8 : 0.78,
            abstention: challenger ? 0.1 : 0.11, latencyMs: challenger ? 120 : 100, tokens: challenger ? 50 : 45,
            costMicros: challenger ? 20 : 15, slice: challenger ? 0.92 : 0.9 };
        },
      });
      const shadowIntegrity = bindShadow(integrity('PROMOTE'), unbound, shadow);
      const record = bindIntegrity(unbound, shadowIntegrity);
      // Different (still passing) deltas than the shadow run produced are refused.
      const madeUp = buildEnsembleIntegrityReport({ record, integrity: shadowIntegrity, eligibility: eligibility(record), pairedDeltas: passing(record) });
      expect(madeUp.decision).toBe('PROMOTE');
      const gateway = gatewayFor(record);
      expect(() => promoteChampionChallenger({ record, integrityReport: madeUp, eligibility: eligibility(record), gateway, at })).toThrow(/shadow/);
      expect(gateway.promoteAlias).not.toHaveBeenCalled();
      const real = buildEnsembleIntegrityReport({ record, integrity: shadowIntegrity, eligibility: eligibility(record), pairedDeltas: shadow.pairedDeltas });
      expect(real.decision).toBe('PROMOTE');
      promoteChampionChallenger({ record, integrityReport: real, eligibility: eligibility(record), gateway, at });
      expect(gateway.promoteAlias).toHaveBeenCalledWith(record.eligibilityId, at);
    });
  });

  describe('pre-merge review regressions', () => {
    const at = '2026-09-06T00:00:00.000Z';

    it('PM-01 charges the full token reservation when a member reports null token usage and reports it as unknown', async () => {
      const policy = smallPolicy();
      policy.members[0]!.samples = 4;
      policy.ceilings = { ...policy.ceilings, attempts: 4, tokens: 40, costMicros: 40, deadlineMs: 20 };
      const spans: DecisionTelemetrySpan[] = [];
      const result = await executeDecisionEnsemble(policy, {
        enabled: true,
        invocationId: 'null-token-usage',
        authorizeMember: () => true,
        now: () => 0,
        delay: () => new Promise(() => undefined),
        dispatch: async request => withAttempts(request.member, request.sampleIndex, 1, { inputTokens: null, outputTokens: null, costUsd: 0.00001 }),
        telemetry: { hook: { emit: span => { spans.push(span); } } },
      });
      expect((result as { actuals?: unknown }).actuals).toEqual({ attempts: 4, tokens: 40, costMicros: 40, unknownUsageSamples: 4 });
      expect(spans[0]!.attributes).toMatchObject({ 'aiwg.budget.tokens.actual': 40, 'aiwg.budget.unknown_usage_samples': 4 });

      // Partially reported usage is charged at least the reservation, and a later overrun still stops dispatch.
      const partial = smallPolicy();
      partial.members[0]!.samples = 2;
      partial.ceilings = { ...partial.ceilings, attempts: 2 };
      let dispatched = 0;
      const stopped = await executeDecisionEnsemble(partial, {
        enabled: true,
        invocationId: 'partial-token-usage',
        authorizeMember: () => true,
        now: () => 0,
        delay: () => new Promise(() => undefined),
        dispatch: async request => {
          dispatched += 1;
          return withAttempts(request.member, request.sampleIndex, 1, { inputTokens: null, outputTokens: 95, costUsd: 0.000001 });
        },
      });
      expect(dispatched).toBe(1);
      expect(stopped.memberResults.map(item => item.status)).toEqual(['failed', 'failed']);
    });

    it('PM-02 refuses a promotion event that does not move the alias to this record\'s challenger', () => {
      const { record, promoteIntegrity } = tinyChampionChallenger();
      const history: AliasEvent[] = [{ revision: 1, alias: record.alias, actualIdentityDigest: record.champion.identityDigest,
        actualModel: record.champion.actualModel, recordedAt: '2026-09-01T00:00:00.000Z', kind: 'observed', promotionEligibilityId: null }];
      const integrityReport = buildEnsembleIntegrityReport({ record, integrity: promoteIntegrity, eligibility: eligibility(record),
        pairedDeltas: record.pairedMetrics.map(metric => ({ metric: metric.metric, delta: 0, pairs: metric.minimumPairs })) });
      const inconsistent = {
        aliasHistory: () => history,
        promotionEligibility: () => eligibility(record),
        rollbackAlias: vi.fn(),
        promoteAlias: (eligibilityId: string, when: string): AliasEvent => ({ revision: 2, alias: record.alias, actualIdentityDigest: hash('9'),
          actualModel: 'some-other-model', recordedAt: when, kind: 'promoted', promotionEligibilityId: eligibilityId }),
      };
      expect(() => promoteChampionChallenger({ record, integrityReport, eligibility: eligibility(record), gateway: inconsistent, at }))
        .toThrow(/promotion event/);
      const skipped = { ...inconsistent, promoteAlias: (eligibilityId: string, when: string): AliasEvent => ({ revision: 5, alias: record.alias,
        actualIdentityDigest: record.challenger.identityDigest, actualModel: record.challenger.actualModel, recordedAt: when, kind: 'promoted',
        promotionEligibilityId: eligibilityId }) };
      expect(() => promoteChampionChallenger({ record, integrityReport, eligibility: eligibility(record), gateway: skipped, at }))
        .toThrow(/promotion event/);
    });
  });
});
