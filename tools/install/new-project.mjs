#!/usr/bin/env node
/**
 * New Project Scaffolder
 *
 * Create a minimal project structure with intake templates, settings.json configuration,
 * and a README tailored to the AIWG framework. Intended to be invoked via
 * alias `aiwg-new` and run in the target project directory.
 *
 * Features:
 * - Copies SDLC intake templates
 * - Creates/updates .claude/settings.json with SDLC documentation access
 * - Optionally deploys agents
 * - Initializes git repository
 *
 * Usage:
 *   node tools/install/new-project.mjs [--name <project-name>] [--no-agents] [--provider <claude|openai>]
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { importImpl } from '../_resolve-impl.mjs';

const { boundedSpawnSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');
const { helperEnvironment, DEPLOYMENT_HELPER_ENV_ALLOWLIST } = await importImpl(import.meta.url, 'process/cli-command.mjs');
const { parseNewProjectArgs } = await importImpl(import.meta.url, 'cli/new-project-options.js');

function printHelp() {
  console.log(`aiwg new — Scaffold a new AIWG project

Usage:
  aiwg new [<project-name>] [options]

Arguments:
  <project-name>      Project name (defaults to current directory basename)

Options:
  --name <name>       Override project name explicitly
  --list-templates    List supported project templates without writing files
  --no-agents         Skip framework indexing and kernel deployment
  --copy, --copy-all  Opt in to provider copies
  --provider <p>      Target provider: claude | openai (default: claude)
  --help, -h          Show this help and exit (no side effects)

Examples:
  aiwg new my-project
  aiwg new . --provider openai
  aiwg new --list-templates
  aiwg new my-project --no-agents

Notes:
  Scaffolds .aiwg/intake/ templates, CLAUDE.md, AIWG.md, README.md, and
  initializes a git repo in the current directory. Run from an empty or
  fresh directory. A non-empty current directory requires an explicit . target.`);
}

function parseArgs() {
  try {
    const options = parseNewProjectArgs(process.argv.slice(2), process.cwd());
    if (options.mode === 'help') { printHelp(); process.exit(0); }
    if (options.mode === 'list') {
      console.log('Available project templates:\n  sdlc  SDLC project with project-intake, solution-profile, and option-matrix intake templates');
      process.exit(0);
    }
    return options;
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function copyFile(src, dest) {
  if (fs.existsSync(dest)) return false;
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return true;
}

/**
 * Detect AIWG installation path
 * Tries multiple strategies:
 * 1. Check if we're running from the installed location
 * 2. Check standard install location (~/.local/share/ai-writing-guide)
 * 3. Use repo root if running from source
 */
function detectAiwgPath(repoRoot) {
  // Standard install location
  const stdInstall = path.join(os.homedir(), '.local', 'share', 'ai-writing-guide');
  if (fs.existsSync(path.join(stdInstall, 'agentic', 'code', 'frameworks', 'sdlc-complete'))) {
    return stdInstall;
  }
  // Running from source
  if (fs.existsSync(path.join(repoRoot, 'agentic', 'code', 'frameworks', 'sdlc-complete'))) {
    return repoRoot;
  }
  // Fallback to repo root
  return repoRoot;
}

/**
 * Create or update .claude/settings.json with SDLC documentation access
 */
