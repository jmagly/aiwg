// Provider definition types and runtime validation for the shared registry.
import { z } from 'zod';
import { integer, url } from '../schema/zod-validation.mjs';
import type { Platform } from '../agents/types.js';
import type { DeployTarget, ProviderStatus } from './capability-matrix.js';

export type ProviderSurface = {
  primary: string;
  compatibility: string[];
  precedence: string[];
  related: ProviderRelatedSurface[];
};

export type ProviderSurfaceRelationship = 'same-provider' | 'shared-adapter' | 'future-provider' | 'companion-standard';

export type ProviderSurfacePathMap = {
  rules: string[];
  skills: string[];
  agentsMd: string[];
  legacy: string[];
};

export type ProviderRelatedSurface = {
  id: string;
  displayName: string;
  relationship: ProviderSurfaceRelationship;
  deployable: boolean;
  aliases: string[];
  paths: ProviderSurfacePathMap;
  notes: string[];
};

export type ProviderDetection = {
  env: string[];
  process: string[];
  capabilityId: string;
  runtimeEnvPriority?: number;
};

export type ProviderArtifactPaths = Record<'agents' | 'commands' | 'skills' | 'rules' | 'behaviors', string | null>;
export type ProviderArtifactPathStrings = Record<'agents' | 'commands' | 'skills' | 'rules' | 'behaviors', string>;
export type ProviderContextDiscoveryPaths = Record<'agents' | 'skills' | 'rules' | 'behaviors', string | null>;
export type ProviderContextDiscoveryPathStrings = Record<'agents' | 'skills' | 'rules' | 'behaviors', string>;

export type ProviderContextFiles = {
  aiwgMd: boolean;
  agentsMd: boolean;
  claudeMdHook: boolean;
  hookFile: string | null;
  contextFile: string | null;
};

export type ProviderContextLoadMode =
  | 'native-include'
  | 'prose-directive'
  | 'config-registration'
  | 'unsupported';

/**
 * Provider startup/context contract used by the shared workspace-context graph.
 *
 * A Markdown link is never represented as a native include. Providers that do
 * not document an include or configuration mechanism receive a compact prose
 * directive and an explicit degraded status instead.
 */
export type ProviderContextContract = {
  startupFiles: string[];
  precedence: string[];
  loadMode: ProviderContextLoadMode;
  includeSyntax: string | null;
  configRegistration: { file: string; key: string } | null;
  bootstrapTargets: string[];
  maxContextBytes: number | null;
  recommendedMaxLines: number | null;
  nestedContext: boolean;
  support: 'supported' | 'degraded' | 'unsupported';
  verification: {
    method: string;
    source: string;
    lastVerified: string;
  };
};

export type ProviderPaths = {
  deployTarget: DeployTarget;
  artifacts: ProviderArtifactPaths;
  kernelSkills: string | null;
  contextDiscovery: ProviderContextDiscoveryPaths;
  configFile: string | null;
  contextFiles: ProviderContextFiles;
};

export type ProviderSmithPaths = {
  agents: string | null;
  commands: string | null;
  skills: string | null;
  rules: string | null;
  fileExtension: '.md' | '.json';
  configFile: string | null;
  aggregated: boolean;
};

export type ProviderSkillNamespace = {
  deploymentGroup: 'deep-recursion' | 'one-level' | 'mcp-skip';
  pathType: 'project' | 'home-dir';
  skillsBaseDir: string;
  subdirLayout: boolean;
  maxNameLength?: number;
  maxDescriptionLength?: number;
  appendToDescription?: string;
};

export type ProviderAdapters = {
  agentFormat: string;
  hookBridge: string | null;
  mcpInjection: string | null;
  contextAggregation: string | null;
  ruleFormat: string | null;
};

export interface ProviderDefinition {
  id: Platform;
  displayName: string;
  aliases: string[];
  status: ProviderStatus;
  builtIn: boolean;
  upstream?: {
    source: string;
    version: string;
    revision: string;
    runtime: string;
    lastVerified: string;
  };
  surfaces: ProviderSurface;
  detection: ProviderDetection;
  paths: ProviderPaths;
  context: ProviderContextContract;
  smithPaths: ProviderSmithPaths;
  skillNamespace: ProviderSkillNamespace;
  adapters: ProviderAdapters;
  capabilities: {
    matrixRef: string | null;
    nativeFeatures: Record<string, boolean>;
    emulation: Record<string, string | null>;
  };
}

const ArtifactPathsSchema = z.object({
  agents: z.string().nullable(),
  commands: z.string().nullable(),
  skills: z.string().nullable(),
  rules: z.string().nullable(),
  behaviors: z.string().nullable(),
});

