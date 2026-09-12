/**
 * Refresh Command Handler (formerly Sync)
 *
 * Ensures the active session's AIWG deployment matches the latest published
 * version under the current provider. Orchestrates: version check → update →
 * re-deploy all installed frameworks → health verification.
 *
 * Renamed from `aiwg sync` to `aiwg refresh` to avoid collision with
 * git repo sync semantics (#694). `aiwg sync` remains as a deprecated alias.
 *
 * @implements @agentic/code/frameworks/sdlc-complete/rules/self-maintenance.md
 * @source @src/cli/router.ts
 * @issue #173, #174, #482, #557, #694
 */

import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { promises as fs } from 'fs';
import { execFile } from 'node:child_process';
import path from 'path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { createScriptRunner } from './script-runner.js';
import { createUseHandler } from './use.js';
import { getFrameworkRoot } from '../../channel/manager.mjs';
import { refreshAllPackages } from '../../packages/registry.js';
import { resolveActiveProvider } from '../provider-resolution.js';
import {
  readAiwgConfig,
  writeAiwgConfig,
  hashManifest,
  getProviderParallelismDefaults,
} from '../../config/aiwg-config.js';
import { discoverProjectLocalBundles } from '../../extensions/project-local-discovery.js';
import { getProviderArtifactPathStrings } from '../../providers/provider-definitions.js';
import {
  collectPackagedAgentInventory,
  normalizeAgentArtifactName,
  parseManagedArtifactMarker,
} from '../../agents/packaged-agent-inventory.js';
import * as ui from '../ui.js';

const PROVIDER_AGENT_DIRS: Record<string, string> = {
  claude: '.claude/agents',
  codex: '.codex/agents',
  copilot: '.github/agents',
  cursor: '.cursor/agents',
  factory: '.factory/droids',
  opencode: '.opencode/agent',
  warp: '.warp/agents',
  windsurf: '.windsurf/agents',
};

export async function currentBundledAgentBasenames(frameworkRoot: string): Promise<Set<string>> {
  return new Set((await collectPackagedAgentInventory(frameworkRoot)).keys());
}

export interface ProviderStaleAgentRemoval {
  provider: string;
  paths: string[];
}

async function readFrameworkVersion(frameworkRoot: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(frameworkRoot, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : null;
  } catch {
    return null;
  }
}

function isOlderManagedVersion(deployedVersion: string, currentVersion: string): boolean {
  const parse = (version: string): { core: number[]; prerelease: string | null } | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version);
    return match
      ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ?? null }
      : null;
  };
  const deployed = parse(deployedVersion);
  const current = parse(currentVersion);
  if (!deployed || !current) return deployedVersion !== currentVersion;
  for (let index = 0; index < deployed.core.length; index += 1) {
    if (deployed.core[index] !== current.core[index]) {
      return deployed.core[index] < current.core[index];
    }
  }
  if (deployed.prerelease === current.prerelease) return false;
  if (deployed.prerelease === null) return false;
  if (current.prerelease === null) return true;
  return deployed.prerelease.localeCompare(current.prerelease, undefined, { numeric: true }) < 0;
}

/** Artifact classes considered when pruning a provider tree as a unit (#2506). */
type ProviderArtifactKind = 'agents' | 'commands' | 'rules';

const PRUNABLE_ARTIFACT_KINDS: readonly ProviderArtifactKind[] = ['agents', 'commands', 'rules'];

/**
 * Resolve the on-disk artifact directories for a provider.
 *
 * `PROVIDER_AGENT_DIRS` remains the enumeration of providers AIWG can prune;
 * the command/rule directories come from the provider definitions so the
 * unit-prune path never drifts from what `aiwg use` actually wrote.
 */
function providerArtifactDirs(provider: string): Record<ProviderArtifactKind, string | null> {
  const agents = PROVIDER_AGENT_DIRS[provider] ?? null;
  const declared = getProviderArtifactPathStrings(provider);
  const usable = (value: string | undefined): string | null =>
    typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) ? value : null;
  return {
    agents,
    commands: usable(declared?.commands),
    rules: usable(declared?.rules),
  };
}

interface ManagedArtifactHit {
  kind: ProviderArtifactKind;
  absolutePath: string;
  relativePath: string;
  version: string;
  artifactName: string;
}

