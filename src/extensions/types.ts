/**
 * Unified Extension Type System
 *
 * Provides a single schema for all AIWG extensions: agents, commands, skills,
 * hooks, tools, and MCP servers. Enables dynamic discovery, semantic search,
 * and unified help generation.
 *
 * @architecture @docs/architecture/cli/extending-cli.md
 * @version 1.0.0
 */

import type { Platform } from '../agents/types.js';

// ============================================
// Core Extension Schema
// ============================================

/**
 * Extension type discriminator
 */
export type ExtensionType =
  | 'agent'
  | 'command'
  | 'skill'
  | 'hook'
  | 'tool'
  | 'mcp-server'
  | 'framework'
  | 'addon'
  | 'template'
  | 'prompt'
  | 'soul'
  | 'behavior'
  | 'team';

/**
 * Types that are authored as source artifacts.
 *
 * Skills are the canonical source format for workflows. All new workflows
 * should be authored as skills, not commands.
 */
export type SourceExtensionType = Exclude<ExtensionType, 'command'>;

/**
 * Types that are generated at deploy time from source artifacts.
 *
 * Commands are generated from skills for providers that require command format
 * natively (Factory, OpenCode, Warp/Windsurf aggregation, legacy Codex).
 */
export type DeploymentExtensionType = 'command';

/**
 * Extension lifecycle status
 */
export type ExtensionStatus =
  | 'stable'
  | 'beta'
  | 'experimental'
  | 'deprecated'
  | 'archived';

/**
 * Platform support level
 */
export type PlatformSupport =
  | 'full'          // Fully supported with all features
  | 'partial'       // Supported with limitations
  | 'experimental'  // Experimental support
  | 'none';         // Not supported

/**
 * Platform compatibility matrix
 *
 * Keys mirror the provider registry (`PROVIDER_IDS` in
 * `src/providers/provider-definitions.ts`), the single source of truth for
 * provider ids (#3724).
 */
export type PlatformCompatibility = Partial<Record<Platform, PlatformSupport>>;

/**
 * A single .aiwg/ path entry in a memory footprint declaration
 */
export interface MemoryPath {
  /** Path relative to project root — always under .aiwg/ */
  path: string;
  /** Human-readable description of what this path contains */
  description: string;
}

/**
 * Declares what .aiwg/ paths a component creates when deployed
 *
 * Skills and agents can safely reference any path listed in `creates` from
 * an installed component — those paths are guaranteed to exist after deployment.
 *
 * @see docs/development/aiwg-dir-reference-contract.md
 */
export interface MemoryFootprint {
  /**
   * Directories and files this component creates or populates in .aiwg/
   *
   * Skills may safely reference any path listed here.
   *
   * @example [{ "path": ".aiwg/requirements/", "description": "User stories, use cases, NFRs" }]
   */
  creates?: MemoryPath[];

  /**
   * Specific files with documented schemas that skills can depend on
   *
   * These are primary context injection points — they have a defined structure
   * that skills can rely on.
   *
   * @example [{ "path": ".aiwg/AIWG.md", "description": "Project context entry point" }]
   */
  normalizedFiles?: MemoryPath[];

  /**
   * Semantic memory topology declaration
   *
   * When present, this component declares a structured semantic memory that
   * kernel skills (memory-ingest, memory-lint, memory-query-capture) can
   * operate on. The kernel reads this contract to parameterize behavior.
   *
   * @see ADR-021 — Semantic memory kernel architecture
   */
  topology?: MemoryTopology;
}

/**
 * Cross-reference style used when linking between pages in semantic memory.
 *
 * Kernel skills write cross-references per the consumer's declared style.
 * AIWG internal tooling (mention-wire, mention-lint) uses at-mention exclusively.
 */
export type CrossRefStyle = 'at-mention' | 'wikilink' | 'markdown-link' | 'yaml-ref';

/**
 * Semantic memory topology contract
 *
 * Declares how a consumer's semantic memory is organized — where raw sources
 * live, where derived pages go, how pages cross-reference each other, and
 * what validation the kernel should apply during ingest and lint.
 *
 * Read by kernel skills in `agentic/code/addons/semantic-memory/` to
 * parameterize topology-agnostic operations.
 *
 * @see ADR-021 decisions D2 (interface) and D3 (schema location)
 * @see https://git.integrolabs.net/roctinam/aiwg/issues/825
 */
export interface MemoryTopology {
  /**
   * Root namespace for this consumer's memory under .aiwg/
   *
   * @example ".aiwg/research"
   * @example ".aiwg/wiki"
   */
  namespace: string;

  /**
   * Directory where raw/original sources are stored before processing
   *
   * @example ".aiwg/research/sources"
   */
  rawSources: string;

  /**
   * Map of derived page categories to their storage directories
   *
   * Keys are semantic roles (summary, entity, concept, synthesis, etc.).
   * Values are directory paths under the namespace.
   *
   * @example { "summary": ".aiwg/research/summaries", "entity": ".aiwg/research/knowledge/entities" }
   */
  derivedPages: Record<string, string>;

