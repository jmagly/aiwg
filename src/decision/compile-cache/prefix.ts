import { providerPrefixKey } from './identity.js';
import type { ProviderPrefixEvidence, ProviderPrefixIdentity } from './types.js';

export type ProviderPrefixReport =
  | { kind: 'reported'; hit: boolean; cacheVersion: string; savedInputTokens: number | null; expiresAtEpochMs: number | null }
  | { kind: 'unsupported' }
  | { kind: 'bypass' }
  | { kind: 'unreported' };

/** Provider status is derived exclusively from an explicit report/capability declaration. */
export function providerPrefixEvidence(identity: ProviderPrefixIdentity, report: ProviderPrefixReport): ProviderPrefixEvidence {
  const base = { schemaVersion: 'decision-provider-prefix-evidence/v1' as const, identityDigest: providerPrefixKey(identity) };
  if (report.kind === 'reported') return { ...base, status: report.hit ? 'hit' : 'miss', source: 'provider-report',
    cacheVersion: report.cacheVersion, savedInputTokens: report.savedInputTokens, expiresAtEpochMs: report.expiresAtEpochMs };
  if (report.kind === 'unsupported') return { ...base, status: 'unsupported', source: 'documented-unsupported', cacheVersion: null, savedInputTokens: null, expiresAtEpochMs: null };
  if (report.kind === 'bypass') return { ...base, status: 'bypass', source: 'policy-bypass', cacheVersion: null, savedInputTokens: null, expiresAtEpochMs: null };
  return { ...base, status: 'unknown', source: 'unreported', cacheVersion: null, savedInputTokens: null, expiresAtEpochMs: null };
}
