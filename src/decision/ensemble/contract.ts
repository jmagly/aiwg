import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalJson } from '../../security/artifact-trust.js';
import { admitEntry } from '../entry.js';
import type { AliasEvent, CompatibilityDecision, PromotionEligibility } from '../calibration/types.js';
import type {
  DecisionChampionChallenger, DecisionDriftResponse, DecisionEnsembleAggregate, DecisionEnsembleIntegrityReport,
  DecisionEnsemblePolicy, EnsembleAggregationAlgorithm, EnsembleBudgetPlan, EnsembleCeilings, EnsembleDigest,
  EnsembleDisagreementMetric, EnsemblePrimitive, EnsembleReservation, IntegrityGateDecision, PairedMetric, PairedMetricThreshold,
  DriftResponseRule,
} from './types.js';

/** Pure D17 contract validation. Nothing here resolves credentials, calls an adapter or opens a transport. */
export class EnsembleContractError extends Error {
  constructor(message: string, readonly layer: 'admission' | 'schema' | 'semantic' = 'semantic', readonly details: readonly string[] = []) {
    super(message); this.name = 'EnsembleContractError';
  }
}

export const ENSEMBLE_SCHEMA_FILES = {
  policy: 'DecisionEnsemblePolicy.v1.schema.json',
  championChallenger: 'DecisionChampionChallenger.v1.schema.json',
  driftResponse: 'DecisionDriftResponse.v1.schema.json',
  aggregate: 'DecisionEnsembleAggregate.v1.schema.json',
  integrityReport: 'DecisionEnsembleIntegrityReport.v1.schema.json',
} as const;
export type EnsembleSchemaKind = keyof typeof ENSEMBLE_SCHEMA_FILES;

/** Versioned algorithm and metric compatibility. An unknown version is rejected, never approximated. */
export const ENSEMBLE_AGGREGATION_PRIMITIVES: Readonly<Record<EnsembleAggregationAlgorithm, readonly EnsemblePrimitive[]>> = {
  'majority-v1': ['choice', 'truth-probability'],
  'mean-probability-v1': ['choice', 'truth-probability'],
  'score-distribution-mean-v1': ['ordinal-score'],
  'score-median-v1': ['ordinal-score'],
};
export const ENSEMBLE_DISAGREEMENT_PRIMITIVES: Readonly<Record<EnsembleDisagreementMetric, readonly EnsemblePrimitive[]>> = {
  'vote-share-v1': ['choice', 'truth-probability'],
  'normalized-entropy-v1': ['choice', 'truth-probability'],
  'jensen-shannon-v1': ['choice', 'truth-probability'],
  'score-dispersion-v1': ['ordinal-score'],
};
/** Algorithms/metrics that combine numeric uncertainty require one shared uncertainty profile. */
const UNCERTAINTY_COMBINING = new Set<string>(['mean-probability-v1', 'jensen-shannon-v1']);
export const REQUIRED_PAIRED_METRICS: readonly PairedMetric[] = ['quality', 'calibration', 'risk-coverage', 'abstention', 'latency', 'tokens', 'cost', 'slice'];
const CEILING_FIELDS = ['members', 'attempts', 'deadlineMs', 'tokens', 'costMicros', 'concurrency', 'fallbackDepth'] as const;
const GATE_RANK: Readonly<Record<IntegrityGateDecision, number>> = { PROMOTE: 0, HOLD: 1, ROLLBACK: 2 };

let validators: Map<EnsembleSchemaKind, ValidateFunction> | null = null;
function schemaValidator(kind: EnsembleSchemaKind): ValidateFunction {
  if (!validators) {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = [resolve(here, '../../../schemas/decision'), resolve(here, '../../../../schemas/decision')]
      .find(path => existsSync(resolve(path, ENSEMBLE_SCHEMA_FILES.policy)));
    if (!dir) throw new Error('Decision ensemble schema directory is unavailable');
    const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
    validators = new Map((Object.keys(ENSEMBLE_SCHEMA_FILES) as EnsembleSchemaKind[]).map(name => [name,
      ajv.compile(JSON.parse(readFileSync(resolve(dir, ENSEMBLE_SCHEMA_FILES[name]), 'utf8')) as object)]));
  }
  return validators.get(kind)!;
}