function createOrUpdateSettings(aiwgPath, provider) {
  const settingsDir = path.resolve(process.cwd(), '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');

  ensureDir(settingsDir);

  // SDLC documentation path
  const sdlcDocsPath = path.join(aiwgPath, 'agentic', 'code', 'frameworks', 'sdlc-complete');

  let settings = {};

  // Read existing settings if present
  if (fs.existsSync(settingsPath)) {
    try {
      const content = fs.readFileSync(settingsPath, 'utf8');
      settings = JSON.parse(content);
      console.log('Updating existing .claude/settings.json');
    } catch (e) {
      console.warn('Could not parse existing settings.json, creating new one');
      settings = {};
    }
  } else {
    console.log('Creating .claude/settings.json');
  }

  // Ensure permissions object exists
  if (!settings.permissions) {
    settings.permissions = {};
  }

  // Add SDLC documentation read access to allow list
  if (!settings.permissions.allow) {
    settings.permissions.allow = [];
  }

  // Add SDLC documentation path if not already present
  const sdlcReadPermission = `Read(${sdlcDocsPath}/**)`;
  if (!settings.permissions.allow.includes(sdlcReadPermission)) {
    settings.permissions.allow.push(sdlcReadPermission);
  }

  // Add current project read access (best practice)
  const projectReadPermission = `Read(${process.cwd()}/**)`;
  if (!settings.permissions.allow.includes(projectReadPermission)) {
    settings.permissions.allow.push(projectReadPermission);
  }

  // Add helpful default permissions for SDLC workflows
  const defaultPermissions = [
    'Bash(git:*)',           // Git operations
    'Bash(npm:*)',           // NPM operations
    'Bash(node:*)',          // Node operations
    'Write(./**)',           // Write to project files
    'Glob',                  // File pattern matching
    'Grep'                   // Content search
  ];

  for (const perm of defaultPermissions) {
    if (!settings.permissions.allow.includes(perm)) {
      settings.permissions.allow.push(perm);
    }
  }

  // Add recommended denials for security
  if (!settings.permissions.deny) {
    settings.permissions.deny = [];
  }

  const defaultDenials = [
    'Read(./.env)',
    'Read(./secrets/**)',
    'Read(./**/.env)',
    'Bash(rm:-rf)',
    'Bash(curl:*)',
    'WebFetch'
  ];

  for (const deny of defaultDenials) {
    if (!settings.permissions.deny.includes(deny)) {
      settings.permissions.deny.push(deny);
    }
  }

  // Write updated settings
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

  return settingsPath;
}

