import { prepareAntigravityConfig, resolveAntigravityConfigPath } from './antigravity-config.mjs';
import { tomlString } from './toml-string.mjs';
import { buildServerConfig } from './server-config.mjs';
export { buildServerConfig } from './server-config.mjs';
import { isLowerLayerEntry, loadLayered, lowerEntryQualified, resolveConfigLayers, saveLayerData } from './config-layers.mjs';
import { assertConfigDestination, assertProjectCredentials, classifyMcpDestination, projectCredentialRemedy, writeConfigAtomic, writeConfigTransaction } from './config-file.mjs';
import { manageOmpMcp } from './omp-config.mjs';
import { manageGrokBuildMcp } from './grok-build-config.mjs';
import { replaceServer } from './toml-editor.mjs';
import { resolveOmpPaths } from '../providers/omp-paths.mjs';
import { applyJsonToolFilterPlan, claudeSettingsPath, prepareClaudePermissions, planToolFilters } from './tool-filters.mjs';
import { assertCredentialPolicy, resolveCredentialPolicy, validateEnvReferenceName, validateCredentialReferences, assertEnvironmentCredentialReferences } from './credentials.mjs';
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

import { readFile } from 'fs/promises';
import { qualificationDigest } from '../models/qualification-digest.mjs';
import { dirname, resolve } from 'path';
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

// The typed worker dispatch boundary owns qualification. Legacy runtime edits
// invalidate its binding without importing the TypeScript policy owner.
export function workerServerDigest(server) {
  const { workerQualification, description, injectedProviders, addedAt, updatedAt, ...execution } = server;
  return qualificationDigest(execution);
}

export class McpServerRegistry {
  #configDir;
  #cache = null;

  #layers;
  #layering = null;

  constructor(configDirOverride) {
    this.#layers = resolveConfigLayers(configDirOverride);
    this.#configDir = this.#layers ? this.#layers[this.#layers.length - 1] : resolveConfigDir(configDirOverride);
  }

