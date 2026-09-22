#!/usr/bin/env node
/**
 * Deploy Agents for Windsurf
 *
 * Windsurf differs from other providers:
 * - Uses aggregated AGENTS.md (not individual agent files)
 * - Uses .windsurfrules for orchestration context
 * - Commands become workflows in .windsurf/workflows/
 * - Skills deploy natively to .windsurf/skills/{name}/SKILL.md (one-level subdirs, native since v1.13.6)
 * - Plain markdown format (no YAML frontmatter)
 *
 * Usage:
 *   node tools/agents/deploy-windsurf.mjs [options]
 *
 * Options:
 *   --source <path>          Source directory (defaults to repo root)
 *   --target <path>          Target directory (defaults to cwd)
 *   --mode <type>            Deployment mode: general, sdlc, marketing, or all (default)
 *   --deploy-commands        Deploy commands as workflows
 *   --deploy-skills          Deploy skills to .windsurf/skills/
 *   --dry-run                Show what would be deployed without writing
 *   --force                  Overwrite existing files
 *   --reasoning-model <name> Override model for reasoning tasks
 *   --coding-model <name>    Override model for coding tasks
 *   --efficiency-model <name> Override model for efficiency tasks
 *
 * Output Structure:
 *   project/
 *   ├── AGENTS.md              # Aggregated agent definitions
 *   ├── .windsurfrules         # Orchestration context + key agents
 *   └── .windsurf/
 *       ├── workflows/         # Commands as workflows (if --deploy-commands)
 *       └── skills/            # Native skill files (if --deploy-skills)
 *           └── {name}/
 *               └── SKILL.md
 */

import realFs from 'fs';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
let fs;
try { const gfs = _require('graceful-fs'); gfs.gracefulify(realFs); fs = realFs; } catch { fs = realFs; }
import path from 'path';

// ============================================================================
// CONFIGURATION
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const cfg = {
    source: null,
    target: process.cwd(),
    mode: 'all',
    dryRun: false,
    force: false,
    reasoningModel: null,
    codingModel: null,
    efficiencyModel: null,
    deployCommands: false,
    deploySkills: false
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source' && args[i + 1]) cfg.source = path.resolve(args[++i]);
    else if (a === '--target' && args[i + 1]) cfg.target = path.resolve(args[++i]);
    else if (a === '--mode' && args[i + 1]) cfg.mode = String(args[++i]).toLowerCase();
    else if (a === '--dry-run') cfg.dryRun = true;
    else if (a === '--force') cfg.force = true;
    else if (a === '--reasoning-model' && args[i + 1]) cfg.reasoningModel = args[++i];
    else if (a === '--coding-model' && args[i + 1]) cfg.codingModel = args[++i];
    else if (a === '--efficiency-model' && args[i + 1]) cfg.efficiencyModel = args[++i];
    else if (a === '--deploy-commands') cfg.deployCommands = true;
    else if (a === '--deploy-skills') cfg.deploySkills = true;
  }

  return cfg;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function listMdFiles(dir, excludePatterns = []) {
  if (!fs.existsSync(dir)) return [];
  const defaultExcluded = [
    'README.md',
    'manifest.md',
    'agent-template.md',
    'openai-compat.md',
    'factory-compat.md',
    'windsurf-compat.md',
    'DEVELOPMENT_GUIDE.md'
  ];
  const excluded = [...defaultExcluded, ...excludePatterns];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && !excluded.includes(e.name))
    .map((e) => path.join(dir, e.name));
}

function listMdFilesRecursive(dir, excludePatterns = []) {
  if (!fs.existsSync(dir)) return [];
  const defaultExcluded = [
    'README.md',
    'manifest.md',
    'agent-template.md',
    'openai-compat.md',
    'factory-compat.md',
    'windsurf-compat.md',
    'DEVELOPMENT_GUIDE.md'
  ];
  const excluded = [...defaultExcluded, ...excludePatterns];
  const results = [];

  function scan(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory() && entry.name !== 'templates') {
        scan(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && !excluded.includes(entry.name)) {
        results.push(fullPath);
      }
    }
  }

  scan(dir);
  return results;
}

function listSkillDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => path.join(dir, e.name));
}

/**
 * Load model configuration from models.json
 */
