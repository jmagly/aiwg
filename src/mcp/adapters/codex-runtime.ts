/**
 * Codex Per-Profile Runtime-Home Adapter
 *
 * Codex has no native per-session config flag (unlike `claude --mcp-config`).
 * This adapter implements the sysops `codex-role.sh` pattern:
 *
 *   1. Create ~/.codex/roles-runtime/<profile>/ per profile
 *   2. Symlink shared state (history, sessions) into the runtime home
 *   3. Write a profile-scoped config.toml (stripped global MCP, only profile servers)
 *   4. Launch with HOME=<runtime-home> codex
 *   5. Auth flows execute against the runtime home — OAuth tokens are isolated per profile
 *
 * Reference: roctinam/sysops:scripts/mcp-roles/codex-role.sh
 *
 * @implements #892
 */

import { readFile, writeFile, mkdir, symlink, access, readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { buildServerToml, type McpServerDefinition } from '../registry.js';
import { assertCredentialPolicy, type McpCredentialPolicy } from '../credentials.mjs';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface RuntimeHomeInfo {
  profile: string;
  path: string;
  exists: boolean;
  hasConfig: boolean;
  hasOrphanedAuth: boolean;  // auth tokens present but profile may have been removed
}

export interface SharedStatePolicy {
  /** Files/dirs to symlink from the global codex home (shared across profiles) */
  shared: string[];
  /** Files/dirs that are profile-isolated (not symlinked) */
  isolated: string[];
}

const DEFAULT_SHARED_STATE: SharedStatePolicy = {
  // Shared: operator history and session index are cross-profile
  shared: ['history.jsonl', 'sessions'],
  // Isolated: auth tokens and per-profile config are scoped to the runtime home
  isolated: ['auth.json', '.credentials', 'config.toml'],
};

// ─────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────

function codexHome(): string {
  return join(homedir(), '.codex');
}

function runtimeHomesDir(): string {
  return join(codexHome(), 'roles-runtime');
}

function runtimeHomePath(profile: string): string {
  return join(runtimeHomesDir(), profile);
}

function runtimeConfigPath(profile: string): string {
  return join(runtimeHomePath(profile), 'config.toml');
}

// ─────────────────────────────────────────────
// Runtime home management
// ─────────────────────────────────────────────

/**
 * Ensure the runtime home directory exists for a profile.
 * Creates the directory and sets up shared-state symlinks.
 * Returns the runtime home path.
 */
export async function ensureRuntimeHome(
  profile: string,
  policy: SharedStatePolicy = DEFAULT_SHARED_STATE,
): Promise<string> {
  const rtHome = runtimeHomePath(profile);

  await mkdir(rtHome, { recursive: true });

  const globalHome = codexHome();

  // Create symlinks for shared state (only if source exists in global home)
  for (const name of policy.shared) {
    const source = join(globalHome, name);
    const link = join(rtHome, name);

    // Skip if already linked or already exists
    try {
      await access(link);
      continue; // already exists
    } catch {
      // doesn't exist — create symlink if source exists
    }

    if (existsSync(source)) {
      try {
        await symlink(source, link);
      } catch {
        // ignore symlink errors (e.g., cross-device — not fatal)
      }
    }
  }

  return rtHome;
}

/**
 * Write a profile-scoped config.toml into the runtime home.
 * Strips all [mcp_servers.*] blocks from any existing global config.toml
 * and writes only the profile's servers.
 */
export async function writeProfileConfig(
  profile: string,
  servers: McpServerDefinition[],
  options: { credentialPolicy?: McpCredentialPolicy } = {},
): Promise<void> {
  assertCredentialPolicy(servers, options.credentialPolicy);
  const rtHome = runtimeHomePath(profile);
  await mkdir(rtHome, { recursive: true });

  // Load global config.toml as base (strip existing mcp_servers blocks)
  let baseConfig = '';
  const globalConfigPath = join(codexHome(), 'config.toml');
  try {
    const raw = await readFile(globalConfigPath, 'utf-8');
    // Remove all [mcp_servers.*] sections and their content
    baseConfig = raw
      .replace(/\[mcp_servers\.[^\]]+\][\s\S]*?(?=\n\[|\s*$)/g, '')
      .trimEnd();
  } catch {
    // No global config — start empty
  }

  // Build profile-specific [mcp_servers.*] TOML sections
  const mcpSections = servers.map((server) => buildServerToml(server));

  const configContent =
    (baseConfig ? baseConfig + '\n\n' : '') +
    mcpSections.join('\n\n') +
    '\n';

  await writeFile(runtimeConfigPath(profile), configContent, 'utf-8');
}

/**
 * Launch Codex with a profile's runtime home.
 * Sets HOME=<runtime-home> so Codex reads its profile-scoped config and
 * OAuth tokens are written to the runtime home (isolated from other profiles).
 */
export function launchWithProfile(
  profile: string,
  extraArgs: string[] = [],
): SpawnSyncReturns<Buffer> {
  const rtHome = runtimeHomePath(profile);

  if (!existsSync(rtHome)) {
    throw new Error(
      `Runtime home for profile "${profile}" does not exist.\n` +
      `Run "aiwg mcp profile add ${profile}" or "aiwg session --provider codex --profile ${profile}" to create it.`,
    );
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: rtHome,
  };

  return spawnSync('codex', extraArgs, {
    stdio: 'inherit',
    env,
  });
}

/**
 * Run `codex login` within a profile's runtime home to isolate OAuth tokens.
 */
export async function loginInProfile(profile: string): Promise<void> {
  await ensureRuntimeHome(profile);
  const rtHome = runtimeHomePath(profile);

  console.log(`\n  Running codex login in profile "${profile}" runtime home...`);
  console.log(`  Auth tokens will be isolated to: ${rtHome}\n`);

  const result = spawnSync('codex', ['login'], {
    stdio: 'inherit',
    env: {
      ...(process.env as Record<string, string>),
      HOME: rtHome,
    },
  });

  if (result.status !== 0) {
    throw new Error(`codex login failed with exit code ${result.status ?? 'unknown'}`);
  }
}

// ─────────────────────────────────────────────
// Introspection
// ─────────────────────────────────────────────

/**
 * List all runtime homes (one per profile that has been set up).
 */
export async function listRuntimeHomes(): Promise<RuntimeHomeInfo[]> {
  const dir = runtimeHomesDir();

  if (!existsSync(dir)) return [];

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  return Promise.all(
    entries.map(async (name) => {
      const rtPath = join(dir, name);
      const configPath = join(rtPath, 'config.toml');
      const authPath = join(rtPath, 'auth.json');

      return {
        profile: name,
        path: rtPath,
        exists: true,
        hasConfig: existsSync(configPath),
        hasOrphanedAuth: existsSync(authPath),
      };
    }),
  );
}

/**
 * Remove a profile's runtime home (destructive — deletes auth tokens).
 * Returns false if the home does not exist.
 */
export async function removeRuntimeHome(profile: string): Promise<boolean> {
  const rtHome = runtimeHomePath(profile);
  if (!existsSync(rtHome)) return false;

  const result = spawnSync('rm', ['-rf', rtHome], { stdio: 'inherit' });
  return result.status === 0;
}

/**
 * Detect orphaned runtime homes: runtime homes where the corresponding
 * MCP profile no longer exists in the profile registry.
 */
export async function detectOrphanedRuntimes(
  knownProfiles: string[],
): Promise<RuntimeHomeInfo[]> {
  const homes = await listRuntimeHomes();
  return homes.filter((h) => !knownProfiles.includes(h.profile));
}

// ─────────────────────────────────────────────
// Re-exports (convenience)
// ─────────────────────────────────────────────

export { DEFAULT_SHARED_STATE };
