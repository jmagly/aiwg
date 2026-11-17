import { deployCursorPromptDiscovery } from './cursor-prompt-discovery.mjs';
import { withModelWrapper } from './model-wrapper.mjs';
/**
 * Cursor IDE Provider
 *
 * Deploys agents, commands, skills, and rules for Cursor IDE.
 * Rules use native .cursor/rules/ support with MDC format.
 * Other artifacts use conventional .cursor/ subdirectories.
 *
 * Deployment paths:
 *   - Agents: .cursor/agents/
 *   - Commands: .cursor/commands/
 *   - Skills: .cursor/skills/
 *   - Rules: .cursor/rules/
 *
 * Special features:
 *   - MDC format (.mdc extension) for rules
 *   - Glob pattern attachment for rules
 *   - $ARGUMENTS -> [arguments] conversion for rules
 *   - Delegates rules deployment to deploy-rules-cursor.mjs
 */
import realFs from 'fs';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const staticModelCatalog = _require('../../../agentic/code/providers/model-catalog.v1.json');
let fs;
try { const gfs = _require('graceful-fs'); gfs.gracefulify(realFs); fs = realFs; } catch { fs = realFs; }
import path from 'path';
import { spawn } from 'child_process';
import {
  withRuleDeployment,
  parseRuleActivation,
  ensureDir,
  listMdFiles,
  listMdFilesRecursive,
  listSkillDirs,
  deployFiles,
  deploySkillDir,
  deploySkillsWithKernelRouting,
  isKernelSkill,
  pruneStaleAiwgSkills,
  computeAllKernelNames,
  filterAgentFiles,
  getAddonAgentFiles,
  getAddonCommandFiles,
  getAddonSkillDirs,
  getAddonRuleFiles,
  createAgentsMdFromTemplate,
  initializeFrameworkWorkspace,
  normalizeDeploymentMode,
  collectFrameworkArtifacts,
  listOnDemandRuleFiles,
  writeOnDemandRuleIndex,
  cleanupOldRuleFiles,
  filterCommandsAgainstSkills,
  deploySoulCompanions,
  loadRuntimeModelCatalog
} from './base.mjs';
const modelCatalog = loadRuntimeModelCatalog(staticModelCatalog);
// ============================================================================
// Provider Configuration
// ============================================================================
export const name = 'cursor';
export const aliases = [];
export const paths = {
  agents: '.cursor/agents/',
  commands: '.cursor/commands/',
  // Skills sequestered under .cursor/.aiwg/skills/ — index-driven discovery (#1212).
  skills: '.cursor/.aiwg/skills/',
  rules: '.cursor/rules/'
};

// Kernel skills (always-loaded) deploy to the platform-native dir.
export const kernelSkillsPath = '.cursor/skills/';

export const support = {
  agents: 'conventional',
  commands: 'conventional',
  skills: 'conventional',
  rules: 'native'
};

export const capabilities = {
  agents: true,
  commands: true,
  skills: true,
  rules: true,  // Rules-focused provider with native support
  aggregatedOutput: false,
  yamlFormat: false
};

// ============================================================================
// Content Transformation
// ============================================================================

/**
 * Transform agent content for Cursor
 * Cursor uses conventional deployment - minimal transformation needed
 */
