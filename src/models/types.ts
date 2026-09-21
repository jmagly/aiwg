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
export interface ConfigDefaults {
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
