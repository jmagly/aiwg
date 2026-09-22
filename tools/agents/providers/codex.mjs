/**
 * OpenAI Codex Provider
 *
 * Deploys agents and commands for OpenAI Codex CLI. Commands are transformed
 * to prompts format via external script.
 *
 * Deployment paths:
 *   - Agents: <project>/.codex/agents/ (project-local)
 *   - Commands: ~/.codex/prompts/ (home directory, NOT project)
 *   - Skills: <project>/.agents/skills/ (project-local, cross-provider canonical)
 *   - Rules: <project>/.codex/rules/ (project-local, conventional)
 *
 * Skill path note (#766 regression fix):
 *   Codex (codex-rs/core-skills/src/loader.rs) scans the project-local
 *   `.agents/skills/` directory — the industry-standard, cross-provider path
 *   shared with OpenClaw, Warp, Copilot, and OpenCode. The legacy home-dir
 *   path `~/.codex/skills/` is deprecated. Earlier versions wrote BOTH, and
 *   because codex-rs scans both, every kernel skill appeared twice in the
 *   slash-command list (e.g. `/aiwg-regenerate` listed twice). We now write
 *   `.agents/skills/` only and prune the stale legacy home dir on deploy.
 *
 * Special features:
 *   - Model replacement (opus/sonnet/haiku -> catalog codex roles (gpt-5.6-sol/terra/luna))
 *   - --as-agents-md aggregation option
 *   - Delegates commands to deploy-prompts-codex.mjs (deploys to ~/.codex/prompts/)
 *   - Delegates skills to deploy-skills-codex.mjs (deploys to .agents/skills/)
 */

import realFs from 'fs';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
let fs;
try { const gfs = _require('graceful-fs'); gfs.gracefulify(realFs); fs = realFs; } catch { fs = realFs; }
const staticModelCatalog = _require('../../../agentic/code/providers/model-catalog.v1.json');
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { load as loadYaml } from 'js-yaml';
import { classifyModelRole, modelForRole } from './model-role.mjs';
import {
  ensureDir,
  listMdFiles,
  listMdFilesRecursive,
  writeFile,
  deployFiles,
  createAgentsMdFromTemplate,
  initializeFrameworkWorkspace,
  getAddonAgentFiles,
  getAddonCommandFiles,
  getAddonSkillDirs,
  getAddonRuleFiles,
  listSkillDirs,
  loadRuntimeModelCatalog,
  deploySkillDir,
  deploySkillsWithKernelRouting,
  getFrameworksForMode,
  normalizeDeploymentMode,
  getRulesIndexPath,
  cleanupOldRuleFiles,
  filterCommandsAgainstSkills,
  collectFrameworkArtifacts,
  listOnDemandRuleFiles,
  writeOnDemandRuleIndex,
  deploySoulCompanions,
  parseFrontmatter,
  resolveAiwgRoot
} from './base.mjs';
const modelCatalog = loadRuntimeModelCatalog(staticModelCatalog);

function resolveCodexHelperRoot(srcRoot) {
  const resolved = resolveAiwgRoot(srcRoot);
  if (resolved) return resolved;
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
}

// ============================================================================
// Provider Configuration
// ============================================================================

export const name = 'codex';
export const aliases = ['openai'];

export const paths = {
  agents: '.codex/agents/',
  commands: '.codex/commands/',  // Project-local mirror for conventional deployment
  // Skills sequestered under .codex/.aiwg/skills/ — index-driven discovery (#1212).
  skills: '.codex/.aiwg/skills/',
  rules: '.codex/rules/'
};

// Kernel skills (always-loaded) deploy to the project-local `.agents/skills/`
// directory — the cross-provider canonical path codex-rs natively scans. This
// is project-relative (joined with the deploy target), matching the other
// providers' kernel paths. The legacy home-dir path `~/.codex/skills/` is
// deprecated and pruned on deploy (#766 regression fix). The standard tier
// (when `--copy-all` is passed) lands alongside kernel skills; the
// deploy-skills-codex.mjs script filters non-kernel skills out by default (#1217).
export const kernelSkillsPath = '.agents/skills/';

