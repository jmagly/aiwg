/**
 * Enhanced Model Selection System - Public API
 *
 * Provides tier-based model selection with:
 * - Quality tiers (economy, standard, premium, max-quality)
 * - Provider abstraction (claude, openai, factory, etc.)
 * - Hierarchical configuration (default < user < project < agent)
 * - Backwards compatibility with v1 configs
 *
 * @implements @.aiwg/architecture/ADR-015-enhanced-model-selection.md
 * @architecture @.aiwg/architecture/enhanced-model-selection-design.md
 *
 * @module models
 */

// Export all types
export type {
  ModelTier,
  RuntimeModelTier,
  ModelRole,
  Provider,
  ModelCapabilities,
  CostPer1kTokens,
  ModelInfo,
  ModelDefinition,
  RoleMapping,
  TierDefinition,
  TierOverrides,
  ProviderDefinition,
  AgentRoleAssignment,
  ConfigDefaults,
  Shorthand,
  ModelConfig,
  ModelConfigV1,
  ResolvedModel,
  ModelResolverOptions,
  AgentOverride,
  UserProjectConfig,
  MergedModelConfig,
  TierInfo,
  ValidationResult,
  ModelRouteRequest,
  ModelRouteDecision,
  CanonicalModelPolicy,
  ModelCompilationOutcome,
  ModelEffort,
} from './types.js';

// Export ConfigLoader
export { ConfigLoader } from './config-loader.js';
export type { ConfigLocations } from './config-loader.js';

// Export ModelResolver
export { ModelResolver } from './resolver.js';

// Export provider-neutral runtime tier routing primitive
export { routeModelTier } from './router.js';

export {
  discoverGrokBuildModels,
  parseGrokBuildModelConfig,
  resolveGrokBuildRoleModel,
} from './grok-build-models.js';

export {
  compileModelPolicy,
  loadProviderModelCapabilities,
  loadProviderModelCatalog,
  renderCodexAgentToml,
  resetModelPolicyCachesForTests,
  validateCanonicalModelPolicy,
  validateUserProjectModelConfig,
} from './provider-policy.js';
export type {
  CodexAgentDefinition,
  CompiledModelPolicy,
  CompileModelPolicyInput,
  ModelDiagnostic,
  ModelDiagnosticSeverity,
  ModelPolicyProvider,
  ProviderModelCapability,
  ProviderModelCapabilityRegistry,
  ProviderModelCatalog,
} from './provider-policy.js';
