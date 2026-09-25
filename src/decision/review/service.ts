import type {
  CreateReviewInput, DecisionReview, ReviewActor, ReviewAuthorization, ReviewEffectReceipt,
  DecisionReviewServiceOptions, ReviewEventType, ReviewListOptions, ReviewScope, ReviewStore,
  ReviewSensitiveView, ReviewSensitiveViewRequest, ReviewSensitiveViewSource,
} from './types.js';
import { assertReviewProjection, currentProposal, ReviewAccessError, ReviewConflictError, reviewDigest, reviewOperatorEventId } from './validate.js';
import { validateDecisionLifecyclePolicy, type DecisionLifecycleReference, type DecisionLifecycleRule } from '../lifecycle.js';

/** Only an executor that can attest zero external effect may report definitive failure. */
export class ReviewDefinitiveExecutionError extends Error {}
import { DecisionTraceBuilder } from '../telemetry/trace.js';
import { sanitizeOpaqueValue } from '../telemetry/redaction.js';
import { replayReviewOperatorAudit } from './operator-audit.js';
import type { DecisionCorrelation } from '../../audit/operator-decision.js';

/** Review events that map to a #1567 operator decision record. */
const OPERATOR_DECISION_EVENTS = new Set<ReviewEventType>(['approved', 'rejected', 'escalated', 'authorization-denied']);

