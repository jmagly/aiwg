/**
 * Skills CLI Commands
 *
 * Provides CLI interface for multi-registry skill operations:
 * - search: Search skills across registries
 * - info: Show detailed skill information
 * - list: List all available skills
 * - install: Install a skill from a registry
 * - publish: Publish a skill to a registry
 *
 * @implements #539
 */

import { spawn } from 'child_process';
import { displaySkillsTable, displaySkillCollisions } from './cli-display.js';
import {
  searchSkills,
  listSkills,
  getSkillInfo,
  installSkill,
  publishSkill,
  importSkillSource,
  getAllAdapters,
} from './registry.js';
import { AgentSkillImportError } from './importer.js';
import {
  AgentSkillDeploymentError,
  deployImportedAgentSkill,
  uninstallImportedAgentSkill,
} from './deployer.js';
import {
  AgentSkillExportError,
  exportAgentSkillDirectory,
} from './exporter.js';
import type {
  AgentSkillDeploymentOptions,
  AgentSkillDeploymentResult,
  AgentSkillExportOptions,
  AgentSkillImportOptions,
  AgentSkillImportSource,
  SkillDetails,
} from './types.js';
import { PROVIDER_IDS } from '../providers/provider-definitions.js';
import {
  parseAgentSpawnFlags,
  buildAgentArgs,
  getProviderConfig,
  isSpawnableProvider,
} from '../cli/agent-spawn.js';

const SUPPORTED_TARGETS: readonly string[] = PROVIDER_IDS;

export function importedSkillActivationError(
  details: SkillDetails,
): string | undefined {
  if (
    !details.imported
    || (
      details.imported.trust.state === 'trusted'
      && details.imported.trust.activation === 'active'
    )
  ) {
    return undefined;
  }
  return (
    `Imported skill '${details.name}' is `
    + `${details.imported.trust.state}/${details.imported.trust.activation}. `
    + `Explicitly trust and activate digest ${details.imported.digest} before execution.`
  );
}

/**
 * Parse --provider and --target flags from args
 */
function parseFlags(args: string[]): {
  provider: string | undefined;
  target: string | undefined;
  rest: string[];
} {
  const rest: string[] = [];
  let provider: string | undefined;
  let target: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' && i + 1 < args.length) {
      provider = args[i + 1];
      i++;
    } else if (args[i] === '--target' && i + 1 < args.length) {
      target = args[i + 1];
      i++;
    } else {
      rest.push(args[i]);
    }
  }

  return { provider, target, rest };
}

/**
 * Handle 'skills search' command
 */
async function handleSearch(args: string[]): Promise<void> {
  const { provider, rest } = parseFlags(args);
  const query = rest.join(' ');

  if (!query) {
    console.error('Error: Search query required');
    console.log('Usage: aiwg skills search <query> [--provider <registry>]');
    process.exit(1);
  }

  const results = await searchSkills(query, provider);

  console.log('');
  console.log(
    `Search results for "${query}"${provider ? ` (${provider})` : ''}:`
  );
  displaySkillsTable(results);
  console.log('');
  console.log(`  ${results.length} skill(s) found`);
  console.log('');
}

/**
 * Handle 'skills info' command
 */