  /**
   * Path to the master index file for this memory
   *
   * @example ".aiwg/research/index.md"
   */
  index: string;

  /**
   * Path to the append-only JSON Lines event log
   *
   * @example ".aiwg/research/.log.jsonl"
   */
  log: string;

  /**
   * How cross-references between pages are written
   *
   * @default "at-mention"
   */
  crossRefStyle: CrossRefStyle;

  /**
   * Path to the page template used when creating new derived pages
   *
   * Relative to the consumer's addon/framework root.
   *
   * @example "templates/research-page.md"
   */
  pageTemplate?: string;

  /**
   * Capabilities required during ingest
   *
   * Kernel checks these and delegates to the named capability providers.
   * Common values: "provenance", "grade-quality", "citation-guard"
   *
   * @example ["provenance", "grade-quality"]
   */
  ingestRequires?: string[];

  /**
   * Lint rule IDs to apply during memory-lint
   *
   * References existing skill or rule IDs (e.g., "citation-guard", "link-check").
   * The kernel composes these with its own structural checks.
   *
   * @example ["citation-guard", "link-check", "mention-lint"]
   */
  lintRules?: string[];
}

/**
 * Deployment configuration
 */
export interface DeploymentConfig {
  /**
   * Base deployment path template
   *
   * Variables: {platform}, {id}, {type}
   *
   * @example ".{platform}/agents/{id}.md"
   * @example ".{platform}/commands/{id}.md"
   */
  pathTemplate: string;

  /**
   * Platform-specific path overrides
   *
   * @example { "claude": ".claude/agents/api-designer.md" }
   */
  pathOverrides?: Record<string, string>;

  /**
   * Additional files that are part of this extension
   *
   * @example ["references/api-patterns.md", "templates/openapi.yaml"]
   */
  additionalFiles?: string[];

  /**
   * Whether this extension auto-installs
   *
   * @default false
   */
  autoInstall?: boolean;

  /**
   * Whether this is a core extension
   *
   * Core extensions are always available.
   *
   * @default false
   */
  core?: boolean;
}

/**
 * Unified Extension Schema
 *
 * Represents any AIWG extension: agent, command, skill, hook, tool, or MCP server.
 *
 * @version 1.0.0
 */
export interface Extension {
  // ============================================
  // Core Identity (Required)
  // ============================================

  /**
   * Unique identifier (kebab-case)
   *
   * @example "api-designer"
   * @example "mention-wire"
   * @example "voice-apply"
   */
  id: string;

  /**
   * Previous ID for backward compatibility.
   * Existing deployments using this ID continue to resolve until users re-run `aiwg use`.
   */
  legacyId?: string;

  /**
   * Extension type discriminator
   *
   * Used for type-safe narrowing and dispatch.
   */
  type: ExtensionType;

  /**
   * Human-readable name
   *
   * @example "API Designer"
   * @example "Mention Wire Command"
   */
  name: string;

  /**
   * Brief description (1-2 sentences)
   *
   * Should be clear enough for search results and help listings.
   */
  description: string;

  /**
   * Semantic version (semver or CalVer)
   *
   * @example "1.0.0"
   * @example "2026.1.5"
   */
  version: string;

  // ============================================
  // Discovery & Classification (Required)
  // ============================================

  /**
   * Capabilities this extension provides
   *
   * Used for capability-based discovery and semantic search.
   *
   * @example ["api-design", "interface-contracts", "rest"]
   * @example ["traceability", "@-mention", "validation"]
   */
  capabilities: string[];

  /**
   * Keywords for search and categorization
   *
   * @example ["sdlc", "architecture", "design"]
   * @example ["testing", "quality", "validation"]
   */
  keywords: string[];

  /**
   * Categorical classification
   *
   * Allows hierarchical organization.
   *
   * @example "sdlc/architecture"
   * @example "writing-quality/validation"
   */
  category?: string;

  // ============================================
  // Platform & Deployment (Required)
  // ============================================

  /**
   * Platform compatibility
   *
   * Indicates which AI platforms this extension works with.
   */
  platforms: PlatformCompatibility;

  /**
   * Deployment configuration
   *
   * Where and how this extension is deployed.
   */
  deployment: DeploymentConfig;

  // ============================================
  // Dependencies & Requirements (Optional)
  // ============================================

  /**
   * Other extensions required by this extension
   *
   * @example ["sdlc-complete", "aiwg-utils"]
   */
  requires?: string[];

  /**
   * Optional extensions that enhance functionality
   *
   * @example ["voice-framework", "writing-quality"]
   */
  recommends?: string[];

  /**
   * Extensions that conflict with this one
   *
   * @example ["legacy-agent-v1"]
   */
  conflicts?: string[];

  /**
   * System dependencies (CLI tools, packages)
   *
   * @example { "gh": ">=2.0.0", "jq": "*" }
   */
  systemDependencies?: Record<string, string>;

