// Shared provider rule index utilities.
import { DEFAULT_RULES_INLINE_BUDGET_TOKENS, fs, inferRuleActivation, parseRuleFrontmatter, path, resolveRulesInlineBudget } from './base-runtime.mjs';
import { resolveAiwgRoot } from './base-inventory.mjs';
import { addManagedMarker, listMdFiles } from './base-files.mjs';
import { discoverAddons } from './base-addon-discovery.mjs';


/**
 * Get all rule files from all addons
 * @param {string} srcRoot - Source root directory
 * @param {string[]} excludeAddons - Addon names to exclude (default: none)
 * @returns {string[]} - Array of rule file paths
 */
/**
 * Read a rule's enforcement level from its `enforcement:` frontmatter
 * (#1673). Returns 'critical' | 'high' | 'medium' | 'low' | null.
 */
export function ruleEnforcementLevel(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (m) {
    const e = m[1].match(/^enforcement:\s*([A-Za-z]+)/m);
    if (e) return e[1].toLowerCase();
  }
  // Rules without frontmatter declare the level in the body header.
  const body = content.match(/^\*\*Enforcement Level\*\*:\s*([A-Za-z]+)/m);
  return body ? body[1].toLowerCase() : null;
}


/**
 * Default inline rule budget (#2562). Every inlined rule is loaded into every
 * session AND every subagent dispatch, so the always-on set must leave room
 * for the agent definition, the system prompt, and the task itself inside the
 * standard 200K window. 64K tokens (~256 KB) keeps a full CRITICAL+HIGH
 * deployment dispatchable; `AIWG_RULES_INLINE_BUDGET_TOKENS=0` disables the
 * budget, any other value overrides it.
 */
export function resolveRulesInlineBudgetTokens(env = process.env) {
  return resolveRulesInlineBudget({}, env);
}


/** Sidecar recording which rules the inline budget moved on demand (#2562). */
export const RULE_BUDGET_SIDECAR = '.aiwg-rules-budget.json';


export function readRuleBudgetSidecar(destDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(destDir, RULE_BUDGET_SIDECAR), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.demoted)) return null;
    return { budgetTokens: Number(parsed.budgetTokens) || 0, demoted: parsed.demoted.map(String) };
  } catch {
    return null;
  }
}


// Compatibility exports: budgets never change selection or retain demotions.
export function reconcileInlineRuleBudget(destDir, budgetTokens, opts = {}) {
  if (!opts.dryRun) fs.rmSync(path.join(destDir, RULE_BUDGET_SIDECAR), { force: true });
  return { demoted: [], removed: [] };
}

export function applyInlineRuleBudget(ruleFiles) {
  return { inline: [...(ruleFiles || [])], demoted: [] };
}


/**
 * Tier gate (#1673, enforcement-tiered deployment ADR). Only CRITICAL and HIGH
 * rules are inlined into a provider's always-on rule directory; MEDIUM/LOW are
 * left on-demand (reachable via `aiwg show rule <name> --body` and the assembled
 * RULES-INDEX pointer index). Index files and rules with no enforcement marker
 * default to always-on, so an un-triaged or structural file is never dropped.
 */
export function isAlwaysOnRule(filePath) {
  const base = path.basename(filePath);
  if (base === 'RULES-INDEX.md' || base === 'RULES-ONDEMAND.md') return true;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = parseRuleFrontmatter(content);
    if (!parsed.valid) throw new Error(`${filePath}: ${parsed.diagnostics.map(d => d.message).join('; ')}`);
    const activation = parsed.rule.tagged ? parsed.rule.activation : inferRuleActivation(ruleEnforcementLevel(content));
    return activation === 'kernel' || activation === 'paths';
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}


/**
 * Enumerate MEDIUM/LOW rule files for the whole installed AIWG corpus.
 * `srcRoot` may be the repository root or a bundled framework/addon/extension
 * root during a multi-pass deploy; normalize it before discovery so a later
 * pass never truncates an index written by an earlier pass.
 */
