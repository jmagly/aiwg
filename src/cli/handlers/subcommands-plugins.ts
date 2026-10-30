import * as path from "node:path";
// Focused subcommand handlers preserving the public facade.
import type { CommandHandler, HandlerContext, HandlerResult } from "./types.js";
import { createScriptRunner } from "./script-runner.js";
import { getFrameworkRoot } from "../../channel/manager.mjs";
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

