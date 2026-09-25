/**
 * Skills Registry Types
 *
 * Defines the RegistryAdapter interface and result types for
 * provider-agnostic skill search, install, and publish operations.
 *
 * @implements #539
 */

/**
 * Skill search result
 */
export interface SkillResult {
  /** Skill name (e.g., "parallel-dispatch") */
  name: string;

  /** Human-readable description */
  description: string;

  /** Source registry (e.g., "local", "clawhub", "openclaw") */
  source: string;

  /** Framework or addon that provides this skill */
  package?: string;

  /** Supported platforms */
  platforms?: string[];

  /** Whether the skill is installed locally */
  installed?: boolean;
}

/**
 * Detailed skill information
 */
export interface SkillDetails extends SkillResult {
  /** Version string */
  version?: string;

  /** Natural language trigger phrases */
  triggers?: string[];

  /** Tools this skill uses */
  tools?: string[];

  /** File path (for local skills) */
  path?: string;

  /** Scripts associated with this skill */
  scripts?: string[];

  /** Input requirements */
  inputRequirements?: string[];

  /** Output format description */
  outputFormat?: string;

  /** Full markdown content */
  content?: string;

  /** Managed import provenance, trust, diagnostics, and location */
  imported?: AgentSkillImportResult;
}

/**
 * Install options for cross-platform deployment
 */
export interface InstallOptions {
  /** Target platform for deployment (claude, copilot, cursor, etc.) */
  target?: string;

  /** Project directory to install into */
  projectDir: string;

  /** Artifact type to install (skill, agent, command, rule) */
  artifactType?: 'skill' | 'agent' | 'command' | 'rule';
}

export type AgentSkillImportSource =
  | {
      kind: 'directory';
      path: string;
    }
  | {
      kind: 'git';
      url: string;
      revision: string;
      subpath: string;
    };

export interface AgentSkillImportLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
  maxGitRepositoryBytes: number;
}

export interface AgentSkillImportOptions {
  projectDir: string;
  profile?: 'strict' | 'compatible';
  dryRun?: boolean;
  update?: boolean;
  force?: boolean;
  trust?: boolean;
  activate?: boolean;
  limits?: Partial<AgentSkillImportLimits>;
  importedAt?: string;
  aiwgVersion?: string;
}

export interface AgentSkillImportDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  file: string;
  yamlPath: string;
  message: string;
  upstreamBaseline: string;
  remediation: string;
}

export interface AgentSkillImportResult {
  schemaVersion: 1;
  status: 'imported' | 'updated' | 'unchanged' | 'planned';
  dryRun: boolean;
  name: string;
  description: string;
  digest: string;
  source:
    | {
        kind: 'directory';
        locator: string;
      }
    | {
        kind: 'git';
        locator: string;
        subpath: string;
        requestedRevision: string;
        resolvedRevision: string;
      };
  validationProfile: 'strict' | 'compatible';
  diagnostics: AgentSkillImportDiagnostic[];
  trust: {
    state: 'untrusted' | 'trusted';
    activation: 'inactive' | 'active';
  };
  importedAt: string;
  aiwgVersion: string;
  managedLocation: string;
  fileCount: number;
  totalBytes: number;
}

export interface AgentSkillDeploymentOptions {
  projectDir: string;
  target: string;
  homeDir?: string;
  dryRun?: boolean;
  /**
   * Projection scope for providers with distinct project and user roots
   * (muse). Defaults to the provider's skill namespace (project for muse).
   */
  scope?: 'project' | 'user';
}

export type AgentSkillDeploymentOutcome =
  | 'deployed'
  | 'updated'
  | 'unchanged'
  | 'planned'
  | 'removed'
  | 'absent'
  | 'blocked';

export interface AgentSkillDeploymentResult {
  schemaVersion: 1;
  operation: 'deploy' | 'uninstall';
  outcome: AgentSkillDeploymentOutcome;
  dryRun: boolean;
  name: string;
  provider: string;
  projectionStatus: 'native' | 'projected' | 'degraded' | 'unsupported';
  path: string;
  reasons: string[];
  warnings: string[];
  sourceDigest: string;
}

export interface AgentSkillExportOptions {
  outDir: string;
  dryRun?: boolean;
  force?: boolean;
  exportedAt?: string;
  aiwgVersion?: string;
}

export interface AgentSkillExportResult {
  schemaVersion: 1;
  status: 'planned' | 'exported' | 'updated' | 'unchanged';
  dryRun: boolean;
  name: string;
  description: string;
  sourcePath: string;
  outputPath: string;
  sourceDigest: string;
  exportDigest: string;
  omittedAiwgFields: string[];
  fileCount: number;
  totalBytes: number;
  exportedAt: string;
  aiwgVersion: string;
}

/**
 * Registry adapter interface
 *
 * All skill registries (local, clawhub, openclaw, agentskills)
 * implement this interface for uniform access.
 */
export interface RegistryAdapter {
  /** Registry identifier */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Whether this adapter is available (e.g., CLI installed, API reachable) */
  isAvailable(): Promise<boolean>;

  /** Search for skills matching a query */
  search(query: string): Promise<SkillResult[]>;

  /** Get detailed information about a specific skill */
  info(name: string): Promise<SkillDetails | undefined>;

  /** List all available skills */
  list(): Promise<SkillResult[]>;

  /** Install a skill to a target directory with cross-platform translation */
  install?(name: string, options: InstallOptions): Promise<void>;

  /** Import a byte-preserved Agent Skills source into the managed store */
  importSource?(
    source: AgentSkillImportSource,
    options: AgentSkillImportOptions,
  ): Promise<AgentSkillImportResult>;

  /** Publish a skill package to the registry */
  publish?(packageDir: string): Promise<void>;
}
