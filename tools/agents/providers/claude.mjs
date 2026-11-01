import { removeSkillCopy } from './skill-copy-prune.mjs';
import { withModelWrapper } from './model-wrapper.mjs';
import { postDeploy } from './claude-post-deploy.mjs';
export { postDeploy };
import { importImpl } from '../../_resolve-impl.mjs';
/**
 * Claude Code Provider
 *
 * The default/primary provider for AIWG. Claude Code is the most feature-rich
 * provider with full support for agents, commands, skills, and rules.
 *
 * Deployment paths:
 *   Skills are sequestered under `.claude/.aiwg/skills/` so the
 *   platform's flat-namespace skill-listing budget doesn't truncate
 *   them. Discovery is index-driven (epic #1212). The kernel of
 *   always-loaded skills deploys to `.claude/skills/` so Claude Code's
 *   native loader picks them up. Agents, commands, and rules continue
 *   to deploy to their platform-native paths.
 *
 *   - Agents:        .claude/agents/         (platform-native)
 *   - Commands:      .claude/commands/       (platform-native)
 *   - AIWG skills:   .claude/.aiwg/skills/   (index-driven discovery)
 *   - Kernel skills: .claude/skills/         (platform-native, always-loaded)
 *   - Rules:         .claude/rules/          (platform-native)
 *   - Hooks/settings: .claude/               (platform-native)
 */
import realFs from 'fs';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
let fs;
try { const gfs = _require('graceful-fs'); gfs.gracefulify(realFs); fs = realFs; } catch { fs = realFs; }
import path from 'path';
import { tmpdir } from 'os';
import { classifyModelRole, modelForRole } from './model-role.mjs';
import {
  withRuleDeployment,
  ensureDir,
  listMdFiles,
  listMdFilesRecursive,
  listSkillDirs,
  writeFile,
  deployFiles,
  deploySkillDir,
  deploySkillsWithKernelRouting,
  isKernelSkill,
  pruneStaleAiwgSkills,
  computeAllKernelNames,
  parseFrontmatter,
  filterAgentFiles,
  getAddonAgentFiles,
  getAddonCommandFiles,
  getAddonSkillDirs,
  getAddonRuleFiles,
  listOnDemandRuleFiles,
  writeOnDemandRuleIndex,
  reconcileInlineRuleBudget,
  assembleRulesIndex,
  normalizeDeploymentMode,
  collectFrameworkArtifacts,
  cleanupOldRuleFiles,
  filterCommandsAgainstSkills,
  deploySoulCompanions,
  buildRemotesTopologyBlock,
  interpolateContextTokens
} from './base.mjs';
import { writeContextFileSync } from './context-write.mjs';
// ============================================================================
// Provider Configuration
// ============================================================================
export const name = 'claude';
export const aliases = [];

export const paths = {
  agents: '.claude/agents/',
  commands: '.claude/commands/',
  // Skills are hidden under `.claude/.aiwg/skills/` so the platform's
  // flat-namespace skill-listing budget doesn't truncate them.
  // Discovery is index-driven (#1212). The kernel set deploys to
  // `kernelSkills` separately so Claude Code natively loads it.
  skills: '.claude/.aiwg/skills/',
  rules: '.claude/rules/',
};

// Kernel skills path: always-loaded set the platform sees natively.
// The rest of AIWG's skills sit at `paths.skills` and are reached
// through the artifact index (epic #1212).
export const kernelSkillsPath = '.claude/skills/';

export const support = {
  agents: 'native',
  commands: 'native',
  skills: 'native',
  rules: 'native'
};

export const capabilities = {
  skills: true,
  rules: true,
  aggregatedOutput: false,
  yamlFormat: false,
  mdcFormat: false,
  homeDirectoryDeploy: false,
  projectLocalMirror: false
};

// ============================================================================
// Model Handling
// ============================================================================

/**
 * Replace model in frontmatter based on role classification
 * opus -> reasoning, sonnet -> coding, haiku -> efficiency
 */
