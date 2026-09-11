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
 *   --mode <type>            Deployment mode: general, sdlc, marketing (alias: mmk), media-curator, research, both, or all (default)
 *   --deploy-commands        Deploy commands in addition to agents
 *   --deploy-skills          Deploy skills in addition to agents
 *   --deploy-rules           Deploy rules in addition to agents
 *   --commands-only          Deploy only commands (skip agents)
 *   --skills-only            Deploy only skills (skip agents)
 *   --rules-only             Deploy only rules (skip agents)
 *   --dry-run                Show what would be deployed without writing
 *   --force                  Overwrite existing files
 *   --provider <name>        Target provider: antigravity (agy), claude (default), openai, codex, cursor, opencode, copilot, factory, pi, omp, deepseek-harness (dsh), warp, devin, hermes, or openclaw
 *   --model <name>            Override model for all tiers (blanket)
 *   --reasoning-model <name> Override model for reasoning tasks
 *   --coding-model <name>    Override model for coding tasks
 *   --efficiency-model <name> Override model for efficiency tasks
 *   --model-tier <tier>      Override all artifacts with economy|standard|premium
 *   --as-agents-md               Aggregate to single AGENTS.md (OpenAI/Codex)
 *   --create-agents-md           Create/update AGENTS.md template
 *   --skip-commands-migration    Skip deleting the commands directory (warns about duplicate TUI entries) (Factory/Codex/OpenCode/Cursor)
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
import os from 'os';
import readline from 'readline';
import { fileURLToPath } from 'url';
import {
  addManagedMarker,
  collectBehaviorDirs,
  collectFrameworkArtifacts,
  computeAllArtifactBasenames,
  contentHash,
  deployEmulatedBehaviors,
  getAddonSkillDirs,
  listSkillDirs,
  loadModelConfig,
  loadRuntimeModelCatalog,
  migrateCommandsDirectory,
  parseFrontmatter,
  pruneStaleAiwgFiles,
  resolveAiwgRoot,
  updateSidecarManifest,
} from './providers/base.mjs';
const modelCatalog = loadRuntimeModelCatalog(staticModelCatalog);

/**
 * Read version from package.json at the source root.
 * Falls back to 'unknown' if unavailable.
 */
function getDeployVersion(srcRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ============================================================================
// Provider Registry
// ============================================================================

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

const AVAILABLE_PROVIDERS = ['antigravity', 'claude', 'factory', 'codex', 'opencode', 'copilot', 'cursor', 'pi', 'omp', 'deepseek-harness', 'warp', 'windsurf', 'hermes', 'openclaw', 'openhuman'];

const UNSUPPORTED_PROVIDER_HINTS = {
  'devin-cli': [
    'Devin CLI has distinct rules/skills surfaces and is not a deployable AIWG provider yet.',
    'Use --provider devin for Devin Desktop deployments.',
  ],
};

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
  'aiwg-mission',
  'use',
  'steward',
]);

function providerUsesSkillsNatively(providerName) {
  return ['antigravity', 'claude', 'cursor', 'deepseek-harness', 'hermes', 'openhuman', 'pi', 'omp'].includes(providerName);
}

function shouldMirrorStandardCommandSkill(skillName) {
  return (
    skillName.startsWith('flow-') ||
    MIRRORED_STANDARD_COMMAND_SKILLS.has(skillName)
  );
}

