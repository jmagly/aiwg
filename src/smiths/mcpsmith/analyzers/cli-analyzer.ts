/**
 * CLI Analyzer for MCPsmith
 *
 * Parses CLI tool help output to extract tool definitions.
 *
 * @architecture @docs/smithing/mcpsmith.md
 * @implements @docs/smithing/mcpsmith.md
 */

import { spawn } from 'child_process';
import type {
  AnalyzerResult,
  CLIAnalyzerOptions,
  MCPToolDefinition,
  ParsedCLIHelp,
  ParsedSubcommand,
  ParsedFlag
} from '../types.js';

/**
 * Analyze a CLI tool and extract MCP tool definitions
 */
export async function analyzeCLI(options: CLIAnalyzerOptions): Promise<AnalyzerResult> {
  const {
    command,
    includeSubcommands = true,
    // maxDepth and parseManPage reserved for future use
    timeout = 5000
  } = options;

  // Get command version
  const version = await getCommandVersion(command, timeout);

  // Get help output
  const helpText = await getHelpOutput(command, timeout);

  // Parse help text
  const parsed = parseHelpText(helpText, command);

  // Extract tool definitions
  const tools: MCPToolDefinition[] = [];

  // If there are subcommands, generate tools for each
  if (includeSubcommands && parsed.subcommands.length > 0) {
    for (const subcommand of parsed.subcommands) {
      const tool = subcommandToTool(command, subcommand, parsed.globalFlags);
      tools.push(tool);
    }
  } else {
    // Generate single tool for the command
    const tool = commandToTool(command, parsed);
    tools.push(tool);
  }

  return {
    tools,
    metadata: {
      sourceType: 'cli',
      sourceName: command,
      sourceVersion: version,
      discoveredAt: new Date().toISOString(),
      toolCount: tools.length
    }
  };
}

/**
 * Get command version
 */
