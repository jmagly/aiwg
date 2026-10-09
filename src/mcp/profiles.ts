/**
 * MCP Profile Registry (TypeScript)
 *
 * Named, ordered subsets of registered MCP servers.
 * Stored in ~/.aiwg/mcp-profiles.json.
 *
 * This module is used for type checking and vitest.
 * profiles.mjs is the runtime ESM version used by cli.mjs.
 *
 * @implements #889
 */

import { resolveCredentialPolicy, type McpCredentialPolicy } from './credentials.mjs';
import { type Layering, isLowerLayerEntry, loadLayered, resolveProfileExtends, resolveConfigLayers, saveLayerData } from './config-layers.mjs';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { resolveConfigDir } from '../config/user-config.js';
import { McpServerRegistry, McpServerDefinition } from './registry.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface McpProfileProviderOverride {
  toolDeny?: string[];
  toolAllow?: string[];
}

export interface McpProfile {
  /** Profile name (unique, [a-z0-9-]+) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Server names referenced from the server registry. '__all__' expands to all servers. */
  servers: string[];
  /** Profiles whose servers and tool filters this profile inherits, base first */
  extends?: string[];
  /** Per-provider tool allow/deny overrides */
  providerOverrides?: Record<string, McpProfileProviderOverride>;
  /** ISO timestamp */
  createdAt?: string;
  /** ISO timestamp */
  updatedAt?: string;
}

export interface McpProfileRegistryData {
  credentialPolicy?: McpCredentialPolicy;
  apiVersion: string;
  kind: string;
  profiles: Record<string, McpProfile>;
}

export interface ProfileEditChanges {
  description?: string;
  addServers?: string[];
  removeServers?: string[];
  /** Tool patterns to add, keyed by provider ('*' for every provider) */
  providerOverrides?: Record<string, McpProfileProviderOverride>;
  /** Provider key whose tool filters are removed */
  clearToolFilters?: string;
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const PROFILES_FILENAME = 'mcp-profiles.json';

const RESERVED_NAMES = new Set(['all', 'none', 'default']);
const NAME_RE = /^[a-z0-9-]+$/;

const DEFAULT_DATA: McpProfileRegistryData = {
  apiVersion: 'aiwg.io/v1',
  kind: 'McpProfileRegistry',
  profiles: {},
};

// ─────────────────────────────────────────────
// Preset profiles
// ─────────────────────────────────────────────

export const PRESET_PROFILES: Record<string, Omit<McpProfile, 'name'>> = {
  minimal: {
    description: 'Minimal toolset for smoke tests (~6K token budget)',
    servers: [],
    providerOverrides: {},
  },
  dev: {
    description: 'Code editing + git + memory (~12K token budget)',
    servers: ['git-gitea', 'codeindex-codehound', 'memory-fortemi'],
    providerOverrides: {
      codex: { toolDeny: ['git-gitea__delete_*', 'git-gitea__actions_config_write'] },
    },
  },
  ops: {
    description: 'Infra + git + CMDB operations (~14K token budget)',
    servers: ['git-gitea', 'cmdb-itassets', 'memory-fortemi'],
    providerOverrides: {},
  },
  research: {
    description: 'Documentation + memory + calendar (~10K token budget)',
    servers: ['memory-fortemi', 'claude_ai_Google_Drive', 'claude_ai_Google_Calendar'],
    providerOverrides: {},
  },
  incident: {
    description: 'Incident response — git + CMDB + memory (~16K token budget)',
    servers: ['git-gitea', 'cmdb-itassets', 'memory-fortemi', 'codeindex-codehound'],
    providerOverrides: {},
  },
  full: {
    description: 'All registered servers — for exploration (~21K token budget)',
    servers: ['__all__'],
    providerOverrides: {},
  },
};

// ─────────────────────────────────────────────
// Registry class
// ─────────────────────────────────────────────

export class McpProfileRegistry {
  private readonly configDir: string;
  private cache: McpProfileRegistryData | null = null;

  /** Configuration layers, lowest precedence first; null for a single directory */
  private readonly layers: string[] | null;
  private layering: Layering | null = null;

  constructor(configDirOverride?: string) {
    this.layers = resolveConfigLayers(configDirOverride);
    this.configDir = this.layers ? this.layers[this.layers.length - 1] : resolveConfigDir(configDirOverride);
  }