(async function main() {
  const { name, withAgents, provider, copy } = parseArgs();
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(scriptDir, '..', '..');

  // Detect AIWG installation path
  const aiwgPath = detectAiwgPath(repoRoot);
  console.log(`Using AIWG installation at: ${aiwgPath}`);

  // Create/update .claude/settings.json with SDLC documentation access
  const settingsPath = createOrUpdateSettings(aiwgPath, provider);
  console.log(`Settings configured: ${settingsPath}`);

  const intakeSrc = path.join(aiwgPath, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'templates', 'intake');
  const destIntake = path.resolve(process.cwd(), '.aiwg', 'intake');
  ensureDir(destIntake);

  const mapping = [
    { src: 'project-intake-template.md', dest: 'project-intake.md' },
    { src: 'solution-profile-template.md', dest: 'solution-profile.md' },
    { src: 'option-matrix-template.md', dest: 'option-matrix.md' }
  ];
  let created = 0;
  for (const m of mapping) {
    const s = path.join(intakeSrc, m.src);
    const d = path.join(destIntake, m.dest);
    if (fs.existsSync(s)) {
      if (copyFile(s, d)) {
        console.log(`created ${path.relative(process.cwd(), d)}`);
        created++;
      } else {
        console.log(`exists  ${path.relative(process.cwd(), d)}`);
      }
    }
  }

  // Copy CLAUDE.md template with AIWG_ROOT substitution
  const claudeMdTemplate = path.join(aiwgPath, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'templates', 'project', 'CLAUDE.md');
  const claudeMdDest = path.resolve(process.cwd(), 'CLAUDE.md');
  if (fs.existsSync(claudeMdTemplate) && !fs.existsSync(claudeMdDest)) {
    let claudeMdContent = fs.readFileSync(claudeMdTemplate, 'utf8');
    // Replace {AIWG_ROOT} placeholder with actual path
    claudeMdContent = claudeMdContent.replace(/\{AIWG_ROOT\}/g, aiwgPath);
    fs.writeFileSync(claudeMdDest, claudeMdContent, 'utf8');
    console.log(`created CLAUDE.md`);
  } else if (fs.existsSync(claudeMdDest)) {
    console.log(`exists  CLAUDE.md`);
  }

  // Copy AIWG.md hook file (generated content loaded by @AIWG.md directive in CLAUDE.md)
  const aiwgMdTemplate = path.join(aiwgPath, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'templates', 'project', 'AIWG.md');
  const aiwgMdDest = path.resolve(process.cwd(), 'AIWG.md');
  if (fs.existsSync(aiwgMdTemplate)) {
    fs.writeFileSync(aiwgMdDest, fs.readFileSync(aiwgMdTemplate, 'utf8'), 'utf8');
    console.log(`created AIWG.md`);
  }

  // Copy SECURITY.md template for private vulnerability disclosure.
  const securityTemplate = path.join(aiwgPath, 'agentic', 'code', 'frameworks', 'security-engineering', 'templates', 'SECURITY.md');
  const securityDest = path.resolve(process.cwd(), 'SECURITY.md');
  if (fs.existsSync(securityTemplate) && !fs.existsSync(securityDest)) {
    fs.copyFileSync(securityTemplate, securityDest);
    console.log(`created SECURITY.md`);
  } else if (fs.existsSync(securityDest)) {
    console.log(`exists  SECURITY.md`);
  }

  const readmePath = path.resolve(process.cwd(), 'README.md');
  if (!fs.existsSync(readmePath)) {
    const readme = `# ${name}\n\n` +
      `This project uses the AIWG SDLC Complete framework.\n\n` +
      `## Getting Started\n\n` +
      `### 1. Fill Intake Forms\n\n` +
      `Start by completing the intake forms in the \`.aiwg/intake/\` directory:\n\n` +
      `- \`.aiwg/intake/project-intake.md\` - Project overview, stakeholders, constraints\n` +
      `- \`.aiwg/intake/solution-profile.md\` - Technical requirements, architecture preferences\n` +
      `- \`.aiwg/intake/option-matrix.md\` - Solution alternatives and evaluation criteria\n\n` +
      `### 2. Skills and Provider Adapters\n\n` +
      `Canonical SDLC skills are discovered through the AIWG kernel/index surface. Provider-specific commands, when deployed, are compatibility adapters rather than workflow definitions.\n\n` +
      `### 3. Start SDLC Flow\n\n` +
      `Once intake forms are complete, kick off the Concept → Inception flow:\n\n` +
      '```bash\n# Find and inspect the canonical workflow\naiwg discover "SDLC concept to inception"\naiwg show skill flow-concept-to-inception\n\n# Find project intake guidance\naiwg discover "create or complete project intake"\n```\n\n' +
      `### 4. SDLC Framework Documentation\n\n` +
      `Supported providers can discover the complete SDLC framework documentation at:\n\n` +
      `\`${aiwgPath}/agentic/code/frameworks/sdlc-complete/\`\n\n` +
      `This includes templates, flows, add-ons, and artifacts for all SDLC phases.\n\n` +
      `## Framework Components\n\n` +
      `- **Agents** (51): Specialized SDLC role agents (Requirements Analyst, Security Gatekeeper, etc.)\n` +
      `- **Skills**: Canonical flow orchestration and workflow contracts\n` +
      `- **Provider adapters**: Optional generated command/invocation surfaces\n` +
      `- **Templates**: Intake, requirements, architecture, test, security, deployment\n` +
      `- **Flows**: Phase-based workflows (Inception → Elaboration → Construction → Transition)\n` +
      `- **Add-ons**: GDPR compliance, legal frameworks\n\n` +
      `## Key Skills\n\n` +
      `Use \`aiwg discover "<need>"\` and \`aiwg show skill <name>\` to select current behavior. Common canonical skills include \`flow-concept-to-inception\`, \`flow-discovery-track\`, \`flow-delivery-track\`, \`flow-iteration-dual-track\`, \`flow-gate-check\`, and \`flow-handoff-checklist\`.\n\n` +
      `For more information, see the [SDLC Complete Framework documentation](${aiwgPath}/agentic/code/frameworks/sdlc-complete/README.md).\n`;
    fs.writeFileSync(readmePath, readme, 'utf8');
    console.log(`created README.md`);
  }

  // Share the use policy, receipt and discovery index rather than a second deploy path.
  if (withAgents) {
    const cliPath = path.join(aiwgPath, 'bin', 'aiwg.mjs');
    const deployEnv = { ...helperEnvironment(process.env, DEPLOYMENT_HELPER_ENV_ALLOWLIST), HOME: os.homedir(), USERPROFILE: os.homedir(), AIWG_ROOT: aiwgPath };
    const deployArgs = [cliPath, 'use', 'sdlc', '--provider', provider, '--no-utils', '--yes', ...(copy ? ['--copy-all'] : [])];
    const deployed = boundedSpawnSync(process.execPath, deployArgs, 'long', { stdio: 'inherit', env: deployEnv });
    if (deployed.error || deployed.status !== 0) {
      if (deployed.error) console.warn(deployed.error.message);
      console.warn('Framework indexing/deployment failed');
      process.exitCode = 1;
    }
  }

  // Initialize git repository if not present
  if (!fs.existsSync(path.resolve(process.cwd(), '.git'))) {
    try {
      let r = boundedSpawnSync('git', ['init', '-b', 'main'], 'quick', { stdio: 'inherit' });
      if (r.error || r.status !== 0) {
        // fallback for older git
        boundedSpawnSync('git', ['init'], 'quick', { stdio: 'inherit' });
        boundedSpawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], 'quick', { stdio: 'inherit' });
      }
      const gi = path.resolve(process.cwd(), '.gitignore');
      if (!fs.existsSync(gi)) {
        const gitignore = [
          'node_modules/',
          'dist/',
          'build/',
          '.env',
          '.DS_Store',
          'coverage/',
          '.idea/',
          '.vscode/',
          '',
          '# Claude Code local session state',
          '.claude/settings.local.json',
          '',
          '# AIWG — ignore only high-churn runtime subdirs, NOT .aiwg/ itself',
          '.aiwg/working/',
          '.aiwg/ralph/',
          '.aiwg/ralph-external/',
          '.aiwg/security-engineering/reviews/disclosures/',
        ].join('\n') + '\n';
        fs.writeFileSync(gi, gitignore, 'utf8');
        console.log('created .gitignore');
      } else {
        // Existing .gitignore: append missing AIWG runtime patterns
        const existing = fs.readFileSync(gi, 'utf8');
        const lines = existing.split('\n').map(l => l.trim());
        const RUNTIME = ['.aiwg/working/', '.aiwg/ralph/', '.aiwg/ralph-external/', '.aiwg/security-engineering/reviews/disclosures/'];
        const isCovered = (p) => lines.includes(p) || lines.includes(p.replace(/\/$/, ''));
        const missing = RUNTIME.filter(p => !isCovered(p));
        if (missing.length > 0) {
          const block = '\n# AIWG — ignore only high-churn runtime subdirs, NOT .aiwg/ itself\n' + missing.join('\n') + '\n';
          fs.writeFileSync(gi, existing.endsWith('\n') ? existing + block : existing + '\n' + block, 'utf8');
          console.log('updated .gitignore with AIWG runtime entries');
        }
      }
      console.log('Initialized git repository on branch main.');
      console.log('Next steps:');
      console.log('  1. Fill intake forms: .aiwg/intake/project-intake.md, .aiwg/intake/solution-profile.md, .aiwg/intake/option-matrix.md');
      console.log('  2. Start SDLC flow: /flow-concept-to-inception .');
      console.log('  3. Commit: git add . && git commit -m "chore: initial scaffold"');
    } catch (e) {
      console.warn('git initialization skipped or failed:', e.message);
    }
  }

  console.log('\n=== Scaffold Complete ===');
  console.log(`Project: ${name}`);
  console.log(`Provider: ${provider}`);
  console.log(`Intake templates: ${created} files created in .aiwg/intake/`);
  console.log(`Settings: .claude/settings.json configured with SDLC documentation access`);
  console.log(`SDLC Framework: ${aiwgPath}/agentic/code/frameworks/sdlc-complete/`);
  if (withAgents) {
    console.log(`SDLC indexed; find capabilities with aiwg discover. Use aiwg use sdlc --copy for provider copies.`);
  }
  console.log('\nReady to start! Fill intake forms and run: aiwg discover "concept to inception"');
})();
