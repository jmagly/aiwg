// Public provider registry facade; declarations and built-in data live in focused modules.
import { homedir } from 'os';
import { isAbsolute, join } from 'path';
import type { Platform } from '../agents/types.js';
import { resolveGrokbotSkillsDir } from './grokbot-paths.js';
import { getProviderCapabilities } from './capability-matrix.js';
import { ProviderDefinitionSchema, type ProviderDefinition, type BuiltInSeed, type ProviderArtifactPathStrings, type ProviderContextDiscoveryPathStrings } from './provider-definition-schema.js';
export type * from './provider-definition-schema.js';
import { CONTEXT_CONTRACTS } from './provider-context-contracts.js';
import { BUILT_IN_SEEDS_1 } from './provider-seeds-1.js';
import { BUILT_IN_SEEDS_2 } from './provider-seeds-2.js';
import { BUILT_IN_SEEDS_3 } from './provider-seeds-3.js';

export const PROVIDER_IDS: readonly Platform[] = [
  'antigravity',
  'claude',
  'codex',
  'copilot',
  'cursor',
  'deepseek-harness',
  'factory',
  'flue',
  'grokbot',
  'grok-build',
  'hermes',
  'muse',
  'opencode',
  'openclaw',
  'openhuman',
  'pi',
  'omp',
  'warp',
  'windsurf',
  'generic',
];

const BUILT_IN_SEEDS: BuiltInSeed[] = [...BUILT_IN_SEEDS_1, ...BUILT_IN_SEEDS_2, ...BUILT_IN_SEEDS_3];

let cachedRegistry: Map<Platform, ProviderDefinition> | null = null;

function buildDefinition(seed: BuiltInSeed): ProviderDefinition {
  const capabilities = seed.matrixRef ? getProviderCapabilities(seed.matrixRef) : undefined;
  const contextDiscovery = seed.paths.contextDiscovery ?? {
    agents: seed.paths.artifacts.agents,
    skills: seed.paths.artifacts.skills,
    rules: seed.paths.artifacts.rules,
    behaviors: null,
  };
  const definition: ProviderDefinition = {
    ...seed,
    displayName: seed.displayName ?? capabilities?.display_name ?? seed.id,
    status: seed.status ?? capabilities?.status ?? 'experimental',
    paths: {
      ...seed.paths,
      deployTarget: seed.paths.deployTarget ?? capabilities?.deploy_target ?? 'project',
      contextDiscovery,
    },
    context: CONTEXT_CONTRACTS[seed.id],
    capabilities: {
      matrixRef: seed.matrixRef,
      nativeFeatures: capabilities?.native_features ?? {},
      emulation: capabilities?.emulation ?? {},
    },
  };
  return ProviderDefinitionSchema.parse(definition);
}

function assertNoDuplicateAliases(definitions: ProviderDefinition[]): void {
  const seen = new Map<string, Platform>();
  for (const definition of definitions) {
    for (const candidate of [definition.id, ...definition.aliases]) {
      const normalized = candidate.toLowerCase();
      const existing = seen.get(normalized);
      if (existing && existing !== definition.id) {
        throw new Error(`Provider alias "${candidate}" is declared by both ${existing} and ${definition.id}`);
      }
      seen.set(normalized, definition.id);
    }
  }
}

export function listProviderDefinitions(): ProviderDefinition[] {
  if (!cachedRegistry) {
    const definitions = BUILT_IN_SEEDS.map(buildDefinition);
    assertNoDuplicateAliases(definitions);
    cachedRegistry = new Map(definitions.map((definition) => [definition.id, definition]));
  }
  return PROVIDER_IDS.map((id) => {
    const definition = cachedRegistry?.get(id);
    if (!definition) throw new Error(`Missing provider definition for ${id}`);
    return definition;
  });
}

export function loadProviderDefinitionRegistry(): ReadonlyMap<Platform, ProviderDefinition> {
  listProviderDefinitions();
  return cachedRegistry as ReadonlyMap<Platform, ProviderDefinition>;
}

export function getProviderDefinition(provider: string | null | undefined): ProviderDefinition | undefined {
  const normalized = normalizeProviderDefinitionId(provider);
  if (!normalized) return undefined;
  return loadProviderDefinitionRegistry().get(normalized);
}

export function expandProviderHomePath(providerPath: string | null): string {
  if (!providerPath) return '';
  if (providerPath === '~') return homedir();
  if (providerPath.startsWith('~/')) return join(homedir(), providerPath.slice(2));
  return providerPath;
}

export function getProviderArtifactPathStrings(provider: string | null | undefined): ProviderArtifactPathStrings | undefined {
  const definition = getProviderDefinition(provider);
  if (!definition) return undefined;
  const normalized = normalizeProviderDefinitionId(provider);
  // Grok Bot skills are env-gated (AIWG_GROKBOT_SKILLS_DIR). Resolve dynamically so
  // deploy counting / user-scope same-path inventory can see the configured root
  // without inventing ~/.grokbot (#210).
  let skills = expandProviderHomePath(definition.paths.artifacts.skills);
  if (normalized === 'grokbot' && !skills) {
    skills = resolveGrokbotSkillsDir() ?? '';
  }
  return {
    agents: expandProviderHomePath(definition.paths.artifacts.agents),
    commands: expandProviderHomePath(definition.paths.artifacts.commands),
    skills,
    rules: expandProviderHomePath(definition.paths.artifacts.rules),
    behaviors: expandProviderHomePath(definition.paths.artifacts.behaviors),
  };
}

export function getProviderContextDiscoveryPathStrings(
  provider: string | null | undefined
): ProviderContextDiscoveryPathStrings | undefined {
  const definition = getProviderDefinition(provider);
  if (!definition) return undefined;
  return {
    agents: expandProviderHomePath(definition.paths.contextDiscovery.agents),
    skills: expandProviderHomePath(definition.paths.contextDiscovery.skills),
    rules: expandProviderHomePath(definition.paths.contextDiscovery.rules),
    behaviors: expandProviderHomePath(definition.paths.contextDiscovery.behaviors),
  };
}

export function getProviderKernelSkillPath(provider: string | null | undefined): string {
  const definition = getProviderDefinition(provider);
  return expandProviderHomePath(definition?.paths.kernelSkills ?? null);
}

export function resolveProviderPathValue(providerPath: string | null, projectPath: string,
  paths: Pick<typeof import('node:path'), 'join' | 'isAbsolute'> = { join, isAbsolute },
  homeDirectory = homedir()): string {
  const expandedPath = !providerPath ? '' : providerPath === '~' ? homeDirectory
    : providerPath.startsWith('~/') ? paths.join(homeDirectory, providerPath.slice(2)) : providerPath;
  if (!expandedPath) return '';
  if (paths.isAbsolute(expandedPath)) return expandedPath;
  return paths.join(projectPath, expandedPath);
}

export function normalizeProviderDefinitionId(provider: string | null | undefined): Platform | null {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return null;
  for (const definition of listProviderDefinitions()) {
    if (definition.id === normalized || definition.aliases.includes(normalized)) return definition.id;
  }
  return null;
}

export function validateProviderDefinitionRegistry(): ProviderDefinition[] {
  return listProviderDefinitions();
}
