#!/usr/bin/env node
/**
 * aiwg clean:providers
 *
 * Resets provider-deployed state between builds/tests. `.claude/` is shared
 * with Claude Desktop/Code, which keeps its own session and workspace state
 * there — `worktrees/`, `settings.local.json`, `settings.json` (and its
 * `.bak.*` backups), `launch.json`, and anything else AIWG never wrote.
 * `rm -rf .claude` destroys that state along with the AIWG-deployed
 * artifacts; none of it is recoverable from source.
 *
 * AIWG only needs to remove what it itself deployed into `.claude/`. The
 * provider definition registry (`getProviderArtifactPathStrings` /
 * `getProviderKernelSkillPath`) already records exactly those subpaths —
 * reuse it instead of hand-maintaining a parallel list here.
 *
 * `.cursor/` and `.agents/` have the same problem (#3055): both hold
 * AIWG-deployed subdirectories (agents, skills, rules, commands, ...) the
 * same way `.claude/` does, via `resolveDirectoryManagedPaths` below, but
 * each also holds a *project MCP config file* AIWG merges entries into
 * rather than owns outright — `.cursor/mcp.json` and
 * `.agents/plugins/aiwg/mcp_config.json` (plus its legacy flat config).
 * `opencode.json` is the same shape: AIWG merges
 * one `instructions` entry into it. These files get a merge-aware
 * pass (`cleanMergeTarget`) instead of being removed wholesale.
 *
 * Every other target below keeps the previous whole-directory/whole-file
 * removal behavior unchanged. The audit for #2626 confirmed `.claude` (and,
 * for #3055, `.cursor`/`.agents`/`opencode.json`) as the destructive cases;
 * widening further is a separate, unverified change.
 *
 * @implements #2626
 * @implements #3055
 */

import { readFile, rm } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { importImpl } from '../_resolve-impl.mjs';
const { assertConfigDestination, writeConfigAtomic } = await importImpl(import.meta.url, 'mcp/config-file.mjs');

// The registry lives in TypeScript sources, so it is only importable after a
// build. Cleaning has to work on a tree with no build output, so fall back to
// the same subpaths written out by hand. The fallback never widens to the
// whole directory.
const FALLBACK_SCOPED_PATHS = [
  '.claude/agents',
  '.claude/commands',
  '.claude/.aiwg/skills',
  '.claude/rules',
  '.claude/hooks',
  '.claude/skills',
];

// Same no-build-output constraint as FALLBACK_SCOPED_PATHS, for the
// directory-wide scan `resolveDirectoryManagedPaths` does across every
// provider's artifact/kernel-skill paths.
const FALLBACK_DIRECTORY_PATHS = {
  '.cursor': ['.cursor/agents', '.cursor/commands', '.cursor/.aiwg/skills', '.cursor/rules', '.cursor/skills'],
  '.agents': ['.agents/agents', '.agents/.aiwg/skills', '.agents/skills'],
};

let registry = null;
try {
  registry = await importImpl(import.meta.url, 'providers/provider-definitions.js');
} catch {
  registry = null;
}

// Unchanged from the previous `rm -rf` list — no confirmed shared/merge-owned
// state found for these during the #2626 audit (see tool report). `.cursor`,
// `.agents`, and `opencode.json` moved out of this list for #3055; see above.
export const WHOLE_REMOVE_TARGETS = [
  '.codex',
  '.factory',
  '.warp',
  '.windsurf',
  '.hermes',
  '.hermes.md',
  '.devin',
];

// Claude Code/Desktop shares `.claude/` with AIWG; only the subpaths AIWG
// itself deploys are removed there.
export const SCOPED_PROVIDER = 'claude';

// Cursor and Antigravity share `.cursor/` and `.agents/` with AIWG the same
// way; only the subpaths AIWG itself deploys are removed. Unlike `.claude`,
// more than one provider deploys under `.agents/` (the shared
// `.agents/skills` namespace), so these are resolved by directory prefix
// across every registered provider rather than one provider id.
export const SCOPED_DIRECTORIES = ['.cursor', '.agents'];

export function resolveScopedProviderManagedPaths(source = registry) {
  if (!source) return [...FALLBACK_SCOPED_PATHS];
  const artifactPaths = source.getProviderArtifactPathStrings(SCOPED_PROVIDER);
  const kernelSkills = source.getProviderKernelSkillPath(SCOPED_PROVIDER);
  const managed = [
    ...(artifactPaths ? Object.values(artifactPaths) : []),
    kernelSkills,
  ].filter(Boolean);
  return [...new Set(managed)];
}

/**
 * Every AIWG artifact/kernel-skill path, across every registered provider,
 * that lives under `dirPrefix`. Generalizes resolveScopedProviderManagedPaths
 * to directories more than one provider deploys into (`.agents/skills` is a
 * shared namespace), reusing the same registry data instead of a
 * hand-maintained per-directory provider list.
 */
