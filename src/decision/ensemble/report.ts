import type { AliasEvent, PromotionEligibility } from '../calibration/types.js';
import type { QualificationIntegrityMetadata } from '../qualification/release.js';
import {
  championChallengerEligibilityProblems, ensembleContractDigest, EnsembleContractError, validateChampionChallenger,
  validateEnsembleIntegrityReport,
} from './contract.js';
import type { DecisionEnsembleIntegrityReport, IntegrityGateDecision, PairedDeltaObservation } from './types.js';

export interface EnsembleIntegrityReportInput {
  record: unknown;
  /** The #2037/#2048 integrity metadata and release gate, carried unchanged. */
  integrity: QualificationIntegrityMetadata;
  pairedDeltas: readonly PairedDeltaObservation[];
  /** D09 eligibility for `record.eligibilityId`; null records the gap and holds promotion. */
  eligibility: PromotionEligibility | null;
  aliasHistory?: readonly AliasEvent[];
}

/** Extends the eval-integrity report with paired champion/challenger evidence. D17 findings can
 * only hold or roll back: HOLD and ROLLBACK from the upstream gate are never upgraded. */
export function buildEnsembleIntegrityReport(input: EnsembleIntegrityReportInput): DecisionEnsembleIntegrityReport {
  const { record, digest } = validateChampionChallenger(input.record, input.aliasHistory ? { aliasHistory: input.aliasHistory } : {});
  const integrity = input.integrity;
  const findings = new Set<string>();
  if (!input.eligibility) findings.add('d09-eligibility-missing');
  else for (const problem of championChallengerEligibilityProblems(record, input.eligibility)) findings.add(`d09-${problem}`);
  if (integrity.integrity_state !== 'verified') findings.add('integrity-not-verified');
  if (integrity.integrity_mode === 'standard') findings.add('integrity-mode-standard');
  if (integrity.trusted_score_source === 'local-unverified') findings.add('untrusted-score-source');
  if (integrity.fresh_workspace_required && !integrity.fresh_workspace_verified) findings.add('fresh-workspace-unverified');
  if (integrity.uncertainty === null) findings.add('uncertainty-missing');
  if (integrity.paired_baseline === null) findings.add('paired-baseline-missing');
  if (integrity.weak_signal_reason !== null) findings.add('weak-signal');
  if (integrity.compromise_labels.length > 0) findings.add('compromised');
  if (integrity.sample_n < Math.max(...record.pairedMetrics.map(item => item.minimumPairs))) findings.add('insufficient-samples');

  const observed = new Map<string, PairedDeltaObservation>();
  for (const item of input.pairedDeltas) {
    if (observed.has(item.metric)) throw new EnsembleContractError(`paired delta ${item.metric} is duplicated`, 'semantic');
    observed.set(item.metric, item);
  }
  const pairedDeltas = record.pairedMetrics.map(threshold => {
    const item = observed.get(threshold.metric);
    const delta = item?.delta ?? null; const pairs = item?.pairs ?? 0;
    let passed = true;
    if (!item) { findings.add(`paired-delta-missing:${threshold.metric}`); passed = false; }
    else if (delta === null || !Number.isFinite(delta)) { findings.add(`paired-delta-unknown:${threshold.metric}`); passed = false; }
    else if (!Number.isSafeInteger(pairs) || pairs < threshold.minimumPairs) { findings.add(`paired-delta-insufficient:${threshold.metric}`); passed = false; }
    else if (threshold.comparison === 'delta-at-least' ? delta < threshold.bound : delta > threshold.bound) { findings.add(`paired-delta-failed:${threshold.metric}`); passed = false; }
    return { ...threshold, delta, pairs, passed };
  }).sort((a, b) => a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0);

  const upstreamDecision = integrity.release_gate.decision;
  const compromised = integrity.integrity_state === 'compromised' || integrity.compromise_labels.length > 0;
  const decision: IntegrityGateDecision = upstreamDecision === 'ROLLBACK' || compromised ? 'ROLLBACK'
    : upstreamDecision === 'HOLD' || findings.size > 0 ? 'HOLD' : 'PROMOTE';
  const payload: Omit<DecisionEnsembleIntegrityReport, 'digest'> = {
    schemaVersion: 'decision-ensemble-integrity-report/v1',
    subject: { kind: 'champion-challenger', id: record.id, digest, eligibilityId: record.eligibilityId },
    integrity, pairedDeltas, findings: [...findings].sort(), upstreamDecision, decision,
  };
  return validateEnsembleIntegrityReport({ ...payload, digest: ensembleContractDigest(payload) });
}
