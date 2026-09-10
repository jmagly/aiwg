import { manageOmpMcp } from './omp-config.mjs';
import { replaceServer } from './toml-editor.mjs';
import { resolveOmpPaths } from '../providers/omp-paths.mjs';
/**
 * MCP Server Registry
 *
 * Single source of truth for MCP server definitions.
 * Stores server configs in the user config directory (~/.aiwg/mcp-servers.json)
 * and injects them into provider-native config formats.
 *
 * @implements #554
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { resolveConfigDir } from '../config/user-config.js';
import { getProviderDefinition } from '../providers/provider-definitions.js';

// ============================================
// Types
// ============================================

export type McpServerType = 'stdio' | 'http' | 'sse';

export interface McpServerDefinition {
  /** Server name (unique identifier) */
  name: string;

  /** Server URL (for http/sse types) */
  url?: string;

  /** Server type */
  type: McpServerType;

  /** Command to run (for stdio type) */
  command?: string;

  /** Command arguments (for stdio type) */
  args?: string[];

  /** Environment variables */
  env?: Record<string, string>;

  /** Headers (for http/sse types) */
  headers?: Record<string, string>;

  /**
   * Header-to-environment-variable references for authenticated transports.
   * Only variable names are persisted; secret values are resolved by the
   * consuming client at connection time.
   */
  headerEnv?: Record<string, string>;
  /** OMP native transport and authentication options (placeholders remain unresolved). */
  cwd?: string;
  /** SDK/plugin policies; native OMP mcp.json injection rejects these instead of silently dropping them. */
  envPolicy?: 'literal';
  envLiteralKeys?: string[];
  headerPolicy?: 'origin-locked';
  enabled?: boolean;
  timeout?: number;
  requestIdFormat?: 'string' | 'number';
  auth?: { type: 'oauth' | 'apikey'; credentialId?: string; tokenUrl?: string; clientId?: string; clientSecret?: string; resource?: string };
  oauth?: { clientId?: string; clientSecret?: string; redirectUri?: string; callbackPort?: number; callbackPath?: string; prompt?: string; scope?: string };

  /** Providers this server has been injected into */
  injectedProviders?: string[];

  /** Optional description */
  description?: string;

  /** When this entry was added */
  addedAt?: string;

  /** When this entry was last updated */
  updatedAt?: string;
}

export interface McpRegistryData {
  apiVersion: string;
  kind: string;
  servers: Record<string, McpServerDefinition>;
}

export type InjectProvider =
  | 'antigravity'
  | 'agy'
  | 'omp'
  | 'oh-my-pi'
  | 'claude-code'
  | 'claude'
  | 'cursor'
  | 'factory'
  | 'codex'
  | 'openai'
  | 'opencode'
  | 'windsurf'
  | 'warp';

type McpInjectionAdapter = 'antigravity' | 'claude-code' | 'cursor' | 'factory' | 'codex' | 'opencode' | 'windsurf' | 'warp' | null;

// ============================================
// Registry
// ============================================

const REGISTRY_FILENAME = 'mcp-servers.json';

const DEFAULT_REGISTRY: McpRegistryData = {
  apiVersion: 'aiwg.io/v1',
  kind: 'McpServerRegistry',
  servers: {},
};

const ENV_REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateCredentialReferences(def: Pick<McpServerDefinition, 'headerEnv'>): void {
  for (const [header, envName] of Object.entries(def.headerEnv ?? {})) {
    if (!header.trim()) throw new Error('MCP header-env header name must not be empty');
    if (!ENV_REFERENCE_NAME.test(envName)) {
      throw new Error(`Invalid MCP header environment variable reference "${envName}"`);
    }
  }
}

export class McpServerRegistry {
  private readonly configDir: string;
  private cache: McpRegistryData | null = null;

  constructor(configDirOverride?: string) {
    this.configDir = resolveConfigDir(configDirOverride);
  }

  /** Get the registry file path */
  getPath(): string {
    return resolve(this.configDir, REGISTRY_FILENAME);
  }

