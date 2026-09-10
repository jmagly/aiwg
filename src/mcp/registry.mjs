import { manageOmpMcp } from './omp-config.mjs';
import { replaceServer } from './toml-editor.mjs';
import { resolveOmpPaths } from '../providers/omp-paths.mjs';
/**
 * MCP Server Registry (Runtime ESM)
 *
 * Single source of truth for MCP server definitions.
 * Stores server configs in the user config directory (~/.aiwg/mcp-servers.json)
 * and injects them into provider-native config formats.
 *
 * This is the runtime .mjs version used by cli.mjs.
 * The .ts version exists for type checking and vitest.
 *
 * @implements #554
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import {
  getMcpInjectionDefinition,
  listMcpInjectProviderIds,
  normalizeRuntimeProviderId,
  resolveMcpConfigPath,
} from '../providers/provider-definitions.mjs';

// ============================================
// Config dir resolution (inlined from user-config.ts)
// ============================================

function resolveConfigDir(overridePath) {
  const envOverride = process.env.AIWG_CONFIG;
  if (overridePath) {
    return resolve(overridePath);
  }
  if (envOverride) {
    return resolve(envOverride);
  }

  const primaryPath = resolve(homedir(), '.aiwg');
  if (existsSync(primaryPath)) {
    return primaryPath;
  }

  const fallbackPath = resolve(homedir(), '.config/aiwg');
  if (existsSync(fallbackPath)) {
    return fallbackPath;
  }

  return primaryPath;
}

// ============================================
// Registry
// ============================================

const REGISTRY_FILENAME = 'mcp-servers.json';

const DEFAULT_REGISTRY = {
  apiVersion: 'aiwg.io/v1',
  kind: 'McpServerRegistry',
  servers: {},
};

const ENV_REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateCredentialReferences(def) {
  for (const [header, envName] of Object.entries(def.headerEnv || {})) {
    if (!header.trim()) throw new Error('MCP header-env header name must not be empty');
    if (!ENV_REFERENCE_NAME.test(envName)) {
      throw new Error(`Invalid MCP header environment variable reference "${envName}"`);
    }
  }
}

export class McpServerRegistry {
  #configDir;
  #cache = null;

  constructor(configDirOverride) {
    this.#configDir = resolveConfigDir(configDirOverride);
  }

  getPath() {
    return resolve(this.#configDir, REGISTRY_FILENAME);
  }

  async load() {
    if (this.#cache) return this.#cache;

    const filePath = this.getPath();
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      this.#cache = {
        ...DEFAULT_REGISTRY,
        ...parsed,
        servers: parsed.servers || {},
      };
    } catch {
      this.#cache = { ...DEFAULT_REGISTRY, servers: {} };
    }

    return this.#cache;
  }

  async save() {
    if (!this.#cache) return;
    await mkdir(this.#configDir, { recursive: true });
    const filePath = this.getPath();
    await writeFile(filePath, JSON.stringify(this.#cache, null, 2) + '\n', 'utf-8');
  }

  async add(def) {
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

  async remove(name) {
    const data = await this.load();

    if (!data.servers[name]) {
      throw new Error(`Server "${name}" not found.`);
    }

    delete data.servers[name];
    await this.save();
  }

  async update(name, updates) {
    const data = await this.load();

    if (!data.servers[name]) {
      throw new Error(`Server "${name}" not found.`);
    }

    const next = {
      ...data.servers[name],
      ...updates,
      name,
      updatedAt: new Date().toISOString(),
    };
    validateCredentialReferences(next);
    data.servers[name] = next;

    await this.save();
  }

  async get(name) {
    const data = await this.load();
    return data.servers[name];
  }

  async list() {
    const data = await this.load();
    return Object.values(data.servers);
  }

  async recordInjection(name, provider) {
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

  async getInjectedProviders() {
    const data = await this.load();
    const providers = new Set();
    for (const server of Object.values(data.servers)) {
      for (const p of server.injectedProviders || []) {
        providers.add(p);
      }
    }
    return [...providers];
  }

  clearCache() {
    this.#cache = null;
  }
}

// ============================================
// Provider injection logic
// ============================================

function buildServerConfig(server, provider) {
  const mcpDefinition = getMcpInjectionDefinition(provider);

  switch (mcpDefinition?.serverConfigFormat) {
    case 'antigravity': {
      if (server.type === 'stdio') {
        return { command: server.command, args: server.args || [], ...(server.env ? { env: server.env } : {}) };
      }
      return { serverUrl: server.url, ...(server.headers ? { headers: server.headers } : {}) };
    }
    case 'standard': {
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

    case 'toml':
      return {};

    default:
      return {};
  }
}

function tomlString(value) {
  if (typeof value !== 'string' || [...value].some(char => {
    const point = char.codePointAt(0);
    return point >= 0xd800 && point <= 0xdfff;
  })) throw new Error('TOML values must be strings containing valid Unicode scalar values');
  // JSON escapes align with TOML basic strings except DEL must also be escaped.
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f');
}

function tomlKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function buildServerToml(server) {
  const lines = [];
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

export function getProviderConfigPath(provider, projectDir = '.', options = {}) {
  if (normalizeRuntimeProviderId(provider) === 'omp' && options.scope !== undefined && !['user', 'project'].includes(options.scope)) throw new Error('OMP MCP scope must be user or project');
  return resolveMcpConfigPath(provider, projectDir, options);
}

export async function injectServers(registry, provider, options = {}) {
  const { servers: serverFilter, projectDir = '.', dryRun = false } = options;
  const normalizedProvider = normalizeRuntimeProviderId(provider);
  const mcpDefinition = getMcpInjectionDefinition(provider);
  const configPath = getProviderConfigPath(provider, projectDir, options);
  const result = {
    provider,
    configPath,
    serversInjected: [],
    alreadyPresent: [],
  };

  if (!normalizedProvider || !mcpDefinition) {
    result.error = `Unsupported provider: ${provider}`;
    return result;
  }

  let allServers = await registry.list();
  if (serverFilter && serverFilter.length > 0) {
    allServers = allServers.filter(s => serverFilter.includes(s.name));
  }

  if (allServers.length === 0) {
    result.error = 'No servers to inject. Use "aiwg mcp add" first.';
    return result;
  }

  if (normalizedProvider === 'omp') {
    try {
      const managed = await manageOmpMcp(configPath, allServers, { dryRun });
      if (!dryRun) for (const server of allServers) await registry.recordInjection(server.name, 'omp');
      return { ...result, ...managed };
    } catch (error) {
      return { ...result, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (mcpDefinition?.configFormat === 'toml') {
    return injectToml(registry, allServers, configPath, provider, dryRun, result);
  }

  return injectJson(registry, allServers, configPath, provider, dryRun, result);
}

async function injectJson(registry, servers, configPath, provider, dryRun, result) {
  let existing = {};
  try {
    const content = await readFile(configPath, 'utf-8');
    existing = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Refusing to overwrite malformed MCP config ${configPath}: invalid JSON`);
    }
    if (normalizeRuntimeProviderId(provider) === 'antigravity' && error?.code !== 'ENOENT') {
      throw new Error(`Refusing to overwrite malformed MCP config ${configPath}: ${error.message}`);
    }
    if (error?.code !== 'ENOENT') throw error;
  }

  const mcpKey = getMcpInjectionDefinition(provider)?.serversKey || 'mcpServers';
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(existing) || (Object.hasOwn(existing, mcpKey) && !isObject(existing[mcpKey]))) {
    throw new Error('MCP configuration must contain an object root and an object server map');
  }
  const existingServers = existing[mcpKey] || {};
  const newServers = { ...existingServers };

  for (const server of servers) {
    if (existingServers[server.name]) {
      result.alreadyPresent.push(server.name);
      if (normalizeRuntimeProviderId(provider) === 'antigravity') continue;
    }
    newServers[server.name] = buildServerConfig(server, provider);
    result.serversInjected.push(server.name);
  }

  const merged = { ...existing, [mcpKey]: newServers };

  if (!dryRun) {
    await mkdir(resolve(configPath, '..'), { recursive: true });
    await writeFile(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');

    for (const server of servers) {
      if (normalizeRuntimeProviderId(provider) === 'antigravity' && !result.serversInjected.includes(server.name)) continue;
      await registry.recordInjection(server.name, normalizeRuntimeProviderId(provider) || provider);
    }
  }

  return result;
}

async function injectToml(registry, servers, configPath, provider, dryRun, result) {
  let existing = '';
  try {
    existing = await readFile(configPath, 'utf-8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
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

export const SUPPORTED_PROVIDERS = listMcpInjectProviderIds();
