/**
 * Subcommand Handlers
 *
 * Handlers for MCP, catalog, plugin, and other subcommands.
 * Handles CLI subcommand routing.
 *
 * @implements @.aiwg/architecture/decisions/ADR-001-unified-extension-system.md
 * @implements #56, #57
 * @source @src/cli/router.ts
 * @tests @test/unit/cli/handlers/subcommands.test.ts
 * @issue #33
 */

import type { CommandHandler, HandlerContext, HandlerResult } from "./types.js";
import { createScriptRunner } from "./script-runner.js";
import { getFrameworkRoot } from "../../channel/manager.mjs";
import { getRegistry } from "../../extensions/registry.js";
import { registerDeployedExtensions } from "../../extensions/deployment-registration.js";
import { discoverProjectLocalBundles } from "../../extensions/project-local-discovery.js";
import { buildUpstreamRegistry } from "../../extensions/upstream-registry.js";
import { resolveShadows } from "../../extensions/shadow-resolver.js";
import { sessionHandler } from "./session.js";
import { feedbackHandler } from "./feedback.js";
import { handlerResultFromError } from "../errors.js";
import { getProjectDir } from "../../config/aiwg-config.js";
import { formatDeployedWorkspaceSignalPlan, readWorkspaceSignalPlan } from "../workspace-signals.js";
import * as path from "node:path";
import * as fsSync from "node:fs";
import { pathToFileURL } from "node:url";

/** Generate or deploy the canonical project quickref. */
export const quickrefHandler: CommandHandler = {
  id: 'quickref',
  name: 'Project Quickref',
  description: 'Generate and deploy an always-visible project quickref',
  category: 'project',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const action = ctx.args.find(arg => !arg.startsWith('-')) ?? 'generate';
    if (!ctx.args.includes('--project')) {
      return { exitCode: 1, message: 'Error: project quickrefs require --project\n\nUsage: aiwg quickref generate|deploy --project [--provider <id>] [--dry-run]' };
    }
    if (!['generate', 'deploy'].includes(action)) {
      return { exitCode: 1, message: `Error: unknown quickref action '${action}' (expected generate or deploy)` };
    }

    const {
      generateProjectQuickref,
      deployProjectQuickref,
    } = await import('../../extensions/project-quickref.js');
    try {
      if (action === 'generate') {
        const result = await generateProjectQuickref(ctx.cwd, { dryRun: ctx.dryRun });
        const verb = ctx.dryRun ? 'Would generate' : result.changed ? 'Generated' : 'Unchanged';
        console.log(`${verb} ${result.skillName}`);
        console.log(`  Source: ${result.sourcePath}`);
        console.log(`  Output: ${result.outputPath}`);
        for (const warning of result.warnings) console.log(`  Warning: ${warning}`);
        if (ctx.dryRun) {
          console.log('\n--- preview ---\n');
          console.log(result.content);
        }
        return { exitCode: 0 };
      }

      const providerIndex = ctx.args.indexOf('--provider');
      const explicitProvider = providerIndex >= 0 ? ctx.args[providerIndex + 1] : undefined;
      const { readAiwgConfig } = await import('../../config/aiwg-config.js');
      const config = await readAiwgConfig(ctx.cwd);
      const providers = explicitProvider ? [explicitProvider] : (config?.providers ?? []);
      if (providers.length === 0) {
        return { exitCode: 1, message: 'No providers configured. Pass --provider <id> or add providers to .aiwg/aiwg.config.' };
      }
      for (const provider of providers) {
        const result = await deployProjectQuickref(ctx.cwd, provider, { dryRun: ctx.dryRun });
        const verb = ctx.dryRun ? 'Would deploy' : result.changed ? 'Deployed' : 'Unchanged';
        console.log(`${verb} ${result.skillName} -> ${result.provider}: ${result.targetPath}${result.emulated ? ' (emulated skill surface)' : ''}`);
        for (const stale of result.pruned) {
          console.log(`  ${ctx.dryRun ? 'Would prune' : 'Pruned'} stale managed quickref: ${stale}`);
        }
      }
      return { exitCode: 0 };
    } catch (error) {
      return { exitCode: 1, message: `Project quickref failed: ${(error as Error).message}` };
    }
  },
};

/**
 * Provider artifact-path map for `aiwg list` provider detection (#1530).
 *
 * Mirrors the `collectProviderDeployments` provider list in
 * `tools/cli/workspace-status.mjs` so `aiwg list` and `aiwg status` agree on
 * what counts as a deployed provider. Keep the two lists in sync. The
 * `agents`/`commands`/`skills` paths feed `registerDeployedExtensions`;
 * each provider that has at least one populated artifact dir is registered.
 *
 * Some providers use singular dir names (`opencode` → `.opencode/agent/`)
 * and some have non-uniform paths (`copilot` → `.github/agents/` for agents,
 * `.github/prompts/` for commands). The map encodes both.
 */
type ProviderDeployTargets = {
  name: string;
  root: string;
  agentsPath: string;
  skillsPath: string;
  commandsPath: string;
};

const LIST_PROVIDER_TARGETS: ReadonlyArray<ProviderDeployTargets> = [
  { name: 'claude', root: '.claude', agentsPath: '.claude/agents', skillsPath: '.claude/skills', commandsPath: '.claude/commands' },
  { name: 'codex', root: '.codex', agentsPath: '.codex/agents', skillsPath: '.codex/skills', commandsPath: '.codex/commands' },
  { name: 'copilot', root: '.github', agentsPath: '.github/agents', skillsPath: '.github/skills', commandsPath: '.github/prompts' },
  { name: 'cursor', root: '.cursor', agentsPath: '.cursor/agents', skillsPath: '.cursor/skills', commandsPath: '.cursor/commands' },
  { name: 'opencode', root: '.opencode', agentsPath: '.opencode/agent', skillsPath: '.opencode/skill', commandsPath: '.opencode/command' },
  { name: 'warp', root: '.warp', agentsPath: '.warp/agents', skillsPath: '.warp/skills', commandsPath: '.warp/commands' },
  { name: 'factory', root: '.factory', agentsPath: '.factory/droids', skillsPath: '.factory/skills', commandsPath: '.factory/commands' },
  { name: 'windsurf', root: '.windsurf', agentsPath: '.windsurf/agents', skillsPath: '.windsurf/skills', commandsPath: '.windsurf/workflows' },
  { name: 'universal', root: '.agents', agentsPath: '.agents/agents', skillsPath: '.agents/skills', commandsPath: '.agents/commands' },
];

function hasAnyPopulated(cwd: string, p: ProviderDeployTargets): boolean {
  const candidates = [p.agentsPath, p.skillsPath, p.commandsPath];
  for (const rel of candidates) {
    const abs = path.join(cwd, rel);
    try {
      if (fsSync.statSync(abs).isDirectory() && fsSync.readdirSync(abs).length > 0) return true;
    } catch {
      // dir doesn't exist or unreadable — skip
    }
  }
  return false;
}

function detectDeployedProviders(cwd: string): ProviderDeployTargets[] {
  return LIST_PROVIDER_TARGETS.filter(p => hasAnyPopulated(cwd, p));
}

const REMOVE_FLAGS_WITH_VALUES = new Set([
  '--provider',
  '--platform',
  '--scope',
  '--target',
]);

function firstRemovePositional(args: ReadonlyArray<string>): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (REMOVE_FLAGS_WITH_VALUES.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

function parseRemoveProvider(args: ReadonlyArray<string>): { provider?: string; error?: string } {
  const idx = args.findIndex(a => a === '--provider' || a === '--platform');
  if (idx < 0) return {};
  const provider = args[idx + 1];
  if (!provider || provider.startsWith('-')) {
    return { error: 'Error: --provider requires a provider name' };
  }
  return { provider };
}

/**
 * MCP server command handler
 *
 * Dynamically imports and delegates to src/mcp/cli.mjs.
 * Handles subcommands: serve, install, info
 */
export const mcpHandler: CommandHandler = {
  id: "aiwg-mcp-server",
  name: "AIWG MCP Server",
  description: "AIWG MCP server commands (serve, install, add, remove, update, list, inject, info)",
  category: "mcp",
  aliases: ["mcp", "aiwg-mcp"],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      // Dynamic import to avoid loading MCP dependencies unless needed
      const { main } = await import("../../mcp/cli.mjs");
      await main(ctx.args);

      return {
        exitCode: 0,
      };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `MCP command failed: ${result.message}` };
    }
  },
};

