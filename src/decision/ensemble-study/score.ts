import { ceilingDecision } from '../../gates/lattice.js';
import { heldoutDigest, validateHeldoutAttempt, validateHeldoutInputs } from '../heldout/contract.js';
import type { HeldoutStudyModule, Digest, HeldoutRow, HeldoutAttempt } from '../heldout/types.js';
import { artifactPin } from '../validate.js';
import { aggregateEnsembleResults } from '../ensemble/aggregate.js';
import { validateChampionChallenger, pairedThresholdsDigest } from '../ensemble/contract.js';
import { buildEnsembleIntegrityReport } from '../ensemble/report.js';
import { championChallengerInputSetDigest, championChallengerShadowBaseline, runChampionChallengerShadow } from '../ensemble/runtime.js';
import type { ChampionChallengerObservation } from '../ensemble/runtime.js';
import type { DecisionChampionChallenger, DecisionEnsemblePolicy, EnsembleMemberResult } from '../ensemble/types.js';
import { qualificationIntegrityAllowlistProblems } from '../qualification/release.js';
import type { QualificationIntegrityMetadata } from '../qualification/release.js';
import { evaluateBinaryHeldout, freezeQualificationSplit } from '../qualification/quality.js';
import { D17_ANALYSIS } from './protocol.js';
import { d17StudyDecision, evaluateD17Statistics } from './gates.js';
import { d17Statistics, type D17ArmMeasurement, type D17Pair } from './statistics.js';
import type { prepareD17Study } from './corpus.js';
import type { prepareD17StagedStudy } from './staged.js';
import { validateD17Artifact } from './artifacts.js';
import { applyD17Mapping, assertD17Staged, d17AttemptsByRow, d17RawProbabilities, verifyD17CalibrationSet } from './calibration.js';
import type { D17CalibrationContext } from './calibration.js';
import { calibrationIdentityDigest } from '../calibration/registry.js';
import type { PromotionEligibility } from '../calibration/types.js';
import type { ChampionAliasGateway } from '../ensemble/runtime.js';
import { canonicalJson } from '../../security/artifact-trust.js';

type ScoreInput = Parameters<HeldoutStudyModule['score']>[0];
type Prepared = ReturnType<typeof prepareD17Study>;
type StagedPrepared = ReturnType<typeof prepareD17StagedStudy>;

function policy(prepared: Pick<Prepared, 'corpus' | 'preregistration'>, rowAttempts: readonly HeldoutAttempt[]): DecisionEnsemblePolicy | null {
  const first = rowAttempts.find(attempt => attempt.result?.receipt)?.result?.receipt;
  if (!first) return null;
  const definition = artifactPin(prepared.corpus.definitions[0]!);
  return { schemaVersion: 'decision-ensemble-policy/v1', id: 'd17-synthetic-repeated-sample', version: '1.0.0',
    mode: 'offline-shadow', riskTiers: ['synthetic-diagnostic'], definition, primitive: 'choice', options: ['no', 'yes'],
    compatibleUncertaintyProfiles: ['typesafe-distribution-v1'], requiredCapabilities: ['choice', 'probability-distribution'],
    members: [{ id: 'jev', memberType: 'repeated-sample', definition, binding: first.spec.binding,
      adapter: { id: 'jev', version: '1.0.0' }, model: { provider: 'jev', backend: 'api', requested: 'jev-1.13.0', pinnedVersion: 'jev-1.13.0' },
      primitive: 'choice', uncertaintyProfile: 'typesafe-distribution-v1', requiredCapabilities: ['choice', 'probability-distribution'],
      capabilities: ['choice', 'probability-distribution'], calibration: null, samples: 3, fallbackDepth: 0,
      estimate: { attemptsPerSample: 2, tokensPerAttempt: 4000, costMicrosPerAttempt: 400, deadlineMsPerAttempt: prepared.preregistration.requestTimeoutMs },
      approvalReference: null }], aggregation: { algorithm: 'mean-probability-v1', tieRule: D17_ANALYSIS.acceptance.tieRule },
    disagreement: { metric: D17_ANALYSIS.acceptance.disagreementMetric, thresholdBps: D17_ANALYSIS.acceptance.maximumDisagreementBps, onExceeded: 'defer' },
    acceptance: { minimumSuccessfulMembers: D17_ANALYSIS.acceptance.minimumSuccessfulMembers, onInsufficientMembers: 'defer',
      highAgreementWarningBps: D17_ANALYSIS.acceptance.highAgreementWarningBps }, calibration: { requirement: 'advisory' },
    ceilings: { members: 1, attempts: 6, deadlineMs: prepared.preregistration.requestTimeoutMs * 6, tokens: 24000, costMicros: 2400,
      concurrency: 1, fallbackDepth: 0, unknownCost: { rule: 'reject' } } };
}

