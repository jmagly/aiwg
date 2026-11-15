/**
 * MCPsmith Server Generator
 *
 * Generates complete MCP servers from analyzer results.
 *
 * @architecture @docs/smithing/mcpsmith.md
 * @implements @docs/smithing/mcpsmith.md
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import type {
  GeneratorOptions,
  GeneratedServer,
  MCPServerConfig,
  MCPServerManifest,
  MCPToolDefinition
} from './types.js';
import { projectAiwgPath } from '../../config/project-artifacts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Generate MCP server from analyzer result
 */
export async function generateServer(options: GeneratorOptions): Promise<GeneratedServer> {
  const {
    serverId,
    serverName,
    description,
    analyzerResult,
    config,
    outputDir
  } = options;

  // Create server directory
  const serverPath = path.join(outputDir, serverId);
  await fs.mkdir(serverPath, { recursive: true });
  await fs.mkdir(path.join(serverPath, 'tools'), { recursive: true });

  // Generate config
  const serverConfig = createConfig(serverId, serverName, description, analyzerResult, config);
  const configPath = path.join(serverPath, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(serverConfig, null, 2), 'utf-8');

  // Generate tool definition files
  const toolPaths: string[] = [];
  for (const tool of analyzerResult.tools) {
    const toolPath = path.join(serverPath, 'tools', `${tool.name}.json`);
    await fs.writeFile(toolPath, JSON.stringify(tool, null, 2), 'utf-8');
    toolPaths.push(toolPath);
  }

  // Generate server.mjs from template
  const serverCode = await generateServerCode(serverId, serverName, analyzerResult);
  const serverCodePath = path.join(serverPath, 'server.mjs');
  await fs.writeFile(serverCodePath, serverCode, 'utf-8');
  await fs.chmod(serverCodePath, 0o755); // Make executable

  // Generate manifest
  const manifest = createManifest(serverId, serverName, analyzerResult, serverConfig);
  const manifestPath = path.join(serverPath, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  // Create .mcpsmith marker file
  await fs.writeFile(
    path.join(serverPath, '.mcpsmith'),
    JSON.stringify({
      generated_at: new Date().toISOString(),
      mcpsmith_version: '1.0.0'
    }, null, 2),
    'utf-8'
  );

  return {
    id: serverId,
    path: serverPath,
    files: {
      server: serverCodePath,
      manifest: manifestPath,
      config: configPath,
      tools: toolPaths
    }
  };
}

/**
 * Create server configuration
 */
function createConfig(
  serverId: string,
  serverName: string,
  description: string,
  analyzerResult: any,
  userConfig: Partial<MCPServerConfig>
): MCPServerConfig {
  const sourceCommand = analyzerResult.metadata.sourceName;

  return {
    $schema: 'https://aiwg.io/schemas/mcpsmith-server-config.json',
    server: {
      name: serverName,
      version: userConfig.server?.version || '1.0.0',
      description
    },
    transport: userConfig.transport || {
      type: 'stdio',
      options: {}
    },
    source: {
      type: analyzerResult.metadata.sourceType,
      command: sourceCommand,
      workingDirectory: userConfig.source?.workingDirectory || process.cwd(),
      environment: userConfig.source?.environment || {},
      timeout: userConfig.source?.timeout || 30000
    },
    tools: {
      prefix: userConfig.tools?.prefix || `${serverId}-`,
      allowlist: userConfig.tools?.allowlist || analyzerResult.tools.map((t: MCPToolDefinition) => t.name),
      denylist: userConfig.tools?.denylist || [],
      dangerousCommands: {
        require_confirmation: userConfig.tools?.dangerousCommands?.require_confirmation ||
          analyzerResult.tools.filter((t: MCPToolDefinition) => t.metadata.requiresConfirmation).map((t: MCPToolDefinition) => t.name),
        blocked: userConfig.tools?.dangerousCommands?.blocked || []
      }
    },
    resources: {
      enabled: userConfig.resources?.enabled ?? false,
      patterns: userConfig.resources?.patterns || []
    },
    prompts: {
      enabled: userConfig.prompts?.enabled ?? false
    },
    security: {
      sandboxed: userConfig.security?.sandboxed ?? true,
      maxExecutionTime: userConfig.security?.maxExecutionTime || 60000,
      allowedPaths: userConfig.security?.allowedPaths || [process.cwd()],
      blockedCommands: userConfig.security?.blockedCommands || [],
      requireConfirmation: userConfig.security?.requireConfirmation ||
        analyzerResult.tools.filter((t: MCPToolDefinition) => t.metadata.requiresConfirmation).map((t: MCPToolDefinition) => t.name)
    },
    logging: {
      enabled: userConfig.logging?.enabled ?? true,
      level: userConfig.logging?.level || 'info',
      maxFiles: userConfig.logging?.maxFiles || 10,
      maxSize: userConfig.logging?.maxSize || '10mb'
    }
  };
}

/**
 * Create server manifest
 */
function createManifest(
  serverId: string,
  serverName: string,
  analyzerResult: any,
  config: MCPServerConfig
): MCPServerManifest {
  const tools = analyzerResult.tools.map((t: MCPToolDefinition) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    dangerous: t.metadata.dangerous,
    requiresConfirmation: t.metadata.requiresConfirmation
  }));

  const files = [
    'server.mjs',
    'config.json',
    'manifest.json',
    '.mcpsmith',
    ...analyzerResult.tools.map((t: MCPToolDefinition) => `tools/${t.name}.json`)
  ];

  const checksum = crypto.createHash('sha256')
    .update(JSON.stringify({ serverId, config, tools }))
    .digest('hex');

  return {
    $schema: 'https://aiwg.io/schemas/mcpsmith-manifest.json',
    id: serverId,
    name: serverName,
    version: config.server.version,
    mcpVersion: '2025-11-25',
    generated: {
      at: new Date().toISOString(),
      by: 'mcpsmith/1.0.0',
      from: {
        type: analyzerResult.metadata.sourceType,
        source: analyzerResult.metadata.sourceName,
        version: analyzerResult.metadata.sourceVersion
      }
    },
    capabilities: {
      tools: true,
      resources: config.resources.enabled,
      prompts: config.prompts.enabled,
      sampling: false,
      logging: config.logging.enabled
    },
    tools,
    resources: [],
    prompts: [],
    dependencies: {
      runtime: ['node >= 24'],
      external: [
        `${analyzerResult.metadata.sourceName}${analyzerResult.metadata.sourceVersion ? ' >= ' + analyzerResult.metadata.sourceVersion : ''}`
      ]
    },
    files,
    checksum
  };
}

