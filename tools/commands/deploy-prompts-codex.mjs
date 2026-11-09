#!/usr/bin/env node
/**
 * Deploy Commands as Prompts to Codex
 *
 * Transforms AIWG slash commands to Codex prompt format and deploys to ~/.codex/prompts/
 *
 * Codex Prompt Format:
 * - Location: ~/.codex/prompts/<name>.md
 * - YAML frontmatter (optional): description, argument-hint
 * - Placeholders: $1-$9, $ARGUMENTS, $NAMED
 *
 * Usage:
 *   node tools/commands/deploy-prompts-codex.mjs [options]
 *
 * Options:
 *   --source <path>    Source directory (defaults to repo root)
 *   --target <path>    Target directory (defaults to ~/.codex/prompts)
 *   --mode <type>      Deployment mode: general, sdlc, marketing (alias: mmk), media-curator, research, or all (default)
 *   --dry-run          Show what would be deployed without writing
 *   --force            Overwrite existing files
 *   --prefix <str>     Prefix for prompt names (default: 'aiwg')
 */

import realFs from 'fs';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
let fs;
try { const gfs = _require('graceful-fs'); gfs.gracefulify(realFs); fs = realFs; } catch { fs = realFs; }
import path from 'path';
import { fileURLToPath } from 'node:url';
import os from 'os';
import { importImpl } from '../_resolve-impl.mjs';
const { legacyCodexPromptOwner, outputDigest } = await importImpl(import.meta.url, 'providers/deployment-ownership.mjs');
import { getFrameworksForMode, normalizeDeploymentMode, getAddonSkillDirs, listSkillDirs, collectFrameworkArtifacts } from '../agents/providers/base.mjs';

function parseArgs(args, homeDir) {
  const cfg = {
    source: null,
    target: path.join(homeDir, '.codex', 'prompts'),
    mode: 'all',
    dryRun: false,
    force: false,
    prefix: 'aiwg'
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source' && args[i + 1]) cfg.source = path.resolve(args[++i]);
    else if (a === '--target' && args[i + 1]) cfg.target = path.resolve(args[++i]);
    else if (a === '--mode' && args[i + 1]) cfg.mode = String(args[++i]).toLowerCase();
    else if (a === '--dry-run') cfg.dryRun = true;
    else if (a === '--force') cfg.force = true;
    else if (a === '--prefix' && args[i + 1]) cfg.prefix = args[++i];
  }

  cfg.mode = normalizeDeploymentMode(cfg.mode);
  return cfg;
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/**
 * List .md command files in a directory
 */
function listCommandFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  const excluded = ['README.md', 'manifest.md', 'DEVELOPMENT_GUIDE.md'];

  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md') && !excluded.includes(e.name))
    .map(e => path.join(dir, e.name));
}

/**
 * Parse AIWG command frontmatter and body
 */
function parseCommandFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Check for YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (fmMatch) {
    const [, frontmatter, body] = fmMatch;
    const metadata = {};

    for (const line of frontmatter.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        metadata[key] = value;
      }
    }

    return { metadata, body: body.trim(), hasMetadata: true };
  }

  // No frontmatter, entire content is body
  return { metadata: {}, body: content.trim(), hasMetadata: false };
}

/**
 * Transform AIWG command to Codex prompt format
 */
