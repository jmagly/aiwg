import { tomlString } from './toml-string.mjs';
import { buildServerConfig as renderServerConfig } from './server-config.mjs';
import { type Layering, isLowerLayerEntry, loadLayered, lowerEntryQualified, resolveConfigLayers, saveLayerData } from './config-layers.mjs';
import { assertConfigDestination, assertProjectCredentials, classifyMcpDestination, projectCredentialRemedy, writeConfigAtomic, writeConfigTransaction } from './config-file.mjs';
import { manageOmpMcp } from './omp-config.mjs';
import { manageGrokBuildMcp } from './grok-build-config.mjs';
import { replaceServer } from './toml-editor.mjs';
import { resolveOmpPaths } from '../providers/omp-paths.mjs';
import { applyJsonToolFilterPlan, claudeSettingsPath, prepareClaudePermissions, planToolFilters, type ToolFilterPlan, type ToolFilters } from './tool-filters.mjs';
import { assertCredentialPolicy, resolveCredentialPolicy, validateEnvReferenceName, credentialReferenceInput, validateCredentialReferences, assertEnvironmentCredentialReferences, type McpCredentialPolicy } from './credentials.mjs';
/**
 * MCP Server Registry
 *
 * Single source of truth for MCP server definitions.
 * Stores server configs in the user config directory (~/.aiwg/mcp-servers.json)
 * and injects them into provider-native config formats.
 *
 * @implements #554
 */

import { readFile } from 'fs/promises';
import { qualificationDigest } from '../models/qualification-digest.mjs';
import { qualifyWorkerInvocationProfile, requiredWorkerControls, type WorkerAdapterMetadata, type WorkerInvocationProfile } from '../models/provider-policy.js';
import { dirname, isAbsolute, resolve } from 'path';
import { homedir } from 'os';
import { resolveConfigDir } from '../config/user-config.js';
import { resolveSensitiveInput, type SensitiveInputDependencies } from '../auth/sensitive-input.js';

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
   * Only variable names or file:/store: locators are persisted; values are resolved by the
   * consuming client at connection time.
   */
  headerEnv?: Record<string, string>;
  /**
   * Server-environment-to-environment-variable references for stdio servers.
   * Maps the variable the server sees to the variable the client reads; only
   * names or file:/store: locators are persisted.
   */
  envFrom?: Record<string, string>;
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

  /** Host qualification only; never grants task authority or substitutes for a live installation recheck. */
  workerQualification?: McpWorkerQualification;

  /** Providers this server has been injected into */
  injectedProviders?: string[];

  /** Optional description */
  description?: string;

  /** When this entry was added */
  addedAt?: string;

  /** When this entry was last updated */
  updatedAt?: string;
}

export interface McpWorkerQualification {
  serverDigest: string;
  adapterDigest: string;
  profile: string;
  cliVersion: string;
  scopeDigest: string;
  fixtureDigest: string;
  requiredControls: string[];
}

/** Supply the trusted host probe result, after rechecking its live installation scope. */
export interface McpWorkerQualificationInput {
  /** Captured by the trusted host before probing and included in installation scope. */
  authorizedServerDigest: string;
  adapter: WorkerAdapterMetadata;
  profile: string;
  cliVersion: string;
  requiredControls: string[];
  policy?: Parameters<typeof requiredWorkerControls>[0]['policy'];
  permissions?: Parameters<typeof requiredWorkerControls>[0]['permissions'];
  effort?: string | null;
  boundary?: Parameters<typeof qualifyWorkerInvocationProfile>[1]['boundary'];
  mcp: NonNullable<WorkerInvocationProfile['mcp']>;
  installationQualification: {
    status: 'ENABLED'; scopeDigest: string; fixtureDigest: string;
    verifiedAt: string; evidenceRef: string; cliVersion: string; platform: string;
    serverDigest?: string;
  };
}