/**
 * Generate server code from template
 */
async function generateServerCode(
  serverId: string,
  serverName: string,
  analyzerResult: any
): Promise<string> {
  // Load template
  const projectRoot = path.resolve(path.dirname(__dirname), '..', '..');
  const templatePath = projectAiwgPath(
    projectRoot,
    'smiths',
    'mcpsmith',
    'templates',
    'server-template.mjs'
  );

  let template = await fs.readFile(templatePath, 'utf-8');

  // Replace template variables
  const now = new Date().toISOString();
  const replacements: Record<string, string> = {
    '{{SERVER_ID}}': serverId,
    '{{SERVER_NAME}}': serverName,
    '{{GENERATED_AT}}': now,
    '{{SOURCE_TYPE}}': analyzerResult.metadata.sourceType,
    '{{SOURCE_COMMAND}}': analyzerResult.metadata.sourceName,
    '{{MCPSMITH_VERSION}}': '1.0.0'
  };

  for (const [key, value] of Object.entries(replacements)) {
    template = template.replace(new RegExp(key, 'g'), value);
  }

  return template;
}

/**
 * Update registry with new server
 */
export async function updateRegistry(
  registryPath: string,
  serverId: string,
  serverInfo: any
): Promise<void> {
  let registry;

  try {
    const content = await fs.readFile(registryPath, 'utf-8');
    registry = JSON.parse(content);
  } catch {
    // Create new registry
    registry = {
      $schema: 'https://aiwg.io/schemas/mcpsmith-registry.json',
      version: '1.0',
      servers: [],
      integration: {
        aiwgMcp: {
          enabled: true,
          autoRegister: true,
          resourcePrefix: 'mcpsmith://'
        },
        platforms: {
          claude: false,
          factory: false,
          codex: false,
          cursor: false
        }
      },
      defaults: {
        transport: 'stdio',
        sandbox: true,
        timeout: 30000
      }
    };
  }

  // Remove existing entry if present
  registry.servers = registry.servers.filter((s: any) => s.id !== serverId);

  // Add new entry
  registry.servers.push(serverInfo);

  // Write back
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
}
