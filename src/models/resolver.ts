/**
 * Model Resolver
 * Resolves agent names and roles to concrete model identifiers using tier system
 *
 * @implements @docs/models/supported-models.md
 * @architecture @docs/models/supported-models.md
 */

import { normalizeModelTier, TIER_ORDER, flagshipElected, isFlagshipModel } from './tiers.js';
import { compileModelPolicy } from './provider-policy.js';
import { ConfigLoader } from './config-loader.js';
import { resolveWorkerPlan, type WorkerPlanRequest, type WorkerPlanSnapshot, type WorkerResolutionPlan } from './worker-plan.js';
export * from './worker-plan.js';
import type { ModelTier, ModelRole, Provider, ResolvedModel, ModelResolverOptions, MergedModelConfig, ModelInfo, TierInfo } from './types.js';

/**
 * Resolves models for agents using tier system
 */
export class ModelResolver {
  private config: MergedModelConfig | null = null;
  private readonly loader: ConfigLoader;
  private readonly options: ModelResolverOptions;

  constructor(options: ModelResolverOptions = {}, projectPath?: string) {
    this.options = {
      respectMinimums: true,
      ...options,
    };
    this.loader = new ConfigLoader(projectPath);
  }

  /** Reload current files through the origin-aware loader on every worker plan. */
  async resolveWorker(request: WorkerPlanRequest, input: Omit<WorkerPlanSnapshot, 'models' | 'modelDigests'>): Promise<WorkerResolutionPlan> {
    const models = await this.loader.load(input.config.parallelism);
    return resolveWorkerPlan({ ...input, models, modelDigests: this.loader.getInputDigests()! }, request);
  }

  /**
   * Resolve model for an agent
   *
   * @param agentName - Name of the agent
   * @param agentRole - Role hint from agent frontmatter (legacy 'model' field)
   * @param agentTier - Tier from agent frontmatter (new 'model-tier' field)
   * @returns Resolved model information
   */
  async resolve(
    agentName: string,
    agentRole?: ModelRole,
    agentTier?: ModelTier
  ): Promise<ResolvedModel> {
    const config = await this.getConfig();

    // Determine effective tier and role
    const { tier, role, source } = this.determineEffectiveTierAndRole(
      agentName,
      agentRole,
      agentTier,
      config
    );

    if (normalizeModelTier(tier) === 'flagship' && !flagshipElected({ ...this.options, agentName })) {
      throw new Error('Flagship models are user-elected only');
    }

    // Check for direct model override (bypasses tier system)
    const override = config.agentOverrides[agentName];
    if (override?.['model-override']) {
      if (isFlagshipModel(override['model-override']) && !flagshipElected({ ...this.options, agentName })) throw new Error('Flagship models are user-elected only');
      return {
        modelId: override['model-override'],
        provider: this.options.provider || config.defaults.provider,
        tier: normalizeModelTier(tier),
        role,
        source: 'agent',
      };
    }

    const provider = this.options.provider || config.defaults.provider;
    const modelId = normalizeModelTier(tier) === 'flagship'
      ? compileModelPolicy({
          provider: provider === 'openai' ? 'codex' : provider,
          artifact: 'agent', policy: { tier: 'flagship', role },
          election: this.options.election, flagshipAllowlist: this.options.flagshipAllowlist, agentName,
        }).effectiveModel
      : this.resolveModelId(tier, role, config);
    if (!modelId) throw new Error(`No supported model binding for ${provider}/${tier}`);
    if (isFlagshipModel(modelId) && !flagshipElected({ ...this.options, agentName })) {
      throw new Error('Flagship models are user-elected only');
    }

    return {
      modelId,
      provider: this.options.provider || config.defaults.provider,
      tier: normalizeModelTier(tier),
      role,
      source,
    };
  }

  /**
   * Determine effective tier and role for an agent
   */
  private determineEffectiveTierAndRole(
    agentName: string,
    agentRole: ModelRole | undefined,
    agentTier: ModelTier | undefined,
    config: MergedModelConfig
  ): { tier: ModelTier; role: ModelRole; source: ResolvedModel['source'] } {
    // 1. CLI tier takes precedence
    if (this.options.tier) {
      const role = this.determineRole(agentName, agentRole, config);
      return {
        tier: this.applyMinimumTier(agentName, this.options.tier, config),
        role,
        source: 'cli',
      };
    }

    // 2. Agent frontmatter tier
    const agentOverride = config.agentOverrides[agentName];
    if (agentTier || agentOverride?.['model-tier']) {
      const tier = agentTier || agentOverride!['model-tier']!;
      const role = this.determineRole(agentName, agentRole, config);
      return {
        tier: this.applyMinimumTier(agentName, tier, config),
        role,
        source: 'agent',
      };
    }

    // 3. Default tier from config
    const defaultTier = config.defaults.tier;
    const role = this.determineRole(agentName, agentRole, config);

    return {
      tier: this.applyMinimumTier(agentName, defaultTier, config),
      role,
      source: 'default',
    };
  }