export const transformAgent = withModelWrapper('cursor', translateAgent);
function translateAgent(srcPath, content, opts) {
  const model = content.match(/^model:\s*(.+)$/m)?.[1]?.trim().replace(/['"]/g, '');
  if (!model) return content;
  const roles = modelCatalog.providers.cursor.roles;
  const mapped = /opus/i.test(model)
    ? roles.reasoning.id
    : /haiku/i.test(model)
      ? roles.efficiency.id
      : roles.coding.id;
  return content.replace(/^model:\s*.+$/m, `model: ${mapped}`);
}

/**
 * Transform command content for Cursor
 * Cursor uses conventional deployment - minimal transformation needed
 */
export function transformCommand(srcPath, content, opts) {
  return content;
}

/** Compile the shared five-mode activation contract to native MDC. */
export function transformRule(srcPath, content, opts) {
  const parsed = parseRuleActivation(content);
  if (!parsed.valid) throw new Error(`${srcPath}: ${parsed.diagnostics.map(d => d.message).join('; ')}`);
  if (parsed.rule.tagged) {
    const rule = parsed.rule;
    // Bound/on-demand rules have no auto-selection description or glob hint.
    const fields = rule.activation === 'paths'
      ? `globs: ${JSON.stringify(rule.paths)}\nalwaysApply: false`
      : rule.activation === 'summary'
        ? `description: ${JSON.stringify(rule.summary)}\nalwaysApply: false`
        : `alwaysApply: ${rule.activation === 'kernel'}`;
    return `---\n${fields}\n---\n${parsed.body}`;
  }
  // Detect proper YAML frontmatter — must close within the first 30 lines.
  // Files with `---` horizontal rules deeper in markdown content (like
  // RULES-INDEX.md) can have multiple `---` lines without being frontmatter;
  // the line-budget keeps us from misidentifying horizontal rules as frontmatter
  // delimiters.
  const lines = content.split('\n');
  let fmEnd = -1;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < Math.min(lines.length, 30); i++) {
      if (lines[i].trim() === '---') {
        fmEnd = i;
        break;
      }
      // YAML frontmatter is key:value pairs. If we see a markdown heading or
      // bold/italic markers in what would be frontmatter, this is not YAML.
      if (/^(#{1,6}\s|\*\*|^\* )/.test(lines[i])) {
        fmEnd = -1;
        break;
      }
    }
  }

  if (fmEnd > 0) {
    const existingFm = lines.slice(1, fmEnd).join('\n');
    const body = lines.slice(fmEnd + 1).join('\n');

    // If the operator already set alwaysApply, leave it alone.
    if (/^\s*alwaysApply\s*:\s*\w+/m.test(existingFm)) {
      return content;
    }

    // PUW-021 (#1122): if source frontmatter declares `globs:` (or
    // `applyTo:` for Copilot-style rules), emit Cursor MDC `globs:` plus
    // `alwaysApply: false`. The activation mode is implicitly `glob`.
    const globsMatch = /^\s*globs?\s*:\s*(.+)$/m.exec(existingFm);
    const applyToMatch = /^\s*applyTo\s*:\s*(.+)$/m.exec(existingFm);
    if (globsMatch || applyToMatch) {
      const globValue = (globsMatch?.[1] || applyToMatch?.[1] || '').trim().replace(/^['"]|['"]$/g, '');
      let mergedFm = existingFm.trimEnd();
      // Add globs field if absent (operator already set globs would have matched).
      if (!globsMatch) {
        mergedFm += `\nglobs: '${globValue}'`;
      }
      mergedFm += '\nalwaysApply: false';
      return `---\n${mergedFm}\n---\n${body}`;
    }

    const updatedFm = existingFm.trimEnd() + '\nalwaysApply: true';
    return `---\n${updatedFm}\n---\n${body}`;
  }

  // No (proper) frontmatter — prepend a minimal MDC block.
  return `---\nalwaysApply: true\n---\n${content}`;
}

// ============================================================================
// Model Mapping (not applicable for Cursor)
// ============================================================================

export function mapModel(shorthand, modelCfg, modelsConfig) {
  return shorthand;
}

// ============================================================================
// Deployment Functions
// ============================================================================

/**
 * Deploy agents to .cursor/agents/
 */
export function deployAgents(agentFiles, targetDir, opts) {
  const destDir = path.join(targetDir, paths.agents);
  ensureDir(destDir, opts.dryRun);
  return deployFiles(agentFiles, destDir, { ...opts, injectPlatform: true }, transformAgent);
}

/**
 * Deploy commands to .cursor/commands/
 */
export function deployCommands(commandFiles, targetDir, opts) {
  const destDir = path.join(targetDir, paths.commands);
  ensureDir(destDir, opts.dryRun);
  return deployFiles(commandFiles, destDir, opts, transformCommand);
}

/**
 * Deploy skills with kernel-vs-standard routing (#1212/#1216).
 *   - kernel skills → .cursor/skills/        (platform-native, always-loaded)
 *   - standard      → .cursor/.aiwg/skills/  (index-discoverable)
 */
export function deploySkills(skillDirs, targetDir, opts) {
  const standardDestDir = path.join(targetDir, paths.skills);
  const kernelDestDir = path.join(targetDir, kernelSkillsPath);
  deploySkillsWithKernelRouting(skillDirs, standardDestDir, kernelDestDir, opts);
}

/**
 * Deploy rules via external script (native MDC support)
 * Falls back to inline deployment if script not found
 */
export async function deployRulesViaScript(targetDir, srcRoot, opts) {
  const scriptPath = path.join(srcRoot, 'tools', 'rules', 'deploy-rules-cursor.mjs');

  if (!fs.existsSync(scriptPath)) {
    console.warn(`Cursor rules deployment script not found at ${scriptPath}`);
    return false;
  }

  console.log('Delegating rules deployment to deploy-rules-cursor.mjs...');

  return new Promise((resolve, reject) => {
    const args = ['--target', targetDir, '--source', srcRoot];
    if (opts.dryRun) args.push('--dry-run');
    if (opts.force) args.push('--force');
    if (opts.mode) args.push('--mode', opts.mode);

    const child = spawn('node', [scriptPath, ...args], {
      stdio: 'inherit',
      cwd: srcRoot
    });

    child.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`deploy-rules-cursor.mjs exited with code ${code}`));
    });

    child.on('error', reject);
  });
}