  // ============================================
  // Metadata & Documentation (Optional)
  // ============================================

  /**
   * Extension author
   *
   * @example "AIWG Contributors"
   * @example "John Magly <john@example.com>"
   */
  author?: string;

  /**
   * License identifier
   *
   * @example "MIT"
   * @example "Apache-2.0"
   */
  license?: string;

  /**
   * Repository URL
   *
   * @example "https://github.com/jmagly/aiwg"
   */
  repository?: string;

  /**
   * Homepage/documentation URL
   *
   * @example "https://aiwg.io/extensions/api-designer"
   */
  homepage?: string;

  /**
   * Bug tracker URL
   *
   * @example "https://github.com/jmagly/aiwg/issues"
   */
  bugs?: string;

  /**
   * Documentation paths relative to extension root
   *
   * @example { "readme": "README.md", "guide": "docs/guide.md" }
   */
  documentation?: Record<string, string>;

  /**
   * Research compliance metadata
   *
   * Links to research best practices and archetypes.
   */
  researchCompliance?: Record<string, string[]>;

  /**
   * .aiwg/ memory footprint declaration
   *
   * Declares what .aiwg/ paths this component creates when deployed.
   * Skills can safely @-reference any path declared in memory.creates.
   * Used by validate-component and dev-doctor to check link correctness.
   */
  memory?: MemoryFootprint;

  // ============================================
  // Type-Specific Data (Discriminated Union)
  // ============================================

  /**
   * Type-specific metadata
   *
   * The shape of this object depends on `type` field.
   * TypeScript will narrow this based on the discriminator.
   */
  metadata: ExtensionMetadata;

  // ============================================
  // Lifecycle & Status (Optional)
  // ============================================

  /**
   * Extension status
   *
   * @default "stable"
   */
  status?: ExtensionStatus;

  /**
   * Deprecation information
   */
  deprecation?: {
    /** When this extension was deprecated (ISO 8601) */
    date: string;
    /** Replacement extension ID */
    successor?: string;
    /** Deprecation reason */
    reason: string;
  };

  /**
   * Installation state tracking
   *
   * Populated by the runtime, not in manifest files.
   */
  installation?: {
    /** Install timestamp (ISO 8601) */
    installedAt: string;
    /** Installation source */
    installedFrom: 'builtin' | 'registry' | 'local' | 'git';
    /** Installation path */
    installedPath: string;
    /** Enabled state */
    enabled: boolean;
  };

  // ============================================
  // Validation & Quality (Optional)
  // ============================================

  /**
   * Extension checksum for integrity validation
   *
   * @example "sha256:abc123..."
   */
  checksum?: string;

  /**
   * Signature for authenticity verification
   */
  signature?: {
    algorithm: 'pgp' | 'ed25519';
    value: string;
    publicKey?: string;
  };
}

// ============================================
// Type-Specific Metadata
// ============================================

/**
 * Discriminated union of type-specific metadata
 */
export type ExtensionMetadata =
  | AgentMetadata
  | CommandMetadata
  | SkillMetadata
  | HookMetadata
  | ToolMetadata
  | MCPServerMetadata
  | FrameworkMetadata
  | AddonMetadata
  | TemplateMetadata
  | PromptMetadata
  | SoulMetadata
  | BehaviorMetadata;

/**
 * Agent-specific metadata
 */
export interface AgentMetadata {
  type: 'agent';

  /**
   * Agent role/expertise area
   *
   * @example "API Design and Contract Definition"
   */
  role: string;

  /**
   * Model selection
   *
   * Tier-based selection or specific model override.
   */
  model: {
    /** Tier preference */
    tier: 'haiku' | 'sonnet' | 'opus';
    /** Specific model override (optional) */
    override?: string;
  };

  /**
   * Tools this agent can use
   *
   * @example ["Read", "Write", "Bash"]
   */
  tools: string[];

  /**
   * Agent complexity template
   *
   * @example "simple" | "complex" | "orchestrator"
   */
  template?: string;

  /**
   * Maximum tool count
   */
  maxTools?: number;

  /**
   * Can delegate to other agents
   */
  canDelegate?: boolean;

  /**
   * Read-only mode (no Write/Bash)
   */
  readOnly?: boolean;

  /**
   * Agent workflow steps
   */
  workflow?: string[];

  /**
   * Agent expertise areas
   */
  expertise?: string[];

  /**
   * Agent responsibilities
   */
  responsibilities?: string[];
}

/**
 * Command argument definition
 */
export interface CommandArgument {
  name: string;
  description: string;
  required: boolean;
  type: 'string' | 'number' | 'boolean';
  default?: string | number | boolean;
  position?: number;
}

/**
 * Command option definition
 */
export interface CommandOption {
  name: string;
  description: string;
  type: 'string' | 'boolean' | 'number' | 'array';
  default?: string | boolean | number;
  short?: string;
  long?: string;
}

