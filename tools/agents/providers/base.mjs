/**
 * Shared utilities for provider modules
 *
 * This module contains common functions used across all providers:
 * - File operations (ensureDir, listMdFiles, writeFile, etc.)
 * - Model configuration loading
 * - Frontmatter parsing
 * - Other shared utilities
 */

import realFs from 'fs';
import path from 'path';
import os from 'os';
import { classifyModelRole } from './model-role.mjs';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { execSync as nodeExecSync } from 'child_process';

// Use graceful-fs to prevent EMFILE crashes on systems with low ulimit.
// graceful-fs queues open() calls when FD pressure is detected and retries
// after a backoff, transparently wrapping the native fs module.
let fs;
try {
  const require = createRequire(import.meta.url);
  const gracefulFs = require('graceful-fs');
  gracefulFs.gracefulify(realFs);
  fs = realFs;
} catch {
  // graceful-fs not available — fall back to native fs
  fs = realFs;
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * Ensure a directory exists, creating it recursively if needed
 * @param {string} d - Directory path
 * @param {boolean} dryRun - If true, skip actual directory creation
 */
export function ensureDir(d, dryRun = false) {
  if (dryRun) return;
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const PROJECT_ARTIFACT_ENV_KEYS = [
  'AIWG_ARTIFACTS_PATH',
  'AIWG_PROJECT_ARTIFACTS_PATH',
  'AIWG_PROJECT_AIWG_DIR',
];

function expandProjectArtifactPath(value, projectDir) {
  const trimmed = value.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.resolve(os.homedir(), trimmed.slice(2));
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(projectDir, trimmed);
}

function parseProjectArtifactLocation(contents) {
  for (const rawLine of contents.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const assignment = line.match(/^AIWG_ARTIFACTS_PATH\s*=\s*(.+)$/);
    if (assignment) line = assignment[1].trim();
    if ((line.startsWith('"') && line.endsWith('"')) || (line.startsWith("'") && line.endsWith("'"))) {
      line = line.slice(1, -1);
    }
    return line || null;
  }
  return null;
}

/** Resolve the artifact corpus root used for framework-generated workspace data. */
export function resolveFrameworkWorkspaceRoot(projectDir, env = process.env) {
  for (const key of PROJECT_ARTIFACT_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) return expandProjectArtifactPath(value, projectDir);
  }
  const pointer = path.join(projectDir, '.aiwg-location');
  if (fs.existsSync(pointer)) {
    const configured = parseProjectArtifactLocation(fs.readFileSync(pointer, 'utf8'));
    if (configured) return expandProjectArtifactPath(configured, projectDir);
  }
  return path.join(projectDir, '.aiwg');
}

/**
 * List markdown files in a directory (non-recursive)
 */
export function listMdFiles(dir, excludePatterns = []) {
  if (!fs.existsSync(dir)) return [];
  const defaultExcluded = ['README.md', 'manifest.md', 'agent-template.md', 'openai-compat.md', 'factory-compat.md', 'windsurf-compat.md', 'DEVELOPMENT_GUIDE.md'];
  const excluded = [...defaultExcluded, ...excludePatterns];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && !e.name.toLowerCase().endsWith('.soul.md') && !excluded.includes(e.name))
    .map((e) => path.join(dir, e.name));
}

/**
 * List .soul.md companion files in a directory (non-recursive)
 */
export function listSoulFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.soul.md'))
    .map((e) => path.join(dir, e.name));
}

/**
 * List markdown files recursively
 */
export function listMdFilesRecursive(dir, excludePatterns = []) {
  if (!fs.existsSync(dir)) return [];
  const defaultExcluded = ['README.md', 'manifest.md', 'agent-template.md', 'openai-compat.md', 'factory-compat.md', 'windsurf-compat.md', 'DEVELOPMENT_GUIDE.md'];
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

/**
 * List skill directories (directories containing SKILL.md)
 */
export function listSkillDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => path.join(dir, e.name));
}

/**
 * Write a file (with dry-run support)
 */
export function writeFile(dest, data, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] write ${dest}`);
  } else {
    fs.writeFileSync(dest, data, 'utf8');
  }
}

// ============================================================================
// Deployment Manifest (File Ownership Tagging)
// ============================================================================

// Match either form so legacy-marker files are recognized as already-managed:
//   <!-- aiwg:managed v... ...   (legacy, line 1, breaks YAML frontmatter parsing)
//   # aiwg:managed v... ...      (current, inside frontmatter as a YAML comment)
const MANAGED_MARKER_RE = /^(?:<!-- aiwg:managed |# aiwg:managed )/m;
const MANIFEST_FILENAME = '.aiwg-manifest.json';

/**
 * Add an `aiwg:managed vVERSION SOURCE` marker to deployed markdown content.
 *
 * For files with YAML frontmatter (start with `---\n`), inject the marker as
 * a YAML comment INSIDE the frontmatter. This keeps `---` on line 1, which
 * Claude Code (and other YAML frontmatter parsers) require to discover
 * agents/skills/commands. Issue #1059.
 *
 * For files without frontmatter, fall back to the legacy HTML-comment-at-top
 * form (no parser to break).
 *
 * Idempotent — skips if either form of the marker is already present.
 */
export function addManagedMarker(content, version, source, style = 'markdown') {
  if (MANAGED_MARKER_RE.test(content)) return content;
  if (style === 'line-comment') {
    return `# aiwg:managed v${version} ${source}\n${content}`;
  }
  // Frontmatter present → inject as YAML comment after the opening `---\n`.
  if (content.startsWith('---\n')) {
    return content.replace(
      /^---\n/,
      `---\n# aiwg:managed v${version} ${source}\n`
    );
  }
  // No frontmatter → legacy HTML-comment-at-top form is safe.
  return `<!-- aiwg:managed v${version} ${source} -->\n${content}`;
}

/**
 * Compute SHA-256 hash of content (hex string).
 */
export function contentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Read existing sidecar manifest from a deployment directory.
 * Returns `{ managed: { [filename]: { hash, source, version } } }` or null.
 */
