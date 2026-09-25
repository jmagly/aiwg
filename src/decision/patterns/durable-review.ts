import {
  DecisionReviewService, FileDecisionReviewStore, PinnedReviewAuthorization, ReviewAccessError, ReviewConflictError,
  type LiveReviewAuthority, type PinnedReviewPolicy, type ReviewScope,
} from '../review/index.js';
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

export interface ReviewAuthorizationFixtureResult {
  schema: 'decision-review-offline-authorization/v1';
  executionMode: 'offline-local';
  networkAllowed: false;
  credentialRequired: false;
  authorization: 'pinned-review-authorization';
  restarted: true;
  /** Every attempt that must not reach the executor, by fixture case ID. */
  deniedAttempts: string[];
  unauthorizedEffects: 0;
  authorizedEffects: 1;
  authorizationDeniedEvents: number;
  duplicateResumeReturnedReceipt: true;
}

/**
 * Installed-package G6 fixture with a non-permissive `PinnedReviewAuthorization`.
 * Unauthenticated, self-approving, wrong-role, foreign-project, stale-token,
 * revoked-action, replaced-policy and revoked-reviewer attempts run against the
 * real file store. The executor counts calls per phase, so any unauthorized
 * attempt that reaches it fails the fixture. One authorized resume after a
 * restart then produces exactly one effect, and a duplicate returns its receipt.
 */