/**
 * Command-specific metadata
 *
 * @deprecated As a source format. Commands are now generated from skills at deploy time.
 * This type is retained for providers that require command format natively
 * (Factory, OpenCode, Warp/Windsurf aggregation, legacy Codex).
 * New workflows should use `type: 'skill'` with `commandHint` for translation metadata.
 *
 * @see SkillMetadata.commandHint
 */
export interface CommandMetadata {
  type: 'command';

  /**
   * Command template type
   */
  template: 'utility' | 'transformation' | 'orchestration';

  /**
   * Command arguments
   */
  arguments?: CommandArgument[];

  /**
   * Command options/flags
   */
  options?: CommandOption[];

  /**
   * Argument hint for help display
   *
   * @example "<file-path>"
   * @example "[options] <input>"
   */
  argumentHint?: string;

  /**
   * Allowed tools for this command
   *
   * @example ["Read", "Write", "Grep"]
   */
  allowedTools?: string[];

  /**
   * Model preference
   *
   * @example "sonnet"
   */
  model?: string;

  /**
   * Provider-neutral model policy. `model` remains readable during migration,
   * but new skills should declare role/tier intent instead of an exact ID.
   */
  modelRole?: 'reasoning' | 'coding' | 'efficiency';
  modelTier?: 'economy' | 'standard' | 'premium';
  modelEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  modelRationale?: string;

  /**
   * Execution steps
   */
  executionSteps?: string[];

  /**
   * Success criteria
   */
  successCriteria?: string[];

  /**
   * When true, this command is slash-command-only and has no CLI handler.
   * Exempts it from handler coverage checks.
   */
  cliDisabled?: boolean;

  /**
   * Skill ID that produced this command (set at generation time by the translation layer).
   * Present only on commands generated from skills, not hand-authored commands.
   */
  generatedFrom?: string;
}

/**
 * Skill reference material
 */
export interface SkillReference {
  /** Reference filename */
  filename: string;
  /** Reference description */
  description: string;
  /** Reference content path */
  path: string;
}

/**
 * Command translation hints for generating command artifacts from skills.
 *
 * Used by the skill→command translation layer when deploying to providers
 * that require command format natively (Factory, OpenCode, Warp/Windsurf, legacy Codex).
 */
export interface CommandHint {
  /**
   * Argument hint for help display
   *
   * @example "<file-path>"
   * @example "[options] <input>"
   */
  argumentHint?: string;

  /**
   * Allowed tools to declare in the generated command
   *
   * @example ["Read", "Write", "Grep"]
   */
  allowedTools?: string[];

  /**
   * Command template type for generated commands
   */
  template?: 'utility' | 'transformation' | 'orchestration';

  /**
   * Command arguments for generated command files
   */
  arguments?: CommandArgument[];

  /**
   * Command options/flags for generated command files
   */
  options?: CommandOption[];

  /**
   * Execution steps for generated command documentation
   */
  executionSteps?: string[];

  /**
   * Success criteria for generated command documentation
   */
  successCriteria?: string[];

  /**
   * Model preference for the generated command
   *
   * @example "sonnet"
   */
  model?: string;

  /**
   * When true, this skill has no CLI handler (slash-command-only).
   * Exempts it from handler coverage checks.
   */
  cliDisabled?: boolean;

  /**
   * When true, this skill is executed via `aiwg skills run` (provider dispatch)
   * rather than a bespoke TypeScript handler.
   * Exempts it from handler coverage checks.
   */
  executedViaSkillRunner?: boolean;
}

/**
 * Skill-specific metadata
 */
export interface SkillMetadata {
  type: 'skill';

  /**
   * Namespace prefix for collision avoidance (e.g., 'aiwg').
   * Canonical invocation slug: '{namespace}-{name}'
   *
   * @see adr-skill-namespace-strategy.md
   */
  namespace?: string;

  /**
   * Natural language trigger phrases
   *
   * @example ["what's next?", "project status", "where are we?"]
   */
  triggerPhrases: string[];

  /**
   * Whether this skill is auto-triggered
   *
   * @default false
   */
  autoTrigger?: boolean;

  /**
   * Auto-trigger conditions
   */
  autoTriggerConditions?: string[];

  /**
   * Tools this skill uses
   */
  tools?: string[];

  /**
   * Reference materials
   */
  references?: SkillReference[];

  /**
   * Input requirements
   */
  inputRequirements?: string[];

  /**
   * Output format description
   */
  outputFormat?: string;

  // ============================================
  // Official Claude Code SKILL.md Frontmatter
  // ============================================

  /**
   * Model effort override (1=low, 2=medium, 3=high)
   *
   * Controls reasoning effort when the skill is invoked.
   */
  effort?: 1 | 2 | 3;

  /**
   * Whether this skill can be invoked by the user via slash command.
   *
   * @default true
   */
  userInvocable?: boolean;

  /**
   * When true, prevents model from auto-invoking this skill.
   * The skill can only be triggered explicitly by the user.
   *
   * @default false
   */
  disableModelInvocation?: boolean;

