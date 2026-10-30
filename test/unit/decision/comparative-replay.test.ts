import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../../../src/security/artifact-trust.js';
import { analyzeDecisionSensitivity } from '../../../src/decision/sensitivity/runtime.js';
import { checkSensitivitySchema, sensitivityDigest } from '../../../src/decision/sensitivity/contract.js';
import { buildComparativeReplayReport, validateComparativeReplayReport, type ComparativeReplayInput,
  type ComparativeReplayPreregistration } from '../../../src/decision/sensitivity/comparative.js';
import { readReplayArtifacts, replayFrozenCorpus, replayInput, replayPreregistration, writeReplayStudy, buildReplayReviewPackets } from '../../../tools/decision/comparative-replay.js';
import { validateReplayAssets, validateReplayFreeze, validateReplayReviewPackets } from '../../../tools/decision/comparative-replay-assets.js';
import { REPLAY_CLOCK, type ReplayGold } from '../../../tools/decision/comparative-replay-corpus.js';
import * as gates from '../../../src/gates/evaluate.js';
import { comparativeReplayGateInput } from '../../../src/decision/sensitivity/comparative-gates.js';
import { evidenceProvider } from '../../../src/gates/providers/index.js';

const frozenAt = '2026-09-30T12:00:00.000Z';
const accessedAt = '2026-09-30T12:00:01.000Z';
const state = () => ({ maxEntriesPerPrincipal: 600, reportsByWindow: new Map<string, number>(), pathCounts: new Map<string, number>() });
const artifacts = readReplayArtifacts();
let input: ComparativeReplayInput;
let boundReport: ReturnType<typeof buildComparativeReplayReport>;
const retained = JSON.parse(readFileSync(resolve(import.meta.dirname,
  '../../../docs/decision/evidence/comparative-replay-v1/report.json'), 'utf8')) as typeof boundReport;
const temporary = mkdtempSync(resolve(tmpdir(), 'd23-replay-'));
afterAll(() => { rmSync(temporary, { recursive: true, force: true }); });

function seal<T extends { digest: string }>(value: T): void {
  const { digest: _digest, ...payload } = value;
  value.digest = sensitivityDigest(payload);
}
function policy(change: Partial<ComparativeReplayPreregistration>, source = input): ComparativeReplayInput {
  const candidate = structuredClone(source);
  Object.assign(candidate.preregistration, change);
  seal(candidate.preregistration);
  candidate.trustedPreregistrationDigest = candidate.preregistration.digest;
  return candidate;
}
function resealReport(candidate: ComparativeReplayInput, index: number): void {
  const root = candidate.roots[index]!;
  seal(root.report);
  root.trustedReportDigest = root.report.digest;
  root.reproductionDigest = root.report.digest;
}
// A constructed report is only a gate unit fixture, never retained as measured evidence.
function perfectGateFixture(): ComparativeReplayInput {
  const candidate = structuredClone(input);
  candidate.roots.forEach((root, index) => {
    const { unreplayable: _unreplayable, ...deltas } = root.gold;
    Object.assign(root.report.rows[0]!.deltas, deltas);
    resealReport(candidate, index);
  });
  return candidate;
}

// Replays all 600 roots twice; give the same CI headroom as the durable
// replay test below rather than the default 30s hook deadline.
beforeAll(async () => {
  const transport = vi.fn(() => { throw new Error('provider dispatch forbidden'); });
  vi.stubGlobal('fetch', transport);
  try {
    const reserve = vi.fn();
    const complete = vi.fn();
    const run = await replayFrozenCorpus(artifacts, state(), { reserve, complete });
    expect(reserve).toHaveBeenCalledTimes(artifacts.corpus.roots.length * 2);
    expect(complete).toHaveBeenCalledTimes(artifacts.corpus.roots.length * 2);
    expect(run.stopped).toBe(false);
    expect(transport).not.toHaveBeenCalled();
    input = replayInput(artifacts, replayPreregistration(artifacts, frozenAt), run.roots, accessedAt);
    boundReport = buildComparativeReplayReport(input);
  } finally { vi.unstubAllGlobals(); }
}, 120_000);