export async function runOfflineReviewAuthorizationFixture(directory: string): Promise<ReviewAuthorizationFixtureResult> {
  if (!directory) throw new Error('A durable review fixture directory is required');
  const key = new TextEncoder().encode('aiwg-offline-review-authorization-fixture-key-v1');
  const store = () => new FileDecisionReviewStore(join(directory, 'authorization'), key);
  const policy: PinnedReviewPolicy = {
    id: 'fixture-review-policy', version: '1', tenantId: 'fixture-tenant', projectId: 'fixture-project',
    requesterRoles: ['requester'], reviewerRoles: ['reviewer'], executorRoles: ['executor'],
    auditorRoles: ['auditor'], operatorRoles: ['operator'], minimumQuorumByRisk: { low: 1 },
    retentionWindowMsByRisk: { low: 60_000 },
    separateRequesterReviewer: true, separateEditorReviewer: true, separateReviewerExecutor: true,
  };
  // Live identity authority fake: roles come from here, never from the caller's scope.
  const directoryRoles = new Map<string, string[]>([
    ['requester', ['requester']], ['reviewer', ['reviewer']], ['executor', ['executor']],
    ['dual-role', ['requester', 'reviewer']],
  ]);
  const revoked = new Set<string>();
  let authenticated = new Set(['requester', 'reviewer', 'executor', 'dual-role']);
  let policyReplaced = false;
  let actionPermitted = true;
  let authorizationDigest: `sha256:${string}` | null = null;
  const authority: LiveReviewAuthority = {
    authenticate: async scope => authenticated.has(scope.actor.id),
    resolve: async (_tenant, _project, id) => directoryRoles.has(id)
      ? { roles: revoked.has(id) ? [] : directoryRoles.get(id)!, active: true, compromised: false, conflictsWith: [], authorityContext: 'fixture/v1' }
      : null,
    currentPolicyDigest: async () => policyReplaced ? `sha256:${'0'.repeat(64)}` : authorizationDigest,
  };
  const authorization = new PinnedReviewAuthorization(policy, authority, async () => actionPermitted);
  authorizationDigest = authorization.policyDigest;
  let now = 1_000;
  const service = () => new DecisionReviewService(store(), authorization, () => now);
  // The caller claims every role; only the live authority's answer counts.
  const scope = (id: string, projectId = policy.projectId): ReviewScope => ({ tenantId: policy.tenantId, projectId,
    actor: { id, roles: ['requester', 'reviewer', 'executor', 'operator'], authorityContext: 'fixture/v1' } });
  const digest = `sha256:${'1'.repeat(64)}` as const;
  const reviewId = 'authorization-fixture';
  const token = 'fixture-authorization-resume-token';
  await service().create(scope('dual-role'), {
    reviewId, sourceReceipt: { id: 'source-authorization', digest }, evidencePins: [{ id: 'evidence', version: '1', digest }],
    policyPins: [{ id: policy.id, version: policy.version, digest: authorization.policyDigest }],
    reasonCodes: ['high-risk-action'], riskTier: 'low', presentation: { summary: 'Projected synthetic evidence' },
    action: { kind: 'fixture', value: 'guarded' }, rationale: 'Requires review', expiresAtEpochMs: 30_000,
    retentionUntilEpochMs: now + policy.retentionWindowMsByRisk.low!, continuationId: 'continue-authorization', resumeToken: token,
  });

  let unauthorizedEffects = 0;
  let authorizedEffects = 0;
  let authorizedPhase = false;
  const execute = async (effectId: string) => {
    if (authorizedPhase) authorizedEffects += 1; else unauthorizedEffects += 1;
    return { delivered: true, effectId };
  };
  const denied: string[] = [];
  const expectDenied = async (caseId: string, attempt: () => Promise<unknown>) => {
    try { await attempt(); }
    catch (error) {
      if (!(error instanceof ReviewAccessError) && !(error instanceof ReviewConflictError)) throw error;
      denied.push(caseId);
      return;
    }
    throw new Error(`Review authorization fixture allowed ${caseId}`);
  };

  // Before approval: nobody may resume, and the requester (dual-role) may not approve its own request.
  await expectDenied('resume-before-approval', () => service().resume(scope('executor'), reviewId, token, execute));
  await expectDenied('self-approval', () => service().decide(scope('dual-role'), reviewId, 'approve', 'self'));
  authenticated = new Set(['requester', 'executor', 'dual-role']);
  await expectDenied('unauthenticated-reviewer', () => service().decide(scope('reviewer'), reviewId, 'approve', 'forged'));
  authenticated = new Set(['requester', 'reviewer', 'executor', 'dual-role']);
  await expectDenied('requester-claim', () => service().claim(scope('requester'), reviewId, 'wrong role'));
  await service().decide(scope('reviewer'), reviewId, 'approve', 'approved by independent reviewer');

  // After approval: wrong role, foreign scope, unknown principal and stale token cannot resume.
  await expectDenied('reviewer-as-executor', () => service().resume(scope('reviewer'), reviewId, token, execute));
  await expectDenied('foreign-project-executor', () => service().resume(scope('executor', 'other-project'), reviewId, token, execute));
  await expectDenied('unknown-principal', () => service().resume(scope('stranger'), reviewId, token, execute));
  await expectDenied('stale-resume-token', () => service().resume(scope('executor'), reviewId, 'stale-token', execute));

  // Authority changes after approval block execution. Revoked action or reviewer authority is
  // recorded as authorization-denied without erasing the approval; a replaced policy pin makes
  // the review unavailable to every caller.
  actionPermitted = false;
  await expectDenied('action-authorization-revoked', () => service().resume(scope('executor'), reviewId, token, execute));
  actionPermitted = true;
  policyReplaced = true;
  await expectDenied('policy-replaced', () => service().resume(scope('executor'), reviewId, token, execute));
  policyReplaced = false;
  revoked.add('reviewer');
  await expectDenied('reviewer-role-revoked', () => service().resume(scope('executor'), reviewId, token, execute));
  revoked.delete('reviewer');

  // Restart with a fresh store and service, then resume under current authority.
  now += 1;
  authorizedPhase = true;
  const receipt = await service().resume(scope('executor'), reviewId, token, execute);
  const duplicate = await service().resume(scope('executor'), reviewId, token, execute);
  const persisted = await store().read(reviewId, policy.tenantId, policy.projectId);
  const deniedEvents = persisted?.events.filter(event => event.type === 'authorization-denied').length ?? 0;
  if (unauthorizedEffects !== 0 || authorizedEffects !== 1 || JSON.stringify(receipt) !== JSON.stringify(duplicate) ||
      persisted?.status !== 'completed' || denied.length !== 11 || deniedEvents !== 2) {
    throw new Error('Review authorization fixture recorded an unauthorized or duplicate effect');
  }
  return {
    schema: 'decision-review-offline-authorization/v1', executionMode: 'offline-local', networkAllowed: false,
    credentialRequired: false, authorization: 'pinned-review-authorization', restarted: true, deniedAttempts: denied,
    unauthorizedEffects: 0, authorizedEffects: 1, authorizationDeniedEvents: deniedEvents, duplicateResumeReturnedReceipt: true,
  };
}
