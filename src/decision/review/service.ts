import type {
  CreateReviewInput, DecisionReview, ReviewActor, ReviewAuthorization, ReviewEffectReceipt,
  ReviewEventType, ReviewScope, ReviewStore,
} from './types.js';
import { currentProposal, ReviewAccessError, ReviewConflictError, reviewDigest } from './validate.js';

export class DecisionReviewService {
  constructor(private readonly store: ReviewStore, private readonly authorization: ReviewAuthorization, private readonly now = () => Date.now()) {}

  async create(scope: ReviewScope, input: CreateReviewInput): Promise<DecisionReview> {
    await this.allowed(scope, 'create');
    const at = this.now();
    if (input.expiresAtEpochMs <= at) throw new ReviewConflictError('Review expiry must be in the future');
    const proposal = { version: 1, action: structuredClone(input.action), actionDigest: reviewDigest(input.action), createdAtEpochMs: at, editor: scope.actor, rationale: input.rationale } as const;
    const review: DecisionReview = {
      apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionReview', schema: 'decision-review/v1', revision: 1,
      reviewId: input.reviewId, tenantId: scope.tenantId, projectId: scope.projectId, requesterId: scope.actor.id,
      sourceReceipt: input.sourceReceipt, evidencePins: input.evidencePins, policyPins: input.policyPins,
      reasonCodes: input.reasonCodes, riskTier: input.riskTier, presentation: input.presentation,
      proposals: [proposal], decisions: [], status: 'pending', createdAtEpochMs: at, updatedAtEpochMs: at,
      expiresAtEpochMs: input.expiresAtEpochMs, ...(input.escalationAtEpochMs === undefined ? {} : { escalationAtEpochMs: input.escalationAtEpochMs }),
      quorum: input.quorum ?? 1, continuation: { id: input.continuationId, tokenDigest: reviewDigest(input.resumeToken) },
      events: [{ sequence: 1, type: 'created', atEpochMs: at, actor: scope.actor, proposalVersion: 1, rationale: input.rationale }],
    };
    if (!await this.store.create(review)) throw new ReviewConflictError('Review ID already exists');
    return review;
  }

  async read(scope: ReviewScope, reviewId: string): Promise<DecisionReview | null> {
    await this.allowed(scope, 'read');
    return this.store.read(reviewId, scope.tenantId, scope.projectId);
  }

  claim(scope: ReviewScope, id: string, rationale: string) { return this.mutate(scope, id, 'claim', review => {
    this.requireStatus(review, ['pending', 'claimed']);
    return this.append(review, 'claimed', scope.actor, rationale, 'claimed');
  }); }

  async decide(scope: ReviewScope, id: string, decision: 'approve' | 'reject', rationale: string): Promise<DecisionReview> {
    return this.mutate(scope, id, 'decide', async review => {
      this.requireActive(review); const proposal = currentProposal(review);
      if (!await this.authorization.eligible(scope, review, proposal)) throw new ReviewAccessError('Reviewer is not eligible');
      if (review.requesterId === scope.actor.id) throw new ReviewAccessError('Self-approval is denied');
      if (review.decisions.some(item => item.reviewer.id === scope.actor.id && item.proposalVersion === proposal.version)) throw new ReviewConflictError('Reviewer already decided this proposal');
      const decisions = [...review.decisions, { reviewer: scope.actor, proposalVersion: proposal.version, decision, rationale, atEpochMs: this.now() }];
      const approvals = decisions.filter(item => item.proposalVersion === proposal.version && item.decision === 'approve').length;
      const status = decision === 'reject' ? 'rejected' : approvals >= review.quorum ? 'approved' : 'claimed';
      return this.append({ ...review, decisions }, decision === 'approve' ? 'approved' : 'rejected', scope.actor, rationale, status, { quorumSatisfied: approvals >= review.quorum });
    });
  }

  edit(scope: ReviewScope, id: string, action: unknown, rationale: string) { return this.mutate(scope, id, 'edit', review => {
    this.requireActive(review); const at = this.now(); const version = currentProposal(review).version + 1;
    const proposals = [...review.proposals, { version, action: structuredClone(action), actionDigest: reviewDigest(action), createdAtEpochMs: at, editor: scope.actor, rationale }];
    return this.append({ ...review, proposals, decisions: review.decisions }, 'edited', scope.actor, rationale, 'pending');
  }); }

  escalate(scope: ReviewScope, id: string, rationale: string) { return this.mutate(scope, id, 'escalate', review => {
    this.requireStatus(review, ['pending', 'claimed']);
    if (review.escalationAtEpochMs !== undefined && this.now() < review.escalationAtEpochMs) throw new ReviewConflictError('Escalation deadline has not arrived');
    return this.append(review, 'escalated', scope.actor, rationale, 'escalated');
  }); }
  cancel(scope: ReviewScope, id: string, rationale: string) { return this.mutate(scope, id, 'cancel', review => {
    this.requireStatus(review, ['pending', 'claimed', 'approved', 'escalated']);
    return this.append(review, 'canceled', scope.actor, rationale, 'canceled');
  }); }

