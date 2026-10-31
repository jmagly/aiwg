import path from 'node:path';
import { homedir } from 'node:os';
import { resolveHermesHomePath } from '../providers/hermes-home.js';
import { resolveOmpPaths } from '../providers/omp-paths.mjs';
import type { Platform } from '../agents/types.js';
import {
  PROVIDER_IDS,
  getProviderDefinition,
  getProviderArtifactPathStrings,
  resolveProviderPathValue,
  type ProviderContextContract,
  type ProviderDefinition,
} from '../providers/provider-definitions.js';
import { deployedSkillRoots } from '../providers/deployed-skill-roots.js';
import { resolveMuseXdgSkillsDir } from '../providers/muse-paths.js';
import { grokBuildUserPaths, resolveGrokHome } from '../providers/grok-build-paths.js';
import type { MemoryObservation } from './taxonomy.js';

export type ProviderMemoryDisposition = Exclude<MemoryObservation['status'], 'unknown'>;
export type ProviderSessionEffect = 'current' | 'next-session' | 'unknown';
export type ProviderMemoryOperation = 'promote' | 'demote' | 'recategorize' | 'merge'
  | 'split' | 'supersede' | 'retire' | 'restore';

/** Evidence is supplied by an owner; adapters never inspect a filesystem or session. */
export interface ProviderMemoryItem {
  observation: Omit<MemoryObservation, 'status'> & { status: ProviderMemoryDisposition };
  visibility: 'static' | 'runtime' | 'hidden';
}

export interface ProviderMemorySize extends Omit<ProviderMemoryItem, 'observation'> {
  observation: MemoryObservation;
  kind: 'durable' | 'injected';
  bytes: number | null;
}

export type ProviderMemoryEstimate =
  | { bytes: null; confidence: 'unknown'; kind: ProviderMemorySize['kind'] }
  | { bytes: number; confidence: 'measured' | 'inferred'; kind: ProviderMemorySize['kind'] };

export type ProviderMaintenanceLimit =
  | 'canonical-edit-and-regenerate' | 'immutable-running-session' | 'opaque-system-content'
  | 'explicit-scope-selection' | 'authority-review-required' | 'imports-consume-startup-context'
  | 'runtime-truncation-and-restart' | 'no-general-precedence' | 'surface-and-enabled-state-required'
  | 'scope-limited-imports' | 'write-is-not-reload-proof' | 'external-connections-only'
  | 'durable-and-injected-sizes-separate' | 'no-verified-project-startup'
  | 'nearest-nonempty-context' | 'depth-ordered-include-deduplication'
  | 'configuration-registration-mutation' | 'always-apply-except-globs'
  | 'runtime-load-unobserved' | 'trust-gated-startup' | 'unknown-estimates' | 'distinct-native-memory-stores'
  | 'indexed-baseline-only';

export interface ProviderMemoryAdapter {
  providerId: Platform;
  /** Locators only. Enumeration neither reads roots nor grants selection of another scope. */
  memoryRoots(): string[];
  disposition(item: ProviderMemoryItem): ProviderMemoryDisposition;
  supports: { read: boolean; write: boolean; estimate: boolean; liveLoadVisibility: boolean };
  sessionEffect(op: ProviderMemoryOperation): ProviderSessionEffect;
  context: ProviderContextContract;
  limits: readonly ProviderMaintenanceLimit[];
  diagnostic: string | null;
  /** Classify supplied size evidence only; token/budget estimation belongs to its owner. */
  estimate(size: ProviderMemorySize): ProviderMemoryEstimate;
}

interface ProviderMemoryPolicy {
  limits: readonly ProviderMaintenanceLimit[];
  sessionEffect: Exclude<ProviderSessionEffect, 'current'>;
  liveLoadVisibility?: boolean;
}

const COMMON_LIMITS: readonly ProviderMaintenanceLimit[] = [
  'canonical-edit-and-regenerate', 'immutable-running-session', 'opaque-system-content',
  'explicit-scope-selection', 'authority-review-required',
];