function transformToCodexPrompt(commandPath, prefix) {
  const parsed = parseCommandFile(commandPath);
  const commandName = path.basename(commandPath, '.md');

  // Extract description from metadata or first paragraph
  let description = '';
  if (parsed.metadata.description) {
    description = parsed.metadata.description;
  } else {
    // Try to extract from first line after any heading
    const lines = parsed.body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-') && !trimmed.startsWith('```')) {
        description = trimmed.slice(0, 200);
        break;
      }
    }
  }

  // Extract argument hints from command body
  let argumentHint = '';
  const argPatterns = parsed.body.match(/\$ARGUMENTS|\$\d+|\$[A-Z_]+/g);
  if (argPatterns) {
    const unique = [...new Set(argPatterns)];
    argumentHint = unique.join(' ');
  }

  // Convert AIWG placeholders to Codex format
  // AIWG: $ARGUMENTS, $1, etc. -> Same in Codex
  let body = parsed.body;

  // Convert {{variable}} to $VARIABLE format
  body = body.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, name) => `$${name.toUpperCase()}`);

  // Build Codex prompt
  const promptName = prefix ? `${prefix}-${commandName}` : commandName;

  let promptContent = '';

  // Add frontmatter if we have description or argument-hint
  if (description || argumentHint) {
    promptContent = `---\n`;
    if (description) promptContent += `description: ${description}\n`;
    if (argumentHint) promptContent += `argument-hint: ${argumentHint}\n`;
    promptContent += `---\n\n`;
  }

  promptContent += body;

  return {
    name: promptName,
    description,
    argumentHint,
    content: promptContent,
    sourcePath: commandPath
  };
}

/**
 * Deploy prompt to Codex prompts directory
 */
function deployPrompt(prompt, targetDir, opts) {
  const { force = false, dryRun = false } = opts;
  const destPath = path.join(targetDir, `${prompt.name}.md`);

  // Check if prompt already exists
  if (fs.existsSync(destPath)) {
    if (!fs.lstatSync(destPath).isFile()) return { action: 'skip', reason: 'protected' };
    const bytes = fs.readFileSync(destPath);
    const existingContent = bytes.toString('utf8');
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(targetDir, '.aiwg-manifest.json'), 'utf8')).managed?.[`${prompt.name}.md`]; } catch { /* legacy install */ }
    // A recorded digest takes precedence over legacy evidence and markers:
    // edited managed files and unknown same-named files stay protected.
    const owned = record ? record.hash === outputDigest(bytes)
      : legacyCodexPromptOwner(destPath, bytes) || /^(?:<!--\s*aiwg:managed\s|#\s*aiwg:managed\s)/m.test(existingContent);
    if (!force && !owned) {
      console.log(`  skip (operator-owned): ${prompt.name}`);
      return { action: 'skip', reason: 'protected' };
    }
    if (existingContent === prompt.content && !force) {
      console.log(`  skip (unchanged): ${prompt.name}`);
      return { action: 'skip', reason: 'unchanged' };
    }
  }

  if (dryRun) {
    console.log(`  [dry-run] deploy: ${prompt.name}`);
    return { action: 'deploy', reason: 'dry-run' };
  }

  // Write prompt file
  fs.writeFileSync(destPath, prompt.content, 'utf8');
  console.log(`  deployed: ${prompt.name}.md`);

  return { action: 'deploy', reason: 'success' };
}

/**
 * Load addon manifest if it exists
 */
function loadAddonManifest(addonPath) {
  const manifestPath = path.join(addonPath, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      console.warn(`  Warning: Could not parse manifest at ${manifestPath}`);
    }
  }
  return {};
}

/**
 * Get command directories based on mode
 * Returns objects with: dir, label, isCore (whether to deploy all commands)
 */
function getCommandDirectories(srcRoot, mode) {
  const dirs = [];

  // General commands (not core - apply priority filter)
  if (mode === 'general' || mode === 'all') {
    const generalCommandsDir = path.join(srcRoot, 'commands');
    if (fs.existsSync(generalCommandsDir)) {
      dirs.push({ dir: generalCommandsDir, label: 'general', isCore: false });
    }
  }

  // Addon commands (dynamically discovered)
  // Check manifest for core/autoInstall flags
  if (mode === 'general' || mode === 'sdlc' || mode === 'both' || mode === 'all') {
    const addonsRoot = path.join(srcRoot, 'agentic', 'code', 'addons');
    if (fs.existsSync(addonsRoot)) {
      const addonEntries = fs.readdirSync(addonsRoot, { withFileTypes: true })
        .filter(e => e.isDirectory());

      for (const entry of addonEntries) {
        const addonPath = path.join(addonsRoot, entry.name);
        const addonCommandsDir = path.join(addonPath, 'commands');

        if (fs.existsSync(addonCommandsDir)) {
          const manifest = loadAddonManifest(addonPath);
          // Core addons (core: true or autoInstall: true) deploy ALL commands
          const isCore = manifest.core === true || manifest.autoInstall === true;

          dirs.push({
            dir: addonCommandsDir,
            label: entry.name,
            isCore
          });
        }
      }
    }
  }

  // Framework commands are discovered from framework manifests/directory structure.
  const frameworks = getFrameworksForMode(srcRoot, mode);
  for (const framework of frameworks) {
    if (framework.components.commands.exists) {
      dirs.push({
        dir: framework.components.commands.path,
        label: framework.id,
        isCore: false
      });
    }
  }

  return dirs;
}

export async function main(args = process.argv.slice(2), internal = {}) {
  const cfg = parseArgs(args, internal.homeDir || os.homedir());
  const { source, target, mode, dryRun, force, prefix } = cfg;

  // Resolve source directory
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(scriptDir, '..', '..');
  const srcRoot = source || repoRoot;

  console.log(`Deploying commands as Codex prompts (~/.codex/prompts/)`);
  console.log(`  Source: ${srcRoot}`);
  console.log(`  Target: ${target}`);
  console.log(`  Mode: ${mode}`);
  console.log(`  Prefix: ${prefix}`);
  if (dryRun) console.log(`  [DRY RUN]`);
  console.log();

  // Create target directory
  if (!dryRun) {
    ensureDir(target);
  }

  // Collect skill names to detect command/skill collisions
  const skillNames = new Set();
  const addonSkills = getAddonSkillDirs(srcRoot);
  for (const d of addonSkills) skillNames.add(path.basename(d));
  const frameworkSkills = collectFrameworkArtifacts(srcRoot, mode, {
    includeAgents: false, includeCommands: false, includeSkills: true, includeRules: false
  });
  for (const d of frameworkSkills.skills) skillNames.add(path.basename(d));

  // Get command directories based on mode
  const commandDirs = getCommandDirectories(srcRoot, mode);
  let totalDeployed = 0;
  let totalSkipped = 0;

  for (const { dir, label } of commandDirs) {
    const commandFiles = listCommandFiles(dir);
    if (commandFiles.length === 0) continue;

    console.log(`\n${label} (${commandFiles.length} prompts):`);

    for (const commandFile of commandFiles) {
      // Skip commands that collide with skills (skills take precedence)
      const commandName = path.basename(commandFile, '.md');
      if (skillNames.has(commandName)) {
        console.log(`  skip (skill precedence): command "${commandName}" — skill with same name takes precedence`);
        totalSkipped++;
        continue;
      }
      try {
        const prompt = transformToCodexPrompt(commandFile, prefix);
        const result = deployPrompt(prompt, target, { force, dryRun });
        if (result.action === 'deploy') totalDeployed++;
        else totalSkipped++;
      } catch (err) {
        console.log(`  error: ${path.basename(commandFile)} - ${err.message}`);
        totalSkipped++;
      }
    }
  }

  console.log(`\nSummary: ${totalDeployed} deployed, ${totalSkipped} skipped`);

  if (!dryRun && totalDeployed > 0) {
    console.log(`\nRestart Codex to load new prompts.`);
    console.log(`Use prompts with: /prompts:${prefix}-<command-name>`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