async function handleInfo(args: string[]): Promise<void> {
  const { provider, rest } = parseFlags(args);
  const name = rest[0];

  if (!name) {
    console.error('Error: Skill name required');
    console.log('Usage: aiwg skills info <name> [--provider <registry>]');
    process.exit(1);
  }

  const details = await getSkillInfo(name, provider);

  if (!details) {
    console.error(`Error: Skill '${name}' not found`);
    console.log("Run 'aiwg skills search <query>' to find skills");
    process.exit(1);
  }

  console.log('');
  console.log(`Skill: ${details.name}`);
  console.log('');
  console.log(`Source:      ${details.source}`);
  if (details.package) console.log(`Package:     ${details.package}`);
  if (details.version) console.log(`Version:     ${details.version}`);
  console.log(`Description: ${details.description}`);
  displaySkillCollisions(details);

  if (details.platforms && details.platforms.length > 0) {
    console.log(`Platforms:   ${details.platforms.join(', ')}`);
  }

  if (details.triggers && details.triggers.length > 0) {
    console.log('');
    console.log('Triggers:');
    for (const trigger of details.triggers) {
      console.log(`  - ${trigger}`);
    }
  }

  if (details.scripts && details.scripts.length > 0) {
    console.log('');
    console.log('Scripts:');
    for (const script of details.scripts) {
      console.log(`  - ${script}`);
    }
  }

  if (details.path) {
    console.log('');
    console.log(`Path: ${details.path}`);
  }

  if (details.imported) {
    console.log('');
    console.log(`Digest:       ${details.imported.digest}`);
    console.log(`Profile:      ${details.imported.validationProfile}`);
    console.log(`Trust:        ${details.imported.trust.state}`);
    console.log(`Activation:   ${details.imported.trust.activation}`);
    console.log(`Source kind:  ${details.imported.source.kind}`);
    console.log(`Locator:      ${details.imported.source.locator}`);
    if (details.imported.source.kind === 'git') {
      console.log(`Subpath:      ${details.imported.source.subpath}`);
      console.log(`Requested:    ${details.imported.source.requestedRevision}`);
      console.log(`Resolved:     ${details.imported.source.resolvedRevision}`);
    }
  }

  console.log('');
}

/**
 * Handle 'skills list' command
 */
async function handleList(args: string[]): Promise<void> {
  const { provider } = parseFlags(args);

  const results = await listSkills(provider);

  console.log('');
  console.log(
    `Available skills${provider ? ` (${provider})` : ''}:`
  );
  displaySkillsTable(results);
  console.log('');
  console.log(`  ${results.length} skill(s) total`);

  // Show registry availability
  const adapters = getAllAdapters();
  console.log('');
  console.log('  Registries:');
  for (const adapter of adapters) {
    const available = await adapter.isAvailable();
    const status = available ? '\u2713' : '\u2013';
    console.log(`    ${status} ${adapter.name} (${adapter.id})`);
  }

  console.log('');
}

/**
 * Handle 'skills install' command
 *
 * Supports cross-platform deployment:
 *   aiwg skills install <name> --provider <registry> --target <platform>
 *
 * --provider: which registry to pull from (local, clawhub, openclaw)
 * --target: which platform to deploy to (claude, copilot, cursor, etc.)
 *           Defaults to claude. Uses platform-aware path translation.
 */
