import { importImpl } from '../../_resolve-impl.mjs';
/**
 * Devin Provider (native .devin/ with legacy deployment migration)
 *
 * Devin Desktop/CLI 3.x reads `.devin/` natively (rules, skills, agents,
 * project MCP config) and imports `.windsurf/` as a legacy surface. The
 * canonical `devin` selector deploys native `.devin/` paths; the deprecated
 * `windsurf` selector is a deprecated alias with identical native output.
 *
 * Deployment paths (devin selector):
 *   - Output: AGENTS.md (bootstrap, compact core and rules hook)
 *   - Output: .devin/rules/aiwg-orchestration.md (orchestration context, trigger: always_on)
 *   - Output: .windsurfrules (deprecated stub — retained for backward compat only)
 *   - Commands: .devin/skills/<name>/SKILL.md (commands as skills; Devin has no workflow surface)
 *   - Skills: .devin/skills/ (kernel, discrete skill directories)
 *   - Skills: .agents/skills/ (cross-agent compatibility path)
 *   - Rules: .devin/rules/ (discrete rule files with trigger frontmatter)
 *   - MCP: .devin/mcp_config.json (project-scope, merge-safe)
 *   - Agents: .devin/agents/<name>.md (native subagent profiles)
 *
 *
 * Migration:
 *   - A `devin` deploy removes AIWG-managed `.windsurf/` artifacts left by
 *     earlier versions (marker/sidecar ownership only — operator files are
 *     preserved) once their `.devin/` replacements exist.
 *
 * Special features:
 *   - Discrete agent definitions as Devin subagent profiles (.devin/agents/)
 *   - Capabilities tags for tools in agent bodies
 *   - Commands delivered as skills (Devin imports, never reads, .windsurf/workflows/)
 *   - Devin Desktop selectors resolve to the canonical `devin` provider id
 */
import realFs from 'fs';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
let fs;
try { const gfs = _require('graceful-fs'); gfs.gracefulify(realFs); fs = realFs; } catch { fs = realFs; }
import path from 'path';
import {
  withRuleDeployment,
  ensureDir,
  initializeFrameworkWorkspace,
  getAddonAgentFiles,
  getAddonCommandFiles,
  getAddonRuleFiles,
  getAddonSkillDirs,
  listSkillDirs,
  deploySkillDir,
  deploySkillsWithKernelRouting,
  isKernelSkill,
  pruneStaleAiwgSkills,
  computeAllKernelNames,
  normalizeDeploymentMode,
  collectFrameworkArtifacts,
  listOnDemandRuleFiles,
  writeOnDemandRuleIndex,
  cleanupOldRuleFiles,
  filterCommandsAgainstSkills,
  deploySoulCompanions
} from './base.mjs';
import { migrateLegacyWindsurfContent } from './devin-migration.mjs';
import { transformAgent, transformCommand, transformRule } from './devin-transforms.mjs';
import { generateAgentsMd, generateWindsurfRules, deployWorkflows, ensureDevinMcpConfig } from './devin-context.mjs';
export { transformAgent, transformCommand, transformRule, generateAgentsMd, generateWindsurfRules, deployWorkflows };
// ============================================================================
// Provider Configuration
// ============================================================================
export const name = 'devin';
export const aliases = ['windsurf', 'devin-desktop', 'devin-local', 'cascade'];

// Native `.devin/` layout — Devin Desktop/CLI 3.x reads these directly
// (verified on devin-desktop 3.14 via PROBE tokens in .devin/rules/,
// .devin/skills/, and .agents/skills/).
export const paths = {
  agents: '.devin/agents/',          // Native subagent profiles (name/description frontmatter)
  commands: null,                    // No command-file surface — commands deploy as skills into .devin/skills/
  // Skills sequestered under .devin/.aiwg/skills/ — index-driven discovery (#1212).
  skills: '.devin/.aiwg/skills/',
  crossAgentSkills: '.agents/skills/',  // Cross-agent compatibility path (#576)
  rules: '.devin/rules/'
};

