/**
 * Provider-neutral model-tier routing primitive.
 *
 * This is deliberately a policy decision helper, not a provider switcher.
 * Callers use it to decide whether a task stays on the current/default
 * model, escalates to a capable work tier, or requires explicit premium
 * confirmation before routing.
 *
 * @implements #1185
 */

import type {
  ModelRouteDecision,
  ModelRouteRequest,
  MergedModelConfig,
  ModelTier,
  RuntimeModelTier,
} from './types.js';

import { flagshipElected, normalizeModelTier } from './tiers.js';
import { resolveDelegationDefaults } from './delegation-defaults.js';

const RUNTIME_TO_MODEL_TIER: Record<RuntimeModelTier, ModelTier | null> = {
  0: null,
  1: 'economy',
  2: 'standard',
  3: 'premium',
  4: 'flagship',
};

function clampRuntimeTier(tier: RuntimeModelTier | undefined, fallback: RuntimeModelTier): RuntimeModelTier {
  return tier === 0 || tier === 1 || tier === 2 || tier === 3 || tier === 4 ? tier : fallback;
}

const runtimeTier = (tier: ModelTier): RuntimeModelTier =>
  ({ economy: 1, standard: 2, premium: 3, flagship: 4 } as const)[normalizeModelTier(tier)];

/** Read merged policy for callers without an already-loaded model configuration. */
export async function resolveModelTier(request: ModelRouteRequest = {}, cwd?: string): Promise<ModelRouteDecision> {
  const { ConfigLoader } = await import('./config-loader.js');
  return routeModelTier(request, await new ConfigLoader(cwd).load());
}

/** Pure routing/authorization helper; pass ConfigLoader's result to honor user/project policy. */
export function routeModelTier(request: ModelRouteRequest = {}, models?: MergedModelConfig): ModelRouteDecision {
  const defaults = resolveDelegationDefaults({ workerId: request.agentName, task: request.task,
    role: request.role ?? (request.routine && !request.task ? 'efficiency' : undefined) }, models);
  const defaultTier = clampRuntimeTier(request.defaultTier, runtimeTier(defaults.tier));
  const maxAutoTier = clampRuntimeTier(request.maxAutoTier, runtimeTier(defaults.ceiling));

  let tier: RuntimeModelTier = defaultTier;
  let source: ModelRouteDecision['source'] = 'default';
  const rationale: string[] = request.defaultTier === undefined
    ? [`${defaults.strategy} worker policy; ${defaults.role} role; automatic ceiling ${defaults.ceiling}`] : [];

  if (request.deterministic) {
    tier = 0;
    source = 'deterministic';
    rationale.push('deterministic tool/cache/existing answer is sufficient');
  } else if (request.requestedTier) {
    tier = ({ economy: 1, standard: 2, premium: 3, flagship: 4 } as const)[normalizeModelTier(request.requestedTier)];
    source = 'request';
    rationale.push('explicit tier request');
  } else if (request.requestedPremium) {
    tier = 3;
    source = 'request';
    rationale.push('premium tier was explicitly requested');
  } else if (request.highImpact) {
    tier = 3;
    source = 'impact';
    rationale.push('high-impact domain requires supervised premium routing');
  } else if (request.complex) {
    tier = Math.max(defaultTier, 2) as RuntimeModelTier;
    source = 'complexity';
    rationale.push('complex or multi-step work needs a capable work tier');
  } else if (request.routine) {
    tier = request.defaultTier === undefined ? defaultTier : Math.min(defaultTier, 1) as RuntimeModelTier;
    source = 'default';
    rationale.push('routine work stays at the default/cheap tier');
  } else {
    rationale.push('no escalation signal present');
  }

  const elected = flagshipElected(request);
  if (tier === 4 && !elected) {
    tier = 3;
    source = 'policy';
    rationale.push('flagship is user-elected only; capped at premium');
  }

  const requiresConfirmation = tier === 4 ? false : (tier === 3 && !request.premiumAuthorized) || tier > maxAutoTier;
  if (requiresConfirmation) {
    rationale.push(
      tier === 3
        ? 'Tier 3 requires explicit human confirmation'
        : `policy permits auto-routing only through Tier ${maxAutoTier}`,
    );
  }

  const summaryRequired = tier > defaultTier;

  return {
    tier,
    modelTier: RUNTIME_TO_MODEL_TIER[tier],
    requiresConfirmation,
    summaryRequired,
    source: requiresConfirmation && tier > maxAutoTier ? 'policy' : source,
    rationale,
  };
}
