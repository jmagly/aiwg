import { createHash } from 'node:crypto';
import { z } from 'zod';
export const SESSION_CONTRACT_VERSION = '1.0.0' as const;
export const SESSION_PROVIDER_IDS = [
  'claude', 'codex', 'copilot', 'cursor', 'factory', 'hermes',
  'opencode', 'openclaw', 'openhuman', 'grokbot', 'grok-build', 'pi', 'omp', 'deepseek-harness', 'warp', 'devin-desktop', 'muse', 'generic',
] as const satisfies readonly [
  string, string, string, string, string, string,
  string, string, string, string, string, string, string, string, string, string, string, string,
];

export const SessionProviderIdSchema = z.enum(SESSION_PROVIDER_IDS);
export type SessionProviderId = z.infer<typeof SessionProviderIdSchema>;
export const SESSION_PROVIDER_ALIASES = Object.freeze({
  windsurf: 'devin-desktop',
  dsh: 'deepseek-harness',
} as const);
const CompatibleSessionProviderIdSchema = z.preprocess(
  (value) => typeof value === 'string'
    ? (SESSION_PROVIDER_ALIASES[value as keyof typeof SESSION_PROVIDER_ALIASES] ?? value)
    : value,
  SessionProviderIdSchema,
);

export const CapabilityDispositionSchema = z.enum([
  'implemented', 'manual-only', 'degraded', 'unsupported',
]);
export const OperationalStateSchema = z.enum([
  'available', 'unavailable', 'inaccessible', 'version-unknown',
  'schema-unsupported', 'degraded',
]);
export const ConsistencyStateSchema = z.enum([
  'provisional', 'consistent-snapshot', 'complete',
]);
export const SessionErrorCodeSchema = z.enum([
  'UNKNOWN_PROVIDER', 'UNKNOWN_SCHEMA_MAJOR', 'SOURCE_NOT_AUTHORIZED',
  'SOURCE_OUTSIDE_ALLOWED_ROOT', 'SOURCE_SYMLINK', 'SOURCE_NOT_REGULAR_FILE',
  'RESOURCE_LIMIT_EXCEEDED', 'NETWORK_NOT_AUTHORIZED', 'SCHEMA_DRIFT',
  'OPERATION_NOT_AUTHORIZED',
  'IMPORT_CONFLICT', 'IMPORT_INTERRUPTED', 'MALFORMED_SOURCE',
  'DUPLICATE_NATIVE_ID', 'AMBIGUOUS_TIMESTAMP', 'TRUNCATED_SOURCE',
  'UNSUPPORTED_OPERATION',
  'INVALID_SEARCH_QUERY', 'INVALID_ARGUMENT',
]);

const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const NativeExtensionsSchema = z.record(z.unknown()).superRefine((value, context) => {
  for (const key of Object.keys(value)) {
    if (!key.startsWith('native.')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `native extension must use native.<provider>: ${key}` });
    }
  }
});

export const SessionSourceSchema = z.object({
  contractVersion: z.literal(SESSION_CONTRACT_VERSION),
  sourceId: z.string().min(1),
  provider: CompatibleSessionProviderIdSchema,
  providerProfile: z.string().min(1),
  locatorClass: z.string().min(1),
  redactedLocator: z.string().min(1),
  adapterVersion: VersionSchema,
  sourceSchemaVersion: VersionSchema,
  disposition: CapabilityDispositionSchema,
  operationalState: OperationalStateSchema,
  consistency: ConsistencyStateSchema,
  authorizedAt: z.string().datetime({ offset: true }),
  extensions: NativeExtensionsSchema.default({}),
});

export const SessionEventSchema = z.object({
  contractVersion: z.literal(SESSION_CONTRACT_VERSION),
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  sourceId: z.string().min(1),
  importRunId: z.string().min(1),
  nativeId: z.string().min(1).nullable(),
  sequence: z.number().int().nonnegative(),
  kind: z.string().min(1),
  role: z.string().min(1).nullable(),
  participant: z.string().min(1).nullable().default(null),
  toolName: z.string().min(1).nullable().default(null),
  toolCallId: z.string().min(1).nullable().default(null),
  model: z.string().min(1).nullable().default(null),
  entities: z.array(z.string().min(1)).default([]),
  extractionState: z.string().min(1).nullable().default(null),
  occurredAt: z.string().datetime({ offset: true }).nullable(),
  activityBoundary: z.enum(['pause', 'resume', 'continuation', 'end']).nullable().default(null),
  activityBoundaryBasis: z.string().min(1).nullable().default(null),
  activityBoundaryConfidence: z.enum(['low', 'medium', 'high']).nullable().default(null),
  origin: z.enum([
    'user-authored', 'assistant-generated', 'provider-bootstrap',
    'workspace-instruction', 'tool-control', 'unknown',
  ]).default('unknown'),
  originRule: z.string().min(1).default('legacy:unknown'),
  originClassifierVersion: VersionSchema.default('1.0.0'),
  searchableText: z.string(),
  digest: DigestSchema,
  rawReference: z.object({
    locatorClass: z.string().min(1),
    offset: z.number().int().nonnegative().optional(),
    sequence: z.number().int().nonnegative().optional(),
  }),
  adapterVersion: VersionSchema,
  consistency: ConsistencyStateSchema,
  sensitivity: z.object({
    classification: z.enum(['none', 'sensitive']),
    classes: z.array(z.string().min(1)),
  }),
  opaque: z.boolean().default(false),
  extensions: NativeExtensionsSchema.default({}),
});

