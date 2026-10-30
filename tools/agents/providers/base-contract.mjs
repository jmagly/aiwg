// Shared provider contract utilities.
import { path } from './base-runtime.mjs';


// ============================================================================
// Provider Interface
// ============================================================================

/**
 * Base provider interface - all providers should implement these methods
 */
export const ProviderInterface = {
  name: 'base',
  aliases: [],

  // ── Path Configuration ──────────────────────────────────────────────
  // Paths describe native or conventional deployment only. Empty paths mean
  // indexed access via aiwg discover/show, not an unavailable artifact class.
  paths: {
    agents: null,
    commands: null,
    skills: null,
    rules: null
  },

  // ── Support Level per Artifact Type ─────────────────────────────────
  // Distinguishes native platform support from AIWG conventional directories.
  //   'native'       - Platform natively discovers and uses these files
  //   'conventional' - AIWG directory convention; available for @-mention context loading
  //   'aggregated'   - Content included in aggregated file AND deployed as discrete files
  //   'indexed'      - Full source body available via aiwg discover/show without a native loader
  support: {
    agents: 'conventional',
    commands: 'conventional',
    skills: 'conventional',
    rules: 'conventional'
  },

  // ── Provider Capabilities ───────────────────────────────────────────
  capabilities: {
    skills: false,
    rules: false,
    aggregatedOutput: false,
    yamlFormat: false,
    mdcFormat: false,
    homeDirectoryDeploy: false,
    projectLocalMirror: false
  },

  // ── Home Directory Paths (Codex-specific) ───────────────────────────
  // Only populated for providers that deploy to home directory.
  homePaths: {
    commands: null,
    skills: null
  },

  // ── Artifact Transformation ─────────────────────────────────────────
  transformAgent(srcPath, content, opts) { return content; },
  transformCommand(srcPath, content, opts) { return content; },
  transformSkill(srcPath, content, opts) { return content; },
  transformRule(srcPath, content, opts) { return content; },

  // ── Model Mapping ──────────────────────────────────────────────────
  mapModel(shorthand, modelCfg, modelsConfig) { return shorthand; },

  // ── Deployment Functions ────────────────────────────────────────────
  // All four deploy functions are available. Providers override as needed.
  deployAgents(agentFiles, targetDir, opts) {},
  deployCommands(commandFiles, targetDir, opts) {},
  deploySkills(skillDirs, targetDir, opts) {},
  deployRules(ruleFiles, targetDir, opts) {},

  // ── Aggregation (for Warp, Windsurf) ────────────────────────────────
  aggregate(artifacts, targetDir, opts) {},

  // ── Create/update AGENTS.md ────────────────────────────────────────
  createAgentsMd(target, srcRoot, dryRun) {
    // Override in provider
  },

  // ── Post-deployment hook ───────────────────────────────────────────
  async postDeploy(targetDir, opts) {
    // Override in provider if needed
  },

  // ── File Extension ────────────────────────────────────────────────
  getFileExtension(type) { return '.md'; }
};


/** Replace only the generated binding block; keep authored bytes intact. */
export function replaceBoundRulesBlock(content, rules = []) {
  const clean = content.replace(/\n?<!-- AIWG:bound-rules:start -->[\s\S]*?<!-- AIWG:bound-rules:end -->\n?/g, '');
  if (!rules.length) return clean;
  const unique = [...new Map(rules.map(rule => [rule.name, rule])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  return `${clean}${clean.endsWith('\n') ? '' : '\n'}\n<!-- AIWG:bound-rules:start -->\n## Bound rules\n\nRequired reading on every invocation: fetch and follow every bound rule below before starting governed work. A summary or discovery pointer does not discharge this obligation.\n\n${unique.map(rule =>
    `- ${rule.name} — ${rule.summary}\n  Fetch and follow before governed work: \`aiwg show rule ${rule.name} --body\`.`
  ).join('\n')}\n<!-- AIWG:bound-rules:end -->\n`;
}


export function injectBoundRules(content, source, opts = {}) {
  if (!opts.ruleDelivery) return content;
  return replaceBoundRulesBlock(content, opts.ruleDelivery.bindings.get(path.resolve(source)) || []);
}


/** Rule delivery stages output and guards startup before promotion. Deferred
 * kernel passes leave rule delivery to the final source in the invocation. */
export async function withRuleDeployment(opts, provider, deploy) {
  if (opts.kernelOnly && opts.deferRuleProjection && provider.name !== 'warp'
    && !globalThis[Symbol.for('aiwg.provider-preparation-hook.v1')]) return deploy(opts);
  const { deployWithRuleDelivery } = await import('./rule-delivery.mjs');
  return deployWithRuleDelivery(opts, provider, deploy);
}
