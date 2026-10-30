// Acceptance checks over conductor briefs, trusted head/lineage and verifier records.
import { workerReviewLineageDiagnostics } from '../models/worker-review-lineage.js';
import type { WorkerModelObservation } from '../models/types.js';
import {
  WorkerContractError, type WorkerBrief, type WorkerDirectBrief, type WorkerExecution,
  type WorkerVerification, type WorkerDirectVerification, type WorkerReviewEvidence,
} from './types.js';

type Verification = WorkerVerification | WorkerDirectVerification;
export interface WorkerAcceptanceContext {
  /** Current PR head supplied by the trusted conductor, never by worker claims. */
  headSha?: string;
  reviewLineage?: {
    writer: WorkerModelObservation;
    reviewers: WorkerModelObservation[];
  };
}
function fail(message: string): never { throw new WorkerContractError('OG_CONTRACT_INVALID', message); }

/** Read an existing verifier verdict; never promote worker completion to acceptance. */
export function hasIndependentWorkerAcceptance(verification: Verification): boolean {
  return verification.status === 'accepted'
    && !!verification.reviewRounds?.length
    && verification.evidence.length > 0
    && workerReviewEvidenceErrors(verification).length === 0;
}

/** Additional relational checks after JSON Schema shape validation. */
export function workerReviewEvidenceErrors(verification: Verification): string[] {
  const errors: string[] = [];
  const rounds = verification.reviewRounds;
  if (rounds?.some((review, index) => review.round !== index + 1)) {
    errors.push('Review rounds must be contiguous and start at one');
  }
  const ledger = verification.findingsLedger ?? [];
  if (new Set(ledger.map(finding => finding.id)).size !== ledger.length) errors.push('Finding IDs must be unique');
  if (rounds && ledger.some(finding => finding.round > rounds.length)) errors.push('Finding round has no review record');
  if (verification.roundsToClean !== undefined && (verification.status !== 'accepted'
    || verification.roundsToClean !== rounds?.length)) errors.push('roundsToClean must count all review rounds on acceptance');
  if (verification.status === 'accepted') {
    if (ledger.some(finding => finding.class === 'A' && finding.status === 'open'
      && ['blocker', 'major'].includes(finding.severity))) errors.push('Open class A blocker or major findings prevent acceptance');
    if (rounds?.length && (verification.headSha !== rounds.at(-1)!.headSha
      || verification.roundsToClean !== rounds.length || !verification.findingsLedger)) {
      errors.push('Accepted review needs the final headSha, findingsLedger and roundsToClean');
    }
  }
  const commands = verification.oracleResults?.map(result => result.command) ?? [];
  if (new Set(commands).size !== commands.length) errors.push('Oracle result commands must be unique');
  return errors;
}

/** Derive telemetry, then validate it through the normal verifier payload codec. */
export function prepareWorkerAcceptance(
  brief: WorkerBrief | WorkerDirectBrief, execution: WorkerExecution,
  supplied: Verification, context: WorkerAcceptanceContext,
): Verification {
  const verification = structuredClone(supplied);
  if (verification.status !== 'accepted') return verification;
  if (brief.designReviewRequired && !brief.designReviewArtifact) {
    fail('Acceptance requires a design-review artifact in the implementation brief');
  }
  const oracle = brief.verificationOracle;
  if (oracle) {
    const results = verification.oracleResults ?? [];
    if (new Set(oracle.map(check => check.command)).size !== oracle.length
      || results.length !== oracle.length || oracle.some(check => {
        const matches = results.filter(result => result.command === check.command);
        return matches.length !== 1 || matches[0].exitCode !== check.expectedExitCode;
      })) fail('Acceptance requires exact verificationOracle command outcomes');
  }
  const required = brief.intent.verification.independentReview === 'required'
    || brief.intent.verification.differentFamily === 'require';
  const rounds = verification.reviewRounds ?? [];
  if (!required && !rounds.length) return verification;
  const final = rounds.at(-1);
  if (!final) fail('Acceptance requires a final cross-model review record');
  if (!context.headSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(context.headSha)
    || final.headSha !== context.headSha || verification.headSha !== undefined && verification.headSha !== context.headSha) {
    fail('Final review is missing the current PR head SHA or is bound to a stale head');
  }
  const writer = context.reviewLineage?.writer;
  const observations = context.reviewLineage?.reviewers;
  const reviewers = Array.isArray(observations)
    ? observations.filter(observation => observation?.recordId === final.reviewerObservationRef) : [];
  if (reviewers.length !== 1) fail('Final review is missing unambiguous reviewer lineage');
  const diagnostics = workerReviewLineageDiagnostics({ reviewOf: writer, reviewer: reviewers[0], requireDifferentFamily: true });
  if (diagnostics.length) fail(diagnostics.map(diagnostic => `${diagnostic.pointer}: ${diagnostic.message}`).join('; '));
  if (writer!.cliId !== brief.selected.cli || writer!.family !== execution.observedFamily) {
    fail('Review source lineage differs from the observed writer');
  }
  if (verification.roundsToClean !== undefined && verification.roundsToClean !== rounds.length) {
    fail('roundsToClean differs from the retained review rounds');
  }
  verification.headSha = context.headSha;
  verification.roundsToClean = rounds.length;
  return verification;
}

/** Successors keep earlier rounds and findings; resolving a finding retains its ID. */
export function assertWorkerReviewSuccessor(prior: WorkerReviewEvidence, next: WorkerReviewEvidence): void {
  for (const [index, round] of (prior.reviewRounds ?? []).entries()) {
    const successor = next.reviewRounds?.[index];
    if (!successor || successor.round !== round.round || successor.headSha !== round.headSha
      || successor.reviewerObservationRef !== round.reviewerObservationRef
      || successor.artifact.ref !== round.artifact.ref || successor.artifact.digest !== round.artifact.digest) {
      fail('Worker successor drops or rewrites a review round');
    }
  }
  for (const finding of prior.findingsLedger ?? []) {
    const successor = next.findingsLedger?.find(candidate => candidate.id === finding.id);
    if (!successor || successor.class !== finding.class || successor.severity !== finding.severity || successor.round !== finding.round) {
      fail('Worker successor drops or reclassifies a retained finding');
    }
  }
}
