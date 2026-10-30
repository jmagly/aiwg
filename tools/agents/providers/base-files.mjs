// Shared provider files utilities.
import { mergeArtifactOwnership } from './base-runtime.mjs';
import { createHash, fs, os, path } from './base-runtime.mjs';


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


export const PROJECT_ARTIFACT_ENV_KEYS = [
  'AIWG_ARTIFACTS_PATH',
  'AIWG_PROJECT_ARTIFACTS_PATH',
  'AIWG_PROJECT_AIWG_DIR',
];


export function expandProjectArtifactPath(value, projectDir) {
  const trimmed = value.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.resolve(os.homedir(), trimmed.slice(2));
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(projectDir, trimmed);
}


export function parseProjectArtifactLocation(contents) {
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
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && !e.name.toLowerCase().endsWith('.soul.md') && !e.name.toLowerCase().endsWith('.core.md') && !excluded.includes(e.name))
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
export const MANAGED_MARKER_RE = /^(?:<!-- aiwg:managed |# aiwg:managed )/m;

export const MANIFEST_FILENAME = '.aiwg-manifest.json';


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
  const previous = readSidecarManifest(dir);
  for (const [name, record] of Object.entries(manifest.managed || {})) {
    const prior = previous?.managed?.[name];
    const owner = record.frameworkSlug;
    if (owner) manifest.managed[name] = mergeArtifactOwnership(prior, record, owner);
    else if (prior?.hash === record.hash) manifest.managed[name] = { ...prior, ...record };
  }
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
    const { filename, hash, frameworkSlug, kind, sourcePath } = entry;
    const prior = existing.managed[filename];
    const digest = `sha256:${hash}`;
    const sidecarEntry = { ...(prior?.hash === digest ? prior : {}), hash: digest, source, version };
    if (sourcePath) sidecarEntry.sourcePath = sourcePath;
    if (frameworkSlug) sidecarEntry.frameworkSlug = frameworkSlug;
    // `kind` marks artifacts whose lifecycle is governed elsewhere — currently
    // only `skill-command` wrappers, which follow their source skill (#2507).
    if (kind) sidecarEntry.kind = kind;
    existing.managed[filename] = frameworkSlug ? mergeArtifactOwnership(prior, sidecarEntry, frameworkSlug) : sidecarEntry;
  }

  writeSidecarManifest(dir, existing, dryRun);
}