/** Maps retained provider distributions only; confidence and agreement never become calibrated probability. */
export async function scoreD17Study(input: ScoreInput, prepared: Prepared) {
  validateHeldoutInputs(input.corpus, input.preregistration);
  if (input.preregistration.calibration.scope !== 'uncalibrated-diagnostic'
    || !input.approvedCalibration || input.approvedCalibration.mode !== 'uncalibrated-diagnostic'
    || Object.keys(input.approvedCalibration).join(',') !== 'mode' || input.calibrated !== false) {
    throw new Error('D17 uncalibrated diagnostic scope');
  }
  if (heldoutDigest(input.corpus) !== heldoutDigest(prepared.corpus)
    || heldoutDigest(input.preregistration) !== heldoutDigest(prepared.preregistration)
    || heldoutDigest(input.gold) !== input.corpus.provenance.goldDigest
    || heldoutDigest(prepared.gold) !== input.corpus.provenance.goldDigest) throw new Error('D17 frozen scoring pins');
  const integrityProblems = qualificationIntegrityAllowlistProblems(input.integrity);
  if (integrityProblems.includes('integrity-invalid')) throw new Error('D17 invalid integrity');
  const rows = new Map(input.corpus.rows.map(row => [row.id, row]));
  const seen = new Set<string>();
  for (const attempt of input.attempts) {
    validateHeldoutAttempt(attempt);
    const row = rows.get(attempt.rowId), key = `${attempt.rowId}/${attempt.requestId}/${attempt.ordinal}`;
    if (!row || !row.requests.some(request => request.id === attempt.requestId) || seen.has(key)
      || attempt.corpusDigest !== input.preregistration.corpusDigest || attempt.study !== 'D17'
      || attempt.preregistrationDigest !== heldoutDigest(input.preregistration)) throw new Error('D17 attempt membership');
    seen.add(key);
  }
  const armAttempts = (row: HeldoutRow, candidate: boolean) => input.attempts.filter(attempt => attempt.rowId === row.id
    && (candidate ? attempt.requestId.startsWith('member_') : attempt.requestId === 'champion'));
  const member = (row: HeldoutRow, requestId: string): EnsembleMemberResult => {
    const attempts = input.attempts.filter(attempt => attempt.rowId === row.id && attempt.requestId === requestId).sort((a, b) => a.ordinal - b.ordinal);
    const terminal = attempts.at(-1)?.result;
    const decision = terminal?.receipt?.spec.evaluations.q0;
    const uncertainty = decision?.spec.uncertainty;
    const ok = terminal?.disposition === 'success' && terminal.servedModel === 'jev-1.13.0'
      && decision?.spec.status === 'success' && uncertainty?.source === 'provider'
      && uncertainty.profile === 'typesafe-distribution-v1' && uncertainty.distribution !== null;
    if (ok && (Object.keys(uncertainty.distribution!).sort().join(',') !== 'no,yes'
      || !['yes', 'no'].includes(String(decision.spec.value)))) throw new Error('D17 native distribution');
    return { memberId: 'jev', sampleIndex: requestId === 'champion' ? 0 : Number(requestId.slice(-1)) - 1,
      status: ok ? 'succeeded' : 'failed', resultDigest: heldoutDigest(attempts), value: ok ? decision.spec.value! : null,
      distribution: ok ? uncertainty.distribution : null, uncertaintyProfile: ok ? uncertainty.profile : null };
  };
  const measured = (probability: number, accepted: boolean, value: unknown, gold: string, attempts: readonly HeldoutAttempt[]): D17ArmMeasurement => ({
    probability, accepted, correct: accepted && value === gold, brier: (probability - Number(gold === 'yes')) ** 2,
    latencyMs: attempts.reduce((sum, attempt) => sum + (attempt.result?.latencyMs ?? 0), 0),
    tokens: attempts.some(attempt => !attempt.result || attempt.result.inputTokens === null || attempt.result.outputTokens === null) ? null
      : attempts.reduce((sum, attempt) => sum + attempt.result!.inputTokens! + attempt.result!.outputTokens!, 0),
    reservedCostMicros: attempts.reduce((sum, attempt) => sum + Math.max(attempt.reservedUsdMicros, attempt.result?.accountedUsdMicros ?? 0), 0),
  });
  const pairs: D17Pair[] = [], observations: Array<{ id: string; champion: ChampionChallengerObservation | null;
    challenger: ChampionChallengerObservation | null; aggregate: ReturnType<typeof aggregateEnsembleResults> | null }> = [];
  let championCorrect = 0, challengerCorrect = 0;
  const test = input.corpus.rows.filter(row => row.split === 'test');
  for (const row of test) {
    const single = member(row, 'champion'), members = [1, 2, 3].map(n => member(row, `member_${n}`));
    const candidateAttempts = armAttempts(row, true), championAttempts = armAttempts(row, false);
    const ensemblePolicy = policy(prepared, candidateAttempts);
    const aggregate = ensemblePolicy ? aggregateEnsembleResults(ensemblePolicy, members) : null;
    const gold = prepared.gold.labels[row.id]!;
    const champion = single.status === 'succeeded' ? measured(single.distribution!.yes!, single.distribution!.yes !== single.distribution!.no,
      single.value, gold, championAttempts) : null;
    const challenger = members.every(m => m.status === 'succeeded') && aggregate?.statistics.meanDistribution
      ? measured(aggregate.statistics.meanDistribution.yes!, aggregate.outcome.disposition === 'accept', aggregate.outcome.value, gold, candidateAttempts) : null;
    championCorrect += Number(champion?.correct ?? false); challengerCorrect += Number(challenger?.correct ?? false);
    if (champion && challenger) pairs.push({ id: row.id, slice: row.slice, champion, challenger });
    const observation = (arm: D17ArmMeasurement | null, attempts: readonly HeldoutAttempt[]): ChampionChallengerObservation | null => arm ? {
      inputDigest: heldoutDigest(row.input), receiptDigest: heldoutDigest(attempts), quality: Number(arm.correct), calibration: arm.brier,
      riskCoverage: Number(arm.accepted && !arm.correct), abstention: Number(!arm.accepted), latencyMs: arm.latencyMs,
      tokens: arm.tokens, costMicros: arm.reservedCostMicros, slice: Number(arm.correct),
    } : null;
    observations.push({ id: row.id, champion: observation(champion, championAttempts), challenger: observation(challenger, candidateAttempts), aggregate });
  }
  const statistics = d17Statistics(pairs, test.map(row => row.id));
  statistics.worstCaseFailureAsError.championCorrect = championCorrect;
  statistics.worstCaseFailureAsError.challengerCorrect = challengerCorrect;
  const splits = (['tuning', 'calibration', 'test'] as const).map(split =>
    freezeQualificationSplit(split, input.corpus.rows.filter(row => row.split === split).map(row => row.id)));
  const binary = (role: 'champion' | 'challenger') => pairs.length === test.length ? evaluateBinaryHeldout(splits, pairs.map(pair => {
    const attempts = armAttempts(rows.get(pair.id)!, role === 'challenger');
    const known = (key: 'inputTokens' | 'outputTokens' | 'providerCostUsd') => attempts.some(a => !a.result || a.result[key] === null)
      ? null : attempts.reduce((sum, a) => sum + a.result![key]!, 0);
    return { id: pair.id, slice: pair.slice, label: Number(prepared.gold.labels[pair.id] === 'yes') as 0 | 1,
      probability: pair[role].probability, accepted: pair[role].accepted, latencyMs: pair[role].latencyMs,
      inputTokens: known('inputTokens'), outputTokens: known('outputTokens'), costUsd: known('providerCostUsd'),
      calls: attempts.length, retries: attempts.filter(a => a.ordinal > 1).length, fallbacks: 0 };
  })) : null;
  const reservation = (attempts: readonly HeldoutAttempt[]) => attempts.reduce((sum, attempt) =>
    sum + Math.max(attempt.reservedUsdMicros, attempt.result?.accountedUsdMicros ?? 0), 0);
  const definitionPin = artifactPin(input.corpus.definitions[0]!);
  const successful = input.attempts.filter(attempt => attempt.result?.disposition === 'success');
  const bindingPin = successful[0]?.result?.receipt?.spec.binding ?? null;
  if (successful.some(attempt => !attempt.result?.receipt
    || heldoutDigest(attempt.result.receipt.spec.binding) !== heldoutDigest(bindingPin)
    || Object.values(attempt.result.receipt.spec.evaluations).some(result => heldoutDigest(result.spec.decision) !== heldoutDigest(definitionPin)))) {
    throw new Error('D17 mixed execution pins');
  }
  const testIds = new Set(test.map(row => row.id));
  const testAttempts = input.attempts.filter(attempt => testIds.has(attempt.rowId));
  const championReservations = reservation(testAttempts.filter(attempt => attempt.requestId === 'champion'));
  const challengerReservations = reservation(testAttempts.filter(attempt => attempt.requestId !== 'champion'));
  const report = { schemaVersion: 'decision-d17-study-report/v1', scope: 'synthetic-diagnostic-only',
    calibrated: false, d09Qualified: false, calibratedGate: false,
    corpusDigest: heldoutDigest(input.corpus), preregistrationDigest: heldoutDigest(input.preregistration),
    executionPins: { definition: definitionPin, binding: bindingPin, model: 'jev-1.13.0', adapter: { id: 'jev', version: '1.0.0' },
      aggregatePolicyDigest: observations.find(row => row.aggregate)?.aggregate?.policy.digest ?? null },
    integrityDigest: heldoutDigest(input.integrity), integrity: structuredClone(input.integrity), integrityProblems,
    statistics, statisticsDigest: heldoutDigest(statistics), pairs, observations,
    accounting: { allSplits: { attempts: input.attempts.length, reservedCostMicros: reservation(input.attempts) },
      test: { championReservedCostMicros: championReservations, challengerReservedCostMicros: challengerReservations,
        netSavingsMicros: championReservations - challengerReservations, complete: pairs.length === test.length } },
    calibrationDiagnostics: { champion: binary('champion'), challenger: binary('challenger'), calibrated: false },
    pending: ['D09 compatible member and aggregate calibration', 'blind gold audit and delayed repeats', 'separate extra-cost tradeoff approval',
      'protected native report approval and eligibility'],
    decision: d17StudyDecision(evaluateD17Statistics(statistics, undefined, input.integrity), input.integrity) };
  validateD17Artifact('report', report);
  return report;
}

