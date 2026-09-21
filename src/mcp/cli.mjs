#!/usr/bin/env node

/**
 * AIWG MCP CLI
 *
 * Command-line interface for AIWG MCP server operations.
 */

import { startServer, createServer } from './server.mjs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  McpServerRegistry,
  injectServers,
  SUPPORTED_PROVIDERS,
  getProviderConfigPath,
} from './registry.mjs';
import { McpProfileRegistry } from './profiles.mjs';
import { getMcpInjectionDefinition } from '../providers/provider-definitions.mjs';
import { manageOmpMcp } from './omp-config.mjs';
import { unmanageGrokBuildMcp } from './grok-build-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Print usage information
 */
function printUsage() {
  console.log(`
AIWG MCP Server

Usage:
  aiwg mcp serve [options]     Start the MCP server
  aiwg mcp install [target]    Install AIWG MCP server into a provider
  aiwg mcp info                Show server capabilities

  aiwg mcp add <name> [opts]   Define an MCP server in the registry
  aiwg mcp remove <name>       Remove a server from the registry
  aiwg mcp update <name> [opts]  Update a server definition
  aiwg mcp list                List registered MCP servers
  aiwg mcp inject [opts]       Inject servers into provider configs
  aiwg mcp uninject [opts]     Remove unchanged AIWG-owned OMP server entries
  aiwg mcp profile <sub>       Manage MCP profiles (named server subsets)

Server Options (for add/update):
  --url <url>          Server URL (for http/sse types)
  --type <type>        Server type: http (default), stdio, sse
  --command <cmd>      Command to run (for stdio type)
  --args <a1,a2,...>   Command arguments (comma-separated, for stdio)
  --env <K=V,...>      Environment variables (comma-separated K=V pairs)
  --headers <K=V,...>  HTTP headers (comma-separated K=V pairs)
  --header-env <K=ENV,...>
                       Resolve HTTP header values from environment variables
  --description <text> Optional description

Inject Options:
  --provider <name>    Target provider (including antigravity / agy and omp / oh-my-pi)
  --scope <scope>      project (default) or user; provider user scope must be documented
  --all                Inject into all previously configured providers
  --servers <a,b,...>  Only inject specific servers (comma-separated names)
  --dry-run            Show what would change without writing

Serve Options:
  --transport <type>   Transport type: stdio (default), http
  --port <number>      Port for HTTP transport (default: 3100)

Examples:
  # Define MCP servers
  aiwg mcp add fortemi --url https://memory.s9.internal/mcp --type http
  aiwg mcp add fortemi-enterprise --url https://memory.example.internal/mcp --type http \
    --header-env Authorization=AIWG_FORTEMI_TOKEN
  aiwg mcp add gitea --url https://mcp-gitea.integrolabs.net/mcp
  aiwg mcp add mytools --type stdio --command npx --args mcp-server-mytools

  # Inject into provider configs
  aiwg mcp inject --provider claude-code
  aiwg mcp inject --provider cursor --servers fortemi,gitea
  aiwg mcp inject --all

  # Update a server URL
  aiwg mcp update fortemi --url https://new-url.internal/mcp
  aiwg mcp inject --all   # re-inject to all providers

  # List and manage
  aiwg mcp list
  aiwg mcp remove fortemi

  # Install AIWG's own MCP server
  aiwg mcp install claude
  aiwg mcp serve
  aiwg mcp info
`);
}

/**
 * Generate MCP client configuration
 */