export class DecisionReviewService {
  private readonly resumingLeaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly telemetry: DecisionReviewServiceOptions['telemetry'];
  private readonly operatorAudit: DecisionReviewServiceOptions['operatorAudit'];
  private readonly lifecycleRule: DecisionLifecycleRule | null;
  private auditQueue: Promise<void> = Promise.resolve();
  constructor(private readonly store: ReviewStore, private readonly authorization: ReviewAuthorization, private readonly now = () => Date.now(), options: DecisionReviewServiceOptions = {}) {
    this.resumingLeaseMs = options.resumingLeaseMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 10;
    this.telemetry = options.telemetry;
    this.operatorAudit = options.operatorAudit;
    if (options.lifecycle) validateDecisionLifecyclePolicy(options.lifecycle.policy);
    this.lifecycleRule = options.lifecycle ? structuredClone(options.lifecycle.policy.surfaces.review) : null;
    if (!Number.isSafeInteger(this.resumingLeaseMs) || this.resumingLeaseMs < 1) throw new Error('resumingLeaseMs must be a positive integer');
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) throw new Error('pollIntervalMs must be a positive integer');
  }

  async create(scope: ReviewScope, input: CreateReviewInput): Promise<DecisionReview> {
    await this.allowed(scope, 'create');
    const at = this.now();
    if (input.expiresAtEpochMs <= at) throw new ReviewConflictError('Review expiry must be in the future');
    let retentionUntilEpochMs = input.retentionUntilEpochMs;
    if (this.lifecycleRule) {
      // The shared D10 review rule is the retention ceiling; absent a pin, it is the deadline.
      const ceiling = at + this.lifecycleRule.retentionMs;
      retentionUntilEpochMs ??= ceiling;
      if (retentionUntilEpochMs > ceiling || input.expiresAtEpochMs > retentionUntilEpochMs) {
        throw new ReviewConflictError('Review retention exceeds the D10 review lifecycle rule');
      }
    }
    const proposal = { version: 1, action: structuredClone(input.action), actionDigest: reviewDigest(input.action), createdAtEpochMs: at, editor: scope.actor, rationale: input.rationale } as const;
    const review: DecisionReview = {
      apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionReview', schema: 'decision-review/v1', revision: 1,
      reviewId: input.reviewId, tenantId: scope.tenantId, projectId: scope.projectId, requesterId: scope.actor.id,
      sourceReceipt: input.sourceReceipt, evidencePins: input.evidencePins, policyPins: input.policyPins,
      reasonCodes: input.reasonCodes, riskTier: input.riskTier, presentation: input.presentation,
      proposals: [proposal], decisions: [], status: 'pending', createdAtEpochMs: at, updatedAtEpochMs: at,
      expiresAtEpochMs: input.expiresAtEpochMs,
      ...(retentionUntilEpochMs === undefined ? {} : { retentionUntilEpochMs }),
      ...(input.escalationAtEpochMs === undefined ? {} : { escalationAtEpochMs: input.escalationAtEpochMs }),
      quorum: input.quorum ?? 1, continuation: { id: input.continuationId, tokenDigest: reviewDigest(input.resumeToken) },
      events: [{ sequence: 1, type: 'created', atEpochMs: at, actor: scope.actor, proposalVersion: 1,
        rationale: input.rationale, operatorDecisionEventId: reviewOperatorEventId(input.reviewId, 1) }],
    };
    await this.allowed(scope, 'create', review);
    if (!await this.store.create(review)) throw new ReviewConflictError('Review ID already exists');
    await this.auditReview(review);
    await this.emitTelemetry(review);
    return review;
  }

  async read(scope: ReviewScope, reviewId: string): Promise<DecisionReview | null> {
    const review = await this.store.read(reviewId, scope.tenantId, scope.projectId);
    if (!review || !await this.authorization.authorize(scope, 'read', review)) return null;
    return review.status === 'tombstoned' || this.pastRetention(review) ? null : review;
  }

  async list(scope: ReviewScope, options: ReviewListOptions = {}): Promise<DecisionReview[]> {
    if (!await this.authorization.authorize(scope, 'list')) return [];
    const reviews = await this.store.list(scope.tenantId, scope.projectId);
    const visible: DecisionReview[] = [];
    for (const review of reviews) {
      if ((!options.includeTombstoned && review.status === 'tombstoned') || this.pastRetention(review) ||
        !await this.authorization.authorize(scope, 'read', review)) continue;
      visible.push(review);
    }
    return visible;
  }

  /** Replay missing operator records after a crash before resuming a continuation. */
  async syncOperatorAudit(scope: ReviewScope, id: string): Promise<void> {
    const review = await this.requireAuthorizedReview(scope, id, 'export');
    await this.auditReview(review);
  }

  async export(scope: ReviewScope, id: string): Promise<DecisionReview | null> {
    const review = await this.store.read(id, scope.tenantId, scope.projectId);
    if (!review || !await this.authorization.authorize(scope, 'export', review)) return null;
    // A D10 rule that denies export, or a review past retention, reads like an absent one.
    if (this.lifecycleRule?.export === 'denied' || this.pastRetention(review)) return null;
    return structuredClone(review);
  }

  /**
   * Access-audited, retention-bounded view of host-held sensitive material. The
   * access is appended to the review journal (`sensitive-view-accessed`) before
   * the host source is read, so an unaudited read cannot happen. The content is
   * never persisted in the review, its events or telemetry. The granted lifetime
   * never exceeds the review's retention deadline. Missing, out-of-scope,
   * tombstoned, expired-retention and unauthorized reviews all fail as
   * `ReviewAccessError("Review not found")`.
   */
  async openSensitiveView(scope: ReviewScope, id: string, request: ReviewSensitiveViewRequest,
    source: ReviewSensitiveViewSource): Promise<ReviewSensitiveView | null> {
    if (!request || typeof request.purpose !== 'string' || !request.purpose.trim() ||
      !Number.isSafeInteger(request.ttlMs) || request.ttlMs < 1 || typeof source?.read !== 'function') {
      throw new ReviewConflictError('Invalid sensitive view request');
    }
    assertReviewProjection(request.purpose);
    let grant: { at: number; expires: number } | undefined;
    const audited = await this.mutate(scope, id, 'sensitive-view', review => {
      const deadline = this.retentionDeadline(review);
      const at = this.now();
      if (review.status === 'tombstoned' || (deadline !== undefined && at >= deadline)) throw this.unavailable();
      if (deadline === undefined) throw new ReviewConflictError('Sensitive view requires a pinned retention deadline');
      grant = { at, expires: Math.min(at + request.ttlMs, deadline) };
      return this.append(review, 'sensitive-view-accessed', scope.actor, request.purpose, review.status,
        { viewExpiresAtEpochMs: grant.expires });
    });
    const content = await source.read({ tenantId: audited.tenantId, projectId: audited.projectId, reviewId: audited.reviewId,
      sourceReceipt: structuredClone(audited.sourceReceipt), evidencePins: structuredClone(audited.evidencePins) });
    if (content === null || content === undefined) return null;
    return { reviewId: audited.reviewId, purpose: request.purpose, content, grantedAtEpochMs: grant!.at,
      expiresAtEpochMs: grant!.expires, auditEventSequence: audited.events.length };
  }

  /** Opaque D10 reference for a review; the host keeps the reverse index, never model-visible state. */
  lifecycleReference(review: Pick<DecisionReview, 'tenantId' | 'projectId' | 'reviewId'>): DecisionLifecycleReference {
    return { surface: 'review', opaqueId: reviewDigest({ schema: 'decision-review-lifecycle/v1',
      tenantId: review.tenantId, projectId: review.projectId, reviewId: review.reviewId }) };
  }

  /** D10 `links` support: references for the reviews created from one source receipt that the caller may delete. */
  async lifecycleReferences(scope: ReviewScope, sourceReceiptId: string): Promise<DecisionLifecycleReference[]> {
    this.requireLifecycle();
    if (!await this.authorization.authorize(scope, 'list')) return [];
    const references: DecisionLifecycleReference[] = [];
    for (const review of await this.store.list(scope.tenantId, scope.projectId)) {
      if (review.sourceReceipt.id === sourceReceiptId && await this.authorization.authorize(scope, 'delete', review)) {
        references.push(this.lifecycleReference(review));
      }
    }
    return references;
  }

  /**
   * D10 `erase` support for `eraseDecisionSubject`. Appends a tombstone under
   * delete authority (refused under legal hold) and, when the D10 review rule
   * says `erase`, physically purges the revisions. Erasure never converts an
   * unavailable review into approval: a tombstoned or purged review cannot resume.
   */
  async eraseLifecycleReference(scope: ReviewScope, reference: DecisionLifecycleReference): Promise<boolean> {
    const rule = this.requireLifecycle();
    if (reference?.surface !== 'review' || !reference.opaqueId) throw new ReviewConflictError('Review lifecycle reference invalid');
    const review = (await this.store.list(scope.tenantId, scope.projectId))
      .find(item => this.lifecycleReference(item).opaqueId === reference.opaqueId);
    if (!review) {
      // Only an operator may learn that a reference is already erased.
      if (!await this.authorization.authorize(scope, 'purge')) throw this.unavailable();
      return false;
    }
    await this.applyTombstone(scope, review.reviewId, 'D10 lifecycle erasure', 'delete');
    if (rule.deletion === 'erase') {
      if (!this.store.purgeTombstoned) throw new ReviewConflictError('Physical review purge is unavailable');
      await this.store.purgeTombstoned(review.reviewId, scope.tenantId, scope.projectId);
    }
    return true;
  }

  setLegalHold(scope: ReviewScope, id: string, legalHold: boolean, rationale: string) { return this.mutate(scope, id, 'legal-hold', review => {
    if (review.status === 'tombstoned') throw new ReviewConflictError('Tombstoned review cannot change legal hold');
    if ((review.lifecycle?.legalHold ?? false) === legalHold) return review;
    return this.append({ ...review, lifecycle: { ...review.lifecycle, legalHold } }, legalHold ? 'legal-hold-placed' : 'legal-hold-released', scope.actor, rationale, review.status);
  }, true); }

  delete(scope: ReviewScope, id: string, rationale: string) { return this.applyTombstone(scope, id, rationale, 'delete'); }
  tombstone(scope: ReviewScope, id: string, rationale: string) { return this.applyTombstone(scope, id, rationale, 'tombstone'); }

  /** Cryptographic audit marker remains, but every historical plaintext revision is removed. */
  async purge(scope: ReviewScope, id: string) {
    if (!this.store.purgeTombstoned) throw new ReviewConflictError('Physical review purge is unavailable');
    const review = await this.store.read(id, scope.tenantId, scope.projectId);
    // A denied existing review and an absent one fail identically.
    if (!await this.authorization.authorize(scope, review ? 'delete' : 'purge', review ?? undefined)) throw this.unavailable();
    if (review && (review.status !== 'tombstoned' || review.lifecycle?.legalHold ||
      review.retentionUntilEpochMs === undefined || this.now() < review.retentionUntilEpochMs)) {
      throw new ReviewConflictError('Review retention or legal hold prohibits purge');
    }
    try { return await this.store.purgeTombstoned(id, scope.tenantId, scope.projectId); }
    catch (error) {
      if (!review && error instanceof Error && /scope mismatch|requires an unheld tombstone/.test(error.message)) {
        throw this.unavailable();
      }
      throw error;
    }
  }

  private applyTombstone(scope: ReviewScope, id: string, rationale: string, operation: 'delete' | 'tombstone') { return this.mutate(scope, id, operation, review => {
    if (review.lifecycle?.legalHold) throw new ReviewConflictError('Review deletion prohibited by legal hold');
    if (review.status === 'tombstoned') return review;
    const at = this.now();
    return this.append({ ...review, lifecycle: { legalHold: false, tombstonedAtEpochMs: at, tombstoneReason: rationale } }, 'tombstoned', scope.actor, rationale, 'tombstoned');
  }, true); }

  claim(scope: ReviewScope, id: string, rationale: string) { return this.mutate(scope, id, 'claim', review => {
    this.requireStatus(review, ['pending', 'claimed']);
    if (review.status === 'claimed') {
      if (review.events.at(-1)?.actor.id === scope.actor.id) return review;
      throw new ReviewConflictError('Review already claimed');
    }
    return this.append(review, 'claimed', scope.actor, rationale, 'claimed');
  }, true); }

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

  edit(scope: ReviewScope, id: string, action: unknown, rationale: string, newResumeToken: string) { return this.mutate(scope, id, 'edit', async review => {
    this.requireActive(review); const at = this.now(); const version = currentProposal(review).version + 1;
    if (!newResumeToken || reviewDigest(newResumeToken) === review.continuation.tokenDigest) throw new ReviewConflictError('Edited proposal requires a fresh resume token');
    const proposal = { version, action: structuredClone(action), actionDigest: reviewDigest(action), createdAtEpochMs: at, editor: scope.actor, rationale };
    if (!await this.authorization.authorizeAction(scope, review, proposal)) throw new ReviewAccessError('Edited action is not authorized');
    return this.append({ ...review, continuation: { ...review.continuation, tokenDigest: reviewDigest(newResumeToken) },
      proposals: [...review.proposals, proposal] }, 'edited', scope.actor, rationale, 'pending');
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

  async resume(scope: ReviewScope, id: string, token: string, execute: (effectId: string, action: unknown) => Promise<unknown>,
    reconcile?: (effectId: string) => Promise<ReviewEffectReceipt | null>): Promise<ReviewEffectReceipt> {
    for (;;) {
      const review = await this.requireAuthorizedReview(scope, id, 'resume');
      await this.auditReview(review);
      if (review.continuation.tokenDigest !== reviewDigest(token)) throw new ReviewAccessError('Invalid resume token');
      if (review.effectReceipt) return review.effectReceipt;
      const proposal = currentProposal(review);
      const approvals = review.decisions.filter(item => item.proposalVersion === proposal.version && item.decision === 'approve');
      if (approvals.length < review.quorum) throw new ReviewConflictError('Approval quorum is no longer satisfied');
      const currentApprovals = await Promise.all(approvals.map(decision => this.authorization.eligibleApproval(scope, review, proposal, decision)));
      if (currentApprovals.filter(Boolean).length < review.quorum ||
          !await this.authorization.eligible(scope, review, proposal) || !await this.authorization.authorizeAction(scope, review, proposal)) {
        const denied = this.append(review, 'authorization-denied', scope.actor, 'resume authorization denied', review.status);
        if (!await this.store.compareAndSwap(id, scope.tenantId, scope.projectId, review.revision, denied)) continue;
        await this.auditReview(denied);
        await this.emitTelemetry(denied);
        throw new ReviewAccessError('Authorization is no longer valid');
      }
      if (review.status === 'resuming') {
        const acquiredAt = review.events.at(-1)?.atEpochMs ?? review.updatedAtEpochMs;
        if (this.now() - acquiredAt < this.resumingLeaseMs) { await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs)); continue; }
        const effectId = reviewDigest({ reviewId: id, continuationId: review.continuation.id, proposalVersion: proposal.version });
        // A stale lease does not prove whether the remote effect ran. Replaying
        // execute with the same ID cannot establish idempotence by itself.
        if (!reconcile) throw new ReviewConflictError('Stale continuation requires effect reconciliation');
        const receipt = await reconcile(effectId);
        if (!receipt) throw new ReviewConflictError('Effect outcome remains unknown');
        if (receipt.effectId !== effectId || receipt.continuationId !== review.continuation.id ||
            receipt.proposalVersion !== proposal.version) throw new ReviewConflictError('Reconciliation receipt mismatch');
        const recovered = this.append(review, 'resumed', scope.actor, 'stale continuation reconciled', 'resuming', { effectId, recovered: true });
        if (!await this.store.compareAndSwap(id, scope.tenantId, scope.projectId, review.revision, recovered)) continue;
        await this.finish(scope, id, recovered.revision, receipt);
        return receipt;
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
    let result: unknown;
    try {
      result = await execute(effectId, structuredClone(action));
    } catch (error) {
      // An arbitrary rejection cannot prove that the remote effect did not run.
      // Leave the lease in resuming for authoritative reconciliation after restart.
      if (error instanceof ReviewDefinitiveExecutionError) {
        const failed = this.append(resuming, 'execution-failed', scope.actor, 'executor failed', 'execution-failed');
        failed.executionError = 'executor-failed';
        await this.store.compareAndSwap(id, scope.tenantId, scope.projectId, resuming.revision, failed);
      }
      throw error;
    }
    const receipt: ReviewEffectReceipt = { effectId, continuationId: resuming.continuation.id, proposalVersion: currentProposal(resuming).version, completedAtEpochMs: this.now(), result };
    // If persistence fails, DO NOT claim the external effect failed. Reconcile
    // from the executor-owned journal rather than dispatching it a second time.
    await this.finish(scope, id, resuming.revision, receipt);
    const completed = await this.store.read(id, scope.tenantId, scope.projectId);
    if (completed) await this.emitTelemetry(completed, receipt.effectId);
    return receipt;
  }

  private async finish(scope: ReviewScope, id: string, revision: number, receipt: ReviewEffectReceipt) {
    const review = await this.requireReview(scope, id);
    if (review.revision !== revision || review.status !== 'resuming') throw new ReviewConflictError('Resume ownership was lost');
    const completed = this.append({ ...review, effectReceipt: receipt }, 'execution-completed', scope.actor, 'executor completed', 'completed', { effectId: receipt.effectId });
    if (!await this.store.compareAndSwap(id, scope.tenantId, scope.projectId, revision, completed)) throw new ReviewConflictError('Could not persist effect receipt');
    await this.auditReview(completed);
  }

  private async mutate(scope: ReviewScope, id: string, operation: Parameters<ReviewAuthorization['authorize']>[1], build: (review: DecisionReview) => DecisionReview | Promise<DecisionReview>, allowNoop = false): Promise<DecisionReview> {
    for (;;) { const review = await this.requireAuthorizedReview(scope, id, operation); const next = await build(review);
      if (allowNoop && next === review) return review;
      if (await this.store.compareAndSwap(id, scope.tenantId, scope.projectId, review.revision, next)) {
        await this.auditReview(next);
        await this.emitTelemetry(next);
        return next;
      } }
  }
  private async requireReview(scope: ReviewScope, id: string) { const review = await this.store.read(id, scope.tenantId, scope.projectId); if (!review) throw this.unavailable(); return review; }
  /** Missing, out-of-scope and unauthorized reviews share one error so callers cannot probe existence. */
  private async requireAuthorizedReview(scope: ReviewScope, id: string, operation: Parameters<ReviewAuthorization['authorize']>[1]) {
    const review = await this.store.read(id, scope.tenantId, scope.projectId);
    if (!review || !await this.authorization.authorize(scope, operation, review)) throw this.unavailable();
    return review;
  }
  private unavailable() { return new ReviewAccessError('Review not found'); }
  private requireLifecycle(): DecisionLifecycleRule {
    if (!this.lifecycleRule) throw new ReviewConflictError('Review service has no D10 lifecycle binding');
    return this.lifecycleRule;
  }
  /** Effective deadline: the review's pin, capped by the D10 review rule when bound. */
  private retentionDeadline(review: DecisionReview): number | undefined {
    const ceiling = this.lifecycleRule ? review.createdAtEpochMs + this.lifecycleRule.retentionMs : undefined;
    if (review.retentionUntilEpochMs === undefined) return ceiling;
    return ceiling === undefined ? review.retentionUntilEpochMs : Math.min(ceiling, review.retentionUntilEpochMs);
  }
  private pastRetention(review: DecisionReview): boolean {
    if (!this.lifecycleRule) return false;
    const deadline = this.retentionDeadline(review);
    return deadline !== undefined && this.now() >= deadline;
  }
  private async allowed(scope: ReviewScope, operation: Parameters<ReviewAuthorization['authorize']>[1], review?: DecisionReview) { if (!await this.authorization.authorize(scope, operation, review)) throw new ReviewAccessError('Review access denied'); }
  private requireActive(review: DecisionReview) { this.requireStatus(review, ['pending', 'claimed']); if (this.now() >= review.expiresAtEpochMs) throw new ReviewConflictError('Review is expired'); }
  private requireStatus(review: DecisionReview, states: DecisionReview['status'][]) { if (!states.includes(review.status)) throw new ReviewConflictError(`Illegal transition from ${review.status}`); }
  private append(review: DecisionReview, type: ReviewEventType, actor: ReviewActor, rationale: string, status: DecisionReview['status'], data?: Record<string, unknown>): DecisionReview {
    const at = Math.max(this.now(), review.updatedAtEpochMs); const proposalVersion = currentProposal(review).version;
    return { ...structuredClone(review), revision: review.revision + 1, status, updatedAtEpochMs: at,
      events: [...review.events, { sequence: review.events.length + 1, type, atEpochMs: at, actor, proposalVersion,
        rationale, operatorDecisionEventId: reviewOperatorEventId(review.reviewId, review.events.length + 1), ...(data ? { data } : {}) }] };
  }

  private async auditReview(review: DecisionReview): Promise<void> {
    if (!this.operatorAudit) return;
    const audit = this.operatorAudit;
    const next = this.auditQueue.then(async () => {
      await replayReviewOperatorAudit(review, audit.store, this.auditCorrelation(review), audit.classification);
    });
    this.auditQueue = next.catch(() => {});
    await next;
  }

  /**
   * The #1567 record and the review span must share one trace identity. When the
   * host supplies a telemetry parent and no explicit trace ID, bind the audit
   * correlation to that W3C trace instead of keeping a parallel identifier.
   */
  private auditCorrelation(review: DecisionReview): DecisionCorrelation {
    const correlation = this.operatorAudit!.correlation(review);
    const parent = this.telemetry?.parent;
    return parent && correlation.trace_id === undefined ? { ...correlation, trace_id: parent.traceId } : correlation;
  }

  private async emitTelemetry(review: DecisionReview, effectId?: string): Promise<void> {
    if (!this.telemetry) return;
    try {
      const builder = new DecisionTraceBuilder(this.telemetry.ids, this.now);
      const last = review.events.at(-1);
      // Only operator decisions have a #1567 record; other events carry no audit ID.
      const operatorEvent = last && OPERATOR_DECISION_EVENTS.has(last.type) ? last.operatorDecisionEventId : undefined;
      const approval = review.events.filter(event => event.type === 'approved').at(-1)?.operatorDecisionEventId;
      const root = builder.startSpan('decision.review', {
        ...(this.telemetry.parent ? { parent: this.telemetry.parent } : {}),
        attributes: {
          'aiwg.review.id': sanitizeOpaqueValue(review.reviewId, 128),
          'aiwg.review.status': review.status,
          'aiwg.review.revision': review.revision,
          'aiwg.review.event': last?.type ?? 'unknown',
          ...(operatorEvent ? { 'aiwg.operator_decision.event_id': sanitizeOpaqueValue(operatorEvent, 128) } : {}),
        },
        provenance: {
          'aiwg.review.id': 'client-derived', 'aiwg.review.status': 'client-derived',
          'aiwg.review.revision': 'client-derived', 'aiwg.review.event': 'client-derived',
          'aiwg.operator_decision.event_id': 'client-derived',
        },
      });
      builder.endSpan(root, review.status === 'execution-failed' ? 'error' : 'ok');
      if (effectId) {
        const action = builder.startSpan('decision.action', { parent: root.context,
          links: [{ ...root.context, relationship: 'review', attributes: { 'aiwg.review.id': sanitizeOpaqueValue(review.reviewId, 128) } }],
          attributes: { 'aiwg.effect_receipt.id': sanitizeOpaqueValue(effectId, 128), 'aiwg.review.id': sanitizeOpaqueValue(review.reviewId, 128),
            ...(approval ? { 'aiwg.operator_decision.event_id': sanitizeOpaqueValue(approval, 128) } : {}) },
          provenance: { 'aiwg.effect_receipt.id': 'client-derived', 'aiwg.review.id': 'client-derived',
            'aiwg.operator_decision.event_id': 'client-derived' } });
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
