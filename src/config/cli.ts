/**
 * Config CLI — Subcommand router for `aiwg config`
 *
 * Subcommands:
 *   get <key>           — Read a config value
 *   set <key> <value>   — Write a config value
 *   list                — Show all user config (merged view)
 *   validate            — Validate all config files
 *   reset [<key>]       — Reset key or all config to defaults
 *   path                — Print the active config directory path
 *   edit                — Open config in $EDITOR
 *   gitignore           — Show/check/fix .gitignore for AIWG runtime dirs
 *
 * Global flags:
 *   --config-dir <path> — Override config directory
 *
 * @implements #545
 * @implements #553
 */

import { fileURLToPath } from 'url';
import path from 'path';
import { UserConfig } from './user-config.js';
import { AiwgError, EXIT_CODES } from '../cli/errors.js';
import { projectControlPath, resolveProjectAiwgDir } from './project-artifacts.js';

const _scriptDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Main CLI entry point for `aiwg config <subcommand> [args]`
 */
export async function main(args: string[]): Promise<void> {
  // Extract --config-dir flag before routing
  let configDir: string | undefined;
  const filteredArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config-dir' && i + 1 < args.length) {
      configDir = args[i + 1];
      i++; // skip next arg
    } else {
      filteredArgs.push(args[i]);
    }
  }

  const subcommand = filteredArgs[0];
  const subArgs = filteredArgs.slice(1);

  const config = new UserConfig(configDir);

  switch (subcommand) {
    case 'get':
      await handleGet(config, subArgs);
      break;

    case 'set':
      await handleSet(config, subArgs);
      break;

    case 'list':
    case 'ls':
      await handleList(config);
      break;

    case 'validate':
      await handleValidate(config, subArgs);
      break;

    case 'reset':
      await handleReset(config, subArgs);
      break;

    case 'path':
      handlePath(config);
      break;

    case 'edit':
      await handleEdit(config);
      break;

    case 'gitignore':
      await handleGitignore(subArgs);
      break;

    case 'show':
      await handleShow(subArgs);
      break;

    default:
      printUsage();
      if (subcommand) {
        throw new AiwgError({
          code: 'ERR_USAGE_UNKNOWN_SUBCOMMAND',
          message: `Unknown config subcommand: ${subcommand}`,
          hint: "Run 'aiwg config' without arguments to see usage",
          exitCode: EXIT_CODES.USAGE,
        });
      }
      break;
  }
}

