// Shared provider behaviors utilities.
import { fs, path } from './base-runtime.mjs';
import { parseFrontmatter } from './base-frontmatter.mjs';
import { addManagedMarker, ensureDir, writeFile } from './base-files.mjs';
import { getAddonAgentFiles, getAddonCommandFiles, getAddonSkillDirs } from './base-addon-discovery.mjs';
import { getAddonRuleFiles } from './base-rule-index.mjs';


/**
 * List behavior directories (directories containing BEHAVIOR.md).
 */
export function listBehaviorDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'BEHAVIOR.md')))
    .map((entry) => path.join(dir, entry.name));
}


/**
 * Collect behavior directories from all supported source shapes:
 * - direct component source: <srcRoot>/behaviors/
 * - cross-framework: agentic/code/behaviors/
 * - per-addon: agentic/code/addons/<name>/behaviors/
 * - per-framework: agentic/code/frameworks/<name>/behaviors/
 */
export function collectBehaviorDirs(srcRoot) {
  const dirs = [];
  const seen = new Set();
  const addDirs = (items) => {
    for (const dir of items) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      dirs.push(dir);
    }
  };

  addDirs(listBehaviorDirs(path.join(srcRoot, 'behaviors')));
  addDirs(listBehaviorDirs(path.join(srcRoot, 'agentic', 'code', 'behaviors')));

  const addonsDir = path.join(srcRoot, 'agentic', 'code', 'addons');
  if (fs.existsSync(addonsDir)) {
    for (const entry of fs.readdirSync(addonsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      addDirs(listBehaviorDirs(path.join(addonsDir, entry.name, 'behaviors')));
    }
  }

  const frameworksDir = path.join(srcRoot, 'agentic', 'code', 'frameworks');
  if (fs.existsSync(frameworksDir)) {
    for (const entry of fs.readdirSync(frameworksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      addDirs(listBehaviorDirs(path.join(frameworksDir, entry.name, 'behaviors')));
    }
  }

  return dirs;
}


export const BEHAVIOR_EMULATION_TARGETS = {
  claude: { dir: '.claude/rules/behaviors', extension: '.md', surface: 'Claude Code rules' },
  codex: { dir: '.codex/rules/behaviors', extension: '.md', surface: 'Codex rules' },
  copilot: { dir: '.github/instructions/aiwg-behaviors', extension: '.instructions.md', surface: 'GitHub Copilot instructions' },
  cursor: { dir: '.cursor/rules/behaviors', extension: '.md', surface: 'Cursor rules' },
  factory: { dir: '.factory/rules/behaviors', extension: '.md', surface: 'Factory rules' },
  opencode: { dir: '.opencode/rule/behaviors', extension: '.md', surface: 'OpenCode rules' },
  warp: { dir: '.warp/rules/behaviors', extension: '.md', surface: 'Warp rules/context surface' },
  windsurf: { dir: '.windsurf/rules/behaviors', extension: '.md', surface: 'Windsurf rules' },
  hermes: { dir: '.hermes/behaviors', extension: '.md', surface: 'Hermes behavior context' },
};


export function renderBehaviorEmulation(behaviorDir, provider, target) {
  const behaviorName = path.basename(behaviorDir);
  const behaviorPath = path.join(behaviorDir, 'BEHAVIOR.md');
  const content = fs.readFileSync(behaviorPath, 'utf8');
  const { metadata } = parseFrontmatter(content);
  const description = metadata?.description || `AIWG behavior ${behaviorName}`;

  return `# AIWG Behavior: ${behaviorName}

Provider surface: ${target.surface}
Provider: ${provider}
Native source: ${path.relative(process.cwd(), behaviorPath)}

${description}

This provider does not expose OpenClaw-style native behavior directories. AIWG installs this generated behavior rule so the provider still receives the behavior contract instead of silently skipping it.

## Activation

Apply this behavior whenever the session, daemon, chat bridge, Mission Control loop, or provider runtime sees a matching trigger from the source behavior metadata. If a trigger cannot be observed natively, treat this file as provider-context guidance for the closest available rule, instruction, hook, or AGENTS-style surface.

## Source Behavior

\`\`\`markdown
${content.trim()}
\`\`\`
`;
}


/**
 * Deploy provider-specific emulated behavior artifacts for providers that do
 * not have a native OpenClaw-style behavior loader.
 */
export function deployEmulatedBehaviors(behaviorDirs, providerName, targetDir, opts = {}) {
  if (!behaviorDirs || behaviorDirs.length === 0) return 0;
  const provider = providerName === 'openai' ? 'codex' : providerName;
  if (provider === 'openclaw') return 0;
  const target = BEHAVIOR_EMULATION_TARGETS[provider];
  if (!target) {
    if (opts.verbose) console.warn(`No behavior emulation target registered for provider ${provider}`);
    return 0;
  }

  const destDir = path.isAbsolute(target.dir) ? target.dir : path.join(targetDir, target.dir);
  ensureDir(destDir, opts.dryRun);
  let count = 0;

  for (const behaviorDir of behaviorDirs) {
    const behaviorName = path.basename(behaviorDir);
    const filename = `${behaviorName}${target.extension}`;
    const dest = path.join(destDir, filename);
    const rendered = renderBehaviorEmulation(behaviorDir, provider, target);
    const content = addManagedMarker(rendered, opts.deployVersion || 'unknown', opts.deploySource || 'bundled');
    if (opts.dryRun) {
      console.log(`[dry-run] deploy behavior emulation ${behaviorName} -> ${dest}`);
    } else {
      writeFile(dest, content, false);
    }
    if (opts.verbose) console.log(`deployed behavior emulation ${behaviorName} -> ${path.relative(process.cwd(), dest)}`);
    count++;
  }

  return count;
}


/**
 * Get addon files by category (agents, commands, skills, rules)
 * @param {string} srcRoot - Source root directory
 * @param {object} options - Options
 * @param {string[]} options.excludeAddons - Addon names to exclude
 * @param {boolean} options.includeAgents - Include agent files (default: true)
 * @param {boolean} options.includeCommands - Include command files (default: true)
 * @param {boolean} options.includeSkills - Include skill directories (default: true)
 * @param {boolean} options.includeRules - Include rule files (default: true)
 * @returns {{agents: string[], commands: string[], skills: string[], rules: string[]}}
 */
export function getAddonFiles(srcRoot, options = {}) {
  const {
    excludeAddons = [],
    includeAgents = true,
    includeCommands = true,
    includeSkills = true,
    includeRules = true
  } = options;

  return {
    agents: includeAgents ? getAddonAgentFiles(srcRoot, excludeAddons) : [],
    commands: includeCommands ? getAddonCommandFiles(srcRoot, excludeAddons) : [],
    skills: includeSkills ? getAddonSkillDirs(srcRoot, excludeAddons) : [],
    rules: includeRules ? getAddonRuleFiles(srcRoot, excludeAddons) : []
  };
}