/** Collect every AIWG-managed (`source: bundled`) artifact in one provider tree. */
async function collectManagedProviderArtifacts(
  projectRoot: string,
  provider: string,
  kinds: readonly ProviderArtifactKind[],
): Promise<ManagedArtifactHit[]> {
  const dirs = providerArtifactDirs(provider);
  const hits: ManagedArtifactHit[] = [];

  for (const kind of kinds) {
    const relDir = dirs[kind];
    if (!relDir) continue;
    const dir = path.join(projectRoot, relDir);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      // Generated indexes are rewritten on every deploy, never orphaned.
      if (entry.name === 'RULES-INDEX.md' || entry.name === 'RULES-ONDEMAND.md') continue;
      const file = path.join(dir, entry.name);
      let content;
      try {
        content = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const marker = parseManagedArtifactMarker(content);
      if (marker?.source !== 'bundled') continue;
      hits.push({
        kind,
        absolutePath: file,
        relativePath: path.relative(projectRoot, file),
        version: marker.version,
        artifactName: normalizeAgentArtifactName(entry.name),
      });
    }
  }

  return hits;
}

/**
 * Non-target provider trees left behind by an older package (#2506).
 *
 * A provider-scoped refresh reports these instead of mutating them, so the
 * operator decides whether to refresh, prune, or keep the tree.
 */
export interface ProviderStaleTree {
  provider: string;
  /** Oldest managed version observed in the tree. */
  version: string;
  counts: Record<ProviderArtifactKind, number>;
  total: number;
}

export async function detectStaleProviderTrees(options: {
  projectRoot: string;
  frameworkRoot: string;
  /** Provider refreshed in this invocation; its own tree is never reported. */
  provider?: string;
  currentVersion?: string;
}): Promise<ProviderStaleTree[]> {
  const currentVersion = options.currentVersion ?? await readFrameworkVersion(options.frameworkRoot);
  if (currentVersion === null) return [];

  const trees: ProviderStaleTree[] = [];
  for (const provider of Object.keys(PROVIDER_AGENT_DIRS)) {
    if (provider === options.provider) continue;
    const hits = (await collectManagedProviderArtifacts(options.projectRoot, provider, PRUNABLE_ARTIFACT_KINDS))
      .filter((hit) => isOlderManagedVersion(hit.version, currentVersion));
    if (hits.length === 0) continue;

    const counts: Record<ProviderArtifactKind, number> = { agents: 0, commands: 0, rules: 0 };
    for (const hit of hits) counts[hit.kind] += 1;
    const oldest = hits
      .map((hit) => hit.version)
      .reduce((a, b) => (isOlderManagedVersion(a, b) ? a : b));
    trees.push({ provider, version: oldest, counts, total: hits.length });
  }

  trees.sort((a, b) => a.provider.localeCompare(b.provider));
  return trees;
}

/**
 * Split project-relative paths into the ones git tracks and the ones it does not (#2509).
 *
 * Deleting an ignored, regenerable artifact and deleting a committed file are
 * not the same act. A project that is not a git repo — or a machine without
 * git — reports everything as untracked, so the caller behaves as before.
 */
export async function partitionTrackedPaths(
  projectRoot: string,
  relativePaths: string[],
): Promise<{ tracked: string[]; untracked: string[] }> {
  if (relativePaths.length === 0) return { tracked: [], untracked: [] };
  let trackedSet: Set<string>;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--', ...relativePaths],
      { cwd: projectRoot, maxBuffer: 32 * 1024 * 1024 },
    );
    trackedSet = new Set(stdout.split('\0').filter(Boolean));
  } catch {
    return { tracked: [], untracked: [...relativePaths] };
  }
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const relativePath of relativePaths) {
    // git reports POSIX separators regardless of platform.
    (trackedSet.has(relativePath.split(path.sep).join('/')) ? tracked : untracked).push(relativePath);
  }
  return { tracked, untracked };
}

export interface ProviderStalePruneResult {
  /** Artifacts removed (or, in dry-run, that would be removed). */
  removals: ProviderStaleAgentRemoval[];
  /** Tracked artifacts left in place because deleting them needs `--force` (#2509). */
  trackedSkipped: ProviderStaleAgentRemoval[];
}

