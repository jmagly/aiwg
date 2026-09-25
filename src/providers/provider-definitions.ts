import { z } from 'zod';
import { homedir } from 'os';
import { join } from 'path';
import type { Platform } from '../agents/types.js';
import { resolveHermesHomePath } from './hermes-home.js';
import { resolveGrokbotSkillsDir } from './grokbot-paths.js';
import {
  getProviderCapabilities,
  type DeployTarget,
  type ProviderStatus,
} from './capability-matrix.js';

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

const ProviderDefinitionSchema = z.object({
  id: z.enum([
    'antigravity',
    'claude',
    'codex',
    'copilot',
    'cursor',
    'deepseek-harness',
    'factory',
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
    source: z.string().url(),
    version: z.string().min(1),
    revision: z.string().regex(/^[0-9a-f]{40}$/).refine(
      (value) => value !== '0'.repeat(40),
      { message: 'upstream.revision must be a real reviewed SHA, not all-zero' },
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
    runtimeEnvPriority: z.number().int().positive().optional(),
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
    maxContextBytes: z.number().int().positive().nullable(),
    recommendedMaxLines: z.number().int().positive().nullable(),
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
    maxNameLength: z.number().int().positive().optional(),
    maxDescriptionLength: z.number().int().positive().optional(),
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
    nativeFeatures: z.record(z.boolean()),
    emulation: z.record(z.string().nullable()),
  }),
}) satisfies z.ZodType<ProviderDefinition>;

export const PROVIDER_IDS: readonly Platform[] = [
  'antigravity',
  'claude',
  'codex',
  'copilot',
  'cursor',
  'deepseek-harness',
  'factory',
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

type BuiltInSeed = Omit<ProviderDefinition, 'displayName' | 'status' | 'paths' | 'context' | 'capabilities'> & {
  displayName?: string;
  status?: ProviderStatus;
  paths: Omit<ProviderPaths, 'deployTarget' | 'contextDiscovery'> & {
    deployTarget?: DeployTarget;
    contextDiscovery?: ProviderContextDiscoveryPaths;
  };
  matrixRef: string | null;
};

const VERIFIED_ON = '2026-07-21';

const CONTEXT_CONTRACTS: Record<Platform, ProviderContextContract> = {
  antigravity: {
    startupFiles: ['AGENTS.md', 'GEMINI.md'],
    precedence: ['provider/system', 'project AGENTS.md or GEMINI.md', 'nested project context when selected by the CLI'],
    loadMode: 'prose-directive', includeSyntax: null, configRegistration: null,
    bootstrapTargets: ['AGENTS.md'], maxContextBytes: null, recommendedMaxLines: null, nestedContext: true, support: 'supported',
    verification: {
      method: 'official Antigravity CLI documentation and sanitized 1.1.26 help evidence',
      source: 'https://antigravity.google/docs/cli/overview/',
      lastVerified: '2026-09-04',
    },
  },
  claude: {
    startupFiles: ['CLAUDE.md', '.claude/CLAUDE.md'], precedence: ['provider/system', 'nested CLAUDE.md', 'root CLAUDE.md'],
    loadMode: 'native-include', includeSyntax: '@WORKSPACE.md\n@AIWG.md', configRegistration: null,
    bootstrapTargets: ['CLAUDE.md'], maxContextBytes: null, recommendedMaxLines: 200, nestedContext: true, support: 'supported',
    verification: { method: 'official documentation: CLAUDE.md imports and InstructionsLoaded hook', source: 'https://code.claude.com/docs/en/memory', lastVerified: VERIFIED_ON },
  },
  codex: {
    startupFiles: ['AGENTS.override.md', 'AGENTS.md'], precedence: ['provider/system', 'root-to-cwd AGENTS chain', 'nearest file'],
    loadMode: 'prose-directive', includeSyntax: null, configRegistration: null,
    bootstrapTargets: ['AGENTS.md'], maxContextBytes: 32 * 1024, recommendedMaxLines: null, nestedContext: true, support: 'supported',
    verification: { method: 'official AGENTS.md discovery chain; no Markdown include claimed', source: 'https://developers.openai.com/codex/guides/agents-md', lastVerified: VERIFIED_ON },
  },
  copilot: {
    startupFiles: ['.github/copilot-instructions.md', 'AGENTS.md', 'CLAUDE.md'], precedence: ['personal', 'repository', 'organization; CLI combines applicable files'],
    loadMode: 'native-include', includeSyntax: '@WORKSPACE.md\n@AIWG.md', configRegistration: null,
    bootstrapTargets: ['.github/copilot-instructions.md', 'AGENTS.md'], maxContextBytes: null, recommendedMaxLines: null, nestedContext: true, support: 'supported',
    verification: { method: 'official Copilot CLI custom-instruction imports', source: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions', lastVerified: VERIFIED_ON },
  },
  cursor: {
    startupFiles: ['AGENTS.md', 'CLAUDE.md', '.cursor/rules/*.mdc'], precedence: ['provider/system', 'project rules', 'root AGENTS.md'],
    loadMode: 'prose-directive', includeSyntax: null, configRegistration: null,
    bootstrapTargets: ['AGENTS.md'], maxContextBytes: null, recommendedMaxLines: 500, nestedContext: false, support: 'supported',
    verification: { method: 'official Cursor rules and CLI documentation', source: 'https://docs.cursor.com/context/rules-for-ai', lastVerified: VERIFIED_ON },
  },
  'deepseek-harness': {
    startupFiles: ['AGENTS.md', 'CLAUDE.md'],
    precedence: ['provider/system', 'project AGENTS.md or CLAUDE.md', 'nested project context'],
    loadMode: 'prose-directive', includeSyntax: null, configRegistration: null,
    bootstrapTargets: ['AGENTS.md'], maxContextBytes: 65536, recommendedMaxLines: null, nestedContext: true, support: 'supported',
    verification: {
      method: 'DeepSeek Harness instruction and filesystem-skill source review',
      source: 'https://github.com/deepseek-ai/deepseek-harness',
      lastVerified: '2026-09-05',
    },
  },
  factory: {
    startupFiles: ['AGENTS.md', '~/.factory/AGENTS.md'], precedence: ['provider/system', 'nearest AGENTS.md', 'root AGENTS.md', 'personal override'],
    loadMode: 'prose-directive', includeSyntax: null, configRegistration: null,
    bootstrapTargets: ['AGENTS.md'], maxContextBytes: null, recommendedMaxLines: 150, nestedContext: true, support: 'supported',
    verification: { method: 'official Factory AGENTS.md discovery hierarchy', source: 'https://docs.factory.ai/cli/configuration/agents-md', lastVerified: VERIFIED_ON },
  },
  grokbot: {
    startupFiles: ['AGENTS.md'],
    precedence: ['provider/system', 'project AGENTS.md when the host exposes it', 'explicit aiwg discover/show'],
    loadMode: 'prose-directive', includeSyntax: null, configRegistration: null,
    bootstrapTargets: ['AGENTS.md'], maxContextBytes: null, recommendedMaxLines: null, nestedContext: false, support: 'degraded',
    verification: {
      method: 'AIWG discover-first adapter contract; native Grok Bot startup/include path not yet verified — explicit-read guidance only',
      source: 'docs/architecture/adr-grokbot-provider-target.md',
      lastVerified: '2026-09-15',
    },
  },
  'grok-build': {
    // config.toml is configuration (MCP/plugins/permissions), not a startup/context file.
    // Hierarchical instructions: AGENTS.md + .grok/rules/*.md, root-to-cwd, deeper wins.
    startupFiles: ['AGENTS.md', '.grok/rules/*.md'],
    precedence: [
      'provider/system',
      'global ~/.grok instruction sources',
      'root-to-cwd AGENTS.md and .grok/rules/*.md (deeper files win on conflicts)',
      '$GROK_HOME for user skills and user config',
    ],
    loadMode: 'prose-directive', includeSyntax: null, configRegistration: null,
    bootstrapTargets: ['AGENTS.md'], maxContextBytes: null, recommendedMaxLines: null, nestedContext: true, support: 'supported',
    verification: {
      method: 'xAI project-rules docs (AGENTS.md + .grok/rules hierarchical discovery); grok inspect when installed',
      source: 'https://docs.x.ai/build/features/project-rules',
      lastVerified: '2026-09-20',
    },
  },
  hermes: {
    startupFiles: ['.hermes.md', 'AGENTS.md'], precedence: ['provider/system', '.hermes.md', 'AGENTS.md'],
    loadMode: 'prose-directive', includeSyntax: null, configRegistration: null,
    bootstrapTargets: ['.hermes.md', 'AGENTS.md'], maxContextBytes: null, recommendedMaxLines: 30, nestedContext: false, support: 'degraded',
    verification: { method: 'AIWG Hermes adapter contract; on-demand artifact-read required', source: 'agentic/code/providers/capability-matrix.yaml', lastVerified: VERIFIED_ON },
  },
  // #225: Muse Code prefers AGENTS.md over CLAUDE.md at each directory level;
  // project AGENTS.md loads only after the workspace is explicitly trusted
  // (first-run trust prompt). Discover-first bridge content lands in #227.
  muse: {
    startupFiles: ['AGENTS.md'],
    precedence: ['provider/system', 'project AGENTS.md once the workspace is trusted', 'explicit aiwg discover/show'],
    loadMode: 'prose-directive', includeSyntax: null, configRegistration: null,
    bootstrapTargets: ['AGENTS.md'], maxContextBytes: null, recommendedMaxLines: null, nestedContext: false, support: 'supported',
    verification: {
      method: 'ADR-locked surfaces; discover-first AGENTS.md bridge per official Muse Code docs (trust-gated load)',
      source: 'docs/architecture/adr-muse-provider-target.md',
      lastVerified: '2026-09-24',
    },
  },
  opencode: {
    startupFiles: ['AGENTS.md', 'CLAUDE.md', 'opencode.json#instructions'], precedence: ['provider/system', 'nearest AGENTS.md', 'CLAUDE compatibility', 'registered instructions'],
    loadMode: 'config-registration', includeSyntax: null, configRegistration: { file: 'opencode.json', key: 'instructions' },
    bootstrapTargets: ['AGENTS.md'], maxContextBytes: null, recommendedMaxLines: null, nestedContext: true, support: 'supported',
    verification: { method: 'official OpenCode rules documentation and instructions array', source: 'https://opencode.ai/docs/rules/', lastVerified: VERIFIED_ON },
  },
  openclaw: {
    startupFiles: ['~/.openclaw/config.yaml'], precedence: ['provider/system', 'home configuration'],
    loadMode: 'unsupported', includeSyntax: null, configRegistration: null,
    bootstrapTargets: [], maxContextBytes: null, recommendedMaxLines: null, nestedContext: false, support: 'degraded',
    verification: { method: 'AIWG home-scope adapter contract; no verified project startup file', source: 'agentic/code/providers/capability-matrix.yaml', lastVerified: VERIFIED_ON },
  },
  openhuman: {
    startupFiles: ['AGENTS.md'], precedence: ['provider/system', 'project AGENTS.md when host exposes it'],
    loadMode: 'prose-directive', includeSyntax: null, configRegistration: null,
    bootstrapTargets: ['AGENTS.md'], maxContextBytes: null, recommendedMaxLines: null, nestedContext: false, support: 'degraded',
    verification: { method: 'AIWG mixed-scope adapter contract; host loading remains capability-dependent', source: 'agentic/code/providers/capability-matrix.yaml', lastVerified: VERIFIED_ON },
  },
  omp: {
    startupFiles: ['.omp/AGENTS.md', 'AGENTS.md'],
    precedence: ['provider/system', 'native nearest nonempty .omp', 'compatibility context ordered by depth; exact paragraph deduplication'],
    loadMode: 'native-include', includeSyntax: '@<relative-path>', configRegistration: null,
    bootstrapTargets: ['.omp/AGENTS.md'], maxContextBytes: null, recommendedMaxLines: null, nestedContext: true, support: 'supported',
    verification: {
      method: 'OMP 18.1.10 source and live context import smoke',
      source: 'https://github.com/can1357/oh-my-pi/blob/5964a0f7649275bcde818f20073193fd032451f2/packages/coding-agent/src/system-prompt.ts#L451',
      lastVerified: '2026-09-04',
    },
  },
  pi: {
    startupFiles: ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'],
    precedence: ['provider/system', 'root-to-cwd context chain', 'AGENTS.override.md supersedes same-directory AGENTS.md and CLAUDE.md'],
    loadMode: 'prose-directive', includeSyntax: null, configRegistration: null,
    bootstrapTargets: ['AGENTS.md'], maxContextBytes: null, recommendedMaxLines: null, nestedContext: true, support: 'supported',
    verification: {
      method: 'Pi coding-agent resource loader and official README context-file documentation',
      source: 'https://github.com/earendil-works/pi/blob/79680533c6b898894f2d2421c7f640b212d3dfdd/packages/coding-agent/README.md#context-files',
      lastVerified: '2026-09-03',
    },
  },
  warp: {
    startupFiles: ['WARP.md', 'AGENTS.md'], precedence: ['provider/system', 'subdirectory rule', 'root rule', 'global rule'],
    loadMode: 'prose-directive', includeSyntax: null, configRegistration: null,
    bootstrapTargets: ['WARP.md', 'AGENTS.md'], maxContextBytes: null, recommendedMaxLines: null, nestedContext: true, support: 'supported',
    verification: { method: 'official Warp project rules documentation', source: 'https://docs.warp.dev/agent-platform/capabilities/rules/', lastVerified: VERIFIED_ON },
  },
  windsurf: {
    startupFiles: ['AGENTS.md', '.windsurf/rules/*.md', '.devin/rules/*.md'], precedence: ['provider/system', 'Devin rules', 'Windsurf rules', 'AGENTS.md'],
    loadMode: 'prose-directive', includeSyntax: null, configRegistration: null,
    bootstrapTargets: ['AGENTS.md'], maxContextBytes: null, recommendedMaxLines: null, nestedContext: true, support: 'degraded',
    verification: { method: 'AIWG Windsurf/Devin topology contract; provider-native rules retained', source: 'src/providers/provider-definitions.ts', lastVerified: VERIFIED_ON },
  },
  generic: {
    startupFiles: [], precedence: ['host policy'], loadMode: 'unsupported', includeSyntax: null, configRegistration: null,
    bootstrapTargets: [], maxContextBytes: null, recommendedMaxLines: null, nestedContext: false, support: 'unsupported',
    verification: { method: 'No provider selected; no startup-file claim', source: 'src/providers/provider-definitions.ts', lastVerified: VERIFIED_ON },
  },
};

const BUILT_IN_SEEDS: BuiltInSeed[] = [
  {
    id: 'antigravity',
    displayName: 'Google Antigravity CLI',
    aliases: ['agy'],
    status: 'experimental',
    builtIn: true,
    surfaces: {
      primary: 'antigravity',
      compatibility: ['agy'],
      precedence: ['AGENTS.md', 'GEMINI.md', '.agents/agents/', '.agents/skills/'],
      related: [],
    },
    detection: { env: [], process: ['agy'], capabilityId: 'antigravity' },
    paths: {
      deployTarget: 'project',
      artifacts: {
        agents: '.agents/agents', commands: null, skills: '.agents/.aiwg/skills', rules: null, behaviors: null,
      },
      kernelSkills: '.agents/skills',
      contextDiscovery: { agents: '.agents/agents', skills: '.agents/skills', rules: null, behaviors: null },
      configFile: 'AGENTS.md',
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: null, contextFile: 'AGENTS.md' },
    },
    smithPaths: {
      agents: '.agents/agents', commands: null, skills: '.agents/skills', rules: null,
      fileExtension: '.md', configFile: 'AGENTS.md', aggregated: false,
    },
    skillNamespace: {
      deploymentGroup: 'deep-recursion', pathType: 'project', skillsBaseDir: '.agents/skills', subdirLayout: true,
    },
    adapters: {
      agentFormat: 'antigravity-markdown', hookBridge: null, mcpInjection: 'antigravity',
      contextAggregation: 'agents-md', ruleFormat: null,
    },
    matrixRef: 'antigravity',
  },
  {
    id: 'claude',
    displayName: 'Claude Code',
    aliases: ['claude-code'],
    builtIn: true,
    surfaces: { primary: 'claude-code', compatibility: ['claude'], precedence: ['.claude/', 'CLAUDE.md'], related: [] },
    detection: {
      env: ['CLAUDE_CODE_VERSION', 'ANTHROPIC_API_KEY'],
      process: ['claude-code', 'claude'],
      capabilityId: 'claude-code',
      runtimeEnvPriority: 100,
    },
    paths: {
      artifacts: {
        agents: '.claude/agents',
        commands: '.claude/commands',
        skills: '.claude/.aiwg/skills',
        rules: '.claude/rules',
        behaviors: '.claude/hooks',
      },
      kernelSkills: '.claude/skills',
      configFile: 'CLAUDE.md',
      contextFiles: { aiwgMd: true, agentsMd: false, claudeMdHook: true, hookFile: null, contextFile: 'CLAUDE.md' },
    },
    smithPaths: {
      agents: '.claude/agents',
      commands: '.claude/commands',
      skills: '.claude/skills',
      rules: '.claude/rules',
      fileExtension: '.md',
      configFile: 'CLAUDE.md',
      aggregated: false,
    },
    skillNamespace: {
      deploymentGroup: 'deep-recursion',
      pathType: 'project',
      skillsBaseDir: '.claude/skills',
      subdirLayout: true,
    },
    adapters: {
      agentFormat: 'claude-markdown',
      hookBridge: null,
      mcpInjection: 'claude-code',
      contextAggregation: 'claude-hook',
      ruleFormat: 'markdown',
    },
    matrixRef: 'claude-code',
  },
  {
    id: 'codex',
    aliases: ['openai'],
    builtIn: true,
    surfaces: { primary: 'codex', compatibility: ['openai'], precedence: ['.agents/skills/', '.codex/'], related: [] },
    detection: {
      env: ['CODEX_SANDBOX', 'CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY'],
      process: ['@openai/codex', 'codex'],
      capabilityId: 'codex',
      runtimeEnvPriority: 10,
    },
    paths: {
      artifacts: {
        agents: '.codex/agents',
        commands: '.codex/commands',
        skills: '.codex/.aiwg/skills',
        rules: '.codex/rules',
        behaviors: '.codex/rules',
      },
      kernelSkills: '.agents/skills',
      contextDiscovery: {
        agents: '.codex/agents',
        skills: '.agents/skills',
        rules: '.codex/rules',
        behaviors: null,
      },
      configFile: 'AGENTS.md',
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: null, contextFile: 'AGENTS.md' },
    },
    smithPaths: {
      agents: '.codex/agents',
      commands: '.codex/commands',
      skills: '.codex/skills',
      rules: '.codex/rules',
      fileExtension: '.md',
      configFile: 'AGENTS.md',
      aggregated: false,
    },
    skillNamespace: {
      deploymentGroup: 'deep-recursion',
      pathType: 'home-dir',
      skillsBaseDir: '.codex/skills',
      maxNameLength: 100,
      maxDescriptionLength: 500,
      subdirLayout: true,
    },
    adapters: {
      agentFormat: 'codex-markdown',
      hookBridge: 'codex',
      mcpInjection: 'codex',
      contextAggregation: 'agents-md',
      ruleFormat: 'markdown',
    },
    matrixRef: 'codex',
  },
  {
    id: 'copilot',
    aliases: ['github-copilot'],
    builtIn: true,
    surfaces: { primary: 'copilot', compatibility: ['github-copilot'], precedence: ['.github/'], related: [] },
    detection: {
      env: ['COPILOT_AGENT', 'GITHUB_COPILOT_TOKEN'],
      process: ['copilot'],
      capabilityId: 'copilot',
      runtimeEnvPriority: 50,
    },
    paths: {
      artifacts: {
        agents: '.github/agents',
        commands: '.github/commands',
        skills: '.github/.aiwg/skills',
        rules: '.github/copilot-rules',
        behaviors: '.github/copilot-rules',
      },
      kernelSkills: '.github/skills',
      contextDiscovery: {
        agents: '.github/agents',
        skills: '.github/.aiwg/skills',
        rules: '.github/instructions',
        behaviors: null,
      },
      configFile: 'copilot-instructions.md',
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: null, contextFile: 'AGENTS.md' },
    },
    smithPaths: {
      agents: '.github/agents',
      commands: '.github/agents',
      skills: '.github/skills',
      rules: '.github/copilot-rules',
      fileExtension: '.md',
      configFile: 'copilot-instructions.md',
      aggregated: false,
    },
    skillNamespace: {
      deploymentGroup: 'deep-recursion',
      pathType: 'project',
      skillsBaseDir: '.github/skills',
      subdirLayout: true,
    },
    adapters: {
      agentFormat: 'copilot-markdown',
      hookBridge: 'copilot',
      mcpInjection: null,
      contextAggregation: 'agents-md',
      ruleFormat: 'markdown',
    },
    matrixRef: 'copilot',
  },
  {
    id: 'cursor',
    aliases: [],
    builtIn: true,
    surfaces: { primary: 'cursor', compatibility: [], precedence: ['AGENTS.md', '.cursor/rules/'], related: [] },
    detection: {
      env: ['CURSOR_TRACE_ID', 'CURSOR_VERSION'],
      process: ['cursor'],
      capabilityId: 'cursor',
      runtimeEnvPriority: 20,
    },
    paths: {
      artifacts: {
        agents: '.cursor/agents',
        commands: '.cursor/commands',
        skills: '.cursor/.aiwg/skills',
        rules: '.cursor/rules',
        behaviors: '.cursor/rules',
      },
      kernelSkills: '.cursor/skills',
      configFile: 'AGENTS.md',
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: null, contextFile: 'AGENTS.md' },
    },
    smithPaths: {
      agents: '.cursor/agents',
      commands: '.cursor/commands',
      skills: '.cursor/skills',
      rules: '.cursor/rules',
      fileExtension: '.json',
      configFile: 'AGENTS.md',
      aggregated: false,
    },
    skillNamespace: {
      deploymentGroup: 'deep-recursion',
      pathType: 'project',
      skillsBaseDir: '.cursor/skills',
      subdirLayout: true,
    },
    adapters: {
      agentFormat: 'cursor-json',
      hookBridge: null,
      mcpInjection: 'cursor',
      contextAggregation: 'agents-md',
      ruleFormat: 'mdc',
    },
    matrixRef: 'cursor',
  },
  {
    id: 'factory',
    aliases: ['factory-ai'],
    builtIn: true,
    surfaces: { primary: 'factory', compatibility: ['factory-ai'], precedence: ['.factory/', 'AGENTS.md'], related: [] },
    detection: {
      env: ['FACTORY_AGENT_ID'],
      process: ['factory'],
      capabilityId: 'factory',
      runtimeEnvPriority: 80,
    },
    paths: {
      artifacts: {
        agents: '.factory/droids',
        commands: '.factory/commands',
        skills: '.factory/.aiwg/skills',
        rules: '.factory/rules',
        behaviors: '.factory/rules',
      },
      kernelSkills: '.factory/skills',
      configFile: 'AGENTS.md',
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: null, contextFile: 'AGENTS.md' },
    },
    smithPaths: {
      agents: '.factory/droids',
      commands: '.factory/commands',
      skills: '.factory/skills',
      rules: '.factory/rules',
      fileExtension: '.md',
      configFile: 'AGENTS.md',
      aggregated: false,
    },
    skillNamespace: {
      deploymentGroup: 'deep-recursion',
      pathType: 'project',
      skillsBaseDir: '.factory/skills',
      appendToDescription: 'Use when relevant to the task.',
      subdirLayout: true,
    },
    adapters: {
      agentFormat: 'factory-droid',
      hookBridge: 'factory',
      mcpInjection: 'factory',
      contextAggregation: 'agents-md',
      ruleFormat: 'markdown',
    },
    matrixRef: 'factory',
  },
  {
    id: 'grokbot',
    displayName: 'Grok Bot',
    aliases: [],
    // #210: promoted stable — Linux PUW + security + migration + maintainer Linux-only waiver 2026-09-16.
    status: 'stable',
    builtIn: true,
    surfaces: {
      primary: 'grokbot',
      compatibility: [],
      precedence: ['AGENTS.md', 'AIWG_GROKBOT_SKILLS_DIR when configured'],
      related: [],
    },
    // Do not treat xAI API keys or generic GROK_* model env as Grok Bot evidence.
    detection: { env: [], process: [], capabilityId: 'grokbot' },
    paths: {
      deployTarget: 'mixed',
      artifacts: {
        agents: null,
        commands: null,
        // Native skill copies only when AIWG_GROKBOT_SKILLS_DIR is set at deploy time.
        skills: null,
        rules: null,
        behaviors: null,
      },
      kernelSkills: null,
      contextDiscovery: {
        agents: '.agents/agents',
        skills: null,
        rules: null,
        behaviors: null,
      },
      configFile: 'AGENTS.md',
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: null, contextFile: 'AGENTS.md' },
    },
    smithPaths: {
      agents: null,
      commands: null,
      skills: null,
      rules: null,
      fileExtension: '.md',
      configFile: 'AGENTS.md',
      aggregated: false,
    },
    // Skills root is env-gated (AIWG_GROKBOT_SKILLS_DIR). skillsBaseDir is a
    // documentation sentinel only — deployer resolves via resolveGrokbotSkillsDir
    // and never joins ~/grokbot-skills.
    skillNamespace: {
      deploymentGroup: 'deep-recursion',
      pathType: 'home-dir',
      skillsBaseDir: 'AIWG_GROKBOT_SKILLS_DIR',
      subdirLayout: true,
    },
    adapters: {
      agentFormat: 'agents-md',
      hookBridge: null,
      mcpInjection: null,
      contextAggregation: 'agents-md',
      ruleFormat: 'agents-md-section',
    },
    matrixRef: 'grokbot',
  },
  {
    id: 'grok-build',
    displayName: 'Grok Build',
    aliases: [],
    status: 'experimental',
    builtIn: true,
    upstream: {
      source: 'https://github.com/xai-org/grok-build',
      version: '1.0.38',
      // Reviewed public tree (docs + inspect schema), not an all-zero placeholder.
      revision: '4247f661689354b831191f11eeeac8424993fe3d',
      runtime: 'Grok Build CLI',
      lastVerified: '2026-09-20',
    },
    surfaces: {
      primary: 'grok-build',
      compatibility: [],
      precedence: ['AGENTS.md', '.grok/agents/ (qualified model workers)', '.grok/skills/', '.grok/rules/ (host)', '.grok/config.toml (config only)', '$GROK_HOME'],
      related: [],
    },
    detection: { env: ['GROK_HOME'], process: ['grok'], capabilityId: 'grok-build' },
    paths: {
      deployTarget: 'mixed',
      artifacts: {
        agents: '.grok/agents',
        commands: null,
        skills: '.grok/skills',
        rules: null,
        behaviors: null,
      },
      kernelSkills: '.grok/skills',
      contextDiscovery: {
        agents: '.grok/agents',
        skills: '.grok/skills',
        rules: '.grok/rules',
        behaviors: null,
      },
      configFile: '.grok/config.toml',
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: null, contextFile: 'AGENTS.md' },
    },
    smithPaths: {
      agents: '.grok/agents',
      commands: null,
      skills: '.grok/skills',
      rules: null,
      fileExtension: '.md',
      configFile: '.grok/config.toml',
      aggregated: false,
    },
    skillNamespace: {
      deploymentGroup: 'deep-recursion',
      pathType: 'project',
      skillsBaseDir: '.grok/skills',
      subdirLayout: true,
    },
    adapters: {
      agentFormat: 'agents-md',
      hookBridge: 'grok-build',
      mcpInjection: 'grok-build',
      contextAggregation: 'agents-md',
      ruleFormat: 'agents-md-section',
    },
    matrixRef: 'grok-build',
  },
  {
    id: 'hermes',
    aliases: [],
    builtIn: true,
    surfaces: { primary: 'hermes', compatibility: [], precedence: ['.hermes.md', 'AGENTS.md', resolveHermesHomePath('skills')], related: [] },
    detection: {
      env: [],
      process: ['hermes'],
      capabilityId: 'hermes',
    },
    paths: {
      artifacts: {
        agents: null,
        commands: null,
        skills: resolveHermesHomePath('skills', '.aiwg'),
        rules: null,
        behaviors: null,
      },
      kernelSkills: resolveHermesHomePath('skills'),
      configFile: 'AGENTS.md',
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: '.hermes.md', contextFile: 'AGENTS.md' },
    },
    smithPaths: {
      agents: null,
      commands: null,
      skills: resolveHermesHomePath('skills'),
      rules: null,
      fileExtension: '.md',
      configFile: 'AGENTS.md',
      aggregated: false,
    },
    skillNamespace: {
      deploymentGroup: 'mcp-skip',
      pathType: 'home-dir',
      skillsBaseDir: '.hermes/skills',
      subdirLayout: false,
    },
    adapters: {
      agentFormat: 'agents-md',
      hookBridge: 'hermes',
      mcpInjection: null,
      contextAggregation: 'agents-md',
      ruleFormat: 'agents-md-section',
    },
    matrixRef: 'hermes',
  },
  {
    id: 'muse',
    displayName: 'Muse Code',
    // #225: ADR fixes the canonical id as `muse` with no aliases.
    aliases: [],
    status: 'experimental',
    builtIn: true,
    surfaces: {
      primary: 'muse',
      compatibility: [],
      precedence: ['AGENTS.md', '.agents/skills/'],
      related: [],
    },
    // Fail-closed: no env or process signals. A bare `muse` process name collides
    // with unrelated software, so it is not evidence of Muse Code. The `muse`
    // CLI binary name is a documented fact, not a detection claim
    // (docs/architecture/adr-muse-provider-target.md).
    detection: { env: [], process: [], capabilityId: 'muse' },
    paths: {
      deployTarget: 'mixed',
      artifacts: {
        // Wave 1 (#225) registers identity only; skill writers land in #226
        // and hooks in #228, so non-skill artifacts stay null.
        agents: null,
        commands: null,
        skills: '.agents/skills',
        rules: null,
        behaviors: null,
      },
      kernelSkills: '.agents/skills',
      contextDiscovery: {
        agents: null,
        skills: '.agents/skills',
        rules: null,
        behaviors: null,
      },
      configFile: null,
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: null, contextFile: 'AGENTS.md' },
    },
    smithPaths: {
      agents: null,
      commands: null,
      skills: '.agents/skills',
      rules: null,
      fileExtension: '.md',
      configFile: null,
      aggregated: false,
    },
    // Project skill root only: the namespace default resolves to
    // <repo>/.agents/skills — a project tree, never a home-dir tree — so the
    // deployer cannot invent ~/.muse, ~/.config/muse siblings outside
    // muse/skills, or ~/.agents/skills from this metadata alone. The XDG
    // user root ($XDG_CONFIG_HOME/muse/skills, default ~/.config/muse/skills)
    // is not a static namespace default; it resolves dynamically at deploy
    // time via resolveMuseXdgSkillsDir (src/providers/muse-paths.ts, #234),
    // which fails closed on bad XDG metadata. Never write ~/.muse or
    // silently mirror into ~/.agents/skills (#226).
    skillNamespace: {
      deploymentGroup: 'deep-recursion',
      pathType: 'project',
      skillsBaseDir: '.agents/skills',
      subdirLayout: true,
    },
    adapters: {
      agentFormat: 'agents-md',
      hookBridge: null,
      mcpInjection: null,
      contextAggregation: 'agents-md',
      ruleFormat: 'agents-md-section',
    },
    matrixRef: 'muse',
  },
  {
    id: 'opencode',
    aliases: [],
    builtIn: true,
    surfaces: { primary: 'opencode', compatibility: [], precedence: ['.opencode/', 'AGENTS.md'], related: [] },
    detection: {
      env: ['OPENCODE_VERSION'],
      process: ['opencode'],
      capabilityId: 'opencode',
      runtimeEnvPriority: 90,
    },
    paths: {
      artifacts: {
        agents: '.opencode/agent',
        commands: '.opencode/command',
        skills: '.opencode/.aiwg/skill',
        rules: '.opencode/rule',
        behaviors: '.opencode/rule',
      },
      kernelSkills: '.opencode/skill',
      configFile: 'AGENTS.md',
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: null, contextFile: 'AGENTS.md' },
    },
    smithPaths: {
      agents: null,
      commands: '.opencode/command',
      skills: '.opencode/skill',
      rules: '.opencode/rule',
      fileExtension: '.md',
      configFile: 'AGENTS.md',
      aggregated: false,
    },
    skillNamespace: {
      deploymentGroup: 'deep-recursion',
      pathType: 'project',
      skillsBaseDir: '.opencode/skill',
      subdirLayout: true,
    },
    adapters: {
      agentFormat: 'opencode-markdown',
      hookBridge: null,
      mcpInjection: 'opencode',
      contextAggregation: 'agents-md',
      ruleFormat: 'markdown',
    },
    matrixRef: 'opencode',
  },
  {
    id: 'openclaw',
    aliases: [],
    builtIn: true,
    surfaces: { primary: 'openclaw', compatibility: [], precedence: ['~/.openclaw/'], related: [] },
    detection: {
      env: ['OPENCLAW_VERSION'],
      process: ['openclaw'],
      capabilityId: 'openclaw',
      runtimeEnvPriority: 60,
    },
    paths: {
      deployTarget: 'home',
      artifacts: {
        agents: '~/.openclaw/agents',
        commands: '~/.openclaw/commands',
        skills: '~/.openclaw/.aiwg/skills',
        rules: '~/.openclaw/rules',
        behaviors: '~/.openclaw/behaviors',
      },
      kernelSkills: '~/.openclaw/skills/aiwg',
      configFile: 'AGENTS.md',
      contextFiles: { aiwgMd: false, agentsMd: false, claudeMdHook: false, hookFile: null, contextFile: '~/.openclaw/config.yaml' },
    },
    smithPaths: {
      agents: '~/.openclaw/agents',
      commands: '~/.openclaw/commands',
      skills: '~/.openclaw/skills',
      rules: '~/.openclaw/rules',
      fileExtension: '.md',
      configFile: 'AGENTS.md',
      aggregated: false,
    },
    skillNamespace: {
      deploymentGroup: 'deep-recursion',
      pathType: 'home-dir',
      skillsBaseDir: '.openclaw/skills',
      subdirLayout: true,
    },
    adapters: {
      agentFormat: 'openclaw-markdown',
      hookBridge: null,
      mcpInjection: null,
      contextAggregation: null,
      ruleFormat: 'markdown',
    },
    matrixRef: 'openclaw',
  },
  {
    id: 'openhuman',
    aliases: ['tinyhumansai'],
    builtIn: true,
    surfaces: { primary: 'openhuman', compatibility: ['tinyhumansai'], precedence: ['~/.openhuman/skills/', 'AGENTS.md'], related: [] },
    detection: {
      env: ['OPENHUMAN_HOME', 'OPENHUMAN_CORE_TOKEN'],
      process: ['openhuman'],
      capabilityId: 'openhuman',
      runtimeEnvPriority: 70,
    },
    paths: {
      deployTarget: 'mixed',
      artifacts: {
        agents: null,
        commands: null,
        skills: '~/.openhuman/.aiwg/skills',
        rules: '~/.openhuman/.aiwg/rules',
        behaviors: null,
      },
      kernelSkills: '~/.openhuman/skills',
      contextDiscovery: {
        agents: '.agents/agents',
        skills: '~/.openhuman/.aiwg/skills',
        rules: '~/.openhuman/.aiwg/rules',
        behaviors: null,
      },
      configFile: null,
      contextFiles: { aiwgMd: false, agentsMd: false, claudeMdHook: false, hookFile: null, contextFile: 'AGENTS.md' },
    },
    smithPaths: {
      agents: null,
      commands: null,
      skills: '~/.openhuman/skills',
      rules: '~/.openhuman/.aiwg/rules',
      fileExtension: '.md',
      configFile: null,
      aggregated: false,
    },
    skillNamespace: {
      deploymentGroup: 'deep-recursion',
      pathType: 'home-dir',
      skillsBaseDir: '.openhuman/skills',
      subdirLayout: true,
    },
    adapters: {
      agentFormat: 'openhuman-agents-md',
      hookBridge: null,
      mcpInjection: null,
      contextAggregation: 'agents-md',
      ruleFormat: 'agents-md-section',
    },
    matrixRef: 'openhuman',
  },
  {
    id: 'deepseek-harness',
    displayName: 'DeepSeek Harness',
    aliases: ['dsh'],
    builtIn: true,
    upstream: {
      source: 'https://github.com/deepseek-ai/deepseek-harness',
      version: 'dsh-v0.1.3-alpha.1',
      revision: 'd347e703908d0406b7a7ef80e3a0e594d86b2215',
      runtime: 'Node.js ^22.19.0 || >=24.0.0',
      lastVerified: '2026-09-05',
    },
    surfaces: {
      primary: 'dsh', compatibility: ['deepseek-harness'],
      precedence: ['AGENTS.md', 'CLAUDE.md', '.agents/skills/', '.dsh/skills/', '.dsh/aiwg.cordis.patch.yml'], related: [],
    },
    detection: { env: ['DSH_HOME'], process: ['dsh'], capabilityId: 'deepseek-harness' },
    paths: {
      artifacts: { agents: '.agents/skills', commands: null, skills: '.agents/skills', rules: null, behaviors: null },
      kernelSkills: '.agents/skills',
      contextDiscovery: { agents: '.agents/skills', skills: '.agents/skills', rules: null, behaviors: null },
      configFile: '.dsh/aiwg.cordis.patch.yml',
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: null, contextFile: 'AGENTS.md' },
    },
    smithPaths: { agents: '.agents/skills', commands: null, skills: '.agents/skills', rules: null, fileExtension: '.md', configFile: '.dsh/aiwg.cordis.patch.yml', aggregated: false },
    skillNamespace: { deploymentGroup: 'deep-recursion', pathType: 'project', skillsBaseDir: '.agents/skills', subdirLayout: true },
    adapters: { agentFormat: 'agents-md', hookBridge: null, mcpInjection: null, contextAggregation: 'agents-md', ruleFormat: 'agents-md-section' },
    matrixRef: 'deepseek-harness',
  },
  {
    id: 'omp',
    aliases: ['oh-my-pi'],
    builtIn: true,
    surfaces: {
      primary: 'omp', compatibility: ['oh-my-pi'],
      precedence: ['.omp/AGENTS.md', 'AGENTS.md', '.agents/skills/', '.omp/skills/', '.omp/prompts/'], related: [],
    },
    detection: { env: [], process: ['omp', '@oh-my-pi/pi-coding-agent'], capabilityId: 'omp' },
    paths: {
      artifacts: { agents: '.omp/agents', commands: '.omp/prompts', skills: '.agents/skills', rules: '.omp/rules', behaviors: '.omp/extensions' },
      kernelSkills: '.agents/skills',
      contextDiscovery: { agents: '.omp/agents', skills: '.agents/skills', rules: '.omp/rules', behaviors: '.omp/extensions' },
      configFile: '.omp/AGENTS.md',
      contextFiles: { aiwgMd: true, agentsMd: false, claudeMdHook: false, hookFile: '.omp/AGENTS.md', contextFile: '.omp/AGENTS.md' },
    },
    smithPaths: { agents: '.omp/agents', commands: '.omp/prompts', skills: '.agents/skills', rules: '.omp/rules', fileExtension: '.md', configFile: '.omp/AGENTS.md', aggregated: false },
    skillNamespace: { deploymentGroup: 'one-level', pathType: 'project', skillsBaseDir: '.omp/skills', subdirLayout: false },
    adapters: { agentFormat: 'omp-markdown', hookBridge: 'omp', mcpInjection: 'omp', contextAggregation: 'agents-md', ruleFormat: 'omp-markdown' },
    matrixRef: 'omp',
  },
  {
    id: 'pi',
    aliases: ['pi-coding-agent'],
    builtIn: true,
    surfaces: {
      primary: 'pi',
      compatibility: ['pi-coding-agent'],
      precedence: ['AGENTS.override.md', 'AGENTS.md', '.agents/skills/', '.pi/skills/', '.pi/prompts/'],
      related: [],
    },
    detection: {
      // PI_CODING_AGENT_DIR only relocates configuration; it is deliberately
      // not an active-runtime marker. Availability is proven by process or executable.
      env: [],
      process: ['pi'],
      capabilityId: 'pi',
    },
    paths: {
      artifacts: {
        agents: '.agents/skills',
        commands: '.pi/prompts',
        skills: '.pi/.aiwg/skills',
        rules: null,
        behaviors: '.pi/extensions',
      },
      kernelSkills: '.agents/skills',
      contextDiscovery: {
        agents: '.agents/skills',
        skills: '.agents/skills',
        rules: null,
        behaviors: '.pi/extensions',
      },
      configFile: 'AGENTS.md',
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: null, contextFile: 'AGENTS.md' },
    },
    smithPaths: {
      agents: '.agents/skills',
      commands: '.pi/prompts',
      skills: '.pi/skills',
      rules: null,
      fileExtension: '.md',
      configFile: 'AGENTS.md',
      aggregated: false,
    },
    skillNamespace: {
      deploymentGroup: 'deep-recursion',
      pathType: 'project',
      skillsBaseDir: '.pi/skills',
      subdirLayout: true,
    },
    adapters: {
      agentFormat: 'agents-md',
      hookBridge: null,
      mcpInjection: null,
      contextAggregation: 'agents-md',
      ruleFormat: 'agents-md-section',
    },
    matrixRef: 'pi',
  },
  {
    id: 'warp',
    aliases: [],
    builtIn: true,
    surfaces: { primary: 'warp', compatibility: [], precedence: ['WARP.md', '.warp/'], related: [] },
    detection: {
      env: ['WARP_SESSION_ID', 'WARP_TERMINAL'],
      process: ['warp'],
      capabilityId: 'warp',
      runtimeEnvPriority: 40,
    },
    paths: {
      artifacts: {
        agents: '.warp/agents',
        commands: '.warp/commands',
        skills: '.warp/.aiwg/skills',
        rules: '.warp/rules',
        behaviors: null,
      },
      kernelSkills: '.warp/skills',
      configFile: 'WARP.md',
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: 'AIWG-warp.md', contextFile: 'WARP.md' },
    },
    smithPaths: {
      agents: '.warp/agents',
      commands: '.warp/commands',
      skills: '.warp/skills',
      rules: '.warp/rules',
      fileExtension: '.md',
      configFile: 'WARP.md',
      aggregated: true,
    },
    skillNamespace: {
      deploymentGroup: 'deep-recursion',
      pathType: 'project',
      skillsBaseDir: '.warp/skills',
      subdirLayout: true,
    },
    adapters: {
      agentFormat: 'warp-markdown',
      hookBridge: null,
      mcpInjection: 'warp',
      contextAggregation: 'warp-md',
      ruleFormat: 'markdown',
    },
    matrixRef: 'warp',
  },
  {
    id: 'windsurf',
    displayName: 'Devin Desktop',
    status: 'stable',
    aliases: ['devin', 'devin-desktop', 'devin-local', 'cascade'],
    builtIn: true,
    surfaces: {
      primary: 'devin',
      compatibility: ['devin-desktop', 'windsurf', 'devin-local', 'cascade'],
      precedence: ['.devin/rules/', '.windsurf/rules/', 'AGENTS.md', '.windsurfrules'],
      related: [
        {
          id: 'devin-desktop',
          displayName: 'Devin Desktop',
          relationship: 'same-provider',
          deployable: true,
          aliases: ['devin', 'windsurf', 'cascade'],
          paths: {
            rules: ['.devin/rules/*.md', '.windsurf/rules/*.md'],
            skills: [],
            agentsMd: ['AGENTS.md', 'agents.md'],
            legacy: ['.windsurfrules'],
          },
          notes: [
            'Devin Desktop is the current product name; --provider devin is preferred and --provider windsurf remains a deprecated compatibility id.',
            '.devin/rules is preferred by Devin Desktop, but AIWG keeps .devin/ as ignored local provider output and currently emits the compatibility surface through .windsurf/ plus AGENTS.md.',
          ],
        },
        {
          id: 'devin-cli',
          displayName: 'Devin CLI',
          relationship: 'future-provider',
          deployable: false,
          aliases: [],
          paths: {
            rules: ['AGENTS.md', 'AGENTS.local.md', 'AGENT.md', '.windsurfrules', 'CLAUDE.md'],
            skills: ['.devin/skills/<skill-name>/SKILL.md', '.windsurf/skills/<skill-name>/SKILL.md'],
            agentsMd: ['AGENTS.md'],
            legacy: ['.windsurfrules'],
          },
          notes: [
            'Devin CLI has distinct rules and skills surfaces and should not normalize to windsurf until a dedicated provider behavior issue adds writer support.',
          ],
        },
        {
          id: 'devin-product-skills',
          displayName: 'Devin Product Skills',
          relationship: 'companion-standard',
          deployable: false,
          aliases: [],
          paths: {
            rules: [],
            skills: ['.agents/skills/<skill-name>/SKILL.md'],
            agentsMd: [],
            legacy: [],
          },
          notes: [
            'Devin product skills use the Agent Skills layout and are recorded here as a readable surface, not as current AIWG windsurf deploy output.',
          ],
        },
      ],
    },
    detection: {
      env: ['WINDSURF_VERSION'],
      process: ['windsurf'],
      capabilityId: 'windsurf',
      runtimeEnvPriority: 30,
    },
    paths: {
      artifacts: {
        agents: '.windsurf/agents',
        commands: '.windsurf/workflows',
        skills: '.windsurf/.aiwg/skills',
        rules: '.windsurf/rules',
        behaviors: '.windsurf/rules',
      },
      kernelSkills: '.windsurf/skills',
      configFile: '.windsurfrules',
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: 'AIWG-windsurf.md', contextFile: 'AGENTS.md' },
    },
    smithPaths: {
      agents: '.windsurf/agents',
      commands: '.windsurf/workflows',
      skills: '.windsurf/skills',
      rules: '.windsurf/rules',
      fileExtension: '.md',
      configFile: '.windsurfrules',
      aggregated: true,
    },
    skillNamespace: {
      deploymentGroup: 'one-level',
      pathType: 'project',
      skillsBaseDir: '.windsurf/skills',
      subdirLayout: false,
    },
    adapters: {
      agentFormat: 'windsurf-markdown',
      hookBridge: null,
      mcpInjection: 'windsurf',
      contextAggregation: 'agents-md',
      ruleFormat: 'windsurf-rule',
    },
    matrixRef: 'windsurf',
  },
  {
    id: 'generic',
    displayName: 'Generic',
    status: 'stable',
    aliases: [],
    builtIn: true,
    surfaces: { primary: 'generic', compatibility: [], precedence: ['agents/', 'skills/', 'rules/'], related: [] },
    detection: {
      env: [],
      process: [],
      capabilityId: 'generic',
    },
    paths: {
      deployTarget: 'project',
      artifacts: {
        agents: 'agents',
        commands: 'commands',
        skills: 'skills',
        rules: 'rules',
        behaviors: null,
      },
      kernelSkills: null,
      configFile: 'README.md',
      contextFiles: { aiwgMd: false, agentsMd: false, claudeMdHook: false, hookFile: null, contextFile: 'README.md' },
    },
    smithPaths: {
      agents: 'agents',
      commands: 'commands',
      skills: 'skills',
      rules: 'rules',
      fileExtension: '.md',
      configFile: 'README.md',
      aggregated: false,
    },
    skillNamespace: {
      deploymentGroup: 'deep-recursion',
      pathType: 'project',
      skillsBaseDir: 'skills',
      subdirLayout: true,
    },
    adapters: {
      agentFormat: 'generic-markdown',
      hookBridge: null,
      mcpInjection: null,
      contextAggregation: null,
      ruleFormat: 'markdown',
    },
    matrixRef: null,
  },
];

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

export function resolveProviderPathValue(providerPath: string | null, projectPath: string): string {
  const expandedPath = expandProviderHomePath(providerPath);
  if (!expandedPath) return '';
  if (expandedPath.startsWith('/')) return expandedPath;
  return join(projectPath, expandedPath);
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