export function listOnDemandRuleFiles(srcRoot, excludeAddons = []) {
  const out = [];
  const aiwgRoot = resolveAiwgRoot(srcRoot) || srcRoot;
  const consider = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of listMdFiles(dir)) {
      const b = path.basename(f);
      if (b === 'RULES-INDEX.md' || b === 'RULES-ONDEMAND.md') continue;
      const parsed = parseRuleFrontmatter(fs.readFileSync(f, 'utf8'));
      if (!parsed.valid) throw new Error(`${f}: invalid rule frontmatter`);
      if (!parsed.rule.tagged && !isAlwaysOnRule(f)) out.push(f);
    }
  };
  for (const addon of discoverAddons(aiwgRoot)) {
    if (excludeAddons.includes(addon.name)) continue;
    consider(path.join(addon.path, 'rules'));
  }
  const codeRoot = path.join(aiwgRoot, 'agentic', 'code');
  for (const fwDir of ['frameworks', 'extensions']) {
    const base = path.join(codeRoot, fwDir);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) consider(path.join(base, entry.name, 'rules'));
    }
  }
  return out;
}


/**
 * Sorted, de-duplicated rule names (basename minus `.md`) from a list of
 * on-demand rule file paths. Shared by the discrete index writer and the
 * aggregated-bridge section renderer so both stay in lock-step.
 */
export function onDemandRuleNames(onDemandFiles, exclude = []) {
  const skip = new Set(exclude);
  return [...new Set((onDemandFiles || []).map((f) => path.basename(f).replace(/\.md$/, '')))]
    .filter((n) => !skip.has(n))
    .sort();
}


/**
 * Render the on-demand rule list as a markdown section (#1675) for aggregated
 * providers whose rules live in a single bridge file (WARP.md, AGENTS.md)
 * rather than a discrete `RULES-ONDEMAND.md`. Returns '' when nothing is
 * on-demand so callers can skip the section entirely. `exclude` drops names
 * already inlined verbatim in the bridge (e.g. Warp's aiwg-utils set).
 */
export function renderOnDemandRuleSection(onDemandFiles, opts = {}) {
  const names = onDemandRuleNames(onDemandFiles, opts.exclude || []);
  if (names.length === 0) return '';
  const heading = opts.heading || '## On-Demand Rules';
  return [
    heading,
    '',
    'These MEDIUM/LOW-enforcement rules are not inlined here, to keep the',
    'always-on context small. They still apply when relevant — fetch any body',
    'on demand:',
    '',
    '```bash',
    'aiwg show rule <name> --body',
    '```',
    '',
    ...names.map((n) => `- \`${n}\` — \`aiwg show rule ${n} --body\``),
  ].join('\n');
}


/**
 * Write a compact on-demand rule index (#1673) into a provider's rule dir.
 * Lists the MEDIUM/LOW rules that are NOT inlined at startup, with the
 * `aiwg show rule <name> --body` fetch hint. Removes a stale index when empty.
 */
export function writeOnDemandRuleIndex(destDir, onDemandFiles, opts = {}) {
  const indexPath = path.join(destDir, 'RULES-ONDEMAND.md');
  const demotedNames = [...new Set([...onDemandRuleNames(opts.demotedFiles || []), ...(opts.demotedNames || [])])].sort();
  const names = onDemandRuleNames(onDemandFiles, demotedNames);
  if (names.length === 0 && demotedNames.length === 0) {
    try {
      if (fs.existsSync(indexPath) && !opts.dryRun) fs.rmSync(indexPath);
    } catch { /* ignore */ }
    return 0;
  }
  const lines = [
    '# On-Demand Rules (not inlined at startup)',
    '',
    'These MEDIUM/LOW-enforcement rules are not loaded into every session, to keep',
    'the standard-context startup budget small. They still apply when relevant —',
    'fetch any rule body on demand:',
    '',
    '```bash',
    'aiwg show rule <name> --body',
    '```',
    '',
    ...names.map((n) => `- \`${n}\` — \`aiwg show rule ${n} --body\``),
    '',
  ];
  if (demotedNames.length > 0) {
    // HIGH rules that did not fit the inline budget (#2562). They remain
    // binding; they are fetched on demand so subagent dispatch keeps working.
    lines.push(
      '## Binding rules moved on demand to fit the inline budget',
      '',
      'These HIGH-enforcement rules still apply in full. They are not inlined because the',
      `always-on rule set would otherwise exceed the ${(opts.inlineBudgetTokens ?? DEFAULT_RULES_INLINE_BUDGET_TOKENS).toLocaleString()}-token inline budget`,
      '(AIWG_RULES_INLINE_BUDGET_TOKENS) and break subagent dispatch with "Prompt is too long".',
      'Fetch any of them before work they govern:',
      '',
      ...demotedNames.map((n) => `- \`${n}\` — \`aiwg show rule ${n} --body\``),
      '',
    );
  }
  let content = lines.join('\n');
  content = addManagedMarker(content, opts.deployVersion || 'unknown', opts.deploySource || 'bundled');
  if (!opts.dryRun) fs.writeFileSync(indexPath, content, 'utf8');
  return names.length + demotedNames.length;
}


