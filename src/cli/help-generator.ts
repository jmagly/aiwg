/**
 * Help Generator
 *
 * Dynamically generates CLI help text from the extension registry.
 * Shares provider help between the launcher and command handler.
 *
 * @implements @docs/architecture/cli/adr-001-unified-extension-registry.md
 * @tests @test/unit/cli/help-generator.test.ts
 * @version 1.0.0
 */

import { listProviderDefinitions } from '../providers/provider-definitions.js';
import type { ExtensionRegistry } from '../extensions/registry.js';
import type { Extension } from '../extensions/types.js';
import type { CommandCategory } from './handlers/types.js';

/**
 * Category display order and titles
 *
 * Determines the order in which command categories appear in help output.
 */
const CATEGORY_ORDER: { category: CommandCategory; title: string }[] = [
  { category: 'framework', title: 'Framework Management' },
  { category: 'project', title: 'Project Setup' },
  { category: 'workspace', title: 'Workspace Management' },
  { category: 'mcp', title: 'MCP Server' },
  { category: 'toolsmith', title: 'Toolsmith (Runtime Discovery)' },
  { category: 'catalog', title: 'Model Catalog' },
  { category: 'utility', title: 'Utilities' },
  { category: 'plugin', title: 'Plugin Packaging' },
  { category: 'scaffolding', title: 'Scaffolding' },
  { category: 'channel', title: 'Channel Management' },
  { category: 'maintenance', title: 'Maintenance' },
  { category: 'ralph', title: 'Agent Loop (Iterative Execution)' },
  { category: 'orchestration', title: 'Orchestration (Mission Control)' },
  { category: 'index', title: 'Artifact Index' },
  { category: 'daemon', title: 'Daemon & Behaviors' },
  { category: 'agentic-tools', title: 'Agentic Tools (RLM chunk, fanout, search)' },
];

/**
 * Command name column width for alignment
 */
const COMMAND_COL_WIDTH = 24;

/**
 * Generate help text from registry
 *
 * Dynamically builds CLI help text by querying the extension registry for
 * command extensions, grouping them by category, and formatting them for display.
 *
 * @param registry - Extension registry to query
 * @returns Formatted help text
 *
 * @example
 * ```typescript
 * import { getRegistry } from '../extensions/registry.js';
 * import { generateHelp } from './help-generator.js';
 *
 * const registry = getRegistry();
 * const helpText = generateHelp(registry);
 * console.log(helpText);
 * ```
 */
export function generateHelp(registry: ExtensionRegistry): string {
  const lines: string[] = [];

  // Header
  lines.push('AIWG CLI');
  lines.push('');
  lines.push('Usage: aiwg <command> [options]');
  lines.push('');

  // Get commands by category (skills are the canonical source format for CLI commands)
  const commands = [
    ...registry.getByType('skill'),
    ...registry.getByType('command'),
  ];
  const byCategory = groupByCategory(commands);

  // Generate sections in order
  for (const { category, title } of CATEGORY_ORDER) {
    const categoryCommands = byCategory.get(category);
    if (!categoryCommands || categoryCommands.length === 0) continue;

    lines.push(`${title}:`);
    for (const cmd of categoryCommands) {
      const name = formatCommandName(cmd);
      const desc = cmd.description;
      lines.push(`  ${name.padEnd(COMMAND_COL_WIDTH)} ${desc}`);
    }
    lines.push('');
  }

  // Platform options
  lines.push('Platform Options (--provider):');
  lines.push(`  ${generateProviderHelp()}`);
  lines.push('');

  // Examples
  lines.push('Examples:');
  lines.push('  aiwg use sdlc                    Install SDLC framework');
  lines.push('  aiwg use sdlc --global           Install user assets + lightweight project wiring');
  lines.push('  aiwg -new                        Create new project');
  lines.push('  aiwg doctor                      Check installation health');
  lines.push('');

  return lines.join('\n');
}

/**
 * Group commands by category
 *
 * Takes a flat list of command extensions and organizes them into a Map
 * keyed by category, with values being arrays of extensions.
 *
 * @param commands - Array of command extensions
 * @returns Map of category to command extensions
 *
 * @example
 * ```typescript
 * const commands = registry.getByType('command');
 * const grouped = groupByCategory(commands);
 *
 * const frameworkCommands = grouped.get('framework');
 * console.log(`${frameworkCommands?.length} framework commands`);
 * ```
 */
function groupByCategory(commands: Extension[]): Map<string, Extension[]> {
  const map = new Map<string, Extension[]>();

  for (const cmd of commands) {
    const category = cmd.category || 'utility';

    let list = map.get(category);
    if (!list) {
      list = [];
      map.set(category, list);
    }

    list.push(cmd);
  }

  // Sort commands within each category by ID
  // Use Array.from to convert values() iterator to array
  Array.from(map.values()).forEach((list) => {
    list.sort((a, b) => a.id.localeCompare(b.id));
  });

  return map;
}

/**
 * Format command name with primary alias
 *
 * Returns a formatted command name string that includes the primary alias
 * (if present) for display in help text.
 *
 * Format:
 * - No aliases: "command-name"
 * - With aliases: "command-name, -alias"
 *
 * @param cmd - Command extension
 * @returns Formatted command name string
 *
 * @example
 * ```typescript
 * // Command with no aliases
 * const name1 = formatCommandName(useCmd);
 * // Returns: "use"
 *
 * // Command with aliases
 * const name2 = formatCommandName(newCmd);
 * // Returns: "new, -new"
 *
 * // Command with multiple aliases
 * const name3 = formatCommandName(helpCmd);
 * // Returns: "help, -h"
 * ```
 */
function formatCommandName(cmd: Extension): string {
  // Get aliases from metadata
  const metadata = cmd.metadata as any;
  const aliases = metadata?.aliases || [];

  // If no aliases, just return ID
  if (aliases.length === 0) {
    return cmd.id;
  }

  // Show command name with first alias
  return `${cmd.id}, ${aliases[0]}`;
}

/** Provider list shared by both production help paths, including generic. */
export function generateProviderHelp(): string {
  const providers = listProviderDefinitions();
  return `Providers: ${providers.length} — ${providers.map(({ id, status }) => status === 'experimental' ? `${id} (experimental)` : id).join(', ')} (default: claude; aliases: agy → antigravity, windsurf → devin (deprecated), oh-my-pi → omp, openai → codex)`;
}