/**
 * Deploy rules to .cursor/rules/ (inline deployment)
 * Used as fallback when external script is not available
 */
export function deployRulesInline(ruleFiles, targetDir, opts) {
  const destDir = path.join(targetDir, paths.rules);
  ensureDir(destDir, opts.dryRun);
  // Migrate legacy AIWG `.md` rules → `.mdc`. Cursor's rules engine only loads
  // `.mdc` files, so AIWG-managed `.md` rules from an older deploy are inert and
  // would linger (cleanup matches by stem, keeping them). Remove the marker-
  // bearing `.md` leftovers so the `.mdc` we emit below is the live copy.
  if (!opts.dryRun && fs.existsSync(destDir)) {
    for (const name of fs.readdirSync(destDir)) {
      if (!name.endsWith('.md') || name === 'RULES-INDEX.md') continue;
      const p = path.join(destDir, name);
      try {
        if (fs.readFileSync(p, 'utf8').includes('aiwg:managed')) {
          fs.unlinkSync(p);
          console.log(`  migrated legacy rule to .mdc (removed ${name})`);
        }
      } catch { /* ignore unreadable file */ }
    }
  }
  // #1143: skip cleanup when this deploy has 0 rules.
  cleanupOldRuleFiles(destDir, { ...opts, incomingFiles: ruleFiles });
  // transformRule injects native MDC frontmatter (globs → alwaysApply:false when
  // the source declares them; else alwaysApply:true). Emit with the `.mdc`
  // extension Cursor actually loads — getFileExtension('rule') === '.mdc'.
  return deployFiles(ruleFiles, destDir, { ...opts, fileExtension: '.mdc' }, transformRule);
}

/**
 * Deploy rules - tries external script first, falls back to inline
 */
export async function deployRules(ruleFilesOrTarget, targetDirOrSrcRoot, optsOrUndefined) {
  // Handle both call signatures:
  // 1. deployRules(targetDir, srcRoot, opts) - from old code
  // 2. deployRules(ruleFiles, targetDir, opts) - from new code

  // Check if first arg is array (new signature) or string (old signature)
  if (Array.isArray(ruleFilesOrTarget)) {
    // New signature: deployRules(ruleFiles, targetDir, opts)
    return deployRulesInline(ruleFilesOrTarget, targetDirOrSrcRoot, optsOrUndefined);
  } else {
    // Old signature: deployRules(targetDir, srcRoot, opts)
    // Try external script first
    try {
      const success = await deployRulesViaScript(ruleFilesOrTarget, targetDirOrSrcRoot, optsOrUndefined);
      if (success) return;
    } catch (err) {
      console.warn('External rules script failed, using inline deployment');
    }

    // Fallback to inline - need to collect rule files
    console.log('Using inline rules deployment...');
    const ruleFiles = [];
    const srcRoot = targetDirOrSrcRoot;
    const opts = optsOrUndefined;

    // Use consolidated index if available
    const indexPath = getRulesIndexPath(srcRoot);
    if (indexPath) {
      ruleFiles.push(indexPath);
    } else {
      const sdlcRulesDir = path.join(srcRoot, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'rules');
      if (fs.existsSync(sdlcRulesDir)) {
        ruleFiles.push(...listMdFiles(sdlcRulesDir));
      }
    }

    deployRulesInline(ruleFiles, ruleFilesOrTarget, opts);
  }
}