export function replaceModelFrontmatter(content, models) {
  const fmStart = content.indexOf('---');
  if (fmStart !== 0) return content;
  const fmEnd = content.indexOf('\n---', 3);
  if (fmEnd === -1) return content;

  const header = content.slice(0, fmEnd + 4);
  const body = content.slice(fmEnd + 4);

  const modelMatch = header.match(/^model:\s*([^\n]+)$/m);
  let newModel = null;

  if (modelMatch) {
    const orig = modelMatch[1].trim();
    const role = classifyModelRole(orig);

    if (role === 'reasoning') newModel = models.reasoning;
    else if (role === 'efficiency') newModel = models.efficiency;
    else if (role === 'coding') newModel = models.coding;
  }

  if (!newModel) return content;
  const updatedHeader = header.replace(/^model:\s*[^\n]+$/m, `model: ${newModel}`);
  return updatedHeader + body;
}

/**
 * Map model shorthand to Claude format
 * For Claude, we keep opus/sonnet/haiku unless overridden
 */
export function mapModel(shorthand, modelCfg, modelsConfig) {
  // If overrides specified, use them
  if (modelCfg.reasoningModel || modelCfg.codingModel || modelCfg.efficiencyModel) {
    return modelForRole(shorthand, {
      reasoning: modelCfg.reasoningModel || 'opus',
      coding: modelCfg.codingModel || 'sonnet',
      efficiency: modelCfg.efficiencyModel || 'haiku',
    }, { defaultRole: 'coding' }) ?? shorthand;
  }

  // No transformation needed for Claude - keep shorthand
  return shorthand || 'sonnet';
}

// ============================================================================
// Content Transformation
// ============================================================================

/**
 * Transform agent content for Claude
 * Claude is the native format - minimal transformation needed
 */
export const transformAgent = withModelWrapper('claude', translateAgent);
function translateAgent(srcPath, content, opts) {
  const { reasoningModel, codingModel, efficiencyModel } = opts;

  // Explicit overrides re-map every classified model, pinned or not.
  if (reasoningModel || codingModel || efficiencyModel) {
    const models = {
      reasoning: reasoningModel || 'opus',
      coding: codingModel || 'sonnet',
      efficiency: efficiencyModel || 'haiku'
    };
    return replaceModelFrontmatter(content, models);
  }

  // Default compilation (#2563): a bare alias in source frontmatter is
  // provider-neutral intent, not a deployable pin. Deployed Claude agents get
  // the pinned variant from the models.json `claude` tiers so subagent
  // dispatch never inherits a 1M-context parent (#1442). Already-pinned
  // values, `inherit`, and explicit `[1m]` opt-ins are left untouched.
  const tiers = opts.modelsConfig?.claude;
  if (!tiers) return content;
  return pinBareModelAlias(content, {
    reasoning: tiers.reasoning?.model,
    coding: tiers.coding?.model,
    efficiency: tiers.efficiency?.model,
  });
}

const BARE_MODEL_ALIAS_ROLE = { opus: 'reasoning', sonnet: 'coding', haiku: 'efficiency' };

/**
 * Replace a bare `model: opus|sonnet|haiku` frontmatter alias with the pinned
 * variant for its role. Anything else (pinned ids, `inherit`, `sonnet[1m]`,
 * placeholders) is returned unchanged.
 */
