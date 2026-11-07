/**
 * User-Level Configuration Manager
 *
 * Manages the ~/.aiwg/ (or ~/.config/aiwg/) user configuration directory.
 * Provides get/set/list/validate/reset/path operations for all config files.
 *
 * Resolution order:
 *   1. AIWG_CONFIG env var (explicit override)
 *   2. --config-dir CLI flag (explicit override)
 *   3. ~/.aiwg (primary — simple, discoverable)
 *   4. ~/.config/aiwg (fallback — XDG-compliant)
 *
 * New config files are created in whichever path already exists,
 * defaulting to ~/.aiwg if neither exists.
 *
 * @implements #545
 */

import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { resolveUserConfigDir } from './user-config-dir.mjs';
import type { DecisionConfig } from './decision-config.js';

/**
 * Top-level user preferences schema
 */
export interface UserConfigData {
  decision?: DecisionConfig;
  apiVersion: string;
  kind: string;
  defaults: {
    provider?: string;
    verbosity?: 'normal' | 'quiet' | 'verbose';
    opsHome?: string;
  };
  telemetry: {
    enabled: boolean;
  };
  updates: {
    channel?: 'stable' | 'next' | 'nightly';
    checkOnStartup?: boolean;
  };
  community?: {
    nudges?: boolean;
  };
}

/**
 * Config file metadata for the subsystem registration pattern
 */
export interface ConfigFileSpec {
  filename: string;
  description: string;
  schema?: string;
}

/**
 * Known config files in the user config directory
 */
export const KNOWN_CONFIG_FILES: ConfigFileSpec[] = [
  { filename: 'config.yaml', description: 'Global AIWG user preferences' },
  { filename: 'aiwg.config', description: 'Operator rule pins and capability groups' },
  { filename: 'models.json', description: 'Model tier and provider overrides' },
  { filename: 'ops.json', description: 'Ops workspace registry' },
  { filename: 'mcp-servers.json', description: 'MCP server registry (single source of truth)' },
  { filename: 'packages.yaml', description: 'Installed remote packages (aiwg install)' },
  { filename: 'installation.json', description: 'Canonical global installation identity' },
];

/**
 * Default user config values
 */
export const DEFAULT_USER_CONFIG: UserConfigData = {
  apiVersion: 'aiwg.io/v1',
  kind: 'UserConfig',
  defaults: {
    provider: 'claude',
    verbosity: 'normal',
  },
  telemetry: {
    enabled: false,
  },
  updates: {
    channel: 'stable',
    checkOnStartup: true,
  },
  community: {
    nudges: true,
  },
};

/**
 * Resolve the active user config directory
 *
 * Resolution order:
 *   1. Explicit override (AIWG_CONFIG env or --config-dir)
 *   2. ~/.aiwg (primary)
 *   3. ~/.config/aiwg (fallback)
 *   4. ~/.aiwg (default if neither exists)
 */
export function resolveConfigDir(overridePath?: string): string {
  return resolveUserConfigDir({ configDir: overridePath });
}

/**
 * User-level configuration manager
 */
export class UserConfig {
  private readonly configDir: string;
  private configCache: UserConfigData | null = null;

  constructor(overridePath?: string) {
    this.configDir = resolveConfigDir(overridePath);
  }

  /**
   * Get the resolved config directory path
   */
  getPath(): string {
    return this.configDir;
  }

