// Built-in provider startup contracts used by the shared context graph.
import type { Platform } from '../agents/types.js';
import type { ProviderContextContract } from './provider-definition-schema.js';

const VERIFIED_ON = '2026-07-21';

export const CONTEXT_CONTRACTS: Record<Platform, ProviderContextContract> = {
  flue: {
    startupFiles: ['AGENTS.md'], precedence: ['provider/system', 'cwd AGENTS.md bytes'],
    loadMode: 'prose-directive', includeSyntax: null, configRegistration: null,
    bootstrapTargets: ['AGENTS.md'], maxContextBytes: null, recommendedMaxLines: null,
    nestedContext: false, support: 'supported',
    verification: { method: 'Installed Flue 2.3.0 source; context must be inlined',
      source: '@flue/runtime/dist/conversation-stream-store-CXrgv-b0.mjs:339-349,463-482', lastVerified: '2026-10-30' },
  },
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
  // (first-run trust prompt). AIWG deploys a discover-first AGENTS.md bridge.
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

