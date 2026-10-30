// Shared provider framework discovery utilities.
import { classifyModelRole, fs, path } from './base-runtime.mjs';
import { parseFrontmatter } from './base-frontmatter.mjs';
import { listMdFiles, listMdFilesRecursive, listSkillDirs, listSoulFiles } from './base-files.mjs';
import { getRulesIndexPath, isAlwaysOnRule } from './base-rule-index.mjs';


// ============================================================================
// Agent Filtering
// ============================================================================

/**
 * Check if an agent should be deployed based on filter options
 * @param {string} agentPath - Path to agent file
 * @param {object} metadata - Parsed frontmatter metadata
 * @param {object} opts - Options including filter and filterRole
 * @returns {boolean} - True if agent should be deployed
 */
export function shouldDeployAgent(agentPath, metadata, opts) {
  const { filter, filterRole } = opts;

  // No filters - deploy everything
  if (!filter && !filterRole) return true;

  // Filter by role (model tier)
  if (filterRole) {
    const role = classifyModelRole(metadata.model, { defaultRole: 'coding' });
    if (role !== filterRole.toLowerCase()) {
      return false;
    }
  }

  // Filter by glob pattern
  if (filter) {
    const agentName = path.basename(agentPath, '.md');
    if (!matchesGlob(agentName, filter)) {
      return false;
    }
  }

  return true;
}


/**
 * Simple glob pattern matching
 * Supports * (match any characters) and ? (match single character)
 * @param {string} str - String to match
 * @param {string} pattern - Glob pattern
 * @returns {boolean} - True if matches
 */
export function matchesGlob(str, pattern) {
  // Convert glob to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except * and ?
    .replace(/\*/g, '.*')                  // * matches any characters
    .replace(/\?/g, '.');                  // ? matches single character

  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(str);
}


/**
 * Filter a list of agent files based on filter options
 * @param {string[]} files - List of file paths
 * @param {object} opts - Options including filter and filterRole
 * @returns {string[]} - Filtered list of file paths
 */
export function filterAgentFiles(files, opts) {
  const { filter, filterRole } = opts;

  // No filters - return all
  if (!filter && !filterRole) return files;

  return files.filter(filePath => {
    // Read and parse frontmatter to get metadata
    const content = fs.readFileSync(filePath, 'utf8');
    const { metadata } = parseFrontmatter(content);
    return shouldDeployAgent(filePath, metadata, opts);
  });
}


// ============================================================================
// Framework Discovery
// ============================================================================

export const MODE_ALIASES = {
  writing: 'general',
  mmk: 'marketing'
};


export const LEGACY_FRAMEWORK_MODE_ALIASES = {
  'sdlc-complete': ['sdlc'],
  'media-marketing-kit': ['marketing', 'mmk'],
  'media-curator': ['media-curator'],
  'research-complete': ['research']
};


export const DEFAULT_FRAMEWORK_SUBDIRS = {
  'sdlc-complete': ['repo', 'projects', 'working', 'archive'],
  'media-marketing-kit': ['repo', 'campaigns', 'working', 'archive'],
  'media-curator': ['repo', 'library', 'working', 'archive'],
  'research-complete': ['repo', 'corpus', 'working', 'archive']
};


export function normalizePathSegment(segment) {
  return String(segment || '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}


export function ensureStringArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.map(v => String(v)) : [String(value)];
}


export function uniqueLower(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const v = String(raw || '').trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}


export function normalizeDeploymentMode(mode = 'all') {
  const normalized = String(mode || 'all').toLowerCase();
  return MODE_ALIASES[normalized] || normalized;
}


export function resolveFrameworkComponentDir(frameworkPath, manifest, component) {
  const entry = manifest?.entry?.[component];
  const relPath = normalizePathSegment(entry || component);
  return path.join(frameworkPath, relPath);
}


/**
 * Discover framework roots under agentic/code/frameworks.
 * Framework metadata is loaded from root manifest.json when present.
 */
export function discoverFrameworks(srcRoot) {
  const frameworksRoot = path.join(srcRoot, 'agentic', 'code', 'frameworks');
  if (!fs.existsSync(frameworksRoot)) return [];

  const frameworks = [];
  const entries = fs.readdirSync(frameworksRoot, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const frameworkPath = path.join(frameworksRoot, entry.name);
    const manifestPath = path.join(frameworkPath, 'manifest.json');
    let manifest = {};

    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        console.warn(`Warning: Could not parse framework manifest for ${entry.name}: ${e.message}`);
      }
    }

    const id = String(manifest.id || manifest.framework || entry.name);
    const aliases = uniqueLower([
      id,
      entry.name,
      ...ensureStringArray(manifest.modeAliases),
      ...ensureStringArray(manifest.aliases),
      ...(LEGACY_FRAMEWORK_MODE_ALIASES[id] || [])
    ]);

    const workspaceSubdirs = ensureStringArray(
      manifest.workspace?.subdirs || manifest.workspace?.directories
    );

    const agentsDir = resolveFrameworkComponentDir(frameworkPath, manifest, 'agents');
    const commandsDir = resolveFrameworkComponentDir(frameworkPath, manifest, 'commands');
    const skillsDir = resolveFrameworkComponentDir(frameworkPath, manifest, 'skills');
    const rulesDir = resolveFrameworkComponentDir(frameworkPath, manifest, 'rules');

    frameworks.push({
      id,
      name: manifest.name || entry.name,
      path: frameworkPath,
      manifest,
      aliases,
      workspaceSubdirs: workspaceSubdirs.length > 0
        ? workspaceSubdirs
        : (DEFAULT_FRAMEWORK_SUBDIRS[id] || ['repo', 'working', 'archive']),
      components: {
        agents: { path: agentsDir, exists: fs.existsSync(agentsDir) },
        commands: { path: commandsDir, exists: fs.existsSync(commandsDir) },
        skills: { path: skillsDir, exists: fs.existsSync(skillsDir) },
        rules: { path: rulesDir, exists: fs.existsSync(rulesDir) }
      }
    });
  }

  return frameworks;
}


