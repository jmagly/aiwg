/**
 * TypeScript types for Enhanced Model Selection System (Phase 1)
 *
 * @implements @.aiwg/architecture/ADR-015-enhanced-model-selection.md
 * @architecture @.aiwg/architecture/enhanced-model-selection-design.md
 */

/**
 * Quality tier for model selection
 */
export type ModelTier = 'economy' | 'standard' | 'premium' | 'max-quality';

/**
 * Provider-neutral runtime routing tier for escalation policy.
 *
 * 0 = no model call, 1 = default/cheap, 2 = capable work model,
 * 3 = premium/supervised.
 */
export type RuntimeModelTier = 0 | 1 | 2 | 3;

export interface ModelRouteRequest {
  /** Agent or workflow name, used for diagnostics only. */
  agentName?: string;
  /** Current/default runtime tier for the session. Defaults to 1. */
  defaultTier?: RuntimeModelTier;
  /** Existing answer, deterministic tool, or cache is sufficient. */
  deterministic?: boolean;
  /** Routine summary/classification/formatting. */
  routine?: boolean;
  /** Multi-step debugging, code changes, architecture, or nuanced analysis. */
  complex?: boolean;
  /** Legal, medical, financial, security, destructive, shared infra, or release-impacting work. */
  highImpact?: boolean;
  /** User or policy explicitly requested a stronger/premium model. */
  requestedPremium?: boolean;
  /** Unattended bot/session policy. */
  unattended?: boolean;
  /** Highest tier allowed without confirmation. Defaults to 2 for supervised, 1 for unattended. */
  maxAutoTier?: RuntimeModelTier;
  /** Invocation or project policy has already authorized premium routing. */
  premiumAuthorized?: boolean;
}

export interface ModelRouteDecision {
  tier: RuntimeModelTier;
  modelTier: ModelTier | null;
  requiresConfirmation: boolean;
  summaryRequired: boolean;
  source: 'deterministic' | 'default' | 'complexity' | 'impact' | 'request' | 'policy';
  rationale: string[];
}

/**
 * Task role for model categorization
 */
export type ModelRole = 'reasoning' | 'coding' | 'efficiency';

/**
 * AI provider identifier
 */
export type Provider =
  | 'antigravity'
  | 'claude'
  | 'codex'
  | 'copilot'
  | 'cursor'
  | 'factory'
  | 'grokbot'
  | 'grok-build'
  | 'hermes'
  | 'muse'
  | 'opencode'
  | 'openclaw'
  | 'openhuman'
  | 'omp'
  | 'pi'
  | 'openai'
  | 'warp'
  | 'windsurf';

export type ModelEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface CanonicalModelPolicy {
  role: ModelRole;
  tier: ModelTier;
  effort?: ModelEffort;
  override?: string;
}

export type ModelCompilationOutcome =
  | 'native'
  | 'compiled'
  | 'inherited'
  | 'global-only'
  | 'informational'
  | 'unsupported';

/**
 * Model capability flags
 */
export interface ModelCapabilities {
  longContext?: boolean;
  reasoning?: boolean;
  codeGeneration?: boolean;
  vision?: boolean;
  toolUse?: boolean;
  fastResponse?: boolean;
}

/**
 * Cost information per 1000 tokens
 */
export interface CostPer1kTokens {
  input: number;
  output: number;
}

/**
 * Model metadata
 */
export interface ModelInfo {
  id: string;
  provider: Provider;
  role: ModelRole;
  aliases: string[];
  capabilities: string[];
  contextWindow: number;
  costPer1kTokens?: CostPer1kTokens;
}

/**
 * Model definition in config
 */
export interface ModelDefinition {
  default: string;
  aliases?: string[];
  capabilities?: string[];
  contextWindow?: number;
  costPer1kTokens?: CostPer1kTokens;
}

/**
 * Role-to-role mapping for tier system
 */