async function getCommandVersion(command: string, timeout: number): Promise<string | undefined> {
  try {
    // Try common version flags
    const versionFlags = ['--version', '-v', 'version', '-V'];

    for (const flag of versionFlags) {
      try {
        const output = await executeCommand(command, [flag], timeout);
        if (output && output.trim().length > 0) {
          // Extract version number from output
          const versionMatch = output.match(/\d+\.\d+(\.\d+)?/);
          if (versionMatch) {
            return versionMatch[0];
          }
          // Return first line if no version number found
          return output.split('\n')[0].trim();
        }
      } catch {
        continue;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get help output for command
 */
async function getHelpOutput(command: string, timeout: number): Promise<string> {
  const helpFlags = ['--help', '-h', 'help'];

  for (const flag of helpFlags) {
    try {
      const output = await executeCommand(command, [flag], timeout);
      if (output && output.trim().length > 0) {
        return output;
      }
    } catch {
      continue;
    }
  }

  throw new Error(`Could not get help output for command: ${command}`);
}

/**
 * Execute command and capture output
 */
function executeCommand(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      timeout,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      // Many commands output help to stderr
      const output = stdout || stderr;
      if (output.trim().length > 0) {
        resolve(output);
      } else {
        reject(new Error(`Command exited with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Parse help text into structured format
 */
function parseHelpText(helpText: string, command: string): ParsedCLIHelp {
  const lines = helpText.split('\n');

  // Extract description (usually first non-empty line or after "NAME:")
  const description = extractDescription(lines);

  // Extract subcommands
  const subcommands = extractSubcommands(lines);

  // Extract global flags/options
  const globalFlags = extractFlags(lines);

  return {
    command,
    description,
    subcommands,
    globalFlags
  };
}

/**
 * Extract description from help text
 */
function extractDescription(lines: string[]): string {
  // Look for description after NAME: or DESCRIPTION:
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(NAME|DESCRIPTION):/i.test(line)) {
      // Next line is usually the description
      if (i + 1 < lines.length) {
        return lines[i + 1].trim();
      }
    }
  }

  // Otherwise use first non-empty line
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('-') && !trimmed.startsWith('Usage:')) {
      return trimmed;
    }
  }

  return 'CLI tool';
}

/**
 * Extract subcommands from help text
 */
function extractSubcommands(lines: string[]): ParsedSubcommand[] {
  const subcommands: ParsedSubcommand[] = [];
  let inSubcommandsSection = false;

  // Patterns for subcommand sections
  const sectionPatterns = /^(COMMANDS|SUBCOMMANDS|Available commands):/i;
  // Pattern for subcommand line: "  command    description"
  const subcommandPattern = /^  ([a-z][a-z0-9-_]*)\s{2,}(.+)$/i;

  for (const line of lines) {
    // Check if we're entering subcommands section
    if (sectionPatterns.test(line)) {
      inSubcommandsSection = true;
      continue;
    }

    // Check if we're leaving section (next section header or empty line)
    if (inSubcommandsSection && (/^[A-Z\s]+:/.test(line) || line.trim() === '')) {
      if (/^[A-Z\s]+:/.test(line)) {
        inSubcommandsSection = false;
      }
      continue;
    }

    // Parse subcommand line
    if (inSubcommandsSection) {
      const match = line.match(subcommandPattern);
      if (match) {
        subcommands.push({
          name: match[1],
          description: match[2].trim(),
          flags: [],
          arguments: []
        });
      }
    }
  }

  return subcommands;
}

/**
 * Extract flags/options from help text
 */
function extractFlags(lines: string[]): ParsedFlag[] {
  const flags: ParsedFlag[] = [];
  let inOptionsSection = false;

  // Patterns for options section
  const sectionPatterns = /^(OPTIONS|FLAGS):/i;
  // Pattern for flag line: "  -s, --long <arg>    description"
  const flagPattern = /^\s+(-[a-z])?,?\s*(--[a-z][a-z0-9-_]*)?(?:\s+<([^>]+)>|\s+\[([^\]]+)\])?\s{2,}(.+)$/i;

  for (const line of lines) {
    // Check if we're entering options section
    if (sectionPatterns.test(line)) {
      inOptionsSection = true;
      continue;
    }

    // Check if we're leaving section
    if (inOptionsSection && /^[A-Z\s]+:/.test(line)) {
      inOptionsSection = false;
      continue;
    }

    // Parse flag line
    if (inOptionsSection) {
      const match = line.match(flagPattern);
      if (match) {
        const [, short, long, requiredArg, optionalArg, description] = match;
        const hasArg = !!(requiredArg || optionalArg);

        flags.push({
          short,
          long,
          description: description.trim(),
          type: hasArg ? 'string' : 'boolean',
          required: !!requiredArg
        });
      }
    }
  }

  return flags;
}

/**
 * Convert subcommand to MCP tool definition
 */
function subcommandToTool(
  command: string,
  subcommand: ParsedSubcommand,
  globalFlags: ParsedFlag[]
): MCPToolDefinition {
  const toolName = `${command}-${subcommand.name}`;
  const mapping: Record<string, any> = {};
  const properties: Record<string, any> = {};
  const required: string[] = [];

  // Add flags to schema
  const allFlags = [...globalFlags, ...subcommand.flags];
  for (const flag of allFlags) {
    const paramName = (flag.long || flag.short || '').replace(/^-+/, '');
    if (!paramName) continue;

    mapping[paramName] = {
      flag: flag.long || flag.short,
      type: flag.type
    };

    properties[paramName] = {
      type: flag.type,
      description: flag.description
    };

    if (flag.required) {
      required.push(paramName);
    }

    if (flag.default) {
      properties[paramName].default = flag.default;
    }
  }

  // Add arguments to schema
  for (const arg of subcommand.arguments) {
    mapping[arg.name] = {
      position: arg.position,
      type: arg.type
    };

    properties[arg.name] = {
      type: arg.type,
      description: arg.description
    };

    if (arg.required) {
      required.push(arg.name);
    }
  }

  return {
    name: toolName,
    title: `${command} ${subcommand.name}`,
    description: subcommand.description,
    source: {
      type: 'cli',
      command,
      subcommand: subcommand.name,
      mapping
    },
    inputSchema: {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined
    },
    examples: [],
    metadata: {
      dangerous: isDangerousCommand(command, subcommand.name),
      requiresConfirmation: requiresConfirmation(command, subcommand.name),
      retryable: true
    }
  };
}

/**
 * Convert command to MCP tool definition (for commands without subcommands)
 */
function commandToTool(command: string, parsed: ParsedCLIHelp): MCPToolDefinition {
  const mapping: Record<string, any> = {};
  const properties: Record<string, any> = {};
  const required: string[] = [];

  // Add flags to schema
  for (const flag of parsed.globalFlags) {
    const paramName = (flag.long || flag.short || '').replace(/^-+/, '');
    if (!paramName) continue;

    mapping[paramName] = {
      flag: flag.long || flag.short,
      type: flag.type
    };

    properties[paramName] = {
      type: flag.type,
      description: flag.description
    };

    if (flag.required) {
      required.push(paramName);
    }

    if (flag.default) {
      properties[paramName].default = flag.default;
    }
  }

  return {
    name: command,
    title: command,
    description: parsed.description,
    source: {
      type: 'cli',
      command,
      mapping
    },
    inputSchema: {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined
    },
    examples: [],
    metadata: {
      dangerous: isDangerousCommand(command),
      requiresConfirmation: requiresConfirmation(command),
      retryable: true
    }
  };
}

/**
 * Check if command/subcommand is dangerous
 */
function isDangerousCommand(command: string, subcommand?: string): boolean {
  const dangerousPatterns = [
    /rm/i,
    /delete/i,
    /remove/i,
    /format/i,
    /erase/i,
    /destroy/i,
    /force/i,
    /hard/i
  ];

  const fullCommand = subcommand ? `${command}-${subcommand}` : command;
  return dangerousPatterns.some(pattern => pattern.test(fullCommand));
}

/**
 * Check if command requires confirmation
 */
function requiresConfirmation(command: string, subcommand?: string): boolean {
  const confirmationPatterns = [
    /push/i,
    /deploy/i,
    /publish/i,
    /reset/i,
    /rebase/i
  ];

  const fullCommand = subcommand ? `${command}-${subcommand}` : command;
  return confirmationPatterns.some(pattern => pattern.test(fullCommand));
}