  /**
   * Execution context isolation mode.
   *
   * - 'fork': Skill runs in an isolated context (new conversation)
   * - 'inherit': Skill runs in the current conversation context
   */
  context?: 'fork' | 'inherit';

  /**
   * Tool access restriction for this skill when invoked in Claude Code.
   *
   * Note: Distinct from `commandHint.allowedTools` which describes tools
   * declared in generated command files for legacy providers.
   */
  allowedTools?: string[];

  // ============================================
  // Command Translation
  // ============================================

  /**
   * Command translation hints for generating command artifacts.
   *
   * Used by the skill→command translation layer when deploying to providers
   * that require command format natively. Skills without `commandHint` will
   * still be translated using defaults derived from the skill's own fields.
   */
  commandHint?: CommandHint;
}

/**
 * Hook lifecycle events
 */
export type HookEvent =
  | 'pre-session'
  | 'post-session'
  | 'pre-command'
  | 'post-command'
  | 'pre-agent'
  | 'post-agent'
  | 'pre-write'
  | 'post-write'
  | 'pre-bash'
  | 'post-bash';

/**
 * Hook-specific metadata
 */
export interface HookMetadata {
  type: 'hook';

  /**
   * Hook lifecycle event
   *
   * @example "pre-session" | "post-session" | "pre-command" | "post-command"
   */
  event: HookEvent;

  /**
   * Hook priority (lower = earlier execution)
   *
   * @default 100
   */
  priority?: number;

  /**
   * Whether this hook can modify execution
   *
   * @default false
   */
  canModify?: boolean;

  /**
   * Whether this hook can block execution
   *
   * @default false
   */
  canBlock?: boolean;

  /**
   * Hook configuration schema
   */
  configSchema?: Record<string, unknown>;
}

/**
 * Tool-specific metadata
 */
export interface ToolMetadata {
  type: 'tool';

  /**
   * Tool category
   */
  category: 'core' | 'languages' | 'utilities' | 'custom';

  /**
   * Executable path or command
   */
  executable: string;

  /**
   * Tool verification status
   */
  verificationStatus?: 'verified' | 'unverified';

  /**
   * Last verified date (ISO 8601)
   */
  lastVerified?: string;

  /**
   * Manual page content
   */
  manPage?: string;

  /**
   * Tool aliases
   *
   * @example ["rg", "ripgrep"]
   */
  aliases?: string[];

  /**
   * Related tools
   *
   * @example ["grep", "ag", "ack"]
   */
  relatedTools?: string[];

  /**
   * Platform-specific notes
   */
  platformNotes?: Record<string, string>;

  /**
   * Installation hint
   */
  installHint?: string;
}

/**
 * MCP tool summary
 */
export interface MCPToolSummary {
  name: string;
  description: string;
  dangerous: boolean;
}

/**
 * MCP Server-specific metadata
 */
export interface MCPServerMetadata {
  type: 'mcp-server';

  /**
   * MCP protocol version
   *
   * @example "1.0"
   */
  mcpVersion: string;

  /**
   * Server transport type
   */
  transport: 'stdio' | 'http';

  /**
   * Server port (for HTTP transport)
   */
  port?: number;

  /**
   * Server capabilities
   */
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
    sampling: boolean;
    logging: boolean;
  };

  /**
   * Source type
   */
  sourceType: 'cli' | 'api' | 'catalog' | 'nl' | 'extension';

  /**
   * Base command (for CLI source)
   */
  sourceCommand?: string;

  /**
   * API base URL (for API source)
   */
  sourceBaseUrl?: string;

  /**
   * Working directory
   */
  workingDirectory?: string;

  /**
   * Environment variables
   */
  environment?: Record<string, string>;

  /**
   * Tool definitions
   */
  tools?: MCPToolSummary[];

  /**
   * Resource patterns
   */
  resources?: string[];

  /**
   * Available prompts
   */
  prompts?: string[];
}

/**
 * Framework-specific metadata
 */
/**
 * CI workflow artifacts declared by a framework.
 * Source files live under `{framework}/ci/{forge}/workflows/`.
 * Deployed to `.github/workflows/` or `.gitea/workflows/` when
 * `aiwg use <framework> --ci-hooks-enabled` is run.
 *
 * @implements #661
 */
export interface ManifestCiSpec {
  /** Paths relative to `ci/github/` to deploy to `.github/workflows/` */
  github?: string[];
  /** Paths relative to `ci/gitea/` to deploy to `.gitea/workflows/` */
  gitea?: string[];
}

export interface FrameworkMetadata {
  type: 'framework';

  /**
   * Framework domain
   *
   * @example "sdlc" | "marketing" | "security"
   */
  domain: string;

  /**
   * Included extension IDs
   */
  includes: {
    agents?: string[];
    commands?: string[];
    skills?: string[];
    hooks?: string[];
    templates?: string[];
    prompts?: string[];
  };