async function handleInstall(args: string[]): Promise<void> {
  const { provider, target, rest } = parseFlags(args);
  const name = rest[0];

  if (!name) {
    console.error('Error: Skill name required');
    console.log(
      'Usage: aiwg skills install <name> [--provider <registry>] [--target <platform>]'
    );
    console.log('');
    console.log('Options:');
    console.log('  --provider  Registry to pull from (local, clawhub, openclaw). Default: local');
    console.log('  --target    Platform to deploy to (claude, copilot, cursor, etc.). Default: claude');
    console.log('');
    console.log('Examples:');
    console.log('  aiwg skills install parallel-dispatch');
    console.log('  aiwg skills install parallel-dispatch --target copilot');
    console.log('  aiwg skills install my-skill --provider clawhub --target cursor');
    console.log('');
    console.log(`Supported targets: ${SUPPORTED_TARGETS.join(', ')}`);
    process.exit(1);
  }

  const registry = provider || 'local';
  const targetPlatform = target || 'claude';

  if (target && !SUPPORTED_TARGETS.includes(target)) {
    console.error(`Error: Unknown target platform '${target}'`);
    console.log(`Supported: ${SUPPORTED_TARGETS.join(', ')}`);
    process.exit(1);
  }

  try {
    await installSkill(
      name,
      { projectDir: process.cwd(), target: targetPlatform },
      registry
    );
    console.log(`Installed skill '${name}' from ${registry} → ${targetPlatform}`);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

interface ParsedImportArgs {
  source: AgentSkillImportSource;
  options: Omit<AgentSkillImportOptions, 'projectDir'>;
  json: boolean;
}

function parseImportArgs(args: string[]): ParsedImportArgs {
  let gitUrl: string | undefined;
  let revision: string | undefined;
  let subpath: string | undefined;
  let profile: AgentSkillImportOptions['profile'];
  let dryRun = false;
  let update = false;
  let force = false;
  let trust = false;
  let activate = false;
  let json = false;
  const positional: string[] = [];

  const takeValue = (index: number, flag: string): string => {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--git':
        gitUrl = takeValue(index, argument);
        index += 1;
        break;
      case '--rev':
        revision = takeValue(index, argument);
        index += 1;
        break;
      case '--subpath':
        subpath = takeValue(index, argument);
        index += 1;
        break;
      case '--profile': {
        const value = takeValue(index, argument);
        if (value !== 'strict' && value !== 'compatible') {
          throw new Error('--profile must be strict or compatible');
        }
        profile = value;
        index += 1;
        break;
      }
      case '--dry-run':
        dryRun = true;
        break;
      case '--update':
        update = true;
        break;
      case '--force':
        force = true;
        break;
      case '--trust':
        trust = true;
        break;
      case '--activate':
        activate = true;
        break;
      case '--json':
        json = true;
        break;
      default:
        if (argument.startsWith('--')) {
          throw new Error(`unknown import option "${argument}"`);
        }
        positional.push(argument);
    }
  }

  if (gitUrl || revision || subpath) {
    if (!gitUrl || !revision || !subpath) {
      throw new Error('Git import requires --git, --rev, and --subpath');
    }
    if (positional.length > 0) {
      throw new Error('Git import does not accept a local directory argument');
    }
    return {
      source: {
        kind: 'git',
        url: gitUrl,
        revision,
        subpath,
      },
      options: { profile, dryRun, update, force, trust, activate },
      json,
    };
  }
  if (positional.length !== 1) {
    throw new Error('local import requires exactly one skill directory');
  }
  return {
    source: {
      kind: 'directory',
      path: positional[0],
    },
    options: { profile, dryRun, update, force, trust, activate },
    json,
  };
}

function printImportUsage(): void {
  console.log('Usage:');
  console.log('  aiwg skills import <directory> [options]');
  console.log('  aiwg skills import --git <url> --rev <revision> --subpath <path> [options]');
  console.log('  aiwg skills import <repo-url|path> --into <addon> [--ref <revision>] [--only <glob>] [--dry-run]');
  console.log('  aiwg skills import --refresh <addon> [--dry-run]');
  console.log('');
  console.log('Options:');
  console.log('  --profile strict|compatible  Validation profile (default: strict)');
  console.log('  --dry-run                    Validate and plan without writing');
  console.log('  --update                     Update changed content from the same source');
  console.log('  --force                      Replace an imported name from a different source');
  console.log('  --trust --activate           Explicitly trust and activate this exact digest');
  console.log('  --json                       Emit deterministic structured output');
}

async function handleImport(args: string[]): Promise<void> {
  if (args.includes('--into') || args.includes('--refresh')) {
    return (await import('./bundle-import-cli.js')).handleBundleImport(args);
  }
  let parsed: ParsedImportArgs;
  try {
    parsed = parseImportArgs(args);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    printImportUsage();
    process.exit(1);
  }

  try {
    const result = await importSkillSource(parsed.source, {
      ...parsed.options,
      projectDir: process.cwd(),
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(`Agent Skill import: ${result.status}`);
    console.log(`Name:         ${result.name}`);
    console.log(`Description:  ${result.description}`);
    console.log(`Digest:       ${result.digest}`);
    console.log(`Source:       ${result.source.kind}`);
    console.log(`Locator:      ${result.source.locator}`);
    if (result.source.kind === 'git') {
      console.log(`Subpath:      ${result.source.subpath}`);
      console.log(`Requested:    ${result.source.requestedRevision}`);
      console.log(`Resolved:     ${result.source.resolvedRevision}`);
    }
    console.log(`Profile:      ${result.validationProfile}`);
    console.log(`Trust:        ${result.trust.state}`);
    console.log(`Activation:   ${result.trust.activation}`);
    console.log(`Managed:      ${result.managedLocation}`);
    console.log(`Files:        ${result.fileCount}`);
    console.log(`Bytes:        ${result.totalBytes}`);
    if (result.diagnostics.length > 0) {
      console.log('');
      console.log('Diagnostics:');
      for (const item of result.diagnostics) {
        console.log(`  ${item.severity} ${item.code} ${item.file} ${item.yamlPath}: ${item.message}`);
      }
    }
    console.log('');
  } catch (error) {
    const importError = error instanceof AgentSkillImportError ? error : undefined;
    if (parsed.json) {
      console.log(JSON.stringify({
        schemaVersion: 1,
        status: 'error',
        code: importError?.code ?? 'AS_IMPORT_FAILED',
        message: error instanceof Error ? error.message : String(error),
        diagnostics: importError?.diagnostics ?? [],
      }, null, 2));
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      for (const item of importError?.diagnostics ?? []) {
        console.error(`  ${item.severity} ${item.code} ${item.file} ${item.yamlPath}: ${item.message}`);
      }
    }
    process.exit(1);
  }
}

interface ParsedDeploymentArgs {
  name: string;
  targets: string[];
  dryRun: boolean;
  json: boolean;
}

function parseDeploymentArgs(args: string[]): ParsedDeploymentArgs {
  let target = 'claude';
  let dryRun = false;
  let json = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--target': {
        const value = args[index + 1];
        if (!value || value.startsWith('--')) {
          throw new Error('--target requires a provider ID or all');
        }
        target = value;
        index += 1;
        break;
      }
      case '--dry-run':
        dryRun = true;
        break;
      case '--json':
        json = true;
        break;
      default:
        if (argument.startsWith('--')) {
          throw new Error(`unknown deployment option "${argument}"`);
        }
        positional.push(argument);
    }
  }
  if (positional.length !== 1) {
    throw new Error('deployment requires exactly one imported skill name');
  }
  if (target !== 'all' && !SUPPORTED_TARGETS.includes(target)) {
    throw new Error(`unknown target "${target}"`);
  }
  return {
    name: positional[0],
    targets: target === 'all' ? [...SUPPORTED_TARGETS] : [target],
    dryRun,
    json,
  };
}