// Kernel skills (always-loaded) deploy to the platform-native dir.
export const kernelSkillsPath = '.devin/skills/';

// Commands land in the native skills dir as <name>/SKILL.md.
const nativeCommandsDest = '.devin/skills/';

function layoutFor() {
  return { paths, kernelSkillsPath, commandsDest: nativeCommandsDest };
}

export const support = {
  agents: 'aggregated',      // Agents aggregated into AGENTS.md
  commands: 'native',        // Native workflow/commands support
  skills: 'conventional',    // Conventional discrete deployment
  rules: 'conventional'      // Conventional discrete deployment
};

export const capabilities = {
  skills: true,
  rules: true,
  aggregatedOutput: true,  // All content in single file
  yamlFormat: false
};

export function mapModel(shorthand, modelCfg, modelsConfig) {
  return shorthand;
}

// ============================================================================
// Skills Deployment
// ============================================================================

/**
 * Deploy skills to .devin/skills/ (primary) and .agents/skills/ (cross-agent compatibility).
 * The .agents/skills/ path is an interop convention for projects using multiple AI coding tools.
 */
export function deploySkills(skillDirs, targetDir, opts) {
  const layout = layoutFor(opts);
  // Primary: kernel-vs-standard routing (#1212/#1216)
  //   - kernel skills → .devin/skills/            (platform-native, always-loaded)
  //   - standard      → .devin/.aiwg/skills/      (index-discoverable)
  const standardDestDir = path.join(targetDir, layout.paths.skills);
  const kernelDestDir = path.join(targetDir, layout.kernelSkillsPath);
  deploySkillsWithKernelRouting(skillDirs, standardDestDir, kernelDestDir, opts);

  // Cross-agent compatibility: .agents/skills/
  const crossAgentDir = path.join(targetDir, layout.paths.crossAgentSkills);
  ensureDir(crossAgentDir, opts.dryRun);
  if (!opts.dryRun) {
    console.log(`Deploying cross-agent skills to ${path.relative(process.cwd(), crossAgentDir)}...`);
  } else {
    console.log(`[dry-run] Would deploy cross-agent skills to .agents/skills/`);
  }
  for (const skillDir of skillDirs) {
    deploySkillDir(skillDir, crossAgentDir, opts);
  }
}

// ============================================================================
// Rules Deployment
// ============================================================================

/**
 * Deploy rules as discrete files with trigger: always_on frontmatter injected
 */
export function deployRules(ruleFiles, targetDir, opts) {
  if (opts.ruleDelivery) return [];
  const destDir = path.join(targetDir, layoutFor(opts).paths.rules);
  ensureDir(destDir, opts.dryRun);
  cleanupOldRuleFiles(destDir, opts);
  return deployFiles(ruleFiles, destDir, opts, transformRule);
}

// ============================================================================
// Post-Deployment
// ============================================================================

export async function postDeploy(targetDir, opts) {
  initializeFrameworkWorkspace(targetDir, opts.mode, opts.dryRun, opts.srcRoot);
}

// ============================================================================
// File Extension
// ============================================================================

export function getFileExtension(type) {
  return '.md';
}

// ============================================================================
// Main Deploy Function
// ============================================================================

export async function deploy(opts) {
  const layout = layoutFor(opts);
  return withRuleDeployment(opts, { name, paths: layout.paths, kernelSkillsPath: layout.kernelSkillsPath }, deploySelected);
}

