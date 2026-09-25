import { admitEntry } from '../entry.js';
import {
  compareEnsembleKeys, ensembleContractDigest, EnsembleContractError, validateEnsemblePolicy, type EnsemblePolicyValidationOptions,
} from './contract.js';
import type {
  DecisionEnsembleAggregate, DecisionEnsemblePolicy, EnsembleMember, EnsembleMemberResult, EnsembleWarning,
} from './types.js';

/** Deterministic reference aggregation over already-recorded member results. It never dispatches.
 * Member order does not matter: results are put in canonical (memberId, sampleIndex) order first,
 * so every sum and tie-break runs in the same sequence for any permutation of the input. */
export function aggregateEnsembleResults(
  policyInput: unknown, resultsInput: readonly EnsembleMemberResult[], options: EnsemblePolicyValidationOptions = {},
): DecisionEnsembleAggregate {
  const { policy, digest: policyDigest } = validateEnsemblePolicy(policyInput, options);
  try { admitEntry(resultsInput); } catch { throw new EnsembleContractError('member results admission denied', 'admission'); }
  const members = new Map(policy.members.map(member => [member.id, member]));
  const results = [...resultsInput].sort((a, b) => compareEnsembleKeys(a.memberId, b.memberId) || a.sampleIndex - b.sampleIndex);
  validateResults(policy, members, results);
  const succeeded = results.filter(result => result.status === 'succeeded');
  const n = succeeded.length;
  const labels = labelSpace(policy);
  const statistics: DecisionEnsembleAggregate['statistics'] = {
    votes: null, meanProbability: null, meanDistribution: null, meanScore: null, medianScore: null, dispersion: null,
  };
  const { algorithm, tieRule } = policy.aggregation;
  const { metric } = policy.disagreement;
  let candidate: string | number | null = null;
  let tie = false;

  const votes = () => {
    const counts = Object.fromEntries(labels.map(label => [label, 0])) as Record<string, number>;
    for (const result of succeeded) counts[vote(policy, result)]! += 1;
    return counts;
  };
  const distributions = () => succeeded.map(result => distributionOf(policy, labels, result));
  const meanOf = (items: Record<string, number>[]) => Object.fromEntries(labels.map(label =>
    [label, n ? round(items.reduce((sum, item) => sum + item[label]!, 0) / n) : 0])) as Record<string, number>;
  const scores = () => succeeded.map(result => result.value as number);
  const pick = (weights: Record<string, number>) => {
    const top = Math.max(...labels.map(label => weights[label]!));
    const winners = labels.filter(label => weights[label] === top);
    tie = winners.length > 1; return n ? winners[0]! : null;
  };

  if (algorithm === 'majority-v1' || metric === 'vote-share-v1' || metric === 'normalized-entropy-v1') statistics.votes = votes();
  if (policy.primitive === 'truth-probability' && (algorithm === 'mean-probability-v1' || metric === 'jensen-shannon-v1')) {
    statistics.meanProbability = n ? round(succeeded.reduce((sum, result) => sum + (result.value as number), 0) / n) : null;
  }
  if (policy.primitive === 'choice' && (algorithm === 'mean-probability-v1' || metric === 'jensen-shannon-v1')) statistics.meanDistribution = meanOf(distributions());
  if (policy.primitive === 'ordinal-score' && n) {
    const values = scores(); const mean = values.reduce((sum, value) => sum + value, 0) / n;
    statistics.meanScore = round(mean);
    statistics.dispersion = round(Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n));
    const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(n / 2);
    statistics.medianScore = round(n % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2);
  }

  if (algorithm === 'majority-v1') candidate = pick(statistics.votes!);
  else if (algorithm === 'mean-probability-v1') candidate = policy.primitive === 'choice' ? pick(statistics.meanDistribution!) : statistics.meanProbability;
  else if (algorithm === 'score-distribution-mean-v1') candidate = statistics.meanScore;
  else if (n) {
    // score-median-v1: an even count with distinct middle values is a tie; the stable rule takes the lower value.
    const sorted = scores().sort((a, b) => a - b); const middle = Math.floor(n / 2);
    tie = n % 2 === 0 && sorted[middle - 1] !== sorted[middle];
    candidate = tie ? sorted[middle - 1]! : statistics.medianScore;
  }

  const disagreementValue = n === 0 ? 1 : disagreement(policy, statistics, distributions, n);
  const valueBps = Math.round(Math.min(1, Math.max(0, disagreementValue)) * 10_000);
  const exceeded = valueBps > policy.disagreement.thresholdBps;
  let disposition: DecisionEnsembleAggregate['outcome']['disposition'] = 'accept';
  let reason: DecisionEnsembleAggregate['outcome']['reason'] = 'aggregated';
  if (n < policy.acceptance.minimumSuccessfulMembers) { disposition = policy.acceptance.onInsufficientMembers; reason = 'insufficient-members'; }
  else if (tie && tieRule !== 'lowest-canonical-value') { disposition = tieRule; reason = 'tie'; }
  else if (exceeded) { disposition = policy.disagreement.onExceeded; reason = 'disagreement-exceeded'; }

  const contributing = succeeded.map(result => members.get(result.memberId)!);
  const warnings = new Set<EnsembleWarning>();
  if (results.some(result => result.status !== 'succeeded')) warnings.add('member-failures-present');
  if (contributing.some(member => !member.calibration)) warnings.add('uncalibrated-members');
  if (n >= 2 && valueBps <= policy.acceptance.highAgreementWarningBps) {
    warnings.add('high-agreement-not-correctness');
    if (limitedIndependence(contributing)) warnings.add('shared-systematic-error-risk');
  }

  const payload: Omit<DecisionEnsembleAggregate, 'digest'> = {
    schemaVersion: 'decision-ensemble-aggregate/v1',
    policy: { id: policy.id, version: policy.version, digest: policyDigest },
    primitive: policy.primitive,
    algorithm: { id: algorithm, version: versionOf(algorithm) },
    semantics: 'stability-signal-not-correctness',
    provenance: 'derived',
    members: results.map(result => ({ memberId: result.memberId, sampleIndex: result.sampleIndex, status: result.status,
      resultDigest: result.resultDigest, value: result.value })),
    counts: { declared: results.length, succeeded: n, failed: results.filter(result => result.status === 'failed').length,
      abstained: results.filter(result => result.status === 'abstained').length },
    outcome: { disposition, value: disposition === 'accept' ? candidate : null, reason, tie, tieRule: tie ? tieRule : null },
    statistics,
    disagreement: { metric: { id: metric, version: versionOf(metric) }, valueBps, thresholdBps: policy.disagreement.thresholdBps, exceeded },
    warnings: [...warnings].sort(compareEnsembleKeys),
    correctnessGate: { status: 'not-satisfied', reason: 'agreement-is-not-correctness-evidence' },
  };
  return { ...payload, digest: ensembleContractDigest(payload) };
}

