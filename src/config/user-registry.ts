/**
 * Per-user AIWG registry — `~/.aiwg/installed.json` (#1156 Phase 1).
 *
 * Tracks frameworks/addons deployed at user scope (`aiwg use --scope user`).
 * Operationally distinct from the project-level `.aiwg/aiwg.config`:
 *
 *   project:      .aiwg/aiwg.config           — installed.{name}
 *   user:         ~/.aiwg/installed.json      — installed.{name}.deployedTo.{provider}
 *
 * Same shape as `AiwgConfig.installed` so existing helpers can be lifted with
 * minimal change. The user registry exists outside any project so `aiwg list
 * --scope user` works from any cwd.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DeployedArtifactCounts, InstalledEntry } from './aiwg-config.js';
import { userScopeConfigPath } from '../cli/scope-resolver.js';

/**
 * Per-artifact-type entry list captured at deploy time. Each list contains the
 * top-level filenames or directory names this deploy created under the
 * provider's user-scope target. `aiwg remove --scope user` walks these to
 * delete precisely what was deployed without disturbing artifacts owned by
 * other frameworks at the same shared user-scope dirs.
 */
export interface UserScopeArtifactEntries {
  agents?: string[];
  commands?: string[];
  skills?: string[];
  rules?: string[];
  behaviors?: string[];
}

/**
 * One per-provider entry in the user registry. Extends the project-scope
 * `DeployedArtifactCounts` with the entry-name lists needed for precise
 * remove. Older registry entries written before #1156 Cycle 3 may lack
 * `entries` — `removeUserScopeDeploy` falls back to the conservative
 * "registry-only revert" behavior in that case.
 */
export interface UserScopeProviderDeploy extends DeployedArtifactCounts {
  /**
   * Entry names recorded by the mirror (one list per artifact type).
   * Optional for back-compat with older registry files.
   */
  entries?: UserScopeArtifactEntries;
}

/**
 * Path to ~/.aiwg/installed.json. Distinct from `userScopeConfigPath()`
 * (which points at ~/.aiwg/aiwg.config and is reserved for future user-level
 * config that mirrors the project aiwg.config structure).
 *
 * Honors `AIWG_USER_REGISTRY_PATH` for test isolation: setting that env var
 * redirects all reads/writes to the supplied path. Production code should
 * never set this — it exists so the test suite can avoid clobbering the real
 * `~/.aiwg/installed.json` on the developer's machine.
 */
/** True when AIWG_USER_REGISTRY_PATH redirects away from ~/.aiwg/installed.json. */
export function isUserRegistryPathOverrideActive(): boolean {
  return Boolean(process.env.AIWG_USER_REGISTRY_PATH?.trim());
}

/**
 * Operator-facing warning for a leftover test override (#246).
 * Docs mark AIWG_USER_REGISTRY_PATH as test-only; doctor/status/use must surface it.
 */
export const USER_REGISTRY_PATH_OVERRIDE_WARN =
  'AIWG_USER_REGISTRY_PATH is set (test override active); user registry is not writing to default ~/.aiwg/installed.json';

export function userRegistryPath(): string {
  const override = process.env.AIWG_USER_REGISTRY_PATH;
  if (override) return override;
  // Reuse the directory portion of userScopeConfigPath() to stay consistent
  // with the documented user-scope convention from ADR-4.
  return dirname(userScopeConfigPath()) + '/installed.json';
}

export interface UserRegistry {
  /** Schema version — bump when the registry shape changes incompatibly. */
  version: '1';
  /** Deployed frameworks/addons keyed by name (e.g., 'sdlc', 'marketing'). */
  installed: Record<string, InstalledEntry>;
}

export function emptyUserRegistry(): UserRegistry {
  return { version: '1', installed: {} };
}

export interface UserRegistryInspection {
  registry: UserRegistry;
  status: 'available' | 'absent' | 'unreadable';
}

/**
 * Read the user registry while preserving whether empty means absent or
 * unreadable. Callers making adoption/readiness claims must not collapse a
 * corrupt or inaccessible registry into proof that an addon is missing.
 */