describe('D23 comparative policy replay', () => {
  it.each(artifacts.corpus.roots.map(root => [root.id]))('preserves the retained binding result for %s', id => {
    const actual = boundReport.roots.find(root => root.id === id);
    const expected = retained.roots.find(root => root.id === id);
    expect(expected).toBeDefined();
    expect(actual).toEqual(expected);
    expect(actual?.correct).toBe(true);
    expect(actual?.falseNoChange).toBe(false);
  });

  it('gets report decisions from evaluateGates and responds to a binding threshold mutation', () => {
    const evaluate = gates.evaluateGates;
    const spy = vi.spyOn(gates, 'evaluateGates').mockImplementation(context => {
      context.binding.spec.parameters['project:d23-comparative-replay.maxErrorUpperBps'] = 95;
      context.trustedBindingDigest = sensitivityDigest(context.binding);
      context.holdout = gates.sealGateHoldout({ frozenDigest: context.trustedBindingDigest, firstAccessedAt: accessedAt });
      return evaluate(context);
    });
    try {
      const changed = buildComparativeReplayReport(input);
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.results[0]!.value).toMatchObject({ kind: 'GateReport', decision: changed.decision });
      expect(boundReport.diagnosticDecision).toBe('pass');
      expect(changed.diagnosticDecision).toBe('fail');
      expect(changed.findings).toContain('error-bound-failed');
      expect(changed.decision).toBe('HOLD');
    } finally { spy.mockRestore(); }
  });

  it('changes the evaluator verdict when a binding threshold is tightened under synthetic completed review', () => {
    const candidate = perfectGateFixture();
    Object.assign(candidate.integrity, { integrity_mode: 'locked', integrity_state: 'verified',
      trusted_score_source: 'locked-artifact-snapshot', weak_signal_reason: null,
      release_gate: { decision: 'PROMOTE', reasons: [] } });
    candidate.trustedIntegrityDigest = sensitivityDigest(candidate.integrity);
    const report = buildComparativeReplayReport(candidate);
    const context = comparativeReplayGateInput(candidate, report.roots, report.metrics, new Set());
    // This raw evaluator fixture is deliberately synthetic. Production D23 review ingestion still refuses.
    const review = context.metrics.providers[evidenceProvider.id]!.metrics.attestations!.pooled!.available!
      .find(item => item.id === 'reviewer-audit-pending')!;
    review.passed = true;
    expect(gates.evaluateGates(context).decision).toBe('PROMOTE');
    context.binding.spec.parameters['project:d23-comparative-replay.maxErrorUpperBps'] = 95;
    expect(() => gates.evaluateGates(context)).toThrow(/digest/);
    context.trustedBindingDigest = sensitivityDigest(context.binding);
    context.holdout = gates.sealGateHoldout({ frozenDigest: context.trustedBindingDigest, firstAccessedAt: accessedAt });
    const changed = gates.evaluateGates(context);
    expect(changed.decision).toBe('HOLD');
    expect(changed.gateEvidence.find(item => item.gateId === 'error-bound-failed')).toMatchObject({
      status: 'fail', threshold: { resolved: 95 }, statistic: { upperBps: 96 },
    });
    expect(report.decision).toBe('HOLD');
    expect(report.findings).toContain('reviewer-audit-pending');
  });

  it.each([
    ['verified review pending', {}, 'HOLD'],
    ['upstream hold', { release_gate: { decision: 'HOLD', reasons: [] } }, 'HOLD'],
    ['upstream rollback', { release_gate: { decision: 'ROLLBACK', reasons: [] } }, 'ROLLBACK'],
    ['compromise state', { integrity_state: 'compromised' }, 'ROLLBACK'],
    ['compromise label', { compromise_labels: ['fixture_edit'] }, 'ROLLBACK'],
    ['unverified', { integrity_state: 'unverified' }, 'HOLD'],
    ['unknown mode', { integrity_mode: 'unknown' }, 'HOLD'],
    ['unknown source', { trusted_score_source: 'unknown' }, 'HOLD'],
    ['fresh workspace missing', { fresh_workspace_required: true, fresh_workspace_verified: false }, 'HOLD'],
    ['uncertainty missing', { uncertainty: null }, 'HOLD'],
    ['baseline missing', { paired_baseline: null }, 'HOLD'],
    ['sample mismatch', { sample_n: 399 }, 'HOLD'],
  ] as const)('keeps the binding integrity ceiling for %s', (_name, integrity, decision) => {
    const candidate = perfectGateFixture();
    Object.assign(candidate.integrity, { integrity_mode: 'locked', integrity_state: 'verified',
      trusted_score_source: 'locked-artifact-snapshot', weak_signal_reason: null,
      release_gate: { decision: 'PROMOTE', reasons: [] } }, integrity);
    candidate.trustedIntegrityDigest = sensitivityDigest(candidate.integrity);
    const report = buildComparativeReplayReport(candidate);
    const context = comparativeReplayGateInput(candidate, report.roots, report.metrics, new Set());
    expect(report.diagnosticDecision).toBe('pass');
    expect(gates.evaluateGates(context).decision).toBe(decision);
    expect(report.decision).toBe(decision);
    expect(context.binding.kind).toBe('GateBinding');
  });

  it('binds 600 unique synthetic roots and passes threshold equality while integrity stays HOLD', () => {
    expect(artifacts.corpus.deduplication).toEqual({ roots: 600, payloads: 600, duplicatePayloads: 0,
      sourceInputs: 600, duplicateSourceInputs: 0, crossSplitFamilies: 0 });
    const report = buildComparativeReplayReport(input);
    expect(report.roots).toHaveLength(600);
    expect(report.metrics.testRoots).toBe(400);
    expect(report.metrics.errors).toBe(0);
    expect(report.roots.filter(root => root.split === 'test' && !root.correct)).toEqual([]);
    for (const id of ['d23-test-threshold-boundary-041', 'd23-test-threshold-boundary-083']) {
      expect(report.roots.find(root => root.id === id)?.correct).toBe(true);
    }
    expect(report.metrics.falseNoChange).toBe(0);
    expect(report.metrics).toMatchObject({ backendCalls: 0, tokens: 0, costMicros: 0, exactReproduction: true });
    expect(report.diagnosticDecision).toBe('pass');
    expect(report.decision).toBe('HOLD');
    expect(report.integrity).toEqual(input.integrity);
    expect(report.findings).toContain('reviewer-audit-pending');
    expect(report.findings).toContain('upstream-integrity-hold');
    expect(report.findings).not.toContain('error-bound-failed');
    validateComparativeReplayReport(report, input);
  });

  it('reconstructs the retained report exactly from the frozen corpus and local access record', () => {
    const directory = resolve(import.meta.dirname, '../../../docs/decision/evidence/comparative-replay-v1');
    const read = (name: string) => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
    const plan = read('preregistration.json');
    const reconstructed = buildComparativeReplayReport(replayInput(artifacts, plan, input.roots, read('access.json').accessedAt));
    expect(canonicalJson(reconstructed)).toBe(canonicalJson(read('report.json')));
  });

  it('rebuilds blinded contextual packets and rejects extra review/freeze fields', () => {
    const directory = resolve(import.meta.dirname, '../../../docs/decision/evidence/comparative-replay-v1');
    const read = (name: string) => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
    const packets = buildReplayReviewPackets(artifacts, input.roots);
    expect(canonicalJson(packets)).toBe(canonicalJson(read('review-packets.json')));
    expect(() => validateReplayReviewPackets({ ...packets, approved: true })).toThrow(/invalid replay/);
    expect(() => validateReplayFreeze({ ...read('freeze-manifest.json'), verified: true })).toThrow(/invalid replay/);
  });

  it('uses independently fixed gold for exact threshold, priority, control and unreplayable semantics', () => {
    const gold = new Map(artifacts.gold.roots.map(root => [root.id, root.gold]));
    const expected: Array<[string, ReplayGold]> = [
      ['threshold-boundary-002', { status: 'completed', outcomeChanged: false, acceptanceChanged: false, ruleChanged: false, unreplayable: false }],
      ['threshold-boundary-003', { status: 'review', outcomeChanged: true, acceptanceChanged: true, ruleChanged: true, unreplayable: false }],
      ['priority-loss-001', { status: 'completed', outcomeChanged: true, acceptanceChanged: false, ruleChanged: true, unreplayable: false }],
      ['priority-loss-002', { status: 'completed', outcomeChanged: true, acceptanceChanged: false, ruleChanged: false, unreplayable: false }],
      ['unchanged-control-001', { status: 'completed', outcomeChanged: false, acceptanceChanged: false, ruleChanged: false, unreplayable: false }],
      ['unreplayable-001', { status: 'completed', outcomeChanged: false, acceptanceChanged: false, ruleChanged: false, unreplayable: true }],
    ];
    for (const [suffix, value] of expected) expect(gold.get(`d23-test-${suffix}`)).toEqual(value);
  });

  it('applies the registered confidence level, CI method, NI margin, error caps and slice support', () => {
    const perfect = perfectGateFixture();
    const report = buildComparativeReplayReport(perfect);
    expect(report.diagnosticDecision).toBe('pass');
    expect(report.metrics).toMatchObject({ pairedLowerBps: -96, errorUpperBps: 96 });
    expect(report.metrics.slices['threshold-boundary']).toEqual({ roots: 100, errors: 0, errorUpperBps: 370 });
    for (const [change, finding] of [
      [{ nonInferiorityMarginBps: -95 }, 'non-inferiority-failed'],
      [{ maxErrorUpperBps: 95 }, 'error-bound-failed'],
      [{ maxSliceErrorUpperBps: 369 }, 'slice-failed:threshold-boundary'],
      [{ minimumTestRoots: 404, minimumSliceRoots: 101 }, 'slice-failed:unchanged-control'],
      [{ levelBps: 9900 }, 'non-inferiority-failed'],
    ] as Array<[Partial<ComparativeReplayPreregistration>, string]>) {
      const failed = buildComparativeReplayReport(policy(change, perfect));
      expect(failed.diagnosticDecision).toBe('fail');
      expect(failed.findings).toContain(finding);
      expect(failed.decision).not.toBe('PROMOTE');
    }
    expect(() => buildComparativeReplayReport(policy({ pairedMethod: 'tango' as 'newcombe-10' }, perfect))).toThrow(/schema/);
  });

  it('fails exact-match and false-no-change gates even when statistical thresholds are relaxed', () => {
    const candidate = policy({ maxErrorUpperBps: 10000, maxSliceErrorUpperBps: 10000, nonInferiorityMarginBps: -10000 }, perfectGateFixture());
    const index = candidate.roots.findIndex(root => root.split === 'test' && root.gold.unreplayable);
    candidate.roots[index]!.report.rows[0]!.inference = 'reused-stored-evidence';
    resealReport(candidate, index);
    const report = buildComparativeReplayReport(candidate);
    expect(report.metrics.falseNoChange).toBe(1);
    expect(report.findings).toContain('false-no-change');
    expect(report.diagnosticDecision).toBe('fail');
    expect(report.decision).toBe('HOLD');
  });

  it.each(['backendCalls', 'tokens', 'costMicros'] as const)('rejects nonzero %s including development consumption', resource => {
    const candidate = perfectGateFixture();
    candidate.roots[0]!.report.budget[resource] = 1;
    resealReport(candidate, 0);
    const report = buildComparativeReplayReport(candidate);
    expect(report.findings).toContain('zero-call-budget-violated');
    expect(report.diagnosticDecision).toBe('fail');
    expect(report.decision).not.toBe('PROMOTE');
  });

  it('fails on unknown cost, concealed row spend, new inference and development reproduction mismatch', () => {
    const unknown = structuredClone(input);
    (unknown.roots[0]!.report.budget as unknown as { costMicros: null }).costMicros = null;
    resealReport(unknown, 0);
    expect(() => buildComparativeReplayReport(unknown)).toThrow(/schema/);
    const concealed = perfectGateFixture();
    concealed.roots[0]!.report.rows[0]!.resourceUse.costMicros = 1;
    resealReport(concealed, 0);
    expect(buildComparativeReplayReport(concealed).findings).toContain(`not-zero-call-policy-replay:${concealed.roots[0]!.id}`);
    const invoked = perfectGateFixture();
    invoked.roots[0]!.report.rows[0]!.inference = 'new-invocation';
    invoked.roots[0]!.report.rows[0]!.freshInvocationId = 'synthetic-unapproved';
    resealReport(invoked, 0);
    expect(buildComparativeReplayReport(invoked).diagnosticDecision).toBe('fail');
    const changed = perfectGateFixture();
    changed.roots[0]!.reproductionDigest = sensitivityDigest('different');
    expect(buildComparativeReplayReport(changed).findings).toContain('reproduction-mismatch');
  });

  it.each(['HOLD', 'ROLLBACK'] as const)('never upgrades upstream %s after perfect synthetic diagnostics', decision => {
    const candidate = perfectGateFixture();
    Object.assign(candidate.integrity, { integrity_mode: 'locked', integrity_state: 'verified', trusted_score_source: 'locked-artifact-snapshot', weak_signal_reason: null });
    candidate.integrity.release_gate.decision = decision;
    candidate.trustedIntegrityDigest = sensitivityDigest(candidate.integrity);
    const report = buildComparativeReplayReport(candidate);
    expect(report.diagnosticDecision).toBe('pass');
    expect(report.upstreamDecision).toBe(decision);
    expect(report.decision).toBe(decision);
  });

  it('rejects spread-forged integrity, unknown sources, missing metadata, and forged final reports', () => {
    const candidate = perfectGateFixture();
    candidate.integrity = { ...candidate.integrity, integrity_state: 'verified' };
    expect(() => buildComparativeReplayReport(candidate)).toThrow(/untrusted eval-integrity/);
    candidate.trustedIntegrityDigest = sensitivityDigest(candidate.integrity);
    const report = buildComparativeReplayReport(candidate);
    expect(report.findings).toContain('integrity-mode-not-allowlisted');
    expect(report.decision).toBe('HOLD');
    expect(() => validateComparativeReplayReport({ ...report, decision: 'PROMOTE' }, candidate)).toThrow(/differs/);
    delete (candidate.integrity as unknown as Record<string, unknown>).uncertainty;
    expect(() => buildComparativeReplayReport(candidate)).toThrow(/schema/);
  });

  it('rejects changed gold, missing roots, membership substitutions, source reuse and stale access', () => {
    const gold = structuredClone(input);
    gold.roots[0]!.gold.ruleChanged = !gold.roots[0]!.gold.ruleChanged;
    expect(() => buildComparativeReplayReport(gold)).toThrow(/gold mismatch/);
    const missing = structuredClone(input);
    missing.roots.pop();
    expect(() => buildComparativeReplayReport(missing)).toThrow(/membership/);
    const swapped = structuredClone(input);
    swapped.roots[0]!.slice = 'unreplayable';
    expect(() => buildComparativeReplayReport(swapped)).toThrow(/membership/);
    const reused = structuredClone(input);
    reused.roots[1]!.sourceResultDigest = reused.roots[0]!.sourceResultDigest;
    expect(() => buildComparativeReplayReport(reused)).toThrow(/duplicate source/);
    expect(() => buildComparativeReplayReport({ ...input, accessedAt: frozenAt })).toThrow(/follow preregistration/);
    expect(() => buildComparativeReplayReport({ ...input, trustedPreregistrationDigest: sensitivityDigest('forged') })).toThrow(/untrusted/);
  });

  it('enforces closed schemas and binds source report digests to the frozen plan', () => {
    expect(() => checkSensitivitySchema('comparativePlan', { ...input.preregistration, ignoredGate: 1 })).toThrow(/schema/);
    const candidate = structuredClone(input);
    candidate.roots[0]!.report.plan.digest = sensitivityDigest('another-plan');
    resealReport(candidate, 0);
    expect(buildComparativeReplayReport(candidate).findings).toContain(`report-invalid:${candidate.roots[0]!.id}`);
    candidate.roots[0]!.report.rows[0]!.deltas.status = 'forged';
    expect(() => buildComparativeReplayReport(candidate)).toThrow(/digest/);
  });

  it('rejects closed asset-envelope drift and modified request payloads before replay', () => {
    for (const name of ['corpus', 'gold', 'split', 'auditSample'] as const) {
      const candidate = structuredClone(artifacts);
      Object.assign(candidate[name], { undeclared: true });
      expect(() => validateReplayAssets(candidate)).toThrow(/invalid replay/);
    }
    const changed = structuredClone(artifacts);
    (changed.corpus.roots[0]!.request.sourceInput as { quantity: number }).quantity += 1;
    expect(() => validateReplayAssets(changed)).toThrow(/binding differs/);
  });

  it('retains 44 pending assessments with exactly four delayed repeats and two protocol/report reviews', () => {
    const sample = artifacts.auditSample;
    expect(sample.assessments).toHaveLength(44);
    expect(new Set(sample.assessments.map(item => item.assessmentId)).size).toBe(44);
    expect(new Set(sample.assessments.filter(item => item.phase === 'development').map(item => item.rootId)).size).toBe(20);
    expect(new Set(sample.assessments.filter(item => item.phase === 'holdout').map(item => item.rootId)).size).toBe(20);
    for (const repeat of sample.assessments.filter(item => item.repeatOf)) {
      expect(sample.assessments.find(item => item.assessmentId === repeat.repeatOf)?.rootId).toBe(repeat.rootId);
    }
    expect(sample.assessments.filter(item => item.repeatOf)).toHaveLength(4);
    expect(sample.artifactReviews).toHaveLength(2);
    expect(sample.reviewer).toBeNull();
    expect(sample.completedAt).toBeNull();
  });

  it('keeps completed evidence on cancellation and reserves each replay before completion', async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const run = await replayFrozenCorpus(artifacts, state(), {
      reserve: (id, repetition) => events.push(`reserve:${id}:${repetition}`),
      complete: (id, repetition) => { events.push(`complete:${id}:${repetition}`); if (repetition === 1) setImmediate(() => controller.abort()); },
    }, controller.signal);
    expect(run.stopped).toBe(true);
    expect(run.roots).toHaveLength(1);
    expect(events.map(item => item.split(':')[0])).toEqual(['reserve', 'complete', 'reserve', 'complete']);
    expect(run.roots[0]!.report.status).toBe('completed');
  });

  it('reports timeout and probe exhaustion without changing the completed stored results', async () => {
    const request = structuredClone(artifacts.corpus.roots[0]!.request);
    const clock = Date.parse(REPLAY_CLOCK);
    let ticks = 0;
    const timed = await analyzeDecisionSensitivity({ ...request, probeState: state(),
      now: () => clock + (++ticks >= 4 ? request.plan.budgets.deadlineMs : 0) });
    expect(timed.status).toBe('budget-exhausted');
    expect(timed.rows).toHaveLength(0);
    const shared = state();
    const original = await analyzeDecisionSensitivity({ ...request, probeState: shared, now: () => clock });
    const bytes = canonicalJson(original);
    await analyzeDecisionSensitivity({ ...request, probeState: shared, now: () => clock });
    const exhausted = await analyzeDecisionSensitivity({ ...request, probeState: shared, now: () => clock });
    expect(exhausted.status).toBe('rejected');
    expect(exhausted.rows).toHaveLength(0);
    expect(exhausted.budget.backendCalls).toBe(0);
    expect(canonicalJson(original)).toBe(bytes);
    const candidate = structuredClone(input);
    candidate.roots[0]!.report = timed;
    resealReport(candidate, 0);
    expect(buildComparativeReplayReport(candidate).diagnosticDecision).toBe('fail');
  });

  it('preserves stored bytes in disabled mode and produces no inference', async () => {
    const request = structuredClone(artifacts.corpus.roots[0]!.request);
    request.plan.mode = 'disabled';
    const before = canonicalJson(request);
    const reevaluate = vi.fn();
    const report = await analyzeDecisionSensitivity({ ...request, now: () => Date.parse(REPLAY_CLOCK), probeState: state(), reevaluate });
    expect(report.status).toBe('rejected');
    expect(report.rows).toEqual([]);
    expect(reevaluate).not.toHaveBeenCalled();
    expect(canonicalJson(request)).toBe(before);
  });

  it('writes an offline reviewable HOLD report and durable reservation evidence without allowing a restart reset', async () => {
    const directory = resolve(temporary, 'study');
    await writeReplayStudy(directory);
    const report = JSON.parse(readFileSync(resolve(directory, 'comparative-report.json'), 'utf8'));
    const binding = JSON.parse(readFileSync(resolve(directory, 'gate-binding.json'), 'utf8'));
    const gateReport = JSON.parse(readFileSync(resolve(directory, 'gate-report.json'), 'utf8'));
    expect(binding.kind).toBe('GateBinding');
    expect(gateReport).toMatchObject({ kind: 'GateReport', decision: report.decision,
      binding: { digest: sensitivityDigest(binding) } });
    expect(gateReport.gateEvidence.find((item: { gateId: string }) => item.gateId === 'reviewer-audit-pending'))
      .toMatchObject({ status: 'fail', outcome: 'HOLD' });
    expect(report.decision).toBe('HOLD');
    expect(report.metrics.errors).toBe(0);
    expect(report.diagnosticDecision).toBe('pass');
    const ledger = readFileSync(resolve(directory, 'probe-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(ledger.filter(item => item.kind === 'reserved')).toHaveLength(1200);
    expect(ledger.filter(item => item.kind === 'completed')).toHaveLength(1200);
    await expect(writeReplayStudy(directory)).rejects.toThrow(/EEXIST/);
    const packets = JSON.parse(readFileSync(resolve(directory, 'review-packets.json'), 'utf8'));
    expect(packets.packets).toHaveLength(44);
    expect(Object.keys(packets.packets[0])).toEqual(['assessmentId', 'context', 'A', 'B']);
    expect(packets.packets[0].context.changes).toHaveLength(1);
    expect(packets.packets[0].context.rules).toHaveLength(2);
    expect(JSON.stringify(packets)).not.toContain('d23-test-');
    // 1,200 durable ledger appends: ~3.8s idle and ~6.3s under CPU contention locally, but over 30s on a loaded CI
    // runner. 120s keeps ~4x headroom over the observed CI time without trimming the asserted evidence.
  }, 120_000);
});

it('preserves the D23 verdict table across upstream, compromise and finding inputs (#2829)', () => {
  for (const upstream of ['PROMOTE', 'HOLD', 'ROLLBACK'] as const) for (const compromised of [false, true]) {
    const integrity = { ...input.integrity, integrity_state: compromised ? 'compromised' : 'verified',
      release_gate: { decision: upstream, reasons: [] }, compromise_labels: compromised ? ['fixture_edit'] : [] };
    const bound = { ...input, integrity, trustedIntegrityDigest: sensitivityDigest(integrity) };
    const report = buildComparativeReplayReport(bound);
    // Operator audit remains pending for this replay study, so the clean case holds.
    expect(report.decision).toBe(upstream === 'ROLLBACK' || compromised ? 'ROLLBACK' : 'HOLD');
    expect(() => validateComparativeReplayReport(report, bound)).not.toThrow();
  }
});