// Legacy home-dir skills location written by AIWG versions prior to the #766
// regression fix. Pruned on every codex skill deploy so codex-rs stops listing
// each AIWG skill twice. Never touches non-AIWG (unmarked) skills.
const legacyHomeSkillsDir = path.join(os.homedir(), '.codex', 'skills');

export const support = {
  agents: 'native',
  commands: 'native',
  skills: 'native',
  rules: 'conventional'
};

export const capabilities = {
  skills: true,  // But deployed to home dir
  rules: true,
  aggregatedOutput: true,  // --as-agents-md
  yamlFormat: false
};

// ============================================================================
// Model Mapping
// ============================================================================

/**
 * Map model shorthand to OpenAI/GPT format
 */
export function mapModel(originalModel, modelCfg, modelsConfig) {
  const gptModels = {
    'opus': modelCatalog.providers.codex.roles.reasoning.id,
    'sonnet': modelCatalog.providers.codex.roles.coding.id,
    'haiku': modelCatalog.providers.codex.roles.efficiency.id
  };

  // Handle override models first
  if (modelCfg.reasoningModel || modelCfg.codingModel || modelCfg.efficiencyModel) {
    const mapped = modelForRole(originalModel, {
      reasoning: modelCfg.reasoningModel || gptModels.opus,
      coding: modelCfg.codingModel || gptModels.sonnet,
      efficiency: modelCfg.efficiencyModel || gptModels.haiku,
    }, { defaultRole: 'coding' });
    return mapped ?? originalModel;
  }

  return modelForRole(originalModel, {
    reasoning: gptModels.opus,
    coding: gptModels.sonnet,
    efficiency: gptModels.haiku,
  }, { defaultRole: 'coding' }) ?? originalModel;
}

function cleanYamlScalar(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

/**
 * Render a standalone Codex custom-agent TOML file.
 *
 * Required fields follow the current Codex custom-agent contract:
 * name, description, and developer_instructions. Model controls are native
 * config.toml keys and inherit only when omitted.
 *
 * @implements #1802
 */
export function renderAgentToml(srcPath, content, models) {
  const { frontmatter, body } = parseFrontmatter(content);
  if (!frontmatter) {
    throw new Error(`Codex agent ${srcPath} is missing YAML frontmatter`);
  }
  const metadata = loadYaml(frontmatter) || {};

  const name = cleanYamlScalar(metadata.name) || path.basename(srcPath, '.md');
  const description = cleanYamlScalar(metadata.description);
  const instructions = body.trim();
  if (!description) throw new Error(`Codex agent ${srcPath} is missing description`);
  if (!instructions) throw new Error(`Codex agent ${srcPath} has no developer instructions`);

  const role = classifyModelRole(metadata.model, { defaultRole: 'coding' });
  const model = role === 'unknown' ? cleanYamlScalar(metadata.model) : models[role];
  const effortMatch = frontmatter.match(/^model-effort:\s*([^\n]+)$/m);
  const effort = effortMatch
    ? cleanYamlScalar(effortMatch[1])
    : { reasoning: 'high', coding: 'medium', efficiency: 'low' }[role];

  const lines = [
    `name = ${tomlString(name)}`,
    `description = ${tomlString(description)}`,
    `developer_instructions = ${tomlString(instructions)}`,
  ];
  if (model) lines.push(`model = ${tomlString(model)}`);
  if (effort) lines.push(`model_reasoning_effort = ${tomlString(effort)}`);
  return `${lines.join('\n')}\n`;
}

// ============================================================================
// Content Transformation
// ============================================================================

/**
 * Transform agent content for Codex
 */
export function transformAgent(srcPath, content, opts) {
  const { reasoningModel, codingModel, efficiencyModel } = opts;
  const catalogModels = modelCatalog.providers.codex.roles;

  const models = {
    reasoning: reasoningModel || catalogModels.reasoning.id,
    coding: codingModel || catalogModels.coding.id,
    efficiency: efficiencyModel || catalogModels.efficiency.id
  };

  return renderAgentToml(srcPath, content, models);
}

/**
 * Transform command content for Codex
 */
export function transformCommand(srcPath, content, opts) {
  return content;
}

// ============================================================================
// Deployment Functions
// ============================================================================

/**
 * Deploy agents to .codex/agents/
 */
export function deployAgents(agentFiles, targetDir, opts) {
  const destDir = path.join(targetDir, paths.agents);
  ensureDir(destDir, opts.dryRun);
  return deployFiles(agentFiles, destDir, {
    ...opts,
    fileExtension: '.toml',
    injectPlatform: false,
  }, transformAgent);
}

/**
 * Deploy commands via external script
 *
 * NOTE: Codex prompts/commands go to ~/.codex/prompts/ (home directory)
 * not to the project directory. We do NOT pass --target to let the
 * script use its default home directory location.
 */
export async function deployCommands(targetDir, srcRoot, opts) {
  const helperRoot = resolveCodexHelperRoot(srcRoot);
  const scriptPath = path.join(helperRoot, 'tools', 'commands', 'deploy-prompts-codex.mjs');

  if (!fs.existsSync(scriptPath)) {
    console.warn(`Codex prompts deployment script not found at ${scriptPath}`);
    return;
  }

  console.log('Delegating command deployment to deploy-prompts-codex.mjs (~/.codex/prompts/)...');

  return new Promise((resolve, reject) => {
    // NOTE: Do NOT pass --target - Codex prompts belong in ~/.codex/prompts/ (home)
    const args = ['--source', srcRoot];
    if (opts.dryRun) args.push('--dry-run');
    if (opts.force) args.push('--force');
    if (opts.mode) args.push('--mode', opts.mode);
    if (opts.copyStandardSkills === true) args.push('--copy-all');
    // A copy-all the deployer forced on the caller's behalf (project-local
    // bundles) still honors the startup listing cap (#2561).
    if (opts.listingBudget === true) args.push('--listing-budget');

    const child = spawn('node', [scriptPath, ...args], {
      stdio: 'inherit',
      cwd: helperRoot
    });

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`deploy-prompts-codex.mjs exited with code ${code}`));
    });

    child.on('error', reject);
  });
}