export interface RoleMapping {
  reasoning: ModelRole;
  coding: ModelRole;
  efficiency: ModelRole;
}

/**
 * Tier definition
 */
export interface TierDefinition {
  description: string;
  costMultiplier: number;
  roleMapping: RoleMapping;
}

/**
 * Tier-specific model overrides
 */
export interface TierOverrides {
  [tier: string]: {
    reasoning?: string;
    coding?: string;
    efficiency?: string;
  };
}

/**
 * Provider definition
 */
export interface ProviderDefinition {
  inherits?: Provider;
  _status?: 'STABLE' | 'EXPERIMENTAL' | 'DEPRECATED';
  description?: string;
  models?: {
    reasoning?: ModelDefinition;
    coding?: ModelDefinition;
    efficiency?: ModelDefinition;
  };
  tierOverrides?: TierOverrides;
}

/**
 * Agent role assignment category
 */
export interface AgentRoleAssignment {
  agents: string[];
  defaultRole: ModelRole;
  minimumTier: ModelTier;
  rationale: string;
}

/**
 * Configuration defaults
 */
export interface WorkerModelObservation {
  version: 1;
  recordId: string;
  cliId: string;
  family: string;
  runtimeVersion: string;
  accountScope: string;
  endpointFingerprint: string;
  observedAt: string;
  verifiedAt: string;
  releaseDate: string | null;
  releaseDateKind: 'official' | 'reported' | 'unknown';
  visibility: 'listed' | 'hidden' | 'unknown';
  availability: 'accessible' | 'unavailable' | 'unknown';
  lifecycle: 'active' | 'deprecated' | 'retired' | 'unverified';
  sunsetAt?: string | null;
  replacementModelId?: string;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  modalities: Array<'text' | 'image' | 'audio' | 'video'>;
  efforts: Array<{ id: string; selfDelegates: boolean | null }>;
  effortSupport: 'explicit' | 'not-applicable' | 'unknown';
  pricing: { costClass: 'economy' | 'standard' | 'premium' | 'unknown'; billing: 'metered' | 'subscription' | 'local' | 'unknown'; currency: 'USD'; inputPerMillion: number | null; outputPerMillion: number | null };
  dataUse: { processing: 'local' | 'remote' | 'unknown'; productImprovement: boolean | null; retentionDays: number | null };
  qualification: { status: 'qualified' | 'unqualified'; roles: string[]; fixtureDigest?: string; verifiedAt?: string; evidenceRef?: string };
  /** Stable digest of material source facts, independent of cache read time. */
  evidenceDigest?: string;
  conflicts?: Array<{
    field: string;
    evidence: Array<{ value: unknown; source: string; pointer: string; observedAt: string; digest: string }>;
  }>;
  provenance: Array<{ fields: string[]; source: string; kind: 'native' | 'official' | 'operator' | 'derived'; observedAt: string; digest: string; confidence: 'verified' | 'reported' | 'derived' | 'unknown' }>;
  firstObservedAt: string;
  fetchedAt: string;
  retiredAt: string | null;
  supersededBy?: string;
}