function loadModelConfig(srcRoot) {
  const locations = [
    { path: path.join(process.cwd(), 'models.json'), label: 'project' },
    { path: path.join(process.env.HOME || process.env.USERPROFILE, '.config', 'aiwg', 'models.json'), label: 'user' },
    { path: path.join(srcRoot, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'config', 'models.json'), label: 'AIWG defaults' }
  ];

  for (const loc of locations) {
    if (fs.existsSync(loc.path)) {
      try {
        const config = JSON.parse(fs.readFileSync(loc.path, 'utf8'));
        config._source = `${loc.label} (${loc.path})`;
        return config;
      } catch (err) {
        console.warn(`Warning: Could not parse models.json at ${loc.path}: ${err.message}`);
      }
    }
  }

  // Fallback to hardcoded defaults
  return {
    windsurf: {
      reasoning: { model: 'claude-opus-5' },
      coding: { model: 'claude-sonnet-5' },
      efficiency: { model: 'claude-haiku-4-5' }
    },
    shorthand: {
      opus: 'claude-opus-5',
      sonnet: 'claude-sonnet-5',
      haiku: 'claude-haiku-4-5'
    },
    _source: 'built-in defaults'
  };
}

// ============================================================================
// WINDSURF TRANSFORMATION FUNCTIONS
// ============================================================================

/**
 * Display Windsurf deployment info banner
 */
function displayWindsurfBanner() {
  console.log('\nWindsurf provider — skill support native since v1.13.6');
  console.log('Issues: https://github.com/jmagly/aiwg/issues\n');
}

/**
 * Transform agent content to Windsurf format (plain markdown, no YAML frontmatter)
 */