export interface McpRegistryData {
  apiVersion: string;
  kind: string;
  /** Default credential policy for rendering; see credentials.mjs. */
  credentialPolicy?: McpCredentialPolicy;
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
  | 'grok-build'
  | 'opencode'
  | 'devin'
  | 'windsurf'
  | 'devin-desktop'
  | 'devin-local'
  | 'cascade'
  | 'warp';

// ============================================
// Registry
// ============================================

const REGISTRY_FILENAME = 'mcp-servers.json';

const DEFAULT_REGISTRY: McpRegistryData = {
  apiVersion: 'aiwg.io/v1',
  kind: 'McpServerRegistry',
  servers: {},
};

/** Resolve references only for AIWG's in-memory transport, never for a config writer. */
export async function resolveMcpCredentialMaps(
  server: Pick<McpServerDefinition, 'env' | 'headers' | 'envFrom' | 'headerEnv'>,
  dependencies: SensitiveInputDependencies = {},
): Promise<{ env?: Record<string, string>; headers?: Record<string, string> }> {
  const result = { env: server.env ? { ...server.env } : undefined, headers: server.headers ? { ...server.headers } : undefined };
  for (const [field, target, flag] of [['envFrom', 'env', '--env-from'], ['headerEnv', 'headers', '--header-env']] as const) {
    for (const [key, reference] of Object.entries(server[field] ?? {})) {
      const input = credentialReferenceInput(reference, flag);
      // Explicit locators prevent terminal prompts and implicit stdin consumption.
      try {
        const value = await resolveSensitiveInput({ ...input, prefix: 'value' }, dependencies);
        result[target] = { ...result[target], [key]: value };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'MCP credential input failed';
        throw new Error(message.replace(/--value-(file|store|env)/g, (_, source: string) =>
          `${flag} KEY=${source === 'env' ? 'ENV_NAME' : source === 'file' ? 'file:ABSOLUTE_PATH' : 'store:NAME'}`));
      }
    }
  }
  return result;
}

export function workerServerDigest(server: McpServerDefinition): string {
  const { workerQualification, description, injectedProviders, addedAt, updatedAt, ...execution } = server;
  return qualificationDigest(execution);
}

function workerQualificationBinding(server: McpServerDefinition, input: McpWorkerQualificationInput): McpWorkerQualification {
  if (!Array.isArray(input.requiredControls) || input.requiredControls.some(name =>
    typeof name !== 'string' || !name || !Object.hasOwn(input.adapter.invocationProfiles?.[input.profile]?.controls ?? {}, name))) {
    throw new Error('MCP worker must declare valid required controls');
  }
  if (server.enabled === false || input.mcp.serverRef !== server.name) {
    throw new Error('MCP worker server is disabled or does not match the qualified profile');
  }
  if (input.authorizedServerDigest !== workerServerDigest(server)) {
    throw new Error('MCP server command, endpoint or configuration lacks matching host authorization');
  }
  if (server.type === 'stdio') {
    if (!server.command || !isAbsolute(server.command) || server.command.includes('\0')
        || (server.args ?? []).some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new Error('MCP worker requires an authorized absolute local command and typed argv');
    }
  } else {
    let endpoint: URL;
    try { endpoint = new URL(server.url ?? ''); } catch { throw new Error('MCP worker endpoint is invalid'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error('MCP worker endpoint must be an authorized HTTP URL without credentials or fragment');
    }
  }
  const profile = qualifyWorkerInvocationProfile(input.adapter, { ...input, transport: 'mcp' });
  const installed = input.installationQualification;
  if (installed?.serverDigest !== input.authorizedServerDigest) {
    throw new Error('MCP worker installation does not cover the authorized registration');
  }
  const evidence = profile.installationQualification;
  if (!installed || installed.status !== 'ENABLED' || installed.platform !== 'linux' || installed.cliVersion !== input.cliVersion
      || !evidence || ['scopeDigest', 'fixtureDigest', 'verifiedAt', 'evidenceRef'].some(key =>
        installed[key as keyof typeof evidence] !== evidence[key as keyof typeof evidence])) {
    throw new Error('MCP worker requires current trusted installation qualification');
  }
  if (Object.keys(server.env ?? {}).some(key => !profile.envAllowlist.includes(key))
      || Object.values(server.headerEnv ?? {}).some(key => !profile.envAllowlist.includes(key))) {
    throw new Error('MCP worker server environment exceeds the qualified profile allowlist');
  }
  return {
    serverDigest: workerServerDigest(server), adapterDigest: qualificationDigest(input.adapter),
    profile: input.profile, cliVersion: input.cliVersion,
    scopeDigest: installed.scopeDigest, fixtureDigest: installed.fixtureDigest,
    requiredControls: requiredWorkerControls(input).sort(),
  };
}

export class McpServerRegistry {
  private readonly configDir: string;
  private cache: McpRegistryData | null = null;

  /** Configuration layers, lowest precedence first; null for a single directory */
  private readonly layers: string[] | null;
  private layering: Layering | null = null;

  constructor(configDirOverride?: string) {
    this.layers = resolveConfigLayers(configDirOverride);
    this.configDir = this.layers ? this.layers[this.layers.length - 1] : resolveConfigDir(configDirOverride);
  }

  /** Get the registry file path */
  getPath(): string {
    return resolve(this.configDir, REGISTRY_FILENAME);
  }

  /** Load the registry from disk */
  async load(): Promise<McpRegistryData> {
    if (this.cache) return this.cache;

    const loaded = await loadLayered(this.layers ?? [this.configDir], REGISTRY_FILENAME, 'servers', DEFAULT_REGISTRY);
    this.cache = loaded.data;
    this.layering = this.layers ? loaded.layering : null;
    return this.cache;
  }

  /** Save the registry to disk */
  async save(data: McpRegistryData | null = this.cache, explicitPolicy = false): Promise<void> {
    if (!data) return;
    // A fresh instance has no ownership record yet; load it first so inherited
    // entries and inherited policy are never copied into the write layer.
    let layering = this.layering;
    if (this.layers && !layering) {
      await this.load();
      layering = this.layering;
    }
    await saveLayerData(this.getPath(), data, 'servers', this.layers, layering, explicitPolicy);
    this.cache = data;
    if (this.layers) {
      this.clearCache();
      await this.load();
    }
  }

  /** Add a new MCP server definition */
  async add(def: McpServerDefinition): Promise<void> {
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

  /** Remove an MCP server definition */
  async remove(name: string): Promise<void> {
    const data = structuredClone(await this.load());

    if (!data.servers[name]) {
      throw new Error(`Server "${name}" not found.`);
    }

    if (this.layering && isLowerLayerEntry(this.layering, name)) {
      throw new Error(`Server "${name}" is defined in a lower configuration layer; remove it there.`);
    }
    if (this.layering && lowerEntryQualified(this.layering, name)) {
      throw new Error(`Server "${name}" overrides a qualified lower-layer entry; removing the override would silently re-expose its qualification. Remove the lower-layer entry in its own layer instead.`);
    }
    delete data.servers[name];
    await this.save(data);
  }

  /** Update an existing MCP server definition */
  async update(name: string, updates: Partial<Omit<McpServerDefinition, 'name'>>): Promise<void> {
    const data = structuredClone(await this.load());

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
    // Ordinary registration edits cannot mint qualification, including a copied binding.
    next.workerQualification = workerServerDigest(next) === workerServerDigest(data.servers[name])
      ? data.servers[name].workerQualification : undefined;
    data.servers[name] = next;

    await this.save(data);
  }

  /** Bind an already qualified host installation to this exact MCP registration. */
  async recordWorkerQualification(name: string, input: McpWorkerQualificationInput): Promise<McpWorkerQualification> {
    this.clearCache();
    const server = await this.get(name);
    if (!server) throw new Error(`Server "${name}" not found.`);
    const binding = workerQualificationBinding(server, input);
    server.workerQualification = binding;
    await this.save();
    return structuredClone(binding);
  }

  /** Recheck immediately before use; direct shell invocations do not use this registry. */
  async assertWorkerQualified(name: string, input: McpWorkerQualificationInput): Promise<McpServerDefinition> {
    // Other trusted registry writers may have changed the registration since load().
    this.clearCache();
    const server = await this.get(name);
    if (!server) throw new Error(`Server "${name}" not found.`);
    const current = workerQualificationBinding(server, input);
    if (!server.workerQualification || qualificationDigest(server.workerQualification) !== qualificationDigest(current)) {
      throw new Error('MCP worker registration qualification is missing or changed');
    }
    return structuredClone(server);
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

  /** Registry-wide default credential policy, if one is set */
  async getCredentialPolicy(): Promise<McpCredentialPolicy | undefined> {
    const data = await this.load();
    return data.credentialPolicy;
  }

  /** The enforced organisation floor for this registry, if any layer below the write layer sets one. */
  async getCredentialPolicyFloor(): Promise<McpCredentialPolicy | undefined> {
    await this.load();
    return this.layering?.lowerPolicy;
  }

  /** The config file of the layer that set the enforced floor, for diagnostics. */
  async getCredentialPolicyFloorSource(): Promise<string | undefined> {
    await this.load();
    return this.layering?.lowerPolicySource;
  }

  async setCredentialPolicy(policy: McpCredentialPolicy): Promise<void> {
    const data = structuredClone(await this.load());
    const floorPolicy = this.layering?.lowerPolicy;
    const floorSource = this.layering?.lowerPolicySource;
    const effective = resolveCredentialPolicy({ flag: policy, floorPolicy, floorSource, env: {} });
    if (effective !== policy) {
      const location = floorSource ? ` (set in ${floorSource})` : '';
      throw new Error(`Cannot relax MCP credential policy floor "${effective}"${location} to "${policy}".`);
    }
    data.credentialPolicy = policy;
    await this.save(data, true);
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
export function buildServerConfig(
  server: McpServerDefinition,
  provider: InjectProvider,
): Record<string, unknown> {
  return renderServerConfig(server, provider);
}

function tomlKey(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values).map(([name, value]) => `${tomlKey(name)} = ${tomlString(value)}`).join(', ')} }`;
}

export function buildServerToml(server: McpServerDefinition): string {
  assertEnvironmentCredentialReferences(server, 'codex');
  const lines: string[] = [];
  lines.push(`[mcp_servers.${tomlKey(server.name)}]`);

  if (server.type === 'stdio') {
    lines.push(`command = ${tomlString(server.command)}`);
    if (server.args && server.args.length > 0) {
      const argsStr = server.args.map(a => tomlString(a)).join(', ');
      lines.push(`args = [${argsStr}]`);
    }
    if (server.env && Object.keys(server.env).length > 0) lines.push(`env = ${tomlInlineTable(server.env)}`);
    // Codex forwards a variable only under its own name (env_vars).
    const forwarded = Object.entries(server.envFrom ?? {});
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
    for (const name of Object.values(server.headerEnv ?? {})) validateEnvReferenceName(name);
    if (server.headerEnv && Object.keys(server.headerEnv).length > 0) lines.push(`env_http_headers = ${tomlInlineTable(server.headerEnv)}`);
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
  /** Profile tool filters the provider cannot express; present only when filters were requested. */
  warnings?: string[];
  /** Claude Code settings file that received permission rules. */
  settingsPath?: string;
}

/**
 * Get the config file path for a provider.
 */
export function getProviderConfigPath(provider: InjectProvider, projectDir = '.', options: { scope?: 'user' | 'project' } = {}): string {
  if ((provider === 'antigravity' || provider === 'agy') && options.scope === 'user') {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    return resolve(homeDir, '.gemini/config/mcp_config.json');
  }
  if ((provider === 'claude-code' || provider === 'claude') && options.scope === 'user') {
    return resolve(process.env.HOME || process.env.USERPROFILE || homedir(), '.claude.json');
  }
  if ((provider === 'omp' || provider === 'oh-my-pi') && options.scope !== undefined && !['user', 'project'].includes(options.scope)) throw new Error('OMP MCP scope must be user or project');
  if ((provider === 'omp' || provider === 'oh-my-pi') && options.scope === 'user') return resolve(resolveOmpPaths().agentDir, 'mcp.json');
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  const pathMap: Record<InjectProvider, string> = {
    antigravity: resolve(projectDir, '.agents/mcp_config.json'),
    agy: resolve(projectDir, '.agents/mcp_config.json'),
    omp: resolve(projectDir, '.omp/mcp.json'),
    'oh-my-pi': resolve(projectDir, '.omp/mcp.json'),
    'claude-code': resolve(projectDir, '.mcp.json'),
    claude: resolve(projectDir, '.mcp.json'),
    cursor: resolve(projectDir, '.cursor/mcp.json'),
    factory: resolve(homeDir, '.factory/mcp.json'),
    codex: process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME, 'config.toml') : resolve(homeDir, '.codex/config.toml'),
    openai: process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME, 'config.toml') : resolve(homeDir, '.codex/config.toml'),
    'grok-build': options.scope === 'user'
      ? resolve(process.env.GROK_HOME || resolve(homeDir, '.grok'), 'config.toml')
      : resolve(projectDir, '.grok/config.toml'),
    opencode: resolve(projectDir, 'opencode.json'),
    devin: options.scope === 'user'
      ? resolve(homeDir, '.config/devin/mcp_config.json')
      : resolve(projectDir, '.devin/mcp_config.json'),
    windsurf: options.scope === 'user'
      ? resolve(homeDir, '.config/devin/mcp_config.json')
      : resolve(projectDir, '.devin/mcp_config.json'),
    'devin-desktop': options.scope === 'user'
      ? resolve(homeDir, '.config/devin/mcp_config.json')
      : resolve(projectDir, '.devin/mcp_config.json'),
    'devin-local': options.scope === 'user'
      ? resolve(homeDir, '.config/devin/mcp_config.json')
      : resolve(projectDir, '.devin/mcp_config.json'),
    cascade: options.scope === 'user'
      ? resolve(homeDir, '.config/devin/mcp_config.json')
      : resolve(projectDir, '.devin/mcp_config.json'),
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
    toolFilters?: ToolFilters;
    credentialPolicy?: McpCredentialPolicy;
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
  if (provider === 'omp' || provider === 'oh-my-pi') {
    try {
      const managed = await manageOmpMcp(configPath, allServers, { dryRun, userScope, projectRoot });
      if (!dryRun) for (const server of allServers) await registry.recordInjection(server.name, 'omp');
      return { ...result, ...managed };
    } catch (error) {
      return { ...result, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (provider === 'grok-build') {
    try {
      const managed = await manageGrokBuildMcp(configPath, allServers, {
        dryRun,
        userScope,
        root: options.scope === 'user' ? dirname(dirname(configPath)) : resolve(projectDir),
      });
      if (!dryRun && !managed.error) for (const server of allServers) await registry.recordInjection(server.name, 'grok-build');
      return { ...result, ...managed };
    } catch (error) {
      return { ...result, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // Handle TOML-based providers (Codex/OpenAI) separately
  if (provider === 'codex' || provider === 'openai') {
    return injectToml(registry, allServers, configPath, provider, dryRun, result, userScope, projectRoot, toolPlan);
  }

  // JSON-based providers
  return injectJson(registry, allServers, configPath, provider, dryRun, result, userScope, projectRoot, toolPlan, { projectDir, scope: options.scope });
}

async function injectJson(
  registry: McpServerRegistry,
  servers: McpServerDefinition[],
  configPath: string,
  provider: InjectProvider,
  dryRun: boolean,
  result: InjectResult,
  userScope: boolean,
  projectRoot?: string,
  toolPlan: ToolFilterPlan | null = null,
  location: { projectDir?: string; scope?: 'user' | 'project' } = {},
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
  if (toolPlan) {
    applyJsonToolFilterPlan(merged, mcpKey, toolPlan);
  }

  const isClaude = provider === 'claude-code' || provider === 'claude';
  const settingsPath = isClaude ? claudeSettingsPath(location.projectDir, location.scope) : null;
  const settings = settingsPath ? await prepareClaudePermissions(
    settingsPath, toolPlan?.claudePermissions || { deny: [], allow: [] },
    { userScope, projectRoot, managedDir: dirname(registry.getPath()), mcpPath: configPath },
  ) : null;
  if (settings?.active && settingsPath) result.settingsPath = settingsPath;
  if (settings?.warnings.length) result.warnings = [...(result.warnings || []), ...settings.warnings];

  if (!dryRun) {
    await writeConfigTransaction([
      { file: configPath, content: JSON.stringify(merged, null, 2) + '\n', options: { userScope, projectRoot } },
      ...(settings?.writes || []),
    ]);

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
  userScope: boolean,
  projectRoot?: string,
  toolPlan: ToolFilterPlan | null = null,
): Promise<InjectResult> {
  // A deliberately aliased Codex home is trusted; descendants below it are not.
  const destinationRoot = projectRoot ?? (process.env.CODEX_HOME || resolve(process.env.HOME || process.env.USERPROFILE || homedir(), '.codex'));
  await assertConfigDestination(configPath, destinationRoot);
  let existing = '';
  try {
    existing = await readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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

/** All supported provider names for injection */
export const SUPPORTED_PROVIDERS: InjectProvider[] = [
  'antigravity',
  'omp',
  'claude-code',
  'cursor',
  'factory',
  'codex',
  'grok-build',
  'opencode',
  'devin',
  'warp',
];
