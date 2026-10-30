// Focused subcommand handlers preserving the public facade.
import type { CommandHandler, HandlerContext, HandlerResult } from "./types.js";
import { handlerResultFromError } from "../errors.js";
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