  getPath(): string {
    return resolve(this.configDir, PROFILES_FILENAME);
  }

  async load(): Promise<McpProfileRegistryData> {
    if (this.cache) return this.cache;

    if (this.layers) {
      const layered = await loadLayered(this.layers, PROFILES_FILENAME, 'profiles', DEFAULT_DATA);
      this.cache = layered.data;
      this.layering = layered.layering;
      return this.cache!;
    }

    const filePath = this.getPath();
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content) as McpProfileRegistryData;
      this.cache = {
        ...DEFAULT_DATA,
        ...parsed,
        profiles: parsed.profiles || {},
      };
    } catch {
      this.cache = { ...DEFAULT_DATA, profiles: {} };
    }

    try {
      resolveCredentialPolicy({ registryPolicy: this.cache.credentialPolicy, env: {} });
    } catch (error) {
      this.cache = null;
      throw new Error(`Invalid MCP credential policy in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return this.cache;
  }

  async save(data: McpProfileRegistryData | null = this.cache): Promise<void> {
    if (!data) return;
    await saveLayerData(this.getPath(), data, 'profiles', this.layers, this.layering);
    this.cache = data;
    if (this.layers) {
      this.clearCache();
      await this.load();
    }
  }

  private validateName(name: string): void {
    if (!NAME_RE.test(name)) {
      throw new Error(
        `Invalid profile name "${name}". Names must match [a-z0-9-]+.`,
      );
    }
    if (RESERVED_NAMES.has(name)) {
      throw new Error(
        `"${name}" is a reserved profile name. Choose a different name.`,
      );
    }
  }

  private async validateServers(
    serverNames: string[],
    serverRegistry?: McpServerRegistry,
  ): Promise<void> {
    if (!serverRegistry) return;
    const missing: string[] = [];
    for (const name of serverNames) {
      if (name === '__all__') continue;
      const server = await serverRegistry.get(name);
      if (!server) missing.push(name);
    }
    if (missing.length > 0) {
      throw new Error(
        `Server(s) not found in registry: ${missing.join(', ')}.\n` +
        `Use "aiwg mcp list" to see registered servers.`,
      );
    }
  }

  async add(profile: McpProfile, serverRegistry?: McpServerRegistry): Promise<void> {
    this.validateName(profile.name);
    const data = structuredClone(await this.load());

    if (data.profiles[profile.name]) {
      throw new Error(
        `Profile "${profile.name}" already exists. Use "aiwg mcp profile edit" to modify it.`,
      );
    }

    await this.validateServers(profile.servers ?? [], serverRegistry);
    if (profile.extends?.length) resolveProfileExtends(profile.name, { ...data.profiles, [profile.name]: profile });

    data.profiles[profile.name] = {
      ...profile,
      servers: profile.servers ?? [],
      providerOverrides: profile.providerOverrides ?? {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.save(data);
  }

  async get(name: string): Promise<McpProfile | undefined> {
    const data = await this.load();
    return data.profiles[name];
  }

  /**
   * Return a profile with its `extends` chain applied across all configuration
   * layers. Use get() for the profile exactly as stored.
   */
  async resolve(name: string): Promise<McpProfile | undefined> {
    const data = await this.load();
    if (!data.profiles[name]) return undefined;
    return resolveProfileExtends(name, data.profiles);
  }

  async list(): Promise<McpProfile[]> {
    const data = await this.load();
    return Object.values(data.profiles);
  }

  async edit(
    name: string,
    changes: ProfileEditChanges,
    serverRegistry?: McpServerRegistry,
  ): Promise<McpProfile> {
    const data = structuredClone(await this.load());
    const existing = data.profiles[name];
    if (!existing) throw new Error(`Profile "${name}" not found.`);

    const current = { ...existing, servers: [...existing.servers] };

    if (changes.description !== undefined) current.description = changes.description;

    if (changes.addServers && changes.addServers.length > 0) {
      await this.validateServers(changes.addServers, serverRegistry);
      for (const s of changes.addServers) {
        if (!current.servers.includes(s)) current.servers.push(s);
      }
    }

    if (changes.removeServers && changes.removeServers.length > 0) {
      current.servers = current.servers.filter(
        (s) => !(changes.removeServers ?? []).includes(s),
      );
    }

    if (changes.clearToolFilters) {
      const overrides = { ...(current.providerOverrides ?? {}) };
      delete overrides[changes.clearToolFilters];
      current.providerOverrides = overrides;
    }

    for (const [provider, override] of Object.entries(changes.providerOverrides ?? {})) {
      const overrides = { ...(current.providerOverrides ?? {}) };
      const previous = overrides[provider] ?? {};
      const merge = (before: string[] | undefined, added: string[] | undefined) => (added ? [...new Set([...(before ?? []), ...added])] : before);
      overrides[provider] = {
        ...previous,
        ...(override.toolDeny ? { toolDeny: merge(previous.toolDeny, override.toolDeny) } : {}),
        ...(override.toolAllow ? { toolAllow: merge(previous.toolAllow, override.toolAllow) } : {}),
      };
      current.providerOverrides = overrides;
    }

    current.updatedAt = new Date().toISOString();
    data.profiles[name] = current;
    await this.save(data);
    return data.profiles[name];
  }

  async remove(name: string): Promise<void> {
    const data = structuredClone(await this.load());
    if (!data.profiles[name]) throw new Error(`Profile "${name}" not found.`);
    if (this.layering && isLowerLayerEntry(this.layering, name)) {
      throw new Error(`Profile "${name}" is defined in a lower configuration layer; remove it there.`);
    }
    const dependents = Object.entries(data.profiles)
      .filter(([other, profile]) => other !== name && profile.extends?.includes(name))
      .map(([other]) => other);
    if (dependents.length) {
      throw new Error(`Cannot remove profile "${name}": extended by ${dependents.join(', ')}.`);
    }
    delete data.profiles[name];
    await this.save(data);
  }

  async resolveServers(
    name: string,
    serverRegistry?: McpServerRegistry,
  ): Promise<McpServerDefinition[] | string[]> {
    const profile = await this.resolve(name);
    if (!profile) throw new Error(`Profile "${name}" not found.`);

    if (profile.servers.includes('__all__') && serverRegistry) {
      return serverRegistry.list();
    }

    if (!serverRegistry) return profile.servers;

    const resolved: McpServerDefinition[] = [];
    for (const serverName of profile.servers) {
      const server = await serverRegistry.get(serverName);
      if (server) resolved.push(server);
    }
    return resolved;
  }

  async importFrom(filePath: string): Promise<{ added: number; updated: number }> {
    const content = await readFile(filePath, 'utf-8');
    const imported = JSON.parse(content) as { profiles?: Record<string, McpProfile> };
    const data = structuredClone(await this.load());

    let added = 0;
    let updated = 0;

    const profiles = imported.profiles ?? (
      typeof imported === 'object' && !Array.isArray(imported)
        ? imported as Record<string, McpProfile>
        : {}
    );
    const candidate = { ...data.profiles };

    for (const [name, profile] of Object.entries(profiles)) {
      try {
        this.validateName(name);
      } catch {
        continue;
      }
      if (candidate[name]) {
        candidate[name] = {
          ...candidate[name],
          ...profile,
          name,
          updatedAt: new Date().toISOString(),
        };
        updated++;
      } else {
        candidate[name] = {
          name,
          description: profile.description,
          ...(profile.extends ? { extends: profile.extends } : {}),
          servers: profile.servers ?? [],
          providerOverrides: profile.providerOverrides ?? {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        added++;
      }
    }

    for (const name of Object.keys(candidate)) resolveProfileExtends(name, candidate);
    data.profiles = candidate;
    await this.save(data);
    return { added, updated };
  }

  async exportTo(filePath: string, profileName?: string): Promise<void> {
    const data = await this.load();

    if (profileName && !data.profiles[profileName]) {
      throw new Error(`Profile "${profileName}" not found.`);
    }

    const toExport = profileName
      ? { [profileName]: data.profiles[profileName] }
      : data.profiles;

    await writeFile(
      filePath,
      JSON.stringify({ profiles: toExport }, null, 2) + '\n',
      'utf-8',
    );
  }

  async initPresets(): Promise<{ added: number; total: number }> {
    const data = structuredClone(await this.load());
    let added = 0;

    for (const [name, preset] of Object.entries(PRESET_PROFILES)) {
      if (!data.profiles[name]) {
        data.profiles[name] = {
          name,
          ...preset,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        added++;
      }
    }

    await this.save(data);
    return { added, total: Object.keys(PRESET_PROFILES).length };
  }

  clearCache(): void {
    this.cache = null;
  }
}