export const ProviderDefinitionSchema = z.object({
  id: z.enum([
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
  ]),
  displayName: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  status: z.enum(['stable', 'experimental', 'deprecated']),
  builtIn: z.boolean(),
  upstream: z.object({
    source: url(),
    version: z.string().min(1),
    revision: z.string().regex(/^[0-9a-f]{40}$/).refine(
      (value) => value !== '0'.repeat(40),
      { error: 'upstream.revision must be a real reviewed SHA, not all-zero' },
    ),
    runtime: z.string().min(1),
    lastVerified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).optional(),
  surfaces: z.object({
    primary: z.string().min(1),
    compatibility: z.array(z.string().min(1)),
    precedence: z.array(z.string().min(1)),
    related: z.array(z.object({
      id: z.string().min(1),
      displayName: z.string().min(1),
      relationship: z.enum(['same-provider', 'shared-adapter', 'future-provider', 'companion-standard']),
      deployable: z.boolean(),
      aliases: z.array(z.string().min(1)),
      paths: z.object({
        rules: z.array(z.string().min(1)),
        skills: z.array(z.string().min(1)),
        agentsMd: z.array(z.string().min(1)),
        legacy: z.array(z.string().min(1)),
      }),
      notes: z.array(z.string().min(1)),
    })),
  }),
  detection: z.object({
    env: z.array(z.string().min(1)),
    process: z.array(z.string().min(1)),
    capabilityId: z.string().min(1),
    runtimeEnvPriority: integer().positive().optional(),
  }),
  paths: z.object({
    deployTarget: z.enum(['project', 'home', 'mixed']),
    artifacts: ArtifactPathsSchema,
    kernelSkills: z.string().nullable(),
    contextDiscovery: z.object({
      agents: z.string().nullable(),
      skills: z.string().nullable(),
      rules: z.string().nullable(),
      behaviors: z.string().nullable(),
    }),
    configFile: z.string().nullable(),
    contextFiles: z.object({
      aiwgMd: z.boolean(),
      agentsMd: z.boolean(),
      claudeMdHook: z.boolean(),
      hookFile: z.string().nullable(),
      contextFile: z.string().nullable(),
    }),
  }),
  context: z.object({
    startupFiles: z.array(z.string().min(1)),
    precedence: z.array(z.string().min(1)),
    loadMode: z.enum(['native-include', 'prose-directive', 'config-registration', 'unsupported']),
    includeSyntax: z.string().nullable(),
    configRegistration: z.object({ file: z.string().min(1), key: z.string().min(1) }).nullable(),
    bootstrapTargets: z.array(z.string().min(1)),
    maxContextBytes: integer().positive().nullable(),
    recommendedMaxLines: integer().positive().nullable(),
    nestedContext: z.boolean(),
    support: z.enum(['supported', 'degraded', 'unsupported']),
    verification: z.object({
      method: z.string().min(1),
      source: z.string().min(1),
      lastVerified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  }),
  smithPaths: z.object({
    agents: z.string().nullable(),
    commands: z.string().nullable(),
    skills: z.string().nullable(),
    rules: z.string().nullable(),
    fileExtension: z.enum(['.md', '.json']),
    configFile: z.string().nullable(),
    aggregated: z.boolean(),
  }),
  skillNamespace: z.object({
    deploymentGroup: z.enum(['deep-recursion', 'one-level', 'mcp-skip']),
    pathType: z.enum(['project', 'home-dir']),
    skillsBaseDir: z.string().min(1),
    subdirLayout: z.boolean(),
    maxNameLength: integer().positive().optional(),
    maxDescriptionLength: integer().positive().optional(),
    appendToDescription: z.string().min(1).optional(),
  }),
  adapters: z.object({
    agentFormat: z.string().min(1),
    hookBridge: z.string().nullable(),
    mcpInjection: z.string().nullable(),
    contextAggregation: z.string().nullable(),
    ruleFormat: z.string().nullable(),
  }),
  capabilities: z.object({
    matrixRef: z.string().nullable(),
    nativeFeatures: z.record(z.string(), z.boolean()),
    emulation: z.record(z.string(), z.string().nullable()),
  }),
}) satisfies z.ZodType<ProviderDefinition>;

export type BuiltInSeed = Omit<ProviderDefinition, 'displayName' | 'status' | 'paths' | 'context' | 'capabilities'> & {
  displayName?: string;
  status?: ProviderStatus;
  paths: Omit<ProviderPaths, 'deployTarget' | 'contextDiscovery'> & {
    deployTarget?: DeployTarget;
    contextDiscovery?: ProviderContextDiscoveryPaths;
  };
  matrixRef: string | null;
};