  /**
   * CI workflow artifacts for opt-in deployment via --ci-hooks-enabled.
   * @implements #661
   */
  ci?: ManifestCiSpec;

  /**
   * Framework configuration schema
   */
  configSchema?: Record<string, unknown>;

  /**
   * Default configuration
   */
  defaultConfig?: Record<string, unknown>;
}

/**
 * Addon-specific metadata
 */
export interface AddonMetadata {
  type: 'addon';

  /**
   * Addon entry points
   */
  entry: {
    agents?: string;
    commands?: string;
    skills?: string;
    hooks?: string;
    templates?: string;
    prompts?: string;
  };

  /**
   * Extensions this addon provides
   */
  provides: {
    agents?: string[];
    commands?: string[];
    skills?: string[];
    hooks?: string[];
    templates?: string[];
    prompts?: string[];
  };

  /**
   * CLI commands contributed to the `aiwg` binary
   *
   * Addon-contributed commands are dispatched as `aiwg <namespace> <subcommand>`.
   * Each subcommand maps to an mjs file that exports a default async function.
   * The `hook_event` field enables automatic Claude Code hook registration on deploy.
   *
   * @example
   * ```json
   * {
   *   "namespace": "my-addon",
   *   "description": "My addon lifecycle operations",
   *   "entry": "commands/",
   *   "subcommands": {
   *     "check": { "file": "commands/my-check.mjs", "description": "Validate completion" }
   *   }
   * }
   * ```
   */
  cli_commands?: {
    namespace: string;
    description: string;
    entry?: string;
    subcommands: Record<string, {
      file: string;
      description: string;
      hook_event?: string;
    }>;
  };
}

/**
 * Template variable definition
 */
export interface TemplateVariable {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  default?: unknown;
}

/**
 * Template-specific metadata
 */
export interface TemplateMetadata {
  type: 'template';

  /**
   * Template language/format
   *
   * @example "markdown" | "yaml" | "json" | "handlebars"
   */
  format: string;

  /**
   * Template variables
   */
  variables?: TemplateVariable[];

  /**
   * Template sections
   */
  sections?: string[];

  /**
   * Target artifact type
   *
   * @example "use-case" | "architecture-doc" | "test-plan"
   */
  targetArtifact?: string;
}

/**
 * Prompt-specific metadata
 */
export interface PromptMetadata {
  type: 'prompt';

  /**
   * Prompt category
   *
   * @example "core" | "reliability" | "agents"
   */
  category: string;

  /**
   * Prompt purpose
   */
  purpose: string;

  /**
   * When to use this prompt
   */
  useWhen: string[];

  /**
   * Prompt variables
   */
  variables?: string[];

  /**
   * Expected context
   */
  requiredContext?: string[];
}

/**
 * Soul-specific metadata
 *
 * Defines an AI agent's identity, worldview, and character.
 * Distinct from voice profiles (how content sounds) — soul defines
 * who the agent is.
 *
 * @see https://github.com/aaronjmars/soul.md
 */
export interface SoulMetadata {
  type: 'soul';

  /**
   * Soul scope
   *
   * @example "project" — applies to all agents in the project
   * @example "agent" — applies to a specific agent
   */
  scope: 'project' | 'agent';

  /**
   * Target agent name (required when scope is 'agent')
   *
   * @example "test-engineer"
   */
  targetAgent?: string;

  /**
   * Sections present in the soul file
   *
   * @example ["who-i-am", "worldview", "opinions", "vocabulary", "boundaries"]
   */
  sections: string[];

  /**
   * Companion files
   *
   * Optional related files in the soul ecosystem
   */
  companions?: {
    /** STYLE.md — writing style companion */
    style?: string;
    /** MEMORY.md — session memory */
    memory?: string;
    /** examples/ — calibration examples */
    examples?: string;
  };

  /**
   * Context budget estimate in tokens
   */
  estimatedTokens?: number;
}

/**
 * Behavior hook event types
 *
 * Events that behaviors can subscribe to on platforms with hook support.
 * Platforms without hook support ignore the hooks section and degrade
 * the behavior to a skill (NLP triggers only).
 */
export type BehaviorHookEvent =
  | 'on_file_write'
  | 'on_tool_complete'
  | 'on_schedule'
  | 'on_commit'
  | 'on_pr_open'
  | 'on_deploy'
  | 'on_session_start'
  | 'on_session_end';

/**
 * Behavior hook action configuration
 */
export interface BehaviorHookAction {
  /** Glob filter for file-based events */
  filter?: string;
  /** Tool name filter for on_tool_complete events */
  tool?: string;
  /** Cron expression for on_schedule events */
  cron?: string;
  /** Action to take when the hook fires */
  action: 'run_script' | 'notify' | 'log';
  /** Script to execute (relative to behavior directory) */
  script?: string;
}

/**
 * Behavior structured input definition
 */