/** Native serialization requires a separately anchored record. It cannot create approval or eligibility. */
export async function buildD17NativeReport(input: { report: Awaited<ReturnType<typeof scoreD17Study>> | D17StagedReport; prepared: Prepared | StagedPrepared;
  record: DecisionChampionChallenger; integrity: QualificationIntegrityMetadata; trustedIntegrityDigest: Digest; trustedReportDigest: Digest;
  /** Staged (v2) only: D09's stored eligibility for `record.eligibilityId`, checked against the registry that will promote. */
  eligibility?: PromotionEligibility; registry?: Pick<ChampionAliasGateway, 'promotionEligibility'>;
  /** Staged (v2) only: the anchored extra-cost tradeoff approval an upstream PROMOTE must carry. */
  tradeoff?: unknown; trustedTradeoffDigest?: Digest }) {
  const staged = input.report.schemaVersion === 'decision-d17-study-report/v2';
  validateD17Artifact(staged ? 'reportV2' : 'report', input.report);
  if (!staged && (input.eligibility !== undefined || input.tradeoff !== undefined)) throw new Error('D17 diagnostic native report has no promotion route');
  if (input.eligibility !== undefined) {
    const stored = input.registry?.promotionEligibility(input.record.eligibilityId) ?? null;
    if (!stored || canonicalJson(stored) !== canonicalJson(input.eligibility)) throw new Error('D17 native eligibility');
  }
  if (staged) {
    // AC7/AC14: each role must cite the exact D09 artifact the calibrated report applied to it.
    const calibration = (input.report as D17StagedReport).calibration, record = input.record as DecisionChampionChallenger;
    const cites = (role: 'champion' | 'challenger', pin: { artifactId: string; artifactDigest: string }) =>
      record[role]?.calibration?.artifactId === pin.artifactId && record[role]?.calibration?.artifactDigest === pin.artifactDigest;
    assertD17Staged(input.prepared as StagedPrepared);
    if (!cites('champion', calibration.member) || !cites('challenger', calibration.aggregate)) throw new Error('D17 native calibration pins');
  }
  const { record } = validateChampionChallenger(input.record);
  const problems = qualificationIntegrityAllowlistProblems(input.integrity);
  if (problems.includes('integrity-invalid') || heldoutDigest(input.integrity) !== input.trustedIntegrityDigest
    || record.evaluationIntegrityReport.digest !== input.trustedIntegrityDigest) throw new Error('D17 native integrity pin');
  if (heldoutDigest(input.report) !== input.trustedReportDigest || input.report.integrityDigest !== heldoutDigest(input.report.integrity)
    || input.report.corpusDigest !== heldoutDigest(input.prepared.corpus)
    || input.report.preregistrationDigest !== heldoutDigest(input.prepared.preregistration)
    || input.report.statisticsDigest !== heldoutDigest(input.report.statistics)
    || record.preregistration.thresholdsDigest !== pairedThresholdsDigest([...D17_ANALYSIS.native])
    || input.integrity.release_gate.decision === 'PROMOTE'
      && (!staged || !d17PromotionSupported(input.report as D17StagedReport, input.integrity, input.tradeoff, input.trustedTradeoffDigest))
    || input.report.decision === 'ROLLBACK' && input.integrity.release_gate.decision !== 'ROLLBACK') throw new Error('D17 native report needs anchored HOLD or ROLLBACK');
  const pins = input.report.executionPins;
  if (!pins.binding || !pins.aggregatePolicyDigest || record.champion.ensemblePolicy !== null
    || record.challenger.ensemblePolicy?.digest !== pins.aggregatePolicyDigest
    || [record.champion, record.challenger].some(role => role.actualModel !== pins.model
      || heldoutDigest(role.binding) !== heldoutDigest(pins.binding) || heldoutDigest(role.adapter) !== heldoutDigest(pins.adapter))) {
    throw new Error('D17 native execution pins');
  }
  const items = input.prepared.corpus.rows.filter(row => row.split === 'test').map(row => ({ id: row.id, input: row.input, slice: row.slice }));
  if (record.inputSet.digest !== championChallengerInputSetDigest(items)) throw new Error('D17 native membership');
  const shadow = await runChampionChallengerShadow(record, { enabled: true, invocationId: 'd17-recorded-replay', items,
    evaluate: async ({ role, item }) => {
      const observation = input.report.observations.find(row => row.id === item.id)?.[role];
      if (!observation || observation.tokens === null) throw new Error('D17 incomplete native endpoints');
      return observation;
    } });
  const baseline = championChallengerShadowBaseline(record, shadow);
  const upstream = input.integrity.paired_baseline as Record<string, unknown> | null;
  if (!upstream || heldoutDigest(upstream.championChallengerShadow ?? null) !== heldoutDigest(baseline)
    || upstream.d17StatisticsDigest !== input.report.statisticsDigest) throw new Error('D17 unbound native statistics');
  return buildEnsembleIntegrityReport({ record, integrity: input.integrity, pairedDeltas: shadow.pairedDeltas, eligibility: input.eligibility ?? null });
}