function transformToWindsurfAgent(content, modelCfg) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return content;

  const [, frontmatter, body] = fmMatch;

  // Extract metadata
  const name = frontmatter.match(/name:\s*(.+)/)?.[1]?.trim();
  const description = frontmatter.match(/description:\s*(.+)/)?.[1]?.trim();
  const toolsMatch = frontmatter.match(/tools:\s*(.+)/)?.[1]?.trim();
  const modelMatch = frontmatter.match(/model:\s*(.+)/)?.[1]?.trim();

  // Map model to full name
  const model = mapModelToWindsurf(modelMatch, modelCfg);

  // Build Windsurf-compatible format (plain markdown, no YAML)
  const lines = [];
  lines.push(`### ${name}`);
  lines.push('');

  if (description) {
    lines.push(`> ${description}`);
    lines.push('');
  }

  // Parse and include tools as capabilities
  if (toolsMatch) {
    let tools = [];
    if (toolsMatch.startsWith('[')) {
      try {
        tools = JSON.parse(toolsMatch);
      } catch {
        tools = toolsMatch.replace(/[\[\]"']/g, '').split(/[,\s]+/).filter(Boolean);
      }
    } else {
      tools = toolsMatch.split(/[,\s]+/).filter(Boolean);
    }

    if (tools.length > 0) {
      lines.push('<capabilities>');
      tools.forEach(t => lines.push(`- ${t.trim()}`));
      lines.push('</capabilities>');
      lines.push('');
    }
  }

  if (model) {
    lines.push(`**Model**: ${model}`);
    lines.push('');
  }

  lines.push(body.trim());
  return lines.join('\n');
}

/**
 * Map shorthand model names to Windsurf model identifiers
 */
function mapModelToWindsurf(modelName, modelCfg) {
  if (!modelName) return null;

  const clean = modelName.toLowerCase().replace(/['"]/g, '');

  // Use shorthand mapping if available
  if (modelCfg?.shorthand?.[clean]) {
    return modelCfg.shorthand[clean];
  }

  // Use windsurf-specific mapping if available
  if (modelCfg?.windsurf) {
    if (clean === 'opus' || clean.includes('opus')) return modelCfg.windsurf.reasoning?.model;
    if (clean === 'haiku' || clean.includes('haiku')) return modelCfg.windsurf.efficiency?.model;
    if (clean === 'sonnet' || clean.includes('sonnet')) return modelCfg.windsurf.coding?.model;
  }

  // Return as-is if no mapping found
  return modelName;
}

/**
 * Transform command content to Windsurf workflow format
 * @param {string} content - The command file content
 * @param {string} filename - The original filename (used for fallback name)
 */
function transformToWindsurfWorkflow(content, filename) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return { content, name: filename || 'Workflow' };

  const [, frontmatter, body] = fmMatch;

  // Try to get name from frontmatter, then from first heading, then from filename
  const nameMatch = frontmatter.match(/name:\s*(.+)/);
  const descMatch = frontmatter.match(/description:\s*(.+)/);
  const headingMatch = body.match(/^#\s+(.+)$/m);

  let name;
  if (nameMatch) {
    name = nameMatch[1].trim();
  } else if (headingMatch) {
    name = headingMatch[1].trim();
  } else if (filename) {
    // Convert filename to readable name
    name = filename.replace(/\.md$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  } else {
    name = 'Workflow';
  }

  const description = descMatch ? descMatch[1].trim() : '';

  // Build workflow format (Windsurf has 12,000 char limit per workflow)
  const lines = [];
  lines.push(`# ${name}`);
  lines.push('');

  if (description) {
    lines.push(`> ${description}`);
    lines.push('');
  }

  lines.push('## Instructions');
  lines.push('');
  lines.push(body.trim());

  const output = lines.join('\n');

  // Warn if exceeding character limit
  if (output.length > 12000) {
    console.warn(`  [WARNING] Workflow "${name}" exceeds 12,000 character limit (${output.length} chars)`);
  }

  return { content: output, name };
}

// ============================================================================
// GENERATION FUNCTIONS
// ============================================================================

/**
 * Generate AGENTS.md for Windsurf with all agents aggregated
 */
function generateAgentsMd(files, destPath, opts, modelCfg) {
  const { dryRun } = opts;

  const lines = [];
  lines.push('# AGENTS.md');
  lines.push('');
  lines.push('> AIWG Agent Directory for Windsurf');
  lines.push('');
  lines.push('<!--');
  lines.push('  Generated by AIWG for Windsurf');
  lines.push('  Windsurf reads this file for directory-scoped AI instructions.');
  lines.push('  See: https://docs.windsurf.com/windsurf/cascade/agents-md');
  lines.push('-->');
  lines.push('');
  lines.push('## Table of Contents');
  lines.push('');

  // Build TOC and collect agents
  const agents = [];
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const name = nameMatch ? nameMatch[1].trim() : path.basename(f, '.md');
    agents.push({ name, file: f, content });
    const anchor = name.replace(/\s+/g, '-').toLowerCase();
    lines.push(`- [${name}](#${anchor})`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Add each agent
  for (const agent of agents) {
    const transformed = transformToWindsurfAgent(agent.content, modelCfg);
    lines.push(transformed);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  const output = lines.join('\n');

  if (dryRun) {
    console.log(`[dry-run] Would write AGENTS.md with ${agents.length} agents`);
  } else {
    fs.writeFileSync(destPath, output, 'utf8');
    console.log(`Created AGENTS.md with ${agents.length} agents`);
  }

  return agents.length;
}

/**
 * Generate .windsurfrules with orchestration context and key agents
 */
function generateWindsurfRules(srcRoot, target, opts, agentCount, commandCount, skillCount) {
  const { dryRun, mode } = opts;

  const lines = [];
  lines.push('# AIWG Rules for Windsurf');
  lines.push('');
  lines.push('<!--');
  lines.push('  Generated by AIWG for Windsurf');
  lines.push('  This file provides orchestration context for AIWG workflows.');
  lines.push('-->');
  lines.push('');

  // Orchestration section
  lines.push('<orchestration>');

  if (mode === 'sdlc' || mode === 'all' || mode === 'both') {
    lines.push('## AIWG SDLC Framework');
    lines.push('');
    lines.push(`**${agentCount} agents** | **${commandCount}+ commands** | **${skillCount} skills**`);
    lines.push('');
    lines.push('### Natural Language Commands');
    lines.push('');
    lines.push('**Phase Transitions:**');
    lines.push('- "transition to elaboration" | "move to elaboration" | "start elaboration"');
    lines.push('- "ready to deploy" | "begin construction" | "start transition"');
    lines.push('');
    lines.push('**Workflow Requests:**');
    lines.push('- "run iteration {N}" | "start iteration {N}"');
    lines.push('- "deploy to production" | "start deployment"');
    lines.push('');
    lines.push('**Review Cycles:**');
    lines.push('- "security review" | "run security" | "validate security"');
    lines.push('- "run tests" | "execute tests" | "test suite"');
    lines.push('');
    lines.push('**Status Checks:**');
    lines.push('- "where are we" | "what\'s next" | "project status"');
  } else if (mode === 'marketing') {
    lines.push('## AIWG Marketing Framework');
    lines.push('');
    lines.push(`**${agentCount} agents** | Marketing campaign lifecycle`);
    lines.push('');
    lines.push('### Natural Language Commands');
    lines.push('');
    lines.push('- "create campaign" | "plan campaign"');
    lines.push('- "generate content" | "write copy"');
    lines.push('- "analyze metrics" | "campaign performance"');
  } else {
    lines.push('## AIWG Writing Framework');
    lines.push('');
    lines.push(`**${agentCount} agents** | Voice profiles and writing validation`);
    lines.push('');
    lines.push('### Natural Language Commands');
    lines.push('');
    lines.push('- "validate writing" | "check voice"');
    lines.push('- "apply voice profile" | "use technical-authority"');
  }

  lines.push('</orchestration>');
  lines.push('');

  // Key agents section
  lines.push('<agents>');
  lines.push('## Key Agents');
  lines.push('');
  lines.push('For the full catalog of agents, see @AGENTS.md');
  lines.push('');

  if (mode === 'sdlc' || mode === 'all' || mode === 'both') {
    lines.push('### Executive Orchestrator');
    lines.push('**Role**: Coordinate multi-agent workflows and phase transitions.');
    lines.push('**Use**: Phase transitions, complex multi-deliverable workflows.');
    lines.push('');
    lines.push('### Requirements Analyst');
    lines.push('**Role**: Analyze requirements, create use cases and user stories.');
    lines.push('**Use**: "analyze requirements", "create use case for {feature}"');
    lines.push('');
    lines.push('### Architecture Designer');
    lines.push('**Role**: Design system architecture, create ADRs, select technology stacks.');
    lines.push('**Use**: "design architecture", "create SAD", "write ADR for {decision}"');
    lines.push('');
    lines.push('### Security Architect');
    lines.push('**Role**: Lead threat modeling, security requirements, and gates.');
    lines.push('**Use**: "security review", "threat model", "security gate"');
    lines.push('');
    lines.push('### Test Architect');
    lines.push('**Role**: Define test strategy, coverage requirements, automation approach.');
    lines.push('**Use**: "test strategy", "define test plan", "coverage analysis"');
    lines.push('');
    lines.push('### Technical Writer');
    lines.push('**Role**: Create and maintain documentation with voice consistency.');
    lines.push('**Use**: "document {feature}", "update README", "API docs"');
  } else if (mode === 'marketing') {
    lines.push('### Campaign Strategist');
    lines.push('**Role**: Plan and coordinate marketing campaigns.');
    lines.push('');
    lines.push('### Content Creator');
    lines.push('**Role**: Generate marketing copy and content.');
    lines.push('');
    lines.push('### Analytics Specialist');
    lines.push('**Role**: Analyze campaign performance and metrics.');
  } else {
    lines.push('### Writing Validator');
    lines.push('**Role**: Validate content for voice consistency and authenticity.');
    lines.push('');
    lines.push('### Prompt Optimizer');
    lines.push('**Role**: Enhance prompts for better AI output quality.');
    lines.push('');
    lines.push('### Content Diversifier');
    lines.push('**Role**: Generate varied examples and perspectives.');
  }

  lines.push('</agents>');
  lines.push('');

  // Artifacts section
  lines.push('<artifacts>');
  lines.push('## Project Artifacts');
  lines.push('');
  if (mode === 'sdlc' || mode === 'all' || mode === 'both') {
    lines.push('All SDLC artifacts stored in `.aiwg/`:');
    lines.push('- `intake/` - Project intake forms');
    lines.push('- `requirements/` - User stories, use cases');
    lines.push('- `architecture/` - SAD, ADRs');
    lines.push('- `testing/` - Test strategy, plans');
    lines.push('- `security/` - Threat models');
    lines.push('- `deployment/` - Deployment plans');
  } else {
    lines.push('Content artifacts stored in project directories.');
  }
  lines.push('</artifacts>');
  lines.push('');

  // References section
  lines.push('<references>');
  lines.push('## Full Documentation');
  lines.push('');
  lines.push('- **All Agents**: @AGENTS.md');
  lines.push('- **Templates**: @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/templates/');
  lines.push('- **Commands**: @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/commands/');
  lines.push('- **Repository**: https://github.com/jmagly/aiwg');
  lines.push('</references>');

  const output = lines.join('\n');
  const destPath = path.join(target, '.windsurfrules');

  if (dryRun) {
    console.log(`[dry-run] Would write .windsurfrules`);
  } else {
    fs.writeFileSync(destPath, output, 'utf8');
    console.log(`Created .windsurfrules`);
  }
}

/**
 * Deploy workflows (commands) to .windsurf/workflows/
 */
function deployWorkflows(files, destDir, opts) {
  const { dryRun, force } = opts;

  if (!dryRun) ensureDir(destDir);

  let deployed = 0;
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    const baseName = path.basename(f, '.md');
    const { content: transformed, name: workflowName } = transformToWindsurfWorkflow(content, baseName);
    const destFile = path.join(destDir, `${baseName}.md`);

    if (fs.existsSync(destFile) && !force) {
      console.log(`  [skip] ${baseName}.md (exists)`);
      continue;
    }

    if (dryRun) {
      console.log(`  [dry-run] ${baseName}.md`);
    } else {
      fs.writeFileSync(destFile, transformed, 'utf8');
      console.log(`  [deployed] ${baseName}.md`);
    }
    deployed++;
  }

  return deployed;
}

// ============================================================================
// MAIN DEPLOYMENT LOGIC
// ============================================================================

async function main() {
  const cfg = parseArgs();
  const { source, target, mode, dryRun, deployCommands, deploySkills, reasoningModel, codingModel, efficiencyModel } = cfg;

  // Display Windsurf info banner
  displayWindsurfBanner();

  // Resolve source root (this repository)
  const srcRoot = source || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

  // Load model configuration
  const modelsConfig = loadModelConfig(srcRoot);
  console.log(`Model configuration loaded from: ${modelsConfig._source}`);

  // Apply CLI model overrides
  const modelCfg = {
    ...modelsConfig,
    windsurf: {
      reasoning: { model: reasoningModel || modelsConfig.windsurf?.reasoning?.model },
      coding: { model: codingModel || modelsConfig.windsurf?.coding?.model },
      efficiency: { model: efficiencyModel || modelsConfig.windsurf?.efficiency?.model }
    }
  };

  console.log(`\nDeploying to Windsurf (mode=${mode})${dryRun ? ' [DRY RUN]' : ''}`);
  console.log(`Target: ${target}`);
  console.log('');

  // Collect agent files based on mode
  const agentFiles = [];

  // All addons (dynamically discovered)
  if (mode === 'general' || mode === 'writing' || mode === 'sdlc' || mode === 'both' || mode === 'all') {
    const addonsRoot = path.join(srcRoot, 'agentic', 'code', 'addons');
    if (fs.existsSync(addonsRoot)) {
      let addonAgentCount = 0;
      const addonDirs = fs.readdirSync(addonsRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(addonsRoot, e.name, 'agents'));

      for (const addonAgentsDir of addonDirs) {
        if (fs.existsSync(addonAgentsDir)) {
          const files = listMdFiles(addonAgentsDir);
          agentFiles.push(...files);
          addonAgentCount += files.length;
        }
      }
      if (addonAgentCount > 0) {
        console.log(`Found ${addonAgentCount} addon agents`);
      }
    }
  }

  // SDLC agents
  if (mode === 'sdlc' || mode === 'both' || mode === 'all') {
    const sdlcAgentsRoot = path.join(srcRoot, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'agents');
    if (fs.existsSync(sdlcAgentsRoot)) {
      const files = listMdFiles(sdlcAgentsRoot);
      if (files.length > 0) {
        console.log(`Found ${files.length} SDLC agents`);
        agentFiles.push(...files);
      }
    }
  }

  // Marketing agents
  if (mode === 'marketing' || mode === 'all') {
    const marketingAgentsRoot = path.join(srcRoot, 'agentic', 'code', 'frameworks', 'media-marketing-kit', 'agents');
    if (fs.existsSync(marketingAgentsRoot)) {
      const files = listMdFiles(marketingAgentsRoot);
      if (files.length > 0) {
        console.log(`Found ${files.length} marketing agents`);
        agentFiles.push(...files);
      }
    }
  }

  // Generate aggregated AGENTS.md
  if (agentFiles.length > 0) {
    console.log(`\nGenerating aggregated AGENTS.md with ${agentFiles.length} agents...`);
    const agentsMdPath = path.join(target, 'AGENTS.md');
    generateAgentsMd(agentFiles, agentsMdPath, cfg, modelCfg);
  } else {
    console.log('\nNo agents found to deploy');
  }

  // Collect and deploy commands as workflows
  let commandCount = 0;
  if (deployCommands) {
    const commandFiles = [];

    // General commands
    if (mode === 'general' || mode === 'both' || mode === 'all') {
      const generalCommandsRoot = path.join(srcRoot, 'commands');
      if (fs.existsSync(generalCommandsRoot)) {
        commandFiles.push(...listMdFilesRecursive(generalCommandsRoot));
      }
    }

    // SDLC commands
    if (mode === 'sdlc' || mode === 'both' || mode === 'all') {
      const sdlcCommandsRoot = path.join(srcRoot, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'commands');
      if (fs.existsSync(sdlcCommandsRoot)) {
        commandFiles.push(...listMdFilesRecursive(sdlcCommandsRoot));
      }
    }

    // Marketing commands
    if (mode === 'marketing' || mode === 'all') {
      const marketingCommandsRoot = path.join(srcRoot, 'agentic', 'code', 'frameworks', 'media-marketing-kit', 'commands');
      if (fs.existsSync(marketingCommandsRoot)) {
        commandFiles.push(...listMdFilesRecursive(marketingCommandsRoot));
      }
    }

    if (commandFiles.length > 0) {
      const workflowsDir = path.join(target, '.windsurf', 'workflows');
      console.log(`\nDeploying ${commandFiles.length} commands as workflows to .windsurf/workflows/`);
      commandCount = deployWorkflows(commandFiles, workflowsDir, cfg);
    }
  }

  // Deploy skills natively to .windsurf/skills/{name}/SKILL.md
  // Windsurf supports one-level subdirectory discovery (native since v1.13.6)
  let skillCount = 0;
  if (deploySkills) {
    const skillsDestDir = path.join(target, '.windsurf', 'skills');
    const skillDirs = [];

    // Addon skills (dynamically discovered)
    const addonsRoot = path.join(srcRoot, 'agentic', 'code', 'addons');
    if (fs.existsSync(addonsRoot)) {
      const addonDirs = fs.readdirSync(addonsRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(addonsRoot, e.name, 'skills'));

      for (const addonSkillsDir of addonDirs) {
        if (fs.existsSync(addonSkillsDir)) {
          skillDirs.push(...listSkillDirs(addonSkillsDir));
        }
      }
    }

    // SDLC skills
    if (mode === 'sdlc' || mode === 'both' || mode === 'all') {
      const sdlcSkillsRoot = path.join(srcRoot, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'skills');
      if (fs.existsSync(sdlcSkillsRoot)) {
        skillDirs.push(...listSkillDirs(sdlcSkillsRoot));
      }
    }

    if (skillDirs.length > 0) {
      console.log(`\nDeploying ${skillDirs.length} skills to .windsurf/skills/`);
      if (!dryRun) ensureDir(skillsDestDir);

      for (const skillDir of skillDirs) {
        const skillName = path.basename(skillDir);
        const srcSkillFile = path.join(skillDir, 'SKILL.md');
        const destSkillDir = path.join(skillsDestDir, skillName);
        const destSkillFile = path.join(destSkillDir, 'SKILL.md');

        if (fs.existsSync(destSkillFile) && !cfg.force) {
          console.log(`  [skip] ${skillName}/SKILL.md (exists)`);
          continue;
        }

        if (dryRun) {
          console.log(`  [dry-run] ${skillName}/SKILL.md`);
        } else {
          ensureDir(destSkillDir);
          fs.copyFileSync(srcSkillFile, destSkillFile);
          console.log(`  [deployed] ${skillName}/SKILL.md`);
        }
        skillCount++;
      }
    }
  }

  // Generate .windsurfrules
  console.log('\nGenerating .windsurfrules...');
  generateWindsurfRules(srcRoot, target, cfg, agentFiles.length, commandCount, skillCount);

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('Windsurf Deployment Summary');
  console.log('='.repeat(50));
  console.log(`Agents:    ${agentFiles.length} → AGENTS.md`);
  if (deployCommands) {
    console.log(`Workflows: ${commandCount} → .windsurf/workflows/`);
  }
  if (deploySkills) {
    console.log(`Skills:    ${skillCount} → .windsurf/skills/`);
  }
  console.log(`Rules:     .windsurfrules`);
  console.log('');
  console.log('Generated structure:');
  console.log('  AGENTS.md');
  console.log('  .windsurfrules');
  if (deployCommands && commandCount > 0) {
    console.log('  .windsurf/workflows/*.md');
  }
  if (deploySkills && skillCount > 0) {
    console.log('  .windsurf/skills/{name}/SKILL.md');
  }

  if (dryRun) {
    console.log('\n[DRY RUN] No files were written.');
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
