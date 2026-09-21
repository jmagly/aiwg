import { resolveOmpPaths } from './omp-paths.mjs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';

const MCP_INJECTION_DEFINITIONS = [
  {
    id: 'antigravity', aliases: ['agy'],
    mcp: { providerId: 'antigravity', includeInSupportedProviders: true, configFormat: 'json',
      serverConfigFormat: 'antigravity', serversKey: 'mcpServers',
      configPath: { scope: 'project', path: '.agents/mcp_config.json' },
      supportsEphemeral: false,
      unsupportedReason: 'Antigravity uses project or user persistent MCP configuration; temporary injection is not qualified.' },
  },
  {
    id: 'omp', aliases: ['oh-my-pi'],
    mcp: { providerId: 'omp', includeInSupportedProviders: true, configFormat: 'json',
      serverConfigFormat: 'standard', serversKey: 'mcpServers',
      configPath: { scope: 'project', path: '.omp/mcp.json' },
      supportsEphemeral: false,
      unsupportedReason: 'OMP uses owned persistent MCP configuration; temporary injection is not supported.' },
  },
  {
    id: 'claude',
    aliases: ['claude-code'],
    mcp: {
      providerId: 'claude-code',
      includeInSupportedProviders: true,
      configFormat: 'json',
      serverConfigFormat: 'standard',
      serversKey: 'mcpServers',
      configPath: { scope: 'project', path: '.claude/settings.local.json' },
      supportsEphemeral: true,
    },
  },
  {
    id: 'cursor',
    aliases: [],
    mcp: {
      providerId: 'cursor',
      includeInSupportedProviders: true,
      configFormat: 'json',
      serverConfigFormat: 'standard',
      serversKey: 'mcpServers',
      configPath: { scope: 'project', path: '.cursor/mcp.json' },
      supportsEphemeral: true,
    },
  },
  {
    id: 'factory',
    aliases: ['factory-ai'],
    mcp: {
      providerId: 'factory',
      includeInSupportedProviders: true,
      configFormat: 'json',
      serverConfigFormat: 'factory',
      serversKey: 'mcpServers',
      configPath: { scope: 'home', path: '.factory/mcp.json' },
      supportsEphemeral: true,
    },
  },
  {
    id: 'codex',
    aliases: ['openai'],
    mcp: {
      providerId: 'codex',
      acceptedProviderIds: ['openai'],
      includeInSupportedProviders: true,
      configFormat: 'toml',
      serverConfigFormat: 'toml',
      serversKey: null,
      configPath: { scope: 'home', path: '.codex/config.toml' },
      supportsEphemeral: true,
    },
  },
  {
    id: 'grok-build', aliases: [],
    mcp: {
      providerId: 'grok-build',
      includeInSupportedProviders: true,
      configFormat: 'toml',
      serverConfigFormat: 'grok-build',
      serversKey: null,
      configPath: { scope: 'project', path: '.grok/config.toml' },
      supportsEphemeral: false,
      unsupportedReason: 'Grok Build project MCP configuration is trust-scoped and must remain in its reviewed config layer.',
    },
  },
  {
    id: 'opencode',
    aliases: [],
    mcp: {
      providerId: 'opencode',
      includeInSupportedProviders: true,
      configFormat: 'json',
      serverConfigFormat: 'opencode',
      serversKey: 'mcp',
      configPath: { scope: 'project', path: 'opencode.json' },
      supportsEphemeral: true,
    },
  },
  {
    id: 'windsurf',
    aliases: ['devin', 'devin-desktop', 'devin-local', 'cascade'],
    mcp: {
      providerId: 'windsurf',
      includeInSupportedProviders: true,
      configFormat: 'json',
      serverConfigFormat: 'standard',
      serversKey: 'mcpServers',
      configPath: { scope: 'home', path: '.codeium/windsurf/mcp_config.json' },
      supportsEphemeral: true,
    },
  },
  {
    id: 'warp',
    aliases: [],
    mcp: {
      providerId: 'warp',
      includeInSupportedProviders: true,
      configFormat: 'json',
      serverConfigFormat: 'standard',
      serversKey: 'mcpServers',
      configPath: { scope: 'home', path: '.warp/mcp.json' },
      supportsEphemeral: false,
      unsupportedReason: 'Warp configures MCP servers via its UI only. No file-based ephemeral config is available.',
    },
  },
];

function allMcpProviderIds(definition) {
  return [
    definition.id,
    ...definition.aliases,
    definition.mcp.providerId,
    ...(definition.mcp.acceptedProviderIds || []),
  ];
}

export function listRuntimeProviderDefinitions() {
  return MCP_INJECTION_DEFINITIONS.map((definition) => ({
    ...definition,
    aliases: [...definition.aliases],
    mcp: {
      ...definition.mcp,
      acceptedProviderIds: [...(definition.mcp.acceptedProviderIds || [])],
      configPath: { ...definition.mcp.configPath },
    },
  }));
}

export function normalizeRuntimeProviderId(provider) {
  const candidate = provider?.trim().toLowerCase();
  if (!candidate) return null;

  for (const definition of MCP_INJECTION_DEFINITIONS) {
    if (allMcpProviderIds(definition).includes(candidate)) {
      return definition.mcp.providerId;
    }
  }

  return null;
}

export function getMcpInjectionDefinition(provider) {
  const normalized = normalizeRuntimeProviderId(provider);
  if (!normalized) return undefined;

  return MCP_INJECTION_DEFINITIONS
    .map((definition) => definition.mcp)
    .find((definition) => definition.providerId === normalized);
}

export function listMcpInjectProviderIds() {
  return MCP_INJECTION_DEFINITIONS
    .map((definition) => definition.mcp)
    .filter((definition) => definition.includeInSupportedProviders)
    .map((definition) => definition.providerId);
}

export function resolveMcpConfigPath(provider, projectDir = '.', options = {}) {
  if (normalizeRuntimeProviderId(provider) === 'antigravity' && options.scope === 'user') {
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    return resolve(home, '.gemini/config/mcp_config.json');
  }
  if (normalizeRuntimeProviderId(provider) === 'omp' && options.scope === 'user') {
    return resolve(resolveOmpPaths(options).agentDir, 'mcp.json');
  }
  if (normalizeRuntimeProviderId(provider) === 'grok-build' && options.scope === 'user') {
    const userHome = process.env.HOME || process.env.USERPROFILE || homedir();
    const raw = process.env.GROK_HOME || join(userHome, '.grok');
    const home = raw.startsWith('~/') ? join(userHome, raw.slice(2)) : raw;
    if (!isAbsolute(home) || resolve(home) === resolve(home, '..')) throw new Error('GROK_HOME must be an absolute non-root path for MCP injection');
    return resolve(home, 'config.toml');
  }
  const definition = getMcpInjectionDefinition(provider);
  if (!definition) return '';

  const base = definition.configPath.scope === 'home'
    ? (process.env.HOME || process.env.USERPROFILE || homedir())
    : projectDir;

  return resolve(base, definition.configPath.path);
}