export const SessionSchema = z.object({
  contractVersion: z.literal(SESSION_CONTRACT_VERSION),
  sessionId: z.string().min(1),
  sourceId: z.string().min(1),
  provider: CompatibleSessionProviderIdSchema,
  nativeSessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
  consistency: ConsistencyStateSchema,
  lifecycle: z.enum([
    'active', 'inactive', 'paused', 'complete', 'interrupted', 'archived',
    'unknown', 'tombstoned',
  ]),
  intent: z.object({
    status: z.enum(['selected', 'absent', 'unknown']),
    eventId: z.string().min(1).nullable(),
    sequence: z.number().int().nonnegative().nullable(),
    title: z.string().nullable(),
    summary: z.string().nullable(),
  }).default({
    status: 'unknown',
    eventId: null,
    sequence: null,
    title: null,
    summary: null,
  }),
  sourceDigest: DigestSchema,
  extensions: NativeExtensionsSchema.default({}),
});

export const ImportCheckpointSchema = z.object({
  cursor: z.string(),
  recordsRead: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative(),
  checkpointVersion: z.literal('2').optional(),
  positionKind: z.enum(['record-index', 'byte-offset', 'provider-native']).optional(),
  sourceGeneration: z.string().min(1).optional(),
  locatorClass: z.string().min(1).optional(),
  adapterVersion: VersionSchema.optional(),
  sourceSchemaVersion: VersionSchema.optional(),
  policyVersion: VersionSchema.optional(),
  continuity: z.enum([
    'new-generation',
    'validated-append',
    'unchanged-replay',
    'unverified',
  ]).optional(),
  sourceSize: z.number().int().nonnegative().optional(),
  sourceMtimeMs: z.number().nonnegative().optional(),
  sourceFileIdentity: z.string().min(1).optional(),
  prefixDigest: DigestSchema.optional(),
});

export const ImportRunSchema = z.object({
  contractVersion: z.literal(SESSION_CONTRACT_VERSION),
  importRunId: z.string().min(1),
  sourceId: z.string().min(1),
  parserVersion: VersionSchema,
  policyVersion: VersionSchema,
  sourceSchemaVersion: VersionSchema,
  consistency: ConsistencyStateSchema,
  status: z.enum(['running', 'committed', 'rolled-back', 'failed']),
  checkpoint: ImportCheckpointSchema,
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  errorCode: SessionErrorCodeSchema.nullable(),
});

export const ProvenanceEdgeSchema = z.object({
  contractVersion: z.literal(SESSION_CONTRACT_VERSION),
  edgeId: z.string().min(1),
  relation: z.enum([
    'acquired-from', 'normalized-from', 'derived-from', 'promoted-to',
    'supersedes', 'invalidates',
  ]),
  fromId: z.string().min(1),
  toId: z.string().min(1),
  importRunId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
});

export const IntelligenceCandidateTypeSchema = z.enum([
  'decision', 'requirement', 'constraint', 'preference', 'task', 'discovery',
  'fix', 'failed-approach', 'procedure', 'risk', 'contradiction', 'question',
  'entity', 'relationship',
]);

export const CandidateSecurityWarningSchema = z.enum([
  'instruction-like', 'structure-breaking', 'control-character', 'bidi-control',
  'unicode-confusable', 'active-content', 'secret-bearing',
]);

export const CandidateSecuritySchema = z.object({
  disposition: z.enum(['clear', 'suspicious']),
  warnings: z.array(CandidateSecurityWarningSchema),
  requiresAcknowledgement: z.boolean(),
  acknowledged: z.boolean(),
  policyVersion: VersionSchema,
}).strict();