type Arm = D17ArmMeasurement;
export type D17StagedReport = Awaited<ReturnType<typeof scoreD17StagedStudy>>;

/**
 * Calibrated test-phase scorer (#2611 staged D09). The collector passes only test rows and `calibrated: null`.
 * The approved calibration set, both approved artifacts, their mappings and the completed development review
 * are verified and D09-qualified at the scoring clock before any row is scored. The champion's native P(yes)
 * passes through the member calibrator; the challenger's raw three-member mean passes through the aggregate
 * calibrator, and it is accepted only when the native aggregate accepts and the calibrated value is not a tie.
 * The frozen D17 native gates are evaluated on those calibrated measurements; the uncalibrated statistics are
 * retained as a descriptive comparison. The decision is HOLD or a preserved ROLLBACK, never PROMOTE.
 */
export async function scoreD17StagedStudy(input: Omit<ScoreInput, 'approvedCalibration' | 'calibrated'> & {
  approvedCalibration: unknown; calibrated: unknown }, prepared: StagedPrepared, context: D17CalibrationContext) {
  assertD17Staged(prepared);
  if (input.preregistration?.calibration?.scope !== 'calibrated' || input.calibrated !== null) throw new Error('D17 staged calibration scope');
  const testRows = prepared.corpus.rows.filter(row => row.split === 'test');
  if (heldoutDigest(input.corpus) !== heldoutDigest({ ...prepared.corpus, rows: testRows })
    || heldoutDigest(input.preregistration) !== heldoutDigest(prepared.preregistration)
    || heldoutDigest(input.gold) !== prepared.corpus.provenance.goldDigest
    || heldoutDigest(prepared.gold) !== prepared.corpus.provenance.goldDigest) throw new Error('D17 frozen scoring pins');
  if (!context || typeof context.testPhaseAccessAt !== 'string') throw new Error('D17 staged test access');
  const verified = verifyD17CalibrationSet(prepared, input.approvedCalibration as never, context);
  const integrityProblems = qualificationIntegrityAllowlistProblems(input.integrity);
  if (integrityProblems.includes('integrity-invalid')) throw new Error('D17 invalid integrity');
  const rows = new Map(testRows.map(row => [row.id, row]));
  const seen = new Set<string>();
  for (const attempt of input.attempts) {
    validateHeldoutAttempt(attempt);
    const row = rows.get(attempt.rowId), key = `${attempt.rowId}/${attempt.requestId}/${attempt.ordinal}`;
    if (!row || !row.requests.some(request => request.id === attempt.requestId) || seen.has(key)
      || attempt.corpusDigest !== input.preregistration.corpusDigest || attempt.study !== 'D17'
      || attempt.preregistrationDigest !== heldoutDigest(input.preregistration)) throw new Error('D17 attempt membership');
    seen.add(key);
  }
  const grouped = d17AttemptsByRow(input.attempts), rowAttempts = (row: HeldoutRow) => grouped.get(row.id) ?? [];
  const of = (row: HeldoutRow, candidate: boolean) => rowAttempts(row).filter(attempt =>
    candidate ? attempt.requestId.startsWith('member_') : attempt.requestId === 'champion');
  const member = (row: HeldoutRow, requestId: string): EnsembleMemberResult => {
    const attempts = rowAttempts(row).filter(attempt => attempt.requestId === requestId).sort((a, b) => a.ordinal - b.ordinal);
    const terminal = attempts.at(-1)?.result, decision = terminal?.receipt?.spec.evaluations.q0, uncertainty = decision?.spec.uncertainty;
    const ok = terminal?.disposition === 'success' && terminal.servedModel === 'jev-1.13.0' && decision?.spec.status === 'success'
      && uncertainty?.source === 'provider' && uncertainty.profile === 'typesafe-distribution-v1' && uncertainty.distribution !== null;
    if (ok && (Object.keys(uncertainty.distribution!).sort().join(',') !== 'no,yes' || !['yes', 'no'].includes(String(decision.spec.value)))) throw new Error('D17 native distribution');
    return { memberId: 'jev', sampleIndex: requestId === 'champion' ? 0 : Number(requestId.slice(-1)) - 1,
      status: ok ? 'succeeded' : 'failed', resultDigest: heldoutDigest(attempts), value: ok ? decision.spec.value! : null,
      distribution: ok ? uncertainty.distribution : null, uncertaintyProfile: ok ? uncertainty.profile : null };
  };
  const arm = (probability: number, accepted: boolean, value: unknown, gold: string, attempts: readonly HeldoutAttempt[]): Arm => ({
    probability, accepted, correct: accepted && value === gold, brier: (probability - Number(gold === 'yes')) ** 2,
    latencyMs: attempts.reduce((sum, attempt) => sum + (attempt.result?.latencyMs ?? 0), 0),
    tokens: attempts.some(attempt => !attempt.result || attempt.result.inputTokens === null || attempt.result.outputTokens === null) ? null
      : attempts.reduce((sum, attempt) => sum + attempt.result!.inputTokens! + attempt.result!.outputTokens!, 0),
    reservedCostMicros: attempts.reduce((sum, attempt) => sum + Math.max(attempt.reservedUsdMicros, attempt.result?.accountedUsdMicros ?? 0), 0),
  });
  const calibratedValue = (p: number) => p > 0.5 ? 'yes' : p < 0.5 ? 'no' : null;
  const pairs: D17Pair[] = [], rawPairs: D17Pair[] = [], observations: Array<{ id: string; champion: ChampionChallengerObservation | null;
    challenger: ChampionChallengerObservation | null; aggregate: ReturnType<typeof aggregateEnsembleResults> | null }> = [];
  let championCorrect = 0, challengerCorrect = 0;
  for (const row of testRows) {
    const single = member(row, 'champion'), members = [1, 2, 3].map(n => member(row, `member_${n}`));
    const candidateAttempts = of(row, true), championAttempts = of(row, false);
    const ensemblePolicy = policy(prepared, candidateAttempts);
    const aggregate = ensemblePolicy ? aggregateEnsembleResults(ensemblePolicy, members) : null;
    const gold = prepared.gold.labels[row.id]!, raw = d17RawProbabilities(rowAttempts(row), row);
    let champion: Arm | null = null, challenger: Arm | null = null;
    if (single.status === 'succeeded' && raw.champion !== null) {
      const p = applyD17Mapping(verified.member.mapping, raw.champion);
      champion = arm(p, calibratedValue(p) !== null, calibratedValue(p), gold, championAttempts);
    }
    if (members.every(m => m.status === 'succeeded') && aggregate?.statistics.meanDistribution && raw.mean !== null) {
      const p = applyD17Mapping(verified.aggregate.mapping, raw.mean);
      challenger = arm(p, aggregate.outcome.disposition === 'accept' && calibratedValue(p) !== null, calibratedValue(p), gold, candidateAttempts);
    }
    // Uncalibrated comparison: the original v1 measurements, descriptive only.
    const rawChampion = single.status === 'succeeded' ? arm(single.distribution!.yes!, single.distribution!.yes !== single.distribution!.no,
      single.value, gold, championAttempts) : null;
    const rawChallenger = members.every(m => m.status === 'succeeded') && aggregate?.statistics.meanDistribution ? arm(aggregate.statistics.meanDistribution.yes!,
      aggregate.outcome.disposition === 'accept', aggregate.outcome.value, gold, candidateAttempts) : null;
    if (rawChampion && rawChallenger) rawPairs.push({ id: row.id, slice: row.slice, champion: rawChampion, challenger: rawChallenger });
    championCorrect += Number(champion?.correct ?? false); challengerCorrect += Number(challenger?.correct ?? false);
    if (champion && challenger) pairs.push({ id: row.id, slice: row.slice, champion, challenger });
    const observation = (measured: Arm | null, attempts: readonly HeldoutAttempt[]): ChampionChallengerObservation | null => measured ? {
      inputDigest: heldoutDigest(row.input), receiptDigest: heldoutDigest(attempts), quality: Number(measured.correct), calibration: measured.brier,
      riskCoverage: Number(measured.accepted && !measured.correct), abstention: Number(!measured.accepted), latencyMs: measured.latencyMs,
      tokens: measured.tokens, costMicros: measured.reservedCostMicros, slice: Number(measured.correct),
    } : null;
    observations.push({ id: row.id, champion: observation(champion, championAttempts), challenger: observation(challenger, candidateAttempts), aggregate });
  }
  const ids = testRows.map(row => row.id);
  const statistics = d17Statistics(pairs, ids);
  statistics.worstCaseFailureAsError.championCorrect = championCorrect;
  statistics.worstCaseFailureAsError.challengerCorrect = challengerCorrect;
  const uncalibratedStatistics = d17Statistics(rawPairs, ids);
  const splits = (['tuning', 'calibration', 'test'] as const).map(split =>
    freezeQualificationSplit(split, prepared.corpus.rows.filter(row => row.split === split).map(row => row.id)));
  const binary = (role: 'champion' | 'challenger') => pairs.length === testRows.length ? evaluateBinaryHeldout(splits, pairs.map(pair => {
    const attempts = of(rows.get(pair.id)!, role === 'challenger');
    const known = (key: 'inputTokens' | 'outputTokens' | 'providerCostUsd') => attempts.some(a => !a.result || a.result[key] === null)
      ? null : attempts.reduce((sum, a) => sum + a.result![key]!, 0);
    return { id: pair.id, slice: pair.slice, label: Number(prepared.gold.labels[pair.id] === 'yes') as 0 | 1,
      probability: pair[role].probability, accepted: pair[role].accepted, latencyMs: pair[role].latencyMs,
      inputTokens: known('inputTokens'), outputTokens: known('outputTokens'), costUsd: known('providerCostUsd'),
      calls: attempts.length, retries: attempts.filter(a => a.ordinal > 1).length, fallbacks: 0 };
  })) : null;
  const reservation = (attempts: readonly HeldoutAttempt[]) => attempts.reduce((sum, attempt) =>
    sum + Math.max(attempt.reservedUsdMicros, attempt.result?.accountedUsdMicros ?? 0), 0);
  const definitionPin = artifactPin(prepared.corpus.definitions[0]!);
  const successful = input.attempts.filter(attempt => attempt.result?.disposition === 'success');
  const bindingPin = successful[0]?.result?.receipt?.spec.binding ?? null;
  if (successful.some(attempt => !attempt.result?.receipt || heldoutDigest(attempt.result.receipt.spec.binding) !== heldoutDigest(bindingPin)
    || Object.values(attempt.result.receipt.spec.evaluations).some(result => heldoutDigest(result.spec.decision) !== heldoutDigest(definitionPin)))) {
    throw new Error('D17 mixed execution pins');
  }
  const championReservations = reservation(input.attempts.filter(attempt => attempt.requestId === 'champion'));
  const challengerReservations = reservation(input.attempts.filter(attempt => attempt.requestId !== 'champion'));
  const pin = (role: 'member' | 'aggregate') => ({ artifactId: verified[role].artifact.id, artifactDigest: verified[role].artifact.digest,
    mappingDigest: heldoutDigest(verified[role].mapping), compatibility: { action: 'allow' as const,
      state: verified[role].compatibility.state as 'exact' | 'approved-compatible', pinId: verified[role].compatibility.pinId } });
  const approved = input.approvedCalibration as { calibrationPhaseRecordDigest: Digest; priorApprovalDigest: Digest };
  const decision = d17StudyDecision(evaluateD17Statistics(statistics, undefined, input.integrity), input.integrity);
  const report = { schemaVersion: 'decision-d17-study-report/v2' as const, scope: 'synthetic-staged-calibrated' as const,
    calibrated: true as const, d09Qualified: true as const, calibratedGate: true as const,
    corpusDigest: heldoutDigest(prepared.corpus), preregistrationDigest: heldoutDigest(prepared.preregistration),
    executionPins: { definition: definitionPin, binding: bindingPin, model: 'jev-1.13.0' as const, adapter: { id: 'jev', version: '1.0.0' },
      aggregatePolicyDigest: observations.find(row => row.aggregate)?.aggregate?.policy.digest ?? null },
    integrityDigest: heldoutDigest(input.integrity), integrity: structuredClone(input.integrity), integrityProblems,
    calibration: { mode: 'staged-test' as const, calibrationSetDigest: verified.setDigest,
      calibrationPhaseRecordDigest: approved.calibrationPhaseRecordDigest, priorApprovalDigest: approved.priorApprovalDigest,
      member: pin('member'), aggregate: pin('aggregate'), qualifiedAt: verified.qualifiedAt,
      applied: { champion: 'member' as const, challenger: 'aggregate' as const } },
    developmentReviewDigest: verified.developmentReviewDigest, calibrationReviewDigest: verified.calibrationReviewDigest,
    statistics, statisticsDigest: heldoutDigest(statistics), uncalibratedStatistics, pairs, observations,
    accounting: { allSplits: { attempts: input.attempts.length, reservedCostMicros: reservation(input.attempts) },
      test: { championReservedCostMicros: championReservations, challengerReservedCostMicros: challengerReservations,
        netSavingsMicros: championReservations - challengerReservations, complete: pairs.length === testRows.length } },
    calibrationDiagnostics: { champion: binary('champion'), challenger: binary('challenger'), calibrated: true as const },
    gates: { source: 'd17-native-protocol' as const, gateBinding: null, statisticalGate: statistics.statisticalGate as 'pass' | 'HOLD',
      findings: [...statistics.findings], promotion: 'not-authorized: requires separate extra-cost tradeoff approval and D09 promotion eligibility' as const },
    pending: ['blind gold audit and delayed repeats', 'separate extra-cost tradeoff approval', 'D09 promotion eligibility',
      'protected native report approval'],
    decision };
  validateD17Artifact('reportV2', report);
  return report;
}

