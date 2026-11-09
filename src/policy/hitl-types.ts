// Defines bounded HITL grants and trusted resolver inputs, separate from RBAC.
export const HITL_CATEGORIES = ['repo.read', 'repo.edit', 'docs.edit', 'test.run', 'testnet.configure'] as const;
export const HITL_ENVIRONMENTS = ['local', 'development', 'test', 'testnet'] as const;
export type HitlImpact = 'low' | 'medium' | 'high';
export interface HitlProfile {
  categories: Array<typeof HITL_CATEGORIES[number]>;
  repos: string[];
  environments: Array<typeof HITL_ENVIRONMENTS[number]>;
  resources: string[];
  reversible: true;
  maxImpact: 'low' | 'medium';
  expiresAt: string;
}
export interface HitlSelector {
  categories?: string[];
  repos?: string[];
  environments?: string[];
  resources?: string[];
}
export interface HitlPolicy {
  version: '1';
  enabled: boolean;
  reviewedAt: string;
  maxAgeSeconds: number;
  expiresAt: string;
  profiles: Record<string, HitlProfile>;
  deny: HitlSelector[];
  requireReview: HitlSelector[];
}
export interface HitlAction {
  category: string;
  repo: string;
  environment: string;
  /** Canonical repo-relative paths; caller must resolve symlinks before describing effects. */
  resources: string[];
  reversible: boolean;
  impact: HitlImpact;
  /** Host identity and SHA-256 of the exact proposed tool input; required for repo.edit. */
  actor?: string;
  inputDigest?: string;
  /** Exact host-classified target and verb; defaults are repo:<repo> and category's final component. */
  target?: string;
  verb?: string;
}
export interface HitlLayer {
  /** Trusted config origin, never issue or model-authored text. Outermost first. */
  source: string;
  policy?: HitlPolicy;
}
export interface HitlContext {
  now: string;
  layers: HitlLayer[];
  expectedPolicyVersion?: string;
  platform?: 'deny' | 'escalate';
  /** Populated only by the host from a direct user instruction, never action-file data. */
  sessionAuthorization?: { source: 'session-user'; profile: HitlProfile };
  /** Verified host snapshot, refreshed from the ledger for every check and consumption. */
  durableAuthorization?: import('./hitl-durable.js').DurableAuthorization;
}
export interface HitlResolution {
  decision: 'auto-authorized' | 'escalate' | 'deny';
  reason: string;
  /** Content digest binds all effective policy layers, including revocations. */
  policyVersion: string;
  matchedProfile: string | null;
  provenance: 'platform' | 'explicit-deny' | 'session-user' | 'durable-user' | 'project-policy' | 'default';
  authorizationGrant?: { grantId: string; effectId: string; recordHash: string };
  nearestGrant?: { grantId: string; fields: string[] };
  /** Earliest expiration of the effective grant, fixed when the receipt is issued. */
  expiresAt?: string;
}