/**
 * Deploy skills via external script
 */
export async function deploySkills(targetDir, srcRoot, opts) {
  const helperRoot = resolveCodexHelperRoot(srcRoot);
  const scriptPath = path.join(helperRoot, 'tools', 'skills', 'deploy-skills-codex.mjs');

  if (!fs.existsSync(scriptPath)) {
    console.warn(`Codex skills deployment script not found at ${scriptPath}`);
    return;
  }

  console.log('Delegating skill deployment to deploy-skills-codex.mjs...');

  // Deploy to the project-local .agents/skills/ — the SINGLE codex-scanned
  // target (industry-standard cross-provider path). Writing only here avoids
  // the duplicate slash-command bug that occurred when skills were ALSO
  // written to the legacy ~/.codex/skills/ home dir: codex-rs scans both, so
  // every kernel skill was listed twice (e.g. `/aiwg-regenerate`). See #766.
  const crossAgentSkillsDir = path.join(targetDir, '.agents', 'skills');
  console.log(`Deploying skills to ${crossAgentSkillsDir} (.agents/skills — codex-scanned path)...`);

  await new Promise((resolve, reject) => {
    const args = ['--source', srcRoot, '--target', crossAgentSkillsDir];
    // Overflow past Codex's startup listing cap lands here instead of being
    // deployed over the cap (#2561); the index still reaches these skills.
    args.push('--standard-target', path.join(targetDir, ...paths.skills.split('/').filter(Boolean)));
    if (opts.dryRun) args.push('--dry-run');
    if (opts.force) args.push('--force');
    if (opts.mode) args.push('--mode', opts.mode);
    if (opts.copyStandardSkills === true) args.push('--copy-all');
    // A copy-all the deployer forced on the caller's behalf (project-local
    // bundles) still honors the startup listing cap (#2561).
    if (opts.listingBudget === true) args.push('--listing-budget');

    const child = spawn('node', [scriptPath, ...args], {
      stdio: 'inherit',
      cwd: helperRoot
    });

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`deploy-skills-codex.mjs exited with code ${code}`));
    });

    child.on('error', reject);
  });

  // Self-heal: prune AIWG-managed skill dirs left behind in the legacy
  // ~/.codex/skills/ home location by pre-fix versions, so codex-rs stops
  // listing each skill twice.
  pruneLegacyCodexSkills(opts);
}