export interface BehaviorInput {
  /** Input parameter name */
  name: string;
  /** Input type */
  type: 'string' | 'number' | 'boolean' | 'enum' | 'path';
  /** Whether this input is required */
  required?: boolean;
  /** Description of the input */
  description?: string;
  /** Default value */
  default?: string | number | boolean;
  /** Allowed values (for enum type) */
  values?: string[];
}

/**
 * Behavior-specific metadata
 *
 * Behaviors are reactive capabilities with scripts + hooks + structured inputs.
 * They extend beyond skills by subscribing to system events via hooks.
 * On platforms without hook support, behaviors degrade to skills gracefully.
 */
export interface BehaviorMetadata {
  type: 'behavior';

  /**
   * Natural language trigger phrases (invocation path — same as skills)
   *
   * @example ["run security scan", "check for vulnerabilities"]
   */
  triggerPhrases?: string[];

  /**
   * Structured input parameters
   */
  inputs?: BehaviorInput[];

  /**
   * Event hook subscriptions (reactive path — what makes it a behavior)
   *
   * Keyed by hook event type, each containing an array of hook actions.
   */
  hooks?: Partial<Record<BehaviorHookEvent, BehaviorHookAction[]>>;

  /**
   * Scripts associated with this behavior
   *
   * Keyed by logical name, value is the relative path from the behavior directory.
   *
   * @example { "main": "scripts/main.sh", "lint": "scripts/lint-on-write.sh" }
   */
  scripts?: Record<string, string>;

  /**
   * Behavior manifest — richer metadata than skills
   */
  manifest?: {
    /** Category for discovery */
    category?: string;
    /** Runtime requirements */
    requires?: {
      /** Required binaries */
      bins?: string[];
      /** Required environment variables */
      env?: string[];
    };
    /** Output descriptions */
    outputs?: Array<{
      type: string;
      path: string;
    }>;
    /** Behaviors this composes with */
    composable_with?: string[];
  };
}

// ============================================
// Capability Index
// ============================================

/**
 * Capability index for semantic search
 *
 * This index enables fast capability-based discovery.
 */
export interface CapabilityIndex {
  /**
   * Index version
   */
  version: string;

  /**
   * Index generation timestamp (ISO 8601)
   */
  generated: string;

  /**
   * Capability to extensions mapping
   *
   * Key: capability name
   * Value: list of extension IDs that provide it
   */
  capabilities: Record<string, string[]>;

  /**
   * Keyword to extensions mapping
   *
   * Key: keyword
   * Value: list of extension IDs tagged with it
   */
  keywords: Record<string, string[]>;

  /**
   * Category to extensions mapping
   *
   * Key: category path
   * Value: list of extension IDs in that category
   */
  categories: Record<string, string[]>;

  /**
   * Type to extensions mapping
   *
   * Key: extension type
   * Value: list of extension IDs of that type
   */
  types: Record<ExtensionType, string[]>;

  /**
   * Platform to extensions mapping
   *
   * Key: platform name
   * Value: list of extension IDs supporting that platform
   */
  platforms: Record<string, string[]>;

  /**
   * Full-text search index (inverted index)
   *
   * Key: term (lowercased)
   * Value: list of extension IDs containing that term
   */
  searchIndex: Record<string, string[]>;
}

/**
 * Capability search query
 */
export interface CapabilityQuery {
  /**
   * Required capabilities (AND)
   */
  requires?: string[];

  /**
   * Optional capabilities (OR)
   */
  prefers?: string[];

  /**
   * Extension type filter
   */
  type?: ExtensionType | ExtensionType[];

  /**
   * Platform filter
   */
  platform?: string;

  /**
   * Keyword filter
   */
  keywords?: string[];

  /**
   * Category filter
   */
  category?: string;

  /**
   * Full-text search
   */
  search?: string;

  /**
   * Status filter
   */
  status?: ExtensionStatus[];
}

/**
 * Capability search result
 */
export interface CapabilitySearchResult {
  /**
   * Matching extensions
   */
  extensions: Extension[];

  /**
   * Result count
   */
  count: number;

  /**
   * Match scores (0-1, higher is better)
   *
   * Key: extension ID
   * Value: relevance score
   */
  scores: Record<string, number>;

  /**
   * Search metadata
   */
  metadata: {
    query: CapabilityQuery;
    executedAt: string;
    executionTimeMs: number;
  };
}

// ============================================
// Validation
// ============================================

/**
 * Field constraint definition
 */
export interface Constraint {
  /** Minimum value (for numbers/lengths) */
  min?: number;
  /** Maximum value (for numbers/lengths) */
  max?: number;
  /** Allowed values (enum) */
  enum?: unknown[];
  /** Custom validation function */
  validate?: (value: unknown) => boolean;
  /** Error message */
  message: string;
}

/**
 * Cross-field validation rule
 */
export interface CrossFieldRule {
  /** Rule description */
  description: string;
  /** Fields involved */
  fields: string[];
  /** Validation function */
  validate: (extension: Extension) => boolean;
  /** Error message */
  message: string;
}