/**
 * Model catalog command handler
 *
 * Dynamically imports and delegates to src/catalog/cli.mjs.
 * Handles subcommands: list, info, search
 */
export const catalogHandler: CommandHandler = {
  id: "catalog",
  name: "Model Catalog",
  description: "Model catalog commands (list, info, search)",
  category: "catalog",
  aliases: [],

  async help(): Promise<HandlerResult> {
    const { printCatalogHelp } = await import("../../catalog/cli.mjs");
    printCatalogHelp();
    return { exitCode: 0 };
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      // Dynamic import to avoid loading catalog dependencies unless needed
      const { main } = await import("../../catalog/cli.mjs");
      await main(ctx.args);

      return {
        exitCode: 0,
      };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `Catalog command failed: ${result.message}` };
    }
  },
};

/**
 * List frameworks handler
 *
 * Lists deployed extensions from the registry.
 * Falls back to legacy plugin-status script if needed.
 */
export const listHandler: CommandHandler = {
  id: "list",
  name: "List Frameworks",
  description: "List installed frameworks and plugins",
  category: "framework",
  aliases: ["ls"],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    // Filter args: positional type filter, plus --project-local flag (#1034)
    const projectLocalOnly = ctx.args.includes('--project-local');
    const shadowsOnly = ctx.args.includes('--shadows');
    const deployedOnly = ctx.args.includes('--deployed');
    const filterType = ctx.args.find((a) => !a.startsWith('--')); // 'agents'|'skills'|'commands'|'all'|undefined

    // #1156 Phase 1 — --scope user / --user surfaces the per-user registry
    // (~/.aiwg/installed.json) instead of the project-scope deployed-extensions
    // registry. Works from any cwd; does not require a project to be present.
    const userScopeRequested = ctx.args.includes('--user') || isScopeUser(ctx.args);
    if (userScopeRequested) {
      return await formatUserScopeRegistry();
    }

    // Project-local bundle discovery (#1034) — read-only scan, no deploy
    const projectLocal = await discoverProjectLocalBundles(ctx.cwd);

    if (shadowsOnly) {
      // #1036 — surface only artifacts that shadow upstream
      return await formatShadowsOnly(projectLocal);
    }

    if (projectLocalOnly) {
      // --project-local: only show project-local bundles; skip the deployed-
      // extension registry read entirely
      return formatProjectLocalOnly(projectLocal);
    }

    // Ensure registry is populated with deployed extensions
    const registry = getRegistry();

    // If registry is empty, try to populate it from EVERY deployed provider
    // in the workspace (not just claude). Fixes #1530: in a Codex-only
    // workspace the legacy hard-coded `.claude/...` lookup reported zero
    // extensions even though `.codex/` was populated. Detection mirrors
    // `tools/cli/workspace-status.mjs` so `aiwg list` and `aiwg status`
    // agree on what counts as deployed.
    //
    // `--provider <name>` narrows registration to one provider; otherwise
    // we register the union of everything detected so a multi-provider
    // workspace shows everything in a single inventory.
    if (registry.size === 0) {
      try {
        const provIdx = ctx.args.findIndex((a) => a === '--provider' || a === '--platform');
        const requestedProvider = provIdx >= 0 ? ctx.args[provIdx + 1] : undefined;

        let targets = detectDeployedProviders(ctx.cwd);
        if (requestedProvider) {
          targets = targets.filter((p) => p.name === requestedProvider);
          if (targets.length === 0) {
            return {
              exitCode: 1,
              message: `Error: provider '${requestedProvider}' is not deployed in this workspace.\n\nRun 'aiwg status' to see deployed providers.`,
            };
          }
        }

        if (targets.length === 0) {
          // No deployed providers detected → return a clean empty-inventory
          // message rather than dispatching to the legacy script (which
          // requires a path argument it doesn't get here). Matches the
          // legacy script's helpful guidance from #1530.
          return {
            exitCode: 0,
            message:
              'No agents, skills, or commands deployed in this workspace.\n\n' +
              'Tip: Deploy a framework with "aiwg use sdlc" (or another framework) to get started.\n' +
              'Run "aiwg status" for workspace health detail.\n',
          };
        }

        for (const target of targets) {
          await registerDeployedExtensions(registry, {
            agentsPath: target.agentsPath,
            skillsPath: target.skillsPath,
            commandsPath: target.commandsPath,
            provider: target.name,
            cwd: ctx.cwd,
          });
        }
      } catch (error) {
        // If registry population fails, fall back to legacy script
        const frameworkRoot = await getFrameworkRoot();
        const runner = createScriptRunner(frameworkRoot);
        return runner.run("tools/plugin/plugin-status-cli.mjs", ctx.args, {
          cwd: ctx.cwd,
        });
      }
    }

    // Determine what to show
    const showAgents = !filterType || filterType === 'agents' || filterType === 'all';
    const showSkills = !filterType || filterType === 'skills' || filterType === 'all';
    const showCommands = !filterType || filterType === 'commands' || filterType === 'all';

    let output = '';

    if (showAgents) {
      const agents = registry.getByType('agent');
      output += `\nAgents (${agents.length}):\n`;
      output += '─'.repeat(60) + '\n';

      if (agents.length === 0) {
        output += '  No agents deployed\n';
      } else {
        for (const agent of agents.slice(0, 20)) { // Limit to 20 for readability
          output += `  ${agent.name}\n`;
          output += `    ID: ${agent.id}\n`;
          output += `    Description: ${agent.description.slice(0, 80)}${agent.description.length > 80 ? '...' : ''}\n`;
          if (agent.installation) {
            output += `    Path: ${agent.installation.installedPath}\n`;
          }
          output += '\n';
        }
        if (agents.length > 20) {
          output += `  ... and ${agents.length - 20} more\n`;
        }
      }
    }

    if (showSkills) {
      const skills = registry.getByType('skill');
      output += `\nSkills (${skills.length}):\n`;
      output += '─'.repeat(60) + '\n';

      if (skills.length === 0) {
        output += '  No skills deployed\n';
      } else {
        for (const skill of skills.slice(0, 20)) {
          output += `  ${skill.name}\n`;
          output += `    ID: ${skill.id}\n`;
          output += `    Description: ${skill.description.slice(0, 80)}${skill.description.length > 80 ? '...' : ''}\n`;
          if (skill.installation) {
            output += `    Path: ${skill.installation.installedPath}\n`;
          }
          output += '\n';
        }
        if (skills.length > 20) {
          output += `  ... and ${skills.length - 20} more\n`;
        }
      }
    }

    if (showCommands) {
      const commands = registry.getByType('command');
      output += `\nCommands (${commands.length}):\n`;
      output += '─'.repeat(60) + '\n';

      if (commands.length === 0) {
        output += '  No commands registered\n';
      } else {
        for (const command of commands.slice(0, 20)) {
          output += `  ${command.name}\n`;
          output += `    ID: ${command.id}\n`;
          output += `    Description: ${command.description.slice(0, 80)}${command.description.length > 80 ? '...' : ''}\n`;
          output += '\n';
        }
        if (commands.length > 20) {
          output += `  ... and ${commands.length - 20} more\n`;
        }
      }
    }

    // Project-local bundles (#1034) — surfaced as a separate section with
    // [project] source label
    const totalProjectLocal =
      projectLocal.counts.extension +
      projectLocal.counts.addon +
      projectLocal.counts.framework +
      projectLocal.counts.plugin;

    if (totalProjectLocal > 0 || projectLocal.errors.length > 0) {
      output += `\nProject-local bundles (${totalProjectLocal}):\n`;
      output += '─'.repeat(60) + '\n';
      for (const b of projectLocal.bundles) {
        output += `  ${b.id} [project] [${b.type}]\n`;
        output += `    Path: ${b.localPath}\n`;
        output += `    Description: ${b.manifest.description.slice(0, 80)}${b.manifest.description.length > 80 ? '...' : ''}\n\n`;
      }
      if (projectLocal.errors.length > 0) {
        output += `  ⚠ ${projectLocal.errors.length} validation error(s) — see "aiwg doctor" for details\n`;
      }
    }

    // Summary
    const totalAgents = registry.getByType('agent').length;
    const totalSkills = registry.getByType('skill').length;
    const totalCommands = registry.getByType('command').length;
    const total = totalAgents + totalSkills + totalCommands;

    output += '\n' + '═'.repeat(60) + '\n';
    output += `Total: ${total} extensions (${totalAgents} agents, ${totalSkills} skills, ${totalCommands} commands)`;
    if (totalProjectLocal > 0) {
      output += ` + ${totalProjectLocal} project-local`;
    }
    output += '\n';

    if (total === 0 && totalProjectLocal === 0) {
      output += '\nTip: Deploy a framework with "aiwg use sdlc" to get started\n';
    } else if (totalCommands === 0 && totalAgents > 0) {
      // Skill-only model (Claude Code default): commands aren't deployed as
      // slash commands; capabilities reach the agent via natural language or
      // `aiwg discover` (#1228). Surface this so 0 commands doesn't look like
      // a deploy failure.
      output += '\nNote: 0 commands is expected on Claude Code — capabilities are reached via natural language or `aiwg discover "<phrase>"`.\n';
    }

    if (deployedOnly) {
      const projectDir = getProjectDir(ctx, ctx.args);
      const plan = await readWorkspaceSignalPlan(projectDir);
      if (plan) {
        output += formatDeployedWorkspaceSignalPlan(plan);
      } else {
        output += '\nWorkspace skill filter: no recorded plan found.\n';
        output += 'Run `aiwg use --profile <name>` to record workspace-aware include/exclude reasons.\n';
      }
    }

    return {
      exitCode: 0,
      message: output,
    };
  },
};