/**
 * Remove AIWG-managed skill directories from the legacy ~/.codex/skills/ home
 * location. Earlier AIWG versions deployed kernel skills there in addition to
 * .agents/skills/; since codex-rs scans both, this produced duplicate
 * slash-command entries (#766 half-fix regression). Only directories carrying
 * the `.aiwg-managed` marker are removed — user-authored skills are never
 * touched. The now-empty legacy dir is removed if AIWG owned everything in it.
 */
export function pruneLegacyCodexSkills(opts = {}, legacyDir = legacyHomeSkillsDir) {
  let entries;
  try {
    entries = fs.readdirSync(legacyDir, { withFileTypes: true });
  } catch {
    return 0; // legacy dir absent — nothing to prune
  }

  let pruned = 0;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillDir = path.join(legacyDir, ent.name);
    // `aiwg-mcp` was deployed before marker files existed and its malformed
    // pre-fix SKILL.md is rejected by Codex before AIWG can self-heal. The
    // exact retired name is safe to claim; all other unmarked skills remain
    // user-owned.
    const isKnownPreMarkerLegacySkill = ent.name === 'aiwg-mcp';
    if (
      !isKnownPreMarkerLegacySkill &&
      !fs.existsSync(path.join(skillDir, '.aiwg-managed'))
    ) continue; // leave user skills alone
    if (opts.dryRun) {
      console.log(`[dry-run] would prune legacy AIWG skill ${skillDir}`);
    } else {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
    pruned++;
  }

  if (pruned > 0) {
    console.log(`Pruned ${pruned} AIWG-managed skill${pruned === 1 ? '' : 's'} from legacy ~/.codex/skills/ (now deployed to .agents/skills/).`);
    if (!opts.dryRun) {
      // Remove the legacy dir only if AIWG owned everything in it.
      try {
        if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
      } catch { /* non-empty (user skills remain) — keep it */ }
    }
  }
  return pruned;
}

/**
 * Deploy rules to .codex/rules/
 */
export function deployRules(ruleFiles, targetDir, opts) {
  const destDir = path.join(targetDir, paths.rules);
  ensureDir(destDir, opts.dryRun);
  cleanupOldRuleFiles(destDir, opts);
  return deployFiles(ruleFiles, destDir, opts, transformCommand);
}

/**
 * Aggregate agents to single AGENTS.md file
 */
export function aggregateToAgentsMd(agentFiles, destPath, opts) {
  const blocks = [];
  for (const f of agentFiles) {
    let content = fs.readFileSync(f, 'utf8');
    content = transformAgent(f, content, opts);
    if (!content.endsWith('\n')) content += '\n';
    blocks.push(content);
  }
  const out = blocks.join('\n');
  if (opts.dryRun) console.log(`[dry-run] write ${destPath}`);
  else fs.writeFileSync(destPath, out, 'utf8');
  console.log(`wrote ${path.relative(process.cwd(), destPath)} with ${agentFiles.length} agents`);
}

// ============================================================================
// AGENTS.md
// ============================================================================

/**
 * Create/update AGENTS.md from Codex template
 */
export function createAgentsMd(target, srcRoot, dryRun) {
  createAgentsMdFromTemplate(target, srcRoot, 'codex/AGENTS.md.aiwg-template', dryRun);
}

// ============================================================================
// Plugin Bundle Generator
// ============================================================================

/**
 * Generate a Codex plugin bundle for AIWG SDLC.
 *
 * Creates:
 *   <targetDir>/agentic/code/plugins/sdlc/.codex-plugin/plugin.json  — Codex plugin manifest
 *   <targetDir>/.agents/plugins/marketplace.json        — Repo marketplace entry
 *
 * @param {string} targetDir - Root directory where bundle is written
 * @param {{ dryRun?: boolean, srcRoot?: string, version?: string }} opts
 */