export async function pruneStaleManagedAgentFiles(options: {
  projectRoot: string;
  frameworkRoot: string;
  /** Provider successfully refreshed in this invocation. */
  provider?: string;
  currentVersion?: string;
  dryRun?: boolean;
  /**
   * How to treat provider trees this run did not refresh (#2506).
   *
   * `skip` (default) leaves them entirely alone — a claude-scoped refresh must
   * never mutate `.codex/`. `prune` removes the whole tree as a unit
   * (agents + commands + rules) so the surface is never left half-deployed.
   */
  crossProvider?: 'skip' | 'prune';
  /**
   * Delete git-tracked artifacts during a cross-provider unit prune (#2509).
   *
   * Off by default: removing another provider's committed files is a working-
   * tree mutation the operator did not ask for when they refreshed this one.
   * The refreshed provider's own orphan cleanup is unaffected — pruning the
   * tree you just refreshed is that pass's purpose.
   */
  allowTrackedDeletes?: boolean;
}): Promise<ProviderStalePruneResult> {
  const desired = await currentBundledAgentBasenames(options.frameworkRoot);
  const currentVersion = options.currentVersion ?? await readFrameworkVersion(options.frameworkRoot);
  const crossProvider = options.crossProvider ?? 'skip';
  const removals: ProviderStaleAgentRemoval[] = [];
  const trackedSkipped: ProviderStaleAgentRemoval[] = [];

  const record = (list: ProviderStaleAgentRemoval[], provider: string, relativePath: string): void => {
    let entry = list.find((item) => item.provider === provider);
    if (!entry) {
      entry = { provider, paths: [] };
      list.push(entry);
    }
    entry.paths.push(relativePath);
  };

  for (const provider of Object.keys(PROVIDER_AGENT_DIRS)) {
    const isTargetProvider = provider === options.provider;
    // Non-target trees are pruned as a unit or not at all; the refreshed
    // provider only drops agents whose source no longer ships them.
    if (!isTargetProvider && crossProvider === 'skip') continue;
    const kinds = isTargetProvider ? (['agents'] as const) : PRUNABLE_ARTIFACT_KINDS;

    const hits = await collectManagedProviderArtifacts(options.projectRoot, provider, kinds);
    const eligible = hits.filter((hit) => {
      if (isTargetProvider) {
        // Addons have independent manifest versions. Comparing their managed
        // marker to the top-level package version makes a successful refresh
        // delete freshly restored addon agents, so the active provider removes
        // only artifacts absent from current sources.
        return !desired.has(hit.artifactName);
      }
      return currentVersion !== null && isOlderManagedVersion(hit.version, currentVersion);
    });
    if (eligible.length === 0) continue;

    // Only the cross-provider unit prune defers to VCS state.
    let protectedPaths = new Set<string>();
    if (!isTargetProvider && !options.allowTrackedDeletes) {
      const { tracked } = await partitionTrackedPaths(
        options.projectRoot,
        eligible.map((hit) => hit.relativePath),
      );
      protectedPaths = new Set(tracked);
    }

    for (const hit of eligible) {
      if (protectedPaths.has(hit.relativePath)) {
        record(trackedSkipped, provider, hit.relativePath);
        continue;
      }
      if (!options.dryRun) await fs.rm(hit.absolutePath, { force: true });
      record(removals, provider, hit.relativePath);
    }
  }

  for (const list of [removals, trackedSkipped]) {
    for (const entry of list) entry.paths.sort((a, b) => a.localeCompare(b));
  }
  return { removals, trackedSkipped };
}

/**
 * Reconcile `installed.deployedTo` with the artifacts a prune pass left behind (#2506).
 *
 * Recorded counts are written by `aiwg use` before the prune runs, so a run
 * that deletes artifacts otherwise leaves the config permanently claiming
 * files that are gone. Two cases:
 *
 *  - **Unit-pruned provider tree** (a non-refreshed provider removed wholesale):
 *    every managed agent/command/rule for that provider is gone, so those
 *    counts drop to zero across all installed bundles. Skills are not part of
 *    the prune pass and keep their recorded values.
 *  - **Refreshed provider** (agent orphans only): subtract the removed count
 *    from the recorded agent totals, largest contributor first, clamped at 0.
 */