function validateResults(policy: DecisionEnsemblePolicy, members: Map<string, EnsembleMember>, results: readonly EnsembleMemberResult[]): void {
  const problems: string[] = []; const seen = new Set<string>();
  const needsDistribution = policy.primitive === 'choice'
    && (policy.aggregation.algorithm === 'mean-probability-v1' || policy.disagreement.metric === 'jensen-shannon-v1');
  for (const result of results) {
    const at = `result ${result.memberId}#${result.sampleIndex}`;
    const member = members.get(result.memberId);
    if (!member) { problems.push(`${at} names an unknown member`); continue; }
    if (!Number.isSafeInteger(result.sampleIndex) || result.sampleIndex < 0 || result.sampleIndex >= member.samples) problems.push(`${at} is outside the planned samples`);
    const key = `${result.memberId}\u0000${result.sampleIndex}`;
    if (seen.has(key)) problems.push(`${at} is duplicated`); seen.add(key);
    if (!/^sha256:[0-9a-f]{64}$/.test(result.resultDigest)) problems.push(`${at} must pin its retained result lineage`);
    if (!['succeeded', 'failed', 'abstained'].includes(result.status)) problems.push(`${at} has an unknown status`);
    if (result.status !== 'succeeded') {
      if (result.value !== null || result.distribution !== null) problems.push(`${at} is not successful and cannot carry a value`);
      continue;
    }
    if (result.uncertaintyProfile !== member.uncertaintyProfile) problems.push(`${at} uncertainty profile does not match its member`);
    const value = result.value;
    if (policy.primitive === 'choice' && (typeof value !== 'string' || !policy.options!.includes(value))) problems.push(`${at} is not a declared choice option`);
    if (policy.primitive === 'truth-probability' && (typeof value !== 'number' || !(value >= 0 && value <= 1))) problems.push(`${at} is not a probability`);
    if (policy.primitive === 'ordinal-score' && (typeof value !== 'number' || !(value >= 0 && value <= policy.levels! - 1))) problems.push(`${at} is outside the score levels`);
    if (result.distribution !== null) {
      const entries = Object.entries(result.distribution);
      const allowed = policy.primitive === 'choice' ? policy.options! : ['false', 'true'];
      if (policy.primitive === 'ordinal-score' || entries.some(([label, p]) => !allowed.includes(label) || !(p >= 0 && p <= 1))
        || Math.abs(entries.reduce((sum, [, p]) => sum + p, 0) - 1) > 1e-6) problems.push(`${at} has an invalid distribution`);
    } else if (needsDistribution) problems.push(`${at} needs a provider distribution for ${policy.aggregation.algorithm}/${policy.disagreement.metric}`);
  }
  const planned = policy.members.reduce((sum, member) => sum + member.samples, 0);
  if (results.length !== planned) problems.push(`every planned sample must be recorded, including failures (${results.length}/${planned})`);
  if (problems.length) throw new EnsembleContractError(`member results rejected: ${problems[0]}`, 'semantic', problems);
}