  async expireDue(scope: ReviewScope, id: string): Promise<DecisionReview> {
    return this.mutate(scope, id, 'decide', review => {
      this.requireStatus(review, ['pending', 'claimed', 'approved', 'escalated']);
      if (this.now() < review.expiresAtEpochMs) throw new ReviewConflictError('Review has not expired');
      return this.append(review, 'expired', scope.actor, 'expiry deadline reached', 'expired');
    });
  }

  async resume(scope: ReviewScope, id: string, token: string, execute: (effectId: string, action: unknown) => Promise<unknown>): Promise<ReviewEffectReceipt> {
    for (;;) {
      const review = await this.requireReview(scope, id);
      await this.allowed(scope, 'resume', review);
      if (review.effectReceipt) return review.effectReceipt;
      if (review.status === 'resuming') { await new Promise(resolve => setTimeout(resolve, 10)); continue; }
      if (review.status !== 'approved') throw new ReviewConflictError(`Review cannot resume from ${review.status}`);
      if (review.continuation.tokenDigest !== reviewDigest(token)) throw new ReviewAccessError('Invalid resume token');
      if (this.now() >= review.expiresAtEpochMs) throw new ReviewConflictError('Review expired before resume');
      const proposal = currentProposal(review);
      const approvals = review.decisions.filter(item => item.proposalVersion === proposal.version && item.decision === 'approve');
      if (approvals.length < review.quorum) throw new ReviewConflictError('Approval quorum is no longer satisfied');
      if (!await this.authorization.eligible(scope, review, proposal) || !await this.authorization.authorizeAction(scope, review, proposal)) {
        throw new ReviewAccessError('Authorization is no longer valid');
      }
      const effectId = reviewDigest({ reviewId: id, continuationId: review.continuation.id, proposalVersion: proposal.version });
      const resuming = this.append(review, 'resumed', scope.actor, 'continuation acquired', 'resuming', { effectId });
      if (!await this.store.compareAndSwap(id, scope.tenantId, scope.projectId, review.revision, resuming)) continue;
      try {
        const result = await execute(effectId, structuredClone(proposal.action));
        const completedAtEpochMs = this.now();
        const receipt: ReviewEffectReceipt = { effectId, continuationId: review.continuation.id, proposalVersion: proposal.version, completedAtEpochMs, result };
        await this.finish(scope, id, resuming.revision, receipt);
        return receipt;
      } catch (error) {
        const failed = this.append(resuming, 'execution-failed', scope.actor, 'executor failed', 'execution-failed');
        failed.executionError = error instanceof Error ? error.message : String(error);
        await this.store.compareAndSwap(id, scope.tenantId, scope.projectId, resuming.revision, failed);
        throw error;
      }
    }
  }

  private async finish(scope: ReviewScope, id: string, revision: number, receipt: ReviewEffectReceipt) {
    const review = await this.requireReview(scope, id);
    if (review.revision !== revision || review.status !== 'resuming') throw new ReviewConflictError('Resume ownership was lost');
    const completed = this.append({ ...review, effectReceipt: receipt }, 'execution-completed', scope.actor, 'executor completed', 'completed', { effectId: receipt.effectId });
    if (!await this.store.compareAndSwap(id, scope.tenantId, scope.projectId, revision, completed)) throw new ReviewConflictError('Could not persist effect receipt');
  }

  private async mutate(scope: ReviewScope, id: string, operation: Parameters<ReviewAuthorization['authorize']>[1], build: (review: DecisionReview) => DecisionReview | Promise<DecisionReview>): Promise<DecisionReview> {
    for (;;) { const review = await this.requireReview(scope, id); await this.allowed(scope, operation, review); const next = await build(review);
      if (await this.store.compareAndSwap(id, scope.tenantId, scope.projectId, review.revision, next)) return next; }
  }
  private async requireReview(scope: ReviewScope, id: string) { const review = await this.store.read(id, scope.tenantId, scope.projectId); if (!review) throw new ReviewAccessError('Review not found'); return review; }
  private async allowed(scope: ReviewScope, operation: Parameters<ReviewAuthorization['authorize']>[1], review?: DecisionReview) { if (!await this.authorization.authorize(scope, operation, review)) throw new ReviewAccessError('Review access denied'); }
  private requireActive(review: DecisionReview) { this.requireStatus(review, ['pending', 'claimed']); if (this.now() >= review.expiresAtEpochMs) throw new ReviewConflictError('Review is expired'); }
  private requireStatus(review: DecisionReview, states: DecisionReview['status'][]) { if (!states.includes(review.status)) throw new ReviewConflictError(`Illegal transition from ${review.status}`); }
  private append(review: DecisionReview, type: ReviewEventType, actor: ReviewActor, rationale: string, status: DecisionReview['status'], data?: Record<string, unknown>): DecisionReview {
    const at = Math.max(this.now(), review.updatedAtEpochMs); const proposalVersion = currentProposal(review).version;
    return { ...structuredClone(review), revision: review.revision + 1, status, updatedAtEpochMs: at,
      events: [...review.events, { sequence: review.events.length + 1, type, atEpochMs: at, actor, proposalVersion, rationale, ...(data ? { data } : {}) }] };
  }
}