export async function inspectUserRegistry(): Promise<UserRegistryInspection> {
  const registryFile = userRegistryPath();
  try {
    const raw = await readFile(registryFile, 'utf-8');
    const parsed = JSON.parse(raw) as UserRegistry;
    if (!parsed.installed || typeof parsed.installed !== 'object' || Array.isArray(parsed.installed)) {
      throw new Error('installed must be an object');
    }
    return { registry: { version: '1', installed: parsed.installed }, status: 'available' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { registry: emptyUserRegistry(), status: 'absent' };
    }
    process.stderr.write(`[user-registry] failed to parse ${registryFile}: ${err instanceof Error ? err.message : String(err)} — using empty registry\n`);
    return { registry: emptyUserRegistry(), status: 'unreadable' };
  }
}

/**
 * Read the per-user registry. Returns an empty registry when the file doesn't
 * exist — that's the normal case before the operator's first `aiwg use --scope
 * user`. On parse failure returns the empty registry and writes a stderr
 * warning (the broken file is preserved so the operator can inspect it).
 */
export async function readUserRegistry(): Promise<UserRegistry> {
  return (await inspectUserRegistry()).registry;
}

/** User receipts can describe project-relative provider trees only at HOME. */
export async function homeDeploymentReceipts(projectRoot: string): Promise<Array<[string, InstalledEntry]>> {
  if (resolve(projectRoot) !== resolve(homedir())) return [];
  const registry = await readUserRegistry();
  return Object.entries(registry.installed).map(([name, entry]) => [`user:${name}`, entry]);
}

/**
 * Persist the user registry. Creates the parent directory if missing.
 */
export async function writeUserRegistry(registry: UserRegistry): Promise<void> {
  const path = userRegistryPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
}

/**
 * Record a successful user-scope deploy. Idempotent — re-running `aiwg use
 * --scope user` for the same framework+provider overwrites the prior entry's
 * counts, entries, and timestamp.
 *
 * Mutates the passed registry in place AND writes it to disk so callers don't
 * have to manage the persistence dance themselves.
 *
 * `entries` (optional) records the actual artifact names this deploy
 * mirrored, enabling precise remove later.
 */
export async function recordUserDeploy(opts: {
  framework: string;
  provider: string;
  version: string;
  source: string;
  counts: DeployedArtifactCounts;
  entries?: UserScopeArtifactEntries;
  manifestHash?: string;
}): Promise<UserRegistry> {
  const registry = await readUserRegistry();
  const existing = registry.installed[opts.framework];
  const deployedTo = existing?.deployedTo ?? {};
  // Merge the new counts with the optional entries snapshot. Cast through
  // UserScopeProviderDeploy so the registry can carry the richer shape.
  const merged: UserScopeProviderDeploy = { ...opts.counts };
  if (opts.entries) merged.entries = opts.entries;
  deployedTo[opts.provider] = merged;
  registry.installed[opts.framework] = {
    version: opts.version,
    source: opts.source,
    installedAt: new Date().toISOString(),
    deployedTo,
    manifestHash: opts.manifestHash,
  };
  await writeUserRegistry(registry);
  return registry;
}

/**
 * Remove a framework's user-scope deploy from the registry. If `provider` is
 * specified, removes only that provider's entry; the framework entry stays if
 * other providers remain. Without `provider`, removes the framework entirely.
 *
 * Returns the updated registry. The caller is responsible for the actual
 * filesystem revert (deleting the mirrored artifacts) — this only updates the
 * bookkeeping.
 */
export async function removeUserDeploy(opts: {
  framework: string;
  provider?: string;
}): Promise<UserRegistry> {
  const registry = await readUserRegistry();
  const entry = registry.installed[opts.framework];
  if (!entry) return registry;
  if (opts.provider) {
    delete entry.deployedTo[opts.provider];
    if (Object.keys(entry.deployedTo).length === 0) {
      delete registry.installed[opts.framework];
    }
  } else {
    delete registry.installed[opts.framework];
  }
  await writeUserRegistry(registry);
  return registry;
}