// ============================================================================
// AGENTS.md
// ============================================================================

export function createAgentsMd(target, srcRoot, dryRun) {
  createAgentsMdFromTemplate(target, srcRoot, 'cursor/AGENTS.md.aiwg-template', dryRun);
}

// ============================================================================
// Cloud agent + worktree configuration (PUW-019 #1120)
// ============================================================================

/**
 * Deploy Cursor cloud-agent + worktree config templates.
 *
 * Per PUW-019: AIWG ships templates at
 *   agentic/code/frameworks/sdlc-complete/templates/cursor/environment.json.aiwg-template
 *   agentic/code/frameworks/sdlc-complete/templates/cursor/worktrees.json.aiwg-template
 * but they were never wired into the deployer. This emits them at
 *   .cursor/environment.json
 *   .cursor/worktrees.json
 * only when the operator-provided file is absent (always-deploy invariant
 * §0.6 — we don't overwrite operator-authored config). When the file
 * exists, deploy is skipped with a verbose-only note.
 */
export function deployCursorConfigTemplates(targetDir, srcRoot, opts) {
  const cursorDir = path.join(targetDir, '.cursor');
  ensureDir(cursorDir, opts?.dryRun);

  const templates = [
    { src: 'cursor/environment.json.aiwg-template', dest: 'environment.json' },
    { src: 'cursor/worktrees.json.aiwg-template', dest: 'worktrees.json' },
  ];

  for (const t of templates) {
    const srcPath = path.join(
      srcRoot,
      'agentic',
      'code',
      'frameworks',
      'sdlc-complete',
      'templates',
      t.src,
    );
    const destPath = path.join(cursorDir, t.dest);

    if (!fs.existsSync(srcPath)) {
      if (opts?.verbose) {
        console.log(`  cursor template not found, skipping: ${t.src}`);
      }
      continue;
    }
    if (fs.existsSync(destPath)) {
      if (opts?.verbose) {
        console.log(`  ${t.dest} exists, preserving operator content`);
      }
      continue;
    }
    if (opts?.dryRun) {
      console.log(`[dry-run] Would deploy cursor template ${t.src} -> .cursor/${t.dest}`);
      continue;
    }
    fs.copyFileSync(srcPath, destPath);
    if (opts?.verbose) {
      console.log(`deployed cursor template: .cursor/${t.dest}`);
    }
  }
}

// ============================================================================
// Post-Deployment
// ============================================================================

export async function postDeploy(targetDir, opts) {
  initializeFrameworkWorkspace(targetDir, opts.mode, opts.dryRun, opts.srcRoot);
  await deployCursorPromptDiscovery(targetDir, opts);

  if (opts.createAgentsMd) {
    if (opts.contextFiles !== false) createAgentsMd(targetDir, opts.srcRoot, opts.dryRun);
  }

  // PUW-019 (#1120): wire environment.json + worktrees.json templates.
  try {
    deployCursorConfigTemplates(targetDir, opts.srcRoot, opts);
  } catch (err) {
    console.warn(
      `Warning: cursor template deploy failed: ${err && err.message ? err.message : err}`,
    );
  }
}

// ============================================================================
// File Extension
// ============================================================================

export function getFileExtension(type) {
  // Rules use .mdc for native Cursor support, everything else uses .md
  if (type === 'rule' || type === 'rules') {
    return '.mdc';
  }
  return '.md';
}