export function readSidecarManifest(dir) {
  const p = path.join(dir, MANIFEST_FILENAME);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write sidecar manifest to a deployment directory.
 */
export function writeSidecarManifest(dir, manifest, dryRun) {
  if (dryRun) return;
  const p = path.join(dir, MANIFEST_FILENAME);
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/**
 * Update sidecar manifest entries for a batch of deployed files.
 * Merges into existing manifest if present.
 *
 * `frameworkSlug` (optional, per-entry) records which AIWG framework
 * the file came from (e.g., 'forensics-complete', 'sdlc-complete').
 * Used by the cross-framework collision guard (#1169) to detect
 * silent overwrites when two frameworks ship a file with the same
 * filename but different content.
 */
export function updateSidecarManifest(dir, deployedEntries, opts) {
  const { dryRun = false, version = 'unknown', source = 'bundled' } = opts;
  const existing = readSidecarManifest(dir) || { managed: {} };

  for (const entry of deployedEntries) {
    const { filename, hash, frameworkSlug, kind } = entry;
    const sidecarEntry = { hash: `sha256:${hash}`, source, version };
    if (frameworkSlug) sidecarEntry.frameworkSlug = frameworkSlug;
    // `kind` marks artifacts whose lifecycle is governed elsewhere — currently
    // only `skill-command` wrappers, which follow their source skill (#2507).
    if (kind) sidecarEntry.kind = kind;
    existing.managed[filename] = sidecarEntry;
  }

  writeSidecarManifest(dir, existing, dryRun);
}

// ============================================================================
// Cross-Framework Collision Detection (#1169)
// ============================================================================

/**
 * Extract the framework slug from a source file path.
 *
 * Recognizes paths under `agentic/code/frameworks/<slug>/...` and
 * `agentic/code/addons/<slug>/...`. Returns null for paths outside
 * those namespaces (operator-authored bundles, addons under
 * `.aiwg/addons/`, etc.) — those don't get collision-tracked.
 */
export function extractFrameworkSlug(srcPath) {
  if (typeof srcPath !== 'string') return null;
  // Normalize separators for cross-platform matching
  const normalized = srcPath.replace(/\\/g, '/');
  const m = normalized.match(/agentic\/code\/(?:frameworks|addons)\/([^/]+)\//);
  return m ? m[1] : null;
}

// ============================================================================
// Model Configuration
// ============================================================================

/**
 * Load model configuration from models.json
 * Priority: Project models.json > User ~/.config/aiwg/models.json > AIWG defaults
 */
export function loadModelConfig(srcRoot) {
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

  // Fallback to hardcoded defaults if no config found
  return {
    claude: {
      reasoning: { model: 'opus' },
      coding: { model: 'sonnet' },
      efficiency: { model: 'haiku' }
    },
    factory: {
      reasoning: { model: 'heavy' },
      coding: { model: 'medium' },
      efficiency: { model: 'light' }
    },
    shorthand: {
      'opus': 'claude-opus-4-6',
      'sonnet': 'claude-sonnet-4-6',
      'haiku': 'claude-haiku-4-5-20251001',
      'inherit': 'inherit'
    },
    claude_shorthand: {
      'opus': 'opus',
      'opus-1m': 'opus[1m]',
      'opus[1m]': 'opus[1m]',
      'sonnet': 'sonnet',
      'sonnet-1m': 'sonnet[1m]',
      'sonnet[1m]': 'sonnet[1m]',
      'haiku': 'haiku',
      'inherit': 'inherit'
    }
  };
}

/**
 * Load a fresh dynamically-discovered model catalog when available, otherwise
 * use the committed catalog supplied by the caller. Refresh is performed by
 * `aiwg models refresh`; deployment itself never performs network access.
 */
export function loadRuntimeModelCatalog(staticCatalog, options = {}) {
  if (process.env.VITEST && !options.cacheFile && !options.homeDir) return staticCatalog;
  const homeDir = options.homeDir || os.homedir();
  const cacheFile = options.cacheFile || path.join(homeDir, '.cache', 'aiwg', 'model-catalog.v1.json');
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const fetchedAt = Date.parse(cached?.discovery?.fetchedAt || '');
    const age = Date.now() - fetchedAt;
    if (
      cached?.providers &&
      Number.isFinite(age) &&
      age >= 0 &&
      age <= ttlMs
    ) {
      return cached;
    }
  } catch {
    // Missing, stale, or malformed cache: deterministic static fallback.
  }
  return staticCatalog;
}

// ============================================================================
// Frontmatter Utilities
// ============================================================================

/**
 * Maps provider names to the platform identifiers used in skill platforms: fields.
 * Skills use descriptive names (e.g. "claude-code") while providers use short names (e.g. "claude").
 */
const PROVIDER_TO_PLATFORM = {
  'claude': 'claude-code'
};

/**
 * Parse the platforms: field from a SKILL.md frontmatter block.
 * Handles both inline array (platforms: [a, b]) and multi-line list formats.
 * Returns null if no platforms field is present (= deploy to all providers).
 * Returns an empty array only if the field is explicitly empty.
 */
export function parseSkillPlatforms(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const fm = fmMatch[1];

  // Inline array: platforms: [claude-code, codex] or platforms: [all]
  const inlineMatch = fm.match(/^platforms:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    const items = inlineMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    if (items.length === 0 || (items.length === 1 && items[0] === 'all')) return null;
    return items;
  }

  // Multi-line list:
  //   platforms:
  //     - claude-code
  //     - hermes
  const multiMatch = fm.match(/^platforms:\s*\n((?:[ \t]+-[ \t]+\S[^\n]*\n?)+)/m);
  if (multiMatch) {
    const items = multiMatch[1]
      .split('\n')
      .map(line => line.match(/^[ \t]+-[ \t]+(\S+)/)?.[1])
      .filter(Boolean);
    return items.length > 0 ? items : null;
  }

  // platforms: key present but empty
  if (/^platforms:\s*$/m.test(fm)) return null;

  return null; // Field absent = deploy to all
}

/**
 * Returns true if a skill (given its source content) should be deployed to the given provider.
 * If no provider is specified, always returns true.
 */
export function skillMatchesProvider(content, provider) {
  if (!provider) return true;

  const platforms = parseSkillPlatforms(content);
  if (!platforms) return true; // No restriction

  const platformName = PROVIDER_TO_PLATFORM[provider] || provider;
  return platforms.includes(platformName) || platforms.includes(provider);
}

/**
 * Inject the target platform name into a SKILL.md frontmatter block.
 *
 * Source skills use platforms: [all] as a deployment token.
 * At deploy time this function replaces [all] with [<targetPlatform>] so
 * each deployed copy accurately reflects where it was installed.
 *
 * Explicit restriction lists (not [all]) are preserved as-is.
 * If no platforms: field is present, one is added.
 */
export function injectPlatformInContent(content, targetPlatform) {
  if (!targetPlatform) return content;

  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---\n?)([\s\S]*)$/);
  if (!fmMatch) return content;

  const [, open, fm, close, body] = fmMatch;

  const injected = `platforms: [${targetPlatform}]`;

  // Case 1: inline [all] token → replace with target platform
  let updated = fm.replace(/^platforms:\s*\[all\]\n?/m, injected + '\n');
  if (updated !== fm) return open + updated + close + body;

  // Case 2: inline explicit restriction (not [all]) → leave as-is, do not inject
  if (/^platforms:\s*\[(?!all\])[^\]]+\]/m.test(fm)) {
    return content;
  }

  // Case 3: multi-line list → replace entire block with injected value
  updated = fm.replace(/^platforms:\s*\n(?:[ \t]+-[ \t]+\S[^\n]*\n?)*/m, injected + '\n');
  if (updated !== fm) return open + updated + close + body;

  // Case 4: bare `platforms:` with no value → replace
  updated = fm.replace(/^platforms:\s*$/m, injected);
  if (updated !== fm) return open + updated + close + body;

  // Case 5: no platforms: field at all → insert after the first frontmatter line
  const fmLines = fm.split('\n');
  fmLines.splice(1, 0, injected);
  return open + fmLines.join('\n') + close + body;
}

/**
 * Remove the `platforms:` field from a SKILL.md frontmatter block.
 *
 * Hermes (and other providers that treat `platforms:` as an OS gate —
 * linux / macos / windows) hide any skill whose value isn't a recognized
 * OS. AIWG source skills use the field as a *provider* restriction token
 * (`[all]`, provider names), which is the opposite meaning, so deployed
 * copies destined for such providers must drop the field entirely. An
 * absent field is the documented "compatible with all platforms" default.
 */
export function stripPlatformsFromContent(content) {
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))([\s\S]*)$/);
  if (!fmMatch) return content;

  const [, open, fm, close, body] = fmMatch;
  let updated = fm.replace(/^platforms:[^\r\n]*(?:\r?\n|$)/m, '');

  // Multi-line list form:
  //   platforms:
  //     - claude-code
  //     - hermes
  if (updated === fm) {
    updated = fm.replace(
      /^platforms:[ \t]*\r?\n(?:[ \t]+-[ \t]+\S[^\r\n]*(?:\r?\n|$))*/m,
      '',
    );
  }

  if (updated === fm) return content;
  return open + updated + close + body;
}

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
 * Strip JSON comments (JSONC) for parsing
 * Used by Factory provider for settings.json
 */