export interface WorkerDataPolicy {
  allowedProcessing?: Array<'local' | 'remote'>;
  allowProductImprovement?: boolean;
  allowUnknown?: boolean;
  maxRetentionDays?: number;
}
export interface WorkerRoleGuidance {
  groups: string[];
  tier: ModelTier;
  initialEffort: string | null;
  effortLadder: string[];
  escalateAfter?: number;
  maxEscalations?: number;
  deescalateAfter?: number;
  allowNotApplicableEffort?: boolean;
}
export interface WorkerSelectionPolicy {
  roleGuidance?: Record<string, WorkerRoleGuidance>;
  guards?: {
    deniedEfforts?: string[];
    deniedModels?: string[];
    denySelfDelegation?: boolean;
    requireExactModel?: boolean;
    allowedVisibility?: Array<'listed' | 'hidden'>;
    allowedLifecycle?: Array<'active' | 'deprecated'>;
    minimumIdentityEvidence?: 'runtime-configured' | 'backend-attested';
  };
  dataPolicy?: WorkerDataPolicy;
  dataClasses?: Record<string, WorkerDataPolicy>;
  freshness?: { warnHours?: number; blockHours?: number; policyDays?: number };
  taskClasses?: Record<string, string>;
}
export interface WorkerPolicyOrigin {
  source: string;
  pointer: string;
  digest: string;
  authority: 'builtin' | 'user' | 'project';
  contribution: unknown;
}
export interface WorkerPolicyDiagnostic {
  /** When present, this diagnostic concerns only these roles. */
  roles?: string[];
  code: 'OG_POLICY_RELAXATION' | 'OG_CONFIG_REFERENCE' | 'OG_EFFORT_DENIED' | 'OG_MODEL_UNAPPROVED' | 'OG_DATA_POLICY' | 'OG_PIN_MISMATCH' | 'OG_ADAPTER_UNQUALIFIED' | 'OG_BUDGET_UNMEASURABLE';
  pointer: string;
  message: string;
  /** Diagnostics block by default; optional evidence conflicts are advisory. */
  blocking?: boolean;
  origins?: WorkerPolicyOrigin[];
}

export interface ConfigDefaults {
  workerSelection?: WorkerSelectionPolicy;
  tier: ModelTier;
  provider: Provider;
}

/**
 * Shorthand aliases
 */
export interface Shorthand {
  [alias: string]: string;
}

/**
 * Model configuration v2 schema
 */
export interface ModelConfig {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  version: string;
  lastUpdated?: string;
  defaults: ConfigDefaults;
  tiers: {
    [tier: string]: TierDefinition;
  };
  providers: {
    [provider: string]: ProviderDefinition;
  };
  agentRoleAssignments?: {
    [category: string]: AgentRoleAssignment;
  };
  shorthand?: Shorthand;
  _comments?: Record<string, string>;
}

/**
 * Legacy v1 model configuration (backwards compatibility)
 */
export interface ModelConfigV1 {
  [provider: string]: {
    reasoning?: { model: string; description?: string };
    coding?: { model: string; description?: string };
    efficiency?: { model: string; description?: string };
  } | { [key: string]: string };
}

/**
 * Resolved model information
 */
export interface ResolvedModel {
  modelId: string;
  provider: Provider;
  tier: ModelTier;
  role: ModelRole;
  source: 'cli' | 'agent' | 'project' | 'user' | 'default';
}

/**
 * Model resolver options
 */
export interface ModelResolverOptions {
  provider?: Provider;
  tier?: ModelTier;
  respectMinimums?: boolean;
  overrides?: Record<string, string>;
}

/**
 * Agent override configuration (from user/project config)
 */
export interface AgentOverride {
  'model-tier'?: ModelTier;
  'model-override'?: string;
  rationale?: string;
}

/**
 * User/Project configuration structure
 */
export interface UserProjectConfig {
  defaults?: Partial<ConfigDefaults>;
  agentOverrides?: {
    [agentName: string]: AgentOverride;
  };
  customTiers?: {
    [tierName: string]: TierDefinition;
  };
  rationale?: string;
}

/**
 * Merged configuration with precedence
 */
export interface MergedModelConfig {
  workerPolicyOrigins?: Record<string, WorkerPolicyOrigin[]>;
  defaults: ConfigDefaults;
  tiers: { [tier: string]: TierDefinition };
  providers: { [provider: string]: ProviderDefinition };
  agentRoleAssignments: { [category: string]: AgentRoleAssignment };
  shorthand: Shorthand;
  agentOverrides: { [agentName: string]: AgentOverride };
}

/**
 * Tier information for listing
 */
export interface TierInfo {
  tier: ModelTier;
  description: string;
  costMultiplier: number;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}