function labelSpace(policy: DecisionEnsemblePolicy): string[] {
  return policy.primitive === 'choice' ? [...policy.options!].sort(compareEnsembleKeys) : policy.primitive === 'truth-probability' ? ['false', 'true'] : [];
}
/** Noul votes true at p >= 0.5; the threshold is part of majority-v1 and vote-share-v1. */
function vote(policy: DecisionEnsemblePolicy, result: EnsembleMemberResult): string {
  return policy.primitive === 'truth-probability' ? ((result.value as number) >= 0.5 ? 'true' : 'false') : result.value as string;
}
function distributionOf(policy: DecisionEnsemblePolicy, labels: string[], result: EnsembleMemberResult): Record<string, number> {
  if (policy.primitive === 'truth-probability') { const p = result.value as number; return { false: 1 - p, true: p }; }
  return Object.fromEntries(labels.map(label => [label, result.distribution?.[label] ?? 0]));
}
function entropyBits(weights: readonly number[]): number {
  return -weights.reduce((sum, p) => sum + (p > 0 ? p * Math.log2(p) : 0), 0);
}
function disagreement(policy: DecisionEnsemblePolicy, statistics: DecisionEnsembleAggregate['statistics'],
  distributions: () => Record<string, number>[], n: number): number {
  const metric = policy.disagreement.metric;
  if (metric === 'vote-share-v1') return 1 - Math.max(...Object.values(statistics.votes!)) / n;
  if (metric === 'normalized-entropy-v1') {
    const counts = Object.values(statistics.votes!);
    return entropyBits(counts.map(count => count / n)) / Math.log2(counts.length);
  }
  if (metric === 'jensen-shannon-v1') {
    const items = distributions(); const labels = Object.keys(items[0] ?? {});
    const scale = Math.log2(Math.min(n, labels.length));
    if (!(scale > 0)) return 0;
    const mean = labels.map(label => items.reduce((sum, item) => sum + item[label]!, 0) / n);
    const within = items.reduce((sum, item) => sum + entropyBits(labels.map(label => item[label]!)), 0) / n;
    return (entropyBits(mean) - within) / scale;
  }
  // score-dispersion-v1: population standard deviation over its maximum, half the level span.
  return (statistics.dispersion ?? 0) / ((policy.levels! - 1) / 2);
}
function limitedIndependence(members: readonly EnsembleMember[]): boolean {
  const identities = new Set(members.map(member => `${member.model.provider}\u0000${member.model.backend}\u0000${member.model.pinnedVersion}`));
  return identities.size < 2 || members.every(member => member.memberType === 'repeated-sample' || member.memberType === 'prompt-adapter');
}
function versionOf(id: string): string { return id.slice(id.lastIndexOf('-') + 1); }
/** Removes binary floating-point noise from derived statistics; raw member values are retained unchanged. */
function round(value: number): number { return Math.round(value * 1e12) / 1e12; }
