import { DecisionReviewService, FileDecisionReviewStore, ReviewConflictError, type ReviewScope } from '../review/index.js';
import { join } from 'node:path';

export interface DurableReviewFixtureResult {
  schema: 'decision-pattern-durable-review-fixture/v1';
  executionMode: 'offline-local';
  networkAllowed: false;
  credentialRequired: false;
  store: 'file-decision-review-store';
  restarted: true;
  reviewId: string;
  effectId: string;
  persistedRevision: number;
  executorCalls: 1;
  duplicateResumeReturnedReceipt: true;
}

/**
 * Exercise the real durable review service and file store without credentials or
 * network access. The caller owns `directory` and may inspect or remove it.
 */
export async function runOfflineDurableReviewFixture(directory: string): Promise<DurableReviewFixtureResult> {
  if (!directory) throw new Error('A durable review fixture directory is required');
  const integrityKey = new TextEncoder().encode('aiwg-offline-durable-review-fixture-key-v1');
  const authorization = {
    authorize: () => true,
    eligible: ({ actor }: { actor: { roles: string[] } }) => actor.roles.includes('reviewer'),
    eligibleApproval: (_scope: unknown, _review: unknown, _proposal: unknown, decision: { reviewer: { roles: string[] } }) => decision.reviewer.roles.includes('reviewer'),
    authorizeAction: () => true,
  };
  const actor = { id: 'fixture-reviewer', roles: ['reviewer'], authorityContext: 'offline-fixture/v1' };
  const requester = { id: 'fixture-requester', roles: ['requester'], authorityContext: 'offline-fixture/v1' };
  const requesterScope = { tenantId: 'fixture-tenant', projectId: 'fixture-project', actor: requester };
  const reviewerScope = { tenantId: 'fixture-tenant', projectId: 'fixture-project', actor };
  const digest = `sha256:${'1'.repeat(64)}` as `sha256:${string}`;
  let now = 1_000;
  const store = () => new FileDecisionReviewStore(directory, integrityKey);
  const first = new DecisionReviewService(store(), authorization, () => now);
  await first.create(requesterScope, {
    reviewId: 'durable-review-fixture',
    sourceReceipt: { id: 'offline-receipt', digest },
    evidencePins: [{ id: 'recorded-evidence', version: '1.0.0', digest }],
    policyPins: [{ id: 'offline-policy', version: '1.0.0', digest }],
    presentation: { summary: 'Synthetic offline durable review fixture' },
    action: { kind: 'local-fixture', value: 'approved' },
    rationale: 'Exercise durable review without external side effects',
    riskTier: 'fixture', reasonCodes: ['durable-review-required'],
    expiresAtEpochMs: 60_000, continuationId: 'fixture-continuation',
    resumeToken: 'fixture-resume-token',
  });
  await first.decide(reviewerScope, 'durable-review-fixture', 'approve', 'fixture approval');

  // Construct a new store and service to prove the continuation survives restart.
  now += 1;
  const restarted = new DecisionReviewService(store(), authorization, () => now);
  let executorCalls = 0;
  const execute = async (effectId: string) => {
    executorCalls += 1;
    return { local: true, effectId };
  };
  const receipt = await restarted.resume(reviewerScope, 'durable-review-fixture', 'fixture-resume-token', execute);

  // Construct another service and replay resume. It must return the stored effect
  // receipt without calling the executor a second time.
  const replayed = await new DecisionReviewService(store(), authorization, () => now)
    .resume(reviewerScope, 'durable-review-fixture', 'fixture-resume-token', execute);
  if (executorCalls !== 1 || JSON.stringify(receipt) !== JSON.stringify(replayed)) {
    throw new Error('Durable review fixture violated idempotent resume');
  }
  const persisted = await store().read('durable-review-fixture', 'fixture-tenant', 'fixture-project');
  if (!persisted?.effectReceipt) throw new Error('Durable review fixture receipt was not persisted');
  return {
    schema: 'decision-pattern-durable-review-fixture/v1', executionMode: 'offline-local',
    networkAllowed: false, credentialRequired: false, store: 'file-decision-review-store',
    restarted: true, reviewId: persisted.reviewId, effectId: receipt.effectId,
    persistedRevision: persisted.revision, executorCalls: 1,
    duplicateResumeReturnedReceipt: true,
  };
}