export function pinBareModelAlias(content, pinned) {
  if (!content.startsWith('---')) return content;
  const fmEnd = content.indexOf('\n---', 3);
  if (fmEnd === -1) return content;
  const header = content.slice(0, fmEnd + 4);
  const body = content.slice(fmEnd + 4);
  const match = header.match(/^model:[ \t]*['"]?([A-Za-z]+)['"]?[ \t]*$/m);
  if (!match) return content;
  const alias = match[1].toLowerCase();
  const role = BARE_MODEL_ALIAS_ROLE[alias];
  const target = role ? pinned?.[role] : null;
  if (!target || target === alias) return content;
  return header.replace(match[0], `model: ${target}`) + body;
}

/**
 * Transform command content for Claude
 * Commands use same format as agents - minimal transformation
 */
export function transformCommand(srcPath, content, opts) {
  return transformAgent(srcPath, content, opts);
}

// ============================================================================
// Legacy Skill Cleanup
// ============================================================================

/**
 * Claude built-in command names that must never be used as bare skill slugs.
 * Mirrors the list in src/smiths/skillsmith/collision-detector.ts.
 */
const CLAUDE_BUILTINS = new Set([
  'help', 'clear', 'compact', 'review', 'init', 'doctor',
  'memory', 'settings', 'logout', 'login', 'mcp', 'migrate',
]);

/**
 * After deploying skills, remove stale bare-named skills that collide with
 * Claude built-ins, provided all three conditions hold:
 *   1. The skill directory is owned by the aiwg namespace (namespace: aiwg in SKILL.md)
 *   2. The skill name is in the CLAUDE_BUILTINS set
 *   3. A namespaced replacement (aiwg-{name}) already exists in the same directory
 *
 * This implements the "+1 release" auto-cleanup milestone from the skill namespace
 * migration guide (docs/migration/skill-namespace-migration.md).
 */
function cleanupLegacyBuiltinCollisions(destDir, opts) {
  if (opts.dryRun || !fs.existsSync(destDir)) return;

  let entries;
  try { entries = fs.readdirSync(destDir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!CLAUDE_BUILTINS.has(name)) continue;

    const skillPath = path.join(destDir, name);
    const namespacedPath = path.join(destDir, `aiwg-${name}`);
    const skillMd = path.join(skillPath, 'SKILL.md');

    // Only remove when the namespaced replacement has already been deployed
    if (!fs.existsSync(skillMd) || !fs.existsSync(namespacedPath)) continue;

    let content = '';
    try { content = fs.readFileSync(skillMd, 'utf8'); } catch { continue; }
    // Guard: only remove if the skill is owned by the aiwg namespace
    if (!/^namespace:\s*aiwg\s*$/m.test(content)) continue;

    try {
      if (!removeSkillCopy(skillPath, opts)) continue;
      if (opts.verbose) console.log(`removed legacy skill: ${name} (superseded by aiwg-${name})`);
    } catch { /* non-fatal */ }
  }
}

// ============================================================================
// Deployment Functions
// ============================================================================

/**
 * Deploy agents to .claude/agents/
 */
export function deployAgents(agentFiles, targetDir, opts) {
  const destDir = path.join(targetDir, paths.agents);
  ensureDir(destDir, opts.dryRun);
  return deployFiles(agentFiles, destDir, { ...opts, injectPlatform: true }, transformAgent);
}

/**
 * Deploy commands to .claude/commands/
 */
export function deployCommands(commandFiles, targetDir, opts) {
  const destDir = path.join(targetDir, paths.commands);
  ensureDir(destDir, opts.dryRun);
  return deployFiles(commandFiles, destDir, opts, transformCommand);
}

/**
 * Deploy skills.
 *
 * Skills are directories containing SKILL.md and supporting files. Two
 * deploy targets per epic #1212:
 *
 *  - **Kernel skills** (frontmatter `kernel: true`) → `.claude/skills/`
 *    (platform-native, always-loaded). These are the always-on
 *    quickref / utility skills that frame the agent's interaction with
 *    the rest of AIWG. Kept small (~10-15 entries) to fit within the
 *    platform's flat-namespace skill-listing budget.
 *
 *  - **Standard skills** → `.claude/.aiwg/skills/`. The bulk of AIWG's
 *    skills, hidden from the platform's flat listing and discoverable
 *    via the artifact index.
 */
export function deploySkills(skillDirs, targetDir, opts) {
  const standardDestDir = path.join(targetDir, paths.skills);
  const kernelDestDir = path.join(targetDir, kernelSkillsPath);
  // copyStandardSkills resolution: opts.copyStandardSkills (set by
  // `--copy-all` CLI flag, #1219). Default (#1217) is no-copy +
  // index-driven discovery. The deploySkillsWithKernelRouting helper
  // does the actual partition + cleanup.
  // does the same priority resolution centrally.
  deploySkillsWithKernelRouting(skillDirs, standardDestDir, kernelDestDir, {
    ...opts,
    transformSkillMd: transformSkillModelPolicy,
  });
  // Remove legacy bare-named skills superseded by their aiwg- prefixed replacements
  cleanupLegacyBuiltinCollisions(standardDestDir, opts);
}

function resolveSkillModelPolicy(commandHint = {}) {
  const legacy = String(commandHint.model || '').trim().toLowerCase();
  const legacyRole = legacy === 'opus' ? 'reasoning'
    : legacy === 'haiku' ? 'efficiency'
      : legacy ? 'coding' : null;
  const role = commandHint.modelRole || legacyRole;
  if (!role) return null;
  return {
    model: role === 'reasoning' ? 'opus' : role === 'efficiency' ? 'haiku' : 'sonnet',
    effort: commandHint.modelEffort,
  };
}

/** Compile portable commandHint policy to Claude's native skill fields. */
export function transformSkillModelPolicy(content) {
  const { frontmatter: rawFrontmatter } = parseFrontmatter(content);
  if (!rawFrontmatter) return content;
  const hintBlock = rawFrontmatter.match(/^commandHint:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1] || '';
  const commandHint = {};
  for (const line of hintBlock.split('\n')) {
    const match = line.trim().match(/^(model|modelRole|modelTier|modelEffort):\s*(.+)$/);
    if (match) commandHint[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  const policy = resolveSkillModelPolicy(commandHint);
  if (!policy) return content;
  const match = content.match(/^([\s\S]*?---\n)([\s\S]*?)(\n---\n[\s\S]*)$/);
  if (!match) return content;
  let frontmatter = match[2]
    .replace(/^model:\s*.*\n?/m, '')
    .replace(/^effort:\s*.*\n?/m, '');
  frontmatter += `\nmodel: ${policy.model}`;
  if (policy.effort) {
    const effort = policy.effort === 'medium' ? 2
      : policy.effort === 'high' || policy.effort === 'xhigh' ? 3 : 1;
    frontmatter += `\neffort: ${effort}`;
  }
  return `${match[1]}${frontmatter}${match[3]}`;
}

/**
 * Deploy rules to .claude/rules/
 * Deploys consolidated RULES-INDEX.md instead of individual rule files.
 * Cleans up old individual rule files from previous deployments.
 */
export function deployRules(ruleFiles, targetDir, opts) {
  const destDir = path.join(targetDir, paths.rules);
  ensureDir(destDir, opts.dryRun);
  // Pass incomingFiles so addon deploys with 0 rules don't wipe the main
  // framework's rules (#1143 mitigation; also fixes #1117 PUW-016).
  cleanupOldRuleFiles(destDir, { ...opts, incomingFiles: ruleFiles });
  return deployFiles(ruleFiles, destDir, opts, transformCommand);
}

// ============================================================================
// AGENTS.md (Not typically used for Claude, but supported)
// ============================================================================

export function createAgentsMd(target, srcRoot, dryRun) {
  // Claude Code doesn't typically use AGENTS.md since it has native agent support
  // But we can create one for documentation purposes if needed
  console.log('Claude Code uses native .claude/agents/ - AGENTS.md not required');
}

// ============================================================================
// Post-Deployment
// ============================================================================


/**
 * Deploy the AIWG.md hook file and add @AIWG.md directive to CLAUDE.md.
 * Hook file approach: AIWG content lives in AIWG.md; CLAUDE.md stays minimal
 * with a single @AIWG.md directive that Claude Code loads at session start.
 * Falls back gracefully if template is missing (older installs).
 */
/**
 * Substitute {{TOKEN}} placeholders in hook file content with deployment counts
 * and the resolved remotes topology (#998).
 *
 * Delegates to the shared interpolateContextTokens helper in base.mjs so the
 * Claude hook file and the AGENTS.md template path render the same tokens.
 */
function interpolateHookTokens(content, counts, targetDir) {
  return interpolateContextTokens(content, {
    counts,
    topology: targetDir ? buildRemotesTopologyBlock(targetDir) : '',
  });
}

export function deployHookFile(targetDir, opts) {
  const { srcRoot, dryRun, counts } = opts;
  const templatePath = path.join(srcRoot, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'templates', 'project', 'AIWG.md');
  const hookDest = path.join(targetDir, 'AIWG.md');
  const claudeDest = path.join(targetDir, 'CLAUDE.md');
  const directive = '@AIWG.md';

  if (!fs.existsSync(templatePath)) return;

  // Build effective counts: use current-run counts where > 0, otherwise read the
  // actual deployed count from the filesystem. This prevents a partial deploy
  // (e.g. agents-only, no --skills flag) from resetting skill/command counts to
  // "0" in the generated AIWG.md.
  const effectiveCounts = { ...counts };
  function countMdFiles(dir) {
    try { return fs.readdirSync(dir).filter(f => f.endsWith('.md')).length; } catch { return 0; }
  }
  function countDirs(dir) {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).length; } catch { return 0; }
  }
  if (!effectiveCounts.agents) effectiveCounts.agents = countMdFiles(path.join(targetDir, '.claude', 'agents'));
  if (!effectiveCounts.skills) effectiveCounts.skills = countDirs(path.join(targetDir, '.claude', 'skills'));
  if (!effectiveCounts.commands) effectiveCounts.commands = countMdFiles(path.join(targetDir, '.claude', 'commands'));
  if (!effectiveCounts.rules)   effectiveCounts.rules   = countMdFiles(path.join(targetDir, '.claude', 'rules'));

  // Write AIWG.md (always overwrite — it's generated content)
  if (dryRun) {
    console.log('[dry-run] Would write AIWG.md from template');
  } else {
    let content = fs.readFileSync(templatePath, 'utf8');
    content = interpolateHookTokens(content, effectiveCounts, targetDir);
    writeContextFileSync(hookDest, content, 'utf8');
    console.log('Created AIWG.md (hook file)');
  }

  // Add @AIWG.md directive to CLAUDE.md if present but missing the directive
  if (fs.existsSync(claudeDest)) {
    const existing = fs.readFileSync(claudeDest, 'utf8');
    if (!existing.includes(directive)) {
      if (dryRun) {
        console.log('[dry-run] Would add @AIWG.md directive to CLAUDE.md');
      } else {
        // Insert directive after the first heading or at end of first paragraph
        const lines = existing.split('\n');
        let insertAt = lines.length;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#')) {
            // Insert after the first heading block (skip blank lines after heading)
            let j = i + 1;
            while (j < lines.length && lines[j].trim() === '') j++;
            insertAt = j;
            break;
          }
        }
        lines.splice(insertAt, 0, '', directive, '');
        writeContextFileSync(claudeDest, lines.join('\n'), 'utf8');
        console.log('Added @AIWG.md directive to CLAUDE.md');
      }
    }
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
 * Main deployment function for Claude provider
 * Orchestrates deployment of agents, commands, skills, and rules
 */
export async function deploy(opts) {
  return withRuleDeployment(opts, { name, paths, kernelSkillsPath }, deploySelected);
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
    dryRun
  } = opts;

  const verbose = opts.verbose || false;

  if (verbose) {
    console.log(`\n=== Claude Code Provider ===`);
    console.log(`Target: ${target}`);
    console.log(`Mode: ${mode}`);
  }

  // Collect source files based on mode
  const agentFiles = [];
  const commandFiles = [];
  const skillDirs = [];
  let ruleFiles = [];

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
      }
    }

    if (shouldDeployRules || rulesOnly) {
      const addonRulesDir = path.join(srcRoot, 'rules');
      if (fs.existsSync(addonRulesDir)) {
        ruleFiles.push(...listMdFiles(addonRulesDir));
      }
    }
  }

  const normalizedMode = normalizeDeploymentMode(mode);

  // All addons (dynamically discovered)
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

  // Deploy based on flags — track counts for summary
  const counts = { agents: 0, commands: 0, skills: 0, rules: 0, souls: 0 };

  if (!commandsOnly && !skillsOnly && !rulesOnly) {
    // Apply filters if specified
    const filteredAgents = filterAgentFiles(agentFiles, opts);
    if (verbose && (opts.filter || opts.filterRole)) {
      console.log(`\nFiltered from ${agentFiles.length} to ${filteredAgents.length} agents`);
    }
    if (verbose) console.log(`\nDeploying ${filteredAgents.length} agents...`);
    deployAgents(filteredAgents, target, opts);
    counts.agents = filteredAgents.length;

    // Deploy soul companion files alongside agents
    if (soulFiles.length > 0) {
      const destDir = path.join(target, paths.agents);
      if (verbose) console.log(`\nDeploying ${soulFiles.length} soul files...`);
      deploySoulCompanions(soulFiles, destDir, opts);
      counts.souls = soulFiles.length;
    }
  }

  // Filter commands that collide with skills (skills take precedence)
  const filteredCommands = (shouldDeploySkills || skillsOnly)
    ? filterCommandsAgainstSkills(commandFiles, skillDirs)
    : commandFiles;

  if (shouldDeployCommands || commandsOnly) {
    if (verbose) console.log(`\nDeploying ${filteredCommands.length} commands...`);
    deployCommands(filteredCommands, target, opts);
    counts.commands = filteredCommands.length;
  }

  if (shouldDeploySkills || skillsOnly) {
    if (verbose) console.log(`\nDeploying ${skillDirs.length} skills...`);
    deploySkills(skillDirs, target, opts);
    counts.skills = skillDirs.length;

    // Holistic cleanup of stale AIWG-managed kernel skills (renamed or
    // removed sources). Builds the desired-kernel set by walking the
    // ENTIRE source tree, not just this-call's skillDirs, because
    // `deploy-agents.mjs` is invoked multiple times by `aiwg use`
    // (once per framework + once per addon batch). Per-call cleanup
    // would prune kernel skills owned by a sibling call.
    const kernelDestDir = path.join(target, kernelSkillsPath);
    pruneStaleAiwgSkills(kernelDestDir, computeAllKernelNames(srcRoot), opts);
  }

  if (shouldDeployRules || rulesOnly) {
    // Try assembled rules index (combines all component indexes)
    const assembled = assembleRulesIndex(srcRoot);
    if (assembled) {
      // Write assembled index to a unique temp dir to avoid races when
      // multiple deployments run concurrently (e.g., parallel test workers)
      const tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'aiwg-rules-assembly-'));
      const assembledPath = path.join(tmpDir, 'RULES-INDEX.md');
      fs.writeFileSync(assembledPath, assembled);

      // Replace the sdlc RULES-INDEX.md with the assembled one;
      // keep any non-RULES-INDEX files (non-consolidated addon rules)
      const finalRuleFiles = [
        assembledPath,
        ...ruleFiles.filter(f => path.basename(f) !== 'RULES-INDEX.md')
      ];

      if (verbose) console.log(`\nDeploying assembled RULES-INDEX.md + ${finalRuleFiles.length - 1} additional rule files...`);
      deployRules(finalRuleFiles, target, opts);
      counts.rules = finalRuleFiles.length;

      // Cleanup temp directory
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    } else {
      // Fallback: deploy individual files
      if (verbose) console.log(`\nDeploying ${ruleFiles.length} rules...`);
      deployRules(ruleFiles, target, opts);
      counts.rules = ruleFiles.length;
    }

    // On-demand index (#1673): list the MEDIUM/LOW rules that were tier-gated
    // out of the always-on set so agents can fetch them via `aiwg show rule`.
    const rulesDestDir = path.join(target, paths.rules);
    reconcileInlineRuleBudget(rulesDestDir, undefined, opts);
    const onDemandCount = writeOnDemandRuleIndex(rulesDestDir, listOnDemandRuleFiles(srcRoot), opts);
    if (verbose && onDemandCount > 0) {
      console.log(`  On-demand rules (not inlined): ${onDemandCount} → RULES-ONDEMAND.md`);
    }
  }

  // Post-deployment (pass counts for hook file token substitution)
  await postDeploy(target, { ...opts, counts });

  if (verbose) {
    console.log('\n=== Claude deployment complete ===\n');
  } else {
    // Clean summary output
    const parts = [];
    if (counts.agents > 0) parts.push(`${counts.agents} agents`);
    if (counts.souls > 0) parts.push(`${counts.souls} souls`);
    if (counts.commands > 0) parts.push(`${counts.commands} commands`);
    if (counts.skills > 0) parts.push(`${counts.skills} skills`);
    if (counts.rules > 0) parts.push(`${counts.rules} rules`);
    if (parts.length > 0) {
      console.log(`  Deployed: ${parts.join('  ')}`);
    }
  }
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
  pinBareModelAlias,
  deployAgents,
  deployCommands,
  deploySkills,
  deployRules,
  createAgentsMd,
  postDeploy,
  getFileExtension,
  deploy
};