async function generateConfig(target, projectDir = '.') {
  const homeDir = process.env.HOME || process.env.USERPROFILE;

  const configs = {
    claude: {
      path: path.join(projectDir, '.claude/settings.local.json'),
      content: {
        mcpServers: {
          aiwg: {
            command: 'aiwg',
            args: ['mcp', 'serve'],
            env: {
              AIWG_ROOT: process.env.AIWG_ROOT || '~/.local/share/ai-writing-guide'
            }
          }
        }
      }
    },
    cursor: {
      path: path.join(projectDir, '.cursor/mcp.json'),
      content: {
        mcpServers: {
          aiwg: {
            command: 'aiwg',
            args: ['mcp', 'serve']
          }
        }
      },
      merge: (existing, content) => ({
        ...existing,
        mcpServers: {
          ...(existing.mcpServers || {}),
          ...content.mcpServers
        }
      })
    },
    factory: {
      // Factory stores MCP config at user level in ~/.factory/mcp.json
      // or project level in .factory/mcp.json
      path: projectDir === '.' || projectDir === 'global'
        ? path.join(homeDir, '.factory/mcp.json')
        : path.join(projectDir, '.factory/mcp.json'),
      content: {
        mcpServers: {
          aiwg: {
            type: 'stdio',
            command: 'aiwg',
            args: ['mcp', 'serve'],
            disabled: false
          }
        }
      },
      merge: (existing, content) => ({
        ...existing,
        mcpServers: {
          ...(existing.mcpServers || {}),
          ...content.mcpServers
        }
      })
    },
    codex: {
      // Codex stores config in ~/.codex/config.toml (TOML format)
      path: path.join(homeDir, '.codex/config.toml'),
      // We generate TOML snippet to append, not JSON
      content: null,
      toml: `
# AIWG MCP Server Configuration
# Add this section to your ~/.codex/config.toml

[mcp_servers.aiwg]
command = "aiwg"
args = ["mcp", "serve"]
startup_timeout_sec = 10.0
tool_timeout_sec = 60.0
enabled_tools = [
  "discover",
  "command-run",
  "artifact-read",
  "artifact-write",
  "template-render",
  "agent-list"
]
`,
      // Custom handler for TOML
      handler: async (configPath, tomlContent) => {
        // Check if config.toml exists
        let existing = '';
        try {
          existing = await fs.readFile(configPath, 'utf-8');
        } catch {
          // File doesn't exist
        }

        // Check if AIWG MCP already configured
        if (existing.includes('[mcp_servers.aiwg]')) {
          console.log('AIWG MCP already configured in ~/.codex/config.toml');
          return true;
        }

        // Append TOML config
        const updated = existing.trimEnd() + '\n' + tomlContent.trim() + '\n';

        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, updated);
        console.log(`MCP configuration appended to: ${configPath}`);
        console.log(`\nTo use AIWG MCP server with Codex:`);
        console.log(`  1. Restart Codex CLI`);
        console.log(`  2. AIWG tools will be available via MCP`);
        return true;
      }
    },
    openai: {
      // Alias for codex
      path: path.join(homeDir, '.codex/config.toml'),
      alias: 'codex'
    },
    windsurf: {
      // Windsurf stores MCP config at ~/.codeium/windsurf/mcp_config.json
      path: path.join(homeDir, '.codeium/windsurf/mcp_config.json'),
      content: {
        mcpServers: {
          aiwg: {
            command: 'aiwg',
            args: ['mcp', 'serve']
          }
        }
      },
      merge: (existing, content) => ({
        ...existing,
        mcpServers: {
          ...(existing.mcpServers || {}),
          ...content.mcpServers
        }
      })
    },
    warp: {
      // Warp configures MCP servers via UI only (Settings > AI > MCP Servers)
      // There is no documented file-based config path
      path: null,
      content: null,
      handler: async () => {
        console.log(`Warp MCP Server Setup (UI-based)\n`);
        console.log(`Warp configures MCP servers through its UI, not config files.`);
        console.log(`\nTo add the AIWG MCP server to Warp:\n`);
        console.log(`  1. Open Warp Terminal`);
        console.log(`  2. Go to Settings > AI > MCP Servers`);
        console.log(`  3. Click "Add MCP Server"`);
        console.log(`  4. Configure:`);
        console.log(`       Name:    aiwg`);
        console.log(`       Type:    stdio`);
        console.log(`       Command: aiwg`);
        console.log(`       Args:    mcp serve`);
        console.log(`  5. Save and restart Warp\n`);
        console.log(`Alternatively, use Warp's /add-mcp slash command.`);
        return true;
      }
    },
    vscode: {
      // VS Code / Copilot stores MCP config in .vscode/mcp.json
      path: path.join(projectDir === '.' ? process.cwd() : projectDir, '.vscode/mcp.json'),
      content: {
        servers: {
          aiwg: {
            type: 'stdio',
            command: 'aiwg',
            args: ['mcp', 'serve']
          }
        }
      },
      merge: (existing, content) => ({
        ...existing,
        servers: {
          ...(existing.servers || {}),
          ...content.servers
        }
      })
    },
    copilot: {
      // Alias for vscode
      path: path.join(projectDir === '.' ? process.cwd() : projectDir, '.vscode/mcp.json'),
      alias: 'vscode'
    },
    opencode: {
      // OpenCode stores MCP config in opencode.json at project root or .opencode/
      path: projectDir === '.' || projectDir === 'global'
        ? path.join(process.cwd(), 'opencode.json')
        : path.join(projectDir, 'opencode.json'),
      content: {
        mcp: {
          aiwg: {
            type: 'local',
            command: ['aiwg', 'mcp', 'serve']
          }
        }
      },
      merge: (existing, content) => ({
        ...existing,
        mcp: {
          ...(existing.mcp || {}),
          ...content.mcp
        }
      }),
      // Custom handler to handle both JSON and JSONC formats
      handler: async (configPath, _, content, mergeFunc) => {
        // Check multiple locations for opencode config
        const locations = [
          configPath,
          path.join(path.dirname(configPath), '.opencode', 'opencode.jsonc'),
          path.join(path.dirname(configPath), '.opencode', 'opencode.json')
        ];

        let targetPath = configPath;
        let existing = {};

        // Find existing config
        for (const loc of locations) {
          try {
            const rawContent = await fs.readFile(loc, 'utf-8');
            // Strip JSONC comments for parsing
            const jsonContent = rawContent
              .replace(/\/\/.*$/gm, '')
              .replace(/\/\*[\s\S]*?\*\//g, '');
            existing = JSON.parse(jsonContent);
            targetPath = loc;
            break;
          } catch {
            // Continue to next location
          }
        }

        // Check if AIWG MCP already configured
        if (existing.mcp && existing.mcp.aiwg) {
          console.log('AIWG MCP already configured in OpenCode config');
          return true;
        }

        // Merge configuration
        const merged = mergeFunc(existing, content);

        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, JSON.stringify(merged, null, 2));
        console.log(`MCP configuration written to: ${targetPath}`);
        console.log(`\nTo use AIWG MCP server with OpenCode:`);
        console.log(`  1. Restart OpenCode`);
        console.log(`  2. AIWG tools will be available via MCP`);
        return true;
      }
    }
  };

  let config = configs[target];
  if (!config) {
    console.error(`Unknown target: ${target}`);
    console.error(`Available targets: ${Object.keys(configs).join(', ')}`);
    return false;
  }

  // Handle alias
  if (config.alias) {
    config = configs[config.alias];
  }

  // Handle custom handler (for TOML configs like Codex, or OpenCode JSON)
  if (config.handler) {
    return await config.handler(config.path, config.toml, config.content, config.merge);
  }

  // Ensure directory exists
  await fs.mkdir(path.dirname(config.path), { recursive: true });

  // Check if file exists and merge
  let existing = {};
  try {
    const content = await fs.readFile(config.path, 'utf-8');
    existing = JSON.parse(content);
  } catch {
    // File doesn't exist, start fresh
  }

  // Merge configuration using custom merge function if available
  const merged = config.merge
    ? config.merge(existing, config.content)
    : {
        ...existing,
        ...config.content,
        mcpServers: {
          ...(existing.mcpServers || {}),
          ...config.content.mcpServers
        }
      };

  await fs.writeFile(config.path, JSON.stringify(merged, null, 2));
  console.log(`MCP configuration written to: ${config.path}`);
  console.log(`\nTo use AIWG MCP server with ${target}:`);
  console.log(`  1. Restart ${target}`);
  console.log(`  2. AIWG tools and resources will be available`);

  return true;
}