// ============================================================================
// Main Deploy Function
// ============================================================================

/**
 * Main deployment function for Cursor provider
 * Orchestrates deployment of agents, commands, skills, and rules
 */
export async function deploy(opts) {
  return withRuleDeployment(opts, { name, paths, kernelSkillsPath, transformRule }, deploySelected);
}

async function deploySelected(opts) {
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
    createAgentsMd: shouldCreateAgentsMd
  } = opts;

  console.log(`\n=== Cursor IDE Provider ===`);
  console.log(`Target: ${target}`);
  console.log(`Mode: ${mode}`);

  // Collect source files based on mode
  const agentFiles = [];
  const commandFiles = [];
  const skillDirs = [];
  const ruleFiles = [];

  // Check for addon-style directory structure (direct agents/, commands/, skills/ subdirs)
  // This handles deployment when --source points to an addon directory
  const isAddonSource = fs.existsSync(path.join(srcRoot, 'agents')) ||
                        fs.existsSync(path.join(srcRoot, 'commands')) ||
                        fs.existsSync(path.join(srcRoot, 'skills'));

  if (isAddonSource) {
    // Deploy from addon-style directory structure
    const addonAgentsDir = path.join(srcRoot, 'agents');
    if (fs.existsSync(addonAgentsDir)) {
      agentFiles.push(...listMdFiles(addonAgentsDir));
    }

    if (shouldDeployCommands || commandsOnly) {
      const addonCommandsDir = path.join(srcRoot, 'commands');
      if (fs.existsSync(addonCommandsDir)) {
        commandFiles.push(...listMdFiles(addonCommandsDir));
      }
    }

    if (shouldDeploySkills || skillsOnly) {
      const addonSkillsDir = path.join(srcRoot, 'skills');
      if (fs.existsSync(addonSkillsDir)) {
        skillDirs.push(...listSkillDirs(addonSkillsDir));
    
    // Holistic post-deploy cleanup of stale AIWG-managed kernel
    // skills (renamed/removed sources). Uses the global kernel set
    // (computeAllKernelNames walks all source frameworks/addons),
    // not just this-call's skillDirs, because aiwg use invokes
    // deploy-agents.mjs multiple times.
    {
      const _kernelDestDir = path.isAbsolute(kernelSkillsPath)
        ? kernelSkillsPath
        : path.join(target, kernelSkillsPath);
      pruneStaleAiwgSkills(_kernelDestDir, computeAllKernelNames(srcRoot), opts);
    }
  }
    }

    if (shouldDeployRules || rulesOnly) {
      const addonRulesDir = path.join(srcRoot, 'rules');
      if (fs.existsSync(addonRulesDir)) {
        ruleFiles.push(...listMdFiles(addonRulesDir));
      }
    }
  }

  // All addons (dynamically discovered)
  const normalizedMode = normalizeDeploymentMode(mode);
  if (normalizedMode === 'general' || normalizedMode === 'sdlc' || normalizedMode === 'both' || normalizedMode === 'all') {
    agentFiles.push(...getAddonAgentFiles(srcRoot));

    if (shouldDeployCommands || commandsOnly) {
      commandFiles.push(...getAddonCommandFiles(srcRoot));
    }

    if (shouldDeploySkills || skillsOnly) {
      skillDirs.push(...getAddonSkillDirs(srcRoot));
    }

    if (shouldDeployRules || rulesOnly) {
      ruleFiles.push(...getAddonRuleFiles(srcRoot));
    }
  }

  const frameworkArtifacts = collectFrameworkArtifacts(srcRoot, normalizedMode, {
    includeAgents: true,
    includeCommands: shouldDeployCommands || commandsOnly,
    includeSkills: shouldDeploySkills || skillsOnly,
    includeRules: shouldDeployRules || rulesOnly,
    recursiveCommands: true,
    consolidatedSdlcRules: true
  });
  agentFiles.push(...frameworkArtifacts.agents);
  const soulFiles = [...(frameworkArtifacts.souls || [])];
  commandFiles.push(...frameworkArtifacts.commands);
  skillDirs.push(...frameworkArtifacts.skills);
  ruleFiles.push(...frameworkArtifacts.rules);

  // Deploy based on flags
  if (!commandsOnly && !skillsOnly && !rulesOnly) {
    // Apply filters if specified
    const filteredAgents = filterAgentFiles(agentFiles, opts);
    if (opts.filter || opts.filterRole) {
      console.log(`\nFiltered from ${agentFiles.length} to ${filteredAgents.length} agents`);
    }
    console.log(`\nDeploying ${filteredAgents.length} agents...`);
    deployAgents(filteredAgents, target, opts);

    // Deploy soul companion files alongside agents
    if (soulFiles.length > 0) {
      const destDir = path.join(target, paths.agents);
      console.log(`\nDeploying ${soulFiles.length} soul files...`);
      deploySoulCompanions(soulFiles, destDir, opts);
    }
  }

  // Filter commands that collide with skills (skills take precedence)
  const filteredCommands = (shouldDeploySkills || skillsOnly)
    ? filterCommandsAgainstSkills(commandFiles, skillDirs)
    : commandFiles;

  if (shouldDeployCommands || commandsOnly) {
    console.log(`\nDeploying ${filteredCommands.length} commands...`);
    deployCommands(filteredCommands, target, opts);
  }

  if (shouldDeploySkills || skillsOnly) {
    console.log(`\nDeploying ${skillDirs.length} skills...`);
    deploySkills(skillDirs, target, opts);
  }

  if (shouldDeployRules || rulesOnly) {
    console.log(`\nDeploying ${ruleFiles.length} rules...`);
    // Use inline deployment (external script relied on commands/ dirs which are now skills)
    deployRulesInline(ruleFiles, target, opts);

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

  console.log('\n=== Cursor deployment complete ===\n');
}

