export const DECISION_REVIEW_API_VERSION = 'decision.aiwg.io/v1alpha1' as const;

export type ReviewStatus =
  | 'pending' | 'claimed' | 'approved' | 'rejected' | 'expired'
  | 'escalated' | 'canceled' | 'resuming' | 'completed' | 'execution-failed' | 'tombstoned';

export type ReviewEventType =
  | 'created' | 'claimed' | 'approved' | 'rejected' | 'edited' | 'expired'
  | 'escalated' | 'canceled' | 'resumed' | 'execution-completed' | 'execution-failed'
  | 'legal-hold-placed' | 'legal-hold-released' | 'tombstoned' | 'authorization-denied'
  | 'sensitive-view-accessed';

export interface ReviewActor {
  id: string;
  roles: string[];
  authorityContext: string;
}

export interface ReviewProposal {
  version: number;
  action: unknown;
  actionDigest: `sha256:${string}`;
  createdAtEpochMs: number;
  editor: ReviewActor;
  rationale: string;
}

export interface ReviewDecision {
  reviewer: ReviewActor;
  proposalVersion: number;
  decision: 'approve' | 'reject';
  rationale: string;
  atEpochMs: number;
}

export interface ReviewEvent {
  sequence: number;
  type: ReviewEventType;
  atEpochMs: number;
  actor: ReviewActor;
  proposalVersion: number;
  rationale: string;
  /** Same ID used in #1567 operator-decision audit; not a second audit identity. */
  operatorDecisionEventId?: string;
  data?: Record<string, unknown>;
}

export interface ReviewEffectReceipt {
  effectId: string;
  continuationId: string;
  proposalVersion: number;
  completedAtEpochMs: number;
  result: unknown;
}

export interface DecisionReview {
  apiVersion: typeof DECISION_REVIEW_API_VERSION;
  kind: 'DecisionReview';
  schema: 'decision-review/v1';
  revision: number;
  reviewId: string;
  tenantId: string;
  projectId: string;
  requesterId: string;
  sourceReceipt: { id: string; digest: `sha256:${string}` };
  evidencePins: Array<{ id: string; version: string; digest: `sha256:${string}` }>;
  policyPins: Array<{ id: string; version: string; digest: `sha256:${string}` }>;
  reasonCodes: string[];
  riskTier: string;
  presentation: Record<string, unknown>;
  proposals: ReviewProposal[];
  decisions: ReviewDecision[];
  events: ReviewEvent[];
  status: ReviewStatus;
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
  expiresAtEpochMs: number;
  /** Explicit pinned retention deadline; absent disables physical purge. */
  retentionUntilEpochMs?: number;
  escalationAtEpochMs?: number;
  quorum: number;
  continuation: { id: string; tokenDigest: `sha256:${string}` };
  effectReceipt?: ReviewEffectReceipt;
  executionError?: string;
  lifecycle?: {
    legalHold: boolean;
    tombstonedAtEpochMs?: number;
    tombstoneReason?: string;
  };
}

export interface ReviewScope { tenantId: string; projectId: string; actor: ReviewActor }

export type ReviewOperation = 'create' | 'read' | 'list' | 'export' | 'claim' | 'decide' | 'edit' | 'escalate' | 'cancel' | 'resume' | 'legal-hold' | 'delete' | 'tombstone' | 'purge' | 'sensitive-view';

export interface ReviewAuthorization {
  authorize(scope: ReviewScope, operation: ReviewOperation, review?: DecisionReview): boolean | Promise<boolean>;
  eligible(scope: ReviewScope, review: DecisionReview, proposal: ReviewProposal): boolean | Promise<boolean>;
  authorizeAction(scope: ReviewScope, review: DecisionReview, proposal: ReviewProposal): boolean | Promise<boolean>;
  /** Resolve each approval against current role/COI/quorum policy, never trust stored roles alone. */
  eligibleApproval(scope: ReviewScope, review: DecisionReview, proposal: ReviewProposal, decision: ReviewDecision): boolean | Promise<boolean>;
}