/** Admission then JSON Schema; the semantic layer runs only on schema-valid values. */
export function checkEnsembleSchema(kind: EnsembleSchemaKind, value: unknown): void {
  try { admitEntry(value); } catch { throw new EnsembleContractError(`${kind} admission denied`, 'admission'); }
  const check = schemaValidator(kind);
  if (!check(value)) {
    throw new EnsembleContractError(`${kind} does not match its v1 schema`, 'schema',
      (check.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`));
  }
}

export function ensembleContractDigest(value: unknown): EnsembleDigest {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
/** Order-independent digest a preregistration pins before any held-out access. */
export function pairedThresholdsDigest(metrics: readonly PairedMetricThreshold[]): EnsembleDigest {
  return ensembleContractDigest([...metrics].sort((a, b) => compareEnsembleKeys(a.metric, b.metric)));
}
export function driftThresholdsDigest(rules: readonly DriftResponseRule[]): EnsembleDigest {
  return ensembleContractDigest([...rules].sort((a, b) => compareEnsembleKeys(a.id, b.id)));
}
/** Locale-independent code-unit ordering; the canonical order for ties and member lists. */
export function compareEnsembleKeys(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function semantic(problems: string[], message: string): void {
  if (problems.length) throw new EnsembleContractError(`${message}: ${problems[0]}`, 'semantic', problems);
}
const time = (value: string): number => Date.parse(value);

export interface EnsemblePolicyValidationOptions {
  /** Host/tenant/workflow ceilings; the effective limit is the minimum of every layer, as in effectiveGraphCeilings. */
  hostCeilings?: ReadonlyArray<Partial<EnsembleCeilings>>;
  /** D09 compatibility pins per member ID, when the host has already resolved them. */
  calibrationPins?: Readonly<Record<string, CompatibilityDecision>>;
}
export interface EnsemblePolicyValidation { policy: DecisionEnsemblePolicy; digest: EnsembleDigest; budget: EnsembleBudgetPlan }

/** Refuses incompatible members, primitives, uncertainty semantics, calibration, capabilities or budgets. */
export function validateEnsemblePolicy(value: unknown, options: EnsemblePolicyValidationOptions = {}): EnsemblePolicyValidation {
  checkEnsembleSchema('policy', value);
  const policy = value as DecisionEnsemblePolicy;
  const problems: string[] = [];
  const { algorithm } = policy.aggregation; const { metric } = policy.disagreement;
  if (!ENSEMBLE_AGGREGATION_PRIMITIVES[algorithm].includes(policy.primitive)) problems.push(`aggregation ${algorithm} is not defined for ${policy.primitive}`);
  if (!ENSEMBLE_DISAGREEMENT_PRIMITIVES[metric].includes(policy.primitive)) problems.push(`disagreement ${metric} is not defined for ${policy.primitive}`);
  const ids = new Set<string>(); const identities = new Set<string>();
  const combining = UNCERTAINTY_COMBINING.has(algorithm) || UNCERTAINTY_COMBINING.has(metric);
  for (const member of policy.members) {
    const at = `member ${member.id}`;
    if (ids.has(member.id)) problems.push(`${at} is duplicated`); ids.add(member.id);
    if (member.primitive !== policy.primitive) problems.push(`${at} primitive mismatch: ${member.primitive} is not ${policy.primitive}`);
    if (canonicalJson(member.definition) !== canonicalJson(policy.definition)) problems.push(`${at} definition pin mismatch`);
    if (!policy.compatibleUncertaintyProfiles.includes(member.uncertaintyProfile)) problems.push(`${at} uncertainty profile ${member.uncertaintyProfile} is not compatible`);
    if (combining && member.uncertaintyProfile !== policy.members[0]!.uncertaintyProfile) problems.push(`${at} cannot combine different uncertainty semantics`);
    for (const capability of [...policy.requiredCapabilities, ...member.requiredCapabilities]) {
      if (!member.capabilities.includes(capability)) problems.push(`${at} lacks required capability ${capability}`);
    }
    if (member.memberType === 'repeated-sample' && member.samples < 2) problems.push(`${at} repeated-sample member needs at least two samples`);
    if (member.memberType === 'prompt-adapter' && !member.approvalReference) problems.push(`${at} prompt/adapter variant requires explicit approval`);
    if (member.estimate.attemptsPerSample < member.fallbackDepth + 1) problems.push(`${at} attempt estimate does not cover its fallback depth`);
    if (member.memberType !== 'repeated-sample') {
      const identity = canonicalJson([member.binding.digest, member.adapter, member.model.provider, member.model.backend, member.model.pinnedVersion]);
      if (identities.has(identity)) problems.push(`${at} duplicates another member identity; independence is not established`);
      identities.add(identity);
    }
    if (policy.calibration.requirement === 'required' && !member.calibration) problems.push(`${at} requires a pinned calibration artifact`);
    const pin = options.calibrationPins?.[member.id];
    if (options.calibrationPins && member.calibration) {
      if (!pin) problems.push(`${at} has no resolved calibration compatibility pin`);
      else if (pin.action !== 'allow' || !['exact', 'approved-compatible'].includes(pin.state) || pin.artifactDigest !== member.calibration.artifactDigest || pin.artifactId !== member.calibration.artifactId) {
        problems.push(`${at} calibration is incompatible (${pin.state}/${pin.action})`);
      }
    }
  }
  const totalSamples = policy.members.reduce((sum, member) => sum + member.samples, 0);
  if (policy.acceptance.minimumSuccessfulMembers > totalSamples) problems.push('minimum successful members exceeds planned samples');
  semantic(problems, 'ensemble policy rejected');
  const budget = computeBudget(policy, options.hostCeilings ?? []);
  return { policy, digest: ensembleContractDigest(policy), budget };
}

/** Validation-time mirror of GraphBudgetLedger: effective limits are layer minima, estimates must be
 * safe integers with at least one attempt, attempts are never refunded, unknown cost needs a trusted
 * bound, and the whole plan is admitted all-or-nothing before any dispatch could start. */
export function planEnsembleBudget(value: unknown, hostCeilings: ReadonlyArray<Partial<EnsembleCeilings>> = []): EnsembleBudgetPlan {
  return validateEnsemblePolicy(value, { hostCeilings }).budget;
}

function computeBudget(policy: DecisionEnsemblePolicy, layers: ReadonlyArray<Partial<EnsembleCeilings>>): EnsembleBudgetPlan {
  const { members, attempts, deadlineMs, tokens, costMicros, concurrency, fallbackDepth } = policy.ceilings;
  const effective: EnsembleCeilings = { members, attempts, deadlineMs, tokens, costMicros, concurrency, fallbackDepth };
  for (const layer of layers) {
    for (const field of CEILING_FIELDS) {
      const limit = layer[field];
      if (limit === undefined) continue;
      if (!Number.isSafeInteger(limit) || limit < (field === 'fallbackDepth' ? 0 : 1)) throw new EnsembleContractError(`invalid host ceiling ${field}`, 'semantic');
      effective[field] = Math.min(effective[field], limit);
    }
  }
  const problems: string[] = [];
  const reservations: EnsembleReservation[] = [];
  const unknown = policy.ceilings.unknownCost;
  let slowestSample = 0;
  for (const member of [...policy.members].sort((a, b) => compareEnsembleKeys(a.id, b.id))) {
    const { attemptsPerSample, tokensPerAttempt, costMicrosPerAttempt, deadlineMsPerAttempt } = member.estimate;
    const perAttemptCost = costMicrosPerAttempt ?? (unknown.rule === 'reserve-bound' ? unknown.boundMicrosPerAttempt : null);
    if (perAttemptCost === null) { problems.push(`member ${member.id} has unknown cost and the policy rejects unbounded cost`); continue; }
    slowestSample = Math.max(slowestSample, attemptsPerSample * deadlineMsPerAttempt);
    for (let sampleIndex = 0; sampleIndex < member.samples; sampleIndex++) {
      reservations.push({ memberId: member.id, sampleIndex, attempts: attemptsPerSample,
        tokens: attemptsPerSample * tokensPerAttempt, costMicros: attemptsPerSample * perAttemptCost });
    }
  }
  const total = (field: 'attempts' | 'tokens' | 'costMicros') => reservations.reduce((sum, item) => sum + item[field], 0);
  const samples = policy.members.reduce((sum, member) => sum + member.samples, 0);
  const demand: EnsembleCeilings = {
    members: policy.members.length, attempts: total('attempts'), tokens: total('tokens'), costMicros: total('costMicros'),
    concurrency: Math.min(samples, effective.concurrency),
    deadlineMs: Math.ceil(samples / effective.concurrency) * slowestSample,
    fallbackDepth: Math.max(...policy.members.map(member => member.fallbackDepth)),
  };
  for (const field of CEILING_FIELDS) {
    if (!Number.isSafeInteger(demand[field])) problems.push(`ensemble ${field} demand is not a safe integer`);
    else if (demand[field] > effective[field]) problems.push(`ensemble ${field} demand ${demand[field]} exceeds ceiling ${effective[field]}`);
  }
  semantic(problems, 'ensemble budget rejected');
  return { effective, demand, reservations };
}

export interface ChampionChallengerContext {
  /** The D09 registry's PromotionEligibility record named by `eligibilityId`. */
  eligibility?: PromotionEligibility;
  /** Immutable D09 alias history used to confirm the exact rollback target. */
  aliasHistory?: readonly AliasEvent[];
}

/** Stable problem codes comparing a champion/challenger record with the D09 eligibility record. */
export function championChallengerEligibilityProblems(record: DecisionChampionChallenger, eligibility: PromotionEligibility): string[] {
  const problems: string[] = [];
  if (eligibility.id !== record.eligibilityId) problems.push('eligibility-id-mismatch');
  if (!eligibility.eligible) problems.push('eligibility-not-eligible');
  if (eligibility.alias !== record.alias) problems.push('eligibility-alias-mismatch');
  if (eligibility.candidateIdentityDigest !== record.challenger.identityDigest || eligibility.candidateActualModel !== record.challenger.actualModel) problems.push('eligibility-candidate-mismatch');
  if (eligibility.evaluationIntegrityReport.id !== record.evaluationIntegrityReport.id || eligibility.evaluationIntegrityReport.digest !== record.evaluationIntegrityReport.digest) problems.push('eligibility-integrity-report-mismatch');
  if (eligibility.approvalReference !== record.approval.reference) problems.push('eligibility-approval-mismatch');
  if (eligibility.rollbackTarget.aliasRevision !== record.rollbackTarget.aliasRevision || eligibility.rollbackTarget.identityDigest !== record.rollbackTarget.identityDigest) problems.push('eligibility-rollback-target-mismatch');
  return problems;
}

export function validateChampionChallenger(value: unknown, context: ChampionChallengerContext = {}): { record: DecisionChampionChallenger; digest: EnsembleDigest } {
  checkEnsembleSchema('championChallenger', value);
  const record = value as DecisionChampionChallenger;
  const problems: string[] = [];
  const metrics = record.pairedMetrics.map(item => item.metric);
  for (const metric of REQUIRED_PAIRED_METRICS) if (metrics.filter(item => item === metric).length !== 1) problems.push(`paired metric ${metric} must appear exactly once`);
  if (record.preregistration.thresholdsDigest !== pairedThresholdsDigest(record.pairedMetrics)) problems.push('paired thresholds do not match the preregistered digest');
  if (record.champion.identityDigest === record.challenger.identityDigest) problems.push('challenger must differ from the champion identity');
  if (record.rollbackTarget.aliasRevision !== record.champion.aliasRevision || record.rollbackTarget.identityDigest !== record.champion.identityDigest) {
    problems.push('rollback target must be the exact pinned champion revision');
  }
  const registered = time(record.preregistration.registeredAt);
  if (record.preregistration.holdoutAccessedAt !== null && time(record.preregistration.holdoutAccessedAt) <= registered) problems.push('thresholds must be preregistered before held-out access');
  if (registered > time(record.approval.approvedAt)) problems.push('approval cannot precede threshold preregistration');
  if (time(record.inputSet.frozenAt) > time(record.approval.approvedAt)) problems.push('approval cannot precede freezing the input set');
  if (record.inputSet.itemCount < Math.max(...record.pairedMetrics.map(item => item.minimumPairs))) problems.push('input set is smaller than the preregistered minimum pairs');
  if (context.eligibility) problems.push(...championChallengerEligibilityProblems(record, context.eligibility));
  if (context.aliasHistory) {
    const target = context.aliasHistory.find(event => event.revision === record.rollbackTarget.aliasRevision);
    if (!target || target.actualIdentityDigest !== record.rollbackTarget.identityDigest || target.kind === 'retired') problems.push('rollback target no longer matches immutable alias history');
  }
  semantic(problems, 'champion/challenger record rejected');
  return { record, digest: ensembleContractDigest(record) };
}

export function validateDriftResponsePolicy(value: unknown): DecisionDriftResponse {
  checkEnsembleSchema('driftResponse', value);
  const policy = value as DecisionDriftResponse;
  const problems: string[] = [];
  const ids = new Set<string>(); const keys = new Set<string>();
  for (const rule of policy.rules) {
    if (ids.has(rule.id)) problems.push(`drift rule ${rule.id} is duplicated`); ids.add(rule.id);
    const key = `${rule.source}/${rule.metric}`;
    if (keys.has(key)) problems.push(`drift signal ${key} has more than one configured response`); keys.add(key);
  }
  if (!policy.rules.some(rule => rule.source === 'alias-drift')) problems.push('alias-drift events have no configured response');
  if (policy.thresholds.digest !== driftThresholdsDigest(policy.rules)) problems.push('drift rules do not match the registered thresholds digest');
  if (policy.window.kind === 'observations' && policy.window.minimumSamples > policy.window.size) problems.push('minimum samples exceed the observation window');
  semantic(problems, 'drift response policy rejected');
  return policy;
}

export function validateEnsembleAggregate(value: unknown): DecisionEnsembleAggregate {
  checkEnsembleSchema('aggregate', value);
  const aggregate = value as DecisionEnsembleAggregate;
  const { digest, ...payload } = aggregate;
  const problems: string[] = [];
  if (digest !== ensembleContractDigest(payload)) problems.push('aggregate digest does not match its content');
  const { counts } = aggregate;
  if (counts.succeeded + counts.failed + counts.abstained !== counts.declared || aggregate.members.length !== counts.declared) problems.push('aggregate counts do not reconcile');
  if (aggregate.outcome.disposition !== 'accept' && aggregate.outcome.value !== null) problems.push('a deferred aggregate cannot carry an outcome value');
  if (!ENSEMBLE_AGGREGATION_PRIMITIVES[aggregate.algorithm.id as EnsembleAggregationAlgorithm]?.includes(aggregate.primitive)) problems.push('unknown or incompatible aggregation version');
  semantic(problems, 'ensemble aggregate rejected');
  return aggregate;
}

/** A D17 report may keep or tighten the upstream #2037/#2048 decision, never loosen it. */
export function validateEnsembleIntegrityReport(value: unknown): DecisionEnsembleIntegrityReport {
  checkEnsembleSchema('integrityReport', value);
  const report = value as DecisionEnsembleIntegrityReport;
  const { digest, ...payload } = report;
  const problems: string[] = [];
  if (report.upstreamDecision !== report.integrity.release_gate.decision) problems.push('upstream decision must be the eval-integrity release gate decision');
  if (GATE_RANK[report.decision] < GATE_RANK[report.upstreamDecision]) problems.push(`D17 cannot upgrade ${report.upstreamDecision} to ${report.decision}`);
  if (report.decision === 'PROMOTE' && (report.findings.length > 0 || report.pairedDeltas.some(item => !item.passed))) problems.push('PROMOTE requires every D17 check to pass');
  if (digest !== ensembleContractDigest(payload)) problems.push('integrity report digest does not match its content');
  semantic(problems, 'ensemble integrity report rejected');
  return report;
}

export function integrityGateRank(decision: IntegrityGateDecision): number { return GATE_RANK[decision]; }
