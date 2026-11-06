import { withModelWrapper } from './model-wrapper.mjs';
/**
 * Factory AI Provider
 *
 * Deploys agents as "droids" in Factory AI format. Factory uses a different
 * frontmatter structure with kebab-case names and mapped tools.
 *
 * Deployment paths:
 *   - Agents: .factory/droids/
 *   - Commands: .factory/commands/
 *   - Skills: .factory/skills/
 *   - Rules: .factory/rules/
 *
 * Special features:
 *   - Transforms agent names to kebab-case
 *   - Maps Claude tools to Factory equivalents
 *   - Enables custom droids in ~/.factory/settings.json
 *   - Creates/updates AGENTS.md from template
 */
import realFs from 'fs';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const staticModelCatalog = _require('../../../agentic/code/providers/model-catalog.v1.json');
let fs;
try { const gfs = _require('graceful-fs'); gfs.gracefulify(realFs); fs = realFs; } catch { fs = realFs; }
import path from 'path';
import {
  withRuleDeployment,
  ensureDir,
  listMdFiles,
  listMdFilesRecursive,
  writeFile,
  deployFiles,
  toKebabCase,
  stripJsonComments,
  createAgentsMdFromTemplate,
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
  loadRuntimeModelCatalog,
  filterCommandsAgainstSkills,
  deploySoulCompanions
} from './base.mjs';
const modelCatalog = loadRuntimeModelCatalog(staticModelCatalog);
// ============================================================================
// Provider Configuration
// ============================================================================
export const name = 'factory';
export const aliases = [];
export const paths = {
  agents: '.factory/droids/',
  commands: '.factory/commands/',
  // Skills sequestered under .factory/.aiwg/skills/ — index-driven discovery (#1212).
  skills: '.factory/.aiwg/skills/',
  rules: '.factory/rules/'
};

// Kernel skills (always-loaded) deploy to the platform-native dir.
export const kernelSkillsPath = '.factory/skills/';

export const support = {
  agents: 'native',
  commands: 'native',
  skills: 'native',
  rules: 'conventional'
};

export const capabilities = {
  skills: true,
  rules: true,
  aggregatedOutput: false,
  yamlFormat: false
};

// ============================================================================
// Tool Mapping
// ============================================================================

/**
 * Map Claude Code tools to Factory AI equivalents
 */
