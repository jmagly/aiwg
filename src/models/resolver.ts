/**
 * Model Resolver
 * Resolves agent names and roles to concrete model identifiers using tier system
 *
 * @implements @.aiwg/architecture/ADR-015-enhanced-model-selection.md
 * @architecture @.aiwg/architecture/enhanced-model-selection-design.md
 */

import { ConfigLoader } from './config-loader.js';
import { WORKER_DISPATCH_ENABLE_COMMAND, WORKER_DISPATCH_READINESS_COMMAND } from './worker-dispatch-offer.js';
import {
  resolveWorkerGroupInstallation, resolveParallelism, validateWorkerGroupQualifications, validateWorkerGroupReferences, validateWorkerBudgetEnforcement,
  workerActivationDigests, workerConfigDigest,
  type AiwgConfig, type WorkerActivation, type WorkerExecution,
} from '../config/aiwg-config.js';
import {
  qualifyWorkerInvocationProfile, validateWorkerPolicyRoute, validateWorkerModelObservation,
  hasOperatorWorkerNativeRenderer, hasSelectionRelevantConflicts, workerContextHeadroom, workerModelKey, isCanonicalWorkerModelKey,
  WorkerSelectionPolicySchema, validateWorkerCatalogDiscovery,
  type ProviderModelCapabilityRegistry, type WorkerInvocationProfile, type WorkerContextEstimate,
  type WorkerBoundary,
} from './provider-policy.js';
import type { DiscoveredModel, DynamicModelCatalog } from './model-discovery.js';
import { MODEL_WRAPPERS } from './provider-models.js';
import { routeModelTier } from './router.js';
import type { ModelRouteRequest, WorkerModelObservation, WorkerPolicyDiagnostic } from './types.js';
import type {
  ModelTier,
  ModelRole,
  Provider,
  ResolvedModel,
  ModelResolverOptions,
  MergedModelConfig,
  ModelInfo,
  TierInfo,
} from './types.js';

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

    // Check for direct model override (bypasses tier system)
    const override = config.agentOverrides[agentName];
    if (override?.['model-override']) {
      return {
        modelId: override['model-override'],
        provider: this.options.provider || config.defaults.provider,
        tier,
        role,
        source: 'agent',
      };
    }

    // Resolve tier + role to concrete model
    const modelId = this.resolveModelId(tier, role, config);

    return {
      modelId,
      provider: this.options.provider || config.defaults.provider,
      tier,
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
    const tierOrder: ModelTier[] = ['economy', 'standard', 'premium', 'max-quality'];
    const index1 = tierOrder.indexOf(tier1);
    const index2 = tierOrder.indexOf(tier2);
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
      tier: tierName as ModelTier,
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

type ModelInputDigests = Pick<WorkerActivation, 'projectModelsDigest' | 'userModelsDigest' | 'builtinModelsDigest'>;
export type WorkerIdentityEvidence = 'runtime-configured' | 'backend-attested' | 'unknown' | 'mismatched';

/** Current, trusted qualification projection supplied by the installation owner.
 * Task requests cannot introduce bindings or promote identity evidence. */
export interface WorkerResolutionBinding {
  cliVersion: string;
  accountScope: string;
  endpointFingerprint: string;
  profile: string;
  identityEvidence: WorkerIdentityEvidence;
  mcp?: WorkerInvocationProfile['mcp'];
  boundary?: WorkerBoundary;
}

export interface WorkerPlanSnapshot {
  config: AiwgConfig;
  /** ConfigLoader.load(parallelism), including restriction origins and wrapper pins. */
  models: MergedModelConfig;
  modelDigests: ModelInputDigests;
  catalog: DynamicModelCatalog;
  registry: ProviderModelCapabilityRegistry;
  installations: Record<string, WorkerResolutionBinding>;
  /** Current trusted restrictions; these can only remove candidates. */
  constraints?: { revokedModels?: string[]; unavailableMembers?: string[]; maxParallel?: number; ceilings?: WorkerResolutionCeilings };
}

export interface WorkerResolutionCeilings {
  tokens?: number;
  costUsd?: number;
  wallSeconds?: number;
  maxAttempts?: number;
}

export interface WorkerChoice {
  group: string;
  member: string;
  model: string;
  effort: string | null;
}

export interface WorkerPlanRequest {
  role?: 'efficiency' | 'coding' | 'reasoning';
  taskClass?: string;
  group?: string;
  member?: string;
  model?: string;
  effort?: string | null;
  dataClass?: string;
  transport?: 'shell' | 'mcp';
  context: WorkerContextEstimate;
  /** Explicit clock makes freshness and replay reproducible. */
  now: string;
  expectedDigests?: Record<string, string>;
  choice?: WorkerChoice & { rationale: string };
  /** Only the named, eligible replacement may depart from an exact pin. */
  substitution?: WorkerChoice & { rationale: string };
  reviewOf?: WorkerModelObservation;
  requireDifferentFamily?: boolean;
  authority?: ModelRouteRequest;
  requiredControls?: string[];
  maxParallel?: number;
  ceilings?: WorkerResolutionCeilings;
}

export interface WorkerEligibleTuple extends WorkerChoice {
  cli: string;
  inferenceProvider: string;
  modelKey: string;
  family: string;
  identityEvidence: WorkerIdentityEvidence;
  profile: string;
  transport: 'shell' | 'mcp';
  permissions: WorkerExecution;
  context: ReturnType<typeof workerContextHeadroom>;
  observedAt: string;
  verifiedAt: string;
  observationRef: string;
  effectiveMaxParallel: number | null;
  diagnostics: WorkerPolicyDiagnostic[];
}

export interface WorkerResolutionPlan {
  mode: 'direct' | 'managed';
  status: 'disabled' | 'eligible' | 'blocked';
  role: string | null;
  selected: WorkerEligibleTuple | null;
  eligible: WorkerEligibleTuple[];
  alternatives: WorkerEligibleTuple[];
  exclusions: Array<{ group: string; member: string; model: string; effort: string | null; diagnostics: WorkerPolicyDiagnostic[] }>;
  diagnostics: WorkerPolicyDiagnostic[];
  digests: Record<string, string>;
  policy: MergedModelConfig['defaults']['workerSelection'];
  origins: MergedModelConfig['workerPolicyOrigins'];
  choice: { source: 'conductor' | 'default'; rationale: string; substitution?: WorkerPlanRequest['substitution'] } | null;
  capacity: 'conductor-guidance-only';
  ceilings: WorkerResolutionCeilings;
}

const matchesChoice = (tuple: WorkerChoice, choice: WorkerChoice): boolean =>
  tuple.group === choice.group && tuple.member === choice.member && tuple.model === choice.model && tuple.effort === choice.effort;

function findWorkerModelRow(rows: DiscoveredModel[] | undefined, model: string): DiscoveredModel | undefined {
  const matches = rows?.filter(row => row.id === model || row.apiModelId === model) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

/** Pure S1 resolution. No probing, launch, activation, admission, or writes.
 * Recheck against freshly loaded snapshots before preparing an invocation. */
export function resolveWorkerPlan(snapshot: WorkerPlanSnapshot, request: WorkerPlanRequest): WorkerResolutionPlan {
  let parallelism = snapshot.config.parallelism ?? {};
  const policy = snapshot.models.defaults.workerSelection;
  const digests = {
    ...snapshot.modelDigests,
    configDigest: workerActivationDigests(snapshot.config).configDigest,
    resolvedModelsDigest: workerConfigDigest(snapshot.models),
    catalogDigest: workerConfigDigest(snapshot.catalog),
    profileDigest: workerConfigDigest([snapshot.registry, snapshot.installations]),
    constraintsDigest: workerConfigDigest(snapshot.constraints),
  };
  const plan: WorkerResolutionPlan = {
    mode: parallelism.worker_mode ?? 'direct', status: 'blocked', role: null, selected: null,
    eligible: [], alternatives: [], exclusions: [], diagnostics: [], digests,
    policy: structuredClone(policy), origins: structuredClone(snapshot.models.workerPolicyOrigins),
    choice: null, capacity: 'conductor-guidance-only', ceilings: {},
  };
  const diagnostic = (code: WorkerPolicyDiagnostic['code'], pointer: string, message: string): WorkerPolicyDiagnostic => ({ code, pointer, message });
  const block = (code: WorkerPolicyDiagnostic['code'], pointer: string, message: string): void => {
    plan.diagnostics.push(diagnostic(code, pointer, message));
  };
  if (!parallelism.worker_dispatch) {
    plan.status = 'disabled';
    block('OG_CONFIG_REFERENCE', '/parallelism/worker_dispatch',
      `Direct worker dispatch is off (parallelism.worker_dispatch). Enable with \`${WORKER_DISPATCH_ENABLE_COMMAND}\` `
      + `(then check readiness with \`${WORKER_DISPATCH_READINESS_COMMAND}\`).`);
    return plan;
  }
  const now = new Date(request.now);
  if (!Number.isFinite(now.getTime())) block('OG_CONFIG_REFERENCE', '/request/now', 'A valid current clock is required');
  if (!request.context || typeof request.context.estimator !== 'string') block('OG_CONFIG_REFERENCE', '/request/context', 'A named, bounded context estimate is required');
  if (snapshot.constraints?.revokedModels?.some(key => !isCanonicalWorkerModelKey(key))) block('OG_CONFIG_REFERENCE', '/constraints/revokedModels', 'Revocations require canonical inference model keys');
  if (request.expectedDigests && (Object.keys(request.expectedDigests).length !== Object.keys(digests).length
    || Object.entries(digests).some(([key, value]) => request.expectedDigests![key] !== value))) {
    block('OG_CONFIG_REFERENCE', '/request/expectedDigests', 'Current input digests changed; resolve again');
  }
  if (Object.values(snapshot.modelDigests).length !== 3 || Object.values(digests).some(value => !/^sha256:[a-f0-9]{64}$/.test(value))) {
    block('OG_CONFIG_REFERENCE', '/models', 'Current loader input digests are required');
  }
  if (plan.mode === 'managed') {
    const activation = parallelism.activation;
    if (!activation || ['configDigest', 'projectModelsDigest', 'userModelsDigest', 'builtinModelsDigest'].some(key =>
      activation[key as keyof WorkerActivation] !== digests[key as keyof typeof digests])) {
      block('OG_CONFIG_REFERENCE', '/parallelism/activation', 'Managed activation is missing or stale');
    }
    block('OG_ADAPTER_UNQUALIFIED', '/parallelism/worker_mode', 'Managed activation/admission runtime is deferred to S2+');
  }
  if (!policy) block('OG_CONFIG_REFERENCE', '/defaults/workerSelection', 'Current merged worker policy is required');
  const catalogErrors = validateWorkerCatalogDiscovery(snapshot.catalog.discovery);
  if (catalogErrors.length) block('OG_ADAPTER_UNQUALIFIED', '/catalog/discovery', catalogErrors.join('; '));
  if (plan.diagnostics.length || !policy) return plan;
  const policyShape = WorkerSelectionPolicySchema.safeParse(policy);
  if (!policyShape.success) {
    block('OG_CONFIG_REFERENCE', '/defaults/workerSelection', policyShape.error.message);
    return plan;
  }
  for (const message of validateWorkerGroupReferences(parallelism, policy)) block('OG_CONFIG_REFERENCE', '/parallelism', message);
  if (plan.diagnostics.length) return plan;
  parallelism = resolveParallelism(parallelism, snapshot.config.providers?.[0]);
  const ceilingLayers = [parallelism.budgets?.perRun, parallelism.budgets?.perTask,
    { maxAttempts: parallelism.retry?.maxAttempts ?? 3 }, snapshot.constraints?.ceilings, request.ceilings];
  for (const key of ['tokens', 'costUsd', 'wallSeconds', 'maxAttempts'] as const) {
    const values = ceilingLayers.map(layer => (layer as WorkerResolutionCeilings | undefined)?.[key]).filter((value): value is number => value !== undefined);
    if (values.some(value => !Number.isFinite(value) || value < 0 || key !== 'costUsd' && !Number.isSafeInteger(value))) {
      block('OG_CONFIG_REFERENCE', `/request/ceilings/${key}`, 'Ceilings must be finite nonnegative values; counts must be integers');
    } else if (values.length) plan.ceilings[key] = Math.min(...values);
  }
  if (plan.ceilings.maxAttempts === 0) block('OG_BUDGET_UNMEASURABLE', '/request/ceilings/maxAttempts', 'No task attempts remain');
  const qualifiedRoles: Record<string, string[]> = {};
  for (const [groupId, group] of Object.entries(parallelism.groups ?? {})) {
    for (const member of group.members) {
      const observed = findWorkerModelRow(snapshot.catalog.discovery?.instances?.[member.cli]?.models, member.model)?.worker;
      qualifiedRoles[`${groupId}/${member.id}`] = observed?.qualification.status === 'qualified'
        ? observed.qualification.roles.filter(role => policy.roleGuidance?.[role]?.groups.includes(groupId)) : [];
    }
  }
  plan.diagnostics.push(...validateWorkerGroupQualifications(parallelism, qualifiedRoles).map(diagnostic => ({
    ...diagnostic, message: `${diagnostic.message}. Run aiwg doctor --probe-workers --qualify.`,
  })));
  const taskRole = request.taskClass ? policy.taskClasses?.[request.taskClass] : undefined;
  const role = request.role ?? taskRole;
  plan.role = role ?? null;
  if (request.taskClass && (!taskRole || request.role && taskRole !== request.role)) block('OG_CONFIG_REFERENCE', '/request/taskClass', 'Unknown task class or conflicting role');
  const guidance = role ? policy.roleGuidance?.[role] : undefined;
  if (!role || !guidance) block('OG_CONFIG_REFERENCE', '/defaults/workerSelection/roleGuidance', 'Requested role has no guidance');
  if (request.member && !request.group) block('OG_CONFIG_REFERENCE', '/request/member', 'Group-local member pins require a group');
  if (request.group && !guidance?.groups.includes(request.group)) block('OG_CONFIG_REFERENCE', '/request/group', 'Group is outside role guidance');
  if ([request.maxParallel, snapshot.constraints?.maxParallel].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) block('OG_CONFIG_REFERENCE', '/request/maxParallel', 'Capacity ceilings must be nonnegative integers');
  if (request.requireDifferentFamily && (!request.reviewOf || validateWorkerModelObservation(request.reviewOf).length
    || hasSelectionRelevantConflicts(request.reviewOf) || !request.reviewOf.family || request.reviewOf.family === 'unknown')) {
    block('OG_MODEL_UNAPPROVED', '/request/reviewOf', 'Required review needs unambiguous observed source lineage');
  }
  if (plan.diagnostics.length || !role || !guidance) return plan;
  const wrapperPin = snapshot.models.agentOverrides[MODEL_WRAPPERS[role as keyof typeof MODEL_WRAPPERS]]?.['model-override'];
  const groups = request.group ? [request.group] : guidance.groups;
  for (const groupId of groups) {
    const group = parallelism.groups![groupId];
    const permissions = { ...group.execution, transport: group.execution?.transport ?? 'shell' };
    const transport = permissions.transport;
    // Priority is guidance only. Preserve declaration order for ties; fallback order stays explicit.
    const members = group.members.map((member, index) => ({ member, index })).sort((a, b) =>
      (a.member.priority ?? 100) - (b.member.priority ?? 100) || a.index - b.index);
    for (const { member } of members) {
      const binding = snapshot.installations[member.cli];
      const discovery = snapshot.catalog.discovery?.instances?.[member.cli];
      const row = findWorkerModelRow(discovery?.models, member.model);
      const observation = row?.worker;
      const efforts = request.effort !== undefined ? [request.effort]
        : [...new Set([guidance.initialEffort, ...guidance.effortLadder])];
      for (const effort of efforts) {
        const tuple = { group: groupId, member: member.id, model: member.model, effort };
        const reasons: WorkerPolicyDiagnostic[] = [];
        const deny = (code: WorkerPolicyDiagnostic['code'], pointer: string, message: string): void => { reasons.push(diagnostic(code, pointer, message)); };
        const pointer = `/parallelism/groups/${groupId}/members/${member.id}`;
        if (request.transport !== undefined && request.transport !== transport) deny('OG_POLICY_RELAXATION', '/request/transport', 'Requested transport differs from resolved group permissions');
        if (member.enabled === false || parallelism.clis?.[member.cli]?.enabled === false) deny('OG_CONFIG_REFERENCE', pointer, 'Member or installation is disabled');
        if (!member.roles.includes(role as 'coding' | 'reasoning' | 'efficiency')) deny('OG_CONFIG_REFERENCE', pointer, 'Member does not cover requested role');
        const pinMismatch = request.member && request.member !== member.id || request.model && request.model !== member.model || wrapperPin && wrapperPin !== member.model;
        const substitution = request.substitution && matchesChoice(tuple, request.substitution) && request.substitution.rationale.trim();
        if (pinMismatch && !substitution) deny('OG_PIN_MISMATCH', pointer, 'Exact request or wrapper pin requires explicit substitution');
        if (!observation || !binding || !row?.llmProvider || !row.apiModelId) deny('OG_ADAPTER_UNQUALIFIED', pointer, 'Missing exact model, inference provider, observation or current installation evidence. Run aiwg doctor --probe-workers --qualify.');
        if (observation && binding && row?.llmProvider && row.apiModelId) {
          const shapeErrors = validateWorkerModelObservation(observation);
          if (shapeErrors.length) {
            deny('OG_ADAPTER_UNQUALIFIED', '/worker', shapeErrors.join('; '));
            plan.exclusions.push({ ...tuple, diagnostics: reasons });
            continue;
          }
          if (observation.cliId !== member.cli || observation.runtimeVersion !== binding.cliVersion
            || observation.accountScope !== binding.accountScope || observation.endpointFingerprint !== binding.endpointFingerprint
            || discovery?.accountBinding !== binding.accountScope || discovery?.runtimeVersion !== binding.cliVersion
            || parallelism.clis?.[member.cli]?.accountScope && parallelism.clis[member.cli].accountScope !== binding.accountScope) {
            deny('OG_ADAPTER_UNQUALIFIED', pointer, 'Catalog and current installation scope differ');
          }
          reasons.push(...validateWorkerPolicyRoute({ policy, role, inferenceProvider: row.llmProvider, apiModelId: row.apiModelId,
            selectedModel: member.model, effort, identityEvidence: binding.identityEvidence, observation,
            wrapperPin, ...(substitution ? { substitution: request.substitution } : {}), dataClass: request.dataClass, now, context: request.context }));
          if (request.requireDifferentFamily && (observation.family === 'unknown' || observation.family === request.reviewOf!.family)) deny('OG_MODEL_UNAPPROVED', '/worker/family', 'Required review must use a different observed family');
          try {
            const { adapter } = resolveWorkerGroupInstallation(parallelism, member.cli, snapshot.registry);
            const configuredProfile = parallelism.clis?.[member.cli]?.invocationProfile;
            if (configuredProfile && configuredProfile !== binding.profile) throw new Error('Configured invocation profile changed');
            const configuredServer = parallelism.clis?.[member.cli]?.mcpServerRef;
            if (transport === 'mcp' && configuredServer && configuredServer !== binding.mcp?.serverRef) throw new Error('Configured MCP server changed');
            if (!hasOperatorWorkerNativeRenderer(adapter) && (adapter.capabilities.modelPin === 'unsupported' || !adapter.capabilities.nativeFallbackControllable)) throw new Error('Exact model or fallback control is unqualified; qualify an adapter with these controls');
            if (policy.guards?.denySelfDelegation !== false && !adapter.capabilities.nestedAgentsControllable) throw new Error('Child-agent control is unqualified. Review models.json defaults.workerSelection.guards.denySelfDelegation; false permits uncontrolled child agents without qualifying their behavior.');
            if (binding.identityEvidence === 'backend-attested' && adapter.capabilities.modelPin !== 'observed') throw new Error('Requested-only mapping cannot attest backend identity');
            if (!hasOperatorWorkerNativeRenderer(adapter) && group.execution?.sandbox && !adapter.capabilities.sandboxModes.includes(group.execution.sandbox)) throw new Error('Requested sandbox mode is unqualified');
            qualifyWorkerInvocationProfile(adapter, { profile: binding.profile, transport, cliVersion: binding.cliVersion,
              policy, permissions, effort, boundary: binding.boundary,
              requiredControls: request.requiredControls, mcp: binding.mcp });
            const { maxAttempts: _maxAttempts, ...budgetLimits } = plan.ceilings;
            const budgetDimensions = { tokens: 'tokens', cost: 'costUsd', 'wall-time': 'wallSeconds' } as const;
            const enforceable = adapter.capabilities.hardBudget.map(key => budgetDimensions[key as keyof typeof budgetDimensions]);
            for (const message of validateWorkerBudgetEnforcement({ ...parallelism.budgets, perTask: budgetLimits }, enforceable)) deny('OG_BUDGET_UNMEASURABLE', '/parallelism/budgets', message);
          } catch (error) { deny('OG_ADAPTER_UNQUALIFIED', pointer, String(error)); }
          let key: string;
          try { key = workerModelKey(row.llmProvider, row.apiModelId); }
          catch { plan.exclusions.push({ ...tuple, diagnostics: reasons }); continue; }
          if (snapshot.constraints?.revokedModels?.includes(key)) deny('OG_MODEL_UNAPPROVED', '/constraints/revokedModels', 'Current model revocation');
          if (snapshot.constraints?.unavailableMembers?.includes(`${groupId}/${member.id}`)) deny('OG_ADAPTER_UNQUALIFIED', pointer, 'Member is currently unavailable');
          const premium = ['premium', 'max-quality'].includes(guidance.tier) || observation.pricing.costClass === 'premium';
          // Worker candidates always invoke a model; deterministic/routine hints must not bypass premium authority.
          const authority = routeModelTier({ ...request.authority, deterministic: false, routine: false,
            defaultTier: guidance.tier === 'economy' ? 1 : 2, requestedPremium: premium || request.authority?.requestedPremium });
          if (authority.requiresConfirmation) deny('OG_MODEL_UNAPPROVED', '/request/authority', `${authority.rationale.join('; ')}; agents may pass --authorize-premium only after the human explicitly confirmed the premium escalation (escalation-discipline rule)`);
          const installation = parallelism.clis?.[member.cli];
          const caps = [parallelism.max_parallel_subagents, group.maxParallel, parallelism.admission?.groupCaps?.[groupId],
            parallelism.admission?.memberCaps?.[`${groupId}/${member.id}`], parallelism.admission?.cliCaps?.[member.cli],
            parallelism.admission?.modelCaps?.[key], installation && parallelism.admission?.quotaCaps?.[installation.quotaScope],
            snapshot.constraints?.maxParallel, request.maxParallel].filter((value): value is number => value !== undefined);
          const effectiveMaxParallel = caps.length ? Math.min(...caps) : null;
          if (effectiveMaxParallel === 0) deny('OG_ADAPTER_UNQUALIFIED', '/constraints/maxParallel', 'Current capacity ceiling is zero');
          if (!reasons.some(reason => reason.blocking !== false)) plan.eligible.push({ ...tuple, cli: member.cli,
            inferenceProvider: row.llmProvider, modelKey: key, family: observation.family, identityEvidence: binding.identityEvidence,
            profile: binding.profile, transport,
            permissions: structuredClone(permissions), context: workerContextHeadroom(request.context, observation),
            observedAt: observation.observedAt, verifiedAt: observation.verifiedAt, observationRef: observation.recordId,
            effectiveMaxParallel, diagnostics: reasons });
        }
        if (reasons.some(reason => reason.blocking !== false)) plan.exclusions.push({ ...tuple, diagnostics: reasons });
      }
    }
  }
  if (request.choice) {
    if (!request.choice.rationale.trim()) block('OG_CONFIG_REFERENCE', '/request/choice/rationale', 'Conductor choice requires a rationale');
    plan.selected = plan.eligible.find(tuple => matchesChoice(tuple, request.choice!)) ?? null;
    if (!plan.selected) block('OG_MODEL_UNAPPROVED', '/request/choice', 'Conductor choice is outside the eligible set');
  } else plan.selected = plan.eligible[0] ?? null;
  if (plan.diagnostics.length) plan.selected = null;
  if (plan.selected) {
    plan.status = 'eligible';
    plan.choice = { source: request.choice ? 'conductor' : 'default', rationale: request.choice?.rationale ?? 'Role group order, member priority/declaration order, then qualified effort ladder',
      ...(request.substitution && matchesChoice(plan.selected, request.substitution) ? { substitution: structuredClone(request.substitution) } : {}) };
  }
  plan.alternatives = plan.eligible.filter(tuple => tuple !== plan.selected);
  return plan;
}