/**
 * Format `aiwg list --project-local` output: only project-local bundles, with
 * per-type breakdown and any validation errors surfaced. (#1034)
 */
function formatProjectLocalOnly(
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
async function formatShadowsOnly(
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
function isScopeUser(args: ReadonlyArray<string>): boolean {
  const idx = args.findIndex((a) => a === '--scope');
  if (idx === -1) return false;
  return args[idx + 1] === 'user';
}

/**
 * #1156 Phase 1 — Format the per-user registry (~/.aiwg/installed.json) as a
 * human-readable inventory. Used by `aiwg list --scope user` / `aiwg list
 * --user`. Independent of any project — works from any cwd.
 */
async function formatUserScopeRegistry(): Promise<HandlerResult> {
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

/**
 * #1156 Phase 1 — Revert a user-scope mirror.
 *
 * Reads `~/.aiwg/installed.json`, looks up the framework + provider entry,
 * and deletes the specific artifact entries this deploy created (recorded
 * by the mirror in Cycle 3). With `--dry-run`, lists what would be removed
 * without touching the filesystem.
 *
 * Back-compat: registry entries written before Cycle 3 lack the `entries`
 * snapshot. For those, the handler falls back to the conservative
 * registry-only revert and tells the operator to clean up manually.
 *
 * Multi-provider: if `--provider` is omitted, all of the framework's
 * provider deployments are reverted in one pass.
 */
async function removeUserScopeDeploy(args: ReadonlyArray<string>): Promise<HandlerResult> {
  const positional = firstRemovePositional(args);
  if (!positional) {
    return {
      exitCode: 1,
      message: 'Error: framework name required\n\nUsage: aiwg remove <framework> --scope user [--provider <p>] [--dry-run]',
    };
  }

  const dryRun = args.includes('--dry-run');
  const providerParse = parseRemoveProvider(args);
  if (providerParse.error) {
    return {
      exitCode: 1,
      message: `${providerParse.error}\n\nUsage: aiwg remove <framework> --scope user [--provider <p>] [--dry-run]`,
    };
  }
  const provider = providerParse.provider;

  const { readUserRegistry, removeUserDeploy } = await import('../../config/user-registry.js');
  const { USER_SCOPE_PATHS } = await import('../scope-resolver.js');
  const registry = await readUserRegistry();
  const entry = registry.installed[positional];
  if (!entry) {
    return {
      exitCode: 1,
      message: `Error: framework '${positional}' is not deployed at user scope.\n\nRun 'aiwg list --scope user' to see installed frameworks.`,
    };
  }

  const providersToRevert = provider ? [provider] : Object.keys(entry.deployedTo);
  if (provider && !entry.deployedTo[provider]) {
    return {
      exitCode: 1,
      message: `Error: framework '${positional}' is not deployed at user scope for provider '${provider}'.\n\nDeployed providers: ${Object.keys(entry.deployedTo).join(', ') || '(none)'}`,
    };
  }

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const linesOut: string[] = [];
  if (dryRun) linesOut.push(`[dry-run] Plan for user-scope remove of '${positional}':`);
  else linesOut.push(`Removing user-scope mirror of '${positional}':`);

  let totalDeleted = 0;
  let conservativeFallbackUsed = false;

  for (const p of providersToRevert) {
    const userPaths = USER_SCOPE_PATHS[p];
    if (!userPaths) {
      linesOut.push(`  ⚠ ${p}: no user-scope paths registered — skipping (manual cleanup may be needed)`);
      continue;
    }

    // Cast through unknown to access the optional `entries` snapshot recorded
    // by the Cycle 3 mirror. Older registry entries won't have it.
    const providerEntry = entry.deployedTo[p] as unknown as {
      entries?: { agents?: string[]; commands?: string[]; skills?: string[]; rules?: string[]; behaviors?: string[] };
    };
    const recorded = providerEntry?.entries;

    if (!recorded) {
      // Pre-Cycle-3 entry: surface the deploy paths and let the operator
      // clean them up manually. We can't safely auto-delete because the dirs
      // are shared with other frameworks.
      conservativeFallbackUsed = true;
      const existingDirs = [
        { type: 'agents', path: userPaths.agents },
        { type: 'commands', path: userPaths.commands },
        { type: 'skills', path: userPaths.skills },
        { type: 'rules', path: userPaths.rules },
        { type: 'behaviors', path: userPaths.behaviors },
      ].filter(t => t.path);
      linesOut.push(`  ⚠ ${p}: registry entry has no per-artifact manifest (deployed before Cycle 3). Manual cleanup of these dirs may be needed:`);
      for (const t of existingDirs) {
        const stat = await fs.stat(t.path).catch(() => null);
        if (stat && stat.isDirectory()) {
          linesOut.push(`      - ${t.path}`);
        }
      }
      continue;
    }

    // Precise revert — walk the recorded entry names and delete each one
    // from its corresponding user-scope dir.
    const sets: Array<[string, string, string[] | undefined]> = [
      ['agents', userPaths.agents, recorded.agents],
      ['commands', userPaths.commands, recorded.commands],
      ['skills', userPaths.skills, recorded.skills],
      ['rules', userPaths.rules, recorded.rules],
      ['behaviors', userPaths.behaviors, recorded.behaviors],
    ];
    for (const [type, dir, names] of sets) {
      if (!dir || !names || names.length === 0) continue;
      let deletedHere = 0;
      for (const name of names) {
        const target = path.join(dir, name);
        if (dryRun) {
          linesOut.push(`  · ${p} ${type}: ${target}`);
          deletedHere++;
          continue;
        }
        try {
          await fs.rm(target, { recursive: true, force: true });
          deletedHere++;
          totalDeleted++;
        } catch (err) {
          linesOut.push(`  ⚠ ${p} ${type}: failed to remove ${target}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!dryRun && deletedHere > 0) {
        linesOut.push(`  ✓ ${p} ${type}: removed ${deletedHere} entry/entries from ${dir}`);
      } else if (dryRun) {
        linesOut.push(`    (${deletedHere} ${type} would be removed from ${dir})`);
      }
    }
  }

  if (!dryRun) {
    if (provider) {
      await removeUserDeploy({ framework: positional, provider });
    } else {
      await removeUserDeploy({ framework: positional });
    }
    linesOut.push('');
    if (conservativeFallbackUsed) {
      linesOut.push('Registry updated. Some providers had no per-artifact manifest (pre-Cycle-3 deploys); inspect the dirs listed above and clean up manually if needed.');
    } else {
      linesOut.push(`Registry updated. ${totalDeleted} artifact entry/entries removed.`);
    }
  }

  return {
    exitCode: 0,
    message: linesOut.join('\n') + '\n',
  };
}

/**
 * Remove framework handler
 *
 * Delegates to tools/plugin/plugin-uninstaller-cli.mjs
 */
export const removeHandler: CommandHandler = {
  id: "remove",
  name: "Remove Framework",
  description: "Remove installed framework, plugin, or project-local bundle",
  category: "framework",
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    // Explicit provider removal is separate from framework removal. The native
    // adapter validates receipt hashes and preserves operator modifications.
    const nativeRemovalProvider = parseRemoveProvider(ctx.args);
    if (firstRemovePositional(ctx.args) === 'omp' && nativeRemovalProvider.provider === 'omp') {
      const { uninstall } = await import('../../../tools/agents/providers/omp.mjs');
      const { getProjectDir } = await import('../../config/aiwg-config.js');
      const dryRun = ctx.args.includes('--dry-run');
      const scope = ctx.args.includes('--user') || isScopeUser(ctx.args) ? 'user' : 'project';
      const count = uninstall(getProjectDir({ cwd: ctx.cwd }, ctx.args), { dryRun, scope });
      return { exitCode: 0, message: `${dryRun ? 'Would remove' : 'Removed'} ${count} unchanged OMP-owned files; operator files preserved.` };
    }

    // #1156 Phase 1 — `--scope user` / `--user`: revert the user-scope mirror
    // for the given framework. Independent of any project; reads the per-user
    // registry at ~/.aiwg/installed.json to find what was deployed, deletes
    // the mirrored artifacts under the provider's USER_SCOPE_PATHS, and
    // updates the registry.
    if (ctx.args.includes('--user') || isScopeUser(ctx.args)) {
      return await removeUserScopeDeploy(ctx.args);
    }

    if (firstRemovePositional(ctx.args) === 'grok-build') {
      const providerParse = parseRemoveProvider(ctx.args);
      if (providerParse.provider !== 'grok-build' || providerParse.error) {
        return { exitCode: 1, message: 'Use aiwg remove grok-build --provider grok-build [--dry-run] for reviewed project-scope removal.' };
      }
      const frameworkRoot = await getFrameworkRoot();
      const { uninstall } = (await import(pathToFileURL(path.join(frameworkRoot, 'tools/agents/providers/grok-build.mjs')).href)) as typeof import('../../../tools/agents/providers/grok-build.mjs');
      const { readAiwgConfig, writeAiwgConfig } = await import('../../config/aiwg-config.js');
      const target = getProjectDir({ cwd: ctx.cwd }, ctx.args);
      const dryRun = ctx.args.includes('--dry-run');
      const report = uninstall(target, { dryRun, srcRoot: frameworkRoot });
      if (!dryRun && report.skipped.length === 0) {
        const config = await readAiwgConfig(target);
        if (config) {
          for (const [name, entry] of Object.entries(config.installed ?? {})) {
            delete entry.deployedTo?.['grok-build'];
            if (Object.keys(entry.deployedTo ?? {}).length === 0) delete config.installed[name];
          }
          await writeAiwgConfig(target, config);
        }
      }
      const lines = [
        `${dryRun ? 'Would remove' : 'Removed'} ${dryRun ? report.planned.length : report.removed.length} unchanged AIWG-owned Grok Build artifact(s).`,
        ...report.planned.map(relative => `  ${relative}`),
        ...report.skipped.map(relative => `  Preserved modified or unverifiable: ${relative}`),
        'Operator-owned Grok content and shared context files are preserved.',
      ];
      return { exitCode: report.skipped.length ? 1 : 0, message: lines.join('\n') };
    }

    // #1037 — Project-local-aware remove. If the first positional arg matches
    // a project-local entry in `installed`, route to the new handler.
    // Otherwise fall through to the existing plugin-uninstaller flow.
    const positionalArg = firstRemovePositional(ctx.args);
    const providerParse = parseRemoveProvider(ctx.args);
    if (providerParse.error) {
      return {
        exitCode: 1,
        message: `${providerParse.error}\n\nUsage: aiwg remove <id> [--force] [--dry-run] [--provider <p>] [--keep-registry]`,
      };
    }
    if (!positionalArg) {
      return {
        exitCode: 1,
        message: 'Error: framework or bundle id required\n\nUsage: aiwg remove <id> [--force] [--dry-run] [--provider <p>] [--keep-registry]',
      };
    }
    if (positionalArg) {
      try {
        const { readAiwgConfig, writeAiwgConfig, getProjectDir } = await import(
          '../../config/aiwg-config.js'
        );
        const { removeProjectLocalBundle } = await import(
          '../../extensions/project-local-remove.js'
        );
        const projectDir = getProjectDir({ cwd: ctx.cwd }, ctx.args);
        const config = await readAiwgConfig(projectDir);
        const entry = config?.installed?.[positionalArg];
        if (config && entry?.source === 'project-local') {
          const force = ctx.args.includes('--force');
          const dryRun = ctx.args.includes('--dry-run');
          const keepRegistry = ctx.args.includes('--keep-registry');
          const provider = providerParse.provider;

          const result = await removeProjectLocalBundle(
            config, projectDir, positionalArg, { force, dryRun, keepRegistry, provider },
          );

          // Print outcome summary
          const lines: string[] = [];
          if (dryRun) lines.push(`[dry-run] Plan for project-local '${positionalArg}':`);
          for (const o of result.outcomes) {
            const marker = o.reverted ? '✓' : '⚠';
            lines.push(`  ${marker} ${o.provider} :: ${o.artifactPath}  [${o.case}] ${o.message}`);
          }
          if (result.revertedProviders.length > 0) {
            lines.push(`Fully reverted: ${result.revertedProviders.join(', ')}`);
          }
          if (result.partialProviders.length > 0) {
            lines.push(`Partial (registry preserved): ${result.partialProviders.join(', ')}`);
          }
          if (lines.length > 0) console.log(lines.join('\n'));

          if (!dryRun) {
            await writeAiwgConfig(projectDir, config);
          }

          // Note: source under .aiwg/<type>/<name>/ is intentionally NOT
          // deleted (load-bearing invariant from #1048 design).
          return {
            exitCode: result.partialProviders.length > 0 ? 1 : 0,
            message: result.partialProviders.length > 0
              ? `Some artifacts skipped (see above). Use --force to override mutation refusal.`
              : '',
          };
        }
      } catch (err) {
        // Fall through to upstream remove on any error in the project-local path
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`project-local remove pre-check failed (falling through): ${msg}\n`);
      }
    }

    if (providerParse.provider) {
      return {
        exitCode: 1,
        message: `Error: --provider is only supported for project-local or user-scope remove. '${positionalArg}' is not a project-local bundle.\n\nUse 'aiwg remove ${positionalArg}' without --provider, or 'aiwg remove ${positionalArg} --scope user --provider ${providerParse.provider}' for a user-scope mirror. Refs #1610.`,
      };
    }

    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    return runner.run("tools/plugin/plugin-uninstaller-cli.mjs", ctx.args, {
      cwd: ctx.cwd,
    });
  },
};

/**
 * Promote handler — graduate a project-local bundle to upstream or to a
 * private corpus path. Implements the design at
 * @.aiwg/architecture/design-doctor-log-promote.md (#1049).
 *
 * Usage:
 *   aiwg promote <name>                          # default: --to upstream
 *   aiwg promote <name> --to upstream
 *   aiwg promote <name> --to corpus <path>
 *   aiwg promote <name> --dry-run
 *   aiwg promote <name> --cleanup
 *   aiwg promote <name> --force
 *
 * @implements #1037
 */
export const promoteHandler: CommandHandler = {
  id: 'promote',
  name: 'Promote',
  description: 'Graduate a project-local bundle to upstream or a corpus path',
  category: 'framework',
  aliases: ['-promote', '--promote', 'graduate'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const args = ctx.args;
    const positional = args.find(a => !a.startsWith('-'));
    if (!positional) {
      return { exitCode: 1, message: 'Error: bundle name required\n\nUsage: aiwg promote <name> [--to upstream|corpus <path>] [--dry-run] [--cleanup] [--force]' };
    }

    const toIdx = args.findIndex(a => a === '--to');
    const toValue = toIdx >= 0 ? args[toIdx + 1] : 'upstream';
    let corpusPath: string | undefined;
    if (toValue === 'corpus') {
      // The argument *after* "corpus" is the path
      corpusPath = args[toIdx + 2];
      if (!corpusPath || corpusPath.startsWith('-')) {
        return { exitCode: 1, message: 'Error: --to corpus requires a path argument' };
      }
    } else if (toValue !== 'upstream') {
      return { exitCode: 1, message: `Error: --to must be 'upstream' or 'corpus' (got '${toValue}')` };
    }

    const dryRun = args.includes('--dry-run');
    const cleanup = args.includes('--cleanup');
    const force = args.includes('--force');

    try {
      const { readAiwgConfig, writeAiwgConfig, getProjectDir } = await import('../../config/aiwg-config.js');
      const { promoteProjectLocalBundle } = await import('../../extensions/project-local-promote.js');

      const projectDir = getProjectDir({ cwd: ctx.cwd }, args);
      const config = await readAiwgConfig(projectDir);
      if (!config) {
        return { exitCode: 1, message: 'Error: no .aiwg/aiwg.config found — run `aiwg init` first' };
      }

      const fr = await getFrameworkRoot();
      const result = await promoteProjectLocalBundle(config, projectDir, positional, {
        to: toValue as 'upstream' | 'corpus',
        corpusPath,
        dryRun,
        cleanup,
        force,
        frameworkRoot: fr,
      });

      if (!result.ok) {
        return { exitCode: 1, message: `Error: ${result.message ?? result.failureReason}` };
      }

      if (dryRun && result.plan) {
        console.log('[dry-run] Would copy:');
        console.log(`  ${result.plan.source} → ${result.plan.destination}`);
        console.log(`  Files: ${result.plan.files.length}, ${result.plan.totalBytes} bytes`);
        console.log('  Pre-flight: ✓ manifest valid  ✓ destination clean');
        console.log('  Hash verification: skipped (dry-run)');
        console.log(`  Registry update: source: project-local → ${toValue === 'upstream' ? 'bundled' : 'corpus'}`);
        console.log(`  Cleanup: ${cleanup ? 'will remove .aiwg source after copy' : 'skipped (--cleanup not set)'}`);
        return { exitCode: 0 };
      }

      await writeAiwgConfig(projectDir, config);
      console.log(`✓ Promoted '${positional}' → ${result.plan?.destination}`);
      if (cleanup) {
        console.log('  Source removed from .aiwg/');
        try {
          const { deployProjectQuickref, generateProjectQuickref, hasProjectQuickref } = await import('../../extensions/project-quickref.js');
          if (await hasProjectQuickref(projectDir)) {
            if (config.providers.length > 0) {
              for (const provider of config.providers) await deployProjectQuickref(projectDir, provider);
              console.log(`  Managed project quickref refreshed for: ${config.providers.join(', ')}.`);
            } else {
              await generateProjectQuickref(projectDir);
              console.log('  Managed project quickref generated; no providers are configured for deployment.');
            }
          } else {
            console.log('  Managed project quickref is now empty; run `aiwg doctor --project-local` to inspect deployed stale copies.');
          }
        } catch (error) {
          console.log(`  Managed project quickref refresh failed: ${(error as Error).message}`);
        }
      }
      return { exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { exitCode: 1, message: `promote failed: ${msg}` };
    }
  },
};

/**
 * New bundle handler — scaffolds a project-local bundle under the configured
 * AIWG artifact root with a valid manifest, starter artifact, and a
 * README that includes the identical-form portability reminder.
 *
 * Usage:
 *   aiwg new-bundle <name>                      # default: --type extension --starter skill
 *   aiwg new-bundle <name> --type addon
 *   aiwg new-bundle <name> --type framework --starter minimal
 *   aiwg new-bundle <name> --starter rule --description "Custom rule"
 *
 * @implements #1050
 */
export const newBundleHandler: CommandHandler = {
  id: 'new-bundle',
  name: 'New Bundle',
  description: 'Scaffold a project-local bundle under the configured AIWG artifact root',
  category: 'scaffolding',
  aliases: ['new-extension', 'new-addon', 'new-framework', 'new-plugin', 'new-provider'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const args = ctx.args;
    const positional = args.find(a => !a.startsWith('-'));
    if (!positional) {
      return {
        exitCode: 1,
        message: 'Error: bundle name required\n\nUsage: aiwg new-bundle <name> [--type extension|addon|framework|plugin|provider] [--starter skill|rule|agent|minimal] [--description "..."]',
      };
    }

    // Type can be inferred from the alias used to invoke (new-extension etc.)
    const aliasMap: Record<string, 'extension' | 'addon' | 'framework' | 'plugin' | 'provider'> = {
      'new-extension': 'extension',
      'new-addon': 'addon',
      'new-framework': 'framework',
      'new-plugin': 'plugin',
      'new-provider': 'provider',
    };
    const invoked = ctx.rawArgs[0] ?? '';
    const aliasType = aliasMap[invoked];

    const typeIdx = args.findIndex(a => a === '--type');
    const typeFlag = typeIdx >= 0 ? args[typeIdx + 1] : undefined;
    const type = (typeFlag ?? aliasType ?? 'extension') as 'extension' | 'addon' | 'framework' | 'plugin' | 'provider';
    if (!['extension', 'addon', 'framework', 'plugin', 'provider'].includes(type)) {
      return { exitCode: 1, message: `Error: --type must be one of extension|addon|framework|plugin|provider (got '${type}')` };
    }

    const starterIdx = args.findIndex(a => a === '--starter');
    const starter = starterIdx >= 0 ? (args[starterIdx + 1] as 'skill' | 'rule' | 'agent' | 'minimal') : undefined;
    if (starter && !['skill', 'rule', 'agent', 'minimal'].includes(starter)) {
      return { exitCode: 1, message: `Error: --starter must be one of skill|rule|agent|minimal (got '${starter}')` };
    }

    const descIdx = args.findIndex(a => a === '--description');
    const description = descIdx >= 0 ? args[descIdx + 1] : undefined;

    const dryRun = args.includes('--dry-run');

    const { scaffoldProjectLocalBundle } = await import('../../extensions/project-local-scaffold.js');

    try {
      const result = await scaffoldProjectLocalBundle({
        type,
        name: positional,
        description,
        starter,
        projectDir: ctx.cwd,
        dryRun,
      });

      if (result.alreadyExists) {
        return {
          exitCode: 1,
          message: `Refused: bundle already exists at ${result.bundlePath}. Remove it first or pick a different name.`,
        };
      }

      if (dryRun) {
        console.log(`[DRY RUN] Would scaffold project-local ${type} '${positional}' at ${result.bundlePath}`);
        console.log('  Files that would be created:');
        for (const f of result.filesCreated) console.log(`    + ${f}`);
        console.log('');
        console.log('No files written. Re-run without --dry-run to create.');
        return { exitCode: 0 };
      }

      console.log(`✓ Scaffolded project-local ${type} '${positional}' at ${result.bundlePath}`);
      console.log('  Files created:');
      for (const f of result.filesCreated) console.log(`    + ${f}`);

      // #1085 — when the project blanket-ignores .aiwg/, the new bundle's
      // source would be silently dropped from version control. Detect and
      // self-heal idempotently.
      try {
        const { appendAiwgSourceTrackBlock } = await import(
          '../../extensions/project-local-gitignore.js'
        );
        const ig = await appendAiwgSourceTrackBlock(ctx.cwd);
        if (ig.added) {
          console.log('');
          console.log(`  → ${ig.reason}`);
          console.log('    .aiwg/{addons,extensions,frameworks,plugins,providers}/ now tracked by git.');
          console.log('    Generated state under .aiwg/ (working/, ralph/, research/, ...) stays ignored.');
        }
      } catch {
        // .gitignore management is best-effort; don't fail the scaffold
      }

      try {
        const { generateProjectQuickref } = await import('../../extensions/project-quickref.js');
        await generateProjectQuickref(ctx.cwd);
        console.log('  → Managed project quickref refreshed from discovered capabilities.');
      } catch (error) {
        console.log(`  → Managed project quickref refresh deferred: ${(error as Error).message}`);
      }

      // #1235 / #1758 — auto-rebuild the project graph and refresh the
      // Fortemi Core static cache so the new bundle is immediately
      // discoverable via top-level `aiwg discover` / `aiwg show`.
      // Best-effort: don't fail the scaffold if indexing hiccups.
      let indexedOk = false;
      let fortemiSyncedOk = false;
      try {
        const { buildIndex } = await import('../../artifacts/index-builder.js');
        await buildIndex(ctx.cwd, { graph: 'project', force: false, explicit: true });
        indexedOk = true;
        const { syncFortemiCoreIndex } = await import('../../artifacts/fortemi-core-sync.js');
        syncFortemiCoreIndex(ctx.cwd, { graph: 'project' });
        fortemiSyncedOk = true;
      } catch {
        // ignore — surface via next-steps hint instead
      }

      console.log('');
      console.log('Next steps:');
      console.log(`  1. Edit manifest.json (description, version, keywords)`);
      console.log(`  2. Customize the starter artifact under ${result.bundlePath}/`);
      if (indexedOk && fortemiSyncedOk) {
        console.log(`  3. Discoverable now via:  aiwg discover "${positional}"`);
      } else if (indexedOk) {
        console.log(`  3. Sync project search cache: aiwg index sync --graph project`);
        console.log(`     then:                       aiwg discover "${positional}"`);
      } else {
        console.log(`  3. Rebuild project index:  aiwg index build --graph project`);
        console.log(`     then sync search cache: aiwg index sync --graph project`);
        console.log(`     then:                   aiwg discover "${positional}"`);
      }
      console.log(`  4. Deploy:  aiwg use ${positional}`);
      console.log(`  5. Inspect: aiwg doctor --project-local`);
      console.log(`  6. When mature, promote:  aiwg promote ${positional}`);

      return { exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { exitCode: 1, message: `Error: ${msg}` };
    }
  },
};

/**
 * New project handler
 *
 * Delegates to tools/install/new-project.mjs
 */
export const newProjectHandler: CommandHandler = {
  id: "new",
  name: "New Project",
  description: "Scaffold a new project with AIWG",
  category: "project",
  aliases: ["-new", "--new"],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    const result = await runner.run("tools/install/new-project.mjs", ctx.args, {
      cwd: ctx.cwd,
    });
    if (result.exitCode === 0) {
      // The real scaffolder always runs in an existing target directory. Keep
      // mocked/script-runner-only calls side-effect free when their synthetic
      // cwd does not exist.
      const { access } = await import('node:fs/promises');
      const { constants } = await import('node:fs');
      try {
        await access(ctx.cwd, constants.W_OK);
        const { ensureWorkspaceContext } = await import('../../smiths/context-pipeline/workspace-context.js');
        await ensureWorkspaceContext(ctx.cwd);
      } catch (error) {
        if (!['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      const { formatStarNudge } = await import("../../community/links.js");
      const { markNudgeShown, shouldShowNudge } = await import("../../community/nudge-policy.js");
      if (shouldShowNudge('intake')) {
        const nudge = formatStarNudge();
        if (nudge) {
          console.log('');
          console.log(nudge);
          markNudgeShown('intake');
        }
      }
    }
    return result;
  },
};

/**
 * Install plugin handler
 *
 * Delegates to tools/plugin/plugin-installer-cli.mjs
 */
export const installPluginHandler: CommandHandler = {
  id: "install-plugin",
  name: "Install Plugin",
  description: "Install a plugin from the registry",
  category: "plugin",
  aliases: ["-install-plugin", "--install-plugin"],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    return runner.run("tools/plugin/plugin-installer-cli.mjs", ctx.args, {
      cwd: ctx.cwd,
      env: { AIWG_ROOT: frameworkRoot },
    });
  },
};

/**
 * Uninstall plugin handler
 *
 * Delegates to tools/plugin/plugin-uninstaller-cli.mjs
 */
export const uninstallPluginHandler: CommandHandler = {
  id: "uninstall-plugin",
  name: "Uninstall Plugin",
  description: "Uninstall a plugin",
  category: "plugin",
  aliases: ["-uninstall-plugin", "--uninstall-plugin"],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    return runner.run("tools/plugin/plugin-uninstaller-cli.mjs", ctx.args, {
      cwd: ctx.cwd,
    });
  },
};

/**
 * Plugin status handler
 *
 * Delegates to tools/plugin/plugin-status-cli.mjs
 */
export const pluginStatusHandler: CommandHandler = {
  id: "plugin-status",
  name: "Plugin Status",
  description: "Show plugin status and installation details",
  category: "plugin",
  aliases: ["-plugin-status", "--plugin-status"],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    return runner.run("tools/plugin/plugin-status-cli.mjs", ctx.args, {
      cwd: ctx.cwd,
    });
  },
};

/**
 * Package plugin handler
 *
 * Delegates to tools/plugin/package-plugins.mjs
 */
function packagePluginHelp(): HandlerResult {
  return {
    exitCode: 0,
    message: [
      "aiwg package-plugin — package a project-local or built-in marketplace wrapper",
      "",
      "Usage:",
      "  aiwg package-plugin <name> [--source <path>] [--output <path>] [--provider <name>] [--clean] [--dry-run]",
      "  aiwg package-plugin --plugin <name> [options]  # compatibility form",
      "",
      "Options:",
      "  --source <path>    explicit project-local wrapper source (must stay inside the project)",
      "  --output <path>    standalone archive output (default: dist/plugins)",
      "  --provider <name>  claude, codex, or all for standalone wrappers; built-ins retain all formats",
      "  --clean            clean generated plugin output before packaging",
      "  --dry-run, -n      preview without writing",
      "  --help, -h         show this help",
      "",
      "Project-local wrappers are discovered under .aiwg/plugins and packaged as deterministic archives.",
    ].join("\n"),
  };
}

export const packagePluginHandler: CommandHandler = {
  id: "package-plugin",
  name: "Package Plugin",
  description: "Package a plugin for distribution",
  category: "plugin",
  aliases: ["-package-plugin", "--package-plugin"],

  async help(): Promise<HandlerResult> {
    return packagePluginHelp();
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    if (ctx.args.includes("--help") || ctx.args.includes("-h")) {
      return packagePluginHelp();
    }

    const hasExplicitPlugin = ctx.args.includes("--plugin") || ctx.args.includes("-p");
    const positional = ctx.args[0] && !ctx.args[0].startsWith("-")
      ? ctx.args[0]
      : undefined;
    if (!hasExplicitPlugin && !positional) {
      return {
        exitCode: 1,
        message: "Error: plugin name is required.\n\nRun `aiwg package-plugin --help` for usage.",
      };
    }
    const positionalSource = positional && (positional.includes('/') || positional.includes('\\'))
      ? positional
      : undefined;
    const normalizedArgs = hasExplicitPlugin
      ? ctx.args
      : positionalSource
        ? [
          "--plugin", path.basename(path.resolve(ctx.cwd, positionalSource)),
          "--source", positionalSource,
          ...ctx.args.slice(1),
        ]
        : ["--plugin", positional as string, ...ctx.args.slice(1)];

    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    return runner.run("tools/plugin/package-plugins.mjs", normalizedArgs, {
      cwd: ctx.cwd,
    });
  },
};

/**
 * Package all plugins handler
 *
 * Delegates to tools/plugin/package-plugins.mjs with --all flag
 */
export const packageAllPluginsHandler: CommandHandler = {
  id: "package-all-plugins",
  name: "Package All Plugins",
  description: "Package all plugins for distribution",
  category: "plugin",
  aliases: ["-package-all-plugins", "--package-all-plugins"],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    if (ctx.args.includes("--help") || ctx.args.includes("-h")) {
      return {
        exitCode: 0,
        message: [
          "aiwg package-all-plugins — package every built-in marketplace wrapper",
          "",
          "Usage:",
          "  aiwg package-all-plugins [--provider <name>] [--clean] [--dry-run]",
          "",
          "Options:",
          "  --provider <name>  claude, codex, cursor, factory, openclaw, or all",
          "  --clean            clean generated plugin output before packaging",
          "  --dry-run, -n      preview without writing",
          "  --help, -h         show this help",
        ].join("\n"),
      };
    }

    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    return runner.run("tools/plugin/package-plugins.mjs", ["--all", ...ctx.args], {
      cwd: ctx.cwd,
    });
  },
};

/**
 * Artifact index command handler
 *
 * Dynamically imports and delegates to src/artifacts/cli.mjs.
 * Handles subcommands: build, query, deps, stats
 *
 * @implements #420
 */
export const indexHandler: CommandHandler = {
  id: "index",
  name: "Artifact Index",
  description: "Artifact index commands (build, query, deps, stats)",
  category: "index",
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import("../../artifacts/cli.js");
      await main(ctx.args);

      return {
        exitCode: 0,
      };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `Index command failed: ${result.message}` };
    }
  },
};

/**
 * `aiwg corpus` — research-corpus tools (radar/freshness subsystem, #1498).
 * Delegates to the corpus-tools router, mirroring indexHandler.
 */
export const corpusHandler: CommandHandler = {
  id: "corpus",
  name: "Research Corpus Tools",
  description: "Research-corpus tools (radar-init, radar-status, radar-report)",
  category: "index",
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { corpusMain } = await import("../../artifacts/corpus-tools/cli.js");
      await corpusMain(ctx.args, ctx.cwd);
      return { exitCode: 0 };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `Corpus command failed: ${result.message}` };
    }
  },
};

