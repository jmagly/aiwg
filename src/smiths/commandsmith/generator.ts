/**
 * Command generation and deployment
 */

import { mkdir, writeFile, readFile, access } from 'fs/promises';
import { join, dirname } from 'path';
import { constants } from 'fs';
import {
  CommandOptions,
  GeneratedCommand,
  CommandDeploymentResult,
  ValidationResult,
  ValidationIssue,
  CursorCommandSpec,
} from './types.js';
import { generateCommandContent } from './templates.js';
import { getCommandsDirectory, getFileExtension } from '../platform-paths.js';

/**
 * Validate command name (kebab-case)
 */
function validateCommandName(name: string): string | null {
  if (!name || name.trim() === '') {
    return 'Command name cannot be empty';
  }

  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return 'Command name must be kebab-case (lowercase letters, numbers, hyphens only, must start with letter)';
  }

  if (name.startsWith('-') || name.endsWith('-')) {
    return 'Command name cannot start or end with a hyphen';
  }

  if (name.includes('--')) {
    return 'Command name cannot contain consecutive hyphens';
  }

  return null;
}

/**
 * Validate command options
 */
export function validateCommand(command: GeneratedCommand): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Validate name
  const nameError = validateCommandName(command.name);
  if (nameError) {
    issues.push({
      type: 'error',
      field: 'name',
      message: nameError,
      suggestion: 'Use lowercase letters, numbers, and hyphens only (e.g., my-command)',
    });
  }

  // Validate content
  if (!command.content || command.content.trim() === '') {
    issues.push({
      type: 'error',
      field: 'content',
      message: 'Command content cannot be empty',
    });
  }

  // Validate platform
  const validPlatforms = ['claude', 'codex', 'copilot', 'cursor', 'factory', 'generic', 'devin'];
  if (!validPlatforms.includes(command.platform)) {
    issues.push({
      type: 'error',
      field: 'platform',
      message: `Invalid platform: ${command.platform}`,
      suggestion: `Must be one of: ${validPlatforms.join(', ')}`,
    });
  }

  // Warn if content doesn't include standard options
  if (!command.content.includes('--interactive') && !command.content.includes('--guidance')) {
    issues.push({
      type: 'warning',
      field: 'content',
      message: 'Command should support --interactive and --guidance options',
      suggestion: 'Add these standard options to command arguments',
    });
  }

  return {
    valid: issues.filter(i => i.type === 'error').length === 0,
    issues,
    command,
  };
}

/**
 * Transform command content for Cursor platform (JSON format)
 */
function transformForCursor(
  name: string,
  description: string,
  options: CommandOptions
): string {
  const spec: CursorCommandSpec = {
    name,
    description,
    arguments: (options.args || []).map(arg => ({
      name: arg.name,
      description: arg.description,
      required: arg.required,
      type: 'string',
      default: arg.default,
    })),
    options: [
      ...(options.options || []).map(opt => ({
        name: opt.name,
        description: opt.description,
        type: opt.type,
        default: opt.default,
      })),
      {
        name: 'interactive',
        description: 'Enable interactive mode with guided questions',
        type: 'boolean',
        default: false,
      },
      {
        name: 'guidance',
        description: 'Provide strategic guidance for execution',
        type: 'string',
      },
    ],
    execution: {
      steps: [
        'Validate inputs',
        'Process request',
        'Generate output',
        'Report status',
      ],
    },
    commandHint: {
      modelRole: options.modelRole ?? 'efficiency',
      modelTier: options.modelTier ?? 'economy',
    },
  };

  return JSON.stringify(spec, null, 2);
}

/**
 * Generate a command from options
 */
