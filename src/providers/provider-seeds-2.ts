// Built-in provider adapter definitions, preserving canonical registry order.
import type { BuiltInSeed } from './provider-definition-schema.js';
import { resolveHermesHomePath } from './hermes-home.js';
import { GROK_BUILD_STANDARD_SKILLS_PATH } from './grok-build-paths.js';
import { MUSE_STANDARD_SKILLS_PATH } from './muse-paths.js';

export const BUILT_IN_SEEDS_2: BuiltInSeed[] = [
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
      revision: '2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8',
      runtime: 'Grok Build CLI',
      lastVerified: '2026-10-26',
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
        skills: GROK_BUILD_STANDARD_SKILLS_PATH,
        rules: '.grok/rules',
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
      rules: '.grok/rules',
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
        rules: '.hermes/rules',
        behaviors: null,
      },
      kernelSkills: resolveHermesHomePath('skills'),
      contextDiscovery: { agents: null, skills: resolveHermesHomePath('skills', '.aiwg'), rules: null, behaviors: null },
      configFile: 'AGENTS.md',
      contextFiles: { aiwgMd: true, agentsMd: true, claudeMdHook: false, hookFile: '.hermes.md', contextFile: 'AGENTS.md' },
    },
    smithPaths: {
      agents: null,
      commands: null,
      skills: resolveHermesHomePath('skills'),
      rules: '.hermes/rules',
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
    // #231: promoted stable — Linux PUW + security review; maintainer Linux-only waiver 2026-10-02.
    status: 'stable',
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
        // Bulk skills use an opt-in mirror; kernel skills stay native. Rule files
        // use the AGENTS.md hook. Agents/commands stay indexed via discover/show.
        agents: null,
        commands: null,
        skills: MUSE_STANDARD_SKILLS_PATH,
        rules: '.muse/rules',
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
      rules: '.muse/rules',
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
      contextFiles: { aiwgMd: true, agentsMd: false, claudeMdHook: false, hookFile: null, contextFile: '~/.openclaw/config.yaml' },
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
      contextFiles: { aiwgMd: true, agentsMd: false, claudeMdHook: false, hookFile: null, contextFile: 'AGENTS.md' },
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
];