export function resolveDirectoryManagedPaths(dirPrefix, source = registry) {
  if (!source) return [...(FALLBACK_DIRECTORY_PATHS[dirPrefix] ?? [])];
  const managed = new Set();
  for (const definition of source.listProviderDefinitions()) {
    const artifactPaths = source.getProviderArtifactPathStrings(definition.id);
    const kernelSkills = source.getProviderKernelSkillPath(definition.id);
    for (const candidate of [...(artifactPaths ? Object.values(artifactPaths) : []), kernelSkills]) {
      if (candidate && (candidate === dirPrefix || candidate.startsWith(`${dirPrefix}/`))) {
        managed.add(candidate);
      }
    }
  }
  return [...managed];
}

// ── Merge-target files: AIWG merges entries into these, it does not own them ──
//
// Identification reuses the same receipts the rest of AIWG uses to tell its
// own entries apart from a user's, rather than guessing:
//
//  - MCP server entries (`.cursor/mcp.json`, Antigravity plugin + legacy configs): the
//    central MCP server registry (~/.aiwg/mcp-servers.json, written by
//    src/mcp/registry.ts) records, per server, which providers it was
//    injected into (`injectedProviders`). An entry in a provider's
//    mcpServers map is AIWG's if that provider appears in the matching
//    registry server's `injectedProviders`.
//  - `opencode.json`'s `instructions` entry: `registerProviderContext()` in
//    src/smiths/context-pipeline/workspace-context.ts always adds exactly
//    'WORKSPACE.md' and 'AIWG.md', nothing else; those two literal strings
//    are AIWG's.
const OPENCODE_MANAGED_INSTRUCTIONS = ['WORKSPACE.md', 'AIWG.md'];

// getMcpInjectionDefinition() (providers/provider-definitions.mjs) is the
// canonical source for configPath/serversKey; this is only the no-build
// fallback, matching it by hand.
const FALLBACK_MERGE_TARGETS = [
  { relPath: '.cursor/mcp.json', providerId: 'cursor', serversKey: 'mcpServers' },
  { relPath: '.agents/plugins/aiwg/mcp_config.json', providerId: 'antigravity', serversKey: 'mcpServers' },
  { relPath: 'opencode.json', providerId: 'opencode', serversKey: 'mcp', instructionsKey: 'instructions' },
];

let mcpProviderDefs = null;
try {
  mcpProviderDefs = await importImpl(import.meta.url, 'providers/provider-definitions.mjs');
} catch {
  mcpProviderDefs = null;
}

function resolveMergeTargets() {
  const legacy = { relPath: '.agents/mcp_config.json', providerId: 'antigravity', serversKey: 'mcpServers' };
  if (!mcpProviderDefs) return [...FALLBACK_MERGE_TARGETS, legacy];
  return FALLBACK_MERGE_TARGETS.map((fallback) => {
    const definition = mcpProviderDefs.getMcpInjectionDefinition(fallback.providerId);
    if (!definition) return fallback;
    return {
      ...fallback,
      relPath: definition.configPath?.path || fallback.relPath,
      serversKey: definition.serversKey || fallback.serversKey,
    };
  }).concat(legacy);
}

/**
 * Load the central MCP server registry's `servers` map. Returns `{}` when no
 * registry file exists yet (nothing has ever been injected — a normal,
 * confidently-known state), or `null` when the registry exists but could not
 * be read as the AIWG-managed receipt it is meant to be (corrupt JSON, or no
 * build output to resolve the loader through). `null` must never be treated
 * as "no managed entries" by a caller — it means "unknown".
 */
async function loadMcpRegistryServers() {
  try {
    const { resolveConfigLayers, loadLayered } = await importImpl(import.meta.url, 'mcp/config-layers.mjs');
    const { resolveUserConfigDir } = await importImpl(import.meta.url, 'config/user-config-dir.mjs');
    const DEFAULT_REGISTRY = { apiVersion: 'aiwg.io/v1', kind: 'McpServerRegistry', servers: {} };
    const layers = resolveConfigLayers();
    if (layers) {
      const layered = await loadLayered(layers, 'mcp-servers.json', 'servers', DEFAULT_REGISTRY);
      return layered.data.servers || {};
    }
    const filePath = path.join(resolveUserConfigDir(), 'mcp-servers.json');
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf-8'));
      return parsed.servers || {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      return null; // Corrupt registry: cannot safely tell AIWG's entries from the user's.
    }
  } catch {
    return null; // No build output to resolve the registry loader through.
  }
}