function printDeploymentUsage(operation: 'deploy' | 'uninstall'): void {
  console.log(
    `Usage: aiwg skills ${operation} <name> [--target <provider|all>] [--dry-run] [--json]`,
  );
  console.log('');
  console.log(`Supported targets: ${SUPPORTED_TARGETS.join(', ')}`);
}

function printDeploymentResults(
  operation: 'deploy' | 'uninstall',
  results: AgentSkillDeploymentResult[],
  json: boolean,
): void {
  if (json) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      operation,
      results,
    }, null, 2));
    return;
  }
  console.log('');
  console.log(`Agent Skill ${operation}:`);
  for (const item of results) {
    console.log(
      `  ${item.provider.padEnd(10)} ${item.outcome.padEnd(9)} `
      + `${item.projectionStatus.padEnd(11)} ${item.path}`,
    );
    console.log(`    digest: ${item.sourceDigest || 'unavailable'}`);
    for (const reason of item.reasons) console.log(`    reason: ${reason}`);
    for (const warning of item.warnings) console.log(`    warning: ${warning}`);
  }
  console.log('');
}

async function handleDeployment(
  operation: 'deploy' | 'uninstall',
  args: string[],
): Promise<void> {
  let parsed: ParsedDeploymentArgs;
  try {
    parsed = parseDeploymentArgs(args);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    printDeploymentUsage(operation);
    process.exit(1);
  }

  try {
    const options = (target: string): AgentSkillDeploymentOptions => ({
      projectDir: process.cwd(),
      target,
      dryRun: parsed.dryRun,
    });
    const results = parsed.targets.map((target) => (
      operation === 'deploy'
        ? deployImportedAgentSkill(parsed.name, options(target))
        : uninstallImportedAgentSkill(parsed.name, options(target))
    ));
    printDeploymentResults(operation, results, parsed.json);
    if (results.some((item) => item.outcome === 'blocked')) {
      process.exitCode = 1;
    }
  } catch (error) {
    const deploymentError = error instanceof AgentSkillDeploymentError
      ? error
      : undefined;
    if (parsed.json) {
      console.log(JSON.stringify({
        schemaVersion: 1,
        operation,
        status: 'error',
        code: deploymentError?.code ?? 'AS_DEPLOY_FAILED',
        message: error instanceof Error ? error.message : String(error),
        results: [],
      }, null, 2));
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}

interface ParsedExportArgs {
  name: string;
  provider: string;
  outDir: string;
  dryRun: boolean;
  force: boolean;
  json: boolean;
}

function parseExportArgs(args: string[]): ParsedExportArgs {
  let provider = 'local';
  let outDir: string | undefined;
  let dryRun = false;
  let force = false;
  let json = false;
  const positional: string[] = [];
  const takeValue = (index: number, flag: string): string => {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--provider':
        provider = takeValue(index, argument);
        index += 1;
        break;
      case '--out':
        outDir = takeValue(index, argument);
        index += 1;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--force':
        force = true;
        break;
      case '--json':
        json = true;
        break;
      default:
        if (argument.startsWith('--')) {
          throw new Error(`unknown export option "${argument}"`);
        }
        positional.push(argument);
    }
  }
  if (positional.length !== 1) {
    throw new Error('export requires exactly one skill name');
  }
  if (!outDir) {
    throw new Error('export requires --out <directory>');
  }
  return {
    name: positional[0],
    provider,
    outDir,
    dryRun,
    force,
    json,
  };
}

function printExportUsage(): void {
  console.log('Usage: aiwg skills export <name> --out <directory> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --provider <registry>  Skill registry to read from (default: local)');
  console.log('  --out <directory>      Parent directory for the exported Agent Skill');
  console.log('  --dry-run              Validate and plan without writing');
  console.log('  --force                Replace an existing export directory after review');
  console.log('  --json                 Emit deterministic structured output');
}

async function handleExport(args: string[]): Promise<void> {
  let parsed: ParsedExportArgs;
  try {
    parsed = parseExportArgs(args);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    printExportUsage();
    process.exit(1);
  }

  try {
    const details = await getSkillInfo(parsed.name, parsed.provider);
    if (!details?.path) {
      throw new AgentSkillExportError(
        'AS_EXPORT_SKILL_NOT_FOUND',
        `skill '${parsed.name}' was not found in ${parsed.provider} with a local SKILL.md path`,
      );
    }
    const options: AgentSkillExportOptions = {
      outDir: parsed.outDir,
      dryRun: parsed.dryRun,
      force: parsed.force,
    };
    const result = exportAgentSkillDirectory(
      details.path.replace(/(?:^|[/\\])SKILL\.md$/, ''),
      options,
    );
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(`Agent Skill export: ${result.status}`);
    console.log(`Name:          ${result.name}`);
    console.log(`Output:        ${result.outputPath}`);
    console.log(`Source digest: ${result.sourceDigest}`);
    console.log(`Export digest: ${result.exportDigest}`);
    console.log(`Files:         ${result.fileCount}`);
    if (result.omittedAiwgFields.length > 0) {
      console.log(`Omitted AIWG fields: ${result.omittedAiwgFields.join(', ')}`);
    }
    console.log('');
  } catch (error) {
    const exportError = error instanceof AgentSkillExportError ? error : undefined;
    if (parsed.json) {
      console.log(JSON.stringify({
        schemaVersion: 1,
        status: 'error',
        code: exportError?.code ?? 'AS_EXPORT_FAILED',
        message: error instanceof Error ? error.message : String(error),
      }, null, 2));
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}

/**
 * Handle 'skills publish' command
 */
async function handlePublish(args: string[]): Promise<void> {
  const { provider, rest } = parseFlags(args);
  const packageDir = rest[0] || process.cwd();

  if (!provider) {
    console.error('Error: --provider required');
    console.log('Usage: aiwg skills publish [dir] --provider <registry>');
    console.log('');
    console.log('Example:');
    console.log('  aiwg skills publish --provider clawhub');
    process.exit(1);
  }

  try {
    await publishSkill(packageDir, provider);
    console.log(`Published skill to ${provider}`);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

/**
 * Handle 'skills run' command
 *
 * Looks up a skill by name, substitutes $ARGUMENTS, and dispatches
 * the full skill prompt to the configured provider for execution.
 *
 * Always routes through a provider — no local execution fallback.
 *
 * @implements roctinam/aiwg#630
 */
async function handleRun(args: string[]): Promise<void> {
  const { opts, remaining } = parseAgentSpawnFlags(args);
  const skillName = remaining[0];
  const skillArgs = remaining.slice(1);

  if (!skillName) {
    console.error('Error: Skill name required');
    console.log('Usage: aiwg skills run <skill-name> [args...] [--provider <provider>]');
    console.log('');
    console.log('Examples:');
    console.log('  aiwg skills run workspace-health');
    console.log('  aiwg skills run ralph "Fix failing tests" --completion "npm test passes"');
    console.log('  aiwg skills run doc-sync --dry-run --provider claude');
    process.exit(1);
  }

  const details = await getSkillInfo(skillName);

  if (!details) {
    console.error(`Error: Skill '${skillName}' not found`);
    console.log("Run 'aiwg skills list' to see available skills");
    process.exit(1);
  }

  const activationError = importedSkillActivationError(details);
  if (activationError) {
    console.error(`Error: ${activationError}`);
    process.exit(1);
  }

  if (!details.content) {
    console.error(`Error: Skill '${skillName}' has no executable content`);
    process.exit(1);
  }

  // Substitute $ARGUMENTS with the provided args
  const argString = skillArgs.join(' ');
  const prompt = details.content.replace(/\$ARGUMENTS/g, argString);

  // Resolve provider — default to claude
  const providerName = opts.provider ?? 'claude';

  if (!isSpawnableProvider(providerName)) {
    const config = getProviderConfig(providerName);
    console.error(`Error: Provider '${config.name}' cannot be spawned from the CLI.`);
    if (config.guidanceMessage) {
      console.log('');
      console.log(config.guidanceMessage);
    }
    process.exit(1);
  }

  const config = getProviderConfig(providerName);
  const spawnArgs = buildAgentArgs(prompt, opts);

  console.log(`Running skill '${skillName}' via ${config.name}...`);
  console.log('');

  const child = spawn(config.binary!, spawnArgs, { stdio: 'inherit' });

  child.on('error', (err) => {
    console.error(`Error: Failed to spawn ${config.binary}: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code ?? 1);
  });
}

/**
 * Main skills command router
 */
export async function main(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subcommandArgs = args.slice(1);

  switch (subcommand) {
    case 'run':
      await handleRun(subcommandArgs);
      break;

    case 'search':
      await handleSearch(subcommandArgs);
      break;

    case 'info':
      await handleInfo(subcommandArgs);
      break;

    case 'list':
      await handleList(subcommandArgs);
      break;

    case 'install':
      await handleInstall(subcommandArgs);
      break;

    case 'import':
      await handleImport(subcommandArgs);
      break;

    case 'deploy':
      await handleDeployment('deploy', subcommandArgs);
      break;

    case 'uninstall':
      await handleDeployment('uninstall', subcommandArgs);
      break;

    case 'export':
      await handleExport(subcommandArgs);
      break;

    case 'publish':
      await handlePublish(subcommandArgs);
      break;

    case undefined:
      console.error('Error: Skills subcommand required');
      console.log('Available: run, search, info, list, install, import, deploy, uninstall, export, publish');
      console.log('');
      console.log('Examples:');
      console.log('  aiwg skills run workspace-health');
      console.log('  aiwg skills run ralph "Fix failing tests" --completion "npm test passes"');
      console.log('  aiwg skills list');
      console.log('  aiwg skills search "parallel"');
      console.log('  aiwg skills info parallel-dispatch');
      console.log('  aiwg skills search "testing" --provider clawhub');
      console.log('  aiwg skills install parallel-dispatch');
      console.log('  aiwg skills install parallel-dispatch --target copilot');
      console.log('  aiwg skills install my-skill --provider clawhub --target cursor');
      console.log('  aiwg skills import ./my-skill --dry-run');
      console.log('  aiwg skills deploy my-skill --target all --dry-run');
      console.log('  aiwg skills uninstall my-skill --target claude');
      console.log('  aiwg skills export my-skill --out ./agent-skills');
      process.exit(1);
      break;

    default:
      console.error(`Error: Unknown skills subcommand '${subcommand}'`);
      console.log('Available: run, search, info, list, install, import, deploy, uninstall, export, publish');
      process.exit(1);
  }
}