/** Installed-package offline matrix: no network, credentials, or external executor. */
export async function runOfflineReviewMatrixFixture(directory: string) {
  if (!directory) throw new Error('A durable review fixture directory is required');
  const key = new TextEncoder().encode('aiwg-offline-review-matrix-fixture-key-v1');
  const store = () => new FileDecisionReviewStore(join(directory, 'matrix'), key);
  const requester: ReviewScope = { tenantId: 'fixture-tenant', projectId: 'fixture-project',
    actor: { id: 'requester', roles: ['requester'], authorityContext: 'fixture/v1' } };
  const reviewer: ReviewScope = { ...requester, actor: { id: 'reviewer', roles: ['reviewer'], authorityContext: 'fixture/v1' } };
  const auth = { authorize: () => true, eligible: () => true, eligibleApproval: () => true, authorizeAction: () => true };
  let now = 1_000;
  const service = () => new DecisionReviewService(store(), auth, () => now);
  const digest = `sha256:${'1'.repeat(64)}` as const;
  const create = (id: string, reasonCode: string, expiry = 9_000) => service().create(requester, {
    reviewId: id, sourceReceipt: { id: `source-${id}`, digest }, evidencePins: [{ id: 'evidence', version: '1', digest }],
    policyPins: [{ id: 'policy', version: '1', digest }], reasonCodes: [reasonCode], riskTier: 'fixture',
    presentation: { summary: 'Projected synthetic evidence' }, action: { kind: 'fixture', value: 'original' },
    rationale: 'Requires review', expiresAtEpochMs: expiry, continuationId: `continue-${id}`, resumeToken: `resume-${id}`,
    escalationAtEpochMs: 1_500,
  });
  await create('low-confidence', 'low-confidence');
  await create('policy-conflict', 'policy-conflict');
  const claimed = await service().claim(reviewer, 'low-confidence', 'claim');
  const rejected = await service().decide(reviewer, 'policy-conflict', 'reject', 'conflict');
  await create('edited', 'manual-edit');
  const edited = await service().edit(reviewer, 'edited', { kind: 'fixture', value: 'amended' }, 'amend', 'resume-edited-v2');
  await service().decide(reviewer, 'edited', 'approve', 'approve amendment');
  let effects = 0;
  const execute = async () => { effects += 1; return { delivered: true }; };
  const completed = await service().resume(reviewer, 'edited', 'resume-edited-v2', execute);
  const duplicate = await service().resume(reviewer, 'edited', 'resume-edited-v2', execute);
  await create('expiry', 'deadline', 1_600);
  await create('escalation', 'deadline');
  now = 1_600;
  const expired = await service().expireDue(reviewer, 'expiry');
  const escalated = await service().escalate(reviewer, 'escalation', 'deadline');
  let lateDenied = false;
  try { await service().decide(reviewer, 'expiry', 'approve', 'too late'); }
  catch (error) { if (!(error instanceof ReviewConflictError)) throw error; lateDenied = true; }
  if (!lateDenied || effects !== 1 || completed.effectId !== duplicate.effectId) throw new Error('Offline review matrix failed');
  return { schema: 'decision-review-offline-matrix/v1' as const, executionMode: 'offline-local' as const,
    networkAllowed: false as const, credentialRequired: false as const, restarted: true as const,
    claimed: claimed.status, rejected: rejected.status, editedVersion: edited.proposals.at(-1)!.version,
    expired: expired.status, escalated: escalated.status, lateDenied, executorCalls: effects,
    duplicateResumeReturnedReceipt: true as const };
}