async function handleGet(config: UserConfig, args: string[]): Promise<void> {
  const isProject = args.includes('--project');
  const positional = args.filter(a => a !== '--project' && a !== '--user');
  const key = positional[0];
  if (!key) {
    throw new AiwgError({
      code: 'ERR_USAGE_MISSING_ARG',
      message: 'aiwg config get requires a key',
      hint: 'Example: aiwg config get defaults.provider  (or --project delivery.mode)',
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (isProject) {
    await projectConfigGet(key, args);
    return;
  }

  const value = await config.get(key);
  if (value === undefined) {
    console.log(`(not set)`);
  } else if (typeof value === 'object') {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(String(value));
  }
}

async function handleSet(config: UserConfig, args: string[]): Promise<void> {
  const isProject = args.includes('--project');
  const positional = args.filter(a => a !== '--project' && a !== '--user');
  const key = positional[0];
  const value = positional[1];

  if (!key || value === undefined) {
    throw new AiwgError({
      code: 'ERR_USAGE_MISSING_ARG',
      message: 'aiwg config set requires both a key and a value',
      hint: 'Example: aiwg config set defaults.verbosity quiet  (or --project delivery.mode pr-required)',
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (isProject) {
    await projectConfigSet(key, value, args);
    return;
  }

  await config.set(key, value);
  console.log(`Set ${key} = ${value}`);
}

// ── Project-config get/set (#1006) ────────────────────────────────────────────
//
// Extends `aiwg config get|set` with `--project` to read/write the project-
// level .aiwg/aiwg.config. Dotted paths address nested fields:
//   aiwg config get --project delivery.mode
//   aiwg config set --project delivery.mode pr-required
//   aiwg config get --project remotes.primary
//
// Set validates enum membership for known fields (delivery.mode,
// delivery.merge_style, delivery.force_push_policy, remotes.issue_provider)
// before writing.

/** Deprecated values accepted on `set` and normalized to their current spelling. */
const ENUM_ALIASES: Record<string, Record<string, string>> = {
  'delivery.force_push_policy': { 'main-only-blocked': 'own-branch-only' },
};

/** Extra context printed alongside an alias normalization, where semantics also changed. */
const ENUM_ALIAS_NOTES: Record<string, string> = {
  'delivery.force_push_policy':
    "The permission also narrowed: the old value allowed force-push on any feature branch, the new one only on the agent's own branch.",
};

const ENUM_RULES: Record<string, readonly string[]> = {
  'delivery.mode': ['direct', 'feature-branch', 'pr-required'],
  'delivery.merge_style': ['rebase-merge', 'squash', 'merge', 'fast-forward-only'],
  'delivery.force_push_policy': ['never', 'own-branch-only', 'allowed'],
  'delivery.signing.format': ['openpgp', 'ssh', 'x509'],
  'delivery.signing.enforce': ['commits', 'tags', 'all'],
  'delivery.release_signing.format': ['openpgp', 'ssh', 'x509'],
  'delivery.release_signing.enforce': ['commits', 'tags', 'all'],
  'remotes.issue_provider': ['gitea', 'github', 'local'],
  'remotes.customer_issue_provider': ['gitea', 'github', 'local'],
  'remotes.tracker_actor.via': ['tea', 'gh', 'mcp', 'api'],
  'remotes.customer_tracker_actor.via': ['tea', 'gh', 'mcp', 'api'],
  'remotes.transport.protocol': ['ssh', 'https'],
  'repo_maintainer.tiers.local': ['collaborator', 'maintainer', 'admin'],
  'security.threatAssessment.mode': ['off', 'audit', 'enforce'],
  'artifact_outputs.canonical': ['aiwg'],
  'artifact_outputs.provider_native': ['disabled', 'explicit-only', 'project-default'],
};

const BOOLEAN_FIELDS = new Set([
  'delivery.delete_branch_on_merge',
  'delivery.require_ci_green',
  'delivery.require_signed_commits',
  'delivery.auto_close_issues',
  'delivery.issue_comment_on_cycle',
  'command_log.enabled',
  'telemetry.skill_usage.enabled',
]);

const STRING_ARRAY_FIELDS = new Set([
  'providers',
  'remotes.tracker_actor.forbid_actors',
  'remotes.customer_tracker_actor.forbid_actors',
  'command_log.scopes',
  'telemetry.skill_usage.scopes',
]);

// Integer fields with valid range constraints. Validated at `aiwg config set`.
// Bounds mirror the JSON schema (vscode-extension/schemas/aiwg.config.v1.json).
const INTEGER_FIELDS: Record<string, { min: number; max: number }> = {
  'parallelism.max_parallel_subagents': { min: 1, max: 50 },
  'parallelism.max_parallel_ralph_loops': { min: 1, max: 20 },
  'parallelism.max_parallel_mc_missions': { min: 1, max: 20 },
  'command_log.max_bytes': { min: 1024, max: 104_857_600 },
  'telemetry.skill_usage.max_bytes': { min: 1024, max: 104_857_600 },
};

async function projectConfigGet(key: string, args: string[]): Promise<void> {
  const { readAiwgConfig, getProjectDir } = await import('./aiwg-config.js');
  const projectDir = getProjectDir(undefined, args);
  const cfg = await readAiwgConfig(projectDir);
  if (!cfg) {
    throw new AiwgError({
      code: 'ERR_NO_PROJECT_CONFIG',
      message: 'No project AIWG config found at the resolved artifact root.',
      hint: 'Run `aiwg init`, then ask your AIWG agent to set up repo/tracker/delivery policy.',
      exitCode: EXIT_CODES.CONFIG,
    });
  }

  const value = getDottedPath(cfg as unknown as Record<string, unknown>, key);
  if (value === undefined) {
    console.log('(not set)');
  } else if (typeof value === 'object') {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(String(value));
  }
}

async function projectConfigSet(key: string, raw: string, args: string[]): Promise<void> {
  const {
    readAiwgConfig,
    writeAiwgConfig,
    getProjectDir,
    emptyConfig,
    validateExternalLinks,
  } = await import('./aiwg-config.js');
  const projectDir = getProjectDir(undefined, args);

  // Validate enum fields before writing. Deprecated spellings normalize forward with a
  // notice rather than failing, so a config written before a rename stays settable (#2532).
  const allowed = ENUM_RULES[key];
  const aliased = ENUM_ALIASES[key]?.[raw];
  if (aliased) {
    process.stderr.write(
      `Note: '${raw}' is a deprecated alias for '${aliased}'; writing '${aliased}'.\n`
      + (ENUM_ALIAS_NOTES[key] ? `      ${ENUM_ALIAS_NOTES[key]}\n` : ''),
    );
    raw = aliased;
  }
  if (allowed && !allowed.includes(raw)) {
    throw new AiwgError({
      code: 'ERR_INVALID_VALUE',
      message: `Invalid value for ${key}: '${raw}'. Allowed: ${allowed.join(', ')}`,
      hint: `Try: aiwg config set --project ${key} ${allowed[0]}`,
      exitCode: EXIT_CODES.USAGE,
    });
  }

  // Coerce booleans for known boolean fields
  let value: unknown = raw;
  if (/^externalLinks\.[^.]+$/.test(key) || key === 'security.threatAssessment') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new AiwgError({
        code: 'ERR_INVALID_VALUE',
        message: `${key} must be a valid JSON object`,
        hint: key === 'security.threatAssessment'
          ? `Try: aiwg config set --project ${key} '{"schemaVersion":"1","mode":"audit","defaultProfile":"balanced"}'`
          : `Try: aiwg config set --project ${key} '{"label":"Project docs","url":"https://example.com/docs"}'`,
        exitCode: EXIT_CODES.USAGE,
      });
    }
  }
  if (BOOLEAN_FIELDS.has(key)) {
    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else {
      throw new AiwgError({
        code: 'ERR_INVALID_VALUE',
        message: `${key} must be 'true' or 'false', got '${raw}'`,
        hint: `Try: aiwg config set --project ${key} true`,
        exitCode: EXIT_CODES.USAGE,
      });
    }
  }

  if (STRING_ARRAY_FIELDS.has(key)) {
    let items: unknown = raw.split(',');
    if (raw.trimStart().startsWith('[')) {
      try {
        items = JSON.parse(raw);
      } catch {
        items = undefined;
      }
      if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) {
        throw new AiwgError({
          code: 'ERR_INVALID_VALUE',
          message: `${key} must be a comma-separated list or a JSON array of strings`,
          hint: `Try: aiwg config set --project ${key} '["a","b"]' (or a,b)`,
          exitCode: EXIT_CODES.USAGE,
        });
      }
    }
    value = (items as string[]).map(item => item.trim()).filter(Boolean);
    if (key === 'command_log.scopes' || key === 'telemetry.skill_usage.scopes') {
      const invalid = (value as string[]).filter(item => item !== 'project' && item !== 'global');
      if (invalid.length > 0) {
        throw new AiwgError({
          code: 'ERR_INVALID_VALUE',
          message: `${key} supports only 'project' and 'global', got '${invalid.join(', ')}'`,
          hint: `Try: aiwg config set --project ${key} project,global`,
          exitCode: EXIT_CODES.USAGE,
        });
      }
    }
  }

  // Coerce + range-check integers for known integer fields (#1359).
  const intRule = INTEGER_FIELDS[key];
  if (intRule) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < intRule.min || n > intRule.max) {
      throw new AiwgError({
        code: 'ERR_INVALID_VALUE',
        message: `${key} must be an integer between ${intRule.min} and ${intRule.max}, got '${raw}'`,
        hint: `Try: aiwg config set --project ${key} ${intRule.min}`,
        exitCode: EXIT_CODES.USAGE,
      });
    }
    value = n;
  }

  // Read-modify-write — preserve unrelated fields. emptyConfig() seeds the
  // base shape when no config file exists yet (e.g. brand-new project).
  const cfg = (await readAiwgConfig(projectDir)) ?? emptyConfig();
  setDottedPath(cfg as unknown as Record<string, unknown>, key, value);
  const externalLinkErrors = validateExternalLinks(cfg.externalLinks);
  if (externalLinkErrors.length > 0) {
    throw new AiwgError({
      code: 'ERR_INVALID_VALUE',
      message: `Invalid external link configuration: ${externalLinkErrors.join('; ')}`,
      hint: 'Each link needs a stable key, non-empty label, and absolute HTTP(S) URL without embedded credentials.',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  const { validateThreatAssessmentConfig } = await import('../security/threat-assessment-config.js');
  const threatErrors = validateThreatAssessmentConfig(cfg.security?.threatAssessment);
  if (threatErrors.length > 0) {
    throw new AiwgError({
      code: 'ERR_INVALID_VALUE',
      message: `Invalid threat-assessment configuration: ${threatErrors.join('; ')}`,
      hint: 'Use a built-in profile or correct the referenced profile, rule pack, threshold, or regex.',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  await writeAiwgConfig(projectDir, cfg);
  console.log(`Set --project ${key} = ${raw}`);
}

/** Read a dotted path from a nested record. Returns undefined when any segment is missing. */
function getDottedPath(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Write a dotted path into a nested record, creating intermediate objects. */
function setDottedPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  const last = parts.pop()!;
  let cur: Record<string, unknown> = obj;
  for (const p of parts) {
    const next = cur[p];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[last] = value;
}

async function handleList(config: UserConfig): Promise<void> {
  const allConfig = await config.list();

  console.log(`Config directory: ${config.getPath()}\n`);

  for (const [filename, data] of Object.entries(allConfig)) {
    console.log(`── ${filename} ──`);
    if (typeof data === 'string') {
      console.log(data);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
    console.log('');
  }
}

async function handleValidate(config: UserConfig, args: string[]): Promise<void> {
  if (args.includes('--project')) {
    await handleProjectValidate(args);
    return;
  }
  const issues = await config.validate();

  console.log(`Config directory: ${config.getPath()}\n`);

  if (issues.length === 0) {
    console.log('✓ All config files valid');
    return;
  }

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  const infos = issues.filter(i => i.severity === 'info');

  for (const issue of issues) {
    const icon = issue.severity === 'error' ? '✗' : issue.severity === 'warning' ? '!' : 'i';
    console.log(`  ${icon} [${issue.file}] ${issue.message}`);
  }

  console.log('');
  console.log(`${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info`);

  if (errors.length > 0) {
    throw new AiwgError({
      code: 'ERR_CONFIG_VALIDATION',
      message: `Config validation failed with ${errors.length} error(s)`,
      hint: 'Fix the errors listed above, or run: aiwg config edit',
      exitCode: EXIT_CODES.CONFIG,
    });
  }
}

async function handleProjectValidate(args: string[]): Promise<void> {
  const {
    getProjectDir,
    readAiwgConfig,
    resolveIssueLabels,
    validateExternalLinks,
    validateIndexConfig,
    validateIssueLabels,
  } = await import('./aiwg-config.js');
  const projectDir = getProjectDir(undefined, args);
  const cfg = await readAiwgConfig(projectDir);
  if (!cfg) {
    throw new AiwgError({
      code: 'ERR_NO_PROJECT_CONFIG',
      message: 'No project AIWG config found at the resolved artifact root.',
      hint: 'Run `aiwg init`, then configure project policy.',
      exitCode: EXIT_CODES.CONFIG,
    });
  }

  const providerIndex = args.indexOf('--provider');
  const providerArg = providerIndex >= 0 ? args[providerIndex + 1] : undefined;
  const allowedProviders = ['gitea', 'github', 'local'] as const;
  if (providerArg && !allowedProviders.includes(providerArg as typeof allowedProviders[number])) {
    throw new AiwgError({
      code: 'ERR_INVALID_VALUE',
      message: `Unsupported issue label provider '${providerArg}'.`,
      hint: 'Use --provider gitea, --provider github, or --provider local.',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  const provider = providerArg as typeof allowedProviders[number] | undefined;
  const availableLabels: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--available-label' && args[i + 1]) availableLabels.push(args[++i]);
  }

  const indexErrors = validateIndexConfig(cfg.index).map((message) => ({
    severity: 'error' as const,
    code: 'index',
    message,
  }));
  const externalLinkErrors = validateExternalLinks(cfg.externalLinks).map((message) => ({
    severity: 'error' as const,
    code: 'external-links',
    message,
  }));
  const labelDiagnostics = provider
    ? validateIssueLabels(cfg.issues, {
        provider,
        ...(availableLabels.length ? { availableLabels } : {}),
      })
    : cfg.issues?.labels
      ? validateIssueLabels(cfg.issues)
      : resolveIssueLabels(undefined, 'local').diagnostics;
  const diagnostics = [...indexErrors, ...externalLinkErrors, ...labelDiagnostics];

  console.log(`Project config: ${projectControlPath(projectDir, 'aiwg.config')}`);
  console.log(`Artifact root:  ${resolveProjectAiwgDir(projectDir)}\n`);
  if (diagnostics.length === 0) {
    console.log('✓ Project config valid');
    return;
  }
  for (const diagnostic of diagnostics) {
    const icon = diagnostic.severity === 'error' ? '✗' : '!';
    console.log(`  ${icon} [${diagnostic.code}] ${diagnostic.message}`);
  }
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
  if (errors.length) {
    throw new AiwgError({
      code: 'ERR_CONFIG_VALIDATION',
      message: `Project config validation failed with ${errors.length} error(s)`,
      hint: 'Fix the reported taxonomy or index configuration. Missing tracker labels must be provisioned explicitly.',
      exitCode: EXIT_CODES.CONFIG,
    });
  }
}

async function handleReset(config: UserConfig, args: string[]): Promise<void> {
  const isProject = args.includes('--project');
  const positional = args.filter(a => a !== '--project');
  const key = positional[0];

  if (isProject) {
    await projectConfigReset(key, args);
    return;
  }

  if (key) {
    await config.reset(key);
    console.log(`Reset ${key} to default`);
  } else {
    await config.reset();
    console.log('Reset all config to defaults');
  }
}

/**
 * Reset a project-config key to its provider-aware default.
 *
 * Currently scoped to the `parallelism` block (#1359). Resetting
 * `parallelism` (no field suffix) restores the block to the primary
 * provider's defaults. Resetting a specific field like
 * `parallelism.max_parallel_subagents` restores just that field.
 */
async function projectConfigReset(key: string | undefined, args: string[]): Promise<void> {
  const {
    readAiwgConfig,
    writeAiwgConfig,
    getProjectDir,
    getProviderParallelismDefaults,
  } = await import('./aiwg-config.js');

  if (!key) {
    throw new AiwgError({
      code: 'ERR_USAGE_MISSING_ARG',
      message: 'aiwg config reset --project requires a key',
      hint: 'Example: aiwg config reset --project parallelism',
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const projectDir = getProjectDir(undefined, args);
  const cfg = await readAiwgConfig(projectDir);
  if (!cfg) {
    throw new AiwgError({
      code: 'ERR_NO_PROJECT_CONFIG',
      message: 'No project AIWG config found at the resolved artifact root.',
      hint: 'Run `aiwg init`, then ask your AIWG agent to establish project policy.',
      exitCode: EXIT_CODES.CONFIG,
    });
  }

  const primary = cfg.providers[0];
  const defaults = getProviderParallelismDefaults(primary);

  if (key === 'parallelism') {
    cfg.parallelism = {
      max_parallel_subagents: defaults.max_parallel_subagents,
      max_parallel_ralph_loops: defaults.max_parallel_ralph_loops,
      max_parallel_mc_missions: defaults.max_parallel_mc_missions,
      rationale: `Reset to provider default for ${primary ?? 'unknown'}`,
    };
    await writeAiwgConfig(projectDir, cfg);
    console.log(`Reset --project parallelism to provider default (${primary ?? 'unknown'})`);
    return;
  }

  if (key.startsWith('parallelism.')) {
    const field = key.slice('parallelism.'.length) as keyof typeof defaults;
    if (field in defaults) {
      cfg.parallelism = cfg.parallelism ?? {};
      (cfg.parallelism as Record<string, unknown>)[field] = defaults[field];
      await writeAiwgConfig(projectDir, cfg);
      console.log(`Reset --project ${key} to provider default (${defaults[field]})`);
      return;
    }
  }

  throw new AiwgError({
    code: 'ERR_INVALID_KEY',
    message: `Reset for project key '${key}' is not supported.`,
    hint: 'Supported: parallelism, parallelism.max_parallel_subagents, parallelism.max_parallel_ralph_loops, parallelism.max_parallel_mc_missions',
    exitCode: EXIT_CODES.USAGE,
  });
}

function handlePath(config: UserConfig): void {
  console.log(config.getPath());
}

async function handleEdit(config: UserConfig): Promise<void> {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const configPath = `${config.getPath()}/config.yaml`;

  // Ensure the config file exists before opening
  await config.ensureDir();

  const { execSync } = await import('child_process');
  try {
    execSync(`${editor} "${configPath}"`, { stdio: 'inherit' });
  } catch (err) {
    throw new AiwgError({
      code: 'ERR_EDITOR_FAILED',
      message: `Failed to open editor: ${editor}`,
      hint: 'Set EDITOR or VISUAL to a valid editor binary, or edit the file directly',
      exitCode: EXIT_CODES.GENERAL,
      cause: err,
    });
  }
}

/**
 * `aiwg config show --project [--json]` — print the resolved project-level
 * .aiwg/aiwg.config (#999).
 *
 * Without `--project`, prints a hint pointing at `list` (user config) or
 * `show --project` (project config). Project mode resolves the remotes block
 * via the same defaults the rest of AIWG uses (origin → primary → issue/ci).
 */
async function handleShow(args: string[]): Promise<void> {
  const isProject = args.includes('--project');
  const isJson = args.includes('--json');

  if (!isProject) {
    console.log(`aiwg config show requires a scope flag.

For user-level config:    aiwg config list
For project-level config: aiwg config show --project [--json]
`);
    throw new AiwgError({
      code: 'ERR_USAGE_MISSING_FLAG',
      message: 'aiwg config show requires --project (or use `aiwg config list` for user config)',
      hint: 'Try: aiwg config show --project',
      exitCode: EXIT_CODES.USAGE,
    });
  }

  // Lazy-import to keep startup cost low for unrelated subcommands.
  const { readAiwgConfig, resolveRemotes, getProjectDir } = await import('./aiwg-config.js');
  const { spawnSync } = await import('child_process');

  const projectDir = getProjectDir(undefined, args);
  const cfg = await readAiwgConfig(projectDir);

  if (!cfg) {
    throw new AiwgError({
      code: 'ERR_NO_PROJECT_CONFIG',
      message: 'No project AIWG config found at the resolved artifact root.',
      hint: 'Run `aiwg init`, then ask your AIWG agent to set up repo/tracker/delivery policy.',
      exitCode: EXIT_CODES.CONFIG,
    });
  }

  const resolvedRemotes = resolveRemotes(cfg.remotes);

  // Resolve each declared remote name to its URL via git. Best-effort.
  function getUrl(name: string): string | null {
    const r = spawnSync('git', ['-C', projectDir, 'remote', 'get-url', name], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.status !== 0) return null;
    const out = r.stdout?.toString().trim();
    return out || null;
  }

  const remotesView = {
    primary: { name: resolvedRemotes.primary, url: getUrl(resolvedRemotes.primary) },
    issue_tracker: { name: resolvedRemotes.issue_tracker, url: getUrl(resolvedRemotes.issue_tracker) },
    customer_issue_tracker: resolvedRemotes.customer_issue_tracker
      ? { name: resolvedRemotes.customer_issue_tracker, url: getUrl(resolvedRemotes.customer_issue_tracker) }
      : null,
    ci: { name: resolvedRemotes.ci, url: getUrl(resolvedRemotes.ci) },
    secondary: resolvedRemotes.secondary.map((s) => ({
      ...s,
      url: getUrl(s.name),
    })),
    has_remotes_block: !!cfg.remotes,
  };

  if (isJson) {
    console.log(JSON.stringify({
      project_dir: projectDir,
      version: cfg.version,
      providers: cfg.providers,
      installed: cfg.installed,
      scripts: cfg.scripts,
      externalLinks: cfg.externalLinks ?? {},
      remotes: remotesView,
    }, null, 2));
    return;
  }

  // Human-readable view
  console.log(`Project config: ${projectControlPath(projectDir, 'aiwg.config')}`);
  console.log(`Artifact root:  ${resolveProjectAiwgDir(projectDir)}\n`);
  console.log(`Schema version: ${cfg.version}`);
  console.log(`Providers:      ${cfg.providers.join(', ') || '(none)'}`);
  console.log('');
  console.log('Installed frameworks:');
  const installed = Object.entries(cfg.installed);
  if (installed.length === 0) {
    console.log('  (none)');
  } else {
    for (const [name, entry] of installed) {
      const providers = Object.keys(entry.deployedTo).join(', ') || '(no targets)';
      console.log(`  - ${name} v${entry.version} → ${providers}`);
    }
  }
  console.log('');
  console.log('External links:');
  const externalLinks = Object.entries(cfg.externalLinks ?? {});
  if (externalLinks.length === 0) {
    console.log('  (none)');
  } else {
    for (const [key, link] of externalLinks) {
      const metadata = [link.category, link.audience].filter(Boolean).join(', ');
      console.log(`  - ${key}: ${link.label} — ${link.url}${metadata ? ` [${metadata}]` : ''}`);
      if (link.description) console.log(`    ${link.description}`);
    }
  }
  console.log('');
  console.log('Remote topology:');
  if (!remotesView.has_remotes_block) {
    console.log('  (no `remotes` block — defaults: origin is primary, issue tracker, and CI)');
  }
  const fmt = (label: string, ref: { name: string; url: string | null }) => {
    const u = ref.url ? ` (${ref.url})` : ' (no such remote in `git remote`)';
    return `  ${label}: ${ref.name}${u}`;
  };
  console.log(fmt('Primary       ', remotesView.primary));
  if (remotesView.issue_tracker.name !== remotesView.primary.name) {
    console.log(fmt('Internal issues', remotesView.issue_tracker));
  }
  if (remotesView.customer_issue_tracker) {
    console.log(fmt('Customer issues', remotesView.customer_issue_tracker));
  }
  if (remotesView.ci.name !== remotesView.primary.name) {
    console.log(fmt('CI            ', remotesView.ci));
  }
  for (const sec of remotesView.secondary) {
    const purpose = sec.purpose ? ` — ${sec.purpose}` : '';
    const release = sec.push_on_release ? ' [push tags on release]' : '';
    const u = sec.url ? ` (${sec.url})` : ' (no such remote in `git remote`)';
    console.log(`  Secondary     : ${sec.name}${u}${purpose}${release}`);
  }
  console.log('');
}

async function handleGitignore(args: string[]): Promise<void> {
  const { spawnSync } = await import('child_process');
  // Locate the gitignore CLI script relative to this compiled module
  // (#1228). At runtime this module lives at `dist/src/config/cli.js`,
  // so we need three `..` segments to reach the package root where
  // `tools/cli/` is shipped (see package.json `files`).
  const scriptPath = path.resolve(_scriptDir, '../../../tools/cli/config-gitignore.mjs');
  const result = spawnSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function printUsage(): void {
  console.log(`Usage: aiwg config <subcommand> [options]

Subcommands:
  get <key>                       Read a user config value
  get --project <key>             Read a project config value (default .aiwg/aiwg.config;
                                  AIWG_ARTIFACTS_PATH may override the artifact root)
  set <key> <value>               Write a user config value
  set --project <key> <value>     Write a project config value (validates enums)
  list                Show all user config
  show --project      Show resolved project config and artifact root
  validate            Validate user config files
  validate --project  Validate resolved project config taxonomy/index semantics
    [--provider gitea|github|local] [--available-label NAME ...]
  reset [<key>]       Reset key or all config to defaults
  path                Print config directory path
  edit                Open config in $EDITOR
  gitignore           Show/check/fix .gitignore AIWG entries

Global flags:
  --config-dir <path> Override config directory

Examples:
  aiwg config get defaults.provider
  aiwg config set defaults.verbosity quiet
  aiwg config set updates.channel next
  aiwg config list
  aiwg config show --project
  aiwg config show --project --json
  aiwg config get --project delivery.mode
  aiwg config set --project delivery.mode pr-required
  aiwg config set --project delivery.merge_style squash
  aiwg config get --project parallelism
  aiwg config set --project parallelism.max_parallel_subagents 6
  aiwg config reset --project parallelism
  aiwg config validate
  aiwg config path
  aiwg config reset defaults.provider
  aiwg config --config-dir /custom/path list
  aiwg config gitignore
  aiwg config gitignore --fix
  aiwg config gitignore --check`);
}