/**
 * Show server capabilities
 */
async function showInfo() {
  console.log(`
AIWG MCP Server v1.0.0
Protocol Version: 2025-11-25

POSITIONING:
  MCP is optional and provider-agnostic. Baseline AIWG reachability is file
  deployment plus CLI discovery: aiwg discover / aiwg show <type> <name>.

CORE TOOLS (15, always registered):
  discover                         Cross-type ranked catalog search
  skill-list / skill-show           Skill catalog and SKILL.md body fetch
  command-list / command-show       CLI command catalog and command spec fetch
  rule-list / rule-show             Rule catalog and rule body fetch
  agent-list / agent-show           Agent catalog and agent definition fetch
  template-list / template-show      Template catalog and raw template fetch
  template-render                   Render AIWG template with variables
  command-run                       Allow-listed CLI dispatch; confirmation-gated when needed
  artifact-read / artifact-write    Project .aiwg/ artifact IO

OPT-IN TOOLSETS (60 additional tools):
  flows          flow-list / flow-show / flow-run
  missions       mission-guide / mission-dispatch / mission-status
  memory         memory-* and reflections-* storage operations
  kb             kb-* storage operations
  research       provenance-* and research-store-* storage operations
  activity-log   show / append / stats
  index          build / query / deps / stats
  ralph          start / status / abort / attach
  mc             start / dispatch / status / stop / list
  ops            status / list / use / push
  sandbox        fleet inventory / mutation / reconciliation and governed activity

Enable opt-in tools:
  AIWG_MCP_TOOLSETS=flows,missions,memory,kb,ralph,sandbox aiwg mcp serve
  aiwg mcp serve --toolsets=all

RESOURCES:
  aiwg://prompts/catalog              List of prompt templates
  aiwg://templates/catalog            List of document templates
  aiwg://agents/catalog               List of available agents
  aiwg://prompts/{category}/{name}    Specific prompt template
  aiwg://templates/{fw}/{cat}/{name}  Specific document template
  aiwg://agents/{framework}/{name}    Specific agent definition

PROMPTS:
  decompose-task       Break complex task into subtasks
  parallel-execution   Identify parallelizable work
  recovery-protocol    PAUSE->DIAGNOSE->ADAPT->RETRY->ESCALATE

TRANSPORTS:
  stdio    Standard input/output (default, for local use)
  http     Streamable HTTP (for remote/containerized use)

ENVIRONMENT:
  AIWG_ROOT          Path to AIWG installation (default: ~/.local/share/ai-writing-guide)
  AIWG_MCP_TOOLSETS  Comma-separated opt-in toolsets; use all for every toolset
  AIWG_SANDBOX_MANAGEMENT_URL         Sandbox management API origin (HTTPS except loopback)
  AIWG_SANDBOX_MANAGEMENT_TOKEN_FILE  Mode-0600 management bearer file for sandbox tools

Docs:
  docs/integrations/mcp-capability-audit.md
`);
}

// ============================================
// Registry subcommand handlers
// ============================================

/**
 * Parse --key value pairs from args
 */
function parseFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

/**
 * Parse comma-separated key=value pairs into an object
 */
