// Focused subcommand handlers preserving the public facade.
import type { CommandHandler, HandlerContext, HandlerResult } from "./types.js";
import { handlerResultFromError } from "../errors.js";
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
  description: 'Memory storage, project registry, read-only audit/cost/recommendations, and reviewed lifecycle operations',
  category: 'utility',
  aliases: [],

  async help(ctx: HandlerContext): Promise<HandlerResult> {
    if (ctx.args[0] === 'cost') {
      const { MEMORY_COST_USAGE } = await import('../../memory/cli.js');
      return { exitCode: 0, message: MEMORY_COST_USAGE, rawOutput: true };
    }
    if (ctx.args[0] === 'recommend') {
      const { MEMORY_RECOMMEND_USAGE } = await import('../../memory/recommend-cli.js');
      return { exitCode: 0, message: MEMORY_RECOMMEND_USAGE, rawOutput: true };
    }
    if (['plan', 'apply', 'verify', 'restore'].includes(ctx.args[0])) {
      const { MEMORY_MAINTENANCE_USAGE } = await import('../../memory/maintenance-cli.js');
      return { exitCode: 0, message: MEMORY_MAINTENANCE_USAGE, rawOutput: true };
    }
    const { MEMORY_AUDIT_USAGE } = await import('../../memory/cli.js');
    return { exitCode: 0, message: MEMORY_AUDIT_USAGE, rawOutput: true };
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    try {
      const { main } = await import('../../memory/cli.js');
      return { exitCode: (await main(ctx.args)) ?? 0 };
    } catch (error) {
      const result = handlerResultFromError(error);
      if (['audit', 'cost', 'recommend', 'plan', 'apply', 'verify', 'restore'].includes(ctx.args[0])) {
        const { isAiwgError } = await import('../errors.js');
        const exitCode = isAiwgError(error) ? error.exitCode : 3;
        const receipt = error && typeof error === 'object' && 'receipt' in error ? error.receipt : undefined;
        if (ctx.args.includes('--json')) {
          console.log(JSON.stringify({ error: result.message, exitCode,
            ...(receipt !== undefined ? { receipt } : {}) }, null, 2));
          return { exitCode };
        }
        return { ...result, exitCode, message: `memory command failed: ${result.message}${receipt !== undefined ? `\n${JSON.stringify({ receipt }, null, 2)}` : ''}` };
      }
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