export function getAddonRuleFiles(srcRoot, excludeAddons = [], options = {}) {
  const addons = discoverAddons(srcRoot, options);
  const files = [];

  for (const addon of addons) {
    if (excludeAddons.includes(addon.name)) continue;

    const rulesDir = path.join(addon.path, 'rules');
    if (fs.existsSync(rulesDir)) {
      for (const file of listMdFiles(rulesDir)) {
        // Consolidation remains a legacy inventory policy. Explicit activation
        // owns delivery, including the desired set used by the outer prune.
        if (addon.manifest?.consolidation?.deployIndexOnly) {
          const parsed = parseRuleFrontmatter(fs.readFileSync(file, 'utf8'));
          if (!parsed.valid) throw new Error(`${file}: invalid rule frontmatter`);
          if (!parsed.rule.tagged) continue;
        }
        files.push(file);
      }
    }
  }

  // Activation selects bodies; only untagged rules use the old severity tier.
  // The deploy enumeration and prune desired set must select the same bodies.
  return files.filter(isAlwaysOnRule);
}


// ============================================================================
// Consolidated Rules Deployment
// ============================================================================

/**
 * Load rules manifest from source directory.
 * Inventory metadata only: delivery is decided by rule `activation` (rule-delivery.mjs);
 * the former manifest `tiers` deploy policy was never consulted and was removed (#3450).
 * @param {string} srcRoot - Source root directory
 * @returns {object|null} - Parsed manifest or null if not found
 */
export function loadRulesManifest(srcRoot) {
  const manifestPath = path.join(srcRoot, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'rules', 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    console.warn(`Warning: Could not parse rules manifest: ${e.message}`);
    return null;
  }
}


/**
 * Group rules by tier
 * @param {Array} rules - Array of rule objects from manifest
 * @returns {{core: Array, sdlc: Array, research: Array}}
 */
export function groupRulesByTier(rules) {
  const groups = { core: [], sdlc: [], research: [] };
  for (const rule of rules) {
    const tier = rule.tier || 'sdlc';
    if (groups[tier]) {
      groups[tier].push(rule);
    }
  }
  return groups;
}


/**
 * Group rules by enforcement level within a tier
 * @param {Array} rules - Array of rule objects
 * @returns {{critical: Array, high: Array, medium: Array}}
 */
export function groupByEnforcement(rules) {
  const groups = { critical: [], high: [], medium: [] };
  for (const rule of rules) {
    const level = (rule.enforcement || 'medium').toLowerCase();
    if (groups[level]) {
      groups[level].push(rule);
    }
  }
  return groups;
}


/**
 * Get the RULES-INDEX.md path for a component (framework or addon).
 * Checks the component's manifest.json for consolidation.rulesIndex.
 * @param {string} componentPath - Path to the component directory
 * @returns {string|null} - Path to the component's RULES-INDEX.md or null
 */
export function getComponentRulesIndexPath(componentPath) {
  const manifestPath = path.join(componentPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const rulesIndex = manifest.consolidation?.rulesIndex;
    if (!rulesIndex) return null;

    const indexPath = path.join(componentPath, rulesIndex);
    return fs.existsSync(indexPath) ? indexPath : null;
  } catch (e) {
    return null;
  }
}


