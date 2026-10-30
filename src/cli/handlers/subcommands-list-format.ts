// Focused subcommand handlers preserving the public facade.
import type { HandlerResult } from "./types.js";
import { discoverProjectLocalBundles } from "../../extensions/project-local-discovery.js";
import { buildUpstreamRegistry } from "../../extensions/upstream-registry.js";
import { resolveShadows } from "../../extensions/shadow-resolver.js";
/**
 * Format `aiwg list --project-local` output: only project-local bundles, with
 * per-type breakdown and any validation errors surfaced. (#1034)
 */
export function formatProjectLocalOnly(
  result: Awaited<ReturnType<typeof discoverProjectLocalBundles>>
): HandlerResult {
  let output = '';
  const total =
    result.counts.extension +
    result.counts.addon +
    result.counts.framework +
    result.counts.plugin;

  if (total === 0 && result.errors.length === 0) {
    output += '\nNo project-local bundles found.\n';
    output += '\nTip: place a manifest.json under the configured AIWG artifact root at {extensions,addons,frameworks,plugins,providers}/<name>/ to author a project-local artifact.\n';
    return { exitCode: 0, message: output };
  }

  output += `\nProject-local bundles (${total}):\n`;
  output += '─'.repeat(60) + '\n';
  for (const b of result.bundles) {
    output += `  ${b.id} [project] [${b.type}] v${b.manifest.version}\n`;
    output += `    Path: ${b.localPath}\n`;
    output += `    Description: ${b.manifest.description.slice(0, 80)}${b.manifest.description.length > 80 ? '...' : ''}\n\n`;
  }

  if (result.errors.length > 0) {
    output += '\nValidation errors:\n';
    output += '─'.repeat(60) + '\n';
    for (const e of result.errors.slice(0, 10)) {
      output += `  [${e.severity}] ${e.path}\n`;
      output += `    ${e.field}: expected ${e.expected}, got ${e.actual}\n`;
      if (e.hint) output += `    hint: ${e.hint}\n`;
    }
    if (result.errors.length > 10) {
      output += `  ... and ${result.errors.length - 10} more\n`;
    }
  }

  output += '\n' + '═'.repeat(60) + '\n';
  output += `Counts by type: extension=${result.counts.extension} addon=${result.counts.addon} framework=${result.counts.framework} plugin=${result.counts.plugin}\n`;

  return { exitCode: 0, message: output };
}

/**
 * Format `aiwg list --shadows` output: only artifacts that currently shadow
 * an upstream artifact, with safety-critical and override status. (#1036)
 */
export async function formatShadowsOnly(
  projectLocal: Awaited<ReturnType<typeof discoverProjectLocalBundles>>
): Promise<HandlerResult> {
  let output = '';

  if (projectLocal.bundles.length === 0) {
    output += '\nNo project-local bundles — no shadows possible.\n';
    return { exitCode: 0, message: output };
  }

  const { getFrameworkRoot: gfr } = await import('../../channel/manager.mjs');
  const frameworkRoot = await gfr();
  const upstream = await buildUpstreamRegistry({ frameworkRoot });
  const result = await resolveShadows(projectLocal.bundles, upstream);

  if (result.shadows.length === 0) {
    output += '\nNo active shadows.\n';
    output += '\nProject-local bundles deploy alongside upstream without collision.\n';
    return { exitCode: 0, message: output };
  }

  output += `\nActive shadows (${result.shadows.length}):\n`;
  output += '─'.repeat(60) + '\n';
  for (const r of result.shadows) {
    const sc = r.upstream?.safetyCritical ? ' [SAFETY-CRITICAL]' : '';
    output += `  ${r.artifactType}/${r.artifactId}${sc}\n`;
    output += `    Bundle: ${r.bundleId} (${r.bundleLocalPath})\n`;
    output += `    Project-local: ${r.artifactSourcePath}\n`;
    if (r.upstream) {
      output += `    Shadows ${r.upstream.source}: ${r.upstream.sourcePath}\n`;
    }
    output += `    Verdict: ${r.verdict}\n\n`;
  }

  if (result.blockedBundleIds.size > 0) {
    output += `\n⚠ ${result.blockedBundleIds.size} bundle(s) blocked from deployment due to unsafe shadows.\n`;
  }

  return { exitCode: 0, message: output };
}

/**
 * #1156 Phase 1 — `--scope user` detection. Mirrors `detectScope()` from
 * scope-resolver but tolerates the absence of the flag (no throw on absent).
 * Returns true when args contain `--scope user`.
 */
export function isScopeUser(args: ReadonlyArray<string>): boolean {
  const idx = args.findIndex((a) => a === '--scope');
  if (idx === -1) return false;
  return args[idx + 1] === 'user';
}

/**
 * #1156 Phase 1 — Format the per-user registry (~/.aiwg/installed.json) as a
 * human-readable inventory. Used by `aiwg list --scope user` / `aiwg list
 * --user`. Independent of any project — works from any cwd.
 */
export async function formatUserScopeRegistry(): Promise<HandlerResult> {
  const { readUserRegistry, userRegistryPath } = await import('../../config/user-registry.js');
  const registry = await readUserRegistry();
  const frameworks = Object.entries(registry.installed);

  let output = '';
  if (frameworks.length === 0) {
    output += '\nNo frameworks deployed at user scope.\n';
    output += `\nRegistry path: ${userRegistryPath()}\n`;
    output += '\nTip: run `aiwg use <framework> --provider <p> --scope user` to install at user scope.\n';
    return { exitCode: 0, message: output };
  }

  output += `\nUser-scope deployments (${frameworks.length}):\n`;
  output += '─'.repeat(60) + '\n';
  for (const [name, entry] of frameworks) {
    output += `  ${name}  v${entry.version}  [${entry.source}]\n`;
    output += `    Installed: ${entry.installedAt}\n`;
    const providers = Object.entries(entry.deployedTo);
    for (const [provider, counts] of providers) {
      const parts: string[] = [];
      if (counts.agents > 0) parts.push(`${counts.agents} agents`);
      if (counts.commands > 0) parts.push(`${counts.commands} commands`);
      if (counts.skills > 0) parts.push(`${counts.skills} skills`);
      if (counts.rules > 0) parts.push(`${counts.rules} rules`);
      output += `    ${provider}: ${parts.length > 0 ? parts.join(', ') : '(empty)'}\n`;
    }
    output += '\n';
  }

  output += '═'.repeat(60) + '\n';
  output += `Registry path: ${userRegistryPath()}\n`;
  return { exitCode: 0, message: output };
}
