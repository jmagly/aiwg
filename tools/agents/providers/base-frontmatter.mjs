// Shared provider frontmatter utilities.
import { path } from './base-runtime.mjs';


/**
 * Parse YAML frontmatter from markdown content
 * Returns { frontmatter: string, body: string, metadata: object }
 */
export function parseFrontmatter(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    return { frontmatter: null, body: content, metadata: {} };
  }

  const [, frontmatter, body] = fmMatch;

  // Parse simple YAML key-value pairs
  const metadata = {};
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      metadata[match[1]] = match[2].trim();
    }
  }

  return { frontmatter, body, metadata };
}


/**
 * Create frontmatter string from metadata object
 */
export function stringifyFrontmatter(metadata, body) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && value !== null) {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n\n' + body.trim();
}


// ============================================================================
// String Utilities
// ============================================================================

/**
 * Convert a string to kebab-case
 * "Technical Researcher" -> "technical-researcher"
 */
export function toKebabCase(str) {
  if (!str) return str;
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}


/**
 * Strip JSON comments (JSONC) for parsing. Used by the Factory and Muse
 * settings and hooks merges, which write the parsed document back, so the
 * scanner tracks string literals: `//` in a URL or a slash-star sequence in
 * a glob matcher is data, not a comment. A regex-only stripper collapsed glob
 * matchers inside strings and rejected any settings file containing a URL.
 */
export function stripJsonComments(jsonc) {
  const text = String(jsonc);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}


// ============================================================================
// Agent Category Inference
// ============================================================================

/**
 * Infer agent category from name and body content
 * Returns: 'analysis', 'documentation', 'planning', or 'implementation'
 */
export function inferAgentCategory(name, body) {
  const normalizedName = (name || '').toLowerCase();
  const normalizedBody = (body || '').toLowerCase();

  // Analysis agents (read-only)
  if (normalizedName.includes('security') || normalizedName.includes('review') ||
      normalizedName.includes('analyst') || normalizedName.includes('auditor')) {
    return 'analysis';
  }

  // Documentation agents
  if (normalizedName.includes('writer') || normalizedName.includes('document') ||
      normalizedName.includes('archivist')) {
    return 'documentation';
  }

  // Planning agents
  if (normalizedName.includes('architect') || normalizedName.includes('planner') ||
      normalizedName.includes('requirements') || normalizedName.includes('designer')) {
    return 'planning';
  }

  // Implementation agents (full access)
  if (normalizedName.includes('implement') || normalizedName.includes('engineer') ||
      normalizedName.includes('developer') || normalizedName.includes('test')) {
    return 'implementation';
  }

  // Default to implementation for most flexibility
  return 'implementation';
}


// ============================================================================
// Tool Parsing
// ============================================================================

/**
 * Parse tools string into array
 */
export function parseTools(toolsString) {
  if (!toolsString) return [];

  if (toolsString.startsWith('[')) {
    try {
      return JSON.parse(toolsString);
    } catch (e) {
      return toolsString.replace(/[\[\]"']/g, '').split(/[,\s]+/).filter(Boolean);
    }
  }
  return toolsString.split(/[,\s]+/).filter(Boolean);
}


// ============================================================================
// Skill-Command Collision Detection
// ============================================================================

/**
 * Filter out commands that share a name with a skill.
 * Skills are the richer format (triggers, NL routing, behavior spec) and take precedence.
 *
 * @param {string[]} commandFiles - Array of command file paths
 * @param {string[]} skillDirs - Array of skill directory paths
 * @returns {string[]} Filtered command files with collisions removed
 */
export function filterCommandsAgainstSkills(commandFiles, skillDirs) {
  if (!skillDirs.length || !commandFiles.length) return commandFiles;

  // Build set of skill names (directory basenames, without extension)
  const skillNames = new Set(skillDirs.map(d => path.basename(d)));

  const filtered = [];
  for (const f of commandFiles) {
    // Command name is the filename without extension
    const commandName = path.basename(f).replace(/\.\w+$/, '');
    if (skillNames.has(commandName)) {
      console.log(`skip (skill precedence): command "${commandName}" — skill with same name takes precedence`);
    } else {
      filtered.push(f);
    }
  }

  return filtered;
}


export function shouldReportDeployCollisions(opts = {}) {
  if (opts.reportCollisions === true) return true;
  if (opts.reportCollisions === false) return false;
  if (process.env.AIWG_REPORT_DEPLOY_COLLISIONS === '1') return true;
  if (process.env.VITEST) return false;
  if (process.env.NODE_ENV === 'test') return false;
  return true;
}