/**
 * Assemble the deployed RULES-INDEX.md from the global template and all
 * installed component indexes.
 *
 * Flow:
 * 1. Read global template from agentic/code/RULES-INDEX.md
 * 2. For each component with consolidation support, read its RULES-INDEX.md
 * 3. Concatenate: global header + component indexes + global quick reference
 *
 * @param {string} srcRoot - Source root directory
 * @returns {string|null} - Assembled content or null if global template missing
 */
export function assembleRulesIndex(srcRoot) {
  const globalPath = path.join(srcRoot, 'agentic', 'code', 'RULES-INDEX.md');
  if (!fs.existsSync(globalPath)) return null;

  const globalContent = fs.readFileSync(globalPath, 'utf8');

  // Find the Quick Reference section in the global template
  const qrMarker = '## Quick Reference by Context';
  const qrIndex = globalContent.indexOf(qrMarker);

  // Split global into header (before Quick Reference) and footer (Quick Reference + rest)
  let header, footer;
  if (qrIndex >= 0) {
    header = globalContent.substring(0, qrIndex).trimEnd();
    footer = globalContent.substring(qrIndex);
  } else {
    header = globalContent;
    footer = '';
  }

  // Collect component indexes
  const componentSections = [];

  // 1. Framework indexes (sdlc-complete, etc.)
  const frameworksDir = path.join(srcRoot, 'agentic', 'code', 'frameworks');
  if (fs.existsSync(frameworksDir)) {
    for (const entry of fs.readdirSync(frameworksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fwPath = path.join(frameworksDir, entry.name);
      const indexPath = getComponentRulesIndexPath(fwPath);
      if (indexPath) {
        componentSections.push(fs.readFileSync(indexPath, 'utf8').trim());
      }
    }
  }

  // 2. Addon indexes
  const addons = discoverAddons(srcRoot);
  for (const addon of addons) {
    const indexPath = getComponentRulesIndexPath(addon.path);
    if (indexPath) {
      componentSections.push(fs.readFileSync(indexPath, 'utf8').trim());
    }
  }

  // Assemble: header + component indexes + footer
  const parts = [header];
  if (componentSections.length > 0) {
    parts.push('');
    parts.push(componentSections.join('\n\n'));
  }
  if (footer) {
    parts.push('');
    parts.push(footer);
  }

  return parts.join('\n');
}


/**
 * Get the RULES-INDEX.md file path from source
 * @param {string} srcRoot - Source root directory
 * @returns {string|null} - Path to RULES-INDEX.md or null
 */
export function getRulesIndexPath(srcRoot) {
  const indexPath = path.join(srcRoot, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'rules', 'RULES-INDEX.md');
  return fs.existsSync(indexPath) ? indexPath : null;
}


/**
 * Generate consolidated rules content from manifest for a specific provider.
 * Used by content-injection providers (copilot, warp, windsurf) that need
 * the rules content inline rather than as a file.
 *
 * @param {string} srcRoot - Source root directory
 * @param {string} provider - Provider name (for @-link formatting)
 * @param {string[]} [addonRuleFiles] - Optional addon rule file paths
 * @returns {string|null} - Generated content or null if manifest/index missing
 */
export function generateConsolidatedRulesContent(srcRoot, provider, addonRuleFiles = []) {
  // Try assembled index first (new multi-component assembly)
  const assembled = assembleRulesIndex(srcRoot);
  if (assembled) {
    let content = assembled;
    // Append any remaining non-consolidated addon rules
    if (addonRuleFiles.length > 0) {
      content += '\n\n---\n\n## Additional Addon Rules\n\n';
      for (const ruleFile of addonRuleFiles) {
        const ruleName = path.basename(ruleFile, '.md');
        content += `- **${ruleName}**: @${path.relative(srcRoot, ruleFile)}\n`;
      }
    }
    return content;
  }

  // Fallback: legacy single-index behavior
  const indexPath = getRulesIndexPath(srcRoot);
  if (!indexPath) return null;

  let content = fs.readFileSync(indexPath, 'utf8');

  if (addonRuleFiles.length > 0) {
    content += '\n\n---\n\n## Addon Rules\n\n';
    for (const ruleFile of addonRuleFiles) {
      const ruleName = path.basename(ruleFile, '.md');
      content += `- **${ruleName}**: @${path.relative(srcRoot, ruleFile)}\n`;
    }
  }

  return content;
}