function shouldMirrorCommandSkill(providerName, skillName) {
  if (MIRRORED_KERNEL_COMMAND_SKILLS.has(skillName)) {
    return !providerUsesSkillsNatively(providerName);
  }

  return shouldMirrorStandardCommandSkill(skillName);
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function collectMirrorSkillDirs(srcRoot, mode) {
  const dirs = [];

  const directSkillsDir = path.join(srcRoot, 'skills');
  dirs.push(...listSkillDirs(directSkillsDir));

  // If --source itself is a skills directory, support that shape too.
  dirs.push(...listSkillDirs(srcRoot));

  const repoFrameworksRoot = path.join(srcRoot, 'agentic', 'code', 'frameworks');
  if (fs.existsSync(repoFrameworksRoot)) {
    const artifacts = collectFrameworkArtifacts(srcRoot, mode, {
      includeAgents: false,
      includeCommands: false,
      includeSkills: true,
      includeRules: false,
    });
    dirs.push(...artifacts.skills);

    if (mode === 'all') {
      dirs.push(...getAddonSkillDirs(srcRoot));
    }
  }

  return uniquePaths(dirs);
}

function resolveCommandMirrorDir(provider, target) {
  const commandsPath = provider.paths?.commands;
  if (commandsPath) {
    return path.isAbsolute(commandsPath) ? commandsPath : path.join(target, commandsPath);
  }

  // Closest conventional location for providers whose primary command
  // surface is MCP/aggregation rather than a documented command directory.
  if (provider.name === 'hermes') {
    // #2119: HERMES_HOME is the single source of truth the running Hermes
    // runtime uses to locate its files — resolve the home the same way the
    // provider does instead of hardcoding $HOME/.hermes.
    const hermesHome = typeof provider.getHermesHome === 'function'
      ? provider.getHermesHome()
      : path.join(os.homedir(), '.hermes');
    return path.resolve(hermesHome, 'commands');
  }

  return null;
}

function commandFileExtensionForProvider(provider) {
  if (provider.name === 'copilot') return '.prompt.md';
  return '.md';
}

function resolveSkillCommandPolicy(commandHint = {}) {
  const legacy = String(commandHint.model || '').trim().toLowerCase();
  const legacyRole = legacy === 'opus' ? 'reasoning'
    : legacy === 'haiku' ? 'efficiency'
      : legacy ? 'coding' : null;
  const modelRole = commandHint.modelRole || legacyRole;
  if (!modelRole) return null;
  const modelTier = commandHint.modelTier
    || (modelRole === 'reasoning' ? 'premium'
      : modelRole === 'efficiency' ? 'economy' : 'standard');
  return {
    modelRole,
    modelTier,
    modelEffort: commandHint.modelEffort,
    modelRationale: commandHint.modelRationale,
  };
}

function parseSkillCommandHint(raw) {
  const { frontmatter } = parseFrontmatter(raw);
  const block = frontmatter?.match(/^commandHint:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1] || '';
  const hint = {};
  for (const line of block.split('\n')) {
    const match = line.trim().match(/^(model|modelRole|modelTier|modelEffort|modelRationale):\s*(.+)$/);
    if (match) hint[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return hint;
}

function skillToCommandContent(skillDir) {
  const skillName = path.basename(skillDir);
  const skillPath = path.join(skillDir, 'SKILL.md');
  const raw = fs.readFileSync(skillPath, 'utf8');
  const { metadata, body } = parseFrontmatter(raw);
  const description = metadata.description || `Run AIWG skill ${skillName}`;
  const policy = resolveSkillCommandPolicy(parseSkillCommandHint(raw));
  const policyLines = policy ? [
    `aiwg-model-role: ${policy.modelRole}`,
    `aiwg-model-tier: ${policy.modelTier}`,
    ...(policy.modelEffort ? [`aiwg-model-effort: ${policy.modelEffort}`] : []),
    ...(policy.modelRationale ? [`aiwg-model-rationale: ${policy.modelRationale}`] : []),
  ] : [];

  return `---\nname: ${skillName}\ndescription: ${description}\n${policyLines.join('\n')}${policyLines.length ? '\n' : ''}---\n\n${body.trim()}\n`;
}

function mirrorSkillsAsCommands(provider, target, srcRoot, opts) {
  if (!opts.deployCommands && !opts.commandsOnly) return 0;

  const targetDir = resolveCommandMirrorDir(provider, target);
  if (!targetDir) return 0;

  const skillDirs = collectMirrorSkillDirs(srcRoot, opts.mode)
    .filter((dir) => shouldMirrorCommandSkill(provider.name, path.basename(dir)));

  if (skillDirs.length === 0) return 0;
  if (!opts.dryRun) fs.mkdirSync(targetDir, { recursive: true });

  const ext = commandFileExtensionForProvider(provider);
  const deployedEntries = [];
  let count = 0;

  for (const skillDir of skillDirs) {
    const skillName = path.basename(skillDir);
    let content = skillToCommandContent(skillDir);
    if (typeof provider.transformCommand === 'function') {
      content = provider.transformCommand(path.join(skillDir, `${skillName}.md`), content, opts);
    }
    // #2507: mirrored wrappers used to be written with no ownership signal, so
    // AIWG could neither count them as deployed nor prune them when the source
    // skill went away — a later run reported its own 46 wrappers as unmanaged
    // artifacts the operator should delete. They carry the same managed marker
    // and sidecar entry as any other deployed command now.
    content = addManagedMarker(content, opts.deployVersion || 'unknown', opts.deploySource || 'bundled');

    const filename = `${skillName}${ext}`;
    const dest = path.join(targetDir, filename);
    if (opts.dryRun) {
      if (opts.verbose) console.log(`[dry-run] mirror skill command ${skillName} -> ${dest}`);
      const raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      const policy = resolveSkillCommandPolicy(parseSkillCommandHint(raw));
      if (policy && opts.verbose) {
        const outcome = provider.name === 'claude' ? 'native'
          : provider.name === 'factory' ? 'informational' : 'unsupported';
        console.log(`[dry-run] skill model policy ${skillName}: ${outcome} (${policy.modelRole}/${policy.modelTier})`);
      }
    } else {
      fs.writeFileSync(dest, content, 'utf8');
    }
    deployedEntries.push({ filename, hash: contentHash(content), kind: 'skill-command' });
    count++;
  }

  if (deployedEntries.length > 0) {
    updateSidecarManifest(targetDir, deployedEntries, {
      dryRun: opts.dryRun,
      version: opts.deployVersion || 'unknown',
      source: opts.deploySource || 'bundled',
    });
  }

  return count;
}


// ============================================================================
// Stale-Artifact Prune (agents / commands / rules) — #1627
// ============================================================================

/**
 * After a deploy, prune AIWG-managed flat artifacts (agents/commands/rules)
 * whose source no longer ships them — mirroring the skills holistic prune.
 *
 * Safety boundaries:
 *   - Runs ONLY for AIWG framework/addon deploys (default source = AIWG root,
 *     or `--source` under `<aiwgRoot>/agentic/code`). Project-local bundle
 *     deploys (`--source <bundle>`) are skipped so a bundle's just-deployed
 *     artifacts are never mistaken for stale framework files.
 *   - `pruneStaleAiwgFiles` itself only removes files carrying an AIWG
 *     ownership signal (sidecar entry or `aiwg:managed` marker) AND whose
 *     stem is absent from the global, mode-independent source set, so
 *     user-authored files and sibling-framework artifacts always survive.
 *   - Aggregate-file paths (e.g. `AGENTS.md`) and unset paths are skipped.
 *
 * @param {object} provider loaded provider module
 * @param {string} target deploy target dir
 * @param {string} srcRoot effective deploy source
 * @param {object} opts deploy opts (dryRun/verbose/quiet + deploy flags)
 * @param {string|null} explicitSource the raw `--source` value (null when unset)
 */
/** Bundles whose deploy is itself the kernel-only bulk install. */
const BULK_INSTALL_BUNDLES = new Set(['all']);

/**
 * True when the kernel-only bulk install is the only thing this project has
 * deployed, so clearing leftover flat artifacts is a migration and not a
 * deletion of another bundle's surface (#2508).
 *
 * A project with no readable `.aiwg/aiwg.config` has no recorded owner, so the
 * pre-#152 migration cleanup still applies.
 */
export function bulkInstallOwnsFlatArtifacts(target) {
  let installed;
  try {
    const raw = realFs.readFileSync(path.join(target, '.aiwg', 'aiwg.config'), 'utf8');
    installed = JSON.parse(raw)?.installed;
  } catch {
    return true;
  }
  if (!installed || typeof installed !== 'object') return true;
  return !Object.keys(installed).some(name => !BULK_INSTALL_BUNDLES.has(name));
}

function pruneStaleAiwgArtifacts(provider, target, srcRoot, opts, explicitSource) {
  if (opts.skillsOnly && !opts.kernelOnly) return; // skills run their own prune in the provider

  const aiwgRoot = resolveAiwgRoot(srcRoot);
  if (!aiwgRoot) return; // no AIWG tree → bundle/standalone deploy; never prune

  // Gate: only framework/addon deploys are eligible. A default deploy (no
  // --source) sources from the AIWG root. An explicit --source is eligible
  // only when it lives under <aiwgRoot>/agentic/code (bundled fw/addon).
  if (explicitSource) {
    const codeRoot = path.join(aiwgRoot, 'agentic', 'code');
    const rel = path.relative(codeRoot, path.resolve(explicitSource));
    const underCode = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (!underCode) return; // project-local bundle / external source → skip
  }

  if (opts.kernelOnly) {
    // A kernel-only run deploys skills and nothing else (deployCommands /
    // deployRules / deployBehaviors are all forced false above), so it has no
    // basis for judging any flat artifact stale. The empty desired set below
    // exists for one narrow migration: clearing agents/commands/rules left by
    // the pre-#152 bulk default, when the bulk install is the only thing this
    // project ever deployed.
    //
    // #2508: applying it unconditionally deleted every artifact a sibling
    // bundle owned — `aiwg use sdlc` followed by `aiwg use all` took
    // .claude/agents from 139 to 0. When another bundle is installed, it owns
    // this surface deliberately and the migration assumption does not hold.
    if (!bulkInstallOwnsFlatArtifacts(target)) {
      if (opts.verbose) {
        console.log('skip kernel-only flat prune: another installed bundle owns agents/commands/rules');
      }
      return;
    }
    for (const type of ['agents', 'commands', 'rules']) {
      const relPath = provider.paths?.[type];
      if (!relPath || relPath.endsWith('.md')) continue;
      const destDir = path.isAbsolute(relPath) ? relPath : path.join(target, relPath);
      pruneStaleAiwgFiles(destDir, new Set(), {
        dryRun: opts.dryRun,
        verbose: opts.verbose,
        artifactExtensions: ['.md', '.mdc', '.toml'],
      });
    }
    return;
  }

  const typesThisRun = [];
  if (!opts.commandsOnly && !opts.rulesOnly) typesThisRun.push('agents');
  if (opts.deployCommands || opts.commandsOnly) typesThisRun.push('commands');
  if (opts.deployRules || opts.rulesOnly) typesThisRun.push('rules');

  for (const type of typesThisRun) {
    const relPath = provider.paths?.[type];
    if (!relPath) continue;                 // type not file-deployed by provider
    if (relPath.endsWith('.md')) continue;  // aggregate file (e.g. AGENTS.md)

    const desired = computeAllArtifactBasenames(srcRoot, type);
    if (!desired) continue;                 // no global desired set → skip

    const destDir = path.isAbsolute(relPath) ? relPath : path.join(target, relPath);
    const removed = pruneStaleAiwgFiles(destDir, desired, {
      dryRun: opts.dryRun,
      verbose: opts.verbose,
    });
    if (removed.length > 0 && !opts.quiet) {
      console.log(`  Pruned: ${removed.length} stale AIWG ${type} file${removed.length === 1 ? '' : 's'}`);
    }
  }
}

// ============================================================================
// Argument Parsing
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const cfg = {
    source: null,
    target: process.cwd(),
    mode: 'all',  // 'general', 'sdlc', 'marketing', 'media-curator', 'research', 'both' (legacy), or 'all'
    dryRun: false,
    force: false,
    provider: 'claude',
    model: null,             // Blanket override for all tiers
    modelTier: null,         // Blanket canonical tier override
    reasoningModel: null,
    codingModel: null,
    efficiencyModel: null,
    asAgentsMd: false,
    createAgentsMd: false,
    deployCommands: false,
    deploySkills: false,
    deployRules: false,
    deployBehaviors: false,      // Deploy behaviors (native on openclaw, emulated on others)
    commandsOnly: false,
    skillsOnly: false,
    rulesOnly: false,
    kernelOnly: false,
    filter: null,           // Glob pattern for agent names
    filterRole: null,       // Filter by role: reasoning|coding|efficiency
    save: false,            // Save model config to project models.json
    saveUser: false,        // Save model config to ~/.config/aiwg/models.json
    verbose: false,         // Show per-file deployment details
    quiet: false,           // Suppress all non-error output (for embedding in use.ts)
    asPlugin: false,        // Generate .factory-plugin/ bundle (Factory provider only)
    deployBehaviors: false, // Deploy behaviors in addition to agents
    skipCommandsMigration: false  // Skip commands → skills migration (warns about duplicates)
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source' && args[i + 1]) cfg.source = path.resolve(args[++i]);
    else if (a === '--target' && args[i + 1]) cfg.target = path.resolve(args[++i]);
    else if (a === '--mode' && args[i + 1]) cfg.mode = String(args[++i]).toLowerCase();
    else if (a === '--dry-run') cfg.dryRun = true;
    else if (a === '--force') cfg.force = true;
    else if ((a === '--provider' || a === '--platform') && args[i + 1]) cfg.provider = String(args[++i]).toLowerCase();
    else if (a === '--model' && args[i + 1]) cfg.model = args[++i];
    else if (a === '--model-tier' && args[i + 1]) cfg.modelTier = String(args[++i]).toLowerCase();
    else if ((a === '--reasoning-model' || a === '--reasoning') && args[i + 1]) cfg.reasoningModel = args[++i];
    else if ((a === '--coding-model' || a === '--coding') && args[i + 1]) cfg.codingModel = args[++i];
    else if ((a === '--efficiency-model' || a === '--efficiency') && args[i + 1]) cfg.efficiencyModel = args[++i];
    else if (a === '--as-agents-md') cfg.asAgentsMd = true;
    else if (a === '--create-agents-md') cfg.createAgentsMd = true;
    else if (a === '--deploy-commands') cfg.deployCommands = true;
    else if (a === '--deploy-skills') cfg.deploySkills = true;
    else if (a === '--deploy-rules') cfg.deployRules = true;
    else if (a === '--deploy-behaviors') cfg.deployBehaviors = true;
    else if (a === '--commands-only') cfg.commandsOnly = true;
    else if (a === '--skills-only') cfg.skillsOnly = true;
    else if (a === '--rules-only') cfg.rulesOnly = true;
    else if (a === '--kernel-only') cfg.kernelOnly = true;
    else if (a === '--deploy-behaviors') cfg.deployBehaviors = true;
    else if (a === '--filter' && args[i + 1]) cfg.filter = args[++i];
    else if (a === '--filter-role' && args[i + 1]) cfg.filterRole = args[++i];
    else if (a === '--save') cfg.save = true;
    else if (a === '--save-user') cfg.saveUser = true;
    else if (a === '--verbose' || a === '-v') cfg.verbose = true;
    else if (a === '--quiet' || a === '-q') cfg.quiet = true;
    else if (a === '--as-plugin') cfg.asPlugin = true;
    else if (a === '--skip-commands-migration') cfg.skipCommandsMigration = true;
    else if (a === '--copy-all' || a === '--copy-standard-skills') cfg.copyStandardSkills = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return cfg;
}

function printHelp() {
  console.log(`
Deploy Agents and Commands

Usage:
  node tools/agents/deploy-agents.mjs [options]
  aiwg -deploy-agents [options]

Options:
  --source <path>          Source directory (defaults to repo root)
  --target <path>          Target directory (defaults to cwd)
  --mode <type>            Deployment mode: general, sdlc, marketing (alias: mmk), media-curator, research, both, or all (default)
  --deploy-commands        Deploy commands in addition to agents
  --deploy-skills          Deploy skills in addition to agents
  --deploy-rules           Deploy rules in addition to agents
  --commands-only          Deploy only commands (skip agents)
  --skills-only            Deploy only skills (skip agents)
  --rules-only             Deploy only rules (skip agents)
  --kernel-only            Deploy kernel skills only and prune managed bulk artifacts
  --dry-run                Show what would be deployed without writing
  --force                  Overwrite existing files
  --provider <name>        Target provider (see below)
  --model <name>           Override model for all tiers (blanket)
  --reasoning-model <name> Override model for reasoning tasks (alias: --reasoning)
  --coding-model <name>    Override model for coding tasks (alias: --coding)
  --efficiency-model <name> Override model for efficiency tasks (alias: --efficiency)
  --model-tier <tier>      Override all artifacts with economy|standard|premium
  --filter <pattern>       Only deploy agents matching pattern (glob)
  --filter-role <role>     Only deploy agents of role: reasoning|coding|efficiency
  --save                   Save model config to project models.json
  --save-user              Save model config to ~/.config/aiwg/models.json
  --as-agents-md               Aggregate to single AGENTS.md (Codex)
  --create-agents-md           Create/update AGENTS.md template
  --skip-commands-migration    Skip deleting the commands directory before skills deployment
  --copy-all                   Copy ALL skills per-project (legacy mirror at <provider>/.aiwg/skills/).
                               For aiwg use all, this also restores the legacy full agent,
                               command, and expanded-rule copy. Default bulk deployment is
                               kernel-only + index-driven discovery for the rest (#1217).
                               Use this for sandboxed runtimes / air-gapped corpora where
                               $AIWG_ROOT isn't readable from the agent's working dir.
                               Alias: --copy-standard-skills — rc.29 era).
                               (warns about duplicate entries in the provider command palette)

Model Override Examples:
  # Use sonnet for everything
  aiwg use sdlc --model sonnet

  # Override individual tiers
  aiwg use sdlc --reasoning opus --coding sonnet --efficiency haiku

  # Use a specific model ID for coding tier
  aiwg use sdlc --provider factory --coding-model gpt-5.3-codex

  # Blanket with per-tier override (reasoning uses opus, others use sonnet)
  aiwg use sdlc --model sonnet --reasoning opus

  # Save overrides to project models.json for future deployments
  aiwg use sdlc --model sonnet --save

Model Precedence:
  CLI flags > project models.json > user ~/.config/aiwg/models.json > AIWG defaults

Shorthand Values:
  opus, sonnet, haiku, inherit — resolved per provider to full model IDs

Providers (all deploy agents, commands, skills, and rules):
  claude    - Claude Code (default)
              Paths: .claude/agents/, .claude/commands/, .claude/skills/, .claude/rules/
  factory   - Factory AI
              Paths: .factory/droids/, .factory/commands/, .factory/skills/, .factory/rules/
  codex     - OpenAI Codex (alias: openai)
              Paths: .codex/agents/, .codex/commands/, .codex/skills/, .codex/rules/
  opencode  - OpenCode
              Paths: .opencode/skill/, .opencode/rule/ (agents/commands not file-based in OpenCode)
  copilot   - GitHub Copilot
              Paths: .github/agents/, .github/commands/, .github/skills/, .github/copilot-rules/
  cursor    - Cursor IDE
              Paths: .cursor/agents/, .cursor/commands/, .cursor/skills/, .cursor/rules/
  warp      - Warp Terminal
              Paths: .warp/agents/, .warp/commands/, .warp/skills/, .warp/rules/ + WARP.md
  deepseek-harness - DeepSeek Harness (alias: dsh; experimental)
              Paths: AGENTS.md, .agents/skills/, .dsh/aiwg.cordis.patch.yml
  devin     - Devin Desktop (preferred; aliases: devin-desktop, windsurf)
              Paths: .windsurf/agents/, .windsurf/workflows/, .windsurf/skills/, .windsurf/rules/
  hermes    - Hermes Agent (MCP-based integration)
              Skills: $HERMES_HOME/skills/ (user-global; defaults to ~/.hermes/skills/) | Agents: AGENTS.md
              Commands/Rules: served via MCP, not file-deployed

Modes:
  general       - Writing-quality addon agents and commands (alias: writing)
  sdlc          - SDLC Complete framework agents and commands
  marketing     - Media/Marketing Kit framework agents and commands (alias: mmk)
  media-curator - Media Curator framework agents and commands
  research      - Research Complete framework agents and commands
  both          - writing + SDLC (legacy compatibility)
  all           - All frameworks + addons (default)

Examples:
  # Deploy SDLC framework to Claude Code
  aiwg -deploy-agents --mode sdlc

  # Deploy to Factory with commands and AGENTS.md
  aiwg -deploy-agents --provider factory --mode sdlc --deploy-commands --create-agents-md

  # Deploy to GitHub Copilot
  aiwg -deploy-agents --provider copilot --mode sdlc

  # Override model for all tiers
  aiwg -deploy-agents --mode sdlc --model sonnet

  # Override individual tiers
  aiwg -deploy-agents --mode sdlc --reasoning opus --coding sonnet --efficiency haiku

  # Dry run to preview deployment
  aiwg -deploy-agents --provider cursor --mode sdlc --dry-run
`);
}

// ============================================================================
// Provider Loading
// ============================================================================

/**
 * Resolve provider name (handle aliases)
 */
function resolveProvider(name) {
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
    process.exit(1);
  }
  return resolved;
}

/**
 * Dynamically load provider module
 */
async function loadProvider(providerName) {
  const resolved = resolveProvider(providerName);
  const providerPath = `./providers/${resolved}.mjs`;

  try {
    const provider = await import(providerPath);
    return provider.default || provider;
  } catch (err) {
    console.error(`Failed to load provider '${resolved}':`, err.message);
    process.exit(1);
  }
}

// ============================================================================
// Model Shorthand Resolution
// ============================================================================

/**
 * Resolve a shorthand model value to a full model ID
 *
 * If the value is a known shorthand (opus, sonnet, haiku, inherit), resolve it
 * through the provider's shorthand map. Otherwise treat it as a literal model ID.
 *
 * @param {string|null} value - CLI flag value (e.g., "opus" or "claude-opus-4-6")
 * @param {object} shorthandMap - Provider shorthand map (e.g., { opus: "claude-opus-4-6" })
 * @param {object} modelsConfig - Full models config from loadModelConfig()
 * @param {string} provider - Provider name
 * @param {string} tier - Tier name: "reasoning", "coding", or "efficiency"
 * @returns {string|null} Resolved model ID or null if input was null
 */
function resolveShorthand(value, shorthandMap, modelsConfig, provider, tier) {
  if (!value) return null;

  const clean = value.toLowerCase().replace(/['"]/g, '');

  // Check shorthand map first
  if (shorthandMap[clean]) return shorthandMap[clean];

  // Check provider-specific tier config (e.g., modelsConfig.factory.reasoning.model)
  const providerConfig = modelsConfig?.[provider];
  if (providerConfig?.[tier]?.model && clean === tier) {
    return providerConfig[tier].model;
  }

  // Not a shorthand — return as literal model ID
  return value;
}

// ============================================================================
// Model Configuration Persistence
// ============================================================================

/**
 * Save model configuration to project or user config file
 * @param {object} cfg - Configuration with model overrides
 * @param {string} providerName - Provider name for provider-specific config
 */
async function saveModelConfig(cfg, providerName) {
  // Build config object with only the provided overrides
  const modelConfig = {};
  if (cfg.modelTier) {
    modelConfig.defaults = { tier: cfg.modelTier };
  }

  // Provider-specific tier configuration
  if (cfg.reasoningModel || cfg.codingModel || cfg.efficiencyModel) {
    modelConfig[providerName] = {};
    if (cfg.reasoningModel) {
      modelConfig[providerName].reasoning = { model: cfg.reasoningModel };
    }
    if (cfg.codingModel) {
      modelConfig[providerName].coding = { model: cfg.codingModel };
    }
    if (cfg.efficiencyModel) {
      modelConfig[providerName].efficiency = { model: cfg.efficiencyModel };
    }
  }

  // Shorthand mappings
  if (cfg.reasoningModel || cfg.codingModel || cfg.efficiencyModel) {
    modelConfig.shorthand = {};
    if (cfg.reasoningModel) modelConfig.shorthand.opus = cfg.reasoningModel;
    if (cfg.codingModel) modelConfig.shorthand.sonnet = cfg.codingModel;
    if (cfg.efficiencyModel) modelConfig.shorthand.haiku = cfg.efficiencyModel;
  }

  // Determine target path
  let targetPath;
  if (cfg.saveUser) {
    const configDir = path.join(os.homedir(), '.config', 'aiwg');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    targetPath = path.join(configDir, 'models.json');
  } else {
    targetPath = path.join(cfg.target, 'models.json');
  }

  // Merge with existing config if it exists
  let existingConfig = {};
  if (fs.existsSync(targetPath)) {
    try {
      existingConfig = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  // Deep merge: existing config + new overrides
  const mergedConfig = deepMerge(existingConfig, modelConfig);

  // Write the config
  fs.writeFileSync(targetPath, JSON.stringify(mergedConfig, null, 2) + '\n', 'utf8');
  console.log(`\nModel configuration saved to: ${targetPath}`);
}

/**
 * Deep merge two objects
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ============================================================================
// Commands → Skills Migration
// ============================================================================

/**
 * Ask the user whether to delete the provider's commands directory before
 * deploying skills. Skipped automatically when not running in a TTY (CI/pipe)
 * or when --quiet is set.
 *
 * @param {object} cfg - Parsed CLI config
 * @param {object} provider - Loaded provider module
 * @param {string} targetDir - Resolved target directory
 * @returns {Promise<boolean>} true = proceed with migration, false = skip
 */
async function promptCommandsMigration(cfg, provider, targetDir) {
  // Home-directory providers share commands across projects — do not delete.
  if (provider.capabilities?.homeDirectoryDeploy) return false;
  // Some providers intentionally expose both surfaces with different runtime
  // semantics. Pi prompt templates (/name) are not aliases for Agent Skills
  // (/skill:name), so command-to-skill migration would destroy valid prompts.
  if (provider.capabilities?.parallelCommandAndSkillSurfaces) return false;

  const commandsRelPath = provider.paths?.commands;
  if (!commandsRelPath) return false;

  const commandsDir = path.join(targetDir, commandsRelPath);
  if (!fs.existsSync(commandsDir)) return false;

  const entries = fs.readdirSync(commandsDir).filter(e => e.endsWith('.md'));
  if (entries.length === 0) return false;

  // Non-interactive context: migrate silently.
  if (cfg.quiet || !process.stdout.isTTY) return true;

  const rel = path.relative(process.cwd(), commandsDir);
  console.log(`\n⚠  Commands → Skills Migration`);
  console.log(`   ${rel} contains ${entries.length} legacy command file(s).`);
  console.log(`   AIWG now serves these as skills (.claude/skills/).`);
  console.log(`   Keeping both causes duplicate entries in the Claude Code command palette.`);
  console.log('');

  const answer = await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('   Remove commands directory and migrate? [Y/n] ', ans => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });

  if (answer === 'n' || answer === 'no') {
    console.log('');
    console.log('   Skipping migration. Run `aiwg use` again without --skip-commands-migration');
    console.log(`   to clean up, or delete ${rel} manually.`);
    console.log('');
    return false;
  }

  return true;
}

// ============================================================================
// Main Entry Point
// ============================================================================

export async function main() {
  const cfg = parseArgs();

  // Resolve source directory (default to repo root relative to this script)
  const __filename = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(__filename);
  const srcRoot = cfg.source || path.resolve(scriptDir, '..', '..');

  // Validate source directory
  if (!fs.existsSync(srcRoot)) {
    console.error(`Source directory not found: ${srcRoot}`);
    process.exit(1);
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
  if (!cfg.quiet) console.log(`\nLoaded provider: ${provider.name}`);

  // Build options for provider
  const opts = {
    srcRoot,
    target: cfg.target,
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
    asAgentsMd: cfg.asAgentsMd,
    createAgentsMd: cfg.createAgentsMd,
    deployCommands: cfg.kernelOnly ? false : cfg.deployCommands,
    deploySkills: cfg.kernelOnly ? true : cfg.deploySkills,
    deployRules: cfg.kernelOnly ? false : cfg.deployRules,
    deployBehaviors: cfg.kernelOnly ? false : cfg.deployBehaviors,
    commandsOnly: cfg.commandsOnly,
    skillsOnly: cfg.skillsOnly || cfg.kernelOnly,
    rulesOnly: cfg.rulesOnly,
    kernelOnly: cfg.kernelOnly,
    filter: cfg.filter,
    filterRole: cfg.filterRole,
    save: cfg.save,
    saveUser: cfg.saveUser,
    verbose: cfg.verbose,
    quiet: cfg.quiet,
    asPlugin: cfg.asPlugin,
    deployBehaviors: cfg.kernelOnly ? false : cfg.deployBehaviors,
    skipCommandsMigration: cfg.skipCommandsMigration,
    // #1217 / #1219: --copy-all flag forces legacy per-project mirror
    // for the standard tier. Default is no-copy + index-driven discovery.
    // Replaces the legacy AIWG_COPY_STANDARD_SKILLS env var (removed rc.30).
    // Default (#1217) is no-copy + index-driven discovery.
    copyStandardSkills: cfg.copyStandardSkills === true,
    deployVersion: getDeployVersion(srcRoot),
    deploySource: 'bundled',
  };

  // Commands → Skills migration: prompt then delete the commands directory
  // so stale command files don't create duplicates in the provider TUI.
  if (!cfg.dryRun && !cfg.skipCommandsMigration) {
    const doMigrate = await promptCommandsMigration(cfg, provider, cfg.target);
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

  // Delegate to provider
  try {
    await provider.deploy(opts);

    const mirroredCommandCount = mirrorSkillsAsCommands(provider, cfg.target, srcRoot, opts);
    if (mirroredCommandCount > 0 && !cfg.quiet) {
      console.log(`  Mirrored: ${mirroredCommandCount} skill command wrapper${mirroredCommandCount === 1 ? '' : 's'}`);
    }

    // Prune stale AIWG-managed agents/commands/rules whose source was renamed
    // or removed (the flat-file analogue of the skills holistic prune). #1627.
    pruneStaleAiwgArtifacts(provider, cfg.target, srcRoot, opts, cfg.source);

    if (!opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly) {
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

    if (!cfg.quiet) console.log(`\n=== Deployment complete ===\n`);
  } catch (err) {
    console.error(`\nDeployment failed:`, err.message);
    if (cfg.dryRun) {
      console.error('(dry-run mode - no files were modified)');
    }
    process.exit(1);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