/**
 * Discovery command handler — first-class top-level verb (#1212).
 *
 * Forwards to the same implementation as `aiwg index discover` but
 * exposes discovery as its own command so agents don't conflate it
 * with the project's general-purpose artifact graph indices.
 *
 *   aiwg discover "<phrase>" [--limit N] [--type skill,agent,...] [--json]
 *     [--resource-source local|web|auto] [--aiwg-version <version|range|digest|channel>] [--offline]
 */
export const discoverHandler: CommandHandler = {
  id: "discover",
  name: "Discover",
  description:
    "Find AIWG operational assets by capability — index-driven on-demand discovery",
  category: "index",
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      // Delegate to the same handler `aiwg index discover` uses, by
      // prepending the `discover` subcommand and reusing the artifacts
      // CLI router. This keeps a single implementation path.
      const { main } = await import("../../artifacts/cli.js");
      await main(["discover", ...ctx.args]);
      return { exitCode: 0 };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `Discover command failed: ${result.message}` };
    }
  },
};

/**
 * Features command handler — manage AIWG's optional runtime features (#1219).
 *
 * Subcommands: status / info / install / remove. Native feature installs use
 * a user-owned package root with explicit package-level script approval.
 */
export const featuresHandler: CommandHandler = {
  id: "features",
  name: "Features",
  description:
    "List, inspect, and install AIWG's optional runtime features",
  category: "maintenance",
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import("../../features/cli.js");
      await main(ctx.args);
      return { exitCode: 0 };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `Features command failed: ${result.message}` };
    }
  },
};

