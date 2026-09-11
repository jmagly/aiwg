/**
 * Use Command Handler
 *
 * Deploys AIWG frameworks (SDLC, Marketing, Writing) to the current project.
 * After deployment, registers deployed extensions in the extension registry.
 *
 * @implements @.aiwg/architecture/decisions/ADR-001-unified-extension-system.md
 * @implements #56, #57
 * @source @src/cli/router.ts
 * @issue #33
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'node:url';
import { resolveOmpPaths } from '../../providers/omp-paths.mjs';
import YAML from 'yaml';
import { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { createScriptRunner } from './script-runner.js';
import { getFrameworkRoot, getVersionInfo } from '../../channel/manager.mjs';
import { getRegistry } from '../../extensions/registry.js';
import { registerDeployedExtensions } from '../../extensions/deployment-registration.js';
import {
  loadCliCommandsContribution,
  registerCliCommands,
  registerHooks,
} from '../cli-extension-loader.js';
import { translateSkillsToCommands, providerNeedsCommands } from '../../plugin/skill-command-translator.js';
import * as ui from '../ui.js';
import { readAiwgConfig, writeAiwgConfig, updateInstalled, hashManifest, emptyConfig, getProjectDir } from '../../config/aiwg-config.js';
import { appendGitignore } from '../../config/gitignore.js';
import { getLogger } from '../log.js';
import { installCockpit } from './cockpit.js';
import { initHandler } from './init.js';
import {
  checkCollisions,
  formatCollisionReport,
  hasBlockingCollisions,
} from '../../smiths/skillsmith/collision-detector.js';
import {
  discoverProjectLocalBundles,
  type ProjectLocalBundle,
} from '../../extensions/project-local-discovery.js';
import { PROJECT_LOCAL_TYPE_TO_DIR } from '../../extensions/project-local-paths.js';
import { buildUpstreamRegistry } from '../../extensions/upstream-registry.js';
import {
  resolveShadows,
  formatShadowReport,
} from '../../extensions/shadow-resolver.js';
import {
  appendProjectLocalActivity,
  emitDiscoverEventsDeduped,
} from '../../extensions/project-local-activity.js';
import {
  hashBundleArtifacts,
  hashDeployedBundleArtifacts,
} from '../../extensions/project-local-remove.js';
import { installAiwgHooks } from '../../extensions/claude-hooks-installer.js';
import {
  detectScope,
  mirrorToUserScope,
  rejectOpenClawProjectScope,
  USER_SCOPE_PATHS,
} from '../scope-resolver.js';
import { maybeWarnProjectIsolation } from '../project-isolation/index.js';
import {
  formatWorkspaceSignalPlan,
  includedBundleIds,
  resolveWorkspaceSignalPlan,
  writeWorkspaceSignalPlan,
} from '../workspace-signals.js';
import {
  getProviderArtifactPathStrings,
  getProviderDefinition,
  getProviderKernelSkillPath,
  normalizeProviderDefinitionId,
  type ProviderArtifactPathStrings,
} from '../../providers/provider-definitions.js';

// Module-level guard so the iteration loops further down (which re-enter
// execute() per framework/provider) don't re-emit the warning each pass.
// Reset is not needed: a single CLI process is one user invocation.
let projectIsolationChecked = false;
// Non-zero only while the outer `aiwg use --json` orchestration wrapper is
// collecting child-process output. The CLI is single-command-per-process;
// recursive provider expansion shares this guard intentionally.
let machineReadableUseDepth = 0;
// Context-pipeline: emits WORKSPACE.md + AIWG.md + provider adapters last.
// for non-Claude providers per ADR-1 (.aiwg/architecture/adr-agents-md-aggregation.md).
// Distinct from agentsmith (which creates subagent personas).
import {
  generate as generateContextFiles,
  discoverDeployedArtifacts,
} from '../../smiths/context-pipeline/index.js';
import type { Platform } from '../../agents/types.js';
import { verifyModelWrapperDeployment } from '../../models/wrapper-deployment.js';
import { loadGraphIndexFile } from '../../artifacts/index-reader.js';
import type { ArtifactIndex } from '../../artifacts/types.js';
import {
  aggregateUseDeploymentResult,
  buildDryRunUseResult,
  renderUseDeploymentResult,
  verifyProviderDeployment,
  type DeploymentScope,
  type UseDeploymentResult,
} from '../services/deployment-verification.js';
import {
  finalizeProviderTransformationReceipt,
  providerReceiptHasLocalSources,
  sourceVerificationsFromSignedWebRelease,
} from '../../providers/transformation-receipt-integration.js';
import {
  loadResourceTrustRootFile,
  resolveWebRelease,
  type WebReleaseOptions,
} from '../../resources/web-release.js';
import { createResourceCredentialProvider } from '../../auth/resource-credentials.js';

/**
 * Valid framework identifiers
 */
const VALID_FRAMEWORKS = ['sdlc', 'marketing', 'media-curator', 'research', 'forensics', 'dfir', 'security-engineering', 'ops', 'validation', 'knowledge-base', 'writing', 'general', 'all'] as const;
type Framework = typeof VALID_FRAMEWORKS[number];

function providerReceiptWebReleaseOptions(): Omit<WebReleaseOptions, 'selector' | 'offline'> {
  const baseUrl = process.env.AIWG_RESOURCE_BASE_URL;
  const cacheRoot = process.env.AIWG_RESOURCE_CACHE_ROOT;
  const trustRootFile = process.env.AIWG_RESOURCE_TRUST_ROOT_FILE;
  const publicKeyPem = trustRootFile === undefined
    ? undefined
    : loadResourceTrustRootFile(path.resolve(trustRootFile));
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(cacheRoot === undefined ? {} : { cacheRoot }),
    ...(publicKeyPem === undefined ? {} : { publicKeyPem }),
    ...(process.env.AIWG_RESOURCE_ALLOW_INSECURE_LOOPBACK_HTTP === '1'
      ? { allowInsecureLoopbackHttp: true }
      : {}),
  };
}

function releaseResourceUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|request timed out|no fetch implementation/i.test(message);
}

export async function resolveProviderReceiptSource(options: {
  projectRoot: string;
  frameworkRoot: string;
  provider: string;
  scope: DeploymentScope;
  requestedBundles: string[];
}): Promise<{
  sourceVerifications?: Readonly<Record<string, import('../../security/artifact-verifier.js').ArtifactVerificationResult>>;
  sourceDisposition?: 'local-source' | 'source-unavailable' | 'verification-failed';
}> {
  if (await providerReceiptHasLocalSources(options)) return { sourceDisposition: 'local-source' };
  const versionInfo = await getVersionInfo();
  if (versionInfo.devMode) return { sourceDisposition: 'local-source' };
  const releaseOptions = providerReceiptWebReleaseOptions();
  let release;
  try {
    release = await resolveWebRelease({ ...releaseOptions, selector: versionInfo.version, offline: true });
  } catch {
    const credentialProvider = createResourceCredentialProvider(process.env);
    const token = await credentialProvider();
    // Protected production resources require the authenticated release
    // credential. A configured alternate endpoint may intentionally be public.
    if (!token && releaseOptions.baseUrl === undefined) return { sourceDisposition: 'source-unavailable' };
    try {
      release = await resolveWebRelease({
        ...releaseOptions,
        selector: versionInfo.version,
        credentialProvider: async () => token,
      });
    } catch (error) {
      if (releaseResourceUnavailable(error)) return { sourceDisposition: 'source-unavailable' };
      throw error;
    }
  }
  const verifications = await sourceVerificationsFromSignedWebRelease(options, release);
  return Object.keys(verifications).length > 0
    ? { sourceVerifications: verifications }
    : { sourceDisposition: 'verification-failed' };
}

/**
 * Framework name to deploy mode mapping.
 * Mode is passed as `--mode <value>` to deploy-agents.mjs, which resolves
 * to the actual framework via discoverFrameworks() + modeAliases.
 */
const MODE_MAP: Record<Framework, string> = {
  sdlc: 'sdlc',
  marketing: 'marketing',
  'media-curator': 'media-curator',
  research: 'research',
  forensics: 'forensics',
  dfir: 'dfir',
  'security-engineering': 'security-engineering',
  ops: 'ops-complete',      // ops-complete manifest id is 'ops-complete' (modeAlias: ops)
  validation: 'validation-complete',
  'knowledge-base': 'knowledge-base',
  writing: 'general',
  general: 'general',
  all: 'all',
};

const MODEL_DEPLOY_VALUE_FLAGS = new Set([
  '--model', '--reasoning-model', '--coding-model', '--efficiency-model',
  '--model-tier', '--filter', '--filter-role',
]);
const MODEL_OVERRIDE_VALUE_FLAGS = new Set([
  '--model', '--reasoning-model', '--coding-model', '--efficiency-model', '--model-tier',
]);
const MODEL_DEPLOY_BOOLEAN_FLAGS = new Set(['--save', '--save-user']);
export function collectUseModelDeployArgs(args: string[]): string[] {
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (MODEL_DEPLOY_BOOLEAN_FLAGS.has(args[i])) forwarded.push(args[i]);
    else if (MODEL_DEPLOY_VALUE_FLAGS.has(args[i]) && args[i + 1]) {
      forwarded.push(args[i], args[++i]);
    }
  }
  return forwarded;
}

export function collectModelOverrideDeployArgs(args: string[]): string[] {
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (MODEL_OVERRIDE_VALUE_FLAGS.has(args[i]) && args[i + 1]) {
      forwarded.push(args[i], args[++i]);
    }
  }
  return forwarded;
}

type WrapperRole = 'reasoning' | 'coding' | 'efficiency';
type DeployModelsConfig = Record<string, any>;

async function loadDeployModelsConfig(frameworkRoot: string): Promise<DeployModelsConfig> {
  const candidates = [
    path.join(process.cwd(), 'models.json'),
    path.join(os.homedir(), '.config', 'aiwg', 'models.json'),
    path.join(frameworkRoot, 'agentic/code/frameworks/sdlc-complete/config/models.json'),
  ];
  for (const file of candidates) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) as DeployModelsConfig; }
    catch { /* try the next deployment-precedence location */ }
  }
  return {
    shorthand: {
      opus: 'claude-opus-4-6',
      sonnet: 'claude-sonnet-4-6',
      haiku: 'claude-haiku-4-5-20251001',
      inherit: 'inherit',
    },
    claude_shorthand: { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku', inherit: 'inherit' },
  };
}

function deployArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function resolveDeployModelAlias(
  value: string,
  provider: string,
  role: WrapperRole,
  config: DeployModelsConfig,
): string {
  const clean = value.toLowerCase().replace(/['"]/g, '');
  const shorthand = config[`${provider}_shorthand`] ?? config.shorthand ?? {};
  if (typeof shorthand[clean] === 'string') return shorthand[clean];
  const tierModel = config[provider]?.[role]?.model;
  if (clean === role && typeof tierModel === 'string') return tierModel;
  return value;
}

export function resolveUseWrapperModelExpectations(options: {
  provider: string;
  modelDeployArgs: string[];
  catalogModels: Record<WrapperRole, string>;
  modelsConfig: DeployModelsConfig;
}): Record<WrapperRole, string> {
  const roles: WrapperRole[] = ['reasoning', 'coding', 'efficiency'];
  let blanket = deployArgValue(options.modelDeployArgs, '--model');
  const tier = deployArgValue(options.modelDeployArgs, '--model-tier');
  if (tier) {
    const tierRole: WrapperRole | null = tier === 'economy' ? 'efficiency'
      : tier === 'standard' ? 'coding'
        : tier === 'premium' || tier === 'max-quality' ? 'reasoning' : null;
    if (tierRole) blanket = options.catalogModels[tierRole];
  }
  return Object.fromEntries(roles.map(role => {
    const override = deployArgValue(options.modelDeployArgs, `--${role}-model`) ?? blanket;
    return [role, override
      ? resolveDeployModelAlias(override, options.provider, role, options.modelsConfig)
      : options.catalogModels[role]];
  })) as Record<WrapperRole, string>;
}

/**
 * Framework name to actual directory name under agentic/code/frameworks/.
 * Used for path construction in collision checks, CI hooks, and version tracking.
 * Frameworks without a dedicated directory (writing, general) map to undefined —
 * those code paths are skipped gracefully.
 */
const FRAMEWORK_DIR_MAP: Partial<Record<string, string>> = {
  sdlc: 'sdlc-complete',
  marketing: 'media-marketing-kit',
  'media-curator': 'media-curator',
  research: 'research-complete',
  forensics: 'forensics-complete',
  dfir: 'forensics-complete',
  'security-engineering': 'security-engineering',
  ops: 'ops-complete',
  validation: 'validation-complete',
  'knowledge-base': 'knowledge-base',
  // 'writing' and 'general' have no backing framework directory
  // 'all' falls back to sdlc for manifest/CI purposes
  all: 'sdlc-complete',
};

/** Resolve actual framework directory name for a given user-facing name. */
function resolveFrameworkDir(framework: string): string | undefined {
  return FRAMEWORK_DIR_MAP[framework];
}

/**
 * Addons excluded from `aiwg use all`.
 * aiwg-dev is contributor-only tooling — not for end users.
 */
export const USE_ALL_DISALLOW = new Set(['aiwg-dev']);

/** Full-framework setup requires the corpus omitted by the lightweight CLI. */
async function bundledSetupPrerequisiteMessage(frameworkRoot: string): Promise<string | undefined> {
  let packageName: string | undefined;
  try {
    packageName = JSON.parse(await fs.readFile(path.join(frameworkRoot, 'package.json'), 'utf8')).name;
  } catch {
    // Embedded callers and source fixtures need not have package metadata.
    return undefined;
  }
  if (packageName !== '@aiwg/cli') return undefined;

  const hasCorpus = (await Promise.all(['frameworks', 'addons'].map(async (kind) => {
    try {
      return (await fs.stat(path.join(frameworkRoot, 'agentic/code', kind))).isDirectory();
    } catch {
      return false;
    }
  }))).every(Boolean);
  if (hasCorpus) return undefined;

  return [
    'Bundled framework setup requires the full aiwg package. This @aiwg/cli installation does not include framework and addon sources.',
    'Replace the lightweight global package, then rerun your setup command:',
    '  npm uninstall -g @aiwg/cli',
    '  npm install -g aiwg',
    '@aiwg/cli can still query signed web resources and deploy external project-local bundles.',
  ].join('\n');
}

/**
 * Discover all addon names from the filesystem, minus the disallow list.
 */
export async function getAllAddons(frameworkRoot: string): Promise<string[]> {
  const addonsDir = path.join(frameworkRoot, 'agentic/code/addons');
  const entries = await fs.readdir(addonsDir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && !USE_ALL_DISALLOW.has(e.name))
    .map(e => e.name);
}

/**
 * Extensions excluded from `aiwg use all` deployment.
 * `api-adapter` is an OpenAPI spec, not a deployable artifact bundle.
 */
export const USE_ALL_EXTENSIONS_DISALLOW = new Set(['api-adapter']);

/**
 * Discover all extension names from `agentic/code/extensions/*` (#1221).
 *
 * Extensions are addon-shaped bundles with their own `manifest.json`,
 * `skills/`, `rules/`, and `templates/` directories. Only directories
 * containing a `manifest.json` are considered deployable; bare directories
 * (e.g. `api-adapter` which only ships an OpenAPI spec) are skipped.
 */
export async function getAllExtensions(frameworkRoot: string): Promise<string[]> {
  const extensionsDir = path.join(frameworkRoot, 'agentic/code/extensions');
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(extensionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (USE_ALL_EXTENSIONS_DISALLOW.has(entry.name)) continue;
    const manifestPath = path.join(extensionsDir, entry.name, 'manifest.json');
    try {
      await fs.access(manifestPath);
      result.push(entry.name);
    } catch {
      // Directory without a manifest is not deployable as an extension.
      continue;
    }
  }
  return result;
}

/**
 * Resolve extension source path from its name.
 */
export function extensionPath(frameworkRoot: string, name: string): string {
  return path.join(frameworkRoot, 'agentic/code/extensions', name);
}

/**
 * Check whether a given addon name exists on disk.
 * The USE_ALL_DISALLOW list does NOT block explicit single-addon installs —
 * contributors can still run `aiwg use aiwg-dev` directly.
 */
/** Resolve canonical addon folder name from user-supplied alias. */
function resolveAddonFolderName(name: string): string {
  const ADDON_ALIASES: Record<string, string> = {
    // ring-methodology has always been invokable as 'ring'
    'ring': 'ring-methodology',
    // agent-loop addon — 'al' and 'ralph' are legacy aliases
    'al': 'agent-loop',
    'ralph': 'agent-loop',
  };
  return ADDON_ALIASES[name] ?? name;
}

export async function isValidAddon(frameworkRoot: string, name: string): Promise<boolean> {
  try {
    const folderName = resolveAddonFolderName(name);
    const stat = await fs.stat(path.join(frameworkRoot, 'agentic/code/addons', folderName));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve addon source path from its name.
 * Handles known aliases (ring, al, agent-loop).
 */
export function addonPath(frameworkRoot: string, name: string): string {
  const folderName = resolveAddonFolderName(name);
  return path.join(frameworkRoot, 'agentic/code/addons', folderName);
}

/**
 * Resolve a selected addon's required addon dependencies in deterministic
 * dependency-first order. Optional dependencies remain descriptive and are
 * never activated implicitly.
 */
export async function resolveRequiredAddonActivationOrder(
  frameworkRoot: string,
  selectedAddon: string,
): Promise<string[]> {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];

  const visit = async (requestedName: string, ancestry: string[]): Promise<void> => {
    const name = resolveAddonFolderName(requestedName);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(`Invalid required addon identifier '${requestedName}'`);
    }
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Required addon dependency cycle: ${[...ancestry, name].join(' -> ')}`);
    }
    const source = addonPath(frameworkRoot, name);
    let manifest: { id?: unknown; dependencies?: { required?: unknown } };
    try {
      manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
    } catch (error) {
      throw new Error(
        `Cannot load required addon '${name}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (manifest.id !== name) {
      throw new Error(`Required addon manifest identity mismatch: expected '${name}'`);
    }
    const required = manifest.dependencies?.required ?? [];
    if (!Array.isArray(required) || required.some(item => typeof item !== 'string')) {
      throw new Error(`Addon '${name}' has an invalid dependencies.required declaration`);
    }

    visiting.add(name);
    for (const dependency of [...required].sort()) {
      const dependencyName = resolveAddonFolderName(dependency as string);
      if (!await isValidAddon(frameworkRoot, dependencyName)) {
        throw new Error(`Addon '${name}' requires unavailable addon '${dependencyName}'`);
      }
      await visit(dependencyName, [...ancestry, name]);
    }
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  };

  await visit(selectedAddon, []);
  return order;
}

async function registerSourceCliCommands(opts: {
  source: string;
  target: string;
  provider: string;
  dryRun: boolean;
  fallbackDescription: string;
}): Promise<number> {
  const contribution = await loadCliCommandsContribution(opts.source);
  if (!contribution) return 0;

  const { manifest, commandsSource } = contribution;
  const count = Object.keys(manifest.subcommands).length;
  if (opts.dryRun) {
    ui.dim(`  [dry-run] Would register CLI namespace '${manifest.namespace}' (${count} subcommands)`);
    return count;
  }

  await registerCliCommands(
    opts.target,
    manifest.namespace,
    manifest.description || opts.fallbackDescription,
    commandsSource,
    manifest.subcommands,
  );
  ui.success(`CLI namespace '${manifest.namespace}' registered (${count} subcommands)`);

  if (opts.provider === 'claude') {
    const registeredHooks = await registerHooks(
      opts.target,
      manifest.namespace,
      manifest.subcommands,
    );
    for (const hook of registeredHooks) ui.success(`Hook registered: ${hook}`);
  }
  return count;
}

function getProviderPaths(provider: string): ProviderArtifactPathStrings {
  const paths = getProviderArtifactPathStrings(provider) ?? getProviderArtifactPathStrings('claude');
  if (!paths) throw new Error(`Missing provider paths for ${provider}`);
  return paths;
}

function getProviderKernelSkillsPath(provider: string): string {
  return getProviderKernelSkillPath(provider) || getProviderKernelSkillPath('claude');
}

const PROVIDER_GENERATED_GITIGNORE_PATTERNS: Record<string, string[]> = {
  codex: ['.codex/', '.agents/'],
};

async function ensureProviderGeneratedDirsIgnored(
  projectRoot: string,
  provider: string,
  opts: { dryRun: boolean; verbose: boolean },
): Promise<void> {
  if (opts.dryRun) return;

  const patterns = PROVIDER_GENERATED_GITIGNORE_PATTERNS[provider];
  if (!patterns || patterns.length === 0) return;

  try {
    const result = await appendGitignore(projectRoot, patterns);
    if (opts.verbose && result.added.length > 0) {
      ui.dim(`  Gitignore: added ${result.added.join(', ')}`);
    }
  } catch (error) {
    ui.warn(`Failed to update .gitignore for generated ${provider} artifacts: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const MIRRORED_STANDARD_COMMAND_SKILLS = new Set([
  'aiwg-setup-project',
  'aiwg-update-claude',
  'aiwg-update-agents-md',
  'sdlc-accelerate',
  'project-status',
  'intake-wizard',
  'intake-from-codebase',
  'intake-start',
  // Issue-workflow entry commands — invoked directly by users; mirror as
  // commands so they reach .opencode/command/, .claude/commands/, etc. (#1549).
  'address-issues',
  'issue-audit',
]);

const MIRRORED_KERNEL_COMMAND_SKILLS = new Set([
  'aiwg-refresh',
  'aiwg-doctor',
  'aiwg-status',
  'aiwg-help',
  'aiwg-regenerate',
  'aiwg-regenerate-claude',
  'aiwg-regenerate-codex',
  'aiwg-regenerate-opencode',
  'aiwg-regenerate-agents',
  'aiwg-issue',
  'aiwg-pr',
  'aiwg-delivery-pr',
  'aiwg-mission',
  'use',
  'steward',
]);

function shouldMirrorStandardCommandSkill(skillName: string): boolean {
  return skillName.startsWith('flow-') || MIRRORED_STANDARD_COMMAND_SKILLS.has(skillName);
}

function shouldMirrorKernelCommandSkill(skillName: string): boolean {
  return MIRRORED_KERNEL_COMMAND_SKILLS.has(skillName);
}

function resolveProviderPath(target: string, providerPath: string): string {
  return path.isAbsolute(providerPath) ? providerPath : path.join(target, providerPath);
}

async function validateDeployedModelWrappers(options: {
  provider: string;
  target: string;
  frameworkRoot: string;
  modelDeployArgs: string[];
  filtered: boolean;
  verbose: boolean;
}): Promise<HandlerResult | null> {
  const paths = getProviderPaths(options.provider);
  const agentsPath = paths.agents ? resolveProviderPath(options.target, paths.agents) : null;
  const { collectProviderInventory } = await import('../../providers/provider-inventory.js');
  const { resolveDynamicModelCatalog } = await import('../../models/model-discovery.js');
  const catalog = await resolveDynamicModelCatalog({
    aiwgRoot: options.frameworkRoot,
    inventory: await collectProviderInventory(options.target, { detectProcess: false }),
    allowNetwork: false,
  });
  const catalogEntries = catalog.providers[options.provider]?.roles as
    | Record<WrapperRole, { id: string }>
    | undefined;
  const catalogModels = catalogEntries
    ? Object.fromEntries(Object.entries(catalogEntries).map(([role, entry]) => [role, entry.id])) as Record<WrapperRole, string>
    : undefined;
  const expectedModels = catalogModels
    ? resolveUseWrapperModelExpectations({
      provider: options.provider,
      modelDeployArgs: collectModelOverrideDeployArgs(options.modelDeployArgs),
      catalogModels,
      modelsConfig: await loadDeployModelsConfig(options.frameworkRoot),
    })
    : undefined;
  const wrappers = await verifyModelWrapperDeployment(agentsPath, {
    provider: options.provider,
    ...(expectedModels ? {
      models: expectedModels,
    } : {}),
  });
  if (wrappers.supported && !wrappers.valid) {
    const details = [
      ...(wrappers.missing.length > 0 ? [`missing ${wrappers.missing.join(', ')}`] : []),
      ...wrappers.mismatches.map(item => `${item.wrapper}.${item.field}: ${item.reason}`),
    ];
    const message = `Model wrapper deployment invalid for ${options.provider}: ${details.join('; ')}`;
    if (!options.filtered) return { exitCode: 1, message };
    ui.warn(`${message} (filtered deployment)`);
  } else if (options.verbose && wrappers.supported) {
    ui.dim(`  Model wrappers verified: ${wrappers.found.join(', ')}`);
  } else if (options.verbose) {
    ui.dim(`  Model wrappers: ${options.provider} has no provider-native agent directory; model policy remains ${options.provider === 'hermes' || options.provider === 'openhuman' ? 'inherited/global' : 'informational'}.`);
  }
  return null;
}

/**
 * List skill folder names from a source skills directory.
 * Returns empty array if the directory doesn't exist.
 */
async function listSourceSkillNames(skillsDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

async function mirrorStandardCommandSkills(opts: {
  provider: string;
  target: string;
  targetCommandsDir: string;
  targetSkillsDir: string;
  frameworkRoot: string;
  dryRun: boolean;
  verbose: boolean;
}): Promise<number> {
  const sourceDirs = [
    opts.targetSkillsDir,
    path.join(opts.frameworkRoot, 'agentic/code/frameworks/sdlc-complete/skills'),
  ];
  const seen = new Set<string>();
  let count = 0;

  for (const sourceDir of sourceDirs) {
    if (!sourceDir || seen.has(sourceDir)) continue;
    seen.add(sourceDir);

    const result = await translateSkillsToCommands(sourceDir, {
      provider: opts.provider,
      targetDir: opts.targetCommandsDir,
      projectPath: opts.target,
      dryRun: opts.dryRun,
      verbose: opts.verbose,
      deployVersion: (await getVersionInfo()).version,
      nameFilter: shouldMirrorStandardCommandSkill,
    });
    count += result.translated.length;
  }

  return count;
}

/**
 * Run pre-deployment collision check for a framework or addon.
 * Emits warnings/errors to stderr. Returns false if deployment should be blocked.
 */
async function runPreDeployCollisionCheck(opts: {
  frameworkRoot: string;
  framework: string;
  target: string;
  provider: string;
  force: boolean;
  skipConflicts: boolean;
  verbose?: boolean;
}): Promise<boolean> {
  const { frameworkRoot, framework, target, provider, force, verbose = false } = opts;

  // Resolve source skills dir for this framework
  const frameworkDirName = resolveFrameworkDir(framework);
  if (!frameworkDirName) return true; // no backing directory — skip collision check
  const sourceSkillsDir = path.join(
    frameworkRoot,
    'agentic/code/frameworks',
    frameworkDirName,
    'skills'
  );

  const skillNames = await listSourceSkillNames(sourceSkillsDir);
  if (skillNames.length === 0) return true; // nothing to check

  const providerPaths = getProviderPaths(provider);
  const skillsBaseDir = path.isAbsolute(providerPaths.skills)
    ? providerPaths.skills
    : path.join(target, providerPaths.skills);

  const results = await checkCollisions({
    platform: provider as any,
    projectPath: target,
    skillNames,
    namespace: 'aiwg',
    skillsBaseDir,
    sourceSkillsDir,
  });

  const report = formatCollisionReport(results, { verbose });
  if (report && machineReadableUseDepth === 0) {
    process.stderr.write(report + '\n');
  }

  if (hasBlockingCollisions(results) && !force) {
    if (machineReadableUseDepth === 0) {
      process.stderr.write('\nDeployment blocked. Use --force to override.\n');
    }
    return false;
  }

  return true;
}

function agenticNextSteps(openStep: string): string[] {
  return [
    openStep,
    'Ask the steward:  "Check that AIWG is installed correctly and tell me what I can do here."',
    'Regenerate:       Invoke {{aiwg-regenerate}} in-session when context files need rebuilding.',
    'Install runbook:  docs/agentic-install-runbook.md',
    'Diagnostics:      aiwg doctor',
  ];
}

/**
 * Framework-specific next steps guidance.
 *
 * Keep this handoff user-facing: `aiwg use` is the main human CLI entry point;
 * discovery, capability lookup, and agent-loop commands are agent tools.
 *
 * Keyed as `<provider>/<framework>` with fallback to `<framework>`.
 * The 'claude' provider is the default (shown for all unrecognized providers).
 */
const NEXT_STEPS: Record<string, string[]> = {
  'sdlc': agenticNextSteps('Open platform:    Open Claude Code, Codex, Cursor, Warp, or your chosen AI tool.'),
  'marketing': agenticNextSteps('Open platform:    Open your chosen AI tool and ask for a campaign or marketing intake.'),
  'media-curator': agenticNextSteps('Open platform:    Open your chosen AI tool and ask for a media collection next action.'),
  'research': agenticNextSteps('Open platform:    Open your chosen AI tool and ask for a research workflow next action.'),
  'security-engineering': agenticNextSteps('Open platform:    Open your chosen AI tool and ask for a security-engineering decision path.'),
  'all': agenticNextSteps('Open platform:    Open Claude Code, Codex, Cursor, Warp, or your chosen AI tool.'),

  'hermes/sdlc': agenticNextSteps('Start Hermes:      Open a Hermes chat attached to this project.'),
  'hermes/marketing': agenticNextSteps('Start Hermes:      Open a Hermes chat attached to this project.'),
  'hermes/all': agenticNextSteps('Start Hermes:      Open a Hermes chat attached to this project.'),

  'factory/sdlc': agenticNextSteps('Open Factory:      Start Factory from this project root.'),
  'cursor/sdlc': agenticNextSteps('Open Cursor:       Open this project in Cursor.'),
  'warp/sdlc': agenticNextSteps('Open Warp:         Start a Warp session in this project root.'),
  'copilot/sdlc': agenticNextSteps('Open VS Code:      Open this workspace and use Copilot Chat.'),
  'codex/sdlc': agenticNextSteps('Open Codex:        Restart Codex in this project root.'),
  'windsurf/sdlc': agenticNextSteps('Open Devin Desktop: Open this project in Devin Desktop and ask Devin for AIWG status.'),
  'openclaw/sdlc': agenticNextSteps('Start OpenClaw:    Open OpenClaw with this project workspace.'),
  'openclaw/marketing': agenticNextSteps('Start OpenClaw:    Open OpenClaw with this project workspace.'),
  'openclaw/all': agenticNextSteps('Start OpenClaw:    Open OpenClaw with this project workspace.'),
  'openhuman/sdlc': agenticNextSteps('Open OpenHuman:    Open OpenHuman and check the Skills view for AIWG kernel skills.'),
  'openhuman/marketing': agenticNextSteps('Open OpenHuman:    Open OpenHuman and check the Skills view for AIWG kernel skills.'),
  'openhuman/all': agenticNextSteps('Open OpenHuman:    Open OpenHuman and check the Skills view for AIWG kernel skills.'),
};

export function nextStepsFor(framework: Framework, provider: string = 'claude'): string[] {
  const providerKey = `${provider}/${framework}`;
  const regenerateInvocation = provider === 'codex' || provider === 'openai'
    ? '$aiwg-regenerate'
    : '/aiwg-regenerate';
  const steps = NEXT_STEPS[providerKey] ?? NEXT_STEPS[framework] ?? NEXT_STEPS.sdlc;
  return steps.map((step) => step.replace('{{aiwg-regenerate}}', regenerateInvocation));
}

/**
 * Per-provider session-reload requirement after `aiwg use`.
 *
 * Most agentic platforms read their `<provider>/agents/` directory at session
 * start and cache the agent registry for the lifetime of the session. A
 * deploy that lands new agent files is invisible to any session that was
 * already running when the deploy completed — the Agent / Task tool will
 * still report `Agent type 'foo' not found` until the session reloads.
 *
 * Issue #1240: surfacing this requirement in `aiwg use` output and in the
 * Steward FAQ so operators stop hitting the "fallback to general-purpose"
 * path silently.
 */
const SESSION_RELOAD_NOTICE: Record<string, { action: string; rationale: string; symptom?: string }> = {
  claude: {
    action: 'Restart your Claude Code session (close and reopen) to load the newly deployed agents.',
    rationale: 'Claude Code reads .claude/agents/ at session start. A running session retains its old registry until reloaded.',
  },
  codex: {
    action: 'Restart/open Codex in this target workspace so it picks up newly deployed agents and .agents/skills entries.',
    rationale: 'Codex caches its agent and skill registry per session. Project .agents/skills/ and .codex/agents/ are scanned from the Codex working directory up to the repo root on startup.',
  },
  copilot: {
    action: 'Reload the VS Code window (`Developer: Reload Window`) so Copilot picks up the new .github/agents/ entries.',
    rationale: 'VS Code/Copilot caches workspace agent definitions until the window reloads.',
  },
  cursor: {
    action: 'Restart Cursor (close and reopen the project) to load the newly deployed agents.',
    rationale: 'Cursor reads .cursor/agents/ and .cursor/rules/ on workspace open.',
  },
  warp: {
    action: 'Open a fresh Warp tab — WARP.md is re-read on tab start.',
    rationale: 'Warp aggregates context from WARP.md when a new tab spawns; existing tabs keep the prior version.',
  },
  windsurf: {
    action: 'Restart Devin Desktop or reload the workspace so the aggregated AGENTS.md is re-parsed.',
    rationale: 'Devin Desktop reads the Windsurf-compatible AGENTS.md once per workspace session.',
  },
  factory: {
    action: 'Restart your Factory droid runtime to pick up new entries in .factory/droids/.',
    rationale: 'Factory caches the droid manifest at runtime start.',
  },
  opencode: {
    action: 'Restart your OpenCode session — `.opencode/agent/` is scanned on startup.',
    rationale: 'OpenCode loads agent files on session start and does not hot-reload.',
  },
  hermes: {
    action: 'In an active Hermes session, run /reload-skills to pick up new skills in $HERMES_HOME/skills/ and /reload-mcp to pick up MCP server changes ($HERMES_HOME/config.yaml) — both are in-session slash commands, no chat restart needed. Restart the chat only as a fallback if the slash commands are unavailable.',
    rationale: 'Hermes loads skills and MCP config at session start (verified in hermes_cli/commands.py:178 and hermes_cli/config.py:1228). The /reload-skills and /reload-mcp slash commands re-scan in place; /reload-mcp prompts for confirmation by default.',
    symptom: 'Until reloaded, newly deployed kernel skills are missing from `hermes skills list` and unreachable via natural-language invocation; new MCP servers (incl. AIWG) are missing from the tool surface.',
  },
  openclaw: {
    action: 'Restart OpenClaw — ~/.openclaw/agents/ and ~/.openclaw/skills/ are loaded on startup.',
    rationale: 'OpenClaw reads its home-dir registry once per process.',
  },
};

function printSessionReloadNotice(provider: string): void {
  const notice = SESSION_RELOAD_NOTICE[provider];
  if (!notice) return;
  const defaultSymptom =
    'Until reloaded, the Agent/Task tool will report "Agent type not found" for the newly deployed agents.';
  ui.section('Session reload required:', [
    notice.action,
    `Why: ${notice.rationale}`,
    notice.symptom ?? defaultSymptom,
  ]);
}

/**
 * Count deployed artifacts in target directories
 *
 * @implements #609
 */
async function countDeployedArtifacts(
  target: string,
  paths: { agents: string; skills: string; commands: string; rules: string; behaviors: string },
  provider?: string
): Promise<{ agents: number; commands: number; skills: number; rules: number; behaviors: number }> {
  const countMd = async (dir: string): Promise<number> => {
    if (!dir) return 0;
    try {
      // Support absolute paths (openclaw deploys to home dir)
      const resolvedDir = path.isAbsolute(dir) ? dir : path.join(target, dir);
      const entries = await fs.readdir(resolvedDir);
      return entries.filter(f => f.endsWith('.md')).length;
    } catch {
      return 0;
    }
  };
  const countDirs = async (dir: string): Promise<number> => {
    if (!dir) return 0;
    try {
      const resolvedDir = path.isAbsolute(dir) ? dir : path.join(target, dir);
      const entries = await fs.readdir(resolvedDir, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).length;
    } catch {
      return 0;
    }
  };
  // Count rules by parsing declared counts from RULES-INDEX.md files rather
  // than counting .md files on disk. When deployIndexOnly is true, only one
  // RULES-INDEX.md is deployed but it declares the total count of rules across
  // all installed components via section headers like "## Name (N rules — ...)".
  const countRules = async (dir: string): Promise<number> => {
    if (!dir) return 0;
    try {
      const resolvedDir = path.isAbsolute(dir) ? dir : path.join(target, dir);
      const entries = await fs.readdir(resolvedDir);
      const indexFiles = entries.filter(f => f.endsWith('RULES-INDEX.md'));
      if (indexFiles.length === 0) {
        // No index files — fall back to counting individual rule .md files
        return entries.filter(f => f.endsWith('.md')).length;
      }
      let total = 0;
      for (const indexFile of indexFiles) {
        const content = await fs.readFile(path.join(resolvedDir, indexFile), 'utf-8');
        // Match section headers: "## Name (N rules — ..." or "— N rules*"
        const matches = content.matchAll(/\((\d+) rules[^)]*\)/g);
        for (const m of matches) {
          total += parseInt(m[1], 10);
        }
      }
      return total > 0 ? total : entries.filter(f => f.endsWith('.md')).length;
    } catch {
      return 0;
    }
  };
  // Kernel skills deploy to the platform-native skills dir (always-loaded
  // set) while standard skills may sequester under <provider>/.aiwg/skills.
  // Count the provider-declared kernel path directly; deriving it by stripping
  // `.aiwg/` from the standard path produced `.codex/skills` instead of
  // Codex's native `.agents/skills` path (#766).
  const kernelSkillsPath = provider ? getProviderKernelSkillsPath(provider) : '';
  return {
    agents: await countMd(paths.agents),
    commands: await countMd(paths.commands),
    skills:
      (await countDirs(paths.skills)) +
      (kernelSkillsPath && kernelSkillsPath !== paths.skills
        ? await countDirs(kernelSkillsPath)
        : 0),
    rules: await countRules(paths.rules),
    behaviors: await countDirs(paths.behaviors),
  };
}

/**
 * Detect forge targets from .git/config remote URLs.
 * Returns a list of forge types found: 'github' | 'gitea'
 *
 * @implements #661
 */
async function detectForges(projectDir: string): Promise<Array<'github' | 'gitea'>> {
  const forges = new Set<'github' | 'gitea'>();
  try {
    const gitConfig = await fs.readFile(path.join(projectDir, '.git', 'config'), 'utf-8');
    if (/github\.com/i.test(gitConfig)) forges.add('github');
    // Gitea: any non-github remote host (self-hosted instances)
    const remoteUrls = [...gitConfig.matchAll(/url\s*=\s*(.+)/g)].map(m => m[1].trim());
    for (const url of remoteUrls) {
      if (!url.includes('github.com') && (url.includes('git.') || url.includes('.net') || url.includes('.io'))) {
        forges.add('gitea');
      }
    }
  } catch {
    // No .git/config — default to github only
    forges.add('github');
  }
  return [...forges];
}

/**
 * Deploy CI workflow files to .github/workflows/ and/or .gitea/workflows/
 * when --ci-hooks-enabled is set.
 *
 * @implements #661
 */
async function deployCiHooks(opts: {
  frameworkRoot: string;
  framework: string;
  target: string;
  dryRun: boolean;
}): Promise<void> {
  const { frameworkRoot, framework, target, dryRun } = opts;

  // Resolve framework source dir
  const ciFrameworkDir = resolveFrameworkDir(framework);
  if (!ciFrameworkDir) return; // no backing directory — nothing to deploy
  const frameworkDir = path.join(
    frameworkRoot,
    'agentic/code/frameworks',
    ciFrameworkDir
  );

  // Read CI manifest from framework manifest.json
  let ciSpec: { github?: string[]; gitea?: string[] } = {};
  try {
    const manifestPath = path.join(frameworkDir, 'manifest.json');
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent) as { ci?: { github?: string[]; gitea?: string[] } };
    ciSpec = manifest.ci ?? {};
  } catch {
    // No CI spec in manifest — nothing to deploy
    return;
  }

  if (Object.keys(ciSpec).length === 0) return;

  const forges = await detectForges(target);
  const ciSourceDir = path.join(frameworkDir, 'ci');

  const forgeMap: Array<{ forge: 'github' | 'gitea'; targetDir: string; files: string[] }> = [
    { forge: 'github', targetDir: path.join(target, '.github', 'workflows'), files: ciSpec.github ?? [] },
    { forge: 'gitea', targetDir: path.join(target, '.gitea', 'workflows'), files: ciSpec.gitea ?? [] },
  ];

  let deployed = 0;
  for (const { forge, targetDir, files } of forgeMap) {
    if (!forges.includes(forge) || files.length === 0) continue;

    if (!dryRun) {
      await fs.mkdir(targetDir, { recursive: true });
    }

    for (const file of files) {
      const src = path.join(ciSourceDir, forge, file);
      const dest = path.join(targetDir, path.basename(file));
      if (dryRun) {
        console.log(`  [dry-run] Would copy CI file: ${src} → ${dest}`);
      } else {
        try {
          await fs.copyFile(src, dest);
          deployed++;
        } catch {
          ui.warn(`Could not copy CI file: ${file} (source missing in framework — skipping)`);
        }
      }
    }
  }

  if (!dryRun && deployed > 0) {
    ui.blank();
    ui.warn(`CI hooks installed (${deployed} file(s)). Review before committing — they affect your CI pipeline.`);
  }
}

/**
 * Count artifacts contributed by a single project-local bundle by reading the
 * bundle's source directories. Approximates what deploy-agents.mjs writes to
 * the provider deploy paths for this specific bundle (skills are subdirs;
 * everything else is .md files).
 *
 * @implements #1035
 */
async function countBundleSourceArtifacts(
  bundlePath: string
): Promise<{ agents: number; commands: number; skills: number; rules: number }> {
  const countMd = async (dir: string): Promise<number> => {
    try {
      const entries = await fs.readdir(path.join(bundlePath, dir));
      return entries.filter(f => f.endsWith('.md')).length;
    } catch {
      return 0;
    }
  };
  const countDirs = async (dir: string): Promise<number> => {
    try {
      const entries = await fs.readdir(path.join(bundlePath, dir), { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).length;
    } catch {
      return 0;
    }
  };
  return {
    agents: await countMd('agents'),
    commands: await countMd('commands'),
    skills: await countDirs('skills'),
    rules: await countMd('rules'),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveDeployPath(target: string, deployPath: string): string {
  return path.isAbsolute(deployPath) ? deployPath : path.join(target, deployPath);
}

async function listBundleMdStems(bundlePath: string, subdir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(bundlePath, subdir));
    return entries
      .filter(entry => entry.endsWith('.md'))
      .map(entry => path.basename(entry, '.md'));
  } catch {
    return [];
  }
}

async function countDeployedBundleFiles(
  bundlePath: string,
  subdir: string,
  target: string,
  deployPath: string,
  extensions: string[],
): Promise<number> {
  if (!deployPath) return 0;
  const stems = await listBundleMdStems(bundlePath, subdir);
  if (stems.length === 0) return 0;
  const destDir = resolveDeployPath(target, deployPath);
  let count = 0;
  for (const stem of stems) {
    for (const ext of extensions) {
      if (await fileExists(path.join(destDir, `${stem}${ext}`))) {
        count++;
        break;
      }
    }
  }
  return count;
}

async function listBundleSkillNameCandidates(bundlePath: string): Promise<string[][]> {
  const skillsRoot = path.join(bundlePath, 'skills');
  try {
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    const candidates: string[][] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sourceName = entry.name;
      const skillMd = path.join(skillsRoot, sourceName, 'SKILL.md');
      let deployedName = sourceName;
      try {
        const content = await fs.readFile(skillMd, 'utf-8');
        const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (match) {
          const parsed = YAML.parse(match[1]);
          if (typeof parsed?.name === 'string' && parsed.name.trim()) {
            deployedName = parsed.name.trim();
          }
        }
      } catch {
        // Missing or invalid frontmatter still leaves the source dir name as
        // the best deployed-name approximation for providers that copy dirs.
      }
      candidates.push([...new Set([deployedName, sourceName])]);
    }
    return candidates;
  } catch {
    return [];
  }
}

async function countDeployedBundleSkills(
  bundlePath: string,
  target: string,
  provider: string,
  paths: ProviderArtifactPathStrings,
): Promise<number> {
  const skillCandidates = await listBundleSkillNameCandidates(bundlePath);
  if (skillCandidates.length === 0) return 0;
  const candidateDirs = [
    paths.skills,
    getProviderKernelSkillsPath(provider),
  ]
    .filter(Boolean)
    .map(dir => resolveDeployPath(target, dir));
  const uniqueCandidateDirs = [...new Set(candidateDirs)];

  let count = 0;
  for (const names of skillCandidates) {
    let found = false;
    for (const dir of uniqueCandidateDirs) {
      for (const name of names) {
        if (!(await fileExists(path.join(dir, name, 'SKILL.md')))) continue;
        count++;
        found = true;
        break;
      }
      if (found) break;
    }
  }
  return count;
}

async function countBundleDeployedArtifacts(
  bundlePath: string,
  target: string,
  provider: string,
): Promise<{ agents: number; commands: number; skills: number; rules: number }> {
  const paths = getProviderPaths(provider);
  return {
    agents: await countDeployedBundleFiles(bundlePath, 'agents', target, paths.agents, ['.md', '.toml']),
    commands: await countDeployedBundleFiles(bundlePath, 'commands', target, paths.commands, ['.md']),
    skills: await countDeployedBundleSkills(bundlePath, target, provider, paths),
    rules: await countDeployedBundleFiles(bundlePath, 'rules', target, paths.rules, ['.md', '.mdc']),
  };
}

const SKILL_SUPPORT_REFERENCE = /(?:^|[\s`('"\[])((?:templates|references|scripts|assets)\/[A-Za-z0-9._@/+\-]+)(?=$|[\s`)'"\],:;])/gm;

/**
 * Skill-relative support files may live beside the skill or at the bundle root
 * (plugin payloads commonly share report templates). Materialize
 * only paths explicitly named by SKILL.md, and fail closed on missing or
 * unsafe sources so a deployed instruction can never point at absent assets.
 */
async function reconcileDeployedSkillAssets(
  bundlePath: string,
  target: string,
  provider: string,
  options: { strictReferences?: boolean; scope?: 'user' | 'project'; skipUndeployed?: boolean } = {},
): Promise<void> {
  const strictReferences = options.strictReferences ?? true;
  const skillsRoot = path.join(bundlePath, 'skills');
  let skillDirs: string[];
  try {
    skillDirs = (await fs.readdir(skillsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return;
  }
  const paths = getProviderPaths(provider);
  const kernelSkillsPath = getProviderKernelSkillsPath(provider);
  const deployRoots = provider === 'omp' && options.scope === 'user'
    ? [path.join(resolveOmpPaths({ cwd: target }).agentDir, 'skills')]
    : [...new Set([paths.skills, kernelSkillsPath]
      .filter((value): value is string => Boolean(value)).map(value => resolveDeployPath(target, value)))];

  for (const skillName of skillDirs) {
    const sourceSkillDir = path.join(skillsRoot, skillName);
    const sourceSkillMd = path.join(sourceSkillDir, 'SKILL.md');
    let content: string;
    try { content = await fs.readFile(sourceSkillMd, 'utf8'); } catch { continue; }
    if (options.skipUndeployed && !(await Promise.all(deployRoots.map(root =>
      fileExists(path.join(root, skillName, 'SKILL.md'))))).some(Boolean)) continue;
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
    const declaredEntrypoint = frontmatter
      .match(/^[ \t]+entrypoint:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
    const declaredEntrypoints = new Set(declaredEntrypoint ? [declaredEntrypoint] : []);
    const references = [...new Set([
      ...content.matchAll(SKILL_SUPPORT_REFERENCE),
    ].map(match => match[1]).concat([...declaredEntrypoints]))];
    for (const relative of references) {
      const normalized = path.posix.normalize(relative);
      if (normalized !== relative || normalized.startsWith('../') || path.isAbsolute(normalized)) {
        throw new Error(`unsafe skill support reference '${relative}' in ${sourceSkillMd}`);
      }
      const candidates = [path.join(sourceSkillDir, normalized), path.join(bundlePath, normalized)];
      let source: string | undefined;
      for (const candidate of candidates) {
        try {
          const stat = await fs.lstat(candidate);
          if (stat.isFile() && !stat.isSymbolicLink()) { source = candidate; break; }
        } catch { /* try bundle-root fallback */ }
      }
      if (!source) {
        if (strictReferences || declaredEntrypoints.has(relative)) {
          throw new Error(`missing skill support asset '${relative}' referenced by ${sourceSkillMd}`);
        }
        continue;
      }

      let deployedSkillRoot: string | undefined;
      for (const root of deployRoots) {
        // The deployer may select the bulk or kernel tier; use the tier that
        // actually contains this skill's transformed SKILL.md.
        if (await fileExists(path.join(root, skillName, 'SKILL.md'))) {
          deployedSkillRoot = root;
          break;
        }
      }
      if (!deployedSkillRoot) throw new Error(`deployed skill '${skillName}' not found while reconciling support assets`);
      const destination = path.join(deployedSkillRoot, skillName, ...normalized.split('/'));
      if (provider === 'omp') {
        const adapter = await import(pathToFileURL(path.join(await getFrameworkRoot(), 'tools/agents/providers/omp.mjs')).href);
        adapter.deploySkillSupportAsset(source, destination, { quiet: true });
        continue;
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
      const mode = (await fs.stat(source)).mode & 0o777;
      await fs.chmod(destination, mode);
    }
  }
}

/**
 * Deploy a single project-local bundle to one provider via deploy-agents.mjs.
 * Runs the same script and flags used for upstream addons, with the bundle
 * directory as the `--source`. Idempotent — overwrites prior deploys.
 *
 * @implements #1035
 */
async function deployOneProjectLocalBundle(opts: {
  bundle: ProjectLocalBundle;
  ctx: HandlerContext;
  frameworkRoot: string;
  provider: string;
  target: string;
  dryRun: boolean;
  verbose: boolean;
  quiet: boolean;
  modelArgs: string[];
}): Promise<{ exitCode: number; counts: { agents: number; commands: number; skills: number; rules: number } }> {
  const { bundle, ctx, frameworkRoot, provider, target, dryRun, verbose, quiet, modelArgs } = opts;
  const sourceCounts = await countBundleSourceArtifacts(bundle.artifactPath);
  const artifactTotal = sourceCounts.agents + sourceCounts.commands + sourceCounts.skills + sourceCounts.rules;
  let cliCommandCount = 0;
  try {
    const contribution = await loadCliCommandsContribution(bundle.artifactPath);
    cliCommandCount = contribution ? Object.keys(contribution.manifest.subcommands).length : 0;
  } catch (error) {
    ui.warn(`Invalid CLI contribution for project-local '${bundle.id}': ${(error as Error).message}`);
    return { exitCode: 1, counts: sourceCounts };
  }
  if (verbose || dryRun) {
    ui.dim(
      `  Artifacts: agents=${sourceCounts.agents} commands=${sourceCounts.commands} skills=${sourceCounts.skills} rules=${sourceCounts.rules} cli=${cliCommandCount}`,
    );
  }
  if (artifactTotal === 0 && cliCommandCount === 0) {
    ui.warn(
      `Project-local ${bundle.type} '${bundle.id}' has no deployable agents, commands, skills, rules, or CLI commands at ${bundle.artifactPath}`,
    );
    return { exitCode: 1, counts: sourceCounts };
  }

  let exitCode = 0;
  if (artifactTotal > 0) {
    const runner = createScriptRunner(frameworkRoot);
    const args: string[] = [
      '--source', bundle.artifactPath,
      '--deploy-commands', '--deploy-skills', '--deploy-rules',
      '--provider', provider,
      '--target', target,
      // Project-local skills MUST land in the per-project skills tier
      // (#1228 follow-up). Default deploy mode after #1217 is no-copy +
      // index-driven discovery, but that model assumes upstream skills at
      // $AIWG_ROOT — project-local bundles live under the project's .aiwg/
      // tree and aren't reachable via `aiwg discover` of the framework
      // graph. Without --copy-all, the bundle's rules deploy but its skills
      // never reach <provider>/.aiwg/skills/, leaving them invisible to
      // both the platform and the index.
      '--copy-all',
      ...modelArgs,
    ];
    if (dryRun) args.push('--dry-run');
    if (verbose) args.push('--verbose');
    if (quiet && !verbose) args.push('--quiet');
    // Project-local bundles are addon-shaped — never trigger the legacy commands
    // migration prompt (which is only relevant for full-framework deploys).
    args.push('--skip-commands-migration');

    const captureOpts = quiet && !verbose ? { capture: true } : {};
    // Inject AIWG_ROOT so the deploy subprocess can resolve the upstream AIWG
    // install root. The bundle's `--source` is its project-local path, so
    // `computeAllKernelNames`/`computeAllArtifactBasenames` (which walk up from
    // srcRoot looking for agentic/code/{frameworks,addons}) would otherwise fail
    // and prune the provider's kernel skill directory with an empty desired set
    // (#123). `frameworkRoot` is the AIWG install root that owns these trees.
    const result = await runner.run('tools/agents/deploy-agents.mjs', args, {
      ...captureOpts,
      env: { AIWG_ROOT: frameworkRoot },
    });
    exitCode = result.exitCode;
    if (exitCode === 0 && !dryRun) {
      try {
        await reconcileDeployedSkillAssets(bundle.artifactPath, target, provider);
      } catch (error) {
        ui.warn(`Project-local skill asset deployment failed for '${bundle.id}': ${(error as Error).message}`);
        exitCode = 1;
      }
    }
  }

  if (exitCode === 0 && cliCommandCount > 0) {
    try {
      await registerSourceCliCommands({
        source: bundle.artifactPath,
        target,
        provider,
        dryRun,
        fallbackDescription: `${bundle.id} project-local commands`,
      });
    } catch (error) {
      ui.warn(`Failed to register CLI commands for project-local '${bundle.id}': ${(error as Error).message}`);
      exitCode = 1;
    }
  }

  const counts = exitCode === 0 && !dryRun
    ? await countBundleDeployedArtifacts(bundle.artifactPath, target, provider)
    : sourceCounts;
  void ctx;
  return { exitCode, counts };
}

/**
 * Discover and deploy artifact-bearing project-local bundles from
 * `.aiwg/{extensions,addons,frameworks,plugins,providers}/<id>/` for one
 * provider. Provider bundles are metadata and are consumed by --provider
 * resolution, not deployed as artifacts. Updates `aiwg.config.installed`
 * with `source: 'project-local'` entries.
 *
 * Returns the number of bundles deployed and any deploy errors.
 *
 * @implements #1035
 */
async function deployProjectLocalBundles(opts: {
  ctx: HandlerContext;
  frameworkRoot: string;
  projectDir: string;
  provider: string;
  target: string;
  dryRun: boolean;
  verbose: boolean;
  quiet: boolean;
  modelArgs?: string[];
  /** When set, restrict to the bundle whose id matches. */
  onlyBundleId?: string;
}): Promise<{ deployed: number; failed: number; bundles: ProjectLocalBundle[] }> {
  const {
    ctx, frameworkRoot, projectDir, provider, target, dryRun, verbose, quiet,
    onlyBundleId, modelArgs = [],
  } = opts;

  const discovery = await discoverProjectLocalBundles(projectDir);

  if (discovery.errors.length > 0 && !quiet) {
    ui.warn(`Project-local discovery surfaced ${discovery.errors.length} validation error(s) — run 'aiwg list --project-local' for details`);
  }

  const targetBundles = onlyBundleId
    ? discovery.bundles.filter(b => b.id === onlyBundleId)
    : discovery.bundles.filter(b => b.type !== 'provider');

  if (targetBundles.length === 0) {
    if (!onlyBundleId) {
      const { hasProjectQuickref, deployProjectQuickref } = await import('../../extensions/project-quickref.js');
      try {
        if (await hasProjectQuickref(projectDir)) {
          await deployProjectQuickref(projectDir, provider, { dryRun });
          if (verbose || dryRun) ui.dim(`  + project quickref -> ${provider}`);
        }
      } catch (error) {
        ui.warn(`Project quickref deployment failed: ${(error as Error).message}`);
        return { deployed: 0, failed: 1, bundles: [] };
      }
    }
    return { deployed: 0, failed: 0, bundles: [] };
  }

  // #1037/#1049 — Activity log: emit `discover` for newly-seen bundles
  // (deduped against recent log tail to avoid spam on repeated commands).
  if (!dryRun) {
    await emitDiscoverEventsDeduped(targetBundles.map(b => ({ id: b.id, type: b.type })));
  }

  // #1036 — Resolve shadows against the upstream registry before any deploy.
  // Refuse to deploy bundles that contain a safety-critical shadow without an
  // explicit `overrides:` declaration, or that share an artifact id with another
  // project-local bundle, or that declare a phantom override.
  const upstream = await buildUpstreamRegistry({ frameworkRoot });
  const shadowResult = await resolveShadows(targetBundles, upstream);
  const report = formatShadowReport(shadowResult);
  if (report && machineReadableUseDepth === 0) {
    process.stderr.write(report + '\n');
  }

  // #1037/#1049 — Activity log per shadow resolution
  if (!dryRun) {
    for (const r of shadowResult.resolutions) {
      if (r.verdict === 'deploy') continue; // no-collision case is silent
      const bundle = targetBundles.find(b => b.id === r.bundleId);
      if (!bundle) continue;
      const event = r.verdict === 'deploy-acknowledged'
        ? 'shadow-acknowledged'
        : r.verdict === 'refuse-unsafe' || r.verdict === 'refuse-phantom' || r.verdict === 'refuse-duplicate'
          ? 'shadow-refused'
          : 'conflict';
      await appendProjectLocalActivity({
        event,
        name: bundle.id,
        type: bundle.type,
        summary: `${r.verdict}: ${r.artifactType}/${r.artifactId}${r.upstream ? ` overrides ${r.upstream.source}` : ''}`,
      });
    }
  }

  let deployed = 0;
  let failed = 0;

  for (const bundle of targetBundles) {
    if (shadowResult.blockedBundleIds.has(bundle.id)) {
      failed++;
      ui.warn(`Refused to deploy project-local bundle '${bundle.id}' due to shadow-resolution policy (see ── above ──)`);
      continue;
    }

    if (verbose || dryRun) {
      const action = dryRun ? '[dry-run] Would deploy' : 'Deploying';
      console.log(`${action} project-local ${bundle.type} '${bundle.id}' from ${bundle.localPath} → ${provider}`);
      if (bundle.artifactPath !== bundle.bundlePath) {
        const payloadDisplay = path.relative(projectDir, bundle.artifactPath) || '.';
        ui.dim(`  Resolved plugin payload: ${payloadDisplay}`);
      }
    }

    const result = await deployOneProjectLocalBundle({
      bundle, ctx, frameworkRoot, provider, target, dryRun, verbose, quiet, modelArgs,
    });

    if (result.exitCode !== 0) {
      failed++;
      ui.warn(`Failed to deploy project-local bundle '${bundle.id}' (exit ${result.exitCode})`);
      if (!dryRun) {
        await appendProjectLocalActivity({
          event: 'deploy-failed',
          name: bundle.id,
          type: bundle.type,
          summary: `${provider}: exit ${result.exitCode}`,
        });
      }
      continue;
    }

    deployed++;

    if (!dryRun) {
      const c = result.counts;
      await appendProjectLocalActivity({
        event: 'deploy',
        name: bundle.id,
        type: bundle.type,
        summary: `${provider}: agents=${c.agents} commands=${c.commands} skills=${c.skills} rules=${c.rules}`,
      });
    }

    // Persist registry entry (skip in dry-run — no side effects)
    if (!dryRun) {
      try {
        const config = await readAiwgConfig(projectDir);
        if (!config) continue;
        // Hash the bundle's manifest.json for stale detection
        const manifestAbsPath = path.join(bundle.bundlePath, 'manifest.json');
        const mHash = await hashManifest(manifestAbsPath);
        // #1037 — record per-artifact source hashes so `aiwg remove` can
        // detect pristine vs mutated vs replaced deployed files.
        const artifactHashes = await hashBundleArtifacts(bundle.artifactPath);
        const deployedArtifactHashes = await hashDeployedBundleArtifacts(
          projectDir,
          provider,
          artifactHashes,
        );
        const updated = updateInstalled(config, bundle.id, provider, result.counts, {
          version: bundle.manifest.version,
          source: 'project-local',
          manifestHash: mHash,
          localPath: bundle.localPath,
          localType: bundle.type,
          manifestVersion: bundle.manifest.manifestVersion,
          artifactHashes,
          deployedArtifactHashes,
        });
        await writeAiwgConfig(projectDir, updated);
      } catch (err) {
        // Non-fatal: deploy already succeeded
        ui.warn(`Project-local registry update failed for '${bundle.id}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Automatic reconciliation (also used by refresh/upgrade) must restore the
  // project search cache for existing bundles, just as a named local install
  // does. Named installs refresh once after all selected providers finish.
  if (deployed > 0 && !dryRun && !onlyBundleId) {
    try {
      await rebuildExternalBundleIndex(projectDir, 'project', verbose);
    } catch (error) {
      failed++;
      ui.warn(`Project-local index refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Refresh the project kernel quickref from either legacy operator input or
  // managed project-local discovery whenever bundles deploy.
  const { hasProjectQuickref, deployProjectQuickref } = await import('../../extensions/project-quickref.js');
  try {
    if (await hasProjectQuickref(projectDir)) {
      const quickrefResult = await deployProjectQuickref(projectDir, provider, { dryRun });
      if (verbose || dryRun) {
        ui.dim(`  + project quickref -> ${quickrefResult.provider}${quickrefResult.emulated ? ' (emulated)' : ''}`);
      }
    }
  } catch (error) {
    failed++;
    ui.warn(`Project quickref deployment failed: ${(error as Error).message}`);
  }

  return { deployed, failed, bundles: targetBundles };
}

async function resolveProjectLocalProviderAdapter(
  projectDir: string,
  provider: string,
): Promise<{ provider: string; requestedProvider?: string; bundle?: ProjectLocalBundle }> {
  const discovery = await discoverProjectLocalBundles(projectDir);
  const bundle = discovery.bundles.find((candidate) => candidate.type === 'provider' && candidate.id === provider);
  const extendsProvider = bundle?.manifest.providerConfig?.extends;
  if (!bundle || !extendsProvider) return { provider };
  return { provider: extendsProvider, requestedProvider: provider, bundle };
}

function resolveBuiltInProviderForUse(provider: string): { provider: string; requestedProvider?: string } {
  const normalized = normalizeProviderDefinitionId(provider);
  if (normalized && normalized !== provider) {
    return { provider: normalized, requestedProvider: provider };
  }
  return { provider };
}

function unsupportedProviderMessage(provider: string): string | null {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'devin-cli') {
    return [
      `Unsupported provider: ${provider}`,
      '',
      'Devin CLI has distinct rules/skills surfaces and is not a deployable AIWG provider yet.',
      'Use --provider devin for Devin Desktop deployments.',
    ].join('\n');
  }
  return null;
}

const USE_FLAGS_WITH_VALUES = new Set([
  '--harness-agents',
  '--profile',
  '--provider',
  '--platform',
  '--providers',
  '--prefix',
  '--scope',
  '--target',
]);

type OpenHumanHarnessScope = 'project' | 'user';

export const OPENHUMAN_DEFAULT_HARNESS_AGENTS = [
  'architecture-designer',
  'code-reviewer',
  'project-manager',
  'requirements-analyst',
  'security-auditor',
  'software-implementer',
  'technical-writer',
  'test-engineer',
] as const;

interface OpenHumanHarnessProfile {
  modelHint: 'agentic' | 'coding' | 'reasoning' | 'efficiency';
  temperature: number;
  maxIterations: number;
  iterationPolicy: 'strict' | 'extended';
  maxResultChars: number;
  maxTurnOutputTokens: number;
  timeoutSecs: number;
  sandboxMode: 'none' | 'read_only' | 'sandboxed';
  tokenjuiceCompression: 'auto' | 'full' | 'light' | 'off';
}

const OPENHUMAN_DEFAULT_HARNESS_PROFILE: OpenHumanHarnessProfile = {
  modelHint: 'agentic',
  temperature: 0.35,
  maxIterations: 10,
  iterationPolicy: 'strict',
  maxResultChars: 18000,
  maxTurnOutputTokens: 6000,
  timeoutSecs: 900,
  sandboxMode: 'none',
  tokenjuiceCompression: 'auto',
};

const OPENHUMAN_HARNESS_PROFILES: Record<string, Partial<OpenHumanHarnessProfile>> = {
  'aiwg-model-reasoning-worker': {
    modelHint: 'reasoning',
  },
  'aiwg-model-coding-worker': {
    modelHint: 'coding',
  },
  'aiwg-model-efficiency-worker': {
    modelHint: 'efficiency',
  },
  'architecture-designer': {
    modelHint: 'reasoning',
    maxIterations: 14,
    iterationPolicy: 'extended',
    maxResultChars: 24000,
    maxTurnOutputTokens: 8000,
    timeoutSecs: 1200,
  },
  'code-reviewer': {
    modelHint: 'coding',
    temperature: 0.25,
    maxIterations: 10,
    maxResultChars: 20000,
    tokenjuiceCompression: 'light',
  },
  'project-manager': {
    modelHint: 'agentic',
    maxIterations: 8,
    maxResultChars: 14000,
  },
  'requirements-analyst': {
    modelHint: 'reasoning',
    maxIterations: 12,
    iterationPolicy: 'extended',
    maxResultChars: 22000,
  },
  'security-auditor': {
    modelHint: 'coding',
    temperature: 0.2,
    maxIterations: 12,
    iterationPolicy: 'extended',
    maxResultChars: 24000,
    maxTurnOutputTokens: 8000,
    timeoutSecs: 1200,
    tokenjuiceCompression: 'light',
  },
  'software-implementer': {
    modelHint: 'coding',
    temperature: 0.25,
    maxIterations: 16,
    iterationPolicy: 'extended',
    maxResultChars: 26000,
    maxTurnOutputTokens: 9000,
    timeoutSecs: 1500,
    tokenjuiceCompression: 'light',
  },
  'technical-writer': {
    modelHint: 'agentic',
    temperature: 0.45,
    maxIterations: 8,
    maxResultChars: 18000,
  },
  'test-engineer': {
    modelHint: 'coding',
    temperature: 0.25,
    maxIterations: 14,
    iterationPolicy: 'extended',
    maxResultChars: 24000,
    maxTurnOutputTokens: 8000,
    timeoutSecs: 1200,
    tokenjuiceCompression: 'light',
  },
};

export interface OpenHumanHarnessDeployResult {
  emitted: number;
  tomlPaths: string[];
  promptPaths: string[];
}

interface ParsedAgentMarkdown {
  slug: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

function readFlagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) return args[i + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function removeFlagWithOptionalValue(args: string[], name: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) {
      i++;
      continue;
    }
    if (arg.startsWith(`${name}=`)) continue;
    result.push(arg);
  }
  return result;
}

function withProviderOverride(args: string[], provider: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--provider' || arg === '--platform') && i + 1 < args.length) {
      i++;
      continue;
    }
    result.push(arg);
  }
  result.push('--provider', provider);
  return result;
}

export function parseOpenHumanHarnessAgentSelector(args: string[]): string[] {
  const value = readFlagValue(args, '--harness-agents');
  if (!value) return [];
  return Array.from(new Set(
    value
      .split(',')
      .map((entry) => slugifyAgentName(entry))
      .filter(Boolean)
  ));
}

function hasFlag(args: string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

export function resolveOpenHumanHarnessAgentSelectors(args: string[]): string[] {
  if (args.includes('--no-harness-agents')) return [];
  if (hasFlag(args, '--harness-agents')) return parseOpenHumanHarnessAgentSelector(args);
  return [];
}

function slugifyAgentName(value: string): string {
  return value
    .trim()
    .replace(/\.md$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function snakeAgentId(slug: string): string {
  return slug.replace(/-/g, '_');
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseAgentMarkdown(slug: string, content: string): ParsedAgentMarkdown {
  if (!content.startsWith('---\n')) {
    return { slug, frontmatter: {}, body: content.trimStart() };
  }
  const end = content.indexOf('\n---', 4);
  if (end < 0) return { slug, frontmatter: {}, body: content.trimStart() };

  const rawFrontmatter = content.slice(4, end);
  const bodyStart = content.indexOf('\n', end + 4);
  const body = bodyStart >= 0 ? content.slice(bodyStart + 1) : '';
  const parsed = YAML.parse(rawFrontmatter);
  return {
    slug,
    frontmatter: parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {},
    body: body.trimStart(),
  };
}

function frontmatterString(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key];
  if (typeof value === 'string') return value;
  return undefined;
}

function normalizeDescription(value: string | undefined, slug: string): string {
  const description = value?.replace(/\s+/g, ' ').trim();
  return description || `Use the ${titleFromSlug(slug)} AIWG specialist.`;
}

function escapeTomlBasicString(value: string): string {
  return JSON.stringify(value);
}

function tomlMultilineLiteral(value: string): string {
  // TOML literal strings cannot contain three consecutive apostrophes.
  return `'''${value.replace(/'''/g, "''\\'")}'''`;
}

function openHumanHarnessProfile(slug: string): OpenHumanHarnessProfile {
  return {
    ...OPENHUMAN_DEFAULT_HARNESS_PROFILE,
    ...(OPENHUMAN_HARNESS_PROFILES[slug] ?? {}),
  };
}

function renderOpenHumanHarnessToml(agent: ParsedAgentMarkdown, promptBody: string): string {
  const id = snakeAgentId(agent.slug);
  const profile = openHumanHarnessProfile(agent.slug);
  return [
    '# AIWG-managed OpenHuman native harness agent; do not hand-edit.',
    '# Source template: agentic/code/frameworks/sdlc-complete/templates/openhuman/agent.toml.aiwg-template',
    `id = "aiwg_${id}"`,
    `when_to_use = ${escapeTomlBasicString(normalizeDescription(frontmatterString(agent.frontmatter, 'description'), agent.slug))}`,
    `display_name = ${escapeTomlBasicString(frontmatterString(agent.frontmatter, 'name') || titleFromSlug(agent.slug))}`,
    '',
    'agent_tier = "worker"',
    `temperature = ${profile.temperature}`,
    `max_iterations = ${profile.maxIterations}`,
    `iteration_policy = "${profile.iterationPolicy}"`,
    `max_result_chars = ${profile.maxResultChars}`,
    `max_turn_output_tokens = ${profile.maxTurnOutputTokens}`,
    `timeout_secs = ${profile.timeoutSecs}`,
    `sandbox_mode = "${profile.sandboxMode}"`,
    `tokenjuice_compression = "${profile.tokenjuiceCompression}"`,
    '',
    'omit_identity = true',
    'omit_memory_context = true',
    'omit_safety_preamble = true',
    'omit_skills_catalog = false',
    'omit_profile = true',
    'omit_memory_md = false',
    'background = false',
    'trigger_memory_agent = "never"',
    '',
    '[system_prompt]',
    `inline = ${tomlMultilineLiteral(promptBody.trim())}`,
    '',
    '[model]',
    `hint = "${profile.modelHint}"`,
    '',
  ].join('\n');
}

function projectHarnessToml(agent: ParsedAgentMarkdown): string {
  const id = snakeAgentId(agent.slug);
  return [
    '# AIWG-managed OpenHuman harness definition; do not hand-edit.',
    `id = "aiwg_${id}"`,
    `when_to_use = ${escapeTomlBasicString(normalizeDescription(frontmatterString(agent.frontmatter, 'description'), agent.slug))}`,
    `display_name = ${escapeTomlBasicString(frontmatterString(agent.frontmatter, 'name') || titleFromSlug(agent.slug))}`,
    '',
    '[system_prompt]',
    `file = "aiwg/${id}.md"`,
    '',
  ].join('\n');
}

function userHarnessToml(agent: ParsedAgentMarkdown): string {
  return renderOpenHumanHarnessToml(agent, agent.body);
}

function assertNoSubagentsKey(toml: string): void {
  if (/^\s*subagents\s*=/m.test(toml)) {
    throw new Error('OpenHuman AIWG harness definitions must not emit `subagents` for Worker-tier agents');
  }
}

function openHumanHomeDir(): string {
  return process.env.OPENHUMAN_HOME || path.join(os.homedir(), '.openhuman');
}

async function writeManagedFile(filePath: string, content: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function readSourceAgent(frameworkRoot: string, slug: string): Promise<ParsedAgentMarkdown> {
  const candidates = [
    path.join(frameworkRoot, 'agentic/code/frameworks/sdlc-complete/agents', `${slug}.md`),
    path.join(frameworkRoot, 'agentic/code/addons/aiwg-utils/agents', `${slug}.md`),
    path.join(frameworkRoot, 'agentic/code/agents/personas', `${slug}.md`),
  ];
  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, 'utf-8');
      const parsed = parseAgentMarkdown(slug, content);
      if (!parsed.body.trim()) throw new Error(`${candidate} has an empty prompt body after frontmatter stripping`);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Unknown AIWG agent '${slug}' for --harness-agents`);
}

export async function deployOpenHumanHarnessAgents(opts: {
  frameworkRoot: string;
  target: string;
  selectors: string[];
  scope: OpenHumanHarnessScope;
  dryRun?: boolean;
}): Promise<OpenHumanHarnessDeployResult> {
  const uniqueSelectors = Array.from(new Set(opts.selectors.map(slugifyAgentName).filter(Boolean)));
  if (uniqueSelectors.length === 0) return { emitted: 0, tomlPaths: [], promptPaths: [] };

  const tomlRoot = opts.scope === 'user'
    ? path.join(openHumanHomeDir(), 'agents')
    : path.join(opts.target, 'agents');
  const promptRoot = path.join(opts.target, 'agent', 'prompts', 'aiwg');
  const tomlPaths: string[] = [];
  const promptPaths: string[] = [];

  for (const slug of uniqueSelectors) {
    const agent = await readSourceAgent(opts.frameworkRoot, slug);
    const id = snakeAgentId(slug);
    const toml = opts.scope === 'user' ? userHarnessToml(agent) : projectHarnessToml(agent);
    assertNoSubagentsKey(toml);

    const tomlPath = path.join(tomlRoot, `aiwg_${id}.toml`);
    tomlPaths.push(tomlPath);
    await writeManagedFile(tomlPath, toml, !!opts.dryRun);

    if (opts.scope === 'project') {
      const promptPath = path.join(promptRoot, `${id}.md`);
      promptPaths.push(promptPath);
      await writeManagedFile(promptPath, agent.body.trimStart(), !!opts.dryRun);
    }
  }

  return { emitted: uniqueSelectors.length, tomlPaths, promptPaths };
}

function firstUsePositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (USE_FLAGS_WITH_VALUES.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

function removeFirstPositional(args: string[]): string[] {
  let skipped = false;
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (USE_FLAGS_WITH_VALUES.has(arg)) {
      result.push(arg);
      if (i + 1 < args.length) result.push(args[++i]);
      continue;
    }
    if (!skipped && !arg.startsWith('-')) {
      skipped = true;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function removeGlobalBootstrapFlags(args: string[]): string[] {
  const result: string[] = [];
  const valueFlags = new Set(['--provider', '--platform', '--providers', '--scope', '--target', '--prefix']);
  const booleanFlags = new Set([
    '--global', '--user', '--ci-hooks-enabled', '--no-project-local',
    '--no-context-files', '--no-hooks', '--no-workspace-signals',
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (valueFlags.has(arg)) {
      i += 1;
      continue;
    }
    if (booleanFlags.has(arg)) continue;
    result.push(arg);
  }
  return result;
}

function configuredGlobalProviders(
  args: string[],
  config: Awaited<ReturnType<typeof readAiwgConfig>>,
): string[] {
  const providerIdx = args.findIndex((arg) => arg === '--provider' || arg === '--platform');
  if (providerIdx >= 0 && args[providerIdx + 1]) return [args[providerIdx + 1]];
  const providersIdx = args.indexOf('--providers');
  if (providersIdx >= 0 && args[providersIdx + 1]) {
    const value = args[providersIdx + 1];
    return value === 'default'
      ? ['claude']
      : [...new Set(value.split(',').map((provider) => provider.trim()).filter(Boolean))];
  }
  return config?.providers?.length ? [...new Set(config.providers)] : ['claude'];
}

async function generateGlobalProjectContext(opts: {
  provider: string;
  projectPath: string;
  args: string[];
}): Promise<void> {
  const userPaths = USER_SCOPE_PATHS[opts.provider];
  if (!userPaths) return;
  const skipContext = opts.args.includes('--no-context-files');
  const sections = await discoverDeployedArtifacts(opts.projectPath, {
    agents: userPaths.agents,
    rules: userPaths.rules,
    skills: userPaths.skills,
    behaviors: userPaths.behaviors,
  });
  await generateContextFiles({
    provider: opts.provider as Platform,
    projectPath: opts.projectPath,
    sections,
    detectExistingFiles: true,
    force: opts.args.includes('--force-context-files'),
    skip: {
      workspaceMd: skipContext || opts.args.includes('--no-workspace-md'),
      aiwgMd: skipContext || opts.args.includes('--no-aiwg-md'),
      agentsMd: skipContext || opts.args.includes('--no-agents-md'),
    },
  });
}

async function ensurePostDeployPhases(opts: {
  frameworkRoot: string;
  projectPath: string;
  provider: string;
  args: string[];
  invocationStartedAt: string;
}): Promise<void> {
  const currentIndex = loadGraphIndexFile<ArtifactIndex>(opts.frameworkRoot, 'metadata.json', 'framework');
  const builtAt = currentIndex ? Date.parse(currentIndex.builtAt) : Number.NaN;
  const startedAt = Date.parse(opts.invocationStartedAt);
  if (!Number.isFinite(builtAt) || builtAt + 2_000 < startedAt) {
    try {
      const { buildIndex } = await import('../../artifacts/index-builder.js');
      await buildIndex(opts.frameworkRoot, { graph: 'framework', explicit: false });
    } catch {
      // The shared verifier reports the index failure with stable remediation.
    }
  }

  // The Fortemi export is the default discovery backend. Rebuilding only the
  // source graph makes any existing export stale, so every successful use
  // must leave the shared cache synchronized (#142/#2103). This also
  // materializes a fresh-install cache without requiring a manual index sync.
  try {
    const {
      getFortemiCoreSyncStatus,
      syncFortemiCoreIndex,
    } = await import('../../artifacts/fortemi-core-sync.js');
    const status = getFortemiCoreSyncStatus(opts.frameworkRoot, 'framework');
    if (!status.built || status.stale) {
      syncFortemiCoreIndex(opts.frameworkRoot, { graph: 'framework' });
    }
  } catch {
    // The shared verifier reports discovery failures with stable remediation.
  }

  if (opts.args.includes('--no-context-files')) return;
  const paths = getProviderPaths(opts.provider);
  const sections = await discoverDeployedArtifacts(opts.projectPath, {
    agents: paths.agents,
    rules: paths.rules,
    skills: paths.skills,
    behaviors: paths.behaviors,
  });
  try {
    await generateContextFiles({
      provider: opts.provider as Platform,
      projectPath: opts.projectPath,
      sections,
      detectExistingFiles: true,
      force: opts.args.includes('--force-context-files'),
      skip: {
        workspaceMd: opts.args.includes('--no-workspace-md'),
        aiwgMd: opts.args.includes('--no-aiwg-md'),
        agentsMd: opts.args.includes('--no-agents-md'),
      },
    });
  } catch {
    // The shared verifier reports context or provider-wiring failures.
  }
}

async function deploySourceDirectory(opts: {
  ctx: HandlerContext;
  frameworkRoot: string;
  source: string;
  provider: string;
  target: string;
  dryRun: boolean;
  verbose: boolean;
  force: boolean;
  copyAll: boolean;
  kernelOnly?: boolean;
  quiet: boolean;
  modelArgs: string[];
}): Promise<HandlerResult> {
  const args = [
    '--source', opts.source,
    '--deploy-commands',
    '--deploy-skills',
    '--deploy-rules',
    '--provider', opts.provider,
    '--target', opts.target,
    ...opts.modelArgs,
  ];
  if (opts.dryRun) args.push('--dry-run');
  if (opts.verbose) args.push('--verbose');
  if (opts.force) args.push('--force');
  if (opts.copyAll) args.push('--copy-all');
  if (opts.kernelOnly) args.push('--kernel-only');
  if (opts.quiet) args.unshift('--quiet');

  const runner = createScriptRunner(opts.frameworkRoot);
  const result = await runner.run(
    'tools/agents/deploy-agents.mjs',
    args,
    opts.quiet ? { capture: true } : {},
  );
  if (result.exitCode === 0 && !opts.kernelOnly) {
    try {
      await registerSourceCliCommands({
        source: opts.source,
        target: opts.target,
        provider: opts.provider,
        dryRun: opts.dryRun,
        fallbackDescription: `${path.basename(opts.source)} addon commands`,
      });
    } catch (error) {
      return {
        exitCode: 1,
        message: `Failed to register addon CLI commands: ${(error as Error).message}`,
      };
    }
  }
  return result;
}

async function assertNoSymlinks(root: string): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in external bundle source: ${candidate}`);
    }
    if (entry.isDirectory()) await assertNoSymlinks(candidate);
  }
}

async function installProjectLocalBundleInUserCatalog(bundle: ProjectLocalBundle): Promise<string> {
  await assertNoSymlinks(bundle.bundlePath);
  const catalogRoot = path.join(os.homedir(), '.aiwg', PROJECT_LOCAL_TYPE_TO_DIR[bundle.type]);
  await fs.mkdir(catalogRoot, { recursive: true });
  const destination = path.join(catalogRoot, bundle.id);
  const stage = await fs.mkdtemp(path.join(catalogRoot, `.${bundle.id}-stage-`));
  const backup = path.join(catalogRoot, `.${bundle.id}-backup-${process.pid}`);
  let movedExisting = false;
  try {
    await fs.cp(bundle.bundlePath, stage, { recursive: true, force: true });
    try {
      await fs.rename(destination, backup);
      movedExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.rename(stage, destination);
    if (movedExisting) await fs.rm(backup, { recursive: true, force: true });
    return destination;
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    if (movedExisting) {
      await fs.rm(destination, { recursive: true, force: true });
      await fs.rename(backup, destination).catch(() => {});
    }
    throw error;
  }
}

async function rebuildExternalBundleIndex(
  projectDir: string,
  graph: 'project' | 'user',
  verbose: boolean,
): Promise<void> {
  const originalLog = console.log;
  if (!verbose) console.log = () => {};
  try {
    const [{ buildIndex }, { syncFortemiCoreIndex }] = await Promise.all([
      import('../../artifacts/index-builder.js'),
      import('../../artifacts/fortemi-core-sync.js'),
    ]);
    await buildIndex(projectDir, { graph, force: true, explicit: false });
    syncFortemiCoreIndex(projectDir, { graph });
  } finally {
    console.log = originalLog;
  }
  ui.dim(`  Refreshed ${graph}-scope capability index`);
}

/** User OMP writes use native ownership receipts instead of an unconditional copy. */
async function deployOmpUserSource(opts: {
  frameworkRoot: string; source: string; target: string; bundle: string; copyAll: boolean; mode?: string;
}): Promise<void> {
  const adapter = await import(pathToFileURL(path.join(opts.frameworkRoot, 'tools/agents/providers/omp.mjs')).href);
  await adapter.deploy({ srcRoot: opts.source, target: opts.target, provider: 'omp', scope: 'user',
    mode: opts.mode ?? 'general', deployCommands: true, deploySkills: true, deployRules: true,
    copyStandardSkills: opts.copyAll, quiet: true, deployVersion: (await getVersionInfo()).version });
  const sourceBundles = new Set([opts.source]);
  const { resourceDirs } = resolveOmpPaths({ cwd: opts.target });
  const entries: Record<'agents' | 'commands' | 'skills' | 'rules' | 'behaviors', string[]> = {
    agents: [], commands: [], skills: [], rules: [], behaviors: [],
  };
  const belongsToBundle = (entry: { provider?: string; source?: string; transformation?: string }) => {
    if (entry.provider !== 'omp' || typeof entry.source !== 'string') return false;
    if (entry.transformation === 'omp-extension') return true;
    const relative = path.relative(opts.source, entry.source);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const locations = resourceDirs;
  for (const kind of Object.keys(entries) as Array<keyof typeof entries>) {
    const directory = locations[kind];
    if (kind === 'skills') {
      let children: string[]; try { children = await fs.readdir(directory); } catch { continue; }
      for (const child of children) {
        try {
          const receipt = JSON.parse(await fs.readFile(path.join(directory, child, '.aiwg-manifest.json'), 'utf8'));
          if (receipt.managed?.['SKILL.md'] && belongsToBundle(receipt.managed['SKILL.md'])) {
            entries.skills.push(child);
            const source = receipt.managed['SKILL.md'].source;
            if (typeof source === 'string') sourceBundles.add(path.dirname(path.dirname(path.dirname(source))));
          }
        } catch { /* operator resources have no OMP receipt */ }
      }
    } else {
      try {
        const receipt = JSON.parse(await fs.readFile(path.join(directory, '.aiwg-manifest.json'), 'utf8'));
        entries[kind] = Object.entries(receipt.managed ?? {}).filter(([, entry]) =>
          belongsToBundle(entry as { provider?: string; source?: string; transformation?: string })).map(([name]) => name);
      } catch { /* no deployed resources of this kind */ }
    }
  }
  for (const source of sourceBundles) await reconcileDeployedSkillAssets(source, opts.target, 'omp',
    { strictReferences: false, scope: 'user', skipUndeployed: !opts.copyAll });
  const { recordUserDeploy } = await import('../../config/user-registry.js');
  await recordUserDeploy({ framework: opts.bundle, provider: 'omp',
    version: (await getVersionInfo()).version, source: 'bundled',
    counts: { agents: entries.agents.length, commands: entries.commands.length,
      skills: entries.skills.length, rules: entries.rules.length }, entries });
}

async function mirrorProjectLocalBundleToUserScope(opts: {
  bundle: ProjectLocalBundle;
  provider: string;
  target: string;
}): Promise<void> {
  const paths = getProviderPaths(opts.provider);
  const resolveProjectPath = (value: string): string =>
    !value ? '' : path.isAbsolute(value) ? value : path.join(opts.target, value);
  const mirrored = await mirrorToUserScope(opts.provider, {
    agents: resolveProjectPath(paths.agents),
    skills: resolveProjectPath(paths.skills),
    kernelSkills: resolveProjectPath(getProviderKernelSkillsPath(opts.provider)),
    commands: resolveProjectPath(paths.commands),
    rules: resolveProjectPath(paths.rules),
    behaviors: resolveProjectPath(paths.behaviors),
  });
  const counts = {
    agents: mirrored.agents.count,
    commands: mirrored.commands.count,
    skills: mirrored.skills.count,
    rules: mirrored.rules.count,
  };
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    throw new Error(`External bundle '${opts.bundle.id}' produced no user-scope artifacts for ${opts.provider}`);
  }
  const { recordUserDeploy } = await import('../../config/user-registry.js');
  await recordUserDeploy({
    framework: opts.bundle.id,
    provider: opts.provider,
    version: opts.bundle.manifest.version,
    source: 'project-local',
    counts,
    entries: {
      agents: mirrored.agents.entries,
      commands: mirrored.commands.entries,
      skills: mirrored.skills.entries,
      rules: mirrored.rules.entries,
      behaviors: mirrored.behaviors.entries,
    },
    manifestHash: await hashManifest(path.join(opts.bundle.bundlePath, 'manifest.json')),
  });
}

/**
 * Use command handler
 *
 * Deploys framework agents, commands, and skills to the current project,
 * then registers them in the extension registry for discovery.
 */
const USE_HELP = `Usage: aiwg use <bundle> [options]

Deploy an AIWG framework, addon, or extension into the current project.

Bundles:
  all                       Kernel surface only (kernel skills, rules, behaviors)
  sdlc | research | ops | forensics | marketing | media-curator | ...
                            Full framework surface (agents, commands, skills, rules)
  <addon> | <extension>     Any installed addon or extension name

Options:
  --provider <name>         Target provider (default: .aiwg/aiwg.config providers)
  --target <dir>            Deploy into <dir> instead of the current directory
  --scope project|user      Deploy to the project (default) or the user scope
  --force                   Re-write every artifact, replacing files AIWG does
                            not currently manage. Use this to reclaim a
                            directory left behind by an older AIWG install.
  --copy-all                Mirror standard-tier skills into the project instead
                            of relying on index-driven discovery
  --dry-run                 Preview the deployment without writing files
  --verbose, -v             Show per-artifact deploy decisions
  --json                    Emit the machine-readable deployment result
  --no-project-local        Skip project-local bundles under .aiwg/
  --no-context-files        Skip WORKSPACE.md / AIWG.md / AGENTS.md emission
  -h, --help                Show this help without deploying

Deployment counts report what the run wrote or already manages. Files AIWG does
not own are listed separately as unmanaged and are never counted as deployed.
`;

export class UseHandler implements CommandHandler {
  id = 'use';
  name = 'Use Framework';
  description = 'Deploy AIWG framework to project or user scope';
  category = 'framework' as const;
  aliases: string[] = [];
  private orchestrationDepth = 0;

  async help(): Promise<HandlerResult> {
    return { exitCode: 0, message: USE_HELP, rawOutput: true };
  }

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const requestedBundle = firstUsePositional(ctx.args)
      ?? (ctx.args[0] === '--profile' ? 'all' : undefined);
    const bypassOrchestration = this.orchestrationDepth > 0
      || !requestedBundle
      || requestedBundle === 'cockpit'
      || ctx.args.includes('--workspace-signals');
    if (bypassOrchestration) return this.executeCore(ctx);

    this.orchestrationDepth += 1;
    try {
      return await this.executeOrchestrated(ctx, requestedBundle);
    } finally {
      this.orchestrationDepth -= 1;
    }
  }

  private async executeOrchestrated(
    ctx: HandlerContext,
    requestedBundle: string,
  ): Promise<HandlerResult> {
    const startedAt = new Date().toISOString();
    const json = ctx.args.includes('--json');
    const coreArgs = ctx.args.filter((arg) => arg !== '--json');
    const remainingArgs = removeFirstPositional(coreArgs);
    const projectDir = getProjectDir(ctx, remainingArgs);
    const frameworkRoot = ctx.frameworkRoot || await getFrameworkRoot();
    const config = await readAiwgConfig(projectDir);
    const requestedProviders = configuredGlobalProviders(remainingArgs, config);
    const providers: string[] = [];
    for (const requestedProvider of requestedProviders) {
      const local = await resolveProjectLocalProviderAdapter(projectDir, requestedProvider);
      const builtIn = local.requestedProvider
        ? local.provider
        : resolveBuiltInProviderForUse(local.provider).provider;
      if (!providers.includes(builtIn)) providers.push(builtIn);
    }
    const dryRun = remainingArgs.includes('--dry-run');
    const requestedScope: DeploymentScope = remainingArgs.includes('--global')
      ? 'user'
      : detectScope(remainingArgs);
    const contextOptOut = [
      '--no-context-files',
      '--no-workspace-md',
      '--no-aiwg-md',
      '--no-agents-md',
    ].some((flag) => remainingArgs.includes(flag));

    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    if (json) {
      machineReadableUseDepth += 1;
      console.log = () => {};
      console.info = () => {};
      console.warn = () => {};
      console.error = () => {};
    }

    let coreResult: HandlerResult;
    try {
      coreResult = await this.executeCore({ ...ctx, args: coreArgs });
    } finally {
      if (json) {
        machineReadableUseDepth -= 1;
        console.log = originalConsole.log;
        console.info = originalConsole.info;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;
      }
    }

    let result: UseDeploymentResult;
    if (dryRun && coreResult.exitCode === 0) {
      result = buildDryRunUseResult({
        projectRoot: projectDir,
        frameworkRoot,
        providers,
        scope: requestedScope,
        requestedBundles: [requestedBundle],
        contextOptOut,
      });
    } else {
      if (coreResult.exitCode === 0 && !dryRun && !VALID_FRAMEWORKS.includes(requestedBundle as Framework)) {
        for (const provider of providers) {
          await ensurePostDeployPhases({
            frameworkRoot,
            projectPath: projectDir,
            provider,
            args: remainingArgs,
            invocationStartedAt: startedAt,
          });
        }
      }
      const providerResults = [];
      for (const provider of providers) {
        const effectiveScope: DeploymentScope = provider === 'openclaw' || provider === 'openhuman'
          ? 'user'
          : requestedScope;
        if (coreResult.exitCode === 0 && !dryRun) {
          try {
            const receiptOptions = {
              projectRoot: projectDir,
              frameworkRoot,
              provider,
              scope: effectiveScope,
              requestedBundles: [requestedBundle],
            };
            const sourceResolution = await resolveProviderReceiptSource(receiptOptions);
            await finalizeProviderTransformationReceipt({ ...receiptOptions, ...sourceResolution });
          } catch (error) {
            await finalizeProviderTransformationReceipt({
              projectRoot: projectDir,
              frameworkRoot,
              provider,
              scope: effectiveScope,
              requestedBundles: [requestedBundle],
              sourceDisposition: 'verification-failed',
            }).catch(() => undefined);
            originalConsole.warn(`Provider receipt finalization failed for ${provider}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        providerResults.push(await verifyProviderDeployment({
          projectRoot: projectDir,
          frameworkRoot,
          provider,
          scope: effectiveScope,
          requestedBundles: [requestedBundle],
          contextOptOut,
          invocationStartedAt: dryRun ? undefined : startedAt,
          deploymentExitCode: coreResult.exitCode,
          deploymentMessage: coreResult.message,
          // A normal first deployment has no authenticated verifier handoff
          // yet, so receipt absence belongs in doctor/status rather than
          // degrading an otherwise successful `aiwg use` result.
          reportMissingReceipt: false,
        }));
      }
      result = aggregateUseDeploymentResult({
        projectRoot: projectDir,
        frameworkRoot,
        scope: requestedScope,
        requestedBundles: [requestedBundle],
        providers: providerResults,
      });
      if (dryRun) {
        result.dryRun = true;
        result.exitClassification = 'failure';
      }
    }

    if (json) {
      return { exitCode: result.exitCode, message: JSON.stringify(result, null, 2), rawOutput: true };
    }
    const verbose = coreArgs.includes('--verbose') || coreArgs.includes('-v');
    const versionInfo = await getVersionInfo().catch(() => null);
    const widthFromEnvironment = Number(process.env.COLUMNS);
    const width = Number.isFinite(process.stdout.columns) && process.stdout.columns > 0
      ? process.stdout.columns
      : Number.isFinite(widthFromEnvironment) && widthFromEnvironment > 0
        ? widthFromEnvironment
        : 100;
    const canonicalProvider = result.providers[0]?.provider ?? 'claude';
    const rendered = renderUseDeploymentResult(result, {
      verbose,
      width,
      version: versionInfo
        ? { version: versionInfo.version, repository: versionInfo.repoUrl || 'aiwg.io' }
        : undefined,
      nextSteps: verbose && result.outcome !== 'failed' && VALID_FRAMEWORKS.includes(requestedBundle as Framework)
        ? nextStepsFor(requestedBundle as Framework, canonicalProvider)
        : undefined,
    });
    return {
      exitCode: result.exitCode,
      message: [coreResult.message, rendered].filter(Boolean).join('\n'),
    };
  }

  private async executeCore(ctx: HandlerContext): Promise<HandlerResult> {
    const explicitTarget = firstUsePositional(ctx.args);

    if (ctx.args.includes('--workspace-signals')) {
      const signalArgs = ctx.args.filter((a) => a !== '--workspace-signals');
      const profileIdx = signalArgs.findIndex((a) => a === '--profile');
      const profile = profileIdx >= 0 && signalArgs[profileIdx + 1]
        ? signalArgs[profileIdx + 1]
        : undefined;
      const requestedTarget = firstUsePositional(signalArgs);
      const remainingSignalArgs = requestedTarget
        ? removeFirstPositional(signalArgs)
        : signalArgs;
      const projectDir = getProjectDir(ctx, remainingSignalArgs);
      const plan = await resolveWorkspaceSignalPlan(projectDir, { profile, requestedTarget });
      return {
        exitCode: 0,
        message: formatWorkspaceSignalPlan(plan),
      };
    }

    let framework = ctx.args[0];
    let remainingArgs = ctx.args.slice(1);
    if (framework === '--profile') {
      framework = 'all';
      remainingArgs = ctx.args;
    }
    const modelDeployArgs = collectUseModelDeployArgs(remainingArgs);
    if (framework === 'cockpit') {
      return installCockpit(ctx, remainingArgs);
    }

    // Check before auto-init, global staging, or deployment can alter a project.
    // Web lookup does not materialize the corpus required by bundled setup.
    if (VALID_FRAMEWORKS.includes(framework as Framework)) {
      const prerequisite = await bundledSetupPrerequisiteMessage(ctx.frameworkRoot || await getFrameworkRoot());
      if (prerequisite) return { exitCode: 1, message: prerequisite };
    }

    // Structured logger for this invocation. Records go to both stderr (if
    // verbose level) and ~/.aiwg/logs/aiwg-YYYY-MM-DD.jsonl with full
    // provenance (invocation_id, aiwg_version, git_sha, etc.). #925.
    const log = getLogger('cli:use', { framework: framework ?? '<all>' });
    const span = log.span('use');

    // Resolve --prefix as alias for --target (#734)
    // --prefix is more intuitive for "deploy to a project directory" in cloud-init/CI
    const prefixIdx = remainingArgs.findIndex(a => a === '--prefix');
    if (prefixIdx >= 0 && remainingArgs[prefixIdx + 1]) {
      // Rewrite --prefix to --target for downstream compatibility
      remainingArgs[prefixIdx] = '--target';
    }

    // Global bootstrap deliberately avoids a persistent project artifact
    // deployment. Build the normal provider output in an isolated staging
    // directory, let the established user-scope mirror/registry path consume
    // it, then discard the stage and emit only lightweight project context.
    // `--scope user` remains additive for compatibility; `--global` is the
    // explicit no-project-deploy contract.
    if (remainingArgs.includes('--global')) {
      const scopeIdx = remainingArgs.indexOf('--scope');
      if (scopeIdx >= 0 && remainingArgs[scopeIdx + 1] === 'project') {
        return { exitCode: 1, message: 'Error: --global conflicts with --scope project' };
      }
      const contextTargetIdx = remainingArgs.indexOf('--target');
      const contextTarget = path.resolve(
        contextTargetIdx >= 0 && remainingArgs[contextTargetIdx + 1]
          ? remainingArgs[contextTargetIdx + 1]
          : (ctx.cwd || process.cwd()),
      );
      const externalDiscovery = await discoverProjectLocalBundles(contextTarget);
      const externalBundle = framework
        ? externalDiscovery.bundles.find(bundle => bundle.id === framework)
        : undefined;
      const isFrameworkTarget = Boolean(framework && VALID_FRAMEWORKS.includes(framework as Framework));
      if (!framework || (!isFrameworkTarget && !externalBundle)) {
        return {
          exitCode: 1,
          message: 'Error: --global target must be a bundled framework or a valid external project-local bundle',
        };
      }
      const originalConfig = await readAiwgConfig(contextTarget);
      const providers = configuredGlobalProviders(remainingArgs, originalConfig);
      const dryRun = remainingArgs.includes('--dry-run');
      const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-global-bootstrap-'));

      try {
        if (externalBundle) {
          const stagedBundle = path.join(
            stageRoot,
            '.aiwg',
            PROJECT_LOCAL_TYPE_TO_DIR[externalBundle.type],
            externalBundle.id,
          );
          await fs.mkdir(path.dirname(stagedBundle), { recursive: true });
          await fs.cp(externalBundle.bundlePath, stagedBundle, { recursive: true, force: true });
        }
        for (const provider of providers) {
          const innerArgs = [
            framework,
            ...removeGlobalBootstrapFlags(remainingArgs),
            '--provider', provider,
            '--scope', 'user',
            '--target', stageRoot,
            ...(externalBundle ? [] : ['--no-project-local']),
            '--no-context-files',
            '--no-hooks',
            '--no-workspace-signals',
          ];
          const result = await this.execute({ ...ctx, cwd: stageRoot, args: innerArgs });
          if (result.exitCode !== 0) return result;
          if (!dryRun) {
            await fs.mkdir(contextTarget, { recursive: true });
            await generateGlobalProjectContext({
              provider: normalizeProviderDefinitionId(provider) ?? provider,
              projectPath: contextTarget,
              args: remainingArgs,
            });
          }
        }
      } finally {
        await fs.rm(stageRoot, { recursive: true, force: true });
      }

      return {
        exitCode: 0,
        message: dryRun
          ? `Global ${externalBundle ? 'external bundle' : 'bootstrap'} preview complete; project context target: ${contextTarget}`
          : `Global ${externalBundle ? 'external bundle' : 'bootstrap'} complete; user assets installed and capability index refreshed`,
      };
    }

    // Project-isolation warning (UC-NUA-002 / SAD §5.1). Fires once per CLI
    // process. Skipped when --target/--prefix is explicit (the user named a
    // destination) so the warning never fights with intentional out-of-cwd
    // deploys. Skipped on recursive iteration via the module-level guard.
    if (!projectIsolationChecked) {
      projectIsolationChecked = true;
      const userTargetedExplicitDir = remainingArgs.includes('--target');
      if (!userTargetedExplicitDir) {
        const isolationResult = await maybeWarnProjectIsolation({ cwd: ctx.cwd ?? process.cwd() });
        if (isolationResult.cancelled) {
          // User pressed Ctrl-C during the delay — exit cleanly with no
          // artifacts written (UC-NUA-002 Alt A2).
          return { exitCode: 130, message: 'Cancelled.' };
        }
      }
    }

    // Read project config for config-first resolution (#621).
    // projectDir resolution uses the shared helper so --target/--prefix,
    // ctx.cwd, and process.cwd() fallback are handled consistently across
    // handlers (#919 cleanup).
    const targetFlagIdx = remainingArgs.findIndex(a => a === '--target');
    const targetDir = targetFlagIdx >= 0 && remainingArgs[targetFlagIdx + 1]
      ? remainingArgs[targetFlagIdx + 1]
      : null;
    const projectDir = getProjectDir(ctx, remainingArgs);
    let config = await readAiwgConfig(projectDir);

    // Auto-init when no config found (#720)
    // Check early for --provider/--platform and --providers flags
    const _providerFlagIdx = remainingArgs.findIndex(a => a === '--provider' || a === '--platform');
    const _hasExplicitProvider = _providerFlagIdx >= 0 && !!remainingArgs[_providerFlagIdx + 1];
    const _providersFlagIdx = remainingArgs.findIndex(a => a === '--providers');
    const _providersValue = _providersFlagIdx >= 0 ? remainingArgs[_providersFlagIdx + 1] : null;
    const _isDryRun = remainingArgs.includes('--dry-run');

    // Bulk/automation intent: `aiwg use all` and `aiwg use --yes` skip the
    // init wizard and use sensible defaults so CLI calls never hang waiting
    // on a detached terminal. Users who want the wizard run `aiwg init`.
    const _isBulkIntent = framework === 'all'
      || remainingArgs.includes('--yes')
      || remainingArgs.includes('-y')
      || remainingArgs.includes('--non-interactive');

    if (!config) {
      if (_providersValue) {
        // --providers shorthand: write config without wizard
        const pList = _providersValue === 'default'
          ? ['claude']
          : _providersValue.split(',').map(s => s.trim()).filter(Boolean);
        config = emptyConfig(pList.length > 0 ? pList : ['claude']);
        if (!_isDryRun) await writeAiwgConfig(projectDir, config);
      } else if (_isBulkIntent || targetDir || _hasExplicitProvider || !process.stdin.isTTY) {
        // Non-interactive: auto-create minimal config with explicit provider or default (#734)
        // When --prefix/--target is set, or `use all`, or --yes is passed, we're in
        // automated mode — no wizard, no prompts, no way to hang on stdin.
        const autoProvider = _hasExplicitProvider ? remainingArgs[_providerFlagIdx + 1] : 'claude';
        config = emptyConfig([autoProvider]);
        if (!_isDryRun) await writeAiwgConfig(projectDir, config);
        if (!_isDryRun && _isBulkIntent && framework === 'all') {
          ui.dim(`  No .aiwg/aiwg.config found — auto-created with provider '${autoProvider}'. Ask your AIWG agent to review repo/tracker/delivery policy.`);
        }
      } else if (process.stdin.isTTY) {
        // Interactive terminal with no config → run init wizard inline (#720)
        const initResult = await initHandler.execute({ ...ctx, args: [] });
        if (initResult.exitCode !== 0) return initResult;
        config = await readAiwgConfig(projectDir);
      }
    }

    // Zero-arg form: `aiwg use` with no framework → redeploy all installed to all providers
    if (!framework) {
      if (!config || Object.keys(config.installed).length === 0) {
        const advisory = !config
          ? "\n\nRun 'aiwg init', then ask your AIWG agent to establish providers, tracker, and delivery policy."
          : '';
        return {
          exitCode: 1,
          message: `Error: Framework, addon, or extension name required\nFrameworks: sdlc, marketing, media-curator, research, forensics, dfir, security-engineering, ops, validation, knowledge-base, all\nAddons: rlm, ring, daemon, aiwg-dev (full list: \`aiwg list\`)\nExtensions: sys, net, it, sec, stream, dev (full list: \`ls $AIWG_ROOT/agentic/code/extensions\`)\n'all' deploys every framework + every addon + every extension.${advisory}`,
        };
      }
      const installedNames = Object.keys(config.installed);
      const redeployProviders = config.providers.length > 0 ? config.providers : ['claude'];
      ui.blank();
      ui.header(`  Redeploying ${installedNames.length} framework(s) to ${redeployProviders.join(', ')}...`);
      for (const name of installedNames) {
        for (const p of redeployProviders) {
          const result = await this.execute({ ...ctx, args: [name, '--provider', p] });
          if (result.exitCode !== 0) return result;
        }
      }
      return { exitCode: 0 };
    }

    // Handler contexts already carry the active installation root. Respect it
    // so linked worktrees, embedded callers, and tests do not silently deploy
    // artifacts from a different channel checkout.
    const frameworkRoot = ctx.frameworkRoot || await getFrameworkRoot();

    if (framework === 'all' && explicitTarget !== 'all' && !remainingArgs.includes('--no-workspace-signals')) {
      const profileIdx = remainingArgs.findIndex((a) => a === '--profile');
      const profile = profileIdx >= 0 && remainingArgs[profileIdx + 1]
        ? remainingArgs[profileIdx + 1]
        : undefined;
      const plan = await resolveWorkspaceSignalPlan(projectDir, { profile, requestedTarget: framework });
      const selectedFrameworks = includedBundleIds(plan, 'framework');
      const selectedAddons = includedBundleIds(plan, 'addon');
      const selectedExtensions = includedBundleIds(plan, 'extension');

      const providerIdx = remainingArgs.findIndex(a => a === '--provider' || a === '--platform');
      const explicitProvider = providerIdx >= 0 && remainingArgs[providerIdx + 1] ? remainingArgs[providerIdx + 1] : null;
      let providersForFiltered: string[];
      if (explicitProvider) {
        providersForFiltered = [explicitProvider];
      } else if (_providersValue) {
        providersForFiltered = _providersValue === 'default'
          ? ['claude']
          : _providersValue.split(',').map(s => s.trim()).filter(Boolean);
      } else if (config && config.providers.length > 0) {
        providersForFiltered = config.providers;
      } else {
        providersForFiltered = ['claude'];
      }

      const targetIdx = remainingArgs.findIndex(a => a === '--target');
      const target = targetIdx >= 0 && remainingArgs[targetIdx + 1] ? remainingArgs[targetIdx + 1] : process.cwd();
      const dryRun = remainingArgs.includes('--dry-run');
      const verbose = remainingArgs.includes('--verbose') || remainingArgs.includes('-v');
      const force = remainingArgs.includes('--force');
      const copyAll = remainingArgs.includes('--copy-all') || remainingArgs.includes('--copy-standard-skills');
      const quiet = machineReadableUseDepth > 0 || (!verbose && !dryRun);

      ui.blank();
      ui.header(`  Workspace-aware deployment (${plan.profile})`);
      ui.dim(`  Included frameworks: ${selectedFrameworks.join(', ') || '(none)'}`);
      ui.dim(`  Included addons: ${selectedAddons.join(', ') || '(none)'}`);
      if (selectedExtensions.length > 0) {
        ui.dim(`  Included extensions: ${selectedExtensions.join(', ')}`);
      }
      ui.dim('  Use `aiwg use all` for the full deployment.');

      for (const providerName of providersForFiltered) {
        const kernelOnly = !copyAll;
        for (const selected of selectedFrameworks) {
          const frameworkDir = resolveFrameworkDir(selected);
          if (!frameworkDir) continue;
          const result = await deploySourceDirectory({
            ctx,
            frameworkRoot,
            source: path.join(frameworkRoot, 'agentic/code/frameworks', frameworkDir),
            provider: providerName,
            target,
            dryRun,
            verbose,
            force,
            copyAll,
            kernelOnly,
            quiet,
            modelArgs: modelDeployArgs,
          });
          if (result.exitCode !== 0) return result;
        }

        for (const selected of selectedAddons) {
          const result = await deploySourceDirectory({
            ctx,
            frameworkRoot,
            source: addonPath(frameworkRoot, selected),
            provider: providerName,
            target,
            dryRun,
            verbose,
            force,
            copyAll,
            kernelOnly,
            quiet,
            modelArgs: modelDeployArgs,
          });
          if (result.exitCode !== 0) return result;
        }

        for (const selected of selectedExtensions) {
          const result = await deploySourceDirectory({
            ctx,
            frameworkRoot,
            source: extensionPath(frameworkRoot, selected),
            provider: providerName,
            target,
            dryRun,
            verbose,
            force,
            copyAll,
            kernelOnly,
            quiet,
            modelArgs: modelDeployArgs,
          });
          if (result.exitCode !== 0) return result;
        }

        if (!remainingArgs.includes('--no-project-local')) {
          const plResult = await deployProjectLocalBundles({
            ctx,
            frameworkRoot,
            projectDir,
            provider: providerName,
            target,
            dryRun,
            verbose,
            quiet: machineReadableUseDepth > 0 || (!verbose && !dryRun),
            modelArgs: modelDeployArgs,
          });
          if (plResult.failed > 0) {
            ui.warn(`${plResult.failed} project-local bundle(s) failed to deploy`);
          }
        }

        await ensureProviderGeneratedDirsIgnored(target, providerName, { dryRun, verbose });

        if (!dryRun) {
          try {
            const registry = getRegistry();
            const paths = getProviderPaths(providerName);
            await registerDeployedExtensions(registry, {
              agentsPath: paths.agents,
              skillsPath: paths.skills,
              commandsPath: paths.commands,
              rulesPath: paths.rules,
              behaviorsPath: paths.behaviors,
              provider: providerName,
              cwd: target,
            });

            const counts = await countDeployedArtifacts(target, paths, providerName);
            if (quiet) {
              ui.blank();
              if (counts.agents > 0) ui.deployCount('Agents', counts.agents);
              if (counts.commands > 0) ui.deployCount('Commands', counts.commands);
              if (counts.skills > 0) ui.deployCount('Skills', counts.skills);
              if (counts.rules > 0) ui.deployCount('Rules', counts.rules);
              if (counts.behaviors > 0) ui.deployCount('Behaviors', counts.behaviors);
              ui.blank();
              printSessionReloadNotice(providerName);
            }
          } catch (error) {
            ui.warn(`Filtered deployment registration failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      if (!remainingArgs.includes('--dry-run')) {
        await writeWorkspaceSignalPlan(projectDir, plan);
      }

      return { exitCode: 0 };
    }

    const isFramework = VALID_FRAMEWORKS.includes(framework as Framework);
    const isAddon = !isFramework && await isValidAddon(frameworkRoot, framework);
    // Extensions live in `agentic/code/extensions/<name>/` and are addon-shaped
    // bundles. We treat them as addons for deployment purposes (#1222) — when
    // the user runs `aiwg use sys` we resolve to the extension source dir and
    // deploy via the addon code path below by remapping `addonPath()` lookup.
    const isExtension = !isFramework && !isAddon
      && (await getAllExtensions(frameworkRoot)).includes(framework);

    // Project-local bundle resolution: when the name doesn't match an upstream
    // framework, addon, or extension, check `.aiwg/{extensions,addons,
    // frameworks,plugins,providers}/<id>/` for a matching bundle. (#1035)
    if (!isFramework && !isAddon && !isExtension) {
      const discovery = await discoverProjectLocalBundles(projectDir);
      const match = discovery.bundles.find(b => b.id === framework);
      if (match) {
        if (match.type === 'provider') {
          return {
            exitCode: 1,
            message: `Project-local provider '${match.id}' is selected with --provider.\n\nExample: aiwg use sdlc --provider ${match.id}`,
          };
        }

        const providerIdx = remainingArgs.findIndex(a => a === '--provider' || a === '--platform');
        const explicitProvider = providerIdx >= 0 && remainingArgs[providerIdx + 1] ? remainingArgs[providerIdx + 1] : null;
        const dryRunSingle = remainingArgs.includes('--dry-run');
        const verboseSingle = remainingArgs.includes('--verbose') || remainingArgs.includes('-v');
        const targetIdxSingle = remainingArgs.findIndex(a => a === '--target');
        const targetSingle = targetIdxSingle >= 0 && remainingArgs[targetIdxSingle + 1] ? remainingArgs[targetIdxSingle + 1] : projectDir;
        let scopeSingle: 'project' | 'user';
        try {
          scopeSingle = detectScope(remainingArgs);
          if (scopeSingle === 'project' && remainingArgs.includes('--user')) {
            scopeSingle = 'user';
          }
        } catch (error) {
          return {
            exitCode: 1,
            message: `Error: ${error instanceof Error ? error.message : String(error)}`,
          };
        }

        // Multi-provider expansion mirrors the framework path
        let providersForSingle: string[];
        if (explicitProvider) providersForSingle = [explicitProvider];
        else if (config && config.providers.length > 0) providersForSingle = config.providers;
        else providersForSingle = ['claude'];

        const resolvedProviders: string[] = [];
        for (const requestedProvider of providersForSingle) {
          const provider = normalizeProviderDefinitionId(requestedProvider);
          if (!provider) {
            return {
              exitCode: 1,
              message: `External bundle '${match.id}' cannot deploy to unsupported provider '${requestedProvider}'. Choose a provider declared in its manifest.`,
            };
          }
          const support = match.manifest.platforms[provider as keyof typeof match.manifest.platforms]
            ?? match.manifest.platforms.generic;
          if (!support || support === 'none') {
            const declared = Object.entries(match.manifest.platforms)
              .filter(([, level]) => level && level !== 'none')
              .map(([name]) => name)
              .join(', ');
            return {
              exitCode: 1,
              message: `External bundle '${match.id}' does not declare support for provider '${provider}'. Declared providers: ${declared || 'none'}.`,
            };
          }
          if (scopeSingle === 'user' && !USER_SCOPE_PATHS[provider]) {
            return {
              exitCode: 1,
              message: `External bundle '${match.id}' cannot install at user scope for provider '${provider}' because AIWG has no user-scope path contract for it.`,
            };
          }
          resolvedProviders.push(provider);
        }

        let totalDeployed = 0;
        let totalFailed = 0;
        for (const p of resolvedProviders) {
          const r = await deployProjectLocalBundles({
            ctx, frameworkRoot, projectDir, provider: p, target: targetSingle,
            dryRun: dryRunSingle, verbose: verboseSingle, quiet: !verboseSingle && !dryRunSingle,
            onlyBundleId: framework,
            modelArgs: modelDeployArgs,
          });
          totalDeployed += r.deployed;
          totalFailed += r.failed;
          if (r.deployed > 0 && scopeSingle === 'user' && !dryRunSingle) {
            try {
              await mirrorProjectLocalBundleToUserScope({
                bundle: match,
                provider: p,
                target: targetSingle,
              });
            } catch (error) {
              totalFailed += 1;
              ui.warn(`Failed to install external bundle '${match.id}' for user-scope provider '${p}': ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }

        if (totalDeployed > 0 && totalFailed === 0 && !dryRunSingle) {
          try {
            await rebuildExternalBundleIndex(projectDir, 'project', verboseSingle);
            if (scopeSingle === 'user') {
              await installProjectLocalBundleInUserCatalog(match);
              await rebuildExternalBundleIndex(projectDir, 'user', verboseSingle);
            }
          } catch (error) {
            totalFailed += 1;
            ui.warn(`External bundle '${match.id}' index refresh failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        if (!verboseSingle && !dryRunSingle) {
          ui.blank();
          if (totalFailed === 0) {
            const scopeLabel = scopeSingle === 'user' ? 'project + user' : 'project';
            ui.success(`external ${match.type} '${match.id}' installed at ${scopeLabel} scope (${totalDeployed} provider(s)); capability index refreshed`);
          }
        }
        return {
          exitCode: totalFailed > 0 ? 1 : 0,
          message: totalFailed > 0 ? `${totalFailed} project-local deploy(s) failed` : '',
        };
      }

      return {
        exitCode: 1,
        message: `Error: Unknown target '${framework}'\nFrameworks: ${VALID_FRAMEWORKS.join(', ')}\n\n'all' deploys every framework + every addon + every extension.\nFor a single addon, run 'aiwg list' to see available addons.\nFor extensions (sys, net, it, sec, stream, dev), see $AIWG_ROOT/agentic/code/extensions/.\nFor project-local artifacts, run 'aiwg list --project-local'.\nRun 'aiwg help' for usage information.`,
      };
    }

    // Handle addon-only or extension-only deployment.
    // Extensions are addon-shaped bundles — same code path, different source dir.
    if (isAddon || isExtension) {
      const providerIdx = remainingArgs.findIndex(a => a === '--provider' || a === '--platform');
      const explicitAddonProvider = providerIdx >= 0 && remainingArgs[providerIdx + 1] ? remainingArgs[providerIdx + 1] : null;
      const provider = resolveBuiltInProviderForUse(explicitAddonProvider ?? (config?.providers?.[0] ?? 'claude')).provider;
      const targetIdx = remainingArgs.findIndex(a => a === '--target');
      const target = targetIdx >= 0 && remainingArgs[targetIdx + 1] ? remainingArgs[targetIdx + 1] : process.cwd();
      const dryRunAddon = remainingArgs.includes('--dry-run');
      let addonScope: 'project' | 'user';
      try {
        addonScope = detectScope(remainingArgs);
        if (addonScope === 'project' && remainingArgs.includes('--user')) addonScope = 'user';
      } catch (error) {
        return { exitCode: 1, message: `Error: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (addonScope === 'user' && !USER_SCOPE_PATHS[provider]) {
        return {
          exitCode: 1,
          message: `--scope user not supported for provider '${provider}' — see docs/customization/user-scope-deployment.md for the supported list`,
        };
      }

      const runner = createScriptRunner(frameworkRoot);
      const addonBaseArgs = ['--deploy-commands', '--deploy-skills', '--deploy-rules'];
      // An explicitly selected upstream addon must be self-contained in the
      // project. Unlike a full framework deploy, its standard skills cannot be
      // left index-only: the user asked to install this specific bundle and
      // its supporting scripts must travel with the skill directory.
      addonBaseArgs.push('--copy-all');
      addonBaseArgs.push(...modelDeployArgs);
      if (provider) addonBaseArgs.push('--provider', provider);
      if (target) addonBaseArgs.push('--target', target);
      // Forward --copy-all (#1219) so addon-only deploys also honor it.
      if ((remainingArgs.includes('--copy-all') || remainingArgs.includes('--copy-standard-skills'))
          && !addonBaseArgs.includes('--copy-all')) {
        addonBaseArgs.push('--copy-all');
      }
      if (dryRunAddon) addonBaseArgs.push('--dry-run');

      const kind = isExtension ? 'extension' : 'addon';
      const activationOrder = isAddon
        ? await resolveRequiredAddonActivationOrder(frameworkRoot, framework)
        : [framework];
      const requiredAddons = activationOrder.slice(0, -1);

      for (const dependency of requiredAddons) {
        ui.blank();
        ui.header(`  Deploying required ${dependency} addon...`);
        const dependencySource = addonPath(frameworkRoot, dependency);
        const dependencyResult = await runner.run('tools/agents/deploy-agents.mjs', [
          '--quiet', '--source', dependencySource,
          ...addonBaseArgs,
        ], { capture: true });
        if (dependencyResult.exitCode !== 0) {
          return {
            ...dependencyResult,
            message: dependencyResult.message
              || `Failed to deploy required addon '${dependency}'`,
          };
        }
        if (!dryRunAddon) {
          try {
            await reconcileDeployedSkillAssets(dependencySource, target, provider, { strictReferences: false });
          } catch (error) {
            return {
              exitCode: 1,
              message: `Required addon '${dependency}' skill asset deployment failed: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
        try {
          await registerSourceCliCommands({
            source: dependencySource,
            target,
            provider,
            dryRun: dryRunAddon,
            fallbackDescription: `${dependency} addon commands`,
          });
        } catch (error) {
          return {
            exitCode: 1,
            message: `Failed to register required addon '${dependency}' CLI commands: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        ui.success(dryRunAddon
          ? `Required ${dependency} addon activation previewed`
          : `Required ${dependency} addon deployed`);
      }

      ui.blank();
      ui.header(`  Deploying ${framework} ${kind}...`);
      const addonSource = isExtension
        ? extensionPath(frameworkRoot, framework)
        : addonPath(frameworkRoot, framework);
      const addonResult = await runner.run('tools/agents/deploy-agents.mjs', [
        '--quiet', '--source', addonSource,
        ...addonBaseArgs,
      ], { capture: true });

      if (addonResult.exitCode !== 0) {
        return addonResult;
      }

      if (!dryRunAddon) {
        try {
          await reconcileDeployedSkillAssets(addonSource, target, provider, { strictReferences: false });
        } catch (error) {
          return {
            exitCode: 1,
            message: `${kind} '${framework}' skill asset deployment failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      if (!dryRunAddon && provider === 'omp' && (detectScope(remainingArgs) === 'user' || remainingArgs.includes('--user'))) {
        try { await deployOmpUserSource({ frameworkRoot, source: addonSource, target, bundle: framework, copyAll: true }); }
        catch (error) { return { exitCode: 1, message: `OMP user deployment failed: ${error instanceof Error ? error.message : String(error)}` }; }
      }

      // Register only artifacts actually written by a confirmed deployment.
      if (!dryRunAddon) {
        try {
          const registry = getRegistry();
          const paths = getProviderPaths(provider);
          await registerDeployedExtensions(registry, {
            agentsPath: paths.agents,
            skillsPath: paths.skills,
            commandsPath: paths.commands,
            rulesPath: paths.rules,
            behaviorsPath: paths.behaviors,
            provider,
            cwd: target,
          });
          ui.success('Extension registration complete');
        } catch (error) {
          ui.warn(`Failed to register extensions: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Register CLI commands if addon declares them
      try {
        await registerSourceCliCommands({
          source: addonSource,
          target,
          provider,
          dryRun: dryRunAddon,
          fallbackDescription: `${framework} addon commands`,
        });
      } catch (error) {
        return {
          exitCode: 1,
          message: `Failed to register CLI commands: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      // Persist the same lifecycle record frameworks and project-local bundles
      // receive so status, refresh, doctor, and remove can account for this
      // upstream addon and every provider artifact it actually deployed.
      if (!dryRunAddon && config) {
        try {
          const manifestPath = path.join(addonSource, 'manifest.json');
          const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
            version?: string;
          };
          // Provider rule aggregation may rename many source rules into one
          // managed index. Record this addon's contributed artifact counts,
          // matching framework registry semantics, rather than trying to
          // attribute shared aggregate filenames after deployment.
          const counts = await countBundleSourceArtifacts(addonSource);
          const updated = updateInstalled(config, framework, provider, counts, {
            version: manifest.version ?? (await getVersionInfo()).version,
            source: 'bundled',
            manifestHash: await hashManifest(manifestPath),
          });
          await writeAiwgConfig(projectDir, updated);
          config = updated;
        } catch (error) {
          ui.warn(`Addon registry update failed for '${framework}': ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Profile picker for addons with memory topology and multiple templates
      try {
        const profileManifestPath = path.join(addonSource, 'manifest.json');
        const profileManifestContent = await fs.readFile(profileManifestPath, 'utf-8');
        const profileManifest = JSON.parse(profileManifestContent);

        const topology = profileManifest.memory?.topology;
        const templates = profileManifest.templates;

        if (topology && templates && templates.length > 1) {
          const profileIdx = remainingArgs.findIndex(a => a === '--profile');
          let selectedProfile: string | undefined;

          if (profileIdx >= 0 && remainingArgs[profileIdx + 1]) {
            // Explicit --profile flag
            selectedProfile = remainingArgs[profileIdx + 1];
            const templateFile = templates.find((t: string) =>
              t.replace('.md', '') === selectedProfile || t === selectedProfile
            );
            if (!templateFile) {
              ui.warn(`Unknown profile "${selectedProfile}". Available: ${templates.map((t: string) => t.replace('.md', '')).join(', ')}`);
              selectedProfile = undefined;
            }
          } else if (_isBulkIntent || !process.stdin.isTTY) {
            // Bulk/automation or non-TTY: silently pick 'generic' default.
            // The profile picker is annoying during `aiwg use all`.
            selectedProfile = 'generic';
          } else if (process.stdin.isTTY) {
            // Interactive profile selection via the shared `listSelect` helper
            // (POC for spike #926). One call renders the option list, handles
            // number-or-name matching, threads `ctx.signal` for Ctrl-C
            // cancellation, and resolves to the fallback on timeout or empty
            // input. The hand-rolled parse-and-branch that used to live here
            // is now a one-liner.
            const { createPromptInterface, listSelect } = await import('../prompt-utils.js');
            ui.blank();
            ui.header('  Select a topology profile:');
            const templateNames = templates.map((t: string) => t.replace('.md', ''));
            const options = templateNames.map((name: string) => ({
              label: name === 'generic' ? `${name} (default)` : name,
              value: name,
            }));

            const rl = createPromptInterface();
            try {
              selectedProfile = await listSelect(
                rl,
                '  Enter number or name [generic]: ',
                options,
                'generic',
                ctx.signal,
              );
            } finally {
              rl.close();
            }
          }

          // Write profile config to project namespace
          if (selectedProfile && !dryRunAddon) {
            const namespace = topology.namespace || `.aiwg/${framework}`;
            const configDir = path.join(target, namespace);
            await fs.mkdir(configDir, { recursive: true });
            const profileConfig = {
              profile: selectedProfile,
              pageTemplate: `templates/${selectedProfile}.md`,
              selectedAt: new Date().toISOString(),
            };
            await fs.writeFile(
              path.join(configDir, 'config.json'),
              JSON.stringify(profileConfig, null, 2) + '\n'
            );
            ui.success(`Profile "${selectedProfile}" selected → ${namespace}/config.json`);
          }
        }
      } catch {
        // Profile selection is optional — don't fail deployment
      }

      if (framework === 'aiwg-utils' && !['pi', 'omp'].includes(provider) && !remainingArgs.includes('--dry-run')) {
        const wrapperValidation = await validateDeployedModelWrappers({
          provider: normalizeProviderDefinitionId(provider) ?? provider,
          target,
          frameworkRoot,
          modelDeployArgs,
          filtered: remainingArgs.includes('--filter') || remainingArgs.includes('--filter-role'),
          verbose: remainingArgs.includes('--verbose') || remainingArgs.includes('-v'),
        });
        if (wrapperValidation) return wrapperValidation;
      }

      ui.blank();
      ui.success(dryRunAddon
        ? `${framework} addon activation preview complete`
        : `${framework} addon deployed`);
      return {
        exitCode: 0,
      };
    }

    // Map framework name to deploy mode
    const mode = MODE_MAP[framework as Framework];
    const deployArgs = ['--mode', mode, '--deploy-commands', '--deploy-skills', '--deploy-rules', ...remainingArgs];

    // Check flags
    const skipUtils = remainingArgs.includes('--no-utils');
    const skipProjectLocal = remainingArgs.includes('--no-project-local');
    const verbose = remainingArgs.includes('--verbose') || remainingArgs.includes('-v');
    const dryRun = remainingArgs.includes('--dry-run');
    const ciHooksEnabled = remainingArgs.includes('--ci-hooks-enabled');
    const force = remainingArgs.includes('--force');
    const skipConflicts = remainingArgs.includes('--skip-conflicts');
    const explicitHarnessAgentSelectors = parseOpenHumanHarnessAgentSelector(remainingArgs);

    // PUW-027 (#1128): --scope user|project per ADR-4. Default project.
    // #1156 Phase 1: --user is a shorthand for --scope user.
    let scope: 'project' | 'user';
    try {
      scope = detectScope(remainingArgs);
      if (scope === 'project' && remainingArgs.includes('--user')) {
        scope = 'user';
      }
    } catch (err) {
      return {
        exitCode: 1,
        message: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (scope === 'user' && verbose) {
      ui.dim(`  --scope user: deploy targets mirror to home-rooted paths per ADR-4 §2`);
    }
    const filteredArgs = deployArgs.filter(
      a => a !== '--no-utils' && a !== '--no-project-local' && a !== '--ci-hooks-enabled' && a !== '--force' && a !== '--skip-conflicts' && a !== '--no-harness-agents'
    );
    const deployFilteredArgs = removeFlagWithOptionalValue(filteredArgs, '--harness-agents');

    // Pass --quiet to suppress deploy-agents.mjs header/footer in default mode (#460)
    // Human dry-run remains verbose; machine-readable dry-run captures the
    // preview so stdout stays a single JSON document.
    if (machineReadableUseDepth > 0 || (!verbose && !dryRun)) deployFilteredArgs.push('--quiet');

    // Extract provider and target from remainingArgs to pass to addon deployments
    // Config-first resolution (#621): explicit --provider overrides config, config overrides default 'claude'
    const providerIdx = remainingArgs.findIndex(a => a === '--provider' || a === '--platform');
    const explicitProvider = providerIdx >= 0 && remainingArgs[providerIdx + 1] ? remainingArgs[providerIdx + 1] : null;

    // Determine providers list for multi-provider deployment
    let providers: string[];
    if (explicitProvider) {
      providers = [explicitProvider];
    } else if (config && config.providers.length > 0) {
      providers = config.providers;
    } else {
      providers = ['claude'];
      if (!config) {
        ui.warn("No .aiwg/aiwg.config found. Run 'aiwg init', then ask your AIWG agent to configure this project properly.");
      }
    }

    // Multi-provider: loop over providers, deploying to each in sequence
    if (providers.length > 1) {
      for (const p of providers) {
        const result = await this.execute({ ...ctx, args: [framework, '--provider', p, ...remainingArgs] });
        if (result.exitCode !== 0) return result;
      }
      return { exitCode: 0 };
    }

    const requestedProvider = providers[0];
    const projectLocalProviderResolution = await resolveProjectLocalProviderAdapter(projectDir, requestedProvider);
    const builtInProviderResolution = projectLocalProviderResolution.requestedProvider
      ? { provider: projectLocalProviderResolution.provider, requestedProvider: projectLocalProviderResolution.requestedProvider }
      : resolveBuiltInProviderForUse(projectLocalProviderResolution.provider);
    const unsupportedMessage = projectLocalProviderResolution.requestedProvider
      ? null
      : unsupportedProviderMessage(requestedProvider);
    if (unsupportedMessage) {
      return { exitCode: 1, message: unsupportedMessage };
    }
    if (requestedProvider.trim().toLowerCase() === 'windsurf') {
      ui.warn("Provider id 'windsurf' is deprecated; use '--provider devin' for Devin Desktop. Existing .windsurf/ output paths remain supported.");
    }
    const provider = builtInProviderResolution.provider;
    const providerDeployArgs = builtInProviderResolution.requestedProvider
      ? withProviderOverride(deployFilteredArgs, provider)
      : deployFilteredArgs;
    const bulkKernelOnly = framework === 'all'
      && !['pi', 'omp'].includes(provider)
      && !remainingArgs.includes('--copy-all')
      && !remainingArgs.includes('--copy-standard-skills');
    if (bulkKernelOnly) providerDeployArgs.push('--kernel-only');
    const targetIdx = remainingArgs.findIndex(a => a === '--target');
    const target = targetIdx >= 0 && remainingArgs[targetIdx + 1] ? remainingArgs[targetIdx + 1] : process.cwd();

    if ((verbose || dryRun) && projectLocalProviderResolution.requestedProvider) {
      ui.dim(`  project-local provider '${projectLocalProviderResolution.requestedProvider}' extends '${provider}'`);
    } else if ((verbose || dryRun) && builtInProviderResolution.requestedProvider) {
      ui.dim(`  provider alias '${builtInProviderResolution.requestedProvider}' resolves to '${provider}'`);
    }

    if (explicitHarnessAgentSelectors.length > 0 && provider !== 'openhuman') {
      return {
        exitCode: 1,
        message: '--harness-agents is only supported with --provider openhuman',
      };
    }

    // #1526 / OpenHuman source alignment — OpenClaw and OpenHuman are
    // user-global app installs. An unflagged deploy should work; explicit
    // `--scope project` is rejected below.
    if ((provider === 'openclaw' || provider === 'openhuman') && scope === 'project' && !remainingArgs.includes('--scope')) {
      scope = 'user';
    }

    // #1156 Phase 1 — home-dir providers reject explicit --scope project.
    try {
      rejectOpenClawProjectScope(provider, scope);
    } catch (err) {
      return {
        exitCode: 1,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // #1156 Phase 1 — Reject --scope user for providers that don't have a
    // documented user-scope path map. Operators get a clear error rather than a
    // silent fall-through to project-only deployment.
    if (scope === 'user') {
      const { USER_SCOPE_PATHS } = await import('../scope-resolver.js');
      if (!USER_SCOPE_PATHS[provider]) {
        return {
          exitCode: 1,
          message: `--scope user not supported for provider '${provider}' — see docs/customization/user-scope-deployment.md for the supported list`,
        };
      }
    }

    // Pre-deployment collision check (skip in dry-run — nothing is written)
    if (!dryRun) {
      const canDeploy = await runPreDeployCollisionCheck({
        frameworkRoot,
        framework,
        target,
        provider,
        force,
        skipConflicts,
        verbose,
      });
      if (!canDeploy) {
        return { exitCode: 1, message: 'Deployment blocked due to name collisions. See above for details.' };
      }
    }

    // Deploy main framework
    const quiet = machineReadableUseDepth > 0 || (!verbose && !dryRun);
    const captureOpts = quiet ? { capture: true } : {};
    if (quiet) {
      const installLabel = framework === 'all'
        ? 'Installing complete AIWG surface'
        : `Installing ${framework} framework`;
      const providerLabel = getProviderDefinition(provider)?.displayName ?? provider;
      ui.blank();
      console.log(`  ${ui.brandMark()} ${ui.bold(installLabel)}  ${ui.dimText(`for ${providerLabel}`)}`);
      ui.blank();
    }
    const runner = createScriptRunner(ctx.frameworkRoot);
    const mainResult = await runner.run('tools/agents/deploy-agents.mjs', providerDeployArgs, captureOpts);

    if (mainResult.exitCode !== 0) {
      return mainResult;
    }

    const harnessAgentSelectors = provider === 'openhuman'
      ? resolveOpenHumanHarnessAgentSelectors(remainingArgs)
      : [];
    if (harnessAgentSelectors.length > 0) {
      try {
        const harness = await deployOpenHumanHarnessAgents({
          frameworkRoot,
          target,
          selectors: harnessAgentSelectors,
          scope: 'user',
          dryRun,
        });
        if (verbose || !quiet) {
          ui.dim(`  OpenHuman native harness agents: ${harness.emitted}`);
        }
      } catch (error) {
        return {
          exitCode: 1,
          message: `OpenHuman harness agent deployment failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // Build common args for addon deployments (inherit provider and target)
    const addonBaseArgs = ['--deploy-commands', '--deploy-skills', '--deploy-rules'];
    if (bulkKernelOnly) addonBaseArgs.push('--kernel-only');
    addonBaseArgs.push(...modelDeployArgs);
    if (provider) addonBaseArgs.push('--provider', provider);
    if (target) addonBaseArgs.push('--target', target);
    if (dryRun) addonBaseArgs.push('--dry-run');
    if (verbose) addonBaseArgs.push('--verbose');
    // Forward --copy-all to addon deploys so the legacy mirror behavior
    // is consistent across the framework + every addon (#1219).
    if (remainingArgs.includes('--copy-all') || remainingArgs.includes('--copy-standard-skills')) {
      addonBaseArgs.push('--copy-all');
    }

    // Deploy all addons (excluding disallow list) unless --no-utils
    if (!skipUtils) {
      const allAddons = await getAllAddons(frameworkRoot);
      for (const addon of allAddons) {
        if (verbose) {
          console.log('');
          console.log(`Deploying ${addon} addon...`);
        }
        const source = addonPath(frameworkRoot, addon);
        const addonArgs = quiet
          ? ['--quiet', '--source', source, ...addonBaseArgs]
          : ['--source', source, ...addonBaseArgs];
        const result = await runner.run('tools/agents/deploy-agents.mjs', addonArgs, captureOpts);
        if (result.exitCode !== 0) {
          return result;
        }
        try {
          await registerSourceCliCommands({
            source,
            target,
            provider,
            dryRun,
            fallbackDescription: `${addon} addon commands`,
          });
        } catch (error) {
          ui.warn(`Failed to register CLI commands for '${addon}': ${(error as Error).message}`);
        }
      }

      // Deploy all extensions from agentic/code/extensions/* (#1222).
      // Extensions are addon-shaped bundles (manifest type: "addon") that live
      // in a separate top-level dir to keep ops/sysops/itops/devops grouped.
      // `aiwg use all` was previously silent about them, leaving 6 extension
      // bundles undeployed even when the user explicitly asked for everything.
      const allExtensions = await getAllExtensions(frameworkRoot);
      for (const ext of allExtensions) {
        if (verbose) {
          console.log('');
          console.log(`Deploying ${ext} extension...`);
        }
        const source = extensionPath(frameworkRoot, ext);
        const extArgs = quiet
          ? ['--quiet', '--source', source, ...addonBaseArgs]
          : ['--source', source, ...addonBaseArgs];
        const result = await runner.run('tools/agents/deploy-agents.mjs', extArgs, captureOpts);
        if (result.exitCode !== 0) {
          return result;
        }
        try {
          await registerSourceCliCommands({
            source,
            target,
            provider,
            dryRun,
            fallbackDescription: `${ext} extension commands`,
          });
        } catch (error) {
          ui.warn(`Failed to register CLI commands for '${ext}': ${(error as Error).message}`);
        }
      }
    }

    // Deploy project-local bundles (#1035). Auto-runs after upstream addons unless
    // --no-project-local. Idempotent — overwrites prior deploys. Skipped under
    // --dry-run-disabled scenarios for safety; --dry-run is honored and logged.
    if (!skipProjectLocal) {
      const plResult = await deployProjectLocalBundles({
        ctx,
        frameworkRoot,
        projectDir,
        provider,
        target,
        dryRun,
        verbose,
        quiet,
        modelArgs: modelDeployArgs,
      });
      if (plResult.deployed > 0 && quiet) {
        ui.dim(`  + ${plResult.deployed} project-local bundle(s)`);
      }
      if (plResult.failed > 0) {
        ui.warn(`${plResult.failed} project-local bundle(s) failed to deploy`);
      }
    }

    await ensureProviderGeneratedDirsIgnored(target, provider, { dryRun, verbose });

    const paths = getProviderPaths(provider);
    // Pi model selection/headless routing is delivered by #2151. Until that
    // adapter exists, do not require model-wrapper artifacts that Pi cannot
    // load; resource deployment remains independently valid.
    if (!dryRun && !skipUtils && !bulkKernelOnly && !['pi', 'omp'].includes(provider)) {
      const wrapperValidation = await validateDeployedModelWrappers({
        provider,
        target,
        frameworkRoot,
        modelDeployArgs,
        filtered: remainingArgs.includes('--filter') || remainingArgs.includes('--filter-role'),
        verbose,
      });
      if (wrapperValidation) return wrapperValidation;
    }
    const targetSkillsDir = resolveProviderPath(target, paths.skills);
    const targetCommandsDir = paths.commands ? resolveProviderPath(target, paths.commands) : '';
    const kernelSkillsPath = getProviderKernelSkillsPath(provider);
    const targetKernelSkillsDir = kernelSkillsPath ? resolveProviderPath(target, kernelSkillsPath) : '';

    // Translate deployed skills to commands for providers that require legacy command format.
    // (#550) Skills are canonical; commands are generated deployment artifacts.
    if (!bulkKernelOnly && providerNeedsCommands(provider) && targetCommandsDir) {
      try {
        const translationResult = await translateSkillsToCommands(targetSkillsDir, {
          provider,
          targetDir: targetCommandsDir,
          projectPath: target,
          dryRun,
          verbose,
          deployVersion: (await getVersionInfo()).version,
        });
        if (verbose && translationResult.translated.length > 0) {
          ui.success(`Translated ${translationResult.translated.length} skills → commands (${provider})`);
        }
      } catch (error) {
        ui.warn(`Skill→command translation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Mirror deterministic operator workflows to each provider's native
    // command/prompt surface when one exists. This applies even when a
    // provider loads skills natively: users still expect setup, update,
    // status, intake, and flow workflows to show up in the provider's `/`
    // command picker where supported.
    if (!bulkKernelOnly && targetCommandsDir) {
      try {
        const standardMirrored = await mirrorStandardCommandSkills({
          provider,
          target,
          targetCommandsDir,
          targetSkillsDir,
          frameworkRoot,
          dryRun,
          verbose,
        });
        if (verbose && standardMirrored > 0) {
          ui.success(`Mirrored ${standardMirrored} operator skills → commands (${provider})`);
        }

        // Mirror the kernel self-maintenance set (aiwg-regenerate, -doctor,
        // -refresh, -status, -help, -issue, -pr, -mission, use, steward) to
        // the provider's command surface so these bootstrap entry points are
        // *copied in* for direct `/`-access — not discovery-only. This matches
        // the standard operator mirror above (which already deploys /intake-*
        // and /flow-* on skills-native providers like Claude/Cursor), and makes
        // the wrapper's own callout true ("…directly invokable as slash
        // commands"). `aiwg discover` remains the backstop for the long tail.
        //
        // Supersedes the #1382 gate (`&& providerNeedsCommands(provider)`),
        // which suppressed these on Claude/Cursor to avoid a skill+command
        // duplicate `/` entry. The direct bootstrap entry point is worth that
        // redundancy — the same skill+command coexistence already shipped for
        // the standard operator set. Gated on `targetCommandsDir` only, so
        // providers without a command dir (Hermes/OpenHuman) still no-op.
        if (targetKernelSkillsDir) {
          const kernel = await translateSkillsToCommands(targetKernelSkillsDir, {
            provider,
            targetDir: targetCommandsDir,
            projectPath: target,
            dryRun,
            verbose,
            deployVersion: (await getVersionInfo()).version,
            nameFilter: shouldMirrorKernelCommandSkill,
          });
          if (verbose && kernel.translated.length > 0) {
            ui.success(`Mirrored ${kernel.translated.length} kernel skills → commands (${provider})`);
          }
        }
      } catch (error) {
        ui.warn(`Skill→command mirror failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Register deployed extensions in the registry
    if (verbose) {
      console.log('');
      console.log('Registering deployed extensions...');
    }
    try {
      const registry = getRegistry();
      const paths = getProviderPaths(provider);

      await registerDeployedExtensions(registry, {
        agentsPath: paths.agents,
        skillsPath: paths.skills,
        commandsPath: paths.commands,
        rulesPath: paths.rules,
        behaviorsPath: paths.behaviors,
        provider,
        cwd: target,
        quiet: !verbose,
      });

      if (verbose) console.log('Extension registration complete');
    } catch (error) {
      console.error('Warning: Failed to register extensions:', error instanceof Error ? error.message : String(error));
      // Don't fail the deployment if registration fails
    }

    // Rebuild the `framework` artifact index (#1212/#1214) so
    // `aiwg discover` queries return fresh capability data. This step
    // can take a few seconds on a full install (~2,000 artifacts) —
    // surface the work to the operator so the apparent stall during
    // `aiwg use` is legible. Best-effort — index rebuild failure must
    // not fail the deploy.
    //
    // Pre-flight: skip when the framework source dirs aren't present
    // (e.g., test fixtures, deploy from npm install rather than the
    // source repo). buildIndex() calls `process.exit(1)` on missing
    // scan dirs which would short-circuit our catch.
    if (!dryRun) {
      // Build the framework graph against $AIWG_ROOT, not the project's
      // target dir (#1217). The framework source is user-global at
      // AIWG_ROOT — recording AIWG_ROOT-relative paths makes the index
      // resolvable from any project. Falls back to project target only
      // if AIWG_ROOT is unset or unreadable (rare).
      const aiwgRootForIndex = process.env.AIWG_ROOT || frameworkRoot || target;
      const fwSrcDir = path.join(aiwgRootForIndex, 'agentic', 'code', 'frameworks');
      const hasFrameworkSrc = await fs.access(fwSrcDir).then(() => true).catch(() => false);
      if (hasFrameworkSrc) {
        // Always announce the index build — this is the visible-to-user
        // expensive step on a full install (~2,000 artifacts indexed).
        // Without messaging, the operator sees an apparent stall after
        // the deploy summary. Verbose mode lets buildIndex's own
        // progress through; otherwise we show a single-line spinner-
        // style message and capture the noisy stat lines.
        ui.blank();
        ui.info('Building capability index…');
        ui.dim('  Indexing operational assets for agent-side lookup.');

        const indexStart = Date.now();
        // Capture buildIndex's own console.log noise unless verbose
        const origLog = console.log;
        if (!verbose) console.log = () => {};
        try {
          const { buildIndex } = await import('../../artifacts/index-builder.js');
          // Build against AIWG_ROOT so stored paths resolve from any
          // project (#1217). The output index location is XDG-shared
          // regardless of build cwd.
          await buildIndex(aiwgRootForIndex, { graph: 'framework', explicit: false });
          const { syncFortemiCoreIndex } = await import('../../artifacts/fortemi-core-sync.js');
          syncFortemiCoreIndex(aiwgRootForIndex, { graph: 'framework' });
          console.log = origLog;
          const indexElapsedSec = ((Date.now() - indexStart) / 1000).toFixed(1);
          ui.success(`Capability index ready (${indexElapsedSec}s).`);
        } catch (error) {
          console.log = origLog;
          ui.warn(
            `Capability index build failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          ui.dim('  Deploy succeeded — skills are reachable, but agent-side capability search may be stale until the next rebuild.');
        }
      } else if (verbose) {
        console.log('Framework source not found; skipping capability index rebuild');
      }
    }

    // Collect deployment counts for registry persistence and the final
    // orchestrated report. Presentation happens once, after verification, so
    // users do not see a second competing summary.
    //
    // Counts are always populated from the on-disk artifacts so that the
    // registry record written below (#621) reflects the real deploy even on
    // a verbose run — the prior `if (quiet)` guard left the record
    // `{agents: 0, commands: 0, skills: 0, rules: 0}` on `-v` runs.
    const counts = await countDeployedArtifacts(target, paths, provider);

    // Deploy CI workflow files when --ci-hooks-enabled is set (#661)
    if (ciHooksEnabled) {
      await deployCiHooks({ frameworkRoot, framework, target, dryRun });
    }

    // PUW-027 (#1128), #1156 Phase 1 — --scope user: mirror the full
    // per-provider artifact set (agents/commands/skills/rules) to the
    // user-scope target per ADR-4 §2. The project-scope deploy stays in
    // place; user-scope copies are additive so the framework is available
    // across every project on the operator's machine. After a successful
    // mirror, record the deploy in the per-user registry at
    // ~/.aiwg/installed.json so `aiwg list --scope user` and `aiwg remove
    // --scope user` can find it from any cwd.
    if (scope === 'user' && provider === 'omp' && !dryRun) {
      try {
        await deployOmpUserSource({ frameworkRoot, source: frameworkRoot, target, bundle: framework, mode,
          copyAll: remainingArgs.includes('--copy-all') || remainingArgs.includes('--copy-standard-skills') });
      } catch (error) { return { exitCode: 1, message: `OMP user deployment failed: ${error instanceof Error ? error.message : String(error)}` }; }
    }
    if (scope === 'user' && provider !== 'openhuman' && provider !== 'omp' && !dryRun) {
      try {
        const paths = getProviderPaths(provider);
        const resolveProjectPath = (p: string): string =>
          !p ? '' : path.isAbsolute(p) ? p : path.join(target, p);
        const projectPaths = {
          agents: resolveProjectPath(paths.agents),
          skills: resolveProjectPath(paths.skills),
          kernelSkills: resolveProjectPath(getProviderKernelSkillsPath(provider)),
          commands: resolveProjectPath(paths.commands),
          rules: resolveProjectPath(paths.rules),
          behaviors: resolveProjectPath(paths.behaviors),
        };
        const r = await mirrorToUserScope(provider, projectPaths);
        const summary: string[] = [];
        if (r.agents.count > 0) summary.push(`${r.agents.count} agent(s)`);
        if (r.commands.count > 0) summary.push(`${r.commands.count} command(s)`);
        if (r.skills.count > 0) summary.push(`${r.skills.count} skill(s)`);
        if (r.rules.count > 0) summary.push(`${r.rules.count} rule(s)`);
        if (r.behaviors.count > 0) summary.push(`${r.behaviors.count} behavior(s)`);
        if (summary.length > 0) {
          // Show the per-type breakdown plus the primary user-scope target dir.
          // Prefer skills.targetDir as the surfaced location since most providers
          // share `~/.<provider>/` for the others.
          const headline = r.skills.targetDir || r.agents.targetDir || r.commands.targetDir || r.rules.targetDir;
          ui.dim(`  --scope user: mirrored ${summary.join(', ')} to ${headline}`);

          // Record the deploy in the per-user registry. Counts come from the
          // mirror result so they reflect what actually landed at user scope,
          // not what was deployed at project scope (the two can diverge if
          // some artifact dirs were empty in the project tree). Entry names
          // are recorded so `aiwg remove --scope user` can revert precisely
          // (delete only this deploy's artifacts, not other frameworks').
          try {
            const { recordUserDeploy } = await import('../../config/user-registry.js');
            const versionInfo = await getVersionInfo().catch(() => ({ version: 'unknown' }));
            await recordUserDeploy({
              framework,
              provider,
              version: versionInfo.version,
              source: 'bundled',
              counts: {
                agents: r.agents.count,
                commands: r.commands.count,
                skills: r.skills.count,
                rules: r.rules.count,
              },
              entries: {
                agents: r.agents.entries,
                commands: r.commands.entries,
                skills: r.skills.entries,
                rules: r.rules.entries,
                behaviors: r.behaviors.entries,
              },
            });
          } catch (registryErr) {
            ui.warn(`user-scope registry update failed: ${registryErr instanceof Error ? registryErr.message : String(registryErr)}`);
          }
        }
      } catch (err) {
        ui.warn(`--scope user mirror failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // PUW-010 (#1111) Claude Code aiwg-hooks autoInstall — wire the
    // addon's JS handler scripts into .claude/settings.json with backup-
    // and-rollback per ADR-3 §5. Default ON for Claude per ADR-3 §7;
    // operator opts out via --no-hooks.
    if (provider === 'claude' && !dryRun && !remainingArgs.includes('--no-hooks')) {
      try {
        const r = await installAiwgHooks({
          projectPath: target,
          frameworkRoot,
          dryRun,
          verbose,
        });
        if (r) {
          if (verbose && r.installedScripts.length > 0) {
            ui.dim(`  aiwg-hooks: installed ${r.installedScripts.length} hook scripts to .claude/hooks/`);
          }
          if (verbose && r.registeredEvents.length > 0) {
            for (const event of r.registeredEvents) {
              ui.dim(`  aiwg-hooks registered: ${event}`);
            }
          }
          if (r.backupPath) {
            ui.dim(`  aiwg-hooks: backed up settings.json to ${r.backupPath}`);
          }
          for (const w of r.warnings) {
            ui.dim(`  aiwg-hooks: ${w}`);
          }
        }
      } catch (err) {
        ui.warn(`aiwg-hooks installer: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // PUW-018 (#1119) cross-provider hook bridge — opt-in via
    // --enable-cross-provider-hooks. When enabled and at least one canonical
    // hook source exists at agentic/code/addons/aiwg-hooks/canonical/*.yaml,
    // translate to provider-native artifacts (Codex TOML, Copilot JSON,
    // Factory shell, Hermes Python plugin). Per ADR-3 §7 autoInstall policy
    // this is opt-in.
    if (remainingArgs.includes('--enable-cross-provider-hooks') && !dryRun) {
      try {
        const { loadHookSources, bridgeAll } = await import('../../smiths/hook-bridge/index.js');
        const { sources, errors } = await loadHookSources(frameworkRoot);
        if (errors.length > 0) {
          for (const err of errors) {
            ui.warn(`hook-bridge load: ${err}`);
          }
        }
        if (sources.length === 0) {
          if (verbose) {
            ui.dim('  hook-bridge: no canonical hook sources found at agentic/code/addons/aiwg-hooks/canonical/ — flag is a no-op');
          }
        } else {
          // Cross-provider providers per ADR-3 §7 (no-op if their dir not present)
          const bridgeProviders = ['codex', 'copilot', 'factory', 'hermes'];
          const results = await bridgeAll(sources, bridgeProviders, {
            projectPath: target,
            dryRun,
            verbose,
          });
          let emittedCount = 0;
          for (const r of results) {
            if (r.skipped) {
              if (verbose) ui.dim(`  hook-bridge skipped ${r.provider}: ${r.skipReason}`);
              continue;
            }
            emittedCount += r.emittedPaths.length;
            for (const w of r.warnings) ui.dim(`  hook-bridge ${r.provider}: ${w}`);
          }
          if (emittedCount > 0) {
            ui.dim(`  hook-bridge: emitted ${emittedCount} cross-provider hook artifact(s)`);
          }
        }
      } catch (err) {
        ui.warn(`hook-bridge: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Update installed section in config (#621)
    if (config !== null && !dryRun) {
      try {
        const versionInfo = await getVersionInfo();
        const versionDirName = resolveFrameworkDir(framework);
        const frameworkManifestPath = versionDirName
          ? path.join(frameworkRoot, 'agentic/code/frameworks', versionDirName, 'manifest.json')
          : null;
        if (!frameworkManifestPath) throw new Error('no manifest for general/writing mode');
        const mHash = await hashManifest(frameworkManifestPath);
        const updatedConfig = updateInstalled(config, framework, provider, {
          agents: counts.agents,
          commands: counts.commands,
          skills: counts.skills,
          rules: counts.rules,
        }, { version: versionInfo.version, source: 'bundled', manifestHash: mHash });
        await writeAiwgConfig(projectDir, updatedConfig);
      } catch {
        // Non-fatal: config tracking failure must not block deployment
      }
    }

    // Context-pipeline emission (ADR-1 §0 + §0.5 + §7).
    //
    // For AGENTS.md providers (codex/copilot/cursor/windsurf/hermes/warp/factory/
    // opencode), emit WORKSPACE.md + AIWG.md + provider adapters as the last filesystem
    // step before activity-log close. The generator-runs-after-deploy invariant
    // (ADR-1 §7) means the link index can only cite files we observe on disk:
    // failed deploys produce shorter indexes, never broken links.
    //
    // Operators opt out via --no-context-files / --no-aiwg-md / --no-agents-md.
    if (!dryRun) {
      const skipContext = remainingArgs.includes('--no-context-files');
      const skipWorkspaceMd = skipContext || remainingArgs.includes('--no-workspace-md');
      const skipAiwgMd = skipContext || remainingArgs.includes('--no-aiwg-md');
      const skipAgentsMd = skipContext || remainingArgs.includes('--no-agents-md');
      const forceContext = remainingArgs.includes('--force-context-files');

      try {
        const paths = getProviderPaths(provider);
        const sections = await discoverDeployedArtifacts(target, {
          agents: paths.agents,
          rules: paths.rules,
          skills: paths.skills,
          behaviors: paths.behaviors,
        });

        const ctxResult = await generateContextFiles({
          provider: provider as Platform,
          projectPath: target,
          sections,
          detectExistingFiles: true,
          force: forceContext,
          skip: { workspaceMd: skipWorkspaceMd, aiwgMd: skipAiwgMd, agentsMd: skipAgentsMd },
        });

        if (verbose && ctxResult.workspaceMdPath) {
          ui.dim(`  ${ctxResult.workspaceMdAction === 'created' ? 'Created' : 'Refreshed'} WORKSPACE.md`);
        }

        if (verbose && ctxResult.agentsMdPath) {
          ui.dim(`  Wrote AGENTS.md (${ctxResult.agentsMdBytes} bytes)`);
        }
        if (verbose && ctxResult.aiwgMdPath) {
          ui.dim(`  Wrote AIWG.md`);
        }
        if (verbose && ctxResult.normalizedAiwgMdPath) {
          ui.dim(`  Wrote .aiwg/AIWG.md`);
        }
        if (verbose && ctxResult.claudeMdHookPath && ctxResult.claudeMdHookAction && ctxResult.claudeMdHookAction !== 'unchanged') {
          // #1437: CLAUDE.md hook for claude provider; mirrors AGENTS.md for other providers.
          const verb =
            ctxResult.claudeMdHookAction === 'created' ? 'Created' :
            ctxResult.claudeMdHookAction === 'inserted' ? 'Inserted hook into' :
            ctxResult.claudeMdHookAction === 'updated' ? 'Updated hook in' :
            'Touched';
          ui.dim(`  ${verb} CLAUDE.md (@WORKSPACE.md then @AIWG.md block)`);
        }
        for (const w of ctxResult.warnings) {
          // #1579: loud warnings (non-managed twin/bridge left untouched) are
          // prefixed `WARNING:` and must render prominently, not dimmed, so the
          // consequence + remediation isn't buried in deploy output.
          if (w.startsWith('WARNING:')) {
            ui.warn(`context-pipeline: ${w.slice('WARNING:'.length).trim()}`);
          } else {
            ui.dim(`  context-pipeline: ${w}`);
          }
        }
        for (const b of ctxResult.backupPaths) {
          ui.dim(`  Backup created: ${b}`);
        }

        // PUW-029 size validation hook (#1130). Hard error at 32KB matches
        // Codex's config_toml.rs:68 cap. Soft warning at 30KB.
        if (provider === 'codex' && ctxResult.agentsMdBytes > 0) {
          if (ctxResult.agentsMdBytes >= 32 * 1024) {
            ui.dim(`  WARNING: AGENTS.md (${ctxResult.agentsMdBytes} bytes) exceeds Codex 32KB cap. Auto-split lands in PUW-029 implementation; manual split needed for now.`);
          } else if (ctxResult.agentsMdBytes >= 30 * 1024) {
            ui.dim(`  Note: AGENTS.md (${ctxResult.agentsMdBytes} bytes) approaches Codex 32KB cap (warn threshold 30KB).`);
          }
        }
      } catch (err) {
        // Non-fatal: context-pipeline emission must not block deployment.
        // Operator can re-run aiwg use to retry.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: context-pipeline emission failed: ${msg}`);
      }
    }

    span.end('use:complete', { framework });
    return {
      exitCode: 0,
      message: verbose ? `Successfully deployed ${framework} framework` : '',
    };
  }
}

/**
 * Create use handler instance
 */
export function createUseHandler(): CommandHandler {
  return new UseHandler();
}

/**
 * Singleton handler instance
 */
export const useHandler = new UseHandler();
