// Focused subcommand handlers preserving the public facade.
import type { CommandHandler, HandlerContext, HandlerResult } from "./types.js";
import { handlerResultFromError } from "../errors.js";
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

  async help(): Promise<HandlerResult> {
    const { main } = await import("../../mcp/cli.mjs");
    await main(["--help"]);
    return { exitCode: 0 };
  },

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

