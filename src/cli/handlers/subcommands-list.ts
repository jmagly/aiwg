// Focused subcommand handlers preserving the public facade.
import type { CommandHandler, HandlerContext, HandlerResult } from "./types.js";
import { createScriptRunner } from "./script-runner.js";
import { getFrameworkRoot } from "../../channel/manager.mjs";
import * as path from "node:path";
import * as fsSync from "node:fs";
import { getRegistry } from "../../extensions/registry.js";
import { registerDeployedExtensions } from "../../extensions/deployment-registration.js";
import { discoverProjectLocalBundles } from "../../extensions/project-local-discovery.js";
import { getProjectDir } from "../../config/aiwg-config.js";
import { formatDeployedWorkspaceSignalPlan, readWorkspaceSignalPlan } from "../workspace-signals.js";
import { isScopeUser, formatUserScopeRegistry, formatProjectLocalOnly, formatShadowsOnly } from "./subcommands-list-format.js";
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