  /** Load the registry from disk */
  async load(): Promise<McpRegistryData> {
    if (this.cache) return this.cache;

    const filePath = this.getPath();
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content) as McpRegistryData;
      this.cache = {
        ...DEFAULT_REGISTRY,
        ...parsed,
        servers: parsed.servers || {},
      };
    } catch {
      this.cache = { ...DEFAULT_REGISTRY, servers: {} };
    }

    return this.cache;
  }

  /** Save the registry to disk */
  async save(): Promise<void> {
    if (!this.cache) return;
    await mkdir(this.configDir, { recursive: true });
    const filePath = this.getPath();
    await writeFile(filePath, JSON.stringify(this.cache, null, 2) + '\n', 'utf-8');
  }

  /** Add a new MCP server definition */
  async add(def: McpServerDefinition): Promise<void> {
    validateCredentialReferences(def);
    const data = await this.load();

    if (data.servers[def.name]) {
      throw new Error(`Server "${def.name}" already exists. Use "update" to modify it.`);
    }

    data.servers[def.name] = {
      ...def,
      injectedProviders: [],
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.save();
  }

  /** Remove an MCP server definition */
  async remove(name: string): Promise<void> {
    const data = await this.load();

    if (!data.servers[name]) {
      throw new Error(`Server "${name}" not found.`);
    }

    delete data.servers[name];
    await this.save();
  }

  /** Update an existing MCP server definition */
  async update(name: string, updates: Partial<Omit<McpServerDefinition, 'name'>>): Promise<void> {
    const data = await this.load();

    if (!data.servers[name]) {
      throw new Error(`Server "${name}" not found.`);
    }

    const next = {
      ...data.servers[name],
      ...updates,
      name, // preserve original name
      updatedAt: new Date().toISOString(),
    };
    validateCredentialReferences(next);
    data.servers[name] = next;

    await this.save();
  }

  /** Get a specific server definition */
  async get(name: string): Promise<McpServerDefinition | undefined> {
    const data = await this.load();
    return data.servers[name];
  }

  /** List all server definitions */
  async list(): Promise<McpServerDefinition[]> {
    const data = await this.load();
    return Object.values(data.servers);
  }

  /** Record that a server was injected into a provider */
  async recordInjection(name: string, provider: string): Promise<void> {
    const data = await this.load();
    const server = data.servers[name];
    if (!server) return;

    if (!server.injectedProviders) {
      server.injectedProviders = [];
    }
    if (!server.injectedProviders.includes(provider)) {
      server.injectedProviders.push(provider);
    }

    await this.save();
  }

  /** Get all providers that have had servers injected */
  async getInjectedProviders(): Promise<string[]> {
    const data = await this.load();
    const providers = new Set<string>();
    for (const server of Object.values(data.servers)) {
      for (const p of server.injectedProviders || []) {
        providers.add(p);
      }
    }
    return [...providers];
  }

  /** Clear the in-memory cache */
  clearCache(): void {
    this.cache = null;
  }
}

// ============================================
// Provider injection logic
// ============================================

/**
 * Build the MCP config block for a single server in a given provider's format.
 */
