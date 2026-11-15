/**
 * Type definitions for Toolsmith feature
 *
 * @architecture @docs/smithing/toolsmith.md
 * @architecture @docs/smithing/toolsmith.md
 */

/**
 * Tool category classification
 */
export type ToolCategory = 'core' | 'languages' | 'utilities' | 'custom';

/**
 * Operating system platform
 */
export type Platform = 'linux' | 'macos' | 'windows' | 'wsl';

/**
 * Tool verification status
 */
export type ToolStatus = 'verified' | 'unverified';

/**
 * Runtime environment information
 */
export interface EnvironmentInfo {
  os: 'linux' | 'darwin' | 'win32';
  osVersion: string;
  arch: 'x64' | 'arm64' | 'x86';
  shell: string;
  homeDir: string;
  workingDir: string;
}

/**
 * System resource information
 */
export interface ResourceInfo {
  diskFreeGb: number;
  memoryTotalGb: number;
  memoryAvailableGb: number;
  cpuCores: number;
}

/**
 * Cataloged tool entry
 */
export interface CatalogedTool {
  id: string;
  name: string;
  category: ToolCategory;
  version: string;
  path: string;
  status: ToolStatus;
  lastVerified: string; // ISO 8601
  capabilities: string[];
  manPage?: string;
  documentation?: string;
  aliases: string[];
  relatedTools: string[];
}

/**
 * Unavailable tool entry
 */
export interface UnavailableTool {
  id: string;
  reason: 'not-installed' | 'version-mismatch' | 'broken';
  installHint?: string;
}

/**
 * Complete runtime catalog
 */
export interface RuntimeCatalog {
  $schema: string;
  version: '1.0';
  generated: string; // ISO 8601
  inputFingerprint?: string;
  delta?: { added: string[]; removed: string[] };
  environment: EnvironmentInfo;
  resources: ResourceInfo;
  tools: CatalogedTool[];
  unavailable: UnavailableTool[];
}

/**
 * Tool verification result
 */
export interface VerificationResult {
  valid: number;
  total: number;
  failed: CatalogedTool[];
  timestamp: string;
}

/**
 * Runtime summary for display
 */
export interface RuntimeSummary {
  environment: EnvironmentInfo;
  resources: ResourceInfo;
  toolCounts: Record<ToolCategory, number>;
  totalTools: number;
  lastDiscovery: string;
  catalogPath: string;
}

/**
 * Individual tool check result
 */
export interface ToolCheckResult {
  id: string;
  available: boolean;
  version?: string;
  path?: string;
  status?: ToolStatus;
  lastVerified?: string;
  installHint?: string;
}

/**
 * Custom tool configuration
 */
export interface CustomToolConfig {
  id: string;
  name: string;
  path: string;
  category: ToolCategory;
  capabilities: string[];
  documentation?: string;
  aliases?: string[];
}

/**
 * Tool specification frontmatter
 */
export interface ToolSpecFrontmatter {
  id: string;
  name: string;
  version: string;
  category: ToolCategory;
  platform: Platform;
  platformNotes?: string;
  status: 'verified' | 'unverified' | 'unavailable';
  verifiedDate: string; // YYYY-MM-DD
  capabilities: string[];
  synopsis: string;
}

/**
 * Complete tool specification
 */
export interface ToolSpecification {
  id: string;
  name: string;
  version: string;
  category: ToolCategory;
  platform: Platform;
  platformNotes: string;
  status: 'verified' | 'unverified' | 'unavailable';
  synopsis: string;
  rawContent: string; // Full markdown content
}

/**
 * Toolsmith configuration
 */
export interface ToolsmithConfig {
  $schema: string;
  version: '1.0';
  discovery: {
    autoDiscoverOnInit: boolean;
    refreshIntervalHours: number;
    categories: ToolCategory[];
    excludePatterns: string[];
    includeSystemPath: boolean;
    additionalPaths: string[];
  };
  generation: {
    preferLocalManPages: boolean;
    fetchRemoteDocs: boolean;
    includeExamples: boolean;
    exampleCount: number;
    platformAdaptation: boolean;
  };
  caching: {
    enabled: boolean;
    ttlDays: number;
    maxCacheSizeMb: number;
    autoUpdateOnVersionChange: boolean;
  };
  output: {
    format: 'markdown';
    includeFrontmatter: boolean;
    compactMode: boolean;
  };
}

/**
 * Known tool database entry
 */
export interface KnownToolEntry {
  category: ToolCategory;
  capabilities: string[];
  documentation?: string;
  aliases: string[];
  relatedTools: string[];
  versionPattern: string;
  examples: Array<{
    cmd: string;
    desc: string;
  }>;
}
