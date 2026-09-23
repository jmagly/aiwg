export const DECISION_REVIEW_API_VERSION = 'decision.aiwg.io/v1alpha1' as const;

export type ReviewStatus =
  | 'pending' | 'claimed' | 'approved' | 'rejected' | 'expired'
  | 'escalated' | 'canceled' | 'resuming' | 'completed' | 'execution-failed' | 'tombstoned';

export type ReviewEventType =
  | 'created' | 'claimed' | 'approved' | 'rejected' | 'edited' | 'expired'
  | 'escalated' | 'canceled' | 'resumed' | 'execution-completed' | 'execution-failed'
  | 'legal-hold-placed' | 'legal-hold-released' | 'tombstoned' | 'authorization-denied';

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

export type ReviewOperation = 'create' | 'read' | 'list' | 'export' | 'claim' | 'decide' | 'edit' | 'escalate' | 'cancel' | 'resume' | 'legal-hold' | 'delete' | 'tombstone';

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
}

export interface ReviewListOptions { includeTombstoned?: boolean }
export interface DecisionReviewServiceOptions {
  resumingLeaseMs?: number;
  pollIntervalMs?: number;
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
  escalationAtEpochMs?: number;
  quorum?: number;
  continuationId: string;
  resumeToken: string;
}
