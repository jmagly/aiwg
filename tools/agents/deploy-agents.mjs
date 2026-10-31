#!/usr/bin/env node
/**
 * Deploy Agents and Commands - Orchestrator
 *
 * Deploy agents/commands from this repository to a target project.
 * Delegates to provider-specific modules for platform-specific deployment.
 *
 * Usage:
 *   node tools/agents/deploy-agents.mjs [options]
 *
 * Options:
 *   --source <path>          Source directory (defaults to repo root)
 *   --target <path>          Target directory (defaults to cwd)
 *   --scope <user|project>   Deployment scope (default: project)
 *   --user                  Shorthand for --scope user
 *   --mode <type>            Deployment mode: general, sdlc, marketing (alias: mmk), media-curator, research, both, or all (default)
 *   --deploy-commands        Deploy commands in addition to agents
 *   --deploy-skills          Deploy skills in addition to agents
 *   --deploy-rules           Deploy rules in addition to agents
 *   --commands-only          Deploy only commands (skip agents)
 *   --skills-only            Deploy only skills (skip agents)
 *   --strict                 Fail startup budget overruns before deployment promotion
  --report-only            Warn on startup budget overruns (migration default; CI remains strict)
  --rules-only             Deploy only rules (skip agents)
 *   --dry-run                Show what would be deployed without writing
 *   --force                  Overwrite existing files
 *   --provider <name>        Target provider: antigravity (agy), claude (default), openai, codex, cursor, opencode, copilot, factory, grokbot, grok-build, muse, flue (experimental), pi, omp, deepseek-harness (dsh), warp, devin, hermes, openhuman, or openclaw
 *   --model <name>            Override model for all tiers (blanket)
 *   --reasoning-model <name> Override model for reasoning tasks
 *   --coding-model <name>    Override model for coding tasks
 *   --efficiency-model <name> Override model for efficiency tasks
 *   --model-tier <tier>      Override all artifacts with economy|standard|premium
 *   --as-agents-md               Aggregate to single AGENTS.md (OpenAI/Codex)
 *   --create-agents-md           Create/update AGENTS.md template
  --no-context-files           Preserve WORKSPACE.md, AIWG.md and AGENTS.md (including managed blocks)
 *   --skip-commands-migration    Skip deleting the commands directory (warns about duplicate TUI entries) (Factory/Codex/OpenCode/Cursor)
 *   --deploy-source <name>       Managed-marker source for deployed artifacts (default: bundled)
 *   --deploy-version <version>   Managed-marker version for deployed artifacts (default: source package.json)
 *
 * Modes:
 *   general       - Deploy only writing-quality addon agents and commands (alias: writing)
 *   writing       - Deploy only writing-quality addon agents (alias for general)
 *   sdlc          - Deploy only SDLC Complete framework agents and commands
 *   marketing     - Deploy only Media/Marketing Kit framework agents and commands (alias: mmk)
 *   media-curator - Deploy only Media Curator framework agents and commands
 *   research      - Deploy only Research Complete framework agents and commands
 *   both          - Deploy writing + SDLC (legacy compatibility)
 *   all           - Deploy all frameworks + addons (default)
 *
 * Providers:
 *   claude    - Claude Code (default) - .claude/agents/, .claude/commands/, .claude/skills/, .claude/rules/
 *   factory   - Factory AI - .factory/droids/, .factory/commands/, .factory/skills/, .factory/rules/
 *   codex     - OpenAI Codex - .codex/agents/, .codex/commands/, .codex/skills/, .codex/rules/
 *   openai    - Alias for codex
 *   opencode  - OpenCode - .opencode/skill/, .opencode/rule/ (agents+commands not file-based)
 *   copilot   - GitHub Copilot - .github/agents/, .github/commands/, .github/skills/, .github/copilot-rules/
 *   cursor    - Cursor IDE - .cursor/agents/, .cursor/commands/, .cursor/skills/, .cursor/rules/
 *   warp      - Warp Terminal - .warp/agents/, .warp/commands/, .warp/skills/, .warp/rules/ + WARP.md
 *   devin     - Devin Desktop - .windsurf/agents/, .windsurf/workflows/, .windsurf/skills/, .windsurf/rules/
 *   windsurf  - Deprecated alias for devin
 *   openclaw  - OpenClaw - ~/.openclaw/agents/, ~/.openclaw/commands/, ~/.openclaw/skills/, ~/.openclaw/rules/, ~/.openclaw/behaviors/
 *   pi        - Pi Coding Agent - .agents/skills/, .pi/skills/, .pi/prompts/, AGENTS.md
 *   omp       - Oh My Pi - .omp/agents/, .omp/prompts/, .agents/skills/, .omp/AGENTS.md
 *   deepseek-harness - DeepSeek Harness - .agents/skills/, AGENTS.md, .dsh/aiwg.cordis.patch.yml
 *
 * Defaults:
 *   --source resolves relative to this script's repo root (../..)
 *   --target is process.cwd()
 *   --mode is 'all'
 */

