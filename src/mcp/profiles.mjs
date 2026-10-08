/**
 * MCP Profile Registry (Runtime ESM)
 *
 * Named, ordered subsets of registered MCP servers.
 * Stored in ~/.aiwg/mcp-profiles.json.
 *
 * This is the runtime .mjs version used by cli.mjs.
 * profiles.ts exists for type checking and vitest.
 *
 * @implements #889
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

// ─────────────────────────────────────────────
// Config dir resolution (mirrors registry.mjs)
// ─────────────────────────────────────────────

function resolveConfigDir(overridePath) {
  const envOverride = process.env.AIWG_CONFIG;
  if (overridePath) return resolve(overridePath);
  if (envOverride) return resolve(envOverride);

  const primary = resolve(homedir(), '.aiwg');
  if (existsSync(primary)) return primary;

  const fallback = resolve(homedir(), '.config/aiwg');
  if (existsSync(fallback)) return fallback;

  return primary;
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const PROFILES_FILENAME = 'mcp-profiles.json';

const RESERVED_NAMES = new Set(['all', 'none', 'default']);
const NAME_RE = /^[a-z0-9-]+$/;

const DEFAULT_DATA = {
  apiVersion: 'aiwg.io/v1',
  kind: 'McpProfileRegistry',
  profiles: {},
};

// ─────────────────────────────────────────────
// Preset profiles
// ─────────────────────────────────────────────

export const PRESET_PROFILES = {
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
  #configDir;
  #cache = null;

  constructor(configDirOverride) {
    this.#configDir = resolveConfigDir(configDirOverride);
  }

  getPath() {
    return resolve(this.#configDir, PROFILES_FILENAME);
  }

  async load() {
    if (this.#cache) return this.#cache;

    const filePath = this.getPath();
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      this.#cache = {
        ...DEFAULT_DATA,
        ...parsed,
        profiles: parsed.profiles || {},
      };
    } catch {
      this.#cache = { ...DEFAULT_DATA, profiles: {} };
    }

    return this.#cache;
  }

  async save() {
    if (!this.#cache) return;
    await mkdir(this.#configDir, { recursive: true });
    await writeFile(
      this.getPath(),
      JSON.stringify(this.#cache, null, 2) + '\n',
      'utf-8',
    );
  }

  /**
   * Validate a profile name. Throws on invalid.
   */
  #validateName(name) {
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

  /**
   * Validate that all server names exist in the server registry.
   * Skip validation for the special '__all__' sentinel.
   */
  async #validateServers(serverNames, serverRegistry) {
    if (!serverRegistry) return; // skip if no registry provided
    const missing = [];
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

  /** Add a new profile */
  async add(profile, serverRegistry) {
    this.#validateName(profile.name);
    const data = await this.load();

    if (data.profiles[profile.name]) {
      throw new Error(
        `Profile "${profile.name}" already exists. Use "aiwg mcp profile edit" to modify it.`,
      );
    }

    await this.#validateServers(profile.servers ?? [], serverRegistry);

    data.profiles[profile.name] = {
      name: profile.name,
      description: profile.description,
      servers: profile.servers ?? [],
      providerOverrides: profile.providerOverrides ?? {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.save();
  }

  /** Get a profile by name */
  async get(name) {
    const data = await this.load();
    return data.profiles[name];
  }

  /** List all profiles */
  async list() {
    const data = await this.load();
    return Object.values(data.profiles);
  }

  /** Edit an existing profile (add/remove servers, update description) */
  async edit(name, changes, serverRegistry) {
    const data = await this.load();
    const existing = data.profiles[name];
    if (!existing) {
      throw new Error(`Profile "${name}" not found.`);
    }

    const current = { ...existing };

    if (changes.description !== undefined) {
      current.description = changes.description;
    }

    if (changes.addServers && changes.addServers.length > 0) {
      await this.#validateServers(changes.addServers, serverRegistry);
      for (const s of changes.addServers) {
        if (!current.servers.includes(s)) current.servers.push(s);
      }
    }

    if (changes.removeServers && changes.removeServers.length > 0) {
      current.servers = current.servers.filter(
        (s) => !changes.removeServers.includes(s),
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
      const merge = (before, added) => (added ? [...new Set([...(before ?? []), ...added])] : before);
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

  /** Remove a profile */
  async remove(name) {
    const data = await this.load();
    if (!data.profiles[name]) {
      throw new Error(`Profile "${name}" not found.`);
    }
    delete data.profiles[name];
    await this.save();
  }

  /**
   * Resolve the effective server list for a profile.
   * If the profile contains '__all__', expand to all servers in serverRegistry.
   */
  async resolveServers(name, serverRegistry) {
    const profile = await this.get(name);
    if (!profile) {
      throw new Error(`Profile "${name}" not found.`);
    }

    if (profile.servers.includes('__all__') && serverRegistry) {
      return serverRegistry.list();
    }

    if (!serverRegistry) return profile.servers;

    const resolved = [];
    for (const serverName of profile.servers) {
      const server = await serverRegistry.get(serverName);
      if (server) resolved.push(server);
    }
    return resolved;
  }

  /** Import profiles from a JSON file */
  async importFrom(filePath) {
    const content = await readFile(filePath, 'utf-8');
    const imported = JSON.parse(content);
    const data = await this.load();

    let added = 0;
    let updated = 0;

    const profiles = imported.profiles ?? (
      typeof imported === 'object' && !Array.isArray(imported)
        ? imported
        : {}
    );

    for (const [name, profile] of Object.entries(profiles)) {
      try {
        this.#validateName(name);
      } catch {
        continue; // skip invalid names silently during import
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

  /** Export a profile (or all profiles) to a JSON file */
  async exportTo(filePath, profileName) {
    const data = await this.load();

    const toExport = profileName
      ? { [profileName]: data.profiles[profileName] }
      : data.profiles;

    if (profileName && !data.profiles[profileName]) {
      throw new Error(`Profile "${profileName}" not found.`);
    }

    await writeFile(filePath, JSON.stringify({ profiles: toExport }, null, 2) + '\n', 'utf-8');
  }

  /** Install preset profiles (does not overwrite existing) */
  async initPresets() {
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

  clearCache() {
    this.#cache = null;
  }
}
