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

import { readFile, writeFile, mkdir } from 'fs/promises';
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
  /** Per-provider tool allow/deny overrides */
  providerOverrides?: Record<string, McpProfileProviderOverride>;
  /** ISO timestamp */
  createdAt?: string;
  /** ISO timestamp */
  updatedAt?: string;
}

export interface McpProfileRegistryData {
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

  constructor(configDirOverride?: string) {
    this.configDir = resolveConfigDir(configDirOverride);
  }

  getPath(): string {
    return resolve(this.configDir, PROFILES_FILENAME);
  }

  async load(): Promise<McpProfileRegistryData> {
    if (this.cache) return this.cache;

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

    return this.cache;
  }

  async save(): Promise<void> {
    if (!this.cache) return;
    await mkdir(this.configDir, { recursive: true });
    await writeFile(
      this.getPath(),
      JSON.stringify(this.cache, null, 2) + '\n',
      'utf-8',
    );
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
    const data = await this.load();

    if (data.profiles[profile.name]) {
      throw new Error(
        `Profile "${profile.name}" already exists. Use "aiwg mcp profile edit" to modify it.`,
      );
    }

    await this.validateServers(profile.servers ?? [], serverRegistry);

    data.profiles[profile.name] = {
      ...profile,
      servers: profile.servers ?? [],
      providerOverrides: profile.providerOverrides ?? {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.save();
  }

  async get(name: string): Promise<McpProfile | undefined> {
    const data = await this.load();
    return data.profiles[name];
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
    const data = await this.load();
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
    await this.save();
    return data.profiles[name];
  }

  async remove(name: string): Promise<void> {
    const data = await this.load();
    if (!data.profiles[name]) throw new Error(`Profile "${name}" not found.`);
    delete data.profiles[name];
    await this.save();
  }

  async resolveServers(
    name: string,
    serverRegistry?: McpServerRegistry,
  ): Promise<McpServerDefinition[] | string[]> {
    const profile = await this.get(name);
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
    const data = await this.load();

    let added = 0;
    let updated = 0;

    const profiles = imported.profiles ?? {};

    for (const [name, profile] of Object.entries(profiles)) {
      try {
        this.validateName(name);
      } catch {
        continue;
      }
      if (data.profiles[name]) {
        data.profiles[name] = {
          ...data.profiles[name],
          ...profile,
          name,
          updatedAt: new Date().toISOString(),
        };
        updated++;
      } else {
        data.profiles[name] = {
          name,
          description: profile.description,
          servers: profile.servers ?? [],
          providerOverrides: profile.providerOverrides ?? {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        added++;
      }
    }

    await this.save();
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
    const data = await this.load();
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

    await this.save();
    return { added, total: Object.keys(PRESET_PROFILES).length };
  }

  clearCache(): void {
    this.cache = null;
  }
}
