/**
 * Built-in `decision.receipt` verifier over the D03 receipt stores and D16 job
 * items, and the `decision.review.continuation` placeholder (#2721).
 *
 * Target forms (`decision:<receipt-id>`):
 *
 * | Target | Source | Store scope from |
 * |---|---|---|
 * | `decision:invocation/<invocationId>` | D03 `DecisionReceiptStore.read` | `projectId` |
 * | `decision:batch/<batchId>` | D03 `BatchReceiptStore.read` | `tenantId`, `projectId` |
 * | `decision:job/<jobId>/<itemId>` | D16 `JobStore.read`, then the D03 receipt of the item's latest attempt | `tenantId`, `projectId`, `workspaceId`, `principalId` |
 *
 * Scope members come from the effect context, falling back to the verifier
 * options. The expected receipt digest (`artifactDigest` of the receipt) comes
 * from `expected.digest`, then `context.receiptDigest`; for a job item the
 * attempt's recorded `receiptDigest` wins.
 *
 * @see docs/contracts/effect-ledger.v1.md "Built-in verifiers"
 */

import type { BatchReceiptStore } from '../../decision/batch-receipts/types.js';
import type { JobScope, JobStore } from '../../decision/job-store.js';
import { DecisionReceiptAccessError } from '../../decision/receipts.js';
import type { DecisionReceiptStore } from '../../decision/types.js';
import { artifactDigest } from '../../decision/validate.js';
import type { EffectVerifier, EffectVerifierEvidence, EffectVerifierObservation, EffectVerifierRequest } from './types.js';

export interface DecisionReceiptVerifierOptions {
  /** D03 invocation receipts. Also used for D16 job item attempts. */
  receipts?: DecisionReceiptStore;
  /** D03 batch receipts. */
  batches?: BatchReceiptStore;
  /** D16 job store. */
  jobs?: JobStore;
  /** Defaults for store scoping when the effect context does not carry them. */
  tenantId?: string;
  projectId?: string;
  workspaceId?: string;
  principalId?: string;
}

export const DECISION_RECEIPT_VERIFIER_VERSION = '1.0.0';
export const REVIEW_CONTINUATION_PLACEHOLDER_VERSION = '0.1.0';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

type Observation = EffectVerifierObservation;
const unknown = (reason: Observation['reason'], evidence?: EffectVerifierEvidence): Observation =>
  ({ result: 'unknown', reason, complete: false, ...(evidence ? { evidence } : {}) });
const absent = (evidence: EffectVerifierEvidence): Observation =>
  ({ result: 'absent', reason: 'complete-query-no-match', complete: true, evidence });

function member(request: EffectVerifierRequest, options: DecisionReceiptVerifierOptions, name: 'tenantId' | 'projectId' | 'workspaceId' | 'principalId'): string | undefined {
  const value = request.context[name] ?? options[name];
  return typeof value === 'string' && value ? value : undefined;
}

function expectedDigest(request: EffectVerifierRequest): string | undefined | null {
  const value = request.expected.digest ?? request.context.receiptDigest;
  if (value === undefined) return undefined;
  return typeof value === 'string' && DIGEST.test(value) ? value : null;
}

/** Store failures are never `absent`: denial is `auth-denied`, anything else (MAC, corruption, I/O) `container-unreadable`. */
function storeFailure(error: unknown): Observation {
  if (error instanceof DecisionReceiptAccessError) return unknown('auth-denied');
  return unknown('container-unreadable');
}

async function read<T>(load: () => Promise<T>): Promise<{ value: T } | { failure: Observation }> {
  try { return { value: await load() }; } catch (error) { return { failure: storeFailure(error) }; }
}

function digestOf(value: unknown): string | null {
  try { return artifactDigest(value); } catch { return null; }
}

/** Settle a D03 state machine: completed is present, failed is absent, anything else is unsettled. */
function settle(state: string, receipt: unknown, expected: string | undefined, base: EffectVerifierEvidence): Observation {
  if (state === 'completed') {
    const actual = digestOf(receipt);
    if (!actual) return unknown('malformed-response');
    const evidence = { ...base, state, receiptDigest: actual, expectedDigest: expected ?? null };
    if (expected === undefined) return { result: 'present', reason: 'state-match', complete: true, evidence };
    return actual === expected
      ? { result: 'present', reason: 'digest-match', complete: true, evidence }
      : unknown('evidence-conflict', evidence);
  }
  if (state === 'failed') return absent({ ...base, state });
  return unknown('consistency-lag', { ...base, state });
}