import realFs from 'fs';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const staticModelCatalog = _require('../../agentic/code/providers/model-catalog.v1.json');
let fs;
try { const gfs = _require('graceful-fs'); gfs.gracefulify(realFs); fs = realFs; } catch { fs = realFs; }
import path from 'path';
import { importImpl } from '../_resolve-impl.mjs';
const { resolveDeployVersion } = await importImpl(import.meta.url, 'providers/deploy-version.mjs');
import os from 'os';
import { fileURLToPath } from 'url';
import {
  collectBehaviorDirs,
  deployEmulatedBehaviors,
  loadModelConfig,
  loadRuntimeModelCatalog,
  migrateCommandsDirectory,
  resolveAiwgRoot,
} from './providers/base.mjs';

const PROVIDER_ALIASES = {
  agy: 'antigravity',
  'openai': 'codex',
  'devin': 'windsurf',
  'devin-desktop': 'windsurf',
  'devin-local': 'windsurf',
  'cascade': 'windsurf',
  'pi-coding-agent': 'pi',
  'oh-my-pi': 'omp',
  'dsh': 'deepseek-harness',
};

const AVAILABLE_PROVIDERS = ['antigravity', 'claude', 'factory', 'codex', 'opencode', 'copilot', 'cursor', 'flue', 'pi', 'omp', 'deepseek-harness', 'warp', 'windsurf', 'hermes', 'openclaw', 'openhuman', 'grokbot', 'grok-build', 'muse'];

const UNSUPPORTED_PROVIDER_HINTS = {
  'devin-cli': [
    'Devin CLI has distinct rules/skills surfaces and is not a deployable AIWG provider yet.',
    'Use --provider devin for Devin Desktop deployments.',
  ],
};

// ============================================================================
// Provider Loading
// ============================================================================

/**
 * Resolve provider name (handle aliases)
 */
export function resolveProvider(name) {
  const candidate = String(name || '').trim().toLowerCase();
  const resolved = PROVIDER_ALIASES[candidate] || candidate;
  if (!AVAILABLE_PROVIDERS.includes(resolved)) {
    console.error(`Unknown provider: ${name}`);
    console.error(`Available providers: ${AVAILABLE_PROVIDERS.join(', ')}`);
    console.error(`Aliases: ${Object.entries(PROVIDER_ALIASES).map(([a, p]) => `${a} -> ${p}`).join(', ')}`);
    if (UNSUPPORTED_PROVIDER_HINTS[candidate]) {
      console.error('');
      for (const line of UNSUPPORTED_PROVIDER_HINTS[candidate]) console.error(line);
    }
    throw new Error(`Unknown provider: ${name}`);
  }
  return resolved;
}

/**
 * Dynamically load provider module
 */
export async function loadProvider(providerName) {
  const resolved = resolveProvider(providerName);
  // Resolve against this module, not the caller's cwd: in-process callers
  // (including module runners such as Vitest) cannot resolve a bare relative
  // specifier held in a variable.
  const providerUrl = new URL(`./providers/${resolved}.mjs`, import.meta.url).href;

  try {
    const provider = await import(providerUrl);
    return provider.default || provider;
  } catch (err) {
    console.error(`Failed to load provider '${resolved}':`, err.message);
    throw err;
  }
}


export { bulkInstallOwnsFlatArtifacts } from './providers/stale-artifact-prune.mjs';
import { pruneStaleAiwgArtifacts } from './providers/stale-artifact-prune.mjs';

export { parseArgs } from './deploy-options.mjs';
export { collectMirrorSkillDirs } from './deploy-command-mirrors.mjs';
import { parseArgs, printHelp } from './deploy-options.mjs';
import { mirrorSkillsAsCommands } from './deploy-command-mirrors.mjs';
import { resolveShorthand, saveModelConfig, promptCommandsMigration } from './deploy-support.mjs';
const { captureDeploymentOutputs, recordDeploymentOutputs, deploymentOutputRoots } = await importImpl(import.meta.url, 'providers/deployment-ownership.mjs');

