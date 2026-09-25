/**
 * D16 adoption of the AIWG effect ledger (#2722).
 *
 * - `ledgerJobEffectRecorder` records a `decision.receipt` effect for a job
 *   item attempt once the admitted evaluator has written its D03 receipt and
 *   before the job record is updated. The effect's payload digest is the D03
 *   receipt digest, so the ledger holds digest references only.
 * - `ledgerExecutionUnknownResolver` is the opt-in resolver for
 *   `DecisionJobRuntime.reconcile(..., { resolveUnknown })`. It resolves an
 *   `execution-unknown` item only when the `decision.receipt` verifier reports
 *   `present` / `digest-match` against the digest the ledger recorded, and the
 *   D03 receipt still has that digest. `state-match`, `absent` and `unknown`
 *   never resolve, and nothing is ever dispatched or replayed.
 *
 * Effect identity: kind `decision.receipt`, target
 * `decision:job/<jobId>/<itemId>`, context the job scope plus `attemptId`,
 * subsystem `job`. The ledger's tenant and project are the job's.
 *
 * @see docs/decision/async-jobs.md "Resolving execution-unknown"
 * @see docs/contracts/effect-ledger.v1.md "Composition"
 */

import {
  createVerifierRegistry,
  decisionReceiptVerifier,
  effectId as deriveEffectId,
  lookupEffect,
  reconcileEffect,
  recordIntent,
  type EffectLedger,
  type EffectLinks,
} from '../effects/index.js';
import { decisionResultJobState } from './job-evaluate.js';
import type { ExecutionUnknownResolver } from './job-runtime.js';
import type { JobScope, JobStore } from './job-store.js';
import type { JobItemEffectRecorder } from './job-worker.js';
import type { DecisionReceiptStore } from './types.js';
import { artifactDigest } from './validate.js';

export const JOB_EFFECT_KIND = 'decision.receipt' as const;

/** The ledger identity (kind, target, context) of one job item attempt. */
export function jobItemEffectIdentity(scope: JobScope, jobId: string, itemId: string, attemptId: string) {
  return {
    kind: JOB_EFFECT_KIND,
    target: `decision:job/${jobId}/${itemId}`,
    context: { tenantId: scope.tenantId, projectId: scope.projectId, workspaceId: scope.workspaceId, principalId: scope.principalId, attemptId },
  };
}

/** The effect ID of one job item attempt in a `job` ledger for the job's tenant and project. */
export function jobItemEffectId(scope: JobScope, jobId: string, itemId: string, attemptId: string): string {
  const identity = jobItemEffectIdentity(scope, jobId, itemId, attemptId);
  return deriveEffectId({ scope: { tenant: scope.tenantId, project: scope.projectId, subsystem: 'job' }, ...identity });
}

export interface JobEffectLedgerOptions {
  /** A ledger with subsystem `job` whose tenant and project are the jobs'. */
  ledger: EffectLedger;
  /** The D03 receipt store the admitted evaluator writes. */
  receipts: DecisionReceiptStore;
  /** The D16 job store. */
  jobs: JobStore;
  timeoutMs?: number;
  /** Correlation links (for example the #1567 operator decision that authorized the job). */
  links?: EffectLinks;
}

function assertJobLedger(options: JobEffectLedgerOptions): void {
  if (options.ledger.scope.subsystem !== 'job') throw new Error('Job effect ledger must use the job subsystem');
}

const inScope = (options: JobEffectLedgerOptions, scope: JobScope) =>
  options.ledger.scope.tenant === scope.tenantId && options.ledger.scope.project === scope.projectId;

function registry(options: JobEffectLedgerOptions) {
  return createVerifierRegistry([decisionReceiptVerifier({ receipts: options.receipts, jobs: options.jobs })]);
}

/** Records the D03 receipt of a finished attempt: a signed intent carrying the receipt digest, then a verified `completed`. */
export function ledgerJobEffectRecorder(options: JobEffectLedgerOptions): JobItemEffectRecorder {
  assertJobLedger(options);
  return {
    async recordReceipt({ scope, jobId, itemId, attemptId, receiptDigest }) {
      if (!inScope(options, scope)) throw new Error('Job effect ledger scope mismatch');
      const identity = jobItemEffectIdentity(scope, jobId, itemId, attemptId);
      const intent = await recordIntent(options.ledger, { ...identity, payloadDigest: receiptDigest, links: options.links });
      await reconcileEffect(options.ledger, intent.effectId, {
        verifiers: registry(options), expected: { digest: receiptDigest }, links: options.links,
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
    },
  };
}

/** The opt-in D16 resolver backed by the effect ledger. Resolves only on `digest-match`. */
export function ledgerExecutionUnknownResolver(options: JobEffectLedgerOptions): ExecutionUnknownResolver {
  assertJobLedger(options);
  return async ({ job, item, attempt }) => {
    if (!inScope(options, job.scope) || item.state !== 'execution-unknown' || attempt.outcome !== 'execution-unknown') return null;
    const id = jobItemEffectId(job.scope, job.id, item.id, attempt.id);
    const lookup = await lookupEffect(options.ledger, id);
    const intent = lookup.records.find(record => record.phase === 'intent');
    // Without a recorded digest there is nothing to match: the item stays execution-unknown.
    if (!intent || lookup.tombstoned) return null;
    const recorded = intent.payloadDigest;
    const outcome = await reconcileEffect(options.ledger, id, {
      verifiers: registry(options), expected: { digest: recorded }, links: options.links,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    const verification = outcome.result.verification;
    if (verification.result !== 'present' || verification.reason !== 'digest-match') return null;
    const receipt = await options.receipts.read(attempt.id, job.scope.projectId);
    if (!receipt || receipt.state !== 'completed' || !receipt.result || artifactDigest(receipt) !== recorded) return null;
    const state = decisionResultJobState(receipt.result);
    if (state !== 'succeeded' && state !== 'review') return null;
    return {
      state, effectId: id, reason: 'digest-match',
      receiptDigest: recorded as `sha256:${string}`, resultDigest: artifactDigest(receipt.result) as `sha256:${string}`,
    };
  };
}