/** Operator-supplied identity for the anchored champion/challenger record; nothing here confers eligibility. */
export interface D17NativeOperator {
  alias: string; aliasRevision: number; eligibilityId: string; integrityReportId: string;
  approvalReference: string; approvedAt: string; holdoutAccessedAt: string;
}

/**
 * Builds the real champion/challenger record and the shadow baseline for a calibrated v2 report. Each role
 * cites the D09 artifact applied to it; identities are the calibrated decision identities. The caller binds
 * the returned baseline and statistics digest into eval-integrity metadata, anchors that digest externally,
 * and only then serializes the native report with `buildD17NativeReport`.
 */
export async function d17NativeHandoff(input: { report: D17StagedReport; trustedReportDigest: Digest; prepared: StagedPrepared;
  artifacts: { member: { id: string; digest: Digest; identity: Parameters<typeof calibrationIdentityDigest>[0] };
    aggregate: { id: string; digest: Digest; identity: Parameters<typeof calibrationIdentityDigest>[0] } };
  operator: D17NativeOperator }) {
  validateD17Artifact('reportV2', input.report);
  assertD17Staged(input.prepared);
  const { report, operator, artifacts } = input;
  if (heldoutDigest(report) !== input.trustedReportDigest || report.corpusDigest !== heldoutDigest(input.prepared.corpus)
    || report.preregistrationDigest !== heldoutDigest(input.prepared.preregistration)) throw new Error('D17 native report pin');
  for (const role of ['member', 'aggregate'] as const) {
    if (artifacts[role].id !== report.calibration[role].artifactId || artifacts[role].digest !== report.calibration[role].artifactDigest) {
      throw new Error('D17 native calibration pins');
    }
  }
  const pins = report.executionPins;
  if (!pins.binding || !pins.aggregatePolicyDigest || !report.accounting.test.complete) throw new Error('D17 incomplete native endpoints');
  const policyPin = report.observations.find(row => row.aggregate)?.aggregate?.policy;
  if (!policyPin || policyPin.digest !== pins.aggregatePolicyDigest) throw new Error('D17 native execution pins');
  const template = input.prepared.nativeTemplates.comparison;
  const items = input.prepared.corpus.rows.filter(row => row.split === 'test').map(row => ({ id: row.id, input: row.input, slice: row.slice }));
  const championIdentity = calibrationIdentityDigest(artifacts.member.identity);
  const role = (calibration: { id: string; digest: Digest }, identityDigest: Digest) => ({ identityDigest, actualModel: pins.model,
    binding: structuredClone(pins.binding!), adapter: structuredClone(pins.adapter),
    calibration: { artifactId: calibration.id, artifactDigest: calibration.digest } });
  const record = { ...structuredClone(template), alias: operator.alias,
    champion: { ...role(artifacts.member, championIdentity), aliasRevision: operator.aliasRevision, ensemblePolicy: null },
    challenger: { ...role(artifacts.aggregate, calibrationIdentityDigest(artifacts.aggregate.identity)), ensemblePolicy: structuredClone(policyPin) },
    inputSet: { ...structuredClone(template.inputSet), digest: championChallengerInputSetDigest(items) },
    preregistration: { ...structuredClone(template.preregistration), thresholdsDigest: pairedThresholdsDigest([...D17_ANALYSIS.native]),
      holdoutAccessedAt: operator.holdoutAccessedAt },
    eligibilityId: operator.eligibilityId, evaluationIntegrityReport: { id: operator.integrityReportId, digest: report.integrityDigest },
    approval: { reference: operator.approvalReference, approvedAt: operator.approvedAt },
    rollbackTarget: { aliasRevision: operator.aliasRevision, identityDigest: championIdentity } } as unknown as DecisionChampionChallenger;
  validateChampionChallenger(record);
  const shadow = await runChampionChallengerShadow(record, { enabled: true, invocationId: 'd17-recorded-replay', items,
    evaluate: async ({ role: side, item }) => {
      const observation = report.observations.find(row => row.id === item.id)?.[side];
      if (!observation || observation.tokens === null) throw new Error('D17 incomplete native endpoints');
      return observation;
    } });
  return { record, pairedBaseline: { championChallengerShadow: championChallengerShadowBaseline(record, shadow),
    d17StatisticsDigest: report.statisticsDigest } };
}

