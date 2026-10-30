// Model persistence and interactive command migration support.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
export function resolveShorthand(value, shorthandMap, modelsConfig, provider, tier) {
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
export async function saveModelConfig(cfg, providerName) {
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
export async function promptCommandsMigration(cfg, provider, targetDir, interactive = process.stdout.isTTY) {
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
  if (cfg.quiet || !interactive) return true;

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