export const IntelligenceCandidateSchema = z.object({
  contractVersion: z.literal(SESSION_CONTRACT_VERSION),
  candidateId: z.string().min(1),
  version: z.number().int().positive(),
  type: IntelligenceCandidateTypeSchema,
  assertion: z.string().min(1),
  subject: z.string().min(1).nullable(),
  predicate: z.string().min(1).nullable(),
  object: z.string().min(1).nullable(),
  evidence: z.array(z.object({
    eventId: z.string().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quoteDigest: DigestSchema,
    quote: z.string().min(1).optional(),
  }).strict()).min(1),
  confidence: z.number().min(0).max(1),
  temporalScope: z.string().min(1),
  projectScope: z.string().min(1),
  extractionMethod: z.string().min(1),
  extractionVersion: VersionSchema,
  extractionPolicyVersion: VersionSchema,
  model: z.string().min(1).nullable(),
  sensitivity: z.enum(['none', 'sensitive']),
  security: CandidateSecuritySchema.default({
    disposition: 'clear',
    warnings: [],
    requiresAcknowledgement: false,
    acknowledged: false,
    policyVersion: '1.0.0',
  }),
  reviewState: z.enum([
    'pending', 'accepted', 'rejected', 'deferred', 'promoted', 'superseded',
  ]),
  conflictsWith: z.array(z.string().min(1)).default([]),
  supersedes: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime({ offset: true }),
}).strict().superRefine((candidate, context) => {
  if (candidate.type === 'relationship'
    && (!candidate.subject || !candidate.predicate || !candidate.object)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'relationship candidates require subject, predicate, and object',
    });
  }
});