/**
 * Show command handler — fetch the full text of a specific artifact (#1218).
 *
 * Forwards to the same implementation as `aiwg index show`. Companion to
 * `aiwg discover`: where discover ranks candidates, show fetches the body
 * so consumers don't need to navigate AIWG's storage paths themselves.
 *
 *   aiwg show <name> [--type skill,agent,...] [--json] [--first]
 *     [--resource-source local|web|auto] [--aiwg-version <version|range|digest|channel>] [--offline]
 */
export const showHandler: CommandHandler = {
  id: "show",
  name: "Show",
  description:
    "Print the full text of a specific AIWG skill, agent, command, or rule by name",
  category: "index",
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import("../../artifacts/cli.js");
      await main(["show", ...ctx.args]);
      return { exitCode: 0 };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `Show command failed: ${result.message}` };
    }
  },
};

/**
 * Skills command handler
 *
 * Dynamically imports and delegates to src/skills/cli.ts.
 * Handles subcommands: search, info, list, install, publish
 *
 * @implements #539
 */
export const skillsHandler: CommandHandler = {
  id: "skills",
  name: "Skills Registry",
  description: "Skill commands (search, info, list, install, publish)",
  category: "catalog",
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import("../../skills/cli.js");
      await main(ctx.args);

      return {
        exitCode: 0,
      };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `Skills command failed: ${result.message}` };
    }
  },
};

