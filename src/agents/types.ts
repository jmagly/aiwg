/**
 * Agent Deployment System - Type Definitions
 *
 * Defines interfaces and types for multi-platform agent deployment.
 */

/**
 * Supported deployment platforms/providers.
 *
 * | Platform   | Agent Location           | Config File          | Status        |
 * |------------|--------------------------|----------------------|---------------|
 * | claude     | .claude/agents/          | CLAUDE.md            | ✅ Full       |
 * | factory    | .factory/droids/         | AGENTS.md            | ✅ Full       |
 * | cursor     | .cursor/agents/          | .cursor/rules/ (MDC) | ✅ Full       |
 * | codex      | .codex/agents/           | AGENTS.md            | ✅ Full       |
 * | opencode   | .opencode/agent/         | AGENTS.md            | ✅ Full       |
 * | warp       | .warp/agents/            | WARP.md              | ✅ Full       |
 * | windsurf   | .windsurf/agents/        | .windsurfrules       | ✅ Devin Desktop compatibility adapter |
 * | copilot    | .github/agents/          | copilot-instructions | ✅ Full       |
 * | hermes     | ~/.hermes/skills/        | AGENTS.md            | optional MCP sidecar |
 * | openclaw   | ~/.openclaw/agents/      | AGENTS.md            | ✅ Full       |
 * | openhuman  | .agents/agents/          | AGENTS.md            | ✅ Full       |
 * | pi         | .agents/skills/          | AGENTS.md            | experimental |
 * | deepseek-harness | .agents/skills/    | AGENTS.md            | experimental |
 * | generic    | agents/                  | varies               | ✅ Full       |
 *
 * CLI usage: --provider <platform> or --platform <platform>
 */
export type Platform = 'antigravity' | 'claude' | 'codex' | 'copilot' | 'cursor' | 'deepseek-harness' | 'factory' | 'grokbot' | 'hermes' | 'opencode' | 'openclaw' | 'openhuman' | 'pi' | 'omp' | 'warp' | 'windsurf' | 'generic';
export type AgentCategory = 'writing-quality' | 'sdlc' | 'security' | 'testing' | 'architecture' | 'documentation' | 'general';
export type ArtifactType = 'agent' | 'command' | 'skill' | 'rule';
export type SupportLevel = 'native' | 'conventional' | 'aggregated' | 'indexed';

/**
 * Provider path configuration (all four artifact types required)
 */
export interface ProviderPaths {
  agents: string;
  commands: string;
  skills: string;
  rules: string;
}

/**
 * Support level per artifact type for a provider
 */
export interface ProviderSupport {
  agents: SupportLevel;
  commands: SupportLevel;
  skills: SupportLevel;
  rules: SupportLevel;
}

/**
 * Agent metadata from frontmatter
 */
export interface AgentMetadata {
  name: string;
  description: string;
  category?: AgentCategory;
  model?: string;
  /** OMP native model priority order, when explicitly configured. */
  modelPriority?: string[];
  thinkingLevel?: string;
  spawns?: string[] | '*';
  blocking?: boolean;
  output?: unknown;
  autoloadSkills?: string[];
  readSummarize?: boolean;
  prewalk?: boolean | string;
  advisor?: boolean | string;
  modelRole?: 'reasoning' | 'coding' | 'efficiency';
  modelTier?: 'economy' | 'standard' | 'premium' | 'max-quality';
  tools?: string[];
  dependencies?: string[];
  version?: string;
  /**
   * Natural-language routing phrases for `aiwg discover`. When declared it
   * must be a non-empty array of non-empty strings — an explicit empty
   * `triggers: []` is the discoverability anti-pattern (#1623). Optional:
   * omitting it is allowed; declaring it empty is not.
   */
  triggers?: string[];
}

/**
 * Parsed agent information
 */
export interface AgentInfo {
  metadata: AgentMetadata;
  content: string;
  filePath: string;
  fileName: string;
}

/**
 * Deployment target specification
 */
export interface DeploymentTarget {
  platform: Platform;
  projectPath: string;
  agentsPath?: string; // Custom agents directory (default: .{platform}/agents)
}

/**
 * Deployment options
 */
export interface DeploymentOptions {
  categories?: AgentCategory[];
  agentNames?: string[];
  dryRun?: boolean;
  force?: boolean;
  backup?: boolean;
  verbose?: boolean;
}

/**
 * Validation issue
 */
export interface ValidationIssue {
  type: 'error' | 'warning' | 'info';
  field: string;
  message: string;
  suggestion?: string;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  agent: AgentInfo;
}

/**
 * Deployment result for a single agent
 */
export interface AgentDeploymentResult {
  agent: AgentInfo;
  success: boolean;
  targetPath: string;
  error?: string;
}

/**
 * Overall deployment result
 */
export interface DeploymentResult {
  platform: Platform;
  projectPath: string;
  deployed: AgentDeploymentResult[];
  skipped: AgentInfo[];
  failed: { agent: AgentInfo; error: string }[];
  backupPath?: string;
  totalAgents: number;
  deployedCount: number;
  skippedCount: number;
  failedCount: number;
}

/**
 * Agent packaging result
 */
export interface PackagedAgent {
  agent: AgentInfo;
  content: string;
  format: Platform;
}