  /**
   * Determine role for agent
   */
  private determineRole(
    agentName: string,
    agentRole?: ModelRole,
    config?: MergedModelConfig
  ): ModelRole {
    // If explicit role provided, use it
    if (agentRole) {
      return agentRole;
    }

    // Check agent role assignments
    if (config?.agentRoleAssignments) {
      for (const category of Object.values(config.agentRoleAssignments)) {
        if (category.agents.includes(agentName)) {
          return category.defaultRole;
        }
      }
    }

    // Default to 'coding' as reasonable middle ground
    return 'coding';
  }

  /**
   * Apply minimum tier constraint if respectMinimums is true
   */
  private applyMinimumTier(
    agentName: string,
    requestedTier: ModelTier,
    config: MergedModelConfig
  ): ModelTier {
    if (!this.options.respectMinimums) {
      return requestedTier;
    }

    // Find agent's minimum tier
    for (const category of Object.values(config.agentRoleAssignments || {})) {
      if (category.agents.includes(agentName)) {
        const minimumTier = category.minimumTier;
        return this.maxTier(requestedTier, minimumTier);
      }
    }

    return requestedTier;
  }

  /**
   * Return the higher of two tiers
   */
  private maxTier(tier1: ModelTier, tier2: ModelTier): ModelTier {
    const tierOrder = TIER_ORDER;
    const index1 = tierOrder.indexOf(normalizeModelTier(tier1));
    const index2 = tierOrder.indexOf(normalizeModelTier(tier2));
    return tierOrder[Math.max(index1, index2)];
  }

  /**
   * Resolve tier + role to concrete model ID
   */
  private resolveModelId(tier: ModelTier, role: ModelRole, config: MergedModelConfig): string {
    const provider = this.options.provider || config.defaults.provider;
    let providerDef = config.providers[provider];

    if (!providerDef) {
      throw new Error(`Provider ${provider} not found in configuration`);
    }

    // Resolve inheritance
    providerDef = this.loader.resolveProviderInheritance(providerDef, config.providers);

    // Check for tier-specific override first
    if (providerDef.tierOverrides?.[tier]?.[role]) {
      return providerDef.tierOverrides[tier][role]!;
    }

    // Apply tier's role mapping
    const tierDef = config.tiers[tier];
    if (!tierDef) {
      throw new Error(`Tier ${tier} not found in configuration`);
    }

    const mappedRole = tierDef.roleMapping[role];

    // Get model for mapped role
    const modelDef = providerDef.models?.[mappedRole];
    if (!modelDef) {
      throw new Error(`Model not found for provider ${provider}, role ${mappedRole}`);
    }

    return modelDef.default;
  }

  /**
   * Get model info by ID or alias
   */
  async getModelInfo(modelIdOrAlias: string): Promise<ModelInfo | null> {
    const config = await this.getConfig();
    const provider = this.options.provider || config.defaults.provider;
    let providerDef = config.providers[provider];

    if (!providerDef) {
      return null;
    }

    // Resolve inheritance
    providerDef = this.loader.resolveProviderInheritance(providerDef, config.providers);

    // Check shorthand aliases
    const resolvedId = config.shorthand[modelIdOrAlias] || modelIdOrAlias;

    // Search through all roles
    for (const [roleName, modelDef] of Object.entries(providerDef.models || {})) {
      if (modelDef.default === resolvedId || modelDef.aliases?.includes(modelIdOrAlias)) {
        return {
          id: modelDef.default,
          provider,
          role: roleName as ModelRole,
          aliases: modelDef.aliases || [],
          capabilities: modelDef.capabilities || [],
          contextWindow: modelDef.contextWindow || 0,
          costPer1kTokens: modelDef.costPer1kTokens,
        };
      }
    }

    return null;
  }

  /**
   * List all available models for provider
   */
  async listModels(provider?: Provider): Promise<ModelInfo[]> {
    const config = await this.getConfig();
    const targetProvider = provider || this.options.provider || config.defaults.provider;
    let providerDef = config.providers[targetProvider];

    if (!providerDef) {
      return [];
    }

    // Resolve inheritance
    providerDef = this.loader.resolveProviderInheritance(providerDef, config.providers);

    const models: ModelInfo[] = [];

    for (const [roleName, modelDef] of Object.entries(providerDef.models || {})) {
      models.push({
        id: modelDef.default,
        provider: targetProvider,
        role: roleName as ModelRole,
        aliases: modelDef.aliases || [],
        capabilities: modelDef.capabilities || [],
        contextWindow: modelDef.contextWindow || 0,
        costPer1kTokens: modelDef.costPer1kTokens,
      });
    }

    return models;
  }

  /**
   * List available tiers
   */
  async listTiers(): Promise<TierInfo[]> {
    const config = await this.getConfig();

    return Object.entries(config.tiers).map(([tierName, tierDef]) => ({
      tier: normalizeModelTier(tierName as ModelTier),
      description: tierDef.description,
      costMultiplier: tierDef.costMultiplier,
    }));
  }

  /**
   * Get configuration (cached)
   */
  private async getConfig(): Promise<MergedModelConfig> {
    if (!this.config) {
      this.config = await this.loader.load();
    }
    return this.config;
  }

  /**
   * Clear cache (useful for testing)
   */
  clearCache(): void {
    this.config = null;
    this.loader.clearCache();
  }
}