// Deliberately exhaustive: a new provider needs a reviewed maintenance policy.
// Paths, ceilings, nesting and loading syntax remain owned by provider definitions.
const POLICIES: Record<Platform, ProviderMemoryPolicy> = {
  antigravity: { limits: ['runtime-load-unobserved'], sessionEffect: 'next-session' },
  claude: { limits: ['imports-consume-startup-context'], sessionEffect: 'next-session', liveLoadVisibility: true },
  codex: { limits: ['runtime-truncation-and-restart', 'runtime-load-unobserved'], sessionEffect: 'next-session' },
  copilot: { limits: ['no-general-precedence', 'surface-and-enabled-state-required', 'scope-limited-imports', 'runtime-load-unobserved'], sessionEffect: 'next-session' },
  cursor: { limits: ['always-apply-except-globs', 'runtime-load-unobserved'], sessionEffect: 'next-session' },
  'deepseek-harness': { limits: ['runtime-load-unobserved'], sessionEffect: 'next-session' },
  flue: { limits: ['runtime-load-unobserved'], sessionEffect: 'next-session' },
  factory: { limits: ['runtime-load-unobserved'], sessionEffect: 'next-session' },
  grokbot: { limits: ['runtime-load-unobserved'], sessionEffect: 'unknown' },
  'grok-build': { limits: ['runtime-load-unobserved'], sessionEffect: 'next-session' },
  hermes: { limits: ['write-is-not-reload-proof', 'external-connections-only', 'distinct-native-memory-stores'], sessionEffect: 'next-session' },
  muse: { limits: ['trust-gated-startup', 'runtime-load-unobserved'], sessionEffect: 'unknown' },
  opencode: { limits: ['configuration-registration-mutation', 'runtime-load-unobserved'], sessionEffect: 'next-session' },
  openclaw: { limits: ['durable-and-injected-sizes-separate', 'no-verified-project-startup'], sessionEffect: 'unknown', liveLoadVisibility: true },
  openhuman: { limits: ['runtime-load-unobserved'], sessionEffect: 'unknown' },
  pi: { limits: ['runtime-load-unobserved'], sessionEffect: 'next-session' },
  omp: { limits: ['nearest-nonempty-context', 'depth-ordered-include-deduplication', 'runtime-load-unobserved'], sessionEffect: 'next-session' },
  warp: { limits: ['runtime-load-unobserved'], sessionEffect: 'next-session' },
  windsurf: { limits: ['runtime-load-unobserved'], sessionEffect: 'next-session' },
  generic: { limits: ['indexed-baseline-only'], sessionEffect: 'unknown' },
};