export function mapToolsToFactory(toolsString, agentName) {
  // Default comprehensive tool set if no tools specified
  if (!toolsString) {
    return ["Read", "LS", "Grep", "Glob", "Edit", "Create", "Execute", "Task", "TodoWrite", "WebSearch", "FetchUrl"];
  }

  // Parse tools (comma-separated or array format)
  let originalTools = [];
  if (toolsString.startsWith('[')) {
    try {
      originalTools = JSON.parse(toolsString);
    } catch (e) {
      originalTools = toolsString.replace(/[\[\]"']/g, '').split(/[,\s]+/).filter(Boolean);
    }
  } else {
    originalTools = toolsString.split(/[,\s]+/).filter(Boolean);
  }

  // Tool mapping: Claude Code → Factory
  const toolMap = {
    'Bash': 'Execute',
    'Write': 'Create',  // Will add Edit too
    'WebFetch': 'FetchUrl',
    'Read': 'Read',
    'Grep': 'Grep',
    'Glob': 'Glob',
    'LS': 'LS'
  };

  const factoryTools = new Set();

  // Map original tools
  for (const tool of originalTools) {
    // MultiEdit maps to Edit + ApplyPatch in Factory
    if (tool === 'MultiEdit') {
      factoryTools.add('Edit');
      factoryTools.add('ApplyPatch');
      continue;
    }

    const mapped = toolMap[tool] || tool;
    factoryTools.add(mapped);

    // If Write is present, add both Create and Edit
    if (tool === 'Write') {
      factoryTools.add('Create');
      factoryTools.add('Edit');
    }
  }

  // Orchestration agents need Task tool for invoking subagents
  const orchestrationAgents = [
    'executive-orchestrator',
    'intake-coordinator',
    'documentation-synthesizer',
    'project-manager',
    'deployment-manager',
    'test-architect',
    'architecture-designer',
    'requirements-analyst',
    'security-architect',
    'technical-writer'
  ];

  const normalizedName = (agentName || '').toLowerCase().replace(/\s+/g, '-');
  if (orchestrationAgents.some(oa => normalizedName.includes(oa))) {
    factoryTools.add('Task');
    factoryTools.add('TodoWrite');
  }

  // Add web tools if WebFetch was present
  if (originalTools.includes('WebFetch')) {
    factoryTools.add('FetchUrl');
    factoryTools.add('WebSearch');
  }

  // Convert to sorted array for consistency
  return Array.from(factoryTools).sort();
}

// ============================================================================
// Model Mapping
// ============================================================================

// Default Factory models (fallback if config not loaded)
const DEFAULT_FACTORY_MODELS = {
  reasoning: modelCatalog.providers.factory.roles.reasoning.id,
  coding: modelCatalog.providers.factory.roles.coding.id,
  efficiency: modelCatalog.providers.factory.roles.efficiency.id
};

/**
 * Sonnet-tier agents that need higher reasoningEffort than the default "medium".
 * These are deploy-time overrides — source agent files remain provider-agnostic.
 *
 * Rationale: these roles perform analysis, review, or verification where
 * thoroughness is critical despite running on the cost-efficient sonnet tier.
 */
const REASONING_EFFORT_OVERRIDES = {
  // Review & analysis — must be thorough
  'code-reviewer': 'high',
  'security-auditor': 'high',
  'test-architect': 'high',
  'requirements-reviewer': 'high',
  'api-designer': 'high',
  'regression-analyst': 'high',
  'compliance-checker': 'high',
  'privacy-officer': 'high',
  'reliability-engineer': 'high',
  'migration-planner': 'high',
  'incident-responder': 'high',
  // Grounding agents — verification accuracy is paramount
  'security-grounding-agent': 'high',
  'compliance-grounding-agent': 'high',
  'technology-grounding-agent': 'high',
  'performance-grounding-agent': 'high',
  // Lightweight roles — mechanical, not analytical
  'documentation-archivist': 'low',
};

/**
 * Map model tier to Factory reasoningEffort level.
 *
 * Priority: agent-specific override > agent frontmatter > models.json per-tier > default by model tier.
 * Valid levels: off, low, medium, high.
 */
export function mapReasoningEffort(originalModel, modelsConfig, frontmatterEffort, agentName) {
  // Explicit frontmatter override wins (source-level)
  if (frontmatterEffort && ['off', 'low', 'medium', 'high'].includes(frontmatterEffort)) {
    return frontmatterEffort;
  }

  // Agent-specific deploy-time override (Factory provider policy)
  const normalizedName = (agentName || '').toLowerCase().replace(/\s+/g, '-');
  if (REASONING_EFFORT_OVERRIDES[normalizedName]) {
    return REASONING_EFFORT_OVERRIDES[normalizedName];
  }

  const factoryConfig = modelsConfig?.factory || {};
  const clean = (originalModel || 'sonnet').toLowerCase().replace(/['"]/g, '');

  // Check models.json for per-tier reasoningEffort
  if (/opus/i.test(clean) && factoryConfig.reasoning?.reasoningEffort) {
    return factoryConfig.reasoning.reasoningEffort;
  }
  if (/haiku/i.test(clean) && factoryConfig.efficiency?.reasoningEffort) {
    return factoryConfig.efficiency.reasoningEffort;
  }
  if (factoryConfig.coding?.reasoningEffort) {
    return factoryConfig.coding.reasoningEffort;
  }

  // Default mapping by model tier
  if (/opus/i.test(clean)) return 'high';
  if (/haiku/i.test(clean)) return 'low';
  return 'medium';
}

/**
 * Map model shorthand to Factory AI format
 */
export function mapModel(originalModel, modelCfg, modelsConfig) {
  // Safe access to nested config with fallbacks
  const factoryConfig = modelsConfig?.factory || {};
  const defaultReasoning = factoryConfig.reasoning?.model || DEFAULT_FACTORY_MODELS.reasoning;
  const defaultCoding = factoryConfig.coding?.model || DEFAULT_FACTORY_MODELS.coding;
  const defaultEfficiency = factoryConfig.efficiency?.model || DEFAULT_FACTORY_MODELS.efficiency;

  // Handle override models first
  if (modelCfg?.reasoningModel || modelCfg?.codingModel || modelCfg?.efficiencyModel) {
    const clean = (originalModel || 'sonnet').toLowerCase().replace(/['"]/g, '');
    if (/opus/i.test(clean)) return modelCfg.reasoningModel || defaultReasoning;
    if (/haiku/i.test(clean)) return modelCfg.efficiencyModel || defaultEfficiency;
    return modelCfg.codingModel || defaultCoding;
  }

  // Prefer factory-specific shorthand over shared shorthand
  const factoryModels = modelsConfig?.factory_shorthand || {
    'opus': defaultReasoning,
    'sonnet': defaultCoding,
    'haiku': defaultEfficiency,
    'inherit': 'inherit'
  };

  const clean = (originalModel || 'sonnet').toLowerCase().replace(/['"]/g, '');
  for (const [key, value] of Object.entries(factoryModels)) {
    if (clean.includes(key)) return value;
  }
  if (/opus/i.test(clean)) return defaultReasoning;
  if (/haiku/i.test(clean)) return defaultEfficiency;
  if (/sonnet/i.test(clean)) return defaultCoding;

  return defaultCoding; // default
}

// ============================================================================
// Content Transformation
// ============================================================================

/**
 * Transform AIWG agent to Factory droid format
 */
export const transformAgent = withModelWrapper('factory', translateAgent);
function translateAgent(srcPath, content, opts) {
  const { modelsConfig = {} } = opts;

  // Parse existing frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return content;

  const [, frontmatter, body] = fmMatch;

  // Extract metadata
  const rawName = frontmatter.match(/name:\s*(.+)/)?.[1]?.trim();
  const description = frontmatter.match(/description:\s*(.+)/)?.[1]?.trim();
  const modelMatch = frontmatter.match(/model:\s*(.+)/)?.[1]?.trim();
  const toolsMatch = frontmatter.match(/tools:\s*(.+)/)?.[1]?.trim();
  const effortMatch = frontmatter.match(/reasoningEffort:\s*(.+)/)?.[1]?.trim();

  // Convert name to kebab-case for Factory compatibility
  const name = toKebabCase(rawName);

  // Map model to Factory format
  const factoryModel = mapModel(modelMatch, opts, modelsConfig);

  // Map reasoning effort based on model tier, with agent-specific overrides
  const reasoningEffort = mapReasoningEffort(modelMatch, modelsConfig, effortMatch, name);

  // Map tools to Factory equivalents
  const factoryTools = mapToolsToFactory(toolsMatch, name);

  // Generate Factory droid frontmatter
  const factoryFrontmatter = `---
name: ${name}
description: ${description || 'AIWG SDLC agent'}
model: ${factoryModel}
reasoningEffort: ${reasoningEffort}
tools: ${JSON.stringify(factoryTools)}
---`;

  return `${factoryFrontmatter}\n\n${body.trim()}`;
}

/**
 * Map a skill commandHint.allowedTools string to Factory equivalents.
 *
 * Skill `allowedTools` differs from agent `tools` — it may carry Claude
 * Code's allowlist syntax (e.g. `Bash(git *, gh *)`, `Bash(npm:*)`) where
 * the parentheses contain commas that must NOT be treated as token
 * separators. This tokenizer respects parentheses, then maps each token's
 * identifier head:
 *
 *   Bash(git *, gh *)  →  Execute(git *, gh *)
 *   Bash               →  Execute
 *   Write              →  Create  (Factory pairs Create+Edit but for hint-only
 *                                  use we keep the head unique)
 *   MultiEdit          →  Edit
 *   mcp__gitea__*      →  mcp__gitea__*  (passthrough)
 *
 * Returns a comma-separated string suitable for re-insertion into SKILL.md.
 */
export function mapAllowedToolsString(allowedTools) {
  if (!allowedTools) return '';
  const tokens = [];
  let buf = '';
  let depth = 0;
  for (const ch of allowedTools) {
    if (ch === '(') { depth += 1; buf += ch; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); buf += ch; continue; }
    if (ch === ',' && depth === 0) {
      if (buf.trim()) tokens.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) tokens.push(buf.trim());

  const headMap = {
    Bash: 'Execute',
    Write: 'Create',
    MultiEdit: 'Edit',
    WebFetch: 'FetchUrl'
  };

  const mapped = tokens.map(tok => {
    const m = tok.match(/^([A-Za-z_][\w]*)(.*)$/);
    if (!m) return tok;
    const [, head, rest] = m;
    const newHead = headMap[head] || head;
    return `${newHead}${rest}`;
  });

  // Deduplicate while preserving order
  const seen = new Set();
  const out = [];
  for (const t of mapped) {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out.join(', ');
}

/**
 * Transform SKILL.md frontmatter for Factory.
 *
 * Skills declare optional `commandHint:` metadata describing how the skill
 * should be invoked as a slash command. The hint carries Claude-native tool
 * names and Claude model shorthand, both of which are wrong on Factory:
 *
 *   commandHint:
 *     allowedTools: 'WebSearch, Read, Write, Bash'   ← Bash/Write/MultiEdit
 *     model: sonnet                                  ← bare shorthand
 *
 * This transform rewrites the indented allowedTools and model fields so
 * the deployed SKILL.md is consistent with how agent droids are transformed
 * by transformAgent() — Bash → Execute, Write → Create+Edit, MultiEdit →
 * Edit+ApplyPatch, sonnet → claude-sonnet-4-x, etc.
 *
 * Issue: #1056 (upstream #102)
 */
export function transformSkillFrontmatter(content, opts) {
  const { modelsConfig = {} } = opts || {};

  // Match frontmatter, allowing an optional leading HTML comment.
  const fmMatch = content.match(/^((?:<!--[\s\S]*?-->\s*)?)---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return content;

  const [, prefix, frontmatter, body] = fmMatch;

  // Step 1: filter top-level keys to the Factory-recognized allowlist (#102).
  // Anything else is AIWG-internal metadata or Claude Code-specific and would
  // confuse Factory's skill loader. Block-aware parsing preserves multi-line
  // values like the `commandHint:` map.
  const filtered = filterFactorySkillFrontmatter(frontmatter);

  // Step 2: rewrite the still-Claude-flavored bits inside `commandHint:` —
  // tool name remap and model shorthand → Factory model id.
  let updated = filtered;
  updated = updated.replace(
    /^(\s+allowedTools:\s*)(['"]?)([^\n'"]+)\2/m,
    (_match, lead, quote, raw) => {
      const mapped = mapAllowedToolsString(raw);
      const q = quote || "'";
      return `${lead}${q}${mapped}${q}`;
    }
  );
  updated = updated.replace(
    /^(\s+model:\s*)(['"]?)([^\s\n'"]+)\2/m,
    (_match, lead, quote, raw) => {
      const mapped = mapModel(raw, opts, modelsConfig);
      const q = quote;
      return `${lead}${q}${mapped}${q}`;
    }
  );

  if (updated === frontmatter) return content;
  return `${prefix}---\n${updated}\n---\n${body}`;
}

/**
 * Top-level frontmatter keys Factory recognizes for skills.
 *
 * The list comes from Factory's skill loader contract — anything not in it is
 * either AIWG-internal (`namespace`, `platforms`, `memory`, `category`,
 * `orchestration`, `subagent-optimized`, `version`) or a Claude Code-only
 * concept (`tools`, `model` at the top level — Factory handles those via
 * `commandHint:` for skills).
 *
 * Issue: #102 — Factory provider must strip non-Factory fields, not pass them through.
 */
const FACTORY_SKILL_TOP_LEVEL_KEYS = new Set([
  'name',
  'description',
  'user-invocable',
  'disable-model-invocation',
  'commandHint',
]);

/**
 * Filter a YAML frontmatter string down to Factory-recognized top-level keys.
 *
 * Preserves the order and exact line content of kept blocks (no YAML round-trip),
 * including indented continuation lines. Block boundaries are detected by
 * unindented `key:` lines.
 */
export function filterFactorySkillFrontmatter(frontmatter) {
  const lines = frontmatter.split('\n');
  const kept = [];
  let keepingCurrent = true;

  for (const line of lines) {
    const topKeyMatch = line.match(/^([A-Za-z_][\w-]*)\s*:/);
    if (topKeyMatch) {
      // Start of a new top-level block — decide whether to keep it.
      keepingCurrent = FACTORY_SKILL_TOP_LEVEL_KEYS.has(topKeyMatch[1]);
      if (keepingCurrent) kept.push(line);
      continue;
    }
    // Continuation of the current block (indented value, list item, blank line).
    if (keepingCurrent) kept.push(line);
  }

  return kept.join('\n');
}

/**
 * Transform command for Factory
 * Commands use similar format to agents
 */
export function transformCommand(srcPath, content, opts) {
  // Commands are simpler - just basic frontmatter transformation
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return content;

  const [, frontmatter, body] = fmMatch;

  // Extract metadata
  const rawName = frontmatter.match(/name:\s*(.+)/)?.[1]?.trim();
  const description = frontmatter.match(/description:\s*(.+)/)?.[1]?.trim();
  const args = frontmatter.match(/args:\s*(.+)/)?.[1]?.trim();
  const argumentHint = frontmatter.match(/argument-hint:\s*(.+)/)?.[1]?.trim();

  // Convert name to kebab-case
  const name = toKebabCase(rawName) || path.basename(srcPath, '.md');

  // Build Factory command frontmatter
  let factoryFrontmatter = `---
name: ${name}
description: ${description || 'AIWG command'}
argument-hint: ${argumentHint || '<task-description>'}`;

  if (args) {
    factoryFrontmatter += `\nargs: ${args}`;
  }

  factoryFrontmatter += '\n---';

  // Prepend $ARGUMENTS so Factory passes user input into the prompt body.
  // Factory silently drops anything typed after the command name if $ARGUMENTS
  // is not present. This is a deploy-time transform only — source files are unchanged.
  const bodyWithArgs = `$ARGUMENTS\n\n${body.trim()}`;

  return `${factoryFrontmatter}\n\n${bodyWithArgs}`;
}

// ============================================================================
// Deployment Functions
// ============================================================================

/**
 * Deploy agents to .factory/droids/
 */
export function deployAgents(agentFiles, targetDir, opts) {
  const destDir = path.join(targetDir, paths.agents);
  ensureDir(destDir, opts.dryRun);
  return deployFiles(agentFiles, destDir, { ...opts, injectPlatform: true }, transformAgent);
}

/**
 * Deploy commands to .factory/commands/
 */
export function deployCommands(commandFiles, targetDir, opts) {
  const destDir = path.join(targetDir, paths.commands);
  ensureDir(destDir, opts.dryRun);
  return deployFiles(commandFiles, destDir, opts, transformCommand);
}

/**
 * Deploy skills with kernel-vs-standard routing (#1212/#1216).
 *   - kernel skills → .factory/skills/        (platform-native, always-loaded)
 *   - standard      → .factory/.aiwg/skills/  (index-discoverable)
 */
export function deploySkills(skillDirs, targetDir, opts) {
  const standardDestDir = path.join(targetDir, paths.skills);
  const kernelDestDir = path.join(targetDir, kernelSkillsPath);
  const skillOpts = { ...opts, transformSkillMd: transformSkillFrontmatter };
  deploySkillsWithKernelRouting(skillDirs, standardDestDir, kernelDestDir, skillOpts);
}

/**
 * Deploy rules to .factory/rules/
 */
export function deployRules(ruleFiles, targetDir, opts) {
  if (opts.ruleDelivery) return [];
  const destDir = path.join(targetDir, paths.rules);
  ensureDir(destDir, opts.dryRun);
  cleanupOldRuleFiles(destDir, opts);
  return deployFiles(ruleFiles, destDir, opts, transformAgent);
}

// ============================================================================
// AGENTS.md
// ============================================================================

/**
 * Create/update AGENTS.md from Factory template
 */
export function createAgentsMd(target, srcRoot, dryRun) {
  createAgentsMdFromTemplate(target, srcRoot, 'factory/AGENTS.md.aiwg-template', dryRun);
}

// ============================================================================
// Factory Settings
// ============================================================================

/**
 * Enable custom droids in Factory settings.json
 */
export function enableFactoryCustomDroids(dryRun) {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) {
    console.warn('Could not determine home directory, skipping Factory settings configuration');
    return;
  }

  const settingsDir = path.join(homeDir, '.factory');
  const settingsPath = path.join(settingsDir, 'settings.json');

  let settings = {};
  let originalContent = '';
  let hasExistingFile = false;

  // Read existing settings if present
  if (fs.existsSync(settingsPath)) {
    hasExistingFile = true;
    try {
      originalContent = fs.readFileSync(settingsPath, 'utf8');
      // Strip JSONC comments before parsing
      const jsonContent = stripJsonComments(originalContent);
      settings = JSON.parse(jsonContent);
    } catch (err) {
      console.warn(`Warning: Could not parse existing Factory settings.json: ${err.message}`);
      console.warn('Will add enableCustomDroids setting using text manipulation to preserve file...');

      // Try to add the setting via text manipulation
      if (originalContent.includes('"enableCustomDroids"')) {
        if (originalContent.includes('"enableCustomDroids": true') ||
            originalContent.includes('"enableCustomDroids":true')) {
          console.log('Factory Custom Droids already enabled in settings');
          return;
        }
        // Replace false with true
        if (!dryRun) {
          const updatedContent = originalContent.replace(
            /"enableCustomDroids"\s*:\s*false/,
            '"enableCustomDroids": true'
          );
          fs.writeFileSync(settingsPath, updatedContent, 'utf8');
          console.log(`Enabled Custom Droids in Factory settings: ${settingsPath}`);
        } else {
          console.log(`[dry-run] Would enable Custom Droids in ${settingsPath}`);
        }
        return;
      }

      // Setting doesn't exist, add it after the first {
      if (!dryRun) {
        const insertPoint = originalContent.indexOf('{') + 1;
        const updatedContent =
          originalContent.slice(0, insertPoint) +
          '\n  "enableCustomDroids": true,' +
          originalContent.slice(insertPoint);
        fs.writeFileSync(settingsPath, updatedContent, 'utf8');
        console.log(`Enabled Custom Droids in Factory settings: ${settingsPath}`);
      } else {
        console.log(`[dry-run] Would enable Custom Droids in ${settingsPath}`);
      }
      return;
    }
  }

  // Check if Custom Droids already enabled
  if (settings.enableCustomDroids === true) {
    console.log('Factory Custom Droids already enabled in settings');
    return;
  }

  // Enable Custom Droids
  settings.enableCustomDroids = true;

  if (dryRun) {
    console.log(`[dry-run] Would enable Custom Droids in ${settingsPath}`);
    console.log(`[dry-run] New setting: enableCustomDroids: true`);
  } else {
    // Ensure settings directory exists
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }

    if (hasExistingFile && originalContent.includes('//')) {
      // File has comments - use text manipulation to preserve them
      if (originalContent.includes('"enableCustomDroids"')) {
        const updatedContent = originalContent.replace(
          /"enableCustomDroids"\s*:\s*false/,
          '"enableCustomDroids": true'
        );
        fs.writeFileSync(settingsPath, updatedContent, 'utf8');
      } else {
        const insertPoint = originalContent.indexOf('{') + 1;
        const updatedContent =
          originalContent.slice(0, insertPoint) +
          '\n  "enableCustomDroids": true,' +
          originalContent.slice(insertPoint);
        fs.writeFileSync(settingsPath, updatedContent, 'utf8');
      }
    } else {
      // No comments or new file - safe to use JSON.stringify
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    }
    console.log(`Enabled Custom Droids in Factory settings: ${settingsPath}`);
    console.log('Note: You may need to restart droid for this setting to take effect');
  }
}

// ============================================================================
// Factory Hooks
// ============================================================================

export { deployFactoryHooks } from './factory-hooks.mjs';
import { deployFactoryHooks } from './factory-hooks.mjs';

// ============================================================================
// Post-Deployment
// ============================================================================

export async function postDeploy(targetDir, opts) {
  // Initialize framework workspace structure
  initializeFrameworkWorkspace(targetDir, opts.mode, opts.dryRun, opts.srcRoot);

  // Enable custom droids in Factory settings
  enableFactoryCustomDroids(opts.dryRun);

  // Deploy SessionStart hook for AIWG pre-flight checks
  if (opts.hooks !== false) await deployFactoryHooks(opts.dryRun, opts.scope === 'user' ? undefined : targetDir);

  // Create/update AGENTS.md if requested
  if (opts.createAgentsMd) {
    if (opts.contextFiles !== false) createAgentsMd(targetDir, opts.srcRoot, opts.dryRun);
  }
}

// ============================================================================
// Factory Plugin Bundle
// ============================================================================

/**
 * Generate a .factory-plugin/ bundle for distributing AIWG as a Factory plugin.
 *
 * Factory plugins use the structure:
 *   .factory-plugin/
 *     plugin.json       — manifest (name, version, description, contents)
 *     droids/           — agent definitions
 *     commands/         — command definitions
 *     skills/           — skill definitions
 *     rules/            — rule definitions
 *     hooks.json        — hook configuration
 *
 * Invoke via: aiwg use sdlc --provider factory --as-plugin
 */
export function generatePluginBundle(targetDir, opts) {
  const pluginDir = path.join(targetDir, '.factory-plugin');
  const { dryRun, version } = opts;

  // Read package.json for version info
  let pkgVersion = version || 'unknown';
  if (!version) {
    try {
      const pkgPath = path.join(opts.srcRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        pkgVersion = pkg.version || 'unknown';
      }
    } catch (_) { /* use default */ }
  }

  // Count deployed artifacts
  const droidDir = path.join(targetDir, paths.agents);
  const cmdDir = path.join(targetDir, paths.commands);
  const skillDir = path.join(targetDir, paths.skills);
  const ruleDir = path.join(targetDir, paths.rules);

  const countFiles = (dir, ext) => {
    try {
      return fs.readdirSync(dir).filter(f => f.endsWith(ext || '.md')).length;
    } catch (_) { return 0; }
  };

  const droidCount = countFiles(droidDir);
  const commandCount = countFiles(cmdDir);
  const ruleCount = countFiles(ruleDir);
  let skillCount = 0;
  try {
    skillCount = fs.readdirSync(skillDir).filter(f =>
      fs.statSync(path.join(skillDir, f)).isDirectory()
    ).length;
  } catch (_) { /* 0 */ }

  // Build plugin manifest
  const manifest = {
    name: 'aiwg-sdlc',
    version: pkgVersion,
    description: `AIWG SDLC Framework v${pkgVersion} — ${droidCount} droids, ${commandCount} commands, ${skillCount} skills, ${ruleCount} rules. Phase-based SDLC workflows with specialized agents for architecture, security, testing, and deployment.`,
    author: {
      name: 'AIWG Contributors',
      email: 'support@aiwg.io'
    },
    homepage: 'https://aiwg.io',
    repository: 'https://github.com/jmagly/aiwg',
    license: 'MIT',
    contents: {
      droids: droidCount,
      commands: commandCount,
      skills: skillCount,
      rules: ruleCount
    },
    hooks: {
      SessionStart: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: 'aiwg refresh --dry-run --quiet'
            }
          ]
        }
      ]
    },
    keywords: [
      'sdlc', 'software-development', 'project-management',
      'security', 'testing', 'architecture', 'devops', 'aiwg'
    ]
  };

  if (dryRun) {
    console.log(`[dry-run] Would create ${pluginDir}/plugin.json`);
    console.log(`[dry-run] Plugin: aiwg-sdlc v${pkgVersion} (${droidCount} droids, ${commandCount} commands, ${skillCount} skills, ${ruleCount} rules)`);
    return;
  }

  ensureDir(pluginDir, false);
  fs.writeFileSync(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8'
  );
  console.log(`Generated Factory plugin manifest: ${pluginDir}/plugin.json`);
  console.log(`Plugin: aiwg-sdlc v${pkgVersion} (${droidCount} droids, ${commandCount} commands, ${skillCount} skills, ${ruleCount} rules)`);
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
 * Main deployment function for Factory provider
 */
export async function deploy(opts) {
  return withRuleDeployment(opts, { name, paths, kernelSkillsPath, transformSkillMd: transformSkillFrontmatter }, deploySelected);
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

  console.log(`\n=== Factory AI Provider ===`);
  console.log(`Target: ${target}`);
  console.log(`Mode: ${mode}`);

  // Collect source files based on mode
  const agentFiles = [];
  const commandFiles = [];
  const ruleFiles = [];
  const skillDirs = [];
  const normalizedMode = normalizeDeploymentMode(mode);

  // Check for addon-style directory structure (direct agents/, commands/,
  // skills/, rules/ subdirs). Handles deployment when --source points at a
  // project-local bundle (.aiwg/extensions/<name>/) rather than $AIWG_ROOT.
  // Mirrors the reference implementation in claude.mjs (#124).
  const isAddonSource = fs.existsSync(path.join(srcRoot, 'agents')) ||
                        fs.existsSync(path.join(srcRoot, 'commands')) ||
                        fs.existsSync(path.join(srcRoot, 'skills')) ||
                        fs.existsSync(path.join(srcRoot, 'rules'));

  if (isAddonSource) {
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

  // All addons (dynamically discovered)
  if (normalizedMode === 'general' || normalizedMode === 'sdlc' || normalizedMode === 'both' || normalizedMode === 'all') {
    agentFiles.push(...getAddonAgentFiles(srcRoot));

    if (shouldDeployCommands || commandsOnly) {
      commandFiles.push(...getAddonCommandFiles(srcRoot));
    }

    if (shouldDeployRules || rulesOnly) {
      ruleFiles.push(...getAddonRuleFiles(srcRoot));
    }

    if (shouldDeploySkills || skillsOnly) {
      skillDirs.push(...getAddonSkillDirs(srcRoot));
  
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
    console.log(`\nDeploying ${agentFiles.length} agents as droids...`);
    deployAgents(agentFiles, target, opts);

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

  // Generate Factory plugin bundle if requested
  if (opts.asPlugin) {
    console.log('\nGenerating Factory plugin bundle...');
    generatePluginBundle(target, opts);
  }

  console.log('\n=== Factory deployment complete ===\n');
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
  transformSkillFrontmatter,
  filterFactorySkillFrontmatter,
  mapModel,
  mapReasoningEffort,
  mapToolsToFactory,
  deployAgents,
  deployCommands,
  deploySkills,
  deployRules,
  createAgentsMd,
  enableFactoryCustomDroids,
  deployFactoryHooks,
  generatePluginBundle,
  postDeploy,
  getFileExtension,
  deploy
};