  /**
   * Ensure the config directory exists
   */
  async ensureDir(): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
  }

  /**
   * Get a config value by dot-notation key
   *
   * Supports keys like:
   *   - "defaults.provider"
   *   - "telemetry.enabled"
   *   - "updates.channel"
   */
  async get(key: string): Promise<unknown> {
    const config = await this.loadConfig();
    return getNestedValue(config as unknown as Record<string, unknown>, key);
  }

  /**
   * Set a config value by dot-notation key
   */
  async set(key: string, value: string): Promise<void> {
    const config = await this.loadConfig();
    const parsed = parseValue(value);
    setNestedValue(config as unknown as Record<string, unknown>, key, parsed);
    await this.saveConfig(config);
    this.configCache = config;
  }

  /**
   * List all config values (merged view across all files)
   */
  async list(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};

    // Load config.yaml (or defaults)
    const config = await this.loadConfig();
    result['config.yaml'] = config;

    // Check for other known files
    for (const spec of KNOWN_CONFIG_FILES) {
      if (spec.filename === 'config.yaml') continue;

      const filePath = resolve(this.configDir, spec.filename);
      try {
        await access(filePath);
        const content = await readFile(filePath, 'utf-8');
        if (spec.filename.endsWith('.json') || spec.filename === 'aiwg.config') {
          result[spec.filename] = JSON.parse(content);
        } else {
          result[spec.filename] = content;
        }
      } catch {
        // File doesn't exist, skip
      }
    }

    return result;
  }

  /**
   * Validate all config files
   *
   * Returns array of validation issues (empty = all valid)
   */
  async validate(): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    // Check config directory exists
    if (!existsSync(this.configDir)) {
      issues.push({
        file: this.configDir,
        severity: 'info',
        message: 'Config directory does not exist (will be created on first use)',
      });
      return issues;
    }

    // Validate config.yaml
    const configPath = resolve(this.configDir, 'config.yaml');
    if (existsSync(configPath)) {
      try {
        const content = await readFile(configPath, 'utf-8');
        const parsed = parseYamlSimple(content);
        if (!parsed.apiVersion) {
          issues.push({
            file: 'config.yaml',
            severity: 'warning',
            message: 'Missing apiVersion field',
          });
        }
        if (!parsed.kind) {
          issues.push({
            file: 'config.yaml',
            severity: 'warning',
            message: 'Missing kind field',
          });
        }
      } catch (err) {
        issues.push({
          file: 'config.yaml',
          severity: 'error',
          message: `Failed to parse: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Validate models.json
    const modelsPath = resolve(this.configDir, 'models.json');
    if (existsSync(modelsPath)) {
      try {
        const content = await readFile(modelsPath, 'utf-8');
        JSON.parse(content);
      } catch (err) {
        issues.push({
          file: 'models.json',
          severity: 'error',
          message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Validate ops.json if present
    const opsPath = resolve(this.configDir, 'ops.json');
    if (existsSync(opsPath)) {
      try {
        const content = await readFile(opsPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed.apiVersion && parsed.apiVersion !== 'aiwg.io/v1') {
          issues.push({
            file: 'ops.json',
            severity: 'warning',
            message: `Unknown apiVersion: ${parsed.apiVersion}`,
          });
        }
      } catch (err) {
        issues.push({
          file: 'ops.json',
          severity: 'error',
          message: `Failed to parse: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return issues;
  }

  /**
   * Reset a key to its default value, or reset all config
   */
  async reset(key?: string): Promise<void> {
    if (!key) {
      // Reset entire config to defaults
      await this.saveConfig({ ...DEFAULT_USER_CONFIG });
      this.configCache = null;
      return;
    }

    // Reset specific key
    const config = await this.loadConfig();
    const defaultValue = getNestedValue(DEFAULT_USER_CONFIG as unknown as Record<string, unknown>, key);
    if (defaultValue !== undefined) {
      setNestedValue(config as unknown as Record<string, unknown>, key, defaultValue);
      await this.saveConfig(config);
      this.configCache = config;
    }
  }

  /**
   * Load config.yaml, creating defaults if it doesn't exist
   */
  private async loadConfig(): Promise<UserConfigData> {
    if (this.configCache) {
      return this.configCache;
    }

    const parsed = await this.readConfig() as unknown as UserConfigData | null;
    if (parsed) {
      this.configCache = {
        ...DEFAULT_USER_CONFIG,
        ...parsed,
        defaults: { ...DEFAULT_USER_CONFIG.defaults, ...parsed.defaults },
        telemetry: { ...DEFAULT_USER_CONFIG.telemetry, ...parsed.telemetry },
        updates: { ...DEFAULT_USER_CONFIG.updates, ...parsed.updates },
        community: { ...DEFAULT_USER_CONFIG.community, ...parsed.community },
      };
      return this.configCache;
    } else {
      // File doesn't exist — return defaults (don't create file yet)
      this.configCache = {
        ...DEFAULT_USER_CONFIG,
        defaults: { ...DEFAULT_USER_CONFIG.defaults },
        telemetry: { ...DEFAULT_USER_CONFIG.telemetry },
        updates: { ...DEFAULT_USER_CONFIG.updates },
        community: { ...DEFAULT_USER_CONFIG.community },
      };
      return this.configCache;
    }
  }

  private async readConfig(): Promise<Record<string, unknown> | null> {
    const configPath = resolve(this.configDir, 'config.yaml');
    try {
      const content = await readFile(configPath, 'utf-8');
      return parseYamlSimple(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Failed to load ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Save config.yaml
   */
  private async saveConfig(config: UserConfigData): Promise<void> {
    // Recheck the existing file even when defaults or cached values are being saved.
    await this.readConfig();
    await this.ensureDir();
    const configPath = resolve(this.configDir, 'config.yaml');
    const yaml = serializeYamlSimple(config as unknown as Record<string, unknown>);
    await writeFile(configPath, yaml, 'utf-8');
  }
}

// ============================================
// Validation types
// ============================================

export interface ValidationIssue {
  file: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

// ============================================
// Simple YAML helpers (no dependency needed for flat configs)
// ============================================

/**
 * Minimal YAML parser for flat/nested config files.
 * Handles the subset we use: scalars, nested objects.
 * For complex YAML, users should use a full parser.
 */
export function parseYamlSimple(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const sections = [{ indent: -1, value: result }];

  for (const line of content.split('\n')) {
    // Skip comments and empty lines
    if (line.trim().startsWith('#') || line.trim() === '') continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // Key: value pair
    const match = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1].trim();
    const rawValue = match[2].trim();

    // Config keys have no legitimate use for prototype-related names at any level.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error('Unsafe config key: prototype-related names are not allowed');
    }

    while (sections.length > 1 && sections.at(-1)!.indent >= indent) sections.pop();
    const parent = sections.at(-1)!;
    if (indent !== 0 && (indent < 2 || sections.length === 1)) continue;
    if (rawValue === '') {
      const section: Record<string, unknown> = {};
      parent.value[key] = section;
      sections.push({ indent, value: section });
    } else {
      parent.value[key] = parseScalar(rawValue);
    }
  }

  return result;
}

function parseScalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  // Strip quotes
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Minimal YAML serializer for our config format
 */
export function serializeYamlSimple(obj: Record<string, unknown>, indent = 0): string {
  const lines: string[] = [];
  const pad = ' '.repeat(indent);

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      lines.push(`${pad}${key}:`);
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${pad}${key}:`);
      lines.push(serializeYamlSimple(value as Record<string, unknown>, indent + 2));
    } else if (typeof value === 'string') {
      // Quote strings that could be misinterpreted
      const needsQuote = /[:#{}[\],&*?|>!%@`]/.test(value) || value === '';
      lines.push(`${pad}${key}: ${needsQuote ? `"${value}"` : value}`);
    } else {
      lines.push(`${pad}${key}: ${String(value)}`);
    }
  }

  return lines.join('\n');
}

// ============================================
// Dot-notation helpers
// ============================================

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  // Reject the entire path before mutating config; key uses below also guard each segment.
  if (parts.some(part => part === '__proto__' || part === 'constructor' || part === 'prototype')) {
    throw new Error('Unsafe config key path: prototype-related segments are not allowed');
  }
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      throw new Error('Unsafe config key path: prototype-related segments are not allowed');
    }
    if (i === parts.length - 1) {
      current[part] = value;
      return;
    }
    if (!Object.hasOwn(current, part) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
}

function parseValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  return value;
}
