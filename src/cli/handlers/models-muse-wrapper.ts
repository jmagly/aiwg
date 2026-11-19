// Resolve built-in Muse wrappers even when no source artifacts are deployed.
import { MODEL_WRAPPER_DEFINITIONS } from '../../models/wrapper-definitions.js';
import type { CanonicalModelPolicy, ModelTier } from '../../models/types.js';
import { loadProviderModelCatalog, type CompiledModelPolicy, type ProviderModelCatalog } from '../../models/catalog-policy.js';
import type { Artifact } from './models.js';
import { normalizeModelTier } from '../../models/tiers.js';

export function museWrapperArtifacts(artifacts: Artifact[], provider: string,
  parsed: { subcommand: string; flags: Map<string, string | boolean> }): Artifact[] {
  if (provider !== 'muse' || parsed.subcommand !== 'resolve') return artifacts;
  const wrapper = MODEL_WRAPPER_DEFINITIONS.find(item => item.name === parsed.flags.get('agent'));
  if (!wrapper) return artifacts;
  const existing = artifacts.find(item => item.kind === 'agent' && item.name === wrapper.name);
  const tier = parsed.flags.get('tier');
  // These virtual artifacts are used only by read-only resolve, never by set/migrate.
  return [...artifacts.filter(item => item.kind !== 'agent' || item.name !== wrapper.name), {
    ...existing, kind: 'agent', name: wrapper.name, file: existing?.file ?? '',
    relative: existing?.relative ?? 'built-in model wrapper',
    role: existing?.role ?? wrapper.role,
    tier: typeof tier === 'string' ? tier as ModelTier : existing?.tier ?? wrapper.tier,
    effort: existing?.effort ?? wrapper.effort,
  }];
}

export function museWrapperCompilation(item: Artifact, compiled: CompiledModelPolicy,
  policy: CanonicalModelPolicy, catalog: ProviderModelCatalog = loadProviderModelCatalog()): CompiledModelPolicy {
  if (compiled.provider !== 'muse' || item.kind !== 'agent'
    || !MODEL_WRAPPER_DEFINITIONS.some(wrapper => wrapper.name === item.name)) return compiled;
  const provider = catalog.providers.muse!;
  const tier = normalizeModelTier(policy.tier);
  const role = policy.tier === 'economy' ? 'efficiency' : policy.tier === 'premium' ? 'reasoning' : policy.role;
  // Report the session model candidate while retaining unsupported agent controls and empty fields.
  return { ...compiled, effectiveModel: (provider.tiers?.[tier] ?? provider.roles[role]).id };
}