function parseKVPairs(str) {
  if (!str) return undefined;
  const result = {};
  for (const pair of str.split(',')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    result[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Handle `aiwg mcp add <name> [opts]`
 */
async function handleAdd(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const name = positional[0];

  if (!name) {
    console.error('Usage: aiwg mcp add <name> --url <url> [--type http|stdio|sse] [--command <cmd>] [--args <a,b>]');
    process.exit(1);
  }

  const type = parseFlag(args, '--type') || 'http';
  const url = parseFlag(args, '--url');
  const command = parseFlag(args, '--command');
  const argsStr = parseFlag(args, '--args');
  const envStr = parseFlag(args, '--env');
  const headersStr = parseFlag(args, '--headers');
  const headerEnvStr = parseFlag(args, '--header-env');
  const description = parseFlag(args, '--description');

  if (type === 'stdio' && !command) {
    console.error('Error: --command is required for stdio type servers');
    process.exit(1);
  }
  if ((type === 'http' || type === 'sse') && !url) {
    console.error(`Error: --url is required for ${type} type servers`);
    process.exit(1);
  }

  const registry = new McpServerRegistry();
  await registry.add({
    name,
    type,
    url,
    command,
    args: argsStr ? argsStr.split(',') : undefined,
    env: parseKVPairs(envStr),
    headers: parseKVPairs(headersStr),
    headerEnv: parseKVPairs(headerEnvStr),
    description,
  });

  console.log(`Added MCP server: ${name}`);
  if (url) console.log(`  URL: ${url}`);
  if (command) console.log(`  Command: ${command}`);
  console.log(`  Type: ${type}`);
  console.log(`\nUse "aiwg mcp inject --provider <name>" to inject into a provider config.`);
}

/**
 * Handle `aiwg mcp remove <name>`
 */
async function handleRemove(args) {
  const name = args.filter(a => !a.startsWith('--'))[0];
  if (!name) {
    console.error('Usage: aiwg mcp remove <name>');
    process.exit(1);
  }

  const registry = new McpServerRegistry();
  await registry.remove(name);
  console.log(`Removed MCP server: ${name}`);
  console.log(`\nNote: This does not remove the server from provider configs.`);
  console.log(`Re-run "aiwg mcp inject --all" to update provider configs.`);
}

/**
 * Handle `aiwg mcp update <name> [opts]`
 */
async function handleUpdate(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const name = positional[0];

  if (!name) {
    console.error('Usage: aiwg mcp update <name> --url <url> [--type <type>] ...');
    process.exit(1);
  }

  const updates = {};
  const url = parseFlag(args, '--url');
  const type = parseFlag(args, '--type');
  const command = parseFlag(args, '--command');
  const argsStr = parseFlag(args, '--args');
  const envStr = parseFlag(args, '--env');
  const headersStr = parseFlag(args, '--headers');
  const headerEnvStr = parseFlag(args, '--header-env');
  const description = parseFlag(args, '--description');

  if (url !== undefined) updates.url = url;
  if (type !== undefined) updates.type = type;
  if (command !== undefined) updates.command = command;
  if (argsStr !== undefined) updates.args = argsStr.split(',');
  if (envStr !== undefined) updates.env = parseKVPairs(envStr);
  if (headersStr !== undefined) updates.headers = parseKVPairs(headersStr);
  if (headerEnvStr !== undefined) updates.headerEnv = parseKVPairs(headerEnvStr);
  if (description !== undefined) updates.description = description;

  if (Object.keys(updates).length === 0) {
    console.error('No updates provided. Use --url, --type, --command, etc.');
    process.exit(1);
  }

  const registry = new McpServerRegistry();
  await registry.update(name, updates);
  console.log(`Updated MCP server: ${name}`);
  for (const [key, value] of Object.entries(updates)) {
    console.log(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
  console.log(`\nRe-run "aiwg mcp inject --all" to propagate changes to provider configs.`);
}

/**
 * Handle `aiwg mcp list` (managed servers from registry)
 */
async function handleList() {
  const registry = new McpServerRegistry();
  const servers = await registry.list();

  if (servers.length === 0) {
    console.log('No MCP servers registered.');
    console.log('\nUse "aiwg mcp add <name> --url <url>" to add one.');
    return;
  }

  console.log(`MCP Servers (${servers.length}):\n`);

  for (const server of servers) {
    console.log(`  ${server.name}`);
    console.log(`    Type: ${server.type}`);
    if (server.url) console.log(`    URL: ${server.url}`);
    if (server.command) console.log(`    Command: ${server.command}${server.args ? ' ' + server.args.join(' ') : ''}`);
    if (server.headerEnv) {
      const refs = Object.entries(server.headerEnv).map(([header, envName]) => `${header}←${envName}`);
      console.log(`    Credential refs: ${refs.join(', ')}`);
    }
    if (server.description) console.log(`    Description: ${server.description}`);
    if (server.injectedProviders && server.injectedProviders.length > 0) {
      console.log(`    Injected into: ${server.injectedProviders.join(', ')}`);
    }
    console.log('');
  }

  console.log(`Registry: ${registry.getPath()}`);
}

/**
 * Handle `aiwg mcp inject [opts]`
 *
 * Supports:
 *   --profile <name>   resolve server set from profile registry (#890)
 *   --ephemeral        write standalone config file, do NOT touch provider default (#890)
 *   --out <path>       explicit output path for ephemeral mode
 *   --all              inject into all previously configured providers (existing behavior)
 *   --provider <name>  target provider
 *   --servers a,b      explicit server filter
 *   --dry-run          print what would change
 */
async function handleInject(args) {
  const provider = parseFlag(args, '--provider');
  const injectAll = args.includes('--all');
  const serversStr = parseFlag(args, '--servers');
  const dryRun = args.includes('--dry-run');
  const projectDir = parseFlag(args, '--project') || '.';
  const scope = parseFlag(args, '--scope') || 'project';
  if (!['project', 'user'].includes(scope)) throw new Error('Scope must be project or user');
  const profileName = parseFlag(args, '--profile');
  const ephemeral = args.includes('--ephemeral');
  const outPath = parseFlag(args, '--out');

  if (!provider && !injectAll) {
    console.error('Usage: aiwg mcp inject --provider <name> [--profile <p>] [--ephemeral] [--servers a,b] [--dry-run]');
    console.error('       aiwg mcp inject --all [--dry-run]');
    console.error(`\nSupported providers: ${SUPPORTED_PROVIDERS.join(', ')}`);
    process.exit(1);
  }

  const registry = new McpServerRegistry();

  // Resolve server filter: --profile takes precedence over --servers
  let serverFilter;
  if (profileName) {
    const profiles = new McpProfileRegistry();
    const profile = await profiles.get(profileName);
    if (!profile) {
      const all = await profiles.list();
      console.error(`Profile "${profileName}" not found.`);
      if (all.length > 0) console.error(`Available profiles: ${all.map(p => p.name).join(', ')}`);
      process.exit(1);
    }
    // Resolve to server names (expand __all__ later in injectServers)
    serverFilter = profile.servers.includes('__all__')
      ? undefined  // inject all
      : profile.servers;
    console.log(`Profile: ${profileName} (${profile.servers.length === 1 && profile.servers[0] === '__all__' ? 'all servers' : profile.servers.join(', ')})`);
  } else if (serversStr) {
    serverFilter = serversStr.split(',').map(s => s.trim());
  }

  let providers;
  if (injectAll) {
    providers = await registry.getInjectedProviders();
    if (providers.length === 0) {
      console.error('No providers have been injected before. Use --provider <name> first.');
      process.exit(1);
    }
  } else {
    const normalized = provider === 'claude' ? 'claude-code' : provider;
    if (!getMcpInjectionDefinition(normalized)) {
      console.error(`Unknown provider: ${provider}`);
      console.error(`Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`);
      process.exit(1);
    }
    providers = [normalized];
  }

  if (ephemeral) {
    for (const p of providers) {
      const mcpDefinition = getMcpInjectionDefinition(p);
      if (!mcpDefinition?.supportsEphemeral) {
        console.error(`Error: --ephemeral is not supported for provider "${p}".`);
        if (mcpDefinition?.unsupportedReason) console.error(`  ${mcpDefinition.unsupportedReason}`);
        process.exit(1);
      }
    }
    console.log(dryRun ? '[DRY RUN] Ephemeral mode — would write standalone config:' : 'Ephemeral mode — writing standalone config (default provider config NOT modified):');
  } else if (dryRun) {
    console.log('[DRY RUN] Would inject servers into:');
  }

  let totalInjected = 0;

  for (const p of providers) {
    if (ephemeral) {
      // Generate a standalone ephemeral config file
      const targetPath = outPath ?? path.join(
        process.env.TMPDIR || '/tmp',
        `aiwg-mcp-${profileName ?? 'custom'}-${p}-${Date.now()}.json`,
      );

      const allServers = await registry.list();
      const servers = serverFilter
        ? allServers.filter(s => serverFilter.includes(s.name))
        : allServers;

      if (servers.length === 0) {
        console.error(`  ${p}: no servers to write`);
        continue;
      }

      // Build ephemeral config in provider's format
      const mcpDefinition = getMcpInjectionDefinition(p);
      const mcpKey = mcpDefinition?.serversKey || 'mcpServers';
      const mcpBlock = {};
      for (const server of servers) {
        if (mcpDefinition?.configFormat === 'toml') {
          // TOML providers get a note — ephemeral TOML is handled by codex-runtime adapter
          console.log(`  ${p}: TOML ephemeral config requires the codex-runtime adapter.`);
          console.log(`  Use "aiwg session --provider codex --profile ${profileName}" instead.`);
          continue;
        }
        const cfg = {};
        if (server.type === 'stdio') {
          cfg.command = server.command;
          cfg.args = server.args || [];
          if (server.env) cfg.env = server.env;
        } else {
          cfg.url = server.url;
          if (server.headers) cfg.headers = server.headers;
        }
        mcpBlock[server.name] = cfg;
      }

      if (Object.keys(mcpBlock).length === 0) continue;

      const config = { [mcpKey]: mcpBlock };

      if (!dryRun) {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      }

      const prefix = dryRun ? '[DRY RUN] ' : '';
      console.log(`${prefix}${p}: ${targetPath}`);
      console.log(`  ${prefix}Servers: ${Object.keys(mcpBlock).join(', ')}`);
      if (!dryRun && (p === 'claude-code' || p === 'claude')) {
        console.log(`  Launch with: claude --mcp-config ${targetPath}`);
      }
      totalInjected += Object.keys(mcpBlock).length;
      continue;
    }

    // Persistent injection (existing behavior)
    const result = await injectServers(registry, p, {
      servers: serverFilter,
      projectDir,
      dryRun,
      scope,
    });

    if (result.error) {
      console.error(`  ${p}: ${result.error}`);
      process.exitCode = 1;
      continue;
    }

    const prefix = dryRun ? '[DRY RUN] ' : '';
    console.log(`${prefix}${p}: ${result.configPath}`);
    if (result.serversInjected.length > 0) {
      console.log(`  ${prefix}Injected: ${result.serversInjected.join(', ')}`);
      totalInjected += result.serversInjected.length;
    }
    if (result.alreadyPresent.length > 0) {
      console.log(`  ${prefix}Updated in place: ${result.alreadyPresent.join(', ')}`);
    }
  }

  if (!dryRun && totalInjected > 0 && !ephemeral) {
    console.log(`\nDone. Restart your provider(s) to pick up the changes.`);
  }
}

// ============================================
// Profile subcommand handlers (#889)
// ============================================

/**
 * Print profile subcommand usage
 */
function printProfileUsage() {
  console.log(`
aiwg mcp profile — MCP server profiles (named server subsets)

Usage:
  aiwg mcp profile add <name> --servers a,b,c [--description "..."]
  aiwg mcp profile list
  aiwg mcp profile show <name>
  aiwg mcp profile edit <name> [--add-server x] [--remove-server y] [--description "..."]
  aiwg mcp profile remove <name>
  aiwg mcp profile import <file>
  aiwg mcp profile export <name> [--out <file>]
  aiwg mcp profile init-presets

Profiles let you define named subsets of your registered MCP servers:
  aiwg mcp profile add dev --servers git-gitea,memory-fortemi --description "Dev work"
  aiwg mcp profile show dev
  aiwg mcp inject --provider claude --profile dev --ephemeral
  aiwg session --provider claude --profile dev

Preset profiles (minimal, dev, ops, research, incident, full):
  aiwg mcp profile init-presets
`);
}

/**
 * Handle `aiwg mcp profile add <name> [opts]`
 */
async function handleProfileAdd(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const name = positional[0];
  if (!name) {
    console.error('Usage: aiwg mcp profile add <name> --servers a,b,c [--description "..."]');
    process.exit(1);
  }

  const serversStr = parseFlag(args, '--servers');
  const description = parseFlag(args, '--description');

  if (!serversStr && name !== 'minimal') {
    console.error('Warning: no --servers specified. Profile will start empty.');
  }

  const servers = serversStr ? serversStr.split(',').map(s => s.trim()).filter(Boolean) : [];

  const profiles = new McpProfileRegistry();
  const registry = new McpServerRegistry();

  await profiles.add({ name, description, servers }, registry);

  console.log(`Profile added: ${name}`);
  if (description) console.log(`  Description: ${description}`);
  console.log(`  Servers (${servers.length}): ${servers.length > 0 ? servers.join(', ') : '(none)'}`);
  console.log(`\nUse "aiwg mcp inject --provider <p> --profile ${name}" to inject this profile.`);
}

/**
 * Handle `aiwg mcp profile list`
 */
async function handleProfileList() {
  const profiles = new McpProfileRegistry();
  const all = await profiles.list();

  if (all.length === 0) {
    console.log('No profiles defined.');
    console.log('\nCreate one:   aiwg mcp profile add dev --servers git-gitea,memory-fortemi');
    console.log('Or install presets: aiwg mcp profile init-presets');
    return;
  }

  console.log(`MCP Profiles (${all.length}):\n`);
  for (const p of all) {
    const serverCount = p.servers.length === 1 && p.servers[0] === '__all__'
      ? 'all'
      : String(p.servers.length);
    console.log(`  ${p.name.padEnd(16)}  [${serverCount} server${serverCount === '1' ? '' : 's'}]  ${p.description ?? ''}`);
  }
  console.log(`\nProfiles file: ${profiles.getPath()}`);
}

/**
 * Handle `aiwg mcp profile show <name>`
 */
async function handleProfileShow(args) {
  const name = args.filter(a => !a.startsWith('--'))[0];
  if (!name) {
    console.error('Usage: aiwg mcp profile show <name>');
    process.exit(1);
  }

  const profiles = new McpProfileRegistry();
  const profile = await profiles.get(name);

  if (!profile) {
    const all = await profiles.list();
    console.error(`Profile "${name}" not found.`);
    if (all.length > 0) {
      console.error(`Available profiles: ${all.map(p => p.name).join(', ')}`);
    }
    process.exit(1);
  }

  console.log(`Profile: ${profile.name}`);
  if (profile.description) console.log(`Description: ${profile.description}`);
  console.log(`\nServers (${profile.servers.length}):`);

  if (profile.servers.length === 0) {
    console.log('  (none)');
  } else if (profile.servers[0] === '__all__') {
    console.log('  (all registered servers)');
  } else {
    // Resolve server configs
    const registry = new McpServerRegistry();
    for (const serverName of profile.servers) {
      const server = await registry.get(serverName);
      if (server) {
        const detail = server.type === 'stdio'
          ? `stdio  ${server.command}${server.args ? ' ' + server.args.join(' ') : ''}`
          : `${server.type}  ${server.url}`;
        console.log(`  ${serverName.padEnd(24)} ${detail}`);
        if (server.description) console.log(`  ${''.padEnd(24)} ${server.description}`);
      } else {
        console.log(`  ${serverName.padEnd(24)} (not in registry — missing)`);
      }
    }
  }

  if (profile.providerOverrides && Object.keys(profile.providerOverrides).length > 0) {
    console.log('\nProvider overrides:');
    for (const [provider, overrides] of Object.entries(profile.providerOverrides)) {
      console.log(`  ${provider}:`);
      if (overrides.toolDeny) console.log(`    toolDeny: ${overrides.toolDeny.join(', ')}`);
      if (overrides.toolAllow) console.log(`    toolAllow: ${overrides.toolAllow.join(', ')}`);
    }
  }

  if (profile.createdAt) console.log(`\nCreated: ${profile.createdAt}`);
  if (profile.updatedAt) console.log(`Updated: ${profile.updatedAt}`);
}

/**
 * Handle `aiwg mcp profile edit <name> [opts]`
 */
async function handleProfileEdit(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const name = positional[0];
  if (!name) {
    console.error('Usage: aiwg mcp profile edit <name> [--add-server x] [--remove-server y] [--description "..."]');
    process.exit(1);
  }

  const addServer = parseFlag(args, '--add-server');
  const removeServer = parseFlag(args, '--remove-server');
  const description = parseFlag(args, '--description');

  const changes = {
    description,
    addServers: addServer ? addServer.split(',').map(s => s.trim()) : undefined,
    removeServers: removeServer ? removeServer.split(',').map(s => s.trim()) : undefined,
  };

  if (!description && !addServer && !removeServer) {
    console.error('No changes specified. Use --add-server, --remove-server, or --description.');
    process.exit(1);
  }

  const profiles = new McpProfileRegistry();
  const registry = new McpServerRegistry();
  const updated = await profiles.edit(name, changes, registry);

  console.log(`Profile updated: ${name}`);
  console.log(`  Servers (${updated.servers.length}): ${updated.servers.join(', ') || '(none)'}`);
}

/**
 * Handle `aiwg mcp profile remove <name>`
 */
async function handleProfileRemove(args) {
  const name = args.filter(a => !a.startsWith('--'))[0];
  if (!name) {
    console.error('Usage: aiwg mcp profile remove <name>');
    process.exit(1);
  }

  const profiles = new McpProfileRegistry();
  await profiles.remove(name);
  console.log(`Profile removed: ${name}`);
}

/**
 * Handle `aiwg mcp profile import <file>`
 */
async function handleProfileImport(args) {
  const filePath = args.filter(a => !a.startsWith('--'))[0];
  if (!filePath) {
    console.error('Usage: aiwg mcp profile import <file>');
    process.exit(1);
  }

  const profiles = new McpProfileRegistry();
  const result = await profiles.importFrom(filePath);
  console.log(`Imported ${result.added} new profile(s), updated ${result.updated} existing.`);
}

/**
 * Handle `aiwg mcp profile export <name> [--out <file>]`
 */
async function handleProfileExport(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const name = positional[0]; // optional — omit to export all
  const outFile = parseFlag(args, '--out') || (name ? `${name}-profile.json` : 'mcp-profiles.json');

  const profiles = new McpProfileRegistry();
  await profiles.exportTo(outFile, name);
  console.log(`Exported ${name ? `profile "${name}"` : 'all profiles'} to: ${outFile}`);
}

/**
 * Handle `aiwg mcp profile init-presets`
 */
async function handleProfileInitPresets() {
  const profiles = new McpProfileRegistry();
  const result = await profiles.initPresets();

  if (result.added === 0) {
    console.log(`All ${result.total} preset profiles are already installed.`);
    console.log('Use "aiwg mcp profile list" to view them.');
  } else {
    console.log(`Installed ${result.added} preset profile(s) (${result.total} total presets):`);
    console.log('  minimal, dev, ops, research, incident, full');
    console.log('\nNote: preset server names reference expected registry entries.');
    console.log('Run "aiwg mcp list" to see which servers are registered.');
  }
}

/**
 * Route `aiwg mcp profile <subcommand>`
 */
async function handleProfile(args) {
  const sub = args[0];
  const subArgs = args.slice(1);

  switch (sub) {
    case 'add':
      await handleProfileAdd(subArgs);
      break;
    case 'list':
    case 'ls':
      await handleProfileList();
      break;
    case 'show':
      await handleProfileShow(subArgs);
      break;
    case 'edit':
      await handleProfileEdit(subArgs);
      break;
    case 'remove':
    case 'rm':
      await handleProfileRemove(subArgs);
      break;
    case 'import':
      await handleProfileImport(subArgs);
      break;
    case 'export':
      await handleProfileExport(subArgs);
      break;
    case 'init-presets':
      await handleProfileInitPresets();
      break;
    default:
      if (sub) console.error(`Unknown profile subcommand: ${sub}\n`);
      printProfileUsage();
      process.exit(sub ? 1 : 0);
  }
}

// ============================================
// Main CLI entry point
// ============================================

/**
 * Main CLI entry point
 */
export async function main(args = process.argv.slice(2)) {
  const command = args[0];
  const subArgs = args.slice(1);

  switch (command) {
    case 'serve': {
      // Parse options
      const transportIdx = args.indexOf('--transport');
      const transport = transportIdx !== -1 ? args[transportIdx + 1] : 'stdio';

      if (transport === 'http') {
        const portIdx = args.indexOf('--port');
        const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 3100;
        console.error(`HTTP transport not yet implemented. Use stdio for now.`);
        console.error(`Would start on port ${port}`);
        process.exit(1);
      }

      // --toolsets flag overrides AIWG_MCP_TOOLSETS env (#1332 / S18)
      const toolsetsIdx = args.indexOf('--toolsets');
      if (toolsetsIdx !== -1 && args[toolsetsIdx + 1]) {
        process.env.AIWG_MCP_TOOLSETS = args[toolsetsIdx + 1];
      }

      await startServer();
      break;
    }

    case 'install': {
      if (['omp', 'oh-my-pi'].includes(args[1])) {
        const scope = parseFlag(args, '--scope') || 'project';
        if (!['project', 'user'].includes(scope)) throw new Error('Scope must be project or user');
        const projectDir = parseFlag(args, '--project') || (args[2] && !args[2].startsWith('--') ? args[2] : '.');
        const configPath = getProviderConfigPath('omp', projectDir, { scope });
        const result = await manageOmpMcp(configPath, [{ name: 'aiwg', type: 'stdio', command: 'aiwg', args: ['mcp', 'serve'] }], { dryRun: args.includes('--dry-run') });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      // Parse install arguments (skip flags)
      const installArgs = args.slice(1).filter(a => !a.startsWith('--'));
      const target = installArgs[0] || 'claude';
      const projectDir = installArgs[1] || '.';

      // Check for --dry-run flag
      if (args.includes('--dry-run')) {
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        console.log(`[DRY RUN] Would generate MCP config for: ${target}`);
        console.log(`[DRY RUN] Target directory: ${projectDir}`);
        const configPaths = {
          claude: '.claude/settings.local.json',
          cursor: '.cursor/mcp.json',
          factory: (projectDir === '.' || projectDir === 'global')
            ? path.join(homeDir, '.factory/mcp.json')
            : path.join(projectDir, '.factory/mcp.json'),
          codex: path.join(homeDir, '.codex/config.toml'),
          openai: path.join(homeDir, '.codex/config.toml'),
          vscode: '.vscode/mcp.json',
          copilot: '.vscode/mcp.json',
          opencode: (projectDir === '.' || projectDir === 'global')
            ? 'opencode.json'
            : path.join(projectDir, 'opencode.json'),
          windsurf: path.join(homeDir, '.codeium/windsurf/mcp_config.json'),
          warp: '(UI-based — Settings > AI > MCP Servers)'
        };
        console.log(`[DRY RUN] Config file: ${configPaths[target] || 'unknown'}`);
        break;
      }

      await generateConfig(target, projectDir);
      break;
    }

    case 'info':
      await showInfo();
      break;

    case 'add':
      await handleAdd(subArgs);
      break;

    case 'remove':
    case 'rm':
      await handleRemove(subArgs);
      break;

    case 'update':
      await handleUpdate(subArgs);
      break;

    case 'list':
    case 'ls':
      await handleList();
      break;

    case 'inject':
      await handleInject(subArgs);
      break;

    case 'uninject': {
      const provider = parseFlag(subArgs, '--provider');
      if (!['omp', 'oh-my-pi', 'grok-build'].includes(provider)) throw new Error('uninject supports --provider omp or grok-build');
      const scope = parseFlag(subArgs, '--scope') || 'project';
      if (!['project', 'user'].includes(scope)) throw new Error('Scope must be project or user');
      const remove = (parseFlag(subArgs, '--servers') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!remove.length) throw new Error('uninject requires --servers name[,name]');
      const configPath = getProviderConfigPath(provider, parseFlag(subArgs, '--project') || '.', { scope });
      if (provider === 'grok-build') {
        const projectDir = parseFlag(subArgs, '--project') || '.';
        const result = await unmanageGrokBuildMcp(configPath, remove, {
          dryRun: subArgs.includes('--dry-run'),
          root: scope === 'user' ? path.dirname(path.dirname(configPath)) : path.resolve(projectDir),
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      const result = await manageOmpMcp(configPath, [], { remove, dryRun: subArgs.includes('--dry-run') });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'profile':
      await handleProfile(subArgs);
      break;

    case '--help':
    case '-h':
    case 'help':
      printUsage();
      break;

    default:
      if (command) {
        console.error(`Unknown command: ${command}`);
      }
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

// Run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
