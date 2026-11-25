// Applies automatic tier ceilings and stable strategy ranking to qualified worker tuples.
import type { ModelTier, ModelRouteRequest, WorkerModelObservation, WorkerSelectionPolicy } from './types.js';
import { flagshipElected, isFlagshipModel, normalizeModelTier, TIER_ORDER } from './tiers.js';

/** Role authority is a floor; observed pricing and recognized flagship identities can raise it. */
export function workerSelectionTier(roleTier: ModelTier, model: string,
  pricing: WorkerModelObservation['pricing']): ModelTier {
  if (isFlagshipModel(model)) return 'flagship';
  const role = TIER_ORDER.indexOf(normalizeModelTier(roleTier));
  const observed = pricing.costClass === 'unknown' ? role : TIER_ORDER.indexOf(pricing.costClass);
  return TIER_ORDER[Math.max(role, observed)];
}

/** Pins and conductor choices alone never authorize exceeding an automatic ceiling. */
export function exceedsWorkerAutoTier(tier: ModelTier, policy: WorkerSelectionPolicy,
  authority: ModelRouteRequest = {}): boolean {
  if (policy.maxAutoTier === undefined) return false;
  const canonical = normalizeModelTier(tier);
  if (canonical === 'flagship' && flagshipElected(authority)) return false;
  if (canonical === 'premium' && authority.premiumAuthorized) return false;
  return TIER_ORDER.indexOf(canonical) > TIER_ORDER.indexOf(normalizeModelTier(policy.maxAutoTier));
}

/** Pricing class is a cost/quality proxy, never a measured quality claim or dollar estimate. */
export function rankWorkerChoices<T>(choices: T[], strategy: WorkerSelectionPolicy['strategy'],
  pricing: (choice: T) => WorkerModelObservation['pricing'], roleTier: ModelTier): void {
  if (strategy === undefined || strategy === 'balanced') return;
  const score = (choice: T): number => {
    const cost = pricing(choice).costClass;
    return TIER_ORDER.indexOf(cost === 'unknown' ? normalizeModelTier(roleTier) : cost);
  };
  choices.sort((left, right) => (strategy === 'quality' ? -1 : 1) * (score(left) - score(right)));
}
