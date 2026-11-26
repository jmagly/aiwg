// Shared tier defaults for native delegation and the synchronous policy router.
import type { MergedModelConfig, ModelRole, ModelTier } from './types.js';
import { DEFAULT_WORKER_SELECTION, ownWorkerRoleGuidance } from './worker-selection-policy.js';
import { normalizeModelTier, TIER_ORDER } from './tiers.js';

export interface DelegationDefaultsRequest {
  workerId?: string;
  role?: string;
  task?: string;
  requestedTier?: ModelTier;
}

const roleTiers = { efficiency: 'economy', coding: 'standard', reasoning: 'premium' } as const;
export { roleTiers };

/** ConfigLoader owns builtin → user → project merging; never merge policy ad hoc here. */
export function resolveDelegationDefaults(request: DelegationDefaultsRequest, config?: MergedModelConfig) {
  const policy = config?.defaults.workerSelection ?? DEFAULT_WORKER_SELECTION;
  if (request.task && !policy.taskClasses?.[request.task]) throw new Error(`Unknown worker task class: ${request.task}`);
  const assignments = Object.values(config?.agentRoleAssignments ?? {});
  const matches = assignments.filter(entry => entry.agents.includes(request.workerId ?? ''));
  const role = request.role ?? (request.task ? policy.taskClasses?.[request.task] : undefined)
    ?? matches[0]?.defaultRole ?? (request.requestedTier === 'economy' ? 'efficiency' : 'coding');
  const guidance = ownWorkerRoleGuidance(policy, role);
  const baseRole = guidance?.baseRole ?? role;
  if (!Object.hasOwn(roleTiers, baseRole)) throw new Error(`Unknown worker role: ${role}`);
  let tier = normalizeModelTier(request.requestedTier ?? config?.agentOverrides[request.workerId ?? '']?.['model-tier']
    ?? guidance?.tier ?? roleTiers[baseRole as ModelRole]);
  for (const assignment of matches) {
    if (TIER_ORDER.indexOf(normalizeModelTier(assignment.minimumTier)) > TIER_ORDER.indexOf(tier)) tier = normalizeModelTier(assignment.minimumTier);
  }
  if (guidance && TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(normalizeModelTier(guidance.tier))) throw new Error('Requested worker tier is below role guidance');
  return { policy, role, baseRole: baseRole as ModelRole, tier,
    strategy: policy.strategy ?? 'cost-effective', ceiling: policy.maxAutoTier ?? 'standard' };
}