export function stripJsonComments(jsonc) {
  // Remove single-line comments
  let result = jsonc.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  return result;
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

function shouldReportDeployCollisions(opts = {}) {
  if (opts.reportCollisions === true) return true;
  if (opts.reportCollisions === false) return false;
  if (process.env.AIWG_REPORT_DEPLOY_COLLISIONS === '1') return true;
  if (process.env.VITEST) return false;
  if (process.env.NODE_ENV === 'test') return false;
  return true;
}

// ============================================================================
// File Deployment
// ============================================================================

/**
 * Deploy files to destination directory
 * Handles transformation via provider's transform function
 */
export function deployFiles(files, destDir, opts, transformFn) {
  const { force = false, dryRun = false, provider = 'claude', fileExtension = '.md', injectPlatform = false } = opts;
  const deployVersion = opts.deployVersion || 'unknown';
  const deploySource = opts.deploySource || 'bundled';
  // Map of dest path → first batch entry that claimed it. Used to detect
  // and report cross-framework collisions within a single deploy batch
  // (#1169). Each value: { src, frameworkSlug }
  const seen = new Map();
  const actions = [];
  // Collision report — one entry per detected cross-framework collision
  // (within-batch or against sidecar). Surfaced after the loop.
  const collisions = [];

  // Read sidecar manifest for hash-based skip-on-match (#749) and
  // cross-framework collision detection (#1169)
  const sidecar = readSidecarManifest(destDir);
  const sidecarManaged = sidecar?.managed || {};

  for (const f of files) {
    let base = path.basename(f);

    // Change extension if needed
    if (fileExtension !== '.md' && base.endsWith('.md')) {
      base = base.replace(/\.md$/, fileExtension);
    }

    let dest = path.join(destDir, base);
    const currentFrameworkSlug = extractFrameworkSlug(f);

    // Read and transform source content (needed for content-equality check
    // and the collision-vs-duplicate distinction)
    const srcContent = fs.readFileSync(f, 'utf8');
    let transformedContent = transformFn ? transformFn(f, srcContent, opts) : srcContent;

    // Inject target platform into agent .md files that use platforms: [all]
    if (injectPlatform && provider && /platforms:\s*\[all\]/.test(transformedContent)) {
      const platformName = PROVIDER_TO_PLATFORM[provider] || provider;
      transformedContent = injectPlatformInContent(transformedContent, platformName);
    }

    // Add managed marker for provider artifacts (#749). TOML accepts `#`
    // comments, which lets doctor attribute transformed Codex agents even
    // though their YAML frontmatter is removed during serialization.
    if (base.endsWith('.md') || base.endsWith('.mdc')) {
      transformedContent = addManagedMarker(transformedContent, deployVersion, deploySource);
    } else if (base.endsWith('.toml')) {
      transformedContent = addManagedMarker(
        transformedContent,
        deployVersion,
        deploySource,
        'line-comment',
      );
    }

    // Compute content hash for sidecar comparison
    const hash = contentHash(transformedContent);

    // Within-batch collision check (#1169). If a previous file in this
    // batch already claimed this dest, distinguish:
    //   - Same content (transform/normalize is idempotent) → silent skip
    //   - Same framework + different content → "duplicate" (legacy reason)
    //   - Different framework + different content → "collision"
    if (seen.has(dest)) {
      const prev = seen.get(dest);
      const prevContent = prev.transformedContent;
      if (prevContent === transformedContent) {
        actions.push({ type: 'skip', src: f, dest, reason: 'duplicate-identical' });
        continue;
      }
      const prevSlug = prev.frameworkSlug;
      if (currentFrameworkSlug && prevSlug && currentFrameworkSlug !== prevSlug) {
        // Cross-framework collision within a single deploy batch — first
        // wins; second is skipped. `--force` keeps the first entry too,
        // since we have no principled way to pick a winner among peers.
        collisions.push({
          dest,
          filename: base,
          existingFramework: prevSlug,
          existingSrc: prev.src,
          incomingFramework: currentFrameworkSlug,
          incomingSrc: f,
          scope: 'within-batch',
        });
        actions.push({
          type: 'skip',
          src: f,
          dest,
          reason: 'collision',
          collidingFramework: prevSlug,
        });
        continue;
      }
      actions.push({ type: 'skip', src: f, dest, reason: 'duplicate' });
      continue;
    }

    // Skip-on-match: compare hash against sidecar manifest before reading dest file (#749)
    // Guard: only skip if the destination file still exists on disk. cleanupOldRuleFiles
    // may have deleted it before deployFiles runs, so the sidecar record is stale.
    if (!force && sidecarManaged[base]?.hash === `sha256:${hash}` && fs.existsSync(dest)) {
      actions.push({ type: 'skip', src: f, dest, reason: 'hash-match' });
      seen.set(dest, { src: f, frameworkSlug: currentFrameworkSlug, transformedContent });
      continue;
    }

    // Cross-batch collision check against sidecar (#1169). If the dest
    // file is already managed by a *different* framework than this deploy,
    // and the new content differs, refuse to silently overwrite.
    if (
      !force &&
      fs.existsSync(dest) &&
      sidecarManaged[base]?.frameworkSlug &&
      currentFrameworkSlug &&
      sidecarManaged[base].frameworkSlug !== currentFrameworkSlug
    ) {
      const destContent = fs.readFileSync(dest, 'utf8');
      if (destContent !== transformedContent) {
        collisions.push({
          dest,
          filename: base,
          existingFramework: sidecarManaged[base].frameworkSlug,
          existingSrc: null,
          incomingFramework: currentFrameworkSlug,
          incomingSrc: f,
          scope: 'cross-batch',
        });
        actions.push({
          type: 'skip',
          src: f,
          dest,
          reason: 'collision',
          collidingFramework: sidecarManaged[base].frameworkSlug,
        });
        // Don't claim the dest in `seen` — we did not deploy. The sidecar
        // entry already holds the previous framework's record and stays.
        continue;
      }
    }

    // Fallback: check destination file content directly
    if (!force && fs.existsSync(dest)) {
      const destContent = fs.readFileSync(dest, 'utf8');
      if (destContent === transformedContent) {
        actions.push({ type: 'skip', src: f, dest, reason: 'unchanged', hash });
        seen.set(dest, { src: f, frameworkSlug: currentFrameworkSlug, transformedContent });
        continue;
      }
      actions.push({ type: 'deploy', src: f, dest, content: transformedContent, reason: 'changed', hash, frameworkSlug: currentFrameworkSlug });
    } else if (force && fs.existsSync(dest)) {
      actions.push({ type: 'deploy', src: f, dest, content: transformedContent, reason: 'forced', hash, frameworkSlug: currentFrameworkSlug });
    } else {
      actions.push({ type: 'deploy', src: f, dest, content: transformedContent, reason: 'new', hash, frameworkSlug: currentFrameworkSlug });
    }
    seen.set(dest, { src: f, frameworkSlug: currentFrameworkSlug, transformedContent });
  }

  const verbose = opts.verbose === true;
  const deployedEntries = [];
  for (const a of actions) {
    if (a.type === 'deploy') {
      if (dryRun) console.log(`[dry-run] deploy ${a.src} -> ${a.dest} (${a.reason})`);
      else writeFile(a.dest, a.content, false);
      if (verbose) console.log(`deployed ${path.basename(a.src)} -> ${path.relative(process.cwd(), a.dest)} (${a.reason})`);
      deployedEntries.push({ filename: path.basename(a.dest), hash: a.hash, frameworkSlug: a.frameworkSlug });
    } else if (a.type === 'skip') {
      if (verbose) console.log(`skip (${a.reason}): ${path.basename(a.dest)}`);
      // Preserve existing sidecar entries for skipped files
      if (a.hash) deployedEntries.push({ filename: path.basename(a.dest), hash: a.hash });
    }
  }

  // Surface cross-framework collisions to the operator (#1169). Always
  // visible (not gated on verbose) because silent loss is the failure
  // mode this guard exists to prevent.
  if (collisions.length > 0 && shouldReportDeployCollisions(opts)) {
    const tag = force ? 'override' : 'skip';
    console.warn(
      `\n⚠ Cross-framework deploy collision${collisions.length > 1 ? 's' : ''} detected (${collisions.length}):`,
    );
    for (const c of collisions) {
      console.warn(
        `  ${c.filename}: ${c.existingFramework} owns this slot; ${c.incomingFramework} skipped (${c.scope})`,
      );
    }
    if (!force) {
      console.warn(
        `  Re-run with --force to override (last-wins) or rename the colliding file at framework source.`,
      );
    }
  }

  // Update sidecar manifest with deployed file hashes (#749) including
  // framework slug for future collision detection (#1169).
  if (deployedEntries.length > 0) {
    updateSidecarManifest(destDir, deployedEntries, { dryRun, version: deployVersion, source: deploySource });
  }

  return actions;
}

/**
 * Deploy .soul.md companion files alongside agents.
 * Soul files are copied as-is (no transformation) to the same directory as agents.
 */
export function deploySoulCompanions(soulFiles, destDir, opts) {
  if (!soulFiles || soulFiles.length === 0) return [];
  return deployFiles(soulFiles, destDir, opts, null);
}

/**
 * Read a skill's SKILL.md frontmatter and return whether it is a
 * "kernel" skill — always-loaded, deploys to the platform's native
 * skills directory rather than the AIWG-namespaced one. Per epic
 * #1212. A skill opts in by setting `kernel: true` in its frontmatter.
 *
 * Note: `parseFrontmatter` keeps values as strings (no YAML coercion).
 * Accept both the string `"true"` and the boolean `true` so callers
 * are not surprised if a future parser upgrade returns booleans.
 */
export function isKernelSkill(skillDir) {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) return false;
  const content = fs.readFileSync(skillMdPath, 'utf8');
  const { metadata } = parseFrontmatter(content);
  const v = metadata?.kernel;
  return v === true || v === 'true';
}

/**
 * Deploy skills with kernel-vs-standard routing (#1212/#1216/#1217).
 *
 * Partitions `skillDirs` into kernel skills (frontmatter `kernel: true`)
 * and standard skills.
 *
 * **Kernel skills** copy to `kernelDestDir` (platform-native dir,
 * always-loaded by the platform). Small set: currently 24 skills spanning
 * framework quickrefs, routing maps, and self-maintenance operations.
 *
 * **Standard skills** are NOT copied per-project (#1217). They live at
 * `$AIWG_ROOT/agentic/code/.../skills/<name>/` and `aiwg discover`
 * returns absolute paths anchored there. The agent reads them directly
 * via the `Read` tool — no per-project mirror, no stale-copy risk.
 * `standardDestDir` is retained as a fallback when `$AIWG_ROOT` is not
 * readable, and as the cleanup target for legacy `.aiwg/skills/`
 * directories from rc.13 and earlier deploys.
 *
 * @param skillDirs        absolute paths to source skill directories
 * @param standardDestDir  absolute path for standard skills (legacy
 *                         per-project mirror — used only as cleanup
 *                         target by default; populated if
 *                         `opts.copyStandardSkills` is true)
 * @param kernelDestDir    absolute path for kernel skills
 *                         (e.g., `.cursor/skills`); pass null/undefined
 *                         to disable kernel routing
 * @param opts             standard deploy opts forwarded to
 *                         `deploySkillDir`. New optional flags:
 *                         - `copyStandardSkills` (default: false) —
 *                           force per-project copy of standard skills
 *                           (used when $AIWG_ROOT is not readable from
 *                           the agent's working directory)
 *
 * @returns `{ kernel, standardCopied, prunedFromKernelDir,
 *             prunedFromStandardDir, prunedKernelFromStandardDir }`
 *             deployed/pruned counts
 *
 * Cleanup behavior:
 *   - Kernel dir: prune any AIWG-shaped skill whose name now belongs
 *     to the standard tier (rc.13 behavior, preserved).
 *   - Standard dir: when standard copies are NOT being deployed this
 *     run, prune any AIWG-shaped skill that exists under
 *     `standardDestDir`. These are legacy per-project mirrors from
 *     rc.13 deploys; the canonical source is now `$AIWG_ROOT`.
 *   - User-authored skills (no SKILL.md, or names not in our deploy
 *     manifest) survive untouched in both directories.
 */