// ============================================================================
// Default Export
// ============================================================================

// ============================================================================
// Plugin Bundle Generation (Cursor)
// ============================================================================

/**
 * Generate a `.cursor-plugin/plugin.json` manifest for distributing AIWG as a
 * Cursor plugin. Cursor's cursor.com/marketplace is centralized and partner-
 * oriented; this manifest enables manual/local installation and future
 * submission if the marketplace opens third-party submissions.
 *
 * Layout produced:
 *   <targetDir>/.cursor-plugin/plugin.json  — the plugin manifest
 *
 * @param {string} targetDir - Plugin bundle root (typically agentic/code/plugins/<name>/)
 * @param {{ dryRun?: boolean, srcRoot?: string, name?: string, version?: string, description?: string, contents?: object }} opts
 */
export function generatePluginBundle(targetDir, opts = {}) {
  const {
    dryRun = false,
    srcRoot = process.cwd(),
    name: pluginName = 'aiwg-plugin',
    version: overrideVersion,
    description = 'AIWG plugin for Cursor',
    contents = {
      agents: 'agents/',
      commands: 'commands/',
      skills: 'skills/',
      rules: 'rules/',
    },
  } = opts;

  // Resolve version: opts.version > package.json > 'unknown'
  let version = overrideVersion;
  if (!version) {
    try {
      const pkgPath = path.join(srcRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        version = pkg.version || 'unknown';
      } else {
        version = 'unknown';
      }
    } catch {
      version = 'unknown';
    }
  }

  const pluginDir = path.join(targetDir, '.cursor-plugin');
  const manifest = {
    name: pluginName,
    version,
    displayName: pluginName.replace(/^aiwg-/, 'AIWG ').replace(/-/g, ' '),
    description,
    publisher: 'aiwg',
    homepage: 'https://aiwg.io',
    repository: 'https://github.com/jmagly/aiwg',
    license: 'MIT',
    contents,
  };

  if (dryRun) {
    console.log(`[dry-run] Would create ${pluginDir}/plugin.json`);
    return { pluginDir, manifest };
  }

  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8'
  );

  console.log(`Generated Cursor plugin manifest: ${pluginDir}/plugin.json`);
  return { pluginDir, manifest };
}

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
  createAgentsMd,
  postDeploy,
  getFileExtension,
  generatePluginBundle,
  deploy
};