  getPath() {
    return resolve(this.#configDir, REGISTRY_FILENAME);
  }

  async load() {
    if (this.#cache) return this.#cache;

    const loaded = await loadLayered(this.#layers ?? [this.#configDir], REGISTRY_FILENAME, 'servers', DEFAULT_REGISTRY);
    this.#cache = loaded.data;
    this.#layering = this.#layers ? loaded.layering : null;
    return this.#cache;
  }

  async save(data = this.#cache, explicitPolicy = false) {
    if (!data) return;
    // A fresh instance has no ownership record yet; load it first so inherited
    // entries and inherited policy are never copied into the write layer.
    let layering = this.#layering;
    if (this.#layers && !layering) {
      await this.load();
      layering = this.#layering;
    }
    await saveLayerData(this.getPath(), data, 'servers', this.#layers, layering, explicitPolicy);
    this.#cache = data;
    if (this.#layers) {
      this.clearCache();
      await this.load();
    }
  }

  async add(def) {
    validateCredentialReferences(def);
    const data = structuredClone(await this.load());

    if (data.servers[def.name]) {
      throw new Error(`Server "${def.name}" already exists. Use "update" to modify it.`);
    }

    data.servers[def.name] = {
      ...def,
      workerQualification: undefined,
      injectedProviders: [],
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.save(data);
  }

  async remove(name) {
    const data = structuredClone(await this.load());

    if (!data.servers[name]) {
      throw new Error(`Server "${name}" not found.`);
    }

    if (this.#layering && isLowerLayerEntry(this.#layering, name)) {
      throw new Error(`Server "${name}" is defined in a lower configuration layer; remove it there.`);
    }
    if (this.#layering && lowerEntryQualified(this.#layering, name)) {
      throw new Error(`Server "${name}" overrides a qualified lower-layer entry; removing the override would silently re-expose its qualification. Remove the lower-layer entry in its own layer instead.`);
    }
    delete data.servers[name];
    await this.save(data);
  }

  async update(name, updates) {
    const data = structuredClone(await this.load());

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
    next.workerQualification = workerServerDigest(next) === workerServerDigest(data.servers[name])
      ? data.servers[name].workerQualification : undefined;
    data.servers[name] = next;

    await this.save(data);
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
    const data = structuredClone(await this.load());
    const server = data.servers[name];
    if (!server) return;

    if (!server.injectedProviders) {
      server.injectedProviders = [];
    }
    if (!server.injectedProviders.includes(provider)) {
      server.injectedProviders.push(provider);
    }

    await this.save(data);
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

  async getCredentialPolicy() {
    const data = await this.load();
    return data.credentialPolicy;
  }

  /** The enforced organisation floor for this registry, if any layer below the write layer sets one. */
  async getCredentialPolicyFloor() {
    await this.load();
    return this.#layering?.lowerPolicy;
  }

  /** The config file of the layer that set the enforced floor, for diagnostics. */
  async getCredentialPolicyFloorSource() {
    await this.load();
    return this.#layering?.lowerPolicySource;
  }

  async setCredentialPolicy(policy) {
    const data = structuredClone(await this.load());
    const floorPolicy = this.#layering?.lowerPolicy;
    const floorSource = this.#layering?.lowerPolicySource;
    const effective = resolveCredentialPolicy({ flag: policy, floorPolicy, floorSource, env: {} });
    if (effective !== policy) {
      const location = floorSource ? ` (set in ${floorSource})` : '';
      throw new Error(`Cannot relax MCP credential policy floor "${effective}"${location} to "${policy}".`);
    }
    data.credentialPolicy = policy;
    await this.save(data, true);
  }

  clearCache() {
    this.#cache = null;
  }
}

// ============================================
// Provider injection logic
// ============================================


function tomlKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function tomlInlineTable(values) {
  return `{ ${Object.entries(values).map(([name, value]) => `${tomlKey(name)} = ${tomlString(value)}`).join(', ')} }`;
}

export function buildServerToml(server) {
  assertEnvironmentCredentialReferences(server, 'codex');
  const lines = [];
  lines.push(`[mcp_servers.${tomlKey(server.name)}]`);

  if (server.type === 'stdio') {
    lines.push(`command = ${tomlString(server.command)}`);
    if (server.args && server.args.length > 0) {
      const argsStr = server.args.map(a => tomlString(a)).join(', ');
      lines.push(`args = [${argsStr}]`);
    }
    if (server.env && Object.keys(server.env).length > 0) lines.push(`env = ${tomlInlineTable(server.env)}`);
    // Codex forwards a variable only under its own name (env_vars).
    const forwarded = Object.entries(server.envFrom || {});
    for (const [key, name] of forwarded) {
      validateEnvReferenceName(name);
      if (key !== name) {
        throw new Error(`MCP server "${server.name}": Codex forwards environment variables under their own name only; env-from ${key}=${name} cannot be rendered. Use ${name}=${name}.`);
      }
    }
    if (forwarded.length > 0) lines.push(`env_vars = [${forwarded.map(([name]) => tomlString(name)).join(', ')}]`);
  } else {
    lines.push(`url = ${tomlString(server.url)}`);
    if (server.headers && Object.keys(server.headers).length > 0) lines.push(`http_headers = ${tomlInlineTable(server.headers)}`);
    for (const name of Object.values(server.headerEnv || {})) validateEnvReferenceName(name);
    if (server.headerEnv && Object.keys(server.headerEnv).length > 0) lines.push(`env_http_headers = ${tomlInlineTable(server.headerEnv)}`);
  }

  lines.push(`startup_timeout_sec = 10.0`);
  lines.push(`tool_timeout_sec = 60.0`);

  return lines.join('\n');
}

export function getProviderConfigPath(provider, projectDir = '.', options = {}) {
  if (normalizeRuntimeProviderId(provider) === 'antigravity') return resolveAntigravityConfigPath(projectDir, options);
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
  if (serverFilter !== undefined) {
    allServers = allServers.filter(s => serverFilter.includes(s.name));
  }

  const toolPlan = options.toolFilters
    ? planToolFilters(provider, allServers.map(server => server.name), options.toolFilters)
    : null;
  if (toolPlan) result.warnings = toolPlan.warnings;
  if (allServers.length === 0) {
    result.error = 'No servers to inject. Use "aiwg mcp add" first.';
    return result;
  }

  assertCredentialPolicy(allServers, resolveCredentialPolicy({
    flag: options.credentialPolicy, registryPolicy: await registry.getCredentialPolicy(),
    floorPolicy: await registry.getCredentialPolicyFloor(),
    floorSource: await registry.getCredentialPolicyFloorSource(),
  }));

  // The shareable-project decision follows the actual resolved destination,
  // never the requested scope: a `--scope user` request for a provider without
  // a user-scope destination still resolves to the project file and is refused.
  const { userScope, projectRoot } = classifyMcpDestination(provider, options.scope, configPath, projectDir);
  await assertConfigDestination(configPath, projectRoot);
  // Every destination inside the project directory is meant to be committed to
  // version control; home destinations are private, so literals there are not
  // copied into a shared file.
  if (projectRoot) {
    assertProjectCredentials(allServers, configPath, projectCredentialRemedy(provider, projectDir));
  }
  if (normalizedProvider === 'omp') {
    try {
      const managed = await manageOmpMcp(configPath, allServers, { dryRun, userScope, projectRoot });
      if (!dryRun) for (const server of allServers) await registry.recordInjection(server.name, 'omp');
      return { ...result, ...managed };
    } catch (error) {
      return { ...result, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (normalizedProvider === 'grok-build') {
    try {
      const managed = await manageGrokBuildMcp(configPath, allServers, {
        dryRun,
        userScope,
        root: options.scope === 'user'
          ? dirname(dirname(configPath))
          : resolve(projectDir),
        blockedByPolicy: options.blockedByPolicy,
      });
      if (!dryRun && !managed.error) {
        for (const server of allServers) await registry.recordInjection(server.name, 'grok-build');
      }
      return { ...result, ...managed };
    } catch (error) {
      return { ...result, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (mcpDefinition?.configFormat === 'toml') {
    return injectToml(registry, allServers, configPath, provider, dryRun, result, userScope, projectRoot, toolPlan);
  }

  return injectJson(registry, allServers, configPath, provider, dryRun, result, userScope, projectRoot, toolPlan, { projectDir, scope: options.scope });
}

async function injectJson(registry, servers, configPath, provider, dryRun, result, userScope, projectRoot, toolPlan = null, location = {}) {
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
  const plugin = await prepareAntigravityConfig(provider, configPath, existing, location);
  existing = plugin.config;
  if (plugin.warnings.length) result.warnings = [...(result.warnings || []), ...plugin.warnings];
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
  if (toolPlan) {
    applyJsonToolFilterPlan(merged, mcpKey, toolPlan);
  }

  const isClaude = normalizeRuntimeProviderId(provider) === 'claude-code';
  const settingsPath = isClaude ? claudeSettingsPath(location.projectDir, location.scope) : null;
  const settings = settingsPath ? await prepareClaudePermissions(
    settingsPath, toolPlan?.claudePermissions || { deny: [], allow: [] },
    { userScope, projectRoot, managedDir: dirname(registry.getPath()), mcpPath: configPath },
  ) : null;
  if (settings?.active && settingsPath) result.settingsPath = settingsPath;
  if (settings?.warnings.length) result.warnings = [...(result.warnings || []), ...settings.warnings];

  if (!dryRun) {
    await writeConfigTransaction([
      ...plugin.writes,
      { file: configPath, content: JSON.stringify(merged, null, 2) + '\n', options: { userScope, projectRoot } },
      ...(settings?.writes || []),
    ]);

    for (const server of servers) {
      if (normalizeRuntimeProviderId(provider) === 'antigravity' && !result.serversInjected.includes(server.name)) continue;
      await registry.recordInjection(server.name, normalizeRuntimeProviderId(provider) || provider);
    }
  }


  return result;
}

async function injectToml(registry, servers, configPath, provider, dryRun, result, userScope, projectRoot, toolPlan = null) {
  // A deliberately aliased Codex home is trusted; descendants below it are not.
  const destinationRoot = projectRoot ?? (process.env.CODEX_HOME || resolve(process.env.HOME || process.env.USERPROFILE || homedir(), '.codex'));
  await assertConfigDestination(configPath, destinationRoot);
  let existing = '';
  try {
    existing = await readFile(configPath, 'utf-8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  for (const server of servers) {
    const filterLines = toolPlan?.tomlLines[server.name] || [];
    const edited = replaceServer(existing, server.name, [buildServerToml(server), ...filterLines].join('\n'));
    existing = edited.text;
    if (edited.alreadyPresent) result.alreadyPresent.push(server.name);
    result.serversInjected.push(server.name);
  }

  if (!dryRun) {
    await writeConfigAtomic(configPath, existing, { userScope, projectRoot: destinationRoot });

    for (const server of servers) {
      await registry.recordInjection(server.name, provider);
    }
  }

  return result;
}

export const SUPPORTED_PROVIDERS = listMcpInjectProviderIds();