export function deploySkillsWithKernelRouting(
  skillDirs,
  standardDestDir,
  kernelDestDir,
  opts,
) {
  // Caller opts in via `opts.copyStandardSkills` (set by `--copy-all`
  // CLI flag, #1219). Default (#1217) is no-copy: standard skills stay
  // at their source path under $AIWG_ROOT and are reached via the
  // artifact index.
  const copyStandardSkills = opts?.copyStandardSkills === true;

  const kernel = [];
  const standard = [];
  for (const dir of skillDirs) {
    if (kernelDestDir && isKernelSkill(dir)) kernel.push(dir);
    else standard.push(dir);
  }

  // Names of skills in the deploy manifest — bound the cleanup to
  // names AIWG manages so user-authored content survives.
  const standardNames = new Set(standard.map(p => path.basename(p)));
  const allSkillNames = new Set([...standardNames, ...kernel.map(p => path.basename(p))]);

  if (kernel.length > 0 && kernelDestDir) {
    ensureDir(kernelDestDir, opts?.dryRun);
    for (const dir of kernel) deploySkillDir(dir, kernelDestDir, opts);
  }

  // Standard tier copy is OFF by default (#1217). Only fires when the
  // operator explicitly opts in via `copyStandardSkills` — typically
  // because $AIWG_ROOT isn't readable from the agent's working dir.
  let standardCopied = 0;
  if (copyStandardSkills && standard.length > 0) {
    ensureDir(standardDestDir, opts?.dryRun);
    for (const dir of standard) {
      deploySkillDir(dir, standardDestDir, opts);
      standardCopied++;
    }
  }

  // A skill promoted from standard → kernel may still have an older managed
  // copy in the opt-in standard mirror. Remove that duplicate even when
  // --copy-all remains enabled; otherwise providers that recursively scan
  // both tiers can surface the same skill twice after a tier transition.
  let prunedKernelFromStandardDir = 0;
  if (
    standardDestDir &&
    fs.existsSync(standardDestDir) &&
    !opts?.dryRun &&
    kernel.length > 0
  ) {
    const kernelNames = new Set(kernel.map(p => path.basename(p)));
    for (const entry of fs.readdirSync(standardDestDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !kernelNames.has(entry.name)) continue;
      const target = path.join(standardDestDir, entry.name);
      const skillMd = path.join(target, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const marker = path.join(target, '.aiwg-managed');
      let managed = fs.existsSync(marker);
      if (!managed) {
        try {
          managed = /^\s*namespace:\s*["']?aiwg["']?\s*$/m.test(
            parseFrontmatter(fs.readFileSync(skillMd, 'utf8')).frontmatter ?? '',
          );
        } catch { /* preserve unreadable/operator-owned content */ }
      }
      if (!managed) continue;
      fs.rmSync(target, { recursive: true, force: true });
      prunedKernelFromStandardDir++;
      if (opts?.verbose) console.log(`pruned promoted kernel from standard dir: ${entry.name}`);
    }
  }

  // Kernel-dir cleanup: prune skills whose name moved to the standard
  // tier (rc.13 logic). Holistic cleanup of orphaned skills (renamed or
  // removed sources) happens in a separate post-all-deploys step
  // (`pruneStaleAiwgSkills`) — running per-call here would race because
  // `deploySkills` may be invoked multiple times in one orchestration.
  let prunedFromKernelDir = 0;
  if (kernelDestDir && fs.existsSync(kernelDestDir) && !opts?.dryRun) {
    for (const entry of fs.readdirSync(kernelDestDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(kernelDestDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      if (!standardNames.has(entry.name)) continue;
      const target = path.join(kernelDestDir, entry.name);
      try {
        fs.rmSync(target, { recursive: true, force: true });
        prunedFromKernelDir++;
        if (opts?.verbose) console.log(`pruned legacy from kernel dir: ${entry.name}`);
      } catch (err) {
        if (opts?.verbose) console.warn(`Warning: could not prune ${target}: ${err.message}`);
      }
    }
  }

  // Standard-dir cleanup (#1217): when we're NOT copying standard
  // skills, anything AIWG-named under standardDestDir is a legacy
  // mirror from a rc.13-or-earlier deploy. Prune to clean up.
  let prunedFromStandardDir = 0;
  if (
    !copyStandardSkills &&
    standardDestDir &&
    fs.existsSync(standardDestDir) &&
    !opts?.dryRun
  ) {
    for (const entry of fs.readdirSync(standardDestDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(standardDestDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      // Only prune skills AIWG manages — bound by the deploy manifest.
      if (!allSkillNames.has(entry.name)) continue;
      const target = path.join(standardDestDir, entry.name);
      try {
        fs.rmSync(target, { recursive: true, force: true });
        prunedFromStandardDir++;
        if (opts?.verbose) console.log(`pruned legacy from standard dir: ${entry.name}`);
      } catch (err) {
        if (opts?.verbose) console.warn(`Warning: could not prune ${target}: ${err.message}`);
      }
    }
    // Try to remove the now-empty standard dir + its parent .aiwg/
    // wrapper if both end up empty. Best-effort.
    try {
      const remaining = fs.readdirSync(standardDestDir);
      if (remaining.length === 0) {
        fs.rmdirSync(standardDestDir);
        const aiwgWrapper = path.dirname(standardDestDir);
        if (path.basename(aiwgWrapper) === '.aiwg') {
          const wrapperRemaining = fs.readdirSync(aiwgWrapper);
          if (wrapperRemaining.length === 0) fs.rmdirSync(aiwgWrapper);
        }
      }
    } catch { /* non-fatal */ }
  }

  return {
    kernel: kernel.length,
    standardCopied,
    prunedFromKernelDir,
    prunedFromStandardDir,
    prunedKernelFromStandardDir,
  };
}

/**
 * Compute the global desired-kernel set by walking the entire AIWG
 * source tree (frameworks + addons), regardless of which deploy mode
 * is in flight. Used by `pruneStaleAiwgSkills` so cleanup never races
 * with sibling deploy invocations (`aiwg use` runs `deploy-agents.mjs`
 * multiple times — once per framework, once per addon batch).
 *
 * @param {string} srcRoot AIWG repo / install root
 * @returns {string[]|null} basenames of every source skill dir whose
 *   SKILL.md frontmatter has `kernel: true`, or `null` when no AIWG
 *   framework/addon tree can be located. A `null` return signals the
 *   caller (`pruneStaleAiwgSkills`) to SKIP pruning rather than treat an
 *   empty set as "delete every AIWG skill" (#123). Mirrors the contract of
 *   `computeAllArtifactBasenames` (#1627).
 */
export function computeAllKernelNames(srcRoot) {
  const hasAiwgTree = (dir) =>
    fs.existsSync(path.join(dir, 'agentic', 'code', 'frameworks')) &&
    fs.existsSync(path.join(dir, 'agentic', 'code', 'addons'));
  const isRootOrSourceDescendant = (candidate, original) => {
    const root = path.resolve(candidate);
    const source = path.resolve(original);
    const agenticCode = path.join(root, 'agentic', 'code');
    return source === root || source === agenticCode || source.startsWith(`${agenticCode}${path.sep}`);
  };

  // Prefer an explicit AIWG_ROOT, but only when it actually points at a real
  // AIWG tree — a stale/bogus env value must not silently yield an empty
  // desired set. Otherwise walk up from srcRoot (the caller may pass an
  // addon/framework/project-local-bundle path, not the install root).
  let aiwgRoot = null;
  if (process.env.AIWG_ROOT && hasAiwgTree(process.env.AIWG_ROOT)) {
    aiwgRoot = process.env.AIWG_ROOT;
  } else {
    let cur = path.resolve(srcRoot);
    for (let i = 0; i < 8; i++) {
      if (hasAiwgTree(cur) && isRootOrSourceDescendant(cur, srcRoot)) { aiwgRoot = cur; break; }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  // No AIWG framework/addon tree found — e.g. deploying a project-local
  // bundle with AIWG_ROOT unset. Return null so the prune is skipped.
  if (!aiwgRoot) return null;

  const names = new Set();
  const roots = [
    path.join(aiwgRoot, 'agentic', 'code', 'frameworks'),
    path.join(aiwgRoot, 'agentic', 'code', 'addons'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const componentEntry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!componentEntry.isDirectory()) continue;
      const skillsDir = path.join(root, componentEntry.name, 'skills');
      if (!fs.existsSync(skillsDir)) continue;
      for (const skillEntry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!skillEntry.isDirectory()) continue;
        const fullPath = path.join(skillsDir, skillEntry.name);
        if (isKernelSkill(fullPath)) names.add(skillEntry.name);
      }
    }
  }
  return Array.from(names);
}

/**
 * Holistic post-deploy cleanup of stale AIWG-managed skills.
 *
 * Run this AFTER all `deploySkills` invocations have completed for a
 * given provider so the desired-name set reflects every kernel skill
 * deployed across all frameworks/addons. Per-call cleanup races because
 * `deploySkills` may be invoked multiple times in one orchestration —
 * this function does the cleanup once at the end.
 *
 * Identifies AIWG-managed skills via:
 *   1. `.aiwg-managed` marker file (preferred — set by `deploySkillDir`)
 *   2. Frontmatter `namespace: aiwg` (migration fallback for pre-marker
 *      deploys; stops firing after one redeploy)
 *
 * Bounded to entries identified above, so user-authored skills next to
 * AIWG-managed ones are never touched.
 *
 * @param {string} kernelDestDir absolute path to the platform's kernel
 *   skills dir (e.g. `<project>/.claude/skills/`)
 * @param {string[]|null} desiredKernelNames names of every kernel skill that
 *   SHOULD remain (basenames of source dirs). When `null` (no AIWG tree
 *   located — see `computeAllKernelNames`), pruning is skipped entirely so a
 *   project-local-bundle deploy without AIWG_ROOT never empties the kernel
 *   skills directory (#123).
 * @param {object} opts `{ dryRun, verbose, artifactExtensions }`
 * @returns {number} count of pruned entries
 */
export function pruneStaleAiwgSkills(kernelDestDir, desiredKernelNames, opts = {}) {
  if (!kernelDestDir || !fs.existsSync(kernelDestDir)) return 0;
  // No global desired set — skip pruning rather than delete everything (#123).
  if (desiredKernelNames == null) return 0;
  if (opts.dryRun) return 0;
  const desired = new Set(desiredKernelNames);
  let pruned = 0;
  for (const entry of fs.readdirSync(kernelDestDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (desired.has(entry.name)) continue;

    const skillMd = path.join(kernelDestDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;

    const marker = path.join(kernelDestDir, entry.name, '.aiwg-managed');
    let isAiwgManaged = fs.existsSync(marker);
    if (!isAiwgManaged) {
      try {
        const content = fs.readFileSync(skillMd, 'utf8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch && /^\s*namespace:\s*["']?aiwg["']?\s*$/m.test(fmMatch[1])) {
          isAiwgManaged = true;
        }
      } catch { /* unreadable — leave alone */ }
    }
    if (!isAiwgManaged) continue;

    try {
      fs.rmSync(path.join(kernelDestDir, entry.name), { recursive: true, force: true });
      pruned++;
      if (opts.verbose) console.log(`pruned stale AIWG skill: ${entry.name}`);
    } catch (err) {
      if (opts.verbose) console.warn(`Warning: could not prune ${entry.name}: ${err.message}`);
    }
  }
  return pruned;
}

// ============================================================================
// Flat-File Stale-Artifact Prune (agents / commands / rules) — #1627
// ============================================================================

/**
 * Reduce a deployed artifact filename to a provider-extension-agnostic stem.
 *
 * Different providers emit the same source rule/agent/command under different
 * extensions (`.md`, `.mdc`, `.agent.md`, `.prompt.md`, `.instructions.md`).
 * Matching by stem lets the stale-prune compare a source basename
 * (`foo.md` → `foo`) against any provider's on-disk form (`foo.agent.md` →
 * `foo`) without hard-coding the per-provider extension map.
 *
 * Strips a trailing `.md`/`.mdc`, then a secondary copilot-style
 * `.agent`/`.prompt`/`.instructions` qualifier.
 *
 * @param {string} name basename
 * @returns {string} extension-agnostic stem
 */
export function artifactStem(name) {
  return String(name)
    .replace(/\.(md|mdc)$/i, '')
    .replace(/\.(agent|prompt|instructions)$/i, '');
}

/**
 * Compute the global set of source-basename stems AIWG ships for a flat
 * artifact type, across ALL frameworks and addons (mode-independent).
 *
 * Used as the "desired" set by `pruneStaleAiwgFiles`. Mode independence is
 * deliberate and mirrors `computeAllKernelNames` for skills: `aiwg use sdlc`
 * must not prune a marketing agent that a prior `aiwg use all` deployed and
 * that is still a valid AIWG artifact. Only artifacts whose source no longer
 * exists ANYWHERE in the tree (renamed/removed) fall out of this set and
 * become prune-eligible.
 *
 * Anchors to the AIWG root (resolved by walking up from `srcRoot` for the
 * `agentic/code/frameworks` + `agentic/code/addons` pair, or `AIWG_ROOT`),
 * NOT the raw `srcRoot`. This matters because `deploy-agents.mjs` can be
 * invoked with `--source <project-local-bundle>`; computing the desired set
 * against a bundle dir would be empty and make every AIWG artifact look stale.
 * Returns `null` when no AIWG framework/addon tree is found — the caller MUST
 * then skip pruning (a bundle-only deploy has no global desired set).
 *
 * @param {string} srcRoot AIWG repo / install root (or a subdir of it)
 * @param {'agents'|'commands'|'rules'} type artifact type
 * @returns {Set<string>|null} stems of every source file of that type, or null
 *   if the AIWG framework/addon tree can't be located
 */
export function computeAllArtifactBasenames(srcRoot, type) {
  const aiwgRoot = resolveAiwgRoot(srcRoot);
  if (!aiwgRoot) return null;

  const stems = new Set();
  const add = (files) => {
    for (const f of files) stems.add(artifactStem(path.basename(f)));
  };

  const frameworkArtifacts = collectFrameworkArtifacts(aiwgRoot, 'all', {
    includeAgents: type === 'agents',
    includeCommands: type === 'commands',
    includeRules: type === 'rules',
    includeSkills: false,
    recursiveCommands: true,
  });

  if (type === 'agents') {
    add(frameworkArtifacts.agents);
    // Soul companions live alongside agents and are deployed with them —
    // keep their stems in the desired set so the prune never removes them.
    add(frameworkArtifacts.souls || []);
    add(getAddonAgentFiles(aiwgRoot));
  } else if (type === 'commands') {
    add(frameworkArtifacts.commands);
    add(getAddonCommandFiles(aiwgRoot));
  } else if (type === 'rules') {
    add(frameworkArtifacts.rules);
    add(getAddonRuleFiles(aiwgRoot));
  }

  return stems;
}

/**
 * Resolve the AIWG install/repo root from a possibly-nested srcRoot.
 *
 * Mirrors the walk-up logic in `computeAllKernelNames`: honor `AIWG_ROOT`,
 * else climb up to 8 levels looking for the directory that holds BOTH
 * `agentic/code/frameworks` and `agentic/code/addons`. Returns `null` when
 * no such root is found (e.g. a standalone project-local bundle).
 *
 * @param {string} srcRoot
 * @returns {string|null}
 */
export function resolveAiwgRoot(srcRoot) {
  const hasTree = (dir) =>
    fs.existsSync(path.join(dir, 'agentic', 'code', 'frameworks')) &&
    fs.existsSync(path.join(dir, 'agentic', 'code', 'addons'));
  const isRootOrSourceDescendant = (candidate, original) => {
    const root = path.resolve(candidate);
    const source = path.resolve(original);
    const agenticCode = path.join(root, 'agentic', 'code');
    return source === root || source === agenticCode || source.startsWith(`${agenticCode}${path.sep}`);
  };

  if (process.env.AIWG_ROOT && hasTree(process.env.AIWG_ROOT)) {
    return process.env.AIWG_ROOT;
  }
  let cur = path.resolve(srcRoot);
  for (let i = 0; i < 8; i++) {
    if (hasTree(cur) && isRootOrSourceDescendant(cur, srcRoot)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * Names of every skill AIWG ships, kernel and standard alike (#2511).
 *
 * `computeAllKernelNames` filters to kernel skills, but skill-command wrappers
 * are generated from both tiers, so retiring an orphaned wrapper needs the full
 * set. Anchored to the AIWG root rather than `srcRoot` for the same reason
 * `computeAllArtifactBasenames` is: a bundle-scoped deploy must not produce an
 * empty desired set and retire everything.
 *
 * @param {string} srcRoot AIWG repo / install root (or a subdir of it)
 * @returns {Set<string>|null} skill directory names, or null when no AIWG tree
 *   is found — callers MUST then skip pruning.
 */
export function computeAllSkillNames(srcRoot) {
  const aiwgRoot = resolveAiwgRoot(srcRoot);
  if (!aiwgRoot) return null;

  const names = new Set();
  for (const group of ['frameworks', 'addons']) {
    const root = path.join(aiwgRoot, 'agentic', 'code', group);
    if (!fs.existsSync(root)) continue;
    for (const component of fs.readdirSync(root, { withFileTypes: true })) {
      if (!component.isDirectory()) continue;
      const skillsDir = path.join(root, component.name, 'skills');
      if (!fs.existsSync(skillsDir)) continue;
      for (const skill of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (skill.isDirectory()) names.add(skill.name);
      }
    }
  }
  return names;
}

/**
 * Holistic post-deploy prune of stale AIWG-managed flat artifacts
 * (agents / commands / rules). The flat-file analogue of
 * `pruneStaleAiwgSkills`.
 *
 * Removes a file from `destDir` only when ALL hold:
 *   1. It has an allowed deployed-artifact extension (`.md` / `.mdc` by
 *      default; callers may include `.toml`), is not `RULES-INDEX.md`,
 *      and not the sidecar manifest.
 *   2. Its stem is NOT in `desiredStems` (the source no longer ships it).
 *   3. It carries an AIWG ownership signal — either a `.aiwg-manifest.json`
 *      sidecar entry, or an in-file `aiwg:managed` marker.
 *
 * User-authored files (no ownership signal) and current AIWG artifacts (stem
 * in the desired set) are never touched. Pruned files also have their sidecar
 * entry dropped so the manifest stays accurate.
 *
 * Safe to call on every deploy invocation: `desiredStems` is the global
 * (mode-independent) source set, so sibling-framework files are never
 * collateral.
 *
 * @param {string} destDir absolute path to the provider artifact dir
 * @param {Set<string>|string[]} desiredStems stems that should remain
 * @param {object} opts `{ dryRun, verbose }`
 * @returns {string[]} removed (or would-be-removed) file paths
 */
export function pruneStaleAiwgFiles(destDir, desiredStems, opts = {}) {
  const { dryRun = false, verbose = false } = opts;
  const artifactExtensions = opts.artifactExtensions || ['.md', '.mdc'];
  // When supplied, skill-command wrappers are retired against the set of skills
  // that still exist rather than exempted outright (#2511). `null`/absent keeps
  // the blanket exemption, so callers without a skill inventory cannot retire a
  // wrapper by accident.
  const skillCommandStems = opts.skillCommandStems instanceof Set
    ? opts.skillCommandStems
    : Array.isArray(opts.skillCommandStems)
      ? new Set(opts.skillCommandStems)
      : null;
  const removed = [];
  if (!destDir || !fs.existsSync(destDir)) return removed;

  const desired = desiredStems instanceof Set ? desiredStems : new Set(desiredStems);
  const sidecar = readSidecarManifest(destDir) || { managed: {} };
  const managed = sidecar.managed || {};
  let sidecarDirty = false;

  let entries;
  try {
    entries = fs.readdirSync(destDir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name === MANIFEST_FILENAME) continue;
    if (name === 'RULES-INDEX.md') continue;
    if (name === 'RULES-ONDEMAND.md') continue; // generated on-demand index (#1673)
    const lower = name.toLowerCase();
    if (!artifactExtensions.some(extension => lower.endsWith(extension))) continue;

    if (desired.has(artifactStem(name))) continue;

    // Skill-command wrappers are named after skills, not command sources, so
    // they are absent from the command desired set by construction — pruning
    // them against it would delete wrappers the same deploy just wrote (#2507).
    // They are retired against the skill inventory instead, when one is given
    // (#2511); without one they stay exempt.
    if (managed[name]?.kind === 'skill-command') {
      if (!skillCommandStems || skillCommandStems.has(artifactStem(name))) continue;
    }

    // Ownership gate — never delete a file AIWG didn't deploy.
    let owned = Object.prototype.hasOwnProperty.call(managed, name);
    if (!owned) {
      try {
        owned = MANAGED_MARKER_RE.test(fs.readFileSync(path.join(destDir, name), 'utf8'));
      } catch {
        owned = false; // unreadable → leave it alone
      }
    }
    if (!owned) continue;

    const target = path.join(destDir, name);
    removed.push(target);
    if (dryRun) {
      if (verbose) console.log(`[dry-run] would prune stale AIWG artifact: ${path.relative(process.cwd(), target)}`);
      continue;
    }
    try {
      fs.unlinkSync(target);
      if (Object.prototype.hasOwnProperty.call(managed, name)) {
        delete managed[name];
        sidecarDirty = true;
      }
      if (verbose) console.log(`pruned stale AIWG artifact: ${path.relative(process.cwd(), target)}`);
    } catch (err) {
      removed.pop();
      if (verbose) console.warn(`Warning: could not prune ${target}: ${err.message}`);
    }
  }

  if (sidecarDirty) writeSidecarManifest(destDir, sidecar, dryRun);
  return removed;
}

/**
 * Deploy a skill directory (copy recursively).
 *
 * Platform handling (controlled by opts.provider):
 *   - If the skill's SKILL.md has platforms: [all] → deploy to all, inject [provider] in deployed copy
 *   - If no platforms: field → deploy to all, inject [provider] in deployed copy
 *   - If explicit restriction list → only deploy if opts.provider is in the list; keep list in deployed copy
 */
export function deploySkillDir(skillDir, destDir, opts) {
  const { force = false, dryRun = false, provider, transformSkillMd } = opts;
  const verbose = opts.verbose === true;
  const skillName = path.basename(skillDir);

  // Check SKILL.md for explicit platform restriction before deploying anything
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (provider && fs.existsSync(skillMdPath)) {
    const skillContent = fs.readFileSync(skillMdPath, 'utf8');
    if (!skillMatchesProvider(skillContent, provider)) {
      if (verbose) console.log(`skip (platform restricted): ${skillName}`);
      return;
    }
  }

  const destSkillDir = path.join(destDir, skillName);
  if (!dryRun) ensureDir(destSkillDir);

  function copyRecursive(src, dest) {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        if (!dryRun) ensureDir(destPath);
        copyRecursive(srcPath, destPath);
      } else {
        let srcContent = fs.readFileSync(srcPath, 'utf8');

        // Inject target platform into SKILL.md — replaces [all] token with [provider-name]
        if (entry.name === 'SKILL.md' && provider) {
          const platformName = PROVIDER_TO_PLATFORM[provider] || provider;
          srcContent = injectPlatformInContent(srcContent, platformName);

          // Provider-specific frontmatter transform (e.g. Factory remaps
          // commandHint.allowedTools / commandHint.model). Optional callback —
          // most providers leave SKILL.md alone after platform injection.
          if (typeof transformSkillMd === 'function') {
            srcContent = transformSkillMd(srcContent, opts) || srcContent;
          }
        }

        if (fs.existsSync(destPath)) {
          const destContent = fs.readFileSync(destPath, 'utf8');
          if (destContent === srcContent && !force) {
            if (verbose) console.log(`skip (unchanged): ${path.relative(destDir, destPath)}`);
            continue;
          }
        }

        if (dryRun) {
          console.log(`[dry-run] deploy ${srcPath} -> ${destPath}`);
        } else {
          fs.writeFileSync(destPath, srcContent, 'utf8');
          if (verbose) console.log(`deployed ${entry.name} -> ${path.relative(process.cwd(), destPath)}`);
        }
      }
    }
  }

  copyRecursive(skillDir, destSkillDir);

  // Drop a `.aiwg-managed` marker so future cleanup runs can identify
  // AIWG-deployed skills regardless of frontmatter shape (some providers
  // strip `namespace:` during transform). Cleanup keys off this presence
  // to safely prune renamed/removed source skills.
  if (!dryRun) {
    try {
      fs.writeFileSync(path.join(destSkillDir, '.aiwg-managed'), 'aiwg\n', 'utf8');
    } catch { /* non-fatal */ }
  }

  if (verbose) console.log(`deployed skill: ${skillName}`);
}

// ============================================================================
// Workspace Initialization
// ============================================================================

/**
 * Initialize framework-scoped workspace structure
 * Creates .aiwg/frameworks/{framework-id}/ directories
 */
export function initializeFrameworkWorkspace(target, mode, dryRun, srcRoot = null) {
  const aiwgBase = resolveFrameworkWorkspaceRoot(target);
  const frameworksDir = path.join(aiwgBase, 'frameworks');
  const sharedDir = path.join(aiwgBase, 'shared');

  const frameworkDirs = srcRoot
    ? getFrameworksForMode(srcRoot, mode).map(fw => ({
      id: fw.id,
      path: fw.path,
      subdirs: fw.workspaceSubdirs,
      memoryCreates: Array.isArray(fw.manifest?.memory?.creates) ? fw.manifest.memory.creates : []
    }))
    : [];

  // Backward-compatible fallback when source root isn't provided.
  if (frameworkDirs.length === 0) {
    if (mode === 'sdlc' || mode === 'both' || mode === 'all') {
      frameworkDirs.push({
        id: 'sdlc-complete',
        subdirs: ['repo', 'projects', 'working', 'archive']
      });
    }

    if (mode === 'marketing' || mode === 'all') {
      frameworkDirs.push({
        id: 'media-marketing-kit',
        subdirs: ['repo', 'campaigns', 'working', 'archive']
      });
    }

    if (mode === 'media-curator' || mode === 'all') {
      frameworkDirs.push({
        id: 'media-curator',
        subdirs: ['repo', 'library', 'working', 'archive']
      });
    }

    if (mode === 'research' || mode === 'all') {
      frameworkDirs.push({
        id: 'research-complete',
        subdirs: ['repo', 'corpus', 'working', 'archive']
      });
    }
  }

  if (frameworkDirs.length === 0) return;

  if (dryRun) {
    console.log('\n[dry-run] Would create framework-scoped workspace structure:');
    console.log(`[dry-run]   ${aiwgBase}/`);
    console.log(`[dry-run]   ${frameworksDir}/`);
    console.log(`[dry-run]   ${sharedDir}/`);
    for (const fw of frameworkDirs) {
      for (const subdir of fw.subdirs) {
        console.log(`[dry-run]   ${path.join(frameworksDir, fw.id, subdir)}/`);
      }
      for (const entry of fw.memoryCreates || []) {
        if (entry && typeof entry.path === 'string') {
          console.log(`[dry-run]   ${path.join(aiwgBase, entry.path.slice('.aiwg/'.length))}${entry.path.endsWith('/') ? '/' : ''}`);
        }
      }
    }
    return;
  }

  ensureDir(aiwgBase);
  ensureDir(frameworksDir);
  ensureDir(sharedDir);

  for (const fw of frameworkDirs) {
    const fwBase = path.join(frameworksDir, fw.id);
    ensureDir(fwBase);
    for (const subdir of fw.subdirs) {
      ensureDir(path.join(fwBase, subdir));
    }
    initializeMemoryCreates(aiwgBase, fw.path, fw.memoryCreates);
  }

  // Initialize registry.json if it doesn't exist
  const registryPath = path.join(frameworksDir, 'registry.json');
  if (!fs.existsSync(registryPath)) {
    const registry = {
      version: '1.0.0',
      created: new Date().toISOString(),
      frameworks: frameworkDirs.map(fw => ({
        id: fw.id,
        installed: new Date().toISOString(),
        version: '1.0.0'
      }))
    };
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');
    console.log('Created framework registry at .aiwg/frameworks/registry.json');
  }
}


function initializeMemoryCreates(aiwgBase, frameworkPath, creates) {
  for (const entry of creates || []) {
    if (!entry || typeof entry.path !== 'string') continue;
    if (!entry.path.startsWith('.aiwg/')) continue;

    const targetPath = path.join(aiwgBase, entry.path.slice('.aiwg/'.length));
    const isDirectory = entry.path.endsWith('/') || path.extname(entry.path) === '';
    if (isDirectory) {
      ensureDir(targetPath);
      continue;
    }

    ensureDir(path.dirname(targetPath));
    if (fs.existsSync(targetPath)) continue;

    let content = null;
    if (typeof entry.template === 'string' && frameworkPath) {
      const templatePath = path.join(frameworkPath, entry.template);
      if (fs.existsSync(templatePath)) {
        content = fs.readFileSync(templatePath, 'utf8');
      }
    }

    if (content === null) {
      const title = path.basename(entry.path, path.extname(entry.path))
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
      content = '# ' + title + '\n\n';
    }

    fs.writeFileSync(targetPath, content.endsWith('\n') ? content : content + '\n', 'utf8');
  }
}

// ============================================================================
// AGENTS.md Template Handling
// ============================================================================

/**
 * Build a Markdown "Repo Topology" block from .aiwg/aiwg.config remotes (#998).
 *
 * Returns an empty string when there's no `remotes` block configured — agents
 * should fall back to the today-default behavior in that case.
 *
 * The output is a small Markdown section suitable for token substitution into
 * AIWG.md / AGENTS.md / similar context files. URL resolution is best-effort:
 * when `git remote get-url <name>` fails (not a git repo, missing remote), the
 * remote name is shown without a URL.
 *
 * @param {string} targetDir - Project directory (the one that owns .aiwg/aiwg.config)
 * @returns {string} Markdown block (with leading/trailing blank lines), or '' when absent
 */
export function buildRemotesTopologyBlock(targetDir) {
  const cfgPath = path.join(targetDir, '.aiwg', 'aiwg.config');
  if (!fs.existsSync(cfgPath)) return '';

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return '';
  }
  if (!cfg || !cfg.remotes) return '';

  // Apply the same defaults as resolveRemotes() in src/config/aiwg-config.ts.
  // Inlined here so the deploy path doesn't depend on the compiled TS bundle.
  const primary = cfg.remotes.primary || 'origin';
  const issueTracker = cfg.remotes.issue_tracker || primary;
  const ci = cfg.remotes.ci || primary;
  const secondary = Array.isArray(cfg.remotes.secondary) ? cfg.remotes.secondary : [];

  function getUrl(remote) {
    try {
      return nodeExecSync(`git -C ${JSON.stringify(targetDir)} remote get-url ${JSON.stringify(remote)}`, {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim();
    } catch {
      return '';
    }
  }

  const lines = [];
  lines.push('## Repo Topology');
  lines.push('');
  lines.push('Agents: respect this when picking remotes/providers. From `.aiwg/aiwg.config` `remotes` block (#994).');
  lines.push('');
  const primaryUrl = getUrl(primary);
  const primarySuffix = primaryUrl ? ` (${primaryUrl})` : '';
  lines.push(`- **Primary**: \`${primary}\`${primarySuffix} — issues, PRs, CI live here`);
  if (issueTracker !== primary) {
    const u = getUrl(issueTracker);
    lines.push(`- **Issue tracker**: \`${issueTracker}\`${u ? ` (${u})` : ''}`);
  }
  if (ci !== primary) {
    const u = getUrl(ci);
    lines.push(`- **CI**: \`${ci}\`${u ? ` (${u})` : ''}`);
  }
  for (const sec of secondary) {
    if (!sec || !sec.name) continue;
    const u = getUrl(sec.name);
    const purpose = sec.purpose ? ` — ${sec.purpose}` : '';
    const releaseTag = sec.push_on_release ? ' (push tags on release)' : '';
    lines.push(`- **Secondary**: \`${sec.name}\`${u ? ` (${u})` : ''}${purpose}${releaseTag}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Substitute the topology + count tokens in template content. Shared by the
 * Claude hook file and createAgentsMdFromTemplate so every consumer gets the
 * same {{REMOTES_TOPOLOGY}} treatment without each provider reinventing it.
 */
export function interpolateContextTokens(content, opts) {
  const counts = opts?.counts || {};
  const topology = opts?.topology || '';
  const onDemandRules = opts?.onDemandRules || '';
  return content
    .replace(/\{\{AGENTS_COUNT\}\}/g, String(counts.agents || 0))
    .replace(/\{\{COMMANDS_COUNT\}\}/g, String(counts.commands || 0))
    .replace(/\{\{SKILLS_COUNT\}\}/g, String(counts.skills || 0))
    .replace(/\{\{RULES_COUNT\}\}/g, String(counts.rules || 0))
    .replace(/\{\{REMOTES_TOPOLOGY\}\}/g, topology)
    .replace(/\{\{ON_DEMAND_RULES\}\}/g, onDemandRules);
}

/**
 * Create or update AGENTS.md from template
 * Common logic used by multiple providers
 */
// Managed-block markers (#1571). The AIWG SDLC section is wrapped in these so
// every later `aiwg use`/`aiwg refresh` can UPDATE it in place — append-once-and-
// skip meant existing AGENTS.md bridges never received content updates.
const AIWG_MD_BEGIN = '<!-- BEGIN AIWG-managed (auto-generated; edits between these markers are overwritten on redeploy) -->';
const AIWG_MD_END = '<!-- END AIWG-managed -->';

/**
 * Inject/update an AIWG-managed section in a workspace markdown file (AGENTS.md,
 * SOUL.md, …) from a template. Wraps the section in BEGIN/END markers and updates
 * in place on redeploy (no-op if unchanged), preserving operator content outside
 * the markers and migrating legacy unmarked sections. (#1571 / #1572)
 *
 * @param {string} target - directory containing the dest file
 * @param {string} destFilename - e.g. 'AGENTS.md' or 'SOUL.md'
 * @param {string} srcRoot
 * @param {string} templateSubpath - relative to sdlc-complete/templates
 * @param {boolean} dryRun
 * @param {{sectionMarker?: string, legacyHeading?: string}} [opts]
 */
export function createManagedMdFromTemplate(target, destFilename, srcRoot, templateSubpath, dryRun, opts = {}) {
  const sectionMarker = opts.sectionMarker || '<!-- AIWG SDLC Framework Integration -->';
  const legacyHeading = opts.legacyHeading || '## AIWG SDLC Framework';
  const templatePath = path.join(srcRoot, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'templates', templateSubpath);
  const destPath = path.join(target, destFilename);

  if (!fs.existsSync(templatePath)) {
    console.warn(`${destFilename} template not found at ${templatePath}`);
    return;
  }

  let template = fs.readFileSync(templatePath, 'utf8');
  // Token interpolation — gives every template-based provider {{REMOTES_TOPOLOGY}},
  // {{ON_DEMAND_RULES}} (#1675), and the shared count tokens for free. The
  // on-demand list is computed lazily only when the template references it.
  template = interpolateContextTokens(template, {
    topology: buildRemotesTopologyBlock(target),
    onDemandRules: template.includes('{{ON_DEMAND_RULES}}')
      ? renderOnDemandRuleSection(listOnDemandRuleFiles(srcRoot), { heading: '### On-Demand Rules' })
      : '',
  });

  // Extract the AIWG section from the template (everything from its section
  // marker onward) and wrap it in managed markers so redeploys can update it.
  const tmplMarker = template.indexOf(sectionMarker);
  const aiwgSection = (tmplMarker !== -1 ? template.slice(tmplMarker) : template).trim();
  const templatePrefix = tmplMarker !== -1 ? template.slice(0, tmplMarker).trim() : '';
  const managedBlock = `${AIWG_MD_BEGIN}\n${aiwgSection}\n${AIWG_MD_END}`;

  const write = (content, verb) => {
    if (dryRun) {
      console.log(`[dry-run] Would ${verb} ${destFilename} AIWG-managed section`);
    } else {
      fs.writeFileSync(destPath, content, 'utf8');
      console.log(`${verb[0].toUpperCase()}${verb.slice(1)} ${destFilename} AIWG-managed section`);
    }
  };

  // 1. Fresh file — write prefix (if any) + managed block.
  if (!fs.existsSync(destPath)) {
    const out = (templatePrefix ? templatePrefix + '\n\n---\n\n' : '') + managedBlock + '\n';
    write(out, 'create');
    return;
  }

  const existing = fs.readFileSync(destPath, 'utf8');
  const begIdx = existing.indexOf(AIWG_MD_BEGIN);
  const endIdx = existing.indexOf(AIWG_MD_END);

  // 2. Markers present — replace the managed block in place, preserve everything outside.
  if (begIdx !== -1 && endIdx !== -1 && endIdx > begIdx) {
    const updated = existing.slice(0, begIdx) + managedBlock + existing.slice(endIdx + AIWG_MD_END.length);
    if (updated === existing) return; // already current — no-op
    write(updated, 'update');
    return;
  }

  // 3. Legacy unmarked AIWG section — migrate to the managed block. The section
  //    is always EOF-appended, so the operator prefix is everything before it.
  const legacyMarkerIdx = existing.indexOf(sectionMarker);
  const legacyIdx = legacyMarkerIdx !== -1 ? legacyMarkerIdx : existing.indexOf(legacyHeading);
  if (legacyIdx !== -1) {
    const prefix = existing.slice(0, legacyIdx).replace(/\n+---\s*$/, '').trimEnd();
    write(prefix + '\n\n---\n\n' + managedBlock + '\n', 'migrate');
    return;
  }

  // 4. No AIWG section at all — append the managed block.
  write(existing.trimEnd() + '\n\n---\n\n' + managedBlock + '\n', 'append');
}

/** AGENTS.md bridge — thin wrapper over createManagedMdFromTemplate (#1571). */
export function createAgentsMdFromTemplate(target, srcRoot, templateSubpath, dryRun) {
  createManagedMdFromTemplate(target, 'AGENTS.md', srcRoot, templateSubpath, dryRun, {
    sectionMarker: '<!-- AIWG SDLC Framework Integration -->',
    legacyHeading: '## AIWG SDLC Framework',
  });
}

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

const MODE_ALIASES = {
  writing: 'general',
  mmk: 'marketing'
};

const LEGACY_FRAMEWORK_MODE_ALIASES = {
  'sdlc-complete': ['sdlc'],
  'media-marketing-kit': ['marketing', 'mmk'],
  'media-curator': ['media-curator'],
  'research-complete': ['research']
};

const DEFAULT_FRAMEWORK_SUBDIRS = {
  'sdlc-complete': ['repo', 'projects', 'working', 'archive'],
  'media-marketing-kit': ['repo', 'campaigns', 'working', 'archive'],
  'media-curator': ['repo', 'library', 'working', 'archive'],
  'research-complete': ['repo', 'corpus', 'working', 'archive']
};

function normalizePathSegment(segment) {
  return String(segment || '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function ensureStringArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.map(v => String(v)) : [String(value)];
}

function uniqueLower(values) {
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

function resolveFrameworkComponentDir(frameworkPath, manifest, component) {
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

// ============================================================================
// Addon Discovery
// ============================================================================

/**
 * Discover all addons in the agentic/code/addons directory
 * @param {string} srcRoot - Source root directory
 * @returns {Array<{name: string, path: string, manifest: object}>} - Array of addon info
 */
export function discoverAddons(srcRoot) {
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
export function getAddonAgentFiles(srcRoot, excludeAddons = []) {
  const addons = discoverAddons(srcRoot);
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
export function getAddonCommandFiles(srcRoot, excludeAddons = []) {
  const addons = discoverAddons(srcRoot);
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
 * Get all skill directories from all addons
 * @param {string} srcRoot - Source root directory
 * @param {string[]} excludeAddons - Addon names to exclude (default: none)
 * @returns {string[]} - Array of skill directory paths
 */
export function getAddonSkillDirs(srcRoot, excludeAddons = []) {
  const addons = discoverAddons(srcRoot);
  const dirs = [];

  for (const addon of addons) {
    if (excludeAddons.includes(addon.name)) continue;

    const skillsDir = path.join(addon.path, 'skills');
    if (fs.existsSync(skillsDir)) {
      dirs.push(...listSkillDirs(skillsDir));
    }
  }

  return dirs;
}

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
  if (!m) return null;
  const e = m[1].match(/^enforcement:\s*([A-Za-z]+)/m);
  return e ? e[1].toLowerCase() : null;
}

/**
 * Tier gate (#1673, enforcement-tiered deployment ADR). Only CRITICAL and HIGH
 * rules are inlined into a provider's always-on rule directory; MEDIUM/LOW are
 * left on-demand (reachable via `aiwg show rule <name>` and the assembled
 * RULES-INDEX pointer index). Index files and rules with no enforcement marker
 * default to always-on, so an un-triaged or structural file is never dropped.
 */
export function isAlwaysOnRule(filePath) {
  const base = path.basename(filePath);
  if (base === 'RULES-INDEX.md' || base === 'RULES-ONDEMAND.md') return true;
  try {
    const lvl = ruleEnforcementLevel(fs.readFileSync(filePath, 'utf8'));
    return lvl !== 'medium' && lvl !== 'low';
  } catch {
    return true; // unreadable → keep (safe default)
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
      if (!isAlwaysOnRule(f)) out.push(f);
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
    'aiwg show rule <name>',
    '```',
    '',
    ...names.map((n) => `- \`${n}\` — \`aiwg show rule ${n}\``),
  ].join('\n');
}

/**
 * Write a compact on-demand rule index (#1673) into a provider's rule dir.
 * Lists the MEDIUM/LOW rules that are NOT inlined at startup, with the
 * `aiwg show rule <name>` fetch hint. Removes a stale index when empty.
 */
export function writeOnDemandRuleIndex(destDir, onDemandFiles, opts = {}) {
  const indexPath = path.join(destDir, 'RULES-ONDEMAND.md');
  const names = onDemandRuleNames(onDemandFiles);
  if (names.length === 0) {
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
    'aiwg show rule <name>',
    '```',
    '',
    ...names.map((n) => `- \`${n}\` — \`aiwg show rule ${n}\``),
    '',
  ];
  let content = lines.join('\n');
  content = addManagedMarker(content, opts.deployVersion || 'unknown', opts.deploySource || 'bundled');
  if (!opts.dryRun) fs.writeFileSync(indexPath, content, 'utf8');
  return names.length;
}

export function getAddonRuleFiles(srcRoot, excludeAddons = []) {
  const addons = discoverAddons(srcRoot);
  const files = [];

  for (const addon of addons) {
    if (excludeAddons.includes(addon.name)) continue;

    // Skip addons with consolidated rule indexes — their rules are
    // included via assembleRulesIndex() instead of individual files
    if (addon.manifest?.consolidation?.deployIndexOnly) continue;

    const rulesDir = path.join(addon.path, 'rules');
    if (fs.existsSync(rulesDir)) {
      files.push(...listMdFiles(rulesDir));
    }
  }

  // Tier gate (#1673): inline only always-on (CRITICAL/HIGH) rules. MEDIUM/LOW
  // stay on-demand. Applied here so both the deploy enumeration and the prune
  // desired-set (computeAllArtifactBasenames) exclude them for every provider.
  return files.filter(isAlwaysOnRule);
}

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

const BEHAVIOR_EMULATION_TARGETS = {
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

function renderBehaviorEmulation(behaviorDir, provider, target) {
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

// ============================================================================
// Consolidated Rules Deployment
// ============================================================================

/**
 * Load rules manifest from source directory
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

/**
 * Clean up old individually-deployed rule files from target directory.
 * Removes any .md files that are NOT RULES-INDEX.md.
 *
 * @param {string} rulesDir - Target rules directory
 * @param {object} opts - Options
 * @param {boolean} opts.dryRun - If true, log but don't delete
 * @returns {string[]} - List of removed (or would-be-removed) file paths
 */
/**
 * Remove stale rule files from a deploy directory before writing fresh ones.
 *
 * Per #1143 + #1117: addon deploys run as separate `deploy-agents.mjs`
 * invocations after the main framework, and the previous "wipe all non-index
 * .md before writing" behavior caused the main framework's rules to be
 * silently destroyed by every subsequent addon deploy (whether or not the
 * addon shipped any rules of its own).
 *
 * The fix: cleanup only fires when the operator explicitly asks via
 * `opts.cleanRules: true`. The deploy-time cleanup is replaced by a
 * dedicated `aiwg refresh --clean-rules` operator flow (follow-up issue).
 *
 * Existing callers that pass `incomingFiles: []` still get a no-op; existing
 * callers that pass nothing get the legacy (now-disabled) cleanup as a no-op
 * by default.
 *
 * @param {string} rulesDir
 * @param {object} opts
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.cleanRules] explicit opt-in to remove stale files
 * @param {string[]} [opts.incomingFiles] when cleanRules=true, only files NOT
 *   in this list are removed
 */
export function cleanupOldRuleFiles(rulesDir, opts = {}) {
  const { dryRun = false, cleanRules = false, incomingFiles } = opts;
  const removed = [];

  if (!fs.existsSync(rulesDir)) return removed;
  if (!cleanRules) return removed;
  if (Array.isArray(incomingFiles) && incomingFiles.length === 0) return removed;

  // Only `.md` rules are eligible for generic cleanup — `.mdc` (native Cursor
  // rules) and non-rule files (config.json, …) are preserved. AIWG's own legacy
  // `.md`→`.mdc` migration is handled explicitly by the Cursor provider's
  // deployRulesInline (marker-gated), not here, so operator `.mdc` stay safe.
  const incomingBasenames = new Set(
    Array.isArray(incomingFiles)
      ? incomingFiles.map((f) => path.basename(f))
      : []
  );

  // Ownership gate (#1627): only AIWG-managed rule files are eligible for
  // removal. A rule the operator dropped into the dir (no sidecar entry, no
  // `aiwg:managed` marker) is preserved even when cleanRules is on.
  const sidecarManaged = readSidecarManifest(rulesDir)?.managed || {};

  const entries = fs.readdirSync(rulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    if (entry.name === 'RULES-INDEX.md') continue;
    if (entry.name === 'RULES-ONDEMAND.md') continue; // generated on-demand index (#1675) — protected like RULES-INDEX
    if (incomingBasenames.has(entry.name)) continue;

    const filePath = path.join(rulesDir, entry.name);

    let owned = Object.prototype.hasOwnProperty.call(sidecarManaged, entry.name);
    if (!owned) {
      try {
        owned = MANAGED_MARKER_RE.test(fs.readFileSync(filePath, 'utf8'));
      } catch {
        owned = false; // unreadable → leave it alone
      }
    }
    if (!owned) continue; // user-authored rule — preserve

    removed.push(filePath);

    if (dryRun) {
      console.log(`[dry-run] would remove old rule: ${entry.name}`);
    } else {
      fs.unlinkSync(filePath);
      console.log(`removed old rule: ${entry.name}`);
    }
  }

  if (removed.length > 0) {
    console.log(`cleaned up ${removed.length} old rule file(s) from ${rulesDir}`);
  }

  return removed;
}

/**
 * Migrate commands directory by removing stale AIWG command files before
 * skills deployment.
 *
 * AIWG migrated from commands to skills. If old AIWG command files are left
 * in place alongside newly deployed skills, the provider TUI (e.g. Claude
 * Code's command palette) shows duplicate entries — one from the stale
 * command file and one from the skill. This removes those duplicates.
 *
 * Removal is bounded to AIWG-managed command files (#1627): a command the
 * operator authored (no sidecar entry, no `aiwg:managed` marker) is preserved.
 * Subdirectories and non-command files are left untouched. The directory is
 * removed only if it ends up empty after pruning AIWG files.
 *
 * Home-directory providers (codex, openclaw) are excluded by the caller: their
 * commands paths are shared across all projects and must not be touched.
 *
 * @param {string} commandsDir - Full path to the provider's commands directory
 * @param {object} opts
 * @param {boolean} opts.dryRun - Log but don't delete
 * @param {boolean} opts.skipCommandsMigration - User opted out; warn about duplicates instead
 * @returns {boolean} true if any AIWG command file was removed (or would be in dry-run)
 */
export function migrateCommandsDirectory(commandsDir, opts = {}) {
  const { dryRun = false, skipCommandsMigration = false, verbose = false } = opts;

  if (!fs.existsSync(commandsDir)) return false;

  const entries = fs.readdirSync(commandsDir, { withFileTypes: true });
  if (entries.length === 0) return false;

  if (skipCommandsMigration) {
    const rel = path.relative(process.cwd(), commandsDir);
    console.warn(`\nWarning: commands migration skipped for ${rel}`);
    console.warn('  Duplicate entries may appear in the command palette because old command');
    console.warn('  files overlap with newly deployed skills. Remove AIWG command files manually');
    console.warn(`  to fix: rm ${rel}/<command>.md`);
    return false;
  }

  // Bound removal to AIWG-managed command files; preserve operator files.
  const sidecar = readSidecarManifest(commandsDir) || { managed: {} };
  const managed = sidecar.managed || {};
  let sidecarDirty = false;
  const rel = path.relative(process.cwd(), commandsDir);

  const managedNames = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith('.md')) continue; // only command markdown files
    const filePath = path.join(commandsDir, entry.name);
    // Skill-command wrappers ARE the current skill surface, not legacy command
    // files superseded by it. Migrating them away deletes what the same deploy
    // just wrote — and on a kernel-only run, which does not re-translate, they
    // are never restored (#2507).
    if (managed[entry.name]?.kind === 'skill-command') continue;
    let owned = Object.prototype.hasOwnProperty.call(managed, entry.name);
    if (!owned) {
      try {
        owned = MANAGED_MARKER_RE.test(fs.readFileSync(filePath, 'utf8'));
      } catch {
        owned = false;
      }
    }
    if (owned) managedNames.push(entry.name);
  }

  if (managedNames.length === 0) return false;

  if (dryRun) {
    console.log(`[dry-run] would remove ${managedNames.length} AIWG command file(s) from ${rel}`);
    return true;
  }

  for (const name of managedNames) {
    try {
      fs.unlinkSync(path.join(commandsDir, name));
      if (Object.prototype.hasOwnProperty.call(managed, name)) {
        delete managed[name];
        sidecarDirty = true;
      }
      if (verbose) console.log(`  removed AIWG command file: ${name}`);
    } catch (err) {
      if (verbose) console.warn(`  Warning: could not remove ${name}: ${err.message}`);
    }
  }

  if (sidecarDirty) writeSidecarManifest(commandsDir, sidecar, dryRun);
  console.log(`  Removed ${managedNames.length} old AIWG command file(s) from ${rel} (now served as skills)`);

  // Remove the directory only if AIWG files were the only contents.
  try {
    const remaining = fs.readdirSync(commandsDir).filter((n) => n !== MANIFEST_FILENAME);
    if (remaining.length === 0) {
      fs.rmSync(commandsDir, { recursive: true, force: true });
    }
  } catch { /* non-fatal */ }

  return true;
}

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