async function reconcileDeployedToAfterPrune(
  projectRoot: string,
  removals: ProviderStaleAgentRemoval[],
  refreshedProvider: string | null,
): Promise<void> {
  if (removals.length === 0) return;
  const config = await readAiwgConfig(projectRoot);
  if (!config) return;

  let changed = false;
  for (const removal of removals) {
    const unitPruned = removal.provider !== refreshedProvider;
    const entries = Object.values(config.installed)
      .filter((entry) => entry.deployedTo?.[removal.provider]);
    if (entries.length === 0) continue;

    if (unitPruned) {
      for (const entry of entries) {
        const counts = entry.deployedTo[removal.provider];
        if (counts.agents === 0 && counts.commands === 0 && counts.rules === 0) continue;
        counts.agents = 0;
        counts.commands = 0;
        counts.rules = 0;
        changed = true;
      }
      continue;
    }

    let outstanding = removal.paths.length;
    const byAgentsDesc = entries
      .slice()
      .sort((a, b) => b.deployedTo[removal.provider].agents - a.deployedTo[removal.provider].agents);
    for (const entry of byAgentsDesc) {
      if (outstanding <= 0) break;
      const counts = entry.deployedTo[removal.provider];
      const deduct = Math.min(counts.agents, outstanding);
      if (deduct <= 0) continue;
      counts.agents -= deduct;
      outstanding -= deduct;
      changed = true;
    }
  }

  if (changed) await writeAiwgConfig(projectRoot, config);
}

/**
 * Whether this run may delete git-tracked artifacts during a cross-provider
 * prune (#2514).
 *
 * Deliberately not derived from `--force`. `--force` governs what gets
 * *written* — it replaces artifacts AIWG does not currently manage. Deleting
 * files someone committed, in a provider tree this run was not asked to touch,
 * is a different decision and gets its own switch, so habitual `--force` use
 * can never authorise it.
 */
export function allowsTrackedDeletes(args: string[]): boolean {
  return args.includes('--prune-tracked');
}

/**
 * Parse --flag value pairs from args
 */
function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

const MODEL_DEPLOY_VALUE_FLAGS = new Set([
  '--model', '--reasoning-model', '--coding-model', '--efficiency-model',
  '--filter', '--filter-role', '--model-tier',
]);
const MODEL_DEPLOY_BOOLEAN_FLAGS = new Set(['--save', '--save-user']);
export function collectModelDeployArgs(args: string[]): string[] {
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (MODEL_DEPLOY_BOOLEAN_FLAGS.has(args[i])) forwarded.push(args[i]);
    else if (MODEL_DEPLOY_VALUE_FLAGS.has(args[i]) && args[i + 1]) {
      forwarded.push(args[i], args[++i]);
    }
  }
  return forwarded;
}

const REFRESH_HELP = `Usage: aiwg refresh [options]

Update AIWG, re-deploy installed frameworks, and run health verification.

Options:
  --dry-run                 Preview changes without updating or deploying
  --quiet                   Suppress progress output
  --skip-update             Skip the installation update
  --packages-only           Refresh remote packages only
  --provider <name>         Override provider auto-detection
  --prune-other-providers   Remove stale AIWG-managed trees belonging to
                            providers this run did not refresh. Off by default:
                            a provider-scoped refresh never mutates another
                            provider's deployed surface. Git-tracked files are
                            always left in place unless --prune-tracked is given.
  --prune-tracked           Allow --prune-other-providers to delete git-tracked
                            files. Deleting committed files is a separate
                            decision from --force, which only governs writes.
  --force                   Re-write every deployed artifact, replacing files
                            AIWG does not currently manage. Never authorises
                            deleting tracked files.
  --channel <name>          Select the update channel (stable or main)
  --frameworks <list>       Re-deploy a comma-separated installed subset
  --model <name>            Override all deployed agent model tiers
  --reasoning-model <name>  Override the reasoning model tier
  --coding-model <name>     Override the coding model tier
  --efficiency-model <name> Override the efficiency model tier
  --filter <pattern>        Limit model deployment by agent name
  --filter-role <role>      Limit model deployment by role
  --model-tier <tier>       Limit model deployment by tier
  --save                    Save model overrides to the project
  --save-user               Save model overrides to user configuration
  -h, --help                Show this help without running refresh

Alias: aiwg sync (deprecated)`;