/**
 * Config command handler
 *
 * Dynamically imports and delegates to src/config/cli.ts.
 * Handles subcommands: get, set, list, validate, reset, path, edit
 *
 * @implements #545
 */
export const configHandler: CommandHandler = {
  id: "config",
  name: "Config",
  description: "User config commands (get, set, list, validate, reset, path, edit)",
  category: "config",
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import("../../config/cli.js");
      await main(ctx.args);

      return {
        exitCode: 0,
      };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `Config command failed: ${result.message}` };
    }
  },
};

/**
 * Ops command handler
 *
 * Dynamically imports and delegates to src/ops/cli.ts.
 * Handles subcommands: init, status, use, list, push
 *
 * @implements #544
 */
export const opsHandler: CommandHandler = {
  id: "ops",
  name: "Ops",
  description: "Ops ecosystem commands (init, status, use, list, push)",
  category: "ops",
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import("../../ops/cli.js");
      await main(ctx.args);

      return {
        exitCode: 0,
      };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `Ops command failed: ${result.message}` };
    }
  },
};

/**
 * Activity-log command handler
 *
 * Dynamically imports and delegates to src/activity-log/cli.ts.
 * Handles subcommands: show, append, stats. Persistence routes through
 * resolveStorage('activity_log') so the log honors any storage.config
 * override (#934).
 *
 * @implements #934
 * @implements #964
 */
