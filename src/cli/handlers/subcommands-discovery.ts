// Focused subcommand handlers preserving the public facade.
import type { CommandHandler, HandlerContext, HandlerResult } from "./types.js";
import { handlerResultFromError } from "../errors.js";
export const indexHandler: CommandHandler = {
  id: "index",
  name: "Artifact Index",
  description: "Artifact index commands (build, query, deps, stats)",
  category: "index",
  aliases: [],

  async help(): Promise<HandlerResult> {
    const { printIndexUsage } = await import("../../artifacts/cli.js");
    printIndexUsage();
    return { exitCode: 0 };
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import("../../artifacts/cli.js");
      await main(ctx.args);

      return {
        exitCode: Number(process.exitCode ?? 0),
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

  async help(): Promise<HandlerResult> {
    const { corpusMain } = await import("../../artifacts/corpus-tools/cli.js");
    await corpusMain(["--help"]);
    return { exitCode: 0 };
  },

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
    "Show an AIWG metadata card; --section or --body fetches content",
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

