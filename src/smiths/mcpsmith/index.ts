/**
 * MCPsmith - MCP Server Generator
 *
 * Generates MCP (Model Context Protocol) servers from:
 * - CLI tools (--help parsing)
 * - REST APIs (OpenAPI specs)
 * - Tool catalogs (YAML/JSON)
 * - Natural language descriptions
 *
 * @module smiths/mcpsmith
 * @architecture @docs/smithing/mcpsmith.md
 * @implements @docs/smithing/mcpsmith.md
 */

export * from './types.js';
export * from './analyzers/cli-analyzer.js';
export * from './generator.js';