function buildServerConfig(
  server: McpServerDefinition,
  provider: InjectProvider,
): Record<string, unknown> {
  const adapter = getProviderDefinition(provider)?.adapters.mcpInjection as McpInjectionAdapter | undefined;
  switch (adapter) {
    case 'antigravity': {
      if (server.type === 'stdio') {
        return { command: server.command, args: server.args || [], ...(server.env ? { env: server.env } : {}) };
      }
      return { serverUrl: server.url, ...(server.headers ? { headers: server.headers } : {}) };
    }
    case 'claude-code': {
      if (server.type === 'stdio') {
        return {
          command: server.command,
          args: server.args || [],
          ...(server.env ? { env: server.env } : {}),
        };
      }
      // http/sse
      return {
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }

    case 'cursor': {
      if (server.type === 'stdio') {
        return {
          command: server.command,
          args: server.args || [],
          ...(server.env ? { env: server.env } : {}),
        };
      }
      return {
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }

    case 'factory': {
      if (server.type === 'stdio') {
        return {
          type: 'stdio',
          command: server.command,
          args: server.args || [],
          disabled: false,
          ...(server.env ? { env: server.env } : {}),
        };
      }
      return {
        type: server.type,
        url: server.url,
        disabled: false,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }

    case 'opencode': {
      if (server.type === 'stdio') {
        return {
          type: 'local',
          command: [server.command, ...(server.args || [])],
          ...(server.env ? { env: server.env } : {}),
        };
      }
      return {
        type: 'remote',
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }

    case 'windsurf':
    case 'warp': {
      if (server.type === 'stdio') {
        return {
          command: server.command,
          args: server.args || [],
          ...(server.env ? { env: server.env } : {}),
        };
      }
      return {
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }

    case 'codex':
      // TOML format handled separately
      return {};

    default:
      return {};
  }
}

/**
 * Build a TOML section for a server (Codex/OpenAI provider).
 */
function tomlString(value: unknown): string {
  if (typeof value !== 'string' || [...value].some(char => {
    const point = char.codePointAt(0)!;
    return point >= 0xd800 && point <= 0xdfff;
  })) throw new Error('TOML values must be strings containing valid Unicode scalar values');
  // JSON escapes align with TOML basic strings except DEL must also be escaped.
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f');
}

function tomlKey(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function buildServerToml(server: McpServerDefinition): string {
  const lines: string[] = [];
  lines.push(`[mcp_servers.${tomlKey(server.name)}]`);

  if (server.type === 'stdio') {
    lines.push(`command = ${tomlString(server.command)}`);
    if (server.args && server.args.length > 0) {
      const argsStr = server.args.map(a => tomlString(a)).join(', ');
      lines.push(`args = [${argsStr}]`);
    }
  } else {
    lines.push(`url = ${tomlString(server.url)}`);
  }

  lines.push(`startup_timeout_sec = 10.0`);
  lines.push(`tool_timeout_sec = 60.0`);

  return lines.join('\n');
}

export interface InjectResult {
  provider: string;
  configPath: string;
  serversInjected: string[];
  alreadyPresent: string[];
  error?: string;
}

/**
 * Get the config file path for a provider.
 */
export function getProviderConfigPath(provider: InjectProvider, projectDir = '.', options: { scope?: 'user' | 'project' } = {}): string {
  if ((provider === 'antigravity' || provider === 'agy') && options.scope === 'user') {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    return resolve(homeDir, '.gemini/config/mcp_config.json');
  }
  if ((provider === 'omp' || provider === 'oh-my-pi') && options.scope !== undefined && !['user', 'project'].includes(options.scope)) throw new Error('OMP MCP scope must be user or project');
  if ((provider === 'omp' || provider === 'oh-my-pi') && options.scope === 'user') return resolve(resolveOmpPaths().agentDir, 'mcp.json');
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  const pathMap: Record<InjectProvider, string> = {
    antigravity: resolve(projectDir, '.agents/mcp_config.json'),
    agy: resolve(projectDir, '.agents/mcp_config.json'),
    omp: resolve(projectDir, '.omp/mcp.json'),
    'oh-my-pi': resolve(projectDir, '.omp/mcp.json'),
    'claude-code': resolve(projectDir, '.claude/settings.local.json'),
    claude: resolve(projectDir, '.claude/settings.local.json'),
    cursor: resolve(projectDir, '.cursor/mcp.json'),
    factory: resolve(homeDir, '.factory/mcp.json'),
    codex: resolve(homeDir, '.codex/config.toml'),
    openai: resolve(homeDir, '.codex/config.toml'),
    opencode: resolve(projectDir, 'opencode.json'),
    windsurf: resolve(homeDir, '.codeium/windsurf/mcp_config.json'),
    warp: resolve(homeDir, '.warp/mcp.json'),
  };

  return pathMap[provider] || '';
}

/**
 * Inject MCP servers into a provider's native config format.
 *
 * Non-destructive: preserves existing provider-specific servers not managed by AIWG.
 * Idempotent: updates in place without duplicating.
 */
export async function injectServers(
  registry: McpServerRegistry,
  provider: InjectProvider,
  options: {
    scope?: 'user' | 'project';
    servers?: string[];
    projectDir?: string;
    dryRun?: boolean;
  } = {},
): Promise<InjectResult> {
  const { servers: serverFilter, projectDir = '.', dryRun = false } = options;
  const configPath = getProviderConfigPath(provider, projectDir, options);
  const result: InjectResult = {
    provider,
    configPath,
    serversInjected: [],
    alreadyPresent: [],
  };

  // Get servers to inject
  let allServers = await registry.list();
  if (serverFilter && serverFilter.length > 0) {
    allServers = allServers.filter(s => serverFilter.includes(s.name));
  }

  if (allServers.length === 0) {
    result.error = 'No servers to inject. Use "aiwg mcp add" first.';
    return result;
  }

  if (provider === 'omp' || provider === 'oh-my-pi') {
    try {
      const managed = await manageOmpMcp(configPath, allServers, { dryRun });
      if (!dryRun) for (const server of allServers) await registry.recordInjection(server.name, 'omp');
      return { ...result, ...managed };
    } catch (error) {
      return { ...result, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // Handle TOML-based providers (Codex/OpenAI) separately
  if (provider === 'codex' || provider === 'openai') {
    return injectToml(registry, allServers, configPath, provider, dryRun, result);
  }

  // JSON-based providers
  return injectJson(registry, allServers, configPath, provider, dryRun, result);
}

async function injectJson(
  registry: McpServerRegistry,
  servers: McpServerDefinition[],
  configPath: string,
  provider: InjectProvider,
  dryRun: boolean,
  result: InjectResult,
): Promise<InjectResult> {
  // Load existing config
  let existing: Record<string, unknown> = {};
  try {
    const content = await readFile(configPath, 'utf-8');
    existing = JSON.parse(content);
  } catch (error: any) {
    if (error instanceof SyntaxError) {
      throw new Error(`Refusing to overwrite malformed MCP config ${configPath}: invalid JSON`);
    }
    if ((provider === 'antigravity' || provider === 'agy') && error?.code !== 'ENOENT') {
      throw new Error(`Refusing to overwrite malformed MCP config ${configPath}: ${error.message}`);
    }
    if (error?.code !== 'ENOENT') throw error;
  }

  // Determine the MCP servers key for this provider
  const mcpKey = provider === 'opencode' ? 'mcp' : 'mcpServers';
  const isObject = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(existing) || (Object.hasOwn(existing, mcpKey) && !isObject(existing[mcpKey]))) {
    throw new Error('MCP configuration must contain an object root and an object server map');
  }
  const existingServers = (existing[mcpKey] as Record<string, unknown>) || {};

  // Build new server entries
  const newServers: Record<string, unknown> = { ...existingServers };

  for (const server of servers) {
    if (existingServers[server.name]) {
      // Update existing entry in place
      result.alreadyPresent.push(server.name);
      if (provider === 'antigravity' || provider === 'agy') continue;
    }
    newServers[server.name] = buildServerConfig(server, provider);
    result.serversInjected.push(server.name);
  }

  // Merge back
  const merged = { ...existing, [mcpKey]: newServers };

  if (!dryRun) {
    await mkdir(resolve(configPath, '..'), { recursive: true });
    await writeFile(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');

    // Record injection in registry
    for (const server of servers) {
      if ((provider === 'antigravity' || provider === 'agy') && !result.serversInjected.includes(server.name)) continue;
      await registry.recordInjection(server.name, provider === 'agy' ? 'antigravity' : provider);
    }
  }

  return result;
}

async function injectToml(
  registry: McpServerRegistry,
  servers: McpServerDefinition[],
  configPath: string,
  provider: InjectProvider,
  dryRun: boolean,
  result: InjectResult,
): Promise<InjectResult> {
  let existing = '';
  try {
    existing = await readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  for (const server of servers) {
    const edited = replaceServer(existing, server.name, buildServerToml(server));
    existing = edited.text;
    if (edited.alreadyPresent) result.alreadyPresent.push(server.name);
    result.serversInjected.push(server.name);
  }

  if (!dryRun) {
    await mkdir(resolve(configPath, '..'), { recursive: true });
    await writeFile(configPath, existing, 'utf-8');

    for (const server of servers) {
      await registry.recordInjection(server.name, provider);
    }
  }

  return result;
}

/** All supported provider names for injection */
export const SUPPORTED_PROVIDERS: InjectProvider[] = [
  'antigravity',
  'omp',
  'claude-code',
  'cursor',
  'factory',
  'codex',
  'opencode',
  'windsurf',
  'warp',
];