async function deploySelected(opts) {
  const {
    srcRoot,
    target,
    mode,
    deployCommands,
    deploySkills: shouldDeploySkills,
    deployRules: shouldDeployRules,
    commandsOnly,
    skillsOnly,
    rulesOnly,
    dryRun
  } = opts;

  const layout = layoutFor(opts);
  const lpaths = layout.paths;
  console.log(`\n=== Devin Desktop Provider (native .devin/ layout) ===`);
  console.log(`Target: ${target}`);
  console.log(`Mode: ${mode}`);
  const normalizedMode = normalizeDeploymentMode(mode);

  // Collect all agent files based on mode
  const allAgentFiles = [];

  // All addons (dynamically discovered)
  if (normalizedMode === 'general' || normalizedMode === 'sdlc' || normalizedMode === 'both' || normalizedMode === 'all') {
    allAgentFiles.push(...getAddonAgentFiles(srcRoot));
  }

  const frameworkAgents = collectFrameworkArtifacts(srcRoot, normalizedMode, {
    includeAgents: true,
    includeCommands: false,
    includeSkills: false,
    includeRules: false
  });
  allAgentFiles.push(...frameworkAgents.agents);
  const soulFiles = [...(frameworkAgents.souls || [])];

  // Generate aggregated AGENTS.md
  if (allAgentFiles.length > 0 && !commandsOnly && !skillsOnly && !rulesOnly) {
    const agentsMdPath = path.join(target, 'AGENTS.md');
    console.log(`\nGenerating AGENTS.md with ${allAgentFiles.length} agents...`);
    generateAgentsMd(allAgentFiles, agentsMdPath, opts);

    // Deploy soul companion files alongside agents (discrete mirror dir)
    if (soulFiles.length > 0) {
      const destDir = path.join(target, lpaths.agents);
      ensureDir(destDir, opts.dryRun);
      console.log(`\nDeploying ${soulFiles.length} soul files...`);
      deploySoulCompanions(soulFiles, destDir, opts);
    }
  }

  // Generate <rules>/aiwg-orchestration.md (trigger: always_on) + deprecated .windsurfrules stub
  if (!commandsOnly && !skillsOnly && !rulesOnly) {
    console.log(`\nGenerating orchestration rule (${lpaths.rules}aiwg-orchestration.md)...`);
    generateWindsurfRules(srcRoot, target, opts);
  }

  // Collect skill directories early so we can filter command collisions
  const skillDirs = [];
  if (shouldDeploySkills || skillsOnly) {
    // All addons (dynamically discovered)
    if (normalizedMode === 'general' || normalizedMode === 'sdlc' || normalizedMode === 'both' || normalizedMode === 'all') {
      skillDirs.push(...getAddonSkillDirs(srcRoot));
  
    // Holistic post-deploy cleanup of stale AIWG-managed kernel
    // skills (renamed/removed sources). Uses the global kernel set
    // (computeAllKernelNames walks all source frameworks/addons),
    // not just this-call's skillDirs, because aiwg use invokes
    // deploy-agents.mjs multiple times.
    {
      const _kernelDestDir = path.isAbsolute(layout.kernelSkillsPath)
        ? layout.kernelSkillsPath
        : path.join(target, layout.kernelSkillsPath);
      pruneStaleAiwgSkills(_kernelDestDir, computeAllKernelNames(srcRoot), opts);
    }
  }

    const frameworkSkills = collectFrameworkArtifacts(srcRoot, normalizedMode, {
      includeAgents: false,
      includeCommands: false,
      includeSkills: true,
      includeRules: false
    });
    skillDirs.push(...frameworkSkills.skills);
  }

  // Deploy commands as Devin Desktop workflows
  if (deployCommands || commandsOnly) {
    // Collect command files based on mode
    const commandFiles = [];

    // All addons (dynamically discovered)
    if (normalizedMode === 'general' || normalizedMode === 'sdlc' || normalizedMode === 'both' || normalizedMode === 'all') {
      commandFiles.push(...getAddonCommandFiles(srcRoot));
    }

    const frameworkCommands = collectFrameworkArtifacts(srcRoot, normalizedMode, {
      includeAgents: false,
      includeCommands: true,
      includeSkills: false,
      includeRules: false,
      recursiveCommands: true
    });
    commandFiles.push(...frameworkCommands.commands);

    // Filter commands that collide with skills (skills take precedence)
    const filteredCommands = skillDirs.length > 0
      ? filterCommandsAgainstSkills(commandFiles, skillDirs)
      : commandFiles;

    if (filteredCommands.length > 0) {
      deployWorkflows(filteredCommands, target, opts);
    }
  }

  // Deploy skills
  if (skillDirs.length > 0 && (shouldDeploySkills || skillsOnly)) {
    console.log(`\nDeploying ${skillDirs.length} skills...`);
    deploySkills(skillDirs, target, opts);
  }

  // Deploy rules
  if (shouldDeployRules || rulesOnly) {
    // Collect rule files based on mode
    const ruleFiles = [];

    // All addons (dynamically discovered)
    if (normalizedMode === 'general' || normalizedMode === 'sdlc' || normalizedMode === 'both' || normalizedMode === 'all') {
      ruleFiles.push(...getAddonRuleFiles(srcRoot));
    }

    const frameworkRules = collectFrameworkArtifacts(srcRoot, normalizedMode, {
      includeAgents: false,
      includeCommands: false,
      includeSkills: false,
      includeRules: true,
      consolidatedSdlcRules: true
    });
    ruleFiles.push(...frameworkRules.rules);

    if (ruleFiles.length > 0) {
      console.log(`\nDeploying ${ruleFiles.length} rules...`);
      deployRules(ruleFiles, target, opts);

      // On-demand index (#1675): list the MEDIUM/LOW rules tier-gated out of the
      // always-on set so agents can fetch them via `aiwg show rule`.
      const onDemandCount = writeOnDemandRuleIndex(
        path.join(target, lpaths.rules),
        listOnDemandRuleFiles(srcRoot),
        opts,
      );
      if (onDemandCount > 0) {
        console.log(`  On-demand rules (not inlined): ${onDemandCount} → RULES-ONDEMAND.md`);
      }
    }
  }

  // Project MCP config — Devin reads .devin/mcp_config.json natively.
  if (!commandsOnly && !skillsOnly && !rulesOnly) {
    ensureDevinMcpConfig(target, opts);
  }

  // Migrate AIWG-managed .windsurf/ artifacts replaced by the .devin/ layout.
  migrateLegacyWindsurfContent(target, opts);

  // Post-deployment
  await postDeploy(target, opts);

  console.log('\n' + '='.repeat(70));
  console.log(`Devin Desktop deployment complete (native .devin/ layout). Generated files:`);
  console.log('  - AGENTS.md (agent catalog)');
  console.log(`  - ${lpaths.rules}aiwg-orchestration.md (orchestration context, trigger: always_on)`);
  console.log('  - .windsurfrules (deprecated stub — Devin Desktop may ignore this file)');
  console.log('  - .devin/mcp_config.json (project MCP configuration)');
  if (deployCommands || commandsOnly) {
    console.log(`  - ${layout.commandsDest} (commands as skills)`);
  }
  if (shouldDeploySkills || skillsOnly) {
    console.log(`  - ${layout.kernelSkillsPath} (discrete skill directories)`);
    console.log('  - .agents/skills/ (cross-agent compatibility)');
  }
  if (shouldDeployRules || rulesOnly) {
    console.log(`  - ${lpaths.rules} (discrete rule files with trigger frontmatter)`);
  }
  console.log('='.repeat(70) + '\n');
}

// ============================================================================
// Default Export
// ============================================================================

export default {
  name,
  aliases,
  paths,
  kernelSkillsPath,
  support,
  capabilities,
  transformAgent,
  transformCommand,
  transformRule,
  mapModel,
  generateAgentsMd,
  generateWindsurfRules,
  deployWorkflows,
  deploySkills,
  deployRules,
  postDeploy,
  getFileExtension,
  deploy
};