export const CandidateReviewReceiptSchema = z.object({
  contractVersion: z.literal(SESSION_CONTRACT_VERSION),
  receiptId: z.string().min(1),
  candidateId: z.string().min(1),
  candidateVersion: z.number().int().positive(),
  fromState: z.enum([
    'pending', 'accepted', 'rejected', 'deferred', 'promoted', 'superseded',
  ]),
  toState: z.enum([
    'pending', 'accepted', 'rejected', 'deferred', 'promoted', 'superseded',
  ]),
  reviewer: z.string().min(1),
  reason: z.string().min(1),
  securityWarnings: z.array(CandidateSecurityWarningSchema).default([]),
  securityAcknowledged: z.boolean().default(false),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();

export const PromotionReceiptSchema = z.object({
  contractVersion: z.literal(SESSION_CONTRACT_VERSION),
  receiptId: z.string().min(1),
  operationId: z.string().min(1),
  candidateId: z.string().min(1),
  candidateVersion: z.number().int().positive(),
  consumer: z.string().min(1),
  destinationRef: z.string().min(1),
  reviewer: z.string().min(1),
  approvedAt: z.string().datetime({ offset: true }),
  evidenceEventIds: z.array(z.string().min(1)).min(1),
  conflictsWith: z.array(z.string().min(1)),
  supersedes: z.array(z.string().min(1)),
  beforeHash: DigestSchema.nullable(),
  afterHash: DigestSchema,
  dryRun: z.boolean(),
  duplicate: z.boolean(),
}).strict();

export const DeletionReceiptSchema = z.object({
  contractVersion: z.literal(SESSION_CONTRACT_VERSION),
  receiptId: z.string().min(1),
  operationId: z.string().min(1),
  scopeClass: z.string().min(1),
  counts: z.record(z.number().int().nonnegative()),
  survivingDependentIds: z.array(z.string().min(1)),
  actorClass: z.string().min(1),
  reasonCode: z.string().min(1),
  orphanCounts: z.record(z.number().int().nonnegative()),
  outcome: z.enum(['preview', 'committed', 'failed']),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();

export const PromotionDependencyDecisionSchema = z.object({
  dependentId: z.string().min(1),
  action: z.enum([
    'revoke', 'supersede', 'retain', 'origin_unavailable', 'delete', 'abort',
  ]),
  basis: z.string().min(1),
}).strict();

export type SessionSource = z.infer<typeof SessionSourceSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type ImportCheckpoint = z.infer<typeof ImportCheckpointSchema>;
export type ImportRun = z.infer<typeof ImportRunSchema>;
export type ProvenanceEdge = z.infer<typeof ProvenanceEdgeSchema>;
export type IntelligenceCandidate = z.infer<typeof IntelligenceCandidateSchema>;
export type CandidateSecurityWarning = z.infer<typeof CandidateSecurityWarningSchema>;
export type CandidateReviewReceipt = z.infer<typeof CandidateReviewReceiptSchema>;
export type PromotionReceipt = z.infer<typeof PromotionReceiptSchema>;
export type DeletionReceipt = z.infer<typeof DeletionReceiptSchema>;
export type PromotionDependencyDecision = z.infer<typeof PromotionDependencyDecisionSchema>;

export interface ProviderRecord {
  nativeSessionId: string;
  nativeEventId?: string;
  sequence: number;
  kind: string;
  role?: string;
  participant?: string;
  toolName?: string;
  toolCallId?: string;
  model?: string;
  entities?: string[];
  extractionState?: string;
  /** Import-control metadata; not copied into normalized event extensions. */
  sourceCursor?: string;
  sourceBytes?: number;
  occurredAt?: string;
  activityBoundary?: 'pause' | 'resume' | 'continuation' | 'end';
  activityBoundaryBasis?: string;
  activityBoundaryConfidence?: 'low' | 'medium' | 'high';
  text: string;
  rawReference: SessionEvent['rawReference'];
  extensions?: Record<string, unknown>;
}

export interface AuthorizedScope {
  workspaceId: string;
  allowedRoots: string[];
  authorizedAccounts?: string[];
  networkOperation?: string;
}
export interface SourceDescriptor { provider: SessionProviderId; locator: string; locatorClass: string }
export interface SelectedSource extends SourceDescriptor { sourceId: string; authorizedScope: AuthorizedScope }
export interface SourceProbe {
  sourceSchemaVersion: string;
  consistency: z.infer<typeof ConsistencyStateSchema>;
  operationalState: z.infer<typeof OperationalStateSchema>;
}
export interface ImportCursor { value: string }

export interface SessionSourceAdapter {
  readonly provider: SessionProviderId;
  readonly adapterVersion: string;
  readonly disposition: z.infer<typeof CapabilityDispositionSchema>;
  readonly supportedOperations: readonly SessionSourceOperation[];
  readonly acquisitionModes: readonly SessionAcquisitionMode[];
  readonly sourceSchemaMajor?: number;
  /** Validated mutable preamble excluded from append-continuity checks. */
  mutablePrefixBytes?(source: SelectedSource): Promise<number>;
  discover(scope: AuthorizedScope): AsyncIterable<SourceDescriptor>;
  inspect(source: SelectedSource): Promise<SourceProbe>;
  stream(source: SelectedSource, cursor?: ImportCursor): AsyncIterable<ProviderRecord>;
}

export type SessionSourceOperation = 'discover' | 'inspect' | 'stream' | 'snapshot';
export type SessionAcquisitionMode =
  | 'api' | 'jsonl' | 'sqlite-snapshot' | 'hook' | 'manual-export';

export function assertSessionProviderId(value: string): SessionProviderId {
  const canonical = SESSION_PROVIDER_ALIASES[
    value as keyof typeof SESSION_PROVIDER_ALIASES
  ] ?? value;
  const parsed = SessionProviderIdSchema.safeParse(canonical);
  if (!parsed.success) throw new SessionContractError('UNKNOWN_PROVIDER', `unknown session provider: ${value}`);
  return parsed.data;
}

export function assertSupportedSchemaMajor(version: string, supportedMajor = 1): void {
  const match = /^(\d+)\./.exec(version);
  if (!match || Number(match[1]) !== supportedMajor) {
    throw new SessionContractError('UNKNOWN_SCHEMA_MAJOR', `unsupported session schema major: ${version}`);
  }
}

export function stableSessionId(provider: SessionProviderId | string, sourceId: string, nativeSessionId: string): string {
  const canonical = assertSessionProviderId(provider);
  // Preserve the legacy identity seed through the published compatibility
  // window so existing Windsurf catalogs do not duplicate normalized rows.
  const identitySeed = canonical === 'devin-desktop' ? 'windsurf' : canonical;
  return stableId('session', identitySeed, sourceId, nativeSessionId);
}

export function stableEventId(
  provider: SessionProviderId | string,
  sourceId: string,
  record: ProviderRecord,
  digest: string,
): string {
  const canonical = assertSessionProviderId(provider);
  const identityScheme = 'event-v2-native-scope';
  return record.nativeEventId
    ? stableId(
        'event',
        identityScheme,
        canonical,
        sourceId,
        record.nativeSessionId,
        record.nativeEventId,
        record.sequence,
      )
    : stableId('event', identityScheme, canonical, sourceId, record.nativeSessionId, record.sequence, record.kind, digest);
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableId(prefix: string, ...parts: Array<string | number>): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex')}`;
}

export class SessionContractError extends Error {
  constructor(public readonly code: z.infer<typeof SessionErrorCodeSchema>, message: string) {
    super(message);
    this.name = 'SessionContractError';
  }
}