export const activityLogHandler: CommandHandler = {
  id: 'activity-log',
  name: 'Activity Log',
  description: 'Query and manage .aiwg/activity.log (show, append, stats)',
  category: 'utility',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import('../../activity-log/cli.js');
      await main(ctx.args);
      return { exitCode: 0 };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `activity-log command failed: ${result.message}` };
    }
  },
};

/**
 * Provenance command handler — routes \`aiwg provenance\` through
 * resolveStorage('provenance') for provenance-* skills (#968).
 *
 * @implements #934
 * @implements #968
 */
export const provenanceHandler: CommandHandler = {
  id: 'provenance',
  name: 'Provenance',
  description: 'Provenance subsystem storage operations (path, list, get, put, delete, append-log)',
  category: 'utility',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import('../../provenance/cli.js');
      await main(ctx.args);
      return { exitCode: 0 };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `provenance command failed: ${result.message}` };
    }
  },
};

/**
 * Research storage command handler — routes \`aiwg research-store\`
 * through resolveStorage('research') for research-acquire / corpus-*
 * skills (#968). Disambiguated from existing research-* workflow
 * commands by the \`-store\` suffix.
 *
 * @implements #934
 * @implements #968
 */
export const researchStoreHandler: CommandHandler = {
  id: 'research-store',
  name: 'Research Store',
  description: 'Research subsystem storage operations (path, list, get, put, delete, append-log)',
  category: 'utility',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import('../../research/storage-cli.js');
      await main(ctx.args);
      return { exitCode: 0 };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `research-store command failed: ${result.message}` };
    }
  },
};

