/**
 * MCPsmith Type Definitions
 *
 * Types for MCP server generation from various sources.
 *
 * @architecture @docs/smithing/mcpsmith.md
 * @implements @docs/smithing/mcpsmith.md
 */

// ============================================
// Server Configuration Types
// ============================================

export interface MCPServerConfig {
  $schema?: string;
  server: {
    name: string;
    version: string;
    description: string;
  };
  transport: {
    type: 'stdio' | 'http';
    options?: {
      port?: number;
      host?: string;
    };
  };
  source: {
    type: 'cli' | 'api' | 'catalog' | 'nl' | 'extension';
    command?: string;
    baseUrl?: string;
    workingDirectory: string;
    environment: Record<string, string>;
    timeout: number;
  };
  tools: {
    prefix: string;
    allowlist: string[];
    denylist: string[];
    dangerousCommands: {
      require_confirmation: string[];
      blocked: string[];
    };
  };
  resources: {
    enabled: boolean;
    patterns: string[];
  };
  prompts: {
    enabled: boolean;
  };
  security: {
    sandboxed: boolean;
    maxExecutionTime: number;
    allowedPaths: string[];
    blockedCommands: string[];
    requireConfirmation: string[];
  };
  logging: {
    enabled: boolean;
    level: 'debug' | 'info' | 'warn' | 'error';
    maxFiles: number;
    maxSize: string;
  };
}

// ============================================
// Tool Definition Types
// ============================================

export interface MCPToolDefinition {
  name: string;
  title: string;
  description: string;
  source: {
    type: 'cli' | 'api' | 'function';
    // CLI source
    command?: string;
    subcommand?: string;
    mapping?: Record<string, {
      flag?: string;
      position?: number;
      type: 'string' | 'boolean' | 'number' | 'array';
      transform?: string;
    }>;
    // API source
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    endpoint?: string;
    headers?: Record<string, string>;
    bodyMapping?: Record<string, string>;
    // Function source
    handler?: string;
  };
  inputSchema: {
    type: 'object';
    properties: Record<string, JSONSchema>;
    required?: string[];
  };
  outputSchema?: {
    type: string;
    properties?: Record<string, JSONSchema>;
  };
  examples: Array<{
    name: string;
    input: Record<string, unknown>;
    description: string;
  }>;
  metadata: {
    dangerous: boolean;
    requiresConfirmation: boolean;
    timeout?: number;
    retryable: boolean;
  };
}

export interface JSONSchema {
  type: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: JSONSchema;
  properties?: Record<string, JSONSchema>;
  required?: string[];
}

// ============================================
// Registry Types
// ============================================

export interface MCPServerRegistry {
  $schema: string;
  version: string;
  servers: MCPServerEntry[];
  integration: {
    aiwgMcp: {
      enabled: boolean;
      autoRegister: boolean;
      resourcePrefix: string;
    };
    platforms: {
      claude: boolean;
      factory: boolean;
      codex: boolean;
      cursor: boolean;
    };
  };
  defaults: {
    transport: 'stdio' | 'http';
    sandbox: boolean;
    timeout: number;
  };
}

export interface MCPServerEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  source: {
    type: 'cli' | 'api' | 'catalog' | 'nl' | 'extension';
    command?: string;
    specFile?: string;
    catalogFile?: string;
    description?: string;
    basePath?: string;
    discovery: string;
  };
  status: 'active' | 'inactive' | 'error' | 'generating';
  path: string;
  transport: 'stdio' | 'http';
  port?: number;
  createdAt: string;
  updatedAt: string;
  tools: string[];
  resources: string[];
  prompts: string[];
  health: {
    status: 'healthy' | 'unhealthy' | 'unknown';
    lastCheck: string;
    errorMessage?: string;
  };
  platforms?: {
    claude?: boolean;
    factory?: boolean;
    codex?: boolean;
    cursor?: boolean;
  };
}

// ============================================
// Manifest Types
// ============================================

export interface MCPServerManifest {
  $schema: string;
  id: string;
  name: string;
  version: string;
  mcpVersion: string;
  generated: {
    at: string;
    by: string;
    from: {
      type: string;
      source: string;
      version?: string;
    };
  };
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
    sampling: boolean;
    logging: boolean;
  };
  tools: MCPToolManifest[];
  resources: MCPResourceManifest[];
  prompts: MCPPromptManifest[];
  dependencies: {
    runtime: string[];
    external: string[];
  };
  files: string[];
  checksum: string;
}

export interface MCPToolManifest {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  dangerous: boolean;
  requiresConfirmation: boolean;
}

export interface MCPResourceManifest {
  name: string;
  uri: string;
  uriTemplate?: string;
  description: string;
  mimeType?: string;
}

export interface MCPPromptManifest {
  name: string;
  description: string;
  arguments: Array<{
    name: string;
    description: string;
    required: boolean;
  }>;
}

// ============================================
// Analyzer Types
// ============================================

export interface AnalyzerResult {
  tools: MCPToolDefinition[];
  resources?: MCPResourceDefinition[];
  metadata: {
    sourceType: 'cli' | 'api' | 'catalog' | 'nl';
    sourceName: string;
    sourceVersion?: string;
    discoveredAt: string;
    toolCount: number;
  };
}

export interface MCPResourceDefinition {
  name: string;
  uri: string;
  uriTemplate?: string;
  description: string;
  mimeType: string;
  source: {
    type: 'cli' | 'api' | 'file' | 'function';
    command?: string;
    args?: string[];
    method?: string;
    endpoint?: string;
    path?: string;
    handler?: string;
  };
  cache: {
    enabled: boolean;
    ttl: number;
  };
}

// ============================================
// CLI Analyzer Types
// ============================================

export interface CLIAnalyzerOptions {
  command: string;
  includeSubcommands?: boolean;
  maxDepth?: number;
  timeout?: number;
  parseManPage?: boolean;
}

export interface ParsedCLIHelp {
  command: string;
  description: string;
  version?: string;
  subcommands: ParsedSubcommand[];
  globalFlags: ParsedFlag[];
}

export interface ParsedSubcommand {
  name: string;
  description: string;
  flags: ParsedFlag[];
  arguments: ParsedArgument[];
}

export interface ParsedFlag {
  short?: string;
  long?: string;
  description: string;
  type: 'string' | 'boolean' | 'number' | 'array';
  required: boolean;
  default?: string;
}

export interface ParsedArgument {
  name: string;
  description: string;
  type: 'string' | 'number';
  required: boolean;
  position: number;
}

// ============================================
// Generator Types
// ============================================

export interface GeneratorOptions {
  serverId: string;
  serverName: string;
  description: string;
  analyzerResult: AnalyzerResult;
  config: Partial<MCPServerConfig>;
  outputDir: string;
}

export interface GeneratedServer {
  id: string;
  path: string;
  files: {
    server: string;
    manifest: string;
    config: string;
    tools: string[];
  };
}