/** Server names in `registryServers` recorded as injected into `providerId`, or `null` if unknown (see loadMcpRegistryServers). */
function managedServerNames(registryServers, providerId) {
  if (!registryServers) return null;
  const names = new Set();
  for (const [name, server] of Object.entries(registryServers)) {
    if (Array.isArray(server?.injectedProviders) && server.injectedProviders.includes(providerId)) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Remove AIWG-managed entries from a merge-target file in place.
 *
 * - Invalid JSON, or a non-object root: left untouched; caller is told why.
 * - MCP entries whose managed names are unknown (registry unreadable): that
 *   part is skipped and reported; other identifiable entries (instructions)
 *   are still cleaned.
 * - No AIWG-managed entries found anywhere: left untouched, byte-for-byte.
 * - File left with no remaining top-level content after removal: deleted.
 */
async function cleanMergeTarget(absPath, { serversKey, managedNames, instructionsKey }, projectRoot) {
  await assertConfigDestination(absPath, projectRoot);
  let raw;
  try {
    raw = await readFile(absPath, 'utf-8');
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'absent' };
    throw error;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { status: 'invalid-json' };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { status: 'invalid-json' };
  }

  const skipped = [];
  let removedServers = 0;
  if (serversKey) {
    if (managedNames === null) {
      skipped.push('could not read the MCP server registry to identify AIWG-managed MCP entries');
    } else if (data[serversKey] && typeof data[serversKey] === 'object' && !Array.isArray(data[serversKey])) {
      const servers = data[serversKey];
      for (const name of Object.keys(servers)) {
        if (managedNames.has(name)) {
          delete servers[name];
          removedServers += 1;
        }
      }
      if (Object.keys(servers).length === 0) delete data[serversKey];
    }
  }

  let removedInstructions = false;
  if (instructionsKey && Array.isArray(data[instructionsKey])) {
    const current = data[instructionsKey];
    const kept = current.filter((entry) => !OPENCODE_MANAGED_INSTRUCTIONS.includes(entry));
    if (kept.length !== current.length) {
      removedInstructions = true;
      if (kept.length === 0) delete data[instructionsKey];
      else data[instructionsKey] = kept;
    }
  }

  if (removedServers === 0 && !removedInstructions) {
    return skipped.length > 0 ? { status: 'unknown-managed-entries', skipped } : { status: 'no-change' };
  }

  if (Object.keys(data).length === 0) {
    await assertConfigDestination(absPath, projectRoot);
    await rm(absPath, { force: true });
    return { status: 'deleted', removedServers, removedInstructions, skipped };
  }

  await writeConfigAtomic(absPath, `${JSON.stringify(data, null, 2)}\n`, { projectRoot });
  return { status: 'updated', removedServers, removedInstructions, skipped };
}

async function removePath(absPath) {
  await rm(absPath, { recursive: true, force: true });
}

/**
 * Remove provider-deployed state under `projectRoot`. Returns the relative
 * paths removed outright, and notes on merge-target files that were updated
 * in place or left untouched.
 */
export async function cleanProviders(projectRoot = process.cwd()) {
  const removed = [];
  const notes = [];

  // Check merge destinations before removing any provider subpaths beneath them.
  for (const target of resolveMergeTargets()) {
    await assertConfigDestination(path.join(projectRoot, target.relPath), projectRoot);
  }

  for (const target of WHOLE_REMOVE_TARGETS) {
    await removePath(path.join(projectRoot, target));
    removed.push(target);
  }

  for (const relPath of resolveScopedProviderManagedPaths()) {
    await removePath(path.join(projectRoot, relPath));
    removed.push(relPath);
  }

  for (const dir of SCOPED_DIRECTORIES) {
    for (const relPath of resolveDirectoryManagedPaths(dir)) {
      await removePath(path.join(projectRoot, relPath));
      removed.push(relPath);
    }
  }

  const registryServers = await loadMcpRegistryServers();
  for (const target of resolveMergeTargets()) {
    const managedNames = target.serversKey ? managedServerNames(registryServers, target.providerId) : new Set();
    const relPath = target.relPath;
    const result = await cleanMergeTarget(path.join(projectRoot, relPath), {
      serversKey: target.serversKey,
      managedNames,
      instructionsKey: target.instructionsKey,
    }, projectRoot);

    if (result.status === 'deleted') {
      removed.push(relPath);
    } else if (result.status === 'updated') {
      notes.push(`${relPath} (removed AIWG-managed entries)`);
    } else if (result.status === 'invalid-json') {
      notes.push(`${relPath} left untouched: not valid JSON`);
    } else if (result.status === 'unknown-managed-entries') {
      notes.push(`${relPath} left untouched: ${result.skipped.join('; ')}`);
    }
  }

  return { removed, notes };
}

async function main() {
  const projectRoot = process.cwd();
  const { removed, notes } = await cleanProviders(projectRoot);
  console.log('Removed provider-deployed state:');
  for (const target of removed) {
    console.log(`  ${target}`);
  }
  if (notes.length > 0) {
    console.log('Merge-target provider files:');
    for (const note of notes) {
      console.log(`  ${note}`);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