export interface D17TradeoffApproval {
  schemaVersion: 'decision-d17-tradeoff-approval/v1'; approved: true; reviewer: string; reportDigest: Digest; statisticsDigest: Digest;
  netSavingsMicros: number; acceptedAdditionalCostMicros: number; qualityLowerBps: number; approvalReference: string; approvedAt: string;
}

/**
 * The preregistered extra-cost tradeoff: an anchored approval of this exact report and statistics that accepts at least the
 * measured additional reservation cost and records the observed quality lower bound. It approves cost, not quality.
 */
export function validateD17Tradeoff(report: D17StagedReport, tradeoff: unknown, trustedDigest: unknown): D17TradeoffApproval {
  try { validateD17Artifact('calibration', tradeoff); } catch { throw new Error('D17 tradeoff approval'); }
  const value = tradeoff as unknown as D17TradeoffApproval;
  if (value.schemaVersion !== 'decision-d17-tradeoff-approval/v1' || typeof trustedDigest !== 'string' || heldoutDigest(value) !== trustedDigest
    || value.reportDigest !== heldoutDigest(report) || value.statisticsDigest !== report.statisticsDigest
    || value.netSavingsMicros !== report.statistics.netSavingsMicros || value.acceptedAdditionalCostMicros < Math.max(0, -report.statistics.netSavingsMicros)
    || value.qualityLowerBps !== report.statistics.quality?.lowerBps) throw new Error('D17 tradeoff approval');
  return value;
}

