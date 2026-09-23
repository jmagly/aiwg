import type { DecisionReview, ReviewActor, ReviewAuthorization, ReviewDecision, ReviewOperation, ReviewProposal, ReviewScope } from './types.js';
import { reviewDigest } from './validate.js';

export interface PinnedReviewPolicy {
  id: string;
  version: string;
  tenantId: string;
  projectId: string;
  reviewerRoles: string[];
  requesterRoles: string[];
  executorRoles: string[];
  auditorRoles: string[];
  operatorRoles: string[];
  minimumQuorumByRisk: Record<string, number>;
  /** Immutable governed retention window per risk tier; pins erase eligibility. */
  retentionWindowMsByRisk: Record<string, number>;
  separateRequesterReviewer: boolean;
  separateEditorReviewer: boolean;
  separateReviewerExecutor: boolean;
}

export interface LiveReviewAuthority {
  /** Independently attest the caller; do not infer authentication from supplied actor.id. */
  authenticate(scope: ReviewScope): Promise<boolean>;
  /** Resolve current status from authenticated identity authority; never from persisted review.roles. */
  resolve(tenantId: string, projectId: string, actorId: string): Promise<{
    roles: string[]; active: boolean; compromised: boolean; conflictsWith: string[]; authorityContext: string;
  } | null>;
  /** Current policy digest must match the immutable review pin at every transition. */
  currentPolicyDigest(tenantId: string, projectId: string, policyId: string): Promise<`sha256:${string}` | null>;
}

/** Explicit offline/host adapter; no credential handling and no default allow on missing authority. */
export class PinnedReviewAuthorization implements ReviewAuthorization {
  readonly policyDigest: `sha256:${string}`;
  private readonly policy: PinnedReviewPolicy;
  constructor(policy: PinnedReviewPolicy, private readonly authority: LiveReviewAuthority,
    private readonly actionAllowed: (scope: ReviewScope, review: DecisionReview, proposal: ReviewProposal) => Promise<boolean>) {
    if (!policy.id || !policy.version || !policy.tenantId || !policy.projectId ||
      Object.values(policy.minimumQuorumByRisk).some(value => !Number.isSafeInteger(value) || value < 1 || value > 16) ||
      !policy.retentionWindowMsByRisk ||
      Object.values(policy.retentionWindowMsByRisk).some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('Invalid pinned review policy');
    }
    this.policy = structuredClone(policy);
    this.policyDigest = reviewDigest(this.policy);
  }
  private inScope(scope: ReviewScope) {
    return scope.tenantId === this.policy.tenantId && scope.projectId === this.policy.projectId;
  }
  private async actor(scope: ReviewScope, actor: ReviewActor) {
    if (!this.inScope(scope) || (actor.id === scope.actor.id && !await this.authority.authenticate(scope))) return null;
    const current = await this.authority.resolve(scope.tenantId, scope.projectId, actor.id);
    if (!current?.active || current.compromised) return null;
    return current;
  }
  private hasRole(actual: string[], required: string[]) { return actual.some(role => required.includes(role)); }
  private async pinned(review: DecisionReview) {
    const retention = this.policy.retentionWindowMsByRisk[review.riskTier];
    if (review.tenantId !== this.policy.tenantId || review.projectId !== this.policy.projectId ||
        review.quorum < (this.policy.minimumQuorumByRisk[review.riskTier] ?? Infinity) ||
        retention === undefined || review.retentionUntilEpochMs !== review.createdAtEpochMs + retention) return false;
    const pin = review.policyPins.find(item => item.id === this.policy.id && item.version === this.policy.version && item.digest === this.policyDigest);
    return Boolean(pin) && await this.authority.currentPolicyDigest(review.tenantId, review.projectId, this.policy.id) === this.policyDigest;
  }
  async authorize(scope: ReviewScope, operation: ReviewOperation, review?: DecisionReview): Promise<boolean> {
    const actor = await this.actor(scope, scope.actor);
    if (!actor || (review && !await this.pinned(review))) return false;
    if (!review && operation === 'create') return this.hasRole(actor.roles, this.policy.requesterRoles);
    if (!review && operation === 'list') return this.hasRole(actor.roles, [
      ...this.policy.reviewerRoles, ...this.policy.auditorRoles, ...this.policy.operatorRoles,
    ]);
    if (!review) return false;
    switch (operation) {
      case 'create': return this.hasRole(actor.roles, this.policy.requesterRoles);
      case 'list': case 'read': case 'export': return this.hasRole(actor.roles, [
        ...this.policy.reviewerRoles, ...this.policy.auditorRoles, ...this.policy.operatorRoles,
      ]);
      case 'resume': return this.hasRole(actor.roles, this.policy.executorRoles);
      case 'claim': case 'decide': case 'edit': return this.hasRole(actor.roles, this.policy.reviewerRoles);
      case 'escalate': case 'cancel': case 'legal-hold': case 'delete': case 'tombstone':
        return this.hasRole(actor.roles, this.policy.operatorRoles);
    }
  }
  async eligible(scope: ReviewScope, review: DecisionReview, proposal: ReviewProposal): Promise<boolean> {
    if (!await this.pinned(review) || proposal.version !== review.proposals.at(-1)?.version) return false;
    const actor = await this.actor(scope, scope.actor);
    if (!actor || !this.hasRole(actor.roles, this.policy.reviewerRoles.concat(this.policy.executorRoles))) return false;
    if (actor.conflictsWith.includes(review.requesterId) || actor.conflictsWith.includes(proposal.editor.id)) return false;
    if (this.policy.separateRequesterReviewer && scope.actor.id === review.requesterId) return false;
    if (this.policy.separateEditorReviewer && scope.actor.id === proposal.editor.id) return false;
    return true;
  }
  async eligibleApproval(scope: ReviewScope, review: DecisionReview, proposal: ReviewProposal, decision: ReviewDecision): Promise<boolean> {
    if (!await this.pinned(review) || decision.proposalVersion !== proposal.version) return false;
    const reviewer = await this.actor(scope, decision.reviewer);
    if (!reviewer || !this.hasRole(reviewer.roles, this.policy.reviewerRoles)) return false;
    if (this.policy.separateRequesterReviewer && decision.reviewer.id === review.requesterId) return false;
    if (this.policy.separateEditorReviewer && decision.reviewer.id === proposal.editor.id) return false;
    if (this.policy.separateReviewerExecutor && decision.reviewer.id === scope.actor.id) return false;
    return !reviewer.conflictsWith.includes(review.requesterId) && !reviewer.conflictsWith.includes(proposal.editor.id);
  }
  async authorizeAction(scope: ReviewScope, review: DecisionReview, proposal: ReviewProposal): Promise<boolean> {
    return await this.pinned(review) && Boolean(await this.actor(scope, scope.actor)) && await this.actionAllowed(scope, review, proposal);
  }
}