/**
 * Select frameworks for a deployment mode.
 */
export function getFrameworksForMode(srcRoot, mode) {
  const normalizedMode = normalizeDeploymentMode(mode);
  const frameworks = discoverFrameworks(srcRoot);

  if (normalizedMode === 'all') return frameworks;
  if (normalizedMode === 'general') return [];
  if (normalizedMode === 'both') {
    return frameworks.filter(fw => fw.aliases.includes('sdlc'));
  }

  return frameworks.filter(fw =>
    fw.id.toLowerCase() === normalizedMode || fw.aliases.includes(normalizedMode)
  );
}


/**
 * Collect framework artifacts for a deployment mode.
 * @param {string} srcRoot - Source root directory
 * @param {string} mode - Deployment mode
 * @param {object} options - Collection options
 * @param {boolean} options.includeAgents - Include agents
 * @param {boolean} options.includeCommands - Include commands
 * @param {boolean} options.includeSkills - Include skills
 * @param {boolean} options.includeRules - Include rules
 * @param {boolean} options.recursiveCommands - Use recursive command listing
 * @param {boolean} options.consolidatedSdlcRules - Use RULES-INDEX for SDLC when available
 * @returns {{frameworks: Array, agents: string[], commands: string[], skills: string[], rules: string[]}}
 */
export function collectFrameworkArtifacts(srcRoot, mode, options = {}) {
  const {
    includeAgents = true,
    includeCommands = true,
    includeSkills = true,
    includeRules = true,
    recursiveCommands = true,
    consolidatedSdlcRules = true
  } = options;

  const frameworks = getFrameworksForMode(srcRoot, mode);
  const artifacts = {
    frameworks,
    agents: [],
    souls: [],
    commands: [],
    skills: [],
    rules: []
  };

  for (const framework of frameworks) {
    if (includeAgents && framework.components.agents.exists) {
      artifacts.agents.push(...listMdFiles(framework.components.agents.path));
      artifacts.souls.push(...listSoulFiles(framework.components.agents.path));
    }

    if (includeCommands && framework.components.commands.exists) {
      const commandFiles = recursiveCommands
        ? listMdFilesRecursive(framework.components.commands.path)
        : listMdFiles(framework.components.commands.path);
      artifacts.commands.push(...commandFiles);
    }

    if (includeSkills && framework.components.skills.exists) {
      artifacts.skills.push(...listSkillDirs(framework.components.skills.path));
    }

    if (includeRules && framework.components.rules.exists) {
      if (consolidatedSdlcRules && framework.id === 'sdlc-complete') {
        const indexPath = getRulesIndexPath(srcRoot);
        if (indexPath) {
          artifacts.rules.push(indexPath);
          // PUW-016 (#1117): also include individual rule files referenced
          // by the index. RULES-INDEX.md links to per-rule files; if those
          // files don't ship the links resolve to nowhere. Filter the
          // index file itself out of listMdFiles so it isn't pushed twice.
          const indexBase = indexPath.split('/').pop();
          artifacts.rules.push(
            ...listMdFiles(framework.components.rules.path)
              .filter((f) => !f.endsWith(indexBase))
              .filter(isAlwaysOnRule) // tier gate (#1673)
          );
          continue;
        }
      }
      // tier gate (#1673): inline only always-on (CRITICAL/HIGH) rules
      artifacts.rules.push(...listMdFiles(framework.components.rules.path).filter(isAlwaysOnRule));
    }
  }

  return artifacts;
}