/** `decision.receipt`: D03 invocation and batch receipts, and D16 job items. */
export function decisionReceiptVerifier(options: DecisionReceiptVerifierOptions = {}): EffectVerifier {
  return {
    kind: 'decision.receipt',
    version: DECISION_RECEIPT_VERIFIER_VERSION,
    canReportAbsent: true,
    async verify(request) {
      if (!request.target.startsWith('decision:')) return unknown('malformed-response');
      const parts = request.target.slice('decision:'.length).split('/');
      const expected = expectedDigest(request);
      if (expected === null) return unknown('malformed-response');
      if (!parts.slice(1).every(part => SEGMENT.test(part))) return unknown('malformed-response');

      if (parts[0] === 'invocation' && parts.length === 2) {
        const projectId = member(request, options, 'projectId');
        if (!options.receipts || !projectId) return unknown('container-unreadable');
        const loaded = await read(() => options.receipts!.read(parts[1], projectId));
        if ('failure' in loaded) return loaded.failure;
        const base = { source: 'd03-invocation', invocationId: parts[1] };
        if (!loaded.value) return absent({ ...base, found: false });
        const fingerprint = request.context.fingerprint;
        if (typeof fingerprint === 'string' && fingerprint !== loaded.value.fingerprint) return unknown('evidence-conflict', { ...base, found: true });
        return settle(loaded.value.state, loaded.value, expected, base);
      }

      if (parts[0] === 'batch' && parts.length === 2) {
        const tenantId = member(request, options, 'tenantId');
        const projectId = member(request, options, 'projectId');
        if (!options.batches || !tenantId || !projectId) return unknown('container-unreadable');
        const loaded = await read(() => options.batches!.read(parts[1], tenantId, projectId));
        if ('failure' in loaded) return loaded.failure;
        const base = { source: 'd03-batch', batchId: parts[1] };
        if (!loaded.value) return absent({ ...base, found: false });
        return settle(loaded.value.status, loaded.value, expected, base);
      }

      if (parts[0] === 'job' && parts.length === 3) {
        const scope: Partial<JobScope> = {
          tenantId: member(request, options, 'tenantId'), projectId: member(request, options, 'projectId'),
          workspaceId: member(request, options, 'workspaceId'), principalId: member(request, options, 'principalId'),
        };
        if (!options.jobs || !options.receipts || Object.values(scope).some(value => value === undefined)) return unknown('container-unreadable');
        const [, jobId, itemId] = parts;
        const base = { source: 'd16-job-item', jobId, itemId };
        const job = await read(() => options.jobs!.read(scope as JobScope, jobId));
        if ('failure' in job) return job.failure;
        if (!job.value) return absent({ ...base, found: false });
        // A deleted (D10-tombstoned) job cannot speak for its items.
        if (job.value.deleted) return unknown('container-unreadable', { ...base, deleted: true });
        const item = job.value.job.items.find(candidate => candidate.id === itemId);
        if (!item) return absent({ ...base, found: false });
        const attempt = item.attempts.at(-1);
        if (!attempt) return absent({ ...base, itemState: item.state, attempts: 0 });
        const receipt = await read(() => options.receipts!.read(attempt.id, scope.projectId!));
        if ('failure' in receipt) return receipt.failure;
        const attemptBase = { ...base, itemState: item.state, attemptId: attempt.id, attemptOutcome: attempt.outcome };
        if (!receipt.value) return absent({ ...attemptBase, found: false });
        return settle(receipt.value.state, receipt.value, attempt.receiptDigest ?? expected, attemptBase);
      }

      return unknown('malformed-response');
    },
  };
}

/**
 * `decision.review.continuation` placeholder. It always returns `unknown` /
 * `verifier-missing` and can never report `absent`, so D13 continues to fail
 * closed until #2721 supplies the review-store verifier.
 */
export function reviewContinuationPlaceholderVerifier(): EffectVerifier {
  return {
    kind: 'decision.review.continuation',
    version: REVIEW_CONTINUATION_PLACEHOLDER_VERSION,
    canReportAbsent: false,
    async verify() { return unknown('verifier-missing'); },
  };
}