export async function main(args = process.argv.slice(2), internal = {}) {
  const cfg = parseArgs(args);
  if (cfg.help) { printHelp(); return 0; }
  const modelCatalog = loadRuntimeModelCatalog(staticModelCatalog);

  // Resolve source directory (default to repo root relative to this script)
  const __filename = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(__filename);
  const srcRoot = cfg.source || path.resolve(scriptDir, '..', '..');

  // Validate source directory
  if (!fs.existsSync(srcRoot)) {
    throw new Error(`Source directory not found: ${srcRoot}`);
  }

  // Validate target directory
  if (!fs.existsSync(cfg.target)) {
    console.log(`Creating target directory: ${cfg.target}`);
    fs.mkdirSync(cfg.target, { recursive: true });
  }

  // Normalize mode aliases
  if (cfg.mode === 'writing') cfg.mode = 'general';
  if (cfg.mode === 'mmk') cfg.mode = 'marketing';

  // Apply --model blanket override: sets all three tiers unless individually overridden
  if (cfg.modelTier) {
    const tierRole = cfg.modelTier === 'economy' ? 'efficiency'
      : cfg.modelTier === 'premium' || cfg.modelTier === 'max-quality' ? 'reasoning'
        : cfg.modelTier === 'standard' ? 'coding' : null;
    if (!tierRole) throw new Error(`Invalid --model-tier: ${cfg.modelTier}`);
    const catalogProvider = cfg.provider === 'openai' ? 'codex' : cfg.provider;
    const providerCatalog = modelCatalog.providers[catalogProvider];
    if (!providerCatalog) throw new Error(`No model catalog entry for --model-tier provider ${cfg.provider}`);
    cfg.model = providerCatalog.roles[tierRole].id;
  }
  if (cfg.model) {
    if (!cfg.reasoningModel) cfg.reasoningModel = cfg.model;
    if (!cfg.codingModel) cfg.codingModel = cfg.model;
    if (!cfg.efficiencyModel) cfg.efficiencyModel = cfg.model;
  }

  // Load model configuration (project > user > AIWG defaults)
  const modelsConfig = loadModelConfig(srcRoot);

  // Resolve shorthand values in CLI flags using provider-specific config
  if (cfg.reasoningModel || cfg.codingModel || cfg.efficiencyModel) {
    const resolvedProvider = resolveProvider(cfg.provider);
    const providerShorthand = modelsConfig?.[`${resolvedProvider}_shorthand`] || modelsConfig?.shorthand || {};

    cfg.reasoningModel = resolveShorthand(cfg.reasoningModel, providerShorthand, modelsConfig, resolvedProvider, 'reasoning');
    cfg.codingModel = resolveShorthand(cfg.codingModel, providerShorthand, modelsConfig, resolvedProvider, 'coding');
    cfg.efficiencyModel = resolveShorthand(cfg.efficiencyModel, providerShorthand, modelsConfig, resolvedProvider, 'efficiency');
  }

  if (!cfg.quiet) {
    console.log(`\n=== AIWG Agent Deployment ===`);
    console.log(`Provider: ${cfg.provider}`);
    console.log(`Source: ${srcRoot}`);
    console.log(`Target: ${cfg.target}`);
    console.log(`Mode: ${cfg.mode}`);
    if (cfg.dryRun) console.log(`Dry run: enabled`);
    if (cfg.filter) console.log(`Filter: ${cfg.filter}`);
    if (cfg.filterRole) console.log(`Filter role: ${cfg.filterRole}`);
    if (cfg.model) console.log(`Model (all tiers): ${cfg.model}`);
    if (cfg.modelTier) console.log(`Canonical tier override: ${cfg.modelTier}`);
    if (cfg.reasoningModel) console.log(`Reasoning model: ${cfg.reasoningModel}`);
    if (cfg.codingModel) console.log(`Coding model: ${cfg.codingModel}`);
    if (cfg.efficiencyModel) console.log(`Efficiency model: ${cfg.efficiencyModel}`);
    if (cfg.save) console.log(`Save to project: enabled`);
    if (cfg.saveUser) console.log(`Save to user config: enabled`);
  }

  // Load provider module
  const provider = await loadProvider(cfg.provider);
  if (cfg.additionalSources.length && provider.name !== 'omp') throw new Error('--additional-source requires the OMP provider');
  for (const source of cfg.additionalSources) {
    if (!fs.statSync(source).isDirectory()) throw new Error(`Additional source is not a directory: ${source}`);
  }
  if (!cfg.quiet) console.log(`\nLoaded provider: ${provider.name}`);

  // Build options for provider
  const { writeContextFileSync } = await import('./providers/context-write.mjs');
  const opts = {
    writeReceipt: writeContextFileSync,
    srcRoot,
    target: cfg.target,
    ...(cfg.userScope ? { userScope: true } : {}),
    mode: cfg.mode,
    // Provider aliases are selectors, not artifact identities. Passing the
    // canonical id keeps generated frontmatter byte-identical for devin,
    // devin-desktop, and the deprecated windsurf selector.
    provider: resolveProvider(cfg.provider),
    dryRun: cfg.dryRun,
    force: cfg.force,
    reasoningModel: cfg.reasoningModel,
    codingModel: cfg.codingModel,
    efficiencyModel: cfg.efficiencyModel,
    modelsConfig,
    modelCatalog,
    // Warnings belong to this pass, just as they do in an isolated CLI run.
    warnedCommandsDirs: new Set(),
    asAgentsMd: cfg.asAgentsMd,
    createAgentsMd: cfg.contextFiles && cfg.createAgentsMd,
    contextFiles: cfg.contextFiles,
    deployCommands: cfg.kernelOnly ? false : cfg.deployCommands,
    deploySkills: cfg.kernelOnly ? true : cfg.deploySkills,
    deployRules: !cfg.deferRuleProjection && (cfg.kernelOnly || cfg.deployRules),
    deployBehaviors: cfg.kernelOnly ? false : cfg.deployBehaviors,
    commandsOnly: cfg.commandsOnly,
    skillsOnly: cfg.skillsOnly || cfg.kernelOnly,
    rulesOnly: cfg.rulesOnly,
    strict: cfg.strict,
    reportOnly: cfg.reportOnly,
    allowOverBudget: cfg.allowOverBudget === true,
    kernelOnly: cfg.kernelOnly,
    deferRuleProjection: cfg.deferRuleProjection,
    additionalSources: cfg.additionalSources,
    filter: cfg.filter,
    filterRole: cfg.filterRole,
    save: cfg.save,
    saveUser: cfg.saveUser,
    verbose: cfg.verbose,
    quiet: cfg.quiet,
    asPlugin: cfg.asPlugin,
    deployBehaviors: cfg.kernelOnly ? false : cfg.deployBehaviors,
    skipCommandsMigration: cfg.skipCommandsMigration,
    warnOnSkip: cfg.warnOnSkippedCommandsMigration !== false,
    // #1217 / #1219: --copy-all flag forces legacy per-project mirror
    // for the standard tier. Default is no-copy + index-driven discovery.
    // Replaces the legacy AIWG_COPY_STANDARD_SKILLS env var (removed rc.30).
    // Default (#1217) is no-copy + index-driven discovery.
    copyStandardSkills: cfg.copyStandardSkills === true,
    // #228: Muse provider hooks/MCP profile surface.
    mcp: cfg.mcp === true,
    hooks: cfg.hooks !== false,
    attribution: cfg.attribution !== false,
    listingBudget: cfg.listingBudget === true,
    deployVersion: resolveDeployVersion(resolveAiwgRoot(srcRoot) || srcRoot, cfg.deployVersion),
    deploySource: cfg.deploySource || 'bundled',
  };
  if (provider.name === 'hermes' && cfg.projectScope && !cfg.userScope) {
    throw new Error('Hermes does not support --scope project: skills are discovered only under HERMES_HOME/skills (default ~/.hermes/skills). Use --scope user or an isolated HERMES_HOME profile shared with Hermes.');
  }
  // Deferred kernel source passes must not load the projection dependency
  // graph. Preparation still owns their staged deployment when a hook is active.
  const preparationActive = cfg.kernelOnly && cfg.deferRuleProjection
    ? Boolean(globalThis[Symbol.for('aiwg.provider-preparation-hook.v1')])
    : (await import('./providers/rule-delivery.mjs')).isRuleDeploymentPreparationActive();

  // Commands → Skills migration: prompt then delete the commands directory
  // so stale command files don't create duplicates in the provider TUI.
  if (!preparationActive && !internal.finalizeOnly) {
    if (!cfg.dryRun && !cfg.skipCommandsMigration) {
      const doMigrate = await promptCommandsMigration(cfg, provider, cfg.target, internal.capture ? false : process.stdout.isTTY);
      if (doMigrate) {
        const commandsRelPath = provider.paths?.commands;
        if (commandsRelPath) {
          migrateCommandsDirectory(path.join(cfg.target, commandsRelPath), opts);
        }
      } else {
        // User said no — flip the flag so the provider knows to emit the duplicate warning
        opts.skipCommandsMigration = true;
      }
    } else if (cfg.skipCommandsMigration) {
      // Flag was passed explicitly — emit the duplicate warning now via a dry migration call
      const commandsRelPath = provider.paths?.commands;
      if (commandsRelPath && !provider.capabilities?.homeDirectoryDeploy) {
        migrateCommandsDirectory(path.join(cfg.target, commandsRelPath), opts);
      }
    }
  }

  // Concurrent deployment runs this parent-owned preflight before any child
  // snapshots its inputs. Migration can remove a provider command tree, so it
  // must remain on the same side of the transaction boundary as serial deploy.
  if (internal.preflightOnly) return;

  const ownershipRoots = deploymentOutputRoots(provider, cfg.target);
  const ownershipBefore = cfg.dryRun || preparationActive || internal.preflightOnly ? null : captureDeploymentOutputs(ownershipRoots);

  // Delegate to provider
  try {
    if (!internal.finalizeOnly) {
      if (cfg.kernelOnly && (!cfg.deferRuleProjection || preparationActive)
        && !['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw', 'flue', 'pi', 'copilot', 'factory', 'opencode', 'windsurf', 'antigravity', 'muse', 'omp', 'grok-build'].includes(provider.name)) {
        const { deployWithRuleDelivery } = await import('./providers/rule-delivery.mjs');
        await deployWithRuleDelivery(opts, provider, staged => provider.deploy(staged));
      } else await provider.deploy(opts);
    }
    if (preparationActive) return;

    // User settings are outside staging: write only after a real promotion.
    if (provider.name === 'claude' && cfg.userScope && !cfg.dryRun && cfg.attribution !== false) {
      const { installAiwgHooks } = await importImpl(import.meta.url, 'extensions/claude-hooks-installer.js');
      const result = await installAiwgHooks({ projectPath: os.homedir(), frameworkRoot: srcRoot, hooks: false });
      for (const warning of result?.warnings || []) console.warn(`Claude settings: ${warning}`);
    }

    const mirroredCommandCount = mirrorSkillsAsCommands(provider, cfg.target, srcRoot, opts);
    if (mirroredCommandCount > 0 && !cfg.quiet) {
      console.log(`  Mirrored: ${mirroredCommandCount} skill command wrapper${mirroredCommandCount === 1 ? '' : 's'}`);
    }

    // Prune stale AIWG-managed agents/commands/rules whose source was renamed
    // or removed (the flat-file analogue of the skills holistic prune). #1627.
    pruneStaleAiwgArtifacts(provider, cfg.target, srcRoot, opts, cfg.source);

    if (!['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw'].includes(provider.name) && !opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly) {
      const behaviorDirs = collectBehaviorDirs(srcRoot);
      const behaviorCount = deployEmulatedBehaviors(behaviorDirs, provider.name, cfg.target, opts);
      if (behaviorCount > 0 && !cfg.quiet) {
        console.log(`  Deployed: ${behaviorCount} behavior emulation${behaviorCount === 1 ? '' : 's'}`);
      }
    }

    // Save model configuration if requested
    if ((cfg.save || cfg.saveUser) && !cfg.dryRun) {
      await saveModelConfig(cfg, provider.name);
    }

    if (ownershipBefore) recordDeploymentOutputs(ownershipBefore, ownershipRoots, opts);
    if (!cfg.quiet) console.log(`\n=== Deployment complete ===\n`);
  } catch (err) {
    if (preparationActive || internal.finalizeOnly) throw err;
    console.error(`\nDeployment failed:`, err.message);
    if (cfg.dryRun) {
      console.error('(dry-run mode - no files were modified)');
    }
    return 1;
  }
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try { process.exitCode = (await main()) ?? 0; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
