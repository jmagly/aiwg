import { join } from 'node:path';
import {
  DecisionReviewService, FileDecisionReviewStore, FileVerifiedReviewEffectLedger, reviewDigest,
  type ReviewAuthorization, type ReviewScope,
} from '../../../../src/decision/review/index.js';

// Shared by the cross-process review tests and their child processes (#2606 AC5/AC6).
export const REVIEW_ID = 'process-review';
export const TOKEN = 'process-resume-token';
export const CONTINUATION = 'process-continuation';
export const tenant = { tenantId: 'tenant-p', projectId: 'project-p' };
const storeKey = new Uint8Array(32).fill(3);
const ledgerKey = new Uint8Array(32).fill(4);
const digest = `sha256:${'b'.repeat(64)}` as const;

/** Role-checked offline authorization; the tests exercise concurrency and crashes, not policy. */
export const authorization: ReviewAuthorization = {
  authorize: (scope, operation) => operation === 'create' ? scope.actor.roles.includes('requester') : !scope.actor.roles.includes('requester'),
  eligible: scope => scope.actor.roles.includes('reviewer') || scope.actor.roles.includes('executor'),
  eligibleApproval: (_scope, _review, _proposal, decision) => decision.reviewer.roles.includes('reviewer'),
  authorizeAction: () => true,
};
export const actor = (id: string, role: 'requester' | 'reviewer' | 'executor'): ReviewScope =>
  ({ ...tenant, actor: { id, roles: [role], authorityContext: 'process-fixture/v1' } });
export const requester = actor('requester', 'requester');
export const executor = actor('executor', 'executor');

export function paths(directory: string) {
  return { store: join(directory, 'reviews'), ledger: join(directory, 'ledger'), effects: join(directory, 'effects.log') };
}
export function openStore(directory: string, fault?: ConstructorParameters<typeof FileDecisionReviewStore>[2]['fault']) {
  return new FileDecisionReviewStore(paths(directory).store, storeKey, fault ? { fault } : {});
}
export function openLedger(directory: string) { return new FileVerifiedReviewEffectLedger(paths(directory).ledger, ledgerKey); }
export function openService(directory: string, now: () => number, fault?: Parameters<typeof openStore>[1]) {
  return new DecisionReviewService(openStore(directory, fault), authorization, now, { resumingLeaseMs: 1_000, pollIntervalMs: 5 });
}
export const effectId = reviewDigest({ reviewId: REVIEW_ID, continuationId: CONTINUATION, proposalVersion: 1 });
export function createInput() {
  return {
    reviewId: REVIEW_ID, sourceReceipt: { id: 'process-receipt', digest }, evidencePins: [{ id: 'evidence', version: '1', digest }],
    policyPins: [{ id: 'policy', version: '1', digest }], reasonCodes: ['process-fixture'], riskTier: 'low',
    presentation: { summary: 'synthetic cross-process review' }, action: { kind: 'fixture', value: 'guarded' },
    rationale: 'review required', expiresAtEpochMs: 1_000_000, continuationId: CONTINUATION, resumeToken: TOKEN,
  };
}