export function generatePluginBundle(targetDir, opts = {}) {
  const { dryRun = false, srcRoot = process.cwd(), version: overrideVersion } = opts;

  // Resolve version: opts.version > package.json > 'unknown'
  let version = overrideVersion;
  if (!version) {
    try {
      const pkgPath = path.join(srcRoot, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      // Strip pre-release suffix so it stays CalVer-compliant
      version = (pkg.version || 'unknown').replace(/-.*$/, '');
    } catch {
      version = 'unknown';
    }
  }

  // ---- plugin.json --------------------------------------------------------
  const pluginManifest = {
    name: 'aiwg-sdlc',
    version,
    description:
      'Complete Software Development Lifecycle framework with 180+ specialized agents for requirements, architecture, security, testing, and deployment.',
    author: 'AIWG',
    homepage: 'https://aiwg.io',
    repository: 'https://github.com/jmagly/aiwg',
    license: 'MIT',
    skills: './skills/',
    keywords: ['sdlc', 'aiwg', 'agents', 'architecture', 'security', 'testing', 'deployment']
  };

  const pluginJsonDir = path.join(targetDir, 'agentic', 'code', 'plugins', 'sdlc', '.codex-plugin');
  const pluginJsonPath = path.join(pluginJsonDir, 'plugin.json');

  if (dryRun) {
    console.log(`[dry-run] would write ${pluginJsonPath}`);
  } else {
    fs.mkdirSync(pluginJsonDir, { recursive: true });
    fs.writeFileSync(pluginJsonPath, JSON.stringify(pluginManifest, null, 2) + '\n', 'utf8');
  }

  // ---- marketplace.json ---------------------------------------------------
  const marketplace = {
    name: 'aiwg-local',
    interface: {
      displayName: 'AIWG Plugins'
    },
    plugins: [
      {
        name: 'aiwg-sdlc',
        source: {
          path: './agentic/code/plugins/sdlc',
          source: 'local'
        },
        policy: {
          installation: 'AVAILABLE'
        },
        category: 'Development'
      }
    ]
  };

  const marketplaceDir = path.join(targetDir, '.agents', 'plugins');
  const marketplacePath = path.join(marketplaceDir, 'marketplace.json');

  if (dryRun) {
    console.log(`[dry-run] would write ${marketplacePath}`);
  } else {
    fs.mkdirSync(marketplaceDir, { recursive: true });
    fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n', 'utf8');
  }
}

// ============================================================================
// Post-Deployment
// ============================================================================

export async function postDeploy(targetDir, opts) {
  initializeFrameworkWorkspace(targetDir, opts.mode, opts.dryRun, opts.srcRoot);

  if (opts.createAgentsMd) {
    createAgentsMd(targetDir, opts.srcRoot, opts.dryRun);
  }
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

/**
 * Main deployment function for Codex provider
 */
export async function deploy(opts) {
  const {
    srcRoot,
    target,
    mode,
    deployCommands: shouldDeployCommands,
    deploySkills: shouldDeploySkills,
    deployRules: shouldDeployRules,
    commandsOnly,
    skillsOnly,
    rulesOnly,
    dryRun,
    asAgentsMd,
    asPlugin,
    createAgentsMd: shouldCreateAgentsMd
  } = opts;

  console.log(`\n=== OpenAI Codex Provider ===`);
  console.log(`Target: ${target}`);
  console.log(`Mode: ${mode}`);

  // Collect source files based on mode
  const agentFiles = [];
  const ruleFiles = [];
  const normalizedMode = normalizeDeploymentMode(mode);

  // Check for addon-style directory structure (direct agents/ and rules/
  // subdirs). Handles deployment when --source points at a project-local
  // bundle (.aiwg/extensions/<name>/) rather than $AIWG_ROOT. Mirrors the
  // reference implementation in claude.mjs (#124). Commands and skills are
  // resolved from srcRoot inside deployCommands/deploySkills, so only agents
  // and rules need the explicit short-circuit here.
  const isAddonSource = fs.existsSync(path.join(srcRoot, 'agents')) ||
                        fs.existsSync(path.join(srcRoot, 'commands')) ||
                        fs.existsSync(path.join(srcRoot, 'skills')) ||
                        fs.existsSync(path.join(srcRoot, 'rules'));

  if (isAddonSource) {
    const addonAgentsDir = path.join(srcRoot, 'agents');
    if (fs.existsSync(addonAgentsDir)) {
      agentFiles.push(...listMdFiles(addonAgentsDir));
    }

    if (shouldDeployRules || rulesOnly) {
      const addonRulesDir = path.join(srcRoot, 'rules');
      if (fs.existsSync(addonRulesDir)) {
        ruleFiles.push(...listMdFiles(addonRulesDir));
      }
    }
  }

  // Frameworks discovered from manifests/directory structure
  const frameworks = getFrameworksForMode(srcRoot, normalizedMode);
  for (const framework of frameworks) {
    if (framework.components.agents.exists) {
      agentFiles.push(...listMdFiles(framework.components.agents.path));
    }

    if (framework.id === 'sdlc-complete' && framework.components.rules.exists) {
      // Use consolidated RULES-INDEX.md for SDLC rules when available.
      const indexPath = getRulesIndexPath(srcRoot);
      if (indexPath) {
        ruleFiles.push(indexPath);
        continue;
      }
    }

    if (framework.components.rules.exists) {
      ruleFiles.push(...listMdFiles(framework.components.rules.path));
    }
  }

  // All addons (dynamically discovered)
  if (normalizedMode === 'general' || normalizedMode === 'sdlc' || normalizedMode === 'both' || normalizedMode === 'all') {
    agentFiles.push(...getAddonAgentFiles(srcRoot));
    ruleFiles.push(...getAddonRuleFiles(srcRoot));
  }

  // Collect soul companion files
  const soulArtifacts = collectFrameworkArtifacts(srcRoot, normalizedMode, {
    includeAgents: false,
    includeCommands: false,
    includeSkills: false,
    includeRules: false
  });
  const soulFiles = [...(soulArtifacts.souls || [])];

  // Deploy based on flags
  if (!commandsOnly && !skillsOnly && !rulesOnly) {
    if (asAgentsMd) {
      // Aggregate to single AGENTS.md
      const destPath = path.join(target, 'AGENTS.md');
      console.log(`\nAggregating ${agentFiles.length} agents to AGENTS.md...`);
      aggregateToAgentsMd(agentFiles, destPath, opts);
    } else {
      console.log(`\nDeploying ${agentFiles.length} agents...`);
      deployAgents(agentFiles, target, opts);
    }

    // Deploy soul companion files alongside agents
    if (soulFiles.length > 0) {
      const destDir = path.join(target, paths.agents);
      ensureDir(destDir, opts.dryRun);
      console.log(`\nDeploying ${soulFiles.length} soul files...`);
      deploySoulCompanions(soulFiles, destDir, opts);
    }
  }

  if (shouldDeployCommands || commandsOnly) {
    console.log(`\nDeploying commands...`);
    await deployCommands(target, srcRoot, opts);
  }

  if (shouldDeploySkills || skillsOnly) {
    console.log(`\nDeploying skills to .agents/skills/...`);
    await deploySkills(target, srcRoot, opts);
  }

  if (shouldDeployRules || rulesOnly) {
    console.log(`\nDeploying ${ruleFiles.length} rules...`);
    deployRules(ruleFiles, target, opts);

    // On-demand index (#1675): list the MEDIUM/LOW rules tier-gated out of the
    // always-on set so agents can fetch them via `aiwg show rule`.
    const onDemandCount = writeOnDemandRuleIndex(
      path.join(target, paths.rules),
      listOnDemandRuleFiles(srcRoot),
      opts,
    );
    if (onDemandCount > 0) {
      console.log(`  On-demand rules (not inlined): ${onDemandCount} → RULES-ONDEMAND.md`);
    }
  }

  // Post-deployment
  await postDeploy(target, { ...opts, createAgentsMd: shouldCreateAgentsMd });

  // Plugin bundle (opt-in via --as-plugin)
  if (asPlugin) {
    console.log('\nGenerating Codex plugin bundle...');
    generatePluginBundle(target, { dryRun, srcRoot });
  }

  console.log('\n=== Codex deployment complete ===\n');
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
  mapModel,
  deployAgents,
  deployCommands,
  deploySkills,
  deployRules,
  aggregateToAgentsMd,
  createAgentsMd,
  postDeploy,
  getFileExtension,
  generatePluginBundle,
  deploy
};