function memoryRoots(definition: ProviderDefinition): string[] {
  if (definition.id === 'generic') return [];
  const { paths, context } = definition;
  const values: Array<string | null> = [
    ...Object.values(paths.artifacts), ...Object.values(paths.contextDiscovery),
    paths.kernelSkills, paths.contextFiles.contextFile, paths.contextFiles.hookFile,
    ...context.startupFiles, ...context.bootstrapTargets, context.configRegistration?.file ?? null,
    ...Object.values(getProviderArtifactPathStrings(definition.id) ?? {}),
    // The deployment helper has a Claude compatibility fallback when no kernel
    // root exists. That fallback is not this provider's memory surface.
    ...(paths.kernelSkills ? deployedSkillRoots('.', definition.id) : []),
    ...definition.surfaces.related
      .filter(surface => surface.relationship === 'same-provider' || surface.relationship === 'shared-adapter')
      .flatMap(surface => Object.values(surface.paths).flat()),
  ];
  if (context.includeSyntax) {
    for (const include of context.includeSyntax.split('\n')) {
      // A template such as @<relative-path> is syntax, not a concrete root.
      if (/^@[^<>\s]+$/.test(include)) values.push(include.slice(1));
    }
  }
  if (definition.skillNamespace.pathType === 'home-dir' && !['grokbot', 'hermes'].includes(definition.id)) {
    values.push(resolveProviderPathValue(`~/${definition.skillNamespace.skillsBaseDir}`, '.'));
  }
  if (definition.id === 'muse') values.push(resolveMuseXdgSkillsDir());
  if (definition.id === 'grok-build') {
    const home = resolveGrokHome();
    if (home) values.push(...Object.values(grokBuildUserPaths(home)));
  }
  // Native user stores absent from deployment paths. Keep these with the
  // adapter owner so audit never invents another provider path registry.
  if (definition.id === 'claude' || definition.id === 'codex') {
    const home = definition.id === 'claude'
      ? process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
      : process.env.CODEX_HOME || path.join(homedir(), '.codex');
    for (const value of Object.values(paths.artifacts)) {
      if (value?.startsWith(`.${definition.id}/`)) values.push(path.resolve(home, value.slice(definition.id.length + 2)));
    }
    values.push(path.resolve(home, definition.id === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'));
    if (definition.id === 'codex') values.push(path.resolve(home, 'AGENTS.override.md'));
    if (definition.id === 'claude') values.push(path.resolve(home, 'projects/*/memory'));
  }
  if (definition.id === 'hermes') values.push(resolveHermesHomePath('memories/MEMORY.md'), resolveHermesHomePath('memories/USER.md'));
  if (definition.id === 'omp') {
    const resolved = resolveOmpPaths();
    values.push(path.join(resolved.agentDir, 'AGENTS.md'), ...Object.values(resolved.resourceDirs));
  }
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function hasRuntimeEvidence(item: ProviderMemoryItem, providerId: Platform): boolean {
  const { evidence } = item.observation;
  return item.visibility === 'runtime' && Boolean(evidence.source && evidence.at
    && evidence.session && evidence.version && evidence.provider === providerId);
}

function createAdapter(definition: ProviderDefinition, policy: ProviderMemoryPolicy): ProviderMemoryAdapter {
  const supported = definition.context.support === 'supported';
  const native = definition.id !== 'generic';
  const adapter: ProviderMemoryAdapter = {
    providerId: definition.id,
    memoryRoots: () => memoryRoots(definition),
    disposition(item) {
      const { status } = item.observation;
      if (item.visibility === 'hidden' || status === 'opaque') return 'opaque';
      if (status === 'observed' && (!policy.liveLoadVisibility || !hasRuntimeEvidence(item, definition.id))) {
        return 'inferred';
      }
      return status;
    },
    supports: { read: native, write: native, estimate: supported, liveLoadVisibility: policy.liveLoadVisibility ?? false },
    sessionEffect: () => policy.sessionEffect,
    context: definition.context,
    limits: [...COMMON_LIMITS, ...policy.limits, ...(!supported ? ['unknown-estimates' as const] : [])],
    diagnostic: native ? null : 'No native memory surface is supported; use the indexed AIWG baseline.',
    estimate(size) {
      const unknown: ProviderMemoryEstimate = { bytes: null, confidence: 'unknown', kind: size.kind };
      if (size.observation.status === 'unknown') return unknown;
      const known = { ...size, observation: { ...size.observation, status: size.observation.status } };
      const disposition = adapter.disposition(known);
      if (!supported || !Number.isSafeInteger(size.bytes) || (size.bytes ?? -1) < 0
        || ['opaque', 'absent', 'inaccessible'].includes(disposition)) return unknown;
      if (size.kind === 'injected') {
        // A durable file's size cannot establish the amount injected into a session.
        if (disposition !== 'observed' || !hasRuntimeEvidence(known, definition.id)) return unknown;
        return { bytes: size.bytes as number, confidence: 'measured', kind: size.kind };
      }
      return { bytes: size.bytes as number, confidence: disposition === 'inferred' ? 'inferred' : 'measured', kind: size.kind };
    },
  };
  return adapter;
}

export const PROVIDER_MEMORY_ADAPTERS: ReadonlyMap<Platform, ProviderMemoryAdapter> = new Map(
  PROVIDER_IDS.map(providerId => {
    const definition = getProviderDefinition(providerId);
    const policy = POLICIES[providerId];
    if (!definition || !policy) throw new Error(`Missing memory adapter contract for ${providerId}`);
    return [providerId, createAdapter(definition, policy)];
  }),
);

/** Always checks coverage, including generic; never silently skips a missing adapter. */
export function listProviderMemoryAdapters(
  registry: ReadonlyMap<Platform, ProviderMemoryAdapter> = PROVIDER_MEMORY_ADAPTERS,
): ProviderMemoryAdapter[] {
  return PROVIDER_IDS.map(providerId => {
    const adapter = registry.get(providerId);
    if (!adapter || adapter.providerId !== providerId) throw new Error(`Missing memory adapter contract for ${providerId}`);
    return adapter;
  });
}