export async function generateCommand(options: CommandOptions): Promise<GeneratedCommand> {
  // Validate command name
  const nameError = validateCommandName(options.name);
  if (nameError) {
    throw new Error(nameError);
  }

  // Default template
  const template = options.template || 'utility';

  // Determine target directory
  const targetDir = options.targetDir || getCommandsDirectory(options.platform, options.projectPath);

  // Get file extension
  const ext = getFileExtension(options.platform);

  // Build file path
  const filePath = join(targetDir, `${options.name}${ext}`);
  const skillPath = join(options.projectPath, '.agents/skills', options.name, 'SKILL.md');
  const modelRole = options.modelRole ?? (template === 'orchestration' ? 'coding' : 'efficiency');
  const modelTier = options.modelTier ?? (template === 'orchestration' ? 'standard' : 'economy');

  // Generate content based on platform
  let content: string;
  if (options.platform === 'cursor') {
    // Cursor uses JSON format
    content = transformForCursor(options.name, options.description, options);
  } else {
    // Other platforms use markdown
    content = generateCommandContent(
      template,
      options.name,
      options.description,
      options.args,
      options.options,
      options.guidance,
      modelRole,
      modelTier
    );
  }
  const skillContent = `---
name: ${options.name}
namespace: aiwg
description: ${options.description}
commandHint:
  modelRole: ${modelRole}
  modelTier: ${modelTier}
---

# ${options.name}

${options.description}

## Execution

Use the generated provider command artifact for slash-command UX, but treat this SKILL.md as the canonical source for model policy and deployment translation.
`;

  return {
    name: options.name,
    path: filePath,
    content,
    skillContent,
    skillPath,
    platform: options.platform,
    template,
  };
}

/**
 * Check if file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Backup existing file
 */
async function backupFile(path: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const backupPath = `${path}.backup-${timestamp}`;

  const content = await readFile(path, 'utf-8');
  await writeFile(backupPath, content, 'utf-8');

  return backupPath;
}

/**
 * Deploy a generated command to the filesystem
 */
export async function deployCommand(
  command: GeneratedCommand,
  options: { force?: boolean; backup?: boolean } = {}
): Promise<CommandDeploymentResult> {
  try {
    // Validate command first
    const validation = validateCommand(command);
    if (!validation.valid) {
      const errors = validation.issues.filter(i => i.type === 'error').map(i => i.message);
      return {
        command,
        success: false,
        error: `Validation failed: ${errors.join('; ')}`,
      };
    }

    // Check if file exists
    const exists = await fileExists(command.path);

    // Handle existing file
    if (exists && !options.force) {
      return {
        command,
        success: false,
        error: `File already exists: ${command.path}. Use force option to overwrite.`,
      };
    }

    // Backup if requested and file exists
    let backed_up = false;
    if (exists && options.backup) {
      await backupFile(command.path);
      backed_up = true;
    }

    // Ensure directory exists
    const dir = dirname(command.path);
    await mkdir(dir, { recursive: true });
    await mkdir(dirname(command.skillPath), { recursive: true });

    // Write command file
    await writeFile(command.skillPath, command.skillContent, 'utf-8');
    await writeFile(command.path, command.content, 'utf-8');

    return {
      command,
      success: true,
      backed_up,
    };
  } catch (error) {
    return {
      command,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Generate and deploy a command in one step
 */
export async function generateAndDeploy(
  options: CommandOptions,
  deployOptions: { force?: boolean; backup?: boolean } = {}
): Promise<CommandDeploymentResult> {
  const command = await generateCommand(options);

  // If dry run, don't deploy
  if (options.dryRun) {
    return {
      command,
      success: true,
      error: undefined,
    };
  }

  return deployCommand(command, deployOptions);
}

/**
 * List existing commands in a project
 */
export async function listCommands(
  platform: string,
  projectPath: string
): Promise<string[]> {
  const commandsDir = getCommandsDirectory(platform as any, projectPath);
  const ext = getFileExtension(platform as any);

  try {
    const { readdir } = await import('fs/promises');
    const files = await readdir(commandsDir);
    return files
      .filter(f => f.endsWith(ext))
      .map(f => f.replace(ext, ''))
      .sort();
  } catch {
    // Directory doesn't exist or is empty
    return [];
  }
}
