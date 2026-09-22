import { DecisionReviewService, FileDecisionReviewStore } from '../review/index.js';

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
