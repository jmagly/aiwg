import type {
  CreateReviewInput, DecisionReview, ReviewActor, ReviewAuthorization, ReviewEffectReceipt,
  DecisionReviewServiceOptions, ReviewEventType, ReviewListOptions, ReviewScope, ReviewStore,
} from './types.js';
import { currentProposal, ReviewAccessError, ReviewConflictError, reviewDigest } from './validate.js';
import { DecisionTraceBuilder } from '../telemetry/trace.js';
import { sanitizeOpaqueValue } from '../telemetry/redaction.js';

export class DecisionReviewService {
  private readonly resumingLeaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly telemetry: DecisionReviewServiceOptions['telemetry'];
  constructor(private readonly store: ReviewStore, private readonly authorization: ReviewAuthorization, private readonly now = () => Date.now(), options: DecisionReviewServiceOptions = {}) {
    this.resumingLeaseMs = options.resumingLeaseMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 10;
    this.telemetry = options.telemetry;
    if (!Number.isSafeInteger(this.resumingLeaseMs) || this.resumingLeaseMs < 1) throw new Error('resumingLeaseMs must be a positive integer');
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) throw new Error('pollIntervalMs must be a positive integer');
  }

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
    await this.emitTelemetry(review);
    return review;
  }

  async read(scope: ReviewScope, reviewId: string): Promise<DecisionReview | null> {
    const review = await this.store.read(reviewId, scope.tenantId, scope.projectId);
    if (!review || !await this.authorization.authorize(scope, 'read', review)) return null;
    return review.status === 'tombstoned' ? null : review;
  }

  async list(scope: ReviewScope, options: ReviewListOptions = {}): Promise<DecisionReview[]> {
    if (!await this.authorization.authorize(scope, 'list')) return [];
    const reviews = await this.store.list(scope.tenantId, scope.projectId);
    const visible: DecisionReview[] = [];
    for (const review of reviews) {
      if ((!options.includeTombstoned && review.status === 'tombstoned') || !await this.authorization.authorize(scope, 'read', review)) continue;
      visible.push(review);
    }
    return visible;
  }

  async export(scope: ReviewScope, id: string): Promise<DecisionReview | null> {
    const review = await this.store.read(id, scope.tenantId, scope.projectId);
    if (!review || !await this.authorization.authorize(scope, 'export', review)) return null;
    return structuredClone(review);
  }

  setLegalHold(scope: ReviewScope, id: string, legalHold: boolean, rationale: string) { return this.mutate(scope, id, 'legal-hold', review => {
    if (review.status === 'tombstoned') throw new ReviewConflictError('Tombstoned review cannot change legal hold');
    if ((review.lifecycle?.legalHold ?? false) === legalHold) return review;
    return this.append({ ...review, lifecycle: { ...review.lifecycle, legalHold } }, legalHold ? 'legal-hold-placed' : 'legal-hold-released', scope.actor, rationale, review.status);
  }, true); }

  delete(scope: ReviewScope, id: string, rationale: string) { return this.applyTombstone(scope, id, rationale, 'delete'); }
  tombstone(scope: ReviewScope, id: string, rationale: string) { return this.applyTombstone(scope, id, rationale, 'tombstone'); }

  private applyTombstone(scope: ReviewScope, id: string, rationale: string, operation: 'delete' | 'tombstone') { return this.mutate(scope, id, operation, review => {
    if (review.lifecycle?.legalHold) throw new ReviewConflictError('Review deletion prohibited by legal hold');
    if (review.status === 'tombstoned') return review;
    const at = this.now();
    return this.append({ ...review, lifecycle: { legalHold: false, tombstonedAtEpochMs: at, tombstoneReason: rationale } }, 'tombstoned', scope.actor, rationale, 'tombstoned');
  }, true); }

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
      if (review.continuation.tokenDigest !== reviewDigest(token)) throw new ReviewAccessError('Invalid resume token');
      if (review.effectReceipt) return review.effectReceipt;
      const proposal = currentProposal(review);
      const approvals = review.decisions.filter(item => item.proposalVersion === proposal.version && item.decision === 'approve');
      if (approvals.length < review.quorum) throw new ReviewConflictError('Approval quorum is no longer satisfied');
      if (!await this.authorization.eligible(scope, review, proposal) || !await this.authorization.authorizeAction(scope, review, proposal)) {
        throw new ReviewAccessError('Authorization is no longer valid');
      }
      if (review.status === 'resuming') {
        const acquiredAt = review.events.at(-1)?.atEpochMs ?? review.updatedAtEpochMs;
        if (this.now() - acquiredAt < this.resumingLeaseMs) { await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs)); continue; }
        const effectId = reviewDigest({ reviewId: id, continuationId: review.continuation.id, proposalVersion: proposal.version });
        const recovered = this.append(review, 'resumed', scope.actor, 'stale continuation lease recovered', 'resuming', { effectId, recovered: true });
        if (!await this.store.compareAndSwap(id, scope.tenantId, scope.projectId, review.revision, recovered)) continue;
        await this.emitTelemetry(recovered);
        return this.executeAndFinish(scope, id, recovered, proposal.action, effectId, execute);
      }
      if (review.status !== 'approved') throw new ReviewConflictError(`Review cannot resume from ${review.status}`);
      if (this.now() >= review.expiresAtEpochMs) throw new ReviewConflictError('Review expired before resume');
      const effectId = reviewDigest({ reviewId: id, continuationId: review.continuation.id, proposalVersion: proposal.version });
      const resuming = this.append(review, 'resumed', scope.actor, 'continuation acquired', 'resuming', { effectId });
      if (!await this.store.compareAndSwap(id, scope.tenantId, scope.projectId, review.revision, resuming)) continue;
      await this.emitTelemetry(resuming);
      return this.executeAndFinish(scope, id, resuming, proposal.action, effectId, execute);
    }
  }

  private async executeAndFinish(scope: ReviewScope, id: string, resuming: DecisionReview, action: unknown, effectId: string, execute: (effectId: string, action: unknown) => Promise<unknown>): Promise<ReviewEffectReceipt> {
    try {
      const result = await execute(effectId, structuredClone(action));
      const receipt: ReviewEffectReceipt = { effectId, continuationId: resuming.continuation.id, proposalVersion: currentProposal(resuming).version, completedAtEpochMs: this.now(), result };
      await this.finish(scope, id, resuming.revision, receipt);
      const completed = await this.store.read(id, scope.tenantId, scope.projectId);
      if (completed) await this.emitTelemetry(completed, receipt.effectId);
      return receipt;
    } catch (error) {
      const failed = this.append(resuming, 'execution-failed', scope.actor, 'executor failed', 'execution-failed');
      failed.executionError = error instanceof Error ? error.message : String(error);
      await this.store.compareAndSwap(id, scope.tenantId, scope.projectId, resuming.revision, failed);
      throw error;
    }
  }

  private async finish(scope: ReviewScope, id: string, revision: number, receipt: ReviewEffectReceipt) {
    const review = await this.requireReview(scope, id);
    if (review.revision !== revision || review.status !== 'resuming') throw new ReviewConflictError('Resume ownership was lost');
    const completed = this.append({ ...review, effectReceipt: receipt }, 'execution-completed', scope.actor, 'executor completed', 'completed', { effectId: receipt.effectId });
    if (!await this.store.compareAndSwap(id, scope.tenantId, scope.projectId, revision, completed)) throw new ReviewConflictError('Could not persist effect receipt');
  }

  private async mutate(scope: ReviewScope, id: string, operation: Parameters<ReviewAuthorization['authorize']>[1], build: (review: DecisionReview) => DecisionReview | Promise<DecisionReview>, allowNoop = false): Promise<DecisionReview> {
    for (;;) { const review = await this.requireReview(scope, id); await this.allowed(scope, operation, review); const next = await build(review);
      if (allowNoop && next === review) return review;
      if (await this.store.compareAndSwap(id, scope.tenantId, scope.projectId, review.revision, next)) {
        await this.emitTelemetry(next);
        return next;
      } }
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

  private async emitTelemetry(review: DecisionReview, effectId?: string): Promise<void> {
    if (!this.telemetry) return;
    try {
      const builder = new DecisionTraceBuilder(this.telemetry.ids, this.now);
      const root = builder.startSpan('decision.review', {
        ...(this.telemetry.parent ? { parent: this.telemetry.parent } : {}),
        attributes: {
          'aiwg.review.id': sanitizeOpaqueValue(review.reviewId, 128),
          'aiwg.review.status': review.status,
          'aiwg.review.revision': review.revision,
          'aiwg.review.event': review.events.at(-1)?.type ?? 'unknown',
        },
        provenance: {
          'aiwg.review.id': 'client-derived', 'aiwg.review.status': 'client-derived',
          'aiwg.review.revision': 'client-derived', 'aiwg.review.event': 'client-derived',
        },
      });
      builder.endSpan(root, review.status === 'execution-failed' ? 'error' : 'ok');
      if (effectId) {
        const action = builder.startSpan('decision.action', { parent: root.context,
          links: [{ ...root.context, relationship: 'review', attributes: { 'aiwg.review.id': sanitizeOpaqueValue(review.reviewId, 128) } }],
          attributes: { 'aiwg.effect_receipt.id': sanitizeOpaqueValue(effectId, 128), 'aiwg.review.id': sanitizeOpaqueValue(review.reviewId, 128) },
          provenance: { 'aiwg.effect_receipt.id': 'client-derived', 'aiwg.review.id': 'client-derived' } });
        builder.endSpan(action, review.status === 'completed' ? 'ok' : 'error');
      }
      for (const span of builder.build().spans) {
        try { await this.telemetry.hook.emit(span); } catch { /* isolate exporter failure */ }
      }
    } catch {
      // Observability must never alter durable review state or action delivery.
    }
  }
}