/**
 * Refresh command handler (formerly sync)
 */
export const refreshHandler: CommandHandler = {
  id: 'refresh',
  name: 'Refresh',
  description: 'Refresh AIWG to latest version and re-deploy installed frameworks',
  category: 'maintenance',
  aliases: ['--refresh', 'sync', '--sync'],

  async help(): Promise<HandlerResult> {
    return { exitCode: 0, message: REFRESH_HELP, rawOutput: true };
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const dryRun = hasFlag(ctx.args, '--dry-run');
    const quiet = hasFlag(ctx.args, '--quiet');
    const skipUpdate = hasFlag(ctx.args, '--skip-update');
    const packagesOnly = hasFlag(ctx.args, '--packages-only');
    // #2506: cross-provider pruning is opt-in. A provider-scoped refresh must
    // not silently delete another provider's deployed surface.
    const pruneOtherProviders = hasFlag(ctx.args, '--prune-other-providers');
    const forceDeploy = hasFlag(ctx.args, '--force');
    // #2514: deleting committed files in a tree this run was not asked to touch
    // is its own decision, not a consequence of asking for a forceful re-write.
    // `--force` governs what gets written; this governs what gets destroyed.
    const pruneTracked = allowsTrackedDeletes(ctx.args);
    const provider = parseFlag(ctx.args, '--provider');
    const channel = parseFlag(ctx.args, '--channel');
    const frameworksArg = parseFlag(ctx.args, '--frameworks');
    const modelDeployArgs = collectModelDeployArgs(ctx.args);

    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);
    const activeUseHandler = createUseHandler();

    if (!quiet) {
      ui.blank();
      // Deprecation notice when invoked as 'sync'
      const invokedAs = ctx.rawArgs[0]?.toLowerCase();
      if (invokedAs === 'sync' || invokedAs === '--sync') {
        ui.warn("'aiwg sync' is deprecated — use 'aiwg refresh' instead (renamed to avoid git sync confusion)");
      }
      console.log(`  ${ui.brandMark()} ${ui.bold('aiwg refresh')}${dryRun ? ui.dimText('  (dry run)') : ''}`);
      ui.rule();
    }

    // Step 1: Detect provider
    if (!quiet) ui.info('Detecting provider...');
    await runner.run('tools/cli/runtime-info.mjs', [], { capture: true });
    const resolution = await resolveActiveProvider({ cwd: ctx.cwd, explicitProvider: provider, detectProcess: true });
    if (!resolution.provider) {
      if (!quiet) ui.warn('Provider detection ambiguous: ' + resolution.reason + '. Specify --provider <name>.');
      return { exitCode: 2, message: 'Provider detection ambiguous: ' + resolution.reason };
    }
    const detectedProvider = resolution.provider;
    if (!quiet) ui.success('Provider: ' + detectedProvider);

    // Step 2: Check current version
    if (!quiet) ui.info('Checking version...');
    await runner.run('tools/cli/version.mjs', ['--json'], { capture: true });
    if (!quiet) ui.success('Version check complete');

    // Step 2.5: Refresh remote packages (always, unless --packages-only skips npm)
    if (!quiet) ui.info(dryRun ? 'Would refresh remote packages...' : 'Refreshing remote packages...');
    const deploymentFailures: string[] = [];
    let updateFailure: { exitCode: number } | null = null;
    if (!dryRun) {
      try {
        const refreshed = await refreshAllPackages();
        if (refreshed.length > 0) {
          if (!quiet) ui.success(`Refreshed ${refreshed.length} remote package${refreshed.length > 1 ? 's' : ''}: ${refreshed.join(', ')}`);
        } else {
          if (!quiet) ui.dim('  No remote packages registered');
        }
      } catch (error) {
        if (!quiet) ui.warn(`Remote package refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (packagesOnly) {
      if (!quiet) {
        ui.rule();
        ui.success('Remote packages refreshed (--packages-only, skipping npm update and framework deploy)');
        ui.blank();
      }
      return { exitCode: 0 };
    }

    // Step 3: Update package (unless --skip-update)
    if (!skipUpdate) {
      if (!quiet) ui.info(dryRun ? 'Would check for updates...' : 'Checking for updates...');
      if (!dryRun) {
        const channelArgs = channel ? ['--channel', channel] : [];
        const updateResult = await runner.run('tools/cli/update.mjs', channelArgs, { capture: quiet });
        if (updateResult.exitCode === 0) {
          if (!quiet) ui.success('Package up to date');
        } else {
          updateFailure = { exitCode: updateResult.exitCode };
          if (!quiet) {
            ui.warn('Installation update failed; continuing with re-deployment. Run `aiwg installation show` for canonical-install diagnostics.');
          }
        }
      }
    } else {
      if (!quiet) ui.dim('  Skipping package update (--skip-update)');
    }

    // Step 4: Re-deploy frameworks. Both the default form and --all mean
    // "all installed", never the `aiwg use all` expansion meta-target. This
    // preserves the operator's selected footprint and removal symmetry.
    const refreshConfig = await readAiwgConfig(ctx.cwd);
    const installedFrameworks = Object.keys(refreshConfig?.installed ?? {});
    const requestedFrameworks = frameworksArg
      ? frameworksArg.split(',').map(item => item.trim()).filter(Boolean)
      : [];
    const frameworks = !frameworksArg || requestedFrameworks.includes('all')
      ? installedFrameworks
      : requestedFrameworks;
    if (!quiet) ui.info(dryRun ? 'Would re-deploy frameworks...' : 'Re-deploying frameworks...');

    if (!dryRun) {
      if (frameworks.length === 0 && !quiet) {
        ui.dim('  No installed frameworks or addons to re-deploy');
      }
      for (const fw of frameworks) {
        // Invoke the active installation's handler directly. The historical
        // deploy.mjs bridge shells out to the first `aiwg` on PATH, which can
        // be a different version/root and therefore cannot safely refresh
        // addons installed by this package (#143/#2102).
        const useResult = await activeUseHandler.execute({
          ...ctx,
          cwd: ctx.cwd,
          frameworkRoot,
          args: [
            fw,
            '--provider', detectedProvider,
            '--target', ctx.cwd,
            '--yes',
            '--json',
            // #2507: give operators a reclaim path for artifacts an older
            // AIWG left behind without a managed marker.
            ...(forceDeploy ? ['--force'] : []),
            ...modelDeployArgs,
          ],
          rawArgs: ['use', fw],
        });
        if (useResult.exitCode === 0) {
          if (!quiet) ui.success(`Deployed: ${fw}`);
        } else {
          deploymentFailures.push(fw);
          if (!quiet) ui.warn(`Deploy issue: ${fw} (exit ${useResult.exitCode})`);
        }
      }
    } else {
      if (!quiet) {
        if (frameworks.length === 0) ui.dim('    No installed frameworks or addons');
        for (const fw of frameworks) {
          ui.dim(`    Would re-deploy: ${fw}`);
        }
      }
    }

    // Step 4.25: Report planned project-local deploys (#1035).
    // The active use handler performs the actual project-local deploy during
    // framework refresh; this block surfaces dry-run and completion details.
    try {
      const plDiscovery = await discoverProjectLocalBundles(ctx.cwd);
      const plCount = plDiscovery.bundles.length;
      if (plCount > 0) {
        if (dryRun) {
          if (!quiet) {
            ui.info(`Would re-deploy ${plCount} project-local bundle(s):`);
            for (const b of plDiscovery.bundles) {
              ui.dim(`    ${b.type} '${b.id}' from ${b.localPath}`);
            }
          }
        } else {
          if (!quiet) ui.success(`Project-local: ${plCount} bundle(s) re-deployed via 'aiwg use'`);
        }
      }
      if (plDiscovery.errors.length > 0 && !quiet) {
        ui.warn(`Project-local discovery: ${plDiscovery.errors.length} validation error(s) — run 'aiwg list --project-local' for details`);
      }
    } catch {
      // Non-fatal — refresh continues
    }

    // Step 4.5: Stale deployment check (#621, #1460, #1799, #2506)
    if (!quiet) ui.info('Checking for stale deployments...');
    // A modifier with nothing to modify is almost always a mistyped intent.
    if (pruneTracked && !pruneOtherProviders && !quiet) {
      ui.warn('--prune-tracked has no effect without --prune-other-providers; nothing was removed.');
    }
    let staleAgentRemovals: ProviderStaleAgentRemoval[] = [];
    let trackedSkipped: ProviderStaleAgentRemoval[] = [];
    if (!dryRun && deploymentFailures.length === 0) {
      try {
        const pruneResult = await pruneStaleManagedAgentFiles({
          projectRoot: ctx.cwd,
          frameworkRoot,
          provider: detectedProvider,
          crossProvider: pruneOtherProviders ? 'prune' : 'skip',
          allowTrackedDeletes: pruneTracked,
        });
        staleAgentRemovals = pruneResult.removals;
        trackedSkipped = pruneResult.trackedSkipped;
        if (trackedSkipped.length > 0 && !quiet) {
          const total = trackedSkipped.reduce((sum, item) => sum + item.paths.length, 0);
          ui.warn(
            `Left ${total} git-tracked AIWG-managed file${total === 1 ? '' : 's'} in place ` +
            `across ${trackedSkipped.length} provider${trackedSkipped.length === 1 ? '' : 's'}`,
          );
          for (const skipped of trackedSkipped) {
            const shown = skipped.paths.slice(0, 3).join(', ');
            const remainder = skipped.paths.length - 3;
            ui.dim(
              `    ${skipped.provider}: ${skipped.paths.length} (${shown}${remainder > 0 ? `, ...and ${remainder} more` : ''})`,
            );
          }
          ui.dim("    These are committed files. Add --prune-tracked to remove them as well.");
        }
        if (staleAgentRemovals.length > 0 && !quiet) {
          const total = staleAgentRemovals.reduce((sum, item) => sum + item.paths.length, 0);
          ui.warn(
            `Removed ${total} stale AIWG-managed file${total === 1 ? '' : 's'} ` +
            `across ${staleAgentRemovals.length} provider${staleAgentRemovals.length === 1 ? '' : 's'}`,
          );
          for (const removal of staleAgentRemovals) {
            const shown = removal.paths.slice(0, 3).join(', ');
            const remainder = removal.paths.length - 3;
            ui.dim(
              `    ${removal.provider}: ${removal.paths.length} (${shown}${remainder > 0 ? `, ...and ${remainder} more` : ''})`,
            );
          }
          ui.dim('    Review `git status` before committing — deployed artifacts may be tracked.');
        }
        // #2506: keep the recorded deployment state consistent with what the
        // prune actually left on disk, so a later run does not trust counts
        // for artifacts that no longer exist.
        await reconcileDeployedToAfterPrune(
          ctx.cwd,
          staleAgentRemovals,
          pruneOtherProviders ? detectedProvider : null,
        );
      } catch {
        if (!quiet) ui.dim('  Agent orphan cleanup skipped (non-critical)');
      }

      // #2506: a provider-scoped refresh reports other providers' stale trees
      // instead of mutating them. Silent cross-provider deletion destroyed
      // git-tracked artifacts and left half-deployed surfaces behind.
      if (!pruneOtherProviders) {
        try {
          const staleTrees = await detectStaleProviderTrees({
            projectRoot: ctx.cwd,
            frameworkRoot,
            provider: detectedProvider,
          });
          for (const tree of staleTrees) {
            const breakdown = (['agents', 'commands', 'rules'] as const)
              .filter((kind) => tree.counts[kind] > 0)
              .map((kind) => `${tree.counts[kind]} ${kind}`)
              .join(', ');
            ui.warn(
              `Stale ${tree.provider} deployment: ${tree.total} AIWG-managed file(s) from v${tree.version} ` +
              `(${breakdown}) — this run refreshed ${detectedProvider ?? 'the active provider'} only`,
            );
            ui.dim(
              `    Refresh it with 'aiwg refresh --provider ${tree.provider}', ` +
              `or remove it with 'aiwg refresh --prune-other-providers'`,
            );
          }
        } catch {
          if (!quiet) ui.dim('  Stale provider tree check skipped (non-critical)');
        }
      }

      try {
        const { getFrameworkRoot } = await import('../../channel/manager.mjs');
        const { join } = await import('path');
        const config = await readAiwgConfig(process.cwd());
        if (config) {
          const MANIFEST_PATHS: Record<string, string> = {
            sdlc: 'agentic/code/frameworks/sdlc-complete/manifest.json',
            marketing: 'agentic/code/frameworks/media-marketing-kit/manifest.json',
            'media-curator': 'agentic/code/frameworks/media-curator/manifest.json',
            research: 'agentic/code/frameworks/research-complete/manifest.json',
          };
          const frameworkRoot = await getFrameworkRoot();
          // Batch-hash manifests in parallel instead of serially awaiting each
          // one. For ~10 frameworks this cuts refresh latency from ~N*I/O to
          // max-single-I/O on a warm filesystem (#919 cleanup).
          const hashChecks = await Promise.all(
            Object.entries(config.installed).map(async ([name, entry]) => {
              if (!entry.manifestHash) return null;
              const relPath = MANIFEST_PATHS[name];
              if (!relPath) return null;
              const currentHash = await hashManifest(join(frameworkRoot, relPath));
              return currentHash && currentHash !== entry.manifestHash ? name : null;
            }),
          );
          const stale: string[] = hashChecks.filter((n): n is string => n !== null);
          if (stale.length > 0) {
            for (const name of stale) {
              ui.warn(`Stale deployment: ${name} — run 'aiwg use ${name}' to redeploy`);
            }
          } else if (staleAgentRemovals.length > 0) {
            // #2506: a run that deleted artifacts is not an "up to date" run.
            const removed = staleAgentRemovals.reduce((sum, item) => sum + item.paths.length, 0);
            if (!quiet) {
              ui.warn(`Deployments current, but ${removed} stale artifact(s) were removed this run — review the list above`);
            }
          } else {
            if (!quiet) ui.success('All deployments up to date');
          }
        } else {
          if (!quiet) ui.dim('  No aiwg.config — skipping stale check');
        }
      } catch {
        if (!quiet) ui.dim('  Stale check skipped (non-critical)');
      }
    }

    // Step 4.6: Migrate aiwg.config — add parallelism block if missing (#1359)
    if (!dryRun) {
      try {
        const config = await readAiwgConfig(process.cwd());
        if (config && !config.parallelism) {
          const primary = config.providers[0];
          const defaults = getProviderParallelismDefaults(primary);
          config.parallelism = {
            max_parallel_subagents: defaults.max_parallel_subagents,
            max_parallel_ralph_loops: defaults.max_parallel_ralph_loops,
            max_parallel_mc_missions: defaults.max_parallel_mc_missions,
            rationale: `Provider default for ${primary ?? 'unknown'} (migrated by aiwg refresh)`,
          };
          await writeAiwgConfig(process.cwd(), config);
          if (!quiet) {
            ui.success(
              `Added parallelism block to .aiwg/aiwg.config (max_parallel_subagents=${defaults.max_parallel_subagents})`,
            );
          }
        }
      } catch {
        // Non-fatal — refresh continues even if migration fails
      }
    }

    // Step 5: Health check
    if (!quiet) ui.info(dryRun ? 'Would run health check...' : 'Running health check...');
    if (!dryRun) {
      const doctorResult = await runner.run('tools/cli/doctor.mjs', [], { capture: quiet });
      if (doctorResult.exitCode === 0) {
        if (!quiet) ui.success('Health check passed');
      } else {
        if (!quiet) ui.warn('Health check found issues (run `aiwg doctor` for details)');
      }
    }

    // Summary
    if (!quiet) {
      ui.rule();
      if (dryRun) {
        ui.info('Dry run complete — no changes made');
      } else if (updateFailure) {
        ui.warn(
          `Refresh completed with installation update failure (exit ${updateFailure.exitCode}); ` +
          're-deployment continued, but AIWG may still be on the previous version.',
        );
      } else {
        ui.success('Refresh complete');
      }
      ui.blank();
    }

    // Quiet mode: JSON output
    if (quiet) {
      const output = JSON.stringify({
        status: dryRun
          ? 'dry-run'
          : updateFailure
            ? 'refreshed-with-update-failure'
            : 'refreshed',
        provider: detectedProvider,
        frameworks,
        skipUpdate,
        channel: channel || undefined,
        staleAgentRemovals,
        deploymentFailures,
        updateFailure,
      });
      console.log(output);
    }

    if (deploymentFailures.length > 0) {
      return {
        exitCode: 1,
        message: `Failed to re-deploy installed bundle(s): ${deploymentFailures.join(', ')}`,
      };
    }
    return { exitCode: 0 };
  },
};
