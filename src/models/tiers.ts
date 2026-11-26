// Canonical tier names and the shared user-election boundary for flagship models.
import type { ModelTier } from './types.js';

export type CanonicalModelTier = Exclude<ModelTier, 'max-quality'>;
export const MODEL_TIERS = ['economy', 'standard', 'premium', 'flagship', 'max-quality'] as const;
export const TIER_ORDER: CanonicalModelTier[] = ['economy', 'standard', 'premium', 'flagship'];
export function parseWorkerTier(value: string | undefined): ModelTier | undefined {
  if (value === undefined) return undefined;
  if (!(MODEL_TIERS as readonly string[]).includes(value)) throw new Error(`Invalid --worker-tier: ${value}`);
  return value as ModelTier;
}
export function normalizeModelTier(tier: ModelTier): CanonicalModelTier {
  return tier === 'max-quality' ? 'flagship' : tier;
}

export interface FlagshipAuthority {
  election?: 'user';
  /** Exact capability/agent names from the caller's delegation configuration. */
  flagshipAllowlist?: readonly string[];
  agentName?: string;
}
export function flagshipElected(request: FlagshipAuthority): boolean {
  return request.election === 'user'
    || Boolean(request.agentName && request.flagshipAllowlist?.includes(request.agentName));
}
export function isFlagshipModel(id: string): boolean {
  return /(?:^|[/:._-])(?:fable|astra)(?:$|[/:._\[\]-]|\d)/i.test(id);
}