/**
 * Extension validation rules
 */
export interface ValidationRules {
  /**
   * Required fields for all extensions
   */
  required: string[];

  /**
   * Field type constraints
   */
  types: Record<string, string>;

  /**
   * Field format patterns (regex)
   */
  patterns: Record<string, string>;

  /**
   * Field value constraints
   */
  constraints: Record<string, Constraint>;

  /**
   * Cross-field validation rules
   */
  crossFieldRules: CrossFieldRule[];

  /**
   * Type-specific validation rules
   */
  typeSpecificRules: Record<ExtensionType, ValidationRules>;
}

/**
 * Validation error
 */
export interface ValidationError {
  /** Error type */
  type: 'required' | 'type' | 'format' | 'constraint' | 'cross-field';

  /** Field path */
  field: string;

  /** Error message */
  message: string;

  /** Current value */
  value?: unknown;

  /** Expected value/format */
  expected?: unknown;

  /** Suggestion for fix */
  suggestion?: string;
}

/**
 * Validation warning
 */
export interface ValidationWarning {
  /** Warning type */
  type: 'deprecated' | 'missing-optional' | 'best-practice';

  /** Field path */
  field: string;

  /** Warning message */
  message: string;

  /** Recommendation */
  recommendation?: string;
}

/**
 * Validation result
 */
export interface ExtensionValidationResult {
  /** Whether extension is valid */
  valid: boolean;

  /** Validation errors */
  errors: ValidationError[];

  /** Validation warnings */
  warnings: ValidationWarning[];

  /** Extension being validated */
  extension: Extension;
}

// ============================================
// Migration
// ============================================

/**
 * Migration mapping from existing formats to unified schema
 */
export interface MigrationMapping {
  /**
   * Source format identifier
   */
  sourceFormat: string;

  /**
   * Target schema version
   */
  targetVersion: string;

  /**
   * Field mappings
   *
   * Key: target field path (dot-notation)
   * Value: source field path or transform function name
   */
  fieldMappings: Record<string, string>;

  /**
   * Default values for new fields
   */
  defaults: Record<string, unknown>;

  /**
   * Custom transform functions
   */
  transforms?: Record<string, (value: unknown) => unknown>;
}

// ============================================
// Type Guards
// ============================================

/**
 * Type guard for agent extensions
 */
export function isAgentExtension(ext: Extension): ext is Extension & { metadata: AgentMetadata } {
  return ext.type === 'agent' && ext.metadata.type === 'agent';
}

/**
 * Type guard for command extensions
 */
export function isCommandExtension(ext: Extension): ext is Extension & { metadata: CommandMetadata } {
  return ext.type === 'command' && ext.metadata.type === 'command';
}

/**
 * Type guard for skill extensions
 */
export function isSkillExtension(ext: Extension): ext is Extension & { metadata: SkillMetadata } {
  return ext.type === 'skill' && ext.metadata.type === 'skill';
}

/**
 * Type guard for hook extensions
 */
export function isHookExtension(ext: Extension): ext is Extension & { metadata: HookMetadata } {
  return ext.type === 'hook' && ext.metadata.type === 'hook';
}

/**
 * Type guard for tool extensions
 */
export function isToolExtension(ext: Extension): ext is Extension & { metadata: ToolMetadata } {
  return ext.type === 'tool' && ext.metadata.type === 'tool';
}

/**
 * Type guard for MCP server extensions
 */
export function isMCPServerExtension(ext: Extension): ext is Extension & { metadata: MCPServerMetadata } {
  return ext.type === 'mcp-server' && ext.metadata.type === 'mcp-server';
}

/**
 * Type guard for framework extensions
 */
export function isFrameworkExtension(ext: Extension): ext is Extension & { metadata: FrameworkMetadata } {
  return ext.type === 'framework' && ext.metadata.type === 'framework';
}

/**
 * Type guard for addon extensions
 */
export function isAddonExtension(ext: Extension): ext is Extension & { metadata: AddonMetadata } {
  return ext.type === 'addon' && ext.metadata.type === 'addon';
}

/**
 * Type guard for template extensions
 */
export function isTemplateExtension(ext: Extension): ext is Extension & { metadata: TemplateMetadata } {
  return ext.type === 'template' && ext.metadata.type === 'template';
}

/**
 * Type guard for prompt extensions
 */
export function isPromptExtension(ext: Extension): ext is Extension & { metadata: PromptMetadata } {
  return ext.type === 'prompt' && ext.metadata.type === 'prompt';
}

/**
 * Type guard for soul extensions
 */
export function isSoulExtension(ext: Extension): ext is Extension & { metadata: SoulMetadata } {
  return ext.type === 'soul' && ext.metadata.type === 'soul';
}

/**
 * Type guard for behavior extensions
 */
export function isBehaviorExtension(ext: Extension): ext is Extension & { metadata: BehaviorMetadata } {
  return ext.type === 'behavior' && ext.metadata.type === 'behavior';
}