export interface ReviewStore {
  read(reviewId: string, tenantId: string, projectId: string): Promise<DecisionReview | null>;
  create(review: DecisionReview): Promise<boolean>;
  compareAndSwap(reviewId: string, tenantId: string, projectId: string, expectedRevision: number, next: DecisionReview): Promise<boolean>;
  list(tenantId: string, projectId: string): Promise<DecisionReview[]>;
  /** Optional terminal payload erasure; implementations preserve a signed non-reusable ID marker. */
  purgeTombstoned?(reviewId: string, tenantId: string, projectId: string): Promise<ReviewPurgeReceipt>;
}

export interface ReviewPurgeReceipt {
  reviewIdDigest: `sha256:${string}`;
  tenantDigest: `sha256:${string}`;
  projectDigest: `sha256:${string}`;
  lastRevision: number;
  finalReviewMac: string;
}

export interface ReviewListOptions { includeTombstoned?: boolean }
export interface DecisionReviewServiceOptions {
  resumingLeaseMs?: number;
  /** Single-writer #1567 audit journal; missing records are reconciled before any effect. */
  operatorAudit?: {
    store: import('../../audit/operator-decision.js').JsonlOperatorDecisionStore;
    correlation: (review: DecisionReview) => import('../../audit/operator-decision.js').DecisionCorrelation;
    classification: import('../../audit/operator-decision.js').DataClassification;
  };
  pollIntervalMs?: number;
  /**
   * Binds review retention, export and erasure to the shared D10 `review` lifecycle
   * surface. The rule caps each review's retention deadline, denies export when the
   * rule does, hides reviews past retention, and lets `eraseDecisionSubject` cascade
   * through opaque review references.
   */
  lifecycle?: { policy: import('../lifecycle.js').DecisionLifecyclePolicy };
  /** Optional metadata-only sink; exporter failures never affect review state. */
  telemetry?: {
    hook: import('../telemetry/types.js').DecisionTelemetryHook;
    ids?: import('../telemetry/context.js').DecisionTelemetryIdSource;
    parent?: import('../telemetry/types.js').DecisionTelemetryContext;
  };
}

export interface CreateReviewInput {
  reviewId: string;
  sourceReceipt: DecisionReview['sourceReceipt'];
  evidencePins: DecisionReview['evidencePins'];
  policyPins: DecisionReview['policyPins'];
  reasonCodes: string[];
  riskTier: string;
  presentation: Record<string, unknown>;
  action: unknown;
  rationale: string;
  expiresAtEpochMs: number;
  retentionUntilEpochMs?: number;
  escalationAtEpochMs?: number;
  quorum?: number;
  continuationId: string;
  resumeToken: string;
}

/**
 * Host-owned source of sensitive review material (for example the unprojected
 * evidence behind a presentation). The review store never holds this content;
 * the service reads it only after authorizing and durably auditing the access.
 */
export interface ReviewSensitiveViewSource {
  read(reference: { tenantId: string; projectId: string; reviewId: string;
    sourceReceipt: DecisionReview['sourceReceipt']; evidencePins: DecisionReview['evidencePins'] }): Promise<unknown | null>;
}

export interface ReviewSensitiveViewRequest {
  /** Recorded in the review journal; must be a projection-safe justification. */
  purpose: string;
  /** Requested view lifetime. The granted lifetime never exceeds review retention. */
  ttlMs: number;
}

export interface ReviewSensitiveView {
  reviewId: string;
  purpose: string;
  content: unknown;
  grantedAtEpochMs: number;
  /** min(grant + ttl, review retention deadline, D10 review retention). Callers discard content afterwards. */
  expiresAtEpochMs: number;
  /** Sequence of the durable `sensitive-view-accessed` event that audits this access. */
  auditEventSequence: number;
}
