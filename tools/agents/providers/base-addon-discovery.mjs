// Shared provider addon discovery utilities.
import { fs, path } from './base-runtime.mjs';
import { listMdFiles, listSkillDirs } from './base-files.mjs';


// ============================================================================
// Addon Discovery
// ============================================================================

/**
 * Discover all addons in the agentic/code/addons directory
 * @param {string} srcRoot - Source root directory
 * @param {{includeExplicit?: boolean}} [options] - includeExplicit also returns explicitInstall addons
 * @returns {Array<{name: string, path: string, manifest: object}>} - Array of addon info
 */
export function discoverAddons(srcRoot, { includeExplicit = false } = {}) {
  const addonsDir = path.join(srcRoot, 'agentic', 'code', 'addons');
  if (!fs.existsSync(addonsDir)) return [];

  const addons = [];
  for (const entry of fs.readdirSync(addonsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const addonPath = path.join(addonsDir, entry.name);
    const manifestPath = path.join(addonPath, 'manifest.json');

    let manifest = {};
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        console.warn(`Warning: Could not parse manifest for addon ${entry.name}: ${e.message}`);
      }
    }

    // Skip addons marked devOnly — they are contributor tools, not end-user deployables
    if (manifest.devOnly === true) continue;
    // explicitInstall addons deploy only when named (`aiwg use <addon>`), never
    // as part of a framework or `all` bulk deploy (#2641).
    // The stale-artifact prune passes includeExplicit so a named install's own
    // files stay in its desired set and are not deleted right after deployment.
    if (manifest.explicitInstall === true && !includeExplicit) continue;

    addons.push({
      name: entry.name,
      path: addonPath,
      manifest
    });
  }

  return addons;
}


/**
 * Get all agent files from all addons
 * @param {string} srcRoot - Source root directory
 * @param {string[]} excludeAddons - Addon names to exclude (default: none)
 * @returns {string[]} - Array of agent file paths
 */
export function getAddonAgentFiles(srcRoot, excludeAddons = [], options = {}) {
  const addons = discoverAddons(srcRoot, options);
  const files = [];

  for (const addon of addons) {
    if (excludeAddons.includes(addon.name)) continue;

    const agentsDir = path.join(addon.path, 'agents');
    if (fs.existsSync(agentsDir)) {
      files.push(...listMdFiles(agentsDir));
    }
  }

  return files;
}


/**
 * Get all command files from all addons
 * @param {string} srcRoot - Source root directory
 * @param {string[]} excludeAddons - Addon names to exclude (default: none)
 * @returns {string[]} - Array of command file paths
 */
export function getAddonCommandFiles(srcRoot, excludeAddons = [], options = {}) {
  const addons = discoverAddons(srcRoot, options);
  const files = [];

  for (const addon of addons) {
    if (excludeAddons.includes(addon.name)) continue;

    const commandsDir = path.join(addon.path, 'commands');
    if (fs.existsSync(commandsDir)) {
      files.push(...listMdFiles(commandsDir));
    }
  }

  return files;
}


/**
 * Get skill directories from a direct addon/framework source or all addons
 * @param {string} srcRoot - Source root directory
 * @param {string[]} excludeAddons - Addon names to exclude (default: none)
 * @returns {string[]} - Array of skill directory paths
 */
export function getAddonSkillDirs(srcRoot, excludeAddons = []) {
  const addons = discoverAddons(srcRoot);
  const dirs = [];
  const directDir = getDirectSourceDir(srcRoot, excludeAddons);
  if (directDir) dirs.push(...listSkillDirs(directDir));

  for (const addon of addons) {
    if (excludeAddons.includes(addon.name)) continue;

    const skillsDir = path.join(addon.path, 'skills');
    if (fs.existsSync(skillsDir)) {
      dirs.push(...listSkillDirs(skillsDir));
    }
  }

  return dirs;
}


// `aiwg use <addon>` passes the component itself as --source. Keep bulk
// repository discovery unchanged, even if the repo has a top-level skills/.
export function getDirectSourceDir(srcRoot, excludeAddons) {
  if (fs.existsSync(path.join(srcRoot, 'agentic', 'code')) ||
      excludeAddons.includes(path.basename(path.resolve(srcRoot)))) return null;
  const dir = path.join(srcRoot, 'skills');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const relative = path.relative(fs.realpathSync(srcRoot), fs.realpathSync(dir));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    console.warn(`Warning: Skipping direct skills directory ${dir}: resolves outside source root ${srcRoot}`);
    return null;
  }
  return dir;
}
