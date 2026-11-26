// Resolves native orchestration workers through the existing merged tier policy.
import { ConfigLoader } from './config-loader.js';
import { loadProviderModelCatalog, type ModelPolicyProvider } from './catalog-policy.js';
import { buildWrapperRouteEnvelope } from './wrapper-route.js';
import { exceedsWorkerAutoTier } from './worker-tier-selection.js';
import { flagshipElected, isFlagshipModel, normalizeModelTier, parseWorkerTier, TIER_ORDER } from './tiers.js';
import { isConcreteWrapperModel } from './wrapper-enforcement.js';
import { DEFAULT_WORKER_SELECTION } from './worker-selection-policy.js';
import type { MergedModelConfig, ModelRole, ModelRouteRequest, ModelTier } from './types.js';

export interface DelegationRequest extends Pick<ModelRouteRequest, 'election' | 'premiumAuthorized'> {
  orchestrator: 'mission' | 'mc' | 'flow' | 'ralph' | 'team';
  workerId: string;
  assignment: string;
  provider: string;
  cwd?: string;
  role?: string;
  task?: string;
  requestedTier?: ModelTier;
  /** Exact operator pin; session defaults must never be passed here. */
  model?: string;
}

export interface DelegationRecord {
  version: 1;
  orchestrator: DelegationRequest['orchestrator'];
  workerId: string;
  role: string;
  requested_tier: ModelTier | null;
  resolved_tier: ModelTier;
  resolved_model: string;
  wrapper: string;
  strategy: 'cost-effective' | 'balanced' | 'quality';
  max_auto_tier: ModelTier | null;
  election: 'user' | null;
  warnings: string[];
}

export { parseWorkerTier } from './tiers.js';

const roleTiers = { efficiency: 'economy', coding: 'standard', reasoning: 'premium' } as const;

export async function resolveDelegation(request: DelegationRequest, models?: MergedModelConfig) {
  parseWorkerTier(request.requestedTier);
  const config = models ?? await new ConfigLoader(request.cwd).load();
  const policy = config.defaults.workerSelection ?? DEFAULT_WORKER_SELECTION;
  const provider = (request.provider === 'claude-code' ? 'claude' : request.provider === 'openai' ? 'codex' : request.provider) as ModelPolicyProvider;
  const catalog = loadProviderModelCatalog();
  const catalogProvider = catalog.providers[provider];
  if (!catalogProvider) throw new Error(`Worker tier selection is unavailable for provider ${request.provider}`);
  if (request.task && !policy.taskClasses?.[request.task]) throw new Error(`Unknown worker task class: ${request.task}`);
  const agentGuidance = Object.values(config.agentRoleAssignments ?? {}).find(entry => entry.agents.includes(request.workerId));
  const role = request.role ?? (request.task ? policy.taskClasses?.[request.task] : undefined) ?? agentGuidance?.defaultRole
    ?? (request.requestedTier === 'economy' ? 'efficiency' : 'coding');
  const guidance = policy.roleGuidance && Object.hasOwn(policy.roleGuidance, role) ? policy.roleGuidance[role] : undefined;
  const baseRole = guidance?.baseRole ?? role;
  if (!Object.hasOwn(roleTiers, baseRole)) throw new Error(`Unknown worker role: ${role}`);
  let tier = normalizeModelTier(request.requestedTier ?? config.agentOverrides[request.workerId]?.['model-tier']
    ?? guidance?.tier ?? roleTiers[baseRole as ModelRole]);
  for (const assignment of Object.values(config.agentRoleAssignments ?? {})) {
    if (assignment.agents.includes(request.workerId) && TIER_ORDER.indexOf(normalizeModelTier(assignment.minimumTier)) > TIER_ORDER.indexOf(tier)) tier = normalizeModelTier(assignment.minimumTier);
  }
  if (guidance && TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(normalizeModelTier(guidance.tier))) throw new Error('Requested worker tier is below role guidance');
  const ceiling = policy.maxAutoTier ?? 'standard';
  const override = config.agentOverrides[request.workerId]?.['model-override'];
  const definition = config.providers[provider];
  const inherited = definition && new ConfigLoader(request.cwd).resolveProviderInheritance(definition, config.providers);
  const mappedRole = config.tiers[tier]?.roleMapping[baseRole as ModelRole];
  const model = request.model ?? override ?? inherited?.tierOverrides?.[tier]?.[baseRole as ModelRole]
    ?? (mappedRole ? inherited?.models?.[mappedRole]?.default : undefined);
  const envelope = buildWrapperRouteEnvelope({
    provider, role: baseRole as ModelRole, requestedTier: tier, election: request.election,
    premiumAuthorized: request.premiumAuthorized, maxAutoTier: 3,
    agentName: request.workerId, modelOverride: model,
    capability: { id: request.workerId, name: request.workerId, type: 'agent',
      source: { path: 'src/models/delegation.ts', scope: 'packaged', provenance: 'corpus' } },
    assignment: request.assignment, launchMechanism: 'aiwg-mc',
  });
  // A native CLI can pin its session even when provider agent frontmatter cannot.
  const selected = envelope.model?.effectiveModel ?? request.model ?? override;
  if (!selected || !isConcreteWrapperModel(selected) || selected.startsWith('@')) throw new Error(`Worker requires a concrete model for ${provider}; supply an explicit model pin`);
  // A cheap tier label cannot disguise a recognized higher-tier model pin.
  let actualTier: ModelTier = isFlagshipModel(selected) ? 'flagship' : tier;
  const raise = (candidate: ModelTier, id: string | undefined) => {
    if (id && (selected === id || selected.endsWith(`/${id}`))
      && TIER_ORDER.indexOf(normalizeModelTier(candidate)) > TIER_ORDER.indexOf(normalizeModelTier(actualTier))) actualTier = candidate;
  };
  for (const [name, entry] of Object.entries(catalogProvider.tiers ?? {})) raise(name as ModelTier, entry.id);
  for (const [name, entry] of Object.entries(catalogProvider.roles)) raise(roleTiers[name as ModelRole], entry.id);
  for (const [name, entry] of Object.entries(inherited?.models ?? {})) {
    raise(roleTiers[name as ModelRole], entry.default);
    for (const alias of entry.aliases ?? []) raise(roleTiers[name as ModelRole], alias);
  }
  if (actualTier === 'flagship' && !flagshipElected(request)) throw new Error('Flagship workers require election: user');
  if (exceedsWorkerAutoTier(actualTier, { ...policy, maxAutoTier: ceiling }, request)) throw new Error(`Worker tier ${actualTier} exceeds defaults.workerSelection.maxAutoTier (${ceiling})`);
  if ((actualTier === 'premium' && !request.premiumAuthorized) || envelope.decision.requiresConfirmation) throw new Error('Worker tier requires explicit human authorization');
  const record: DelegationRecord = {
    version: 1, orchestrator: request.orchestrator, workerId: request.workerId, role,
    requested_tier: request.requestedTier ?? null, resolved_tier: actualTier, resolved_model: selected,
    wrapper: envelope.wrapper!, strategy: policy.strategy ?? 'cost-effective', max_auto_tier: ceiling,
    election: request.election ?? null, warnings: envelope.model!.diagnostics.map(item => item.message),
  };
  return { record, envelope };
}