/** Executable source-selection companion to the research-query skill. */
export const researchQueryHandler: CommandHandler = {
  id: 'research-query',
  name: 'Research Query',
  description: 'Select research sources for a question with local or Fortemi Core retrieval',
  category: 'index',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import('../../research/query-cli.js');
      await main(ctx.args, ctx.cwd);
      return { exitCode: 0 };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `research-query command failed: ${result.message}` };
    }
  },
};

/**
 * Reflections command handler
 *
 * Routes \`aiwg reflections <subcommand>\` through resolveStorage('reflections')
 * for ralph-reflect / reflection-injection skills (#967).
 *
 * @implements #934
 * @implements #967
 */
export const reflectionsHandler: CommandHandler = {
  id: 'reflections',
  name: 'Reflections',
  description: 'Reflections subsystem storage operations (path, list, get, put, delete, append-log)',
  category: 'utility',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import('../../reflections/cli.js');
      await main(ctx.args);
      return { exitCode: 0 };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `reflections command failed: ${result.message}` };
    }
  },
};

/**
 * Memory command handler
 *
 * Routes \`aiwg memory <subcommand>\` through resolveStorage('memory') so
 * the four memory skills (memory-ingest, memory-lint, memory-log-append,
 * memory-query-capture) honor any storage.config redirection.
 *
 * @implements #934
 * @implements #966
 */
export const memoryHandler: CommandHandler = {
  id: 'memory',
  name: 'Memory',
  description: 'Memory subsystem storage operations (path, list, get, put, delete, append-log)',
  category: 'utility',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import('../../memory/cli.js');
      await main(ctx.args);
      return { exitCode: 0 };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `memory command failed: ${result.message}` };
    }
  },
};

/**
 * Knowledge-base command handler
 *
 * Routes \`aiwg kb <subcommand>\` through resolveStorage('kb') so the KB
 * honors any storage.config redirection without each kb skill
 * hardcoding `.aiwg/kb/`.
 *
 * @implements #934
 * @implements #965
 */
export const kbHandler: CommandHandler = {
  id: 'kb',
  name: 'Knowledge Base',
  description: 'Knowledge base storage operations (path, list, get, put, delete)',
  category: 'utility',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import('../../kb/cli.js');
      await main(ctx.args);
      return { exitCode: 0 };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `kb command failed: ${result.message}` };
    }
  },
};

/**
 * Storage command handler
 *
 * Dynamically imports and delegates to src/storage/cli.ts.
 * Handles subcommands: show, list-backends, test
 *
 * @implements #934
 * @implements #954
 */
export const storageHandler: CommandHandler = {
  id: 'storage',
  name: 'Storage',
  description: 'Storage adapter commands (show, list-backends, test)',
  category: 'utility',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import('../../storage/cli.js');
      await main(ctx.args);
      return { exitCode: 0 };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `Storage command failed: ${result.message}` };
    }
  },
};

/**
 * RLM agentic tools handler
 *
 * Routes `aiwg chunk`, `aiwg fanout`, `aiwg rlm-prep`, `aiwg rlm-search`,
 * and `aiwg rlm-status` to src/rlm/cli.ts.
 *
 * These are support tools for agentic sessions — callable by users but
 * primarily used by RLM agents during recursive and fanout operations.
 *
 * @implements #559
 */
export const rlmToolsHandler: CommandHandler = {
  id: 'rlm-tools',
  name: 'RLM Tools',
  description: 'Agentic support tools for RLM operations (chunk, fanout, rlm-prep, rlm-search, rlm-status)',
  category: 'agentic-tools',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import('../../rlm/cli.js');
      await main(ctx.args);

      return {
        exitCode: 0,
      };
    } catch (error) {
      const result = handlerResultFromError(error);
      return { ...result, message: `RLM tools command failed: ${result.message}` };
    }
  },
};

// Individual handlers that delegate to rlmToolsHandler with their command prepended

export const chunkHandler: CommandHandler = {
  id: 'chunk',
  name: 'Chunk',
  description: 'Split a file into overlapping chunks for parallel fanout processing',
  category: 'agentic-tools',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    return rlmToolsHandler.execute({ ...ctx, args: ['chunk', ...ctx.args] });
  },
};

export const fanoutHandler: CommandHandler = {
  id: 'fanout',
  name: 'Fanout',
  description: 'Dispatch parallel subagent queries across a chunk manifest',
  category: 'agentic-tools',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    return rlmToolsHandler.execute({ ...ctx, args: ['fanout', ...ctx.args] });
  },
};

export const rlmPrepHandler: CommandHandler = {
  id: 'rlm-prep',
  name: 'RLM Prep',
  description: 'Prepare source content for RLM processing (chunk + index + manifest)',
  category: 'agentic-tools',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    return rlmToolsHandler.execute({ ...ctx, args: ['rlm-prep', ...ctx.args] });
  },
};

export const rlmSearchHandler: CommandHandler = {
  id: 'rlm-search',
  name: 'RLM Search',
  description: 'Full recursive search pipeline: decompose source, fanout query, synthesize results',
  category: 'agentic-tools',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    return rlmToolsHandler.execute({ ...ctx, args: ['rlm-search', ...ctx.args] });
  },
};

export const rlmStatusCliHandler: CommandHandler = {
  id: 'rlm-status',
  name: 'RLM Status',
  description: 'Show active RLM task tree, progress, and cost breakdown',
  category: 'agentic-tools',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    return rlmToolsHandler.execute({ ...ctx, args: ['rlm-status', ...ctx.args] });
  },
};

/** RLM result cache (#1203). */
export const rlmCacheHandler: CommandHandler = {
  id: 'rlm-cache',
  name: 'RLM Cache',
  description: 'Manage cached RLM results (list, stats, evict, clear) — keyed by index content-hash',
  category: 'agentic-tools',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    return rlmToolsHandler.execute({ ...ctx, args: ['rlm-cache', ...ctx.args] });
  },
};

/**
 * All subcommand handlers
 */
export const subcommandHandlers: CommandHandler[] = [
  mcpHandler,
  catalogHandler,
  listHandler,
  removeHandler,
  newProjectHandler,
  installPluginHandler,
  uninstallPluginHandler,
  pluginStatusHandler,
  packagePluginHandler,
  packageAllPluginsHandler,
  indexHandler,
  discoverHandler,
  showHandler,
  featuresHandler,
  skillsHandler,
  configHandler,
  opsHandler,
  storageHandler,
  activityLogHandler,
  kbHandler,
  memoryHandler,
  reflectionsHandler,
  provenanceHandler,
  researchStoreHandler,
  researchQueryHandler,
  chunkHandler,
  fanoutHandler,
  rlmPrepHandler,
  rlmSearchHandler,
  rlmStatusCliHandler,
  rlmCacheHandler,
  sessionHandler,
  feedbackHandler,
];