/** A calibrated report supports PROMOTE only with a passing study gate, a positive quality bound and the bound tradeoff. */
function d17PromotionSupported(report: D17StagedReport, integrity: QualificationIntegrityMetadata, tradeoff: unknown, trustedDigest: unknown): boolean {
  if (report.gates.statisticalGate !== 'pass' || !report.statistics.benefitSupported) return false;
  try { validateD17Tradeoff(report, tradeoff, trustedDigest); } catch { return false; }
  const upstream = integrity.paired_baseline as Record<string, unknown> | null;
  return upstream?.d17TradeoffApprovalDigest === trustedDigest;
}

/**
 * Eval-integrity metadata for the native D17 record. The release gate comes from the locked-snapshot evidence (`base`); a
 * PROMOTE gate survives only when the calibrated study gate passes, the quality lower bound is positive and an anchored
 * extra-cost tradeoff approval binds this report. Otherwise PROMOTE is held, with the missing pieces as reasons.
 */
export function d17NativeIntegrity(input: { base: QualificationIntegrityMetadata; pairedBaseline: Record<string, unknown>;
  report: D17StagedReport; tradeoff?: unknown; trustedTradeoffDigest?: Digest | null }): QualificationIntegrityMetadata {
  const missing: string[] = [];
  if (input.report.gates.statisticalGate !== 'pass') missing.push('D17 statistical gate did not pass');
  if (!input.report.statistics.benefitSupported) missing.push('D17 quality lower bound is not positive');
  let tradeoffDigest: Digest | null = null;
  if (input.tradeoff === undefined || input.tradeoff === null) missing.push('no anchored extra-cost tradeoff approval');
  else { validateD17Tradeoff(input.report, input.tradeoff, input.trustedTradeoffDigest); tradeoffDigest = input.trustedTradeoffDigest!; }
  // The ensemble integrity contract carries only the gate decision and reasons (eval-tool thresholds are dropped).
  const gate = { decision: input.base.release_gate.decision, reasons: [...input.base.release_gate.reasons] };
  const release_gate = gate.decision === 'PROMOTE' && missing.length
    ? { decision: ceilingDecision(gate.decision, 'HOLD'), reasons: [...gate.reasons, ...missing.map(reason => `promotion withheld: ${reason}`)] } : gate;
  const { sample_n, uncertainty, integrity_mode, fresh_workspace_required, fresh_workspace_verified, integrity_state,
    trusted_score_source, compromise_labels, weak_signal_reason } = input.base;
  return { sample_n, uncertainty, paired_baseline: { ...input.pairedBaseline, d17TradeoffApprovalDigest: tradeoffDigest },
    integrity_mode, fresh_workspace_required, fresh_workspace_verified, integrity_state, trusted_score_source,
    compromise_labels: [...compromise_labels], weak_signal_reason, release_gate };
}
